package auth

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/security"
	"github.com/qdwallet/wallet-api/internal/store"
)

type Handlers struct {
	svc            *Service
	allowedOrigins []string
	cookieSecure   bool
	cookies        CookieNames
	csrfKey        []byte
	ipHashKey      []byte
	trustedProxies []*net.IPNet
}

func NewHandlers(svc *Service, allowedOrigins []string, cookieSecure bool, cookies CookieNames, csrfKey, ipHashKey []byte, trustedProxies []*net.IPNet) *Handlers {
	return &Handlers{svc: svc, allowedOrigins: allowedOrigins, cookieSecure: cookieSecure, cookies: cookies, csrfKey: csrfKey, ipHashKey: ipHashKey, trustedProxies: trustedProxies}
}

func (h *Handlers) ipHash(r *http.Request) string {
	if len(h.ipHashKey) == 0 {
		return ""
	}
	ip := security.ClientIP(r, h.trustedProxies)
	return security.HashIP(h.ipHashKey, ip)
}

// resolveOrigin returns the origin string that must appear in the signed
// challenge message: the request's Origin header for web clients (checked
// against the allow-list), or the fixed mobile origin token.
func (h *Handlers) resolveOrigin(r *http.Request) (string, string, bool) {
	clientType := r.Header.Get("X-QD-Client")
	switch clientType {
	case "mobile":
		return MobileOrigin, clientType, true
	case "web":
		origin := r.Header.Get("Origin")
		if origin == "" || !httpx.IsAllowedOrigin(h.allowedOrigins, origin) {
			return "", clientType, false
		}
		return origin, clientType, true
	default:
		return "", clientType, false
	}
}

type challengeRequest struct {
	DevicePublicKey string `json:"devicePublicKey"`
}

func (h *Handlers) CreateChallenge(w http.ResponseWriter, r *http.Request) {
	var req challengeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DevicePublicKey == "" {
		httpx.BadRequest(w, r, "INVALID_BODY", "devicePublicKey is required")
		return
	}
	pub, err := ParseSPKIPublicKeyB64URL(req.DevicePublicKey)
	if err != nil {
		httpx.BadRequest(w, r, "INVALID_PUBLIC_KEY", err.Error())
		return
	}
	der, err := SPKIDER(pub)
	if err != nil {
		httpx.BadRequest(w, r, "INVALID_PUBLIC_KEY", err.Error())
		return
	}
	origin, clientType, ok := h.resolveOrigin(r)
	if !ok {
		httpx.BadRequest(w, r, "INVALID_ORIGIN", "Origin is missing, not allowed, or X-QD-Client is invalid")
		return
	}
	c, err := h.svc.Challenges().Create(r.Context(), der, origin, clientType)
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"challengeId": c.ID.String(),
		"nonce":       c.Nonce,
		"message":     c.Message,
		"expiresAt":   c.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

type registerRequest struct {
	ChallengeID string `json:"challengeId"`
	Signature   string `json:"signature"`
	Platform    string `json:"platform"`
	Label       string `json:"label"`
}

func (h *Handlers) Register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ChallengeID == "" || req.Signature == "" || req.Platform == "" {
		httpx.BadRequest(w, r, "INVALID_BODY", "challengeId, signature and platform are required")
		return
	}
	challengeID, err := uuid.Parse(req.ChallengeID)
	if err != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "invalid challengeId")
		return
	}
	origin, clientType, ok := h.resolveOrigin(r)
	if !ok {
		httpx.BadRequest(w, r, "INVALID_ORIGIN", "Origin is missing, not allowed, or X-QD-Client is invalid")
		return
	}

	challenge, err := h.svc.store.Challenges().Get(r.Context(), challengeID)
	if err != nil {
		httpx.Unauthorized(w, r, "INVALID_CHALLENGE", "Unknown challenge")
		return
	}
	// The challenge must be redeemed under the exact same origin/client type
	// it was issued for. The signed message already embeds the origin, so
	// this mostly guards against a challenge issued for one transport
	// (e.g. web) being redeemed as another (e.g. mobile), which would change
	// how the resulting session/tokens are delivered.
	if challenge.Origin != origin || challenge.ClientType != clientType {
		httpx.Unauthorized(w, r, "INVALID_CHALLENGE", "Challenge origin/client type mismatch")
		return
	}
	pub, err := ParseSPKIPublicKeyB64URL(encodeB64(challenge.PublicKey))
	if err != nil {
		httpx.Unauthorized(w, r, "INVALID_CHALLENGE", "corrupt challenge")
		return
	}
	if err := VerifyP1363SignatureB64URL(pub, []byte(challenge.Message), req.Signature); err != nil {
		httpx.Unauthorized(w, r, "INVALID_SIGNATURE", "Signature verification failed")
		return
	}
	consumed, err := h.svc.Challenges().Consume(r.Context(), challengeID, challenge.PublicKey)
	if err != nil {
		mapChallengeError(w, r, err)
		return
	}

	platform := store.Platform(req.Platform)
	result, err := h.svc.Register(r.Context(), consumed.PublicKey, platform, req.Label, h.ipHash(r))
	if err != nil {
		if errors.Is(err, ErrDeviceExists) {
			httpx.Conflict(w, r, "DEVICE_EXISTS", "This device key is already registered")
			return
		}
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	h.writeSession(w, r, http.StatusCreated, result)
}

type loginRequest struct {
	ChallengeID string `json:"challengeId"`
	Signature   string `json:"signature"`
}

func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ChallengeID == "" || req.Signature == "" {
		httpx.BadRequest(w, r, "INVALID_BODY", "challengeId and signature are required")
		return
	}
	challengeID, err := uuid.Parse(req.ChallengeID)
	if err != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "invalid challengeId")
		return
	}
	origin, clientType, ok := h.resolveOrigin(r)
	if !ok {
		httpx.BadRequest(w, r, "INVALID_ORIGIN", "Origin is missing, not allowed, or X-QD-Client is invalid")
		return
	}

	challenge, err := h.svc.store.Challenges().Get(r.Context(), challengeID)
	if err != nil {
		httpx.Unauthorized(w, r, "INVALID_CHALLENGE", "Unknown challenge")
		return
	}
	if challenge.Origin != origin || challenge.ClientType != clientType {
		httpx.Unauthorized(w, r, "INVALID_CHALLENGE", "Challenge origin/client type mismatch")
		return
	}
	pub, err := ParseSPKIPublicKeyB64URL(encodeB64(challenge.PublicKey))
	if err != nil {
		httpx.Unauthorized(w, r, "INVALID_CHALLENGE", "corrupt challenge")
		return
	}
	if err := VerifyP1363SignatureB64URL(pub, []byte(challenge.Message), req.Signature); err != nil {
		httpx.Unauthorized(w, r, "INVALID_SIGNATURE", "Signature verification failed")
		return
	}
	consumed, err := h.svc.Challenges().Consume(r.Context(), challengeID, challenge.PublicKey)
	if err != nil {
		mapChallengeError(w, r, err)
		return
	}

	result, err := h.svc.Login(r.Context(), consumed.PublicKey, h.ipHash(r))
	if err != nil {
		httpx.Unauthorized(w, r, "LOGIN_FAILED", "Unknown or revoked device")
		return
	}
	h.writeSession(w, r, http.StatusOK, result)
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

// Refresh does not require a CSRF token (the web client recovers its
// in-memory csrfToken across page reloads by calling this endpoint), so it
// is deliberately mounted outside the CSRF-enforcing middleware group.
// Instead, cookie-bearing (web) requests are held to the same strict Origin
// allow-list check as challenge/register/login: SameSite=Strict cookies
// plus an enforced Origin header are the CSRF defence for this route.
func (h *Handlers) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	_ = json.NewDecoder(r.Body).Decode(&req)

	raw := req.RefreshToken
	usingCookie := raw == ""
	if usingCookie {
		if c, err := r.Cookie(h.cookies.Refresh); err == nil {
			raw = c.Value
		}
	}
	if usingCookie {
		// A cookie-borne refresh token must only ever be accepted from a web
		// client with an allow-listed Origin. Do NOT reuse resolveOrigin
		// here: its "mobile" branch always succeeds without checking Origin
		// at all, which would let a request that also happens to carry a
		// (possibly cross-site-leaked) refresh cookie bypass the Origin
		// check entirely just by sending X-QD-Client: mobile.
		clientType := r.Header.Get("X-QD-Client")
		origin := r.Header.Get("Origin")
		if clientType != "web" || origin == "" || !httpx.IsAllowedOrigin(h.allowedOrigins, origin) {
			httpx.BadRequest(w, r, "INVALID_ORIGIN", "Cookie-based refresh requires X-QD-Client: web and an allowed Origin")
			return
		}
	}
	if raw == "" {
		httpx.Unauthorized(w, r, "INVALID_REFRESH", "Missing refresh token")
		return
	}
	result, err := h.svc.Refresh(r.Context(), raw)
	if err != nil {
		h.clearSessionCookies(w)
		httpx.Unauthorized(w, r, "INVALID_REFRESH", "Refresh token is invalid, expired, or reused")
		return
	}
	h.writeSession(w, r, http.StatusOK, result)
}

func (h *Handlers) Logout(w http.ResponseWriter, r *http.Request) {
	p := FromContext(r.Context())
	if p == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	_ = h.svc.Logout(r.Context(), p.SessionID, p.UserID)
	h.clearSessionCookies(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) Me(w http.ResponseWriter, r *http.Request) {
	p := FromContext(r.Context())
	if p == nil {
		httpx.Unauthorized(w, r, "UNAUTHENTICATED", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"userId":   p.UserID.String(),
		"deviceId": p.DeviceID.String(),
	})
}

func (h *Handlers) ListDevices(w http.ResponseWriter, r *http.Request) {
	p := FromContext(r.Context())
	devices, err := h.svc.store.Devices().ListByUser(r.Context(), p.UserID)
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	out := make([]map[string]any, 0, len(devices))
	for _, d := range devices {
		out = append(out, deviceToJSON(d, d.ID == p.DeviceID))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"devices": out})
}

type renameDeviceRequest struct {
	Label string `json:"label"`
}

func (h *Handlers) RenameDevice(w http.ResponseWriter, r *http.Request) {
	p := FromContext(r.Context())
	deviceID, err := uuid.Parse(chi.URLParam(r, "deviceId"))
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	var req renameDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Label == "" {
		httpx.BadRequest(w, r, "INVALID_BODY", "label is required")
		return
	}
	if err := h.svc.store.Devices().UpdateLabel(r.Context(), p.UserID, deviceID, req.Label); err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	d, err := h.svc.store.Devices().Get(r.Context(), p.UserID, deviceID)
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, deviceToJSON(d, d.ID == p.DeviceID))
}

func (h *Handlers) RevokeDevice(w http.ResponseWriter, r *http.Request) {
	p := FromContext(r.Context())
	deviceID, err := uuid.Parse(chi.URLParam(r, "deviceId"))
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	if err := h.svc.RevokeDevice(r.Context(), p.UserID, deviceID); err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func deviceToJSON(d *store.Device, current bool) map[string]any {
	m := map[string]any{
		"id":         d.ID.String(),
		"platform":   string(d.Platform),
		"label":      d.Label,
		"createdAt":  d.CreatedAt.UTC().Format(time.RFC3339),
		"lastSeenAt": d.LastSeenAt.UTC().Format(time.RFC3339),
		"current":    current,
	}
	if d.RevokedAt != nil {
		m["revokedAt"] = d.RevokedAt.UTC().Format(time.RFC3339)
	}
	return m
}

func mapChallengeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrChallengeNotFound):
		httpx.Unauthorized(w, r, "INVALID_CHALLENGE", "Unknown challenge")
	case errors.Is(err, ErrChallengeExpired):
		httpx.Unauthorized(w, r, "CHALLENGE_EXPIRED", "Challenge expired")
	case errors.Is(err, ErrChallengeUsed):
		httpx.Unauthorized(w, r, "CHALLENGE_USED", "Challenge already used")
	case errors.Is(err, ErrChallengeKeyMismatch):
		httpx.Unauthorized(w, r, "INVALID_CHALLENGE", "Challenge/key mismatch")
	default:
		httpx.InternalError(w, r, "INTERNAL", "")
	}
}

// writeSession sets the web cookies (if applicable) and writes the Session
// JSON body per the transport rules in openapi.yaml.
func (h *Handlers) writeSession(w http.ResponseWriter, r *http.Request, status int, res *SessionResult) {
	clientType := r.Header.Get("X-QD-Client")
	body := map[string]any{
		"userId":          res.UserID.String(),
		"deviceId":        res.DeviceID.String(),
		"accessExpiresAt": res.AccessExpiresAt.UTC().Format(time.RFC3339),
	}
	if clientType == "mobile" {
		body["accessToken"] = res.AccessToken
		body["refreshToken"] = res.RefreshToken
	} else {
		h.setSessionCookies(w, res)
		body["csrfToken"] = security.CSRFToken(h.csrfKey, res.SessionID.String())
	}
	httpx.WriteJSON(w, status, body)
}

func (h *Handlers) setSessionCookies(w http.ResponseWriter, res *SessionResult) {
	http.SetCookie(w, &http.Cookie{
		Name:     h.cookies.Access,
		Value:    res.AccessToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(AccessTokenTTL.Seconds()),
	})
	http.SetCookie(w, &http.Cookie{
		Name:     h.cookies.Refresh,
		Value:    res.RefreshToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(RefreshTokenTTL.Seconds()),
	})
}

func (h *Handlers) clearSessionCookies(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: h.cookies.Access, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: h.cookieSecure, SameSite: http.SameSiteStrictMode})
	http.SetCookie(w, &http.Cookie{Name: h.cookies.Refresh, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: h.cookieSecure, SameSite: http.SameSiteStrictMode})
}

func encodeB64(b []byte) string { return rawURLEncode(b) }
