//go:build linux

package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// ReadFile reads a file using secure dirfd component-by-component traversal,
// opening with O_NONBLOCK, rejecting symlinks, FIFOs, sockets, device nodes,
// and hardlinked files (nlink != 1).
func (b *FileBroker) ReadFile(targetPath, scope string, maxBytes int64) (*ReadResult, error) {
	cleanPath := filepath.Clean(targetPath)
	if err := b.ValidateScope(cleanPath, scope); err != nil {
		return nil, err
	}

	fd, err := openSecure(cleanPath, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC)
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			return nil, ErrSymlinkNotAllowed
		}
		return nil, fmt.Errorf("open secure %s: %w", cleanPath, err)
	}

	// Single owner: os.NewFile takes ownership of fd, defer f.Close() only
	f := os.NewFile(uintptr(fd), cleanPath)
	defer f.Close()

	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, fmt.Errorf("fstat: %w", err)
	}

	// Must be regular file (reject FIFOs, devices, sockets)
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil, fmt.Errorf("not a regular file (mode 0%o)", st.Mode)
	}

	// Reject hardlinks to avoid link-based bypasses
	if st.Nlink != 1 {
		return nil, errors.New("hardlinked files (nlink != 1) are forbidden")
	}

	data, err := BoundedRead(f, maxBytes)
	if err != nil {
		return nil, err
	}

	h := sha256.Sum256(data)
	digest := hex.EncodeToString(h[:])

	return &ReadResult{
		Path:    cleanPath,
		Content: string(data),
		Size:    int64(len(data)),
		Mode:    uint32(st.Mode & 0777),
		Digest:  digest,
	}, nil
}

// ApplyFile applies a CAS mutation to a file or creates it with atomic create-no-replace semantics.
// Requires exact pre-image and post-image digests.
func (b *FileBroker) ApplyFile(payload *FileApplyPayload) (*ApplyResult, error) {
	cleanPath := filepath.Clean(payload.Path)
	if err := b.ValidateScope(cleanPath, payload.Scope); err != nil {
		return nil, err
	}

	candidateBytes := []byte(payload.Content)
	if int64(len(candidateBytes)) > MaxFileBytes {
		return nil, ErrFileTooLarge
	}

	// PostImageDigest is strictly required for all mutations
	if payload.PostImageDigest == "" {
		return nil, errors.New("postImageDigest is required for file mutation")
	}
	postDigest := ComputeDigest(candidateBytes)
	if postDigest != payload.PostImageDigest {
		return nil, fmt.Errorf("%w: expected %s, got %s", ErrPostImageMismatch, payload.PostImageDigest, postDigest)
	}

	parentDir := filepath.Dir(cleanPath)
	baseName := filepath.Base(cleanPath)

	parentFd, err := openDirSecure(parentDir)
	if err != nil {
		return nil, fmt.Errorf("opening parent directory securely: %w", err)
	}
	defer unix.Close(parentFd)

	// Fixed mode: 0644 for regular configs, never arbitrary caller mode
	const fixedMode uint32 = 0644

	if payload.CreateNoReplace {
		// Precondition: cannot have pre-image for creation
		if payload.ExpectedPreImageDigest != "" && payload.ExpectedPreImageDigest != "none" {
			return nil, fmt.Errorf("%w: expectedPreImageDigest must be empty or 'none' for create-no-replace", ErrPreconditionFailed)
		}

		// Stage candidate into temporary sibling file first to prevent partial files
		tempName := fmt.Sprintf(".tmp.create.%s.%d", baseName, time.Now().UnixNano())
		tempFd, err := unix.Openat(parentFd, tempName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC, fixedMode)
		if err != nil {
			return nil, fmt.Errorf("creating temp file for staged create: %w", err)
		}

		tempFile := os.NewFile(uintptr(tempFd), filepath.Join(parentDir, tempName))
		if _, err := tempFile.Write(candidateBytes); err != nil {
			tempFile.Close()
			_ = unix.Unlinkat(parentFd, tempName, 0)
			return nil, fmt.Errorf("writing staged create file: %w", err)
		}
		if err := tempFile.Sync(); err != nil {
			tempFile.Close()
			_ = unix.Unlinkat(parentFd, tempName, 0)
			return nil, fmt.Errorf("fsync staged create file: %w", err)
		}
		if err := tempFile.Close(); err != nil {
			_ = unix.Unlinkat(parentFd, tempName, 0)
			return nil, fmt.Errorf("closing staged create file: %w", err)
		}

		// Atomically publish via renameat2 with RENAME_NOREPLACE
		err = unix.Renameat2(parentFd, tempName, parentFd, baseName, unix.RENAME_NOREPLACE)
		if err != nil {
			_ = unix.Unlinkat(parentFd, tempName, 0)
			if errors.Is(err, unix.EEXIST) {
				return nil, fmt.Errorf("%w: file %s already exists (create-no-replace denied)", ErrPreconditionFailed, cleanPath)
			}
			return nil, fmt.Errorf("atomic renameat2 NOREPLACE: %w", err)
		}

		// fsync parent dir - error must not be ignored
		if err := unix.Fsync(parentFd); err != nil {
			return nil, fmt.Errorf("fsync parent directory after create: %w", err)
		}

		return &ApplyResult{
			Path:            cleanPath,
			Applied:         true,
			PostImageDigest: postDigest,
		}, nil
	}

	// Replacement flow: expectedPreImageDigest is mandatory
	if payload.ExpectedPreImageDigest == "" {
		return nil, errors.New("expectedPreImageDigest is required for file replacement")
	}

	// Open target file securely to verify pre-image and create backup
	targetFd, err := unix.Openat(parentFd, baseName, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if os.IsNotExist(err) || errors.Is(err, unix.ENOENT) {
			return nil, fmt.Errorf("%w: target file %s does not exist", ErrPreconditionFailed, cleanPath)
		}
		return nil, fmt.Errorf("opening target file for CAS verification: %w", err)
	}

	var st unix.Stat_t
	if err := unix.Fstat(targetFd, &st); err != nil {
		unix.Close(targetFd)
		return nil, fmt.Errorf("stat target: %w", err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(targetFd)
		return nil, fmt.Errorf("target is not a regular file")
	}
	if st.Nlink != 1 {
		unix.Close(targetFd)
		return nil, errors.New("hardlinked target file is forbidden")
	}

	targetFile := os.NewFile(uintptr(targetFd), cleanPath)
	existingData, err := BoundedRead(targetFile, MaxFileBytes)
	targetFile.Close() // single owner closes targetFd
	if err != nil {
		return nil, fmt.Errorf("reading target for CAS verification: %w", err)
	}

	existingDigest := ComputeDigest(existingData)
	if existingDigest != payload.ExpectedPreImageDigest {
		return nil, fmt.Errorf("%w: expected %s, got %s", ErrDriftDetected, payload.ExpectedPreImageDigest, existingDigest)
	}

	// Create protected backup
	backupPath, err := b.CreateBackup(cleanPath, existingData)
	if err != nil {
		return nil, fmt.Errorf("creating backup: %w", err)
	}

	// Write candidate to temp file in parent dir, preserving ownership and permissions
	tempName := fmt.Sprintf(".tmp.%s.%d", baseName, time.Now().UnixNano())
	tempFd, err := unix.Openat(parentFd, tempName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC, uint32(st.Mode&0777))
	if err != nil {
		return nil, fmt.Errorf("creating temp file in parent dir: %w", err)
	}

	// Preserve owner and group
	if err := unix.Fchown(tempFd, int(st.Uid), int(st.Gid)); err != nil {
		unix.Close(tempFd)
		_ = unix.Unlinkat(parentFd, tempName, 0)
		return nil, fmt.Errorf("fchown preserving owner: %w", err)
	}

	tempFile := os.NewFile(uintptr(tempFd), filepath.Join(parentDir, tempName))
	if _, err := tempFile.Write(candidateBytes); err != nil {
		tempFile.Close()
		_ = unix.Unlinkat(parentFd, tempName, 0)
		return nil, fmt.Errorf("writing candidate: %w", err)
	}
	if err := tempFile.Sync(); err != nil {
		tempFile.Close()
		_ = unix.Unlinkat(parentFd, tempName, 0)
		return nil, fmt.Errorf("fsync temp file: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		_ = unix.Unlinkat(parentFd, tempName, 0)
		return nil, fmt.Errorf("closing temp file: %w", err)
	}

	// Atomic rename
	if err := unix.Renameat(parentFd, tempName, parentFd, baseName); err != nil {
		_ = unix.Unlinkat(parentFd, tempName, 0)
		return nil, fmt.Errorf("atomic renameat: %w", err)
	}

	// fsync parent directory to make rename durable - error cannot be ignored
	if err := unix.Fsync(parentFd); err != nil {
		return nil, fmt.Errorf("fsync parent directory after replace: %w", err)
	}

	return &ApplyResult{
		Path:            cleanPath,
		Applied:         true,
		BackupPath:      backupPath,
		PostImageDigest: postDigest,
	}, nil
}

// openDirSecure opens a directory securely following canonical components without symlinks.
func openDirSecure(path string) (int, error) {
	cleanPath := filepath.Clean(path)
	if !filepath.IsAbs(cleanPath) {
		return -1, fmt.Errorf("path must be absolute: %s", path)
	}

	currFd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}

	// Verify root identity
	var rootStat unix.Stat_t
	if err := unix.Fstat(currFd, &rootStat); err != nil {
		unix.Close(currFd)
		return -1, fmt.Errorf("stat /: %w", err)
	}

	parts := strings.Split(strings.Trim(cleanPath, "/"), "/")
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}

		nextFd, err := unix.Openat(currFd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(currFd)
		if err != nil {
			return -1, fmt.Errorf("resolving component %q in %s: %w", part, cleanPath, err)
		}
		currFd = nextFd
	}

	return currFd, nil
}

// openSecure opens a file by traversing its directory tree securely without following symlinks.
func openSecure(path string, flags int) (int, error) {
	cleanPath := filepath.Clean(path)
	parentDir := filepath.Dir(cleanPath)
	baseName := filepath.Base(cleanPath)

	parentFd, err := openDirSecure(parentDir)
	if err != nil {
		return -1, err
	}
	defer unix.Close(parentFd)

	fd, err := unix.Openat(parentFd, baseName, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	return fd, nil
}
