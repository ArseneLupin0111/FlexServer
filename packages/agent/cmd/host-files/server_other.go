//go:build !linux

package main

import (
 "errors"
 "os"
)

func run(_ string, _ os.FileMode, _,_ int) error {
 return errors.New("host-files is supported only on Linux")
}
