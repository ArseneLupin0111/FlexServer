//go:build !windows

package updater

import (
	"fmt"
	"os"
	"syscall"
)

// fsyncDir fsyncs a directory so renames inside it become durable.
func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open dir for fsync: %w", err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("fsync dir: %w", err)
	}
	return nil
}

// lockFile holds an flock for the lifetime of the daemon/helper run. The
// kernel releases it automatically when the process dies, so a crash can
// never leave a stale lock behind.
type lockFile struct {
	f *os.File
}

func acquireLock(path string) (*lockFile, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("lock %s: another updater instance is running: %w", path, err)
	}
	return &lockFile{f: f}, nil
}

func (l *lockFile) release() {
	if l == nil || l.f == nil {
		return
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	_ = l.f.Close()
}

// statIsRootOwned reports whether fi describes a uid-0 file; ok=false when
// the platform exposes no uid metadata (caller skips the ownership check).
func statIsRootOwned(fi os.FileInfo) (bool, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return false, false
	}
	return st.Uid == 0, true
}

// fileUIDGID returns the numeric owner of fi; ok=false when the platform
// exposes no uid metadata (caller skips ownership preservation).
func fileUIDGID(fi os.FileInfo) (uid, gid int, ok bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(st.Uid), int(st.Gid), true
}
