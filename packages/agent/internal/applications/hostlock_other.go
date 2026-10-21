//go:build !linux

package applications

import "fmt"

func acquireProcessFileLock(path string) (func(), error) {
	return nil, fmt.Errorf("applications: cross-process exclusion locks are unsupported on this platform")
}
