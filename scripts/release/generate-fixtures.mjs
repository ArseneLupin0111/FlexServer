#!/usr/bin/env node
// Generate the committed release-manifest fixture vectors.
//
// TEST FIXTURE ONLY: the keypair is derived from a fixed, publicly known
// seed string so anyone can regenerate these files. It must never appear in
// any production configuration (CI secret, API env, updater trust store);
// real release keys are generated offline and live only in the protected
// GitHub `release` environment secret.
//
// Outputs (scripts/release/fixtures/, byte-exact, no trailing newline):
//   manifest.canonical.txt   canonical bytes of the UNSIGNED fixture document
//                            — the shared byte-agreement contract between the
//                            TS API, this mjs tooling, and the Go updater
//   manifest.signature.b64   Ed25519 signature over those bytes
//   manifest.pubkey.b64      raw 32-byte public key, base64
//   manifest.valid.json      fully signed document (canonical serialization)
//   manifest.tampered.json   signed document with one artifact sha256 altered
//                            (valid JSON, signature must fail)
//   manifest.multicomponent.json  signed document with BOTH release
//                            components, mirroring what fleet-release.yml
//                            publishes

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson, canonicalizeManifest } from "./lib/canonical.mjs";

const SEED_LABEL = "vps-manager release-manifest fixture key v1 TEST ONLY";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const FIXTURE_SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const SHA256_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHA256_B = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const seed = createHash("sha256").update(SEED_LABEL, "utf8").digest();
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
  format: "der",
  type: "pkcs8",
});
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("fixture seed did not produce an Ed25519 key");
}
const publicKey = createPublicKey(privateKey);
const spki = publicKey.export({ format: "der", type: "spki" });
const rawPublicKey = spki.subarray(spki.length - 32);

const unsignedDocument = {
  releaseId: FIXTURE_SHA,
  version: "1.2.3",
  buildId: FIXTURE_SHA,
  channel: "stable",
  publishedAt: "2026-01-15T00:00:00Z",
  apiCompatibility: { min: 2, max: 2 },
  artifacts: [
    {
      component: "agent",
      os: "linux",
      arch: "amd64",
      size: 8_345_672,
      sha256: SHA256_A,
      url: `https://github.com/example-org/vps-manager-nodejs/releases/download/agent-${FIXTURE_SHA}/vps-agent-linux-amd64`,
    },
    {
      // No `component` on purpose: consumers must default it to "agent".
      os: "linux",
      arch: "arm64",
      size: 8_301_224,
      sha256: SHA256_B,
      url: `https://github.com/example-org/vps-manager-nodejs/releases/download/agent-${FIXTURE_SHA}/vps-agent-linux-arm64`,
    },
  ],
};

const canonicalText = canonicalizeManifest(unsignedDocument);
const signature = sign(null, Buffer.from(canonicalText, "utf8"), privateKey).toString(
  "base64",
);
const signedText = canonicalJson({ ...unsignedDocument, signature });
const tamperedText = canonicalJson({
  ...unsignedDocument,
  artifacts: [
    { ...unsignedDocument.artifacts[0], sha256: SHA256_B },
    unsignedDocument.artifacts[1],
  ],
  signature,
});

// Signed multi-component manifest — the layout fleet-release.yml publishes
// (see the workflow's Sign and verify stable manifest step).
const multicomponentDocument = {
  ...unsignedDocument,
  artifacts: [
    unsignedDocument.artifacts[0],
    unsignedDocument.artifacts[1],
  ],
};
const multicomponentCanonical = canonicalizeManifest(multicomponentDocument);
const multicomponentSignature = sign(
  null,
  Buffer.from(multicomponentCanonical, "utf8"),
  privateKey,
).toString("base64");
const multicomponentText = canonicalJson({
  ...multicomponentDocument,
  signature: multicomponentSignature,
});

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
mkdirSync(fixturesDir, { recursive: true });
writeFileSync(`${fixturesDir}manifest.canonical.txt`, canonicalText, "utf8");
writeFileSync(`${fixturesDir}manifest.signature.b64`, signature, "utf8");
writeFileSync(`${fixturesDir}manifest.pubkey.b64`, rawPublicKey.toString("base64"), "utf8");
writeFileSync(`${fixturesDir}manifest.valid.json`, signedText, "utf8");
writeFileSync(`${fixturesDir}manifest.tampered.json`, tamperedText, "utf8");
writeFileSync(
  `${fixturesDir}manifest.multicomponent.json`,
  multicomponentText,
  "utf8",
);

process.stderr.write(
  `fixtures written: canonical ${canonicalText.length}B, signature ${signature}, pubkey ${rawPublicKey.toString("base64")}\n`,
);
