import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository, aiCodexOauthAad } from "../src/persistence/repositories/ai.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiRoutesService } from "../src/ai/ai-routes.service.js";
import { AiCodexOauthService } from "../src/ai/ai-codex-oauth.service.js";
import { encryptAiSecret } from "../src/ai/ai-crypto.js";
import { createTestKeyring, saveKeyringToFile, type Keyring } from "../src/ssh/key-encryption.js";
import type { MetricService } from "../src/metrics/metric.service.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import type { AiHostPlanService } from "../src/ai/ai-host-plan.service.js";
import type { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import type { AiReadToolsService } from "../src/ai/ai-read-tools.service.js";

const request = { dashboardSessionId: "admin-session" } as Request;

describe("ChatGPT OAuth provider end-to-end (offline stubs)", () => {
  let dir: string;
  let keyring: Keyring;
  let authServer: Server;
  let codexServer: Server;
  let authBase: string;
  let codexBase: string;
  let tokenResponses: { status: number; body: unknown }[];
  let codexRequests: { authorization?: string; originator?: string; body: unknown }[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-codex-flow-"));
    keyring = createTestKeyring("kek_codex_flow");
    await saveKeyringToFile(join(dir, "keyring.json"), keyring);
    tokenResponses = [];
    codexRequests = [];
    authServer = createServer((req, res) => {
      req.resume();
      const next = tokenResponses.shift() ?? { status: 200, body: { access_token: `access-${randomUUID()}`, refresh_token: `refresh-${randomUUID()}`, id_token: undefined, expires_in: 3600 } };
      res.writeHead(next.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
    codexServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: { name?: string }[] };
        codexRequests.push({ authorization: req.headers.authorization, originator: String(req.headers.originator ?? ""), body });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (body.tools?.some((tool) => tool.name === "flexserver_check")) {
          res.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", call_id: "check-1", name: "flexserver_check", arguments: "{\"ok\":true}" }], usage: { input_tokens: 5, output_tokens: 2 } }));
          return;
        }
        res.end(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done via Codex" }] }], usage: { input_tokens: 10, output_tokens: 5 } }));
      });
    });
    await Promise.all([new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve)), new Promise<void>((resolve) => codexServer.listen(0, "127.0.0.1", resolve))]);
    authBase = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
    codexBase = `http://127.0.0.1:${(codexServer.address() as AddressInfo).port}`;
  }, 20_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([new Promise<void>((resolve) => authServer.close(() => resolve())), new Promise<void>((resolve) => codexServer.close(() => resolve()))]);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  async function setup() {
    const repository = createJsonAiRepository(join(dir, "ai.json"));
    const vps = createVpsStore(join(dir, "vps.json"));
    const server = await vps.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    const base = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "codex-flow-secret-0123456789abcdef" });
    const config = { ...base, ai: { ...base.ai, enabled: true, keyringFile: join(dir, "keyring.json"), contextWindowTokens: 16000, contextWindowTokensByModel: {}, contextReserveTokens: 2048, contextTailTokens: 1000, maxCumulativeTaskTokens: 1000000, codexOauth: { clientId: "test-client-id", authBaseUrl: authBase, apiBaseUrl: codexBase, cliVersion: "0.55.0" } } };
    const policy = new AiPolicyService(config, repository);
    const codexOauth = new AiCodexOauthService({ clientId: "test-client-id", authBaseUrl: authBase, apiBaseUrl: codexBase, cliVersion: "0.55.0" }, repository, config.ai.keyringFile);
    const routes = new AiRoutesService(config, repository, vps, codexOauth);
    const service = new AiTaskService(repository, config, policy, {} as MetricService, { authenticateById: async () => ({ sessionId: "admin-session" }) } as unknown as DashboardSessionService, {} as DockerMonitoringService, {} as AiHostPlanService, {} as AiDockerBridgeService, {} as DockerMonitoringRepository, {} as AiReadToolsService, vps, codexOauth);
    return { repository, server, config, routes, service, codexOauth };
  }
  const wait = async (repository: Awaited<ReturnType<typeof setup>>["repository"], vpsId: string, taskId: string) => {
    const deadline = Date.now() + 12000;
    for (;;) {
      const task = await repository.getTask(vpsId, taskId);
      if (task && ["succeeded", "failed", "awaiting_approval", "awaiting_input"].includes(task.state)) return task;
      if (Date.now() > deadline) throw new Error("task did not terminate");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  async function createConnectedProfile(routes: AiRoutesService, repository: Awaited<ReturnType<typeof setup>>["repository"]) {
    const created = await routes.createProvider(request, { name: "ChatGPT", models: ["gpt-5-codex", "gpt-5.1-codex"], authKind: "chatgpt_oauth" });
    expect(created.endpoint).toBe(codexBase);
    expect(created.authKind).toBe("chatgpt_oauth");
    const { authorizeUrl } = await routes.authorizeProviderOauth(request, created.id);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const exchanged = await routes.exchangeProviderOauth(request, created.id, { callbackUrl: `http://localhost:1455/auth/callback?code=code-1&state=${encodeURIComponent(state)}` });
    expect(exchanged.profile.tokenState).toBe("connected");
    expect(exchanged.expiresAt).toBeTruthy();
    // Test-only: dispatch through the loopback stub needs the private-endpoint opt-in.
    const profile = await repository.getProviderProfile(created.id);
    await repository.updateProviderProfile(created.id, { name: profile!.name, endpoint: profile!.endpoint, models: profile!.models, defaultModel: profile!.defaultModel, enabled: true, isDefault: profile!.isDefault, allowPrivateEndpoint: true });
    return created.id;
  }

  it("connects via paste-back OAuth and dispatches a task through the Codex backend", async () => {
    const { repository, server, routes, service } = await setup();
    const providerId = await createConnectedProfile(routes, repository);
    const task = await service.create(request, server.id, { request: "check the host", idempotencyKey: "codex-e2e" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.state, JSON.stringify(outcome.error)).toBe("succeeded");
    expect(outcome.providerId).toBe(providerId);
    expect(outcome.model).toBe("gpt-5-codex");
    expect(codexRequests).toHaveLength(1);
    expect(codexRequests[0]!.authorization).toMatch(/^Bearer access-/);
    expect(codexRequests[0]!.originator).toBe("codex_cli_rs");
    const history = await repository.listConversationHistory(task.conversationId);
    expect(history.messages.at(-1)?.content).toBe("Done via Codex");
    expect(history.messages.at(-1)?.providerId).toBe(providerId);
  });

  it("refreshes an expired access token before dispatch and persists the rotation", async () => {
    const { repository, server, routes, service } = await setup();
    const providerId = await createConnectedProfile(routes, repository);
    const expired = { accessToken: "access-expired", refreshToken: "refresh-old", expiresAt: new Date(Date.now() - 60_000).toISOString(), lastRefreshedAt: new Date(Date.now() - 60_000).toISOString() };
    await repository.updateProviderOauth(providerId, { envelope: encryptAiSecret(JSON.stringify(expired), aiCodexOauthAad(providerId), keyring) });
    const task = await service.create(request, server.id, { request: "again", idempotencyKey: "codex-refresh" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.state, JSON.stringify(outcome.error)).toBe("succeeded");
    expect(codexRequests[0]!.authorization).toMatch(/^Bearer access-/);
    expect(codexRequests[0]!.authorization).not.toContain("access-expired");
  });

  it("fails closed with relogin_required when OpenAI revokes the refresh token", async () => {
    const { repository, server, routes, service } = await setup();
    const providerId = await createConnectedProfile(routes, repository);
    const expired = { accessToken: "access-expired", refreshToken: "refresh-revoked", expiresAt: new Date(Date.now() - 60_000).toISOString(), lastRefreshedAt: new Date(Date.now() - 60_000).toISOString() };
    await repository.updateProviderOauth(providerId, { envelope: encryptAiSecret(JSON.stringify(expired), aiCodexOauthAad(providerId), keyring) });
    tokenResponses.push({ status: 400, body: { error: "invalid_grant" } });
    const task = await service.create(request, server.id, { request: "nope", idempotencyKey: "codex-revoked" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.state).toBe("failed");
    expect(outcome.error?.code).toBe("provider_unavailable");
    expect((await repository.getProviderProfile(providerId))?.tokenState).toBe("relogin_required");
    expect(codexRequests).toHaveLength(0);
  });

  it("rejects apiKey profile creation without an endpoint and OAuth checks reroute through the Codex probe", async () => {
    const { repository, server, routes } = await setup();
    await expect(routes.createProvider(request, { name: "NoEndpoint", models: ["m1"], authKind: "apiKey" })).rejects.toMatchObject({ status: 400 });    const providerId = await createConnectedProfile(routes, repository);
    const profile = await repository.getProviderProfile(providerId);
    await repository.updateProviderProfile(providerId, { name: profile!.name, endpoint: profile!.endpoint, models: profile!.models, defaultModel: profile!.defaultModel, enabled: true, isDefault: profile!.isDefault, allowPrivateEndpoint: true });
    await expect(routes.checkProviderProfile(request, providerId)).resolves.toEqual({ ok: true });
    expect(codexRequests[0]!.body).toMatchObject({ model: "gpt-5-codex" });
    await expect(routes.fetchProviderModels(request, providerId)).rejects.toMatchObject({ status: 400 });
    void server;
  });
});
