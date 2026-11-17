import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * ACCEPTANCE: three independent browsers, a 2-of-3 shared wallet, real
 * Threshold Raccoon key generation, ADHIL and NENA approve sending 0.02 ETH,
 * their browsers run the networked three-round signing protocol in their key
 * workers, the API combines and verifies the signature, and its relayer
 * executes it through the QdAccount contract on Anvil. Run with
 * `make e2e-shared` (the config starts Anvil, the API and the static web app).
 */

const PASSWORD = 'Correct-Horse-42';
const RECIPIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const WALLET_NAME = 'Acceptance vault';
const ANVIL = process.env.QD_E2E_ANVIL_URL ?? 'http://127.0.0.1:8547';

async function anvil<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const balance = async (addr: string) => BigInt(await anvil<string>('eth_getBalance', [addr, 'latest']));

async function createLocalWallet(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Create a new wallet' }).click();
  await page.getByLabel(/cannot recover my recovery phrase/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Write down your recovery phrase' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Tap to reveal/ }).click();
  const words = (await page.locator('ol li span.font-mono').allTextContents()).map((w) => w.trim());
  expect(words).toHaveLength(12);
  await page.getByRole('button', { name: 'I wrote it down' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm your recovery phrase' })).toBeVisible();
  await expect(page.locator('legend')).toHaveCount(3);
  for (const legend of await page.locator('legend').allTextContents()) {
    const n = Number(/#(\d+)/.exec(legend)![1]);
    await page.locator('fieldset', { hasText: legend }).getByRole('button', { name: words[n - 1]!, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet is ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Open wallet' }).click();
  await expect(page).toHaveURL(/\/home/);
}

/** Uncaught errors in any participant's page (e.g. the former "chain.data is undefined" crash). */
const pageErrors: string[] = [];

async function newParticipant(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => pageErrors.push(`${page.url()}: ${e.message}`));
  await createLocalWallet(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Shared', exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Shared wallets', level: 1 })).toBeVisible();
  return page;
}

const keyCard = (page: Page): Locator => page.getByRole('region', { name: 'Threshold key' });
const card = (page: Page): Locator => page.getByRole('article', { name: new RegExp(`^Proposal: 0\\.02 ETH to ${RECIPIENT}$`, 'i') });

test('acceptance: ADHIL and NENA sign 0.02 ETH with a 2-of-3 Threshold Raccoon key; executed and confirmed on Anvil', async ({ browser }) => {
  // --- wallet with three independent participants ---
  const adhil = await newParticipant(browser);
  const create = adhil.getByRole('form', { name: 'Create shared wallet' });
  await create.getByLabel('Wallet name').fill(WALLET_NAME);
  await create.getByLabel('Your display name').fill('ADHIL');
  await create.getByRole('button', { name: 'Create shared wallet' }).click();
  await expect(adhil.getByRole('heading', { name: WALLET_NAME })).toBeVisible();
  const joined: Page[] = [];
  for (const name of ['NENA', 'P3']) {
    await adhil.getByLabel('Invitation label').fill(name);
    await adhil.getByRole('button', { name: 'Invite participant' }).click();
    const code = (await adhil.getByLabel('Invitation code', { exact: true }).textContent())!.trim();
    await adhil.getByRole('button', { name: 'Done' }).click();
    const page = await newParticipant(browser);
    const join = page.getByRole('form', { name: 'Join with invitation code' });
    await join.getByLabel('Invitation code', { exact: true }).fill(code);
    await join.getByLabel('Your display name').fill(name);
    await join.getByRole('button', { name: 'Preview invitation' }).click();
    await join.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page.getByRole('heading', { name: WALLET_NAME })).toBeVisible();
    joined.push(page);
  }
  const [nena, p3] = joined as [Page, Page];
  const all = [adhil, nena, p3];
  for (const page of all) await expect(page.getByText('Required approvals: 2', { exact: true })).toBeVisible();

  // --- 2-of-3 key generation (trusted dealer = ADHIL's browser) ---
  await keyCard(adhil).getByRole('button', { name: 'Start key generation' }).click();
  for (const page of all) {
    const k = keyCard(page);
    await expect(k.getByText('Status: Key generation in progress')).toBeVisible();
    await k.getByLabel('Wallet password').fill(PASSWORD);
    await k.getByRole('button', { name: 'Unlock key-share storage' }).click();
    await k.getByRole('button', { name: 'Prepare this device' }).click();
    await expect(k.getByRole('button', { name: 'Prepare this device' })).toHaveCount(0);
  }
  await keyCard(adhil).getByRole('button', { name: 'Generate and distribute shares' }).click();
  for (const page of all) {
    await expect(keyCard(page).getByText('Status: Awaiting participant provisioning')).toBeVisible();
    await keyCard(page).getByRole('button', { name: 'Receive my share' }).click();
  }
  for (const page of all) await expect(keyCard(page).getByText('Status: Key initialized')).toBeVisible();

  // --- shared account: its smart-account address is derived on each device ---
  await adhil.getByLabel('Account name').fill('Treasury');
  await adhil.getByRole('button', { name: 'Add account' }).click();
  await adhil.getByRole('button', { name: 'Derive smart-account address on this device' }).click();
  const addrEl = adhil.getByLabel('Smart account address');
  await expect(addrEl).toBeVisible();
  const address = (await addrEl.textContent())!.trim();
  expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  await nena.getByRole('button', { name: 'Confirm address on this device' }).click();
  for (const page of [adhil, nena]) {
    await expect(page.getByText(/Confirmed by 2 of 3 participant devices · derived and verified on this device/)).toBeVisible();
  }
  await expect(p3.getByLabel('Smart account address')).toHaveText(address);

  // Fund the account on Anvil (from Anvil's unlocked test account #0).
  await anvil('eth_sendTransaction', [{ from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', to: address, value: '0xde0b6b3a7640000' }]);
  // Every participant reads the same balance from the chain (independent profiles, own caches).
  for (const page of all) await expect(page.getByLabel('Account balance')).toHaveText('1 ETH', { timeout: 30_000 });
  const recipientBefore = await balance(RECIPIENT);

  // --- ADHIL proposes 0.02 ETH ---
  const form = adhil.getByRole('form', { name: 'New proposal' });
  await expect(form.getByText(`Sends from smart account ${address}`, { exact: false })).toBeVisible();
  await form.getByLabel('Recipient address').fill(RECIPIENT);
  await form.getByLabel('Amount (ETH)').fill('0.02');
  await form.getByLabel('Network', { exact: true }).selectOption('31337');
  await form.getByRole('button', { name: 'Review proposal' }).click();
  await adhil.getByRole('button', { name: 'Submit proposal' }).click();
  await expect(card(adhil).getByLabel('Proposal status')).toHaveText('Awaiting approvals');
  for (const page of all) await expect(card(page).getByText(/\b(Submitted|Confirmed)\b/)).toHaveCount(0);

  // --- ADHIL and NENA approve: threshold 2/2 ---
  await card(adhil).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(adhil).getByText('1/2 approvals', { exact: true })).toBeVisible();
  await expect(card(nena).getByText('1/2 approvals', { exact: true })).toBeVisible();
  await card(nena).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(nena).getByText('2/2 approvals', { exact: true })).toBeVisible();

  // Selected signers are ADHIL and NENA; P3 sees progress only.
  await expect(card(p3).getByText(/Selected signers: ADHIL \(party 1\), NENA \(party 2\)/)).toBeVisible();
  await expect(card(p3).getByText('This device is taking part automatically')).toHaveCount(0);

  // --- networked signing in both browsers' key workers, verification, execution, receipt ---
  for (const page of all) {
    await expect(card(page).getByLabel('Proposal status')).toHaveText('Confirmed', { timeout: 240_000 });
  }
  for (const page of [adhil, nena]) {
    const c = card(page);
    await expect(c.getByText('Round 1 — commitments (2/2)')).toBeVisible();
    await expect(c.getByText('Round 2 — openings and MACs (2/2)')).toBeVisible();
    await expect(c.getByText('Round 3 — response shares (2/2)')).toBeVisible();
    await expect(c.getByText('Signature generated (combined from the response shares)')).toBeVisible();
    await expect(c.getByText(/Signature verified by the coordinator and on this device/)).toBeVisible();
  }
  const txHash = (await card(adhil).getByLabel('Transaction hash', { exact: true }).textContent())!.trim();
  expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
  await expect(card(adhil).getByText(/Confirmed in block \d+/)).toBeVisible();

  // --- receipt card, built from the chain's receipt; PDF download ---
  const receiptCard = card(adhil).getByRole('region', { name: 'Transaction receipt' });
  await expect(receiptCard.getByText('Status: Confirmed')).toBeVisible({ timeout: 30_000 });
  await expect(receiptCard.getByText(txHash, { exact: true })).toBeVisible();
  await expect(receiptCard.getByText('0.02 ETH', { exact: true })).toBeVisible();
  await expect(receiptCard.getByText('2-of-3', { exact: true })).toBeVisible();
  const [download] = await Promise.all([adhil.waitForEvent('download'), receiptCard.getByRole('button', { name: 'Download PDF receipt' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^qd-wallet-receipt-31337-0x[0-9a-f]{10}\.pdf$/);
  const pdf = await (await download.createReadStream()).toArray();
  const pdfText = Buffer.concat(pdf as Buffer[]).toString('latin1');
  expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
  expect(pdfText.replace(/\) Tj ET\nBT [^(]*\(/g, '')).toContain(txHash);

  // --- the chain agrees ---
  const receipt = await anvil<{ status: string; to: string }>('eth_getTransactionReceipt', [txHash]);
  expect(receipt.status).toBe('0x1');
  expect(receipt.to.toLowerCase()).toBe(address);
  expect(await balance(RECIPIENT)).toBe(recipientBefore + 20_000_000_000_000_000n);
  expect(await balance(address)).toBe(980_000_000_000_000_000n);
  await expect(adhil.getByLabel('Account balance')).toHaveText('0.98 ETH', { timeout: 30_000 });

  // --- Shared → Personal: 0.01 ETH to P3's own personal wallet. Same transaction in both histories. ---
  const p3Address = (await p3.evaluate(() => (JSON.parse(localStorage.getItem('qd-meta')!) as { state: { accounts: { address: string }[] } }).state.accounts[0]!.address)).toLowerCase();
  await expect(form.getByLabel('Nonce')).toHaveValue('1', { timeout: 30_000 });
  await form.getByLabel('Recipient address').fill(p3Address);
  await form.getByLabel('Amount (ETH)').fill('0.01');
  await form.getByLabel('Network', { exact: true }).selectOption('31337');
  await form.getByRole('button', { name: 'Review proposal' }).click();
  await adhil.getByRole('button', { name: 'Submit proposal' }).click();
  const toP3 = (page: Page) => page.getByRole('article', { name: new RegExp(`^Proposal: 0\\.01 ETH to ${p3Address}$`, 'i') });
  await toP3(adhil).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toP3(nena).getByText('1/2 approvals', { exact: true })).toBeVisible();
  await toP3(nena).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toP3(adhil).getByLabel('Proposal status')).toHaveText('Confirmed', { timeout: 240_000 });
  const p3Hash = (await toP3(adhil).getByLabel('Transaction hash', { exact: true }).textContent())!.trim();
  // Shared Wallet History (sender side): Sent 0.01 ETH, the same hash, from the chain index; PDF receipt from the re-verified receipt.
  const history = adhil.getByRole('region', { name: 'Wallet History', exact: true });
  await history.scrollIntoViewIfNeeded();
  const sentEntry = history.getByRole('listitem', { name: `Sent ETH ${p3Hash}` });
  await expect(sentEntry).toBeVisible({ timeout: 60_000 });
  await expect(sentEntry.getByLabel('Amount')).toHaveText('−0.01 ETH');
  await expect(history.getByRole('listitem', { name: `Sent ETH ${txHash}` })).toBeVisible();
  await expect(history.getByRole('listitem', { name: new RegExp('^Received ETH 0x') }).first()).toBeVisible(); // the 1 ETH funding
  await sentEntry.getByRole('button').first().click();
  const details = sentEntry.getByRole('region', { name: 'Transaction details' });
  await expect(details.getByLabel('Transaction hash', { exact: true })).toHaveText(p3Hash);
  const [historyPdf] = await Promise.all([adhil.waitForEvent('download'), details.getByRole('button', { name: 'Download PDF receipt' }).click()]);
  expect(historyPdf.suggestedFilename()).toBe(`qd-wallet-receipt-31337-${p3Hash.slice(0, 12)}.pdf`);
  expect(await balance(p3Address)).toBe(10_000_000_000_000_000n);

  // --- an over-budget proposal: every participant sees why it cannot execute; nothing is sent ---
  await expect(form.getByLabel('Nonce')).toHaveValue('2', { timeout: 30_000 });
  const relayerNonceBefore = await anvil<string>('eth_getTransactionCount', [RELAYER, 'latest']);
  await form.getByLabel('Recipient address').fill(RECIPIENT);
  await form.getByLabel('Amount (ETH)').fill('5');
  await form.getByLabel('Network', { exact: true }).selectOption('31337');
  await form.getByRole('button', { name: 'Review proposal' }).click();
  await adhil.getByRole('button', { name: 'Submit proposal' }).click();
  const big = (page: Page) => page.getByRole('article', { name: new RegExp(`^Proposal: 5 ETH to ${RECIPIENT}$`, 'i') });
  await big(adhil).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(big(nena).getByText('1/2 approvals', { exact: true })).toBeVisible();
  await big(nena).getByRole('button', { name: 'Approve', exact: true }).click();
  for (const page of all) {
    const summary = big(page).getByRole('region', { name: 'Execution summary' });
    await expect(summary.getByLabel('Execution readiness')).toContainText('Blocked', { timeout: 120_000 });
    await expect(summary.getByText(/The shared account is short by 4\.03 ETH/)).toBeVisible({ timeout: 60_000 });
    await expect(summary.getByLabel('Shared account balance')).toHaveText('0.97 ETH');
    await expect(summary.getByLabel('Gas Service Account balance')).toHaveText(/^\d+(\.\d+)? ETH$/);
  }
  await expect(big(adhil).getByLabel('Proposal status')).toHaveText('Insufficient shared-account funds', { timeout: 120_000 });
  expect(await anvil<string>('eth_getTransactionCount', [RELAYER, 'latest'])).toBe(relayerNonceBefore);

  // --- Gas Service Account (Settings → Network & Gas): same account, live balance, recharge detection ---
  await anvil('eth_sendTransaction', [{ from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', to: RELAYER, value: '0x2386f26fc10000' }]); // 0.01 ETH
  for (const page of all) {
    // In-app navigation (a full reload locks the wallet by design).
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).filter({ visible: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    const gas = page.getByLabel('Gas Service Account', { exact: true });
    await expect(gas.getByLabel('Gas service address', { exact: true })).toHaveText(new RegExp(`^${RELAYER}$`, 'i'), { timeout: 30_000 });
    // The displayed balance is the chain's, exactly (nothing more is being spent at this point).
    await expect(gas.getByRole('button', { name: 'Refresh balance' })).toBeEnabled();
    await gas.getByRole('button', { name: 'Refresh balance' }).click();
    await expect(gas.getByLabel('Gas service balance', { exact: true })).toHaveText(`${formatEth(await balance(RELAYER))} ETH`, { timeout: 15_000 });
    await expect(gas.getByLabel('Gas service status', { exact: true })).toHaveText('Healthy');
    // History from receipts: the incoming recharge and the execution's gas payment, linked to its proposal.
    const history = gas.getByRole('region', { name: 'Gas service history' });
    await expect(history.getByText('Recharge (incoming)')).toBeVisible({ timeout: 60_000 });
    // One gas payment per execution: the 0.02 ETH and the 0.01 ETH transfers.
    await expect(history.getByText('Gas: shared-wallet execution')).toHaveCount(2, { timeout: 60_000 });
    await expect(history.getByText(/^proposal [0-9a-f]{8}…$/).first()).toBeVisible();
  }
  // Funding instructions with QR, for an external transfer.
  const gas = adhil.getByLabel('Gas Service Account', { exact: true });
  await gas.getByRole('button', { name: 'Fund / Recharge account' }).click();
  const sheet = adhil.getByRole('dialog');
  await expect(sheet.getByText(/Send ETH to this address to fund QD Wallet’s gas service account\. This account pays blockchain execution fees for shared-wallet transactions\./)).toBeVisible();
  await expect(sheet.getByRole('img', { name: new RegExp(`QR code for ${RELAYER}`, 'i') })).toBeVisible();
  await expect(sheet.getByLabel('Funding address', { exact: true })).toHaveText(new RegExp(`^${RELAYER}$`, 'i'));

  // --- Personal Home → Activity (recipient side): P3 never took part in that proposal; the transfer is found on chain ---
  await p3.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).first().click();
  await p3.getByRole('button', { name: /^Network: .*Change network$/ }).click();
  await p3.getByRole('option', { name: /Localhost \(Anvil\)/ }).click();
  await p3.getByRole('tab', { name: 'Activity' }).click();
  const received = p3.getByRole('button', { name: /Received ETH/ }).first();
  await expect(received).toBeVisible({ timeout: 60_000 });
  await expect(received).toContainText('+0.01 ETH');
  await received.click();
  const sheet2 = p3.getByRole('dialog');
  await expect(sheet2.getByText(p3Hash.slice(0, 10), { exact: false })).toBeVisible();
  await expect(sheet2.getByText(p3Hash.slice(-8), { exact: false })).toBeVisible();
  // The sender is the shared smart account (chunked display: compare without spaces).
  expect((await sheet2.getByText('From').locator('..').textContent())!.replace(/\s/g, '').toLowerCase()).toContain(address.toLowerCase());

  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

const RELAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil account #1, the e2e API's relayer

function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
