//go:build linux

package main

import (
 "context"
 "errors"
 "net"
 "net/http"
 "os"
 "os/signal"
 "path/filepath"
 "syscall"
 "time"

 "github.com/vps-manager/agent/internal/files"
)

func run(socket string, mode os.FileMode, uid,gid int) error {
 if err:=os.MkdirAll(filepath.Dir(socket),0750); err!=nil { return err }
 if info,err:=os.Lstat(socket); err==nil {
  if info.Mode()&os.ModeSocket==0 { return errors.New("socket path exists and is not a socket") }
  probe,e:=net.DialTimeout("unix",socket,time.Second); if e==nil { probe.Close(); return errors.New("socket already active") }
  if err=os.Remove(socket); err!=nil { return err }
 } else if !os.IsNotExist(err) { return err }
 previous:=syscall.Umask(0077)
 listener,err:=net.Listen("unix",socket)
 syscall.Umask(previous)
 if err!=nil { return err }
 defer listener.Close(); defer os.Remove(socket)
 if err=os.Chown(socket,uid,gid); err!=nil { return err }
 if err=os.Chmod(socket,mode); err!=nil { return err }
 ctx,stop:=signal.NotifyContext(context.Background(),os.Interrupt,syscall.SIGTERM); defer stop()
 server:=&http.Server{Handler:files.Handler(),ReadHeaderTimeout:15*time.Second,IdleTimeout:60*time.Second,BaseContext:func(net.Listener) context.Context{return ctx}}
 go func(){ <-ctx.Done(); _=server.Close() }()
 err=server.Serve(listener)
 if errors.Is(err,http.ErrServerClosed) { return nil }
 return err
}
