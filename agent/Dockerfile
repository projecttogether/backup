# Backup Agent: one Go binary without dependencies, and pg_dump (README.md).
# Build context: this folder (agent/).
FROM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN go vet ./... && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /backup-agent .

# Alpine 3.24 ships pg_dump 18, which dumps PostgreSQL 18 and older servers.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache postgresql18-client
COPY --from=build /backup-agent /usr/local/bin/backup-agent
# nobody: reads the volumes (mounted read-only) and writes only the dump to
# BACKUP_TMP_DIR (/tmp). It opens no port.
USER 65534:65534
# The commit the image is built from (--build-arg APP_VERSION=<commit>); the
# agent reports it to the Backup app.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
ENTRYPOINT ["/usr/local/bin/backup-agent"]
