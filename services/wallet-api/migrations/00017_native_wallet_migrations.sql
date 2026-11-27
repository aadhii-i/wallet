-- +goose Up
CREATE TABLE native_wallet_migrations (
 id uuid PRIMARY KEY,
 source_wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
 target_wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
 status text NOT NULL CHECK(status IN ('draft','frozen','partial','complete','cancelled')),
 body jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 CHECK(source_wallet_id<>target_wallet_id)
);
CREATE UNIQUE INDEX native_wallet_migration_source ON native_wallet_migrations(source_wallet_id) WHERE status<>'cancelled';
CREATE INDEX native_wallet_migration_target ON native_wallet_migrations(target_wallet_id);
-- +goose Down
DROP TABLE native_wallet_migrations;
