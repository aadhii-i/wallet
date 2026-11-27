import { expect, test, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PASSWORD = 'Correct-Horse-42';
// Published development fixture. No public-network funding or transfers.
const PHRASE = 'test test test test test test test test test test test junk';

const modeSwitch = (page: Page) => page.getByRole('navigation', { name: 'Wallet type', exact: true });
const mainLink = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main', exact: true })
    .getByRole('link', { name, exact: true })
    .filter({ visible: true })
    .first();

async function restore(page: Page) {
  await page.goto('/onboarding/import');
  await page.getByLabel('Word 1', { exact: true }).fill(PHRASE);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Import wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Open wallet', exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(modeSwitch(page)).toBeVisible();
}

async function individualContext(page: Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('qd-meta')!).state;
    return {
      selectedIndex: state.selectedIndex,
      networkId: state.networkId,
      btcAddressType: state.btcAddressType,
      customRpc: state.customRpc,
      hideBalances: state.hideBalances,
      accounts: state.accounts.map((a: { index: number; name: string; address: string }) => ({
        index: a.index,
        name: a.name,
        address: a.address,
      })),
    };
  });
}

async function createGroup(page: Page, name: string) {
  const form = page.getByRole('form', {
    name: 'Create shared wallet',
    exact: true,
  });
  await form.getByLabel('Wallet name', { exact: true }).fill(name);
  await form.getByLabel('Your display name', { exact: true }).fill('UI reviewer');
  await form.getByRole('button', { name: 'Create shared wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

for (const viewport of [
  { name: 'laptop', width: 1440, height: 1000 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'small phone', width: 320, height: 740 },
]) {
  test(`wallet modes preserve individual state on ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await restore(page);
      await expect(
        modeSwitch(page).getByRole('link', {
          name: 'Individual Wallet',
          exact: true,
        }),
      ).toHaveAttribute('aria-current', 'page');
      const initial = await individualContext(page);
      const addedIndex = Math.max(...initial.accounts.map((a: { index: number }) => a.index)) + 1;
      await page.getByRole('button', { name: /^Account: .*Switch account$/ }).click();
      await page.getByRole('button', { name: 'Add account', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Accounts', exact: true })
        .getByRole('button')
        .filter({ hasText: `Account ${addedIndex + 1}` })
        .first()
        .click();
      await page.getByRole('button', { name: 'Hide balances', exact: true }).click();
      await mainLink(page, 'Assets').click();
      const before = await individualContext(page);
      expect(before.selectedIndex).toBe(addedIndex);
      await modeSwitch(page).getByRole('link', { name: 'Shared Wallet', exact: true }).click();
      await expect(
        modeSwitch(page).getByRole('link', {
          name: 'Shared Wallet',
          exact: true,
        }),
      ).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('form', { name: 'Create shared wallet', exact: true })).toBeVisible();
      await expect(
        page.getByRole('form', {
          name: 'Join with invitation code',
          exact: true,
        }),
      ).toBeVisible();
      await createGroup(page, 'Family UI wallet');
      await page.getByRole('button', { name: 'All shared wallets', exact: true }).click();
      await page.getByText('Create or join another shared wallet', { exact: true }).click();
      await createGroup(page, 'Team UI wallet');
      await page
        .getByRole('combobox', { name: 'Shared wallet group', exact: true })
        .selectOption({ label: 'Family UI wallet' });
      await expect(page.getByRole('heading', { name: 'Family UI wallet', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Network: .*Change network$/ })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Your assets', exact: true })).toBeVisible();
      await expect(
        page.getByRole('region', {
          name: 'Threshold key',
          includeHidden: true,
        }),
      ).toBeHidden();
      await page.getByRole('button', { name: 'Open Bitcoin', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Shared Bitcoin', exact: true })).toBeVisible();
      await expect(
        page.getByRole('region', {
          name: 'Shared Hedera',
          includeHidden: true,
        }),
      ).toBeHidden();
      await expect(page.getByRole('combobox', { name: 'Choose asset', exact: true })).toHaveValue('bitcoin');
      await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
      await page.getByLabel('Account name', { exact: true }).fill('Trip funds');
      await page.getByRole('button', { name: 'Add account', exact: true }).click();
      await expect(page.getByRole('list', { name: 'Shared accounts' })).toContainText('Trip funds');
      await mainLink(page, 'Assets').click();
      await expect(page.getByRole('heading', { name: 'Balances & receive', exact: true })).toBeInViewport();
      await mainLink(page, 'Requests').click();
      await expect(page.getByRole('heading', { name: 'Payment requests', exact: true })).toBeInViewport();
      const asset = page.getByRole('combobox', {
        name: 'Choose asset',
        exact: true,
      });
      await asset.selectOption('evm');
      const request = page.getByRole('form', {
        name: 'Payment request',
        exact: true,
      });
      await request.getByLabel('Recipient address', { exact: true }).fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
      await request.getByLabel('Amount (ETH)', { exact: true }).fill('0.1');
      await request.getByLabel('Network', { exact: true }).selectOption('84532');
      await request.locator('summary').filter({ hasText: 'Advanced settings' }).click();
      await request.getByLabel('Data (optional)', { exact: true }).fill('0xdeadbeef');
      await request.getByRole('button', { name: 'Review payment', exact: true }).click();
      const review = page.getByRole('region', { name: 'Review payment', exact: true });
      await expect(review.getByText('0xdeadbeef', { exact: true })).toBeVisible();
      await expect(review.getByText('Base Sepolia', { exact: true })).toBeVisible();
      await expect(review.getByText(/Limit 21000 gas/)).toBeVisible();
      await review.getByRole('button', { name: 'Back', exact: true }).click();
      await asset.selectOption('bitcoin');
      await expect(request).toBeHidden();
      await asset.selectOption('evm');
      await expect(request.getByLabel('Amount (ETH)', { exact: true })).toHaveValue('0.1');
      await expect(request.getByLabel('Network', { exact: true })).toHaveValue('84532');
      await page.goBack();
      await expect(asset).toHaveValue('bitcoin');
      await page.goForward();
      await expect(asset).toHaveValue('evm');
      await expect(request.getByLabel('Amount (ETH)', { exact: true })).toHaveValue('0.1');
      await request.getByRole('button', { name: 'Review payment', exact: true }).click();
      await page.getByRole('button', { name: 'Create payment request', exact: true }).click();
      const queued = page.getByRole('article', { name: /^Proposal: 0\.1 ETH to / });
      await expect(queued.getByText('0xdeadbeef', { exact: true })).toBeVisible();
      await expect(queued.getByText(/Limit 21000 gas/)).toBeVisible();
      await expect(queued.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
      // Do not approve: this checks the review of a local, unsigned request.
      await mainLink(page, 'Settings').click();
      await expect(page).toHaveURL(/\/settings\?mode=shared/);
      await expect(
        modeSwitch(page).getByRole('link', {
          name: 'Shared Wallet',
          exact: true,
        }),
      ).toHaveAttribute('aria-current', 'page');
      await modeSwitch(page).getByRole('link', { name: 'Individual Wallet', exact: true }).click();
      await expect(page).toHaveURL(/\/assets$/);
      expect(await individualContext(page)).toEqual(before);
      await mainLink(page, 'Home').click();
      await page.getByRole('button', { name: 'Receive', exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('img', { name: /QR code/ })).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('link', { name: 'Send', exact: true }).click();
      await expect(
        modeSwitch(page).getByRole('link', {
          name: 'Shared Wallet',
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(modeSwitch(page).locator('[aria-disabled="true"]')).toContainText('Shared Wallet');
      await modeSwitch(page).getByRole('link', { name: 'Individual Wallet', exact: true }).click();
      await expect(page).toHaveURL(/\/send/);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await modeSwitch(page).getByRole('link', { name: 'Shared Wallet', exact: true }).click();
      await expect(
        page.getByRole('combobox', {
          name: 'Shared wallet group',
          exact: true,
        }),
      ).toHaveValue(/.+/);
      await expect(page.getByRole('heading', { name: 'Family UI wallet', exact: true })).toBeVisible();
      expect(await individualContext(page)).toEqual(before);
      await expect(modeSwitch(page)).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({
        path: join(tmpdir(), `qd-wallet-mode-${viewport.name.replace(/ /g, '-')}.png`),
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
