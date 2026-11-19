-- +goose Up
-- Threshold Raccoon key generation for shared wallets (trusted dealer). The
-- backend relays HPKE (X-Wing) envelopes it cannot open. No column holds a
-- plaintext share, the master secret, tFull, the chain code or a pairwise seed:
-- only public encryption keys, opaque envelopes (wiped on acknowledgement or
-- when the ceremony ends) and the SHA3-256 master-key fingerprint.
CREATE TABLE shared_key_generations (
    id uuid PRIMARY KEY,
    wallet_id uuid NOT NULL REFERENCES shared_wallets(id),
    membership_version bigint NOT NULL,
    threshold int NOT NULL CHECK (threshold >= 1),
    parties int NOT NULL CHECK (parties >= threshold AND parties <= 64),
    dealer_member_id uuid NOT NULL REFERENCES shared_wallet_members(id),
    status text NOT NULL CHECK (status IN ('collecting_keys','dealing','awaiting_provisioning','complete','failed')),
    failure_reason text NOT NULL DEFAULT '',
    fingerprint bytea CHECK (fingerprint IS NULL OR length(fingerprint) = 32),
    dealer_signature bytea,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    ended_at timestamptz
);
-- At most one open ceremony per wallet.
CREATE UNIQUE INDEX shared_key_generations_one_open ON shared_key_generations (wallet_id)
    WHERE status IN ('collecting_keys','dealing','awaiting_provisioning');
CREATE INDEX shared_key_generations_wallet ON shared_key_generations (wallet_id, created_at DESC, id DESC);

CREATE TABLE shared_key_generation_participants (
    keygen_id uuid NOT NULL REFERENCES shared_key_generations(id),
    member_id uuid NOT NULL REFERENCES shared_wallet_members(id),
    party_index int NOT NULL CHECK (party_index BETWEEN 1 AND 64),
    encryption_key bytea CHECK (encryption_key IS NULL OR length(encryption_key) = 1216),
    key_signature bytea,
    key_registered_at timestamptz,
    envelope_enc bytea,
    envelope_ct bytea,
    envelope_hash bytea,
    envelope_fingerprint bytea,
    ack_signature bytea,
    provisioned_at timestamptz,
    PRIMARY KEY (keygen_id, member_id),
    UNIQUE (keygen_id, party_index)
);

ALTER TABLE shared_wallets
    ADD COLUMN key_generation_id uuid REFERENCES shared_key_generations(id),
    ADD COLUMN key_fingerprint bytea CHECK (key_fingerprint IS NULL OR length(key_fingerprint) = 32);

-- +goose Down
ALTER TABLE shared_wallets DROP COLUMN IF EXISTS key_fingerprint, DROP COLUMN IF EXISTS key_generation_id;
DROP TABLE IF EXISTS shared_key_generation_participants;
DROP TABLE IF EXISTS shared_key_generations;
