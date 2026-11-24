package sharedwallet

import (
	"encoding/hex"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

func (h *Handlers) signingRoutes(r chi.Router) {
	r.Post("/v1/shared-wallets/{walletId}/accounts/{accountId}/key", h.registerAccountKey)
	r.Get("/v1/shared-wallets/{walletId}/accounts/{accountId}/key", h.getAccountKey)
	r.Post("/v1/proposals/{proposalId}/signing-sessions", h.startSigning)
	r.Get("/v1/signing-sessions/{sessionId}", h.getSigning)
	r.Post("/v1/signing-sessions/{sessionId}/rounds/{round}", h.submitRound)
	r.Post("/v1/signing-sessions/{sessionId}/abort", h.abortSigning)
}

func accountKeyJSON(k *store.AccountKey, withKey bool) map[string]any {
	atts := make([]map[string]any, len(k.Attestations))
	for i, a := range k.Attestations {
		atts[i] = map[string]any{"participantId": a.MemberID.String(), "at": ts(a.At)}
	}
	out := map[string]any{
		"keyGenerationId": k.KeygenID.String(), "derivationIndex": k.DerivationIndex,
		"publicKeyHash": "0x" + hex.EncodeToString(k.PublicKeyHash), "address": k.Address,
		"attestations": atts, "createdAt": ts(k.CreatedAt),
	}
	if withKey {
		out["publicKey"] = b64.EncodeToString(k.PublicKey)
	}
	return out
}

func sessionJSON(ss *store.SigningSession, msgs []*store.SigningMessage) map[string]any {
	signers := make([]string, len(ss.SignerMemberIDs))
	for i, id := range ss.SignerMemberIDs {
		signers[i] = id.String()
	}
	progress := map[string][]int{"1": {}, "2": {}, "3": {}}
	for _, m := range msgs {
		k := strconv.Itoa(m.Round)
		progress[k] = append(progress[k], m.PartyIndex)
	}
	out := map[string]any{
		"id": ss.ID.String(), "proposalId": ss.ProposalID.String(), "attempt": ss.Attempt, "status": string(ss.Status),
		"round": ss.Status.Round(), "failureReason": ss.FailureReason,
		"keyGenerationId": ss.KeygenID.String(), "threshold": ss.Threshold, "parties": ss.Parties,
		"membershipVersion": ss.MembershipVersion, "derivationIndex": ss.DerivationIndex, "chainId": ss.ChainID,
		"signerPartyIndexes": ss.Act, "signerParticipantIds": signers,
		"sid": hex.EncodeToString(ss.SID), "message": "0x" + hex.EncodeToString(ss.Message),
		"accountAddress": ss.AccountAddress, "publicKeyHash": "0x" + hex.EncodeToString(ss.PublicKeyHash),
		"progress": progress, "createdAt": ts(ss.CreatedAt), "expiresAt": ts(ss.ExpiresAt),
	}
	if ss.FailedBy != nil {
		out["failedBy"] = ss.FailedBy.String()
	}
	if ss.EndedAt != nil {
		out["endedAt"] = ts(*ss.EndedAt)
	}
	if len(ss.Signature) > 0 {
		// Combined by the coordinator and verified (Raccoon Verify) before it was stored.
		out["signatureSha256"] = sha256Hex(ss.Signature)
		out["signatureVerified"] = true
	}
	return out
}

func executionJSON(e *store.Execution) map[string]any {
	out := map[string]any{
		"status": string(e.Status), "chainId": e.ChainID, "accountAddress": e.AccountAddress, "lastError": e.LastError,
		"relayer": e.RelayerAddress, "txHash": e.TxHash, "createdAt": ts(e.CreatedAt), "updatedAt": ts(e.UpdatedAt),
	}
	if e.BlockNumber != nil {
		out["blockNumber"] = *e.BlockNumber
	}
	if e.GasUsed != nil {
		out["gasUsed"] = *e.GasUsed
	}
	if e.CallSuccess != nil {
		out["callSuccess"] = *e.CallSuccess
	}
	if e.SubmittedAt != nil {
		out["submittedAt"] = ts(*e.SubmittedAt)
	}
	if e.ConfirmedAt != nil {
		out["confirmedAt"] = ts(*e.ConfirmedAt)
	}
	out["stage"] = e.Stage
	out["setupTxs"] = append([]string{}, e.SetupTxs...)
	out["setupAttempts"] = e.SetupAttempts
	if e.PendingSetupTx != "" {
		out["pendingSetupTx"] = e.PendingSetupTx
	}
	if e.NextAttemptAt != nil {
		out["nextAttemptAt"] = ts(*e.NextAttemptAt)
	}
	if e.TxNonce != nil {
		out["txNonce"] = *e.TxNonce
	}
	if e.EffectiveGasPrice != "" {
		out["effectiveGasPrice"] = e.EffectiveGasPrice
	}
	if e.BlockTime != nil {
		out["blockTime"] = ts(*e.BlockTime)
	}
	if e.ExecutedTo != "" {
		out["executedTo"] = e.ExecutedTo
		out["executedValue"] = e.ExecutedValue
	}
	return out
}

// signingViewJSON includes the payloads a signer needs for its next step
// (the previous round's messages), or every payload with ?payloads=all.
func signingViewJSON(v *SigningView, all bool) map[string]any {
	out := sessionJSON(v.Session, v.Messages)
	out["header"] = string(v.Header)
	if v.Transcript != nil {
		out["transcriptHash"] = hex.EncodeToString(v.Transcript)
	}
	cur := v.Session.Status.Round()
	msgs := make([]map[string]any, 0, len(v.Messages))
	for _, m := range v.Messages {
		j := map[string]any{
			"round": m.Round, "partyIndex": m.PartyIndex, "participantId": m.MemberID.String(),
			"payloadSha256": sha256Hex(m.Payload), "createdAt": ts(m.CreatedAt),
		}
		if all || (cur > 0 && m.Round == cur-1) {
			j["payload"] = b64.EncodeToString(m.Payload)
		}
		msgs = append(msgs, j)
	}
	out["messages"] = msgs
	if len(v.Session.Signature) > 0 {
		out["signature"] = b64.EncodeToString(v.Session.Signature)
	}
	if v.Execution != nil {
		out["execution"] = executionJSON(v.Execution)
	}
	return out
}

func (h *Handlers) registerAccountKey(w http.ResponseWriter, r *http.Request) {
	walletID, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	accountID, ok := pathID(w, r, "accountId")
	if !ok {
		return
	}
	var body struct {
		PublicKey string `json:"publicKey"`
		Signature string `json:"signature"`
	}
	if !decode(w, r, &body) {
		return
	}
	k, err := h.svc.RegisterAccountKey(r.Context(), auth.FromContext(r.Context()), walletID, accountID, body.PublicKey, body.Signature)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, accountKeyJSON(k, false))
}

func (h *Handlers) getAccountKey(w http.ResponseWriter, r *http.Request) {
	walletID, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	accountID, ok := pathID(w, r, "accountId")
	if !ok {
		return
	}
	v, err := h.svc.GetWallet(r.Context(), auth.FromContext(r.Context()), walletID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	k, ok := v.AccountKeys[accountID]
	if !ok {
		httpx.NotFound(w, r, "NOT_FOUND", "no account key registered for the active wallet key")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, accountKeyJSON(k, true))
}

func (h *Handlers) startSigning(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "proposalId")
	if !ok {
		return
	}
	v, err := h.svc.StartSigning(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, signingViewJSON(v, false))
}

func (h *Handlers) getSigning(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "sessionId")
	if !ok {
		return
	}
	v, err := h.svc.GetSigning(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, signingViewJSON(v, r.URL.Query().Get("payloads") == "all"))
}

func (h *Handlers) submitRound(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "sessionId")
	if !ok {
		return
	}
	round, err := strconv.Atoi(chi.URLParam(r, "round"))
	if err != nil || round < 1 || round > 3 {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	var body struct {
		Payload        string `json:"payload"`
		TranscriptHash string `json:"transcriptHash"`
		Signature      string `json:"signature"`
	}
	if !decode(w, r, &body) {
		return
	}
	v, err := h.svc.SubmitRound(r.Context(), auth.FromContext(r.Context()), id, round, body.Payload, body.TranscriptHash, body.Signature)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, signingViewJSON(v, false))
}

func (h *Handlers) abortSigning(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "sessionId")
	if !ok {
		return
	}
	var body struct {
		Reason    string `json:"reason"`
		Signature string `json:"signature"`
	}
	if !decode(w, r, &body) {
		return
	}
	v, err := h.svc.AbortSigning(r.Context(), auth.FromContext(r.Context()), id, body.Reason, body.Signature)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, signingViewJSON(v, false))
}
