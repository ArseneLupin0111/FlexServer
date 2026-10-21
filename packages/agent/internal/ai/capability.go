package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// RootfsManifest matches the schema produced by scripts/agent/build-rootfs.mjs
type RootfsManifest struct {
	Version      int                  `json:"version"`
	RootfsSha256 string               `json:"rootfsSha256"`
	Files        []RootfsManifestFile `json:"files"`
}

// RootfsManifestFile represents an entry in RootfsManifest.Files
type RootfsManifestFile struct {
	Path   string `json:"path"`
	Sha256 string `json:"sha256"`
	Mode   uint32 `json:"mode,omitempty"`
}

// DecodeRootfsManifest parses and validates the rootfs manifest JSON according to
// the build-rootfs schema: {version: 1, rootfsSha256: string, files: [...]}.
func DecodeRootfsManifest(data []byte) (*RootfsManifest, error) {
	var m RootfsManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("decoding rootfs manifest json: %w", err)
	}
	if m.Version != 1 {
		return nil, fmt.Errorf("unsupported rootfs manifest version %d (expected 1)", m.Version)
	}
	if strings.TrimSpace(m.RootfsSha256) == "" {
		return nil, errors.New("rootfs manifest missing rootfsSha256")
	}
	if len(m.Files) == 0 {
		return nil, errors.New("rootfs manifest contains no file entries")
	}
	for i, f := range m.Files {
		if strings.TrimSpace(f.Path) == "" {
			return nil, fmt.Errorf("manifest entry [%d] missing path", i)
		}
		if strings.TrimSpace(f.Sha256) == "" {
			return nil, fmt.Errorf("manifest entry [%d] (%s) missing sha256", i, f.Path)
		}
	}
	return &m, nil
}

// CalculateProfilesDigest computes a deterministic SHA256 digest of all profile files
// in the given directory. If directory doesn't exist, returns empty string.
func CalculateProfilesDigest(dir string) (string, error) {
	if dir == "" {
		return "", nil
	}
	info, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("profiles path %s is not a directory", dir)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}

	var filenames []string
	for _, e := range entries {
		if !e.IsDir() && (filepath.Ext(e.Name()) == ".json" || filepath.Ext(e.Name()) == ".yaml" || filepath.Ext(e.Name()) == ".yml") {
			filenames = append(filenames, e.Name())
		}
	}
	if len(filenames) == 0 {
		return "", nil
	}
	sort.Strings(filenames)

	hasher := sha256.New()
	for _, fn := range filenames {
		path := filepath.Join(dir, fn)
		f, err := os.Open(path)
		if err != nil {
			return "", err
		}
		hasher.Write([]byte(fn))
		hasher.Write([]byte{0})
		if _, err := io.Copy(hasher, f); err != nil {
			f.Close()
			return "", err
		}
		f.Close()
		hasher.Write([]byte{0})
	}

	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// CalculateManifestDigest computes SHA256 digest of rootfs manifest file.
func CalculateManifestDigest(manifestPath string) (string, error) {
	if manifestPath == "" {
		return "", nil
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:]), nil
}
