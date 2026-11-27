# Shared wallet usability improvements

Review date: 26 November 2026.

## What changed

The shared group now opens on a short overview with its name, participant count,
required approvals, Receive and Request payment actions, and a list of assets.
Users open one asset at a time instead of scrolling through three complete
blockchain implementations. Ethereum and its compatible networks are labelled
"Ethereum & networks"; Bitcoin and Hedera use their familiar names. We do not
show an invented combined balance or treat an unavailable balance as zero.

Balances/receiving, payment requests, activity, people/invitations and wallet
setup have separate views. The selected asset remains selected when moving to
Requests or Activity. Existing Bitcoin and Hedera section links remain useful,
and browser back/forward restores the appropriate view. The wallet-mode selector
stays available at the top when moving between tasks.

Cryptographic setup, share unlocking, backup controls, membership migration and
technical identifiers remain available in clearly labelled views or expandable
sections. Required safety-number comparisons and confirmations are preserved.
The test-network notice remains visible; its expandable security explanation
retains the trusted-dealer, conventional-signature and unaudited-verifier limits.

Payment wording is simpler: users review a payment and create a payment request.
The recipient, amount, network, fee settings, expiry and required approvals remain
visible for review. Non-empty contract data and fee settings also remain visible
on the request card before another participant approves it. Contract data is
shown in the review, with optional input and
raw protocol settings available under Advanced settings. Routine request cards
keep technical identifiers in an expandable section.

## Architecture and contribution boundary

This is our presentation and navigation contribution. Adhil's authentication,
provisioning, Raccoon protocol and EVM execution flow are preserved, together with
the existing native Bitcoin/Hedera custody and migration rules. The selected
asset is a display choice; it does not derive a different key or change any
participant's authority. There is no new credential or key-storage format.

Task panels remain mounted when hidden. Switching views does not discard an
unfinished request or stop an already approved signing round. Changing groups
still mounts a separate dashboard, keeping one group's forms separate from
another's. Leaving the shared page, locking and recovery retain their existing
behaviour; this milestone does not add persistent draft recovery.

The individual wallet's pages, account/network controls, personal state, and
send/receive implementations are unchanged. Shared navigation now uses in-page
hash changes for task selection; ordinary individual navigation keeps its
existing routes. No backend, cryptographic package, dependency or deployment
configuration change was needed for this milestone.

## Verification

- Web unit suite: 233 passed, 3 skipped, including four new task-navigation checks.
- Web type checking and the production build passed; all 17 routes were exported.
- A syntax-aware comparison found 54 existing signing, approval and account-action
  calls unchanged against the pre-simplification checkpoint. This checks the
  scope of the change and is not a cryptographic security audit.

- The three responsive browser cases passed at 1440, 390 and 320 pixels wide.
  They cover task/asset selection, hidden unrelated panels, preserved payment
  drafts and selected EVM network, browser back/forward, visible wallet modes,
  no horizontal overflow, receive/send navigation and unchanged individual
  account/network metadata. They also review non-empty contract data and verify
  its visibility on an unsigned local request before approval. These requests
  are not approved or broadcast by the responsive tests. The three layouts were
  visually inspected.
- The shared three-profile signing journey passed, including native Bitcoin
  signatures against simulated chain data and Raccoon-authorized EVM execution,
  receipts and history on local Anvil. The five-participant approval and key
  provisioning journey also passed. Existing tests were updated to navigate
  between tasks and use the new labels; their signing/approval assertions remain.
- The shared Hedera three-profile journey passed with simulated Mirror/HAPI
  responses, including account creation, quorum signing, HBAR payment and the
  migration review/tampering checks. It does not demonstrate public consensus.
- All 16 existing individual-wallet browser cases passed across desktop and
  mobile, covering onboarding, restore, account repair, receive, local sending,
  lock/unlock, API interactions and security headers. Together with the three
  responsive cases and three shared acceptance scenarios, 22 browser cases passed.
- The changed-source credential scan passed with no findings. Browser traces
  are excluded from source backups; layout previews and validation logs are
  retained outside the repository.

## Remaining boundaries

The final branch checkpoint passed 543 workspace tests with 26 skipped and all
12 workspace type checks. This includes the 233 web unit tests above. The
staged-source credential scan found no leaks. The 52 changed native-core and
backend files match the earlier verified native-hardening checkpoint; their
backend race/static, database and regtest evidence is recorded in that milestone.

Asset cards lead to the existing per-network balances; there is no new combined
portfolio valuation. Shared activity is viewed by asset, using the existing
history and saved-payment implementations. Mainnet release, public-testnet
verification, independent security review and Android packaging remain separate
work. This change does not make native Bitcoin/Hedera signatures post-quantum or
replace trusted-dealer provisioning with distributed key generation.
