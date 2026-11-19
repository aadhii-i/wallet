-- +goose Up
-- Networked Threshold Raccoon signing and on-chain execution for approved
-- shared-wallet proposals. Every column is public protocol data: account
-- public keys pk_j, round messages (commitments, masked openings, masked
-- response shares), the combined signature and relayer transactions. No key
-- share, seed, chain code or master secret is ever stored.
CREATE TABLE shared_account_keys (
    account_id uuid NOT NULL REFERENCES shared_accounts(id),
    keygen_id uuid NOT NULL REFERENCES shared_key_generations(id),
    wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
    derivation_index bigint NOT NULL CHECK (derivation_index >= 0),
    public_key bytea NOT NULL CHECK (length(public_key) = 5152),
    public_key_hash bytea NOT NULL CHECK (length(public_key_hash) = 32),
    address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (account_id, keygen_id)
);

CREATE TABLE shared_account_key_attestations (
    account_id uuid NOT NULL,
    keygen_id uuid NOT NULL,
    member_id uuid NOT NULL REFERENCES shared_wallet_members(id),
    signature bytea NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (account_id, keygen_id, member_id),
    FOREIGN KEY (account_id, keygen_id) REFERENCES shared_account_keys (account_id, keygen_id)
);

CREATE TABLE shared_signing_sessions (
    id uuid PRIMARY KEY,
    proposal_id uuid NOT NULL REFERENCES proposals(id),
    wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
    keygen_id uuid NOT NULL REFERENCES shared_key_generations(id),
    attempt int NOT NULL CHECK (attempt >= 1),
    sid bytea NOT NULL UNIQUE CHECK (length(sid) = 32),
    act int[] NOT NULL,
    signer_member_ids uuid[] NOT NULL,
    threshold int NOT NULL CHECK (threshold >= 1),
    parties int NOT NULL CHECK (parties >= threshold AND parties <= 64),
    membership_version bigint NOT NULL,
    derivation_index bigint NOT NULL,
    chain_id bigint NOT NULL,
    account_address text NOT NULL,
    public_key_hash bytea NOT NULL CHECK (length(public_key_hash) = 32),
    message bytea NOT NULL CHECK (length(message) = 32),
    status text NOT NULL CHECK (status IN ('round1','round2','round3','combining','complete','failed')),
    failure_reason text NOT NULL DEFAULT '',
    failed_by uuid REFERENCES shared_wallet_members(id),
    signature bytea CHECK (signature IS NULL OR length(signature) = 19494),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    ended_at timestamptz,
    UNIQUE (proposal_id, attempt)
);
-- At most one open session, and at most one signature, per proposal.
CREATE UNIQUE INDEX shared_signing_sessions_one_open ON shared_signing_sessions (proposal_id)
    WHERE status IN ('round1','round2','round3','combining');
CREATE UNIQUE INDEX shared_signing_sessions_one_signed ON shared_signing_sessions (proposal_id)
    WHERE status = 'complete';

CREATE TABLE shared_signing_messages (
    session_id uuid NOT NULL REFERENCES shared_signing_sessions(id),
    round int NOT NULL CHECK (round BETWEEN 1 AND 3),
    party_index int NOT NULL CHECK (party_index BETWEEN 1 AND 64),
    member_id uuid NOT NULL REFERENCES shared_wallet_members(id),
    payload bytea NOT NULL,
    device_signature bytea NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (session_id, round, party_index)
);

CREATE TABLE shared_executions (
    proposal_id uuid PRIMARY KEY REFERENCES proposals(id),
    session_id uuid NOT NULL REFERENCES shared_signing_sessions(id),
    wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
    chain_id bigint NOT NULL,
    account_address text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','submitting','submitted','confirmed','failed')),
    last_error text NOT NULL DEFAULT '',
    relayer_address text NOT NULL DEFAULT '',
    tx_hash text NOT NULL DEFAULT '',
    raw_tx bytea,
    block_number bigint,
    gas_used bigint,
    call_success boolean,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    submitted_at timestamptz,
    confirmed_at timestamptz
);
CREATE INDEX shared_executions_status ON shared_executions (status);

-- +goose Down
DROP TABLE shared_executions;
DROP TABLE shared_signing_messages;
DROP TABLE shared_signing_sessions;
DROP TABLE shared_account_key_attestations;
DROP TABLE shared_account_keys;
