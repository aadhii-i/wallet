# 2026-11-13 — Bitcoin support (mainnet + testnet4)

## Summary

Adds Bitcoin as a first-class chain family alongside EVM:

- Networks `btc-mainnet` and `btc-testnet4`.
- BIP-84 P2WPKH (`bc1q` / `tb1q`) as the default receive/send address type.
- BIP-86 P2TR (`bc1p` / `tb1p`) as an opt-in address type.
- UTXO fetching, coin selection, fee quoting in sat/vB, PSBT construction,
  signing inside the KeyWorker, and broadcast through wallet-api.
- wallet-api uses the public Mempool.space Esplora REST API; it never sees
  private keys or descriptors containing an xprv.

No post-quantum claim is made for Bitcoin. P2MR (BIP 360) remains a separate,
feature-flagged future path; P2WPKH is the default because it hides the public
key until spend, unlike Taproot key-path outputs.

## Decisions

1. **BIP-84 default, BIP-86 opt-in.** P2WPKH does not expose the public key in
   the output, so it is safe against long-exposure quantum attacks as long as
   addresses are not reused. Taproot key-path spends publish the public key in
   the output, so it stays opt-in.
2. **Coin type per network.** `m/84'/0'/0'/0/i` on mainnet and
   `m/84'/1'/0'/0/i` on testnet4 (likewise purpose `86'` for P2TR).
3. **Esplora REST API.** Uses the public Mempool.space Esplora API instead of a
   self-hosted Bitcoin Core node. No watch-wallet setup or descriptor import is
   required; every address is queryable on demand.
4. **Explicit routes, no RPC passthrough.** Bitcoin exposes only purpose-built
   endpoints (`/fees`, `/address/{address}/utxos`, `/address/{address}/history`,
   `/tx/{hash}`, `/broadcast`) so a compromised client cannot reach arbitrary
   node RPCs.
5. **Signing stays in the worker.** The UI receives a PSBT, the worker signs it,
   and the UI broadcasts the extracted transaction. The signer checks that the
   payload address belongs to the selected account.
6. **Change reuses the sending address in this iteration.** A fresh change
   address per transaction is tracked as a follow-up; it is a privacy, not a
   fund-safety, issue.

## Files changed

| Path | Change |
|---|---|
| `packages/shared-types/src/index.ts` | `ChainFamily` includes `bitcoin`; `ApiAddress.networkFamily` union |
| `packages/blockchain/src/networks.ts` | `BitcoinNetwork`, `BITCOIN_NETWORKS`, union `Network`, registry |
| `packages/blockchain/src/assets.ts` | `AssetKind` includes `btc`; native BTC asset |
| `packages/blockchain/src/adapter.ts` | adapter surface used by the UI (`listAssets`, `getAllBalances`, `getChainStatus`) |
| `packages/wallet-core/src/derivation/index.ts` | BIP-84/86 paths, bech32/bech32m addresses, Taproot tweak |
| `packages/wallet-core/src/signer/keyring.ts` | `btcAddress`, `withBtcPrivateKey` |
| `packages/wallet-core/src/signer/types.ts` | Bitcoin signing payload/result |
| `packages/bitcoin/*` | new adapter, UTXO, fees, PSBT, signer and tests |
| `apps/web/src/lib/*` | Bitcoin adapter, address hook, send flow |
| `services/wallet-api/internal/blockchain/btc/*` | new Esplora REST client + service |
| `services/wallet-api/internal/platform/config/config.go` | `BTC_*` configuration and production validation |
| `services/wallet-api/cmd/wallet-api/main.go` | Bitcoin routes wiring |
| `docs/adr/0017-*` | address policy and threat notes |
| `docs/operations/bitcoin-node.md` | Esplora API configuration runbook |

## API / configuration

New wallet-api variables:

```
# Bitcoin Esplora REST API (server-side only; never exposed to clients).
# Bitcoin support is OFF while BTC_ESPLORA_URL is empty.
# Use the Mempool.space public API — no node required.
#   Testnet4: https://mempool.space/testnet4/api
#   Mainnet:  https://mempool.space/api
BTC_ESPLORA_URL=https://mempool.space/testnet4/api

# Network the Esplora instance indexes: mainnet or testnet4.
BTC_NETWORK=testnet4

# Fee policy bounds in sat/vB. Every quoted rate is clamped into this band.
BTC_FEE_FLOOR_SAT_VB=1
BTC_MAX_FEE_SAT_VB=500
```

Endpoints (authenticated, session rate limited):

```
GET  /v1/btc/{network}/fees
GET  /v1/btc/{network}/address/{address}/utxos
GET  /v1/btc/{network}/address/{address}/history
GET  /v1/btc/{network}/tx/{hash}
POST /v1/btc/{network}/broadcast   { "raw": "<hex>" }
```

The client derives Bitcoin addresses locally and queries the server for each
address. No descriptor import or address registration endpoint is needed with
Esplora; every address is queryable directly from the public blockchain.

`network` is `mainnet` or `testnet4`; a request for a network not matching the
configured `BTC_NETWORK` returns 404.

## Tests and verification

- `packages/wallet-core`: BIP-84 and BIP-86 vectors from the BIPs, plus a
  mnemonic → address determinism test.
- `packages/bitcoin`: address validation (including cross-network rejection),
  fee/coin-selection cases, PSBT build → sign → extract round trip.
- `apps/web` / all packages: `tsc --noEmit` and `vitest run`.
- Go: not executed in this environment (no Go toolchain); the package is
  compile-reviewed and must be run in CI. See "Verification" below for the
  exact commands.

## Security notes

- Private keys never leave the KeyWorker. wallet-api receives only public
  addresses and raw signed transactions.
- Cross-network addresses are rejected (`bc1` vs `tb1`).
- Fee rate is capped; unsupported or absurd fee estimates fall back to the
  configured floor rather than building an unpriceable transaction.
- Dust outputs are rejected; change below the dust threshold is added to fee.
- Esplora queries are rate limited; addresses are never logged in plaintext.
- Bitcoin signing here is secp256k1 ECDSA/Schnorr. It is **not** quantum-safe,
  and the UI must not claim otherwise.

## Rollback

Revert this change set. Vault format is unchanged, so no migration is needed.
Users who received BTC on a generated address can still restore it from the
same BIP-39 mnemonic with any BIP-84/86 wallet; no funds depend on the app.

## Verification

```bash
npx pnpm@9.15.0 -w exec tsc -p packages/wallet-core/tsconfig.json --noEmit
npx pnpm@9.15.0 -w exec tsc -p packages/bitcoin/tsconfig.json --noEmit
npx pnpm@9.15.0 -w exec tsc -p packages/blockchain/tsconfig.json --noEmit
npx pnpm@9.15.0 -w exec tsc -p apps/web/tsconfig.json --noEmit
npx pnpm@9.15.0 --filter @qd/wallet-core test
npx pnpm@9.15.0 --filter @qd/bitcoin test
(cd services/wallet-api && go build ./... && go test ./...)
```
