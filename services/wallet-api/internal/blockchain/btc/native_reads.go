package btc

import (
	"context"
	"errors"
	"strings"
)

// NativeMigrationIdentity forbids mainnet and mismatched upstreams. Read-only.
func (s *Service) NativeMigrationIdentity(ctx context.Context) error {
	if s.network != NetworkTestnet4 {
		return errors.New("native migration requires Bitcoin Testnet4")
	}
	body, err := s.esplora.get(ctx, "/block-height/0")
	if err != nil {
		return errors.New("Bitcoin network identity unavailable")
	}
	if strings.TrimSpace(string(body)) != "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043" {
		return errors.New("Bitcoin network identity mismatch")
	}
	return nil
}
func (s *Service) NativeMigrationAddress(ctx context.Context, address string) (bool, []UTXO, error) {
	if ValidateAddress(address, NetworkTestnet4) != nil {
		return false, nil, ErrInvalidAddress
	}
	history, err := s.esplora.GetAddressTxs(ctx, address, "")
	if err != nil {
		return false, nil, errors.New("Bitcoin discovery unavailable")
	}
	coins, err := s.UTXOs(ctx, address)
	return len(history) > 0, coins, err
}
func (s *Service) NativeMigrationTransaction(ctx context.Context, txid string) (*EsploraTx, int64, error) {
	if !validTxID(txid) {
		return nil, 0, ErrInvalidTxID
	}
	tx, err := s.esplora.GetTransaction(ctx, txid)
	if err != nil {
		return nil, 0, err
	}
	if tx.TxID != txid || !tx.Status.Confirmed || tx.Status.BlockHeight <= 0 {
		return nil, 0, errors.New("Bitcoin migration is not confirmed")
	}
	tip, err := s.esplora.GetTipHeight(ctx)
	if err != nil {
		return nil, 0, err
	}
	if tip < tx.Status.BlockHeight {
		return nil, 0, errors.New("invalid Bitcoin confirmation height")
	}
	return tx, tip - tx.Status.BlockHeight + 1, nil
}
