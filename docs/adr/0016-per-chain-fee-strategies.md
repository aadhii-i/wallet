# ADR 0016: One fee engine, per-chain fee strategies

- **Status:** Accepted
- **Spec:** §16.2 (fee tiers), §11.3 ("the registry is data"), §25.3 (RPC method allowlist)
- **Date:** 2026-10-18

## Context

`EvmAdapter.estimateFee` implemented one fee model and applied it everywhere: `eth_feeHistory` over ten blocks at percentiles 10/50/90, `maxFeePerGas = 2 × baseFee + tip`. That is correct for Ethereum and Ethereum-shaped chains, and wrong in different ways for the chains the multi-chain work is enabling:

- **OP-stack (Base).** The sender also pays for posting the transaction to Ethereum. A quote built from L2 gas alone under-states the cost the account is debited, so a transfer that looked affordable is rejected for insufficient funds after the user has already authorized it.
- **Arbitrum.** ArbOS derives the gas price from L1 conditions and the Rollup parameters; the sampled `feeHistory` rewards do not describe what the sender pays. The L1 component is already inside the price the node quotes.
- **Polygon PoS.** EIP-1559 on the surface, but validators enforce a chain minimum gas price that has been raised several times, so base + sampled tip can produce a price no block includes.

The registry already carries `feeModel: 'eip1559' | 'legacy'` and nothing read it, so a chain could be declared legacy-priced and still be sent as EIP-1559.

## Decision

Fee quoting moves to `packages/evm/src/fees.ts`: four strategies (`eip1559`, `op-stack`, `arbitrum`, `polygon`) behind one interface, selected by a **required** `feeStrategy` field on each `EvmNetwork`. The adapter asks the strategy and no longer contains tier arithmetic. Choosing a fee model is now part of declaring a chain, the same way `chainId` and `kind` are — an unlisted strategy fails the quote instead of falling back to Ethereum's.

Three rules the strategies share:

- **`eth_gasPrice` is the floor, not a constant.** Where a chain enforces a minimum, the node's own price is used rather than a hard-coded number that goes stale at the next upgrade. On Polygon the shortfall against that floor is closed in the tip, because the tip is the only field the sender controls; quoting the floor while sending a lower effective price would be a lie in the other direction.
- **OP-stack chains are asked, not modelled.** The L1 component comes from the chain's `GasPriceOracle` predeploy (`getL1Fee(bytes)` over `eth_call`), evaluated against a representative transaction of the real gas limit and calldata. The formula and its inputs have changed with each hardfork while the call has stayed on the predeploy, so the node reports whatever it currently enforces. A zero answer adds nothing, which also avoids double-counting once the cost is folded into the gas price.
- **A chain that cannot be priced in full is not transacted on.** Each strategy raises `FEE_QUOTE_FAILED` (`fundsMoved: no`, retryable) rather than degrading to a partial number — the same policy the gas estimate already follows.

`extraFee` is carried on `EvmFeeParams` and added to **both** `FeeOption.maxFee` and `estimatedFee`, so the review screen's total, the `HIGH_FEE` guard and the insufficient-balance guard all see the true worst case. Previously those guards used `ReviewSummary.maxFee`, which is only `gas × maxFeePerGas` decoded from the payload.

`feeStrategy` is client-only, like `feeModel`, so it stays out of `docs/api/networks.json` (ADR 0015): the server does not price transactions. Per-chain gas bounds stay global (spec §16.3) — a transfer never needs more than the existing ceiling on any of these chains.

## Consequences

Enabling a chain means naming how it prices, and the runbook records which strategies exist. Every method the strategies use is already on the proxy allowlist (§25.3: `eth_feeHistory`, `eth_gasPrice`, `eth_getBlockByNumber`, `eth_maxPriorityFeePerGas`, `eth_call`), so a new fee model has to check that list — a chain whose fee needs another method works over a custom RPC and silently fails through `wallet-api`.

The unit tests pin the requests and the arithmetic against a fake node. **They cannot confirm the fee models against real chains.** Base Sepolia, Arbitrum Sepolia and Polygon Amoy now have upstreams and are selectable, so each strategy's first live quote is the remaining gate before those chains are offered for sending: the oracle's answer on Base in particular, whether Arbitrum's `eth_gasPrice` really carries the L1 component, and whether Polygon's floor is reached through the tip. Ethereum mainnet, Base, Arbitrum One and Polygon PoS have no upstream and stay gated.
