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
cache) [ "$(cat out/main.aux)" = "cached aux" ]; mkdir -p "$out/custom"; printf '\000\001\002\377' > "$out/custom/data.bin"; printf '%%PDF-1.5' > "$out/$name.pdf"; echo transcript > "$out/$name.log" ;;
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
	handler := newHandler(timeout)
	t.Cleanup(func() { _ = handler.Close() })
	return handler, temp, marker
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

type flushRecorder struct {
	*httptest.ResponseRecorder
	flushedBodies []string
}

func (w *flushRecorder) Flush() {
	w.flushedBodies = append(w.flushedBodies, w.Body.String())
	w.ResponseRecorder.Flush()
}

func TestPDFIsFlushedBeforeLogAndArtifacts(t *testing.T) {
	handler, temp, _ := testEngine(t, time.Second)
	request := httptest.NewRequest(http.MethodPost, "/compile", strings.NewReader(`{"files":{"main.tex":"hello"}}`))
	request.Header.Set("Content-Type", "application/json")
	response := &flushRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(response, request)
	if response.Code != 200 || len(response.flushedBodies) < 2 {
		t.Fatalf("missing PDF/log flushes: %d %v", response.Code, response.flushedBodies)
	}
	if !strings.Contains(response.flushedBodies[0], "%PDF-1.5") || strings.Contains(response.flushedBodies[0], `name="log"`) {
		t.Fatalf("PDF was not flushed first: %q", response.flushedBodies[0])
	}
	if !strings.Contains(response.flushedBodies[1], `name="log"`) || strings.Contains(response.flushedBodies[1], `name="artifact:`) {
		t.Fatalf("log was not flushed before artifacts: %q", response.flushedBodies[1])
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
	if response.Code != 200 {
		t.Fatalf("log compile failed: %d", response.Code)
	}
	request = httptest.NewRequest("POST", "/", nil)
	request.Header = response.Header()
	request.Body = io.NopCloser(bytes.NewReader(response.Body.Bytes()))
	if err := request.ParseMultipartForm(1024 * 1024); err != nil {
		t.Fatal(err)
	}
	diagnostic := request.FormValue("log")
	if len(diagnostic) > 3*maxLogBytes+32 || !strings.Contains(diagnostic, "START") || !strings.Contains(diagnostic, "END") {
		t.Fatalf("diagnostic is unbounded or lost endpoints: %d bytes", len(diagnostic))
	}
	file, _, err := request.FormFile("artifact:main.log")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	rawLog, err := io.ReadAll(file)
	if err != nil || len(rawLog) != 100008 {
		t.Fatalf("full generated log was truncated: %d, %v", len(rawLog), err)
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

func TestStageTiming(t *testing.T) {
	handler, _, _ := testEngine(t, time.Second)
	for i, source := range []string{"hello", "bad"} {
		req := httptest.NewRequest("POST", "/compile", strings.NewReader(`{"files":{"main.tex":"`+source+`"}}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Compilation-Id", "01911111-1111-4111-8111-111111111111")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		var timing engineTiming
		if err := json.Unmarshal([]byte(response.Header().Get("X-Compile-Timing")), &timing); err != nil {
			t.Fatal(err)
		}
		expected := "cold"
		if i > 0 {
			expected = "warm"
		}
		if timing.Engine != "tectonic" || timing.Temperature != expected {
			t.Fatalf("incorrect engine context: %+v", timing)
		}
		for _, duration := range []*float64{timing.InputPrepMs, timing.CompileMs, timing.OutputMs} {
			if duration == nil || *duration < 0 {
				t.Fatalf("missing stage timing: %+v", timing)
			}
		}
		if i == 1 && response.Code != 422 {
			t.Fatalf("timing changed failure behavior: %d", response.Code)
		}
	}
}

func TestProjectOwnershipAndCancellation(t *testing.T) {
	handler, temp, marker := testEngine(t, 10*time.Second)
	server := httptest.NewServer(handler)
	defer server.Close()
	send := func(project, id, source string) *http.Response {
		req, _ := http.NewRequest("POST", server.URL+"/compile", strings.NewReader(`{"files":{"main.tex":"`+source+`"}}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Project-Id", project)
		req.Header.Set("X-Compilation-Id", id)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Error(err)
			return nil
		}
		return res
	}
	finished := make(chan *http.Response, 1)
	go func() { finished <- send("project-a", "old", "slow") }()
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("engine did not start")
		}
		time.Sleep(time.Millisecond)
	}
	cancel, _ := http.NewRequest("DELETE", server.URL+"/compilations/old", nil)
	stopped, err := http.DefaultClient.Do(cancel)
	if err != nil {
		t.Fatal(err)
	}
	_ = stopped.Body.Close()
	if stopped.StatusCode != 204 {
		t.Fatalf("cancel: %d", stopped.StatusCode)
	}
	prior := <-finished
	if prior == nil {
		t.Fatal("missing response")
	}
	_ = prior.Body.Close()
	assertClean(t, temp)
	next := send("project-a", "new", "hello")
	_ = next.Body.Close()
	if next.StatusCode != 200 {
		t.Fatalf("replacement: %d", next.StatusCode)
	}
	other := send("project-b", "other", "hello")
	_ = other.Body.Close()
	if other.StatusCode != 409 {
		t.Fatalf("engine reused by other project: %d", other.StatusCode)
	}
	// A DELETE may overtake POST on a separate connection.
	early, _ := http.NewRequest("DELETE", server.URL+"/compilations/early", nil)
	res, err := http.DefaultClient.Do(early)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	late := send("project-a", "early", "hello")
	_ = late.Body.Close()
	if late.StatusCode != 409 {
		t.Fatalf("early cancellation lost: %d", late.StatusCode)
	}
	assertClean(t, temp)
}

func TestCacheAndAllArtifacts(t *testing.T) {
	handler, temp, _ := testEngine(t, time.Second)
	response := post(handler, `{"files":{"main.tex":"cache"},"cache":{"main.aux":{"base64":"Y2FjaGVkIGF1eA=="},"custom.unknown":{"base64":"AAEC/w=="}}}`)
	if response.Code != 200 {
		t.Fatalf("cached compile failed: %d %s", response.Code, response.Body)
	}
	request := httptest.NewRequest("POST", "/", nil)
	request.Header = response.Header()
	request.Body = io.NopCloser(bytes.NewReader(response.Body.Bytes()))
	if err := request.ParseMultipartForm(1024 * 1024); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"pdf", "artifact:main.log", "artifact:main.aux", "artifact:custom.unknown", "artifact:custom/data.bin"} {
		if len(request.MultipartForm.File[name]) != 1 {
			t.Fatalf("missing artifact %s", name)
		}
	}
	file, _, err := request.FormFile("artifact:custom/data.bin")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil || !bytes.Equal(data, []byte{0, 1, 2, 255}) {
		t.Fatalf("binary artifact changed: %v %v", data, err)
	}
	assertClean(t, temp)
	for _, body := range []string{
		`{"files":{"main.tex":"ok","out/forbidden.tex":"bad"}}`,
		`{"files":{"main.tex":"ok"},"cache":{"../escape":{"base64":"YQ=="}}}`,
	} {
		if response := post(handler, body); response.Code != 400 {
			t.Fatalf("unsafe cache/source accepted: %d", response.Code)
		}
	}
}

func TestPlanTimeouts(t *testing.T) {
	for _, tc := range []struct {
		plan, requested string
		want            time.Duration
		invalid         bool
	}{
		{"free", "", 15 * time.Second, false},
		{"pro", "", 300 * time.Second, false},
		{"team", "300000", 300 * time.Second, false},
		{"unknown", "", 15 * time.Second, false},
		{"", "", 15 * time.Second, false},
		{"free", "300000", 0, true},
		{"pro", "300001", 0, true},
		{"pro", "-1", 0, true},
		{"pro", "invalid", 0, true},
		{"free", "0", 0, true},
		{"pro", "2000", 2 * time.Second, false},
	} {
		headers := http.Header{}
		headers.Set("X-Compile-Plan", tc.plan)
		headers.Set("X-Compile-Timeout-Ms", tc.requested)
		got, err := requestCompileTimeout(headers, 300*time.Second)
		if (err != nil) != tc.invalid || got != tc.want {
			t.Fatalf("%+v: got %s, %v", tc, got, err)
		}
	}
}

func TestCoordinatorTimeoutKillsProcess(t *testing.T) {
	handler, temp, _ := testEngine(t, 300*time.Second)
	for _, plan := range []string{"free", "pro", "team"} {
		request := httptest.NewRequest(http.MethodPost, "/compile", strings.NewReader(`{"files":{"main.tex":"slow"}}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Compile-Plan", plan)
		request.Header.Set("X-Compile-Timeout-Ms", "20")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 408 {
			t.Fatalf("%s: %d %s", plan, response.Code, response.Body)
		}
		assertClean(t, temp)
	}
}
