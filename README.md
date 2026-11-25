# Backup

ProjectTogether's open-source backup app. Self-hosted backups of what an
organization cannot lose: the database and files of its apps, Google Drive,
Personio, and S3 buckets, encrypted and deduplicated into one repository in
S3-compatible storage such as Hetzner Object Storage.

- **One dashboard.** Every source with its status (OK, failed, overdue,
  running), its last successful backup, size and next run; the target with
  its size, integrity check and protection; the runs with their logs.
- **Apps with PostgreSQL and Docker volumes** through the
  [backup agent](agent/README.md) in `agent/`, a small program next to each
  app: it streams a `pg_dump` and the app's volumes on request, connects out
  over HTTPS, and opens no port. The app itself needs no change.
- **Google Drive** (Google Workspace): a shared drive or folders, through a
  service account with domain-wide delegation and read-only access. Google
  Docs, Sheets and Slides are saved as Office files.
- **Personio:** every person with every attribute the API credential may
  read (JSON and CSV), and each person's documents.
- **S3 buckets:** the objects of an S3-compatible bucket, or of one folder
  in it, through a read-only key; for example the uploads an app keeps in a
  bucket.
- **restic does the work:** encryption, deduplication, compression,
  snapshots, retention per source and integrity checks. One schedule and
  one retention per source; a daily upkeep.
- **Restore without the app:** the recovery kit holds the bucket's address,
  keys and the repository password, so the plain restic command line
  restores everything even when this app is gone. In the app, each snapshot
  downloads as a tar or zip file.
- **Alerts** by email when a backup fails or is overdue, and a heartbeat URL
  for an outside monitor, which raises the alarm when the app itself stops.
- **Admins only:** sign-in with any OpenID Connect provider, for the
  addresses in `ADMIN_EMAILS` or the groups in `ADMIN_GROUPS`. An audit log
  records every change and download.
- **Settings from the command line:** `cli settings` sets the target, the
  sources and the alerts on the server, without a browser, with the same
  checks as the pages.
- **Deploys at any time:** a restart during a backup queues a scheduled
  backup again, once, so an upgrade never costs a day's backup.

Hono server, React web app, PostgreSQL, restic, rclone, one Docker image; the
backup agent is a Go program with an image of its own.

## Documentation

- [Deployment](docs/deployment.md): the server, the bucket (Hetzner Object
  Storage with Object Lock and lifecycle rules), settings from the command
  line, upgrades, builds and deploys.
- [Sources](docs/sources.md): connecting apps (through the backup agent),
  Google Drive, Personio and S3 buckets.
- [Restore](docs/restore.md): getting data back, with or without the app.
- [Configuration](docs/configuration.md): every environment variable.
- [Architecture](docs/architecture.md): how it works inside.
- [Backup agent](agent/README.md): setting up the agent next to an app, and
  its protocol.
- [Contributing](CONTRIBUTING.md): development setup and checks.

## Quick start (development)

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18, Keycloak, S3 storage, Mailpit
cp .env.example .env.local
npm ci
npm run dev
```

The development server needs `restic` on the `PATH` (and `rclone` for Google
Drive and S3 buckets). Open http://localhost:5173 and sign in as
`ada@example.org` (password `backups-dev`). Set the target under
**Settings → Target** with the values in `.env.example`, create the
repository, then add a source.

## License

Copyright 2026 ProjectTogether gGmbH

Licensed under the [Apache License 2.0](LICENSE).
