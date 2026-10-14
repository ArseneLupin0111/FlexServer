//go:build !linux

package main

import (
	"errors"
	"os"
)

func runUnixSocketServer(socketPath, shell string, defaultRows, defaultCols uint16, socketMode os.FileMode, socketUid, socketGid int) error {
	return errors.New("unix domain socket listener is only supported on Linux")
}
