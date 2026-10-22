package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/vps-manager/agent/internal/applications"
)

// PlatformInfo describes host OS and architecture.
type PlatformInfo struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
}

// AIHealthReport describes the AI runtime status on the host.
type AIHealthReport struct {
	Installed  bool     `json:"installed"`
	Version    string   `json:"version,omitempty"`
	Healthy    bool     `json:"healthy"`
	Detail     string   `json:"detail,omitempty"`
	Components []string `json:"components,omitempty"`
}

// ClaimRequest is sent in Protocol 3 job claim requests.
type ClaimRequest struct {
	UpdaterVersion string         `json:"updaterVersion,omitempty"`
	Platform       PlatformInfo   `json:"platform"`
	Idle           bool           `json:"idle"`
	BusyReason     string         `json:"busyReason,omitempty"`
	AIHealth       AIHealthReport `json:"aiHealth"`
}

// DetectHostIdle inspects active operations on the host (Compose/Docker, terminal sessions, AI tasks).
// Unknown evidence fails closed (returns false, reason).
func DetectHostIdle(cfg *Config) (idle bool, reason string) {
	// 1. Check Compose / Docker exclusion locks
	seen := make(map[string]bool)
	var exclusionCandidates []string
	addCandidate := func(p string) {
		clean := filepath.Clean(p)
		if !seen[clean] {
			seen[clean] = true
			exclusionCandidates = append(exclusionCandidates, clean)
		}
	}
	if cfg != nil && cfg.AgentStateDir != "" {
		addCandidate(filepath.Join(cfg.AgentStateDir, "docker-applications", "exclusion.json"))
	} else {
		if p, err := applications.DefaultLockPath(); err == nil && p != "" {
			addCandidate(p)
		}
		addCandidate("/var/lib/vps-manager-agent/docker-applications/exclusion.json")
		if cfg != nil && cfg.StateDir != "" {
			addCandidate(filepath.Join(cfg.StateDir, "docker-applications", "exclusion.json"))
			addCandidate(filepath.Join(cfg.StateDir, "..", "vps-manager-agent", "docker-applications", "exclusion.json"))
		}
	}

	for _, p := range exclusionCandidates {
		data, err := os.ReadFile(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			// Fail closed on unreadable lock registry
			return false, fmt.Sprintf("exclusion lock registry %s unreadable: %v", p, err)
		}
		var rows []applications.LockRow
		if err := json.Unmarshal(data, &rows); err != nil {
			return false, fmt.Sprintf("exclusion lock registry %s corrupt: %v", p, err)
		}
		now := time.Now().Unix()
		for _, r := range rows {
			// Idle inspection must ignore own upgrade scope:
			if r.Scope == applications.LockScopeUpgrade {
				if (r.Holder.Kind == "updater-helper" || r.Holder.Kind == "") {
					if cfg != nil && cfg.CurrentJobID != "" && r.Holder.ID == cfg.CurrentJobID {
						continue
					}
					if cfg != nil && cfg.StateDir != "" {
						if hj, err := LoadHelperJournal(cfg.StateDir); err == nil && hj != nil && (hj.FenceOwner == r.Holder.ID || hj.JobID == r.Holder.ID) {
							continue
						}
					}
				}
			}
			// Stale activity check:
			// terminal:* and ai:* ephemeral activity rows (even mutating) are ignored if holder process died.
			// Mutating Compose operations require explicit recovery even if process died.
			// Non-mutating rows are ignored if process died.
			isEphemeralActivity := strings.HasPrefix(r.Scope, "terminal:") || strings.HasPrefix(r.Scope, "ai:")
			if r.Scope != applications.LockScopeUpgrade && r.Holder.PID > 0 {
				if isEphemeralActivity || !r.Mutating {
					if !applications.IsProcessAlive(r.Holder.PID, r.Holder.ProcessStartTime) {
						continue
					}
				}
			}
			// Mutating locks never expire by TTL; non-mutating expire after ExpiresAtUnix.
			if r.Mutating || r.ExpiresAtUnix == 0 || r.ExpiresAtUnix > now {
				return false, fmt.Sprintf("active exclusion lock on scope %s held by %s", r.Scope, r.Holder.Kind)
			}
		}
	}

	// 2. Check active PTY / terminal sessions
	ptySockets := []string{
		"/run/flexserver/host-pty/pty.sock",
		"/var/run/flexserver/host-pty/pty.sock",
		"/run/flexserver/host-pty/host-pty.sock",
		"/var/run/flexserver/host-pty/host-pty.sock",
	}
	for _, sock := range ptySockets {
		if fi, err := os.Stat(sock); err == nil && !fi.IsDir() {
			// Socket exists: check if sessions marker exists
			activeMarker := filepath.Join(filepath.Dir(sock), "active_sessions")
			markerData, err := os.ReadFile(activeMarker)
			if err != nil {
				return false, fmt.Sprintf("pty socket %s present with missing or unreadable active_sessions marker: %v", sock, err)
			}
			txt := strings.TrimSpace(string(markerData))
			count, err := strconv.Atoi(txt)
			if err != nil {
				return false, fmt.Sprintf("pty socket %s present with non-numeric active_sessions marker (%q)", sock, txt)
			}
			if count > 0 {
				return false, fmt.Sprintf("active terminal sessions (%d)", count)
			}
		}
	}

	// 3. Check AI tasks in child cgroups under /sys/fs/cgroup/flexserver-ai
	cgroupBase := "/sys/fs/cgroup/flexserver-ai"
	if entries, err := os.ReadDir(cgroupBase); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			taskProcs := filepath.Join(cgroupBase, e.Name(), "cgroup.procs")
			procs, err := os.ReadFile(taskProcs)
			if err != nil {
				return false, fmt.Sprintf("AI cgroup child %s unreadable: %v", taskProcs, err)
			}
			pids := strings.Fields(string(procs))
			if len(pids) > 0 {
				return false, fmt.Sprintf("AI task active in cgroup %s (pids: %d)", e.Name(), len(pids))
			}
		}
	} else if !os.IsNotExist(err) {
		return false, fmt.Sprintf("AI cgroup directory %s unreadable: %v", cgroupBase, err)
	}

	// 4. Check AI scratch directory for recent activity
	scratchDir := "/var/lib/flexserver-ai/scratch"
	if entries, err := os.ReadDir(scratchDir); err == nil {
		cutoff := time.Now().Add(-30 * time.Second)
		for _, e := range entries {
			if fi, err := e.Info(); err == nil {
				if fi.ModTime().After(cutoff) {
					return false, fmt.Sprintf("recent AI task scratch activity in %s", e.Name())
				}
			} else {
				return false, fmt.Sprintf("AI scratch entry %s unreadable: %v", e.Name(), err)
			}
		}
	} else if !os.IsNotExist(err) {
		return false, fmt.Sprintf("AI scratch directory %s unreadable: %v", scratchDir, err)
	}

	return true, ""
}

// DetectAIHealth inspects installed AI components, binary versions, and service status.
func DetectAIHealth(cfg *Config) AIHealthReport {
	helperBin := "/usr/local/sbin/ai-host-helper"
	executorBin := "/usr/local/sbin/ai-executor"
	serviceName := "flexserver-ai-helper.service"
	rootfsDir := "/usr/local/share/flexserver-ai/rootfs"
	profilesDir := "/etc/flexserver-ai/profiles"

	var comps []string
	if _, err := os.Stat(helperBin); err == nil {
		comps = append(comps, "ai-host-helper")
	}
	if _, err := os.Stat(executorBin); err == nil {
		comps = append(comps, "ai-executor")
	}
	if _, err := os.Stat(rootfsDir); err == nil {
		comps = append(comps, "ai-rootfs")
	}
	if _, err := os.Stat(profilesDir); err == nil {
		comps = append(comps, "ai-profiles")
	}

	if len(comps) == 0 {
		return AIHealthReport{
			Installed:  false,
			Healthy:    true,
			Components: comps,
		}
	}

	report := AIHealthReport{
		Installed:  true,
		Components: comps,
		Healthy:    true,
	}

	// Version check via helper -version
	if _, err := os.Stat(helperBin); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		cmd := exec.CommandContext(ctx, helperBin, "-version")
		if out, err := cmd.Output(); err == nil {
			v, _, parseErr := ParseVersionLine(strings.TrimSpace(string(out)))
			if parseErr == nil {
				report.Version = v
			} else {
				report.Version = strings.TrimSpace(string(out))
			}
		}
		cancel()
	}

	// Check helper service active state if unit exists
	servicePath := "/etc/systemd/system/" + serviceName
	if _, err := os.Stat(servicePath); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "systemctl", "is-active", serviceName)
		out, err := cmd.Output()
		status := strings.TrimSpace(string(out))
		if err != nil || status != "active" {
			report.Healthy = false
			report.Detail = fmt.Sprintf("service %s is %s", serviceName, status)
		}
	}

	return report
}
