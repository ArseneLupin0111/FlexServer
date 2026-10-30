package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFileBroker_ProtectedPaths(t *testing.T) {
	cases := []struct {
		path      string
		protected bool
	}{
		{"/etc/shadow", true},
		{"/etc/shadow.bak", true},
		{"/etc/sudoers", true},
		{"/etc/sudoers.d/custom", true},
		{"/root", true},
		{"/root/secrets.txt", true},
		{"/etc/ssh/sshd_config", true},
		{"/var/run/docker.sock", true},
		{"/home/user/.ssh/authorized_keys", true},
		{"/var/www/html/index.html", false},
		{"/etc/nginx/nginx.conf", false},
		{"/tmp/test.txt", false},
	}

	for _, c := range cases {
		got := IsProtectedPath(c.path)
		if got != c.protected {
			t.Errorf("IsProtectedPath(%q) = %v, expected %v", c.path, got, c.protected)
		}
	}
}

func TestFileBroker_CreateNoReplace(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-filebroker-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	broker, err := NewFileBroker(tempDir, []string{tempDir})
	if err != nil {
		t.Fatalf("NewFileBroker failed: %v", err)
	}

	targetPath := filepath.Join(tempDir, "new-file.txt")
	content := "hello world"
	postDigest := ComputeDigest([]byte(content))

	// 1. First creation should succeed
	res, err := broker.ApplyFile(&FileApplyPayload{
		Path:            targetPath,
		Scope:           tempDir,
		Content:         content,
		PostImageDigest: postDigest,
		CreateNoReplace: true,
	})
	if err != nil {
		t.Fatalf("first ApplyFile create-no-replace failed: %v", err)
	}
	if !res.Applied {
		t.Fatalf("expected applied == true")
	}

	// 2. Second creation of existing file with CreateNoReplace must fail
	dupContent := "overwrite attempt"
	_, err = broker.ApplyFile(&FileApplyPayload{
		Path:            targetPath,
		Scope:           tempDir,
		Content:         dupContent,
		PostImageDigest: ComputeDigest([]byte(dupContent)),
		CreateNoReplace: true,
	})
	if err == nil {
		t.Fatalf("expected error on duplicate create-no-replace")
	}
	if !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("expected ErrPreconditionFailed, got: %v", err)
	}
}

func TestFileBroker_CASReplacementAndDrift(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-filebroker-cas-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	broker, err := NewFileBroker(tempDir, []string{tempDir})
	if err != nil {
		t.Fatalf("NewFileBroker failed: %v", err)
	}

	targetPath := filepath.Join(tempDir, "target.txt")
	initialContent := "version 1 content"
	if err := os.WriteFile(targetPath, []byte(initialContent), 0644); err != nil {
		t.Fatalf("writing initial file failed: %v", err)
	}

	h1 := sha256.Sum256([]byte(initialContent))
	digest1 := hex.EncodeToString(h1[:])

	// 1. Apply replacement with correct pre-image digest
	newContent := "version 2 content"
	h2 := sha256.Sum256([]byte(newContent))
	digest2 := hex.EncodeToString(h2[:])

	res, err := broker.ApplyFile(&FileApplyPayload{
		Path:                   targetPath,
		Scope:                  tempDir,
		Content:                newContent,
		ExpectedPreImageDigest: digest1,
		PostImageDigest:        digest2,
	})
	if err != nil {
		t.Fatalf("ApplyFile replacement failed: %v", err)
	}
	if !res.Applied || res.BackupPath == "" {
		t.Fatalf("expected applied with backupPath, got: %+v", res)
	}

	// Verify backup file exists and contains version 1
	backupData, err := os.ReadFile(res.BackupPath)
	if err != nil {
		t.Fatalf("reading backup failed: %v", err)
	}
	if string(backupData) != initialContent {
		t.Fatalf("backup content mismatch: got %q, expected %q", string(backupData), initialContent)
	}

	// 2. Drift detection: attempt another replacement with stale digest1 (now at digest2)
	v3Content := "version 3 content"
	_, err = broker.ApplyFile(&FileApplyPayload{
		Path:                   targetPath,
		Scope:                  tempDir,
		Content:                v3Content,
		ExpectedPreImageDigest: digest1, // Stale!
		PostImageDigest:        ComputeDigest([]byte(v3Content)),
	})
	if err == nil {
		t.Fatalf("expected drift error on stale digest")
	}
	if !errors.Is(err, ErrDriftDetected) {
		t.Fatalf("expected ErrDriftDetected, got: %v", err)
	}
}

func TestFileBroker_OversizedFileRejected(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-filebroker-oversize-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	broker, err := NewFileBroker(tempDir, []string{tempDir})
	if err != nil {
		t.Fatalf("NewFileBroker failed: %v", err)
	}

	oversized := make([]byte, MaxFileBytes+10)
	_, err = broker.ApplyFile(&FileApplyPayload{
		Path:            filepath.Join(tempDir, "oversized.txt"),
		Scope:           tempDir,
		Content:         string(oversized),
		PostImageDigest: ComputeDigest(oversized),
		CreateNoReplace: true,
	})
	if err == nil {
		t.Fatalf("expected error for oversized content")
	}
	if !errors.Is(err, ErrFileTooLarge) {
		t.Fatalf("expected ErrFileTooLarge, got: %v", err)
	}
}

func TestFileBroker_MissingDigestsRejected(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-filebroker-missing-digest-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	broker, err := NewFileBroker(tempDir, []string{tempDir})
	if err != nil {
		t.Fatalf("NewFileBroker failed: %v", err)
	}

	targetPath := filepath.Join(tempDir, "file.txt")

	// Missing PostImageDigest rejected
	_, err = broker.ApplyFile(&FileApplyPayload{
		Path:            targetPath,
		Scope:           tempDir,
		Content:         "content",
		CreateNoReplace: true,
	})
	if err == nil {
		t.Fatalf("expected error for missing postImageDigest")
	}

	// Replacement missing ExpectedPreImageDigest rejected
	_ = os.WriteFile(targetPath, []byte("existing"), 0644)
	_, err = broker.ApplyFile(&FileApplyPayload{
		Path:            targetPath,
		Scope:           tempDir,
		Content:         "new content",
		PostImageDigest: ComputeDigest([]byte("new content")),
	})
	if err == nil {
		t.Fatalf("expected error for missing expectedPreImageDigest on replacement")
	}
}

func TestFileBroker_ValidateScopeRoot(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-filebroker-scope-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	broker, err := NewFileBroker(tempDir, nil)
	if err != nil {
		t.Fatalf("NewFileBroker failed: %v", err)
	}

	// Test both POSIX-literal paths and OS-native filepath.Clean paths (Windows and Linux)
	for _, targetPath := range []string{"/var/log/app.log", filepath.Clean("/var/log/app.log")} {
		if err := broker.ValidateScope(targetPath, "/"); err != nil {
			t.Errorf("ValidateScope(%q, \"/\") failed: %v", targetPath, err)
		}
	}

	// Protected paths even under root scope "/" must be rejected with ErrProtectedPath
	for _, protectedPath := range []string{"/etc/shadow", filepath.Clean("/etc/shadow"), "/root/.ssh/id_rsa", filepath.Clean("/etc/sudoers")} {
		if err := broker.ValidateScope(protectedPath, "/"); !errors.Is(err, ErrProtectedPath) {
			t.Errorf("ValidateScope(%q, \"/\") expected ErrProtectedPath, got: %v", protectedPath, err)
		}
	}
}
