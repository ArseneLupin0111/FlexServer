package applications

import (
	"strings"
)

const (
	// Pinned target release for new installations and upgrades.
	// Official release published 2025-10-30; maintained Compose v2.
	composeTargetRelease = "v2.40.3"

	// Retain alias for any internal callers expecting composeRelease.
	composeRelease = composeTargetRelease

	// Fixed absolute path for the FlexServer-managed plugin.
	composeInstallPath = "/usr/local/lib/flexserver/compose/docker-compose"

	// Bounded limit for downloaded runtime binaries (128 MiB).
	composeDownloadLimit = 128 << 20

	// Stable error codes and guidance for missing base CLI.
	ErrDockerCLIMissing = "docker_cli_missing"
	DockerCLIManualInstructions = "Docker CLI (/usr/bin/docker or /usr/local/bin/docker) is missing or untrusted. Please install the official docker-ce-cli package (e.g. 'apt-get install -y docker-ce-cli' or 'yum install -y docker-ce-cli') and verify the root-owned executable exists before preparing Docker Compose."
)

// DockerCLIMissingError provides structured error info for missing base CLI.
type DockerCLIMissingError struct {
	Reason       string
	Instructions string
}

func (e *DockerCLIMissingError) Error() string {
	return e.Reason
}

// DockerCLIProbeResult captures the result of probing host Docker CLI.
type DockerCLIProbeResult struct {
	Path    string
	Present bool
	Trusted bool
	Reason  string
}

// Official SHA256 checksums from docker/compose release assets.
// v2.40.3 (published 2025-10-30, latest stable maintained v2):
// - linux-x86_64: dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372
// - linux-aarch64: d26373b19e89160546d15407516cc59f453030d9bc5b43ba7faf16f7b4980137
//
// v2.39.4 (compatible fixture release):
// - linux-x86_64: 7af95166a730b87e172d4fc9aefea8725d3c6c7327d59149267b452114ddb7d4
// - linux-aarch64: 49082844b87f03cdcd5f5bbef1ba8c9c897b7a2dfb80cea18d61ec8ca6117e0c
var composeReleaseSHA256 = map[string]map[string]string{
	"v2.40.3": {
		"amd64": "dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372",
		"arm64": "d26373b19e89160546d15407516cc59f453030d9bc5b43ba7faf16f7b4980137",
	},
	"v2.39.4": {
		"amd64": "7af95166a730b87e172d4fc9aefea8725d3c6c7327d59149267b452114ddb7d4",
		"arm64": "49082844b87f03cdcd5f5bbef1ba8c9c897b7a2dfb80cea18d61ec8ca6117e0c",
	},
}

// Default checksums map for target release.
var composeSHA256 = composeReleaseSHA256[composeTargetRelease]

// compatibleComposeVersion verifies if the discovered version belongs to
// our explicit compatibility matrix of reviewed maintained releases.
// Both v2.40.3 (target release) and v2.39.4 (existing fixture) are supported.
// Unknown minor/patch versions are not presumed compatible from their major number.
func compatibleComposeVersion(version string) bool {
	v := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if idx := strings.IndexAny(v, "-+ \t\r\n"); idx != -1 {
		v = v[:idx]
	}
	switch v {
	case "2.40.3", "2.39.4":
		return true
	default:
		return false
	}
}
