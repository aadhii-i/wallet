package sharedwallet

import (
	"testing"

	"github.com/qdwallet/wallet-api/internal/platform/config"
)

// Production relayer keys are accepted only for chains a shared-wallet
// proposal can actually target, and never for a mainnet or a local chain.
func TestProductionRelayerChainsAreExecutionTestnets(t *testing.T) {
	for id := range config.ProductionRelayerChains {
		if !ExecutionChainAllowed(id) {
			t.Errorf("production relayer chain %d is not a shared-wallet execution chain", id)
		}
	}
	for _, mainnet := range []int64{1, 10, 56, 137, 8453, 42161, 43114, 295} {
		if config.ProductionRelayerChains[mainnet] || ExecutionChainAllowed(mainnet) {
			t.Errorf("mainnet %d is allowed", mainnet)
		}
	}
	if config.ProductionRelayerChains[31337] {
		t.Error("local Anvil is allowed in production")
	}
}
