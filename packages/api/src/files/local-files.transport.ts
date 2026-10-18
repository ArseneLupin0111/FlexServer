/// <reference lib="es2024.promise" />
import { request, type IncomingMessage } from "node:http";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FilesError } from "./files-error.js";
import type { FileEntry, FilesConnection } from "./files.models.js";
import type { VpsRecord } from "../vps/vps.models.js";

export class LocalFilesUnavailableError extends FilesError {
  constructor(message = "Host filesystem helper is unavailable. Check installation and socket permissions.") {
    super("LOCAL_FILES_UNAVAILABLE", message);
  }
}

/** Host access is exclusively through the Unix helper, including native deployments. */
export class LocalFilesTransport {
  constructor(readonly socketPath = process.env.LOCAL_FILES_SOCKET_PATH || "/var/run/flexserver/host-files/files.sock") {}

  async health(signal: AbortSignal): Promise<void> {
    try {
      const response = await this.request("GET", "/health", signal);
      let text = "";
      for await (const chunk of response) {
        text += chunk.toString();
        if (Buffer.byteLength(text) > 16384) { response.destroy(); throw new LocalFilesUnavailableError(); }
      }
      if (response.statusCode !== 200 || JSON.parse(text).data?.protocolVersion !== 1) throw new LocalFilesUnavailableError();
    } catch { throw new LocalFilesUnavailableError(); }
  }

  request(method: string, path: string, signal: AbortSignal, body?: Readable | string, headers: Record<string, string> = {}): Promise<IncomingMessage> {
    const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
      const req = request({ socketPath: this.socketPath, method, path, headers, signal });
      const opening = setTimeout(() => req.destroy(new LocalFilesUnavailableError()), 15000);
      req.once("response", (response) => {
        clearTimeout(opening);
        response.setTimeout(60000, () => response.destroy(new LocalFilesUnavailableError()));
        resolve(response);
      });
      req.once("error", () => { clearTimeout(opening); reject(new LocalFilesUnavailableError()); });
      req.setTimeout(60000, () => req.destroy(new LocalFilesUnavailableError()));
      if (typeof body === "string" || body === undefined) req.end(body);
      else void pipeline(body, req, { signal }).catch(() => req.destroy(new LocalFilesUnavailableError()));
    return promise;
  }
  private async handleErrorResponse(res: IncomingMessage): Promise<never> {
    let text = "";
    try {
      for await (const chunk of res) {
        text += chunk.toString();
        if (text.length > 16384) break;
      }
      const parsed = JSON.parse(text);
      const code = parsed?.error?.code;
      const msg = parsed?.error?.message;
      if (typeof code === "string") throw new FilesError(code, msg);
    } catch (e) {
      if (e instanceof FilesError) throw e;
    }
    throw new LocalFilesUnavailableError();
  }

  private async readText(res: IncomingMessage): Promise<string> {
    let text = "";
    for await (const chunk of res) {
      text += chunk.toString();
      if (text.length > 10 * 1024 * 1024) throw new FilesError("DIRECTORY_TOO_LARGE");
    }
    return text;
  }
  async open(_vps: VpsRecord, signal: AbortSignal): Promise<FilesConnection> {
    await this.health(signal);
    return {
      close: () => {},
      list: async (path) => {
        const res = await this.request("GET", `/entries?path=${encodeURIComponent(path)}`, signal);
        if (res.statusCode !== 200) await this.handleErrorResponse(res);
        const text = await this.readText(res);
        return JSON.parse(text).data;
      },
      download: async (path, output) => {
        const res = await this.request("GET", `/download?path=${encodeURIComponent(path)}`, signal);
        if (res.statusCode !== 200) await this.handleErrorResponse(res);
        let bytes = 0;
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            bytes += chunk.length;
            cb(null, chunk);
          },
        });
        await pipeline(res, counter, output, { signal });
        return bytes;
      },
      upload: async (path, input) => {
        const res = await this.request("PUT", `/upload?path=${encodeURIComponent(path)}`, signal, input, {
          "Content-Type": "application/octet-stream",
        });
        if (res.statusCode !== 201) await this.handleErrorResponse(res);
        const text = await this.readText(res);
        return JSON.parse(text).data.bytes;
      },
      mkdir: async (path) => {
        const res = await this.request("POST", "/directory", signal, JSON.stringify({ path }), {
          "Content-Type": "application/json",
        });
        if (res.statusCode !== 201) await this.handleErrorResponse(res);
      },
      rename: async (path, newPath) => {
        const res = await this.request("POST", "/rename", signal, JSON.stringify({ path, newPath }), {
          "Content-Type": "application/json",
        });
        if (res.statusCode !== 200) await this.handleErrorResponse(res);
      },
      delete: async (path) => {
        const res = await this.request("DELETE", `/entry?path=${encodeURIComponent(path)}`, signal);
        if (res.statusCode !== 204) await this.handleErrorResponse(res);
      },
    };
  }
}
