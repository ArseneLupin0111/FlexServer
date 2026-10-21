//go:build linux

package ai

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// verifyProfileOwnership validates that the profile file is root-owned (UID 0, GID 0)
// and not writable by group or others.
func verifyProfileOwnership(st os.FileInfo) error {
	var uid uint32
	switch sys := st.Sys().(type) {
	case *syscall.Stat_t:
		uid = sys.Uid
	case *unix.Stat_t:
		uid = sys.Uid
	default:
		return fmt.Errorf("unable to determine profile file ownership")
	}
	if uid != 0 {
		return fmt.Errorf("profile file is not root-owned (UID=%d)", uid)
	}
	if st.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("profile file is group or world writable (mode=0%o)", st.Mode().Perm())
	}
	return nil
}
