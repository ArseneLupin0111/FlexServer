package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestCapability_ProfilesDigest(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-profiles-test-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Empty dir returns ""
	digest, err := CalculateProfilesDigest(tempDir)
	if err != nil {
		t.Fatalf("CalculateProfilesDigest failed: %v", err)
	}
	if digest != "" {
		t.Fatalf("expected empty digest for empty dir, got %q", digest)
	}

	// Add profile file
	content := []byte(`{"id":"test","serviceUnit":"test.service"}`)
	profilePath := filepath.Join(tempDir, "test.json")
	if err := os.WriteFile(profilePath, content, 0644); err != nil {
		t.Fatalf("writing profile file failed: %v", err)
	}

	digest1, err := CalculateProfilesDigest(tempDir)
	if err != nil {
		t.Fatalf("CalculateProfilesDigest failed: %v", err)
	}
	if digest1 == "" {
		t.Fatalf("expected non-empty digest for non-empty profiles dir")
	}

	// Stable digest
	digest2, err := CalculateProfilesDigest(tempDir)
	if err != nil {
		t.Fatalf("second CalculateProfilesDigest failed: %v", err)
	}
	if digest1 != digest2 {
		t.Fatalf("expected deterministic digest: %s != %s", digest1, digest2)
	}
}

func TestCapability_ManifestDigest(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-manifest-test-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tempDir)

	manifestPath := filepath.Join(tempDir, "rootfs.manifest")
	content := []byte("sha256:abc12345 /bin/sh\nsha256:def67890 /etc/hosts\n")
	if err := os.WriteFile(manifestPath, content, 0644); err != nil {
		t.Fatalf("writing manifest failed: %v", err)
	}

	h := sha256.Sum256(content)
	expected := hex.EncodeToString(h[:])

	got, err := CalculateManifestDigest(manifestPath)
	if err != nil {
		t.Fatalf("CalculateManifestDigest failed: %v", err)
	}
	if got != expected {
		t.Fatalf("expected %s, got %s", expected, got)
	}
}

func TestCapability_FailClosedNonLinux(t *testing.T) {
	caps := DetectCapabilities("", "", "")
	// If running on non-linux or dev environment without root/cgroups:
	if !caps.Supported {
		if caps.UnsupportedReason == "" {
			t.Fatalf("expected unsupported reason when supported == false")
		}
	}
}

func TestCapability_DecodeRootfsManifest(t *testing.T) {
	// 1. Valid manifest matching build-rootfs schema
	validJSON := []byte(`{
		"version": 1,
		"rootfsSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
		"files": [
			{"path": "/bin/sh", "sha256": "abc123", "mode": 493},
			{"path": "/bin/busybox", "sha256": "def456", "mode": 493}
		]
	}`)
	m, err := DecodeRootfsManifest(validJSON)
	if err != nil {
		t.Fatalf("expected valid manifest to decode successfully, got: %v", err)
	}
	if m.Version != 1 {
		t.Errorf("expected version 1, got %d", m.Version)
	}
	if m.RootfsSha256 != "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" {
		t.Errorf("rootfsSha256 mismatch")
	}
	if len(m.Files) != 2 {
		t.Errorf("expected 2 files, got %d", len(m.Files))
	}

	// 2. Unsupported version
	invalidVersion := []byte(`{"version": 2, "rootfsSha256": "abc", "files": [{"path": "/bin/sh", "sha256": "123"}]}`)
	if _, err := DecodeRootfsManifest(invalidVersion); err == nil {
		t.Errorf("expected error for unsupported version")
	}

	// 3. Missing rootfsSha256
	missingSha := []byte(`{"version": 1, "rootfsSha256": "", "files": [{"path": "/bin/sh", "sha256": "123"}]}`)
	if _, err := DecodeRootfsManifest(missingSha); err == nil {
		t.Errorf("expected error for missing rootfsSha256")
	}

	// 4. Empty files array
	emptyFiles := []byte(`{"version": 1, "rootfsSha256": "abc", "files": []}`)
	if _, err := DecodeRootfsManifest(emptyFiles); err == nil {
		t.Errorf("expected error for empty files")
	}

	// 5. Entry missing path
	missingPath := []byte(`{"version": 1, "rootfsSha256": "abc", "files": [{"path": "", "sha256": "123"}]}`)
	if _, err := DecodeRootfsManifest(missingPath); err == nil {
		t.Errorf("expected error for missing entry path")
	}
}
