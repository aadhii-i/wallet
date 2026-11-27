import { openSharedTask } from './shared-navigation';
import {installHederaFixture,setHederaPayer,restoreHederaPayerMetadata,verifySharedHedera,verifyMigrationReviewScreen} from './hedera-shared-fixture';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { HDKeyring, bytesToHex, fromHex } from '@qd/wallet-core';
import { BITCOIN_TESTNET4_GENESIS, scriptPubKeyHex } from '@qd/bitcoin';
import { Transaction, TEST_NETWORK } from '../../../packages/bitcoin/test/fixtures';

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
  if(process.env.QD_HEDERA_SHARED_ONLY==='1')await setHederaPayer(page,words);
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
  if(process.env.QD_HEDERA_SHARED_ONLY==='1')await restoreHederaPayerMetadata(page,PASSWORD);
}

/** Uncaught errors in any participant's page (e.g. the former "chain.data is undefined" crash). */
const pageErrors: string[] = [];

async function newParticipant(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if(process.env.QD_HEDERA_SHARED_ONLY==='1')await installHederaFixture(page);
  page.on('pageerror', (e) => pageErrors.push(`${page.url()}: ${e.message}`));
  await createLocalWallet(page);
  await page.getByRole('navigation', { name: 'Wallet type' }).getByRole('link', { name: 'Shared Wallet', exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Shared wallets', level: 1 })).toBeVisible();
  return page;
}

const keyCard = (page: Page): Locator => page.getByRole('region', { name: 'Threshold key' });
const card = (page: Page): Locator => page.getByRole('article', { name: new RegExp(`^Proposal: 0\\.02 ETH to ${RECIPIENT}$`, 'i') });

const signingScenario = process.env.QD_HEDERA_SHARED_ONLY === '1'
  ? 'acceptance: shared Hedera creation, native quorum, Raccoon approval and HBAR transfer'
  : process.env.QD_BITCOIN_SHARED_ONLY === '1'
    ? 'acceptance: three devices sign shared Bitcoin with Threshold Raccoon approval and a native quorum'
    : 'acceptance: ADHIL and NENA sign 0.02 ETH with a 2-of-3 Threshold Raccoon key; executed and confirmed on Anvil';

test(signingScenario, async ({ browser }) => {
  // --- wallet with three independent participants ---
  const adhil = await newParticipant(browser);
  const create = adhil.getByRole('form', { name: 'Create shared wallet' });
  await create.getByLabel('Wallet name').fill(WALLET_NAME);
  await create.getByLabel('Your display name').fill('ADHIL');
  await create.getByRole('button', { name: 'Create shared wallet' }).click();
  await expect(adhil.getByRole('heading', { name: WALLET_NAME })).toBeVisible();
  await openSharedTask(adhil, 'sw-participants');
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

  for (const page of all) await openSharedTask(page, 'sw-setup');
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
  for (const page of all) await openSharedTask(page, 'sw-accounts');
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

  if (process.env.QD_HEDERA_SHARED_ONLY === '1') {
    await verifySharedHedera(all);
    await verifyMigrationReviewScreen(adhil);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    return;
  }
  await verifySharedBitcoin(all);
  if(process.env.QD_BITCOIN_SHARED_ONLY==='1'){expect(pageErrors,pageErrors.join('\n')).toEqual([]);return;}
  for (const page of all) await openSharedTask(page, 'sw-proposals');

  // --- ADHIL proposes 0.02 ETH ---
  const form = adhil.getByRole('form', { name: 'Payment request' });
  await expect(form.getByText(`Sends from shared address ${address}`, { exact: false })).toBeVisible();
  await form.getByLabel('Recipient address').fill(RECIPIENT);
  await form.getByLabel('Amount (ETH)').fill('0.02');
  await form.getByLabel('Network', { exact: true }).selectOption('11155111');
  await form.getByRole('button', { name: 'Review payment' }).click();
  await adhil.getByRole('button', { name: 'Create payment request' }).click();
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
  expect(download.suggestedFilename()).toMatch(/^qd-wallet-receipt-11155111-0x[0-9a-f]{10}\.pdf$/);
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
  await openSharedTask(adhil, 'sw-accounts');
  await openSharedTask(adhil, 'sw-accounts');
  await expect(adhil.getByLabel('Account balance')).toHaveText('0.98 ETH', { timeout: 30_000 });
  await openSharedTask(adhil, 'sw-proposals');
  await openSharedTask(adhil, 'sw-proposals');

  // --- Shared → Personal: 0.01 ETH to P3's own personal wallet. Same transaction in both histories. ---
  const p3Address = (await p3.evaluate(() => (JSON.parse(localStorage.getItem('qd-meta')!) as { state: { accounts: { address: string }[] } }).state.accounts[0]!.address)).toLowerCase();
  await expect(form.getByLabel('Nonce')).toHaveValue('1', { timeout: 30_000 });
  await form.getByLabel('Recipient address').fill(p3Address);
  await form.getByLabel('Amount (ETH)').fill('0.01');
  await form.getByLabel('Network', { exact: true }).selectOption('11155111');
  await form.getByRole('button', { name: 'Review payment' }).click();
  await adhil.getByRole('button', { name: 'Create payment request' }).click();
  const toP3 = (page: Page) => page.getByRole('article', { name: new RegExp(`^Proposal: 0\\.01 ETH to ${p3Address}$`, 'i') });
  await toP3(adhil).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toP3(nena).getByText('1/2 approvals', { exact: true })).toBeVisible();
  await toP3(nena).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toP3(adhil).getByLabel('Proposal status')).toHaveText('Confirmed', { timeout: 240_000 });
  const p3Hash = (await toP3(adhil).getByLabel('Transaction hash', { exact: true }).textContent())!.trim();
  // Shared Wallet History (sender side): Sent 0.01 ETH, the same hash, from the chain index; PDF receipt from the re-verified receipt.
  await openSharedTask(adhil, 'sw-wallet-history');
  await openSharedTask(adhil, 'sw-wallet-history');
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
  expect(historyPdf.suggestedFilename()).toBe(`qd-wallet-receipt-11155111-${p3Hash.slice(0, 12)}.pdf`);
  expect(await balance(p3Address)).toBe(10_000_000_000_000_000n);

  await openSharedTask(adhil, 'sw-proposals');
  // --- an over-budget proposal: every participant sees why it cannot execute; nothing is sent ---
  await openSharedTask(adhil, 'sw-proposals');
  await expect(form.getByLabel('Nonce')).toHaveValue('2', { timeout: 30_000 });
  const relayerNonceBefore = await anvil<string>('eth_getTransactionCount', [RELAYER, 'latest']);
  await form.getByLabel('Recipient address').fill(RECIPIENT);
  await form.getByLabel('Amount (ETH)').fill('5');
  await form.getByLabel('Network', { exact: true }).selectOption('11155111');
  await form.getByRole('button', { name: 'Review payment' }).click();
  await adhil.getByRole('button', { name: 'Create payment request' }).click();
  const big = (page: Page) => page.getByRole('article', { name: new RegExp(`^Proposal: 5 ETH to ${RECIPIENT}$`, 'i') });
  await big(adhil).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(big(nena).getByText('1/2 approvals', { exact: true })).toBeVisible();
  await big(nena).getByRole('button', { name: 'Approve', exact: true }).click();
  for (const page of all) {
    const summary = big(page).getByRole('region', { name: 'Execution summary' });
    await expect(summary.getByLabel('Execution readiness')).toContainText('Blocked', { timeout: 120_000 });
    await expect(summary.getByText(/The shared account is short by 4\.03 (Sepolia)?ETH/)).toBeVisible({ timeout: 60_000 });
    await expect(summary.getByLabel('Shared account balance')).toHaveText(/^0\.97 (Sepolia)?ETH$/);
    await expect(summary.getByLabel('Gas Service Account balance')).toHaveText(/^\d+(\.\d+)? (Sepolia)?ETH$/);
  }
  await expect(big(adhil).getByLabel('Proposal status')).toHaveText('Insufficient shared-account funds', { timeout: 120_000 });
  expect(await anvil<string>('eth_getTransactionCount', [RELAYER, 'latest'])).toBe(relayerNonceBefore);

  // --- Gas Service Account (Settings → Network & Gas): same account, live balance, recharge detection ---
  const rechargeHash = await anvil<string>('eth_sendTransaction', [{ from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', to: RELAYER, value: '0x2386f26fc10000' }]); // 0.01 ETH
  // Blocks are timed (like Sepolia): wait until the recharge is mined before reading balances.
  await expect.poll(async () => (await anvil<{ status: string } | null>('eth_getTransactionReceipt', [rechargeHash]))?.status, { timeout: 30_000 }).toBe('0x1');
  for (const page of all) {
    // In-app navigation (a full reload locks the wallet by design).
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).filter({ visible: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    const gas = page.getByLabel('Gas Service Account', { exact: true });
    await expect(gas.getByLabel('Gas service address', { exact: true })).toHaveText(new RegExp(`^${RELAYER}$`, 'i'), { timeout: 30_000 });
    // The displayed balance is the chain's, exactly (nothing more is being spent at this point).
    await expect(gas.getByRole('button', { name: 'Refresh balance' })).toBeEnabled();
    await gas.getByRole('button', { name: 'Refresh balance' }).click();
    await expect(gas.getByLabel('Gas service balance', { exact: true })).toHaveText(new RegExp(`^${formatEth(await balance(RELAYER)).replace('.', '\\.')} (Sepolia)?ETH$`), { timeout: 15_000 });
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
  await expect(sheet.getByText(/Send (Sepolia)?ETH to this address to fund QD Wallet’s gas service account\. This account pays blockchain execution fees for shared-wallet transactions\./)).toBeVisible();
  await expect(sheet.getByRole('img', { name: new RegExp(`QR code for ${RELAYER}`, 'i') })).toBeVisible();
  await expect(sheet.getByLabel('Funding address', { exact: true })).toHaveText(new RegExp(`^${RELAYER}$`, 'i'));

  // --- Personal Home → Activity (recipient side): P3 never took part in that proposal; the transfer is found on chain ---
  await p3.getByRole('navigation', { name: 'Wallet type' }).getByRole('link', { name: 'Individual Wallet', exact: true }).click();
  await p3.getByRole('button', { name: /^Network: .*Change network$/ }).click();
  await p3.getByRole('option', { name: /Sepolia/ }).click();
  await p3.getByRole('tab', { name: 'Activity' }).click();
  const received = p3.getByRole('button', { name: /Received (Sepolia)?ETH/ }).first();
  await expect(received).toBeVisible({ timeout: 60_000 });
  await expect(received).toContainText(/\+0\.01 (Sepolia)?ETH/);
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

/** Public Bitcoin data are simulated; device authentication, encrypted shares,
 * workers, all Raccoon rounds and independent native signatures are real. */
async function verifySharedBitcoin(pages:Page[]) {
  for (const page of pages) await openSharedTask(page, 'sw-bitcoin');
  const panels=pages.map(page=>page.getByRole('region',{name:'Shared Bitcoin',exact:true}));
  for(const panel of panels)await panel.getByRole('button',{name:'Register my Bitcoin key'}).click();
  for(const panel of panels) {
    await expect(panel.getByText('Native keys registered: 3 / 3')).toBeVisible();
    await panel.getByRole('checkbox').check();
    await panel.getByRole('button',{name:'Confirm Bitcoin policy'}).click();
  }
  const address=(await panels[0]!.getByLabel('Shared Bitcoin receive address',{exact:true}).textContent())!.trim();
  for(const panel of panels)await expect(panel.getByLabel('Shared Bitcoin receive address',{exact:true})).toHaveText(address);
  const funding=new Transaction({allowUnknownInputs:true});funding.addInput({txid:'11'.repeat(32),index:0});
  funding.addOutputAddress(address,100_000n,TEST_NETWORK);funding.updateInput(0,{finalScriptSig:new Uint8Array([0])});
  const raw=bytesToHex(funding.toBytes(true,false));let submitted:Transaction|undefined;
  for(const page of pages)await page.route('**/v1/btc/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const answer=(data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(path.endsWith('/identity'))return answer({genesis:BITCOIN_TESTNET4_GENESIS});
    if(path.endsWith('/fees'))return answer({fees:{low:1,market:2,aggressive:3,tipHeight:500,quotedAt:new Date().toISOString()}});
    const a=/\/address\/([^/]+)\/(used|utxos|history)$/.exec(path);
    if(a){const own=decodeURIComponent(a[1]!)===address;
      if(a[2]==='used')return answer({used:own});
      if(a[2]==='utxos')return answer({utxos:own&&!submitted?[{txid:funding.id,vout:0,value:'100000',confirmations:6}]:[]});
      return answer({items:[]});
    }
    if(path.endsWith(`/tx/${funding.id}/raw`))return answer({raw});
    if(path.endsWith('/broadcast')) {
      const tx=Transaction.fromRaw(fromHex(route.request().postDataJSON().raw));
      expect(tx.getInput(0).finalScriptWitness!.length).toBe(4);
      expect(tx.outputsLength).toBe(2);expect(tx.getOutputAddress(1,TEST_NETWORK)).not.toBe(address);
      submitted=tx;return answer({txid:tx.id});
    }
    return answer({status:404,code:'NOT_FOUND'},404);
  });
  const key=await HDKeyring.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const recipient=key.btcAddress(8,'p2wpkh','testnet4');key.lock();
  for (const page of pages) await openSharedTask(page, 'sw-bitcoin-payments');
  let success=false;
  for(let attempt=0;attempt<12&&!success;attempt++) {
    const prepare=panels[0]!;
    await prepare.getByLabel('Bitcoin recipient',{exact:true}).fill(recipient);
    await prepare.getByLabel('Amount in BTC',{exact:true}).fill('0.0004');
    await prepare.getByRole('button',{name:'Prepare Bitcoin proposal'}).click();
    await expect(prepare.getByRole('combobox',{name:'Bitcoin proposal',exact:true})).not.toHaveValue('');
    const session=await prepare.getByRole('combobox',{name:'Bitcoin proposal',exact:true}).inputValue();
    for(const panel of panels.slice(1)) {
      const select=panel.getByRole('combobox',{name:'Bitcoin proposal',exact:true});
      await expect(select.locator(`option[value="${session}"]`)).toHaveCount(1);await select.selectOption(session);
    }
    for(const panel of panels)await panel.getByRole('button',{name:'Approve and participate in signing'}).click();
    const outcome=await Promise.race([
      prepare.getByRole('button',{name:'Finalize and submit Bitcoin payment'}).waitFor({state:'visible'}).then(async()=>{
        await expect(prepare.getByRole('button',{name:'Finalize and submit Bitcoin payment'})).toBeEnabled({timeout:45000});return 'ready';
      }),
      Promise.any(panels.map(panel=>panel.getByRole('alert').waitFor({state:'visible',timeout:50000}))).then(()=>'aborted'),
    ]);
    if(outcome==='aborted')continue;
    await prepare.getByRole('button',{name:'Finalize and submit Bitcoin payment'}).click();
    await expect(prepare.getByRole('status')).toContainText('Bitcoin payment submitted:');success=true;
  }
  expect(success).toBe(true);expect(submitted).toBeDefined();
  expect(submitted!.getOutputAddress(0,TEST_NETWORK)).toBe(recipient);
}
