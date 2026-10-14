//go:build linux

package pty

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

const (
	tiocSptlck = 0x40045431
	tiocGptn   = 0x80045430
	tiocSwinsz = 0x5414
)

type winsize struct {
	wsRow    uint16
	wsCol    uint16
	wsXpixel uint16
	wsYpixel uint16
}

type linuxPty struct {
	master *os.File
	closed bool
	mu     sync.Mutex
}

func (p *linuxPty) Read(b []byte) (int, error) {
	return p.master.Read(b)
}

func (p *linuxPty) Write(b []byte) (int, error) {
	return p.master.Write(b)
}

func (p *linuxPty) Resize(size Winsize) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrClosed
	}
	ws := winsize{wsRow: size.Rows, wsCol: size.Cols}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, p.master.Fd(), tiocSwinsz, uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		return fmt.Errorf("TIOCSWINSZ ioctl failed: %w", errno)
	}
	return nil
}

func (p *linuxPty) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	p.closed = true
	return p.master.Close()
}

// Start launches cmd in a real pseudo-terminal on Linux.
func Start(cmd *exec.Cmd, size Winsize) (*Session, error) {
	if size.Cols == 0 {
		size.Cols = 80
	}
	if size.Rows == 0 {
		size.Rows = 24
	}

	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}

	// Unlock pseudo-terminal (TIOCSPTLCK)
	var unlock int
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), tiocSptlck, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		master.Close()
		return nil, fmt.Errorf("TIOCSPTLCK: %w", errno)
	}

	// Get slave pts number (TIOCGPTN)
	var ptn uint32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), tiocGptn, uintptr(unsafe.Pointer(&ptn))); errno != 0 {
		master.Close()
		return nil, fmt.Errorf("TIOCGPTN: %w", errno)
	}

	slavePath := fmt.Sprintf("/dev/pts/%d", ptn)
	slave, err := os.OpenFile(slavePath, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		return nil, fmt.Errorf("open slave %s: %w", slavePath, err)
	}
	defer slave.Close()

	// Set initial window size
	ws := winsize{wsRow: size.Rows, wsCol: size.Cols}
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), tiocSwinsz, uintptr(unsafe.Pointer(&ws))); errno != 0 {
		master.Close()
		return nil, fmt.Errorf("initial TIOCSWINSZ: %w", errno)
	}

	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
		Ctty:    0,
	}

	if err := cmd.Start(); err != nil {
		master.Close()
		return nil, fmt.Errorf("cmd.Start: %w", err)
	}

	lp := &linuxPty{master: master}
	return &Session{
		Pty: lp,
		Cmd: cmd,
	}, nil
}

func (s *Session) KillProcessGroup() {
	if s.Cmd != nil && s.Cmd.Process != nil && s.Cmd.Process.Pid > 0 {
		pid := s.Cmd.Process.Pid
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = s.Cmd.Process.Kill()
	}
}
