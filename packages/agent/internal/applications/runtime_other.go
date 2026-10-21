//go:build !linux

package applications

import (
 "context"
 "fmt"
 "github.com/vps-manager/agent/internal/config"
 "github.com/vps-manager/agent/internal/state"
)

func StartInventory(context.Context,*config.Config,*state.Store,func(error)) error {
 return fmt.Errorf("applications: inventory requires a Linux Engine socket")
}
