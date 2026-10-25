package ai

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Protocol version 1
const ProtocolVersion = 1

// Bounded limits (§9.3, §8.3, wire contract)
const (
	MaxIDLen                = 64
	MaxInstanceIDLen        = 32
	MaxErrorCodeLen         = 64
	MaxErrorMessageLen      = 1024
	MinPlanDigestLen        = 16
	MaxPlanDigestLen        = 128
	MaxUnsupportedReasonLen = 512
	MaxOutputChunkBytes     = 16 * 1024
	MaxOutputPreviewBytes   = 8 * 1024
	MaxFileBytes            = 256 * 1024
	MaxClaimResponseBytes   = 64 * 1024
	MaxReceiptSizeBytes     = 128 * 1024
	MaxScriptBytes          = 32 * 1024 // matches the API shell plan step script cap
	DefaultTimeoutSeconds   = 60
	MaxTimeoutSeconds       = 120
	TermGracePeriod         = 5 * time.Second
)

// Shell execution modes (ShellPayload.ExecMode). Empty means sandbox: old
// commands without the field keep running confined.
const (
	ExecModeSandbox    = "sandbox"
	ExecModePrivileged = "privileged"
)

// Command kinds
const (
	KindShell          = "shell"
	KindFileRead       = "file_read"
	KindFileApply      = "file_apply"
	KindServiceStatus  = "service_status"
	KindServiceAction  = "service_action"
	KindConfigValidate = "config_validate"
	KindConfigApply    = "config_apply"
	KindConfigRecover  = "config_recover"
)

var validCommandKinds = map[string]bool{
	KindShell:          true,
	KindFileRead:       true,
	KindFileApply:      true,
	KindServiceStatus:  true,
	KindServiceAction:  true,
	KindConfigValidate: true,
	KindConfigApply:    true,
	KindConfigRecover:  true,
}

// Receipt states
const (
	ReceiptClaimed   = "claimed"
	ReceiptExecuting = "executing"
	ReceiptSucceeded = "succeeded"
	ReceiptFailed    = "failed"
	ReceiptUncertain = "uncertain"
	ReceiptCancelled = "cancelled"
)

// Result statuses
const (
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"
	StatusUncertain = "uncertain"
	StatusCancelled = "cancelled"
)

// Error codes allowlist (§8.2, wire contract)
const (
	ErrCodeSandboxUnavailable = "sandbox_unavailable"
	ErrCodeUnsupportedAction  = "unsupported_action"
	ErrCodeTargetBusy         = "target_busy"
	ErrCodeDeadlineExceeded   = "deadline_exceeded"
	ErrCodeIdentityMismatch   = "identity_mismatch"
	ErrCodeTargetMismatch     = "target_mismatch"
	ErrCodePreconditionFailed = "precondition_failed"
	ErrCodeDriftDetected      = "drift_detected"
	ErrCodeProfileNotFound    = "profile_not_found"
	ErrCodeValidationFailed   = "validation_failed"
	ErrCodeExecutionFailed    = "execution_failed"
	ErrCodeTimeout            = "timeout"
	ErrCodeCancelled          = "cancelled"
	ErrCodeUncertainOutcome   = "uncertain_outcome"
	ErrCodeProtectedPath      = "protected_path"
	ErrCodeConfigPathDenied   = "config_path_denied"
	ErrCodeInvalidCommand     = "invalid_command"
	ErrCodeFileTooLarge        = "file_too_large"
	ErrCodeHelperUnavailable  = "helper_unavailable"
)

var validErrorCodes = map[string]bool{
	ErrCodeSandboxUnavailable: true,
	ErrCodeUnsupportedAction:  true,
	ErrCodeTargetBusy:         true,
	ErrCodeDeadlineExceeded:   true,
	ErrCodeIdentityMismatch:   true,
	ErrCodeTargetMismatch:     true,
	ErrCodePreconditionFailed: true,
	ErrCodeDriftDetected:      true,
	ErrCodeProfileNotFound:    true,
	ErrCodeValidationFailed:   true,
	ErrCodeExecutionFailed:    true,
	ErrCodeTimeout:            true,
	ErrCodeCancelled:          true,
	ErrCodeUncertainOutcome:   true,
	ErrCodeProtectedPath:      true,
	ErrCodeConfigPathDenied:   true,
	ErrCodeInvalidCommand:     true,
	ErrCodeFileTooLarge:        true,
	ErrCodeHelperUnavailable:  true,
}

// HostCapabilities reports the OS confinement and profile state of this agent.
// PrivilegedSupported is probed at worker start against the root helper: it is
// independent of Supported (sandbox confinement) and fails closed to false.
type HostCapabilities struct {
	Supported         bool     `json:"supported"`
	UnsupportedReason string   `json:"unsupportedReason,omitempty"`
	CgroupV2          bool     `json:"cgroupV2"`
	Namespaces        bool     `json:"namespaces"`
	Seccomp           bool     `json:"seccomp"`
	MinimalRootfs     bool     `json:"-"`
	RootfsDigest      string   `json:"rootfsDigest"`
	ProfilesDigest    string   `json:"profilesDigest"`
	Profiles          []string `json:"profiles"`

	PrivilegedSupported         bool   `json:"privilegedSupported"`
	PrivilegedUnsupportedReason string `json:"privilegedUnsupportedReason,omitempty"`
}

// ClaimRequest is sent to POST /api/agent/ai/claim
type ClaimRequest struct {
	Version         int              `json:"version"`
	AgentInstanceID string           `json:"agentInstanceId"`
	Capabilities    HostCapabilities `json:"capabilities"`
}

// ClaimResponse is received from POST /api/agent/ai/claim
type ClaimResponse struct {
	Data struct {
		Ok      bool     `json:"ok,omitempty"`
		Command *Command `json:"command"`
	} `json:"data"`
}

// Command is the strict v1 command envelope.
type Command struct {
	Version         int             `json:"version"`
	TaskID          string          `json:"taskId"`
	StepID          string          `json:"stepId"`
	CommandID       string          `json:"commandId"`
	VpsID           string          `json:"vpsId"`
	AgentInstanceID string          `json:"agentInstanceId"`
	PlanVersion     int             `json:"planVersion"`
	PlanDigest      string          `json:"planDigest"`
	DeadlineAt      string          `json:"deadlineAt"`
	PolicyRevision  int             `json:"policyRevision"`
	Kind            string          `json:"kind"`
	Payload         json.RawMessage `json:"payload"`
}

// idPattern accepts alphanumerics plus dots and dashes as identifier names;
// anything containing whitespace, slashes, equals or other operators fails.
var idPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// validateID enforces strict identifier format: bounded length and a single
// token with no separators, whitespace, traversal sequences or absolute path
// prefixes. Used for task/step/command IDs that key filesystem paths (cgroups,
// scratch dirs, receipts); anything outside the alphabet fails closed.
func validateID(kind string, id string) error {
	if id == "" {
		return fmt.Errorf("empty %s", kind)
	}
	if len(id) > MaxIDLen {
		return fmt.Errorf("%s too long (%d > %d)", kind, len(id), MaxIDLen)
	}
	if !idPattern.MatchString(id) {
		return fmt.Errorf("invalid %s format", kind)
	}
	if strings.Contains(id, "..") {
		return fmt.Errorf("invalid %s format (traversal)", kind)
	}
	return nil
}

// ValidateTaskID reports whether the given identifier is safe as a task ID.
func ValidateTaskID(taskID string) error {
	return validateID("taskId", taskID)
}

// ValidateStepID reports whether the given identifier is safe as a step ID.
func ValidateStepID(stepID string) error {
	return validateID("stepId", stepID)
}

// ValidateCommandID reports whether the given identifier is safe as a command ID.
func ValidateCommandID(commandID string) error {
	return validateID("commandId", commandID)
}

// Validate checks the command envelope for validity and safety.
func (c *Command) Validate(expectedAgentInstanceID, expectedVpsID string) error {
	if c.Version != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version: %d", c.Version)
	}
	if err := ValidateTaskID(c.TaskID); err != nil {
		return err
	}
	if err := ValidateStepID(c.StepID); err != nil {
		return err
	}
	if err := ValidateCommandID(c.CommandID); err != nil {
		return err
	}
	if c.VpsID != expectedVpsID {
		return fmt.Errorf("vpsId mismatch: expected %q, got %q", expectedVpsID, c.VpsID)
	}
	if c.AgentInstanceID != expectedAgentInstanceID {
		return fmt.Errorf("agentInstanceId mismatch: expected %q, got %q", expectedAgentInstanceID, c.AgentInstanceID)
	}
	if !validCommandKinds[c.Kind] {
		return fmt.Errorf("unsupported command kind: %q", c.Kind)
	}
	if c.Kind == KindFileRead || c.Kind == KindServiceStatus {
		if c.PlanVersion < 0 {
			return fmt.Errorf("invalid planVersion for read command: %d", c.PlanVersion)
		}
	} else {
		if c.PlanVersion < 1 {
			return fmt.Errorf("invalid planVersion for mutating command: %d (must be >= 1)", c.PlanVersion)
		}
	}
	if len(c.PlanDigest) < MinPlanDigestLen || len(c.PlanDigest) > MaxPlanDigestLen {
		return fmt.Errorf("invalid planDigest length: %d (must be between %d and %d)", len(c.PlanDigest), MinPlanDigestLen, MaxPlanDigestLen)
	}
	if len(c.DeadlineAt) > 0 {
		t, err := time.Parse(time.RFC3339, c.DeadlineAt)
		if err != nil {
			return fmt.Errorf("invalid deadlineAt RFC3339 timestamp: %w", err)
		}
		if time.Now().After(t) {
			return fmt.Errorf("command deadline already passed at %s", c.DeadlineAt)
		}
	}
	return nil
}

// ShellPayload is the payload for KindShell. ExecMode selects the execution
// path: "sandbox" (default, empty tolerated) requires sandbox confinement;
// "privileged" runs unconfined via the root helper and only requires the
// helper probe to have succeeded at worker start.
type ShellPayload struct {
	Script         string   `json:"script"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	ExecMode       string   `json:"execMode,omitempty"`
	ScratchDirs    []string `json:"scratchDirs,omitempty"`
}

// FileReadPayload is the payload for KindFileRead
type FileReadPayload struct {
	Path     string `json:"path"`
	Scope    string `json:"scope"`
	MaxBytes int64  `json:"maxBytes"`
}

// FileApplyPayload is the payload for KindFileApply
type FileApplyPayload struct {
	Path                   string `json:"path"`
	Scope                  string `json:"scope"`
	Content                string `json:"content"`
	ExpectedPreImageDigest string `json:"expectedPreImageDigest"`
	PostImageDigest        string `json:"postImageDigest"`
	Mode                   uint32 `json:"mode"`
	CreateNoReplace        bool   `json:"createNoReplace"`
}

// ServiceStatusPayload is the payload for KindServiceStatus
type ServiceStatusPayload struct {
	ProfileID string `json:"profileId"`
	Service   string `json:"service"`
}

// ServiceActionPayload is the payload for KindServiceAction
type ServiceActionPayload struct {
	ProfileID string `json:"profileId"`
	Service   string `json:"service"`
	Action    string `json:"action"` // start, stop, restart, reload
}

// ConfigValidatePayload is the payload for KindConfigValidate
type ConfigValidatePayload struct {
	ProfileID        string `json:"profileId"`
	TargetPath       string `json:"targetPath"`
	CandidateContent string `json:"candidateContent"`
}

// ConfigApplyPayload is the payload for KindConfigApply
type ConfigApplyPayload struct {
	ProfileID              string `json:"profileId"`
	TargetPath             string `json:"targetPath"`
	CandidateContent       string `json:"candidateContent"`
	ExpectedPreImageDigest string `json:"expectedPreImageDigest"`
	PostImageDigest        string `json:"postImageDigest"`
	ReloadService          bool   `json:"reloadService"`
}

// ConfigRecoverPayload is the payload for KindConfigRecover
type ConfigRecoverPayload struct {
	ProfileID               string `json:"profileId"`
	TargetPath              string `json:"targetPath"`
	BackupPath              string `json:"backupPath"`
	ExpectedPostImageDigest string `json:"expectedPostImageDigest"`
	RestoreService          bool   `json:"restoreService"`
}

// HeartbeatRequest is sent to POST /api/agent/ai/heartbeat
type HeartbeatRequest struct {
	Version         int    `json:"version"`
	TaskID          string `json:"taskId"`
	CommandID       string `json:"commandId"`
	AgentInstanceID string `json:"agentInstanceId"`
	Timestamp       string `json:"timestamp"`
}

// HeartbeatResponse is received from POST /api/agent/ai/heartbeat
type HeartbeatResponse struct {
	Data struct {
		Ok              bool `json:"ok"`
		CancelRequested bool `json:"cancelRequested"`
	} `json:"data"`
}

// OutputChunkRequest is sent to POST /api/agent/ai/output
type OutputChunkRequest struct {
	Version         int    `json:"version"`
	TaskID          string `json:"taskId"`
	CommandID       string `json:"commandId"`
	AgentInstanceID string `json:"agentInstanceId"`
	StreamID        string `json:"streamId"`
	Sequence        int64  `json:"sequence"`
	Chunk           string `json:"chunk"`
	IsGap           bool   `json:"isGap"`
	IsEnd           bool   `json:"isEnd"`
}

// OutputChunkResponse is received from POST /api/agent/ai/output
type OutputChunkResponse struct {
	Data struct {
		Ok              bool  `json:"ok"`
		AcknowledgedSeq int64 `json:"acknowledgedSeq,omitempty"`
	} `json:"data"`
}

// ResultRequest is sent to POST /api/agent/ai/result
type ResultRequest struct {
	Version         int    `json:"version"`
	AgentInstanceID string `json:"agentInstanceId"`
	TaskID          string `json:"taskId"`
	StepID          string `json:"stepId"`
	CommandID       string `json:"commandId"`
	PlanVersion     int    `json:"planVersion"`
	PlanDigest      string `json:"planDigest"`
	Status          string `json:"status"` // succeeded, failed, uncertain, cancelled
	Executed        bool   `json:"executed"`
	ExitCode        *int   `json:"exitCode,omitempty"`
	ErrorCode       string `json:"errorCode,omitempty"`
	ErrorMessage    string `json:"errorMessage,omitempty"`
	OutputPreview   string `json:"outputPreview,omitempty"`
	Payload         any    `json:"payload,omitempty"`
}

// ResultResponse is received from POST /api/agent/ai/result
type ResultResponse struct {
	Data struct {
		Ok              bool   `json:"ok"`
		CommandID       string `json:"commandId,omitempty"`
		AgentInstanceID string `json:"agentInstanceId,omitempty"`
	} `json:"data"`
}

// CancelStatusRequest is sent to POST /api/agent/ai/cancel-status
type CancelStatusRequest struct {
	Version         int    `json:"version"`
	TaskID          string `json:"taskId"`
	CommandID       string `json:"commandId"`
	AgentInstanceID string `json:"agentInstanceId"`
	Acknowledged    bool   `json:"acknowledged"`
	Terminated      bool   `json:"terminated"`
}

// CancelStatusResponse is received from POST /api/agent/ai/cancel-status
type CancelStatusResponse struct {
	Data struct {
		Ok bool `json:"ok"`
	} `json:"data"`
}

// Receipt is the durable record of a command lifecycle step.
type Receipt struct {
	Version          int       `json:"version"`
	CommandID        string    `json:"commandId"`
	TaskID           string    `json:"taskId"`
	StepID           string    `json:"stepId"`
	Kind             string    `json:"kind"`
	State            string    `json:"state"` // claimed, executing, succeeded, failed, uncertain, cancelled
	Executed         bool      `json:"executed"`
	PlanVersion      int       `json:"planVersion,omitempty"`
	PlanDigest       string    `json:"planDigest"`
	PayloadDigest    string    `json:"payloadDigest"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
	ErrorCode        string    `json:"errorCode,omitempty"`
	ErrorMessage     string    `json:"errorMessage,omitempty"`
	ObservedEvidence string    `json:"observedEvidence,omitempty"`
}

var tokenPattern = regexp.MustCompile(`vma_[a-zA-Z0-9_-]+`)

// SanitizeLog strips agent tokens and sensitive values from log strings.
func SanitizeLog(s string) string {
	return tokenPattern.ReplaceAllString(s, "[redacted]")
}

// ChunkRedactor provides stateful streaming redaction across chunk boundaries
// using line-oriented buffering so secrets cut across packets are not partially emitted.
type ChunkRedactor struct {
	mu      sync.Mutex
	buffer  string
	discard bool
}

const maxRedactorLineLen = 16 * 1024

// NewChunkRedactor creates a new stateful chunk redactor.
func NewChunkRedactor() *ChunkRedactor {
	return &ChunkRedactor{}
}

// Process ingests a streaming chunk, redacts complete lines, and returns the sanitized text.
// Any incomplete trailing line is retained until the next chunk or Flush.
func (r *ChunkRedactor) Process(chunk string) string {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.buffer += chunk
	var out strings.Builder

	for {
		idx := strings.IndexByte(r.buffer, '\n')
		if idx == -1 {
			break
		}
		rawLine := r.buffer[:idx+1]
		r.buffer = r.buffer[idx+1:]

		if r.discard {
			r.discard = false
			out.WriteString("[redacted]\n")
			continue
		}

		out.WriteString(SanitizeLog(rawLine))
	}

	if len(r.buffer) > maxRedactorLineLen {
		r.discard = true
		r.buffer = ""
		out.WriteString("[redacted]\n")
	}

	return out.String()
}

// Flush sanitizes and returns any remaining incomplete line in the buffer.
func (r *ChunkRedactor) Flush() string {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.discard {
		r.discard = false
		return "[redacted]\n"
	}
	if len(r.buffer) > 0 {
		out := SanitizeLog(r.buffer)
		r.buffer = ""
		return out
	}
	return ""
}

// Reset clears any buffered state.
func (r *ChunkRedactor) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buffer = ""
	r.discard = false
}
