package auth_test

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
)

func challengeAndSign(t *testing.T, client *http.Client, base string, device *testDevice) (string, string) {
	t.Helper()
	resp, body := doJSON(t, client, http.MethodPost, base+"/v1/auth/challenge", map[string]any{
		"devicePublicKey": device.pub,
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("challenge failed: %d %v", resp.StatusCode, body)
	}
	challengeID, _ := body["challengeId"].(string)
	message, _ := body["message"].(string)
	if challengeID == "" || message == "" {
		t.Fatalf("bad challenge response: %v", body)
	}
	sig := device.sign(t, message)
	return challengeID, sig
}

func TestFullAuthFlow_RegisterMeRefreshLogout(t *testing.T) {
	env := newTestEnv(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	device := newTestDevice(t)

	// 1. register
	challengeID, sig := challengeAndSign(t, client, env.server.URL, device)
	resp, body := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": challengeID,
		"signature":   sig,
		"platform":    "web",
		"label":       "Test browser",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register failed: %d %v", resp.StatusCode, body)
	}
	csrfToken, _ := body["csrfToken"].(string)
	if csrfToken == "" {
		t.Fatalf("expected csrfToken in register response, got %v", body)
	}
	if _, ok := body["accessToken"]; ok {
		t.Fatalf("web response must not include accessToken, got %v", body)
	}

	// 2. GET /v1/me using the cookie
	resp, meBody := doJSON(t, client, http.MethodGet, env.server.URL+"/v1/me", nil, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me failed: %d %v", resp.StatusCode, meBody)
	}
	userID, _ := meBody["userId"].(string)
	if userID == "" {
		t.Fatalf("expected userId, got %v", meBody)
	}

	// 3. refresh rotation: refresh via cookie (no body needed)
	resp, refreshBody := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/refresh", map[string]any{}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("refresh failed: %d %v", resp.StatusCode, refreshBody)
	}

	// me should still work after refresh (new access cookie set)
	resp, meBody2 := doJSON(t, client, http.MethodGet, env.server.URL+"/v1/me", nil, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me after refresh failed: %d %v", resp.StatusCode, meBody2)
	}

	// 4. logout (CSRF required since unsafe method + cookie auth)
	newCsrf, _ := refreshBody["csrfToken"].(string)
	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/logout", map[string]any{}, map[string]string{"X-CSRF-Token": newCsrf})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout failed: %d", resp.StatusCode)
	}

	// after logout, /v1/me must fail
	resp, _ = doJSON(t, client, http.MethodGet, env.server.URL+"/v1/me", nil, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 after logout, got %d", resp.StatusCode)
	}
}

func TestRefreshTokenReuseRevokesFamily(t *testing.T) {
	env := newTestEnv(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	device := newTestDevice(t)

	challengeID, sig := challengeAndSign(t, client, env.server.URL, device)
	resp, regBody := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": challengeID, "signature": sig, "platform": "web",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register failed: %d %v", resp.StatusCode, regBody)
	}

	// Grab the original refresh cookie value before rotating.
	var originalRefresh *http.Cookie
	u, _ := client.Jar.(*cookiejar.Jar), env.server.URL
	_ = u
	for _, c := range client.Jar.Cookies(mustParseURL(t, env.server.URL)) {
		if c.Name == "qd_rt" {
			cc := *c
			originalRefresh = &cc
		}
	}
	if originalRefresh == nil {
		t.Fatal("expected refresh cookie to be set after register")
	}

	// First refresh: should succeed and rotate the token.
	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/refresh", map[string]any{}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first refresh failed: %d", resp.StatusCode)
	}

	// Replay the ORIGINAL (now rotated-out) refresh token: must be rejected
	// and must revoke the session/family.
	replayClient := &http.Client{}
	req, _ := http.NewRequest(http.MethodPost, env.server.URL+"/v1/auth/refresh", newJSONReader(t, map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-QD-Client", "web")
	req.Header.Set("Origin", testOrigin)
	req.AddCookie(originalRefresh)
	resp2, err := replayClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected replayed refresh token to be rejected, got %d", resp2.StatusCode)
	}

	// The legitimate rotated session must now ALSO be revoked (whole family
	// killed), so a subsequent legitimate refresh with the newest token must
	// also fail.
	resp3, _ := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/refresh", map[string]any{}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected family to be revoked after reuse, got %d", resp3.StatusCode)
	}

}

func TestRefreshDoesNotRequireCSRF(t *testing.T) {
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

	// Refresh with a valid Origin and NO X-CSRF-Token header must succeed,
	// and must return a fresh csrfToken.
	resp, body := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/refresh", map[string]any{}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected refresh without CSRF header to succeed given a valid Origin, got %d", resp.StatusCode)
	}
	if tok, _ := body["csrfToken"].(string); tok == "" {
		t.Fatalf("expected a fresh csrfToken in the refresh response, got %v", body)
	}

	// Refresh with a foreign Origin must be rejected, even with valid cookies.
	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/refresh", map[string]any{}, map[string]string{"X-QD-Client": "web", "Origin": "http://evil.example"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected refresh from a foreign Origin to be rejected, got %d", resp.StatusCode)
	}
}

func TestCSRFRequiredForUnsafeMethods(t *testing.T) {
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

	// Logout without X-CSRF-Token must fail with 403.
	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/logout", map[string]any{}, nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 CSRF mismatch, got %d", resp.StatusCode)
	}

	// Wrong CSRF token must also fail.
	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/logout", map[string]any{}, map[string]string{"X-CSRF-Token": "wrong-token"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for wrong CSRF token, got %d", resp.StatusCode)
	}
}

func TestChallengeIsSingleUse(t *testing.T) {
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

	// Replaying the same challenge+signature (e.g. against login) must fail.
	resp, body := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/login", map[string]any{
		"challengeId": challengeID, "signature": sig,
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected replayed challenge to be rejected, got %d %v", resp.StatusCode, body)
	}
}

func TestChallengeExpires(t *testing.T) {
	env := newTestEnv(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	device := newTestDevice(t)

	resp, body := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/challenge", map[string]any{
		"devicePublicKey": device.pub,
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("challenge failed: %d", resp.StatusCode)
	}
	challengeID, _ := body["challengeId"].(string)
	message, _ := body["message"].(string)
	sig := device.sign(t, message)

	// Force-expire the challenge directly via the store to avoid a real sleep.
	expireChallenge(t, env, challengeID)

	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": challengeID, "signature": sig, "platform": "web",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected expired challenge to be rejected, got %d", resp.StatusCode)
	}
}

func TestInvalidSignatureRejected(t *testing.T) {
	env := newTestEnv(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	device := newTestDevice(t)

	resp, body := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/challenge", map[string]any{
		"devicePublicKey": device.pub,
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("challenge failed: %d", resp.StatusCode)
	}
	challengeID, _ := body["challengeId"].(string)

	other := newTestDevice(t)
	badSig := other.sign(t, body["message"].(string))

	resp, _ = doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": challengeID, "signature": badSig, "platform": "web",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected invalid signature to be rejected, got %d", resp.StatusCode)
	}
}

func TestWrongOriginRejected(t *testing.T) {
	env := newTestEnv(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	device := newTestDevice(t)

	resp, _ := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/challenge", map[string]any{
		"devicePublicKey": device.pub,
	}, map[string]string{"X-QD-Client": "web", "Origin": "http://evil.example"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for disallowed origin, got %d", resp.StatusCode)
	}
}

func TestDeviceExistsConflictOnDoubleRegister(t *testing.T) {
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

	challengeID2, sig2 := challengeAndSign(t, client, env.server.URL, device)
	resp, body := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": challengeID2, "signature": sig2, "platform": "web",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 DEVICE_EXISTS, got %d %v", resp.StatusCode, body)
	}
}

func TestDeviceRevocationInvalidatesSession(t *testing.T) {
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

	resp, meBody := doJSON(t, client, http.MethodGet, env.server.URL+"/v1/me", nil, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me failed: %d", resp.StatusCode)
	}
	deviceID, _ := meBody["deviceId"].(string)
	userID, _ := meBody["userId"].(string)

	uid := mustParseUUID(t, userID)
	did := mustParseUUID(t, deviceID)
	if err := env.svc.RevokeDevice(newCtx(), uid, did); err != nil {
		t.Fatal(err)
	}

	resp, _ = doJSON(t, client, http.MethodGet, env.server.URL+"/v1/me", nil, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 after device revocation, got %d", resp.StatusCode)
	}
}

func TestIDORDevicesNotVisibleAcrossUsers(t *testing.T) {
	env := newTestEnv(t)

	jarA, _ := cookiejar.New(nil)
	clientA := &http.Client{Jar: jarA}
	deviceA := newTestDevice(t)
	cIDA, sigA := challengeAndSign(t, clientA, env.server.URL, deviceA)
	respA, _ := doJSON(t, clientA, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": cIDA, "signature": sigA, "platform": "web",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if respA.StatusCode != http.StatusCreated {
		t.Fatalf("register A failed: %d", respA.StatusCode)
	}

	jarB, _ := cookiejar.New(nil)
	clientB := &http.Client{Jar: jarB}
	deviceB := newTestDevice(t)
	cIDB, sigB := challengeAndSign(t, clientB, env.server.URL, deviceB)
	respB, _ := doJSON(t, clientB, http.MethodPost, env.server.URL+"/v1/auth/register", map[string]any{
		"challengeId": cIDB, "signature": sigB, "platform": "web",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if respB.StatusCode != http.StatusCreated {
		t.Fatalf("register B failed: %d", respB.StatusCode)
	}
	_, meB := doJSON(t, clientB, http.MethodGet, env.server.URL+"/v1/me", nil, nil)
	deviceBID, _ := meB["deviceId"].(string)

	// User A tries to rename/revoke user B's device: must be 404, not 403,
	// and must not succeed.
	respRename, _ := doJSON(t, clientA, http.MethodPatch, env.server.URL+"/v1/devices/"+deviceBID, map[string]any{"label": "hijacked"}, map[string]string{"X-CSRF-Token": mustCSRF(t, clientA, env)})
	if respRename.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for cross-user device rename, got %d", respRename.StatusCode)
	}
}

func mustCSRF(t *testing.T, client *http.Client, env *testEnv) string {
	t.Helper()
	// A fresh refresh call returns a new csrfToken tied to this client's session.
	resp, body := doJSON(t, client, http.MethodPost, env.server.URL+"/v1/auth/refresh", map[string]any{}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("refresh for csrf failed: %d", resp.StatusCode)
	}
	tok, _ := body["csrfToken"].(string)
	return tok
}

func mustParseUUID(t *testing.T, s string) uuid.UUID {
	t.Helper()
	parsed, err := uuid.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustParseUUIDFromMe(t *testing.T, client *http.Client, base string) uuid.UUID {
	t.Helper()
	_, body := doJSON(t, client, http.MethodGet, base+"/v1/me", nil, nil)
	id, _ := body["userId"].(string)
	return mustParseUUID(t, id)
}

func expireChallenge(t *testing.T, env *testEnv, challengeID string) {
	t.Helper()
	id := mustParseUUID(t, challengeID)
	c, err := env.st.Challenges().Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	c.ExpiresAt = c.ExpiresAt.Add(-2 * time.Hour)
	// Re-create with the past expiry (memory store Create overwrites by ID).
	if err := env.st.Challenges().Create(context.Background(), c); err != nil {
		t.Fatal(err)
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func newCtx() context.Context { return context.Background() }
