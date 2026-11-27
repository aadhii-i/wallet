package nativecustody

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPublicPolicyContractFromJavaScriptSigner(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/api/native-policy-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var entries []struct {
		Chain     string `json:"chain"`
		Policy    Policy `json:"policy"`
		PolicyID  string `json:"policyId"`
		Key       string `json:"thresholdEncoding"`
		Addresses []struct {
			Branch  uint32 `json:"branch"`
			Index   uint32 `json:"index"`
			Address string `json:"address"`
			Script  string `json:"script"`
		} `json:"addresses"`
	}
	if err = json.Unmarshal(raw, &entries); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		id, err := ValidatePolicy(entry.Policy)
		if err != nil || id != entry.PolicyID {
			t.Fatalf("%s policy contract mismatch: %v", entry.Chain, err)
		}
		if entry.Chain == "bitcoin" {
			for _, expected := range entry.Addresses {
				address, script, err := entry.Policy.BitcoinOutput(expected.Branch, expected.Index)
				if err != nil || address != expected.Address || script != expected.Script {
					t.Fatalf("Bitcoin derivation mismatch: %v", err)
				}
			}
		} else {
			key, err := entry.Policy.HederaKey()
			if err != nil || key != entry.Key {
				t.Fatalf("Hedera protobuf key mismatch: %v", err)
			}
		}
		weakened := entry.Policy
		weakened.NativeThreshold = 1
		if _, err := ValidatePolicy(weakened); err == nil {
			t.Fatal("weakened native threshold accepted")
		}
		changed := entry.Policy
		changed.Context.MembershipVersion++
		if _, err := ValidatePolicy(changed); err == nil {
			t.Fatal("substituted epoch accepted")
		}
		corrupt := entry.Policy
		corrupt.Members = append([]Enrollment(nil), corrupt.Members...)
		corrupt.Members[0].Proof = "00"
		if _, err := ValidatePolicy(corrupt); err == nil {
			t.Fatal("forged native enrollment accepted")
		}
	}
}
