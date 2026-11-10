package main

import (
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
	pdf  *os.File
	log  string
	root string
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

func compile(ctx context.Context, p project, timeout time.Duration, timing *engineTiming) (_ *result, err error) {
	prepStart := time.Now()
	defer func() {
		if timing.InputPrepMs == nil {
			timing.InputPrepMs = elapsedMs(prepStart)
		}
	}()
	root, err := os.MkdirTemp("", "texfolia-")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(root)
		}
	}()
	source, output := filepath.Join(root, "source"), filepath.Join(root, "output")
	if err = os.Mkdir(output, 0700); err != nil {
		return nil, err
	}
	for path, content := range p.files {
		target := filepath.Join(source, path)
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return nil, err
		}
		if err = os.WriteFile(target, content, 0600); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tectonic", "--untrusted", "--keep-logs", "--outdir", output, "./"+p.mainFile)
	cmd.Dir = source
	cmd.Env = []string{"TECTONIC_UNTRUSTED_MODE=1"}
	for _, key := range []string{"PATH", "HOME", "XDG_CACHE_HOME"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	stdout, stderr := &limitedLog{}, &limitedLog{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = time.Second
	timing.InputPrepMs = elapsedMs(prepStart)
	compileStart := time.Now()
	runErr := cmd.Run()
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
	if ctx.Err() != nil {
		return nil, &httpError{status: 408, message: "Compilation timed out", log: log}
	}
	if runErr != nil {
		var exit *exec.ExitError
		if errors.As(runErr, &exit) {
			return nil, &httpError{status: 422, message: "LaTeX compilation failed", log: log}
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
	return &result{pdf: pdf, log: log, root: root}, nil
}
