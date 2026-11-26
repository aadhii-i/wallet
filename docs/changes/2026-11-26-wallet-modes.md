# Individual and shared wallet modes

Review date: 26 November 2026.

The later [shared-wallet usability milestone](2026-11-26-shared-wallet-usability.md)
replaces the initial long dashboard with separate task views. This record retains
the evidence for introducing the two wallet modes.

## Purpose and delivered behaviour

We promoted Shared Wallet from a secondary navigation item to an equal wallet
mode beside Individual Wallet. Both choices appear at the top of the wallet
on laptop and phone layouts when the existing shared-wallet feature is enabled.
The active choice is labelled for assistive technology as well as highlighted
visually.

Individual Wallet retains its account and network selectors, balances, assets,
activity, receive screen, send flows and device security controls. Returning to
it restores the last eligible individual screen in the current browser session.
The mode switch does not change the selected individual account, network,
Bitcoin address type, custom RPC settings or balance visibility. During an
individual send, switching modes is disabled until the user finishes or cancels
that send.

Shared Wallet has its own navigation for overview, accounts, payment requests
and activity, with participants and security available in the desktop rail and
existing shared sections. A group selector allows switching between shared
wallets. Request payment and Receive links lead to the existing EVM, Bitcoin
Testnet4 and Hedera Testnet sections. They do not submit a transaction. The
existing signing and approval controls remain responsible for each payment.

Device settings and security are common to both modes. When opened from Shared
Wallet, an explanatory notice and a return link preserve the shared context.
The selected group is remembered while moving between the two modes in the
current open session.

## Implementation boundaries

The route determines which mode is displayed. Individual transaction routes
cannot be relabelled as Shared Wallet by a mode query parameter. Navigation
hints live in a separate, memory-only store containing public screen and group
references. No wallet-storage schema, account derivation, password protection,
key-share storage, blockchain configuration or signing protocol changes were
needed.

The individual home, assets, activity and send pages, account/network/receive
controls and personal state/hooks have no source changes in this milestone.
Fifteen sensitive native-wallet, worker and signing files were also compared
with the pre-UI hardening checkpoint and were unchanged.

Each selected shared group mounts a separate dashboard instance so form state
from one group is not carried into another. Section links reuse the existing
shared components rather than introducing a second payment implementation.
The existing shared feature flag remains in control; this milestone does not
enable shared wallets in deployment configuration.

Adhil's authentication, shared-wallet provisioning, Threshold Raccoon engine,
approval rules and EVM execution flow are preserved. Our contribution here is
the mode navigation, group presentation and regression coverage. Existing
native-chain integration and migration work is documented separately in the
[native wallet hardening record](2026-11-26-native-wallet-release-hardening.md).

## Verification

The following checks passed against the implementation:

| Check | Observed result and scope |
| --- | --- |
| Web unit tests | 229 passed, 3 skipped; includes six new navigation-boundary checks. The passing full run limited parallel workers to two. |
| Existing individual browser suite | All 16 cases passed across desktop Chrome and a mobile browser profile. Covers creation, restore, account recovery, receive, local ETH sending, lock/unlock, API interactions and security headers. |
| New mode browser suite | All three viewport cases passed: 1440, 390 and 320 pixels wide. Covers two-group selection, mode return, unchanged individual public account/settings metadata, receive QR, send guard and absence of horizontal page overflow. |
| Shared signing browser regression | The three-profile journey passed with Raccoon approvals, native Bitcoin signatures using simulated chain data, and EVM execution/receipts on local Anvil. Its return to personal history now uses the Individual Wallet mode switch. |
| Shared group browser regression | The five-participant, three-approval journey and Threshold Raccoon key provisioning passed using the local API and separate browser profiles. |
| Shared Hedera browser regression | The three-profile account creation, native quorum, Raccoon approval and HBAR payment journey passed with simulated Mirror/HAPI responses. This does not verify public Hedera consensus. |
| Type checking and static build | Web type checking passed; all 17 routes built successfully with shared wallets enabled. |
| Changed-source credential scan | Passed with no findings; generated browser traces were excluded from the source scan and were not added to documentation or source backups. |

Browser checks use disposable local profiles and a local API. ETH execution is
against local Anvil. Mode checks create local shared groups but do not send
payments. These results do not demonstrate public-testnet or mainnet execution.
The desktop and phone screenshots were visually inspected and are retained
outside the repository rather than added to the supervisor report.

An initial browser test setup used a static-server API policy that differed
from the built app's API address. The passing individual run used a dedicated
test configuration that aligns those addresses and starts and stops its local
services. No application security-header relaxation was made. An earlier
unbounded unit run encountered a timeout under concurrent build/test load;
the complete run with bounded parallelism passed without changing its assertion.

## Remaining work

This milestone establishes the two wallet modes and clearer shared entry
points. The shared sections still use the existing long-form dashboard; a
further visual redesign can be reviewed independently. Remembered navigation
is session-only, and the existing unlock/reload route behaviour is unchanged.
There is no new combined multi-chain balance calculation or Android application.

Future UI work should refine the shared account and request screens, review
accessibility on physical devices, and plan an Android shell with deliberate
secure-storage and recovery choices. Public-network verification, independent
security review and the native membership/recovery release gates remain
separate requirements; this navigation change does not certify release readiness.
