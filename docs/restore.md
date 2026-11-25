# Restore

Getting data back: from the app, or with the plain restic command line and
the recovery kit when the app is gone. The app never writes into a source;
restoring is a step a person takes.

## From the app

On a source's page, each snapshot has a **Download** link:

- **App (backup agent):** a tar file (`backup.tar` of the snapshot) with
  `manifest.json`, `db.dump` and `volumes/<name>/`.
- **Google Drive, Personio, S3 bucket:** a zip file of the copy at that
  time.

Every download is in the audit log.

## Without the app: the recovery kit

The recovery kit (**Settings → Target → Download recovery kit**) holds
everything restic needs. On any computer with
[restic](https://restic.net/) 0.17 or later:

```sh
export RESTIC_REPOSITORY=s3:https://hel1.your-objectstorage.com/acme-backups
export RESTIC_PASSWORD=…
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
export AWS_DEFAULT_REGION=hel1

restic snapshots                      # every snapshot with its tag (source:<id>)
restic snapshots --tag source:<id>    # the snapshots of one source
```

The kit lists which tag belongs to which source. Select a source's
snapshots by its tag, never by host: a repository taken over from an earlier
installation holds snapshots with another host name than the new ones
(`backup`), and both belong to the source.

## An app (backup agent)

On the app's server, in its folder (e.g. `/srv/wiki`):

1. **Get the archive** of the snapshot (from the app, or with restic):

   ```sh
   restic dump <snapshot> /backup.tar > backup.tar
   mkdir restore && tar -xf backup.tar -C restore
   cat restore/manifest.json     # the app, its image (version), the volumes
   ```

2. **Stop the app** but keep its database running:
   `docker compose stop web worker` (the services that write).
3. **Database:** restore the dump into the app's database, replacing what
   is there:

   ```sh
   docker compose cp restore/db.dump postgres:/tmp/db.dump   # with compose.postgres.yaml
   docker compose exec postgres pg_restore --clean --if-exists --no-owner \
     --username <user> --dbname <database> /tmp/db.dump
   ```

   With a database elsewhere, run this from a computer that reaches it, with
   `pg_restore` of the same or a newer major version:

   ```sh
   pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" restore/db.dump
   ```

4. **Files:** copy each volume's folder back into its volume, e.g. for
   the wiki's `files`:

   ```sh
   docker run --rm -v wiki_files:/target -v "$PWD/restore/volumes/files:/source:ro" alpine \
     sh -c 'rm -rf /target/* && cp -a /source/. /target/'
   ```

   The volume's name is `<project>_<volume>`; `docker volume ls` lists them.

5. **Keys:** the app's `.env` needs the settings that the source page and
   the recovery kit name (such as `ENCRYPTION_KEY`), with their values from
   the copy of the app's `.env` kept apart. The backups do not hold them.
6. **Start** the app with the version in the manifest's `image` (or newer):
   `docker compose up -d`. Migrations bring an older database up to date.
7. **The app's own steps:** then follow the app's deployment guide. Some
   apps require more steps after a restore.

## Google Drive

```sh
restic restore <snapshot> --target ./restore
```

The files are under `./restore/data/staging/<source id>/`. Upload them back
to Drive (drag them into the drive in the browser, or with
[rclone](https://rclone.org) `copy`). Google Docs, Sheets and Slides come
back as Office files; Drive converts them when they are opened.

## S3 bucket

```sh
restic restore <snapshot> --target ./restore
```

The objects are under `./restore/data/staging/<source id>/`, without the
folder's name if the source copied one folder. Copy them back into the
bucket, into that folder when the source copied one (for example
`originals/`), with [rclone](https://rclone.org) `copy` or `aws s3 sync`.

## Personio

```sh
restic restore <snapshot> --target ./restore
```

`employees.csv` and `employees.json` hold the people with their
attributes, `documents/` each person's documents. Personio has no import of
a whole export: take the records you need from the files.

## This app (Backup)

```sh
restic snapshots --tag source:self
restic dump <snapshot> /backups.dump > backups.dump
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" backups.dump
```

Start the app with the same `ENCRYPTION_KEY` as before: it opens the stored
secrets. Without the database, a new installation can use the existing
repository: under **Settings → Target**, enter the bucket, then
**Connect to an existing repository** with the password from the recovery
kit, and add the sources again.

## Test restores

A backup is only as good as its last restore. Restore one snapshot of each
source to another place now and then (for example each quarter), and write
down that it worked.
