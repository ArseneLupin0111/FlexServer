package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"time"
)

var (
	ErrHelperUnavailable = errors.New("ai host helper socket unavailable")
	ErrHelperFailed      = errors.New("ai host helper operation failed")
)

// HelperRequest is sent to the root ai-host-helper Unix socket.
type HelperRequest struct {
	Op     string          `json:"op"`
	Params json.RawMessage `json:"params"`
}

// HelperResponse is received from the helper.
type HelperResponse struct {
	Ok    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// HelperClient provides typed RPCs to the root-owned ai-host-helper.
type HelperClient struct {
	socketPath string
}

// NewHelperClient creates a new HelperClient.
func NewHelperClient(socketPath string) *HelperClient {
	return &HelperClient{
		socketPath: socketPath,
	}
}

func (c *HelperClient) call(ctx context.Context, op string, params any, result any) error {
	if c.socketPath == "" {
		return ErrHelperUnavailable
	}

	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", c.socketPath)
	if err != nil {
		return fmt.Errorf("%w: dial %s: %v", ErrHelperUnavailable, c.socketPath, err)
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	}

	rawParams, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("marshal params: %w", err)
	}

	req := HelperRequest{
		Op:     op,
		Params: rawParams,
	}

	reqBytes, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	if _, err := conn.Write(append(reqBytes, '\n')); err != nil {
		return fmt.Errorf("writing to helper: %w", err)
	}

	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return fmt.Errorf("reading from helper: %w", err)
	}

	var resp HelperResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return fmt.Errorf("unmarshal helper response: %w", err)
	}

	if !resp.Ok {
		return fmt.Errorf("%w: %s", ErrHelperFailed, resp.Error)
	}

	if result != nil && len(resp.Data) > 0 {
		if err := json.Unmarshal(resp.Data, result); err != nil {
			return fmt.Errorf("unmarshal helper data: %w", err)
		}
	}

	return nil
}

// ServiceStatusParams is the param for op "service_status"
type ServiceStatusParams struct {
	ProfileID string `json:"profileId"`
	Service   string `json:"service"`
}

// ServiceStatusResult is the data returned for "service_status"
type ServiceStatusResult struct {
	Service  string `json:"service"`
	Active   bool   `json:"active"`
	Substate string `json:"substate"`
	PID      int    `json:"pid"`
}

// ServiceStatus queries systemd status for a service.
func (c *HelperClient) ServiceStatus(ctx context.Context, profileID, service string) (*ServiceStatusResult, error) {
	var res ServiceStatusResult
	err := c.call(ctx, "service_status", ServiceStatusParams{
		ProfileID: profileID,
		Service:   service,
	}, &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// ServiceActionParams is the param for op "service_action"
type ServiceActionParams struct {
	ProfileID string `json:"profileId"`
	Service   string `json:"service"`
	Action    string `json:"action"` // start, stop, restart, reload
}

// ServiceActionResult is the data returned for "service_action"
type ServiceActionResult struct {
	Service string `json:"service"`
	Action  string `json:"action"`
	Success bool   `json:"success"`
}

// ServiceAction executes a permitted service lifecycle action.
func (c *HelperClient) ServiceAction(ctx context.Context, profileID, service, action string) (*ServiceActionResult, error) {
	var res ServiceActionResult
	err := c.call(ctx, "service_action", ServiceActionParams{
		ProfileID: profileID,
		Service:   service,
		Action:    action,
	}, &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// ConfigValidateParams is the param for op "config_validate"
type ConfigValidateParams struct {
	ProfileID        string `json:"profileId"`
	TargetPath       string `json:"targetPath"`
	CandidateContent string `json:"candidateContent"`
}

// ConfigValidateResult is the data returned for "config_validate"
type ConfigValidateResult struct {
	Valid          bool   `json:"valid"`
	ValidatorOutput string `json:"validatorOutput"`
}

// ValidateConfig executes the profile validator against candidate content.
func (c *HelperClient) ValidateConfig(ctx context.Context, profileID, targetPath, candidateContent string) (*ConfigValidateResult, error) {
	var res ConfigValidateResult
	err := c.call(ctx, "config_validate", ConfigValidateParams{
		ProfileID:        profileID,
		TargetPath:       targetPath,
		CandidateContent: candidateContent,
	}, &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// CgroupCreateParams is the param for op "cgroup_create"
type CgroupCreateParams struct {
	TaskID       string `json:"taskId"`
	CPUMax       string `json:"cpuMax"`    // e.g. "100000 100000" for 1 CPU
	MemoryMax    int64  `json:"memoryMax"` // bytes, e.g. 268435456 for 256 MiB
	PidsMax      int64  `json:"pidsMax"`   // e.g. 64
	ExecutionUID int    `json:"executionUid"`
	ExecutionGID int    `json:"executionGid,omitempty"`
}

// CreateCgroup creates a sub-cgroup with resource limits. Task IDs are validated
// before they reach the helper: they key filesystem paths under the AI cgroup,
// so anything outside the strict alphabet fails closed.
func (c *HelperClient) CreateCgroup(ctx context.Context, params CgroupCreateParams) error {
	if err := ValidateTaskID(params.TaskID); err != nil {
		return err
	}
	return c.call(ctx, "cgroup_create", params, nil)
}

// CgroupKillParams is the param for op "cgroup_kill"
type CgroupKillParams struct {
	TaskID string `json:"taskId"`
}

// KillCgroup kills all processes in the task cgroup and cleans it up. Task IDs
// are validated before they reach the helper: they key filesystem paths under
// the AI cgroup, so anything outside the strict alphabet fails closed.
func (c *HelperClient) KillCgroup(ctx context.Context, taskID string) error {
	if err := ValidateTaskID(taskID); err != nil {
		return err
	}
	return c.call(ctx, "cgroup_kill", CgroupKillParams{TaskID: taskID}, nil)
}

// TaskExecuteParams is sent to helper for op "task_execute"
type TaskExecuteParams struct {
	TaskID         string `json:"taskId"`
	CommandID      string `json:"commandId"`
	Script         string `json:"script"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	ScratchRootDir string `json:"scratchRootDir"`
	RootfsDir      string `json:"rootfsDir"`
	ExecutionUID   int    `json:"executionUid"`
	ExecutionGID   int    `json:"executionGid"`
}

// TaskExecuteStreamMessage is a streamed line from the helper during task_execute
type TaskExecuteStreamMessage struct {
	Stream     string `json:"stream"` // stdout, stderr, exit, error
	Data       string `json:"data,omitempty"`
	ExitCode   int    `json:"exitCode,omitempty"`
	Terminated bool   `json:"terminated,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ExecuteTask requests the root helper to spawn the namespace executor in isolated
// cgroup scope and streams output back.
func (c *HelperClient) ExecuteTask(ctx context.Context, params TaskExecuteParams, outputCb func(chunk string, isStderr bool)) (*ShellExecutionResult, error) {
	if c.socketPath == "" {
		return nil, ErrHelperUnavailable
	}
	if err := ValidateTaskID(params.TaskID); err != nil {
		return nil, fmt.Errorf("invalid taskId: %w", err)
	}
	return c.streamExecute(ctx, "task_execute", params, outputCb)
}

// streamExecute opens the helper socket, frames a single HelperRequest for op,
// and consumes the streamed TaskExecuteStreamMessage reply (stdout/stderr/exit/
// error lines) until EOF, mirroring the wire protocol of the sandbox task
// execution. Shared by task_execute and privileged_execute.
func (c *HelperClient) streamExecute(ctx context.Context, op string, params any, outputCb func(chunk string, isStderr bool)) (*ShellExecutionResult, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", c.socketPath)
	if err != nil {
		return nil, fmt.Errorf("%w: dial %s: %v", ErrHelperUnavailable, c.socketPath, err)
	}
	defer conn.Close()

	rawParams, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("marshal params: %w", err)
	}
	req := HelperRequest{
		Op:     op,
		Params: rawParams,
	}
	reqBytes, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	if _, err := conn.Write(append(reqBytes, '\n')); err != nil {
		return nil, fmt.Errorf("writing to helper: %w", err)
	}

	done := make(chan struct{})
	defer close(done)

	go func() {
		select {
		case <-done:
		case <-ctx.Done():
			_ = conn.Close()
		}
	}()

	stdoutSnippet := NewBoundedWriter(MaxOutputPreviewBytes)
	stderrSnippet := NewBoundedWriter(MaxOutputPreviewBytes)
	scanner := bufio.NewScanner(conn)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	var lastExitCode int
	var wasTerminated bool
	receivedExit := false

	for scanner.Scan() {
		var msg TaskExecuteStreamMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		switch msg.Stream {
		case "stdout":
			stdoutSnippet.Write([]byte(msg.Data))
			if outputCb != nil {
				outputCb(msg.Data, false)
			}
		case "stderr":
			stderrSnippet.Write([]byte(msg.Data))
			if outputCb != nil {
				outputCb(msg.Data, true)
			}
		case "exit":
			lastExitCode = msg.ExitCode
			wasTerminated = msg.Terminated
			receivedExit = true
		case "error":
			return nil, fmt.Errorf("%w: %s", ErrHelperFailed, msg.Error)
		}
	}

	if err := scanner.Err(); err != nil && !receivedExit {
		if ctx.Err() != nil {
			return &ShellExecutionResult{
				ExitCode:      137,
				StdoutSnippet: stdoutSnippet.String(),
				StderrSnippet: stderrSnippet.String(),
				Terminated:    true,
			}, ctx.Err()
		}
		return nil, fmt.Errorf("streaming from helper: %w", err)
	}

	if !receivedExit && ctx.Err() != nil {
		return &ShellExecutionResult{
			ExitCode:      137,
			StdoutSnippet: stdoutSnippet.String(),
			StderrSnippet: stderrSnippet.String(),
			Terminated:    true,
		}, ctx.Err()
	}

	return &ShellExecutionResult{
		ExitCode:      lastExitCode,
		StdoutSnippet: stdoutSnippet.String(),
		StderrSnippet: stderrSnippet.String(),
		Terminated:    wasTerminated,
	}, nil
}

// PrivilegedProbeParams is the (empty) param for op "privileged_probe".
type PrivilegedProbeParams struct{}

// PrivilegedProbeResult is the data returned for "privileged_probe".
type PrivilegedProbeResult struct {
	Supported bool `json:"supported"`
}

// ProbePrivileged asks the helper whether it supports privileged (root,
// non-confined) script execution. An old helper that does not know the op
// answers with an error, which maps to supported=false here: callers fail
// closed when the helper is missing, unreachable, or outdated.
func (c *HelperClient) ProbePrivileged(ctx context.Context) (bool, error) {
	var res PrivilegedProbeResult
	if err := c.call(ctx, "privileged_probe", PrivilegedProbeParams{}, &res); err != nil {
		return false, err
	}
	if !res.Supported {
		return false, fmt.Errorf("%w: helper reports privileged execution unsupported", ErrHelperFailed)
	}
	return true, nil
}

// PrivilegedExecuteParams is sent to helper for op "privileged_execute". Unlike
// TaskExecuteParams there is no confinement identity: the script runs with the
// helper's own (root) privileges under the upstream per-command approval boundary.
type PrivilegedExecuteParams struct {
	TaskID         string `json:"taskId"`
	CommandID      string `json:"commandId"`
	Script         string `json:"script"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

// ExecutePrivileged requests the root helper to run the script unconfined with
// root privileges and streams output back. Transport, framing, and streaming
// mirror ExecuteTask exactly; the caller owns the human-approval/redaction
// boundary upstream of this call.
func (c *HelperClient) ExecutePrivileged(ctx context.Context, params PrivilegedExecuteParams, outputCb func(chunk string, isStderr bool)) (*ShellExecutionResult, error) {
	if c.socketPath == "" {
		return nil, ErrHelperUnavailable
	}
	if err := ValidateTaskID(params.TaskID); err != nil {
		return nil, fmt.Errorf("invalid taskId: %w", err)
	}
	return c.streamExecute(ctx, "privileged_execute", params, outputCb)
}

// ConfigApplyParams specifies a privileged CAS mutation routed via helper.
type ConfigApplyParams struct {
	ProfileID              string `json:"profileId"`
	TargetPath             string `json:"targetPath"`
	CandidateContent       string `json:"candidateContent"`
	ExpectedPreImageDigest string `json:"expectedPreImageDigest"`
	PostImageDigest        string `json:"postImageDigest"`
	CreateNoReplace        bool   `json:"createNoReplace"`
}

// ConfigApplyResult is returned by helper after applying a config mutation.
type ConfigApplyResult struct {
	Applied         bool   `json:"applied"`
	Path            string `json:"path"`
	PostImageDigest string `json:"postImageDigest"`
	BackupPath      string `json:"backupPath,omitempty"`
}

// ConfigApply routes a privileged CAS config change via the root helper.
func (c *HelperClient) ConfigApply(ctx context.Context, params ConfigApplyParams) (*ConfigApplyResult, error) {
	var res ConfigApplyResult
	err := c.call(ctx, "config_apply", params, &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// ConfigRecoverParams specifies a rollback mutation routed via helper.
type ConfigRecoverParams struct {
	ProfileID    string `json:"profileId"`
	TargetPath   string `json:"targetPath"`
	TargetDigest string `json:"targetDigest"`
	BackupPath   string `json:"backupPath"`
}

// ConfigRecoverResult is returned after helper rollback.
type ConfigRecoverResult struct {
	Recovered bool   `json:"recovered"`
	Path      string `json:"path"`
	Digest    string `json:"digest"`
}

// ConfigRecover routes a privileged config rollback via the root helper.
func (c *HelperClient) ConfigRecover(ctx context.Context, params ConfigRecoverParams) (*ConfigRecoverResult, error) {
	var res ConfigRecoverResult
	err := c.call(ctx, "config_recover", params, &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}
