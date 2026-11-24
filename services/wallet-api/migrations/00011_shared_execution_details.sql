-- +goose Up
-- Relayer progress and receipt details for shared-wallet executions:
-- what stage the relayer is in, one-time setup progress (so a restart resumes
-- rather than repeating paid transactions), and the verified receipt fields
-- shown on the transaction receipt.
ALTER TABLE shared_executions
    ADD COLUMN stage text NOT NULL DEFAULT 'queued',
    ADD COLUMN setup_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN next_attempt_at timestamptz,
    ADD COLUMN setup_txs text[] NOT NULL DEFAULT '{}',
    ADD COLUMN pending_setup_tx text NOT NULL DEFAULT '',
    ADD COLUMN tx_nonce bigint,
    ADD COLUMN effective_gas_price text NOT NULL DEFAULT '',
    ADD COLUMN block_time timestamptz,
    ADD COLUMN executed_to text NOT NULL DEFAULT '',
    ADD COLUMN executed_value text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX shared_executions_tx_hash ON shared_executions (chain_id, tx_hash) WHERE tx_hash <> '';

-- +goose Down
DROP INDEX shared_executions_tx_hash;
ALTER TABLE shared_executions
    DROP COLUMN stage, DROP COLUMN setup_attempts, DROP COLUMN next_attempt_at, DROP COLUMN setup_txs,
    DROP COLUMN pending_setup_tx, DROP COLUMN tx_nonce, DROP COLUMN effective_gas_price, DROP COLUMN block_time,
    DROP COLUMN executed_to, DROP COLUMN executed_value;
