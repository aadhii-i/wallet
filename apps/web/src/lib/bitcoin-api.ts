'use client';
import type { ActivityItem, ApiBtcUtxo, BitcoinNetworkName, TxStatus } from '@qd/shared-types';
import type { BitcoinChain, Page, TxLookup } from '@qd/blockchain';
import type { BitcoinDataSource, BtcFeeEstimates, BtcUtxo } from '@qd/bitcoin';
import { scriptPubKeyHex } from '@qd/bitcoin';
import { getApi } from './api';
import { bitcoinWalletHistory } from './bitcoin-history';
import { ApiError } from '@qd/rpc';

/**
 * Sats arrive as decimal strings; the adapter works in bigint only.
 * The listing's script is a claim based on the requested address, not proof.
 * Selected coins must subsequently match raw previous transaction bytes.
 */
function toUtxo(u: ApiBtcUtxo, scriptPubKey: string): BtcUtxo {
  return {
    txid: u.txid,
    vout: u.vout,
    value: BigInt(u.value),
    scriptPubKey,
    confirmations: u.confirmations,
    ...(u.blockHeight !== undefined ? { blockHeight: u.blockHeight } : {}),
  };
}

/**
 * Bitcoin data source backed by wallet-api, which owns the Core connection.
 * The client never talks to Bitcoin Core, and no key material crosses this
 * boundary: addresses in, PSBTs out.
 */
export function createBitcoinDataSource(chain: BitcoinNetworkName): BitcoinDataSource {
  return {
    chain,

    async getRawTransaction(txid: string): Promise<string> {
      return (await (await getApi()).btcRawTransaction(chain, txid)).raw;
    },
    async isAddressUsed(address: string): Promise<boolean> {
      return (await (await getApi()).btcAddressUsed(chain, address)).used;
    },

    async getTipHeight(): Promise<bigint> {
      const { fees } = await (await getApi()).btcFees(chain);
      return BigInt(fees.tipHeight);
    },

    async getUtxos(address: string): Promise<BtcUtxo[]> {
      const { utxos } = await (await getApi()).btcUtxos(chain, address);
      // Esplora's UTXO endpoint does not include scriptPubKey; we build it
      // from the address. Every UTXO from /address/{address}/utxo pays that
      // address according to the provider. Raw previous-output verification
      // independently checks this claim before any signature is released.
      const spk = scriptPubKeyHex(address);
      return utxos.map(u => toUtxo(u, spk));
    },

    async getFees(): Promise<BtcFeeEstimates> {
      const { fees } = await (await getApi()).btcFees(chain);
      return {
        low: fees.low,
        market: fees.market,
        aggressive: fees.aggressive,
        tipHeight: fees.tipHeight,
        quotedAt: Date.parse(fees.quotedAt) || Date.now(),
      };
    },

    async getTransaction(hash: string): Promise<TxLookup | null> {
      try {
        const tx = await (await getApi()).btcTransaction(chain, hash);
        return {
          hash: tx.txid,
          status: mapStatus(tx.status, tx.confirmations),
          ...(tx.blockHeight !== undefined ? { blockNumber: BigInt(tx.blockHeight) } : {}),
          ...(tx.fee !== undefined ? { fee: BigInt(tx.fee) } : {}),
        };
      } catch (error) {
        // A mempool transaction the node has not indexed yet is not an error,
        // it is "not found"; the adapter polls until it appears or times out.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },

    async getHistory(address: string, cursor?: string): Promise<Page<ActivityItem>> {
      const res = await (await getApi()).btcHistory(chain, address, cursor);
      return { items: res.items, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
    },

    async getWalletHistory(addresses: readonly string[], cursor?: string): Promise<Page<ActivityItem>> {
      const api = await getApi();
      return bitcoinWalletHistory(addresses, cursor,
        async (address, next) => {
          const result = await api.btcHistory(chain, address, next);
          return { items: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
        }, txid => api.btcTransaction(chain, txid));
    },

    async broadcast(rawHex: string): Promise<string> {
      const { txid } = await (await getApi()).btcBroadcast(chain, rawHex);
      return txid;
    },
  };
}

/** A zero-confirmation transaction is pending; a dropped one is gone. */
function mapStatus(status: TxStatus, confirmations: number): TxStatus {
  if (status === 'confirmed' && confirmations === 0) return 'pending';
  return status;
}

/**
 * The web app picks the data source from the selected network's registry
 * entry, so a stale id cannot silently read the wrong chain.
 */
export function chainForNetworkId(networkId: string): BitcoinChain | undefined {
  if (networkId === 'btc-mainnet') return 'mainnet';
  if (networkId === 'btc-testnet4') return 'testnet4';
  return undefined;
}
