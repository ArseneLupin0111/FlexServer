# Security Model

## Runtime Modes

- `APP_MODE=demo`: public portfolio mode. Seeds simulated servers, metrics, jobs, audit events, and terminal output. Real SSH and real terminal network access are disabled.
- `APP_MODE=local`: self-hosted local mode. Dashboard access requires an HttpOnly session cookie obtained by logging in with the DB-backed admin password (set via `npm run set-dashboard-password`). Real SSH remains behind host policy and explicit configuration.

Invalid modes fail during config parsing. `ENABLE_WEB_TERMINAL=true` is rejected unless `APP_MODE=local`.

## SSH Safety

Demo mode throws before any real SSH provider call. Host policy blocks metadata/link-local targets, localhost, and private-network targets unless local mode explicitly allows private targets.

The demo terminal is read-only canned output. It has no command input, no socket, no transcript persistence, and no path to `ssh2`.

## Secrets

Passwords are accepted only in provision-key request bodies. They are never stored in `localStorage`, `sessionStorage`, IndexedDB, cookies, public assets, backend JSON files, logs, or API responses.

Private keys remain under `private/keys/`. Public/private key material is not displayed by the dashboard and is not returned by API responses.

## HTTP Safety

The backend disables `x-powered-by`, adds request IDs, applies Helmet security headers with a restrictive Content Security Policy (`default-src 'self'`, `frame-ancestors 'none'`, with explicit Google Fonts allowances), rate-limits mutations, normalizes errors, and redacts secret-looking metadata before audit persistence.

Rate limiting uses a pluggable store. In JSON/demo mode, an in-memory fixed-window store tracks limits per process. In Postgres mode, a shared `rate_limit_buckets` table provides atomic per-IP buckets across instances. On store error, the limiter fails closed with HTTP 503 and a standard error shape (including `requestId`). Sensitive mutation routes (`/api/vps/*`, `/api/agent/*`) and the login endpoint each have independent rate-limit counters, scoped by IP. Agent metric ingestion receives a 5× higher limit multiplier.

The nginx reverse proxy adds matching CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a restrictive Permissions-Policy for frontend static assets.

Static serving is limited to root `public/`; `data/`, `private/`, `packages/api/`, and `packages/web/` are not exposed.

### Host agent Docker metrics access

The host systemd agent is installed without Docker access by default. The installer never changes Docker socket permissions, adds a root agent, or mounts `/var/run/docker.sock`. Docker metrics are an explicit opt-in:

```bash
sudo ./scripts/install/install-local-agent.sh --binary /tmp/vps-agent --config /tmp/agent-config.json --enable-docker-metrics-access
```

This option fails closed unless the host has a `docker` group, and adds only `SupplementaryGroups=docker` to the generated unit. Membership in the Docker group is effectively root-equivalent: a process with access to the Docker socket can start a privileged container and access the host filesystem. Enable it only when this risk is accepted and Docker metrics are required.

To revoke access, remove the option from the unit by reinstalling without it, or remove the unit and reinstall the agent:

```bash
sudo systemctl disable --now vps-manager-agent
sudo ./scripts/install/install-local-agent.sh --binary /tmp/vps-agent --config /tmp/agent-config.json
sudo systemctl daemon-reload
sudo systemctl restart vps-manager-agent
```

Troubleshooting: `getent group docker` confirms whether the group exists. If the opt-in install reports that it is missing, install/configure Docker first or omit the flag. Check the generated unit with `systemctl cat vps-manager-agent`; the default unit must not contain `SupplementaryGroups=docker`. Docker metrics can remain disabled in the dashboard without granting host Docker access.

### Host agent Docker v2 state

Managed local installs retain a root-owned `docker-identity.json` (`0600`) and service-user-owned `runtime-keys.json` (`0600`). Remote installs with root or passwordless sudo use the same split ownership. Without sudo, a fresh remote install creates both files as the SSH user (`0600`); that user can then replace its own identity, so this mode does not provide root-enforced identity integrity. Upgrades preserve an intact user-owned pair after validating its contents and match. For an existing root-owned identity and user-owned runtime keys, a no-sudo upgrade leaves both files untouched and checks file type, mode, owner and nonempty contents; the subsequent agent preflight validates runtime state. The SSH user cannot verify the cryptographic identity/runtime match without reading the root-only identity, so privileged provisioning is still needed to verify that relationship. Missing or partial state fails before replacing a running agent; an identity is never intentionally rotated during upgrade.


### Agent Singleton Lock and Remote Service Supervision

To prevent duplicate running instances, telemetry collisions, and conflicting background collectors:
- **Trusted Linux Namespace**: The agent locks `/run/vps-manager-agent/vps-agent-${sha256(vpsId).toLowerCase()}.lock`. On Linux, this path is fixed; no environment variable overrides or fallback directories (such as `/tmp`) are permitted.
- **Directory and File Invariants**: The directory `/run/vps-manager-agent` is root-owned (`UID 0`) with mode `0755` (strictly verified `perm & 0022 == 0`, rejecting group- or other-writable directories). The lock file is a root-owned regular file with mode `0666`.
- **System Call Hardening**: The lock file is opened using `syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK` and verified via `f.Stat()` as a root-owned regular file, mitigating symlink traversal, descriptor leakage to child processes, and hangs on unexpected FIFO nodes.
- **Tmpfiles Provisioning (No RuntimeDirectory)**: Unprivileged agents executing under dedicated service accounts cannot create the root directory or file; they must be provisioned ahead of time via `/etc/tmpfiles.d/vps-manager-agent.conf` and `systemd-tmpfiles --create` (or during installer bootstrap). The service unit must **not** use `RuntimeDirectory=`; systemd's `RuntimeDirectory=` directive automatically transfers directory ownership to the service's unprivileged `User=`, which would violate the trusted root-ownership invariant. Unprivileged instances fail closed actionably if tmpfiles provisioning is missing.
- **Kernel Flock Concurrency**: Mutual exclusion is acquired via non-blocking exclusive flock (`syscall.Flock(fd, LOCK_EX|LOCK_NB)`). The inode is held for the lifetime of the process. On process exit or unhandled crash, the Linux kernel automatically cleans up the flock descriptor. The lock file is **never** unlinked or truncated on release or exit, ensuring all competing processes contend on the exact same filesystem inode across restarts without race windows.
- **Contention with One-Shot Modes**: Invoking `vps-agent ... -once` acquires the exact same non-blocking OS lock as the long-running daemon. If another process is running for the VPS, `-once` exits immediately with `instance lock error: agent already running for this VPS`.
- **Offline Preflight Validation**: Staged candidate upgrades avoid lock contention by running `<candidate> -config <path> -validate-config`, which loads and validates configuration syntax and required fields without acquiring the singleton lock, contacting the network, or mutating state.
- **Local vs Remote Service Naming**: Local host agent installations retain the canonical service unit name `vps-manager-agent.service` (`/etc/systemd/system/vps-manager-agent.service`) to preserve compatibility with the pull-only local updater daemon (`vps-updater`). Only remote SSH managed agents use the per-VPS deterministic hashed unit name `/etc/systemd/system/vps-agent-${sha256(vpsId).toLowerCase()}.service`.
- **Remote Service Lifecycle and Process Cleanup**: Remote Linux agents run under system-level systemd service management (`/etc/systemd/system/vps-agent-${sha256(vpsId).toLowerCase()}.service`) running as `User=<user>`, `Group=<group>`, with `WorkingDirectory=<homeDir>`, `Restart=always`, `RestartSec=10`, `TimeoutStopSec=15`, and `KillMode=control-group`. `KillMode=control-group` provides clean descendant process termination and signal delivery upon stop or restart to avoid orphaned workers; it is process lifecycle cleanup, **not** a security sandbox, privilege boundary, or container isolation. Sudo is required for service setup and lifecycle operations; no unprivileged `nohup` fallback is permitted. Legacy PID files (`~/.vps-manager-agent/vps-agent.pid`) and exact argv matching are used solely as a safe migration path to transition existing nohup background loops to systemd; unknown processes or PID mismatches are never terminated indiscriminately.
- **Single-Host Production Verification**: Verified operational on Azure host `vps_kUq9jDFzAtxY` running systemd service `vps-agent-e3d0757876c6e2baf8d0044daa30b1218070930aa38f83de4112794e7eceeb5a.service` (`User=doanphamthanhson`, build `867941df81e769e07db86edcf9e4314101889735`), confirming non-blocking lock contention rejection for duplicate `-once` invocations, stable lock inode retention across `systemctl restart`, and offline `-validate-config` execution leaving live PID unchanged. Fleet-wide rollout across remaining remote hosts remains unverified.
- **Diagnostic Stubs Audited**: Two diagnostic stubs observed under `/tmp` were verified via SHA-256 and disassembly as tiny 4624- and 4680-byte test binaries executing pause syscall loops; they were terminated via pidfd, confirmed not to be real agents or causes of upgrade timeouts, and no incident root cause is attributed to them.

### Fleet and Local Agent Updater Security Architecture

To prevent unauthorized binary substitution, privilege escalation, and unintended service disruption during safe-upgrades:
- **Privilege Separation & Hardened Daemon Sandbox**: The updater daemon (`vps-updater.service`) executes as dedicated unprivileged system user and group `vps-updater:vps-updater`. The systemd service unit enforces `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `InaccessiblePaths=/etc/vps-manager-agent` (preventing access to agent tokens, certificates, and Docker identity state), `ReadWritePaths=/var/lib/vps-updater`, and an empty `CapabilityBoundingSet=` dropping all Linux capabilities.
- **Constrained Root Helper with Fixed Argv**: Privileged host mutations (binary replacements, unit restarts, multi-component upgrades) are delegated to the root helper (`vps-updater-apply.service`). The helper runs as `root:root` with a bounded `CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_CHOWN` (strictly constrained to DAC traversal and ownership preservation across legacy user-owned home binary paths, while dropping all other capabilities) and a strictly fixed argv (`ExecStart=/usr/local/lib/vps-manager-agent/vps-updater helper -config /etc/vps-updater/config.json`). The helper is triggered asynchronously via `vps-updater-apply.path` monitoring `DirectoryNotEmpty=/var/lib/vps-updater/pending`.
- **IPC Security & Path Traversal Prevention**: The unprivileged daemon cannot pass commands, file paths, or service unit names to the helper. File inputs in `stateDir/pending/` enforce strict alphanumeric job ID formats (`^[A-Za-z0-9_-]{1,64}$`) preventing path traversal.
- **Filesystem & Symlink Hardening**: The helper verifies that `/var/lib/vps-updater/helper` and its backup directories are root-owned regular directories (`requireSecureDir`), fail-closing if an unprivileged process attempts to redirect writes via symlinks.
- **Signed Release Manifest Envelopes**: Fleet release manifests are packaged into an immutable signed envelope (`{ payload: "<raw UTF-8 JSON>", signature: "<base64 Ed25519>", keyId: "<keyId>" }`). Ed25519 signature verification operates directly on exact payload UTF-8 string bytes without recanonicalizing, immunizing against JSON key-reordering and whitespace canonicalization attacks. Manifest payloads require `schemaVersion: 1`, `channel: "stable"`, matching 40-hex commit hashes for `releaseId` and `buildId`, semver version formatting, and allowlisted components (`agent`, `updater`, `ai-executor`, `ai-host-helper`, `ai-rootfs`, `ai-profiles`).
- **Offline Pinned Public Key**: The Ed25519 release verification public key is pinned offline on the host at `/etc/vps-updater/fleet-release.pub` (`0644 root:root`). Provisioned via `--fleet-release-pub-key <path>` in `install-local-agent.sh` (forwarded as `--pubkey-file` to `install-updater.sh`). Keys are never downloaded dynamically over the network; verification fails closed if the key file is missing, corrupted, or untrusted.
- **Artifact Allowlisting and Validation**: Download URLs must use HTTPS without userinfo or custom ports and match the hardcoded hostname allowlist (`github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`). The downloaded binary is validated against the exact SHA-256 digest and expected byte size declared in the signed manifest.
- **Fleet Protocol 3 & Host Idle / AI Health Evidence Boundary**:
  - Updater requests use `X-Updater-Protocol-Version: 3` and `User-Agent: vps-updater/3` over outbound HTTPS with scoped bearer credentials (`Authorization: Bearer vma_<credentialId>_<secret>`, scope `local-updater`). Foreign VPS IDs or invalid scopes return `403 Forbidden`.
  - When claiming jobs, protocol 3 updaters report telemetry evidence: host platform (`os`, `arch`), updater version identity, host idle status, and AI subsystem health.
  - Host idle detection inspects Compose/Docker exclusion locks (`/var/lib/vps-manager-agent/docker-applications/exclusion.json`), active host-pty terminal sessions (`/var/run/flexserver/host-pty/active-sessions.json`), and active AI task execution locks (`/var/run/vps-ai-tasks/active-tasks.json`). If any lock is active or the exclusion registry cannot be read, the updater reports `idle: false` with the busy reason, preventing unsafe disruption of active workloads.
  - `LocalUpgradeService` rejects legacy protocol 1 updaters (`updater_incompatible`), requires minimum protocol 2, and stores protocol 3 evidence in `updater_heartbeats`.
- **Multi-Component Upgrade and Rollback Safety**:
  - Safe sequencing: The updater binary is updated first, restarting `vps-updater.service` under the new build before applying agent or AI component changes.
  - The agent binary is backed up to `/var/lib/vps-updater/helper/backups/<jobId>/` and swapped via root-owned atomic rename into `/usr/local/bin/vps-manager-agent`.
  - AI worker components (`ai-executor`, `ai-host-helper`, `ai-rootfs`, `ai-profiles`) are updated in-place without enabling uninstalled services.
  - Root-owned journal `/var/lib/vps-updater/helper/journal.json` tracks `intent`, `renamed`, `restarted`, and `rolled_back` phases so interrupted operations resume or roll back safely.
  - Two-generation backup retention: Backup directories retain current and previous generations for durable rollback; completed job backups are pruned under root ownership.
  - Fresh heartbeat confirmation: An upgrade job succeeds ONLY after a fresh heartbeat bearing the target commit build ID is ingested before the deadline (`awaitHeartbeatGrace`). Failure rolls back to previous binaries; unverified rollbacks halt subsequent jobs as `rollback_unverified` until manual operator acknowledgment (`vps-updater ack`).
- **Rollout and Verification Boundaries**:
  - Production verification status: Single host Azure VPS `vps_kUq9jDFzAtxY` verified for systemd service supervision, lock contention rejection, and offline preflight (`-validate-config`).
  - Staging smoke validation: Multi-component upgrade and rollback verification exercises CLI signature validation (tamper and wrong-key rejection), rootfs tar extraction, and automated backup restoration upon missing heartbeat.
  - Fleet-wide multi-host production rollout across diverse hosts remains unverified and staged per-host; offline recovery and rollback acknowledgement governed by `docs/local-agent-upgrade-operations.md`.
### Session cookie hardening

`DASHBOARD_SESSION_SECRET` must be at least 32 characters in `APP_MODE=local`. `SameSite=None` requires `Secure=true`. An HTTPS dashboard origin in local mode forces `Secure=true`.

### Web Terminal Security

- **Runtime Setting & State**: The web terminal state is persisted via `PATCH /api/dashboard/settings` (`{ webTerminalEnabled: boolean }`) into the database (`dashboard_settings` table). The environment variable `ENABLE_WEB_TERMINAL` serves as the initial boot default if no database setting has been persisted yet.
- **Prerequisites for Enabling**: Enabling the web terminal at runtime strictly requires `APP_MODE=local` and a configured canonical `DASHBOARD_PUBLIC_ORIGIN`. If origin validation fails (e.g., origin unset or pointing to placeholder), enabling fails closed with an actionable error.
- **Origin & Session Gating**: WebSocket upgrades at `/api/vps/:vpsId/terminal` verify the HttpOnly dashboard session cookie, validate `Origin` against `DASHBOARD_PUBLIC_ORIGIN`, and verify that the effective runtime `webTerminalEnabled` setting is active.
- **Local vs Remote Execution**:
  - **Local VPS**: Uses dedicated host-level PTY execution (`host-pty` binary or daemon socket transport). Even when the API runs inside a Docker container, it attaches to the host environment via the `/var/run/flexserver/host-pty/host-pty.sock` Unix domain socket rather than executing within the API container.
  - **Host PTY Socket Security**: Only `/var/run/flexserver:/var/run/flexserver` is mounted into the API container, never the Docker engine socket. `LOCAL_PTY_SOCKET_PATH=/var/run/flexserver/host-pty/host-pty.sock` selects the host PTY socket, restricted to mode `0660` and the dynamically detected API UID/GID. The host unit owns only `RuntimeDirectory=flexserver/host-pty` with mode `0755`; the rotation helper owns `RuntimeDirectory=flexserver/agent-rotation`. Neither service owns or cleans the shared mount parent, so restarting either cannot unlink the other's socket.
  - **CI/CD & Compose Deployment**:
    In automated CI/CD deployment (`.github/workflows/ci.yml`), the deployment workflow automatically provisions the packaged `host-pty` binary (`/app/agent/host-pty-linux-amd64`) directly from the deployed API container image, performs an atomic binary installation to `/usr/local/bin/flexserver-host-pty`, installs the root systemd daemon unit with `RuntimeDirectory=flexserver/host-pty` and dynamically resolved `app` runtime UID/GID, and restarts the service on every image digest upgrade before starting the API container.
    When migrating older units that owned the shared `flexserver` directory, stop both daemons before starting either replacement. Recreate the API container after migration to refresh its directory bind mount, and update both socket environment variables to the new child paths. Custom socket directories outside these dedicated paths are created by the daemon/installer, not claimed as systemd runtime directories.
    For manual host installs:
    ```bash
    # Install local agent and host-pty daemon on host:
    sudo ./scripts/install/install-local-agent.sh --binary packages/agent/dist/vps-agent-linux-amd64 --config /etc/vps-manager-agent/config.json --install-host-pty
    # Launch Docker Compose with the opt-in host PTY socket mount:
    docker compose -f docker-compose.yml -f docker-compose.terminal.yml up -d
    ```
  - **Process Lifecycle and Descendant Cleanup**:
    - On Linux: Host PTY processes are allocated in their own session/process group (`setpgid`). Closing the session issues `SIGTERM` to the entire negative PID group (`syscall.Kill(-pid, syscall.SIGTERM)`).
    - On Windows: Terminal processes are bound to an OS JobObject configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When the session handle closes, the Windows kernel guarantees atomic termination of the shell and all descendant child processes.
  - **Remote VPS**: Connects via `ssh2` with strict host-key verification against stored pinned host keys and managed SSH keys.
- **Audit & Resource Quotas**: Both local and remote terminal sessions enforce global and per-session capacity limits, activity heartbeats, idle timeouts, and record lifecycle audit events (`terminal.opened`, `terminal.closed`) without logging sensitive shell input or output.
- **Accidental Command Guard (`terminalCommandGuardEnabled`)**:
  - **Client-Side Accidental Command Guard**: Configurable via the Settings toggle (`terminalCommandGuardEnabled`, defaulted to `false` for new and existing deployments). It cancels recognized destructive commands typed into the web terminal and rejects dangerous clipboard pastes before forwarding them, then displays a dismiss-only warning. Dismissing the warning does not execute the blocked command. Detection covers common high-impact commands such as `rm -rf /`, `mkfs`, `dd`, `shutdown`, `reboot`, and root block-device writes; it cannot inspect shell history, aliases, custom scripts, or fullscreen terminal applications.
  - **Explicit Non-Security Boundary & Root Unchanged**: This guard is strictly an ergonomic safety net against paste accidents or fat-finger execution. It is **NOT** a security sandbox, privilege boundary, or authorization restriction. Interactive PTY transports stream raw byte sequences rather than structured command invocations, making server-side or stream-level command denylisting unsound without breaking interactive curses applications, text editors, subshells, pipelines, and terminal escape sequences. Therefore, no server-side runtime input filtering or stream blocking is performed.
  - **Execution Identity**: The underlying host PTY process executes with host root privileges, and remote SSH sessions execute with the configured SSH credentials. Enabling the accidental command guard does not alter the runtime UID/GID or drop root privileges. Disabling it restores raw terminal input forwarding.
  - **Persistence**: Persisted globally across storage backends (PostgreSQL `dashboard_settings.terminal_command_guard_enabled` via migration `025_terminal_command_guard.sql` and JSON `data/settings.json`), exposed via `DashboardOverview.settings.terminalCommandGuardEnabled`, and updated via `PATCH /api/dashboard/settings` with support for independent partial updates.

### Local Agent Credential Rotation Helper Security

- **Constrained Host Daemon**: In containerized deployments, local agent rotation cannot run unprivileged within the container or invoke host `systemctl` directly. The rotation helper daemon (`flexserver-local-agent-rotator.service`) runs on the host as root, listening on the Unix domain socket `/var/run/flexserver/agent-rotation/agent-rotation.sock` located inside the existing shared runtime volume `/var/run/flexserver`.
- **Peer Credential Authentication**: The daemon checks the connecting socket peer using Linux `SO_PEERCRED`. Only processes matching the API container runtime UID/GID (or root) are allowed to connect.
- **Strictly Bounded Scope**: The daemon accepts only a single bounded JSON line (`{"vpsId": "...", "token": "..."}`, capped at 4096 bytes). Arbitrary commands, parameters, or file paths are prohibited.
- **Identity Enforcement**: The daemon parses the local host config (`/etc/vps-manager-agent/config.json`) and validates that the requested `vpsId` matches the local host `vpsId` exactly; mismatched IDs are rejected immediately.
- **Atomic File Update & Rollback**: The daemon atomically rewrites `/etc/vps-manager-agent/config.json` via a unique PID- and sequence-keyed temporary file with `fsync`, preserving original ownership and file mode (`0640`, group `gid 999`), retains an atomic rollback backup, and restarts `vps-manager-agent.service`. If the service restart fails, the configuration is immediately restored from backup and restart is retried.
- **Serialized Transactions & Fast Reject**: Mutation transactions are serialized via a process-level mutex with immediate `TryLock` rejection (`rotation busy`) to prevent request queueing, race conditions, or deadline drift.
- **Bounded Timeouts & No Late Mutations**: Systemd restarts are bounded to 8 seconds (rollback restart also 8 seconds), guaranteeing total daemon execution stays well within the 25-second client timeout and 30-second API timeout (`LOCAL_AGENT_ROTATION_TIMEOUT_MS`), preventing split-brain or late accepted mutations.
- **Zero Token Leakage**: Tokens (`vma_...`) are strictly excluded from command-line arguments, environment logs, daemon logs, and API error responses. Child process output and stderr streams are filtered with regex token sanitization.
## SSH Private Key Envelope Encryption & Management

### Envelope Architecture & Cryptography

SSH private keys at rest under `private/keys/` are protected using AES-256-GCM envelope encryption:
- **Data Encryption Key (DEK)**: A dedicated 32-byte (256-bit) cryptographically random DEK is generated for each managed keypair.
- **Authenticated Encryption**: Both the DEK and the private key payload are encrypted using AES-256-GCM with fresh 12-byte random IVs and 16-byte authentication tags.
- **Cryptographic AAD Binding**:
  - DEK AAD: `<vpsId>:dek:v1` cryptographically binds the encrypted DEK to the specific VPS identity and format version.
  - Payload AAD: `<vpsId>:payload:v1` binds the encrypted OpenSSH private key payload.
  - Substituting an envelope from another VPS or corrupting authenticated ciphertext, IV or tag causes decryption to fail closed.
- **In-Memory Consumers**: SSH connection handlers (e.g. `ssh2`) receive the decrypted OpenSSH private key string strictly in memory; decrypted keys are never written to disk or logs.

### External KEK Keyring & Storage Isolation

The Key Encryption Key (KEK) is managed outside the application repository and data stores:
- **Configuration**: Set `SSH_KEY_ENCRYPTION_KEY_FILE` to the external keyring path. The setup CLI suggests `/etc/flexserver/ssh-keyring.json` on Linux and `%ProgramData%\flexserver\ssh-keyring.json` on Windows; the application requires an explicit path.
- **Boundary Validation**: The path is resolved canonically (following symlinks) and strictly prohibited from residing inside `DATA_DIR`, `PRIVATE_DIR`, or the project root.
- **File Permissions**: Must be secured with mode `0600` (owner read/write only) on POSIX, or restricted owner ACLs on Windows NTFS.
- **Fail-Closed Semantics**: If the keyring file is missing, invalid, or corrupted, SSH operations fail closed. The application never silently falls back to plaintext or auto-generates a production KEK on read.
- **Host Compromise Threat Boundary**: When the KEK resides on the same physical or virtual host as the application, a full host compromise (root access) compromises both the application files and the keyring. Storing the KEK in a distinct external location protects against accidental directory leaks, repository commits, and application-level backup exposures.

### Plaintext Historical Backup Exposure & Purging

**CRITICAL OPERATOR NOTICE**:
Prior releases stored Ed25519 private keys as unencrypted OpenSSH files. Any application backups taken prior to envelope encryption contain unencrypted private keys.
- Operators must audit and purge historical application backups that contain unencrypted `private/keys/` files.
- If historical backup copies cannot be verified as secure, consider rotating all managed VPS host access keys.

### Separate Offline Recovery Copy

- **Keyring Backup**: The external KEK keyring file must be excluded from routine application backups and backed up to a separate, offline location (such as an offline vault, hardware token, or air-gapped backup).
- **Disaster Recovery**: Restoring application data without the corresponding KEK keyring renders all managed private keys permanently unrecoverable.

### Key Migration & Non-Destructive Protection

- **Zero-Downtime Migration**: Existing unencrypted OpenSSH private keys are automatically detected upon access, encrypted into the envelope format, and saved via atomic write without altering the keypair identity.
- **Batch Migration**: Operators can migrate all stored keys using `npm run manage-ssh-keys -- migrate`.
- **Safe Regeneration Guard**: If a private key exists without a public key (or vice-versa), the service refuses to regenerate the keypair to prevent accidental loss or mispairing.
- **Corruption Protection**: Decryption errors, authentication tag failures, or missing KEK entries immediately abort and never overwrite or regenerate damaged key files.

### Operator CLI & Rotation Procedures

A dedicated CLI tool manages keyrings and key envelopes without printing secret key material:

```bash
# 1. Initialize external keyring (creates file with initial 256-bit KEK)
# Optionally pass --migrate to immediately encrypt existing plaintext OpenSSH keys:
npm run manage-ssh-keys -- init --path /etc/flexserver/ssh-keyring.json --migrate
# Set SSH_KEY_ENCRYPTION_KEY_FILE=/etc/flexserver/ssh-keyring.json in .env before starting the app.
# Grant only the application service account access; on Windows restrict NTFS ACLs explicitly.

# 2. Migrate existing plaintext keys to envelope encryption
npm run manage-ssh-keys -- migrate

# 3. Rotate active KEK (generates new KEK, sets as active, and rewraps existing keys)
npm run manage-ssh-keys -- rotate

# Rotate keyring without immediate key rewrapping:
npm run manage-ssh-keys -- rotate --skip-rewrap
```

### Deployment & Container Wiring

In containerized production deployments:
- The external keyring resides outside checkout, `DATA_DIR`, and `PRIVATE_DIR` on the host at `/etc/flexserver/ssh-keyring.json`.
- The host directory `/etc/flexserver` is mounted read-only into the API container: `- /etc/flexserver:/etc/flexserver:ro`.
- The API container runs with `SSH_KEY_ENCRYPTION_KEY_FILE=/etc/flexserver/ssh-keyring.json` defined in `.env` and `docker-compose.yml`.
- Permissions are strictly restricted: host directory `/etc/flexserver` has mode `0750` owned by the API runtime UID:GID (`100:101`), and `/etc/flexserver/ssh-keyring.json` has mode `0600` owned by the API runtime UID:GID.
- An idempotent host bootstrapper script is provided at `scripts/install/bootstrap-ssh-keyring.sh`.
- For standalone Docker Compose setups, the optional override `docker-compose.keyring.yml` mounts `/etc/flexserver` into the API container without breaking demo mode when unmounted.

## AI Keyring Deployment & Container Wiring

The AI subsystem uses the same external keyring directory as the SSH and Compose keyrings.
- The external AI keyring resides outside checkout, `DATA_DIR`, and `PRIVATE_DIR` on the host at `/etc/flexserver/ai-keyring.json` (canonical default `AI_DEFAULT_KEYRING_PATH`; a custom `AI_KEYRING_FILE` from `.env` is preserved verbatim).
- With multiple provider profiles, each profile's API key is its own envelope bound to a per-provider AAD identity (`docs/ai-multi-provider-plan.md`); keyring rotation/rewrap enumerates every provider envelope, and the boot migration re-encrypts the legacy single key under the first profile's identity while keeping the legacy slot for rollback.
- **ChatGPT (OAuth) provider profiles** (`docs/ai-chatgpt-oauth-provider-plan.md`) authenticate with the operator's own ChatGPT Plus/Pro account through the public Codex CLI OAuth registration and consume subscription quota via OpenAI's Codex backend. Tokens live in the keyring under a dedicated AAD field, refresh is single-flight with persist-before-use, and a revoked refresh token fails closed with a "relogin required" status. Using ChatGPT quota through a non-official client **violates OpenAI's Terms of Service and can lead to account suspension**; the dashboard requires an explicit per-profile acknowledgment of this risk before the OAuth flow can start. Endpoint constants are env-overridable (`APP_AI_CODEX_*`) and every request passes the same egress guards as API-key providers.
- The host directory `/etc/flexserver` is mounted read-only into the API container: `- /etc/flexserver:/etc/flexserver:ro`. `AI_KEYRING_FILE` and `APP_AI_ENABLED` are defined in `.env` and passed through `docker-compose.yml` (`APP_AI_ENABLED` is forwarded but never force-enables an explicit `false`).
- Permissions are strictly restricted: host directory `/etc/flexserver` mode `0750` owned by the API runtime UID:GID; `/etc/flexserver/ai-keyring.json` mode `0600` owned by the same UID:GID.
- Supported deployments provision the AI keyring automatically: `scripts/install/bootstrap-ssh-keyring.sh` (SSH bootstrap), `scripts/install/install.sh` (own initial init), and the CI/CD host provisioning job. All invoke `node dist/scripts/manage-ai-keys.js init` with a one-shot read-write bind mount and the storage env intact; the CLI's encrypted-data guard refuses regeneration when encrypted AI data exists (stop JSON-storage API writers first — the CLI guards storage with a writer lock), and the CI deployment job runs core DB migrations before AI init on a fresh database.
- Never remove a live writer lock; keep the external AI keyring and encrypted storage backed up separately (see `npm run manage-ai-keys` for `init|rotate|rewrap|check`).
### Docker Compose applications (phase 2)

Compose discovery is observational. Each VPS has a separate Compose-management gate, disabled by default; existing Docker-container management permission does not enable it. Enabling the gate and opting a detected stack into external control are explicit, authenticated actions. Specifying an external Compose source path is privileged and separately consented; the path remains externally owned and is treated as read-only. Managed configuration is a separate path. There is no implicit `up` or `start`, no runtime installation triggered by ordinary application operations, and no automatic rollback. Start operates only on existing captured containers; a missing container cannot be recreated by Start. Readiness is evaluated using configured checks and observed results; a readiness timeout is a failed outcome that leaves observed resources in place. An uncertain operation remains locked for reconciliation—never blindly retry or clear its lock.

Runtime preparation requires separate confirmation with `pluginRequired: true`. Trusted compatible Compose builds are reused without installation; the compatibility matrix currently allows v2.39.4 and v2.40.3. Installation is Linux amd64/arm64 only and requires a root-run agent. The installer downloads the pinned official v2.40.3 artifact over HTTPS, verifies its architecture-specific SHA-256, and atomically installs `/usr/local/lib/flexserver/compose/docker-compose`; it does not overwrite the system plugin or upgrade Docker Engine. Missing or untrusted Docker CLI yields `docker_cli_missing` and manual official-package guidance rather than running a package manager. Non-Linux, unsupported architecture, insufficient privilege, download/hash and post-install verification failures remain explicit failures. GET, preview and deployment never install or upgrade runtime.

Configuration validation accepts a deliberately restricted Compose subset; it rejects multiple YAML documents and bounds desired replicas to 1–100. Secret interpolation is permitted only in protected runtime fields, not public workload identity/configuration such as images, paths, ports, resources, or profiles. Preview/configuration responses redact secrets. Never treat a configuration as deployable merely because it parses as YAML.
Managed deployments accept one Compose YAML document with prebuilt registry images and supported service, dependency, healthcheck, port, named-volume, and app-data-root bind settings; they do not accept Git/build contexts or multi-file overrides. The validator rejects privileged mode, host namespaces/network, devices, Docker socket mounts, and arbitrary host bind paths. Named volumes are retained and never deleted by service removal. Preview resolves image digests; failed registry resolution has no cache fallback. Removed-service cleanup is ownership-checked and requires explicit preview approval. Previews capture the complete daemon container inventory fingerprint, while deletion candidates remain scoped to the selected project. Any inventory drift between preview and mutation invalidates approval and fails closed. The approved removal manifest must cover every owned container of each removed service exactly; an omitted sibling fails deployment before Compose mutation or teardown. A deployment without configured healthchecks is reported as readiness-unverified rather than healthy. See the Compose compatibility notes in the implementation for exact field validation; unsupported configuration is rejected, not silently ignored.

Registry credential replacement and deletion are refused while a referenced operation is authorized, applying, or uncertain, including references captured by its preview. Posting an existing host/username pair is a replacement, not a way around that fence. Replacing credentials before authorization invalidates pending previews; obtain and confirm a new preview rather than retrying an old approval.


The keyring is loaded only when encrypted Compose data is needed. If it is absent, unreadable, or invalid, those operations fail closed with crypto unavailable; there is no plaintext fallback or silent key generation. Discovery/read-only inventory remains independent of keyring availability.

For a source checkout, the commands are `npm run manage-compose-keys -- --help` and `npm run manage-compose-keys -- <init|rotate|rewrap|check>`. Use the same environment and storage configuration as the API. In the API image, the compiled entry point is `node dist/scripts/manage-compose-keys.js <command>`; do not invoke the source-only root `scripts/admin` wrapper in the image. The API image runs as its non-root `app` user, so the host keyring directory and file must permit that container UID/GID to read and, for one-shot init/rotation, write them. Stop API writers before administrative commands and restart the stack afterward.

The Compose keyring override is opt-in and separate from demo defaults:

```bash
docker compose -f docker-compose.yml -f docker-compose.keyring.yml up -d
```

This mounts `/etc/flexserver` read-only into the API container and sets `COMPOSE_KEYRING_FILE=/etc/flexserver/compose-keyring.json`. Provision the keyring separately; the override does not create it. For one-shot initialization or rotation only, stop the API and use the admin override to mount the same directory read-write:

```bash
docker compose stop api
docker compose -f docker-compose.yml -f docker-compose.keyring.yml -f docker-compose.keyring-admin.yml run --rm --no-deps api node dist/scripts/manage-compose-keys.js init
docker compose up -d
```

Replace `init` with `rotate`, `rewrap`, or `check` as appropriate. The read-write override is only for a stopped-API one-shot command; never start the normal API with it. Compose merges the additional mount with the base service mounts. After atomic keyring replacement, restart the API so its read-only bind sees the new file. For a standalone host, use the API runtime UID/GID; restrict the directory to `0750` and keyring file to `0600`, owned by the API runtime identity. Never mount the Docker socket or host root into the API. Registry credentials are stored encrypted at rest and scoped per VPS; use private registries with trusted TLS certificate verification. Never disable certificate verification or use plaintext registry connections.

If removed-service teardown fails closed with `removed_service_inventory_changed`, the sampled container inventory drifted after preview approval; deploy a fresh preview instead of reusing the approval. `removed_service_manifest_incomplete` means the approved manifest missed an owned container of a removed service; the pre-apply recheck fails before any teardown. Both failures leave observed resources in place for reconciliation.

The JSON adapter is a single-writer store: do not run multiple API processes against the same JSON state, and never manually remove a live writer lock. PostgreSQL provides transactional shared storage and contention control. On uncertain outcomes, inspect/reconcile the recorded operation and observed runtime before considering another action. Redeploying an earlier revision does not restore volume, database, or other application data; take workload-level backups before deployment and plan data recovery separately.


## Web terminal origin during domain changes

`DASHBOARD_PUBLIC_ORIGIN` must match the browser dashboard origin exactly (scheme, hostname, and optional port). After changing the public dashboard domain, update both the deployment `.env` and the GitHub Actions repository variable `DASHBOARD_PUBLIC_ORIGIN`, then recreate the API container so it receives the new environment. Do not disable origin checks or add a permissive host fallback.

A rejected WebSocket upgrade can appear as a connection error before any SSH connection is attempted. An unauthenticated upgrade with the configured Origin reaches the authentication gate (`401`); a mismatched Origin is rejected with `403` while terminal access is enabled. Verify the authenticated terminal path as well, using a real command output rather than the shell's input echo.

## AI provider transport and encryption

The AI adapter uses an explicitly configured OpenAI-compatible endpoint. It sends non-streaming chat-completion requests with a 60-second deadline, a 1 MiB request/response limit, bounded tool calls, and strict response decoding. Returned tool calls are proposals, not execution permission. Redirects and automatic provider fallback are rejected. Every resolved address is checked before connecting to a pinned address; TLS verification and the original hostname/SNI remain enabled. Metadata/link-local targets are forbidden even with private-endpoint consent. Plain HTTP is limited to explicitly opted-in loopback development endpoints; remote providers require HTTPS.

AI secrets use a separate external keyring and the authenticated namespace `flexserver:ai:v1`. Envelopes bind VPS, task, field and revision; changing any identity invalidates decryption. Wrapped-key rotation preserves the encrypted payload and requires retaining old keys until all retained envelopes are rewrapped. Missing or invalid key material fails closed; there is no plaintext fallback. Do not reuse Compose or SSH keyring files for AI, mount provider credentials into agents, or log provider request/response bodies. Provider failures expose fixed error messages, not remote error bodies.

Transport verification uses a synthetic local endpoint and does not establish compatibility, privacy, tool-selection quality or billing accuracy of a real provider. Host confinement and mutation rollout require independent Linux staging evidence; passing adapter tests does not authorize VPS operations.

Connecting a provider makes cached metrics and inventory available without per-VPS setup for hosts without an explicit AI policy. Managed Docker/Compose actions may be proposed by default, but still require the existing management prerequisites and individual immutable-plan approval before execution. Existing saved policy opt-outs are preserved. Shell execution, file scopes, service profiles, and sending logs/files to the provider are not enabled automatically; host execution retains its separate confinement checks. `APP_AI_ENABLED=false` remains the global kill switch.

## AI Assistant Operational Safety, Retention, and Secret Redaction

### Retention semantics and state fences

1. **Scheduled retention lifecycle:** `AiRetentionService` runs a lightweight 5-second session/lease reconciliation loop and a periodic 300-second retention pass.
2. **Terminal task pruning:** Only tasks in terminal states (`succeeded`, `failed`, `cancelled`, `expired`) older than the 30-day cutoff are pruned. Active tasks (`planning`, `awaiting_input`, `awaiting_approval`, `executing`, `verifying`, `cancel_requested`) and `uncertain` tasks are strictly preserved and never TTL-deleted.
3. **Durable fence and receipt preservation:** Any task associated with active outbox entries (`pending` or `dispatched`) or `uncertain` execution receipts is protected from retention deletion. Terminal task pruning purges only resolved receipts and acknowledged outbox entries, keeping all fences intact.
4. **Needed execution blob protection:** Encrypted execution blobs (`AiExecutionBlob`) are deleted on expiration only if not needed by an active or uncertain task, active outbox commands, or uncertain receipts. Needed blobs remain durable until their associated work settles.
5. **Audit preservation on chat deletion:** Deleting a chat conversation (`deleteConversation`) deletes conversation metadata and messages but preserves all historical audit events (`state.auditEvents`) and records an immutable deletion audit event. Audit records are maintained under the 90-day retention baseline.

### Startup recovery and session revocation

1. **Immediate session revocation enforcement:** When an initiating or approving dashboard session logs out or is revoked in `DashboardSessionService`:
   - Tasks in `executing` or `verifying` are transitioned to `cancel_requested` with code `session_revoked`, instructing the agent to terminate execution on its next heartbeat rather than running detached.
   - Tasks in `planning`, `awaiting_approval`, or `awaiting_input` are expired immediately with code `session_revoked`.
2. **Owner lease expiration:** Tasks in `executing` or `verifying` whose runtime owner lease expires without fresh heartbeat/receipt are transitioned to `uncertain` with wire code `uncertain_outcome`, preserving the active-slot fence without duplicate execution. Stale `planning` leases expire to unblock VPS crashes.
3. **Awaiting task expiration:** Tasks remaining in `awaiting_approval`, `awaiting_input`, or `planning` past their `expiresAt` deadline are transitioned to `expired` with wire code `approval_expired`.

### Secret redaction and streaming boundaries

1. **Shared secret redaction:** All outgoing responses and provider communications pass through `packages/api/src/common/redaction.ts`. Redaction matches private key PEM blocks, SSH keys, passwords, bearer tokens, scoped `vma_` tokens, `sk-` provider keys, generic secret assignments, and `.env` variable assignments.
2. **ANSI escape stripping:** Terminal and subprocess output undergoes ANSI sequence stripping before pattern matching to prevent escape code fragmentation from evading secret redaction.
3. **Chunk boundary streaming redactor:** `ChunkRedactor` buffers stream chunks across packet boundaries to detect and redact split tokens or headers that cross chunk splits, using line-oriented buffering and dedicated PEM block masking.
4. **Exact preview byte preservation:** Authenticated execution preview payloads are exempted from output value mutation to guarantee that script/content byte digests match during subsequent approval verification.
5. **Operational limits:** Production deployment of AI assistant host execution and multi-node confinement has NOT been verified. Passing local unit tests and simulated adapter runs does not guarantee provider reliability, billing boundaries, or safe confinement on production Linux hosts.

### Host Confinement Runtime (ai-host-helper / ai-executor)

1. **Privileged helper is a small socket daemon:** `ai-host-helper` runs as root, exposes a Unix domain socket, and authenticates every connection via `SO_PEERCRED`. Authorized peers are limited to root, the helper daemon's own effective UID, explicit `--socket-uid`/`--socket-gid` values, and the pinned execution UID/GID. All other peers are rejected.
2. **Bounded RPC surface:** The helper implements only `service_status`, `service_action`, `config_validate`, `config_apply`, `cgroup_create`, `cgroup_kill`, and `task_execute`. Every RPC re-validates task IDs, profile membership, and pinned paths before acting.
3. **Pinned execution identity:** `--execution-uid`, `--execution-gid`, `--executor-binary`, `--rootfs-dir`, `--cgroup-base`, and `--backups-dir` are set by the administrator at install time. Callers cannot arbitrate the execution UID/GID or the executor binary path; the helper launches `/usr/local/sbin/ai-executor` only inside fresh mount/PID/IPC/UTS namespaces and drops to the pinned UID/GID before exec.
4. **cgroup v2 requirement:** `cgroup_create`, `task_execute`, and shell tooling fail closed with `cgroup v2 unavailable: unified cgroup hierarchy required` on hosts lacking `/sys/fs/cgroup/cgroup.controllers`. There is no cgroup v1 fallback and no unconfined execution fallback (verified on a cgroup v1 Docker Linux engine).
5. **Config CAS mutations via helper:** `config_apply` enforces pre-image and post-image SHA-256 digests, writes 0640 root-owned backups under `--backups-dir`, and atomically replaces the candidate via temp file + rename with directory fsync. Digest drift is rejected without any disk mutation.
6. **Profile installation is an administrator step:** Service profiles are root-owned JSON files under the root-owned `--profiles-dir` (binary default `/etc/vps-manager/ai-profiles.d`; the installer uses `/etc/flexserver-ai/profiles` and passes it explicitly), 0644 mode, UID 0, and not group/world writable. The profile registry rejects group/world-writable files and non-root ownership, and no default profile is seeded implicitly.
7. **Installer surface (`scripts/install/install-local-agent.sh`):** The AI subsystem is installed only when the administrator passes `--install-ai` (or one of the AI component flags). The installer provisions the dedicated AI user/group, installs the helper/executor binaries to `/usr/local/sbin`, unpacks the rootfs tarball and manifest, and populates the profile directory; `--help` and `--dry-run` make zero filesystem writes and zero network calls.
