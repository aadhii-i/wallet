package nativecustody

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
)

type migrationAccess struct {
	SourceParticipantID string `json:"sourceParticipantId"`
	TargetParticipantID string `json:"targetParticipantId"`
}
type migrationView struct {
	Migration Migration       `json:"migration"`
	Access    migrationAccess `json:"access"`
}

func (s *Coordinator) view(r *http.Request, m Migration) (migrationView, error) {
	a, b, err := s.access(r.Context(), auth.FromContext(r.Context()), m)
	return migrationView{Migration: m, Access: migrationAccess{SourceParticipantID: a, TargetParticipantID: b}}, err
}
func migrationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrMigrationForbidden):
		httpx.NotFound(w, r, "NOT_FOUND", "")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r, "NOT_FOUND", "")
	case errors.Is(err, ErrMigrationConflict):
		httpx.Conflict(w, r, "MIGRATION_CHANGED", "Refresh the migration; its state changed or a group is already protected")
	default:
		var validation *validationError
		if errors.As(err, &validation) {
			httpx.Conflict(w, r, "NATIVE_MIGRATION_UNAVAILABLE", validation.message)
		} else {
			httpx.Conflict(w, r, "NATIVE_MIGRATION_UNAVAILABLE", "Migration service unavailable. Refresh and retry; preserve saved transaction evidence.")
		}
	}
}
func migrationBody(w http.ResponseWriter, r *http.Request, value any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 3500000))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "Invalid migration request")
		return false
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		httpx.BadRequest(w, r, "INVALID_BODY", "Expected one migration request")
		return false
	}
	return true
}
func validPath(r *http.Request, name string) bool {
	_, err := uuid.Parse(chi.URLParam(r, name))
	return err == nil
}
func (s *Coordinator) Routes(router chi.Router) {
	router.Get("/v1/shared-wallets/{walletId}/native-migrations", s.listHTTP)
	router.Get("/v1/shared-wallets/{walletId}/native-inventory", s.inventoryHTTP)
	router.Post("/v1/shared-wallets/{walletId}/native-migrations", s.createHTTP)
	router.Get("/v1/native-migrations/{migrationId}", s.getHTTP)
	router.Post("/v1/native-migrations/{migrationId}/confirm", s.approveHTTP)
	router.Post("/v1/native-migrations/{migrationId}/cancel", s.cancelHTTP)
	router.Post("/v1/native-migrations/{migrationId}/attempts", s.registerHTTP)
	router.Post("/v1/native-migrations/{migrationId}/check", s.checkHTTP)
	router.Post("/v1/native-migrations/{migrationId}/review", s.reviewHTTP)
	router.Get("/v1/native-migrations/{migrationId}/messages", s.messagesHTTP)
}
func (s *Coordinator) listHTTP(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "walletId")
	if !validPath(r, "walletId") {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	if _, _, err := s.member(r.Context(), auth.FromContext(r.Context()), id); err != nil {
		migrationError(w, r, err)
		return
	}
	items, err := s.repo.ForWallet(r.Context(), id)
	if err != nil {
		migrationError(w, r, invalid("Migration history unavailable"))
		return
	}
	result := []migrationView{}
	for _, m := range sortedMigrations(items) {
		view, err := s.view(r, m)
		if err != nil {
			migrationError(w, r, err)
			return
		}
		result = append(result, view)
	}
	httpx.WriteJSON(w, 200, map[string]any{"migrations": result})
}
func (s *Coordinator) createHTTP(w http.ResponseWriter, r *http.Request) {
	if !validPath(r, "walletId") {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	var input DraftInput
	if !migrationBody(w, r, &input) {
		return
	}
	if _, err := uuid.Parse(input.TargetWalletID); err != nil || len(input.Mappings) < 1 || len(input.Mappings) > 16 {
		httpx.BadRequest(w, r, "INVALID_BODY", "Choose a target group and account mappings")
		return
	}
	m, err := s.Create(r.Context(), auth.FromContext(r.Context()), chi.URLParam(r, "walletId"), input)
	if err != nil {
		migrationError(w, r, err)
		return
	}
	s.writeView(w, r, m)
}
func (s *Coordinator) getHTTP(w http.ResponseWriter, r *http.Request) {
	m, ok := s.loadHTTP(w, r)
	if ok {
		s.writeView(w, r, m)
	}
}
func (s *Coordinator) loadHTTP(w http.ResponseWriter, r *http.Request) (Migration, bool) {
	if !validPath(r, "migrationId") {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return Migration{}, false
	}
	m, err := s.repo.Get(r.Context(), chi.URLParam(r, "migrationId"))
	if err != nil {
		migrationError(w, r, err)
		return Migration{}, false
	}
	if _, err = s.view(r, m); err != nil {
		migrationError(w, r, err)
		return Migration{}, false
	}
	return m, true
}
func (s *Coordinator) writeView(w http.ResponseWriter, r *http.Request, m Migration) {
	view, err := s.view(r, m)
	if err != nil {
		migrationError(w, r, err)
		return
	}
	httpx.WriteJSON(w, 200, view)
}
func (s *Coordinator) approveHTTP(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.loadHTTP(w, r); !ok {
		return
	}
	var input struct {
		Side      string `json:"side"`
		Signature string `json:"signature"`
	}
	if !migrationBody(w, r, &input) {
		return
	}
	m, err := s.Approve(r.Context(), auth.FromContext(r.Context()), chi.URLParam(r, "migrationId"), input.Side, input.Signature)
	if err != nil {
		migrationError(w, r, err)
		return
	}
	s.writeView(w, r, m)
}
func (s *Coordinator) cancelHTTP(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.loadHTTP(w, r); !ok {
		return
	}
	m, err := s.Cancel(r.Context(), auth.FromContext(r.Context()), chi.URLParam(r, "migrationId"))
	if err != nil {
		migrationError(w, r, err)
		return
	}
	s.writeView(w, r, m)
}
func (s *Coordinator) registerHTTP(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.loadHTTP(w, r); !ok {
		return
	}
	var input RegisterInput
	if !migrationBody(w, r, &input) {
		return
	}
	m, err := s.Register(r.Context(), auth.FromContext(r.Context()), chi.URLParam(r, "migrationId"), input)
	if err != nil {
		migrationError(w, r, err)
		return
	}
	s.writeView(w, r, m)
}
func (s *Coordinator) checkHTTP(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.loadHTTP(w, r); !ok {
		return
	}
	m, err := s.Check(r.Context(), auth.FromContext(r.Context()), chi.URLParam(r, "migrationId"))
	if err != nil {
		migrationError(w, r, err)
		return
	}
	s.writeView(w, r, m)
}
func (s *Coordinator) messagesHTTP(w http.ResponseWriter, r *http.Request) {
	m, ok := s.loadHTTP(w, r)
	if !ok {
		return
	}
	intentID, side, session := r.URL.Query().Get("intentId"), r.URL.Query().Get("side"), r.URL.Query().Get("session")
	if side != "source" && side != "target" {
		httpx.BadRequest(w, r, "INVALID_BODY", "Choose a signing group")
		return
	}
	var intent *MigrationIntent
	for i := range m.Manifest.Intents {
		if m.Manifest.Intents[i].ID == intentID {
			intent = &m.Manifest.Intents[i]
			break
		}
	}
	if intent == nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	var attempt *MigrationAttempt
	for i := range m.Attempts {
		if m.Attempts[i].IntentID == intentID && m.Attempts[i].Session == session {
			attempt = &m.Attempts[i]
			break
		}
	}
	if attempt == nil || attempt.Archived {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	policy := intent.SourcePolicy
	if side == "target" {
		if intent.Chain != "hedera" {
			httpx.BadRequest(w, r, "INVALID_BODY", "Bitcoin has no destination signing phase")
			return
		}
		policy = intent.TargetPolicy
	}
	reader := s.bitcoinRooms
	if intent.Chain == "hedera" {
		reader = s.hederaRooms
	}
	// The registered immutable review is the proposal. Each group subsequently
	// publishes only its own device-authenticated approvals and public rounds.
	raw, err := reader.SessionMessages(r.Context(), policy.Context.WalletID, policy.Context.AccountID, policy.Context.KeygenID, policy.Context.MembershipVersion, session)
	if err != nil {
		migrationError(w, r, invalid("Native signing messages unavailable"))
		return
	}
	var messages []json.RawMessage
	if json.Unmarshal(raw, &messages) != nil {
		migrationError(w, r, invalid("Invalid native signing messages"))
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"messages": messages})
}

func (s *Coordinator) reviewHTTP(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.loadHTTP(w, r); !ok {
		return
	}
	var input struct {
		Reviews []IntentReview `json:"reviews"`
	}
	if !migrationBody(w, r, &input) {
		return
	}
	m, err := s.Review(r.Context(), auth.FromContext(r.Context()), chi.URLParam(r, "migrationId"), input.Reviews)
	if err != nil {
		migrationError(w, r, err)
		return
	}
	s.writeView(w, r, m)
}

func (s *Coordinator) inventoryHTTP(w http.ResponseWriter, r *http.Request) {
	wallet, _, err := s.member(r.Context(), auth.FromContext(r.Context()), chi.URLParam(r, "walletId"))
	if err != nil {
		migrationError(w, r, err)
		return
	}
	entries, _, err := s.inventory(r.Context(), wallet)
	if err != nil {
		migrationError(w, r, err)
		return
	}
	out := []map[string]any{}
	for _, e := range entries {
		out = append(out, map[string]any{"chain": e.Chain, "accountId": e.AccountID, "policyId": e.PolicyID, "policy": e.Policy, "hederaAccountId": e.HederaAccountID, "boundCount": e.BoundCount})
	}
	httpx.WriteJSON(w, 200, map[string]any{"accounts": out})
}
