package lock

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// LinuxDefaultLockDir is the trusted root-owned directory used on Linux systems.
const LinuxDefaultLockDir = "/run/vps-manager-agent"

// ErrAlreadyRunning indicates another process currently holds the lock for this VPS.
var ErrAlreadyRunning = errors.New("agent already running for this VPS")

// Handle represents an acquired OS-level process lock.
// The lock file descriptor/handle is held open for the lifetime of the process.
// Releasing the handle unlocks and closes the file descriptor, but NEVER unlinks
// the lock file on disk so that all competing processes always contend on the exact
// same file/inode across restarts and crashes.
type Handle struct {
	f    *os.File
	path string
}

// Path returns the filesystem path of the held lock file.
func (h *Handle) Path() string {
	if h == nil {
		return ""
	}
	return h.path
}

// Release releases the lock and closes the underlying file handle.
// It never unlinks the file.
func (h *Handle) Release() error {
	if h == nil {
		return nil
	}
	if h.f == nil {
		return nil
	}
	f := h.f
	h.f = nil
	return releaseOS(f)
}

// Option configures lock acquisition.
type Option func(*options)

type options struct {
	dir              string
	expectedOwnerUID *int
}

// WithDir overrides the directory in which the lock file is created.
// In direct internal tests in private temporary directories, this also defaults the
// expected directory and file owner UID to the current user's UID (os.Geteuid() on Linux)
// unless explicitly configured via WithExpectedOwnerUID.
// In production (when WithDir is omitted), the directory is /run/vps-manager-agent on Linux
// and the expected owner is strictly UID 0 (root).
func WithDir(dir string) Option {
	return func(o *options) {
		o.dir = dir
	}
}

// WithExpectedOwnerUID explicitly sets the expected owner UID for directory and file security checks.
func WithExpectedOwnerUID(uid int) Option {
	return func(o *options) {
		o.expectedOwnerUID = &uid
	}
}

// DefaultLockDir returns the default lock directory.
// On Linux, it returns "/run/vps-manager-agent" (fixed across all users and execution paths).
// On other platforms, it returns os.TempDir().
func DefaultLockDir() string {
	if runtime.GOOS == "linux" {
		return LinuxDefaultLockDir
	}
	return filepath.Clean(os.TempDir())
}

// LockFilename returns the deterministic, safe lock filename for a given vpsId.
// Format: vps-agent-<sha256(vpsId)>.lock
func LockFilename(vpsId string) string {
	h := sha256.Sum256([]byte(vpsId))
	return fmt.Sprintf("vps-agent-%x.lock", h)
}

// LockPath returns the full filesystem path for the given vpsId and options.
func LockPath(vpsId string, opts ...Option) string {
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	dir := o.dir
	if dir == "" {
		dir = DefaultLockDir()
	}
	return filepath.Join(dir, LockFilename(vpsId))
}

// Acquire acquires a non-blocking exclusive OS lock keyed by vpsId.
// If another instance already holds the lock, it returns an error wrapping ErrAlreadyRunning.
func Acquire(vpsId string, opts ...Option) (*Handle, error) {
	if strings.TrimSpace(vpsId) == "" {
		return nil, fmt.Errorf("vpsId cannot be empty")
	}

	var o options
	for _, opt := range opts {
		opt(&o)
	}

	path := LockPath(vpsId, opts...)
	f, err := acquireOS(path, o)
	if err != nil {
		return nil, err
	}

	return &Handle{
		f:    f,
		path: path,
	}, nil
}
