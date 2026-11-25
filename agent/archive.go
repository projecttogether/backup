package main

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"syscall"
	"time"
)

// Manifest is the first file of the archive, manifest.json.
type Manifest struct {
	Format    int              `json:"format"`
	CreatedAt string           `json:"createdAt"`
	Agent     AgentInfo        `json:"agent"`
	App       AppInfo          `json:"app"`
	Database  ManifestDatabase `json:"database"`
	Volumes   []string         `json:"volumes"`
}

type AgentInfo struct {
	Version string `json:"version"`
}

type AppInfo struct {
	Name  string `json:"name"`
	Image string `json:"image"`
	// Secrets: APP_SECRETS, the names of the app's settings that a restore
	// needs and that are not in the backup; never values. [] when unset.
	Secrets []string `json:"secrets"`
}

// ManifestDatabase: {"included": false} without a database; with one, also
// the file, its format and the server's version ("" when unknown).
type ManifestDatabase struct {
	Included      bool    `json:"included"`
	File          string  `json:"file,omitempty"`
	Format        string  `json:"format,omitempty"`
	ServerVersion *string `json:"serverVersion,omitempty"`
}

const dumpName = "db.dump"

// archive writes the stream: manifest.json, db.dump, then the volumes.
type archive struct {
	tw  *tar.Writer
	ctx context.Context
	log *slog.Logger
	// open opens a regular file for reading without following a link;
	// readDir lists a folder. Tests replace them: root reads every file.
	open       func(name string) (*os.File, error)
	readDir    func(name string) ([]fs.DirEntry, error)
	unreadable int
	changed    int
	special    int
}

func openNoFollow(name string) (*os.File, error) {
	// O_NONBLOCK: a file that turned into a FIFO meanwhile does not block.
	return os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}

// writeArchive writes the whole archive to w. dumpPath is empty without a
// database. Files that cannot be read are skipped and become warnings. An
// error is returned when a folder cannot be read (*folderError), writing to
// w fails, or ctx ends.
func writeArchive(ctx context.Context, w io.Writer, manifest Manifest, dumpPath, dataDir string, log *slog.Logger) ([]string, error) {
	a := &archive{tw: tar.NewWriter(w), ctx: ctx, log: log, open: openNoFollow, readDir: os.ReadDir}
	return a.write(manifest, dumpPath, dataDir)
}

func (a *archive) write(manifest Manifest, dumpPath, dataDir string) ([]string, error) {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	data = append(data, '\n')
	created, _ := time.Parse(time.RFC3339, manifest.CreatedAt)
	header := &tar.Header{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(data)), ModTime: created}
	if err := a.tw.WriteHeader(header); err != nil {
		return nil, err
	}
	if _, err := a.tw.Write(data); err != nil {
		return nil, err
	}
	if dumpPath != "" {
		if err := a.addDump(dumpPath); err != nil {
			return nil, err
		}
	}
	for _, volume := range manifest.Volumes {
		if err := a.addVolume(filepath.Join(dataDir, volume), "volumes/"+volume); err != nil {
			return nil, err
		}
	}
	if err := a.tw.Close(); err != nil {
		return nil, err
	}
	var warnings []string
	if a.unreadable > 0 {
		warnings = append(warnings, plural(a.unreadable, "file could not be read", "files could not be read"))
	}
	if a.changed > 0 {
		warnings = append(warnings, plural(a.changed, "file changed while it was read", "files changed while they were read"))
	}
	if a.special > 0 {
		a.log.Debug("Skipped sockets, devices and FIFOs.", "count", a.special)
	}
	return warnings, nil
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// addDump adds the database dump as db.dump. It must be read whole: an
// error here fails the job.
func (a *archive) addDump(dumpPath string) error {
	f, err := os.Open(dumpPath)
	if err != nil {
		return fmt.Errorf("the database dump cannot be read: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("the database dump cannot be read: %w", err)
	}
	header := &tar.Header{Name: dumpName, Typeflag: tar.TypeReg, Mode: 0o600, Size: info.Size(), ModTime: info.ModTime().Truncate(time.Second)}
	if err := a.tw.WriteHeader(header); err != nil {
		return err
	}
	source := &readTracker{r: f}
	n, err := io.Copy(a.tw, source)
	if source.err != nil || (err == nil && n != info.Size()) {
		return fmt.Errorf("the database dump could not be read whole: %v", errors.Join(source.err, err))
	}
	return err
}

// addVolume adds the directory root as prefix/ and everything below it,
// depth first, each directory's entries in lexical (byte) order.
func (a *archive) addVolume(root, prefix string) error {
	info, err := os.Lstat(root)
	switch {
	case errors.Is(err, fs.ErrNotExist) || (err == nil && !info.IsDir()):
		a.skip(prefix, ".", err)
		return nil
	case err != nil:
		return a.unreadableFolder(prefix, "", nil, err)
	}
	if err := a.tw.WriteHeader(header(prefix+"/", info, tar.TypeDir, "")); err != nil {
		return err
	}
	return a.addDirectory(root, prefix, prefix, "", info)
}

// addDirectory adds what is below the directory dir (described by info). A
// directory that vanished is skipped; one that cannot be listed fails the
// job, since a backup without it would look complete.
func (a *archive) addDirectory(dir, volume, name, rel string, info fs.FileInfo) error {
	entries, err := a.readDir(dir) // sorted by name
	switch {
	case errors.Is(err, fs.ErrNotExist):
		a.skip(volume, orDefault(rel, "."), err)
		return nil
	case err != nil:
		return a.unreadableFolder(volume, rel, info, err)
	}
	dirInfo := info
	for _, entry := range entries {
		if err := a.ctx.Err(); err != nil {
			return err
		}
		full := filepath.Join(dir, entry.Name())
		childName := name + "/" + entry.Name()
		childRel := path.Join(rel, entry.Name())
		info, err := os.Lstat(full)
		if errors.Is(err, fs.ErrPermission) {
			// Lstat needs only search permission on dir: a folder that may be
			// listed but not entered fails the job like one that cannot be listed.
			return a.unreadableFolder(volume, rel, dirInfo, err)
		}
		if err != nil {
			a.skip(volume, childRel, err)
			continue
		}
		mode := info.Mode()
		switch {
		case mode.IsDir():
			if err := a.tw.WriteHeader(header(childName+"/", info, tar.TypeDir, "")); err != nil {
				return err
			}
			if err := a.addDirectory(full, volume, childName, childRel, info); err != nil {
				return err
			}
		case mode&fs.ModeSymlink != 0:
			target, err := os.Readlink(full)
			if err != nil {
				a.skip(volume, childRel, err)
				continue
			}
			if err := a.tw.WriteHeader(header(childName, info, tar.TypeSymlink, target)); err != nil {
				return err
			}
		case mode.IsRegular():
			if err := a.addFile(full, volume, childName, childRel); err != nil {
				return err
			}
		default: // sockets, devices, FIFOs
			a.special++
		}
	}
	return nil
}

// volumeSummary is what a backup would hold of one volume.
type volumeSummary struct {
	files   int   // regular files that open
	bytes   int64 // their size
	skipped int   // regular files that do not open: skipped, a warning
	folders int   // folders that cannot be listed: the backup fails
	// The first skipped file and the first folder that cannot be listed:
	// the path in the volume, the owner and the error.
	skippedPath, skippedOwner string
	skippedErr                error
	folderPath, folderOwner   string
	folderErr                 error
}

// summarize walks the volume root as addVolume does, without following
// links, and opens each regular file without reading it.
func (a *archive) summarize(root string) (volumeSummary, error) {
	var s volumeSummary
	info, err := os.Lstat(root)
	switch {
	case errors.Is(err, fs.ErrNotExist) || (err == nil && !info.IsDir()):
		return s, nil
	case err != nil:
		s.folders, s.folderPath, s.folderErr = 1, ".", err
		return s, nil
	}
	return s, a.summarizeDirectory(&s, root, "", info)
}

func (a *archive) summarizeDirectory(s *volumeSummary, dir, rel string, info fs.FileInfo) error {
	entries, err := a.readDir(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		if s.folders++; s.folders == 1 {
			s.folderPath, s.folderOwner, s.folderErr = orDefault(rel, "."), owner(info), err
		}
		return nil
	}
	dirInfo := info
	for _, entry := range entries {
		if err := a.ctx.Err(); err != nil {
			return err
		}
		full := filepath.Join(dir, entry.Name())
		childRel := path.Join(rel, entry.Name())
		info, err := os.Lstat(full)
		if errors.Is(err, fs.ErrPermission) { // dir may be listed but not entered
			if s.folders++; s.folders == 1 {
				s.folderPath, s.folderOwner, s.folderErr = orDefault(rel, "."), owner(dirInfo), err
			}
			return nil
		}
		if err == nil && info.IsDir() {
			if err := a.summarizeDirectory(s, full, childRel, info); err != nil {
				return err
			}
			continue
		}
		if err == nil && !info.Mode().IsRegular() {
			continue // links, sockets, devices, FIFOs
		}
		var f *os.File
		if err == nil {
			f, err = a.open(full)
		}
		if err != nil {
			if s.skipped++; s.skipped == 1 {
				s.skippedPath, s.skippedOwner, s.skippedErr = childRel, owner(info), err
			}
			continue
		}
		f.Close()
		s.files++
		s.bytes += info.Size()
	}
	return nil
}

// addFile adds a regular file. One that cannot be opened is skipped; one
// that shrinks or fails while it is read is filled up with zeros (the tar
// header already holds its size) and counted as changed.
func (a *archive) addFile(full, volume, name, rel string) error {
	f, err := a.open(full)
	if err != nil {
		a.skip(volume, rel, err)
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		a.skip(volume, rel, err)
		return nil
	}
	if err := a.tw.WriteHeader(header(name, info, tar.TypeReg, "")); err != nil {
		return err
	}
	source := &readTracker{r: io.LimitReader(f, info.Size())}
	n, err := io.Copy(a.tw, source)
	if err != nil && source.err == nil {
		return err // writing failed
	}
	if n < info.Size() {
		if _, err := io.CopyN(a.tw, zeros{}, info.Size()-n); err != nil {
			return err
		}
		a.change(volume, rel, source.err)
		return nil
	}
	if after, err := f.Stat(); err == nil && (after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime())) {
		a.change(volume, rel, nil)
	}
	return nil
}

func (a *archive) skip(volume, rel string, err error) {
	a.unreadable++
	a.log.Warn("Skipped a file that cannot be read.", fileAttrs(volume, rel, err)...)
}

// unreadableFolder logs the folder with its path and returns the error that
// fails the job.
func (a *archive) unreadableFolder(volume, rel string, info fs.FileInfo, err error) error {
	a.log.Error("A folder cannot be read, so the backup fails.", fileAttrs(volume, orDefault(rel, "."), err)...)
	return &folderError{volume: path.Base(volume), owner: owner(info), err: err}
}

// folderError: a folder of a volume cannot be listed. Its message is for
// the Backup app: it names the volume, never the path, because names of files and
// folders may hold personal data.
type folderError struct {
	volume string
	owner  string // "uid:gid" of the folder; "" when unknown
	err    error
}

func (e *folderError) Error() string {
	text := fmt.Sprintf("A folder in the volume %q cannot be read (%s).", e.volume, errorReason(e.err))
	if errors.Is(e.err, fs.ErrPermission) {
		text += " " + userHint(e.owner)
	}
	return text
}

// userHint tells how to let the agent read what the app's user owns.
func userHint(owner string) string {
	return fmt.Sprintf("Run the agent as the app's user: set user: of the backup-agent service, such as %q.", orDefault(owner, "1000:1000"))
}

// errorReason is the cause of a file system error without its path, such as
// "permission denied".
func errorReason(err error) string {
	var errno syscall.Errno
	var pathErr *fs.PathError
	switch {
	case errors.As(err, &errno):
		return errno.Error()
	case errors.As(err, &pathErr):
		return pathErr.Err.Error()
	}
	return "unknown error"
}

// owner is "uid:gid" of a file, or "" when unknown.
func owner(info fs.FileInfo) string {
	if info == nil {
		return ""
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", stat.Uid, stat.Gid)
	}
	return ""
}

func (a *archive) change(volume, rel string, err error) {
	a.changed++
	a.log.Warn("A file changed while it was read; the backup may hold it incomplete.", fileAttrs(volume, rel, err)...)
}

// fileAttrs name a file by its volume and its path in the volume.
func fileAttrs(volume, rel string, err error) []any {
	attrs := []any{"volume", path.Base(volume), "path", rel}
	if err != nil {
		attrs = append(attrs, "error", err)
	}
	return attrs
}

// header describes a directory, link or regular file with its mode, owner
// (numeric) and modification time (whole seconds).
func header(name string, info fs.FileInfo, typeflag byte, link string) *tar.Header {
	mode := int64(info.Mode().Perm())
	if info.Mode()&fs.ModeSetuid != 0 {
		mode |= 0o4000
	}
	if info.Mode()&fs.ModeSetgid != 0 {
		mode |= 0o2000
	}
	if info.Mode()&fs.ModeSticky != 0 {
		mode |= 0o1000
	}
	h := &tar.Header{Name: name, Typeflag: typeflag, Linkname: link, Mode: mode, ModTime: info.ModTime().Truncate(time.Second)}
	if typeflag == tar.TypeReg {
		h.Size = info.Size()
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		h.Uid, h.Gid = int(stat.Uid), int(stat.Gid)
	}
	return h
}

// readTracker remembers a read error, to tell it from a write error.
type readTracker struct {
	r   io.Reader
	err error
}

func (t *readTracker) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err != nil && err != io.EOF {
		t.err = err
	}
	return n, err
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}
