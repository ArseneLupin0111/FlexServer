package applications

import (
 "bytes"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "fmt"
 "io"
 "net/http"
 "net/url"
 "time"

 "github.com/vps-manager/agent/internal/config"
)

// InventoryClient sends only the safe projection through the enrolled transport.
type InventoryClient struct {endpoint string;token string;httpClient *http.Client}
func NewInventoryClient(cfg *config.Config)(*InventoryClient,error){
 endpoint,err:=url.JoinPath(cfg.BackendUrl,"/api/agent/applications/inventory")
 if err!=nil{return nil,err}
 return &InventoryClient{endpoint:endpoint,token:cfg.Token,httpClient:&http.Client{Timeout:time.Duration(cfg.RequestTimeoutSeconds)*time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}},nil
}
func(c *InventoryClient)Push(ctx context.Context,inv *Inventory)error{
 body,err:=json.Marshal(inv)
 if err!=nil{return err}
 if len(body)>512*1024{return &InventoryError{Reason:ReasonOverPayload}}
 req,err:=http.NewRequestWithContext(ctx,http.MethodPost,c.endpoint,bytes.NewReader(body))
 if err!=nil{return err}
 digest:=sha256.Sum256(body)
 req.Header.Set("Authorization","Bearer "+c.token)
 req.Header.Set("Content-Type","application/json")
 req.Header.Set("x-agent-instance",inv.AgentInstanceID)
 req.Header.Set("x-inventory-digest",hex.EncodeToString(digest[:]))
 resp,err:=c.httpClient.Do(req)
 if err!=nil{return &InventoryError{Reason:ReasonTransport}}
 defer resp.Body.Close()
 _,_=io.Copy(io.Discard,io.LimitReader(resp.Body,4096))
 if resp.StatusCode<200 || resp.StatusCode>=300{return fmt.Errorf("applications inventory HTTP %d",resp.StatusCode)}
 return nil
}
