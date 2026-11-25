package main

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestLoadConfig(t *testing.T) {
	env := map[string]string{"BACKUP_URL": "https://backup.example.org/", "BACKUP_TOKEN": testToken, "DATABASE_URL": "postgres://app:pw@db/app", "LOG_LEVEL": "DEBUG"}
	cfg, err := LoadConfig(func(name string) string { return env[name] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "https://backup.example.org" || cfg.DataDir != "/data" || cfg.TmpDir != "/tmp" || cfg.LogLevel != slog.LevelDebug || cfg.Version != "development" {
		t.Errorf("cfg %+v", cfg)
	}
	idle, err := LoadConfig(func(string) string { return "" })
	if err != nil || idle.URL != "" {
		t.Errorf("empty settings: %+v, %v", idle, err)
	}
}

func TestLoadConfigRejects(t *testing.T) {
	for _, bad := range []map[string]string{
		{"BACKUP_URL": "backup.example.org", "BACKUP_TOKEN": testToken},
		{"BACKUP_URL": "ftp://backup.example.org", "BACKUP_TOKEN": testToken},
		{"BACKUP_URL": "https://user:pw@backup.example.org", "BACKUP_TOKEN": testToken},
		{"BACKUP_URL": "https://backup.example.org?a=b", "BACKUP_TOKEN": testToken},
		{"BACKUP_URL": "https://backup.example.org"},
		{"BACKUP_URL": "https://backup.example.org", "BACKUP_TOKEN": testToken + " "},
		{"BACKUP_URL": "https://backup.example.org", "BACKUP_TOKEN": "bkp_short"},
		{"BACKUP_URL": "https://backup.example.org", "BACKUP_TOKEN": "\"" + testToken + "\""},
		{"DATABASE_URL": "mysql://app:secret-password@db/app"},
		{"DATABASE_URL": "secret-password"},
		{"LOG_LEVEL": "loud"},
		{"APP_NAME": "two\nlines"},
		{"APP_SECRETS": "ENCRYPTION_KEY=secret-password"},
	} {
		_, err := LoadConfig(func(name string) string { return bad[name] })
		if err == nil {
			t.Errorf("LoadConfig(%v) should fail", bad)
			continue
		}
		if strings.Contains(err.Error(), "secret-password") || strings.Contains(err.Error(), testToken) {
			t.Errorf("the error shows a secret: %v", err)
		}
	}
}

func TestAppSecrets(t *testing.T) {
	long := "K" + strings.Repeat("_", 99)
	twenty := make([]string, 20)
	for i := range twenty {
		twenty[i] = fmt.Sprintf("KEY_%d", i)
	}
	for value, want := range map[string]string{
		"":                                   "",
		" , ,":                               "",
		"ENCRYPTION_KEY":                     "ENCRYPTION_KEY",
		" ENCRYPTION_KEY , AUTH_SECRET,, ":   "ENCRYPTION_KEY AUTH_SECRET",
		"B,A,B,_x9,A":                        "B A _x9",
		long:                                 long,
		strings.Join(twenty, ","):            strings.Join(twenty, " "),
		strings.Join(twenty, ",") + ",KEY_0": strings.Join(twenty, " "),
	} {
		got, err := parseAppSecrets(value)
		if err != nil || got == nil || strings.Join(got, " ") != want {
			t.Errorf("parseAppSecrets(%q) = %q, %v", value, got, err)
		}
	}
	for _, value := range []string{"ENCRYPTION_KEY=secret-password", "1KEY", "KEY-NAME", "KEY NAME", "secret-password", "ÄKEY", long + "X",
		strings.Join(twenty, ",") + ",KEY_20"} {
		if _, err := parseAppSecrets(value); err == nil || strings.Contains(err.Error(), "secret-password") {
			t.Errorf("parseAppSecrets(%q): %v", value, err)
		}
	}
	cfg, err := LoadConfig(func(name string) string { return map[string]string{"APP_SECRETS": "A, B"}[name] })
	if err != nil || strings.Join(cfg.AppSecrets, " ") != "A B" {
		t.Errorf("LoadConfig: %q, %v", cfg.AppSecrets, err)
	}
}

func TestSecrets(t *testing.T) {
	cfg := Config{Token: testToken, DatabaseURL: "postgres://app:p%40ss@db/app"}
	got := strings.Join(cfg.Secrets(), " ")
	if got != testToken+" postgres://app:p%40ss@db/app p%40ss p@ss" {
		t.Errorf("Secrets = %q", got)
	}
}

func TestSplitPassword(t *testing.T) {
	cases := []struct{ in, url, password string }{
		{"postgres://app:pw@db:5432/app", "postgres://app@db:5432/app", "pw"},
		{"postgresql://app:p%40ss%2Fword@db/app?sslmode=require", "postgresql://app@db/app?sslmode=require", "p@ss/word"},
		{"postgres://app@db/app", "postgres://app@db/app", ""},
		{"postgres://db/app?user=app&password=pw", "postgres://db/app?user=app", "pw"},
		// libpq takes the password parameter over the user part, and the last one.
		{"postgres://app:old@db/app?password=new", "postgres://app@db/app", "new"},
		{"postgres://app@db/app?password=old&sslmode=require&password=new", "postgres://app@db/app?sslmode=require", "new"},
		{"postgresql://app:old@db1:5433,db2/app?password=new", "postgresql://app@db1:5433,db2/app", "new"},
		{"postgres://app@/app?host=/run/postgresql", "postgres://app@/app?host=/run/postgresql", ""},
		// Several hosts (libpq), which Go's URL parser refuses: split by hand.
		{"postgresql://app:p%40ss@db1:5433,db2/app?target_session_attrs=read-write", "postgresql://app@db1:5433,db2/app?target_session_attrs=read-write", "p@ss"},
		{"postgresql://db1:5433,db2/app?password=pw&sslmode=require", "postgresql://db1:5433,db2/app?sslmode=require", "pw"},
		{"postgresql://db1,db2/app?pass%77ord=a+b%2B", "postgresql://db1,db2/app", "a+b+"},
		{"postgresql://db1:5433,db2/app?pass%77ord=a+b%2B", "postgresql://db1:5433,db2/app", "a+b+"},
	}
	for _, c := range cases {
		url, password := splitPassword(c.in)
		if url != c.url || password != c.password {
			t.Errorf("splitPassword(%q) = %q, %q", c.in, url, password)
		}
	}
	env := dumpEnvironment([]string{"PATH=/bin", "BACKUP_TOKEN=x", "DATABASE_URL=y", "PGPASSWORD=old", "PGSSLMODE=require"}, "pw")
	if strings.Join(env, " ") != "PATH=/bin PGSSLMODE=require PGPASSWORD=pw" {
		t.Errorf("dumpEnvironment = %q", env)
	}
	env = dumpEnvironment([]string{"PGPASSWORD=own"}, "")
	if strings.Join(env, " ") != "PGPASSWORD=own" {
		t.Errorf("dumpEnvironment without a password in the URL = %q", env)
	}
}

func TestFailMessageHasNoSecrets(t *testing.T) {
	secrets := Config{Token: testToken, DatabaseURL: "postgres://app:hunter2@db/app"}.Secrets()
	text := "pg_dump: error: failed for postgres://app:hunter2@db/app and postgresql://other:pw@x/y\n" +
		"password=hunter2 PASSWORD: 'two words' token=abc secret=s Authorization: Bearer abc.def " + testToken + " hunter2 bkp_zzzzzzzzzzzz"
	got := failMessage(text, secrets)
	for _, leak := range []string{"hunter2", "postgres://", "postgresql://", "two words", "abc", "bkp_", "\n"} {
		if strings.Contains(got, leak) {
			t.Errorf("%q in %q", leak, got)
		}
	}
	if !strings.HasPrefix(got, "pg_dump: error: failed for [redacted] and [url] password=[redacted]") {
		t.Errorf("failMessage = %q", got)
	}
	long := failMessage(strings.Repeat("ä", 600), nil)
	if n := len([]rune(long)); n != 500 || !strings.HasSuffix(long, "…") {
		t.Errorf("a long message has %d characters", n)
	}
	if failMessage("  \n ", nil) == "" {
		t.Error("an empty message")
	}
	if got := failMessage(`connection to server at "db" (10.0.0.2), port 5432 failed: FATAL:  password authentication failed for user "app"`, secrets); got != `connection to server at "db" (10.0.0.2), port 5432 failed: FATAL: password authentication failed for user "app"` {
		t.Errorf("an ordinary message changed: %q", got)
	}
}

func TestLoggerRedactsSecrets(t *testing.T) {
	var out bytes.Buffer
	secrets := Config{Token: testToken, DatabaseURL: "postgres://app:hunter2@db/app"}.Secrets()
	log := newLogger(&out, slog.LevelInfo, secrets)
	log.Info("Using postgres://app:hunter2@db/app", "error", errors.New("token "+testToken), "value", "hunter2")
	log.Debug("hidden")
	got := out.String()
	if strings.Contains(got, "hunter2") || strings.Contains(got, testToken) || strings.Contains(got, "hidden") {
		t.Errorf("log: %s", got)
	}
	if !strings.HasPrefix(got, "time=") || !strings.Contains(got, "level=INFO") || !strings.Contains(got, "error=\"token [redacted]\"") {
		t.Errorf("log: %s", got)
	}
}

func TestParseDumpHeader(t *testing.T) {
	version, err := parseDumpHeader(bytes.NewReader(pg18HeaderBytes(t)))
	if err != nil || version != "18.7" {
		t.Errorf("parseDumpHeader = %q, %v", version, err)
	}
	header := pg18HeaderBytes(t)
	for name, data := range map[string][]byte{
		"empty":     nil,
		"plain SQL": []byte("--\n-- PostgreSQL database dump\n"),
		"cut":       header[:60],
		"tar":       append(append([]byte{}, header[:10]...), append([]byte{3}, header[11:]...)...),
	} {
		if version, err := parseDumpHeader(bytes.NewReader(data)); err == nil {
			t.Errorf("%s: parseDumpHeader = %q", name, version)
		}
	}
}

func TestPgDumpError(t *testing.T) {
	cases := map[string]string{
		"pg_dump: error: aborting because of server version mismatch\npg_dump: detail: server version: 19.0; pg_dump version: 18.7\n": "aborting because of server version mismatch; detail: server version: 19.0; pg_dump version: 18.7",
		"pg_dump: warning: x\npg_dump: error: query failed\n":                                                                         "query failed",
		"something else\n\n": "something else",
		"":                   "",
	}
	for stderr, want := range cases {
		if got := pgDumpError(stderr); got != want {
			t.Errorf("pgDumpError(%q) = %q, want %q", stderr, got, want)
		}
	}
}
