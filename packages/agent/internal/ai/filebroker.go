package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	ErrProtectedPath      = errors.New("access denied: protected path")
	ErrOutOfScope         = errors.New("access denied: path outside allowed scope")
	ErrSymlinkNotAllowed  = errors.New("access denied: symlinks not allowed")
	ErrFileTooLarge       = errors.New("file exceeds maximum allowed size (256 KiB)")
	ErrPreconditionFailed = errors.New("precondition failed")
	ErrDriftDetected      = errors.New("drift detected: current file digest does not match expected pre-image digest")
	ErrPostImageMismatch  = errors.New("post-image verification failed: digest does not match")
)

var defaultProtectedPrefixes = []string{
	"/etc/shadow",
	"/etc/gshadow",
	"/etc/sudoers",
	"/etc/sudoers.d",
	"/root",
	"/etc/ssh",
	"/proc",
	"/sys",
	"/dev",
	"/var/run/docker.sock",
	"/run/docker.sock",
	"/etc/vps-agent",
	"/var/lib/vps-agent",
	"/run/vps-agent",
	"/etc/vps-manager-agent",
	"/var/lib/vps-manager-agent",
	"/run/vps-manager-agent",
	"/etc/vps-manager",
	"/var/lib/vps-manager",
	"/run/vps-manager",
	"/etc/vps-updater",
	"/var/lib/vps-updater",
	"/run/vps-updater",
	"/etc/flexserver",
	"/var/lib/flexserver",
	"/run/flexserver",
	"/opt/flexserver",
	"/etc/flexserver-ai",
	"/var/lib/flexserver-ai",
	"/run/flexserver-ai",
	"/usr/local/share/flexserver-ai",
	"/etc/systemd/system",
	"/usr/lib/systemd/system",
	"/lib/systemd/system",
}

// FileBroker handles secure reading and CAS mutations with backups.
type FileBroker struct {
	stateDir     string
	backupsDir   string
	allowedRoots []string
}

// NewFileBroker creates a new FileBroker.
func NewFileBroker(stateDir string, allowedRoots []string) (*FileBroker, error) {
	backupsDir := filepath.Join(stateDir, "backups")
	if err := os.MkdirAll(backupsDir, 0700); err != nil {
		return nil, fmt.Errorf("creating backups directory: %w", err)
	}
	// Clean and canonicalize allowed roots
	var cleanRoots []string
	for _, r := range allowedRoots {
		if r != "" {
			cleanRoots = append(cleanRoots, filepath.Clean(r))
		}
	}
	return &FileBroker{
		stateDir:     stateDir,
		backupsDir:   backupsDir,
		allowedRoots: cleanRoots,
	}, nil
}

// IsProtectedPath checks if target path falls within forbidden system directories.
func IsProtectedPath(cleanPath string) bool {
	for _, protected := range defaultProtectedPrefixes {
		if cleanPath == protected || strings.HasPrefix(cleanPath, protected+"/") || ((protected == "/etc/shadow" || protected == "/etc/gshadow") && strings.HasPrefix(cleanPath, protected+".")) {
			return true
		}
	}
	// Also protect hidden SSH directories in user homes
	parts := strings.Split(filepath.ToSlash(strings.ReplaceAll(cleanPath, "\\", "/")), "/")
	for _, p := range parts {
		if p == ".ssh" {
			return true
		}
	}
	return false
}

func (b *FileBroker) ValidateScope(cleanPath string, requestedScope string) error {
	if IsProtectedPath(cleanPath) {
		return fmt.Errorf("%w: %s", ErrProtectedPath, cleanPath)
	}

	// Absent scope and absent allowed roots must fail closed
	if requestedScope == "" && len(b.allowedRoots) == 0 {
		return fmt.Errorf("%w: absent scope and allowed roots (unrestricted file access is forbidden)", ErrOutOfScope)
	}

	// If requestedScope is non-empty, ensure path is inside it
	if requestedScope != "" {
		cleanScope := filepath.Clean(requestedScope)
		if cleanPath != cleanScope && !strings.HasPrefix(cleanPath, cleanScope+string(filepath.Separator)) {
			return fmt.Errorf("%w: path %s outside requested scope %s", ErrOutOfScope, cleanPath, requestedScope)
		}
	}

	// If allowedRoots are configured, verify it falls within at least one root
	if len(b.allowedRoots) > 0 {
		matched := false
		for _, root := range b.allowedRoots {
			if cleanPath == root || strings.HasPrefix(cleanPath, root+string(filepath.Separator)) {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Errorf("%w: path %s outside allowed roots", ErrOutOfScope, cleanPath)
		}
	}

	return nil
}

// ReadResult is returned by ReadFile.
type ReadResult struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	Digest  string `json:"digest"`
}

// ApplyResult is returned by ApplyFile.
type ApplyResult struct {
	Path            string `json:"path"`
	Applied         bool   `json:"applied"`
	BackupPath      string `json:"backupPath,omitempty"`
	PostImageDigest string `json:"postImageDigest"`
}

// CreateBackup creates a protected copy of the existing file.
func (b *FileBroker) CreateBackup(targetPath string, preImageData []byte) (string, error) {
	h := sha256.Sum256(preImageData)
	digestPrefix := hex.EncodeToString(h[:8])
	baseName := filepath.Base(targetPath)
	timestamp := time.Now().UTC().Format("20060102T150405Z")
	backupFilename := fmt.Sprintf("%s-%s-%s.bak", digestPrefix, baseName, timestamp)
	backupPath := filepath.Join(b.backupsDir, backupFilename)

	tempBackup := fmt.Sprintf("%s.tmp.%d", backupPath, time.Now().UnixNano())
	f, err := os.OpenFile(tempBackup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", fmt.Errorf("creating temp backup file: %w", err)
	}

	if _, err := f.Write(preImageData); err != nil {
		f.Close()
		os.Remove(tempBackup)
		return "", fmt.Errorf("writing backup data: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tempBackup)
		return "", fmt.Errorf("fsync backup file: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tempBackup)
		return "", fmt.Errorf("closing backup file: %w", err)
	}

	if err := os.Rename(tempBackup, backupPath); err != nil {
		os.Remove(tempBackup)
		return "", fmt.Errorf("renaming backup file: %w", err)
	}

	// fsync backups directory - error must not be ignored on Linux
	if err := syncDir(b.backupsDir); err != nil {
		return "", fmt.Errorf("fsync backups directory: %w", err)
	}

	return backupPath, nil
}

// ComputeDigest computes hex sha256 of data.
func ComputeDigest(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// BoundedRead reads up to maxBytes from r.
func BoundedRead(r io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 || maxBytes > MaxFileBytes {
		maxBytes = MaxFileBytes
	}
	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrFileTooLarge
	}
	return data, nil
}
