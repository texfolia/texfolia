package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func deltaJSON(t *testing.T, delta sourceDelta) []byte {
	t.Helper()
	body, err := json.Marshal(delta)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func deltaFile(t *testing.T, content string) sourceFile {
	t.Helper()
	raw, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	return sourceFile{Hash: hashSource([]byte(content)), Content: raw}
}

func TestDeltaCompileHTTP(t *testing.T) {
	handler, _, _ := testEngine(t, time.Second)
	delta := sourceDelta{MainFile: "main.tex", BaseRevision: 0, Revision: 1, Files: map[string]sourceFile{
		"main.tex": deltaFile(t, "first"), "sections/hello.tex": deltaFile(t, "nested"), "assets/data.bin": {Hash: hashSource([]byte{0, 1, 255}), Content: json.RawMessage(`{"base64":"AAH/"}`)},
	}}
	response := post(handler, string(deltaJSON(t, delta)))
	if response.Code != 409 || response.Header().Get("X-Source-Resync") != "1" {
		t.Fatalf("missing working copy did not request resync: %d %s", response.Code, response.Body)
	}
	delta.Resync = true
	response = post(handler, string(deltaJSON(t, delta)))
	if response.Code != 200 || response.Header().Get("X-Source-Revision") != "1" {
		t.Fatalf("initial resync failed: %d %s", response.Code, response.Body)
	}
	delta = sourceDelta{MainFile: "main.tex", BaseRevision: 1, Revision: 2, Files: map[string]sourceFile{"main.tex": deltaFile(t, "second")}}
	response = post(handler, string(deltaJSON(t, delta)))
	if response.Code != 200 || !strings.Contains(response.Body.String(), "secondnested") || !strings.Contains(response.Body.String(), string([]byte{0, 1, 255})) {
		t.Fatalf("delta lost unchanged text or binary: %d %s", response.Code, response.Body)
	}
	delta = sourceDelta{MainFile: "main.tex", BaseRevision: 2, Revision: 3, Deleted: []string{"sections/hello.tex"}}
	response = post(handler, string(deltaJSON(t, delta)))
	if response.Code != 200 || strings.Contains(response.Body.String(), "nested") {
		t.Fatalf("deletion not applied: %d %s", response.Code, response.Body)
	}
	delta.BaseRevision = 3
	delta.Revision = 3
	delta.Deleted = nil
	if response = post(handler, string(deltaJSON(t, delta))); response.Code != 200 {
		t.Fatalf("clean retry on same revision failed: %d %s", response.Code, response.Body)
	}
	delta = sourceDelta{MainFile: "main.tex", BaseRevision: 3, Revision: 4, Files: map[string]sourceFile{"main.tex": deltaFile(t, "bad")}}
	response = post(handler, string(deltaJSON(t, delta)))
	if response.Code != 422 || response.Header().Get("X-Source-Revision") != "4" {
		t.Fatalf("TeX failure lost the applied source revision: %d %s", response.Code, response.Body)
	}
	delta = sourceDelta{MainFile: "main.tex", BaseRevision: 4, Revision: 5, Files: map[string]sourceFile{"main.tex": deltaFile(t, "repaired")}}
	response = post(handler, string(deltaJSON(t, delta)))
	if response.Code != 200 || !strings.Contains(response.Body.String(), "repaired") {
		t.Fatalf("TeX failure left working copy stuck: %d %s", response.Code, response.Body)
	}
	fresh, _, _ := testEngine(t, time.Second)
	response = post(fresh, string(deltaJSON(t, sourceDelta{MainFile: "main.tex", BaseRevision: 3, Revision: 4})))
	if response.Code != 409 || response.Header().Get("X-Source-Resync") != "1" {
		t.Fatalf("restarted engine did not request resync: %d", response.Code)
	}
}

func TestDeltaHashMismatchIsAtomicAndRecovers(t *testing.T) {
	var working workingCopy
	delta := sourceDelta{MainFile: "main.tex", BaseRevision: 0, Revision: 1, Resync: true, Files: map[string]sourceFile{"main.tex": deltaFile(t, "original"), "asset.bin": deltaFile(t, "binary")}}
	_, err := working.apply(deltaJSON(t, delta))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(working.project.sourceDir) })
	bad := sourceDelta{MainFile: "main.tex", BaseRevision: 1, Revision: 2, Files: map[string]sourceFile{"main.tex": {Hash: strings.Repeat("0", 64), Content: json.RawMessage(`"wrong"`)}}}
	if _, err = working.apply(deltaJSON(t, bad)); err == nil || working.revision != 1 {
		t.Fatal("hash mismatch changed working copy")
	}
	renamed := sourceDelta{MainFile: "main.tex", BaseRevision: 1, Revision: 2, Files: map[string]sourceFile{"renamed.bin": {Hash: delta.Files["asset.bin"].Hash}}, Deleted: []string{"asset.bin"}}
	beforeRename, err := os.Stat(filepath.Join(working.project.sourceDir, "asset.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = working.apply(deltaJSON(t, renamed)); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(working.project.sourceDir, "asset.bin")); !os.IsNotExist(err) {
		t.Fatal("old binary path survived rename")
	}
	if content, err := os.ReadFile(filepath.Join(working.project.sourceDir, "renamed.bin")); err != nil || string(content) != "binary" {
		t.Fatal("hash-addressed binary rename failed")
	}
	afterRename, err := os.Stat(filepath.Join(working.project.sourceDir, "renamed.bin"))
	if err != nil || !os.SameFile(beforeRename, afterRename) {
		t.Fatal("binary rename rewrote existing content")
	}
	unchanged := sourceDelta{MainFile: "main.tex", BaseRevision: 2, Revision: 3, Files: map[string]sourceFile{"main.tex": deltaFile(t, "changed")}}
	previousInfo, err := os.Stat(filepath.Join(working.project.sourceDir, "renamed.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = working.apply(deltaJSON(t, unchanged)); err != nil {
		t.Fatal(err)
	}
	newInfo, err := os.Stat(filepath.Join(working.project.sourceDir, "renamed.bin"))
	if err != nil || !os.SameFile(previousInfo, newInfo) {
		t.Fatal("unchanged binary was rewritten")
	}
	path := filepath.Join(working.project.sourceDir, "main.tex")
	if err = os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("corrupted"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = working.apply(deltaJSON(t, sourceDelta{MainFile: "main.tex", BaseRevision: 3, Revision: 4})); err == nil {
		t.Fatal("disk hash mismatch was not detected")
	}
	delta.BaseRevision = 0
	delta.Revision = 4
	if _, err = working.apply(deltaJSON(t, delta)); err != nil {
		t.Fatalf("full resync did not repair corrupted copy: %v", err)
	}
	content, err := os.ReadFile(filepath.Join(working.project.sourceDir, "main.tex"))
	if err != nil || string(content) != "original" {
		t.Fatal("resync did not restore server bytes")
	}
}

func TestDeltaValidationAndProjectIsolation(t *testing.T) {
	handler, _, _ := testEngine(t, time.Second)
	send := func(owner string, delta sourceDelta) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/compile", strings.NewReader(string(deltaJSON(t, delta))))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Project-Id", owner)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	delta := sourceDelta{MainFile: "main.tex", BaseRevision: 0, Revision: 1, Resync: true, Files: map[string]sourceFile{"main.tex": deltaFile(t, "hello")}}
	if response := send("one", delta); response.Code != 200 {
		t.Fatalf("first owner rejected: %d", response.Code)
	}
	if response := send("two", delta); response.Code != 409 {
		t.Fatal("another project overwrote working copy")
	}
	for _, path := range []string{"../outside", "out/stolen", "a\\b", "/absolute"} {
		delta.Files[path] = deltaFile(t, "unsafe")
		if response := send("one", delta); response.Code != 400 {
			t.Fatalf("unsafe path accepted: %s %d", path, response.Code)
		}
		delete(delta.Files, path)
	}
}
