-- Response IDs identify exact Codex usage, including the first request and model
-- switches. Replayed response evidence supersedes legacy cumulative estimates
-- for that thread; retain the original records for audit and deduplication.
DROP VIEW usage_deltas;
CREATE VIEW usage_deltas AS
WITH previous AS (
 SELECT *,LAG(input) OVER w AS pi,LAG(output) OVER w AS po,LAG(cache_read) OVER w AS pc,LAG(model) OVER w AS pm,
 LAG(occurred_at) OVER w AS previous_at
 FROM usage_records u
 WHERE u.measurement_kind!='cumulative' OR NOT EXISTS (
   SELECT 1 FROM usage_records r WHERE r.workspace_id=u.workspace_id
   AND r.provider=u.provider AND r.stream_id=u.stream_id
   AND r.measurement_kind='delta' AND r.counter_epoch='responses-v1'
 )
 WINDOW w AS (PARTITION BY workspace_id,stream_id,counter_epoch ORDER BY occurred_at,id)
)
SELECT workspace_id,id,agent,provider,occurred_at,previous_at,
 (CASE WHEN measurement_kind='delta' OR model=pm THEN model END) AS model,
 (CASE WHEN measurement_kind='cumulative' AND (pi IS NULL OR input<pi OR output<po OR cache_read<pc) THEN 1 ELSE 0 END) AS incomplete,
 (CASE WHEN measurement_kind='delta' THEN input WHEN pi IS NULL OR input<pi OR output<po OR cache_read<pc THEN 0 ELSE MAX(input-pi-(cache_read-pc),0) END) AS input,
 (CASE WHEN measurement_kind='delta' THEN output WHEN pi IS NULL OR input<pi OR output<po OR cache_read<pc THEN 0 ELSE output-po END) AS output,
 (CASE WHEN measurement_kind='delta' THEN cache_read WHEN pi IS NULL OR input<pi OR output<po OR cache_read<pc THEN 0 ELSE cache_read-pc END) AS cache_read,
 cache_write_5m,cache_write_1h FROM previous;
