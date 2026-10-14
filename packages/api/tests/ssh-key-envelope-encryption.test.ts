import type * as FileSystemPromises from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type ssh2 from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createKeyService,
  type KeyService,
} from "../src/ssh/keyService.js";
import {
  atomicWriteFile,
  createTestKeyring,
  decodeKeyBytes,
  decryptEnvelope,
  decryptWithAesGcm,
  encryptEnvelope,
  encryptWithAesGcm,
  getActiveKek,
  getDefaultKeyringPath,
  initKeyring,
  loadKeyringFromFile,
  migrateKeysDirectory,
  rotateKeyring,
  saveKeyringToFile,
  validateExternalSecretPath,
  type EnvelopeData,
  type Keyring,
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
} from "../src/ssh/key-encryption.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const require = createRequire(import.meta.url);
const sshUtils = (require("ssh2") as typeof ssh2).utils;

describe("SSH Private Key Envelope Encryption", () => {
  let tempDir: string;
  let externalSecretDir: string;
  let keysDir: string;
  let defaultKeyring: Keyring;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vps-key-enc-test-"));
    externalSecretDir = await mkdtemp(join(tmpdir(), "vps-external-secret-"));
    keysDir = join(tempDir, "private", "keys");
    await mkdir(keysDir, { recursive: true });
    defaultKeyring = createTestKeyring("active-kek-v1");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(externalSecretDir, { recursive: true, force: true });
  });

  describe("Cryptographic primitives & AAD binding", () => {
    it("decodes 32-byte keys from base64 and 64-character hex", () => {
      const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const fromHex = decodeKeyBytes(hexKey);
      expect(fromHex.length).toBe(32);

      const b64Key = Buffer.alloc(32, 0x42).toString("base64");
      const fromB64 = decodeKeyBytes(b64Key);
      expect(fromB64.length).toBe(32);
      expect(fromB64.every((b) => b === 0x42)).toBe(true);

      // Rejects invalid key lengths
      expect(() => decodeKeyBytes("dG9vc2hvcnQ=")).toThrow(/Invalid KEK length/);
      expect(() => decodeKeyBytes(Buffer.alloc(16).toString("base64"))).toThrow(/Invalid KEK length/);
      expect(() => decodeKeyBytes(Buffer.alloc(64).toString("base64"))).toThrow(/Invalid KEK length/);
    });

    it("encrypts and decrypts with fresh 12-byte IVs and 16-byte auth tags", () => {
      const key = Buffer.alloc(32, 0x7a);
      const plaintext = Buffer.from("super-secret-ssh-key-data");
      const aad = Buffer.from("vps-manager-aad");

      const enc1 = encryptWithAesGcm(key, plaintext, aad);
      const enc2 = encryptWithAesGcm(key, plaintext, aad);

      // Fresh IVs for each encryption
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(Buffer.from(enc1.iv, "base64").length).toBe(12);
      expect(Buffer.from(enc2.iv, "base64").length).toBe(12);
      expect(Buffer.from(enc1.tag, "base64").length).toBe(16);
      expect(Buffer.from(enc2.tag, "base64").length).toBe(16);

      const dec1 = decryptWithAesGcm(key, enc1, aad);
      const dec2 = decryptWithAesGcm(key, enc2, aad);
      expect(dec1.toString("utf8")).toBe("super-secret-ssh-key-data");
      expect(dec2.toString("utf8")).toBe("super-secret-ssh-key-data");
    });

    it("fails closed on tamper with ciphertext, IV, or auth tag", () => {
      const key = Buffer.alloc(32, 0x99);
      const plaintext = Buffer.from("sensitive-key-material");
      const aad = Buffer.from("aad-binding");
      const enc = encryptWithAesGcm(key, plaintext, aad);

      // Tampered ciphertext
      const tamperedCiphertext = {
        ...enc,
        ciphertext: Buffer.from("tampered" + enc.ciphertext).toString("base64"),
      };
      expect(() => decryptWithAesGcm(key, tamperedCiphertext, aad)).toThrow();

      // Tampered tag
      const badTag = Buffer.from(enc.tag, "base64");
      badTag[0] = (badTag[0]! ^ 0xff);
      const tamperedTag = { ...enc, tag: badTag.toString("base64") };
      expect(() => decryptWithAesGcm(key, tamperedTag, aad)).toThrow();

      // Tampered IV
      const badIv = Buffer.from(enc.iv, "base64");
      badIv[0] = (badIv[0]! ^ 0xff);
      const tamperedIv = { ...enc, iv: badIv.toString("base64") };
      expect(() => decryptWithAesGcm(key, tamperedIv, aad)).toThrow();

      // Mismatched AAD
      expect(() =>
        decryptWithAesGcm(key, enc, Buffer.from("different-aad")),
      ).toThrow();
    });

    it("cryptographically binds envelope to target VPS identity", () => {
      const { kekId, kek } = getActiveKek(defaultKeyring);
      const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----";

      const envelopeVps1 = encryptEnvelope("vps-alpha", privateKey, kekId, kek);
      expect(envelopeVps1.format).toBe(ENVELOPE_FORMAT);
      expect(envelopeVps1.version).toBe(ENVELOPE_VERSION);

      // Decrypt with correct vpsId succeeds
      const decrypted = decryptEnvelope("vps-alpha", envelopeVps1, defaultKeyring);
      expect(decrypted).toBe(privateKey);

      // Attempting to decrypt with a different vpsId (cross-VPS substitution attack) MUST fail closed
      expect(() =>
        decryptEnvelope("vps-beta", envelopeVps1, defaultKeyring),
      ).toThrow();
    });

    it("fails closed when KEK is missing from keyring", () => {
      const { kekId, kek } = getActiveKek(defaultKeyring);
      const envelope = encryptEnvelope("vps-1", "test-key", kekId, kek);

      const otherKeyring = createTestKeyring("different-kek-id");
      expect(() =>
        decryptEnvelope("vps-1", envelope, otherKeyring),
      ).toThrow(/KEK "active-kek-v1" not found in keyring/);
    });
  });

  describe("External secret path validation", () => {
    it("accepts absolute and relative paths outside dataDir, privateDir, and projectRoot", () => {
      const secretFile = join(externalSecretDir, "ssh-keyring.json");
      const dataDir = join(tempDir, "data");
      const privateDir = join(tempDir, "private");
      const projectRoot = tempDir;

      const validatedAbsolute = validateExternalSecretPath(
        secretFile,
        dataDir,
        privateDir,
        projectRoot,
      );
      expect(validatedAbsolute).toBe(resolve(secretFile));
      expect(isAbsolute(validatedAbsolute)).toBe(true);

      // Relative external path resolves canonically to absolute path
      const relExternal = join("..", "external-secret-path", "keyring.json");
      const validatedRel = validateExternalSecretPath(
        relExternal,
        dataDir,
        privateDir,
        projectRoot,
      );
      expect(validatedRel).toBe(resolve(relExternal));
      expect(isAbsolute(validatedRel)).toBe(true);

      // Default keyring path contains flexserver convention
      expect(getDefaultKeyringPath()).toContain("flexserver");
    });

    it("rejects path traversal attempts reaching into restricted directories", () => {
      const dataDir = join(tempDir, "data");
      const privateDir = join(tempDir, "private");
      const projectRoot = tempDir;

      // Traversal into dataDir
      const sneakyData = join(externalSecretDir, "..", basename(tempDir), "data", "secrets.json");
      expect(() =>
        validateExternalSecretPath(sneakyData, dataDir, privateDir, projectRoot),
      ).toThrow(/must not be located inside DATA_DIR/);

      // Traversal into privateDir
      const sneakyPrivate = join(externalSecretDir, "..", basename(tempDir), "private", "secrets.json");
      expect(() =>
        validateExternalSecretPath(sneakyPrivate, dataDir, privateDir, projectRoot),
      ).toThrow(/must not be located inside PRIVATE_DIR/);

      // Traversal into projectRoot
      const sneakyRoot = join(externalSecretDir, "..", basename(tempDir), "secrets.json");
      expect(() =>
        validateExternalSecretPath(sneakyRoot, dataDir, privateDir, projectRoot),
      ).toThrow(/must not be located inside the project directory/);
    });

    it("rejects paths inside or equal to dataDir", () => {
      const dataDir = join(tempDir, "data");
      const insideData = join(dataDir, "secrets", "keyring.json");
      expect(() =>
        validateExternalSecretPath(insideData, dataDir, join(tempDir, "private"), tempDir),
      ).toThrow(/must not be located inside DATA_DIR/);
    });

    it("rejects paths inside or equal to privateDir", () => {
      const privateDir = join(tempDir, "private");
      const insidePrivate = join(privateDir, "keyring.json");
      expect(() =>
        validateExternalSecretPath(insidePrivate, join(tempDir, "data"), privateDir, tempDir),
      ).toThrow(/must not be located inside PRIVATE_DIR/);
    });

    it("rejects paths inside or equal to projectRoot", () => {
      const insideRoot = join(tempDir, "config", "keyring.json");
      expect(() =>
        validateExternalSecretPath(
          insideRoot,
          join(tempDir, "data"),
          join(tempDir, "private"),
          tempDir,
        ),
      ).toThrow(/must not be located inside the project directory/);
    });

    it("rejects symlinked paths that resolve into restricted directories", async () => {
      const restrictedTarget = join(tempDir, "data", "sneaky-keyring.json");
      await mkdir(dirname(restrictedTarget), { recursive: true });
      await writeFile(restrictedTarget, "{}", "utf8");

      const symlinkPath = join(externalSecretDir, "link-to-data.json");
      try {
        await symlink(restrictedTarget, symlinkPath, "file");
      } catch (err) {
        // Windows unprivileged symlinks might require Developer Mode; skip symlink test if OS denies
        return;
      }

      expect(() =>
        validateExternalSecretPath(
          symlinkPath,
          join(tempDir, "data"),
          join(tempDir, "private"),
          tempDir,
        ),
      ).toThrow(/must not be located inside DATA_DIR/);
    });
    it("rejects paths in subdirectories starting with '..' (e.g. '..secrets') inside projectRoot and protected dirs", () => {
      const dataDir = join(tempDir, "data");
      const privateDir = join(tempDir, "private");
      const projectRoot = tempDir;

      // Inside projectRoot in a subdirectory named '..secrets'
      const dotDotRoot = join(projectRoot, "..secrets", "keyring.json");
      expect(() =>
        validateExternalSecretPath(dotDotRoot, dataDir, privateDir, projectRoot),
      ).toThrow(/must not be located inside the project directory/);

      // Inside dataDir in a subdirectory named '..secrets'
      const dotDotData = join(dataDir, "..secrets", "keyring.json");
      expect(() =>
        validateExternalSecretPath(dotDotData, dataDir, privateDir, projectRoot),
      ).toThrow(/must not be located inside DATA_DIR/);

      // Inside privateDir in a subdirectory named '..secrets'
      const dotDotPrivate = join(privateDir, "..secrets", "keyring.json");
      expect(() =>
        validateExternalSecretPath(dotDotPrivate, dataDir, privateDir, projectRoot),
      ).toThrow(/must not be located inside PRIVATE_DIR/);
    });
  });

  describe("KeyService lifecycle & fail-closed guarantees", () => {
    it("fails closed when keyring is unconfigured (no silent plaintext fallback)", async () => {
      const keys = createKeyService({ baseDir: keysDir });
      await expect(keys.ensureKeyPair("vps-unconfigured")).rejects.toThrow();

      // Write an existing private plaintext file
      const plaintextPayload =
        "-----BEGIN OPENSSH PRIVATE KEY-----\nplaintext-test\n-----END OPENSSH PRIVATE KEY-----";
      const keyFile = join(keysDir, "vps-unconfigured-existing");
      await writeFile(keyFile, plaintextPayload, "utf8");

      // Verify operation rejects and existing file remains untouched on disk when no secret
      await expect(keys.readPrivateKey("vps-unconfigured-existing")).rejects.toThrow();
      const untouched = await readFile(keyFile, "utf8");
      expect(untouched).toBe(plaintextPayload);
    });

    it("creates new keypair with encrypted envelope at rest and OpenSSH Ed25519 in memory", async () => {
      const keys = createKeyService({
        baseDir: keysDir,
        keyring: defaultKeyring,
      });

      const pair = await keys.ensureKeyPair("vps-fresh");
      expect(pair.publicKey).toMatch(/^ssh-ed25519 /);
      expect(pair.privateKey).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");

      // Verify on-disk file is JSON envelope
      const onDisk = await readFile(pair.privateKeyPath, "utf8");
      expect(onDisk).not.toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
      const envelope: EnvelopeData = JSON.parse(onDisk);
      expect(envelope.format).toBe(ENVELOPE_FORMAT);
      expect(envelope.version).toBe(1);
      expect(envelope.kekId).toBe(defaultKeyring.activeKekId);

      // Verify readPrivateKey returns decrypted OpenSSH private key
      const decrypted = await keys.readPrivateKey("vps-fresh");
      expect(decrypted).toBe(pair.privateKey);
    });

    it("decrypted private key parses successfully with ssh2 parseKey", async () => {
      const keys = createKeyService({
        baseDir: keysDir,
        keyring: defaultKeyring,
      });

      const pair = await keys.ensureKeyPair("vps-ssh2-test");
      const decrypted = await keys.readPrivateKey("vps-ssh2-test");

      // Parse with ssh2 parser
      const parsedKey = sshUtils.parseKey(decrypted);
      expect(parsedKey).not.toBeInstanceOf(Error);
      expect(parsedKey).toBeDefined();
      if (parsedKey && typeof parsedKey === "object" && "type" in parsedKey) {
        expect(parsedKey.type).toBe("ssh-ed25519");
      } else {
        expect.fail("parsedKey must be an object with a type property");
      }
    });
    it("prevents unsafe regeneration when only public key exists", async () => {
      const keys = createKeyService({
        baseDir: keysDir,
        keyring: defaultKeyring,
      });

      // Write orphaned public key
      await writeFile(join(keysDir, "vps-orphan.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI dummy\n", "utf8");

      await expect(keys.ensureKeyPair("vps-orphan")).rejects.toThrow(
        /Public key exists for "vps-orphan" but private key is missing; unsafe regeneration blocked/,
      );
    });

    it("prevents unsafe regeneration when only private key exists", async () => {
      const keys = createKeyService({
        baseDir: keysDir,
        keyring: defaultKeyring,
      });

      // Write orphaned private key
      await writeFile(join(keysDir, "vps-orphan-priv"), "{}", "utf8");

      await expect(keys.ensureKeyPair("vps-orphan-priv")).rejects.toThrow(
        /Private key exists for "vps-orphan-priv" but public key is missing; unsafe regeneration blocked/,
      );
    });

    it("fails closed and never replaces existing keys when decryption fails or file is corrupted", async () => {
      const keys = createKeyService({
        baseDir: keysDir,
        keyring: defaultKeyring,
      });

      const pair = await keys.ensureKeyPair("vps-tamper");
      const originalEnvelope = await readFile(pair.privateKeyPath, "utf8");

      // Corrupt the envelope ciphertext
      const envelope: EnvelopeData = JSON.parse(originalEnvelope);
      const badCiphertext = Buffer.from(envelope.encryptedKey.ciphertext, "base64");
      badCiphertext[0] = (badCiphertext[0]! ^ 0xff);
      envelope.encryptedKey.ciphertext = badCiphertext.toString("base64");
      await writeFile(pair.privateKeyPath, JSON.stringify(envelope), "utf8");

      // Reading must throw
      await expect(keys.readPrivateKey("vps-tamper")).rejects.toThrow();

      // ensureKeyPair must throw and NEVER replace or regenerate the corrupted key
      await expect(keys.ensureKeyPair("vps-tamper")).rejects.toThrow();

      // File on disk remains the corrupted file (not wiped or replaced with a new keypair)
      const currentContent = await readFile(pair.privateKeyPath, "utf8");
      expect(currentContent).toBe(JSON.stringify(envelope));
    });

    it("migrates existing plaintext OpenSSH private keys to encrypted envelope atomically", async () => {
      // Generate a real plaintext Ed25519 keypair
      const generated = sshUtils.generateKeyPairSync("ed25519");
      const rawPlaintextPrivate = generated.private;
      const rawPublicKey = generated.public;

      const privPath = join(keysDir, "vps-legacy");
      const pubPath = join(keysDir, "vps-legacy.pub");
      await writeFile(privPath, rawPlaintextPrivate, { mode: 0o600 });
      await writeFile(pubPath, `${rawPublicKey.trim()}\n`, { mode: 0o644 });

      // Before access: disk has plaintext OpenSSH header
      expect(await readFile(privPath, "utf8")).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");

      const keys = createKeyService({
        baseDir: keysDir,
        keyring: defaultKeyring,
      });

      // ensureKeyPair triggers transparent migration
      const pair = await keys.ensureKeyPair("vps-legacy");
      expect(pair.publicKey).toBe(rawPublicKey.trim());
      expect(pair.privateKey).toBe(rawPlaintextPrivate);

      // After access: disk is now envelope encrypted
      const onDisk = await readFile(privPath, "utf8");
      expect(onDisk).not.toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
      const envelope: EnvelopeData = JSON.parse(onDisk);
      expect(envelope.format).toBe(ENVELOPE_FORMAT);
      expect(envelope.version).toBe(1);
      expect(envelope.kekId).toBe(defaultKeyring.activeKekId);

      // Subsequent readPrivateKey returns original plaintext
      const decrypted = await keys.readPrivateKey("vps-legacy");
      expect(decrypted).toBe(rawPlaintextPrivate);
    });
  });

  describe("Key rotation & batch migration", () => {
    it("rotates active KEK, preserves old KEK, and rewraps existing envelopes", async () => {
      const keyringFilePath = join(externalSecretDir, "keyring.json");
      await saveKeyringToFile(keyringFilePath, defaultKeyring);

      const keys = createKeyService({
        baseDir: keysDir,
        keyringFilePath,
      });

      // Create two managed VPS keys encrypted with active-kek-v1
      const pair1 = await keys.ensureKeyPair("vps-rotate-1");
      const pair2 = await keys.ensureKeyPair("vps-rotate-2");

      const env1Before: EnvelopeData = JSON.parse(await readFile(pair1.privateKeyPath, "utf8"));
      expect(env1Before.kekId).toBe("active-kek-v1");

      // Rotate keyring: generates new KEK, sets as active
      const rotation = await rotateKeyring(keyringFilePath);
      expect(rotation.previousActiveKekId).toBe("active-kek-v1");
      expect(rotation.newActiveKekId).not.toBe("active-kek-v1");
      expect(rotation.keyring.keys["active-kek-v1"]).toBeDefined();
      expect(rotation.keyring.keys[rotation.newActiveKekId]).toBeDefined();

      // Batch migrate/rewrap keys to new active KEK
      const migrationResult = await migrateKeysDirectory(keysDir, rotation.keyring);
      expect(migrationResult.rewrapped).toBe(2);
      expect(migrationResult.unchanged).toBe(0);
      expect(migrationResult.migratedFromPlaintext).toBe(0);

      // Verify envelopes on disk now use new KEK ID
      const env1After: EnvelopeData = JSON.parse(await readFile(pair1.privateKeyPath, "utf8"));
      expect(env1After.kekId).toBe(rotation.newActiveKekId);
      // New IV was used for the rewrapped DEK
      expect(env1After.dek.iv).not.toBe(env1Before.dek.iv);

      // Read keys back with the updated keyring: keys decrypt to identical private key material
      const keysUpdated = createKeyService({
        baseDir: keysDir,
        keyringFilePath,
      });
      const decrypted1 = await keysUpdated.readPrivateKey("vps-rotate-1");
      const decrypted2 = await keysUpdated.readPrivateKey("vps-rotate-2");
      expect(decrypted1).toBe(pair1.privateKey);
      expect(decrypted2).toBe(pair2.privateKey);
    });

    it("initKeyring initializes a valid external keyring file and forbids overwriting", async () => {
      const keyringFilePath = join(externalSecretDir, "init-test.json");

      const initResult = await initKeyring(keyringFilePath, {
        dataDir: join(tempDir, "data"),
        privateDir: join(tempDir, "private"),
      });

      expect(initResult.keyring.version).toBe(1);
      expect(initResult.keyring.activeKekId).toBeDefined();
      expect(initResult.keyring.keys[initResult.keyring.activeKekId]).toBeDefined();

      // Refuses to overwrite existing keyring file to prevent unrecoverable KEK loss
      await expect(
        initKeyring(keyringFilePath, {
          dataDir: join(tempDir, "data"),
          privateDir: join(tempDir, "private"),
        }),
      ).rejects.toThrow(/Keyring file already exists.*Overwrite is blocked/);
    });
  });

  describe("Atomic write resilience & integrity", () => {
    it("preserves existing keyring file if atomic rename fails", async () => {
      const keyringFilePath = join(externalSecretDir, "preserve-keyring.json");
      const originalKeyring = createTestKeyring("original-active-kek");
      await saveKeyringToFile(keyringFilePath, originalKeyring);
      const originalContent = await readFile(keyringFilePath, "utf8");

      const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(
        new Error("EPERM: operation not permitted, rename"),
      );

      try {
        const replacementKeyring = createTestKeyring("unauthorized-overwrite-kek");
        await expect(
          saveKeyringToFile(keyringFilePath, replacementKeyring),
        ).rejects.toThrow(/operation not permitted, rename/);

        // Verify existing file is preserved and completely unchanged
        const contentAfterFailedRename = await readFile(keyringFilePath, "utf8");
        expect(contentAfterFailedRename).toBe(originalContent);

        const loadedKeyring = await loadKeyringFromFile(keyringFilePath);
        expect(loadedKeyring.activeKekId).toBe("original-active-kek");
      } finally {
        renameSpy.mockRestore();
      }
    });

    it("preserves existing private key file on disk if atomic rename fails", async () => {
      const keys = createKeyService({
        baseDir: keysDir,
        keyring: defaultKeyring,
      });

      const pair = await keys.ensureKeyPair("vps-preserve-on-failed-rename");
      const keyFilePath = join(keysDir, "vps-preserve-on-failed-rename");
      const originalEnvelopeOnDisk = await readFile(keyFilePath, "utf8");

      const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(
        new Error("EBUSY: resource busy or locked, rename"),
      );

      try {
        await expect(
          atomicWriteFile(
            keyFilePath,
            JSON.stringify({ corrupted: true }),
            0o600,
          ),
        ).rejects.toThrow(/resource busy or locked, rename/);

        // Verify existing private key envelope on disk is preserved intact
        const contentAfterFailedRename = await readFile(keyFilePath, "utf8");
        expect(contentAfterFailedRename).toBe(originalEnvelopeOnDisk);

        // Verify keyService can still decrypt and return original private key
        const decrypted = await keys.readPrivateKey("vps-preserve-on-failed-rename");
        expect(decrypted).toBe(pair.privateKey);
      } finally {
        renameSpy.mockRestore();
      }
    });
  });
});
