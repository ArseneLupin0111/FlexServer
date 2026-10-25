//go:build windows

package updater

import (
	"errors"
	"fmt"
	"os"
	"time"
)

// fsyncDir is a no-op on Windows: directory handles cannot be flushed there,
// and os.Rename already replaces atomically in the same volume. The Windows
// build exists for tests only; the deploy target is Linux.
func fsyncDir(dir string) error { return nil }

// lockFile is a portable O_EXCL fallback for the flock used on Linux. It is
// only exercised by tests on Windows.
type lockFile struct {
	path string
}

func acquireLock(path string) (*lockFile, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if errors.Is(err, os.ErrExist) {
		// Take over locks abandoned by a crashed process (test runs only).
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > 5*time.Second {
			_ = os.Remove(path)
			return acquireLock(path)
		}
		return nil, fmt.Errorf("lock %s: another updater instance is running", path)
	}
	if err != nil {
		return nil, fmt.Errorf("open lock: %w", err)
	}
	_ = f.Close()
	return &lockFile{path: path}, nil
}

func (l *lockFile) release() {
	if l == nil {
		return
	}
	_ = os.Remove(l.path)
}

// statIsRootOwned: Windows has no uid metadata (test-only build) — the
// ownership half of requireSecureDir is skipped there.
func statIsRootOwned(os.FileInfo) (bool, bool) { return false, false }

// fileUIDGID: Windows exposes no POSIX owner in this build (test-only) —
// ownership preservation is skipped there.
func fileUIDGID(os.FileInfo) (uid, gid int, ok bool) { return 0, 0, false }
