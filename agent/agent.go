package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Agent asks the Backup app for jobs and runs them, one at a time.
type Agent struct {
	cfg     Config
	client  *Client
	log     *slog.Logger
	secrets []string
	pgDump  string // the pg_dump program
	// heartbeat is the time between progress reports while pg_dump runs.
	heartbeat time.Duration
	now       func() time.Time
	// volumeProblem is the last error of listing the volumes, logged once.
	volumeProblem string
}

const (
	defaultPoll = 60 * time.Second
	minPoll     = time.Second
	maxPoll     = time.Hour
	// Parts are held in memory, one at a time.
	minPartBytes   = 1 << 10
	maxPartBytes   = 256 << 20
	stoppedMessage = "The agent was stopped"
	dumpPattern    = "backup-agent-*.dump"
)

func NewAgent(cfg Config, log *slog.Logger) *Agent {
	return &Agent{
		cfg:       cfg,
		client:    newClient(cfg, log),
		log:       log,
		secrets:   cfg.Secrets(),
		pgDump:    "pg_dump",
		heartbeat: 5 * time.Minute,
		now:       time.Now,
	}
}

// Run polls until ctx ends, and runs each job the Backup app hands out. Without
// BACKUP_URL it only waits.
func (a *Agent) Run(ctx context.Context) int {
	if a.cfg.URL == "" {
		a.log.Info("BACKUP_URL is empty: the agent is idle and backs up nothing.")
		<-ctx.Done()
		return 0
	}
	a.log.Info("Backup agent started.", "version", a.cfg.Version, "backupApp", a.cfg.URL, "app", a.cfg.AppName,
		"database", a.cfg.DatabaseURL != "", "dataDir", a.cfg.DataDir)
	if strings.HasPrefix(a.cfg.URL, "http://") {
		a.log.Warn("BACKUP_URL starts with http://: the token and the backups travel unencrypted. Use https:// outside a test.")
	}
	a.removeStaleDumps()
	state := pollState{interval: defaultPoll}
	for ctx.Err() == nil {
		if job := a.pollOnce(ctx, &state); job != nil {
			a.runJob(ctx, *job)
		}
		_ = sleepContext(ctx, jitter(state.interval))
	}
	a.log.Info("Backup agent stopped.")
	return 0
}

// pollState is what the poll loop keeps between polls.
type pollState struct {
	interval time.Duration // pollSeconds of the last answer
	source   string        // the source the Backup app answered as
	problem  string        // the last error, logged once until it changes
}

// pollOnce asks the Backup app once and returns the job it handed out, if any.
func (a *Agent) pollOnce(ctx context.Context, s *pollState) *Job {
	answer, err := a.client.Poll(ctx, a.pollRequest(false))
	if ctx.Err() != nil {
		return nil
	}
	if err != nil {
		switch {
		case err.Error() == s.problem:
			a.log.Debug("The Backup app still does not answer.", "error", err)
		case errors.Is(err, errUnauthorized):
			a.log.Error("The Backup app refused the token. The agent asks again later.", "error", err, "wait", s.interval)
		default:
			a.log.Warn("The Backup app did not answer. The agent asks again later.", "error", err, "wait", s.interval)
		}
		s.problem = err.Error()
		return nil
	}
	if s.problem != "" {
		a.log.Info("The Backup app answers again.")
		s.problem = ""
	}
	if answer.PollSeconds > 0 {
		s.interval = min(max(time.Duration(answer.PollSeconds)*time.Second, minPoll), maxPoll)
	}
	if answer.Source.ID != s.source {
		a.log.Info("Connected to the Backup app.", "source", answer.Source.Name, "poll", s.interval)
		s.source = answer.Source.ID
	}
	return answer.Job
}

func (a *Agent) pollRequest(check bool) PollRequest {
	volumes, err := listVolumes(a.cfg.DataDir)
	if err != nil && err.Error() != a.volumeProblem {
		a.log.Warn("The volumes cannot be listed.", "error", err)
	}
	a.volumeProblem = ""
	if err != nil {
		a.volumeProblem = err.Error()
	}
	return PollRequest{
		Agent:    AgentInfo{Version: a.cfg.Version},
		App:      a.appInfo(),
		Database: a.cfg.DatabaseURL != "",
		Volumes:  volumes,
		Check:    check,
	}
}

// appInfo is the app as the poll and manifest.json name it.
func (a *Agent) appInfo() AppInfo {
	secrets := a.cfg.AppSecrets
	if secrets == nil {
		secrets = []string{}
	}
	return AppInfo{Name: a.cfg.AppName, Image: a.cfg.AppImage, Secrets: secrets}
}

// jitter adds up to a tenth, so that agents started together spread out.
func jitter(d time.Duration) time.Duration {
	if d/10 <= 0 {
		return d
	}
	return d + rand.N(d/10)
}

var errStreamMismatch = errors.New("The Backup app found other totals than the agent sent (422 stream_mismatch)")

// runJob produces and sends one backup, and reports a failure to the Backup app
// unless the Backup app already knows (410, 401, a mismatch of the totals).
func (a *Agent) runJob(ctx context.Context, job Job) {
	log := a.log.With("job", job.ID)
	if job.ID == "" {
		a.log.Error("The Backup app handed out a job without an id; the agent skips it.")
		return
	}
	start := time.Now()
	log.Info("Backup started.", "partBytes", job.PartBytes)
	totals, err := a.produce(ctx, job, log)
	switch {
	case err == nil:
		log.Info("Backup sent.", "parts", totals.Parts, "bytes", totals.Bytes, "duration", time.Since(start).Round(time.Second),
			"warnings", strings.Join(totals.Warnings, "; "))
	case errors.Is(err, errJobEnded):
		log.Warn("The Backup app ended the job, so the agent stopped it.", "error", err)
	case errors.Is(err, errUnauthorized), errors.Is(err, errStreamMismatch):
		log.Error("The backup failed.", "error", err)
	case ctx.Err() != nil:
		log.Warn("The agent was stopped during the backup.")
		a.fail(job.ID, stoppedMessage, 5*time.Second, log)
	default:
		message := failMessage(err.Error(), a.secrets)
		log.Error("The backup failed.", "error", message)
		a.fail(job.ID, message, time.Minute, log)
	}
}

func (a *Agent) fail(jobID, message string, timeout time.Duration, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := a.client.Fail(ctx, jobID, message); err != nil {
		log.Warn("The Backup app could not be told that the backup failed.", "error", err)
	}
}

// produce dumps the database, streams the archive in parts, and sends the
// totals: manifest.json, db.dump, then volumes/<name>/… (README.md, "The
// stream").
func (a *Agent) produce(ctx context.Context, job Job, log *slog.Logger) (Totals, error) {
	if job.PartBytes < minPartBytes || job.PartBytes > maxPartBytes {
		return Totals{}, fmt.Errorf("The Backup app asked for parts of %d bytes; the agent sends parts of 1 KiB to 256 MiB", job.PartBytes)
	}
	volumes, err := listVolumes(a.cfg.DataDir)
	if err != nil {
		return Totals{}, err
	}
	manifest := Manifest{
		Format:    1,
		CreatedAt: a.now().UTC().Format(time.RFC3339),
		Agent:     AgentInfo{Version: a.cfg.Version},
		App:       a.appInfo(),
		Volumes:   volumes,
	}
	dumpPath := ""
	if a.cfg.DatabaseURL != "" {
		file, err := os.CreateTemp(a.cfg.TmpDir, dumpPattern)
		if err != nil {
			return Totals{}, fmt.Errorf("the dump cannot be written to BACKUP_TMP_DIR: %w", err)
		}
		dumpPath = file.Name()
		file.Close()
		defer os.Remove(dumpPath)
		started := time.Now()
		if err := a.dumpDatabase(ctx, job.ID, dumpPath); err != nil {
			return Totals{}, err
		}
		version := dumpServerVersion(dumpPath)
		log.Info("Database dumped.", "bytes", fileSize(dumpPath), "duration", time.Since(started).Round(time.Second), "serverVersion", version)
		manifest.Database = ManifestDatabase{Included: true, File: dumpName, Format: "pg_dump custom", ServerVersion: &version}
	}
	parts := newPartWriter(int(job.PartBytes), func(n int, data []byte, sha string) error {
		log.Debug("Sending a part.", "part", n, "bytes", len(data))
		return a.client.PutPart(ctx, job.ID, n, data, sha)
	})
	warnings, err := writeArchive(ctx, parts, manifest, dumpPath, a.cfg.DataDir, log)
	if err != nil {
		return Totals{}, err
	}
	totals, err := parts.Close()
	if err != nil {
		return Totals{}, err
	}
	totals.Warnings = append(totals.Warnings, warnings...)
	if err := a.client.Complete(ctx, job.ID, totals); err != nil {
		var e *apiError
		if errors.As(err, &e) && e.Status == 422 {
			return Totals{}, fmt.Errorf("%w: %v", errStreamMismatch, e)
		}
		return Totals{}, err
	}
	return totals, nil
}

// dumpDatabase runs pg_dump and tells the Backup app every heartbeat that the job
// is alive. When the Backup app answers that the job ended, pg_dump stops.
func (a *Agent) dumpDatabase(ctx context.Context, jobID, file string) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(a.heartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				err := a.client.Progress(ctx, jobID, "database", fileSize(file))
				if errors.Is(err, errJobEnded) || errors.Is(err, errUnauthorized) {
					cancel(err)
					return
				}
				if err != nil {
					a.log.Debug("The Backup app did not take the progress report.", "job", jobID, "error", err)
				}
			}
		}
	}()
	err := runPgDump(ctx, a.pgDump, a.cfg.DatabaseURL, file, false)
	close(done)
	return err
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

// removeStaleDumps deletes dumps that a stopped agent left behind.
func (a *Agent) removeStaleDumps() {
	stale, _ := filepath.Glob(filepath.Join(a.cfg.TmpDir, dumpPattern))
	for _, path := range stale {
		if os.Remove(path) == nil {
			a.log.Info("Removed a dump that an earlier run left behind.", "path", path)
		}
	}
}
