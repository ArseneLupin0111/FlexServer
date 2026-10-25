// Offline tests for the Codex OAuth client (slice 2 of
// docs/ai-chatgpt-oauth-provider-plan.md): a local stub server imitates
// {authBaseUrl}/oauth/token and a tmpdir keyring backs the AI envelopes.
// No real OpenAI endpoint is contacted.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonAiRepository, aiCodexOauthAad } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import { AiCryptoUnavailableError, decryptAiSecret, encryptAiSecret } from "../src/ai/ai-crypto.js";
import { ProviderRateLimitError, ProviderTransportError } from "../src/ai/ai-provider.js";
import {
  AiCodexOauthService,
  CODEX_OAUTH_REDIRECT_URI,
  CodexOauthReloginRequiredError,
  CodexOauthStateError,
  type CodexOauthTokens,
} from "../src/ai/ai-codex-oauth.service.js";
import { createTestKeyring, saveKeyringToFile, type Keyring } from "../src/ssh/key-encryption.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

type StubRequest = { path: string; body: string; contentType: string | undefined };
type StubOutcome = { status: number; payload: unknown; delayMs?: number; headers?: Record<string, string> };

async function stubTokenEndpoint(handler: (captured: StubRequest) => StubOutcome): Promise<{ requests: StubRequest[]; baseUrl: string }> {
  const requests: StubRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const captured: StubRequest = { path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8"), contentType: request.headers["content-type"] };
      requests.push(captured);
      const outcome = handler(captured);
      const respond = () => {
        response.writeHead(outcome.status, { "Content-Type": "application/json", ...outcome.headers });
        response.end(JSON.stringify(outcome.payload));
      };
      if (outcome.delayMs) setTimeout(respond, outcome.delayMs);
      else respond();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  return { requests, baseUrl: `http://127.0.0.1:${address.port}` };
}

const idToken = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;
const tokenResponse = (overrides: Record<string, unknown> = {}) => ({ access_token: "at-new", refresh_token: "rt-new", expires_in: 18000, ...overrides });
const nearExpiryTokens = (accessToken: string, refreshToken: string): CodexOauthTokens => ({
  accessToken,
  refreshToken,
  accountId: "acct-1",
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  lastRefreshedAt: new Date(Date.now() - 3_600_000).toISOString(),
});

describe("AI Codex OAuth service", () => {
  let dir: string;
  let keyring: Keyring;
  let keyringFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-codex-oauth-"));
    keyring = createTestKeyring("kek_codex_oauth");
    keyringFile = join(dir, "keyring.json");
    await saveKeyringToFile(keyringFile, keyring);
  }, 20_000);
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); }, 20_000);

  const makeRepository = (): AiRepository => createJsonAiRepository(join(dir, "ai.json"));
  const makeService = (repository: AiRepository, authBaseUrl: string, overrides: { clientId?: string; pendingTtlMs?: number; keyringFile?: string } = {}) =>
    new AiCodexOauthService(
      {
        clientId: overrides.clientId ?? "app_test_client",
        authBaseUrl,
        apiBaseUrl: "http://127.0.0.1:9/backend-api/codex",
        cliVersion: "0.0.0-test",
        ...(overrides.pendingTtlMs !== undefined ? { pendingTtlMs: overrides.pendingTtlMs } : {}),
      },
      repository,
      overrides.keyringFile ?? keyringFile,
    );
  const createOauthProfile = async (repository: AiRepository, id: string) =>
    repository.createProviderProfile({ id, name: "codex", endpoint: "https://chatgpt.com/backend-api/codex", models: ["gpt-5-codex"], enabled: true, isDefault: false, authKind: "chatgpt_oauth" });
  const seedTokens = async (repository: AiRepository, id: string, tokens: CodexOauthTokens) => {
    await repository.updateProviderOauth(id, { envelope: encryptAiSecret(JSON.stringify(tokens), aiCodexOauthAad(id), keyring), tokenState: "connected" });
  };
  const storedTokens = async (repository: AiRepository, id: string): Promise<CodexOauthTokens> => {
    const profile = await repository.getProviderProfile(id);
    return JSON.parse(decryptAiSecret(profile!.encryptedOauth!, aiCodexOauthAad(id), keyring)) as CodexOauthTokens;
  };
  const pastedCallback = (state: string, code = "the-code") => `http://localhost:1455/auth/callback?code=${code}&state=${state}`;

  it("completes the paste-back exchange: authorize URL carries the S256 challenge and state, the verifier is sent, and the envelope is persisted revision-neutral", async () => {
    const repository = makeRepository();
    const id = "oauth-exchange";
    await createOauthProfile(repository, id);
    const stub = await stubTokenEndpoint(() => ({ status: 200, payload: { access_token: "at-1", refresh_token: "rt-1", id_token: idToken("acct-42"), expires_in: 18000 } }));
    const service = makeService(repository, stub.baseUrl);

    const { authorizeUrl } = service.beginAuthorize(id);
    const authorize = new URL(authorizeUrl);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${stub.baseUrl}/authorize`);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("client_id")).toBe("app_test_client");
    expect(authorize.searchParams.get("redirect_uri")).toBe(CODEX_OAUTH_REDIRECT_URI);
    expect(authorize.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = authorize.searchParams.get("code_challenge")!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = authorize.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const before = await repository.getProviderProfile(id);
    const tokens = await service.exchangeCallback(id, pastedCallback(state));
    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.accountId).toBe("acct-42");
    expect(Date.parse(tokens.expiresAt)).toBeGreaterThan(Date.now() + 17 * 60_000);
    expect(Math.abs(Date.parse(tokens.lastRefreshedAt) - Date.now())).toBeLessThan(10_000);

    // PKCE: the code_verifier sent to the token endpoint hashes to the challenge published in the authorize URL.
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.path).toBe("/oauth/token");
    expect(stub.requests[0]!.contentType).toContain("application/x-www-form-urlencoded");
    const sent = new URLSearchParams(stub.requests[0]!.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("the-code");
    expect(sent.get("client_id")).toBe("app_test_client");
    expect(sent.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(createHash("sha256").update(sent.get("code_verifier")!, "ascii").digest().toString("base64url")).toBe(challenge);

    // Persisted once, decryptable under the dedicated OAuth AAD, revision-neutral.
    const profile = await repository.getProviderProfile(id);
    expect(profile?.tokenState).toBe("connected");
    expect(profile?.revision).toBe(before?.revision);
    expect(await storedTokens(repository, id)).toEqual({ accessToken: "at-1", refreshToken: "rt-1", accountId: "acct-42", expiresAt: tokens.expiresAt, lastRefreshedAt: tokens.lastRefreshedAt });

    // The pasted URL is single-use: a replay is rejected without another token call.
    await expect(service.exchangeCallback(id, pastedCallback(state))).rejects.toBeInstanceOf(CodexOauthStateError);
    expect(stub.requests).toHaveLength(1);

    await expect(service.tokenStatus(id)).resolves.toEqual({ connected: true, expiresAt: tokens.expiresAt, lastRefreshedAt: tokens.lastRefreshedAt, reloginRequired: false });
  });

  it("rejects unknown, wrong and consumed states without touching the token endpoint", async () => {
    const repository = makeRepository();
    const id = "oauth-states";
    await createOauthProfile(repository, id);
    const stub = await stubTokenEndpoint(() => ({ status: 200, payload: tokenResponse() }));
    const service = makeService(repository, stub.baseUrl);

    // Unknown: no pending authorization exists for this provider.
    await expect(service.exchangeCallback(id, pastedCallback("never-started"))).rejects.toBeInstanceOf(CodexOauthStateError);
    // Wrong state on a pending authorization.
    const { authorizeUrl } = service.beginAuthorize(id);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await expect(service.exchangeCallback(id, pastedCallback("tampered"))).rejects.toBeInstanceOf(CodexOauthStateError);
    // Consumed: a completed exchange invalidates its pending entry.
    expect((await service.exchangeCallback(id, pastedCallback(state))).accessToken).toBe("at-new");
    await expect(service.exchangeCallback(id, pastedCallback(state))).rejects.toBeInstanceOf(CodexOauthStateError);
    // Malformed and foreign-origin pasted URLs.
    await expect(service.exchangeCallback(id, "not a url")).rejects.toBeInstanceOf(CodexOauthStateError);
    await expect(service.exchangeCallback(id, "https://evil.example.test/auth/callback?code=c&state=s")).rejects.toBeInstanceOf(CodexOauthStateError);

    expect(stub.requests).toHaveLength(1);
    const profile = await repository.getProviderProfile(id);
    expect(profile?.tokenState).toBe("connected");
  });

  it("rejects a paste-back after the pending authorize TTL expires", async () => {
    const repository = makeRepository();
    const id = "oauth-ttl";
    await createOauthProfile(repository, id);
    const stub = await stubTokenEndpoint(() => ({ status: 200, payload: tokenResponse() }));
    const service = makeService(repository, stub.baseUrl, { pendingTtlMs: 30 });
    const { authorizeUrl } = service.beginAuthorize(id);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(service.exchangeCallback(id, pastedCallback(state))).rejects.toThrow(/expired/);
    expect(stub.requests).toHaveLength(0);
    const profile = await repository.getProviderProfile(id);
    expect(profile?.tokenState).toBeUndefined();
  });

  it("returns the cached access token while more than 60s of life remains, without any network call", async () => {
    const repository = makeRepository();
    const id = "oauth-cached";
    await createOauthProfile(repository, id);
    await seedTokens(repository, id, { ...nearExpiryTokens("at-old", "rt-old"), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const stub = await stubTokenEndpoint(() => ({ status: 200, payload: tokenResponse() }));
    const service = makeService(repository, stub.baseUrl);
    await expect(service.getValidAccessToken(id)).resolves.toBe("at-old");
    expect(stub.requests).toHaveLength(0);
  });

  it("refreshes proactively near expiry, persists the rotated envelope before use and never bumps the revision", async () => {
    const repository = makeRepository();
    const id = "oauth-refresh";
    await createOauthProfile(repository, id);
    await seedTokens(repository, id, nearExpiryTokens("at-old", "rt-old"));
    const before = await repository.getProviderProfile(id);
    const stub = await stubTokenEndpoint(() => ({ status: 200, payload: { access_token: "at-new", refresh_token: "rt-new", expires_in: 18000 } }));
    const service = makeService(repository, stub.baseUrl);

    await expect(service.getValidAccessToken(id)).resolves.toBe("at-new");
    expect(stub.requests).toHaveLength(1);
    const sent = new URLSearchParams(stub.requests[0]!.body);
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("rt-old");
    expect(sent.get("client_id")).toBe("app_test_client");

    const profile = await repository.getProviderProfile(id);
    expect(profile?.tokenState).toBe("connected");
    expect(profile?.revision).toBe(before?.revision);
    const stored = await storedTokens(repository, id);
    expect(stored.accessToken).toBe("at-new");
    expect(stored.refreshToken).toBe("rt-new");
    expect(stored.accountId).toBe("acct-1");
    expect(Date.parse(stored.expiresAt)).toBeGreaterThan(Date.now() + 17 * 60_000);
  });

  it("coalesces concurrent refreshes into a single token-endpoint call", async () => {
    const repository = makeRepository();
    const id = "oauth-single-flight";
    await createOauthProfile(repository, id);
    await seedTokens(repository, id, nearExpiryTokens("at-old", "rt-old"));
    let rotated = 0;
    const stub = await stubTokenEndpoint(() => {
      rotated += 1;
      return { status: 200, payload: { access_token: `at-new-${rotated}`, refresh_token: `rt-new-${rotated}`, expires_in: 18000 }, delayMs: 40 };
    });
    const service = makeService(repository, stub.baseUrl);

    const [first, second, third] = await Promise.all([service.getValidAccessToken(id), service.getValidAccessToken(id), service.getValidAccessToken(id)]);
    expect(first).toBe("at-new-1");
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(stub.requests).toHaveLength(1);
    expect((await storedTokens(repository, id)).refreshToken).toBe("rt-new-1");
  });

  it.each([
    { name: "HTTP 400 with invalid_grant", status: 400, payload: { error: "invalid_grant", error_description: "refresh token expired" } },
    { name: "HTTP 401 with another error body", status: 401, payload: { error: "expired_token" } },
  ])("persists relogin_required and fails closed on a rejected refresh ($name)", async ({ status, payload }) => {
    const repository = makeRepository();
    const id = "oauth-relogin";
    await createOauthProfile(repository, id);
    const original = nearExpiryTokens("at-old", "rt-old");
    await seedTokens(repository, id, original);
    const stub = await stubTokenEndpoint(() => ({ status, payload }));
    const service = makeService(repository, stub.baseUrl);

    await expect(service.getValidAccessToken(id)).rejects.toBeInstanceOf(CodexOauthReloginRequiredError);
    const profile = await repository.getProviderProfile(id);
    expect(profile?.tokenState).toBe("relogin_required");
    // Nothing is deleted: the envelope survives untouched.
    expect(JSON.parse(decryptAiSecret(profile!.encryptedOauth!, aiCodexOauthAad(id), keyring))).toEqual(original);
    await expect(service.tokenStatus(id)).resolves.toEqual({ connected: false, reloginRequired: true });
    // Fail closed: further calls never reach the network.
    await expect(service.getValidAccessToken(id)).rejects.toBeInstanceOf(CodexOauthReloginRequiredError);
    expect(stub.requests).toHaveLength(1);
  });

  it("maps an HTTP 429 refresh rejection to the rate-limit error without flipping token state", async () => {
    const repository = makeRepository();
    const id = "oauth-429";
    await createOauthProfile(repository, id);
    await seedTokens(repository, id, nearExpiryTokens("at-old", "rt-old"));
    const stub = await stubTokenEndpoint(() => ({ status: 429, payload: { error: "rate_limit_exceeded" } }));
    const service = makeService(repository, stub.baseUrl);
    await expect(service.getValidAccessToken(id)).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect((await repository.getProviderProfile(id))?.tokenState).toBe("connected");
    expect(stub.requests).toHaveLength(1);
  });

  it("does not follow redirects from the token endpoint", async () => {
    const repository = makeRepository();
    const id = "oauth-redirect";
    await createOauthProfile(repository, id);
    await seedTokens(repository, id, nearExpiryTokens("at-old", "rt-old"));
    const stub = await stubTokenEndpoint(() => ({ status: 302, payload: {}, headers: { Location: "http://169.254.169.254/" } }));
    const service = makeService(repository, stub.baseUrl);
    await expect(service.getValidAccessToken(id)).rejects.toBeInstanceOf(ProviderTransportError);
    expect(stub.requests).toHaveLength(1);
  });

  it("propagates AiCryptoUnavailableError without corrupting state when the keyring is missing", async () => {
    const repository = makeRepository();
    const id = "oauth-keyring";
    await createOauthProfile(repository, id);
    await seedTokens(repository, id, nearExpiryTokens("at-old", "rt-old"));
    const missingKeyring = join(dir, "absent-keyring.json");
    const stub = await stubTokenEndpoint(() => ({ status: 200, payload: tokenResponse() }));

    // Refresh path: fails before any network call, stored state untouched.
    const service = makeService(repository, stub.baseUrl, { keyringFile: missingKeyring });
    await expect(service.getValidAccessToken(id)).rejects.toBeInstanceOf(AiCryptoUnavailableError);
    expect(stub.requests).toHaveLength(0);
    const profile = await repository.getProviderProfile(id);
    expect(profile?.tokenState).toBe("connected");
    expect(profile?.encryptedOauth).toBeDefined();

    // Exchange path: the code is exchanged, but persistence fails closed.
    const repository2 = makeRepository();
    const id2 = "oauth-keyring-exchange";
    await createOauthProfile(repository2, id2);
    const service2 = makeService(repository2, stub.baseUrl, { keyringFile: missingKeyring });
    const { authorizeUrl } = service2.beginAuthorize(id2);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await expect(service2.exchangeCallback(id2, pastedCallback(state))).rejects.toBeInstanceOf(AiCryptoUnavailableError);
    expect(stub.requests).toHaveLength(1);
    const untouched = await repository2.getProviderProfile(id2);
    expect(untouched?.encryptedOauth).toBeUndefined();
    expect(untouched?.tokenState).toBeUndefined();
  });

  it("maps a token-endpoint server failure during exchange to provider_unavailable without marking relogin", async () => {
    const repository = makeRepository();
    const id = "oauth-server-error";
    await createOauthProfile(repository, id);
    const stub = await stubTokenEndpoint(() => ({ status: 500, payload: { error: "server_error" } }));
    const service = makeService(repository, stub.baseUrl);
    const { authorizeUrl } = service.beginAuthorize(id);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await expect(service.exchangeCallback(id, pastedCallback(state))).rejects.toBeInstanceOf(ProviderTransportError);
    const profile = await repository.getProviderProfile(id);
    expect(profile?.tokenState).toBeUndefined();
    expect(profile?.encryptedOauth).toBeUndefined();
    await expect(service.tokenStatus("missing-provider")).resolves.toEqual({ connected: false, reloginRequired: false });
  });
});
