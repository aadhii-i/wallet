import { Transaction } from '@scure/btc-signer';
import { bytesToHex, fromHex } from '@qd/wallet-core';
import type { BtcUtxo } from './types';

export const MAX_BITCOIN_SATS = 21_000_000n * 100_000_000n;
export const MAX_SPEND_INPUTS = 200;

export function outpoint(u: Pick<BtcUtxo, 'txid' | 'vout'>): string {
  return `${u.txid.toLowerCase()}:${u.vout}`;
}

/** Validate the complete set before selection, including duplicates not selected. */
export function validateUtxos(utxos: readonly BtcUtxo[]): void {
  if (utxos.length > 10_000) throw new Error('UTXO response exceeds the wallet limit');
  const seen = new Set<string>();
  let total = 0n;
  for (const u of utxos) {
    if (
      !/^[0-9a-f]{64}$/i.test(u.txid) ||
      !Number.isInteger(u.vout) ||
      u.vout < 0 ||
      u.vout > 0xffffffff ||
      typeof u.value !== 'bigint' ||
      u.value <= 0n ||
      u.value > MAX_BITCOIN_SATS ||
      !Number.isSafeInteger(u.confirmations) ||
      u.confirmations < 0 ||
      !/^(?:[0-9a-f]{2})+$/i.test(u.scriptPubKey)
    )
      throw new Error('Invalid Bitcoin UTXO');
    const key = outpoint(u);
    if (seen.has(key)) throw new Error('Duplicate Bitcoin UTXO');
    seen.add(key);
    total += u.value;
    if (total > MAX_BITCOIN_SATS) throw new Error('Bitcoin input value exceeds the money supply');
    if (u.previousTx !== undefined) verifyPreviousOutput(u);
  }
}

/** Proves contents, not confirmation or unspentness. Those still trust the provider. */
export function verifyPreviousOutput(u: BtcUtxo): void {
  if (!u.previousTx || !/^(?:[0-9a-f]{2})+$/i.test(u.previousTx) || u.previousTx.length > 8_000_000) {
    throw new Error('Verified previous transaction is required');
  }
  const tx = Transaction.fromRaw(fromHex(u.previousTx), { allowUnknownInputs: true, allowUnknownOutputs: true });
  if (tx.id !== u.txid.toLowerCase() || u.vout >= tx.outputsLength)
    throw new Error('Previous transaction does not match the outpoint');
  const output = tx.getOutput(u.vout);
  if (output.amount !== u.value || !output.script || bytesToHex(output.script) !== u.scriptPubKey.toLowerCase()) {
    throw new Error('Previous output amount or script was substituted');
  }
  const input = tx.getInput(0);
  const coinbase =
    tx.inputsLength === 1 && !!input.txid && input.txid.every((b) => b === 0) && input.index === 0xffffffff;
  if (coinbase && u.confirmations < 100) throw new Error('Coinbase output is not mature');
  if (u.coinbase !== undefined && u.coinbase !== coinbase) throw new Error('Inconsistent coinbase status');
}
