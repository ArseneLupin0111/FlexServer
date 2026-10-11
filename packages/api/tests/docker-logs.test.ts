import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import * as nodeHttp from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config/app-config.js";
import { DockerLogsService, type DockerLogsPolicySnapshot } from "../src/docker/docker-logs.service.js";
import { DockerManagementService } from "../src/docker/docker-management.service.js";
import {
  createJsonAgentRepository,
  type AgentRepository,
} from "../src/persistence/repositories/agent.repository.js";
import {
  createJsonAuditRepository,
} from "../src/persistence/repositories/audit.repository.js";
import {
  createJsonDockerManagementRepository,
} from "../src/persistence/repositories/docker-management.repository.js";
import {
  createJsonDockerMonitoringRepository,
  seedDockerMonitoringForTests,
} from "../src/persistence/repositories/docker-monitoring.repository.js";
import {
  createJsonJobRepository,
} from "../src/persistence/repositories/job.repository.js";
import {
  createJsonMetricRepository,
} from "../src/persistence/repositories/metric.repository.js";
import {
  createJsonSessionRepository,
} from "../src/persistence/repositories/session.repository.js";
import {
  createVpsStore,
  type VpsRepository,
} from "../src/persistence/store/vpsStore.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { AgentService } from "../src/agents/agent.service.js";
import { createSessionCookie } from "./test-helpers.js";

// ── Realtime log broker: ephemeral SSE streams, claim/upload lifecycle ────
// The broker owns in-flight subscriptions only. No log content, no history,
// no replay: a subscription lives from the viewer's SSE request until one of
// the teardown paths (browser close, agent outcome, policy/session loss,
// expiry, shutdown) runs, and every path releases the registry slot and its
// timers.

const SESSION_SECRET = "docker-logs-api-test-secret-32chars";
const T_SNAP = "2026-09-15T12:00:00.000Z";

const baseConfig: AppConfig = {
  mode: "local",
  enableWebTerminal: false,
  allowPrivateNetworkTargets: false,
  dataDir: "data",
  privateDir: "private",
  rateLimitWindowMs: 60_000,
  rateLimitMax: 120,
  agentInstallIntervalSeconds: 1,
  allowInsecureAgentHttp: false,
  storageDriver: "json",
  dbSsl: false,
  dbPoolMax: 10,
  dashboardSessionTtlSeconds: 86_400,
  dashboardCookieSecure: false,
  dashboardCookieSameSite: "lax",
  dashboardSessionSecret: SESSION_SECRET,
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
};

let tempDir: string;
let vpsRepo: VpsRepository;
let agentRepo: AgentRepository;
let agentService: AgentService;
let sessionCookie: string;
let vpsA = "";
let vpsB = "";
let vpsOff = "";
let tokenA = "";
let tokenB = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-docker-logs-"));
  const dataDir = join(tempDir, "data");

  vpsRepo = createVpsStore(join(dataDir, "vps.json"));
  const a = await vpsRepo.create({
    name: "logs-a",
    host: "203.0.113.40",
    port: 22,
    username: "root",
  });
  const b = await vpsRepo.create({
    name: "logs-b",
    host: "203.0.113.41",
    port: 22,
    username: "root",
  });
  const off = await vpsRepo.create({
    name: "logs-off",
    host: "203.0.113.42",
    port: 22,
    username: "root",
  });
  vpsA = a.id;
  vpsB = b.id;
  vpsOff = off.id;

  await vpsRepo.update(vpsA, { dockerManagementEnabled: true });
  await vpsRepo.update(vpsB, { dockerManagementEnabled: true });
  // vpsOff keeps default management consent off; read-only logs remain available.

  await seedDockerMonitoringForTests(
    join(dataDir, "docker-monitoring.json"),
    {
      samples: [
        row("web", vpsA, "snap_a", {
          containerKey: "ck_web",
          name: "web",
          state: "running",
        }),
        row("api", vpsA, "snap_a", {
          containerKey: "ck_api",
          name: "api",
          state: "running",
        }),
        row("svc", vpsB, "snap_b", {
          agentInstanceId: "instB",
          containerKey: "ck_b",
          name: "service-b",
          state: "running",
        }),
        row("off", vpsOff, "snap_off", {
          containerKey: "ck_web",
          name: "web",
          state: "running",
        }),
      ],
    },
  );

  agentRepo = createJsonAgentRepository(join(dataDir, "agents.json"));
  agentService = new AgentService(
    agentRepo,
    createJsonMetricRepository(join(dataDir, "metrics.json")),
    vpsRepo,
    { ...baseConfig, dataDir, privateDir: join(tempDir, "private") },
    new AgentLifecycleCoordinator(),
    {} as never,
  );
  tokenA = (await agentService.createCredential(vpsA)).token;
  tokenB = (await agentService.createCredential(vpsB)).token;
  sessionCookie = await createSessionCookie(tempDir, SESSION_SECRET);
});

afterEach(async () => {
  // Each test drives its own real HTTP servers; a stream the test never
  // awaited to completion must not outlive the test.
  for (const server of openServers) {
    server.close();
    server.closeAllConnections?.();
  }
  openServers.clear();
  await rm(tempDir, { recursive: true, force: true });
});

function row(
  id: string,
  vpsId: string,
  snapshotId: string,
  extra: Record<string, unknown>,
) {
  return {
    id,
    vpsId,
    agentInstanceId: "instA",
    snapshotId,
    collectedAt: T_SNAP,
    receivedAt: T_SNAP,
    effectiveAt: T_SNAP,
    metrics: { cpuPercent: 1, memoryUsageBytes: 64, pids: 2 },
    ...extra,
  };
}

function app(configOverrides: Partial<AppConfig> = {}) {
  return createApp({
    config: {
      ...baseConfig,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
      ...configOverrides,
    },
    store: vpsRepo,
    keys: createKeyService(join(tempDir, "private", "keys")),
    agent: agentRepo,
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    jobs: createJsonJobRepository(join(tempDir, "data", "jobs.json")),
    metrics: createJsonMetricRepository(join(tempDir, "data", "metrics.json")),
    sessions: createJsonSessionRepository(
      join(tempDir, "data", "sessions.json"),
    ),
    dockerManagement: createJsonDockerManagementRepository(
      join(tempDir, "data", "docker-management.json"),
    ),
    dockerMonitoring: createJsonDockerMonitoringRepository(
      join(tempDir, "data", "docker-monitoring.json"),
    ),
  });
}

type AppServer = Express;

function streamUrl(
  vpsId: string,
  agentInstanceId = "instA",
  containerKey = "ck_web",
) {
  return `/api/vps/${vpsId}/docker/management/logs/stream?agentInstanceId=${encodeURIComponent(agentInstanceId)}&containerKey=${encodeURIComponent(containerKey)}`;
}

type Frame = { event: string; data: Record<string, unknown> };

/**
 * Ephemeral HTTP servers created by `openStream`. Every test drives real
 * sockets, so the handles are tracked and closed centrally — a stream the test
 * never awaits to completion cannot otherwise leak its listener.
 */
const openServers = new Set<nodeHttp.Server>();

type StreamResult = {
  status: number;
  headers: Record<string, string>;
  frames: Frame[];
};

/**
 * The open SSE request. Awaiting the handle resolves when the response ends
 * (clean `end()` or aborted socket); `registration` resolves as soon as the
 * broker's `waiting` frame is on the wire, which is an awaited signal — not a
 * duration — that the subscription row is already claimable.
 */
type StreamHandle = Promise<StreamResult> & {
  registration: Promise<string | null>;
};

/**
 * Opens the SSE response on a raw HTTP client so the test observes the real
 * status, headers, and every frame, and can stop reading once it has seen what
 * it needs. Resolution is driven by the response's own `end`/`close` events,
 * which the broker emits through `res.end()` — never by a guessed duration.
 */
function openStream(
  server: AppServer,
  url: string,
  options: {
    cookie?: string;
    onFirstFrame?: (subscriptionId: string) => void;
    pauseOn?: (frames: Frame[]) => boolean;
  } = {},
): StreamHandle {
  const { promise, resolve } = Promise.withResolvers<StreamResult>();
  const {
    promise: registrationPromise,
    resolve: resolveRegistration,
  } = Promise.withResolvers<string | null>();
  const settled = { done: false };
  const finish = () => {
    if (settled.done) return;
    settled.done = true;
    // No state frame ever arrived, so nothing can be claimed from here.
    resolveRegistration(null);
    // Release the ephemeral listener and any socket the test did not abort
    // itself, so an ended stream never keeps a handle open.
    httpServer.close();
    httpServer.closeAllConnections?.();
    resolve({ status, headers, frames: sink });
  };

  let status = 0;
  let headers: Record<string, string> = {};
  const sink: Frame[] = [];
  let registered = false;
  const signalRegistration = (subscriptionId: string) => {
    if (registered) return;
    registered = true;
    resolveRegistration(subscriptionId);
  };
  // `server` is the raw Express app from createApp; wrap it in a real HTTP
  // server so a live socket exists for the stream and can be destroyed.
  const handler = server as unknown as (req: unknown, res: unknown) => void;
  const {
    promise: listening,
    resolve: resolveListening,
    reject: rejectListening,
  } = Promise.withResolvers<{ host: string; port: number }>();
  const httpServer = nodeHttp.createServer(handler);
  openServers.add(httpServer);
  httpServer.once("error", rejectListening);
  httpServer.listen(0, "127.0.0.1", () => {
    const address = httpServer.address();
    if (address && typeof address === "object") {
      resolveListening({ host: address.address, port: address.port });
    } else {
      rejectListening(new Error("no address"));
    }
  });

  listening
    .then(({ host, port }) => {
      nodeHttp.get(
        {
          host,
          port,
          path: url,
          headers: { Cookie: options.cookie ?? sessionCookie },
        },
        (res) => {
          status = res.statusCode ?? 0;
          headers = res.headers as Record<string, string>;
          res.setEncoding("utf8");
          let raw = "";
          res.on("data", (chunk: string) => {
            raw += chunk;
            const frames = parseFrames(raw);
            while (sink.length < frames.length) {
              const frame = frames[sink.length];
              sink.push(frame);
              if (frame.event === "docker.logs.state") {
                signalRegistration(String(frame.data.subscriptionId));
                options.onFirstFrame?.(String(frame.data.subscriptionId));
              }
            }
            if (options.pauseOn?.(sink)) {
              // Pause first so the buffered bytes are fully processed, then
              // abort on the next tick — the same signal a browser navigation
              // produces. Destroying before the data event ran lost the frame.
              res.pause();
              setImmediate(() => res.destroy());
            }
          });
          // `close` covers both a clean `res.end()` and an aborted socket.
          res.on("close", finish);
          res.on("error", finish);
        },
      );
    })
    .catch(() => {
      status = 0;
      finish();
    });

  const handle = promise as StreamHandle;
  handle.registration = registrationPromise;
  return handle;
}

/**
 * Awaits an already-observed signal under a bounded wall-clock deadline. The
 * signal — an SSE frame written by the broker, a response end, a claim answer —
 * is the mechanism; the deadline only guards against a dead socket or a bug,
 * so a healthy run resolves on the first observation and a broken one still
 * fails with the condition, not a duration.
 *
 * Integration exception: these tests drive real HTTP sockets, so the deadline
 * necessarily runs against the platform clock. Deterministic time control
 * cannot stand in for an actual round trip; the product's own timers are
 * covered deterministically in the fake-clock suite below.
 */
const SIGNAL_DEADLINE_MS = 5_000;

async function withDeadline<T>(signal: Promise<T>, what: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error(`${what} was not observed in time`)),
    SIGNAL_DEADLINE_MS,
  );
  // Never hold the process open for a safety net.
  timer.unref?.();
  try {
    return await Promise.race([signal, promise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses the complete `\n\n`-terminated frames out of `raw`. Only terminated
 * blocks are returned: a single TCP chunk may end mid-line, mid-`data:`
 * prefix, or mid-manifest, and an unterminated tail is re-examined when the
 * next chunk lands. Incomplete lines are skipped rather than parsed.
 */
function parseFrames(raw: string): Frame[] {
  const frames: Frame[] = [];
  const blocks = raw.split("\n\n");
  for (const block of blocks.slice(0, -1)) {
    const lines = block.split("\n");
    const eventLine = lines.find((value) => value.startsWith("event: "));
    const dataLine = lines.find((value) => value.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    try {
      frames.push({
        event: eventLine.slice("event: ".length).trim(),
        data: JSON.parse(dataLine.slice("data: ".length)),
      });
    } catch {
      // A complete block with an unparsable manifest fails the frame-order
      // assertion as a missing frame instead of crashing the socket reader.
      continue;
    }
  }
  return frames;
}

function claim(
  server: AppServer,
  bearer: string,
  agentInstanceId = "instA",
) {
  return request(server)
    .post("/api/agent/logs/claim")
    .set("Authorization", `Bearer ${bearer}`)
    .send({ agentInstanceId });
}

function chunks(
  server: AppServer,
  bearer: string,
  subscriptionId: string,
  overrides: Record<string, unknown> = {},
) {
  return request(server)
    .post(`/api/agent/logs/${encodeURIComponent(subscriptionId)}/chunks`)
    .set("Authorization", `Bearer ${bearer}`)
    .send({
      agentInstanceId: "instA",
      sequence: 1,
      ready: true,
      lines: [],
      ...overrides,
    });
}

function result(
  server: AppServer,
  bearer: string,
  subscriptionId: string,
  overrides: Record<string, unknown> = {},
) {
  return request(server)
    .post(`/api/agent/logs/${encodeURIComponent(subscriptionId)}/result`)
    .set("Authorization", `Bearer ${bearer}`)
    .send({
      agentInstanceId: "instA",
      status: "completed",
      ...overrides,
    });
}

function line(text: string, stream = "stdout") {
  return { stream, text, truncated: false };
}

/**
 * Claims a stream once the broker has registered it. `registration` is the
 * awaited signal that the subscription row already exists, so the claim never
 * races the registration it is meant to observe — no retries, no duration.
 */
async function claimOpen(
  handle: StreamHandle,
  server: AppServer,
  bearer = tokenA,
  agentInstanceId = "instA",
) {
  const subscriptionId = await withDeadline(
    handle.registration,
    "docker.logs.state waiting frame",
  );
  expect(subscriptionId).not.toBeNull();
  const claimed = (await claim(server, bearer, agentInstanceId).expect(200)).body
    .data.subscription;
  expect(claimed.subscriptionId).toBe(subscriptionId);
  expect(claimed.vpsId).toBeDefined();
  expect(claimed.agentInstanceId).toBe(agentInstanceId);
  expect(claimed.tailLines).toBe(200);
  return subscriptionId as string;
}

// ── Stream open and pre-header rejection ───────────────────────────────────

describe("GET /api/vps/:id/docker/management/logs/stream", () => {
  it("registers a waiting subscription and answers with SSE headers", async () => {
    const server = app();
    const opened = { subscriptionId: "" };
    // Destroy right after the waiting frame: the assertion is on the wire
    // shape, so there is no reason to hold the socket open.
    const stream = await openStream(server, streamUrl(vpsA), {
      onFirstFrame: (id) => {
        opened.subscriptionId = id;
      },
      pauseOn: (frames) => frames.length >= 1,
    });
    expect(opened.subscriptionId).toMatch(/^dlog_[A-Za-z0-9._~-]+$/);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.headers["cache-control"]).toContain("no-cache");
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    expect(stream.frames).toEqual([
      {
        event: "docker.logs.state",
        data: { subscriptionId: opened.subscriptionId, status: "waiting" },
      },
    ]);

    // No viewer history may be written anywhere: the JSON data files hold no
    // log content after a stream opened and closed.
    const files = await readdir(join(tempDir, "data"));
    for (const file of files) {
      const text = await readFile(join(tempDir, "data", file), "utf8");
      expect(text).not.toContain("ck_web-out");
    }
  });

  it("requires a dashboard session", async () => {
    const server = app();
    const res = await request(server).get(streamUrl(vpsA)).expect(401);
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("rejects an unknown VPS with 404 before headers", async () => {
    const server = app();
    const res = await request(server)
      .get(streamUrl("vps_missing"))
      .set("Cookie", sessionCookie)
      .expect(404);
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("rejects a system-managed host with 403 before headers", async () => {
    await vpsRepo.update(vpsOff, { managedBy: "system" });
    const server = app();
    const res = await request(server)
      .get(streamUrl(vpsOff))
      .set("Cookie", sessionCookie)
      .expect(403);
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("rejects a container that is not in the current snapshot with 404", async () => {
    const server = app();
    const res = await request(server)
      .get(streamUrl(vpsA, "instA", "ck_vanished"))
      .set("Cookie", sessionCookie)
      .expect(404);
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("rejects a valid instance id paired with another instance's containerKey", async () => {
    const server = app();
    // `ck_b` belongs to instB; asking for it as instA must not leak or match.
    const res = await request(server)
      .get(streamUrl(vpsA, "instA", "ck_b"))
      .set("Cookie", sessionCookie)
      .expect(404);
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("rejects a malformed query with 400 and never dumps the parsed input", async () => {
    const server = app();
    for (const url of [
      `/api/vps/${vpsA}/docker/management/logs/stream?containerKey=ck_web`,
      `/api/vps/${vpsA}/docker/management/logs/stream?agentInstanceId=instA`,
      `/api/vps/${vpsA}/docker/management/logs/stream?agentInstanceId=inst%20A&containerKey=ck_web`,
      `/api/vps/${vpsA}/docker/management/logs/stream?agentInstanceId=instA&containerKey=ck_web&tail=100`,
    ]) {
      const res = await request(server).get(url).set("Cookie", sessionCookie);
      expect(res.status).toBe(400);
      expect(res.headers["content-type"]).not.toContain("text/event-stream");
      expect(JSON.stringify(res.body)).not.toContain("agentInstanceId");
    }
  });

  it("rejects a stream in demo mode with 403", async () => {
    const server = app({ mode: "demo" });
    await request(server)
      .get(streamUrl(vpsA))
      .set("Cookie", sessionCookie)
      .expect(403);
  });
});

// ── Claim → upload → live → result lifecycle ───────────────────────────────

describe("log stream claim and upload lifecycle", () => {
  it("opens, claims, and uploads logs with default management consent off", async () => {
    expect((await vpsRepo.get(vpsOff))?.dockerManagementEnabled).toBe(false);
    const tokenOff = (await agentService.createCredential(vpsOff)).token;
    const server = app();
    const stream = openStream(server, streamUrl(vpsOff));
    const subscriptionId = await claimOpen(stream, server, tokenOff);
    await chunks(server, tokenOff, subscriptionId, { lines: [line("read-only log")] }).expect(200);
    await result(server, tokenOff, subscriptionId).expect(200);
    const response = await stream;
    expect(response.status).toBe(200);
    expect(response.frames.map((frame) => frame.event)).toEqual([
      "docker.logs.state", "docker.logs.state", "docker.logs.lines", "docker.logs.closed",
    ]);
    expect(response.frames[2].data).toEqual({ subscriptionId, lines: [line("read-only log")] });
  });

  it("answers null when no viewer is waiting, then claims FIFO", async () => {
    const server = app();
    expect((await claim(server, tokenA).expect(200)).body).toEqual({
      data: { subscription: null },
    });

    const first = openStream(server, streamUrl(vpsA));
    const second = openStream(server, streamUrl(vpsA));
    const [firstId, secondId] = await withDeadline(
      Promise.all([first.registration, second.registration]),
      "two waiting registrations",
    );
    expect(firstId).not.toBeNull();
    expect(secondId).not.toBeNull();
    expect(firstId).not.toBe(secondId);

    // With two viewers waiting, claim returns one of them and never repeats it.
    const claimed = (await claim(server, tokenA).expect(200)).body.data
      .subscription;
    expect([firstId, secondId]).toContain(claimed.subscriptionId);
    expect(claimed.vpsId).toBe(vpsA);
    expect(claimed.agentInstanceId).toBe("instA");
    expect(claimed.tailLines).toBe(200);

    const again = (await claim(server, tokenA).expect(200)).body.data
      .subscription;
    expect(again.subscriptionId).not.toBe(claimed.subscriptionId);
    expect([firstId, secondId]).toContain(again.subscriptionId);

    // Both streams are claimed now, so the queue is empty again.
    const body = (await claim(server, tokenA).expect(200)).body.data
      .subscription;
    expect(body).toBeNull();
  });

  it("moves waiting to live and forwards stdout and stderr in order", async () => {
    const server = app();
    let captured = "";
    const stream = openStream(server, streamUrl(vpsA), {
      onFirstFrame: (id) => {
        captured = id;
      },
    });
    // The `waiting` frame is the awaited signal that the broker registered the
    // subscription; the claim below then observes a real row, not a race.
    const subscriptionId = await claimOpen(stream, server);
    expect(subscriptionId).toBe(captured);

    await chunks(server, tokenA, subscriptionId, {
      lines: [line("history-1"), line("boom-1", "stderr")],
    }).expect(200);
    await chunks(server, tokenA, subscriptionId, {
      sequence: 2,
      lines: [line("history-2"), line("boom-2", "stderr")],
    }).expect(200);
    await result(server, tokenA, subscriptionId).expect(200);

    const frames = (await stream).frames;
    expect(frames.map((frame) => frame.event)).toEqual([
      "docker.logs.state",
      "docker.logs.state",
      "docker.logs.lines",
      "docker.logs.lines",
      "docker.logs.closed",
    ]);
    expect(frames[0].data).toEqual({ subscriptionId, status: "waiting" });
    expect(frames[1].data).toEqual({ subscriptionId, status: "live" });
    expect(frames[2].data).toEqual({
      subscriptionId,
      lines: [
        { stream: "stdout", text: "history-1", truncated: false },
        { stream: "stderr", text: "boom-1", truncated: false },
      ],
    });
    expect(frames[3].data).toEqual({
      subscriptionId,
      lines: [
        { stream: "stdout", text: "history-2", truncated: false },
        { stream: "stderr", text: "boom-2", truncated: false },
      ],
    });
    expect(frames[4].data).toEqual({ subscriptionId, reason: "completed" });
  });

  it("accepts an empty batch as a heartbeat and emits no lines frame", async () => {
    const server = app();
    const stream = openStream(server, streamUrl(vpsA), {});
    const subscriptionId = await claimOpen(stream, server);

    await chunks(server, tokenA, subscriptionId, { lines: [] }).expect(200);
    await chunks(server, tokenA, subscriptionId, { sequence: 2, lines: [] }).expect(200);
    await result(server, tokenA, subscriptionId).expect(200);

    const frames = (await stream).frames;
    expect(frames.map((frame) => frame.event)).toEqual([
      "docker.logs.state",
      "docker.logs.state",
      "docker.logs.closed",
    ]);
  });

  it("rejects a not-ready chunk and a wrong sequence with 409", async () => {
    const server = app();
    const stream = openStream(server, streamUrl(vpsA), {});
    const subscriptionId = await claimOpen(stream, server);

    await chunks(server, tokenA, subscriptionId, { ready: false }).expect(409);
    await chunks(server, tokenA, subscriptionId, { sequence: 7 }).expect(409);
    // Sequence 1 is still expected, so the valid batch still lands.
    await chunks(server, tokenA, subscriptionId).expect(200);
    await result(server, tokenA, subscriptionId).expect(200);
    await stream;
  });

  it("rejects malformed chunk and result bodies with 400", async () => {
    const server = app();
    const stream = openStream(server, streamUrl(vpsA), {});
    const subscriptionId = await claimOpen(stream, server);

    await request(server)
      .post(`/api/agent/logs/${subscriptionId}/chunks`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ agentInstanceId: "instA", sequence: 0, ready: true, lines: [] })
      .expect(400);
    await request(server)
      .post(`/api/agent/logs/${subscriptionId}/chunks`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        agentInstanceId: "instA",
        sequence: 1,
        ready: true,
        lines: [{ stream: "stdout" }],
      })
      .expect(400);
    await request(server)
      .post(`/api/agent/logs/${subscriptionId}/result`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ agentInstanceId: "instA", status: "aborted" })
      .expect(400);
    await result(server, tokenA, subscriptionId).expect(200);
    await stream;
  });

  it("reports a failed outcome with a safe code and no daemon detail", async () => {
    const server = app();
    const stream = openStream(server, streamUrl(vpsA), {});
    const subscriptionId = await claimOpen(stream, server);

    await result(server, tokenA, subscriptionId, {
      status: "failed",
      errorCode: "daemon_unreachable",
    }).expect(200);

    const frames = (await stream).frames;
    const closed = frames[frames.length - 1];
    expect(closed).toEqual({
      event: "docker.logs.closed",
      data: {
        subscriptionId,
        reason: "failed",
        errorCode: "daemon_unreachable",
      },
    });
    // The broker never carries daemon text, so no detail can leak through.
    expect(JSON.stringify(frames)).not.toContain("permission denied");
  });
});

// ── Credential binding ─────────────────────────────────────────────────────

describe("log stream credential binding", () => {
  it("refuses claims and uploads from another VPS's credential", async () => {
    const server = app();
    const stream = openStream(server, streamUrl(vpsA), {});
    const subscriptionId = await claimOpen(stream, server);

    // B's credential holds no waiting stream on B, so it sees nothing.
    expect((await claim(server, tokenB).expect(200)).body).toEqual({
      data: { subscription: null },
    });
    // B cannot write to A's subscription, and the id is never consumed.
    await chunks(
      server,
      tokenB,
      subscriptionId,
      { agentInstanceId: "instA" },
    ).expect(404);
    await result(
      server,
      tokenB,
      subscriptionId,
      { agentInstanceId: "instA" },
    ).expect(404);

    // A's own credential still works.
    await chunks(server, tokenA, subscriptionId).expect(200);
    await result(server, tokenA, subscriptionId).expect(200);
    await stream;
  });

  it("refuses an unknown id with 404 and a closed id with 410", async () => {
    const server = app();
    await request(server)
      .post("/api/agent/logs/dlog_does-not-exist/chunks")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ agentInstanceId: "instA", sequence: 1, ready: true, lines: [] })
      .expect(404);
    await request(server)
      .post("/api/agent/logs/dlog_does-not-exist/result")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ agentInstanceId: "instA", status: "completed" })
      .expect(404);

    const stream = openStream(server, streamUrl(vpsA), {});
    const subscriptionId = await claimOpen(stream, server);
    await result(server, tokenA, subscriptionId).expect(200);
    await stream;

    // Once closed, the owning agent's subsequent chunks/result receive 410 Gone,
    // signaling to tear down rather than retry.
    await request(server)
      .post(`/api/agent/logs/${subscriptionId}/chunks`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ agentInstanceId: "instA", sequence: 2, ready: true, lines: [] })
      .expect(410);

    // Another VPS credential gets 404, never learning that the closed ID existed.
    await request(server)
      .post(`/api/agent/logs/${subscriptionId}/chunks`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ agentInstanceId: "instA", sequence: 2, ready: true, lines: [] })
      .expect(404);
  });

  it("refuses agent routes without a bearer token", async () => {
    const server = app();
    await request(server)
      .post("/api/agent/logs/claim")
      .send({ agentInstanceId: "instA" })
      .expect(401);
    await request(server)
      .post("/api/agent/logs/dlog_x/chunks")
      .send({ agentInstanceId: "instA", sequence: 1, ready: true, lines: [] })
      .expect(401);
  });
});

// ── Registry lifecycle, limits, and body bounds ────────────────────────────

describe("log stream registry lifecycle", () => {
  it("releases the subscription when the browser disconnects", async () => {
    const server = app();
    let captured = "";
    // Aborting the socket is the browser-close path: the test drives the same
    // signal a tab navigation would, after the waiting frame is seen.
    const stream = await openStream(server, streamUrl(vpsA), {
      onFirstFrame: (id) => {
        captured = id;
      },
      pauseOn: (frames) => frames.length >= 1,
    });
    expect(captured).not.toBe("");
    expect(stream.status).toBe(200);

    // The response is gone, so the next agent request is a 410, never a write
    // into a dead socket.
    await chunks(server, tokenA, captured).expect(410);
    await result(server, tokenA, captured).expect(410);
    expect(stream.frames).toHaveLength(1);
  });

  it("closes streams beyond the per-VPS limit with 429", async () => {
    const server = app();
    // Open the four allowed streams and hold their sockets. A fifth attempt is
    // answered with 429 before any SSE header, and the four survive.
    const holders = Array.from({ length: 4 }, () =>
      openStream(server, streamUrl(vpsA)),
    );
    await withDeadline(
      Promise.all(holders.map((stream) => stream.registration)),
      "four waiting registrations",
    );

    const rejected = await openStream(server, streamUrl(vpsA));
    expect(rejected.status).toBe(429);
    expect(rejected.headers["content-type"]).not.toContain("text/event-stream");
    expect(rejected.frames).toEqual([]);
  });

  it("rejects an oversized chunk body with 400 before parsing", async () => {
    const server = app();
    const stream = openStream(server, streamUrl(vpsA), {});
    const subscriptionId = await claimOpen(stream, server);

    await request(server)
      .post(`/api/agent/logs/${subscriptionId}/chunks`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        agentInstanceId: "instA",
        sequence: 1,
        ready: true,
        lines: Array.from({ length: 101 }, () => line("x".repeat(1_000))),
      })
      .expect(400);
    await result(server, tokenA, subscriptionId).expect(200);
    await stream;
  });

  it("rejects a batch larger than 100 lines with 400", async () => {
    const server = app();
    const stream = openStream(server, streamUrl(vpsA), {});
    const subscriptionId = await claimOpen(stream, server);

    await request(server)
      .post(`/api/agent/logs/${subscriptionId}/chunks`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        agentInstanceId: "instA",
        sequence: 1,
        ready: true,
        lines: Array.from({ length: 101 }, () => line("x")),
      })
      .expect(400);
    await result(server, tokenA, subscriptionId).expect(200);
    await stream;
  });
});

/**
 * Deterministic lifecycle coverage: no sockets, no real time, no network.
 *
 * The integration tests above drive the same service through a real HTTP
 * harness, but their timings are the system's own limits (30s claim/ready,
 * 10s idle, 15s revalidation, 2h cap) — waiting on those would make the suite
 * slow and timing-sensitive. Here the service is instantiated directly and
 * Vitest's fake clock advances the timers instantaneously, so every lifecycle
 * branch is asserted on its own observable effect: the terminal
 * `docker.logs.closed` frame and the registry releasing its slot.
 */
describe("log stream deterministic lifecycle and timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockResponse(overrides: { write?: () => boolean } = {}) {
    const chunks: string[] = [];
    const handlers = new Map<string, Array<() => void>>();
    let ended = false;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
    const write = overrides.write ?? (() => true);
    const response = {
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      flush: vi.fn(),
      write: vi.fn((chunk: string) => {
        chunks.push(chunk);
        return write();
      }),
      end: vi.fn(() => {
        ended = true;
        resolveFinished();
      }),
      on: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return response;
      }),
      off: vi.fn((event: string, handler: () => void) => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((entry) => entry !== handler),
        );
        return response;
      }),
      emit: (event: string) => {
        for (const handler of handlers.get(event) ?? []) handler();
      },
      writableEnded: false,
      destroyed: false,
      chunks,
      finished,
      get ended() {
        return ended;
      },
    };
    return response;
  }

  function createService(overrides: {
    sessionValid?: boolean;
    targets?: Array<{
      agentInstanceId: string;
      containerKey: string;
      name: string;
    }>;
  } = {}) {
    const config = { mode: "local" } as AppConfig;
    const dockerManagement = {
      capability: vi.fn((): Promise<DockerLogsPolicySnapshot> =>
        Promise.resolve({
          logsSupported: true,
          targets:
            overrides.targets ??
            [{ agentInstanceId: "instA", containerKey: "ck_web", name: "web" }],
        }),
      ),
    };
    const dashboardSessions = {
      authenticateById: vi.fn((id: string) =>
        overrides.sessionValid === false
          ? Promise.resolve(undefined)
          : Promise.resolve({ id, userId: "u1" }),
      ),
    };
    const service = new DockerLogsService(
      config,
      dockerManagement as never,
      dashboardSessions as never,
    );
    return { service, dockerManagement, dashboardSessions };
  }

  const query = {
    vpsId: "vps_lifecycle",
    agentInstanceId: "instA",
    containerKey: "ck_web",
  };
  const session = { dashboardSessionId: "sess_1", localMode: true };
  const credential = {
    vpsId: "vps_lifecycle",
    agentInstanceId: "instA",
  } as never;

  function lastClosedCode(res: { chunks: string[] }): string {
    const last = res.chunks[res.chunks.length - 1] ?? "";
    const dataLine = last
      .split("\n")
      .find((line) => line.startsWith("data: "));
    return (dataLine ?? "").replace("data: ", "");
  }

  it.each(["system", "demo"] as const)("denies claim, upload, and periodic revalidation after a refreshed %s policy", async (policy) => {
    const config = { ...baseConfig };
    const management = new DockerManagementService(
      vpsRepo,
      createJsonDockerManagementRepository(join(tempDir, "data", "docker-management.json")),
      createJsonDockerMonitoringRepository(join(tempDir, "data", "docker-monitoring.json")),
      config,
    );
    const service = new DockerLogsService(config, management, {
      authenticateById: async () => ({ id: "sess_1", userId: "u1" }),
    } as never);
    const offQuery = { ...query, vpsId: vpsOff };
    const offCredential = { vpsId: vpsOff } as never;
    const waiting = mockResponse();
    const uploading = mockResponse();
    const revalidating = mockResponse();
    await service.open(waiting as unknown as Response, offQuery, session);
    const upload = await service.open(uploading as unknown as Response, offQuery, session);
    await service.claim(offCredential, { agentInstanceId: "instA" });
    await service.claim(offCredential, { agentInstanceId: "instA" });
    // Keep one subscription unclaimed to exercise claim's current-policy gate.
    await service.open(revalidating as unknown as Response, offQuery, session);
    if (policy === "system") await vpsRepo.update(vpsOff, { managedBy: "system" });
    else config.mode = "demo";
    expect(await service.claim(offCredential, { agentInstanceId: "instA" })).toBeNull();
    await expect(service.chunks(offCredential, upload.subscriptionId, {
      agentInstanceId: "instA", sequence: 1, ready: true, lines: [],
    })).rejects.toMatchObject({ status: 410 });
    await vi.advanceTimersByTimeAsync(15_000);
    // The interval starts an async policy lookup backed by real file I/O.
    // Advancing fake time does not await that I/O; await the response's close
    // signal instead of assuming the interval's promise has already settled.
    await withDeadline(waiting.finished, "refreshed policy stream closure");
    expect(service.snapshot()).toHaveLength(0);
    for (const response of [waiting, uploading, revalidating]) {
      expect(lastClosedCode(response)).toContain("logs_unavailable");
      expect(response.ended).toBe(true);
    }
  });

  it("keeps a subscription available after management consent is withdrawn", async () => {
    const management = new DockerManagementService(
      vpsRepo,
      createJsonDockerManagementRepository(join(tempDir, "data", "docker-management.json")),
      createJsonDockerMonitoringRepository(join(tempDir, "data", "docker-monitoring.json")),
      baseConfig,
    );
    const service = new DockerLogsService(baseConfig, management, {
      authenticateById: async () => ({ id: "sess_1", userId: "u1" }),
    } as never);
    const response = mockResponse();
    const opened = await service.open(response as unknown as Response, { ...query, vpsId: vpsA }, session);
    await vpsRepo.update(vpsA, { dockerManagementEnabled: false });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.snapshot()).toHaveLength(1);
    const localCredential = { vpsId: vpsA } as never;
    expect((await service.claim(localCredential, { agentInstanceId: "instA" }))?.subscriptionId).toBe(opened.subscriptionId);
    await service.chunks(localCredential, opened.subscriptionId, {
      agentInstanceId: "instA", sequence: 1, ready: true, lines: [line("still readable")],
    });
    expect(response.ended).toBe(false);
    service.onModuleDestroy();
  });

  it("closes with agent_unavailable when no claim and ready arrive in 30s", async () => {
    const { service } = createService();
    const res = mockResponse();
    await service.open(res as unknown as Response, query, session);
    expect(service.snapshot()).toHaveLength(1);

    vi.advanceTimersByTime(29_999);
    expect(service.snapshot()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(service.snapshot()).toHaveLength(0);
    expect(lastClosedCode(res)).toContain("agent_unavailable");
    expect(res.ended).toBe(true);
  });

  it("closes with stream_lost when a live source goes silent for 10s", async () => {
    const { service } = createService();
    const res = mockResponse();
    const opened = await service.open(res as unknown as Response, query, session);

    // Claim then report ready: the stream is now live.
    await service.claim(credential, { agentInstanceId: "instA" });
    await service.chunks(credential, opened.subscriptionId, {
      agentInstanceId: "instA",
      sequence: 1,
      ready: true,
      lines: [],
    });

    vi.advanceTimersByTime(9_999);
    expect(service.snapshot()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(service.snapshot()).toHaveLength(0);
    expect(lastClosedCode(res)).toContain("stream_lost");
    expect(res.ended).toBe(true);
  });

  it("keeps a live stream alive when heartbeats arrive within the idle window", async () => {
    const { service } = createService();
    const res = mockResponse();
    const opened = await service.open(res as unknown as Response, query, session);
    await service.claim(credential, { agentInstanceId: "instA" });
    await service.chunks(credential, opened.subscriptionId, {
      agentInstanceId: "instA",
      sequence: 1,
      ready: true,
      lines: [],
    });

    // Heartbeat every 5s keeps the stream live well past a single idle window.
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      vi.advanceTimersByTime(5_000);
      await service.chunks(credential, opened.subscriptionId, {
        agentInstanceId: "instA",
        sequence,
        ready: true,
        lines: [],
      });
    }

    expect(service.snapshot()).toHaveLength(1);
    expect(res.ended).toBe(false);
    expect(res.chunks.some((chunk) => chunk.includes("docker.logs.lines"))).toBe(
      false,
    );
  });

  it("closes with session_expired when the dashboard session stops authenticating", async () => {
    let valid = true;
    const config = { mode: "local" } as AppConfig;
    const dockerManagement = {
      capability: vi.fn((): Promise<DockerLogsPolicySnapshot> =>
        Promise.resolve({
          logsSupported: true,
          targets: [
            { agentInstanceId: "instA", containerKey: "ck_web", name: "web" },
          ],
        }),
      ),
    };
    const dashboardSessions = {
      authenticateById: vi.fn(() =>
        valid
          ? Promise.resolve({ id: "sess_1", userId: "u1" })
          : Promise.resolve(undefined),
      ),
    };
    const service = new DockerLogsService(
      config,
      dockerManagement as never,
      dashboardSessions as never,
    );
    const res = mockResponse();
    await service.open(res as unknown as Response, query, session);

    // No revalidation tick yet: the stream stays open.
    vi.advanceTimersByTime(10_000);
    expect(service.snapshot()).toHaveLength(1);

    // The session disappears; the first revalidation tick must close the stream.
    valid = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dashboardSessions.authenticateById).toHaveBeenCalled();
    expect(service.snapshot()).toHaveLength(0);
    expect(lastClosedCode(res)).toContain("session_expired");
    expect(res.ended).toBe(true);
  });

  it("closes with logs_unavailable when the target leaves the snapshot", async () => {
    let targets = [
      { agentInstanceId: "instA", containerKey: "ck_web", name: "web" },
    ];
    const config = { mode: "local" } as AppConfig;
    const dockerManagement = {
      capability: vi.fn((): Promise<DockerLogsPolicySnapshot> =>
        Promise.resolve({
          logsSupported: true,
          targets,
        }),
      ),
    };
    const dashboardSessions = {
      authenticateById: vi.fn(() =>
        Promise.resolve({ id: "sess_1", userId: "u1" }),
      ),
    };
    const service = new DockerLogsService(
      config,
      dockerManagement as never,
      dashboardSessions as never,
    );
    const res = mockResponse();
    await service.open(res as unknown as Response, query, session);

    // The container is gone from the latest snapshot at the next revalidation.
    targets = [];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.snapshot()).toHaveLength(0);
    expect(lastClosedCode(res)).toContain("logs_unavailable");
    expect(res.ended).toBe(true);
  });

  it("closes with expired at the 2h subscription cap", async () => {
    const { service } = createService();
    const res = mockResponse();
    const opened = await service.open(res as unknown as Response, query, session);
    await service.claim(credential, { agentInstanceId: "instA" });
    await service.chunks(credential, opened.subscriptionId, {
      agentInstanceId: "instA",
      sequence: 1,
      ready: true,
      lines: [],
    });

    // Heartbeats keep the live stream past every 10s idle window so the only
    // close at the cap is the 2h expiry itself.
    const cap = 2 * 60 * 60 * 1000;
    let sequence = 2;
    let advanced = 0;
    while (advanced + 5_000 < cap) {
      vi.advanceTimersByTime(5_000);
      advanced += 5_000;
      await service.chunks(credential, opened.subscriptionId, {
        agentInstanceId: "instA",
        sequence,
        ready: true,
        lines: [],
      });
      sequence += 1;
    }
    vi.advanceTimersByTime(cap - 1 - advanced);
    expect(service.snapshot()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(service.snapshot()).toHaveLength(0);
    expect(lastClosedCode(res)).toContain("expired");
    expect(res.ended).toBe(true);
  });

  it("closes with slow_consumer when the viewer stops draining the socket", async () => {
    const { service } = createService();
    const res = mockResponse({ write: () => false });
    const opened = await service.open(res as unknown as Response, query, session);
    // The `waiting` frame itself did not fit the socket buffer, so the broker
    // ended the stream instead of queueing into unbounded memory.
    expect(service.snapshot()).toHaveLength(0);
    expect(lastClosedCode(res)).toContain("slow_consumer");
    expect(res.ended).toBe(true);
    expect(opened.subscriptionId).toMatch(/^dlog_/);
  });

  it("releases every subscription and its timers on shutdown", async () => {
    const { service } = createService({
      targets: [
        { agentInstanceId: "instA", containerKey: "ck_web", name: "web" },
        { agentInstanceId: "instA", containerKey: "ck_api", name: "api" },
      ],
    });
    const first = mockResponse();
    const second = mockResponse();
    await service.open(first as unknown as Response, query, session);
    await service.open(second as unknown as Response, {
      ...query,
      containerKey: "ck_api",
    }, session);
    expect(service.snapshot()).toHaveLength(2);

    service.onModuleDestroy();

    expect(service.snapshot()).toHaveLength(0);
    expect(first.ended).toBe(true);
    expect(second.ended).toBe(true);
    expect(lastClosedCode(first)).toContain("logs_unavailable");
    // After module destroy no timer may fire a late write into a dead socket.
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
