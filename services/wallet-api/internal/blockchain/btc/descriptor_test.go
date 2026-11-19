package btc

import (
	"errors"
	"strings"
	"testing"
)

// testExtKey builds a syntactically valid extended public key of the right
// length for the tests.
func testExtKey(prefix string) string {
	body := strings.Repeat("123456789ABCDEFGH", 8)
	return prefix + body[:107]
}

func testDescriptor(script, prefix, origin string) string {
	return script + "([" + origin + "]" + testExtKey(prefix) + "/0/*)"
}

func TestParseDescriptorAcceptsTheTwoValidShapes(t *testing.T) {
	mainnet := testDescriptor("wpkh", "xpub", "deadbeef/84'/0'/0'")
	parsed, err := ParseDescriptor(mainnet, NetworkMainnet, AddressTypeP2WPKH)
	if err != nil {
		t.Fatalf("expected a valid mainnet descriptor, got %v", err)
	}
	if parsed.Script != "wpkh" {
		t.Fatalf("unexpected script: %q", parsed.Script)
	}
	if parsed.Origin.Purpose != 84 || parsed.Origin.CoinType != 0 || parsed.Origin.Account != 0 {
		t.Fatalf("unexpected origin: %+v", parsed.Origin)
	}
	if parsed.Origin.Fingerprint != "deadbeef" {
		t.Fatalf("unexpected fingerprint: %q", parsed.Origin.Fingerprint)
	}
	if parsed.Derivation != "0/*" {
		t.Fatalf("unexpected derivation: %q", parsed.Derivation)
	}
	if parsed.String() != mainnet {
		t.Fatalf("the descriptor did not round-trip: %q", parsed.String())
	}

	testnet := testDescriptor("tr", "tpub", "deadbeef/86'/1'/0'")
	parsed, err = ParseDescriptor(testnet, NetworkTestnet4, AddressTypeP2TR)
	if err != nil {
		t.Fatalf("expected a valid testnet descriptor, got %v", err)
	}
	if parsed.Origin.CoinType != 1 || parsed.Origin.Purpose != 86 {
		t.Fatalf("unexpected origin: %+v", parsed.Origin)
	}
}

func TestParseDescriptorRejectsBadDescriptors(t *testing.T) {
	cases := []struct {
		name       string
		descriptor string
		network    Network
		address    AddressType
	}{
		{"empty", "", NetworkMainnet, AddressTypeP2WPKH},
		{"garbage", "not-a-descriptor", NetworkMainnet, AddressTypeP2WPKH},
		{"private key", testDescriptor("wpkh", "xprv", "deadbeef/84'/0'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"testnet private key", testDescriptor("wpkh", "tprv", "deadbeef/84'/0'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"wif key", "wpkh(" + "K" + strings.Repeat("1", 51) + ")", NetworkMainnet, AddressTypeP2WPKH},
		{"wrong purpose", testDescriptor("wpkh", "xpub", "deadbeef/86'/0'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"wrong coin type", testDescriptor("wpkh", "xpub", "deadbeef/84'/1'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"testnet key on mainnet", testDescriptor("wpkh", "tpub", "deadbeef/84'/0'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"mainnet key on testnet", testDescriptor("wpkh", "xpub", "deadbeef/84'/1'/0'"), NetworkTestnet4, AddressTypeP2WPKH},
		{"script does not match address type", testDescriptor("tr", "xpub", "deadbeef/86'/0'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"nested script", "sh(" + testDescriptor("wpkh", "xpub", "deadbeef/84'/0'/0'") + ")", NetworkMainnet, AddressTypeP2WPKH},
		{"pk script", "pk(" + testExtKey("xpub") + ")", NetworkMainnet, AddressTypeP2WPKH},
		{"combo script", "combo(" + testExtKey("xpub") + ")", NetworkMainnet, AddressTypeP2WPKH},
		{"multi key", "wpkh(" + testExtKey("xpub") + "," + testExtKey("xpub") + ")", NetworkMainnet, AddressTypeP2WPKH},
		{"no key origin", "wpkh(" + testExtKey("xpub") + "/0/*)", NetworkMainnet, AddressTypeP2WPKH},
		{"shallow origin", testDescriptor("wpkh", "xpub", "deadbeef/84'"), NetworkMainnet, AddressTypeP2WPKH},
		{"deep origin", testDescriptor("wpkh", "xpub", "deadbeef/84'/0'/0'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"non hardened origin", testDescriptor("wpkh", "xpub", "deadbeef/84/0/0"), NetworkMainnet, AddressTypeP2WPKH},
		{"bad fingerprint", testDescriptor("wpkh", "xpub", "deadbee/84'/0'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"non hex fingerprint", testDescriptor("wpkh", "xpub", "deadbeeg/84'/0'/0'"), NetworkMainnet, AddressTypeP2WPKH},
		{"wrong derivation", "wpkh([" + "deadbeef/84'/0'/0']" + testExtKey("xpub") + "/0/1/*)", NetworkMainnet, AddressTypeP2WPKH},
		{"no derivation", "wpkh([" + "deadbeef/84'/0'/0']" + testExtKey("xpub") + ")", NetworkMainnet, AddressTypeP2WPKH},
		{"too long", "wpkh(" + strings.Repeat("a", 1100) + ")", NetworkMainnet, AddressTypeP2WPKH},
		{"control character", "wpkh([" + "deadbeef/84'/0'/0']" + testExtKey("xpub") + "/0/*)\n", NetworkMainnet, AddressTypeP2WPKH},
		{"truncated key", "wpkh([deadbeef/84'/0'/0']xpub123)", NetworkMainnet, AddressTypeP2WPKH},
		{"non base58 key", "wpkh([deadbeef/84'/0'/0']xpub" + strings.Repeat("0", 107) + ")", NetworkMainnet, AddressTypeP2WPKH},
	}
	for _, tc := range cases {
		_, err := ParseDescriptor(tc.descriptor, tc.network, tc.address)
		if err == nil {
			t.Fatalf("%s: expected the descriptor to be rejected", tc.name)
		}
		if !errors.Is(err, ErrInvalidDescriptor) {
			t.Fatalf("%s: expected ErrInvalidDescriptor, got %v", tc.name, err)
		}
	}
}

func TestDescriptorFingerprintDoesNotLeakTheDescriptor(t *testing.T) {
	desc := testDescriptor("wpkh", "xpub", "deadbeef/84'/0'/0'")
	fp := DescriptorFingerprint(desc)
	if len(fp) != 8 {
		t.Fatalf("expected an 8 character fingerprint, got %q", fp)
	}
	if strings.Contains(fp, "xpub") {
		t.Fatalf("the fingerprint leaks the descriptor: %q", fp)
	}
}
