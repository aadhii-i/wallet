package postgres

import (
	"bytes"
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Signing sessions and executions. Mutations lock the wallet row FOR SHARE
// (membership changes take it FOR UPDATE, so they wait for in-flight signing
// steps and vice versa), then the session row FOR UPDATE.

const sessionCols = `id, proposal_id, wallet_id, keygen_id, attempt, sid, act, signer_member_ids::text[], threshold, parties,
	membership_version, derivation_index, chain_id, account_address, public_key_hash, message, status, failure_reason,
	failed_by, signature, created_at, expires_at, ended_at`

func scanSession(row pgx.Row) (*store.SigningSession, error) {
	var s store.SigningSession
	var act []int32
	var signers []string
	var status string
	if err := row.Scan(&s.ID, &s.ProposalID, &s.WalletID, &s.KeygenID, &s.Attempt, &s.SID, &act, &signers, &s.Threshold, &s.Parties,
		&s.MembershipVersion, &s.DerivationIndex, &s.ChainID, &s.AccountAddress, &s.PublicKeyHash, &s.Message, &status, &s.FailureReason,
		&s.FailedBy, &s.Signature, &s.CreatedAt, &s.ExpiresAt, &s.EndedAt); err != nil {
		return nil, mapNotFound(err)
	}
	s.Status = store.SigningStatus(status)
	for _, a := range act {
		s.Act = append(s.Act, int(a))
	}
	for _, id := range signers {
		u, err := uuid.Parse(id)
		if err != nil {
			return nil, err
		}
		s.SignerMemberIDs = append(s.SignerMemberIDs, u)
	}
	return &s, nil
}

func listSessionMsgs(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, sessionID uuid.UUID) ([]*store.SigningMessage, error) {
	rows, err := q.Query(ctx, `SELECT session_id, round, party_index, member_id, payload, device_signature, created_at
		FROM shared_signing_messages WHERE session_id=$1 ORDER BY round, created_at, party_index`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.SigningMessage
	for rows.Next() {
		var m store.SigningMessage
		if err := rows.Scan(&m.SessionID, &m.Round, &m.PartyIndex, &m.MemberID, &m.Payload, &m.DeviceSignature, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &m)
	}
	return out, rows.Err()
}

func failSessionTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string, by *uuid.UUID, now time.Time) (*store.SigningSession, error) {
	return scanSession(tx.QueryRow(ctx, `UPDATE shared_signing_sessions SET status='failed', failure_reason=$2, failed_by=$3, ended_at=$4
		WHERE id=$1 RETURNING `+sessionCols, id, reason, by, now))
}

// lockSession locks the wallet (shared) and the session, failing an expired
// open session. expired reports whether that happened (the caller commits it).
func lockSession(ctx context.Context, tx pgx.Tx, id uuid.UUID, now time.Time) (ss *store.SigningSession, expired bool, err error) {
	var walletID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT wallet_id FROM shared_signing_sessions WHERE id=$1`, id).Scan(&walletID); err != nil {
		return nil, false, mapNotFound(err)
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM shared_wallets WHERE id=$1 FOR SHARE`, walletID); err != nil {
		return nil, false, err
	}
	ss, err = scanSession(tx.QueryRow(ctx, `SELECT `+sessionCols+` FROM shared_signing_sessions WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return nil, false, err
	}
	if ss.Status.Open() && ss.Status != store.SigningCombining && !now.Before(ss.ExpiresAt) {
		ss, err = failSessionTx(ctx, tx, id, store.SigningFailExpired, nil, now)
		return ss, true, err
	}
	return ss, false, nil
}

func (r *sharedRepo) PutAccountKey(ctx context.Context, k *store.AccountKey, att store.AccountKeyAttestation) (*store.AccountKey, error) {
	err := withTx(ctx, r.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO shared_account_keys (account_id, keygen_id, wallet_id, derivation_index, public_key,
			public_key_hash, address, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (account_id, keygen_id) DO NOTHING`,
			k.AccountID, k.KeygenID, k.WalletID, k.DerivationIndex, k.PublicKey, k.PublicKeyHash, k.Address, k.CreatedAt); err != nil {
			return err
		}
		var pk []byte
		var addr string
		if err := tx.QueryRow(ctx, `SELECT public_key, address FROM shared_account_keys WHERE account_id=$1 AND keygen_id=$2 FOR UPDATE`,
			k.AccountID, k.KeygenID).Scan(&pk, &addr); err != nil {
			return err
		}
		if !bytes.Equal(pk, k.PublicKey) || addr != k.Address {
			return store.ErrMismatch
		}
		_, err := tx.Exec(ctx, `INSERT INTO shared_account_key_attestations (account_id, keygen_id, member_id, signature, created_at)
			VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, k.AccountID, k.KeygenID, att.MemberID, att.Signature, att.At)
		return err
	})
	if err != nil {
		return nil, err
	}
	return r.GetAccountKey(ctx, k.AccountID, k.KeygenID)
}

func (r *sharedRepo) GetAccountKey(ctx context.Context, accountID, keygenID uuid.UUID) (*store.AccountKey, error) {
	var k store.AccountKey
	if err := r.pool.QueryRow(ctx, `SELECT account_id, keygen_id, wallet_id, derivation_index, public_key, public_key_hash, address, created_at
		FROM shared_account_keys WHERE account_id=$1 AND keygen_id=$2`, accountID, keygenID).
		Scan(&k.AccountID, &k.KeygenID, &k.WalletID, &k.DerivationIndex, &k.PublicKey, &k.PublicKeyHash, &k.Address, &k.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	rows, err := r.pool.Query(ctx, `SELECT member_id, signature, created_at FROM shared_account_key_attestations
		WHERE account_id=$1 AND keygen_id=$2 ORDER BY created_at`, accountID, keygenID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a store.AccountKeyAttestation
		if err := rows.Scan(&a.MemberID, &a.Signature, &a.At); err != nil {
			return nil, err
		}
		k.Attestations = append(k.Attestations, a)
	}
	return &k, rows.Err()
}

func (r *sharedRepo) CreateSigningSession(ctx context.Context, ss *store.SigningSession) error {
	return withTx(ctx, r.pool, func(tx pgx.Tx) error {
		w, err := scanSharedWallet(tx.QueryRow(ctx, `SELECT `+sharedWalletCols+` FROM shared_wallets
			WHERE id=(SELECT wallet_id FROM proposals WHERE id=$1) FOR SHARE`, ss.ProposalID))
		if err != nil {
			return err
		}
		var status string
		var pmv int64
		if err := tx.QueryRow(ctx, `SELECT status, membership_version FROM proposals WHERE id=$1 FOR UPDATE`, ss.ProposalID).Scan(&status, &pmv); err != nil {
			return mapNotFound(err)
		}
		var jobs int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM signing_jobs WHERE proposal_id=$1`, ss.ProposalID).Scan(&jobs); err != nil {
			return err
		}
		if status != string(store.ProposalApproved) || jobs != 1 {
			return store.ErrProposalClosed
		}
		if w.KeyStatus != store.KeyActive || w.KeyGenerationID == nil || *w.KeyGenerationID != ss.KeygenID ||
			w.MembershipVersion != ss.MembershipVersion || pmv != ss.MembershipVersion {
			return store.ErrStale
		}
		// Expire stale open sessions, then refuse if one is open or complete.
		if _, err := tx.Exec(ctx, `UPDATE shared_signing_sessions SET status='failed', failure_reason=$2, ended_at=$3
			WHERE proposal_id=$1 AND status IN ('round1','round2','round3') AND expires_at <= $3`,
			ss.ProposalID, store.SigningFailExpired, ss.CreatedAt); err != nil {
			return err
		}
		var open, complete, attempts int
		if err := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status IN ('round1','round2','round3','combining')),
			count(*) FILTER (WHERE status='complete'), count(*) FROM shared_signing_sessions WHERE proposal_id=$1`, ss.ProposalID).
			Scan(&open, &complete, &attempts); err != nil {
			return err
		}
		if complete > 0 {
			return store.ErrAlreadySigned
		}
		if open > 0 {
			return store.ErrConflict
		}
		ss.Attempt, ss.Status = attempts+1, store.SigningRound1
		act := make([]int32, len(ss.Act))
		for i, a := range ss.Act {
			act[i] = int32(a)
		}
		_, err = tx.Exec(ctx, `INSERT INTO shared_signing_sessions (id, proposal_id, wallet_id, keygen_id, attempt, sid, act,
			signer_member_ids, threshold, parties, membership_version, derivation_index, chain_id, account_address, public_key_hash,
			message, status, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
			ss.ID, ss.ProposalID, ss.WalletID, ss.KeygenID, ss.Attempt, ss.SID, act, uuidStrings(ss.SignerMemberIDs), ss.Threshold,
			ss.Parties, ss.MembershipVersion, ss.DerivationIndex, ss.ChainID, ss.AccountAddress, ss.PublicKeyHash, ss.Message,
			string(ss.Status), ss.CreatedAt, ss.ExpiresAt)
		return mapConflict(err)
	})
}

func (r *sharedRepo) GetSigningSession(ctx context.Context, id uuid.UUID, now time.Time) (*store.SigningSession, []*store.SigningMessage, error) {
	var ss *store.SigningSession
	var msgs []*store.SigningMessage
	err := withTx(ctx, r.pool, func(tx pgx.Tx) error {
		var err error
		if ss, _, err = lockSession(ctx, tx, id, now); err != nil {
			return err
		}
		msgs, err = listSessionMsgs(ctx, tx, id)
		return err
	})
	return ss, msgs, err
}

func (r *sharedRepo) LatestSigningSession(ctx context.Context, proposalID uuid.UUID, now time.Time) (*store.SigningSession, []*store.SigningMessage, error) {
	var id uuid.UUID
	if err := r.pool.QueryRow(ctx, `SELECT id FROM shared_signing_sessions WHERE proposal_id=$1 ORDER BY attempt DESC LIMIT 1`,
		proposalID).Scan(&id); err != nil {
		return nil, nil, mapNotFound(err)
	}
	return r.GetSigningSession(ctx, id, now)
}

func (r *sharedRepo) AddSigningMessage(ctx context.Context, m *store.SigningMessage, now time.Time,
	check func(*store.SigningSession, []*store.SigningMessage) string) (*store.SigningSession, error) {
	var out *store.SigningSession
	var stepErr error
	err := withTx(ctx, r.pool, func(tx pgx.Tx) error {
		ss, expired, err := lockSession(ctx, tx, m.SessionID, now)
		if err != nil {
			return err
		}
		if expired {
			stepErr = store.ErrSigningClosed
			return nil // commit the expiry
		}
		if ss.Status.Round() != m.Round {
			return store.ErrSigningClosed
		}
		ok := false
		for i, idx := range ss.Act {
			if idx == m.PartyIndex && ss.SignerMemberIDs[i] == m.MemberID {
				ok = true
			}
		}
		if !ok {
			return store.ErrNotEligible
		}
		msgs, err := listSessionMsgs(ctx, tx, ss.ID)
		if err != nil {
			return err
		}
		inRound := 0
		for _, x := range msgs {
			if x.Round == m.Round {
				if x.PartyIndex == m.PartyIndex {
					return store.ErrConflict
				}
				inRound++
			}
		}
		if check != nil {
			if reason := check(ss, msgs); reason != "" {
				if _, err := failSessionTx(ctx, tx, ss.ID, reason, &m.MemberID, now); err != nil {
					return err
				}
				stepErr = store.ErrSigningClosed
				return nil // commit the failure
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO shared_signing_messages (session_id, round, party_index, member_id, payload,
			device_signature, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			m.SessionID, m.Round, m.PartyIndex, m.MemberID, m.Payload, m.DeviceSignature, now); err != nil {
			return mapConflict(err)
		}
		next := ss.Status
		if inRound+1 == len(ss.Act) {
			switch ss.Status {
			case store.SigningRound1:
				next = store.SigningRound2
			case store.SigningRound2:
				next = store.SigningRound3
			case store.SigningRound3:
				next = store.SigningCombining
			}
		}
		out, err = scanSession(tx.QueryRow(ctx, `UPDATE shared_signing_sessions SET status=$2 WHERE id=$1 RETURNING `+sessionCols,
			ss.ID, string(next)))
		return err
	})
	if err != nil {
		return nil, err
	}
	if stepErr != nil {
		return nil, stepErr
	}
	return out, nil
}

func (r *sharedRepo) CompleteSigningSession(ctx context.Context, id uuid.UUID, sig []byte, now time.Time) (*store.SigningSession, error) {
	var out *store.SigningSession
	err := withTx(ctx, r.pool, func(tx pgx.Tx) error {
		ss, _, err := lockSession(ctx, tx, id, now)
		if err != nil {
			return err
		}
		if ss.Status != store.SigningCombining {
			if ss.Status == store.SigningComplete {
				return store.ErrAlreadySigned
			}
			return store.ErrSigningClosed
		}
		if out, err = scanSession(tx.QueryRow(ctx, `UPDATE shared_signing_sessions SET status='complete', signature=$2, ended_at=$3
			WHERE id=$1 RETURNING `+sessionCols, id, sig, now)); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO shared_executions (proposal_id, session_id, wallet_id, chain_id, account_address, status,
			created_at, updated_at, stage) VALUES ($1,$2,$3,$4,$5,'pending',$6,$6,'queued')`,
			ss.ProposalID, ss.ID, ss.WalletID, ss.ChainID, ss.AccountAddress, now)
		return mapConflict(err)
	})
	return out, err
}

func (r *sharedRepo) FailSigningSession(ctx context.Context, id uuid.UUID, reason string, by *uuid.UUID, now time.Time) (*store.SigningSession, error) {
	var out *store.SigningSession
	var stepErr error
	err := withTx(ctx, r.pool, func(tx pgx.Tx) error {
		ss, expired, err := lockSession(ctx, tx, id, now)
		if err != nil {
			return err
		}
		if expired || !ss.Status.Open() {
			stepErr = store.ErrSigningClosed
			return nil
		}
		out, err = failSessionTx(ctx, tx, id, reason, by, now)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, stepErr
}

const execCols = `proposal_id, session_id, wallet_id, chain_id, account_address, status, last_error, relayer_address, tx_hash, raw_tx,
	block_number, gas_used, call_success, created_at, updated_at, submitted_at, confirmed_at,
	stage, setup_attempts, next_attempt_at, setup_txs, pending_setup_tx, tx_nonce, effective_gas_price, block_time, executed_to, executed_value`

func scanExecution(row pgx.Row) (*store.Execution, error) {
	var e store.Execution
	var status string
	var block, gas, txNonce *int64
	if err := row.Scan(&e.ProposalID, &e.SessionID, &e.WalletID, &e.ChainID, &e.AccountAddress, &status, &e.LastError, &e.RelayerAddress,
		&e.TxHash, &e.RawTx, &block, &gas, &e.CallSuccess, &e.CreatedAt, &e.UpdatedAt, &e.SubmittedAt, &e.ConfirmedAt,
		&e.Stage, &e.SetupAttempts, &e.NextAttemptAt, &e.SetupTxs, &e.PendingSetupTx, &txNonce, &e.EffectiveGasPrice, &e.BlockTime,
		&e.ExecutedTo, &e.ExecutedValue); err != nil {
		return nil, mapNotFound(err)
	}
	if txNonce != nil {
		v := uint64(*txNonce)
		e.TxNonce = &v
	}
	e.Status = store.ExecutionStatus(status)
	if block != nil {
		v := uint64(*block)
		e.BlockNumber = &v
	}
	if gas != nil {
		v := uint64(*gas)
		e.GasUsed = &v
	}
	return &e, nil
}

func (r *sharedRepo) GetExecution(ctx context.Context, proposalID uuid.UUID) (*store.Execution, error) {
	return scanExecution(r.pool.QueryRow(ctx, `SELECT `+execCols+` FROM shared_executions WHERE proposal_id=$1`, proposalID))
}

func (r *sharedRepo) ListExecutions(ctx context.Context, statuses []store.ExecutionStatus) ([]*store.Execution, error) {
	ss := make([]string, len(statuses))
	for i, s := range statuses {
		ss[i] = string(s)
	}
	rows, err := r.pool.Query(ctx, `SELECT `+execCols+` FROM shared_executions WHERE status = ANY($1) ORDER BY created_at`, ss)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Execution
	for rows.Next() {
		e, err := scanExecution(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (r *sharedRepo) UpdateExecution(ctx context.Context, e *store.Execution, from store.ExecutionStatus) error {
	var block, gas *int64
	if e.BlockNumber != nil {
		v := int64(*e.BlockNumber)
		block = &v
	}
	if e.GasUsed != nil {
		v := int64(*e.GasUsed)
		gas = &v
	}
	var txNonce *int64
	if e.TxNonce != nil {
		v := int64(*e.TxNonce)
		txNonce = &v
	}
	setupTxs := e.SetupTxs
	if setupTxs == nil {
		setupTxs = []string{}
	}
	tag, err := r.pool.Exec(ctx, `UPDATE shared_executions SET status=$3, last_error=$4, relayer_address=$5, tx_hash=$6, raw_tx=$7,
		block_number=$8, gas_used=$9, call_success=$10, updated_at=$11, submitted_at=$12, confirmed_at=$13,
		stage=$14, setup_attempts=$15, next_attempt_at=$16, setup_txs=$17, pending_setup_tx=$18, tx_nonce=$19,
		effective_gas_price=$20, block_time=$21, executed_to=$22, executed_value=$23
		WHERE proposal_id=$1 AND status=$2`, e.ProposalID, string(from), string(e.Status), e.LastError, e.RelayerAddress, e.TxHash,
		e.RawTx, block, gas, e.CallSuccess, e.UpdatedAt, e.SubmittedAt, e.ConfirmedAt,
		e.Stage, e.SetupAttempts, e.NextAttemptAt, setupTxs, e.PendingSetupTx, txNonce, e.EffectiveGasPrice, e.BlockTime,
		e.ExecutedTo, e.ExecutedValue)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var n int
		if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM shared_executions WHERE proposal_id=$1`, e.ProposalID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return store.ErrNotFound
		}
		return store.ErrConflict
	}
	return nil
}

func (r *sharedRepo) RecordGasTransfer(ctx context.Context, t *store.GasTransfer) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO gas_service_transfers
		(chain_id, tx_hash, address, direction, kind, counterparty, value_wei, gas_used, gas_price_wei, fee_wei, success, block_number, block_time, proposal_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (chain_id, tx_hash) DO UPDATE SET
			proposal_id = COALESCE(gas_service_transfers.proposal_id, EXCLUDED.proposal_id),
			kind = CASE WHEN gas_service_transfers.kind = 'other' THEN EXCLUDED.kind ELSE gas_service_transfers.kind END`,
		t.ChainID, t.TxHash, t.Address, t.Direction, t.Kind, t.Counterparty, t.ValueWei, int64(t.GasUsed), t.GasPriceWei, t.FeeWei,
		t.Success, int64(t.BlockNumber), t.BlockTime, t.ProposalID)
	return err
}

func (r *sharedRepo) ListGasTransfers(ctx context.Context, chainID int64, address string, limit int) ([]*store.GasTransfer, error) {
	if limit <= 0 {
		limit = 1000
	}
	rows, err := r.pool.Query(ctx, `SELECT chain_id, tx_hash, address, direction, kind, counterparty, value_wei, gas_used, gas_price_wei, fee_wei,
		success, block_number, block_time, proposal_id, created_at
		FROM gas_service_transfers WHERE chain_id=$1 AND lower(address)=lower($2) ORDER BY block_number DESC, tx_hash LIMIT $3`, chainID, address, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.GasTransfer
	for rows.Next() {
		var t store.GasTransfer
		var gas, block int64
		if err := rows.Scan(&t.ChainID, &t.TxHash, &t.Address, &t.Direction, &t.Kind, &t.Counterparty, &t.ValueWei, &gas, &t.GasPriceWei, &t.FeeWei,
			&t.Success, &block, &t.BlockTime, &t.ProposalID, &t.CreatedAt); err != nil {
			return nil, err
		}
		t.GasUsed, t.BlockNumber = uint64(gas), uint64(block)
		out = append(out, &t)
	}
	return out, rows.Err()
}
