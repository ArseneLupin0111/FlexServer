//go:build linux

package lock

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// acquireOS opens the lock file at path and acquires a non-blocking exclusive flock.
//
// Linux Hardening & Invariants:
//  1. Directory verification: parent directory must exist, be a directory, NOT be group/other writable
//     (perm & 0022 == 0), and be owned by the expected UID (strictly UID 0 in production).
//  2. Open hardening: opened with syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK.
//     O_NOFOLLOW prevents symlink traversal; O_CLOEXEC prevents fd inheritance; O_NONBLOCK prevents
//     blocking if the path was replaced with a FIFO.
//  3. File verification: verified via f.Stat() to be a regular file owned by the expected UID.
//  4. Creation constraints: only root (UID 0) or test fixtures in private directories can create
//     the lock file; unprivileged production agents fail closed with an actionable error if the
//     directory or file is absent, requiring root service setup to preprovision it.
//  5. Exclusive lock: syscall.Flock(fd, LOCK_EX|LOCK_NB).
//  6. Persistence: inode is never unlinked or truncated on release or crash.
func acquireOS(path string, o options) (*os.File, error) {
	expectedOwnerUID := 0
	if o.expectedOwnerUID != nil {
		expectedOwnerUID = *o.expectedOwnerUID
	} else if o.dir != "" {
		// When a custom directory is explicitly supplied for tests, default expected owner
		// to the running test user's UID. Production always uses UID 0 (root).
		expectedOwnerUID = os.Geteuid()
	}

	parentDir := filepath.Dir(path)
	parentFi, err := os.Stat(parentDir)
	if err != nil {
		if os.IsNotExist(err) {
			if os.Geteuid() == 0 {
				if err := os.MkdirAll(parentDir, 0o755); err != nil {
					return nil, fmt.Errorf("create lock directory %s: %w", parentDir, err)
				}
				parentFi, err = os.Stat(parentDir)
				if err != nil {
					return nil, fmt.Errorf("stat lock directory %s: %w", parentDir, err)
				}
			} else {
				return nil, fmt.Errorf("lock directory %s does not exist: %w (service setup must preprovision root-owned directory)", parentDir, err)
			}
		} else {
			return nil, fmt.Errorf("stat lock directory %s: %w", parentDir, err)
		}
	}

	if !parentFi.IsDir() {
		return nil, fmt.Errorf("lock parent path %s is not a directory", parentDir)
	}

	// Parent directory must not be group-writable or other-writable
	if parentFi.Mode().Perm()&0o022 != 0 {
		return nil, fmt.Errorf("lock directory %s has insecure permissions %04o (group/other writable)", parentDir, parentFi.Mode().Perm())
	}

	// Verify parent directory ownership
	if st, ok := parentFi.Sys().(*syscall.Stat_t); ok {
		if int(st.Uid) != expectedOwnerUID {
			return nil, fmt.Errorf("lock directory %s is owned by UID %d, expected UID %d", parentDir, st.Uid, expectedOwnerUID)
		}
	}

	flags := syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
	canCreate := (os.Geteuid() == 0) || (o.dir != "" && os.Geteuid() == expectedOwnerUID)

	var f *os.File
	if canCreate {
		f, err = os.OpenFile(path, os.O_CREATE|os.O_RDWR|flags, 0o666)
	} else {
		f, err = os.OpenFile(path, os.O_RDWR|flags, 0)
		if err != nil && (errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.EACCES)) {
			// Linux flock(LOCK_EX) is permitted on read-only file descriptors
			f, err = os.OpenFile(path, os.O_RDONLY|flags, 0)
		}
	}
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("lock file %s does not exist: %w (service setup must preprovision root-owned 0666 lock file)", path, err)
		}
		return nil, fmt.Errorf("open lock file %s: %w", path, err)
	}

	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("stat lock file %s: %w", path, err)
	}
	if !fi.Mode().IsRegular() {
		_ = f.Close()
		return nil, fmt.Errorf("lock target %s is not a regular file", path)
	}

	// Verify lock file ownership
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		if int(st.Uid) != expectedOwnerUID {
			_ = f.Close()
			return nil, fmt.Errorf("lock file %s is owned by UID %d, expected UID %d", path, st.Uid, expectedOwnerUID)
		}
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, fmt.Errorf("%w (lock held at %s)", ErrAlreadyRunning, path)
		}
		return nil, fmt.Errorf("flock %s: %w", path, err)
	}

	return f, nil
}

// releaseOS unlocks and closes the file descriptor without unlinking the file.
func releaseOS(f *os.File) error {
	if f == nil {
		return nil
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return f.Close()
}

func provisionOS(vpsId string, o options) error {
	expectedOwnerUID := 0
	if o.expectedOwnerUID != nil {
		expectedOwnerUID = *o.expectedOwnerUID
	} else if o.dir != "" {
		expectedOwnerUID = os.Geteuid()
	}

	dir := o.dir
	if dir == "" {
		dir = LinuxDefaultLockDir
	}

	// 1. Ensure directory exists with 0755 permissions and expected owner UID
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create lock directory %s: %w", dir, err)
	}
	dirFi, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("stat lock directory %s: %w", dir, err)
	}
	if !dirFi.IsDir() {
		return fmt.Errorf("lock directory path %s is not a directory", dir)
	}
	if dirFi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("lock directory %s is a symlink", dir)
	}
	if dirFi.Mode().Perm() != 0o755 {
		if err := os.Chmod(dir, 0o755); err != nil {
			return fmt.Errorf("chmod lock directory %s: %w", dir, err)
		}
	}
	if st, ok := dirFi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != expectedOwnerUID {
		if expectedOwnerUID == 0 || (o.dir != "" && os.Geteuid() == expectedOwnerUID) {
			if err := os.Chown(dir, expectedOwnerUID, expectedOwnerUID); err != nil {
				return fmt.Errorf("chown lock directory %s to UID %d: %w", dir, expectedOwnerUID, err)
			}
		}
	}

	// 2. Ensure lock file exists with 0666 permissions and expected owner UID.
	// Never unlink or truncate an existing file so any held inode remains continuous.
	lockPath := filepath.Join(dir, LockFilename(vpsId))
	fi, err := os.Lstat(lockPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			flags := syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
			f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_RDWR|flags, 0o666)
			if err != nil {
				return fmt.Errorf("create lock file %s: %w", lockPath, err)
			}
			_ = f.Close()
			if err := os.Chmod(lockPath, 0o666); err != nil {
				return fmt.Errorf("chmod lock file %s: %w", lockPath, err)
			}
			if expectedOwnerUID == 0 || (o.dir != "" && os.Geteuid() == expectedOwnerUID) {
				_ = os.Chown(lockPath, expectedOwnerUID, expectedOwnerUID)
			}
		} else {
			return fmt.Errorf("stat lock file %s: %w", lockPath, err)
		}
	} else {
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("lock file %s is a symlink", lockPath)
		}
		if !fi.Mode().IsRegular() {
			return fmt.Errorf("lock file %s is not a regular file", lockPath)
		}
		if fi.Mode().Perm() != 0o666 {
			if err := os.Chmod(lockPath, 0o666); err != nil {
				return fmt.Errorf("chmod lock file %s: %w", lockPath, err)
			}
		}
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != expectedOwnerUID {
			if expectedOwnerUID == 0 || (o.dir != "" && os.Geteuid() == expectedOwnerUID) {
				if err := os.Chown(lockPath, expectedOwnerUID, expectedOwnerUID); err != nil {
					return fmt.Errorf("chown lock file %s to UID %d: %w", lockPath, expectedOwnerUID, err)
				}
			}
		}
	}

	// 3. Provision systemd tmpfiles configuration for reboot persistence
	tmpfilesDir := ""
	if o.tmpfilesDir != nil {
		tmpfilesDir = *o.tmpfilesDir
	} else if o.dir == "" {
		tmpfilesDir = TmpfilesDefaultDir
	}

	if tmpfilesDir != "" {
		if err := os.MkdirAll(tmpfilesDir, 0o755); err != nil {
			return fmt.Errorf("create tmpfiles directory %s: %w", tmpfilesDir, err)
		}
		confPath := filepath.Join(tmpfilesDir, TmpfilesDefaultConf)
		content := fmt.Sprintf("d %s 0755 root root -\nf %s 0666 root root -\n", dir, lockPath)
		if err := os.WriteFile(confPath, []byte(content), 0o644); err != nil {
			return fmt.Errorf("write tmpfiles configuration %s: %w", confPath, err)
		}
		_ = os.Chmod(confPath, 0o644)
		if expectedOwnerUID == 0 {
			_ = os.Chown(confPath, 0, 0)
		}

		if tmpfilesDir == TmpfilesDefaultDir {
			if tmpfilesBin, err := exec.LookPath("systemd-tmpfiles"); err == nil && tmpfilesBin != "" {
				cmd := exec.Command(tmpfilesBin, "--create", confPath)
				_ = cmd.Run()
			}
		}
	}

	return nil
}
