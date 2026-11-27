package nativecustody

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"strconv"

	"github.com/qdwallet/wallet-api/internal/blockchain/btc"
)

func compactSize(reader *bytes.Reader) (uint64, error) {
	first, err := reader.ReadByte()
	if err != nil {
		return 0, err
	}
	switch first {
	case 253:
		var n uint16
		err = binary.Read(reader, binary.LittleEndian, &n)
		if n < 253 {
			return 0, invalid("noncanonical compact size")
		}
		return uint64(n), err
	case 254:
		var n uint32
		err = binary.Read(reader, binary.LittleEndian, &n)
		if n <= 65535 {
			return 0, invalid("noncanonical compact size")
		}
		return uint64(n), err
	case 255:
		return 0, invalid("oversized compact size")
	default:
		return uint64(first), nil
	}
}
func reviewedPSBT(text string) (txid string, points []string, amount int64, script string, err error) {
	fail := func() (string, []string, int64, string, error) {
		return "", nil, 0, "", invalid("invalid migration PSBT")
	}
	raw, err := base64.StdEncoding.DecodeString(text)
	if err != nil || len(raw) > 1000000 || !bytes.HasPrefix(raw, []byte{'p', 's', 'b', 't', 255}) {
		return fail()
	}
	reader := bytes.NewReader(raw[5:])
	var unsigned []byte
	for count := 0; count < 1024; count++ {
		length, e := compactSize(reader)
		if e != nil {
			return fail()
		}
		if length == 0 {
			break
		}
		if length > 1000 || length > uint64(reader.Len()) {
			return fail()
		}
		key := make([]byte, int(length))
		_, _ = io.ReadFull(reader, key)
		length, e = compactSize(reader)
		if e != nil || length > uint64(reader.Len()) {
			return fail()
		}
		value := make([]byte, int(length))
		_, _ = io.ReadFull(reader, value)
		if len(key) == 1 && key[0] == 0 {
			if unsigned != nil {
				return fail()
			}
			unsigned = value
		}
	}
	if len(unsigned) < 10 {
		return fail()
	}
	r := bytes.NewReader(unsigned)
	var version uint32
	if binary.Read(r, binary.LittleEndian, &version) != nil || version != 2 {
		return fail()
	}
	count, e := compactSize(r)
	if e != nil || count < 1 || count > 100 {
		return fail()
	}
	seen := map[string]bool{}
	for i := uint64(0); i < count; i++ {
		hash := make([]byte, 32)
		if _, e = io.ReadFull(r, hash); e != nil {
			return fail()
		}
		var output, sequence uint32
		if binary.Read(r, binary.LittleEndian, &output) != nil {
			return fail()
		}
		length, e := compactSize(r)
		if e != nil || length != 0 {
			return fail()
		}
		if binary.Read(r, binary.LittleEndian, &sequence) != nil || sequence != 0xffffffff {
			return fail()
		}
		for a, b := 0, len(hash)-1; a < b; a, b = a+1, b-1 {
			hash[a], hash[b] = hash[b], hash[a]
		}
		point := fmt.Sprintf("%s:%d", hex.EncodeToString(hash), output)
		if seen[point] {
			return fail()
		}
		seen[point] = true
		points = append(points, point)
	}
	outputs, e := compactSize(r)
	if e != nil || outputs != 1 {
		return fail()
	}
	var value uint64
	if binary.Read(r, binary.LittleEndian, &value) != nil || value == 0 || value > 2100000000000000 {
		return fail()
	}
	length, e := compactSize(r)
	if e != nil || length != 34 {
		return fail()
	}
	outputScript := make([]byte, int(length))
	if _, e = io.ReadFull(r, outputScript); e != nil {
		return fail()
	}
	var lock uint32
	if binary.Read(r, binary.LittleEndian, &lock) != nil || lock != 0 || r.Len() != 0 {
		return fail()
	}
	first := sha256.Sum256(unsigned)
	second := sha256.Sum256(first[:])
	for a, b := 0, len(second)-1; a < b; a, b = a+1, b-1 {
		second[a], second[b] = second[b], second[a]
	}
	return hex.EncodeToString(second[:]), points, int64(value), hex.EncodeToString(outputScript), nil
}
func coinPoint(coin MigrationCoin) string { return fmt.Sprintf("%s:%d", coin.TxID, coin.Vout) }
func (s *Coordinator) validateCoins(ctx context.Context, policy Policy, coins []MigrationCoin) error {
	if len(coins) > 1000 {
		return invalid("select at most one thousand coins for a migration snapshot")
	}
	if s.bitcoin == nil {
		return invalid("Bitcoin verification unavailable")
	}
	if err := s.bitcoin.NativeMigrationIdentity(ctx); err != nil {
		return err
	}
	roots := make([]string, len(policy.Members))
	for i, m := range policy.Members {
		roots[i] = m.Xpub
	}
	seen := map[string]bool{}
	parents := map[string]*btc.EsploraTx{}
	depth := map[string]int64{}
	total := int64(0)
	for _, coin := range coins {
		value, err := strconv.ParseInt(coin.Value, 10, 64)
		if err != nil || value <= 0 || value > 2100000000000000 || !regexpTxID.MatchString(coin.TxID) || coin.Branch > 1 || coin.Index >= 10000 || coin.Branch == 0 && coin.Index != 0 || seen[coinPoint(coin)] {
			return invalid("invalid or duplicate nominated Bitcoin coin")
		}
		seen[coinPoint(coin)] = true
		total += value
		if total > 2100000000000000 {
			return invalid("Bitcoin snapshot exceeds the money supply")
		}
		parent := parents[coin.TxID]
		if parent == nil {
			var count int64
			parent, count, err = s.bitcoin.NativeMigrationTransaction(ctx, coin.TxID)
			if err != nil || parent == nil || parent.TxID != coin.TxID || count < 1 {
				return invalid("a nominated Bitcoin coin is not confirmed")
			}
			parents[coin.TxID] = parent
			depth[coin.TxID] = count
		}
		if uint64(coin.Vout) >= uint64(len(parent.Vout)) || len(parent.Vin) == 1 && parent.Vin[0].IsCoinbase && depth[coin.TxID] < 100 {
			return invalid("nominated Bitcoin output is missing or immature")
		}
		_, script, err := btc.SharedOutput(roots, policy.NativeThreshold, coin.Branch, coin.Index)
		if err != nil {
			return err
		}
		output := parent.Vout[coin.Vout]
		if output.Scriptpubkey != script || output.Value != value {
			return invalid("nominated Bitcoin coin is not owned by the source policy")
		}
	}
	return nil
}
