-- +goose Up
-- addresses.network_family was originally pinned to 'evm'. Bitcoin and Hedera
-- registration both write to this table (store.FamilyBitcoin /
-- store.FamilyHedera), so widen the CHECK to the families the store declares.
ALTER TABLE addresses DROP CONSTRAINT IF EXISTS addresses_network_family_check;
ALTER TABLE addresses ADD CONSTRAINT addresses_network_family_check
    CHECK (network_family IN ('evm', 'bitcoin', 'monero', 'hedera'));

-- +goose Down
ALTER TABLE addresses DROP CONSTRAINT IF EXISTS addresses_network_family_check;
ALTER TABLE addresses ADD CONSTRAINT addresses_network_family_check
    CHECK (network_family = 'evm');
