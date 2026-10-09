package evm

import "testing"

func TestDetectPoisoningFlagsZeroValueIncoming(t *testing.T) {
	items := []ActivityItem{
		{Hash: "0x1", Direction: "in", From: "0xUNKNOWN00000000000000000000000000000001", Amount: "0"},
	}
	out := DetectPoisoning(items, map[string]struct{}{})
	if !hasFlag(out[0].Flags, "suspected_poisoning") {
		t.Fatalf("expected zero-value incoming transfer to be flagged, got %v", out[0].Flags)
	}
}

func TestDetectPoisoningFlagsLookalikeSender(t *testing.T) {
	sentTo := map[string]struct{}{
		"0xabcd00000000000000000000000000000000ef01": {},
	}
	items := []ActivityItem{
		// Same first-4 (abcd) and last-4 (ef01) hex chars, different middle.
		{Hash: "0x2", Direction: "in", From: "0xabcd99999999999999999999999999999999ef01", Amount: "100"},
	}
	out := DetectPoisoning(items, sentTo)
	if !hasFlag(out[0].Flags, "suspected_poisoning") {
		t.Fatalf("expected lookalike sender to be flagged, got %v", out[0].Flags)
	}
}

func TestDetectPoisoningDoesNotFlagKnownSender(t *testing.T) {
	sentTo := map[string]struct{}{
		"0xabcd00000000000000000000000000000000ef01": {},
	}
	items := []ActivityItem{
		{Hash: "0x3", Direction: "in", From: "0xABCD00000000000000000000000000000000EF01", Amount: "100"},
	}
	out := DetectPoisoning(items, sentTo)
	if hasFlag(out[0].Flags, "suspected_poisoning") {
		t.Fatalf("expected a known (previously sent-to) sender to NOT be flagged, got %v", out[0].Flags)
	}
}

func TestDetectPoisoningDoesNotFlagUnrelatedIncoming(t *testing.T) {
	sentTo := map[string]struct{}{
		"0xabcd00000000000000000000000000000000ef01": {},
	}
	items := []ActivityItem{
		{Hash: "0x4", Direction: "in", From: "0x111100000000000000000000000000000000ffff", Amount: "100"},
	}
	out := DetectPoisoning(items, sentTo)
	if hasFlag(out[0].Flags, "suspected_poisoning") {
		t.Fatalf("expected an unrelated sender to NOT be flagged, got %v", out[0].Flags)
	}
}

func TestDetectPoisoningIgnoresOutgoing(t *testing.T) {
	items := []ActivityItem{
		{Hash: "0x5", Direction: "out", From: "0x111100000000000000000000000000000000ffff", Amount: "0"},
	}
	out := DetectPoisoning(items, map[string]struct{}{})
	if hasFlag(out[0].Flags, "suspected_poisoning") {
		t.Fatalf("expected outgoing transfers to never be flagged, got %v", out[0].Flags)
	}
}

func hasFlag(flags []string, want string) bool {
	for _, f := range flags {
		if f == want {
			return true
		}
	}
	return false
}
