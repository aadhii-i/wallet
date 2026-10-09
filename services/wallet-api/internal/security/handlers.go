package security

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

// PrincipalFunc extracts the authenticated (userID, deviceID) from a
// request. It is injected from main() (bound to auth.FromContext) rather
// than imported directly, since internal/auth already imports
// internal/security for the KeyManager and importing back would cycle.
type PrincipalFunc func(r *http.Request) (userID, deviceID uuid.UUID, ok bool)

type Handlers struct {
	events    store.SecurityEvents
	principal PrincipalFunc
}

func NewHandlers(events store.SecurityEvents, principal PrincipalFunc) *Handlers {
	return &Handlers{events: events, principal: principal}
}

func eventJSON(e *store.SecurityEvent) map[string]any {
	m := map[string]any{
		"id":        e.ID.String(),
		"type":      e.Type,
		"severity":  string(e.Severity),
		"createdAt": e.CreatedAt.UTC().Format(time.RFC3339),
	}
	if e.DeviceID != nil {
		m["deviceId"] = e.DeviceID.String()
	}
	if e.Metadata != nil {
		m["metadata"] = e.Metadata
	}
	return m
}

func (h *Handlers) ListEvents(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := h.principal(r)
	if !ok {
		httpx.Unauthorized(w, r, "UNAUTHENTICATED", "")
		return
	}
	events, err := h.events.ListByUser(r.Context(), userID, 200)
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	out := make([]map[string]any, 0, len(events))
	for _, e := range events {
		out = append(out, eventJSON(e))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"events": out})
}

type clientEventRequest struct {
	Type string `json:"type"`
}

// ReportClientEvent accepts only allowlisted event types with no free text
// (spec: no free text is ever accepted from the client).
func (h *Handlers) ReportClientEvent(w http.ResponseWriter, r *http.Request) {
	userID, deviceID, ok := h.principal(r)
	if !ok {
		httpx.Unauthorized(w, r, "UNAUTHENTICATED", "")
		return
	}
	var req clientEventRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !IsAllowedClientEventType(req.Type) {
		httpx.BadRequest(w, r, "INVALID_EVENT_TYPE", "type must be one of the allowlisted client event types")
		return
	}
	_ = RecordEvent(r.Context(), h.events, userID, &deviceID, req.Type, SeverityForClientEvent(req.Type), "", nil)
	w.WriteHeader(http.StatusAccepted)
}

// SeverityForClientEvent maps a client-reported event type to a severity;
// unlock_failed_burst is a warning signal, everything else is informational.
func SeverityForClientEvent(t string) store.Severity {
	if t == "unlock_failed_burst" {
		return store.SeverityWarning
	}
	return store.SeverityInfo
}
