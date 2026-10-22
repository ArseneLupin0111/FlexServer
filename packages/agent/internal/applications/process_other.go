//go:build !linux

package applications

import (
	"os"
)

func currentProcessStartTime() int64 {
	if procStartTimeOverride != nil {
		st, _ := procStartTimeOverride(os.Getpid())
		return st
	}
	return 0
}

func isProcessAlive(pid int, recordedStartTime int64) bool {
	if pid <= 0 {
		return false
	}
	if procAliveOverride != nil {
		if handled, alive := procAliveOverride(pid, recordedStartTime); handled {
			return alive
		}
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = p
	return true
}

func getFileGID(fi os.FileInfo) int {
	return -1
}
