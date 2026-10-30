# Agent delivery and host updater migration runbook

Agent and AI runtime binaries ship inside the deployed API image. There is **no host updater** in this release line: no `vps-updater` daemon, no `vps-updater-apply` privileged helper, no scoped `local-updater` pull channel (`/api/local-updater` is gone), and no updater credentials. Host state transitions to agent-only delivery.

## Current delivery model

- **Agent binaries:** Linux amd64/arm64 agent binaries remain packaged in the API container (`/app/agent/vps-agent-linux-amd64`, `vps-agent-linux-arm64`), together with the per-arch helper binaries (`host-pty`, `local-agent-rotator`, `host-files`, and the AI bundle under `/app/agent/ai/`). Hosts receive them by running the installer from the extracted bundle, not by a pull daemon.
- **Local hosts:** run `sudo bash scripts/install/install.sh` on the host; it extracts the bundled artifacts, installs the host systemd agent, and installs the AI runtime by default (`--skip-ai` opts out; there is no `--enable-ai`). `deploy.sh` only prints this command as a pointer; it does not run the installer.
- **Remote hosts:** agents and the AI bundle are installed/updated over the VPS's saved SSH credentials. The SSH channel is the only remote transport; the updater-based install channel was removed with the updater.
- **AI runtime:** image path `/app/agent/ai/` bundles both-architectures binaries, digest-pinned BusyBox rootfs tarballs/manifests, service profiles, and `install-local-agent.sh`. Installing the agent includes AI by default (`--skip-ai` opts out on the local installer). On remote hosts, a deliberate AI policy change (enabling AI or shell, changing `execMode`, or changing `executionMode` to YOLO) can trigger first installation over saved SSH credentials; there is no separate AI bundle update action in VPS Settings. On the local/system host, run `sudo bash scripts/install/install.sh` to update the agent and AI runtime together. Deploying a newer image alone does not update hosts.
- **Safety invariants retained:** installed build is verified against the bundled build identity; unchanged agent build identities do not trigger restarts; missing host access is reported as `needs_access` (not silently skipped); failed targets are suppressed until manually retried; API containers hold no host root and no Docker/systemd socket. Nothing installs or restarts on a host without an explicit operator action.
## Host state cleanup: migrating an existing host off the updater

Each host that previously ran the updater needs a one-time manual migration. Do it **before** revoking the updater credential on the API side, while the credential still exists as a recovery path. All commands run as root on the host.

### 1. Drain in-flight work — never kill a mid-swap helper
An interrupted privileged swap can leave the agent binary replaced but the journal unsettled. Refuse to stop the system until the host-side state is settled:

```bash
/usr/local/lib/vps-manager-agent/vps-updater status -config /etc/vps-updater/config.json
ls /var/lib/vps-updater/pending/          # must be empty
test ! -f /var/lib/vps-updater/journal.json -o -z "$(cat /var/lib/vps-updater/journal.json 2>/dev/null)" # no live daemon run
test ! -f /var/lib/vps-updater/helper/journal.json || grep -qE '"phase":"(restarted|rolled_back)"' /var/lib/vps-updater/helper/journal.json
systemctl status vps-updater-apply.service
```

Settled means: no pending queue entries (`pending/` empty), no active daemon journal run, and the helper journal phase is `restarted` or `rolled_back` (or absent). If `rollback_unverified` conditions hold (the previous binary was not confirmed via fresh heartbeat), perform the manual recovery from the backups under `/var/lib/vps-updater/helper/backups/<jobId>/` before proceeding: restore the confirmed-good binary, restart `vps-manager-agent.service`, and verify a fresh heartbeat with the restored build ID. Do not delete backups or blindly retry a swapped mutation. Backups on hosts whose last job settled cleanly are covered in step 4.

### 2. Stop and disable the updater units

```bash
systemctl disable --now vps-updater-apply.path vps-updater-apply.service vps-updater.service
systemctl daemon-reload
```

`vps-updater-apply.path` goes first so nothing can trigger the helper (including a pending action that survived step 1) while the other units stop. Only after all three are inactive is it safe to remove anything.

### 3. Remove the updater footprint (preserve backups and required state)

Remove:

```bash
rm -f /etc/systemd/system/vps-updater.service /etc/systemd/system/vps-updater-apply.service /etc/systemd/system/vps-updater-apply.path
rm -rf /var/lib/vps-updater/staging /var/lib/vps-updater/pending
rm -f /usr/local/lib/vps-manager-agent/vps-updater
```

Preserve — these are not updater-only:

- `/var/lib/vps-updater/helper/backups/` — prior agent binary generations; retain the current and previous generations until the host has been re-verified on the bundled build, then archive and remove them together with the rest of the state if desired. Do not delete them while any job's rollback is unverified.
- `/var/lib/vps-updater/helper/journal.json` — historical operation record; keep until you are satisfied backups are no longer needed, then remove with the state directory.
- `/etc/vps-updater/config.json` — contains the scoped updater credential. Do not learn the token from it for anything else; retire it explicitly (step 5) rather than reusing updater credentials in the agent, which must remain separately scoped.
- `/etc/vps-updater/fleet-release.pub` — legacy signed-fleet trust anchor. The fleet-release rollout path for `agent`/`updater` artifacts no longer accepts them; remove the key whenever host trust is re-anchored through the API image bundle. If any signed AI-only manifests are still honored in your deployment, keep it until that trust is migrated alongside the AI-health evidence re-sourcing.
- `/var/lib/vps-updater/updater_heartbeats`-equivalent durable records embedded in the API's `updater_heartbeats` table carried AI component/health evidence (`installed_ai`, `ai_health`) as the sole source for signed AI runtime rollout eligibility. Replacement evidence sources must exist before these records are dropped server-side; file-side state removal does not affect them.

Repeat `systemctl daemon-reload` after removing units. Verify no `vps-updater` processes remain (`pgrep -af vps-updater`) — a live but daemonized helper outside systemd ownership is a real risk; kill it only after its journal phase check has settled.

### 4. Verify the agent is intact and delivered by the bundled identity

```bash
/usr/local/bin/vps-manager-agent -version
systemctl status vps-manager-agent.service
journalctl -u vps-manager-agent.service -n 50 --no-pager
```

And on the dashboard, confirm the agent's heartbeat reports a fresh build ID matching the current bundled binary. If the agent's on-disk build does not match the bundled identity (e.g. the last updater run rolled back to an older binary), replace it from the bundled artifact just like a manual upgrade, keeping the SHA-256 and `-version` verifications; do not re-enable the updater for it.

### 5. Revoke updater credentials only after the host daemon is gone

Server side (API host):

1. Verify the host's updater no longer polls and the agent is delivering fresh metrics — the updater credential should be idle-only. Do not purge while jobs reference it as a recovery path.
2. Revoke the updater scope credential for that host. No shipped command supports updater-scope revocation (`revoke-agent-credentials` accepts only `--scope agent`, the default, and requires `--keep-credential-id` of an active agent-scope credential), so revoke the updater-scope rows manually and non-destructively in the credential store. Legacy `local-updater` rows may not exist at all in your deployment; skip the store change if the queries below return none.
   - **PostgreSQL** (Docker Compose/Postgres deployments), run inside one transaction so verification and revocation are atomic, with the real VPS id substituted for `<vps_id>`. Set `status='revoked'` and `revoked_at=NOW()` — never `DELETE`; other statements in this runbook treat those rows as an operation record. Only rows whose `scope='local-updater'` are touched; agent-scope rows stay untouched, so the live agent keeps authenticating via bearer verification independent of the updater-credential revocation.
     ```sql
     BEGIN;
     SELECT id, vps_id, status, scope FROM agent_credentials
       WHERE vps_id = '<vps_id>' AND scope = 'local-updater' AND status = 'active';
     UPDATE agent_credentials
        SET status = 'revoked', revoked_at = NOW()
      WHERE vps_id = '<vps_id>' AND scope = 'local-updater' AND status = 'active';
     COMMIT;
     ```
     Substitute the real VPS id for `<vps_id>` in both statements. Verify the `SELECT` shows only updater-scope rows before committing.
   - **JSON storage** (direct source runs): stop the API process first so no in-flight writer races your hand edit (`withFileLock` in the repository only serializes writes among repository callers — a concurrent process can still interleave once your editor releases the file). Then back up `DATA_DIR/agents.json`, edit it to set `status` to `revoked` and `revokedAt` to the current timestamp on each `local-updater` entry for that VPS id, and restart the API after the atomic rename-on-write completes. agent-scope entries stay untouched. The stored secret is a SHA-256 hash, so the raw token is not recoverable from it either way.
   - In both stores the row/entry stays put and the token stops authenticating; scopes stay independent, so the host's live `agent` credential keeps working.
3. Any remaining `local-updater` rows kept for rollback support should be revoked last, explicitly and only when configuration/staging/journal footprints on that host have been confirmed removed. The `agent_credentials` scope column stays as-is under migration 021 (`text NOT NULL DEFAULT 'agent'`, no CHECK constraint); only updater-scope row *statuses* change, and nothing deletes the table or its rows here (`agent_states.build_id` is the separate heartbeat build-identity column from the same migration and is unrelated).
4. Rotation offers no cleaner path: no `rotate-agent` flow can help here — `AgentRotationService` refuses non-local/non-system hosts, issues only fresh `agent`-scope credentials, and explicitly scopes its revocation to prior `agent`-scope rows, so it never touches the updater credential. No `--rotate`/`--keep-previous` overlap flow exists in `revoke-agent-credentials.ts` for updater-scoped credentials either. So there is no supported rotation that re-arms the updater; close this out with step 2's revocation instead. An updater that fails authentication because the credential was revoked but whose units are still enabled will retry forever and fail closed — finish step 2–3 on the host so it exits.

## Deployment automation changes

- `scripts/install/prepare-agent-updater.sh`, `scripts/install/install-updater.sh`, and `scripts/install/install-fleet-updater.sh` are removed; `scripts/deploy.sh` no longer runs host updater preparation. A healthy dashboard deploy is the acceptance condition and no longer depends on host updater state.
- `scripts/install/install.sh` and `scripts/install/install-local-agent.sh` no longer provision updaters, generate updater credentials, or forward `--fleet-release-pub-key`; their help output no longer references the updater runbook.
- `flexserverctl set-backend` no longer validates a `/etc/vps-updater/config.json` updater `apiBase` leg and no longer has the updater quiescence guard — cutovers act on the agent config alone.
- CI no longer compiles or tests `vps-updater` artifacts; release manifests no longer require an agent/updater pairing.

## Manual integrity verification (replaces the updater confirmation loop)

After any host agent replacement — dashboard-driven or manual — confirm end-to-end:

1. `vps-manager-agent -version` matches the bundled release identity.
2. A fresh heartbeat carrying that build ID arrives within the grace deadline (bundled identity, version freshness, and heartbeat age are visible in per-VPS Settings).
3. Local Docker snapshot `source_sequence` advances and chart samples for CPU/RAM, RX/TX add at least two fresh points.
4. On normal failure of a restarted agent, manual rollback restores the prior binary from your archived backup and is confirmed the same way (fresh heartbeat carrying the restored build ID). There is no automatic rollback without the updater; a failed restart leaves the service down until an operator intervenes. Schedule host changes in a window where you are present to observe the first restart.

## Durable AI multi-plan loop operations

The `executionVersion: 2` loop is durable state, not a browser callback. Manual mode is the default: every mutation plan on every continuation turn requires approval of the exact `planVersion` and `planDigest` through the dashboard/API. Do not reuse an approval after the plan digest or version changes. YOLO is a separate, explicit root-consent mode: enabling `executionMode: "yolo"` requires `acknowledgeYolo: true`, records the acknowledging admin session, and applies full host-root execution only to the selected VPS. YOLO does not grant provider egress; `sendLogsToProvider` and `sendFilesToProvider` remain independent opt-ins.

### Restart, scheduler, and cutover behavior

- `AiTaskService.onModuleInit()` awaits one immediate continuation sweep, then schedules a five-second interval. Each sweep is single-flight and atomically claims at most 100 eligible loop tasks using `claimPendingContinuation({ ownerInstanceId, leaseSeconds: 60 })`; every service has its own UUID owner. `planning`/`verifying` tasks with continuation ready or a missing/expired turn lease are eligible, while `cancel_requested` tasks are excluded. Claimed tasks renew the lease every 15 seconds; `run(..., alreadyClaimed=true)` skips a duplicate turn claim. Missing `initiatingSessionId` fails closed as blocked `missing_initiating_session`; sweep errors are caught/logged. Repository claims prevent duplicate live ownership across API instances.
- On shutdown, the scheduler timer is cleared and in-process controllers are aborted. A command already dispatched is not assumed to have stopped: wait for its receipt and preserve the receipt/accounting.

### Failure, cancellation, and no-progress handling

- An expired execution lease without a receipt, an uncertain receipt, or an indeterminate result after host execution transitions the loop to `uncertain` and fences further mutation. Never retry or re-dispatch that step blindly; reconcile the host and receipt first.
- Cancellation before dispatch prevents a new dispatch. Cancellation after dispatch requests termination where supported but does not erase the outbox entry or receipt. A successful receipt after cancellation is recorded with `cancelled_after_dispatch`; an uncertain post-execution result remains `uncertain`.
- Durable counters survive restart/resume. Three consecutive identical tool/target/result fingerprints terminate the task as `failed` with blocked completion `reasonCode: "no_progress"` (`no_progress3`); do not work around this by repeatedly polling or issuing a compensating mutation.

### Evidence and rollout gate

The verified evidence now comes from the clean acceptance artifact: web suite (290 tests), desktop/mobile fixture actions, API loop acceptance final results (166 passing, 0 failed, 0 pending across 12 files), security coverage, PostgreSQL loop coverage (12 passing), PostgreSQL migration 037 proof, and web typecheck. Startup scheduler regressions pass for persisted `continuationReady` recovery, concurrent `onModuleInit` single-flight behavior across two services, exactly-once provider dispatch, and task completion without a manual wake. Authorized disposable-host runtime proof is complete: manual task `b746e91c-f270-4c8b-925a-5e9d823df411` required exact approvals v1/v2, treated restart unhealthy `500` as not verified, then verified repair with fresh `200`; API SIGKILL/restart preserved task plan and receipts without replay; YOLO task `a2a29902-c62b-4916-b27d-41f3af97c443` completed two auto-approved plans with successful actual-host UID 0 markers. This was a scripted-orchestration proof, not a real-provider run. Real-provider credentials remain absent, so real-provider readiness is still pending.

## Incident checks (updater remnants)

If dashboard-side paths (agent update status that referenced updater endpoints) appear stale or error with a 404 on `/api/local-updater/*`, the API and web views already reflect removal; manually-triggered retry actions against remaining updater-era hosts report the host's real state through saved-SSH operations only. Consequently no dashboard action button starts a pull updater upgrade.

Operational guard retained from the prior runbook: do not terminate an in-flight update or delete the running journal/backup to make progress — resolve state, then act. Manual confirmation and credential handling rules above stay authoritative in `docs/security.md`.
