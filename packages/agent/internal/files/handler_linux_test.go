//go:build linux

package files

import (
 "bytes"
 "io"
 "net/http"
 "net/http/httptest"
 "net/url"
 "os"
 "path/filepath"
 "strings"
 "syscall"
 "testing"
)

func TestFilesystemOperations(t *testing.T) {
 dir:=t.TempDir(); handler:=Handler()
 call:=func(method,route string,body io.Reader)*httptest.ResponseRecorder {
  req:=httptest.NewRequest(method,route,body); if method=="PUT" { req.Header.Set("Content-Type","application/octet-stream") }
  out:=httptest.NewRecorder(); handler.ServeHTTP(out,req); return out
 }
 p:=filepath.Join(dir,"Unicode tiếng #%;$.bin"); query:="?path="+url.QueryEscape(p)
 data:=[]byte{0,1,255,13,10,128}
 if got:=call("PUT","/upload"+query,bytes.NewReader(data)); got.Code!=201 { t.Fatalf("upload: %d %s",got.Code,got.Body) }
 if got:=call("GET","/download"+query,nil); got.Code!=200 || !bytes.Equal(got.Body.Bytes(),data) { t.Fatalf("download mismatch: %d",got.Code) }
 if got:=call("PUT","/upload"+query,strings.NewReader("replacement")); got.Code!=409 { t.Fatalf("overwrite accepted: %d",got.Code) }
 original,_:=os.ReadFile(p); if !bytes.Equal(original,data) { t.Fatal("existing bytes changed") }
 link:=filepath.Join(dir,"link"); if err:=os.Symlink(p,link); err!=nil { t.Fatal(err) }
 if got:=call("DELETE","/entry?path="+url.QueryEscape(link),nil); got.Code!=204 { t.Fatalf("unlink: %d",got.Code) }
 if _,err:=os.Stat(p); err!=nil { t.Fatal("symlink target removed",err) }
 if got:=call("DELETE","/entry?path="+url.QueryEscape(dir),nil); got.Code!=409 { t.Fatalf("nonempty dir: %d",got.Code) }
 fifo:=filepath.Join(dir,"pipe"); if err:=syscall.Mkfifo(fifo,0600); err!=nil { t.Fatal(err) }
 if got:=call("GET","/download?path="+url.QueryEscape(fifo),nil); got.Code!=422 { t.Fatalf("FIFO accepted: %d",got.Code) }
 if got:=call("DELETE","/entry?path=/",nil); got.Code!=400 { t.Fatalf("root accepted: %d",got.Code) }
 if got:=call("GET","/health",nil); got.Code!=http.StatusOK || !strings.Contains(got.Body.String(),`"protocolVersion":1`) { t.Fatal("health protocol") }
}
