package account

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

type Handlers struct {
	svc   *Service
	store store.Store
}

func NewHandlers(svc *Service, st store.Store) *Handlers {
	return &Handlers{svc: svc, store: st}
}

func walletJSON(w *store.Wallet, accounts []map[string]any) map[string]any {
	return map[string]any{
		"id":                 w.ID.String(),
		"label":              w.Label,
		"defaultSigningMode": string(w.DefaultSigningMode),
		"accounts":           accounts,
		"createdAt":          w.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func accountJSON(a *store.Account, addresses []map[string]any) map[string]any {
	m := map[string]any{
		"id":          a.ID.String(),
		"walletId":    a.WalletID.String(),
		"name":        a.Name,
		"signingMode": string(a.SigningMode),
		"hidden":      a.Hidden,
		"addresses":   addresses,
	}
	if a.HDIndex != nil {
		m["hdIndex"] = *a.HDIndex
	}
	return m
}

func addressJSON(a *store.Address) map[string]any {
	return map[string]any{
		"id":            a.ID.String(),
		"networkFamily": string(a.NetworkFamily),
		"address":       a.Address,
	}
}

func (h *Handlers) ListWallets(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	wallets, byWallet, byAccount, err := h.svc.ListWalletsWithAccounts(r.Context(), p.UserID)
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	out := make([]map[string]any, 0, len(wallets))
	for _, wallet := range wallets {
		accs := byWallet[wallet.ID]
		accJSON := make([]map[string]any, 0, len(accs))
		for _, acc := range accs {
			addrs := byAccount[acc.ID]
			addrJSON := make([]map[string]any, 0, len(addrs))
			for _, addr := range addrs {
				addrJSON = append(addrJSON, addressJSON(addr))
			}
			accJSON = append(accJSON, accountJSON(acc, addrJSON))
		}
		out = append(out, walletJSON(wallet, accJSON))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"wallets": out})
}

type createWalletRequest struct {
	Label string `json:"label"`
}

func (h *Handlers) CreateWallet(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	var req createWalletRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Label == "" {
		httpx.BadRequest(w, r, "INVALID_BODY", "label is required")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	httpx.IdempotentCreate(r.Context(), h.store.Idempotency(), p.UserID, key, "POST /v1/wallets", w, func() (int, any, error) {
		wallet, err := h.svc.CreateWallet(r.Context(), p.UserID, req.Label)
		if err != nil {
			httpx.InternalError(w, r, "INTERNAL", "")
			return 0, nil, err
		}
		return http.StatusCreated, walletJSON(wallet, []map[string]any{}), nil
	})
}

type createAccountRequest struct {
	HDIndex int64  `json:"hdIndex"`
	Name    string `json:"name"`
}

func (h *Handlers) CreateAccount(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	walletID, err := uuid.Parse(chi.URLParam(r, "walletId"))
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	var req createAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || req.HDIndex < 0 {
		httpx.BadRequest(w, r, "INVALID_BODY", "hdIndex and name are required")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	httpx.IdempotentCreate(r.Context(), h.store.Idempotency(), p.UserID, key, "POST /v1/wallets/"+walletID.String()+"/accounts", w, func() (int, any, error) {
		acc, err := h.svc.CreateAccount(r.Context(), p.UserID, walletID, req.HDIndex, req.Name)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				httpx.NotFound(w, r, "NOT_FOUND", "")
			} else if errors.Is(err, ErrHDIndexTaken) {
				httpx.Conflict(w, r, "HD_INDEX_TAKEN", "This HD index is already used in this wallet")
			} else {
				httpx.InternalError(w, r, "INTERNAL", "")
			}
			return 0, nil, err
		}
		return http.StatusCreated, accountJSON(acc, []map[string]any{}), nil
	})
}

type updateAccountRequest struct {
	Name   *string `json:"name"`
	Hidden *bool   `json:"hidden"`
}

func (h *Handlers) UpdateAccount(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	accountID, err := uuid.Parse(chi.URLParam(r, "accountId"))
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	var req updateAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "")
		return
	}
	acc, err := h.svc.UpdateAccount(r.Context(), p.UserID, accountID, req.Name, req.Hidden)
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	addrs, _ := h.svc.ListAddresses(r.Context(), p.UserID, accountID)
	addrJSON := make([]map[string]any, 0, len(addrs))
	for _, a := range addrs {
		addrJSON = append(addrJSON, addressJSON(a))
	}
	httpx.WriteJSON(w, http.StatusOK, accountJSON(acc, addrJSON))
}

type registerAddressRequest struct {
	NetworkFamily string `json:"networkFamily"`
	Address       string `json:"address"`
	Proof         string `json:"proof"`
}

func (h *Handlers) RegisterAddress(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	accountID, err := uuid.Parse(chi.URLParam(r, "accountId"))
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	var req registerAddressRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.NetworkFamily == "" || req.Address == "" || req.Proof == "" {
		httpx.BadRequest(w, r, "INVALID_BODY", "networkFamily, address and proof are required")
		return
	}
	addr, err := h.svc.RegisterAddress(r.Context(), p.UserID, accountID, req.NetworkFamily, req.Address, req.Proof)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.NotFound(w, r, "NOT_FOUND", "")
			return
		}
		httpx.BadRequest(w, r, "INVALID_PROOF", err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, addressJSON(addr))
}
