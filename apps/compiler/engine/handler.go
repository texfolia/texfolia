package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var processStarted = time.Now()

type engineHandler struct {
	http.Handler
	slots []*slot
}

func (handler *engineHandler) Close() error {
	var failure error
	for _, s := range handler.slots {
		if err := s.close(); err != nil && failure == nil {
			failure = err
		}
	}
	return failure
}

// cancellations remembers a cancel that overtakes its compile request.
type cancellations struct {
	mu  sync.Mutex
	ids map[string]bool
}

func (c *cancellations) add(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.ids) >= 1024 {
		clear(c.ids)
	}
	c.ids[id] = true
}

func (c *cancellations) take(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	cancelled := c.ids[id]
	delete(c.ids, id)
	return cancelled
}

type compileHeaders struct {
	id         string
	affinity   string
	slot       int
	generation int64
	timeout    time.Duration
}

func parseCompileHeaders(headers http.Header, slots int, maximum time.Duration) (*compileHeaders, error) {
	invalid := &httpError{status: 400, message: "Invalid compile headers"}
	parsed := &compileHeaders{id: headers.Get("X-Compile-Id"), affinity: headers.Get("X-Compile-Affinity")}
	if parsed.id == "" || len(parsed.id) > 64 || parsed.affinity == "" || len(parsed.affinity) > 128 {
		return nil, invalid
	}
	index, err := strconv.Atoi(headers.Get("X-Compile-Slot"))
	if err != nil || index < 0 || index >= slots {
		return nil, invalid
	}
	generation, err := strconv.ParseInt(headers.Get("X-Compile-Generation"), 10, 64)
	if err != nil || generation <= 0 {
		return nil, invalid
	}
	timeout, err := strconv.ParseInt(headers.Get("X-Compile-Timeout-Ms"), 10, 64)
	if err != nil || timeout <= 0 || timeout > maximum.Milliseconds() {
		return nil, &httpError{status: 400, message: "Invalid compile timeout"}
	}
	parsed.slot, parsed.generation, parsed.timeout = index, generation, time.Duration(timeout)*time.Millisecond
	return parsed, nil
}

func imageSize() *int64 {
	data, err := os.ReadFile("/etc/texfolia-image-size")
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return nil
	}
	size, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || size < 0 {
		return nil
	}
	return &size
}

func newHandler(maximum time.Duration, slotCount int) *engineHandler {
	slots := make([]*slot, slotCount)
	for index := range slots {
		slots[index] = &slot{blobs: map[string]blob{}}
	}
	cancelled := &cancellations{ids: map[string]bool{}}
	identity := make([]byte, 16)
	if _, err := rand.Read(identity); err != nil {
		panic(err)
	}
	bootID := fmt.Sprintf("%x", identity)
	bootMs := elapsedMs(processStarted)
	size := imageSize()
	var warmed atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(struct {
			Status string `json:"status"`
			BootID string `json:"bootId"`
		}{"ready", bootID})
	})
	mux.HandleFunc("DELETE /compilations/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		cancelled.add(id)
		for _, s := range slots {
			if run := s.running(id); run != nil {
				run.cancel()
				select {
				case <-run.done:
				case <-r.Context().Done():
					return
				}
				cancelled.take(id)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /compile", func(w http.ResponseWriter, r *http.Request) {
		headers, err := parseCompileHeaders(r.Header, slotCount, maximum)
		if err != nil {
			writeFailure(w, err)
			return
		}
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || contentType != "application/x-tar" {
			writeFailure(w, &httpError{status: 415, message: "Expected application/x-tar"})
			return
		}
		s := slots[headers.slot]
		run, ctx, err := s.begin(r.Context(), headers.generation, headers.id)
		if err != nil {
			writeFailure(w, err)
			return
		}
		defer s.end(run)
		if cancelled.take(headers.id) {
			writeFailure(w, &httpError{status: 409, message: "Compilation cancelled", code: "cancelled"})
			return
		}
		timing := engineTiming{Engine: "tectonic", Temperature: "cold", ContainerBootID: bootID, BootMs: bootMs, ImageSizeBytes: size}
		if warmed.Swap(true) {
			timing.Temperature = "warm"
		}
		defer func() {
			slog.New(slog.NewJSONHandler(os.Stdout, nil)).Info("compile_engine",
				"event", "compile_engine", "telemetryVersion", 2, "compileId", headers.id, "timing", timing)
		}()
		result, preview, err := s.run(ctx, w, r, headers, &timing)
		setTiming(w, &timing)
		if err != nil {
			if ctx.Err() != nil {
				err = &httpError{status: 409, message: "Compilation cancelled", code: "cancelled"}
			}
			writeFailure(w, err)
			return
		}
		defer result.close()
		s.writeResult(w, result, preview)
	})
	return &engineHandler{Handler: mux, slots: slots}
}

func (s *slot) run(ctx context.Context, w http.ResponseWriter, r *http.Request, headers *compileHeaders, timing *engineTiming) (*result, []byte, error) {
	started := time.Now()
	if err := s.assign(headers.affinity); err != nil {
		return nil, nil, err
	}
	// Unblock a half-received body when the run is cancelled or preempted.
	control := http.NewResponseController(w)
	stopReading := context.AfterFunc(ctx, func() { _ = control.SetReadDeadline(time.Now()) })
	sources, err := s.receive(http.MaxBytesReader(w, r.Body, maxRequestBytes), timing)
	if !stopReading() {
		// The interrupted read ended this connection's context for good.
		w.Header().Set("Connection", "close")
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		return nil, nil, err
	}
	p := project{mainFile: sources.MainFile, files: make(map[string]string, len(sources.Files)), cache: s.cache}
	for path, hash := range sources.Files {
		p.files[path] = s.blobs[hash].path
	}
	timing.CacheUsed = len(p.cache) > 0
	result, err := compile(ctx, p, headers.timeout, timing, s.dir)
	if timing.InputPrepMs != nil && timing.CompileMs != nil {
		// Input preparation starts with the request body, not with the first link.
		prepared := float64(time.Since(started))/float64(time.Millisecond) - *timing.CompileMs
		if timing.OutputMs != nil {
			prepared -= *timing.OutputMs
		}
		timing.InputPrepMs = &prepared
	}
	if err != nil {
		return nil, nil, err
	}
	if !sources.Preview {
		return result, nil, nil
	}
	preview, err := renderPreview(ctx, result.pdf.Name())
	if err != nil {
		result.close()
		return nil, nil, err
	}
	return result, preview, nil
}
