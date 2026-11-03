import { describe, expect, it } from "vitest";
import {
  redactString,
  redactValue,
  safeErrorMessage,
  ChunkRedactor,
  isSecretKey,
  REDACTED,
} from "../src/common/redaction.js";

describe("redaction consumer behavior regressions", () => {
  describe("quoted JSON and tool arguments", () => {
    it("redacts quoted credentials with spaces and preserves valid JSON", () => {
      const payload = JSON.stringify({
        password: "my super secret password with spaces",
        clientSecret: "client secret value with spaces",
        token: "bearer-token-123 with spaces",
        apiKey: "sk-proj-1234567890abcdef1234567890",
        Cookie: "session_id=secret123; user=alice",
        Authorization: "Basic dXNlcjpwYXNzd29yZA==",
        inputTokens: 120,
        totalTokens: 250,
      });

      const redacted = redactString(payload);
      expect(redacted).not.toContain("my super secret password with spaces");
      expect(redacted).not.toContain("client secret value with spaces");
      expect(redacted).not.toContain("bearer-token-123 with spaces");
      expect(redacted).not.toContain("sk-proj-1234567890abcdef1234567890");
      expect(redacted).not.toContain("secret123");
      expect(redacted).not.toContain("dXNlcjpwYXNzd29yZA==");

      const parsed = JSON.parse(redacted);
      expect(parsed.password).toBe(REDACTED);
      expect(parsed.clientSecret).toBe(REDACTED);
      expect(parsed.token).toBe(REDACTED);
      expect(parsed.apiKey).toBe(REDACTED);
      expect(parsed.Cookie).toBe(REDACTED);
      expect(parsed.Authorization).toBe(REDACTED);
      expect(parsed.inputTokens).toBe(120);
      expect(parsed.totalTokens).toBe(250);
    });

    it("sanitizes incomplete PEM with escaped newlines in string JSON tool arguments", () => {
      const toolCallArgs = JSON.stringify({
        path: "/root/.ssh/id_rsa",
        content: "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn",
        mode: "0600",
      });

      const sanitized = redactString(toolCallArgs);
      expect(sanitized).not.toContain("OPENSSH PRIVATE KEY");
      expect(sanitized).not.toContain("b3BlbnNzaC1rZXktdjE");

      const parsed = JSON.parse(sanitized);
      expect(parsed.path).toBe("/root/.ssh/id_rsa");
      expect(parsed.content).toBe(REDACTED);
      expect(parsed.mode).toBe("0600");
    });

    it("sanitizes JSON-encoded file contents with escaped quotes nested in tool arguments", () => {
      const payload = JSON.stringify({
        tool: "write_file",
        arguments: JSON.stringify({
          path: "/app/config.json",
          content: '{"password": "secret\\"pass with spaces", "unrelated": "ok"}',
        }),
      });

      const sanitized = redactString(payload);
      expect(sanitized).not.toContain("secret");
      const parsedOuter = JSON.parse(sanitized);
      const parsedInner = JSON.parse(parsedOuter.arguments);
      const parsedContent = JSON.parse(parsedInner.content);
      expect(parsedContent.password).toBe(REDACTED);
      expect(parsedContent.unrelated).toBe("ok");
    });
  });

  describe("YAML and .env assignments", () => {
    it("redacts YAML credential assignments with spaces", () => {
      const yaml = [
        'password: "secret password with spaces"',
        "db_password: 'db secret password'",
        "auth_token: plain secret token with spaces",
        "prompt_tokens: 15",
      ].join("\n");

      const redacted = redactString(yaml);
      expect(redacted).not.toContain("secret password with spaces");
      expect(redacted).not.toContain("db secret password");
      expect(redacted).not.toContain("plain secret token with spaces");
      expect(redacted).toContain("prompt_tokens: 15");
    });

    it("redacts .env credential assignments with quotes and spaces", () => {
      const env = [
        'export SECRET_KEY="my secret key with spaces"',
        "DATABASE_PASSWORD='single quoted pass with spaces'",
        "API_TOKEN=unquoted_token_val",
        "PORT=8080",
      ].join("\n");

      const redacted = redactString(env);
      expect(redacted).not.toContain("my secret key with spaces");
      expect(redacted).not.toContain("single quoted pass with spaces");
      expect(redacted).not.toContain("unquoted_token_val");
      expect(redacted).toContain("PORT=8080");
      expect(redacted).toContain("SECRET_KEY=[REDACTED]");
      expect(redacted).toContain("DATABASE_PASSWORD=[REDACTED]");
    });
  });

  describe("Authorization and Cookie headers", () => {
    it("redacts Authorization Basic and Bearer headers in logs and curl commands", () => {
      const log = 'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA==" -H "Proxy-Authorization: Basic dXNlcjpwYXNz" https://api.example.com';
      const redacted = redactString(log);
      expect(redacted).not.toContain("dXNlcjpwYXNzd29yZA==");
      expect(redacted).not.toContain("dXNlcjpwYXNz");
      expect(redacted).toContain("Authorization: [REDACTED]");
      expect(redacted).toContain("Proxy-Authorization: [REDACTED]");
    });

    it("redacts Cookie and Set-Cookie headers", () => {
      const headers = [
        "Cookie: session=secret123; tracking=allowed",
        "Set-Cookie: auth_token=token456; Path=/; Secure; HttpOnly",
      ].join("\n");

      const redacted = redactString(headers);
      expect(redacted).not.toContain("secret123");
      expect(redacted).not.toContain("token456");
      expect(redacted).toContain("Cookie: [REDACTED]");
      expect(redacted).toContain("Set-Cookie: [REDACTED]");
    });
  });

  describe("URL userinfo and sensitive query params", () => {
    it("redacts userinfo credentials across database and http URLs", () => {
      expect(redactString("postgres://postgres:adminPass123@localhost:5432/db")).toBe(
        "postgres://postgres:[REDACTED]@localhost:5432/db",
      );
      expect(redactString("redis://:redisPass123@10.0.0.1:6379")).toBe(
        "redis://[REDACTED]@10.0.0.1:6379",
      );
      expect(redactString("https://ghp_token123@github.com/org/repo")).toBe(
        "https://[REDACTED]@github.com/org/repo",
      );
    });

    it("redacts sensitive query params without corrupting ordinary token counts", () => {
      const url = "https://api.example.com/data?token=secretToken&api_key=secretKey&prompt_tokens=42&token_count=3";
      const redacted = redactString(url);
      expect(redacted).not.toContain("secretToken");
      expect(redacted).not.toContain("secretKey");
      expect(redacted).toContain("token=[REDACTED]");
      expect(redacted).toContain("api_key=[REDACTED]");
      expect(redacted).toContain("prompt_tokens=42");
      expect(redacted).toContain("token_count=3");
    });
  });

  describe("PEM private keys and truncation handling", () => {
    it("redacts complete and truncated PEM blocks", () => {
      const fullPem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y1v\n-----END RSA PRIVATE KEY-----";
      expect(redactString(fullPem)).toBe(REDACTED);

      const truncatedPem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y1v";
      expect(redactString(truncatedPem)).toBe(REDACTED);
    });

    it("safeErrorMessage masks secrets before byte truncation", () => {
      const msg = `Failed connecting with password=${"x".repeat(2000)} to host`;
      const safe = safeErrorMessage(new Error(msg), 100);
      expect(safe).not.toContain("xxx");
      expect(safe).toContain(REDACTED);
      expect(Buffer.byteLength(safe, "utf8")).toBeLessThanOrEqual(100);
    });

    it("ChunkRedactor masks incomplete PEM blocks upon flush", () => {
      const redactor = new ChunkRedactor();
      redactor.process("Log line: reading credentials\n");
      redactor.process("-----BEGIN RSA PRIVATE KEY-----\n");
      redactor.process("MIIEowIBAAKCAQEA0Y1v\n");
      const flushed = redactor.flush();
      expect(flushed).not.toContain("MIIEowIBAAKCAQEA0Y1v");
      expect(flushed).toContain(REDACTED);
    });

    it("emits normal prose incrementally before end without waiting for newlines", () => {
      const redactor = new ChunkRedactor();
      const p1 = redactor.process("Hello world! ");
      expect(p1).toBe("Hello world! ");
      const p2 = redactor.process("The server is running smoothly. ");
      expect(p2).toBe("The server is running smoothly. ");
      const p3 = redactor.process("All containers are healthy.");
      expect(p3).toBe("");
      const flushed = redactor.flush();
      expect(flushed).toBe("All containers are healthy.");
    });

    it("holds back split tokens and masks secrets cut across chunk boundaries", () => {
      const redactor = new ChunkRedactor();
      // "sk-" cut across chunks: "sk-" then rest of token
      const p1 = redactor.process("System inspected. Key is sk-");
      // "System inspected. " was a safe clause, but "Key is sk-" has a trigger and no newline so held back
      expect(p1).toBe("System inspected. ");
      const p2 = redactor.process("1234567890abcdef1234567890 in text.\n");
      expect(p2).not.toContain("1234567890abcdef1234567890");
      const flushed = redactor.flush();
      const total = p1 + p2 + flushed;
      expect(total).not.toContain("1234567890abcdef1234567890");
      expect(total).toContain(REDACTED);
    });

    it("holds back split assignment keys and values across chunk boundaries", () => {
      const redactor = new ChunkRedactor();
      const p1 = redactor.process("Setup complete; pass");
      expect(p1).toBe("Setup complete; ");
      const p2 = redactor.process("word = supersecret123\n");
      expect(p2).not.toContain("supersecret123");
      const flushed = redactor.flush();
      const total = p1 + p2 + flushed;
      expect(total).not.toContain("supersecret123");
      expect(total).toContain(REDACTED);
    });
  });

  describe("redactValue and isSecretKey", () => {
    it("preserves boolean provider credential readiness without exposing credential values", () => {
      const payload = { providers: [
        { hasApiKey: true, apiKey: "provider-credential", encryptedApiKey: "encrypted-material" },
        { hasApiKey: false },
        { hasApiKey: "not-a-boolean-secret" },
      ] };
      const expected = { providers: [
        { hasApiKey: true, apiKey: REDACTED, encryptedApiKey: REDACTED },
        { hasApiKey: false },
        { hasApiKey: REDACTED },
      ] };
      expect(redactValue(payload)).toEqual(expected);
      expect(JSON.parse(redactString(JSON.stringify(payload)))).toEqual(expected);
    });

    it("redacts prefixed sensitive keys without matching ordinary token counts", () => {
      const input = {
        dbPassword: "secret-password",
        user_password: "user-pass",
        stripeApiKey: "sk-stripe-live",
        my_api_key: "api-key-value",
        sessionToken: "sess-token-xyz",
        x_auth_token: "auth-token-abc",
        nested: {
          privateKey: "private-key-material",
          clientSecret: "client-secret-val",
        },
        inputTokens: 100,
        outputTokens: 50,
        promptTokens: 80,
        completionTokens: 20,
        totalTokens: 150,
        maxTokens: 4096,
        tokenCount: 12,
        tokens: 35,
        tokenUsage: { total_tokens: 150 },
      };

      const output = redactValue(input) as Record<string, unknown>;
      expect(output.dbPassword).toBe(REDACTED);
      expect(output.user_password).toBe(REDACTED);
      expect(output.stripeApiKey).toBe(REDACTED);
      expect(output.my_api_key).toBe(REDACTED);
      expect(output.sessionToken).toBe(REDACTED);
      expect(output.x_auth_token).toBe(REDACTED);

      const nested = output.nested as Record<string, unknown>;
      expect(nested.privateKey).toBe(REDACTED);
      expect(nested.clientSecret).toBe(REDACTED);

      expect(output.inputTokens).toBe(100);
      expect(output.outputTokens).toBe(50);
      expect(output.promptTokens).toBe(80);
      expect(output.completionTokens).toBe(20);
      expect(output.totalTokens).toBe(150);
      expect(output.maxTokens).toBe(4096);
      expect(output.tokenCount).toBe(12);
      expect(output.tokens).toBe(35);
      expect((output.tokenUsage as Record<string, unknown>).total_tokens).toBe(150);
    });

    it("correctly identifies secret keys with isSecretKey", () => {
      expect(isSecretKey("dbPassword")).toBe(true);
      expect(isSecretKey("x-api-key")).toBe(true);
      expect(isSecretKey("authToken")).toBe(true);
      expect(isSecretKey("inputTokens")).toBe(false);
      expect(isSecretKey("outputTokens")).toBe(false);
      expect(isSecretKey("totalTokens")).toBe(false);
      expect(isSecretKey("tokenCount")).toBe(false);
      expect(isSecretKey("tokens")).toBe(false);
    });
  });

  describe("benign text preservation", () => {
    it("leaves safe prose intact", () => {
      expect(redactString("The basic tier includes standard support")).toBe(
        "The basic tier includes standard support",
      );
      expect(redactString("Please enter your password at the prompt")).toBe(
        "Please enter your password at the prompt",
      );
      expect(redactString("curl -H 'Accept: application/json' https://api.example.com")).toBe(
        "curl -H 'Accept: application/json' https://api.example.com",
      );
    });
  });

  describe("ChunkRedactor sentence-safe split chunk redaction", () => {
    it("does not leak YAML keys or values when split around whitespace before colon", () => {
      const redactor = new ChunkRedactor();
      const p1 = redactor.process("db_passphrase ");
      const p2 = redactor.process(": swordfish\n");
      const full = p1 + p2 + redactor.flush();
      expect(full).not.toContain("swordfish");
      expect(full).toContain(REDACTED);
    });

    it("does not leak env assignment when split around whitespace before equals", () => {
      const redactor = new ChunkRedactor();
      const p1 = redactor.process("AWS_ACCESS_KEY_ID ");
      const p2 = redactor.process("= AKIAIOSFODNN7EXAMPLE\n");
      const full = p1 + p2 + redactor.flush();
      expect(full).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(full).toContain(REDACTED);
    });

    it("emits safe prose across sentence boundaries before line end", () => {
      const redactor = new ChunkRedactor();
      const p1 = redactor.process("The memory inspection completed successfully. ");
      const p2 = redactor.process("Next step underway.");
      expect(p1).toBe("The memory inspection completed successfully. ");
      const flushed = redactor.flush();
      expect(flushed).toBe("Next step underway.");
    });

    it("does not leak env key ending in dot when assignment operator is in subsequent chunk", () => {
      const redactor = new ChunkRedactor();
      const p1 = redactor.process("MY_KEY. ");
      const p2 = redactor.process("= swordfish\n");
      const full = p1 + p2 + redactor.flush();
      expect(full).not.toContain("swordfish");
      expect(full).toContain(REDACTED);
    });

    it("does not leak secrets when ANSI escape codes bisect trigger roots across chunks", () => {
      const redactor = new ChunkRedactor();
      const p1 = redactor.process("MY_KE\u001b[31mY. ");
      expect(p1).toBe(""); // Held back because normalized candidate contains "KEY"
      const p2 = redactor.process("= swordfish\n");
      const full = p1 + p2 + redactor.flush();
      expect(full).not.toContain("swordfish");
      expect(full).toContain(REDACTED);
    });
  });
});
