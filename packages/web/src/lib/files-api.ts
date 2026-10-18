export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number | null;
  modifiedAt: string | null;
  mode: number | null;
};

export type FilesCapabilities = {
  enabled: boolean;
  available: boolean;
  transport: "local" | "sftp";
  reason: string | null;
};

export class FilesApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FilesApiError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body?.error?.code || `HTTP_${res.status}`;
    const message = body?.error?.message || res.statusText || "Request failed";
    throw new FilesApiError(code, message, res.status);
  }
  return body.data as T;
}

export async function getFilesCapabilities(
  vpsId: string,
  signal?: AbortSignal,
): Promise<FilesCapabilities> {
  const res = await fetch(`/api/vps/${encodeURIComponent(vpsId)}/files/capabilities`, {
    credentials: "same-origin",
    signal,
  });
  return handleResponse<FilesCapabilities>(res);
}

export async function listFilesEntries(
  vpsId: string,
  path = "/",
  signal?: AbortSignal,
): Promise<{ path: string; entries: FileEntry[] }> {
  const res = await fetch(
    `/api/vps/${encodeURIComponent(vpsId)}/files/entries?path=${encodeURIComponent(path)}`,
    {
      credentials: "same-origin",
      signal,
    },
  );
  return handleResponse<{ path: string; entries: FileEntry[] }>(res);
}

export async function createDirectory(
  vpsId: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ path: string }> {
  const res = await fetch(`/api/vps/${encodeURIComponent(vpsId)}/files/directory`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: window.location.origin,
    },
    body: JSON.stringify({ path }),
    credentials: "same-origin",
    signal,
  });
  return handleResponse<{ path: string }>(res);
}

export async function renameEntry(
  vpsId: string,
  path: string,
  newPath: string,
  signal?: AbortSignal,
): Promise<{ path: string }> {
  const res = await fetch(`/api/vps/${encodeURIComponent(vpsId)}/files/rename`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: window.location.origin,
    },
    body: JSON.stringify({ path, newPath }),
    credentials: "same-origin",
    signal,
  });
  return handleResponse<{ path: string }>(res);
}

export async function deleteEntry(
  vpsId: string,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/vps/${encodeURIComponent(vpsId)}/files/entry?path=${encodeURIComponent(path)}`,
    {
      method: "DELETE",
      headers: {
        Origin: window.location.origin,
      },
      credentials: "same-origin",
      signal,
    },
  );
  return handleResponse<void>(res);
}

export function downloadFile(vpsId: string, path: string): void {
  const link = document.createElement("a");
  link.href = `/api/vps/${encodeURIComponent(vpsId)}/files/download?path=${encodeURIComponent(path)}`;
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function uploadFile(
  vpsId: string,
  path: string,
  data: Blob | File,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/vps/${encodeURIComponent(vpsId)}/files/upload?path=${encodeURIComponent(path)}`;

    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.timeout = 60 * 60 * 1000;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Origin", window.location.origin);

    if (signal) {
      if (signal.aborted) {
        return reject(new FilesApiError("ABORTED", "Upload cancelled"));
      }
      const abortUpload = () => {
        xhr.abort();
        reject(new FilesApiError("ABORTED", "Upload cancelled"));
      };
      signal.addEventListener("abort", abortUpload, { once: true });
      xhr.addEventListener("loadend", () => signal.removeEventListener("abort", abortUpload), { once: true });
    }

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(e.loaded, e.total);
        } else {
          onProgress(e.loaded, data.size);
        }
      };
    }

    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body?.data || { path, bytes: data.size });
      } else {
        const code = body?.error?.code || `HTTP_${xhr.status}`;
        const message = body?.error?.message || xhr.statusText || "Upload failed";
        reject(new FilesApiError(code, message, xhr.status));
      }
    };
    xhr.ontimeout = () => reject(new FilesApiError("FILES_TIMEOUT", "Upload timed out"));

    xhr.onerror = () => reject(new FilesApiError("NETWORK_ERROR", "Network error during upload"));
    xhr.onabort = () => reject(new FilesApiError("ABORTED", "Upload cancelled"));

    xhr.send(data);
  });
}
