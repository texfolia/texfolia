package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func leaseRequest(handler http.Handler, method, path, token, project string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.Header.Set("X-Container-Lease", token)
	r.Header.Set("X-Project-Id", project)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestLeaseHandoffWipesSourcesCacheAndTemporaryFiles(t *testing.T) {
	handler, temp, _ := testEngine(t, time.Second)
	if w := leaseRequest(handler, "PUT", "/lease", "1:a", "a", nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body)
	}
	archive, err := packCache(map[string][]byte{"main.aux": []byte("cached aux")})
	if err != nil {
		t.Fatal(err)
	}
	if w := leaseRequest(handler, "PUT", "/cache", "1:a", "a", archive); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	delta := sourceDelta{MainFile: "main.tex", Revision: 1, Resync: true, Files: map[string]sourceFile{
		"main.tex":           deltaFile(t, "private-a"),
		"sections/hello.tex": deltaFile(t, "secret-a"),
		"assets/data.bin":    deltaFile(t, "private-binary"),
	}}
	if w := leaseRequest(handler, "POST", "/compile", "1:a", "a", deltaJSON(t, delta)); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if w := leaseRequest(handler, "PUT", "/lease", "2:b", "b", nil); w.Code != 409 {
		t.Fatal("overlapping lease accepted", w.Code)
	}
	if w := leaseRequest(handler, "DELETE", "/lease", "1:a", "", nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body)
	}
	assertClean(t, temp)
	if w := leaseRequest(handler, "PUT", "/lease", "1:a", "a", nil); w.Code != 409 {
		t.Fatal("retired lease accepted", w.Code)
	}
	if w := leaseRequest(handler, "PUT", "/lease", "2:b", "b", nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body)
	}
	for _, route := range []struct{ method, path string }{{"PUT", "/cache"}, {"POST", "/compile"}, {"DELETE", "/compilations/new"}, {"DELETE", "/lease"}} {
		if w := leaseRequest(handler, route.method, route.path, "1:a", "a", archive); w.Code != 409 {
			t.Fatalf("stale lease reached %s: %d", route.path, w.Code)
		}
	}
	// Neither A's source revision nor its cached auxiliary is available to B.
	missing := sourceDelta{MainFile: "main.tex", BaseRevision: 1, Revision: 2}
	if w := leaseRequest(handler, "POST", "/compile", "2:b", "b", deltaJSON(t, missing)); w.Code != 409 || w.Header().Get("X-Source-Resync") != "1" {
		t.Fatal("previous source manifest survived", w.Code, w.Body)
	}
	if w := leaseRequest(handler, "POST", "/compile", "2:b", "b", []byte(`{"files":{"main.tex":"cache"}}`)); w.Code != 422 {
		t.Fatal("previous cache survived", w.Code, w.Body)
	}
	if w := leaseRequest(handler, "PUT", "/cache", "2:b", "b", archive); w.Code != 200 {
		t.Fatal("B could not restore its archive", w.Code, w.Body)
	}
	w := leaseRequest(handler, "POST", "/compile", "2:b", "b", []byte(`{"files":{"main.tex":"cache"}}`))
	var timing engineTiming
	if w.Code != 200 || json.Unmarshal([]byte(w.Header().Get("X-Compile-Timing")), &timing) != nil || !timing.CacheUsed || timing.Temperature != "warm" {
		t.Fatal("B did not compile on the warm process with its restored cache", w.Code, w.Body)
	}
	if w := leaseRequest(handler, "DELETE", "/lease", "2:b", "", nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body)
	}
	assertClean(t, temp)
}

func TestReleaseFencesDelayedAcquire(t *testing.T) {
	handler, temp, _ := testEngine(t, time.Second)
	if w := leaseRequest(handler, "DELETE", "/lease", "1:delayed", "", nil); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := leaseRequest(handler, "PUT", "/lease", "1:delayed", "a", nil); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w := leaseRequest(handler, "PUT", "/lease", "2:current", "b", nil); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := leaseRequest(handler, "DELETE", "/lease", "2:current", "", nil); w.Code != 204 {
		t.Fatal(w.Code)
	}
	assertClean(t, temp)
}

func TestLeaseReleaseCancelsAndWaitsForActiveCompile(t *testing.T) {
	handler, temp, marker := testEngine(t, 10*time.Second)
	if w := leaseRequest(handler, "PUT", "/lease", "1:a", "a", nil); w.Code != 204 {
		t.Fatal(w.Code)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		r, _ := http.NewRequest("POST", server.URL+"/compile", strings.NewReader(`{"files":{"main.tex":"slow"}}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Container-Lease", "1:a")
		r.Header.Set("X-Project-Id", "a")
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Error(err)
			return
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
	}()
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("compile did not start")
		}
		time.Sleep(time.Millisecond)
	}
	if w := leaseRequest(handler, "DELETE", "/lease", "1:a", "", nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body)
	}
	<-finished
	assertClean(t, temp)
	if w := leaseRequest(handler, "PUT", "/lease", "2:b", "b", nil); w.Code != 204 {
		t.Fatal(w.Code, w.Body)
	}
	if w := leaseRequest(handler, "POST", "/compile", "2:b", "b", []byte(`{"files":{"main.tex":"next"}}`)); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
}
