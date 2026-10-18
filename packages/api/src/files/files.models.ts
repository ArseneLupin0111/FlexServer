import type { Readable, Writable } from "node:stream";

export const MAX_UPLOAD_BYTES = 1073741824;
export type FileEntry = { name: string; path: string; type: "file" | "directory" | "symlink" | "other"; size: number | null; modifiedAt: string | null; mode: number | null };
export type FilesCapabilities = {
  enabled: boolean;
  available: boolean;
  transport: "local" | "sftp";
  reason: string | null;
};

export interface FilesTransport {
  open(vps: import("../vps/vps.models.js").VpsRecord, signal: AbortSignal): Promise<FilesConnection>;
}

export interface FilesConnection {
  close(): void;
  list(path: string): Promise<{ path: string; entries: FileEntry[] }>;
  download(path: string, output: Writable): Promise<number>;
  upload(path: string, input: Readable): Promise<number>;
  mkdir(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
}
