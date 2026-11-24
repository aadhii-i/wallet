package qdraccoon

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

// Transcripts written by packages/qd-crypto/test/rounds.test.ts
// (QD_WRITE_VECTORS=1): real 2-of-3 and 3-of-5 signing runs, every round
// message as it travels over the wire, and the TypeScript combiner's output.
type transcript struct {
	Threshold       int      `json:"threshold"`
	Parties         int      `json:"parties"`
	Act             []int    `json:"act"`
	DerivationIndex uint32   `json:"derivationIndex"`
	SID             string   `json:"sid"`
	Msg             string   `json:"msg"`
	PublicKey       string   `json:"publicKey"`
	Round1          []string `json:"round1"`
	Round2          []string `json:"round2"`
	Round3          []string `json:"round3"`
	Signature       string   `json:"signature"`
}

func b64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type parsed struct {
	tr  transcript
	pk  *PublicKey
	req *Request
	r1  []*Round1
	r2  []*Round2
	r3  []PolyVec
	sig []byte
	raw [3][][]byte
}

func load(t *testing.T, name string) *parsed {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	p := &parsed{}
	if err := json.Unmarshal(data, &p.tr); err != nil {
		t.Fatal(err)
	}
	if p.pk, err = DecodePublicKey(b64(t, p.tr.PublicKey)); err != nil {
		t.Fatal(err)
	}
	p.req = &Request{Act: p.tr.Act, DerivationIndex: p.tr.DerivationIndex}
	copy(p.req.SID[:], b64(t, p.tr.SID))
	copy(p.req.Msg[:], b64(t, p.tr.Msg))
	for k, from := range p.tr.Act {
		b1, b2, b3 := b64(t, p.tr.Round1[k]), b64(t, p.tr.Round2[k]), b64(t, p.tr.Round3[k])
		p.raw[0], p.raw[1], p.raw[2] = append(p.raw[0], b1), append(p.raw[1], b2), append(p.raw[2], b3)
		r1, err := DecodeRound1(b1)
		if err != nil {
			t.Fatal(err)
		}
		r2, err := DecodeRound2(from, b2, p.tr.Act)
		if err != nil {
			t.Fatal(err)
		}
		r3, err := DecodeRound3(b3)
		if err != nil {
			t.Fatal(err)
		}
		p.r1, p.r2, p.r3 = append(p.r1, r1), append(p.r2, r2), append(p.r3, r3)
	}
	p.sig = b64(t, p.tr.Signature)
	return p
}

func TestKnownAnswerCombineAndVerify(t *testing.T) {
	for _, name := range []string{"transcript_2of3.json", "transcript_3of5.json"} {
		t.Run(name, func(t *testing.T) {
			p := load(t, name)
			if !ValidAct(p.req.Act, p.tr.Threshold, p.tr.Parties) {
				t.Fatal("act")
			}
			sig, err := Combine(p.pk, p.req, p.r1, p.r2, p.r3)
			if err != nil {
				t.Fatal(err)
			}
			if got := EncodeSignature(sig); !bytes.Equal(got, p.sig) {
				t.Fatal("Go combine differs from the TypeScript combine")
			}
			dec, err := DecodeSignature(p.sig)
			if err != nil || !Verify(p.pk, p.req.Msg[:], dec) {
				t.Fatal("TypeScript signature does not verify in Go")
			}
			if !bytes.Equal(EncodePublicKey(p.pk), b64(t, p.tr.PublicKey)) {
				t.Fatal("public key round trip")
			}
		})
	}
}

func TestRejections(t *testing.T) {
	p := load(t, "transcript_2of3.json")
	sig, _ := DecodeSignature(p.sig)

	msg := p.req.Msg
	msg[0] ^= 1
	if Verify(p.pk, msg[:], sig) {
		t.Fatal("altered message accepted")
	}
	for name, mutate := range map[string]func(b []byte){
		"z":         func(b []byte) { b[Omega*2+6] ^= 1 },
		"h":         func(b []byte) { b[Omega*2+L*N*7+1] = (b[Omega*2+L*N*7+1] + 1) % 250 },
		"sign":      func(b []byte) { b[0] ^= 0x80 },
		"position":  func(b []byte) { b[1] ^= 1 },
		"duplicate": func(b []byte) { b[2], b[3] = b[0], b[1] },
	} {
		b := append([]byte{}, p.sig...)
		mutate(b)
		s, err := DecodeSignature(b)
		if err == nil && Verify(p.pk, p.req.Msg[:], s) {
			t.Fatalf("%s: tampered signature accepted", name)
		}
	}
	for name, b := range map[string][]byte{
		"reserved bits": func() []byte { b := append([]byte{}, p.sig...); b[0] |= 2; return b }(),
		"z ≥ q": func() []byte {
			b := append([]byte{}, p.sig...)
			copy(b[Omega*2:], bytes.Repeat([]byte{0xff}, 7))
			return b
		}(),
		"short": p.sig[:len(p.sig)-1],
	} {
		if _, err := DecodeSignature(b); err == nil {
			t.Fatalf("%s: decoded", name)
		}
	}

	// Wrong session id: the commitments no longer open.
	other := *p.req
	other.SID[0] ^= 1
	if _, err := Combine(p.pk, &other, p.r1, p.r2, p.r3); err != ErrTranscript {
		t.Fatalf("wrong sid: %v", err)
	}
	// Corrupted response share: Combine refuses to output a signature.
	bad := append([]byte{}, p.raw[2][1]...)
	bad[6] ^= 1
	z, _ := DecodeRound3(bad)
	if _, err := Combine(p.pk, p.req, p.r1, p.r2, []PolyVec{p.r3[0], z}); err != ErrInvalid {
		t.Fatalf("corrupted response: %v", err)
	}
	// Corrupted commitment share opening.
	w := append([]byte{}, p.raw[1][0]...)
	w[6] ^= 1
	r2, _ := DecodeRound2(p.req.Act[0], w, p.req.Act)
	if OpensCommitment(p.req, p.req.Act[0], p.r1[0], r2.W) {
		t.Fatal("altered opening accepted")
	}
	// Insufficient shares.
	if _, err := Combine(p.pk, p.req, p.r1[:1], p.r2[:1], p.r3[:1]); err != ErrTranscript {
		t.Fatal("combined with fewer than T")
	}
	// Malformed rounds.
	if _, err := DecodeRound1(p.raw[0][0][:Round1Bytes-1]); err == nil {
		t.Fatal("short round 1")
	}
	r2b := append([]byte{}, p.raw[1][0]...)
	r2b[K*N*7] = 9
	if _, err := DecodeRound2(p.req.Act[0], r2b, p.req.Act); err == nil {
		t.Fatal("misaddressed tag")
	}
	if ValidAct([]int{2, 1}, 2, 3) || ValidAct([]int{1, 4}, 2, 3) || ValidAct([]int{1}, 2, 3) {
		t.Fatal("ValidAct")
	}
}
