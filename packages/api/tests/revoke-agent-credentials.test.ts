import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import {
  resolveRevokeScope,
  revokeScopedAgentCredentials,
} from "../src/scripts/revoke-agent-credentials.js";

const VPS_ID = "vps_local_host";

let tempDir: string;
let repo: AgentRepository;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-revoke-"));
  repo = createJsonAgentRepository(join(tempDir, "agents.json"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function statusOf(id: string) {
  return (await repo.getCredential(id))?.status;
}

describe("resolveRevokeScope", () => {
  it("defaults to agent", () => {
    expect(resolveRevokeScope(undefined)).toBe("agent");
    expect(resolveRevokeScope("")).toBe("agent");
  });

  it("accepts known scopes and rejects everything else", () => {
    expect(resolveRevokeScope("agent")).toBe("agent");
    expect(() => resolveRevokeScope("root")).toThrow(/Invalid --scope/);
    expect(() => resolveRevokeScope("ALL")).toThrow(/Invalid --scope/);
  });
});

describe("revokeScopedAgentCredentials", () => {
  it("revokes old agent credentials only after confirming the active replacement", async () => {
    const oldAgent = await repo.createCredential({ vpsId: VPS_ID, secretHash: "old", status: "active" });
    const replacement = await repo.createCredential({ vpsId: VPS_ID, secretHash: "new", status: "active" });

    const result = await revokeScopedAgentCredentials(repo, {
      vpsId: VPS_ID,
      scope: "agent",
      keepCredentialId: replacement.id,
    });

    expect(result.revokedCredentialIds).toEqual([oldAgent.id]);
    expect(await statusOf(oldAgent.id)).toBe("revoked");
    expect(await statusOf(replacement.id)).toBe("active");
  });


  it("refuses to revoke anything when the keep credential id does not exist", async () => {
    const onlyAgent = await repo.createCredential({
      vpsId: VPS_ID,
      secretHash: "agent-hash",
      status: "active",
    });

    await expect(
      revokeScopedAgentCredentials(repo, {
        vpsId: VPS_ID,
        scope: "agent",
        keepCredentialId: "cred_does_not_exist",
      }),
    ).rejects.toThrow(/not found/);
    expect(await statusOf(onlyAgent.id)).toBe("active");
  });


  it("refuses when the keep credential is no longer active", async () => {
    const dead = await repo.createCredential({
      vpsId: VPS_ID,
      secretHash: "dead-hash",
      status: "revoked",
    });
    const liveAgent = await repo.createCredential({
      vpsId: VPS_ID,
      secretHash: "live-hash",
      status: "active",
    });

    await expect(
      revokeScopedAgentCredentials(repo, {
        vpsId: VPS_ID,
        scope: "agent",
        keepCredentialId: dead.id,
      }),
    ).rejects.toThrow(/not active/);
    expect(await statusOf(liveAgent.id)).toBe("active");
  });
});
