import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptComposeField, encryptComposeField, rewrapComposeEnvelope, type ComposeAadContext } from "../src/crypto/secret-envelope.js";
import type { Keyring } from "../src/ssh/key-encryption.js";

const context: ComposeAadContext = { vpsId: "vps-a", appId: "app-a", field: "secret", version: 1 };
function keyring(): Keyring {
  return { version: 1, activeKekId: "first", keys: { first: { key: randomBytes(32).toString("base64") } } };
}

describe("Compose encrypted field identity", () => {
  it.each([
    { ...context, vpsId: "vps-b" },
    { ...context, appId: "app-b" },
    { ...context, field: "registryCredential" as const },
    { ...context, version: 2 },
  ])("rejects substitution into another identity: %j", (other) => {
    const keys = keyring();
    const envelope = encryptComposeField("protected-value", context, keys);
    expect(decryptComposeField(envelope, context, keys)).toBe("protected-value");
    expect(() => decryptComposeField(envelope, other, keys)).toThrow();
  });

  it("rewraps without changing protected payload and retains prior-key recovery", () => {
    const keys = keyring();
    const original = encryptComposeField("protected-value", context, keys);
    keys.keys.second = { key: randomBytes(32).toString("base64") };
    keys.activeKekId = "second";
    const rotated = rewrapComposeEnvelope(original, context, keys);
    expect(rotated.kekId).toBe("second");
    expect(rotated.encryptedKey).toEqual(original.encryptedKey);
    expect(decryptComposeField(rotated, context, keys)).toBe("protected-value");
    expect(decryptComposeField(original, context, keys)).toBe("protected-value");
    const newOnly = { ...keys, keys: { second: keys.keys.second! } };
    expect(decryptComposeField(rotated, context, newOnly)).toBe("protected-value");
    expect(() => decryptComposeField(original, context, newOnly)).toThrow();
  });
});
