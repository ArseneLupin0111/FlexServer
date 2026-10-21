//go:build !linux

package main

import (
	"errors"
)

func run(_ ServerConfig) error {
	return errors.New("ai-host-helper is supported only on Linux")
}
