package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var hex40Pattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

func createAgentFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	goMod := "module github.com/vps-manager/testagent\n\ngo 1.21\n"
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(goMod), 0644); err != nil {
		t.Fatalf("writing go.mod: %v", err)
	}

	cmdDir := filepath.Join(dir, "cmd", "vps-agent")
	if err := os.MkdirAll(cmdDir, 0755); err != nil {
		t.Fatalf("creating cmd/vps-agent: %v", err)
	}
	mainGo := "package main\n\nfunc main() {}\n"
	if err := os.WriteFile(filepath.Join(cmdDir, "main.go"), []byte(mainGo), 0644); err != nil {
		t.Fatalf("writing main.go: %v", err)
	}

	internalDir := filepath.Join(dir, "internal", "foo")
	if err := os.MkdirAll(internalDir, 0755); err != nil {
		t.Fatalf("creating internal/foo: %v", err)
	}
	fooGo := "package foo\n\nfunc Bar() {}\n"
	if err := os.WriteFile(filepath.Join(internalDir, "foo.go"), []byte(fooGo), 0644); err != nil {
		t.Fatalf("writing foo.go: %v", err)
	}

	return dir
}

func TestCLI_Success(t *testing.T) {
	fixtureDir := createAgentFixture(t)

	cmd := exec.Command("go", "run", ".", "--root", fixtureDir)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("CLI failed: %v (stderr: %s)", err, stderr.String())
	}

	out := strings.TrimSpace(stdout.String())
	if !hex40Pattern.MatchString(out) {
		t.Fatalf("expected 40-hex lowercase output, got %q", out)
	}
}

func TestCLI_Failure_InvalidRoot(t *testing.T) {
	nonExistent := filepath.Join(t.TempDir(), "non-existent")

	cmd := exec.Command("go", "run", ".", "--root", nonExistent)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err == nil {
		t.Fatalf("expected CLI error for non-existent root directory, got stdout: %s", stdout.String())
	}

	if !strings.Contains(stderr.String(), "agent-build-id:") {
		t.Fatalf("expected error prefix 'agent-build-id:' in stderr, got: %s", stderr.String())
	}
}
