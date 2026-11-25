#!/usr/bin/env bash
# End-to-end test of the backup agent image: PostgreSQL 18 with a little
# data, two volumes with files, and a fake Backup app
# (test/fake_backup_app.py) that keeps the stream it receives. The archive is
# checked with tar and restored with pg_restore. Needs Docker, Python 3, jq
# and curl.
# Usage: test/run.sh [image]   (without an image, it builds backup-agent:test)
set -euo pipefail
cd "$(dirname "$0")/.."

image=${1:-}
version=""
if [ -z "$image" ]; then
  version=test-commit
  docker build --quiet --build-arg "APP_VERSION=$version" --tag backup-agent:test . > /dev/null
  image=backup-agent:test
fi
postgres=postgres:18@sha256:e754b839f447639b7004895f4d8a4bfcb4e9dbe3a1bc035f27f646562a16fd61
db_port=55491
server_port=55492
token=bkp_EndToEndTestToken_0123456789abcdefghijklmno
password=e2e-Pg-Secret-4711
database_url="postgres://postgres:$password@127.0.0.1:$db_port/app"
work=$(mktemp -d)
state=$work/state
files=$work/data/files
uploads=$work/data/uploads
private=$work/private
mkdir -p "$state" "$files/docs" "$files/empty" "$uploads" "$work/out" "$private"
server=""

# as_root <command...>: runs a command of the image as root, with $private at /v.
as_root() { docker run --rm --user 0 --entrypoint "$1" --volume "$private:/v" "$image" "${@:2}"; }
cleanup() {
  docker rm --force backup-agent-test backup-agent-test-db > /dev/null 2>&1 || true
  [ -z "$server" ] || kill "$server" 2> /dev/null || true
  as_root rm -rf /v/jane-doe > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*"
  docker logs backup-agent-test 2>&1 | tail -n 30 || true
  exit 1
}
pass() { echo "ok: $*"; }
# eventually <seconds> <command...>: true once the command succeeds in time.
eventually() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.5
  done
}
logged() { docker logs backup-agent-test 2>&1 | grep -F -- "$1" > /dev/null; }
leaks() { docker logs backup-agent-test 2>&1 | grep -F -e "$password" -e "$token" -e wrong-password > /dev/null; }
sql() { docker exec backup-agent-test-db psql --username postgres --dbname "$1" --quiet --tuples-only --no-align --command "$2"; }
agent_settings=(--network host
  --env "BACKUP_URL=http://127.0.0.1:$server_port" --env "BACKUP_TOKEN=$token"
  --env APP_NAME=example --env APP_IMAGE=ghcr.io/example/app:1.2.3
  --env "APP_SECRETS= ENCRYPTION_KEY, AUTH_SECRET,,ENCRYPTION_KEY"
  --volume "$files:/data/files:ro" --volume "$uploads:/data/uploads:ro")
run() { docker run --detach --name backup-agent-test "$@" "$image" > /dev/null; }
# Stops the agent; fails unless it exits with 0 within 10 seconds.
stop() {
  local start=$SECONDS
  docker stop backup-agent-test > /dev/null
  [ $((SECONDS - start)) -le 10 ] || fail "docker stop took $((SECONDS - start))s"
  [ "$(docker inspect --format '{{.State.ExitCode}}' backup-agent-test)" = 0 ] || fail "the agent did not exit with 0"
  docker rm backup-agent-test > /dev/null
}
# job: the Backup app hands out a job with parts of 64 KiB at the next poll.
job() {
  rm -f "$state/complete.json" "$state/fail.json"
  echo 65536 > "$state/job"
}

# The volumes: files, a directory, an empty directory, a link, a FIFO
# (skipped) and a file the agent's user cannot read (skipped, a warning).
printf 'first note\n' > "$files/notes.txt"
printf '# A\n' > "$files/docs/a.md"
head -c 300000 /dev/urandom > "$files/docs/big.bin"
ln -s docs/a.md "$files/latest"
mkfifo "$files/pipe"
printf 'private\n' > "$files/private.txt"
printf 'upload\n' > "$uploads/photo.jpg"
chmod -R a+rX "$work/data"
chmod 600 "$files/private.txt"

docker run --detach --name backup-agent-test-db --env "POSTGRES_PASSWORD=$password" --env POSTGRES_DB=app \
  --publish "127.0.0.1:$db_port:5432" "$postgres" > /dev/null
FAKE_TOKEN=$token python3 test/fake_backup_app.py "$server_port" "$state" &
server=$!
# The init server of the image listens only on its socket: wait for TCP.
eventually 60 docker exec backup-agent-test-db pg_isready --host 127.0.0.1 --username postgres --dbname app > /dev/null ||
  fail "PostgreSQL did not start"
sql app "CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL); INSERT INTO notes (body) VALUES ('one'), ('two'), ('three');"
eventually 10 curl --silent --output /dev/null "http://127.0.0.1:$server_port/" || fail "the fake Backup app did not start"

if [ -n "$version" ]; then
  [ "$(docker run --rm "$image" version)" = "$version" ] || fail "version does not print $version"
  pass "version prints APP_VERSION"
fi
[ "$(docker run --rm --entrypoint id "$image" -u)" = 65534 ] || fail "the image does not run as nobody"
docker run --rm --entrypoint pg_dump "$image" --version | grep -q '(PostgreSQL) 18\.' || fail "the image has no pg_dump 18"
pass "runs as nobody, with pg_dump 18"

# A wrong setting: check explains it and exits with 1, without the secret.
output=$(docker run --rm --env BACKUP_URL=https://backup.example.org "$image" check 2>&1) && fail "check passed without BACKUP_TOKEN"
grep -q BACKUP_TOKEN <<< "$output" || fail "no word about BACKUP_TOKEN: $output"
output=$(docker run --rm --env "DATABASE_URL=mysql://app:$password@db/app" "$image" check 2>&1) && fail "check took a MySQL URL"
grep -q DATABASE_URL <<< "$output" || fail "no word about DATABASE_URL: $output"
! grep -qF "$password" <<< "$output" || fail "the error shows the password: $output"
pass "check refuses a missing token and a URL that is no PostgreSQL URL, without showing it"

# The agent itself never exits on a wrong setting (an app update would roll
# back): it logs it once, stays up without asking the Backup app, and stops with 0.
run "${agent_settings[@]}" --env "DATABASE_URL=mysql://app:$password@db/app"
eventually 10 logged "DATABASE_URL must start with" || fail "no message about DATABASE_URL"
sleep 2
[ "$(docker inspect --format '{{.State.Running}}' backup-agent-test)" = true ] || fail "the agent exited on a wrong setting"
[ "$(docker logs backup-agent-test 2>&1 | wc -l)" = 1 ] || fail "the agent logged more than the setting: $(docker logs backup-agent-test 2>&1)"
! leaks || fail "the log shows the password or the token"
stop
[ ! -e "$state/requests" ] || fail "the agent asked the Backup app with a wrong setting"
pass "a wrong setting leaves the agent idle, without requests; it stops with exit code 0"

# Without BACKUP_URL the agent is idle, and stops at once.
run
eventually 10 logged "BACKUP_URL is empty" || fail "no idle message"
stop
[ ! -e "$state/requests" ] || fail "the idle agent sent requests"
pass "idle without BACKUP_URL, stops with exit code 0"

# check: settings, volumes, pg_dump, the database and the Backup app; takes no job.
job
output=$(docker run --rm "${agent_settings[@]}" --env "DATABASE_URL=$database_url" "$image" check) || fail "check failed: $output"
for want in "ok       Volumes in /data: files, uploads" \
  'warning  Volume files: 3 files, 300.0 kB. Backups skip a file that cannot be read: "private.txt" (permission denied).' \
  "ok       Volume uploads: 1 file, 7 bytes." "pg_dump (PostgreSQL) 18." "Database: answers (PostgreSQL 18." 'Backup app: answers, as the source "Example"'; do
  grep -qF "$want" <<< "$output" || fail "check did not print '$want': $output"
done
[ -e "$state/job" ] || fail "check took the job"
tail -n 1 "$state/polls" | jq -e '.check == true and .database == true and .volumes == ["files", "uploads"] and
  .app.secrets == ["ENCRYPTION_KEY", "AUTH_SECRET"]' > /dev/null ||
  fail "unexpected poll of check: $(tail -n 1 "$state/polls")"
output=$(docker run --rm "${agent_settings[@]}" --env "DATABASE_URL=${database_url/$password/wrong-password}" "$image" check) &&
  fail "check passed with a wrong password"
grep -q "problem  Database: pg_dump failed: .*password authentication failed" <<< "$output" || fail "check did not explain: $output"
! grep -qF wrong-password <<< "$output" || fail "check shows the password: $output"
pass "check reports the volumes and their files, pg_dump, the database and the Backup app, and takes no job"

# A backup: parts of 64 KiB, with a lost part, a lost answer and a damaged part on the way.
printf '1 500\n2 store-500\n3 422\n' > "$state/faults"
run "${agent_settings[@]}" --env "DATABASE_URL=$database_url"
eventually 60 test -s "$state/complete.json" || fail "no complete"
eventually 10 logged 'msg="Backup sent."' || fail "the Backup app did not accept the totals"
for n in 1 2 3; do
  [ "$(grep -cE "^PUT .*/parts/$n( |\$)" "$state/requests")" = 2 ] || fail "part $n was not sent twice: $(cat "$state/requests")"
done
jq -e '.parts > 4 and .warnings == ["1 file could not be read"]' "$state/complete.json" > /dev/null ||
  fail "unexpected totals: $(cat "$state/complete.json")"
logged 'msg="Skipped a file that cannot be read." job=' || fail "the unreadable file was not logged"
logged "volume=files path=private.txt" || fail "the unreadable file was not logged with its path"
! leaks || fail "the log shows the password or the token"
stop
pass "sends the backup in parts, again after errors, and completes"

expected="manifest.json
db.dump
volumes/files/
volumes/files/docs/
volumes/files/docs/a.md
volumes/files/docs/big.bin
volumes/files/empty/
volumes/files/latest
volumes/files/notes.txt
volumes/uploads/
volumes/uploads/photo.jpg"
listing=$(tar -tf "$state/stream.tar")
[ "$listing" = "$expected" ] || fail "the archive holds:
$listing"
tar -tvf "$state/stream.tar" | grep -q 'volumes/files/latest -> docs/a.md$' || fail "latest is no link"
tar -xf "$state/stream.tar" -C "$work/out"
for name in notes.txt docs/a.md docs/big.bin latest; do
  cmp "$files/$name" "$work/out/volumes/files/$name" || fail "$name differs"
done
cmp "$uploads/photo.jpg" "$work/out/volumes/uploads/photo.jpg" || fail "photo.jpg differs"
jq -e --arg version "$version" '.format == 1 and (.createdAt | test("^[0-9-]{10}T[0-9:]{8}Z$")) and
  ($version == "" or .agent.version == $version) and
  .app == {"name": "example", "image": "ghcr.io/example/app:1.2.3", "secrets": ["ENCRYPTION_KEY", "AUTH_SECRET"]} and
  .database.included and .database.file == "db.dump" and .database.format == "pg_dump custom" and
  (.database.serverVersion | test("^18\\.[0-9]+$")) and .volumes == ["files", "uploads"]' "$work/out/manifest.json" > /dev/null ||
  fail "unexpected manifest: $(cat "$work/out/manifest.json")"
pass "the archive: manifest.json, db.dump, then the volumes in order, links as links, without the FIFO and the unreadable file"

docker cp "$work/out/db.dump" backup-agent-test-db:/tmp/db.dump
docker exec backup-agent-test-db pg_restore --list /tmp/db.dump | grep -q 'TABLE DATA public notes' || fail "pg_restore --list shows no notes"
docker exec backup-agent-test-db createdb --username postgres restored
docker exec backup-agent-test-db pg_restore --username postgres --no-owner --dbname restored /tmp/db.dump
[ "$(sql restored 'SELECT string_agg(body, $$,$$ ORDER BY id) FROM notes')" = "one,two,three" ] || fail "the restored database differs"
pass "db.dump restores with pg_restore"

# dump-database: the database alone to stdout, without the Backup app's settings.
# Restored with the command of README.md ("Restore a dump"), also over a
# newer version's migration, which that command undoes in full.
docker run --rm --network host --env "DATABASE_URL=$database_url" "$image" dump-database > "$work/app.dump" ||
  fail "dump-database failed"
[ "$(head -c 5 "$work/app.dump")" = PGDMP ] || fail "dump-database wrote no pg_dump archive"
# shellcheck disable=SC2016 # the container's shell expands $DATABASE_URL
restore_script='
  pg_restore --clean --if-exists --no-owner --file=/tmp/restore.sql &&
  psql --dbname="$DATABASE_URL" --single-transaction --set=ON_ERROR_STOP=1 --quiet --output=/dev/null \
    --command="SET client_min_messages = warning; DROP SCHEMA public CASCADE;
      CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC;" \
    --file=/tmp/restore.sql'
restore() {
  docker run --rm --interactive --network host --env "DATABASE_URL=${database_url%/app}/dumped" --entrypoint sh "$image" -c "$restore_script" < "$1"
}
docker exec backup-agent-test-db createdb --username postgres dumped
restore "$work/app.dump" || fail "the dump of dump-database did not restore"
[ "$(sql dumped 'SELECT string_agg(body, $$,$$ ORDER BY id) FROM notes')" = "one,two,three" ] || fail "the restored dump differs"
sql dumped "CREATE TABLE tags (note_id int NOT NULL REFERENCES notes); INSERT INTO tags VALUES (1); UPDATE notes SET body = 'new';"
head -c 2000 "$work/app.dump" > "$work/truncated.dump"
restore "$work/truncated.dump" 2> /dev/null && fail "a truncated dump restored"
[ "$(sql dumped 'SELECT count(*) FROM tags')" = 1 ] || fail "a failed restore changed the database"
restore "$work/app.dump" || fail "the dump did not restore over the migration"
[ "$(sql dumped 'SELECT string_agg(body, $$,$$ ORDER BY id) FROM notes')" = "one,two,three" ] || fail "the restore did not undo the migration"
[ "$(sql dumped "SELECT to_regclass('public.tags') IS NULL")" = t ] || fail "the restore kept the table of the migration"
output=$(docker run --rm --network host --env "DATABASE_URL=${database_url/$password/wrong-password}" "$image" dump-database 2>&1 > "$work/failed.dump") &&
  fail "dump-database passed with a wrong password"
grep -q "^pg_dump failed: .*password authentication failed" <<< "$output" || fail "dump-database did not explain: $output"
if [ "$(wc -l <<< "$output")" != 1 ] || grep -qF wrong-password <<< "$output"; then fail "unexpected error: $output"; fi
[ ! -s "$work/failed.dump" ] || fail "a failed dump wrote data"
output=$(docker run --rm --tty --env "DATABASE_URL=$database_url" "$image" dump-database 2>&1) && fail "dump-database wrote to a terminal"
grep -q "which is a terminal" <<< "$output" || fail "dump-database did not refuse the terminal: $output"
pass "dump-database writes a dump that restores, also over a migration, and fails without secrets or on a terminal"

# pg_dump fails: the Backup app hears why, without the password; nothing is sent.
job
run "${agent_settings[@]}" --env "DATABASE_URL=${database_url/$password/wrong-password}"
eventually 30 test -s "$state/fail.json" || fail "no failure reported"
jq -e '.message | test("^pg_dump failed: .*password authentication failed") and (test("wrong-password|postgres://") | not)' "$state/fail.json" > /dev/null ||
  fail "unexpected failure: $(cat "$state/fail.json")"
[ ! -s "$state/stream.tar" ] || fail "parts were sent after pg_dump failed"
! leaks || fail "the log shows the password or the token"
stop
pass "a failed pg_dump is reported without secrets"

# Stopped during a job: the Backup app hears it.
job
printf '0 slow\n' > "$state/faults"
run "${agent_settings[@]}" --env "DATABASE_URL=$database_url"
eventually 30 grep -q "^PUT .*/parts/0 slow" "$state/requests" || fail "the first part did not arrive"
stop
eventually 5 test -s "$state/fail.json" || fail "no failure reported"
[ "$(jq -r .message "$state/fail.json")" = "The agent was stopped" ] || fail "unexpected failure: $(cat "$state/fail.json")"
pass "a stopped agent reports the job as failed"

# An app that runs as uid 10001 keeps private folders (mode 0700). As
# nobody the agent cannot list them: check reports a problem, and the backup
# fails, naming the volume but not the folder. As the app's user both work.
as_root sh -c 'mkdir /v/jane-doe && echo receipt > /v/jane-doe/receipt.pdf &&
  chown -R 10001:10001 /v/jane-doe && chmod 700 /v/jane-doe && chmod 600 /v/jane-doe/receipt.pdf'
chmod a+rX "$private"
private_settings=("${agent_settings[@]}" --volume "$private:/data/private_data:ro")
folder_message='A folder in the volume "private_data" cannot be read (permission denied). Run the agent as the app'"'"'s user: set user: of the backup-agent service, such as "10001:10001".'
output=$(docker run --rm "${private_settings[@]}" "$image" check) && fail "check passed with a folder it cannot read: $output"
grep -qF 'problem  Volume private_data: backups fail. A folder cannot be read: "jane-doe" (permission denied). Run the agent as the app'"'"'s user: set user: of the backup-agent service, such as "10001:10001".' <<< "$output" ||
  fail "check did not explain the folder: $output"
job
run "${private_settings[@]}"
eventually 30 test -s "$state/fail.json" || fail "no failure reported"
[ "$(jq -r .message "$state/fail.json")" = "$folder_message" ] || fail "unexpected failure: $(cat "$state/fail.json")"
[ ! -e "$state/complete.json" ] || fail "the backup completed without the folder"
logged 'msg="A folder cannot be read, so the backup fails." job=' || fail "the folder was not logged"
logged "volume=private_data path=jane-doe" || fail "the folder was not logged with its path"
stop
pass "a folder the agent cannot read fails check and the backup, without its path in the Backup app"

output=$(docker run --rm --user 10001:10001 "${private_settings[@]}" "$image" check) || fail "check failed as the app's user: $output"
grep -qF "ok       Volume private_data: 1 file, 8 bytes." <<< "$output" || fail "check did not count the private file: $output"
job
run --user 10001:10001 "${private_settings[@]}"
eventually 30 test -s "$state/complete.json" || fail "no complete as the app's user"
eventually 10 logged 'msg="Backup sent."' || fail "the Backup app did not accept the totals"
[ ! -e "$state/fail.json" ] || fail "unexpected failure: $(cat "$state/fail.json")"
[ "$(tar -xOf "$state/stream.tar" volumes/private_data/jane-doe/receipt.pdf)" = receipt ] || fail "the private file is not in the archive"
tar -tvf "$state/stream.tar" | grep -qE '^drwx------ 10001/10001 .* volumes/private_data/jane-doe/$' || fail "the folder lost its owner or mode"
stop
pass "as the app's user (user: 10001:10001), check and the backup read the private folder"

# A folder that others may list but not enter (0744): its names show, but
# nothing in it can be read. That fails too, rather than a warning per file.
as_root chmod 744 /v/jane-doe
output=$(docker run --rm "${private_settings[@]}" "$image" check) && fail "check passed with a folder it cannot enter: $output"
grep -qF 'problem  Volume private_data: backups fail. A folder cannot be read: "jane-doe" (permission denied).' <<< "$output" ||
  fail "check did not explain the folder it cannot enter: $output"
job
run "${private_settings[@]}"
eventually 30 test -s "$state/fail.json" || fail "no failure reported for a folder the agent cannot enter"
[ "$(jq -r .message "$state/fail.json")" = "$folder_message" ] || fail "unexpected failure: $(cat "$state/fail.json")"
[ ! -e "$state/complete.json" ] || fail "the backup completed without the folder's files"
stop
pass "a folder the agent may list but not enter fails check and the backup"

echo "All tests passed."
