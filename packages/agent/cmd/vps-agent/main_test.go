package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/config"
	"github.com/vps-manager/agent/internal/lock"
)

var (
	testBinaryPath string
	buildOnce      sync.Once
	buildErr       error
)

func getAgentBinary(t *testing.T) string {
	buildOnce.Do(func() {
		tmpDir, err := os.MkdirTemp("", "vps-agent-test-bin-*")
		if err != nil {
			buildErr = err
			return
		}
		binName := "vps-agent-test"
		if runtime.GOOS == "windows" {
			binName += ".exe"
		}
		testBinaryPath = filepath.Join(tmpDir, binName)
		cmd := exec.Command("go", "build", "-o", testBinaryPath, ".")
		cmd.Dir = "."
		out, err := cmd.CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("go build failed: %w (output: %s)", err, string(out))
		}
	})
	if buildErr != nil {
		t.Fatalf("failed to build vps-agent binary for tests: %v", buildErr)
	}
	return testBinaryPath
}

func writeConfigFile(t *testing.T, dir, filename string, cfg *config.Config) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	path := filepath.Join(dir, filename)
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write config file: %v", err)
	}
	return path
}

func startMockServer(reqCount *atomic.Int64) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reqCount != nil {
			reqCount.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": map[string]interface{}{
				"status": "ok",
			},
		})
	}))
}

// canRunCLILockTests checks whether the current environment has permission to acquire
// the production host lock (root required on Linux for /run/vps-manager-agent; supported on Windows/other).
func canRunCLILockTests(t *testing.T) bool {
	if runtime.GOOS != "linux" {
		return true
	}
	if os.Geteuid() == 0 {
		return true
	}
	// On unprivileged Linux, test if /run/vps-manager-agent was pre-provisioned by root
	fi, err := os.Stat("/run/vps-manager-agent")
	if err == nil && fi.IsDir() {
		return true
	}
	return false
}

// TestValidateConfigOffline tests the -validate-config flag.
// It verifies that:
// 1. Valid config exits 0 without contacting network, creating lock files, or mutating state.
// 2. Invalid config exits non-zero.
// 3. Staged preflight using -validate-config succeeds even when another instance holds the lock for that VPS.
func TestValidateConfigOffline(t *testing.T) {
	bin := getAgentBinary(t)
	configDir := t.TempDir()
	stateDir := t.TempDir()
	statePath := filepath.Join(stateDir, "state.json")

	var reqCount atomic.Int64
	server := startMockServer(&reqCount)
	defer server.Close()

	vpsId := fmt.Sprintf("vps-val-%d-%d", os.Getpid(), time.Now().UnixNano())
	lockPath := lock.LockPath(vpsId)
	t.Cleanup(func() { _ = os.Remove(lockPath) })

	validCfg := &config.Config{
		BackendUrl:            server.URL,
		VpsId:                 vpsId,
		Token:                 "token-xyz",
		IntervalSeconds:       5,
		RequestTimeoutSeconds: 10,
		StatePath:             statePath,
	}
	validConfigPath := writeConfigFile(t, configDir, "valid.json", validCfg)

	// 1. Valid config should exit 0
	cmd := exec.Command(bin, "-config", validConfigPath, "-validate-config")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("expected -validate-config to succeed, failed with: %v (output: %s)", err, string(out))
	}

	// Network proof: backend server must receive ZERO requests
	if got := reqCount.Load(); got != 0 {
		t.Fatalf("expected 0 HTTP requests during -validate-config, got %d", got)
	}

	// State proof: state file must NOT be created
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("expected state file NOT to exist after -validate-config, but found: %s", statePath)
	}

	// Lock proof: lock file must NOT be created by -validate-config
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("expected lock file NOT to exist for -validate-config, but found: %s", lockPath)
	}

	// 2. Invalid config should exit non-zero
	invalidConfigPath := filepath.Join(configDir, "invalid.json")
	if err := os.WriteFile(invalidConfigPath, []byte(`{"vpsId": ""}`), 0o600); err != nil {
		t.Fatalf("write invalid config: %v", err)
	}
	cmdBad := exec.Command(bin, "-config", invalidConfigPath, "-validate-config")
	if err := cmdBad.Run(); err == nil {
		t.Fatal("expected -validate-config to fail on invalid config, but succeeded")
	}

	// 3. -validate-config while continuous daemon holds the lock
	if canRunCLILockTests(t) {
		h, err := lock.Acquire(validCfg.VpsId)
		if err != nil {
			t.Logf("skipping while-locked assertion: could not acquire production lock: %v", err)
		} else {
			defer h.Release()

			cmdWhileLocked := exec.Command(bin, "-config", validConfigPath, "-validate-config")
			outLocked, errLocked := cmdWhileLocked.CombinedOutput()
			if errLocked != nil {
				t.Fatalf("expected -validate-config to succeed even when lock is held by live daemon, failed: %v (output: %s)", errLocked, string(outLocked))
			}
		}
	}
}

// TestSameVPSContentionAcrossPaths tests that two agent instances configured for the same VPS ID,
// running from different binary paths or different config file locations, contend on the exact same lock
// and the competing instance fails closed.
func TestSameVPSContentionAcrossPaths(t *testing.T) {
	if !canRunCLILockTests(t) {
		t.Skip("skipping CLI daemon test on unprivileged Linux (covered by root smoke tests)")
	}

	bin := getAgentBinary(t)
	server := startMockServer(nil)
	defer server.Close()

	vpsId := fmt.Sprintf("vps-contention-%d-%d", os.Getpid(), time.Now().UnixNano())
	lockPath := lock.LockPath(vpsId)
	t.Cleanup(func() { _ = os.Remove(lockPath) })

	// Path A: simulating /home/user/.vps-manager-agent/config.json
	dirA := filepath.Join(t.TempDir(), "pathA")
	cfgA := &config.Config{
		BackendUrl:            server.URL,
		VpsId:                 vpsId,
		Token:                 "token-a",
		IntervalSeconds:       1,
		RequestTimeoutSeconds: 5,
	}
	configPathA := writeConfigFile(t, dirA, "config.json", cfgA)

	// Path B: simulating /tmp/staged-vps-agent/config.json (different directory and binary path)
	dirB := filepath.Join(t.TempDir(), "pathB")
	cfgB := &config.Config{
		BackendUrl:            server.URL,
		VpsId:                 vpsId,
		Token:                 "token-b",
		IntervalSeconds:       1,
		RequestTimeoutSeconds: 5,
	}
	configPathB := writeConfigFile(t, dirB, "config.json", cfgB)

	// Copy binary to dirB to simulate distinct binary paths
	binB := filepath.Join(dirB, filepath.Base(bin))
	binData, err := os.ReadFile(bin)
	if err != nil {
		t.Fatalf("read binary: %v", err)
	}
	if err := os.WriteFile(binB, binData, 0o755); err != nil {
		t.Fatalf("copy binary to pathB: %v", err)
	}

	// Start Instance 1 with Config A in background
	cmd1 := exec.Command(bin, "-config", configPathA)
	stderr1, err := cmd1.StderrPipe()
	if err != nil {
		t.Fatalf("stderr pipe: %v", err)
	}
	if err := cmd1.Start(); err != nil {
		t.Fatalf("start cmd1: %v", err)
	}
	defer func() {
		_ = cmd1.Process.Kill()
		_ = cmd1.Wait()
	}()

	// Wait for Instance 1 to acquire the lock and start
	reader1 := bufio.NewReader(stderr1)
	started := false
	for i := 0; i < 20; i++ {
		line, err := reader1.ReadString('\n')
		if err != nil {
			break
		}
		if strings.Contains(line, "starting agent") || strings.Contains(line, "mode: loop") {
			started = true
			break
		}
	}
	if !started {
		t.Fatal("instance 1 did not start in time")
	}

	// Verify lock file exists at the fixed host path
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("expected lock file at %s: %v", lockPath, err)
	}

	// Start Instance 2 with Config B and Binary B for the same VPS ID.
	// It MUST fail closed immediately due to lock contention.
	cmd2 := exec.Command(binB, "-config", configPathB)
	out2, err2 := cmd2.CombinedOutput()
	if err2 == nil {
		t.Fatal("expected instance 2 to fail closed with lock error, but it exited 0")
	}
	if !strings.Contains(string(out2), "instance lock error") || !strings.Contains(string(out2), "agent already running for this VPS") {
		t.Fatalf("expected lock contention error message, got: %s", string(out2))
	}

	// Also test that running -once with Instance 2 also fails closed while Instance 1 is running
	cmdOnce := exec.Command(binB, "-config", configPathB, "-once")
	outOnce, errOnce := cmdOnce.CombinedOutput()
	if errOnce == nil {
		t.Fatal("expected -once to fail closed while daemon is running, but exited 0")
	}
	if !strings.Contains(string(outOnce), "instance lock error") {
		t.Fatalf("expected -once lock contention error message, got: %s", string(outOnce))
	}
}

// TestDifferentVPSIsolation tests that two agent instances for different VPS IDs
// run concurrently on the same host without any contention.
func TestDifferentVPSIsolation(t *testing.T) {
	if !canRunCLILockTests(t) {
		t.Skip("skipping CLI daemon test on unprivileged Linux (covered by root smoke tests)")
	}

	bin := getAgentBinary(t)
	server := startMockServer(nil)
	defer server.Close()

	vps1 := fmt.Sprintf("vps-iso-1-%d-%d", os.Getpid(), time.Now().UnixNano())
	vps2 := fmt.Sprintf("vps-iso-2-%d-%d", os.Getpid(), time.Now().UnixNano())

	lockPath1 := lock.LockPath(vps1)
	lockPath2 := lock.LockPath(vps2)
	t.Cleanup(func() {
		_ = os.Remove(lockPath1)
		_ = os.Remove(lockPath2)
	})

	cfg1 := &config.Config{
		BackendUrl:            server.URL,
		VpsId:                 vps1,
		Token:                 "token-1",
		IntervalSeconds:       1,
		RequestTimeoutSeconds: 5,
	}
	cfg2 := &config.Config{
		BackendUrl:            server.URL,
		VpsId:                 vps2,
		Token:                 "token-2",
		IntervalSeconds:       1,
		RequestTimeoutSeconds: 5,
	}

	path1 := writeConfigFile(t, t.TempDir(), "config1.json", cfg1)
	path2 := writeConfigFile(t, t.TempDir(), "config2.json", cfg2)

	cmd1 := exec.Command(bin, "-config", path1)
	stderr1, err := cmd1.StderrPipe()
	if err != nil {
		t.Fatalf("stderr1 pipe: %v", err)
	}
	if err := cmd1.Start(); err != nil {
		t.Fatalf("start cmd1: %v", err)
	}
	defer func() {
		_ = cmd1.Process.Kill()
		_ = cmd1.Wait()
	}()

	reader1 := bufio.NewReader(stderr1)
	for i := 0; i < 20; i++ {
		line, err := reader1.ReadString('\n')
		if err != nil {
			break
		}
		if strings.Contains(line, "starting agent") || strings.Contains(line, "mode: loop") {
			break
		}
	}

	cmd2 := exec.Command(bin, "-config", path2)
	stderr2, err := cmd2.StderrPipe()
	if err != nil {
		t.Fatalf("stderr2 pipe: %v", err)
	}
	if err := cmd2.Start(); err != nil {
		t.Fatalf("start cmd2: %v", err)
	}
	defer func() {
		_ = cmd2.Process.Kill()
		_ = cmd2.Wait()
	}()

	reader2 := bufio.NewReader(stderr2)
	started2 := false
	for i := 0; i < 20; i++ {
		line, err := reader2.ReadString('\n')
		if err != nil {
			break
		}
		if strings.Contains(line, "starting agent") || strings.Contains(line, "mode: loop") {
			started2 = true
			break
		}
	}
	if !started2 {
		t.Fatal("instance 2 failed to start concurrently with instance 1 for different VPS")
	}

	// Verify two distinct lock files exist
	if lockPath1 == lockPath2 {
		t.Fatalf("expected different lock paths, got identical: %s", lockPath1)
	}
	if _, err := os.Stat(lockPath1); err != nil {
		t.Fatalf("lockPath1 missing: %v", err)
	}
	if _, err := os.Stat(lockPath2); err != nil {
		t.Fatalf("lockPath2 missing: %v", err)
	}
}

// TestLockReleaseOnProcessTermination verifies that after an agent process terminates,
// the OS lock is cleanly released and a new instance can immediately start.
func TestLockReleaseOnProcessTermination(t *testing.T) {
	if !canRunCLILockTests(t) {
		t.Skip("skipping CLI daemon test on unprivileged Linux (covered by root smoke tests)")
	}

	bin := getAgentBinary(t)
	server := startMockServer(nil)
	defer server.Close()

	vpsId := fmt.Sprintf("vps-release-%d-%d", os.Getpid(), time.Now().UnixNano())
	lockPath := lock.LockPath(vpsId)
	t.Cleanup(func() { _ = os.Remove(lockPath) })

	cfg := &config.Config{
		BackendUrl:            server.URL,
		VpsId:                 vpsId,
		Token:                 "token-rel",
		IntervalSeconds:       1,
		RequestTimeoutSeconds: 5,
	}
	configPath := writeConfigFile(t, t.TempDir(), "config.json", cfg)

	cmd := exec.Command(bin, "-config", configPath)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("stderr pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start cmd: %v", err)
	}

	reader := bufio.NewReader(stderr)
	started := false
	for i := 0; i < 20; i++ {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		if strings.Contains(line, "starting agent") || strings.Contains(line, "mode: loop") {
			started = true
			break
		}
	}
	if !started {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatal("instance did not start in time")
	}

	// While child process is running, direct lock acquisition must fail with ErrAlreadyRunning
	_, errWhileAlive := lock.Acquire(vpsId)
	if errWhileAlive == nil || !strings.Contains(errWhileAlive.Error(), "already running") {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("expected ErrAlreadyRunning while process is active, got: %v", errWhileAlive)
	}

	// Terminate process (simulating service stop or restart)
	_ = cmd.Process.Kill()
	_ = cmd.Wait()

	// 1. Direct lock acquisition must now succeed immediately, proving the OS released the lock
	hAfter, errAfter := lock.Acquire(vpsId)
	if errAfter != nil {
		t.Fatalf("expected lock to be released after process killed, but acquire failed: %v", errAfter)
	}
	_ = hAfter.Release()

	// 2. Continuous child process acquisition observation: start a fresh instance and verify it acquires the lock cleanly
	cmd2 := exec.Command(bin, "-config", configPath)
	stderr2, err := cmd2.StderrPipe()
	if err != nil {
		t.Fatalf("stderr2 pipe: %v", err)
	}
	if err := cmd2.Start(); err != nil {
		t.Fatalf("start cmd2: %v", err)
	}
	defer func() {
		_ = cmd2.Process.Kill()
		_ = cmd2.Wait()
	}()

	reader2 := bufio.NewReader(stderr2)
	started2 := false
	for i := 0; i < 20; i++ {
		line, err := reader2.ReadString('\n')
		if err != nil {
			break
		}
		if strings.Contains(line, "starting agent") || strings.Contains(line, "mode: loop") {
			started2 = true
			break
		}
	}
	if !started2 {
		t.Fatal("second instance failed to acquire lock and start after first instance was killed")
	}
}
