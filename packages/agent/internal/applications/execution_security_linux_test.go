//go:build linux

package applications

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBoundedOutputDropsExcessWithoutRetainingIt(t *testing.T) {
	b := &boundedOutput{limit: 16}
	n, err := b.Write(bytes.Repeat([]byte("x"), 1024*1024))
	if err != nil || n != 1024*1024 || len(b.data) != 16 || !b.exceeded {
		t.Fatal("output cap not enforced")
	}
}
func TestEveryEnvironmentValueIsRedacted(t *testing.T) {
	model := map[string]any{"services": map[string]any{"web": map[string]any{"environment": map[string]any{"PUBLIC": "not-labelled-secret", "NUMBER": 12, "EMPTY": nil}, "command": []any{"secret"}}}}
	_, redacted, _, _, _, err := canonicalVerifiedModel(model, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(redacted), "not-labelled-secret") || strings.Contains(string(redacted), "secret") {
		t.Fatalf("protected value escaped: %s", redacted)
	}
}
func TestBindRootIsAppDataOnly(t *testing.T) {
	root := t.TempDir()
	t.Setenv("COMPOSE_WORK_DIR", root)
	app := "app_a"
	data := filepath.Join(root, app, "data")
	if err := os.MkdirAll(data, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(data, "config")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	denyCreate := false
	volume := deployVolumeModel{Type: "bind", Source: file}
	volume.Bind.CreateHostPath = &denyCreate
	model := deployComposeModel{Services: map[string]deployServiceModel{"web": {Volumes: []deployVolumeModel{volume}}}}
	if err := verifyAppBindSources(model, app, 1); err != nil {
		t.Fatal(err)
	}
	if err := verifyAppBindSources(model, "other_app", 1); err == nil {
		t.Fatal("cross-application bind accepted")
	}
	model.Services["web"] = deployServiceModel{Volumes: []deployVolumeModel{{Type: "bind", Source: root}}}
	if err := verifyAppBindSources(model, app, 1); err == nil {
		t.Fatal("metadata root bind accepted")
	}
}
func TestSelectedProfilesLimitReadinessModel(t *testing.T) {
	model := deployComposeModel{Services: map[string]deployServiceModel{"web": {}, "job": {Profiles: []string{"jobs"}}}}
	inactive := selectedDeployModel(model, nil)
	active := selectedDeployModel(model, []string{"jobs"})
	if _, ok := inactive.Services["job"]; ok {
		t.Fatal("inactive job blocks readiness")
	}
	if _, ok := inactive.Services["web"]; !ok {
		t.Fatal("default web omitted")
	}
	if _, ok := active.Services["job"]; !ok {
		t.Fatal("selected job omitted from readiness")
	}
}
func TestRepoDigestRepositoryMatching(t *testing.T) {
	for _, pair := range [][2]string{{"alpine:3", "docker.io/library/alpine@sha256:abc"}, {"org/image:latest", "docker.io/org/image@sha256:abc"}, {"registry:5000/org/image:tag", "registry:5000/org/image@sha256:abc"}} {
		if imageRepository(pair[0]) != imageRepository(pair[1]) {
			t.Fatalf("repository mismatch %v", pair)
		}
	}
	if imageRepository("other/image:tag") == imageRepository("org/image@sha256:abc") {
		t.Fatal("unrelated repositories matched")
	}
}
func TestCommandTimeoutTerminatesProcessGroup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	// The shell is test-only; production execution always uses fixed argv.
	runner := &composeRunner{runtime: &ComposeRuntime{Path: "/bin/sh"}, workDir: t.TempDir(), env: []string{"PATH=/usr/bin:/bin"}}
	start := time.Now()
	err := runner.cmd(ctx, nil, time.Second, "-c", "sleep 60")
	if err == nil || time.Since(start) > 3*time.Second {
		t.Fatalf("process group was not bounded: %v", err)
	}
}

func TestDurableOwnershipRejectsLabelsWithoutManifest(t *testing.T) {
	t.Setenv("COMPOSE_WORK_DIR", t.TempDir())
	if err := verifyDurableOwnership("app", "instance", "epoch", "project", map[string]string{"id": "web"}); err == nil {
		t.Fatal("missing durable ownership accepted")
	}
}
func TestReadinessTimeoutDefaultAndBounds(t *testing.T) {
	if deployReadinessTimeout(0) != 300*time.Second || deployReadinessTimeout(29) != 300*time.Second || deployReadinessTimeout(3601) != 300*time.Second || deployReadinessTimeout(60) != time.Minute {
		t.Fatal("readiness deadline invalid")
	}
}
func TestRuntimeFingerprintRowWireContract(t *testing.T) {
	b, err := json.Marshal(runtimeFingerprintRow{"key", "project", "web", 2, "running", ""})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"containerKey":"key","project":"project","service":"web","slot":2,"state":"running","health":""}` {
		t.Fatalf("fingerprint wire contract changed: %s", b)
	}
}

func TestComposeOutputLimitFailsWithoutReturningChildSecrets(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "fixture")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf secret-sentinel-output\n"), 0700); err != nil {
		t.Fatal(err)
	}
	runner := &composeRunner{runtime: &ComposeRuntime{Path: binary}, workDir: dir, env: []string{}}
	// The executable ignores argv and emits more than the permitted stdout.
	out, stderr, err := runner.runStdout(context.Background(), time.Second, 1, "", nil, nil, "config")
	if err == nil || len(out) != 0 || stderr != "" {
		t.Fatalf("unbounded child output returned: %q %q %v", out, stderr, err)
	}
}
