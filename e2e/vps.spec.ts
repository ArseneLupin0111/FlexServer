import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';

test('creates a VPS and preserves its connection details after reload', async ({ page, app }) => {
  const suffix = randomUUID();
  const vps = {
    displayName: `E2E Singapore ${suffix}`,
    name: `e2e-sgp-${suffix}`,
    host: '203.0.113.20',
    port: 2222,
    username: 'e2e-admin',
  };

  await page.goto('/vps');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(app.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open local admin account menu', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'New VPS', exact: true }).first().click();
  await expect(page).toHaveURL(`${app.baseURL}/vps/new`);
  await page.getByLabel('Display name', { exact: true }).fill(vps.displayName);
  await page.getByLabel('Name', { exact: true }).fill(vps.name);
  await page.getByLabel('Host / IP', { exact: true }).fill(vps.host);
  await page.getByLabel('Port', { exact: true }).fill(String(vps.port));
  await page.getByLabel('Username', { exact: true }).fill(vps.username);
  // A blank optional password creates inventory only, without remote key provisioning.
  await expect(page.getByLabel('Optional password', { exact: true })).toBeEmpty();
  const creation = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/vps' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create VPS', exact: true }).click();
  const response = await creation;
  expect(response.status()).toBe(201);
  const { data: created } = await response.json();
  expect(created).toMatchObject(vps);
  expect(created.id).toEqual(expect.any(String));
  await expect(page).toHaveURL(`${app.baseURL}/vps/${encodeURIComponent(created.id)}`);

  await page.reload();
  await expect(page).toHaveURL(`${app.baseURL}/vps/${encodeURIComponent(created.id)}`);
  const detail = await page.request.get(`/api/vps/${encodeURIComponent(created.id)}`);
  expect(detail.status()).toBe(200);
  expect((await detail.json()).data).toMatchObject({ id: created.id, ...vps });

  await page.goto('/vps');
  const manage = page.getByRole('link', { name: `Manage ${vps.displayName}`, exact: true });
  await expect(manage).toBeVisible();
  await expect(manage).toHaveAttribute('href', `/vps/${created.id}`);
  const list = await page.request.get('/api/vps');
  expect(list.status()).toBe(200);
  expect((await list.json()).data.filter((record: { id: string }) => record.id === created.id))
    .toEqual([expect.objectContaining(vps)]);
});
