import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { BitcoinAddressType } from '@qd/blockchain';
import {
  ConfirmationRegistry,
  SignerError,
  bytesToHex,
  type AccountRef,
  type HDKeyring,
  type SignatureResult,
  type SignerKind,
  type SigningRequest,
} from '@qd/wallet-core';
import { scriptPubKeyHex, isValidBitcoinDestination, decodeBitcoinAddress } from './address';
import { dustLimit } from './fees';
import { MAX_BITCOIN_SATS, MAX_SPEND_INPUTS } from './validation';

/**
 * Signs Bitcoin PSBTs with the account key. Kept separate from `HDSigner`
 * because Bitcoin addresses are not hex and Taproot signs BIP-341 digests,
 * not EIP-1559 payloads. It still lives inside the KeyWorker.
 */
export class BitcoinSigner {
  readonly kind: SignerKind = 'hd';

  constructor(
    private readonly keyring: HDKeyring,
    readonly confirmations: ConfirmationRegistry = new ConfirmationRegistry(),
  ) {}

  getAddress(
    account: AccountRef,
    addressType: BitcoinAddressType = 'p2wpkh',
    network: 'mainnet' | 'testnet4' = 'mainnet',
  ): string {
    return this.keyring.btcAddress(account.hdIndex, addressType, network);
  }

  sign({ account, payload, confirmation }: SigningRequest): SignatureResult {
    if (payload.kind !== 'btc-psbt') {
      throw new SignerError('UNSUPPORTED', 'BitcoinSigner only signs Bitcoin PSBTs');
    }
    if (this.keyring.locked) throw new SignerError('LOCKED', 'Wallet is locked');
    this.confirmations.consume(confirmation, payload);
    this.validate({ account, payload });

    const expected = this.keyring.btcAddress(account.hdIndex, payload.addressType, payload.network);
    if (expected !== payload.from) {
      throw new SignerError('ACCOUNT_MISMATCH', 'PSBT sender does not match the selected account');
    }

    const tx = Transaction.fromPSBT(base64.decode(payload.psbt));
    if (tx.inputsLength === 0) throw new SignerError('INVALID_PAYLOAD', 'PSBT has no inputs');

    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (!input.witnessUtxo) {
        throw new SignerError('INVALID_PAYLOAD', `Input ${i} is missing witnessUtxo`);
      }
      const change = payload.review!.inputChanges[i];
      const address =
        change === null
          ? expected
          : this.keyring.btcChangeAddress(account.hdIndex, change!, payload.addressType, payload.network);
      if (bytesToHex(input.witnessUtxo.script) !== scriptPubKeyHex(address)) {
        throw new SignerError('INVALID_PAYLOAD', `Input ${i} does not belong to the sending address`);
      }
    }

    let signed = 0;
    for (let i = 0; i < tx.inputsLength; i++) {
      const signInput = (privateKey: Uint8Array) => {
        if (payload.addressType === 'p2tr') {
          // P2TR key-path: the PSBT needs the x-only internal key so scure can
          // commit to the tweaked output and apply the BIP-341 tweak itself.
          const internalKey = schnorr.getPublicKey(privateKey);
          tx.updateInput(i, { tapInternalKey: internalKey });
        }
        if (tx.signIdx(privateKey, i)) signed++;
      };
      const change = payload.review!.inputChanges[i];
      if (change === null)
        this.keyring.withBtcPrivateKey(account.hdIndex, payload.addressType, payload.network, signInput);
      else
        this.keyring.withBtcChangePrivateKey(account.hdIndex, change!, payload.addressType, payload.network, signInput);
    }
    if (signed !== tx.inputsLength) {
      throw new SignerError('UNSUPPORTED', 'Some inputs could not be signed');
    }
    tx.finalize();
    return { kind: 'btc-psbt', signerKind: this.kind, psbt: base64.encode(tx.toPSBT()) };
  }

  /** Used before atomically reserving inputs. All policy checks run again at signing. */
  validate({ account, payload }: Pick<SigningRequest, 'account' | 'payload'>): void {
    const invalid = (message: string): never => {
      throw new SignerError('INVALID_PAYLOAD', message);
    };
    if (payload.kind !== 'btc-psbt' || !payload.review) invalid('Bitcoin review details are required');
    if (payload.kind !== 'btc-psbt' || !payload.review) return;
    const review = payload.review;
    if (!isValidBitcoinDestination(review.recipient, payload.network))
      invalid('Recipient belongs to another network or is unsupported');
    if (payload.psbt.length > 12_000_000) invalid('PSBT exceeds the wallet limit');
    if (payload.from !== this.keyring.btcAddress(account.hdIndex, payload.addressType, payload.network))
      invalid('Sender does not belong to selected account');
    if (![review.amount, review.maxFee].every((v) => /^(0|[1-9][0-9]*)$/.test(v))) invalid('Invalid review amounts');
    const amount = BigInt(review.amount),
      maxFee = BigInt(review.maxFee);
    if (amount < dustLimit(decodeBitcoinAddress(review.recipient).type === 'p2wpkh' ? 'p2wpkh' : 'p2wsh'))
      invalid('Recipient output is dust');
    if (amount <= 0n || amount > MAX_BITCOIN_SATS || maxFee > MAX_BITCOIN_SATS) invalid('Invalid review amounts');
    const tx = Transaction.fromPSBT(base64.decode(payload.psbt));
    if (
      tx.version !== 2 ||
      tx.lockTime !== 0 ||
      tx.inputsLength < 1 ||
      tx.inputsLength > MAX_SPEND_INPUTS ||
      tx.outputsLength < 1 ||
      tx.outputsLength > 2 ||
      review.inputChanges.length !== tx.inputsLength
    )
      invalid('Unsupported transaction structure');
    if (tx.outputsLength === 1 && review.changeIndex !== undefined) invalid('Unexpected change derivation index');
    const seen = new Set<string>();
    let inputs = 0n,
      outputs = 0n;
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (!input.txid || input.index === undefined || !input.witnessUtxo || !input.nonWitnessUtxo)
        invalid('Verified previous transactions are required');
      if (!input.txid || input.index === undefined || !input.witnessUtxo || !input.nonWitnessUtxo) return;
      const key = `${bytesToHex(input.txid)}:${input.index}`;
      if (seen.has(key)) invalid('Duplicate input');
      seen.add(key);
      const index = review.inputChanges[i];
      if (index !== null && (!Number.isSafeInteger(index) || index! < 0 || index! >= 10000))
        invalid('Invalid internal derivation index');
      const address =
        index === null
          ? payload.from
          : this.keyring.btcChangeAddress(account.hdIndex, index!, payload.addressType, payload.network);
      if (bytesToHex(input.witnessUtxo.script) !== scriptPubKeyHex(address))
        invalid('Input does not belong to the selected account');
      const previous = input.nonWitnessUtxo.outputs[input.index];
      if (
        !previous ||
        previous.amount !== input.witnessUtxo.amount ||
        bytesToHex(previous.script) !== bytesToHex(input.witnessUtxo.script)
      )
        invalid('Previous output mismatch');
      if (input.sighashType !== undefined && input.sighashType !== (payload.addressType === 'p2tr' ? 0 : 1))
        invalid('Unsupported signature hash');
      if (input.redeemScript || input.witnessScript || input.tapMerkleRoot || input.tapLeafScript?.length) {
        invalid('Script-path inputs are not supported by this wallet');
      }
      if (
        input.sequence !== 0xffffffff ||
        input.partialSig?.length ||
        input.tapKeySig ||
        input.tapScriptSig?.length ||
        input.finalScriptWitness?.length ||
        input.finalScriptSig?.length
      )
        invalid('Unsupported or already signed input');
      inputs += input.witnessUtxo.amount;
    }
    const recipient = tx.getOutput(0);
    if (
      recipient.amount !== amount ||
      !recipient.script ||
      bytesToHex(recipient.script) !== scriptPubKeyHex(review.recipient)
    )
      invalid('Recipient or amount changed after review');
    if (tx.outputsLength === 2) {
      if (!Number.isSafeInteger(review.changeIndex) || review.changeIndex! < 0 || review.changeIndex! >= 10000)
        invalid('Fresh change index is required');
      const changeAddress = this.keyring.btcChangeAddress(
        account.hdIndex,
        review.changeIndex!,
        payload.addressType,
        payload.network,
      );
      const change = tx.getOutput(1);
      if (!change.amount || change.amount < dustLimit(payload.addressType)) invalid('Change output is dust');
      if (
        review.changeAddress !== changeAddress ||
        !change.script ||
        bytesToHex(change.script) !== scriptPubKeyHex(changeAddress)
      )
        invalid('Change does not belong to the reserved internal address');
    }
    for (let i = 0; i < tx.outputsLength; i++) {
      const value = tx.getOutput(i).amount;
      if (value === undefined || value <= 0n || value > MAX_BITCOIN_SATS) invalid('Invalid output amount');
      outputs += value!;
    }
    const fee = inputs - outputs;
    if (inputs > MAX_BITCOIN_SATS || fee < 0n || fee > maxFee || fee > BigInt(5000 * tx.unsignedTx.length))
      invalid('Fee exceeds the approved limit');
  }
}
