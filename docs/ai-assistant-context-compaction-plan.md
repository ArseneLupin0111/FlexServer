# AI Assistant: conversation context and auto-compaction

Status: implementation and offline repair verification completed (2026-10-24); the full API suite still has Windows-host failures noted below. This document is the durable implementation handoff. Research: [OpenClaw/Hermes](research/assistant-context-compaction.md), [pi harness](research/pi-harness-context.md).

## Problem and acceptance

`packages/api/src/ai/ai-task.service.ts` currently loads messages from a conversation and filters them to the *current task ID*. Every new user message creates another task, so a follow-up such as “ok” is sent to the model without the prior question and answer. A deterministic offline service test must prove that consecutive tasks on the same conversation send the previous turns to the provider and that a different conversation/VPS cannot leak into the prompt.

## Invariants

1. Context is scoped to conversation and VPS, but only an explicit approval of a concrete plan digest/version under current policy/session/TTL authorizes execution. A chat response or summary never approves a plan. The system prompt and tool definitions are rebuilt from the current server configuration, never accepted from historical summaries.
2. Raw conversation messages remain immutable and visible. A separate, redacted checkpoint per conversation records summary and the exclusive covered-message boundary (durable ID/order); load latest valid checkpoint plus the uncompressed tail, without duplicating covered messages. Deleting a conversation removes its checkpoint. Clarification, retries and restarts use the same projection. Keep user turn and related evidence/tool pair together.
3. Context window is a per-request limit defaulting to 128,000 tokens, configurable per model. Reserve 20,000 tokens within it for output/headroom; proactively compact when projected prompt exceeds ~108,000. Also respect provider limits of 128 messages and 1 MiB serialized request. Keep a recent verbatim tail targeting 20,000 tokens, but never discard the current user turn or an unfinished tool round. Use actual provider usage where valid and a conservative estimate for preflight; never claim estimates are exact. A too-large mandatory turn fails explicitly.
4. Compact with the currently configured provider/model using a bounded, no-tools summary request. Feed prior summary plus newly covered turns to subsequent compactions; preserve goals, decisions, pending work, identifiers, timestamps/provenance/freshness and omissions. Redact before storage and egress. Reject empty or truncated summaries, commit checkpoint atomically only after validation, and preserve the last good checkpoint on failure. UI only shows “Auto-compact” while active.
5. Persist bounded, redacted, structured tool evidence with host/source/time/status/truncation rather than unbounded raw logs/files. Old measurements remain historical; the assistant must re-observe before claiming current VPS state. Do not bypass existing egress policy or replay a tool operation from an old transcript.
6. Separate per-request context size from per-task cumulative consumption. Default configurable 1,000,000 tokens/task including compact calls, retain six model rounds and twelve tool calls. Prevent repeated compaction without meaningful headroom. Classify actual context overflow or truncated output distinctly from rate limits/provider failures; allow at most one compact-and-retry, never re-run non-idempotent tools. Continue conversations across provider/model changes without confirmation and recompute limits/usage for the active model.

## Implementation slices

1. Add a red offline regression test for two successive tasks and fix conversation-scoped projection in task service, excluding cross-VPS/conversation history. Preserve task approval isolation.
2. Add compact checkpoint persistence and repository API shared by JSON and Postgres journal drivers, compatible with older state. Introduce a bounded history reader (no silent 200-message loss), deletion cleanup and concurrency/revision checks.
3. Extract a pure context-budget and boundary builder accounting for system/tools/messages/output, message count and serialized byte ceilings. Add model-window configuration, safe token estimation, and meaningful overflow/provider classification.
4. Integrate summarization before dispatch and after tool results, checkpoint chaining, bounded provider calls and usage accounting; classify failed summaries and stop clearly without deleting raw history. Keep current task single-flight and approval/egress rules intact.
5. Capture structured, capped, redacted tool evidence; mark historical data with provenance in projection and summary. Add only the minimal “Auto-compact” UI status.
6. Extend offline unit/service/provider/repository/UI tests for thresholds, near-limit, 128-message/1-MiB triggers, truncated/failed summary, one retry, restart, deletion, provider switch and authorization. Run TypeScript, relevant API/web test suites, build and check diff. Never use real provider or VPS in tests.

## Verified starting constraints

- `ai-task.service.ts:113` filters to task ID; context hard-fails at 64 KiB and task budget at 32,768 cumulative tokens; six rounds/twelve tools.
- `ai-provider.ts` caps 128 messages, 1 MiB body, 2,048 output tokens and 60 s request; `finish_reason: length` currently fails its schema.
- `ai.repository.ts` uses one shared state document in JSON or a Postgres JSONB journal. `listMessages` defaults to the last 200. Raw tool calls/results are not persisted across tasks. Provider usage is available when returned, with a byte/4 fallback otherwise.
- Approval is independently bound to plan digest/version/revisions, session and expiry. Preserve these checks.

## Progress

- [x] Save approved design and primary-source research.
- [x] Conversation continuity regression and fix.
- [x] Checkpoint/context budgeting/provider integration.
- [x] Evidence and UI status.
- [x] Targeted API context/provider/persistence tests (99 passing), 253 web tests, both TypeScript projects, API/web production builds, diff check and documentation links.
- [x] Repair regressions for revoked log/file egress, checkpoint validation, same-task clarification boundaries, overflow classification, append-order history, evidence provenance and approval transitions, and transcript pagination. Offline targeted AI tests and the full web suite pass; API/web TypeScript checks and production builds pass.
- [ ] Full API suite clean on this Windows host. The latest run with a 20-second timeout had 1,259 passing, 48 skipped and three unrelated failures: two `fleet-provisioning.service` cases rely on unavailable `flock`, and one `local-upgrade.service` concurrent file rename returned `EPERM`. The default five-second timeout also timed out in file-backed AI tests under full-suite parallel load; those tests pass in the targeted suite and at 20 seconds. PostgreSQL-specific tests were skipped without a configured database.
- [x] Final review repairs: historical summaries are lower-priority user data rather than system messages; dispatch revalidates session, provider revision and restricted-source egress after compaction and immediately before ordinary requests; absent provider usage uses the conservative estimator. `APP_AI_CONTEXT_MODEL_WINDOWS` accepts a JSON object mapping exact model IDs to context-window token counts (global 128,000 default remains the fallback); configuration rejects a reserve below the provider's 2,048-token normal output cap. Docker Compose forwards these settings. Offline regression tests cover these paths. Final focused AI run: 116 passed; full web suite: 259 passed; both typechecks, both production builds, docs links and diff whitespace passed.
- [ ] Revoking log/file egress fails closed for an existing conversation containing that restricted evidence; a new conversation or restored grant is required to continue. Bounded redacted evidence may persist in raw conversation history. PostgreSQL-specific checkpoint behavior remains untested without a configured database. No live provider or VPS was contacted during verification. The reviewer role was available for a read-only final pass; implementation worker roles hit a model concurrency limit, so their bounded assignments were completed locally.
