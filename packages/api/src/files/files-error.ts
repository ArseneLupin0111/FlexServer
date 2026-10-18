const statuses: Record<string, number> = {
 INVALID_PATH:400, FILES_DISABLED:403, DEMO_UNAVAILABLE:403, PERMISSION_DENIED:403,
 FILE_NOT_FOUND:404, DESTINATION_EXISTS:409, DIRECTORY_NOT_EMPTY:409,
 FILE_TOO_LARGE:413, DIRECTORY_TOO_LARGE:413, UNSUPPORTED_MEDIA_TYPE:415,
 UNSUPPORTED_FILE_TYPE:422, FILES_BUSY:429, SFTP_UNAVAILABLE:502,
 LOCAL_FILES_UNAVAILABLE:503, OPERATION_UNSUPPORTED:503, FILES_TIMEOUT:504,
};
export class FilesError extends Error {
 readonly status: number;
 constructor(readonly code: string, message?: string) {
  super(message ?? code.replaceAll("_", " ").toLowerCase());
  this.status = statuses[code] ?? 502;
 }
}
export function mapFilesError(error: unknown): Error {
 if (error instanceof FilesError) return error;
 const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
 if (code === "SSH_HOST_KEY_TRUST_REQUIRED" && error instanceof Error) return error;
 if (typeof code === "string" && statuses[code]) return new FilesError(code);
 if (code === 2 || code === "ENOENT") return new FilesError("FILE_NOT_FOUND");
 if (code === 3 || code === "EACCES") return new FilesError("PERMISSION_DENIED");
 if (code === 11 || code === "EEXIST") return new FilesError("DESTINATION_EXISTS");
 if (code === "ENOTEMPTY") return new FilesError("DIRECTORY_NOT_EMPTY");
 return new FilesError("SFTP_UNAVAILABLE", error instanceof Error ? error.message : String(error));
}
