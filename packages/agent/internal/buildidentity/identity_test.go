package buildidentity

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var hex40Pattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

func createBaseAgentFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	goMod := "module github.com/vps-manager/testagent\n\ngo 1.21\n"
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(goMod), 0644); err != nil {
		t.Fatalf("failed writing go.mod: %v", err)
	}

	cmdDir := filepath.Join(dir, "cmd", "vps-agent")
	if err := os.MkdirAll(cmdDir, 0755); err != nil {
		t.Fatalf("failed creating cmd/vps-agent: %v", err)
	}
	mainGo := "package main\n\nimport \"github.com/vps-manager/testagent/internal/worker\"\n\nfunc main() {\n\tworker.Run()\n}\n"
	if err := os.WriteFile(filepath.Join(cmdDir, "main.go"), []byte(mainGo), 0644); err != nil {
		t.Fatalf("failed writing main.go: %v", err)
	}

	workerDir := filepath.Join(dir, "internal", "worker")
	if err := os.MkdirAll(workerDir, 0755); err != nil {
		t.Fatalf("failed creating internal/worker: %v", err)
	}
	workerGo := "package worker\n\nfunc Run() string {\n\treturn \"worker-v1\"\n}\n"
	if err := os.WriteFile(filepath.Join(workerDir, "worker.go"), []byte(workerGo), 0644); err != nil {
		t.Fatalf("failed writing worker.go: %v", err)
	}

	return dir
}

func TestCompute_FormatAndDeterminism(t *testing.T) {
	dir := createBaseAgentFixture(t)

	id1, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute failed: %v", err)
	}

	if !hex40Pattern.MatchString(id1) {
		t.Fatalf("expected 40-char lowercase hex string, got %q", id1)
	}

	id2, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute failed on second call: %v", err)
	}

	if id1 != id2 {
		t.Fatalf("Compute is not deterministic: %q != %q", id1, id2)
	}
}

func TestCompute_Invariance_DocsAndUnembeddedFiles(t *testing.T) {
	dir := createBaseAgentFixture(t)

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute baseline failed: %v", err)
	}

	// 1. Add README.md at root
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Agent docs\n"), 0644); err != nil {
		t.Fatalf("writing README.md: %v", err)
	}
	// 2. Add documentation inside internal
	if err := os.WriteFile(filepath.Join(dir, "internal", "worker", "README.md"), []byte("worker notes\n"), 0644); err != nil {
		t.Fatalf("writing worker README.md: %v", err)
	}
	// 3. Add loose un-embedded json file
	if err := os.WriteFile(filepath.Join(dir, "internal", "worker", "config.json"), []byte(`{"unembedded": true}`), 0644); err != nil {
		t.Fatalf("writing config.json: %v", err)
	}

	newID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with docs failed: %v", err)
	}

	if newID != baseID {
		t.Fatalf("identity changed unexpectedly after adding non-Go/doc files: %q != %q", newID, baseID)
	}
}

func TestCompute_Invariance_TestFiles(t *testing.T) {
	dir := createBaseAgentFixture(t)

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute baseline failed: %v", err)
	}

	// Add test files
	cmdTest := "package main\n\nimport \"testing\"\n\nfunc TestMain(t *testing.T) {}\n"
	if err := os.WriteFile(filepath.Join(dir, "cmd", "vps-agent", "main_test.go"), []byte(cmdTest), 0644); err != nil {
		t.Fatalf("writing main_test.go: %v", err)
	}

	workerTest := "package worker\n\nimport \"testing\"\n\nfunc TestRun(t *testing.T) {}\n"
	if err := os.WriteFile(filepath.Join(dir, "internal", "worker", "worker_test.go"), []byte(workerTest), 0644); err != nil {
		t.Fatalf("writing worker_test.go: %v", err)
	}

	newID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with test files failed: %v", err)
	}

	if newID != baseID {
		t.Fatalf("identity changed unexpectedly after adding test files: %q != %q", newID, baseID)
	}
}

func TestCompute_Invariance_BuildIdentityPackage(t *testing.T) {
	dir := createBaseAgentFixture(t)

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute baseline failed: %v", err)
	}

	// Add internal/buildidentity package
	biDir := filepath.Join(dir, "internal", "buildidentity")
	if err := os.MkdirAll(biDir, 0755); err != nil {
		t.Fatalf("creating internal/buildidentity: %v", err)
	}
	biCode := "package buildidentity\n\nconst Version = \"1.0.0\"\n"
	if err := os.WriteFile(filepath.Join(biDir, "identity.go"), []byte(biCode), 0644); err != nil {
		t.Fatalf("writing buildidentity source: %v", err)
	}

	newID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with buildidentity package failed: %v", err)
	}

	if newID != baseID {
		t.Fatalf("identity changed unexpectedly after adding buildidentity calculator sources: %q != %q", newID, baseID)
	}
}

func TestCompute_Invariance_NonRuntimeCmdPackages(t *testing.T) {
	dir := createBaseAgentFixture(t)

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute baseline failed: %v", err)
	}

	// Add cmd/agent-build-id
	cliDir := filepath.Join(dir, "cmd", "agent-build-id")
	if err := os.MkdirAll(cliDir, 0755); err != nil {
		t.Fatalf("creating cmd/agent-build-id: %v", err)
	}
	cliCode := "package main\n\nfunc main() {}\n"
	if err := os.WriteFile(filepath.Join(cliDir, "main.go"), []byte(cliCode), 0644); err != nil {
		t.Fatalf("writing cmd/agent-build-id: %v", err)
	}

	newID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with non-runtime cmd package failed: %v", err)
	}

	if newID != baseID {
		t.Fatalf("identity changed unexpectedly after adding non-runtime cmd package: %q != %q", newID, baseID)
	}
}

func TestCompute_Invariance_CRLFvsLF(t *testing.T) {
	dir := createBaseAgentFixture(t)

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute baseline failed: %v", err)
	}

	// Convert all Go files and go.mod to CRLF
	for _, rel := range []string{"go.mod", filepath.Join("cmd", "vps-agent", "main.go"), filepath.Join("internal", "worker", "worker.go")} {
		fullPath := filepath.Join(dir, rel)
		data, err := os.ReadFile(fullPath)
		if err != nil {
			t.Fatalf("reading %s: %v", rel, err)
		}
		crlfData := bytes.ReplaceAll(data, []byte("\n"), []byte("\r\n"))
		if err := os.WriteFile(fullPath, crlfData, 0644); err != nil {
			t.Fatalf("writing CRLF %s: %v", rel, err)
		}
	}

	crlfID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with CRLF files failed: %v", err)
	}

	if crlfID != baseID {
		t.Fatalf("identity mismatch between LF and CRLF checkouts: %q != %q", crlfID, baseID)
	}
}

func TestCompute_Sensitivity_CmdVpsAgent(t *testing.T) {
	dir := createBaseAgentFixture(t)

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute baseline failed: %v", err)
	}

	// Modify cmd/vps-agent/main.go
	newMain := "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"modified\")\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "cmd", "vps-agent", "main.go"), []byte(newMain), 0644); err != nil {
		t.Fatalf("modifying main.go: %v", err)
	}

	newID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute after modifying cmd/vps-agent failed: %v", err)
	}

	if newID == baseID {
		t.Fatalf("expected identity change when cmd/vps-agent source changes, but both were %q", newID)
	}
}

func TestCompute_Sensitivity_InternalPackage(t *testing.T) {
	dir := createBaseAgentFixture(t)

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute baseline failed: %v", err)
	}

	// Modify internal/worker/worker.go
	newWorker := "package worker\n\nfunc Run() string {\n\treturn \"worker-v2-updated\"\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "internal", "worker", "worker.go"), []byte(newWorker), 0644); err != nil {
		t.Fatalf("modifying worker.go: %v", err)
	}

	newID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute after modifying internal source failed: %v", err)
	}

	if newID == baseID {
		t.Fatalf("expected identity change when internal source changes, but both were %q", newID)
	}
}

func TestCompute_Sensitivity_GoModAndGoSum(t *testing.T) {
	dir := createBaseAgentFixture(t)

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute baseline failed: %v", err)
	}

	// 1. Add go.sum
	goSumData := "github.com/vps-manager/dep v1.0.0 h1:xyz=\ngithub.com/vps-manager/dep v1.0.0/go.mod h1:abc=\n"
	if err := os.WriteFile(filepath.Join(dir, "go.sum"), []byte(goSumData), 0644); err != nil {
		t.Fatalf("writing go.sum: %v", err)
	}

	idWithSum, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with go.sum failed: %v", err)
	}
	if idWithSum == baseID {
		t.Fatalf("expected identity change after adding go.sum")
	}

	// 2. Modify go.sum
	updatedGoSum := "github.com/vps-manager/dep v1.0.1 h1:updated=\n"
	if err := os.WriteFile(filepath.Join(dir, "go.sum"), []byte(updatedGoSum), 0644); err != nil {
		t.Fatalf("updating go.sum: %v", err)
	}

	idWithUpdatedSum, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with updated go.sum failed: %v", err)
	}
	if idWithUpdatedSum == idWithSum {
		t.Fatalf("expected identity change after modifying go.sum")
	}

	// 3. Modify go.mod
	updatedGoMod := "module github.com/vps-manager/testagent\n\ngo 1.22\n"
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(updatedGoMod), 0644); err != nil {
		t.Fatalf("updating go.mod: %v", err)
	}

	idWithUpdatedMod, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with updated go.mod failed: %v", err)
	}
	if idWithUpdatedMod == idWithUpdatedSum {
		t.Fatalf("expected identity change after modifying go.mod")
	}
}

func TestCompute_Sensitivity_Toolchain(t *testing.T) {
	dir := createBaseAgentFixture(t)

	id1, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute toolchain 1 failed: %v", err)
	}

	id2, err := Compute(dir, "go1.22.0")
	if err != nil {
		t.Fatalf("Compute toolchain 2 failed: %v", err)
	}

	if id1 == id2 {
		t.Fatalf("expected identity change when toolchain changes, but both were %q", id1)
	}
}

func TestCompute_EmbeddedAssets_IncludedAndSensitive(t *testing.T) {
	dir := createBaseAgentFixture(t)

	// Create a package with //go:embed
	embedPkgDir := filepath.Join(dir, "internal", "assets")
	if err := os.MkdirAll(embedPkgDir, 0755); err != nil {
		t.Fatalf("creating internal/assets: %v", err)
	}

	assetFile := filepath.Join(embedPkgDir, "data.txt")
	if err := os.WriteFile(assetFile, []byte("initial asset content\n"), 0644); err != nil {
		t.Fatalf("writing initial asset: %v", err)
	}

	embedSource := "package assets\n\nimport _ \"embed\"\n\n//go:embed data.txt\nvar AssetData string\n"
	if err := os.WriteFile(filepath.Join(embedPkgDir, "assets.go"), []byte(embedSource), 0644); err != nil {
		t.Fatalf("writing assets.go: %v", err)
	}

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with embedded asset failed: %v", err)
	}

	// Modify the embedded asset content
	if err := os.WriteFile(assetFile, []byte("updated asset content\n"), 0644); err != nil {
		t.Fatalf("modifying embedded asset: %v", err)
	}

	updatedID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute after modifying embedded asset failed: %v", err)
	}

	if updatedID == baseID {
		t.Fatalf("expected identity change when embedded asset content changes, but both were %q", updatedID)
	}

	// Verify embedded assets are hashed as raw bytes (changing line endings in an embedded asset changes ID)
	crlfAsset := []byte("updated asset content\r\n")
	if err := os.WriteFile(assetFile, crlfAsset, 0644); err != nil {
		t.Fatalf("writing CRLF to embedded asset: %v", err)
	}

	crlfAssetID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with raw CRLF embedded asset failed: %v", err)
	}

	if crlfAssetID == updatedID {
		t.Fatalf("expected raw bytes in embedded asset to distinguish LF from CRLF")
	}
}

func TestCompute_EmbeddedAssets_ArchUnion(t *testing.T) {
	dir := createBaseAgentFixture(t)

	platformDir := filepath.Join(dir, "internal", "platform")
	if err := os.MkdirAll(platformDir, 0755); err != nil {
		t.Fatalf("creating internal/platform: %v", err)
	}

	// arm64-only source embedding an asset
	arm64Source := "//go:build arm64\n\npackage platform\n\nimport _ \"embed\"\n\n//go:embed arm64_blob.bin\nvar Arm64Blob []byte\n"
	if err := os.WriteFile(filepath.Join(platformDir, "platform_arm64.go"), []byte(arm64Source), 0644); err != nil {
		t.Fatalf("writing platform_arm64.go: %v", err)
	}

	arm64Blob := filepath.Join(platformDir, "arm64_blob.bin")
	if err := os.WriteFile(arm64Blob, []byte{0xDE, 0xAD, 0xBE, 0xEF}, 0644); err != nil {
		t.Fatalf("writing arm64_blob.bin: %v", err)
	}

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with arm64 embedded asset failed: %v", err)
	}

	// Modify the arm64 embedded asset
	if err := os.WriteFile(arm64Blob, []byte{0xCA, 0xFE, 0xBA, 0xBE}, 0644); err != nil {
		t.Fatalf("modifying arm64_blob.bin: %v", err)
	}

	updatedID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute after modifying arm64 asset failed: %v", err)
	}

	if updatedID == baseID {
		t.Fatalf("expected identity change when linux/arm64-only embedded asset changes")
	}
}

func TestCompute_EmbeddedAssets_GoSourceCollision(t *testing.T) {
	dir := createBaseAgentFixture(t)

	// In internal/worker, add a template Go source file that is also embedded by worker.go
	templatePath := filepath.Join(dir, "internal", "worker", "template.go")
	templateCode := "package worker\n\nconst TemplateSnippet = \"template-v1\"\n"
	if err := os.WriteFile(templatePath, []byte(templateCode), 0644); err != nil {
		t.Fatalf("writing template.go: %v", err)
	}

	workerCode := "package worker\n\nimport _ \"embed\"\n\n//go:embed template.go\nvar EmbeddedCode string\n\nfunc Run() string {\n\treturn EmbeddedCode\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "internal", "worker", "worker.go"), []byte(workerCode), 0644); err != nil {
		t.Fatalf("writing worker.go: %v", err)
	}

	baseID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with embedded Go source failed: %v", err)
	}

	// Change CRLF line endings in the embedded Go source file.
	// For ordinary Go sources, CRLF is normalized to LF, so line ending changes don't change the ID.
	// But because template.go is declared in EmbedFiles, raw override hashes the raw disk bytes as embedded by the compiler.
	crlfTemplate := strings.ReplaceAll(templateCode, "\n", "\r\n")
	if err := os.WriteFile(templatePath, []byte(crlfTemplate), 0644); err != nil {
		t.Fatalf("writing CRLF template.go: %v", err)
	}

	crlfID, err := Compute(dir, "go1.21.0")
	if err != nil {
		t.Fatalf("Compute with CRLF embedded Go source failed: %v", err)
	}

	if crlfID == baseID {
		t.Fatalf("expected raw override for embedded Go source to reflect disk bytes (LF vs CRLF), but ID remained identical: %q", crlfID)
	}
}

func TestCompute_RequiredFilesFailure(t *testing.T) {
	t.Run("missing root directory", func(t *testing.T) {
		_, err := Compute(filepath.Join(t.TempDir(), "non-existent"), "go1.21.0")
		if err == nil {
			t.Fatalf("expected error for non-existent root")
		}
	})

	t.Run("missing go.mod", func(t *testing.T) {
		dir := createBaseAgentFixture(t)
		if err := os.Remove(filepath.Join(dir, "go.mod")); err != nil {
			t.Fatalf("removing go.mod: %v", err)
		}
		_, err := Compute(dir, "go1.21.0")
		if err == nil {
			t.Fatalf("expected error when go.mod is missing")
		}
		if !strings.Contains(err.Error(), "go.mod") {
			t.Fatalf("expected error message to mention go.mod, got %v", err)
		}
	})

	t.Run("missing cmd/vps-agent directory", func(t *testing.T) {
		dir := createBaseAgentFixture(t)
		if err := os.RemoveAll(filepath.Join(dir, "cmd", "vps-agent")); err != nil {
			t.Fatalf("removing cmd/vps-agent: %v", err)
		}
		_, err := Compute(dir, "go1.21.0")
		if err == nil {
			t.Fatalf("expected error when cmd/vps-agent is missing")
		}
	})

	t.Run("empty cmd/vps-agent directory", func(t *testing.T) {
		dir := createBaseAgentFixture(t)
		if err := os.Remove(filepath.Join(dir, "cmd", "vps-agent", "main.go")); err != nil {
			t.Fatalf("removing main.go: %v", err)
		}
		// Add only a test file
		if err := os.WriteFile(filepath.Join(dir, "cmd", "vps-agent", "main_test.go"), []byte("package main\n"), 0644); err != nil {
			t.Fatalf("writing main_test.go: %v", err)
		}
		_, err := Compute(dir, "go1.21.0")
		if err == nil {
			t.Fatalf("expected error when cmd/vps-agent has no non-test .go files")
		}
	})

	t.Run("missing internal directory", func(t *testing.T) {
		dir := createBaseAgentFixture(t)
		if err := os.RemoveAll(filepath.Join(dir, "internal")); err != nil {
			t.Fatalf("removing internal: %v", err)
		}
		_, err := Compute(dir, "go1.21.0")
		if err == nil {
			t.Fatalf("expected error when internal is missing")
		}
	})

	t.Run("missing declared embedded file", func(t *testing.T) {
		dir := createBaseAgentFixture(t)
		embedPkgDir := filepath.Join(dir, "internal", "assets")
		if err := os.MkdirAll(embedPkgDir, 0755); err != nil {
			t.Fatalf("creating internal/assets: %v", err)
		}
		// Declare //go:embed for non-existent file
		embedSource := "package assets\n\nimport _ \"embed\"\n\n//go:embed non_existent.txt\nvar Data string\n"
		if err := os.WriteFile(filepath.Join(embedPkgDir, "assets.go"), []byte(embedSource), 0644); err != nil {
			t.Fatalf("writing assets.go: %v", err)
		}
		_, err := Compute(dir, "go1.21.0")
		if err == nil {
			t.Fatalf("expected error when declared embedded file is missing")
		}
	})
}

func TestCompute_RealPackageAgent(t *testing.T) {
	// Look up real packages/agent root relative to current package
	realRoot := filepath.Join("..", "..")
	if _, err := os.Stat(filepath.Join(realRoot, "go.mod")); err != nil {
		t.Skipf("skipping real package test: cannot locate packages/agent root at %s", realRoot)
	}

	id1, err := Compute(realRoot, "")
	if err != nil {
		t.Fatalf("Compute real package failed: %v", err)
	}

	if !hex40Pattern.MatchString(id1) {
		t.Fatalf("expected 40-char lowercase hex string for real agent package, got %q", id1)
	}

	id2, err := Compute(realRoot, "")
	if err != nil {
		t.Fatalf("Compute real package on second call failed: %v", err)
	}

	if id1 != id2 {
		t.Fatalf("Compute real package not deterministic: %q != %q", id1, id2)
	}
}
