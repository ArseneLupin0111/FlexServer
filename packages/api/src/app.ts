import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  ExpressAdapter,
  type NestExpressApplication,
} from "@nestjs/platform-express";
import express, { type Express } from "express";
import helmet from "helmet";
import { join } from "node:path";
import serveStatic from "serve-static";
import {
  AppModule,
  createAppModule,
  type AppDependencies,
} from "./app.module.js";
import { createLoginRateLimit } from "./common/login-rate-limit.middleware.js";
import { createMutationRateLimit } from "./common/rate-limit.middleware.js";
import { requestIdMiddleware } from "./common/request-id.middleware.js";
import { ApiExceptionFilter } from "./common/filters/api-exception.filter.js";
import { loadAppConfig } from "./config/app-config.js";
import {
  createPostgresRateLimitStore,
  createInMemoryRateLimitStore,
  type RateLimitStore,
} from "./common/rate-limit-store.js";
import { createDatabasePool } from "./db/pool.js";
import { attachTerminalWebSocket } from "./terminal/terminal-websocket.js";
import { TerminalSessionService } from "./terminal/terminal-session.service.js";
import { DashboardSessionService } from "./auth/dashboard-session.service.js";

export type Dependencies = AppDependencies;

export async function createNestApp(
  deps: Dependencies = {},
  server: Express = express(),
  httpServer?: import("node:http").Server,
): Promise<NestExpressApplication> {
  const config = deps.config ?? loadAppConfig();
  server.disable("x-powered-by");
  // Express 5 uses a strict query parser by default.
  // Preserve Express 4 nested query object parsing for compatibility.
  server.set("query parser", "extended");
  // Trust reverse proxy for correct client IP when behind nginx/haproxy.
  // Set TRUST_PROXY_HOPS=N to trust the N most recent proxy hops.
  // Default 0 (no trust) is safe for direct exposure. In production behind
  // a reverse proxy, set TRUST_PROXY_HOPS=1 (or more if chained).
  if (config.trustProxyHops > 0) {
    server.set("trust proxy", config.trustProxyHops);
  }
  server.use(requestIdMiddleware);
  server.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
          "img-src": ["'self'", "data:"],
          "connect-src": [
            "'self'",
            "https://fonts.googleapis.com",
            "https://fonts.gstatic.com",
          ],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "frame-ancestors": ["'none'"],
        },
      },
    }),
  );

  // Create rate-limit store: Postgres when in postgres mode, in-memory otherwise
  let rateLimitStore: RateLimitStore;
  if (config.storageDriver === "postgres") {
    // If deps.pool was provided, use it; otherwise create one (owned by this function)
    const ownsPool = !deps.pool;
    const pool = deps.pool ?? createDatabasePool(config);
    // If we created the pool, pass it through deps so createAppModule reuses and closes it.
    // If caller supplied deps.pool, caller owns lifecycle unless deps.ownsPool was set.
    deps = {
      ...deps,
      pool,
      ownsPool: ownsPool ? true : (deps.ownsPool ?? false),
    };
    rateLimitStore = createPostgresRateLimitStore(pool);
  } else {
    rateLimitStore = createInMemoryRateLimitStore();
  }

  server.use(createMutationRateLimit(config, rateLimitStore));
  server.use(createLoginRateLimit(rateLimitStore));
  server.use(
    serveStatic(join(process.cwd(), "public"), { index: "index.html" }),
  );

  const nestApp = await NestFactory.create<NestExpressApplication>(
    createAppModule({ ...deps, config }),
    new ExpressAdapter(server),
    {
      logger: false,
      rawBody: true,
    },
  );
  // Raise the shared JSON ceiling so the log broker's own guard answers
  // oversized batches with 400 body_too_large instead of the default 100kb
  // parser preempting the route. Must run before init so the default parser
  // is skipped.
  nestApp.useBodyParser("json", { limit: "1mb" });
  nestApp.useGlobalFilters(new ApiExceptionFilter());
  // Public SPA fallback for React Router entry points. Only paths registered
  // in web/src/App.tsx routes belong here: these are hard navigations that
  // must return index.html so the browser can restore client-side routing.
  server.get(/^\/(vps(\/.*)?|pricing|enterprise|security)?$/, (_req, res) => {
    res.sendFile(join(process.cwd(), "public", "index.html"));
  });
  await nestApp.init();
  const terminalService = nestApp.get(TerminalSessionService);
  // Explicit server ownership: callers supplying httpServer own the accepting
  // Node server; otherwise Nest's server is the terminal upgrade target.
  // createApp is an HTTP-test-only Express wrapper and does not expose listen.
  const terminalTransport = attachTerminalWebSocket(httpServer ?? nestApp.getHttpServer(), config, nestApp.get(DashboardSessionService), terminalService);
  terminalService.setWebSocketCloser(terminalTransport.close);
  return nestApp;
}

export function createApp(deps: Dependencies = {}) {
  const server = express();
  let ready = false;
  let initError: unknown;
  const init = createNestApp(deps, server)
    .then(() => {
      ready = true;
    })
    .catch((error: unknown) => {
      initError = error;
    });

  server.use(async (_req, _res, next) => {
    if (!ready && !initError) await init;
    if (initError) return next(initError);
    next();
  });

  return server;
}

export { AppModule };
