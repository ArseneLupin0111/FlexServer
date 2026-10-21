package applications

import (
 "fmt"
 "testing"
)

func TestInventoryGroupsInterleavedProjectsAndPreservesOpaqueKeys(t *testing.T) {
 rows := []inventoryRaw{
  {ID:"1", State:"running", Labels:map[string]string{LabelProject:"alpha",LabelService:"web",LabelNumber:"1"}},
  {ID:"2", State:"exited", Labels:map[string]string{LabelProject:"beta",LabelService:"db",LabelNumber:"1"}},
  {ID:"3", State:"running", Labels:map[string]string{LabelProject:"alpha",LabelService:"worker",LabelNumber:"1"}},
 }
 opts := InventoryOptions{ContainerKey:func(id string) string{return fmt.Sprintf("%032s",id)}}
 inv, err := buildInventory(rows,opts)
 if err != nil {t.Fatal(err)}
 if len(inv.Projects)!=2 {t.Fatalf("projects: %+v",inv.Projects)}
 if inv.Projects[0].Project!="alpha" || len(inv.Projects[0].Services)!=2 || inv.Projects[0].Services[1].Service!="worker" {t.Fatalf("alpha grouping: %+v", inv.Projects[0])}
 if inv.Projects[1].Project!="beta" || len(inv.Projects[1].Services)!=1 || inv.Projects[1].Services[0].Service!="db" {t.Fatalf("beta grouping: %+v", inv.Projects[1])}
 if got:=inv.Projects[0].Services[1].Replicas[0].ContainerKey;got!=opts.ContainerKey("3") {t.Fatalf("opaque key %q",got)}
}

func TestInventoryRejectsOverCapAndMissingOpaqueIdentity(t *testing.T) {
 if _,err:=buildInventory(make([]inventoryRaw,501),InventoryOptions{});err==nil {t.Fatal("accepted over-cap inventory")}
 rows:=[]inventoryRaw{{ID:"private-id",Labels:map[string]string{LabelProject:"alpha",LabelService:"web"}}}
 if _,err:=buildInventory(rows,InventoryOptions{});err==nil {t.Fatal("accepted missing opaque identity")}
}
