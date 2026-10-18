import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { posix } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { APP_CONFIG, VPS_REPOSITORY, KEY_SERVICE, LOCAL_FILES_TRANSPORT, REMOTE_FILES_TRANSPORT } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { VpsRecord } from "../vps/vps.models.js";
import { VpsNotFoundError } from "../common/errors.js";
import { AuditService } from "../audit/audit.service.js";
import { DashboardSessionService } from "../auth/dashboard-session.service.js";
import type { KeyService } from "../ssh/keyService.js";
import { SshService } from "../ssh/ssh.service.js";
import { FilesError, mapFilesError } from "./files-error.js";
import {
  MAX_UPLOAD_BYTES,
  type FileEntry,
  type FilesCapabilities,
  type FilesConnection,
  type FilesTransport,
} from "./files.models.js";
import { LocalFilesTransport } from "./local-files.transport.js";
import { RemoteFilesTransport } from "./remote-files.transport.js";

export type SessionContext = {
  dashboardSessionId?: string;
};

type ActiveOperation = {
  id: string;
  vpsId: string;
  dashboardSessionId?: string;
  abortController: AbortController;
  initialHost?: string;
  initialPort?: number;
  initialUsername?: string;
};

const MAX_CONCURRENT_PER_VPS = 2;
const MAX_CONCURRENT_GLOBAL = 10;
const OPEN_TIMEOUT_MS = 15000;
const METADATA_TIMEOUT_MS = 30000;
const TRANSFER_IDLE_TIMEOUT_MS = 60000;
const TRANSFER_TOTAL_TIMEOUT_MS = 3600000;

@Injectable()
export class FilesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly activeOperations = new Map<string, ActiveOperation>();
  private revalidationInterval: NodeJS.Timeout | null = null;
  private readonly defaultLocalTransport: LocalFilesTransport;
  private readonly defaultRemoteTransport: RemoteFilesTransport;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VPS_REPOSITORY) private readonly vpsRepository: VpsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DashboardSessionService) private readonly dashboardSessions: DashboardSessionService,
    @Inject(KEY_SERVICE) private readonly keyService: KeyService,
    @Inject(SshService) private readonly sshService: SshService,
    @Optional() @Inject(LOCAL_FILES_TRANSPORT) private readonly customLocalTransport?: FilesTransport,
    @Optional() @Inject(REMOTE_FILES_TRANSPORT) private readonly customRemoteTransport?: FilesTransport,
  ) {
    this.defaultLocalTransport = new LocalFilesTransport(this.config.localFilesSocketPath);
    this.defaultRemoteTransport = new RemoteFilesTransport(this.sshService, this.keyService);
  }

  onApplicationBootstrap(): void {
    this.startRevalidationLoop();
  }

  onApplicationShutdown(): void {
    if (this.revalidationInterval) {
      clearInterval(this.revalidationInterval);
      this.revalidationInterval = null;
    }
    for (const op of this.activeOperations.values()) {
      op.abortController.abort(new FilesError("FILES_BUSY", "Server shutting down"));
    }
    this.activeOperations.clear();
  }

  private isLocal(vps: VpsRecord): boolean {
    return vps.kind === "local" || vps.managedBy === "system";
  }

  private getTransport(vps: VpsRecord): FilesTransport {
    if (this.isLocal(vps)) {
      return this.customLocalTransport ?? this.defaultLocalTransport;
    }
    return this.customRemoteTransport ?? this.defaultRemoteTransport;
  }

  cancelOperationsForVps(vpsId: string, reason = "Files access disabled or host configuration changed"): void {
    for (const op of this.activeOperations.values()) {
      if (op.vpsId === vpsId) {
        op.abortController.abort(new FilesError("FILES_DISABLED", reason));
      }
    }
  }

  private startRevalidationLoop(): void {
    if (this.revalidationInterval) return;
    this.revalidationInterval = setInterval(async () => {
      if (this.activeOperations.size === 0) return;
      for (const op of Array.from(this.activeOperations.values())) {
        try {
          const vps = await this.vpsRepository.get(op.vpsId);
          if (
            !vps ||
            vps.sftpEnabled !== true ||
            vps.host !== op.initialHost ||
            vps.port !== op.initialPort ||
            vps.username !== op.initialUsername
          ) {
            op.abortController.abort(
              new FilesError("FILES_DISABLED", "VPS settings changed or files access disabled"),
            );
            continue;
          }

          if (op.dashboardSessionId && this.config.mode === "local") {
            const session = await this.dashboardSessions.authenticateById(op.dashboardSessionId);
            if (!session) {
              op.abortController.abort(
                new FilesError("PERMISSION_DENIED", "Dashboard session expired or revoked"),
              );
            }
          }
        } catch {
          // If repository check fails, fail-safe abort
          op.abortController.abort(new FilesError("FILES_DISABLED", "Host lookup failed"));
        }
      }
    }, 1000);
    this.revalidationInterval.unref();
  }

  private acquireSlot(vps: VpsRecord, dashboardSessionId?: string): ActiveOperation {
    if (this.activeOperations.size >= MAX_CONCURRENT_GLOBAL) {
      throw new FilesError("FILES_BUSY", "Global files transfer capacity reached. Try again later.");
    }
    let perVpsCount = 0;
    for (const op of this.activeOperations.values()) {
      if (op.vpsId === vps.id) perVpsCount++;
    }
    if (perVpsCount >= MAX_CONCURRENT_PER_VPS) {
      throw new FilesError("FILES_BUSY", "Maximum concurrent file operations reached for this host.");
    }

    const id = `${vps.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const op: ActiveOperation = {
      id,
      vpsId: vps.id,
      dashboardSessionId,
      abortController: new AbortController(),
      initialHost: vps.host,
      initialPort: vps.port,
      initialUsername: vps.username,
    };
    this.activeOperations.set(id, op);
    return op;
  }

  private releaseSlot(opId: string): void {
    this.activeOperations.delete(opId);
  }

  private async preflight(
    vpsId: string,
    ctx: SessionContext,
  ): Promise<{ vps: VpsRecord; slot: ActiveOperation }> {
    if (this.config.mode === "demo") {
      throw new FilesError("DEMO_UNAVAILABLE", "Files access is unavailable in demo mode");
    }

    const vps = await this.vpsRepository.get(vpsId);
    if (!vps) {
      throw new VpsNotFoundError();
    }

    if (vps.sftpEnabled !== true) {
      throw new FilesError("FILES_DISABLED", "Files access is disabled for this VPS");
    }

    if (ctx.dashboardSessionId && this.config.mode === "local") {
      const active = await this.dashboardSessions.authenticateById(ctx.dashboardSessionId);
      if (!active) {
        throw new FilesError("PERMISSION_DENIED", "Dashboard session expired or invalid");
      }
    }

    const slot = this.acquireSlot(vps, ctx.dashboardSessionId);
    return { vps, slot };
  }

  async capabilities(vpsId: string): Promise<FilesCapabilities> {
    const vps = await this.vpsRepository.get(vpsId);
    if (!vps) {
      throw new VpsNotFoundError();
    }

    const transportKind = this.isLocal(vps) ? "local" : "sftp";
    if (this.config.mode === "demo") {
      return {
        enabled: false,
        available: false,
        transport: transportKind,
        reason: "Files operations are unavailable in demo mode",
      };
    }

    if (vps.sftpEnabled !== true) {
      return {
        enabled: false,
        available: false,
        transport: transportKind,
        reason: "Files access is disabled for this VPS",
      };
    }

    let slot: ActiveOperation | null = null;
    try {
      slot = this.acquireSlot(vps);
    } catch {
      return {
        enabled: true,
        available: false,
        transport: transportKind,
        reason: "Files transport is busy",
      };
    }

    const probeSignal = AbortSignal.any([
      slot.abortController.signal,
      AbortSignal.timeout(OPEN_TIMEOUT_MS),
    ]);

    try {
      const transport = this.getTransport(vps);
      const conn = await transport.open(vps, probeSignal);
      conn.close();
      return {
        enabled: true,
        available: true,
        transport: transportKind,
        reason: null,
      };
    } catch (err: unknown) {
      const mapped = mapFilesError(err);
      return {
        enabled: true,
        available: false,
        transport: transportKind,
        reason: mapped.message,
      };
    } finally {
      if (slot) this.releaseSlot(slot.id);
    }
  }

  async list(
    vpsId: string,
    path: string,
    ctx: SessionContext,
  ): Promise<{ path: string; entries: FileEntry[] }> {
    const { vps, slot } = await this.preflight(vpsId, ctx);
    const timeoutSignal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([slot.abortController.signal, timeoutSignal]);

    let conn: FilesConnection | null = null;
    try {
      const transport = this.getTransport(vps);
      conn = await transport.open(vps, combinedSignal);
      const result = await conn.list(path);

      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.list",
        resourceType: "vps",
        resourceId: vpsId,
        result: "success",
        metadata: { path, entryCount: result.entries.length },
      });

      return result;
    } catch (err: unknown) {
      const mapped = mapFilesError(err);
      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.list",
        resourceType: "vps",
        resourceId: vpsId,
        result: "failure",
        metadata: { path, errorCode: mapped instanceof FilesError ? mapped.code : "SFTP_UNAVAILABLE" },
      });
      throw mapped;
    } finally {
      if (conn) conn.close();
      this.releaseSlot(slot.id);
    }
  }

  async download(
    vpsId: string,
    path: string,
    res: Response,
    ctx: SessionContext,
  ): Promise<void> {
    const { vps, slot } = await this.preflight(vpsId, ctx);
    const totalTimeoutSignal = AbortSignal.timeout(TRANSFER_TOTAL_TIMEOUT_MS);
    let idleTimer: NodeJS.Timeout | null = null;
    const idleAbort = new AbortController();

    const resetIdleTimer = () => {
      clearTimeout(idleTimer!);
      idleTimer = setTimeout(() => {
        idleAbort.abort(new FilesError("FILES_TIMEOUT", "Transfer idle timeout exceeded"));
      }, TRANSFER_IDLE_TIMEOUT_MS);
    };

    resetIdleTimer();

    const combinedSignal = AbortSignal.any([
      slot.abortController.signal,
      totalTimeoutSignal,
      idleAbort.signal,
    ]);

    let conn: FilesConnection | null = null;
    let transferredBytes = 0;
    try {
      const transport = this.getTransport(vps);
      conn = await transport.open(vps, combinedSignal);

      const basename = posix.basename(path);
      const safeAscii = basename.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const encoded = encodeURIComponent(basename).replace(/['()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`,
      );
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");

      const meter = new Transform({
        transform(chunk, _enc, cb) {
          resetIdleTimer();
          transferredBytes += chunk.length;
          cb(null, chunk);
        },
      });

      const forwardPipeline = pipeline(meter, res);
      // Transport preflight can fail before this pipeline is awaited.
      // Observe response closure immediately to avoid an unhandled rejection.
      void forwardPipeline.catch(() => {});

      const clientCloseListener = () => {
        slot.abortController.abort(new FilesError("FILES_TIMEOUT", "Client disconnected"));
      };
      res.once("close", clientCloseListener);

      try {
        await conn.download(path, meter);
        await forwardPipeline;
      } finally {
        res.off("close", clientCloseListener);
      }

      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.download",
        resourceType: "vps",
        resourceId: vpsId,
        result: "success",
        metadata: { path, bytes: transferredBytes },
      });
    } catch (err: unknown) {
      const mapped = mapFilesError(err);
      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.download",
        resourceType: "vps",
        resourceId: vpsId,
        result: "failure",
        metadata: { path, bytes: transferredBytes, errorCode: mapped instanceof FilesError ? mapped.code : "SFTP_UNAVAILABLE" },
      });

      if (!res.headersSent) {
        throw mapped;
      } else {
        res.destroy(mapped);
      }
    } finally {
      clearTimeout(idleTimer!);
      if (conn) conn.close();
      this.releaseSlot(slot.id);
    }
  }

  async upload(
    vpsId: string,
    path: string,
    req: Request,
    ctx: SessionContext,
  ): Promise<{ path: string; bytes: number }> {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/octet-stream")) {
      throw new FilesError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/octet-stream");
    }

    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
        throw new FilesError("FILE_TOO_LARGE", "File exceeds maximum upload size of 1 GiB");
      }
    }

    const { vps, slot } = await this.preflight(vpsId, ctx);
    const totalTimeoutSignal = AbortSignal.timeout(TRANSFER_TOTAL_TIMEOUT_MS);
    let idleTimer: NodeJS.Timeout | null = null;
    const idleAbort = new AbortController();

    const resetIdleTimer = () => {
      clearTimeout(idleTimer!);
      idleTimer = setTimeout(() => {
        idleAbort.abort(new FilesError("FILES_TIMEOUT", "Transfer idle timeout exceeded"));
      }, TRANSFER_IDLE_TIMEOUT_MS);
    };

    resetIdleTimer();

    const combinedSignal = AbortSignal.any([
      slot.abortController.signal,
      totalTimeoutSignal,
      idleAbort.signal,
    ]);

    let conn: FilesConnection | null = null;
    let uploadedBytes = 0;
    try {
      const transport = this.getTransport(vps);
      conn = await transport.open(vps, combinedSignal);

      const meter = new Transform({
        transform(chunk, _enc, cb) {
          resetIdleTimer();
          uploadedBytes += chunk.length;
          if (uploadedBytes > MAX_UPLOAD_BYTES) {
            cb(new FilesError("FILE_TOO_LARGE", "File exceeds maximum upload size of 1 GiB"));
            return;
          }
          cb(null, chunk);
        },
      });

      const clientCloseListener = () => {
        if (!req.complete) {
          slot.abortController.abort(new FilesError("FILES_TIMEOUT", "Client disconnected"));
        }
      };
      req.once("close", clientCloseListener);

      const meteredStream = req.pipe(meter);

      try {
        const bytes = await conn.upload(path, meteredStream as unknown as Readable);

        // Revalidate VPS state before returning success
        const latestVps = await this.vpsRepository.get(vpsId);
        if (!latestVps || latestVps.sftpEnabled !== true) {
          throw new FilesError("FILES_DISABLED", "Files access disabled during upload");
        }

        await this.audit.record({
          actor: ctx.dashboardSessionId ?? "dashboard",
          action: "files.upload",
          resourceType: "vps",
          resourceId: vpsId,
          result: "success",
          metadata: { path, bytes },
        });

        return { path, bytes };
      } finally {
        req.off("close", clientCloseListener);
      }
    } catch (err: unknown) {
      const mapped = mapFilesError(err);
      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.upload",
        resourceType: "vps",
        resourceId: vpsId,
        result: "failure",
        metadata: { path, bytes: uploadedBytes, errorCode: mapped instanceof FilesError ? mapped.code : "SFTP_UNAVAILABLE" },
      });
      throw mapped;
    } finally {
      clearTimeout(idleTimer!);
      if (conn) conn.close();
      this.releaseSlot(slot.id);
    }
  }

  async mkdir(vpsId: string, path: string, ctx: SessionContext): Promise<{ path: string }> {
    const { vps, slot } = await this.preflight(vpsId, ctx);
    const timeoutSignal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([slot.abortController.signal, timeoutSignal]);

    let conn: FilesConnection | null = null;
    try {
      const transport = this.getTransport(vps);
      conn = await transport.open(vps, combinedSignal);
      await conn.mkdir(path);

      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.mkdir",
        resourceType: "vps",
        resourceId: vpsId,
        result: "success",
        metadata: { path },
      });

      return { path };
    } catch (err: unknown) {
      const mapped = mapFilesError(err);
      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.mkdir",
        resourceType: "vps",
        resourceId: vpsId,
        result: "failure",
        metadata: { path, errorCode: mapped instanceof FilesError ? mapped.code : "SFTP_UNAVAILABLE" },
      });
      throw mapped;
    } finally {
      if (conn) conn.close();
      this.releaseSlot(slot.id);
    }
  }

  async rename(
    vpsId: string,
    path: string,
    newPath: string,
    ctx: SessionContext,
  ): Promise<{ path: string }> {
    const { vps, slot } = await this.preflight(vpsId, ctx);
    const timeoutSignal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([slot.abortController.signal, timeoutSignal]);

    let conn: FilesConnection | null = null;
    try {
      const transport = this.getTransport(vps);
      conn = await transport.open(vps, combinedSignal);

      if (path === newPath) {
        // Verify source existence
        const parent = posix.dirname(path);
        const name = posix.basename(path);
        const entries = await conn.list(parent);
        const exists = entries.entries.some((e) => e.name === name);
        if (!exists) throw new FilesError("FILE_NOT_FOUND");
        return { path: newPath };
      }

      await conn.rename(path, newPath);

      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.rename",
        resourceType: "vps",
        resourceId: vpsId,
        result: "success",
        metadata: { path, newPath },
      });

      return { path: newPath };
    } catch (err: unknown) {
      const mapped = mapFilesError(err);
      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.rename",
        resourceType: "vps",
        resourceId: vpsId,
        result: "failure",
        metadata: { path, newPath, errorCode: mapped instanceof FilesError ? mapped.code : "SFTP_UNAVAILABLE" },
      });
      throw mapped;
    } finally {
      if (conn) conn.close();
      this.releaseSlot(slot.id);
    }
  }

  async delete(vpsId: string, path: string, ctx: SessionContext): Promise<void> {
    const { vps, slot } = await this.preflight(vpsId, ctx);
    const timeoutSignal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([slot.abortController.signal, timeoutSignal]);

    let conn: FilesConnection | null = null;
    try {
      const transport = this.getTransport(vps);
      conn = await transport.open(vps, combinedSignal);
      await conn.delete(path);

      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.delete",
        resourceType: "vps",
        resourceId: vpsId,
        result: "success",
        metadata: { path },
      });
    } catch (err: unknown) {
      const mapped = mapFilesError(err);
      await this.audit.record({
        actor: ctx.dashboardSessionId ?? "dashboard",
        action: "files.delete",
        resourceType: "vps",
        resourceId: vpsId,
        result: "failure",
        metadata: { path, errorCode: mapped instanceof FilesError ? mapped.code : "SFTP_UNAVAILABLE" },
      });
      throw mapped;
    } finally {
      if (conn) conn.close();
      this.releaseSlot(slot.id);
    }
  }
}
