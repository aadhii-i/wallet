import { expect, test } from '@playwright/test';

/**
 * Batch 4: the three rollup testnets are selectable and answer through
 * wallet-api's RPC proxy.
 *
 * Two halves, because the two failure modes are different. The selector list is
 * the gate (ADR 0015 + `GET /v1/networks`): a chain appears only if the server
 * has an upstream for it, and a mainnet with no upstream must stay hidden. The
 * block number is the live proof: it comes from an `eth_getBlockByNumber` over
 * the proxy, so it only renders if the upstream answered *and* passed its
 * `eth_chainId` check — a URL wired under the wrong chain id is disabled by the
 * pool and leaves the header without a block number.
 */
const MNEMONIC = 'test test test test test test test test test test test junk';
const PASSWORD = 'Correct-Horse-42';

const SELECTABLE = ['Ethereum Sepolia', 'Base Sepolia', 'Arbitrum Sepolia', 'Polygon Amoy', 'Localhost (Anvil)'];
const NEW_TESTNETS = ['Base Sepolia', 'Arbitrum Sepolia', 'Polygon Amoy'];

/**
 * An option's accessible name is "<chain name> <symbol> · no real value" — the
 * coloured initial is aria-hidden, so it is not part of the name. Anchoring at
 * the start keeps `Base` from matching `Base Sepolia`.
 */
function optionFor(page: import('@playwright/test').Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByRole('option', { name: new RegExp(`^${escaped}\\s`) });
}

test('offers exactly the proxied chains and reads a live block from each new testnet', async ({ page }) => {
  test.setTimeout(300_000);

  await page.goto('/onboarding/import');
  await page.getByLabel('Word 1', { exact: true }).fill(MNEMONIC);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Import wallet' }).click();
  await page.getByRole('button', { name: 'Open wallet' }).click({ timeout: 30_000 });

  await page.getByRole('button', { name: /Network: / }).click();
  // The count is the other half of the assertion: every proxied chain is listed
  // and nothing else is, so a mainnet without an upstream cannot leak back in.
  await expect(page.getByRole('option')).toHaveCount(SELECTABLE.length);
  for (const name of SELECTABLE) {
    await expect(optionFor(page, name)).toBeVisible();
  }
  // Close the sheet: while it is open the page behind is inert, so the header
  // trigger is not in the accessibility tree and cannot be clicked again.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);

  for (const name of NEW_TESTNETS) {
    await page.getByRole('button', { name: /Network: / }).click();
    await optionFor(page, name).click();

    await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTitle('Latest block')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/no upstream|unreachable|Can.t reach/i)).toHaveCount(0);
  }

  await page.screenshot({ path: 'test-results/screens/multi-network.png', fullPage: false });
});
