package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/security"
)

type ctxKeyPrincipal struct{}

func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, ctxKeyPrincipal{}, p)
}

// FromContext returns the authenticated principal, or nil if the request
// was not authenticated (only possible on routes that don't use Middleware).
func FromContext(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxKeyPrincipal{}).(*Principal)
	return p
}

// CookieNames abstracts the __Host- prefixed vs plain cookie names so
// middleware does not need the full config package.
type CookieNames struct {
	Access  string
	Refresh string
}

// Middleware builds the authentication + CSRF middleware described in spec
// §9.3: it accepts either a Bearer access token (mobile) or the access
// cookie (web); for unsafe methods authenticated by cookie, it also
// requires a matching X-CSRF-Token header.
func Middleware(svc *Service, cookies CookieNames, csrfKey []byte) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var rawToken string
			viaCookie := false

			if authz := r.Header.Get("Authorization"); strings.HasPrefix(authz, "Bearer ") {
				rawToken = strings.TrimPrefix(authz, "Bearer ")
			} else if c, err := r.Cookie(cookies.Access); err == nil {
				rawToken = c.Value
				viaCookie = true
			}

			if rawToken == "" {
				httpx.Unauthorized(w, r, "UNAUTHENTICATED", "Missing credentials")
				return
			}

			principal, err := svc.VerifyPrincipal(r.Context(), rawToken)
			if err != nil {
				httpx.Unauthorized(w, r, "UNAUTHENTICATED", "Invalid or expired session")
				return
			}

			if viaCookie && isUnsafeMethod(r.Method) {
				supplied := r.Header.Get("X-CSRF-Token")
				if supplied == "" || !security.VerifyCSRFToken(csrfKey, principal.SessionID.String(), supplied) {
					httpx.Forbidden(w, r, "CSRF_MISMATCH", "Missing or invalid CSRF token")
					return
				}
			}

			ctx := WithPrincipal(r.Context(), principal)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RateLimitBySession applies limiter keyed by the authenticated session id
// (spec §25.2: 20 req/s burst 40 per session for the RPC proxy). It must be
// mounted after Middleware so a Principal is already in context.
func RateLimitBySession(limiter security.Limiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := FromContext(r.Context())
			if p != nil && limiter != nil && !limiter.Allow(p.SessionID.String()) {
				httpx.TooManyRequests(w, r, "RATE_LIMITED", "Too many requests")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isUnsafeMethod(m string) bool {
	switch m {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}
