package pty

import (
	"errors"
	"io"
	"os/exec"
)

var (
	ErrClosed      = errors.New("pty: closed")
	ErrUnsupported = errors.New("pty: unsupported on this platform")
	ErrInvalidSize = errors.New("pty: invalid window size")
)

// Winsize specifies terminal window dimensions.
type Winsize struct {
	Rows uint16
	Cols uint16
}

// Pty represents an active pseudo-terminal device.
type Pty interface {
	io.ReadWriteCloser
	Resize(size Winsize) error
}

// Session represents a running process attached to a pseudo-terminal.
type Session struct {
	Pty WinsizePty
	Cmd *exec.Cmd
}

// WinsizePty combines io.ReadWriteCloser and Resize.
type WinsizePty interface {
	io.Reader
	io.Writer
	io.Closer
	Resize(size Winsize) error
}

// Close terminates the session and closes the PTY.
func (s *Session) Close() error {
	var errs []error
	if s.Pty != nil {
		if err := s.Pty.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	s.KillProcessGroup()
	if len(errs) > 0 {
		return errs[0]
	}
	return nil
}

// Wait waits for the command to exit.
func (s *Session) Wait() error {
	if s.Cmd == nil {
		return nil
	}
	return s.Cmd.Wait()
}

// Read reads from the session's PTY.
func (s *Session) Read(p []byte) (int, error) {
	if s.Pty == nil {
		return 0, ErrClosed
	}
	return s.Pty.Read(p)
}

// Write writes to the session's PTY.
func (s *Session) Write(p []byte) (int, error) {
	if s.Pty == nil {
		return 0, ErrClosed
	}
	return s.Pty.Write(p)
}

// Resize resizes the session's PTY.
func (s *Session) Resize(size Winsize) error {
	if s.Pty == nil {
		return ErrClosed
	}
	return s.Pty.Resize(size)
}
