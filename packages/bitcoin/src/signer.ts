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
import { scriptPubKeyHex } from './address';

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

    const expected = this.keyring.btcAddress(account.hdIndex, payload.addressType, payload.network);
    if (expected !== payload.from) {
      throw new SignerError('ACCOUNT_MISMATCH', 'PSBT sender does not match the selected account');
    }

    const tx = Transaction.fromPSBT(base64.decode(payload.psbt));
    if (tx.inputsLength === 0) throw new SignerError('INVALID_PAYLOAD', 'PSBT has no inputs');

    const expectedScript = scriptPubKeyHex(expected);
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (!input.witnessUtxo) {
        throw new SignerError('INVALID_PAYLOAD', `Input ${i} is missing witnessUtxo`);
      }
      if (bytesToHex(input.witnessUtxo.script) !== expectedScript) {
        throw new SignerError('INVALID_PAYLOAD', `Input ${i} does not belong to the sending address`);
      }
    }

    const signed = this.keyring.withBtcPrivateKey(
      account.hdIndex,
      payload.addressType,
      payload.network,
      (privateKey) => {
        if (payload.addressType === 'p2tr') {
          // P2TR key-path: the PSBT needs the x-only internal key so scure can
          // commit to the tweaked output and apply the BIP-341 tweak itself.
          const internalKey = schnorr.getPublicKey(privateKey);
          for (let i = 0; i < tx.inputsLength; i++) {
            tx.updateInput(i, { tapInternalKey: internalKey });
          }
        }
        return tx.sign(privateKey);
      },
    );
    if (signed !== tx.inputsLength) {
      throw new SignerError('UNSUPPORTED', 'Some inputs could not be signed');
    }
    tx.finalize();
    return { kind: 'btc-psbt', signerKind: this.kind, psbt: base64.encode(tx.toPSBT()) };
  }
}
