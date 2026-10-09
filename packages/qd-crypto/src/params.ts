/**
 * QD-Wallet parameters. See docs/qd-protocol/README.md §1.2 and ADR 0014.
 *
 * Ring and dimensions follow the QD-Wallet paper (§7): Raccoon-128 with
 * n = 512, q = p1·p2, (k, ℓ) = (5, 4), ω = 19. The Gaussian widths and the
 * rounding shifts come from Threshold Raccoon, Table 2 (λ = 128), because the
 * QD paper does not specify them and TRaccoon's correctness bound (Lemma 7.1)
 * is stated for exactly these values.
 */

/** Ring degree n of R_q = Z_q[X]/(X^n + 1). */
export const N = 512;

/** q = p1·p2 with both primes ≡ 1 (mod 2n), so each has a negacyclic NTT. */
export const P1 = 33_292_289; // 2^25 − 2^18 + 1
export const P2 = 16_515_073; // 2^24 − 2^18 + 1
/** 549 824 583 172 097 < 2^49: every value mod q is exact in a float64. */
export const Q = P1 * P2;

/** A ∈ R_q^{k×ℓ}. */
export const K = 5;
export const L = 4;

/** Challenge weight: c has exactly ω coefficients in {−1, +1}. */
export const OMEGA = 19;

/** Bits dropped from the verification key t and from the commitment w. */
export const NU_T = 37;
export const NU_W = 40;
/** Rounded moduli q_ν = ⌊q / 2^ν⌉ (QD paper §4.1). */
export const Q_T = Math.round(Q / 2 ** NU_T); // 4001
export const Q_W = Math.round(Q / 2 ** NU_W); // 500

/** Width of the secret s and key noise e. */
export const SIGMA_T = 2 ** 20;
/** σ_w·√T: the aggregated commitment randomness always has this width. */
export const SIGMA_W_TOTAL = 2 ** 42;

/**
 * Bound B on the constant term f(0) of the rerandomisation polynomial.
 * Coefficients are uniform in [−B, B), the "DecodeSmall" option of QD §5.1.
 * f(0) must be short, or s + f(0) would break the norm check (README §2.3).
 */
export const DERIVE_BOUND = 2 ** 20;

/** Largest supported party count. Dealer seeds grow as N². */
export const MAX_PARTIES = 64;

export const SEED_BYTES = 32;
export const MSG_BYTES = 32;

/** Per-signer commitment width for an active set of size T. */
export function sigmaW(threshold: number): number {
  return SIGMA_W_TOTAL / Math.sqrt(threshold);
}

/**
 * Two-norm bound on (z, 2^νw·h), from TRaccoon Lemma 7.1:
 *   B = e^{1/4}·(ω·σ_s + √T·σ_w)·√(n(k+ℓ)) + (ω·2^νt + 2^{νw+1})·√(nk).
 * σ_s is the width of the session secret s + f(0). This is wider than σ_t
 * because of rerandomisation (QD Thm 1 overlooks this; README §2.3).
 * √T·σ_w is constant, so the bound does not depend on T.
 */
export const SIGMA_SESSION = Math.sqrt(SIGMA_T ** 2 + DERIVE_BOUND ** 2 / 3);
export const NORM_BOUND =
  Math.exp(0.25) * (OMEGA * SIGMA_SESSION + SIGMA_W_TOTAL) * Math.sqrt(N * (K + L)) +
  (OMEGA * 2 ** NU_T + 2 ** (NU_W + 1)) * Math.sqrt(N * K);
