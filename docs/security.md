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

### Session cookie hardening

`DASHBOARD_SESSION_SECRET` must be at least 32 characters in `APP_MODE=local`. `SameSite=None` requires `Secure=true`. An HTTPS dashboard origin in local mode forces `Secure=true`.

### Web Terminal Security

- **Runtime Setting & State**: The web terminal state is persisted via `PATCH /api/dashboard/settings` (`{ webTerminalEnabled: boolean }`) into the database (`dashboard_settings` table). The environment variable `ENABLE_WEB_TERMINAL` serves as the initial boot default if no database setting has been persisted yet.
- **Prerequisites for Enabling**: Enabling the web terminal at runtime strictly requires `APP_MODE=local` and a configured canonical `DASHBOARD_PUBLIC_ORIGIN`. If origin validation fails (e.g., origin unset or pointing to placeholder), enabling fails closed with an actionable error.
- **Origin & Session Gating**: WebSocket upgrades at `/api/vps/:vpsId/terminal` verify the HttpOnly dashboard session cookie, validate `Origin` against `DASHBOARD_PUBLIC_ORIGIN`, and verify that the effective runtime `webTerminalEnabled` setting is active.
- **Local vs Remote Execution**:
  - **Local VPS**: Uses dedicated host-level PTY execution (`host-pty` binary or daemon socket transport). Even when the API runs inside a Docker container, it attaches to the host environment via the `/var/run/flexserver/host-pty.sock` Unix domain socket rather than executing within the API container.
  - **Host PTY Socket Security**: In containerized deployments, only the dedicated PTY socket (`/var/run/flexserver/host-pty.sock`) is mounted into the API container via `docker-compose.terminal.yml`. The Docker engine socket (`/var/run/docker.sock`) is NEVER mounted or exposed to any container or installer. Socket files are restricted (mode `0660`) and granted to the container runtime UID/GID (`app`).
  - **Host Daemon & Compose Deployment**:
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
