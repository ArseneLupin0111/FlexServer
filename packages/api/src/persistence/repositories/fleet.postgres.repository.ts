import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  FleetNotification,
  FleetPolicy,
  FleetRelease,
  FleetRollout,
} from "../../agent-updates/fleet.models.js";
import type { FleetRepository } from "./fleet.repository.js";
import {
  requiredIsoString,
  toDateOrNull,
  toJsonOrNull,
} from "./postgres-mappers.js";

interface FleetPolicyRow {
  vps_id: string;
  mode: "auto" | "manual" | "pinned";
  policy_group: string;
  pinned_release_id: string | null;
  canary: boolean;
  maintenance_window: FleetPolicy["maintenanceWindow"] | null;
}

interface FleetReleaseRow {
  release_id: string;
  version: string;
  build_id: string;
  published_at: Date | string;
  rollback_safe: boolean;
  payload: string;
  signature: string;
  key_id: string;
  created_at?: Date | string;
}

interface FleetRolloutRow {
  id: string;
  release_id: string;
  state: "pending" | "running" | "paused" | "completed" | "failed";
  policy_group: string;
  hosts: FleetRollout["hosts"];
  reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FleetNotificationRow {
  id: string;
  message: string;
  kind: "info" | "warning" | "error" | "success";
  created_at: Date | string;
}

const DEFAULT_POLICY: FleetPolicy = {
  mode: "auto",
  group: "Default",
};

export function createPostgresFleetRepository(pool: Pool): FleetRepository {
  return {
    async getPolicy(vpsId: string): Promise<FleetPolicy | undefined> {
      const res = await pool.query<FleetPolicyRow>(
        `SELECT vps_id, mode, policy_group, pinned_release_id, canary, maintenance_window
         FROM fleet_policies WHERE vps_id = $1`,
        [vpsId],
      );
      if (res.rows.length === 0) return undefined;
      const row = res.rows[0];
      return {
        mode: row.mode,
        group: row.policy_group,
        pinnedReleaseId: row.pinned_release_id ?? undefined,
        canary: row.canary,
        maintenanceWindow: row.maintenance_window ?? undefined,
      };
    },

    async listPolicies(): Promise<Map<string, FleetPolicy>> {
      const res = await pool.query<FleetPolicyRow>(
        `SELECT vps_id, mode, policy_group, pinned_release_id, canary, maintenance_window
         FROM fleet_policies`,
      );
      const map = new Map<string, FleetPolicy>();
      for (const row of res.rows) {
        map.set(row.vps_id, {
          mode: row.mode,
          group: row.policy_group,
          pinnedReleaseId: row.pinned_release_id ?? undefined,
          canary: row.canary,
          maintenanceWindow: row.maintenance_window ?? undefined,
        });
      }
      return map;
    },

    async upsertPolicy(
      vpsId: string,
      patch: Partial<FleetPolicy>,
    ): Promise<FleetPolicy> {
      const existing = (await this.getPolicy(vpsId)) ?? { ...DEFAULT_POLICY };
      const updated: FleetPolicy = {
        mode: patch.mode ?? existing.mode,
        group: patch.group ?? existing.group,
        pinnedReleaseId:
          patch.pinnedReleaseId !== undefined
            ? patch.pinnedReleaseId
            : existing.pinnedReleaseId,
        canary: patch.canary !== undefined ? patch.canary : existing.canary,
        maintenanceWindow:
          patch.maintenanceWindow !== undefined
            ? patch.maintenanceWindow
            : existing.maintenanceWindow,
      };

      await pool.query(
        `INSERT INTO fleet_policies (vps_id, mode, policy_group, pinned_release_id, canary, maintenance_window, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (vps_id) DO UPDATE SET
           mode = EXCLUDED.mode,
           policy_group = EXCLUDED.policy_group,
           pinned_release_id = EXCLUDED.pinned_release_id,
           canary = EXCLUDED.canary,
           maintenance_window = EXCLUDED.maintenance_window,
           updated_at = now()`,
        [
          vpsId,
          updated.mode,
          updated.group,
          updated.pinnedReleaseId ?? null,
          updated.canary ?? false,
          toJsonOrNull(updated.maintenanceWindow),
        ],
      );
      return updated;
    },

    async isEnrolled(vpsId: string): Promise<boolean> {
      const res = await pool.query<{ enrolled: boolean }>(
        `SELECT enrolled FROM fleet_enrollments WHERE vps_id = $1`,
        [vpsId],
      );
      return res.rows.length > 0 && Boolean(res.rows[0].enrolled);
    },

    async listEnrolledVpsIds(): Promise<string[]> {
      const res = await pool.query<{ vps_id: string }>(
        `SELECT vps_id FROM fleet_enrollments WHERE enrolled = true`,
      );
      return res.rows.map((r) => r.vps_id);
    },

    async setEnrolled(vpsId: string, enrolled: boolean): Promise<void> {
      if (enrolled) {
        await pool.query(
          `INSERT INTO fleet_enrollments (vps_id, enrolled, enrolled_at)
           VALUES ($1, true, now())
           ON CONFLICT (vps_id) DO UPDATE SET enrolled = true, enrolled_at = now()`,
          [vpsId],
        );
      } else {
        await pool.query(
          `DELETE FROM fleet_enrollments WHERE vps_id = $1`,
          [vpsId],
        );
      }
    },

    async listRollouts(): Promise<FleetRollout[]> {
      const res = await pool.query<FleetRolloutRow>(
        `SELECT id, release_id, state, policy_group, hosts, reason, created_at, updated_at
         FROM fleet_rollouts ORDER BY created_at DESC`,
      );
      return res.rows.map((row) => ({
        id: row.id,
        releaseId: row.release_id,
        state: row.state,
        group: row.policy_group,
        hosts: row.hosts ?? [],
        reason: row.reason ?? undefined,
        createdAt: requiredIsoString(row.created_at),
        updatedAt: requiredIsoString(row.updated_at),
      }));
    },

    async getRollout(id: string): Promise<FleetRollout | undefined> {
      const res = await pool.query<FleetRolloutRow>(
        `SELECT id, release_id, state, policy_group, hosts, reason, created_at, updated_at
         FROM fleet_rollouts WHERE id = $1`,
        [id],
      );
      if (res.rows.length === 0) return undefined;
      const row = res.rows[0];
      return {
        id: row.id,
        releaseId: row.release_id,
        state: row.state,
        group: row.policy_group,
        hosts: row.hosts ?? [],
        reason: row.reason ?? undefined,
        createdAt: requiredIsoString(row.created_at),
        updatedAt: requiredIsoString(row.updated_at),
      };
    },

    async getActiveRollout(): Promise<FleetRollout | undefined> {
      const res = await pool.query<FleetRolloutRow>(
        `SELECT id, release_id, state, policy_group, hosts, reason, created_at, updated_at
         FROM fleet_rollouts WHERE state IN ('running', 'pending')
         ORDER BY created_at DESC LIMIT 1`,
      );
      if (res.rows.length === 0) return undefined;
      const row = res.rows[0];
      return {
        id: row.id,
        releaseId: row.release_id,
        state: row.state,
        group: row.policy_group,
        hosts: row.hosts ?? [],
        reason: row.reason ?? undefined,
        createdAt: requiredIsoString(row.created_at),
        updatedAt: requiredIsoString(row.updated_at),
      };
    },

    async createRollout(rollout: FleetRollout): Promise<FleetRollout> {
      await pool.query(
        `INSERT INTO fleet_rollouts (id, release_id, state, policy_group, hosts, reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          rollout.id,
          rollout.releaseId,
          rollout.state,
          rollout.group,
          JSON.stringify(rollout.hosts),
          rollout.reason ?? null,
          toDateOrNull(rollout.createdAt) ?? new Date(),
          toDateOrNull(rollout.updatedAt) ?? new Date(),
        ],
      );
      return rollout;
    },

    async updateRollout(rollout: FleetRollout): Promise<FleetRollout> {
      await pool.query(
        `UPDATE fleet_rollouts
         SET state = $2, policy_group = $3, hosts = $4, reason = $5, updated_at = now()
         WHERE id = $1`,
        [
          rollout.id,
          rollout.state,
          rollout.group,
          JSON.stringify(rollout.hosts),
          rollout.reason ?? null,
        ],
      );
      return rollout;
    },

    async listReleases(): Promise<FleetRelease[]> {
      const res = await pool.query<FleetReleaseRow>(
        `SELECT release_id, version, build_id, published_at, rollback_safe, payload, signature, key_id, created_at
         FROM fleet_releases ORDER BY published_at DESC`,
      );
      return res.rows.map((row) => {
        let components: string[] = [];
        let artifacts: any[] | undefined;
        let upgradeFrom: string[] | undefined;
        let minUpdaterVersion: string | undefined;
        let ai: { version: string; components: string[] } | undefined;
        try {
          const parsed = JSON.parse(row.payload);
          if (Array.isArray(parsed.artifacts)) {
            artifacts = parsed.artifacts;
            components = Array.from(
              new Set(parsed.artifacts.map((a: { component: string }) => a.component)),
            );
          }
          if (Array.isArray(parsed.upgradeFrom)) {
            upgradeFrom = parsed.upgradeFrom;
          }
          if (typeof parsed.minUpdaterVersion === "string") {
            minUpdaterVersion = parsed.minUpdaterVersion;
          }
          if (parsed.ai && typeof parsed.ai === "object") {
            ai = parsed.ai;
          }
        } catch {
          // ignore parsing error
        }
        return {
          id: row.release_id,
          version: row.version,
          buildId: row.build_id,
          publishedAt: requiredIsoString(row.published_at),
          channel: "stable" as const,
          rollbackSafe: row.rollback_safe,
          components,
          rawPayload: row.payload,
          signature: row.signature,
          keyId: row.key_id,
          createdAt: requiredIsoString(row.created_at ?? row.published_at),
          ...(artifacts ? { artifacts } : {}),
          ...(upgradeFrom ? { upgradeFrom } : {}),
          ...(minUpdaterVersion ? { minUpdaterVersion } : {}),
          ...(ai ? { ai } : {}),
        };
      });
    },

    async getRelease(id: string): Promise<FleetRelease | undefined> {
      const res = await pool.query<FleetReleaseRow>(
        `SELECT release_id, version, build_id, published_at, rollback_safe, payload, signature, key_id, created_at
         FROM fleet_releases WHERE release_id = $1`,
        [id],
      );
      if (res.rows.length === 0) return undefined;
      const row = res.rows[0];
      let components: string[] = [];
      let artifacts: any[] | undefined;
      let upgradeFrom: string[] | undefined;
      let minUpdaterVersion: string | undefined;
      let ai: { version: string; components: string[] } | undefined;
      try {
        const parsed = JSON.parse(row.payload);
        if (Array.isArray(parsed.artifacts)) {
          artifacts = parsed.artifacts;
          components = Array.from(
            new Set(parsed.artifacts.map((a: { component: string }) => a.component)),
          );
        }
        if (Array.isArray(parsed.upgradeFrom)) {
          upgradeFrom = parsed.upgradeFrom;
        }
        if (typeof parsed.minUpdaterVersion === "string") {
          minUpdaterVersion = parsed.minUpdaterVersion;
        }
        if (parsed.ai && typeof parsed.ai === "object") {
          ai = parsed.ai;
        }
      } catch {
        // ignore
      }
      return {
        id: row.release_id,
        version: row.version,
        buildId: row.build_id,
        publishedAt: requiredIsoString(row.published_at),
        channel: "stable" as const,
        rollbackSafe: row.rollback_safe,
        components,
        rawPayload: row.payload,
        signature: row.signature,
        keyId: row.key_id,
        createdAt: requiredIsoString(row.created_at ?? row.published_at),
        ...(artifacts ? { artifacts } : {}),
        ...(upgradeFrom ? { upgradeFrom } : {}),
        ...(minUpdaterVersion ? { minUpdaterVersion } : {}),
        ...(ai ? { ai } : {}),
      };
    },
    async upsertRelease(release: FleetRelease): Promise<FleetRelease> {
      const payloadToStore =
        release.rawPayload ??
        JSON.stringify({
          schemaVersion: 1,
          releaseId: release.id,
          version: release.version,
          buildId: release.buildId,
          publishedAt: release.publishedAt,
          channel: "stable",
          rollbackSafe: release.rollbackSafe,
          minUpdaterVersion: release.minUpdaterVersion ?? "0.1.0",
          upgradeFrom: release.upgradeFrom,
          artifacts: release.artifacts ?? release.components.map((c) => ({
            component: c,
            os: "linux",
            arch: "amd64",
            url: `https://release.example.com/${release.version}/${c}`,
            sha256: "0".repeat(64),
            size: 1024,
            version: release.version,
          })),
        });

      await pool.query(
        `INSERT INTO fleet_releases (release_id, version, build_id, published_at, rollback_safe, payload, signature, key_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (release_id) DO UPDATE SET
           version = EXCLUDED.version,
           build_id = EXCLUDED.build_id,
           published_at = EXCLUDED.published_at,
           rollback_safe = EXCLUDED.rollback_safe,
           payload = EXCLUDED.payload,
           signature = EXCLUDED.signature,
           key_id = EXCLUDED.key_id`,
        [
          release.id,
          release.version,
          release.buildId,
          toDateOrNull(release.publishedAt) ?? new Date(),
          release.rollbackSafe,
          payloadToStore,
          release.signature ?? "",
          release.keyId ?? "fleet-key",
        ],
      );
      return release;
    },

    async listNotifications(limit = 100): Promise<FleetNotification[]> {
      const res = await pool.query<FleetNotificationRow>(
        `SELECT id, message, kind, created_at
         FROM fleet_notifications ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return res.rows.map((row) => ({
        id: row.id,
        message: row.message,
        kind: row.kind,
        createdAt: requiredIsoString(row.created_at),
      }));
    },

    async addNotification(
      notification: Omit<FleetNotification, "id" | "createdAt">,
    ): Promise<FleetNotification> {
      const id = randomUUID();
      const res = await pool.query<FleetNotificationRow>(
        `INSERT INTO fleet_notifications (id, message, kind, created_at)
         VALUES ($1, $2, $3, now())
         RETURNING id, message, kind, created_at`,
        [id, notification.message, notification.kind],
      );
      const row = res.rows[0];
      return {
        id: row.id,
        message: row.message,
        kind: row.kind,
        createdAt: requiredIsoString(row.created_at),
      };
    },

    async pruneNotifications(olderThanMs: number): Promise<void> {
      const cutoff = new Date(Date.now() - olderThanMs);
      await pool.query(
        `DELETE FROM fleet_notifications WHERE created_at < $1`,
        [cutoff],
      );
    },

    async deleteByVps(vpsId: string): Promise<void> {
      await pool.query(`DELETE FROM fleet_policies WHERE vps_id = $1`, [vpsId]);
      await pool.query(`DELETE FROM fleet_enrollments WHERE vps_id = $1`, [vpsId]);
    },
  };
}
