package main

import (
 "flag"
 "fmt"
 "os"
 "strconv"
)

func main() {
 socket:=flag.String("socket","/var/run/flexserver/host-files/host-files.sock","Unix socket path")
 mode:=flag.String("socket-mode","0660","Socket permissions (octal)")
 uid:=flag.Int("socket-uid",-1,"Socket owner UID")
 gid:=flag.Int("socket-gid",-1,"Socket owner GID")
 flag.Parse()
 permission,err:=strconv.ParseUint(*mode,8,9)
 if err==nil { err=run(*socket,os.FileMode(permission),*uid,*gid) }
 if err!=nil { fmt.Fprintln(os.Stderr,err); os.Exit(1) }
}
