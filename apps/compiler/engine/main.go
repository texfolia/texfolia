package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"os"
	"os/exec"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

func writeError(w http.ResponseWriter, err error) {
	failure := &httpError{status: 500, message: "Compilation service failed"}
	if !errors.As(err, &failure) {
		log.Printf("Compilation failed: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(failure.status)
	_ = json.NewEncoder(w).Encode(struct {
		Error string `json:"error"`
		Log   string `json:"log"`
	}{failure.message, failure.log})
}

func newHandler(timeout time.Duration) http.Handler {
	mux := http.NewServeMux()
	var busy atomic.Bool
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ready"}`)
	})
	mux.HandleFunc("POST /compile", func(w http.ResponseWriter, r *http.Request) {
		if !busy.CompareAndSwap(false, true) {
			w.Header().Set("Retry-After", "1")
			writeError(w, &httpError{status: 503, message: "Compiler busy; retry shortly"})
			return
		}
		defer busy.Store(false)
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || contentType != "application/json" {
			writeError(w, &httpError{status: 415, message: "Expected application/json"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxProjectBytes)
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
		p, err := parseProject(body)
		if err != nil {
			writeError(w, err)
			return
		}
		result, err := compile(r.Context(), p, timeout)
		if err != nil {
			writeError(w, err)
			return
		}
		defer result.close()
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
		if err == nil {
			err = form.WriteField("log", result.log)
		}
		if err == nil {
			err = form.Close()
		}
		if err != nil {
			log.Printf("Sending compilation result failed: %v", err)
		}
	})
	return mux
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
	server := &http.Server{
		Addr:              net.JoinHostPort(host, port),
		Handler:           newHandler(60 * time.Second),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 75*time.Second)
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
