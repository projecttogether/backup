# Deployment

For the person who runs Backup on a Linux server, such as a VPS with Debian
or Ubuntu: requirements, [the bucket](#the-bucket), [setup](#setup),
[settings from the command line](#settings-from-the-command-line),
[upgrades](#upgrades), [builds and deploys](#builds-and-deploys), and what
the app backs up of itself. Every environment variable is described in
[Configuration](configuration.md). Connecting sources: [Sources](sources.md).

## Requirements

- **A server with Debian 12 or later** (or a similar system with systemd and
  apt, such as Ubuntu 24.04), with Docker Engine and its Compose plugin, and a
  domain name that points at it. Preferably its own server, not the one of
  the apps it backs up: then losing that server does not take the backups'
  orchestration with it.
- **PostgreSQL 16 or later:** a database of your own, or the one
  `compose.postgres.yaml` adds.
- **Caddy** (or another reverse proxy on the server) that terminates HTTPS
  and accepts request bodies of 16 MiB (the agents send their streams in
  parts of that size; `AGENT_PART_MB` changes it). Caddy and Traefik accept
  them as they are; nginx needs `client_max_body_size 20m;`.
- **An OpenID Connect provider** for sign-in (Keycloak, Microsoft Entra ID,
  Google, Authentik, …).
- **An S3-compatible bucket** for the backups ([below](#the-bucket)).
- **Disk space** in the `data` volume for the local copies of Google Drive,
  S3 buckets and Personio (as much as they hold) and restic's cache (a few
  percent of the repository).

## What runs

The [Deploy workflow](#builds-and-deploys) builds the image
`ghcr.io/projecttogether/backup` (linux/amd64) from every commit on `main`
that passes CI, tagged `sha-<commit>` and `latest`. There are no numbered
releases: the commit is the version. `BACKUP_IMAGE_TAG` in `.env` picks the
image: `latest` (the default) or `sha-<commit>` for one build.

| File                    | Contains                                                                     |
| ----------------------- | ---------------------------------------------------------------------------- |
| `Dockerfile`            | The image, with restic, rclone and pg_dump 18. Its command picks the role.   |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`) and the `worker`.                   |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own. |
| `agent/`                | The backup agent and its image `ghcr.io/projecttogether/backup-agent`.       |

- **`web`** serves the interface and receives the agents' uploads (each
  upload runs a restic process in it). Run exactly one `web`: an upload lives
  in its memory.
- **`worker`** plans the runs, backs up Google Drive, S3 buckets, Personio
  and the app's own database one at a time, runs the daily upkeep, and
  sends alerts. Run exactly one `worker`: it ends runs that count as running
  without it, so a second one would end the first one's.

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`BACKUP_PORT` changes the host port. `web` and `worker` share the volume
`data` (`/data`).

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process. Mount a volume at `/data`.

## The bucket

Any S3-compatible storage works: Hetzner Object Storage, AWS S3, Backblaze
B2, Scaleway, OVHcloud, IONOS, MinIO. These steps are for Hetzner Object
Storage. They give the backups three protections:

- **Another place:** the bucket in another location than the servers (servers
  in Falkenstein or Nuremberg, the bucket in Helsinki).
- **Other keys:** the bucket in a Hetzner project of its own. Hetzner's S3
  keys are valid for every bucket of their project, so the apps' projects
  never hold keys that reach the backups.
- **Object Lock:** stored objects cannot be changed or deleted for 30 days,
  not even with the keys. When restic deletes old data, the bucket keeps the
  locked versions, so a stolen key or ransomware cannot wipe the backups
  within that time.

Steps:

1. In the [Hetzner Console](https://console.hetzner.com), create a project,
   for example `backups`.
2. In it, create a bucket under Object Storage: a location other than the
   servers', private, and **Object Lock enabled**. Object Lock can only be
   turned on when the bucket is created; it also turns on versioning.
3. In the same project, create S3 credentials (a key pair) in the Console.
   Copy the secret key: Hetzner shows it once.
4. Set the default retention and the lifecycle rules with the AWS command
   line (Hetzner sets lifecycle rules only through the S3 API, not in the
   Console). With the key in `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY`:

   ```sh
   E=https://hel1.your-objectstorage.com   # the bucket's location
   B=acme-backups                          # the bucket's name
   aws s3api put-object-lock-configuration --endpoint-url "$E" --bucket "$B" \
     --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":30}}}'
   aws s3api put-bucket-lifecycle-configuration --endpoint-url "$E" --bucket "$B" \
     --lifecycle-configuration '{"Rules":[
       {"ID":"old-versions","Status":"Enabled","Prefix":"",
        "NoncurrentVersionExpiration":{"NoncurrentDays":31},
        "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}},
       {"ID":"delete-markers","Status":"Enabled","Prefix":"",
        "Expiration":{"ExpiredObjectDeleteMarker":true}}]}'
   ```

   - **Old versions** (what restic deleted) are removed 31 days after restic
     deleted them, and never while their lock (30 days from their upload)
     lasts. Without this rule, Hetzner keeps them, and bills them, forever. Hetzner supports only
     `NoncurrentDays` here, no "keep the last N versions".
   - **Delete markers** that are left alone are removed.
   - **Incomplete uploads** are removed after 7 days.

   Deleted data thus stays in the bucket for 31 days after restic deletes
   it. Longer periods protect longer and cost more storage; keep
   `NoncurrentDays` longer than the lock.

5. In the app, under **Settings → Target**: endpoint
   `https://hel1.your-objectstorage.com`, region `hel1`, the bucket, the
   key. **Test connection**, then **Create repository**: the app generates
   the repository password. The page shows what the bucket protects
   (versioning, Object Lock, lifecycle rules), read from the bucket itself.
6. **Download the recovery kit** and store it offline (password manager,
   safe). It holds the bucket's address, the key and the repository
   password: with it, restic restores everything without this app
   ([Restore](restore.md)). Without it, nobody can restore the backups when
   this app and its database are lost.

The commands set **compliance** mode: nobody can delete a locked version
before its lock ends, not even with the bucket's keys. In governance mode, a
key with the bypass permission can delete locked versions early. Hetzner's
own Object Lock guide shows such a bypass, and Hetzner's keys are valid for
every bucket of their project, so the key that Backup holds can most likely
do it: exactly the case the lock is for, a taken-over Backup server. This
is not tested against a real Hetzner bucket. Governance mode
(`"Mode":"GOVERNANCE"`) stays an option for those who accept that.

In compliance mode, nobody can empty or delete the bucket before the locks
of its objects end. Hetzner deletes all data when the contract ends, Object
Lock or not.

## Setup

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files:**

   ```sh
   git clone https://github.com/projecttogether/backup.git /srv/backup
   cd /srv/backup
   ```

3. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc`.
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set production values: `APP_URL`, `DATABASE_URL`,
   a new `AUTH_SECRET` and a new `ENCRYPTION_KEY` (each
   `openssl rand -base64 32`), the `OIDC_*` values, the admins in
   `ADMIN_EMAILS` or `ADMIN_GROUPS`, and `TZ` (the schedules' time zone,
   e.g. `Europe/Berlin`). Remove `NODE_ENV=development`, `RUN_MIGRATIONS`
   and `DATA_DIR`. With an `https` `APP_URL`, the app does not start with the
   example secrets. Without a database of your own, add
   `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a `POSTGRES_PASSWORD`
   (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://backups:<POSTGRES_PASSWORD>@postgres:5432/backups`.
   Keep a copy of `.env` with the recovery kit: `ENCRYPTION_KEY` opens the
   secrets the database stores.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   backup.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. With `BACKUP_PORT` set, use that port
   instead of 3000.

7. Open `APP_URL`, sign in, and set up the target as
   [above](#the-bucket), then the alerts (**Settings → Notifications**) and
   the [sources](sources.md). On the server, `cli settings` sets the same
   ([below](#settings-from-the-command-line)).

## Alerts

Under **Settings → Notifications**:

- **Email** over SMTP to the recipients: once when a source's backup fails
  or is overdue (no success for one and a half intervals), once when it works
  again, and when the daily upkeep fails. **Send test email** checks the
  settings.
- **Heartbeat URL:** while every source is fine and the repository is
  ready, the worker calls this URL every 15 minutes. Create a check at a
  monitor (healthchecks.io, Uptime Kuma, Better Stack, …) with a period of
  15 minutes and a grace time of about an hour: it alerts when the calls
  stop, also when this app or its server is down.

## The daily upkeep

At the time set under **Settings → Target** (default 04:30, time zone `TZ`),
the worker backs up the app's own database (`pg_dump`, tag `source:self`,
kept 14 days, 8 weeks, 12 months), then applies each source's retention,
removes data no snapshot needs (`restic prune`), checks the repository's
structure (on Sundays it also reads and verifies a random 5% of the
data), measures its size, and reads the bucket's protection
settings again. A failed upkeep sends an alert.

## Settings from the command line

What admins set under **Settings → Target**, **Settings → Notifications**
and **Sources** can also be set on the server, without a browser, with
`cli`. It runs the same code as the pages: the same checks, the same
encryption, and an entry in the audit log with the actor `operator` and the
command. In `/srv/backup`:

```sh
docker compose run --rm -T migrate cli settings list
```

In a running container, the command is just `cli …`
(`docker compose exec web cli settings list`).

| Command                                                | What it does                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `cli settings list [--json]`                           | Each setting and each source (with its ID): `set`, `not set` or `incomplete`, with hints such as `secret key …a1b2` |
| `cli settings show <name> [--id <id>]`                 | The setting as JSON, as the page reads it: secrets only as hints. `sources` without `--id`: every source            |
| `cli settings apply <name> [--id <id>]`                | Saves the JSON body on stdin, as the page's **Save** does; prints what `show` prints                                |
| `cli settings remove sources --id <id>`                | Deletes a source; its snapshots stay. `--snapshots forget`: the next upkeep forgets them                            |
| `cli settings test <name> [--id <id>]`                 | What the page's test button does                                                                                    |
| `cli settings test notifications --email\|--heartbeat` | Sends a test email to the recipients, or calls the heartbeat URL                                                    |
| `cli target initialize`                                | **Create repository**: `restic init` with a new password                                                            |
| `cli target connect`                                   | **Connect to an existing repository** with the password in the body `{"password": "…"}`                             |
| `cli target recovery-kit`                              | **Download recovery kit**, into a new private file (below): never onto a terminal                                   |
| `cli target confirm-recovery-kit`                      | **I stored the recovery kit**                                                                                       |
| `cli sources run <id>`                                 | **Back up now**                                                                                                     |
| `cli tokens create agent --source <id>`                | **New token** of an app source: prints only the token                                                               |
| `cli help`                                             | The commands and the setting names                                                                                  |

- The setting names: `target` (the bucket and its keys), `maintenance` (the
  time of the daily upkeep), `sources` (a list: one entry per source) and
  `notifications` (alert emails and the heartbeat URL).
- Secrets go only in the body on stdin, never in an argument (arguments show
  in `ps` and the shell history). Nothing prints a saved secret, except the
  recovery kit and a new agent token, which exist to be handed over.
- `apply` replaces the whole setting or source, as the page does: start from
  what `show` prints. As on the page, an empty or missing secret keeps the
  saved one.
- `apply sources` without `--id` adds a source; its ID goes to stderr. For
  an app source, stdout holds only the two lines for the agent's `.env`,
  `BACKUP_URL` and `BACKUP_TOKEN`, shown this once: redirect them into a
  new file that only its owner may read, as for the recovery kit and a new
  token: `(umask 077; set -C; docker compose exec -T web cli … > agent.env)`
  (`set -C` refuses to overwrite a regular file that is there already).
- Run every command that prints a secret with `docker compose exec`, as
  above, not `run`: Docker's log driver keeps what a container started with
  `run` prints, so the secret would end up in a log (with `journald` or a
  remote driver also after `--rm`).
- Exit codes: `0` done; `1` refused, with the page's message and the field
  on stderr (also a failed test); `2` a wrong command or a body that is not
  JSON.

The bodies, as the pages send them:

`target`: the bucket ([above](#the-bucket)). Then `cli settings test target`,
`cli target initialize` (or `cli target connect` for an existing
repository), the recovery kit into a new file that only its owner may read,
`(umask 077; set -C; docker compose exec -T web cli target recovery-kit > recovery-kit.txt)`,
store the kit offline and delete the file, and
`cli target confirm-recovery-kit`.

```json
{
  "endpoint": "https://hel1.your-objectstorage.com",
  "region": "hel1",
  "bucket": "acme-backups",
  "prefix": "",
  "accessKeyId": "<access key>",
  "secretAccessKey": "<secret key>"
}
```

`maintenance`: the time of the daily upkeep, in the time zone `TZ`.

```json
{ "maintenanceTime": "04:30" }
```

`notifications` (`security`: `tls` on port 465, `starttls` on 587, or
`none`). The heartbeat URL's path authorizes the pings, so it is a secret as
on the page: `show` prints only its server as `heartbeatUrlHint`, a body
without `heartbeatUrl` keeps the saved one, and `"heartbeatUrl": ""` turns the
heartbeat off. Then `cli settings test notifications --email` and
`--heartbeat`.

```json
{
  "email": {
    "enabled": true,
    "host": "mail.example.org",
    "port": 587,
    "security": "starttls",
    "username": "backup@example.org",
    "password": "<password>",
    "from": "backup@example.org",
    "recipients": ["it@example.org"]
  },
  "heartbeatUrl": "https://hc-ping.com/<check>",
  "notifyRecovery": true
}
```

`sources`: an app source. The bodies of the other kinds are in
[Sources](sources.md#from-the-command-line).

```json
{
  "kind": "app",
  "name": "Wiki",
  "schedule": { "type": "daily", "time": "02:00" },
  "retention": { "daily": 14, "weekly": 8, "monthly": 12, "yearly": 0 }
}
```

An AI with access to the server sets a key this way: it receives the secret
as a file, pipes the body into `cli settings apply`, runs
`cli settings test` and deletes the file. With `jq`, the secret never
appears in an argument:

```sh
jq -n --rawfile key s3-secret '{endpoint: "https://hel1.your-objectstorage.com", region: "hel1",
  bucket: "acme-backups", prefix: "", accessKeyId: "<access key>", secretAccessKey: ($key | rtrimstr("\n"))}' \
  | docker compose run --rm -T migrate cli settings apply target
docker compose run --rm -T migrate cli settings test target
rm s3-secret
```

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age. It stops while a job runs far longer than
  it should, so the check fails.

The heartbeat URL is the outside check of the backups themselves; set up an
uptime check on `<APP_URL>/-/readyz` too, if you have one.

## Upgrades

An upgrade pulls a newer image. In `/srv/backup`:

1. Read the pull requests merged since the running commit (**My settings**
   shows it under **About**). A pull request labeled `breaking` says what to
   do; take those steps.
2. Run `git pull` for the newest `compose.yaml`, then
   `docker compose up -d --pull always`. With `BACKUP_IMAGE_TAG` pinned to
   `sha-<commit>`, set the new commit first.

The `migrate` service applies database migrations before `web` and `worker`
start. An upgrade can happen at any time, also during a backup: `web` and
`worker` stop their runs (restic removes its locks) and a scheduled backup
that a restart interrupted is queued again after the restart, once. An
agent's upload starts again from the beginning; restic's deduplication keeps
that cheap. A backup an admin started by hand is not repeated: it fails, and
**Back up now** starts it again.

## Builds and deploys

Every commit on `main` that passes CI is built and, at ProjectTogether,
deployed. There are no numbered releases: the commit is the version.

- **CI** (`.github/workflows/ci.yaml`, on every pull request and on `main`):
  the history for secrets (Gitleaks), the files for private artifacts,
  internal names and credential formats (`scripts/check-public-repository.mjs`),
  lint, formatting, types, unit tests, migration drift, the build, the
  integration tests (PostgreSQL, restic, S3), the image (started with
  `compose.yaml`), and the backup agent (Go format, vet, tests, end-to-end
  test).
- **Deploy** (`.github/workflows/deploy.yml`), when CI passes on `main`, or
  by hand (Actions → Deploy → Run workflow), for example after a setting
  changed:
  1. It builds `ghcr.io/projecttogether/backup` with `APP_VERSION` set to
     the first 12 characters of the commit and pushes it as `sha-<commit>`
     and `latest`, and the same for the backup agent,
     `ghcr.io/projecttogether/backup-agent` (from `agent/`).
  2. It sends the image and the app's settings to the server of the GitHub
     environment `production` over SSH. The server's deploy script pulls the
     image, writes the settings, runs the migrations, starts `web` and
     `worker`, waits until both are healthy, and puts the previous image and
     settings back when they do not become healthy. One deploy runs at a
     time; a newer one waits.

Without the variable `DEPLOY_HOST` in the environment `production`, step 2
deploys nothing. Label a pull request `breaking` when the people who run the
app must act on it, and write the steps into its description; merging
deploys it, so take steps that must come first before merging.

The packages `backup` and `backup-agent` in GitHub's container registry must
be public, so that servers can pull them without a token: an owner of the
organization sets that once, after the first build.

### Settings

The settings come from two places:

- **Server settings**, written on the server by its own configuration
  (ProjectTogether's infrastructure repository): `APP_URL`, `DATABASE_URL`,
  `TZ`, `TRUST_PROXY`, `ENCRYPTION_KEY`, `AUTH_SECRET`, and
  `POSTGRES_PASSWORD` with `compose.postgres.yaml`. They win over the app
  settings.
- **App settings**, sent by the Deploy workflow at each deploy from the
  environment `production`: every other variable of
  [Configuration](configuration.md) that the app reads, as the workflow's
  `SETTINGS` list names them. Empty values are left out, so the app's
  default applies. A new setting needs a line in `SETTINGS` and its own line
  below it.

| Kind      | Names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets   | `DEPLOY_SSH_KEY`, `OIDC_CLIENT_SECRET`, `SENTRY_DSN`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Variables | `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `APP_URL` (the environment's link only), `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_PROVIDER_NAME`, `OIDC_SCOPES`, `OIDC_PKCE`, `OIDC_GROUPS_CLAIM`, `OIDC_REQUIRE_EMAIL_VERIFIED`, `ADMIN_EMAILS`, `ADMIN_GROUPS`, `SESSION_HOURS`, `APP_NAME`, `AGENT_PART_MB`, `AGENT_POLL_SECONDS`, `RUN_HISTORY_DAYS`, `AUDIT_LOG_DAYS`, `LOG_LEVEL`, `DATABASE_POOL_SIZE`, `DATABASE_STATEMENT_TIMEOUT_SECONDS`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` |

The build reads one more secret, of the repository or the organization, not
of the environment: `SENTRY_AUTH_TOKEN` ([Sentry](#error-reports-and-performance-data-sentry)).
Elsewhere, `compose.yaml` with a plain `.env` holds both kinds of settings
([Setup](#setup)).

### Rollbacks

A deploy that does not become healthy puts the previous image back by
itself. To go back by hand, revert the change on `main`, or run the server's
rollback. Neither undoes database migrations, so a migration keeps the
previous version working: add columns with a database default.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `backup@<commit>` for the
images of the Deploy workflow, unless `SENTRY_RELEASE` is set. The Deploy
workflow uploads the source maps to the Sentry project
`projecttogether/backups` when the secret `SENTRY_AUTH_TOKEN` (an
organization token) is set; without it, nothing is uploaded. Reports never
contain file names, names, email addresses, keys, request data or
variables. The worker's alert job checks in as the cron monitor
`backups-alerts`.

## Logs

Every process logs JSON lines to standard output (`docker compose logs
web`). Logs carry identifiers (source, run, request), never file names,
personal data or secrets. A run's own log (steps, files that could not be
copied) is on its page in the app.

## Hardening

- Serve the app over HTTPS only. Agents send their token and the backups
  over this connection.
- Keep the admins few: they can download every backup, including the HR
  data from Personio. Every download is in the audit log.
- Keep the recovery kit and a copy of `.env` offline, apart from the server.
- Use a bucket in a project of its own, with Object Lock
  ([The bucket](#the-bucket)).
- Use read-only access for the sources: the service account's Drive scope
  is `drive.readonly`; Personio credentials and the keys of S3 bucket
  sources need only read permissions.
