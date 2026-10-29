package transaction

import (
	"encoding/json"
	"testing"

	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
)

// A nil Go slice marshals to JSON null. docs/api/openapi.yaml declares
// ActivityItem.flags as required, and the web list calls flags.includes()
// without a guard, so an unflagged transfer used to blank the Activity screen.
func TestNilFlagsMarshalToNullWithoutNormalisation(t *testing.T) {
	raw, err := json.Marshal(map[string]any{"flags": []string(nil)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := string(raw); got != `{"flags":null}` {
		t.Fatalf("unexpected baseline, review this test: %s", got)
	}
}

func TestActivityFlagsAlwaysSerializeAsArray(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want string
	}{
		{"nil", nil, `[]`},
		{"empty", []string{}, `[]`},
		{"flagged", []string{"suspected_poisoning"}, `["suspected_poisoning"]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(flagsForResponse(tc.in))
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(raw) != tc.want {
				t.Errorf("flags = %s, want %s", raw, tc.want)
			}
		})
	}
}

// TestProviderActivitySerialisesFlagsForEveryItem drives the real path: a
// history provider item that triggers no poisoning detection carries a nil
// Flags slice on the way into the response.
func TestProviderActivitySerialisesFlagsForEveryItem(t *testing.T) {
	items := []evm.ActivityItem{
		{Hash: "0xaaa", NetworkID: "sepolia", Direction: "out", From: "0xME", To: "0xOTHER", Amount: "1000"},
	}
	merged := providerToMerged(evm.DetectPoisoning(items, map[string]struct{}{}))
	if len(merged) != 1 {
		t.Fatalf("got %d merged items, want 1", len(merged))
	}
	if merged[0].Flags != nil {
		t.Fatalf("expected an unflagged item to carry nil flags, got %v", merged[0].Flags)
	}

	raw, err := json.Marshal(map[string]any{"flags": flagsForResponse(merged[0].Flags)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := string(raw); got != `{"flags":[]}` {
		t.Errorf("response = %s, want {\"flags\":[]}", got)
	}
}
