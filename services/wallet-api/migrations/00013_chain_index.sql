-- +goose Up
-- Chain index: value transfers read from receipts and logs for known
-- addresses (personal wallet addresses and shared QdAccount addresses), the
-- persistent source of personal Activity and shared Wallet History.
-- log_index: -1 the transaction's own value transfer, -2 an unexplained
-- balance increase (internal transfer), >= 0 the Executed / ERC-20 log.
CREATE TABLE chain_transfers (
    chain_id      bigint      NOT NULL,
    tx_hash       text        NOT NULL,
    log_index     bigint      NOT NULL,
    kind          text        NOT NULL CHECK (kind IN ('native', 'qd_execute', 'erc20', 'internal')),
    from_address  text        NOT NULL,
    to_address    text        NOT NULL,
    token         text        NOT NULL DEFAULT '',
    amount        numeric(78) NOT NULL CHECK (amount >= 0),
    tx_from       text        NOT NULL DEFAULT '',
    tx_to         text        NOT NULL DEFAULT '',
    success       boolean     NOT NULL,
    block_number  bigint      NOT NULL,
    block_time    timestamptz NOT NULL,
    gas_used      bigint      NOT NULL DEFAULT 0,
    gas_price_wei text        NOT NULL DEFAULT '',
    fee_wei       text        NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX chain_transfers_from ON chain_transfers (chain_id, from_address, block_number DESC);
CREATE INDEX chain_transfers_to ON chain_transfers (chain_id, to_address, block_number DESC);
CREATE INDEX chain_transfers_tx_from ON chain_transfers (chain_id, tx_from, block_number DESC);

CREATE TABLE chain_index_cursors (
    chain_id        bigint      NOT NULL,
    address         text        NOT NULL,
    since_block     bigint      NOT NULL,
    scanned_through bigint      NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, address)
);

-- +goose Down
DROP TABLE chain_index_cursors;
DROP TABLE chain_transfers;
