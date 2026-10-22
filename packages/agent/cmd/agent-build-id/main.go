package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/vps-manager/agent/internal/buildidentity"
)

func main() {
	var root string
	flag.StringVar(&root, "root", ".", "Path to agent package root")
	flag.Parse()

	id, err := buildidentity.Compute(root, "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent-build-id: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(id)
}
