package ai

import (
	"context"
	"errors"
)

var (
	ErrSandboxUnavailable = errors.New("confined shell execution unavailable on this host")
	ErrExecutionTimeout    = errors.New("command execution deadline exceeded")
	ErrExecutionCancelled  = errors.New("command execution cancelled")
)

// ShellExecutionOptions specifies confinement parameters for a shell command.
type ShellExecutionOptions struct {
	TaskID          string
	CommandID       string
	Script          string
	TimeoutSeconds  int
	ScratchRootDir  string
	RootfsDir       string
	ExecutorBinary  string
	ExecutionUID    int
	ExecutionGID    int
	HelperClient    *HelperClient
	OutputCallback  func(chunk string, isGap bool, isEnd bool)
}

// ShellExecutionResult holds the outcome of running a confined shell script.
type ShellExecutionResult struct {
	ExitCode      int
	StdoutSnippet string
	StderrSnippet string
	Terminated    bool
}

// ShellExecutor abstracts confined script execution.
type ShellExecutor interface {
	Execute(ctx context.Context, opts ShellExecutionOptions) (*ShellExecutionResult, error)
}

// BoundedWriter captures up to limit bytes in memory.
type BoundedWriter struct {
	buf   []byte
	limit int
}

func NewBoundedWriter(limit int) *BoundedWriter {
	return &BoundedWriter{
		buf:   make([]byte, 0, limit),
		limit: limit,
	}
}

func (w *BoundedWriter) Write(p []byte) (n int, err error) {
	n = len(p)
	remaining := w.limit - len(w.buf)
	if remaining <= 0 {
		return n, nil
	}
	if len(p) > remaining {
		w.buf = append(w.buf, p[:remaining]...)
	} else {
		w.buf = append(w.buf, p...)
	}
	return n, nil
}

func (w *BoundedWriter) String() string {
	return string(w.buf)
}

func (w *BoundedWriter) Bytes() []byte {
	return w.buf
}
