import { openSharedTask, openSharedDetails } from './shared-navigation';
import { expect, type Page } from '@playwright/test';
import { HDKeyring } from '@qd/wallet-core';
import { proto, PublicKey, AccountId } from '../../../packages/hedera/test/fixtures';
import { hederaWireText, hederaPolicyId, hederaThresholdKeyHex, type HederaSharedPolicy } from '@qd/hedera';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { nativeMigrationFields, type NativeMigrationManifest, type NativePolicy } from '@qd/rpc';

/** Isolated public-data and HAPI simulator. No requests reach Hedera. */
const payers = new Map<string, string>();
const payerForPage = new WeakMap<Page, string>();
let count = 0,
  keyHex = '',
  created = false,
  balance = 0n,
  lastId = '',
  lastAmount = 0n,
  creationCount = 0;
const receipts = new Map<string, { entityId?: string; timestamp: string; intentMemo?: string }>();
const now = () => `${Math.floor(Date.now() / 1000)}.999999999`;
const mirrorId = (id: string) => id.replace('@', '-').replace(/\.([^.]*)$/, '-$1');
function frame(bytes: Uint8Array, trailer = false) {
  const header = Buffer.alloc(5);
  header[0] = trailer ? 128 : 0;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
export async function setHederaPayer(page: Page, words: string[]) {
  const key = await HDKeyring.fromMnemonic(words.join(' ')),
    id = `0.0.${666 + count++}`;
  payers.set(id, key.hederaPublicKey(0));
  payerForPage.set(page, id);
  key.lock();
}
export async function restoreHederaPayerMetadata(page: Page, password: string) {
  await page.addInitScript((id) => {
    const raw = localStorage.getItem('qd-meta');
    if (raw) {
      const meta = JSON.parse(raw);
      meta.state.hederaAccountIds = { 0: id };
      localStorage.setItem('qd-meta', JSON.stringify(meta));
    }
  }, payerForPage.get(page)!);
  await page.reload();
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
}
export async function installHederaFixture(page: Page) {
  await page.route('**/v1/hedera/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    const answer = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const match = /\/account\/([^/]+)\/(info|balance|history)$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      if (match[2] === 'info') {
        if (id === '0.0.777' && !created) return answer({ code: 'NOT_FOUND', status: 404 }, 404);
        const publicKey = payers.get(id) ?? '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
        return answer({
          accountId: id,
          network: 'testnet',
          tinybars: id === '0.0.777' ? balance.toString() : '10000000000',
          balanceTimestamp: now(),
          deleted: false,
          receiverSignatureRequired: false,
          key:
            id === '0.0.777' ? { type: 'ProtobufEncoded', key: keyHex } : { type: 'ECDSA_SECP256K1', key: publicKey },
        });
      }
      if (match[2] === 'balance')
        return answer({
          accountId: id,
          tinybars: id === '0.0.777' ? balance.toString() : '10000000000',
          hbar: '100.00000000',
        });
      return answer({
        items:
          lastId && id === '0.0.777'
            ? [
                {
                  transactionId: mirrorId(lastId),
                  timestamp: receipts.get(lastId)?.timestamp ?? now(),
                  type: 'CRYPTOTRANSFER',
                  direction: 'out',
                  from: id,
                  to: '0.0.778',
                  amountTinybars: lastAmount.toString(),
                  feeTinybars: '1000000',
                  hbar: '1.00000000',
                  status: 'confirmed',
                  networkId: 'hedera-testnet',
                },
              ]
            : [],
      });
    }
    const lookup = /\/transaction\/(.+)$/.exec(path);
    if (lookup) {
      const id = decodeURIComponent(lookup[1]!),
        receipt = receipts.get(id);
      return answer(
        receipt
          ? { found: true, transactionId: id, result: 'SUCCESS', feeTinybars: '1000000', ...receipt }
          : { found: false, transactionId: id },
      );
    }
    return answer({ code: 'NOT_FOUND' }, 404);
  });
  // Match every HTTPS request, including any unexpected transport, so this
  // acceptance test cannot accidentally submit a public testnet transaction.
  await page.route(
    (url) => !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    async (route) => {
      const path = new URL(route.request().url()).pathname,
        method = path.split('/').pop();
      const headers = {
        'access-control-allow-origin': 'http://localhost:3100',
        'access-control-allow-headers': 'content-type,x-grpc-web,x-user-agent,grpc-timeout',
        'access-control-allow-methods': 'POST,OPTIONS',
        'access-control-expose-headers': 'grpc-status,grpc-message',
      };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (path === '/' && !route.request().postDataBuffer()?.length)
        return route.fulfill({
          status: 200,
          headers: { ...headers, 'content-type': 'application/grpc-web+proto', 'grpc-status': '0' },
          body: Buffer.alloc(0),
        });
      if (!['createAccount', 'cryptoTransfer', 'getTransactionReceipts'].includes(method ?? ''))
        return route.fulfill({ status: 404, headers, body: 'Unexpected external request blocked' });
      const text = route.request().headers()['content-type']?.includes('text'),
        encoded = route.request().postDataBuffer()!;
      const wire = text ? Buffer.from(encoded.toString(), 'base64') : encoded;
      const request = wire.subarray(5, 5 + wire.readUInt32BE(1));
      let response: Uint8Array;
      if (method === 'getTransactionReceipts') {
        const query = proto.Query.decode(request),
          id = query.transactionGetReceipt!.transactionID!,
          account = `0.0.${id.accountID!.accountNum!.toString()}`,
          transactionId = `${account}@${id.transactionValidStart!.seconds!.toString()}.${id.transactionValidStart!.nanos!.toString().padStart(9, '0')}`;
        const known = receipts.get(transactionId);
        response = proto.Response.encode({
          transactionGetReceipt: {
            header: { nodeTransactionPrecheckCode: proto.ResponseCodeEnum.OK, responseType: 0 },
            receipt: {
              status: known ? proto.ResponseCodeEnum.SUCCESS : proto.ResponseCodeEnum.UNKNOWN,
              ...(known?.entityId ? { accountID: new AccountId(777)._toProtobuf() } : {}),
            },
          },
        }).finish();
      } else {
        const transaction = proto.Transaction.decode(request),
          signed = proto.SignedTransaction.decode(transaction.signedTransactionBytes!),
          body = proto.TransactionBody.decode(signed.bodyBytes!);
        const id = body.transactionID!,
          transactionId = `0.0.${id.accountID!.accountNum!.toString()}@${id.transactionValidStart!.seconds!.toString()}.${id.transactionValidStart!.nanos!.toString().padStart(9, '0')}`;
        for (const pair of signed.sigMap!.sigPair!) {
          expect(PublicKey.fromBytesECDSA(pair.pubKeyPrefix!).verify(signed.bodyBytes!, pair.ECDSASecp256k1!)).toBe(
            true,
          );
        }
        if (method === 'createAccount') {
          creationCount++;
          expect(creationCount).toBe(1);
          expect(signed.sigMap!.sigPair!.length).toBe(1);
          keyHex = Buffer.from(proto.Key.encode(body.cryptoCreateAccount!.key!).finish()).toString('hex');
          created = true;
          receipts.set(transactionId, { entityId: '0.0.777', timestamp: now(), intentMemo: body.memo ?? '' });
        } else {
          expect(
            new Set(signed.sigMap!.sigPair!.map((pair) => Buffer.from(pair.pubKeyPrefix!).toString('hex'))).size,
          ).toBeGreaterThanOrEqual(2);
          const credit = body.cryptoTransfer!.transfers!.accountAmounts!.find((a) => a.amount!.toString()[0] !== '-')!;
          lastId = transactionId;
          lastAmount = BigInt(credit.amount!.toString());
          balance -= lastAmount + 1000000n;
          receipts.set(transactionId, { timestamp: now(), intentMemo: body.memo ?? '' });
        }
        response = proto.TransactionResponse.encode({
          nodeTransactionPrecheckCode: proto.ResponseCodeEnum.OK,
        }).finish();
      }
      const result = Buffer.concat([frame(response), frame(Buffer.from('grpc-status: 0\r\ngrpc-message: \r\n'), true)]);
      return route.fulfill({
        status: 200,
        headers: {
          ...headers,
          'content-type': text ? 'application/grpc-web-text' : 'application/grpc-web+proto',
          'grpc-status': '0',
        },
        body: text ? result.toString('base64') : result,
      });
    },
  );
}

export async function verifySharedHedera(pages: Page[]) {
  for (const page of pages) await openSharedTask(page, 'sw-hedera');
  const panels = pages.map((page) => page.getByRole('region', { name: 'Shared Hedera', exact: true }));
  for (const panel of panels) await panel.getByRole('button', { name: 'Register my Hedera key' }).click();
  for (const panel of panels) {
    await expect(panel.getByText('Hedera keys registered: 3 / 3')).toBeVisible();
    await panel.getByRole('checkbox').check();
    await panel.getByRole('button', { name: 'Confirm Hedera policy' }).click();
  }
  const owner = panels[0]!;
  await owner.getByText('Create a new native threshold account', { exact: true }).click();
  await expect(owner.getByRole('combobox', { name: 'Hedera creation payer' }).locator('option[value="0"]')).toHaveCount(
    1,
  );
  await owner.getByRole('combobox', { name: 'Hedera creation payer' }).selectOption('0');
  await owner.getByRole('button', { name: 'Review Hedera account creation' }).click();
  await owner.getByRole('button', { name: 'Sign and submit Hedera account creation' }).click();
  await expect(owner.getByRole('status')).toContainText('Created 0.0.777', { timeout: 30000 });
  await owner.getByRole('button', { name: 'Verify and share Hedera account' }).click();
  for (const panel of panels) {
    await expect(panel.getByText('Proposed Hedera account: 0.0.777')).toBeVisible();
    await panel.getByRole('button', { name: 'Verify and confirm Hedera account' }).click();
  }
  for (const panel of panels)
    await expect(panel.getByLabel('Shared Hedera receive account', { exact: true })).toHaveText('0.0.777');
  balance = 10000000000n;
  await openSharedDetails(pages[0]!, 'Back up your share');
  const download = pages[0]!.waitForEvent('download');
  await owner.getByRole('button', { name: 'Export encrypted Hedera share backup' }).click();
  const backup = await download;
  expect(backup.suggestedFilename()).toMatch(/^qd-hedera-share-/);
  for (const page of pages) await openSharedTask(page, 'sw-hedera-payments');
  let success = false;
  for (let attempt = 0; attempt < 12 && !success; attempt++) {
    await owner.getByLabel('Hedera recipient', { exact: true }).fill('0.0.778');
    await owner.getByLabel('Amount in HBAR', { exact: true }).fill('1');
    await owner.getByLabel('Maximum Hedera network fee', { exact: true }).fill('0.01');
    await owner.getByRole('button', { name: 'Prepare Hedera payment' }).click();
    const select = owner.getByRole('combobox', { name: 'Hedera proposal', exact: true });
    await expect(select).not.toHaveValue('');
    const session = await select.inputValue();
    for (const panel of panels.slice(1)) {
      const other = panel.getByRole('combobox', { name: 'Hedera proposal', exact: true });
      await expect(other.locator(`option[value="${session}"]`)).toHaveCount(1);
      await other.selectOption(session);
    }
    for (const panel of panels) await panel.getByRole('button', { name: /Approve and sign.*HBAR payment/ }).click();
    const button = owner.getByRole('button', { name: 'Submit shared Hedera payment' });
    const outcome = await Promise.race([
      expect(button)
        .toBeEnabled({ timeout: 45000 })
        .then(() => 'ready'),
      Promise.any(panels.map((panel) => panel.getByRole('alert').waitFor({ state: 'visible', timeout: 50000 }))).then(
        () => 'abort',
      ),
    ]);
    if (outcome === 'abort') continue;
    await button.click();
    await expect(owner.getByRole('status').filter({ hasText: 'Hedera receipt confirmed SUCCESS' })).toBeVisible({
      timeout: 30000,
    });
    success = true;
  }
  expect(success).toBe(true);
  expect(creationCount).toBe(1);
  expect(lastId).not.toBe('');
  await openSharedTask(pages[0]!, 'sw-hedera-history');
  await expect(owner.getByRole('link', { name: /Sent 1 HBAR/ })).toBeVisible({ timeout: 25000 });
}

/** Rendering and fail-closed checks only. Worker and coordinator suites test
 * actual two-group signatures and chain verification independently. */
export async function verifyMigrationReviewScreen(page: Page) {
  const origin = `http://localhost:${process.env.QD_E2E_API_PORT ?? '8080'}`;
  const wallets = await (await page.request.get(`${origin}/v1/shared-wallets`)).json();
  const wallet = wallets.wallets.find((w: { name: string }) => w.name === 'Acceptance vault');
  const group = await (await page.request.get(`${origin}/v1/shared-wallets/${wallet.id}`)).json();
  const inventory = await (await page.request.get(`${origin}/v1/shared-wallets/${wallet.id}/native-inventory`)).json();
  const source = inventory.accounts.find((i: { chain: string }) => i.chain === 'hedera');
  expect(source).toBeDefined();
  const policies = JSON.parse(
    await readFile(new URL('../../../docs/api/native-policy-fixture.json', import.meta.url), 'utf8'),
  );
  const target = policies[3].policy as HederaSharedPolicy,
    id = randomUUID();
  const roster = (policy: NativePolicy) =>
    policy.members.map((p, index) => ({
      id: p.participantId,
      name: `Incoming signer ${index + 1}`,
      role: index === 0 ? ('owner' as const) : ('member' as const),
      deviceKey: '',
    }));
  const manifest: NativeMigrationManifest = {
    version: 1,
    id,
    sourceWalletId: wallet.id,
    targetWalletId: target.context.walletId,
    sourceEpoch: source.policy.context.membershipVersion,
    targetEpoch: target.context.membershipVersion,
    sourceKeygenId: source.policy.context.keygenId,
    targetKeygenId: target.context.keygenId,
    sourceRoster: source.policy.members.map((p: { participantId: string }) => {
      const member = group.participants.find((m: { id: string }) => m.id === p.participantId);
      return { id: p.participantId, name: member.displayName, role: member.role, deviceKey: '' };
    }),
    targetRoster: roster(target as unknown as NativePolicy),
    intents: [
      {
        id: randomUUID(),
        chain: 'hedera',
        sourceAccountId: source.accountId,
        targetAccountId: target.context.accountId,
        sourcePolicyId: source.policyId,
        targetPolicyId: hederaPolicyId(target),
        sourcePolicy: source.policy,
        targetPolicy: target as unknown as NativePolicy,
        bitcoinCoins: null,
        changeCursor: 0,
        destination: '',
        destinationScript: '',
        hederaAccountId: '0.0.777',
        targetKey: hederaThresholdKeyHex(target),
        maxFee: '100000000',
      },
    ],
    requiredApprovals: 2,
    requiredTargetApprovals: 2,
  };
  const migration = {
    manifest,
    digest: createHash('sha256')
      .update(JSON.stringify(nativeMigrationFields(manifest)))
      .digest('hex'),
    status: 'draft',
    revision: 1,
    approvals: [],
    attempts: [],
    progress: [],
    reviewPending: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const path = `**/v1/shared-wallets/${wallet.id}/native-migrations`;
  await page.route(path, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        migrations: [{ migration, access: { sourceParticipantId: group.me.id, targetParticipantId: '' } }],
      }),
    }),
  );
  try {
    await openSharedTask(page, 'sw-setup');
    await openSharedDetails(page, 'Change group membership');
    const panel = page.getByRole('region', { name: 'Native group migration', exact: true });
    await expect(panel.getByText(/Review safety number:/)).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText(/0.0.777 keeps its number/)).toBeVisible();
    const confirm = panel.getByRole('button', { name: 'Confirm as an old participant' });
    await expect(confirm).toBeDisabled();
    await panel.getByRole('checkbox', { name: /I compared this safety number/ }).check();
    await expect(confirm).toBeEnabled();
    // No confirmation or transaction is executed by this rendering test.
    migration.digest = '00'.repeat(32);
    await expect(panel.getByRole('alert')).toContainText('Migration status could not be verified', { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Prepare Hedera payment', exact: true })).toHaveCount(0);
  } finally {
    await page.unroute(path);
  }
}
