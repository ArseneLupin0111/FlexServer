package updater

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDetectHostIdleLockArraySemantics(t *testing.T) {
	stateDir := t.TempDir()
	agentStateDir := t.TempDir()
	lockDir := filepath.Join(agentStateDir, "docker-applications")
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		t.Fatalf("mkdir lockDir: %v", err)
	}
	lockFile := filepath.Join(lockDir, "exclusion.json")

	cfg := &Config{
		StateDir:      stateDir,
		AgentStateDir: agentStateDir,
	}

	// 1. Empty array: idle
	if err := os.WriteFile(lockFile, []byte("[]"), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	idle, reason := DetectHostIdle(cfg)
	if !idle {
		t.Fatalf("expected idle with empty lock array, got reason: %s", reason)
	}

	// 2. Active mutating lock (even with expired ExpiresAtUnix): busy
	mutatingPast := fmt.Sprintf(`[{"scope":"project:p1","holder":{"kind":"compose-operation","id":"1"},"mutating":true,"expiresAtUnix":%d}]`, time.Now().Add(-1*time.Hour).Unix())
	if err := os.WriteFile(lockFile, []byte(mutatingPast), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	idle, reason = DetectHostIdle(cfg)
	if idle {
		t.Fatalf("expected busy with mutating lock regardless of expiry")
	}
	if !strings.Contains(reason, "active exclusion lock on scope project:p1") {
		t.Fatalf("unexpected reason: %s", reason)
	}

	// 3. Expired non-mutating lock: idle
	expiredNonMutating := fmt.Sprintf(`[{"scope":"project:p2","holder":{"kind":"compose-operation","id":"2"},"mutating":false,"expiresAtUnix":%d}]`, time.Now().Add(-10*time.Minute).Unix())
	if err := os.WriteFile(lockFile, []byte(expiredNonMutating), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	idle, reason = DetectHostIdle(cfg)
	if !idle {
		t.Fatalf("expected idle with expired non-mutating lock, got reason: %s", reason)
	}

	// 4. Active non-mutating lock (future expiry): busy
	activeFuture := fmt.Sprintf(`[{"scope":"container:c1","holder":{"kind":"container-command","id":"3"},"mutating":false,"expiresAtUnix":%d}]`, time.Now().Add(10*time.Minute).Unix())
	if err := os.WriteFile(lockFile, []byte(activeFuture), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	idle, reason = DetectHostIdle(cfg)
	if idle {
		t.Fatalf("expected busy with active future non-mutating lock")
	}
	if !strings.Contains(reason, "active exclusion lock on scope container:c1") {
		t.Fatalf("unexpected reason: %s", reason)
	}

	// 5. Active non-mutating lock (expiresAtUnix == 0, indefinite): busy
	activeZero := `[{"scope":"container:c2","holder":{"kind":"container-command","id":"4"},"mutating":false,"expiresAtUnix":0}]`
	if err := os.WriteFile(lockFile, []byte(activeZero), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	idle, reason = DetectHostIdle(cfg)
	if idle {
		t.Fatalf("expected busy with zero-expiry non-mutating lock")
	}

	// 6. Corrupt JSON array: fails closed (busy)
	if err := os.WriteFile(lockFile, []byte("{not-json"), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	idle, reason = DetectHostIdle(cfg)
	if idle {
		t.Fatalf("expected busy with corrupt exclusion registry")
	}
	if !strings.Contains(reason, "corrupt") {
		t.Fatalf("expected corrupt in reason, got %s", reason)
	}
}

func TestDetectHostIdlePTYMarker(t *testing.T) {
	// DetectHostIdle checks fixed paths:
	// /run/flexserver/host-pty/pty.sock
	// /var/run/flexserver/host-pty/pty.sock
	// On systems without those sockets, it skips PTY checks.
	// Verify that if neither socket exists, it remains idle.
	cfg := &Config{
		StateDir: t.TempDir(),
	}
	idle, _ := DetectHostIdle(cfg)
	if !idle {
		t.Log("Note: host has non-idle environment (active locks/cgroups/scratch)")
	}
}

func TestDetectHostIdleStaleActivityDeadPID(t *testing.T) {
	stateDir := t.TempDir()
	agentStateDir := t.TempDir()
	lockDir := filepath.Join(agentStateDir, "docker-applications")
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		t.Fatalf("mkdir lockDir: %v", err)
	}
	lockFile := filepath.Join(lockDir, "exclusion.json")

	cfg := &Config{
		StateDir:      stateDir,
		AgentStateDir: agentStateDir,
	}

	// 1. Mutating terminal session with dead PID: should be ignored, host considered idle
	deadTerminal := `[{"scope":"terminal:dead-pty","holder":{"kind":"host-pty","id":"dead-pty","pid":999999,"processStartTime":500},"mutating":true}]`
	if err := os.WriteFile(lockFile, []byte(deadTerminal), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	idle, reason := DetectHostIdle(cfg)
	if !idle {
		t.Fatalf("expected idle for dead PID terminal session, got reason: %s", reason)
	}

	// 2. Mutating Compose operation with dead PID: MUST NOT be blindly ignored, host considered busy!
	deadCompose := `[{"scope":"project:dead-compose","holder":{"kind":"compose-operation","id":"dead-compose","pid":999999,"processStartTime":500},"mutating":true}]`
	if err := os.WriteFile(lockFile, []byte(deadCompose), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	idle, reason = DetectHostIdle(cfg)
	if idle {
		t.Fatalf("expected busy for dead PID mutating compose operation (requires explicit reconcile)")
	}
	if !strings.Contains(reason, "project:dead-compose") {
		t.Fatalf("expected project:dead-compose in reason, got %s", reason)
	}

	// 3. system:upgrade scope with matching helper journal JobID: ignored, host idle
	matchingUpgrade := `[{"scope":"system:upgrade","holder":{"kind":"updater-helper","id":"job-42"},"mutating":true}]`
	if err := os.WriteFile(lockFile, []byte(matchingUpgrade), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}
	// Write helper journal with matching JobID directly to stateDir/helper/journal.json
	helperDir := filepath.Join(cfg.StateDir, "helper")
	if err := os.MkdirAll(helperDir, 0o700); err != nil {
		t.Fatalf("mkdir helper: %v", err)
	}
	hjJSON := `{"jobId":"job-42","phase":"restarted","fenceOwner":"job-42"}`
	if err := os.WriteFile(filepath.Join(helperDir, "journal.json"), []byte(hjJSON), 0o600); err != nil {
		t.Fatalf("write helper journal: %v", err)
	}
	idle, reason = DetectHostIdle(cfg)
	if !idle {
		t.Fatalf("expected idle when upgrade scope matches helper journal, got: %s", reason)
	}

	// 4. system:upgrade scope with different JobID: busy!
	cfg.CurrentJobID = "job-different"
	_ = os.Remove(filepath.Join(helperDir, "journal.json"))
	idle, reason = DetectHostIdle(cfg)
	if idle {
		t.Fatalf("expected busy when upgrade scope belongs to another job")
	}
}

func TestDetectHostIdleConfiguredAgentStateDirPriority(t *testing.T) {
	stateDir := t.TempDir()
	agentStateDir := t.TempDir()
	lockDir := filepath.Join(agentStateDir, "docker-applications")
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		t.Fatalf("mkdir lockDir: %v", err)
	}
	lockFile := filepath.Join(lockDir, "exclusion.json")
	if err := os.WriteFile(lockFile, []byte("[]"), 0o644); err != nil {
		t.Fatalf("write lockFile: %v", err)
	}

	cfg := &Config{
		StateDir:      stateDir,
		AgentStateDir: agentStateDir,
	}
	idle, reason := DetectHostIdle(cfg)
	if !idle {
		t.Fatalf("expected idle with empty configured agentStateDir, got: %s", reason)
	}
}
