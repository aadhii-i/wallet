# Shared wallets: 50% multi-participant authorization

Status: approval layer implemented and tested; Threshold Raccoon key generation and share provisioning implemented ([shared-wallet-key-generation.md](shared-wallet-key-generation.md)); networked signing and on-chain execution **pending**. Decision record: [ADR 0017](../adr/0017-shared-wallet-approval-policy-separate-from-raccoon-threshold.md).

## 1. Model

| Concept | Where | Notes |
|---|---|---|
| Wallet profile | `shared_wallets` | Name, policy (version, numerator, denominator, rounding), `membership_version`, `key_status` |
| Participants | `shared_wallet_members` | One per (wallet, user) while not revoked. Bound to the user **and** the device key that accepted the invitation. Roles `owner`/`member`; statuses `active`/`suspended`/`revoked` |
| Invitations | `shared_wallet_invitations` | One-time code, stored only as SHA-256; 72 h expiry; `invited`/`accepted`/`rejected`/`revoked` |
| Accounts | `shared_accounts` | QD derivation index under the wallet's (future) Raccoon key. **No Ethereum address** yet |
| Proposals | `proposals` | Immutable transaction intent + frozen policy/participant snapshot + digest |
| Votes | `proposal_votes`, `proposal_vote_nonces` | Signed approve/reject, one per participant per proposal |
| Signing jobs | `signing_jobs` | Created exactly once when a proposal reaches its threshold |

HD wallets (`wallets`, `accounts`) and ECDSA signing are unchanged. Adding an account never adds a participant; adding a participant never adds an account.

## 2. Policy

`required = ceil(activeParticipants × numerator / denominator)`, default 1/2 (`internal/authorization`). Examples: 1→1, 2→1, 3→2, 4→2, 5→3, 10→5, 11→6, 30→15, 64→32. The policy module accepts 100→50, but shared wallets are capped at **64 active participants** because `dealerKeyGen` refuses N > 64.

Evaluation of a proposal uses only its stored snapshot:
- `approvals ≥ required` → **approved** (threshold reached) and a signing job is created.
- `participantCount − rejections < required` → **rejected** (threshold unreachable). A single rejection is a vote, not a veto.
- otherwise **pending**. Expired proposals become **expired**.

A join or revocation increments `membership_version`, marks pending and approved-but-unsigned proposals **superseded** (snapshots preserved), and flips an `active` key to `rekey_required`. New proposals use the new count (10→5, 11→6, 12→6).

## 3. Canonical encodings

Proposal digest = `SHA-256(utf8(S))`, where `S` is `|`-joined:

```
QDWallet-Proposal | v1 | proposalId | walletId | accountId | derivationIndex | initiatorParticipantId
| chainId | to (lowercase) | valueWei | data (lowercase 0x hex) | nonce | gasLimit | maxFeePerGas
| maxPriorityFeePerGas | policyVersion | numerator | denominator | rounding | membershipVersion
| participantCount | requiredApprovals | eligibleParticipantIds (sorted, comma-joined) | expiresAt (Unix s)
```

Vote message (signed with the participant's P-256 device key, IEEE P1363):

```
QDWallet-Vote|v1|{approve|reject}|proposalId|walletId|digestHex|policyVersion|membershipVersion|participantId|nonce|issuedAt
```

Implementations: `services/wallet-api/internal/sharedwallet/canonical.go` and `packages/rpc/src/shared-wallets.ts`, pinned to one vector (`ca4d341e…69321`) computed independently with Python `hashlib`. The client recomputes the digest from what it displays and refuses to sign on mismatch, inconsistent snapshots, or fields that could alter the encoding.

## 4. Vote processing (security)

1. Session auth (existing middleware) → active participant of the proposal's wallet, else 404.
2. The request must come from the device bound to the participant (`WRONG_DEVICE`).
3. Client digest must equal the stored digest, which must equal a recomputation (`DIGEST_MISMATCH`).
4. `issuedAt` within ±5 minutes; signature verified against the stored device key (`VOTE_SIGNATURE_INVALID`).
5. Atomically: claim the single-use nonce (bound to participant + proposal, 2-minute TTL; spent even if the vote is refused), check pending and unexpired, check active and in the snapshot, insert (unique per participant), recount, transition, create the signing job once. Postgres uses one transaction with lock order wallet → proposal → member; revocations take the wallet row `FOR UPDATE`, so they wait for in-flight votes.

Every membership, proposal and vote action is written to the hash-chained audit log (ADR 0012).

## 5. Cryptographic boundary

`packages/qd-crypto/test/authorization-compat.test.ts` shows, in-process only, that the first ⌈N/2⌉ approvers' shares from `dealerKeyGen(⌈N/2⌉, N)` sign the 32-byte proposal digest with the unchanged `QdParty` rounds. Fewer than T cannot sign; a key for N = 10 cannot serve N = 11.

**Implemented since:** trusted-dealer key generation with HPKE X-Wing share delivery to each participant's device ([shared-wallet-key-generation.md](shared-wallet-key-generation.md), [ADR 0018](../adr/0018-shared-wallet-trusted-dealer-keygen-and-hpke-share-delivery.md)). Networked signing and on-chain execution followed ([shared-wallet-signing-and-execution.md](shared-wallet-signing-and-execution.md), [ADR 0019](../adr/0019-networked-threshold-raccoon-signing-and-qdaccount-execution.md)).

An approved proposal is signed by its T selected signers' devices and executed through the account's `QdAccount` contract; `proposal.lifecycle` reports each stage honestly.

## 6. Security limitations

- Approvals are authenticated with classical P-256 device keys: **not post-quantum**.
- Key generation uses a trusted dealer (the owner's device) who sees the master secret and could sign alone.
- Revoking a participant does not cryptographically invalidate a share; only a new key generation does.
- Semi-honest security model for Raccoon (ADR 0014). Research/testnet only.
- The Postgres store has not been integration-tested in this environment (no Postgres available); the in-memory store is covered by race-detector tests. The shared-wallet and key-generation suites run against Postgres when `TEST_DATABASE_URL` is set: `TEST_DATABASE_URL=postgres://… go test ./internal/sharedwallet`.

## 7. Local multi-user testing

Prerequisites: Go 1.26+, Node 22+, pnpm via corepack. No Docker or database needed (in-memory store).

```bash
make install
make api                      # wallet-api on :8080, STORE=memory (state is lost on restart)
make web                      # web app on :3000
```

`make api` allows the origin `http://localhost:3000` and sets `DEV_CREDENTIAL_RATE_BURST=200`: the normal per-IP limit on `/v1/auth/*` (about 5 device registrations per burst) would otherwise block registering many users from one machine. The setting is refused when `APP_ENV=production`. Each **browser profile / incognito window** has its own IndexedDB device key and therefore is an **independent user** — this is the only "seeding" needed; there is no backdoor to create users.

1. Open 5 isolated sessions (e.g. Chrome profiles, or one normal + several incognito windows of *different* browsers — incognito windows of the same browser share state). In each, create a local wallet (onboarding) so the app is unlocked.
2. **P1:** open **Shared** → *Create shared wallet*. Dashboard shows *Participants: 1, Required approvals: 1*.
3. **P1:** *Invite participant* four times; each code is shown once — copy it.
4. **P2–P5:** **Shared** → *Join with invitation code* → paste → *Accept*. All dashboards now show *Participants: 5, Authorization policy: 50%, Required approvals: 3*.
5. **P1:** *Add account*, then *New proposal*: 1 ETH to `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`, network Anvil. Review shows "This transaction requires approval from 3 of 5 participants."
6. **P1** approves, **P2** approves → *2/3 approvals*, status pending, no signing.
7. **P3** approves → *3/3*, **Threshold reached**, status *Threshold reached — awaiting key generation*; P4/P5 can no longer vote.
8. Continue with key generation: [shared-wallet-key-generation.md §6](shared-wallet-key-generation.md#6-manual-test-5-browsers).
9. Try: P2 voting again (button gone; API returns `DUPLICATE_VOTE`), owner revoking P5 (open proposals become superseded; new proposals need 2 of 4).

Automated:

```bash
make test-go                  # policy, shared-wallet service (race-safe concurrency), store
cd packages/rpc && npx vitest run         # digest vector + vote-refusal tests
# HTTP integration: 10 independent users, concurrent final approval, forged votes, revocation
(cd services/wallet-api && HTTP_ADDR=:8181 METRICS_ADDR=:9191 APP_ENV=development STORE=memory \
   PRICE_PROVIDER=static DEV_CREDENTIAL_RATE_BURST=200 go run ./cmd/wallet-api) &
cd packages/rpc && QD_API_URL=http://localhost:8181 npx vitest run test/shared-wallets.integration.test.ts
cd packages/rpc && QD_API_URL=http://localhost:8181 npx vitest run test/shared-keygen.integration.test.ts  # key generation, real crypto
cd packages/qd-crypto && npx vitest run   # incl. approval ↔ Raccoon compatibility, keygen + Shamir checks
cd packages/wallet-core && npx vitest run # HPKE envelopes, dealer/recipient checks, encrypted share store
make build && make e2e-shared # 5 browser contexts: approvals, then key generation and share provisioning
# If :8080 is taken: NEXT_PUBLIC_API_URL=http://localhost:8282 pnpm --filter @qd/web build && QD_E2E_API_PORT=8282 make e2e-shared
```

No real funds are involved: proposals never reach a chain.
