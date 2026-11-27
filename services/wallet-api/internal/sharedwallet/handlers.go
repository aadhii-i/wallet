package sharedwallet

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/authorization"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

const SepoliaChainID int64 = 11155111

// executionChains are the only chains a shared-wallet proposal may target and
// the relayer may submit to: public testnets and local Anvil. The on-chain
// Raccoon verifier is research-grade, so no mainnet is ever listed here.
var executionChains = map[int64]bool{
	SepoliaChainID: true, // Ethereum Sepolia
	84532:          true, // Base Sepolia
	421614:         true, // Arbitrum Sepolia
	80002:          true, // Polygon Amoy
	31337:          true, // local Anvil
}

// ExecutionChainAllowed reports whether shared-wallet proposals and relayer
// execution are permitted on chainID (testnets and local Anvil only).
func ExecutionChainAllowed(chainID int64) bool { return executionChains[chainID] }

type Handlers struct {
	svc      *Service
	relayer  *Relayer
	index    HistoryIndex
	networks func(chainID int64) (*HistoryNetwork, bool)
	sanitize func(string) string
}

func NewHandlers(svc *Service) *Handlers { return &Handlers{svc: svc} }

// Routes mounts every endpoint; the caller wraps it in the auth middleware.
func (h *Handlers) Routes(r chi.Router) {
	r.Post("/v1/shared-wallets", h.createWallet)
	r.Get("/v1/shared-wallets", h.listWallets)
	r.Get("/v1/shared-wallets/{walletId}", h.getWallet)
	r.Get("/v1/shared-wallets/{walletId}/authorization-policy", h.getPolicy)
	r.Post("/v1/shared-wallets/{walletId}/invitations", h.createInvitation)
	r.Post("/v1/shared-wallets/{walletId}/invitations/{invitationId}/revoke", h.revokeInvitation)
	r.Post("/v1/shared-wallets/{walletId}/participants/{participantId}/revoke", h.revokeParticipant)
	r.Post("/v1/shared-wallets/{walletId}/accounts", h.createAccount)
	r.Post("/v1/shared-wallets/{walletId}/proposals", h.createProposal)
	r.Get("/v1/shared-wallets/{walletId}/proposals", h.listProposals)
	r.Get("/v1/shared-wallets/{walletId}/history", h.walletHistory)
	r.Post("/v1/shared-wallet-invitations/preview", h.previewInvitation)
	r.Post("/v1/shared-wallet-invitations/accept", h.acceptInvitation)
	r.Post("/v1/shared-wallet-invitations/reject", h.rejectInvitation)
	r.Get("/v1/proposals/{proposalId}", h.getProposal)
	r.Post("/v1/proposals/{proposalId}/vote-nonce", h.voteNonce)
	r.Post("/v1/proposals/{proposalId}/votes", h.castVote)
	h.keygenRoutes(r)
	h.signingRoutes(r)
	h.gasRoutes(r)
}

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.NotFound(w, r, "NOT_FOUND", "")
	case errors.Is(err, ErrForbidden):
		httpx.Forbidden(w, r, "FORBIDDEN", "Not permitted for this participant")
	case errors.Is(err, ErrWrongDevice):
		httpx.Forbidden(w, r, "WRONG_DEVICE", err.Error())
	case errors.Is(err, ErrInvalid), errors.Is(err, authorization.ErrInvalidPolicy):
		httpx.BadRequest(w, r, "INVALID_BODY", err.Error())
	case errors.Is(err, ErrAlreadyMember):
		httpx.Conflict(w, r, "ALREADY_PARTICIPANT", err.Error())
	case errors.Is(err, ErrInvitationInvalid):
		httpx.BadRequest(w, r, "INVITATION_INVALID", err.Error())
	case errors.Is(err, ErrLimit):
		httpx.Conflict(w, r, "LIMIT_REACHED", err.Error())
	case errors.Is(err, store.ErrNativeMigrationRequired):
		httpx.Conflict(w, r, "NATIVE_MIGRATION_REQUIRED", "Migrate native shared accounts with the current quorum before changing participants")
	case errors.Is(err, ErrStale):
		httpx.Conflict(w, r, "MEMBERSHIP_CHANGED", err.Error())
	case errors.Is(err, ErrNonceInvalid):
		httpx.BadRequest(w, r, "VOTE_NONCE_INVALID", err.Error())
	case errors.Is(err, ErrBadSignature):
		httpx.BadRequest(w, r, "VOTE_SIGNATURE_INVALID", err.Error())
	case errors.Is(err, ErrDigestMismatch):
		httpx.BadRequest(w, r, "DIGEST_MISMATCH", err.Error())
	case errors.Is(err, ErrClosed):
		httpx.Conflict(w, r, "PROPOSAL_CLOSED", err.Error())
	case errors.Is(err, ErrNotEligible):
		httpx.Forbidden(w, r, "NOT_ELIGIBLE", err.Error())
	case errors.Is(err, ErrDuplicateVote):
		httpx.Conflict(w, r, "DUPLICATE_VOTE", err.Error())
	case errors.Is(err, ErrKeygenInProgress):
		httpx.Conflict(w, r, "KEYGEN_IN_PROGRESS", err.Error())
	case errors.Is(err, ErrAlreadyInitialized):
		httpx.Conflict(w, r, "KEY_ALREADY_INITIALIZED", err.Error())
	case errors.Is(err, ErrKeygenNotOpen):
		httpx.Conflict(w, r, "KEYGEN_NOT_OPEN", err.Error())
	case errors.Is(err, ErrKeygenIncomplete):
		httpx.Conflict(w, r, "KEYGEN_INCOMPLETE", err.Error())
	case errors.Is(err, ErrFingerprintMismatch):
		httpx.BadRequest(w, r, "FINGERPRINT_MISMATCH", err.Error())
	case errors.Is(err, ErrAlreadyProvisioned):
		httpx.Conflict(w, r, "ALREADY_PROVISIONED", err.Error())
	case errors.Is(err, ErrAlreadyRegistered):
		httpx.Conflict(w, r, "ALREADY_REGISTERED", err.Error())
	case errors.Is(err, ErrKeygenSignature):
		httpx.BadRequest(w, r, "SIGNATURE_INVALID", err.Error())
	case errors.Is(err, ErrNotInKeyGeneration):
		httpx.Forbidden(w, r, "NOT_IN_KEY_GENERATION", err.Error())
	case errors.Is(err, ErrInvalidFailureReason):
		httpx.BadRequest(w, r, "INVALID_BODY", err.Error())
	case errors.Is(err, ErrNotSigner):
		httpx.Forbidden(w, r, "NOT_SELECTED_SIGNER", err.Error())
	case errors.Is(err, ErrSigningNotReady):
		httpx.Conflict(w, r, "SIGNING_NOT_READY", err.Error())
	case errors.Is(err, ErrSigningClosed):
		httpx.Conflict(w, r, "SIGNING_SESSION_CLOSED", err.Error())
	case errors.Is(err, ErrAlreadySigned):
		httpx.Conflict(w, r, "ALREADY_SIGNED", err.Error())
	case errors.Is(err, ErrSessionOpen):
		httpx.Conflict(w, r, "SIGNING_SESSION_OPEN", err.Error())
	case errors.Is(err, ErrAccountKeyMismatch):
		httpx.Conflict(w, r, "ACCOUNT_KEY_MISMATCH", err.Error())
	case errors.Is(err, ErrTranscriptMismatch):
		httpx.Conflict(w, r, "TRANSCRIPT_MISMATCH", err.Error())
	case errors.Is(err, ErrBadRoundPayload):
		httpx.BadRequest(w, r, "ROUND_MESSAGE_INVALID", err.Error())
	case errors.Is(err, ErrDuplicateRoundMessage):
		httpx.Conflict(w, r, "DUPLICATE_ROUND_MESSAGE", err.Error())
	case errors.Is(err, ErrTooManyAttempts):
		httpx.Conflict(w, r, "SIGNING_ATTEMPTS_EXHAUSTED", err.Error())
	case errors.Is(err, ErrProposalTooLate):
		httpx.Conflict(w, r, "PROPOSAL_EXPIRES_TOO_SOON", err.Error())
	case errors.Is(err, ErrInvalidAbortReason):
		httpx.BadRequest(w, r, "INVALID_BODY", err.Error())
	default:
		httpx.InternalError(w, r, "INTERNAL", "")
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "malformed JSON body")
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return uuid.Nil, false
	}
	return id, true
}

// ---- JSON shapes ---------------------------------------------------------------

func policyJSON(w *store.SharedWallet, active, required int) map[string]any {
	return map[string]any{
		"version": w.PolicyVersion, "numerator": w.PolicyNumerator, "denominator": w.PolicyDenominator,
		"rounding": w.PolicyRounding, "membershipVersion": w.MembershipVersion,
		"activeParticipants": active, "requiredApprovals": required,
		"maxParticipants": MaxMembers,
	}
}

func memberJSON(m *store.SharedMember) map[string]any {
	out := map[string]any{
		"id": m.ID.String(), "displayName": m.DisplayName, "role": string(m.Role), "status": string(m.Status),
		"joinedAt": ts(m.JoinedAt),
	}
	if m.RevokedAt != nil {
		out["revokedAt"] = ts(*m.RevokedAt)
	}
	return out
}

func viewJSON(v *View) map[string]any {
	members := make([]map[string]any, 0, len(v.Members))
	for _, m := range v.Members {
		members = append(members, memberJSON(m))
	}
	accounts := make([]map[string]any, 0, len(v.Accounts))
	for _, a := range v.Accounts {
		acct := map[string]any{
			"id": a.ID.String(), "name": a.Name, "derivationIndex": a.DerivationIndex,
			// The QdAccount address exists once a participant's device has
			// registered pk_j for the active key (it is derived from pk_j).
			"address": nil, "createdAt": ts(a.CreatedAt),
		}
		if k, ok := v.AccountKeys[a.ID]; ok {
			acct["address"] = k.Address
			acct["key"] = accountKeyJSON(k, false)
		}
		accounts = append(accounts, acct)
	}
	out := map[string]any{
		"id": v.Wallet.ID.String(), "name": v.Wallet.Name, "createdAt": ts(v.Wallet.CreatedAt),
		"keyStatus": string(v.Wallet.KeyStatus), "nativeCustodyLocked": v.Wallet.NativeCustodyLocked,
		"key":    keyJSON(v),
		"policy": policyJSON(v.Wallet, v.Active, v.Required),
		"me":     memberJSON(v.Me), "participants": members, "accounts": accounts,
	}
	if v.Invitations != nil {
		invs := make([]map[string]any, 0, len(v.Invitations))
		for _, i := range v.Invitations {
			invs = append(invs, map[string]any{
				"id": i.ID.String(), "label": i.Label, "status": string(i.Status),
				"expiresAt": ts(i.ExpiresAt), "createdAt": ts(i.CreatedAt),
			})
		}
		out["invitations"] = invs
	}
	return out
}

func proposalJSON(v *ProposalView) map[string]any {
	p := v.Proposal
	eligible := make([]string, len(p.EligibleMemberIDs))
	for i, id := range p.EligibleMemberIDs {
		eligible[i] = id.String()
	}
	votes := make([]map[string]any, 0, len(v.Votes))
	for _, x := range v.Votes {
		votes = append(votes, map[string]any{"participantId": x.MemberID.String(), "decision": string(x.Decision), "createdAt": ts(x.CreatedAt)})
	}
	out := map[string]any{
		"id": p.ID.String(), "walletId": p.WalletID.String(), "accountId": p.AccountID.String(),
		"derivationIndex": p.DerivationIndex, "initiatorParticipantId": p.InitiatorMemberID.String(),
		"senderAddress": nil,
		"chainId":       p.ChainID, "to": p.To, "valueWei": p.ValueWei, "data": p.Data,
		"nonce": p.Nonce, "gasLimit": p.GasLimit, "maxFeePerGas": p.MaxFeePerGas, "maxPriorityFeePerGas": p.MaxPriorityFeePerGas,
		"policy": map[string]any{
			"version": p.PolicyVersion, "numerator": p.PolicyNumerator, "denominator": p.PolicyDenominator, "rounding": p.PolicyRounding,
		},
		"membershipVersion": p.MembershipVersion, "participantCount": p.ParticipantCount,
		"requiredApprovals": p.RequiredApprovals, "eligibleParticipantIds": eligible,
		"digest": hex.EncodeToString(p.Digest), "status": string(p.Status),
		"approvals": v.Approvals, "rejections": v.Rejections,
		"remainingApprovals": max(0, p.RequiredApprovals-v.Approvals),
		"votes":              votes,
		"expiresAt":          ts(p.ExpiresAt), "createdAt": ts(p.CreatedAt),
		"lifecycle": v.Lifecycle(),
		"execution": map[string]any{"status": "not_started"},
	}
	if v.AccountKey != nil {
		out["senderAddress"] = v.AccountKey.Address
	}
	if v.Execution != nil {
		out["execution"] = executionJSON(v.Execution)
	}
	if v.MyVote != nil {
		out["myVote"] = string(v.MyVote.Decision)
	}
	if v.SigningJob != nil {
		signers := make([]string, len(v.SigningJob.Signers))
		for i, id := range v.SigningJob.Signers {
			signers[i] = id.String()
		}
		signing := map[string]any{"status": string(v.SigningJob.Status), "signers": signers, "createdAt": ts(v.SigningJob.CreatedAt)}
		if v.KeyReady {
			// A Raccoon key matching the proposal's snapshot exists.
			signing["status"] = "ready"
			signing["signerPartyIndexes"] = v.SignerIndexes
			if v.AccountKey == nil {
				signing["status"] = "awaiting_account_key"
			}
		}
		if v.Session != nil {
			signing["session"] = sessionJSON(v.Session, v.Messages)
			signing["status"] = string(v.Session.Status)
		}
		out["signing"] = signing
	}
	return out
}

// ---- handlers ------------------------------------------------------------------

func (h *Handlers) createWallet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
	}
	if !decode(w, r, &req) {
		return
	}
	p := auth.FromContext(r.Context())
	wallet, err := h.svc.CreateWallet(r.Context(), p, req.Name, req.DisplayName)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	v, err := h.svc.GetWallet(r.Context(), p, wallet.ID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, viewJSON(v))
}

func (h *Handlers) listWallets(w http.ResponseWriter, r *http.Request) {
	views, err := h.svc.ListWallets(r.Context(), auth.FromContext(r.Context()))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(views))
	for _, v := range views {
		out = append(out, viewJSON(v))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"wallets": out})
}

func (h *Handlers) getWallet(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	v, err := h.svc.GetWallet(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, viewJSON(v))
}

func (h *Handlers) getPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	v, err := h.svc.GetWallet(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, policyJSON(v.Wallet, v.Active, v.Required))
}

func (h *Handlers) createInvitation(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	var req struct {
		Label string `json:"label"`
	}
	if !decode(w, r, &req) {
		return
	}
	inv, code, err := h.svc.CreateInvitation(r.Context(), auth.FromContext(r.Context()), id, req.Label)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	// The code is returned exactly once; only its hash is stored.
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{
		"id": inv.ID.String(), "code": code, "label": inv.Label, "status": string(inv.Status), "expiresAt": ts(inv.ExpiresAt),
	})
}

func (h *Handlers) revokeInvitation(w http.ResponseWriter, r *http.Request) {
	wid, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	iid, ok := pathID(w, r, "invitationId")
	if !ok {
		return
	}
	if err := h.svc.RevokeInvitation(r.Context(), auth.FromContext(r.Context()), wid, iid); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) revokeParticipant(w http.ResponseWriter, r *http.Request) {
	wid, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	pid, ok := pathID(w, r, "participantId")
	if !ok {
		return
	}
	wallet, err := h.svc.RevokeParticipant(r.Context(), auth.FromContext(r.Context()), wid, pid)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"membershipVersion": wallet.MembershipVersion, "keyStatus": string(wallet.KeyStatus)})
}

type codeRequest struct {
	Code        string `json:"code"`
	DisplayName string `json:"displayName,omitempty"`
}

func (h *Handlers) previewInvitation(w http.ResponseWriter, r *http.Request) {
	var req codeRequest
	if !decode(w, r, &req) {
		return
	}
	prev, err := h.svc.PreviewInvitation(r.Context(), req.Code)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"walletId": prev.WalletID.String(), "walletName": prev.WalletName, "invitedBy": prev.InvitedBy,
		"activeParticipants": prev.Active, "expiresAt": ts(prev.ExpiresAt),
	})
}

func (h *Handlers) acceptInvitation(w http.ResponseWriter, r *http.Request) {
	var req codeRequest
	if !decode(w, r, &req) {
		return
	}
	p := auth.FromContext(r.Context())
	wallet, _, err := h.svc.AcceptInvitation(r.Context(), p, req.Code, req.DisplayName)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	v, err := h.svc.GetWallet(r.Context(), p, wallet.ID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, viewJSON(v))
}

func (h *Handlers) rejectInvitation(w http.ResponseWriter, r *http.Request) {
	var req codeRequest
	if !decode(w, r, &req) {
		return
	}
	if err := h.svc.RejectInvitation(r.Context(), auth.FromContext(r.Context()), req.Code); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) createAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &req) {
		return
	}
	a, err := h.svc.CreateAccount(r.Context(), auth.FromContext(r.Context()), id, req.Name)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{
		"id": a.ID.String(), "name": a.Name, "derivationIndex": a.DerivationIndex, "address": nil, "createdAt": ts(a.CreatedAt),
	})
}

func (h *Handlers) createProposal(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	var req struct {
		AccountID            string `json:"accountId"`
		ChainID              int64  `json:"chainId"`
		To                   string `json:"to"`
		ValueWei             string `json:"valueWei"`
		Data                 string `json:"data"`
		Nonce                uint64 `json:"nonce"`
		GasLimit             uint64 `json:"gasLimit"`
		MaxFeePerGas         string `json:"maxFeePerGas"`
		MaxPriorityFeePerGas string `json:"maxPriorityFeePerGas"`
		TTLSeconds           int64  `json:"ttlSeconds"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !ExecutionChainAllowed(req.ChainID) {
		httpx.BadRequest(w, r, "UNSUPPORTED_CHAIN", "Shared wallet execution is available on test networks only (Sepolia, Base Sepolia, Arbitrum Sepolia, Polygon Amoy, local Anvil)")
		return
	}
	acct, err := uuid.Parse(req.AccountID)
	if err != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "accountId must be a UUID")
		return
	}
	p := auth.FromContext(r.Context())
	prop, err := h.svc.CreateProposal(r.Context(), p, id, ProposalInput{
		AccountID: acct, ChainID: req.ChainID, To: req.To, ValueWei: req.ValueWei, Data: req.Data,
		Nonce: req.Nonce, GasLimit: req.GasLimit, MaxFeePerGas: req.MaxFeePerGas, MaxPriorityFeePerGas: req.MaxPriorityFeePerGas,
		TTL: time.Duration(req.TTLSeconds) * time.Second,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	v, err := h.svc.GetProposal(r.Context(), p, prop.ID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, proposalJSON(v))
}

func (h *Handlers) listProposals(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	views, err := h.svc.ListProposals(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(views))
	for _, v := range views {
		out = append(out, proposalJSON(v))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"proposals": out})
}

func (h *Handlers) getProposal(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "proposalId")
	if !ok {
		return
	}
	v, err := h.svc.GetProposal(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, proposalJSON(v))
}

func (h *Handlers) voteNonce(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "proposalId")
	if !ok {
		return
	}
	n, err := h.svc.IssueVoteNonce(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"nonce": n.Nonce, "participantId": n.MemberID.String(), "expiresAt": ts(n.ExpiresAt)})
}

func (h *Handlers) castVote(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "proposalId")
	if !ok {
		return
	}
	var req struct {
		Decision  string `json:"decision"`
		Nonce     string `json:"nonce"`
		IssuedAt  int64  `json:"issuedAt"`
		Digest    string `json:"digest"`
		Signature string `json:"signature"`
	}
	if !decode(w, r, &req) {
		return
	}
	v, err := h.svc.CastVote(r.Context(), auth.FromContext(r.Context()), id, VoteInput{
		Decision: store.VoteDecision(req.Decision), Nonce: req.Nonce, IssuedAtUnix: req.IssuedAt, DigestHex: req.Digest, Signature: req.Signature,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, proposalJSON(v))
}
