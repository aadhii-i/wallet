package nativecustody

import (
	"encoding/base64"
	"time"
)

type RosterMember struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role"`
	DeviceKey string `json:"deviceKey"`
}
type MigrationCoin struct {
	TxID   string `json:"txid"`
	Vout   uint32 `json:"vout"`
	Value  string `json:"value"`
	Branch uint32 `json:"branch"`
	Index  uint32 `json:"index"`
}
type MigrationIntent struct {
	ID                string          `json:"id"`
	Chain             string          `json:"chain"`
	SourceAccountID   string          `json:"sourceAccountId"`
	TargetAccountID   string          `json:"targetAccountId"`
	SourcePolicyID    string          `json:"sourcePolicyId"`
	TargetPolicyID    string          `json:"targetPolicyId"`
	SourcePolicy      Policy          `json:"sourcePolicy"`
	TargetPolicy      Policy          `json:"targetPolicy"`
	BitcoinCoins      []MigrationCoin `json:"bitcoinCoins"`
	ChangeCursor      uint32          `json:"changeCursor"`
	Destination       string          `json:"destination"`
	DestinationScript string          `json:"destinationScript"`
	HederaAccountID   string          `json:"hederaAccountId"`
	TargetKey         string          `json:"targetKey"`
	MaxFee            string          `json:"maxFee"`
}
type MigrationManifest struct {
	Version                 int               `json:"version"`
	ID                      string            `json:"id"`
	SourceWalletID          string            `json:"sourceWalletId"`
	TargetWalletID          string            `json:"targetWalletId"`
	SourceEpoch             int64             `json:"sourceEpoch"`
	TargetEpoch             int64             `json:"targetEpoch"`
	SourceKeygenID          string            `json:"sourceKeygenId"`
	TargetKeygenID          string            `json:"targetKeygenId"`
	SourceRoster            []RosterMember    `json:"sourceRoster"`
	TargetRoster            []RosterMember    `json:"targetRoster"`
	Intents                 []MigrationIntent `json:"intents"`
	RequiredApprovals       int               `json:"requiredApprovals"`
	RequiredTargetApprovals int               `json:"requiredTargetApprovals"`
}
type MigrationApproval struct {
	Side          string    `json:"side"`
	ParticipantID string    `json:"participantId"`
	Signature     string    `json:"signature"`
	At            time.Time `json:"at"`
}
type MigrationAttempt struct {
	IntentID       string    `json:"intentId"`
	Session        string    `json:"session"`
	TxID           string    `json:"txid"`
	MaxFee         string    `json:"maxFee"`
	Memo           string    `json:"memo"`
	SourceProposal any       `json:"sourceProposal"`
	TargetProposal any       `json:"targetProposal,omitempty"`
	RegisteredAt   time.Time `json:"registeredAt"`
	RegisteredBy   string    `json:"registeredBy"`
	Archived       bool      `json:"archived,omitempty"`
}
type MigrationProgress struct {
	IntentID  string    `json:"intentId"`
	State     string    `json:"state"`
	TxID      string    `json:"txid,omitempty"`
	Detail    string    `json:"detail"`
	CheckedAt time.Time `json:"checkedAt"`
}
type MigrationReview struct {
	Manifest  MigrationManifest   `json:"manifest"`
	Digest    string              `json:"digest"`
	Approvals []MigrationApproval `json:"approvals"`
	At        time.Time           `json:"at"`
}
type Migration struct {
	Manifest          MigrationManifest   `json:"manifest"`
	Digest            string              `json:"digest"`
	Status            string              `json:"status"`
	Revision          int64               `json:"revision"`
	Approvals         []MigrationApproval `json:"approvals"`
	Attempts          []MigrationAttempt  `json:"attempts"`
	Progress          []MigrationProgress `json:"progress"`
	ReviewPending     bool                `json:"reviewPending"`
	ReviewHistory     []MigrationReview   `json:"reviewHistory,omitempty"`
	CompletedAt       *time.Time          `json:"completedAt,omitempty"`
	MonitoringWarning string              `json:"monitoringWarning,omitempty"`
	CreatedAt         time.Time           `json:"createdAt"`
	FrozenAt          *time.Time          `json:"frozenAt,omitempty"`
	UpdatedAt         time.Time           `json:"updatedAt"`
}

func coinFields(coins []MigrationCoin) []any {
	out := []any{}
	for _, coin := range coins {
		out = append(out, []any{coin.TxID, coin.Vout, coin.Value, coin.Branch, coin.Index})
	}
	return out
}
func ManifestFields(m MigrationManifest) []any {
	roster := func(members []RosterMember) []any {
		out := []any{}
		for _, r := range members {
			out = append(out, []any{r.ID, base64.RawURLEncoding.EncodeToString([]byte(r.Name)), r.Role, r.DeviceKey})
		}
		return out
	}
	intents := []any{}
	for _, i := range m.Intents {
		intents = append(intents, []any{i.ID, i.Chain, i.SourceAccountID, i.TargetAccountID, i.SourcePolicyID, i.TargetPolicyID, coinFields(i.BitcoinCoins), i.ChangeCursor, i.Destination, i.DestinationScript, i.HederaAccountID, i.TargetKey, i.MaxFee})
	}
	return []any{"QDWallet-NativeMigrationManifest/v1", m.Version, m.ID, m.SourceWalletID, m.TargetWalletID, m.SourceEpoch, m.TargetEpoch, m.SourceKeygenID, m.TargetKeygenID, roster(m.SourceRoster), roster(m.TargetRoster), intents, m.RequiredApprovals, m.RequiredTargetApprovals}
}
func ApprovalMessage(m Migration, side string) []any {
	return []any{"QDWallet-NativeMigrationApproval/v1", side, m.Manifest.ID, m.Digest, m.Manifest.SourceWalletID, m.Manifest.TargetWalletID, m.Manifest.SourceEpoch, m.Manifest.TargetEpoch}
}
