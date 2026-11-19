# Changelog

All notable changes to this project are documented here. Every change also gets a
detailed record under [`docs/changes/`](changes/), named
`YYYY-MM-DD-<slug>.md`, with the files touched, decisions, tests and rollback.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Bitcoin support** — `btc-mainnet` and `btc-testnet4` networks, BIP-84
  P2WPKH by default and BIP-86 P2TR opt-in, UTXO/PSBT sending, and a
  wallet-api Bitcoin Core RPC surface.
  See [`docs/changes/2026-11-13-bitcoin-support.md`](changes/2026-11-13-bitcoin-support.md)
  and [`docs/adr/0020-bitcoin-support-and-address-policy.md`](adr/0020-bitcoin-support-and-address-policy.md).

### Changed

- `ChainFamily` now includes `'bitcoin'`; `Network` is a union of
  `EvmNetwork | BitcoinNetwork`.
- `AssetKind` now includes `'btc'` so native Bitcoin balances are not
  modelled as an ERC-20.
