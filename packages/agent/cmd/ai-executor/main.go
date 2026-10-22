package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/vps-manager/agent/internal/version"
)

func main() {
	rootfs := flag.String("rootfs", "", "Path to pinned minimal rootfs directory")
	scratch := flag.String("scratch", "", "Path to task scratch directory")
	script := flag.String("script", "", "Path to script file to execute")
	uid := flag.Int("uid", -1, "Target unprivileged execution UID")
	gid := flag.Int("gid", -1, "Target unprivileged execution GID")
	cgroup := flag.String("cgroup", "", "Path to cgroup directory for scope confinement")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version.Identity())
		return
	}
	if *script == "" {
		fmt.Fprintln(os.Stderr, "ai-executor: -script is required")
		os.Exit(1)
	}

	exitCode, err := run(*rootfs, *scratch, *script, *uid, *gid, *cgroup)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ai-executor error: %v\n", err)
		os.Exit(exitCode)
	}
	os.Exit(exitCode)
}
