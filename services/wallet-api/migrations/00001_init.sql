-- +goose Up
CREATE EXTENSION IF NOT EXISTS citext;

-- Core schema for wallet-api (spec §18). IDs are UUIDs generated
-- application-side as UUIDv7 for time-ordering; Postgres just stores them as
-- native uuid. No column here holds a mnemonic, seed, private key, or
-- plaintext share (CI migration linter should reject any column matching
-- *seed*|*mnemonic*|*private_key*|*secret* unless annotated
-- "-- encrypted-envelope").

CREATE TABLE users (
    id uuid PRIMARY KEY,
    email citext UNIQUE,
    email_verified_at timestamptz,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleted')),
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    public_key bytea NOT NULL UNIQUE,
    platform text NOT NULL CHECK (platform IN ('web','ios','android')),
    label text NOT NULL DEFAULT '',
    attestation jsonb,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_id_idx ON devices(user_id);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    device_id uuid NOT NULL REFERENCES devices(id),
    user_id uuid NOT NULL REFERENCES users(id),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    ip_hash text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_device_id_idx ON sessions(device_id);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

-- One row per refresh-token rotation generation. Only the SHA-256 hash of
-- the raw token is ever stored (-- encrypted-envelope not required: this is
-- a one-way hash, not a reversible secret at rest).
CREATE TABLE refresh_tokens (
    hash bytea PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES sessions(id),
    rotated boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_session_id_idx ON refresh_tokens(session_id);

-- Auth challenges are short-lived (60s TTL); kept in Postgres for a single
-- wallet-api replica, but may be moved to Redis behind the same interface.
CREATE TABLE challenges (
    id uuid PRIMARY KEY,
    public_key bytea NOT NULL,
    nonce text NOT NULL,
    message text NOT NULL,
    origin text NOT NULL,
    client_type text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallets (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    label text NOT NULL,
    default_signing_mode text NOT NULL DEFAULT 'hd' CHECK (default_signing_mode IN ('hd','mpc','qd')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallets_user_id_idx ON wallets(user_id);

CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    wallet_id uuid NOT NULL REFERENCES wallets(id),
    user_id uuid NOT NULL REFERENCES users(id),
    hd_index bigint,
    name text NOT NULL,
    signing_mode text NOT NULL DEFAULT 'hd' CHECK (signing_mode IN ('hd','mpc','qd')),
    hidden boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (wallet_id, hd_index)
);
CREATE INDEX accounts_user_id_idx ON accounts(user_id);

CREATE TABLE networks (
    id text PRIMARY KEY,
    family text NOT NULL CHECK (family IN ('evm','monero')),
    chain_id bigint,
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('mainnet','testnet','local')),
    native_symbol text NOT NULL,
    native_decimals smallint NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id),
    network_family text NOT NULL CHECK (network_family = 'evm'),
    address text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (network_family, address, account_id)
);
CREATE INDEX addresses_account_id_idx ON addresses(account_id);

CREATE TABLE assets (
    id text PRIMARY KEY,
    network_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('native','erc20')),
    contract_address text,
    symbol text NOT NULL,
    name text NOT NULL,
    decimals smallint NOT NULL,
    verified boolean NOT NULL DEFAULT false,
    price_ref text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    account_id uuid NOT NULL REFERENCES accounts(id),
    network_id text NOT NULL,
    hash text NOT NULL,
    from_address text NOT NULL,
    to_address text NOT NULL,
    asset_id text NOT NULL,
    amount numeric(78,0) NOT NULL,
    fee numeric(78,0),
    nonce bigint,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','replaced','dropped')),
    block_number bigint,
    origin text NOT NULL DEFAULT 'wallet' CHECK (origin IN ('wallet','indexed')),
    flags text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Scoped per-user (not globally) so one user can never pre-register a
    -- hash to block or interfere with another user's independent tracking
    -- of the same on-chain transaction hash.
    UNIQUE (user_id, network_id, hash)
);
CREATE INDEX transactions_user_id_idx ON transactions(user_id);
CREATE INDEX transactions_account_id_idx ON transactions(account_id);
CREATE INDEX transactions_status_idx ON transactions(status) WHERE status = 'pending';

CREATE TABLE transaction_events (
    id uuid PRIMARY KEY,
    transaction_id uuid NOT NULL REFERENCES transactions(id),
    from_status text,
    to_status text NOT NULL,
    detail jsonb,
    observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_events_tx_id_idx ON transaction_events(transaction_id);

CREATE TABLE recovery_methods (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL CHECK (kind IN ('file','device','cloud')),
    share_ref text,
    verified_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE security_events (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    device_id uuid REFERENCES devices(id),
    type text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
    ip_hash text NOT NULL DEFAULT '',
    metadata jsonb,
    acknowledged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user_id_idx ON security_events(user_id);

-- Append-only, hash-chained audit log (spec §9.6). The application DB role
-- must have only INSERT/SELECT here -- see the comment at the bottom of
-- this migration; granting is left to an operator-controlled role
-- management step outside of goose since role names are environment
-- specific.
CREATE TABLE audit_logs (
    id bigserial PRIMARY KEY,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    metadata jsonb,
    prev_hash bytea NOT NULL DEFAULT '',
    row_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
    key text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id),
    route text NOT NULL,
    status_code int NOT NULL,
    body bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, route, key)
);

-- NOTE (operational, not enforced by goose): in production, REVOKE
-- UPDATE, DELETE ON audit_logs FROM the application role and GRANT only
-- INSERT, SELECT, so even a compromised app process cannot rewrite history.

-- +goose Down
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS security_events;
DROP TABLE IF EXISTS recovery_methods;
DROP TABLE IF EXISTS transaction_events;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS networks;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS challenges;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS users;
