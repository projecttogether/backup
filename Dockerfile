# One image for every process. The command selects the role:
#   all      web app and worker (default)
#   web      web app and the agents' uploads (port 3000)
#   worker   schedules, Google Drive, S3 bucket and Personio backups, upkeep, alerts
#   migrate  apply database migrations, then exit
#   cli …    the operator command, e.g. `cli settings list` (docs/deployment.md)
# The image has restic (backups), rclone (Google Drive, S3 buckets) and pg_dump 18 (this
# app's own database).

FROM node:26.13.1-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM base AS deps
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build
# The Deploy workflow's builds upload the source maps of the server and the
# web app to Sentry, which finds them by the debug IDs the build wrote into
# the bundles (scripts/inject-debug-ids.mjs). Without the token (the secret
# SENTRY_AUTH_TOKEN of the repository), nothing is uploaded.
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      export SENTRY_CLI_NO_TELEMETRY=1 SENTRY_CLI_NO_UPDATE_CHECK=1 \
      && node_modules/.bin/sentry sourcemap upload apps/server/dist \
      && node_modules/.bin/sentry sourcemap upload apps/web/dist; \
    fi
# The web app's source maps would be public under /assets: they stay out of
# the image. The server's are never served.
RUN find apps/web/dist -name '*.map' -delete

FROM base AS prod-deps
# Optional packages here are build and test tools that libraries name as
# optional peers (vitest, drizzle-kit, esbuild): the server needs none of them.
RUN npm ci --omit=dev --omit=optional --workspace @backup/server --include-workspace-root=false --no-audit --no-fund

# restic and rclone from their GitHub releases, checked against the release
# checksums; the PostgreSQL apt key for pg_dump 18.
FROM debian:bookworm-slim AS tools
ARG TARGETARCH
ARG RESTIC_VERSION=0.19.1
ARG RCLONE_VERSION=1.76.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl bzip2 unzip \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) restic_sha=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c; rclone_sha=b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7 ;; \
      arm64) restic_sha=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465; rclone_sha=ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/restic.bz2 "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2"; \
    echo "${restic_sha}  /tmp/restic.bz2" | sha256sum -c -; \
    bunzip2 /tmp/restic.bz2; \
    install -m 0755 /tmp/restic /usr/local/bin/restic; \
    curl -fsSL -o /tmp/rclone.zip "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}.zip"; \
    echo "${rclone_sha}  /tmp/rclone.zip" | sha256sum -c -; \
    unzip -q /tmp/rclone.zip -d /tmp; \
    install -m 0755 "/tmp/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}/rclone" /usr/local/bin/rclone; \
    curl -fsSL -o /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc

FROM node:26.13.1-bookworm-slim AS runtime
# restic and rclone need the CA certificates for HTTPS; pg_dump 18 comes from
# the PostgreSQL project's apt repository.
COPY --from=tools /tmp/pgdg.asc /usr/share/keyrings/pgdg.asc
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/local/bin/restic /usr/local/bin/rclone /usr/local/bin/
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    PG_DUMP_BINARY=/usr/lib/postgresql/18/bin/pg_dump \
    WORKER_HEARTBEAT_FILE=/tmp/worker-heartbeat
WORKDIR /app
# Local copies of Google Drive, S3 buckets and Personio, and restic's cache; mount a volume here (compose.yaml).
RUN mkdir -p /data && chown -R node:node /data
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# `cli …` in a terminal of a running container, e.g. with
# `docker compose exec web cli settings list`.
RUN printf '#!/bin/sh\nexec docker-entrypoint.sh cli "$@"\n' > /usr/local/bin/cli \
    && chmod 755 /usr/local/bin/cli
# The Deploy workflow sets the version (the first 12 characters of the
# commit); images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["all"]
