package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

type entry struct {
	name, link, content string
	typeflag            byte
	mode                int64
}

func readArchive(t *testing.T, data []byte) []entry {
	t.Helper()
	var entries []entry
	r := tar.NewReader(bytes.NewReader(data))
	for {
		h, err := r.Next()
		if err == io.EOF {
			return entries
		}
		if err != nil {
			t.Fatalf("not a tar archive: %v", err)
		}
		content, _ := io.ReadAll(r)
		entries = append(entries, entry{name: h.Name, link: h.Linkname, content: string(content), typeflag: h.Typeflag, mode: h.Mode})
	}
}

func names(entries []entry) []string {
	var list []string
	for _, e := range entries {
		list = append(list, e.name)
	}
	return list
}

func testVolumes(t *testing.T) string {
	t.Helper()
	data := t.TempDir()
	writeFiles(t, filepath.Join(data, "files"), map[string]string{
		"b.txt":         "b",
		"a.txt":         "a",
		"a/z.txt":       "z",
		"a/y/":          "",
		"docs/one.md":   "one",
		"latest":        "->docs/one.md",
		"outside":       "->/etc",
		"dangling":      "->nowhere",
		"secret.txt":    "secret",
		"empty/":        "",
		"Upper.txt":     "upper",
		"with space.md": "space",
	})
	writeFiles(t, filepath.Join(data, "uploads"), map[string]string{"x.bin": "x"})
	if err := os.Chmod(filepath.Join(data, "files", "a.txt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(data, "files", "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(data, "files", "sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	// A file directly in the data folder is no volume.
	writeFiles(t, data, map[string]string{"stray.txt": "stray"})
	return data
}

func TestArchiveLayout(t *testing.T) {
	data := testVolumes(t)
	dump := filepath.Join(t.TempDir(), "dump")
	if err := os.WriteFile(dump, []byte("PGDMP fake dump"), 0o600); err != nil {
		t.Fatal(err)
	}
	volumes, err := listVolumes(data)
	if err != nil || strings.Join(volumes, ",") != "files,uploads" {
		t.Fatalf("listVolumes = %v, %v", volumes, err)
	}
	version := "18.1"
	manifest := Manifest{Format: 1, CreatedAt: "2026-11-20T02:00:00Z", Agent: AgentInfo{"0.1.0"},
		App:      AppInfo{Name: "example", Image: "ghcr.io/example/app:1.2.3", Secrets: []string{"ENCRYPTION_KEY"}},
		Database: ManifestDatabase{Included: true, File: dumpName, Format: "pg_dump custom", ServerVersion: &version},
		Volumes:  volumes}

	var out bytes.Buffer
	logs := &lockedBuffer{}
	a := &archive{tw: tar.NewWriter(&out), ctx: context.Background(), log: newLogger(logs, slog.LevelDebug, nil), readDir: os.ReadDir}
	a.open = func(name string) (*os.File, error) {
		if filepath.Base(name) == "secret.txt" {
			return nil, os.ErrPermission
		}
		return openNoFollow(name)
	}
	warnings, err := a.write(manifest, dump, data)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(warnings, ";") != "1 file could not be read" {
		t.Errorf("warnings %q", warnings)
	}
	if !strings.Contains(logs.String(), "path=secret.txt") || !strings.Contains(logs.String(), "volume=files") {
		t.Errorf("the skipped file was not logged with its path in the volume:\n%s", logs)
	}

	entries := readArchive(t, out.Bytes())
	want := []string{
		"manifest.json", "db.dump",
		"volumes/files/", "volumes/files/Upper.txt", "volumes/files/a/", "volumes/files/a/y/", "volumes/files/a/z.txt",
		"volumes/files/a.txt", "volumes/files/b.txt", "volumes/files/dangling", "volumes/files/docs/",
		"volumes/files/docs/one.md", "volumes/files/empty/", "volumes/files/latest", "volumes/files/outside",
		"volumes/files/with space.md",
		"volumes/uploads/", "volumes/uploads/x.bin",
	}
	if got := names(entries); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("entries:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	byName := map[string]entry{}
	for _, e := range entries {
		byName[e.name] = e
	}
	var got Manifest
	if err := json.Unmarshal([]byte(entries[0].content), &got); err != nil {
		t.Fatalf("manifest.json: %v", err)
	}
	if got.Format != 1 || got.App.Name != "example" || strings.Join(got.App.Secrets, ",") != "ENCRYPTION_KEY" || !got.Database.Included || *got.Database.ServerVersion != "18.1" || len(got.Volumes) != 2 {
		t.Errorf("manifest %+v", got)
	}
	if e := byName["db.dump"]; e.content != "PGDMP fake dump" || e.mode != 0o600 {
		t.Errorf("db.dump %+v", e)
	}
	for name, target := range map[string]string{"latest": "docs/one.md", "outside": "/etc", "dangling": "nowhere"} {
		if e := byName["volumes/files/"+name]; e.typeflag != tar.TypeSymlink || e.link != target || e.content != "" {
			t.Errorf("%s is not stored as a link to %s: %+v", name, target, e)
		}
	}
	if e := byName["volumes/files/a.txt"]; e.content != "a" || e.mode != 0o600 || e.typeflag != tar.TypeReg {
		t.Errorf("a.txt %+v", e)
	}
	if e := byName["volumes/files/a/"]; e.typeflag != tar.TypeDir || e.mode != 0o755 {
		t.Errorf("a/ %+v", e)
	}
}

func TestArchiveWithoutDatabaseOrVolumes(t *testing.T) {
	var out bytes.Buffer
	manifest := Manifest{Format: 1, CreatedAt: "2026-11-20T02:00:00Z", Volumes: []string{}}
	warnings, err := writeArchive(context.Background(), &out, manifest, "", filepath.Join(t.TempDir(), "missing"), slog.New(slog.DiscardHandler))
	if err != nil || len(warnings) != 0 {
		t.Fatalf("writeArchive = %v, %v", warnings, err)
	}
	entries := readArchive(t, out.Bytes())
	if len(entries) != 1 || entries[0].name != "manifest.json" {
		t.Fatalf("entries %v", names(entries))
	}
	if !strings.Contains(entries[0].content, `"database": {
    "included": false
  }`) {
		t.Errorf("manifest without a database:\n%s", entries[0].content)
	}
	if volumes, err := listVolumes(filepath.Join(t.TempDir(), "missing")); err != nil || volumes == nil || len(volumes) != 0 {
		t.Errorf("a missing data folder: %v, %v", volumes, err)
	}
}

func TestArchiveStopsWhenWritingFails(t *testing.T) {
	data := testVolumes(t)
	failure := errors.New("the job ended")
	w := newPartWriter(1024, func(int, []byte, string) error { return failure })
	manifest := Manifest{Format: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339), Volumes: []string{"files", "uploads"}}
	if _, err := writeArchive(context.Background(), w, manifest, "", data, slog.New(slog.DiscardHandler)); !errors.Is(err, failure) {
		t.Fatalf("writeArchive = %v, want the error of the writer", err)
	}
}

// denyFolders makes readDir fail for the folders named in denied (by their
// base name) with err, as for a folder of another user with mode 0700.
func denyFolders(err syscall.Errno, denied ...string) func(string) ([]fs.DirEntry, error) {
	return func(name string) ([]fs.DirEntry, error) {
		if slices.Contains(denied, filepath.Base(name)) {
			return nil, &fs.PathError{Op: "open", Path: name, Err: err}
		}
		return os.ReadDir(name)
	}
}

func TestArchiveFailsOnAFolderItCannotRead(t *testing.T) {
	data := t.TempDir()
	writeFiles(t, filepath.Join(data, "files"), map[string]string{"a.txt": "a"})
	writeFiles(t, filepath.Join(data, "private_data"), map[string]string{"jane-doe/receipt.pdf": "receipt", "public.txt": "public"})
	owner := fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())
	manifest := Manifest{Format: 1, CreatedAt: "2026-11-20T02:00:00Z", Volumes: []string{"files", "private_data"}}
	cases := []struct{ denied, path, want string }{
		{"jane-doe", "jane-doe", `A folder in the volume "private_data" cannot be read (permission denied). Run the agent as the app's user: set user: of the backup-agent service, such as "` + owner + `".`},
		{"private_data", ".", `A folder in the volume "private_data" cannot be read (permission denied). Run the agent as the app's user: set user: of the backup-agent service, such as "` + owner + `".`},
	}
	for _, c := range cases {
		var out bytes.Buffer
		logs := &lockedBuffer{}
		a := &archive{tw: tar.NewWriter(&out), ctx: context.Background(), log: newLogger(logs, slog.LevelDebug, nil),
			open: openNoFollow, readDir: denyFolders(syscall.EACCES, c.denied)}
		_, err := a.write(manifest, "", data)
		var folder *folderError
		if !errors.As(err, &folder) || err.Error() != c.want {
			t.Errorf("%s: write = %v\nwant %s", c.denied, err, c.want)
			continue
		}
		if got := failMessage(err.Error(), nil); got != c.want {
			t.Errorf("%s: the message for the Backup app changed: %q", c.denied, got)
		}
		if !strings.Contains(logs.String(), "level=ERROR") || !strings.Contains(logs.String(), "volume=private_data path="+c.path+" ") {
			t.Errorf("%s: the folder was not logged with its path:\n%s", c.denied, logs)
		}
	}

	// Another error than a permission: no hint about the user.
	a := &archive{tw: tar.NewWriter(io.Discard), ctx: context.Background(), log: slog.New(slog.DiscardHandler),
		open: openNoFollow, readDir: denyFolders(syscall.EIO, "jane-doe")}
	if _, err := a.write(manifest, "", data); err == nil || err.Error() != `A folder in the volume "private_data" cannot be read (input/output error).` {
		t.Errorf("EIO: write = %v", err)
	}
}

func TestArchiveSkipsAFolderThatVanished(t *testing.T) {
	data := t.TempDir()
	writeFiles(t, filepath.Join(data, "files"), map[string]string{"gone/a.txt": "a", "b.txt": "b"})
	var out bytes.Buffer
	a := &archive{tw: tar.NewWriter(&out), ctx: context.Background(), log: slog.New(slog.DiscardHandler),
		open: openNoFollow, readDir: denyFolders(syscall.ENOENT, "gone")}
	warnings, err := a.write(Manifest{Format: 1, CreatedAt: "2026-11-20T02:00:00Z", Volumes: []string{"files"}}, "", data)
	if err != nil || strings.Join(warnings, ";") != "1 file could not be read" {
		t.Fatalf("write = %q, %v", warnings, err)
	}
	if got := strings.Join(names(readArchive(t, out.Bytes())), " "); got != "manifest.json volumes/files/ volumes/files/b.txt volumes/files/gone/" {
		t.Errorf("entries %s", got)
	}
}

func TestCheckSummarizesAVolume(t *testing.T) {
	root := filepath.Join(t.TempDir(), "private_data")
	writeFiles(t, root, map[string]string{"a.txt": "aaa", "docs/b.md": strings.Repeat("b", 2000), "latest": "->docs/b.md",
		"outside": "->/etc", "secret.txt": "s", "jane-doe/receipt.pdf": "r", "john-doe/receipt.pdf": "r", "empty/": ""})
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	owner := fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())
	hint := ` Run the agent as the app's user: set user: of the backup-agent service, such as "` + owner + `".`
	denyFiles := func(denied ...string) func(string) (*os.File, error) {
		return func(name string) (*os.File, error) {
			if slices.Contains(denied, filepath.Base(name)) {
				return nil, &fs.PathError{Op: "open", Path: name, Err: syscall.EACCES}
			}
			return openNoFollow(name)
		}
	}
	cases := []struct {
		open        func(string) (*os.File, error)
		readDir     func(string) ([]fs.DirEntry, error)
		label, text string
	}{
		{openNoFollow, os.ReadDir, "ok", "Volume private_data: 5 files, 2.0 kB."},
		{denyFiles("secret.txt"), os.ReadDir, "warning",
			`Volume private_data: 4 files, 2.0 kB. Backups skip a file that cannot be read: "secret.txt" (permission denied).` + hint},
		{denyFiles("secret.txt", "b.md"), os.ReadDir, "warning",
			`Volume private_data: 3 files, 5 bytes. Backups skip 2 files that cannot be read, such as "docs/b.md" (permission denied).` + hint},
		{denyFiles("secret.txt"), denyFolders(syscall.EACCES, "jane-doe"), "problem",
			`Volume private_data: backups fail. A folder cannot be read: "jane-doe" (permission denied). They would also skip a file that cannot be read: "secret.txt" (permission denied).` + hint},
		{openNoFollow, denyFolders(syscall.EACCES, "jane-doe", "john-doe"), "problem",
			`Volume private_data: backups fail. 2 folders cannot be read, such as "jane-doe" (permission denied).` + hint},
		{openNoFollow, denyFolders(syscall.EACCES, "private_data"), "problem",
			`Volume private_data: backups fail. A folder cannot be read: "." (permission denied).` + hint},
		{openNoFollow, denyFolders(syscall.ENOENT, "jane-doe"), "ok", "Volume private_data: 4 files, 2.0 kB."},
	}
	for i, c := range cases {
		walk := &archive{ctx: context.Background(), open: c.open, readDir: c.readDir}
		summary, err := walk.summarize(root)
		if err != nil {
			t.Fatal(err)
		}
		if label, text := describeVolume("private_data", summary); label != c.label || text != c.text {
			t.Errorf("case %d: %s %s\nwant %s %s", i, label, text, c.label, c.text)
		}
	}
	if summary, err := (&archive{ctx: context.Background()}).summarize(filepath.Join(root, "missing")); err != nil || summary != (volumeSummary{}) {
		t.Errorf("a missing volume: %+v, %v", summary, err)
	}
	if got := formatBytes(12_400_000); got != "12.4 MB" {
		t.Errorf("formatBytes = %q", got)
	}
}
