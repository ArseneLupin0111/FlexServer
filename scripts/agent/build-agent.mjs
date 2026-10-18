#!/usr/bin/env node

/**
 * Cross-platform build script for the Go agent and updater.
 * Sets GOOS=linux GOARCH=amd64 to produce Linux binaries on any host.
 *
 * Build identity (parity with the Dockerfile agent-builder stage):
 *   -X ...version.Value=<semver>          display version (AGENT_VERSION or package.json)
 *   -X ...version.Build=<40-hex git SHA>  immutable build identity (AGENT_BUILD_ID or git HEAD)
 * `-version` prints "<Value>+<Build>" ("<Value>" alone when Build is unknown),
 * so a release build can always be cross-checked against its manifest.
 * Both binaries share one identity: the signed release manifest pins each
 * under its own artifacts[] entry (component "agent" / "updater").
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
const nativeExt = process.platform === "win32" ? ".exe" : "";
const hostPtyNativePath = join(outputDir, `host-pty${nativeExt}`);
const hostFilesNativePath = join(outputDir, `host-files${nativeExt}`);
const rotatorNativePath = join(outputDir, `local-agent-rotator${nativeExt}`);

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

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const agentVersion = process.env.AGENT_VERSION || packageJson.version || "dev";

// Immutable build identity: explicit AGENT_BUILD_ID (CI release builds) wins;
// otherwise derive from the checked-out commit. Anything non-canonical is a
// misconfiguration and fails hard rather than silently building a "dev" identity.
let buildId = process.env.AGENT_BUILD_ID;
if (buildId === undefined || buildId === "") {
  try {
    buildId = execSync("git rev-parse HEAD", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    buildId = "";
  }
} else if (!GIT_SHA_RE.test(buildId)) {
  console.error(
    `Error: AGENT_BUILD_ID must be a full 40-hex git SHA (got "${buildId}")`,
  );
  process.exit(1);
}
if (buildId !== "" && !GIT_SHA_RE.test(buildId)) {
  console.error(
    `Error: git rev-parse HEAD returned a non-SHA value ("${buildId}"); set AGENT_BUILD_ID explicitly`,
  );
  process.exit(1);
}

const identity = buildId === "" ? agentVersion : `${agentVersion}+${buildId}`;
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
  ]) {
    execSync('go build -ldflags "' + ldflags + '" -o "' + out + '" ' + pkg, {
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
    execSync('go build -ldflags "' + ldflags + '" -o "' + hostPtyNativePath + '" ./cmd/host-pty', {
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
    execSync('go build -ldflags "' + ldflags + '" -o "' + hostFilesNativePath + '" ./cmd/host-files', {
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
    execSync('go build -ldflags "' + ldflags + '" -o "' + rotatorNativePath + '" ./cmd/local-agent-rotator', {
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


for (const out of [agentOutputPath, updaterOutputPath, hostPtyOutputPath, hostPtyNativePath, hostFilesOutputPath, hostFilesNativePath, rotatorOutputPath, rotatorNativePath]) {
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
console.log(`  identity: ${identity}`);
