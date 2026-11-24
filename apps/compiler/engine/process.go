package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

const (
	// Address space, of which Tectonic reserves about half before it starts.
	maxProcessBytes = 1024 * 1024 * 1024
	// Every accepted output is smaller, and so is every file of the TeX bundle.
	maxFileBytes = 64 * 1024 * 1024
)

var processLimits = map[int]uint64{
	syscall.RLIMIT_AS:    maxProcessBytes,
	syscall.RLIMIT_FSIZE: maxFileBytes,
	syscall.RLIMIT_CORE:  0,
}

// limitedCommand is a command for untrusted input. It leads a process group, so
// that stopping it also stops what it started.
func limitedCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return killGroup(cmd.Process.Pid) }
	cmd.WaitDelay = time.Second
	return cmd
}

// runLimited runs a limitedCommand. Go cannot set limits between fork and exec,
// so they are set as soon as the process exists: before it can have read any
// input, and before it can have started a child that would not inherit them.
func runLimited(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	var limitErr error
	for resource, limit := range processLimits {
		if err := limitProcess(cmd.Process.Pid, resource, limit); err != nil && !errors.Is(err, syscall.ESRCH) {
			limitErr = err
			_ = killGroup(cmd.Process.Pid)
		}
	}
	err := cmd.Wait()
	// Nothing a command started may outlive it.
	_ = killGroup(cmd.Process.Pid)
	if limitErr != nil {
		return os.NewSyscallError("prlimit", limitErr)
	}
	return err
}

func killGroup(pid int) error {
	err := syscall.Kill(-pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}

func limitProcess(pid, resource int, limit uint64) error {
	value := syscall.Rlimit{Cur: limit, Max: limit}
	_, _, errno := syscall.RawSyscall6(syscall.SYS_PRLIMIT64, uintptr(pid), uintptr(resource), uintptr(unsafe.Pointer(&value)), 0, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}
