# AGENTS.md

Backup Agent is the sidecar that backs up one app for ProjectTogether's
Backup app (the rest of this repository). It runs next to any app that runs
with Docker Compose, PostgreSQL and volumes. When the Backup app hands out a
job, it streams a tar archive of the app's `pg_dump` and its volumes to the
Backup app, in parts, over HTTPS. `README.md` is the user documentation and
the public contract of the protocol.

## Layout

```
main.go             commands: run (no argument), check, dump-database, version
config.go           the settings (environment), the volumes below BACKUP_DATA_DIR
agent.go            the poll loop; a job from pg_dump to /complete or /fail
client.go           the protocol over HTTP: poll, parts with retries, progress, complete, fail
archive.go          the tar stream: manifest.json, db.dump, volumes/<name>/…
parts.go            cuts the stream into parts, with SHA-256 per part and in total
dump.go             runs pg_dump; its error lines; the server version from the dump
                    header; the dump-database command (pg_dump to stdout)
check.go            the check command
redact.go           keeps secrets out of logs and failure messages; the logger
version.go          the version (APP_VERSION of the image: the commit) and the User-Agent
*_test.go           unit tests; fake_test.go is a fake Backup app (httptest)
test/run.sh         end to end: the image, PostgreSQL 18, test/fake_backup_app.py
```

## Rules

- **The protocol is a contract.** A change goes into `README.md`
  ("Protocol"), this agent and the Backup app's server
  (`packages/shared/src/api/agent.ts`, `apps/server`) together.
- **No secrets in logs or messages:** never `BACKUP_TOKEN`, `DATABASE_URL`
  or a password. Log only through the logger of `newLogger`; messages for
  `/fail` pass `failMessage`. The password reaches `pg_dump` in
  `PGPASSWORD`, never in its arguments.
- **The agent only reads.** Volumes are mounted read-only; no restore, no
  port, no program but `pg_dump`.
- **Stream.** Never load a whole file or the whole stream; one part is in
  memory.
- **Standard library only**, one `package main`. Go 1.27.
- **Apps contain nothing about the agent.** Examples use generic names
  (`example`, `ghcr.io/example/app:1.2.3`), not real apps.
- Change the tests with the behaviour; `test/run.sh` covers what needs the
  image.

## Commands

Run them in `agent/`:

```sh
go test ./...                     # Go 1.27, or:
docker run --rm -v "$PWD":/src -w /src golang:1.27-alpine go test ./...
gofmt -l . && go vet ./...
test/run.sh                       # end to end (Docker, Python 3, jq, curl)
```

The image: `docker build --build-arg APP_VERSION=<commit> .` in `agent/`.
CI builds `ghcr.io/projecttogether/backup-agent` on every commit to `main`,
tagged `sha-<commit>` and `latest`. There are no releases; no file holds the
version.

## Writing

Concise, plain US English; short sentences.
