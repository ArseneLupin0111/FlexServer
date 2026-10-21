//go:build !linux

package ai

import (
	"context"
)

// NonLinuxShellExecutor returns ErrSandboxUnavailable, failing closed on non-Linux platforms.
type NonLinuxShellExecutor struct{}

func NewShellExecutor() ShellExecutor {
	return &NonLinuxShellExecutor{}
}

func (e *NonLinuxShellExecutor) Execute(ctx context.Context, opts ShellExecutionOptions) (*ShellExecutionResult, error) {
	return nil, ErrSandboxUnavailable
}
