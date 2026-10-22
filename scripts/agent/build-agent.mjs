#!/usr/bin/env node

/**
 * Cross-platform build script for the Go agent and updater.
 * Sets GOOS=linux GOARCH=amd64 to produce Linux binaries on any host.
 *
 * Build identity (parity with the Dockerfile agent-builder stage):
 *   -X ...version.Value=<semver>          display version (AGENT_VERSION, defaults to dev)
 *   -X ...version.Build=<40-hex content ID>  deterministic content identity via agent-build-id CLI
 * `-version` prints "<Value>+<Build>" ("<Value>" alone when Build is unknown).
 * Both binaries share one identity.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const agentDir = join(root, "packages", "agent");
const outputDir = join(agentDir, "dist");
const agentOutputPath = join(outputDir, "vps-agent-linux-amd64");
const updaterOutputPath = join(outputDir, "vps-updater-linux-amd64");
const hostPtyOutputPath = join(outputDir, "host-pty-linux-amd64");
const hostFilesOutputPath = join(outputDir, "host-files-linux-amd64");
const rotatorOutputPath = join(outputDir, "local-agent-rotator-linux-amd64");
const aiExecutorOutputPath = join(outputDir, "ai-executor-linux-amd64");
const aiHostHelperOutputPath = join(outputDir, "ai-host-helper-linux-amd64");
const nativeExt = process.platform === "win32" ? ".exe" : "";
const hostPtyNativePath = join(outputDir, `host-pty${nativeExt}`);
const hostFilesNativePath = join(outputDir, `host-files${nativeExt}`);
const rotatorNativePath = join(outputDir, `local-agent-rotator${nativeExt}`);
const aiExecutorNativePath = join(outputDir, `ai-executor${nativeExt}`);
const aiHostHelperNativePath = join(outputDir, `ai-host-helper${nativeExt}`);
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
// The identity line printed by `-version` must stay inside the API upgrader's
// VERSION_RE ([A-Za-z0-9][A-Za-z0-9._+-]{0,63}) or remote upgrades would
// reject the binary late; enforce it at build time instead.
const VERSION_LINE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

if (!existsSync(agentDir)) {
  console.error(`Error: ${agentDir} does not exist`);
  process.exit(1);
}

console.log("Building vps-agent and vps-updater for linux/amd64...");
mkdirSync(outputDir, { recursive: true });

const agentVersion = process.env.AGENT_VERSION || "dev";

// Immutable content identity: computed deterministically from agent package
// sources and toolchain using agent-build-id CLI. Deployment ignores AGENT_BUILD_ID
// overrides and always uses content identity.
let buildId;
try {
  buildId = execSync("go run ./cmd/agent-build-id --root .", {
    cwd: agentDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CGO_ENABLED: "0" },
  })
    .toString()
    .trim();
} catch (err) {
  const errMsg = err.stderr ? err.stderr.toString() : err.message;
  console.error(`Failed to compute agent build identity: ${errMsg}`);
  process.exit(1);
}

if (!GIT_SHA_RE.test(buildId)) {
  console.error(
    `Error: agent-build-id returned non-canonical identity ("${buildId}")`,
  );
  process.exit(1);
}

const identity = `${agentVersion}+${buildId}`;
if (!VERSION_LINE_RE.test(identity)) {
  console.error(
    `Error: build identity "${identity}" does not match VERSION_RE ` +
      `([A-Za-z0-9][A-Za-z0-9._+-]{0,63}); the API upgrader would reject it. ` +
      `Set AGENT_VERSION to a compatible value.`,
  );
  process.exit(1);
}

const ldflags = [
  `-X github.com/vps-manager/agent/internal/version.Value=${agentVersion}`,
  `-X github.com/vps-manager/agent/internal/version.Build=${buildId}`,
].join(" ");

try {
  for (const [pkg, out] of [
    ["./cmd/vps-agent", agentOutputPath],
    ["./cmd/vps-updater", updaterOutputPath],
    ["./cmd/host-pty", hostPtyOutputPath],
    ["./cmd/host-files", hostFilesOutputPath],
    ["./cmd/local-agent-rotator", rotatorOutputPath],
    ["./cmd/ai-executor", aiExecutorOutputPath],
    ["./cmd/ai-host-helper", aiHostHelperOutputPath],
  ]) {
    execSync('go build -trimpath -buildvcs=false -ldflags "' + ldflags + '" -o "' + out + '" ' + pkg, {
      cwd: agentDir,
      stdio: "inherit",
      env: { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
    });
  }
} catch (err) {
  console.error("Build failed.");
  process.exit(1);
}

if (process.platform !== "linux" || process.arch !== "amd64") {
  try {
    execSync('go build -trimpath -buildvcs=false -ldflags "' + ldflags + '" -o "' + hostPtyNativePath + '" ./cmd/host-pty', {
      cwd: agentDir,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
  } catch (err) {
    if (process.platform === "win32" || process.platform === "linux") {
      console.error(`Native host-pty build failed on ${process.platform}:`, err.message);
      process.exit(1);
    }
    console.warn("Native host-pty build skipped:", err.message);
  }
}
if (process.platform !== "linux" || process.arch !== "amd64") {
  try {
    execSync('go build -trimpath -buildvcs=false -ldflags "' + ldflags + '" -o "' + hostFilesNativePath + '" ./cmd/host-files', {
      cwd: agentDir,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
  } catch (err) {
    if (process.platform === "win32" || process.platform === "linux") {
      console.error(`Native host-files build failed on ${process.platform}:`, err.message);
      process.exit(1);
    }
    console.warn("Native host-files build skipped:", err.message);
  }
}
if (process.platform !== "linux" || process.arch !== "amd64") {
  try {
    execSync('go build -trimpath -buildvcs=false -ldflags "' + ldflags + '" -o "' + rotatorNativePath + '" ./cmd/local-agent-rotator', {
      cwd: agentDir,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
  } catch (err) {
    if (process.platform === "win32" || process.platform === "linux") {
      console.error(`Native local-agent-rotator build failed on ${process.platform}:`, err.message);
      process.exit(1);
    }
    console.warn("Native local-agent-rotator build skipped:", err.message);
  }
}
if (process.platform !== "linux" || process.arch !== "amd64") {
  try {
    execSync('go build -trimpath -buildvcs=false -ldflags "' + ldflags + '" -o "' + aiExecutorNativePath + '" ./cmd/ai-executor', {
      cwd: agentDir,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
  } catch (err) {
    if (process.platform === "win32" || process.platform === "linux") {
      console.error(`Native ai-executor build failed on ${process.platform}:`, err.message);
      process.exit(1);
    }
    console.warn("Native ai-executor build skipped:", err.message);
  }
}
if (process.platform !== "linux" || process.arch !== "amd64") {
  try {
    execSync('go build -trimpath -buildvcs=false -ldflags "' + ldflags + '" -o "' + aiHostHelperNativePath + '" ./cmd/ai-host-helper', {
      cwd: agentDir,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0" },
    });
  } catch (err) {
    if (process.platform === "win32" || process.platform === "linux") {
      console.error(`Native ai-host-helper build failed on ${process.platform}:`, err.message);
      process.exit(1);
    }
    console.warn("Native ai-host-helper build skipped:", err.message);
  }
}


for (const out of [agentOutputPath, updaterOutputPath, hostPtyOutputPath, hostPtyNativePath, hostFilesOutputPath, hostFilesNativePath, rotatorOutputPath, rotatorNativePath, aiExecutorOutputPath, aiExecutorNativePath, aiHostHelperOutputPath, aiHostHelperNativePath]) {
  if (existsSync(out)) {
    const stats = statSync(out);
    const sizeKB = (stats.size / 1024).toFixed(1);
    const name = out.split(/[/\\]/).pop();
    console.log(`\n✓ Built: packages/agent/dist/${name} (${sizeKB} KB)`);
  }
}
if (existsSync(agentOutputPath)) {
  const agentBuf = readFileSync(agentOutputPath);
  const agentSha = createHash("sha256").update(agentBuf).digest("hex");
  const agentMeta = {
    os: "linux",
    arch: "amd64",
    version: agentVersion,
    buildId: buildId,
    sha256: agentSha,
    size: agentBuf.length,
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(`${agentOutputPath}.json`, JSON.stringify(agentMeta, null, 2));
}
for (const [binPath, componentName] of [
  [updaterOutputPath, "updater"],
  [aiExecutorOutputPath, "ai-executor"],
  [aiHostHelperOutputPath, "ai-host-helper"],
]) {
  if (existsSync(binPath)) {
    const buf = readFileSync(binPath);
    const sha = createHash("sha256").update(buf).digest("hex");
    const meta = {
      component: componentName,
      os: "linux",
      arch: "amd64",
      version: agentVersion,
      buildId: buildId,
      sha256: sha,
      size: buf.length,
      publishedAt: new Date().toISOString(),
    };
    writeFileSync(`${binPath}.json`, JSON.stringify(meta, null, 2));
  }
}

import("./build-rootfs.mjs")
  .then(({ buildRootfs }) => {
    try {
      buildRootfs(outputDir);
    } catch (err) {
      console.warn("Rootfs build warning:", err.message);
    }
  })
  .catch((err) => {
    console.warn("Rootfs builder import warning:", err.message);
  });
console.log(`  identity: ${identity}`);
