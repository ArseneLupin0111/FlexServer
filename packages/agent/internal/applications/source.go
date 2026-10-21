// Package applications source model: bounded, data-only Compose projection
// for external-control verification and managed dependency planning.
//
// Security invariants (plan §3):
//   - never invokes Compose against inline content; resolution uses the
//     isolated runner, never the raw config;
//   - never follows an untrusted label path; every path component is opened
//     no-follow and anchored by dev/inode before any invocation;
//   - untrusted metadata is bounded UTF-8 without control characters;
//   - unresolved interpolation affecting identity (image), profiles or the
//     dependency graph is rejected, never silently inherited;
//   - reference mechanisms (include/extends/env_file/label_file/provider/
//     build/develop/watch/lifecycle hooks) and unsupported fields fail
//     verification before any mutation; duplicate keys/aliases/extra
//     documents are rejected.
package applications

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// Dependency is one projected depends_on edge with a known condition.
type Dependency struct {
	Condition string `yaml:"condition" json:"condition"`
	// OneShot marks a dependency whose condition requires task completion
	// (service_completed_successfully); lifecycle never races it.
	OneShot bool `yaml:"-" json:"oneShot"`
}

// SourceService is the bounded per-service projection.
type SourceService struct {
	// Image is the declared reference (identity field).
	Image string `yaml:"image" json:"image"`
	// Profiles lists explicit opt-in membership for the service.
	Profiles []string `yaml:"profiles" json:"profiles"`
	// DependsOn is the conditional dependency graph.
	DependsOn map[string]Dependency `yaml:"depends_on" json:"dependsOn"`
	// Replicas is the declared desired count (1..100 when set); zero means
	// unspecified (the operation model decides).
	Replicas int `yaml:"-" json:"replicas,omitempty"`
	// Healthcheck marks a declared healthcheck on the service. Readiness of
	// the service itself derives from this fact alone; dependency edge
	// conditions live in DependsOn and never redefine a service's own.
	Healthcheck bool `yaml:"-" json:"healthcheck,omitempty"`
	// RestartNo signals restart:no (treated as a one-shot candidate only
	// together with explicit operation classification, never inferred).
	RestartNo bool `yaml:"-" json:"restartNo,omitempty"`
}

// SourceAnchor pins the verified external file identity: device/inode plus a
// content digest. Runtime mutation re-checks all three.
type SourceAnchor struct {
	Path   string `json:"path"`
	Dev    uint64 `json:"dev"`
	Ino    uint64 `json:"ino"`
	Size   int64  `json:"size"`
	Mode   uint32 `json:"mode"`
	Digest string `json:"digest"`
}

// VerifiedSource is the safe result of one verification pass.
type VerifiedSource struct {
	Digest   string                   `json:"digest"`
	Project  string                   `json:"project,omitempty"`
	Services map[string]SourceService `json:"services"`
	Order    []string                 `json:"order"`
	Anchor   *SourceAnchor            `json:"anchor,omitempty"`
}

const (
	maxSourceBytes   = 256 * 1024
	maxServices      = 64
	maxProfilesPerSv = 16
	maxProfileBytes  = 64
	maxImageBytes    = 512
	maxServiceBytes  = 128
)

// ReadSourceHttpsless isn't needed: the module only reads local files.

// ReadSource never invokes Compose or follows an untrusted label path: the
// caller supplies an explicitly consented path; every ancestor must be a
// non-symlink directory, and the file must be anchored. The returned source
// includes an anchor that must be rechecked before any mutation.
func ReadSource(path string) (*VerifiedSource, error) {
	f, err := secureOpenNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("unsafe_source_path")
	}
	if !modeOwnerWritable(info) {
		return nil, fmt.Errorf("unsafe_source_permissions")
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxSourceBytes+1))
	if err != nil || len(raw) > maxSourceBytes {
		return nil, fmt.Errorf("source_too_large")
	}
	digest := sha256.Sum256(raw)
 	st,sterr := fstatLinux(f)
 	if sterr != nil {
 		return nil, sterr
 	}
	anchor := &SourceAnchor{
		Path: path, Dev: st.dev, Ino: st.ino,
		Size: info.Size(), Mode: uint32(info.Mode()), Digest: hex.EncodeToString(digest[:]),
	}
	vs, err := ParseSource(raw)
	if err != nil {
		return nil, err
	}
	vs.Anchor = anchor
	return vs, nil
}

// RecheckSource re-opens the anchored file and proves dev/inode/type and
// digest still pinned; otherwise the binding is drifted and the caller must
// refuse to mutate.
func RecheckSource(a SourceAnchor) (*VerifiedSource, error) {
	if a.Path == "" || a.Digest == "" {
		return nil, fmt.Errorf("invalid_anchor")
	}
	vs, err := ReadSource(a.Path)
	if err != nil {
		return nil, err
	}
	if vs.Anchor == nil || vs.Anchor.Dev != a.Dev || vs.Anchor.Ino != a.Ino || vs.Anchor.Digest != a.Digest || vs.Anchor.Size != a.Size {
		return nil, fmt.Errorf("source_drift")
	}
	return vs, nil
}

// ParseSource projects the bounded Compose model without evaluation.
func ParseSource(raw []byte) (*VerifiedSource, error) {
	var root yaml.Node
	decoder := yaml.NewDecoder(strings.NewReader(string(raw)))
	if err := decoder.Decode(&root); err != nil {
		return nil, fmt.Errorf("invalid_source")
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("multiple_documents")
	}
	var walk func(*yaml.Node, int) error
	walk = func(n *yaml.Node, depth int) error {
        if depth > 32 || n.Kind == yaml.AliasNode || (strings.HasPrefix(n.Tag, "!") && !strings.HasPrefix(n.Tag, "!!")) {
			return fmt.Errorf("unsupported_yaml")
		}
		if n.Kind == yaml.MappingNode {
			seen := map[string]bool{}
			for i := 0; i < len(n.Content); i += 2 {
				k := n.Content[i].Value
				if seen[k] || k == "<<" {
					return fmt.Errorf("duplicate_key")
				}
				seen[k] = true
			}
		}
		for _, c := range n.Content {
			if err := walk(c, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(&root, 0); err != nil {
		return nil, err
	}
	var model map[string]interface{}
	if err := root.Decode(&model); err != nil {
		return nil, fmt.Errorf("invalid_source")
	}
	for _, key := range []string{"include", "extends"} {
		if _, ok := model[key]; ok {
			return nil, fmt.Errorf("unsupported_source_reference")
		}
	}
	services, ok := model["services"].(map[string]interface{})
	if !ok || len(services) == 0 || len(services) > maxServices {
		return nil, fmt.Errorf("invalid_services")
	}
	result := &VerifiedSource{Services: map[string]SourceService{}, Order: []string{}}
	for name, rawService := range services {
		if !safeMetadata(name, maxServiceBytes) {
			return nil, fmt.Errorf("invalid_service")
		}
		service, ok := rawService.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("invalid_service")
		}
		for _, key := range []string{"extends", "env_file", "label_file", "provider", "build", "develop", "post_start", "pre_stop"} {
			if _, ok := service[key]; ok {
				return nil, fmt.Errorf("unsupported_source_reference")
			}
		}
		projected := SourceService{DependsOn: map[string]Dependency{}, Profiles: []string{}}
		if image, ok := service["image"].(string); ok {
			if strings.Contains(image, "$") || len(image) > maxImageBytes || strings.ContainsAny(image, "\x00\n\r") {
				return nil, fmt.Errorf("unresolved_identity")
			}
			projected.Image = image
		}
		switch profiles := service["profiles"].(type) {
		case []interface{}:
			if len(profiles) > maxProfilesPerSv {
				return nil, fmt.Errorf("too_many_profiles")
			}
			for _, p := range profiles {
				s, ok := p.(string)
				if !ok || !safeMetadata(s, maxProfileBytes) || strings.Contains(s, "$") {
					return nil, fmt.Errorf("invalid_profile")
				}
				projected.Profiles = append(projected.Profiles, s)
			}
		case nil:
		default:
			return nil, fmt.Errorf("invalid_profile")
		}
		switch deps := service["depends_on"].(type) {
		case []interface{}:
			for _, d := range deps {
				s, ok := d.(string)
				if !ok || strings.Contains(s, "$") {
					return nil, fmt.Errorf("invalid_dependency")
				}
				projected.DependsOn[s] = Dependency{Condition: "service_started"}
			}
		case map[string]interface{}:
			for dep, v := range deps {
				if strings.Contains(dep, "$") {
					return nil, fmt.Errorf("unresolved_dependency")
				}
				m, ok := v.(map[string]interface{})
				if !ok {
					return nil, fmt.Errorf("invalid_dependency")
				}
				condition, _ := m["condition"].(string)
				if condition == "" {
					condition = "service_started"
				}
				if condition != "service_started" && condition != "service_healthy" && condition != "service_completed_successfully" {
					return nil, fmt.Errorf("unsupported_dependency")
				}
				projected.DependsOn[dep] = Dependency{Condition: condition, OneShot: condition == "service_completed_successfully"}
			}
		case nil:
		default:
			return nil, fmt.Errorf("invalid_dependency")
		}
		if deploy, ok := service["deploy"].(map[string]interface{}); ok {
			if replicas, ok := deploy["replicas"].(int); ok && replicas > 0 && replicas <= 100 {
				projected.Replicas = replicas
			} else if _, present := deploy["replicas"]; present {
				return nil, fmt.Errorf("invalid_replicas")
			}
			for _, k := range []string{"placement", "update_config", "rollback_config", "restart_policy"} {
				if _, ok := deploy[k]; ok {
					return nil, fmt.Errorf("unsupported_field:deploy." + k)
				}
			}
		} else if _, present := service["deploy"]; present {
			return nil, fmt.Errorf("invalid_deploy")
		}
		if service["healthcheck"] != nil {
			if hc, ok := service["healthcheck"].(map[string]interface{}); !ok {
				return nil, fmt.Errorf("invalid_healthcheck")
			} else if strings.ContainsAny(hcString(hc, "test"), "$") {
				return nil, fmt.Errorf("unresolved_healthcheck")
			}
			projected.Healthcheck = true
		}
		if noRestart(service) {
			projected.RestartNo = true
		}
		result.Services[name] = projected
	}
	if err := orderGraph(result); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	result.Digest = hex.EncodeToString(sum[:])
	return result, nil
}

func hcString(hc map[string]interface{}, key string) string {
	if v, ok := hc[key].(string); ok {
		return v
	}
	if v, ok := hc[key].([]interface{}); ok && len(v) > 0 {
		if s, ok := v[0].(string); ok {
			return s
		}
	}
	return ""
}

func noRestart(service map[string]interface{}) bool {
	r, ok := service["restart"].(string)
	return ok && r == "no"
}

func orderGraph(result *VerifiedSource) error {
	visiting := map[string]bool{}
	visited := map[string]bool{}
	var order func(string) error
	order = func(name string) error {
		if visiting[name] {
			return fmt.Errorf("dependency_cycle")
		}
		if visited[name] {
			return nil
		}
		s, ok := result.Services[name]
		if !ok {
			return fmt.Errorf("missing_dependency")
		}
		visiting[name] = true
		for dep := range s.DependsOn {
			if err := order(dep); err != nil {
				return err
			}
		}
		visiting[name] = false
		visited[name] = true
		result.Order = append(result.Order, name)
		return nil
	}
	for name := range result.Services {
		if err := order(name); err != nil {
			return err
		}
	}
	return nil
}

// safeMetadata validates bounded one-line service/project identifiers.
func safeMetadata(s string, max int) bool {
	if len(s) == 0 || len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == '/' {
			return false
		}
	}
	return true
}
