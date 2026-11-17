-- +goose Up
-- Shared wallets with multi-participant approval. Separate from wallets/
-- accounts (one user's HD profile): participants are independent users.
-- No column holds a key share, seed, or any private key material.
CREATE TABLE shared_wallets (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    policy_version int NOT NULL CHECK (policy_version >= 1),
    policy_numerator int NOT NULL CHECK (policy_numerator >= 1),
    policy_denominator int NOT NULL CHECK (policy_denominator >= policy_numerator),
    policy_rounding text NOT NULL CHECK (policy_rounding IN ('ceil')),
    membership_version bigint NOT NULL DEFAULT 1 CHECK (membership_version >= 1),
    key_status text NOT NULL DEFAULT 'none' CHECK (key_status IN ('none','rekey_required','active')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shared_wallet_members (
    id uuid PRIMARY KEY,
    wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
    user_id uuid NOT NULL REFERENCES users(id),
    device_id uuid NOT NULL REFERENCES devices(id),
    device_public_key bytea NOT NULL,
    display_name text NOT NULL DEFAULT '',
    role text NOT NULL CHECK (role IN ('owner','member')),
    status text NOT NULL CHECK (status IN ('active','suspended','revoked')),
    invited_by uuid REFERENCES shared_wallet_members(id),
    joined_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_by uuid REFERENCES shared_wallet_members(id)
);
-- One non-revoked membership per user per wallet.
CREATE UNIQUE INDEX shared_wallet_members_one_live_idx
    ON shared_wallet_members(wallet_id, user_id) WHERE status <> 'revoked';
CREATE INDEX shared_wallet_members_user_idx ON shared_wallet_members(user_id);

CREATE TABLE shared_wallet_invitations (
    id uuid PRIMARY KEY,
    wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
    code_hash bytea NOT NULL UNIQUE, -- SHA-256 of a one-time code; the code is never stored
    label text NOT NULL DEFAULT '',
    invited_by uuid NOT NULL REFERENCES shared_wallet_members(id),
    status text NOT NULL CHECK (status IN ('invited','accepted','rejected','revoked')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users(id),
    member_id uuid REFERENCES shared_wallet_members(id)
);
CREATE INDEX shared_wallet_invitations_wallet_idx ON shared_wallet_invitations(wallet_id);

CREATE TABLE shared_accounts (
    id uuid PRIMARY KEY,
    wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
    name text NOT NULL,
    derivation_index bigint NOT NULL CHECK (derivation_index >= 0 AND derivation_index < 4294967295),
    created_by uuid NOT NULL REFERENCES shared_wallet_members(id),
    created_at timestamptz NOT NULL,
    UNIQUE (wallet_id, derivation_index)
);

CREATE TABLE proposals (
    id uuid PRIMARY KEY,
    wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
    account_id uuid NOT NULL REFERENCES shared_accounts(id),
    derivation_index bigint NOT NULL,
    initiator_member_id uuid NOT NULL REFERENCES shared_wallet_members(id),
    chain_id bigint NOT NULL,
    to_address text NOT NULL,
    value_wei numeric(78,0) NOT NULL,
    data text NOT NULL,
    nonce numeric(20,0) NOT NULL,
    gas_limit numeric(20,0) NOT NULL,
    max_fee_per_gas numeric(78,0) NOT NULL,
    max_priority_fee_per_gas numeric(78,0) NOT NULL,
    policy_version int NOT NULL,
    policy_numerator int NOT NULL,
    policy_denominator int NOT NULL,
    policy_rounding text NOT NULL,
    membership_version bigint NOT NULL,
    participant_count int NOT NULL,
    required_approvals int NOT NULL CHECK (required_approvals >= 1 AND required_approvals <= participant_count),
    eligible_member_ids uuid[] NOT NULL,
    digest bytea NOT NULL UNIQUE,
    status text NOT NULL CHECK (status IN ('pending','approved','rejected','expired','superseded')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    decided_at timestamptz
);
CREATE INDEX proposals_wallet_idx ON proposals(wallet_id, created_at DESC);

CREATE TABLE proposal_votes (
    id uuid PRIMARY KEY,
    seq bigserial NOT NULL, -- total order of votes; picks the first T approvers
    proposal_id uuid NOT NULL REFERENCES proposals(id),
    member_id uuid NOT NULL REFERENCES shared_wallet_members(id),
    decision text NOT NULL CHECK (decision IN ('approve','reject')),
    nonce text NOT NULL UNIQUE,
    issued_at timestamptz NOT NULL,
    signature bytea NOT NULL,
    digest bytea NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (proposal_id, member_id)
);

CREATE TABLE proposal_vote_nonces (
    nonce text PRIMARY KEY,
    proposal_id uuid NOT NULL REFERENCES proposals(id),
    member_id uuid NOT NULL REFERENCES shared_wallet_members(id),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL
);

CREATE TABLE signing_jobs (
    id uuid PRIMARY KEY,
    proposal_id uuid NOT NULL UNIQUE REFERENCES proposals(id), -- exactly one job per proposal
    status text NOT NULL CHECK (status IN ('awaiting_key_generation')),
    signers uuid[] NOT NULL,
    created_at timestamptz NOT NULL
);

-- +goose Down
DROP TABLE IF EXISTS signing_jobs;
DROP TABLE IF EXISTS proposal_vote_nonces;
DROP TABLE IF EXISTS proposal_votes;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS shared_accounts;
DROP TABLE IF EXISTS shared_wallet_invitations;
DROP TABLE IF EXISTS shared_wallet_members;
DROP TABLE IF EXISTS shared_wallets;
