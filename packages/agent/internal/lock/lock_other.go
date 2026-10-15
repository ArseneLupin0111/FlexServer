//go:build !linux && !windows

package lock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func acquireOS(path string, o options) (*os.File, error) {
	parentDir := filepath.Dir(path)
	if err := os.MkdirAll(parentDir, 0o755); err != nil {
		return nil, fmt.Errorf("create lock directory %s: %w", parentDir, err)
	}

	flags := os.O_CREATE | os.O_RDWR | syscall.O_CLOEXEC
	f, err := os.OpenFile(path, flags, 0o666)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			f, err = os.OpenFile(path, os.O_RDONLY|syscall.O_CLOEXEC, 0)
		}
		if err != nil {
			return nil, fmt.Errorf("open lock file %s: %w", path, err)
		}
	}

	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("stat lock file %s: %w", path, err)
	}
	if !fi.Mode().IsRegular() {
		_ = f.Close()
		return nil, fmt.Errorf("lock target %s is not a regular file", path)
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, fmt.Errorf("%w (lock held at %s)", ErrAlreadyRunning, path)
		}
		return nil, fmt.Errorf("flock %s: %w", path, err)
	}

	return f, nil
}

func releaseOS(f *os.File) error {
	if f == nil {
		return nil
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return f.Close()
}
