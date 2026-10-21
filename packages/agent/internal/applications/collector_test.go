package applications

import (
 "context"
 "encoding/json"
 "fmt"
 "io"
 "net/http"
 "strings"
 "testing"
)

type inventoryRoundTrip func(*http.Request)(*http.Response,error)
func(f inventoryRoundTrip)RoundTrip(r *http.Request)(*http.Response,error){return f(r)}

func TestCollectInventoryIncludesBeyondMetricsSample(t *testing.T){
 rows:=make([]inventoryRaw,25)
 for i:=range rows {rows[i]=inventoryRaw{ID:fmt.Sprint(i),State:"running",Labels:map[string]string{LabelProject:"project",LabelService:"web",LabelNumber:fmt.Sprint(i+1)}}}
 body,_:=json.Marshal(rows)
 client:=&http.Client{Transport:inventoryRoundTrip(func(req *http.Request)(*http.Response,error){
  if req.Method!="GET" || req.URL.Path!="/containers/json" || req.URL.Query().Get("all")!="1" {t.Fatalf("unexpected daemon request %s",req.URL)}
  return &http.Response{StatusCode:200,Body:io.NopCloser(strings.NewReader(string(body)))},nil
 })}
 inv,err:=CollectInventory(context.Background(),client,InventoryOptions{ContainerKey:func(id string)string{return fmt.Sprintf("%032s",id)}})
 if err!=nil {t.Fatal(err)}
 if !inv.Complete || inv.ContainerTotal!=25 || len(inv.Projects[0].Services[0].Replicas)!=25 {t.Fatalf("lost unsampled containers: %+v",inv)}
}

func TestCollectInventoryRejectsMalformedAndOversizedBodies(t *testing.T){
 for _,body:=range []string{"null","{}","[",strings.Repeat(" ",MaxInventoryBodyBytes+1)} {
  client:=&http.Client{Transport:inventoryRoundTrip(func(*http.Request)(*http.Response,error){return &http.Response{StatusCode:200,Body:io.NopCloser(strings.NewReader(body))},nil})}
  if _,err:=CollectInventory(context.Background(),client,InventoryOptions{});err==nil {t.Fatal("accepted invalid daemon body")}
 }
}
