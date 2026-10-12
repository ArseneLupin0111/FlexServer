package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHelperAuthorizesJobViaAPI(t *testing.T) {
	rel := newRelease(t, []byte("new-agent-binary-content"), "https://example.com/agent")
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	stateDir := t.TempDir()
	binDir := t.TempDir()
	agentBin := filepath.Join(binDir, "vps-agent")
	writeFile(t, agentBin, []byte("old-binary"), 0o755)

	h := sha256.Sum256(rel.content)
	targetSha := hex.EncodeToString(h[:])

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/api/local-updater/jobs/"+faultJobID) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"data": map[string]interface{}{
					"job": map[string]interface{}{
						"jobId":           faultJobID,
						"phase":           "restarting",
						"state":           "staging",
						"targetSha256":    targetSha,
						"targetSizeBytes": len(rel.content),
						"leaseExpiresAt":  time.Now().Add(5 * time.Minute).Format(time.RFC3339),
						"phaseDeadlineAt": time.Now().Add(5 * time.Minute).Format(time.RFC3339),
						"deadlineAt":      time.Now().Add(5 * time.Minute).Format(time.RFC3339),
						"release": map[string]interface{}{
							"releaseId":    rel.buildID,
							"buildId":      rel.buildID,
							"targetSha256": targetSha,
						},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := &Config{
		APIBase:          server.URL,
		Credential:       "vma_test_root_cred",
		AgentBinary:      agentBin,
		AgentUnit:        "vps-agent.service",
		StateDir:         stateDir,
		HelperTimeoutSec: 30,
	}
	cfg.EnableTestOverrides()
	if err := cfg.NormalizeAndValidate(); err != nil {
		t.Fatalf("NormalizeAndValidate: %v", err)
	}

	// Seed staging directory with staged binary
	stg := stagingDir(stateDir, faultJobID)
	if err := os.MkdirAll(stg, 0o755); err != nil {
		t.Fatalf("mkdir staging: %v", err)
	}
	writeFile(t, filepath.Join(stg, "artifact.bin"), rel.content, 0o755)

	// Write daemon meta.json matching the authorized API job
	metaBytes, _ := json.Marshal(map[string]interface{}{
		"jobId":   faultJobID,
		"buildId": rel.buildID,
		"sha256":  targetSha,
		"size":    len(rel.content),
	})
	writeFile(t, filepath.Join(stg, "meta.json"), metaBytes, 0o644)

	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "restarted" {
		t.Fatalf("outcome = %q, want restarted (detail: %s)", res.Outcome, res.Detail)
	}
}

func TestHelperRejectsMismatchedMetaFromCompromisedDaemon(t *testing.T) {
	rel := newRelease(t, []byte("new-agent-binary-content"), "https://example.com/agent")
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	stateDir := t.TempDir()
	binDir := t.TempDir()
	agentBin := filepath.Join(binDir, "vps-agent")
	writeFile(t, agentBin, []byte("old-binary"), 0o755)

	h := sha256.Sum256(rel.content)
	authorizedSha := hex.EncodeToString(h[:])

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": map[string]interface{}{
				"job": map[string]interface{}{
					"jobId":           faultJobID,
					"phase":           "restarting",
					"state":           "staging",
					"targetSha256":    authorizedSha,
					"targetSizeBytes": len(rel.content),
					"leaseExpiresAt":  time.Now().Add(5 * time.Minute).Format(time.RFC3339),
					"phaseDeadlineAt": time.Now().Add(5 * time.Minute).Format(time.RFC3339),
					"deadlineAt":      time.Now().Add(5 * time.Minute).Format(time.RFC3339),
					"release": map[string]interface{}{
						"releaseId":    rel.buildID,
						"buildId":      rel.buildID,
						"targetSha256": authorizedSha,
					},
				},
			},
		})
	}))
	defer server.Close()

	cfg := &Config{
		APIBase:          server.URL,
		Credential:       "vma_test_root_cred",
		AgentBinary:      agentBin,
		AgentUnit:        "vps-agent.service",
		StateDir:         stateDir,
		HelperTimeoutSec: 30,
	}
	cfg.EnableTestOverrides()
	if err := cfg.NormalizeAndValidate(); err != nil {
		t.Fatalf("NormalizeAndValidate: %v", err)
	}

	stg := stagingDir(stateDir, faultJobID)
	if err := os.MkdirAll(stg, 0o755); err != nil {
		t.Fatalf("mkdir staging: %v", err)
	}
	writeFile(t, filepath.Join(stg, "artifact.bin"), rel.content, 0o755)

	// Tampered meta.json claiming a different sha256
	metaBytes, _ := json.Marshal(map[string]interface{}{
		"jobId":   faultJobID,
		"buildId": rel.buildID,
		"sha256":  "tampered-sha256-value-12345",
		"size":    len(rel.content),
	})
	writeFile(t, filepath.Join(stg, "meta.json"), metaBytes, 0o644)

	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "verify_failed" {
		t.Fatalf("outcome = %q, want verify_failed", res.Outcome)
	}
	if !strings.Contains(res.Detail, "sha256 mismatch") {
		t.Fatalf("detail %q does not mention sha256 mismatch", res.Detail)
	}
}

func TestHelperRejectsMissingDeadlines(t *testing.T) {
	rel := newRelease(t, []byte("new-agent-binary-content"), "https://example.com/agent")
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	stateDir := t.TempDir()
	binDir := t.TempDir()
	agentBin := filepath.Join(binDir, "vps-agent")
	writeFile(t, agentBin, []byte("old-binary"), 0o755)

	h := sha256.Sum256(rel.content)
	targetSha := hex.EncodeToString(h[:])

	// Server returns job with zero deadlines
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": map[string]interface{}{
				"job": map[string]interface{}{
					"jobId":           faultJobID,
					"phase":           "restarting",
					"state":           "staging",
					"targetSha256":    targetSha,
					"targetSizeBytes": len(rel.content),
					"release": map[string]interface{}{
						"releaseId":    rel.buildID,
						"buildId":      rel.buildID,
						"targetSha256": targetSha,
					},
				},
			},
		})
	}))
	defer server.Close()

	cfg := &Config{
		APIBase:          server.URL,
		Credential:       "vma_test_root_cred",
		AgentBinary:      agentBin,
		AgentUnit:        "vps-agent.service",
		StateDir:         stateDir,
		HelperTimeoutSec: 30,
	}
	cfg.EnableTestOverrides()
	if err := cfg.NormalizeAndValidate(); err != nil {
		t.Fatalf("NormalizeAndValidate: %v", err)
	}

	stg := stagingDir(stateDir, faultJobID)
	if err := os.MkdirAll(stg, 0o755); err != nil {
		t.Fatalf("mkdir stg: %v", err)
	}
	metaBytes, _ := json.Marshal(map[string]interface{}{
		"jobId": faultJobID, "buildId": rel.buildID, "sha256": targetSha, "size": len(rel.content),
	})
	writeFile(t, filepath.Join(stg, "artifact.bin"), rel.content, 0o755)
	writeFile(t, filepath.Join(stg, "meta.json"), metaBytes, 0o644)

	writePending(t, cfg, actionApply, faultJobID)
	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}
	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "verify_failed" {
		t.Fatalf("outcome = %q, want verify_failed", res.Outcome)
	}
	if !strings.Contains(res.Detail, "deadline") && !strings.Contains(res.Detail, "lease") {
		t.Fatalf("detail %q does not mention deadline or lease", res.Detail)
	}
}
