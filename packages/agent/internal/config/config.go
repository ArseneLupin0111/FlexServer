package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Config holds agent configuration loaded from a JSON file.
type Config struct {
	BackendUrl            string `json:"backendUrl"`
	VpsId                 string `json:"vpsId"`
	Token                 string `json:"token"`
	IntervalSeconds       int    `json:"intervalSeconds"`
	RequestTimeoutSeconds int    `json:"requestTimeoutSeconds"`
	StatePath             string   `json:"statePath,omitempty"`
	AI                    AIConfig `json:"ai"`
}

// AIConfig holds configuration for the isolated AI worker subsystem.
// Zero-value means AI is disabled (default-off).
type AIConfig struct {
	Enabled            bool   `json:"enabled"`
	ExecutionUID       int    `json:"executionUid"`
	ExecutionGID       int    `json:"executionGid"`
	HelperSocketPath   string `json:"helperSocketPath"`
	ExecutorPath       string `json:"executorPath"`
	ScratchRootPath    string `json:"scratchRootPath"`
	StatePath          string `json:"statePath"`
	RootfsDirPath      string `json:"rootfsDirPath"`
	RootfsManifestPath string `json:"rootfsManifestPath"`
	ProfilesDirPath    string `json:"profilesDirPath"`
	MaxConcurrentTasks int    `json:"maxConcurrentTasks"`
	ExecuteTokenFile   string `json:"executeTokenFile"`
}

// Load reads and validates a config file from the given path.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// Validate checks all config fields for correctness.
func (c *Config) Validate() error {
	if c.BackendUrl == "" {
		return fmt.Errorf("backendUrl is required")
	}
	u, err := url.Parse(c.BackendUrl)
	if err != nil || !u.IsAbs() {
		return fmt.Errorf("backendUrl must be a valid absolute URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("backendUrl scheme must be http or https, got %q", u.Scheme)
	}
	if u.Scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return fmt.Errorf("backendUrl must use https (http is only allowed for loopback, got %q)", u.Host)
	}

	if c.VpsId == "" {
		return fmt.Errorf("vpsId is required")
	}
	if c.Token == "" {
		return fmt.Errorf("token is required")
	}
	if c.IntervalSeconds < 1 {
		return fmt.Errorf("intervalSeconds must be >= 1")
	}
	if c.RequestTimeoutSeconds <= 0 {
		return fmt.Errorf("requestTimeoutSeconds must be > 0")
	}

	// Normalize: strip trailing slash so path joining is clean
	c.BackendUrl = strings.TrimRight(c.BackendUrl, "/")
	if c.AI.Enabled {
		if c.AI.ExecutionUID <= 0 {
			return fmt.Errorf("ai executionUid must be > 0")
		}
		if c.AI.ExecutionGID <= 0 {
			return fmt.Errorf("ai executionGid must be > 0")
		}
		if c.AI.HelperSocketPath == "" {
			return fmt.Errorf("ai helperSocketPath is required")
		}
		if c.AI.ExecutorPath == "" {
			return fmt.Errorf("ai executorPath is required")
		}
		if c.AI.ScratchRootPath == "" {
			return fmt.Errorf("ai scratchRootPath is required")
		}
		if c.AI.StatePath == "" {
			return fmt.Errorf("ai statePath is required")
		}
		if c.AI.RootfsDirPath == "" {
			return fmt.Errorf("ai rootfsDirPath is required")
		}
		if c.AI.RootfsManifestPath == "" {
			return fmt.Errorf("ai rootfsManifestPath is required")
		}
		if c.AI.ProfilesDirPath == "" {
			return fmt.Errorf("ai profilesDirPath is required")
		}
		if c.AI.MaxConcurrentTasks < 1 {
			return fmt.Errorf("ai maxConcurrentTasks must be >= 1")
		}
	}

	return nil
}

// isLoopbackHost reports whether host is a loopback name or literal; only
// these may use a plain http backendUrl (local development / same-host
// deployments). Everything else must be https.
func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// String returns a sanitized representation that never includes the token.
func (c *Config) String() string {
	return fmt.Sprintf(
		"Config{BackendUrl: %s, VpsId: %s, Token: [redacted], IntervalSeconds: %d, RequestTimeoutSeconds: %d, AIEnabled: %t}",
		c.BackendUrl, c.VpsId, c.IntervalSeconds, c.RequestTimeoutSeconds, c.AI.Enabled,
	)
}
