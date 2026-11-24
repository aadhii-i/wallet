package authorization

import (
	"errors"
	"testing"
)

func TestDefaultPolicyRequiredApprovals(t *testing.T) {
	cases := []struct{ participants, want int }{
		{1, 1}, {2, 1}, {3, 2}, {4, 2}, {5, 3}, {6, 3}, {10, 5},
		{11, 6}, {12, 6}, {20, 10}, {30, 15}, {50, 25}, {64, 32}, {100, 50},
	}
	p := DefaultPolicy()
	for _, c := range cases {
		got, err := p.RequiredApprovals(c.participants)
		if err != nil {
			t.Fatalf("N=%d: %v", c.participants, err)
		}
		if got != c.want {
			t.Errorf("N=%d: required %d, want %d", c.participants, got, c.want)
		}
	}
}

// For every N, ceil(N/2) is the smallest T with 2T >= N.
func TestDefaultPolicyIsSmallestMajorityOrHalf(t *testing.T) {
	p := DefaultPolicy()
	for n := 1; n <= MaxParticipants; n++ {
		got, err := p.RequiredApprovals(n)
		if err != nil {
			t.Fatalf("N=%d: %v", n, err)
		}
		if 2*got < n || 2*(got-1) >= n || got < 1 || got > n {
			t.Fatalf("N=%d: required %d is not ceil(N/2)", n, got)
		}
	}
}

func TestOtherRatios(t *testing.T) {
	cases := []struct {
		num, den, n, want int
	}{
		{2, 3, 3, 2}, {2, 3, 10, 7}, {1, 1, 7, 7}, {3, 4, 10, 8}, {1, 3, 1, 1},
	}
	for _, c := range cases {
		p := Policy{Version: 2, Numerator: c.num, Denominator: c.den, Rounding: RoundCeil}
		got, err := p.RequiredApprovals(c.n)
		if err != nil || got != c.want {
			t.Errorf("%d/%d of %d: got %d (%v), want %d", c.num, c.den, c.n, got, err, c.want)
		}
	}
}

func TestInvalidPolicies(t *testing.T) {
	bad := []Policy{
		{Version: 0, Numerator: 1, Denominator: 2, Rounding: RoundCeil},
		{Version: 1, Numerator: 0, Denominator: 2, Rounding: RoundCeil},
		{Version: 1, Numerator: 3, Denominator: 2, Rounding: RoundCeil},
		{Version: 1, Numerator: 1, Denominator: 0, Rounding: RoundCeil},
		{Version: 1, Numerator: -1, Denominator: 2, Rounding: RoundCeil},
		{Version: 1, Numerator: 1, Denominator: 2, Rounding: "floor"},
		{Version: 1, Numerator: 1, Denominator: 2},
	}
	for _, p := range bad {
		if _, err := p.RequiredApprovals(5); !errors.Is(err, ErrInvalidPolicy) {
			t.Errorf("%+v: expected ErrInvalidPolicy, got %v", p, err)
		}
	}
}

func TestParticipantCountBounds(t *testing.T) {
	p := DefaultPolicy()
	if _, err := p.RequiredApprovals(0); !errors.Is(err, ErrNoActiveParticipants) {
		t.Errorf("N=0: got %v", err)
	}
	if _, err := p.RequiredApprovals(-3); !errors.Is(err, ErrNoActiveParticipants) {
		t.Errorf("N=-3: got %v", err)
	}
	if _, err := p.RequiredApprovals(MaxParticipants + 1); !errors.Is(err, ErrTooManyParticipants) {
		t.Errorf("N=max+1: got %v", err)
	}
}

func TestSnapshotIsFrozenAcrossMembershipChanges(t *testing.T) {
	p := DefaultPolicy()
	at10, err := NewSnapshot(p, 4, 10)
	if err != nil {
		t.Fatal(err)
	}
	// Membership grows to 11 afterwards: new proposals need 6, the old one still needs 5.
	at11, err := NewSnapshot(p, 5, 11)
	if err != nil {
		t.Fatal(err)
	}
	if at10.RequiredApprovals != 5 || at11.RequiredApprovals != 6 {
		t.Fatalf("got %d and %d, want 5 and 6", at10.RequiredApprovals, at11.RequiredApprovals)
	}
	if out, _ := at10.Evaluate(5, 0); out != OutcomeApproved {
		t.Errorf("old snapshot with 5 approvals: %s", out)
	}
}

func TestSnapshotValidateDetectsTampering(t *testing.T) {
	s, err := NewSnapshot(DefaultPolicy(), 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	s.RequiredApprovals = 4
	if err := s.Validate(); !errors.Is(err, ErrInvalidPolicy) {
		t.Errorf("lowered requirement accepted: %v", err)
	}
	if _, err := NewSnapshot(DefaultPolicy(), 0, 10); !errors.Is(err, ErrInvalidPolicy) {
		t.Errorf("membership version 0 accepted: %v", err)
	}
}

func TestEvaluate(t *testing.T) {
	s, err := NewSnapshot(DefaultPolicy(), 1, 10) // requires 5
	if err != nil {
		t.Fatal(err)
	}
	for a := 0; a <= 4; a++ {
		if out, err := s.Evaluate(a, 0); err != nil || out != OutcomePending {
			t.Errorf("%d approvals: %s (%v), want pending", a, out, err)
		}
	}
	cases := []struct {
		approvals, rejections int
		want                  Outcome
	}{
		{5, 0, OutcomeApproved},
		{5, 5, OutcomeApproved},
		{0, 1, OutcomePending},  // one rejection is a vote, not a veto
		{0, 5, OutcomePending},  // the other 5 can still reach 5
		{0, 6, OutcomeRejected}, // at most 4 approvals remain possible
		{4, 6, OutcomeRejected},
	}
	for _, c := range cases {
		out, err := s.Evaluate(c.approvals, c.rejections)
		if err != nil || out != c.want {
			t.Errorf("%d approve / %d reject: %s (%v), want %s", c.approvals, c.rejections, out, err, c.want)
		}
	}
	for _, bad := range [][2]int{{-1, 0}, {0, -1}, {6, 5}, {11, 0}} {
		if _, err := s.Evaluate(bad[0], bad[1]); !errors.Is(err, ErrInvalidPolicy) {
			t.Errorf("counts %v accepted: %v", bad, err)
		}
	}
}

func TestSingleParticipantAndPairEdgeCases(t *testing.T) {
	one, _ := NewSnapshot(DefaultPolicy(), 1, 1)
	if out, _ := one.Evaluate(0, 1); out != OutcomeRejected {
		t.Errorf("1 participant rejecting: %s", out)
	}
	two, _ := NewSnapshot(DefaultPolicy(), 1, 2) // requires 1
	if out, _ := two.Evaluate(0, 1); out != OutcomePending {
		t.Errorf("2 participants, 1 rejection: %s, want pending", out)
	}
	if out, _ := two.Evaluate(1, 1); out != OutcomeApproved {
		t.Errorf("2 participants, 1 approval: %s", out)
	}
}

func TestQdCompatibility(t *testing.T) {
	for _, n := range []int{1, 2, 3, 10, 30, 50, 64} {
		s, _ := NewSnapshot(DefaultPolicy(), 1, n)
		if err := s.QdCompatibility(); err != nil {
			t.Errorf("N=%d: %v", n, err)
		}
	}
	for _, n := range []int{65, 100} {
		s, _ := NewSnapshot(DefaultPolicy(), 1, n)
		if err := s.QdCompatibility(); !errors.Is(err, ErrQdUnsupportedConfig) {
			t.Errorf("N=%d: expected ErrQdUnsupportedConfig, got %v", n, err)
		}
	}
}
