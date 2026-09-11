-- Coalesce presence publication once per batch, including empty-run coverage updates.
ALTER TABLE workspaces ADD COLUMN usage_reset_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE installations ADD COLUMN presence_observed_at INTEGER;
CREATE TABLE presence_dirty (workspace_id TEXT PRIMARY KEY);
DROP TRIGGER presence_publish;
CREATE TRIGGER presence_publish AFTER UPDATE OF presence_received_at ON session_runs
WHEN NEW.presence_received_at IS NOT OLD.presence_received_at BEGIN
 INSERT INTO presence_dirty(workspace_id) VALUES(NEW.workspace_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER installation_presence_publish AFTER UPDATE OF presence_observed_at ON installations
WHEN NEW.presence_observed_at IS NOT OLD.presence_observed_at BEGIN
 INSERT INTO presence_dirty(workspace_id) VALUES(NEW.workspace_id) ON CONFLICT DO NOTHING;
END;
-- Delivered work must not be scanned by recovery cron invocations.
CREATE INDEX notification_pending ON notification_outbox(next_attempt_at,workspace_id)
 WHERE pending_revision>delivered_revision;

-- Reset telemetry atomically with its replay watermark. Keep live run identity,
-- credentials and configuration so running reporters need no reinstallation.
CREATE TRIGGER reset_telemetry AFTER UPDATE OF usage_reset_at ON workspaces
WHEN NEW.usage_reset_at>OLD.usage_reset_at BEGIN
 UPDATE usage_contributions SET frozen=1 WHERE workspace_id=NEW.id;
 DELETE FROM usage_contributions WHERE workspace_id=NEW.id;
 DELETE FROM usage_observations WHERE workspace_id=NEW.id;
 DELETE FROM usage_records WHERE workspace_id=NEW.id;
 DELETE FROM usage_rollups WHERE workspace_id=NEW.id;
 DELETE FROM usage_daily WHERE workspace_id=NEW.id;
 DELETE FROM events WHERE workspace_id=NEW.id;
 UPDATE session_runs SET usage_model=NULL,usage_observed_at=NULL WHERE workspace_id=NEW.id;
 DELETE FROM session_runs WHERE workspace_id=NEW.id AND ended_at IS NOT NULL;
 DELETE FROM presence_dirty WHERE workspace_id=NEW.id;
 DELETE FROM statistics_dirty WHERE workspace_id=NEW.id;
 UPDATE workspaces SET revision=revision+1 WHERE id=NEW.id;
 INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces WHERE id=NEW.id
 ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0;
END;
