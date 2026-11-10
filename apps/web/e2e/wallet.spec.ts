import { expect, test, type Page } from '@playwright/test';

const ANVIL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const ANVIL_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PASSWORD = 'Correct-Horse-42';

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** In-app navigation. A full reload intentionally locks the wallet (keys live only in worker memory). */
async function openFromNav(page: Page, name: 'Settings' | 'Home') {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).filter({ visible: true }).first().click();
}

async function useAnvilRpc(page: Page) {
  await openFromNav(page, 'Settings');
  const row = page.getByRole('button', { name: /Localhost \(Anvil\)/ });
  // The row is server-rendered, so the click can land before React has hydrated and
  // go nowhere. Retry until the sheet actually opens instead of timing out blind.
  await expect(async () => {
    await row.click();
    await page.getByLabel('RPC URL').waitFor({ state: 'visible', timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByLabel('RPC URL').fill(ANVIL);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Custom RPC saved')).toBeVisible();
  await openFromNav(page, 'Home');
  await selectAnvil(page);
}

/** The wallet defaults to Sepolia; local chains are always an explicit choice. */
async function selectAnvil(page: Page) {
  await page.getByRole('button', { name: /^Network: .*Change network$/ }).click();
  await page.getByRole('option', { name: /Localhost \(Anvil\)/ }).click();
  await expect(page.getByRole('button', { name: /^Network: Localhost \(Anvil\)/ })).toBeVisible();
}

async function restore(page: Page, phrase: string) {
  await page.goto('/onboarding');
  await page.getByRole('link', { name: 'I have a recovery phrase' }).click();
  await page.getByLabel('Word 1', { exact: true }).fill(phrase);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Import wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet is ready' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open wallet' }).click();
}

async function unlock(page: Page) {
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

test.describe('onboarding → receive → send', () => {
  test('creates a wallet, verifies backup, receives and sends ETH on Anvil', async ({ page }) => {
    const cspViolations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome to QD Wallet' })).toBeVisible();
    await page.getByRole('link', { name: 'Create a new wallet' }).click();

    // Security explainer
    await page.getByLabel(/cannot recover my recovery phrase/).check();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Password
    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create wallet' }).click();

    // Reveal + read phrase
    await expect(page.getByRole('heading', { name: 'Write down your recovery phrase' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Tap to reveal/ }).click();
    const words = (await page.locator('ol li span.font-mono').allTextContents()).map((w) => w.trim());
    expect(words).toHaveLength(12);
    await page.getByRole('button', { name: 'I wrote it down' }).click();

    // Verify three positions
    await expect(page.getByRole('heading', { name: 'Confirm your recovery phrase' })).toBeVisible();
    await expect(page.locator('legend')).toHaveCount(3);
    const legends = await page.locator('legend').allTextContents();
    for (const legend of legends) {
      const n = Number(/#(\d+)/.exec(legend)![1]);
      await page.locator('fieldset', { hasText: legend }).getByRole('button', { name: words[n - 1]!, exact: true }).click();
    }
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: 'Your wallet is ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Open wallet' }).click();
    await expect(page).toHaveURL(/\/home/);

    // Point Anvil at the local node (backend is optional for this test).
    await useAnvilRpc(page);
    await openFromNav(page, 'Home');

    // Receive: read our address from the receive sheet.
    await page.getByRole('button', { name: 'Receive' }).click();
    const address = (await page.getByRole('dialog').locator('[aria-label^="0x"]').first().getAttribute('aria-label'))!;
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await page.keyboard.press('Escape');

    // Fund from Anvil's unlocked account 0.
    await rpc('eth_sendTransaction', [{ from: ANVIL_ACCOUNT_0, to: address, value: '0xde0b6b3a7640000' }]); // 1 ETH
    await page.getByRole('button', { name: 'Refresh balances' }).click();
    await expect(page.getByLabel('Total balance')).toContainText(/1(\.0+)? ETH|\$/, { timeout: 20_000 });

    // Send 0.1 ETH
    await page.getByRole('link', { name: 'Send' }).click();
    await page.getByRole('button', { name: /^ETH/ }).click();
    await page.getByLabel('Recipient address').fill(RECIPIENT.toLowerCase());
    await expect(page.getByText('New address')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Amount in ETH').fill('0.1');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Review shows every required field (spec §16.4)
    for (const label of ['From', 'To', 'Asset', 'Network', 'Network fee', 'Total']) {
      await expect(page.locator('dt', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
    }
    await expect(page.getByText('0.1 ETH').first()).toBeVisible();
    const before = BigInt((await rpc('eth_getBalance', [RECIPIENT, 'latest'])) as string);
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: 'Transaction confirmed' })).toBeVisible({ timeout: 30_000 });
    const after = BigInt((await rpc('eth_getBalance', [RECIPIENT, 'latest'])) as string);
    expect(after - before).toBe(100_000_000_000_000_000n);

    // Appears in activity
    await page.getByRole('button', { name: 'View activity' }).click();
    await expect(page.getByText('Sent ETH').first()).toBeVisible();

    expect(cspViolations).toEqual([]);
  });
});

test.describe('import & unlock', () => {
  test('imports a phrase, discovers accounts, locks and unlocks', async ({ page }) => {
    await page.goto('/onboarding');
    await page.getByRole('link', { name: 'I have a recovery phrase' }).click();
    await page.getByLabel('Word 1', { exact: true }).fill(ANVIL_MNEMONIC);
    await expect(page.getByLabel('Word 12')).toHaveValue('junk');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Import wallet' }).click();
    await expect(page.getByRole('heading', { name: 'Your wallet is ready' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Open wallet' }).click();

    await expect(page.getByRole('button', { name: /Account: Account 1/ })).toBeVisible();
    await page.getByRole('button', { name: /Account: Account 1/ }).click();
    await expect(page.getByRole('dialog', { name: 'Accounts' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Lock, wrong password, then unlock
    await page.getByRole('button', { name: 'Wallet menu' }).click();
    await page.getByRole('menuitem', { name: 'Lock wallet' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('Incorrect password')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  });

  test('restores the phrase’s own accounts, adds HD accounts, and keeps them across reloads', async ({ page }) => {
    await restore(page, ANVIL_MNEMONIC);
    const header = page.locator('header');
    // Restored wallet = the phrase's index-0 address, on Sepolia (never silently moved to Anvil).
    await expect(header.getByText(short(ANVIL_ACCOUNT_0))).toBeVisible();
    await expect(page.getByRole('button', { name: /^Network: Ethereum Sepolia/ })).toBeVisible();

    // Add account derives index 1 of the same phrase and selects it; a double click adds one account only.
    await page.getByRole('button', { name: /Account: Account 1/ }).click();
    await page.getByRole('button', { name: 'Add account', exact: true }).dblclick();
    await expect(page.getByText('Account 2 created')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /Account: Account 2/ })).toBeVisible();
    await expect(header.getByText(short(RECIPIENT))).toBeVisible();
    await page.getByRole('button', { name: /Account: Account 2/ }).click();
    const accounts = page.getByRole('dialog', { name: 'Accounts' });
    await expect(accounts.getByRole('listitem')).toHaveCount(2);

    // Switching updates the header and account details.
    await accounts.getByRole('button', { name: /Account 1/ }).first().click();
    await expect(page.getByRole('button', { name: /Account: Account 1/ })).toBeVisible();
    await page.getByRole('button', { name: 'Wallet menu' }).click();
    await page.getByRole('menuitem', { name: 'Account details' }).click();
    await expect(page.getByText("m/44'/60'/0'/0/0")).toBeVisible();
    await page.keyboard.press('Escape');

    // A reload locks the wallet; accounts persist and are re-verified against the vault on unlock.
    await page.reload();
    await unlock(page);
    await page.getByRole('button', { name: /Account: Account 1/ }).click();
    await expect(page.getByRole('dialog', { name: 'Accounts' }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('dialog', { name: 'Accounts' }).getByText(short(RECIPIENT))).toBeVisible();
  });

  test('replaces stored account metadata that does not match the vault', async ({ page }) => {
    await restore(page, ANVIL_MNEMONIC);
    await expect(page.locator('header').getByText(short(ANVIL_ACCOUNT_0))).toBeVisible();
    // Corrupt the non-secret metadata: claim account 0 is some other address.
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('qd-meta')!);
      raw.state.accounts[0].address = '0x000000000000000000000000000000000000dEaD';
      localStorage.setItem('qd-meta', JSON.stringify(raw));
    });
    await page.reload();
    await unlock(page);
    await expect(page.getByText('Accounts reloaded from your wallet')).toBeVisible();
    await expect(page.locator('header').getByText(short(ANVIL_ACCOUNT_0))).toBeVisible();
  });

  test('accepts 15-word phrases', async ({ page }) => {
    await page.goto('/onboarding/import');
    // Synthetic fixture (fixed entropy 0x7f…), not a real wallet.
    await page.getByLabel('Word 1', { exact: true }).fill('legal winner thank year wave sausage worth useful legal winner thank year wave sausage wise');
    await expect(page.getByLabel('Word 15', { exact: true })).toHaveValue('wise');
    await expect(page.getByLabel('Word 16', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('rejects an invalid recovery phrase locally', async ({ page }) => {
    await page.goto('/onboarding/import');
    await page.getByLabel('Word 1', { exact: true }).fill(ANVIL_MNEMONIC.replace('junk', 'test'));
    await expect(page.getByText(/isn’t a valid recovery phrase/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});

const API = process.env.E2E_API_URL;

test.describe('full stack through wallet-api', () => {
  test.skip(!API, 'set E2E_API_URL to run against a live wallet-api');

  test('authenticates the device, proxies RPC, registers addresses and tracks a send', async ({ page }) => {
    await page.goto('/onboarding/import');
    await page.getByLabel('Word 1', { exact: true }).fill(ANVIL_MNEMONIC);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Import wallet' }).click();
    await page.getByRole('button', { name: 'Open wallet' }).click({ timeout: 30_000 });
    await selectAnvil(page);

    // Balance comes through the authenticated proxy (no custom RPC configured) and is valued in USD.
    await expect(page.getByLabel('Total balance')).toContainText('$', { timeout: 30_000 });
    await expect(page.getByText(/QD services are unreachable/)).toHaveCount(0);

    await page.getByRole('link', { name: 'Send' }).click();
    await page.getByRole('button', { name: /^ETH/ }).click();
    await page.getByLabel('Recipient address').fill('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Amount in ETH').fill('0.05');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: 'Transaction confirmed' })).toBeVisible({ timeout: 30_000 });

    // Device + security events are served by the backend.
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Wallet menu' }).click();
    await page.getByRole('menuitem', { name: 'Security & privacy' }).click();
    // Exact: the page also carries the subtitle "Unlocks QD Wallet on this device."
    await expect(page.getByText('This device', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('New device registered')).toBeVisible();
  });
});

test('serves strict security headers', async ({ request }) => {
  const res = await request.get('/onboarding');
  const csp = res.headers()['content-security-policy']!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toMatch(/script-src 'self'( 'sha256-[^']+')+/);
  expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
});
