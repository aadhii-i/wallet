// Package evm holds the EVM network registry and history-provider
// interfaces described in spec §11.3 and §11.5.
package evm

// Network describes one EVM chain wallet-api knows about.
type Network struct {
	ID             string `json:"id"`
	Family         string `json:"family"`
	ChainID        int64  `json:"chainId"`
	Name           string `json:"name"`
	Kind           string `json:"kind"` // mainnet | testnet | local
	NativeSymbol   string `json:"nativeSymbol"`
	NativeDecimals int    `json:"nativeDecimals"`
	Enabled        bool   `json:"-"`
}

// staticMetadata is the known-network table (spec §11.3). Chain IDs
// configured via EVM_RPC_<id> that are not in this table still get a
// registry entry with generic metadata, so operators can add a network by
// configuration alone.
var staticMetadata = map[int64]Network{
	1:        {ID: "eth-mainnet", ChainID: 1, Name: "Ethereum", Kind: "mainnet", NativeSymbol: "ETH", NativeDecimals: 18},
	11155111: {ID: "sepolia", ChainID: 11155111, Name: "Ethereum Sepolia", Kind: "testnet", NativeSymbol: "ETH", NativeDecimals: 18},
	8453:     {ID: "base", ChainID: 8453, Name: "Base", Kind: "mainnet", NativeSymbol: "ETH", NativeDecimals: 18},
	42161:    {ID: "arbitrum", ChainID: 42161, Name: "Arbitrum One", Kind: "mainnet", NativeSymbol: "ETH", NativeDecimals: 18},
	137:      {ID: "polygon", ChainID: 137, Name: "Polygon PoS", Kind: "mainnet", NativeSymbol: "POL", NativeDecimals: 18},
	31337:    {ID: "anvil", ChainID: 31337, Name: "Anvil (local)", Kind: "local", NativeSymbol: "ETH", NativeDecimals: 18},
}

// Registry is a lookup of the networks known to this server instance,
// keyed by network id and by chain id.
type Registry struct {
	byID      map[string]*Network
	byChainID map[int64]*Network
	ordered   []*Network
}

// NewRegistry builds a registry from the set of chain IDs that have at
// least one configured RPC upstream (upstreamsByChain maps chainID -> count
// of upstreams > 0 means enabled).
func NewRegistry(upstreamsByChain map[int64]int) *Registry {
	reg := &Registry{byID: map[string]*Network{}, byChainID: map[int64]*Network{}}
	for chainID, count := range upstreamsByChain {
		meta, ok := staticMetadata[chainID]
		if !ok {
			meta = Network{
				ID:             genericID(chainID),
				ChainID:        chainID,
				Name:           genericID(chainID),
				Kind:           "mainnet",
				NativeSymbol:   "ETH",
				NativeDecimals: 18,
			}
		}
		meta.Family = "evm"
		meta.Enabled = count > 0
		n := meta
		reg.byID[n.ID] = &n
		reg.byChainID[n.ChainID] = &n
		reg.ordered = append(reg.ordered, &n)
	}
	return reg
}

func genericID(chainID int64) string {
	return "evm-" + itoa(chainID)
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func (r *Registry) ByChainID(chainID int64) (*Network, bool) {
	n, ok := r.byChainID[chainID]
	return n, ok
}

func (r *Registry) ByID(id string) (*Network, bool) {
	n, ok := r.byID[id]
	return n, ok
}

// Enabled returns every enabled network, for GET /v1/networks.
func (r *Registry) Enabled() []*Network {
	out := make([]*Network, 0, len(r.ordered))
	for _, n := range r.ordered {
		if n.Enabled {
			out = append(out, n)
		}
	}
	return out
}
