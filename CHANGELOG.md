# Changelog

## Unreleased — PostgreSQL deployment health

- Restore the shared `DATABASE_POOL` provider in application wiring so PostgreSQL health checks receive the initialized pool instead of returning HTTP 503 `Database pool not available`.
- Capture API startup logs and the readiness response when container deployment fails.

## Unreleased — AI startup recovery and test lifecycle

- Await the initial AI retention/recovery pass before application bootstrap completes, preventing requests from racing startup JSON writes and task recovery.
- Close test-owned Nest applications before deleting their temporary storage so retention timers and in-flight maintenance cannot recreate removed files.
- Remove the obsolete PostgreSQL provider-shape assertion; retain rate-limit behavior and fail-closed coverage.

## Unreleased — AI Docker bridge approval digest consumption

- Bridge `docker_action`/`compose_*` proposals now execute only through consume-once approval: the API CAS-approves the stored plan (matching `planVersion`/`planDigest`) to `consumed`, then re-reads it before transitioning the task to `executing` and verifies the re-read plan digest matches the approved digest; any mismatch or replay fails as `stale_plan` instead of proceeding.
- Removed the bridge's executing-state fallback: `AiDockerBridgeService.execute` accepts only `approved`/`consumed` plans, so authorization can never be granted by task state alone.
- Refusal smoke against real JSON persistence + real Nest HTTP wiring passed with exact target rejections: Docker/Compose opt-out via policy or per-VPS setting → `policy_denied`; protected container and protected compose application → `protected_target`; precondition drift (`running` → `exited`) on the exact target container → 409 `target_changed`; the operations queue remained empty, so no positive Docker action, cgroup v2 execution, or real nginx staging proof is claimed.
- Stopped the task-owned `ai-api-browser-compiled` and `ai-isolated-styled-web` services and deleted the task-created throwaway smoke harness files and temporary keyring fixture. No other smoke artifacts or services were touched.

## Unreleased — AI assistant operational safety, retention scheduling, and secret redaction

- Add `AiRetentionService` with real periodic scheduling: 5-second active task reconciliation loop and 300-second retention pruning pass.
- Prune terminal tasks older than 30 days while strictly preserving active and uncertain tasks, active outbox commands, and uncertain receipts.
- Protect execution blobs from expiration deletion while referenced by active or uncertain tasks, active outbox commands, or uncertain receipts.
- Preserve audit records across conversation deletion and record an immutable deletion audit event under the 90-day retention baseline.
- Reconcile active tasks at startup and during periodic maintenance: expire stale planning leases and expired awaiting tasks, reconcile expired execution leases to `uncertain` to maintain fences without re-execution, and transition running tasks to `cancel_requested` upon session logout or revocation.
- Centralize shared secret redaction in `common/redaction.ts` covering PEM private keys, SSH keys, passwords, bearer tokens, scoped `vma_` tokens, `sk-` provider keys, `.env` assignments, and ANSI sequence stripping to prevent escape-based bypass.
- Add `ChunkRedactor` with line-oriented buffering and PEM block masking for multi-packet streaming secret detection without leaking token prefixes across chunk splits.
- Redact provider responses and outgoing API endpoints via `AiResponseInterceptor`, exempting authenticated execution preview exact payloads to maintain byte digest verification.
- Operational limitation: Production readiness of AI assistant orchestration, confinement, and real-provider execution remains unverified; local unit tests and simulated adapter runs do not constitute production readiness.

## Unreleased — AI provider transport and encrypted payload primitives

- Add a bounded OpenAI-compatible provider adapter with DNS-pinned endpoint validation, verified TLS, explicit private-endpoint consent, rejected redirects, strict tool-call decoding and fixed safe transport errors. Tool responses do not authorize execution.
- Add separate AI-namespaced envelope encryption and wrapped-key rotation bound to VPS/task/field/revision. No plaintext fallback when external key material is unavailable.
- Verify adapter behavior against a synthetic local HTTP endpoint; real-provider compatibility and Linux host mutation/confinement acceptance remain separate rollout gates.
- Restore compilable AI repository source and a serialized JSON adapter; local runtime smoke verifies durable task admission, idempotent replay and active-task exclusion. End-to-end AI execution remains unavailable and unverified.
- Route privileged AI host operations through the pinned root `ai-host-helper` (`SO_PEERCRED` auth, fixed RPC surface) and namespace-confine shell execution via `ai-executor` with cgroup v2 scopes; both fail closed without cgroup v2, and refused helper RPCs leave the caller's task state untouched.
- Add installer wiring for the isolated AI subsystem (`--install-ai`, AI binary/rootfs/profile flags) to `install-local-agent.sh`; `--help`/`--dry-run` list and print the plan with zero writes and zero network, and group access is granted only via the generated systemd `SupplementaryGroups`, not shell `usermod`.
- Fix Linux stat ownership checks in the AI profile registry and helper validator to handle `syscall.Stat_t` properly; smoke verified service-action safety policy, protected-path denial, atomic CAS with backup and drift rejection, and fail-closed cgroup/execution on a cgroup v1 Linux engine.
## Unreleased — Docker Compose applications (phase 2) packaging and security docs

- Refine Docker investigation and Compose application layout for desktop and mobile; distinguish an absent Compose scan from confirmed runtime unavailability, disclose diagnostic codes separately, and explain freshness requirements before runtime preparation.
- Preserve the Compose management-mode filter's accessible label and align runtime-preparation test fixtures with observed inventory freshness; cover absent-inventory preparation refusal.
- Document the current Compose application security boundaries and rollout controls: separate per-VPS opt-in, external-source consent, no implicit start/deploy or runtime install, readiness and uncertain-operation handling, storage backup/recovery, and data-safe rollback guidance.
- Document the packaged `node dist/scripts/manage-compose-keys.js` administration entry point and its init/check/rotate/rewrap procedures; add an opt-in read-only Compose keyring override and a separate stopped-API read-write override for one-shot administration. The standard stack and demo remain unchanged when overrides are omitted.
- Add separately confirmed runtime preparation: reuse a trusted compatible Compose runtime without changes, or install the pinned official v2.40.3 executable with architecture-specific SHA-256 verification into an isolated FlexServer directory on supported root-run Linux agents. Missing/untrusted Docker CLI fails closed with manual installation guidance; GET, preview and deployment never install runtime.
- Bind Compose inventory requests to their enrolled agent instance so the API can accept fresh inventory without weakening identity checks.
- Bind removal approval to the complete daemon inventory while keeping deletion candidates scoped to the selected project; reject manifests that omit any owned container of a removed service before Compose mutation.
- Read connected-agent freshness from persisted agent state when admitting Compose work; raw VPS records do not carry the dashboard's enriched agent status.
- Encode registry credential identities as JSON tuples so PostgreSQL JSONB storage accepts them without embedded NUL characters.
- Claim source verification and lifecycle work without requiring an unrelated managed revision; replay identical source requests before applying the active-operation guard.
- Accept standard YAML node tags while retaining custom-tag/alias refusal, and accept previews with omitted optional variables.
- Enforce the host exclusion-registry row cap on the proposed mutation before persistence, rejecting the first over-cap acquisition without corrupting the registry.
- Fix managed Compose execution against direct plugin binaries, capture registry credential versions during preview, and commit preview results reported by operation ID.
- Preserve exact terminal receipts across transport retries and clear acknowledged receipts; advance progress sequences monotonically so successful operations do not block subsequent revisions.
- Align deployment authorization with the complete removal manifest, read ownership labels from Engine `Config.Labels`, and allow Docker stop grace to complete before the control transport times out.
- Refuse explicit and implicit registry credential replacement while authorized, applying, or uncertain operations reference it, including preview-captured references; invalidate pending previews when credentials change before authorization.
- Keep discovered application detail, operations and revision reads consistent with the listed identity; preserve freshness-based admission and VPS-scoped operation history.
- Build lifecycle plans from verified dependency edges and observed one-shot completion, retain bounded per-service outcomes, and exclude private claim credentials from public operations.
- Preserve allowlisted runtime-preparation evidence, including whether installation occurred, without returning raw agent observations or executable paths.
- Unwrap Compose API response envelopes in the browser client so the Applications inventory renders against the live API.
- Keep concurrent legacy Docker command claims silent when another agent holds the shared Compose reservation; retain errors for storage failures and preserve active reservations when direct claims are refused.
- Accept the agent's explicit mutation-authorization and partial-result receipt flags while preserving strict request validation, allowing durable terminal receipts to settle instead of remaining claimed after HTTP 400.
- Derive each Compose service's lifecycle readiness from its own one-shot/healthcheck facts, independently of dependency-edge conditions, so services without healthchecks do not wait indefinitely for a nonexistent healthy state.

## Unreleased — Docker container troubleshooting

- Add bounded sanitized Docker inspect details to committed container snapshots: ports, mounts, networks, healthcheck status/timing, lifecycle, exit code, OOM flag, restart metadata. Details are optional for older agents and never carry raw inspect, health commands/output, labels, environment or daemon IDs.
- Add read-only container details to the Docker tab and existing direct container route, alongside identity-scoped lifecycle events and local buffered-log search/stream filters. Logs remain in-memory and filter changes do not request daemon history.
- Deploy API migration `027_docker_container_details.sql` before upgraded agents; old agents continue without details. Details are sampled snapshots, not on-demand inspect; refresh reloads committed data.

## Unreleased — reusable dashboard actions

- Extract the shared row action trigger/menu into `RowActionsMenu` and reuse it in Files, server tables/cards, and Jobs while retaining each feature's permissions and confirmation flows.

## Unreleased — Files row actions

- Replace inline file action buttons with a single row action menu, preserving Download, Rename, Delete confirmation, and capability restrictions on desktop and mobile.

## Unreleased — local Files helper startup

- Pass supported socket UID/GID flags from the host-files installer and align the binary's default socket path with the API and Compose (`host-files/files.sock`).
- Run the root helper with the API runtime group so systemd preserves group access to its runtime directory and socket instead of resetting ownership to root:root.

## Unreleased — CI fixture fixes

- Route Settings agent-upgrade test responses by endpoint so Files capability requests cannot consume upgrade success or failure responses; assert successful confirmation closes and failed confirmation retains the API error.
- Keep the unchanged-endpoint host-key pin preservation check without coupling it to the incidental representation of empty audit metadata.

## Unreleased — Files transfer E2E fixes

- Keep SFTP uploads alive after the HTTP request body completes; only incomplete request closure cancels the upload.
- Encode Unicode download names with an ASCII fallback and RFC 5987 filename parameter.
- Observe download pipeline rejection immediately so missing-file responses cannot terminate the API through an unhandled stream rejection.
- Preserve accessible New Folder and Upload button names on mobile.

## Unreleased — descriptive local shell prompt

- Give host PTY sessions using `sh` or `dash` a default `user@hostname:${PWD}` prompt, with `#` for root and `$` for other users. Preserve a non-empty inherited `PS1` and allow shell startup files to override the default; other shells are unchanged.
- Cross-compiled the Linux helper and exercised a disposable instance on the host: the prompt changed from `root@weepingangel:/root#` to `root@weepingangel:/tmp#` after `cd /tmp`. Removed the temporary helper; the installed daemon was not replaced or restarted. Applying this change requires deploying the host-pty binary and opening a new terminal session.

## Unreleased — terminal mode-query build fix

- Target ES2021 in the frontend production build to preserve logical assignment in xterm's mode-query parser. ES2020 lowering combined with esbuild minification could remove a local enum declaration, causing `ReferenceError` and freezing TUI rendering when applications such as OpenCode query terminal modes. Browsers must support ES2021 syntax.
- Verified the frontend production build and exercised xterm bundled through the same Vite configuration in Chromium: alternate-screen output rendered, cursor-visibility and bracketed-paste mode queries returned the expected replies, and no browser errors were recorded. This is local build/parser verification, not a production deployment or a new end-to-end OpenCode run.

## Unreleased — isolate host daemon socket lifecycles

- Give host PTY and local agent rotation separate runtime child directories under the stable `/var/run/flexserver` mount, preventing one service restart from unlinking the other's socket.
- Migrate socket defaults across API, rotation client, Compose, installers and deployment; stop legacy shared-runtime daemons before cutover and refresh API bind mounts during deployment.

## Unreleased - configuration sliding toggles

- Replace Enable/Disable buttons for web terminal, dangerous command guard, Docker monitoring and Docker management with accessible sliding toggles. Preserve update errors, pending states, capability restrictions and Docker monitoring confirmation.

## Unreleased — Docker workload tab placement

- Move Docker workloads and container resource summaries from Metrics into the Docker workspace. Metrics now displays host telemetry only; existing Docker controls, logs, and history remain in the Docker tab.

## Unreleased — README demo screenshots

- Replace archived desktop/mobile captures with the current Servers workspace captured through Playwright/Chromium in isolated demo mode. README now identifies the simulated data and includes an expandable mobile preview.

## Unreleased — Docker action status response fix

- Read Docker management action creation and status responses as raw resources, matching the Nest API contract. Previously the browser discarded the returned operation and showed `Operation status: none` even when the agent executed the command.
- Chromium smoke against an isolated Docker-in-Docker daemon, real Nest API/JSON persistence, and Linux Go agent verified cancel leaves the workload running, confirmed stop exits it, start runs it again, and confirmed restart changes its PID and start timestamp. All three operation results and manually refreshed browser statuses reported `succeeded`; refreshed inventory reported `running`. This is local verification, not production TLS or remote-host verification.

## Unreleased — local agent verification harness fixes

- Keep the live Linux lifecycle argv fixture running with an exact managed command line instead of invoking GNU `yes` with unsupported `-config` options. Verified all 20 lifecycle assertions, including the real `/proc` stale-pidfile case.
- Remove the docs checker's hashbang: Vite SSR moves imports before it, making the imported script invalid JavaScript. Direct `node scripts/docs/check-links.mjs` usage is unchanged; all eight checker tests pass.
- Disposable Debian/systemd SSH smoke verified host-key trust, password-to-key provisioning, agent install with real heartbeat/metrics, restart, upgrade, reinstall, uninstall, and idempotent server deletion. Callback transport used loopback HTTP inside the isolated target network namespace; this does not verify production TLS or a cross-version upgrade.
- Local installer access/state fixtures passed (16/14 assertions), updater checks passed (26 assertions), and the rotation helper verified successful config replacement, wrong-VPS rejection, and restart-failure rollback with simulated `systemctl`. Linux Go race tests and vet passed. The local updater's full signed rollout against a live systemd service remains outside this smoke; no production host or existing credential was used.

## Unreleased — fail-closed agent lifecycle confirmation

- Check persisted queued/running server jobs inside the held uninstall slot before remote agent removal, credential revocation, state checkpoints, or local deletion. A busy-job refusal leaves the installation intact and can be retried after the job finishes.
- Confirm remote installs using fresh usage of the newly issued agent credential and real online ingest with a version before completing the job. Preserve observed version, build ID, and heartbeat timestamp instead of manufacturing online state; timeout uses the existing rollback and credential revocation path.

## Unreleased — retryable server removal

- Remove remote managed agents synchronously before deleting a VPS record or its SSH key. SSH/uninstall failures retain the record and key so removal can be retried.
- Close the removed server's terminal and Docker log sessions, reject removal while server jobs are active, and purge server-scoped credentials, agent state, metrics, jobs, Docker data, upgrade history, and host-key pins. Repeated deletion completes any remaining local cleanup.
- Verified through authenticated HTTP and a disposable SSH server: failed authentication retains the server, a corrected retry returns 204 and removes the installation and local data, unrelated remote files survive, and repeated deletion returns 204.


## Unreleased — systemd-aware managed process ownership

- Make restart/upgrade inspection systemd-aware: when the deterministic per-VPS unit is active, its `MainPID` is authoritative and the legacy `vps-agent.pid` file is ignored, recovering from supervisor restarts that leave a stale pidfile. Exact exe/cwd/argv, UID, and identity matching are unchanged; foreign, missing, or invalid `MainPID` fails closed as `mismatch`, and ambiguity still reports `ambiguous`. With no active unit the legacy pidfile policy applies unchanged.
- Stage and checksum remote reinstall binaries/configs before stopping the managed service, then atomically replace them; never SFTP-write a running executable (`ETXTBSY`). Keep rollback copies until job completion, restore the prior installation after cutover failure, and release only an acquired lifecycle lock.
- Azure production smoke: dashboard restart and reinstall service jobs succeeded on 2026-10-16; fresh metric ingest followed reinstall and the managed unit MainPID matched its PID file. This verifies remote SSH lifecycle recovery, not the separate local-updater rollout gate.

## Unreleased — CI rotation protocol prerequisites

- Build the native Go local-agent rotation client before Node tests in `Verify checks`, so clean Linux runners exercise the Unix-socket rotation tests with the required executable instead of failing with an unconfigured helper.

## Unreleased — durable external SSH keyring provisioning and deployment wiring

- Add persistent external SSH keyring provisioning across CI/CD deployment (`.github/workflows/ci.yml`), installer (`scripts/install/install.sh`), and host bootstrap (`scripts/install/bootstrap-ssh-keyring.sh`).
- Mount external host directory `/etc/flexserver` read-only into the API container (`/etc/flexserver:/etc/flexserver:ro`) and set `SSH_KEY_ENCRYPTION_KEY_FILE=/etc/flexserver/ssh-keyring.json` in production `.env` and `docker-compose.yml`.
- Add opt-in Compose override `docker-compose.keyring.yml` for local development and standalone Compose environments to mount the external keyring read-only without breaking demo mode when absent.
- Enforce strict POSIX permissions: directory `/etc/flexserver` mode `0750` owned by API container runtime UID/GID (`100:101`), keyring file `ssh-keyring.json` mode `0600` owned by API container runtime UID/GID.
- Add fail-closed envelope guard in `manage-ssh-keys` CLI `init` to refuse initializing a new KEK keyring if existing encrypted envelopes are found without a keyring file, preventing accidental key loss or orphaning.
- Add `--migrate` flag to `manage-ssh-keys init` CLI to atomically migrate existing plaintext OpenSSH private keys to encrypted envelopes immediately after initialization.
- Implement constrained local agent rotation daemon (`local-agent-rotator`) listening on Unix socket `/var/run/flexserver/agent-rotation.sock` with OS peer credential validation (`SO_PEERCRED`), strict payload limits, atomic config updates preserving mode `0640` and group `gid 999`, immediate `TryLock` concurrency rejection, bounded 8s service restart timeouts, and automatic rollback on `vps-manager-agent.service` restart failure.
- Provide container rotation client (`local-agent-rotation-client`) shipped in the API image and wired via `LOCAL_AGENT_ROTATION_HELPER=/usr/local/bin/local-agent-rotation-client` and `LOCAL_AGENT_ROTATION_SOCKET=/var/run/flexserver/agent-rotation.sock` to invoke the host daemon over the shared `/var/run/flexserver` volume without Docker socket access or host root escalation.
- Add standalone host remediation installer `scripts/install/install-local-agent-rotator.sh` and integration options in `scripts/install/install-local-agent.sh`.
- Restrict `AgentRotationService` credential revocation to agent-scoped credentials (`scope === "agent"` or unset), preserving active `local-updater` credentials during local agent rotation so the local updater daemon retains valid authentication.
## Unreleased — agent singleton process lock and systemd service management

- Enforce per-VPS singleton OS process lock on Linux (`/run/vps-manager-agent/vps-agent-<sha256(vpsId)>.lock`) across both continuous daemon and `-once` modes. Directory `/run/vps-manager-agent` is root-owned (`0755`) and the lock file is a root-owned regular file (`0666`). Opened with `O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK` and acquired via non-blocking exclusive `flock`; released automatically by the kernel on termination or crash without unlinking the file, preventing multiple agent instances from competing for the same VPS.
- Add offline `-validate-config` flag to `vps-agent` to validate configuration syntax and required fields without acquiring the singleton lock, opening network connections, or mutating state. Staged upgrade preflight verifies candidate binaries using `-validate-config` while the running daemon maintains its singleton lock.
- Manage remote Linux agents as system-level systemd services (`/etc/systemd/system/vps-agent-<hash>.service`) executing under login credentials (`User=<user>`, `Group=<group>`) with `Restart=always`, `RestartSec=10`, `TimeoutStopSec=15`, and `KillMode=control-group` for process cleanup (not a security sandbox). Local host agent installations retain the canonical `vps-manager-agent.service` unit to preserve local updater daemon (`vps-updater`) supervision. Sudo is required for remote service operations; unmanaged nohup loops are superseded while Docker state arguments are preserved.
- Provision runtime lock directory and lock file via `/etc/tmpfiles.d/vps-manager-agent.conf` and `systemd-tmpfiles --create` rather than systemd `RuntimeDirectory=` (which would transfer root ownership to the unprivileged service user). Supported in both local and remote installers to guarantee persistent root ownership across reboots.
- Harden lock provisioning into durable `lock.Provision(vpsId)`: root-owned `0755` directory, root-owned `0666` lock file with never-unlink/never-truncate inode preservation, plus `/etc/tmpfiles.d/vps-manager-agent.conf` (`0644` root:root) and `systemd-tmpfiles --create` for reboot persistence. Regression coverage includes missing-lock provisioning and held-inode preservation at both lock and privileged-helper layers.
- Provision the singleton lock from the privileged updater helper before binary swap and restart using the trusted local `/etc/vps-manager-agent/config.json` `vpsId` (helper sandbox: `ReadWritePaths=/run/vps-manager-agent /etc/tmpfiles.d`, `ReadOnlyPaths=/etc/vps-manager-agent/config.json`). Add `vps-agent -config <path> -provision-lock` CLI and local-agent installer provisioning preserving the existing lock inode.
- Retain legacy PID tracking (`~/.vps-manager-agent/vps-agent.pid`) and exact argv matching strictly for safe migration of existing background loops to systemd without terminating unknown processes.
- Document production verification of singleton process locking and systemd service management on single Azure host `vps_kUq9jDFzAtxY` (`vps-agent-e3d0757876c6e2baf8d0044daa30b1218070930aa38f83de4112794e7eceeb5a.service`, `User=doanphamthanhson`, build `867941df81e769e07db86edcf9e4314101889735`), confirming duplicate `-once` contention rejection (exit 1), offline `-validate-config` leaving live PID unchanged, stable lock inode across `systemctl restart`, fresh post-restart heartbeat in PostgreSQL `metric_latest`, and passing unprivileged lifecycle helper smoke tests. Broader fleet rollout remains unverified.
- Document audit of two diagnostic stubs under `/tmp` verified via SHA-256 and disassembly as tiny 4624/4680-byte pause syscall loops (not real agents and not causes of job timeouts), terminated via pidfd; no incident cause asserted.
## Unreleased — agent updates relocated to host Settings

- Relocate remote SSH agent upgrade action from VPS fleet list cards/tables to the per-host Settings tab (`/vps/:vpsId/settings`).
- Extend `LocalAgentUpdate` to support both local host updates (bundled daemon updater via `/api/vps/:id/local-agent-upgrades`) and remote SSH host upgrades (`POST /api/vps/:id/upgrade-agent`), retaining host identity, status badge, eligibility gating, upgrade reason feedback, and confirmation dialogs.
- Clean up obsolete `card` and `table` variants and dense display branches from `LocalAgentUpdate`, consolidating into a unified host Settings component.
- Restore frontend `upgradeAgent(id)` API helper and wire it to workspace and Settings actions.

## Unreleased — self-host setup documentation

- Restore root README source/local-mode, PostgreSQL Compose, and Linux amd64 installer instructions, including password bootstrap, session secrets, persistent storage, SSH host trust, and demo/local isolation.
- Correct repository-local paths and canonical FlexServer repository/support links; document the enabled GitHub private vulnerability reporting route.
- Add `npm run check:docs` to validate README local file links and heading anchors without network access; accept additional Markdown paths as arguments.

## Unreleased — web terminal accidental command guard setting

- Add persisted global `terminalCommandGuardEnabled` setting (defaulting to `false`) for web terminal sessions across local host PTY and remote SSH targets.
- Add migration `025_terminal_command_guard.sql` adding `terminal_command_guard_enabled boolean NOT NULL DEFAULT false` to the `dashboard_settings` table.
- Support partial settings updates in `PATCH /api/dashboard/settings` so `webTerminalEnabled` and `terminalCommandGuardEnabled` can be toggled independently without overwriting each other.
- Implement partial update persistence across both JSON (`data/settings.json`) and PostgreSQL (`dashboard_settings` table) repository implementations.
- Expose `terminalCommandGuardEnabled` in `DashboardOverview.settings` and in the `PATCH /api/dashboard/settings` response payload.
- Document accidental command guard behavior in `docs/security.md`: a client-side safety net cancels recognized typed destructive commands and rejects dangerous pastes (`rm -rf /`, `mkfs`, `dd`, `shutdown`, etc.), displaying a dismiss-only warning. It does not filter server-side PTY streams or change host root / SSH execution privileges; disabling it restores raw input forwarding.

## Unreleased — production local terminal host-pty deployment

- Update CI/CD deployment workflow (`.github/workflows/ci.yml`) to automatically provision the bundled `host-pty` binary (`/app/agent/host-pty-linux-amd64`) directly from the deployed API container image.
- Configure root systemd service (`flexserver-host-pty.service`) with `RuntimeDirectory=flexserver` (`RuntimeDirectoryMode=0755`) ensuring `/var/run/flexserver` socket directory recreation across host reboots.
- Derive API container runtime UID and GID dynamically at deployment time (no hardcoded runtime UID) so socket permissions (`0660`) are granted to the unprivileged `app` container user.
- Mount `/var/run/flexserver` into the production API container and set canonical `LOCAL_PTY_SOCKET_PATH=/var/run/flexserver/host-pty.sock` in `.env` and `docker-compose.yml`.
- Ensure atomic binary installation (`/usr/local/bin/flexserver-host-pty`) and daemon update/restart on image digest upgrades, running before the API container starts, with no Docker engine socket mounted.
- Correct documentation in `docs/security.md` regarding automated CI/CD host PTY daemon provisioning, boot runtime directory management, and least-privilege socket permissions.

## Unreleased — CI regression cleanup

- Remove the obsolete Overview endpoint-placement test after workspace metadata deduplication. Keep production UI unchanged rather than restoring duplicate endpoint text or re-pinning incidental layout wording.
- Verified the affected `App.test.tsx` suite: 44 tests passed.

## Unreleased — VPS workspace metrics and action deduplication

- Deduplicate metrics, host identity, and navigation controls across the authenticated VPS workspace (`/vps/:vpsId/*`).
- Header persistent banner establishes single authoritative presentation for host identity (display name, user@host:port, provider, location, status badge, agent status, last seen) and instantaneous resource telemetry (CPU, RAM, Disk, Load, Network RX/TX).
- Remove redundant top-right Terminal and Settings action links from the workspace header, routing all sub-page transitions authoritatively through the horizontal tab bar (`Overview`, `Docker`, `Metrics`, `Jobs`, `Audit`, `Terminal`, `Settings`).
- Streamline Overview tab: remove duplicate CPU/RAM/Disk gauge cards, redundant RX/TX readouts, redundant "Host health" KPI, and redundant "Recent jobs" summary counter, retaining a standalone compact Containers status card. System Facts table retains host hardware and configuration fields (OS, Kernel, CPU model, Cores, Memory, Disk, Server ID, Host ID, Tags, Notes, Agent version, Uptime) while omitting duplicate provider/location/SSH metadata already owned by the header.
- Scoped Metrics tab: lock and hide the redundant "All servers" selector in scoped view, hide fleet-wide peak CPU/RAM/Disk/Load summary cards and redundant MetricServerCard instances, and consolidate the duplicate by-server and top-containers Docker views into a single canonical `CanonicalDockerWorkloads` panel containing summary metrics and container inventory table.
- Remove redundant duplicate `DockerCapabilityNotice` banner on the Docker tab, keeping `DockerMetricsPanel` as the authoritative capability and toggle controller.
- Preserve all unique actions, route reachability, historical charts, and live data telemetry.

## Unreleased — remote agent ownership during upgrades

- Recognize installer-managed `./vps-agent` loops with explicit Docker state arguments, verifying executable, working directory, config/state paths, runtime owner, PID and start time before signaling. Unknown arguments and foreign state paths remain rejected.
- Preserve Docker state arguments when restarting after install or upgrade. Permit an absent managed process during upgrade and rollback without attempting to stop an unrelated process.
- Verified 25 API lifecycle tests, API typecheck, isolated Linux ownership/start/stop smoke on Azure, and read-only ownership classification of the existing Azure agent. No production binary upgrade was performed.

## Unreleased — public navigation layout stability & geometry alignment

- Audit and eliminate horizontal layout shifts across all public routes (`/`, `/pricing`, `/security`, `/enterprise`).
- Root cause: Header container used `justify-between` spacing with uneven right-hand action items (Landing featured both "GitHub" and "Deploy Guide" action buttons while inner pages only featured a single "Deployment docs" action button), causing an asymmetric ~38px middle navigation position shift on route transitions.
- Standardize header action buttons across Landing, Pricing, Security, and Enterprise pages with canonical "GitHub" (secondary) and "Deploy Guide" (primary) buttons, consistent icon sizes (14px), and identical order.
- Stabilize header element geometry with `flex: none` on `.landing-brand`, `.landing-nav`, and `.landing-header-actions` within `.landing-header-inner`.
- Add `scrollbar-gutter: stable` to `html` and `.landing-page` to eliminate layout shift caused by vertical scrollbar appearance and differences in page content heights across routes.
- Align active navigation link styles (`aria-current="page"`) to consistently display brand accent color (`--l-accent`), removing conflicting rules in `security.css` and `enterprise.css` that reset active link color to white.
- Standardize mobile navigation drawer CTAs, ARIA attributes (`aria-controls`, `aria-label`, `aria-current`), menu toggle button icon size (18px), Escape key focus restoration, body overflow management, and 55rem viewport media query listener across all public pages.

## Unreleased — robust public skip link accessibility

- Fix initial load visibility of `.landing-skip` across public pages (Landing, Pricing, Enterprise, Security).
- Replace fixed `-5rem` transform offset with element-height relative translation (`calc(-100% - 2rem)`), `opacity: 0`, and `pointer-events: none` when unfocused, preventing accidental exposure from multi-line text wrapping, user font scaling, or browser zoom.
- Add explicit `prefers-reduced-motion: reduce` overrides for `.landing-skip` to prevent global `.landing-page * { transform: none !important; }` reset from exposing the unfocused skip link on page load.
- Preserve full keyboard accessibility, revealing `.landing-skip` with high-contrast focus outline on `:focus` and `:focus-visible` before dispatching to `<main id="main-content" tabIndex={-1}>`.

## Unreleased — authenticated dashboard workspace redesign

- Redesign the authenticated FlexServer operator console (`/vps/*`) following the approved visual and interaction theses without altering public landing pages, backend logic, or external APIs.
- Implement a workspace-first layout featuring a desktop fleet navigation sidebar with live search filtering, status indicators, and Geist Mono telemetry, accompanied by a mobile fleet navigation drawer triggered from the console header.
- Add a persistent host identity banner across all server workspace tabs displaying host status with textual labels, agent state, `user@host:port` metadata in Geist Mono, provider/location badges, last seen timestamps, and quick action shortcuts.
- Add a compact resource telemetry strip displaying live CPU, RAM, Disk, Load Average, and RX/TX throughput gauges with threshold-based color progression.
- Add horizontally scrollable workspace navigation tabs with active lime indicators and smooth 240ms ease-out panel transitions via `motion/react`.
- Standardize interaction transitions to 160ms ease-out for hover, focus, and state feedback across all dashboard cards, tables, meters, job rows, and audit events.
- Update `MASTER.md` design system master specification with Section 6 covering the authenticated dashboard console contracts.
- Display `n/a` for missing network telemetry instead of implying measured zero traffic; hide the desktop fleet rail below `lg` so mobile navigation uses only the drawer.
- Verified frontend typecheck and production build, desktop/mobile browser rendering, fleet table/search, drawer open/close and Escape, and all host workspace routes. Runtime exposed Docker monitoring-off and terminal-disabled states; live container controls, SSH sessions, and populated telemetry were not exercised. The production bundle still triggers Vite's >500 kB chunk warning.

## Unreleased — parallel CI verification

- Run Node, installer, updater and Go checks independently of Docker image build/security verification after change detection. Keep identity checks, SBOMs and digest-based deployment mandatory.
- Reuse the runner's installed GCC for Go race tests, installing it only when missing, and preserve the existing `Verify` status-check name.
- Narrow Docker application build inputs and cache Go modules/compiler objects with BuildKit. Replace redundant standalone identity compilation in container CI with direct checks of both embedded binaries. Run pinned Trivy scans concurrently after one database download, using isolated in-memory analysis caches; retain all release gates and SBOMs.
- Split Node validation from Go/installer/updater/Compose validation into independent jobs. Keep Node 24 for updater config checks without npm installation; require the new Go check alongside all existing gates before publishing.
- Separate API/Web Docker compilation and cache scopes. Publish exact scanned images directly from the verification runner only after the authenticated current-attempt peer-job gate succeeds; remove image archive transfers and push both images concurrently without rebuilding.

## Unreleased — bundled updater CI verification

- Replace obsolete signed-manifest and source-text assertions in the updater CI gate with keyless bundled-install dry runs, generated systemd isolation checks, checksum and configuration rejection checks. Keep Go vet, tests and Linux compilation mandatory; the Trivy release gate is unchanged.
- Check out installer assets in the SSH deployment job and transfer updater scripts plus the CLI asset over the existing SSH connection, avoiding incompatible `scp` port options.
- Keep updater config validation compatible with the host Node runtime and permit only quiescent `restarted`/`rolled_back` helper journals while preserving recovery state. Reject active, pending, malformed and unknown states; do not replay updater installation through generic SSH retries.

## Unreleased — Termius-inspired natural-flow landing hero

- Replace the 200vh pinned hero storytelling scroll controller with a Termius-inspired natural-flow hero.
- Add an animated layered lime atmospheric aurora backdrop with radial gradients and subtle pulsing/drifting CSS keyframe animations, replacing heavy video backgrounds while staying true to the brand lime palette.
- Introduce a staggered one-time Motion entry reveal (`motion/react`) for hero eyebrow, title, subtitle, CTAs, and capability highlights.
- Implement a 3D perspective dashboard preview (1200px perspective on desktop, 800px on mobile) easing smoothly into a level alignment as it enters the viewport using Motion's `useScroll` and `useTransform`.
- Preserve all existing content, links, CTAs, caveat notices, keyboard focusability, and Features storytelling behavior.
- Support `prefers-reduced-motion: reduce`: static layout without initial entrance opacity hiding, static aurora glow without infinite CSS keyframe animations, and flat preview without scroll-linked 3D transforms.
- Remove superseded CSS attributes, scroll variables (`--scene-progress`), and the scroll affordance hint (`.landing-hero-scene-hint`).

## Unreleased — jsdom scrolling support

- Provide `Element.scrollTo` coordinate updates in the shared web test environment so mobile Features navigation can mount under jsdom. Production scrolling behavior is unchanged.

## Unreleased — Universal Features pinned storytelling on desktop and mobile

- Implement full stationary stage pinned storytelling universally across all viewport widths and heights on the landing page, inspired by reference stationary showcases.
- Desktop (>= 64rem) retains stationary two-column pinned stage (navigation list + synchronized realistic preview) with positive header clearance and measured proportional scaling (`transform: scale(--story-scale) origin top center`) when natural stage height exceeds available window height.
- Mobile (< 64rem) replaces the multi-article flow with a stationary single-column stage featuring an in-stage horizontal tab bar, real-time counter and progress bar, and single active feature description and preview, swapping all six steps in place via native document scroll.
- Apply measured proportional scaling universally on mobile and desktop without a minimum scale clamp, guaranteeing complete stage visibility without text clipping, overlap, wheel interception, or nested scroll traps.
- Unify native scroll progress calculations, target scroll offsets, and active tab scroll alignment across both viewport modes.
- Extend pinning to `prefers-reduced-motion` environments so stage geometry and step swaps remain identical while disabling transition animations and smooth scroll.
- Remove obsolete fallback rendering, dead static override CSS, and superseded mobile natural-flow scroll listeners.
## Unreleased — pinned dashboard preview grid

- Display sample hosts in the landing page's pinned dashboard preview as a two-column grid from 512px, preserving a single-column list on smaller screens and existing native scroll pinning. The live VPS dashboard is unchanged.

## Unreleased — Motion tooling

- Add `motion` to the web workspace for animation imports from `motion/react`.
- Install Motion AI Kit skills for OMP and OpenCode, and configure the hosted `motion` and `motion-plus` MCP servers in OpenCode. Motion+ requires account sign-in.

## Unreleased — read-only container logs independent of Docker management flag

- Make read-only container logs available by default for non-system VPS records in local mode without a new toggle. Read-only streams and the logs broker policy snapshot now depend on `logsSupported` (non-system VPS in local mode) instead of the management action capability or `dockerManagementEnabled`, and demo mode still reports unsupported with an explicit reason rather than faking a source.
- Keep `dockerManagementEnabled` defaulting to `false` and protecting confirmed `start`, `stop`, and `restart` actions; read-only log access does not authorize mutations. System VPS records remain excluded.
- Keep authentication, session/origin checks, authenticated agent credentials bound to the VPS, agent identity, and current inventory membership for the exact `agentInstanceId`/`containerKey` pair required for every stream, and keep log content out of jobs, audit, metrics, monitoring, and every JSON/PostgreSQL repository.
- Populate target discovery when management is enabled or logs are supported, and use `logsSupported` for both opening and ongoing stream policy checks. The logs broker policy snapshot contains only `logsSupported` and targets; Linux agent reads still require the real `/var/run/docker.sock` source and fail explicitly on unsupported transports.

## Unreleased — brand identity and logo integration

- Integrate supplied FlexServer brand identity assets while keeping original source art in `prompt-images/` (`logo.png`, `logo_with_name.png`) untouched. Add derived lossless assets in `packages/web/src/assets/brand/`: `flexserver-mark.webp` (256x246 mark), `flexserver-wordmark.webp` (960x216 wordmark), and `favicon.png` (64x64 PNG).
- Introduce shared identity components in `packages/web/src/components/Brand.tsx` with styling in `brand.css` (`BrandMark`, `Brand`, `FooterBrand`), replacing previous branding across all four public page headers and footers (`Landing`, `Pricing`, `Enterprise`, `Security`), the dashboard header (`DashboardShell`), the fleet sidebar (`FleetSidebar`), the login gate (`LoginGate`), and the document favicon in `index.html`.
- Enforce brand contrast rules: dark headers and sidebar surfaces pair the icon mark with live high-contrast text (`text-text`); the supplied dark-letter wordmark is rendered exclusively on a dedicated white backing plate (`.brand-wordmark-surface`) across dark public footers without recoloring or altering the original lettering. Retain existing layouts, responsive navigation, and focus styling without scope creep.

## Unreleased — public palette alignment

- Align the public pages' marketing palette with the dashboard by aliasing the existing dashboard semantic tokens: public shell aliases the charcoal surfaces/text tokens for all four public pages, with lime `--l-accent`/`--l-ok` for primary actions and emphasis, and dashboard-hued telemetry `--telemetry-cpu` (lime) and `--telemetry-memory` (cyan) kept without overrides.
- Update DESIGN.md palette wording accordingly: the landing reuses dashboard charcoal/lime tokens instead of its own navy/blue (`--l-blue`/`--l-violet`) tokens, Features uses a lime indicator, and the Enterprise hero is lime-lit.
- No changes to layout, behavior, accessibility, navigation, or dashboard UI/tokens; only the palette aliases on public pages are aligned.

## Unreleased — simplified public navigation

- Limit desktop and mobile top navigation on all public pages to Feature, Security, Pricing, and Enterprise, in that order. Preserve existing footer links, branding, and page action buttons.

## Unreleased — public security page

- Add `/security` with a shield hero, three overview cards, layered-control strip, and grouped security explanations with keyboard-focusable anchor targets. Describe implemented SSH trust, sessions, credential handling, API protections, optional terminal/Docker access, and operator responsibilities without unsupported certifications, encryption, uptime, or SLA claims.
- Add Security navigation/footer links across public pages and an API direct-load fallback. Collapse the expanded public navigation below 80rem to avoid crowding. Documentation and email CTAs work without authentication, forms, or fake report downloads.

## Unreleased — public enterprise page

- Add `/enterprise` with a blue-lit hero, value panels, alternating capability previews, security cards, deployment overview, FAQ, and email contact actions. All previews are labeled illustrative; copy describes existing self-hosted capabilities without invented customer metrics, certifications, SSO/RBAC, or SLA promises.
- Add Enterprise links to landing and pricing navigation/footers, and extend the API's public SPA fallback for direct loading. Contact emails include infrastructure requirement prompts; no Enterprise subscription, checkout, or backend form is introduced.

## Unreleased — public pricing page

- Add `/pricing` with Termius-inspired Free ($0), Plus ($3/month USD, Recommended), and Pro ($5/month USD) cards, a grouped comparison table, and native FAQ disclosures. Proposed limits are 2/5/15 servers, 24-hour/7-day/30-day metrics history, and 7-day/30-day/90-day audit history; all plans list one user and shared core security and server-management capabilities.
- Clearly disclose that these are proposed plans, their limits are not enforced, and paid subscriptions are not purchasable. Free links to deployment documentation; Plus/Pro and larger-plan actions open contact emails only. Hosting is not included; no billing, license enforcement, or checkout is introduced.
- Add Pricing to landing navigation/footer, keep the route public without dashboard authentication, and support direct loading through the API SPA fallback. Reuse the navy/blue landing palette with responsive cards and a horizontally scrollable comparison table on small screens.

## Unreleased — pinned feature scrolling

- Replace individually pinned cards with one Termius-style two-column scene: a left-hand list highlights and expands the current capability while a matching illustrative app preview appears on the right. Native scrolling selects all six features in order and reverses naturally; no wheel interception or new dependencies.
- Keep feature selection keyboard accessible and retain all descriptions and previews in normal flow on mobile, short viewports, reduced motion, or when the scene cannot fit. Preserve inline links, anchor clearance, and the existing hero effect.

## Unreleased — web CI test environment fixes

- Provide the missing `matchMedia` browser API in the shared jsdom setup so the public landing authentication-boundary test can mount its responsive scroll effect without changing production behavior.
- Wait for the deferred edit-server dialog's provider field before clearing it, removing the CI timing race while preserving the provider-clearing regression assertion.

## Unreleased — dark navy landing redesign

- Restyle the public landing in a Termius-style dark navy/blue palette scoped entirely to `.landing-page` in `pages/landing.css` via local tokens (`--l-bg`, `--l-panel`, `--l-raised`, `--l-line`, `--l-line-soft`, `--l-text`, `--l-dim`, `--l-blue`, `--l-ok`, `--l-warn`, `--l-violet`) with re-hued telemetry tokens, replacing the charcoal/lime marketing styles. Dashboard tokens, dashboard UI, and auth are unchanged; no new dependencies.
- Center the hero on a single-line regular-weight title ("Modern VPS Management"), a concise lead ("Server health, Docker and SSH jobs. One workspace, on your infrastructure."), docs-primary/GitHub-secondary actions, a compact centered capability row, then a wide rounded static preview card with a blue atmospheric glow; tighten hero spacing so the preview starts higher on desktop.
- Keep every landing invariant: all existing sections and anchor navigation, mobile menu/Escape/scroll lock, FAQ disclosures, contact email, external doc/repo links, and the no-hosted-account/no-public-demo caveat below the preview. No dashboard entry, signup, login, fetch, or `/vps` link.

## Unreleased — pinned hero storytelling on the landing

- Turn the landing hero into a native scroll-driven pinned storytelling scene on desktop: `.landing-hero-scene` becomes a 200vh scroll track with `.landing-hero-stage` as a `position: sticky` block pinned directly under the header, so the hero stays in view for the first scroll length while the rest of the document keeps scrolling normally. No wheel interception, no scrolljacking, no new dependencies; all content, CTAs, anchors, mobile menu/Escape/scroll lock, FAQ disclosures, and the auth/no-dashboard-entry contract are unchanged.
- Map scroll to a single CSS custom property (`--scene-progress`, 0..1) written from a `requestAnimationFrame`-throttled passive `scroll` listener plus one remeasure on `resize` and on `matchMedia` changes; never set React state during scroll. Hero copy and the capability row fade and drift upward directly from progress, and the console preview is absolutely positioned below the measured copy bottom with a 40px clear gap, then translates upward and scales into focus ~24px below the sticky header at `progress = 1`.
- Fit the full preview — console + caption + self-hosted caveat — inside the sticky stage at every supported desktop height (1000/900/768/640) using a measured fit scale (`--preview-start-scale`/`--preview-scale-delta`) and centering the final preview (`targetTop`), so nothing is ever clipped. Disable the scene (safe static stacked layout) when the viewport is under 600px tall or the console cannot fit at ≥60% scale.
- Keep the effect desktop-only and reversible: gate the pin on `matchMedia("(min-width: 64rem) and (min-height: 40rem)")` and `!matchMedia("(prefers-reduced-motion: reduce)")`, applying the `data-scene-active` attribute only when both hold and clearing all scene properties/attributes otherwise, so mobile, short viewports, and reduced-motion users get the original stacked flow with zero extra scroll distance and no 200vh track. Scroll-driven opacity/transform carry no time-based CSS transitions, so reversing scroll reverses the scene directly with no transition lag.
- Preserve hero copy accessibility during the transition: `:focus-within` on the hero copy restores full opacity, transform, and pointer events with a raised stacking context; pointer events stay enabled through mid-fade and are only disabled once progress ≥ 0.85 marks the copy as faded, so CTAs and links stay clickable without blocking the preview console.

## Unreleased — Docker realtime container logs

- Move realtime container logs from the Docker list page to a dedicated container detail page at `/vps/:vpsId/docker/containers/:agentInstanceId/:containerKey`: each container row in `DockerMetricsPanel` links to its own detail route (carrying the full `agentInstanceId` + `containerKey` pair, both URI-encoded), the detail page renders a "Back to containers" affordance, its own container metadata, and the confirmed `start`/`stop`/`restart` controls plus the bounded realtime log viewer, and the Docker list page (`/vps/:vpsId/docker`) no longer mounts the management panel so browsing the list opens zero log subscriptions.
- Keep the detail page bound to the container named by its URL: the target selector is replaced by fixed metadata, a container that is no longer in the server's current inventory is reported as unavailable with no log stream and no fallback to another container, and switching scope/container on the detail page clears the log buffer so a stream from a previous container can never deliver into another page.

- Replace the manual Docker log refresh with on-demand realtime viewing: opening the container log view subscribes automatically to its target's log stream, and the agent opens one Docker `GET /containers/{id}/logs` follow request that returns the last 200 lines and then continues live. There is no snapshot-then-follow pair, so the fixed 200-line tail is read exactly once and never replayed within a subscription.
- Stream logs over a dedicated SSE endpoint (`docker.logs.state`, `docker.logs.lines`, `docker.logs.closed`) backed by an ephemeral in-RAM broker (`DockerLogsService`, agent routes under `/api/agent/logs`). Log content stays out of `monitoring.snapshot`/`metrics.updated`, dashboards overview data, audit, jobs, metrics, and every JSON/PostgreSQL repository; there is no background collection, indexing, search, or download.
- Publish the monitoring exception explicitly: this is an approved on-demand exception to the Phase 1 no-log-ingestion rule, bounded at 4 KiB UTF-8 per line, 100 lines or 32 KiB per batch, 15-second keepalive, 30-second claim/ready, 10-second heartbeat grace, and a 2-hour subscription lifetime.
- Report failures with safe error codes only (`container_not_found`, `target_mismatch`, `daemon_unreachable`, `logs_unavailable`, `invalid_docker_stream`, `agent_unavailable`, `stream_lost`, `slow_consumer`, `session_expired`) and never surface daemon error bodies or log text.
- Bound the browser buffer to 2,000 displayed lines or 1 MiB, discard the oldest lines with a visible notice, throttle updates to at most one render per 100 ms, and render text-only with auto-scroll that yields to a scrolled-up reader plus a "jump to latest" control.
- Make reconnect an explicit new subscription: the browser `EventSource` never auto-reconnects, the displayed buffer is cleared, and Docker re-serves the latest 200 lines, so lines emitted during a network gap are not silently replayed.
- Require a matching rollout: demo mode reports `logsSupported: false` with an explicit reason, the agent log source is Linux-only over `/var/run/docker.sock` and fails explicitly elsewhere, an old agent shows `agent_unavailable` instead of fabricated lines, and an old API stops the agent logs worker without disturbing commands or metrics. Real Docker E2E verification is not claimed here.

## Unreleased — uniform fleet cards

- Remove the Docker section and monitoring toggle from fleet grid cards so Docker availability no longer changes card layout. Docker monitoring remains available in the individual VPS Docker page; fleet summaries are unchanged.

## Unreleased — Linux server icon

- Show a compact Linux penguin beside fleet card names when reported OS metadata identifies Linux; leave unknown and non-Linux systems unmarked.

## Unreleased — agent installer CLI smoke fix

- Move backend URL resolution into an undecorated shared module so the standalone agent installer can show `--help` from the repository root without loading NestJS services or requiring experimental decorator transforms. Preserve URL validation and API error behavior.

## Unreleased — compact VPS cards

- Keep fleet grid identity to server name, health and OS alongside live resource indicators and existing controls. Move connection, hardware, host ID, provider/location, tags, notes and runtime metadata to the individual VPS Overview's system details; table view and stored data are unchanged.

## Unreleased — agent backend URL cutover operations

- Document `flexserverctl set-backend <URL> [--mode auto|systemd|user] [--dry-run]` plus `flexserverctl validate-url <URL> [--updater]` and `flexserverctl help` in the README install section and `docs/local-agent-upgrade-operations.md` as the way to repoint an **existing** agent, with an explicit cross-reference that rerunning `install.sh --backend-url` (or the standalone installers) only sets the public setting and the default for newly written configs and deliberately leaves an already-installed config untouched rather than resetting its backend URL. No credential rotation is part of a URL change, so `--rotate` is never suggested for it. `--mode auto` is the default (systemd when root with a root-owned install, else user when `~/.vps-manager-agent` exists, otherwise a hint to pass `--mode`), while `--mode systemd|user` remain the only explicit forms; systemd rewrites `backendUrl` and `apiBase` only when the updater config exists, user rewrites `~/.vps-manager-agent/config.json` only; reading root-owned configs may need `sudo`; `--dry-run` is the only safe preview (no write, no stop, no start, no backup file; `dry-run: no changes applied`, exit 0) and `validate-url` has zero side effects.
- Document the migration URL policy: a migration target must be HTTPS and the updater `apiBase` stays `https`; validation is shape-only with no hostname allowlist or denylist, so DNS/TLS are settled by the health probe rather than a name check. Keep this distinct from the installers' URL allowance, which still accepts plain `http` for exact loopback (`localhost`, `127.0.0.1`, `[::1]`) for a fresh bootstrap install.
- Document the ordered transaction and verification: credential-free `GET <url>/api/health` (`User-Agent: flexserverctl/1.0`, system TLS verification, no redirect followed, bounded timeout/body and HTTP 200 + `{"ok": true}`) before any write; delivery preflight as `<agent> -config <cfg> -state <tempdir>/state.json -once -host-only`; same-URL apply still restarts the agent (and updater when installed) unit; updater in-flight guard requiring quiescent state (persisted settled helper record with phase `restarted` or `rolled_back` is permitted only when no daemon journal and no pending queue entries exist, while an active daemon run, pending entries, or corrupt/in-flight helper phase triggers refusal before mutation; updater daemon is stopped before the write and re-checked); on success the only on-disk artifact left behind is `.flexserverctl.bak`, which is deleted. Outcomes verbatim: `applied-with-heartbeat-confirmation-required`, `restored`, `rollback-failed`, `dry-run: no changes applied`; exit codes are `0` for success or a clean dry-run and `1` for any refusal, with pre-write refusals printing `Error: <reason>` to stderr and no `--yes`/`--force` override. A restart is liveness only — delivery is confirmed by a fresh parent-API heartbeat and updater proof is capped at `updater-process-observed`.
- Document rollback semantics: each touched config is restored from its `<config>.flexserverctl.bak` companion with the original bytes/owner/mode, the newly started loop is stopped, and the original loop is restarted with its preserved argv and cwd; backups are deleted only after a verified-successful restore and are retained deliberately on `rollback-failed` as operator recovery material. Endpoint or service recovery is not promised. Token preservation (never printed or rotated), config contents never logged, and rotation as a separate lossy bootstrap are documented alongside the installer CLI packaging surface (`/usr/local/bin/flexserverctl` by default, `--install-cli` default on, `--skip-cli`, `--cli-source`, `--cli-dest`, deliberately not removed by `--uninstall` since the CLI is shared tooling), the dashboard origin kept separate with deployment-dependent `TRUST_PROXY_HOPS`, and the canonical `AGENT_PUBLIC_BASE_URL`.
- Stable domain prerequisite documented: DNS must resolve, TLS must validate, and the reverse proxy must `proxy_pass` `/api/` (the cutover validation does not follow redirects). `api.flexserver.tech` DNS resolves and its HTTPS API origin is operational and verified, served through Nginx Proxy Manager with a managed certificate — it is an accepted backend URL once the health probe passes; `flexserver.tech` remains a working origin. Host cutover to `https://api.flexserver.tech` is verified (endpoint-only: `applied-with-heartbeat-confirmation-required` plus a fresh heartbeat); the canonical `AGENT_PUBLIC_BASE_URL` GitHub repo Variable persistently holds `https://api.flexserver.tech`. This does not verify the binary-upgrade production gate. Existing agents are not automatically migrated, so repoint each one explicitly with `flexserverctl set-backend`. No new docs files, no code or test changes.

## Unreleased — English landing with no dashboard entry

- Rewrite the landing page fully in English with expanded coverage: capability groups, audience and non-goals, a web/API/storage/agent architecture and data-flow overview, startup workflow, deployment options with demo/local limits, pre-adoption FAQ, and deployment CTAs.
- Remove every landing link to the dashboard: primary CTAs point to the deployment docs and secondary CTAs to the GitHub repository. Auth, API, and dashboard routes are unchanged.
- Set the landing `lang` to English with English metadata, keep the black/lime identity and the labeled static sample preview, and preserve mobile navigation, sticky-header anchor offsets, and reduced-motion support.

## Unreleased — FlexTechnology branding

- Update the company name to FlexTechnology and the contact address to `contact@flexserver.tech` across the landing page and SEO metadata.
- Add a direct GitHub repository link to the landing footer and point landing documentation/issue links to the current ArseneLupin0111 repository.

## Unreleased — landing clarity and Vietnamese access

- Rework the charcoal/lime landing hero, readable static preview, five benefit groups, startup workflow, mode explanation, FAQ and deployment CTA.
- Correct the public-demo promise: `/vps` retains local password protection; simulated demo requires a demo-mode deployment. Link deployment actions to the existing README instructions.
- Localize dashboard access, loading and errors into Vietnamese, add a home link, and keep credentials/session behavior unchanged.
- Improve mobile preview typography, keyboard focus, anchor offsets and responsive layouts without new dependencies. Keep authentication regressions behavioral instead of pinning incidental copy.

## Unreleased — SaaS landing page

- Add a Vietnamese FlexServer landing page at `/` for Sondoan Technology, with a sample console, feature overview, deployment workflow, accessible FAQ and `contact@sondoan.dev` contact links.
- Keep `/vps` behind the existing local-mode authentication; do not fetch dashboard data or start monitoring on the public homepage.
- Add responsive desktop/mobile navigation, keyboard focus states, reduced-motion support and an authentication-boundary regression test.

## Unreleased — proxy address security patch

- Override and lock `proxy-addr` to 2.0.8 for Express consumers, fixing CVE-2026-90711 / GHSA-jqcg-44mw-7w3h (client-IP spoofing through short IPv4-mapped IPv6 trust prefixes).
- Keep the fixable-CRITICAL image security gate unchanged; the dependency patch replaces the vulnerable 2.0.7 package reported in the API image.

## Unreleased — Overview operational clarity

- Separate host health, recent job outcomes and container counts; show recent failed-job notices with a Jobs link, while treating non-running containers neutrally with a Docker link.
- Make Overview audit events readable without truncated identifiers or redundant server columns; retain full metadata in the details drawer.
- Increase secondary-text contrast and use explicit binary capacity units across host and Docker views; remove the duplicate Overview byte formatter.
- Show failed-job completion percentage, failure reason and finish time instead of an active progress bar; omit missing worker/duration metadata and replace the developer-facing network hint.
- Compact status cards, let recent jobs size to content, move static system facts below activity, and display the CPU model only once.

## Unreleased — scripts directory layout

- Group operational scripts into `agent/`, `vps/`, `admin/`, and `install/`; retain `ci/`, `release/`, and `tests/`.
- Update npm commands, CI filters, installer download URLs, relative imports, shell checks, and operator instructions to the new paths. npm command names and production `dist/scripts/` paths are unchanged.
- Restore the tracked executable bit on `scripts/install/install-updater.sh` after relocation so Linux bootstrap smoke checks and documented direct invocation do not fail with `Permission denied`.

## Unreleased — Recharts telemetry charts

- Replace custom SVG history charts for CPU/RAM, network RX/TX, and Docker CPU/memory with responsive Recharts components; resource meters remain unchanged.
- Add unit-aware hover and keyboard tooltips, numeric timestamp axes, and readable percentage/throughput/memory labels using the existing dark telemetry palette.
- Preserve missing samples as gaps and real zero values; retain empty/loading/error states, Docker coverage metadata, and single-sample indicators.

## Unreleased — compact agent status

- Reduce fleet cards to agent/access status, a short version, and one update badge; omit repeated labels, heartbeat text, commit hashes, and completed upgrade confirmations from compact card/table summaries.
- Keep active upgrade progress and recovery warnings visible; retain full build identity, heartbeat details, and upgrade history in workspace settings and confirmation dialogs.
## Unreleased — overview operational clarity

- Keep the breadcrumb header in document flow so it does not obscure overview cards when scrolling or capturing a full page; retain the sticky fleet sidebar.
- Label workspace health as host status, separate from job outcomes, and show an overview failure summary linking to the failed-jobs filter.
- Show recent job timestamps, available failure messages and log links, with explicit failed-at progress and a neutral zero-running badge.
- Reduce overview audit rows to Time, Event, Result, and Details while retaining the full audit filters and details drawer.

## Unreleased — Docker ingest replay recovery

- Use receive-time-independent ingest digests so retained agent batches can retry after a lost acknowledgment.
- Authenticate previously committed digest-v1 batches using their original ledger receipt time, identity, sequence, and committed watermark; changed bound payloads remain conflicts. No database migration or agent checkpoint reset is required.

## Unreleased — host metric charts

- Project bounded per-VPS CPU, memory, RX, and TX history into metrics, dashboard, and live monitoring responses.
- Standardize Go and local Linux network collectors on explicit bytes-per-second rates; mark first samples and counter resets unavailable rather than plotting false zero/spikes.
- Persist network units and availability in JSON and PostgreSQL (migration `022_metric_network_fields.sql`).
- Connect overview and metrics charts to timestamped same-host history, with separate RX/TX series, gap handling, and unit-aware readouts.
- Handle bounded SSE snapshots containing `refreshRequired` by reloading dashboard data over HTTP instead of dereferencing an absent overview and crashing after login.

## Unreleased — reference dashboard design

- Restyle FlexServer using the supplied VPS Management Dashboard reference: ink/lime palette, compact header, square panels, fleet cards/table, and workspace tabs.
- Align overview, metrics, Docker monitoring, jobs, audit, terminal, settings, forms, and overlays with shared design tokens while retaining API-backed controls and access restrictions.
- Keep missing telemetry explicit instead of presenting unrelated metric history as memory or network data.

## Unreleased — CI/CD optimization

- Scope PR checks through a lightweight change-detection job; keep the full verification matrix on main and honor manual force-build inputs.
- Run database integrations alongside verification, generate SBOMs only for publishable main runs, and avoid redundant standalone Node/Go builds.
- Transfer checksummed, verified Docker images to publish without rebuilding; verify loaded image identities and deploy the pushed digest references.
- Fix fail-fast migration asset smoke checks and grant change detection the pull-request read permission it requires.

## Unreleased — local agent upgrade

- Add bundled binary local agent upgrade architecture: Linux amd64/arm64 agent and updater binaries are packaged directly in the deployed API image, served over HTTPS with scoped credentials, SHA-256 verification, and updater protocol v2, eliminating manual Ed25519 signing keys and external catalog requirements for local updates.
- Add a separately installed, pull-only host updater with scoped credentials, protocol v2 support, in-place migration (`--upgrade`), a constrained privileged helper, durable journal, lease/fencing, SHA-256 artifact verification, automatic rollback, and backup retention when recovery is unverified.
- Add persistent local-upgrade jobs for JSON and PostgreSQL, admin confirmation and audit, idempotent outcomes, and fresh-heartbeat verification before success or verified rollback.
- Show installed build, release availability, updater health, manual instructions, confirmation, durable progress, and recovery guidance in local VPS card, table, and workspace views. Remote SSH upgrades remain separate.
- Harden installer signature gates, updater credential rotation, post-swap failure handling, filesystem boundaries, and confirmation-dialog focus restoration.

Production rollout is **not yet verified**. Local smoke verification passed using simulated updater and heartbeat processes, not live production systemd hosts. Complete the disposable Linux staging and fault-injection gate in `docs/local-agent-upgrade-operations.md` before performing an authorized production canary. API/web deployment alone does not replace the host agent on disk.
