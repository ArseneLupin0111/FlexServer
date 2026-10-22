#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
const e = process.env;
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 2 ? process.argv[outputIndex + 1] : undefined;
if (!output || !/^[a-f0-9]{40}$/.test(e.BUILD_ID ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(e.REPOSITORY ?? '')) throw new Error('Missing canonical build identity/repository/output');
const artifacts = [];
for (const arch of ['amd64', 'arm64']) for (const component of ['agent', 'updater', 'ai-executor', 'ai-host-helper', 'ai-rootfs', 'ai-profiles']) {
  const name = component === 'ai-rootfs' ? `ai-rootfs-bundle-linux-${arch}.tar.gz` : component === 'ai-profiles' ? `ai-profiles-linux-${arch}.tar.gz` : `${component}-linux-${arch}`;
  artifacts.push({ component, os: 'linux', arch, file: `fleet-dist/${name}`, url: `https://github.com/${e.REPOSITORY}/releases/download/agent-${e.BUILD_ID}/${name}`, version: e.RELEASE_VERSION });
}
await writeFile(output, JSON.stringify({ schemaVersion: 1, releaseId: e.BUILD_ID, buildId: e.BUILD_ID, version: e.RELEASE_VERSION, publishedAt: new Date().toISOString(), channel: 'stable', rollbackSafe: e.ROLLBACK_SAFE === 'true', minUpdaterVersion: e.MIN_UPDATER, ...(e.UPGRADE_FROM ? { upgradeFrom: e.UPGRADE_FROM.split(',').map(s => s.trim()).filter(Boolean) } : {}), artifacts, ai: { version: e.RELEASE_VERSION, components: ['ai-executor', 'ai-host-helper', 'ai-rootfs', 'ai-profiles'] } }, null, 2));
