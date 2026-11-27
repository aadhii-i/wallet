// Package bitcoinshared relays public Bitcoin signing messages. It never holds
// native keys or Raccoon shares, and never signs or broadcasts transactions.
package bitcoinshared

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

type Message struct {
	ID        string    `json:"id"`
	From      string    `json:"from"`
	Kind      string    `json:"kind"`
	Session   string    `json:"session"`
	Payload   string    `json:"payload"`
	Signature string    `json:"signature"`
	CreatedAt time.Time `json:"createdAt"`
}
type request struct {
	KeygenID          string `json:"keygenId"`
	MembershipVersion int64  `json:"membershipVersion"`
	Kind              string `json:"kind"`
	Session           string `json:"session"`
	Payload           string `json:"payload"`
	Signature         string `json:"signature"`
}
type Relay struct {
	migrationGuard func(context.Context, string, string, string, string, string) error
	st             store.Store
	pool           *pgxpool.Pool
	mu             sync.Mutex
	messages       map[string][]Message
	snapshot       string
}

func New(st store.Store, pool *pgxpool.Pool, snapshot string) (*Relay, error) {
	r := &Relay{st: st, pool: pool, messages: map[string][]Message{}, snapshot: snapshot}
	if pool == nil && snapshot != "" {
		data, err := os.ReadFile(snapshot)
		if err == nil {
			if err = json.Unmarshal(data, &r.messages); err != nil {
				return nil, errors.New("invalid shared Bitcoin relay snapshot")
			}
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	// Restore guards for pre-existing memory snapshots before serving requests.
	if pool == nil {
		for scope, messages := range r.messages {
			parts := strings.Split(scope, "|")
			if len(parts) != 4 {
				return nil, errors.New("invalid native relay scope")
			}
			walletID, err := uuid.Parse(parts[0])
			if err != nil {
				return nil, err
			}
			wallet, err := st.SharedWallets().GetWallet(context.Background(), walletID)
			if err != nil {
				return nil, err
			}
			members, err := st.SharedWallets().ListMembers(context.Background(), walletID)
			if err != nil {
				return nil, err
			}
			for _, message := range messages {
				if message.Kind != "policy" {
					continue
				}
				for _, member := range members {
					if member.ID.String() == message.From && member.Role == store.RoleOwner {
						if err = st.SharedWallets().LockNativeCustody(context.Background(), walletID, wallet.MembershipVersion); err != nil {
							return nil, err
						}
					}
				}
			}
		}
	}
	return r, nil
}
func (r *Relay) Routes(router chi.Router) {
	router.Get("/v1/shared-wallets/{walletId}/bitcoin/{accountId}", r.get)
	router.Post("/v1/shared-wallets/{walletId}/bitcoin/{accountId}", r.post)
}

// Every message is bound to the registered device, membership epoch and keygen.
func signingText(wallet, account string, q request) string {
	hash := sha256.Sum256([]byte(q.Payload))
	bytes, _ := json.Marshal([]any{"QDWallet-BitcoinRelay/v1", wallet, account, q.KeygenID, q.MembershipVersion, q.Kind, q.Session, hex.EncodeToString(hash[:])})
	return string(bytes)
}
func (r *Relay) authorize(w http.ResponseWriter, req *http.Request) (*store.SharedWallet, *store.SharedMember, string, bool) {
	principal := auth.FromContext(req.Context())
	walletID, e1 := uuid.Parse(chi.URLParam(req, "walletId"))
	accountID, e2 := uuid.Parse(chi.URLParam(req, "accountId"))
	if principal == nil || e1 != nil || e2 != nil {
		httpx.NotFound(w, req, "NOT_FOUND", "")
		return nil, nil, "", false
	}
	member, err := r.st.SharedWallets().GetActiveMemberByUser(req.Context(), walletID, principal.UserID)
	if err != nil || member.DeviceID != principal.DeviceID {
		httpx.NotFound(w, req, "NOT_FOUND", "")
		return nil, nil, "", false
	}
	wallet, err := r.st.SharedWallets().GetWallet(req.Context(), walletID)
	if err != nil || wallet.KeyStatus != store.KeyActive || wallet.KeyGenerationID == nil {
		httpx.Conflict(w, req, "KEY_NOT_READY", "shared key is not ready")
		return nil, nil, "", false
	}
	if _, err = r.st.SharedWallets().GetAccount(req.Context(), walletID, accountID); err != nil {
		httpx.NotFound(w, req, "NOT_FOUND", "")
		return nil, nil, "", false
	}
	scope := strings.Join([]string{walletID.String(), accountID.String(), wallet.KeyGenerationID.String(), big.NewInt(wallet.MembershipVersion).String()}, "|")
	return wallet, member, scope, true
}
func (r *Relay) get(w http.ResponseWriter, req *http.Request) {
	_, _, scope, ok := r.authorize(w, req)
	if !ok {
		return
	}
	session := req.URL.Query().Get("session")
	if session == "" {
		session = "enrollment"
	}
	messages, err := r.read(req.Context(), scope, session)
	if err != nil {
		httpx.InternalError(w, req, "INTERNAL", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"messages": messages})
}
func (r *Relay) post(w http.ResponseWriter, req *http.Request) {
	wallet, member, scope, ok := r.authorize(w, req)
	if !ok {
		return
	}
	var q request
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1500000))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&q) != nil || len(q.Payload) > 1400000 || len(q.Payload) == 0 {
		httpx.BadRequest(w, req, "INVALID_BODY", "invalid or oversized signing message")
		return
	}
	if q.KeygenID != wallet.KeyGenerationID.String() || q.MembershipVersion != wallet.MembershipVersion {
		httpx.Conflict(w, req, "STALE_MEMBERSHIP", "refresh the shared wallet")
		return
	}
	allowed := map[string]bool{"enrollment": true, "policy": true, "proposal": true, "approve": true, "r1": true, "r2": true, "r3": true, "partial": true, "final": true}
	if !allowed[q.Kind] || (q.Session != "enrollment" && !validSession(q.Session)) || ((q.Kind == "enrollment" || q.Kind == "policy") != (q.Session == "enrollment")) {
		httpx.BadRequest(w, req, "INVALID_BODY", "invalid signing phase")
		return
	}
	signature, err := base64.RawURLEncoding.DecodeString(q.Signature)
	parsed, e := x509.ParsePKIXPublicKey(member.DevicePublicKey)
	key, valid := parsed.(*ecdsa.PublicKey)
	digest := sha256.Sum256([]byte(signingText(wallet.ID.String(), chi.URLParam(req, "accountId"), q)))
	if err != nil || e != nil || !valid || len(signature) != 64 || !ecdsa.Verify(key, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		httpx.Forbidden(w, req, "BAD_SIGNATURE", "signing message is not from the registered device")
		return
	}
	// The owner's signed policy confirmation commits to native custody. The
	// store locks against roster edits atomically before publishing that message.
	if q.Kind == "policy" && member.Role == store.RoleOwner {
		if err := r.st.SharedWallets().LockNativeCustody(req.Context(), wallet.ID, wallet.MembershipVersion); err != nil {
			httpx.Conflict(w, req, "STALE_MEMBERSHIP", "Refresh the shared wallet before confirming native custody")
			return
		}
	}
	if r.migrationGuard != nil {
		if err := r.migrationGuard(req.Context(), wallet.ID.String(), chi.URLParam(req, "accountId"), q.Kind, q.Session, q.Payload); err != nil {
			httpx.Conflict(w, req, "NATIVE_MIGRATION_IN_PROGRESS", err.Error())
			return
		}
	}
	id := sha256.Sum256([]byte(scope + "|" + member.ID.String() + "|" + q.Kind + "|" + q.Session + "|" + q.Payload))
	message := Message{ID: hex.EncodeToString(id[:]), From: member.ID.String(), Kind: q.Kind, Session: q.Session, Payload: q.Payload, Signature: q.Signature, CreatedAt: time.Now().UTC()}
	if err = r.append(req.Context(), scope, message); err != nil {
		httpx.Conflict(w, req, "MESSAGE_CONFLICT", "message already committed differently or room limit reached")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, message)
}
func validSession(s string) bool { _, err := uuid.Parse(s); return err == nil }

func (r *Relay) read(ctx context.Context, scope, session string) ([]Message, error) {
	if r.pool != nil {
		rows, err := r.pool.Query(ctx, "SELECT body FROM bitcoin_shared_messages WHERE scope=$1 AND (($2='recent' AND kind='proposal' AND created_at>now()-interval '24 hours') OR session=$2) ORDER BY created_at LIMIT 512", scope, session)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []Message{}
		for rows.Next() {
			var body []byte
			var msg Message
			if err = rows.Scan(&body); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(body, &msg); err != nil {
				return nil, err
			}
			out = append(out, msg)
		}
		return out, rows.Err()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Message{}
	for _, message := range r.messages[scope] {
		if message.Session == session || (session == "recent" && message.Kind == "proposal" && time.Since(message.CreatedAt) < 24*time.Hour) {
			out = append(out, message)
		}
	}
	return out, nil
}
func (r *Relay) append(ctx context.Context, scope string, message Message) error {
	if r.pool != nil {
		tx, err := r.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", scope); err != nil {
			return err
		}
		var previousID string
		err = tx.QueryRow(ctx, "SELECT id FROM bitcoin_shared_messages WHERE scope=$1 AND session=$2 AND kind=$3 AND (author=$4 OR kind='proposal') LIMIT 1", scope, message.Session, message.Kind, message.From).Scan(&previousID)
		if err == nil {
			if previousID != message.ID {
				return errors.New("conflicting message")
			}
			return tx.Commit(ctx)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var count int
		var size int64
		if err = tx.QueryRow(ctx, "SELECT count(*),COALESCE(sum(octet_length(body::text)),0) FROM bitcoin_shared_messages WHERE scope=$1 AND session=$2", scope, message.Session).Scan(&count, &size); err != nil {
			return err
		}
		if count >= 64 || size+int64(len(message.Payload)) > 16000000 {
			return errors.New("room limit")
		}
		body, _ := json.Marshal(message)
		result, err := tx.Exec(ctx, "INSERT INTO bitcoin_shared_messages(scope,session,kind,author,id,body,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(scope,session,kind,author) DO UPDATE SET id=bitcoin_shared_messages.id WHERE bitcoin_shared_messages.id=excluded.id", scope, message.Session, message.Kind, message.From, message.ID, body, message.CreatedAt)
		if err != nil {
			return err
		}
		if result.RowsAffected() != 1 {
			return errors.New("conflicting message")
		}
		return tx.Commit(ctx)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entries := r.messages[scope]
	count, size := 0, 0
	for _, previous := range entries {
		if previous.Session == message.Session {
			count++
			size += len(previous.Payload)
		}
		if previous.Session == message.Session && previous.Kind == message.Kind && (previous.From == message.From || message.Kind == "proposal") {
			if previous.ID == message.ID {
				return nil
			}
			return errors.New("conflicting message")
		}
	}
	if count >= 64 || size+len(message.Payload) > 16000000 || len(entries) >= 20000 {
		return errors.New("room limit")
	}
	next := append(append([]Message{}, entries...), message)
	r.messages[scope] = next
	if r.snapshot != "" {
		data, err := json.Marshal(r.messages)
		if err != nil {
			r.messages[scope] = entries
			return err
		}
		if err = os.MkdirAll(filepath.Dir(r.snapshot), 0700); err == nil {
			err = os.WriteFile(r.snapshot+".tmp", data, 0600)
		}
		if err == nil {
			err = os.Rename(r.snapshot+".tmp", r.snapshot)
		}
		if err != nil {
			r.messages[scope] = entries
			return err
		}
	}
	return nil
}

// SetMigrationGuard is called once during startup, before requests are served.
func (r *Relay) SetMigrationGuard(guard func(context.Context, string, string, string, string, string) error) {
	r.migrationGuard = guard
}

// NativeRooms supplies public enrollment/policy snapshots to the migration
// coordinator. Callers must authenticate the wallet before exposing them.
func (r *Relay) NativeRooms(ctx context.Context, walletID string) (map[string]json.RawMessage, error) {
	grouped := map[string][]Message{}
	if r.pool != nil {
		rows, err := r.pool.Query(ctx, "SELECT scope,body FROM bitcoin_shared_messages WHERE scope LIKE $1 AND session='enrollment' ORDER BY scope,created_at LIMIT 4097", walletID+"|%")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		count := 0
		for rows.Next() {
			count++
			if count > 4096 {
				return nil, errors.New("native inventory limit")
			}
			var scope string
			var body []byte
			var message Message
			if err = rows.Scan(&scope, &body); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(body, &message); err != nil {
				return nil, err
			}
			grouped[scope] = append(grouped[scope], message)
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
	} else {
		r.mu.Lock()
		defer r.mu.Unlock()
		for scope, messages := range r.messages {
			if strings.HasPrefix(scope, walletID+"|") {
				for _, message := range messages {
					if message.Session == "enrollment" {
						grouped[scope] = append(grouped[scope], message)
					}
				}
			}
		}
	}
	result := map[string]json.RawMessage{}
	for scope, messages := range grouped {
		body, err := json.Marshal(messages)
		if err != nil {
			return nil, err
		}
		result[scope] = body
	}
	return result, nil
}

func (r *Relay) SessionMessages(ctx context.Context, wallet, account, keygen string, epoch int64, session string) (json.RawMessage, error) {
	if !validSession(session) {
		return nil, errors.New("invalid signing session")
	}
	scope := strings.Join([]string{wallet, account, keygen, big.NewInt(epoch).String()}, "|")
	messages, err := r.read(ctx, scope, session)
	if err != nil {
		return nil, err
	}
	return json.Marshal(messages)
}
