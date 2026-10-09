# QD-Wallet protocol: source, summary and integration analysis

- **Source (D1):** M. Thomas, Panchami V, A. Sebastian, S. Shahi, S. Eswaran, *"QD-Wallet: An Efficient Quantum-Safe Stateless Threshold Deterministic Wallet"*, manuscript submitted to the International Journal of Information Security (Springer). IIIT Kottayam / Curtin University.
- **Base scheme:** Threshold Raccoon (TRaccoon). Del Pino, Katsumata, Maller, Mouhartem, Prest, Saarinen, EUROCRYPT 2024.
- **Status of this document:** analysis for M7 planning. Nothing here has been externally reviewed.

## 1. What the paper proposes

QD-Wallet is a **post-quantum (lattice-based), stateless, threshold, deterministic wallet**:

| Property | How it is achieved |
|---|---|
| Post-quantum | Signatures are Threshold Raccoon (Module-LWE / Module-SIS), not ECDSA |
| Threshold | The master secret `msk` is Shamir-shared among N parties; any T can sign |
| Deterministic | Session keys are derived from the master key and a chaincode `ch` |
| Stateless | Derivation needs only `(ch, sessID)`, with no evolving state shared between parties |
| Unlinkable | Without `ch`, session public keys cannot be linked to `mpk` or to each other (Thm 1, Thm 4) |

### 1.1 Algorithms (as written in the paper)

| # | Algorithm | Summary |
|---|---|---|
| 1 | `KGen(λ,T,N)` | **Trusted dealer** samples `A`, `(msk,e)`, sets `t = A·msk + e`, Shamir-shares `msk` → `s_i`, gives each party a signing key pair for authentication and pairwise PRF seeds `seed_{i,k}`, samples chaincode `ch`. |
| 2 | `RandSK` | `ρ_j = H(ch ‖ sessID_j)`, `f_j = PolyFromSeed(ρ_j, T−1)`, `s_{j,i} = s_i + f_j(i)`. This is a valid Shamir sharing of `msk + f_j(0)`. |
| 3 | `RandPK` | `t_j = ⌊t + A·f_j(0)⌉_{νt}`, `pk_j = (A, t_j)`. |
| 4 | `Sign` | TRaccoon 3 rounds. (1) commit `cmt = H(w_k)` and publish the row blinder `m_k`. (2) reveal `w_k` with an authentication signature. (3) response `z_k = c·λ_k·s_{j,k} + r_k + m*_k`. The combiner forms `z = Σ(z_k − m_k)` and hint `h`, giving `σ = (c, z, h)`. |
| 5 | `Verify` | Standard Raccoon verification against `pk_j`: norm bounds, then `c == H(pk, m, h + ⌊A·z − 2^{νt}·c·t_j⌉_{νw})`. |

### 1.2 Parameters used in the paper's prototype (§7)

Raccoon-128. `n = 512`, `q = p1·p2 = 33 292 289 × 16 515 073` (= `(2^25−2^18+1)(2^24−2^18+1)`, 49-bit), `k = 5`, `ℓ = 4`, challenge weight `ω = 19`, `(νw, νt) = (44, 42)`, secrets in `{−1,0,1}`, masks in `[−2^44, 2^44]`, SHAKE256 for seed expansion. Sizes: public key ≈ 2.3 kB, **signature ≈ 13 kB**. Verification takes ≈ 0.1–0.2 ms in C.

**Missing from the paper:** the norm bounds `β_z`, `β_w`, the per-signer Gaussian widths for noise flooding, and the exact `DecodeSmall` / `PolyFromSeed` encoding. We took these from Threshold Raccoon (ePrint 2024/184), Table 2 and Lemma 7.1. The choices are recorded in [ADR 0014](../adr/0014-qd-wallet-protocol-threshold-raccoon-with-stateless-derivation.md).

### 1.3 Security model stated by the paper

- **Semi-honest (passive)** adversary with static corruption. Malicious security is left to future work, via zero-knowledge proofs.
- **Trusted-dealer key generation.** Distributed key generation is future work.
- Quantum random oracle model.

## 2. Consequences for this wallet

### 2.1 QD signatures cannot sign Ethereum or Monero transactions directly

Ethereum externally-owned accounts only accept secp256k1 ECDSA, and Monero only accepts CLSAG / Ed25519. A Raccoon signature is valid only where a verifier for Raccoon exists. The practical routes are:

| Route | What it means | Cost / caveat |
|---|---|---|
| **A. On-chain verifier (smart account)** | An ERC-4337-style smart-contract account whose `validateUserOp` runs Raccoon verification in Solidity. The account "address" is the contract, and its owner is `pk_j`. | ≈ 13 kB of calldata per transaction (≈ 200k gas for calldata alone). Verifying needs NTT arithmetic mod a 49-bit composite plus SHAKE256, and the EVM has no precompile for either. This is likely several million gas per transaction, which is realistic on Anvil or a testnet only. Gas figures are estimates until measured. |
| **B. Off-chain authorisation layer** | Transactions are still signed with ECDSA (HD now, threshold ECDSA later). A QD threshold signature over the transaction is **required by the co-signer** before it releases its ECDSA share or approval. | Real PQ protection only for the authorisation step, **not on chain**. It must not be marketed as quantum-safe custody. |
| **C. Standalone protocol module** | `packages/qd-crypto` implements and tests the full protocol (keygen, derivation, 3-round signing between device and co-signer, verify), with benchmarks that reproduce the paper's Table 3. It is shown in the app as "QD vault (research)" signing messages, not moving funds. | No on-chain effect. This is the smallest honest scope. |

These routes build on each other. C is a prerequisite of both A and B.

### 2.2 The session ID must be an account index, not `H(m ‖ ctr)`

Algorithm 4 derives `sid = H(m ‖ ctr)` from the **message**, and uses that same `sid` to derive `pk_j`. A blockchain address has to exist *before* it receives funds, and every later transaction from it must verify under the *same* key. So in a wallet:

- **Derivation ID** = account index (the analogue of a BIP-44 `account/index`). It is fixed per account and feeds `RandSK` / `RandPK`.
- **Signing session ID** = fresh and unique per signing run. It feeds `Hcom`, the PRF blinders and the authentication signatures.

These must be separate values. If one fixed value served both roles, every signature from an account would reuse the same PRF blinders `m_k`, `m*_k`. The masks would then cancel between two signatures, which removes the protection TRaccoon gets from its one-time zero shares.

### 2.3 Inconsistencies to resolve with the authors

| Where | Issue | Our interpretation |
|---|---|---|
| Alg. 3 vs Alg. 2/4 | `RandPK` derives `ρ_j` from the pairwise `seed_{i,j}`, but `RandSK` and `Sign` use `ch`. These would give non-matching key pairs. | Use `ρ_j = H(ch ‖ derivationID)` in both. |
| §5.1 | `PolyFromSeed` is described as "indistinguishable from uniform in R_q" but also as using `DecodeSmall`. If `f_j(0)` were uniform, `s + f_j(0)` would not be short, `z` would fail the norm check, and signing would break. | Constant term `f_j(0)` is **short** (same distribution as secret coefficients). Higher coefficients are uniform in R_q, since they only randomise shares. |
| Alg. 1 line 3 | `t = A·msk + e` is kept unrounded, whereas TRaccoon publishes `⌊t⌉`. | `mpk` stays private to the parties. Only rounded session keys `t_j` are ever published. |
| Alg. 4 line 21 | `c = H_c(pk_j, m_j, w_j)`. Here `m_j` also names the row blinder. | `m_j` is the message, as in TRaccoon. |
| Alg. 5 | Verification recomputes `pk_j` from `ch`. A public verifier (a chain) does not have `ch`, and giving it `ch` would break unlinkability. | Verification takes `pk_j` as input, which is plain Raccoon verification. |
| Thm 1 | Claims `s + s̃` is distributed like `S`. The sum of two Gaussians has width `√2·σ`, not `σ`. | Parameters must account for the wider session secret. This needs checking against TRaccoon's bounds. |

### 2.4 Trust model mapped onto our 2-of-3 topology

The spec (§15.2) already plans for device (P1), co-signer server (P2) and recovery share (P3), with T = 2 and N = 3. Mapped onto QD-Wallet:

- **Dealer** = the user's device, during wallet creation. It samples `msk`, distributes the shares, then **erases `msk`**. This is the weakest point: the device holds the full key at setup. This is inherent to the paper's Alg. 1 until DKG exists.
- **`ch`** is secret to the parties. Anyone who holds `ch` and sees all session keys can link them, but cannot sign.
- **Semi-honest only.** In our topology the server is a party. A *malicious* co-signer (for example, a compromised server) is outside the paper's proven model. Until malicious security is added, the co-signer must be treated as honest-but-curious, and we should say so in the UI and docs.
- Recovery (P3) works because any 2 shares can sign. There is no proactive share refresh in the paper, so refresh stays out of scope.

## 3. Implementation constraints

- The authors' C17 prototype is **not** included with the paper. If it can be obtained, compiling it to WASM (web) and linking it natively or through cgo (server) avoids divergence between two implementations.
- Without it, we write a TypeScript implementation (`packages/qd-crypto`) and a Go implementation of the same protocol for the co-signer. Both would be checked against shared known-answer vectors.
- There is no audited Raccoon or TRaccoon library. Everything here is **research-grade, testnet only** (spec §15.6).
- Cross-checks available: the Raccoon NIST submission's reference implementation and its KATs, for the single-signer verification path.

## 4. Implementation status

`packages/qd-crypto` implements Algs. 1–5 with the interpretations in §2.3 and the decisions in ADR 0014:

| Module | Contents |
|---|---|
| `keys.ts` | Trusted-dealer `KGen`, `rerandomizer` (ρ, f), `derivePublicKey` (RandPK), `deriveShare` (RandSK) |
| `signing.ts` | `QdParty` state machine (ShareSign 1/2/3, sid-reuse guard, commitment and MAC checks), `combine`, `signLocally` |
| `raccoon.ts` | Public-matrix expansion, Keccak-based challenge, hint, `verify` |
| `encoding.ts` | Fixed-width signature (19,494 B) and public-key (5,152 B) formats for the EVM verifier |

Tests: `corepack pnpm@9.15.0 --filter @qd/qd-crypto test`. Benchmarks: `corepack pnpm@9.15.0 --filter @qd/qd-crypto bench` (override with `QD_BENCH_T=2,4,16`).

Measured latency in ms, mean ± sd over 4 trials, T = N, per-signer ShareSign. TypeScript on Node 24, Intel i5-1035G1 laptop:

| T | KeyGen | RandSK | RandPK | SS1 | SS2 | SS3 | Combine | Verify |
|---|---|---|---|---|---|---|---|---|
| 2 | 37.8±11.9 | 4.5±0.6 | 9.4±3.4 | 22.3±6.1 | 7.6±1.2 | 22.8±0.8 | 36.9±4.5 | 15.9±2.3 |
| 4 | 31.9±3.9 | 6.4±1.4 | 5.3±1.4 | 17.3±3.8 | 5.9±0.9 | 20.4±1.3 | 18.2±2.7 | 7.7±1.3 |
| 16 | 208±33 | 33.9±4.8 | 4.7±1.3 | 29.4±2.6 | 20.4±2.0 | 78.8±3.8 | 24.7±6.1 | 8.1±2.9 |
| 64 | 3217±161 | 111±24 | 6.4±3.2 | 88.3±2.8 | 84.5±6.4 | 310±7 | 42.0±8.4 | 7.6±2.4 |

The two-tier shape matches the paper's Fig. 3. RandPK and Verify stay flat in T, while KeyGen, RandSK and ShareSign grow with T. Absolute numbers are 10–100× the paper's C timings, as expected for JavaScript.
