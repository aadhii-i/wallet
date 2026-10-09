import { sha3_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { mulModQ } from './field';
import { DERIVE_BOUND, K, L, MAX_PARTIES, NU_T, Q_T, SEED_BYTES, SIGMA_T } from './params';
import { addQ, addVecQ, matVec, roundPoly, type PolyVec } from './poly';
import { expandA, type PublicKey } from './raccoon';
import { Xof, gaussianVec, randomBytes, u32be } from './sample';

/**
 * Master key material that every party holds. The unrounded t = A·msk + e is
 * never published; only rounded, rerandomised account keys are (README §2.3).
 */
export interface MasterPublic {
  seedA: Uint8Array;
  tFull: PolyVec;
}

/** Party i's long-term key share: msk_i in QD-Wallet Alg. 1. */
export interface KeyShare {
  index: number;
  threshold: number;
  parties: number;
  /** s_i = P(i), a Shamir share of msk. */
  share: PolyVec;
  /** seedsOut[j−1] = seed_{i,j}; seedsIn[j−1] = seed_{j,i}. */
  seedsOut: Uint8Array[];
  seedsIn: Uint8Array[];
  master: MasterPublic;
  chaincode: Uint8Array;
}

export interface DealerOutput {
  master: MasterPublic;
  chaincode: Uint8Array;
  shares: KeyShare[];
}

export function assertThreshold(threshold: number, parties: number): void {
  if (
    !Number.isInteger(threshold) ||
    !Number.isInteger(parties) ||
    threshold < 1 ||
    threshold > parties ||
    parties > MAX_PARTIES
  ) {
    throw new Error(`qd-crypto: invalid (T, N) = (${threshold}, ${parties})`);
  }
}

/** Σ_m coeffs[m]·x^m over R_q^ℓ, for a small integer x (Horner). */
function evalVecPoly(coeffs: PolyVec[], x: number): PolyVec {
  let acc: PolyVec = coeffs[coeffs.length - 1].map((p) => p.slice());
  for (let m = coeffs.length - 2; m >= 0; m--) {
    acc = acc.map((p, j) => {
      const scaled = p.map((c) => mulModQ(c, x));
      return addQ(scaled, coeffs[m][j]);
    });
  }
  return acc;
}

/**
 * QD-Wallet Alg. 1: trusted-dealer key generation.
 *
 * In this wallet the dealer is the user's device during setup. It must drop
 * the returned object once the shares are distributed, because msk can be
 * reconstructed from any T of them. See ADR 0014, "trusted dealer".
 */
export function dealerKeyGen(threshold: number, parties: number): DealerOutput {
  assertThreshold(threshold, parties);
  const seedA = randomBytes(SEED_BYTES);
  const A = expandA(seedA);
  const msk = gaussianVec(L, SIGMA_T);
  const e = gaussianVec(K, SIGMA_T);
  const tFull = addVecQ(matVec(A, msk), e);
  const master: MasterPublic = { seedA, tFull };

  // P(X) = msk + a_1·X + … + a_{T−1}·X^{T−1}, with uniformly random a_m ∈ R_q^ℓ.
  const shamir = [msk];
  const coeffSeed = randomBytes(SEED_BYTES);
  for (let m = 1; m < threshold; m++) {
    const xof = new Xof('QD-shamir', coeffSeed, u32be(m));
    shamir.push(Array.from({ length: L }, () => xof.uniformPoly()));
  }

  const seeds = Array.from({ length: parties }, () =>
    Array.from({ length: parties }, () => randomBytes(SEED_BYTES)),
  );
  const chaincode = randomBytes(SEED_BYTES);

  const shares = Array.from({ length: parties }, (_, idx): KeyShare => {
    const i = idx + 1;
    return {
      index: i,
      threshold,
      parties,
      share: evalVecPoly(shamir, i),
      seedsOut: seeds[idx],
      seedsIn: seeds.map((row) => row[idx]),
      master,
      chaincode,
    };
  });
  return { master, chaincode, shares };
}

// ---------------------------------------------------------------------------
// Stateless deterministic derivation (QD-Wallet Algs. 2 and 3)
// ---------------------------------------------------------------------------

export interface Rerandomizer {
  /** f_j(X) coefficients in R_q^ℓ; f_j(0) is short. */
  coeffs: PolyVec[];
}

function assertDerivationIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error('qd-crypto: derivation index must be a u32');
  }
}

/**
 * ρ_j = H(ch ‖ ID_j), f_j = PolyFromSeed(ρ_j, T − 1).
 * ID_j is the account's derivation index. The QD paper uses H(m ‖ ctr), which
 * would tie the key to a single message (README §2.2).
 */
export function rerandomizer(chaincode: Uint8Array, index: number, terms: number): Rerandomizer {
  assertDerivationIndex(index);
  const rho = sha3_256(concatBytes(new TextEncoder().encode('QD-rho'), chaincode, u32be(index)));
  const coeffs: PolyVec[] = [];
  for (let m = 0; m < terms; m++) {
    const xof = new Xof('QD-f', rho, u32be(m));
    coeffs.push(
      Array.from({ length: L }, () => (m === 0 ? xof.smallPoly(DERIVE_BOUND) : xof.uniformPoly())),
    );
  }
  return { coeffs };
}

/** RandPK: t_j = ⌊t + A·f_j(0)⌉_νt. Needs only f_j(0), so its cost is independent of T. */
export function derivePublicKey(master: MasterPublic, chaincode: Uint8Array, index: number): PublicKey {
  const f0 = rerandomizer(chaincode, index, 1).coeffs[0];
  const shifted = addVecQ(master.tFull, matVec(expandA(master.seedA), f0));
  return { seedA: master.seedA, t: shifted.map((p) => roundPoly(p, NU_T, Q_T)) };
}

/** RandSK: s_{j,i} = s_i + f_j(i). */
export function deriveShare(key: KeyShare, index: number): PolyVec {
  const f = rerandomizer(key.chaincode, index, key.threshold);
  return addVecQ(key.share, evalVecPoly(f.coeffs, key.index));
}

export function accountPublicKey(key: KeyShare, index: number): PublicKey {
  return derivePublicKey(key.master, key.chaincode, index);
}
