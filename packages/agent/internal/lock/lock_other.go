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

func provisionOS(vpsId string, o options) error {
	dir := o.dir
	if dir == "" {
		dir = filepath.Clean(os.TempDir())
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create lock directory %s: %w", dir, err)
	}
	lockPath := filepath.Join(dir, LockFilename(vpsId))
	if _, err := os.Stat(lockPath); errors.Is(err, os.ErrNotExist) {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o666)
		if err != nil && !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("create lock file %s: %w", lockPath, err)
		}
		if f != nil {
			_ = f.Close()
		}
	}
	if o.tmpfilesDir != nil && *o.tmpfilesDir != "" {
		if err := os.MkdirAll(*o.tmpfilesDir, 0o755); err != nil {
			return fmt.Errorf("create tmpfiles directory %s: %w", *o.tmpfilesDir, err)
		}
		confPath := filepath.Join(*o.tmpfilesDir, TmpfilesDefaultConf)
		content := fmt.Sprintf("d %s 0755 root root -\nf %s 0666 root root -\n", dir, lockPath)
		if err := os.WriteFile(confPath, []byte(content), 0o644); err != nil {
			return fmt.Errorf("write tmpfiles configuration %s: %w", confPath, err)
		}
	}
	return nil
}
