package ai

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/config"
)

// mockAIClient records calls and provides dummy responses for worker testing.
type mockAIClient struct {
	claimedCommands []*Command
	outputChunks    []*OutputChunkRequest
	heartbeats      []*HeartbeatRequest
	results         []*ResultRequest
}

func (m *mockAIClient) Claim(ctx context.Context, req *ClaimRequest) (*Command, error) {
	if len(m.claimedCommands) > 0 {
		cmd := m.claimedCommands[0]
		m.claimedCommands = m.claimedCommands[1:]
		return cmd, nil
	}
	return nil, nil
}

func (m *mockAIClient) Heartbeat(ctx context.Context, req *HeartbeatRequest) (*HeartbeatResponse, error) {
	m.heartbeats = append(m.heartbeats, req)
	var hb HeartbeatResponse
	hb.Data.Ok = true
	hb.Data.CancelRequested = false
	return &hb, nil
}

func (m *mockAIClient) Output(ctx context.Context, req *OutputChunkRequest) (*OutputChunkResponse, error) {
	m.outputChunks = append(m.outputChunks, req)
	var out OutputChunkResponse
	out.Data.Ok = true
	return &out, nil
}

func (m *mockAIClient) Result(ctx context.Context, req *ResultRequest) (*ResultResponse, error) {
	m.results = append(m.results, req)
	var res ResultResponse
	res.Data.Ok = true
	return &res, nil
}

func (m *mockAIClient) CancelStatus(ctx context.Context, req *CancelStatusRequest) (*CancelStatusResponse, error) {
	return &CancelStatusResponse{}, nil
}

func TestWorker_UnsupportedHostFailsClosed(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-worker-test-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tempDir)

	stateDir := filepath.Join(tempDir, "state")
	profilesDir := filepath.Join(tempDir, "profiles")
	_ = os.MkdirAll(stateDir, 0700)
	_ = os.MkdirAll(profilesDir, 0700)

	cfg := &config.Config{
		BackendUrl:      "http://localhost:8080",
		Token:           "test-token",
		IntervalSeconds: 5,
		StatePath:       stateDir,
		AI: config.AIConfig{
			Enabled:         true,
			StatePath:       stateDir,
			ProfilesDirPath: profilesDir,
		},
	}

	client := &mockAIClient{}
	worker, err := NewWorker(cfg, "agent-test-1", log.Default())
	if err != nil {
		t.Fatalf("NewWorker failed: %v", err)
	}
	worker.SetClient(client)

	// Ensure capabilities are flagged unsupported
	worker.capabilities.Supported = false
	worker.capabilities.CgroupV2 = false

	cmd := &Command{
		Version:   ProtocolVersion,
		CommandID: "cmd-shell-test",
		TaskID:    "task-1",
		Kind:      KindShell,
		Payload:   json.RawMessage(`{"script":"echo hello","timeoutSeconds":10}`),
	}

	status, _, errCode, message, _, _ := worker.DispatchCommand(context.Background(), cmd)
	if status != StatusFailed {
		t.Fatalf("expected status failed, got %s", status)
	}
	if errCode != ErrCodeSandboxUnavailable {
		t.Fatalf("expected ErrCodeSandboxUnavailable, got %s (msg: %s)", errCode, message)
	}
}

func TestWorker_DisallowedServiceActionFails(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-worker-service-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tempDir)

	stateDir := filepath.Join(tempDir, "state")
	profilesDir := filepath.Join(tempDir, "profiles")
	_ = os.MkdirAll(stateDir, 0700)
	_ = os.MkdirAll(profilesDir, 0700)

	cfg := &config.Config{
		BackendUrl:      "http://localhost:8080",
		Token:           "test-token",
		IntervalSeconds: 5,
		StatePath:       stateDir,
		AI: config.AIConfig{
			Enabled:         true,
			StatePath:       stateDir,
			ProfilesDirPath: profilesDir,
		},
	}

	client := &mockAIClient{}
	worker, err := NewWorker(cfg, "agent-test-2", log.Default())
	if err != nil {
		t.Fatalf("NewWorker failed: %v", err)
	}
	worker.SetClient(client)
	worker.profiles.Register(DefaultNginxProfile())
	// Attempting forbidden 'stop' action
	cmd := &Command{
		Version:   ProtocolVersion,
		CommandID: "cmd-stop-test",
		TaskID:    "task-2",
		Kind:      KindServiceAction,
		Payload:   json.RawMessage(`{"profileId":"nginx","service":"nginx","action":"stop"}`),
	}

	status, _, errCode, message, _, _ := worker.DispatchCommand(context.Background(), cmd)
	if status != StatusFailed {
		t.Fatalf("expected status failed for stop action, got %s", status)
	}
	if errCode != ErrCodeUnsupportedAction {
		t.Fatalf("expected ErrCodeUnsupportedAction, got %s (msg: %s)", errCode, message)
	}
}

func TestWorker_StartupPendingReceiptsProcessed(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-worker-pending-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tempDir)

	stateDir := filepath.Join(tempDir, "state")
	receiptsDir := filepath.Join(stateDir, "receipts")
	profilesDir := filepath.Join(tempDir, "profiles")
	_ = os.MkdirAll(receiptsDir, 0700)
	_ = os.MkdirAll(profilesDir, 0700)

	store, err := NewFileReceiptStore(receiptsDir)
	if err != nil {
		t.Fatalf("NewFileReceiptStore failed: %v", err)
	}

	// Create a pending receipt that was executing when agent crashed
	pendingReceipt := &Receipt{
		Version:   ProtocolVersion,
		CommandID: "cmd-interrupted",
		TaskID:    "task-recovery",
		StepID:    "step-1",
		Kind:      KindFileApply,
		State:     ReceiptExecuting,
		Executed:    true,
		PlanVersion: 1,
		PlanDigest:  "0123456789abcdef0123456789abcdef",
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Persist(pendingReceipt); err != nil {
		t.Fatalf("failed to persist pending receipt: %v", err)
	}

	cfg := &config.Config{
		BackendUrl:      "http://localhost:8080",
		Token:           "test-token",
		IntervalSeconds: 5,
		StatePath:       stateDir,
		AI: config.AIConfig{
			Enabled:         true,
			StatePath:       stateDir,
			ProfilesDirPath: profilesDir,
		},
	}

	client := &mockAIClient{}
	worker, err := NewWorker(cfg, "agent-test-3", log.Default())
	if err != nil {
		t.Fatalf("NewWorker failed: %v", err)
	}
	worker.SetClient(client)

	// Process pending receipts
	worker.ReconcilePendingReceipts(context.Background())

	// Receipt should be transitioned to uncertain and reported to backend
	if len(client.results) == 0 {
		t.Fatalf("expected client.Result to be called for pending receipt")
	}
	result := client.results[0]
	if result.CommandID != "cmd-interrupted" {
		t.Fatalf("expected commandID cmd-interrupted, got %s", result.CommandID)
	}
	if result.Status != StatusUncertain {
		t.Fatalf("expected status uncertain for interrupted execution, got %s", result.Status)
	}
	if result.ErrorCode != ErrCodeUncertainOutcome {
		t.Fatalf("expected ErrCodeUncertainOutcome, got %s", result.ErrorCode)
	}

	// Check store has updated receipt state to uncertain
	loaded, err := store.Load("cmd-interrupted")
	if err != nil {
		t.Fatalf("failed to reload receipt: %v", err)
	}
	if loaded.State != ReceiptUncertain {
		t.Fatalf("expected state uncertain, got %s", loaded.State)
	}
}
