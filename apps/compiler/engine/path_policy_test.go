package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
			request := sources(map[string]string{"main.tex": "main", fixture.Path: "source"})
			err := request.manifest.validate()
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
	handler, _, _ := testEngine(t, 1)
	for _, main := range []string{strings.Repeat("a", 236) + ".tex", strings.Repeat("é", 118) + ".tex"} {
		request := sources(map[string]string{main: "long-name"})
		request.manifest.MainFile = main
		response := request.send(t, handler)
		if response.Code != 200 {
			t.Fatalf("maximum main filename failed: %s", response.Body.String())
		}
		readResponse(t, response.Body).artifact(t, strings.TrimSuffix(main, ".tex")+".synctex.gz")
	}
}
