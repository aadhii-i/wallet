package hedera

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
)

// The entire native key is returned for local policy verification, not just
// one key extracted from a threshold structure. Amounts remain decimal strings.
func (h *Handlers) GetInfo(w http.ResponseWriter, r *http.Request) {
	if chi.URLParam(r, "network") != "testnet" {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	id := chi.URLParam(r, "accountId")
	account, err := h.svc.mirror.GetAccount(r.Context(), id)
	if err != nil {
		serviceUnavailable(w, r, "HEDERA_INFO_UNAVAILABLE", "Account verification is unavailable")
		return
	}
	_, keyErr := hex.DecodeString(account.Key.Key)
	if account.Account != id || account.Deleted == nil || account.ReceiverSignatureRequired == nil || account.Balance.Balance < 0 || !regexp.MustCompile(`^\d+\.\d{1,9}$`).MatchString(account.Balance.Timestamp) || len(account.Key.Key) > 8192 || len(account.Key.Key) == 0 || keyErr != nil {
		serviceUnavailable(w, r, "HEDERA_INVALID_ACCOUNT", "Account verification data are incomplete")
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"accountId": id, "network": "testnet", "tinybars": strconv.FormatInt(account.Balance.Balance, 10), "balanceTimestamp": account.Balance.Timestamp, "deleted": *account.Deleted, "receiverSignatureRequired": *account.ReceiverSignatureRequired, "key": map[string]string{"type": account.Key.Type, "key": strings.ToLower(account.Key.Key)}})
}

var sdkTransactionID = regexp.MustCompile(`^(0\.0\.(?:0|[1-9][0-9]*))@(\d{1,12})\.(\d{9})$`)

// Receipt reconciliation is read-only: absence is unknown, never permission to
// create a replacement transaction or claim that an earlier submission failed.
func (h *Handlers) GetTransaction(w http.ResponseWriter, r *http.Request) {
	if chi.URLParam(r, "network") != "testnet" {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	id := chi.URLParam(r, "transactionId")
	if sdkTransactionID.FindStringSubmatch(id) == nil {
		httpx.BadRequest(w, r, "INVALID_TRANSACTION_ID", "Invalid transaction identifier")
		return
	}
	receipt, err := h.svc.NativeMigrationReceipt(r.Context(), id)
	if err != nil {
		serviceUnavailable(w, r, "MIRROR_NODE_ERROR", "Transaction lookup unavailable")
		return
	}
	httpx.WriteJSON(w, 200, receipt)
}

// NativeReceipt is indexed evidence, not a replacement for native consensus.
type NativeReceipt struct {
	Found         bool   `json:"found"`
	TransactionID string `json:"transactionId"`
	Result        string `json:"result,omitempty"`
	IntentMemo    string `json:"intentMemo,omitempty"`
	EntityID      string `json:"entityId,omitempty"`
	FeeTinybars   string `json:"feeTinybars,omitempty"`
	Timestamp     string `json:"timestamp,omitempty"`
}

func (s *Service) NativeMigrationAccount(ctx context.Context, id string) (*MirrorAccount, error) {
	return s.mirror.GetAccount(ctx, id)
}
func (s *Service) NativeMigrationReceipt(ctx context.Context, id string) (*NativeReceipt, error) {
	parts := sdkTransactionID.FindStringSubmatch(id)
	if parts == nil {
		return nil, errors.New("invalid Hedera transaction identifier")
	}
	nanos := parts[3]
	mirrorID := parts[1] + "-" + parts[2] + "-" + nanos
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.mirror.base+"/transactions/"+mirrorID+"?nonce=0", nil)
	if err != nil {
		return nil, errors.New("Hedera transaction lookup unavailable")
	}
	resp, err := s.mirror.client.Do(req)
	if err != nil {
		return nil, errors.New("Hedera transaction lookup unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return &NativeReceipt{TransactionID: id}, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, mirrorMaxBytes+1))
	var page MirrorTransactionPage
	if err != nil || len(body) > mirrorMaxBytes || resp.StatusCode != 200 || json.Unmarshal(body, &page) != nil {
		return nil, errors.New("Hedera transaction lookup unavailable")
	}
	var selected *MirrorTransaction
	for i := range page.Transactions {
		tx := &page.Transactions[i]
		if tx.TransactionID != mirrorID || tx.Result == "DUPLICATE_TRANSACTION" {
			continue
		}
		selected = tx
		if tx.Result == "SUCCESS" {
			break
		}
	}
	if selected == nil {
		return &NativeReceipt{TransactionID: id}, nil
	}
	memo, _ := base64.StdEncoding.DecodeString(selected.MemoBase64)
	if len(memo) > 100 {
		memo = nil
	}
	return &NativeReceipt{Found: true, TransactionID: id, Result: selected.Result, IntentMemo: string(memo), EntityID: selected.EntityID, FeeTinybars: strconv.FormatInt(selected.Charged_tx_fee, 10), Timestamp: selected.ConsensusTimestamp}, nil
}
