//go:build linux && amd64

package main

import "golang.org/x/sys/unix"

// archSpecificBlockedSyscalls extends the common seccomp blocklist in
// executor_linux.go with syscalls that only exist on amd64. SYS_SYSFS,
// SYS_IOPL, and SYS_IOPERM are absent from the arm64 syscall table, so
// golang.org/x/sys/unix does not define constants for them there and a shared
// list would not compile on linux/arm64. On amd64 they MUST stay blocked, so
// they are kept in a per-arch list instead of being dropped. Both builds stay
// fail-closed: syscalls that do not exist on an architecture cannot be
// invoked on it.
var archSpecificBlockedSyscalls = []uint32{
	unix.SYS_SYSFS,
	unix.SYS_IOPL,
	unix.SYS_IOPERM,
}
