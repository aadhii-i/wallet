import { expect, test } from '@playwright/test';

/**
 * The Activity screen on a chain whose history comes from the backend's history
 * provider (Sepolia/Alchemy), not from the local tracker.
 *
 * Provider items used to reach the UI with `flags: null` because a nil Go slice
 * marshals to JSON null while openapi.yaml declares the array required, and the
 * list dereferences it. That crashed the screen. This test keeps both halves
 * honest: it asserts on the literal response body the server sent, then on the
 * rendered screen.
 */
const MNEMONIC = 'test test test test test test test test test test test junk';
const PASSWORD = 'Correct-Horse-42';

test('renders Ethereum Sepolia history served by wallet-api', async ({ page }) => {
  test.setTimeout(150_000);

  await page.goto('/onboarding/import');
  await page.getByLabel('Word 1', { exact: true }).fill(MNEMONIC);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Import wallet' }).click();
  await page.getByRole('button', { name: 'Open wallet' }).click({ timeout: 30_000 });

  // Switch to the chain with a real history provider.
  await page.getByRole('button', { name: /Network: / }).click();
  await page.getByRole('option', { name: /Ethereum Sepolia/ }).click();

  // Pick the account that holds Sepolia history: m/44'/60'/0'/0/1 of the Anvil
  // test phrase is 0x7099…79C8, which the Alchemy faucet funded, so its transfers
  // come from the backend's history provider rather than the local tracker.
  // Account discovery on the new network has to find it first, hence the long wait.
  await page.getByRole('button', { name: /Account: / }).click();
  const funded = page.getByRole('dialog', { name: 'Accounts' }).getByRole('button', { name: /0x7099/ }).first();
  await expect(funded).toBeVisible({ timeout: 60_000 });
  await funded.click();
  await page.keyboard.press('Escape');

  await expect(page.getByLabel('Total balance')).toContainText('SepoliaETH', { timeout: 40_000 });

  type ActivityBody = { url: string; status: number; items: Array<{ flags?: unknown }> };
  const bodies: ActivityBody[] = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/activity?')) return;
    const json = (await res.json().catch(() => null)) as { items?: ActivityBody['items'] } | null;
    bodies.push({ url: res.url(), status: res.status(), items: json?.items ?? [] });
  });

  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({ timeout: 40_000 });

  // Switching accounts aborts the previous query, and an aborted upstream fetch
  // answers 200 with nothing in it, so wait for a body that actually carried
  // history rather than the first response to arrive.
  await expect
    .poll(() => bodies.filter((b) => b.items.length > 0).length, { timeout: 60_000, message: `bodies: ${JSON.stringify(bodies.map((b) => [b.status, b.items.length]))}` })
    .toBeGreaterThan(0);

  for (const body of bodies.filter((b) => b.items.length > 0)) {
    for (const item of body.items) {
      expect(Array.isArray(item.flags), `flags must serialise as an array, got ${JSON.stringify(item.flags)}`).toBe(true);
    }
  }

  // The screen itself: no error boundary, and the transfers are listed.
  await expect(page.getByText(/Something went wrong/)).toHaveCount(0);
  await expect(page.locator('main').first()).toContainText(/ETH|USDC|Sent|Received|Send/i);
  await page.screenshot({ path: 'test-results/screens/sepolia-activity.png', fullPage: false });
});
