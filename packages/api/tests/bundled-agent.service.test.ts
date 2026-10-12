import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BundledAgentService,
  extractAgentBinaryMetadata,
} from "../src/local-upgrade/bundled-agent.service.js";
import type { AppConfig } from "../src/config/app-config.js";

const VALID_BUILD_ID = "0123456789abcdef0123456789abcdef01234567";

function createDummyElf(options: {
  arch?: "amd64" | "arm64" | "other";
  class?: number;
  endian?: number;
  osabi?: number;
  type?: number;
  buildId?: string;
  version?: string;
  size?: number;
} = {}): Buffer {
  const size = Math.max(options.size ?? 256, 64);
  const buf = Buffer.alloc(size);
  // ELF Magic
  buf[0] = 0x7f;
  buf[1] = 0x45; // 'E'
  buf[2] = 0x4c; // 'L'
  buf[3] = 0x46; // 'F'
  buf[4] = options.class ?? 2; // ELFCLASS64
  buf[5] = options.endian ?? 1; // ELFDATA2LSB
  buf[6] = 1; // EV_CURRENT
  buf[7] = options.osabi ?? 0; // ELFOSABI_NONE / System V

  // e_type
  buf.writeUInt16LE(options.type ?? 2, 16); // ET_EXEC

  // e_machine
  if (options.arch === "arm64") {
    buf.writeUInt16LE(0xb7, 18);
  } else if (options.arch === "other") {
    buf.writeUInt16LE(0x03, 18); // x86 32-bit
  } else {
    buf.writeUInt16LE(0x3e, 18); // EM_X86_64
  }

  // Go ldflags strings if provided
  if (options.buildId) {
    buf.write(`version.Build=${options.buildId}\0`, 64);
  }
  if (options.version) {
    buf.write(`version.Value=${options.version}\0`, 128);
  }

  return buf;
}

describe("extractAgentBinaryMetadata", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bundled-agent-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("extracts valid amd64 ELF with embedded ldflags symbols", () => {
    const buf = createDummyElf({
      arch: "amd64",
      buildId: VALID_BUILD_ID,
      version: "2.1.0",
    });
    const filePath = join(tempDir, "vps-agent-linux-amd64");
    writeFileSync(filePath, buf);

    const meta = extractAgentBinaryMetadata(filePath, buf);
    expect(meta.os).toBe("linux");
    expect(meta.arch).toBe("amd64");
    expect(meta.buildId).toBe(VALID_BUILD_ID);
    expect(meta.version).toBe("2.1.0");
    expect(meta.sha256).toBe(createHash("sha256").update(buf).digest("hex"));
    expect(meta.size).toBe(buf.length);
  });

  it("extracts valid arm64 ELF with embedded ldflags symbols", () => {
    const buf = createDummyElf({
      arch: "arm64",
      buildId: VALID_BUILD_ID,
      version: "1.9.9",
    });
    const filePath = join(tempDir, "vps-agent-linux-arm64");
    writeFileSync(filePath, buf);

    const meta = extractAgentBinaryMetadata(filePath, buf);
    expect(meta.os).toBe("linux");
    expect(meta.arch).toBe("arm64");
    expect(meta.buildId).toBe(VALID_BUILD_ID);
    expect(meta.version).toBe("1.9.9");
  });

  it("uses companion json manifest when present and verifies SHA", () => {
    const buf = createDummyElf({ arch: "amd64" });
    const filePath = join(tempDir, "vps-agent-linux-amd64");
    writeFileSync(filePath, buf);

    const sha256 = createHash("sha256").update(buf).digest("hex");
    const companion = {
      os: "linux",
      arch: "amd64",
      version: "3.0.0",
      buildId: VALID_BUILD_ID,
      sha256,
      size: buf.length,
    };
    writeFileSync(`${filePath}.json`, JSON.stringify(companion));

    const meta = extractAgentBinaryMetadata(filePath);
    expect(meta.version).toBe("3.0.0");
    expect(meta.buildId).toBe(VALID_BUILD_ID);
    expect(meta.sha256).toBe(sha256);
  });

  it("rejects companion manifest if sha256 checksum does not match binary", () => {
    const buf = createDummyElf({ arch: "amd64" });
    const filePath = join(tempDir, "vps-agent-linux-amd64");
    writeFileSync(filePath, buf);

    const companion = {
      os: "linux",
      arch: "amd64",
      version: "3.0.0",
      buildId: VALID_BUILD_ID,
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      size: buf.length,
    };
    writeFileSync(`${filePath}.json`, JSON.stringify(companion));

    expect(() => extractAgentBinaryMetadata(filePath)).toThrow(
      /does not match binary sha256/i,
    );
  });

  it("rejects non-ELF files", () => {
    const filePath = join(tempDir, "fake-binary");
    writeFileSync(filePath, Buffer.from("MZ\x90\x00this is not elf"));

    expect(() => extractAgentBinaryMetadata(filePath)).toThrow(
      /Invalid agent binary/i,
    );
  });

  it("rejects 32-bit ELF files", () => {
    const buf = createDummyElf({ class: 1 });
    const filePath = join(tempDir, "vps-agent-linux-amd64");
    writeFileSync(filePath, buf);

    expect(() => extractAgentBinaryMetadata(filePath)).toThrow(
      /not ELF64/i,
    );
  });

  it("rejects big-endian ELF files", () => {
    const buf = createDummyElf({ endian: 2 });
    const filePath = join(tempDir, "vps-agent-linux-amd64");
    writeFileSync(filePath, buf);

    expect(() => extractAgentBinaryMetadata(filePath)).toThrow(
      /not little-endian/i,
    );
  });

  it("rejects unsupported machine architecture", () => {
    const buf = createDummyElf({ arch: "other" });
    const filePath = join(tempDir, "vps-agent-linux-amd64");
    writeFileSync(filePath, buf);

    expect(() => extractAgentBinaryMetadata(filePath)).toThrow(
      /unsupported machine architecture/i,
    );
  });

  it("rejects binary missing 40-hex buildId", () => {
    const buf = createDummyElf({ arch: "amd64" }); // No buildId symbol
    const filePath = join(tempDir, "vps-agent-linux-amd64");
    writeFileSync(filePath, buf);

    expect(() => extractAgentBinaryMetadata(filePath)).toThrow(
      /missing valid 40-hex build identity/i,
    );
  });
});

describe("BundledAgentService", () => {
  let tempDir: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bundled-service-test-"));
    prevEnv = process.env.AGENT_BINARY_PATH;
  });

  afterEach(async () => {
    process.env.AGENT_BINARY_PATH = prevEnv;
    if (prevEnv === undefined) delete process.env.AGENT_BINARY_PATH;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when configured path does not exist", () => {
    const service = new BundledAgentService({
      agentBinaryPath: join(tempDir, "nonexistent"),
    } as AppConfig);
    expect(service.resolveBinaryPath()).toBeNull();
    expect(service.getMetadata()).toBeNull();
  });

  it("caches metadata across subsequent calls when mtime and size are unchanged", () => {
    const buf = createDummyElf({
      arch: "amd64",
      buildId: VALID_BUILD_ID,
      version: "1.0.0",
    });
    const filePath = join(tempDir, "vps-agent-linux-amd64");
    writeFileSync(filePath, buf);

    const service = new BundledAgentService({
      agentBinaryPath: filePath,
    } as AppConfig);

    const first = service.getMetadata();
    expect(first).not.toBeNull();
    expect(first?.buildId).toBe(VALID_BUILD_ID);

    const second = service.getMetadata();
    expect(second).toBe(first); // Strict object reference equality from cache
  });
});
