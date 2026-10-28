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

describe("AgentRepository.revokeOtherActiveAgentCredentials", () => {
  it("atomically revokes older active agent-scoped credentials and preserves keep credential", async () => {
    const oldAgent1 = await repo.createCredential({ vpsId: VPS_ID, secretHash: "old-1", status: "active", scope: "agent" });
    const oldAgent2 = await repo.createCredential({ vpsId: VPS_ID, secretHash: "old-2", status: "active" }); // default scope agent
    const updater = await repo.createCredential({ vpsId: VPS_ID, secretHash: "updater", status: "active", scope: "local-updater" });
    const otherVps = await repo.createCredential({ vpsId: "vps_other", secretHash: "other", status: "active", scope: "agent" });
    const replacement = await repo.createCredential({ vpsId: VPS_ID, secretHash: "new", status: "active", scope: "agent" });

    const revoked = await repo.revokeOtherActiveAgentCredentials(VPS_ID, replacement.id);

    expect(revoked.sort()).toEqual([oldAgent1.id, oldAgent2.id].sort());
    expect(await statusOf(oldAgent1.id)).toBe("revoked");
    expect(await statusOf(oldAgent2.id)).toBe("revoked");
    expect(await statusOf(replacement.id)).toBe("active");
    expect(await statusOf(updater.id)).toBe("active");
    expect(await statusOf(otherVps.id)).toBe("active");
  });

  it("refuses to revoke anything when keepCredentialId does not exist", async () => {
    const agent = await repo.createCredential({ vpsId: VPS_ID, secretHash: "hash", status: "active" });
    await expect(repo.revokeOtherActiveAgentCredentials(VPS_ID, "cred_missing")).rejects.toThrow(/not found/);
    expect(await statusOf(agent.id)).toBe("active");
  });

  it("refuses to revoke anything when keepCredentialId is not active", async () => {
    const dead = await repo.createCredential({ vpsId: VPS_ID, secretHash: "dead", status: "revoked" });
    const live = await repo.createCredential({ vpsId: VPS_ID, secretHash: "live", status: "active" });
    await expect(repo.revokeOtherActiveAgentCredentials(VPS_ID, dead.id)).rejects.toThrow(/not active/);
    expect(await statusOf(live.id)).toBe("active");
  });

  it("refuses to revoke anything when keepCredentialId has local-updater scope", async () => {
    const updater = await repo.createCredential({ vpsId: VPS_ID, secretHash: "up", status: "active", scope: "local-updater" });
    const agent = await repo.createCredential({ vpsId: VPS_ID, secretHash: "ag", status: "active", scope: "agent" });
    await expect(repo.revokeOtherActiveAgentCredentials(VPS_ID, updater.id)).rejects.toThrow(/expected "agent"/);
    expect(await statusOf(agent.id)).toBe("active");
  });
});
