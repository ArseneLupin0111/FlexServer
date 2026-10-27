//go:build linux

package ai

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectCapabilitiesRecognizesFilesystemOwnership(t *testing.T) {
	dir := t.TempDir()
	manifest := filepath.Join(dir, "rootfs.manifest.json")
	if err := os.WriteFile(manifest, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	caps := DetectCapabilities(dir, manifest, dir)
	if strings.Contains(caps.UnsupportedReason, "unable to determine rootfs file ownership") ||
		strings.Contains(caps.UnsupportedReason, "unable to determine profiles directory ownership") {
		t.Fatalf("Linux os.Stat ownership was not recognized: %s", caps.UnsupportedReason)
	}
}

func TestCheckRootfsFileIgnoresSymlinkPermissionBits(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "busybox"), []byte("x"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("busybox", filepath.Join(dir, "[")); err != nil {
		t.Fatal(err)
	}
	if err := checkRootfsFile(dir, "[", ""); err != nil {
		t.Fatalf("expected symlink permission bits to be ignored: %v", err)
	}
}
