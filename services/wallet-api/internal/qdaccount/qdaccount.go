// Package qdaccount is the Go side of packages/qd-account: deterministic
// addresses of the QD contracts, the execution message a shared wallet's
// signers sign, and calldata for the relayer. Contract artifacts are the
// committed artifacts.json (generated from contracts/ by
// packages/qd-account/scripts/gen-artifacts.mjs).
package qdaccount

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

//go:embed artifacts.json
var artifactsJSON []byte

type artifact struct {
	ABI      json.RawMessage `json:"abi"`
	Bytecode string          `json:"bytecode"`
}

// Deployer is the deterministic-deployment proxy (pre-installed by Anvil).
var Deployer = common.HexToAddress("0x4e59b44847b379578588920ca78fbf26c0b4956c")

// DeploySalt = keccak256("QDWallet.contracts.v1"), as in packages/qd-account.
var DeploySalt = crypto.Keccak256Hash([]byte("QDWallet.contracts.v1"))

// MatrixEntries is K·L. MatrixEntriesPerTx keeps the computation of each
// expansion transaction under the EIP-7825 per-transaction cap (~3.7M compute
// gas per entry). Total gas per entry is ~5.3M before Amsterdam and ~16.5M
// under Amsterdam (EIP-8037), whose state-creation gas is outside that cap.
const (
	MatrixEntries      = 20
	MatrixEntriesPerTx = 2
)

var (
	VerifierABI, AccountABI, FactoryABI    abi.ABI
	verifierCode, accountCode, factoryCode []byte
	executeTypehash                        = crypto.Keccak256Hash([]byte(
		"QDWallet.Execute(uint256 chainId,address account,uint256 nonce,address to,uint256 value,bytes32 dataHash,uint256 callGasLimit,uint256 validUntil,bytes32 proposalDigest)"))
)

func init() {
	var all map[string]artifact
	if err := json.Unmarshal(artifactsJSON, &all); err != nil {
		panic(err)
	}
	load := func(name string) (abi.ABI, []byte) {
		a, ok := all[name]
		if !ok {
			panic("qdaccount: missing artifact " + name)
		}
		parsed, err := abi.JSON(strings.NewReader(string(a.ABI)))
		if err != nil {
			panic(err)
		}
		return parsed, common.FromHex(a.Bytecode)
	}
	VerifierABI, verifierCode = load("QdRaccoonVerifier")
	AccountABI, accountCode = load("QdAccount")
	FactoryABI, factoryCode = load("QdAccountFactory")
}

func word(b []byte) []byte { return common.LeftPadBytes(b, 32) }

func VerifierInitCode() []byte { return verifierCode }

func FactoryInitCode() []byte {
	return append(append([]byte{}, factoryCode...), word(VerifierAddress().Bytes())...)
}

func VerifierAddress() common.Address {
	return crypto.CreateAddress2(Deployer, DeploySalt, crypto.Keccak256(VerifierInitCode()))
}

func FactoryAddress() common.Address {
	return crypto.CreateAddress2(Deployer, DeploySalt, crypto.Keccak256(FactoryInitCode()))
}

// AccountAddress is QdAccountFactory.accountAddress(publicKeyHash).
func AccountAddress(publicKeyHash [32]byte) common.Address {
	init := append(append(append([]byte{}, accountCode...), word(VerifierAddress().Bytes())...), publicKeyHash[:]...)
	return crypto.CreateAddress2(FactoryAddress(), publicKeyHash, crypto.Keccak256(init))
}

// DeployerCalldata is salt ‖ initCode for the deterministic deployer.
func DeployerCalldata(initCode []byte) []byte {
	return append(append([]byte{}, DeploySalt.Bytes()...), initCode...)
}

// Call mirrors QdAccount.Call (field names match the ABI tuple components).
type Call struct {
	Nonce          *big.Int
	To             common.Address
	Value          *big.Int
	Data           []byte
	CallGasLimit   *big.Int
	ValidUntil     *big.Int
	ProposalDigest [32]byte
}

// ExecutionMessage is QdAccount.executionMessage: the 32-byte message the
// Threshold Raccoon signers sign.
func ExecutionMessage(chainID *big.Int, account common.Address, c *Call) [32]byte {
	enc := make([]byte, 0, 320)
	enc = append(enc, executeTypehash.Bytes()...)
	enc = append(enc, word(chainID.Bytes())...)
	enc = append(enc, word(account.Bytes())...)
	enc = append(enc, word(c.Nonce.Bytes())...)
	enc = append(enc, word(c.To.Bytes())...)
	enc = append(enc, word(c.Value.Bytes())...)
	enc = append(enc, crypto.Keccak256(c.Data)...)
	enc = append(enc, word(c.CallGasLimit.Bytes())...)
	enc = append(enc, word(c.ValidUntil.Bytes())...)
	enc = append(enc, c.ProposalDigest[:]...)
	var out [32]byte
	copy(out[:], crypto.Keccak256(enc))
	return out
}

func ExecuteCalldata(c *Call, publicKey, signature []byte) ([]byte, error) {
	return AccountABI.Pack("execute", *c, publicKey, signature)
}

func ExpandMatrixCalldata(seedA [32]byte, first, count int) ([]byte, error) {
	return VerifierABI.Pack("expandMatrix", seedA, big.NewInt(int64(first)), big.NewInt(int64(count)))
}

func MatrixReadyCalldata(seedA [32]byte) ([]byte, error) {
	return VerifierABI.Pack("matrixReady", seedA)
}

func VerifyCalldata(publicKey []byte, message [32]byte, signature []byte) ([]byte, error) {
	return VerifierABI.Pack("verify", publicKey, message, signature)
}

func CreateAccountCalldata(publicKeyHash [32]byte) ([]byte, error) {
	return FactoryABI.Pack("createAccount", publicKeyHash)
}

func NonceCalldata() ([]byte, error) { return AccountABI.Pack("nonce") }

// MatrixEntryCalldata reads verifier.matrixEntry(seedA, index): the data
// contract holding entry index of A, or the zero address if not expanded.
func MatrixEntryCalldata(seedA [32]byte, index int) ([]byte, error) {
	return VerifierABI.Pack("matrixEntry", seedA, big.NewInt(int64(index)))
}

// AccountVerifierCalldata reads QdAccount.verifier().
func AccountVerifierCalldata() ([]byte, error) { return AccountABI.Pack("verifier") }

// AccountPublicKeyHashCalldata reads QdAccount.publicKeyHash().
func AccountPublicKeyHashCalldata() ([]byte, error) { return AccountABI.Pack("publicKeyHash") }

// FactoryAccountAddressCalldata reads QdAccountFactory.accountAddress(pkHash).
func FactoryAccountAddressCalldata(publicKeyHash [32]byte) ([]byte, error) {
	return FactoryABI.Pack("accountAddress", publicKeyHash)
}

// ExecutedEvent is the decoded QdAccount.Executed log.
type ExecutedEvent struct {
	Nonce          *big.Int
	Message        [32]byte
	ProposalDigest [32]byte
	To             common.Address
	Value          *big.Int
	Success        bool
}

// ExecutedTopic is the event signature hash of QdAccount.Executed.
func ExecutedTopic() common.Hash { return AccountABI.Events["Executed"].ID }

// DecodeExecuted parses an Executed log (topics + data).
func DecodeExecuted(topics []common.Hash, data []byte) (*ExecutedEvent, error) {
	if len(topics) != 4 || topics[0] != ExecutedTopic() {
		return nil, fmt.Errorf("qdaccount: not an Executed log")
	}
	vals, err := AccountABI.Events["Executed"].Inputs.NonIndexed().Unpack(data)
	if err != nil || len(vals) != 3 {
		return nil, fmt.Errorf("qdaccount: bad Executed data: %v", err)
	}
	ev := &ExecutedEvent{Nonce: new(big.Int).SetBytes(topics[1].Bytes())}
	copy(ev.Message[:], topics[2].Bytes())
	copy(ev.ProposalDigest[:], topics[3].Bytes())
	var ok bool
	if ev.To, ok = vals[0].(common.Address); !ok {
		return nil, fmt.Errorf("qdaccount: bad Executed.to")
	}
	if ev.Value, ok = vals[1].(*big.Int); !ok {
		return nil, fmt.Errorf("qdaccount: bad Executed.value")
	}
	if ev.Success, ok = vals[2].(bool); !ok {
		return nil, fmt.Errorf("qdaccount: bad Executed.success")
	}
	return ev, nil
}
