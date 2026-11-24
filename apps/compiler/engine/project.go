package main

import (
	"fmt"
	"strings"
)

const maxProjectBytes = 10 * 1024 * 1024
const maxArtifactBytes = 32 * 1024 * 1024
const maxSourceFiles = 200

// A project is a set of source paths, each hard-linked from a file on disk.
type project struct {
	mainFile string
	files    map[string]string
	cache    map[string][]byte
}

func validPath(path string) bool {
	if path == "" || len(path) > 255 || strings.ContainsAny(path, "\\:") {
		return false
	}
	for _, char := range path {
		if char < 32 {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func sourcePath(path string) bool {
	return len(path) <= 240 && validPath(path) && !strings.EqualFold(strings.Split(path, "/")[0], "out")
}

type httpError struct {
	status  int
	message string
	code    string
	missing []string
	log     string
	logFile *logArtifact
}

func (e *httpError) Error() string { return fmt.Sprintf("%d: %s", e.status, e.message) }

type logArtifact struct {
	path    string
	content []byte
}
