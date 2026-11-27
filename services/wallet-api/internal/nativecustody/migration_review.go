package nativecustody

import (
	"context"
	"github.com/qdwallet/wallet-api/internal/auth"
	"sort"
)

// Review changes only the fee budget and nominated Bitcoin coins. Policies,
// destinations and participants cannot change after signatures have existed.
// Earlier authorizations remain in history: a signature is not revoked by an
// application amendment. Both groups must approve the revised review again.
type IntentReview struct {
	IntentID     string          `json:"intentId"`
	MaxFee       string          `json:"maxFee"`
	BitcoinCoins []MigrationCoin `json:"bitcoinCoins,omitempty"`
}

func (s *Coordinator) Review(ctx context.Context, actor *auth.Principal, id string, changes []IntentReview) (Migration, error) {
	m, err := s.repo.Get(ctx, id)
	if err != nil {
		return Migration{}, err
	}
	if _, _, err = s.member(ctx, actor, m.Manifest.SourceWalletID); err != nil {
		return Migration{}, err
	}
	if m.CompletedAt != nil || (m.Status != "frozen" && m.Status != "partial") || m.ReviewPending {
		return Migration{}, invalid("only a pending migration can receive a revised review")
	}
	if len(changes) != len(m.Manifest.Intents) || len(m.ReviewHistory) >= 16 {
		return Migration{}, invalid("review every migration account; recovery review capacity is limited")
	}
	byID := map[string]IntentReview{}
	for _, change := range changes {
		if _, ok := byID[change.IntentID]; ok {
			return Migration{}, invalid("duplicate migration review")
		}
		byID[change.IntentID] = change
	}
	// Repository reads return independent copies. Preserve the exact previous
	// manifest before replacing its coin/fee fields.
	previous := MigrationReview{Manifest: m.Manifest, Digest: m.Digest, Approvals: m.Approvals, At: s.now()}
	next := m.Manifest
	next.Intents = append([]MigrationIntent{}, m.Manifest.Intents...)
	for i, intent := range next.Intents {
		change, ok := byID[intent.ID]
		if !ok {
			return Migration{}, invalid("unknown migration review account")
		}
		limit := int64(100000000)
		if intent.Chain == "bitcoin" {
			limit = 1000000
		}
		fee, err := capAmount(change.MaxFee, limit)
		if err != nil {
			return Migration{}, err
		}
		intent.MaxFee = fee
		if intent.Chain == "bitcoin" {
			if change.BitcoinCoins == nil {
				return Migration{}, invalid("choose the revised Bitcoin snapshot explicitly")
			}
			if err = s.validateCoins(ctx, intent.SourcePolicy, change.BitcoinCoins); err != nil {
				return Migration{}, err
			}
			intent.BitcoinCoins = append([]MigrationCoin{}, change.BitcoinCoins...)
			sort.Slice(intent.BitcoinCoins, func(a, b int) bool {
				if intent.BitcoinCoins[a].TxID != intent.BitcoinCoins[b].TxID {
					return intent.BitcoinCoins[a].TxID < intent.BitcoinCoins[b].TxID
				}
				return intent.BitcoinCoins[a].Vout < intent.BitcoinCoins[b].Vout
			})
		} else if len(change.BitcoinCoins) > 0 {
			return Migration{}, invalid("Hedera review cannot nominate Bitcoin coins")
		}
		next.Intents[i] = intent
	}
	digest := Hash(ManifestFields(next))
	if digest == m.Digest {
		return Migration{}, invalid("the review has not changed")
	}
	if err = s.validateInventory(ctx, m); err != nil {
		return Migration{}, err
	}
	return s.repo.Update(ctx, id, m.Revision, func(current *Migration) error {
		current.ReviewHistory = append(current.ReviewHistory, previous)
		current.Manifest = next
		current.Digest = digest
		current.Approvals = []MigrationApproval{}
		current.ReviewPending = true
		current.Status = "partial"
		current.UpdatedAt = s.now()
		return nil
	})
}
