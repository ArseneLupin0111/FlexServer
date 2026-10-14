const REDACTED = "[REDACTED]";
const SECRET_KEYS = new Set([
  "password",
  "privatekey",
  "private_key",
  "publickey",
  "public_key",
  "authorization",
  "token",
  "localauthtoken",
  "dek",
  "kek",
  "ciphertext",
  "encryptedkey",
  "encrypted_key",
  "kekid",
  "kek_id",
  "sshkeyencryptionkey",
  "ssh_key_encryption_key",
  "authtag",
  "auth_tag",
]);
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+\S+)?/g,
  /password\s*=\s*[^\s&]+/gi,
  /bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

function isSecretKey(key: string) {
  return SECRET_KEYS.has(key.replace(/[-_]/g, "").toLowerCase());
}

export function redactString(value: string): string {
  return SECRET_PATTERNS.reduce(
    (next, pattern) => next.replace(pattern, REDACTED),
    value,
  );
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

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactString(error.message);
  if (typeof error === "string") return redactString(error);
  return "Internal server error";
}
