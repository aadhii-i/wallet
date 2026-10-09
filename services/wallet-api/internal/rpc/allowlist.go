// Package rpc implements the authenticated JSON-RPC proxy described in spec
// §25: a method allowlist, a per-chain provider pool with health checks,
// circuit breakers, retries/failover for reads, and safe handling of
// eth_sendRawTransaction (never blindly resent with a different payload).
package rpc

import "strconv"

// Allowlist is the exact EVM method allowlist from spec §25.3. Anything not
// in this set is rejected per JSON-RPC item with error -32601.
var Allowlist = map[string]struct{}{
	"eth_chainId":               {},
	"eth_blockNumber":           {},
	"eth_getBalance":            {},
	"eth_getTransactionCount":   {},
	"eth_call":                  {},
	"eth_estimateGas":           {},
	"eth_feeHistory":            {},
	"eth_maxPriorityFeePerGas":  {},
	"eth_gasPrice":              {},
	"eth_getBlockByNumber":      {},
	"eth_getTransactionByHash":  {},
	"eth_getTransactionReceipt": {},
	"eth_sendRawTransaction":    {},
	"eth_getCode":               {},
	"eth_getLogs":               {},
}

func IsAllowed(method string) bool {
	_, ok := Allowlist[method]
	return ok
}

// isReadMethod reports whether failover/retry across providers is safe for
// this method. eth_sendRawTransaction is explicitly excluded: retrying it
// blindly could double-broadcast under some provider semantics, so it gets
// its own careful handling (see proxy.go).
func isReadMethod(method string) bool {
	return method != "eth_sendRawTransaction"
}

// MaxLogsRange is the maximum inclusive block range allowed for
// eth_getLogs (spec §25.3).
const MaxLogsRange = 2000

// MaxBatchSize is the maximum number of items in a JSON-RPC batch request.
const MaxBatchSize = 20

// MaxBodyBytes is the JSON-RPC proxy's own body size limit (spec: 256 KB),
// larger than the default 64 KB body limit applied to other routes.
const MaxBodyBytes = 256 * 1024

// parseHexBlock parses a hex block number ("0x..."). It returns ok=false for
// tags like "latest"/"pending"/"earliest", which eth_getLogs range checks
// must treat as "not an explicit number" per spec (only explicit hex
// numbers are allowed for range-checked calls).
func parseHexBlock(s string) (uint64, bool) {
	if len(s) < 3 || s[0] != '0' || (s[1] != 'x' && s[1] != 'X') {
		return 0, false
	}
	v, err := strconv.ParseUint(s[2:], 16, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
