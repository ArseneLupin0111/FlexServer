package lock

import (
	"bufio"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLockAcquireRelease(t *testing.T) {
	dir := t.TempDir()
	vpsId := "vps-acquire-release-test"

	h1, err := Acquire(vpsId, WithDir(dir))
	if err != nil {
		t.Fatalf("failed to acquire lock: %v", err)
	}
	if h1 == nil {
		t.Fatal("expected non-nil handle")
	}

	path := h1.Path()
	expectedHash := fmt.Sprintf("%x", sha256.Sum256([]byte(vpsId)))
	expectedFilename := fmt.Sprintf("vps-agent-%s.lock", expectedHash)
	if filepath.Base(path) != expectedFilename {
		t.Fatalf("expected filename %s, got %s", expectedFilename, filepath.Base(path))
	}

	// Lock file must exist on disk
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("expected lock file on disk: %v", err)
	}
	if !fi.Mode().IsRegular() {
		t.Fatalf("expected regular file, got mode %v", fi.Mode())
	}

	// Release lock
	if err := h1.Release(); err != nil {
		t.Fatalf("release failed: %v", err)
	}

	// Lock file inode must NEVER be unlinked on release
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("lock file was unlinked on release, must be preserved: %v", err)
	}

	// Can acquire again after release
	h2, err := Acquire(vpsId, WithDir(dir))
	if err != nil {
		t.Fatalf("failed to acquire lock after release: %v", err)
	}
	if err := h2.Release(); err != nil {
		t.Fatalf("second release failed: %v", err)
	}
}

func TestLockSameVPSContention(t *testing.T) {
	dir := t.TempDir()
	vpsId := "vps-contention-test"

	h1, err := Acquire(vpsId, WithDir(dir))
	if err != nil {
		t.Fatalf("first acquire failed: %v", err)
	}
	defer h1.Release()

	// Second acquire for the SAME VPS must fail closed with ErrAlreadyRunning
	h2, err := Acquire(vpsId, WithDir(dir))
	if err == nil {
		_ = h2.Release()
		t.Fatal("expected second acquire to fail, but succeeded")
	}
	if !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("expected error wrapping ErrAlreadyRunning, got: %v", err)
	}
	if !strings.Contains(err.Error(), "agent already running for this VPS") {
		t.Fatalf("expected error message to contain 'agent already running for this VPS', got: %v", err)
	}

	// Release h1
	if err := h1.Release(); err != nil {
		t.Fatalf("release h1 failed: %v", err)
	}

	// Now h3 should succeed
	h3, err := Acquire(vpsId, WithDir(dir))
	if err != nil {
		t.Fatalf("acquire after release failed: %v", err)
	}
	defer h3.Release()
}

func TestLockDifferentVPSIsolation(t *testing.T) {
	dir := t.TempDir()
	vps1 := "vps-tenant-111"
	vps2 := "vps-tenant-222"

	h1, err := Acquire(vps1, WithDir(dir))
	if err != nil {
		t.Fatalf("acquire vps1 failed: %v", err)
	}
	defer h1.Release()

	// Different VPS ID must succeed concurrently
	h2, err := Acquire(vps2, WithDir(dir))
	if err != nil {
		t.Fatalf("acquire vps2 failed concurrently: %v", err)
	}
	defer h2.Release()

	if h1.Path() == h2.Path() {
		t.Fatalf("lock paths must be distinct, got same: %s", h1.Path())
	}
}

func TestLockPathStabilityAcrossBinaryAndConfig(t *testing.T) {
	vpsId := "vps-fixed-host-identity"

	path1 := LockPath(vpsId)
	path2 := LockPath(vpsId)
	if path1 != path2 {
		t.Fatalf("paths must be identical for same vpsId: %s != %s", path1, path2)
	}

	if runtime.GOOS == "linux" {
		expectedLinuxPrefix := LinuxDefaultLockDir
		if !strings.HasPrefix(path1, expectedLinuxPrefix) {
			t.Fatalf("expected path to start with %s, got: %s", expectedLinuxPrefix, path1)
		}
	}
}

func TestLockEmptyVPSID(t *testing.T) {
	_, err := Acquire("")
	if err == nil {
		t.Fatal("expected error for empty vpsId, got nil")
	}

	_, err2 := Acquire("   ")
	if err2 == nil {
		t.Fatal("expected error for whitespace vpsId, got nil")
	}
}

func TestLockOwnershipAndPermissionsHardening(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("ownership and permission hardening tests are Linux specific")
	}

	// 1. Insecure directory permissions (e.g. 0777 group/other writable) must be rejected
	dirInsecure := filepath.Join(t.TempDir(), "insecure")
	if err := os.MkdirAll(dirInsecure, 0o777); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Force chmod 0777 (MkdirAll is subject to umask)
	_ = os.Chmod(dirInsecure, 0o777)

	_, err := Acquire("vps-test", WithDir(dirInsecure))
	if err == nil {
		t.Fatal("expected Acquire to fail on 0777 insecure directory, but succeeded")
	}
	if !strings.Contains(err.Error(), "insecure permissions") {
		t.Fatalf("expected error mentioning insecure permissions, got: %v", err)
	}

	// 2. Expected owner mismatch must be rejected
	dirSecure := filepath.Join(t.TempDir(), "secure")
	if err := os.MkdirAll(dirSecure, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	_, errMismatch := Acquire("vps-test", WithDir(dirSecure), WithExpectedOwnerUID(99999))
	if errMismatch == nil {
		t.Fatal("expected Acquire to fail when directory owner UID does not match expected, but succeeded")
	}
	if !strings.Contains(errMismatch.Error(), "owned by UID") {
		t.Fatalf("expected error mentioning owned by UID, got: %v", errMismatch)
	}
}

func TestLockReleaseOnCrash(t *testing.T) {
	if os.Getenv("TEST_LOCK_CRASH_HELPER") == "1" {
		vpsId := os.Getenv("TEST_LOCK_VPS_ID")
		dir := os.Getenv("TEST_LOCK_DIR")
		_, err := Acquire(vpsId, WithDir(dir))
		if err != nil {
			os.Exit(2)
		}
		fmt.Println("LOCKED")
		time.Sleep(2 * time.Second)
		// Abrupt exit without calling Release() — simulating SIGKILL/crash
		os.Exit(42)
	}

	dir := t.TempDir()
	vpsId := "vps-test-crash-release"

	cmd := exec.Command(os.Args[0], "-test.run=TestLockReleaseOnCrash")
	cmd.Env = append(os.Environ(),
		"TEST_LOCK_CRASH_HELPER=1",
		"TEST_LOCK_VPS_ID="+vpsId,
		"TEST_LOCK_DIR="+dir,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("cmd start: %v", err)
	}

	reader := bufio.NewReader(stdout)
	line, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "LOCKED" {
		_ = cmd.Process.Kill()
		t.Fatalf("unexpected helper output: %q (err: %v)", line, err)
	}

	// While helper process holds the lock, another acquire must fail
	_, err = Acquire(vpsId, WithDir(dir))
	if !errors.Is(err, ErrAlreadyRunning) {
		_ = cmd.Process.Kill()
		t.Fatalf("expected ErrAlreadyRunning while helper running, got: %v", err)
	}

	// Wait for helper process to exit (crash)
	_ = cmd.Wait()

	// After helper process crashes, lock must be released immediately by kernel
	h, err := Acquire(vpsId, WithDir(dir))
	if err != nil {
		t.Fatalf("failed to acquire lock after helper crash: %v", err)
	}
	defer h.Release()
}

func TestLockProvision(t *testing.T) {
	dir := t.TempDir()
	tmpfilesDir := t.TempDir()
	vpsId := "vps-provision-test"

	if err := Provision(vpsId, WithDir(dir), WithTmpfilesDir(tmpfilesDir)); err != nil {
		t.Fatalf("Provision failed: %v", err)
	}

	expectedFilename := LockFilename(vpsId)
	lockPath := filepath.Join(dir, expectedFilename)

	fi, err := os.Stat(lockPath)
	if err != nil {
		t.Fatalf("expected lock file at %s: %v", lockPath, err)
	}
	if !fi.Mode().IsRegular() {
		t.Fatalf("expected regular file, got mode: %v", fi.Mode())
	}

	confPath := filepath.Join(tmpfilesDir, TmpfilesDefaultConf)
	confData, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("expected tmpfiles configuration at %s: %v", confPath, err)
	}
	confStr := string(confData)
	if !strings.Contains(confStr, fmt.Sprintf("d %s 0755 root root -", dir)) {
		t.Fatalf("tmpfiles missing directory entry: %s", confStr)
	}
	if !strings.Contains(confStr, fmt.Sprintf("f %s 0666 root root -", lockPath)) {
		t.Fatalf("tmpfiles missing lock file entry: %s", confStr)
	}

	// Acquiring lock after provisioning must succeed
	h, err := Acquire(vpsId, WithDir(dir))
	if err != nil {
		t.Fatalf("failed to acquire provisioned lock: %v", err)
	}
	_ = h.Release()
}

func TestLockProvisionPreservesHeldInode(t *testing.T) {
	dir := t.TempDir()
	vpsId := "vps-preserve-inode-test"

	// Initial provision
	if err := Provision(vpsId, WithDir(dir)); err != nil {
		t.Fatalf("initial provision failed: %v", err)
	}

	// Acquire lock
	h, err := Acquire(vpsId, WithDir(dir))
	if err != nil {
		t.Fatalf("acquire failed: %v", err)
	}
	defer h.Release()

	lockPath := h.Path()
	fi1, err := os.Stat(lockPath)
	if err != nil {
		t.Fatalf("stat 1 failed: %v", err)
	}

	// Re-run provision while lock is held (simulating upgrade helper runtime provisioning)
	if err := Provision(vpsId, WithDir(dir)); err != nil {
		t.Fatalf("second provision failed while held: %v", err)
	}

	fi2, err := os.Stat(lockPath)
	if err != nil {
		t.Fatalf("stat 2 failed: %v", err)
	}

	// File must not be replaced with a new inode
	if !os.SameFile(fi1, fi2) {
		t.Fatalf("Provision replaced existing lock file inode instead of preserving it")
	}

	// Lock must still be held exclusively
	_, err = Acquire(vpsId, WithDir(dir))
	if !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("expected ErrAlreadyRunning on held lock after provision, got: %v", err)
	}
}

func TestLockProvisionEmptyVPSID(t *testing.T) {
	if err := Provision(""); err == nil {
		t.Fatal("expected error for empty vpsId")
	}
	if err := Provision("   "); err == nil {
		t.Fatal("expected error for whitespace vpsId")
	}
}
