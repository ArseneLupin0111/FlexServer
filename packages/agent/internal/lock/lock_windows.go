//go:build windows

package lock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	kernel32        = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx   = kernel32.NewProc("LockFileEx")
	procUnlockFileEx = kernel32.NewProc("UnlockFileEx")
)

const (
	lockfileFailImmediately = 0x00000001
	lockfileExclusiveLock   = 0x00000002
	errLockViolation        = syscall.Errno(33) // ERROR_LOCK_VIOLATION
)

func acquireOS(path string, o options) (*os.File, error) {
	parentDir := filepath.Dir(path)
	if err := os.MkdirAll(parentDir, 0o755); err != nil {
		return nil, fmt.Errorf("create lock directory %s: %w", parentDir, err)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o666)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			f, err = os.OpenFile(path, os.O_RDONLY, 0)
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

	var ol syscall.Overlapped
	r1, _, callErr := procLockFileEx.Call(
		f.Fd(),
		uintptr(lockfileFailImmediately|lockfileExclusiveLock),
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&ol)),
	)
	if r1 == 0 {
		_ = f.Close()
		if errors.Is(callErr, errLockViolation) || callErr != nil {
			return nil, fmt.Errorf("%w (lock held at %s): %v", ErrAlreadyRunning, path, callErr)
		}
		return nil, fmt.Errorf("lock file %s: %w", path, callErr)
	}

	return f, nil
}

func releaseOS(f *os.File) error {
	if f == nil {
		return nil
	}
	var ol syscall.Overlapped
	_, _, _ = procUnlockFileEx.Call(
		f.Fd(),
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&ol)),
	)
	return f.Close()
}
