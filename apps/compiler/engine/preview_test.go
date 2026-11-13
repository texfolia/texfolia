package main

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRenderPreview(t *testing.T) {
	if _, err := exec.LookPath("pdftoppm"); err != nil {
		t.Skip("pdftoppm is required for the real preview rendering check")
	}
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for index, object := range []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R >>",
		"<< /Length 0 >>\nstream\n\nendstream",
	} {
		offsets = append(offsets, pdf.Len())
		fmt.Fprintf(&pdf, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xref := pdf.Len()
	fmt.Fprintf(&pdf, "xref\n0 5\n0000000000 65535 f \n")
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&pdf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&pdf, "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	path := filepath.Join(t.TempDir(), "paper.pdf")
	if err := os.WriteFile(path, pdf.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	preview, err := renderPreview(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	image, err := png.Decode(bytes.NewReader(preview))
	if err != nil || image.Bounds().Dx() != 900 || image.Bounds().Dy() != 1200 {
		t.Fatalf("wrong first-page PNG: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := renderPreview(ctx, path); err == nil {
		t.Fatal("cancelled rendering succeeded")
	}
}
