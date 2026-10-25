import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { parseAppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository, aiProviderKeyAad } from "../src/persistence/repositories/ai.repository.js";
import { AiPersistenceConflictError } from "../src/persistence/repositories/ai.persistence.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiProviderMigrationService } from "../src/ai/ai-provider-migration.service.js";
import { AiRoutesService, AI_PROVIDER_KEY_CONTEXT } from "../src/ai/ai-routes.service.js";
import { AiProvider } from "../src/ai/ai-provider.js";
import { encryptAiSecret, decryptAiSecret } from "../src/ai/ai-crypto.js";
import { createTestKeyring, saveKeyringToFile, type Keyring } from "../src/ssh/key-encryption.js";
import type { MetricService } from "../src/metrics/metric.service.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import type { AiHostPlanService } from "../src/ai/ai-host-plan.service.js";
import type { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import type { AiReadToolsService } from "../src/ai/ai-read-tools.service.js";

const request = { dashboardSessionId: "admin-session" } as Request;

describe("AI multi-provider", () => {
  let dir: string;
  let keyring: Keyring;
  let keyringFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-multi-provider-"));
    keyring = createTestKeyring("kek_multi_provider");
    keyringFile = join(dir, "keyring.json");
    await saveKeyringToFile(keyringFile, keyring);
  }, 20_000);
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); }, 20_000);

  const baseConfig = () => ({ ...parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "multi-provider-secret-0123456789abcdef" }), ai: { enabled: true, keyringFile, contextWindowTokens: 16000, contextWindowTokensByModel: {}, contextReserveTokens: 2048, contextTailTokens: 1000, maxCumulativeTaskTokens: 1000000 } });
  const envelope = (id: string) => encryptAiSecret(`sk-${id}`, id === "legacy" ? AI_PROVIDER_KEY_CONTEXT : aiProviderKeyAad(id), keyring);

  async function setup() {
    const repository = createJsonAiRepository(join(dir, "ai.json"));
    const vps = createVpsStore(join(dir, "vps.json"));
    const server = await vps.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    const config = baseConfig();
    const policy = new AiPolicyService(config, repository);
    const service = new AiTaskService(repository, config, policy, {} as MetricService, { authenticateById: async () => ({ sessionId: "admin-session" }) } as unknown as DashboardSessionService, {} as DockerMonitoringService, {} as AiHostPlanService, {} as AiDockerBridgeService, {} as DockerMonitoringRepository, {} as AiReadToolsService, vps);
    const routes = new AiRoutesService(config, repository, vps);
    const migration = new AiProviderMigrationService(config, repository);
    return { repository, vps, server, config, policy, service, routes, migration };
  }
  const providerStub = (content = "OK") => {
    const generate = vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => ({ message: { role: "assistant", content }, usage: { inputTokens: 10, outputTokens: 5, estimated: false } }));
    return generate;
  };
  const wait = async (repository: Awaited<ReturnType<typeof setup>>["repository"], vpsId: string, taskId: string) => {
    const deadline = Date.now() + 12000;
    for (;;) {
      const task = await repository.getTask(vpsId, taskId);
      if (task && ["succeeded", "failed", "awaiting_approval", "awaiting_input"].includes(task.state)) return task;
      if (Date.now() > deadline) throw new Error("task did not terminate");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const createProfile = async (repository: Awaited<ReturnType<typeof setup>>["repository"], name: string, models: string[], options: { isDefault?: boolean; enabled?: boolean } = {}) => {
    // The envelope AAD binds the profile id, so the id is fixed up front.
    const id = randomUUID();
    return repository.createProviderProfile({ id, name, endpoint: `https://${name}.example.test/v1`, models, defaultModel: models[0], enabled: options.enabled ?? true, isDefault: options.isDefault ?? false, apiKeyEnvelope: envelope(id) });
  };

  it("migrates the legacy provider slot into the first default profile and stays idempotent", async () => {
    const { repository, migration } = await setup();
    await repository.updateSettings({ patch: { endpoint: "https://legacy.example.test/v1", model: "legacy-model" }, apiKeyEnvelope: envelope("legacy"), expectedRevision: 0 });
    await migration.migrate();
    const view = await repository.getProviderMigrationState();
    expect(view.migratedAt).toBeTruthy();
    expect(view.providers).toHaveLength(1);
    const profile = view.providers[0]!;
    expect(profile.isDefault).toBe(true);
    expect(profile.models).toEqual(["legacy-model"]);
    expect(profile.endpoint).toBe("https://legacy.example.test/v1");
    expect(decryptAiSecret(profile.encryptedApiKey!, aiProviderKeyAad(profile.id), keyring)).toBe("sk-legacy");
    // Rollback safety: the legacy slot is deliberately kept (Q15).
    expect(view.legacy?.model).toBe("legacy-model");
    const before = view.providers[0]!.id;
    await migration.migrate();
    const again = await repository.getProviderMigrationState();
    expect(again.providers).toHaveLength(1);
    expect(again.providers[0]!.id).toBe(before);
  });

  it("defers migration while the keyring is unavailable and retries later", async () => {
    const { repository, config } = await setup();
    const brokenConfig = { ...config, ai: { ...config.ai, keyringFile: join(dir, "missing-keyring.json") } };
    await repository.updateSettings({ patch: { endpoint: "https://legacy.example.test/v1", model: "m" }, apiKeyEnvelope: envelope("legacy"), expectedRevision: 0 });
    const deferred = new AiProviderMigrationService(brokenConfig, repository);
    await deferred.onModuleInit();
    expect((await repository.getProviderMigrationState()).migratedAt).toBeUndefined();
    const healthy = new AiProviderMigrationService(config, repository);
    await healthy.onModuleInit();
    expect((await repository.getProviderMigrationState()).providers).toHaveLength(1);
  });

  it("enforces exactly-one-default, revision bumps and the reference-checked delete", async () => {
    const { repository, server } = await setup();
    const first = await createProfile(repository, "first", ["m1"]);
    expect(first.isDefault).toBe(true);
    const second = await createProfile(repository, "second", ["m2"], { isDefault: true });
    expect((await repository.getProviderProfile(first.id))?.isDefault).toBe(false);
    const updated = await repository.updateProviderProfile(second.id, { name: "second", endpoint: second.endpoint, models: ["m2"], defaultModel: "m2", enabled: true, isDefault: true });
    expect(updated.revision).toBe(second.revision + 1);
    expect(updated.encryptedApiKey).toBeDefined();
    await expect(repository.updateProviderProfile(second.id, { name: "second", endpoint: second.endpoint, models: ["m2"], defaultModel: "m1", enabled: true, isDefault: true })).rejects.toBeInstanceOf(AiPersistenceConflictError);
    const conversation = await repository.createConversation(server.id, "Chat");
    await repository.setConversationProviderSelection(server.id, conversation.id, { providerId: second.id, model: "m2" });
    await expect(repository.deleteProviderProfile(second.id)).rejects.toBeInstanceOf(AiPersistenceConflictError);
    await repository.setConversationProviderSelection(server.id, conversation.id, { providerId: first.id, model: "m1" });
    await repository.createTask({ id: "t-active", vpsId: server.id, conversationId: conversation.id, state: "planning", requestSummary: "x", idempotencyKey: "k1", initiatingSessionId: "s", providerId: second.id, model: "m2" });
    await expect(repository.deleteProviderProfile(second.id)).rejects.toBeInstanceOf(AiPersistenceConflictError);
    expect(await repository.deleteProviderProfile("missing")).toBe(false);
  });

  it("resolves the model per Q16 tiers and records provenance", async () => {
    const { repository, service, server } = await setup();
    const first = await createProfile(repository, "first", ["m1", "m1b"]);
    const second = await createProfile(repository, "second", ["m2"], { isDefault: false });
    providerStub();
    // Tier 4: default profile.
    const task1 = await service.create(request, server.id, { request: "hello", idempotencyKey: "k-default" });
    const outcome1 = await wait(repository, server.id, task1.id);
    expect(outcome1.state).toBe("succeeded");
    expect(outcome1.providerId).toBe(first.id);
    expect(outcome1.model).toBe("m1");
    const messages1 = await repository.listConversationHistory(task1.conversationId);
    expect(messages1.messages.at(-1)?.providerId).toBe(first.id);
    expect(messages1.messages.at(-1)?.model).toBe("m1");
    // Tier 3: last used selection (m1b on the default provider).
    const task2 = await service.create(request, server.id, { request: "again", idempotencyKey: "k-last", providerId: first.id, model: "m1b" });
    await wait(repository, server.id, task2.id);
    // Tier 1: pinned conversation selection wins over last used.
    const task3 = await service.create(request, server.id, { request: "pinned", idempotencyKey: "k-pin", conversationId: task2.conversationId, providerId: second.id, model: "m2" });
    await wait(repository, server.id, task3.id);
    const task4 = await service.create(request, server.id, { request: "follow", idempotencyKey: "k-follow", conversationId: task2.conversationId });
    const outcome4 = await wait(repository, server.id, task4.id);
    expect(outcome4.providerId).toBe(second.id);
    expect(outcome4.model).toBe("m2");
  });

  it("fails closed for explicit or pinned selections that cannot be honored", async () => {
    const { repository, service, server } = await setup();
    const first = await createProfile(repository, "first", ["m1"]);
    providerStub();
    await expect(service.create(request, server.id, { request: "x", idempotencyKey: "k-bad-model", providerId: first.id, model: "missing" })).rejects.toMatchObject({ code: "provider_unavailable" });
    const conversation = await repository.createConversation(server.id, "Chat");
    const second = await createProfile(repository, "second", ["m2"]);
    await repository.setConversationProviderSelection(server.id, conversation.id, { providerId: second.id, model: "m2" });
    await repository.updateProviderProfile(second.id, { name: "second", endpoint: second.endpoint, models: ["m2"], defaultModel: "m2", enabled: false, isDefault: false });
    await expect(service.create(request, server.id, { request: "x", idempotencyKey: "k-disabled", conversationId: conversation.id })).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("isolates dispatch revalidation per provider (Q9)", async () => {
    const { repository, policy, server } = await setup();
    const first = await createProfile(repository, "first", ["m1"]);
    const second = await createProfile(repository, "second", ["m2"], { isDefault: false });
    const conversation = await repository.createConversation(server.id, "Chat");
    await repository.createTask({ id: "t-a", vpsId: server.id, conversationId: conversation.id, state: "planning", requestSummary: "x", idempotencyKey: "ka", initiatingSessionId: "s", providerId: first.id, model: "m1" });
    // Editing provider B must not disturb a dispatch bound to provider A.
    await repository.updateProviderProfile(second.id, { name: "second2", endpoint: second.endpoint, models: ["m2"], defaultModel: "m2", enabled: true, isDefault: false });
    await expect(policy.revalidateForDispatch(server.id, { providerRevision: first.revision, policyRevision: 0, providerId: first.id })).resolves.toBeUndefined();
    // Editing provider A invalidates its own dispatches.
    const bumped = await repository.updateProviderProfile(first.id, { name: "first2", endpoint: first.endpoint, models: ["m1"], defaultModel: "m1", enabled: true, isDefault: true });
    expect(bumped.revision).toBe(first.revision + 1);
    await expect(policy.revalidateForDispatch(server.id, { providerRevision: first.revision, policyRevision: 0, providerId: first.id })).rejects.toMatchObject({ code: "provider_revision_changed" });
  });

  it("serves provider routes and freezes legacy settings after migration", async () => {
    const { repository, routes, migration } = await setup();
    await repository.updateSettings({ patch: { endpoint: "https://legacy.example.test/v1", model: "legacy-model" }, apiKeyEnvelope: envelope("legacy"), expectedRevision: 0 });
    await migration.migrate();
    const listed = await routes.providers(request);
    expect(listed.migrated).toBe(true);
    expect(listed.providers).toHaveLength(1);
    expect(listed.providers[0]).toMatchObject({ name: "Default", hasApiKey: true, isDefault: true });
    const derived = await routes.settings(request);
    expect(derived).toMatchObject({ endpoint: "https://legacy.example.test/v1", model: "legacy-model", hasApiKey: true });
    await expect(routes.updateSettings(request, { endpoint: "https://other.example.test", model: "m" })).rejects.toBeInstanceOf(ConflictException);
    const check = vi.spyOn(AiProvider.prototype, "check").mockResolvedValue({ ok: true } as never);
    await expect(routes.checkProvider(request)).resolves.toEqual({ ok: true });
    expect(check).toHaveBeenCalledTimes(1);
    const created = await routes.createProvider(request, { name: "new", endpoint: "https://new.example.test/v1", apiKey: "sk-new", models: ["n1", "n2"], defaultModel: "n2" });
    expect(created).toMatchObject({ name: "new", defaultModel: "n2", hasApiKey: true, isDefault: false });
    const updated = await routes.updateProvider(request, created.id, { name: "new2", endpoint: created.endpoint, models: ["n1"], defaultModel: "n1", enabled: false });
    expect(updated).toMatchObject({ name: "new2", enabled: false, hasApiKey: true, revision: created.revision + 1 });
    expect(await routes.deleteProvider(request, created.id)).toEqual({ ok: true });
    await expect(routes.deleteProvider(request, created.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
