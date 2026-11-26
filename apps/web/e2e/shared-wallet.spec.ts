import { openSharedTask, openSharedDetails } from './shared-navigation';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * Five independent users approve one shared-wallet proposal against the real
 * wallet-api (in-memory store). Run with `make e2e-shared`
 * (playwright.shared.config.ts starts the static web server and the API).
 */

const PASSWORD = 'Correct-Horse-42';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const WALLET_NAME = 'Family vault';

/** Same steps as e2e/wallet.spec.ts: create a fresh local wallet and open it. */
async function createLocalWallet(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to QD Wallet' })).toBeVisible();
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
  const legends = await page.locator('legend').allTextContents();
  for (const legend of legends) {
    const n = Number(/#(\d+)/.exec(legend)![1]);
    await page.locator('fieldset', { hasText: legend }).getByRole('button', { name: words[n - 1]!, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet is ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Open wallet' }).click();
  await expect(page).toHaveURL(/\/home/);
}

/** In-app navigation (a full reload would lock the wallet). */
async function openShared(page: Page) {
  await page.getByRole('navigation', { name: 'Wallet type' }).getByRole('link', { name: 'Shared Wallet', exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Shared wallets', level: 1 })).toBeVisible();
}

/** A new participant: own browser context → own IndexedDB device key → own backend user. */
async function newParticipant(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await createLocalWallet(page);
  await openShared(page);
  return page;
}

const proposalCard = (page: Page): Locator => page.getByRole('article', { name: new RegExp(`^Proposal: 1 ETH to ${RECIPIENT}$`, 'i') });

const keyCard = (page: Page): Locator => page.getByRole('region', { name: 'Threshold key' });

test('five participants reach a 3-of-5 approval threshold, then provision a 3-of-5 Threshold Raccoon key', async ({ browser }) => {
  // --- P1 creates the shared wallet ---
  const p1 = await newParticipant(browser);
  const create = p1.getByRole('form', { name: 'Create shared wallet' });
  await create.getByLabel('Wallet name').fill(WALLET_NAME);
  await create.getByLabel('Your display name').fill('P1');
  await create.getByRole('button', { name: 'Create shared wallet' }).click();
  await expect(p1.getByRole('heading', { name: WALLET_NAME })).toBeVisible();
  await expect(p1.getByText('Participants: 1', { exact: true })).toBeVisible();
  await openSharedTask(p1, 'sw-setup');
  await openSharedDetails(p1, 'Group details');
  await expect(p1.getByText('Authorization policy: 50%', { exact: true })).toBeVisible();

  // --- P1 invites four people; each code is read from the UI ---
  await openSharedTask(p1, 'sw-participants');
  const codes: string[] = [];
  for (let i = 2; i <= 5; i++) {
    await p1.getByLabel('Invitation label').fill(`P${i}`);
    await p1.getByRole('button', { name: 'Invite participant' }).click();
    const code = (await p1.getByLabel('Invitation code', { exact: true }).textContent())?.trim() ?? '';
    expect(code.length).toBeGreaterThan(8);
    await expect(p1.getByText(/Shown only once/)).toBeVisible();
    codes.push(code);
    await p1.getByRole('button', { name: 'Done' }).click();
  }
  expect(new Set(codes).size).toBe(4);

  // --- P2–P5 accept in their own contexts ---
  const others: Page[] = [];
  for (let i = 0; i < 4; i++) {
    const page = await newParticipant(browser);
    const join = page.getByRole('form', { name: 'Join with invitation code' });
    await join.getByLabel('Invitation code', { exact: true }).fill(codes[i]!);
    await join.getByLabel('Your display name').fill(`P${i + 2}`);
    await join.getByRole('button', { name: 'Preview invitation' }).click();
    await expect(join.getByRole('group', { name: 'Invitation preview' })).toContainText(WALLET_NAME);
    await expect(join.getByRole('group', { name: 'Invitation preview' })).toContainText('Invited by P1');
    await join.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page.getByRole('heading', { name: WALLET_NAME })).toBeVisible();
    await openSharedTask(page, 'sw-participants');
    others.push(page);
  }
  const [p2, p3, p4, p5] = others as [Page, Page, Page, Page];
  const all = [p1, p2, p3, p4, p5];

  for (const page of all) {
    await expect(page.getByText('Participants: 5', { exact: true })).toBeVisible();
    await expect(page.getByText('Required approvals: 3', { exact: true })).toBeVisible();
  }
  // Only the owner manages invitations.
  await expect(p1.getByRole('heading', { name: 'Invitations', exact: true })).toBeVisible();
  await expect(p2.getByRole('heading', { name: 'Invitations', exact: true })).toHaveCount(0);

  await openSharedTask(p1, 'sw-setup');
  // --- P1 adds an account (not a participant) ---
  await p1.getByLabel('Account name').fill('Treasury');
  await p1.getByRole('button', { name: 'Add account' }).click();
  await expect(p1.getByRole('list', { name: 'Shared accounts' })).toContainText(/QD account #\d+ — address available once the wallet key is initialized/);
  await expect(p1.getByText('Participants: 5', { exact: true })).toBeVisible();

  for (const page of all) await openSharedTask(page, 'sw-proposals');
  // --- P1 proposes 1 ETH on Anvil ---
  const form = p1.getByRole('form', { name: 'Payment request' });
  await expect(form.getByLabel('Sender account')).toContainText('Treasury');
  await form.getByLabel('Recipient address').fill(RECIPIENT);
  await form.getByLabel('Amount (ETH)').fill('1');
  await form.getByLabel('Network', { exact: true }).selectOption('11155111');
  await form.getByRole('button', { name: 'Review payment' }).click();
  await expect(p1.getByText('This transaction requires approval from 3 of 5 participants.')).toBeVisible();
  await expect(p1.getByText(/requires approval from 3 of 5 participants/)).toBeVisible();
  await p1.getByRole('button', { name: 'Create payment request' }).click();

  const card1 = proposalCard(p1);
  await expect(card1).toBeVisible();
  await expect(card1.getByLabel('Proposal status')).toHaveText('Awaiting approvals');
  await expect(card1.getByText('0/3 approvals', { exact: true })).toBeVisible();
  await expect(card1).toContainText('Sepolia (11155111)');
  await expect(card1).toContainText('Proposed by');
  await expect(card1).toContainText('P1');

  // --- P1 approves ---
  await card1.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card1.getByText('1/3 approvals', { exact: true })).toBeVisible();
  await expect(card1.getByText('Your vote: Approved')).toBeVisible();
  await expect(card1.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

  // --- P2 approves (sees P1's vote via polling first) ---
  const card2 = proposalCard(p2);
  await expect(card2.getByText('1/3 approvals', { exact: true })).toBeVisible();
  await card2.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card2.getByText('2/3 approvals', { exact: true })).toBeVisible();
  await expect(card2.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0); // no double vote
  await expect(card2.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  await expect(card2.getByText('Your vote: Approved')).toBeVisible();
  await expect(card2.getByLabel('Proposal status')).toHaveText('Awaiting approvals');
  await expect(card2.getByText(/Threshold reached/)).toHaveCount(0);
  await expect(card2.getByText(/awaiting key generation/)).toHaveCount(0);

  // P4 can still vote while pending.
  const card4 = proposalCard(p4);
  await expect(card4.getByText('2/3 approvals', { exact: true })).toBeVisible();
  await expect(card4.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();

  // --- P3 approves → threshold reached ---
  const card3 = proposalCard(p3);
  await expect(card3.getByText('2/3 approvals', { exact: true })).toBeVisible();
  await card3.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card3.getByText('3/3 approvals', { exact: true })).toBeVisible();
  await expect(card3.getByLabel('Proposal status')).toHaveText('Threshold reached — awaiting key generation');
  await expect(card3.getByText(/Awaiting an initialized Threshold Raccoon key for this proposal’s participants/)).toBeVisible();

  // Every participant converges on the closed state; P4 can no longer vote.
  for (const page of all) {
    const card = proposalCard(page);
    await expect(card.getByText('3/3 approvals', { exact: true })).toBeVisible(); // before key generation
    await expect(card.getByLabel('Proposal status')).toHaveText('Threshold reached — awaiting key generation');
    await expect(card.getByText(/\b(Signed|Submitted|Confirmed)\b/)).toHaveCount(0);
  }
  await expect(card4.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(card4.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  await expect(proposalCard(p5).getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

  // --- a 6th outsider cannot see the wallet ---
  const outsider = await newParticipant(browser);
  await expect(outsider.getByRole('form', { name: 'Create shared wallet' })).toBeVisible();
  await expect(outsider.getByText('You are not a participant of any shared wallet yet.')).toBeVisible();
  await expect(outsider.getByRole('list', { name: 'Your shared wallets' })).toHaveCount(0);
  await expect(outsider.getByText(WALLET_NAME)).toHaveCount(0);

  for (const page of all) await openSharedTask(page, 'sw-setup');
  // ===== Threshold Raccoon key generation (trusted dealer = P1's browser) =====
  for (const page of all) await expect(keyCard(page).getByText('Status: Not initialized')).toBeVisible();
  await expect(keyCard(p2).getByText('Waiting for the owner to start key generation.')).toBeVisible();
  await expect(keyCard(p2).getByRole('button', { name: 'Start key generation' })).toHaveCount(0);
  await keyCard(p1).getByRole('button', { name: 'Start key generation' }).click();

  // Each participant's own browser creates its receiving key (in the key worker) and registers it.
  for (const page of all) {
    const card = keyCard(page);
    await expect(card.getByText('Status: Key generation in progress')).toBeVisible();
    await card.getByLabel('Wallet password').fill(PASSWORD);
    await card.getByRole('button', { name: 'Unlock key-share storage' }).click();
    await card.getByRole('button', { name: 'Prepare this device' }).click();
    await expect(card.getByRole('button', { name: 'Prepare this device' })).toHaveCount(0);
  }
  // Everyone computes the same safety number from the keys the server shows them.
  const safety: string[] = [];
  for (const page of all) {
    const line = keyCard(page).getByText(/^Safety number:/);
    await expect(line).toBeVisible();
    safety.push((await line.textContent()) ?? '');
  }
  expect(new Set(safety).size).toBe(1);

  await expect(keyCard(p3).getByText('Waiting for the dealer to generate and distribute shares.')).toBeVisible();
  await keyCard(p1).getByRole('button', { name: 'Generate and distribute shares' }).click();

  // Each participant receives, verifies and stores only its own share; the key
  // stays uninitialized until the last one acknowledges.
  for (const [i, page] of all.entries()) {
    const card = keyCard(page);
    await expect(card.getByText('Status: Awaiting participant provisioning')).toBeVisible();
    await card.getByRole('button', { name: 'Receive my share' }).click();
    if (i < all.length - 1) await expect(card.getByText(/Your share is stored\./)).toBeVisible();
  }
  const fingerprints: string[] = [];
  for (const [i, page] of all.entries()) {
    const card = keyCard(page);
    await expect(card.getByText('Status: Key initialized')).toBeVisible();
    await expect(card.getByText('3-of-5 Threshold Raccoon key, provisioned to every participant.')).toBeVisible();
    await expect(card.getByText(`This device holds share #${i + 1}.`)).toBeVisible();
    fingerprints.push((await card.getByText(/^Key fingerprint:/).textContent()) ?? '');
    await openSharedDetails(page, 'Group details');
    await expect(page.getByText('Key status: Key initialized')).toBeVisible();
  }
  expect(new Set(fingerprints).size).toBe(1);
  await expect(keyCard(outsider)).toHaveCount(0);

  for (const page of all) await openSharedTask(page, 'sw-proposals');
  // The approved proposal now refers to an initialized key — but no signature exists.
  for (const page of all) {
    const card = proposalCard(page);
    // The key matches; the account has no smart-account address yet, so signing cannot start.
    await expect(card.getByLabel('Proposal status')).toHaveText('Threshold reached — awaiting account address');
    await expect(card.getByText(/Selected signers: P1 \(.*party 1\), P2 .*party 2\), P3 .*party 3\)/)).toBeVisible();
    await expect(card.getByText(/awaiting key generation/)).toHaveCount(0);
    await expect(card.getByText(/\b(Signed|Submitted|Confirmed)\b/)).toHaveCount(0);
  }
});
