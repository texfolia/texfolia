package main

import (
	"archive/tar"
	"bytes"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestCacheArchiveRoundTrip(t *testing.T) {
	files := map[string][]byte{"main.aux": []byte("cached aux"), "nested/custom.bin": {0, 1, 2, 255}}
	archive, err := packCache(files)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(archive[:4], []byte{0x28, 0xb5, 0x2f, 0xfd}) {
		t.Fatal("cache is not a zstd frame")
	}
	restored, err := unpackCache(bytes.NewReader(archive))
	if err != nil || !reflect.DeepEqual(files, restored) {
		t.Fatalf("cache changed: %v, %v", restored, err)
	}
	for _, invalid := range [][]byte{archive[:len(archive)-1], []byte("not zstd")} {
		if _, err := unpackCache(bytes.NewReader(invalid)); err == nil {
			t.Fatal("accepted corrupt archive")
		}
	}
}

func TestCacheArchiveRejectsUnsafeEntries(t *testing.T) {
	for _, header := range []tar.Header{
		{Name: "../escape", Typeflag: tar.TypeReg},
		{Name: "/absolute", Typeflag: tar.TypeReg},
		{Name: "symlink", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"},
		{Name: "hardlink", Typeflag: tar.TypeLink, Linkname: "main.aux"},
		{Name: "directory/", Typeflag: tar.TypeDir},
		{Name: "huge", Typeflag: tar.TypeReg, Size: maxArtifactBytes + 1},
	} {
		t.Run(header.Name, func(t *testing.T) {
			var compressed bytes.Buffer
			encoder, _ := zstd.NewWriter(&compressed)
			archive := tar.NewWriter(encoder)
			if err := archive.WriteHeader(&header); err != nil {
				t.Fatal(err)
			}
			_ = archive.Close()
			_ = encoder.Close()
			if _, err := unpackCache(&compressed); err == nil {
				t.Fatal("accepted unsafe archive entry")
			}
		})
	}
	for _, files := range []map[string][]byte{{}, {"file": {}, "file/child": {}}} {
		archive, err := packCache(files)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := unpackCache(bytes.NewReader(archive)); err == nil {
			t.Fatal("accepted empty or conflicting archive")
		}
	}
}

func TestCacheArchiveSupportsLongNamesAtFileLimit(t *testing.T) {
	files := make(map[string][]byte, maxCacheFiles)
	content := bytes.Repeat([]byte{1}, maxArtifactBytes/maxCacheFiles)
	for index := range maxCacheFiles {
		files[strings.Repeat("界", 83)+fmt.Sprintf("%06d", index)] = content
	}
	archive, err := packCache(files)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := unpackCache(bytes.NewReader(archive))
	if err != nil || !reflect.DeepEqual(files, restored) {
		t.Fatalf("long-name archive failed: %v", err)
	}
	files["extra"] = []byte{1}
	if _, err := packCache(files); err == nil {
		t.Fatal("accepted cache beyond file limit")
	}
}
