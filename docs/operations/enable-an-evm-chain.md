# Runbook: enable an EVM chain

Adding a chain is a data change plus one environment variable. The chain is only *usable* when both registries agree and the API has an upstream for it: a chain id with no `EVM_RPC_<chainId>` entry is never listed by `GET /v1/networks`.

See [ADR 0015](../adr/0015-one-network-table-asserted-from-both-sides.md) for why the table is shared.

## 1. Declare the chain

1. `docs/api/networks.json` — add `{ id, chainId, name, kind, nativeSymbol, nativeDecimals }`.
2. `packages/blockchain/src/networks.ts` — add the client entry with the same six values, plus the fields that live only in TypeScript: presentation (`explorer`, `accent`, `shortName`, `faucetUrl`, `confirmationsForFinal`) and behaviour (`blockTimeMs`, `feeWarningNative`, `feeStrategy`). `feeStrategy` is required — see step 3 below.
3. `services/wallet-api/internal/blockchain/evm/network.go` — add the same six values to `staticMetadata`.

Steps 2 and 3 are not optional: `packages/blockchain/test/networks-contract.test.ts` and `internal/blockchain/evm/network_test.go` each assert their side against the JSON in both directions, so a chain registered on one side alone fails CI.

### Pick how the chain prices

`feeStrategy` selects the fee model the wallet quotes this chain with ([ADR 0016](../adr/0016-per-chain-fee-strategies.md), implemented in `packages/evm/src/fees.ts`):

| Strategy | Use for | What it asks the node |
|---|---|---|
| `eip1559` | Ethereum, Sepolia, Anvil-shaped chains | `eth_feeHistory` percentiles, base-fee multiple per tier |
| `op-stack` | Base and other OP-stack chains | `eth_feeHistory` **plus** `GasPriceOracle.getL1Fee()` over `eth_call` |
| `arbitrum` | Arbitrum One, Arbitrum Sepolia | `eth_gasPrice` (ArbOS includes the L1 component), per-tier headroom |
| `polygon` | Polygon PoS, Amoy | `eth_gasPrice` floor + `eth_getBlockByNumber` base fee + `eth_maxPriorityFeePerGas` |

A value outside this set fails the quote rather than falling back to Ethereum's model. Every method above is already on the proxy allowlist (spec §25.3); a chain that needs another method works over a custom RPC and fails through `wallet-api`, so check the allowlist in `services/wallet-api/internal/rpc/allowlist.go` when adding a fifth strategy.

The first live quote on a new chain is not covered by the unit tests, which run against a fake node. Confirm it before the chain is offered for sending: send a dust transaction from the app (the RPC proxy needs a device-key session, so quoting through `curl` is not the shortcut), then compare the fee the review screen quoted with the `effectiveGasPrice × gasUsed` in the receipt. A quote that misses a component shows up as an under-stated total, not as an error.

If the chain's native token needs a fiat price, add its CoinGecko id to the static provider in `services/wallet-api/internal/prices/prices.go` and extend `TestStaticProviderCoversClientPriceRefs`. An id missing there is dropped silently rather than reported as an error.

## 2. Give the API an upstream

In `.env` (gitignored, never commit):

```
EVM_RPC_11155111=alchemy=https://eth-sepolia.g.alchemy.com/v2/<key>
HISTORY_PROVIDER_11155111=alchemy
```

The `name=` prefix is load-bearing. `cmd/wallet-api/main.go` resolves the history provider through `pool.NamedCaller("alchemy")`; a bare URL enables the chain but leaves its Activity list empty.

A provider URL is only usable for the chains that provider has enabled. The Alchemy app configured for this checkout answers for Ethereum Sepolia, Arbitrum Sepolia (`arb-sepolia`, not `arbitrum-sepolia`) and Ethereum mainnet, and returns `403` for Base Sepolia and Polygon Amoy — so those two take their public endpoints instead and have no history provider. Check before writing the line:

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' <url>
```

The answer must be the chain's own id. wallet-api verifies the same thing once per upstream and disables a mismatch, so a wrong URL is refused rather than used.

## 3. Rebuild, restart, verify

```bash
docker compose up -d --build --no-deps wallet-api
curl -s localhost:8080/v1/networks
```

Checklist:

- `GET /v1/networks` (public, no device key needed) includes the chain with the `kind` and `nativeSymbol` from step 1.
- The API logs a chain-id match, not the pool's `eth_chainId` mismatch rejection (`internal/rpc/pool.go`) — a provider URL that answers with a different chain id is refused, so a mainnet endpoint cannot be wired under a testnet key.
- In the app (after unlocking), the network selector lists the chain and the home header shows `<Name> · #<block>`, refreshing about every 15 s.

## 4. Run the tests

```bash
corepack enable && corepack pnpm@9.15.0 -r typecheck
corepack pnpm@9.15.0 -r test
MSYS_NO_PATHCONV=1 docker run --rm -v D:/wallet:/src -w /src/services/wallet-api \
  golang:1-bookworm sh -c 'go vet ./... && gofmt -l internal cmd && go test ./...'
```

`make test-go` is the documented path; the container form above is what to use when Go is not installed on the host. `MSYS_NO_PATHCONV=1` stops Git Bash from rewriting the `/src` paths.

On a host whose Docker DNS is unreliable, module downloads fail with `lookup proxy.golang.org ... i/o timeout` or truncate with `unexpected EOF`. Pin resolvers and keep the module cache in a volume so a retry resumes instead of restarting:

```bash
MSYS_NO_PATHCONV=1 docker run --rm --dns 8.8.8.8 --dns 1.1.1.1 \
  -v D:/wallet:/src -v qd-gomod:/go/pkg/mod -w /src/services/wallet-api \
  golang:1-bookworm sh -c 'go mod download && go vet ./... && go test ./...'
```

`gofmt -l` on a Windows checkout lists files whose *worktree* copy is CRLF (`cmd/wallet-api/main.go`, `cmd/wallet-api/chainclient.go`) even though the committed blobs are LF. That is the checkout, not a formatting defect: confirm with `git ls-files --eol <file>` before reformatting, because converting them to LF rewrites every line of the diff.

## 5. Chains in flight

| Chain | id | `chainId` | Gate |
|---|---|---|---|
| Ethereum Sepolia | `sepolia` | 11155111 | enabled and verified live |
| Local Anvil | `anvil` | 31337 | enabled, integration-tested |
| Base Sepolia | `base-sepolia` | 84532 | declared, enabled on a public RPC, live block verified. Needs its first `op-stack` quote against a real node, and a history provider before Activity shows anything |
| Arbitrum Sepolia | `arbitrum-sepolia` | 421614 | declared, enabled on Alchemy with the public RPC as a second upstream, history wired, live block verified. Needs its first `arbitrum` quote against a real node |
| Polygon Amoy | `amoy` | 80002 | declared, enabled on a public RPC, live block verified. Needs its first `polygon` quote against a real node, and a history provider |
| Ethereum, Base, Arbitrum One, Polygon PoS | `eth-mainnet`, `base`, `arbitrum`, `polygon` | 1, 8453, 42161, 137 | declared; mainnet is a separate gated decision: V1 is marked "testnet/local use only" and unaudited, so enabling these needs explicit sign-off plus a live-value test plan |

The three rollup testnets are in both registries and selectable, and each passes the checks above except one: **no fee strategy has quoted a live rollup yet.** The unit tests run against a fake node, so they pin the requests and the arithmetic, not the answer. Do the quote check from step 1 on each chain before it is offered for sending — on an empty testnet wallet the review screen still shows the fee it computed, which is enough to compare against a receipt later.

Two things this table does not cover. `internal/blockchain/evm/network_test.go` has a guard that a chain the server does not know is reported as `unknown`, and it samples an id no registry declares — when you add a chain, check it is not that one. And a testnet's native token has no `priceRef`, so the balance is shown in units and never valued in fiat; adding a price for a testnet would be a number with no market behind it.
