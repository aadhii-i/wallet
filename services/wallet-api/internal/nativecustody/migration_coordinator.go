package nativecustody

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/blockchain/btc"
	"github.com/qdwallet/wallet-api/internal/blockchain/hedera"
	"github.com/qdwallet/wallet-api/internal/store"
)

type BitcoinReader interface {
	NativeMigrationIdentity(context.Context) error
	NativeMigrationAddress(context.Context, string) (bool, []btc.UTXO, error)
	NativeMigrationTransaction(context.Context, string) (*btc.EsploraTx, int64, error)
}
type HederaReader interface {
	NativeMigrationAccount(context.Context, string) (*hedera.MirrorAccount, error)
	NativeMigrationReceipt(context.Context, string) (*hedera.NativeReceipt, error)
}
type Coordinator struct {
	st                        store.Store
	repo                      *MigrationRepository
	bitcoinRooms, hederaRooms NativeRooms
	bitcoin                   BitcoinReader
	hedera                    HederaReader
	now                       func() time.Time
}

func NewCoordinator(st store.Store, repo *MigrationRepository, bitcoinRooms, hederaRooms NativeRooms, bitcoin BitcoinReader, hedera HederaReader) *Coordinator {
	return &Coordinator{st: st, repo: repo, bitcoinRooms: bitcoinRooms, hederaRooms: hederaRooms, bitcoin: bitcoin, hedera: hedera, now: func() time.Time { return time.Now().UTC() }}
}

type AccountMapping struct {
	BitcoinCoins    []MigrationCoin `json:"bitcoinCoins"`
	SourceAccountID string          `json:"sourceAccountId"`
	TargetAccountID string          `json:"targetAccountId"`
	ChangeCursor    uint32          `json:"changeCursor"`
	BitcoinMaxFee   string          `json:"bitcoinMaxFee"`
	HederaMaxFee    string          `json:"hederaMaxFee"`
}
type DraftInput struct {
	TargetWalletID string           `json:"targetWalletId"`
	Mappings       []AccountMapping `json:"mappings"`
}

var ErrMigrationForbidden = invalid("native migration is not available to this participant device")
var regexpTxID = regexp.MustCompile(`^[0-9a-f]{64}$`)
var amountPattern = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
var nativeAccountPattern = regexp.MustCompile(`^0\.0\.(0|[1-9][0-9]{0,18})$`)

func capAmount(value string, limit int64) (string, error) {
	if !amountPattern.MatchString(value) {
		return "", invalid("invalid migration fee cap")
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n > limit {
		return "", invalid("migration fee cap exceeds the supported limit")
	}
	return value, nil
}
func (s *Coordinator) member(ctx context.Context, p *auth.Principal, wallet string) (*store.SharedWallet, *store.SharedMember, error) {
	if p == nil {
		return nil, nil, ErrMigrationForbidden
	}
	id, err := uuid.Parse(wallet)
	if err != nil {
		return nil, nil, ErrMigrationForbidden
	}
	w, err := s.st.SharedWallets().GetWallet(ctx, id)
	if err != nil {
		return nil, nil, ErrMigrationForbidden
	}
	m, err := s.st.SharedWallets().GetActiveMemberByUser(ctx, id, p.UserID)
	if err != nil || m.DeviceID != p.DeviceID {
		return nil, nil, ErrMigrationForbidden
	}
	return w, m, nil
}
func (s *Coordinator) access(ctx context.Context, p *auth.Principal, m Migration) (string, string, error) {
	_, source, e1 := s.member(ctx, p, m.Manifest.SourceWalletID)
	_, target, e2 := s.member(ctx, p, m.Manifest.TargetWalletID)
	if e1 != nil && e2 != nil {
		return "", "", ErrMigrationForbidden
	}
	a, b := "", ""
	if source != nil {
		a = source.ID.String()
	}
	if target != nil {
		b = target.ID.String()
	}
	return a, b, nil
}
func (s *Coordinator) Create(ctx context.Context, p *auth.Principal, sourceID string, input DraftInput) (Migration, error) {
	source, _, err := s.member(ctx, p, sourceID)
	if err != nil {
		return Migration{}, err
	}
	target, targetMember, err := s.member(ctx, p, input.TargetWalletID)
	if err != nil || targetMember.Role != store.RoleOwner || sourceID == input.TargetWalletID {
		return Migration{}, ErrMigrationForbidden
	}
	old, oldRoster, err := s.inventory(ctx, source)
	if err != nil {
		return Migration{}, err
	}
	next, newRoster, err := s.inventory(ctx, target)
	if err != nil {
		return Migration{}, err
	}
	if len(input.Mappings) < 1 || len(input.Mappings) > 16 {
		return Migration{}, invalid("select the target account for every native source account")
	}
	mappings := map[string]AccountMapping{}
	for _, mapping := range input.Mappings {
		if _, exists := mappings[mapping.SourceAccountID]; exists {
			return Migration{}, invalid("duplicate source-account mapping")
		}
		mappings[mapping.SourceAccountID] = mapping
	}
	nextByKey := map[string]inventoryEntry{}
	for _, entry := range next {
		nextByKey[entry.Chain+"|"+entry.AccountID] = entry
	}
	manifest := MigrationManifest{Version: 1, ID: uuid.NewString(), SourceWalletID: sourceID, TargetWalletID: input.TargetWalletID,
		SourceEpoch: source.MembershipVersion, TargetEpoch: target.MembershipVersion, SourceKeygenID: source.KeyGenerationID.String(), TargetKeygenID: target.KeyGenerationID.String(), SourceRoster: oldRoster, TargetRoster: newRoster, RequiredApprovals: len(oldRoster)/2 + 1, RequiredTargetApprovals: len(newRoster)/2 + 1, Intents: []MigrationIntent{}}
	manifest.RequiredTargetApprovals = len(newRoster)/2 + 1
	for _, entry := range next {
		if entry.Policy.RaccoonThreshold > manifest.RequiredTargetApprovals {
			manifest.RequiredTargetApprovals = entry.Policy.RaccoonThreshold
		}
	}
	usedTargets := map[string]bool{}
	for _, entry := range old {
		mapping, ok := mappings[entry.AccountID]
		if !ok {
			return Migration{}, invalid("every registered native account needs a target")
		}
		replacement, ok := nextByKey[entry.Chain+"|"+mapping.TargetAccountID]
		if !ok || usedTargets[entry.Chain+"|"+mapping.TargetAccountID] {
			return Migration{}, invalid("target native policy is missing or reused")
		}
		usedTargets[entry.Chain+"|"+mapping.TargetAccountID] = true
		for _, oldKey := range entry.Policy.Members {
			for _, newKey := range replacement.Policy.Members {
				if entry.Chain == "bitcoin" && oldKey.Xpub == newKey.Xpub || entry.Chain == "hedera" && oldKey.PublicKey == newKey.PublicKey {
					return Migration{}, invalid("the replacement group must enroll fresh native keys")
				}
			}
		}
		intent := MigrationIntent{ID: uuid.NewString(), Chain: entry.Chain, SourceAccountID: entry.AccountID, TargetAccountID: replacement.AccountID, SourcePolicyID: entry.PolicyID, TargetPolicyID: replacement.PolicyID, SourcePolicy: entry.Policy, TargetPolicy: replacement.Policy}
		if entry.Policy.RaccoonThreshold > manifest.RequiredApprovals {
			manifest.RequiredApprovals = entry.Policy.RaccoonThreshold
		}
		if entry.Chain == "bitcoin" {
			if mapping.BitcoinCoins == nil {
				return Migration{}, invalid("choose the Bitcoin coin snapshot explicitly")
			}
			intent.BitcoinCoins = append([]MigrationCoin{}, mapping.BitcoinCoins...)
			sort.Slice(intent.BitcoinCoins, func(i, j int) bool {
				a, b := intent.BitcoinCoins[i], intent.BitcoinCoins[j]
				if a.TxID != b.TxID {
					return a.TxID < b.TxID
				}
				return a.Vout < b.Vout
			})
			if err = s.validateCoins(ctx, entry.Policy, intent.BitcoinCoins); err != nil {
				return Migration{}, err
			}
			if mapping.ChangeCursor > 10000 {
				return Migration{}, invalid("Bitcoin recovery scan limit reached")
			}
			intent.ChangeCursor = mapping.ChangeCursor
			fee := mapping.BitcoinMaxFee
			if fee == "" {
				fee = "100000"
			}
			intent.MaxFee, err = capAmount(fee, 1000000)
			if err != nil {
				return Migration{}, err
			}
			intent.Destination, intent.DestinationScript, err = replacement.Policy.BitcoinOutput(0, 0)
			if err != nil {
				return Migration{}, err
			}
			if s.bitcoin == nil {
				return Migration{}, invalid("Bitcoin verification is unavailable")
			}
			if err = s.bitcoin.NativeMigrationIdentity(ctx); err != nil {
				return Migration{}, err
			}
		} else {
			if !nativeAccountPattern.MatchString(entry.HederaAccountID) || entry.BoundCount != len(oldRoster) {
				return Migration{}, invalid("finish every source Hedera account confirmation before migration")
			}
			if replacement.HederaAccountID != "" && replacement.HederaAccountID != entry.HederaAccountID {
				return Migration{}, invalid("target Hedera policy is already bound to another account")
			}
			intent.HederaAccountID = entry.HederaAccountID
			intent.TargetKey, err = replacement.Policy.HederaKey()
			if err != nil {
				return Migration{}, err
			}
			fee := mapping.HederaMaxFee
			if fee == "" {
				fee = "100000000"
			}
			intent.MaxFee, err = capAmount(fee, 100000000)
			if err != nil {
				return Migration{}, err
			}
			if s.hedera == nil {
				return Migration{}, invalid("Hedera verification is unavailable")
			}
			account, err := s.hedera.NativeMigrationAccount(ctx, intent.HederaAccountID)
			if err != nil || !s.accountMatches(account, entry.Policy, intent.HederaAccountID) {
				return Migration{}, invalid("source Hedera key cannot be verified")
			}
		}
		manifest.Intents = append(manifest.Intents, intent)
	}
	now := s.now()
	m := Migration{Manifest: manifest, Digest: Hash(ManifestFields(manifest)), Status: "draft", Revision: 1, CreatedAt: now, UpdatedAt: now, Approvals: []MigrationApproval{}, Attempts: []MigrationAttempt{}, Progress: []MigrationProgress{}}
	if err = s.repo.Create(ctx, m); err != nil {
		return Migration{}, err
	}
	return m, nil
}
func (s *Coordinator) validateInventory(ctx context.Context, m Migration) error {
	sourceID, err := uuid.Parse(m.Manifest.SourceWalletID)
	if err != nil {
		return invalid("invalid source migration context")
	}
	targetID, err := uuid.Parse(m.Manifest.TargetWalletID)
	if err != nil {
		return invalid("invalid target migration context")
	}
	source, err := s.st.SharedWallets().GetWallet(ctx, sourceID)
	if err != nil {
		return err
	}
	target, err := s.st.SharedWallets().GetWallet(ctx, targetID)
	if err != nil {
		return err
	}
	if source.MembershipVersion != m.Manifest.SourceEpoch || target.MembershipVersion != m.Manifest.TargetEpoch || source.KeyGenerationID == nil || target.KeyGenerationID == nil || source.KeyGenerationID.String() != m.Manifest.SourceKeygenID || target.KeyGenerationID.String() != m.Manifest.TargetKeygenID {
		return invalid("participant context changed; migration cannot proceed")
	}
	entries, _, err := s.inventory(ctx, source)
	if err != nil {
		return err
	}
	next, _, err := s.inventory(ctx, target)
	if err != nil {
		return err
	}
	if len(entries) != len(m.Manifest.Intents) {
		return invalid("native source inventory changed")
	}
	for _, intent := range m.Manifest.Intents {
		oldFound, newFound := false, false
		for _, entry := range entries {
			if entry.Chain == intent.Chain && entry.AccountID == intent.SourceAccountID && entry.PolicyID == intent.SourcePolicyID {
				oldFound = true
			}
		}
		for _, entry := range next {
			if entry.Chain == intent.Chain && entry.AccountID == intent.TargetAccountID && entry.PolicyID == intent.TargetPolicyID {
				newFound = true
			}
		}
		if !oldFound || !newFound {
			return invalid("native policy changed; migration cannot proceed")
		}
	}
	return nil
}
func (s *Coordinator) Approve(ctx context.Context, p *auth.Principal, id, side, signature string) (Migration, error) {
	m, err := s.repo.Get(ctx, id)
	if err != nil {
		return Migration{}, err
	}
	if side != "source" && side != "target" {
		return Migration{}, invalid("invalid migration confirmation side")
	}
	walletID := m.Manifest.SourceWalletID
	if side == "target" {
		walletID = m.Manifest.TargetWalletID
	}
	_, member, err := s.member(ctx, p, walletID)
	if err != nil {
		return Migration{}, err
	}
	if m.Status != "draft" && m.Status != "frozen" && !(m.Status == "partial" && m.ReviewPending) {
		return Migration{}, invalid("migration is no longer accepting confirmations")
	}
	if m.Digest != Hash(ManifestFields(m.Manifest)) {
		return Migration{}, invalid("migration commitment changed")
	}
	data, _ := json.Marshal(ApprovalMessage(m, side))
	digest := sha256.Sum256(data)
	raw, err := base64.RawURLEncoding.DecodeString(signature)
	parsed, e := x509.ParsePKIXPublicKey(member.DevicePublicKey)
	pub, ok := parsed.(*ecdsa.PublicKey)
	if err != nil || e != nil || !ok || len(raw) != 64 || !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(raw[32:])) {
		return Migration{}, ErrMigrationForbidden
	}
	if err = s.validateInventory(ctx, m); err != nil {
		return Migration{}, err
	}
	return s.repo.Update(ctx, id, m.Revision, func(current *Migration) error {
		for _, approval := range current.Approvals {
			if approval.Side == side && approval.ParticipantID == member.ID.String() {
				return nil
			}
		}
		current.Approvals = append(current.Approvals, MigrationApproval{Side: side, ParticipantID: member.ID.String(), Signature: signature, At: s.now()})
		current.UpdatedAt = s.now()
		oldCount, newCount := 0, 0
		for _, approval := range current.Approvals {
			if approval.Side == "source" {
				oldCount++
			} else if approval.Side == "target" {
				newCount++
			}
		}
		if oldCount >= current.Manifest.RequiredApprovals && newCount >= current.Manifest.RequiredTargetApprovals {
			current.Status = "frozen"
			current.ReviewPending = false
			now := s.now()
			current.FrozenAt = &now
		}
		return nil
	})
}
func (s *Coordinator) Cancel(ctx context.Context, p *auth.Principal, id string) (Migration, error) {
	m, err := s.repo.Get(ctx, id)
	if err != nil {
		return Migration{}, err
	}
	_, member, err := s.member(ctx, p, m.Manifest.SourceWalletID)
	if err != nil {
		return Migration{}, err
	}
	if member.Role != store.RoleOwner && len(m.Approvals) > 0 {
		return Migration{}, ErrMigrationForbidden
	}
	return s.repo.Update(ctx, id, m.Revision, func(current *Migration) error {
		if current.Status != "draft" {
			return invalid("a frozen migration cannot be silently cancelled; reconcile and resume it")
		}
		current.Status = "cancelled"
		current.UpdatedAt = s.now()
		return nil
	})
}

func nativeTimestamp(value string) (*big.Int, error) {
	if !regexp.MustCompile(`^\d{1,12}\.\d{1,9}$`).MatchString(value) {
		return nil, invalid("invalid Hedera snapshot timestamp")
	}
	parts := strings.Split(value, ".")
	seconds, _ := new(big.Int).SetString(parts[0], 10)
	fraction, _ := new(big.Int).SetString(parts[1]+strings.Repeat("0", 9-len(parts[1])), 10)
	return new(big.Int).Add(new(big.Int).Mul(seconds, big.NewInt(1000000000)), fraction), nil
}
func (s *Coordinator) accountMatches(account *hedera.MirrorAccount, policy Policy, id string) bool {
	if account == nil || account.Account != id || account.Deleted == nil || *account.Deleted || account.ReceiverSignatureRequired == nil || *account.ReceiverSignatureRequired || account.Balance.Balance < 0 || account.Key.Type != "ProtobufEncoded" {
		return false
	}
	key, err := policy.HederaKey()
	if err != nil || !strings.EqualFold(account.Key.Key, key) {
		return false
	}
	stamp, err := nativeTimestamp(account.Balance.Timestamp)
	lower := new(big.Int).Mul(big.NewInt(s.now().Add(-2*time.Minute).UnixMilli()), big.NewInt(1000000))
	upper := new(big.Int).Mul(big.NewInt(s.now().Add(15*time.Second).UnixMilli()), big.NewInt(1000000))
	return err == nil && stamp.Cmp(lower) >= 0 && stamp.Cmp(upper) <= 0
}

// All activation checks are read-only. A missing result remains partial; neither
// the coordinator nor these verifiers can sign, submit or replace a transaction.
func (s *Coordinator) Check(ctx context.Context, p *auth.Principal, id string) (Migration, error) {
	m, err := s.repo.Get(ctx, id)
	if err != nil {
		return Migration{}, err
	}
	if _, _, err = s.access(ctx, p, m); err != nil {
		return Migration{}, err
	}
	if m.Status == "draft" || m.Status == "cancelled" {
		return m, nil
	}
	if err = s.validateInventory(ctx, m); err != nil {
		return Migration{}, err
	}
	progress := []MigrationProgress{}
	complete := true
	for _, intent := range m.Manifest.Intents {
		entry := MigrationProgress{IntentID: intent.ID, State: "pending", CheckedAt: s.now(), Detail: "No verified migration transaction"}
		var relevant []MigrationAttempt
		for _, attempt := range m.Attempts {
			if attempt.IntentID == intent.ID {
				relevant = append(relevant, attempt)
			}
		}
		if intent.Chain == "bitcoin" {
			known := append([]MigrationCoin{}, intent.BitcoinCoins...)
			for _, review := range m.ReviewHistory {
				for _, old := range review.Manifest.Intents {
					if old.ID == intent.ID {
						known = append(known, old.BitcoinCoins...)
					}
				}
			}
			entry = s.checkBitcoin(ctx, intent, relevant, known)
		} else {
			entry = s.checkHedera(ctx, intent, relevant)
		}
		if entry.State != "confirmed" {
			complete = false
		}
		progress = append(progress, entry)
	}
	return s.repo.Update(ctx, id, m.Revision, func(current *Migration) error {
		current.Progress = progress
		if current.CompletedAt != nil {
			current.Status = "complete"
			current.MonitoringWarning = ""
			if !complete {
				current.MonitoringWarning = "Historical confirmation could not be reverified. Keep the old policy recovery data and check the affected chain."
			}
		} else {
			current.Status = "partial"
			if complete && !current.ReviewPending {
				current.Status = "complete"
				now := s.now()
				current.CompletedAt = &now
			}
		}
		current.UpdatedAt = s.now()
		return nil
	})
}

func (s *Coordinator) checkBitcoin(ctx context.Context, intent MigrationIntent, attempts []MigrationAttempt, known []MigrationCoin) MigrationProgress {
	result := MigrationProgress{IntentID: intent.ID, State: "pending", Detail: "Every nominated Bitcoin coin needs a registered sweep with six confirmations", CheckedAt: s.now()}
	if s.bitcoin == nil || s.bitcoin.NativeMigrationIdentity(ctx) != nil {
		result.State = "unknown"
		result.Detail = "Bitcoin network verification is unavailable"
		return result
	}
	if _, err := ValidatePolicy(intent.SourcePolicy); err != nil {
		result.State = "unknown"
		result.Detail = "Source Bitcoin policy cannot be verified"
		return result
	}
	if len(intent.BitcoinCoins) == 0 {
		result.State = "confirmed"
		result.Detail = "No Bitcoin coins were nominated. Other and later funds still require the old quorum."
		return result
	}
	points := map[string]MigrationCoin{}
	scripts := map[string]string{}
	for _, coin := range known {
		key := fmt.Sprintf("%s:%d", coin.TxID, coin.Vout)
		points[key] = coin
		_, script, err := intent.SourcePolicy.BitcoinOutput(coin.Branch, coin.Index)
		if err != nil {
			result.State = "unknown"
			return result
		}
		scripts[key] = script
	}
	covered := map[string]bool{}
	seenTransactions := map[string]bool{}
	for _, attempt := range attempts {
		if seenTransactions[attempt.TxID] {
			continue
		}
		tx, confirmations, err := s.bitcoin.NativeMigrationTransaction(ctx, attempt.TxID)
		if err != nil || tx == nil || tx.TxID != attempt.TxID || confirmations < 6 || len(tx.Vin) == 0 || len(tx.Vin) > 100 || len(tx.Vout) != 1 {
			continue
		}
		out := tx.Vout[0]
		if out.Scriptpubkey != intent.DestinationScript || out.ScriptpubkeyAddress != intent.Destination || out.Value <= 0 || out.Value > 2100000000000000 {
			continue
		}
		total := int64(0)
		seen := map[string]bool{}
		valid := true
		for _, input := range tx.Vin {
			point := fmt.Sprintf("%s:%d", input.TxID, input.Vout)
			coin, exists := points[point]
			if !exists || input.IsCoinbase || input.Prevout == nil || input.Prevout.Value <= 0 || input.Prevout.Value > 2100000000000000 || scripts[point] != input.Prevout.Scriptpubkey || strconv.FormatInt(input.Prevout.Value, 10) != coin.Value || seen[point] {
				valid = false
				break
			}
			seen[point] = true
			total += input.Prevout.Value
			if total > 2100000000000000 {
				valid = false
				break
			}
		}
		approved, _ := strconv.ParseInt(attempt.MaxFee, 10, 64)
		fee := total - out.Value
		if !valid || fee < 0 || fee > approved {
			continue
		}
		for point := range seen {
			covered[point] = true
		}
		seenTransactions[attempt.TxID] = true
		result.TxID = attempt.TxID
	}
	allCovered := true
	for _, coin := range intent.BitcoinCoins {
		if !covered[coinPoint(coin)] {
			allCovered = false
		}
	}
	if allCovered {
		result.State = "confirmed"
		result.Detail = "Every nominated Bitcoin coin is covered by a verified six-confirmation sweep. Other and later coins remain with the old quorum."
	}
	return result
}
func (s *Coordinator) checkHedera(ctx context.Context, intent MigrationIntent, attempts []MigrationAttempt) MigrationProgress {
	result := MigrationProgress{IntentID: intent.ID, State: "pending", Detail: "Both old and new native quorums must authorize the exact Hedera key update", CheckedAt: s.now()}
	if s.hedera == nil {
		result.State = "unknown"
		return result
	}
	account, err := s.hedera.NativeMigrationAccount(ctx, intent.HederaAccountID)
	if err != nil {
		result.State = "unknown"
		result.Detail = "Hedera account verification is unavailable"
		return result
	}
	if !s.accountMatches(account, intent.TargetPolicy, intent.HederaAccountID) {
		return result
	}
	for _, attempt := range attempts {
		receipt, err := s.hedera.NativeMigrationReceipt(ctx, attempt.TxID)
		if err != nil {
			result.State = "unknown"
			continue
		}
		if receipt == nil || !receipt.Found || receipt.Result != "SUCCESS" || receipt.IntentMemo != attempt.Memo {
			continue
		}
		fee, err := strconv.ParseInt(receipt.FeeTinybars, 10, 64)
		approved, _ := strconv.ParseInt(attempt.MaxFee, 10, 64)
		balanceTime, e1 := nativeTimestamp(account.Balance.Timestamp)
		receiptTime, e2 := nativeTimestamp(receipt.Timestamp)
		if err != nil || fee < 0 || fee > approved || e1 != nil || e2 != nil || balanceTime.Cmp(receiptTime) < 0 {
			continue
		}
		result.State = "confirmed"
		result.TxID = attempt.TxID
		result.Detail = "Exact Hedera key-update receipt and complete new native threshold key verified"
		return result
	}
	return result
}

// Stable presentation order for migration histories, independent of map order.
func sortedMigrations(items []Migration) []Migration {
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	return items
}
