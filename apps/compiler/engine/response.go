package main

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
)

// The result.json entry. files names artifacts/0, artifacts/1, ... in order.
type resultEntry struct {
	Error string   `json:"error,omitempty"`
	Log   string   `json:"log"`
	PDF   string   `json:"pdf,omitempty"`
	Files []string `json:"files"`
}

// Entry names stay short and ASCII, so every reader can use plain ustar.
type responseArchive struct {
	http http.ResponseWriter
	tar  *tar.Writer
	err  error
}

func newResponseArchive(w http.ResponseWriter, status int) *responseArchive {
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	return &responseArchive{http: w, tar: tar.NewWriter(w)}
}

func (a *responseArchive) copy(name string, size int64, content io.Reader) {
	if a.err != nil {
		return
	}
	a.err = a.tar.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: size, Typeflag: tar.TypeReg, Format: tar.FormatUSTAR})
	if a.err == nil {
		_, a.err = io.Copy(a.tar, content)
	}
}

func (a *responseArchive) write(name string, content []byte) {
	if a.err != nil {
		return
	}
	a.err = a.tar.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(content)), Typeflag: tar.TypeReg, Format: tar.FormatUSTAR})
	if a.err == nil {
		_, a.err = a.tar.Write(content)
	}
}

func (a *responseArchive) result(entry resultEntry) {
	encoded, err := json.Marshal(entry)
	if err != nil && a.err == nil {
		a.err = err
	}
	a.write("result.json", encoded)
}

func (a *responseArchive) flush() {
	if a.err == nil {
		a.err = a.tar.Flush()
	}
	if flusher, ok := a.http.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (a *responseArchive) close() {
	if a.err == nil {
		a.err = a.tar.Close()
	}
	if a.err != nil {
		log.Printf("Sending compilation result failed: %v", a.err)
	}
}

func setTiming(w http.ResponseWriter, timing *engineTiming) {
	if encoded, err := json.Marshal(timing); err == nil {
		w.Header().Set("X-Compile-Timing", string(encoded))
	}
}

// writeFailure answers with a result archive when the compile itself failed,
// and with a JSON error when the request could not run.
func writeFailure(w http.ResponseWriter, err error) {
	failure := &httpError{status: 500, message: "Compilation service failed", code: "internal"}
	if !errors.As(err, &failure) {
		log.Printf("Compilation failed: %v", err)
	}
	switch failure.status {
	case http.StatusRequestTimeout, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		archive := newResponseArchive(w, failure.status)
		entry := resultEntry{Error: failure.message, Log: failure.log, Files: []string{}}
		if failure.logFile != nil {
			entry.Files = []string{failure.logFile.path}
		}
		archive.result(entry)
		if failure.logFile != nil {
			archive.write("artifacts/0", failure.logFile.content)
		}
		archive.close()
		return
	}
	code := failure.code
	if code == "" {
		code = "invalid"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if failure.status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "1")
	}
	w.WriteHeader(failure.status)
	_ = json.NewEncoder(w).Encode(struct {
		Error   string   `json:"error"`
		Code    string   `json:"code"`
		Missing []string `json:"missing,omitempty"`
	}{failure.message, code, failure.missing})
}

// writeResult sends the PDF first and flushes it, so a viewer can render while
// the remaining files are still being read and compressed.
func (s *slot) writeResult(w http.ResponseWriter, result *result, preview []byte) {
	stat, err := result.pdf.Stat()
	if err != nil {
		writeFailure(w, err)
		return
	}
	archive := newResponseArchive(w, http.StatusOK)
	archive.copy("output.pdf", stat.Size(), result.pdf)
	archive.flush()
	name := filepath.Base(result.pdf.Name())
	files, err := resultArtifacts(result)
	if err != nil {
		// The response has started; a truncated archive marks it as failed.
		log.Printf("Reading compilation output failed: %v", err)
		panic(http.ErrAbortHandler)
	}
	s.cache, s.cacheReady = resultCache(files), true
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	archive.result(resultEntry{Log: result.log, PDF: name, Files: paths})
	archive.flush()
	if preview != nil {
		archive.write("preview.png", preview)
	}
	for index, path := range paths {
		archive.write("artifacts/"+strconv.Itoa(index), files[path])
	}
	archive.flush()
	if cache, err := packCache(s.cache); err == nil {
		archive.write("cache.tar.zst", cache)
	} else {
		log.Printf("Packing the build cache failed: %v", fmt.Errorf("cache: %w", err))
	}
	archive.close()
}
