package evm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// contractPath resolves the cross-language network table from this file's
// location rather than the test's working directory, so the check runs the same
// way under `go test ./...`, an IDE, or a container.
func contractPath(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve test file path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", ".."))
	return filepath.Join(root, "docs", "api", "networks.json")
}

type contractNetwork struct {
	ID             string `json:"id"`
	ChainID        int64  `json:"chainId"`
	Name           string `json:"name"`
	Kind           string `json:"kind"`
	NativeSymbol   string `json:"nativeSymbol"`
	NativeDecimals int    `json:"nativeDecimals"`
}

func readContract(t *testing.T) []contractNetwork {
	t.Helper()
	raw, err := os.ReadFile(contractPath(t))
	if err != nil {
		t.Fatalf("read network contract: %v", err)
	}
	var doc struct {
		Networks []contractNetwork `json:"networks"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse network contract: %v", err)
	}
	if len(doc.Networks) == 0 {
		t.Fatal("network contract is empty")
	}
	return doc.Networks
}

// TestStaticMetadataMatchesContract is the drift guard for the two network
// registries. Adding a chain to the client registry alone used to make
// wallet-api describe it with generic metadata (and claim it was a mainnet);
// this test fails instead.
func TestStaticMetadataMatchesContract(t *testing.T) {
	networks := readContract(t)

	byChainID := make(map[int64]contractNetwork, len(networks))
	for _, n := range networks {
		if _, dup := byChainID[n.ChainID]; dup {
			t.Fatalf("contract declares chain id %d twice", n.ChainID)
		}
		byChainID[n.ChainID] = n
	}

	if len(staticMetadata) != len(networks) {
		t.Errorf("staticMetadata has %d entries, contract has %d", len(staticMetadata), len(networks))
	}

	for chainID, want := range byChainID {
		got, ok := staticMetadata[chainID]
		if !ok {
			t.Errorf("staticMetadata is missing chain id %d (%s)", chainID, want.ID)
			continue
		}
		if got.ID != want.ID {
			t.Errorf("chain %d: ID = %q, want %q", chainID, got.ID, want.ID)
		}
		if got.Name != want.Name {
			t.Errorf("chain %d: Name = %q, want %q", chainID, got.Name, want.Name)
		}
		if got.Kind != want.Kind {
			t.Errorf("chain %d: Kind = %q, want %q", chainID, got.Kind, want.Kind)
		}
		if got.NativeSymbol != want.NativeSymbol {
			t.Errorf("chain %d: NativeSymbol = %q, want %q", chainID, got.NativeSymbol, want.NativeSymbol)
		}
		if got.NativeDecimals != want.NativeDecimals {
			t.Errorf("chain %d: NativeDecimals = %d, want %d", chainID, got.NativeDecimals, want.NativeDecimals)
		}
	}

	for chainID := range staticMetadata {
		if _, ok := byChainID[chainID]; !ok {
			t.Errorf("staticMetadata declares chain id %d, which the contract does not", chainID)
		}
	}
}

// TestGenericFallbackDoesNotClaimMainnet covers the safety property behind the
// KindUnknown constant: an unknown chain must never be reported as a real-funds
// network. The sample chain id is deliberately one no registry declares; if a
// chain is ever added with this id, pick another rather than weakening the test.
func TestGenericFallbackDoesNotClaimMainnet(t *testing.T) {
	const unknownChainID = int64(999_999_999)
	if _, declared := staticMetadata[unknownChainID]; declared {
		t.Fatalf("chain id %d is now declared; choose an unregistered id for this test", unknownChainID)
	}

	reg := NewRegistry(map[int64]int{unknownChainID: 1})
	n, ok := reg.ByChainID(unknownChainID)
	if !ok {
		t.Fatal("registry dropped a configured chain id")
	}
	if n.Kind == KindMainnet {
		t.Errorf("unknown chain %d reported as mainnet", n.ChainID)
	}
	if n.Kind != KindUnknown {
		t.Errorf("Kind = %q, want %q", n.Kind, KindUnknown)
	}
	if want := "evm-999999999"; n.ID != want {
		t.Errorf("ID = %q, want %s", n.ID, want)
	}
}

func TestRegistryUsesContractMetadataForKnownChain(t *testing.T) {
	reg := NewRegistry(map[int64]int{11155111: 1})
	n, ok := reg.ByChainID(11155111)
	if !ok {
		t.Fatal("sepolia missing from registry")
	}
	if n.Kind != KindTestnet {
		t.Errorf("sepolia Kind = %q, want %q", n.Kind, KindTestnet)
	}
	if n.NativeSymbol != "SepoliaETH" {
		t.Errorf("sepolia NativeSymbol = %q, want SepoliaETH", n.NativeSymbol)
	}
	if !n.Enabled {
		t.Error("sepolia should be enabled with one upstream")
	}
}

func TestRegistryDisablesChainWithNoUpstream(t *testing.T) {
	reg := NewRegistry(map[int64]int{1: 0})
	if len(reg.Enabled()) != 0 {
		t.Error("a chain id configured with zero upstreams must not be reported as enabled")
	}
}
