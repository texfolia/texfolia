package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

func renderPreview(ctx context.Context, pdfPath string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	prefix := filepath.Join(filepath.Dir(pdfPath), "template-preview")
	command := exec.CommandContext(ctx, "pdftoppm", "-f", "1", "-singlefile", "-scale-to", "1200", "-png", pdfPath, prefix)
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("render template preview: %w", err)
	}
	path := prefix + ".png"
	defer os.Remove(path)
	stat, err := os.Stat(path)
	if err != nil || stat.Size() > 4*1024*1024 {
		return nil, fmt.Errorf("invalid template preview size")
	}
	return os.ReadFile(path)
}
