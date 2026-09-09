ALTER TABLE usage_records ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE TABLE usage_daily (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), day_start INTEGER NOT NULL, day_end INTEGER NOT NULL,
 timezone TEXT NOT NULL, agent TEXT NOT NULL, tokens INTEGER NOT NULL, nano_usd TEXT NOT NULL,
 priced INTEGER NOT NULL, complete INTEGER NOT NULL, pricing_version TEXT NOT NULL DEFAULT 'v1',
 PRIMARY KEY(workspace_id,day_start,timezone,agent)
);
CREATE INDEX unarchived_usage ON usage_records(workspace_id,archived,occurred_at);
