import { NETWORK, TEST_NETWORK, Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import {
  assetsForNetwork,
  type Asset,
  type BitcoinAddressType,
  type BitcoinChain,
  type BitcoinNetwork,
  type ReviewSummary,
} from '@qd/blockchain';
import { bytesToHex, fromHex } from '@qd/wallet-core';
import { scriptMatchesAddress, checkBitcoinAddress } from './address';
import { dustLimit } from './fees';
import type { CoinSelection } from './utxo';
import type { BtcUtxo, BitcoinUnsignedTx } from './types';
import { validateUtxos } from './validation';

function scureNetwork(chain: BitcoinChain) {
  return chain === 'mainnet' ? NETWORK : TEST_NETWORK;
}

export interface BuildPsbtParams {
  network: BitcoinNetwork;
  addressType: BitcoinAddressType;
  from: string;
  to: string;
  changeAddress: string;
  changeIndex?: number;
  amount: bigint;
  selection: CoinSelection;
  /** 32-byte x-only internal key, required for P2TR inputs. */
  tapInternalKey?: Uint8Array;
}

/**
 * Builds an unsigned PSBT. Every input is checked against the address we asked
 * the backend about, so a lying data source cannot make us spend a foreign coin.
 */
export function buildPsbt(params: BuildPsbtParams): BitcoinUnsignedTx {
  const { network, addressType, from, to, changeAddress, amount, selection } = params;
  const chain = network.bitcoin.chain;
  validateUtxos(selection.inputs);
  if (
    selection.inputs.reduce((n, u) => n + u.value, 0n) !== selection.total ||
    selection.fee < 0n ||
    selection.change < 0n
  ) {
    throw new Error('Invalid coin selection totals');
  }
  const recipient = checkBitcoinAddress(to, network);
  if (!recipient.valid || !recipient.type || amount < dustLimit(recipient.type))
    throw new RangeError('Recipient amount is below dust or address is invalid');
  if (
    selection.change > 0n &&
    (!checkBitcoinAddress(changeAddress, network).valid || selection.change < dustLimit(addressType))
  ) {
    throw new Error('Change below the dust threshold must be folded into the fee');
  }
  const distributed = amount + selection.change + selection.fee;
  if (distributed !== selection.total) {
    throw new Error('Coin selection does not balance');
  }

  const tx = new Transaction({ version: 2, allowUnknownOutputs: false });
  for (const utxo of selection.inputs) {
    if (!scriptMatchesAddress(utxo.scriptPubKey, utxo.address ?? from)) {
      throw new Error('A selected UTXO does not pay the sending address');
    }
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: fromHex(utxo.scriptPubKey), amount: utxo.value },
      ...(utxo.previousTx ? { nonWitnessUtxo: fromHex(utxo.previousTx) } : {}),
      ...(addressType === 'p2tr' && params.tapInternalKey
        ? { tapInternalKey: requireTapInternalKey(params.tapInternalKey) }
        : {}),
    });
  }

  tx.addOutputAddress(to, amount, scureNetwork(chain));
  if (selection.change > 0n) tx.addOutputAddress(changeAddress, selection.change, scureNetwork(chain));

  const psbt = base64.encode(tx.toPSBT());
  return {
    networkId: network.id,
    addressType,
    psbt,
    from,
    to,
    amount,
    fee: selection.fee,
    change: selection.change,
    inputCount: selection.inputs.length,
    vsize: selection.vsize,
    ...(addressType === 'p2tr' && params.tapInternalKey
      ? { tapInternalKey: bytesToHex(requireTapInternalKey(params.tapInternalKey)) }
      : {}),
    inputs: selection.inputs,
    changeAddress,
    review: {
      recipient: to,
      amount: amount.toString(),
      maxFee: selection.fee.toString(),
      changeAddress,
      ...(selection.change > 0n && params.changeIndex !== undefined ? { changeIndex: params.changeIndex } : {}),
      inputChanges: selection.inputs.map((u) => u.changeIndex ?? null),
    },
  };
}

function requireTapInternalKey(key: Uint8Array | undefined): Uint8Array {
  if (!key || key.length !== 32) throw new Error('P2TR inputs require a 32-byte tapInternalKey');
  return key;
}

/** Parses an unsigned PSBT back into what the review screen shows. */
export function describePsbt(unsigned: BitcoinUnsignedTx, network: BitcoinNetwork): ReviewSummary {
  const tx = Transaction.fromPSBT(base64.decode(unsigned.psbt));
  if (tx.outputsLength < 1) throw new Error('PSBT has no outputs');
  return {
    networkId: network.id,
    from: unsigned.from,
    to: unsigned.to,
    asset: nativeBtc(network),
    amount: unsigned.amount,
    maxFee: unsigned.fee,
  };
}

/** Signed PSBT → raw transaction hex (no `0x`; Core expects bare hex). */
export function extractSignedTx(signedPsbtBase64: string): { rawHex: string; txid: string; vsize: number } {
  const tx = Transaction.fromPSBT(base64.decode(signedPsbtBase64));
  if (!tx.isFinal) tx.finalize();
  return { rawHex: bytesToHex(tx.extract()), txid: tx.id, vsize: tx.vsize };
}

export function psbtInputCount(unsigned: BitcoinUnsignedTx): number {
  return Transaction.fromPSBT(base64.decode(unsigned.psbt)).inputsLength;
}

export function psbtOutpoints(psbt: string): string[] {
  const tx = Transaction.fromPSBT(base64.decode(psbt));
  return Array.from({ length: tx.inputsLength }, (_, i) => {
    const input = tx.getInput(i);
    if (!input.txid || input.index === undefined) throw new Error('Missing input outpoint');
    return `${bytesToHex(input.txid)}:${input.index}`;
  });
}

function nativeBtc(network: BitcoinNetwork): Asset {
  const asset = assetsForNetwork(network)[0];
  if (!asset) throw new Error('Bitcoin network has no native asset');
  return asset;
}

export type { BtcUtxo };
