//go:build !linux

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

func getFileOwnership(fi os.FileInfo) (int, int) {
	return -1, -1
}

func authenticatePeer(conn net.Conn, cfg ServerConfig) error {
	if cfg.AllowAnyPeer {
		return nil
	}
	return errors.New("peer authentication via SO_PEERCRED is only supported on Linux; use -allow-any-peer for local testing")
}

func runUnixSocketServer(cfg ServerConfig) error {
	_ = os.Remove(cfg.SocketPath)

	dir := filepath.Dir(cfg.SocketPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create socket directory: %w", err)
	}

	l, err := net.Listen("unix", cfg.SocketPath)
	if err != nil {
		return fmt.Errorf("failed to listen on unix socket %s: %w", cfg.SocketPath, err)
	}
	defer l.Close()
	defer os.Remove(cfg.SocketPath)

	var shuttingDown atomic.Bool
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		shuttingDown.Store(true)
		_ = l.Close()
	}()

	var wg sync.WaitGroup
	for {
		conn, err := l.Accept()
		if err != nil {
			if shuttingDown.Load() || errors.Is(err, net.ErrClosed) {
				break
			}
			return err
		}
		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			defer c.Close()
			handleConnection(c, cfg)
		}(conn)
	}
	wg.Wait()
	_ = os.Remove(cfg.SocketPath)
	return nil
}
