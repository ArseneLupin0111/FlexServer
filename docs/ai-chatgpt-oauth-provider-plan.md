# AI Assistant: ChatGPT/OpenAI OAuth provider (Codex subscription quota)

Status: implemented and verified offline (2026-10-25) on branch `feat/ai-chatgpt-oauth` (stacked on `feat/ai-multi-provider`). Stacks on the multi-provider branch `feat/ai-multi-provider` ([plan](ai-multi-provider-plan.md)).

## Risk disclosure (non-negotiable)

Using ChatGPT Plus/Pro subscription quota through a non-official client **violates OpenAI's Terms of Service and can get the account suspended**. The UI must show an explicit, per-profile acknowledgment before the first activation, and this risk stays documented here and in `docs/security.md`. All credentials belong to the operator's own account.

## Problem and acceptance

The assistant supports API-key provider profiles only. Acceptance: an admin can add a provider profile of kind "ChatGPT (OAuth)", complete a paste-back OAuth login with their ChatGPT account, and the assistant then dispatches its existing tool-calling pipeline through OpenAI's Codex backend using subscription quota — with token lifecycle (5-hour access tokens, single-use refresh rotation) handled safely, and every failure mode mapped to the existing error vocabulary.

## Settled decisions (Q1–Q10)

1. Native implementation inside vps-manager (no external 9router process required; pointing a normal profile at a self-run 9router remains possible and unchanged).
2. Paste-back login: the modal shows the authorize URL; after login the browser lands on `http://localhost:1455/auth/callback?...` (connection error is expected); the operator pastes that full URL back. No listener, no opened ports.
3. Access + refresh tokens live in the existing AI keyring as one envelope per provider under a dedicated AAD (`field: "codexOauthToken"`, version 1) — separate from API-key envelopes.
4. Full bidirectional translator Chat Completions ↔ Responses API (messages, tools, tool_calls, tool results, usage) inside the provider layer; tool-calling must work end to end.
5. Model list defaults to the Codex set (`gpt-5-codex`, `gpt-5.1-codex`), admin-editable in the profile; no `/v1/models` fetch for this kind.
6. Token status visible per profile; mandatory ToS-acknowledgment gate before first activation.
7. Refresh: single-flight per provider in-process; rotated tokens are encrypted and persisted **before** first use; proactive refresh when <60 s of access-token life remains; `invalid_grant` flips the profile to `relogin_required` and every dispatch fails closed — nothing is deleted.
8. Rate limiting maps to the existing `provider_rate_limit` error (HTTP 429 / rate-limit headers); no quota dashboard this iteration.
9. No multi-account pooling: one OAuth login = one independent profile; no round-robin.
10. UI flow: ToS banner + checkbox → "Open authorize URL" button → paste-back field → token status row (expiry, last refresh, re-login action).

## Protocol constants (verified 2026-10-25 against public Codex CLI registrations)

```text
client_id      app_EMoamEEZ73f0CkXaXp7hrann   (public client, no secret)
issuer         https://auth.openai.com
authorize      {issuer}/authorize?response_type=code&redirect_uri=http://localhost:1455/auth/callback
               &scope=openid profile email offline_access&code_challenge=S256(...)&state=...
token          {issuer}/oauth/token           (grant_type=authorization_code | refresh_token; refresh rotates)
api            https://chatgpt.com/backend-api/codex/responses
headers        originator: codex_cli_rs · codex CLI version · session id; Bearer access token
```

All four are env-overridable (`APP_AI_CODEX_CLIENT_ID`, `APP_AI_CODEX_AUTH_BASE_URL`, `APP_AI_CODEX_API_BASE_URL`, `APP_AI_CODEX_CLI_VERSION`) so OpenAI-side changes do not need a code release; defaults ship in code.

## New shapes

```ts
type AiProviderAuthKind = "apiKey" | "chatgpt_oauth";
// AiProviderProfileInternal gains: authKind (default "apiKey") and, for
// chatgpt_oauth profiles, encryptedOauth?: AiEnvelopeData // { accessToken, refreshToken, accountId, expiresAt, lastRefreshedAt }
// plus public tokenState: "connected" | "relogin_required".
// PKCE verifier/state pairs are held in-memory in the routes service
// (challenge → verifier, single-use, TTL 15 min) — never persisted.
```

Routes: `POST /api/ai/providers/:id/oauth/authorize` (creates the authorize URL for a saved OAuth profile), `POST /api/ai/providers/:id/oauth/exchange` (accepts the pasted callback URL, validates state, exchanges code at the token endpoint, stores the envelope), refresh logic in a small `AiCodexOauthService`.

## Invariants

- Egress discipline: token and responses calls go through the same URL/DNS/BlockList policy as every provider call; only the pinned public hosts are used by default, and env overrides land inside the same guard. Tokens never appear in logs, projections, or errors (existing redaction path).
- Keyring: rotation/rewrap enumerates OAuth envelopes beside API-key envelopes; the writer-lock/refusal rules for active tasks stay unchanged.
- Dispatch binding: OAuth profiles use the same per-provider revision semantics (Q9 of the multi-provider plan) — editing models/name bumps only that profile's revision.
- Fail-closed: expired token + failed refresh = `provider_unavailable` with the `relogin_required` marker surfaced in Settings; no silent fallback to another provider.
- Tests are 100 % offline: stub servers imitating `auth.openai.com` (authorize/token) and the Codex responses backend, injected via the env-overridable base URLs. No real OpenAI endpoint is contacted by research, tests, or previews.

## Implementation slices

1. **Shapes + persistence**: `authKind`, OAuth envelope, `tokenState`; profile CRUD/schemas extended (endpoint becomes fixed/derived for OAuth kind); keyring rotation coverage. Persistence tests.
2. **OAuth client**: PKCE generation, authorize-URL builder, paste-back exchange, single-flight rotating refresh with persist-before-use and `invalid_grant` handling; env-overridable constants. Stub-endpoint tests including refresh races.
3. **Responses translator**: request build (messages/tools → input array), response event stream → single assistant message + tool calls, usage extraction, 429 → rate limit; byte/token preflight adapter so compaction and `APP_AI_CONTEXT_MODEL_WINDOWS` keep working unchanged. Translator unit tests over recorded-style synthetic payloads.
4. **Routes + readiness**: authorize/exchange endpoints, `isProfileReady` for OAuth (connected token + enabled + models), dispatch wiring through the translator. Route/service tests.
5. **Web**: provider editor gains auth-kind selector with the four-step OAuth flow (ToS checkbox, authorize link, paste-back, status row); label shows `ChatGPT · model`. Component tests.
6. **Docs + verification**: ToS risk in `docs/security.md` and README, `.env.example` entries, full offline suite (typechecks, AI API suites, web suite, builds) with artifacts cleaned.

## Verified starting constraints (2026-10-25)

- Multi-provider groundwork is merged on the feature branch: profile CRUD with per-provider CAS/revision, per-profile AAD envelopes, per-provider readiness and Q16 selection, `/api/ai/providers` routes and the web profile manager (127 API + 269 web tests green offline).
- The provider HTTP core already exposes a shared, guarded request path (`resolveProviderTarget` + `providerJsonExchange`) used by chat, check and model listing — the OAuth token and responses calls plug into the same funnel.
- OAuth constants above are public registration data used identically by third-party tooling; no secret is embedded.

## Progress

- [x] Grilled design (Q1–Q10) and shared understanding confirmed.
- [x] Slice 1: `authKind` + OAuth envelope shapes, revision-neutral `updateProviderOauth` (token refresh cannot invalidate plans), `codexOauthToken` AAD field, keyring rotation coverage, `isProfileReady` for OAuth profiles, env-overridable Codex constants (`APP_AI_CODEX_*`). Typecheck + 61 related tests green.
- [x] Slice 2 (task agent): `AiCodexOauthService` — PKCE S256 paste-back flow, single-use state with TTL, single-flight rotating refresh with persist-before-use, `invalid_grant` → `relogin_required` fail-closed, self-contained guarded form POST. 12/12 offline tests.
- [x] Slice 3 (task agent): pure Chat-Completions ↔ Responses translators + guarded `generateCodexRequest` (originator/version/session headers, 429→rate-limit, 413→overflow, reasoning items skipped). 34/34 offline tests. Deviations reviewed and accepted: `model` included in the wire body; optional result context for tool-name validation and input estimation.
- [x] Slice 4: routes `POST /api/ai/providers/:id/oauth/{authorize,exchange}`; OAuth profile creation pins the Codex endpoint and takes no API key; per-profile check reroutes through a Codex `flexserver_check` probe; fetch-models refuses OAuth profiles; dispatch acquires the access token via the shared single-flight client, preflights in the Codex request shape and translates through the shared guarded funnel. 4/4 end-to-end offline flow tests (stub auth + stub Codex).
- [x] Slice 5 (task agent): web — auth-kind selector in the provider editor, four-step OAuth flow (ToS acknowledgment, authorize link, paste-back with helper text, token status + re-login), 13 new component tests. 283/283 web suite.
- [x] Slice 6: integrated offline verification — both typechecks, 177 AI API tests (10 files), 283 web tests (13 files), both production builds, docs link check, diff whitespace; `public/` build artifacts removed. ToS risk documented in `docs/security.md`, `.env.example` and README. No real OpenAI endpoint contacted at any point; the live OAuth flow runs only when an operator triggers it deliberately.
- Known limitation: token expiry is surfaced in the UI only right after exchange/refresh; between refreshes the badge reflects the persisted `tokenState` (connected / relogin_required), not a live countdown.
