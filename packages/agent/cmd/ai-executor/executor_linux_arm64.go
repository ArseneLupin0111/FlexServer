//go:build linux && arm64

package main

// archSpecificBlockedSyscalls has no arm64-only entries. The amd64-only
// dangerous syscalls (SYS_SYSFS, SYS_IOPL, SYS_IOPERM) do not exist in the
// arm64 syscall table, so there is nothing extra to block here; see
// executor_linux_amd64.go for the per-arch list constraint. The common
// blocklist in executor_linux.go still applies, and the filter kills any
// binary whose audit arch does not match, so confinement remains fail-closed.
var archSpecificBlockedSyscalls = []uint32{}
