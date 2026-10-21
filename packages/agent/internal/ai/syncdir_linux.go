//go:build linux

package ai

import (
	"fmt"
	"os"
)

// syncDir fsyncs a directory by file descriptor so a completed rename survives
// an immediate power loss. On Linux the open directory fd is the only portable
// way to do this, and every durable mutation path relies on it: failure is a
// hard error, never a warning.
func syncDir(path string) error {
	dirF, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("opening backups directory for sync: %w", err)
	}
	if err := dirF.Sync(); err != nil {
		dirF.Close()
		return err
	}
	return dirF.Close()
}
