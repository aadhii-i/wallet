# 2026-11-20: Sepolia RPC rate limits (HTTP 429) and shared-wallet execution

A shared-wallet execution on Sepolia showed `Blocked — could not read chain state: rpc: provider alchemy returned HTTP 429`.

## Outcome

- **The execution in question did confirm.** Proposal `01a1f8dd-…` was blocked by 429s at 17:41–17:42. The relayer retried on its own schedule and submitted at 17:43:25. It was mined at 17:43:51.
  - Transaction: `0xbca950d4bf4657a1dd005a2bdaebcfabf043fc02da1505764148151e89ef4bbd`.
  - It was checked independently against a second Sepolia node: status `0x1`, block 12175155, chain id `0xaa36a7`. The sender is the relayer `0x8c446e…`, and the recipient of the outer call is the shared account `0x420f1c…`.
  - Gas used was 10,689,925 at 11 wei.
  - The `Executed` event moved 0.01 SepoliaETH to `0xc6067b…`.
- **The cause was background indexing, which shared the Alchemy quota with the relayer.** It has been fixed in the existing RPC pool. No second RPC stack was added.
- **Since the fix, the live API has logged 0 HTTP 429s.** Before it, the log showed about 65 a minute.

## How Sepolia connectivity works (unchanged)

The API builds one provider pool per chain, `rpc.Pool`, from `EVM_RPC_<chainId>=name=url[,name=url…]`. Every backend user of Sepolia goes through that one pool:

```
browser wallet ─► /v1/rpc/evm/11155111 (proxy; allow-listed reads, careful broadcast) ─┐
transaction tracker (conventional sends: receipt polling) ─────────────────────────────┤
shared-wallet relayer + gas estimate (preflight, simulate, broadcast, receipts) ───────┼─► rpc.Pool(11155111)
gas monitor (Gas Service history) ─────────────────────────────────────────────────────┤     ├─ alchemy     (primary)
chain indexer (Activity, Wallet History) ── background ────────────────────────────────┘     └─ publicnode  (fallback)
```

- **Chain ID.** Each provider's `eth_chainId` is verified once. A provider that serves a different chain is disabled permanently. The relayer and the gas estimate check the chain ID again before every use.
- **Failover and the circuit breaker.** Providers are tried in configured order. Five consecutive failures open a provider's circuit breaker for 30 s. A health probe runs every 10 s.
- **Signing stays separate:**
  - The conventional wallet signs EIP-1559 transactions with secp256k1 in the browser. The API only relays the raw bytes.
  - The shared wallet uses threshold signing in the members' browsers. The relayer only pays gas for a `QdAccount.execute` call that carries the combined signature, and the contract checks that signature.
- **Credentials.** RPC credentials and the relayer key stay in the API process. `make web` strips them from the web server's environment.

## Root cause

1. **Alchemy's free tier caps `eth_getLogs` at a 10-block range and limits throughput.** The chain indexer, which writes Activity and Wallet History, scans token-transfer logs (and Executed logs for shared accounts) for each watched address.
2. **The API had been stopped from about 04:20 to 17:30.** On restart, each of the 7 watched addresses needed about 2,600 Sepolia blocks of logs. At 10 blocks per call and 2–3 log queries per range, that is thousands of `eth_getLogs` calls.
3. **The pool had no pacing and no priority.** The only limit was 50 calls/s per provider, far above the free tier. Background catch-up ran as fast as Alchemy answered.
   - In the previous log, 7,235 of the 8,073 Alchemy 429s were `eth_getLogs`.
   - The indexer's own retry (up to 5 times) and its loop of chains, then addresses, then steps kept the pressure up.
4. **The relayer and the gas estimate read through the same Alchemy key,** so they received the 429s. The relayer waited and retried, which is why the execution still went through. The gas estimate showed the error as a hard "Blocked".

## Changes

### `services/wallet-api/internal/rpc`

**`ratelimit.go` (new)**

- **Background lane.** `rpc.Background(ctx)` and `rpc.BackgroundCaller(pool)` mark the indexer's calls. Each provider paces them at `RPC_BACKGROUND_RPS` (default 3/s) on public chains. While a provider is cooling down after a 429, background calls wait.
- **429 cooldown.** A 429 becomes a typed `*RateLimitedError`, which keeps the text `returned HTTP 429`. The provider then cools down: 1 s, doubling on each consecutive 429 up to 30 s, and never shorter than its `Retry-After`. Cooling providers go last in the failover order, so a configured fallback is used straight away.
- **Foreground retries.** Reads that a user or the relayer is waiting on are retried on 429 up to 3 times. The backoff is exponential with full jitter, starts at 250 ms, is capped at 4 s, and never waits less than the provider's `Retry-After`.
- **`eth_sendRawTransaction` is never retried or shared.**
  - The relayer keeps its existing policy: persist the signed transaction before broadcasting. If the outcome is unknown, it rebroadcasts only the identical bytes. If a node definitely rejected it, it re-signs.
  - The proxy's broadcast policy is unchanged.
- **Deduplication and caching.** Identical concurrent reads share one upstream call. `eth_chainId` is cached for 1 h. `eth_blockNumber` is cached for 1 s, and `eth_gasPrice` and `eth_maxPriorityFeePerGas` for 2 s. Nothing that depends on an address, a transaction or a block is cached.

**`pool.go` and `client.go`**

- 429 handling with `Retry-After`; cooldown state; cooling providers ordered last.
- `Pool.Call` = deduplication → foreground retry → one failover pass.
- A client-cancelled call is no longer counted against the circuit breaker, matching the proxy.

### `internal/indexer/indexer.go`

- **One loop per chain.** A long catch-up on Base Sepolia no longer delays Sepolia.
- **Addresses take turns within a chain.** Each round advances every address one step (2,000 blocks). A shared account's new relayer executions are recorded at the start of every one of its passes.
- **On-demand `Sync` (opening Activity) still goes up to `MaxRange` in one call.**

### `internal/sharedwallet/gasservice.go`

A 429 during the gas estimate now reads: "the network's RPC provider is temporarily rate-limiting requests (HTTP 429); nothing was sent, and the estimate will refresh automatically". It no longer says "could not read chain state".

### Configuration

| Item | Change |
|---|---|
| `cmd/wallet-api/main.go` | Background rate on every non-local pool. The indexer uses `BackgroundCaller`. The gas monitor stays in the normal lane: it watches one address with a small call budget, and in the background lane its history lagged behind indexing (caught by the shared-wallet e2e). |
| `internal/platform/config/config.go` | New `RPC_BACKGROUND_RPS` setting (default 3; 0 means unlimited). |
| `Makefile` | Passes `RPC_BACKGROUND_RPS` to the API when it is set. |
| `.env.example` | Documents the fallback provider and `RPC_BACKGROUND_RPS`. |
| Local `.env` (not committed) | Appended `,publicnode=https://ethereum-sepolia-rpc.publicnode.com` to `EVM_RPC_11155111`. The Alchemy value is unchanged, and a backup is in `.data/env.backup-before-fallback`. |

## Tests

| Test | What it proves | Mutation-checked |
|---|---|---|
| `rpc/ratelimit_test.go` `TestForegroundReadRetriesAfter429` | 429, 429, then OK gives one success after 3 calls | yes |
| `TestForegroundRetriesAreBounded` | Exactly 4 attempts, then the 429 is returned | — |
| `TestSendRawTransactionIsNeverRetried` | A broadcast is sent once, even on 429 | — |
| `TestConcurrentIdenticalReadsShareOneCall` | 10 concurrent identical reads make 1 upstream call; later reads are not cached | yes |
| `TestChainIDIsCached` | 5 chain-ID reads make 1 call | yes |
| `TestCooldownHoldsBackgroundAndPrefersFallback` | After a 429, foreground reads go to the fallback, and background waits out the cooldown | yes |
| `TestBackgroundRateLimit`, `TestParseRetryAfter` | Pacing applies to background only; the `Retry-After` header is parsed correctly | — |
| `indexer` `TestBackgroundRoundsTakeTurns` | One round advances every address one step | yes |
| `sharedwallet` estimate test | A throttled provider gives the temporary message and sends nothing | — |
| `rpc/sepolia_live_test.go` (`QD_LIVE_SEPOLIA=1`) | Live Sepolia through the pool: chain ID verified on both providers; latest block; balance; `estimateGas` 21,000 for a transfer; fees; the shared execution's receipt (status 1); a foreground read in 108 ms during a background burst | live |

**Regression runs after the change:**

| Run | Result |
|---|---|
| Go | `go vet` clean; all 19 packages pass |
| API integration (real wallet-api + Anvil): threshold signing and relayer execution, dropout/replay, histories, wallets, key generation, Gas Service | 9/9 pass |
| Shared-wallet browser e2e (Anvil with Sepolia's chain ID, so the background lane applies) | 2/2 pass |
| Live API after restart | 0 HTTP 429s. The shared execution `0xbca950d4…` appeared in Wallet History within about a minute |

The first e2e run caught a regression, which is fixed. With the gas monitor in the background lane, its history lagged behind indexing and the recharge row missed its 60 s check. The gas monitor now stays in the normal lane.

## Gas Service (Sepolia)

Read from `GET /v1/relayers`:

| Field | Value |
|---|---|
| Relayer | `0x8c446eA9cE9280fD459aE7152faACd10F49EBDC4` |
| Chain | 11155111 |
| Balance | 49,999,993,151,760,132 wei (0.04999 SepoliaETH) |
| Verifier | Deployed |
| Factory | Deployed |
| Fees | Base 17 wei, tip 2 wei, fee cap 53 wei |
| Cost of one execution at the fee cap | 763,200,000 wei |
| Cost of setting up a new wallet | 22,641,600,000 wei |
| Health | Healthy |

The Gas Service needs no top-up at current Sepolia fees. Fees can rise sharply, and at a 1-gwei fee cap the balance covers about three executions. The shared account's own balance is separate: it pays the transferred value, not gas.

## Not changed

- Production restrictions. `APP_ENV=production` still refuses relayer keys, and mainnets are still rejected for shared-wallet execution.
- Signing, the threshold protocol, signature verification and the contract.
- Bitcoin, Bitcoin Testnet4 and Hedera.

## Remaining limitations

- **No new shared-wallet transaction was started after the fix.** A proposal needs the members' browsers, which hold their key shares. The confirmed transaction above came from the user's own session.
- **No new conventional send was made in this phase.** It needs the user's wallet in the browser. Earlier conventional Sepolia sends are recorded as confirmed: `0x6e492c9a…` and `0x5ff4c314…`.
- **A long outage still takes a while to backfill under the 10-block log cap.** At 3 background calls/s, 7 addresses and about 2,600 blocks take tens of minutes. A paid Alchemy plan, or a fallback with wide log ranges, shortens this. Users are not affected while it runs.
- **The fallback is a public endpoint.** It sees the addresses whose reads fail over to it. For a beta, use a second keyed provider instead.
