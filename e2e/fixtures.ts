import { test as base, expect } from '@playwright/test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type App = { baseURL: string; password: string };

export const test = base.extend<{}, { app: App }>({
  app: [async ({}, use) => {
    // Intentionally load the compiled module boundary at fixture setup, after the build.
    const { createNestApp } = await import('../dist/app.js');
    const { parseAppConfig } = await import('../dist/config/app-config.js');
    const { hashPassword, SCRYPT_N, SCRYPT_R, SCRYPT_P } = await import('../dist/auth/password-hash.js');
    const { createJsonAdminCredentialRepository } = await import('../dist/persistence/repositories/admin-credential.repository.js');
    const root = await mkdtemp(join(tmpdir(), 'flexserver-e2e-'));
    let app: NestExpressApplication | undefined;
    try {
      const dataDir = join(root, 'data');
      const config = parseAppConfig({
        APP_MODE: 'local',
        STORAGE_DRIVER: 'json',
        DATA_DIR: dataDir,
        PRIVATE_DIR: join(root, 'private'),
        LOCAL_AGENT_ENABLED: 'false',
        ENABLE_WEB_TERMINAL: 'false',
        ALLOW_PRIVATE_NETWORK_TARGETS: 'false',
        DASHBOARD_SESSION_SECRET: randomBytes(32).toString('hex'),
        DASHBOARD_COOKIE_SECURE: 'false',
      });
      const password = randomBytes(24).toString('hex');
      await createJsonAdminCredentialRepository(join(dataDir, 'admin-credential.json')).upsert({
        passwordHash: hashPassword(password),
        passwordAlgorithm: 'scrypt',
        passwordParams: JSON.stringify({ N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }),
      });
      app = await createNestApp({ config });
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      if (!address || typeof address === 'string') {
        throw new Error('E2E backend did not bind a TCP address');
      }
      await use({ baseURL: `http://127.0.0.1:${address.port}`, password });
    } finally {
      try {
        await app?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, { scope: 'worker', timeout: 60_000 }],
  baseURL: async ({ app }, use) => {
    await use(app.baseURL);
  },
});

export { expect };
