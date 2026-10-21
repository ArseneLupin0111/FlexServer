import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import express, { type Express } from "express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createNestApp, type Dependencies } from "../src/app.js";
import { createJsonSessionRepository } from "../src/persistence/repositories/session.repository.js";
import { SESSION_COOKIE_NAME } from "../src/auth/cookies.js";
const trackedInits = new Set<Promise<NestExpressApplication>>();

export function createApp(deps: Dependencies = {}): Express {
  const server = express();
  let ready = false;
  let initError: unknown;
  const init = createNestApp(deps, server);
  trackedInits.add(init);

  init
    .then(() => {
      ready = true;
    })
    .catch((error: unknown) => {
      initError = error;
    });

  server.use(async (_req, _res, next) => {
    if (!ready && !initError) {
      try {
        await init;
      } catch {
        // initError is preserved by the catch handler above
      }
    }
    if (initError) return next(initError);
    next();
  });

  return server;
}

export async function closeTestApps(): Promise<void> {
  const inits = Array.from(trackedInits);
  trackedInits.clear();
  const initialized = await Promise.allSettled(inits);
  await Promise.all(initialized.map(result =>
    result.status === "fulfilled" ? result.value.close() : undefined,
  ));
  const failed = initialized.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}


/**
 * Create a dashboard session in the JSON store directly (bypasses login)
 * and returns the cookie header value for use with supertest.
 *
 * @param tempDir - Temporary directory where data/sessions.json lives
 * @param sessionSecret - DASHBOARD_SESSION_SECRET used to hash the token
 * @param ttlSeconds - Session TTL (default 86400)
 */
export async function createSessionCookie(
  tempDir: string,
  sessionSecret?: string,
  ttlSeconds = 86_400,
): Promise<string> {
  const repo = createJsonSessionRepository(
    join(tempDir, "data", "sessions.json"),
  );
  const rawToken = randomBytes(32).toString("hex");
  const pepper = sessionSecret ?? "";
  const tokenHash = createHash("sha256")
    .update(rawToken)
    .update(pepper)
    .digest("hex");

  await repo.create({
    tokenHash,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  });

  return `${SESSION_COOKIE_NAME}=${rawToken}`;
}
