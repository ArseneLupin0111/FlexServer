package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
)

type ServerConfig struct {
	SocketPath     string
	SocketMode     os.FileMode
	SocketUID      int
	SocketGID      int
	ProfilesDir    string
	ExecutionUID   int
	ExecutionGID   int
	ExecutorBinary string
	RootfsDir      string
	CgroupBase     string
	BackupsDir     string
}

func main() {
	socket := flag.String("socket", "/run/vps-agent/ai-helper.sock", "Unix domain socket path")
	mode := flag.String("socket-mode", "0660", "Socket permissions (octal)")
	uid := flag.Int("socket-uid", -1, "Socket owner UID")
	gid := flag.Int("socket-gid", -1, "Socket owner GID")
	profilesDir := flag.String("profiles-dir", "/etc/vps-manager/ai-profiles.d", "Root-owned profiles directory")
	executionUID := flag.Int("execution-uid", -1, "Pinned target execution UID for confined tasks")
	executionGID := flag.Int("execution-gid", -1, "Pinned target execution GID for confined tasks")
	executorBinary := flag.String("executor-binary", "/usr/local/sbin/ai-executor", "Pinned path to ai-executor binary")
	rootfsDir := flag.String("rootfs-dir", "/usr/local/share/flexserver-ai/rootfs", "Pinned minimal rootfs directory")
	cgroupBase := flag.String("cgroup-base", "/sys/fs/cgroup/flexserver-ai", "Base cgroup v2 directory")
	backupsDir := flag.String("backups-dir", "/var/lib/flexserver-ai/backups", "Root-owned backups directory for config CAS")
	flag.Parse()

	permission, err := strconv.ParseUint(*mode, 8, 32)
	if err == nil {
		cfg := ServerConfig{
			SocketPath:     *socket,
			SocketMode:     os.FileMode(permission),
			SocketUID:      *uid,
			SocketGID:      *gid,
			ProfilesDir:    *profilesDir,
			ExecutionUID:   *executionUID,
			ExecutionGID:   *executionGID,
			ExecutorBinary: *executorBinary,
			RootfsDir:      *rootfsDir,
			CgroupBase:     *cgroupBase,
			BackupsDir:     *backupsDir,
		}
		err = run(cfg)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
