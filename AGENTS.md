# FlexServer

FlexServer (`vps-manager-nodejs`) is a self-hosted VPS monitoring and management application with a NestJS/Express API, a React/Vite dashboard, and a Go host agent. See [README.md](README.md) for features and deployment instructions.

## Scope

- This file applies repository-wide. If a subdirectory contains an `AGENTS.md`, follow the nearest applicable file for that scope; explicit user instructions take precedence over repository instructions.
- Use npm and `package-lock.json`. The npm workspaces are `packages/api` and `packages/web`; `packages/agent` is a separate Go module.

## Setup and development

Run the commands below from the repository root. Use Node.js 22 and npm; Go 1.21+ is required for agent changes (CI uses Go 1.23.x). Container deployments require Docker Compose v2; installer tools require Python 3.

```bash
npm ci
npm run dev       # API, first terminal
npm run dev:web   # Vite, second terminal
```

- Consult `.env.example` before creating local configuration; preserve any existing `.env`. Keep secret values out of documentation and source code.
- Use `APP_MODE=demo` for development without real VPS connections. `APP_MODE=local` requires authentication, origin, SSH, and keyring configuration described in the README and security documentation; preserve validation rather than bypassing it to start the application.
- After building, `npm start` runs the compiled API and serves the frontend from `public/`.

## Build and verification

```bash
npm run typecheck
npm test
npm run test:agent
npm run build
npm run check:docs
```

Targeted checks and browser journeys:

```bash
npm test -- packages/api/tests
npm run check:docs -- AGENTS.md
npx playwright install chromium
npm run test:e2e
```

- For Vitest, replace the example path with an existing relevant test file or directory. Configuration lives in `vitest.config.ts`: API tests use Node, and web tests use jsdom. Browser tests live in `e2e/`.
- `npm run test:e2e` builds before running Chromium. PostgreSQL integration checks require a dedicated test database and `VPS_MANAGER_TEST_POSTGRES_URL`; never use a production database.
- For Go agent changes, also run `go test -race ./...` from `packages/agent` in an environment supporting the race detector/CGO. `npm run build:agent` builds Linux amd64/arm64 binaries.
- The repository has no `lint` or `format` script; do not assume `npm run lint` exists.
- Run checks appropriate to the changes. Before handing off code changes, run the relevant quality gates above and exercise the changed behavior. Report any checks not run and why.

## Source map and conventions

- `packages/api/src/`: NestJS modules, controllers, and services. Preserve Zod validation at configuration/input boundaries and reuse existing authentication and redaction mechanisms.
- `packages/api/src/persistence/`: JSON and PostgreSQL storage implementations. When changing a persistence contract, update both implementations and related tests.
- `packages/api/db/migrations/`: SQL migrations. Read the migration workflow before changing schemas; never experiment by running migrations against real data.
- `packages/api/tests/`: API tests. Frontend test locations are defined by `vitest.config.ts`; Go tests follow the `*_test.go` convention within the Go module.
- `packages/web/src/`: React/TypeScript dashboard. Before changing UI, read [DESIGN.md](DESIGN.md) and [MASTER.md](MASTER.md); reuse existing components/tokens and `components/Brand.tsx` for branding.
- `packages/agent/`: Go host agent and supporting executables. Preserve the singleton lock, offline configuration validation, and execution privilege boundaries.
- `scripts/`: Administration, installer, CI, and release tools. Many scripts affect real VPS hosts or credentials; they are not smoke-test commands.

## Safety and approvals

- Keep demo mode isolated from real SSH connections, Docker sockets, and host commands. Never mount the Docker engine socket into the API container.
- Preserve session checks, origin checks, SSH host-key pinning, terminal limits, and secret redaction in `packages/api/src/common/redaction.ts`.
- Keyrings configured by `SSH_KEY_ENCRYPTION_KEY_FILE`, `COMPOSE_KEYRING_FILE`, and `AI_KEYRING_FILE` must reside outside the repository, `DATA_DIR`, and `PRIVATE_DIR`. Never print or commit passwords, private keys, tokens, or `.env` contents.
- Keep the AI assistant's `execMode` (sandbox/privileged) distinct from `executionMode` (manual/yolo). Preserve operation approvals and explicit consent requirements for yolo mode.
- Obtain user approval before deploying, releasing, publishing, running migrations, deleting data, installing or upgrading agents on real hosts, rotating or revoking credentials, changing permissions, or operating on production. Do not run administration scripts merely to check syntax.

## Do not edit directly

- `dist/`, `public/assets/`, `packages/web/dist/`, and Go binaries: build outputs. Change source files and use the corresponding build scripts.
- `node_modules/`: dependencies. Update through npm and the lockfile only when needed.
- `data/`, `data-local/`, `private/`, `private-local/`, `.server/`, `.env`, key files, and logs: local data, configuration, and artifacts. Do not overwrite, clean up, or commit them as part of code changes.
- `hermes-agent/`: an external checkout outside the npm workspaces. Change it only when explicitly required by the task, and read its own instructions first.

## Task-specific documentation

- For module, data-flow, or persistence changes, read [docs/architecture.md](docs/architecture.md).
- For authentication, SSH, terminal, encryption, or AI execution privilege changes, read [docs/security.md](docs/security.md).
- For installer, upgrade, or deployment changes, read [docs/local-agent-upgrade-operations.md](docs/local-agent-upgrade-operations.md) and [docs/ci-cd.md](docs/ci-cd.md).
- Update this file when commands, conventions, or safety boundaries change. Update the README/CHANGELOG when product behavior changes.
