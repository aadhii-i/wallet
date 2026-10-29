// Package evm holds the EVM network registry and history-provider
// interfaces described in spec §11.3 and §11.5.
package evm

// Network kinds reported over /v1/networks. KindUnknown is only used for a
// chain id supplied by configuration that has no entry in staticMetadata.
const (
	KindMainnet = "mainnet"
	KindTestnet = "testnet"
	KindLocal   = "local"
	KindUnknown = "unknown"
)

// Network describes one EVM chain wallet-api knows about.
type Network struct {
	ID             string `json:"id"`
	Family         string `json:"family"`
	ChainID        int64  `json:"chainId"`
	Name           string `json:"name"`
	Kind           string `json:"kind"` // mainnet | testnet | local | unknown
	NativeSymbol   string `json:"nativeSymbol"`
	NativeDecimals int    `json:"nativeDecimals"`
	Enabled        bool   `json:"-"`
}

// staticMetadata is the known-network table (spec §11.3), kept in lockstep with
// the client registry through docs/api/networks.json. Chain IDs configured via
// EVM_RPC_<id> that are not in this table still get a registry entry with
// generic metadata, so operators can add a network by configuration alone.
var staticMetadata = map[int64]Network{
	1:        {ID: "eth-mainnet", ChainID: 1, Name: "Ethereum", Kind: KindMainnet, NativeSymbol: "ETH", NativeDecimals: 18},
	11155111: {ID: "sepolia", ChainID: 11155111, Name: "Ethereum Sepolia", Kind: KindTestnet, NativeSymbol: "SepoliaETH", NativeDecimals: 18},
	8453:     {ID: "base", ChainID: 8453, Name: "Base", Kind: KindMainnet, NativeSymbol: "ETH", NativeDecimals: 18},
	42161:    {ID: "arbitrum", ChainID: 42161, Name: "Arbitrum One", Kind: KindMainnet, NativeSymbol: "ETH", NativeDecimals: 18},
	137:      {ID: "polygon", ChainID: 137, Name: "Polygon PoS", Kind: KindMainnet, NativeSymbol: "POL", NativeDecimals: 18},
	84532:    {ID: "base-sepolia", ChainID: 84532, Name: "Base Sepolia", Kind: KindTestnet, NativeSymbol: "ETH", NativeDecimals: 18},
	421614:   {ID: "arbitrum-sepolia", ChainID: 421614, Name: "Arbitrum Sepolia", Kind: KindTestnet, NativeSymbol: "ETH", NativeDecimals: 18},
	80002:    {ID: "amoy", ChainID: 80002, Name: "Polygon Amoy", Kind: KindTestnet, NativeSymbol: "POL", NativeDecimals: 18},
	31337:    {ID: "anvil", ChainID: 31337, Name: "Localhost (Anvil)", Kind: KindLocal, NativeSymbol: "ETH", NativeDecimals: 18},
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
			// Kind is deliberately not guessed. Claiming "mainnet" for a chain the
			// server does not know would let a testnet that only the client registry
			// knows about be reported as a real-funds network over /v1/networks.
			meta = Network{
				ID:             genericID(chainID),
				ChainID:        chainID,
				Name:           genericID(chainID),
				Kind:           KindUnknown,
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
