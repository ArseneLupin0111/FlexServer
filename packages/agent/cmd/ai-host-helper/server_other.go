//go:build !linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"

	"github.com/vps-manager/agent/internal/ai"
)

func run(_ ServerConfig) error {
	return errors.New("ai-host-helper is supported only on Linux")
}

// Fail-closed stubs for non-Linux builds. The helper server itself only runs
// on Linux (run() refuses to start elsewhere), so these handlers are never
// reached in practice; they exist so the privileged ops are explicitly
// unsupported instead of implicitly absent on non-Linux builds.

func handlePrivilegedProbe(conn net.Conn) {
	resp := ai.HelperResponse{Ok: false, Error: "privileged execution is supported only on Linux"}
	b, _ := json.Marshal(resp)
	_, _ = conn.Write(append(b, '\n'))
}

func handlePrivilegedExecute(_ context.Context, conn net.Conn, _ json.RawMessage, _ ServerConfig) {
	// Stream framing (not a plain HelperResponse) so the client's streaming
	// reader maps this to a hard error instead of a silent empty success.
	msg := ai.TaskExecuteStreamMessage{Stream: "error", Error: "privileged execution is supported only on Linux"}
	b, _ := json.Marshal(msg)
	_, _ = conn.Write(append(b, '\n'))
}
