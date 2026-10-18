package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"

	"github.com/vps-manager/agent/internal/pty"
)

func defaultShell() string {
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath("powershell.exe"); err == nil {
			return p
		}
		if p, err := exec.LookPath("cmd.exe"); err == nil {
			return p
		}
		return "cmd.exe"
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	if p, err := exec.LookPath("bash"); err == nil {
		return p
	}
	return "/bin/sh"
}

var (
	activeSessionsMu sync.Mutex
	activeSessions   = make(map[*pty.Session]struct{})
	isShuttingDown   bool
)

func registerSession(s *pty.Session) bool {
	activeSessionsMu.Lock()
	defer activeSessionsMu.Unlock()
	if isShuttingDown {
		return false
	}
	activeSessions[s] = struct{}{}
	return true
}

func unregisterSession(s *pty.Session) {
	activeSessionsMu.Lock()
	delete(activeSessions, s)
	activeSessionsMu.Unlock()
}

func closeAllSessions() {
	activeSessionsMu.Lock()
	defer activeSessionsMu.Unlock()
	if isShuttingDown {
		return
	}
	isShuttingDown = true
	for s := range activeSessions {
		_ = s.Close()
	}
}

func main() {
	colsFlag := flag.Int("cols", 80, "Initial terminal columns")
	rowsFlag := flag.Int("rows", 24, "Initial terminal rows")
	shellFlag := flag.String("shell", "", "Shell executable to run")
	socketFlag := flag.String("socket", "", "Optional Unix domain socket path to listen on (Linux only)")
	socketModeFlag := flag.String("socket-mode", "0660", "File mode for unix domain socket in octal (default: 0660)")
	socketUidFlag := flag.Int("socket-uid", -1, "Socket owner UID (-1 keeps daemon UID)")
	socketGidFlag := flag.Int("socket-gid", -1, "Socket owner GID (-1 keeps daemon GID)")
	flag.Parse()

	cols := uint16(*colsFlag)
	rows := uint16(*rowsFlag)
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}

	shell := *shellFlag
	if shell == "" {
		shell = defaultShell()
	}

	if *socketFlag != "" {
		if runtime.GOOS == "windows" {
			fmt.Fprintf(os.Stderr, "Unix domain socket listener not supported on Windows\n")
			os.Exit(1)
		}
		modeVal, err := strconv.ParseUint(*socketModeFlag, 8, 32)
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid socket-mode %q: %v\n", *socketModeFlag, err)
			os.Exit(1)
		}
		if err := runUnixSocketServer(*socketFlag, shell, rows, cols, os.FileMode(modeVal), *socketUidFlag, *socketGidFlag); err != nil {
			fmt.Fprintf(os.Stderr, "host-pty socket error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if err := runSession(os.Stdin, os.Stdout, shell, rows, cols); err != nil {
		fmt.Fprintf(os.Stderr, "host-pty session error: %v\n", err)
		os.Exit(1)
	}
}


func runSession(in io.Reader, out io.Writer, shell string, rows, cols uint16) error {
	cmd := exec.Command(shell)
	// Minimal POSIX shells do not normally load a descriptive prompt. Preserve
	// an explicitly configured PS1; shell startup files can override this default.
	if runtime.GOOS != "windows" && os.Getenv("PS1") == "" {
		name := filepath.Base(shell)
		if name == "sh" || name == "dash" {
			account, err := user.Current()
			if err != nil {
				return fmt.Errorf("resolve terminal user: %w", err)
			}
			host, err := os.Hostname()
			if err != nil {
				return fmt.Errorf("resolve terminal hostname: %w", err)
			}
			marker := "$ "
			if os.Geteuid() == 0 {
				marker = "# "
			}
			cmd.Env = append(os.Environ(), "PS1="+account.Username+"@"+host+":${PWD}"+marker)
		}
	}
	session, err := pty.Start(cmd, pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		_ = pty.WriteFrame(out, pty.Frame{
			Type:    pty.MsgTypeError,
			Payload: []byte(err.Error()),
		})
		return err
	}
	if !registerSession(session) {
		_ = session.Close()
		_ = pty.WriteFrame(out, pty.Frame{
			Type:    pty.MsgTypeError,
			Payload: []byte("daemon shutting down"),
		})
		return errors.New("daemon shutting down")
	}
	defer func() {
		_ = session.Close()
		unregisterSession(session)
	}()

	outputDone := make(chan struct{})

	// PTY stdout -> framed output to writer
	go func() {
		defer close(outputDone)
		buf := make([]byte, 4096)
		for {
			n, err := session.Read(buf)
			if n > 0 {
				writeErr := pty.WriteFrame(out, pty.Frame{
					Type:    pty.MsgTypeData,
					Payload: buf[:n],
				})
				if writeErr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
	}()

	// Read framed messages from input
	go func() {
		for {
			frame, err := pty.ReadFrame(in)
			if err != nil {
				_ = session.Close()
				return
			}
			switch frame.Type {
			case pty.MsgTypeData:
				if _, err := session.Write(frame.Payload); err != nil {
					_ = session.Close()
					return
				}
			case pty.MsgTypeResize:
				if len(frame.Payload) >= 4 {
					newRows := uint16(frame.Payload[0])<<8 | uint16(frame.Payload[1])
					newCols := uint16(frame.Payload[2])<<8 | uint16(frame.Payload[3])
					_ = session.Resize(pty.Winsize{Rows: newRows, Cols: newCols})
				}
			case pty.MsgTypeClose:
				_ = session.Close()
				return
			}
		}
	}()

	// Wait for child process to exit
	exitCode := 0
	if err := session.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	} else if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}

	// Close session to ensure EOF on PTY reader
	_ = session.Close()

	// Wait for output reader to drain all remaining output frames
	<-outputDone

	// Write exit frame
	exitPayload := []byte{
		byte(exitCode >> 24),
		byte(exitCode >> 16),
		byte(exitCode >> 8),
		byte(exitCode),
	}
	_ = pty.WriteFrame(out, pty.Frame{
		Type:    pty.MsgTypeExit,
		Payload: exitPayload,
	})

	return nil
}
