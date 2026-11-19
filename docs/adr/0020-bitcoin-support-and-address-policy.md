# ADR 0020: Bitcoin support and address policy

- **Status:** Accepted for testnet4 and mainnet preview.
- **Date:** 2026-11-13
- **Spec:** chain family extension (11.2), key derivation (10.1), vault (ADR-0004).
- **Related:** [ADR-0014](0014-qd-wallet-protocol-threshold-raccoon-with-stateless-derivation.md), [Bitcoin support change record](../changes/2026-11-13-bitcoin-support.md)

## Context

The wallet currently supports EVM chains only. Adding Bitcoin means a second
account model (UTXOs instead of balances + nonces), a second signature format
(ECDSA over BIP-143 sighashes, optionally Schnorr over BIP-341), and a second
backend data source.

Bitcoin also forces an explicit address policy because the quantum threat
differs by output type:

| Output | Public key exposure | Long-exposure quantum risk |
|---|---|---|
| P2PKH / P2WPKH | hidden until spend | low, if the address is not reused |
| P2TR key path | public key is in the output | high |
| P2MR (BIP 360, draft) | key path removed | low, but not activated |

BIP 360 is still a Draft and Bitcoin has no activated post-quantum signature
opcode, so no Bitcoin transaction is quantum-safe today. This ADR records what
the wallet does **now** and what it deliberately does not claim.

## Decision

1. **Add `family: 'bitcoin'`** to the chain model. `Network` becomes
   `EvmNetwork | BitcoinNetwork`. The Bitcoin descriptor carries `chain`,
   `coinType`, `bech32Hrp`, and allowed address types.
2. **Two networks:** `btc-mainnet` (coin type 0, `bc`) and `btc-testnet4`
   (coin type 1, `tb`).
3. **BIP-84 P2WPKH is the default.** It is interoperable, cheap enough, and
   does not reveal the public key in the output.
4. **BIP-86 P2TR is opt-in.** It is offered because users and integrators ask
   for Taproot, but the UI must explain that key-path spends publish the public
   key and that Taproot is therefore the weaker default against long-exposure
   quantum attacks.
5. **One seed, deterministic addresses.** Both address types derive from the
   existing BIP-39 seed: `m/84'/coin'/0'/0/i` and `m/86'/coin'/0'/0/i`.
   No new mnemonic, no separate backup.
6. **Signing is chain-local but stays in the KeyWorker.** `packages/bitcoin`
   owns PSBT construction and sighash handling; `wallet-core` owns derivation
   and key access. The UI never sees a private key.
7. **The backend uses the Mempool.space Esplora REST API** through explicit
   routes. No self-hosted node is required. Esplora supplies UTXOs, transaction
   history, fee estimates and broadcast. No arbitrary RPC proxy.
8. **No post-quantum claim.** P2MR readiness is a separate, feature-flagged
   milestone. Marketing copy must not describe Bitcoin support as
   quantum-safe.

## Consequences

- `ChainFamily` is no longer exhaustive as a two-value union; every switch must
  handle `bitcoin` or fail type checking.
- The send flow gains a Bitcoin branch because the EVM flow is built around
  EIP-1559 fields (`chainId`, nonce, gas) that do not exist on Bitcoin.
- The backend gains a second, non-EVM RPC surface; the existing EVM allowlist
  proxy is untouched.
- Watch-only descriptor import gives the server the ability to link a user's
  addresses. This is inherent to server-side indexing; it is documented in the
  operations runbook and mitigated by not logging addresses and by using a
  dedicated wallet.
- Change addresses reuse the sending address in this iteration. This is a
  privacy regression, not a custody risk, and is tracked as a follow-up.
- Testnet4 is the default development target; mainnet is available but the
  release remains "preview, not audited".

## Alternatives considered

- **BIP-86 only.** Rejected: Taproot's key-path spend publishes the public key,
  which is the wrong default for a quantum-aware wallet.
- **Direct Esplora/mempool.space from the browser.** Rejected: it leaks every
  address to a third party and requires loosening CSP `connect-src`.
- **Import user private keys into Core.** Rejected: the server must never hold
  spending keys; only public descriptors are imported.
- **Wait for P2MR.** Rejected for now: BIP 360 is a Draft with no activation
  date, and users need Bitcoin today. P2MR remains the planned migration path.
