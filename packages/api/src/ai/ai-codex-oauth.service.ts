// ── AiCodexOauthService: Codex (ChatGPT) OAuth client, slice 2 of docs/ai-chatgpt-oauth-provider-plan.md ──
//
// Paste-back login (Q2): the admin opens the authorize URL in a browser, the
// IdP lands on http://localhost:1455/auth/callback?... (connection error is
// expected — no listener, no opened ports) and the admin pastes that URL back.
// PKCE verifier/state pairs live in memory only (challenge → verifier,
// single-use, 15-minute TTL) — never persisted.
//
// Tokens (Q3): one AI keyring envelope per provider under the dedicated AAD
// field "codexOauthToken" (aiCodexOauthAad), separate from API-key envelopes.
// The token object is stored as JSON via encryptAiSecret.
//
// Refresh (Q7): proactive when <60s of access-token life remains, single-flight
// per provider in-process, rotated tokens are encrypted and persisted BEFORE
// first use. `invalid_grant` (HTTP 400/401 or matching error body) flips the
// profile to tokenState "relogin_required" and every dispatch fails closed —
// nothing is deleted.
//
// Redaction: token values never appear in logs or error messages; error text
// carries no response-body fragments and token endpoints never echo secrets.

import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { z } from "zod";
import { decryptAiSecret, encryptAiSecret, loadAiKeyring, type AiEnvelopeData } from "./ai-crypto.js";
import { ProviderKeyRequiredError, ProviderProtocolError, ProviderRateLimitError, ProviderTransportError } from "./ai-provider.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import { aiCodexOauthAad } from "../persistence/repositories/ai.repository.js";

export type CodexOauthTokens = { accessToken: string; refreshToken: string; accountId?: string; expiresAt: string; lastRefreshedAt: string };

export type CodexOauthTokenStatus = { connected: boolean; expiresAt?: string; lastRefreshedAt?: string; reloginRequired: boolean };

export type AiCodexOauthOptions = {
  clientId: string;
  authBaseUrl: string;
  apiBaseUrl: string;
  cliVersion: string;
  /** Pending authorize TTL; defaults to 15 minutes, shortened by tests. */
  pendingTtlMs?: number;
};

/** Refresh goes out when the access token has less than this much life left. */
const PROACTIVE_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_PENDING_TTL_MS = 15 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const TOKEN_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Fixed native-app redirect target the admin pastes back (plan Q2). */
export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_OAUTH_SCOPE = "openid profile email offline_access";

/** Re-login required: the authorization server rejected the refresh grant
 * (invalid_grant). The profile flips to "relogin_required" and every dispatch
 * fails closed until the operator completes a fresh login (plan Q7). */
export class CodexOauthReloginRequiredError extends Error {
  readonly code = "codex_oauth_relogin_required" as const;
  constructor(message = "Codex OAuth login expired; re-authorization required") {
    super(message);
    this.name = "CodexOauthReloginRequiredError";
  }
}

/** Paste-back state machine failures: no pending authorize, wrong/unknown/
 * consumed state, expired pending TTL, or a pasted URL that is not the
 * registered redirect target. Never carries token material. */
export class CodexOauthStateError extends Error {
  readonly code = "codex_oauth_state_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "CodexOauthStateError";
  }
}

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(8192),
    refresh_token: z.string().min(1).max(8192).optional(),
    id_token: z.string().min(1).max(65536).optional(),
    expires_in: z.number().int().positive().max(2_592_000),
  })
  .passthrough();
type TokenResponse = z.infer<typeof tokenResponseSchema>;

const storedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accountId: z.string().min(1).optional(),
  expiresAt: z.string().min(1),
  lastRefreshedAt: z.string().min(1),
});

/** `sub` claim from the id_token payload (base64url JSON, middle segment).
 * Signature verification is deliberately out of scope: the token arrived over
 * TLS directly from the pinned authorization server. Unparseable → undefined. */
function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const segments = idToken.split(".");
  if (segments.length !== 3 || !segments[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const sub = (payload as Record<string, unknown>)["sub"];
    return typeof sub === "string" && sub.length > 0 ? sub : undefined;
  } catch {
    return undefined;
  }
}

function tokensFromResponse(previous: CodexOauthTokens | undefined, response: TokenResponse, now: number): CodexOauthTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previous?.refreshToken ?? "",
    accountId: accountIdFromIdToken(response.id_token) ?? previous?.accountId,
    expiresAt: new Date(now + response.expires_in * 1000).toISOString(),
    lastRefreshedAt: new Date(now).toISOString(),
  };
}

/** Strict URL validation for the token endpoint (egress discipline): https or
 * http only, no credentials in the URL, no query/hash, and — because node:http
 * never follows redirects — a 3xx surfaces as a classified error instead of a
 * silent hop to another host. */
function assertTokenUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderTransportError();
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderTransportError();
  }
  return url;
}

/** POST x-www-form-urlencoded with no redirect following, a 30s timeout and a
 * bounded 1 MiB response. Rejects with ProviderTransportError on any transport
 * failure; returns the raw status + body so callers classify (the body is only
 * inspected for error classification, never echoed). */
function postForm(rawUrl: string, params: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = assertTokenUrl(rawUrl);
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST",
      agent: false,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        Accept: "application/json",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > TOKEN_MAX_RESPONSE_BYTES) {
          reject(new ProviderProtocolError());
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => reject(new ProviderTransportError()));
      response.on("aborted", () => reject(new ProviderTransportError()));
    });
    request.on("error", () => reject(new ProviderTransportError()));
    request.end(body);
  });
}

type PendingAuthorize = { verifier: string; state: string; expiresAt: number };

export class AiCodexOauthService {
  private readonly options: AiCodexOauthOptions;
  private readonly pendingTtlMs: number;
  /** PKCE verifier + state per provider, in memory only (plan Q2). */
  private readonly pending = new Map<string, PendingAuthorize>();
  /** Single-flight refresh per provider (plan Q7). */
  private readonly inFlightRefresh = new Map<string, Promise<string>>();

  constructor(options: AiCodexOauthOptions, private readonly repository: AiRepository, private readonly keyringFile: string) {
    if (typeof options.clientId !== "string" || !options.clientId) throw new CodexOauthStateError("clientId is required");
    if (typeof options.authBaseUrl !== "string" || !options.authBaseUrl) throw new CodexOauthStateError("authBaseUrl is required");
    const ttl = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new CodexOauthStateError("pendingTtlMs must be a positive number of milliseconds");
    this.options = { ...options };
    this.pendingTtlMs = ttl;
  }

  /** Build the S256 authorize URL and hold the verifier + state in memory,
   * keyed by provider, single-use, TTL-bounded. Purely in-memory: profile
   * validation is the routes service' job (slice 4). */
  beginAuthorize(providerId: string): { authorizeUrl: string } {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest().toString("base64url");
    const state = randomBytes(32).toString("base64url");
    this.pending.set(providerId, { verifier, state, expiresAt: Date.now() + this.pendingTtlMs });
    const query = new URLSearchParams({
      response_type: "code",
      client_id: this.options.clientId,
      redirect_uri: CODEX_OAUTH_REDIRECT_URI,
      scope: CODEX_OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    return { authorizeUrl: `${this.authBaseUrlRoot()}/authorize?${query.toString()}` };
  }

  /** Validate the pasted callback URL (single-use state, TTL), exchange the
   * code at the token endpoint and persist the encrypted envelope BEFORE
   * returning the tokens. A consumed/expired/wrong state rejects without any
   * network call; a failed token exchange consumes the pending entry (the
   * authorization code is single-use) without touching the stored profile. */
  async exchangeCallback(providerId: string, pastedUrl: string): Promise<CodexOauthTokens> {
    const pending = this.pending.get(providerId);
    if (!pending) throw new CodexOauthStateError("no pending Codex authorization for this provider");
    let callback: URL;
    try {
      callback = new URL(pastedUrl);
    } catch {
      throw new CodexOauthStateError("pasted callback URL is not a valid URL");
    }
    if (`${callback.origin}${callback.pathname}` !== CODEX_OAUTH_REDIRECT_URI) {
      throw new CodexOauthStateError("pasted callback URL does not match the registered redirect target");
    }
    const state = callback.searchParams.get("state");
    const code = callback.searchParams.get("code");
    if (!state || !code) throw new CodexOauthStateError("pasted callback URL is missing the code/state parameters");
    if (state !== pending.state) throw new CodexOauthStateError("state mismatch; the pasted URL does not belong to this authorization");
    if (Date.now() > pending.expiresAt) {
      this.pending.delete(providerId);
      throw new CodexOauthStateError("pending authorization expired; start the login again");
    }
    // Strictly single-use from here: one exchange attempt per authorize.
    this.pending.delete(providerId);
    const response = await postForm(this.tokenUrl(), {
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      client_id: this.options.clientId,
      redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    });
    if (response.status === 429) throw new ProviderRateLimitError();
    if (response.status !== 200) throw new ProviderTransportError();
    const parsed = parseTokenResponse(response.body);
    if (!parsed.refresh_token) throw new ProviderProtocolError("authorization response did not include a refresh token");
    const tokens = tokensFromResponse(undefined, parsed, Date.now());
    await this.persistTokens(providerId, tokens);
    return tokens;
  }

  /** Cached access token while >60s of life remains; otherwise a single-flight
   * rotating refresh whose new envelope is persisted before the token is
   * returned. `relogin_required` profiles fail closed without any network
   * call; rejected refresh grants persist "relogin_required" before throwing. */
  async getValidAccessToken(providerId: string): Promise<string> {
    const profile = await this.repository.getProviderProfile(providerId);
    if (!profile) throw new ProviderKeyRequiredError();
    if (profile.tokenState === "relogin_required") throw new CodexOauthReloginRequiredError();
    if (!profile.encryptedOauth) throw new ProviderKeyRequiredError();
    const tokens = await this.decryptTokens(providerId, profile.encryptedOauth);
    const expiresAt = Date.parse(tokens.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > Date.now() + PROACTIVE_REFRESH_MARGIN_MS) return tokens.accessToken;
    const inFlight = this.inFlightRefresh.get(providerId);
    if (inFlight) return inFlight;
    const flight = this.refreshTokens(providerId, tokens).finally(() => {
      this.inFlightRefresh.delete(providerId);
    });
    this.inFlightRefresh.set(providerId, flight);
    return flight;
  }

  async tokenStatus(providerId: string): Promise<CodexOauthTokenStatus> {
    const profile = await this.repository.getProviderProfile(providerId);
    if (!profile || !profile.encryptedOauth || profile.tokenState !== "connected") {
      return { connected: false, reloginRequired: profile?.tokenState === "relogin_required" };
    }
    const tokens = await this.decryptTokens(providerId, profile.encryptedOauth);
    return { connected: true, expiresAt: tokens.expiresAt, lastRefreshedAt: tokens.lastRefreshedAt, reloginRequired: false };
  }

  private async refreshTokens(providerId: string, previous: CodexOauthTokens): Promise<string> {
    const response = await postForm(this.tokenUrl(), {
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
      client_id: this.options.clientId,
    });
    // Rejected grant (HTTP 400/401, or any non-200 body naming invalid_grant):
    // persist the closed state BEFORE throwing — nothing is deleted (plan Q7).
    if (response.status === 400 || response.status === 401 || (response.status !== 200 && response.body.toLowerCase().includes("invalid_grant"))) {
      await this.repository.updateProviderOauth(providerId, { tokenState: "relogin_required" });
      throw new CodexOauthReloginRequiredError();
    }
    if (response.status === 429) throw new ProviderRateLimitError();
    if (response.status !== 200) throw new ProviderTransportError();
    const parsed = parseTokenResponse(response.body);
    // The refresh grant rotates the refresh token; if the response omits it,
    // keep the previous one rather than dropping the stored credential.
    const tokens = tokensFromResponse(previous, parsed, Date.now());
    await this.persistTokens(providerId, tokens);
    return tokens.accessToken;
  }

  private async persistTokens(providerId: string, tokens: CodexOauthTokens): Promise<void> {
    const keyring = await loadAiKeyring(this.keyringFile);
    const envelope = encryptAiSecret(JSON.stringify(tokens), aiCodexOauthAad(providerId), keyring);
    const updated = await this.repository.updateProviderOauth(providerId, { envelope, tokenState: "connected" });
    if (!updated) throw new CodexOauthStateError("provider profile is missing");
  }

  private async decryptTokens(providerId: string, envelope: AiEnvelopeData): Promise<CodexOauthTokens> {
    const keyring = await loadAiKeyring(this.keyringFile);
    const raw = decryptAiSecret(envelope, aiCodexOauthAad(providerId), keyring);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new ProviderProtocolError("stored OAuth token envelope is not valid JSON");
    }
    const parsed = storedTokensSchema.safeParse(decoded);
    if (!parsed.success) throw new ProviderProtocolError("stored OAuth token envelope has an unexpected shape");
    return parsed.data;
  }

  private tokenUrl(): string {
    return `${this.authBaseUrlRoot()}/oauth/token`;
  }

  private authBaseUrlRoot(): string {
    try {
      const url = new URL(this.options.authBaseUrl);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid base URL");
      return url.toString().replace(/\/+$/, "");
    } catch {
      throw new ProviderTransportError("invalid Codex auth base URL");
    }
  }
}

/** Status bodies are only inspected for classification, never echoed. */
function parseTokenResponse(body: string): TokenResponse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new ProviderProtocolError("token endpoint returned a non-JSON body");
  }
  const parsed = tokenResponseSchema.safeParse(decoded);
  if (!parsed.success) throw new ProviderProtocolError("token endpoint response has an unexpected shape");
  return parsed.data;
}
