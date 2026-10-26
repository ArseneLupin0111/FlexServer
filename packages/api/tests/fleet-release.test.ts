import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signFleetManifest, verifyFleetManifest } from "../../../scripts/release/fleet-release.mjs";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const payload = {
    schemaVersion: 1, channel: "stable", releaseId: "a".repeat(40), buildId: "a".repeat(40),
    version: "1.2.3", publishedAt: "2026-10-22T00:00:00Z", rollbackSafe: true,
    artifacts: ["agent"].map(component => ({ component, os: "linux", arch: "amd64", url: `https://example.com/${component}`, sha256: "b".repeat(64), size: 123, version: "1.2.3" })),
  };
  return { privateKey, publicKey, payload };
}

describe("fleet signed releases", () => {
  it("authenticates exact payload bytes rather than equivalent recanonicalized JSON", () => {
    const { privateKey, publicKey, payload } = fixture();
    const envelope = signFleetManifest(payload, privateKey, "test-key");
    expect(verifyFleetManifest(envelope, publicKey)).toEqual(payload);
    expect(() => verifyFleetManifest({ ...envelope, payload: JSON.stringify(payload, null, 2) }, publicKey)).toThrow(/signature/);
    expect(() => verifyFleetManifest({ ...envelope, payload: envelope.payload.replace('"rollbackSafe":true', '"rollbackSafe":false') }, publicKey)).toThrow(/signature/);
  });

  it("rejects an untrusted signing key and noncanonical signatures", () => {
    const { privateKey, publicKey, payload } = fixture();
    const envelope = signFleetManifest(payload, privateKey, "test-key");
    const wrong = fixture().publicKey;
    expect(() => verifyFleetManifest(envelope, wrong)).toThrow(/signature/);
    expect(() => verifyFleetManifest({ ...envelope, signature: envelope.signature + "\n" }, publicKey)).toThrow(/signature/);
  });

  it("refuses ambiguous or incomplete platform component sets before publication", () => {
    const { privateKey, payload } = fixture();
    expect(() => signFleetManifest({ ...payload, artifacts: [ { ...payload.artifacts[0], component: "ai-executor" } ] }, privateKey, "test-key")).toThrow(/Incomplete AI/);
    expect(() => signFleetManifest({ ...payload, artifacts: [...payload.artifacts, { ...payload.artifacts[0], url: "https://example.com/agent2" }] }, privateKey, "test-key")).toThrow(/Duplicate/);
    expect(() => signFleetManifest({ ...payload, artifacts: [...payload.artifacts, { ...payload.artifacts[0], component: "ai-executor" }] }, privateKey, "test-key")).toThrow(/Incomplete AI/);
  });

  it("signs and verifies AI-only releases without requiring agent/updater artifacts", () => {
    const { privateKey, publicKey } = fixture();
    const aiComponents = ["ai-executor", "ai-host-helper", "ai-rootfs", "ai-profiles"];
    const aiPayload = {
      schemaVersion: 1, channel: "stable", releaseId: "c".repeat(40), buildId: "c".repeat(40),
      version: "2.0.0", publishedAt: "2026-10-22T00:00:00Z", rollbackSafe: true,
      artifacts: aiComponents.map(component => ({
        component, os: "linux", arch: "amd64", url: `https://example.com/${component}`,
        sha256: "d".repeat(64), size: 1024, version: "2.0.0"
      })),
    };
    const envelope = signFleetManifest(aiPayload, privateKey, "ai-key");
    expect(verifyFleetManifest(envelope, publicKey)).toEqual(aiPayload);
  });
});
