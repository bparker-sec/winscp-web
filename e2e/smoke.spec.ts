import { test, expect } from '@playwright/test';

test('boots with the Skiff shell and OneDrive connect affordance', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Skiff');
  await expect(page.getByText('Skiff').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /connect onedrive/i }).first()).toBeVisible();
});

test('connect dialog opens with only SFTP + FTP in the protocol picker', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /new connection/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const protocol = dialog.getByLabel('Protocol');
  await expect(protocol).toBeVisible();
  const options = await protocol.locator('option').allTextContents();
  expect(options).toHaveLength(2);
  // Switching to FTP hides the SSH key auth option.
  await protocol.selectOption('ftp');
  await expect(dialog.getByText(/private key/i)).toHaveCount(0);
});

test('settings dialog opens and the theme toggle persists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^settings$/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/transfer speed/i)).toBeVisible();
  await dialog.getByRole('button', { name: /close/i }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: /toggle light\/dark/i }).click();
  const theme = await page.evaluate(() => localStorage.getItem('winscp-theme'));
  expect(theme).toMatch(/dark|light/);
});
