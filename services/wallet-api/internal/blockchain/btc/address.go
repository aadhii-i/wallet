package btc

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// Errors returned by the address validator. Callers map them onto HTTP
// status codes; the messages never contain the address itself.
var (
	// ErrInvalidAddress means the address is not a well-formed Bitcoin
	// address (bad checksum, bad length, bad characters).
	ErrInvalidAddress = errors.New("invalid bitcoin address")
	// ErrWrongNetwork means the address is valid but belongs to another
	// Bitcoin network than the one this server is configured for.
	ErrWrongNetwork = errors.New("address belongs to a different bitcoin network")
)

// Network is a Bitcoin network wallet-api can be configured for.
type Network string

const (
	NetworkMainnet  Network = "mainnet"
	NetworkTestnet4 Network = "testnet4"
)

// ValidNetwork reports whether n is a network wallet-api supports.
func ValidNetwork(n Network) bool {
	return n == NetworkMainnet || n == NetworkTestnet4
}

const (
	bech32Charset  = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
	base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

	// bech32Const / bech32mConst are the checksum constants defined by
	// BIP-173 and BIP-350.
	bech32Const  uint32 = 1
	bech32mConst uint32 = 0x2bc830a3
)

// ValidateAddress checks that addr is a well-formed Bitcoin address for the
// given network. Both bech32/bech32m (segwit) and base58check (P2PKH/P2SH)
// addresses are accepted; the checksum is verified for both, so a typo is
// rejected instead of being forwarded to the node.
func ValidateAddress(addr string, network Network) error {
	info, err := parseAddress(addr)
	if err != nil {
		return err
	}
	if info.network != network {
		return ErrWrongNetwork
	}
	return nil
}

// AddressNetwork returns the network an address belongs to.
func AddressNetwork(addr string) (Network, error) {
	info, err := parseAddress(addr)
	if err != nil {
		return "", err
	}
	return info.network, nil
}

type addressInfo struct {
	network Network
	// kind is "bech32" or "base58"; it is only used in logs.
	kind string
}

func parseAddress(addr string) (addressInfo, error) {
	trimmed := strings.TrimSpace(addr)
	if trimmed == "" || len(trimmed) > 90 {
		return addressInfo{}, ErrInvalidAddress
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "bc1") || strings.HasPrefix(lower, "tb1") {
		return parseSegwitAddress(trimmed)
	}
	return parseBase58Address(trimmed)
}

// parseSegwitAddress decodes a bech32/bech32m segwit address and verifies
// its checksum, witness version and program length.
func parseSegwitAddress(addr string) (addressInfo, error) {
	lower := strings.ToLower(addr)
	upper := strings.ToUpper(addr)
	if addr != lower && addr != upper {
		// Mixed case is invalid per BIP-173.
		return addressInfo{}, ErrInvalidAddress
	}
	sep := strings.LastIndex(lower, "1")
	if sep < 1 || sep+7 > len(lower) {
		return addressInfo{}, ErrInvalidAddress
	}
	hrp := lower[:sep]
	dataPart := lower[sep+1:]

	data := make([]byte, 0, len(dataPart))
	for i := 0; i < len(dataPart); i++ {
		idx := strings.IndexByte(bech32Charset, dataPart[i])
		if idx < 0 {
			return addressInfo{}, ErrInvalidAddress
		}
		data = append(data, byte(idx))
	}
	if len(data) < 7 {
		return addressInfo{}, ErrInvalidAddress
	}
	version := data[0]
	if version > 16 {
		return addressInfo{}, ErrInvalidAddress
	}
	// Witness version 0 uses bech32, versions 1..16 use bech32m.
	want := bech32Const
	if version > 0 {
		want = bech32mConst
	}
	values := append(bech32HrpExpand(hrp), data...)
	if bech32Polymod(values) != want {
		return addressInfo{}, ErrInvalidAddress
	}
	program, err := convertBits(data[1:len(data)-6], 5, 8, false)
	if err != nil {
		return addressInfo{}, ErrInvalidAddress
	}
	switch version {
	case 0:
		if len(program) != 20 && len(program) != 32 {
			return addressInfo{}, ErrInvalidAddress
		}
	case 1:
		if len(program) != 32 {
			return addressInfo{}, ErrInvalidAddress
		}
	default:
		// Future witness versions are not accepted yet.
		return addressInfo{}, ErrInvalidAddress
	}
	switch hrp {
	case "bc":
		return addressInfo{network: NetworkMainnet, kind: "bech32"}, nil
	case "tb":
		return addressInfo{network: NetworkTestnet4, kind: "bech32"}, nil
	default:
		return addressInfo{}, ErrInvalidAddress
	}
}

// parseBase58Address decodes a base58check address (P2PKH or P2SH) and
// verifies its double-SHA256 checksum.
func parseBase58Address(addr string) (addressInfo, error) {
	if len(addr) < 26 || len(addr) > 35 {
		return addressInfo{}, ErrInvalidAddress
	}
	raw, err := base58Decode(addr)
	if err != nil {
		return addressInfo{}, ErrInvalidAddress
	}
	if len(raw) != 25 {
		return addressInfo{}, ErrInvalidAddress
	}
	payload, checksum := raw[:21], raw[21:]
	sum := sha256.Sum256(payload)
	sum2 := sha256.Sum256(sum[:])
	for i := 0; i < 4; i++ {
		if checksum[i] != sum2[i] {
			return addressInfo{}, ErrInvalidAddress
		}
	}
	switch raw[0] {
	case 0x00: // mainnet P2PKH
		return addressInfo{network: NetworkMainnet, kind: "base58"}, nil
	case 0x05: // mainnet P2SH
		return addressInfo{network: NetworkMainnet, kind: "base58"}, nil
	case 0x6f: // testnet P2PKH
		return addressInfo{network: NetworkTestnet4, kind: "base58"}, nil
	case 0xc4: // testnet P2SH
		return addressInfo{network: NetworkTestnet4, kind: "base58"}, nil
	default:
		return addressInfo{}, ErrInvalidAddress
	}
}

func base58Decode(s string) ([]byte, error) {
	num := big.NewInt(0)
	radix := big.NewInt(58)
	for i := 0; i < len(s); i++ {
		idx := strings.IndexByte(base58Alphabet, s[i])
		if idx < 0 {
			return nil, fmt.Errorf("btc: invalid base58 character")
		}
		num.Mul(num, radix)
		num.Add(num, big.NewInt(int64(idx)))
	}
	zeros := 0
	for zeros < len(s) && s[zeros] == '1' {
		zeros++
	}
	body := num.Bytes()
	out := make([]byte, zeros+len(body))
	copy(out[zeros:], body)
	return out, nil
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

// convertBits regroups a byte slice from one bit width to another.
func convertBits(data []byte, from, to uint8, pad bool) ([]byte, error) {
	var acc uint32
	var bits uint8
	maxv := uint32(1<<to) - 1
	out := make([]byte, 0, len(data)*int(from)/int(to)+1)
	for _, b := range data {
		if (b >> from) != 0 {
			return nil, fmt.Errorf("btc: invalid padding")
		}
		acc = (acc << from) | uint32(b)
		bits += from
		for bits >= to {
			bits -= to
			out = append(out, byte((acc>>bits)&maxv))
		}
	}
	if pad {
		if bits > 0 {
			out = append(out, byte((acc<<(to-bits))&maxv))
		}
	} else if bits >= from || ((acc<<(to-bits))&maxv) != 0 {
		return nil, fmt.Errorf("btc: invalid padding")
	}
	return out, nil
}

// AddressFingerprint returns a short, non-reversible fingerprint of an
// address. It is the only representation of an address that may be logged.
func AddressFingerprint(addr string) string {
	sum := sha256.Sum256([]byte(addr))
	return hex.EncodeToString(sum[:])[:6]
}
