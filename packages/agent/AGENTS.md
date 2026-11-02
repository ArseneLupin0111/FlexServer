# FlexServer Host Agent

Independent Go module (`github.com/vps-manager/agent`) for Linux monitoring, host operations, and privileged helpers. These instructions apply to `packages/agent/` and supplement the [root instructions](../../AGENTS.md).

## Commands

Run from `packages/agent/` with Go 1.21+:

```bash
go test ./...
go test ./internal/config ./internal/lock
go test -race ./...
```

- The race detector requires a supported platform and CGO/toolchain support; CI uses Go 1.23.x.
- From the repository root, `npm run build:agent` produces the production Linux amd64/arm64 artifacts with the existing build script. Production binaries use `CGO_ENABLED=0`; this is separate from race-test requirements.
- Preserve cross-platform compilation with the existing Linux/non-Linux/Windows files and build constraints. A Windows test run does not prove Linux-only behavior; verify changed Linux paths on Linux.
- Running the daemon or host helpers can affect the host. Use isolated test fixtures rather than starting privileged services for a smoke check.

## Package map

- `cmd/vps-agent/`: main daemon, startup flags, configuration validation, and singleton locking.
- `cmd/host-pty/` and `cmd/host-files/`: host terminal and filesystem helpers.
- `cmd/local-agent-rotator/`: authenticated local credential rotation with rollback handling.
- `cmd/ai-executor/`: isolated AI execution; `cmd/ai-host-helper/`: privileged, profile-constrained host operations.
- `cmd/agent-build-id/` and `internal/buildidentity/`: deterministic build identity. Preserve compatibility with the root build script and version metadata.
- `internal/config/`: configuration parsing and validation; `internal/state/`: durable agent state; `internal/commands/`: command validation and execution.
- `profiles/`: allowed service actions, configuration paths, and validators used by privileged helpers.

## Invariants

- Keep `vps-agent -validate-config` offline: it must validate without acquiring the singleton lock, provisioning state, or contacting the network.
- Preserve non-blocking singleton locking per VPS identity. Keep lock-file inode handling intact; unlinking an active lock file can permit duplicate agents.
- Preserve HTTPS/loopback HTTP validation and token redaction in configuration formatting.
- Validate host commands through existing operation allowlists and identifier checks before execution. Keep shared host-operation locking across conflicting actions.
- Retain Unix-socket peer-credential checks, privilege boundaries, file permissions, and credential-rotation rollback behavior.
- Keep AI sandbox execution separate from privileged profile-based operations. Extend explicit profiles and validation rather than accepting arbitrary host commands or paths.
- Preserve durable state identity and HMAC-derived opaque identifiers when changing Docker inventory/state handling.

## Cross-package changes

- Agent payloads and command results are consumed by `packages/api`. When changing a wire contract, update API validation/consumers and both sides' tests in the same change.
- Build identity, manifests, binary names, and validation flags are consumed by root build/install/upgrade tooling. Read [local-agent-upgrade-operations.md](../../docs/local-agent-upgrade-operations.md) before changing those contracts.
- For execution privileges, sockets, credentials, or filesystem access, read [security.md](../../docs/security.md).

## Verification

- Keep tests alongside Go source as `*_test.go`; reuse temporary directories, fake transports, and existing platform-specific test patterns.
- Cover rejection paths and observable state transitions for locks, commands, configuration, and rotation; keep tests independent of production services and credentials.
- Format changed Go files with `gofmt`. Run targeted tests, then the module suite and race checks where supported. Exercise changed Linux-specific behavior in an isolated Linux environment and report platform checks not performed.
- Treat compiled binaries and generated manifests as build outputs; regenerate through the root build tooling instead of editing them.
