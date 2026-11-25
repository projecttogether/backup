# Sources

What Backup backs up, and how to connect it. Add a source under
**Sources → Add source**. Each source has its own schedule (every few
hours, daily or weekly, in the server's time zone `TZ`) and its own
retention (the newest snapshot of each of the last N days, weeks, months and
years; the newest snapshot always stays). **Test** checks the connection,
**Back up now** starts a backup at once. On the server, `cli settings` adds
and changes sources without a browser ([below](#from-the-command-line)).

## Apps (backup agent)

Apps with a PostgreSQL database and Docker volumes, through the backup agent
in [`agent/`](../agent/README.md). The agent runs next to the app, on the
app's server: as a Compose project of its own that joins the app's network
and mounts its volumes read-only (so the app contains nothing about
backups), or as one more service of the app's compose file. When a backup is
due, the agent dumps the app's database (`pg_dump`) and reads the app's
volumes (read-only), and streams both as one tar file to Backup, which
stores it with restic. The agent connects out over HTTPS; it opens no port
and holds no key of the bucket. Its image is
`ghcr.io/projecttogether/backup-agent`; its README describes the setup.

1. In Backup, add a source of the kind **App (backup agent)**, e.g. "Wiki".
   The app shows the agent's token once, with the two lines for the agent's
   `.env`:

   ```sh
   BACKUP_URL=https://backup.example.org
   BACKUP_TOKEN=bkp_…
   ```

2. On the app's server, set up the agent as its
   [README](../agent/README.md#set-it-up) shows, with these lines in its
   `.env`, and start it: `docker compose up -d`.
3. The source page shows when the agent last asked, its version, the app's
   image, and the volumes it sees. **Back up now** runs the first backup.

**The agent's user.** Run the agent as the app's user (`user:` of the
agent's service). An app that keeps private folders readable only by their
owner (`0700`) needs it, such as `user: "10001:10001"`. A folder the agent
cannot read fails the backup.

**Keys a restore needs.** The agent's `APP_SECRETS` names the settings in
the app's `.env` that a restore needs, such as `ENCRYPTION_KEY`. The agent
reports the names, never the values; the source page and the recovery kit
list them. The backups do not hold these keys: keep a copy of the app's
`.env` apart from its server, with the recovery kit.

**Restarts.** A restart of Backup's `web` or of the agent during a backup
ends the upload; a scheduled backup is then queued again, once, and the
agent sends it again from the beginning at its next poll
([Upgrades](deployment.md#upgrades)). Schedule an app's backup before the
times its own updates run database migrations: a fresh backup is the way
back.

The token belongs to the source; **New token** replaces it (the old one
stops working at once). Each snapshot holds one file, `backup.tar`:
`manifest.json`, `db.dump` (`pg_dump` custom format) and `volumes/<name>/`.

A backup that the agent does not pick up within 2 hours fails ("The agent did
not ask for the job"), so a stopped agent shows up as a failed or overdue
source.

## Google Drive

For Google Workspace. A service account acts, with domain-wide delegation,
as a Workspace user with read-only access to Drive, and copies a shared
drive or a set of folders into the app's local copy (`/data/staging`). Each
run copies only what changed; restic then saves the copy as a snapshot.
Google Docs, Sheets, Slides and Drawings are saved as `.docx`, `.xlsx`,
`.pptx` and `.svg`.

1. **Service account:** in the [Google Cloud console](https://console.cloud.google.com),
   in a project of your organization, enable the Google Drive API, create a
   service account, and create a JSON key for it.
2. **Domain-wide delegation:** in the
   [Google Admin console](https://admin.google.com) under Security → Access
   and data control → API controls → Manage domain-wide delegation, add the
   service account's client ID with the scope
   `https://www.googleapis.com/auth/drive.readonly`.
3. **The user to act as:** a Workspace user that sees what to back up, for
   example a dedicated `backup@example.org`, a member (Viewer is enough) of
   the shared drive, or with the folders shared with it.
4. In Backup, add a source of the kind **Google Drive**: the user's
   address, either the shared drive's ID or the folders' IDs (the last part
   of their address, `drive.google.com/drive/folders/<id>`) with a name for
   each, and the JSON key.
5. **Test** checks access and counts the files. The first backup checks that
   the data volume has room for the copy, and refuses otherwise.

Files that cannot be copied (for example a Google document larger than
Google's export limit) are listed in the run's log, and the run ends with a
warning; the rest is saved. When Google refuses the whole copy (wrong key,
missing delegation), the run fails and saves nothing, so an old copy is
never saved as if it were new. Whether Google's export limit of 10 MB
applies to rclone's way of exporting is not verified.

Why the local copy: the size of a drive is not known in advance, and the
copy lets each run fetch only what changed. It needs as much disk space as
the drive holds. The copy is not encrypted on the app's server; the
snapshots in the bucket are.

## Personio

Every person with every attribute the API credential may read, and each
person's documents. Each run writes:

| File                                        | Content                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `employees.json`                            | Every person as Personio sends them                                                 |
| `employees.csv`                             | One row per person, one column per attribute (UTF-8, opens in spreadsheet programs) |
| `attributes.json`                           | The attributes the credential may read                                              |
| `documents/<id> <last name>, <first name>/` | The person's documents and `documents.json` (their list)                            |
| `document-categories.json`, `export.json`   | Document categories; when and how much was exported                                 |

1. In Personio, create API credentials (Marketplace → Connected
   integrations → Create custom integration; it needs the Core Pro plan)
   with **read** access to the employee attributes to back up and to
   documents. Personio sends only the attributes ticked for the credential.
2. In Backup, add a source of the kind **Personio**: the client ID and
   secret, and whether to back up documents.
3. **Test** counts the people and checks that documents can be listed.

People come from Personio's API v1, documents from its Document Management
API v2, which Personio calls beta. Documents already in the copy are not
downloaded again. Documents that cannot be downloaded (for example marked
unsafe by Personio's virus scan) are listed in the run's log, and the run
ends with a warning. Documents of Personio Payroll and DATEV are not
available through the API.

**Privacy:** these are personnel records under the GDPR. Only admins can
see or download them, and every download is in the audit log. The
retention decides how long the data of people who left stays in the
backups; choose and document that period. A deleted source can take its
snapshots with it (**Delete → Forget its snapshots**); the next upkeep then
removes the data, and the bucket's lifecycle rules remove the old versions
once their lock ends.

## S3 bucket

The objects of an S3-compatible bucket (Hetzner Object Storage, AWS S3,
MinIO, RustFS, …), or of one folder in it. For example the uploads of an
app that keeps its files in a bucket, which its backup agent does not see:
back up the bucket with this source, and the app's database with an app
source.

rclone copies the objects into Backup's local copy (`/data/staging`); each
run fetches only the objects whose size or upload time changed. restic then
saves the copy as a snapshot.

1. **A key that may only read the bucket:** list and read its objects
   (`s3:ListBucket`, `s3:GetObject`); Backup never writes to it. Hetzner's
   keys are valid for every bucket of their project, and whether Hetzner can
   limit a key to reading one bucket is not verified. A key that may also
   write works, but then a taken-over Backup server could change the bucket.
2. In Backup, add a source of the kind **S3 bucket**: the endpoint (e.g.
   `https://fsn1.your-objectstorage.com`), the region if the provider needs
   one, the bucket's name, optionally a folder in it (only the objects under
   it), and the key. The secret key is stored encrypted and never shown
   again.
3. **Test** counts the objects and their size. The first backup checks that
   the data volume has room for the copy, and refuses otherwise.

Objects that cannot be copied are listed in the run's log, and the run ends
with a warning; the rest is saved. When the bucket refuses the whole copy
(wrong key, missing bucket), the run fails and saves nothing, so an old copy
is never saved as if it were new. A folder that does not exist counts as
empty: **Test** then says that it found no objects.

Like Google Drive, the copy needs as much disk space as the bucket holds,
and it is not encrypted on Backup's server; the snapshots in the target
are.

## From the command line

`cli settings apply sources` adds a source with the body the **Add source**
page sends; with `--id <id>` it changes that source
([Deployment](deployment.md#settings-from-the-command-line)). Every kind has
a `name`, a `schedule` and a `retention`:

- `schedule`: `{"type": "daily", "time": "02:00"}`,
  `{"type": "weekly", "day": 0, "time": "03:00"}` (0 is Sunday), or
  `{"type": "hourly", "every": 6, "minute": 0}` (every 1, 2, 3, 4, 6, 8 or
  12 hours). Server time, `TZ`.
- `retention`: `{"daily": 14, "weekly": 8, "monthly": 12, "yearly": 0}`.
- `"enabled": false` pauses the source.

An **app**. stdout holds only `BACKUP_URL` and `BACKUP_TOKEN` for the
agent's `.env` (run it with `docker compose exec -T web cli …` and redirect
it into a new file with `umask 077` and `set -C`);
`cli tokens create agent --source <id>` issues a new token later.

```json
{
  "kind": "app",
  "name": "Wiki",
  "schedule": { "type": "daily", "time": "02:00" },
  "retention": { "daily": 14, "weekly": 8, "monthly": 12, "yearly": 0 }
}
```

**Google Drive**: a shared drive (`"scope": {"type": "folders", "folders":
[{"id": "<folder id>", "label": "Finance"}]}` for folders), and the service
account's JSON key as a string. With `jq`:
`jq -n --rawfile key service-account.json '{…, secrets: {serviceAccountKey: $key}}'`.

```json
{
  "kind": "google_drive",
  "name": "Shared drive",
  "schedule": { "type": "daily", "time": "01:00" },
  "retention": { "daily": 14, "weekly": 8, "monthly": 12, "yearly": 0 },
  "config": {
    "subject": "backup@example.org",
    "scope": { "type": "shared_drive", "driveId": "<shared drive id>" }
  },
  "secrets": { "serviceAccountKey": "<the JSON key, as a string>" }
}
```

**Personio** (`baseUrl` only when Personio names another one):

```json
{
  "kind": "personio",
  "name": "Personio",
  "schedule": { "type": "daily", "time": "01:30" },
  "retention": { "daily": 14, "weekly": 8, "monthly": 12, "yearly": 0 },
  "config": { "clientId": "<client ID>", "documents": true },
  "secrets": { "clientSecret": "<client secret>" }
}
```

**S3 bucket** (`prefix`: a folder in the bucket, or `""` for all of it):

```json
{
  "kind": "s3_bucket",
  "name": "Media files",
  "schedule": { "type": "daily", "time": "03:00" },
  "retention": { "daily": 14, "weekly": 8, "monthly": 12, "yearly": 0 },
  "config": {
    "endpoint": "https://fsn1.your-objectstorage.com",
    "region": "fsn1",
    "bucket": "acme-media",
    "prefix": "",
    "accessKeyId": "<access key>"
  },
  "secrets": { "secretAccessKey": "<secret key>" }
}
```

Then `cli settings test sources --id <id>` checks the source, and
`cli sources run <id>` starts its first backup.
`cli settings remove sources --id <id>` deletes it; its snapshots stay in
the repository unless `--snapshots forget` is given.

## This app

The app backs up its own database every day during the upkeep (tag
`source:self`), so the sources, schedules and run history can be restored
too. Its secrets are encrypted with `ENCRYPTION_KEY`: keep a copy of `.env`
with the recovery kit.
