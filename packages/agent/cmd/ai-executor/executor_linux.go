//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

func run(rootfs, scratch, script string, uid, gid int, cgroup string) (int, error) {
	// 1. Mandatory argument validation
	if rootfs == "" || scratch == "" || script == "" || uid <= 0 || gid <= 0 || cgroup == "" {
		return 1, errors.New("rootfs, scratch, script, uid, gid, and cgroup are all mandatory")
	}

	// 2. Bootstrap must be root to establish namespaces, mounts, and drop privileges
	if os.Geteuid() != 0 {
		return 1, errors.New("root bootstrap required for container isolation")
	}

	// 3. Attach bootstrap PID to cgroup2 scope before executing commands
	procsFile := filepath.Join(cgroup, "cgroup.procs")
	pidStr := strconv.Itoa(os.Getpid())
	if err := os.WriteFile(procsFile, []byte(pidStr), 0644); err != nil {
		return 1, fmt.Errorf("attaching PID %s to cgroup %s: %w", pidStr, cgroup, err)
	}

	// Verify cgroup membership
	cgData, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return 1, fmt.Errorf("reading /proc/self/cgroup: %w", err)
	}
	baseTaskID := filepath.Base(cgroup)
	if !strings.Contains(string(cgData), baseTaskID) {
		return 1, fmt.Errorf("cgroup verification failed: current cgroups %q do not contain task %q", string(cgData), baseTaskID)
	}

	// 4. Private mount propagation across entire filesystem
	if err := unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""); err != nil {
		return 1, fmt.Errorf("mount private /: %w", err)
	}

	// 5. Rootfs: bind mount and remount read-only
	if err := unix.Mount(rootfs, rootfs, "bind", unix.MS_BIND|unix.MS_REC, ""); err != nil {
		return 1, fmt.Errorf("bind rootfs %s: %w", rootfs, err)
	}
	if err := unix.Mount(rootfs, rootfs, "none", unix.MS_BIND|unix.MS_REMOUNT|unix.MS_RDONLY, ""); err != nil {
		return 1, fmt.Errorf("remount rootfs %s readonly: %w", rootfs, err)
	}

	// 6. Scratch: mount dedicated bounded tmpfs at /tmp inside rootfs
	tmpPath := filepath.Join(rootfs, "tmp")
	if err := os.MkdirAll(tmpPath, 0700); err != nil {
		return 1, fmt.Errorf("mkdir %s: %w", tmpPath, err)
	}
	// Mount 64 MiB bounded tmpfs with nosuid and nodev
	if err := unix.Mount("tmpfs", tmpPath, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "size=67108864,mode=0700"); err != nil {
		return 1, fmt.Errorf("mount scratch tmpfs on %s: %w", tmpPath, err)
	}
	if err := unix.Chown(tmpPath, uid, gid); err != nil {
		return 1, fmt.Errorf("chown %s to %d:%d: %w", tmpPath, uid, gid, err)
	}

	// 7. Copy script from host path into container /tmp/script.sh before chroot
	scriptBytes, err := os.ReadFile(script)
	if err != nil {
		return 1, fmt.Errorf("reading script %s: %w", script, err)
	}
	destScript := filepath.Join(tmpPath, "script.sh")
	if err := os.WriteFile(destScript, scriptBytes, 0700); err != nil {
		return 1, fmt.Errorf("writing container script %s: %w", destScript, err)
	}
	if err := unix.Chown(destScript, uid, gid); err != nil {
		return 1, fmt.Errorf("chown container script %s: %w", destScript, err)
	}

	// 8. Mount minimal private proc inside rootfs
	procPath := filepath.Join(rootfs, "proc")
	if err := os.MkdirAll(procPath, 0555); err != nil {
		return 1, fmt.Errorf("mkdir %s: %w", procPath, err)
	}
	if err := unix.Mount("proc", procPath, "proc", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil {
		return 1, fmt.Errorf("mount private proc on %s: %w", procPath, err)
	}

	// 9. Chroot into rootfs
	if err := unix.Chroot(rootfs); err != nil {
		return 1, fmt.Errorf("chroot into %s: %w", rootfs, err)
	}
	if err := unix.Chdir("/tmp"); err != nil {
		return 1, fmt.Errorf("chdir /tmp: %w", err)
	}

	// 10. Lock OS thread for capabilities and seccomp installation
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// 11. Drop supplementary groups
	if err := unix.Setgroups([]int{}); err != nil {
		return 1, fmt.Errorf("setgroups empty: %w", err)
	}

	// 12. Drop bounding capability set
	for cap := 0; cap <= 63; cap++ {
		_ = unix.Prctl(unix.PR_CAPBSET_DROP, uintptr(cap), 0, 0, 0)
	}

	// 13. Drop privileges to dedicated execution GID and UID
	if err := unix.Setresgid(gid, gid, gid); err != nil {
		return 1, fmt.Errorf("setresgid to %d: %w", gid, err)
	}
	if err := unix.Setresuid(uid, uid, uid); err != nil {
		return 1, fmt.Errorf("setresuid to %d: %w", uid, err)
	}

	// 14. Set PR_SET_NO_NEW_PRIVS
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return 1, fmt.Errorf("prctl PR_SET_NO_NEW_PRIVS: %w", err)
	}

	// 15. Apply actual seccomp BPF filter
	if err := applySeccompFilter(); err != nil {
		return 1, fmt.Errorf("applying seccomp filter: %w", err)
	}

	// 16. Execute fixed /bin/sh /tmp/script.sh with stdin redirected from /dev/null
	cmd := exec.Command("/bin/sh", "/tmp/script.sh")
	devNull, err := os.Open("/dev/null")
	if err == nil {
		cmd.Stdin = devNull
		defer devNull.Close()
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = []string{
		"PATH=/bin:/usr/bin",
		"HOME=/tmp",
		"TMPDIR=/tmp",
		"LANG=C.UTF-8",
	}

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
				return status.ExitStatus(), nil
			}
			return exitErr.ExitCode(), nil
		}
		return 1, err
	}

	return 0, nil
}

// applySeccompFilter installs a classic BPF filter blocking dangerous syscalls.
func applySeccompFilter() error {
	// Common blocklist for every architecture. SYS_SYSFS, SYS_IOPL, and
	// SYS_IOPERM only exist on amd64, so they live in the per-arch extension
	// list from executor_linux_amd64.go / executor_linux_arm64.go (spliced in
	// at their original position below); see those files for the constraint.
	blockedSyscalls := []uint32{
		unix.SYS_PTRACE,
		unix.SYS_REBOOT,
		unix.SYS_KEXEC_LOAD,
		unix.SYS_INIT_MODULE,
		unix.SYS_FINIT_MODULE,
		unix.SYS_DELETE_MODULE,
		unix.SYS_BPF,
		unix.SYS_KEYCTL,
		unix.SYS_REQUEST_KEY,
		unix.SYS_ADD_KEY,
		unix.SYS_PERF_EVENT_OPEN,
		unix.SYS_UNSHARE,
		unix.SYS_SETNS,
		unix.SYS_MOUNT,
		unix.SYS_PIVOT_ROOT,
		unix.SYS_SWAPON,
		unix.SYS_SWAPOFF,
	}
	blockedSyscalls = append(blockedSyscalls, archSpecificBlockedSyscalls...)
	blockedSyscalls = append(blockedSyscalls, unix.SYS_USERFAULTFD)

	numBlocked := len(blockedSyscalls)
	filter := make([]unix.SockFilter, 0, 4+numBlocked+2)

	// 1. Load arch from seccomp_data (offset 4)
	filter = append(filter, unix.SockFilter{
		Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS,
		K:    4,
	})

	// 2. Validate current architecture
	var arch uint32 = 0xc000003e // AUDIT_ARCH_X86_64
	if runtime.GOARCH == "arm64" {
		arch = 0xc00000b7 // AUDIT_ARCH_AARCH64
	}

	// JEQ arch: if match jump 1 instruction (skip kill), else 0 (proceed to kill)
	filter = append(filter, unix.SockFilter{
		Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K,
		Jt:   1,
		Jf:   0,
		K:    arch,
	})

	// 3. Architecture mismatch -> SECCOMP_RET_KILL_PROCESS
	filter = append(filter, unix.SockFilter{
		Code: unix.BPF_RET | unix.BPF_K,
		K:    0x80000000, // SECCOMP_RET_KILL_PROCESS
	})

	// 4. Load syscall nr from seccomp_data (offset 0)
	filter = append(filter, unix.SockFilter{
		Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS,
		K:    0,
	})

	// 5. Check each blocked syscall
	for i, sc := range blockedSyscalls {
		jumpTarget := uint8(numBlocked - i)
		filter = append(filter, unix.SockFilter{
			Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K,
			Jt:   jumpTarget,
			Jf:   0,
			K:    sc,
		})
	}

	// 6. Default allow: SECCOMP_RET_ALLOW
	filter = append(filter, unix.SockFilter{
		Code: unix.BPF_RET | unix.BPF_K,
		K:    0x7fff0000, // SECCOMP_RET_ALLOW
	})

	// 7. Blocked syscall return EPERM: SECCOMP_RET_ERRNO | EPERM (1)
	filter = append(filter, unix.SockFilter{
		Code: unix.BPF_RET | unix.BPF_K,
		K:    0x00050001, // SECCOMP_RET_ERRNO | 1 (EPERM)
	})

	fprog := unix.SockFprog{
		Len:    uint16(len(filter)),
		Filter: &filter[0],
	}

	return unix.Prctl(unix.PR_SET_SECCOMP, unix.SECCOMP_MODE_FILTER, uintptr(unsafe.Pointer(&fprog)), 0, 0)
}
