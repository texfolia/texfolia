package main

import "time"

type engineTiming struct {
	Engine      string   `json:"engine"`
	Temperature string   `json:"temperature"`
	InputPrepMs *float64 `json:"inputPrepMs"`
	CompileMs   *float64 `json:"compileMs"`
	OutputMs    *float64 `json:"outputMs"`
}

func elapsedMs(start time.Time) *float64 {
	value := float64(time.Since(start)) / float64(time.Millisecond)
	return &value
}
