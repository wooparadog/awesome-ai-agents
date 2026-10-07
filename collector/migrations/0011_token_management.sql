ALTER TABLE api_tokens ADD COLUMN label TEXT;
ALTER TABLE api_tokens ADD COLUMN created_at INTEGER;
ALTER TABLE api_tokens ADD COLUMN updated_at INTEGER;
ALTER TABLE api_tokens ADD COLUMN can_manage_tokens INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_tokens IN (0,1));
ALTER TABLE browser_links ADD COLUMN can_manage_tokens INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_tokens IN (0,1));
CREATE INDEX workspace_tokens ON api_tokens(workspace_id,id);
CREATE INDEX revoked_token_expiry ON api_tokens(revoked_at) WHERE revoked_at IS NOT NULL;
