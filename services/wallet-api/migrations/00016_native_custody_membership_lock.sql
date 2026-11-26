-- +goose Up
ALTER TABLE shared_wallets ADD COLUMN native_custody_locked boolean NOT NULL DEFAULT false;

-- Existing native custody must receive the same protection as new enrollment.
-- A policy confirmation is device-signed; the owner is immutable in this model.
UPDATE shared_wallets w SET native_custody_locked=true
WHERE EXISTS (
  SELECT 1 FROM (
    SELECT scope, author, kind FROM bitcoin_shared_messages
    UNION ALL SELECT scope, author, kind FROM hedera_shared_messages
  ) native
  JOIN shared_wallet_members m ON m.id=native.author AND m.wallet_id=w.id AND m.role='owner'
  WHERE split_part(native.scope,'|',1)=w.id::text AND native.kind='policy'
);

-- +goose Down
ALTER TABLE shared_wallets DROP COLUMN native_custody_locked;
