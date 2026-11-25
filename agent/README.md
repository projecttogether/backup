# Backup Agent

Backups of self-hosted apps for the [Backup app](../README.md) of
ProjectTogether. The agent runs next to any app that runs with Docker
Compose, PostgreSQL and volumes. It asks the Backup app over HTTPS for work.
When the Backup app hands out a job, the agent dumps the app's database with
`pg_dump`, reads the app's volumes, and streams both as one tar archive to
the Backup app, in parts. The Backup app stores the archive with restic.

```text
Backup app: a backup is due ─► the agent asks (POST /poll) and gets the job
agent: pg_dump to a temporary file ─► tar: manifest.json, db.dump, volumes/…
  ─► PUT part 0, 1, 2 … (16 MiB each, SHA-256 each) ─► POST complete (totals)
Backup app: checks the totals ─► restic snapshot
```

The agent only reads. It restores nothing, opens no port, needs no Docker
socket, and only connects out to the Backup app. It is one Go program
without dependencies, plus `pg_dump` 18. It runs as `nobody`, or as the
app's user (`user:`). `dump-database` writes the database alone to stdout,
for a copy outside the Backup app ([Dump the database](#dump-the-database)).

## Image

`ghcr.io/projecttogether/backup-agent`. There are no releases: each commit
to `main` builds the image, tagged `sha-<commit>` and `latest`. Pin
`sha-<commit>`; `latest` moves with every commit. The agent reports the
commit as its version (`APP_VERSION`, set at the build). To update, change
the tag, then `docker compose pull && docker compose up -d`.

## Set it up

The agent needs three things of the app: a network on which it reaches the
app's database, the app's volumes (read-only), and the app's user (uid:gid).
It needs no change to the app.

### Next to the app, as a Compose project of its own

This is the setup ProjectTogether uses: the app's `compose.yaml` contains
nothing about backups. A second Compose project on the app's server, such as
`/srv/backup-agent/compose.yaml`, joins the app's network, mounts the app's
named volumes read-only below `/data`, and runs as the app's user:

```yaml
name: backup-agent

services:
  backup-agent:
    image: ghcr.io/projecttogether/backup-agent:sha-<commit>
    restart: unless-stopped
    # The app's user (uid:gid), so that the agent reads what the app writes.
    # Without it: nobody (65534).
    user: "1000:1000"
    environment:
      # Both from the app's source in the Backup app. Empty: the agent idles.
      BACKUP_URL: ${BACKUP_URL:-}
      BACKUP_TOKEN: ${BACKUP_TOKEN:-}
      # The app's database, by its service name on the app's network.
      DATABASE_URL: ${DATABASE_URL:?Set DATABASE_URL}
      APP_NAME: example
      APP_IMAGE: ghcr.io/example/app
      # The app's settings that a restore needs and that are not in the
      # backup, such as keys that encrypt stored data: names only, never
      # values.
      APP_SECRETS: ENCRYPTION_KEY
    volumes:
      # Each named volume of the app, read-only, as /data/<name>.
      - attachments:/data/attachments:ro
    networks: [app]

networks:
  app:
    # The app's network: <app project>_default, unless the app names it.
    name: example_default
    external: true

volumes:
  attachments:
    # The app's volume: <app project>_<volume>, unless the app names it.
    name: example_attachments
    external: true
```

`BACKUP_URL`, `BACKUP_TOKEN` and `DATABASE_URL` go in the `.env` next to it,
readable only by its owner. `DATABASE_URL` names the database by the service
name on the app's network, such as
`postgres://app:<password>@db:5432/app`. `docker network ls` and
`docker volume ls` show the names; with `external: true`, Compose refuses to
start when the network or a volume is missing, instead of creating an empty
one.

- **Start the app first.** The agent's project uses the app's network and
  volumes; it does not create them. When the app's project is removed and
  created again, run `docker compose up -d` for the agent again.
- **`APP_IMAGE`** does not follow the app's updates in this setup. Name the
  image without a tag, or leave it empty.
- **Bind mounts** of the app (a host folder instead of a named volume) are
  mounted the same way: `- /srv/example/files:/data/files:ro`.

### In the app's compose.yaml

Alternatively, the agent is one more service of the app's `compose.yaml`. It
then shares the app's network and volumes without naming them:

```yaml
x-image: &image ghcr.io/example/app:${APP_TAG:?Set APP_TAG}

services:
  backup-agent:
    image: ghcr.io/projecttogether/backup-agent:sha-<commit>
    restart: unless-stopped
    # The app's user (uid:gid). Without it: nobody (65534).
    user: "1000:1000"
    environment:
      BACKUP_URL: ${BACKUP_URL:-}
      BACKUP_TOKEN: ${BACKUP_TOKEN:-}
      # The same database the app uses.
      DATABASE_URL: ${DATABASE_URL:?Set DATABASE_URL}
      APP_NAME: example
      APP_IMAGE: *image
      APP_SECRETS: ENCRYPTION_KEY
    volumes:
      # Each volume of the app, read-only, below /data.
      - attachments:/data/attachments:ro
```

### Settings

The agent needs no port and none of the app's other settings. Give it only
`DATABASE_URL`, not the app's whole environment.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BACKUP_URL` | empty | Address of the Backup app, such as `https://backup.example.org`. Empty: the agent logs once that it is idle and waits. |
| `BACKUP_TOKEN` | empty | The token the Backup app shows once when an admin adds the app as a source (`bkp_` and 43 more characters). Needed when `BACKUP_URL` is set. |
| `DATABASE_URL` | empty | The app's PostgreSQL URL (`postgres://` or `postgresql://`). Empty: no database in the backups. |
| `BACKUP_DATA_DIR` | `/data` | Each directory directly below it is one volume. Missing or empty: no files in the backups. |
| `APP_NAME` | empty | The app, such as `example`; shown in the Backup app. |
| `APP_IMAGE` | empty | The app's image, perhaps with its tag; shown in the Backup app and stored in the archive. |
| `APP_SECRETS` | empty | Names of the app's settings that a restore needs and that are not in the backup, separated by commas, such as `ENCRYPTION_KEY,AUTH_SECRET`. Names only, never values: each a letter or `_`, then letters, digits or `_`, at most 100 characters; spaces around them and repeated names are dropped, the order is kept, and at most 20 different names. Sent to the Backup app and stored in the archive. |
| `BACKUP_TMP_DIR` | `/tmp` | Where the database dump waits until it is sent. Needs room for one dump. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

The agent never logs `BACKUP_TOKEN`, `DATABASE_URL` or the database password.
It passes the password to `pg_dump` in `PGPASSWORD`, so it shows in no
process list.

To set it up:

1. In the Backup app, add the app as a source of the kind "app". Copy the
   token; the Backup app shows it only once. On the Backup app's server,
   `cli tokens create agent --source <id>` issues a new one.
2. Put `BACKUP_URL` and `BACKUP_TOKEN` in the agent's `.env`.
3. `docker compose up -d`, then check it (below).

## Check it

```sh
docker compose exec backup-agent backup-agent check
```

`check` prints one line per item and exits with 1 when anything is wrong:

```text
Backup Agent <commit>
ok       The settings are valid.
ok       Volumes in /data: attachments
ok       Volume attachments: 1204 files, 3.1 GB.
ok       Temporary folder /tmp: writable, 12.4 GB free; it needs room for one dump.
ok       pg_dump (PostgreSQL) 18.7
ok       Database: answers (PostgreSQL 18.1).
ok       Backup app: answers, as the source "Example"; the agent asks every 60 s.
```

It walks each volume as a backup would, links not followed, and opens each
file without reading it. A folder it cannot read is a problem (the backup
would fail); a file it cannot read is a warning (the backup would skip it).
Both lines name the path and the `user:` to set. It dumps only the schema to
test the database, and runs no backup. The log
(`docker compose logs backup-agent`) shows each backup:

```text
level=INFO msg="Connected to the Backup app." source=Example poll=1m0s
level=INFO msg="Backup started." job=4f0c… partBytes=16777216
level=INFO msg="Database dumped." job=4f0c… bytes=48211337 duration=3s serverVersion=18.1
level=INFO msg="Backup sent." job=4f0c… parts=4 bytes=61530112 duration=9s warnings=""
```

## Dump the database

`dump-database` writes a dump of `DATABASE_URL` to stdout:
`pg_dump --format=custom`, compressed. It needs only `DATABASE_URL`; it
works without `BACKUP_URL`. Use it for a copy outside the Backup app, such
as before an update. By hand, in the agent's folder (or the app's folder,
when the agent is a service of the app):

```sh
(umask 077 && rm -f app.dump && docker compose run --rm -T --no-deps backup-agent dump-database > app.dump)
```

`umask 077` and a new file keep the dump for its owner only: it holds the
whole database.
Keep `-T`: a terminal (TTY) changes the bytes of the dump, so the agent
refuses to write to one. A failure is one line on stderr, without the
password or the URL, and exit code 1.

### Restore a dump

1. Stop the app, but not its database: `docker compose stop web worker`
   in the app's folder (the app's services).
2. Restore the dump, in the agent's folder:

   ```sh
   docker compose run --rm -T --no-deps --entrypoint sh backup-agent -c '
     pg_restore --clean --if-exists --no-owner --file=/tmp/restore.sql &&
     psql --dbname="$DATABASE_URL" --single-transaction --set=ON_ERROR_STOP=1 --quiet --output=/dev/null \
       --command="SET client_min_messages = warning; DROP SCHEMA public CASCADE;
         CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC;" \
       --file=/tmp/restore.sql' < app.dump
   ```

   It uses the image's `pg_restore` and `psql`. It empties the schema
   `public`, so tables that a newer version added go as well, then restores
   the dump; all in one transaction. When anything fails, the database
   stays as it was. It needs PostgreSQL 15 or newer, a `DATABASE_URL` whose
   user owns the database, and room in the container's `/tmp` for the dump
   as SQL.
3. Start the app version that wrote the dump. If the app's settings name a
   newer version now (such as `APP_TAG=1.2.4`), set it back first; a newer
   version would migrate the database again. Then `docker compose up -d`.

## Good to know

- **Wrong settings:** the agent never exits because of a setting. It logs
  the problem once, stays idle and backs up nothing. So a wrong setting
  never makes a deploy fail. `check` shows the problem and exits with 1.
- **Run the agent as the app's user.** The image runs as `nobody` (65534).
  Many apps keep files or folders that only their own user may read. Set
  `user:` of the `backup-agent` service to the app's user, such as
  `user: "10001:10001"`.
- **A folder the agent cannot read fails the backup**, as does one whose
  entries it cannot reach (listed but not entered), because a backup
  without it would look complete. The Backup app shows the volume and how
  to fix it, but not the folder's path: names of files and folders may hold
  personal data. The agent's log has the path.
- **A file the agent cannot read** is skipped, logged with its path, and
  reported to the Backup app as a warning, such as "2 files could not be
  read".
- **Consistency:** the database is dumped first, then the files are read.
  Files the dump refers to exist when they are read. The files are read
  while the app runs; a file that changes while it is read is counted as a
  warning.
- **PostgreSQL versions:** `pg_dump` 18 dumps PostgreSQL 18 and older. A
  PostgreSQL 19 server needs an agent image with `pg_dump` 19.
- **Room:** the dump is written to `BACKUP_TMP_DIR` first, because the tar
  header needs its size. It is deleted after each job. For a large database,
  mount a volume at `/tmp`.
- **Memory:** the agent holds one part in memory (16 MiB by default).

## Restore

A restore is done by hand. The Backup app keeps each backup as the file
`/backup.tar` of a restic snapshot. These are the generic steps. The app's
own deployment guide may require more; for example, an app may need its web
service kept stopped, or a cleanup run, after a restore.

```sh
restic dump <snapshot> /backup.tar > backup.tar
tar -xf backup.tar          # manifest.json, db.dump, volumes/<name>/…
```

1. Stop the app, but not its database: `docker compose stop web worker`
   (the app's services).
2. Restore the database with `pg_restore` 18 or newer:

   ```sh
   pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" db.dump
   ```

   Without a local `pg_restore`, run it in a container of the image
   `postgres:18` that reaches the database.
3. Copy `volumes/<name>/` back into the volume `<name>`, keeping owners and
   modes, for example:

   ```sh
   docker run --rm -v "$PWD/volumes/attachments:/from:ro" -v <project>_attachments:/to alpine cp -a /from/. /to/
   ```

4. The settings that `APP_SECRETS` names (`app.secrets` in
   `manifest.json`) are not in the backup. Take them from the app's
   settings, kept apart from the backup. Without them, the app cannot use
   what they protect, such as credentials it stores encrypted.
5. Start the app: `docker compose up -d`.

`manifest.json` names the app, its image, the settings in `APP_SECRETS` and
the PostgreSQL version of the backup. Restore into the same app version, or
a newer one that migrates the database at its start.

## Protocol

Version 1 of the contract between the agent and the Backup app. Other
agents may implement it.

### Requests

Every request goes to `${BACKUP_URL}/api/agent/v1/...` with:

- `Authorization: Bearer <BACKUP_TOKEN>`
- `User-Agent: backup-agent/<version>`

Errors are JSON: `{ "error": { "code": "...", "message": "..." } }`. The
agent does not follow redirects.

| Request | Answers |
| --- | --- |
| `POST /poll` | `200` with the source, `pollSeconds` and perhaps a job |
| `PUT /jobs/{jobId}/parts/{n}` | `204` stored; `409` `out_of_order`; `422` `checksum_mismatch`; `410` `job_ended` |
| `POST /jobs/{jobId}/progress` | `204`; `410` `job_ended` |
| `POST /jobs/{jobId}/complete` | `202` accepted; `422` `stream_mismatch`; `410` `job_ended` |
| `POST /jobs/{jobId}/fail` | `204` |

`401` on any request means that the token is wrong or the source was
deleted. During a job, the agent then stops the job without `/fail`.

### `POST /poll`

The heartbeat and the job pickup:

```json
{
  "agent": { "version": "0.1.0" },
  "app": { "name": "example", "image": "ghcr.io/example/app:1.2.3", "secrets": ["ENCRYPTION_KEY"] },
  "database": true,
  "volumes": ["attachments"]
}
```

`app.secrets` holds the names of `APP_SECRETS`, `[]` when it is empty: at
most 20 names that match `^[A-Za-z_][A-Za-z0-9_]{0,99}$`. Older agents do
not send it; the Backup app then takes `[]`. `database` is true when
`DATABASE_URL` is set. `volumes` names the directories below
`BACKUP_DATA_DIR`, sorted. The `check` command adds `"check": true`:
the Backup app then answers as usual but hands out no job.

```json
{
  "source": { "id": "uuid", "name": "Example" },
  "pollSeconds": 60,
  "job": null
}
```

With a job: `"job": { "id": "uuid", "partBytes": 16777216 }`. The Backup app marks a
job as running when it hands it out, and hands it out only once. The agent
runs it at once, and polls again `pollSeconds` after it ended.

The agent polls every `pollSeconds` of the last answer (60 before the first
answer; at least 1 s, at most 1 h), plus up to a tenth at random. When a poll
fails (network, `5xx`, `401`), it logs it once and polls again after the
same time.

### The stream

One POSIX tar archive (PAX headers when needed, uncompressed), in this
order:

1. `manifest.json`:

   ```json
   {
     "format": 1,
     "createdAt": "2026-11-20T02:00:00Z",
     "agent": { "version": "0.1.0" },
     "app": { "name": "example", "image": "ghcr.io/example/app:1.2.3", "secrets": ["ENCRYPTION_KEY"] },
     "database": { "included": true, "file": "db.dump", "format": "pg_dump custom", "serverVersion": "18.1" },
     "volumes": ["attachments"]
   }
   ```

   Without a database: `"database": { "included": false }`. `serverVersion`
   is `""` when the dump does not name it. `app.secrets` is as in the poll;
   archives of older agents lack it.
2. `db.dump`, when `DATABASE_URL` is set: `pg_dump --format=custom
   --compress=0` of `DATABASE_URL` (its password in `PGPASSWORD`), written to
   `BACKUP_TMP_DIR` first and deleted after the job. It is uncompressed, so
   that restic can deduplicate and compress it.
3. `volumes/<name>/` and everything below it, for each volume in lexical
   order; within a volume depth first, each directory's entries in lexical
   (byte) order. Directories, regular files and symbolic links (as links,
   never followed), with mode, numeric owner and modification time. Sockets,
   devices and FIFOs are skipped. A file that vanishes or cannot be read is
   skipped and counted in a warning, logged with its path in the volume. So
   is a directory that vanishes. A file that shrinks or fails while it is
   read is filled up with zeros to the size in its header, and counted in a
   warning. A directory (the volume included) that cannot be listed for
   another reason, or whose entries cannot be looked at (listed but not
   entered), fails the job (`/fail`), with a message that names the
   volume but not the path, such as: `A folder in the volume "private_data"
   cannot be read (permission denied). Run the agent as the app's user: set
   user: of the backup-agent service, such as "10001:10001".` The user is
   the folder's owner. The agent logs the path.

### `PUT /jobs/{jobId}/parts/{n}`

The stream cut into parts of exactly `partBytes` bytes; only the last part
may be smaller. `n` counts from 0, in order, one part at a time. Headers:
`Content-Type: application/octet-stream`, `Content-Length`, and
`X-Part-Sha256: <hex SHA-256 of the part>`. The agent takes a `partBytes`
from 1 KiB to 256 MiB; any other fails the job.

- `204`: stored. The same `n` again (after a lost answer) with the same
  SHA-256 is `204`, stored once.
- `409` `out_of_order`, with the part the Backup app expects in the error:
  `{ "error": { "code": "out_of_order", "message": "…", "expected": 3 } }`.
  When it expects the next part, the agent counts this part as stored.
  Otherwise the job fails (`/fail`): the agent keeps only the current part.
- `422` `checksum_mismatch`: the part was damaged on the way; the agent sends
  it again.
- `410` `job_ended`: the job was cancelled or failed in the Backup app, or the Backup app
  restarted. The agent stops and does not call `/fail`.

A network error, `5xx`, `408`, `429` and `422` send the same part again
after 1 s, 2 s, 4 s … at most 60 s, up to 10 attempts. Then the job fails
(`/fail`, if the Backup app answers). Each attempt may take 10 minutes: the Backup app
answers only after restic took the part.

### `POST /jobs/{jobId}/progress`

While `pg_dump` runs, before the first part, the agent reports every 5
minutes that the job is alive: `{ "stage": "database", "bytes": 1048576 }`
(the dump so far). `204`. On `410` the agent stops `pg_dump` and does not
call `/fail`. A Backup app without this endpoint (`404`) is no error.

### `POST /jobs/{jobId}/complete`

```json
{ "parts": 12, "bytes": 190000000, "sha256": "<hex SHA-256 of the whole stream>", "warnings": ["2 files could not be read"] }
```

`warnings` is `[]` without warnings. `202`: the Backup app checks the totals and
finishes the snapshot; the job is done. `422` `stream_mismatch`: the totals
differ, and the run fails in the Backup app. `410` as above. Network errors and
`5xx` are tried again like parts.

### `POST /jobs/{jobId}/fail`

`{ "message": "pg_dump failed: connection to server at \"db\" failed: …" }`:
the agent could not produce the stream. The message has at most 500
characters and no secrets: no token, no database URL or password, nothing
that looks like a URL. `204`. When the agent is stopped (`SIGTERM`) during a
job, the message is "The agent was stopped".

### What the Backup app does

- A token belongs to one source; the Backup app stores only its SHA-256.
- A job is handed out only while no maintenance (forget, prune, check) runs.
- A job that is not picked up within 2 hours of its planned time fails. A
  job with no part (or progress report) for 60 minutes fails.
- A scheduled job that a restart of the Backup app (or of the agent)
  interrupted is queued again, once: the agent gets `410` for its next part,
  goes back to polling, and a later poll hands out the same job (same id)
  again.
- Each part goes into `restic backup --stdin --stdin-filename backup.tar`;
  the Backup app answers `204` only after restic took it. It closes restic's input
  only after `/complete` matched the totals, so no incomplete snapshot is
  written.
- Reverse proxies in front of the Backup app must accept request bodies of
  `partBytes` (16 MiB by default).

## Development

The agent lives in `agent/` of the Backup repository; run the commands
there. Without a local Go, run them in the image the Dockerfile builds with:

```sh
go test ./...   # unit tests (Go 1.27)
docker run --rm -v "$PWD":/src -w /src golang:1.27-alpine sh -c 'gofmt -l . && go vet ./... && go test ./...'
test/run.sh     # end to end: the image, PostgreSQL 18 and a fake Backup app (Docker, Python 3, jq, curl)
```
