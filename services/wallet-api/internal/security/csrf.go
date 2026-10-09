package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
)

// CSRFToken computes base64url(HMAC-SHA256(key, sessionID)), the token
// returned to web clients and compared against X-CSRF-Token on unsafe
// requests.
func CSRFToken(key []byte, sessionID string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(sessionID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// VerifyCSRFToken constant-time compares the supplied token against the
// expected token for sessionID.
func VerifyCSRFToken(key []byte, sessionID, supplied string) bool {
	expected := CSRFToken(key, sessionID)
	return subtle.ConstantTimeCompare([]byte(expected), []byte(supplied)) == 1
}

// HashIP computes HMAC-SHA256(key, ip), base64url-encoded, so raw IPs are
// never stored (spec §24, 30-day retention policy is enforced by a
// scheduled purge job, out of scope for this service binary).
func HashIP(key []byte, ip string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(ip))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
