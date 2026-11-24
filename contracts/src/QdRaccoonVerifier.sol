// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {KeccakF1600} from "./KeccakF1600.sol";

/// @title Raccoon signature verifier for QD-Wallet account keys
/// @notice On-chain port of `verify` in packages/qd-crypto/src/raccoon.ts
/// (TRaccoon Alg. 3 / QD-Wallet Alg. 5 with pk_j as input). Same parameters,
/// encodings and hashes; no new cryptography:
///   - A ∈ R_q^{5×4} is expanded from seedA with SHAKE256 ("QD-A" XOF),
///   - c = ChalGen(keccak256("QD-Hc-v1" ‖ keccak256("QD-VK-v1" ‖ pk) ‖ msg ‖ w)),
///   - accept iff the encodings are canonical, ‖(z, 2^νw·h)‖² ≤ ⌊B²⌋ and
///     c == ChalGen(…, h + ⌊A·z − 2^νt·c·t⌉_νw).
///
/// Expanding A needs ~540 Keccak-f permutations, which is too expensive per
/// signature. `expandMatrix` therefore computes NTT(A_ij) on chain, once per
/// seedA, from seedA alone (nobody can supply a different matrix), and stores
/// each entry as contract code. `verify` reads those entries.
///
/// Arithmetic: products in R_q are computed as exact integer negacyclic
/// convolutions with one NTT modulo a 120-bit prime P (1024 | P − 1), then
/// reduced mod q. All operands are integers in [0, q) (or ±1 for c), so every
/// coefficient of A·z − 2^νt·c·t has |x| < 4·512·q² + 19·q < 2^110 < P/2 and
/// is recovered exactly. This is the same ring arithmetic as qd-crypto's
/// two-prime CRT NTT, with half the transforms.
///
/// Research-grade, unaudited, testnet only (ADR 0014, ADR 0019).
contract QdRaccoonVerifier {
    uint256 internal constant N = 512;
    uint256 internal constant K = 5;
    uint256 internal constant L = 4;
    uint256 internal constant ENTRIES = 20; // K·L
    uint256 internal constant OMEGA = 19;
    uint256 internal constant Q = 549824583172097; // p1·p2 = (2^25 − 2^18 + 1)(2^24 − 2^18 + 1)
    uint256 internal constant HALF_Q = 274912291586048; // (Q − 1) / 2
    uint256 internal constant Q_T = 4001;
    uint256 internal constant Q_W = 500;

    /// NTT prime P = 2^120 − 25599 ≡ 1 (mod 1024); ψ = 5^((P−1)/1024) has order 1024.
    uint256 internal constant P = 0xffffffffffffffffffffffffff9c01;
    uint256 internal constant HALF_P = 0x7fffffffffffffffffffffffffce00; // (P − 1) / 2
    uint256 internal constant PSI = 0x97c42d802af76bbe6c4c201367ea38;
    uint256 internal constant NINV = 1326631847355648459089541812115708979; // 512^{-1} mod P
    uint256 internal constant ENTRY_BYTES = 8192; // n × u128

    /// ⌊B²⌋ for B = NORM_BOUND in packages/qd-crypto/src/params.ts (B² is an
    /// integer as a float64; the TS check is `sqNorm > B·B`).
    uint256 public constant NORM_BOUND_SQ = 392795713433239459143880802304;
    uint256 public constant SIGNATURE_BYTES = 19494; // ω·2 + ℓ·n·7 + k·n·2
    uint256 public constant PUBLIC_KEY_BYTES = 5152; // 32 + k·n·2

    /// zetas[i] = ψ^{brv9(i)} mod P, n × u128 as contract code (after a STOP byte).
    address public immutable zetaData;

    /// matrix[seedA][i·ℓ + j] holds NTT_P(A_ij), n × u128 BE, as contract code (after a STOP byte).
    mapping(bytes32 => address[20]) internal matrix;

    event MatrixEntryExpanded(bytes32 indexed seedA, uint256 index, address data);

    error MatrixNotReady(bytes32 seedA);
    error BadEntryRange();
    error DeployFailed();

    constructor() {
        uint256 z;
        assembly {
            z := mload(0x40)
            mstore(0x40, add(z, 0x4000))
        }
        _makeZetas(z);
        zetaData = _storeU128(z);
    }

    function matrixEntry(bytes32 seedA, uint256 index) external view returns (address) {
        return matrix[seedA][index];
    }

    function matrixReady(bytes32 seedA) public view returns (bool) {
        address[20] storage m = matrix[seedA];
        for (uint256 i = 0; i < ENTRIES; i++) {
            if (m[i] == address(0)) return false;
        }
        return true;
    }

    /// @notice Expands entries [first, first + count) of A for seedA. Idempotent;
    /// callable by anyone, since the result depends only on seedA.
    function expandMatrix(bytes32 seedA, uint256 first, uint256 count) external {
        if (first >= ENTRIES || count == 0 || count > ENTRIES - first) revert BadEntryRange();
        address[20] storage m = matrix[seedA];
        uint256 z = _loadZetas();
        for (uint256 idx = first; idx < first + count; idx++) {
            if (m[idx] != address(0)) continue;
            address data = _expandEntry(seedA, idx, z);
            m[idx] = data;
            emit MatrixEntryExpanded(seedA, idx, data);
        }
    }

    /// keccak256("QD-VK-v1" ‖ pk), qd-crypto `publicKeyHash`.
    function publicKeyHash(bytes calldata pk) public pure returns (bytes32 h) {
        bytes memory buf = abi.encodePacked("QD-VK-v1", pk);
        h = keccak256(buf);
    }

    /// @notice Raccoon verification of `sig` on the 32-byte `message` under `pk`.
    /// Returns false for any invalid or non-canonical signature or key. Reverts
    /// only if the public matrix for pk's seedA has not been expanded yet.
    function verify(bytes calldata pk, bytes32 message, bytes calldata sig) external view returns (bool ok) {
        if (pk.length != PUBLIC_KEY_BYTES || sig.length != SIGNATURE_BYTES) return false;
        bytes32 seedA = bytes32(pk[0:32]);
        address[20] memory entries = matrix[seedA];
        for (uint256 i = 0; i < ENTRIES; i++) {
            if (entries[i] == address(0)) revert MatrixNotReady(seedA);
        }
        ok = _verify(pk, message, sig, entries);
    }

    // -------------------------------------------------------------------------
    // Storage of u128 tables as code (SSTORE2-style)
    // -------------------------------------------------------------------------

    /// Deploys 0x00 ‖ (512 words at src, each as u128 BE) and returns its address.
    function _storeU128(uint256 src) internal returns (address data) {
        uint256 ic;
        assembly {
            ic := mload(0x40)
            mstore(0x40, add(ic, 0x2100))
            // Init code (14 bytes): CODECOPY(0, 14, 0x2001); RETURN(0, 0x2001). Runtime = 0x00 ‖ data.
            mstore(ic, 0x612001600e6000396120016000f3000000000000000000000000000000000000)
            let d := add(ic, 15)
            for { let c := 0 } lt(c, 512) { c := add(c, 1) } {
                mstore(add(d, shl(4, c)), shl(128, mload(add(src, shl(5, c)))))
            }
            data := create(0, ic, add(14, 0x2001))
        }
        if (data == address(0)) revert DeployFailed();
    }

    /// Copies a stored u128 table into 512 words at dst.
    function _loadU128(address src, uint256 dst, uint256 buf) internal view {
        assembly {
            extcodecopy(src, buf, 1, 8192)
            for { let c := 0 } lt(c, 512) { c := add(c, 1) } {
                mstore(add(dst, shl(5, c)), shr(128, mload(add(buf, shl(4, c)))))
            }
        }
    }

    function _loadZetas() internal view returns (uint256 z) {
        assembly {
            z := mload(0x40)
            mstore(0x40, add(z, 0x6000))
        }
        _loadU128(zetaData, z, z + 0x4000);
    }

    // -------------------------------------------------------------------------
    // Matrix expansion: Xof("QD-A", seedA, [i, j]).uniformPoly() (qd-crypto
    // sample.ts), then NTT_P.
    // -------------------------------------------------------------------------

    function _expandEntry(bytes32 seedA, uint256 idx, uint256 z) internal returns (address data) {
        uint256 base;
        assembly {
            base := mload(0x40)
            // state (25 words) | scratch (25 words) | stream (108 blocks) | poly (512 words)
            mstore(0x40, add(base, 0x8000))
        }
        uint256 st = base;
        uint256 tmp = base + 0x320;
        uint256 stream = base + 0x640;
        uint256 a = base + 0x4000;
        assembly {
            calldatacopy(st, calldatasize(), 0x640) // zero state + scratch
            // Absorb one 136-byte block: 0x04 "QD-A" ‖ seedA ‖ i ‖ j ‖ pad.
            let blk := stream
            calldatacopy(blk, calldatasize(), 0x100)
            mstore8(blk, 4)
            mstore8(add(blk, 1), 0x51) // Q
            mstore8(add(blk, 2), 0x44) // D
            mstore8(add(blk, 3), 0x2d) // -
            mstore8(add(blk, 4), 0x41) // A
            mstore(add(blk, 5), seedA)
            mstore8(add(blk, 37), div(idx, 4))
            mstore8(add(blk, 38), mod(idx, 4))
            mstore8(add(blk, 39), 0x1f)
            mstore8(add(blk, 135), 0x80)
        }
        _absorbBlock(st, stream);
        KeccakF1600.permute(st, tmp);
        _squeezeBlock(st, stream);
        uint256 produced = 136;
        uint256 pos = 0;
        uint256 count = 0;
        while (count < N) {
            if (pos + 7 > produced) {
                // The stream buffer holds 108 blocks; ~27 are needed (2.3 % rejection).
                if (produced + 136 + 32 > 0x4000 - 0x640) revert DeployFailed();
                KeccakF1600.permute(st, tmp);
                _squeezeBlock(st, stream + produced);
                produced += 136;
            }
            uint256 v;
            assembly {
                v := and(shr(200, mload(add(stream, pos))), 0x1ffffffffffff)
            }
            pos += 7;
            if (v < Q) {
                assembly {
                    mstore(add(a, shl(5, count)), v)
                }
                count++;
            }
        }
        _nttForward(a, z);
        assembly {
            for { let c := 0 } lt(c, 512) { c := add(c, 1) } {
                let pp := add(a, shl(5, c))
                mstore(pp, mod(mload(pp), P))
            }
        }
        data = _storeU128(a);
    }

    function _absorbBlock(uint256 st, uint256 blk) private pure {
        assembly {
            function bswap64(x) -> y {
                x := or(shr(8, and(x, 0xff00ff00ff00ff00)), shl(8, and(x, 0x00ff00ff00ff00ff)))
                x := or(shr(16, and(x, 0xffff0000ffff0000)), shl(16, and(x, 0x0000ffff0000ffff)))
                y := or(shr(32, x), and(shl(32, x), 0xffffffff00000000))
            }
            for { let l := 0 } lt(l, 17) { l := add(l, 1) } {
                let lane := bswap64(shr(192, mload(add(blk, mul(l, 8)))))
                let p := add(st, mul(l, 32))
                mstore(p, xor(mload(p), lane))
            }
        }
    }

    function _squeezeBlock(uint256 st, uint256 dst) private pure {
        assembly {
            function bswap64(x) -> y {
                x := or(shr(8, and(x, 0xff00ff00ff00ff00)), shl(8, and(x, 0x00ff00ff00ff00ff)))
                x := or(shr(16, and(x, 0xffff0000ffff0000)), shl(16, and(x, 0x0000ffff0000ffff)))
                y := or(shr(32, x), and(shl(32, x), 0xffffffff00000000))
            }
            for { let l := 0 } lt(l, 17) { l := add(l, 1) } {
                mstore(add(dst, mul(l, 8)), shl(192, bswap64(mload(add(st, mul(l, 32))))))
            }
        }
    }

    // -------------------------------------------------------------------------
    // Negacyclic NTT mod P: Cooley–Tukey forward, Gentleman–Sande inverse,
    // zetas[i] = ψ^{brv9(i)} (the layout of qd-crypto ntt.ts). Polynomials
    // are 512 words in memory. Reduction is lazy: forward outputs are < 10·P,
    // inverse intermediates < 2^9·P; every product uses mulmod.
    // -------------------------------------------------------------------------

    function _makeZetas(uint256 z) internal pure {
        assembly {
            let x := 1
            for { let i := 0 } lt(i, 512) { i := add(i, 1) } {
                mstore(add(z, shl(5, i)), x)
                x := mulmod(x, PSI, P)
            }
            // In-place bit-reversal permutation (9 bits).
            let j := 0
            for { let i := 1 } lt(i, 512) { i := add(i, 1) } {
                let bit := 256
                for { } and(j, bit) { bit := shr(1, bit) } { j := xor(j, bit) }
                j := xor(j, bit)
                if lt(i, j) {
                    let pi := add(z, shl(5, i))
                    let pj := add(z, shl(5, j))
                    let t := mload(pi)
                    mstore(pi, mload(pj))
                    mstore(pj, t)
                }
            }
        }
    }

    /// Input coefficients < P (or any value < 2^124 with the same residue); outputs < 10·P.
    function _nttForward(uint256 a, uint256 z) internal pure {
        assembly {
            let k := 0
            for { let len := 256 } gt(len, 0) { len := shr(1, len) } {
                let len32 := shl(5, len)
                for { let start := 0 } lt(start, 512) { start := add(start, shl(1, len)) } {
                    k := add(k, 1)
                    let zeta := mload(add(z, shl(5, k)))
                    let pj := add(a, shl(5, start))
                    let end := add(pj, len32)
                    for { } lt(pj, end) { pj := add(pj, 32) } {
                        let pq := add(pj, len32)
                        let u := mload(pj)
                        let v := mulmod(zeta, mload(pq), P)
                        mstore(pj, add(u, v))
                        mstore(pq, sub(add(u, P), v))
                    }
                }
            }
        }
    }

    /// Input coefficients < P; outputs reduced (< P).
    function _nttInverse(uint256 a, uint256 z) internal pure {
        assembly {
            let k := 512
            let bigP := shl(10, P) // 2^10·P exceeds every intermediate
            for { let len := 1 } lt(len, 512) { len := shl(1, len) } {
                let len32 := shl(5, len)
                for { let start := 0 } lt(start, 512) { start := add(start, shl(1, len)) } {
                    k := sub(k, 1)
                    let zeta := sub(P, mload(add(z, shl(5, k))))
                    let pj := add(a, shl(5, start))
                    let end := add(pj, len32)
                    for { } lt(pj, end) { pj := add(pj, 32) } {
                        let pq := add(pj, len32)
                        let u := mload(pj)
                        let v := mload(pq)
                        mstore(pj, add(u, v))
                        mstore(pq, mulmod(zeta, sub(add(u, bigP), v), P))
                    }
                }
            }
            for { let i := 0 } lt(i, 512) { i := add(i, 1) } {
                let pi := add(a, shl(5, i))
                mstore(pi, mulmod(mload(pi), NINV, P))
            }
        }
    }

    // -------------------------------------------------------------------------
    // Verification
    // -------------------------------------------------------------------------

    // Memory regions (each 512 words = 0x4000 bytes) from a fresh base.
    uint256 private constant R_Z = 0; // zetas
    uint256 private constant R_C = 1; // NTT(c)
    uint256 private constant R_ZH = 2; // NTT(z_j) at 2 + j
    uint256 private constant R_ACC = 6;
    uint256 private constant R_T = 7;
    uint256 private constant R_ABUF = 8; // 8192 bytes (half a region)
    uint256 private constant R_WBUF = 9; // 8 + 32 + 32 + 5120 bytes, then scratch

    function _verify(bytes calldata pk, bytes32 message, bytes calldata sig, address[20] memory entries)
        internal
        view
        returns (bool)
    {
        uint256 base;
        assembly {
            base := mload(0x40)
            mstore(0x40, add(base, mul(10, 0x4000)))
        }
        _loadU128(zetaData, base + R_Z * 0x4000, base + R_ABUF * 0x4000);
        if (!_loadChallenge(sig, base)) return false;
        uint256 norm;
        bool ok;
        (ok, norm) = _loadResponse(sig, base);
        if (!ok) return false;
        uint256 hnorm;
        (ok, hnorm) = _hintNorm(sig);
        if (!ok) return false;
        if (norm + hnorm > NORM_BOUND_SQ) return false;

        bytes32 vk = publicKeyHash(pk);
        for (uint256 i = 0; i < K; i++) {
            if (!_row(pk, sig, entries, base, i)) return false;
        }
        return _challengeMatches(sig, base, vk, message);
    }

    /// Decodes c (ω × u16: bit 15 sign, bits 0–8 position), checks it, and stores NTT(c) (c_i ∈ {0, 1, P − 1}).
    function _loadChallenge(bytes calldata sig, uint256 base) private pure returns (bool ok) {
        uint256 c = base + R_C * 0x4000;
        assembly {
            calldatacopy(c, calldatasize(), 0x4000)
            ok := 1
            let used0 := 0
            let used1 := 0
            for { let i := 0 } lt(i, 19) { i := add(i, 1) } {
                let v := shr(240, calldataload(add(sig.offset, shl(1, i))))
                if and(v, 0x7e00) { ok := 0 }
                let pos := and(v, 511)
                switch lt(pos, 256)
                case 1 {
                    if and(shr(pos, used0), 1) { ok := 0 }
                    used0 := or(used0, shl(pos, 1))
                }
                default {
                    let b := sub(pos, 256)
                    if and(shr(b, used1), 1) { ok := 0 }
                    used1 := or(used1, shl(b, 1))
                }
                switch shr(15, v)
                case 1 { mstore(add(c, shl(5, pos)), sub(P, 1)) }
                default { mstore(add(c, shl(5, pos)), 1) }
            }
        }
        if (!ok) return false;
        _nttForward(c, base + R_Z * 0x4000);
    }

    /// Decodes z (ℓ·n × u56 < q), accumulates ‖z‖² (centred mod q), stores NTT(z_j).
    function _loadResponse(bytes calldata sig, uint256 base) private pure returns (bool ok, uint256 norm) {
        for (uint256 j = 0; j < L; j++) {
            uint256 d = base + (R_ZH + j) * 0x4000;
            bool good;
            uint256 s;
            assembly {
                good := 1
                let off := add(add(sig.offset, 38), mul(j, 3584)) // 512 × 7
                for { let i := 0 } lt(i, 512) { i := add(i, 1) } {
                    let v := shr(200, calldataload(add(off, mul(i, 7))))
                    if iszero(lt(v, Q)) { good := 0 }
                    let cv := v
                    if gt(v, HALF_Q) { cv := sub(Q, v) }
                    s := add(s, mul(cv, cv))
                    mstore(add(d, shl(5, i)), v)
                }
            }
            if (!good) return (false, 0);
            norm += s;
            _nttForward(d, base + R_Z * 0x4000);
        }
        ok = true;
    }

    /// Checks h (k·n × u16 < q_w) and returns ‖2^νw·h‖² (centred mod q).
    function _hintNorm(bytes calldata sig) private pure returns (bool good, uint256 s) {
        assembly {
            good := 1
            let off := add(sig.offset, 14374) // 38 + 14336
            for { let i := 0 } lt(i, 2560) { i := add(i, 1) } {
                let v := shr(240, calldataload(add(off, shl(1, i))))
                if iszero(lt(v, Q_W)) { good := 0 }
                let lv := shl(40, v) // < q for v < 500
                if gt(lv, HALF_Q) { lv := sub(Q, lv) }
                s := add(s, mul(lv, lv))
            }
        }
    }

    /// Row i: w_i = (h_i + ⌊A_i·z − 2^νt·c·t_i⌉_νw) mod q_w, written as u16 BE into the challenge buffer.
    function _row(bytes calldata pk, bytes calldata sig, address[20] memory entries, uint256 base, uint256 i)
        private
        view
        returns (bool good)
    {
        uint256 acc = base + R_ACC * 0x4000;
        uint256 abuf = base + R_ABUF * 0x4000;
        assembly {
            calldatacopy(acc, calldatasize(), 0x4000)
        }
        for (uint256 j = 0; j < L; j++) {
            address entry = entries[i * L + j];
            uint256 zh = base + (R_ZH + j) * 0x4000;
            assembly {
                extcodecopy(entry, abuf, 1, 8192)
                for { let c := 0 } lt(c, 512) { c := add(c, 1) } {
                    let pa := add(acc, shl(5, c))
                    let av := shr(128, mload(add(abuf, shl(4, c))))
                    mstore(pa, addmod(mload(pa), mulmod(av, mload(add(zh, shl(5, c))), P), P))
                }
            }
        }
        uint256 t = base + R_T * 0x4000;
        good = true;
        assembly {
            let off := add(add(pk.offset, 32), mul(i, 1024))
            for { let c := 0 } lt(c, 512) { c := add(c, 1) } {
                let tv := shr(240, calldataload(add(off, shl(1, c))))
                if iszero(lt(tv, Q_T)) { good := 0 }
                mstore(add(t, shl(5, c)), shl(37, tv)) // 2^νt·t < q for t < 4001
            }
        }
        if (!good) return false;
        _nttForward(t, base + R_Z * 0x4000);
        uint256 cc = base + R_C * 0x4000;
        assembly {
            for { let c := 0 } lt(c, 512) { c := add(c, 1) } {
                let o := shl(5, c)
                let pa := add(acc, o)
                mstore(pa, addmod(mload(pa), sub(P, mulmod(mload(add(cc, o)), mload(add(t, o)), P)), P))
            }
        }
        _nttInverse(acc, base + R_Z * 0x4000);
        uint256 wbuf = base + R_WBUF * 0x4000;
        assembly {
            let hoff := add(add(sig.offset, 14374), mul(i, 1024))
            let wout := add(add(wbuf, 72), mul(i, 1024))
            for { let c := 0 } lt(c, 512) { c := add(c, 1) } {
                // Exact integer x ∈ (−P/2, P/2), reduced to y = x mod q ∈ [0, q).
                let x := mload(add(acc, shl(5, c)))
                let y := mod(x, Q)
                if gt(x, HALF_P) { y := mod(sub(Q, mod(sub(P, x), Q)), Q) }
                let r := mod(shr(40, add(y, 0x8000000000)), Q_W) // ⌊y⌉_νw = ⌊(y + 2^39) / 2^40⌋ mod q_w
                let h := shr(240, calldataload(add(hoff, shl(1, c))))
                let w := mod(add(r, h), Q_W)
                let p := add(wout, shl(1, c))
                mstore8(p, shr(8, w))
                mstore8(add(p, 1), and(w, 0xff))
            }
        }
    }

    /// Recomputes ChalGen(keccak256("QD-Hc-v1" ‖ vk ‖ msg ‖ w)) and compares with the signature's c, in order.
    function _challengeMatches(bytes calldata sig, uint256 base, bytes32 vk, bytes32 message)
        private
        pure
        returns (bool same)
    {
        uint256 wbuf = base + R_WBUF * 0x4000;
        assembly {
            mstore(wbuf, 0x51442d48632d7631000000000000000000000000000000000000000000000000) // "QD-Hc-v1"
            mstore(add(wbuf, 8), vk)
            mstore(add(wbuf, 40), message)
            let seed := keccak256(wbuf, 5192)
            let scratch := add(wbuf, 0x1500)
            // Bitmap of positions already drawn, 512 bits at scratch + 64.
            function fresh(bm, pos) -> f {
                let slot := add(bm, shl(5, shr(8, pos)))
                let bit := shl(and(pos, 255), 1)
                let cur := mload(slot)
                f := iszero(and(cur, bit))
                mstore(slot, or(cur, bit))
            }
            mstore(add(scratch, 64), 0)
            mstore(add(scratch, 96), 0)
            same := 1
            let count := 0
            for { let ctr := 0 } lt(count, 19) { ctr := add(ctr, 1) } {
                mstore(scratch, seed)
                mstore(add(scratch, 32), shl(224, ctr))
                let blk := keccak256(scratch, 36)
                for { let b := 0 } and(lt(b, 16), lt(count, 19)) { b := add(b, 1) } {
                    let v := and(shr(sub(240, shl(4, b)), blk), 0xffff)
                    if fresh(add(scratch, 64), and(v, 511)) {
                        if iszero(eq(and(v, 0x81ff), shr(240, calldataload(add(sig.offset, shl(1, count)))))) { same := 0 }
                        count := add(count, 1)
                    }
                }
            }
        }
    }
}
