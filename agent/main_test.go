package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestWrongSettingsLeaveTheAgentIdle(t *testing.T) {
	f := newFakeBackupApp(t)
	env := map[string]string{"BACKUP_URL": f.server.URL, "BACKUP_TOKEN": testToken, "BACKUP_DATA_DIR": t.TempDir(),
		"DATABASE_URL": "mysql://app:secret-password@db/app"}
	getenv := func(name string) string { return env[name] }
	logs := &lockedBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int)
	go func() { done <- run(ctx, nil, getenv, io.Discard, logs) }()
	select {
	case code := <-done:
		t.Fatalf("the agent exited with %d on a wrong setting:\n%s", code, logs)
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("exit %d after the stop, want 0", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the idle agent did not stop")
	}
	got := logs.String()
	if strings.Count(got, "level=ERROR") != 1 || strings.Count(got, "\n") != 1 || !strings.Contains(got, "DATABASE_URL must start with") ||
		!strings.Contains(got, "The agent is idle") || strings.Contains(got, "secret-password") {
		t.Errorf("log:\n%s", got)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.polls) != 0 {
		t.Errorf("the agent polled with a wrong setting: %d polls", len(f.polls))
	}

	// check explains the setting and exits with 1 at once.
	logs = &lockedBuffer{}
	var out strings.Builder
	if code := run(context.Background(), []string{"check"}, getenv, &out, logs); code != 1 {
		t.Errorf("check exited with %d, want 1", code)
	}
	if !strings.Contains(logs.String(), "DATABASE_URL must start with") || strings.Contains(logs.String(), "secret-password") || out.Len() != 0 {
		t.Errorf("check printed %q and logged:\n%s", out.String(), logs)
	}
}

func TestVersionAndUsage(t *testing.T) {
	var out, errOut strings.Builder
	getenv := func(string) string { return "" }
	if code := run(context.Background(), []string{"version"}, getenv, &out, &errOut); code != 0 || out.String() != version()+"\n" {
		t.Errorf("version: exit %d, %q", code, out.String())
	}
	out.Reset()
	if code := run(context.Background(), []string{"help"}, getenv, &out, &errOut); code != 0 || !strings.HasPrefix(out.String(), "Usage:") {
		t.Errorf("help: exit %d, %q", code, out.String())
	}
	if code := run(context.Background(), []string{"backup"}, getenv, &out, &errOut); code != 2 || !strings.HasPrefix(errOut.String(), "Usage:") {
		t.Errorf("an unknown command: exit %d, %q", code, errOut.String())
	}
	errOut.Reset()
	if code := run(context.Background(), []string{"dump-database", "extra"}, getenv, &out, &errOut); code != 2 || !strings.Contains(errOut.String(), "dump-database") {
		t.Errorf("dump-database with an argument: exit %d, %q", code, errOut.String())
	}
}

func TestDumpDatabaseWritesTheDumpToStdout(t *testing.T) {
	bin, record := fakePgDump(t, `printf 'PGDMP and the rest'`)
	t.Setenv("BACKUP_TOKEN", testToken)
	t.Setenv("DATABASE_URL", "postgres://other@db/other")
	// Only DATABASE_URL counts: the Backup app's settings may be empty or wrong.
	env := map[string]string{"DATABASE_URL": "postgresql://app:s3cr%40t@db:5432/app?sslmode=disable", "BACKUP_URL": "not a URL", "LOG_LEVEL": "loud"}
	var out, errOut bytes.Buffer
	if code := dumpDatabase(context.Background(), func(name string) string { return env[name] }, bin, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if out.String() != "PGDMP and the rest" || errOut.Len() != 0 {
		t.Errorf("stdout %q, stderr %q", out.String(), errOut.String())
	}
	args, _ := os.ReadFile(record)
	if string(args) != "--format=custom\n--no-password\n--dbname=postgresql://app@db:5432/app?sslmode=disable\nPGPASSWORD=s3cr@t\nDATABASE_URL= BACKUP_TOKEN=\n" {
		t.Errorf("pg_dump got:\n%s", args)
	}
}

func TestDumpDatabaseFailures(t *testing.T) {
	failing, _ := fakePgDump(t, `echo 'pg_dump: error: connection to server at "db" failed: FATAL:  password authentication failed for user "app" (postgres://app:hunter2-secret@db/app)' >&2
exit 1`)
	for _, c := range []struct {
		name, databaseURL, bin, want string
	}{
		{"no URL", "", failing, "DATABASE_URL is empty, so there is no database to dump.\n"},
		{"no PostgreSQL URL", "mysql://app:hunter2-secret@db/app", failing, "DATABASE_URL must start with postgres:// or postgresql://.\n"},
		{"pg_dump fails", "postgres://app:hunter2-secret@db/app", failing,
			`pg_dump failed: connection to server at "db" failed: FATAL: password authentication failed for user "app" ([redacted])` + "\n"},
		{"no pg_dump", "postgres://app:hunter2-secret@db/app", "/nonexistent/pg_dump", "pg_dump failed: "},
	} {
		var out, errOut bytes.Buffer
		getenv := func(name string) string { return map[string]string{"DATABASE_URL": c.databaseURL}[name] }
		if code := dumpDatabase(context.Background(), getenv, c.bin, &out, &errOut); code != 1 {
			t.Errorf("%s: exit %d, want 1", c.name, code)
		}
		if !strings.HasPrefix(errOut.String(), c.want) || strings.Count(errOut.String(), "\n") != 1 || strings.Contains(errOut.String(), "hunter2") {
			t.Errorf("%s: stderr %q, want %q", c.name, errOut.String(), c.want)
		}
	}
}

func TestDumpDatabaseStops(t *testing.T) {
	bin, _ := fakePgDump(t, "exec sleep 30")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	var errOut bytes.Buffer
	start := time.Now()
	getenv := func(name string) string { return map[string]string{"DATABASE_URL": "postgres://app@db/app"}[name] }
	if code := dumpDatabase(ctx, getenv, bin, io.Discard, &errOut); code != 1 || errOut.String() != "The dump was stopped.\n" {
		t.Errorf("exit %d, stderr %q", code, errOut.String())
	}
	if time.Since(start) > 10*time.Second {
		t.Error("pg_dump was not stopped")
	}
}

// A terminal (docker run -t, docker compose run without -T) would change
// the bytes of the dump; /dev/null and files are fine.
func TestDumpDatabaseRefusesATerminal(t *testing.T) {
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	file, err := os.Create(t.TempDir() + "/app.dump")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if isTerminal(null) || isTerminal(file) || isTerminal(&bytes.Buffer{}) {
		t.Error("/dev/null, a file or a buffer counts as a terminal")
	}
	terminal, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		t.Skipf("no pseudo-terminal here: %v", err)
	}
	defer terminal.Close()
	var errOut bytes.Buffer
	getenv := func(name string) string { return map[string]string{"DATABASE_URL": "postgres://app@db/app"}[name] }
	if code := run(context.Background(), []string{"dump-database"}, getenv, terminal, &errOut); code != 1 ||
		!strings.HasPrefix(errOut.String(), "The dump goes to stdout, which is a terminal here.") {
		t.Errorf("exit %d, stderr %q", code, errOut.String())
	}
}
