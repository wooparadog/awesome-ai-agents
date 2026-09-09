-- A copied transcript can attach existing evidence to a new run without inserting
-- a new usage record. Its per-run totals still need an invalidation.
CREATE TRIGGER usage_observation_publish AFTER INSERT ON usage_observations BEGIN
 UPDATE workspaces SET revision=revision+1 WHERE id=NEW.workspace_id;
 INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces WHERE id=NEW.workspace_id
 ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0;
END;
