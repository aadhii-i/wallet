package evm

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RPCCaller is the minimal surface the scanner needs from an RPC provider
// pool. *rpc.Pool satisfies this implicitly.
type RPCCaller interface {
	Call(ctx context.Context, method string, params any) (json.RawMessage, error)
}

const (
	scannerMaxBlocks   = 5000
	scannerLogsChunk   = 2000
	scannerCacheTTL    = 10 * time.Second
	erc20TransferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
)

// ScannerProvider implements HistoryProvider for local/dev chains (Anvil)
// by scanning recent blocks for native transfers and eth_getLogs for ERC-20
// Transfer events, since there is no indexing service available locally.
type ScannerProvider struct {
	caller RPCCaller

	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	items     []ActivityItem
	expiresAt time.Time
}

func NewScannerProvider(caller RPCCaller) *ScannerProvider {
	return &ScannerProvider{caller: caller, cache: map[string]cacheEntry{}}
}

func (s *ScannerProvider) FetchActivity(ctx context.Context, networkID string, addresses []string) ([]ActivityItem, error) {
	key := networkID + "|" + strings.Join(addresses, ",")
	s.mu.Lock()
	if e, ok := s.cache[key]; ok && time.Now().Before(e.expiresAt) {
		s.mu.Unlock()
		return e.items, nil
	}
	s.mu.Unlock()

	items, err := s.scan(ctx, networkID, addresses)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.cache[key] = cacheEntry{items: items, expiresAt: time.Now().Add(scannerCacheTTL)}
	s.mu.Unlock()
	return items, nil
}

func (s *ScannerProvider) scan(ctx context.Context, networkID string, addresses []string) ([]ActivityItem, error) {
	addrSet := make(map[string]struct{}, len(addresses))
	for _, a := range addresses {
		addrSet[strings.ToLower(a)] = struct{}{}
	}

	latest, err := s.blockNumber(ctx)
	if err != nil {
		return nil, err
	}
	from := int64(0)
	if latest > scannerMaxBlocks {
		from = latest - scannerMaxBlocks + 1
	}

	var items []ActivityItem
	native, err := s.scanNativeTransfers(ctx, networkID, addrSet, from, latest)
	if err != nil {
		return nil, err
	}
	items = append(items, native...)

	erc20, err := s.scanERC20Transfers(ctx, networkID, addrSet, from, latest)
	if err != nil {
		return nil, err
	}
	items = append(items, erc20...)

	return items, nil
}

func (s *ScannerProvider) blockNumber(ctx context.Context) (int64, error) {
	raw, err := s.caller.Call(ctx, "eth_blockNumber", []any{})
	if err != nil {
		return 0, err
	}
	var hexStr string
	if err := json.Unmarshal(raw, &hexStr); err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(hexStr, "0x"), 16, 64)
	if err != nil {
		return 0, err
	}
	return n, nil
}

type rpcBlock struct {
	Number       string  `json:"number"`
	Timestamp    string  `json:"timestamp"`
	Transactions []rpcTx `json:"transactions"`
}

type rpcTx struct {
	Hash  string `json:"hash"`
	From  string `json:"from"`
	To    string `json:"to"`
	Value string `json:"value"`
}

func (s *ScannerProvider) scanNativeTransfers(ctx context.Context, networkID string, addrSet map[string]struct{}, from, to int64) ([]ActivityItem, error) {
	var items []ActivityItem
	for n := from; n <= to; n++ {
		raw, err := s.caller.Call(ctx, "eth_getBlockByNumber", []any{toHex(n), true})
		if err != nil {
			return nil, err
		}
		var block rpcBlock
		if err := json.Unmarshal(raw, &block); err != nil || block.Number == "" {
			continue
		}
		ts, _ := strconv.ParseInt(strings.TrimPrefix(block.Timestamp, "0x"), 16, 64)
		blockNum, _ := strconv.ParseInt(strings.TrimPrefix(block.Number, "0x"), 16, 64)
		for _, tx := range block.Transactions {
			from := strings.ToLower(tx.From)
			to := strings.ToLower(tx.To)
			_, fromKnown := addrSet[from]
			_, toKnown := addrSet[to]
			if !fromKnown && !toKnown {
				continue
			}
			direction := "in"
			if fromKnown && toKnown {
				direction = "self"
			} else if fromKnown {
				direction = "out"
			}
			amount := hexToDecimalString(tx.Value)
			items = append(items, ActivityItem{
				Hash: tx.Hash, NetworkID: networkID, Direction: direction,
				From: tx.From, To: tx.To, AssetID: networkID + ":native", Amount: amount,
				Status: "confirmed", BlockNumber: blockNum, Timestamp: ts,
			})
		}
	}
	return items, nil
}

type rpcLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	TxHash      string   `json:"transactionHash"`
}

func (s *ScannerProvider) scanERC20Transfers(ctx context.Context, networkID string, addrSet map[string]struct{}, from, to int64) ([]ActivityItem, error) {
	var items []ActivityItem
	for chunkFrom := from; chunkFrom <= to; chunkFrom += scannerLogsChunk {
		chunkTo := chunkFrom + scannerLogsChunk - 1
		if chunkTo > to {
			chunkTo = to
		}
		filter := map[string]any{
			"fromBlock": toHex(chunkFrom),
			"toBlock":   toHex(chunkTo),
			"topics":    []any{erc20TransferTopic},
		}
		raw, err := s.caller.Call(ctx, "eth_getLogs", []any{filter})
		if err != nil {
			return nil, err
		}
		var logs []rpcLog
		if err := json.Unmarshal(raw, &logs); err != nil {
			continue
		}
		for _, l := range logs {
			if len(l.Topics) < 3 {
				continue
			}
			from := "0x" + strings.TrimPrefix(l.Topics[1], "0x")[24:]
			to := "0x" + strings.TrimPrefix(l.Topics[2], "0x")[24:]
			fromLower := strings.ToLower(from)
			toLower := strings.ToLower(to)
			_, fromKnown := addrSet[fromLower]
			_, toKnown := addrSet[toLower]
			if !fromKnown && !toKnown {
				continue
			}
			direction := "in"
			if fromKnown && toKnown {
				direction = "self"
			} else if fromKnown {
				direction = "out"
			}
			blockNum, _ := strconv.ParseInt(strings.TrimPrefix(l.BlockNumber, "0x"), 16, 64)
			amount := hexToDecimalString(l.Data)
			items = append(items, ActivityItem{
				Hash: l.TxHash, NetworkID: networkID, Direction: direction,
				From: from, To: to, AssetID: networkID + ":" + strings.ToLower(l.Address), Amount: amount,
				Status: "confirmed", BlockNumber: blockNum,
			})
		}
	}
	return items, nil
}

func toHex(n int64) string {
	return fmt.Sprintf("0x%x", n)
}

// hexToDecimalString converts a 0x-prefixed hex integer into a base-10
// decimal string without ever going through a float.
func hexToDecimalString(hexStr string) string {
	hexStr = strings.TrimPrefix(hexStr, "0x")
	if hexStr == "" {
		return "0"
	}
	// Trim leading zeros for a cheap big-int-free decimal conversion using
	// repeated division would be more code than this problem needs; use
	// math/big for correctness on arbitrarily large values.
	return hexToBigDecimal(hexStr)
}
