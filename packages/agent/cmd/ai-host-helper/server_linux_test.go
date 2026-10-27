//go:build linux

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/ai"
)

// startTestHelper spins a real unix socket, dials it, and runs handler on the
// server side, returning the client end for reading streamed replies. This is
// the same framing the real helper uses (one JSON line per stream message).
func startTestHelper(t *testing.T, handle func(serverConn net.Conn)) net.Conn {
	t.Helper()
	dir, err := os.MkdirTemp("", "ai-helper-test-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	sock := filepath.Join(dir, "t.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	t.Cleanup(func() { l.Close() })

	serverConnCh := make(chan net.Conn, 1)
	go func() {
		c, err := l.Accept()
		if err != nil {
			serverConnCh <- nil
			return
		}
		serverConnCh <- c
	}()

	client, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { client.Close() })

	go func() {
		sc := <-serverConnCh
		if sc == nil {
			return
		}
		defer sc.Close()
		handle(sc)
	}()

	return client
}

// readStreamMessages reads streamed JSON lines until EOF or deadline.
func readStreamMessages(t *testing.T, conn net.Conn) []ai.TaskExecuteStreamMessage {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var msgs []ai.TaskExecuteStreamMessage
	for scanner.Scan() {
		var m ai.TaskExecuteStreamMessage
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			continue
		}
		msgs = append(msgs, m)
	}
	return msgs
}

func testServerConfig(t *testing.T) ServerConfig {
	return ServerConfig{
		AgentStateDir: t.TempDir(),
	}
}

func TestHandleConnPeerAuthorization(t *testing.T) {
	peerUID := os.Geteuid()

	t.Run("pinned agent UID is accepted", func(t *testing.T) {
		client := startTestHelper(t, func(sc net.Conn) {
			handleConn(context.Background(), sc, nil, ServerConfig{AgentUID: peerUID})
		})
		_, err := client.Write([]byte(`{"op":"not-a-real-operation"}` + "\n"))
		if err != nil {
			t.Fatalf("writing request: %v", err)
		}
		var resp ai.HelperResponse
		if err := json.NewDecoder(client).Decode(&resp); err != nil {
			t.Fatalf("reading authorized response: %v", err)
		}
		if resp.Error == "unauthorized peer credentials" || strings.HasPrefix(resp.Error, "unauthorized peer credentials ") {
			t.Fatalf("pinned agent UID was rejected: %q", resp.Error)
		}
		if !strings.Contains(resp.Error, "unknown operation") {
			t.Fatalf("expected request to reach operation dispatch, got %q", resp.Error)
		}
	})

	t.Run("mismatched non-root UID is rejected", func(t *testing.T) {
		if peerUID == 0 {
			t.Skip("the test process is root; SO_PEERCRED cannot provide a mismatched UID")
		}
		client := startTestHelper(t, func(sc net.Conn) {
			handleConn(context.Background(), sc, nil, ServerConfig{AgentUID: peerUID + 1})
		})
		_, err := client.Write([]byte(`{"op":"not-a-real-operation"}` + "\n"))
		if err != nil {
			t.Fatalf("writing request: %v", err)
		}
		var resp ai.HelperResponse
		if err := json.NewDecoder(client).Decode(&resp); err != nil {
			t.Fatalf("reading unauthorized response: %v", err)
		}
		if resp.Ok || !strings.Contains(resp.Error, "unauthorized peer credentials") {
			t.Fatalf("expected unauthorized response, got %+v", resp)
		}
	})
}

func TestAuthorizedPeer(t *testing.T) {
	tests := []struct {
		name     string
		peerUID  int
		agentUID int
		want     bool
	}{
		{name: "root", peerUID: 0, agentUID: 1234, want: true},
		{name: "pinned agent", peerUID: 1234, agentUID: 1234, want: true},
		{name: "other UID", peerUID: 1235, agentUID: 1234, want: false},
		{name: "unset agent", peerUID: 1234, agentUID: -1, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := authorizedPeer(tt.peerUID, tt.agentUID); got != tt.want {
				t.Fatalf("authorizedPeer(%d, %d) = %t, want %t", tt.peerUID, tt.agentUID, got, tt.want)
			}
		})
	}
}

func TestPrivilegedProbeHandler(t *testing.T) {
	client := startTestHelper(t, func(sc net.Conn) {
		handlePrivilegedProbe(sc)
	})
	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	line, err := bufio.NewReader(client).ReadString('\n')
	if err != nil {
		t.Fatalf("reading probe response: %v", err)
	}
	var resp ai.HelperResponse
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal probe response %q: %v", line, err)
	}
	if !resp.Ok {
		t.Fatalf("expected ok=true probe response, got %s", line)
	}
	var res ai.PrivilegedProbeResult
	if err := json.Unmarshal(resp.Data, &res); err != nil {
		t.Fatalf("unmarshal probe data: %v", err)
	}
	if !res.Supported {
		t.Fatalf("expected supported=true, got %s", line)
	}
}

func TestPrivilegedExecuteRunsScriptAndStreams(t *testing.T) {
	cfg := testServerConfig(t)
	params := ai.PrivilegedExecuteParams{
		TaskID:         "task-ptest-1",
		CommandID:      "cmd-ptest-1",
		Script:         "echo privileged-ok; echo oops >&2",
		TimeoutSeconds: 10,
	}
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}

	client := startTestHelper(t, func(sc net.Conn) {
		handlePrivilegedExecute(context.Background(), sc, raw, cfg)
	})
	msgs := readStreamMessages(t, client)

	var sawStdout, sawStderr, sawExit bool
	for _, m := range msgs {
		switch m.Stream {
		case "stdout":
			if strings.Contains(m.Data, "privileged-ok") {
				sawStdout = true
			}
		case "stderr":
			if strings.Contains(m.Data, "oops") {
				sawStderr = true
			}
		case "exit":
			sawExit = true
			if m.ExitCode != 0 || m.Terminated {
				t.Fatalf("expected exit {0,false}, got {code=%d, terminated=%v}", m.ExitCode, m.Terminated)
			}
		case "error":
			t.Fatalf("unexpected error stream message: %s", m.Error)
		}
	}
	if !sawStdout || !sawStderr || !sawExit {
		t.Fatalf("missing stream messages: stdout=%v stderr=%v exit=%v (msgs=%+v)", sawStdout, sawStderr, sawExit, msgs)
	}
}

func TestPrivilegedExecuteTimeoutKills(t *testing.T) {
	cfg := testServerConfig(t)
	params := ai.PrivilegedExecuteParams{
		TaskID:         "task-ptest-2",
		CommandID:      "cmd-ptest-2",
		Script:         "echo started; sleep 60",
		TimeoutSeconds: 1,
	}
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}

	start := time.Now()
	client := startTestHelper(t, func(sc net.Conn) {
		handlePrivilegedExecute(context.Background(), sc, raw, cfg)
	})
	msgs := readStreamMessages(t, client)
	elapsed := time.Since(start)

	var sawExit bool
	for _, m := range msgs {
		if m.Stream == "error" {
			t.Fatalf("unexpected error stream message: %s", m.Error)
		}
		if m.Stream == "exit" {
			sawExit = true
			if !m.Terminated || m.ExitCode != 137 {
				t.Fatalf("expected terminated exit 137 on timeout, got {code=%d, terminated=%v}", m.ExitCode, m.Terminated)
			}
		}
	}
	if !sawExit {
		t.Fatalf("missing exit message (msgs=%+v)", msgs)
	}
	// 1s timeout + bounded WaitDelay; far below the 60s script runtime.
	if elapsed > 15*time.Second {
		t.Fatalf("timeout kill took too long: %v", elapsed)
	}
}

func TestPrivilegedExecuteRejectsBadScriptLength(t *testing.T) {
	cfg := testServerConfig(t)
	cases := []struct {
		name   string
		script string
	}{
		{"empty", ""},
		{"too long", strings.Repeat("x", ai.MaxScriptBytes+1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			params := ai.PrivilegedExecuteParams{
				TaskID:         "task-ptest-3",
				CommandID:      "cmd-ptest-3",
				Script:         tc.script,
				TimeoutSeconds: 5,
			}
			raw, err := json.Marshal(params)
			if err != nil {
				t.Fatalf("marshal params: %v", err)
			}
			client := startTestHelper(t, func(sc net.Conn) {
				handlePrivilegedExecute(context.Background(), sc, raw, cfg)
			})
			msgs := readStreamMessages(t, client)
			if len(msgs) != 1 || msgs[0].Stream != "error" || !strings.Contains(msgs[0].Error, "invalid script length") {
				t.Fatalf("expected single invalid-script-length error, got %+v", msgs)
			}
		})
	}
}

func TestPrivilegedExecuteRejectsBadTaskID(t *testing.T) {
	cfg := testServerConfig(t)
	params := ai.PrivilegedExecuteParams{
		TaskID:         "../evil",
		CommandID:      "cmd-ptest-4",
		Script:         "echo hi",
		TimeoutSeconds: 5,
	}
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	client := startTestHelper(t, func(sc net.Conn) {
		handlePrivilegedExecute(context.Background(), sc, raw, cfg)
	})
	msgs := readStreamMessages(t, client)
	if len(msgs) != 1 || msgs[0].Stream != "error" || !strings.Contains(msgs[0].Error, "invalid taskId") {
		t.Fatalf("expected single invalid-taskId error, got %+v", msgs)
	}
}
