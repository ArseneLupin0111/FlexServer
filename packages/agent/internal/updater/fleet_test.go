package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func generateTestEd25519Key(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey, []byte) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("marshal pubkey: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: der,
	})
	return pub, priv, pemBytes
}

func buildValidTestPayload(buildID string) FleetManifestPayload {
	return FleetManifestPayload{
		SchemaVersion: 1,
		ReleaseID:     buildID,
		BuildID:       buildID,
		Version:       "1.5.0",
		PublishedAt:   "2026-10-22T00:00:00Z",
		Channel:       "stable",
		RollbackSafe:  true,
		Artifacts: []FleetArtifact{
			{
				Component: "agent",
				OS:        "linux",
				Arch:      "amd64",
				URL:       "https://github.com/example/fleet/releases/download/v1.5.0/agent-amd64",
				SHA256:    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				Size:      1234567,
				Version:   "1.5.0",
			},
		},
	}
}

func signPayloadEnvelope(t *testing.T, priv ed25519.PrivateKey, payloadStr string, keyID string) []byte {
	t.Helper()
	sig := ed25519.Sign(priv, []byte(payloadStr))
	env := FleetReleaseEnvelope{
		Payload:   payloadStr,
		Signature: base64.StdEncoding.EncodeToString(sig),
		KeyID:     keyID,
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return raw
}

// testJobAuthorizer is an in-memory JobAuthorizer implementation for tests
// that returns a pre-configured ClaimedJob or error.
type testJobAuthorizer struct {
	job *ClaimedJob
	err error
}

func (a *testJobAuthorizer) Get(_ context.Context, _ string) (*ClaimedJob, error) {
	if a.err != nil {
		return nil, a.err
	}
	return a.job, nil
}

func TestVerifyFleetManifest_Success(t *testing.T) {
	_, priv, pemBytes := generateTestEd25519Key(t)
	buildID := "0123456789abcdef0123456789abcdef01234567"
	payloadObj := buildValidTestPayload(buildID)
	payloadBytes, err := json.Marshal(payloadObj)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payloadStr := string(payloadBytes)
	envelopeBytes := signPayloadEnvelope(t, priv, payloadStr, "test-key-1")

	verified, err := VerifyFleetManifest(envelopeBytes, pemBytes)
	if err != nil {
		t.Fatalf("expected successful verification, got error: %v", err)
	}
	if verified.ReleaseID != buildID {
		t.Fatalf("expected releaseId %s, got %s", buildID, verified.ReleaseID)
	}
	if verified.BuildID != buildID {
		t.Fatalf("expected buildId %s, got %s", buildID, verified.BuildID)
	}
	if len(verified.Artifacts) != 1 {
		t.Fatalf("expected 1 artifact, got %d", len(verified.Artifacts))
	}
	if verified.Artifacts[0].Component != "agent" {
		t.Fatalf("expected component agent, got %s", verified.Artifacts[0].Component)
	}
}

func TestVerifyFleetManifest_TamperRejection(t *testing.T) {
	_, priv, pemBytes := generateTestEd25519Key(t)
	buildID := "0123456789abcdef0123456789abcdef01234567"
	payloadObj := buildValidTestPayload(buildID)
	payloadBytes, err := json.Marshal(payloadObj)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payloadStr := string(payloadBytes)
	validSigB64 := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(payloadStr)))

	// 1. Tampered payload with original signature
	tamperedObj := payloadObj
	tamperedObj.Version = "2.0.0-tampered"
	tamperedBytes, _ := json.Marshal(tamperedObj)
	tamperedEnvelope, _ := json.Marshal(FleetReleaseEnvelope{
		Payload:   string(tamperedBytes),
		Signature: validSigB64,
		KeyID:     "test-key-1",
	})
	if _, err := VerifyFleetManifest(tamperedEnvelope, pemBytes); err == nil {
		t.Fatal("expected signature verification failure on tampered payload, got nil error")
	}

	// 2. Corrupt signature with valid payload
	corruptSig := base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	corruptSigEnvelope, _ := json.Marshal(FleetReleaseEnvelope{
		Payload:   payloadStr,
		Signature: corruptSig,
		KeyID:     "test-key-1",
	})
	if _, err := VerifyFleetManifest(corruptSigEnvelope, pemBytes); err == nil {
		t.Fatal("expected failure on corrupt signature, got nil error")
	}

	// 3. Wrong public key
	_, _, wrongPemBytes := generateTestEd25519Key(t)
	cleanEnvelope, _ := json.Marshal(FleetReleaseEnvelope{
		Payload:   payloadStr,
		Signature: validSigB64,
		KeyID:     "test-key-1",
	})
	if _, err := VerifyFleetManifest(cleanEnvelope, wrongPemBytes); err == nil {
		t.Fatal("expected verification failure with wrong public key, got nil error")
	}
}

func TestVerifyFleetManifest_NoRecanonicalization(t *testing.T) {
	_, priv, pemBytes := generateTestEd25519Key(t)
	buildID := "0123456789abcdef0123456789abcdef01234567"
	payloadObj := buildValidTestPayload(buildID)
	payloadIndented, err := json.MarshalIndent(payloadObj, "", "  ")
	if err != nil {
		t.Fatalf("marshal indent: %v", err)
	}
	payloadStr := string(payloadIndented)

	// Sign the exact indented UTF-8 bytes
	envelopeBytes := signPayloadEnvelope(t, priv, payloadStr, "test-key-indent")

	verified, err := VerifyFleetManifest(envelopeBytes, pemBytes)
	if err != nil {
		t.Fatalf("expected exact payload bytes verification to succeed, got: %v", err)
	}
	if verified.ReleaseID != buildID {
		t.Fatalf("unexpected releaseId: %s", verified.ReleaseID)
	}
}

func TestVerifyFleetManifest_AIOnly(t *testing.T) {
	_, priv, pemBytes := generateTestEd25519Key(t)
	buildID := "0123456789abcdef0123456789abcdef01234567"
	aiComponents := []string{"ai-executor", "ai-host-helper", "ai-rootfs", "ai-profiles"}
	artifacts := make([]FleetArtifact, len(aiComponents))
	for i, c := range aiComponents {
		artifacts[i] = FleetArtifact{
			Component: c,
			OS:        "linux",
			Arch:      "amd64",
			URL:       "https://github.com/vps-manager/releases/" + c,
			SHA256:    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			Size:      1024,
			Version:   "1.0.0",
		}
	}
	payloadObj := FleetManifestPayload{
		SchemaVersion: 1,
		ReleaseID:     buildID,
		BuildID:       buildID,
		Version:       "1.0.0",
		Channel:       "stable",
		RollbackSafe:  true,
		Artifacts:     artifacts,
	}
	payloadBytes, err := json.Marshal(payloadObj)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	envelopeBytes := signPayloadEnvelope(t, priv, string(payloadBytes), "test-ai-key")

	verified, err := VerifyFleetManifest(envelopeBytes, pemBytes)
	if err != nil {
		t.Fatalf("expected successful AI-only manifest verification, got: %v", err)
	}
	if len(verified.Artifacts) != 4 {
		t.Fatalf("expected 4 artifacts, got %d", len(verified.Artifacts))
	}
}

func TestExtractTarGz_StripPrefix(t *testing.T) {
	tmpDir := t.TempDir()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	files := map[string]string{
		"rootfs/":                 "",
		"rootfs/etc/":             "",
		"rootfs/etc/profile.conf": "test-data-content",
		"rootfs/bin/":             "",
		"rootfs/bin/tool":         "binary-data",
	}

	for name, content := range files {
		hdr := &tar.Header{
			Name: name,
			Mode: 0o755,
		}
		if content != "" {
			hdr.Mode = 0o644
			hdr.Size = int64(len(content))
			hdr.Typeflag = tar.TypeReg
		} else {
			hdr.Typeflag = tar.TypeDir
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("write header: %v", err)
		}
		if content != "" {
			if _, err := tw.Write([]byte(content)); err != nil {
				t.Fatalf("write content: %v", err)
			}
		}
	}
	tw.Close()
	gw.Close()

	destDir := filepath.Join(tmpDir, "extracted")
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	tarPath := filepath.Join(tmpDir, "archive.tar.gz")
	if err := os.WriteFile(tarPath, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write tar: %v", err)
	}

	if err := ExtractTarGz(tarPath, destDir, "rootfs"); err != nil {
		t.Fatalf("extract failed: %v", err)
	}

	gotData, err := os.ReadFile(filepath.Join(destDir, "etc", "profile.conf"))
	if err != nil {
		t.Fatalf("read extracted file: %v", err)
	}
	if string(gotData) != "test-data-content" {
		t.Fatalf("content mismatch: got %q want %q", string(gotData), "test-data-content")
	}
}

func TestExtractTarGz_SymlinkEscapeRejection(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping symlink test on Windows")
	}
	tmpDir := t.TempDir()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	hdr := &tar.Header{
		Name:     "rootfs/malicious-link",
		Mode:     0o777,
		Typeflag: tar.TypeSymlink,
		Linkname: "../../../../etc/shadow",
	}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatalf("write header: %v", err)
	}
	tw.Close()
	gw.Close()

	destDir := filepath.Join(tmpDir, "dest")
	_ = os.MkdirAll(destDir, 0o755)
	tarPath := filepath.Join(tmpDir, "evil.tar.gz")
	_ = os.WriteFile(tarPath, buf.Bytes(), 0o644)

	err := ExtractTarGz(tarPath, destDir, "rootfs")
	if err == nil {
		t.Fatalf("expected ExtractTarGz to reject escaping symlink, but got nil error")
	}
}

func TestExtractTarGz_PermissionsAndSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping symlink test on Windows")
	}
	tmpDir := t.TempDir()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	// Directory
	_ = tw.WriteHeader(&tar.Header{
		Name:     "rootfs/bin/",
		Mode:     0o755,
		Typeflag: tar.TypeDir,
	})
	// Executable binary
	binContent := []byte("#!/bin/sh\necho ok\n")
	_ = tw.WriteHeader(&tar.Header{
		Name:     "rootfs/bin/exec_tool",
		Mode:     0o755,
		Size:     int64(len(binContent)),
		Typeflag: tar.TypeReg,
	})
	_, _ = tw.Write(binContent)
	// Relative symlink inside directory
	_ = tw.WriteHeader(&tar.Header{
		Name:     "rootfs/bin/tool_alias",
		Mode:     0o777,
		Typeflag: tar.TypeSymlink,
		Linkname: "exec_tool",
	})
	tw.Close()
	gw.Close()

	destDir := filepath.Join(tmpDir, "dest")
	_ = os.MkdirAll(destDir, 0o755)
	tarPath := filepath.Join(tmpDir, "pkg.tar.gz")
	_ = os.WriteFile(tarPath, buf.Bytes(), 0o644)

	if err := ExtractTarGz(tarPath, destDir, "rootfs"); err != nil {
		t.Fatalf("extract failed: %v", err)
	}

	execPath := filepath.Join(destDir, "bin", "exec_tool")
	fi, err := os.Stat(execPath)
	if err != nil {
		t.Fatalf("stat exec_tool: %v", err)
	}
	if fi.Mode().Perm()&0o111 == 0 {
		t.Fatalf("expected exec_tool to be executable, mode: %v", fi.Mode())
	}

	linkPath := filepath.Join(destDir, "bin", "tool_alias")
	lfi, err := os.Lstat(linkPath)
	if err != nil {
		t.Fatalf("lstat tool_alias: %v", err)
	}
	if lfi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected tool_alias to be symlink, mode: %v", lfi.Mode())
	}
	target, err := os.Readlink(linkPath)
	if err != nil {
		t.Fatalf("readlink tool_alias: %v", err)
	}
	if target != "exec_tool" {
		t.Fatalf("expected symlink target 'exec_tool', got %q", target)
	}
}

func TestSecurity_RejectMaliciousTargetPath(t *testing.T) {
	tmpDir := t.TempDir()
	staging := filepath.Join(tmpDir, "staging")
	_ = os.MkdirAll(staging, 0o755)

	_, priv, pemBytes := generateTestEd25519Key(t)
	buildID := "0123456789abcdef0123456789abcdef01234567"
	payload := buildValidTestPayload(buildID)
	rawPayload, _ := json.Marshal(payload)
	sig := ed25519.Sign(priv, rawPayload)
	envelopeRaw, _ := json.Marshal(FleetReleaseEnvelope{
		Payload:   string(rawPayload),
		Signature: base64.StdEncoding.EncodeToString(sig),
		KeyID:     "sec-key",
	})

	stagedAgent := filepath.Join(staging, "agent-new")
	agentContent := []byte("new-agent-content")
	_ = os.WriteFile(stagedAgent, agentContent, 0o755)
	h := sha256.Sum256(agentContent)
	agentSHA := hex.EncodeToString(h[:])

	// Spec points TargetPath to an unauthorized path outside canonical targets
	spec := ApplySpec{
		JobID:     "job-sec-1",
		ReleaseID: buildID,
		BuildID:   buildID,
		Components: []ComponentApplySpec{
			{
				Component:  "agent",
				SourcePath: stagedAgent,
				TargetPath: "/etc/cron.d/malicious_cron",
				SHA256:     agentSHA,
				Size:       int64(len(agentContent)),
			},
		},
	}
	specBytes, _ := json.Marshal(spec)
	_ = os.WriteFile(filepath.Join(staging, "apply-spec.json"), specBytes, 0o644)

	cfg := &Config{
		StateDir:    tmpDir,
		AgentBinary: filepath.Join(tmpDir, "bin", "agent"),
	}
	cfg.EnableTestOverrides()
	cfg.SetTestFleetPublicKeyPEM(pemBytes)
	cfg.SetTestLockDir(filepath.Join(tmpDir, "lock"))

	apiJob := &ClaimedJob{
		JobID:           "job-sec-1",
		Phase:           PhaseRestarting,
		State:           "staging",
		ManifestRaw:     string(envelopeRaw),
		LeaseExpiresAt:  FlexTime{Time: time.Now().Add(10 * time.Minute)},
		PhaseDeadlineAt: FlexTime{Time: time.Now().Add(10 * time.Minute)},
		DeadlineAt:      FlexTime{Time: time.Now().Add(10 * time.Minute)},
		Release: ReleaseInfo{
			ReleaseID: buildID,
			BuildID:   buildID,
		},
	}
	auth := &testJobAuthorizer{job: apiJob}
	res := &HelperResult{JobID: "job-sec-1", Action: actionApply}

	applyRes := handleApplyFleet(context.Background(), cfg, auth, apiJob, "job-sec-1", staging, res)
	if applyRes.Outcome != "verify_failed" {
		t.Fatalf("expected outcome 'verify_failed' for malicious target path, got %q: %s", applyRes.Outcome, applyRes.Detail)
	}
}

func TestSecurity_RejectEscapingSourcePath(t *testing.T) {
	tmpDir := t.TempDir()
	staging := filepath.Join(tmpDir, "staging")
	_ = os.MkdirAll(staging, 0o755)

	_, priv, pemBytes := generateTestEd25519Key(t)
	buildID := "0123456789abcdef0123456789abcdef01234567"
	payload := buildValidTestPayload(buildID)
	rawPayload, _ := json.Marshal(payload)
	sig := ed25519.Sign(priv, rawPayload)
	envelopeRaw, _ := json.Marshal(FleetReleaseEnvelope{
		Payload:   string(rawPayload),
		Signature: base64.StdEncoding.EncodeToString(sig),
		KeyID:     "sec-key",
	})

	outsideFile := filepath.Join(tmpDir, "outside-secret")
	outsideContent := []byte("secret-data")
	_ = os.WriteFile(outsideFile, outsideContent, 0o644)
	h := sha256.Sum256(outsideContent)
	fileSHA := hex.EncodeToString(h[:])

	agentPath := filepath.Join(tmpDir, "bin", "agent")
	_ = os.MkdirAll(filepath.Dir(agentPath), 0o755)

	// Spec points SourcePath outside staging directory
	spec := ApplySpec{
		JobID:     "job-sec-2",
		ReleaseID: buildID,
		BuildID:   buildID,
		Components: []ComponentApplySpec{
			{
				Component:  "agent",
				SourcePath: outsideFile,
				TargetPath: agentPath,
				SHA256:     fileSHA,
				Size:       int64(len(outsideContent)),
			},
		},
	}
	specBytes, _ := json.Marshal(spec)
	_ = os.WriteFile(filepath.Join(staging, "apply-spec.json"), specBytes, 0o644)

	cfg := &Config{
		StateDir:    tmpDir,
		AgentBinary: agentPath,
	}
	cfg.EnableTestOverrides()
	cfg.SetTestFleetPublicKeyPEM(pemBytes)
	cfg.SetTestCanonicalTarget("agent", agentPath)
	cfg.SetTestLockDir(filepath.Join(tmpDir, "lock"))

	apiJob := &ClaimedJob{
		JobID:           "job-sec-2",
		Phase:           PhaseRestarting,
		State:           "staging",
		ManifestRaw:     string(envelopeRaw),
		LeaseExpiresAt:  FlexTime{Time: time.Now().Add(10 * time.Minute)},
		PhaseDeadlineAt: FlexTime{Time: time.Now().Add(10 * time.Minute)},
		DeadlineAt:      FlexTime{Time: time.Now().Add(10 * time.Minute)},
		Release: ReleaseInfo{
			ReleaseID: buildID,
			BuildID:   buildID,
		},
	}
	auth := &testJobAuthorizer{job: apiJob}
	res := &HelperResult{JobID: "job-sec-2", Action: actionApply}

	applyRes := handleApplyFleet(context.Background(), cfg, auth, apiJob, "job-sec-2", staging, res)
	if applyRes.Outcome != "verify_failed" {
		t.Fatalf("expected outcome 'verify_failed' for escaping source path, got %q: %s", applyRes.Outcome, applyRes.Detail)
	}
}

func TestSecurity_RejectUnsignedManifestRaw(t *testing.T) {
	tmpDir := t.TempDir()
	staging := filepath.Join(tmpDir, "staging")
	_ = os.MkdirAll(staging, 0o755)

	_, _, pemBytes := generateTestEd25519Key(t)
	buildID := "0123456789abcdef0123456789abcdef01234567"

	agentPath := filepath.Join(tmpDir, "bin", "agent")
	_ = os.MkdirAll(filepath.Dir(agentPath), 0o755)
	stagedAgent := filepath.Join(staging, "agent")
	_ = os.WriteFile(stagedAgent, []byte("data"), 0o755)
	h := sha256.Sum256([]byte("data"))

	spec := ApplySpec{
		JobID:     "job-sec-3",
		ReleaseID: buildID,
		BuildID:   buildID,
		Components: []ComponentApplySpec{
			{
				Component:  "agent",
				SourcePath: stagedAgent,
				TargetPath: agentPath,
				SHA256:     hex.EncodeToString(h[:]),
				Size:       4,
			},
		},
	}
	specBytes, _ := json.Marshal(spec)
	_ = os.WriteFile(filepath.Join(staging, "apply-spec.json"), specBytes, 0o644)

	cfg := &Config{
		StateDir:    tmpDir,
		AgentBinary: agentPath,
	}
	cfg.EnableTestOverrides()
	cfg.SetTestFleetPublicKeyPEM(pemBytes)
	cfg.SetTestCanonicalTarget("agent", agentPath)
	cfg.SetTestLockDir(filepath.Join(tmpDir, "lock"))

	// apiJob with empty ManifestRaw
	apiJob := &ClaimedJob{
		JobID:           "job-sec-3",
		Phase:           PhaseRestarting,
		State:           "staging",
		ManifestRaw:     "",
		LeaseExpiresAt:  FlexTime{Time: time.Now().Add(10 * time.Minute)},
		PhaseDeadlineAt: FlexTime{Time: time.Now().Add(10 * time.Minute)},
		DeadlineAt:      FlexTime{Time: time.Now().Add(10 * time.Minute)},
		Release: ReleaseInfo{
			ReleaseID: buildID,
			BuildID:   buildID,
		},
	}
	auth := &testJobAuthorizer{job: apiJob}
	res := &HelperResult{JobID: "job-sec-3", Action: actionApply}

	applyRes := handleApplyFleet(context.Background(), cfg, auth, apiJob, "job-sec-3", staging, res)
	if applyRes.Outcome != "verify_failed" {
		t.Fatalf("expected outcome 'verify_failed' for empty manifestRaw, got %q: %s", applyRes.Outcome, applyRes.Detail)
	}
}

func TestCollectHostEvidence(t *testing.T) {
	cfg := &Config{
		AgentBinary: "/usr/local/bin/vps-manager-agent",
	}
	idle, _ := DetectHostIdle(cfg)
	if !idle {
		t.Logf("host is busy")
	}
	health := DetectAIHealth(cfg)
	if !health.Healthy && !health.Installed {
		t.Fatalf("uninstalled AI should report healthy")
	}

	req := ClaimRequest{
		UpdaterVersion: "1.0.0",
		Platform: PlatformInfo{
			OS:   "linux",
			Arch: "amd64",
		},
		Idle:     idle,
		AIHealth: health,
	}
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal ClaimRequest: %v", err)
	}
	if len(raw) == 0 {
		t.Fatalf("empty claim request json")
	}
}
