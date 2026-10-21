//go:build !linux

package main

import (
	"errors"
)

func run(_, _, _ string, _, _ int, _ string) (int, error) {
	return 1, errors.New("ai-executor is supported only on Linux")
}
