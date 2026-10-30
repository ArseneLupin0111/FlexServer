export const REDACTED = "[REDACTED]";

const SECRET_KEYS: Record<string, true> = {
  password: true,
  passwd: true,
  pwd: true,
  privatekey: true,
  publickey: true,
  authorization: true,
  token: true,
  leasetoken: true,
  localauthtoken: true,
  dek: true,
  kek: true,
  ciphertext: true,
  encryptedkey: true,
  kekid: true,
  sshkeyencryptionkey: true,
  authtag: true,
  apikey: true,
  encryptedapikey: true,
  secret: true,
  secretkey: true,
  cookie: true,
  sessionid: true,
  accesstoken: true,
  refreshtoken: true,
  passphrase: true,
  clientsecret: true,
};

export const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private keys (full blocks and headers/footers)
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
  /-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?-----END [A-Z0-9 ]*KEY-----/gi,
  // SSH keys
  /(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)\s+[A-Za-z0-9+/=]+(?:\s+\S+)?/gi,
  // Password assignments
  /(?:password|passwd|pwd)\s*[:=]\s*[^\s&,"']+/gi,
  // Bearer authentication
  /bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Scoped agent tokens
  /\bvma_[A-Za-z0-9_-]+\b/g,
  // OpenAI / LLM API keys
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
  // Generic secret / API key assignments
  /(?:api[_-]?key|secret[_-]?key|secret|token)\s*[:=]\s*[^\s&,"']+/gi,
  // .env variable assignments with sensitive names
  /(?:^|[\r\n])\s*(?:export\s+)?([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|AUTH)[A-Za-z0-9_]*\s*=\s*)([^\r\n]+)/gi,
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS[key.replace(/[-_]/g, "").toLowerCase()] === true;
}

export const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function redactString(value: string): string {
  let result = value.replace(ANSI_REGEX, "");
  // .env line redaction preserves the variable name but masks the value
  result = result.replace(
    /(?:^|[\r\n])\s*(?:export\s+)?([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|AUTH)[A-Za-z0-9_]*\s*=\s*)([^\r\n]+)/gi,
    (match, prefix) => match.replace(/[^\r\n]+$/, `${prefix}${REDACTED}`),
  );
  return SECRET_PATTERNS.reduce((next, pattern) => next.replace(pattern, REDACTED), result);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSecretKey(key) ? REDACTED : redactValue(entry),
    ]),
  );
}

function truncateUtf8Bytes(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  if (maxBytes <= 0) return Buffer.alloc(0);
  let end = maxBytes;
  let i = end - 1;
  while (i >= 0 && i >= end - 4) {
    const b = buf[i]!;
    if ((b & 0x80) === 0) {
      break;
    }
    if ((b & 0xc0) === 0xc0) {
      let needed = 1;
      if ((b & 0xe0) === 0xc0) needed = 2;
      else if ((b & 0xf0) === 0xe0) needed = 3;
      else if ((b & 0xf8) === 0xf0) needed = 4;
      if (end - i < needed) {
        end = i;
      }
      break;
    }
    i--;
  }
  return buf.subarray(0, end);
}

export function safeErrorMessage(error: unknown, maxLen = 1024): string {
  let msg: string;
  if (error instanceof Error) msg = redactString(error.message);
  else if (typeof error === "string") msg = redactString(error);
  else msg = "Internal server error";

  const buf = Buffer.from(msg, "utf8");
  if (buf.length <= maxLen) {
    return msg;
  }

  const suffix = "...";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxLen <= suffixBytes) {
    return suffix.slice(0, Math.max(0, maxLen));
  }

  const maxContentBytes = maxLen - suffixBytes;
  const truncated = truncateUtf8Bytes(buf, maxContentBytes).toString("utf8");
  return truncated + suffix;
}

/**
 * Stateful streaming redactor to handle secrets that span across chunk boundaries.
 * Uses line-oriented buffering so tokens/assignments cut between packets are not
 * partially emitted. Oversized lines are discarded with REDACTED, and PEM blocks
 * are masked until their closing footer.
 */
export class ChunkRedactor {
  private buffer = "";
  private inPemBlock = false;
  private lineDiscard = false;
  private readonly maxLineLength = 8192;

  process(chunk: string): string {
    this.buffer += chunk;
    let output = "";

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex + 1);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (this.lineDiscard) {
        this.lineDiscard = false;
        output += `${REDACTED}\n`;
        continue;
      }

      const line = stripAnsi(rawLine);

      if (this.inPemBlock) {
        if (/-----END [A-Z0-9 ]*KEY-----/i.test(line)) {
          this.inPemBlock = false;
          output += `${REDACTED}\n`;
        }
        continue;
      }

      if (/-----BEGIN [A-Z0-9 ]*KEY-----/i.test(line)) {
        if (/-----END [A-Z0-9 ]*KEY-----/i.test(line)) {
          output += `${REDACTED}\n`;
        } else {
          this.inPemBlock = true;
        }
        continue;
      }

      output += redactString(line);
    }

    if (this.buffer.length > this.maxLineLength) {
      this.lineDiscard = true;
      this.buffer = "";
      output += `${REDACTED}\n`;
    }

    return output;
  }

  flush(): string {
    let output = "";
    if (this.inPemBlock) {
      this.inPemBlock = false;
      output = `${REDACTED}\n`;
    } else if (this.lineDiscard) {
      this.lineDiscard = false;
      output = `${REDACTED}\n`;
    } else if (this.buffer.length > 0) {
      const line = stripAnsi(this.buffer);
      output = redactString(line);
    }
    return output;
  }

  reset(): void {
    this.buffer = "";
    this.inPemBlock = false;
    this.lineDiscard = false;
  }
}

