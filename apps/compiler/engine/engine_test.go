package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The smallest complete compile request. blobs defaults to every source.
type compileRequest struct {
	id         string
	affinity   string
	slot       int
	generation int64
	timeoutMs  int64
	manifest   manifest
	blobs      map[string]string
	cache      []byte
}

func hashSource(content string) string {
	digest := sha256.Sum256([]byte(content))
	return hex.EncodeToString(digest[:])
}

func sources(files map[string]string) compileRequest {
	request := compileRequest{id: "job", affinity: "a", generation: 1, timeoutMs: 1000, blobs: map[string]string{}}
	request.manifest = manifest{MainFile: "main.tex", Files: map[string]string{}}
	for path, content := range files {
		request.manifest.Files[path] = hashSource(content)
		request.blobs[hashSource(content)] = content
	}
	return request
}

func source(content string) compileRequest {
	return sources(map[string]string{"main.tex": content})
}

func (c compileRequest) with(change func(*compileRequest)) compileRequest {
	change(&c)
	return c
}

func (c compileRequest) archive(t *testing.T) []byte {
	t.Helper()
	var body bytes.Buffer
	archive := tar.NewWriter(&body)
	add := func(name string, content []byte) {
		if err := archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := json.Marshal(c.manifest)
	if err != nil {
		t.Fatal(err)
	}
	add("manifest.json", raw)
	for hash, content := range c.blobs {
		add("blobs/"+hash, []byte(content))
	}
	if c.cache != nil {
		add("cache.tar.zst", c.cache)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func (c compileRequest) http(t *testing.T, url string) *http.Request {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url+"/compile", bytes.NewReader(c.archive(t)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/x-tar")
	request.Header.Set("X-Compile-Id", c.id)
	request.Header.Set("X-Compile-Affinity", c.affinity)
	request.Header.Set("X-Compile-Slot", strconv.Itoa(c.slot))
	request.Header.Set("X-Compile-Generation", strconv.FormatInt(c.generation, 10))
	request.Header.Set("X-Compile-Timeout-Ms", strconv.FormatInt(c.timeoutMs, 10))
	return request
}

func (c compileRequest) send(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, c.http(t, ""))
	return response
}

type compileResponse struct {
	order   []string
	entries map[string][]byte
	result  resultEntry
}

func (c compileResponse) artifact(t *testing.T, path string) []byte {
	t.Helper()
	index := slices.Index(c.result.Files, path)
	if index < 0 {
		t.Fatalf("missing artifact %q in %v", path, c.result.Files)
	}
	return c.entries["artifacts/"+strconv.Itoa(index)]
}

func readResponse(t *testing.T, body io.Reader) compileResponse {
	t.Helper()
	parsed := compileResponse{entries: map[string][]byte{}}
	archive := tar.NewReader(body)
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(archive)
		if err != nil {
			t.Fatal(err)
		}
		parsed.order = append(parsed.order, header.Name)
		parsed.entries[header.Name] = content
	}
	if err := json.Unmarshal(parsed.entries["result.json"], &parsed.result); err != nil {
		t.Fatal(err)
	}
	return parsed
}

func responseTiming(t *testing.T, response *httptest.ResponseRecorder) engineTiming {
	t.Helper()
	var timing engineTiming
	if err := json.Unmarshal([]byte(response.Header().Get("X-Compile-Timing")), &timing); err != nil {
		t.Fatal(err)
	}
	return timing
}

// Exercise process execution, filesystem isolation and HTTP together without a TeX bundle download.
func testEngine(t *testing.T, slots int) (*engineHandler, string, string) {
	t.Helper()
	bin, temp, marker := t.TempDir(), t.TempDir(), filepath.Join(t.TempDir(), "started")
	script := `#!/bin/sh
set -eu
[ "$1" = --untrusted ]
[ "$2" = --keep-logs ]
[ "$3" = --outdir ]
[ "$TECTONIC_UNTRUSTED_MODE" = 1 ]
[ -d "$TMPDIR" ]
echo private > "$TMPDIR/job-secret"
[ "${SERVICE_SECRET-unset}" = unset ]
case "$5" in ./*) ;; *) exit 99 ;; esac
out="$4"
name="${5##*/}"
name="${name%.tex}"
text=$(cat "$5")
case "$text" in
cache) [ "$(cat out/main.aux)" = "cached aux" ]; mkdir -p "$out/custom"; printf 'cached aux' > "$out/main.aux"; printf '\000\001\002\377' > "$out/custom/data.bin"; printf '%%PDF-1.5' > "$out/$name.pdf"; echo transcript > "$out/$name.log" ;;
slow) touch '` + marker + `'; exec sleep 5 ;;
child) sleep 60 & echo $! > '` + marker + `'; wait ;;
orphan) sleep 60 >/dev/null 2>&1 & echo $! > '` + marker + `'; printf '%%PDF-1.5' > "$out/$name.pdf" ;;
limits) printf '%%PDF-1.5' > "$out/$name.pdf"; { ulimit -v; ulimit -f; ulimit -c; } > "$out/limits.txt" ;;
huge) truncate -s 67108865 "$out/$name.pdf" ;;
stale) [ ! -f "$out/main.log" ] && [ -f "$out/main.aux" ] || printf unexpected > "$out/$name.log"; exit 1 ;;
copies) printf '%%PDF-1.5' > "$out/$name.pdf"; cp refs.bib "$out/refs.bib"; printf changed > "$out/notes.bib" ;;
outputs) printf '%%PDF-1.5' > "$out/$name.pdf"; echo transcript > "$out/$name.log"; echo sync > "$out/$name.synctex.gz"; echo aux > "$out/$name.aux" ;;
bad) echo 'undefined control sequence' >&2; echo 'invalidcommand' > "$out/$name.log"; exit 1 ;;
tamper) printf hijacked > main.tex && exit 1; printf '%%PDF-1.5' > "$out/$name.pdf" ;;
long-name) printf '%%PDF-1.5' > "$out/$name.pdf"; echo transcript > "$out/$name.log"; echo sync > "$out/$name.synctex.gz" ;;
missing) exit 0 ;;
large) truncate -s 20971521 "$out/$name.pdf" ;;
logs) head -c 100000 /dev/zero | tr '\000' x; head -c 100000 /dev/zero | tr '\000' y >&2; printf START > "$out/$name.log"; head -c 100000 /dev/zero | tr '\000' z >> "$out/$name.log"; printf END >> "$out/$name.log"; printf '%%PDF-1.5' > "$out/$name.pdf" ;;
*) printf '%%PDF-1.5\n' > "$out/$name.pdf"; cat "$5" >> "$out/$name.pdf"; if [ -f sections/hello.tex ]; then cat sections/hello.tex assets/data.bin >> "$out/$name.pdf"; fi; echo transcript > "$out/$name.log"; echo aux > "$out/$name.aux" ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "tectonic"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("TMPDIR", temp)
	t.Setenv("SERVICE_SECRET", "must not reach TeX")
	packages, err := newPackageCache(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(300*time.Second, slots, packages)
	t.Cleanup(func() {
		_ = handler.Close()
		assertEmpty(t, temp)
	})
	return handler, temp, marker
}

func assertEmpty(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary projects leaked: %v %v", entries, err)
	}
}

// Between compiles a slot holds only its own source blobs.
func assertOnlyBlobs(t *testing.T, temp string, contents ...string) {
	t.Helper()
	expected := []string{}
	for _, content := range contents {
		expected = append(expected, hashSource(content))
	}
	found := []string{}
	slots, err := os.ReadDir(temp)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range slots {
		blobs, err := os.ReadDir(filepath.Join(temp, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range blobs {
			found = append(found, entry.Name())
		}
	}
	slices.Sort(expected)
	slices.Sort(found)
	if !slices.Equal(expected, found) {
		t.Fatalf("slot retained %v, expected %v", found, expected)
	}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("compiler did not start")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestCompileRequestValidation(t *testing.T) {
	handler, _, _ := testEngine(t, 1)
	valid := sources(map[string]string{"main.tex": "hello", "image.png": "\x00\x01\x02\xff"})
	if response := valid.send(t, handler); response.Code != 200 {
		t.Fatalf("valid project rejected: %d %s", response.Code, response.Body)
	}
	many := map[string]string{"main.tex": "hello"}
	for i := range 200 {
		many[strings.Repeat("x", i+1)] = "x"
	}
	for name, request := range map[string]compileRequest{
		"no files":       source("hello").with(func(c *compileRequest) { c.manifest.Files = nil; c.blobs = nil }),
		"no main file":   source("hello").with(func(c *compileRequest) { c.manifest.MainFile = "other.tex" }),
		"not TeX":        sources(map[string]string{"main.txt": "hello"}).with(func(c *compileRequest) { c.manifest.MainFile = "main.txt" }),
		"overlap":        sources(map[string]string{"main.tex": "hello", "a": "b", "a/b/c": "c"}),
		"too many files": sources(many),
		"invalid hash":   source("hello").with(func(c *compileRequest) { c.manifest.Files["main.tex"] = strings.Repeat("A", 64) }),
		"unknown blob":   source("hello").with(func(c *compileRequest) { c.blobs[hashSource("x")] = "x" }),
		"hash mismatch":  source("new").with(func(c *compileRequest) { c.blobs = map[string]string{hashSource("new"): "other"} }),
	} {
		t.Run(name, func(t *testing.T) {
			if response := request.send(t, handler); response.Code != 400 {
				t.Fatalf("accepted: %d %s", response.Code, response.Body)
			}
		})
	}
	for _, path := range []string{"../escape", "/etc/passwd", "C:/secret", "a\\b", "./main.tex", "a//b", "a/../b", "a\x00b", "out/stolen", strings.Repeat("a", 241)} {
		if response := sources(map[string]string{"main.tex": "hello", path: "bad"}).send(t, handler); response.Code != 400 {
			t.Fatalf("unsafe path accepted: %q", path)
		}
	}
	for header, value := range map[string]string{
		"X-Compile-Id": "", "X-Compile-Affinity": "", "X-Compile-Slot": "1", "X-Compile-Generation": "0", "X-Compile-Timeout-Ms": "300001",
	} {
		request := valid.http(t, "")
		request.Header.Set(header, value)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 400 {
			t.Fatalf("invalid %s accepted: %d", header, response.Code)
		}
	}
	request := valid.http(t, "")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 415 {
		t.Fatalf("content type: %d", response.Code)
	}
	request = valid.http(t, "")
	request.Body = io.NopCloser(strings.NewReader("not a tar archive"))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 400 {
		t.Fatalf("corrupt archive: %d", response.Code)
	}
	// The limit covers sources kept from an earlier request as well.
	half := strings.Repeat("x", maxProjectBytes/2)
	if response := sources(map[string]string{"main.tex": "hello", "half": half}).send(t, handler); response.Code != 200 {
		t.Fatalf("half project: %d", response.Code)
	}
	grown := sources(map[string]string{"main.tex": "hello", "half": half, "other": half + "y"}).with(func(c *compileRequest) {
		c.blobs = map[string]string{hashSource(half + "y"): half + "y"}
		c.manifest.Incremental = true
	})
	if response := grown.send(t, handler); response.Code != 413 {
		t.Fatalf("oversized project: %d", response.Code)
	}
}

func TestCompileHTTP(t *testing.T) {
	handler, temp, _ := testEngine(t, 1)
	files := map[string]string{"src/-main.tex": "hello", "sections/hello.tex": "nested", "assets/data.bin": "\x00\x01\x02\xff"}
	response := sources(files).with(func(c *compileRequest) { c.manifest.MainFile = "src/-main.tex" }).send(t, handler)
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Type") != "application/x-tar" {
		t.Fatalf("compile failed: %d %s", response.Code, response.Body)
	}
	parsed := readResponse(t, response.Body)
	if parsed.order[0] != "output.pdf" || parsed.order[1] != "result.json" || parsed.result.PDF != "-main.pdf" {
		t.Fatalf("PDF and result must come first: %v", parsed.order)
	}
	if !bytes.Equal(parsed.entries["output.pdf"], append([]byte("%PDF-1.5\nhellonested"), 0, 1, 2, 255)) {
		t.Fatalf("source or asset changed: %q", parsed.entries["output.pdf"])
	}
	if parsed.result.Log != "transcript" || string(parsed.artifact(t, "-main.log")) != "transcript\n" {
		t.Fatalf("invalid log: %+v", parsed.result)
	}
	restored, err := unpackCache(bytes.NewReader(parsed.entries["cache.tar.zst"]))
	if err != nil || !reflect.DeepEqual(restored, map[string][]byte{"-main.aux": []byte("aux\n")}) {
		t.Fatalf("invalid cache archive: %v %v", restored, err)
	}
	assertOnlyBlobs(t, temp, "hello", "nested", "\x00\x01\x02\xff")
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
	handler, _, _ := testEngine(t, 1)
	response := &flushRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(response, source("hello").http(t, ""))
	if response.Code != 200 || len(response.flushedBodies) < 3 {
		t.Fatalf("missing flushes: %d %d", response.Code, len(response.flushedBodies))
	}
	if !strings.Contains(response.flushedBodies[0], "%PDF-1.5") || strings.Contains(response.flushedBodies[0], "result.json") {
		t.Fatalf("PDF was not flushed first: %q", response.flushedBodies[0])
	}
	if len(response.flushedBodies[0])%512 != 0 {
		t.Fatal("the flushed PDF entry was not padded")
	}
	if !strings.Contains(response.flushedBodies[1], "result.json") || strings.Contains(response.flushedBodies[1], "artifacts/") {
		t.Fatalf("log was not flushed before artifacts: %q", response.flushedBodies[1])
	}
	if strings.Contains(response.flushedBodies[2], "cache.tar.zst") {
		t.Fatal("artifacts waited for cache compression")
	}
}

func TestFailuresAndLimits(t *testing.T) {
	handler, temp, _ := testEngine(t, 1)
	for _, test := range []struct {
		input  string
		status int
		log    string
	}{{"bad", 422, "invalidcommand"}, {"large", 413, ""}, {"missing", 500, ""}, {"hello", 200, ""}} {
		response := source(test.input).send(t, handler)
		if response.Code != test.status {
			t.Fatalf("%s: %d %s", test.input, response.Code, response.Body)
		}
		if test.status == 422 {
			parsed := readResponse(t, response.Body)
			if parsed.result.Error != "LaTeX compilation failed" || !strings.Contains(parsed.result.Log, test.log) || string(parsed.artifact(t, "main.log")) != "invalidcommand\n" {
				t.Fatalf("failure lost its log: %+v", parsed)
			}
		}
		assertOnlyBlobs(t, temp, test.input)
	}
	response := source("logs").send(t, handler)
	if response.Code != 200 {
		t.Fatalf("log compile failed: %d", response.Code)
	}
	parsed := readResponse(t, response.Body)
	if len(parsed.result.Log) > 3*maxLogBytes+32 || !strings.Contains(parsed.result.Log, "START") || !strings.Contains(parsed.result.Log, "END") {
		t.Fatalf("diagnostic is unbounded or lost endpoints: %d bytes", len(parsed.result.Log))
	}
	if raw := parsed.artifact(t, "main.log"); len(raw) != 100008 {
		t.Fatalf("full generated log was truncated: %d", len(raw))
	}
}

func TestBusyTimeoutAndRecovery(t *testing.T) {
	handler, temp, marker := testEngine(t, 1)
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		first <- source("slow").with(func(c *compileRequest) { c.timeoutMs = 200 }).send(t, handler)
	}()
	waitForFile(t, marker)
	response := source("hello").send(t, handler)
	if response.Code != 503 || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("busy: %d %v", response.Code, response.Header())
	}
	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest("GET", "/health", nil))
	if health.Code != 200 {
		t.Fatalf("health blocked by compile: %d", health.Code)
	}
	timedOut := <-first
	if timedOut.Code != 408 || readResponse(t, timedOut.Body).result.Error != "Compilation timed out" {
		t.Fatalf("timeout: %d", timedOut.Code)
	}
	assertOnlyBlobs(t, temp, "slow")
	if response := source("hello").send(t, handler); response.Code != 200 {
		t.Fatalf("busy slot not released: %d", response.Code)
	}
}

func processGone(t *testing.T, marker string) {
	t.Helper()
	waitForFile(t, marker)
	deadline := time.Now().Add(2 * time.Second)
	for {
		raw, err := os.ReadFile(marker)
		if err != nil {
			t.Fatal(err)
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
		if err == nil {
			// A process whose parent has gone may stay a zombie until it is reaped.
			stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
			if err != nil || strings.Contains(string(stat), ") Z ") {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("a child of the compiler survived it")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestChildrenNeverOutliveACompile(t *testing.T) {
	handler, _, marker := testEngine(t, 1)
	started := time.Now()
	response := source("child").with(func(c *compileRequest) { c.timeoutMs = 200 }).send(t, handler)
	if response.Code != 408 || time.Since(started) > 5*time.Second {
		t.Fatalf("a child held up its compile: %d after %v", response.Code, time.Since(started))
	}
	processGone(t, marker)
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	if response := source("orphan").send(t, handler); response.Code != 200 {
		t.Fatalf("orphan: %d", response.Code)
	}
	processGone(t, marker)
}

func TestCompilesOutlastTheServerWriteTimeout(t *testing.T) {
	handler, _, _ := testEngine(t, 1)
	server := httptest.NewUnstartedServer(handler)
	server.Config.WriteTimeout = 50 * time.Millisecond
	server.Start()
	defer server.Close()
	request := source("slow").with(func(c *compileRequest) { c.timeoutMs = 300 }).http(t, server.URL)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 408 || readResponse(t, response.Body).result.Error != "Compilation timed out" {
		t.Fatalf("slow compile: %d", response.StatusCode)
	}
}

func TestProcessLimits(t *testing.T) {
	handler, _, _ := testEngine(t, 1)
	response := source("limits").send(t, handler)
	if response.Code != 200 {
		t.Fatalf("limits: %d", response.Code)
	}
	limits := strings.Fields(string(readResponse(t, response.Body).artifact(t, "limits.txt")))
	// ulimit reports KiB, and file sizes in blocks of 512 bytes or 1 KiB.
	if len(limits) != 3 || limits[0] != "1048576" || limits[1] != "131072" && limits[1] != "65536" || limits[2] != "0" {
		t.Fatalf("processes are not limited: %v", limits)
	}
	if response := source("huge").send(t, handler); response.Code != 422 {
		t.Fatalf("an oversized file was written: %d", response.Code)
	}
}

func TestCancellationsAreForgottenOldestFirst(t *testing.T) {
	c := &cancellations{ids: map[string]bool{}}
	for index := range maxCancellations + 1 {
		c.add(strconv.Itoa(index))
	}
	if c.take("0") || !c.take("1") || c.take("1") || !c.take(strconv.Itoa(maxCancellations)) {
		t.Fatal("cancellations were not forgotten oldest first")
	}
	c.add("1")
	c.add("1")
	if len(c.ids) != maxCancellations-1 || len(c.order) != len(c.ids) {
		t.Fatalf("cancellations leaked: %d ids, %d in order", len(c.ids), len(c.order))
	}
}

func TestCacheHoldsNoLogsOrOutputs(t *testing.T) {
	handler, _, _ := testEngine(t, 1)
	// Archives saved by earlier versions of the engine hold them too.
	archive, err := packCache(map[string][]byte{"main.aux": []byte("aux"), "main.log": []byte("stale"), "main.synctex.gz": []byte("stale")})
	if err != nil {
		t.Fatal(err)
	}
	response := source("stale").with(func(c *compileRequest) { c.cache = archive }).send(t, handler)
	if timing := responseTiming(t, response); timing.ArchiveStatus != "restored" {
		t.Fatalf("archive: %+v", timing)
	}
	if files := readResponse(t, response.Body).result.Files; response.Code != 422 || len(files) != 0 {
		t.Fatalf("a failure returned an earlier log: %d %v", response.Code, files)
	}
	response = source("outputs").send(t, handler)
	parsed := readResponse(t, response.Body)
	if !slices.Equal(parsed.result.Files, []string{"main.aux", "main.log", "main.synctex.gz"}) {
		t.Fatalf("artifacts: %v", parsed.result.Files)
	}
	restored, err := unpackCache(bytes.NewReader(parsed.entries["cache.tar.zst"]))
	if err != nil || !reflect.DeepEqual(restored, map[string][]byte{"main.aux": []byte("aux\n")}) {
		t.Fatalf("cache: %v %v", restored, err)
	}
	stale := source("stale").with(func(c *compileRequest) { c.manifest.Incremental = true })
	if files := readResponse(t, stale.send(t, handler).Body).result.Files; len(files) != 0 {
		t.Fatalf("an incremental failure returned an earlier log: %v", files)
	}
}

func TestCopiedSourcesAreNotArtifacts(t *testing.T) {
	handler, _, _ := testEngine(t, 1)
	response := sources(map[string]string{"main.tex": "copies", "refs.bib": "same", "notes.bib": "source"}).send(t, handler)
	parsed := readResponse(t, response.Body)
	if !slices.Equal(parsed.result.Files, []string{"notes.bib"}) || string(parsed.artifact(t, "notes.bib")) != "changed" {
		t.Fatalf("artifacts: %v", parsed.result.Files)
	}
}

func TestStageTiming(t *testing.T) {
	handler, _, _ := testEngine(t, 1)
	for i, content := range []string{"hello", "bad"} {
		response := source(content).send(t, handler)
		timing := responseTiming(t, response)
		expected := "cold"
		if i > 0 {
			expected = "warm"
		}
		if timing.Engine != "tectonic" || timing.Temperature != expected || timing.ContainerBootID == "" || timing.BootMs == nil {
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

func TestIncrementalRequestsSendOnlyChangedSources(t *testing.T) {
	handler, temp, _ := testEngine(t, 1)
	files := map[string]string{"main.tex": "first", "sections/hello.tex": "nested", "assets/data.bin": "\x00\x01\xff"}
	incremental := func(files map[string]string, changed ...string) compileRequest {
		return sources(files).with(func(c *compileRequest) {
			c.manifest.Incremental = true
			c.blobs = map[string]string{}
			for _, content := range changed {
				c.blobs[hashSource(content)] = content
			}
		})
	}
	response := incremental(files).send(t, handler)
	var failure struct {
		Code    string
		Missing []string
	}
	if response.Code != 409 || json.Unmarshal(response.Body.Bytes(), &failure) != nil || failure.Code != "resync" || len(failure.Missing) != 3 {
		t.Fatalf("a slot without sources did not ask for them: %d %s", response.Code, response.Body)
	}
	if response := sources(files).send(t, handler); response.Code != 200 {
		t.Fatalf("full request failed: %d %s", response.Code, response.Body)
	}
	files["main.tex"] = "second"
	response = incremental(files, "second").send(t, handler)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "secondnested\x00\x01\xff") {
		t.Fatalf("delta lost unchanged text or binary: %d %s", response.Code, response.Body)
	}
	assertOnlyBlobs(t, temp, "second", "nested", "\x00\x01\xff")
	// A rename and a duplicate reuse retained content.
	files["renamed.bin"], files["copy.bin"] = "\x00\x01\xff", "\x00\x01\xff"
	if response := incremental(files).send(t, handler); response.Code != 200 {
		t.Fatalf("hash-addressed rename failed: %d %s", response.Code, response.Body)
	}
	delete(files, "sections/hello.tex")
	if response := incremental(files).send(t, handler); response.Code != 200 || strings.Contains(response.Body.String(), "nested") {
		t.Fatalf("deletion not applied: %d", response.Code)
	}
	files["main.tex"] = "bad"
	if response := incremental(files, "bad").send(t, handler); response.Code != 422 {
		t.Fatalf("TeX failure: %d", response.Code)
	}
	if response := incremental(files).send(t, handler); response.Code != 422 {
		t.Fatalf("a TeX failure lost its sources: %d", response.Code)
	}
}

func TestRetainedSourcesCannotBeChanged(t *testing.T) {
	handler, temp, _ := testEngine(t, 1)
	tamper := source("tamper")
	if response := tamper.send(t, handler); response.Code != 200 && os.Geteuid() != 0 {
		t.Fatalf("TeX wrote to a retained source: %d %s", response.Code, response.Body)
	}
	if response := source("hello").send(t, handler); response.Code != 200 {
		t.Fatal(response.Code)
	}
	slots, _ := os.ReadDir(temp)
	path := filepath.Join(temp, slots[0].Name(), hashSource("hello"))
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("corrupted"), 0600); err != nil {
		t.Fatal(err)
	}
	incremental := source("hello").with(func(c *compileRequest) { c.manifest.Incremental, c.blobs = true, nil })
	if response := incremental.send(t, handler); response.Code != 409 {
		t.Fatalf("changed source was not detected: %d", response.Code)
	}
	response := source("hello").send(t, handler)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "%PDF-1.5\nhello") {
		t.Fatalf("a full request did not repair the source: %d", response.Code)
	}
}

func TestAnotherAffinityFindsNothing(t *testing.T) {
	handler, temp, _ := testEngine(t, 1)
	archive, err := packCache(map[string][]byte{"main.aux": []byte("cached aux")})
	if err != nil {
		t.Fatal(err)
	}
	first := sources(map[string]string{"main.tex": "cache", "secret.tex": "private-a"}).with(func(c *compileRequest) { c.cache = archive })
	if response := first.send(t, handler); response.Code != 200 {
		t.Fatal(response.Code, response.Body)
	}
	second := source("cache").with(func(c *compileRequest) {
		c.affinity, c.generation, c.manifest.Incremental = "b", 2, true
		c.blobs = nil
	})
	if response := second.send(t, handler); response.Code != 409 {
		t.Fatalf("another caller's sources survived: %d", response.Code)
	}
	assertOnlyBlobs(t, temp)
	second.blobs = source("cache").blobs
	if response := second.send(t, handler); response.Code != 422 {
		t.Fatalf("another caller's cache survived: %d", response.Code)
	}
	second.cache, second.manifest.Incremental = archive, false
	response := second.send(t, handler)
	if timing := responseTiming(t, response); response.Code != 200 || !timing.CacheUsed || timing.Temperature != "warm" || timing.ArchiveStatus != "restored" {
		t.Fatalf("the second caller did not restore its cache on the warm process: %d %+v", response.Code, timing)
	}
	if response := first.send(t, handler); response.Code != 409 || !strings.Contains(response.Body.String(), `"lease"`) {
		t.Fatalf("an ended lease compiled: %d %s", response.Code, response.Body)
	}
	assertOnlyBlobs(t, temp, "cache")
}

func TestSlotsAreIndependent(t *testing.T) {
	handler, _, marker := testEngine(t, 2)
	done := make(chan int, 1)
	go func() {
		done <- source("slow").with(func(c *compileRequest) { c.timeoutMs = 400 }).send(t, handler).Code
	}()
	waitForFile(t, marker)
	other := source("hello").with(func(c *compileRequest) { c.slot, c.affinity, c.id = 1, "b", "other" })
	if response := other.send(t, handler); response.Code != 200 {
		t.Fatalf("a busy slot blocked its neighbor: %d %s", response.Code, response.Body)
	}
	if code := <-done; code != 408 {
		t.Fatalf("a neighbor changed the running compile: %d", code)
	}
}

func TestCancellation(t *testing.T) {
	handler, temp, marker := testEngine(t, 1)
	server := httptest.NewServer(handler)
	defer server.Close()
	cancel := func(id string) {
		request, _ := http.NewRequest("DELETE", server.URL+"/compilations/"+id, nil)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != 204 {
			t.Fatalf("cancel: %d", response.StatusCode)
		}
	}
	slow := source("slow").with(func(c *compileRequest) { c.timeoutMs = 10_000 })
	finished := make(chan int, 1)
	go func() {
		response, err := http.DefaultClient.Do(slow.http(t, server.URL))
		if err != nil {
			t.Error(err)
			finished <- 0
			return
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		finished <- response.StatusCode
	}()
	waitForFile(t, marker)
	cancel("job")
	if code := <-finished; code != 409 {
		t.Fatalf("cancelled compile: %d", code)
	}
	assertOnlyBlobs(t, temp, "slow")
	// The same keep-alive connection stays usable.
	for range 2 {
		response, err := http.DefaultClient.Do(source("hello").http(t, server.URL))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("compile after a cancel: %d", response.StatusCode)
		}
	}
	// A cancel that overtakes its compile still wins.
	cancel("early")
	early := source("hello").with(func(c *compileRequest) { c.id = "early" })
	if response := early.send(t, handler); response.Code != 409 {
		t.Fatalf("early cancel lost: %d", response.Code)
	}
	if response := early.send(t, handler); response.Code != 200 {
		t.Fatalf("a cancel outlived its compile: %d", response.Code)
	}
}

func TestNewerLeaseStopsAnAbandonedCompile(t *testing.T) {
	handler, _, marker := testEngine(t, 1)
	finished := make(chan int, 1)
	go func() {
		finished <- source("slow").with(func(c *compileRequest) { c.timeoutMs = 10_000 }).send(t, handler).Code
	}()
	waitForFile(t, marker)
	next := source("hello").with(func(c *compileRequest) { c.id, c.affinity, c.generation = "next", "b", 2 })
	started := time.Now()
	if response := next.send(t, handler); response.Code != 200 {
		t.Fatalf("newer lease: %d %s", response.Code, response.Body)
	}
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Fatalf("newer lease waited for the abandoned compile: %v", elapsed)
	}
	if code := <-finished; code != 409 {
		t.Fatalf("abandoned compile: %d", code)
	}
}

func TestCancelUnblocksAnUnfinishedBody(t *testing.T) {
	handler, _, _ := testEngine(t, 1)
	server := httptest.NewServer(handler)
	defer server.Close()
	body, writer := io.Pipe()
	defer writer.Close()
	request := source("hello").http(t, server.URL)
	request.Body, request.ContentLength = body, -1
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	finished := make(chan int, 1)
	go func() {
		response, err := http.DefaultClient.Do(request.WithContext(ctx))
		if err != nil {
			finished <- 0
			return
		}
		_ = response.Body.Close()
		finished <- response.StatusCode
	}()
	if _, err := writer.Write(source("hello").archive(t)[:512]); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for handler.slots[0].running("job") == nil {
		if time.Now().After(deadline) {
			t.Fatal("compile did not start")
		}
		time.Sleep(time.Millisecond)
	}
	cancel, _ := http.NewRequest("DELETE", server.URL+"/compilations/job", nil)
	response, err := http.DefaultClient.Do(cancel)
	if err != nil || response.StatusCode != 204 {
		t.Fatal(err)
	}
	if ctx.Err() != nil {
		t.Fatal("cancel waited for the request body")
	}
	<-finished
}

func TestCacheArchiveFeedsCompilation(t *testing.T) {
	handler, _, _ := testEngine(t, 1)
	archive, err := packCache(map[string][]byte{"main.aux": []byte("cached aux")})
	if err != nil {
		t.Fatal(err)
	}
	corrupt := source("hello").with(func(c *compileRequest) { c.cache = []byte("corrupt") })
	response := corrupt.send(t, handler)
	if timing := responseTiming(t, response); response.Code != 200 || timing.ArchiveStatus != "invalid" || timing.CacheUsed {
		t.Fatalf("a corrupt cache must cost only a cold compile: %d %+v", response.Code, timing)
	}
	response = source("cache").with(func(c *compileRequest) { c.cache = archive }).send(t, handler)
	timing := responseTiming(t, response)
	if response.Code != 200 || timing.ArchiveStatus != "restored" || timing.ArchiveUnpackMs == nil || timing.ArchiveBytes != int64(len(archive)) {
		t.Fatalf("compile did not use restored aux: %d %+v", response.Code, timing)
	}
	parsed := readResponse(t, response.Body)
	restored, err := unpackCache(bytes.NewReader(parsed.entries["cache.tar.zst"]))
	if err != nil || !bytes.Equal(restored["custom/data.bin"], []byte{0, 1, 2, 255}) || !reflect.DeepEqual(restored["custom/data.bin"], parsed.artifact(t, "custom/data.bin")) {
		t.Fatalf("missing successful build archive: %v %v", restored, err)
	}
	incremental := source("cache").with(func(c *compileRequest) { c.manifest.Incremental, c.blobs = true, nil })
	response = incremental.send(t, handler)
	if timing := responseTiming(t, response); response.Code != 200 || timing.ArchiveStatus != "warm" || !timing.CacheUsed {
		t.Fatalf("warm compile did not reuse its cache: %d %+v", response.Code, timing)
	}
	clean := incremental.with(func(c *compileRequest) { c.manifest.Clean = true; c.cache = archive })
	if response := clean.send(t, handler); response.Code != 422 {
		t.Fatal("clean compilation did not bypass restored auxiliaries")
	}
	if response := incremental.send(t, handler); response.Code != 422 {
		t.Fatal("a clean compilation left the old cache behind")
	}
	// A full request trusts only the archive it carries.
	if response := source("cache").with(func(c *compileRequest) { c.cache = archive }).send(t, handler); response.Code != 200 {
		t.Fatal(response.Code)
	}
	if response := source("cache").send(t, handler); response.Code != 422 {
		t.Fatal("a full request reused a retained cache")
	}
}
