package security

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Well-known security event type constants (spec §22/§26).
const (
	EventNewDeviceRegistered = "new_device_registered"
	EventLogin               = "login"
	EventDeviceRevoked       = "device_revoked"
	EventRefreshTokenReuse   = "refresh_token_reuse"
)

// ClientEventTypes is the allowlist for POST /v1/security/client-events; no
// free text is ever accepted from the client.
var ClientEventTypes = map[string]struct{}{
	"phrase_revealed":     {},
	"unlock_failed_burst": {},
	"wallet_created":      {},
	"wallet_imported":     {},
	"wallet_wiped":        {},
	"backup_verified":     {},
}

func IsAllowedClientEventType(t string) bool {
	_, ok := ClientEventTypes[t]
	return ok
}

// RecordEvent appends a server-originated security event.
func RecordEvent(ctx context.Context, events store.SecurityEvents, userID uuid.UUID, deviceID *uuid.UUID, eventType string, severity store.Severity, ipHash string, metadata map[string]any) error {
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	e := &store.SecurityEvent{
		ID:        id,
		UserID:    userID,
		DeviceID:  deviceID,
		Type:      eventType,
		Severity:  severity,
		IPHash:    ipHash,
		Metadata:  metadata,
		CreatedAt: time.Now().UTC(),
	}
	return events.Create(ctx, e)
}
