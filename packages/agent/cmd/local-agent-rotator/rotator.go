package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	vpsIdRegex = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
	tokenRegex = regexp.MustCompile(`^vma_[A-Za-z0-9_-]+$`)

	mutationMutex sync.Mutex
	tempCounter   atomic.Uint64
)

type ServerConfig struct {
	SocketPath   string
	SocketMode   os.FileMode
	SocketUid    int
	SocketGid    int
	ConfigPath   string
	ServiceName  string
	SystemctlCmd string
	AllowAnyPeer bool
	MaxBodyBytes int
}

type RotationRequest struct {
	VpsId string `json:"vpsId"`
	Token string `json:"token"`
}

type RotationResponse struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// ValidateRequest performs bounded checks on input schema and token format.
// Tokens must never be included in error messages or logs.
func ValidateRequest(req *RotationRequest) error {
	if req == nil {
		return errors.New("empty request payload")
	}
	req.VpsId = strings.TrimSpace(req.VpsId)
	req.Token = strings.TrimSpace(req.Token)

	if req.VpsId == "" {
		return errors.New("vpsId is required")
	}
	if len(req.VpsId) > 128 || !vpsIdRegex.MatchString(req.VpsId) {
		return errors.New("invalid vpsId format")
	}

	if req.Token == "" {
		return errors.New("token is required")
	}
	if len(req.Token) < 10 || len(req.Token) > 512 || !tokenRegex.MatchString(req.Token) {
		return errors.New("invalid token format")
	}
	return nil
}

// UpdateAgentConfig updates only the token in configPath atomically, preserving original
// permissions, owner, and all other fields. Restarts the service with rollback on failure.
// Concurrent mutation calls are rejected immediately via TryLock to avoid queue drift.
func UpdateAgentConfig(configPath string, req RotationRequest, systemctlCmd, serviceName string) error {
	if !mutationMutex.TryLock() {
		return errors.New("rotation busy: another rotation is currently in progress")
	}
	defer mutationMutex.Unlock()

	origBytes, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("failed to read agent config: %w", err)
	}

	fi, err := os.Stat(configPath)
	if err != nil {
		return fmt.Errorf("failed to stat agent config: %w", err)
	}
	origMode := fi.Mode().Perm()
	origUid, origGid := getFileOwnership(fi)

	var configMap map[string]interface{}
	if err := json.Unmarshal(origBytes, &configMap); err != nil {
		return fmt.Errorf("failed to parse existing agent config: %w", err)
	}

	configuredVpsId, _ := configMap["vpsId"].(string)
	if configuredVpsId == "" {
		return errors.New("local agent config does not specify a vpsId")
	}
	if configuredVpsId != req.VpsId {
		return errors.New("vpsId mismatch: local agent is not configured for requested host ID")
	}

	// Update only the token field, preserving all other fields exactly
	configMap["token"] = req.Token

	newBytes, err := json.MarshalIndent(configMap, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to format updated config: %w", err)
	}
	newBytes = append(newBytes, '\n')

	dir := filepath.Dir(configPath)
	tmpPath := filepath.Join(dir, fmt.Sprintf(".%s.tmp.%d.%d", filepath.Base(configPath), os.Getpid(), tempCounter.Add(1)))
	defer os.Remove(tmpPath)

	// Write updated file atomically
	if err := writeAtomic(tmpPath, configPath, newBytes, origMode, origUid, origGid); err != nil {
		return fmt.Errorf("failed to write config atomically: %w", err)
	}

	// Restart service if requested (bounded to 8s; rollback also bounded to 8s)
	if systemctlCmd != "" && systemctlCmd != "none" && serviceName != "" {
		if err := restartService(systemctlCmd, serviceName); err != nil {
			// Rollback to original config on restart failure
			rollbackTmp := filepath.Join(dir, fmt.Sprintf(".%s.rollback.%d.%d", filepath.Base(configPath), os.Getpid(), tempCounter.Add(1)))
			defer os.Remove(rollbackTmp)
			rollbackErr := writeAtomic(rollbackTmp, configPath, origBytes, origMode, origUid, origGid)
			if rollbackErr != nil {
				return fmt.Errorf("service restart failed (%v) and config rollback also failed (%v)", err, rollbackErr)
			}
			// Re-attempt service restart with original config to recover service availability
			_ = restartService(systemctlCmd, serviceName)
			return fmt.Errorf("service restart failed (%v); original config restored", err)
		}
	}

	return nil
}

func writeAtomic(tmpPath, destPath string, content []byte, mode os.FileMode, uid, gid int) error {
	_ = os.Remove(tmpPath)

	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("failed to open temp file: %w", err)
	}

	if _, err := f.Write(content); err != nil {
		f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to write temp file: %w", err)
	}

	if err := f.Sync(); err != nil {
		f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to fsync temp file: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to close temp file: %w", err)
	}

	_ = os.Chmod(tmpPath, mode)
	if uid >= 0 && gid >= 0 {
		_ = os.Chown(tmpPath, uid, gid)
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to replace destination file atomically: %w", err)
	}

	return nil
}

func restartService(systemctlCmd, serviceName string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, systemctlCmd, "restart", serviceName)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}

func handleConnection(conn net.Conn, cfg ServerConfig) {
	_ = conn.SetDeadline(time.Now().Add(25 * time.Second))

	if err := authenticatePeer(conn, cfg); err != nil {
		log.Printf("[rotator] Rejecting connection: %v", err)
		sendResponse(conn, RotationResponse{Ok: false, Error: "unauthorized socket peer"})
		return
	}

	maxBytes := cfg.MaxBodyBytes
	if maxBytes <= 0 {
		maxBytes = 4096
	}

	lr := io.LimitReader(conn, int64(maxBytes+1))
	reader := bufio.NewReader(lr)

	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		sendResponse(conn, RotationResponse{Ok: false, Error: "failed to read request payload"})
		return
	}

	if len(line) > maxBytes {
		sendResponse(conn, RotationResponse{Ok: false, Error: "request payload exceeds maximum limit"})
		return
	}

	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		sendResponse(conn, RotationResponse{Ok: false, Error: "empty request payload"})
		return
	}

	var req RotationRequest
	if err := json.Unmarshal(line, &req); err != nil {
		sendResponse(conn, RotationResponse{Ok: false, Error: "malformed request JSON"})
		return
	}

	if err := ValidateRequest(&req); err != nil {
		sendResponse(conn, RotationResponse{Ok: false, Error: err.Error()})
		return
	}

	log.Printf("[rotator] Processing rotation request for vpsId=%s", req.VpsId)

	if err := UpdateAgentConfig(cfg.ConfigPath, req, cfg.SystemctlCmd, cfg.ServiceName); err != nil {
		log.Printf("[rotator] Rotation failed for vpsId=%s: %v", req.VpsId, err)
		sendResponse(conn, RotationResponse{Ok: false, Error: err.Error()})
		return
	}

	log.Printf("[rotator] Successfully rotated credential for vpsId=%s", req.VpsId)
	sendResponse(conn, RotationResponse{Ok: true})
}

func sendResponse(w io.Writer, resp RotationResponse) {
	b, _ := json.Marshal(resp)
	b = append(b, '\n')
	_, _ = w.Write(b)
}
