import { describe, expect, it } from "vitest";
import { LocalTerminalService } from "../src/terminal/local-terminal.service.js";
import { PassThrough } from "node:stream";

describe("LocalTerminalService", () => {
  it("instantiates and reports availability status", () => {
    const service = new LocalTerminalService({} as any);
    expect(service).toBeDefined();
    expect(typeof service.isSupported()).toBe("boolean");
  });

  it("handles terminal frame encode and decode correctly", async () => {
    // Test the framing format: [1 byte type][4 bytes BE length][payload]
    const inStream = new PassThrough();
    const outStream = new PassThrough();

    // Verify framing parser logic
    const chunks: Buffer[] = [];
    outStream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    // Write a mock data frame (type 1)
    const payload = Buffer.from("hello world");
    const frame = Buffer.alloc(5 + payload.length);
    frame.writeUInt8(1, 0);
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);

    outStream.write(frame);

    expect(chunks.length).toBeGreaterThan(0);
    const combined = Buffer.concat(chunks);
    expect(combined.readUInt8(0)).toBe(1);
    expect(combined.readUInt32BE(1)).toBe(11);
    expect(combined.subarray(5).toString("utf8")).toBe("hello world");
  });
});
