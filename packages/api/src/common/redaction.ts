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

const SENSITIVE_KEY_SUFFIXES = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "secretkey",
  "apikey",
  "privatekey",
  "passphrase",
  "clientsecret",
  "cookie",
];

const TOKEN_COUNT_EXCLUSIONS = /^(?:input|output|prompt|completion|total|max|estimated?|billable|consumed)?tokens?$/i;

const PEM_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?-----END [A-Z0-9 ]*KEY-----/gi,
  /-----BEGIN [A-Z0-9 ]*KEY-----(?:[^"'\r\n\\]|\\.)*(?=["']|$)|-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*$/gi,
  /-----END [A-Z0-9 ]*KEY-----/gi,
];

const ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  // SSH keys
  /(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)\s+[A-Za-z0-9+/=]+(?:\s+\S+)?/gi,
  // Password assignments
  /(?:password|passwd|pwd)\s*[:=]\s*(?!\[REDACTED\])[^\s&,"']+/gi,
  // Bearer authentication
  /bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Scoped agent tokens
  /\bvma_[A-Za-z0-9_-]+\b/g,
  // OpenAI / LLM API keys
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
  /\bsk-[a-zA-Z0-9_-]{8,}$/g,
  // Generic secret / API key assignments
  /(?:api[_-]?key|secret[_-]?key|secret|(?!(?:[A-Za-z0-9_.-]*[_-])?(?:input|output|prompt|completion|total|max|estimated?|billable|consumed)[_-]?tokens?\b)token)\s*[:=]\s*(?!\[REDACTED\])[^\s&,"']+/gi,
];

export const SECRET_PATTERNS: readonly RegExp[] = [...PEM_PATTERNS, ...ASSIGNMENT_PATTERNS];

export function isSecretKey(key: string): boolean {
  const norm = key.replace(/[-_.]/g, "").toLowerCase();
  if (SECRET_KEYS[norm] === true) return true;
  if (SENSITIVE_KEY_SUFFIXES.some((s) => norm.endsWith(s))) return true;
  if (norm.endsWith("token") && !TOKEN_COUNT_EXCLUSIONS.test(norm)) return true;
  return false;
}

export const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

function redactPlainText(value: string): string {
  let result = stripAnsi(value);

  // Apply multiline PEM block patterns first so single-line assignment patterns don't bisect them
  result = PEM_PATTERNS.reduce((next, pattern) => next.replace(pattern, REDACTED), result);

  // URL userinfo
  if (result.includes("://") && result.includes("@")) {
    result = result.replace(
      /\b([a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\/)(?:([^/\s:@]+):|:)?([^/\s@]+)@/gi,
      (m, scheme, user) => (user ? `${scheme}${user}:${REDACTED}@` : `${scheme}${REDACTED}@`),
    );
  }

  // URL sensitive query params
  if (result.includes("?") || result.includes("&")) {
    result = result.replace(
      /([?&](?:[a-zA-Z0-9_.-]{0,64}(?:password|passwd|pwd|secret|apikey|api[_-]?key|session[_-]?id)|(?!(?:input|output|prompt|completion|total|max|estimated?)[_-])[a-zA-Z0-9_.-]{0,64}token)=)([^&#\s]+)/gi,
      (m, prefix) => `${prefix}${REDACTED}`,
    );
  }

  // Quoted JSON properties with credential names (for unparseable snippets or freeform lines)
  if (result.includes('"')) {
    result = result.replace(
      /"([a-zA-Z0-9_.-]{0,64}(?:password|passwd|pwd|secret|apikey|api[_-]?key|private[_-]?key|passphrase|authorization|set[-_]?cookie|cookie|session[_-]?id)|(?!(?:input|output|prompt|completion|total|max|estimated?)[_-])[a-zA-Z0-9_.-]{0,64}token)"\s*:\s*(?:"(?:[^"\\\r\n]|\\.)*(?:"|$)|'(?:[^'\\\r\n]|\\.)*(?:'|$)|(?!\[REDACTED\])[^\s,;}{\]\r\n]+)/gi,
      (m, key) => `"${key}": "${REDACTED}"`,
    );
  }

  // YAML line assignments
  if (result.includes(":")) {
    result = result.replace(
      /(?:^|[\r\n])(\s*(?:-\s+)?)([a-zA-Z0-9_.-]{0,64}(?:password|passwd|pwd|secret|apikey|api[_-]?key|private[_-]?key|passphrase|authorization|set[-_]?cookie|cookie|session[_-]?id)|(?!(?:input|output|prompt|completion|total|max|estimated?)[_-])[a-zA-Z0-9_.-]{0,64}token)\s*:\s*(?:"(?:[^"\\\r\n]|\\.)*(?:"|$)|'(?:[^'\\\r\n]|\\.)*(?:'|$)|(?!\[REDACTED\])[^\r\n]+)/gi,
      (match, indent, key) =>
        `${match.startsWith("\r\n") ? "\r\n" : match.startsWith("\n") ? "\n" : match.startsWith("\r") ? "\r" : ""}${indent}${key}: ${REDACTED}`,
    );
  }

  // .env, export, and CLI flag assignments
  if (result.includes("=")) {
    result = result.replace(
      /(?:^|[\r\n;])\s*(?:export\s+|--)?((?!(?:[A-Za-z0-9_.-]*[_-])?(?:input|output|prompt|completion|total|max|estimated?|billable|consumed)[_-]?tokens?\s*=)[A-Za-z0-9_.-]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|AUTH)[A-Za-z0-9_.-]*\s*=\s*)(?:"(?:[^"\\\r\n]|\\.)*(?:"|$)|'(?:[^'\\\r\n]|\\.)*(?:'|$)|(?!\[REDACTED\])[^;\r\n]+)/gi,
      (match, prefix) =>
        match.replace(/(?:"(?:[^"\\\r\n]|\\.)*(?:"|$)|'(?:[^'\\\r\n]|\\.)*(?:'|$)|(?!\[REDACTED\])[^;\r\n]+)$/, `${prefix}${REDACTED}`),
    );
  }

  // HTTP Authorization / Proxy-Authorization headers
  if (/authorization/i.test(result)) {
    result = result.replace(
      /(^|[\r\n\s"'])\b((?:proxy-)?authorization)\s*:\s*(?:basic\s+[A-Za-z0-9+/=]+|bearer\s+[A-Za-z0-9._~+/-]+=*|(?!\[REDACTED\])[^\r\n"']+)/gi,
      (m, prefix, header) => `${prefix}${header}: ${REDACTED}`,
    );
  }

  // HTTP Cookie / Set-Cookie headers
  if (/cookie/i.test(result)) {
    result = result.replace(
      /(^|[\r\n\s"'])\b(set[-_]?cookie|cookie)\s*:\s*(?!\[REDACTED\])[^\r\n"']+/gi,
      (m, prefix, header) => `${prefix}${header}: ${REDACTED}`,
    );
  }

  // Generic token / key assignments
  result = ASSIGNMENT_PATTERNS.reduce((next, pattern) => next.replace(pattern, REDACTED), result);

  // shortcut: heuristic regexes cover standard serialization formats; arbitrary ad-hoc token structures require domain schema
  return result;
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

export function redactString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(redactValue(parsed));
    } catch {
      // unparseable or partial JSON, proceed with plain text redactor
    }
  }
  return redactPlainText(value);
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

