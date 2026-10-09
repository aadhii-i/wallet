package auth_test

import (
	"net/http"
	"net/http/cookiejar"
	"testing"
)

// TestCookieRefreshRejectsMobileClientType closes a bypass where a request
// carrying the refresh cookie could skip the Origin allow-list check by
// simply sending X-QD-Client: mobile (whose branch never checks Origin at
// all, since genuine mobile clients never use cookies).
func TestCookieRefreshRejectsMobileClientType(t *testing.T) {
	env := newTestEnv(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	device := newTestDevice(t)

	challengeID, sig := challengeAndSign(t, client, env.server.URL, device)
	resp, _ := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": challengeID, "signature": sig, "platform": "web",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register failed: %d", resp.StatusCode)
	}

	// The refresh cookie is now set on the jar. Present it while claiming to
	// be a mobile client (no body refreshToken, so the handler falls back to
	// the cookie): this must be rejected, not silently accepted.
	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/refresh", map[string]any{}, map[string]string{"X-QD-Client": "mobile"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected cookie-based refresh with X-QD-Client: mobile to be rejected, got %d", resp.StatusCode)
	}

	// Legitimate web refresh must still work.
	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/refresh", map[string]any{}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected legitimate web refresh to succeed, got %d", resp.StatusCode)
	}
}

// TestChallengeRedeemedWithDifferentClientTypeIsRejected asserts a challenge
// issued for one X-QD-Client/Origin combination cannot be redeemed under a
// different one, even with a technically valid signature over the (already
// origin-bound) message.
func TestChallengeRedeemedWithDifferentClientTypeIsRejected(t *testing.T) {
	env := newTestEnv(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	device := newTestDevice(t)

	// Issue the challenge as "web".
	resp, body := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/challenge", map[string]any{
		"devicePublicKey": device.pub,
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("challenge failed: %d", resp.StatusCode)
	}
	challengeID, _ := body["challengeId"].(string)
	message, _ := body["message"].(string)
	sig := device.sign(t, message)

	// Attempt to redeem it as "mobile".
	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": challengeID, "signature": sig, "platform": "ios",
	}, map[string]string{"X-QD-Client": "mobile"})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected redeeming a web-issued challenge as mobile to be rejected, got %d", resp.StatusCode)
	}
}
