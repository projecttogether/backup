package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
)

type sentPart struct {
	n    int
	data []byte
	sha  string
}

func collectParts(t *testing.T, size int, stream []byte, chunks ...int) ([]sentPart, Totals) {
	t.Helper()
	var sent []sentPart
	w := newPartWriter(size, func(n int, data []byte, sha string) error {
		sent = append(sent, sentPart{n, bytes.Clone(data), sha})
		return nil
	})
	rest := stream
	for i := 0; len(rest) > 0; i++ {
		k := len(rest)
		if len(chunks) > 0 {
			k = min(chunks[i%len(chunks)], len(rest))
		}
		if n, err := w.Write(rest[:k]); n != k || err != nil {
			t.Fatalf("Write = %d, %v", n, err)
		}
		rest = rest[k:]
	}
	totals, err := w.Close()
	if err != nil {
		t.Fatal(err)
	}
	return sent, totals
}

func hexSHA(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestPartWriterCutsPartsOfExactlyTheSize(t *testing.T) {
	stream := make([]byte, 2500)
	for i := range stream {
		stream[i] = byte(i * 7)
	}
	sent, totals := collectParts(t, 1000, stream, 1, 333, 4096, 7)
	if len(sent) != 3 {
		t.Fatalf("%d parts, want 3", len(sent))
	}
	for i, part := range sent {
		want := stream[i*1000 : min((i+1)*1000, len(stream))]
		if part.n != i || !bytes.Equal(part.data, want) || part.sha != hexSHA(want) {
			t.Errorf("part %d: n %d, %d bytes, sha %s", i, part.n, len(part.data), part.sha)
		}
	}
	if len(sent[2].data) != 500 {
		t.Errorf("the last part has %d bytes, want 500", len(sent[2].data))
	}
	if totals.Parts != 3 || totals.Bytes != 2500 || totals.SHA256 != hexSHA(stream) || totals.Warnings == nil {
		t.Errorf("totals %+v", totals)
	}
}

func TestPartWriterSendsNoEmptyLastPart(t *testing.T) {
	stream := bytes.Repeat([]byte("x"), 2048)
	sent, totals := collectParts(t, 1024, stream)
	if len(sent) != 2 || len(sent[1].data) != 1024 || totals.Parts != 2 {
		t.Fatalf("%d parts, totals %+v", len(sent), totals)
	}
	sent, totals = collectParts(t, 1024, nil)
	if len(sent) != 0 || totals.Parts != 0 || totals.Bytes != 0 || totals.SHA256 != hexSHA(nil) {
		t.Fatalf("an empty stream: %d parts, totals %+v", len(sent), totals)
	}
}

func TestPartWriterStopsAfterAFailedPart(t *testing.T) {
	failure := errors.New("The Backup app ended the job")
	calls := 0
	w := newPartWriter(4, func(n int, data []byte, sha string) error {
		calls++
		return failure
	})
	if n, err := w.Write([]byte("abcdefgh")); n != 4 || !errors.Is(err, failure) {
		t.Errorf("Write = %d, %v", n, err)
	}
	if _, err := w.Write([]byte("ijkl")); !errors.Is(err, failure) {
		t.Errorf("a later Write = %v", err)
	}
	if _, err := w.Close(); !errors.Is(err, failure) || calls != 1 {
		t.Errorf("Close = %v after %d calls", err, calls)
	}
}
