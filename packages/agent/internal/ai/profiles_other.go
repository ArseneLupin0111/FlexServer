//go:build !linux

package ai

import (
	"os"
)

// verifyProfileOwnership is a no-op on non-Linux platforms for development/testing.
func verifyProfileOwnership(st os.FileInfo) error {
	return nil
}
