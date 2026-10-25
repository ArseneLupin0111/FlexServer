package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
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

// CompareSemver compares two semver strings (v1, v2).
// Returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2.
func CompareSemver(v1, v2 string) int {
	v1 = strings.TrimPrefix(v1, "v")
	v2 = strings.TrimPrefix(v2, "v")

	base1 := v1
	if idx := strings.IndexAny(base1, "-+"); idx != -1 {
		base1 = base1[:idx]
	}
	base2 := v2
	if idx := strings.IndexAny(base2, "-+"); idx != -1 {
		base2 = base2[:idx]
	}

	p1 := strings.Split(base1, ".")
	p2 := strings.Split(base2, ".")

	maxLen := len(p1)
	if len(p2) > maxLen {
		maxLen = len(p2)
	}
	for i := 0; i < maxLen; i++ {
		s1 := "0"
		if i < len(p1) {
			s1 = p1[i]
		}
		s2 := "0"
		if i < len(p2) {
			s2 = p2[i]
		}
		n1, err1 := strconv.Atoi(s1)
		n2, err2 := strconv.Atoi(s2)
		if err1 == nil && err2 == nil {
			if n1 < n2 {
				return -1
			}
			if n1 > n2 {
				return 1
			}
		} else {
			if s1 < s2 {
				return -1
			}
			if s1 > s2 {
				return 1
			}
		}
	}
	return 0
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

// FleetReleaseEnvelope represents the signed manifest envelope:
// { payload: "<UTF8 JSON string>", signature: "<base64 Ed25519>", keyId: "<keyId>" }.
type FleetReleaseEnvelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
	KeyID     string `json:"keyId,omitempty"`
}

// FleetArtifact describes one component build artifact.
type FleetArtifact struct {
	Component string `json:"component"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	File      string `json:"file,omitempty"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
	Version   string `json:"version"`
}

// FleetAIInfo describes AI compatibility in the manifest.
type FleetAIInfo struct {
	Version    string   `json:"version"`
	Components []string `json:"components"`
}

// FleetManifestPayload is the verified payload extracted from the signed envelope.
type FleetManifestPayload struct {
	SchemaVersion     int             `json:"schemaVersion"`
	ReleaseID         string          `json:"releaseId"`
	BuildID           string          `json:"buildId"`
	Version           string          `json:"version"`
	PublishedAt       string          `json:"publishedAt"`
	Channel           string          `json:"channel"`
	RollbackSafe      bool            `json:"rollbackSafe"`
	MinUpdaterVersion string          `json:"minUpdaterVersion,omitempty"`
	UpgradeFrom       []string        `json:"upgradeFrom,omitempty"`
	Artifacts         []FleetArtifact `json:"artifacts"`
	AI                *FleetAIInfo    `json:"ai,omitempty"`
}

// ParseEd25519PublicKeyPEM parses an Ed25519 public key in PEM format (SPKI),
// raw 32-byte Ed25519 PEM block, or standard base64 raw string.
func ParseEd25519PublicKeyPEM(pemBytes []byte) (ed25519.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		raw := strings.TrimSpace(string(pemBytes))
		keyBytes, err := base64.StdEncoding.DecodeString(raw)
		if err == nil && len(keyBytes) == ed25519.PublicKeySize {
			return ed25519.PublicKey(keyBytes), nil
		}
		return nil, errors.New("public key is neither valid PEM nor raw 32-byte base64")
	}

	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err == nil {
		if edPub, ok := pub.(ed25519.PublicKey); ok {
			return edPub, nil
		}
		return nil, fmt.Errorf("public key is not Ed25519: %T", pub)
	}

	if len(block.Bytes) == ed25519.PublicKeySize {
		return ed25519.PublicKey(block.Bytes), nil
	}

	return nil, fmt.Errorf("parsing PKIX public key: %w", err)
}

// LoadPublicKeyPEM reads the public key from the given file path or falls back to
// the environment variable FLEET_RELEASE_PUBLIC_KEY_FILE / default path.
func LoadPublicKeyPEM(path string) ([]byte, error) {
	target := path
	if target == "" {
		target = os.Getenv("FLEET_RELEASE_PUBLIC_KEY_FILE")
	}
	if target == "" {
		target = "/etc/vps-updater/fleet-release.pub"
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return nil, fmt.Errorf("read public key from %s: %w", target, err)
	}
	return data, nil
}

var (
	knownFleetComponents = map[string]bool{
		"agent":          true,
		"updater":        true,
		"ai-executor":    true,
		"ai-host-helper": true,
		"ai-rootfs":      true,
		"ai-profiles":    true,
	}
	// aiInstallRequiredComponents is the complete signed AI set the explicit
	// first-install operation requires for the host platform before anything
	// is downloaded or mutated. A partial set is refused fail-closed.
	aiInstallRequiredComponents = []string{
		"ai-executor",
		"ai-host-helper",
		"ai-rootfs",
		"ai-profiles",
	}
	semverRe = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
)

// VerifyFleetManifest verifies an Ed25519-signed fleet release envelope
// against the given public key PEM bytes. Payload UTF-8 bytes are verified verbatim
// without recanonicalizing.
func VerifyFleetManifest(envelopeRaw []byte, pubKeyPEM []byte) (*FleetManifestPayload, error) {
	var env FleetReleaseEnvelope
	if err := json.Unmarshal(envelopeRaw, &env); err != nil {
		return nil, fmt.Errorf("manifest envelope parse: %w", err)
	}
	if env.Payload == "" {
		return nil, errors.New("manifest envelope missing payload string")
	}
	if env.Signature == "" {
		return nil, errors.New("manifest envelope missing signature string")
	}

	sigBytes, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil {
		sigBytes, err = base64.URLEncoding.DecodeString(env.Signature)
	}
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return nil, fmt.Errorf("invalid manifest signature base64 (must be %d bytes)", ed25519.SignatureSize)
	}

	pubKey, err := ParseEd25519PublicKeyPEM(pubKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse public key: %w", err)
	}

	// EXACT UTF-8 bytes of payload - never recanonicalize
	payloadBytes := []byte(env.Payload)
	if !ed25519.Verify(pubKey, payloadBytes, sigBytes) {
		return nil, errors.New("fleet release manifest signature verification failed")
	}

	var payload FleetManifestPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, fmt.Errorf("fleet manifest payload parse: %w", err)
	}

	if payload.SchemaVersion != 1 {
		return nil, fmt.Errorf("unsupported manifest schemaVersion %d (must be 1)", payload.SchemaVersion)
	}
	if payload.Channel != "stable" {
		return nil, fmt.Errorf("unsupported manifest channel %q (must be stable)", payload.Channel)
	}
	if !hex40Re.MatchString(payload.ReleaseID) {
		return nil, fmt.Errorf("invalid releaseId %q (must be 40-hex commit)", payload.ReleaseID)
	}
	if !hex40Re.MatchString(payload.BuildID) {
		return nil, fmt.Errorf("invalid buildId %q (must be 40-hex commit)", payload.BuildID)
	}
	if payload.ReleaseID != payload.BuildID {
		return nil, fmt.Errorf("releaseId %s does not match buildId %s", payload.ReleaseID, payload.BuildID)
	}
	if !semverRe.MatchString(payload.Version) {
		return nil, fmt.Errorf("invalid version format: %q", payload.Version)
	}
	if len(payload.Artifacts) == 0 {
		return nil, errors.New("fleet manifest contains no artifacts")
	}

	for i, a := range payload.Artifacts {
		if !knownFleetComponents[a.Component] {
			return nil, fmt.Errorf("artifact %d has unknown component %q", i, a.Component)
		}
		if a.OS != "linux" {
			return nil, fmt.Errorf("artifact %d has unsupported OS %q", i, a.OS)
		}
		if a.Arch != "amd64" && a.Arch != "arm64" {
			return nil, fmt.Errorf("artifact %d has unsupported arch %q", i, a.Arch)
		}
		if !hex64Re.MatchString(a.SHA256) {
			return nil, fmt.Errorf("artifact %d sha256 %q invalid", i, a.SHA256)
		}
		if a.Size <= 0 {
			return nil, fmt.Errorf("artifact %d size %d must be > 0", i, a.Size)
		}
		if err := validateArtifactURL(a.URL, DefaultAllowedHosts); err != nil {
			return nil, fmt.Errorf("artifact %d url invalid: %w", i, err)
		}
	}

	return &payload, nil
}

// VerifyFleetEnvelopeFile loads and verifies a manifest file from disk against a public key file.
func VerifyFleetEnvelopeFile(manifestPath, pubKeyPath string) (*FleetManifestPayload, error) {
	manifestRaw, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("read manifest file %s: %w", manifestPath, err)
	}
	pubKeyPEM, err := LoadPublicKeyPEM(pubKeyPath)
	if err != nil {
		return nil, err
	}
	return VerifyFleetManifest(manifestRaw, pubKeyPEM)
}

// FindArtifact returns the matching artifact for component, os, and arch, or nil.
func (p *FleetManifestPayload) FindArtifact(component, osName, arch string) *FleetArtifact {
	for i := range p.Artifacts {
		a := &p.Artifacts[i]
		if a.Component == component && a.OS == osName && a.Arch == arch {
			return a
		}
	}
	return nil
}
