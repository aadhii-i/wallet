package sharedwallet

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/authorization"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Threshold Raccoon key generation (trusted dealer) for a shared wallet.
//
//  1. The owner starts a ceremony. It freezes the active members (party
//     indices 1..N in join order), T = the policy's required approvals, and
//     the membership version. Any membership change fails it.
//  2. Each participant's device registers a fresh X-Wing public key, signed
//     with its P-256 device key.
//  3. The dealer (the owner's device) runs dealerKeyGen locally, seals each
//     share to its recipient with HPKE, uploads the envelopes one by one, then
//     commits them with a device signature over every envelope hash.
//  4. Each participant downloads only its own envelope, decrypts and verifies
//     it locally, stores it encrypted, and acknowledges with a device
//     signature over the fingerprint and envelope hash.
//  5. The wallet key becomes active only when all N have acknowledged.
//
// The backend never sees plaintext key material; it cannot check that the
// shares are correct either. That is the dealer's self-check and the
// recipients' fingerprint check, under the trusted-dealer assumption.

const (
	keygenTTL           = 24 * time.Hour
	xwingPublicKeyBytes = 1216
	xwingEncBytes       = 1120
	// A serialized share is at most 36,424 bytes (N = 64), plus a 16-byte AEAD tag.
	maxEnvelopeCTBytes = 40 * 1024
	minEnvelopeCTBytes = 1024
)

var (
	ErrKeygenInProgress      = errors.New("sharedwallet: a key generation is already in progress")
	ErrAlreadyInitialized    = errors.New("sharedwallet: wallet key is already initialized for this membership")
	ErrKeygenNotOpen         = errors.New("sharedwallet: key generation is not at this step (or expired)")
	ErrKeygenIncomplete      = errors.New("sharedwallet: not every participant has completed the previous step")
	ErrFingerprintMismatch   = errors.New("sharedwallet: fingerprint does not match this key generation")
	ErrAlreadyProvisioned    = errors.New("sharedwallet: already acknowledged for this key generation")
	ErrAlreadyRegistered     = errors.New("sharedwallet: encryption key already registered")
	ErrKeygenSignature       = errors.New("sharedwallet: device signature invalid")
	ErrNotInKeyGeneration    = errors.New("sharedwallet: participant is not part of this key generation")
	ErrInvalidFailureReason  = errors.New("sharedwallet: invalid failure reason")
	b64                      = base64.RawURLEncoding
	keygenFailReasonsByUsers = map[string]bool{
		store.KeygenFailCancelled: true, store.KeygenFailDecryption: true, store.KeygenFailVerification: true,
	}
)

func mapKeygenErr(err error) error {
	switch {
	case errors.Is(err, store.ErrKeygenClosed):
		return ErrKeygenNotOpen
	case errors.Is(err, store.ErrKeygenIncomplete):
		return ErrKeygenIncomplete
	case errors.Is(err, store.ErrMismatch):
		return ErrFingerprintMismatch
	case errors.Is(err, store.ErrNotEligible):
		return ErrNotInKeyGeneration
	}
	return mapStoreErr(err)
}

// ---- canonical messages (mirrored in packages/rpc/src/shared-keygen.ts) ----------

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func KeygenKeyMessage(kg *store.KeyGeneration, memberID uuid.UUID, partyIndex int, encryptionKey []byte) []byte {
	return []byte(strings.Join([]string{
		"QDWallet-KeygenKey", "v1", kg.WalletID.String(), kg.ID.String(), memberID.String(),
		strconv.Itoa(partyIndex), strconv.FormatInt(kg.MembershipVersion, 10), sha256Hex(encryptionKey),
	}, "|"))
}

// EnvelopesDigest commits to every envelope: SHA-256 of
// "index:participantId:sha256(enc‖ct)" lines, ordered by party index, joined by ";".
func EnvelopesDigest(parts []*store.KeygenParticipant) []byte {
	sorted := append([]*store.KeygenParticipant(nil), parts...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].PartyIndex < sorted[j].PartyIndex })
	lines := make([]string, len(sorted))
	for i, p := range sorted {
		lines[i] = fmt.Sprintf("%d:%s:%s", p.PartyIndex, p.MemberID, hex.EncodeToString(p.EnvelopeHash))
	}
	h := sha256.Sum256([]byte(strings.Join(lines, ";")))
	return h[:]
}

func KeygenDealMessage(kg *store.KeyGeneration, fingerprint, envelopesDigest []byte) []byte {
	return []byte(strings.Join([]string{
		"QDWallet-KeygenDeal", "v1", kg.WalletID.String(), kg.ID.String(), strconv.FormatInt(kg.MembershipVersion, 10),
		strconv.Itoa(kg.Threshold), strconv.Itoa(kg.Parties), hex.EncodeToString(fingerprint), hex.EncodeToString(envelopesDigest),
	}, "|"))
}

func KeygenAckMessage(kg *store.KeyGeneration, part *store.KeygenParticipant, fingerprint []byte) []byte {
	return []byte(strings.Join([]string{
		"QDWallet-KeygenAck", "v1", kg.WalletID.String(), kg.ID.String(), part.MemberID.String(), strconv.Itoa(part.PartyIndex),
		strconv.Itoa(kg.Threshold), strconv.Itoa(kg.Parties), strconv.FormatInt(kg.MembershipVersion, 10),
		hex.EncodeToString(fingerprint), hex.EncodeToString(part.EnvelopeHash),
	}, "|"))
}

func verifyDevice(m *store.SharedMember, msg []byte, sigB64 string) ([]byte, error) {
	pub, err := auth.ParseSPKIPublicKeyB64URL(b64.EncodeToString(m.DevicePublicKey))
	if err != nil {
		return nil, ErrKeygenSignature
	}
	if err := auth.VerifyP1363SignatureB64URL(pub, msg, sigB64); err != nil {
		return nil, ErrKeygenSignature
	}
	sig, _ := b64.DecodeString(sigB64)
	return sig, nil
}

func parseFingerprint(s string) ([]byte, error) {
	fp, err := hex.DecodeString(s)
	if err != nil || len(fp) != 32 || s != strings.ToLower(s) {
		return nil, fmt.Errorf("%w: fingerprint must be 64 lowercase hex characters", ErrInvalid)
	}
	return fp, nil
}

// ---- views -----------------------------------------------------------------------

// KeygenView is one ceremony as seen by a wallet participant.
type KeygenView struct {
	KG    *store.KeyGeneration
	Parts []*store.KeygenParticipant
	Me    *store.KeygenParticipant // nil if the caller is not a party
}

// KeyInitStatus is the honest, user-facing state of the wallet's Raccoon key.
func KeyInitStatus(w *store.SharedWallet, latest *store.KeyGeneration) string {
	switch {
	case w.KeyStatus == store.KeyActive:
		return "initialized"
	case latest != nil && (latest.Status == store.KeygenCollectingKeys || latest.Status == store.KeygenDealing):
		return "in_progress"
	case latest != nil && latest.Status == store.KeygenAwaitingProvisioning:
		return "awaiting_provisioning"
	case w.KeyStatus == store.KeyRekeyRequired:
		return "rekey_required"
	case latest != nil && latest.Status == store.KeygenFailed:
		return "failed"
	}
	return "not_initialized"
}

// latestKeygen returns the newest ceremony (expiring it if it lapsed), or nil.
func (s *Service) latestKeygen(ctx context.Context, walletID uuid.UUID) (*store.KeyGeneration, []*store.KeygenParticipant, error) {
	kg, parts, err := s.store.SharedWallets().LatestKeyGeneration(ctx, walletID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if kg.Status.Open() && !s.now().Before(kg.ExpiresAt) {
		if _, err := s.store.SharedWallets().FailKeyGeneration(ctx, kg.ID, store.KeygenFailExpired, s.now()); err != nil && !errors.Is(err, store.ErrKeygenClosed) {
			return nil, nil, err
		}
		return s.store.SharedWallets().GetKeyGeneration(ctx, kg.ID)
	}
	return kg, parts, nil
}

func viewOf(kg *store.KeyGeneration, parts []*store.KeygenParticipant, me *store.SharedMember) *KeygenView {
	v := &KeygenView{KG: kg, Parts: parts}
	for _, p := range parts {
		if p.MemberID == me.ID {
			v.Me = p
		}
	}
	return v
}

// keygenFor loads a ceremony of walletID for an active member using their bound device.
func (s *Service) keygenFor(ctx context.Context, p *auth.Principal, walletID, keygenID uuid.UUID) (*store.SharedMember, *KeygenView, error) {
	_, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return nil, nil, err
	}
	kg, parts, err := s.store.SharedWallets().GetKeyGeneration(ctx, keygenID)
	if err != nil || kg.WalletID != walletID {
		return nil, nil, ErrNotFound
	}
	if me.DeviceID != p.DeviceID {
		return nil, nil, ErrWrongDevice
	}
	return me, viewOf(kg, parts, me), nil
}

// ---- operations ------------------------------------------------------------------

// StartKeyGeneration: only the owner, from their bound device, may start it;
// that device becomes the dealer.
func (s *Service) StartKeyGeneration(ctx context.Context, p *auth.Principal, walletID uuid.UUID) (*KeygenView, error) {
	for attempt := 0; attempt < 3; attempt++ {
		w, me, err := s.member(ctx, p, walletID)
		if err != nil {
			return nil, err
		}
		if me.Role != store.RoleOwner {
			return nil, ErrForbidden
		}
		if me.DeviceID != p.DeviceID {
			return nil, ErrWrongDevice
		}
		if w.KeyStatus == store.KeyActive {
			return nil, ErrAlreadyInitialized
		}
		members, err := s.store.SharedWallets().ListMembers(ctx, walletID)
		if err != nil {
			return nil, err
		}
		var active []*store.SharedMember
		for _, m := range members {
			if m.Status == store.MemberActive {
				active = append(active, m)
			}
		}
		// Party index = position in join order (owner first); ties by id.
		sort.SliceStable(active, func(i, j int) bool {
			if !active[i].JoinedAt.Equal(active[j].JoinedAt) {
				return active[i].JoinedAt.Before(active[j].JoinedAt)
			}
			return active[i].ID.String() < active[j].ID.String()
		})
		snap, err := authorization.NewSnapshot(policyOf(w), w.MembershipVersion, len(active))
		if err != nil {
			return nil, err
		}
		if err := snap.QdCompatibility(); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
		}
		now := s.now()
		kg := &store.KeyGeneration{
			ID: newID(), WalletID: walletID, MembershipVersion: w.MembershipVersion,
			Threshold: snap.RequiredApprovals, Parties: snap.ParticipantCount, DealerMemberID: me.ID,
			Status: store.KeygenCollectingKeys, CreatedAt: now, ExpiresAt: now.Add(keygenTTL),
		}
		parts := make([]*store.KeygenParticipant, len(active))
		for i, m := range active {
			parts[i] = &store.KeygenParticipant{KeygenID: kg.ID, MemberID: m.ID, PartyIndex: i + 1}
		}
		err = s.store.SharedWallets().CreateKeyGeneration(ctx, kg, parts)
		if errors.Is(err, store.ErrStale) {
			continue
		}
		if errors.Is(err, store.ErrConflict) {
			if cur, _ := s.store.SharedWallets().GetWallet(ctx, walletID); cur != nil && cur.KeyStatus == store.KeyActive {
				return nil, ErrAlreadyInitialized
			}
			return nil, ErrKeygenInProgress
		}
		if err != nil {
			return nil, err
		}
		s.record(ctx, p.UserID, "shared_wallet.keygen.start", "shared_wallet", walletID.String(), map[string]any{
			"keygen": kg.ID.String(), "threshold": kg.Threshold, "parties": kg.Parties, "membershipVersion": kg.MembershipVersion,
			"dealer": me.ID.String(),
		})
		return viewOf(kg, parts, me), nil
	}
	return nil, ErrStale
}

// CurrentKeyGeneration returns the newest ceremony, or ErrNotFound.
func (s *Service) CurrentKeyGeneration(ctx context.Context, p *auth.Principal, walletID uuid.UUID) (*KeygenView, error) {
	_, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return nil, err
	}
	kg, parts, err := s.latestKeygen(ctx, walletID)
	if err != nil {
		return nil, err
	}
	if kg == nil {
		return nil, ErrNotFound
	}
	return viewOf(kg, parts, me), nil
}

func (s *Service) RegisterEncryptionKey(ctx context.Context, p *auth.Principal, walletID, keygenID uuid.UUID, keyB64, sigB64 string) (*KeygenView, error) {
	me, v, err := s.keygenFor(ctx, p, walletID, keygenID)
	if err != nil {
		return nil, err
	}
	if v.Me == nil {
		return nil, ErrNotInKeyGeneration
	}
	key, err := b64.DecodeString(keyB64)
	if err != nil || len(key) != xwingPublicKeyBytes {
		return nil, fmt.Errorf("%w: encryption key must be a %d-byte X-Wing public key", ErrInvalid, xwingPublicKeyBytes)
	}
	sig, err := verifyDevice(me, KeygenKeyMessage(v.KG, me.ID, v.Me.PartyIndex, key), sigB64)
	if err != nil {
		return nil, err
	}
	if _, err := s.store.SharedWallets().RegisterEncryptionKey(ctx, keygenID, me.ID, key, sig, s.now()); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, ErrAlreadyRegistered
		}
		return nil, mapKeygenErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.keygen.key_registered", "shared_wallet", walletID.String(),
		map[string]any{"keygen": keygenID.String(), "participant": me.ID.String(), "keySha256": sha256Hex(key)})
	return s.reload(ctx, keygenID, me)
}

func (s *Service) reload(ctx context.Context, keygenID uuid.UUID, me *store.SharedMember) (*KeygenView, error) {
	kg, parts, err := s.store.SharedWallets().GetKeyGeneration(ctx, keygenID)
	if err != nil {
		return nil, err
	}
	return viewOf(kg, parts, me), nil
}

func (s *Service) requireDealer(ctx context.Context, p *auth.Principal, walletID, keygenID uuid.UUID) (*store.SharedMember, *KeygenView, error) {
	me, v, err := s.keygenFor(ctx, p, walletID, keygenID)
	if err != nil {
		return nil, nil, err
	}
	if v.KG.DealerMemberID != me.ID {
		return nil, nil, ErrForbidden
	}
	return me, v, nil
}

// StageEnvelope stores one opaque HPKE envelope from the dealer.
func (s *Service) StageEnvelope(ctx context.Context, p *auth.Principal, walletID, keygenID, participantID uuid.UUID, fpHex, encB64, ctB64 string) error {
	_, v, err := s.requireDealer(ctx, p, walletID, keygenID)
	if err != nil {
		return err
	}
	fp, err := parseFingerprint(fpHex)
	if err != nil {
		return err
	}
	enc, err1 := b64.DecodeString(encB64)
	ct, err2 := b64.DecodeString(ctB64)
	if err1 != nil || err2 != nil || len(enc) != xwingEncBytes || len(ct) < minEnvelopeCTBytes || len(ct) > maxEnvelopeCTBytes {
		return fmt.Errorf("%w: malformed envelope", ErrInvalid)
	}
	found := false
	for _, part := range v.Parts {
		found = found || part.MemberID == participantID
	}
	if !found {
		return ErrNotInKeyGeneration
	}
	return mapKeygenErr(s.store.SharedWallets().StageEnvelope(ctx, keygenID, participantID, fp, enc, ct, s.now()))
}

// CommitDeal publishes the staged envelopes atomically once the dealer's
// device has signed a commitment to all of them.
func (s *Service) CommitDeal(ctx context.Context, p *auth.Principal, walletID, keygenID uuid.UUID, fpHex, sigB64 string) (*KeygenView, error) {
	me, v, err := s.requireDealer(ctx, p, walletID, keygenID)
	if err != nil {
		return nil, err
	}
	fp, err := parseFingerprint(fpHex)
	if err != nil {
		return nil, err
	}
	if v.KG.Status != store.KeygenDealing {
		return nil, ErrKeygenNotOpen
	}
	for _, part := range v.Parts {
		if part.EnvelopeCT == nil || !bytes.Equal(part.EnvelopeFingerprint, fp) {
			return nil, ErrKeygenIncomplete
		}
	}
	sig, err := verifyDevice(me, KeygenDealMessage(v.KG, fp, EnvelopesDigest(v.Parts)), sigB64)
	if err != nil {
		return nil, err
	}
	if _, err := s.store.SharedWallets().CommitDeal(ctx, keygenID, fp, sig, s.now()); err != nil {
		return nil, mapKeygenErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.keygen.dealt", "shared_wallet", walletID.String(),
		map[string]any{"keygen": keygenID.String(), "fingerprint": fpHex, "envelopes": hex.EncodeToString(EnvelopesDigest(v.Parts))})
	return s.reload(ctx, keygenID, me)
}

// Envelope is what a participant downloads: only their own ciphertext.
type Envelope struct {
	KG   *store.KeyGeneration
	Part *store.KeygenParticipant
}

func (s *Service) MyEnvelope(ctx context.Context, p *auth.Principal, walletID, keygenID uuid.UUID) (*Envelope, error) {
	_, v, err := s.keygenFor(ctx, p, walletID, keygenID)
	if err != nil {
		return nil, err
	}
	if v.Me == nil {
		return nil, ErrNotInKeyGeneration
	}
	if v.Me.ProvisionedAt != nil {
		return nil, ErrAlreadyProvisioned
	}
	if v.KG.Status != store.KeygenAwaitingProvisioning || !s.now().Before(v.KG.ExpiresAt) || v.Me.EnvelopeCT == nil {
		return nil, ErrKeygenNotOpen
	}
	return &Envelope{KG: v.KG, Part: v.Me}, nil
}

// AcknowledgeShare: the participant's device signs that it decrypted, verified
// and stored the share for this fingerprint. The last acknowledgement
// activates the wallet key.
func (s *Service) AcknowledgeShare(ctx context.Context, p *auth.Principal, walletID, keygenID uuid.UUID, fpHex, sigB64 string) (*KeygenView, error) {
	me, v, err := s.keygenFor(ctx, p, walletID, keygenID)
	if err != nil {
		return nil, err
	}
	if v.Me == nil {
		return nil, ErrNotInKeyGeneration
	}
	if v.Me.ProvisionedAt != nil {
		return nil, ErrAlreadyProvisioned
	}
	fp, err := parseFingerprint(fpHex)
	if err != nil {
		return nil, err
	}
	if v.KG.Fingerprint == nil || v.Me.EnvelopeHash == nil {
		return nil, ErrKeygenNotOpen
	}
	if !bytes.Equal(fp, v.KG.Fingerprint) {
		return nil, ErrFingerprintMismatch
	}
	sig, err := verifyDevice(me, KeygenAckMessage(v.KG, v.Me, fp), sigB64)
	if err != nil {
		return nil, err
	}
	kg, err := s.store.SharedWallets().AckProvisioning(ctx, keygenID, me.ID, fp, sig, s.now())
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, ErrAlreadyProvisioned
		}
		return nil, mapKeygenErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.keygen.share_acknowledged", "shared_wallet", walletID.String(),
		map[string]any{"keygen": keygenID.String(), "participant": me.ID.String(), "partyIndex": v.Me.PartyIndex})
	if kg.Status == store.KeygenComplete {
		s.record(ctx, p.UserID, "shared_wallet.keygen.complete", "shared_wallet", walletID.String(),
			map[string]any{"keygen": keygenID.String(), "fingerprint": fpHex, "threshold": kg.Threshold, "parties": kg.Parties})
	}
	return s.reload(ctx, keygenID, me)
}

// FailKeyGeneration: any party may report that its share failed to decrypt
// or verify; the owner (dealer) may cancel. Either way all envelopes are wiped.
func (s *Service) FailKeyGeneration(ctx context.Context, p *auth.Principal, walletID, keygenID uuid.UUID, reason string) (*KeygenView, error) {
	me, v, err := s.keygenFor(ctx, p, walletID, keygenID)
	if err != nil {
		return nil, err
	}
	if !keygenFailReasonsByUsers[reason] {
		return nil, ErrInvalidFailureReason
	}
	if v.Me == nil || (reason == store.KeygenFailCancelled && v.KG.DealerMemberID != me.ID) {
		return nil, ErrForbidden
	}
	if _, err := s.store.SharedWallets().FailKeyGeneration(ctx, keygenID, reason, s.now()); err != nil {
		return nil, mapKeygenErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.keygen.failed", "shared_wallet", walletID.String(),
		map[string]any{"keygen": keygenID.String(), "participant": me.ID.String(), "reason": reason})
	return s.reload(ctx, keygenID, me)
}
