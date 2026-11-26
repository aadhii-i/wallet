// Package nativecustody validates public native-policy commitments used during
// shared-wallet migration. Raccoon shares and native private keys stay client-side.
package nativecustody

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"regexp"

	ethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/blockchain/btc"
)

type Context struct {
	WalletID          string `json:"walletId"`
	AccountID         string `json:"accountId"`
	KeygenID          string `json:"keygenId"`
	MembershipVersion int64  `json:"membershipVersion"`
	Network           string `json:"network"`
}
type Enrollment struct {
	Context
	ParticipantID    string `json:"participantId"`
	PartyIndex       int    `json:"partyIndex"`
	DerivationIndex  uint32 `json:"derivationIndex"`
	Threshold        int    `json:"threshold"`
	Parties          int    `json:"parties"`
	Xpub             string `json:"xpub,omitempty"`
	PublicKey        string `json:"publicKey,omitempty"`
	RaccoonPublicKey string `json:"raccoonPublicKey"`
	Proof            string `json:"proof"`
}
type Policy struct {
	Version          int          `json:"version"`
	Context          Context      `json:"context"`
	DerivationIndex  uint32       `json:"derivationIndex"`
	RaccoonPublicKey string       `json:"raccoonPublicKey"`
	RaccoonThreshold int          `json:"raccoonThreshold"`
	NativeThreshold  int          `json:"nativeThreshold"`
	Members          []Enrollment `json:"members"`
}

var lowerHex = regexp.MustCompile(`^[0-9a-f]+$`)

func Hash(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func (e Enrollment) fields(bitcoin bool) []any {
	public := e.PublicKey
	if bitcoin {
		public = e.Xpub
	}
	return []any{e.WalletID, e.AccountID, e.KeygenID, e.MembershipVersion, e.Network, e.ParticipantID, e.PartyIndex, e.DerivationIndex, e.Threshold, e.Parties, public, e.RaccoonPublicKey}
}
func ValidatePolicy(p Policy) (string, error) {
	bitcoin := p.Context.Network == "testnet4"
	n := len(p.Members)
	if !bitcoin && p.Context.Network != "testnet" || p.Version != 1 || n < 2 || n > 5 || p.NativeThreshold != n/2+1 || p.RaccoonThreshold < 2 || p.RaccoonThreshold > n || p.Context.MembershipVersion < 1 || p.DerivationIndex >= 1<<31 || len(p.RaccoonPublicKey) == 0 || len(p.RaccoonPublicKey) > 100000 {
		return "", invalid("invalid native policy")
	}
	for _, id := range []string{p.Context.WalletID, p.Context.AccountID, p.Context.KeygenID} {
		if _, err := uuid.Parse(id); err != nil {
			return "", invalid("invalid policy context")
		}
	}
	ids := map[string]bool{}
	keys := map[string]bool{}
	entries := make([]any, 0, n)
	for i, e := range p.Members {
		if e.Context != p.Context || e.PartyIndex != i+1 || e.DerivationIndex != p.DerivationIndex || e.Threshold != p.RaccoonThreshold || e.Parties != n || e.RaccoonPublicKey != p.RaccoonPublicKey || ids[e.ParticipantID] {
			return "", invalid("inconsistent native enrollment")
		}
		if _, err := uuid.Parse(e.ParticipantID); err != nil {
			return "", invalid("invalid participant")
		}
		ids[e.ParticipantID] = true
		domain := "QDWallet-HederaEnrollment/v1"
		if bitcoin {
			domain = "QDWallet-BitcoinEnrollment/v1"
		}
		fields := e.fields(bitcoin)
		message := append([]any{domain}, fields...)
		if !bitcoin {
			message = []any{domain, fields}
		}
		digest, _ := hex.DecodeString(Hash(message))
		pub, err := hex.DecodeString(e.PublicKey)
		public := e.PublicKey
		if bitcoin {
			pub, err = btc.SharedPublicKey(e.Xpub, 0, 0)
			public = e.Xpub
		}
		signature, se := hex.DecodeString(e.Proof)
		if err != nil || se != nil || len(pub) != 33 || len(signature) != 64 || !lowerHex.MatchString(e.Proof) || keys[public] || !ethcrypto.VerifySignature(pub, digest, signature) {
			return "", invalid("invalid native possession proof")
		}
		keys[public] = true
		if bitcoin {
			entries = append(entries, []any{e.ParticipantID, e.PartyIndex, e.Xpub, e.Proof, hex.EncodeToString(digest)})
		} else {
			entries = append(entries, []any{fields, e.Proof})
		}
	}
	fields := []any{p.Version, p.Context.WalletID, p.Context.AccountID, p.Context.KeygenID, p.Context.MembershipVersion, p.Context.Network, p.DerivationIndex, p.RaccoonPublicKey, p.RaccoonThreshold, p.NativeThreshold}
	domain := "QDWallet-BitcoinPolicy/v1"
	if !bitcoin {
		domain = "QDWallet-HederaPolicy/v1"
		fields = []any{p.Version, p.Context.WalletID, p.Context.AccountID, p.Context.KeygenID, p.Context.MembershipVersion, p.Context.Network, p.DerivationIndex, p.NativeThreshold, p.RaccoonThreshold, p.RaccoonPublicKey}
	}
	return Hash([]any{domain, fields, entries}), nil
}

func (p Policy) BitcoinOutput(branch, index uint32) (string, string, error) {
	if _, err := ValidatePolicy(p); err != nil {
		return "", "", err
	}
	if p.Context.Network != "testnet4" {
		return "", "", invalid("not a Bitcoin policy")
	}
	roots := make([]string, len(p.Members))
	for i, m := range p.Members {
		roots[i] = m.Xpub
	}
	return btc.SharedOutput(roots, p.NativeThreshold, branch, index)
}
func field(tag byte, body []byte) []byte {
	result := []byte{tag}
	result = binary.AppendUvarint(result, uint64(len(body)))
	return append(result, body...)
}

// Canonical flat threshold Key, interoperable with the pinned Hedera SDK.
func (p Policy) HederaKey() (string, error) {
	if _, err := ValidatePolicy(p); err != nil {
		return "", err
	}
	if p.Context.Network != "testnet" {
		return "", invalid("not a Hedera policy")
	}
	var list []byte
	for _, m := range p.Members {
		pub, _ := hex.DecodeString(m.PublicKey)
		list = append(list, field(10, field(58, pub))...)
	}
	threshold := []byte{8, byte(p.NativeThreshold)}
	threshold = append(threshold, field(18, list)...)
	return hex.EncodeToString(field(42, threshold)), nil
}

// Only explicit public validation messages are returned to callers. Database,
// provider and filesystem errors must never reveal connection details.
type validationError struct{ message string }

func (e *validationError) Error() string { return e.message }
func invalid(message string) error       { return &validationError{message: message} }
