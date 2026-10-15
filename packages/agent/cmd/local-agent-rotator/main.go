package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultSocketPath  = "/var/run/flexserver/agent-rotation.sock"
	defaultConfigPath  = "/etc/vps-manager-agent/config.json"
	defaultServiceName = "vps-manager-agent.service"
	defaultSocketMode  = "0660"
	defaultSocketUid   = 100
	defaultSocketGid   = 101
	defaultMaxBytes    = 4096
)

func main() {
	serverFlag := flag.Bool("server", false, "Run in host daemon server mode (listen on unix socket)")
	socketFlag := flag.String("socket", "", "Unix domain socket path")
	socketModeFlag := flag.String("socket-mode", defaultSocketMode, "File mode for unix socket (octal)")
	socketUidFlag := flag.Int("socket-uid", defaultSocketUid, "Allowed client UID and socket owner UID (-1 to disable)")
	socketGidFlag := flag.Int("socket-gid", defaultSocketGid, "Allowed client GID and socket owner GID (-1 to disable)")
	configFlag := flag.String("config", defaultConfigPath, "Target agent config.json path")
	serviceNameFlag := flag.String("service-name", defaultServiceName, "Systemd service name to restart")
	systemctlCmdFlag := flag.String("systemctl-cmd", "systemctl", "Systemctl executable path (or 'none' to skip)")
	allowAnyPeerFlag := flag.Bool("allow-any-peer", false, "Skip peer UID authentication (testing only)")
	maxBytesFlag := flag.Int("max-bytes", defaultMaxBytes, "Maximum allowed request body size in bytes")
	timeoutFlag := flag.Duration("timeout", 25*time.Second, "Client operation timeout")

	flag.Parse()

	// If invoked via symlink name "local-agent-rotation-client", default to client mode
	baseName := filepath.Base(os.Args[0])
	if strings.Contains(baseName, "client") {
		*serverFlag = false
	}

	if *serverFlag {
		sockPath := *socketFlag
		if sockPath == "" {
			sockPath = defaultSocketPath
		}

		modeVal, err := strconv.ParseUint(*socketModeFlag, 8, 32)
		if err != nil {
			log.Fatalf("Invalid -socket-mode %q: %v", *socketModeFlag, err)
		}

		cfg := ServerConfig{
			SocketPath:   sockPath,
			SocketMode:   os.FileMode(modeVal),
			SocketUid:    *socketUidFlag,
			SocketGid:    *socketGidFlag,
			ConfigPath:   *configFlag,
			ServiceName:  *serviceNameFlag,
			SystemctlCmd: *systemctlCmdFlag,
			AllowAnyPeer: *allowAnyPeerFlag,
			MaxBodyBytes: *maxBytesFlag,
		}

		log.Printf("[rotator] Starting rotation helper daemon (socket: %s, uid: %d, gid: %d, target: %s)",
			cfg.SocketPath, cfg.SocketUid, cfg.SocketGid, cfg.ConfigPath)

		if err := runUnixSocketServer(cfg); err != nil {
			log.Fatalf("[rotator] Server error: %v", err)
		}
		return
	}

	// Client mode: reads stdin and invokes unix socket
	sockPath := *socketFlag
	if sockPath == "" {
		sockPath = os.Getenv("LOCAL_AGENT_ROTATION_SOCKET")
		if sockPath == "" {
			sockPath = defaultSocketPath
		}
	}

	if err := runClient(sockPath, *timeoutFlag); err != nil {
		fmt.Fprintf(os.Stderr, "Local agent rotation client failed: %v\n", err)
		os.Exit(1)
	}
}

func runClient(socketPath string, timeout time.Duration) error {
	// Read stdin bounded to 4096 bytes
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
	if err != nil {
		return fmt.Errorf("failed to read stdin: %w", err)
	}
	if len(input) > 4096 {
		return errors.New("stdin payload exceeds maximum limit of 4096 bytes")
	}
	input = bytes.TrimSpace(input)
	if len(input) == 0 {
		return errors.New("empty stdin payload; expected JSON with {vpsId, token}")
	}

	conn, err := net.DialTimeout("unix", socketPath, timeout)
	if err != nil {
		return fmt.Errorf("failed to connect to host rotation socket %s: %w", socketPath, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	input = append(input, '\n')
	if _, err := conn.Write(input); err != nil {
		return fmt.Errorf("failed to write payload to rotation socket: %w", err)
	}

	reader := bufio.NewReader(io.LimitReader(conn, 4096))
	respLine, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("failed to read response from rotation socket: %w", err)
	}

	var resp RotationResponse
	if err := json.Unmarshal(bytes.TrimSpace(respLine), &resp); err != nil {
		return fmt.Errorf("invalid response from rotation helper: %w", err)
	}

	if !resp.Ok {
		errMsg := resp.Error
		if errMsg == "" {
			errMsg = "rotation helper rejected request"
		}
		return errors.New(errMsg)
	}

	return nil
}
