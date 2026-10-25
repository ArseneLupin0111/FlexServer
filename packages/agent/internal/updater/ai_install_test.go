package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ── AI first-install (kind "ai-install") helper tests ────────────────────
//
// Offline equivalents of the release pipeline's ai-rootfs bundle layout
// (.github/workflows/fleet-release.yml): the tarball carries rootfs/ plus a
// sibling manifest.json, profiles ship as a profiles/-rooted tarball. The
// privileged helper must provision the fixed AI directories, install the
// sibling manifest at the fixed canonical path, write the unit and merge the
// agent config — and fail closed on a missing manifest or a planted symlink.

const aiTestUID = 54321
const aiTestGID = 54322

func buildTarGz(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, content := range entries {
		hdr := &tar.Header{Name: name, Mode: 0o755, Typeflag: tar.TypeDir}
		if content != "" {
			hdr.Mode = 0o644
			hdr.Size = int64(len(content))
			hdr.Typeflag = tar.TypeReg
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("write header %s: %v", name, err)
		}
		if content != "" {
			if _, err := tw.Write([]byte(content)); err != nil {
				t.Fatalf("write content %s: %v", name, err)
			}
		}
	}
	tw.Close()
	gw.Close()
	return buf.Bytes()
}

func sha256Bytes(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// aiInstallFixture assembles the full offline ai-install scenario: signed
// AI-only manifest (linux/amd64, the four components), staged artifacts, an
// apply-spec pinned to canonical targets under a test provision root, and the
// process/systemd/identity seams a Windows CI host cannot provide.
type aiInstallFixture struct {
	cfg         *Config
	provision   string
	aiP         aiProvisionPaths
	agentConfig string
	staging     string
	jobID       string
	apiJob      *ClaimedJob
	rootfsTar   []byte
	spec        ApplySpec
}

func newAIInstallFixture(t *testing.T, includeRootfsManifest bool) *aiInstallFixture {
	t.Helper()
	_, priv, pemBytes := generateTestEd25519Key(t)
	buildID := "fedcba9876543210fedcba9876543210fedcba98"

	tmp := t.TempDir()
	provision := filepath.Join(tmp, "provision")
	staging := filepath.Join(tmp, "staging")
	stateDir := filepath.Join(tmp, "state")
	for _, d := range []string{staging, stateDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	agentConfig := filepath.Join(tmp, "agent-config.json")
	if err := os.WriteFile(agentConfig, []byte("{\n  \"vpsId\": \"vps-ai-test\",\n  \"server\": { \"port\": 8080 }\n}\n"), 0o644); err != nil {
		t.Fatalf("write agent config: %v", err)
	}

	cfg := &Config{
		StateDir:    stateDir,
		AgentBinary: filepath.Join(tmp, "agent"),
		AgentConfig: agentConfig,
		AgentUnit:   "vps-manager-agent.service",
	}
	cfg.EnableTestOverrides()
	cfg.SetTestFleetPublicKeyPEM(pemBytes)
	cfg.SetTestAIProvisionRoot(provision)
	cfg.SetTestLockDir(filepath.Join(tmp, "lock"))

	aiP := aiPaths(cfg)
	cfg.SetTestCanonicalTarget("ai-executor", filepath.Join(tmp, "sbin", "ai-executor"))
	cfg.SetTestCanonicalTarget("ai-host-helper", filepath.Join(tmp, "sbin", "ai-host-helper"))
	cfg.SetTestCanonicalTarget("ai-rootfs", aiP.RootfsDir)
	cfg.SetTestCanonicalTarget("ai-profiles", aiP.ProfilesDir)

	executorBin := []byte("executor-binary-content")
	helperBin := []byte("host-helper-binary-content")
	rootfsEntries := map[string]string{
		"rootfs/":            "",
		"rootfs/bin/":        "",
		"rootfs/bin/busybox": "busybox-payload",
		"rootfs/etc/":        "",
	}
	if includeRootfsManifest {
		rootfsEntries["manifest.json"] = `{"version":1,"rootfsSha256":"` + strings.Repeat("ab", 32) + `","files":[]}`
	}
	rootfsTar := buildTarGz(t, rootfsEntries)
	profilesTar := buildTarGz(t, map[string]string{
		"profiles/":             "",
		"profiles/default.json": `{"name":"default"}`,
	})

	type stagedFile struct {
		name      string
		component string
		content   []byte
	}
	files := []stagedFile{
		{"ai-executor", "ai-executor", executorBin},
		{"ai-host-helper", "ai-host-helper", helperBin},
		{"ai-rootfs.tar.gz", "ai-rootfs", rootfsTar},
		{"ai-profiles.tar.gz", "ai-profiles", profilesTar},
	}
	artifacts := make([]FleetArtifact, 0, len(files))
	specComponents := make([]ComponentApplySpec, 0, len(files))
	for _, f := range files {
		sha := sha256Bytes(f.content)
		src := filepath.Join(staging, f.name)
		if err := os.WriteFile(src, f.content, 0o644); err != nil {
			t.Fatalf("write staged %s: %v", f.name, err)
		}
		var target string
		isTar := false
		strip := ""
		switch f.component {
		case "ai-executor":
			target, _ = cfg.CanonicalTarget("ai-executor")
		case "ai-host-helper":
			target, _ = cfg.CanonicalTarget("ai-host-helper")
		case "ai-rootfs":
			target, _ = cfg.CanonicalTarget("ai-rootfs")
			isTar, strip = true, "rootfs"
		case "ai-profiles":
			target, _ = cfg.CanonicalTarget("ai-profiles")
			isTar, strip = true, "profiles"
		}
		artifacts = append(artifacts, FleetArtifact{
			Component: f.component,
			OS:        "linux",
			Arch:      "amd64",
			URL:       "https://github.com/example/fleet/releases/download/x/" + f.name,
			SHA256:    sha,
			Size:      int64(len(f.content)),
			Version:   "2.0.0",
		})
		specComponents = append(specComponents, ComponentApplySpec{
			Component:   f.component,
			SourcePath:  src,
			TargetPath:  target,
			SHA256:      sha,
			Size:        int64(len(f.content)),
			IsTar:       isTar,
			StripPrefix: strip,
		})
	}

	payload := FleetManifestPayload{
		SchemaVersion: 1,
		ReleaseID:     buildID,
		BuildID:       buildID,
		Version:       "2.0.0",
		PublishedAt:   "2026-10-25T00:00:00Z",
		Channel:       "stable",
		RollbackSafe:  true,
		Artifacts:     artifacts,
	}
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	envelopeRaw, err := json.Marshal(FleetReleaseEnvelope{
		Payload:   string(rawPayload),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, rawPayload)),
		KeyID:     "ai-test-key",
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}

	jobID := "ai-install-job-1"
	spec := ApplySpec{JobID: jobID, ReleaseID: buildID, BuildID: buildID, Components: specComponents}
	specBytes, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staging, "apply-spec.json"), specBytes, 0o644); err != nil {
		t.Fatalf("write apply-spec: %v", err)
	}

	apiJob := &ClaimedJob{
		JobID:           jobID,
		Kind:            JobKindAIInstall,
		Phase:           PhaseRestarting,
		State:           "staging",
		ManifestRaw:     string(envelopeRaw),
		LeaseExpiresAt:  FlexTime{Time: time.Now().Add(10 * time.Minute)},
		PhaseDeadlineAt: FlexTime{Time: time.Now().Add(10 * time.Minute)},
		DeadlineAt:      FlexTime{Time: time.Now().Add(10 * time.Minute)},
		Release:         ReleaseInfo{ReleaseID: buildID, BuildID: buildID},
	}

	return &aiInstallFixture{
		cfg:         cfg,
		provision:   provision,
		aiP:         aiP,
		agentConfig: agentConfig,
		staging:     staging,
		jobID:       jobID,
		apiJob:      apiJob,
		rootfsTar:   rootfsTar,
		spec:        spec,
	}
}

// installAISeams fakes everything the privileged helper would find on a real
// Linux host: fixed uid/gid identity, no-op systemd, linux/amd64 platform.
func installAISeams(t *testing.T) {
	t.Helper()
	oldPlatform := hostPlatform
	oldSystemctl := runSystemctl
	oldLookupGroup, oldLookupUser := lookupAIGroup, lookupAIUser
	oldCreateGroup, oldCreateUser := createAIGroup, createAIUser
	hostPlatform = func() (string, string) { return "linux", "amd64" }
	runSystemctl = func(_ context.Context, _ ...string) (string, error) { return "", nil }
	lookupAIGroup = func(string) (int, bool, error) { return aiTestGID, true, nil }
	lookupAIUser = func(string) (int, bool, error) { return aiTestUID, true, nil }
	createAIGroup = func(context.Context) error { return nil }
	createAIUser = func(context.Context, int) error { return nil }
	t.Cleanup(func() {
		hostPlatform = oldPlatform
		runSystemctl = oldSystemctl
		lookupAIGroup, lookupAIUser = oldLookupGroup, oldLookupUser
		createAIGroup, createAIUser = oldCreateGroup, oldCreateUser
	})
}

// TestHelperAIInstallComplete: the full happy path — provisioning, rootfs
// extraction WITH the sibling manifest installed at the fixed canonical path,
// unit file, agent-config merge preserving unrelated fields, binaries
// installed, outcome "restarted".
func TestHelperAIInstallComplete(t *testing.T) {
	f := newAIInstallFixture(t, true)
	installAISeams(t)

	res := &HelperResult{JobID: f.jobID, Action: actionApply}
	auth := &testJobAuthorizer{job: f.apiJob}
	applyRes := handleApplyFleet(context.Background(), f.cfg, auth, f.apiJob, f.jobID, f.staging, res)
	if applyRes.Outcome != "restarted" {
		t.Fatalf("expected outcome 'restarted', got %q (%s)", applyRes.Outcome, applyRes.Detail)
	}

	// Rootfs extracted from the signed tarball.
	busybox, err := os.ReadFile(filepath.Join(f.aiP.RootfsDir, "bin", "busybox"))
	if err != nil || string(busybox) != "busybox-payload" {
		t.Fatalf("rootfs not extracted correctly: %q, %v", string(busybox), err)
	}
	// Sibling manifest installed at the fixed canonical path.
	manifestRaw, err := os.ReadFile(f.aiP.RootfsManifest)
	if err != nil {
		t.Fatalf("rootfs manifest missing at %s: %v", f.aiP.RootfsManifest, err)
	}
	if !strings.Contains(string(manifestRaw), `"rootfsSha256"`) {
		t.Fatalf("rootfs manifest content wrong: %s", string(manifestRaw))
	}
	// Profiles extracted.
	if _, err := os.Stat(filepath.Join(f.aiP.ProfilesDir, "default.json")); err != nil {
		t.Fatalf("profiles not extracted: %v", err)
	}
	// Binaries installed at their canonical targets.
	execTarget, _ := f.cfg.CanonicalTarget("ai-executor")
	execContent, err := os.ReadFile(execTarget)
	if err != nil || string(execContent) != "executor-binary-content" {
		t.Fatalf("ai-executor not installed: %v", err)
	}
	// Fixed unit file written.
	if _, err := os.Stat(f.aiP.HelperUnit); err != nil {
		t.Fatalf("ai helper unit missing: %v", err)
	}
	// Agent config merged: ai block present AND unrelated fields preserved.
	cfgRaw, err := os.ReadFile(f.agentConfig)
	if err != nil {
		t.Fatalf("read agent config: %v", err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(cfgRaw, &doc); err != nil {
		t.Fatalf("parse merged agent config: %v (%s)", err, string(cfgRaw))
	}
	if _, ok := doc["ai"]; !ok {
		t.Fatalf("merged agent config has no ai block: %s", string(cfgRaw))
	}
	if _, ok := doc["server"]; !ok {
		t.Fatalf("merged agent config dropped unrelated server block: %s", string(cfgRaw))
	}
	var aiBlock map[string]any
	if err := json.Unmarshal(doc["ai"], &aiBlock); err != nil {
		t.Fatalf("parse ai block: %v", err)
	}
	if aiBlock["executionUid"] != float64(aiTestUID) || aiBlock["rootfsManifestPath"] != f.aiP.RootfsManifest {
		t.Fatalf("ai block wrong: %#v", aiBlock)
	}
}

// TestHelperAIInstallRequiresRootfsManifest: a signed ai-rootfs tarball
// without the sibling manifest must fail closed and roll back — never leave
// a half-installed runtime whose sandbox verification can never pass.
func TestHelperAIInstallRequiresRootfsManifest(t *testing.T) {
	f := newAIInstallFixture(t, false)
	installAISeams(t)

	res := &HelperResult{JobID: f.jobID, Action: actionApply}
	auth := &testJobAuthorizer{job: f.apiJob}
	applyRes := handleApplyFleet(context.Background(), f.cfg, auth, f.apiJob, f.jobID, f.staging, res)
	// The failure happens mid-mutation, so the helper reports the auto
	// rollback outcome with the original cause preserved in the detail.
	if applyRes.Outcome != "auto_rolled_back" {
		t.Fatalf("expected outcome 'auto_rolled_back', got %q (%s)", applyRes.Outcome, applyRes.Detail)
	}
	if !strings.Contains(applyRes.Detail, "no sibling rootfs manifest") {
		t.Fatalf("expected sibling-manifest failure detail, got: %s", applyRes.Detail)
	}
	// Rollback: no manifest at the fixed path, no unit, config untouched.
	if _, err := os.Stat(f.aiP.RootfsManifest); !os.IsNotExist(err) {
		t.Fatalf("rootfs manifest must not be written, stat err=%v", err)
	}
	if _, err := os.Stat(f.aiP.HelperUnit); !os.IsNotExist(err) {
		t.Fatalf("ai helper unit must not survive rollback, stat err=%v", err)
	}
	cfgRaw, err := os.ReadFile(f.agentConfig)
	if err != nil {
		t.Fatalf("read agent config: %v", err)
	}
	if strings.Contains(string(cfgRaw), `"ai"`) {
		t.Fatalf("agent config must be restored without the ai block: %s", string(cfgRaw))
	}
}

// TestHelperAIInstallRefusesSymlinkedTargets: a symlink planted at the
// canonical rootfs/profiles target (or any parent) must fail the privileged
// apply closed before any mutation — nothing written through the link.
func TestHelperAIInstallRefusesSymlinkedTargets(t *testing.T) {
	// Symlinks need privileges on some hosts (Windows without Dev Mode);
	// probe first and skip the whole group when they are unavailable.
	probe := t.TempDir()
	if err := os.Symlink(t.TempDir(), filepath.Join(probe, "probe")); err != nil {
		t.Skipf("symlink not permitted in this environment: %v", err)
	}

	t.Run("rootfs-leaf-symlink", func(t *testing.T) {
		f := newAIInstallFixture(t, true)
		installAISeams(t)
		target := t.TempDir()
		// The provisioning parents are real dirs; the LEAF is a symlink.
		if err := os.MkdirAll(filepath.Dir(f.aiP.RootfsDir), 0o755); err != nil {
			t.Fatalf("mkdir parent: %v", err)
		}
		if err := os.Symlink(target, f.aiP.RootfsDir); err != nil {
			t.Skipf("symlink not permitted in this environment: %v", err)
		}
		res := &HelperResult{JobID: f.jobID, Action: actionApply}
		auth := &testJobAuthorizer{job: f.apiJob}
		applyRes := handleApplyFleet(context.Background(), f.cfg, auth, f.apiJob, f.jobID, f.staging, res)
		if applyRes.Outcome != "verify_failed" {
			t.Fatalf("expected outcome 'verify_failed', got %q (%s)", applyRes.Outcome, applyRes.Detail)
		}
		if !strings.Contains(applyRes.Detail, "provision ai dirs") {
			t.Fatalf("expected provisioning refusal detail, got: %s", applyRes.Detail)
		}
		entries, err := os.ReadDir(target)
		if err != nil {
			t.Fatalf("read symlink target: %v", err)
		}
		if len(entries) != 0 {
			t.Fatalf("helper wrote through the rootfs symlink: %v", entries)
		}
	})

	t.Run("profiles-intermediate-symlink", func(t *testing.T) {
		f := newAIInstallFixture(t, true)
		installAISeams(t)
		// An INTERMEDIATE component (etc/flexserver-ai) is the planted
		// symlink; the leaf profiles dir lives inside its target.
		target := t.TempDir()
		preProfiles := filepath.Join(target, "profiles")
		if err := os.MkdirAll(preProfiles, 0o755); err != nil {
			t.Fatalf("mkdir pre-profiles: %v", err)
		}
		if err := os.MkdirAll(filepath.Dir(filepath.Dir(f.aiP.ProfilesDir)), 0o755); err != nil {
			t.Fatalf("mkdir etc: %v", err)
		}
		if err := os.Symlink(target, filepath.Dir(f.aiP.ProfilesDir)); err != nil {
			t.Skipf("symlink not permitted in this environment: %v", err)
		}
		res := &HelperResult{JobID: f.jobID, Action: actionApply}
		auth := &testJobAuthorizer{job: f.apiJob}
		applyRes := handleApplyFleet(context.Background(), f.cfg, auth, f.apiJob, f.jobID, f.staging, res)
		if applyRes.Outcome != "verify_failed" {
			t.Fatalf("expected outcome 'verify_failed', got %q (%s)", applyRes.Outcome, applyRes.Detail)
		}
		if !strings.Contains(applyRes.Detail, "provision ai dirs") {
			t.Fatalf("expected provisioning refusal detail, got: %s", applyRes.Detail)
		}
		// Nothing may have been extracted through the intermediate link.
		entries, err := os.ReadDir(preProfiles)
		if err != nil {
			t.Fatalf("read pre-profiles: %v", err)
		}
		if len(entries) != 0 {
			t.Fatalf("helper wrote through the profiles symlink: %v", entries)
		}
	})
}

// TestRejectSymlinkPath: the pure component-walk guard used by extraction
// and provisioning.
func TestRejectSymlinkPath(t *testing.T) {
	tmp := t.TempDir()
	clean := filepath.Join(tmp, "a", "b", "c")
	if err := os.MkdirAll(filepath.Join(tmp, "a", "b"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := RejectSymlinkPath(clean); err != nil {
		t.Fatalf("clean partial path must pass: %v", err)
	}
	if err := RejectSymlinkPath(filepath.Join(tmp, "missing", "deeper")); err != nil {
		t.Fatalf("missing path must pass: %v", err)
	}

	// A regular file in the chain must be rejected everywhere.
	if err := os.WriteFile(filepath.Join(tmp, "a", "b", "c"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if err := RejectSymlinkPath(filepath.Join(clean, "d")); err == nil {
		t.Fatal("path through a regular file must be rejected")
	}

	// Symlink cases need permission; skip when the environment forbids it.
	linkTarget := t.TempDir()
	if err := os.Symlink(linkTarget, filepath.Join(tmp, "link")); err != nil {
		t.Skipf("symlink not permitted in this environment: %v", err)
	}
	if err := RejectSymlinkPath(filepath.Join(tmp, "link", "child")); err == nil {
		t.Fatal("path through a symlink must be rejected")
	}
	if err := RejectSymlinkPath(filepath.Join(tmp, "link")); err == nil {
		t.Fatal("symlink leaf must be rejected")
	}
}
