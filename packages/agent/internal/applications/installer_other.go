//go:build !linux

package applications

import (
	"context"
	"fmt"
)

type ComposeRuntime struct {
	Mode    string
	Path    string
	Version string
}

func probeDockerCLI() DockerCLIProbeResult {
	return DockerCLIProbeResult{
		Present: false,
		Trusted: false,
		Reason:  "docker_cli_unsupported_os",
	}
}

func trustedDockerCLI() bool {
	return false
}

func prepareRuntime(ctx context.Context) (*ComposeRuntime, error) {
	return nil, fmt.Errorf("applications: runtime preparation requires Linux (current: unsupported OS)")
}

func installComposeRuntime(ctx context.Context) (*ComposeRuntime, error) {
	return nil, fmt.Errorf("applications: runtime installation requires Linux")
}
