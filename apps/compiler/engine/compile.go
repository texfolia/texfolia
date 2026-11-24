package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxLogBytes = 64 * 1024
	maxPDFBytes = 20 * 1024 * 1024
)

type limitedLog struct{ data []byte }

func (l *limitedLog) Write(p []byte) (int, error) {
	n := len(p)
	l.data = append(l.data, p[:min(len(p), maxLogBytes-len(l.data))]...)
	return n, nil
}

type result struct {
	pdf       *os.File
	log       string
	root      string
	artifacts []string
}

func (r *result) close() {
	_ = r.pdf.Close()
	_ = os.RemoveAll(r.root)
}

func transcript(path string) (string, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return "", err
	}
	if stat.Size() <= maxLogBytes {
		data, err := io.ReadAll(io.LimitReader(file, maxLogBytes))
		return string(data), err
	}
	head, err := io.ReadAll(io.LimitReader(file, maxLogBytes/2))
	if err != nil {
		return "", err
	}
	if _, err := file.Seek(-maxLogBytes/2, io.SeekEnd); err != nil {
		return "", err
	}
	tail, err := io.ReadAll(io.LimitReader(file, maxLogBytes/2))
	return string(head) + "\n…\n" + string(tail), err
}

func sameContent(source, output string) bool {
	expected, err := os.ReadFile(source)
	if err != nil {
		return false
	}
	actual, err := os.ReadFile(output)
	return err == nil && bytes.Equal(expected, actual)
}

func compile(ctx context.Context, p project, timeout time.Duration, timing *engineTiming, tempDir string) (_ *result, err error) {
	prepStart := time.Now()
	defer func() {
		if timing.InputPrepMs == nil {
			timing.InputPrepMs = elapsedMs(prepStart)
		}
	}()
	root, err := os.MkdirTemp(tempDir, "texfolia-")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(root)
		}
	}()
	source := filepath.Join(root, "source")
	output := filepath.Join(source, "out")
	if err = os.MkdirAll(output, 0700); err != nil {
		return nil, err
	}
	for path, content := range p.cache {
		target := filepath.Join(output, path)
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return nil, err
		}
		if err = os.WriteFile(target, content, 0600); err != nil {
			return nil, err
		}
	}
	// Tectonic reads auxiliaries beside its input independently of --outdir.
	// Restore the complete cache there too, with real source paths taking priority.
	primary := filepath.Join(source, filepath.Dir(p.mainFile))
	bases := []string{primary}
	if primary != source {
		bases = append(bases, filepath.Join(primary, "out"))
	}
	for path, content := range p.cache {
		for _, base := range bases {
			if base == primary && (path == "out" || strings.HasPrefix(path, "out/")) {
				continue
			}
			relative, relErr := filepath.Rel(source, filepath.Join(base, path))
			if relErr != nil {
				return nil, relErr
			}
			conflict := false
			for input := range p.files {
				if input == relative || strings.HasPrefix(input, relative+"/") || strings.HasPrefix(relative, input+"/") {
					conflict = true
					break
				}
			}
			if conflict || relative == "out" || strings.HasPrefix(relative, "out/") {
				continue
			}
			target := filepath.Join(source, relative)
			if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return nil, err
			}
			if err = os.WriteFile(target, content, 0600); err != nil {
				return nil, err
			}
		}
	}
	for path, blob := range p.files {
		target := filepath.Join(source, path)
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return nil, err
		}
		if err = os.Link(blob, target); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	temporary := filepath.Join(root, "tmp")
	if err = os.Mkdir(temporary, 0700); err != nil {
		return nil, err
	}
	cmd := limitedCommand(ctx, "tectonic", "--untrusted", "--keep-logs", "--outdir", output, "./"+p.mainFile, "--keep-intermediates", "--synctex")
	cmd.Dir = source
	cmd.Env = []string{"TECTONIC_UNTRUSTED_MODE=1", "TMPDIR=" + temporary}
	for _, key := range []string{"PATH", "HOME", "XDG_CACHE_HOME"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	stdout, stderr := &limitedLog{}, &limitedLog{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	timing.InputPrepMs = elapsedMs(prepStart)
	compileStart := time.Now()
	runErr := runLimited(cmd)
	timing.CompileMs = elapsedMs(compileStart)
	outputStart := time.Now()
	defer func() { timing.OutputMs = elapsedMs(outputStart) }()
	name := strings.TrimSuffix(filepath.Base(p.mainFile), ".tex")
	texLog, err := transcript(filepath.Join(output, name+".log"))
	if err != nil {
		return nil, err
	}
	var logs []string
	for _, log := range []string{string(stdout.data), string(stderr.data), texLog} {
		if log != "" {
			logs = append(logs, log)
		}
	}
	log := strings.ToValidUTF8(strings.TrimSpace(strings.Join(logs, "\n")), "�")
	failureLog := func() *logArtifact {
		file, readErr := os.Open(filepath.Join(output, name+".log"))
		if readErr != nil {
			return nil
		}
		defer file.Close()
		raw, readErr := io.ReadAll(io.LimitReader(file, maxArtifactBytes+1))
		if readErr != nil || len(raw) > maxArtifactBytes {
			return nil
		}
		return &logArtifact{path: name + ".log", content: raw}
	}
	if ctx.Err() != nil {
		return nil, &httpError{status: 408, message: "Compilation timed out", log: log, logFile: failureLog()}
	}
	if runErr != nil {
		var exit *exec.ExitError
		if errors.As(runErr, &exit) {
			return nil, &httpError{status: 422, message: "LaTeX compilation failed", log: log, logFile: failureLog()}
		}
		return nil, runErr
	}
	pdf, err := os.Open(filepath.Join(output, name+".pdf"))
	if err != nil {
		return nil, err
	}
	stat, err := pdf.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxPDFBytes {
		_ = pdf.Close()
		if err != nil {
			return nil, err
		}
		if stat.Size() > maxPDFBytes {
			return nil, &httpError{status: 413, message: "PDF exceeds 20 MiB"}
		}
		return nil, errors.New("Tectonic produced an invalid PDF file")
	}
	artifacts := []string{}
	var artifactBytes int64
	err = filepath.WalkDir(output, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("TeX produced a non-regular output file")
		}
		name, err := filepath.Rel(output, path)
		if err != nil || !validPath(filepath.ToSlash(name)) {
			return errors.New("TeX produced an invalid output path")
		}
		// Tectonic also writes out the sources it passed to biber. In a cache, such
		// a copy would outlive the source.
		blob := p.files[filepath.ToSlash(filepath.Join(filepath.Dir(p.mainFile), name))]
		if blob != "" && sameContent(blob, path) {
			return nil
		}
		artifactBytes += info.Size()
		if artifactBytes > maxArtifactBytes {
			return &httpError{status: 413, message: "Build output exceeds 32 MiB"}
		}
		artifacts = append(artifacts, filepath.ToSlash(name))
		return nil
	})
	if err != nil {
		_ = pdf.Close()
		return nil, err
	}
	return &result{pdf: pdf, log: log, root: root, artifacts: artifacts}, nil
}
