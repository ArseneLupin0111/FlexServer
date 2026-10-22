//go:build !linux

package main

import (
	"errors"
	"os"
)

func runUnixSocketServer(socketPath, shell, stateDir string, defaultRows, defaultCols uint16, socketMode os.FileMode, socketUid, socketGid int) error {
}
