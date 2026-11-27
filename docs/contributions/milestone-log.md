# Contribution milestone log

## 26 November 2026 - Simplified shared-wallet experience

**Problem:** The shared page exposed three full blockchain implementations and
cryptographic setup information together, making routine wallet tasks difficult
to find.

**Delivered:** A short group overview, familiar asset names, Receive/Request
actions and separate asset, payment, activity, people and setup views. Optional
technical information is expandable. Safety comparisons, payment review and
recovery remain available. Task changes preserve mounted forms/signing state.

**Contribution boundary:** Our UI work preserves Adhil's authentication,
provisioning, Raccoon and EVM design, and the existing native-chain extensions.
There is no backend or cryptographic package change. Individual wallet pages,
state and send/receive implementations are unchanged.

**Validation:** 233 web unit tests passed with 3 skipped. Web type checking and
the production build passed for all 17 routes. A syntax-aware comparison found
54 signing, approval and account-action calls unchanged. Browser evidence is
recorded in the linked change record: 22 cases passed, including all 16 existing
individual-wallet checks, three responsive task/review cases and the EVM/Bitcoin,
five-participant and simulated Hedera acceptance scenarios. These are local tests.

**Limitations:** Balances and activity remain per asset; no combined valuation,
native post-quantum signature support, Android package or release certification
is introduced.

**Next:** Gather user feedback on routine tasks and continue the separately
documented public-network, recovery, accessibility and security release work.

**References:** [Implementation and evidence](../changes/2026-11-26-shared-wallet-usability.md).

## 26 November 2026 - Equal individual and shared wallet modes

**Problem:** Shared Wallet appeared as a secondary item within the individual
wallet's navigation rather than a distinct, equally visible wallet experience.

**Delivered:** Equal Individual Wallet and Shared Wallet choices; separate
shared navigation, group selection, request/receive entry points and contextual
device settings. Session-only navigation hints preserve the individual account
and network settings. Switching is disabled during an individual send.

**Contribution boundary:** Our presentation and navigation work reuses Adhil's
existing shared-wallet architecture and the native-chain extensions. No key
derivation, password storage, approval, Raccoon or native signing rules changed.

**Validation:** 229 web unit tests passed with 3 skipped. All 16 existing
individual browser cases passed across desktop and mobile; three new viewport
cases verified mode switching and preservation of individual state. The shared
three-profile signing, five-participant provisioning and simulated Hedera
regressions passed, bringing the local browser total to 22 passing cases.
Web type checking and the 17-route static build passed. These are local checks.

**Limitations:** Shared content still uses the existing detailed dashboard.
Navigation memory is session-only. Physical-device accessibility, Android
packaging and public-network verification are outside this milestone.

**Next:** Review the two-mode experience, then refine shared account/request
screens and the responsive visual design without altering signing behaviour.

**References:** [Implementation and evidence](../changes/2026-11-26-wallet-modes.md).

## 26 November 2026 - Native wallet recovery and coordinated group migration

**Problem:** Shared native accounts needed portable recovery and safe roster
changes. Editing application membership cannot revoke Bitcoin/Hedera keys.

**Delivered:** Bitcoin encrypted own-share recovery and saved-byte retry,
versioned fresh signing-session contributions, explicit signer selection and
exhaustion-safe change metadata. Added the approved two-group migration review,
quorum confirmations, native spending guard, nominated Bitcoin sweep evidence,
both-quorum Hedera key updates, persistent partial recovery and revised reviews.

**Contribution boundary:** Our native-chain integration and release hardening
reuse Adhil's authentication, identities, provisioning, Raccoon implementation
and EVM flow. The project owner approved this lifecycle extension. It introduces
no native MPC, DKG or post-quantum Bitcoin/Hedera consensus claim.

**Validation:** 533 default workspace tests passed with 26 skipped; twelve type
checks and the production build passed. Backend race/static checks and disposable
PostgreSQL persistence checks passed. Eight separately enabled Bitcoin Core
regtest tests passed, including migration sweep acceptance. Hedera's three-profile
simulated browser journey and migration-review tampering checks passed.

**Limitations:** No public-chain transaction was performed. A complete two-group
browser migration, archived/lost-device authorization recovery, independent
security review and measured operational performance remain release gates.

**Next:** Finish those release gates, then seek an explicitly authorized public
Testnet verification session before considering mainnet.

**References:** [Detailed implementation and evidence](../changes/2026-11-26-native-wallet-release-hardening.md),
[approved lifecycle](../adr/0024-native-shared-wallet-release-hardening.md).


## 26 November 2026 - Shared Hedera native custody and Raccoon approval

**Problem:** Hedera worked as a personal native HBAR wallet but lacked shared
native custody, joint policy verification and Raccoon-gated shared payments.

**Delivered:** Independent deterministic participant keys, native majority
threshold accounts, personal-payer account creation, full-key account linking,
shared receive and balances, reviewed HBAR proposals, Raccoon signing with fresh
signer contributions, native signature collection, receipts, history and explorer
links. Added reservations, saved-byte retries and encrypted per-device recovery.

**Contribution boundary:** Our Hedera extension reuses Adhil's authentication,
shared-account identities, provisioning and Raccoon engine. We preserved the
existing EVM and Bitcoin flows and the base membership lifecycle.

**Validation:** Cryptographic and SDK interoperability tests, worker authorization
and recovery tests, relay/device tests and disposable PostgreSQL migration tests.
The browser journey uses simulated Mirror/HAPI responses; public Testnet
consensus execution remains unverified. The completion evidence is in the record
below.

**Limitations:** Native signatures remain conventional. Mainnet, account-key
rotation, complete archived-epoch/device recovery and scheduled signing are
unfinished release work. Membership must remain fixed during funded testing.

**Next:** Review coordinated native key rotation before modifying the base
membership lifecycle, then explicitly authorized Testnet verification and
independent security/performance evaluation.

**References:** [Implementation and evidence](../changes/2026-11-26-shared-hedera.md),
[design and release boundaries](../adr/0023-shared-hedera-native-threshold-and-raccoon.md).

## 24 November 2026 - Shared Bitcoin quorum and Raccoon approval

**Problem:** The personal Bitcoin signing path did not provide shared native
custody or enforce Raccoon approval in the QD-Wallet signer.

**Delivered:** Separate deterministic native keys and majority P2WSH multisignature;
proved enrollment and policy comparison; Bitcoin-specific Raccoon commitments,
networked signing rounds, locally verified approvals, native signatures and
explicit submission. Added device-bound public-message persistence, permanent
session burn records and encrypted retention of pinned-policy shares.

**Contribution boundary:** Our Bitcoin extension reuses Adhil's Raccoon engine,
share provisioning, encrypted storage and shared-account identities. The EVM
protocol is preserved; its session burn storage is tightened atomically across
tabs. We do not attribute inherited cryptographic work to this extension.

**Validation:** Focused cryptographic/native signing tests, Bitcoin Core regtest
payment and restored-change spending, relay and disposable PostgreSQL race tests,
and a three-device browser signing journey. Bitcoin browser network data are
simulated; native consensus is checked separately using local Bitcoin Core.
The existing shared Ethereum browser journey also passed on local Anvil.

**Limitations:** Research preview with mainnet disabled. Bitcoin cannot enforce
Raccoon on-chain. Trusted-dealer provisioning remains. Policy/share recovery,
membership migration, alternate signer selection and proposal recovery need
further work before release. No public-network transaction is claimed.

**Next:** Recovery and adversarial review, explicitly authorized Testnet4 testing,
and performance evaluation.

**References:** [Implementation and evidence](../changes/2026-11-24-shared-bitcoin-raccoon.md),
[approved design and limits](../adr/0022-shared-bitcoin-native-multisig-and-raccoon.md).

## 24 November 2026 - Bitcoin change and UTXO hardening

**Problem:** Reused change addresses and single-address reads prevented a proper
multi-address Bitcoin workflow. Spending required stronger previous-output and
review verification.

**Delivered:** Internal change derivation without changing legacy receive
addresses; discovery, balances/history and signing across owned internal keys;
raw previous-output checks, atomic input reservations and persisted signed
payments, and explicit retry controls.

**Contribution boundary:** Our Bitcoin follow-up. Adhil's shared-wallet design
and Threshold Raccoon implementation are preserved. A separate Bitcoin Raccoon
approval proposal was prepared at this milestone; the later shared Bitcoin
entry above records its separately approved implementation.

**Validation:** New security/discovery tests, real Chromium cross-tab storage
checks, and SegWit/Taproot Bitcoin Core regtest payment/change-spend tests passed.
See the detailed change record for validation scope.

**Limitations:** Provider-dependent chain status, browser-local coordination,
bounded recovery and unfinished release controls remain. No public Testnet4
payment or independent security audit is claimed.

**Next:** Review the Raccoon custody proposal and complete public-network and
release security evaluation.

**References:** [Change record](../changes/2026-11-24-bitcoin-change-security.md),
[approved address design](../adr/0021-bitcoin-change-recovery-and-utxo-validation.md),
[Raccoon proposal](../architecture/bitcoin-raccoon-approval-proposal.md).

## 24 November 2026 - Main integration and reliability

**Problem:** Our older multi-chain workspace and the newer shared-wallet baseline
needed to be reconciled without dropping either contribution.

**Delivered:** Combined the existing work, retained the newer stabilization and
security changes, preserved both histories, corrected RPC read handling, and
added chain-specific shared-wallet funding estimates and native currency labels.

**Contribution boundary:** Our integration and fixes build on Adhil's existing
shared-wallet protocol, provisioning, signing, contracts, and stabilization.
No redesign of that architecture was introduced.

**Validation:** Type checking, production build, backend static analysis, and
automated tests passed. The pre-push TypeScript run passed 481 tests with 20
skipped; the backend race-detector run passed.
The separately enabled smart-account suite passed nine tests, with only its
vector-generation utility skipped. Earlier local browser and
database results are identified separately in the evidence record.

**Limitations:** Public-chain transfers were not performed for this milestone.
Trusted-dealer provisioning remains. This is not a security audit or a production
release certification.

**Next:** Public-testnet journeys, threshold failure handling, cryptographic
review, and performance evaluation.

**References:** [Evidence record](evidence-2026-11-24.md),
[integration checkpoint](../changes/2026-11-24-main-integration.md).

## Entry format for subsequent milestones

Use a dated heading and the same six fields: Problem, Delivered, Contribution
boundary, Validation, Limitations, and Next. Include references to evidence.
Distinguish implementation completion from local simulation and public-network
verification. Do not attribute inherited work solely to the person who merged it.
