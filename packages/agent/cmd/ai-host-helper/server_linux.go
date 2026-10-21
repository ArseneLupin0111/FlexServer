//go:build linux

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/vps-manager/agent/internal/ai"
	"golang.org/x/sys/unix"
)

func run(cfg ServerConfig) error {
	if cfg.SocketPath == "" {
		return errors.New("socket path cannot be empty")
	}
	if err := os.MkdirAll(filepath.Dir(cfg.SocketPath), 0750); err != nil {
		return fmt.Errorf("creating socket directory: %w", err)
	}

	if info, err := os.Lstat(cfg.SocketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("socket path exists and is not a socket")
		}
		probe, e := net.DialTimeout("unix", cfg.SocketPath, time.Second)
		if e == nil {
			probe.Close()
			return errors.New("socket already active")
		}
		if err = os.Remove(cfg.SocketPath); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	if cfg.BackupsDir != "" {
		if err := os.MkdirAll(cfg.BackupsDir, 0700); err != nil {
			return fmt.Errorf("creating backups directory: %w", err)
		}
	}

	previous := syscall.Umask(0077)
	listener, err := net.Listen("unix", cfg.SocketPath)
	syscall.Umask(previous)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", cfg.SocketPath, err)
	}
	defer listener.Close()

	if err := os.Chmod(cfg.SocketPath, cfg.SocketMode); err != nil {
		return fmt.Errorf("setting socket mode: %w", err)
	}
	if cfg.SocketUID >= 0 || cfg.SocketGID >= 0 {
		uid := cfg.SocketUID
		if uid < 0 {
			uid = os.Geteuid()
		}
		gid := cfg.SocketGID
		if gid < 0 {
			gid = os.Getegid()
		}
		if err := os.Chown(cfg.SocketPath, uid, gid); err != nil {
			return fmt.Errorf("setting socket ownership: %w", err)
		}
	}

	profiles, err := ai.LoadProfileRegistry(cfg.ProfilesDir)
	if err != nil {
		return fmt.Errorf("loading profiles: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go handleConn(ctx, conn, profiles, cfg)
	}
}

func handleConn(ctx context.Context, conn net.Conn, profiles *ai.ProfileRegistry, cfg ServerConfig) {
	defer conn.Close()

	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		sendResp(conn, false, "invalid connection type", nil)
		return
	}
	rawFile, err := unixConn.File()
	if err != nil {
		sendResp(conn, false, "peer credentials unavailable: unable to inspect socket file descriptor", nil)
		return
	}
	rawFD := int(rawFile.Fd())
	defer rawFile.Close()
	if rawFD < 0 {
		sendResp(conn, false, "peer credentials unavailable: invalid connection handle", nil)
		return
	}
	ucred, err := unix.GetsockoptUcred(rawFD, unix.SOL_SOCKET, unix.SO_PEERCRED)
	if err != nil {
		sendResp(conn, false, "peer credentials unavailable: SO_PEERCRED failed", nil)
		return
	}

	authorized := false
	if int(ucred.Uid) == 0 || int(ucred.Uid) == os.Geteuid() {
		authorized = true
	}
	if cfg.SocketUID >= 0 && int(ucred.Uid) == cfg.SocketUID {
		authorized = true
	}
	if cfg.SocketGID >= 0 && int(ucred.Gid) == cfg.SocketGID {
		authorized = true
	}
	if cfg.ExecutionUID > 0 && int(ucred.Uid) == cfg.ExecutionUID {
		authorized = true
	}
	if cfg.ExecutionGID > 0 && int(ucred.Gid) == cfg.ExecutionGID {
		authorized = true
	}
	if !authorized {
		sendResp(conn, false, fmt.Sprintf("unauthorized peer credentials uid=%d gid=%d", ucred.Uid, ucred.Gid), nil)
		return
	}

	scanner := bufio.NewScanner(conn)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	if !scanner.Scan() {
		return
	}

	var req ai.HelperRequest
	if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
		sendResp(conn, false, "invalid json request", nil)
		return
	}

	switch req.Op {
	case "service_status":
		handleServiceStatus(conn, req.Params, profiles)
	case "service_action":
		handleServiceAction(conn, req.Params, profiles)
	case "config_validate":
		handleConfigValidate(conn, req.Params, profiles)
	case "config_apply":
		handleConfigApply(conn, req.Params, profiles, cfg)
	case "config_recover":
		handleConfigRecover(conn, req.Params, profiles, cfg)
	case "cgroup_create":
		handleCgroupCreate(conn, req.Params, cfg)
	case "cgroup_kill":
		handleCgroupKill(conn, req.Params, cfg)
	case "task_execute":
		handleTaskExecute(ctx, conn, req.Params, cfg)
	default:
		sendResp(conn, false, fmt.Sprintf("unknown operation %q", req.Op), nil)
	}
}

func sendResp(conn net.Conn, ok bool, errStr string, data any) {
	resp := ai.HelperResponse{
		Ok:    ok,
		Error: errStr,
	}
	if data != nil {
		raw, _ := json.Marshal(data)
		resp.Data = raw
	}
	bytes, _ := json.Marshal(resp)
	_, _ = conn.Write(append(bytes, '\n'))
}

func sendStreamMsg(conn net.Conn, msg ai.TaskExecuteStreamMessage) {
	bytes, _ := json.Marshal(msg)
	_, _ = conn.Write(append(bytes, '\n'))
}

func handleServiceStatus(conn net.Conn, params json.RawMessage, profiles *ai.ProfileRegistry) {
	var p ai.ServiceStatusParams
	if err := json.Unmarshal(params, &p); err != nil {
		sendResp(conn, false, "bad params", nil)
		return
	}

	prof, err := profiles.Get(p.ProfileID)
	if err != nil {
		sendResp(conn, false, err.Error(), nil)
		return
	}

	if prof.ServiceUnit == "" {
		sendResp(conn, false, fmt.Sprintf("profile %q has no service unit configured", prof.ID), nil)
		return
	}
	if p.Service != "" && p.Service != prof.ServiceUnit {
		sendResp(conn, false, fmt.Sprintf("requested service %q does not match profile service unit %q", p.Service, prof.ServiceUnit), nil)
		return
	}
	service := prof.ServiceUnit

	if ai.IsProtectedPath(service) {
		sendResp(conn, false, fmt.Sprintf("service unit %q is a protected control-plane component", service), nil)
		return
	}

	out, _ := exec.Command("systemctl", "is-active", service).Output()
	activeStr := strings.TrimSpace(string(out))
	active := activeStr == "active"

	showOut, _ := exec.Command("systemctl", "show", "--property=MainPID,SubState", service).Output()
	substate := "unknown"
	pid := 0
	lines := strings.Split(string(showOut), "\n")
	for _, l := range lines {
		parts := strings.SplitN(strings.TrimSpace(l), "=", 2)
		if len(parts) == 2 {
			if parts[0] == "SubState" {
				substate = parts[1]
			} else if parts[0] == "MainPID" {
				pid, _ = strconv.Atoi(parts[1])
			}
		}
	}

	sendResp(conn, true, "", ai.ServiceStatusResult{
		Service:  service,
		Active:   active,
		Substate: substate,
		PID:      pid,
	})
}

func handleServiceAction(conn net.Conn, params json.RawMessage, profiles *ai.ProfileRegistry) {
	var p ai.ServiceActionParams
	if err := json.Unmarshal(params, &p); err != nil {
		sendResp(conn, false, "bad params", nil)
		return
	}
	// Plan §1.2: explicitly forbidden actions on system services
	actLower := strings.ToLower(strings.TrimSpace(p.Action))
	if actLower == "stop" || actLower == "disable" || actLower == "mask" {
		sendResp(conn, false, fmt.Sprintf("action %q is forbidden by safety policy (system services cannot be stopped, disabled, or masked)", p.Action), nil)
		return
	}

	prof, err := profiles.Get(p.ProfileID)
	if err != nil {
		sendResp(conn, false, err.Error(), nil)
		return
	}
	if err := prof.ValidateAction(p.Action); err != nil {
		sendResp(conn, false, err.Error(), nil)
		return
	}

	if prof.ServiceUnit == "" {
		sendResp(conn, false, fmt.Sprintf("profile %q has no service unit configured", prof.ID), nil)
		return
	}
	if p.Service != "" && p.Service != prof.ServiceUnit {
		sendResp(conn, false, fmt.Sprintf("requested service %q does not match profile service unit %q", p.Service, prof.ServiceUnit), nil)
		return
	}
	service := prof.ServiceUnit

	if ai.IsProtectedPath(service) {
		sendResp(conn, false, fmt.Sprintf("service unit %q is a protected control-plane component", service), nil)
		return
	}

	out, err := exec.Command("systemctl", p.Action, service).CombinedOutput()
	if err != nil {
		sendResp(conn, false, fmt.Sprintf("systemctl %s failed: %v (output: %s)", p.Action, err, string(out)), nil)
		return
	}

	sendResp(conn, true, "", ai.ServiceActionResult{
		Service: service,
		Action:  p.Action,
		Success: true,
	})
}

func handleConfigValidate(conn net.Conn, params json.RawMessage, profiles *ai.ProfileRegistry) {
	var p ai.ConfigValidateParams
	if err := json.Unmarshal(params, &p); err != nil {
		sendResp(conn, false, "bad params", nil)
		return
	}

	prof, err := profiles.Get(p.ProfileID)
	if err != nil {
		sendResp(conn, false, err.Error(), nil)
		return
	}

	if err := prof.ValidateConfigPath(p.TargetPath); err != nil {
		sendResp(conn, false, err.Error(), nil)
		return
	}
	if ai.IsProtectedPath(p.TargetPath) {
		sendResp(conn, false, fmt.Sprintf("target path %q is protected", p.TargetPath), nil)
		return
	}

	if err := prof.ValidateConfigContent(p.CandidateContent); err != nil {
		sendResp(conn, false, err.Error(), nil)
		return
	}

	if prof.ValidatorExec == "" {
		sendResp(conn, true, "", ai.ConfigValidateResult{
			Valid:           true,
			ValidatorOutput: "no validator configured for profile",
		})
		return
	}

	if err := validateProfileValidator(prof.ValidatorExec); err != nil {
		sendResp(conn, false, fmt.Sprintf("invalid validator executable: %v", err), nil)
		return
	}

	tempFile, err := os.CreateTemp("", "config-validate-*")
	if err != nil {
		sendResp(conn, false, fmt.Sprintf("creating temp candidate: %v", err), nil)
		return
	}
	defer os.Remove(tempFile.Name())

	if _, err := tempFile.WriteString(p.CandidateContent); err != nil {
		tempFile.Close()
		sendResp(conn, false, fmt.Sprintf("writing temp candidate: %v", err), nil)
		return
	}
	tempFile.Close()

	var args []string
	args = append(args, prof.ValidatorArgv...)
	args = append(args, tempFile.Name())

	cmd := exec.Command(prof.ValidatorExec, args...)
	out, err := cmd.CombinedOutput()
	valid := (err == nil)

	sendResp(conn, true, "", ai.ConfigValidateResult{
		Valid:           valid,
		ValidatorOutput: string(out),
	})
}

func handleConfigApply(conn net.Conn, params json.RawMessage, profiles *ai.ProfileRegistry, cfg ServerConfig) {
	var p ai.ConfigApplyParams
	if err := json.Unmarshal(params, &p); err != nil {
		sendResp(conn, false, "bad params", nil)
		return
	}

	prof, err := profiles.Get(p.ProfileID)
	if err != nil {
		sendResp(conn, false, err.Error(), nil)
		return
	}

	cleanPath := filepath.Clean(p.TargetPath)
	if err := prof.ValidateConfigPath(cleanPath); err != nil {
		sendResp(conn, false, fmt.Sprintf("config path validation failed: %v", err), nil)
		return
	}
	if ai.IsProtectedPath(cleanPath) {
		sendResp(conn, false, fmt.Sprintf("target path %q is a protected control-plane path", cleanPath), nil)
		return
	}

	if err := prof.ValidateConfigContent(p.CandidateContent); err != nil {
		sendResp(conn, false, fmt.Sprintf("config content validation failed: %v", err), nil)
		return
	}

	// 1. Validator pre-check if profile has validator
	if prof.ValidatorExec != "" {
		if err := validateProfileValidator(prof.ValidatorExec); err != nil {
			sendResp(conn, false, fmt.Sprintf("invalid validator executable: %v", err), nil)
			return
		}
		tempCandidate, err := os.CreateTemp("", "config-preapply-*")
		if err != nil {
			sendResp(conn, false, fmt.Sprintf("creating temp candidate for validation: %v", err), nil)
			return
		}
		defer os.Remove(tempCandidate.Name())

		if _, err := tempCandidate.WriteString(p.CandidateContent); err != nil {
			tempCandidate.Close()
			sendResp(conn, false, fmt.Sprintf("writing temp candidate: %v", err), nil)
			return
		}
		tempCandidate.Close()

		var vArgs []string
		vArgs = append(vArgs, prof.ValidatorArgv...)
		vArgs = append(vArgs, tempCandidate.Name())

		vCmd := exec.Command(prof.ValidatorExec, vArgs...)
		vOut, vErr := vCmd.CombinedOutput()
		if vErr != nil {
			sendResp(conn, false, fmt.Sprintf("validator rejected candidate configuration: %v (output: %s)", vErr, string(vOut)), nil)
			return
		}
	}

	// 2. CAS verification on existing file
	candidateBytes := []byte(p.CandidateContent)
	postDigest := ai.ComputeDigest(candidateBytes)
	if p.PostImageDigest != "" && postDigest != p.PostImageDigest {
		sendResp(conn, false, fmt.Sprintf("post-image digest mismatch: expected %s, got %s", p.PostImageDigest, postDigest), nil)
		return
	}

	parentDir := filepath.Dir(cleanPath)
	var backupPath string
	var existingMode os.FileMode = 0644

	existingBytes, err := os.ReadFile(cleanPath)
	if err == nil {
		if p.CreateNoReplace {
			sendResp(conn, false, "file already exists and createNoReplace is specified", nil)
			return
		}
		existingDigest := ai.ComputeDigest(existingBytes)
		if p.ExpectedPreImageDigest != "" && p.ExpectedPreImageDigest != "none" {
			if existingDigest != p.ExpectedPreImageDigest {
				sendResp(conn, false, fmt.Sprintf("drift detected: current file digest %s does not match expected pre-image digest %s", existingDigest, p.ExpectedPreImageDigest), nil)
				return
			}
		}

		if st, sErr := os.Lstat(cleanPath); sErr == nil {
			existingMode = st.Mode().Perm()
		}

		// Create backup
		if cfg.BackupsDir != "" {
			_ = os.MkdirAll(cfg.BackupsDir, 0700)
			backupName := fmt.Sprintf("%s.%d.bak", filepath.Base(cleanPath), time.Now().UnixNano())
			backupPath = filepath.Join(cfg.BackupsDir, backupName)
			if err := os.WriteFile(backupPath, existingBytes, 0600); err != nil {
				sendResp(conn, false, fmt.Sprintf("creating backup file %s: %v", backupPath, err), nil)
				return
			}
		}
	} else if os.IsNotExist(err) {
		if p.ExpectedPreImageDigest != "" && p.ExpectedPreImageDigest != "none" {
			sendResp(conn, false, fmt.Sprintf("file %s does not exist but expectedPreImageDigest was specified", cleanPath), nil)
			return
		}
	} else {
		sendResp(conn, false, fmt.Sprintf("reading existing target %s: %v", cleanPath, err), nil)
		return
	}

	// 3. Atomic write via temp file in target's directory + rename
	tmpCandidate, err := os.CreateTemp(parentDir, fmt.Sprintf(".tmp.%s.*", filepath.Base(cleanPath)))
	if err != nil {
		sendResp(conn, false, fmt.Sprintf("creating temporary replacement file in %s: %v", parentDir, err), nil)
		return
	}
	tmpName := tmpCandidate.Name()
	defer os.Remove(tmpName)

	if err := tmpCandidate.Chmod(existingMode); err != nil {
		tmpCandidate.Close()
		sendResp(conn, false, fmt.Sprintf("setting permissions on temp candidate: %v", err), nil)
		return
	}

	if _, err := tmpCandidate.Write(candidateBytes); err != nil {
		tmpCandidate.Close()
		sendResp(conn, false, fmt.Sprintf("writing temp candidate: %v", err), nil)
		return
	}

	if err := tmpCandidate.Sync(); err != nil {
		tmpCandidate.Close()
		sendResp(conn, false, fmt.Sprintf("syncing temp candidate: %v", err), nil)
		return
	}
	tmpCandidate.Close()

	if err := os.Rename(tmpName, cleanPath); err != nil {
		sendResp(conn, false, fmt.Sprintf("atomic rename to %s failed: %v", cleanPath, err), nil)
		return
	}

	// Fsync parent directory
	if parentFile, err := os.Open(parentDir); err == nil {
		_ = parentFile.Sync()
		_ = parentFile.Close()
	}

	sendResp(conn, true, "", ai.ConfigApplyResult{
		Applied:         true,
		Path:            cleanPath,
		PostImageDigest: postDigest,
		BackupPath:      backupPath,
	})
}

func handleConfigRecover(conn net.Conn, params json.RawMessage, profiles *ai.ProfileRegistry, cfg ServerConfig) {
	var p ai.ConfigRecoverParams
	if err := json.Unmarshal(params, &p); err != nil {
		sendResp(conn, false, "bad params", nil)
		return
	}

	prof, err := profiles.Get(p.ProfileID)
	if err != nil {
		sendResp(conn, false, err.Error(), nil)
		return
	}

	cleanTarget := filepath.Clean(p.TargetPath)
	if err := prof.ValidateConfigPath(cleanTarget); err != nil {
		sendResp(conn, false, fmt.Sprintf("config path validation failed: %v", err), nil)
		return
	}
	if ai.IsProtectedPath(cleanTarget) {
		sendResp(conn, false, fmt.Sprintf("target path %q is protected", cleanTarget), nil)
		return
	}

	cleanBackup := filepath.Clean(p.BackupPath)
	if cfg.BackupsDir != "" {
		rel, err := filepath.Rel(cfg.BackupsDir, cleanBackup)
		if err != nil || strings.HasPrefix(rel, "..") {
			sendResp(conn, false, fmt.Sprintf("backup path %s is outside authorized backups directory %s", cleanBackup, cfg.BackupsDir), nil)
			return
		}
	}
	if ai.IsProtectedPath(cleanBackup) {
		sendResp(conn, false, fmt.Sprintf("backup path %q is protected", cleanBackup), nil)
		return
	}

	backupData, err := os.ReadFile(cleanBackup)
	if err != nil {
		sendResp(conn, false, fmt.Sprintf("reading backup %s: %v", cleanBackup, err), nil)
		return
	}

	backupDigest := ai.ComputeDigest(backupData)
	if p.TargetDigest != "" && p.TargetDigest != "none" {
		if backupDigest != p.TargetDigest {
			sendResp(conn, false, fmt.Sprintf("backup digest mismatch: expected %s, got %s", p.TargetDigest, backupDigest), nil)
			return
		}
	}

	// Pre-validate backup content with profile validator
	if prof.ValidatorExec != "" {
		if err := validateProfileValidator(prof.ValidatorExec); err != nil {
			sendResp(conn, false, fmt.Sprintf("invalid validator executable: %v", err), nil)
			return
		}
		tempCandidate, err := os.CreateTemp("", "config-recover-val-*")
		if err != nil {
			sendResp(conn, false, fmt.Sprintf("creating temp file for validation: %v", err), nil)
			return
		}
		defer os.Remove(tempCandidate.Name())
		_, _ = tempCandidate.Write(backupData)
		tempCandidate.Close()

		var vArgs []string
		vArgs = append(vArgs, prof.ValidatorArgv...)
		vArgs = append(vArgs, tempCandidate.Name())

		vCmd := exec.Command(prof.ValidatorExec, vArgs...)
		vOut, vErr := vCmd.CombinedOutput()
		if vErr != nil {
			sendResp(conn, false, fmt.Sprintf("validator rejected recovered configuration: %v (output: %s)", vErr, string(vOut)), nil)
			return
		}
	}

	parentDir := filepath.Dir(cleanTarget)
	tmpCandidate, err := os.CreateTemp(parentDir, fmt.Sprintf(".tmp.recover.%s.*", filepath.Base(cleanTarget)))
	if err != nil {
		sendResp(conn, false, fmt.Sprintf("creating temp file in %s: %v", parentDir, err), nil)
		return
	}
	tmpName := tmpCandidate.Name()
	defer os.Remove(tmpName)

	if err := tmpCandidate.Chmod(0644); err != nil {
		tmpCandidate.Close()
		sendResp(conn, false, fmt.Sprintf("chmod temp recover file: %v", err), nil)
		return
	}
	if _, err := tmpCandidate.Write(backupData); err != nil {
		tmpCandidate.Close()
		sendResp(conn, false, fmt.Sprintf("writing recover file: %v", err), nil)
		return
	}
	if err := tmpCandidate.Sync(); err != nil {
		tmpCandidate.Close()
		sendResp(conn, false, fmt.Sprintf("sync recover file: %v", err), nil)
		return
	}
	tmpCandidate.Close()

	if err := os.Rename(tmpName, cleanTarget); err != nil {
		sendResp(conn, false, fmt.Sprintf("rename recover file to %s failed: %v", cleanTarget, err), nil)
		return
	}

	if parentFile, err := os.Open(parentDir); err == nil {
		_ = parentFile.Sync()
		_ = parentFile.Close()
	}

	sendResp(conn, true, "", ai.ConfigRecoverResult{
		Recovered: true,
		Path:      cleanTarget,
		Digest:    backupDigest,
	})
}

func handleCgroupCreate(conn net.Conn, params json.RawMessage, cfg ServerConfig) {
	var p ai.CgroupCreateParams
	if err := json.Unmarshal(params, &p); err != nil {
		sendResp(conn, false, "bad params", nil)
		return
	}
	if err := ai.ValidateTaskID(p.TaskID); err != nil {
		sendResp(conn, false, fmt.Sprintf("invalid task id: %v", err), nil)
		return
	}

	// Verify cgroup v2 unified hierarchy controllers
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err != nil {
		sendResp(conn, false, fmt.Sprintf("cgroup v2 unavailable: unified cgroup hierarchy required (%v)", err), nil)
		return
	}

	// Verify pinned execution identity
	if cfg.ExecutionUID <= 0 || cfg.ExecutionGID <= 0 {
		sendResp(conn, false, "cgroup creation unavailable: pinned execution identity (execution-uid and execution-gid) required", nil)
		return
	}
	if p.ExecutionUID > 0 && p.ExecutionUID != cfg.ExecutionUID {
		sendResp(conn, false, fmt.Sprintf("execution UID mismatch: caller requested %d, pinned helper execution UID is %d", p.ExecutionUID, cfg.ExecutionUID), nil)
		return
	}

	cgroupBase := cfg.CgroupBase
	if cgroupBase == "" {
		cgroupBase = "/sys/fs/cgroup/flexserver-ai"
	}

	if err := os.MkdirAll(cgroupBase, 0755); err != nil {
		sendResp(conn, false, fmt.Sprintf("creating cgroup base %s: %v", cgroupBase, err), nil)
		return
	}

	// Enable controllers in base cgroup subtree_control if possible
	_ = os.WriteFile(filepath.Join(cgroupBase, "cgroup.subtree_control"), []byte("+cpu +memory +pids\n"), 0644)

	taskCgroup := filepath.Join(cgroupBase, p.TaskID)
	if err := os.MkdirAll(taskCgroup, 0755); err != nil {
		sendResp(conn, false, fmt.Sprintf("creating task cgroup %s: %v", taskCgroup, err), nil)
		return
	}

	// Apply pinned / bounded resource limits
	memLimit := p.MemoryMax
	if memLimit <= 0 || memLimit > 1024*1024*1024 {
		memLimit = 256 * 1024 * 1024 // 256 MiB default pinned limit
	}
	_ = os.WriteFile(filepath.Join(taskCgroup, "memory.max"), []byte(strconv.FormatInt(memLimit, 10)+"\n"), 0644)

	pidsLimit := p.PidsMax
	if pidsLimit <= 0 || pidsLimit > 1024 {
		pidsLimit = 64 // 64 PIDs default pinned limit
	}
	_ = os.WriteFile(filepath.Join(taskCgroup, "pids.max"), []byte(strconv.FormatInt(pidsLimit, 10)+"\n"), 0644)

	cpuLimit := p.CPUMax
	if cpuLimit == "" {
		cpuLimit = "100000 100000" // 1 CPU max default
	}
	_ = os.WriteFile(filepath.Join(taskCgroup, "cpu.max"), []byte(cpuLimit+"\n"), 0644)

	// Set ownership of task cgroup and cgroup.procs to pinned execution user
	_ = os.Chown(taskCgroup, cfg.ExecutionUID, cfg.ExecutionGID)
	_ = os.Chown(filepath.Join(taskCgroup, "cgroup.procs"), cfg.ExecutionUID, cfg.ExecutionGID)

	sendResp(conn, true, "", map[string]any{
		"created":    true,
		"taskCgroup": taskCgroup,
	})
}

func handleCgroupKill(conn net.Conn, params json.RawMessage, cfg ServerConfig) {
	var p ai.CgroupKillParams
	if err := json.Unmarshal(params, &p); err != nil {
		sendResp(conn, false, "bad params", nil)
		return
	}
	if err := ai.ValidateTaskID(p.TaskID); err != nil {
		sendResp(conn, false, fmt.Sprintf("invalid task id: %v", err), nil)
		return
	}

	cgroupBase := cfg.CgroupBase
	if cgroupBase == "" {
		cgroupBase = "/sys/fs/cgroup/flexserver-ai"
	}
	taskCgroup := filepath.Join(cgroupBase, p.TaskID)

	killFile := filepath.Join(taskCgroup, "cgroup.kill")
	if _, statErr := os.Stat(killFile); statErr == nil {
		if err := os.WriteFile(killFile, []byte("1"), 0644); err != nil {
			sendResp(conn, false, fmt.Sprintf("writing cgroup.kill: %v", err), nil)
			return
		}
	} else if !os.IsNotExist(statErr) {
		sendResp(conn, false, fmt.Sprintf("stat cgroup.kill: %v", statErr), nil)
		return
	}

	var removeErr error
	for attempt := 0; attempt < 10; attempt++ {
		removeErr = os.Remove(taskCgroup)
		if removeErr == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if removeErr != nil && !os.IsNotExist(removeErr) {
		sendResp(conn, false, fmt.Sprintf("removing task cgroup: %v", removeErr), nil)
		return
	}

	sendResp(conn, true, "", map[string]bool{"killed": true})
}

func handleTaskExecute(ctx context.Context, conn net.Conn, params json.RawMessage, cfg ServerConfig) {
	var p ai.TaskExecuteParams
	if err := json.Unmarshal(params, &p); err != nil {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{Stream: "error", Error: "bad task_execute params"})
		return
	}

	// 1. Verify cgroup v2 availability
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err != nil {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("cgroup v2 unavailable: unified cgroup hierarchy required (%v)", err),
		})
		return
	}

	// 2. Validate pinned execution identity
	execUID := cfg.ExecutionUID
	execGID := cfg.ExecutionGID
	if execUID <= 0 || execGID <= 0 {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  "pinned execution identity (execution-uid and execution-gid) required",
		})
		return
	}
	if p.ExecutionUID > 0 && p.ExecutionUID != execUID {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("execution UID mismatch: caller requested %d, pinned helper execution UID is %d", p.ExecutionUID, execUID),
		})
		return
	}

	// 3. Validate executor binary
	execBin := cfg.ExecutorBinary
	if execBin == "" {
		execBin = "/usr/local/sbin/ai-executor"
	}
	if binSt, err := os.Stat(execBin); err != nil || binSt.Mode().Perm()&0111 == 0 {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("executor binary %s not found or not executable", execBin),
		})
		return
	}

	// 4. Validate rootfs directory
	rootfs := cfg.RootfsDir
	if rootfs == "" {
		rootfs = p.RootfsDir
	}
	if rootfs == "" {
		rootfs = "/usr/local/share/flexserver-ai/rootfs"
	}
	if rSt, err := os.Stat(rootfs); err != nil || !rSt.IsDir() {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("rootfs directory %s not found or not a directory", rootfs),
		})
		return
	}

	// 5. Cgroup provisioning
	cgroupBase := cfg.CgroupBase
	if cgroupBase == "" {
		cgroupBase = "/sys/fs/cgroup/flexserver-ai"
	}
	_ = os.MkdirAll(cgroupBase, 0755)
	_ = os.WriteFile(filepath.Join(cgroupBase, "cgroup.subtree_control"), []byte("+cpu +memory +pids\n"), 0644)

	taskCgroup := filepath.Join(cgroupBase, p.TaskID)
	if err := os.MkdirAll(taskCgroup, 0755); err != nil {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("creating task cgroup %s: %v", taskCgroup, err),
		})
		return
	}
	defer func() {
		killFile := filepath.Join(taskCgroup, "cgroup.kill")
		_ = os.WriteFile(killFile, []byte("1"), 0644)
		for attempt := 0; attempt < 5; attempt++ {
			if os.Remove(taskCgroup) == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()

	_ = os.WriteFile(filepath.Join(taskCgroup, "memory.max"), []byte("268435456\n"), 0644) // 256 MiB
	_ = os.WriteFile(filepath.Join(taskCgroup, "pids.max"), []byte("64\n"), 0644)           // 64 PIDs
	_ = os.WriteFile(filepath.Join(taskCgroup, "cpu.max"), []byte("100000 100000\n"), 0644) // 1 CPU

	// 6. Scratch directory and script setup
	scratchRoot := p.ScratchRootDir
	if scratchRoot == "" {
		scratchRoot = "/tmp/flexserver-ai-scratch"
	}
	taskScratch := filepath.Join(scratchRoot, p.TaskID)
	if err := os.MkdirAll(taskScratch, 0700); err != nil {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("creating task scratch %s: %v", taskScratch, err),
		})
		return
	}
	defer os.RemoveAll(taskScratch)
	_ = os.Chown(taskScratch, execUID, execGID)

	scriptFile := filepath.Join(taskScratch, "script.sh")
	if err := os.WriteFile(scriptFile, []byte(p.Script), 0700); err != nil {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("writing script file: %v", err),
		})
		return
	}
	_ = os.Chown(scriptFile, execUID, execGID)

	// 7. Spawn ai-executor in dedicated namespaces via root bootstrap
	timeout := time.Duration(p.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(execCtx, execBin,
		"-rootfs", rootfs,
		"-scratch", taskScratch,
		"-script", scriptFile,
		"-uid", strconv.Itoa(execUID),
		"-gid", strconv.Itoa(execGID),
		"-cgroup", taskCgroup,
	)

	// Cloneflags for Linux namespace isolation
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: syscall.CLONE_NEWNS | syscall.CLONE_NEWPID | syscall.CLONE_NEWIPC | syscall.CLONE_NEWUTS | syscall.CLONE_NEWNET,
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("creating stdout pipe: %v", err),
		})
		return
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("creating stderr pipe: %v", err),
		})
		return
	}

	if err := cmd.Start(); err != nil {
		sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
			Stream: "error",
			Error:  fmt.Sprintf("starting namespace executor: %v", err),
		})
		return
	}

	// Attach PID to cgroup scope immediately on spawn (dual attach: helper attaches PID + child attaches self)
	procsFile := filepath.Join(taskCgroup, "cgroup.procs")
	_ = os.WriteFile(procsFile, []byte(strconv.Itoa(cmd.Process.Pid)+"\n"), 0644)

	// Stream stdout and stderr
	readDone := make(chan struct{}, 2)
	streamLines := func(r io.Reader, streamName string) {
		defer func() { readDone <- struct{}{} }()
		sc := bufio.NewScanner(r)
		sBuf := make([]byte, 16*1024)
		sc.Buffer(sBuf, 64*1024)
		for sc.Scan() {
			sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
				Stream: streamName,
				Data:   sc.Text() + "\n",
			})
		}
	}

	go streamLines(stdoutPipe, "stdout")
	go streamLines(stderrPipe, "stderr")

	// Wait for process completion or context cancellation
	waitErr := cmd.Wait()
	<-readDone
	<-readDone

	exitCode := 0
	terminated := false
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
				exitCode = status.ExitStatus()
			} else {
				exitCode = exitErr.ExitCode()
			}
		} else {
			exitCode = 1
		}
	}
	if execCtx.Err() != nil {
		terminated = true
		exitCode = 137
	}

	sendStreamMsg(conn, ai.TaskExecuteStreamMessage{
		Stream:     "exit",
		ExitCode:   exitCode,
		Terminated: terminated,
	})
}

func validateProfileValidator(execPath string) error {
	if execPath == "" {
		return errors.New("validator binary path is empty")
	}
	clean := filepath.Clean(execPath)
	if !filepath.IsAbs(clean) {
		return fmt.Errorf("validator binary %q must be an absolute path", execPath)
	}
	trustedDirs := []string{"/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/local/bin", "/usr/local/sbin"}
	trusted := false
	for _, d := range trustedDirs {
		if clean == d || strings.HasPrefix(clean, d+"/") {
			trusted = true
			break
		}
	}
	if !trusted {
		return fmt.Errorf("validator binary %q is not in a trusted system directory", clean)
	}

	st, err := os.Stat(clean)
	if err != nil {
		return fmt.Errorf("stat validator binary %q: %w", clean, err)
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("validator %q is not a regular file", clean)
	}
	if st.Mode().Perm()&0111 == 0 {
		return fmt.Errorf("validator %q is not executable", clean)
	}
	if st.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("validator %q is group- or world-writable (mode=0%o)", clean, st.Mode().Perm())
	}
	var uid uint32
	switch sys := st.Sys().(type) {
	case *syscall.Stat_t:
		uid = sys.Uid
	case *unix.Stat_t:
		uid = sys.Uid
	default:
		return fmt.Errorf("unable to determine validator ownership")
	}
	if uid != 0 {
		return fmt.Errorf("validator %q must be root-owned (UID=%d)", clean, uid)
	}
	return nil
}
