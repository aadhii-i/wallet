package sharedwallet

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/qdraccoon"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Networked Threshold Raccoon signing (QD-Wallet Alg. 4, TRaccoon ShareSign
// 1–3) for an approved proposal, coordinated by this service:
//
//  1. Each shared account has a public key pk_j (derivation index j of the
//     wallet's key). A participant's key worker derives it from its share and
//     registers it with a device signature; others attest the same value.
//     The QdAccount address is a pure function of pk_j.
//  2. When a proposal is approved and the wallet key matches its snapshot, a
//     selected signer starts a session: fresh random 32-byte sid, active set =
//     the signers' party indices, message = QdAccount.executionMessage of the
//     proposal's call. The parameters are frozen in a session header.
//  3. Each round, every signer's key worker computes its message from its own
//     share; the device signs it together with the hash of the transcript so
//     far, and the service relays it. Round 2 openings are checked against
//     round 1 commitments here as well as by every signer.
//  4. After round 3 the service combines the public transcript into one
//     signature and verifies it (internal/qdraccoon) before recording it.
//
// The service never holds a share, a seed or the chain code.

const (
	signingSessionTTL  = 10 * time.Minute
	maxSigningAttempts = 5
	// Signatures must leave time to reach the chain before the proposal (and
	// therefore the on-chain validUntil) expires.
	minExecutionWindow = 2 * time.Minute
)

var (
	ErrNotSigner             = errors.New("sharedwallet: this participant is not a selected signer")
	ErrSigningNotReady       = errors.New("sharedwallet: signing cannot start: the wallet key or account key is not ready for this proposal")
	ErrSigningClosed         = errors.New("sharedwallet: signing session is not at this round (or expired)")
	ErrAlreadySigned         = errors.New("sharedwallet: proposal already has a verified signature")
	ErrSessionOpen           = errors.New("sharedwallet: a signing session is already open")
	ErrAccountKeyMismatch    = errors.New("sharedwallet: account public key differs from the one already registered")
	ErrTranscriptMismatch    = errors.New("sharedwallet: signed transcript hash does not match this session")
	ErrBadRoundPayload       = errors.New("sharedwallet: malformed round message")
	ErrTooManyAttempts       = errors.New("sharedwallet: signing attempt limit reached; create a new proposal")
	ErrProposalTooLate       = errors.New("sharedwallet: proposal expires too soon to sign and execute")
	ErrInvalidAbortReason    = errors.New("sharedwallet: invalid abort reason")
	ErrDuplicateRoundMessage = errors.New("sharedwallet: this signer already sent its message for this round")
	signingAbortReasons      = map[string]bool{
		store.SigningFailCancelled: true, store.SigningFailParticipantAbort: true, store.SigningFailStateLost: true,
	}
)

func mapSigningErr(err error) error {
	switch {
	case errors.Is(err, store.ErrSigningClosed):
		return ErrSigningClosed
	case errors.Is(err, store.ErrAlreadySigned):
		return ErrAlreadySigned
	case errors.Is(err, store.ErrConflict):
		return ErrSessionOpen
	case errors.Is(err, store.ErrNotEligible):
		return ErrNotSigner
	case errors.Is(err, store.ErrMismatch):
		return ErrAccountKeyMismatch
	case errors.Is(err, store.ErrStale):
		return ErrSigningNotReady
	case errors.Is(err, store.ErrProposalClosed):
		return ErrClosed
	}
	return mapStoreErr(err)
}

// ---- canonical messages (mirrored in packages/rpc/src/shared-signing.ts) ---------

func AccountKeyMessage(walletID, accountID uuid.UUID, derivationIndex int64, keygenID uuid.UUID, pkHash []byte, address string) []byte {
	return []byte(strings.Join([]string{
		"QDWallet-AccountKey", "v1", walletID.String(), accountID.String(), strconv.FormatInt(derivationIndex, 10),
		keygenID.String(), hex.EncodeToString(pkHash), address,
	}, "|"))
}

func joinInts(xs []int) string {
	s := make([]string, len(xs))
	for i, x := range xs {
		s[i] = strconv.Itoa(x)
	}
	return strings.Join(s, ",")
}

// SessionHeader freezes every parameter of a signing session; its SHA-256
// starts the transcript that each round message signs.
func SessionHeader(ss *store.SigningSession, proposalDigest []byte) []byte {
	return []byte(strings.Join([]string{
		"QDWallet-SignSession", "v1", ss.ID.String(), ss.WalletID.String(), ss.ProposalID.String(),
		hex.EncodeToString(proposalDigest), ss.KeygenID.String(), strconv.FormatInt(ss.MembershipVersion, 10),
		strconv.Itoa(ss.Threshold), strconv.Itoa(ss.Parties), joinInts(ss.Act), strings.Join(uuidStrs(ss.SignerMemberIDs), ","),
		strconv.FormatInt(ss.DerivationIndex, 10), strconv.FormatInt(ss.ChainID, 10), ss.AccountAddress,
		hex.EncodeToString(ss.PublicKeyHash), hex.EncodeToString(ss.Message), hex.EncodeToString(ss.SID),
		strconv.FormatInt(ss.ExpiresAt.Unix(), 10),
	}, "|"))
}

func uuidStrs(ids []uuid.UUID) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	return out
}

// TranscriptHash is what a round-r message commits to: the session header
// and every message of rounds before r, as "round:party:sha256(payload)".
func TranscriptHash(ss *store.SigningSession, proposalDigest []byte, msgs []*store.SigningMessage, round int) []byte {
	var lines []string
	sorted := append([]*store.SigningMessage(nil), msgs...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Round != sorted[j].Round {
			return sorted[i].Round < sorted[j].Round
		}
		return sorted[i].PartyIndex < sorted[j].PartyIndex
	})
	for _, m := range sorted {
		if m.Round < round {
			lines = append(lines, fmt.Sprintf("%d:%d:%s", m.Round, m.PartyIndex, sha256Hex(m.Payload)))
		}
	}
	h := sha256.Sum256([]byte("QDWallet-SignTranscript|v1|" + sha256Hex(SessionHeader(ss, proposalDigest)) + "|" + strings.Join(lines, ";")))
	return h[:]
}

func SignRoundMessage(ss *store.SigningSession, round, partyIndex int, memberID uuid.UUID, transcript, payload []byte) []byte {
	return []byte(strings.Join([]string{
		"QDWallet-SignRound", "v1", ss.ID.String(), strconv.Itoa(round), strconv.Itoa(partyIndex), memberID.String(),
		hex.EncodeToString(transcript), sha256Hex(payload),
	}, "|"))
}

func SignAbortMessage(ss *store.SigningSession, memberID uuid.UUID, reason string) []byte {
	return []byte(strings.Join([]string{"QDWallet-SignAbort", "v1", ss.ID.String(), memberID.String(), reason}, "|"))
}

// ProposalCall is the QdAccount call an approved proposal authorises.
func ProposalCall(p *store.Proposal) (*qdaccount.Call, error) {
	value, ok := new(big.Int).SetString(p.ValueWei, 10)
	if !ok {
		return nil, fmt.Errorf("%w: bad value", ErrInvalid)
	}
	var digest [32]byte
	copy(digest[:], p.Digest)
	return &qdaccount.Call{
		Nonce: new(big.Int).SetUint64(p.Nonce), To: common.HexToAddress(p.To), Value: value,
		Data: common.FromHex(p.Data), CallGasLimit: new(big.Int).SetUint64(p.GasLimit),
		ValidUntil: big.NewInt(p.ExpiresAt.Unix()), ProposalDigest: digest,
	}, nil
}

// ---- account keys ------------------------------------------------------------------

func (s *Service) activeKeygen(ctx context.Context, w *store.SharedWallet) (*store.KeyGeneration, []*store.KeygenParticipant, error) {
	if w.KeyStatus != store.KeyActive || w.KeyGenerationID == nil {
		return nil, nil, ErrSigningNotReady
	}
	kg, parts, err := s.store.SharedWallets().GetKeyGeneration(ctx, *w.KeyGenerationID)
	if err != nil || kg.Status != store.KeygenComplete {
		return nil, nil, ErrSigningNotReady
	}
	return kg, parts, nil
}

// RegisterAccountKey records (or attests) pk_j for an account under the
// wallet's active key, as computed by the caller's key worker.
func (s *Service) RegisterAccountKey(ctx context.Context, p *auth.Principal, walletID, accountID uuid.UUID, pkB64, sigB64 string) (*store.AccountKey, error) {
	w, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return nil, err
	}
	if me.DeviceID != p.DeviceID {
		return nil, ErrWrongDevice
	}
	acct, err := s.store.SharedWallets().GetAccount(ctx, walletID, accountID)
	if err != nil {
		return nil, ErrNotFound
	}
	kg, parts, err := s.activeKeygen(ctx, w)
	if err != nil {
		return nil, err
	}
	inKey := false
	for _, pt := range parts {
		inKey = inKey || pt.MemberID == me.ID
	}
	if !inKey {
		return nil, ErrNotInKeyGeneration
	}
	pkBytes, err := b64.DecodeString(pkB64)
	if err != nil {
		return nil, fmt.Errorf("%w: publicKey must be base64url", ErrInvalid)
	}
	pk, err := qdraccoon.DecodePublicKey(pkBytes)
	if err != nil {
		return nil, fmt.Errorf("%w: malformed account public key", ErrInvalid)
	}
	h := qdraccoon.PublicKeyHash(pk)
	address := strings.ToLower(qdaccount.AccountAddress(h).Hex())
	sig, err := verifyDevice(me, AccountKeyMessage(walletID, accountID, acct.DerivationIndex, kg.ID, h[:], address), sigB64)
	if err != nil {
		return nil, err
	}
	now := s.now()
	k, err := s.store.SharedWallets().PutAccountKey(ctx, &store.AccountKey{
		AccountID: accountID, WalletID: walletID, KeygenID: kg.ID, DerivationIndex: acct.DerivationIndex,
		PublicKey: pkBytes, PublicKeyHash: h[:], Address: address, CreatedAt: now,
	}, store.AccountKeyAttestation{MemberID: me.ID, Signature: sig, At: now})
	if err != nil {
		if errors.Is(err, store.ErrMismatch) {
			s.record(ctx, p.UserID, "shared_wallet.account_key.mismatch", "shared_account", accountID.String(),
				map[string]any{"wallet": walletID.String(), "participant": me.ID.String(), "claimedAddress": address})
		}
		return nil, mapSigningErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.account_key.attest", "shared_account", accountID.String(), map[string]any{
		"wallet": walletID.String(), "keygen": kg.ID.String(), "address": address, "attestations": len(k.Attestations),
	})
	return k, nil
}

// accountKeys returns the active key's registered account keys by account id.
func (s *Service) accountKeys(ctx context.Context, w *store.SharedWallet, accounts []*store.SharedAccount) map[uuid.UUID]*store.AccountKey {
	out := map[uuid.UUID]*store.AccountKey{}
	if w.KeyStatus != store.KeyActive || w.KeyGenerationID == nil {
		return out
	}
	for _, a := range accounts {
		if k, err := s.store.SharedWallets().GetAccountKey(ctx, a.ID, *w.KeyGenerationID); err == nil {
			out[a.ID] = k
		}
	}
	return out
}

// ---- sessions ----------------------------------------------------------------------

// SigningView is a session as shown to a wallet participant.
type SigningView struct {
	Session    *store.SigningSession
	Messages   []*store.SigningMessage
	Header     []byte
	Transcript []byte // hash a message for the current round must sign
	Proposal   *store.Proposal
	Execution  *store.Execution
}

func randomSID() ([]byte, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return b, err
}

// StartSigning opens a signing session for an approved proposal (or returns
// the open one). Only a selected signer, from its bound device, may start it.
func (s *Service) StartSigning(ctx context.Context, p *auth.Principal, proposalID uuid.UUID) (*SigningView, error) {
	prop, me, err := s.proposalForMember(ctx, p, proposalID)
	if err != nil {
		return nil, err
	}
	if me.DeviceID != p.DeviceID {
		return nil, ErrWrongDevice
	}
	if prop.Status != store.ProposalApproved {
		return nil, ErrClosed
	}
	v, err := s.view(ctx, prop, me)
	if err != nil {
		return nil, err
	}
	if v.SigningJob == nil || !v.KeyReady {
		return nil, ErrSigningNotReady
	}
	pos := -1
	for i, id := range v.SigningJob.Signers {
		if id == me.ID {
			pos = i
		}
	}
	if pos < 0 {
		return nil, ErrNotSigner
	}
	if cur, _, err := s.store.SharedWallets().LatestSigningSession(ctx, prop.ID, s.now()); err == nil {
		if cur.Status.Open() || cur.Status == store.SigningComplete {
			return s.signingView(ctx, cur.ID, prop)
		}
		if cur.Attempt >= maxSigningAttempts {
			return nil, ErrTooManyAttempts
		}
	}
	now := s.now()
	if prop.ExpiresAt.Sub(now) < minExecutionWindow {
		return nil, ErrProposalTooLate
	}
	w, err := s.store.SharedWallets().GetWallet(ctx, prop.WalletID)
	if err != nil {
		return nil, err
	}
	kg, parts, err := s.activeKeygen(ctx, w)
	if err != nil {
		return nil, err
	}
	key, err := s.store.SharedWallets().GetAccountKey(ctx, prop.AccountID, kg.ID)
	if err != nil {
		return nil, ErrSigningNotReady
	}
	byMember := map[uuid.UUID]int{}
	for _, pt := range parts {
		byMember[pt.MemberID] = pt.PartyIndex
	}
	type signer struct {
		idx int
		id  uuid.UUID
	}
	signers := make([]signer, 0, len(v.SigningJob.Signers))
	for _, id := range v.SigningJob.Signers {
		signers = append(signers, signer{byMember[id], id})
	}
	sort.Slice(signers, func(i, j int) bool { return signers[i].idx < signers[j].idx })
	act := make([]int, len(signers))
	ids := make([]uuid.UUID, len(signers))
	for i, sg := range signers {
		act[i], ids[i] = sg.idx, sg.id
	}
	if !qdraccoon.ValidAct(act, kg.Threshold, kg.Parties) {
		return nil, ErrSigningNotReady
	}
	call, err := ProposalCall(prop)
	if err != nil {
		return nil, err
	}
	msg := qdaccount.ExecutionMessage(big.NewInt(prop.ChainID), common.HexToAddress(key.Address), call)
	sid, err := randomSID()
	if err != nil {
		return nil, err
	}
	expires := now.Add(signingSessionTTL)
	if latest := prop.ExpiresAt.Add(-minExecutionWindow / 2); latest.Before(expires) {
		expires = latest
	}
	ss := &store.SigningSession{
		ID: newID(), ProposalID: prop.ID, WalletID: prop.WalletID, KeygenID: kg.ID, SID: sid, Act: act, SignerMemberIDs: ids,
		Threshold: kg.Threshold, Parties: kg.Parties, MembershipVersion: kg.MembershipVersion, DerivationIndex: prop.DerivationIndex,
		ChainID: prop.ChainID, AccountAddress: key.Address, PublicKeyHash: key.PublicKeyHash, Message: msg[:],
		CreatedAt: now, ExpiresAt: expires.Truncate(time.Second),
	}
	if err := s.store.SharedWallets().CreateSigningSession(ctx, ss); err != nil {
		if errors.Is(err, store.ErrConflict) {
			// Lost a race with another signer: return the session that won.
			if cur, _, gerr := s.store.SharedWallets().LatestSigningSession(ctx, prop.ID, s.now()); gerr == nil && cur.Status.Open() {
				return s.signingView(ctx, cur.ID, prop)
			}
		}
		return nil, mapSigningErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.signing.start", "proposal", prop.ID.String(), map[string]any{
		"session": ss.ID.String(), "attempt": ss.Attempt, "act": act, "account": key.Address,
		"message": hex.EncodeToString(ss.Message), "sid": hex.EncodeToString(sid),
	})
	return s.signingView(ctx, ss.ID, prop)
}

func (s *Service) signingView(ctx context.Context, sessionID uuid.UUID, prop *store.Proposal) (*SigningView, error) {
	ss, msgs, err := s.store.SharedWallets().GetSigningSession(ctx, sessionID, s.now())
	if err != nil {
		return nil, mapSigningErr(err)
	}
	if ss.Status == store.SigningCombining {
		// Recover a session whose combine step did not finish (e.g. a crash).
		if ss, err = s.combine(ctx, ss, msgs, prop); err != nil && ss == nil {
			return nil, err
		}
	}
	v := &SigningView{Session: ss, Messages: msgs, Proposal: prop, Header: SessionHeader(ss, prop.Digest)}
	if r := ss.Status.Round(); r > 0 {
		v.Transcript = TranscriptHash(ss, prop.Digest, msgs, r)
	}
	if e, err := s.store.SharedWallets().GetExecution(ctx, prop.ID); err == nil {
		v.Execution = e
	}
	return v, nil
}

// GetSigning returns a session to any active participant of its wallet.
func (s *Service) GetSigning(ctx context.Context, p *auth.Principal, sessionID uuid.UUID) (*SigningView, error) {
	ss, _, err := s.store.SharedWallets().GetSigningSession(ctx, sessionID, s.now())
	if err != nil {
		return nil, ErrNotFound
	}
	prop, _, err := s.proposalForMember(ctx, p, ss.ProposalID)
	if err != nil {
		return nil, err
	}
	return s.signingView(ctx, sessionID, prop)
}

func roundPayloadValid(ss *store.SigningSession, round, from int, payload []byte) bool {
	var err error
	switch round {
	case 1:
		_, err = qdraccoon.DecodeRound1(payload)
	case 2:
		_, err = qdraccoon.DecodeRound2(from, payload, ss.Act)
	case 3:
		_, err = qdraccoon.DecodeRound3(payload)
	default:
		return false
	}
	return err == nil
}

func (s *Service) signerSlot(ss *store.SigningSession, me *store.SharedMember) (int, bool) {
	for i, id := range ss.SignerMemberIDs {
		if id == me.ID {
			return ss.Act[i], true
		}
	}
	return 0, false
}

// SubmitRound relays one signer's message for one round.
func (s *Service) SubmitRound(ctx context.Context, p *auth.Principal, sessionID uuid.UUID, round int, payloadB64, transcriptHex, sigB64 string) (*SigningView, error) {
	ss, msgs, err := s.store.SharedWallets().GetSigningSession(ctx, sessionID, s.now())
	if err != nil {
		return nil, ErrNotFound
	}
	prop, me, err := s.proposalForMember(ctx, p, ss.ProposalID)
	if err != nil {
		return nil, err
	}
	if me.DeviceID != p.DeviceID {
		return nil, ErrWrongDevice
	}
	partyIndex, ok := s.signerSlot(ss, me)
	if !ok {
		return nil, ErrNotSigner
	}
	if ss.Status.Round() != round {
		return nil, ErrSigningClosed
	}
	payload, err := b64.DecodeString(payloadB64)
	if err != nil || !roundPayloadValid(ss, round, partyIndex, payload) {
		return nil, ErrBadRoundPayload
	}
	transcript := TranscriptHash(ss, prop.Digest, msgs, round)
	if claimed, err := hex.DecodeString(transcriptHex); err != nil || !bytes.Equal(claimed, transcript) {
		return nil, ErrTranscriptMismatch
	}
	sig, err := verifyDevice(me, SignRoundMessage(ss, round, partyIndex, me.ID, transcript, payload), sigB64)
	if err != nil {
		return nil, err
	}
	req := sessionRequest(ss)
	// Rounds before `round` are frozen once `round` opens, so the transcript
	// checked above cannot change before the insert below.
	check := func(cur *store.SigningSession, have []*store.SigningMessage) string {
		if round != 2 {
			return ""
		}
		// A round-2 opening must match the sender's round-1 commitment.
		for _, m := range have {
			if m.Round == 1 && m.PartyIndex == partyIndex {
				r1, err1 := qdraccoon.DecodeRound1(m.Payload)
				r2, err2 := qdraccoon.DecodeRound2(partyIndex, payload, cur.Act)
				if err1 != nil || err2 != nil || !qdraccoon.OpensCommitment(req, partyIndex, r1, r2.W) {
					return store.SigningFailInvalidCommitment
				}
			}
		}
		return ""
	}
	updated, err := s.store.SharedWallets().AddSigningMessage(ctx, &store.SigningMessage{
		SessionID: ss.ID, Round: round, PartyIndex: partyIndex, MemberID: me.ID, Payload: payload, DeviceSignature: sig,
	}, s.now(), check)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, ErrDuplicateRoundMessage
		}
		if errors.Is(err, store.ErrSigningClosed) {
			if cur, _, gerr := s.store.SharedWallets().GetSigningSession(ctx, ss.ID, s.now()); gerr == nil && cur.FailureReason == store.SigningFailInvalidCommitment {
				s.record(ctx, p.UserID, "shared_wallet.signing.fail", "proposal", prop.ID.String(), map[string]any{
					"session": ss.ID.String(), "reason": cur.FailureReason, "party": partyIndex,
				})
			}
		}
		return nil, mapSigningErr(err)
	}
	if updated.Status == store.SigningCombining {
		_, all, err := s.store.SharedWallets().GetSigningSession(ctx, ss.ID, s.now())
		if err != nil {
			return nil, err
		}
		if _, err := s.combine(ctx, updated, all, prop); err != nil {
			return nil, err
		}
	}
	return s.signingView(ctx, ss.ID, prop)
}

func sessionRequest(ss *store.SigningSession) *qdraccoon.Request {
	r := &qdraccoon.Request{Act: append([]int(nil), ss.Act...), DerivationIndex: uint32(ss.DerivationIndex)}
	copy(r.SID[:], ss.SID)
	copy(r.Msg[:], ss.Message)
	return r
}

// combine turns a complete transcript into one verified signature, or fails
// the session. It never outputs an unverified signature.
func (s *Service) combine(ctx context.Context, ss *store.SigningSession, msgs []*store.SigningMessage, prop *store.Proposal) (*store.SigningSession, error) {
	key, err := s.store.SharedWallets().GetAccountKey(ctx, prop.AccountID, ss.KeygenID)
	if err != nil {
		return nil, err
	}
	pk, err := qdraccoon.DecodePublicKey(key.PublicKey)
	if err != nil {
		return nil, err
	}
	byRound := map[int]map[int][]byte{1: {}, 2: {}, 3: {}}
	for _, m := range msgs {
		byRound[m.Round][m.PartyIndex] = m.Payload
	}
	t := len(ss.Act)
	r1, r2, r3 := make([]*qdraccoon.Round1, t), make([]*qdraccoon.Round2, t), make([]qdraccoon.PolyVec, t)
	sig, cerr := func() (*qdraccoon.Signature, error) {
		for k, from := range ss.Act {
			var err error
			if r1[k], err = qdraccoon.DecodeRound1(byRound[1][from]); err != nil {
				return nil, err
			}
			if r2[k], err = qdraccoon.DecodeRound2(from, byRound[2][from], ss.Act); err != nil {
				return nil, err
			}
			if r3[k], err = qdraccoon.DecodeRound3(byRound[3][from]); err != nil {
				return nil, err
			}
		}
		return qdraccoon.Combine(pk, sessionRequest(ss), r1, r2, r3)
	}()
	now := s.now()
	if cerr != nil {
		failed, err := s.store.SharedWallets().FailSigningSession(ctx, ss.ID, store.SigningFailInvalidSignature, nil, now)
		s.record(ctx, uuid.Nil, "shared_wallet.signing.fail", "proposal", prop.ID.String(), map[string]any{
			"session": ss.ID.String(), "reason": store.SigningFailInvalidSignature,
		})
		if err != nil {
			return nil, mapSigningErr(err)
		}
		return failed, nil
	}
	enc := qdraccoon.EncodeSignature(sig)
	done, err := s.store.SharedWallets().CompleteSigningSession(ctx, ss.ID, enc, now)
	if err != nil {
		if errors.Is(err, store.ErrAlreadySigned) {
			cur, _, gerr := s.store.SharedWallets().GetSigningSession(ctx, ss.ID, now)
			return cur, gerr
		}
		return nil, mapSigningErr(err)
	}
	s.record(ctx, uuid.Nil, "shared_wallet.signing.complete", "proposal", prop.ID.String(), map[string]any{
		"session": ss.ID.String(), "signatureSha256": sha256Hex(enc), "message": hex.EncodeToString(ss.Message),
		"account": ss.AccountAddress, "verified": true,
	})
	return done, nil
}

// AbortSigning lets a selected signer end a session it cannot complete
// (its key worker refused a message, it lost its round state, or the user
// cancelled). A new session with a new sid can then be started.
func (s *Service) AbortSigning(ctx context.Context, p *auth.Principal, sessionID uuid.UUID, reason, sigB64 string) (*SigningView, error) {
	if !signingAbortReasons[reason] {
		return nil, ErrInvalidAbortReason
	}
	ss, _, err := s.store.SharedWallets().GetSigningSession(ctx, sessionID, s.now())
	if err != nil {
		return nil, ErrNotFound
	}
	prop, me, err := s.proposalForMember(ctx, p, ss.ProposalID)
	if err != nil {
		return nil, err
	}
	if me.DeviceID != p.DeviceID {
		return nil, ErrWrongDevice
	}
	if _, ok := s.signerSlot(ss, me); !ok {
		return nil, ErrNotSigner
	}
	if _, err := verifyDevice(me, SignAbortMessage(ss, me.ID, reason), sigB64); err != nil {
		return nil, err
	}
	id := me.ID
	if _, err := s.store.SharedWallets().FailSigningSession(ctx, ss.ID, reason, &id, s.now()); err != nil {
		return nil, mapSigningErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.signing.fail", "proposal", prop.ID.String(), map[string]any{
		"session": ss.ID.String(), "reason": reason, "participant": me.ID.String(),
	})
	return s.signingView(ctx, ss.ID, prop)
}
