//go:build linux

package files

import (
 "context"
 "encoding/json"
 "errors"
 "io"
 "mime"
 "net/http"
 "os"
 "path"
 "path/filepath"
 "sort"
 "strings"
 "syscall"
 "time"
 "unicode/utf8"

 "golang.org/x/sys/unix"
)

const MaxUploadBytes int64 = 1073741824

type FileEntry struct {
 Name string `json:"name"`
 Path string `json:"path"`
 Type string `json:"type"`
 Size *int64 `json:"size"`
 ModifiedAt *string `json:"modifiedAt"`
 Mode *uint32 `json:"mode"`
}

type failure struct { status int; code string }
func (e failure) Error() string { return e.code }

func respond(w http.ResponseWriter, status int, data any) {
 w.Header().Set("Content-Type", "application/json")
 w.Header().Set("Cache-Control", "no-store")
 w.WriteHeader(status)
 _ = json.NewEncoder(w).Encode(map[string]any{"data":data})
}

func fail(w http.ResponseWriter, err error) {
 f := failure{500,"FILES_ERROR"}
 var explicit failure
 switch {
 case errors.As(err, &explicit): f = explicit
 case errors.Is(err, os.ErrNotExist): f = failure{404,"FILE_NOT_FOUND"}
 case errors.Is(err, os.ErrPermission): f = failure{403,"PERMISSION_DENIED"}
 case errors.Is(err, os.ErrExist): f = failure{409,"DESTINATION_EXISTS"}
 case errors.Is(err, syscall.ENOTEMPTY): f = failure{409,"DIRECTORY_NOT_EMPTY"}
 case errors.Is(err, syscall.ENOSYS), errors.Is(err, syscall.EOPNOTSUPP): f = failure{503,"OPERATION_UNSUPPORTED"}
 }
 w.Header().Set("Content-Type","application/json")
 w.WriteHeader(f.status)
 _ = json.NewEncoder(w).Encode(map[string]any{"error":map[string]string{"code":f.code,"message":f.code}})
}

func cleanPath(p string, root bool) (string,error) {
 if len(p)>4096 || !utf8.ValidString(p) || !strings.HasPrefix(p,"/") || strings.ContainsRune(p,0) { return "",failure{400,"INVALID_PATH"} }
 p = path.Clean(p)
 if p=="/" && !root { return "",failure{400,"INVALID_PATH"} }
 return p,nil
}

// Handler exposes only the host-files protocol; authentication belongs to the API and socket permissions.
func Handler() http.Handler { return http.HandlerFunc(serve) }

func serve(w http.ResponseWriter, r *http.Request) {
 if r.Method=="GET" && r.URL.Path=="/health" { respond(w,200,map[string]int{"protocolVersion":1}); return }
 p := r.URL.Query().Get("path")
 var newPath string
 if r.Method=="POST" {
  var body struct { Path string `json:"path"`; NewPath string `json:"newPath,omitempty"` }
  decoder := json.NewDecoder(http.MaxBytesReader(w,r.Body,16384)); decoder.DisallowUnknownFields()
  if err:=decoder.Decode(&body); err!=nil { fail(w,failure{400,"INVALID_PATH"}); return }
  if err:=decoder.Decode(new(any)); err!=io.EOF { fail(w,failure{400,"INVALID_PATH"}); return }
  p,newPath = body.Path,body.NewPath
 }
 if p=="" && r.Method=="GET" && r.URL.Path=="/entries" { p="/" }
 p,err:=cleanPath(p,r.Method=="GET" && r.URL.Path=="/entries")
 if err!=nil { fail(w,err); return }
 switch {
 case r.Method=="GET" && r.URL.Path=="/entries": err=list(w,r,p)
 case r.Method=="GET" && r.URL.Path=="/download": err=download(w,r,p)
 case r.Method=="PUT" && r.URL.Path=="/upload": err=upload(w,r,p)
 case r.Method=="POST" && r.URL.Path=="/directory":
  if newPath!="" { err=failure{400,"INVALID_PATH"}; break }
  err=os.Mkdir(p,0755); if err==nil { respond(w,201,map[string]string{"path":p}) }
 case r.Method=="POST" && r.URL.Path=="/rename":
  var dest string; dest,err=cleanPath(newPath,false); if err!=nil { break }
  var info os.FileInfo; info,err=os.Lstat(p); if err!=nil { break }
  if !info.Mode().IsRegular() && !info.IsDir() && info.Mode()&os.ModeSymlink==0 { err=failure{422,"UNSUPPORTED_FILE_TYPE"}; break }
  if info.IsDir() && strings.HasPrefix(dest,p+"/") { err=failure{400,"INVALID_PATH"}; break }
  if p!=dest { err=unix.Renameat2(unix.AT_FDCWD,p,unix.AT_FDCWD,dest,unix.RENAME_NOREPLACE) }
  if err==nil { respond(w,200,map[string]string{"path":dest}) }
 case r.Method=="DELETE" && r.URL.Path=="/entry":
  var info os.FileInfo; info,err=os.Lstat(p); if err!=nil { break }
  if !info.Mode().IsRegular() && !info.IsDir() && info.Mode()&os.ModeSymlink==0 { err=failure{422,"UNSUPPORTED_FILE_TYPE"}; break }
  if info.IsDir() { err=unix.Rmdir(p) } else { err=unix.Unlink(p) }
  if err==nil { w.WriteHeader(204) }
 default: err=failure{404,"FILE_NOT_FOUND"}
 }
 if err!=nil { fail(w,err) }
}

func list(w http.ResponseWriter,r *http.Request,p string) error {
 canonical,err:=filepath.EvalSymlinks(p); if err!=nil { return err }
 dir,err:=os.Open(canonical); if err!=nil { return err }; defer dir.Close()
 entries:=make([]FileEntry,0)
 for {
  if err=r.Context().Err(); err!=nil { return err }
  batch,e:=dir.ReadDir(128)
  if e!=nil && e!=io.EOF { return e }
  for _,item:=range batch {
   if len(entries)==10000 { return failure{413,"DIRECTORY_TOO_LARGE"} }
   info,e:=item.Info(); if e!=nil { return e }
   kind:="other"; switch { case info.Mode()&os.ModeSymlink!=0: kind="symlink"; case info.IsDir(): kind="directory"; case info.Mode().IsRegular(): kind="file" }
   size,modified,mode:=info.Size(),info.ModTime().UTC().Format(time.RFC3339Nano),uint32(info.Mode().Perm())
   entries=append(entries,FileEntry{item.Name(),path.Join(canonical,item.Name()),kind,&size,&modified,&mode})
  }
  if e==io.EOF { break }
 }
 sort.Slice(entries,func(i,j int)bool { if (entries[i].Type=="directory")!=(entries[j].Type=="directory") { return entries[i].Type=="directory" }; return entries[i].Name<entries[j].Name })
 respond(w,200,map[string]any{"path":canonical,"entries":entries}); return nil
}

func download(w http.ResponseWriter,r *http.Request,p string) error {
 // Nonblocking open prevents a raced FIFO replacement from blocking the helper.
 f,err:=os.OpenFile(p,os.O_RDONLY|syscall.O_NONBLOCK,0); if err!=nil { return err }; defer f.Close()
 stop:=context.AfterFunc(r.Context(),func(){ _=f.Close() }); defer stop()
 info,err:=f.Stat(); if err!=nil { return err }; if !info.Mode().IsRegular() { return failure{422,"UNSUPPORTED_FILE_TYPE"} }
 w.Header().Set("Content-Type","application/octet-stream")
 w.Header().Set("Content-Disposition",mime.FormatMediaType("attachment",map[string]string{"filename":strings.NewReplacer("\r","_","\n","_").Replace(path.Base(p))}))
 w.Header().Set("Cache-Control","no-store"); w.Header().Set("X-Content-Type-Options","nosniff")
 w.WriteHeader(200)
 if _,err=io.Copy(w,f); err!=nil { panic(http.ErrAbortHandler) }
 return nil
}

func upload(w http.ResponseWriter,r *http.Request,p string) error {
 media,_,err:=mime.ParseMediaType(r.Header.Get("Content-Type")); if err!=nil || media!="application/octet-stream" { return failure{415,"UNSUPPORTED_MEDIA_TYPE"} }
 if r.ContentLength>MaxUploadBytes { return failure{413,"FILE_TOO_LARGE"} }
 f,err:=os.OpenFile(p,os.O_CREATE|os.O_EXCL|os.O_WRONLY,0600); if err!=nil { return err }
 stop:=context.AfterFunc(r.Context(),func(){ _=f.Close(); _=r.Body.Close() }); defer stop()
 original,err:=f.Stat(); if err!=nil { f.Close(); return err }
 success:=false
 defer func(){ f.Close(); if !success { current,e:=os.Lstat(p); if e==nil && os.SameFile(original,current) { _=os.Remove(p) } } }()
 n,err:=io.Copy(f,io.LimitReader(r.Body,MaxUploadBytes+1))
 if n>MaxUploadBytes { return failure{413,"FILE_TOO_LARGE"} }
 if err!=nil { return err }; if err=r.Context().Err(); err!=nil { return err }
 if err=f.Close(); err!=nil { return err }
 success=true; respond(w,201,map[string]any{"path":p,"bytes":n}); return nil
}
