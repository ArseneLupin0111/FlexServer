import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const components = new Set(['agent', 'ai-executor', 'ai-host-helper', 'ai-rootfs', 'ai-profiles']);
const sha = /^[a-f0-9]{64}$/;
const build = /^[a-f0-9]{40}$/;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
export function validateFleetPayload(payload) {
  requireValue(payload && payload.schemaVersion === 1 && payload.channel === 'stable', 'Unsupported fleet release schema/channel');
  requireValue(typeof payload.releaseId === 'string' && build.test(payload.releaseId) && build.test(payload.buildId) && payload.releaseId === payload.buildId, 'Release identity must match a canonical commit build ID');
  requireValue(version.test(payload.version), 'Invalid release semantic version');
  requireValue(!payload.minUpdaterVersion || version.test(payload.minUpdaterVersion), 'Invalid updater semantic version');
  requireValue(typeof payload.rollbackSafe === 'boolean' && Number.isFinite(Date.parse(payload.publishedAt)), 'Missing rollback policy or publication time');
  requireValue(!payload.upgradeFrom || (Array.isArray(payload.upgradeFrom) && payload.upgradeFrom.every(x => typeof x === 'string' && build.test(x))), 'Invalid intermediate upgrade identities');
  requireValue(Array.isArray(payload.artifacts) && payload.artifacts.length > 0 && payload.artifacts.length <= 32, 'Missing or excessive release artifacts');
  const seen = new Set();
  for (const a of payload.artifacts) {
    requireValue(components.has(a.component) && a.os === 'linux' && ['amd64', 'arm64'].includes(a.arch), 'Unsupported component/platform');
    const key = `${a.component}/${a.os}/${a.arch}`;
    requireValue(!seen.has(key), `Duplicate artifact ${key}`); seen.add(key);
    requireValue(sha.test(a.sha256) && Number.isSafeInteger(a.size) && a.size > 0 && version.test(a.version), `Invalid artifact integrity metadata ${key}`);
    const url = new URL(a.url);
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash, `Artifact must use credential-free HTTPS ${key}`);
  }
  for (const arch of ['amd64', 'arm64']) {
    const has = component => seen.has(`${component}/linux/${arch}`);
    if (payload.artifacts.some(a => a.arch === arch)) {
      const ai = ['ai-executor', 'ai-host-helper', 'ai-rootfs', 'ai-profiles'];
      if (ai.some(has)) {
        requireValue(ai.every(has), `Incomplete AI runtime for ${arch}`);
      }
      requireValue(has('agent') || ai.every(has), `Missing required component set for ${arch}`);
    }
  }
  if (payload.ai) requireValue(version.test(payload.ai.version) && Array.isArray(payload.ai.components) && ['ai-executor', 'ai-host-helper', 'ai-rootfs', 'ai-profiles'].every(c => payload.ai.components.includes(c)), 'Invalid AI compatibility metadata');
  return payload;
}
export function signFleetManifest(payload, privatePem, keyId) {
  validateFleetPayload(payload);
  requireValue(typeof keyId === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(keyId), 'Invalid signing key identity');
  const key = createPrivateKey(privatePem);
  requireValue(key.asymmetricKeyType === 'ed25519', 'Fleet signing key must be Ed25519');
  const raw = JSON.stringify(payload);
  return { payload: raw, signature: sign(null, Buffer.from(raw), key).toString('base64'), keyId };
}
export function verifyFleetManifest(envelope, publicPem) {
  requireValue(envelope && typeof envelope.payload === 'string' && Buffer.byteLength(envelope.payload) <= 128 * 1024 && typeof envelope.signature === 'string' && typeof envelope.keyId === 'string', 'Invalid signed release envelope');
  const key = createPublicKey(publicPem);
  requireValue(key.asymmetricKeyType === 'ed25519', 'Fleet verification key must be Ed25519');
  const signature = Buffer.from(envelope.signature, 'base64');
  requireValue(signature.length === 64 && signature.toString('base64') === envelope.signature && verify(null, Buffer.from(envelope.payload), key, signature), 'Fleet release signature verification failed');
  return validateFleetPayload(JSON.parse(envelope.payload));
}
export async function buildFleetManifest(spec, privatePem, keyId) {
  const artifacts = [];
  for (const artifact of spec.artifacts ?? []) {
    const { file, ...metadata } = artifact;
    requireValue(typeof file === 'string', 'Each artifact requires a local file');
    requireValue((await stat(file)).isFile(), 'Artifact must be a regular file');
    const bytes = await readFile(file);
    artifacts.push({ ...metadata, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return signFleetManifest({ ...spec, artifacts }, privatePem, keyId);
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) { requireValue(args[i]?.startsWith('--') && args[i + 1], 'Expected --name value options'); options[args[i].slice(2)] = args[i + 1]; }
  if (command === 'sign') {
    requireValue(options.spec && options.key && options.output && options['key-id'], 'sign requires --spec --key --key-id --output');
    const envelope = await buildFleetManifest(JSON.parse(await readFile(options.spec, 'utf8')), await readFile(options.key), options['key-id']);
    await writeFile(options.output, JSON.stringify(envelope) + '\n', { mode: 0o644 });
    console.log(`Signed fleet release ${JSON.parse(envelope.payload).releaseId}`);
  } else if (command === 'verify') {
    requireValue(options.manifest && options.key, 'verify requires --manifest --key');
    const payload = verifyFleetManifest(JSON.parse(await readFile(options.manifest, 'utf8')), await readFile(options.key));
    if (options['expect-release']) requireValue(payload.releaseId === options['expect-release'], 'Release identity mismatch');
    console.log(JSON.stringify({ releaseId: payload.releaseId, version: payload.version, artifacts: payload.artifacts.length }));
  } else throw new Error('Usage: fleet-release.mjs sign|verify --help (sign: --spec --key --key-id --output; verify: --manifest --key [--expect-release])');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
