package applications

import (
 "context"
 "encoding/json"
 "fmt"
 "io"
 "net/http"
 "time"
)

// CollectInventory reads metadata independently of the sampled metrics path.
// The caller supplies a socket-bound client, never a user-selected daemon URL.
func CollectInventory(ctx context.Context, client *http.Client, opts InventoryOptions) (*Inventory, error) {
 budget:=opts.Timeout
 if budget<=0 || budget>InventoryBudget {budget=InventoryBudget}
 ctx,cancel:=context.WithTimeout(ctx,budget)
 defer cancel()
 req,err:=http.NewRequestWithContext(ctx,http.MethodGet,"http://docker/containers/json?all=1&size=false",nil)
 if err!=nil {return nil,err}
 resp,err:=client.Do(req)
 if err!=nil {return nil,&InventoryError{Reason:ReasonTransport}}
 defer resp.Body.Close()
 if resp.StatusCode!=http.StatusOK {return nil,&InventoryError{Reason:ReasonTransport}}
 body,err:=io.ReadAll(io.LimitReader(resp.Body,MaxInventoryBodyBytes+1))
 if err!=nil {return nil,&InventoryError{Reason:ReasonTransport}}
 if len(body)>MaxInventoryBodyBytes {return nil,&InventoryError{Reason:ReasonOverPayload}}
 var rows []inventoryRaw
 if err=json.Unmarshal(body,&rows);err!=nil || rows==nil {return nil,&InventoryError{Reason:ReasonMalformed}}
 // Capability probes share the collection deadline, not an unbounded TODO context.
 if opts.Capabilities!=nil {
  capability,e:=opts.Capabilities(ctx)
  if e!=nil {return nil,&InventoryError{Reason:ReasonProjection}}
  opts.Capabilities=func(context.Context)(Capability,error){return capability,nil}
 }
 inv,err:=buildInventory(rows,opts)
 if err!=nil {return nil,err}
 encoded,err:=json.Marshal(inv)
 if err!=nil {return nil,&InventoryError{Reason:ReasonEncode}}
 if len(encoded)>512*1024 {return nil,&InventoryError{Reason:ReasonOverPayload}}
 if err=ctx.Err();err!=nil {return nil,&InventoryError{Reason:ReasonTransport}}
 return inv,nil
}

// RunInventory schedules independently; failed pushes never delay host metrics.
// Collection errors are returned to the caller's reporting policy, not logged
// with raw daemon payloads or identifiers.
func RunInventory(ctx context.Context, interval time.Duration, collect func(context.Context)(*Inventory,error), transport InventoryIngestTransport, report func(error)) {
 if interval<30*time.Second {interval=30*time.Second}
 tick:=time.NewTicker(interval)
 defer tick.Stop()
 for {
  inv,err:=collect(ctx)
  if err==nil {err=transport.Push(ctx,inv)}
  if err!=nil && report!=nil {report(fmt.Errorf("applications inventory unavailable: %w",err))}
  select {case <-ctx.Done():return;case <-tick.C:}
 }
}
