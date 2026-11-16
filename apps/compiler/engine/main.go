package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var processStarted = time.Now()

func writeError(w http.ResponseWriter, err error) {
	failure := &httpError{status: 500, message: "Compilation service failed"}
	if !errors.As(err, &failure) {
		log.Printf("Compilation failed: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(failure.status)
	_ = json.NewEncoder(w).Encode(struct {
		Error   string       `json:"error"`
		Log     string       `json:"log"`
		LogFile *logArtifact `json:"logFile,omitempty"`
	}{failure.message, failure.log, failure.logFile})
}

type engineRun struct {
	id     string
	cancel context.CancelFunc
	done   chan struct{}
}

type engineHandler struct {
	http.Handler
	sources *workingCopy
	scratch *string
}

func (handler *engineHandler) Close() error {
	if *handler.scratch != "" {
		return os.RemoveAll(*handler.scratch)
	}
	if handler.sources.project.sourceDir == "" {
		return nil
	}
	return os.RemoveAll(handler.sources.project.sourceDir)
}

func requestCompileTimeout(headers http.Header, maximum time.Duration) (time.Duration, error) {
	planTimeout := 15 * time.Second
	if plan := headers.Get("X-Compile-Plan"); plan == "pro" || plan == "team" {
		planTimeout = 300 * time.Second
	}
	if value := headers.Get("X-Compile-Timeout-Ms"); value != "" {
		ms, err := strconv.ParseInt(value, 10, 64)
		if err != nil || ms <= 0 || ms > planTimeout.Milliseconds() {
			return 0, &httpError{status: 400, message: "Invalid compile timeout"}
		}
		planTimeout = time.Duration(ms) * time.Millisecond
	}
	return min(planTimeout, maximum), nil
}

func newHandler(timeout time.Duration) *engineHandler {
	mux := http.NewServeMux()
	var mu sync.Mutex
	var active *engineRun
	var owner string
	var lease string
	var generation int64
	var releasing bool
	var scratch string
	validLease := func(r *http.Request) bool {
		token := r.Header.Get("X-Container-Lease")
		return !releasing && ((lease != "" && token == lease) || (generation == 0 && token == ""))
	}
	var cache map[string][]byte
	var cacheReady bool
	bootID := fmt.Sprintf("%x", makeBootID())
	bootMs := elapsedMs(processStarted)
	var imageSize *int64
	if data, err := os.ReadFile("/etc/texfolia-image-size"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			if size, err := strconv.ParseInt(fields[0], 10, 64); err == nil && size >= 0 {
				imageSize = &size
			}
		}
	}
	var sources workingCopy
	cancelled := make(map[string]bool)
	mux.HandleFunc("DELETE /compilations/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		mu.Lock()
		if !validLease(r) {
			mu.Unlock()
			writeError(w, &httpError{status: 409, message: "Container lease has ended"})
			return
		}
		// Remember an early cancellation that overtakes the POST on another connection.
		if len(cancelled) >= 1024 {
			clear(cancelled)
		}
		cancelled[id] = true
		run := active
		if run != nil && run.id == id {
			run.cancel()
		}
		mu.Unlock()
		if run != nil && run.id == id {
			<-run.done
		}
		w.WriteHeader(http.StatusNoContent)
	})
	var warmed atomic.Bool
	mux.HandleFunc("PUT /lease", func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Container-Lease")
		next, err := leaseGeneration(token)
		projectID := r.Header.Get("X-Project-Id")
		if err != nil || projectID == "" {
			writeError(w, &httpError{status: 400, message: "Invalid container lease"})
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if !releasing && lease == token && owner == projectID {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if releasing || lease != "" || active != nil || owner != "" || sources.project.sourceDir != "" || next <= generation {
			writeError(w, &httpError{status: 409, message: "Container unavailable for lease"})
			return
		}
		directory, err := os.MkdirTemp("", "texfolia-lease-")
		if err != nil {
			writeError(w, err)
			return
		}
		generation, lease, owner, scratch = next, token, projectID, directory
		sources.tempDir = directory
		clear(cancelled)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("DELETE /lease", func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Container-Lease")
		next, err := leaseGeneration(token)
		if err != nil {
			writeError(w, &httpError{status: 400, message: "Invalid container lease"})
			return
		}
		mu.Lock()
		if lease == "" && owner == "" && active == nil {
			// Fence a delayed PUT even when release overtakes acquisition.
			generation = max(generation, next)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if lease != token {
			mu.Unlock()
			writeError(w, &httpError{status: 409, message: "Container belongs to another lease"})
			return
		}
		releasing = true
		run := active
		if run != nil {
			run.cancel()
		}
		mu.Unlock()
		if run != nil {
			<-run.done
		}
		mu.Lock()
		defer mu.Unlock()
		// A concurrent duplicate release may have already completed the handoff.
		if lease != token {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if scratch != "" {
			if err := os.RemoveAll(scratch); err != nil {
				writeError(w, err)
				return
			}
		}
		sources = workingCopy{}
		scratch = ""
		cache, cacheReady, owner, lease, releasing = nil, false, "", "", false
		clear(cancelled)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Status         string   `json:"status"`
			BootID         string   `json:"bootId"`
			CacheReady     bool     `json:"cacheReady"`
			BootMs         *float64 `json:"bootMs"`
			ImageSizeBytes *int64   `json:"imageSizeBytes"`
		}{"ready", bootID, cacheReady, bootMs, imageSize})
	})
	mux.HandleFunc("PUT /cache", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		projectID := r.Header.Get("X-Project-Id")
		if !validLease(r) || projectID == "" || (owner != "" && owner != projectID) {
			writeError(w, &httpError{status: 409, message: "Engine belongs to another project"})
			return
		}
		if active != nil {
			writeError(w, &httpError{status: 503, message: "Compiler busy; retry shortly"})
			return
		}
		owner = projectID
		if cacheReady {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		unpackStarted := time.Now()
		if r.Header.Get("X-Cache-Missing") != "1" {
			var err error
			cache, err = unpackCache(http.MaxBytesReader(w, r.Body, maxCacheArchiveBytes))
			if err != nil {
				writeError(w, &httpError{status: 422, message: "Invalid cache archive"})
				return
			}
		}
		cacheReady = true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			UnpackMs *float64 `json:"archiveUnpackMs"`
		}{elapsedMs(unpackStarted)})
	})
	mux.HandleFunc("POST /compile", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		projectID := r.Header.Get("X-Project-Id")
		if !validLease(r) || (owner != "" && owner != projectID) {
			mu.Unlock()
			writeError(w, &httpError{status: 409, message: "Engine belongs to another project"})
			return
		}
		if projectID != "" {
			owner = projectID
		}
		id := r.Header.Get("X-Compilation-Id")
		if cancelled[id] {
			delete(cancelled, id)
			mu.Unlock()
			writeError(w, &httpError{status: 409, message: "Compilation cancelled"})
			return
		}
		if active != nil {
			mu.Unlock()
			w.Header().Set("Retry-After", "1")
			writeError(w, &httpError{status: 503, message: "Compiler busy; retry shortly"})
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		run := &engineRun{id: id, cancel: cancel, done: make(chan struct{})}
		active = run
		mu.Unlock()
		defer func() {
			cancel()
			mu.Lock()
			active = nil
			delete(cancelled, id)
			close(run.done)
			mu.Unlock()
		}()
		timing := engineTiming{Engine: "tectonic", Temperature: "unknown", BootMs: bootMs, ImageSizeBytes: imageSize}
		jobID := r.Header.Get("X-Compilation-Id")
		jobID = jobID[:min(len(jobID), 64)]
		defer func() {
			slog.New(slog.NewJSONHandler(os.Stdout, nil)).Info("compile_engine",
				"event", "compile_engine", "telemetryVersion", 1, "jobId", jobID,
				"attempt", r.Header.Get("X-Compile-Attempt"), "plan", r.Header.Get("X-Compile-Plan"), "timing", timing)
		}()
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || contentType != "application/json" {
			writeError(w, &httpError{status: 415, message: "Expected application/json"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64*1024*1024)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, &httpError{status: 413, message: "Project exceeds 10 MiB"})
			} else {
				writeError(w, &httpError{status: 400, message: "Invalid JSON"})
			}
			return
		}
		var envelope struct {
			BaseRevision *int64 `json:"baseRevision"`
			Preview      bool   `json:"preview"`
		}
		_ = json.Unmarshal(body, &envelope)
		var p project
		if envelope.BaseRevision != nil {
			p, err = sources.apply(body)
			if err == nil {
				w.Header().Set("X-Source-Revision", strconv.FormatInt(sources.revision, 10))
			}
			var failure *httpError
			if errors.As(err, &failure) && failure.status == 409 {
				w.Header().Set("X-Source-Resync", "1")
			}
		} else {
			p, err = parseProject(body)
		}
		if err != nil {
			writeError(w, err)
			return
		}
		if r.Header.Get("X-Clean-Compile") == "1" {
			p.cache = nil
		} else if projectID != "" && len(p.cache) == 0 {
			p.cache = cache
		}
		timing.CacheUsed = len(p.cache) > 0
		timing.Temperature = "cold"
		if warmed.Swap(true) {
			timing.Temperature = "warm"
		}
		compileTimeout, err := requestCompileTimeout(r.Header, timeout)
		if err != nil {
			writeError(w, err)
			return
		}
		result, err := compile(ctx, p, compileTimeout, &timing, scratch)
		if err != nil {
			if encoded, encodeErr := json.Marshal(timing); encodeErr == nil {
				w.Header().Set("X-Compile-Timing", string(encoded))
			}
			writeError(w, err)
			return
		}
		defer result.close()
		var preview []byte
		if envelope.Preview {
			preview, err = renderPreview(ctx, result.pdf.Name())
			if err != nil {
				writeError(w, err)
				return
			}
		}
		nextCache, err := resultCache(result)
		if err != nil {
			writeError(w, err)
			return
		}
		archive, err := packCache(nextCache)
		if err != nil {
			writeError(w, err)
			return
		}
		if projectID != "" {
			mu.Lock()
			cache, cacheReady = nextCache, true
			mu.Unlock()
		}
		if encoded, encodeErr := json.Marshal(timing); encodeErr == nil {
			w.Header().Set("X-Compile-Timing", string(encoded))
		}
		form := multipart.NewWriter(w)
		w.Header().Set("Content-Type", form.FormDataContentType())
		w.Header().Set("Cache-Control", "no-store")
		part, err := form.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="pdf"; filename="output.pdf"`},
			"Content-Type":        {"application/pdf"},
		})
		if err == nil {
			_, err = io.Copy(part, result.pdf)
		}
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		if err == nil {
			err = form.WriteField("log", result.log)
		}
		if err == nil {
			part, err = form.CreateFormFile("cache", "cache.tar.zst")
			if err == nil {
				_, err = io.Copy(part, bytes.NewReader(archive))
			}
		}
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		if err == nil && preview != nil {
			part, err = form.CreatePart(textproto.MIMEHeader{
				"Content-Disposition": {`form-data; name="preview"; filename="preview.png"`},
				"Content-Type":        {"image/png"},
			})
			if err == nil {
				_, err = part.Write(preview)
			}
		}
		for _, path := range result.artifacts {
			if err != nil {
				break
			}
			if path == filepath.Base(result.pdf.Name()) {
				continue
			}
			var part io.Writer
			part, err = form.CreatePart(textproto.MIMEHeader{
				"Content-Disposition": {fmt.Sprintf(`form-data; name="%s"; filename="%s"`, strings.ReplaceAll("artifact:"+path, `"`, `\"`), strings.ReplaceAll(filepath.Base(path), `"`, `\"`))},
				"Content-Type":        {"application/octet-stream"},
			})
			if err != nil {
				break
			}
			var file *os.File
			file, err = os.Open(filepath.Join(result.root, "source", "out", filepath.FromSlash(path)))
			if err == nil {
				_, err = io.Copy(part, file)
				_ = file.Close()
			}
		}
		if err == nil {
			err = form.Close()
		}
		if err != nil {
			log.Printf("Sending compilation result failed: %v", err)
		}
	})
	return &engineHandler{Handler: mux, sources: &sources, scratch: &scratch}
}

func leaseGeneration(token string) (int64, error) {
	parts := strings.SplitN(token, ":", 2)
	if len(parts) != 2 || parts[1] == "" || len(token) > 128 {
		return 0, errors.New("invalid lease token")
	}
	generation, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || generation <= 0 {
		return 0, errors.New("invalid lease generation")
	}
	return generation, nil
}

func makeBootID() []byte {
	identity := make([]byte, 16)
	if _, err := rand.Read(identity); err != nil {
		panic(err)
	}
	return identity
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := http.Client{Timeout: 4 * time.Second}
		response, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/health")
		if err != nil {
			os.Exit(1)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	if err := exec.Command("tectonic", "--version").Run(); err != nil {
		log.Fatalf("Tectonic is unavailable: %v", err)
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	handler := newHandler(300 * time.Second)
	defer handler.Close()
	server := &http.Server{
		Addr:              net.JoinHostPort(host, port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      390 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 390*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("Engine shutdown failed: %v", err)
		}
	}()
	log.Printf("LaTeX engine listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	if ctx.Err() != nil {
		<-shutdownDone
	}
}
