package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/config"
)

// fakeHelperServer is an in-process stand-in for the root ai-host-helper unix
// socket. It records requests and replies with canned lines per op, so tests
// can exercise the HelperClient protocol (framing, streaming, fail-closed
// probes) without root or Linux. The socket path is kept short for the
// Windows AF_UNIX 108-byte path limit.
type fakeHelperServer struct {
	listener   net.Listener
	socketPath string

	mu       sync.Mutex
	requests []HelperRequest
	respond  func(op string, params json.RawMessage) [][]byte
}

// path returns the unix socket path the fake helper listens on.
func (s *fakeHelperServer) path() string { return s.socketPath }

func startFakeHelper(t *testing.T, respond func(op string, params json.RawMessage) [][]byte) *fakeHelperServer {
	t.Helper()
	dir, err := os.MkdirTemp("", "ai-fh-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	sock := filepath.Join(dir, "h.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("fake helper listen failed: %v", err)
	}
	t.Cleanup(func() { l.Close() })

	s := &fakeHelperServer{listener: l, socketPath: sock, respond: respond}
	go s.serve()
	return s
}

func (s *fakeHelperServer) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *fakeHelperServer) handle(conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	if !scanner.Scan() {
		return
	}
	var req HelperRequest
	if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
		return
	}
	s.mu.Lock()
	s.requests = append(s.requests, req)
	respond := s.respond
	s.mu.Unlock()
	if respond == nil {
		return
	}
	w := bufio.NewWriter(conn)
	for _, line := range respond(req.Op, req.Params) {
		if _, err := w.Write(line); err != nil {
			return
		}
		if err := w.WriteByte('\n'); err != nil {
			return
		}
	}
	_ = w.Flush()
}

// recordedRequests returns a copy of the requests seen so far.
func (s *fakeHelperServer) recordedRequests() []HelperRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]HelperRequest, len(s.requests))
	copy(out, s.requests)
	return out
}

// recordingExecutor is a ShellExecutor stub for asserting that dispatchShell
// routes sandbox payloads through the executor instead of the helper.
type recordingExecutor struct {
	mu    sync.Mutex
	calls int
	opts  []ShellExecutionOptions
}

func (r *recordingExecutor) Execute(_ context.Context, opts ShellExecutionOptions) (*ShellExecutionResult, error) {
	r.mu.Lock()
	r.calls++
	r.opts = append(r.opts, opts)
	r.mu.Unlock()
	return &ShellExecutionResult{ExitCode: 0, StdoutSnippet: "sandbox-ok\n"}, nil
}

func (r *recordingExecutor) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

// newExecModeTestWorker builds a worker wired to a mock AI client, mirroring
// the construction pattern in worker_test.go.
func newExecModeTestWorker(t *testing.T, socketPath string) (*Worker, *mockAIClient) {
	t.Helper()
	tempDir, err := os.MkdirTemp("", "ai-execmode-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(tempDir) })

	cfg := &config.Config{
		BackendUrl:      "http://localhost:8080",
		Token:           "test-token",
		IntervalSeconds: 5,
		StatePath:       filepath.Join(tempDir, "state"),
		AI: config.AIConfig{
			Enabled:          true,
			StatePath:        filepath.Join(tempDir, "state"),
			ProfilesDirPath:  filepath.Join(tempDir, "profiles"),
			HelperSocketPath: socketPath,
		},
	}

	worker, err := NewWorker(cfg, "agent-execmode", log.Default())
	if err != nil {
		t.Fatalf("NewWorker failed: %v", err)
	}
	client := &mockAIClient{}
	worker.SetClient(client)
	return worker, client
}

func TestShellPayload_ExecModeParsing(t *testing.T) {
	cases := []struct {
		name     string
		payload  string
		execMode string
	}{
		{"privileged", `{"script":"id","timeoutSeconds":10,"execMode":"privileged"}`, ExecModePrivileged},
		{"sandbox explicit", `{"script":"id","timeoutSeconds":10,"execMode":"sandbox"}`, ExecModeSandbox},
		{"empty tolerated (legacy)", `{"script":"id","timeoutSeconds":10}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var p ShellPayload
			if err := json.Unmarshal([]byte(tc.payload), &p); err != nil {
				t.Fatalf("unmarshal failed: %v", err)
			}
			if p.ExecMode != tc.execMode {
				t.Fatalf("expected execMode %q, got %q", tc.execMode, p.ExecMode)
			}
			if p.Script != "id" || p.TimeoutSeconds != 10 {
				t.Fatalf("unexpected payload fields: %+v", p)
			}
		})
	}
}

func TestProtocol_ClaimCapabilitiesPrivilegedFields(t *testing.T) {
	caps := HostCapabilities{Supported: true, PrivilegedSupported: true}
	raw, err := json.Marshal(ClaimRequest{Version: ProtocolVersion, AgentInstanceID: "inst-1", Capabilities: caps})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if !strings.Contains(string(raw), `"privilegedSupported":true`) {
		t.Fatalf("claim payload missing privilegedSupported: %s", raw)
	}
	// omitempty: no reason on success
	if strings.Contains(string(raw), "privilegedUnsupportedReason") {
		t.Fatalf("unexpected privilegedUnsupportedReason on success: %s", raw)
	}

	caps.PrivilegedSupported = false
	caps.PrivilegedUnsupportedReason = "helper missing, unreachable, or outdated"
	raw, err = json.Marshal(ClaimRequest{Version: ProtocolVersion, AgentInstanceID: "inst-1", Capabilities: caps})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if !strings.Contains(string(raw), `"privilegedSupported":false`) ||
		!strings.Contains(string(raw), `"privilegedUnsupportedReason":"helper missing, unreachable, or outdated"`) {
		t.Fatalf("claim payload missing privileged failure fields: %s", raw)
	}
}

// TestWorker_PrivilegedShellRoutesThroughHelper verifies execMode=privileged
// reaches the helper privileged_execute op and streams/redacts output through
// the same plumbing as the sandbox path.
func TestWorker_PrivilegedShellRoutesThroughHelper(t *testing.T) {
	helper := startFakeHelper(t, func(op string, params json.RawMessage) [][]byte {
		switch op {
		case "privileged_probe":
			return [][]byte{[]byte(`{"ok":true,"data":{"supported":true}}`)}
		case "privileged_execute":
			return [][]byte{
				[]byte(`{"stream":"stdout","data":"privileged-ok\n"}`),
				[]byte(`{"stream":"exit","exitCode":0}`),
			}
		default:
			return [][]byte{[]byte(`{"ok":false,"error":"unknown operation"}`)}
		}
	})

	worker, client := newExecModeTestWorker(t, helper.path())
	// NewWorker's startup probe should have flipped this via the fake helper.
	if !worker.capabilities.PrivilegedSupported {
		t.Fatalf("expected startup probe to set PrivilegedSupported=true, got reason=%q", worker.capabilities.PrivilegedUnsupportedReason)
	}
	worker.capabilities.Supported = true
	worker.capabilities.CgroupV2 = true

	cmd := &Command{
		Version:   ProtocolVersion,
		CommandID: "cmd-priv-1",
		TaskID:    "task-priv-1",
		Kind:      KindShell,
		Payload:   json.RawMessage(`{"script":"echo privileged-ok","timeoutSeconds":10,"execMode":"privileged"}`),
	}

	status, exitCode, errCode, errMsg, _, _ := worker.DispatchCommand(context.Background(), cmd)
	if status != StatusSucceeded {
		t.Fatalf("expected succeeded, got %s (errCode=%s msg=%s)", status, errCode, errMsg)
	}
	if exitCode == nil || *exitCode != 0 {
		t.Fatalf("expected exit code 0, got %v", exitCode)
	}

	var sawExecute bool
	for _, req := range helper.recordedRequests() {
		if req.Op == "privileged_execute" {
			sawExecute = true
			var p PrivilegedExecuteParams
			if err := json.Unmarshal(req.Params, &p); err != nil {
				t.Fatalf("unmarshal privileged_execute params: %v", err)
			}
			if p.TaskID != "task-priv-1" || p.CommandID != "cmd-priv-1" || p.Script != "echo privileged-ok" {
				t.Fatalf("unexpected privileged_execute params: %+v", p)
			}
			if p.TimeoutSeconds != 10 {
				t.Fatalf("expected timeout 10, got %d", p.TimeoutSeconds)
			}
		}
	}
	if !sawExecute {
		t.Fatalf("helper never received privileged_execute")
	}

	if len(client.outputChunks) == 0 || client.outputChunks[0].Chunk != "privileged-ok\n" {
		t.Fatalf("expected streamed output chunk privileged-ok, got %+v", client.outputChunks)
	}
	if client.outputChunks[0].StreamID != "stream-cmd-priv-1" || client.outputChunks[0].Sequence != 1 {
		t.Fatalf("unexpected stream framing: %+v", client.outputChunks[0])
	}
}

// TestWorker_SandboxShellRoutesThroughExecutor verifies sandbox (and empty)
// exec modes keep using the confined executor and never touch the privileged
// helper op.
func TestWorker_SandboxShellRoutesThroughExecutor(t *testing.T) {
	worker, _ := newExecModeTestWorker(t, "")
	worker.capabilities.Supported = true
	worker.capabilities.CgroupV2 = true
	stub := &recordingExecutor{}
	worker.executor = stub

	for _, mode := range []string{"sandbox", ""} {
		payload := `{"script":"echo sandbox-ok","timeoutSeconds":10}`
		if mode != "" {
			payload = `{"script":"echo sandbox-ok","timeoutSeconds":10,"execMode":"sandbox"}`
		}
		cmd := &Command{
			Version:   ProtocolVersion,
			CommandID: "cmd-sandbox-" + mode,
			TaskID:    "task-sandbox-1",
			Kind:      KindShell,
			Payload:   json.RawMessage(payload),
		}
		status, exitCode, errCode, errMsg, _, _ := worker.DispatchCommand(context.Background(), cmd)
		if status != StatusSucceeded {
			t.Fatalf("execMode=%q: expected succeeded, got %s (errCode=%s msg=%s)", mode, status, errCode, errMsg)
		}
		if exitCode == nil || *exitCode != 0 {
			t.Fatalf("execMode=%q: expected exit code 0, got %v", mode, exitCode)
		}
		if got := stub.callCount(); got != 1 {
			t.Fatalf("execMode=%q: expected executor called once, got %d", mode, got)
		}
		stub.mu.Lock()
		stub.calls = 0
		stub.mu.Unlock()
	}
}

// TestWorker_PrivilegedUnsupportedFailsClosed verifies the fail-closed branch:
// privileged with PrivilegedSupported=false returns sandbox_unavailable with
// the contract message and no exit code.
func TestWorker_PrivilegedUnsupportedFailsClosed(t *testing.T) {
	worker, _ := newExecModeTestWorker(t, "")
	worker.capabilities.Supported = true
	worker.capabilities.CgroupV2 = true
	worker.capabilities.PrivilegedSupported = false

	cmd := &Command{
		Version:   ProtocolVersion,
		CommandID: "cmd-priv-closed",
		TaskID:    "task-priv-2",
		Kind:      KindShell,
		Payload:   json.RawMessage(`{"script":"id","timeoutSeconds":10,"execMode":"privileged"}`),
	}

	status, exitCode, errCode, errMsg, _, _ := worker.DispatchCommand(context.Background(), cmd)
	if status != StatusFailed {
		t.Fatalf("expected failed, got %s", status)
	}
	if errCode != ErrCodeSandboxUnavailable {
		t.Fatalf("expected ErrCodeSandboxUnavailable, got %s (msg=%s)", errCode, errMsg)
	}
	if errMsg != "privileged execution unavailable (helper missing or outdated)" {
		t.Fatalf("unexpected error message: %q", errMsg)
	}
	if exitCode != nil {
		t.Fatalf("expected nil exit code, got %v", *exitCode)
	}
}

// TestWorker_ProbePrivilegedSupport covers the startup probe matrix: old
// helper (unknown-kind error), missing helper, and a supporting helper.
func TestWorker_ProbePrivilegedSupport(t *testing.T) {
	t.Run("old helper unknown op fails closed", func(t *testing.T) {
		helper := startFakeHelper(t, func(op string, params json.RawMessage) [][]byte {
			return [][]byte{[]byte(`{"ok":false,"error":"unknown operation \"privileged_probe\""}`)}
		})
		w := &Worker{logger: log.Default(), helper: NewHelperClient(helper.path())}
		w.probePrivilegedSupport()
		if w.capabilities.PrivilegedSupported {
			t.Fatalf("expected PrivilegedSupported=false against old helper")
		}
		if w.capabilities.PrivilegedUnsupportedReason != "helper missing, unreachable, or outdated" {
			t.Fatalf("unexpected reason: %q", w.capabilities.PrivilegedUnsupportedReason)
		}
	})

	t.Run("missing helper fails closed", func(t *testing.T) {
		w := &Worker{logger: log.Default(), helper: NewHelperClient("")}
		w.probePrivilegedSupport()
		if w.capabilities.PrivilegedSupported {
			t.Fatalf("expected PrivilegedSupported=false with missing helper")
		}
		if w.capabilities.PrivilegedUnsupportedReason == "" {
			t.Fatalf("expected unsupported reason to be set")
		}
	})

	t.Run("supporting helper succeeds", func(t *testing.T) {
		helper := startFakeHelper(t, func(op string, params json.RawMessage) [][]byte {
			return [][]byte{[]byte(`{"ok":true,"data":{"supported":true}}`)}
		})
		w := &Worker{logger: log.Default(), helper: NewHelperClient(helper.path())}
		w.probePrivilegedSupport()
		if !w.capabilities.PrivilegedSupported {
			t.Fatalf("expected PrivilegedSupported=true, reason=%q", w.capabilities.PrivilegedUnsupportedReason)
		}
		if w.capabilities.PrivilegedUnsupportedReason != "" {
			t.Fatalf("expected empty reason on success, got %q", w.capabilities.PrivilegedUnsupportedReason)
		}
	})
}

// TestHelperClient_ExecutePrivileged exercises the privileged streaming client
// end-to-end against the fake helper: stdout/stderr chunks, exit code, and the
// error-stream mapping.
func TestHelperClient_ExecutePrivileged(t *testing.T) {
	t.Run("streams output and exit code", func(t *testing.T) {
		helper := startFakeHelper(t, func(op string, params json.RawMessage) [][]byte {
			if op != "privileged_execute" {
				return [][]byte{[]byte(`{"ok":false,"error":"unexpected op"}`)}
			}
			return [][]byte{
				[]byte(`{"stream":"stdout","data":"line-1\n"}`),
				[]byte(`{"stream":"stderr","data":"warn\n"}`),
				[]byte(`{"stream":"exit","exitCode":3}`),
			}
		})
		c := NewHelperClient(helper.path())

		var stderrChunks []string
		res, err := c.ExecutePrivileged(context.Background(), PrivilegedExecuteParams{
			TaskID:         "task-client-1",
			CommandID:      "cmd-client-1",
			Script:         "anything",
			TimeoutSeconds: 5,
		}, func(chunk string, isStderr bool) {
			if isStderr {
				stderrChunks = append(stderrChunks, chunk)
			}
		})
		if err != nil {
			t.Fatalf("ExecutePrivileged failed: %v", err)
		}
		if res == nil || res.ExitCode != 3 {
			t.Fatalf("expected exit code 3, got %+v", res)
		}
		if res.StdoutSnippet != "line-1\n" {
			t.Fatalf("unexpected stdout snippet: %q", res.StdoutSnippet)
		}
		if len(stderrChunks) != 1 || stderrChunks[0] != "warn\n" {
			t.Fatalf("unexpected stderr chunks: %v", stderrChunks)
		}

		reqs := helper.recordedRequests()
		if len(reqs) != 1 || reqs[0].Op != "privileged_execute" {
			t.Fatalf("expected one privileged_execute request, got %+v", reqs)
		}
	})

	t.Run("error stream fails", func(t *testing.T) {
		helper := startFakeHelper(t, func(op string, params json.RawMessage) [][]byte {
			return [][]byte{[]byte(`{"stream":"error","error":"boom"}`)}
		})
		c := NewHelperClient(helper.path())
		_, err := c.ExecutePrivileged(context.Background(), PrivilegedExecuteParams{
			TaskID:         "task-client-2",
			CommandID:      "cmd-client-2",
			Script:         "anything",
			TimeoutSeconds: 5,
		}, nil)
		if err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("expected helper failure error, got %v", err)
		}
	})

	t.Run("invalid task id rejected before dialing", func(t *testing.T) {
		helper := startFakeHelper(t, nil)
		c := NewHelperClient(helper.path())
		_, err := c.ExecutePrivileged(context.Background(), PrivilegedExecuteParams{
			TaskID:         "../evil",
			CommandID:      "cmd-client-3",
			Script:         "anything",
			TimeoutSeconds: 5,
		}, nil)
		if err == nil {
			t.Fatalf("expected invalid taskId error")
		}
	})
}

// TestHelperClient_ProbePrivileged verifies the client-level probe contract:
// an old helper's unknown-kind error maps to (false, err), a supporting
// helper maps to (true, nil).
func TestHelperClient_ProbePrivileged(t *testing.T) {
	t.Run("old helper", func(t *testing.T) {
		helper := startFakeHelper(t, func(op string, params json.RawMessage) [][]byte {
			return [][]byte{[]byte(`{"ok":false,"error":"unknown operation \"privileged_probe\""}`)}
		})
		c := NewHelperClient(helper.path())
		supported, err := c.ProbePrivileged(context.Background())
		if supported || err == nil {
			t.Fatalf("expected (false, err) against old helper, got (%v, %v)", supported, err)
		}
		if len(helper.recordedRequests()) != 1 {
			t.Fatalf("expected the probe request to be sent")
		}
	})

	t.Run("supporting helper", func(t *testing.T) {
		helper := startFakeHelper(t, func(op string, params json.RawMessage) [][]byte {
			return [][]byte{[]byte(`{"ok":true,"data":{"supported":true}}`)}
		})
		c := NewHelperClient(helper.path())
		supported, err := c.ProbePrivileged(context.Background())
		if err != nil || !supported {
			t.Fatalf("expected (true, nil), got (%v, %v)", supported, err)
		}
	})

	t.Run("timeout bounded", func(t *testing.T) {
		helper := startFakeHelper(t, nil) // accepts but never replies
		c := NewHelperClient(helper.path())
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		start := time.Now()
		_, err := c.ProbePrivileged(ctx)
		if err == nil {
			t.Fatalf("expected timeout error")
		}
		if time.Since(start) > 5*time.Second {
			t.Fatalf("probe did not respect context deadline")
		}
	})
}
