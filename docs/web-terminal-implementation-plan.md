# Web Terminal SSH Implementation Plan

## Goal

Provide an explicit, full interactive SSH shell at `/api/vps/:vpsId/terminal` using a same-origin WebSocket bridge and a server-side `ssh2` PTY, without exposing SSH credentials to the browser.

## Review status

**Reviewed: 2026-09-16.** This plan is an implementation/runbook record, not a claim of production readiness.

- **Implemented:** Phase 0 and Phase 1; the Phase 2 protocol, registry, service, limits, flow control, UTF-8 handling, heartbeat/pong adaptation, and lifecycle core; Phase 3 shutdown wiring; frontend confirmation, reconnect cleanup, stale-socket guards, and strict server-message validation; and Compose environment wiring with safe-disabled defaults.
- **Evidence:** Focused backend terminal/frontend gates, static deployment-safety assertions, full typecheck, build, and Compose rendering pass. The full suite passed 470/471 tests; the unrelated uninstall-agent timeout passed 16/16 when rerun alone.
- **Partial:** Comprehensive route-level browser back/programmatic navigation blocking remains partial because BrowserRouter has no safe blocker without architectural migration; REST/SSE evidence and the dedicated browser terminal hook remain separate follow-up items.
- **Staging evidence:** App and edge `nginx -t`, public TLS/WSS routing, exact-Origin and authentication rejection, authenticated nonexistent-target failure, and one controlled real-VPS open/input/disconnect smoke pass with limits `1/1`. Three additional open/ready/disconnect cycles completed without failures, residual SSH sockets, cumulative FD growth, or meaningful memory growth. Logout revoked an active terminal as `session_expired`, removed the SSH connection, and preserved stable resources. No command/output was recorded in lifecycle audits.
- **Staging pending:** Real process/no-open-handle evidence across restart, natural session expiry, deliberate host-key mismatch, missing-key, output-flood/slow-consumer, heartbeat, idle/lifetime, and broader browser accessibility/responsive checks. Direct-origin restriction and trusted-proxy redesign also remain pending.
- **Not production-ready:** The feature remains safe-disabled by default until the mandatory staging gate passes; no production enablement is implied by code completion.

## Security invariants

- Available only in `APP_MODE=local` and behind `ENABLE_WEB_TERMINAL=false` by default.
- Browser supplies only `vpsId`, input, resize, and disconnect messages; host, port, username, key, and trust material are resolved server-side.
- Dashboard cookie authentication and exact browser `Origin` validation happen before WebSocket upgrade.
- Terminal connections reuse DNS/SSRF policy, vetted target IP, host-key verification, and managed-key handling from the existing SSH layer.
- A terminal requires an existing trusted host-key pin, regardless of any permissive legacy SSH policy.
- No password authentication, forwarding, SFTP, session resume, collaboration, or shell recording in MVP.
- Terminal lifecycle audits contain normalized metadata only; never record keystrokes, commands, output, clipboard data, credentials, or raw SSH exceptions. Shared SSH diagnostics still require a separate redaction review before making an end-to-end logging privacy claim.
- Established terminal sessions converge on one idempotent cleanup routine; pre-session upgrade cleanup is handled separately by the WebSocket transport.

## Target architecture

```text
Browser + @xterm/xterm
  -> same-origin WSS /api/vps/:vpsId/terminal
    -> upgrade authentication and origin policy (checks persisted webTerminalEnabled setting)
      -> TerminalSessionService / TerminalSessionRegistry
        -> Local VPS (local-agent): Host PTY transport (host-pty binary / supervisor)
        -> Remote VPS: VPS repository + managed KeyService -> ssh2 PTY with host-key pin
```

One WebSocket owns one shell. Reconnect always creates a new shell.

## Phase 0 — Policy and evidence gate

Status: complete.

- Confirm unrestricted-shell semantics and remove the placeholder's read-only claim.
- Allow configured `root` accounts but require persistent, explicit UI warning.
- Use managed private keys only and fail closed without a trusted host-key pin.
- Define stable protocol/error/close reason taxonomy.
- Establish evidence path: deterministic fake-SSH WebSocket integration tests, existing SSH/auth regression suites, frontend lifecycle tests, nginx WSS smoke test, then controlled real-VPS smoke test.

Gate: architecture, threat model, non-recording policy, and rollback flag reviewed before implementation.

## Phase 1 — Shared security primitives

Status: complete.

### Changes

- Add `packages/api/src/auth/dashboard-session.service.ts` to centralize cookie parsing, token hashing, active-session lookup, and session metadata.
- Add `packages/api/src/auth/origin-policy.ts` as a pure exact-origin validator shared by HTTP and WebSocket paths.
- Refactor `DashboardSessionGuard` and `OriginGuard` to delegate to those primitives without changing current route behavior.
- Extend JSON and PostgreSQL session repositories with `findActiveById(id)` for runtime revocation checks.
- Refactor the SSH layer so future PTY sessions and existing exec/SFTP/provisioning operations use one vetted connection path.
- Add a terminal-specific secure shell operation that requires a resolved host-key pin; do not expose it publicly yet.

### Verification gate

- Auth/origin/session repository unit tests.
- Existing SSH host-key and provisioning tests.
- Existing API typecheck and tests.
- Independent architecture/security review before Phase 2.

## Phase 2 — Backend terminal core

Status: substantially complete; focused implementation evidence passes, with process/no-open-handle and deployment evidence pending.

### Changes

- Add `ws` and `@types/ws`; disable per-message compression and set a small `maxPayload`.
- Add `packages/api/src/terminal/terminal-protocol.ts` with versioned, bounded messages.
- Add an in-memory `TerminalSessionRegistry` with global, per-dashboard-session, and per-VPS admission limits.
- Add `TerminalSessionService` for VPS/key lookup, pinned SSH PTY opening, input/output/resize bridging, audit, heartbeat, revocation polling, timeout, and cleanup.
- Use `client.shell({ term: "xterm-256color", cols, rows })`; resize with `setWindow(rows, cols, height, width)`.
- Bound both SSH-to-WebSocket and WebSocket-to-SSH buffering and close slow consumers safely.

### Initial limits

```text
Global sessions: 10
Per dashboard session: 3
Per VPS: 2
Open-message timeout: 10s
SSH connect timeout: 15s
Idle timeout: 15m
Absolute lifetime: 2h
Inbound frame: 64 KiB
Buffered output: 1 MiB
Revocation poll: 5s
Heartbeat: 30s
```

### Verification gate

- Fake-SSH tests for protocol, lifecycle, cleanup races, limits, backpressure, expiry, and revocation.
- Private keys and raw exception details are absent from client messages; terminal content is absent from terminal lifecycle logs and audit fixtures. Terminal output is necessarily delivered to the browser in `output` messages.
- Focused terminal gate covers protocol, lifecycle, cleanup races, limits, backpressure, expiry, revocation, heartbeat/pong, output progress, UTF-8 splitting, bounded draining, and late-send cleanup guards.
- Real process/no-open-handle evidence remains pending.
- Key-read failures map to the implemented `KEY_UNAVAILABLE` code; broader SSH failure taxonomy remains intentionally represented by `SSH_FAILURE`.
- Independent security review before exposing the upgrade route.

## Phase 3 — WebSocket upgrade integration

Status: code complete for current scope; deployment and real process evidence remain pending.

### Changes

- Attach one `WebSocketServer({ noServer: true })` to the existing Node HTTP server.
- Validate route, mode, feature flag, exact Origin, cookie session, and pending-upgrade capacity before `handleUpgrade()`.
- Reject invalid upgrade requests with minimal HTTP 401/403/404/503 responses and destroy the socket.
- Add graceful shutdown/draining and close all terminal and SSH resources before process exit, including process-signal wiring.
- Capacity admission currently applies before upgrade only to pending authentication/connection capacity; shell admission occurs after the client sends a valid `open` frame.

### Verification gate

- Real WebSocket client receives `101` only when authorized.
- Invalid/missing cookie and Origin are rejected before upgrade.
- REST/SSE behavior remains unchanged; route-level evidence remains pending.
- Shutdown wiring is implemented; real process/no-open-handle evidence remains pending.
- Heartbeat/pong adaptation is implemented and covered by focused terminal tests.

## Phase 4 — Browser terminal UX

Status: substantially code-complete; focused frontend evidence passes, with navigation-blocking scope and broader UX verification pending.

### Dependencies

- `@xterm/xterm`
- `@xterm/addon-fit`

### Changes

- Replace `TerminalPanel` placeholder with a VPS-scoped, state-driven interactive terminal.
- Add a dedicated terminal transport and hook; do not put terminal output in React context/state. Existing transport behavior is implemented; dedicated hook extraction remains deferred.
- Implemented states: `disabled`, `disconnected`, `verifying`, `connecting`, `connected`, `reconnecting`, `disconnecting`, `expired`, and `error`.
- Never auto-connect on route entry; successful connection focuses the terminal.
- Show persistent `ROOT` badge and pre-connect warning for root accounts.
- Preserve scrollback on disconnect/error; reconnect is explicitly a new shell and never replays input.
- Debounce resize; dispose xterm, addons, observers, listeners, timers, and WebSocket on unmount.
- Confirm multiline paste and sensitive active-session disconnect/navigation using design-system dialogs; multiline paste and disconnect confirmation are implemented and tested. Comprehensive browser back/programmatic navigation blocking remains partial under BrowserRouter.
- Keep host-key trust and replacement as explicit, separate security flows.

### Verification gate

- Focused frontend tests cover disabled/enabled, root warning, explicit connect, ready/output, strict server-message validation, sanitized error, disconnect/paste confirmation, unexpected close/reconnect, stale-socket guards, expiry, resize debounce/bounds, and resource cleanup. Comprehensive route-level navigation blocking remains pending.
- Output is written through xterm, never injected as HTML.
- Keyboard/focus accessibility, resize behavior, and 375px responsive behavior tests remain pending.
- The normal web workspace test command includes both dashboard and terminal component suites.
- Designer review preserves existing dashboard visual language.

## Phase 5 — Deployment and controlled rollout

Status: configuration/runbook and Compose environment wiring implemented with safe-disabled defaults; static deployment-safety gates are automated; deployment/staging validation remains pending; not production-ready.

### Changes

- Add a terminal-specific nginx location for `/api/vps/<vpsId>/terminal` with HTTP/1.1 upgrade headers, one-hour read/send timeouts, and buffering disabled. The ordinary `/api/` location remains unchanged for REST and SSE. Static assertions cover this separation and the required proxy settings.
- Document exact `DASHBOARD_PUBLIC_ORIGIN`, secure cookie, HTTPS/WSS, and internal-only API port requirements.
- Keep terminal disabled in default compose/environment files; Compose environment wiring passes the configurable values while preserving safe-disabled defaults. Static assertions cover the compose, example environment, and workflow defaults/forwarding.
- Document conservative operator configuration for concurrency, idle timeout, and absolute lifetime.

### Deployment requirements

- Serve the dashboard and WebSocket endpoint from the same HTTPS origin. The browser URL must be `https://dashboard.example.test`; the terminal transport must therefore be `wss://dashboard.example.test/api/vps/<vpsId>/terminal` (never `ws://` from an HTTPS page).
- TLS topology is: browser HTTPS/WSS -> external TLS terminator -> nginx HTTP -> API. Terminate TLS at the external edge, pass HTTP/WebSocket upgrade traffic to nginx, and keep the API hop internal.
- `DASHBOARD_PUBLIC_ORIGIN` is optional generally, but required when `ENABLE_WEB_TERMINAL=true`. Set it to `https://dashboard.example.test` exactly: scheme plus host and optional port only, with no path, query, fragment, credentials, or trailing slash. Set `DASHBOARD_COOKIE_SECURE=true` for HTTPS/WSS terminal staging and use the existing `SameSite` policy; HTTPS origins cannot use an insecure dashboard cookie.
- Keep the API port internal to the Docker network/reverse-proxy host. Do not publish `api:3000` publicly; the public entry point is nginx, and only the web proxy should reach the API container. Compose binds local development access as `127.0.0.1:3001:3000`, which preserves host-local API debugging without network-public exposure. If host access is not needed, remove the port mapping entirely.
- Keep `ENABLE_WEB_TERMINAL=false` in `.env` and compose until the staging gate passes. Enabling requires `APP_MODE=local`, an exact public origin, a trusted host-key pin, and managed SSH key material.
- Compose passes `APP_MODE`, `ENABLE_WEB_TERMINAL`, `DASHBOARD_PUBLIC_ORIGIN`, dashboard cookie/session settings, reverse-proxy trust settings, and terminal limits into the API service. Keep safe-disabled defaults until staging passes.
- Review the conservative defaults before enabling: `TERMINAL_GLOBAL_LIMIT=10`, `TERMINAL_DASHBOARD_LIMIT=3`, `TERMINAL_VPS_LIMIT=2`, `TERMINAL_PENDING_LIMIT=10`, `TERMINAL_OPEN_TIMEOUT_MS=10000`, `TERMINAL_IDLE_TIMEOUT_MS=900000`, `TERMINAL_LIFETIME_MS=7200000`, `TERMINAL_REVOCATION_POLL_MS=5000`, `TERMINAL_HEARTBEAT_MS=30000`, `TERMINAL_OUTPUT_BUFFER_BYTES=1048576`, `TERMINAL_INPUT_BUFFER_BYTES=65536`, and `TERMINAL_SLOW_CONSUMER_TIMEOUT_MS=10000`. Staging may temporarily set dashboard/VPS limits to `1`.

### Staging smoke commands

```sh
# Render/validate the deployment configuration and nginx syntax (run where nginx is installed).
docker compose config
nginx -t -c "$PWD/docker/nginx.conf" -p "$PWD"

# With HTTPS termination configured and the API still disabled:
curl -fsS https://staging.example.test/api/health
curl -i -N --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: SGVsbG9XZWJTb2NrZXQ=' \
  -H 'Origin: https://staging.example.test' \
  https://staging.example.test/api/vps/<vpsId>/terminal

# A disabled deployment must reject the upgrade; after enabling, use an authenticated
# WebSocket client and verify Origin rejection, revocation, host-key mismatch,
# output-flood limits, and restart cleanup.
docker compose logs --since=10m api web
```

The smoke test must use `wss://staging.example.test/api/vps/<vpsId>/terminal` from the browser and confirm ordinary REST/SSE requests still work through `/api/`. Never use the API container's port as the browser endpoint.

### Rollout

1. Deploy shared refactors with terminal disabled.
2. Deploy backend and nginx endpoint still disabled.
3. Validate staging WSS, Origin rejection, session revocation, host-key mismatch, output flood, and restart cleanup.
4. Enable staging at one session per dashboard session/VPS.
5. Run a controlled real-VPS smoke test.
6. Enable production for one operator and observe memory, event-loop delay, file descriptors, close reasons, and revocation latency.

### Rollback

- Set `ENABLE_WEB_TERMINAL=false` and restart the API to reject new upgrades; verify with `docker compose up -d --no-deps api` and the disabled-upgrade smoke request above. Deterministic draining during restart remains a staging gate until real process/no-open-handle evidence is verified.
- If an edge-only block is required during an incident, temporarily replace the terminal location body with `return 503;`, reload with `nginx -t && systemctl reload nginx`, and restore the proxy location after the API is disabled. The deployed route is `/api/vps/<vpsId>/terminal`.
- MVP introduces no terminal-session database schema, so rollback has no schema reversal.

## Protocol outline

Client control messages:

```json
{ "type": "open", "version": 1, "vpsId": "vps_123", "cols": 120, "rows": 32 }
{ "type": "input", "data": "ls\r" }
{ "type": "resize", "cols": 140, "rows": 40 }
{ "type": "disconnect" }
```

Server control messages:

```json
{ "type": "ready", "terminalSessionId": "term_123", "startedAt": "...", "expiresAt": "..." }
{ "type": "output", "data": "..." }
{ "type": "error", "code": "SSH_FAILURE", "message": "The SSH session could not be opened.", "retryable": true }
{ "type": "closed", "reason": "idle_timeout", "exitCode": 0 }
```

## Implemented error codes

These are the codes currently implemented by the terminal error model:

```text
TERMINAL_DISABLED
SESSION_UNAUTHORIZED
SESSION_EXPIRED
VPS_NOT_FOUND
VPS_NOT_ELIGIBLE
KEY_UNAVAILABLE
SSH_FAILURE
LIMIT_EXCEEDED
PROTOCOL_ERROR
INTERNAL_ERROR
```

`KEY_UNAVAILABLE` is implemented for key-read failures. The broad `SSH_FAILURE` code remains the implemented fallback; finer-grained SSH failure codes are not part of the current protocol until actually implemented.

Lifecycle close reasons are separate from error codes and currently include `client_disconnect`, `session_expired`, `protocol_error`, `input_overflow`, `slow_consumer`, `socket_error`, `channel_closed`, and `channel_error` (plus timeout/lifetime/shutdown reasons where wired). They describe cleanup, not protocol error taxonomy.

## Definition of done

- [x] Phase 0 policy/evidence gate and Phase 1 shared security primitives are complete.
- [x] No SSH credential reaches the browser; browser messages cannot override the stored SSH target identity.
- [x] Terminal protocol validation, admission limits, bounded buffering, PTY bridging, and idempotent cleanup are implemented.
- [ ] **Partial:** Same-origin WebSocket integration, process-signal shutdown wiring, heartbeat/pong adaptation, and focused terminal validation are implemented; REST/SSE evidence, real process/no-open-handle evidence, and deployment checks remain pending.
- [ ] **Partial:** Browser terminal UX, multiline paste/disconnect confirmation, strict message validation, reconnect cleanup, stale-socket guards, and resize behavior are implemented and focused-tested; comprehensive route-level navigation blocking remains partial under BrowserRouter, with broader accessibility and responsive browser verification pending.
- [x] Safe-disabled defaults and the one-flag rollback path are preserved.
- [ ] **Partial:** Nginx/runbook configuration and Compose environment wiring are implemented with safe-disabled defaults; `nginx -t`, TLS/WSS, and mandatory staging validation remain pending.
- [ ] Staging authenticated WSS, rejection, revocation, host-key, output-flood, restart-cleanup, real process/no-open-handle, and controlled real-VPS smoke checks pass.
- [ ] Production readiness approval: not complete; do not enable in production before the staging gate.
