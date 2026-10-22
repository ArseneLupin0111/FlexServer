# CI/CD

This repository uses GitHub Actions for verification, Docker image publishing, and optional SSH deployment.

## Workflow

Workflow file: `.github/workflows/ci.yml`

### Pull requests

Pull requests run Chromium E2E unconditionally and conditional verification behind a lightweight `changes` job (path filters, no toolchains installed): Node, Go, installer, updater, database, and image steps run only when their paths change. Pushes to `main` force the full check matrix and both image builds. Pull requests do not publish images to GHCR and do not run the production deploy job.

API and Web use independent Docker build stages and GitHub Actions cache scopes (`api-runtime`, `web-runtime`). Current path filters still rebuild both images for changes in either Node workspace; database integrations skip web-only changes. Docs-only PRs skip Node, Go, image, installer/updater, and database checks. Workflow and hardening-fixture changes re-run the affected safety checks.
After change detection, `verify-checks` (Node tests/typecheck/CLI smoke), `verify-go` (Go, installer/updater and Compose checks), `verify` (image builds, identity checks, scans and publishing), and the two database jobs run independently. Existing status names remain. The Go job pins Node 24 for updater validation without installing npm dependencies. Go race tests use the runner's GCC, installing it only when absent.

The independent `e2e` job (`E2E Chromium`) always runs on pull requests, pushes to `main`, and manual dispatch, without path filters or production secrets. It uses Node.js 22, `npm ci`, `npx playwright install --with-deps chromium`, and `npm run test:e2e` with a 15-minute job timeout. It builds the real React/NestJS application and checks authentication against isolated temporary JSON storage, not `.env` or a deployed server.

Unless cancelled, the job uploads `playwright-report/` and `test-results/` as `e2e-chromium`, retained for seven days. Download the artifact and open `playwright-report/index.html` to inspect the report; failure traces/screenshots use disposable test credentials. Temporary data/private directories are not uploaded. Deploy explicitly requires both `verify` and `e2e` to succeed; image building/publishing may run alongside E2E, but an E2E failure blocks deployment.


In addition to unconditional Chromium E2E, every pull request runs change detection and the matching checks below:

1. When Node paths change: `npm ci`, `npm test`, `npm run typecheck`, and the `--help` script smoke tests. `npm run build` runs only as a fallback when no Docker target builds; each Docker target compiles its own workspace.
2. When installer paths change: `bash scripts/tests/test-installer-docker-access.sh`.
3. When updater (or agent) paths change: pinned `Setup Go`, then `bash scripts/tests/test-updater.sh`.
4. `docker compose config --quiet` (always, cheap sanity gate).
5. When agent paths change: Go agent tested with the race detector plus `go vet`; the API image compiles agent/updater binaries, whose embedded identities are checked directly against package version and commit SHA without another standalone build in the image job.
6. When API/web paths change (or a workflow-dispatch force input selects them): Docker build checks for the affected runtime targets (`api-runtime`, `web-runtime`) with OCI labels.
7. When an API or web image is built: fail-fast smoke tests, the Docker-socket metadata guard, independent report-only Trivy scans, and the fail-closed CRITICAL gate. SBOM generation is main-only (SBOMs are release attestations; PRs are still scanned and gated).
   API/web Trivy scans run concurrently using pinned Trivy 0.70.0 after a single vulnerability database download. Each process uses an in-memory analysis cache and skips database updates, avoiding shared-cache writer contention. Both exit statuses are awaited; scanner errors or missing reports block release. Docker app builds copy only required source/config/assets, and Go compilation uses BuildKit module/compiler cache mounts (runner-local mount contents are not guaranteed to persist through the GitHub Actions layer cache).
8. When database paths change: TimescaleDB PostgreSQL migration integration (`postgres-integration`, `timescale/timescaledb:2.17.2-pg16`) runs concurrently with `verify` (no longer gated on it).
9. When database paths change: mandatory plain PostgreSQL 16 job (`docker-monitoring-postgres16`, `postgres:16`, `pg_isready` healthcheck, and `VPS_MANAGER_TEST_POSTGRES_URL`), separate from TimescaleDB; it runs the concrete migration, repository, and maintenance suites (`docker-migration-009/013/014.postgres.test.ts`, `docker-monitoring-repository.postgres.test.ts`, and `docker-monitoring-maintenance.postgres.test.ts`). Publishing requires both database jobs.

The PostgreSQL jobs run the same live-test contract against different server capabilities. Core migrations and Docker-monitoring tables must work on ordinary PostgreSQL; TimescaleDB is exercised separately for optional extension-aware deployments. Tests that require a live database are skipped when `VPS_MANAGER_TEST_POSTGRES_URL` is unset, but CI supplies it and therefore treats those cases as mandatory.

Publishing runs inside `verify` only for non-PR runs on `main` with full scope. Images stay in the same runner's Docker daemon after scanning; there is no image archive transfer or rebuild. Pull requests never log into GHCR, publish images, or deploy.

### Pushes to `main`

Pushes to `main` force the full verification matrix (`full` scope: all checks and both image builds run regardless of path filters), then publish two Docker images to GHCR with the current commit SHA only (no `latest` tag for deployment):

- API:
  - `ghcr.io/sondoan17/vps-manager-nodejs-api:<commit-sha>`
- Web:
  - `ghcr.io/sondoan17/vps-manager-nodejs-web:<commit-sha>`

Release gate: after its own image/security checks succeed, `verify` waits for all four peer jobs (`Verify checks`, `Verify Go checks`, both database jobs) to complete successfully in the current run attempt using the authenticated GitHub Actions API. Missing jobs wait at most ten minutes; duplicate jobs, non-success conclusions, API errors and cancellation fail closed. Local image IDs must still match the scanned IDs before concurrent API/Web pushes. Deploy consumes digest outputs directly from `verify`. The workflow no longer has a separate `publish` job or `verified-images` archive.

Deploy pulls by immutable digest (`name@sha256:...` references recorded from `RepoDigests` after the push), not by SHA tag. Rollback stays reproducible by redeploying the image for an earlier commit SHA.

After publishing, the workflow can deploy over SSH if deployment secrets are configured.

Local and remote host agent updates use the bundled agent and updater binaries packaged directly in the deployed API container (`/app/agent/vps-agent-linux-amd64` and `/app/agent/vps-agent-linux-arm64`). Deployment via `scripts/deploy.sh` prepares the host updater using `scripts/install/prepare-agent-updater.sh`, and `AgentConvergenceService` automatically converges installed agents to the deployment-bundled target when the host is idle, without requiring manual release selection or updater enrollment. Busy or offline hosts defer safely until idle, missing host access is reported as `needs_access`, and failed targets are suppressed per host until manually retried.

## Runtime topology

The production deployment runs three containers:

- `postgres`: TimescaleDB/PostgreSQL database on the internal Docker network; stores data in a Docker volume.
- `api`: NestJS API on internal port `3000`; stores data in Docker volumes.
- `web`: Nginx static web server on host port `3000`; proxies `/api/*` to `api:3000` and serves the SPA fallback.

The production docker-compose binds the web container to `127.0.0.1:3000` so it listens only on the loopback interface. An external HTTPS reverse proxy (nginx, Caddy, Cloudflare Tunnel) must terminate TLS and forward to `http://127.0.0.1:3000`. The API health endpoint is reachable through the web proxy at `/api/health`.

The SSH deploy also extracts the bundled `host-files-linux-amd64` binary and its installer from the API image, then installs `flexserver-host-files.service` on the Linux host using the API container's actual UID/GID. The root helper exposes only `/var/run/flexserver/host-files/files.sock`; the existing `/var/run/flexserver` bind mount makes it available to the API without mounting the host filesystem. Installing the helper does not enable Files for any VPS: the per-VPS Settings toggle remains operator-controlled. For native or manual deployments, use `scripts/install/install-host-files.sh --binary <path> --api-uid-gid <UID:GID>` as root.

## Required secrets for deployment

Set these in GitHub repository settings:

`Settings` → `Secrets and variables` → `Actions` → `Repository secrets`

| Secret                     | Required | Description                                                                                                                                                                                       |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VPS_HOST`                 | Yes      | Server IP or hostname.                                                                                                                                                                            |
| `VPS_USER`                 | Yes      | SSH user, for example `root`.                                                                                                                                                                     |
| `VPS_SSH_KEY`              | Yes      | Private SSH key with access to the server.                                                                                                                                                        |
| `DASHBOARD_SESSION_SECRET` | Yes      | Secret for dashboard session token hashing. Required when `APP_MODE=local`.                                                                                                                       |
| `POSTGRES_PASSWORD`        | Yes      | Password for the `vps_manager` PostgreSQL user. Used on first DB volume initialization and by the API `DATABASE_URL`.                                                                             |
| `DASHBOARD_ADMIN_PASSWORD` | No       | Plaintext dashboard admin password. If set, the deploy step pipes it to `set-dashboard-password.js --stdin --skip-if-same` after migrations. If unset, the password must be set manually via SSH. |
| `VPS_KNOWN_HOSTS`          | No       | Pinned SSH known_hosts entry. If set, written directly to `known_hosts` instead of `ssh-keyscan` (TOFU). Recommended for production.                                                              |
| `VPS_PORT`                 | No       | SSH port. Defaults to `22`.                                                                                                                                                                       |
| `DEPLOY_PATH`              | No       | Remote app directory. Defaults to `/opt/vps-manager-nodejs`.                                                                                                                                      |

If the required SSH secrets are missing, the deploy job exits successfully and prints a skip message.

Optional repository variables can override generated server `.env` values:

| Variable                        | Default   | Description                                                                                 |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `PORT`                          | `3000`    | API listen port inside the container.                                                       |
| `APP_MODE`                      | `local`   | Runtime mode for production deployment.                                                     |
| `ENABLE_WEB_TERMINAL`           | `false`   | Enables web terminal only when explicitly allowed.                                          |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `false`   | Allows private-network SSH targets from the server.                                         |
| `DATA_DIR`                      | `data`    | API data directory inside `/app`; resolves to `/app/data`.                                  |
| `PRIVATE_DIR`                   | `private` | API private directory inside `/app`; resolves to `/app/private`.                            |
| `RATE_LIMIT_WINDOW_MS`          | `60000`   | Rate limit window.                                                                          |
| `RATE_LIMIT_MAX`                | `120`     | Rate limit max requests per window.                                                         |
| `AGENT_PUBLIC_BASE_URL`         | empty     | Public callback URL for installed agents.                                                   |
| `ALLOW_INSECURE_AGENT_HTTP`     | `false`   | Allows HTTP agent callback URLs when explicitly accepted.                                   |
| `DASHBOARD_SESSION_TTL_SECONDS` | `28800`   | Dashboard session TTL in seconds.                                                           |
| `DASHBOARD_PUBLIC_ORIGIN`       | empty     | Expected Origin header for CSRF protection.                                                 |
| `DASHBOARD_COOKIE_SECURE`       | `true`    | Set HttpOnly cookie Secure flag.                                                            |
| `DASHBOARD_COOKIE_SAME_SITE`    | `lax`     | SameSite cookie attribute.                                                                  |
| `TRUST_PROXY_HOPS`              | `0`       | Number of reverse proxy hops to trust for client IP. Set to `1` when behind an HTTPS proxy. |

### Local agent updates and optional release catalog

Host agent upgrades do not require external catalog variables or manual signing keys. The API container bundles architecture-specific agent and updater binaries directly. Deployment automatically prepares the host updater via `scripts/install/prepare-agent-updater.sh`, keeping host updaters updated to protocol 3 while preserving credentials, configuration, and state. The deployment convergence service automatically converges idle managed agents to the deployed build identity. Optional Ed25519-signed release manifests are reserved exclusively for AI runtime components (`ai-executor`, `ai-host-helper`, `ai-rootfs`, `ai-profiles`); signed rollouts for `agent` and `updater` components are rejected in favor of deployment-bundled convergence.

## Server requirements

The target server needs:

- Docker
- Docker Compose v2 (`docker compose`)
- SSH access using the configured key
- Access to pull from `ghcr.io` during the deployment workflow

The workflow writes a production `.env` and `docker-compose.yml` into `DEPLOY_PATH`. Secrets from GitHub Actions are written to the server-side `.env` file with `chmod 600`; compose services load it with `env_file`.

Then the workflow runs:

```bash
docker compose pull
docker compose up -d postgres
docker compose run --rm api node dist/db/migrate.js
# Optional and non-fatal:
docker compose run --rm api node dist/db/migrate.js --include-optional || true
docker compose up -d --remove-orphans
docker compose ps
```

After the first deploy (if `DASHBOARD_ADMIN_PASSWORD` was not set), set the dashboard admin password via SSH:

```bash
# Safer: read password from stdin without showing in process list
# (paste or pipe the password when prompted)
printf 'Dashboard password: ' > /dev/tty && read -rs password && printf '%s\n' "$password" | docker compose -f /opt/vps-manager-nodejs/docker-compose.yml run --rm api node dist/scripts/set-dashboard-password.js --stdin && unset password
```

Alternatively, set the `DASHBOARD_ADMIN_PASSWORD` GitHub Secret and redeploy — the CI workflow will bootstrap it automatically.

To rotate the password without downtime, pipe the new password with `--skip-if-same`:

```bash
printf 'New password: ' > /dev/tty && read -rs password && printf '%s\n' "$password" | docker compose -f /opt/vps-manager-nodejs/docker-compose.yml run --rm api node dist/scripts/set-dashboard-password.js --stdin --skip-if-same && unset password
```

The `--skip-if-same` flag avoids unnecessary session revocations when the password hasn't changed (e.g., re-running the deploy CI without changing the secret).

The database password is stored in the server-side `.env` file for this single-host deployment. To rotate it after the `vps-manager-postgres` volume exists, update the DB user password with `ALTER USER`, update the GitHub secret, then redeploy.
### Compose application keyring operations

Compose management is disabled per VPS until an operator opts in. API/web CI deployment alone does not opt in a VPS, install/upgrade Compose, or cause a stack start/deploy. Before enabling Compose secrets, provision a separate external keyring at `/etc/flexserver/compose-keyring.json`, distinct from the SSH keyring, and preserve it in a restricted offline backup separate from the encrypted JSON/PostgreSQL store backup. Without the original keyring, encrypted values cannot be recovered; do not run `init` over existing ciphertext.

The API image includes the compiled CLI at `node dist/scripts/manage-compose-keys.js`; root `scripts/admin` TypeScript wrappers are for source installs and are not copied into the API image. Use the same `.env`/storage configuration as the API. Stop all API writers before administration because the CLI holds an exclusive administrative lock. Back up ciphertext and keyring before rotation; preserve old KEKs until all retained encrypted fields have been successfully rewrapped. Never remove a live lock to force progress.

For a standalone deployment, the read-only keyring override keeps the normal API read-only:

```bash
docker compose -f docker-compose.yml -f docker-compose.keyring.yml up -d
```

To initialize or rotate, stop all API writers, use the separate admin override for a one-shot command, then restart with the read-only configuration:

```bash
docker compose stop api
docker compose -f docker-compose.yml -f docker-compose.keyring.yml -f docker-compose.keyring-admin.yml run --rm --no-deps api node dist/scripts/manage-compose-keys.js init
docker compose up -d
```

Replace `init` with `check`, `rotate`, or `rewrap` as appropriate. The CLI never clears a live lock. After atomic keyring replacement, restarting the API ensures its read-only mount sees the replacement. Never leave the read-write admin override in normal service configuration.

Use private registries only with trusted TLS certificate verification and scoped credentials; do not disable TLS checks. The API container has no Docker socket or host-root mount. Compose operation readiness timeout does not automatically stop or revert workloads. An uncertain result requires reconciliation before retry. Redeploying an earlier application revision does not roll back data volumes or database state; take workload-specific backups before changes and restore data separately if needed.


## Manual run

The workflow supports `workflow_dispatch`, so it can be run manually from the GitHub Actions tab. The `force_api_build` / `force_web_build` inputs only ever add an image build — leaving them unchecked (`false`) never forces anything; on a manual run from `main` the full matrix runs regardless of the force inputs.
