import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";

// ── Bundled AI install artifacts (docs/ai-agent-autoupdate-execmode-plan.md) ─
//
// The API image ships everything needed to install/refresh the AI worker
// subsystem on a managed VPS over the saved-SSH channel: the two per-arch
// Go binaries, the minimal rootfs tarball + manifest, the confinement
// profiles and the installer script. This service reads that directory,
// computes the stable bundleId over every file digest, and exposes
// per-architecture artifacts for the install runner. Dev machines without
// the directory degrade to available=false + reason instead of throwing
// (PR #37 lesson: DI/factory paths must stay null-safe for partial configs).

export type AiBundleFileEntry = {
  /** Path relative to the bundle root, "/"-separated, sorted-stable. */
  relativePath: string;
  absolutePath: string;
  sha256: string;
  size: number;
};

export type AiBundleArchArtifacts = {
  arch: "amd64" | "arm64";
  executor: AiBundleFileEntry;
  hostHelper: AiBundleFileEntry;
  rootfsTar: AiBundleFileEntry;
  rootfsManifest: AiBundleFileEntry;
  /** sha256 over the rootfs manifest file bytes — exactly what the agent
   * reports back as capability rootfsDigest (Go CalculateManifestDigest),
   * so install confirmation can match on it. */
  rootfsDigest: string;
};

export type AiBundle = {
  available: true;
  /** sha256 over the canonical JSON of the sorted {relativePath, sha256}
   * pairs of every file in the bundle directory. */
  bundleId: string;
  dir: string;
  files: AiBundleFileEntry[];
  installerScript: AiBundleFileEntry;
  /** Sibling library for a zero-network installer run; optional — when
   * absent the installer falls back to its pinned download. */
  installerLib: AiBundleFileEntry | null;
  profiles: AiBundleFileEntry[];
  arches: { amd64: AiBundleArchArtifacts | null; arm64: AiBundleArchArtifacts | null };
};

export type AiBundleUnavailable = {
  available: false;
  reason: string;
};

export type AiBundleInfo = AiBundle | AiBundleUnavailable;

const INSTALLER_SCRIPT = "install-local-agent.sh";
const INSTALLER_LIB = "installer-lib.sh";
const PROFILES_DIR = "profiles";

const ARCH_FILE_NAMES: Record<"amd64" | "arm64", { executor: string; hostHelper: string; rootfsTar: string; rootfsManifest: string }> = {
  amd64: {
    executor: "ai-executor-linux-amd64",
    hostHelper: "ai-host-helper-linux-amd64",
    rootfsTar: "ai-rootfs-linux-amd64.tar.gz",
    rootfsManifest: "ai-rootfs-linux-amd64.manifest.json",
  },
  arm64: {
    executor: "ai-executor-linux-arm64",
    hostHelper: "ai-host-helper-linux-arm64",
    rootfsTar: "ai-rootfs-linux-arm64.tar.gz",
    rootfsManifest: "ai-rootfs-linux-arm64.manifest.json",
  },
};

export const AI_BUNDLE_DIR_CANDIDATES = [
  "/app/agent/ai",
  join(process.cwd(), "agent", "ai"),
  join(process.cwd(), "..", "agent", "ai"),
];

function sha256File(absolutePath: string): { sha256: string; size: number } {
  const buf = readFileSync(absolutePath);
  return { sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length };
}

function toEntry(dir: string, relativePath: string): AiBundleFileEntry {
  const absolutePath = join(dir, ...relativePath.split("/"));
  const { sha256, size } = sha256File(absolutePath);
  return { relativePath, absolutePath, sha256, size };
}

/** Recursively lists every regular file under dir as "/"-separated relative
 * paths, sorted. Symlinks and directories with unreadable entries are
 * skipped so a hostile/partial checkout cannot crash the reader. */
function listBundleFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return found;
  }
  for (const name of names) {
    const absolutePath = join(dir, name);
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      continue;
    }
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (stat.isDirectory()) {
      found.push(...listBundleFiles(absolutePath, relativePath));
      continue;
    }
    if (!stat.isFile()) continue;
    found.push(relativePath);
  }
  return found;
}

@Injectable()
export class AiBundleService {
  private cache: { dirMtimeMs: number; info: AiBundleInfo } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Configured bundle directory (env-backed config with a process-env
   * fallback so hand-built test configs cannot crash the provider). */
  resolveBundleDir(): { dir: string; source: "config" | "default" } | null {
    const configured = this.config.ai?.bundleDir ?? process.env.APP_AI_BUNDLE_DIR;
    if (configured) {
      return existsSync(configured) ? { dir: configured, source: "config" } : null;
    }
    const found = AI_BUNDLE_DIR_CANDIDATES.find((candidate) => existsSync(candidate));
    return found ? { dir: found, source: "default" } : null;
  }

  /** Bundle snapshot (mtime-cached). Never throws: a missing or incomplete
   * directory yields { available: false, reason }. */
  getBundle(): AiBundleInfo {
    const resolved = this.resolveBundleDir();
    if (!resolved) {
      const configured = this.config.ai?.bundleDir ?? process.env.APP_AI_BUNDLE_DIR;
      return {
        available: false,
        reason: configured
          ? `AI bundle directory not found: ${configured}`
          : "AI bundle directory not found (no bundled AI artifacts in this deployment)",
      };
    }
    let dirMtimeMs: number;
    try {
      dirMtimeMs = statSync(resolved.dir).mtimeMs;
    } catch {
      return { available: false, reason: `AI bundle directory unreadable: ${resolved.dir}` };
    }
    if (this.cache && this.cache.dirMtimeMs === dirMtimeMs && this.cache.info.available) {
      return this.cache.info;
    }
    const info = this.readBundle(resolved.dir);
    this.cache = { dirMtimeMs, info };
    return info;
  }

  private readBundle(dir: string): AiBundleInfo {
    let relativePaths: string[];
    try {
      relativePaths = listBundleFiles(dir);
    } catch (error) {
      return {
        available: false,
        reason: `AI bundle directory unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (relativePaths.length === 0) {
      return { available: false, reason: `AI bundle directory is empty: ${dir}` };
    }

    const missing: string[] = [];
    const installerEntry = (name: string): AiBundleFileEntry | null => {
      if (!relativePaths.includes(name)) {
        missing.push(name);
        return null;
      }
      return toEntry(dir, name);
    };
    const installerScript = installerEntry(INSTALLER_SCRIPT);
    const installerLib = relativePaths.includes(INSTALLER_LIB)
      ? toEntry(dir, INSTALLER_LIB)
      : null;

    const profiles = relativePaths
      .filter((p) => p.startsWith(`${PROFILES_DIR}/`))
      .map((p) => toEntry(dir, p));
    if (profiles.length === 0) missing.push(`${PROFILES_DIR}/`);

    const arches: AiBundle["arches"] = { amd64: null, arm64: null };
    for (const arch of ["amd64", "arm64"] as const) {
      const names = ARCH_FILE_NAMES[arch];
      const required = [names.executor, names.hostHelper, names.rootfsTar, names.rootfsManifest];
      if (!required.every((name) => relativePaths.includes(name))) {
        missing.push(...required.filter((name) => !relativePaths.includes(name)));
        continue;
      }
      const executor = toEntry(dir, names.executor);
      const hostHelper = toEntry(dir, names.hostHelper);
      const rootfsTar = toEntry(dir, names.rootfsTar);
      const rootfsManifest = toEntry(dir, names.rootfsManifest);
      arches[arch] = {
        arch,
        executor,
        hostHelper,
        rootfsTar,
        rootfsManifest,
        rootfsDigest: rootfsManifest.sha256,
      };
    }

    if (!installerScript || profiles.length === 0 || (!arches.amd64 && !arches.arm64)) {
      return {
        available: false,
        reason: `AI bundle incomplete: missing ${missing.slice(0, 8).join(", ")}`,
      };
    }

    const files: AiBundleFileEntry[] = [];
    for (const relativePath of relativePaths) {
      try {
        files.push(toEntry(dir, relativePath));
      } catch {
        // File disappeared between listing and read; treat the bundle as
        // incomplete rather than shipping a stale digest.
        return { available: false, reason: `AI bundle file unreadable: ${relativePath}` };
      }
    }

    // bundleId: sha256 over the canonical JSON of sorted {relativePath, sha256}.
    const canonical = JSON.stringify(
      files
        .map((f) => ({ relativePath: f.relativePath, sha256: f.sha256 }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    );
    const bundleId = createHash("sha256").update(canonical).digest("hex");

    return {
      available: true,
      bundleId,
      dir,
      files,
      installerScript,
      installerLib,
      profiles,
      arches,
    };
  }
}
