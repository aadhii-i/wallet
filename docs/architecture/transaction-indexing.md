# Transaction indexing: personal Activity and shared Wallet History

Both histories are read from one persistent **chain index** (`services/wallet-api/internal/indexer`). The index is built from blockchain receipts and logs, never from proposals or client state. The chain RPC stays the source of truth for balances and confirmation.

## Why incoming shared-wallet transfers were missing from Activity

A transfer from a shared wallet is one transaction: the relayer calls the `QdAccount` with value 0. The ETH reaches the recipient inside that call, so the outer transaction's `from` and `to` are the relayer and the account. The recipient appears nowhere in them.

Personal Activity was assembled on each request from two sources:
- the transactions this device sent itself;
- a per-network history provider.

Three things kept the transfer out:
1. **Sepolia had no provider.** `HISTORY_PROVIDER_11155111` defaulted to `none`; only Anvil used the block scanner.
2. **The scanner only read outer transactions.** It matched `tx.from` and `tx.to`, so it would also have missed the transfer. The Alchemy provider requested only `external` and `erc20` transfers, not `internal` ones.
3. **Nothing was stored.** Activity was rebuilt on every request.

## The index

**Watched addresses**
- Every registered personal (EVM) address, from the `addresses` table.
- Every shared smart-account address, from `shared_account_keys`.

**Cursor.** Each address has a cursor per chain (`chain_index_cursors`). A pass scans only from the cursor to the head (2 blocks behind it; Anvil has no depth). The first pass backfills 50,000 blocks.

**How transfers are found**

| What | How |
|---|---|
| Native ETH in or out, including ETH a contract sends | Bisect the address's historical (balance, nonce). A block range whose endpoints agree on both had no activity. Only the blocks where they changed are read. For an EOA the nonce is its transaction count. For a shared account it is the QdAccount **execution nonce**, because a contract's transaction count never changes: receiving X and then sending X would otherwise leave nothing to see (this happened on Sepolia). A QdAccount's balance only decreases through `execute`, which always increments that nonce. |
| Transfers out of a shared account | In each such block: transactions from or to the address, and every `Executed` event whose recipient is the address. Only the event names the recipient. |
| ERC-20 transfers | `eth_getLogs` on `Transfer` with the address as indexed `from` or `to`. Token transfers do not change the ETH balance. |
| Shared-account failures | The account's own `Executed` logs: an execution whose call reverted moves no ETH. Plus the relayer's recorded execution transactions: an outer revert emits nothing. |
| EIP-7708 (Sepolia since Amsterdam) | Every native transfer also emits a `Transfer` log from `0xff…fe`. These are recorded as native ETH, never as a token. Logs already covered by the transaction's own value or by an `Executed` event are skipped. The remaining ones are internal transfers, recorded with their exact transaction hash. |
| Anything else | A balance increase that nothing explains is recorded as an internal transfer for its block (`internal:<block>:<address>`). |

**Verification**
- Every record is built from the mined receipt.
- An `Executed` event is accepted only from a contract proven to be a QdAccount of this deployment: `verifier()` is the deterministic verifier, and the factory derives the contract's own address from its `publicKeyHash()`. An `Executed`-shaped event from any other contract is ignored.
- A reverted transaction is stored with `success = false`. For `qd_execute`, success also requires `Executed.success` to be true.

**Records** live in `chain_transfers`, keyed by (chain, tx hash, log index):

| Log index | Meaning |
|---|---|
| −1 | The transaction's own value |
| −2 | An internal remainder |
| ≥ 0 | The `Executed`, ERC-20 or EIP-7708 log |

Re-indexing inserts nothing that already exists, so a pass that crashed before saving its cursor only repeats reads.

**Providers that cap `eth_getLogs`.** Alchemy's free tier allows 10 blocks per query.
- The cap is learned once per chain, from the provider's message when it states it, otherwise by halving.
- Once a cap is known, wide log scans (token transfers, failed-call executions) cover only the newest 200 blocks before an address was first indexed, plus everything after.
- Native ETH history does not depend on logs and covers the whole backfill.
- Without this, one 2,000-block step cost 754 log queries; it now costs about 20 seconds of RPC on the free tier.

**Progress is kept.**
- The cursor is saved after every 2,000-block step.
- Only a node's genuine "no state for that block" answer makes a first indexing start at the head. A timeout or rate limit just fails the step, which is retried. Treating those as missing state once skipped an account's whole history.

**When it runs**
- In the background every 10 s.
- On request: opening Activity or Wallet History indexes those addresses first, within 8 s. It never waits behind a pass already running. The response's `index.state` says whether the history is up to date:
  - `ok`;
  - `indexing`: a pass is running or the request's time ran out; progress is kept;
  - `rpc_error`: the chain could not be read now;
  - `rpc_unavailable`: the server has no RPC for that chain.

  Stored history is returned in every state.
- RPC rate limits are retried with backoff. Only real range errors shrink the `eth_getLogs` window.

**Persistence**
- Postgres: migration `00013_chain_index.sql`.
- Development in-memory store: the `.data/dev-store.json` snapshot.

## Views

| | Personal Activity | Shared Wallet History |
|---|---|---|
| Endpoint | `GET /v1/accounts/{id}/activity` | `GET /v1/shared-wallets/{id}/history?chainId=` (members only) |
| Scope | The user's registered addresses | The wallet's smart accounts (current and earlier keys) |
| Perspective | in / out / self; the fee only when the user paid it | sent / received / self; linked to its proposal |
| Merged with | This device's own pending transactions | — |
| Receipt | Explorer link | Explorer link; PDF after the device re-reads and checks the receipt (`lib/history-receipt.ts`) |

**The same transaction in both views.** When a shared wallet pays a personal wallet, the sender's Wallet History shows *Sent* and the recipient's Activity shows *Received*. Both are the same `chain_transfers` row, so they carry the same hash.

## Limits
- Without archive state, history for an address starts when it is first indexed.
- A transaction that only paid gas for a call moving someone else's value (no value to or from the address) is not listed in Activity.
- ETH sent by a contract on a chain without EIP-7708 shows as an internal transfer without a transaction hash.
- A reverted transfer *to* an address changes neither its balance nor its nonce, so it is not discovered, unless it is a shared account's recorded execution.
