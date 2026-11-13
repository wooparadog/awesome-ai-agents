-- D1 meters every index entry as a written row. Drop indexes that no query
-- needs, keeping an index-backed plan for every query and trigger.
--
-- The usage_materialize/usage_backfill triggers look up later cumulative
-- samples in a stream without constraining counter_epoch. usage_workspace_time
-- served that lookup; usage_stream_order cannot bound it by time, so reads would
-- grow with stream length. This partial index serves it instead, and delta
-- records (every exact Codex response) never pay for it.
CREATE INDEX cumulative_stream ON usage_records(workspace_id,provider,stream_id,occurred_at)
 WHERE measurement_kind='cumulative';
--   usage_time            -> prefix of usage_workspace_time
--   usage_workspace_time  -> its only trigger use is served by cumulative_stream
--   usage_stream          -> stream lookups always filter provider: usage_stream_order
--   unarchived_usage      -> retention scans use usage_expiry(archived,occurred_at)
--   contribution_retention-> contributions are pruned by primary key
--   live_runs             -> active runs are read through active_run_snapshot
DROP INDEX IF EXISTS usage_time;
DROP INDEX IF EXISTS usage_stream;
DROP INDEX IF EXISTS unarchived_usage;
DROP INDEX IF EXISTS usage_workspace_time;
DROP INDEX IF EXISTS contribution_retention;
DROP INDEX IF EXISTS live_runs;
