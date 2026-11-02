# FlexServer API

NestJS 11 API using the Express adapter and TypeScript ESM. These instructions apply to `packages/api/` and supplement the [root instructions](../../AGENTS.md).

## Commands

Run from the repository root after `npm ci`:

```bash
npm run dev
npm run typecheck -w @vps-manager/api
npm test -- packages/api/tests
npm run build:api
```

The compiler emits to root `dist/`. Run tests through the root Vitest configuration. PostgreSQL integration tests require `VPS_MANAGER_TEST_POSTGRES_URL` pointing to a dedicated test database; running migrations against real data requires approval under the root policy.

## Application structure

- `src/server.ts` starts the application; `src/app.ts` owns application creation, middleware, exception filtering, static serving, and WebSocket setup.
- `src/app.module.ts` assembles the dynamic module through `createAppModule`. Reuse Symbol injection tokens from `src/tokens.ts` and existing dependency override seams rather than introducing parallel service wiring.
- Keep controllers thin. Follow existing controller/service pairs: receive untrusted bodies as `unknown`, validate through the relevant Zod schema in the domain/service layer, and apply authorization before side effects.
- Preserve the established `{ data: ... }` JSON response shape where used. Route errors through `ApiExceptionFilter` and existing domain error types; streaming and WebSocket endpoints have their own protocols.
- TypeScript uses `NodeNext` resolution. Use `.js` specifiers for relative imports in TypeScript source, matching the emitted ESM files.

## Persistence and configuration

- `src/persistence/repositories/` defines repository contracts, JSON/PostgreSQL implementations, and the repository factory. Keep both drivers behaviorally consistent when changing a contract.
- Preserve JSON file locking and PostgreSQL parameterized queries. Keep database row mapping in the existing mapper layer.
- SQL migration files live in `db/migrations/`; `src/db/migrations.ts` is the migration runner, not the SQL directory. Follow its ordering, transaction, and optional-extension handling when adding a migration.
- `src/config/app-config.ts` is the configuration validation boundary. Update `.env.example` and relevant configuration tests when adding or changing environment variables.
- For storage/module changes, read [architecture.md](../../docs/architecture.md); for authentication, credentials, execution, or transport changes, read [security.md](../../docs/security.md).

## Security-sensitive boundaries

- Dashboard sessions, unsafe-request origin checks, and agent Bearer credentials are separate authentication paths. Preserve the appropriate guard for each endpoint rather than reusing one indiscriminately.
- Use existing redaction helpers for errors, logs, and audit metadata; do not expose raw transport/provider errors or credential material.
- Keep demo implementations isolated from real transports. Inject dependencies through the existing application factory when testing host operations.
- For AI tasks, keep approval state, execution privileges, and credential access checks enforced server-side; client state is not authorization.

## Tests

- API tests live in `tests/` and use Vitest with explicit imports rather than implicit globals.
- Reuse `tests/test-helpers.ts` for application creation, session cookies, and `closeTestApps()` cleanup. Close applications and release resources after tests.
- Use isolated temporary directories for filesystem-backed stores. PostgreSQL tests must preserve the existing isolated-schema setup and cleanup.
- Cover consumer-visible validation, authorization, error mapping, persistence parity, and state transitions. Exercise the changed endpoint or transport in addition to running relevant tests.
