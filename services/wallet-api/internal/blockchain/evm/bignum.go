package evm

import "math/big"

// hexToBigDecimal converts a hex string (no 0x prefix) into a base-10
// decimal string, using math/big so amounts of any size are exact (no
// floats anywhere, per spec).
func hexToBigDecimal(hexStr string) string {
	n := new(big.Int)
	if _, ok := n.SetString(hexStr, 16); !ok {
		return "0"
	}
	return n.String()
}
