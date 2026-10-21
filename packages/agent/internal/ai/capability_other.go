//go:build !linux

package ai

// DetectCapabilities returns a fail-closed capability structure on non-Linux platforms.
func DetectCapabilities(rootfsDir, rootfsManifest, profilesDir string) HostCapabilities {
	caps := HostCapabilities{
		Supported:         false,
		UnsupportedReason: "unsupported OS: non-Linux host",
		CgroupV2:          false,
		Namespaces:        false,
		Seccomp:           false,
		MinimalRootfs:     false,
		Profiles:          []string{},
	}
	if profilesDir != "" {
		if digest, err := CalculateProfilesDigest(profilesDir); err == nil {
			caps.ProfilesDigest = digest
		}
	}
	if rootfsManifest != "" {
		if digest, err := CalculateManifestDigest(rootfsManifest); err == nil {
			caps.RootfsDigest = digest
		}
	}
	return caps
}
