//go:build !linux

package ai

import "os"

// syncDir is best-effort on non-Linux platforms: directory-handle fsync is a
// Windows filesystem limitation that fails with "Access is denied", not a
// use-case defect. Linux still goes through the strict implementation above;
// tests and dev-run agents elsewhere keep the CAS/backup semantics intact.
func syncDir(path string) error {
	dirF, err := os.Open(path)
	if err != nil {
		return err
	}
	_ = dirF.Sync()
	return dirF.Close()
}
