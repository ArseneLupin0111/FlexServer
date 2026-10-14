package pty

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPtyExecutionAndResize(t *testing.T) {
	var cmd *exec.Cmd
	expectedMarker := "PTY_ALIVE"
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/c", "echo PTY_ALIVE")
	} else if runtime.GOOS == "linux" {
		cmd = exec.Command("/bin/sh", "-c", "echo PTY_ALIVE && [ -t 1 ] && echo IS_A_TTY")
		expectedMarker = "IS_A_TTY"
	} else {
		t.Skip("Unsupported OS for PTY test")
	}

	session, err := Start(cmd, Winsize{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Read initial output from PTY
	buf := make([]byte, 2048)
	done := make(chan struct{})
	var output string

	go func() {
		defer close(done)
		for {
			n, err := session.Pty.Read(buf)
			if n > 0 {
				output += string(buf[:n])
				if strings.Contains(output, expectedMarker) {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("Timeout waiting for PTY output, received so far: %q", output)
	}

	if !strings.Contains(output, "PTY_ALIVE") {
		t.Fatalf("Expected output to contain 'PTY_ALIVE', got %q", output)
	}

	if runtime.GOOS == "linux" && !strings.Contains(output, "IS_A_TTY") {
		t.Fatalf("Expected Linux PTY to be a real TTY ([ -t 1 ]), got %q", output)
	}

	// Test dynamic resize
	if err := session.Pty.Resize(Winsize{Rows: 35, Cols: 120}); err != nil {
		t.Fatalf("Resize failed: %v", err)
	}

	// Test cleanup
	if err := session.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}

	// Idempotent close
	if err := session.Close(); err != nil {
		t.Fatalf("Subsequent Close failed: %v", err)
	}
}
