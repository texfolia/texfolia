package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSharedPathPolicy(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/contracts/fixtures/path-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Path     string
		Source   bool
		Artifact bool
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Path, func(t *testing.T) {
			if validPath(fixture.Path) != fixture.Artifact {
				t.Fatalf("artifact policy differs for %q", fixture.Path)
			}
			if sourcePath(fixture.Path) != fixture.Source {
				t.Fatalf("source policy differs for %q", fixture.Path)
			}
			body, err := json.Marshal(map[string]any{"files": map[string]string{"main.tex": "main", fixture.Path: "source"}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = parseProject(body)
			if (err == nil) != fixture.Source {
				t.Fatalf("project parser differs for %q: %v", fixture.Path, err)
			}
			if !fixture.Source {
				return
			}
			target := filepath.Join(t.TempDir(), fixture.Path)
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, []byte("source"), 0600); err != nil {
				t.Fatalf("accepted path cannot be stored: %v", err)
			}
		})
	}
}

func TestMaximumMainFilenameGeneratedArtifacts(t *testing.T) {
	handler, _, _ := testEngine(t, time.Second)
	for _, main := range []string{strings.Repeat("a", 236) + ".tex", strings.Repeat("é", 118) + ".tex"} {
		body, err := json.Marshal(map[string]any{"mainFile": main, "files": map[string]string{main: "long-name"}})
		if err != nil {
			t.Fatal(err)
		}
		response := post(handler, string(body))
		if response.Code != 200 {
			t.Fatalf("maximum main filename failed: %s", response.Body.String())
		}
		request := httptest.NewRequest("POST", "/", response.Body)
		request.Header.Set("Content-Type", response.Header().Get("Content-Type"))
		file, _, err := request.FormFile("artifact:" + strings.TrimSuffix(main, ".tex") + ".synctex.gz")
		if err != nil {
			t.Fatalf("generated SyncTeX artifact missing: %v", err)
		}
		_ = file.Close()
		_ = request.MultipartForm.RemoveAll()
	}
}
