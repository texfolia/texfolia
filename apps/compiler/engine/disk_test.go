package main

import (
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPackageCacheEviction(t *testing.T) {
	root := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	read := func(name string) string {
		content, _ := os.ReadFile(filepath.Join(root, name))
		return string(content)
	}
	write("manifests/bundle.txt", "article.cls 1\n")
	write("files/aa/image", "image")
	packages, err := newPackageCache(root)
	if err != nil {
		t.Fatal(err)
	}
	free := int64(minFreeBytes)
	packages.free = func() (int64, error) { return free, nil }
	packages.limit = 10
	download := func(size int) {
		write("manifests/bundle.txt", "article.cls 1\nother.sty 2\n")
		write("files/bb/download", strings.Repeat("x", size))
	}
	kept := func() bool { return read("files/bb/download") != "" }
	evicted := func() bool {
		return !kept() && read("manifests/bundle.txt") == "article.cls 1\n" && read("files/aa/image") == "image"
	}

	handler := newHandler(300*time.Second, 1, packages)
	health := func() int {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/health", nil))
		return response.Code
	}
	download(10)
	if health() != 200 || !kept() {
		t.Fatal("downloads within the limit were evicted")
	}
	download(11)
	release := packages.use()
	if health() != 200 || !kept() {
		t.Fatal("downloads were evicted while a compile used them")
	}
	release()
	if health() != 200 || !evicted() {
		t.Fatal("downloads beyond the limit were kept")
	}

	free--
	download(1)
	if health() != 503 || !evicted() {
		t.Fatal("a full disk was reported as healthy")
	}
	download(1)
	packages.use()()
	if !evicted() {
		t.Fatal("a compile did not make room on a full disk")
	}
	packages.free = func() (int64, error) { return 0, errors.New("unreadable") }
	if health() != 503 {
		t.Fatal("an unreadable disk was reported as healthy")
	}
}

func TestPackageCacheMayBeMissing(t *testing.T) {
	packages, err := newPackageCache(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatal(err)
	}
	packages.trim()
	if free, err := packages.free(); err != nil || free <= 0 {
		t.Fatalf("free space: %d %v", free, err)
	}
}
