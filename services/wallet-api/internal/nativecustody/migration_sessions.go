package nativecustody

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
)

type nativeProposal struct {
	Version     int     `json:"version"`
	ID          string  `json:"id"`
	PolicyID    string  `json:"policyId"`
	Genesis     string  `json:"genesis"`
	SID         string  `json:"sid"`
	Active      []int   `json:"active"`
	ExpiresAt   int64   `json:"expiresAt"`
	PSBT        string  `json:"psbt"`
	Recipient   string  `json:"recipient"`
	Amount      string  `json:"amount"`
	MaxFee      string  `json:"maxFee"`
	ChangeIndex *uint32 `json:"changeIndex"`
	InputPaths  []struct {
		Branch uint32 `json:"branch"`
		Index  uint32 `json:"index"`
	} `json:"inputPaths"`
	Migration *struct {
		ID           string `json:"id"`
		TargetPolicy Policy `json:"targetPolicy"`
	} `json:"migration,omitempty"`
	Network          string  `json:"network"`
	LedgerID         string  `json:"ledgerId"`
	Kind             string  `json:"kind"`
	TransactionID    string  `json:"transactionId"`
	TransactionBytes string  `json:"transactionBytes"`
	From             string  `json:"from"`
	To               string  `json:"to"`
	SourcePolicy     *Policy `json:"sourcePolicy,omitempty"`
	TargetPolicy     *Policy `json:"targetPolicy,omitempty"`
	MigrationID      string  `json:"migrationId"`
	ApprovalPolicyID string  `json:"approvalPolicyId"`
}
type RegisterInput struct {
	IntentID       string          `json:"intentId"`
	TxID           string          `json:"txid"`
	SourceProposal json.RawMessage `json:"sourceProposal"`
	TargetProposal json.RawMessage `json:"targetProposal,omitempty"`
}

func decodeProposal(raw json.RawMessage) (nativeProposal, any, error) {
	var p nativeProposal
	if len(raw) == 0 || len(raw) > 1500000 {
		return p, nil, invalid("native proposal is missing or oversized")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&p) != nil {
		return p, nil, invalid("invalid native proposal fields")
	}
	if _, err := uuid.Parse(p.ID); err != nil {
		return p, nil, invalid("invalid native proposal identifier")
	}
	if p.ExpiresAt <= 0 || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(p.SID) || len(p.Active) < 2 || len(p.Active) > 5 {
		return p, nil, invalid("invalid native signing session")
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return p, nil, invalid("invalid native proposal")
	}
	return p, value, nil
}

func (s *Coordinator) Register(ctx context.Context, actor *auth.Principal, id string, input RegisterInput) (Migration, error) {
	m, err := s.repo.Get(ctx, id)
	if err != nil {
		return Migration{}, err
	}
	_, member, err := s.member(ctx, actor, m.Manifest.SourceWalletID)
	if err != nil {
		return Migration{}, err
	}
	if m.ReviewPending || (m.Status != "frozen" && m.Status != "partial") {
		return Migration{}, invalid("both groups must confirm the migration before signing")
	}
	var intent *MigrationIntent
	for i := range m.Manifest.Intents {
		if m.Manifest.Intents[i].ID == input.IntentID {
			intent = &m.Manifest.Intents[i]
			break
		}
	}
	if intent == nil {
		return Migration{}, invalid("unknown migration account")
	}
	p, sourceValue, err := decodeProposal(input.SourceProposal)
	if err != nil {
		return Migration{}, err
	}
	if err = s.validateInventory(ctx, m); err != nil {
		return Migration{}, err
	}
	if !validActive(p.Active, intent.SourcePolicy) {
		return Migration{}, invalid("invalid source signing quorum")
	}
	if p.PolicyID != intent.SourcePolicyID {
		return Migration{}, invalid("proposal is not from the approved source policy")
	}
	fee, err := capAmount(p.MaxFee, 1000000000)
	if err != nil {
		return Migration{}, err
	}
	feeN, _ := strconv.ParseInt(fee, 10, 64)
	maxN, _ := strconv.ParseInt(intent.MaxFee, 10, 64)
	if feeN > maxN {
		return Migration{}, invalid("proposal exceeds the approved migration fee cap")
	}
	if p.ExpiresAt <= s.now().UnixMilli() {
		return Migration{}, invalid("prepare a fresh unexpired migration proposal")
	}
	attempt := MigrationAttempt{IntentID: intent.ID, Session: p.ID, TxID: input.TxID, MaxFee: p.MaxFee, SourceProposal: sourceValue, RegisteredAt: s.now(), RegisteredBy: member.ID.String()}
	if intent.Chain == "bitcoin" {
		if p.Genesis != "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043" || p.Version != 2 || p.Migration == nil || p.Migration.ID != m.Manifest.ID || p.Recipient != intent.Destination || p.ChangeIndex != nil || p.ExpiresAt > s.now().Add(24*time.Hour).UnixMilli() {
			return Migration{}, invalid("Bitcoin migration destination or context changed")
		}
		targetID, err := ValidatePolicy(p.Migration.TargetPolicy)
		if err != nil || targetID != intent.TargetPolicyID {
			return Migration{}, invalid("Bitcoin replacement policy changed")
		}
		txid, points, amount, script, err := reviewedPSBT(p.PSBT)
		snapshot := map[string]MigrationCoin{}
		for _, coin := range intent.BitcoinCoins {
			snapshot[coinPoint(coin)] = coin
		}
		total := int64(0)
		if len(points) != len(p.InputPaths) {
			return Migration{}, invalid("Bitcoin input paths differ from the nominated snapshot")
		}
		for index, point := range points {
			coin, ok := snapshot[point]
			if !ok || coin.Branch != p.InputPaths[index].Branch || coin.Index != p.InputPaths[index].Index {
				return Migration{}, invalid("migration input was not nominated")
			}
			value, _ := strconv.ParseInt(coin.Value, 10, 64)
			total += value
		}
		reviewedAmount, _ := strconv.ParseInt(p.Amount, 10, 64)
		reviewedFee, _ := strconv.ParseInt(p.MaxFee, 10, 64)
		if err != nil || txid != input.TxID || script != intent.DestinationScript || amount != reviewedAmount || total-amount != reviewedFee {
			return Migration{}, invalid("Bitcoin transaction ID does not match the reviewed PSBT")
		}
	} else {
		target, targetValue, err := decodeProposal(input.TargetProposal)
		if err != nil {
			return Migration{}, err
		}
		if p.SourcePolicy == nil || p.TargetPolicy == nil || target.SourcePolicy == nil || target.TargetPolicy == nil {
			return Migration{}, invalid("both Hedera policy snapshots are required")
		}
		oldID, e1 := ValidatePolicy(*p.SourcePolicy)
		newID, e2 := ValidatePolicy(*p.TargetPolicy)
		oldTarget, e3 := ValidatePolicy(*target.SourcePolicy)
		newTarget, e4 := ValidatePolicy(*target.TargetPolicy)
		if e1 != nil || e2 != nil || e3 != nil || e4 != nil || oldID != intent.SourcePolicyID || oldTarget != oldID || newID != intent.TargetPolicyID || newTarget != newID {
			return Migration{}, invalid("Hedera replacement policy changed")
		}
		if p.Version != 1 || target.Version != 1 || !validActive(target.Active, intent.TargetPolicy) || p.Kind != "keyUpdate" || target.Kind != "keyUpdate" || p.MigrationID != m.Manifest.ID || target.MigrationID != m.Manifest.ID || p.ID != target.ID || p.TransactionID != target.TransactionID || p.TransactionBytes != target.TransactionBytes || p.TransactionID != input.TxID || p.From != intent.HederaAccountID || target.From != p.From || p.Amount != "0" || target.Amount != "0" || p.To != "" || target.To != "" || p.MaxFee != target.MaxFee || p.ApprovalPolicyID != oldID || target.ApprovalPolicyID != newID || target.PolicyID != oldID || p.Network != "testnet" || target.Network != "testnet" || p.LedgerID != "01" || target.LedgerID != "01" || p.ExpiresAt != target.ExpiresAt || p.ExpiresAt > s.now().Add(125*time.Second).UnixMilli() || !strings.HasPrefix(p.TransactionID, intent.HederaAccountID+"@") {
			return Migration{}, invalid("Hedera quorums must review the same exact native key update")
		}
		raw, err := base64.StdEncoding.DecodeString(p.TransactionBytes)
		if err != nil || len(raw) > 32768 {
			return Migration{}, invalid("invalid Hedera native transaction bytes")
		}
		commitment := Hash([]any{"QDWallet-HederaNativeIntent/v1", p.PolicyID, p.Kind, p.From, p.To, p.Amount, p.MaxFee, p.TransactionID, p.MigrationID, newID})
		digest, _ := hex.DecodeString(commitment)
		attempt.Memo = "QDWallet:" + p.ID + ":" + base64.RawURLEncoding.EncodeToString(digest)
		if err = reviewedHedera(p, *intent, attempt.Memo); err != nil {
			return Migration{}, err
		}
		attempt.TargetProposal = targetValue
	}
	return s.repo.Update(ctx, id, m.Revision, func(current *Migration) error {
		live := 0
		for i := range current.Attempts {
			old := &current.Attempts[i]
			if old.Session == attempt.Session {
				if Hash(old.SourceProposal) != Hash(attempt.SourceProposal) || Hash(old.TargetProposal) != Hash(attempt.TargetProposal) || old.TxID != attempt.TxID {
					return invalid("a migration signing session is immutable")
				}
				return nil
			}
			// Archive expired public proposal bodies, retaining transaction IDs, fees and
			// memo commitments for uncertain-delivery checks. Secret state is never stored.
			if old.SourceProposal != nil {
				data, _ := json.Marshal(old.SourceProposal)
				var previous nativeProposal
				_ = json.Unmarshal(data, &previous)
				if previous.ExpiresAt <= s.now().UnixMilli() {
					old.SourceProposal = nil
					old.TargetProposal = nil
					old.Archived = true
				}
			}
			if !old.Archived && old.RegisteredBy == member.ID.String() && old.IntentID == attempt.IntentID {
				live++
			}
		}
		if live >= 2 {
			return invalid("this device already has two active migration attempts; reconcile or wait for their signing windows")
		}
		if len(current.Attempts) >= 1000 {
			return invalid("migration evidence capacity reached; preserve backups and seek recovery review")
		}
		current.Attempts = append(current.Attempts, attempt)
		current.UpdatedAt = s.now()
		return nil
	})
}

func (s *Coordinator) Guard(chain string) func(context.Context, string, string, string, string, string) error {
	return func(ctx context.Context, walletID, accountID, kind, session, payload string) error {
		items, err := s.repo.ForWallet(ctx, walletID)
		if err != nil {
			return invalid("native migration status is unavailable")
		}
		for _, m := range items {
			if m.Status == "draft" || m.Status == "complete" || m.Status == "cancelled" {
				continue
			}
			var intent *MigrationIntent
			source := walletID == m.Manifest.SourceWalletID
			for i := range m.Manifest.Intents {
				v := &m.Manifest.Intents[i]
				if v.Chain == chain && ((source && v.SourceAccountID == accountID) || (!source && v.TargetAccountID == accountID)) {
					intent = v
					break
				}
			}
			if kind == "enrollment" || kind == "policy" || kind == "binding" || kind == "link" {
				if intent == nil {
					return invalid("finish the pending migration before setting up another native account")
				}
				continue
			}
			if intent == nil || kind == "creation" || (!source && chain == "bitcoin") {
				return invalid("native spending is paused during the approved membership migration")
			}
			allowed := false
			for _, attempt := range m.Attempts {
				if attempt.IntentID != intent.ID || attempt.Session != session || attempt.Archived {
					continue
				}
				allowed = true
				if kind == "proposal" {
					decoded, err := base64.RawURLEncoding.DecodeString(payload)
					if err != nil {
						return invalid("invalid migration proposal")
					}
					var value any
					if json.Unmarshal(decoded, &value) != nil {
						return invalid("invalid migration proposal")
					}
					expected := attempt.SourceProposal
					if !source {
						expected = attempt.TargetProposal
					}
					if Hash(value) != Hash(expected) {
						return invalid("migration proposal differs from its registered review")
					}
				}
			}
			if !allowed {
				return invalid("register a reviewed migration signing session before exchanging signatures")
			}
		}
		return nil
	}
}

func validActive(active []int, policy Policy) bool {
	if len(active) != policy.RaccoonThreshold {
		return false
	}
	for i, index := range active {
		if index < 1 || index > len(policy.Members) || (i > 0 && index <= active[i-1]) {
			return false
		}
	}
	return true
}
