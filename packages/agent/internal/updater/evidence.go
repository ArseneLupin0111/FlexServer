package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
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
	exclusionCandidates := []string{
		"/var/lib/vps-manager-agent/docker-applications/exclusion.json",
	}
	if cfg != nil && cfg.StateDir != "" {
		exclusionCandidates = append(exclusionCandidates,
			filepath.Join(cfg.StateDir, "docker-applications", "exclusion.json"),
			filepath.Join(cfg.StateDir, "..", "vps-manager-agent", "docker-applications", "exclusion.json"),
		)
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
		var rows map[string]struct {
			Scope  string `json:"scope"`
			Holder struct {
				Kind string `json:"kind"`
				ID   string `json:"id"`
			} `json:"holder"`
			ExpiresAtUnix int64 `json:"expiresAtUnix,omitempty"`
		}
		if err := json.Unmarshal(data, &rows); err != nil {
			return false, fmt.Sprintf("exclusion lock registry %s corrupt: %v", p, err)
		}
		now := time.Now().Unix()
		for scope, r := range rows {
			if r.ExpiresAtUnix == 0 || r.ExpiresAtUnix > now {
				return false, fmt.Sprintf("active exclusion lock on scope %s held by %s", scope, r.Holder.Kind)
			}
		}
	}

	// 2. Check active PTY / terminal sessions
	ptySockets := []string{
		"/run/flexserver/host-pty/pty.sock",
		"/var/run/flexserver/host-pty/pty.sock",
	}
	for _, sock := range ptySockets {
		if fi, err := os.Stat(sock); err == nil && !fi.IsDir() {
			// Socket exists: check if sessions marker exists
			activeMarker := filepath.Join(filepath.Dir(sock), "active_sessions")
			if markerData, err := os.ReadFile(activeMarker); err == nil {
				txt := strings.TrimSpace(string(markerData))
				if txt != "" && txt != "0" {
					return false, fmt.Sprintf("active terminal sessions (%s)", txt)
				}
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
			if procs, err := os.ReadFile(taskProcs); err == nil {
				pids := strings.Fields(string(procs))
				if len(pids) > 0 {
					return false, fmt.Sprintf("AI task active in cgroup %s (pids: %d)", e.Name(), len(pids))
				}
			}
		}
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
			}
		}
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
