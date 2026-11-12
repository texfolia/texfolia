package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

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
		files[strings.Repeat("界", 79)+strconv.Itoa(index)] = content
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

func TestCacheRestoreOwnsProjectAndFeedsCompilation(t *testing.T) {
	handler, _, _ := testEngine(t, time.Second)
	archive, err := packCache(map[string][]byte{"main.aux": []byte("cached aux")})
	if err != nil {
		t.Fatal(err)
	}
	restore := func(owner string, body []byte) *httptest.ResponseRecorder {
		request := httptest.NewRequest("PUT", "/cache", bytes.NewReader(body))
		request.Header.Set("X-Project-Id", owner)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	if response := restore("project-a", []byte("corrupt")); response.Code != 422 {
		t.Fatalf("corrupt cache accepted: %d", response.Code)
	}
	if response := restore("project-a", archive); response.Code != 200 || !strings.Contains(response.Body.String(), "archiveUnpackMs") {
		t.Fatalf("restore failed: %d %s", response.Code, response.Body)
	}
	if response := restore("project-b", archive); response.Code != 409 {
		t.Fatalf("another project restored cache: %d", response.Code)
	}
	if response := restore("project-a", []byte("retry ignored")); response.Code != 204 {
		t.Fatalf("restore is not idempotent: %d", response.Code)
	}
	request := httptest.NewRequest("POST", "/compile", strings.NewReader(`{"files":{"main.tex":"cache"}}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Project-Id", "project-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("compile did not use restored aux: %d %s", response.Code, response.Body)
	}
	var timing engineTiming
	if err := json.Unmarshal([]byte(response.Header().Get("X-Compile-Timing")), &timing); err != nil || !timing.CacheUsed || timing.BootMs == nil {
		t.Fatalf("missing cache/startup telemetry: %+v %v", timing, err)
	}
	_, parameters, err := mime.ParseMediaType(response.Header().Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	form := multipart.NewReader(response.Body, parameters["boundary"])
	found := false
	for {
		part, err := form.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if part.FormName() == "cache" {
			restored, err := unpackCache(part)
			if err != nil || !bytes.Equal(restored["custom/data.bin"], []byte{0, 1, 2, 255}) {
				t.Fatalf("missing successful build archive: %v %v", restored, err)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("missing cache part")
	}
	clean := httptest.NewRequest("POST", "/compile", strings.NewReader(`{"files":{"main.tex":"cache"}}`))
	clean.Header.Set("Content-Type", "application/json")
	clean.Header.Set("X-Project-Id", "project-a")
	clean.Header.Set("X-Clean-Compile", "1")
	cleanResponse := httptest.NewRecorder()
	handler.ServeHTTP(cleanResponse, clean)
	if cleanResponse.Code != 422 {
		t.Fatal("clean compilation did not bypass restored auxiliaries")
	}
}

func TestAnonymousBuildsDoNotShareCache(t *testing.T) {
	handler, _, _ := testEngine(t, time.Second)
	first := post(handler, `{"files":{"main.tex":"cache"},"cache":{"main.aux":{"base64":"Y2FjaGVkIGF1eA=="}}}`)
	if first.Code != 200 {
		t.Fatalf("cache fixture failed: %d %s", first.Code, first.Body)
	}
	second := post(handler, `{"files":{"main.tex":"cache"}}`)
	if second.Code != 422 {
		t.Fatal("an anonymous build reused another job's cache")
	}
}
