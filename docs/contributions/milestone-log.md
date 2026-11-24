# Contribution milestone log

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
