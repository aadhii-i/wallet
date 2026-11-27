package postgres

import (
	"context"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/store"
)

// sharedRepo implements store.SharedWallets. Lock order, everywhere:
// invitation → wallet → proposal → member. Membership changes take the
// wallet row FOR UPDATE; votes and proposal creation take it FOR SHARE, so a
// revocation waits for in-flight votes and no vote observes a half-applied
// membership change.
type sharedRepo struct{ pool *pgxpool.Pool }

func withTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func uuidStrings(ids []uuid.UUID) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	return out
}

func parseUUIDs(ss []string) ([]uuid.UUID, error) {
	out := make([]uuid.UUID, len(ss))
	for i, s := range ss {
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, err
		}
		out[i] = id
	}
	return out, nil
}

// ---- wallets ---------------------------------------------------------------

const sharedWalletCols = `id, name, created_by, policy_version, policy_numerator, policy_denominator, policy_rounding, membership_version, key_status, key_generation_id, key_fingerprint, created_at, native_custody_locked`

func scanSharedWallet(row pgx.Row) (*store.SharedWallet, error) {
	var w store.SharedWallet
	var ks string
	if err := row.Scan(&w.ID, &w.Name, &w.CreatedBy, &w.PolicyVersion, &w.PolicyNumerator, &w.PolicyDenominator, &w.PolicyRounding, &w.MembershipVersion, &ks, &w.KeyGenerationID, &w.KeyFingerprint, &w.CreatedAt, &w.NativeCustodyLocked); err != nil {
		return nil, mapNotFound(err)
	}
	w.KeyStatus = store.KeyStatus(ks)
	return &w, nil
}

func (r *sharedRepo) CreateWallet(ctx context.Context, w *store.SharedWallet, owner *store.SharedMember) error {
	return withTx(ctx, r.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO shared_wallets (`+sharedWalletCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			w.ID, w.Name, w.CreatedBy, w.PolicyVersion, w.PolicyNumerator, w.PolicyDenominator, w.PolicyRounding, w.MembershipVersion, string(w.KeyStatus), w.KeyGenerationID, w.KeyFingerprint, w.CreatedAt, w.NativeCustodyLocked); err != nil {
			return mapConflict(err)
		}
		return insertMember(ctx, tx, owner)
	})
}

func (r *sharedRepo) GetWallet(ctx context.Context, id uuid.UUID) (*store.SharedWallet, error) {
	return scanSharedWallet(r.pool.QueryRow(ctx, `SELECT `+sharedWalletCols+` FROM shared_wallets WHERE id=$1`, id))
}

func (r *sharedRepo) LockNativeCustody(ctx context.Context, walletID uuid.UUID, version int64) error {
	tag, err := r.pool.Exec(ctx, `UPDATE shared_wallets SET native_custody_locked=true WHERE id=$1 AND membership_version=$2`, walletID, version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return store.ErrStale
	}
	return nil
}

func (r *sharedRepo) ListWalletsForUser(ctx context.Context, userID uuid.UUID) ([]*store.SharedWallet, error) {
	rows, err := r.pool.Query(ctx, `SELECT w.id, w.name, w.created_by, w.policy_version, w.policy_numerator, w.policy_denominator, w.policy_rounding, w.membership_version, w.key_status, w.key_generation_id, w.key_fingerprint, w.created_at, w.native_custody_locked
		FROM shared_wallets w JOIN shared_wallet_members m ON m.wallet_id = w.id
		WHERE m.user_id=$1 AND m.status='active' ORDER BY w.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.SharedWallet
	for rows.Next() {
		w, err := scanSharedWallet(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// membershipChanged bumps the version, flags a rekey and supersedes open
// proposals. The caller must hold the wallet row FOR UPDATE.
func membershipChanged(ctx context.Context, tx pgx.Tx, walletID uuid.UUID, now time.Time) (*store.SharedWallet, error) {
	// Proposals that already hold a verified signature were fully authorised
	// before the change and keep going to execution.
	if _, err := tx.Exec(ctx, `UPDATE proposals p SET status='superseded', decided_at=$2
		WHERE p.wallet_id=$1 AND p.status IN ('pending','approved')
		AND NOT EXISTS (SELECT 1 FROM shared_signing_sessions s WHERE s.proposal_id=p.id AND s.status='complete')`, walletID, now); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE shared_signing_sessions SET status='failed', failure_reason=$2, ended_at=$3
		WHERE wallet_id=$1 AND status IN ('round1','round2','round3','combining')`,
		walletID, store.SigningFailMembershipChanged, now); err != nil {
		return nil, err
	}
	// A ceremony snapshot for the old membership can never produce a usable key.
	if _, err := tx.Exec(ctx, `UPDATE shared_key_generations SET status='failed', failure_reason=$2, ended_at=$3
		WHERE wallet_id=$1 AND status IN ('collecting_keys','dealing','awaiting_provisioning')`,
		walletID, store.KeygenFailMembershipChanged, now); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE shared_key_generation_participants p SET envelope_enc=NULL, envelope_ct=NULL
		FROM shared_key_generations k WHERE p.keygen_id=k.id AND k.wallet_id=$1 AND p.envelope_ct IS NOT NULL`, walletID); err != nil {
		return nil, err
	}
	return scanSharedWallet(tx.QueryRow(ctx, `UPDATE shared_wallets SET membership_version = membership_version + 1,
		key_status = CASE WHEN key_status='active' THEN 'rekey_required' ELSE key_status END
		WHERE id=$1 RETURNING `+sharedWalletCols, walletID))
}

// ---- members ---------------------------------------------------------------

const memberCols = `id, wallet_id, user_id, device_id, device_public_key, display_name, role, status, invited_by, joined_at, revoked_at, revoked_by`

func scanMember(row pgx.Row) (*store.SharedMember, error) {
	var m store.SharedMember
	var role, status string
	if err := row.Scan(&m.ID, &m.WalletID, &m.UserID, &m.DeviceID, &m.DevicePublicKey, &m.DisplayName, &role, &status, &m.InvitedBy, &m.JoinedAt, &m.RevokedAt, &m.RevokedBy); err != nil {
		return nil, mapNotFound(err)
	}
	m.Role, m.Status = store.MemberRole(role), store.MemberStatus(status)
	return &m, nil
}

func insertMember(ctx context.Context, tx pgx.Tx, m *store.SharedMember) error {
	_, err := tx.Exec(ctx, `INSERT INTO shared_wallet_members (`+memberCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		m.ID, m.WalletID, m.UserID, m.DeviceID, m.DevicePublicKey, m.DisplayName, string(m.Role), string(m.Status), m.InvitedBy, m.JoinedAt, m.RevokedAt, m.RevokedBy)
	return mapConflict(err)
}

func (r *sharedRepo) ListMembers(ctx context.Context, walletID uuid.UUID) ([]*store.SharedMember, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+memberCols+` FROM shared_wallet_members WHERE wallet_id=$1 ORDER BY joined_at, id`, walletID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.SharedMember
	for rows.Next() {
		m, err := scanMember(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (r *sharedRepo) GetActiveMemberByUser(ctx context.Context, walletID, userID uuid.UUID) (*store.SharedMember, error) {
	return scanMember(r.pool.QueryRow(ctx, `SELECT `+memberCols+` FROM shared_wallet_members WHERE wallet_id=$1 AND user_id=$2 AND status='active'`, walletID, userID))
}

func (r *sharedRepo) RevokeMember(ctx context.Context, walletID, memberID, revokedBy uuid.UUID, now time.Time) (*store.SharedWallet, error) {
	var out *store.SharedWallet
	err := withTx(ctx, r.pool, func(tx pgx.Tx) error {
		wallet, err := scanSharedWallet(tx.QueryRow(ctx, `SELECT `+sharedWalletCols+` FROM shared_wallets WHERE id=$1 FOR UPDATE`, walletID))
		if err != nil {
			return err
		}
		if wallet.NativeCustodyLocked {
			return store.ErrNativeMigrationRequired
		}
		var status string
		if err := tx.QueryRow(ctx, `SELECT status FROM shared_wallet_members WHERE id=$1 AND wallet_id=$2 FOR UPDATE`, memberID, walletID).Scan(&status); err != nil {
			return mapNotFound(err)
		}
		if status == string(store.MemberRevoked) {
			return store.ErrConflict
		}
		if _, err := tx.Exec(ctx, `UPDATE shared_wallet_members SET status='revoked', revoked_at=$2, revoked_by=$3 WHERE id=$1`, memberID, now, revokedBy); err != nil {
			return err
		}
		w, err := membershipChanged(ctx, tx, walletID, now)
		out = w
		return err
	})
	return out, err
}

// ---- invitations -------------------------------------------------------------

const invitationCols = `id, wallet_id, code_hash, label, invited_by, status, expires_at, created_at, resolved_at, resolved_by, member_id`

func scanInvitation(row pgx.Row) (*store.SharedInvitation, error) {
	var i store.SharedInvitation
	var status string
	if err := row.Scan(&i.ID, &i.WalletID, &i.CodeHash, &i.Label, &i.InvitedBy, &status, &i.ExpiresAt, &i.CreatedAt, &i.ResolvedAt, &i.ResolvedBy, &i.MemberID); err != nil {
		return nil, mapNotFound(err)
	}
	i.Status = store.InvitationStatus(status)
	return &i, nil
}

func (r *sharedRepo) CreateInvitation(ctx context.Context, inv *store.SharedInvitation, maxOpen int) error {
	return withTx(ctx, r.pool, func(tx pgx.Tx) error {
		wallet, err := scanSharedWallet(tx.QueryRow(ctx, `SELECT `+sharedWalletCols+` FROM shared_wallets WHERE id=$1 FOR UPDATE`, inv.WalletID))
		if err != nil {
			return err
		}
		if wallet.NativeCustodyLocked {
			return store.ErrNativeMigrationRequired
		}
		var open int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM shared_wallet_invitations WHERE wallet_id=$1 AND status='invited' AND expires_at > $2`, inv.WalletID, inv.CreatedAt).Scan(&open); err != nil {
			return err
		}
		if open >= maxOpen {
			return store.ErrLimit
		}
		_, err = tx.Exec(ctx, `INSERT INTO shared_wallet_invitations (`+invitationCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			inv.ID, inv.WalletID, inv.CodeHash, inv.Label, inv.InvitedBy, string(inv.Status), inv.ExpiresAt, inv.CreatedAt, inv.ResolvedAt, inv.ResolvedBy, inv.MemberID)
		return mapConflict(err)
	})
}

func (r *sharedRepo) ListInvitations(ctx context.Context, walletID uuid.UUID) ([]*store.SharedInvitation, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+invitationCols+` FROM shared_wallet_invitations WHERE wallet_id=$1 ORDER BY created_at`, walletID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.SharedInvitation
	for rows.Next() {
		i, err := scanInvitation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (r *sharedRepo) GetInvitationByCodeHash(ctx context.Context, h []byte) (*store.SharedInvitation, error) {
	return scanInvitation(r.pool.QueryRow(ctx, `SELECT `+invitationCols+` FROM shared_wallet_invitations WHERE code_hash=$1`, h))
}

func (r *sharedRepo) AcceptInvitation(ctx context.Context, h []byte, member *store.SharedMember, maxMembers int, now time.Time) (*store.SharedWallet, error) {
	var out *store.SharedWallet
	err := withTx(ctx, r.pool, func(tx pgx.Tx) error {
		inv, err := scanInvitation(tx.QueryRow(ctx, `SELECT `+invitationCols+` FROM shared_wallet_invitations WHERE code_hash=$1 FOR UPDATE`, h))
		if err != nil || inv.Status != store.InvitationInvited || !now.Before(inv.ExpiresAt) {
			return store.ErrInvitationInvalid
		}
		wallet, err := scanSharedWallet(tx.QueryRow(ctx, `SELECT `+sharedWalletCols+` FROM shared_wallets WHERE id=$1 FOR UPDATE`, inv.WalletID))
		if err != nil {
			return err
		}
		if wallet.NativeCustodyLocked {
			return store.ErrNativeMigrationRequired
		}
		var active int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM shared_wallet_members WHERE wallet_id=$1 AND status='active'`, inv.WalletID).Scan(&active); err != nil {
			return err
		}
		if active >= maxMembers {
			return store.ErrLimit
		}
		m := *member
		m.WalletID = inv.WalletID
		inviter := inv.InvitedBy
		m.InvitedBy = &inviter
		if err := insertMember(ctx, tx, &m); err != nil {
			return err // ErrConflict: already a member (partial unique index)
		}
		if _, err := tx.Exec(ctx, `UPDATE shared_wallet_invitations SET status='accepted', resolved_at=$2, resolved_by=$3, member_id=$4 WHERE id=$1`,
			inv.ID, now, member.UserID, m.ID); err != nil {
			return err
		}
		w, err := membershipChanged(ctx, tx, inv.WalletID, now)
		out = w
		return err
	})
	return out, err
}

func (r *sharedRepo) RejectInvitation(ctx context.Context, h []byte, userID uuid.UUID, now time.Time) error {
	tag, err := r.pool.Exec(ctx, `UPDATE shared_wallet_invitations SET status='rejected', resolved_at=$2, resolved_by=$3
		WHERE code_hash=$1 AND status='invited' AND expires_at > $2`, h, now, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrInvitationInvalid
	}
	return nil
}

func (r *sharedRepo) RevokeInvitation(ctx context.Context, walletID, invitationID uuid.UUID, now time.Time) error {
	tag, err := r.pool.Exec(ctx, `UPDATE shared_wallet_invitations SET status='revoked', resolved_at=$3
		WHERE id=$1 AND wallet_id=$2 AND status='invited'`, invitationID, walletID, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		_ = r.pool.QueryRow(ctx, `SELECT true FROM shared_wallet_invitations WHERE id=$1 AND wallet_id=$2`, invitationID, walletID).Scan(&exists)
		if !exists {
			return store.ErrNotFound
		}
		return store.ErrInvitationInvalid
	}
	return nil
}

// ---- accounts ----------------------------------------------------------------

const sharedAccountCols = `id, wallet_id, name, derivation_index, created_by, created_at`

func scanSharedAccount(row pgx.Row) (*store.SharedAccount, error) {
	var a store.SharedAccount
	if err := row.Scan(&a.ID, &a.WalletID, &a.Name, &a.DerivationIndex, &a.CreatedBy, &a.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	return &a, nil
}

func (r *sharedRepo) CreateAccount(ctx context.Context, a *store.SharedAccount) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO shared_accounts (`+sharedAccountCols+`) VALUES ($1,$2,$3,$4,$5,$6)`,
		a.ID, a.WalletID, a.Name, a.DerivationIndex, a.CreatedBy, a.CreatedAt)
	return mapConflict(err)
}

func (r *sharedRepo) ListAccounts(ctx context.Context, walletID uuid.UUID) ([]*store.SharedAccount, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+sharedAccountCols+` FROM shared_accounts WHERE wallet_id=$1 ORDER BY derivation_index`, walletID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.SharedAccount
	for rows.Next() {
		a, err := scanSharedAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *sharedRepo) GetAccount(ctx context.Context, walletID, accountID uuid.UUID) (*store.SharedAccount, error) {
	return scanSharedAccount(r.pool.QueryRow(ctx, `SELECT `+sharedAccountCols+` FROM shared_accounts WHERE id=$1 AND wallet_id=$2`, accountID, walletID))
}

// ---- proposals ---------------------------------------------------------------

const proposalCols = `id, wallet_id, account_id, derivation_index, initiator_member_id, chain_id, to_address,
	value_wei::text, data, nonce::text, gas_limit::text, max_fee_per_gas::text, max_priority_fee_per_gas::text,
	policy_version, policy_numerator, policy_denominator, policy_rounding, membership_version, participant_count,
	required_approvals, eligible_member_ids::text[], digest, status, expires_at, created_at, decided_at`

func scanProposal(row pgx.Row) (*store.Proposal, error) {
	var p store.Proposal
	var nonce, gas, status string
	var eligible []string
	if err := row.Scan(&p.ID, &p.WalletID, &p.AccountID, &p.DerivationIndex, &p.InitiatorMemberID, &p.ChainID, &p.To,
		&p.ValueWei, &p.Data, &nonce, &gas, &p.MaxFeePerGas, &p.MaxPriorityFeePerGas,
		&p.PolicyVersion, &p.PolicyNumerator, &p.PolicyDenominator, &p.PolicyRounding, &p.MembershipVersion, &p.ParticipantCount,
		&p.RequiredApprovals, &eligible, &p.Digest, &status, &p.ExpiresAt, &p.CreatedAt, &p.DecidedAt); err != nil {
		return nil, mapNotFound(err)
	}
	var err error
	if p.Nonce, err = strconv.ParseUint(nonce, 10, 64); err != nil {
		return nil, err
	}
	if p.GasLimit, err = strconv.ParseUint(gas, 10, 64); err != nil {
		return nil, err
	}
	if p.EligibleMemberIDs, err = parseUUIDs(eligible); err != nil {
		return nil, err
	}
	p.Status = store.ProposalStatus(status)
	return &p, nil
}

func (r *sharedRepo) CreateProposal(ctx context.Context, p *store.Proposal) error {
	return withTx(ctx, r.pool, func(tx pgx.Tx) error {
		var version int64
		if err := tx.QueryRow(ctx, `SELECT membership_version FROM shared_wallets WHERE id=$1 FOR SHARE`, p.WalletID).Scan(&version); err != nil {
			return mapNotFound(err)
		}
		if version != p.MembershipVersion {
			return store.ErrStale
		}
		_, err := tx.Exec(ctx, `INSERT INTO proposals (id, wallet_id, account_id, derivation_index, initiator_member_id, chain_id, to_address,
			value_wei, data, nonce, gas_limit, max_fee_per_gas, max_priority_fee_per_gas,
			policy_version, policy_numerator, policy_denominator, policy_rounding, membership_version, participant_count,
			required_approvals, eligible_member_ids, digest, status, expires_at, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10::numeric,$11::numeric,$12::numeric,$13::numeric,$14,$15,$16,$17,$18,$19,$20,$21::uuid[],$22,$23,$24,$25)`,
			p.ID, p.WalletID, p.AccountID, p.DerivationIndex, p.InitiatorMemberID, p.ChainID, p.To,
			p.ValueWei, p.Data, strconv.FormatUint(p.Nonce, 10), strconv.FormatUint(p.GasLimit, 10), p.MaxFeePerGas, p.MaxPriorityFeePerGas,
			p.PolicyVersion, p.PolicyNumerator, p.PolicyDenominator, p.PolicyRounding, p.MembershipVersion, p.ParticipantCount,
			p.RequiredApprovals, uuidStrings(p.EligibleMemberIDs), p.Digest, string(p.Status), p.ExpiresAt, p.CreatedAt)
		return mapConflict(err)
	})
}

func (r *sharedRepo) GetProposal(ctx context.Context, id uuid.UUID) (*store.Proposal, error) {
	return scanProposal(r.pool.QueryRow(ctx, `SELECT `+proposalCols+` FROM proposals WHERE id=$1`, id))
}

func (r *sharedRepo) ListProposals(ctx context.Context, walletID uuid.UUID) ([]*store.Proposal, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+proposalCols+` FROM proposals WHERE wallet_id=$1 ORDER BY created_at DESC`, walletID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Proposal
	for rows.Next() {
		p, err := scanProposal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (r *sharedRepo) ExpireProposal(ctx context.Context, id uuid.UUID, now time.Time) error {
	_, err := r.pool.Exec(ctx, `UPDATE proposals SET status='expired', decided_at=$2 WHERE id=$1 AND status='pending' AND expires_at <= $2`, id, now)
	return err
}

// ---- votes -------------------------------------------------------------------

func (r *sharedRepo) CreateVoteNonce(ctx context.Context, n *store.VoteNonce) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO proposal_vote_nonces (nonce, proposal_id, member_id, expires_at, used_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		n.Nonce, n.ProposalID, n.MemberID, n.ExpiresAt, n.UsedAt, n.CreatedAt)
	return mapConflict(err)
}

func (r *sharedRepo) CastVote(ctx context.Context, v *store.Vote, now time.Time, decide store.DecideFunc) (*store.Proposal, error) {
	// Spend the nonce in its own statement first, so it stays spent even if
	// the vote is refused below: a nonce can never be used twice.
	tag, err := r.pool.Exec(ctx, `UPDATE proposal_vote_nonces SET used_at=$4
		WHERE nonce=$1 AND proposal_id=$2 AND member_id=$3 AND used_at IS NULL AND expires_at > $4`, v.Nonce, v.ProposalID, v.MemberID, now)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, store.ErrNonceInvalid
	}

	var walletID uuid.UUID
	if err := r.pool.QueryRow(ctx, `SELECT wallet_id FROM proposals WHERE id=$1`, v.ProposalID).Scan(&walletID); err != nil {
		return nil, mapNotFound(err)
	}

	var out *store.Proposal
	var closedErr error
	err = withTx(ctx, r.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM shared_wallets WHERE id=$1 FOR SHARE`, walletID); err != nil {
			return err
		}
		p, err := scanProposal(tx.QueryRow(ctx, `SELECT `+proposalCols+` FROM proposals WHERE id=$1 FOR UPDATE`, v.ProposalID))
		if err != nil {
			return err
		}
		if p.Status == store.ProposalPending && !now.Before(p.ExpiresAt) {
			if _, err := tx.Exec(ctx, `UPDATE proposals SET status='expired', decided_at=$2 WHERE id=$1`, p.ID, now); err != nil {
				return err
			}
			closedErr = store.ErrProposalClosed
			return nil // commit the expiry, then report the closed proposal
		}
		if p.Status != store.ProposalPending {
			return store.ErrProposalClosed
		}
		var memberWallet uuid.UUID
		var memberStatus string
		if err := tx.QueryRow(ctx, `SELECT wallet_id, status FROM shared_wallet_members WHERE id=$1 FOR SHARE`, v.MemberID).Scan(&memberWallet, &memberStatus); err != nil {
			return store.ErrNotEligible
		}
		eligible := false
		for _, id := range p.EligibleMemberIDs {
			if id == v.MemberID {
				eligible = true
			}
		}
		if memberWallet != p.WalletID || memberStatus != string(store.MemberActive) || !eligible {
			return store.ErrNotEligible
		}
		if _, err := tx.Exec(ctx, `INSERT INTO proposal_votes (id, proposal_id, member_id, decision, nonce, issued_at, signature, digest, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, v.ID, v.ProposalID, v.MemberID, string(v.Decision), v.Nonce, v.IssuedAt, v.Signature, v.Digest, v.CreatedAt); err != nil {
			return mapConflict(err) // UNIQUE (proposal_id, member_id): duplicate vote
		}
		rows, err := tx.Query(ctx, `SELECT member_id, decision FROM proposal_votes WHERE proposal_id=$1 ORDER BY seq`, p.ID)
		if err != nil {
			return err
		}
		approvals, rejections := 0, 0
		var approvers []string
		for rows.Next() {
			var mid uuid.UUID
			var d string
			if err := rows.Scan(&mid, &d); err != nil {
				rows.Close()
				return err
			}
			if d == string(store.VoteApprove) {
				approvals++
				approvers = append(approvers, mid.String())
			} else {
				rejections++
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		status, err := decide(p, approvals, rejections)
		if err != nil {
			return err
		}
		if status != p.Status {
			if _, err := tx.Exec(ctx, `UPDATE proposals SET status=$2, decided_at=$3 WHERE id=$1`, p.ID, string(status), now); err != nil {
				return err
			}
			p.Status = status
			t := now
			p.DecidedAt = &t
		}
		if status == store.ProposalApproved {
			if _, err := tx.Exec(ctx, `INSERT INTO signing_jobs (id, proposal_id, status, signers, created_at) VALUES ($1,$2,$3,$4::uuid[],$5)
				ON CONFLICT (proposal_id) DO NOTHING`, uuid.New(), p.ID, string(store.SigningAwaitingKey), approvers[:p.RequiredApprovals], now); err != nil {
				return err
			}
		}
		out = p
		return nil
	})
	if err != nil {
		return nil, err
	}
	if closedErr != nil {
		return nil, closedErr
	}
	return out, nil
}

func (r *sharedRepo) ListVotes(ctx context.Context, proposalID uuid.UUID) ([]*store.Vote, error) {
	rows, err := r.pool.Query(ctx, `SELECT id, proposal_id, member_id, decision, nonce, issued_at, signature, digest, created_at
		FROM proposal_votes WHERE proposal_id=$1 ORDER BY seq`, proposalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Vote
	for rows.Next() {
		var v store.Vote
		var d string
		if err := rows.Scan(&v.ID, &v.ProposalID, &v.MemberID, &d, &v.Nonce, &v.IssuedAt, &v.Signature, &v.Digest, &v.CreatedAt); err != nil {
			return nil, err
		}
		v.Decision = store.VoteDecision(d)
		out = append(out, &v)
	}
	return out, rows.Err()
}

func (r *sharedRepo) GetSigningJob(ctx context.Context, proposalID uuid.UUID) (*store.SigningJob, error) {
	var j store.SigningJob
	var status string
	var signers []string
	if err := r.pool.QueryRow(ctx, `SELECT id, proposal_id, status, signers::text[], created_at FROM signing_jobs WHERE proposal_id=$1`, proposalID).
		Scan(&j.ID, &j.ProposalID, &status, &signers, &j.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	j.Status = store.SigningJobStatus(status)
	var err error
	j.Signers, err = parseUUIDs(signers)
	return &j, err
}

var _ store.SharedWallets = (*sharedRepo)(nil)
