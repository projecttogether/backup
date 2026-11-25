# Contributing

Backup is a Hono server and a React web app in one repository (npm
workspaces), with the backup agent, a Go program, in `agent/`. `AGENTS.md`
has the layout and the rules; this file has the setup and the checks.

## Development setup

Requirements: Node.js 26, Docker with Compose, and
[restic](https://restic.net) 0.19 and [rclone](https://rclone.org) on the
`PATH` (the integration tests and the Google Drive and S3 bucket sources use
rclone).

```sh
docker compose -f compose.dev.yaml up -d
cp .env.example .env.local
npm ci
npm run dev
```

- Web app: http://localhost:5173 (Vite, passes `/api` and `/-` to the server)
- Server: http://localhost:3000
- Keycloak: http://localhost:8114 (admin / admin), realm `backups`. Test
  users (password `backups-dev`): `ada@example.org` (admin by
  `ADMIN_EMAILS`), `grace@example.org` (admin by the group
  `/backup-admins`), `rita@example.org` (no admin: refused).
- S3 storage (RustFS): endpoint http://localhost:9114, console
  http://localhost:9115, key `backups` / `backups-dev-secret`, bucket
  `backups` with Object Lock and lifecycle rules.
- Mailpit: http://localhost:8125 (SMTP `localhost:1035`, no security).

To try an app source, run the backup agent (`agent/`, its README has the
commands) with `BACKUP_URL=http://localhost:3000` and the token the app
shows.

`npm run cli -- settings list` runs the operator command against the
development database (`cli help` lists the commands).

## Checks

```sh
node scripts/check-public-repository.mjs
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:integration   # PostgreSQL, S3 and Mailpit of compose.dev.yaml, restic, rclone
npm run build
```

The backup agent, in `agent/`: `gofmt -l .`, `go vet ./...`,
`go test ./...` and `test/run.sh` (its README, Development).

CI (`.github/workflows/ci.yaml`) runs these, scans the history for secrets,
checks that the migrations match the schema, and builds and starts the
Docker image.

## Database changes

Change the schema in `apps/server/src/db/schema/`, run
`npm run db:generate`, and commit the new file in `apps/server/drizzle/`.
The previous version must keep working on the migrated database (a deploy
that fails puts it back): add columns with a database default.

## Tests

Unit tests sit next to the code (`*.test.ts`), integration tests too
(`*.int.test.ts`). Integration tests create a fresh repository in the test
bucket for each test that needs one.

## Pull requests

Write the title as one plain line of what changes. Label a pull request
`breaking` when the people who run the app must act on it, and describe the
steps in it. Update the docs when behavior or configuration changes.

## Builds and deploys

Every commit on `main` that passes CI is built and deployed; there are no
releases (`docs/deployment.md`, Builds and deploys). The Deploy workflow
uploads the source maps to the Sentry project `projecttogether/backups`
with the secret `SENTRY_AUTH_TOKEN` (Dockerfile); without the secret, it
uploads nothing.

The versions of restic and rclone are build arguments in the `Dockerfile`,
with their SHA-256 checksums; update them by hand (Dependabot does not see
them), together with `RESTIC_VERSION` and `RCLONE_RELEASE` (not
`RCLONE_VERSION`: rclone reads `RCLONE_*` variables as its flags) in
`.github/workflows/ci.yaml`.

## Data, secrets and privacy

Never commit secrets, real personal data or data from a real organization,
also not in tests and fixtures. Use `example.org` addresses and invented
content. `scripts/check-public-repository.mjs` rejects private file types,
unknown hosts and email domains, internal names and token formats; add a
host there only when it is public and intended.
