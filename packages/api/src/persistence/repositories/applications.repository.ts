import { ServiceUnavailableException } from "@nestjs/common";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { mkdir } from "node:fs/promises";
import type { Pool } from "pg";
import { readJsonFile, writeJsonFile, withFileLock } from "./json-file.js";
import type { ComposeEnvelopeData } from "../../crypto/secret-envelope.js";

export type AppRow = {
  id: string;
  vpsId: string;
  displayName: string;
  projectName: string;
  daemonEpoch: string;
  agentInstanceId: string;
  mode: "detected_readonly" | "external_control" | "managed" | "unmanaged";
  generation: number;
  readinessSeconds?: number;
  source?: Record<string, unknown>;
  /** Durable ownership binding: exact project identity on the daemon. */
  ownerManifest?: {
    agentInstanceId: string;
    daemonEpoch: string;
    projectName: string;
    adoptedFromSourcePath?: string;
    adoptedFromSourceDigest?: string;
    containers?: { containerKey: string; service: string }[];
  };
  createdAt: string;
  updatedAt: string;
};
export type ProtectedRow = {
  id: string;
  vpsId: string;
  appId: string;
  name: string;
  version: number;
  envelope: ComposeEnvelopeData;
  updatedAt: string;
};
export type RevisionRow = {
  id: string;
  appId: string;
  vpsId: string;
  seq: number;
  envelope: ComposeEnvelopeData;
  profiles: string[];
  oneShotServices: string[];
  variables: Record<string, string>;
  createdAt: string;
};
/** Durable authorization granted to one claimed operation. */
export type OperationAuthorization = {
  id: string;
  revisionAuthorizationId: string;
  nonce: string;
  payloadDigest: string;
  grantedAt: string;
};
export type WorkRow = {
  id: string;
  vpsId: string;
  appId: string;
  kind: string;
  status: string;
  request: Record<string, unknown>;
  generation: number;
  idempotencyKey: string;
  requestDigest: string;
  actor?: { kind: string; id?: string };
  createdAt: string;
  updatedAt: string;
  claimToken?: string;
  claimedBy?: string;
  claimedAt?: string;
  claimLeaseExpiresAt?: string;
  invocationToken?: string;
  authorization?: OperationAuthorization;
  progress?: { seq: number; items: unknown[] };
  result?: Record<string, unknown>;
  lifecyclePlan?: {
    action: "start" | "stop" | "restart";
    sourcePath: string;
    sourceDigest: string;
    services: {
      name: string;
      kind: "longlived" | "oneshot";
      dependsOn: string[];
      condition: "started" | "healthy" | "completed";
      dependencyConditions?: Record<string, "started" | "healthy" | "completed">;
      selected: boolean;
      desiredCount: number | null;
      replicas: {
        containerKey: string;
        state: string;
        health?: string;
        oneShotStatus: "never_started" | "running" | "succeeded" | "failed";
      }[];
    }[];
    order: string[];
    observedFingerprint: string;
  };
};
/** Compose preview: resolved model lives encrypted in resolvedModelEnvelope; never stored plaintext. */
export type PreviewRow = {
  id: string;
  appId: string;
  vpsId: string;
  revisionSeq: number;
  status: "pending" | "claimed" | "failed" | "ready" | "confirmed" | "stale";
  generation: number;
  request: { registryCredentialIds: string[] };
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  claim?: { claimToken: string; claimedBy: string; claimedAt: string; traveledAt?: string };
  digest?: string;
  removedServices?: string[];
  resolvedModelEnvelope?: ComposeEnvelopeData;
  observedSecretVersions?: Record<string, number>;
  observedCredentialVersions?: Record<string, number>;
  error?: { message: string } | undefined;
  /** Redacted public receipt projection (never carries an observed secret model). */
  result?: Record<string, unknown>;
};
export type ContainerContention = {
  vpsId: string;
  agentInstanceId: string;
  containerKey: string;
  operationId: string;
  createdAt: string;
};
export type ApplicationsState = {
  applications: AppRow[];
  secrets: ProtectedRow[];
  credentials: ProtectedRow[];
  revisions: RevisionRow[];
  previews: PreviewRow[];
  operations: WorkRow[];
  containerContentions: ContainerContention[];
};
const empty = (): ApplicationsState => ({
  applications: [],
  secrets: [],
  credentials: [],
  revisions: [],
  previews: [],
  operations: [],
  containerContentions: [],
});
export const normalizeApplicationsState = (raw: ApplicationsState): ApplicationsState => ({
  ...empty(),
  ...raw,
  containerContentions: Array.isArray(raw?.containerContentions) ? raw.containerContentions : [],
});
export interface ApplicationsRepository {
  transaction<T>(action: (state: ApplicationsState) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
/** Whole-state transaction: no split-file commits. JSON supports one API writer. */
export function createJsonApplicationsRepository(dataDir: string): ApplicationsRepository {
  const file = join(dataDir, "docker-applications.json");
  let release: (() => Promise<void>) | undefined;
  let acquiring: Promise<void> | undefined;
  const acquire = () =>
    (acquiring ??= (async () => {
      await mkdir(dataDir, { recursive: true });
      release = await lockfile.lock(dataDir, {
        lockfilePath: join(dataDir, ".docker-compose-writer.lock"),
        realpath: false,
        retries: 0,
        stale: 120000,
        update: 10000,
      });
    })().catch((error: unknown) => {
      acquiring = undefined;
      if (error && typeof error === "object" && "code" in error && error.code === "ELOCKED") {
        throw new ServiceUnavailableException("compose_store_locked");
      }
      throw error;
    }));
  return {
    async transaction(action) {
      await acquire();
      return withFileLock(file, async () => {
        const state = normalizeApplicationsState(await readJsonFile<ApplicationsState>(file, empty()));
        const result = await action(state);
        await writeJsonFile(file, state);
        return result;
      });
    },
    async close() {
      await release?.();
    },
  };
}
/** PostgreSQL serializes admissions across API instances with a row lock. */
export function createPostgresApplicationsRepository(pool: Pool): ApplicationsRepository {
  return {
    async transaction(action) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(684372911)");
        const rows = await client.query<{ payload: ApplicationsState }>(
          "SELECT payload FROM docker_application_state WHERE id = 1 FOR UPDATE",
        );
        const state = normalizeApplicationsState(rows.rows[0]?.payload ?? empty());
        const result = await action(state);
        await client.query(
          "INSERT INTO docker_application_state(id,payload) VALUES(1,$1::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload",
          [JSON.stringify(state)],
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {},
  };
}
