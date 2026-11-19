-- +goose Up
-- Gas service (relayer) account history, read from chain receipts: incoming
-- recharges and outgoing gas payments for shared-wallet setup and execution.
CREATE TABLE gas_service_transfers (
    chain_id      bigint      NOT NULL,
    tx_hash       text        NOT NULL,
    address       text        NOT NULL,
    direction     text        NOT NULL CHECK (direction IN ('in', 'out')),
    kind          text        NOT NULL,
    counterparty  text        NOT NULL DEFAULT '',
    value_wei     text        NOT NULL DEFAULT '0',
    gas_used      bigint      NOT NULL DEFAULT 0,
    gas_price_wei text        NOT NULL DEFAULT '',
    fee_wei       text        NOT NULL DEFAULT '',
    success       boolean     NOT NULL,
    block_number  bigint      NOT NULL,
    block_time    timestamptz NOT NULL,
    proposal_id   uuid        REFERENCES proposals (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, tx_hash)
);
CREATE INDEX gas_service_transfers_by_address ON gas_service_transfers (chain_id, address, block_number DESC);

-- +goose Down
DROP TABLE gas_service_transfers;
