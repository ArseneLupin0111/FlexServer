package applications

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHostLockSystemUpgradeMutualExclusion(t *testing.T) {
	stateDir := t.TempDir()

	// 1. Regular scope is active (simulating busy host workload)
	err := AcquireHostScopeAt(stateDir, "project:test-proj", "compose-operation", "comp-1", false, time.Minute)
	if err != nil {
		t.Fatalf("acquire regular scope: %v", err)
	}

	// 2. Under immediate disruptive update policy, system:upgrade succeeds even with active workload
	err = AcquireHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-1", true, 0)
	if err != nil {
		t.Fatalf("expected system:upgrade to succeed immediately with active regular scope, got: %v", err)
	}

	// 3. system:upgrade blocks every other scope
	testScopes := []struct {
		scope string
		kind  string
		id    string
	}{
		{"project:p1", "compose-operation", "c1"},
		{"container:cnt1", "container-command", "cc1"},
		{"terminal:term1", "host-pty", "term1"},
		{"ai:task1", "ai-host-helper", "task1"},
	}

	for _, tc := range testScopes {
		t.Run("blocks_"+tc.scope, func(t *testing.T) {
			err := AcquireHostScopeAt(stateDir, tc.scope, tc.kind, tc.id, false, time.Minute)
			if err == nil || !strings.Contains(err.Error(), "scope_busy") {
				t.Fatalf("expected scope_busy for %s while system:upgrade active, got: %v", tc.scope, err)
			}
		})
	}

	// 4. system:upgrade blocks another upgrade job
	err = AcquireHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-2", true, 0)
	if err == nil || !strings.Contains(err.Error(), "scope_busy") {
		t.Fatalf("expected scope_busy for another upgrade job, got: %v", err)
	}

	// 5. Release system:upgrade
	err = ReleaseHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-1")
	if err != nil {
		t.Fatalf("release system:upgrade: %v", err)
	}

	// 6. Regular scopes can now be acquired
	err = AcquireHostScopeAt(stateDir, "terminal:term1", "host-pty", "term1", true, 0)
	if err != nil {
		t.Fatalf("acquire terminal scope after upgrade released: %v", err)
	}
	_ = ReleaseHostScopeAt(stateDir, "terminal:term1", "host-pty", "term1")
}

func TestHostLockExactOwnerReentry(t *testing.T) {
	stateDir := t.TempDir()

	// Acquire system:upgrade
	err := AcquireHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-42", true, 0)
	if err != nil {
		t.Fatalf("initial acquire: %v", err)
	}

	// Exact owner re-entry succeeds
	err = AcquireHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-42", true, 0)
	if err != nil {
		t.Fatalf("exact owner re-entry must succeed, got: %v", err)
	}

	// Different holder id fails
	err = AcquireHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-99", true, 0)
	if err == nil || !strings.Contains(err.Error(), "scope_busy") {
		t.Fatalf("different holder id must fail, got: %v", err)
	}

	// Release
	err = ReleaseHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-42")
	if err != nil {
		t.Fatalf("release: %v", err)
	}
}

func TestHostLockNonExpiringMutatingFence(t *testing.T) {
	stateDir := t.TempDir()

	// Acquire mutating non-expiring lock (ttl = 0)
	err := AcquireHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-mut", true, 0)
	if err != nil {
		t.Fatalf("acquire mutating fence: %v", err)
	}

	// Read registry file directly to inspect fields
	regPath := filepath.Join(stateDir, "docker-applications", "exclusion.json")
	b, err := os.ReadFile(regPath)
	if err != nil {
		t.Fatalf("read registry: %v", err)
	}

	var rows []LockRow
	if err := json.Unmarshal(b, &rows); err != nil {
		t.Fatalf("unmarshal registry: %v", err)
	}
	if len(rows) != 1 || !rows[0].Mutating || rows[0].ExpiresAtUnix != 0 {
		t.Fatalf("expected 1 mutating non-expiring row, got: %+v", rows)
	}

	// Ensure another process still cannot acquire after some time
	err = AcquireHostScopeAt(stateDir, "project:p1", "compose-operation", "c1", false, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "scope_busy") {
		t.Fatalf("mutating fence must not expire, got: %v", err)
	}

	_ = ReleaseHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-mut")
}

func TestHostLockStaleActivityReconciledByPID(t *testing.T) {
	stateDir := t.TempDir()

	// Inject a dead PID lock with non-upgrade scope
	overrideLockTestHooks(
		func() int64 { return 1000 },
		func(pid int, recordedStart int64) bool {
			// Fake alive check: PID 999999 is dead
			return pid != 999999
		},
	)
	defer resetLockTestHooks()

	// Directly write a registry file with a stale process lock
	regDir := filepath.Join(stateDir, "docker-applications")
	if err := os.MkdirAll(regDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	regPath := filepath.Join(regDir, "exclusion.json")
	staleJSON := `[{"scope":"terminal:dead-term","holder":{"kind":"host-pty","id":"dead-term","pid":999999,"processStartTime":500},"mutating":true}]`
	if err := os.WriteFile(regPath, []byte(staleJSON), 0644); err != nil {
		t.Fatalf("write stale registry: %v", err)
	}

	// Acquiring system:upgrade should detect PID 999999 is dead, purge stale row, and succeed!
	err := AcquireHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-reconcile", true, 0)
	if err != nil {
		t.Fatalf("expected acquire to purge dead PID and succeed, got: %v", err)
	}

	_ = ReleaseHostScopeAt(stateDir, LockScopeUpgrade, "updater-helper", "job-reconcile")
}

func TestHostLockMutatingComposeDeadOwnerRetained(t *testing.T) {
	stateDir := t.TempDir()

	overrideLockTestHooks(
		func() int64 { return 1000 },
		func(pid int, recordedStart int64) bool {
			return pid != 999999 // PID 999999 is dead
		},
	)
	defer resetLockTestHooks()

	regDir := filepath.Join(stateDir, "docker-applications")
	if err := os.MkdirAll(regDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	regPath := filepath.Join(regDir, "exclusion.json")
	// Mutating compose project row with dead holder PID:
	staleJSON := `[{"scope":"project:crashed-proj","holder":{"kind":"compose-operation","id":"crash-1","pid":999999,"processStartTime":500},"mutating":true}]`
	if err := os.WriteFile(regPath, []byte(staleJSON), 0644); err != nil {
		t.Fatalf("write stale registry: %v", err)
	}

	// Acquiring the same project scope MUST still be blocked because crashed compose mutating lock requires explicit reconcile!
	err := AcquireHostScopeAt(stateDir, "project:crashed-proj", "compose-operation", "comp-check", true, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "scope_busy") {
		t.Fatalf("expected scope_busy for crashed mutating compose row, got: %v", err)
	}
}

func TestHostLockSymlinkRejected(t *testing.T) {
	stateDir := t.TempDir()
	regDir := filepath.Join(stateDir, "docker-applications")
	if err := os.MkdirAll(regDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	targetFile := filepath.Join(stateDir, "target.json")
	if err := os.WriteFile(targetFile, []byte("[]"), 0644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	regPath := filepath.Join(regDir, "exclusion.json")
	if err := os.Symlink(targetFile, regPath); err != nil {
		t.Skipf("symlinks not supported on this platform/privilege: %v", err)
	}

	err := AcquireHostScopeAt(stateDir, "project:test-symlink", "compose-op", "1", true, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "symlink not allowed") {
		t.Fatalf("expected symlink rejection error, got: %v", err)
	}
}
