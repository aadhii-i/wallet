package btc

// Public-only BIP32 derivation for verifying shared-wallet migration destinations.
// No private extended keys, seed derivation or signing belong on this server.
import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
	"sort"

	ethcrypto "github.com/ethereum/go-ethereum/crypto"
)

func SharedPublicKey(root string, branch, index uint32) ([]byte, error) {
	if len(root) != 111 || branch > 1 || index >= 10000 {
		return nil, errors.New("invalid shared public derivation")
	}
	raw, err := base58Decode(root)
	if err != nil || len(raw) != 82 {
		return nil, errors.New("invalid public root")
	}
	first := sha256.Sum256(raw[:78])
	second := sha256.Sum256(first[:])
	if !bytes.Equal(raw[78:], second[:4]) || binary.BigEndian.Uint32(raw[:4]) != 0x043587cf {
		return nil, errors.New("wrong public root network or checksum")
	}
	chain := append([]byte(nil), raw[13:45]...)
	pub := append([]byte(nil), raw[45:78]...)
	curve := ethcrypto.S256()
	for _, child := range []uint32{branch, index} {
		point, err := ethcrypto.DecompressPubkey(pub)
		if err != nil {
			return nil, errors.New("invalid public point")
		}
		data := make([]byte, 37)
		copy(data, pub)
		binary.BigEndian.PutUint32(data[33:], child)
		mac := hmac.New(sha512.New, chain)
		_, _ = mac.Write(data)
		derived := mac.Sum(nil)
		scalar := new(big.Int).SetBytes(derived[:32])
		if scalar.Sign() == 0 || scalar.Cmp(curve.Params().N) >= 0 {
			return nil, errors.New("invalid BIP32 child")
		}
		x, y := curve.ScalarBaseMult(derived[:32])
		x, y = curve.Add(point.X, point.Y, x, y)
		if x == nil || y == nil || !curve.IsOnCurve(x, y) {
			return nil, errors.New("invalid BIP32 child point")
		}
		pub = make([]byte, 33)
		pub[0] = 2 + byte(y.Bit(0))
		x.FillBytes(pub[1:])
		chain = derived[32:]
	}
	return pub, nil
}

func SharedOutput(roots []string, threshold int, branch, index uint32) (address, scriptHex string, err error) {
	if len(roots) < 2 || len(roots) > 5 || threshold != len(roots)/2+1 {
		return "", "", errors.New("invalid native majority")
	}
	keys := make([][]byte, 0, len(roots))
	for _, root := range roots {
		pub, e := SharedPublicKey(root, branch, index)
		if e != nil {
			return "", "", e
		}
		keys = append(keys, pub)
	}
	sort.Slice(keys, func(i, j int) bool { return bytes.Compare(keys[i], keys[j]) < 0 })
	witness := []byte{byte(0x50 + threshold)}
	for i, pub := range keys {
		if i > 0 && bytes.Equal(pub, keys[i-1]) {
			return "", "", errors.New("duplicate native keys")
		}
		witness = append(witness, 33)
		witness = append(witness, pub...)
	}
	witness = append(witness, byte(0x50+len(keys)), 0xae)
	program := sha256.Sum256(witness)
	script := append([]byte{0, 32}, program[:]...)
	converted, e := convertBits(program[:], 8, 5, true)
	if e != nil {
		return "", "", e
	}
	data := append([]byte{0}, converted...)
	values := append(bech32HrpExpand("tb"), data...)
	values = append(values, 0, 0, 0, 0, 0, 0)
	checksum := bech32Polymod(values) ^ 1
	for i := 0; i < 6; i++ {
		data = append(data, byte(checksum>>uint(5*(5-i))&31))
	}
	encoded := "tb1"
	for _, value := range data {
		encoded += string(bech32Charset[value])
	}
	return encoded, hex.EncodeToString(script), nil
}
