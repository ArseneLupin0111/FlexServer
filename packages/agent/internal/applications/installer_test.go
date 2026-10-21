package applications

import (
	"strings"
	"testing"
)

func TestCompatibleComposeVersion(t *testing.T) {
	cases := []struct {
		input    string
		expected bool
	}{
		{"2.40.3", true},
		{"v2.40.3", true},
		{"2.39.4", true},
		{"v2.39.4", true},
		{"v2.40.3-desktop", true},
		{"2.39.4+build1", true},
		{"  v2.40.3  ", true},
		{"v2.40.4", false},
		{"2.38.0", false},
		{"v1.29.2", false},
		{"v3.0.0", false},
		{"5.6.0", false},
		{"", false},
		{"invalid", false},
	}

	for _, tc := range cases {
		got := compatibleComposeVersion(tc.input)
		if got != tc.expected {
			t.Errorf("compatibleComposeVersion(%q) = %v; want %v", tc.input, got, tc.expected)
		}
	}
}

func TestPlatformChecksumMatrix(t *testing.T) {
	if composeTargetRelease != "v2.40.3" {
		t.Fatalf("expected target release v2.40.3, got %s", composeTargetRelease)
	}

	targets := []string{"v2.40.3", "v2.39.4"}
	for _, rel := range targets {
		digests, ok := composeReleaseSHA256[rel]
		if !ok {
			t.Fatalf("missing release %s in composeReleaseSHA256", rel)
		}
		for _, arch := range []string{"amd64", "arm64"} {
			hash, ok := digests[arch]
			if !ok {
				t.Errorf("missing arch %s for release %s", arch, rel)
			}
			if len(hash) != 64 {
				t.Errorf("invalid hash length %d for %s/%s", len(hash), rel, arch)
			}
		}
	}

	// Verify exact provenance hashes
	wantV2403Amd64 := "dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372"
	wantV2403Arm64 := "d26373b19e89160546d15407516cc59f453030d9bc5b43ba7faf16f7b4980137"
	if got := composeReleaseSHA256["v2.40.3"]["amd64"]; got != wantV2403Amd64 {
		t.Errorf("v2.40.3 amd64 hash = %s; want %s", got, wantV2403Amd64)
	}
	if got := composeReleaseSHA256["v2.40.3"]["arm64"]; got != wantV2403Arm64 {
		t.Errorf("v2.40.3 arm64 hash = %s; want %s", got, wantV2403Arm64)
	}
}

func TestDockerCLIMissingGuidance(t *testing.T) {
	err := &DockerCLIMissingError{
		Reason:       ErrDockerCLIMissing,
		Instructions: DockerCLIManualInstructions,
	}
	if err.Error() != "docker_cli_missing" {
		t.Errorf("err.Error() = %q; want %q", err.Error(), "docker_cli_missing")
	}
	if !strings.Contains(err.Instructions, "docker-ce-cli") {
		t.Errorf("instructions missing docker-ce-cli package reference: %s", err.Instructions)
	}
}
