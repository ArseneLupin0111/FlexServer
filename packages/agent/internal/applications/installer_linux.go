//go:build linux

package applications

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

func probeDockerCLI() DockerCLIProbeResult {
	candidates := []string{"/usr/bin/docker", "/usr/local/bin/docker"}
	for _, p := range candidates {
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 {
			return DockerCLIProbeResult{Path: p, Present: true, Trusted: false, Reason: "docker_cli_untrusted_owner"}
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			return DockerCLIProbeResult{Path: p, Present: true, Trusted: false, Reason: "docker_cli_not_executable"}
		}
		if info.Mode().Perm()&0o022 != 0 {
			return DockerCLIProbeResult{Path: p, Present: true, Trusted: false, Reason: "docker_cli_insecure_permissions"}
		}
		return DockerCLIProbeResult{Path: p, Present: true, Trusted: true}
	}
	return DockerCLIProbeResult{Present: false, Trusted: false, Reason: ErrDockerCLIMissing}
}

func trustedDockerCLI() bool {
	return probeDockerCLI().Trusted
}

func prepareRuntime(ctx context.Context) (*ComposeRuntime, error) {
	// Trusted compatible no-install: if already present and compatible, reuse without modification.
	if rt, err := DetectRuntime(); err == nil && rt.Mode == ModePlugin && compatibleComposeVersion(rt.Version) {
		return rt, nil
	}
	cliProbe := probeDockerCLI()
	if !cliProbe.Trusted {
		return nil, &DockerCLIMissingError{
			Reason:       cliProbe.Reason,
			Instructions: DockerCLIManualInstructions,
		}
	}
	return installComposeRuntime(ctx)
}

func installComposeRuntime(ctx context.Context) (*ComposeRuntime, error) {
	archMap := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}
	arch, ok := archMap[runtime.GOARCH]
	if !ok {
		return nil, fmt.Errorf("unsupported_architecture: %s", runtime.GOARCH)
	}
	digests, ok := composeReleaseSHA256[composeTargetRelease]
	if !ok {
		return nil, errors.New("compose_release_unconfigured")
	}
	expectedHashHex, ok := digests[runtime.GOARCH]
	if !ok {
		return nil, fmt.Errorf("unsupported_architecture: %s", runtime.GOARCH)
	}
	if os.Geteuid() != 0 {
		return nil, errors.New("root_privileges_required")
	}
	url := "https://github.com/docker/compose/releases/download/" + composeTargetRelease + "/docker-compose-linux-" + arch
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	client := &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "https" {
				return errors.New("insecure redirect rejected")
			}
			if !trustedRedirectHost(req.URL.Hostname()) {
				return errors.New("redirect to untrusted host rejected")
			}
			return nil
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, composeDownloadLimit+1))
	if err != nil || len(data) == 0 || len(data) > composeDownloadLimit {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	want, err := hex.DecodeString(expectedHashHex)
	if err != nil {
		return nil, errors.New("invalid_digest_configuration")
	}
	got := sha256.Sum256(data)
	if subtle.ConstantTimeCompare(got[:], want) != 1 {
		return nil, errors.New("compose_checksum_mismatch")
	}
	if err = os.MkdirAll(filepath.Dir(composeInstallPath), 0755); err != nil {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	tmp, err := os.CreateTemp(filepath.Dir(composeInstallPath), ".docker-compose-*.tmp")
	if err != nil {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err = tmp.Chmod(0755); err == nil {
		_, err = tmp.Write(data)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	if err = os.Rename(tmpName, composeInstallPath); err != nil {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	if err = os.Chmod(composeInstallPath, 0755); err != nil {
		return nil, errors.New(ErrRuntimeUnavailable)
	}
	if rt, err := DetectRuntime(); err == nil && rt.Path == composeInstallPath && compatibleComposeVersion(rt.Version) {
		return rt, nil
	}
	return nil, fmt.Errorf("%s", ErrRuntimeUnavailable)
}

func trustedRedirectHost(hostname string) bool {
	switch hostname {
	case "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com":
		return true
	}
	return false
}
