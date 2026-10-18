import { describe, expect, it, vi } from "vitest";
import { createPostgresDockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.postgres.repository.js";

describe("docker monitoring postgres alert resolution (static fake pool)", () => {
  it("updates active alerts with VPS/state predicates and timestamp/reason parameters", async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rowCount: 2, rows: [] }));
    const repo = createPostgresDockerMonitoringRepository({ query } as never);
    const resolvedAt = "2026-09-20T12:34:56.000Z";

    // Objective: the PostgreSQL implementation must issue the constrained, metadata-preserving update.
    expect(await repo.resolveActiveAlertsForVps("vps-a", "monitoring_disabled", resolvedAt)).toBe(2);
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("WHERE vps_id = $1 AND state IN ('open', 'acknowledged')");
    expect(sql).toContain("resolved_at = $2");
    expect(sql).toContain("resolution_reason = $3");
    expect(values).toEqual(["vps-a", new Date(resolvedAt), "monitoring_disabled"]);
  });

  it("returns zero for an idempotent second update", async () => {
    const query = vi.fn<(sql: string, values: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>>()
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const repo = createPostgresDockerMonitoringRepository({ query } as never);

    // Objective: once no open/acknowledged rows remain, a repeated call is a no-op.
    expect(await repo.resolveActiveAlertsForVps("vps-a", "monitoring_disabled", "2026-09-20T00:00:00.000Z")).toBe(2);
    expect(await repo.resolveActiveAlertsForVps("vps-a", "monitoring_disabled", "2026-09-20T00:00:00.000Z")).toBe(0);
  });

  it("persists acknowledgement metadata only for an open, VPS-scoped alert", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: "a1", vps_id: "vps-a", agent_instance_id: null, rule_kind: "docker_unavailable",
        container_key: null, state: "acknowledged", fingerprint: "fp", opened_at: new Date("2026-09-20T00:00:00Z"),
        last_observed_at: null, resolved_at: null, acknowledged_at: new Date("2026-09-20T01:00:00Z"),
        acknowledged_by: "session-1", occurrences: 1, summary: "unavailable", context_version: 1,
      }] });
    const repo = createPostgresDockerMonitoringRepository({ query } as never);
    const result = await repo.acknowledgeAlert("vps-a", "a1", "session-1", "2026-09-20T01:00:00.000Z");
    const [sql, values] = query.mock.calls[0]!;

    expect(result).toMatchObject({ changed: true, alert: { state: "acknowledged", acknowledgedBy: "session-1" } });
    expect(sql).toContain("SET state = 'acknowledged'");
    expect(sql).toContain("acknowledged_at = $3");
    expect(sql).toContain("acknowledged_by = $4");
    expect(sql).toContain("WHERE vps_id = $1 AND id = $2 AND state = 'open'");
    expect(values).toEqual(["vps-a", "a1", new Date("2026-09-20T01:00:00.000Z"), "session-1"]);
  });

  it("keeps typed lifecycle predicates and metadata in unavailable observation SQL", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: "a1", vps_id: "vps-a", agent_instance_id: "inst-1", rule_kind: "docker_unavailable",
      container_key: null, state: "acknowledged", fingerprint: "docker_unavailable:v1:vps-a",
      opened_at: new Date("2026-09-20T00:00:00Z"), last_observed_at: new Date("2026-09-20T01:00:00Z"),
      resolved_at: null, acknowledged_at: new Date("2026-09-20T00:30:00Z"), acknowledged_by: "session-1",
      occurrences: 2, summary: "unavailable", context_version: 1,
    }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: "a1", vps_id: "vps-a", agent_instance_id: "inst-1", rule_kind: "docker_unavailable",
        container_key: null, state: "acknowledged", fingerprint: "docker_unavailable:v1:vps-a",
        opened_at: new Date("2026-09-20T00:00:00Z"), last_observed_at: new Date("2026-09-20T01:00:00Z"),
        resolved_at: null, acknowledged_at: new Date("2026-09-20T00:30:00Z"), acknowledged_by: "session-1",
        occurrences: 3, summary: "unavailable", context_version: 1,
      }] });
    const repo = createPostgresDockerMonitoringRepository({ query } as never);
    const result = await repo.applyUnavailableObservation("vps-a", "inst-1", {
      availability: "unavailable", observedAt: "2026-09-20T01:00:00.000Z",
    });
    const [lookupSql] = query.mock.calls[0]!;
    const [sql, values] = query.mock.calls[1]!;

    expect(result.transition).toBe("persisted");
    expect(lookupSql).toContain("state IN ('open','acknowledged')");
    expect(sql).toContain("occurrences=occurrences+1");
    expect(sql).toContain("RETURNING *");
    expect(values).toEqual(["vps-a", "docker_unavailable:v1:vps-a", new Date("2026-09-20T01:00:00.000Z")]);
  });
});

describe("docker monitoring postgres listCurrentContainers (static fake pool)", () => {
  it("resolves the newest snapshot identity first, then its container rows in containerKey order", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ agent_instance_id: "inst1", snapshot_id: "snap_new" }] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [
        { agent_instance_id: "inst1", container_key: "ck_a", name: "alpha", state: "running", image: "nginx:1.25", status: "Up 1 hour", collected_at: "2026-09-20T00:00:00.000Z", details: null, metrics: { cpuPercent: 1.5, memoryUsageBytes: 512, pids: 5 } },
        { agent_instance_id: "inst1", container_key: "ck_b", name: "beta", state: "exited", image: null, status: null, collected_at: "2026-09-20T00:00:00.000Z", details: null, metrics: { cpuPercent: 0.5, memoryUsageBytes: 128, pids: 10 } },
      ] });
    const repo = createPostgresDockerMonitoringRepository({ query } as never);

    // Objective: current containers come from committed sample rows of the
    // newest snapshot only — samples SQL, never ingest-state/projection tables.
    const data = await repo.listCurrentContainers("vps-a");
    const [identitySql, identityValues] = query.mock.calls[0]!;
    expect(identitySql).toContain("SELECT agent_instance_id, snapshot_id FROM docker_metric_samples");
    expect(identitySql).toContain("WHERE vps_id = $1");
    expect(identitySql).toContain("ORDER BY effective_at DESC, id DESC LIMIT 1");
    expect(identityValues).toEqual(["vps-a"]);

    const [rowsSql, rowsValues] = query.mock.calls[1]!;
    expect(rowsSql).toContain("FROM docker_metric_samples");
    expect(rowsSql).toContain("container_key IS NOT NULL");
    expect(rowsSql).toContain("ORDER BY container_key ASC, id ASC");
    expect(rowsValues).toEqual(["vps-a", "inst1", "snap_new"]);

    expect(data).toEqual([
      { agentInstanceId: "inst1", containerKey: "ck_a", name: "alpha", state: "running", image: "nginx:1.25", status: "Up 1 hour", collectedAt: "2026-09-20T00:00:00.000Z", metrics: { cpuPercent: 1.5, memoryUsageBytes: 512, pids: 5 } },
      { agentInstanceId: "inst1", containerKey: "ck_b", name: "beta", state: "exited", collectedAt: "2026-09-20T00:00:00.000Z", metrics: { cpuPercent: 0.5, memoryUsageBytes: 128, pids: 10 } },
    ]);
  });

  it("omits optional keys when the stored columns are null", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ agent_instance_id: "inst1", snapshot_id: "snap_new" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [
        { agent_instance_id: "inst1", container_key: "ck_a", name: null, state: null, image: null, status: null, collected_at: "2026-09-20T00:00:00.000Z", details: null, metrics: { cpuPercent: 1, memoryUsageBytes: 2, pids: 3 } },
      ] });
    const repo = createPostgresDockerMonitoringRepository({ query } as never);

    const data = await repo.listCurrentContainers("vps-a");
    expect(data).toEqual([
      { agentInstanceId: "inst1", containerKey: "ck_a", collectedAt: "2026-09-20T00:00:00.000Z", metrics: { cpuPercent: 1, memoryUsageBytes: 2, pids: 3 } },
    ]);
    expect(Object.keys(data[0]!).sort()).toEqual([
      "agentInstanceId",
      "collectedAt",
      "containerKey",
      "metrics",
    ]);
  });

  it("returns [] with exactly one query when the VPS has no samples", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const repo = createPostgresDockerMonitoringRepository({ query } as never);

    expect(await repo.listCurrentContainers("vps-a")).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual(["vps-a"]);
  });
});
