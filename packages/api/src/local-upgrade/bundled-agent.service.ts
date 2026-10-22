import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";

export type BundledAgentMetadata = {
  filePath: string;
  os: "linux";
  arch: "amd64" | "arm64";
  version: string;
  buildId: string;
  sha256: string;
  size: number;
  publishedAt: string;
};

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function extractAgentBinaryMetadata(
  filePath: string,
  buffer?: Buffer,
): BundledAgentMetadata {
  const stat = statSync(filePath);
  const buf = buffer ?? readFileSync(filePath);

  // 1. Strict ELF64 little-endian Linux validation
  if (buf.length < 64) {
    throw new Error(`Invalid agent binary: file size (${buf.length} bytes) is less than ELF64 header`);
  }
  if (
    buf[0] !== 0x7f ||
    buf[1] !== 0x45 || // 'E'
    buf[2] !== 0x4c || // 'L'
    buf[3] !== 0x46    // 'F'
  ) {
    throw new Error("Invalid agent binary: missing ELF magic header");
  }
  if (buf[4] !== 2) {
    throw new Error("Invalid agent binary: not ELF64 (64-bit)");
  }
  if (buf[5] !== 1) {
    throw new Error("Invalid agent binary: not little-endian (ELFDATA2LSB)");
  }
  if (buf[7] !== 0 && buf[7] !== 3) {
    throw new Error(`Invalid agent binary: non-Linux OS ABI (${buf[7]})`);
  }

  const machine = buf.readUInt16LE(18);
  let arch: "amd64" | "arm64";
  if (machine === 0x3e) {
    arch = "amd64";
  } else if (machine === 0xb7) {
    arch = "arm64";
  } else {
    throw new Error(`Invalid agent binary: unsupported machine architecture (0x${machine.toString(16)})`);
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");

  // 2. Check for companion build manifest packaged alongside binary
  const companionPath = `${filePath}.json`;
  if (existsSync(companionPath)) {
    try {
      const companionRaw = JSON.parse(readFileSync(companionPath, "utf8"));
      if (companionRaw.sha256 && companionRaw.sha256 !== sha256) {
        throw new Error("Companion manifest sha256 does not match binary sha256");
      }
      if (companionRaw.arch && companionRaw.arch !== arch) {
        throw new Error(`Companion manifest arch (${companionRaw.arch}) does not match ELF arch (${arch})`);
      }
      if (!companionRaw.buildId || !GIT_SHA_RE.test(companionRaw.buildId)) {
        throw new Error("Companion manifest missing valid 40-hex buildId");
      }
      if (!companionRaw.version || !VERSION_RE.test(companionRaw.version)) {
        throw new Error("Companion manifest missing valid version");
      }
      return {
        filePath,
        os: "linux",
        arch,
        version: companionRaw.version,
        buildId: companionRaw.buildId,
        sha256,
        size: stat.size,
        publishedAt: companionRaw.publishedAt ?? new Date(stat.mtimeMs).toISOString(),
      };
    } catch (err: unknown) {
      if ((err as Error).message.includes("does not match") || (err as Error).message.includes("missing valid")) {
        throw err;
      }
    }
  }

  // 3. Parse targeted Go build metadata from buffer without full-buffer copy
  let version: string | null = null;
  let buildId: string | null = null;

  const buildMarker = Buffer.from("version.Build=");
  const buildIdx = buf.indexOf(buildMarker);
  if (buildIdx !== -1) {
    const start = buildIdx + buildMarker.length;
    if (start + 40 <= buf.length) {
      const candidate = buf.subarray(start, start + 40).toString("ascii");
      if (GIT_SHA_RE.test(candidate)) {
        buildId = candidate;
      }
    }
  }

  const valueMarker = Buffer.from("version.Value=");
  const valueIdx = buf.indexOf(valueMarker);
  if (valueIdx !== -1) {
    const start = valueIdx + valueMarker.length;
    let end = start;
    while (
      end < buf.length &&
      end < start + 64 &&
      buf[end] !== 0 &&
      buf[end] !== 0x20 &&
      buf[end] !== 0x0a &&
      buf[end] !== 0x22 &&
      buf[end] !== 0x27
    ) {
      end++;
    }
    const candidate = buf.subarray(start, end).toString("ascii");
    if (VERSION_RE.test(candidate)) {
      version = candidate;
    }
  }

  if (!buildId) {
    const vcsMarker = Buffer.from("vcs.revision=");
    const vcsIdx = buf.indexOf(vcsMarker);
    if (vcsIdx !== -1) {
      const start = vcsIdx + vcsMarker.length;
      if (start + 40 <= buf.length) {
        const candidate = buf.subarray(start, start + 40).toString("ascii");
        if (GIT_SHA_RE.test(candidate)) {
          buildId = candidate;
        }
      }
    }
  }

  if (!buildId || !GIT_SHA_RE.test(buildId)) {
    throw new Error("Agent binary is missing valid 40-hex build identity (version.Build)");
  }
  if (!version || !VERSION_RE.test(version)) {
    throw new Error("Agent binary is missing valid version (version.Value)");
  }

  return {
    filePath,
    os: "linux",
    arch,
    version,
    buildId,
    sha256,
    size: stat.size,
    publishedAt: new Date(stat.mtimeMs).toISOString(),
  };
}

function inspectElfArch(filePath: string): "amd64" | "arm64" | null {

  try {
    const stat = statSync(filePath);
    if (stat.size < 64) return null;
    const buf = readFileSync(filePath);
    if (buf.length < 64) return null;
    if (
      buf[0] !== 0x7f ||
      buf[1] !== 0x45 ||
      buf[2] !== 0x4c ||
      buf[3] !== 0x46
    ) {
      return null;
    }
    if (buf[4] !== 2) return null; // ELF64
    if (buf[5] !== 1) return null; // little-endian
    if (buf[7] !== 0 && buf[7] !== 3) return null; // Linux OS ABI
    const machine = buf.readUInt16LE(18);
    if (machine === 0x3e) return "amd64";
    if (machine === 0xb7) return "arm64";
    return null;
  } catch {
    return null;
  }
}

@Injectable()
export class BundledAgentService {
  private readonly cache = new Map<
    string,
    {
      mtimeMs: number;
      size: number;
      meta: BundledAgentMetadata;
    }
  >();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  resolveBinaryPath(arch: "amd64" | "arm64"): string | null {
    const configuredPath =
      this.config.agentBinaryPath || process.env.AGENT_BINARY_PATH || null;

    if (configuredPath) {
      const configuredName = configuredPath.toLowerCase();
      const otherArch = arch === "amd64" ? "arm64" : "amd64";
      const targetedForArch =
        configuredName.includes(arch) && !configuredName.includes(otherArch);
      const targetedForOther =
        configuredName.includes(otherArch) && !configuredName.includes(arch);

      if (existsSync(configuredPath)) {
        const elfArch = inspectElfArch(configuredPath);
        if (elfArch === arch) {
          return configuredPath;
        }
        // If the configured artifact was explicitly targeted for this arch,
        // but has invalid/mismatched ELF: fail closed for this arch.
        if (targetedForArch || elfArch === null) {
          return null;
        }
        // Configured binary is valid ELF for the other architecture.
        // Resolve the requested architecture via sibling then fallback directories.
        const sibling = join(
          dirname(configuredPath),
          `vps-agent-linux-${arch}`,
        );
        if (existsSync(sibling) && inspectElfArch(sibling) === arch) {
          return sibling;
        }
        return this.resolveFallbackPath(arch);
      }

      // Configured path does not exist on disk (missing configured artifact)
      // If targeted for the other architecture, check for a valid sibling in the same directory.
      if (targetedForOther) {
        const sibling = join(
          dirname(configuredPath),
          `vps-agent-linux-${arch}`,
        );
        if (existsSync(sibling) && inspectElfArch(sibling) === arch) {
          return sibling;
        }
      }
      // Missing configured artifact reports unavailable for this architecture (no fallback)
      return null;
    }

    return this.resolveFallbackPath(arch);
  }

  private resolveFallbackPath(arch: "amd64" | "arm64"): string | null {
    const fallbacks = [
      `/app/agent/vps-agent-linux-${arch}`,
      join(process.cwd(), "agent", `vps-agent-linux-${arch}`),
      join(process.cwd(), "packages", "agent", "dist", `vps-agent-linux-${arch}`),
      join(process.cwd(), "..", "agent", "dist", `vps-agent-linux-${arch}`),
    ];
    for (const fb of fallbacks) {
      if (existsSync(fb) && inspectElfArch(fb) === arch) {
        return fb;
      }
    }
    return null;
  }

  getMetadata(arch: "amd64" | "arm64"): BundledAgentMetadata | null {
    const binPath = this.resolveBinaryPath(arch);
    if (!binPath) return null;
    try {
      const stat = statSync(binPath);
      const cached = this.cache.get(binPath);
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size
      ) {
        return cached.meta;
      }
      const meta = extractAgentBinaryMetadata(binPath);
      if (meta.arch !== arch) {
        return null;
      }
      this.cache.set(binPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
      return meta;
    } catch {
      return null;
    }
  }
}
