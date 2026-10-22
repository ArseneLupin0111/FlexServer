import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateExternalSecretPath } from "../ssh/key-encryption.js";
import type { ComposeCryptoConfig } from "../crypto/compose-crypto-config.js";
import { resolveComposeKeyringFilePath } from "../crypto/compose-crypto-config.js";
import { resolveAiKeyringFilePath } from "../ai/ai-crypto.js";
export type AppMode = "demo" | "local";
export type StorageDriver = "json" | "postgres";

export type AppConfig = {
  mode: AppMode;
  enableWebTerminal: boolean;
  allowPrivateNetworkTargets: boolean;
  dataDir: string;
  privateDir: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  dockerAlertAcknowledgeRateLimitWindowMs?: number;
  dockerAlertAcknowledgeRateLimitMax?: number;
  agentPublicBaseUrl?: string;
  agentBinaryPath?: string;
  agentInstallIntervalSeconds: number;
  allowInsecureAgentHttp: boolean;
  localAgentEnabled?: boolean;
  storageDriver: StorageDriver;
  databaseUrl?: string;
  dbSsl: boolean;
  dbPoolMax: number;

  // Dashboard session auth
  dashboardSessionSecret?: string;
  dashboardSessionTtlSeconds: number;
  dashboardPublicOrigin?: string;
  dashboardCookieSecure: boolean;
  dashboardCookieSameSite: "lax" | "strict" | "none";

  // Reverse proxy trust
  trustProxyHops: number;

  // Retention limits
  jobHistoryLimit: number;
  auditHistoryLimit: number;
  metricWindowLimit: number;

  // Docker monitoring retention maintenance
  dockerRetentionDays: number;
  dockerRollupRetentionDays: number;
  dockerResolvedAlertRetentionDays: number;
  dockerMaintenanceSamplesPerVps: number;
  dockerMaintenanceEventsPerVps: number;
  dockerMaintenanceIntervalSeconds?: number;
  dockerJsonMaxBytes: number;
  dockerJsonMaintenanceMaxRewriteBytes: number;

  // SSH security
  sshHostKeyPins: Record<string, string | string[]>;
  sshHostKeyPolicy: "strict" | "permissive";
  terminal?: { global: number; perDashboard: number; perVps: number; openTimeoutMs: number; idleTimeoutMs: number; lifetimeMs: number; revocationPollMs: number; heartbeatMs: number; outputBufferBytes: number; inputBufferBytes: number; slowConsumerTimeoutMs: number; pendingLimit: number };
  sshKeyEncryptionKeyFile?: string;
  localFilesSocketPath?: string;
  composeCrypto: ComposeCryptoConfig;
  compose?: {
    claimLeaseSeconds: number;
    inventoryMaxBytes: number;
    previewTtlSeconds: number;
  };
  ai: {
    enabled: boolean;
    keyringFile: string;
  };
  fleet: {
    publicKeyFile?: string;
    manifestUrl?: string;
  };
};

const booleanSchema = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

const envSchema = z.object({
  APP_MODE: z.enum(["demo", "local"]).default("demo"),
  ENABLE_WEB_TERMINAL: booleanSchema.default("false"),
  APP_AI_ENABLED: booleanSchema.default("true"),
  ALLOW_PRIVATE_NETWORK_TARGETS: booleanSchema.default("false"),
  DATA_DIR: z.string().trim().min(1).default("data"),
  PRIVATE_DIR: z.string().trim().min(1).default("private"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  DOCKER_ALERT_ACK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  DOCKER_ALERT_ACK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AGENT_PUBLIC_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().url().optional(),
  ),
  AGENT_BINARY_PATH: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().optional(),
  ),
  AGENT_INSTALL_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(1),
  ALLOW_INSECURE_AGENT_HTTP: booleanSchema.default("false"),
  LOCAL_AGENT_ENABLED: booleanSchema.default("true"),
  STORAGE_DRIVER: z.enum(["json", "postgres"]).default("json"),
  DATABASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  DB_SSL: booleanSchema.default("false"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Dashboard session auth
  DASHBOARD_SESSION_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().optional(),
  ),
  DASHBOARD_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400),
  DASHBOARD_PUBLIC_ORIGIN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().optional(),
  ),
  DASHBOARD_COOKIE_SECURE: booleanSchema.default("false"),
  DASHBOARD_COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),

  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  // Retention limits
  JOB_HISTORY_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .max(50_000)
    .default(1000),
  AUDIT_HISTORY_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .max(100_000)
    .default(5000),
  METRIC_WINDOW_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(120),
  DOCKER_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  DOCKER_ROLLUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  DOCKER_RESOLVED_ALERT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  DOCKER_MAINTENANCE_SAMPLES_PER_VPS: z.coerce
    .number()
    .int()
    .positive()
    .max(5000)
    .default(5000),
  DOCKER_MAINTENANCE_EVENTS_PER_VPS: z.coerce
    .number()
    .int()
    .positive()
    .max(10000)
    .default(10000),
  DOCKER_JSON_MAX_BYTES: z.coerce.number().int().positive().max(32 * 1024 * 1024).default(32 * 1024 * 1024),
  DOCKER_JSON_MAINTENANCE_MAX_REWRITE_BYTES: z.coerce.number().int().positive().max(8 * 1024 * 1024).default(8 * 1024 * 1024),
  DOCKER_MAINTENANCE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(86400)
    .default(21600),

  // SSH security
  SSH_HOST_KEY_PINS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),
  SSH_HOST_KEY_POLICY: z.enum(["strict", "permissive"]).default("strict"),
  SSH_KEY_ENCRYPTION_KEY_FILE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().optional(),
  ),

  // Compose applications (phase 2) — external-only keyring material
  COMPOSE_KEYRING_FILE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().optional(),
  ),
  AI_KEYRING_FILE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().optional(),
  ),
  COMPOSE_CLAIM_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),
  COMPOSE_INVENTORY_MAX_BYTES: z.coerce.number().int().min(64 * 1024).max(8 * 1024 * 1024).default(512 * 1024),
  COMPOSE_PREVIEW_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
  LOCAL_FILES_SOCKET_PATH: z.string().trim().min(1).default("/var/run/flexserver/host-files/files.sock"),
  TERMINAL_GLOBAL_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  TERMINAL_DASHBOARD_LIMIT: z.coerce.number().int().min(1).max(20).default(3),
  TERMINAL_VPS_LIMIT: z.coerce.number().int().min(1).max(20).default(2),
  TERMINAL_OPEN_TIMEOUT_MS: z.coerce.number().int().positive().max(120000).default(10000),
  TERMINAL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().max(86400000).default(900000),
  TERMINAL_LIFETIME_MS: z.coerce.number().int().positive().max(86400000).default(7200000),
  TERMINAL_REVOCATION_POLL_MS: z.coerce.number().int().positive().max(3600000).default(5000),
  TERMINAL_HEARTBEAT_MS: z.coerce.number().int().positive().max(3600000).default(30000),
  TERMINAL_OUTPUT_BUFFER_BYTES: z.coerce.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024),
  TERMINAL_INPUT_BUFFER_BYTES: z.coerce.number().int().positive().max(1024 * 1024).default(64 * 1024),
  TERMINAL_SLOW_CONSUMER_TIMEOUT_MS: z.coerce.number().int().positive().max(600000).default(10000),
  TERMINAL_PENDING_LIMIT: z.coerce.number().int().positive().max(1000).default(10),
  FLEET_RELEASE_PUBLIC_KEY_FILE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().optional(),
  ),
  FLEET_RELEASE_MANIFEST_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().url().optional(),
  ),
});

export function parseAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = envSchema.parse(env);

  let sshKeyEncryptionKeyFile: string | undefined;
  if (parsed.SSH_KEY_ENCRYPTION_KEY_FILE) {
    const projectRoot =
      findProjectRoot(process.cwd()) ??
      findProjectRoot(dirname(fileURLToPath(import.meta.url)));
    sshKeyEncryptionKeyFile = validateExternalSecretPath(
      parsed.SSH_KEY_ENCRYPTION_KEY_FILE,
      parsed.DATA_DIR,
      parsed.PRIVATE_DIR,
      projectRoot,
    );
  }
  const composeCrypto: ComposeCryptoConfig = {
    keyringFile: resolveComposeKeyringFilePath(
      parsed.COMPOSE_KEYRING_FILE,
      { dataDir: parsed.DATA_DIR, privateDir: parsed.PRIVATE_DIR },
    ),
  };
  const aiKeyringFile = resolveAiKeyringFilePath(
    parsed.AI_KEYRING_FILE,
    { dataDir: parsed.DATA_DIR, privateDir: parsed.PRIVATE_DIR },
  );
  if (parsed.APP_MODE === "local") {
    if (!parsed.DASHBOARD_SESSION_SECRET) {
      throw new Error(
        "DASHBOARD_SESSION_SECRET is required when APP_MODE=local",
      );
    }
    if (parsed.DASHBOARD_SESSION_SECRET.length < 32) {
      throw new Error(
        "DASHBOARD_SESSION_SECRET must be at least 32 characters when APP_MODE=local " +
          `(got ${parsed.DASHBOARD_SESSION_SECRET.length})`,
      );
    }
  }

  // DASHBOARD_COOKIE_SAME_SITE=none requires Secure
  if (
    parsed.DASHBOARD_COOKIE_SAME_SITE === "none" &&
    !parsed.DASHBOARD_COOKIE_SECURE
  ) {
    throw new Error(
      "DASHBOARD_COOKIE_SAME_SITE=none requires DASHBOARD_COOKIE_SECURE=true",
    );
  }

  // HTTPS DASHBOARD_PUBLIC_ORIGIN in local mode requires Secure cookies
  if (
    parsed.APP_MODE === "local" &&
    parsed.DASHBOARD_PUBLIC_ORIGIN &&
    parsed.DASHBOARD_PUBLIC_ORIGIN.startsWith("https://") &&
    !parsed.DASHBOARD_COOKIE_SECURE
  ) {
    throw new Error(
      "DASHBOARD_COOKIE_SECURE=true is required when DASHBOARD_PUBLIC_ORIGIN uses https:// " +
        "and APP_MODE=local",
    );
  }

  if (parsed.ENABLE_WEB_TERMINAL && parsed.APP_MODE !== "local") {
    throw new Error("ENABLE_WEB_TERMINAL requires APP_MODE=local");
  }
  if (parsed.ENABLE_WEB_TERMINAL) {
    if (!parsed.DASHBOARD_PUBLIC_ORIGIN) throw new Error("DASHBOARD_PUBLIC_ORIGIN is required when ENABLE_WEB_TERMINAL=true");
    try { const origin = new URL(parsed.DASHBOARD_PUBLIC_ORIGIN); if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error(); } catch { throw new Error("DASHBOARD_PUBLIC_ORIGIN must be a canonical origin when ENABLE_WEB_TERMINAL=true"); }
  }

  if (parsed.STORAGE_DRIVER === "postgres" && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
  }

  return {
    mode: parsed.APP_MODE,
    enableWebTerminal: parsed.ENABLE_WEB_TERMINAL,
    allowPrivateNetworkTargets: parsed.ALLOW_PRIVATE_NETWORK_TARGETS,
    dataDir: parsed.DATA_DIR,
    privateDir: parsed.PRIVATE_DIR,
    rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: parsed.RATE_LIMIT_MAX,
    dockerAlertAcknowledgeRateLimitWindowMs: parsed.DOCKER_ALERT_ACK_RATE_LIMIT_WINDOW_MS,
    dockerAlertAcknowledgeRateLimitMax: parsed.DOCKER_ALERT_ACK_RATE_LIMIT_MAX,
    agentPublicBaseUrl: parsed.AGENT_PUBLIC_BASE_URL,
    agentBinaryPath: parsed.AGENT_BINARY_PATH,
    agentInstallIntervalSeconds: parsed.AGENT_INSTALL_INTERVAL_SECONDS,
    allowInsecureAgentHttp: parsed.ALLOW_INSECURE_AGENT_HTTP,
    localAgentEnabled: parsed.LOCAL_AGENT_ENABLED,
    storageDriver: parsed.STORAGE_DRIVER,
    databaseUrl: parsed.DATABASE_URL,
    dbSsl: parsed.DB_SSL,
    dbPoolMax: parsed.DB_POOL_MAX,

    dashboardSessionSecret: parsed.DASHBOARD_SESSION_SECRET,
    dashboardSessionTtlSeconds: parsed.DASHBOARD_SESSION_TTL_SECONDS,
    dashboardPublicOrigin: parsed.DASHBOARD_PUBLIC_ORIGIN,
    dashboardCookieSecure: parsed.DASHBOARD_COOKIE_SECURE,
    dashboardCookieSameSite: parsed.DASHBOARD_COOKIE_SAME_SITE,

    trustProxyHops: parsed.TRUST_PROXY_HOPS,

    jobHistoryLimit: parsed.JOB_HISTORY_LIMIT,
    auditHistoryLimit: parsed.AUDIT_HISTORY_LIMIT,
    metricWindowLimit: parsed.METRIC_WINDOW_LIMIT,

    dockerRetentionDays: parsed.DOCKER_RETENTION_DAYS,
    dockerRollupRetentionDays: parsed.DOCKER_ROLLUP_RETENTION_DAYS,
    dockerResolvedAlertRetentionDays: parsed.DOCKER_RESOLVED_ALERT_RETENTION_DAYS,
    dockerMaintenanceSamplesPerVps: parsed.DOCKER_MAINTENANCE_SAMPLES_PER_VPS,
    dockerMaintenanceEventsPerVps: parsed.DOCKER_MAINTENANCE_EVENTS_PER_VPS,
     dockerMaintenanceIntervalSeconds: parsed.DOCKER_MAINTENANCE_INTERVAL_SECONDS,
     dockerJsonMaxBytes: parsed.DOCKER_JSON_MAX_BYTES,
     dockerJsonMaintenanceMaxRewriteBytes: parsed.DOCKER_JSON_MAINTENANCE_MAX_REWRITE_BYTES,


    sshHostKeyPins: parsed.SSH_HOST_KEY_PINS
      ? (() => {
          let raw: unknown;
          try {
            raw = JSON.parse(parsed.SSH_HOST_KEY_PINS!);
          } catch {
            throw new Error("SSH_HOST_KEY_PINS must be a valid JSON object");
          }
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            throw new Error(
              "SSH_HOST_KEY_PINS must be a JSON object (not an array)",
            );
          }
          for (const [key, value] of Object.entries(raw)) {
            if (typeof value === "string") continue;
            if (
              Array.isArray(value) &&
              value.every((v): v is string => typeof v === "string")
            )
              continue;
            throw new Error(
              `SSH_HOST_KEY_PINS["${key}"] must be a string or array of strings`,
            );
          }
          return raw as Record<string, string | string[]>;
        })()
      : {},
    sshHostKeyPolicy: parsed.SSH_HOST_KEY_POLICY,
    sshKeyEncryptionKeyFile,
    composeCrypto,
    compose: {
      claimLeaseSeconds: parsed.COMPOSE_CLAIM_LEASE_SECONDS,
      inventoryMaxBytes: parsed.COMPOSE_INVENTORY_MAX_BYTES,
      previewTtlSeconds: parsed.COMPOSE_PREVIEW_TTL_SECONDS,
    },
    ai: {
      enabled: parsed.APP_AI_ENABLED,
      keyringFile: aiKeyringFile,
    },
    localFilesSocketPath: parsed.LOCAL_FILES_SOCKET_PATH,
    terminal: {
      global: parsed.TERMINAL_GLOBAL_LIMIT,
      perDashboard: parsed.TERMINAL_DASHBOARD_LIMIT,
      perVps: parsed.TERMINAL_VPS_LIMIT,
      openTimeoutMs: parsed.TERMINAL_OPEN_TIMEOUT_MS,
      idleTimeoutMs: parsed.TERMINAL_IDLE_TIMEOUT_MS,
      lifetimeMs: parsed.TERMINAL_LIFETIME_MS,
      revocationPollMs: parsed.TERMINAL_REVOCATION_POLL_MS,
      heartbeatMs: parsed.TERMINAL_HEARTBEAT_MS,
      outputBufferBytes: parsed.TERMINAL_OUTPUT_BUFFER_BYTES,
      inputBufferBytes: parsed.TERMINAL_INPUT_BUFFER_BYTES,
      slowConsumerTimeoutMs: parsed.TERMINAL_SLOW_CONSUMER_TIMEOUT_MS,
      pendingLimit: parsed.TERMINAL_PENDING_LIMIT,
    },
    fleet: {
      publicKeyFile: parsed.FLEET_RELEASE_PUBLIC_KEY_FILE,
      manifestUrl: parsed.FLEET_RELEASE_MANIFEST_URL,
    },
   };
}

export function loadAppConfig(): AppConfig {
  loadDotenv({ path: findProjectRootEnvPath() });
  return parseAppConfig();
}

function findProjectRootEnvPath(): string {
  const startDirectories = [
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
  ];

  for (const startDirectory of startDirectories) {
    const projectRoot = findProjectRoot(startDirectory);
    if (projectRoot) return join(projectRoot, ".env");
  }

  return join(process.cwd(), ".env");
}

function findProjectRoot(startDirectory: string): string | undefined {
  let currentDirectory = startDirectory;

  while (true) {
    const packageJsonPath = join(currentDirectory, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          readFileSync(packageJsonPath, "utf8"),
        ) as { workspaces?: unknown };
        if (Array.isArray(packageJson.workspaces)) return currentDirectory;
      } catch {
        // Keep walking upward if package.json is not readable or parseable.
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return undefined;
    currentDirectory = parentDirectory;
  }
}
