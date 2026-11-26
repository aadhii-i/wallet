-- +goose Up
-- Public coordinator transcripts only. No native keys or Raccoon key shares.
CREATE TABLE hedera_shared_messages (
 scope text NOT NULL,
 session text NOT NULL,
 kind text NOT NULL,
 author uuid NOT NULL,
 id text NOT NULL,
 body jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(scope,session,kind,author)
);
CREATE INDEX hedera_shared_messages_recent ON hedera_shared_messages(scope,created_at);

-- +goose Down
DROP TABLE hedera_shared_messages;
