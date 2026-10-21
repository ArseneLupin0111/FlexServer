//go:build linux

package applications

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// statLinux is the anchored identity bundle.
type statLinux struct{ dev, ino uint64 }

// secureOpenNoFollow opens `path` without ever traversing a symlink:
// every ancestor is opened O_DIRECTORY|O_NOFOLLOW and stat'ed, then the
// final component is opened with O_NOFOLLOW as well. A mixed leading path
// that is not absolute fails closed.
func secureOpenNoFollow(path string) (*os.File, error) {
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\x00") {
		return nil, fmt.Errorf("invalid_source_path")
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) == 0 {
		return nil, fmt.Errorf("invalid_source_path")
	}
	// Open the root dir then walk each component O_NOFOLLOW.
	dir, err := os.OpenFile("/", os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("unsafe_source_path")
	}
	defer func() { _ = dir.Close() }()
	for _, part := range parts[:len(parts)-1] {
		if part == "" || part == "." || part == ".." || part == "~" {
			return nil, fmt.Errorf("invalid_source_path")
		}
		next, err := openAtNoFollow(dir, part, true)
		if err != nil {
			return nil, fmt.Errorf("unsafe_source_path")
		}
		_ = dir.Close()
		dir = next
		st, serr := fstatLinux(dir)
		if serr != nil {
			_ = dir.Close()
			return nil, fmt.Errorf("unsafe_source_identity")
		}
		_ = st
	}
	last := parts[len(parts)-1]
	if last == "" || last == "." || last == ".." {
		return nil, fmt.Errorf("invalid_source_path")
	}
	return openAtNoFollow(dir, last, false)
}

// openAtNoFollow resolves `name` inside `parent` without following links.
// The final component is opened O_RDONLY|O_NONBLOCK so a FIFO cannot block
// the open; ReadSource still rejects every non-regular component.
func openAtNoFollow(parent *os.File, name string, isDir bool) (*os.File, error) {
	flag := syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	if isDir {
		flag |= syscall.O_DIRECTORY
	} else {
		flag |= syscall.O_NONBLOCK
	}
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return nil, err
	}
	fd, _, errno := syscall.Syscall6(syscall.SYS_OPENAT, parent.Fd(), uintptr(unsafe.Pointer(p)), uintptr(flag), 0, 0, 0)
	if errno != 0 {
		return nil, fmt.Errorf("unsafe_source_path")
	}
	f := os.NewFile(uintptr(fd), name)
	if !isDir {
		// Restore blocking semantics for regular files.
		if err := syscall.SetNonblock(int(f.Fd()), false); err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("unsafe_source_path")
		}
	}
	return f, nil
}

// fstatLinux reads an anchored identity from an open file.
func fstatLinux(f *os.File) (statLinux, error) {
	var s syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &s); err != nil {
		return statLinux{}, fmt.Errorf("unsafe_source_identity")
	}
	return statLinux{dev: uint64(s.Dev), ino: uint64(s.Ino)}, nil
}

// modeOwnerWritable accepts only owner-controlled permissions: a file
// owned by the current UID with no group/world read/write at all.
func modeOwnerWritable(fi os.FileInfo) bool {
	if st, ok := fi.Sys().(*syscall.Stat_t); !ok || uint64(st.Uid) != uint64(os.Geteuid()) {
		return false
	}
	m := fi.Mode().Perm()
	return m&0o077 == 0 && m&0o600 != 0
}
