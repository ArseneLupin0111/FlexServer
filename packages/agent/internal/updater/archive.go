package updater

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// maxSiblingManifestBytes bounds a captured sibling manifest (defense against
// a decompression bomb hiding outside the stripped tree).
const maxSiblingManifestBytes = 1 << 20

// siblingManifestNames are the top-level regular-file names captured when
// extracting the AI rootfs tarball for the ai-install operation. The build
// pipeline (scripts/agent/build-rootfs.mjs) publishes the manifest as a
// sibling of the rootfs/ tree inside the archive.
var siblingManifestNames = map[string]bool{
	"manifest.json":        true,
	"rootfs.manifest.json": true,
}

// ExtractTarGz extracts a .tar.gz archive into destDir with security controls:
//   - Rejects path traversal (..) and absolute paths
//   - Strips stripPrefix if non-empty
//   - Enforces root ownership (UID 0, GID 0) when running as root
//   - Regular files and directories only; rejects symlinks pointing outside destDir
//
// Entries outside the strip prefix (e.g. a manifest.json sibling of rootfs/)
// are skipped; use ExtractTarGzCaptureSibling when they must be captured.
func ExtractTarGz(tarGzPath, destDir, stripPrefix string) error {
	_, err := extractTarGzCapture(tarGzPath, destDir, stripPrefix, nil)
	return err
}

// ExtractTarGzCaptureSibling behaves like ExtractTarGz and additionally
// captures the content of a top-level sibling manifest (manifest.json or
// rootfs.manifest.json) beside the stripped tree. It returns nil when the
// archive carries no such sibling.
func ExtractTarGzCaptureSibling(tarGzPath, destDir, stripPrefix string) ([]byte, error) {
	return extractTarGzCapture(tarGzPath, destDir, stripPrefix, siblingManifestNames)
}

// RejectSymlinkPath fails closed when any EXISTING component of dir is not a
// real directory (a symlink or a regular file). Privileged extraction clears
// and repopulates destDir; a planted symlink at destDir or any of its parents
// would redirect those root-owned writes outside the canonical tree. Missing
// components are fine — provisioning creates them root-owned.
func RejectSymlinkPath(dir string) error {
	clean := filepath.Clean(dir)
	vol := filepath.VolumeName(clean)
	rest := strings.TrimPrefix(clean, vol)
	rest = strings.Trim(rest, string(filepath.Separator))
	cur := vol + string(filepath.Separator)
	for _, seg := range strings.Split(rest, string(filepath.Separator)) {
		if seg == "" {
			continue
		}
		cur = filepath.Join(cur, seg)
		fi, err := os.Lstat(cur)
		if err != nil {
			if os.IsNotExist(err) {
				// Nothing deeper can exist either.
				return nil
			}
			return fmt.Errorf("lstat %s: %w", cur, err)
		}
		// Lstat never follows: a symlink fails IsDir even when it points at
		// a directory.
		if !fi.IsDir() {
			return fmt.Errorf("extraction target %s passes through non-directory %s (symlink planted?)", clean, cur)
		}
	}
	return nil
}

func extractTarGzCapture(tarGzPath, destDir, stripPrefix string, capture map[string]bool) ([]byte, error) {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return nil, fmt.Errorf("open archive %s: %w", tarGzPath, err)
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("gzip reader for %s: %w", tarGzPath, err)
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	cleanDest := filepath.Clean(destDir)
	if err := RejectSymlinkPath(cleanDest); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cleanDest, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir dest %s: %w", cleanDest, err)
	}

	// Remove stale destination entries so the target directory exactly reflects the archive
	if entries, err := os.ReadDir(cleanDest); err == nil {
		for _, e := range entries {
			_ = os.RemoveAll(filepath.Join(cleanDest, e.Name()))
		}
	}

	stripPrefix = strings.Trim(stripPrefix, "/")
	if stripPrefix != "" {
		stripPrefix += "/"
	}
	var captured []byte
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read tar entry: %w", err)
		}

		cleanName := filepath.Clean(hdr.Name)
		if strings.HasPrefix(cleanName, "/") || strings.HasPrefix(cleanName, `\`) || strings.HasPrefix(cleanName, "..") || strings.Contains(cleanName, "/../") || strings.Contains(cleanName, `\..\`) {
			return nil, fmt.Errorf("tar entry %q contains unsafe path traversal", hdr.Name)
		}

		relPath := hdr.Name
		if stripPrefix != "" {
			if strings.HasPrefix(relPath, stripPrefix) {
				relPath = strings.TrimPrefix(relPath, stripPrefix)
			} else if relPath == strings.TrimSuffix(stripPrefix, "/") {
				continue
			} else {
				// Sibling of the stripped tree. For the AI first-install the
				// rootfs manifest ships beside rootfs/ and must be captured,
				// not silently dropped.
				if capture != nil && hdr.Typeflag == tar.TypeReg {
					name := filepath.ToSlash(filepath.Clean(relPath))
					if !strings.Contains(name, "/") && capture[name] {
						data, err := io.ReadAll(io.LimitReader(tr, maxSiblingManifestBytes+1))
						if err != nil {
							return nil, fmt.Errorf("read sibling %q: %w", hdr.Name, err)
						}
						if len(data) > maxSiblingManifestBytes {
							return nil, fmt.Errorf("sibling %q exceeds %d bytes bound", hdr.Name, maxSiblingManifestBytes)
						}
						captured = data
					}
				}
				continue
			}
		}

		relPath = strings.Trim(relPath, "/")
		if relPath == "" || relPath == "." {
			continue
		}

		target := filepath.Join(cleanDest, relPath)
		if !strings.HasPrefix(target, cleanDest+string(filepath.Separator)) && target != cleanDest {
			return nil, fmt.Errorf("tar entry %q escapes destination directory %s", hdr.Name, cleanDest)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return nil, fmt.Errorf("create dir %s: %w", target, err)
			}
			if os.Geteuid() == 0 {
				_ = os.Chown(target, 0, 0)
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return nil, fmt.Errorf("mkdir parent %s: %w", filepath.Dir(target), err)
			}
			mode := os.FileMode(hdr.Mode & 0o777)
			if mode == 0 {
				mode = 0o644
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
			if err != nil {
				return nil, fmt.Errorf("create file %s: %w", target, err)
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return nil, fmt.Errorf("write file %s: %w", target, err)
			}
			_ = out.Sync()
			out.Close()
			if os.Geteuid() == 0 {
				_ = os.Chown(target, 0, 0)
			}
		case tar.TypeSymlink:
			linkTarget := hdr.Linkname
			// Ensure relative symlink target does not escape cleanDest
			if !strings.HasPrefix(linkTarget, "/") {
				resolved := filepath.Clean(filepath.Join(filepath.Dir(target), linkTarget))
				if !strings.HasPrefix(resolved, cleanDest+string(filepath.Separator)) && resolved != cleanDest {
					return nil, fmt.Errorf("unsafe symlink %s -> %s escapes %s", target, linkTarget, cleanDest)
				}
			}
			_ = os.Remove(target)
			if err := os.Symlink(linkTarget, target); err != nil {
				return nil, fmt.Errorf("create symlink %s -> %s: %w", target, linkTarget, err)
			}
			// Skip unsupported entry types
			continue
		}
	}

	return captured, fsyncDir(cleanDest)
}
