// Package commands implements P3 Go agent command transport + Docker control.
//
// Explicit endpoint contract (no API imports; compile dependency is only
// internal/config for backend URL/token/timeout):
//
//	POST {backendURL}/api/agent/commands/claim
//	  Authorization: Bearer <agent token> (never logged; vma_* redacted)
//	  Content-Type: application/json
//	  Body: {"agentInstanceId":"<32-char opaque>"}
//	  200 {"data":{"command":{...}|null}} — null/absent means none queued.
//	  204 with empty body also means none queued.
//	  401/403 fatal (ErrAuth), 409 conflict non-retry (ErrConflict),
//	  400/404 fatal (ErrFatal), 5xx/network retryable (ErrRetryable).
//	  2xx bodies bounded at 32KiB; oversize/trailing-JSON/invalid shape
//	  fails closed to an error (never acts on truncated input).
//
//	POST {backendURL}/api/agent/commands/result
//	  Body: {"commandId","agentInstanceId","status","executed",
//	         "exitCode?","errorCode?","outputPreview?"}
//	  200 {"data":{"ok":true,"commandId":"...","agentInstanceId":"..."}}
//	  Echo must match the reported IDs exactly or pending is preserved.
//	  Same status mapping as claim. A 5xx/transport failure after the daemon
//	  may have acted preserves the terminal receipt for report-only retry:
//	  the action is NEVER re-executed (see Worker).
//
// Docker control invariant: only this package (plus the existing metrics
// collector) touches the Docker socket, and only via the explicit POST
// allowlist in worker.go (start/stop/restart on full 64-char lowercase hex
// IDs). No generic path from API/UI input. Unknown actions fail closed.
// Metrics collection (pushWithState) is untouched and independent: this
// package never imports metrics/push/run/state.
package commands

import (
	"fmt"
	"regexp"
	"unicode/utf8"
)

// Bounded command actions: the only Docker control operations allowed.
const (
	ActionStart   = "start"
	ActionStop    = "stop"
	ActionRestart = "restart"
)

// Durable receipt states (single pending command).
const (
	ReceiptClaimed   = "claimed"
	ReceiptExecuting = "executing"
	ReceiptSucceeded = "succeeded"
	ReceiptFailed    = "failed"
	ReceiptUncertain = "uncertain"
)

// Result statuses reported to the API.
const (
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"
	StatusUncertain = "uncertain"
)

// Bounded error codes the agent may report. Anything else fails closed.
const (
	ErrCodeContainerNotFound = "container_not_found"
	ErrCodeTargetBusy        = "target_busy"
	ErrCodeActionFailed      = "action_failed"
	ErrCodeDeadlineExceeded  = "deadline_exceeded"
	ErrCodeTargetMismatch    = "target_mismatch"
	ErrCodeIdentityMismatch  = "identity_mismatch"
	ErrCodeUnsupportedAction = "unsupported_action"
	ErrCodeDaemonUnreach     = "daemon_unreachable"
	ErrCodeTimeout           = "timeout"
	ErrCodeUncertainOutcome  = "uncertain_outcome"
)

var commandErrorAllowlist = map[string]bool{
	ErrCodeContainerNotFound: true,
	ErrCodeTargetBusy:        true,
	ErrCodeActionFailed:      true,
	ErrCodeDeadlineExceeded:  true,
	ErrCodeTargetMismatch:    true,
	ErrCodeIdentityMismatch:  true,
	ErrCodeUnsupportedAction: true,
	ErrCodeDaemonUnreach:     true,
	ErrCodeTimeout:           true,
	ErrCodeUncertainOutcome:  true,
}

// Bounds mirror the monitoring validators.
const (
	MaxCommandIDLen     = 64
	MaxInstanceIDLen    = 32
	MaxContainerKeyLen  = 32
	MaxVpsIDLen         = 64
	MaxErrorCodeLen     = 64
	MaxDeadlineNanoLen  = 32
	MaxPreviewBytes     = 8 * 1024
	MaxCommandRespBytes = 32 * 1024

	MaxCommandTimeoutSeconds = 120
	MinCommandTimeoutSeconds = 1
)

// Command is the bounded claim payload. Daemon IDs are never transmitted:
// the target is the opaque containerKey; the agent resolves it locally.
type Command struct {
	CommandID       string `json:"commandId"`
	AgentInstanceID string `json:"agentInstanceId"`
	VpsID           string `json:"vpsId,omitempty"`
	Action          string `json:"action"`
	ContainerKey    string `json:"containerKey"`
	DeadlineNano    string `json:"deadlineNano"`
	TimeoutSeconds  int    `json:"timeoutSeconds"`
	TTY             bool   `json:"tty,omitempty"`
}

// Result is the bounded report payload.
type Result struct {
	CommandID       string `json:"commandId"`
	AgentInstanceID string `json:"agentInstanceId"`
	Status          string `json:"status"`
	Executed        bool   `json:"executed"`
	ExitCode        *int   `json:"exitCode,omitempty"`
	ErrorCode       string `json:"errorCode,omitempty"`
	OutputPreview   string `json:"outputPreview,omitempty"`
}

// Receipt is the durable single-pending-command record: persisted before
// execute (claimed), moved to executing immediately before the daemon call,
// then to exactly one terminal state. Executed means the daemon may have
// been touched — a receipt with Executed=true (including every uncertain
// receipt) must never be re-executed, only re-reported. DeadlineNano and
// TimeoutSeconds are persisted so crash recovery re-applies the same bounds.
type Receipt struct {
	CommandID       string `json:"commandId"`
	AgentInstanceID string `json:"agentInstanceId"`
	Action          string `json:"action"`
	ContainerKey    string `json:"containerKey"`
	DeadlineNano    string `json:"deadlineNano"`
	TimeoutSeconds  int    `json:"timeoutSeconds"`
	TTY             bool   `json:"tty,omitempty"`
	State           string `json:"state"`
	Executed        bool   `json:"executed"`
	OutputPreview   string `json:"outputPreview,omitempty"`
	ErrorCode       string `json:"errorCode,omitempty"`
	FenceScope      string `json:"fenceScope,omitempty"`
}

var (
	safeIDPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)
	nanoPattern   = regexp.MustCompile(`^(0|[1-9][0-9]{0,31})$`)
)

func validSafeID(s string, max int) bool {
	if len(s) == 0 || len(s) > max {
		return false
	}
	return safeIDPattern.MatchString(s)
}

func validNano(s string) bool {
	if len(s) == 0 || len(s) > MaxDeadlineNanoLen {
		return false
	}
	return nanoPattern.MatchString(s)
}

// ValidateAction fails closed on anything outside start/stop/restart.
func ValidateAction(a string) error {
	switch a {
	case ActionStart, ActionStop, ActionRestart:
		return nil
	default:
		return fmt.Errorf("unsupported action")
	}
}

func validateReceiptState(s string) error {
	switch s {
	case ReceiptClaimed, ReceiptExecuting,
		ReceiptSucceeded, ReceiptFailed, ReceiptUncertain:
		return nil
	default:
		return fmt.Errorf("unsupported receipt state")
	}
}

func validateResultStatus(s string) error {
	switch s {
	case StatusSucceeded, StatusFailed, StatusUncertain:
		return nil
	}
	return fmt.Errorf("unsupported result status")
}

func validateExitCode(v *int) error {
	if v == nil {
		return nil
	}
	if *v < 0 || *v > 255 {
		return fmt.Errorf("exit code out of range")
	}
	return nil
}

func validateErrorCode(code string) error {
	if code == "" {
		return nil
	}
	if len(code) > MaxErrorCodeLen {
		return fmt.Errorf("error code oversize")
	}
	if !commandErrorAllowlist[code] {
		return fmt.Errorf("unapproved error code")
	}
	return nil
}

func validatePreview(p string) error {
	if len(p) > MaxPreviewBytes {
		return fmt.Errorf("output preview oversize")
	}
	if !utf8.ValidString(p) {
		return fmt.Errorf("output preview not valid UTF-8")
	}
	return nil
}

// ValidateCommand enforces bounded shape. Identity/deadline/target checks
// against local state happen in Worker; this is wire shape only.
func ValidateCommand(c *Command) error {
	if c == nil {
		return fmt.Errorf("nil command")
	}
	if !validSafeID(c.CommandID, MaxCommandIDLen) {
		return fmt.Errorf("bad commandId")
	}
	if !validSafeID(c.AgentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	if c.VpsID != "" && !validSafeID(c.VpsID, MaxVpsIDLen) {
		return fmt.Errorf("bad vpsId")
	}
	if err := ValidateAction(c.Action); err != nil {
		return err
	}
	if !validSafeID(c.ContainerKey, MaxContainerKeyLen) {
		return fmt.Errorf("bad containerKey")
	}
	if !validNano(c.DeadlineNano) {
		return fmt.Errorf("non-canonical deadlineNano")
	}
	if c.TimeoutSeconds < MinCommandTimeoutSeconds || c.TimeoutSeconds > MaxCommandTimeoutSeconds {
		return fmt.Errorf("timeoutSeconds out of range")
	}
	return nil
}

// ValidateResult enforces bounded report shape.
func ValidateResult(r *Result) error {
	if r == nil {
		return fmt.Errorf("nil result")
	}
	if !validSafeID(r.CommandID, MaxCommandIDLen) {
		return fmt.Errorf("bad commandId")
	}
	if !validSafeID(r.AgentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	if err := validateResultStatus(r.Status); err != nil {
		return err
	}
	if err := validateExitCode(r.ExitCode); err != nil {
		return err
	}
	if err := validateErrorCode(r.ErrorCode); err != nil {
		return err
	}
	if err := validatePreview(r.OutputPreview); err != nil {
		return err
	}
	// Terminal consistency: uncertain always means the daemon may have been
	// touched; succeeded/failed carry an explicit executed flag.
	if r.Status == StatusUncertain && !r.Executed {
		return fmt.Errorf("uncertain result must set executed")
	}
	return nil
}

// ValidateReceipt enforces durable receipt shape.
func ValidateReceipt(r *Receipt) error {
	if r == nil {
		return fmt.Errorf("nil receipt")
	}
	if !validSafeID(r.CommandID, MaxCommandIDLen) {
		return fmt.Errorf("bad commandId")
	}
	if !validSafeID(r.AgentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	if err := ValidateAction(r.Action); err != nil {
		return err
	}
	if !validSafeID(r.ContainerKey, MaxContainerKeyLen) {
		return fmt.Errorf("bad containerKey")
	}
	if !validNano(r.DeadlineNano) {
		return fmt.Errorf("non-canonical deadlineNano")
	}
	if r.TimeoutSeconds < MinCommandTimeoutSeconds || r.TimeoutSeconds > MaxCommandTimeoutSeconds {
		return fmt.Errorf("timeoutSeconds out of range")
	}
	if err := validateReceiptState(r.State); err != nil {
		return err
	}
	if err := validateErrorCode(r.ErrorCode); err != nil {
		return err
	}
	if err := validatePreview(r.OutputPreview); err != nil {
		return err
	}
	if r.State == ReceiptUncertain && !r.Executed {
		return fmt.Errorf("uncertain receipt must set executed")
	}
	return nil
}
