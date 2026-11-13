import { describe, expect, it } from "vitest";
import { createAgentPackageManifest } from "../src/agents/agent-package.models.js";
import type { BundledAgentMetadata } from "../src/local-upgrade/bundled-agent.service.js";
import type { AiBundle } from "../src/ai/ai-bundle.service.js";

const agent: BundledAgentMetadata = {
  filePath: "/tmp/vps-agent-linux-amd64",
  os: "linux",
  arch: "amd64",
  version: "1.2.3",
  buildId: "a".repeat(40),
  sha256: "b".repeat(64),
  size: 12,
  publishedAt: "2026-01-01T00:00:00.000Z",
};

const ai = {
  available: true,
  bundleId: "c".repeat(64),
  dir: "/tmp/ai",
  files: [
    { relativePath: "install-local-agent.sh", absolutePath: "/tmp/ai/install-local-agent.sh", sha256: "d".repeat(64), size: 2 },
  ],
  installerScript: {} as never,
  installerLib: null,
  profiles: [],
  arches: { amd64: {} as never, arm64: null },
} satisfies AiBundle;

describe("createAgentPackageManifest", () => {
  it("projects stable identity and artifact digests without absolute paths", () => {
    expect(createAgentPackageManifest(agent, ai)).toEqual({
      schemaVersion: 1,
      os: "linux",
      arch: "amd64",
      agent: { version: "1.2.3", buildId: "a".repeat(40), sha256: "b".repeat(64), size: 12 },
      ai: {
        bundleId: "c".repeat(64),
        artifacts: [{ relativePath: "install-local-agent.sh", sha256: "d".repeat(64), size: 2 }],
      },
    });
  });

  it("fails closed when an AI architecture is unavailable", () => {
    expect(() => createAgentPackageManifest({ ...agent, arch: "arm64" }, ai)).toThrow(
      "AI bundle has no arm64 artifacts",
    );
  });
});
