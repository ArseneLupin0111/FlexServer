package updater

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/vps-manager/agent/internal/version"
)

var systemdUnitRe = regexp.MustCompile(`^[a-zA-Z0-9_.-]+\.service$`)

// parseHTTPBase parses an absolute http(s) base URL without userinfo.
func parseHTTPBase(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("not an absolute URL")
	}
	if u.User != nil {
		return nil, fmt.Errorf("must not carry userinfo")
	}
	return u, nil
}

// Config is the root-owned updater configuration. Nothing in it is ever
// API-controlled: base URL, credential, pinned key and allowlist come from
// this file only.
//
// Production invariants are enforced against the config FILE, not by it:
// apiBase must be https, agentBinary/agentUnit must be the fixed production
// targets and the download allowlist cannot be overridden. Only an
// in-process test harness calling EnableTestOverrides may deviate.
type Config struct {
	// APIBase is the base URL of the vps-manager API, e.g. https://api.example.com
	APIBase string `json:"apiBase"`
	// Credential is the scoped local-updater bearer (vma_<credentialId>_<secret>).
	Credential string `json:"credential"`

	// AgentBinary is the fixed absolute path of the agent binary the helper may replace.
	AgentBinary string `json:"agentBinary"`
	// AgentUnit is the fixed systemd unit the helper may restart.
	AgentUnit string `json:"agentUnit"`

	// AgentConfig is the path to the host agent configuration file used to
	// discover the trusted local vpsId for lock provisioning.
	// In production, it must resolve to FixedAgentConfig.
	AgentConfig string `json:"agentConfig,omitempty"`

	// VpsID is an optional trusted local VPS identifier override in the updater config.
	VpsID string `json:"vpsId,omitempty"`
	// FleetReleasePublicKeyFile is the path to the pinned Ed25519 public key PEM.
	FleetReleasePublicKeyFile string `json:"fleetReleasePublicKeyFile,omitempty"`
	// StateDir holds journal, staging, pending, results, backups and the lock.
	StateDir string `json:"stateDir"`
	// AgentStateDir is the host agent's state directory (holds docker-applications/exclusion.json).
	AgentStateDir string `json:"agentStateDir,omitempty"`
	// MaxArtifactBytes caps a single artifact download (default 128 MiB).
	MaxArtifactBytes int64 `json:"maxArtifactBytes,omitempty"`
	// HTTPTimeout bounds every API/download request.
	HTTPTimeout time.Duration `json:"-"`
	// ClaimInterval is the idle poll interval before claiming a new job.
	ClaimInterval time.Duration `json:"-"`
	// HeartbeatInterval is the GET poll interval while awaiting a heartbeat.
	HeartbeatInterval time.Duration `json:"-"`
	// AwaitHeartbeatGrace is how long to wait for the target heartbeat before
	// requesting a rollback (must stay below the server's phase deadline).
	AwaitHeartbeatGrace time.Duration `json:"-"`
	// HelperTimeout bounds one privileged helper invocation.
	HelperTimeout time.Duration `json:"-"`
	// CurrentJobID is set in-process by the helper during active execution so
	// idle inspection ignores its own upgrade fence.
	CurrentJobID string `json:"-"`

	HTTPTimeoutSec         int `json:"httpTimeoutSec,omitempty"`
	ClaimIntervalSec       int `json:"claimIntervalSec,omitempty"`
	HeartbeatIntervalSec   int `json:"heartbeatIntervalSec,omitempty"`
	AwaitHeartbeatGraceSec int `json:"awaitHeartbeatGraceSec,omitempty"`
	HelperTimeoutSec       int `json:"helperTimeoutSec,omitempty"`
	// testMode opts out of the fixed production invariants. It is unexported
	// so no config file can ever enable it; only in-process test harnesses
	// call EnableTestOverrides.
	testMode              bool
	testAuthorizer        JobAuthorizer
	testLockDir           string
	testTmpfilesDir       string
	testCanonicalTargets  map[string]string
	testFleetPublicKeyPEM []byte
	testUpdaterVersion    string
}
const (
	FixedAgentBinary           = "/usr/local/bin/vps-manager-agent"
	FixedAgentUnit             = "vps-manager-agent.service"
	FixedAgentConfig           = "/etc/vps-manager-agent/config.json"
	FixedUpdaterBinary         = "/usr/local/lib/vps-manager-agent/vps-updater"
	FixedAIExecutorBinary      = "/usr/local/sbin/ai-executor"
	FixedAIHostHelperBinary    = "/usr/local/sbin/ai-host-helper"
	FixedAIRootfsDir           = "/usr/local/share/flexserver-ai/rootfs"
	FixedAIProfilesDir         = "/etc/flexserver-ai/profiles"
	FixedFleetReleasePublicKey = "/etc/vps-updater/fleet-release.pub"
)
// EnableTestOverrides allows this in-process Config to deviate from the
// fixed production invariants (https-only apiBase, fixed agent binary/unit,
// pinned allowlist) so the fault-injection harness can redirect them at
// temp dirs. Never call it from production code; config files cannot
// enable it.
func (c *Config) EnableTestOverrides() { c.testMode = true }

func (c *Config) SetTestAuthorizer(auth JobAuthorizer) { c.testAuthorizer = auth }
func (c *Config) SetTestLockDir(dir string)            { c.testLockDir = dir }
func (c *Config) SetTestTmpfilesDir(dir string)        { c.testTmpfilesDir = dir }
func (c *Config) SetTestCanonicalTargets(targets map[string]string) {
	c.testCanonicalTargets = targets
}

func (c *Config) SetTestCanonicalTarget(component, target string) {
	if c.testCanonicalTargets == nil {
		c.testCanonicalTargets = make(map[string]string)
	}
	c.testCanonicalTargets[component] = target
}

func (c *Config) CanonicalTarget(component string) (string, bool) {
	if c.testMode && c.testCanonicalTargets != nil {
		if target, ok := c.testCanonicalTargets[component]; ok {
			return target, true
		}
	}
	switch component {
	case "agent":
		return c.AgentBinary, true
	case "updater":
		return FixedUpdaterBinary, true
	case "ai-executor":
		return FixedAIExecutorBinary, true
	case "ai-host-helper":
		return FixedAIHostHelperBinary, true
	case "ai-rootfs":
		return FixedAIRootfsDir, true
	case "ai-profiles":
		return FixedAIProfilesDir, true
	default:
		return "", false
	}
}

func (c *Config) SetTestFleetPublicKeyPEM(pem []byte) {
	c.testFleetPublicKeyPEM = pem
}

func (c *Config) FleetPublicKeyPEM() ([]byte, error) {
	if c.testMode && len(c.testFleetPublicKeyPEM) > 0 {
		return c.testFleetPublicKeyPEM, nil
	}
	keyPath := c.FleetReleasePublicKeyFile
	if !c.testMode || keyPath == "" {
		keyPath = FixedFleetReleasePublicKey
	}
	return LoadPublicKeyPEM(keyPath)
}

func (c *Config) SetTestUpdaterVersion(v string) {
	c.testUpdaterVersion = v
}

func (c *Config) UpdaterVersion() string {
	if c.testMode && c.testUpdaterVersion != "" {
		return c.testUpdaterVersion
	}
	return version.String()
}

// Defaults applied when duration fields are absent or zero.
const (
	defaultHTTPTimeout         = 30 * time.Second
	defaultClaimInterval       = 60 * time.Second
	defaultHeartbeatInterval   = 15 * time.Second
	defaultAwaitHeartbeatGrace = 6 * time.Minute
	defaultHelperTimeout       = 3 * time.Minute
	defaultMaxArtifactBytes    = 128 << 20
)

// LoadConfig reads and validates the root-owned config file.
func LoadConfig(path string) (*Config, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("stat config %s: %w", path, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("config %s must not be a symlink", path)
	}
	if fi.Mode().Perm()&0022 != 0 && os.Geteuid() == 0 {
		return nil, fmt.Errorf("config %s must not be group- or world-writable (mode %o)", path, fi.Mode().Perm())
	}
	if os.Geteuid() == 0 {
		if rooted, ok := statIsRootOwned(fi); ok && !rooted {
			return nil, fmt.Errorf("config %s must be owned by root", path)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	if err := c.NormalizeAndValidate(); err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	return &c, nil
}

// NormalizeAndValidate fills defaults and enforces fail-closed invariants.
//
// Production (config file) invariants: apiBase must be https, agentBinary
// and agentUnit must be the fixed targets, and allowedHosts cannot be
// overridden — the pinned allowlist ships with the binary. Only an
// in-process test harness via EnableTestOverrides may deviate; no config
// file field can enable that.
func (c *Config) NormalizeAndValidate() error {
	if c.APIBase == "" {
		return fmt.Errorf("apiBase is required")
	}
	c.APIBase = strings.TrimRight(c.APIBase, "/")
	u, err := parseHTTPBase(c.APIBase)
	if err != nil {
		return fmt.Errorf("apiBase: %w", err)
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !c.testMode) {
		return fmt.Errorf("apiBase must use https")
	}
	if c.Credential == "" {
		return fmt.Errorf("credential is required")
	}
	if !strings.HasPrefix(c.Credential, "vma_") {
		return fmt.Errorf("credential must be a scoped vma_ bearer")
	}
	if c.VpsID != "" {
		h := sha256.Sum256([]byte(c.VpsID))
		expectedUnit := fmt.Sprintf("vps-agent-%x.service", h)
		if c.AgentUnit == "" {
			c.AgentUnit = expectedUnit
		} else {
			if !systemdUnitRe.MatchString(c.AgentUnit) {
				return fmt.Errorf("invalid agentUnit name: %q", c.AgentUnit)
			}
		}
		if c.AgentBinary == "" {
			c.AgentBinary = FixedAgentBinary
		} else if !filepath.IsAbs(c.AgentBinary) {
			return fmt.Errorf("agentBinary must be an absolute path")
		}
		if c.AgentConfig == "" {
			c.AgentConfig = FixedAgentConfig
		} else if !filepath.IsAbs(c.AgentConfig) {
			return fmt.Errorf("agentConfig must be an absolute path")
		}
	} else {
		if c.AgentBinary == "" {
			if c.testMode {
				return fmt.Errorf("agentBinary is required")
			}
			c.AgentBinary = FixedAgentBinary
		}
		if !c.testMode && c.AgentBinary != FixedAgentBinary {
			return fmt.Errorf("agentBinary must be %s", FixedAgentBinary)
		}
		if c.testMode && !filepath.IsAbs(c.AgentBinary) {
			return fmt.Errorf("agentBinary must be an absolute path")
		}
		if c.AgentUnit == "" {
			c.AgentUnit = FixedAgentUnit
		}
		if !c.testMode && c.AgentUnit != FixedAgentUnit {
			return fmt.Errorf("agentUnit must be %s", FixedAgentUnit)
		}
		if c.AgentConfig == "" {
			if !c.testMode {
				c.AgentConfig = FixedAgentConfig
			}
		} else {
			c.AgentConfig = filepath.Clean(c.AgentConfig)
			if !c.testMode && c.AgentConfig != FixedAgentConfig {
				return fmt.Errorf("agentConfig must be %s", FixedAgentConfig)
			}
			if c.testMode && !filepath.IsAbs(c.AgentConfig) {
				return fmt.Errorf("agentConfig must be an absolute path")
			}
		}
	}
	if c.FleetReleasePublicKeyFile == "" {
		if !c.testMode {
			c.FleetReleasePublicKeyFile = FixedFleetReleasePublicKey
		}
	} else {
		if !c.testMode && c.FleetReleasePublicKeyFile != FixedFleetReleasePublicKey {
			return fmt.Errorf("fleetReleasePublicKeyFile must be %s", FixedFleetReleasePublicKey)
		}
		if c.testMode && !filepath.IsAbs(c.FleetReleasePublicKeyFile) {
			return fmt.Errorf("fleetReleasePublicKeyFile must be an absolute path")
		}
	}
	if c.StateDir == "" {
		c.StateDir = "/var/lib/vps-updater"
	}
	if !c.testMode && c.StateDir != "/var/lib/vps-updater" {
		return fmt.Errorf("stateDir must be /var/lib/vps-updater")
	}
	if !filepath.IsAbs(c.StateDir) {
		return fmt.Errorf("stateDir must be an absolute path")
	}
	if c.MaxArtifactBytes <= 0 {
		c.MaxArtifactBytes = defaultMaxArtifactBytes
	}
	if c.HTTPTimeoutSec <= 0 {
		c.HTTPTimeoutSec = int(defaultHTTPTimeout / time.Second)
	}
	if c.ClaimIntervalSec <= 0 {
		c.ClaimIntervalSec = int(defaultClaimInterval / time.Second)
	}
	if c.HeartbeatIntervalSec <= 0 {
		c.HeartbeatIntervalSec = int(defaultHeartbeatInterval / time.Second)
	}
	if c.AwaitHeartbeatGraceSec <= 0 {
		c.AwaitHeartbeatGraceSec = int(defaultAwaitHeartbeatGrace / time.Second)
	}
	if c.HelperTimeoutSec <= 0 {
		c.HelperTimeoutSec = int(defaultHelperTimeout / time.Second)
	}
	c.HTTPTimeout = time.Duration(c.HTTPTimeoutSec) * time.Second
	c.ClaimInterval = time.Duration(c.ClaimIntervalSec) * time.Second
	c.HeartbeatInterval = time.Duration(c.HeartbeatIntervalSec) * time.Second
	c.AwaitHeartbeatGrace = time.Duration(c.AwaitHeartbeatGraceSec) * time.Second
	c.HelperTimeout = time.Duration(c.HelperTimeoutSec) * time.Second
	return nil
}
