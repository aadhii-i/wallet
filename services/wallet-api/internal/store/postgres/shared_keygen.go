package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Key generation. Every mutation takes the wallet row FOR UPDATE first (the
// same lock membership changes take), then the ceremony row, so a revocation
// and a ceremony step can never interleave.

const keygenCols = `id, wallet_id, membership_version, threshold, parties, dealer_member_id, status, failure_reason,
	fingerprint, dealer_signature, created_at, expires_at, ended_at`

const keygenPartCols = `keygen_id, member_id, party_index, encryption_key, key_signature, key_registered_at,
	envelope_enc, envelope_ct, envelope_hash, envelope_fingerprint, ack_signature, provisioned_at`

func scanKeygen(row pgx.Row) (*store.KeyGeneration, error) {
	var k store.KeyGeneration
	var status string
	if err := row.Scan(&k.ID, &k.WalletID, &k.MembershipVersion, &k.Threshold, &k.Parties, &k.DealerMemberID, &status, &k.FailureReason,
		&k.Fingerprint, &k.DealerSignature, &k.CreatedAt, &k.ExpiresAt, &k.EndedAt); err != nil {
		return nil, mapNotFound(err)
	}
	k.Status = store.KeygenStatus(status)
	return &k, nil
}

func listKeygenParts(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, keygenID uuid.UUID) ([]*store.KeygenParticipant, error) {
	rows, err := q.Query(ctx, `SELECT `+keygenPartCols+` FROM shared_key_generation_participants WHERE keygen_id=$1 ORDER BY party_index`, keygenID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.KeygenParticipant
	for rows.Next() {
		var p store.KeygenParticipant
		if err := rows.Scan(&p.KeygenID, &p.MemberID, &p.PartyIndex, &p.EncryptionKey, &p.KeySignature, &p.KeyRegisteredAt,
			&p.EnvelopeEnc, &p.EnvelopeCT, &p.EnvelopeHash, &p.EnvelopeFingerprint, &p.AckSignature, &p.ProvisionedAt); err != nil {
			return nil, err
		}
		out = append(out, &p)
	}
	return out, rows.Err()
}

func failKeygenTx(ctx context.Context, tx pgx.Tx, keygenID uuid.UUID, reason string, now time.Time) (*store.KeyGeneration, error) {
	if _, err := tx.Exec(ctx, `UPDATE shared_key_generation_participants SET envelope_enc=NULL, envelope_ct=NULL WHERE keygen_id=$1`, keygenID); err != nil {
		return nil, err
	}
	return scanKeygen(tx.QueryRow(ctx, `UPDATE shared_key_generations SET status='failed', failure_reason=$2, ended_at=$3
		WHERE id=$1 RETURNING `+keygenCols, keygenID, reason, now))
}

// keygenStep runs fn on a locked ceremony in status want. An expired open
// ceremony is failed and that change is committed, while the caller still
// receives ErrKeygenClosed.
func (r *sharedRepo) keygenStep(ctx context.Context, keygenID uuid.UUID, want store.KeygenStatus, now time.Time,
	fn func(tx pgx.Tx, kg *store.KeyGeneration) error) error {
	var stepErr error
	err := withTx(ctx, r.pool, func(tx pgx.Tx) error {
		var walletID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT wallet_id FROM shared_key_generations WHERE id=$1`, keygenID).Scan(&walletID); err != nil {
			return mapNotFound(err)
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM shared_wallets WHERE id=$1 FOR UPDATE`, walletID); err != nil {
			return err
		}
		kg, err := scanKeygen(tx.QueryRow(ctx, `SELECT `+keygenCols+` FROM shared_key_generations WHERE id=$1 FOR UPDATE`, keygenID))
		if err != nil {
			return err
		}
		if kg.Status.Open() && !now.Before(kg.ExpiresAt) {
			if _, err := failKeygenTx(ctx, tx, keygenID, store.KeygenFailExpired, now); err != nil {
				return err
			}
			stepErr = store.ErrKeygenClosed
			return nil // commit the expiry
		}
		if want != "" && kg.Status != want {
			return store.ErrKeygenClosed
		}
		return fn(tx, kg)
	})
	if err != nil {
		return err
	}
	return stepErr
}

func (r *sharedRepo) CreateKeyGeneration(ctx context.Context, kg *store.KeyGeneration, parts []*store.KeygenParticipant) error {
	return withTx(ctx, r.pool, func(tx pgx.Tx) error {
		w, err := scanSharedWallet(tx.QueryRow(ctx, `SELECT `+sharedWalletCols+` FROM shared_wallets WHERE id=$1 FOR UPDATE`, kg.WalletID))
		if err != nil {
			return err
		}
		if w.MembershipVersion != kg.MembershipVersion {
			return store.ErrStale
		}
		if w.KeyStatus == store.KeyActive {
			return store.ErrConflict
		}
		// Expire a lapsed open ceremony so it does not block a new one.
		var stale []uuid.UUID
		rows, err := tx.Query(ctx, `SELECT id FROM shared_key_generations
			WHERE wallet_id=$1 AND status IN ('collecting_keys','dealing','awaiting_provisioning') AND expires_at <= $2`, kg.WalletID, kg.CreatedAt)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			stale = append(stale, id)
		}
		rows.Close()
		for _, id := range stale {
			if _, err := failKeygenTx(ctx, tx, id, store.KeygenFailExpired, kg.CreatedAt); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO shared_key_generations (`+keygenCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			kg.ID, kg.WalletID, kg.MembershipVersion, kg.Threshold, kg.Parties, kg.DealerMemberID, string(kg.Status), kg.FailureReason,
			kg.Fingerprint, kg.DealerSignature, kg.CreatedAt, kg.ExpiresAt, kg.EndedAt); err != nil {
			return mapConflict(err) // the partial unique index enforces one open ceremony
		}
		for _, p := range parts {
			if _, err := tx.Exec(ctx, `INSERT INTO shared_key_generation_participants (keygen_id, member_id, party_index) VALUES ($1,$2,$3)`,
				kg.ID, p.MemberID, p.PartyIndex); err != nil {
				return mapConflict(err)
			}
		}
		return nil
	})
}

func (r *sharedRepo) GetKeyGeneration(ctx context.Context, keygenID uuid.UUID) (*store.KeyGeneration, []*store.KeygenParticipant, error) {
	kg, err := scanKeygen(r.pool.QueryRow(ctx, `SELECT `+keygenCols+` FROM shared_key_generations WHERE id=$1`, keygenID))
	if err != nil {
		return nil, nil, err
	}
	parts, err := listKeygenParts(ctx, r.pool, keygenID)
	return kg, parts, err
}

func (r *sharedRepo) LatestKeyGeneration(ctx context.Context, walletID uuid.UUID) (*store.KeyGeneration, []*store.KeygenParticipant, error) {
	kg, err := scanKeygen(r.pool.QueryRow(ctx, `SELECT `+keygenCols+` FROM shared_key_generations WHERE wallet_id=$1
		ORDER BY created_at DESC, id DESC LIMIT 1`, walletID))
	if err != nil {
		return nil, nil, err
	}
	parts, err := listKeygenParts(ctx, r.pool, kg.ID)
	return kg, parts, err
}

func (r *sharedRepo) RegisterEncryptionKey(ctx context.Context, keygenID, memberID uuid.UUID, key, sig []byte, now time.Time) (*store.KeyGeneration, error) {
	var out *store.KeyGeneration
	err := r.keygenStep(ctx, keygenID, store.KeygenCollectingKeys, now, func(tx pgx.Tx, kg *store.KeyGeneration) error {
		var registered *time.Time
		if err := tx.QueryRow(ctx, `SELECT key_registered_at FROM shared_key_generation_participants WHERE keygen_id=$1 AND member_id=$2 FOR UPDATE`,
			keygenID, memberID).Scan(&registered); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return store.ErrNotEligible
			}
			return err
		}
		if registered != nil {
			return store.ErrConflict
		}
		if _, err := tx.Exec(ctx, `UPDATE shared_key_generation_participants SET encryption_key=$3, key_signature=$4, key_registered_at=$5
			WHERE keygen_id=$1 AND member_id=$2`, keygenID, memberID, key, sig, now); err != nil {
			return err
		}
		var missing int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM shared_key_generation_participants WHERE keygen_id=$1 AND key_registered_at IS NULL`, keygenID).Scan(&missing); err != nil {
			return err
		}
		out = kg
		if missing == 0 {
			k, err := scanKeygen(tx.QueryRow(ctx, `UPDATE shared_key_generations SET status='dealing' WHERE id=$1 RETURNING `+keygenCols, keygenID))
			out = k
			return err
		}
		return nil
	})
	return out, err
}

func (r *sharedRepo) StageEnvelope(ctx context.Context, keygenID, memberID uuid.UUID, fingerprint, enc, ct []byte, now time.Time) error {
	return r.keygenStep(ctx, keygenID, store.KeygenDealing, now, func(tx pgx.Tx, _ *store.KeyGeneration) error {
		h := sha256.Sum256(append(append([]byte(nil), enc...), ct...))
		tag, err := tx.Exec(ctx, `UPDATE shared_key_generation_participants SET envelope_enc=$3, envelope_ct=$4, envelope_hash=$5, envelope_fingerprint=$6
			WHERE keygen_id=$1 AND member_id=$2`, keygenID, memberID, enc, ct, h[:], fingerprint)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return store.ErrNotEligible
		}
		return nil
	})
}

func (r *sharedRepo) CommitDeal(ctx context.Context, keygenID uuid.UUID, fingerprint, dealerSig []byte, now time.Time) (*store.KeyGeneration, error) {
	var out *store.KeyGeneration
	err := r.keygenStep(ctx, keygenID, store.KeygenDealing, now, func(tx pgx.Tx, _ *store.KeyGeneration) error {
		var bad int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM shared_key_generation_participants
			WHERE keygen_id=$1 AND (envelope_ct IS NULL OR envelope_fingerprint IS DISTINCT FROM $2)`, keygenID, fingerprint).Scan(&bad); err != nil {
			return err
		}
		if bad > 0 {
			return store.ErrKeygenIncomplete
		}
		k, err := scanKeygen(tx.QueryRow(ctx, `UPDATE shared_key_generations SET status='awaiting_provisioning', fingerprint=$2, dealer_signature=$3
			WHERE id=$1 RETURNING `+keygenCols, keygenID, fingerprint, dealerSig))
		out = k
		return err
	})
	return out, err
}

func (r *sharedRepo) AckProvisioning(ctx context.Context, keygenID, memberID uuid.UUID, fingerprint, sig []byte, now time.Time) (*store.KeyGeneration, error) {
	var out *store.KeyGeneration
	// Status "" lets the duplicate check run before the status check, so a
	// repeated acknowledgement reports ErrConflict even after completion.
	err := r.keygenStep(ctx, keygenID, "", now, func(tx pgx.Tx, kg *store.KeyGeneration) error {
		var provisioned *time.Time
		if err := tx.QueryRow(ctx, `SELECT provisioned_at FROM shared_key_generation_participants WHERE keygen_id=$1 AND member_id=$2 FOR UPDATE`,
			keygenID, memberID).Scan(&provisioned); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return store.ErrNotEligible
			}
			return err
		}
		if provisioned != nil {
			return store.ErrConflict
		}
		if kg.Status != store.KeygenAwaitingProvisioning {
			return store.ErrKeygenClosed
		}
		if !bytes.Equal(kg.Fingerprint, fingerprint) {
			return store.ErrMismatch
		}
		if _, err := tx.Exec(ctx, `UPDATE shared_key_generation_participants SET ack_signature=$3, provisioned_at=$4, envelope_enc=NULL, envelope_ct=NULL
			WHERE keygen_id=$1 AND member_id=$2`, keygenID, memberID, sig, now); err != nil {
			return err
		}
		var missing int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM shared_key_generation_participants WHERE keygen_id=$1 AND provisioned_at IS NULL`, keygenID).Scan(&missing); err != nil {
			return err
		}
		out = kg
		if missing > 0 {
			return nil
		}
		var version int64
		if err := tx.QueryRow(ctx, `SELECT membership_version FROM shared_wallets WHERE id=$1`, kg.WalletID).Scan(&version); err != nil {
			return err
		}
		if version != kg.MembershipVersion {
			return store.ErrStale // unreachable: membership changes fail the open ceremony first
		}
		k, err := scanKeygen(tx.QueryRow(ctx, `UPDATE shared_key_generations SET status='complete', ended_at=$2 WHERE id=$1 RETURNING `+keygenCols, keygenID, now))
		if err != nil {
			return err
		}
		out = k
		_, err = tx.Exec(ctx, `UPDATE shared_wallets SET key_status='active', key_generation_id=$2, key_fingerprint=$3 WHERE id=$1`,
			kg.WalletID, kg.ID, kg.Fingerprint)
		return err
	})
	return out, err
}

func (r *sharedRepo) FailKeyGeneration(ctx context.Context, keygenID uuid.UUID, reason string, now time.Time) (*store.KeyGeneration, error) {
	var out *store.KeyGeneration
	err := r.keygenStep(ctx, keygenID, "", now, func(tx pgx.Tx, kg *store.KeyGeneration) error {
		if !kg.Status.Open() {
			return store.ErrKeygenClosed
		}
		k, err := failKeygenTx(ctx, tx, keygenID, reason, now)
		out = k
		return err
	})
	return out, err
}
