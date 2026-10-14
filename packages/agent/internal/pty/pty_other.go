//go:build !windows && !linux

package pty

import (
	"os/exec"
)

func Start(cmd *exec.Cmd, size Winsize) (*Session, error) {
	return nil, ErrUnsupported
}

func (s *Session) KillProcessGroup() {
	if s.Cmd != nil && s.Cmd.Process != nil {
		_ = s.Cmd.Process.Kill()
	}
}
