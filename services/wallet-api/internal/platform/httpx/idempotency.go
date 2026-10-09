package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// IdempotentCreate runs fn (which should perform the create and return the
// status code + response body to send) at most once per (userID, key,
// route). A repeated call with the same Idempotency-Key replays the
// original response instead of creating a duplicate resource.
func IdempotentCreate(ctx context.Context, idem store.Idempotency, userID uuid.UUID, key, route string, w http.ResponseWriter, fn func() (int, any, error)) {
	if key != "" {
		if rec, err := idem.Get(ctx, userID, key, route); err == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(rec.StatusCode)
			_, _ = w.Write(rec.Body)
			return
		}
	}
	status, body, err := fn()
	if err != nil {
		return // fn is responsible for writing its own error response
	}
	bodyBytes, _ := json.Marshal(body)
	if key != "" {
		_ = idem.Put(ctx, &store.IdempotencyRecord{
			Key:        key,
			UserID:     userID,
			Route:      route,
			StatusCode: status,
			Body:       bodyBytes,
			CreatedAt:  time.Now().UTC(),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(bodyBytes)
}
