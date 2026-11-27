package nativecustody

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

type NativeRooms interface {
	NativeRooms(context.Context, string) (map[string]json.RawMessage, error)
	SessionMessages(context.Context, string, string, string, int64, string) (json.RawMessage, error)
}
type roomMessage struct {
	ID        string `json:"id"`
	From      string `json:"from"`
	Kind      string `json:"kind"`
	Session   string `json:"session"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type inventoryEntry struct {
	Chain, AccountID, PolicyID, HederaAccountID string
	Policy                                      Policy
	BoundCount                                  int
}

func verifyRoomMessage(chain string, w *store.SharedWallet, account string, member *store.SharedMember, m roomMessage) bool {
	domain := "QDWallet-BitcoinRelay/v1"
	if chain == "hedera" {
		domain = "QDWallet-HederaRelay/v1"
	}
	payload := sha256.Sum256([]byte(m.Payload))
	value := []any{domain, w.ID.String(), account, w.KeyGenerationID.String(), w.MembershipVersion, m.Kind, m.Session, hex.EncodeToString(payload[:])}
	body, _ := json.Marshal(value)
	digest := sha256.Sum256(body)
	signature, err := base64.RawURLEncoding.DecodeString(m.Signature)
	key, e := x509.ParsePKIXPublicKey(member.DevicePublicKey)
	public, ok := key.(*ecdsa.PublicKey)
	return err == nil && e == nil && ok && len(signature) == 64 && ecdsa.Verify(public, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:]))
}

func (s *Coordinator) inventory(ctx context.Context, w *store.SharedWallet) ([]inventoryEntry, []RosterMember, error) {
	if w.KeyGenerationID == nil || w.KeyStatus != store.KeyActive || !w.NativeCustodyLocked {
		return nil, nil, invalid("finish native custody setup before preparing a migration")
	}
	members, err := s.st.SharedWallets().ListMembers(ctx, w.ID)
	if err != nil {
		return nil, nil, err
	}
	byID := map[string]*store.SharedMember{}
	for _, m := range members {
		if m.Status == store.MemberActive {
			byID[m.ID.String()] = m
		}
	}
	keygen, parts, err := s.st.SharedWallets().GetKeyGeneration(ctx, *w.KeyGenerationID)
	if err != nil {
		return nil, nil, invalid("key generation is unavailable")
	}
	if len(parts) != len(byID) || len(parts) < 2 || len(parts) > 5 {
		return nil, nil, invalid("native key generation no longer matches the participant roster")
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartyIndex < parts[j].PartyIndex })
	roster := []RosterMember{}
	for _, part := range parts {
		m := byID[part.MemberID.String()]
		if m == nil {
			return nil, nil, invalid("native key generation has an inactive participant")
		}
		roster = append(roster, RosterMember{ID: m.ID.String(), Name: m.DisplayName, Role: string(m.Role), DeviceKey: base64.RawURLEncoding.EncodeToString(m.DevicePublicKey)})
	}
	output := []inventoryEntry{}
	for _, chain := range []string{"bitcoin", "hedera"} {
		reader := s.bitcoinRooms
		if chain == "hedera" {
			reader = s.hederaRooms
		}
		rooms, err := reader.NativeRooms(ctx, w.ID.String())
		if err != nil {
			return nil, nil, err
		}
		for scope, body := range rooms {
			fields := strings.Split(scope, "|")
			if len(fields) != 4 {
				return nil, nil, invalid("invalid native inventory scope")
			}
			var messages []roomMessage
			if json.Unmarshal(body, &messages) != nil {
				return nil, nil, invalid("invalid native inventory")
			}
			ownerPinned := false
			for _, message := range messages {
				member := byID[message.From]
				if member != nil && member.Role == store.RoleOwner && message.Kind == "policy" {
					ownerPinned = true
				}
			}
			if !ownerPinned {
				continue
			}
			if fields[2] != w.KeyGenerationID.String() || fields[3] != strconv.FormatInt(w.MembershipVersion, 10) {
				return nil, nil, invalid("an archived native policy needs recovery before migration can continue")
			}
			accountID, err := uuid.Parse(fields[1])
			if err != nil {
				return nil, nil, err
			}
			account, err := s.st.SharedWallets().GetAccount(ctx, w.ID, accountID)
			if err != nil {
				return nil, nil, err
			}
			entries := map[string]Enrollment{}
			pinned := map[string]string{}
			bindings := map[string]string{}
			bindingPolicies := map[string]string{}
			for _, message := range messages {
				if message.Kind != "enrollment" && message.Kind != "policy" && message.Kind != "binding" {
					continue
				}
				member := byID[message.From]
				if member == nil || !verifyRoomMessage(chain, w, accountID.String(), member, message) {
					return nil, nil, invalid("native policy message authentication failed")
				}
				decoded, err := base64.RawURLEncoding.DecodeString(message.Payload)
				if err != nil {
					return nil, nil, invalid("invalid native public message")
				}
				switch message.Kind {
				case "enrollment":
					var e Enrollment
					if json.Unmarshal(decoded, &e) != nil || e.ParticipantID != message.From {
						return nil, nil, invalid("invalid native enrollment")
					}
					entries[message.From] = e
				case "policy":
					var v struct {
						PolicyID string `json:"policyId"`
					}
					if json.Unmarshal(decoded, &v) != nil {
						return nil, nil, invalid("invalid policy confirmation")
					}
					pinned[message.From] = v.PolicyID
				case "binding":
					var v struct {
						PolicyID  string `json:"policyId"`
						AccountID string `json:"accountId"`
					}
					if json.Unmarshal(decoded, &v) != nil {
						return nil, nil, invalid("invalid account binding")
					}
					bindings[message.From] = v.AccountID
					bindingPolicies[message.From] = v.PolicyID
				}
			}
			if len(entries) != len(parts) || len(pinned) != len(parts) {
				return nil, nil, invalid("every participant must confirm each native policy before migration")
			}
			enrolled := make([]Enrollment, len(parts))
			for i, part := range parts {
				e, ok := entries[part.MemberID.String()]
				if !ok || e.PartyIndex != part.PartyIndex || int64(e.DerivationIndex) != account.DerivationIndex || e.Threshold != keygen.Threshold {
					return nil, nil, invalid("native enrollment does not match key generation")
				}
				enrolled[i] = e
			}
			first := enrolled[0]
			policy := Policy{Version: 1, Context: first.Context, DerivationIndex: first.DerivationIndex, RaccoonPublicKey: first.RaccoonPublicKey, RaccoonThreshold: first.Threshold, NativeThreshold: len(enrolled)/2 + 1, Members: enrolled}
			id, err := ValidatePolicy(policy)
			if err != nil {
				return nil, nil, err
			}
			network := "testnet4"
			if chain == "hedera" {
				network = "testnet"
			}
			if policy.Context.WalletID != w.ID.String() || policy.Context.AccountID != account.ID.String() || policy.Context.KeygenID != w.KeyGenerationID.String() || policy.Context.MembershipVersion != w.MembershipVersion || policy.Context.Network != network {
				return nil, nil, invalid("native policy belongs to another account")
			}
			for _, confirmation := range pinned {
				if confirmation != id {
					return nil, nil, invalid("participants confirmed different native policies")
				}
			}
			linked := ""
			for member, value := range bindings {
				if bindingPolicies[member] != id || linked != "" && value != linked {
					return nil, nil, invalid("Hedera account bindings disagree")
				}
				linked = value
			}
			output = append(output, inventoryEntry{Chain: chain, AccountID: account.ID.String(), PolicyID: id, Policy: policy, HederaAccountID: linked, BoundCount: len(bindings)})
		}
	}
	if len(output) == 0 || len(output) > 16 {
		return nil, nil, invalid("migration supports one to sixteen registered native accounts")
	}
	sort.Slice(output, func(i, j int) bool {
		left := output[i].Chain + output[i].AccountID
		right := output[j].Chain + output[j].AccountID
		return left < right
	})
	return output, roster, nil
}
