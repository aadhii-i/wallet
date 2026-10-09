import { expect, test } from '@playwright/test';

/** Visual review captures (not assertions). Run with SCREENSHOTS=1. */
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1');

const MNEMONIC = 'test test test test test test test test test test test junk';
const PW = 'Correct-Horse-42';

for (const scheme of ['dark', 'light'] as const) {
  test(`screens ${scheme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    const shot = (name: string) => page.screenshot({ path: `test-results/screens/${info.project.name}-${scheme}-${name}.png` });
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: 'Welcome to QD Wallet' })).toBeVisible();
    await shot('01-welcome');
    await page.getByRole('link', { name: 'I have a recovery phrase' }).click();
    await page.getByLabel('Word 1', { exact: true }).fill(MNEMONIC);
    await shot('02-import');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('New password', { exact: true }).fill(PW);
    await page.getByLabel('Confirm password').fill(PW);
    await page.getByRole('button', { name: 'Import wallet' }).click();
    await page.getByRole('button', { name: 'Open wallet' }).click({ timeout: 30_000 });
    await expect(page.getByLabel('Total balance')).toContainText('$', { timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot('03-home');
    await page.getByRole('button', { name: /Account: / }).click();
    await page.waitForTimeout(500);
    await shot('04-accounts');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Network: / }).click();
    await page.waitForTimeout(500);
    await shot('05-networks');
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Send' }).click();
    await page.getByRole('button', { name: /^ETH/ }).click();
    await page.getByLabel('Recipient address').fill('0x70990000000000000000000000000000000079c8');
    await shot('06-recipient-poison');
    await page.getByLabel('Recipient address').fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Amount in ETH').fill('1.25');
    await shot('07-amount');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeEnabled({ timeout: 20_000 });
    await shot('08-review');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: 'Transaction confirmed' })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await shot('09-confirmed');
    await page.getByRole('button', { name: 'View activity' }).click();
    await page.waitForTimeout(600);
    await shot('10-activity');
  });
}
