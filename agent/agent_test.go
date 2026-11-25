package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPollSendsTheAppAndItsVolumes(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, _, _ := testAgent(t, f, map[string]string{"DATABASE_URL": "postgres://app:pw@db/app", "APP_SECRETS": " ENCRYPTION_KEY, AUTH_SECRET,,ENCRYPTION_KEY"})
	writeFiles(t, agent.cfg.DataDir, map[string]string{"uploads/a": "a", "files/b": "b", "stray": "x"})
	answer, err := agent.client.Poll(context.Background(), agent.pollRequest(false))
	if err != nil {
		t.Fatal(err)
	}
	if answer.Source.Name != "Example" || answer.PollSeconds != 30 || answer.Job != nil {
		t.Errorf("answer %+v", answer)
	}
	got := f.polls[0]
	if got.Agent.Version != "0.1.0" || got.App.Name != "example" || got.App.Image != "ghcr.io/example/app:1.2.3" ||
		strings.Join(got.App.Secrets, ",") != "ENCRYPTION_KEY,AUTH_SECRET" ||
		!got.Database || strings.Join(got.Volumes, ",") != "files,uploads" || got.Check {
		t.Errorf("poll body %+v", got)
	}

	// Without APP_SECRETS: "secrets": [], also in a Config made by hand.
	for _, agent := range []*Agent{testAgentOnly(t, f), {cfg: Config{}}} {
		body, err := json.Marshal(agent.pollRequest(false))
		if err != nil || !strings.Contains(string(body), `"app":{"name":"`) || !strings.Contains(string(body), `,"secrets":[]},`) {
			t.Errorf("poll body %s, %v", body, err)
		}
	}
}

func testAgentOnly(t *testing.T, f *fakeBackupApp) *Agent {
	agent, _, _ := testAgent(t, f, nil)
	return agent
}

func TestPollWithAWrongToken(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, logs, _ := testAgent(t, f, map[string]string{"BACKUP_TOKEN": "bkp_" + strings.Repeat("x", 43)})
	if _, err := agent.client.Poll(context.Background(), agent.pollRequest(false)); !errors.Is(err, errUnauthorized) {
		t.Fatalf("Poll = %v, want errUnauthorized", err)
	}
	state := pollState{interval: defaultPoll}
	for range 3 {
		if job := agent.pollOnce(context.Background(), &state); job != nil {
			t.Fatal("a job without a valid token")
		}
	}
	if n := strings.Count(logs.String(), `msg="The Backup app refused the token`); n != 1 {
		t.Errorf("the refusal was logged %d times, want once:\n%s", n, logs)
	}
	if state.interval != defaultPoll {
		t.Errorf("interval %v after 401, want the default", state.interval)
	}
}

func TestPollSecondsSetTheInterval(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, _, _ := testAgent(t, f, nil)
	state := pollState{interval: defaultPoll}
	for _, c := range []struct {
		seconds int
		want    time.Duration
	}{{30, 30 * time.Second}, {0, 30 * time.Second}, {999999, time.Hour}, {1, time.Second}} {
		f.mu.Lock()
		f.pollSeconds = c.seconds
		f.mu.Unlock()
		agent.pollOnce(context.Background(), &state)
		if state.interval != c.want {
			t.Errorf("pollSeconds %d: interval %v, want %v", c.seconds, state.interval, c.want)
		}
	}
	if d := jitter(time.Minute); d < time.Minute || d >= 66*time.Second {
		t.Errorf("jitter(1m) = %v", d)
	}
}

func TestIdleWithoutBackupURL(t *testing.T) {
	agent, logs, _ := testAgent(t, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int)
	go func() { done <- agent.Run(ctx) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("exit %d, want 0", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the idle agent did not stop")
	}
	if n := strings.Count(logs.String(), "BACKUP_URL is empty"); n != 1 {
		t.Errorf("idle logged %d times:\n%s", n, logs)
	}
}

// jobAgent is an agent with a job waiting at f and a volume of files.
func jobAgent(t *testing.T, f *fakeBackupApp, env map[string]string) (*Agent, *lockedBuffer, *[]time.Duration) {
	agent, logs, waits := testAgent(t, f, env)
	writeFiles(t, agent.cfg.DataDir, map[string]string{
		"files/notes.txt": strings.Repeat("notes ", 700),
		"files/docs/a.md": strings.Repeat("a", 3000),
		"files/link":      "->docs/a.md",
	})
	f.job = &Job{ID: "job-1", PartBytes: 1024}
	return agent, logs, waits
}

func runOneJob(t *testing.T, agent *Agent) {
	t.Helper()
	state := pollState{interval: defaultPoll}
	job := agent.pollOnce(context.Background(), &state)
	if job == nil {
		t.Fatal("no job")
	}
	agent.runJob(context.Background(), *job)
}

func TestJobSendsPartsInOrderAndCompletes(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, logs, waits := jobAgent(t, f, nil)
	f.faults[1] = []string{"500"}
	f.faults[2] = []string{"store-500"} // stored; the agent sends it again
	f.faults[3] = []string{"422"}
	f.faults[4] = []string{"store-409"}
	runOneJob(t, agent)

	if f.complete == nil || len(f.fails) != 0 {
		t.Fatalf("complete %+v, fails %q\n%s", f.complete, f.fails, logs)
	}
	for i, size := range f.partSize[:len(f.partSize)-1] {
		if size != 1024 {
			t.Errorf("part %d has %d bytes", i, size)
		}
	}
	if f.attempts[0] != 1 || f.attempts[1] != 2 || f.attempts[2] != 2 || f.attempts[3] != 2 || f.attempts[4] != 1 {
		t.Errorf("attempts per part %v", f.attempts)
	}
	if len(*waits) != 3 || (*waits)[0] != time.Second {
		t.Errorf("waits %v, want 1s before each of the three retries", *waits)
	}
	entries := readArchive(t, f.stream.Bytes())
	want := "manifest.json volumes/files/ volumes/files/docs/ volumes/files/docs/a.md volumes/files/link volumes/files/notes.txt"
	if got := strings.Join(names(entries), " "); got != want {
		t.Errorf("entries %s", got)
	}
	if !strings.Contains(entries[0].content, `"createdAt": "2026-11-20T02:00:00Z"`) || !strings.Contains(entries[0].content, `"included": false`) ||
		!strings.Contains(entries[0].content, `"secrets": []`) {
		t.Errorf("manifest:\n%s", entries[0].content)
	}
	if len(f.complete.Warnings) != 0 || f.complete.Warnings == nil {
		t.Errorf("warnings %#v", f.complete.Warnings)
	}
	if !strings.Contains(logs.String(), `msg="Backup sent."`) {
		t.Errorf("no success in the log:\n%s", logs)
	}
}

func TestJobGivesUpAfterTenAttemptsAndFails(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, _, waits := jobAgent(t, f, nil)
	f.faults[1] = []string{"500", "500", "500", "500", "500", "500", "500", "500", "500", "500"}
	runOneJob(t, agent)
	if f.attempts[1] != 10 || f.attempts[2] != 0 || f.complete != nil {
		t.Errorf("attempts %v, complete %+v", f.attempts, f.complete)
	}
	want := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60, 60}
	for i := range want {
		want[i] *= time.Second
	}
	if len(*waits) != len(want) {
		t.Fatalf("waits %v", *waits)
	}
	for i := range want {
		if (*waits)[i] != want[i] {
			t.Errorf("wait %d = %v, want %v", i, (*waits)[i], want[i])
		}
	}
	if len(f.fails) != 1 || !strings.Contains(f.fails[0], "part 1 failed 10 times") || strings.Contains(f.fails[0], "http") {
		t.Errorf("fails %q", f.fails)
	}
}

func TestJobOutOfOrder(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, _, _ := jobAgent(t, f, nil)
	f.faults[2] = []string{"409:0"}
	runOneJob(t, agent)
	if f.complete != nil || len(f.fails) != 1 || !strings.Contains(f.fails[0], "The Backup app expected part 0, the agent sent part 2") {
		t.Errorf("complete %+v, fails %q", f.complete, f.fails)
	}
}

func TestJobEndedOrRefusedByBackupApp(t *testing.T) {
	for _, fault := range []string{"410", "401"} {
		f := newFakeBackupApp(t)
		agent, logs, _ := jobAgent(t, f, nil)
		f.faults[1] = []string{fault}
		runOneJob(t, agent)
		if f.complete != nil || len(f.fails) != 0 || f.attempts[2] != 0 || f.attempts[1] != 1 {
			t.Errorf("%s: complete %+v, fails %q, attempts %v\n%s", fault, f.complete, f.fails, f.attempts, logs)
		}
	}
}

func TestStreamMismatchIsNotReportedAgain(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, logs, _ := jobAgent(t, f, nil)
	f.completeStatus = 422
	runOneJob(t, agent)
	if f.complete == nil || len(f.fails) != 0 || !strings.Contains(logs.String(), "stream_mismatch") {
		t.Errorf("complete %+v, fails %q\n%s", f.complete, f.fails, logs)
	}
}

func TestPartBytesOutOfRange(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, _, _ := jobAgent(t, f, nil)
	f.job.PartBytes = 1 << 30
	runOneJob(t, agent)
	if len(f.fails) != 1 || !strings.Contains(f.fails[0], "parts of 1073741824 bytes") || f.attempts[0] != 0 {
		t.Errorf("fails %q, attempts %v", f.fails, f.attempts)
	}
}

func TestStopDuringAJobReportsTheFailure(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, _, _ := jobAgent(t, f, nil)
	f.faults[0] = []string{"block"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int)
	go func() { done <- agent.Run(ctx) }()
	select {
	case <-f.partSeen:
	case <-time.After(5 * time.Second):
		t.Fatal("no part arrived")
	}
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("exit %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the agent did not stop")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.fails) != 1 || f.fails[0] != stoppedMessage || f.complete != nil {
		t.Errorf("fails %q, complete %+v", f.fails, f.complete)
	}
}

// fakePgDump writes a pg_dump stand-in: it records its arguments and
// PGPASSWORD, then runs script.
func fakePgDump(t *testing.T, script string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	record := filepath.Join(dir, "record")
	path := filepath.Join(dir, "pg_dump")
	content := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + record + "\necho \"PGPASSWORD=$PGPASSWORD\" >> " + record +
		"\necho \"DATABASE_URL=$DATABASE_URL BACKUP_TOKEN=$BACKUP_TOKEN\" >> " + record +
		"\nfor arg; do case $arg in --file=*) file=${arg#--file=};; esac; done\n" + script + "\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return path, record
}

// pg18Header is the start of a real dump of PostgreSQL 18.7 (custom format).
const pg18Header = "" +
	"50 47 44 4d 50 01 10 00 04 08 01 00 00 31 00 00" +
	"00 00 2d 00 00 00 00 07 00 00 00 00 14 00 00 00" +
	"00 0a 00 00 00 00 7e 00 00 00 00 00 00 00 00 00" +
	"08 00 00 00 70 6f 73 74 67 72 65 73 00 1d 00 00" +
	"00 31 38 2e 37 20 28 44 65 62 69 61 6e 20 31 38" +
	"2e 37 2d 31 2e 70 67 64 67 31 33 2b 32 29 00 1d" +
	"00 00 00 31 38 2e 37 20 28 44 65 62 69 61 6e 20" +
	"31 38 2e 37 2d 31 2e 70 67 64 67 31 33 2b 32 29"

func pg18HeaderBytes(t *testing.T) []byte {
	t.Helper()
	data, err := hex.DecodeString(strings.ReplaceAll(pg18Header, " ", ""))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestJobWithDatabase(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, logs, _ := jobAgent(t, f, map[string]string{"DATABASE_URL": "postgresql://app:s3cr%40t@db:5432/app?sslmode=disable"})
	fixture := filepath.Join(t.TempDir(), "fixture")
	if err := os.WriteFile(fixture, append(pg18HeaderBytes(t), []byte("rest of the dump")...), 0o600); err != nil {
		t.Fatal(err)
	}
	var record string
	agent.pgDump, record = fakePgDump(t, "cp "+fixture+" \"$file\"")
	t.Setenv("BACKUP_TOKEN", testToken)
	t.Setenv("DATABASE_URL", agent.cfg.DatabaseURL)
	runOneJob(t, agent)
	if f.complete == nil {
		t.Fatalf("no complete; fails %q\n%s", f.fails, logs)
	}
	args, _ := os.ReadFile(record)
	want := "--format=custom\n--compress=0\n--no-password\n--file="
	if !strings.HasPrefix(string(args), want) ||
		!strings.Contains(string(args), "\n--dbname=postgresql://app@db:5432/app?sslmode=disable\nPGPASSWORD=s3cr@t\nDATABASE_URL= BACKUP_TOKEN=\n") {
		t.Errorf("pg_dump got:\n%s", args)
	}
	entries := readArchive(t, f.stream.Bytes())
	if entries[1].name != "db.dump" || !strings.HasSuffix(entries[1].content, "rest of the dump") {
		t.Errorf("entries %v", names(entries))
	}
	if !strings.Contains(entries[0].content, `"serverVersion": "18.7"`) || !strings.Contains(entries[0].content, `"format": "pg_dump custom"`) {
		t.Errorf("manifest:\n%s", entries[0].content)
	}
	leftovers, _ := filepath.Glob(filepath.Join(agent.cfg.TmpDir, "*"))
	if len(leftovers) != 0 {
		t.Errorf("the dump was not deleted: %v", leftovers)
	}
}

func TestPgDumpFailureIsReportedWithoutSecrets(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, logs, _ := jobAgent(t, f, map[string]string{"DATABASE_URL": "postgres://app:hunter2-secret@db/app"})
	agent.pgDump, _ = fakePgDump(t, `echo 'pg_dump: warning: something' >&2
echo 'pg_dump: error: connection to server at "db" failed: FATAL:  password authentication failed for user "app" (postgres://app:hunter2-secret@db/app) password=hunter2-secret' >&2
exit 1`)
	runOneJob(t, agent)
	if len(f.fails) != 1 || f.attempts[0] != 0 {
		t.Fatalf("fails %q, attempts %v", f.fails, f.attempts)
	}
	message := f.fails[0]
	if !strings.HasPrefix(message, `pg_dump failed: connection to server at "db" failed: FATAL: password authentication failed for user "app"`) {
		t.Errorf("message %q", message)
	}
	for _, secret := range []string{"hunter2", "postgres://", "warning"} {
		if strings.Contains(message, secret) || (secret == "hunter2" && strings.Contains(logs.String(), secret)) {
			t.Errorf("%q in the message %q or the log", secret, message)
		}
	}
	leftovers, _ := filepath.Glob(filepath.Join(agent.cfg.TmpDir, "*"))
	if len(leftovers) != 0 {
		t.Errorf("the dump was not deleted: %v", leftovers)
	}
}

func TestDumpStopsWhenBackupAppEndsTheJob(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, _, _ := jobAgent(t, f, map[string]string{"DATABASE_URL": "postgres://app@db/app"})
	agent.pgDump, _ = fakePgDump(t, "echo partial > \"$file\"; exec sleep 30")
	agent.heartbeat = 20 * time.Millisecond
	f.progressStatus = 410
	start := time.Now()
	runOneJob(t, agent)
	if time.Since(start) > 10*time.Second {
		t.Errorf("pg_dump was not stopped")
	}
	if f.progress == 0 || len(f.fails) != 0 || f.attempts[0] != 0 {
		t.Errorf("progress %d, fails %q, attempts %v", f.progress, f.fails, f.attempts)
	}
}

func TestCheck(t *testing.T) {
	f := newFakeBackupApp(t)
	agent, _, _ := testAgent(t, f, map[string]string{"DATABASE_URL": "postgres://app:pw@db/app"})
	writeFiles(t, agent.cfg.DataDir, map[string]string{"files/a": "a"})
	fixture := filepath.Join(t.TempDir(), "fixture")
	if err := os.WriteFile(fixture, pg18HeaderBytes(t), 0o600); err != nil {
		t.Fatal(err)
	}
	agent.pgDump, _ = fakePgDump(t, `[ "$1" = --version ] && { echo "pg_dump (PostgreSQL) 18.7"; exit 0; }
cp `+fixture+` "$file"`)
	f.job = &Job{ID: "job-1", PartBytes: 1024}
	var out strings.Builder
	if code := agent.Check(context.Background(), &out); code != 0 {
		t.Errorf("exit %d:\n%s", code, out.String())
	}
	for _, want := range []string{"ok       Volumes in ", ": files\n", "ok       Volume files: 1 file, 1 byte.\n", "ok       pg_dump (PostgreSQL) 18.7\n", "ok       Database: answers (PostgreSQL 18.7).\n",
		`ok       Backup app: answers, as the source "Example"; the agent asks every 30 s.`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("no %q in:\n%s", want, out.String())
		}
	}
	if len(f.polls) != 1 || !f.polls[0].Check || f.job == nil {
		t.Errorf("the check took the job or did not say it is a check: %+v", f.polls)
	}

	agent.pgDump, _ = fakePgDump(t, `[ "$1" = --version ] && { echo "pg_dump (PostgreSQL) 18.7"; exit 0; }
echo 'pg_dump: error: connection to server at "db" failed: Connection refused' >&2; exit 1`)
	out.Reset()
	if code := agent.Check(context.Background(), &out); code != 1 || !strings.Contains(out.String(), "problem  Database: pg_dump failed: connection to server") {
		t.Errorf("exit %d:\n%s", code, out.String())
	}
}
