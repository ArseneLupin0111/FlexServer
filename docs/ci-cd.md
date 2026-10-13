# CI/CD

This repository uses GitHub Actions for verification, Docker image publishing, and optional SSH deployment.

## Workflow

Workflow file: `.github/workflows/ci.yml`

### Pull requests

Pull requests run conditional verification behind a lightweight `changes` job (path filters, no toolchains installed): Node, Go, installer, updater, database, and image steps run only when their paths change, so a docs-only PR skips almost everything. Pushes to `main` force the full check matrix and both image builds. Pull requests do not publish images to GHCR and do not run the production deploy job.

Image filters intentionally include both Node workspaces: the current Dockerfile builds both in its shared build stage, so a web-only change still rebuilds both runtime images. Database integrations skip web-only changes; docs-only changes skip Node, Go, image, installer/updater, and database checks. Workflow and hardening-fixture changes re-run the affected safety checks.
After change detection, `verify-checks` (Node tests/typecheck/CLI smoke), `verify-go` (Go, installer/updater and Compose checks), `verify` (image builds, identity checks, scans and artifacts), and the two database jobs run independently. The existing `Verify` and `Verify checks` status names remain; `Verify Go checks` is an additional mandatory gate. The Go job pins Node 24 for updater validation without installing npm dependencies. API/web builds stay on one runner to reuse their shared Docker build stage. Go race tests use the runner's GCC, installing it only when absent.


Every pull request runs change detection, then only the matching checks:

1. When Node paths change: `npm ci`, `npm test`, `npm run typecheck`, and the `--help` script smoke tests. `npm run build` runs only as a fallback when no Docker target builds (both image targets run the same build inside Docker).
2. When installer paths change: `bash scripts/tests/test-installer-docker-access.sh`.
3. When updater (or agent) paths change: pinned `Setup Go`, then `bash scripts/tests/test-updater.sh`.
4. `docker compose config --quiet` (always, cheap sanity gate).
5. When agent paths change: Go agent tested with the race detector plus `go vet`; the API image compiles agent/updater binaries, whose embedded identities are checked directly against package version and commit SHA without another standalone build in the image job.
6. When API/web paths change (or a workflow-dispatch force input selects them): Docker build checks for the affected runtime targets (`api-runtime`, `web-runtime`) with OCI labels.
7. When an API or web image is built: fail-fast smoke tests, the Docker-socket metadata guard, independent report-only Trivy scans, and the fail-closed CRITICAL gate. SBOM generation is main-only (SBOMs are release attestations; PRs are still scanned and gated).
   API/web Trivy scans run concurrently using pinned Trivy 0.70.0 after a single vulnerability database download. Each process uses an in-memory analysis cache and skips database updates, avoiding shared-cache writer contention. Both exit statuses are awaited; scanner errors or missing reports block release. Docker app builds copy only required source/config/assets, and Go compilation uses BuildKit module/compiler cache mounts (runner-local mount contents are not guaranteed to persist through the GitHub Actions layer cache).
8. When database paths change: TimescaleDB PostgreSQL migration integration (`postgres-integration`, `timescale/timescaledb:2.17.2-pg16`) runs concurrently with `verify` (no longer gated on it).
9. When database paths change: mandatory plain PostgreSQL 16 job (`docker-monitoring-postgres16`, `postgres:16`, `pg_isready` healthcheck, and `VPS_MANAGER_TEST_POSTGRES_URL`), separate from TimescaleDB; it runs the concrete migration, repository, and maintenance suites (`docker-migration-009/013/014.postgres.test.ts`, `docker-monitoring-repository.postgres.test.ts`, and `docker-monitoring-maintenance.postgres.test.ts`). `publish` requires both database jobs.

The PostgreSQL jobs run the same live-test contract against different server capabilities. Core migrations and Docker-monitoring tables must work on ordinary PostgreSQL; TimescaleDB is exercised separately for optional extension-aware deployments. Tests that require a live database are skipped when `VPS_MANAGER_TEST_POSTGRES_URL` is unset, but CI supplies it and therefore treats those cases as mandatory.

The `publish` job runs only on pushes to `main` (and equivalent non-PR workflow dispatches). It publishes the exact images built, scanned, and gated in `verify` — transferred as a checksummed `docker save` artifact with image-ID equality verification, never rebuilt. Pull requests never publish images or deploy.

### Pushes to `main`

Pushes to `main` force the full verification matrix (`full` scope: all checks and both image builds run regardless of path filters), then publish two Docker images to GHCR with the current commit SHA only (no `latest` tag for deployment):

- API:
  - `ghcr.io/sondoan17/vps-manager-nodejs-api:<commit-sha>`
- Web:
  - `ghcr.io/sondoan17/vps-manager-nodejs-web:<commit-sha>`

Transfer flow: `verify` saves both loaded images into one `docker save` archive (`verified-images-<sha>`, checksum + image-ID manifest, 1-day retention), and `publish` downloads it, verifies the checksum, loads it, asserts the image IDs match the scanned/saved images, then tags and pushes the SHA tags — build once, publish without rebuild. `publish` fails closed via an explicit `always()` needs check: every gate (`verify`, `verify-checks`, `verify-go`, both database jobs) must report `success`. Because `main` forces all jobs to run, a skipped gate can never slip through.

Deploy pulls by immutable digest (`name@sha256:...` references recorded from `RepoDigests` after the push), not by SHA tag. Rollback stays reproducible by redeploying the image for an earlier commit SHA.

After publishing, the workflow can deploy over SSH if deployment secrets are configured.

Local host agent upgrades use the bundled agent and updater binaries packaged directly in the deployed API container (`/app/agent/vps-agent-linux-amd64` and `/app/agent/vps-updater-linux-amd64`). The deployment workflow automatically extracts the bundled updater and executes `install-updater.sh --upgrade` to ensure the host updater is running protocol version 2, while preserving existing credentials and state. Deploying the API container updates the bundled agent available for upgrade, but does not automatically replace the host systemd agent on disk — local upgrades are confirmed by operators in the dashboard and safely executed by the host updater. No manual signing keys or external release catalogs are required. See `docs/local-agent-upgrade-operations.md` for updater operations, verification, and rollback.

## Runtime topology

The production deployment runs three containers:

- `postgres`: TimescaleDB/PostgreSQL database on the internal Docker network; stores data in a Docker volume.
- `api`: NestJS API on internal port `3000`; stores data in Docker volumes.
- `web`: Nginx static web server on host port `3000`; proxies `/api/*` to `api:3000` and serves the SPA fallback.

The production docker-compose binds the web container to `127.0.0.1:3000` so it listens only on the loopback interface. An external HTTPS reverse proxy (nginx, Caddy, Cloudflare Tunnel) must terminate TLS and forward to `http://127.0.0.1:3000`. The API health endpoint is reachable through the web proxy at `/api/health`.

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
| `AGENT_RELEASE_PUBLIC_KEY`      | empty     | Optional legacy Ed25519 public key (base64 of 32 raw bytes) for external catalog lookups. Unneeded for bundled local agent upgrades. |
| `AGENT_RELEASE_MANIFEST_URL`    | empty     | Optional legacy stable-channel pointer URL (`https`, allowlisted host) for external catalog lookups. Unneeded for bundled local agent upgrades. |
| `ALLOW_INSECURE_AGENT_HTTP`     | `false`   | Allows HTTP agent callback URLs when explicitly accepted.                                   |
| `DASHBOARD_SESSION_TTL_SECONDS` | `28800`   | Dashboard session TTL in seconds.                                                           |
| `DASHBOARD_PUBLIC_ORIGIN`       | empty     | Expected Origin header for CSRF protection.                                                 |
| `DASHBOARD_COOKIE_SECURE`       | `true`    | Set HttpOnly cookie Secure flag.                                                            |
| `DASHBOARD_COOKIE_SAME_SITE`    | `lax`     | SameSite cookie attribute.                                                                  |
| `TRUST_PROXY_HOPS`              | `0`       | Number of reverse proxy hops to trust for client IP. Set to `1` when behind an HTTPS proxy. |

### Local agent updates and optional release catalog

Local host agent upgrades do not require external catalog variables or manual signing keys. The API container bundles the agent and updater binaries directly. During deployment, the workflow extracts the bundled updater from the API container and executes `install-updater.sh --upgrade --binary <path> --config /etc/vps-updater/config.json`, keeping existing host updaters updated to protocol 2 while preserving credentials, configuration, and state. If an updater is absent and an HTTPS backend URL is configured, it bootstraps it.

The repository variables `AGENT_RELEASE_PUBLIC_KEY` and `AGENT_RELEASE_MANIFEST_URL` are strictly optional legacy settings for external catalog pointer lookups:
- **Unneeded for bundled local updates.** The API serves the bundled agent binary directly to authenticated updaters with protocol 2 over HTTPS.
- **If configured, both must be set together.** Setting only one variable causes the API to fail closed at startup. The public key must be base64 of exactly 32 raw Ed25519 bytes, and the pointer URL must be HTTPS on an allowlisted host. Never configure the private `AGENT_RELEASE_SIGNING_KEY` on the API or host.

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

## Manual run

The workflow supports `workflow_dispatch`, so it can be run manually from the GitHub Actions tab. The `force_api_build` / `force_web_build` inputs only ever add an image build — leaving them unchecked (`false`) never forces anything; on a manual run from `main` the full matrix runs regardless of the force inputs.
