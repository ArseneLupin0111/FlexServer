package ai

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var (
	ErrProfileNotFound    = errors.New("service profile not found")
	ErrActionNotPermitted = errors.New("action not permitted by service profile")
	ErrConfigPathDenied   = errors.New("config path not permitted by service profile")
	ErrDangerousDirective = errors.New("config contains forbidden dangerous directive")
)

// ServiceProfile defines the root-owned, strict execution policy for a service.
type ServiceProfile struct {
	ID                 string            `json:"id"`
	Version            int               `json:"version"`
	ServiceUnit        string            `json:"serviceUnit"`
	AllowedActions     []string          `json:"allowedActions"`
	AllowedConfigPaths []string          `json:"allowedConfigPaths"`
	ValidatorExec      string            `json:"validatorExec"`
	ValidatorArgv      []string          `json:"validatorArgv"`
	HealthCheckCmd     []string          `json:"healthCheckCmd"`
	HealthTimeoutSec   int               `json:"healthTimeoutSec"`
	Env                map[string]string `json:"env,omitempty"`
}

// DefaultNginxProfile returns the built-in canonical nginx profile.
func DefaultNginxProfile() *ServiceProfile {
	return &ServiceProfile{
		ID:          "nginx",
		Version:     1,
		ServiceUnit: "nginx.service",
		AllowedActions: []string{
			"status",
			"start",
			"restart",
			"reload",
		},
		AllowedConfigPaths: []string{
			"/etc/nginx/nginx.conf",
			"/etc/nginx/conf.d/*.conf",
			"/etc/nginx/sites-available/*",
			"/etc/nginx/sites-enabled/*",
		},
		ValidatorExec:    "/usr/sbin/nginx",
		ValidatorArgv:    []string{"-t", "-c"},
		HealthCheckCmd:   []string{"/usr/sbin/nginx", "-t"},
		HealthTimeoutSec: 10,
	}
}

// ProfileRegistry manages loaded service profiles.
type ProfileRegistry struct {
	profiles map[string]*ServiceProfile
}

// NewProfileRegistry creates an empty ProfileRegistry.
func NewProfileRegistry() *ProfileRegistry {
	return &ProfileRegistry{
		profiles: make(map[string]*ServiceProfile),
	}
}

// Register adds a profile to the registry.
func (r *ProfileRegistry) Register(p *ServiceProfile) {
	if p != nil && p.ID != "" {
		r.profiles[p.ID] = p
	}
}

// LoadProfileRegistry loads profiles from the specified root-owned directory.
// Requires explicit root ownership and non-writable permissions.
// No default privileged profiles are seeded without explicit root-owned files.
func LoadProfileRegistry(dir string) (*ProfileRegistry, error) {
	reg := NewProfileRegistry()

	if dir == "" {
		return reg, nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return reg, nil
		}
		return nil, fmt.Errorf("reading profiles directory: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		st, err := os.Lstat(path)
		if err != nil {
			return nil, fmt.Errorf("stat profile file %s: %w", path, err)
		}
		if !st.Mode().IsRegular() {
			return nil, fmt.Errorf("profile file %s is not a regular file", path)
		}
		if err := verifyProfileOwnership(st); err != nil {
			return nil, fmt.Errorf("profile file %s ownership check: %w", path, err)
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("reading profile %s: %w", path, err)
		}
		var p ServiceProfile
		if err := json.Unmarshal(data, &p); err != nil {
			return nil, fmt.Errorf("parsing profile %s: %w", path, err)
		}
		if p.ID == "" || p.ServiceUnit == "" {
			return nil, fmt.Errorf("profile %s missing required id or serviceUnit", path)
		}
		reg.profiles[p.ID] = &p
	}

	return reg, nil
}
// List returns all registered profile IDs in sorted order.
func (r *ProfileRegistry) List() []string {
	ids := make([]string, 0, len(r.profiles))
	for id := range r.profiles {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Get returns the profile by ID.
func (r *ProfileRegistry) Get(profileID string) (*ServiceProfile, error) {
	p, ok := r.profiles[profileID]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrProfileNotFound, profileID)
	}
	return p, nil
}

// ValidateAction ensures the requested action is explicitly permitted.
func (p *ServiceProfile) ValidateAction(action string) error {
	actLower := strings.ToLower(strings.TrimSpace(action))
	if actLower == "stop" || actLower == "disable" || actLower == "mask" {
		return fmt.Errorf("%w: action %q is explicitly forbidden by safety policy", ErrActionNotPermitted, action)
	}
	for _, a := range p.AllowedActions {
		if a == actLower {
			return nil
		}
	}
	return fmt.Errorf("%w: action %q on profile %q", ErrActionNotPermitted, action, p.ID)
}

// ValidateConfigPath checks if targetPath matches any allowed pattern for this profile.
func (p *ServiceProfile) ValidateConfigPath(targetPath string) error {
	cleanPath := filepath.Clean(targetPath)
	if IsProtectedPath(cleanPath) {
		return fmt.Errorf("%w: %s is a protected path", ErrConfigPathDenied, cleanPath)
	}

	for _, pattern := range p.AllowedConfigPaths {
		cleanPattern := filepath.Clean(pattern)
		// Check direct equality
		if cleanPath == cleanPattern {
			return nil
		}
		// Check glob match
		if matched, err := filepath.Match(cleanPattern, cleanPath); err == nil && matched {
			return nil
		}
	}
	return fmt.Errorf("%w: %s does not match allowed paths for profile %s", ErrConfigPathDenied, cleanPath, p.ID)
}

// ValidateConfigContent inspects configuration text for dangerous directives.
// For example, in nginx configs, prevents loading arbitrary modules or running scripts.
func (p *ServiceProfile) ValidateConfigContent(content string) error {
	if p.ID == "nginx" {
		dangerousNginxDirectives := []string{
			"load_module",
			"perl_require",
			"perl_modules",
			"lua_package_path",
			"lua_package_cpath",
			"access_by_lua_block",
			"content_by_lua_block",
		}
		lower := strings.ToLower(content)
		for _, directive := range dangerousNginxDirectives {
			if strings.Contains(lower, directive) {
				return fmt.Errorf("%w: nginx directive %q is forbidden in managed configs", ErrDangerousDirective, directive)
			}
		}
	}
	return nil
}
