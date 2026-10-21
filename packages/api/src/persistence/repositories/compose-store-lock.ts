import { open, unlink, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lock from "proper-lockfile";
import { randomBytes } from "node:crypto";

/**
 * Lifetime single-writer store guard for the Compose applications stores.
 *
 * The JSON driver for docker applications is a whole-store flat file that must
 * be written by exactly one API process. Enforcement:
 *  - lockfile acquired at API startup with proper-lockfile (mtime stale checks
 *    disabled; no OS-flock assumption), held for the process lifetime.
 *  - the lock file carries a random nonce; every write batch verifies the
 *    on-disk nonce still matches ours before mutating; loss (another process
 *    took over after compromise) refuses the write with STORE_LOCKED (503).
 *  - NO automatic stale unlink: crash leaves the lock behind; recovery is an
 *    explicit offline admin action documented by the parent ops docs ("confirm
 *    no API process is running, then delete the lock file").
 *  - orderly shutdown unlink verified against our nonce; tests call
 *    releaseComposeStoreLock(). PID reuse / tolerance races are avoided
 *    because we never treat a foreign or stale file as ours without matching
 *    nonce, and never unlink a nonce we did not write.
 */
export type ComposeStoreLockIdentity = {
  path: string;
  nonce: string;
  pid: number;
  host: string;
  startedAt: string;
};

export type ComposeStoreLockHeld = ComposeStoreLockIdentity & {
  release: () => Promise<void>;
};

let activeGuard: ComposeStoreLockIdentity | null = null;
let activeRelease: (() => Promise<void>) | null = null;

const DEFAULT_LOCK_FILE_NAME = ".docker-compose-writer.lock";
const LOCK_RETRY = {
  retries: 120,
  factor: 1,
  minTimeout: 50,
  maxTimeout: 200,
} as const;

export class ComposeStoreLockError extends Error {
  readonly code = "compose_store_locked" as const;

  constructor(message: string) {
    super(message);
    this.name = "ComposeStoreLockError";
  }
}

type LockFileContent = {
  nonce: string;
  pid: number;
  host: string;
  startedAt: string;
};

async function readNonce(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as LockFileContent;
    if (typeof parsed?.nonce === "string" && parsed.nonce.length >= 16) {
      return parsed.nonce;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeNonceFile(
  filePath: string,
  content: LockFileContent,
): Promise<void> {
  await writeFile(filePath, JSON.stringify(content, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
}

function defaultHostId(): string {
  return typeof process.env.COMPUTERNAME === "string"
    ? process.env.COMPUTERNAME
    : process.platform;
}

async function ensureWritableDir(dirPath: string): Promise<void> {
  const probe = join(dirPath, ".compose-lock-probe");
  try {
    const handle = await open(probe, "a", 0o600);
    await handle.close();
    await unlink(probe).catch(() => undefined);
  } catch (err: unknown) {
    throw new ComposeStoreLockError(
      `cannot create data directory for compose store lock: ${String(err)}`,
    );
  }
}

/** Acquire the store lock (idempotent within a process). */
export async function acquireComposeStoreLock(dataDir: string): Promise<void> {
  if (activeGuard) return;
  await ensureWritableDir(dataDir);
  const filePath = join(dataDir, DEFAULT_LOCK_FILE_NAME);
  const release = await lock.lock(filePath, {
    realpath: false,
    retries: LOCK_RETRY,
    stale: 30_000,
    onCompromised: (err: unknown) => {
      throw new ComposeStoreLockError(
        `compose store lock compromised by another process: ${String(err)}`,
      );
    },
  });
  const nonce = randomBytes(16).toString("hex");
  const identity: ComposeStoreLockIdentity = {
    path: filePath,
    nonce,
    pid: process.pid,
    host: defaultHostId(),
    startedAt: new Date().toISOString(),
  };
  await writeNonceFile(filePath, {
    nonce,
    pid: identity.pid,
    host: identity.host,
    startedAt: identity.startedAt,
  });
  activeGuard = identity;
  activeRelease = async () => {
    if ((await readNonce(filePath)) === nonce) {
      await release();
    }
  };
}

/**
 * Verify the lock we hold is still current (nonce match) before a write
 * batch. Throws ComposeStoreLockError if lost.
 */
export async function beginComposeStoreWriteBatch(): Promise<void> {
  if (activeGuard === null) {
    throw new ComposeStoreLockError("compose store lock is not held");
  }
  if ((await readNonce(activeGuard.path)) !== activeGuard.nonce) {
    throw new ComposeStoreLockError(
      "compose store lock lost — another process now holds the writer lock",
    );
  }
}

/** Orderly release for graceful shutdown and tests. */
export async function releaseComposeStoreLock(): Promise<void> {
  const release = activeRelease;
  if (!release) return;
  activeGuard = null;
  activeRelease = null;
  try {
    await release();
  } catch {
    // Best-effort release; losing the lock surfaces on the next acquire.
  }
}

export function composeStoreLockIsHeld(): boolean {
  return activeGuard !== null;
}

export function composeStoreLockString(): string {
  const guard = activeGuard;
  if (guard === null) return "(not held)";
  return `${guard.path} (pid ${guard.pid}, nonce ${guard.nonce.slice(0, 8)}…, startedAt ${guard.startedAt})`;
}

/** Test-only injection used to simulate lost/foreign lock states. */
export function _setComposeStoreLockForTests(overrides: {
  nonce?: string;
  path?: string;
  held?: boolean;
}): () => void {
  const previousGuard = activeGuard;
  const previousRelease = activeRelease;
  if (!overrides.held) activeGuard = null;
  else {
    activeGuard = {
      path: overrides.path ?? join(process.cwd(), DEFAULT_LOCK_FILE_NAME),
      nonce: overrides.nonce ?? "test-nonce-noncurrent-value-000000000",
      pid: process.pid,
      host: "test-host",
      startedAt: new Date().toISOString(),
    };
  }
  return () => {
    activeGuard = previousGuard;
    activeRelease = previousRelease;
  };
}
