package buildidentity

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// BuildRecipe is the literal build recipe string incorporated into the build identity.
const BuildRecipe = "linux;CGO_ENABLED=0;trimpath;buildvcs=false;identity-v1"

// Compute calculates a deterministic 40-character lowercase hexadecimal build identity
// from the agent package sources rooted at root.
//
// The identity is computed by hashing:
// 1. Literal build recipe: "linux;CGO_ENABLED=0;trimpath;buildvcs=false;identity-v1"
// 2. Toolchain version: toolchain argument if non-empty, otherwise runtime.Version()
// 3. All non-test Go source files under cmd/vps-agent and internal (excluding buildidentity)
// 4. go.mod (required) and go.sum (if present)
// 5. Embedded runtime assets discovered via `go list -json` for linux/amd64 and linux/arm64
//
// Go and module files are normalized to LF line endings. Embedded assets are hashed as raw bytes.
// Each file entry is hashed with its normalized relative path and length-prefixed bytes.
// SHA-256 digest is truncated to 40 hex characters.
func Compute(root string, toolchain string) (string, error) {
	if strings.TrimSpace(root) == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolving root directory: %w", err)
	}
	if realRoot, err := filepath.EvalSymlinks(absRoot); err == nil {
		absRoot = realRoot
	}
	stat, err := os.Stat(absRoot)
	if err != nil {
		return "", fmt.Errorf("stat root directory %s: %w", absRoot, err)
	}
	if !stat.IsDir() {
		return "", fmt.Errorf("root path %s is not a directory", absRoot)
	}

	effectiveToolchain := strings.TrimSpace(toolchain)
	if effectiveToolchain == "" {
		effectiveToolchain = runtime.Version()
	}

	files := make(map[string][]byte)

	// 1. Required go.mod
	goModPath := filepath.Join(absRoot, "go.mod")
	goModData, err := os.ReadFile(goModPath)
	if err != nil {
		return "", fmt.Errorf("reading required go.mod in %s: %w", absRoot, err)
	}
	files["go.mod"] = normalizeCRLF(goModData)

	// 2. Optional go.sum
	goSumPath := filepath.Join(absRoot, "go.sum")
	if goSumData, err := os.ReadFile(goSumPath); err == nil {
		files["go.sum"] = normalizeCRLF(goSumData)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("reading go.sum in %s: %w", absRoot, err)
	}

	// 3. Required cmd/vps-agent non-test Go files
	cmdVpsAgentDir := filepath.Join(absRoot, "cmd", "vps-agent")
	if s, err := os.Stat(cmdVpsAgentDir); err != nil || !s.IsDir() {
		return "", fmt.Errorf("required directory cmd/vps-agent missing in %s", absRoot)
	}
	cmdFiles, err := collectGoFiles(absRoot, cmdVpsAgentDir, false)
	if err != nil {
		return "", fmt.Errorf("collecting cmd/vps-agent Go files: %w", err)
	}
	if len(cmdFiles) == 0 {
		return "", fmt.Errorf("no non-test Go source files found in cmd/vps-agent")
	}
	for p, data := range cmdFiles {
		files[p] = data
	}

	// 4. Required internal non-test Go files (excluding internal/buildidentity)
	internalDir := filepath.Join(absRoot, "internal")
	if s, err := os.Stat(internalDir); err != nil || !s.IsDir() {
		return "", fmt.Errorf("required directory internal missing in %s", absRoot)
	}
	internalFiles, err := collectGoFiles(absRoot, internalDir, true)
	if err != nil {
		return "", fmt.Errorf("collecting internal Go files: %w", err)
	}
	if len(internalFiles) == 0 {
		return "", fmt.Errorf("no non-test Go source files found in internal")
	}
	for p, data := range internalFiles {
		files[p] = data
	}

	// 5. Embedded runtime assets union across linux/amd64 and linux/arm64.
	// In the union of normalized relative paths, embedded assets are hashed as raw bytes
	// (overriding text normalization if an embedded file happens to be Go/module source).
	embedAssets, err := enumerateEmbedFiles(absRoot)
	if err != nil {
		return "", fmt.Errorf("enumerating embedded assets: %w", err)
	}
	for normRel, rawData := range embedAssets {
		files[normRel] = rawData
	}

	// Sort all relative paths deterministically
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	hasher := sha256.New()

	writeEntry := func(name string, payload []byte) {
		hasher.Write([]byte(name))
		hasher.Write([]byte{0})
		var lenBuf [8]byte
		binary.BigEndian.PutUint64(lenBuf[:], uint64(len(payload)))
		hasher.Write(lenBuf[:])
		hasher.Write(payload)
	}

	// Literal recipe and effective toolchain
	writeEntry(":recipe", []byte(BuildRecipe))
	writeEntry(":toolchain", []byte(effectiveToolchain))

	for _, p := range paths {
		writeEntry(p, files[p])
	}

	sum := hasher.Sum(nil)
	fullHex := hex.EncodeToString(sum)
	return fullHex[:40], nil
}

func collectGoFiles(absRoot, targetDir string, excludeBuildIdentity bool) (map[string][]byte, error) {
	res := make(map[string][]byte)
	err := filepath.WalkDir(targetDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relFromRoot, err := filepath.Rel(absRoot, path)
		if err != nil {
			return err
		}
		normRel := filepath.ToSlash(relFromRoot)

		if d.IsDir() {
			name := d.Name()
			if name == "testdata" || name == ".git" || name == "dist" || name == "bin" || name == "vendor" {
				return filepath.SkipDir
			}
			if excludeBuildIdentity && (normRel == "internal/buildidentity" || strings.HasPrefix(normRel, "internal/buildidentity/")) {
				return filepath.SkipDir
			}
			return nil
		}

		if !d.Type().IsRegular() {
			return nil
		}

		name := d.Name()
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		if strings.HasSuffix(name, "_test.go") {
			return nil
		}
		if strings.HasSuffix(name, ".gen.go") || strings.HasSuffix(name, ".pb.go") {
			return nil
		}
		if excludeBuildIdentity && strings.HasPrefix(normRel, "internal/buildidentity/") {
			return nil
		}

		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("reading %s: %w", normRel, err)
		}

		if isGeneratedSource(raw) {
			return nil
		}

		res[normRel] = normalizeCRLF(raw)
		return nil
	})
	return res, err
}

func isGeneratedSource(data []byte) bool {
	sc := bufio.NewScanner(bytes.NewReader(data))
	lines := 0
	for sc.Scan() && lines < 30 {
		line := sc.Text()
		if strings.HasPrefix(line, "// Code generated ") && strings.Contains(line, "DO NOT EDIT") {
			return true
		}
		lines++
	}
	return false
}

func normalizeCRLF(data []byte) []byte {
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	data = bytes.ReplaceAll(data, []byte("\r"), []byte("\n"))
	return data
}

func enumerateEmbedFiles(absRoot string) (map[string][]byte, error) {
	arches := []string{"amd64", "arm64"}
	embeddedPaths := make(map[string]string) // normRelPath -> fullPath

	for _, arch := range arches {
		cmd := exec.Command("go", "list", "-json", "./cmd/vps-agent/...", "./internal/...")
		cmd.Dir = absRoot
		cmd.Env = makeGoListEnv(arch)

		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("go list for linux/%s failed: %w (stderr: %s)", arch, err, strings.TrimSpace(stderr.String()))
		}

		dec := json.NewDecoder(&stdout)
		for {
			var pkg struct {
				Dir        string   `json:"Dir"`
				ImportPath string   `json:"ImportPath"`
				EmbedFiles []string `json:"EmbedFiles"`
				Error      *struct {
					Err string `json:"Err"`
				} `json:"Error"`
			}
			if err := dec.Decode(&pkg); err != nil {
				if errors.Is(err, io.EOF) {
					break
				}
				return nil, fmt.Errorf("decoding go list output for linux/%s: %w", arch, err)
			}

			if pkg.Error != nil && pkg.Error.Err != "" {
				return nil, fmt.Errorf("go list reported package error for %s on linux/%s: %s", pkg.ImportPath, arch, pkg.Error.Err)
			}

			if len(pkg.EmbedFiles) == 0 {
				continue
			}

			realPkgDir := pkg.Dir
			if rp, err := filepath.EvalSymlinks(pkg.Dir); err == nil {
				realPkgDir = rp
			}

			relDir, err := filepath.Rel(absRoot, realPkgDir)
			if err != nil {
				return nil, fmt.Errorf("resolving relative package dir %s: %w", realPkgDir, err)
			}
			normRelDir := filepath.ToSlash(relDir)
			if normRelDir == "internal/buildidentity" || strings.HasPrefix(normRelDir, "internal/buildidentity/") {
				continue
			}

			for _, f := range pkg.EmbedFiles {
				fullPath := filepath.Join(pkg.Dir, f)
				realFilePath := fullPath
				if rp, err := filepath.EvalSymlinks(fullPath); err == nil {
					realFilePath = rp
				}
				relPath, err := filepath.Rel(absRoot, realFilePath)
				if err != nil {
					return nil, fmt.Errorf("resolving relative path for embed file %s: %w", fullPath, err)
				}
				normRel := filepath.ToSlash(relPath)
				embeddedPaths[normRel] = fullPath
			}
		}
	}

	result := make(map[string][]byte, len(embeddedPaths))
	for normRel, fullPath := range embeddedPaths {
		data, err := os.ReadFile(fullPath)
		if err != nil {
			return nil, fmt.Errorf("missing declared embedded file %s: %w", normRel, err)
		}
		result[normRel] = data
	}

	return result, nil
}

func makeGoListEnv(arch string) []string {
	baseEnv := os.Environ()
	filtered := make([]string, 0, len(baseEnv)+3)
	for _, e := range baseEnv {
		upper := strings.ToUpper(e)
		if strings.HasPrefix(upper, "GOOS=") ||
			strings.HasPrefix(upper, "GOARCH=") ||
			strings.HasPrefix(upper, "CGO_ENABLED=") {
			continue
		}
		filtered = append(filtered, e)
	}
	filtered = append(filtered, "GOOS=linux", "GOARCH="+arch, "CGO_ENABLED=0")
	return filtered
}
