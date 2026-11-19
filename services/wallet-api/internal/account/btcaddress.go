package account

// btcAddressFromPubKey derives the Bitcoin address for a compressed secp256k1
// public key.  It mirrors the derivation in packages/wallet-core/src/derivation:
//
//   - P2WPKH: bech32 v0, witness program = RIPEMD160(SHA256(pubkey))
//   - P2TR:   bech32m v1, witness program = x(lift_x(x(P)) + t*G) where
//             t = tagged_hash("TapTweak", x(P))
//
// The result is always lowercase.

import (
	"crypto/sha256"
	"fmt"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"golang.org/x/crypto/ripemd160"
)

func btcAddressFromPubKey(compressedPubKey []byte, addressType, network string) (string, error) {
	hrp, err := hrpForNetwork(network)
	if err != nil {
		return "", err
	}
	switch addressType {
	case "p2wpkh":
		program := hash160(compressedPubKey)
		return encodeSegwitAddress(hrp, 0, program)
	case "p2tr":
		program, err := taprootOutputKey(compressedPubKey)
		if err != nil {
			return "", err
		}
		return encodeSegwitAddress(hrp, 1, program)
	default:
		return "", fmt.Errorf("unsupported address type %q", addressType)
	}
}

func hrpForNetwork(network string) (string, error) {
	switch network {
	case "mainnet":
		return "bc", nil
	case "testnet4":
		return "tb", nil
	default:
		return "", fmt.Errorf("unknown bitcoin network %q", network)
	}
}

// hash160 computes RIPEMD160(SHA256(b)), the witness program for P2WPKH.
func hash160(b []byte) []byte {
	h := sha256.Sum256(b)
	r := ripemd160.New()
	r.Write(h[:])
	return r.Sum(nil)
}

// taprootOutputKey computes the BIP-341 key-path output key x-coordinate from
// a compressed secp256k1 public key.  It applies the TapTweak tagged hash and
// returns the 32-byte x-only tweaked output key.
//
// BIP-341 specifies the internal key as lift_x(x(P)), which always has even Y.
// If the compressed public key has odd Y (prefix 0x03), we negate the point
// before adding the tweak — exactly what lift_x does.
func taprootOutputKey(compressedPubKey []byte) ([]byte, error) {
	pubKey, err := secp256k1.ParsePubKey(compressedPubKey)
	if err != nil {
		return nil, fmt.Errorf("parse pubkey: %w", err)
	}
	// x-only internal key (32 bytes, used as the tweak input).
	xOnly := compressedPubKey[1:] // strip the 02/03 prefix
	tweak := tapTweakHash(xOnly)

	// Convert to affine Jacobian so Y is accessible with magnitude 1.
	var internalPoint secp256k1.JacobianPoint
	pubKey.AsJacobian(&internalPoint)
	internalPoint.ToAffine()

	// BIP-341 §Script validation rules: "Let P = lift_x(x(key))".
	// lift_x always returns the point with even Y. If Y is odd, negate it.
	internalPoint.Y.Normalize()
	if internalPoint.Y.IsOdd() {
		// Negate Y: Y → p − Y.  Magnitude 1 → Negate expects magnitude ≤ 63.
		internalPoint.Y.Negate(1).Normalize()
	}

	// Q = lift_x(P) + t·G
	var tweakScalar secp256k1.ModNScalar
	tweakScalar.SetByteSlice(tweak)
	var tweakPoint, outputPoint secp256k1.JacobianPoint
	secp256k1.ScalarBaseMultNonConst(&tweakScalar, &tweakPoint)
	secp256k1.AddNonConst(&internalPoint, &tweakPoint, &outputPoint)
	outputPoint.ToAffine()

	// Extract x-only output key.
	outputPubKey := secp256k1.NewPublicKey(&outputPoint.X, &outputPoint.Y)
	serialized := outputPubKey.SerializeCompressed()
	return serialized[1:], nil // 32-byte x-only
}

// tapTweakHash computes the BIP-341 tagged hash:
//
//	SHA256(SHA256("TapTweak") || SHA256("TapTweak") || xOnlyKey)
func tapTweakHash(xOnlyKey []byte) []byte {
	tag := []byte("TapTweak")
	tagHash := sha256.Sum256(tag)
	h := sha256.New()
	h.Write(tagHash[:])
	h.Write(tagHash[:])
	h.Write(xOnlyKey)
	return h.Sum(nil)
}

// --- bech32 / bech32m encoding -------------------------------------------
// Minimal implementation covering P2WPKH (v0, bech32) and P2TR (v1, bech32m).
// Avoids adding an external dependency; the logic mirrors BIP-173 / BIP-350.

const bech32Alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

func encodeSegwitAddress(hrp string, version int, program []byte) (string, error) {
	const bech32Const uint32 = 1
	const bech32mConst uint32 = 0x2bc830a3

	var checkConst uint32
	if version == 0 {
		checkConst = bech32Const
	} else {
		checkConst = bech32mConst
	}

	// Convert 8-bit program to 5-bit words.
	words5, err := convertBits(program, 8, 5, true)
	if err != nil {
		return "", err
	}
	// Prepend witness version.
	data := make([]byte, 0, 1+len(words5)+6)
	data = append(data, byte(version))
	data = append(data, words5...)
	// Compute checksum.
	checksum := bech32CreateChecksum(hrp, data, checkConst)
	data = append(data, checksum...)

	var sb []byte
	sb = append(sb, []byte(hrp)...)
	sb = append(sb, '1')
	for _, b := range data {
		sb = append(sb, bech32Alphabet[b])
	}
	return string(sb), nil
}

func bech32CreateChecksum(hrp string, data []byte, constant uint32) []byte {
	values := append(bech32HrpExpand(hrp), data...)
	polymod := bech32Polymod(append(values, 0, 0, 0, 0, 0, 0)) ^ constant
	ret := make([]byte, 6)
	for i := range ret {
		ret[i] = byte((polymod >> (5 * (5 - i))) & 31)
	}
	return ret
}

func bech32Polymod(values []byte) uint32 {
	gen := [5]uint32{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	chk := uint32(1)
	for _, v := range values {
		top := chk >> 25
		chk = (chk&0x1ffffff)<<5 ^ uint32(v)
		for i := 0; i < 5; i++ {
			if (top>>uint(i))&1 == 1 {
				chk ^= gen[i]
			}
		}
	}
	return chk
}

func bech32HrpExpand(hrp string) []byte {
	out := make([]byte, 0, len(hrp)*2+1)
	for i := 0; i < len(hrp); i++ {
		out = append(out, hrp[i]>>5)
	}
	out = append(out, 0)
	for i := 0; i < len(hrp); i++ {
		out = append(out, hrp[i]&31)
	}
	return out
}

func convertBits(data []byte, fromBits, toBits uint, pad bool) ([]byte, error) {
	var acc uint32
	var bits uint
	maxv := (uint32(1) << toBits) - 1
	var out []byte
	for _, b := range data {
		acc = (acc << fromBits) | uint32(b)
		bits += fromBits
		for bits >= toBits {
			bits -= toBits
			out = append(out, byte((acc>>bits)&maxv))
		}
	}
	if pad {
		if bits > 0 {
			out = append(out, byte((acc<<(toBits-bits))&maxv))
		}
	} else if bits >= fromBits || ((acc<<(toBits-bits))&maxv) != 0 {
		return nil, fmt.Errorf("invalid padding")
	}
	return out, nil
}
