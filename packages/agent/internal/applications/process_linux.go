//go:build linux

package applications
import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func currentProcessStartTime() int64 {
	st, err := getProcessStartTime(os.Getpid())
	if err != nil {
		return 0
	}
	return st
}

func getProcessStartTime(pid int) (int64, error) {
	if procStartTimeOverride != nil {
		return procStartTimeOverride(pid)
	}
	statPath := fmt.Sprintf("/proc/%d/stat", pid)
	data, err := os.ReadFile(statPath)
	if err != nil {
		return 0, err
	}
	// The comm field is enclosed in parentheses and may contain spaces or closing parentheses.
	// Find the last ')' to parse fields reliably.
	idx := bytes.LastIndexByte(data, ')')
	if idx < 0 || idx+1 >= len(data) {
		return 0, fmt.Errorf("malformed stat for pid %d", pid)
	}
	fields := strings.Fields(string(data[idx+1:]))
	// Field 0 after ')' is state (field 3 of /proc/<pid>/stat)
	// Field 19 after ')' is starttime (field 22 of /proc/<pid>/stat)
	if len(fields) <= 19 {
		return 0, fmt.Errorf("short stat for pid %d", pid)
	}
	st, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse starttime for pid %d: %w", pid, err)
	}
	return st, nil
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
	curStartTime, err := getProcessStartTime(pid)
	if err != nil {
		if os.IsNotExist(err) || errors.Is(err, os.ErrNotExist) {
			return false
		}
		// If /proc/<pid>/stat is inaccessible (e.g. restrictive container permissions), fallback to kill 0:
		if err := unix.Kill(pid, 0); errors.Is(err, unix.ESRCH) {
			return false
		}
	}
	if recordedStartTime > 0 && curStartTime > 0 {
		if curStartTime != recordedStartTime {
			return false // PID was recycled!
		}
		return true
	}
	// If start time cannot be read or recorded start time is 0, verify process exists via kill 0:
	return unix.Kill(pid, 0) == nil
}

func getFileGID(fi os.FileInfo) int {
	if fi == nil {
		return -1
	}
	if stat, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int(stat.Gid)
	}
	return -1
}
