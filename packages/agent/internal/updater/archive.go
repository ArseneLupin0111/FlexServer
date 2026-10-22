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

// ExtractTarGz extracts a .tar.gz archive into destDir with security controls:
//   - Rejects path traversal (..) and absolute paths
//   - Strips stripPrefix if non-empty
//   - Enforces root ownership (UID 0, GID 0) when running as root
//   - Regular files and directories only; rejects symlinks pointing outside destDir
func ExtractTarGz(tarGzPath, destDir, stripPrefix string) error {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return fmt.Errorf("open archive %s: %w", tarGzPath, err)
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip reader for %s: %w", tarGzPath, err)
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	cleanDest := filepath.Clean(destDir)
	if err := os.MkdirAll(cleanDest, 0o755); err != nil {
		return fmt.Errorf("mkdir dest %s: %w", cleanDest, err)
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
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read tar entry: %w", err)
		}

		cleanName := filepath.Clean(hdr.Name)
		if strings.HasPrefix(cleanName, "/") || strings.HasPrefix(cleanName, `\`) || strings.HasPrefix(cleanName, "..") || strings.Contains(cleanName, "/../") || strings.Contains(cleanName, `\..\`) {
			return fmt.Errorf("tar entry %q contains unsafe path traversal", hdr.Name)
		}

		relPath := hdr.Name
		if stripPrefix != "" {
			if strings.HasPrefix(relPath, stripPrefix) {
				relPath = strings.TrimPrefix(relPath, stripPrefix)
			} else if relPath == strings.TrimSuffix(stripPrefix, "/") {
				continue
			} else {
				continue
			}
		}

		relPath = strings.Trim(relPath, "/")
		if relPath == "" || relPath == "." {
			continue
		}

		target := filepath.Join(cleanDest, relPath)
		if !strings.HasPrefix(target, cleanDest+string(filepath.Separator)) && target != cleanDest {
			return fmt.Errorf("tar entry %q escapes destination directory %s", hdr.Name, cleanDest)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("create dir %s: %w", target, err)
			}
			if os.Geteuid() == 0 {
				_ = os.Chown(target, 0, 0)
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return fmt.Errorf("mkdir parent %s: %w", filepath.Dir(target), err)
			}
			mode := os.FileMode(hdr.Mode & 0o777)
			if mode == 0 {
				mode = 0o644
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
			if err != nil {
				return fmt.Errorf("create file %s: %w", target, err)
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return fmt.Errorf("write file %s: %w", target, err)
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
					return fmt.Errorf("unsafe symlink %s -> %s escapes %s", target, linkTarget, cleanDest)
				}
			}
			_ = os.Remove(target)
			if err := os.Symlink(linkTarget, target); err != nil {
				return fmt.Errorf("create symlink %s -> %s: %w", target, linkTarget, err)
			}
			// Skip unsupported entry types
			continue
		}
	}

	return fsyncDir(cleanDest)
}
