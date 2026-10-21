package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestProtocol_SanitizeLog(t *testing.T) {
	raw := "Agent authorization token: vma_abcdef1234567890ABCDEF in request headers"
	sanitized := SanitizeLog(raw)
	if strings.Contains(sanitized, "vma_abcdef1234567890ABCDEF") {
		t.Fatalf("token was not sanitized from log: %s", sanitized)
	}
	if !strings.Contains(sanitized, "[redacted]") {
		t.Fatalf("expected [redacted] in sanitized output: %s", sanitized)
	}
}

func TestProtocol_EnvelopeMarshaling(t *testing.T) {
	claimReq := ClaimRequest{
		Version:         ProtocolVersion,
		AgentInstanceID: "inst-12345",
		Capabilities: HostCapabilities{
			Supported:         true,
			CgroupV2:          true,
			Namespaces:        true,
			Seccomp:           true,
			MinimalRootfs:     true,
			ProfilesDigest:    "prof-digest",
			RootfsDigest:      "root-digest",
			Profiles:          []string{"nginx"},
		},
	}

	bytes, err := json.Marshal(claimReq)
	if err != nil {
		t.Fatalf("marshaling ClaimRequest failed: %v", err)
	}

	var parsed ClaimRequest
	if err := json.Unmarshal(bytes, &parsed); err != nil {
		t.Fatalf("unmarshaling ClaimRequest failed: %v", err)
	}

	if parsed.Version != 1 || parsed.AgentInstanceID != "inst-12345" || !parsed.Capabilities.Supported {
		t.Fatalf("parsed ClaimRequest mismatch: %+v", parsed)
	}
}

func TestProtocol_CommandPayloadValidation(t *testing.T) {
	// Shell command payload validation
	cmd := &Command{
		Version:   ProtocolVersion,
		CommandID: "cmd-1",
		TaskID:    "task-1",
		StepID:    "step-1",
		Kind:      KindShell,
		Payload:   json.RawMessage(`{"script":"echo 1","timeoutSeconds":30}`),
	}

	var shell ShellPayload
	if err := json.Unmarshal(cmd.Payload, &shell); err != nil {
		t.Fatalf("unmarshaling shell payload failed: %v", err)
	}
	if shell.Script != "echo 1" || shell.TimeoutSeconds != 30 {
		t.Fatalf("unexpected shell payload: %+v", shell)
	}
}

// testPayloadDigest returns the real sha256 hex digest of a command payload,
// matching the digest the worker reports for Receipt.PayloadDigest and the
// 64-character plan digest shape the API produces for canonical plans.
func testPayloadDigest(payload string) string {
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func TestProtocol_CommandValidate(t *testing.T) {
	// Auto-authorized read: planVersion = 0 with a real sha256 payload digest.
	readCmd := &Command{
		Version:         ProtocolVersion,
		CommandID:       "cmd-read-1",
		TaskID:          "task-1",
		StepID:          "step-read-1",
		VpsID:           "vps-1",
		AgentInstanceID: "inst-1",
		Kind:            KindFileRead,
		PlanVersion:     0,
		PlanDigest:      testPayloadDigest(`{"path":"/etc/nginx/nginx.conf","scope":"config"}`),
	}
	if err := readCmd.Validate("inst-1", "vps-1"); err != nil {
		t.Fatalf("expected auto-authorized read command to pass Validate, got: %v", err)
	}

	// Mutating command with planVersion = 0 must fail
	mutatingCmdPlan0 := &Command{
		Version:         ProtocolVersion,
		CommandID:       "cmd-mutate-0",
		TaskID:          "task-1",
		StepID:          "step-mutate-0",
		VpsID:           "vps-1",
		AgentInstanceID: "inst-1",
		Kind:            KindShell,
		PlanVersion:     0,
		PlanDigest:      testPayloadDigest("mutating-plan-0"),
	}
	if err := mutatingCmdPlan0.Validate("inst-1", "vps-1"); err == nil {
		t.Fatalf("expected mutating command with planVersion=0 to fail Validate")
	}

	// Mutating command with planVersion = 1 must pass
	mutatingCmdPlan1 := &Command{
		Version:         ProtocolVersion,
		CommandID:       "cmd-mutate-1",
		TaskID:          "task-1",
		StepID:          "step-mutate-1",
		VpsID:           "vps-1",
		AgentInstanceID: "inst-1",
		Kind:            KindShell,
		PlanVersion:     1,
		PlanDigest:      testPayloadDigest("mutating-plan-1"),
	}
	if err := mutatingCmdPlan1.Validate("inst-1", "vps-1"); err != nil {
		t.Fatalf("expected mutating command with planVersion=1 to pass Validate, got: %v", err)
	}
}

func TestProtocol_ChunkRedactor_SplitSecrets(t *testing.T) {
	redactor := NewChunkRedactor()

	// Chunk 1 has part of the token, chunk 2 completes the line
	c1 := "header: Bearer vma_secret"
	c2 := "token123456\nnext line\n"

	p1 := redactor.Process(c1)
	if p1 != "" {
		t.Fatalf("expected chunk 1 without newline to be buffered, got: %q", p1)
	}

	p2 := redactor.Process(c2)
	expected := "header: Bearer [redacted]\nnext line\n"
	if p2 != expected {
		t.Fatalf("expected %q, got %q", expected, p2)
	}

	// Verify flush
	redactor.Process("trailing without newline")
	flushed := redactor.Flush()
	if flushed != "trailing without newline" {
		t.Fatalf("expected flushed trailing line, got %q", flushed)
	}
}

func TestProtocol_TruncateUTF8ToBytes(t *testing.T) {
	// 3-byte UTF-8 rune: 'ế' is 0xe1 0xba 0xbf (3 bytes)
	// "Tiếng" = 'T' (1) + 'i' (1) + 'ế' (3) + 'n' (1) + 'g' (1) = 7 bytes
	s := "Tiếng"
	// Truncating to 3 bytes should stop before 'ế' (giving "Ti")
	truncated := TruncateUTF8ToBytes(s, 3)
	if truncated != "Ti" {
		t.Fatalf("expected 'Ti', got %q", truncated)
	}

	// Truncating to 5 bytes includes 'ế' (giving "Tiế")
	truncated5 := TruncateUTF8ToBytes(s, 5)
	if truncated5 != "Tiế" {
		t.Fatalf("expected 'Tiế', got %q", truncated5)
	}
}
