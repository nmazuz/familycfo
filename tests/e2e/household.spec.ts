import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // No third-party services in E2E: the real browser, Vite proxy, API and SQLite run locally.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue() : route.abort();
  });
});

test('cash expense is persisted, editable and deletable through the Hebrew UI', async ({ page, request }) => {
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'הוספת הוצאה', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'הוסף', exact: true })).toBeDisabled();
  await dialog.locator('input[type=number]').first().fill('123');
  await dialog.locator('input[type=date]').fill(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()));
  await dialog.getByPlaceholder('למשל: עוזרת בית, בייביסיטר, שוק').fill('Synthetic E2E purchase');
  await dialog.getByRole('button', { name: 'הוסף', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Synthetic E2E purchase' });
  await expect(row).toBeVisible();
  await page.reload(); await expect(row).toBeVisible();
  const result = await request.get('/api/transactions?search=Synthetic%20E2E%20purchase');
  expect(result.ok()).toBeTruthy(); expect((await result.json()).totals.spend).toBe(123);
  await row.getByRole('button', { name: 'עריכה', exact: true }).click();
  await dialog.locator('input[type=number]').first().fill('80');
  await dialog.getByRole('button', { name: 'שמור', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await (await request.get('/api/transactions?search=Synthetic%20E2E%20purchase')).json()).totals.spend).toBe(80);
  await row.getByRole('button', { name: 'עריכה', exact: true }).click();
  await dialog.getByRole('button', { name: 'מחיקה', exact: true }).click();
  await dialog.getByRole('button', { name: 'בטוח? למחוק', exact: true }).click();
  await expect(row).toHaveCount(0);
});

test('settings edit survives a reload and reaches the database through Vite proxy', async ({ page, request }) => {
  await page.goto('/settings');
  const input = page.getByLabel('יום תחילת מחזור חודשי', { exact: false });
  await input.fill('10'); await input.blur();
  await expect.poll(async () => (await (await request.get('/api/meta')).json()).settings.cycle_start_day).toBe('10');
  await page.reload(); await expect(input).toHaveValue('10');
  // Restore the calendar for other tests.
  await input.fill('1'); await input.blur();
  await expect.poll(async () => (await (await request.get('/api/meta')).json()).settings.cycle_start_day).toBe('1');
});

test('main screens render a fresh empty household without runtime exceptions', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const path of ['/', '/transactions', '/budgets', '/fixed', '/pension', '/insurance', '/settings']) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible();
  }
  expect(errors).toEqual([]);
  await page.goto('/transactions');
  await page.screenshot({ path: 'test-results/empty-household.png', fullPage: true });
});
