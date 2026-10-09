// Package httpx contains shared HTTP plumbing: RFC 9457 problem+json
// responses, request-id/security-header/body-limit middleware, and helpers
// used across handler packages.
package httpx

import (
	"encoding/json"
	"net/http"
)

// Problem is the RFC 9457 application/problem+json error body used by every
// handler in wallet-api.
type Problem struct {
	Type      string `json:"type,omitempty"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Code      string `json:"code"`
	Detail    string `json:"detail,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

func (p *Problem) Error() string { return p.Title }

// WriteProblem writes a Problem as application/problem+json with the given
// status code, filling in the request id from the response's X-Request-Id
// header if present.
func WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, title, detail string) {
	p := &Problem{
		Title:     title,
		Status:    status,
		Code:      code,
		Detail:    detail,
		RequestID: w.Header().Get("X-Request-Id"),
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(p)
}

// Common error helpers.

func BadRequest(w http.ResponseWriter, r *http.Request, code, detail string) {
	WriteProblem(w, r, http.StatusBadRequest, code, "Bad request", detail)
}

func Unauthorized(w http.ResponseWriter, r *http.Request, code, detail string) {
	WriteProblem(w, r, http.StatusUnauthorized, code, "Unauthorized", detail)
}

func Forbidden(w http.ResponseWriter, r *http.Request, code, detail string) {
	WriteProblem(w, r, http.StatusForbidden, code, "Forbidden", detail)
}

func NotFound(w http.ResponseWriter, r *http.Request, code, detail string) {
	WriteProblem(w, r, http.StatusNotFound, code, "Not found", detail)
}

func Conflict(w http.ResponseWriter, r *http.Request, code, detail string) {
	WriteProblem(w, r, http.StatusConflict, code, "Conflict", detail)
}

func TooManyRequests(w http.ResponseWriter, r *http.Request, code, detail string) {
	WriteProblem(w, r, http.StatusTooManyRequests, code, "Too many requests", detail)
}

func InternalError(w http.ResponseWriter, r *http.Request, code, detail string) {
	WriteProblem(w, r, http.StatusInternalServerError, code, "Internal server error", detail)
}

// WriteJSON writes v as application/json with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
