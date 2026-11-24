import { expect, test } from '@playwright/test';
import { HDKeyring, bytesToHex, fromHex } from '@qd/wallet-core';
import { Transaction, TEST_NETWORK } from '../../../packages/bitcoin/test/fixtures';
import { scriptPubKeyHex } from '@qd/bitcoin';

test.skip(process.env.QD_BITCOIN_E2E !== '1', 'Use the isolated Bitcoin configuration and matching production build');
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const password = 'Correct-Horse-42';

for (const interrupted of [false, true]) test(`fresh change survives reload${interrupted ? ' and interrupted broadcast recovery' : ''} and is spent again`, async ({ page }) => {
  const keys = await HDKeyring.fromMnemonic(phrase);
  const from = keys.btcAddress(0, 'p2wpkh', 'testnet4'),
    to = keys.btcAddress(8, 'p2wpkh', 'testnet4');
  const funding = new Transaction({ allowUnknownInputs: true });
  funding.addInput({ txid: '11'.repeat(32), index: 0 });
  funding.addOutputAddress(from, 100000n, TEST_NETWORK);
  funding.updateInput(0, { finalScriptSig: new Uint8Array([0]) });
  const raw = new Map([[funding.id, bytesToHex(funding.toBytes(true, false))]]);
  type Coin = {
    txid: string;
    vout: number;
    value: string;
    scriptPubKey: string;
    confirmations: number;
    address: string;
  };
  let coins: Coin[] = [
    {
      txid: funding.id,
      vout: 0,
      value: '100000',
      scriptPubKey: scriptPubKeyHex(from),
      confirmations: 6,
      address: from,
    },
  ];
  const details = new Map<
    string,
    {
      txid: string;
      status: string;
      confirmations: number;
      value: string;
      fee: string;
      inputs: { address: string; value: string }[];
      outputs: { address: string; value: string }[];
    }
  >();
  details.set(funding.id, {
    txid: funding.id,
    status: 'confirmed',
    confirmations: 6,
    value: '100000',
    fee: '0',
    inputs: [],
    outputs: [{ address: from, value: '100000' }],
  });
  const submissions: Transaction[] = [];
  let interruptedRaw: string | undefined;
  await page.route('**/v1/btc/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    const answer = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.includes('/mainnet/')) return answer({ code: 'NOT_FOUND', title: 'Not configured', status: 404 }, 404);
    if (path.endsWith('/fees'))
      return answer({ fees: { low: 1, market: 2, aggressive: 3, tipHeight: 500, quotedAt: new Date().toISOString() } });
    const match = /\/address\/([^/]+)\/(used|utxos|history)$/.exec(path);
    if (match) {
      const address = decodeURIComponent(match[1]!);
      if (match[2] === 'used')
        return answer({
          used: [...details.values()].some((t) => [...t.inputs, ...t.outputs].some((o) => o.address === address)),
        });
      if (match[2] === 'utxos') return answer({ utxos: coins.filter((c) => c.address === address) });
      return answer({
        items: [...details.values()]
          .filter((t) => [...t.inputs, ...t.outputs].some((o) => o.address === address))
          .map((t) => ({
            hash: t.txid,
            networkId: 'btc-testnet4',
            direction: 'in',
            from: t.inputs[0]?.address ?? '',
            to: address,
            assetId: 'btc-testnet4:native',
            amount: '100000',
            fee: t.fee,
            status: 'confirmed',
            timestamp: new Date().toISOString(),
            flags: [],
          })),
      });
    }
    const lookup = /\/tx\/([0-9a-f]+)(\/raw)?$/.exec(path);
    if (lookup) {
      const id = lookup[1]!;
      return lookup[2]
        ? answer({ raw: raw.get(id) })
        : details.has(id)
          ? answer(details.get(id))
          : answer({ status: 404, code: 'NOT_FOUND' }, 404);
    }
    if (path.endsWith('/broadcast')) {
      const encoded = (route.request().postDataJSON() as { raw: string }).raw;
      if (interrupted && !interruptedRaw) {
        interruptedRaw = encoded;
        return route.abort('failed');
      }
      if (interruptedRaw && submissions.length === 0) expect(encoded === interruptedRaw).toBe(true);
      const transaction = Transaction.fromRaw(fromHex(encoded));
      const consumed: Coin[] = [];
      for (let i = 0; i < transaction.inputsLength; i++) {
        const input = transaction.getInput(i),
          id = bytesToHex(input.txid!);
        const found = coins.find((c) => c.txid === id && c.vout === input.index);
        if (!found) return answer({ status: 400, code: 'INVALID_TX' }, 400);
        consumed.push(found);
      }
      coins = coins.filter((c) => !consumed.includes(c));
      const outputs = Array.from({ length: transaction.outputsLength }, (_, i) => ({
        address: transaction.getOutputAddress(i, TEST_NETWORK)!,
        value: transaction.getOutput(i).amount!.toString(),
      }));
      outputs.forEach((o, vout) =>
        coins.push({
          txid: transaction.id,
          vout,
          value: o.value,
          scriptPubKey: scriptPubKeyHex(o.address),
          confirmations: 1,
          address: o.address,
        }),
      );
      const fee =
        consumed.reduce((n, c) => n + BigInt(c.value), 0n) - outputs.reduce((n, o) => n + BigInt(o.value), 0n);
      details.set(transaction.id, {
        txid: transaction.id,
        status: 'confirmed',
        confirmations: 1,
        value: outputs.reduce((n, o) => n + BigInt(o.value), 0n).toString(),
        fee: fee.toString(),
        inputs: consumed.map((c) => ({ address: c.address, value: c.value })),
        outputs,
      });
      raw.set(transaction.id, encoded);
      submissions.push(transaction);
      return answer({ txid: transaction.id });
    }
    return answer({ status: 404, code: 'NOT_FOUND' }, 404);
  });
  await page.goto('/onboarding');
  await page.getByRole('link', { name: 'I have a recovery phrase' }).click();
  await page.getByLabel('Word 1', { exact: true }).fill(phrase);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Import wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet is ready' })).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Open wallet' }).click();
  await page.getByRole('button', { name: /^Network: .*Change network$/ }).click();
  await page.getByRole('option', { name: /Bitcoin Testnet4/ }).click();
  async function send(amount: string) {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Home', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByRole('link', { name: 'Send', exact: true }).click();
    await page.getByLabel('Recipient address', { exact: true }).fill(to);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Amount in BTC').fill(amount);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    if (interrupted && submissions.length === 0) {
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
      return;
    }
    await expect(page.getByText('Transaction confirmed', { exact: true }).first()).toBeVisible();
  }
  await send('0.0002');
  if (interrupted) {
    expect(submissions).toHaveLength(0);
    await page.reload();
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('link', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Retry submission', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
  }
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.getOutputAddress(1, TEST_NETWORK)).toBe(keys.btcChangeAddress(0, 0, 'p2wpkh', 'testnet4'));
  await page.reload();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await send('0.0001');
  expect(submissions).toHaveLength(2);
  expect(bytesToHex(submissions[1]!.getInput(0).txid!)).toBe(submissions[0]!.id);
  expect(submissions[1]!.getInput(0).index).toBe(1);
  expect(submissions[1]!.getOutputAddress(1, TEST_NETWORK)).toBe(keys.btcChangeAddress(0, 1, 'p2wpkh', 'testnet4'));
  keys.lock();
});
