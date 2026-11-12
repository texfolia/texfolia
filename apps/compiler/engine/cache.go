package main

import (
	"archive/tar"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/klauspost/compress/zstd"
)

const maxCacheArchiveBytes = maxArtifactBytes + 1024*1024
const maxCacheFiles = 1024

func unpackCache(input io.Reader) (map[string][]byte, error) {
	decoder, err := zstd.NewReader(input, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(64*1024*1024))
	if err != nil {
		return nil, err
	}
	defer decoder.Close()
	decoded := &io.LimitedReader{R: decoder, N: maxArtifactBytes + maxCacheFiles*4096 + 1024 + 1}
	reader := tar.NewReader(decoded)
	files := make(map[string][]byte)
	var size int64
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			if _, err := io.Copy(io.Discard, decoded); err != nil {
				return nil, err
			}
			if decoded.N == 0 {
				return nil, errors.New("expanded cache archive exceeds limit")
			}
			if len(files) == 0 {
				return nil, errors.New("empty cache archive")
			}
			return files, nil
		}
		if err != nil {
			return nil, err
		}
		size += header.Size
		if header.Typeflag != tar.TypeReg || !validPath(header.Name) || header.Size < 0 || size > maxArtifactBytes || len(files) >= maxCacheFiles {
			return nil, errors.New("invalid cache archive entry")
		}
		if _, exists := files[header.Name]; exists {
			return nil, errors.New("duplicate cache archive entry")
		}
		for path := range files {
			if strings.HasPrefix(path, header.Name+"/") || strings.HasPrefix(header.Name, path+"/") {
				return nil, errors.New("conflicting cache archive entries")
			}
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			return nil, err
		}
		files[header.Name] = content
	}
}

func packCache(files map[string][]byte) ([]byte, error) {
	if len(files) > maxCacheFiles {
		return nil, errors.New("too many cache archive entries")
	}
	var output bytes.Buffer
	encoder, err := zstd.NewWriter(&output, zstd.WithEncoderConcurrency(1), zstd.WithEncoderLevel(zstd.SpeedFastest))
	if err != nil {
		return nil, err
	}
	archive := tar.NewWriter(encoder)
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		content := files[path]
		if err = archive.WriteHeader(&tar.Header{Name: path, Mode: 0600, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			break
		}
		if _, err = archive.Write(content); err != nil {
			break
		}
	}
	archiveErr := archive.Close()
	encodeErr := encoder.Close()
	if err != nil {
		return nil, err
	}
	if archiveErr != nil {
		return nil, archiveErr
	}
	if encodeErr != nil {
		return nil, encodeErr
	}
	if output.Len() > maxCacheArchiveBytes {
		return nil, errors.New("cache archive exceeds limit")
	}
	return output.Bytes(), nil
}

func resultCache(result *result) (map[string][]byte, error) {
	files := make(map[string][]byte)
	for _, path := range result.artifacts {
		if path == filepath.Base(result.pdf.Name()) {
			continue
		}
		content, err := os.ReadFile(filepath.Join(result.root, "source", "out", filepath.FromSlash(path)))
		if err != nil {
			return nil, err
		}
		files[path] = content
	}
	return files, nil
}
