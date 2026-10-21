//go:build linux

package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// DetectCapabilities inspects real Linux host confinement primitives.
// Fails closed if any required confinement primitive (namespaces, cgroup v2,
// seccomp, pinned rootfs manifest and root ownership, or profile digests) is missing or invalid.
func DetectCapabilities(rootfsDir, rootfsManifest, profilesDir string) HostCapabilities {
	caps := HostCapabilities{
		Supported: false,
		Profiles:  []string{},
	}

	var reasons []string

	// 1. Namespace probe: check /proc/self/ns files AND test unshare capability
	nsRequired := []string{"mnt", "pid", "ipc", "uts", "net"}
	hasNamespaces := true
	for _, ns := range nsRequired {
		if _, err := os.Stat("/proc/self/ns/" + ns); err != nil {
			hasNamespaces = false
			reasons = append(reasons, fmt.Sprintf("namespace %s unavailable: %v", ns, err))
			break
		}
	}

	// Active unshare probe: test if the unshare syscall is allowed without flags
	if hasNamespaces {
		if err := unix.Unshare(0); err != nil && err != unix.EINVAL {
			hasNamespaces = false
			reasons = append(reasons, fmt.Sprintf("unshare syscall blocked by host: %v", err))
		}
	}
	caps.Namespaces = hasNamespaces

	// 2. Cgroup v2 probe: check /sys/fs/cgroup/cgroup.controllers for cpu, memory, pids
	hasCgroupV2 := false
	if controllersData, err := os.ReadFile("/sys/fs/cgroup/cgroup.controllers"); err == nil {
		controllers := string(controllersData)
		if strings.Contains(controllers, "cpu") &&
			strings.Contains(controllers, "memory") &&
			strings.Contains(controllers, "pids") {
			hasCgroupV2 = true
		} else {
			reasons = append(reasons, fmt.Sprintf("cgroup v2 controllers incomplete (found %q, requires cpu, memory, pids)", strings.TrimSpace(controllers)))
		}
	} else {
		reasons = append(reasons, fmt.Sprintf("cgroup v2 unavailable: %v", err))
	}
	caps.CgroupV2 = hasCgroupV2

	// 3. Seccomp probe: verify kernel support for SECCOMP_MODE_FILTER
	hasSeccomp := false
	val, err := unix.PrctlRetInt(unix.PR_GET_SECCOMP, 0, 0, 0, 0)
	if err == nil || val >= 0 {
		hasSeccomp = true
	} else if _, err := os.Stat("/proc/sys/kernel/seccomp"); err == nil {
		hasSeccomp = true
	}
	if !hasSeccomp {
		reasons = append(reasons, "kernel seccomp filter support unavailable")
	}
	caps.Seccomp = hasSeccomp

	// 4. Pinned minimal rootfs manifest and content verification
	hasRootfs := false
	if rootfsDir == "" || rootfsManifest == "" {
		reasons = append(reasons, "minimal rootfs directory and manifest path must both be configured")
	} else {
		rfStat, err := os.Stat(rootfsDir)
		if err != nil {
			reasons = append(reasons, fmt.Sprintf("rootfs directory %s inaccessible: %v", rootfsDir, err))
		} else {
			// Verify rootfs directory root ownership and no world/group writable bits
			if sysStat, ok := rfStat.Sys().(*unix.Stat_t); ok {
				if sysStat.Uid != 0 || sysStat.Gid != 0 {
					reasons = append(reasons, fmt.Sprintf("rootfs directory %s is not root-owned (UID=%d, GID=%d)", rootfsDir, sysStat.Uid, sysStat.Gid))
				} else if rfStat.Mode().Perm()&0022 != 0 {
					reasons = append(reasons, fmt.Sprintf("rootfs directory %s is group or world writable (mode=0%o)", rootfsDir, rfStat.Mode().Perm()))
				} else {
					// Verify rootfs manifest exists, is root-owned, and compute digest
					mStat, err := os.Stat(rootfsManifest)
					if err != nil {
						reasons = append(reasons, fmt.Sprintf("rootfs manifest %s inaccessible: %v", rootfsManifest, err))
					} else if mSys, ok := mStat.Sys().(*unix.Stat_t); ok && (mSys.Uid != 0 || mSys.Gid != 0) {
						reasons = append(reasons, fmt.Sprintf("rootfs manifest %s is not root-owned", rootfsManifest))
					} else {
						manifestDigest, err := CalculateManifestDigest(rootfsManifest)
						if err != nil || manifestDigest == "" {
							reasons = append(reasons, fmt.Sprintf("calculating manifest digest: %v", err))
						} else {
							caps.RootfsDigest = manifestDigest
							// Verify manifest contents against actual rootfs directory
							if err := verifyRootfsContents(rootfsDir, rootfsManifest); err != nil {
								reasons = append(reasons, fmt.Sprintf("rootfs verification against manifest failed: %v", err))
							} else {
								hasRootfs = true
							}
						}
					}
				}
			} else {
				reasons = append(reasons, "unable to determine rootfs file ownership")
			}
		}
	}
	caps.MinimalRootfs = hasRootfs

	// 5. Profiles directory & digest verification
	hasProfiles := false
	if profilesDir == "" {
		reasons = append(reasons, "profiles directory path must be configured")
	} else {
		pStat, err := os.Stat(profilesDir)
		if err != nil {
			reasons = append(reasons, fmt.Sprintf("profiles directory %s inaccessible: %v", profilesDir, err))
		} else {
			if sysStat, ok := pStat.Sys().(*unix.Stat_t); ok {
				if sysStat.Uid != 0 || sysStat.Gid != 0 {
					reasons = append(reasons, fmt.Sprintf("profiles directory %s is not root-owned (UID=%d, GID=%d)", profilesDir, sysStat.Uid, sysStat.Gid))
				} else if pStat.Mode().Perm()&0002 != 0 {
					reasons = append(reasons, fmt.Sprintf("profiles directory %s is world-writable (mode=0%o)", profilesDir, pStat.Mode().Perm()))
				} else {
					profDigest, err := CalculateProfilesDigest(profilesDir)
					if err != nil || profDigest == "" {
						reasons = append(reasons, "profiles directory contains no valid profiles or digest calculation failed")
					} else {
						caps.ProfilesDigest = profDigest
						if reg, err := LoadProfileRegistry(profilesDir); err == nil {
							caps.Profiles = reg.List()
						}
						hasProfiles = true
					}
				}
			} else {
				reasons = append(reasons, "unable to determine profiles directory ownership")
			}
		}
	}

	// 6. Overall Support determination
	if len(reasons) > 0 {
		caps.Supported = false
		caps.UnsupportedReason = strings.Join(reasons, "; ")
	} else if hasNamespaces && hasCgroupV2 && hasSeccomp && hasRootfs && hasProfiles && caps.RootfsDigest != "" && caps.ProfilesDigest != "" {
		caps.Supported = true
	} else {
		caps.Supported = false
		caps.UnsupportedReason = "one or more confinement prerequisites failed verification"
	}

	return caps
}

// verifyRootfsContents parses the manifest and ensures listed critical binaries exist,
// are root-owned, non-writable, and match their expected digests.
func verifyRootfsContents(rootfsDir, manifestPath string) error {
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}

	manifest, err := DecodeRootfsManifest(data)
	if err != nil {
		return fmt.Errorf("rootfs manifest schema mismatch: %w", err)
	}

	for _, f := range manifest.Files {
		if err := checkRootfsFile(rootfsDir, f.Path, f.Sha256); err != nil {
			return err
		}
	}
	return nil
}

func checkRootfsFile(rootfsDir, relPath, expectedDigest string) error {
	cleanRel := filepath.Clean(strings.TrimPrefix(relPath, "/"))
	fullPath := filepath.Join(rootfsDir, cleanRel)

	st, err := os.Lstat(fullPath)
	if err != nil {
		return fmt.Errorf("missing rootfs file %s: %w", cleanRel, err)
	}

	// Must be root-owned
	if sys, ok := st.Sys().(*unix.Stat_t); ok {
		if sys.Uid != 0 || sys.Gid != 0 {
			return fmt.Errorf("rootfs file %s is not root-owned (UID=%d, GID=%d)", cleanRel, sys.Uid, sys.Gid)
		}
	}

	// Must not be group/world writable
	if st.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("rootfs file %s is writable (mode=0%o)", cleanRel, st.Mode().Perm())
	}

	// Verify digest if file is regular
	if st.Mode().IsRegular() && expectedDigest != "" {
		expectedClean := strings.TrimPrefix(expectedDigest, "sha256:")
		f, err := os.Open(fullPath)
		if err != nil {
			return err
		}
		defer f.Close()

		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return err
		}
		actual := hex.EncodeToString(h.Sum(nil))
		if actual != expectedClean {
			return fmt.Errorf("digest mismatch for %s: expected %s, got %s", cleanRel, expectedClean, actual)
		}
	}

	return nil
}
