//go:build linux

package files

import (
 "errors"
 "net/http/httptest"
 "net/url"
 "os"
 "path/filepath"
 "testing"
)

type replacementReader struct { path string; used bool }
func (r *replacementReader) Read(p []byte)(int,error) {
 if r.used { return 0,errors.New("client disconnected") }; r.used=true
 if err:=os.Rename(r.path,r.path+".partial"); err!=nil { return 0,err }
 if err:=os.WriteFile(r.path,[]byte("replacement"),0600); err!=nil { return 0,err }
 p[0]=1; return 1,nil
}
func TestFailedUploadPreservesReplacement(t *testing.T) {
 p:=filepath.Join(t.TempDir(),"upload")
 req:=httptest.NewRequest("PUT","/upload?path="+url.QueryEscape(p),&replacementReader{path:p})
 req.Header.Set("Content-Type","application/octet-stream")
 response:=httptest.NewRecorder(); Handler().ServeHTTP(response,req)
 content,err:=os.ReadFile(p)
 if err!=nil || string(content)!="replacement" { t.Fatalf("replacement deleted: %q %v",content,err) }
 if response.Code==201 { t.Fatal("failed upload reported success") }
}
