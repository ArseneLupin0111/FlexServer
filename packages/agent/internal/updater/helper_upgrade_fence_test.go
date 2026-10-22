package updater

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/applications"
)

func TestHelperUpgradeFenceBlocksActivityAndDefers(t *testing.T) {
	stateDir := t.TempDir()
	binDir := t.TempDir()
	agentBin := filepath.Join(binDir, "vps-agent")
	_ = os.WriteFile(agentBin, []byte("old-binary"), 0o755)

	cfg := &Config{
		StateDir:      stateDir,
		AgentStateDir: stateDir,
		AgentBinary:   agentBin,
		testMode:      true,
	}

	jobID := "test_fence_job_1"

	// 1. Hold an active terminal scope
	err := applications.AcquireHostScopeAt(stateDir, "terminal:session-123", "host-pty", "session-123", true, 0)
	if err != nil {
		t.Fatalf("acquire terminal scope: %v", err)
	}

	// 2. Attempting to acquire upgrade fence should fail with scope_busy
	err = acquireUpgradeFence(cfg, jobID)
	if err == nil || !strings.Contains(err.Error(), "scope_busy") {
		t.Fatalf("expected scope_busy while terminal active, got: %v", err)
	}

	// 3. DetectHostIdle should report busy
	idle, reason := DetectHostIdle(cfg)
	if idle {
		t.Fatalf("expected host to be busy, got idle")
	}
	if !strings.Contains(reason, "terminal") && !strings.Contains(reason, "exclusion") {
		t.Fatalf("expected busy reason to mention terminal or exclusion, got: %s", reason)
	}

	// 4. Release terminal scope
	err = applications.ReleaseHostScopeAt(stateDir, "terminal:session-123", "host-pty", "session-123")
	if err != nil {
		t.Fatalf("release terminal scope: %v", err)
	}

	// 5. Upgrade fence can now be acquired
	err = acquireUpgradeFence(cfg, jobID)
	if err != nil {
		t.Fatalf("acquire upgrade fence: %v", err)
	}

	// 6. While upgrade fence is held, terminal acquisition must fail
	err = applications.AcquireHostScopeAt(stateDir, "terminal:session-456", "host-pty", "session-456", true, 0)
	if err == nil || !strings.Contains(err.Error(), "scope_busy") {
		t.Fatalf("expected scope_busy for new terminal while upgrade fence active, got: %v", err)
	}

	// 7. DetectHostIdle with CurrentJobID set to jobID should NOT block on its own upgrade fence
	cfg.CurrentJobID = jobID
	idle, reason = DetectHostIdle(cfg)
	if !idle {
		t.Fatalf("DetectHostIdle must ignore own upgrade fence, got busy: %s", reason)
	}

	// 8. Release upgrade fence
	err = releaseUpgradeFence(cfg, jobID)
	if err != nil {
		t.Fatalf("release upgrade fence: %v", err)
	}

	// 9. Terminal acquisition now succeeds again
	err = applications.AcquireHostScopeAt(stateDir, "terminal:session-456", "host-pty", "session-456", true, 0)
	if err != nil {
		t.Fatalf("terminal acquisition after fence release: %v", err)
	}
	_ = applications.ReleaseHostScopeAt(stateDir, "terminal:session-456", "host-pty", "session-456")
}

func TestHelperCleanupReleasesOnlyOwnTerminalRecoveryFence(t *testing.T) {
	stateDir := t.TempDir()
	binDir := t.TempDir()
	agentBin := filepath.Join(binDir, "vps-agent")
	_ = os.WriteFile(agentBin, []byte("old-binary"), 0o755)

	cfg := &Config{
		StateDir:      stateDir,
		AgentStateDir: stateDir,
		AgentBinary:   agentBin,
		testMode:      true,
	}

	jobID := "job_cleanup_fence"

	// Acquire fence as jobID
	if err := acquireUpgradeFence(cfg, jobID); err != nil {
		t.Fatalf("acquire fence: %v", err)
	}
	if err := os.MkdirAll(helperRoot(stateDir), 0o755); err != nil {
		t.Fatalf("mkdir helperRoot: %v", err)
	}
	// Save journal with FenceOwner
	hj := &HelperJournal{
		JobID:      jobID,
		Phase:      hjRolledBack,
		FenceOwner: jobID,
	}
	if err := saveHelperJournal(cfg.StateDir, hj); err != nil {
		t.Fatalf("save journal: %v", err)
	}

	// Run handleCleanup for jobID
	ctx := context.Background()
	res := handleCleanup(ctx, cfg, jobID)
	if res.Outcome != "cleaned" {
		t.Fatalf("expected outcome 'cleaned', got: %s (%s)", res.Outcome, res.Detail)
	}

	// Fence should now be released, so another scope can be acquired
	err := applications.AcquireHostScopeAt(stateDir, "project:post-cleanup", "compose-operation", "p1", false, time.Minute)
	if err != nil {
		t.Fatalf("expected fence to be released after cleanup, got: %v", err)
	}
	_ = applications.ReleaseHostScopeAt(stateDir, "project:post-cleanup", "compose-operation", "p1")
}
