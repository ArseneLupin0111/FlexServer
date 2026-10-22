//go:build linux

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
)

func runUnixSocketServer(socketPath, shell string, defaultRows, defaultCols uint16, socketMode os.FileMode, socketUid, socketGid int) error {
	_ = os.Remove(socketPath)

	dir := filepath.Dir(socketPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create socket directory: %w", err)
	}

	// Restrict umask before creating socket to avoid loose umask access window
	oldUmask := syscall.Umask(0077)
	l, err := net.Listen("unix", socketPath)
	syscall.Umask(oldUmask)
	if err != nil {
		return fmt.Errorf("failed to listen on unix socket %s: %w", socketPath, err)
	}
	defer l.Close()
	defer os.Remove(socketPath)

	if err := os.Chmod(socketPath, socketMode); err != nil {
		return fmt.Errorf("failed to chmod unix socket %s: %w", socketPath, err)
	}
	if socketUid >= 0 || socketGid >= 0 {
		if err := os.Chown(socketPath, socketUid, socketGid); err != nil {
			return fmt.Errorf("failed to chown unix socket %s: %w", socketPath, err)
		}
	}

	var shuttingDown atomic.Bool
	var activeSessions atomic.Int32
	activeMarkerPath := filepath.Join(dir, "active_sessions")
	updateMarker := func(delta int32) {
		n := activeSessions.Add(delta)
		if n < 0 {
			n = 0
			activeSessions.Store(0)
		}
		_ = os.WriteFile(activeMarkerPath, []byte(fmt.Sprintf("%d\n", n)), 0o644)
	}
	updateMarker(0)
	defer os.Remove(activeMarkerPath)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		shuttingDown.Store(true)
		_ = l.Close()
		closeAllSessions()
	}()

	var sessionWg sync.WaitGroup
	for {
		conn, err := l.Accept()
		if err != nil {
			if shuttingDown.Load() || errors.Is(err, net.ErrClosed) {
				break
			}
			return err
		}
		sessionWg.Add(1)
		updateMarker(1)
		go func(c net.Conn) {
			defer sessionWg.Done()
			defer updateMarker(-1)
			defer c.Close()
			_ = runSession(c, c, shell, defaultRows, defaultCols)
		}(conn)
	}
	closeAllSessions()
	sessionWg.Wait()
	_ = os.Remove(activeMarkerPath)
	_ = os.Remove(socketPath)
	return nil
}
