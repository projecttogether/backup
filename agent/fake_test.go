package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testToken = "bkp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"

// fakeBackupApp is the Backup app as far as the agent protocol goes. faults
// change the answers to a part, once each, in order.
type fakeBackupApp struct {
	t      *testing.T
	server *httptest.Server
	mu     sync.Mutex

	job         *Job // handed out by the next poll that is no check
	pollSeconds int
	polls       []PollRequest

	faults   map[int][]string
	attempts map[int]int
	expected int
	lastSHA  string
	stream   bytes.Buffer
	partSize []int

	completeStatus int
	complete       *Totals
	fails          []string
	progress       int
	progressStatus int

	// partSeen is closed when the first part arrives (fault "block").
	partSeen chan struct{}
}

func newFakeBackupApp(t *testing.T) *fakeBackupApp {
	f := &fakeBackupApp{t: t, pollSeconds: 30, faults: map[int][]string{}, attempts: map[int]int{},
		completeStatus: http.StatusAccepted, progressStatus: http.StatusNoContent, partSeen: make(chan struct{})}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeBackupApp) fail(w http.ResponseWriter, status int, code string, extra map[string]any) {
	body := map[string]any{"code": code, "message": "fake: " + code}
	for k, v := range extra {
		body[k] = v
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": body})
}

func (f *fakeBackupApp) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		f.fail(w, http.StatusUnauthorized, "unauthorized", nil)
		return
	}
	if !strings.HasPrefix(r.Header.Get("User-Agent"), "backup-agent/") {
		f.t.Errorf("User-Agent %q", r.Header.Get("User-Agent"))
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/agent/v1")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case r.Method == http.MethodPost && path == "/poll":
		f.poll(w, r)
	case r.Method == http.MethodPut && len(parts) == 4 && parts[0] == "jobs" && parts[2] == "parts":
		n, _ := strconv.Atoi(parts[3])
		f.part(w, r, parts[1], n)
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "jobs":
		f.mu.Lock()
		defer f.mu.Unlock()
		f.jobCall(w, r, parts[2])
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeBackupApp) poll(w http.ResponseWriter, r *http.Request) {
	var request PollRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		f.t.Errorf("poll body: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.polls = append(f.polls, request)
	answer := map[string]any{"source": map[string]string{"id": "source-1", "name": "Example"}, "pollSeconds": f.pollSeconds, "job": nil}
	if f.job != nil && !request.Check {
		answer["job"] = f.job
		f.job = nil
	}
	json.NewEncoder(w).Encode(answer)
}

func (f *fakeBackupApp) part(w http.ResponseWriter, r *http.Request, jobID string, n int) {
	f.mu.Lock()
	f.attempts[n]++
	fault := ""
	if queue := f.faults[n]; len(queue) > 0 {
		fault, f.faults[n] = queue[0], queue[1:]
	}
	f.mu.Unlock()
	if fault == "block" {
		// Read the body first: only then does the server notice that the
		// agent gave up the request.
		io.ReadAll(r.Body)
		close(f.partSeen)
		<-r.Context().Done()
		return
	}
	if r.Header.Get("Content-Type") != "application/octet-stream" || r.ContentLength <= 0 {
		f.t.Errorf("part %d: Content-Type %q, Content-Length %d", n, r.Header.Get("Content-Type"), r.ContentLength)
	}
	data, _ := io.ReadAll(r.Body)
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	f.mu.Lock()
	defer f.mu.Unlock()
	switch fault {
	case "500":
		w.WriteHeader(http.StatusInternalServerError)
		return
	case "422":
		f.fail(w, http.StatusUnprocessableEntity, "checksum_mismatch", nil)
		return
	case "410":
		f.fail(w, http.StatusGone, "job_ended", nil)
		return
	case "401":
		f.fail(w, http.StatusUnauthorized, "unauthorized", nil)
		return
	}
	if strings.HasPrefix(fault, "409:") {
		expected, _ := strconv.Atoi(strings.TrimPrefix(fault, "409:"))
		f.fail(w, http.StatusConflict, "out_of_order", map[string]any{"expected": expected})
		return
	}
	if r.Header.Get("X-Part-Sha256") != sha {
		f.fail(w, http.StatusUnprocessableEntity, "checksum_mismatch", nil)
		return
	}
	switch {
	case n == f.expected-1 && sha == f.lastSHA:
		w.WriteHeader(http.StatusNoContent) // the same part again
		return
	case n != f.expected:
		f.fail(w, http.StatusConflict, "out_of_order", map[string]any{"expected": f.expected})
		return
	}
	f.stream.Write(data)
	f.partSize = append(f.partSize, len(data))
	f.expected++
	f.lastSHA = sha
	switch fault {
	case "store-500": // stored, but the answer is lost
		w.WriteHeader(http.StatusBadGateway)
	case "store-409":
		f.fail(w, http.StatusConflict, "out_of_order", map[string]any{"expected": f.expected})
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (f *fakeBackupApp) jobCall(w http.ResponseWriter, r *http.Request, call string) {
	switch call {
	case "complete":
		var totals Totals
		json.NewDecoder(r.Body).Decode(&totals)
		f.complete = &totals
		sum := sha256.Sum256(f.stream.Bytes())
		if f.completeStatus == http.StatusAccepted && (totals.Parts != f.expected || totals.Bytes != int64(f.stream.Len()) || totals.SHA256 != hex.EncodeToString(sum[:])) {
			f.t.Errorf("totals %+v do not match the stream: %d parts, %d bytes", totals, f.expected, f.stream.Len())
			f.fail(w, http.StatusUnprocessableEntity, "stream_mismatch", nil)
			return
		}
		if f.completeStatus != http.StatusAccepted {
			f.fail(w, f.completeStatus, "stream_mismatch", nil)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	case "fail":
		var body struct{ Message string }
		json.NewDecoder(r.Body).Decode(&body)
		f.fails = append(f.fails, body.Message)
		w.WriteHeader(http.StatusNoContent)
	case "progress":
		f.progress++
		if f.progressStatus == http.StatusGone {
			f.fail(w, http.StatusGone, "job_ended", nil)
			return
		}
		w.WriteHeader(f.progressStatus)
	default:
		http.NotFound(w, r)
	}
}

// lockedBuffer collects logs from several goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// testAgent is an agent against f (nil: idle) whose waits between attempts
// return at once and are recorded.
func testAgent(t *testing.T, f *fakeBackupApp, env map[string]string) (*Agent, *lockedBuffer, *[]time.Duration) {
	t.Helper()
	settings := map[string]string{"BACKUP_DATA_DIR": t.TempDir(), "BACKUP_TMP_DIR": t.TempDir(), "APP_NAME": "example",
		"APP_IMAGE": "ghcr.io/example/app:1.2.3", "APP_VERSION": "0.1.0"}
	if f != nil {
		settings["BACKUP_URL"] = f.server.URL
		settings["BACKUP_TOKEN"] = testToken
	}
	for k, v := range env {
		settings[k] = v
	}
	cfg, err := LoadConfig(func(name string) string { return settings[name] })
	if err != nil {
		t.Fatal(err)
	}
	logs := &lockedBuffer{}
	agent := NewAgent(cfg, newLogger(logs, slog.LevelDebug, cfg.Secrets()))
	var mu sync.Mutex
	waits := &[]time.Duration{}
	agent.client.sleep = func(ctx context.Context, d time.Duration) error {
		mu.Lock()
		defer mu.Unlock()
		*waits = append(*waits, d)
		return ctx.Err()
	}
	agent.now = func() time.Time { return time.Date(2026, 11, 20, 2, 0, 0, 0, time.UTC) }
	return agent, logs, waits
}

// writeFiles creates files below dir: "name" → content; a content of
// "->target" makes a symbolic link, a name ending in / a directory.
func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		full := filepath.Join(dir, name)
		if strings.HasSuffix(name, "/") {
			if err := os.MkdirAll(full, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		var err error
		if target, ok := strings.CutPrefix(content, "->"); ok {
			err = os.Symlink(target, full)
		} else {
			err = os.WriteFile(full, []byte(content), 0o644)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}
