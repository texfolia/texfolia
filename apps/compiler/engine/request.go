package main

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const maxManifestBytes = 1024 * 1024

// Sources, the restored cache, the manifest, and tar padding.
const maxRequestBytes = 64 * 1024 * 1024

// The first entry of a compile request. files maps paths to SHA-256 hashes.
type manifest struct {
	MainFile string            `json:"mainFile"`
	Files    map[string]string `json:"files"`
	Clean    bool              `json:"clean"`
	Preview  bool              `json:"preview"`
	// The caller's last compile ran in this slot, so its cache is current.
	Incremental bool `json:"incremental"`
}

func invalidRequest() error {
	return &httpError{status: 400, message: "Invalid project sources"}
}

func validHash(hash string) bool {
	decoded, err := hex.DecodeString(hash)
	return err == nil && len(decoded) == sha256.Size && strings.ToLower(hash) == hash
}

func (m *manifest) validate() error {
	if len(m.Files) < 1 || len(m.Files) > maxSourceFiles || !sourcePath(m.MainFile) || !strings.HasSuffix(m.MainFile, ".tex") {
		return invalidRequest()
	}
	if _, exists := m.Files[m.MainFile]; !exists {
		return invalidRequest()
	}
	for path, hash := range m.Files {
		if !sourcePath(path) || !validHash(hash) {
			return invalidRequest()
		}
		for parent := path; strings.Contains(parent, "/"); {
			parent = parent[:strings.LastIndexByte(parent, '/')]
			if _, exists := m.Files[parent]; exists {
				return invalidRequest()
			}
		}
	}
	return nil
}

func archiveError(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return &httpError{status: 413, message: "Project exceeds 10 MiB"}
	}
	var failure *httpError
	if errors.As(err, &failure) {
		return failure
	}
	return &httpError{status: 400, message: "Invalid compile archive"}
}

// receive reads one compile request into the slot: the manifest, then source
// blobs the slot may lack, then an optional cache archive. Blobs stay on disk
// for the slot's next compile.
func (s *slot) receive(body io.Reader, timing *engineTiming) (*manifest, error) {
	archive := tar.NewReader(body)
	header, err := archive.Next()
	if err != nil {
		return nil, archiveError(err)
	}
	if header.Name != "manifest.json" || header.Typeflag != tar.TypeReg || header.Size > maxManifestBytes {
		return nil, &httpError{status: 400, message: "Invalid compile archive"}
	}
	raw, err := io.ReadAll(archive)
	if err != nil {
		return nil, archiveError(err)
	}
	var sources manifest
	if json.Unmarshal(raw, &sources) != nil {
		return nil, &httpError{status: 400, message: "Invalid compile manifest"}
	}
	if err := sources.validate(); err != nil {
		return nil, err
	}
	expected := make(map[string]bool, len(sources.Files))
	for _, hash := range sources.Files {
		expected[hash] = true
	}
	if sources.Clean || !sources.Incremental {
		s.cache, s.cacheReady = nil, false
	}
	timing.ArchiveStatus = "missing"
	if s.cacheReady {
		timing.ArchiveStatus = "warm"
	}
	var received int64
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, archiveError(err)
		}
		if header.Typeflag != tar.TypeReg {
			return nil, &httpError{status: 400, message: "Invalid compile archive"}
		}
		if header.Name == "cache.tar.zst" {
			if s.cacheReady || sources.Clean || header.Size == 0 {
				continue
			}
			started := time.Now()
			timing.ArchiveBytes = header.Size
			restored, err := unpackCache(io.LimitReader(archive, maxCacheArchiveBytes))
			if err != nil {
				// A bad archive costs a cold compile, not a failed one.
				timing.ArchiveStatus = "invalid"
				continue
			}
			s.cache, s.cacheReady = restored, true
			timing.ArchiveStatus = "restored"
			timing.ArchiveUnpackMs = elapsedMs(started)
			continue
		}
		hash, found := strings.CutPrefix(header.Name, "blobs/")
		if !found || !expected[hash] {
			return nil, &httpError{status: 400, message: "Invalid compile archive"}
		}
		received += header.Size
		if received >= maxProjectBytes {
			return nil, &httpError{status: 413, message: "Project exceeds 10 MiB"}
		}
		if err := s.storeBlob(hash, archive); err != nil {
			return nil, archiveError(err)
		}
	}
	// Read to the end of the request, not only of the archive: the server then
	// notices when the caller disconnects, and can reuse the connection.
	if _, err := io.Copy(io.Discard, body); err != nil {
		return nil, archiveError(err)
	}
	s.dropChangedBlobs()
	var missing []string
	var size int64
	for hash := range expected {
		if _, exists := s.blobs[hash]; !exists {
			missing = append(missing, hash)
		}
	}
	if len(missing) > 0 {
		return nil, &httpError{status: 409, message: "Source resync required", code: "resync", missing: missing}
	}
	for _, hash := range sources.Files {
		size += s.blobs[hash].size
	}
	if size >= maxProjectBytes {
		return nil, &httpError{status: 413, message: "Project exceeds 10 MiB"}
	}
	s.keepBlobs(expected)
	return &sources, nil
}
