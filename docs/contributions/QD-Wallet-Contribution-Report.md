# QD-Wallet - Implementation Contribution Report

**Supervisor review | 24 November 2026**

## 1. Our contribution in context

Our main contribution has been to extend QD-Wallet beyond its initial Ethereum
workflow and bring different blockchain models into the existing wallet. We
worked on additional EVM testnets, Bitcoin, Hedera, account handling, transaction
flows, and integration reliability. We then reconciled this work with Adhil's
shared-wallet implementation so that both workstreams coexist in one codebase.

Adhil's contribution includes the shared-wallet architecture, participant
approval flow, Threshold Raccoon key provisioning and networked signing, and
the smart-account execution path, together with subsequent stabilization work.
We build on that foundation; we do not claim it as our independent contribution.
The recent integration preserves that architecture and both development histories.

## 2. Multi-blockchain implementation

### Additional EVM networks

We added Base Sepolia, Arbitrum Sepolia, and Polygon Amoy alongside Ethereum
Sepolia. The wallet can offer these configured networks through the common
network selector and reuse EVM address derivation and transaction handling.
Configuration and shared code establish implementation coverage; they do not,
by themselves, prove that a transfer succeeds on every network.

Our recent shared-wallet fee work addresses differences hidden by a generic
EVM interface. Base funding estimates include reserves for L1 data and operator
fees. Arbitrum uses its gas-price model and a posting-cost reserve, while the
transaction gas estimate already includes posting gas. Polygon estimates respect
the node's suggested price floor, and Amoy amounts and receipts display POL.
These are conservative funding checks, not guarantees of the final fee.

### Bitcoin

Our multi-chain work includes Bitcoin receiving and sending with native SegWit
and optional Taproot addresses. We integrated deterministic address derivation,
balance and transaction reads, selection of unspent outputs, fee estimation,
transaction construction, local signing, and backend broadcast support.

Bitcoin differs from Ethereum because each payment spends particular unspent
outputs and may create change. The wallet therefore needs a separate transaction
flow rather than treating BTC as an Ethereum token. Automated tests cover both
address and signing paths. Confirmed public Bitcoin testnet transfers remain
outside the evidence established for this review. Current Bitcoin signing uses
the network's conventional cryptography, not Threshold Raccoon.

### Hedera

We implemented Hedera-specific key derivation, account identification and
linking, HBAR balance and history retrieval, account creation using a funded
payer, and a dedicated transfer and receipt flow. Hedera assigns a network
account identifier, so deriving a key alone does not create a usable funded
network account. The wallet retains the created account identifier if backend
registration needs to be retried.

Registration compares the supplied public key with the key reported for the
account by the Mirror Node. We also distinguish indexing delay from a genuine
ownership mismatch and from an upstream failure. These measures improve account
association and recovery from temporary failures. They do not replace a complete
review of the account-authentication threat model. Live Hedera creation and
transfer tests remain opt-in and were not executed in this review.

## 3. Integration and reliability improvements

We reconciled the multi-chain code with the newer shared-wallet baseline,
retaining its dependency and security updates. Bitcoin and Hedera personal-wallet
flows remain distinct from the shared EVM smart-account execution path. This
integration does not add Threshold Raccoon authorization to native Bitcoin or
Hedera transfers. Monero remains at the design stage.

We addressed RPC read reliability by sharing duplicate requests, applying bounded
retries to eligible reads, preserving each caller's response identifier and
upstream error details, and distinguishing rate limits from provider outages.
Transaction broadcasting remains separate from read retries. Regression tests
cover the diagnosed conditions; the exact cause of the earlier intermittent
browser failure has not been established conclusively.

We also validated compatibility with the shared-wallet storage changes. Earlier
disposable-database checks exercised schema upgrade, rollback, and reapplication
while preserving synthetic EVM, Bitcoin, and Hedera address records. These checks
did not migrate a real user's wallet or database.

## 4. Research and security boundary

The integrated project now contains networked three-round Threshold Raccoon
signing between participants' browser workers, with coordinator verification
and execution through a verifier and smart account. Earlier local browser tests
demonstrated this flow on Anvil. This is a shared project achievement built on
Adhil's implementation, rather than a claim that all supported chains now accept
post-quantum native signatures.

Key provisioning still uses a trusted dealer. It is not distributed key
generation. Wallet secrets and participant shares use password-derived encryption
locally, and signing keys are handled in the browser worker. These are implemented
protections, not evidence of an independently audited production wallet. The
system still depends on conventional signatures for native chain transactions
and other authentication layers.

## 5. Testing and demonstrated results

The pre-push workspace run passed 481 TypeScript tests, including local EVM
integration cases; 20 environment-gated or utility cases were skipped.
The separately enabled smart-account suite then passed nine tests, leaving only
its vector-generation utility skipped. It exercised the verifier and account
against an isolated local Anvil chain. Backend
tests passed with the race detector. Workspace type checking, backend static
analysis, and the production frontend build also passed during merge validation.
Database-gated and public-chain tests are not covered by the latest default
backend run.

Secret scanning passed for the integration commit range, and the Go vulnerability
scan found no vulnerabilities. The JavaScript audit retains one low-severity
dependency advisory under an existing, time-limited project exception. It remains
a release-review item; we do not claim the codebase is free of vulnerabilities.

Earlier integration records document two successful shared-wallet browser tests:
two-of-three signing with local contract execution, and three-of-five approval
and encrypted share provisioning. Eight shared-wallet API integration tests
also passed against an isolated local chain. Following the RPC fix, four targeted
desktop/mobile proxy tests passed. These results are local automated evidence;
an Anvil instance using a Sepolia chain identifier is still a simulator.

We have not established successful public transfers on every configured testnet.
Network availability, balance reads, simulated signing, and a mined successful
public transaction must be recorded separately. The evidence record provides
implementation references and distinguishes earlier results from current checks.

## 6. Next milestone

Our next milestone is to verify complete user journeys on each public testnet
and record confirmed receipts, fees, balances, and failure handling. We also
need threshold-session interruption and recovery evaluation, cryptographic and
contract review, performance measurements, and a release assessment covering
password changes, encrypted storage, recovery, and account ownership.

Our progress is a substantial multi-chain implementation and integration
contribution. The next step is to turn that implementation into reproducible
network evidence and a reviewed release candidate while preserving the agreed
shared-wallet design.
