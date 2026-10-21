package ai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"strings"

	"github.com/vps-manager/agent/internal/config"
)

// AIClient defines the transport methods needed by Worker.
type AIClient interface {
	Claim(ctx context.Context, req *ClaimRequest) (*Command, error)
	Heartbeat(ctx context.Context, req *HeartbeatRequest) (*HeartbeatResponse, error)
	Output(ctx context.Context, req *OutputChunkRequest) (*OutputChunkResponse, error)
	Result(ctx context.Context, req *ResultRequest) (*ResultResponse, error)
	CancelStatus(ctx context.Context, req *CancelStatusRequest) (*CancelStatusResponse, error)
}

// Worker runs the P3/P4 AI command claim, execution, heartbeat, and result loop.
type Worker struct {
	cfg          *config.Config
	instanceID   string
	logger       *log.Logger
	client       AIClient
	receipts     ReceiptStore
	broker       *FileBroker
	profiles     *ProfileRegistry
	helper       *HelperClient
	executor     ShellExecutor
	capabilities HostCapabilities
	mu           sync.Mutex
	activeTask   string
}
// NewWorker initializes the AI worker from agent configuration.
func NewWorker(cfg *config.Config, instanceID string, logger *log.Logger) (*Worker, error) {
	if logger == nil {
		logger = log.Default()
	}

	stateDir := cfg.AI.StatePath
	if stateDir == "" {
		stateDir = filepath.Join(cfg.StatePath, "ai")
	}

	receiptsDir := filepath.Join(stateDir, "receipts")
	receiptStore, err := NewFileReceiptStore(receiptsDir)
	if err != nil {
		return nil, fmt.Errorf("initializing receipt store: %w", err)
	}

	fileBroker, err := NewFileBroker(stateDir, nil)
	if err != nil {
		return nil, fmt.Errorf("initializing file broker: %w", err)
	}

	profileRegistry, err := LoadProfileRegistry(cfg.AI.ProfilesDirPath)
	if err != nil {
		return nil, fmt.Errorf("loading profile registry: %w", err)
	}

	caps := DetectCapabilities(cfg.AI.RootfsDirPath, cfg.AI.RootfsManifestPath, cfg.AI.ProfilesDirPath)
	caps.Profiles = profileRegistry.List()
	if caps.Profiles == nil {
		caps.Profiles = []string{}
	}
	return &Worker{
		cfg:          cfg,
		instanceID:   instanceID,
		logger:       logger,
		client:       NewClient(cfg),
		receipts:     receiptStore,
		broker:       fileBroker,
		profiles:     profileRegistry,
		helper:       NewHelperClient(cfg.AI.HelperSocketPath),
		executor:     NewShellExecutor(),
		capabilities: caps,
	}, nil
}

// Capabilities returns the detected host capabilities.
func (w *Worker) Capabilities() HostCapabilities {
	return w.capabilities
}

// SetClient overrides the client transport (for testing).
func (w *Worker) SetClient(c AIClient) {
	w.client = c
}

// ReconcilePendingReceipts runs receipt recovery (exported for testing).
func (w *Worker) ReconcilePendingReceipts(ctx context.Context) {
	w.reconcilePendingReceipts(ctx)
}

// DispatchCommand dispatches a single command (exported for testing).
func (w *Worker) DispatchCommand(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	return w.dispatch(ctx, cmd)
}

// Run executes the worker loop until ctx is canceled.
func (w *Worker) Run(ctx context.Context) {
	w.logger.Printf("ai worker started (supported=%v, reason=%q)", w.capabilities.Supported, w.capabilities.UnsupportedReason)

	// Startup reconciliation of pending receipts
	w.reconcilePendingReceipts(ctx)

	interval := time.Duration(w.cfg.IntervalSeconds) * time.Second
	if interval < 2*time.Second {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			w.logger.Println("ai worker stopping")
			return
		case <-ticker.C:
			cycleCtx, cycleCancel := context.WithTimeout(ctx, 45*time.Second)
			if err := w.ProcessOne(cycleCtx); err != nil && ctx.Err() == nil {
				w.logger.Printf("ai worker cycle error: %v", err)
			}
			cycleCancel()
		}
	}
}

// reconcilePendingReceipts handles crashes or restarts where previous commands were left executing.
func (w *Worker) reconcilePendingReceipts(ctx context.Context) {
	pending, err := w.receipts.ListPending()
	if err != nil {
		w.logger.Printf("error listing pending receipts: %v", err)
		return
	}

	for _, r := range pending {
		w.logger.Printf("reconciling pending receipt %s in state %s", r.CommandID, r.State)
		if r.State == ReceiptExecuting {
			// Per plan §7.3: Ghi durable executing trước side effect. Crash từ marker tới receipt cuối -> uncertain.
			_, _ = w.receipts.Transition(r.CommandID, ReceiptExecuting, ReceiptUncertain, func(rc *Receipt) {
				rc.ErrorCode = ErrCodeUncertainOutcome
				rc.ErrorMessage = "agent restarted while command was executing"
			})
			req := &ResultRequest{
				Version:         ProtocolVersion,
				TaskID:          r.TaskID,
				StepID:          r.StepID,
				CommandID:       r.CommandID,
				AgentInstanceID: w.instanceID,
				PlanVersion:     r.PlanVersion,
				PlanDigest:      r.PlanDigest,
				Status:          StatusUncertain,
				Executed:        true,
				ErrorCode:       ErrCodeUncertainOutcome,
				ErrorMessage:    "agent restarted while command was executing",
			}
			_, _ = w.client.Result(ctx, req)
		} else if r.State == ReceiptClaimed {
			_, _ = w.receipts.Transition(r.CommandID, ReceiptClaimed, ReceiptFailed, func(rc *Receipt) {
				rc.ErrorCode = ErrCodeExecutionFailed
				rc.ErrorMessage = "agent restarted before command began executing"
			})
			req := &ResultRequest{
				Version:         ProtocolVersion,
				TaskID:          r.TaskID,
				StepID:          r.StepID,
				CommandID:       r.CommandID,
				AgentInstanceID: w.instanceID,
				PlanVersion:     r.PlanVersion,
				PlanDigest:      r.PlanDigest,
				Status:          StatusFailed,
				Executed:        false,
				ErrorCode:       ErrCodeExecutionFailed,
				ErrorMessage:    "agent restarted before command began executing",
			}
			_, _ = w.client.Result(ctx, req)
		}
	}
}

// ProcessOne polls for one command and executes it.
func (w *Worker) ProcessOne(ctx context.Context) error {
	claimReq := &ClaimRequest{
		Version:         ProtocolVersion,
		AgentInstanceID: w.instanceID,
		Capabilities:    w.capabilities,
	}

	cmd, err := w.client.Claim(ctx, claimReq)
	if err != nil {
		return fmt.Errorf("claim error: %w", err)
	}
	if cmd == nil {
		return nil
	}

	if err := cmd.Validate(w.instanceID, w.cfg.VpsId); err != nil {
		w.logger.Printf("rejected invalid command %s: %v", cmd.CommandID, err)
		resultReq := &ResultRequest{
			Version:         ProtocolVersion,
			TaskID:          cmd.TaskID,
			StepID:          cmd.StepID,
			CommandID:       cmd.CommandID,
			AgentInstanceID: w.instanceID,
			PlanVersion:     cmd.PlanVersion,
			PlanDigest:      cmd.PlanDigest,
			Status:          StatusFailed,
			Executed:        false,
			ErrorCode:       ErrCodeInvalidCommand,
			ErrorMessage:    err.Error(),
		}
		_, _ = w.client.Result(ctx, resultReq)
		return nil
	}

	return w.executeCommand(ctx, cmd)
}

func (w *Worker) executeCommand(ctx context.Context, cmd *Command) error {
	w.mu.Lock()
	w.activeTask = cmd.TaskID
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		w.activeTask = ""
		w.mu.Unlock()
	}()

	payloadHash := sha256.Sum256(cmd.Payload)
	payloadDigest := hex.EncodeToString(payloadHash[:])

	receipt := &Receipt{
		Version:       ProtocolVersion,
		CommandID:     cmd.CommandID,
		TaskID:        cmd.TaskID,
		StepID:        cmd.StepID,
		Kind:          cmd.Kind,
		State:         ReceiptClaimed,
		Executed:      false,
		PlanVersion:   cmd.PlanVersion,
		PlanDigest:    cmd.PlanDigest,
		PayloadDigest: payloadDigest,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}

	if err := w.receipts.Persist(receipt); err != nil {
		return fmt.Errorf("persisting initial receipt: %w", err)
	}

	// Persist-before-mutate: transition to "executing" before any mutation
	isMutation := cmd.Kind != KindFileRead && cmd.Kind != KindServiceStatus
	if isMutation {
		if _, err := w.receipts.Transition(cmd.CommandID, ReceiptClaimed, ReceiptExecuting, func(r *Receipt) {
			r.Executed = true
		}); err != nil {
			return fmt.Errorf("persisting executing receipt: %w", err)
		}
	}

	// Execution context with heartbeat cancellation monitoring
	execCtx, cancelExec := context.WithCancel(ctx)
	defer cancelExec()

	// Parse command deadline
	if cmd.DeadlineAt != "" {
		if deadline, err := time.Parse(time.RFC3339, cmd.DeadlineAt); err == nil {
			var deadlineCancel context.CancelFunc
			execCtx, deadlineCancel = context.WithDeadline(execCtx, deadline)
			defer deadlineCancel()
		}
	}

	// Start background heartbeat
	var cancelRequested atomic.Bool
	stopHeartbeat := make(chan struct{})
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopHeartbeat:
				return
			case <-ticker.C:
				hbReq := &HeartbeatRequest{
					Version:         ProtocolVersion,
					TaskID:          cmd.TaskID,
					CommandID:       cmd.CommandID,
					AgentInstanceID: w.instanceID,
					Timestamp:       time.Now().UTC().Format(time.RFC3339),
				}
				resp, err := w.client.Heartbeat(ctx, hbReq)
				if err == nil && resp != nil && resp.Data.CancelRequested {
					cancelRequested.Store(true)
					cancelExec()
					return
				}
			}
		}
	}()

	status, exitCode, errCode, errMsg, preview, resultPayload := w.dispatch(execCtx, cmd)
	close(stopHeartbeat)

	if cancelRequested.Load() {
		status = StatusCancelled
		errCode = ErrCodeCancelled
		errMsg = "command cancelled by user request"
		// Acknowledge cancellation status
		_, _ = w.client.CancelStatus(ctx, &CancelStatusRequest{
			Version:         ProtocolVersion,
			TaskID:          cmd.TaskID,
			CommandID:       cmd.CommandID,
			AgentInstanceID: w.instanceID,
			Acknowledged:    true,
			Terminated:      true,
		})
	}

	// Update receipt to terminal state
	terminalState := ReceiptSucceeded
	if status == StatusFailed {
		terminalState = ReceiptFailed
	} else if status == StatusUncertain {
		terminalState = ReceiptUncertain
	} else if status == StatusCancelled {
		terminalState = ReceiptCancelled
	}

	_, _ = w.receipts.Transition(cmd.CommandID, "", terminalState, func(r *Receipt) {
		r.ErrorCode = errCode
		r.ErrorMessage = errMsg
	})

	resultReq := &ResultRequest{
		Version:         ProtocolVersion,
		TaskID:          cmd.TaskID,
		StepID:          cmd.StepID,
		CommandID:       cmd.CommandID,
		AgentInstanceID: w.instanceID,
		PlanVersion:     cmd.PlanVersion,
		PlanDigest:      cmd.PlanDigest,
		Status:          status,
		Executed:        isMutation,
		ExitCode:        exitCode,
		ErrorCode:       errCode,
		ErrorMessage:    errMsg,
		OutputPreview:   preview,
		Payload:         resultPayload,
	}

	if _, err := w.client.Result(ctx, resultReq); err != nil {
		w.logger.Printf("reporting result for %s failed: %v", cmd.CommandID, err)
		return err
	}

	return nil
}

func (w *Worker) dispatch(ctx context.Context, cmd *Command) (status string, exitCode *int, errCode string, errMsg string, preview string, resultPayload any) {
	switch cmd.Kind {
	case KindShell:
		return w.dispatchShell(ctx, cmd)
	case KindFileRead:
		return w.dispatchFileRead(ctx, cmd)
	case KindFileApply:
		return w.dispatchFileApply(ctx, cmd)
	case KindServiceStatus:
		return w.dispatchServiceStatus(ctx, cmd)
	case KindServiceAction:
		return w.dispatchServiceAction(ctx, cmd)
	case KindConfigValidate:
		return w.dispatchConfigValidate(ctx, cmd)
	case KindConfigApply:
		return w.dispatchConfigApply(ctx, cmd)
	case KindConfigRecover:
		return w.dispatchConfigRecover(ctx, cmd)
	default:
		return StatusFailed, nil, ErrCodeUnsupportedAction, fmt.Sprintf("unsupported kind %q", cmd.Kind), "", nil
	}
}

func (w *Worker) dispatchShell(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	if !w.capabilities.Supported || !w.capabilities.CgroupV2 {
		return StatusFailed, nil, ErrCodeSandboxUnavailable, "sandboxed shell execution is unavailable on this host", "", nil
	}

	var p ShellPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return StatusFailed, nil, ErrCodeInvalidCommand, fmt.Sprintf("malformed shell payload: %v", err), "", nil
	}

	streamID := fmt.Sprintf("stream-%s", cmd.CommandID)
	var seq int64
	redactor := NewChunkRedactor()

	outputCb := func(chunk string, isGap bool, isEnd bool) {
		redacted := redactor.Process(chunk)
		if isEnd {
			redacted += redactor.Flush()
		}
		if len(redacted) == 0 && !isEnd {
			return
		}
		currentSeq := atomic.AddInt64(&seq, 1)
		_, _ = w.client.Output(context.Background(), &OutputChunkRequest{
			Version:         ProtocolVersion,
			TaskID:          cmd.TaskID,
			CommandID:       cmd.CommandID,
			AgentInstanceID: w.instanceID,
			StreamID:        streamID,
			Sequence:        currentSeq,
			Chunk:           redacted,
			IsGap:           isGap,
			IsEnd:           isEnd,
		})
	}

	opts := ShellExecutionOptions{
		TaskID:         cmd.TaskID,
		CommandID:      cmd.CommandID,
		Script:         p.Script,
		TimeoutSeconds: p.TimeoutSeconds,
		ScratchRootDir: w.cfg.AI.ScratchRootPath,
		RootfsDir:      w.cfg.AI.RootfsDirPath,
		ExecutorBinary: w.cfg.AI.ExecutorPath,
		ExecutionUID:   w.cfg.AI.ExecutionUID,
		ExecutionGID:   w.cfg.AI.ExecutionGID,
		HelperClient:   w.helper,
		OutputCallback: outputCb,
	}

	res, err := w.executor.Execute(ctx, opts)
	if err != nil {
		preview := ""
		if res != nil {
			preview = SanitizeLog(res.StdoutSnippet)
			preview = TruncateUTF8ToBytes(preview, MaxOutputPreviewBytes)
		}
		if errors.Is(err, ErrExecutionTimeout) {
			return StatusFailed, nil, ErrCodeDeadlineExceeded, "execution timed out", preview, res
		}
		if errors.Is(err, ErrExecutionCancelled) {
			return StatusCancelled, nil, ErrCodeCancelled, "execution cancelled", preview, res
		}
		return StatusFailed, nil, ErrCodeExecutionFailed, err.Error(), "", nil
	}

	code := res.ExitCode
	preview := res.StdoutSnippet
	if len(preview) == 0 && len(res.StderrSnippet) > 0 {
		preview = res.StderrSnippet
	}
	preview = SanitizeLog(preview)
	preview = TruncateUTF8ToBytes(preview, MaxOutputPreviewBytes)

	if code != 0 {
		return StatusFailed, &code, ErrCodeExecutionFailed, fmt.Sprintf("exit code %d", code), preview, res
	}

	return StatusSucceeded, &code, "", "", preview, res
}

func (w *Worker) dispatchFileRead(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	var p FileReadPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return StatusFailed, nil, ErrCodeInvalidCommand, err.Error(), "", nil
	}

	res, err := w.broker.ReadFile(p.Path, p.Scope, p.MaxBytes)
	if err != nil {
		if errors.Is(err, ErrProtectedPath) {
			return StatusFailed, nil, ErrCodeProtectedPath, err.Error(), "", nil
		}
		if errors.Is(err, ErrOutOfScope) {
			return StatusFailed, nil, ErrCodeTargetMismatch, err.Error(), "", nil
		}
		if errors.Is(err, ErrFileTooLarge) {
			return StatusFailed, nil, ErrCodeFileTooLarge, err.Error(), "", nil
		}
		return StatusFailed, nil, ErrCodeExecutionFailed, err.Error(), "", nil
	}

	preview := res.Content
	if len(preview) > 500 {
		preview = preview[:500] + "..."
	}

	return StatusSucceeded, nil, "", "", preview, res
}

func (w *Worker) dispatchFileApply(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	var p FileApplyPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return StatusFailed, nil, ErrCodeInvalidCommand, err.Error(), "", nil
	}

	res, err := w.broker.ApplyFile(&p)
	if err != nil {
		if errors.Is(err, ErrProtectedPath) {
			return StatusFailed, nil, ErrCodeProtectedPath, err.Error(), "", nil
		}
		if errors.Is(err, ErrDriftDetected) {
			return StatusFailed, nil, ErrCodeDriftDetected, err.Error(), "", nil
		}
		if errors.Is(err, ErrPreconditionFailed) {
			return StatusFailed, nil, ErrCodePreconditionFailed, err.Error(), "", nil
		}
		return StatusFailed, nil, ErrCodeExecutionFailed, err.Error(), "", nil
	}

	return StatusSucceeded, nil, "", "", fmt.Sprintf("applied to %s (backup %s)", res.Path, res.BackupPath), res
}

func (w *Worker) dispatchServiceStatus(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	var p ServiceStatusPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return StatusFailed, nil, ErrCodeInvalidCommand, err.Error(), "", nil
	}

	prof, err := w.profiles.Get(p.ProfileID)
	if err != nil {
		return StatusFailed, nil, ErrCodeProfileNotFound, err.Error(), "", nil
	}

	service := p.Service
	if service == "" {
		service = prof.ServiceUnit
	}

	res, err := w.helper.ServiceStatus(ctx, p.ProfileID, service)
	if err != nil {
		return StatusFailed, nil, ErrCodeHelperUnavailable, err.Error(), "", nil
	}

	preview := fmt.Sprintf("service %s: active=%v substate=%s pid=%d", res.Service, res.Active, res.Substate, res.PID)
	return StatusSucceeded, nil, "", "", preview, res
}

func (w *Worker) dispatchServiceAction(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	var p ServiceActionPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return StatusFailed, nil, ErrCodeInvalidCommand, err.Error(), "", nil
	}

	prof, err := w.profiles.Get(p.ProfileID)
	if err != nil {
		return StatusFailed, nil, ErrCodeProfileNotFound, err.Error(), "", nil
	}
	actLower := strings.ToLower(strings.TrimSpace(p.Action))
	if actLower == "stop" || actLower == "disable" || actLower == "mask" {
		return StatusFailed, nil, ErrCodeUnsupportedAction, fmt.Sprintf("action %q is forbidden by safety policy", p.Action), "", nil
	}

	if err := prof.ValidateAction(p.Action); err != nil {
		return StatusFailed, nil, ErrCodeUnsupportedAction, err.Error(), "", nil
	}

	service := p.Service
	if service == "" {
		service = prof.ServiceUnit
	}

	if IsProtectedPath(service) || IsProtectedPath(prof.ServiceUnit) {
		return StatusFailed, nil, ErrCodeProtectedPath, "service unit targets protected control-plane component", "", nil
	}

	if w.helper == nil {
		return StatusFailed, nil, ErrCodeHelperUnavailable, "root helper required for service actions", "", nil
	}

	res, err := w.helper.ServiceAction(ctx, p.ProfileID, service, p.Action)
	if err != nil {
		return StatusFailed, nil, ErrCodeExecutionFailed, err.Error(), "", nil
	}

	preview := fmt.Sprintf("action %s on %s: success=%v", p.Action, service, res.Success)
	return StatusSucceeded, nil, "", "", preview, res
}
func (w *Worker) dispatchConfigValidate(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	var p ConfigValidatePayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return StatusFailed, nil, ErrCodeInvalidCommand, err.Error(), "", nil
	}

	prof, err := w.profiles.Get(p.ProfileID)
	if err != nil {
		return StatusFailed, nil, ErrCodeProfileNotFound, err.Error(), "", nil
	}

	if err := prof.ValidateConfigPath(p.TargetPath); err != nil {
		return StatusFailed, nil, ErrCodeConfigPathDenied, err.Error(), "", nil
	}

	if err := prof.ValidateConfigContent(p.CandidateContent); err != nil {
		return StatusFailed, nil, ErrCodeValidationFailed, err.Error(), "", nil
	}

	res, err := w.helper.ValidateConfig(ctx, p.ProfileID, p.TargetPath, p.CandidateContent)
	if err != nil {
		return StatusFailed, nil, ErrCodeValidationFailed, err.Error(), "", nil
	}

	if !res.Valid {
		return StatusFailed, nil, ErrCodeValidationFailed, res.ValidatorOutput, res.ValidatorOutput, res
	}

	return StatusSucceeded, nil, "", "", "config validation passed", res
}

func (w *Worker) dispatchConfigApply(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	var p ConfigApplyPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return StatusFailed, nil, ErrCodeInvalidCommand, err.Error(), "", nil
	}

	prof, err := w.profiles.Get(p.ProfileID)
	if err != nil {
		return StatusFailed, nil, ErrCodeProfileNotFound, err.Error(), "", nil
	}

	if err := prof.ValidateConfigPath(p.TargetPath); err != nil {
		return StatusFailed, nil, ErrCodeConfigPathDenied, err.Error(), "", nil
	}

	if IsProtectedPath(p.TargetPath) {
		return StatusFailed, nil, ErrCodeProtectedPath, fmt.Sprintf("target path %q is protected", p.TargetPath), "", nil
	}

	if err := prof.ValidateConfigContent(p.CandidateContent); err != nil {
		return StatusFailed, nil, ErrCodeValidationFailed, err.Error(), "", nil
	}

	// 1. Validate candidate first
	if w.helper != nil {
		valRes, err := w.helper.ValidateConfig(ctx, p.ProfileID, p.TargetPath, p.CandidateContent)
		if err != nil || (valRes != nil && !valRes.Valid) {
			out := ""
			if valRes != nil {
				out = valRes.ValidatorOutput
			}
			return StatusFailed, nil, ErrCodeValidationFailed, fmt.Sprintf("pre-apply validation failed: %s (%v)", out, err), "", nil
		}
	}

	// 2. Route privileged CAS file mutation via root helper if available
	var backupPath string
	var appliedPath string
	var postDigest string
	if w.helper != nil {
		hRes, err := w.helper.ConfigApply(ctx, ConfigApplyParams{
			ProfileID:              p.ProfileID,
			TargetPath:             p.TargetPath,
			CandidateContent:       p.CandidateContent,
			ExpectedPreImageDigest: p.ExpectedPreImageDigest,
			PostImageDigest:        p.PostImageDigest,
			CreateNoReplace:        p.ExpectedPreImageDigest == "none" || p.ExpectedPreImageDigest == "",
		})
		if err != nil {
			return StatusFailed, nil, ErrCodeExecutionFailed, fmt.Sprintf("privileged helper config apply failed: %v", err), "", nil
		}
		backupPath = hRes.BackupPath
		appliedPath = hRes.Path
		postDigest = hRes.PostImageDigest
	} else {
		// Fallback to local FileBroker in test environments without root helper
		applyRes, err := w.broker.ApplyFile(&FileApplyPayload{
			Path:                   p.TargetPath,
			Content:                p.CandidateContent,
			ExpectedPreImageDigest: p.ExpectedPreImageDigest,
			PostImageDigest:        p.PostImageDigest,
		})
		if err != nil {
			if errors.Is(err, ErrDriftDetected) {
				return StatusFailed, nil, ErrCodeDriftDetected, err.Error(), "", nil
			}
			return StatusFailed, nil, ErrCodeExecutionFailed, err.Error(), "", nil
		}
		backupPath = applyRes.BackupPath
		appliedPath = applyRes.Path
		postDigest = applyRes.PostImageDigest
	}

	// 3. Reload service if requested
	if p.ReloadService && w.helper != nil {
		if _, err := w.helper.ServiceAction(ctx, p.ProfileID, prof.ServiceUnit, "reload"); err != nil {
			return StatusFailed, nil, ErrCodeExecutionFailed, fmt.Sprintf("file applied but reload failed: %v", err), "", nil
		}
	}

	resultData := map[string]any{
		"applied":         true,
		"path":            appliedPath,
		"postImageDigest": postDigest,
		"backupPath":      backupPath,
	}
	return StatusSucceeded, nil, "", "", fmt.Sprintf("config applied to %s (backup %s)", appliedPath, backupPath), resultData
}
func (w *Worker) dispatchConfigRecover(ctx context.Context, cmd *Command) (string, *int, string, string, string, any) {
	var p ConfigRecoverPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return StatusFailed, nil, ErrCodeInvalidCommand, err.Error(), "", nil
	}

	prof, err := w.profiles.Get(p.ProfileID)
	if err != nil {
		return StatusFailed, nil, ErrCodeProfileNotFound, err.Error(), "", nil
	}

	if err := prof.ValidateConfigPath(p.TargetPath); err != nil {
		return StatusFailed, nil, ErrCodeConfigPathDenied, err.Error(), "", nil
	}

	if IsProtectedPath(p.TargetPath) || IsProtectedPath(p.BackupPath) {
		return StatusFailed, nil, ErrCodeProtectedPath, "target or backup path is protected", "", nil
	}

	var recoveredPath string
	var recoveredDigest string
	if w.helper != nil {
		hRes, err := w.helper.ConfigRecover(ctx, ConfigRecoverParams{
			ProfileID:    p.ProfileID,
			TargetPath:   p.TargetPath,
			TargetDigest: p.ExpectedPostImageDigest,
			BackupPath:   p.BackupPath,
		})
		if err != nil {
			return StatusFailed, nil, ErrCodeExecutionFailed, fmt.Sprintf("privileged helper config recover failed: %v", err), "", nil
		}
		recoveredPath = hRes.Path
		recoveredDigest = hRes.Digest
	} else {
		// Read backup data via local broker
		backupData, err := w.broker.ReadFile(p.BackupPath, "", MaxFileBytes)
		if err != nil {
			return StatusFailed, nil, ErrCodeExecutionFailed, fmt.Sprintf("reading backup %s: %v", p.BackupPath, err), "", nil
		}

		// Restore backup data to target path
		applyRes, err := w.broker.ApplyFile(&FileApplyPayload{
			Path:                   p.TargetPath,
			Content:                backupData.Content,
			ExpectedPreImageDigest: p.ExpectedPostImageDigest,
		})
		if err != nil {
			return StatusFailed, nil, ErrCodeExecutionFailed, fmt.Sprintf("restoring backup failed: %v", err), "", nil
		}
		recoveredPath = applyRes.Path
		recoveredDigest = applyRes.PostImageDigest
	}

	// Restart or reload service if requested
	if p.RestoreService && w.helper != nil {
		if _, err := w.helper.ServiceAction(ctx, p.ProfileID, prof.ServiceUnit, "restart"); err != nil {
			return StatusFailed, nil, ErrCodeExecutionFailed, fmt.Sprintf("config restored but service restart failed: %v", err), "", nil
		}
	}

	resultData := map[string]any{
		"recovered": true,
		"path":      recoveredPath,
		"digest":    recoveredDigest,
	}
	return StatusSucceeded, nil, "", "", fmt.Sprintf("config recovered from %s", p.BackupPath), resultData
}
