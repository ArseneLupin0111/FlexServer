/// <reference lib="es2024.promise" />
import { posix } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileEntryWithStats, Stats } from "ssh2";
import type { KeyService } from "../ssh/keyService.js";
import type { ManagedSftpConnection } from "../ssh/sshService.js";
import type { SshService } from "../ssh/ssh.service.js";
import type { VpsRecord } from "../vps/vps.models.js";
import { FilesError, mapFilesError } from "./files-error.js";
import { MAX_UPLOAD_BYTES, type FileEntry, type FilesConnection } from "./files.models.js";

function invoke<T>(operation: (done: (error: Error | undefined | null, value: T) => void) => void): Promise<T> {
 const { promise, resolve, reject } = Promise.withResolvers<T>();
 operation((error, value) => error ? reject(mapFilesError(error)) : resolve(value));
 return promise;
}

export class RemoteFilesTransport {
 constructor(private readonly ssh: SshService, private readonly keys: KeyService) {}
 async open(vps: VpsRecord, signal: AbortSignal): Promise<FilesConnection> {
  let privateKey: string;
  try { privateKey = await this.keys.readPrivateKey(vps.id); }
  catch { throw new FilesError("SFTP_UNAVAILABLE", "SSH private key is missing. Provision this host's key first."); }
  let connection: ManagedSftpConnection;
  try { connection = await this.ssh.openManagedSftp(vps, { privateKey }); }
  catch (error) { throw mapFilesError(error); }
  const { sftp } = connection;
  const close = () => { signal.removeEventListener("abort", close); connection.close(); };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) { close(); throw signal.reason; }
  const stat = (path: string, follow = false) => invoke<Stats>(done => follow ? sftp.stat(path, done) : sftp.lstat(path, done));
  const absent = async (path: string) => {
   try { await stat(path); } catch (error) { if (error instanceof FilesError && error.code === "FILE_NOT_FOUND") return; throw error; }
   throw new FilesError("DESTINATION_EXISTS");
  };
  return {
   close,
   async list(path) {
    signal.throwIfAborted();
    const canonical = await invoke<string>(done => sftp.realpath(path, done));
    const raw = await invoke<FileEntryWithStats[]>(done => sftp.readdir(canonical, done));
    if (raw.length > 10000) throw new FilesError("DIRECTORY_TOO_LARGE");
    const entries: FileEntry[] = [];
    for (const item of raw) {
     if (item.filename === "." || item.filename === "..") continue;
     const a = item.attrs;
     const isDir = a.isDirectory();
     const isLnk = a.isSymbolicLink();
     const isReg = a.isFile();
     const type = isLnk ? "symlink" : isDir ? "directory" : isReg ? "file" : "other";
     entries.push({
      name: item.filename,
      path: posix.join(canonical, item.filename),
      type,
      size: Number.isFinite(a.size) ? a.size : null,
      modifiedAt: Number.isFinite(a.mtime) ? new Date(a.mtime * 1000).toISOString() : null,
      mode: Number.isFinite(a.mode) ? a.mode : null,
     });
    }
    entries.sort((a,b) => Number(b.type === "directory") - Number(a.type === "directory") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { path: canonical, entries };
   },
   async download(path, output: Writable) {
    if (!(await stat(path,true)).isFile()) throw new FilesError("UNSUPPORTED_FILE_TYPE");
    let bytes = 0;
    const counter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(null,chunk); } });
    await pipeline(sftp.createReadStream(path), counter, output, { signal });
    return bytes;
   },
   async upload(path, input: Readable) {
    await absent(path);
    let bytes = 0;
    const counter = new Transform({ transform(chunk, _encoding, callback) {
     bytes += chunk.length;
     callback(bytes > MAX_UPLOAD_BYTES ? new FilesError("FILE_TOO_LARGE") : null, chunk);
    } });
    try { await pipeline(input, counter, sftp.createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal }); }
    catch (error) {
     // SFTP v3 does not expose an inode identity; never unlink a possibly replaced file.
     const mapped = mapFilesError(error);
     if (mapped instanceof FilesError) throw new FilesError(mapped.code, `${mapped.message}. A partial upload may remain at ${path}; inspect it before removing.`);
     throw mapped;
    }
    return bytes;
   },
   async mkdir(path) { await absent(path); await invoke<void>(done => sftp.mkdir(path, { mode: 0o755 }, done)); },
   async rename(path,newPath) {
    const source = await stat(path);
    if (!source.isFile() && !source.isDirectory() && !source.isSymbolicLink()) throw new FilesError("UNSUPPORTED_FILE_TYPE");

    if (source.isDirectory() && newPath.startsWith(path + "/")) throw new FilesError("INVALID_PATH");
    await absent(newPath);
    await invoke<void>(done => sftp.rename(path,newPath,done));
   },
   async delete(path) {
    const source = await stat(path);
    if (source.isDirectory()) {
     const children = await invoke<FileEntryWithStats[]>(done => sftp.readdir(path,done));
     if (children.some(entry => entry.filename !== "." && entry.filename !== "..")) throw new FilesError("DIRECTORY_NOT_EMPTY");
     await invoke<void>(done => sftp.rmdir(path,done));
    } else if (source.isFile() || source.isSymbolicLink()) await invoke<void>(done => sftp.unlink(path,done));
    else throw new FilesError("UNSUPPORTED_FILE_TYPE");
   },
  };
 }
}
