/**
 * Revoke active credentials of one scope for a VPS except an explicit credential id.
 *
 * Used by the host-agent installer after a new config has been installed
 * successfully. This keeps token rotation two-phase: issue a new token first,
 * install it, then revoke old credentials only after the install step succeeds.
 *
 * Revocation is scope-aware: only credentials whose scope matches `--scope`
 * (default `agent`) are revoked, so rotating the agent credential never
 * silently revokes a differently scoped credential.
 */

import type { AgentCredentialScope } from "../agents/agent.models.js";
import { loadAppConfig } from "../config/app-config.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import { createRepositories } from "../persistence/repositories/create-repositories.js";

const DEFAULT_LOCAL_HOST_ID = "vps_local_host";
const DEFAULT_SCOPE: AgentCredentialScope = "agent";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function usage(exitCode = 0): never {
  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage: node dist/scripts/revoke-agent-credentials.js --keep-credential-id <id> [--vps-id <id>] [--scope <agent>]
Options:
  --keep-credential-id <id>  Active credential id to keep. Must belong to the
                             targeted scope, otherwise nothing is revoked.
  --vps-id <id>              VPS/host id (default: vps_local_host).
  --scope <scope>            Credential scope to revoke (default: agent).
                             "agent" = metrics/agent credentials.
  --help                     Show this help.
`);
  process.exit(exitCode);
}

/**
 * Resolve the `--scope` option. Missing/empty falls back to `agent`;
 * anything other than a known scope is rejected (no scope-blind fallbacks).
 */
export function resolveRevokeScope(raw: string | undefined): AgentCredentialScope {
  if (raw === undefined || raw === "") return DEFAULT_SCOPE;
  if (raw === "agent") return raw;
  throw new Error(`Invalid --scope "${raw}"; expected "agent".`);
}

/** Repository surface needed for scoped revocation. */
export type ScopedRevocationRepository = Pick<
  AgentRepository,
  "listCredentialsByVps" | "revokeCredential"
>;

export type ScopedRevocationOptions = {
  vpsId: string;
  scope: AgentCredentialScope;
  keepCredentialId: string;
};

export type ScopedRevocationResult = {
  keptCredentialId: string;
  revokedCredentialIds: string[];
  /** Active credentials left untouched because they belong to another scope. */
  untouchedOutOfScopeCredentialIds: string[];
};

/**
 * Revoke every active credential in `scope` for `vpsId` except
 * `keepCredentialId`, using only repository APIs (ids only, no secrets).
 *
 * Fails safe: if the keep credential is missing, not active, or outside the
 * targeted scope, an error is thrown and nothing is revoked — a wrong id must
 * neither wipe the host's active credentials (outage) nor cross a scope
 * boundary.
 */
export async function revokeScopedAgentCredentials(
  repository: ScopedRevocationRepository,
  options: ScopedRevocationOptions,
): Promise<ScopedRevocationResult> {
  const { vpsId, scope, keepCredentialId } = options;
  const credentials = await repository.listCredentialsByVps(vpsId);

  const keep = credentials.find(
    (credential) => credential.id === keepCredentialId,
  );
  if (!keep) {
    throw new Error(
      `Credential "${keepCredentialId}" not found for VPS "${vpsId}"; refusing to revoke anything.`,
    );
  }
  if (keep.status !== "active") {
    throw new Error(
      `Credential "${keepCredentialId}" is "${keep.status}", not active; refusing to revoke anything.`,
    );
  }
  const keepScope = keep.scope ?? "agent";
  if (keepScope !== scope) {
    throw new Error(
      `Credential "${keepCredentialId}" has scope "${keepScope}", expected "${scope}"; refusing to revoke anything.`,
    );
  }

  const toRevoke = credentials.filter(
    (credential) =>
      credential.status === "active" &&
      credential.id !== keepCredentialId &&
      (credential.scope ?? "agent") === scope,
  );

  const revokedCredentialIds: string[] = [];
  for (const credential of toRevoke) {
    const revoked = await repository.revokeCredential(credential.id);
    if (revoked) revokedCredentialIds.push(revoked.id);
  }

  const untouchedOutOfScopeCredentialIds = credentials
    .filter(
      (credential) =>
        credential.status === "active" &&
        (credential.scope ?? "agent") !== scope,
    )
    .map((credential) => credential.id);

  return {
    keptCredentialId: keepCredentialId,
    revokedCredentialIds,
    untouchedOutOfScopeCredentialIds,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function revokeAgentCredentialsFromCli() {
  if (process.argv.includes("--help")) usage();

  const keepCredentialId = argValue("--keep-credential-id");
  if (!keepCredentialId) usage(1);

  const vpsId = argValue("--vps-id") ?? DEFAULT_LOCAL_HOST_ID;

  let scope: AgentCredentialScope;
  try {
    scope = resolveRevokeScope(argValue("--scope"));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    usage(1);
  }

  const config = loadAppConfig();
  const repos = createRepositories(config);
  const { agent: agentRepository, pool } = repos;

  try {
    const result = await revokeScopedAgentCredentials(agentRepository, {
      vpsId,
      scope,
      keepCredentialId,
    });

    console.log(
      JSON.stringify({
        vpsId,
        scope,
        keptCredentialId: result.keptCredentialId,
        revokedCount: result.revokedCredentialIds.length,
        revokedCredentialIds: result.revokedCredentialIds,
        untouchedOutOfScopeCount: result.untouchedOutOfScopeCredentialIds.length,
      }),
    );
  } finally {
    if (pool) await pool.end();
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("revoke-agent-credentials.js") ||
  process.argv[1]?.endsWith("revoke-agent-credentials.ts");
if (isDirectRun) {
  revokeAgentCredentialsFromCli().catch((error: unknown) => {
    console.error(
      "Failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
