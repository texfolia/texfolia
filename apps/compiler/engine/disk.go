package main

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

const (
	// What Tectonic may keep downloaded, beyond the files built into the image.
	maxDownloadBytes = 1024 * 1024 * 1024
	// Below this, a container is replaced rather than given another compile.
	minFreeBytes = 256 * 1024 * 1024
)

// packageCache is Tectonic's cache directory. Compiles only ever add to it.
type packageCache struct {
	root  string
	limit int64
	// Free bytes on the disk that compiles use.
	free func() (int64, error)

	// Held by compiles for reading, and by an eviction for writing.
	mu sync.RWMutex
	// The files of the image. A manifest grows with each download, and Tectonic
	// trusts it: a listed file that is missing fails a compile.
	image     map[string]bool
	manifests map[string][]byte
}

// tectonicCache is where Tectonic keeps bundle files on Linux.
func tectonicCache() string {
	base := os.Getenv("XDG_CACHE_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".cache")
	}
	return filepath.Join(base, "Tectonic")
}

func newPackageCache(root string) (*packageCache, error) {
	c := &packageCache{root: root, limit: maxDownloadBytes, free: freeBytes, image: map[string]bool{}, manifests: map[string][]byte{}}
	err := c.walk(func(path string, _ fs.FileInfo) error {
		c.image[path] = true
		if filepath.Dir(path) != filepath.Join(root, "manifests") {
			return nil
		}
		content, err := os.ReadFile(path)
		c.manifests[path] = content
		return err
	})
	return c, err
}

func freeBytes() (int64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(os.TempDir(), &stat); err != nil {
		return 0, err
	}
	return int64(stat.Bavail) * stat.Bsize, nil
}

func (c *packageCache) walk(visit func(path string, info fs.FileInfo) error) error {
	return filepath.WalkDir(c.root, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.Type().IsRegular() {
			var info fs.FileInfo
			if info, err = entry.Info(); err == nil {
				err = visit(path, info)
			}
		}
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	})
}

// use keeps the cache in place for one compile. A compile that finds the disk
// low empties the cache first, unless another compile needs it.
func (c *packageCache) use() (release func()) {
	if free, err := c.free(); err == nil && free < minFreeBytes {
		c.trim()
	}
	c.mu.RLock()
	return c.mu.RUnlock
}

// trim evicts every download once they exceed the limit or the disk is low. It
// never waits for a compile.
func (c *packageCache) trim() {
	if !c.mu.TryLock() {
		return
	}
	defer c.mu.Unlock()
	var bytes int64
	var downloads []string
	err := c.walk(func(path string, info fs.FileInfo) error {
		if !c.image[path] {
			downloads, bytes = append(downloads, path), bytes+info.Size()
		}
		return nil
	})
	free, freeErr := c.free()
	if err != nil || len(downloads) == 0 || bytes <= c.limit && (freeErr != nil || free >= minFreeBytes) {
		return
	}
	// Manifests first: an interrupted eviction then costs only another download.
	for path, content := range c.manifests {
		if err := os.WriteFile(path, content, 0600); err != nil {
			slog.Error("Package cache eviction failed", "error", err)
			return
		}
	}
	for _, path := range downloads {
		_ = os.Remove(path)
	}
	slog.Info("Package cache evicted", "files", len(downloads), "bytes", bytes)
}
