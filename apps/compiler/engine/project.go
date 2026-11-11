package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf16"
)

const maxProjectBytes = 10 * 1024 * 1024
const maxArtifactBytes = 32 * 1024 * 1024

type project struct {
	mainFile string
	files    map[string][]byte
	cache    map[string][]byte
}

func validPath(path string) bool {
	if path == "" || len(utf16.Encode([]rune(path))) > 240 || strings.ContainsAny(path, "\\:") {
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

func parseProject(body []byte) (project, error) {
	invalid := func() (project, error) {
		return project{}, &httpError{status: 400, message: "Invalid project sources"}
	}
	if !json.Valid(body) {
		return project{}, &httpError{status: 400, message: "Invalid JSON"}
	}
	var wire struct {
		MainFile json.RawMessage            `json:"mainFile"`
		Files    map[string]json.RawMessage `json:"files"`
		Cache    map[string]struct {
			Base64 string `json:"base64"`
		} `json:"cache"`
	}
	if err := json.Unmarshal(body, &wire); err != nil || len(wire.Files) < 1 || len(wire.Files) > 200 {
		return invalid()
	}
	p := project{mainFile: "main.tex", files: make(map[string][]byte, len(wire.Files))}
	if wire.MainFile != nil {
		if err := json.Unmarshal(wire.MainFile, &p.mainFile); err != nil || bytes.Equal(wire.MainFile, []byte("null")) {
			return invalid()
		}
	}
	if !validPath(p.mainFile) || !strings.HasSuffix(p.mainFile, ".tex") {
		return invalid()
	}
	if _, exists := wire.Files[p.mainFile]; !exists {
		return invalid()
	}
	for path, raw := range wire.Files {
		if !validPath(path) || path == "out" || strings.HasPrefix(path, "out/") {
			return invalid()
		}
		for parent := path; strings.Contains(parent, "/"); {
			parent = parent[:strings.LastIndexByte(parent, '/')]
			if _, exists := wire.Files[parent]; exists {
				return invalid()
			}
		}
		var text string
		if len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &text) == nil {
			p.files[path] = []byte(text)
			continue
		}
		var asset struct {
			Base64 *string `json:"base64"`
		}
		if json.Unmarshal(raw, &asset) != nil || asset.Base64 == nil || strings.ContainsAny(*asset.Base64, "\r\n") {
			return invalid()
		}
		content, err := base64.StdEncoding.DecodeString(*asset.Base64)
		if err != nil {
			return invalid()
		}
		p.files[path] = content
	}
	var sourceBytes int
	for _, content := range p.files {
		sourceBytes += len(content)
	}
	if sourceBytes >= maxProjectBytes {
		return project{}, &httpError{status: 413, message: "Project exceeds 10 MiB"}
	}
	p.cache = make(map[string][]byte, len(wire.Cache))
	var cacheBytes int
	for path, asset := range wire.Cache {
		if !validPath(path) {
			return invalid()
		}
		content, err := base64.StdEncoding.DecodeString(asset.Base64)
		if err != nil {
			return invalid()
		}
		cacheBytes += len(content)
		if cacheBytes > maxArtifactBytes {
			return invalid()
		}
		p.cache[path] = content
	}
	return p, nil
}

type httpError struct {
	status  int
	message string
	log     string
	logFile *logArtifact
}

func (e *httpError) Error() string { return fmt.Sprintf("%d: %s", e.status, e.message) }

type logArtifact struct {
	Path   string `json:"path"`
	Base64 string `json:"base64"`
}
