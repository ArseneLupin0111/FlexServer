//go:build linux

package applications

// Compose invocation without shell: fixed absolute executable, allowlisted
// argv, private project directory, scrubbed environment. Compose never
// inherits DOCKER_*/COMPOSE_*/proxy/helper configuration or agent secrets.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	MaxComposeImagePathBytes = 512
	MaxComposeOutputBytes    = 64 * 1024
	// RegistryWorkflowTimeout bounds model resolution; a separate slower pull
	// deadline lives on the operation's pullTimeoutSeconds.
	RegistryWorkflowTimeout = 10 * time.Minute

	// Stable operation error codes (reported verbatim in result.error).
	ErrRuntimeUnavailable = "runtime_unavailable"
	ErrUnsupportedOper    = "unsupported_operation"
	ErrMalformed          = "malformed_operation_payload"
	ErrSourceDrift        = "source_drift"
	ErrRegistryDenied     = "registry_access_denied"
	ErrDependencyUnready  = "dependency_not_ready"
	ErrReadinessTimeout   = "readiness_timeout"
	ErrApplyFailed        = "apply_failed"
	ErrBindUnauthorized   = "mutation_not_authorized"
)

// ComposeRuntime is the fixed verified entrypoint pose.
type ComposeRuntime struct {
	Mode    string // ModePlugin|ModeStandalone
	Path    string
	Version string
}

// DetectRuntime probes fixed absolute paths only; no PATH search, no
// user-selected binary. Ownership/non-writability checks are mandatory.
// Returns ErrRuntimeUnavailable when no trusted compose runtime exists.
func DetectRuntime() (*ComposeRuntime, error) {
	candidates := []struct {
		mode string
		path string
	}{
		{ModePlugin, composeInstallPath},
		{ModePlugin, "/usr/local/lib/docker/cli-plugins/docker-compose"},
		{ModePlugin, "/usr/libexec/docker/cli-plugins/docker-compose"},
		{ModeStandalone, "/usr/local/bin/docker-compose"},
		{ModeStandalone, "/usr/bin/docker-compose"},
	}
	for _, c := range candidates {
		info, err := os.Stat(c.path)
		if err != nil {
			continue
		}
		if info.IsDir() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		if info.Mode().Perm()&0o022 != 0 {
			continue // group/other-writable executable rejected
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Uid != 0 {
			continue // only root-owned runtime accepted
		}
		version, verr := probeVersion(c.path)
		if verr != nil || !compatibleComposeVersion(version) {
			continue
		}
		return &ComposeRuntime{Mode: c.mode, Path: c.path, Version: version}, nil
	}
	return nil, errors.New(ErrRuntimeUnavailable)
}

// probeVersion runs the binary with --version under the scrubbed environment
// (bounded output; the detector never writes anything). Standalone type
// accepts either `docker compose …` (plugin in compose name) or bare
// `docker-compose —version`.
func probeVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version", "--short")
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	out, err := boundedCommandOutput(cmd, 4096)
	if err != nil || len(out) == 0 {
		// Fall back to the human version line for old plugin harnesses.
		cmd2 := exec.CommandContext(ctx, path, "--version")
		cmd2.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
		out2, err2 := boundedCommandOutput(cmd2, 4096)
		if err2 != nil {
			return "", err
		}
		line := strings.TrimSpace(string(out2))
		if line == "" || strings.HasPrefix(strings.ToLower(line), "v") == false && !strings.Contains(line, "compose version") {
			return "", fmt.Errorf("unrecognized compose version output")
		}
		line = strings.TrimPrefix(line, "Docker Compose version ")
		return line, nil
	}
	return strings.TrimSpace(string(out)), nil
}

// dockerSocketHost is the fixed Engine endpoint for Compose engine work.
const dockerSocketHost = "unix:///var/run/docker.sock"

// scrubEnv builds the fixed environment for Compose and helper invocations:
// minimal PATH, no inherited ambient proxy/docker/compose variables, and an
// isolated DOCKER_CONFIG pointing at the op-local auth directory.
func scrubEnv(home, dockerConfig, socketDir string) []string {
	base := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + home,
		"DOCKER_CONFIG=" + dockerConfig,
		"DOCKER_HOST=" + socketDir,
	}
	// Anti-interference: explicit empty values defeat host shells that would
	// otherwise inject DOCKER_CTX/COMPOSE_* into the child.
	for _, k := range []string{"DOCKER_CTX", "COMPOSE_COMPATIBILITY", "COMPOSE_PROFILE", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_IGNORE_ORPHANS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"} {
		base = append(base, k+"=")
	}
	return base
}

// composeRunner holds one operation's isolated execution surface.
type composeRunner struct {
	runtime *ComposeRuntime
	authDir string // per-op registry auth dir (0700/0600 files)
	workDir string // private fixed project-directory
	onStart func(*exec.Cmd) error
	env     []string
}

// workRoot returns the durable runtime-declared workspace root; a fixed
// absolute location keeps every artifact under the agent's own jurisdiction.
func workRoot() string {
	base := os.Getenv("COMPOSE_WORK_DIR")
	if base == "" {
		base = "/var/lib/flexserver/apps"
	}
	return base
}

// newComposeRunner prepares the isolated directories for one operation.
// All directories are 0700 under the base dir; secrets/config never land in
// shared or world-readable locations.
func newComposeRunner(rt *ComposeRuntime, appID, opID string) (*composeRunner, error) {
	if err := safeDirComponent(appID); err != nil {
		return nil, err
	}
	if err := safeDirComponent(opID); err != nil {
		return nil, err
	}
	baseDir := filepath.Join(workRoot(), appID+"-w-"+opID)
	for _, dir := range []string{baseDir, filepath.Join(baseDir, "work"), filepath.Join(baseDir, "auth"), filepath.Join(baseDir, "env")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
		if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm()&0o077 != 0 {
			_ = os.Chmod(dir, 0o700)
		}
	}
	r := &composeRunner{
		runtime: rt,
		authDir: filepath.Join(baseDir, "auth"),
		workDir: filepath.Join(baseDir, "work"),
		env:     scrubEnv(filepath.Join(baseDir, "work"), filepath.Join(baseDir, "auth"), dockerSocketHost),
	}
	return r, nil
}

// close removes every private artifact for the operation.
func (r *composeRunner) close() {
	if len(r.workDir) > len(filepath.Dir(r.workDir)) {
		_ = os.RemoveAll(filepath.Dir(r.workDir))
	}
}

// cmd builds an exec.Cmd with the scrubbed environment and isolated process
// group (never shares the agent's group for safe group termination).
func (r *composeRunner) cmd(ctx context.Context, cancel context.CancelFunc, timeout time.Duration, args ...string) error {
	if r == nil || r.runtime == nil || r.runtime.Path == "" || len(args) == 0 {
		return fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	if err := validateComposeFixedArgv(args); err != nil {
		return err
	}
	fi, err := os.Stat(r.workDir)
	if err != nil || !fi.IsDir() || fi.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	if timeout <= 0 {
		return fmt.Errorf("invalid command timeout")
	}
	cctx, stop := context.WithTimeout(ctx, timeout)
	defer stop()
	if cancel != nil {
		defer cancel()
	}
	cmd := exec.CommandContext(cctx, r.runtime.Path, args...)
	cmd.Env = r.env
	cmd.Dir = r.workDir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	configureProcessCancellation(cmd)
	err = cmd.Run()
	if cctx.Err() != nil {
		return cctx.Err()
	}
	if err != nil {
		return fmt.Errorf("compose command failed")
	}
	return nil

}

// runStdout executes a bounded Compose subcommand and returns stdout.
// stderr is captured but never surfaced raw (it can contain interpolated
// secret values).
func (r *composeRunner) runStdout(ctx context.Context, timeout time.Duration, stdoutLimit int, project string, writeComposeFile, writeEnvFile []byte, args ...string) ([]byte, string, error) {
	fi, err := os.Stat(r.workDir)
	if err != nil || fi.Mode().Perm()&0o077 != 0 {
		return nil, "", errors.New(ErrRuntimeUnavailable)
	}
	composePath := filepath.Join(r.workDir, "docker-compose.yml")
	if len(writeComposeFile) > 0 {
		if err := writePrivateFile(composePath, writeComposeFile, 0o600); err != nil {
			return nil, "", err
		}
	} else if _, err := os.Stat(composePath); err != nil && !os.IsNotExist(err) {
		return nil, "", err
	}
	envPath := ""
	if len(writeEnvFile) > 0 {
		envPath = filepath.Join(r.workDir, "compose.env")
		if err := writePrivateFile(envPath, writeEnvFile, 0o600); err != nil {
			return nil, "", err
		}
	}
	if err := validateComposeFixedArgv(args); err != nil {
		return nil, "", err
	}
	full := make([]string, 0, len(args)+8)
	if project != "" {
		if verr := safeDirComponent(project); verr != nil {
			return nil, "", verr
		}
		full = append(full, "-p", project)
	}
	full = append(full, "-f", composePath)
	if envPath != "" {
		full = append(full, "--env-file", envPath)
	}
	full = append(full, args...)
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c := exec.CommandContext(cctx, r.runtime.Path, full...)
	c.Env = r.env
	c.Dir = r.workDir
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	configureProcessCancellation(c)
	stdout := &boundedOutput{limit: stdoutLimit}
	c.Stdout = stdout
	c.Stderr = io.Discard
	runErr := runTrackedCommand(c, r.onStart)
	if stdout.exceeded {
		return nil, "", fmt.Errorf("compose output limit exceeded")
	}
	if cctx.Err() != nil {
		return nil, "", cctx.Err()
	}
	return stdout.data, "", runErr
}

// truncateSafe is a bounded UTF-8-safe string truncation.
func truncateSafe(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && (s[cut-1]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}

// validateComposeFixedArgv rejects shell metacharacters and the project /
// override / orphan-management flags that must never enter managed argument
// vectors. All paths are constructed by the agent, never by API.
func validateComposeFixedArgv(args []string) error {
	for _, arg := range args {
		if strings.ContainsAny(arg, "\x00\n\r;&|`$><") {
			return errors.New(ErrMalformed)
		}
	}
	banned := []string{"--remove-orphans", "--renew-anon-volumes", "--abort-on-container-exit", "--exit-code-from", "--scale", "--wait-timeout"}
	for _, arg := range args {
		for _, b := range banned {
			if arg == b || strings.HasPrefix(arg, b+"=") {
				return errors.New(ErrUnsupportedOper)
			}
		}
	}
	return nil
}

// writePrivateFile creates or truncates `path` with `perm` in one atomic
// write; existing modes tighten if too broad.
func writePrivateFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm()&0o077 != 0 {
		_ = os.Chmod(dir, 0o700)
	}
	tmp, err := os.CreateTemp(dir, ".w-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// strictDecodeJSON performs bounded strict JSON decoding that rejects
// trailing tokens; UseNumber rejects silent float coercion in identifiers.
func strictDecodeJSON(data []byte, into any) error {
	if len(data) == 0 || len(data) > MaxComposeOutputBytes {
		return fmt.Errorf("payload out of bounds")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(into); err != nil {
		return err
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("trailing JSON tokens")
	}
	return nil
}

// safeDirComponent validates the bounded identifiers that are embedded into
// a private workspace path (app ID / operation ID / project name are all
// server-generated, but validation never trusts that).
func safeDirComponent(s string) error {
	if s == "" || len(s) > 64 {
		return fmt.Errorf(ErrMalformed)
	}
	for _, r := range s {
		isAlnum := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if isAlnum || r == '-' || r == '_' {
			continue
		}
		return fmt.Errorf(ErrMalformed)
	}
	return nil
}

// demoSocketClient dials the fixed local socket for lifecycle data only.
func demoSocketClient(timeout time.Duration, socketURL string) *http.Client {
	if socketURL == "" {
		socketURL = dockerSocketHost
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{Timeout: timeout}).DialContext(ctx, "unix", strings.TrimPrefix(socketURL, "unix://"))
			},
		},
	}
}

// boundedOutput never allocates beyond its limit, even for an untrusted child.
type boundedOutput struct {
	data     []byte
	limit    int
	exceeded bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.limit - len(b.data)
	if remaining < len(p) {
		b.exceeded = true
		p = p[:remaining]
	}
	b.data = append(b.data, p...)
	return n, nil
}
func configureProcessCancellation(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.Cancel = func() error {
		if c.Process == nil {
			return os.ErrProcessDone
		}
		return syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	}
	c.WaitDelay = 2 * time.Second
}
func boundedCommandOutput(c *exec.Cmd, limit int) ([]byte, error) {
	configureProcessCancellation(c)
	b := &boundedOutput{limit: limit}
	c.Stdout = b
	c.Stderr = io.Discard
	err := c.Run()
	if b.exceeded {
		return nil, fmt.Errorf("command output limit exceeded")
	}
	return b.data, err
}

func runTrackedCommand(c *exec.Cmd, onStart func(*exec.Cmd) error) error {
	if err := c.Start(); err != nil {
		return err
	}
	if onStart != nil {
		if err := onStart(c); err != nil {
			_ = c.Cancel()
			_ = c.Wait()
			return err
		}
	}
	return c.Wait()
}
