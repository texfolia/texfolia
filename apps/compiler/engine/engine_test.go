package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProject(t *testing.T) {
	for _, body := range []string{
		`{"files":{"main.tex":"hello"}}`,
		`{"mainFile":"src/main.tex","files":{"src/main.tex":"hello","image.png":{"base64":"AAEC/w=="}}}`,
		`{"mainFile":"-main.tex","files":{"-main.tex":"hello"}}`,
	} {
		p, err := parseProject([]byte(body))
		if err != nil || len(p.files[p.mainFile]) == 0 {
			t.Fatalf("valid project rejected: %s: %v", body, err)
		}
		if image, exists := p.files["image.png"]; exists && !bytes.Equal(image, []byte{0, 1, 2, 255}) {
			t.Fatalf("binary asset changed: %v", image)
		}
	}
	for _, body := range []string{
		`null`, `[]`, `{`, `{}`, `{"files":{}}`,
		`{"files":{"main.tex":null}}`,
		`{"mainFile":null,"files":{"main.tex":"hello"}}`,
		`{"mainFile":"main.txt","files":{"main.txt":"hello"}}`,
		`{"files":{"other.tex":"hello"}}`,
		`{"files":{"main.tex":"hello","a":"","a/b/c":""}}`,
		`{"files":{"main.tex":"hello","asset":{"base64":"!!!"}}}`,
		`{"files":{"main.tex":"hello","asset":{"base64":"YQ"}}}`,
		`{"files":{"main.tex":"hello","asset":{"base64":"YQ==\n"}}}`,
		`{"files":{"main.tex":"hello","asset":{"base64":null}}}`,
	} {
		_, err := parseProject([]byte(body))
		var failure *httpError
		if !errors.As(err, &failure) || failure.status != 400 {
			t.Fatalf("invalid project accepted: %s: %v", body, err)
		}
	}
	for _, path := range []string{"../escape", "/etc/passwd", "C:/secret", "a\\b", "./main.tex", "a//b", "a/../b", "a\x00b", strings.Repeat("a", 241)} {
		body, _ := json.Marshal(map[string]any{"files": map[string]string{"main.tex": "hello", path: "bad"}})
		if _, err := parseProject(body); err == nil {
			t.Fatalf("unsafe path accepted: %q", path)
		}
	}
	files := map[string]string{"main.tex": "hello"}
	for i := range 200 {
		files[strings.Repeat("x", i+1)] = ""
	}
	body, _ := json.Marshal(map[string]any{"files": files})
	if _, err := parseProject(body); err == nil {
		t.Fatal("accepted more than 200 files")
	}
}

// Exercise process execution, filesystem isolation and HTTP together without a TeX bundle download.
func testEngine(t *testing.T, timeout time.Duration) (http.Handler, string, string) {
	t.Helper()
	bin, temp, marker := t.TempDir(), t.TempDir(), filepath.Join(t.TempDir(), "started")
	script := `#!/bin/sh
set -eu
[ "$1" = --untrusted ] && [ "$2" = --keep-logs ] && [ "$3" = --outdir ]
[ "${SERVICE_SECRET-unset}" = unset ]
case "$5" in ./*) ;; *) exit 99 ;; esac
out="$4"
name="${5##*/}"
name="${name%.tex}"
text=$(cat "$5")
case "$text" in
slow) touch '` + marker + `'; exec sleep 5 ;;
bad) echo 'undefined control sequence' >&2; echo 'invalidcommand' > "$out/$name.log"; exit 1 ;;
missing) exit 0 ;;
large) truncate -s 20971521 "$out/$name.pdf" ;;
logs) head -c 100000 /dev/zero | tr '\000' x; head -c 100000 /dev/zero | tr '\000' y >&2; printf START > "$out/$name.log"; head -c 100000 /dev/zero | tr '\000' z >> "$out/$name.log"; printf END >> "$out/$name.log"; printf '%%PDF-1.5' > "$out/$name.pdf" ;;
*) printf '%%PDF-1.5\n' > "$out/$name.pdf"; cat "$5" >> "$out/$name.pdf"; if [ -f sections/hello.tex ]; then cat sections/hello.tex assets/data.bin >> "$out/$name.pdf"; fi; echo transcript > "$out/$name.log" ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "tectonic"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("TMPDIR", temp)
	t.Setenv("SERVICE_SECRET", "must not reach TeX")
	return newHandler(timeout), temp, marker
}

func post(handler http.Handler, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/compile", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertClean(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary projects leaked: %v %v", entries, err)
	}
}

func TestCompileHTTP(t *testing.T) {
	handler, temp, _ := testEngine(t, time.Second)
	response := post(handler, `{"mainFile":"src/-main.tex","files":{"src/-main.tex":"hello","sections/hello.tex":"nested","assets/data.bin":{"base64":"AAEC/w=="}}}`)
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("compile failed: %d %s", response.Code, response.Body)
	}
	request := &http.Request{Header: response.Header(), Body: io.NopCloser(bytes.NewReader(response.Body.Bytes()))}
	form, err := request.MultipartReader()
	if err != nil {
		t.Fatal(err)
	}
	part, err := form.NextPart()
	if err != nil || part.FormName() != "pdf" || part.FileName() != "output.pdf" || part.Header.Get("Content-Type") != "application/pdf" {
		t.Fatalf("invalid PDF part: %v", err)
	}
	pdf, _ := io.ReadAll(part)
	if !bytes.Equal(pdf, append([]byte("%PDF-1.5\nhellonested"), 0, 1, 2, 255)) {
		t.Fatalf("source or asset changed: %q", pdf)
	}
	part, err = form.NextPart()
	if err != nil || part.FormName() != "log" {
		t.Fatalf("missing log: %v", err)
	}
	log, _ := io.ReadAll(part)
	if string(log) != "transcript" {
		t.Fatalf("invalid log: %q", log)
	}
	assertClean(t, temp)
}

func TestFailuresAndLimits(t *testing.T) {
	handler, temp, _ := testEngine(t, time.Second)
	for _, test := range []struct {
		input  string
		status int
		log    string
	}{{"bad", 422, "invalidcommand"}, {"large", 413, ""}, {"missing", 500, ""}, {"hello", 200, ""}} {
		body, _ := json.Marshal(map[string]any{"files": map[string]string{"main.tex": test.input}})
		response := post(handler, string(body))
		if response.Code != test.status || !strings.Contains(response.Body.String(), test.log) {
			t.Fatalf("%s: %d %s", test.input, response.Code, response.Body)
		}
		assertClean(t, temp)
	}
	for _, body := range []string{`{`, `{"files":{}}`} {
		if response := post(handler, body); response.Code != 400 {
			t.Fatalf("invalid JSON/project: %d", response.Code)
		}
	}
	request := httptest.NewRequest("POST", "/compile", strings.NewReader("{}"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 415 {
		t.Fatalf("content type: %d", response.Code)
	}
	response = post(handler, `{"files":{"main.tex":"`+strings.Repeat("x", maxProjectBytes)+`"}}`)
	if response.Code != 413 {
		t.Fatalf("oversized body: %d", response.Code)
	}
	response = post(handler, `{"files":{"main.tex":"logs"}}`)
	if response.Code != 200 || response.Body.Len() > 3*maxLogBytes+2048 || !strings.Contains(response.Body.String(), "START") || !strings.Contains(response.Body.String(), "END") {
		t.Fatalf("logs unbounded or lost transcript endpoints: %d (%d bytes)", response.Code, response.Body.Len())
	}
	assertClean(t, temp)
}

func TestBusyTimeoutAndRecovery(t *testing.T) {
	handler, temp, marker := testEngine(t, 200*time.Millisecond)
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- post(handler, `{"files":{"main.tex":"slow"}}`) }()
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("compiler did not start")
		}
		time.Sleep(time.Millisecond)
	}
	response := post(handler, `{"files":{"main.tex":"hello"}}`)
	if response.Code != 503 || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("busy: %d %v", response.Code, response.Header())
	}
	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest("GET", "/health", nil))
	if health.Code != 200 {
		t.Fatalf("health blocked by compile: %d", health.Code)
	}
	if response := <-first; response.Code != 408 {
		t.Fatalf("timeout: %d %s", response.Code, response.Body)
	}
	assertClean(t, temp)
	if response := post(handler, `{"files":{"main.tex":"hello"}}`); response.Code != 200 {
		t.Fatalf("busy slot not released: %d", response.Code)
	}
	assertClean(t, temp)
}
