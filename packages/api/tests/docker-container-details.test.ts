import { describe, expect, it } from "vitest";
import { dockerContainerDetailsSchema as schema } from "../src/docker/docker-container-details.js";

const available = () => ({
  collectedAt: "2026-10-19T10:00:00.123456789Z",
  status: "available" as const,
  ports: [{ containerPort: 80, protocol: "tcp", hostIp: "::1", hostPort: 8080 }],
  mounts: [{ type: "bind", source: "/host", destination: "/app", readOnly: true }],
  networks: [{ name: "bridge", ipv4: "172.18.0.2" }],
  healthcheck: { status: "none" as const },
});

describe("bounded Docker container details", () => {
  it("preserves zero and false without fabricating absent lifecycle values", () => {
    const result = schema.parse({ ...available(), exitCode: 0, oomKilled: false });
    expect(result).toMatchObject({ exitCode: 0, oomKilled: false });
    expect(result).not.toHaveProperty("finishedAt");
  });

  it("requires complete available sections and limits unavailable to its reason", () => {
    expect(schema.parse({ collectedAt: available().collectedAt, status: "unavailable", reason: "timeout" })).toEqual({ collectedAt: available().collectedAt, status: "unavailable", reason: "timeout" });
    expect(schema.safeParse({ ...available(), ports: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...available(), status: "unavailable", reason: "timeout" }).success).toBe(false);
  });

  it.each([
    { Env: ["SECRET"] },
    { healthcheck: { status: "healthy", command: "SECRET" } },
    { networks: [{ name: "bridge", networkId: "raw" }] },
    { mounts: [{ type: "volume", destination: "/app", readOnly: false, options: { password: "SECRET" } }] },
  ])("rejects raw inspect properties at each nested level", (extra) => {
    expect(schema.safeParse({ ...available(), ...extra }).success).toBe(false);
  });

  it("checks UTF-8 path boundaries rather than JavaScript string length", () => {
    const details = available();
    details.mounts[0].source = "é".repeat(512);
    expect(schema.safeParse(details).success).toBe(true);
    details.mounts[0].source += "a";
    expect(schema.safeParse(details).success).toBe(false);
  });

  it("rejects total envelopes exceeding 16 KiB even when individual paths fit", () => {
    const details = { ...available(), mounts: Array.from({ length: 16 }, (_, i) => ({ type: "bind", source: "s".repeat(1024), destination: `/${i}`, readOnly: false })) };
    expect(schema.safeParse(details).success).toBe(false);
  });

  it.each(["0001-01-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-19T10:00:00+01:00"])("rejects invalid or non-UTC lifecycle timestamp %s", (createdAt) => {
    expect(schema.safeParse({ ...available(), createdAt }).success).toBe(false);
  });

  it.each([
    { exitCode: 256 }, { restartCount: -1 }, { restartCount: Number.MAX_SAFE_INTEGER + 1 },
    { ports: [{ containerPort: 0, protocol: "tcp" }] },
    { ports: Array.from({ length: 33 }, () => ({ containerPort: 80, protocol: "tcp" })) },
  ])("rejects out-of-range metadata", (extra) => {
    expect(schema.safeParse({ ...available(), ...extra }).success).toBe(false);
  });
});
