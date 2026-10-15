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
### Session cookie hardening

`DASHBOARD_SESSION_SECRET` must be at least 32 characters in `APP_MODE=local`. `SameSite=None` requires `Secure=true`. An HTTPS dashboard origin in local mode forces `Secure=true`.

### Web Terminal Security

- **Runtime Setting & State**: The web terminal state is persisted via `PATCH /api/dashboard/settings` (`{ webTerminalEnabled: boolean }`) into the database (`dashboard_settings` table). The environment variable `ENABLE_WEB_TERMINAL` serves as the initial boot default if no database setting has been persisted yet.
- **Prerequisites for Enabling**: Enabling the web terminal at runtime strictly requires `APP_MODE=local` and a configured canonical `DASHBOARD_PUBLIC_ORIGIN`. If origin validation fails (e.g., origin unset or pointing to placeholder), enabling fails closed with an actionable error.
- **Origin & Session Gating**: WebSocket upgrades at `/api/vps/:vpsId/terminal` verify the HttpOnly dashboard session cookie, validate `Origin` against `DASHBOARD_PUBLIC_ORIGIN`, and verify that the effective runtime `webTerminalEnabled` setting is active.
- **Local vs Remote Execution**:
  - **Local VPS**: Uses dedicated host-level PTY execution (`host-pty` binary or daemon socket transport). Even when the API runs inside a Docker container, it attaches to the host environment via the `/var/run/flexserver/host-pty.sock` Unix domain socket rather than executing within the API container.
  - **Host PTY Socket Security**: In containerized deployments, only the dedicated PTY socket directory (`/var/run/flexserver:/var/run/flexserver`) is mounted into the API container (via CI production Compose or `docker-compose.terminal.yml`), with canonical socket path `LOCAL_PTY_SOCKET_PATH=/var/run/flexserver/host-pty.sock`. The Docker engine socket (`/var/run/docker.sock`) is NEVER mounted or exposed to any container or installer. Socket files are restricted (mode `0660`) and granted to the container runtime UID/GID dynamically resolved from the API container `app` user (never hardcoded). The host systemd daemon (`flexserver-host-pty.service`) configures `RuntimeDirectory=flexserver` and `RuntimeDirectoryMode=0755` so that the socket directory is automatically recreated across system boots.
  - **CI/CD & Compose Deployment**:
    In automated CI/CD deployment (`.github/workflows/ci.yml`), the deployment workflow automatically provisions the packaged `host-pty` binary (`/app/agent/host-pty-linux-amd64`) directly from the deployed API container image, performs an atomic binary installation to `/usr/local/bin/flexserver-host-pty`, installs the root systemd daemon unit with `RuntimeDirectory=flexserver` and dynamically resolved `app` runtime UID/GID, and restarts the service on every image digest upgrade before starting the API container.
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
npm run manage-ssh-keys -- init --path /etc/flexserver/ssh-keyring.json
# Set SSH_KEY_ENCRYPTION_KEY_FILE=/etc/flexserver/ssh-keyring.json in .env before starting the app.
# Grant only the application service account access; on Windows restrict NTFS ACLs explicitly.

# 2. Migrate existing plaintext keys to envelope encryption
npm run manage-ssh-keys -- migrate

# 3. Rotate active KEK (generates new KEK, sets as active, and rewraps existing keys)
npm run manage-ssh-keys -- rotate

# Rotate keyring without immediate key rewrapping:
npm run manage-ssh-keys -- rotate --skip-rewrap
```

## Web terminal origin during domain changes

`DASHBOARD_PUBLIC_ORIGIN` must match the browser dashboard origin exactly (scheme, hostname, and optional port). After changing the public dashboard domain, update both the deployment `.env` and the GitHub Actions repository variable `DASHBOARD_PUBLIC_ORIGIN`, then recreate the API container so it receives the new environment. Do not disable origin checks or add a permissive host fallback.

A rejected WebSocket upgrade can appear as a connection error before any SSH connection is attempted. An unauthenticated upgrade with the configured Origin reaches the authentication gate (`401`); a mismatched Origin is rejected with `403` while terminal access is enabled. Verify the authenticated terminal path as well, using a real command output rather than the shell's input echo.
