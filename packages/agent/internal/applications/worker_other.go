//go:build !linux

package applications

import (
	"context"
	"fmt"

	"github.com/vps-manager/agent/internal/config"
)

type Worker struct{}

func NewWorker(cfg *config.Config, instance, receiptPath string, keyForID func(string) string) (*Worker, error) {
	return nil, fmt.Errorf("applications: worker requires linux")
}

func (w *Worker) ProcessOne(ctx context.Context) error {
	return fmt.Errorf("applications: worker requires linux")
}
