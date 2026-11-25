package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Check tests what a backup needs and prints one line per item: the
// volumes (each walked, its files opened but not read), the temporary
// folder, pg_dump, the database and the Backup app. It returns 1 when anything is
// wrong. It runs no job: it polls with "check": true, and fails a job that
// a Backup app hands out anyway.
func (a *Agent) Check(ctx context.Context, out io.Writer) int {
	problems := 0
	line := func(label, text string) {
		if label == "problem" {
			problems++
		}
		fmt.Fprintf(out, "%-8s %s\n", label, redactSecrets(text, a.secrets))
	}
	f := fmt.Sprintf
	fmt.Fprintf(out, "Backup Agent %s\n", a.cfg.Version)
	line("ok", "The settings are valid.")

	if volumes, err := listVolumes(a.cfg.DataDir); err != nil {
		line("problem", f("Volumes: %v", err))
	} else if len(volumes) == 0 {
		line("note", f("Volumes: none in %s; the backups hold no files.", a.cfg.DataDir))
	} else {
		line("ok", f("Volumes in %s: %s", a.cfg.DataDir, strings.Join(volumes, ", ")))
		for _, volume := range volumes {
			walk := &archive{ctx: ctx, open: openNoFollow, readDir: os.ReadDir}
			summary, err := walk.summarize(filepath.Join(a.cfg.DataDir, volume))
			if err != nil {
				line("problem", f("Volume %s: %v", volume, err))
				break
			}
			line(describeVolume(volume, summary))
		}
	}

	tmpOK := false
	if file, err := os.CreateTemp(a.cfg.TmpDir, "backup-check-*"); err != nil {
		line("problem", f("Temporary folder %s: not writable: %v", a.cfg.TmpDir, err))
	} else {
		file.Close()
		os.Remove(file.Name())
		tmpOK = true
		var stat syscall.Statfs_t
		if syscall.Statfs(a.cfg.TmpDir, &stat) == nil {
			free := float64(int64(stat.Bavail)*int64(stat.Bsize)) / 1e9
			line("ok", f("Temporary folder %s: writable, %.1f GB free; it needs room for one dump.", a.cfg.TmpDir, free))
		} else {
			line("ok", f("Temporary folder %s: writable.", a.cfg.TmpDir))
		}
	}

	versionCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	output, err := exec.CommandContext(versionCtx, a.pgDump, "--version").Output()
	cancel()
	pgDumpOK := err == nil
	if pgDumpOK {
		line("ok", strings.TrimSpace(string(output)))
	} else {
		line("problem", f("pg_dump does not run: %v", err))
	}

	switch {
	case a.cfg.DatabaseURL == "":
		line("note", "Database: none, DATABASE_URL is empty; the backups hold no database.")
	case !tmpOK || !pgDumpOK:
		line("problem", "Database: not checked, pg_dump or the temporary folder does not work.")
	default:
		line(a.checkDatabase(ctx))
	}

	if a.cfg.URL == "" {
		line("note", "Backup app: BACKUP_URL is empty; the agent stays idle.")
	} else {
		line(a.checkBackupApp(ctx))
	}
	if problems > 0 {
		return 1
	}
	return 0
}

// describeVolume is the line of check for one volume: a problem when a
// folder cannot be read, a warning when files cannot be read.
func describeVolume(volume string, s volumeSummary) (string, string) {
	held := fmt.Sprintf("Volume %s: %s, %s.", volume, plural(s.files, "file", "files"), formatBytes(s.bytes))
	which := func(n int, one, many, path string, err error) string {
		if n == 1 {
			return fmt.Sprintf("%s: %q (%s).", one, path, errorReason(err))
		}
		return fmt.Sprintf("%d %s, such as %q (%s).", n, many, path, errorReason(err))
	}
	hint := func(owner string, err error) string {
		if errors.Is(err, fs.ErrPermission) {
			return " " + userHint(owner)
		}
		return ""
	}
	switch {
	case s.folders > 0:
		text := fmt.Sprintf("Volume %s: backups fail. ", volume) +
			which(s.folders, "A folder cannot be read", "folders cannot be read", s.folderPath, s.folderErr)
		if s.skipped > 0 {
			text += " They would also skip " +
				which(s.skipped, "a file that cannot be read", "files that cannot be read", s.skippedPath, s.skippedErr)
		}
		return "problem", text + hint(s.folderOwner, s.folderErr)
	case s.skipped > 0:
		return "warning", held + " Backups skip " +
			which(s.skipped, "a file that cannot be read", "files that cannot be read", s.skippedPath, s.skippedErr) + hint(s.skippedOwner, s.skippedErr)
	}
	return "ok", held
}

// formatBytes is a size in decimal units, such as "12.4 MB".
func formatBytes(n int64) string {
	for _, unit := range []struct {
		size float64
		name string
	}{{1e12, "TB"}, {1e9, "GB"}, {1e6, "MB"}, {1e3, "kB"}} {
		if float64(n) >= unit.size {
			return fmt.Sprintf("%.1f %s", float64(n)/unit.size, unit.name)
		}
	}
	return plural(int(n), "byte", "bytes")
}

// checkDatabase dumps only the schema, into the temporary folder.
func (a *Agent) checkDatabase(ctx context.Context) (string, string) {
	file, err := os.CreateTemp(a.cfg.TmpDir, "backup-check-*.dump")
	if err != nil {
		return "problem", fmt.Sprintf("Database: %v", err)
	}
	file.Close()
	defer os.Remove(file.Name())
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := runPgDump(ctx, a.pgDump, a.cfg.DatabaseURL, file.Name(), true); err != nil {
		return "problem", "Database: " + failMessage(err.Error(), a.secrets)
	}
	if version := dumpServerVersion(file.Name()); version != "" {
		return "ok", fmt.Sprintf("Database: answers (PostgreSQL %s).", version)
	}
	return "ok", "Database: answers."
}

// checkBackupApp polls once.
func (a *Agent) checkBackupApp(ctx context.Context) (string, string) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	answer, err := a.client.Poll(ctx, a.pollRequest(true))
	if err != nil {
		return "problem", fmt.Sprintf("Backup app at %s: %v", a.cfg.URL, err)
	}
	text := fmt.Sprintf("Backup app: answers, as the source %q; the agent asks every %d s.", answer.Source.Name, answer.PollSeconds)
	if answer.Job != nil {
		// A Backup app that does not know "check" handed out a job; the next
		// planned run backs up.
		_ = a.client.Fail(ctx, answer.Job.ID, "The check command of the agent took this job; it runs no backups.")
		text += " It handed out a job, which the check reported as failed."
	}
	return "ok", text
}
