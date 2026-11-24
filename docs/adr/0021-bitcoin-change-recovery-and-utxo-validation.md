# ADR 0021: Recoverable Bitcoin change and verified spending inputs

- Status: Approved design, implemented and locally validated; public-network and release review pending.
- Date: 24 November 2026.
- Scope: Personal Bitcoin wallet; shared-wallet and Threshold Raccoon protocols unchanged.

## Decision and compatibility

Keep legacy receiving addresses at `m/purpose'/coin'/0'/0/i`. Add version-1
internal addresses at `m/purpose'/coin'/i'/1/j`, where `i` is the existing
logical account and `j` is its change counter. Purpose is 84 for SegWit and 86
for Taproot; coin type is 0 for mainnet and 1 for Testnet4.

This deliberately preserves existing receiving addresses. It is a mixed legacy
and standard-internal layout, not a promise that a third-party wallet will
reconstruct QD-Wallet account grouping. Restoring in QD-Wallet scans both layouts.
Do not reinterpret old indexes or repurpose unused external addresses as change.
The key worker derives each internal key on demand and wipes the derived node.
An internal public descriptor is available alongside the legacy receiving
descriptor. Recovery tooling must consider both; the old receiving descriptor
alone does not cover internal change. Public descriptors still disclose address
relationships and must not be logged or sent to unrelated providers.

## Discovery and recovery

Scan internal transaction activity, including spent addresses and coinbase
activity. Stop after 20 consecutive unused internal addresses beyond the locally
allocated range. Never interpret a provider failure as an unused address. An
explicit maximum of 10,000 derived internal addresses bounds a scan; reaching it
fails the scan rather than returning a complete zero balance.

Keep public allocation metadata in a versioned IndexedDB ledger, scoped by the
wallet's derived identity, account, network and address type. Advance the counter
only when signing commits, not on review refresh. Allocation cannot pass the
20-address gap beyond observed usage. A full gap blocks further fresh-change
signing until pending payments and address activity are reconciled.

Recovery-phrase import also checks the first 20 legacy account indexes, in both
address formats, on configured Bitcoin networks. An account's legacy history
remains discoverable after its funds move to internal change. Discovery has a
30-second budget and reports incomplete results on failure or timeout. Selecting
a restored account then discovers its internal branch. Higher logical indexes
can be derived through Add account; this is not unbounded account discovery.
An internal address funded directly without any legacy receiving history is not
automatically enough to discover its logical account during import: selecting or
adding that account is required. Further recovery UI remains a release follow-up.

The phrase reproduces keys, not unbroadcast transactions or reservations. A
restore on another device cannot recover signed bytes that were never published.
Independent devices using the same phrase cannot coordinate address allocation
or input reservations through a browser-local ledger. Local storage must not be
treated as a trusted global counter.

## Signing and persistence

Before signing, independently validate the PSBT against explicit review fields:
recipient, amount, maximum fee, internal change index/address, and the per-input
legacy/internal key mapping. The confirmation hash covers these fields and the
PSBT. Only the supported single-recipient, optional-change structure, version 2,
zero locktime, final sequences and supported all-output signature modes are
accepted. Each input must belong to this account. No caller-supplied arbitrary
derivation path is accepted.

The worker validates first, then performs synchronous signing and the ledger
update inside one IndexedDB read/write transaction. That transaction checks for
conflicting input reservations, advances the change counter, reserves inputs,
and stores the finalized transaction bytes and transaction ID. No signature is
returned until the storage transaction completes. A storage/signing failure
aborts the transaction. A crash after commit leaves saved signed bytes that the
user can explicitly resubmit from the Bitcoin send screen.

Reservations are not released on timeout or an unverified report that a payment
has disappeared. Confirmed spent inputs naturally leave the provider's UTXO set.
Saved transactions are paginated in the UI and retained locally; automatic
compaction and explicit conflict/reorganization reconciliation remain follow-ups.

## Untrusted provider boundary

Validate UTXO identifiers, integer output indexes, monetary bounds, confirmation
counts, scripts, duplicate outpoints and total value. Select confirmed coins,
exclude uneconomic inputs, and bound transactions to 200 inputs. Check coinbase
maturity from raw previous transaction structure and reported confirmations.

Fetch selected inputs' raw previous transactions through a purpose-built API.
Recompute each transaction ID and verify the referenced output's amount and
script before building the PSBT. Carry the full previous transaction into the
PSBT so the worker's parser also checks the transaction-ID linkage and output
consistency. Re-query unspent status before signing and before broadcasting.

This checks contents, not independent chain membership. Confirmations,
unspentness, omitted history, and network identity still depend on the configured
Esplora service. There is a race between checking unspentness and broadcasting;
the Bitcoin node remains the final arbiter. A validating-node/light-client trust
model is not introduced by this change.

Use reported tip and block height to calculate confirmation counts; reject
inconsistent heights instead of reporting every confirmed coin as one
confirmation. Distinguish not-found from provider failure during transaction
tracking. Dust thresholds follow Bitcoin Core's default policy for the output
type (294 sats for P2WPKH, 330 for P2TR), not a consensus guarantee. Estimates
reserve worst-case input sizes and distinguish recipient/change script sizes.

## Security limits

These protections do not defend against complete compromise of the browser or
recovery phrase. Native signing remains ECDSA or Schnorr and is not quantum-safe.
Coin control, manual freezing, fee bumping, reorganization reconciliation,
provider-independent chain validation, storage growth controls, and independent
security review remain release work. Address reuse for change is fixed; the
legacy receive address still does not rotate automatically.

## Evidence

See [change and validation record](../changes/2026-11-24-bitcoin-change-security.md).
Protocol references: [BIP 44](https://bips.dev/44/), [BIP 84](https://bips.dev/84/),
[BIP 86](https://bips.dev/86/), [PSBT](https://bips.dev/174/),
[Bitcoin Core dust policy](https://github.com/bitcoin/bitcoin/blob/master/src/policy/policy.cpp).
