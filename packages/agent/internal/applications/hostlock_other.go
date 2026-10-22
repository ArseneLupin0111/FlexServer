//go:build !linux && !windows

package applications

import "fmt"

func openRegistryFile(path string, flag int, perm os.FileMode) (*os.File, error) {
	fi, err := os.Lstat(path)
	if err == nil && (fi.Mode()&os.ModeSymlink != 0) {
		return nil, fmt.Errorf("applications: symlink not allowed for exclusion registry: %s", path)
	}
	return os.OpenFile(path, flag, perm)
}

func acquireProcessFileLock(path string) (func(), error) {
	return nil, fmt.Errorf("applications: cross-process exclusion locks are unsupported on this platform")
}
