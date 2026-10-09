# ADR 0014: QD-Wallet protocol (Threshold Raccoon with stateless derivation)

- **Status:** Accepted for research and testnet use only. Not audited.
- **Spec:** §13.2, §15.6. Source analysis: [docs/qd-protocol/README.md](../qd-protocol/README.md)
- **Date:** 2026-09-25

## Context

D1 is now resolved. The QD research is *"QD-Wallet: An Efficient Quantum-Safe Stateless Threshold Deterministic Wallet"* (Thomas et al.). It is a post-quantum lattice threshold signature (Threshold Raccoon) with chaincode-based rerandomisation. It is **not** threshold ECDSA, so it cannot sign Ethereum EOA or Monero transactions.

The authors' C prototype is not available, and the paper omits several parameters. The user chose scope **"C then A"**: first a complete protocol module, then an on-chain smart-contract account on Anvil that verifies QD signatures.

## Decision

1. **Implement the protocol in TypeScript** as `packages/qd-crypto`. There is one implementation, used by the device and by the co-signer. A Go port would be a second implementation with no known-answer vectors to check it against.
2. **Parameters.** Ring and dimensions come from the QD paper (Raccoon-128: n = 512, q = (2^25−2^18+1)(2^24−2^18+1), k = 5, ℓ = 4, ω = 19). Widths and rounding come from TRaccoon Table 2 at λ = 128: σ_t = 2^20, σ_w·√T = 2^42, ν_t = 37, ν_w = 40. The norm bound comes from TRaccoon Lemma 7.1, with σ widened for the rerandomised secret.
   - The QD paper states (ν_w, ν_t) = (44, 42). With those values, TRaccoon's bound grows to ≈ 2^52.5, which is too close to the norm of a random vector (≈ 2^52.7) to mean anything. We therefore use TRaccoon's values.
   - q/2^37 = 4000.5004 does not meet TRaccoon's rounding condition, ⌊q/2^ν⌋ = ⌊q/2^ν⌉. We use q_t = ⌊q/2^ν⌉ = 4001, as the QD paper does (§4.1). Coefficients in [4000.5·2^37, q) round to 0 ≡ q, with an error below 2^{ν−1}, so the usual rounding bound still holds. t is only ever lifted back to Z_q and is never used in arithmetic mod q_t. Measured correctness: 0 failures in 120 signatures, with the largest norm at 0.49 of the bound.
3. **Derivation index ≠ signing session id.** `RandSK` and `RandPK` take `ρ = SHA3-256("QD-rho" ‖ ch ‖ u32 index)`, which fixes one key per account. Each signing run uses a fresh 32-byte `sid` for commitments, masks and MACs, and parties refuse to reuse one. The paper's `sid = H(m ‖ ctr)` would change the key with every message.
4. **Consistent rerandomiser.** `RandPK` uses `ch`, like `RandSK`. The paper's Alg. 3 uses `seed_{i,j}` here, which would give key pairs that don't match. The constant term f(0) is short, uniform in [−2^20, 2^20). Higher coefficients are uniform in R_q.
5. **Hashes.** SHAKE256 for expansion (A, PRF, f), as in the paper. **Keccak-256** for the public-key hash and for the challenge `c = ChalGen(keccak256("QD-Hc-v1" ‖ H(vk) ‖ msg32 ‖ w))`, so that an EVM verifier can recompute it with the native opcode. The QD paper does not specify H_c.
6. **Round-2 authentication** uses pairwise SHA3 MACs keyed from the dealer's pairwise seeds. This is TRaccoon §6.1's alternative to per-party signatures, and it keeps the authentication post-quantum.
7. **Exactly T signers.** |act| = T, as in QD Alg. 4. The per-signer width σ_w = 2^42/√T assumes this. N ≤ 64.
8. **Fixed-width encodings** for on-chain use: the signature is 19,494 bytes (the paper's ≈ 13 kB relies on compression) and the public key is 5,152 bytes.

## Consequences

- **Trusted dealer.** The device sees `msk` during setup and must erase it afterwards. Distributed key generation is future work in the paper.
- **Semi-honest model.** The paper proves security only against passive corruption. A compromised co-signer that deviates from the protocol is outside the proof. Commitments, MACs and a verify-before-release step in `combine` catch the deviations we test for, but they are not a malicious-security proof.
- **No constant-time guarantee.** The Gaussian sampler uses floating point and branches, which is acceptable for research only.
- **Performance** (JS, i5-1035G1): verification takes 8–16 ms, flat in T. A 2-of-3 signature takes ≈ 50 ms of computation per signer, plus network round trips.
- **Security level not re-estimated.** TRaccoon's 128-bit claim covers its own parameter set. Our deviations (the wider session secret, the rounding modulus) have not been run through the lattice estimator.
- Next steps: the co-signer service (party P2) and a Solidity verifier with a smart-contract account on Anvil (route A in the analysis).
