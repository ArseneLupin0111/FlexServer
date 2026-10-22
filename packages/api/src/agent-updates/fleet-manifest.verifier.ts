import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  FleetArtifact,
  FleetArtifactComponent,
  FleetManifestEnvelope,
  FleetManifestPayload,
} from "./fleet.models.js";

const VALID_COMPONENTS: Record<FleetArtifactComponent, true> = {
  agent: true,
  updater: true,
  "ai-executor": true,
  "ai-host-helper": true,
  "ai-rootfs": true,
  "ai-profiles": true,
};

const SHA_REGEX = /^[a-f0-9]{64}$/;
const BUILD_REGEX = /^[a-f0-9]{40}$/;
const VERSION_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateFleetPayload(raw: unknown): FleetManifestPayload {
  requireValue(
    typeof raw === "object" && raw !== null,
    "Fleet release payload must be an object",
  );
  const payload = raw as Record<string, unknown>;

  requireValue(
    payload.schemaVersion === 1 && payload.channel === "stable",
    "Unsupported fleet release schema/channel",
  );
  requireValue(
    typeof payload.releaseId === "string" &&
      BUILD_REGEX.test(payload.releaseId) &&
      BUILD_REGEX.test(String(payload.buildId)) &&
      payload.releaseId === payload.buildId,
    "Release identity must match a canonical commit build ID",
  );
  requireValue(
    typeof payload.version === "string" &&
      VERSION_REGEX.test(payload.version) &&
      typeof payload.minUpdaterVersion === "string" &&
      VERSION_REGEX.test(payload.minUpdaterVersion),
    "Invalid release/updater semantic version",
  );
  requireValue(
    typeof payload.rollbackSafe === "boolean" &&
      typeof payload.publishedAt === "string" &&
      Number.isFinite(Date.parse(payload.publishedAt)),
    "Missing rollback policy or publication time",
  );
  requireValue(
    !payload.upgradeFrom ||
      (Array.isArray(payload.upgradeFrom) &&
        payload.upgradeFrom.every(
          (x: unknown) => typeof x === "string" && BUILD_REGEX.test(x),
        )),
    "Invalid intermediate upgrade identities",
  );
  requireValue(
    Array.isArray(payload.artifacts) &&
      payload.artifacts.length > 0 &&
      payload.artifacts.length <= 32,
    "Missing or excessive release artifacts",
  );

  const seen = new Set<string>();
  for (const item of payload.artifacts as unknown[]) {
    requireValue(
      typeof item === "object" && item !== null,
      "Artifact must be an object",
    );
    const a = item as Partial<FleetArtifact>;
    requireValue(
      typeof a.component === "string" &&
        Object.hasOwn(VALID_COMPONENTS, a.component) &&
        (a.arch === "amd64" || a.arch === "arm64"),
      `Unsupported component/platform: ${String(a.component)}/${String(a.os)}/${String(a.arch)}`,
    );
    const key = `${a.component}/${a.os}/${a.arch}`;
    requireValue(!seen.has(key), `Duplicate artifact ${key}`);
    seen.add(key);
    requireValue(
      typeof a.sha256 === "string" &&
        SHA_REGEX.test(a.sha256) &&
        typeof a.size === "number" &&
        Number.isSafeInteger(a.size) &&
        a.size > 0 &&
        typeof a.version === "string" &&
        VERSION_REGEX.test(a.version),
      `Invalid artifact integrity metadata ${key}`,
    );
    requireValue(typeof a.url === "string", `Missing artifact URL ${key}`);
    const url = new URL(a.url);
    requireValue(
      url.protocol === "https:" && !url.username && !url.password && !url.hash,
      `Artifact must use credential-free HTTPS ${key}`,
    );
  }

  for (const arch of ["amd64", "arm64"] as const) {
    const has = (component: FleetArtifactComponent) =>
      seen.has(`${component}/linux/${arch}`);
    const artifacts = payload.artifacts as FleetArtifact[];
    if (artifacts.some((a) => a.arch === arch)) {
      if (has("agent") || has("updater")) {
        requireValue(
          has("agent") && has("updater"),
          `Missing agent/updater pair for ${arch}`,
        );
      }
      const ai: FleetArtifactComponent[] = [
        "ai-executor",
        "ai-host-helper",
        "ai-rootfs",
        "ai-profiles",
      ];
      if (ai.some(has)) {
        requireValue(ai.every(has), `Incomplete AI runtime for ${arch}`);
      }
      requireValue(
        (has("agent") && has("updater")) || ai.every(has),
        `Missing required component set for ${arch}`,
      );
    }
  }

  if (payload.ai) {
    const ai = payload.ai;
    const isAiObj = typeof ai === "object" && ai !== null && "version" in ai && "components" in ai;
    requireValue(isAiObj, "Invalid AI compatibility metadata");
    if (isAiObj) {
      const components = ai.components;
      requireValue(
        typeof ai.version === "string" &&
          VERSION_REGEX.test(ai.version) &&
          Array.isArray(components) &&
          [
            "ai-executor",
            "ai-host-helper",
            "ai-rootfs",
            "ai-profiles",
          ].every((c) => components.includes(c)),
        "Invalid AI compatibility metadata",
      );
    }
  }

  return payload as unknown as FleetManifestPayload;
}


export function loadPublicKeyPem(pemOrPath: string): string {
  if (pemOrPath.includes("-----BEGIN")) {
    return pemOrPath;
  }
  if (existsSync(pemOrPath)) {
    return readFileSync(pemOrPath, "utf8");
  }
  throw new Error(`Fleet release public key file not found: ${pemOrPath}`);
}

export function verifyFleetManifest(
  envelope: FleetManifestEnvelope,
  publicPemOrPath: string,
): FleetManifestPayload {
  requireValue(
    envelope &&
      typeof envelope.payload === "string" &&
      Buffer.byteLength(envelope.payload) <= 128 * 1024 &&
      typeof envelope.signature === "string" &&
      typeof envelope.keyId === "string",
    "Invalid signed release envelope",
  );

  const pem = loadPublicKeyPem(publicPemOrPath);
  const key = createPublicKey(pem);
  requireValue(
    key.asymmetricKeyType === "ed25519",
    "Fleet verification key must be Ed25519",
  );

  const signature = Buffer.from(envelope.signature, "base64");
  requireValue(
    signature.length === 64 &&
      signature.toString("base64") === envelope.signature,
    "Invalid Ed25519 signature encoding",
  );

  const ok = verify(
    null,
    Buffer.from(envelope.payload, "utf8"),
    key,
    signature,
  );
  requireValue(ok, "Fleet release signature verification failed");

  return validateFleetPayload(JSON.parse(envelope.payload));
}
