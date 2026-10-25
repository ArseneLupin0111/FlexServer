import { randomUUID } from "node:crypto";
import { readJsonFile, withFileLock, writeJsonFile } from "./json-file.js";
import type {
  FleetNotification,
  FleetPolicy,
  FleetRelease,
  FleetRollout,
} from "../../agent-updates/fleet.models.js";

export interface FleetRepository {
  getPolicy(vpsId: string): Promise<FleetPolicy | undefined>;
  listPolicies(): Promise<Map<string, FleetPolicy>>;
  upsertPolicy(vpsId: string, patch: Partial<FleetPolicy>): Promise<FleetPolicy>;
  isEnrolled(vpsId: string): Promise<boolean>;
  listEnrolledVpsIds(): Promise<string[]>;
  setEnrolled(vpsId: string, enrolled: boolean): Promise<void>;
  listRollouts(): Promise<FleetRollout[]>;
  getRollout(id: string): Promise<FleetRollout | undefined>;
  getActiveRollout(): Promise<FleetRollout | undefined>;
  createRollout(rollout: FleetRollout): Promise<FleetRollout>;
  updateRollout(rollout: FleetRollout): Promise<FleetRollout>;
  listReleases(): Promise<FleetRelease[]>;
  getRelease(id: string): Promise<FleetRelease | undefined>;
  upsertRelease(release: FleetRelease): Promise<FleetRelease>;
  listNotifications(limit?: number): Promise<FleetNotification[]>;
  addNotification(
    notification: Omit<FleetNotification, "id" | "createdAt">,
  ): Promise<FleetNotification>;
  pruneNotifications(olderThanMs: number): Promise<void>;
  deleteByVps(vpsId: string): Promise<void>;
}

interface FleetJsonData {
  policies: Record<string, FleetPolicy>;
  enrollments: Record<string, boolean>;
  releases: Record<string, FleetRelease>;
  rollouts: Record<string, FleetRollout>;
  notifications: FleetNotification[];
}

// A FRESH object per read, never a shared module-level constant: readJsonFile
// returns the fallback object itself when the file is missing, and callers
// mutate the result before writing (upsertRelease, createRollout, …). A
// shared fallback would leak one repo file's records into every other fleet
// repository whose file does not exist yet.
const emptyFleetData = (): FleetJsonData => ({
  policies: {},
  enrollments: {},
  releases: {},
  rollouts: {},
  notifications: [],
});

const DEFAULT_POLICY: FleetPolicy = {
  mode: "auto",
  group: "Default",
};

export function createJsonFleetRepository(
  filePath: string,
): FleetRepository {
  return {
    async getPolicy(vpsId: string): Promise<FleetPolicy | undefined> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return data.policies[vpsId];
    },

    async listPolicies(): Promise<Map<string, FleetPolicy>> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return new Map(Object.entries(data.policies));
    },

    async upsertPolicy(
      vpsId: string,
      patch: Partial<FleetPolicy>,
    ): Promise<FleetPolicy> {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
        const existing = data.policies[vpsId] ?? { ...DEFAULT_POLICY };
        const updated: FleetPolicy = {
          mode: patch.mode ?? existing.mode,
          group: patch.group ?? existing.group,
          pinnedReleaseId:
            patch.pinnedReleaseId !== undefined
              ? patch.pinnedReleaseId
              : existing.pinnedReleaseId,
          canary:
            patch.canary !== undefined ? patch.canary : existing.canary,
          maintenanceWindow:
            patch.maintenanceWindow !== undefined
              ? patch.maintenanceWindow
              : existing.maintenanceWindow,
        };
        data.policies[vpsId] = updated;
        await writeJsonFile(filePath, data);
        return updated;
      });
    },

    async isEnrolled(vpsId: string): Promise<boolean> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return Boolean(data.enrollments[vpsId]);
    },

    async listEnrolledVpsIds(): Promise<string[]> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return Object.entries(data.enrollments)
        .filter(([, enrolled]) => Boolean(enrolled))
        .map(([id]) => id);
    },

    async setEnrolled(vpsId: string, enrolled: boolean): Promise<void> {
      await withFileLock(filePath, async () => {
        const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
        if (enrolled) {
          data.enrollments[vpsId] = true;
        } else {
          delete data.enrollments[vpsId];
        }
        await writeJsonFile(filePath, data);
      });
    },

    async listRollouts(): Promise<FleetRollout[]> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return Object.values(data.rollouts).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    },

    async getRollout(id: string): Promise<FleetRollout | undefined> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return data.rollouts[id];
    },

    async getActiveRollout(): Promise<FleetRollout | undefined> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return Object.values(data.rollouts).find(
        (r) => r.state === "running" || r.state === "pending",
      );
    },

    async createRollout(rollout: FleetRollout): Promise<FleetRollout> {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
        data.rollouts[rollout.id] = rollout;
        await writeJsonFile(filePath, data);
        return rollout;
      });
    },

    async updateRollout(rollout: FleetRollout): Promise<FleetRollout> {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
        data.rollouts[rollout.id] = rollout;
        await writeJsonFile(filePath, data);
        return rollout;
      });
    },

    async listReleases(): Promise<FleetRelease[]> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return Object.values(data.releases).sort((a, b) =>
        b.publishedAt.localeCompare(a.publishedAt),
      );
    },

    async getRelease(id: string): Promise<FleetRelease | undefined> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return data.releases[id];
    },

    async upsertRelease(release: FleetRelease): Promise<FleetRelease> {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
        data.releases[release.id] = release;
        await writeJsonFile(filePath, data);
        return release;
      });
    },

    async listNotifications(limit = 100): Promise<FleetNotification[]> {
      const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
      return data.notifications
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },

    async addNotification(
      notification: Omit<FleetNotification, "id" | "createdAt">,
    ): Promise<FleetNotification> {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
        const item: FleetNotification = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          ...notification,
        };
        data.notifications.unshift(item);
        if (data.notifications.length > 500) {
          data.notifications = data.notifications.slice(0, 500);
        }
        await writeJsonFile(filePath, data);
        return item;
      });
    },

    async pruneNotifications(olderThanMs: number): Promise<void> {
      await withFileLock(filePath, async () => {
        const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
        const cutoff = new Date(Date.now() - olderThanMs).toISOString();
        data.notifications = data.notifications.filter(
          (n) => n.createdAt >= cutoff,
        );
        await writeJsonFile(filePath, data);
      });
    },

    async deleteByVps(vpsId: string): Promise<void> {
      await withFileLock(filePath, async () => {
        const data = await readJsonFile<FleetJsonData>(filePath, emptyFleetData());
        delete data.policies[vpsId];
        delete data.enrollments[vpsId];
        for (const rollout of Object.values(data.rollouts)) {
          rollout.hosts = rollout.hosts.filter((h) => h.vpsId !== vpsId);
        }
        await writeJsonFile(filePath, data);
      });
    },
  };
}
