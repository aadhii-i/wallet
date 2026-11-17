package sharedwallet

import (
	"encoding/hex"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

func (h *Handlers) keygenRoutes(r chi.Router) {
	const base = "/v1/shared-wallets/{walletId}/key-generations"
	r.Post(base, h.startKeygen)
	r.Get(base+"/current", h.currentKeygen)
	r.Post(base+"/{keygenId}/encryption-key", h.registerEncryptionKey)
	// One envelope per request: a 64-party share is ~36 KB, under the 64 KB body limit.
	r.Put(base+"/{keygenId}/envelopes/{participantId}", h.stageEnvelope)
	r.Post(base+"/{keygenId}/commit", h.commitDeal)
	r.Get(base+"/{keygenId}/envelope", h.myEnvelope)
	r.Post(base+"/{keygenId}/acknowledge", h.acknowledgeShare)
	r.Post(base+"/{keygenId}/fail", h.failKeygen)
}

func hexOrNil(b []byte) any {
	if b == nil {
		return nil
	}
	return hex.EncodeToString(b)
}

func keygenSummaryJSON(kg *store.KeyGeneration, parts []*store.KeygenParticipant) map[string]any {
	registered, provisioned := 0, 0
	for _, p := range parts {
		if p.KeyRegisteredAt != nil {
			registered++
		}
		if p.ProvisionedAt != nil {
			provisioned++
		}
	}
	out := map[string]any{
		"id": kg.ID.String(), "status": string(kg.Status), "failureReason": kg.FailureReason,
		"threshold": kg.Threshold, "parties": kg.Parties, "membershipVersion": kg.MembershipVersion,
		"dealerParticipantId": kg.DealerMemberID.String(), "fingerprint": hexOrNil(kg.Fingerprint),
		"keysRegistered": registered, "provisioned": provisioned,
		"createdAt": ts(kg.CreatedAt), "expiresAt": ts(kg.ExpiresAt),
	}
	if kg.EndedAt != nil {
		out["endedAt"] = ts(*kg.EndedAt)
	}
	return out
}

// keygenJSON never includes envelope ciphertexts; each participant fetches
// only their own through /envelope.
func keygenJSON(v *KeygenView) map[string]any {
	out := keygenSummaryJSON(v.KG, v.Parts)
	parts := make([]map[string]any, 0, len(v.Parts))
	for _, p := range v.Parts {
		var key any
		if p.EncryptionKey != nil {
			key = b64.EncodeToString(p.EncryptionKey)
		}
		parts = append(parts, map[string]any{
			"participantId": p.MemberID.String(), "partyIndex": p.PartyIndex,
			"encryptionKey": key, "keyRegistered": p.KeyRegisteredAt != nil,
			"envelopeStaged": p.EnvelopeHash != nil && p.EnvelopeFingerprint != nil,
			"provisioned":    p.ProvisionedAt != nil,
		})
	}
	out["participants"] = parts
	if v.Me != nil {
		out["me"] = map[string]any{"participantId": v.Me.MemberID.String(), "partyIndex": v.Me.PartyIndex}
	} else {
		out["me"] = nil
	}
	return out
}

func keyJSON(v *View) map[string]any {
	out := map[string]any{"status": KeyInitStatus(v.Wallet, v.KeyGen)}
	if v.KeyGen != nil {
		out["generation"] = keygenSummaryJSON(v.KeyGen, v.KeyGenParts)
	}
	if v.Wallet.KeyStatus == store.KeyActive && v.Wallet.KeyGenerationID != nil {
		out["keyGenerationId"] = v.Wallet.KeyGenerationID.String()
		out["fingerprint"] = hexOrNil(v.Wallet.KeyFingerprint)
	}
	return out
}

func (h *Handlers) keygenIDs(w http.ResponseWriter, r *http.Request) (wid, kid uuid.UUID, ok bool) {
	walletID, ok := pathID(w, r, "walletId")
	if !ok {
		return wid, kid, false
	}
	keygenID, ok := pathID(w, r, "keygenId")
	if !ok {
		return wid, kid, false
	}
	return walletID, keygenID, true
}

func (h *Handlers) startKeygen(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	v, err := h.svc.StartKeyGeneration(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, keygenJSON(v))
}

func (h *Handlers) currentKeygen(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	v, err := h.svc.CurrentKeyGeneration(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, keygenJSON(v))
}

func (h *Handlers) registerEncryptionKey(w http.ResponseWriter, r *http.Request) {
	wid, kid, ok := h.keygenIDs(w, r)
	if !ok {
		return
	}
	var req struct {
		PublicKey string `json:"publicKey"`
		Signature string `json:"signature"`
	}
	if !decode(w, r, &req) {
		return
	}
	v, err := h.svc.RegisterEncryptionKey(r.Context(), auth.FromContext(r.Context()), wid, kid, req.PublicKey, req.Signature)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, keygenJSON(v))
}

func (h *Handlers) stageEnvelope(w http.ResponseWriter, r *http.Request) {
	wid, kid, ok := h.keygenIDs(w, r)
	if !ok {
		return
	}
	pid, ok := pathID(w, r, "participantId")
	if !ok {
		return
	}
	var req struct {
		Fingerprint string `json:"fingerprint"`
		Enc         string `json:"enc"`
		CT          string `json:"ct"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := h.svc.StageEnvelope(r.Context(), auth.FromContext(r.Context()), wid, kid, pid, req.Fingerprint, req.Enc, req.CT); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) commitDeal(w http.ResponseWriter, r *http.Request) {
	wid, kid, ok := h.keygenIDs(w, r)
	if !ok {
		return
	}
	var req struct {
		Fingerprint string `json:"fingerprint"`
		Signature   string `json:"signature"`
	}
	if !decode(w, r, &req) {
		return
	}
	v, err := h.svc.CommitDeal(r.Context(), auth.FromContext(r.Context()), wid, kid, req.Fingerprint, req.Signature)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, keygenJSON(v))
}

func (h *Handlers) myEnvelope(w http.ResponseWriter, r *http.Request) {
	wid, kid, ok := h.keygenIDs(w, r)
	if !ok {
		return
	}
	e, err := h.svc.MyEnvelope(r.Context(), auth.FromContext(r.Context()), wid, kid)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"walletId": e.KG.WalletID.String(), "keygenId": e.KG.ID.String(), "participantId": e.Part.MemberID.String(),
		"partyIndex": e.Part.PartyIndex, "threshold": e.KG.Threshold, "parties": e.KG.Parties,
		"membershipVersion": e.KG.MembershipVersion, "fingerprint": hex.EncodeToString(e.KG.Fingerprint),
		"enc": b64.EncodeToString(e.Part.EnvelopeEnc), "ct": b64.EncodeToString(e.Part.EnvelopeCT),
		"envelopeHash": hex.EncodeToString(e.Part.EnvelopeHash),
	})
}

func (h *Handlers) acknowledgeShare(w http.ResponseWriter, r *http.Request) {
	wid, kid, ok := h.keygenIDs(w, r)
	if !ok {
		return
	}
	var req struct {
		Fingerprint string `json:"fingerprint"`
		Signature   string `json:"signature"`
	}
	if !decode(w, r, &req) {
		return
	}
	v, err := h.svc.AcknowledgeShare(r.Context(), auth.FromContext(r.Context()), wid, kid, req.Fingerprint, req.Signature)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, keygenJSON(v))
}

func (h *Handlers) failKeygen(w http.ResponseWriter, r *http.Request) {
	wid, kid, ok := h.keygenIDs(w, r)
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if !decode(w, r, &req) {
		return
	}
	v, err := h.svc.FailKeyGeneration(r.Context(), auth.FromContext(r.Context()), wid, kid, req.Reason)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, keygenJSON(v))
}
