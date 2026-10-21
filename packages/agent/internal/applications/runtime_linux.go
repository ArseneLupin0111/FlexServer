//go:build linux

package applications

import (
 "context"
 "crypto/sha256"
 "encoding/binary"
 "encoding/json"
 "fmt"
 "io"
 "net"
 "net/http"
 "runtime"
 "time"

 "github.com/vps-manager/agent/internal/config"
 "github.com/vps-manager/agent/internal/state"
 "github.com/vps-manager/agent/internal/version"
)

// StartInventory uses only the local Engine socket, independently of metrics.
func StartInventory(ctx context.Context, cfg *config.Config, st *state.Store, report func(error)) error {
 client := &http.Client{Timeout: InventoryBudget, Transport: &http.Transport{Proxy:nil,DialContext:func(ctx context.Context,_,_ string)(net.Conn,error){return (&net.Dialer{Timeout:InventoryBudget}).DialContext(ctx,"unix","/var/run/docker.sock")}}}
 transport,err:=NewInventoryClient(cfg)
 if err!=nil{return err}
 collect:=func(ctx context.Context)(*Inventory,error){
  cycle,cancel:=context.WithTimeout(ctx,InventoryBudget)
  defer cancel()
  req,err:=http.NewRequestWithContext(cycle,http.MethodGet,"http://docker/info",nil)
  if err!=nil{return nil,err}
  resp,err:=client.Do(req)
  if err!=nil{return nil,&InventoryError{Reason:ReasonTransport}}
  defer resp.Body.Close()
  if resp.StatusCode!=200{return nil,&InventoryError{Reason:ReasonTransport}}
  data,err:=io.ReadAll(io.LimitReader(resp.Body,MaxInventoryBodyBytes+1))
  if err!=nil || len(data)>MaxInventoryBodyBytes{return nil,&InventoryError{Reason:ReasonOverPayload}}
  var info struct{ID string `json:"ID"`;ServerVersion string `json:"ServerVersion"`}
  if json.Unmarshal(data,&info)!=nil || info.ID=="" {return nil,fmt.Errorf("applications: daemon identity unavailable")}
  hash:=sha256.Sum256([]byte(st.ContainerKey(info.ID)))
  // A stable opaque epoch fits the API's exact integer range. No raw daemon
  // identifier is persisted or transmitted; replacement changes the binding.
  epoch:=int64(binary.BigEndian.Uint64(hash[:8]) & ((1<<53)-1))
  opts:=InventoryOptions{AgentInstanceID:st.InstanceID(),DaemonEpoch:func()int64{return epoch},Sequence:st.ReserveSequence,ContainerKey:st.ContainerKey,Capabilities:func(context.Context)(Capability,error){cap:=Capability{ProtocolVersion:InventoryProtocolVersion,OS:runtime.GOOS,Arch:runtime.GOARCH,AgentVersion:version.String(),DockerAvailable:true,DockerVersion:info.ServerVersion,ComposeMode:"unavailable",InstallState:InstallMissing,Features:[]string{},Reasons:[]string{}};rt,probeErr:=DetectRuntime();if probeErr==nil {cap.ComposeMode=rt.Mode;cap.ComposeVersion=rt.Version;if rt.Mode==ModePlugin{cap.InstallState=InstallPlugin};if compatibleComposeVersion(rt.Version){cap.Features=append(cap.Features,FeatureComposeMajor2)}else{cap.Reasons=append(cap.Reasons,"compose_version_unsupported")}}else{cap.Reasons=append(cap.Reasons,"compose_runtime_unverified")};return cap,nil}}
  inv,collectErr:=CollectInventory(cycle,client,opts)
  if collectErr==nil{return inv,nil}
  reason:=ReasonTransport
  if typed,ok:=collectErr.(*InventoryError);ok{reason=typed.Reason}
  // An incomplete observation carries no inferred removals. Readers must
  // retain prior evidence while denying mutation admission.
  inv,err=buildInventory([]inventoryRaw{},opts)
  if err!=nil{return nil,err}
  inv.Complete=false
  inv.Reason=reason
  return inv,nil
 }
 go RunInventory(ctx,30*time.Second,collect,transport,report)
 return nil
}
