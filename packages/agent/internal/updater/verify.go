package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Artifact of the release manifest that upgrades the local agent.
const componentAgent = "agent"

var (
	hex40Re = regexp.MustCompile(`^[0-9a-f]{40}$`)
	hex64Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// Version line emitted by `-version`: Value+Build with Build = full SHA.
	versionLineRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
)

// Manifest is the signed release envelope published by the release pipeline.
type Manifest struct {
	ReleaseID   string             `json:"releaseId"`
	Version     string             `json:"version"`
	BuildID     string             `json:"buildId"`
	Channel     string             `json:"channel"`
	PublishedAt string             `json:"publishedAt"`
	APICompat   APICompatibility   `json:"apiCompatibility"`
	Artifacts   []ManifestArtifact `json:"artifacts"`
	Signature   string             `json:"signature"`
}

// APICompatibility declares which API revisions the release can talk to.
type APICompatibility struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// ManifestArtifact describes one downloadable build product.
type ManifestArtifact struct {
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	URL       string `json:"url"`
	Component string `json:"component,omitempty"`
}

// ParseVersionLine splits the single-line `-version` identity
// "<Value>+<Build>" at the LAST '+': Value may itself contain '+' (semver
// build metadata such as "1.2.0+meta"), and Build is the trailing 40-hex
// release commit. Builds without a trailing full SHA (dev builds) are
// rejected — fail closed.
func ParseVersionLine(line string) (value string, buildID string, err error) {
	line = strings.TrimSpace(line)
	if !versionLineRe.MatchString(line) {
		return "", "", fmt.Errorf("version line %q outside accepted format", line)
	}
	idx := strings.LastIndex(line, "+")
	if idx <= 0 || idx == len(line)-1 {
		return "", "", fmt.Errorf("version line %q has no +<40-hex> build segment", line)
	}
	value, buildID = line[:idx], line[idx+1:]
	if !hex40Re.MatchString(buildID) {
		return "", "", fmt.Errorf("build segment %q in %q is not a 40-hex commit", buildID, line)
	}
	return value, buildID, nil
}

// CanonicalSignedBytes returns the canonical form of the signed manifest with
// the `signature` field removed — the exact bytes the Ed25519 signature covers.
func CanonicalSignedBytes(manifestRaw []byte) ([]byte, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(manifestRaw, &probe); err != nil {
		return nil, fmt.Errorf("manifest is not a JSON object: %w", err)
	}
	delete(probe, "signature")
	stripped, err := json.Marshal(map[string]json.RawMessage(probe))
	if err != nil {
		return nil, fmt.Errorf("stripping signature field: %w", err)
	}
	return CanonicalJSON(stripped)
}

// VerifyManifest checks the signed manifest against the pinned public key and
// validates every field the downloader and the swap rely on. rawKey is the
// base64 encoding of a raw 32-byte Ed25519 public key. It never derives trust
// from the manifest itself.
func VerifyManifest(manifestRaw []byte, rawKey string) (*Manifest, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rawKey))
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("pinned public key is not base64 of %d raw bytes", ed25519.PublicKeySize)
	}

	var m Manifest
	if err := json.Unmarshal(manifestRaw, &m); err != nil {
		return nil, fmt.Errorf("manifest parse: %w", err)
	}

	if m.Signature == "" {
		return nil, fmt.Errorf("manifest has no signature")
	}
	sig, err := base64.StdEncoding.DecodeString(m.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, fmt.Errorf("manifest signature is not base64 of %d raw bytes", ed25519.SignatureSize)
	}

	signedBytes, err := CanonicalSignedBytes(manifestRaw)
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(ed25519.PublicKey(key), signedBytes, sig) {
		return nil, fmt.Errorf("manifest signature verification failed")
	}

	if err := validateManifestFields(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

// ParseManifest parses and validates the manifest fields without requiring a signature verification.
func ParseManifest(manifestRaw []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(manifestRaw, &m); err != nil {
		return nil, fmt.Errorf("manifest parse: %w", err)
	}
	if err := validateManifestFields(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

func validateManifestFields(m *Manifest) error {
	if !hex40Re.MatchString(m.ReleaseID) {
		return fmt.Errorf("releaseId %q is not a full 40-hex git SHA", m.ReleaseID)
	}
	if !hex40Re.MatchString(m.BuildID) {
		return fmt.Errorf("buildId %q is not a full 40-hex git SHA", m.BuildID)
	}
	if m.Version == "" {
		return fmt.Errorf("manifest version is empty")
	}
	if len(m.Artifacts) == 0 {
		return fmt.Errorf("manifest has no artifacts")
	}
	return nil
}

// AgentArtifact returns the linux/amd64 agent artifact (component defaults to
// "agent" when absent), validating its hash fields and URL against the
// hostname allowlist.
func (m *Manifest) AgentArtifact(allowedHosts []string) (*ManifestArtifact, error) {
	if len(allowedHosts) == 0 {
		allowedHosts = DefaultAllowedHosts
	}
	for i := range m.Artifacts {
		a := &m.Artifacts[i]
		if a.Component != "" && a.Component != componentAgent {
			continue
		}
		if a.OS != "linux" || a.Arch != "amd64" {
			continue // other platform entries (component may default to agent)
		}
		if len(a.SHA256) != 64 || !hex64Re.MatchString(a.SHA256) {
			return nil, fmt.Errorf("artifact sha256 %q invalid", a.SHA256)
		}
		if a.Size <= 0 {
			return nil, fmt.Errorf("artifact size %d invalid", a.Size)
		}
		if err := validateArtifactURL(a.URL, allowedHosts); err != nil {
			return nil, err
		}
		return a, nil
	}
	return nil, fmt.Errorf("manifest has no linux/amd64 %s artifact", componentAgent)
}

// DefaultAllowedHosts is the hardcoded download allowlist. Config overrides
// exist only for offline test harnesses and live in root-owned config, never
// in API-controlled data.
var DefaultAllowedHosts = []string{"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}

// validateArtifactURL enforces https-only downloads with no userinfo and no
// explicit port, and an exact-hostname allowlist match (no wildcards, no
// suffix matching).
func validateArtifactURL(raw string, allowed []string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("artifact url unparsable: %w", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("artifact url scheme %q is not https", u.Scheme)
	}
	if u.User != nil {
		return fmt.Errorf("artifact url must not carry userinfo")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("artifact url has no host")
	}
	if u.Port() != "" && u.Port() != "443" {
		return fmt.Errorf("artifact url explicit port %q not allowed", u.Port())
	}
	if strings.ContainsAny(host, "*") {
		return fmt.Errorf("artifact url host must not contain wildcards")
	}
	for _, h := range allowed {
		if host == h {
			return nil
		}
	}
	return fmt.Errorf("artifact url host %q not in allowlist", host)
}

// SHA256Hex returns the lowercase hex SHA-256 of b.
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
