package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/audit"
	"github.com/qdwallet/wallet-api/internal/security"
	"github.com/qdwallet/wallet-api/internal/store"
)

const RefreshTokenTTL = 30 * 24 * time.Hour

var (
	ErrDeviceExists   = errors.New("auth: device already registered")
	ErrUnknownDevice  = errors.New("auth: unknown device")
	ErrDeviceRevoked  = errors.New("auth: device revoked")
	ErrInvalidRefresh = errors.New("auth: invalid refresh token")
	ErrRefreshReused  = errors.New("auth: refresh token reuse detected")
)

type Service struct {
	store      store.Store
	challenges *ChallengeService
	tokens     *TokenIssuer
}

func NewService(st store.Store, km security.KeyManager) *Service {
	return &Service{
		store:      st,
		challenges: NewChallengeService(st.Challenges()),
		tokens:     NewTokenIssuer(km),
	}
}

func (s *Service) Challenges() *ChallengeService { return s.challenges }

// Principal identifies the authenticated caller.
type Principal struct {
	UserID    uuid.UUID
	DeviceID  uuid.UUID
	SessionID uuid.UUID
}

// SessionResult is what handlers turn into the Session response body / cookies.
type SessionResult struct {
	UserID          uuid.UUID
	DeviceID        uuid.UUID
	SessionID       uuid.UUID
	AccessToken     string
	AccessExpiresAt time.Time
	RefreshToken    string // raw token, mobile only in the response, always needed for cookies on web
}

func randomToken32() ([]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

func hashToken(raw []byte) []byte {
	sum := sha256.Sum256(raw)
	return sum[:]
}

func b64url(b []byte) string {
	return rawURLEncode(b)
}

// createSession creates a brand-new session + first refresh token
// generation for (userID, deviceID) and mints an access token.
func (s *Service) createSession(ctx context.Context, userID, deviceID uuid.UUID, ipHash string) (*SessionResult, error) {
	sessionID, err := uuid.NewV7()
	if err != nil {
		sessionID = uuid.New()
	}
	now := time.Now().UTC()
	sess := &store.Session{
		ID:        sessionID,
		DeviceID:  deviceID,
		UserID:    userID,
		ExpiresAt: now.Add(RefreshTokenTTL),
		IPHash:    ipHash,
		CreatedAt: now,
	}
	if err := s.store.Sessions().Create(ctx, sess); err != nil {
		return nil, fmt.Errorf("auth: create session: %w", err)
	}
	rawRefresh, err := randomToken32()
	if err != nil {
		return nil, err
	}
	rt := &store.RefreshToken{
		Hash:      hashToken(rawRefresh),
		SessionID: sessionID,
		CreatedAt: now,
	}
	if err := s.store.RefreshTokens().Create(ctx, rt); err != nil {
		return nil, fmt.Errorf("auth: create refresh token: %w", err)
	}
	accessToken, expiresAt, err := s.tokens.IssueAccessToken(ctx, userID, deviceID, sessionID)
	if err != nil {
		return nil, err
	}
	return &SessionResult{
		UserID:          userID,
		DeviceID:        deviceID,
		SessionID:       sessionID,
		AccessToken:     accessToken,
		AccessExpiresAt: expiresAt,
		RefreshToken:    b64url(rawRefresh),
	}, nil
}

// Register creates a new user + device from a consumed challenge, or fails
// with ErrDeviceExists if the public key is already registered.
func (s *Service) Register(ctx context.Context, publicKeyDER []byte, platform store.Platform, label, ipHash string) (*SessionResult, error) {
	if _, err := s.store.Devices().GetByPublicKey(ctx, publicKeyDER); err == nil {
		return nil, ErrDeviceExists
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	userID, err := uuid.NewV7()
	if err != nil {
		userID = uuid.New()
	}
	now := time.Now().UTC()
	user := &store.User{ID: userID, Status: store.UserActive, CreatedAt: now}
	if err := s.store.Users().Create(ctx, user); err != nil {
		return nil, fmt.Errorf("auth: create user: %w", err)
	}

	deviceID, err := uuid.NewV7()
	if err != nil {
		deviceID = uuid.New()
	}
	device := &store.Device{
		ID:         deviceID,
		UserID:     userID,
		PublicKey:  publicKeyDER,
		Platform:   platform,
		Label:      label,
		LastSeenAt: now,
		CreatedAt:  now,
	}
	if err := s.store.Devices().Create(ctx, device); err != nil {
		return nil, fmt.Errorf("auth: create device: %w", err)
	}

	result, err := s.createSession(ctx, userID, deviceID, ipHash)
	if err != nil {
		return nil, err
	}

	_ = security.RecordEvent(ctx, s.store.SecurityEvents(), userID, &deviceID, security.EventNewDeviceRegistered, store.SeverityInfo, ipHash, map[string]any{"platform": string(platform)})
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", userID.String(), "register", "device", deviceID.String(), map[string]any{"platform": string(platform)})

	return result, nil
}

// Login authenticates a known, non-revoked device.
func (s *Service) Login(ctx context.Context, publicKeyDER []byte, ipHash string) (*SessionResult, error) {
	device, err := s.store.Devices().GetByPublicKey(ctx, publicKeyDER)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrUnknownDevice
		}
		return nil, err
	}
	if device.RevokedAt != nil {
		return nil, ErrDeviceRevoked
	}
	_ = s.store.Devices().TouchLastSeen(ctx, device.ID)

	result, err := s.createSession(ctx, device.UserID, device.ID, ipHash)
	if err != nil {
		return nil, err
	}
	_ = security.RecordEvent(ctx, s.store.SecurityEvents(), device.UserID, &device.ID, security.EventLogin, store.SeverityInfo, ipHash, nil)
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", device.UserID.String(), "login", "device", device.ID.String(), nil)
	return result, nil
}

// Refresh rotates a refresh token. The rotated<-false claim is a single
// atomic store operation (ClaimRotation); if it fails because the token was
// already rotated (replay), the whole session is revoked and a critical
// refresh_token_reuse security event is recorded. This closes a
// check-then-act race that existed when Get and MarkRotated were separate
// calls: two concurrent requests presenting the same valid token could
// previously both pass the "not yet rotated" check before either marked it
// rotated, both minting a new token generation from the same parent.
func (s *Service) Refresh(ctx context.Context, rawTokenB64 string) (*SessionResult, error) {
	raw, err := rawURLDecode(rawTokenB64)
	if err != nil {
		return nil, ErrInvalidRefresh
	}
	hash := hashToken(raw)

	sessionID, claimed, err := s.store.RefreshTokens().ClaimRotation(ctx, hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrInvalidRefresh
		}
		return nil, err
	}
	if !claimed {
		// Replay of an already-rotated token: revoke the whole session and
		// alert, regardless of whether we can look up its metadata.
		if sess, sessErr := s.store.Sessions().Get(ctx, sessionID); sessErr == nil {
			_ = s.store.Sessions().Revoke(ctx, sess.ID)
			_ = security.RecordEvent(ctx, s.store.SecurityEvents(), sess.UserID, &sess.DeviceID, security.EventRefreshTokenReuse, store.SeverityCritical, sess.IPHash, map[string]any{"sessionId": sess.ID.String()})
			_ = audit.Record(ctx, s.store.AuditLogs(), "system", "auth", "refresh_token_reuse", "session", sess.ID.String(), nil)
		}
		return nil, ErrRefreshReused
	}

	sess, err := s.store.Sessions().Get(ctx, sessionID)
	if err != nil {
		return nil, ErrInvalidRefresh
	}
	if sess.RevokedAt != nil {
		// The token generation itself was never rotated before now, but the
		// session was independently revoked (e.g. logout/device revoke) --
		// still suspicious enough to log, though the session stays revoked.
		_ = security.RecordEvent(ctx, s.store.SecurityEvents(), sess.UserID, &sess.DeviceID, security.EventRefreshTokenReuse, store.SeverityCritical, sess.IPHash, map[string]any{"sessionId": sess.ID.String()})
		_ = audit.Record(ctx, s.store.AuditLogs(), "system", "auth", "refresh_token_reuse", "session", sess.ID.String(), nil)
		return nil, ErrRefreshReused
	}
	if time.Now().After(sess.ExpiresAt) {
		return nil, ErrInvalidRefresh
	}

	device, err := s.store.Devices().GetByID(ctx, sess.DeviceID)
	if err != nil {
		return nil, ErrInvalidRefresh
	}
	if device.RevokedAt != nil {
		return nil, ErrDeviceRevoked
	}

	newRaw, err := randomToken32()
	if err != nil {
		return nil, err
	}
	newExpiresAt := time.Now().UTC().Add(RefreshTokenTTL)
	if err := s.store.RefreshTokens().Create(ctx, &store.RefreshToken{
		Hash:      hashToken(newRaw),
		SessionID: sess.ID,
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		return nil, err
	}
	if err := s.store.Sessions().ExtendExpiry(ctx, sess.ID, newExpiresAt); err != nil {
		return nil, err
	}

	accessToken, expiresAt, err := s.tokens.IssueAccessToken(ctx, sess.UserID, sess.DeviceID, sess.ID)
	if err != nil {
		return nil, err
	}
	return &SessionResult{
		UserID:          sess.UserID,
		DeviceID:        sess.DeviceID,
		SessionID:       sess.ID,
		AccessToken:     accessToken,
		AccessExpiresAt: expiresAt,
		RefreshToken:    b64url(newRaw),
	}, nil
}

// Logout revokes the given session.
func (s *Service) Logout(ctx context.Context, sessionID uuid.UUID, userID uuid.UUID) error {
	if err := s.store.Sessions().Revoke(ctx, sessionID); err != nil {
		return err
	}
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", userID.String(), "logout", "session", sessionID.String(), nil)
	return nil
}

// VerifyPrincipal checks an access token's claims against the session store
// to ensure the session/device has not since been revoked. This must be
// called on every authenticated request, not just at token-verification
// time, because revocation must take effect immediately (spec §22/§23).
func (s *Service) VerifyPrincipal(ctx context.Context, raw string) (*Principal, error) {
	claims, err := s.tokens.VerifyAccessToken(ctx, raw)
	if err != nil {
		return nil, err
	}
	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return nil, fmt.Errorf("auth: invalid sub claim")
	}
	deviceID, err := uuid.Parse(claims.DeviceID)
	if err != nil {
		return nil, fmt.Errorf("auth: invalid did claim")
	}
	sessionID, err := uuid.Parse(claims.SessionID)
	if err != nil {
		return nil, fmt.Errorf("auth: invalid sid claim")
	}
	sess, err := s.store.Sessions().Get(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("auth: session not found")
	}
	if sess.RevokedAt != nil {
		return nil, fmt.Errorf("auth: session revoked")
	}
	if sess.UserID != userID || sess.DeviceID != deviceID {
		return nil, fmt.Errorf("auth: token/session mismatch")
	}
	device, err := s.store.Devices().GetByID(ctx, deviceID)
	if err != nil {
		return nil, fmt.Errorf("auth: device not found")
	}
	if device.RevokedAt != nil {
		return nil, fmt.Errorf("auth: device revoked")
	}
	return &Principal{UserID: userID, DeviceID: deviceID, SessionID: sessionID}, nil
}

// RevokeDevice revokes a device and all of its sessions immediately.
func (s *Service) RevokeDevice(ctx context.Context, userID, deviceID uuid.UUID) error {
	if _, err := s.store.Devices().Get(ctx, userID, deviceID); err != nil {
		return err
	}
	if err := s.store.Devices().Revoke(ctx, userID, deviceID); err != nil {
		return err
	}
	if err := s.store.Sessions().RevokeByDevice(ctx, deviceID); err != nil {
		return err
	}
	_ = security.RecordEvent(ctx, s.store.SecurityEvents(), userID, &deviceID, security.EventDeviceRevoked, store.SeverityWarning, "", nil)
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", userID.String(), "device_revoke", "device", deviceID.String(), nil)
	return nil
}
