package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type engineRun struct {
	id     string
	cancel context.CancelFunc
	done   chan struct{}
}

type blob struct {
	path     string
	size     int64
	modified time.Time
}

// A slot runs one compile at a time and keeps that caller's sources and cache
// for its next compile. A different affinity wipes the slot before TeX starts.
type slot struct {
	mu         sync.Mutex
	generation int64
	active     *engineRun

	// Only the active run touches these fields.
	affinity   string
	dir        string
	blobs      map[string]blob
	cache      map[string][]byte
	cacheReady bool
}

var errLeaseEnded = &httpError{status: 409, message: "Container lease has ended", code: "lease"}

// begin claims the slot for one run. A newer lease stops whatever an older one
// left running, and an older lease can never start again.
func (s *slot) begin(ctx context.Context, generation int64, id string) (*engineRun, context.Context, error) {
	for {
		s.mu.Lock()
		if generation < s.generation {
			s.mu.Unlock()
			return nil, nil, errLeaseEnded
		}
		running := s.active
		if running == nil {
			s.generation = generation
			ctx, cancel := context.WithCancel(ctx)
			run := &engineRun{id: id, cancel: cancel, done: make(chan struct{})}
			s.active = run
			s.mu.Unlock()
			return run, ctx, nil
		}
		if generation == s.generation {
			s.mu.Unlock()
			return nil, nil, &httpError{status: 503, message: "Compiler busy; retry shortly", code: "busy"}
		}
		s.generation = generation
		running.cancel()
		s.mu.Unlock()
		select {
		case <-running.done:
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		}
	}
}

func (s *slot) end(run *engineRun) {
	run.cancel()
	s.mu.Lock()
	s.active = nil
	s.mu.Unlock()
	close(run.done)
}

func (s *slot) running(id string) *engineRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != nil && s.active.id == id {
		return s.active
	}
	return nil
}

// assign prepares the slot for one affinity. Nothing of the previous owner may
// survive, so a failed wipe fails the compile and leaves the slot unassigned.
func (s *slot) assign(affinity string) error {
	if s.dir != "" && s.affinity == affinity {
		return nil
	}
	if err := s.wipe(); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "texfolia-slot-")
	if err != nil {
		return err
	}
	s.dir, s.affinity = dir, affinity
	return nil
}

func (s *slot) wipe() error {
	s.affinity, s.blobs, s.cache, s.cacheReady = "", map[string]blob{}, nil, false
	if s.dir != "" {
		if err := os.RemoveAll(s.dir); err != nil {
			return err
		}
		s.dir = ""
	}
	return nil
}

func (s *slot) storeBlob(hash string, content io.Reader) (err error) {
	path := filepath.Join(s.dir, hash)
	if existing, exists := s.blobs[hash]; exists && existing.unchanged() {
		return nil
	}
	_ = os.Remove(path)
	delete(s.blobs, hash)
	// TeX must not be able to change a retained source through its hard link.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0400)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.Remove(path)
		}
	}()
	digest := sha256.New()
	_, err = io.Copy(io.MultiWriter(file, digest), content)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if hex.EncodeToString(digest.Sum(nil)) != hash {
		return &httpError{status: 400, message: "Source hash mismatch"}
	}
	stat, err := os.Stat(path)
	if err != nil {
		return err
	}
	s.blobs[hash] = blob{path: path, size: stat.Size(), modified: stat.ModTime()}
	return nil
}

func (b blob) unchanged() bool {
	stat, err := os.Stat(b.path)
	return err == nil && stat.Mode().IsRegular() && stat.Size() == b.size && stat.ModTime().Equal(b.modified)
}

func (s *slot) dropChangedBlobs() {
	for hash, entry := range s.blobs {
		if !entry.unchanged() {
			_ = os.Remove(entry.path)
			delete(s.blobs, hash)
		}
	}
}

func (s *slot) keepBlobs(expected map[string]bool) {
	for hash, entry := range s.blobs {
		if !expected[hash] {
			_ = os.Remove(entry.path)
			delete(s.blobs, hash)
		}
	}
}

func (s *slot) close() error {
	s.mu.Lock()
	run := s.active
	s.mu.Unlock()
	if run != nil {
		run.cancel()
		<-run.done
	}
	return s.wipe()
}
