package btc

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// AddressType is the Bitcoin address scheme of an account.
type AddressType string

const (
	// AddressTypeP2WPKH is BIP-84 (segwit v0 key hash).
	AddressTypeP2WPKH AddressType = "p2wpkh"
	// AddressTypeP2TR is BIP-86 (taproot key path).
	AddressTypeP2TR AddressType = "p2tr"
)

// ErrInvalidDescriptor is returned when a client-supplied descriptor is not
// one of the accepted account-level public descriptors. It is deliberately
// vague in the message: the descriptor itself is public, but echoing it
// back would normalise accepting garbage.
var ErrInvalidDescriptor = errors.New("invalid bitcoin descriptor")

// ErrDescriptorRejected is returned when the node refuses a descriptor that
// passed the local validation.
var ErrDescriptorRejected = errors.New("descriptor rejected by the bitcoin node")

// maxDescriptorLen bounds the size of a client-supplied descriptor.
const maxDescriptorLen = 1024

// Descriptor is a parsed account-level public descriptor of the shape
// `wpkh([<8 hex fingerprint>/<84'>/<coin>'>/<account>']xpub.../0/*)`.
type Descriptor struct {
	// Script is the script function: "wpkh" or "tr".
	Script string
	// Origin is the key origin.
	Origin DescriptorOrigin
	// Key is the extended public key (xpub/tpub).
	Key string
	// Derivation is the trailing derivation, always "0/*".
	Derivation string
}

// DescriptorOrigin is the key origin of a descriptor.
type DescriptorOrigin struct {
	// Fingerprint is the 8 hex character master key fingerprint.
	Fingerprint string
	// Purpose is the BIP-43 purpose (84 for P2WPKH, 86 for P2TR).
	Purpose uint32
	// CoinType is the BIP-44 coin type (0 mainnet, 1 testnet).
	CoinType uint32
	// Account is the BIP-44 account index.
	Account uint32
}

// String rebuilds the canonical descriptor text.
func (d *Descriptor) String() string {
	return fmt.Sprintf("%s([%s/%d'/%d'/%d']%s/%s)",
		d.Script, d.Origin.Fingerprint, d.Origin.Purpose, d.Origin.CoinType, d.Origin.Account, d.Key, d.Derivation)
}

// DescriptorFingerprint returns a short, non-reversible hash of a
// descriptor. Descriptors are public material, but they are never logged
// in plaintext.
func DescriptorFingerprint(desc string) string {
	sum := sha256.Sum256([]byte(desc))
	return hex.EncodeToString(sum[:])[:8]
}

// ParseDescriptor validates a client-supplied descriptor against a strict
// allow-list and returns its parts.
//
// Only the two account-level shapes the client derives are accepted:
//
//	wpkh([<8 hex>/84'/<coin>'/<account>']xpub.../0/*)
//	tr([<8 hex>/86'/<coin>'/<account>']tpub.../0/*)
//
// Anything else is rejected: private keys, WIF keys, other script
// functions, nested or multi-key descriptors, a wrong purpose, a coin type
// that does not match the network, or a key origin that is not at the
// account level.
func ParseDescriptor(raw string, network Network, addressType AddressType) (*Descriptor, error) {
	// Control characters (newlines included) are rejected on the raw input:
	// a descriptor is a single line of machine generated text.
	for _, r := range raw {
		if r < 0x20 || r == 0x7f {
			return nil, fmt.Errorf("%w: descriptor contains control characters", ErrInvalidDescriptor)
		}
	}
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, fmt.Errorf("%w: descriptor is empty", ErrInvalidDescriptor)
	}
	if len(s) > maxDescriptorLen {
		return nil, fmt.Errorf("%w: descriptor is longer than %d characters", ErrInvalidDescriptor, maxDescriptorLen)
	}
	if containsPrivateKeyMaterial(s) {
		return nil, fmt.Errorf("%w: descriptor contains private key material", ErrInvalidDescriptor)
	}
	if containsWIFKey(s) {
		return nil, fmt.Errorf("%w: descriptor contains a private key", ErrInvalidDescriptor)
	}

	open := strings.IndexByte(s, '(')
	if open <= 0 {
		return nil, fmt.Errorf("%w: descriptor has no script function", ErrInvalidDescriptor)
	}
	if !strings.HasSuffix(s, ")") {
		return nil, fmt.Errorf("%w: descriptor is not closed", ErrInvalidDescriptor)
	}
	fn := s[:open]
	body := s[open+1 : len(s)-1]
	if strings.ContainsAny(body, "()") {
		return nil, fmt.Errorf("%w: nested descriptors are not accepted", ErrInvalidDescriptor)
	}
	switch fn {
	case "wpkh":
		if addressType != AddressTypeP2WPKH {
			return nil, fmt.Errorf("%w: script function does not match the address type", ErrInvalidDescriptor)
		}
	case "tr":
		if addressType != AddressTypeP2TR {
			return nil, fmt.Errorf("%w: script function does not match the address type", ErrInvalidDescriptor)
		}
	default:
		return nil, fmt.Errorf("%w: unsupported script function", ErrInvalidDescriptor)
	}

	if !strings.HasPrefix(body, "[") {
		return nil, fmt.Errorf("%w: descriptor has no key origin", ErrInvalidDescriptor)
	}
	end := strings.IndexByte(body, ']')
	if end < 0 {
		return nil, fmt.Errorf("%w: descriptor has an unterminated key origin", ErrInvalidDescriptor)
	}
	origin, err := parseKeyOrigin(body[1:end])
	if err != nil {
		return nil, err
	}
	if err := checkOrigin(origin, network, addressType); err != nil {
		return nil, err
	}

	rest := body[end+1:]
	parts := strings.Split(rest, "/")
	if len(parts) != 3 {
		return nil, fmt.Errorf("%w: unexpected derivation path", ErrInvalidDescriptor)
	}
	key := parts[0]
	derivation := parts[1] + "/" + parts[2]
	if derivation != "0/*" {
		return nil, fmt.Errorf("%w: unsupported derivation path", ErrInvalidDescriptor)
	}
	if err := checkExtendedPublicKey(key, network); err != nil {
		return nil, err
	}

	return &Descriptor{Script: fn, Origin: origin, Key: key, Derivation: derivation}, nil
}

// parseKeyOrigin parses `[<fingerprint>/<purpose>'/<coin>'/<account>']`.
func parseKeyOrigin(raw string) (DescriptorOrigin, error) {
	var origin DescriptorOrigin
	parts := strings.Split(raw, "/")
	if len(parts) != 4 {
		// The origin must sit exactly at the account level: purpose',
		// coin type' and account'.
		return origin, fmt.Errorf("%w: key origin must have exactly three path components", ErrInvalidDescriptor)
	}
	if len(parts[0]) != 8 {
		return origin, fmt.Errorf("%w: key origin fingerprint must be 8 hex characters", ErrInvalidDescriptor)
	}
	if _, err := hex.DecodeString(parts[0]); err != nil {
		return origin, fmt.Errorf("%w: key origin fingerprint must be hex", ErrInvalidDescriptor)
	}
	origin.Fingerprint = parts[0]

	purpose, err := parseHardenedIndex(parts[1])
	if err != nil {
		return origin, fmt.Errorf("%w: invalid key origin purpose", ErrInvalidDescriptor)
	}
	origin.Purpose = purpose

	coinType, err := parseHardenedIndex(parts[2])
	if err != nil {
		return origin, fmt.Errorf("%w: invalid key origin coin type", ErrInvalidDescriptor)
	}
	origin.CoinType = coinType

	account, err := parseHardenedIndex(parts[3])
	if err != nil {
		return origin, fmt.Errorf("%w: invalid key origin account index", ErrInvalidDescriptor)
	}
	origin.Account = account
	return origin, nil
}

// parseHardenedIndex parses a hardened path component such as "84'".
func parseHardenedIndex(s string) (uint32, error) {
	if !strings.HasSuffix(s, "'") {
		return 0, fmt.Errorf("btc: not a hardened index")
	}
	n, err := strconv.ParseUint(strings.TrimSuffix(s, "'"), 10, 32)
	if err != nil {
		return 0, err
	}
	return uint32(n), nil
}

// checkOrigin enforces the purpose and coin type rules.
func checkOrigin(origin DescriptorOrigin, network Network, addressType AddressType) error {
	wantPurpose := uint32(84)
	if addressType == AddressTypeP2TR {
		wantPurpose = 86
	}
	if origin.Purpose != wantPurpose {
		return fmt.Errorf("%w: key origin purpose does not match the address type", ErrInvalidDescriptor)
	}
	wantCoin := uint32(0)
	if network == NetworkTestnet4 {
		wantCoin = 1
	}
	if origin.CoinType != wantCoin {
		return fmt.Errorf("%w: key origin coin type does not match the network", ErrInvalidDescriptor)
	}
	return nil
}

// checkExtendedPublicKey enforces that the key is an extended public key of
// the right network. Anything that could spend is rejected here.
func checkExtendedPublicKey(key string, network Network) error {
	if key == "" {
		return fmt.Errorf("%w: descriptor has no key", ErrInvalidDescriptor)
	}
	wantPrefix := "xpub"
	if network == NetworkTestnet4 {
		wantPrefix = "tpub"
	}
	if !strings.HasPrefix(key, wantPrefix) {
		return fmt.Errorf("%w: key is not an extended public key for this network", ErrInvalidDescriptor)
	}
	if len(key) != 111 {
		return fmt.Errorf("%w: malformed extended public key", ErrInvalidDescriptor)
	}
	for i := 0; i < len(key); i++ {
		if strings.IndexByte(base58Alphabet, key[i]) < 0 {
			return fmt.Errorf("%w: malformed extended public key", ErrInvalidDescriptor)
		}
	}
	return nil
}

// containsPrivateKeyMaterial reports whether the text mentions an extended
// private key. Only the version prefixes are looked for: a bare "prv" would
// false-positive on a random base58 key.
func containsPrivateKeyMaterial(s string) bool {
	lower := strings.ToLower(s)
	for _, marker := range []string{"xprv", "yprv", "zprv", "tprv", "uprv", "vprv"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// containsWIFKey reports whether the text contains a WIF encoded private
// key (base58, 51 or 52 characters, starting with K or L).
func containsWIFKey(s string) bool {
	start := 0
	for i := 0; i <= len(s); i++ {
		if i < len(s) && strings.IndexByte(base58Alphabet, s[i]) >= 0 {
			continue
		}
		token := s[start:i]
		start = i + 1
		if len(token) < 51 || len(token) > 52 {
			continue
		}
		if token[0] == 'K' || token[0] == 'L' {
			return true
		}
	}
	return false
}
