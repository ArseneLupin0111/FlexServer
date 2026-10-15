package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/lock"
)

func TestHelperProvisionsLockOnLegacyUpgrade(t *testing.T) {
	stateDir := t.TempDir()
	binDir := t.TempDir()
	lockDir := t.TempDir()
	tmpfilesDir := t.TempDir()
	agentConfigDir := t.TempDir()

	agentBin := filepath.Join(binDir, "vps-agent")
	oldContent := []byte("old-agent-binary-no-lock")
	writeFile(t, agentBin, oldContent, 0o755)

	vpsId := "vps-legacy-upgrade-uuid-1234"
	agentConfigPath := filepath.Join(agentConfigDir, "config.json")
	agentConfigData, err := json.Marshal(map[string]interface{}{
		"backendUrl": "http://127.0.0.1:38280",
		"vpsId":      vpsId,
		"token":      "vma_secret_token",
	})
	if err != nil {
		t.Fatalf("marshal agent config: %v", err)
	}
	writeFile(t, agentConfigPath, agentConfigData, 0o640)

	cfg := &Config{
		APIBase:          "https://example.com/agent",
		Credential:       "vma_test_root_cred",
		AgentBinary:      agentBin,
		AgentUnit:        "vps-agent.service",
		AgentConfig:      agentConfigPath,
		StateDir:         stateDir,
		HelperTimeoutSec: 30,
	}
	cfg.EnableTestOverrides()
	cfg.SetTestLockDir(lockDir)
	cfg.SetTestTmpfilesDir(tmpfilesDir)

	events := &eventLog{}
	buildID := "0123456789abcdef0123456789abcdef01234567"

	// Lock filename expected for this vpsId
	expectedLockFilename := lock.LockFilename(vpsId)
	expectedLockPath := filepath.Join(lockDir, expectedLockFilename)

	// Ensure lock does NOT exist prior to upgrade (legacy system state)
	if _, err := os.Stat(expectedLockPath); !os.IsNotExist(err) {
		t.Fatalf("expected lock file to not exist initially")
	}

	// Install seams: fakeSystemctl simulates new agent enforcing singleton lock
	oldExec, oldSys := execStagedVersion, runSystemctl
	oldWait, oldPoll := serviceActiveWait, servicePollEvery
	serviceActive := false
	execStagedVersion = func(_ context.Context, _ string) (string, error) {
		return "9.9.9+" + buildID, nil
	}
	runSystemctl = func(_ context.Context, args ...string) (string, error) {
		if len(args) > 0 && args[0] == "restart" {
			events.add("systemctl:restart")
			// The upgraded agent verifies lock existence on startup
			if _, err := os.Stat(expectedLockPath); err == nil {
				serviceActive = true
			} else {
				serviceActive = false
			}
			return "", nil
		}
		if len(args) > 0 && args[0] == "is-active" {
			if serviceActive {
				return "active", nil
			}
			return "inactive", nil
		}
		return "", nil
	}
	serviceActiveWait = 200 * time.Millisecond
	servicePollEvery = 20 * time.Millisecond
	t.Cleanup(func() {
		execStagedVersion, runSystemctl = oldExec, oldSys
		serviceActiveWait, servicePollEvery = oldWait, oldPoll
	})

	newContent := []byte("new-agent-binary-with-lock-enforcement")
	h := sha256.Sum256(newContent)
	targetSha := hex.EncodeToString(h[:])

	pubKey, privKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	doc := map[string]interface{}{
		"version":      "9.9.9",
		"buildId":      buildID,
		"targetSha256": targetSha,
		"size":         int64(len(newContent)),
	}
	canon, _ := json.Marshal(doc)
	sig := ed25519.Sign(privKey, canon)
	signedDoc := map[string]interface{}{
		"version":      "9.9.9",
		"buildId":      buildID,
		"targetSha256": targetSha,
		"size":         int64(len(newContent)),
		"signatures": []map[string]string{
			{
				"publicKey": hex.EncodeToString(pubKey),
				"signature": hex.EncodeToString(sig),
			},
		},
	}
	manifestBytes, _ := json.Marshal(signedDoc)

	jobID := "lug_lock_test"
	stg := stagingDir(stateDir, jobID)
	if err := os.MkdirAll(stg, 0o700); err != nil {
		t.Fatalf("mkdir staging: %v", err)
	}
	writeFile(t, filepath.Join(stg, "artifact.bin"), newContent, 0o755)
	writeFile(t, filepath.Join(stg, "manifest.signed"), manifestBytes, 0o644)

	meta := map[string]interface{}{
		"jobId":        jobID,
		"fencingToken": int64(100),
		"buildId":      buildID,
		"sha256":       targetSha,
		"size":         int64(len(newContent)),
	}
	metaBytes, _ := json.Marshal(meta)
	writeFile(t, filepath.Join(stg, "meta.json"), metaBytes, 0o644)

	job := &ClaimedJob{
		JobID:           jobID,
		Phase:           PhaseRestarting,
		FencingToken:    100,
		TargetSha256:    targetSha,
		TargetSizeBytes: int64(len(newContent)),
		LeaseExpiresAt:  FlexTime{Time: time.Now().Add(5 * time.Minute)},
		PhaseDeadlineAt: FlexTime{Time: time.Now().Add(5 * time.Minute)},
		DeadlineAt:      FlexTime{Time: time.Now().Add(5 * time.Minute)},
		Release: ReleaseInfo{
			BuildID:      buildID,
			TargetSha256: targetSha,
		},
	}
	authorizer := &fakeAPI{job: job}

	res := handleApply(context.Background(), cfg, authorizer, jobID)
	if res.Outcome != "restarted" {
		t.Fatalf("expected outcome 'restarted', got %q (detail: %s)", res.Outcome, res.Detail)
	}

	// 1. Verify lock file was provisioned
	fi, err := os.Stat(expectedLockPath)
	if err != nil {
		t.Fatalf("expected provisioned lock file at %s: %v", expectedLockPath, err)
	}
	if !fi.Mode().IsRegular() {
		t.Fatalf("expected regular file for lock, got: %v", fi.Mode())
	}

	// 2. Verify tmpfiles configuration was provisioned for reboot persistence
	tmpfilesConfPath := filepath.Join(tmpfilesDir, lock.TmpfilesDefaultConf)
	confContent, err := os.ReadFile(tmpfilesConfPath)
	if err != nil {
		t.Fatalf("expected tmpfiles configuration at %s: %v", tmpfilesConfPath, err)
	}
	confStr := string(confContent)
	if !strings.Contains(confStr, fmt.Sprintf("d %s 0755 root root -", lockDir)) {
		t.Fatalf("missing directory line in tmpfiles conf: %s", confStr)
	}
	if !strings.Contains(confStr, fmt.Sprintf("f %s 0666 root root -", expectedLockPath)) {
		t.Fatalf("missing lock file line in tmpfiles conf: %s", confStr)
	}

	// 3. Verify the agent binary was swapped to newContent
	gotBin, err := os.ReadFile(agentBin)
	if err != nil {
		t.Fatalf("read swapped agent bin: %v", err)
	}
	if string(gotBin) != string(newContent) {
		t.Fatalf("agent binary was not swapped")
	}
}

func TestHelperPreservesExistingHeldLockInode(t *testing.T) {
	stateDir := t.TempDir()
	binDir := t.TempDir()
	lockDir := t.TempDir()
	tmpfilesDir := t.TempDir()
	agentConfigDir := t.TempDir()

	agentBin := filepath.Join(binDir, "vps-agent")
	writeFile(t, agentBin, []byte("old-binary"), 0o755)

	vpsId := "vps-preserve-inode-helper"
	agentConfigPath := filepath.Join(agentConfigDir, "config.json")
	agentConfigData, _ := json.Marshal(map[string]interface{}{
		"backendUrl": "http://127.0.0.1:38280",
		"vpsId":      vpsId,
		"token":      "vma_secret_token",
	})
	writeFile(t, agentConfigPath, agentConfigData, 0o640)

	cfg := &Config{
		APIBase:          "https://example.com/agent",
		Credential:       "vma_test_root_cred",
		AgentBinary:      agentBin,
		AgentUnit:        "vps-agent.service",
		AgentConfig:      agentConfigPath,
		StateDir:         stateDir,
		HelperTimeoutSec: 30,
	}
	cfg.EnableTestOverrides()
	cfg.SetTestLockDir(lockDir)
	cfg.SetTestTmpfilesDir(tmpfilesDir)

	// Pre-provision and acquire lock
	if err := lock.Provision(vpsId, lock.WithDir(lockDir), lock.WithTmpfilesDir(tmpfilesDir)); err != nil {
		t.Fatalf("pre-provision failed: %v", err)
	}
	h1, err := lock.Acquire(vpsId, lock.WithDir(lockDir))
	if err != nil {
		t.Fatalf("acquire failed: %v", err)
	}
	defer h1.Release()

	fi1, err := os.Stat(h1.Path())
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}

	// Staging setup for apply
	newContent := []byte("new-binary-content-456")
	h := sha256.Sum256(newContent)
	targetSha := hex.EncodeToString(h[:])
	buildID := "fedcba9876543210fedcba9876543210fedcba98"

	pubKey, privKey, _ := ed25519.GenerateKey(nil)
	canon, _ := json.Marshal(map[string]interface{}{
		"version":      "9.9.9",
		"buildId":      buildID,
		"targetSha256": targetSha,
		"size":         int64(len(newContent)),
	})
	sig := ed25519.Sign(privKey, canon)
	manifestBytes, _ := json.Marshal(map[string]interface{}{
		"version":      "9.9.9",
		"buildId":      buildID,
		"targetSha256": targetSha,
		"size":         int64(len(newContent)),
		"signatures": []map[string]string{
			{"publicKey": hex.EncodeToString(pubKey), "signature": hex.EncodeToString(sig)},
		},
	})

	jobID := "lug_lock_preserve"
	stg := stagingDir(stateDir, jobID)
	_ = os.MkdirAll(stg, 0o700)
	writeFile(t, filepath.Join(stg, "artifact.bin"), newContent, 0o755)
	writeFile(t, filepath.Join(stg, "manifest.signed"), manifestBytes, 0o644)
	metaBytes, _ := json.Marshal(map[string]interface{}{
		"jobId": jobID, "fencingToken": int64(101), "buildId": buildID, "sha256": targetSha, "size": int64(len(newContent)),
	})
	writeFile(t, filepath.Join(stg, "meta.json"), metaBytes, 0o644)

	oldExec, oldSys := execStagedVersion, runSystemctl
	oldWait, oldPoll := serviceActiveWait, servicePollEvery
	execStagedVersion = func(_ context.Context, _ string) (string, error) { return "9.9.9+" + buildID, nil }
	runSystemctl = func(_ context.Context, args ...string) (string, error) {
		if len(args) > 0 && args[0] == "is-active" {
			return "active", nil
		}
		return "", nil
	}
	serviceActiveWait = 200 * time.Millisecond
	servicePollEvery = 20 * time.Millisecond
	t.Cleanup(func() {
		execStagedVersion, runSystemctl = oldExec, oldSys
		serviceActiveWait, servicePollEvery = oldWait, oldPoll
	})

	job := &ClaimedJob{
		JobID:           jobID,
		Phase:           PhaseRestarting,
		FencingToken:    101,
		TargetSha256:    targetSha,
		TargetSizeBytes: int64(len(newContent)),
		LeaseExpiresAt:  FlexTime{Time: time.Now().Add(5 * time.Minute)},
		PhaseDeadlineAt: FlexTime{Time: time.Now().Add(5 * time.Minute)},
		DeadlineAt:      FlexTime{Time: time.Now().Add(5 * time.Minute)},
		Release:         ReleaseInfo{BuildID: buildID, TargetSha256: targetSha},
	}
	authorizer := &fakeAPI{job: job}

	res := handleApply(context.Background(), cfg, authorizer, jobID)
	if res.Outcome != "restarted" {
		t.Fatalf("expected restarted, got: %s (detail: %s)", res.Outcome, res.Detail)
	}

	fi2, err := os.Stat(h1.Path())
	if err != nil {
		t.Fatalf("stat 2 failed: %v", err)
	}
	if !os.SameFile(fi1, fi2) {
		t.Fatalf("lock file inode was replaced during upgrade apply")
	}
}
