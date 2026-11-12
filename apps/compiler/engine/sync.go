package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type sourceFile struct {
	Hash    string          `json:"hash"`
	Content json.RawMessage `json:"content,omitempty"`
}

type sourceDelta struct {
	MainFile     string                `json:"mainFile"`
	BaseRevision int64                 `json:"baseRevision"`
	Revision     int64                 `json:"revision"`
	Files        map[string]sourceFile `json:"files"`
	Deleted      []string              `json:"deleted"`
	Resync       bool                  `json:"resync"`
	Cache        map[string]struct {
		Base64 string `json:"base64"`
	} `json:"cache"`
}

type workingCopy struct {
	revision int64
	project  project
	hashes   map[string]string
}

func hashSource(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func sourcePath(path string) bool {
	return validPath(path) && path != "out" && !strings.HasPrefix(path, "out/")
}

func decodeContent(raw json.RawMessage) ([]byte, error) {
	var text string
	if len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &text) == nil {
		return []byte(text), nil
	}
	var binary struct {
		Base64 *string `json:"base64"`
	}
	if json.Unmarshal(raw, &binary) != nil || binary.Base64 == nil || strings.ContainsAny(*binary.Base64, "\r\n") {
		return nil, &httpError{status: 400, message: "Invalid source content"}
	}
	content, err := base64.StdEncoding.DecodeString(*binary.Base64)
	if err != nil {
		return nil, &httpError{status: 400, message: "Invalid source content"}
	}
	return content, nil
}

func (working *workingCopy) apply(body []byte) (project, error) {
	var delta sourceDelta
	invalid := &httpError{status: 400, message: "Invalid source delta"}
	mismatch := &httpError{status: 409, message: "Source resync required"}
	if json.Unmarshal(body, &delta) != nil || delta.BaseRevision < 0 || delta.Revision < delta.BaseRevision || delta.Revision > 9007199254740991 || !sourcePath(delta.MainFile) || !strings.HasSuffix(delta.MainFile, ".tex") || len(delta.Files) > 200 || len(delta.Deleted) > 200 {
		return project{}, invalid
	}
	if delta.Revision == delta.BaseRevision && (delta.Resync || len(delta.Files) != 0 || len(delta.Deleted) != 0 || delta.MainFile != working.project.mainFile) {
		return project{}, invalid
	}
	if !delta.Resync {
		if working.project.sourceDir == "" || working.revision != delta.BaseRevision {
			return project{}, mismatch
		}
		for path, hash := range working.hashes {
			content, err := os.ReadFile(filepath.Join(working.project.sourceDir, path))
			if err != nil || hashSource(content) != hash {
				return project{}, mismatch
			}
		}
	}
	files := make(map[string][]byte)
	hashes := make(map[string]string)
	blobs := make(map[string][]byte)
	if !delta.Resync {
		for path, content := range working.project.files {
			files[path] = content
			hashes[path] = working.hashes[path]
			blobs[working.hashes[path]] = content
		}
	}
	deleted := make(map[string]bool)
	for _, path := range delta.Deleted {
		if !sourcePath(path) || deleted[path] {
			return project{}, invalid
		}
		if _, exists := delta.Files[path]; exists {
			return project{}, invalid
		}
		deleted[path] = true
		delete(files, path)
		delete(hashes, path)
	}
	for path, file := range delta.Files {
		decodedHash, err := hex.DecodeString(file.Hash)
		if !sourcePath(path) || err != nil || len(decodedHash) != 32 || strings.ToLower(file.Hash) != file.Hash {
			return project{}, invalid
		}
		if len(file.Content) > 0 && !bytes.Equal(file.Content, []byte("null")) {
			content, err := decodeContent(file.Content)
			if err != nil {
				return project{}, err
			}
			if hashSource(content) != file.Hash {
				return project{}, mismatch
			}
			blobs[file.Hash] = content
		}
	}
	for path, file := range delta.Files {
		content, exists := blobs[file.Hash]
		if !exists {
			return project{}, mismatch
		}
		files[path] = content
		hashes[path] = file.Hash
	}
	if len(files) < 1 || len(files) > 200 {
		return project{}, invalid
	}
	if _, exists := files[delta.MainFile]; !exists {
		return project{}, invalid
	}
	var size int
	for path, content := range files {
		size += len(content)
		for parent := path; strings.Contains(parent, "/"); {
			parent = parent[:strings.LastIndexByte(parent, '/')]
			if _, exists := files[parent]; exists {
				return project{}, invalid
			}
		}
	}
	if size >= maxProjectBytes {
		return project{}, &httpError{status: 413, message: "Project exceeds 10 MiB"}
	}
	cache := make(map[string][]byte)
	var cacheBytes int
	for path, file := range delta.Cache {
		content, err := base64.StdEncoding.DecodeString(file.Base64)
		if !validPath(path) || err != nil {
			return project{}, invalid
		}
		cacheBytes += len(content)
		if cacheBytes > maxArtifactBytes {
			return project{}, invalid
		}
		cache[path] = content
	}
	directory, err := os.MkdirTemp("", "texfolia-sources-")
	if err != nil {
		return project{}, err
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(directory)
		}
	}()
	locations := make(map[string]string)
	if !delta.Resync {
		for path, hash := range working.hashes {
			locations[hash] = filepath.Join(working.project.sourceDir, path)
		}
	}
	for path, content := range files {
		target := filepath.Join(directory, path)
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return project{}, err
		}
		if previous := locations[hashes[path]]; previous != "" {
			err = os.Link(previous, target)
		} else {
			err = os.WriteFile(target, content, 0400)
		}
		if err != nil {
			return project{}, err
		}
		locations[hashes[path]] = target
	}
	previous := working.project.sourceDir
	working.project = project{mainFile: delta.MainFile, files: files, sourceDir: directory}
	working.hashes = hashes
	working.revision = delta.Revision
	complete = true
	if previous != "" {
		_ = os.RemoveAll(previous)
	}
	compiled := working.project
	compiled.cache = cache
	return compiled, nil
}
