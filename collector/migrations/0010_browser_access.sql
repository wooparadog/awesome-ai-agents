-- Browser credentials inherit revocation/expiry from the write token that
-- authorized their one-time login link. Secrets are stored only as SHA-256.
ALTER TABLE api_tokens ADD COLUMN parent_token_id TEXT;
CREATE INDEX browser_token_parent ON api_tokens(parent_token_id,expires_at);
CREATE INDEX browser_token_expiry ON api_tokens(expires_at) WHERE parent_token_id IS NOT NULL;
CREATE TABLE browser_links (
 id TEXT PRIMARY KEY,
 secret_hash TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 parent_token_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 token_expires_at INTEGER NOT NULL,
 redeemed_token_id TEXT
);
CREATE INDEX browser_link_expiry ON browser_links(expires_at);
CREATE INDEX browser_link_parent ON browser_links(parent_token_id,expires_at);
CREATE TABLE browser_tickets (
 id TEXT PRIMARY KEY,
 secret_hash TEXT NOT NULL,
 token_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX browser_ticket_expiry ON browser_tickets(expires_at);
CREATE INDEX browser_ticket_token ON browser_tickets(token_id,expires_at);
