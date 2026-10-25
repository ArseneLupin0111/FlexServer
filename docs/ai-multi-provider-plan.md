# AI Assistant: multi-provider profiles with user model selection

Status: implemented and verified offline (2026-10-25) on branch `feat/ai-multi-provider` (stacked on the conversation-context branch). Companion feature: [conversation context and auto-compaction](ai-assistant-context-compaction-plan.md).

## Problem and acceptance

The assistant supports exactly one OpenAI-compatible provider (`StoredAiState.settings`: one endpoint, one model, one encrypted key). Admins who use several providers or models cannot switch without overwriting the single configuration, and every switch invalidates **all** pending approvals via the global provider revision.

Acceptance: an admin can register multiple provider profiles, each with its own endpoint, encrypted API key, model list and enable/disable state; chat selects a model per conversation; changing one provider never disturbs tasks, checkpoints or pending plans of another.

## Settled decisions (Q1–Q16)

1. One role (admin) manages and uses a global provider profile list; per-VPS policy gates stay unchanged.
2. Model selection is per conversation via a dropdown next to the composer.
3. Model lists are admin-entered and/or fetched from the provider's `/v1/models`; fetch lives only in Settings, results stored on the profile, no background refresh.
4. No automatic provider fallback on failure; existing classified errors surface as today.
5. One encrypted envelope per provider in the existing AI keyring, bound to a per-provider AAD context.
6. The legacy single configuration migrates automatically into the first profile.
7. Model may change mid-conversation; each message keeps its own provenance.
8. One profile (and one of its models) is marked default.
9. Each profile has its own revision; edits invalidate only that provider's pending plans and in-flight tasks.
10. Disable hides from selectors but keeps data and provenance; delete is blocked while any conversation or non-terminal task references the profile.
11. Provider check (`flexserver_check`) runs per saved profile.
12. UI: Settings Provider tab becomes a profile list (CRUD, disable, per-profile check, fetch models); composer gains a provider-grouped model dropdown; assistant messages show a small `provider · model` label.
13. Per-model context windows stay env-configured (`APP_AI_CONTEXT_MODEL_WINDOWS`); no UI this iteration.
14. New routes under `/api/ai/providers`; `GET /api/ai/settings` remains read-only for one release (returns the effective default); `PATCH /api/ai/settings` is rejected once migration has run; the legacy check route maps to the default profile for one release.
15. Key migration runs at boot: decrypt with the legacy `AI_PROVIDER_KEY_CONTEXT`, re-encrypt under the profile AAD; idempotent; retries on later boots while the keyring is unavailable; the legacy slot is kept so an old build still runs after a rollback.
16. Model resolution order at send time: the conversation's stored selection → the admin's last used selection → the default profile and its default model.

## New shapes

```ts
type AiProviderProfileInternal = {
  id: string;                       // server-generated UUID
  name: string;                     // display name, 1–64 chars, redacted
  endpoint: string;                 // url, ≤1024
  allowPrivateEndpoint?: boolean;
  encryptedApiKey?: AiEnvelopeData; // AAD { vpsId: "global", taskId: id, field: "providerApiKey", version: 1 }
  models: string[];                 // 1–100 unique names, each 1–256 chars, redacted
  defaultModel?: string;            // member of models
  enabled: boolean;
  isDefault: boolean;               // at most one profile
  revision: number;                 // per-profile CAS + dispatch binding
  updatedAt: string;
};
// StoredAiState gains `providers: AiProviderProfileInternal[]` and
// `lastSelection?: { providerId: string; model: string }`.
// Conversations gain selectedProviderId/selectedModel; tasks bind
// { providerId, providerRevision } at admission; assistant messages and
// checkpoints already carry model provenance and gain providerId.
```

## Invariants

- Keys: one envelope per provider under a distinct AAD context; keyring rotation/rewrap and `manage-ai-keys` enumerate every provider envelope plus the legacy slot while it exists; public projections expose `hasApiKey` only — never plaintext or envelope material.
- Approvals: plan digest now covers `providerId` and that profile's revision; approval CAS, session binding and expiry are unchanged. `revalidateForDispatch` compares the task's provider revision, so editing provider A never fails provider B's tasks (agent claim path included).
- Egress: chat, per-profile check and the `/v1/models` fetch all pass through the existing endpoint policy (URL shape, DNS pinning, BlockList, private-endpoint opt-in per profile). Fetched model lists are capped (≤100 entries, each 1–256 chars), deduplicated and redacted before storage.
- Fail-closed selection: sending with a disabled, deleted or key-missing provider is refused with a clear error and no silent fallback; the affected conversation shows an inline banner until reselected.
- Compaction/checkpoint flow is model-agnostic and already per-model-window aware; only the source of `settings.model` changes (task's bound model).
- Tests never contact a real provider or VPS; HTTP stubs and synthetic fixtures only.

## Implementation slices

1. **Persistence**: profile array on `StoredAiState` (JSON + Postgres journal share `createAiRepositoryCore`), CRUD with per-profile CAS, default-singleton enforcement, reference-checked delete, `lastSelection`; boot migration per Q15 with keyring-deferred retry; keyring rotation enumerates new envelopes. Persistence tests.
2. **Policy/revision**: readiness resolves a specific profile; per-provider `revalidateForDispatch`; task admission binds `{providerId, providerRevision}`; plans stamp both into the digest; agent claim path updated. Isolation tests (edit A ≠ invalidating B).
3. **Routes**: `GET/POST /api/ai/providers`, `PATCH/DELETE /api/ai/providers/:id`, `POST .../check`, `POST .../models` (egress-guarded fetch, bounded/redacted); zod schemas; legacy settings read-only + legacy check mapping; provider-key encrypt/decrypt helpers replacing the single `AI_PROVIDER_KEY_CONTEXT` call sites. Route + schema tests.
4. **Task flow**: Q16 resolution order, conversation selection updates, message/task provenance, disabled/deleted fail-closed errors, compaction uses the bound model. Service tests.
5. **Web**: `ai-api.ts` client for the new routes; Settings Provider tab as profile manager (list, add/edit dialog, disable, per-profile check, fetch models); composer dropdown grouped by provider; `provider · model` label; error banner for invalid selections. Component tests.
6. **Docs & verification**: README/settings docs, `.env.example` unchanged (env window config untouched), link check, both typechecks, targeted API + web suites, production builds.

## Verified starting constraints (2026-10-25 scout)

- `AiProviderSettingsInternal` is a single slot (`ai.models.ts:100-107`); repository `updateSettings` CAS-replaces it (`ai.repository.ts:1074-1112`); no `providerId`/model-list notion exists anywhere.
- `providerRevision` is stamped into plans and covered by `planDigest` (`ai-task.service.ts:336-380`); `revalidateForDispatch` compares the global settings revision (`ai-policy.service.ts:223-241`); the agent claim path repeats the comparison (`ai-agent.service.ts:621-632`).
- Envelope crypto is AAD-parameterized and already handles N envelopes (per-task execution payloads); only the schema slot and the hardcoded `AI_PROVIDER_KEY_CONTEXT` are single-tenant (`ai-crypto.ts`, `ai-routes.service.ts:12`).
- Web settings modal checks run against saved settings only; the provider tab fields map 1:1 onto the current single-slot schema.

## Progress

- [x] Grilled design (Q1–Q16) and shared understanding confirmed.
- [x] Slice 1: profile schema + repository CRUD (per-profile CAS, exactly-one-default, reference-checked delete), boot migration with keyring-deferred retry, keyring rotation covering every provider envelope.
- [x] Slice 2: `isProfileReady` + dispatch revalidation scoped to the task's provider; plans stamp `providerId` into the digest; agent claim path compares the plan's own provider.
- [x] Slice 3: `/api/ai/providers` CRUD + per-profile check + egress-guarded `/v1/models` fetch (bounded/redacted/deduped, cap 100); legacy `GET /api/ai/settings` derives the default after migration, `PATCH` returns 409, legacy check maps to the default profile.
- [x] Slice 4: Q16 resolution (explicit > conversation > last used > default) with fail-closed pinned/explicit selections and a pre-migration legacy pseudo-profile so unmigrated instances keep working; conversation/task/message provenance.
- [x] API offline tests: `ai-multi-provider.test.ts` (migration idempotence + deferral, CRUD invariants, Q16 tiers, fail-closed, Q9 isolation, legacy routes freeze) and model-listing tests in `ai-provider.test.ts`; existing compaction/persistence/provider suites stay green.
- [x] Slice 5: web UI — settings Provider tab is a profile manager (CRUD, disable, per-profile check, fetch models, arm-then-confirm delete); composer model selector grouped by provider; `provider · model` label on assistant turns; Q16 client resolution (conversation pin > last used > default, stale picks omitted) and a pinned-provider warning banner. Implemented by a task agent; one minimal Boolean-cast fix in AssistantChat.
- [x] Slice 6: integrated offline verification — both typechecks, 127 AI API tests, 269 web tests, both production builds, docs link check and diff whitespace all pass. Build artifacts under `public/` were removed after verification. No real provider or VPS contacted. PostgreSQL-specific behavior remains covered only by the shared core logic tests (no configured database), and the full API suite still carries the known Windows-host `flock`/`EPERM` failures unrelated to this feature.
