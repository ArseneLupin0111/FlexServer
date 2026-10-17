import { request as apiRequest } from '@playwright/test';
import { test, expect } from './fixtures';

test('requires authentication', async ({ page }) => {
  await page.goto('/vps');
  const login = page.getByRole('heading', { name: 'Đăng nhập FlexServer', exact: true });
  await expect(login).toBeVisible();
  await expect(page.getByLabel('Mật khẩu', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/auth/me')).json()).data).toMatchObject({
    authRequired: true, authenticated: false,
  });
  expect((await page.request.get('/api/dashboard')).status()).toBe(401);
  await page.reload();
  await expect(login).toBeVisible();
});

test('rejects invalid password', async ({ page }) => {
  await page.goto('/vps');
  const password = page.getByLabel('Mật khẩu', { exact: true });
  await password.fill('invalid-e2e-password');
  const response = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  expect((await response).status()).toBe(401);
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('heading', { name: 'Đăng nhập FlexServer', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/auth/me')).json()).data.authenticated).toBe(false);
});

test('persists and revokes session', async ({ page, app }) => {
  await page.goto('/vps');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(app.password);
  const loginResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  expect((await loginResponse).ok()).toBe(true);
  const account = page.getByRole('button', { name: 'Open local admin account menu', exact: true });
  await expect(account).toBeVisible();
  expect((await (await page.request.get('/api/auth/me')).json()).data.authenticated).toBe(true);
  const dashboard = await page.request.get('/api/dashboard');
  expect(dashboard.status()).toBe(200);
  expect((await dashboard.json()).data.mode).toBe('local');
  await page.reload();
  await expect(account).toBeVisible();
  expect((await (await page.request.get('/api/auth/me')).json()).data.authenticated).toBe(true);

  const cookies = await page.context().cookies(app.baseURL);
  await account.click();
  const logoutResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/auth/logout' && response.request().method() === 'POST');
  await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
  expect((await logoutResponse).ok()).toBe(true);
  const login = page.getByRole('heading', { name: 'Đăng nhập FlexServer', exact: true });
  await expect(login).toBeVisible();
  expect((await (await page.request.get('/api/auth/me')).json()).data.authenticated).toBe(false);
  expect((await page.request.get('/api/dashboard')).status()).toBe(401);
  await page.reload();
  await expect(login).toBeVisible();

  const revokedSession = await apiRequest.newContext({
    baseURL: app.baseURL,
    extraHTTPHeaders: { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') },
  });
  try {
    expect((await revokedSession.get('/api/dashboard')).status()).toBe(401);
  } finally {
    await revokedSession.dispose();
  }
});
