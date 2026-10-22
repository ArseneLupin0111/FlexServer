//go:build linux

package applications

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func openRegistryFile(path string, flag int, perm os.FileMode) (*os.File, error) {
	fi, err := os.Lstat(path)
	if err == nil && (fi.Mode()&os.ModeSymlink != 0) {
		return nil, fmt.Errorf("applications: symlink not allowed for exclusion registry: %s", path)
	}
	return os.OpenFile(path, flag|unix.O_NOFOLLOW, perm)
}

func acquireProcessFileLock(path string) (func(), error) {
	lockPath := path + ".lock"
	f, err := openRegistryFile(lockPath, os.O_CREATE|os.O_RDWR, 0o664)
	if err != nil {
		return nil, fmt.Errorf("applications: open exclusion lock: %w", err)
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("applications: acquire exclusion lock: %w", err)
	}
	return func() {
		_ = unix.Flock(int(f.Fd()), unix.LOCK_UN)
		_ = f.Close()
	}, nil
}
