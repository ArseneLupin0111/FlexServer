//go:build !linux

package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ReadFile provides portable file reading for non-Linux platforms with scope and protection checks.
func (b *FileBroker) ReadFile(targetPath, scope string, maxBytes int64) (*ReadResult, error) {
	cleanPath := filepath.Clean(targetPath)
	if err := b.ValidateScope(cleanPath, scope); err != nil {
		return nil, err
	}

	st, err := os.Lstat(cleanPath)
	if err != nil {
		return nil, err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSymlinkNotAllowed
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file")
	}

	f, err := os.Open(cleanPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

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
		Mode:    uint32(st.Mode() & 0777),
		Digest:  digest,
	}, nil
}

// ApplyFile provides portable CAS apply for non-Linux platforms.
func (b *FileBroker) ApplyFile(payload *FileApplyPayload) (*ApplyResult, error) {
	cleanPath := filepath.Clean(payload.Path)
	if err := b.ValidateScope(cleanPath, payload.Scope); err != nil {
		return nil, err
	}

	candidateBytes := []byte(payload.Content)
	if int64(len(candidateBytes)) > MaxFileBytes {
		return nil, ErrFileTooLarge
	}

	if payload.PostImageDigest == "" {
		return nil, errors.New("postImageDigest is required for file mutation")
	}
	postDigest := ComputeDigest(candidateBytes)
	if postDigest != payload.PostImageDigest {
		return nil, fmt.Errorf("%w: expected %s, got %s", ErrPostImageMismatch, payload.PostImageDigest, postDigest)
	}

	parentDir := filepath.Dir(cleanPath)
	baseName := filepath.Base(cleanPath)
	const fixedMode os.FileMode = 0644

	if payload.CreateNoReplace {
		if payload.ExpectedPreImageDigest != "" && payload.ExpectedPreImageDigest != "none" {
			return nil, fmt.Errorf("%w: expectedPreImageDigest must be empty or 'none' for create-no-replace", ErrPreconditionFailed)
		}
		if _, err := os.Lstat(cleanPath); err == nil {
			return nil, fmt.Errorf("%w: file %s already exists (create-no-replace denied)", ErrPreconditionFailed, cleanPath)
		}

		// Write to temp file then rename to avoid partial writes
		tempPath := filepath.Join(parentDir, fmt.Sprintf(".tmp.create.%s.%d", baseName, time.Now().UnixNano()))
		f, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fixedMode)
		if err != nil {
			return nil, err
		}
		if _, err := f.Write(candidateBytes); err != nil {
			f.Close()
			_ = os.Remove(tempPath)
			return nil, err
		}
		if err := f.Sync(); err != nil {
			f.Close()
			_ = os.Remove(tempPath)
			return nil, err
		}
		if err := f.Close(); err != nil {
			_ = os.Remove(tempPath)
			return nil, err
		}

		if err := os.Rename(tempPath, cleanPath); err != nil {
			_ = os.Remove(tempPath)
			return nil, err
		}

		return &ApplyResult{
			Path:            cleanPath,
			Applied:         true,
			PostImageDigest: postDigest,
		}, nil
	}

	// Replacement flow
	if payload.ExpectedPreImageDigest == "" {
		return nil, errors.New("expectedPreImageDigest is required for file replacement")
	}

	st, err := os.Lstat(cleanPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: file %s does not exist", ErrPreconditionFailed, cleanPath)
		}
		return nil, err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSymlinkNotAllowed
	}

	existingData, err := os.ReadFile(cleanPath)
	if err != nil {
		return nil, err
	}

	existingDigest := ComputeDigest(existingData)
	if existingDigest != payload.ExpectedPreImageDigest {
		return nil, fmt.Errorf("%w: expected %s, got %s", ErrDriftDetected, payload.ExpectedPreImageDigest, existingDigest)
	}

	backupPath, err := b.CreateBackup(cleanPath, existingData)
	if err != nil {
		return nil, fmt.Errorf("creating backup: %w", err)
	}

	tempPath := filepath.Join(parentDir, fmt.Sprintf(".tmp.%s.%d", baseName, time.Now().UnixNano()))
	f, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, st.Mode()&0777)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(candidateBytes); err != nil {
		f.Close()
		_ = os.Remove(tempPath)
		return nil, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		_ = os.Remove(tempPath)
		return nil, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tempPath)
		return nil, err
	}

	if err := os.Rename(tempPath, cleanPath); err != nil {
		_ = os.Remove(tempPath)
		return nil, err
	}

	return &ApplyResult{
		Path:            cleanPath,
		Applied:         true,
		BackupPath:      backupPath,
		PostImageDigest: postDigest,
	}, nil
}
