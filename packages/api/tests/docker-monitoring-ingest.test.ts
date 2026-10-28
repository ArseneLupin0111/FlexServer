import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJsonDockerMonitoringRepository,
  type DockerMonitoringRepository,
} from "../src/persistence/repositories/docker-monitoring.repository.js";
import {
  DockerIngestConflict,
  type DockerIngestUnit,
} from "../src/docker/docker-monitoring.models.js";

const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
function unit(n: string, o: Partial<DockerIngestUnit> = {}): DockerIngestUnit {
  const receivedAt = t(Number(n) % 60);
  return {
    vpsId: "v",
    agentInstanceId: "i",
    snapshotId: `s${n}`,
    requestDigest: `d${n}`,
    requestDigestVersion: 1,
    receivedAt,
    sourceSequence: n,
    hostSample: {
      id: `h${n}`,
      vpsId: "v",
      agentInstanceId: o.agentInstanceId ?? "i",
      snapshotId: `s${n}`,
      collectedAt: receivedAt,
      receivedAt,
      effectiveAt: receivedAt,
      metrics: { cpu: 1 },
    },
    ...o,
  };
}
function event(id: string, seq: string, digest = id) {
  return {
    id,
    vpsId: "v",
    agentInstanceId: "i",
    action: "start" as const,
    eventOccurredAt: t(Number(seq)),
    receivedAt: t(Number(seq)),
    eventDigest: digest,
    contextVersion: 1 as const,
    sourceSequence: seq,
  };
}
function batch(n: string, o: Partial<DockerIngestUnit> = {}) {
  return unit(n, {
    batchId: `b${n}`,
    events: [event(`e${n}`, n)],
    eventProtocol: {
      fromWatermark: {
        vpsId: "v",
        agentInstanceId: "i",
        timeNano: String(Number(n) - 1),
        boundaryDigests: [],
        updatedAt: t(Number(n) - 1),
      },
      proposedWatermark: {
        vpsId: "v",
        agentInstanceId: "i",
        timeNano: n,
        boundaryDigests: [],
        updatedAt: t(Number(n)),
      },
      eventWindow: { from: String(Number(n) - 1), to: n },
    },
    ...o,
  });
}

describe("Docker JSON I3 ingest", () => {
  let dir: string;
  let repo: DockerMonitoringRepository;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dm-i3-"));
    repo = createJsonDockerMonitoringRepository(join(dir, "store.json"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns batchId and committedWatermark on replay_ignored for event batches", async () => {
    expect((await repo.ingestUnit(batch("5"))).ingestStatus).toBe("committed");
    const replay = await repo.ingestUnit(batch("3"));
    expect(replay.ingestStatus).toBe("replay_ignored");
    expect(replay.batchId).toBe("b3");
    expect(replay.committedWatermark?.timeNano).toBe("3");
  });

  it("persists authoritative latest overview fields and current container identity", async () => {
    const withOverview = unit("7", {
      available: false,
      errorCode: "socket_missing",
      engineVersion: "25.0.3",
      apiVersion: "1.44",
      containerSamples: [
        {
          id: "c7",
          vpsId: "v",
          agentInstanceId: "i",
          snapshotId: "s7",
          collectedAt: t(7),
          receivedAt: t(7),
          effectiveAt: t(7),
          containerKey: "ck_7",
          name: "/web",
          state: "running",
          image: "nginx:1.25",
          status: "Up 1 hour",
          metrics: {
            cpuPercent: 1,
            memoryUsageBytes: 2,
            networkRxBytes: 3,
            networkTxBytes: 4,
            blockReadBytes: 5,
            blockWriteBytes: 6,
            pids: 7,
          },
        },
      ],
    });
    expect((await repo.ingestUnit(withOverview)).ingestStatus).toBe("committed");
    expect(await repo.getAuthoritativeLatest("v")).toMatchObject({
      activeInstanceId: "i",
      snapshotId: "s7",
      sourceSequence: "7",
      available: false,
      errorCode: "socket_missing",
      engineVersion: "25.0.3",
      apiVersion: "1.44",
    });
    expect(await repo.getAuthoritativeLatest("missing-vps")).toBeUndefined();
    expect(await repo.listCurrentContainers("v")).toEqual([
      {
        agentInstanceId: "i",
        collectedAt: t(7),
        containerKey: "ck_7",
        name: "/web",
        state: "running",
        image: "nginx:1.25",
        status: "Up 1 hour",
        metrics: { cpuPercent: 1, memoryUsageBytes: 2, pids: 7 },
      },
    ]);
  });

  it("commits eventless units, exact replays, and rejects snapshot digest changes without mutation", async () => {
    const a = unit("1");
    expect((await repo.ingestUnit(a)).ingestStatus).toBe("committed");
    expect((await repo.ingestUnit(a)).ingestStatus).toBe("already_committed");
    const before = (await repo.listHostSamples({ vpsId: "v" })).data;
    await expect(
      repo.ingestUnit({ ...a, requestDigest: "changed" }),
    ).rejects.toMatchObject({ code: "snapshot_conflict" });
    expect((await repo.listHostSamples({ vpsId: "v" })).data).toEqual(before);
  });
  it("commits watermark batches, replays them, and applies CAS conflicts atomically", async () => {
    const a = batch("1");
    expect((await repo.ingestUnit(a)).committedWatermark?.timeNano).toBe("1");
    const replay = await repo.ingestUnit(a);
    expect(replay.ingestStatus).toBe("already_committed");
    const before = (await repo.listEvents({ vpsId: "v" })).data;
    await expect(
      repo.ingestUnit({
        ...batch("2"),
        requestDigest: "x",
        eventProtocol: {
          ...batch("2").eventProtocol!,
          fromWatermark: {
            vpsId: "v",
            agentInstanceId: "i",
            timeNano: "0",
            boundaryDigests: [],
            updatedAt: t(0),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "watermark_conflict" });
    expect((await repo.listEvents({ vpsId: "v" })).data).toEqual(before);
    await expect(
      repo.ingestUnit({ ...a, requestDigest: "other" }),
    ).rejects.toBeInstanceOf(DockerIngestConflict);
  });
  it("deduplicates events, preserves storage on omission, and orders latest by sequence", async () => {
    const storage = {
      vpsId: "v",
      agentInstanceId: "i",
      snapshotId: "st",
      collectedAt: t(1),
      receivedAt: t(1),
      formulaVersion: 1 as const,
      images: { supported: true, count: 1, totalBytes: 1 },
      containers: { supported: false, count: 0, totalBytes: 0 },
      localVolumes: { supported: false, count: 0, totalBytes: 0 },
      buildCache: { supported: false, count: 0, totalBytes: 0 },
    };
    await repo.ingestUnit(batch("3", { storageLatest: storage }));
    await repo.ingestUnit(batch("4", { events: [event("e3", "4")] }));
    expect((await repo.listEvents({ vpsId: "v" })).data).toHaveLength(2);
    expect((await repo.getStorageLatest("v"))?.snapshotId).toBe("st");
    await expect(repo.ingestUnit(unit("2"))).resolves.toMatchObject({
      ingestStatus: "replay_ignored",
    });
  });

  it("commits monitoring alert state with the same JSON ingest mutation", async () => {
    for (let n = 1; n <= 3; n++) {
      await repo.ingestUnit(
        unit(String(n), {
          monitoring: {
            availability: "unavailable",
            state: "enabled",
            effectiveCadenceSeconds: 60,
          },
        }),
      );
    }
    const alerts = (await repo.listAlerts({ vpsId: "v" })).data;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.state).toBe("open");
    expect(await repo.getWatermark("v", "i")).toBeUndefined();
  });
  it("handles instance transitions and old-instance retries", async () => {
    await repo.ingestUnit(unit("10"));
    await expect(
      repo.ingestUnit(unit("9", { agentInstanceId: "old" })),
    ).rejects.toMatchObject({ code: "active_instance_conflict" });
    await expect(
      repo.ingestUnit(unit("1", { agentInstanceId: "new" })),
    ).rejects.toMatchObject({ code: "active_instance_conflict" });
    await repo.ingestUnit(
      unit("1", {
        agentInstanceId: "new",
        auth: { isCurrentGeneration: true, credentialId: "cred-new" },
      }),
    );
    await expect(
      repo
        .ingestUnit(unit("10", { agentInstanceId: "i" }))
        .then((x) => x.ingestStatus),
    ).resolves.toBe("already_committed");
    await expect(
      repo.ingestUnit(
        unit("999", {
          agentInstanceId: "i",
          auth: { isCurrentGeneration: true },
        }),
      ),
    ).rejects.toMatchObject({ code: "active_instance_conflict" });
  });
  it("commits low sequence on authenticated instance reset, locks out retired instance, and resolves active alerts with identity_reset_orphaned while preserving history", async () => {
    // Three unavailable observations open the alert before the reset.
    for (const sequence of ["2147156", "2147157", "2147158"]) {
      await repo.ingestUnit(
        unit(sequence, {
          agentInstanceId: "ogwBx0Au",
          monitoring: {
            effectiveCadenceSeconds: 15,
            availability: "unavailable",
            state: "enabled",
          },
        }),
      );
    }
    let alerts = (await repo.listAlerts({ vpsId: "v" })).data;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.state).toBe("open");

    // Azure reinstall scenario: new instance starts with sequence 295
    const result = await repo.ingestUnit(
      unit("295", {
        agentInstanceId: "gyJ-AxZs",
        auth: {
          credentialId: "cred-azure-new",
          credentialCreatedAt: "2026-10-29T10:00:00Z",
          isCurrentGeneration: true,
        },
      }),
    );
    expect(result.ingestStatus).toBe("committed");

    // Authoritative latest is now the new instance with low sequence
    const latest = await repo.getAuthoritativeLatest("v");
    expect(latest).toMatchObject({
      activeInstanceId: "gyJ-AxZs",
      sourceSequence: "295",
      credentialId: "cred-azure-new",
    });

    // Prior open alerts resolved with identity_reset_orphaned
    alerts = (await repo.listAlerts({ vpsId: "v" })).data;
    expect(alerts[0]?.state).toBe("resolved");
    expect(alerts[0]?.resolutionReason).toBe("identity_reset_orphaned");

    // Historical samples from original instance are preserved
    const samples = (await repo.listHostSamples({ vpsId: "v" })).data;
    expect(samples.map((s) => s.agentInstanceId).sort()).toEqual([
      "gyJ-AxZs",
      "ogwBx0Au",
      "ogwBx0Au",
      "ogwBx0Au",
    ]);

    // Old instance can NEVER retake latest, even with sequence > 2147158
    await expect(
      repo.ingestUnit(
        unit("2147159", {
          agentInstanceId: "ogwBx0Au",
          auth: { isCurrentGeneration: true },
        }),
      ),
    ).rejects.toMatchObject({ code: "active_instance_conflict" });

  });
  it("rejects oversized first new-instance batch without mutating prior latest or retiring active instance", async () => {
    await repo.ingestUnit(unit("10", { agentInstanceId: "orig" }));
    const capped = createJsonDockerMonitoringRepository(join(dir, "store.json"), { maxBytes: 3000 });
    const oversizedBatch = unit("1", {
      agentInstanceId: "new-inst",
      auth: { isCurrentGeneration: true },
      events: [{ ...event("oversized", "1"), agentInstanceId: "new-inst", eventDigest: "x".repeat(4000) }],
    });
    const result = await capped.ingestUnit(oversizedBatch);
    expect(result.status).toBe("history_capacity_refused");
    const latest = await repo.getAuthoritativeLatest("v");
    expect(latest?.activeInstanceId).toBe("orig");
    await expect(repo.ingestUnit(unit("11", { agentInstanceId: "orig" }))).resolves.toMatchObject({
      ingestStatus: "committed",
    });
  });
  it("serializes concurrent commits and supports restart replay and cleanup", async () => {
    const a = unit("20");
    const results = await Promise.all([repo.ingestUnit(a), repo.ingestUnit(a)]);
    expect(results.map((x) => x.ingestStatus).sort()).toEqual([
      "already_committed",
      "committed",
    ]);
    const restarted = createJsonDockerMonitoringRepository(
      join(dir, "store.json"),
    );
    expect((await restarted.ingestUnit(a)).ingestStatus).toBe(
      "already_committed",
    );
    await restarted.cleanupForVps({ vpsId: "v", reason: "vps_deleted" });
    expect((await restarted.listHostSamples({ vpsId: "v" })).data).toEqual([]);
    expect(await restarted.getIngestBatch("v", "i", "b20")).toBeUndefined();
  });

  it("advances watermarks for empty event windows and preserves them on replay", async () => {
    const empty = batch("5", { events: [] });
    const committed = await repo.ingestUnit(empty);
    expect(committed.ingestStatus).toBe("committed");
    expect(committed.committedWatermark?.timeNano).toBe("5");
    expect((await repo.getWatermark("v", "i"))?.timeNano).toBe("5");
    const replay = await repo.ingestUnit(empty);
    expect(replay.ingestStatus).toBe("already_committed");
    expect(replay.committedWatermark?.timeNano).toBe("5");
    await expect(
      repo.ingestUnit({
        ...batch("6", { events: [] }),
        eventProtocol: {
          ...batch("6").eventProtocol!,
          fromWatermark: {
            vpsId: "v",
            agentInstanceId: "i",
            timeNano: "0",
            boundaryDigests: [],
            updatedAt: t(0),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "watermark_conflict" });
    expect((await repo.getWatermark("v", "i"))?.timeNano).toBe("5");
  });

  it("persists history below the JSON cap and returns the typed success status", async () => {
    // Objective: a payload below the cap must persist samples/events and advance its watermark.
    const a = batch("1");
    const result = await repo.ingestUnit(a);

    // Arrange / Act / Assert
    expect(result).toMatchObject({
      ingestStatus: "committed",
      status: "committed",
    });
    expect((await repo.listHostSamples({ vpsId: "v" })).data).toHaveLength(1);
    expect(
      (await repo.listEvents({ vpsId: "v" })).data.map((x) => x.id),
    ).toEqual(["e1"]);
    expect((await repo.getWatermark("v", "i"))?.timeNano).toBe("1");
  });

  it("refuses over-cap history atomically and retries after maintenance", async () => {
    const capped = createJsonDockerMonitoringRepository(
      join(dir, "capped.json"),
      { maxBytes: 3000 },
    );
    await capped.ingestUnit(batch("1"));
    const oversized = batch("2", {
      events: [event("e2", "2", "x".repeat(5000))],
    });
    const result = await capped.ingestUnit(oversized);

    expect(result).toMatchObject({
      ingestStatus: "rejected",
      status: "history_capacity_refused",
    });
    expect(
      (await capped.listHostSamples({ vpsId: "v" })).data.map((x) => x.id),
    ).toEqual(["h1"]);
    expect(
      (await capped.listEvents({ vpsId: "v" })).data.map((x) => x.id),
    ).toEqual(["e1"]);
    expect((await capped.getWatermark("v", "i"))?.timeNano).toBe("1");
    expect(await capped.getStorageLatest("v")).toBeUndefined();
  });
});
