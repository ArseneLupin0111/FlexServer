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

func getPeerCred(conn net.Conn) (*syscall.Ucred, error) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return nil, fmt.Errorf("not a unix socket connection")
	}
	rawConn, err := unixConn.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("failed to get syscall connection: %w", err)
	}
	var ucred *syscall.Ucred
	var credErr error
	err = rawConn.Control(func(fd uintptr) {
		ucred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return nil, fmt.Errorf("raw conn control error: %w", err)
	}
	if credErr != nil {
		return nil, fmt.Errorf("getsockopt SO_PEERCRED error: %w", credErr)
	}
	return ucred, nil
}

func getFileOwnership(fi os.FileInfo) (int, int) {
	if stat, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int(stat.Uid), int(stat.Gid)
	}
	return -1, -1
}

func authenticatePeer(conn net.Conn, cfg ServerConfig) error {
	if cfg.AllowAnyPeer {
		return nil
	}
	ucred, err := getPeerCred(conn)
	if err != nil {
		return fmt.Errorf("failed to read socket peer credentials: %w", err)
	}
	// Root caller is always authorized
	if ucred.Uid == 0 {
		return nil
	}
	// Authorized client UID (e.g. unprivileged API container user uid 100)
	if cfg.SocketUid >= 0 && int(ucred.Uid) == cfg.SocketUid {
		return nil
	}
	// Authorized client GID (e.g. unprivileged API container group gid 101)
	if cfg.SocketGid >= 0 && int(ucred.Gid) == cfg.SocketGid {
		return nil
	}
	return fmt.Errorf("unauthorized peer (uid=%d, gid=%d)", ucred.Uid, ucred.Gid)
}

func runUnixSocketServer(cfg ServerConfig) error {
	_ = os.Remove(cfg.SocketPath)

	dir := filepath.Dir(cfg.SocketPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create socket directory: %w", err)
	}

	oldUmask := syscall.Umask(0077)
	l, err := net.Listen("unix", cfg.SocketPath)
	syscall.Umask(oldUmask)
	if err != nil {
		return fmt.Errorf("failed to listen on unix socket %s: %w", cfg.SocketPath, err)
	}
	defer l.Close()
	defer os.Remove(cfg.SocketPath)

	if err := os.Chmod(cfg.SocketPath, cfg.SocketMode); err != nil {
		return fmt.Errorf("failed to chmod unix socket %s: %w", cfg.SocketPath, err)
	}
	if cfg.SocketUid >= 0 || cfg.SocketGid >= 0 {
		if err := os.Chown(cfg.SocketPath, cfg.SocketUid, cfg.SocketGid); err != nil {
			return fmt.Errorf("failed to chown unix socket %s: %w", cfg.SocketPath, err)
		}
	}

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
