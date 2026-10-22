//go:build windows

package applications

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx   = kernel32.NewProc("LockFileEx")
	procUnlockFileEx = kernel32.NewProc("UnlockFileEx")
)

const (
	lockfileExclusiveLock = 0x00000002
)

func openRegistryFile(path string, flag int, perm os.FileMode) (*os.File, error) {
	fi, err := os.Lstat(path)
	if err == nil && (fi.Mode()&os.ModeSymlink != 0) {
		return nil, fmt.Errorf("applications: symlink not allowed for exclusion registry: %s", path)
	}
	return os.OpenFile(path, flag, perm)
}

func acquireProcessFileLock(path string) (func(), error) {
	f, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("applications: open exclusion lock: %w", err)
	}
	var ol syscall.Overlapped
	r1, _, callErr := procLockFileEx.Call(
		f.Fd(),
		uintptr(lockfileExclusiveLock),
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&ol)),
	)
	if r1 == 0 {
		_ = f.Close()
		return nil, fmt.Errorf("applications: acquire exclusion lock: %v", callErr)
	}
	return func() {
		var ol syscall.Overlapped
		_, _, _ = procUnlockFileEx.Call(
			f.Fd(),
			0,
			1,
			0,
			uintptr(unsafe.Pointer(&ol)),
		)
		_ = f.Close()
	}, nil
}
