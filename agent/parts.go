package main

import (
	"crypto/sha256"
	"encoding/hex"
	"hash"
)

// Totals describe the whole stream for POST /jobs/{id}/complete.
type Totals struct {
	Parts    int      `json:"parts"`
	Bytes    int64    `json:"bytes"`
	SHA256   string   `json:"sha256"`
	Warnings []string `json:"warnings"`
}

// partWriter cuts the stream into parts of exactly size bytes (the last may
// be smaller) and hands each to send, in order and one at a time, with the
// hex SHA-256 of the part. send must not keep data: the buffer is reused.
// After an error of send, every Write returns that error.
type partWriter struct {
	size  int
	buf   []byte
	next  int
	bytes int64
	whole hash.Hash
	send  func(n int, data []byte, sha string) error
	err   error
}

func newPartWriter(size int, send func(n int, data []byte, sha string) error) *partWriter {
	return &partWriter{size: size, buf: make([]byte, 0, size), whole: sha256.New(), send: send}
}

func (w *partWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		if w.err != nil {
			return written, w.err
		}
		k := min(w.size-len(w.buf), len(p))
		w.buf = append(w.buf, p[:k]...)
		w.whole.Write(p[:k])
		w.bytes += int64(k)
		written += k
		p = p[k:]
		if len(w.buf) == w.size {
			w.flush()
		}
	}
	return written, w.err
}

func (w *partWriter) flush() {
	sum := sha256.Sum256(w.buf)
	w.err = w.send(w.next, w.buf, hex.EncodeToString(sum[:]))
	w.next++
	w.buf = w.buf[:0]
}

// Close sends the last part, if bytes are left, and returns the totals.
func (w *partWriter) Close() (Totals, error) {
	if w.err == nil && len(w.buf) > 0 {
		w.flush()
	}
	if w.err != nil {
		return Totals{}, w.err
	}
	return Totals{Parts: w.next, Bytes: w.bytes, SHA256: hex.EncodeToString(w.whole.Sum(nil)), Warnings: []string{}}, nil
}
