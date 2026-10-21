//go:build linux

package ai

import (
	"context"
	"errors"
	"fmt"
)

// LinuxShellExecutor executes commands inside isolated Linux namespaces with cgroup2 confinement
// by routing the privileged bootstrap to the root ai-host-helper.
type LinuxShellExecutor struct{}

func NewShellExecutor() ShellExecutor {
	return &LinuxShellExecutor{}
}

func (e *LinuxShellExecutor) Execute(ctx context.Context, opts ShellExecutionOptions) (*ShellExecutionResult, error) {
	if opts.ExecutionUID <= 0 || opts.ExecutionGID <= 0 {
		return nil, fmt.Errorf("%w: invalid execution UID (%d) or GID (%d)", ErrSandboxUnavailable, opts.ExecutionUID, opts.ExecutionGID)
	}

	if opts.HelperClient == nil {
		return nil, fmt.Errorf("%w: helper client required for mandatory root bootstrap namespace and cgroup confinement", ErrSandboxUnavailable)
	}

	timeout := opts.TimeoutSeconds
	if timeout <= 0 || timeout > MaxTimeoutSeconds {
		timeout = DefaultTimeoutSeconds
	}

	outputCb := func(chunk string, isStderr bool) {
		if opts.OutputCallback != nil {
			opts.OutputCallback(chunk, false, false)
		}
	}

	params := TaskExecuteParams{
		TaskID:         opts.TaskID,
		CommandID:      opts.CommandID,
		Script:         opts.Script,
		TimeoutSeconds: timeout,
		ScratchRootDir: opts.ScratchRootDir,
		RootfsDir:      opts.RootfsDir,
		ExecutionUID:   opts.ExecutionUID,
		ExecutionGID:   opts.ExecutionGID,
	}

	res, err := opts.HelperClient.ExecuteTask(ctx, params, outputCb)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			return res, ErrExecutionTimeout
		}
		if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
			return res, ErrExecutionCancelled
		}
		return res, fmt.Errorf("%w: %v", ErrSandboxUnavailable, err)
	}

	return res, nil
}
