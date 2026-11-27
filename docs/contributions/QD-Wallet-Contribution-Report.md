# QD-Wallet — Implementation Contribution Report

**Supervisor review | 26 November 2026**

## 1. Our contribution in context

Our contribution has been to extend QD-Wallet beyond its initial Ethereum
implementation and integrate different blockchain models into the wallet. We
worked on additional EVM testnets, Bitcoin, Hedera, account handling, transaction
flows and integration reliability. We then connected this work to the shared
wallet so participants can jointly manage native Bitcoin and HBAR accounts.

Adhil developed the shared-wallet foundation, participant approval flow,
Threshold Raccoon provisioning and networked signing, and the smart-account
execution path, together with subsequent stabilization. Our native integrations
build on that work. We identify the inherited foundation separately from our
chain-specific implementation and hardening.

## 2. Multi-blockchain development

### Additional EVM networks

Base Sepolia, Arbitrum Sepolia and Polygon Amoy are configured alongside
Ethereum Sepolia. They use the common network selector, EVM account derivation
and transaction handling. Our funding estimates account for differences in
network fee models, including rollup posting costs and Polygon's suggested price
floor. Amoy displays its native currency as POL.

Configuration and shared functionality establish implementation coverage, but
they do not prove that every public testnet transfer succeeds. These networks
still need individually recorded live transaction evidence.

### Bitcoin

We implemented personal Bitcoin receiving and sending with native SegWit and
optional Taproot addresses. Bitcoin spends specific unspent transaction outputs,
so we added its own input selection, fee estimation, transaction construction,
local signing and broadcast flow. Fresh change addresses use a separate,
deterministic branch while preserving existing receive addresses. Discovery,
previous-transaction checks and persistent reservations support recovery and
help prevent accidental conflicting payments.

We also added a separate shared Bitcoin account. Each participant holds an
independent native key, and Bitcoin requires a majority of those keys to spend.
Before releasing a native signature, each QD-Wallet signer verifies a Threshold
Raccoon approval over the reviewed transaction. The proposer can select the
required Raccoon participants. We added encrypted own-share backups, saved
transaction recovery, history and explicit submission controls.

Bitcoin still verifies conventional native signatures. Raccoon is an additional
application approval layer; a colluding native quorum can bypass it using other
software. Our implementation does not make native Bitcoin consensus quantum-safe.

### Hedera

Our personal Hedera work covers deterministic keys, account creation using a
funded payer, account registration, ownership checks, HBAR balances, transfers,
receipts and history. Hedera assigns a numeric account identifier; deriving a
key alone does not create a usable network account.

We extended this to shared HBAR accounts with independent participant keys and
a native majority threshold. Every participant verifies the complete account
key and confirms the same policy and account number. Shared payments use an
exact transaction review, Raccoon rounds, verified native signatures, a fee cap
and a visible signing deadline. We save signed bytes before submission and
require the matching successful operation before reporting confirmation.

Encrypted backups retain each participant's own share, policy and saved
transaction evidence. A recovery phrase alone cannot recreate a Raccoon share.
The HBAR integration does not claim support for every Hedera asset or service.
Monero remains outside the implemented shared native signing scope.

## 3. Architecture and security improvements

Native participant keys use separate deterministic namespaces for each shared
wallet, account, network and membership context. Existing personal addresses and
EVM derivation remain compatible. Private material stays in participant signing
workers; the coordinator stores public policies and signing messages.

We strengthened signing-session recovery with fresh randomness from the selected
participants and permanent records of used sessions. Restoring a backup retains
those records and does not revive old consent or secret signing rounds. Backup
imports verify the native key, participant context, Raccoon key and saved signed
transactions before installing recovered state.

We also implemented the approved native group-migration workflow. Both old and
incoming groups confirm the same destinations, policies, Bitcoin coin snapshot
and fee limits. The old roster stays available while ordinary native spending
is paused. Bitcoin uses reviewed sweeps to the replacement script. Hedera keeps
its account number and changes its complete threshold key, requiring both old
and new native quorums and separate Raccoon approvals.

Activation requires verification of every nominated migration result. Uncertain
or partial completion remains recoverable. Revised coin snapshots or fee budgets
need fresh confirmations from both groups. Existing EVM accounts stay in the old
group and use their existing approval workflow. Old Bitcoin policies must be
retained for omitted coins and later deposits.

## 4. Testing and demonstrated results

The current workspace automated run passed **533 tests**, with **26 skipped**
opt-in or utility cases. All twelve type-check tasks, the production frontend
build, backend static analysis and backend race-detector tests passed. Disposable
PostgreSQL checks exercised the native relays, membership protection and migration
persistence, including conflicting and stale updates.

The separately enabled shared Bitcoin Core regtest suite passed eight tests. It
checked native quorum payments, spending change and acceptance of a migration
sweep to an independent group's script. Regtest is a private local network; these
results are not public Testnet4 transaction evidence.

The Hedera browser journey used three separate browser profiles, real Raccoon
rounds and native signatures, with local network simulation. It demonstrated
shared account creation, an HBAR payment, matching receipts and history. The
migration review screen also stopped activity when its commitment was changed.
Worker tests exercised two independent groups authorizing a Hedera key update
and recovering its exact signed transaction. These are separate layers of local
evidence, rather than a completed public-chain migration demonstration.

## 5. Research and release direction

The project now connects our native-chain work to Adhil's networked Threshold
Raccoon signing foundation. This gives us a practical setting for evaluating
threshold authorization, deterministic key management, recovery and membership
changes across different blockchains.

Provisioning still uses a trusted dealer, and native chain signatures remain
conventional. Device authentication and recovery also need further review. We
therefore describe this milestone as release hardening, not certification of a
production wallet or proof of end-to-end post-quantum security.

The next milestone is an explicitly authorized public Testnet evaluation,
including complete two-group migration journeys, interrupted signing, uncertain
submission and recovery. Independent cryptographic and application review,
archived-policy and device-authorization recovery, and measured performance on
supported browsers remain necessary before release.
