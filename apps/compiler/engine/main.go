package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

const (
	// The caller streams sources and the cache archive from its own storage.
	receiveTimeout    = 60 * time.Second
	maxCompileTimeout = 300 * time.Second
	previewTimeout    = 15 * time.Second
	// The Worker gives up first, after 120 seconds.
	responseTimeout = 150 * time.Second
	maxRequestTime  = receiveTimeout + maxCompileTimeout + previewTimeout + responseTimeout
)

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
	if err := runLimited(limitedCommand(context.Background(), "tectonic", "--version")); err != nil {
		log.Fatalf("Tectonic is unavailable: %v", err)
	}
	packages, err := newPackageCache(tectonicCache())
	if err != nil {
		log.Fatalf("Tectonic's cache is unreadable: %v", err)
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	slots := 1
	if value := os.Getenv("COMPILE_SLOTS"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 16 {
			log.Fatalf("COMPILE_SLOTS must be between 1 and 16, not %q", value)
		}
		slots = parsed
	}
	handler := newHandler(maxCompileTimeout, slots, packages)
	defer handler.Close()
	server := &http.Server{
		Addr:              net.JoinHostPort(host, port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		// A compile replaces both of these with the limits of its own phases.
		ReadTimeout:    receiveTimeout,
		WriteTimeout:   30 * time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 16 * 1024,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), maxRequestTime)
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
