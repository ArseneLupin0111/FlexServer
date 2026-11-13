import type { AiBundle } from "../ai/ai-bundle.service.js";
import type { BundledAgentMetadata } from "../local-upgrade/bundled-agent.service.js";

export type AgentPackageManifest = {
  schemaVersion: 1;
  os: "linux";
  arch: "amd64" | "arm64";
  agent: {
    version: string;
    buildId: string;
    sha256: string;
    size: number;
  };
  ai: {
    bundleId: string;
    artifacts: Array<{ relativePath: string; sha256: string; size: number }>;
  } | null;
};

export function createAgentPackageManifest(
  agent: BundledAgentMetadata,
  ai: AiBundle | null,
): AgentPackageManifest {
  if (ai && ai.arches[agent.arch] === null) {
    throw new Error(`AI bundle has no ${agent.arch} artifacts`);
  }
  return {
    schemaVersion: 1,
    os: "linux",
    arch: agent.arch,
    agent: {
      version: agent.version,
      buildId: agent.buildId,
      sha256: agent.sha256,
      size: agent.size,
    },
    ai: ai
      ? {
          bundleId: ai.bundleId,
          artifacts: ai.files.map(({ relativePath, sha256, size }) => ({
            relativePath,
            sha256,
            size,
          })),
        }
      : null,
  };
}
