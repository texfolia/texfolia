package main

import "time"

type engineTiming struct {
	Engine          string   `json:"engine"`
	Temperature     string   `json:"temperature"`
	InputPrepMs     *float64 `json:"inputPrepMs"`
	CompileMs       *float64 `json:"compileMs"`
	OutputMs        *float64 `json:"outputMs"`
	CacheUsed       bool     `json:"cacheUsed"`
	ContainerBootID string   `json:"containerBootId,omitempty"`
	BootMs          *float64 `json:"bootMs,omitempty"`
	ImageSizeBytes  *int64   `json:"imageSizeBytes,omitempty"`
	ArchiveStatus   string   `json:"archiveStatus,omitempty"`
	ArchiveUnpackMs *float64 `json:"archiveUnpackMs,omitempty"`
	ArchiveBytes    int64    `json:"archiveBytes,omitempty"`
}

func elapsedMs(start time.Time) *float64 {
	value := float64(time.Since(start)) / float64(time.Millisecond)
	return &value
}
