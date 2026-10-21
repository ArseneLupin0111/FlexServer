//go:build !linux

package applications

import (
	"fmt"
	"os"
	"strings"
)

// statLinux mirrors the anchored identity bundle on non-linux platforms.
type statLinux struct{ dev, ino uint64 }

// secureOpenNoFollow fails closed on unsupported platforms: no anchored
// open primitive exists here, so external source verification is refused
// rather than best-effort.
func secureOpenNoFollow(path string) (*os.File, error) {
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\x00") {
		return nil, fmt.Errorf("invalid_source_path")
	}
	return nil, fmt.Errorf("unsafe_open_unsupported")
}

func fstatLinux(f *os.File) (statLinux, error) {
	if f == nil {
		return statLinux{}, fmt.Errorf("unsafe_source_identity")
	}
	return statLinux{}, fmt.Errorf("unsafe_open_unsupported")
}

// modeOwnerWritable rejects group/world-readable files everywhere.
func modeOwnerWritable(fi os.FileInfo) bool {
	m := fi.Mode().Perm()
	return m&0o077 == 0
}
