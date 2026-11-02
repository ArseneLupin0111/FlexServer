# FlexServer

FlexServer (`vps-manager-nodejs`) is a self-hosted VPS monitoring and management application with a NestJS/Express API, a React/Vite dashboard, and a Go host agent. See [README.md](README.md) for features and deployment instructions.

## Scope

- This file applies repository-wide. If a subdirectory contains an `AGENTS.md`, follow the nearest applicable file for that scope; explicit user instructions take precedence over repository instructions.
- Use npm and `package-lock.json`. The npm workspaces are `packages/api` and `packages/web`; `packages/agent` is a separate Go module.

## Agent workflow

Follow this sequence for implementation requests. For questions or investigation-only requests, stop after answering with evidence; implementation gates do not apply.

### 1. Route skills and scope the request

- Read the applicable skill instructions before using them. Use `ponytail` throughout implementation: the smallest complete change, including affected callers, contracts, tests, and documentation.
- Select skills by the request, rather than loading every skill:

  | Trigger | Skill | Required outcome |
  | --- | --- | --- |
  | Codebase structure or impact analysis | `graphify` | Identify the relevant flow and affected boundaries; use a `scout` agent for unfamiliar code. |
  | Bug, crash, incorrect behavior, or performance problem | `diagnosing-bugs` | Establish a reproducible signal, find the cause, and confirm the original scenario after the fix. |
  | Test-first feature or fix | `tdd` | Agree on public test seams with the user before writing tests; implement one failing-test-to-passing-test slice at a time. |
  | Module responsibilities or interface design | `codebase-design` | Define the contract and affected consumers before implementation. |
  | UI design or changes | `impeccable` | Follow the existing design system and verify the actual browser surface. |
  | Animation or motion | `motion` | Implement and verify the requested interaction. |
  | Agent instructions or skills | `writing-for-agents` | Keep instructions actionable, scoped, and free of duplicated rules. |

- If a named skill or tool is unavailable, report that limitation and follow the documented outcome with available tools; do not claim the skill ran. Use one applicable UI skill rather than stacking equivalent UI skills.
- Before editing, state the intended behavior, affected scope, acceptance criteria, and verification environment. Keep this brief for small changes. Ask for a decision before consequential alternatives involving contracts, architecture, compatibility, or data; otherwise proceed using repository conventions.

### 2. Implement and verify in the right environment

- Before running checks, establish the execution OS, required toolchain/services, and whether the changed path depends on Linux. Reuse that environment assessment until requirements change.
- Use WSL2 or another Linux environment for Linux-dependent tests and runtime checks. Prefer a checkout in the WSL Linux filesystem and install dependencies there; keep Windows and Linux `node_modules`, binaries, and build artifacts separate.
- Windows may run platform-independent checks supported by the project. Linux cross-compilation proves compilation only, not Linux runtime behavior. Use a dedicated Linux VM or test host for systemd, host privileges, or installer behavior that WSL/container execution does not represent; host administration still requires approval under Safety and approvals.
- If the required environment is unavailable, finish reachable checks and report the exact unverified behavior and missing prerequisite. Do not weaken assertions or add Windows-specific product workarounds merely to make Linux checks pass on Windows.
- `tdd` governs test design and the test-first loop; existing suites and smoke checks do not require a separate testing skill. Use the commands in Build and verification, selecting checks for the affected behavior rather than running every suite indiscriminately.
- For significant behavior changes, exercise the changed path in addition to automated checks: real browser interaction for UI, a running API/CLI scenario for backend/tools, and Linux execution for Linux-specific behavior. Prefer isolated demo/test resources, never production data.
- Classify failures as product defects, missing environment prerequisites, or wrong-platform execution before choosing a fix. Report the command, environment, observed result, and verification limits; build success or mocked tests alone are not runtime proof.

### 3. Review and complete

- After implementation and initial verification, use `ponytail-review` for non-trivial code changes. Review correctness, security/data safety, affected callers, risky behavior coverage, and unnecessary code. The implementation owner fixes blocking findings and reruns affected checks before completion.
- Use `code-review` instead when the request is a branch/PR review against a specified baseline, with separate standards and specification checks. Do not duplicate both review workflows by default. Documentation-only or trivial edits need the relevant document/static checks, not a full code review.
- Complete only when acceptance criteria and affected consumers are accounted for, blocking findings are resolved, and relevant documentation is updated. Remove temporary verification scaffolding.
- In the handoff, report changed behavior, checks actually exercised with their environments, and any unverified behavior or risk. Distinguish environment-blocked verification from successful verification; never describe a blocked change as fully verified.

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
