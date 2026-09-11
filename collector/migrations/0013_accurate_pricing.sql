-- Pricing metadata is separate from token identity: old outboxes remain replayable.
ALTER TABLE usage_records ADD COLUMN pricing_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE usage_records ADD COLUMN resolved_rates TEXT;
ALTER TABLE usage_records ADD COLUMN pricing_version TEXT NOT NULL DEFAULT '';
CREATE INDEX pricing_pending ON usage_records(workspace_id,id) WHERE archived=0 AND pricing_version='';
DROP VIEW usage_normalized;
CREATE VIEW usage_normalized AS
SELECT u.workspace_id,u.id,u.day_start,u.day_end,u.agent,u.provider,
 COALESCE((CASE WHEN u.measurement_kind='delta' OR u.model=p.model THEN u.model END),'') AS model,
 (CASE WHEN u.measurement_kind='delta' OR u.model=p.model THEN COALESCE(u.resolved_rates,json_set((CASE WHEN u.measurement_kind='delta' OR u.model=p.model THEN COALESCE((SELECT json_group_object(metric,nano_usd_per_token) FROM price_rates p
 WHERE p.provider=u.provider AND (p.model=u.model OR (substr(u.model,1,length(p.model)+1)=p.model||'-'
 AND length(u.model)=length(p.model)+9 AND substr(u.model,length(p.model)+2) NOT GLOB '*[^0-9]*')
 OR (substr(u.model,1,length(p.model)+1)=p.model||'@' AND length(u.model)>length(p.model)+1
 AND substr(u.model,length(p.model)+2) NOT GLOB '*[^0-9]*')) AND p.effective_from<=u.occurred_at AND (p.effective_to IS NULL OR p.effective_to>u.occurred_at)),'{}') ELSE '{}' END),'$._estimated',1)) ELSE '{}' END) AS rates,
 (CASE WHEN u.measurement_kind='cumulative' AND (p.id IS NULL OR u.input<p.input OR u.output<p.output OR u.cache_read<p.cache_read) THEN 1 ELSE 0 END) AS incomplete,
 (CASE WHEN u.measurement_kind='delta' THEN u.input WHEN p.id IS NULL OR u.input<p.input OR u.output<p.output OR u.cache_read<p.cache_read THEN 0 ELSE MAX(u.input-p.input-(u.cache_read-p.cache_read),0) END) AS input,
 (CASE WHEN u.measurement_kind='delta' THEN u.output WHEN p.id IS NULL OR u.input<p.input OR u.output<p.output OR u.cache_read<p.cache_read THEN 0 ELSE u.output-p.output END) AS output,
 (CASE WHEN u.measurement_kind='delta' THEN u.cache_read WHEN p.id IS NULL OR u.input<p.input OR u.output<p.output OR u.cache_read<p.cache_read THEN 0 ELSE u.cache_read-p.cache_read END) AS cache_read,
 u.cache_write_5m,u.cache_write_1h
FROM usage_records u LEFT JOIN usage_records p ON u.measurement_kind='cumulative' AND p.rowid=(
 SELECT prev.rowid FROM usage_records prev
 WHERE prev.workspace_id=u.workspace_id AND prev.provider=u.provider AND prev.stream_id=u.stream_id
 AND prev.counter_epoch=u.counter_epoch AND (prev.occurred_at,prev.id)<(u.occurred_at,u.id)
 ORDER BY prev.occurred_at DESC,prev.id DESC LIMIT 1
)
WHERE u.archived=0 AND u.day_start IS NOT NULL AND (u.measurement_kind='delta' OR NOT EXISTS (
 SELECT 1 FROM usage_records exact WHERE exact.workspace_id=u.workspace_id AND exact.provider=u.provider
 AND exact.stream_id=u.stream_id AND exact.counter_epoch='responses-v1' AND exact.measurement_kind='delta'
 AND exact.occurred_at<=u.occurred_at
));

-- Replace a contribution through the existing subtract/add triggers so both
-- workspace and resumed-run buckets move atomically, without counting twice.
CREATE TRIGGER usage_reprice AFTER UPDATE OF resolved_rates ON usage_records
WHEN NEW.archived=0 AND NEW.day_start IS NOT NULL AND OLD.resolved_rates IS NOT NEW.resolved_rates BEGIN
 DELETE FROM usage_contributions WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
 INSERT INTO usage_contributions(workspace_id,id,day_start,day_end,agent,provider,model,rates,input,output,cache_read,cache_write_5m,cache_write_1h,incomplete) SELECT workspace_id,id,day_start,day_end,agent,provider,model,rates,input,output,cache_read,cache_write_5m,cache_write_1h,incomplete FROM usage_normalized
 WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;
-- Conflicting nonempty billing metadata must never silently replace evidence.
CREATE TRIGGER pricing_validate BEFORE INSERT ON usage_records BEGIN
 SELECT (CASE WHEN EXISTS(
  SELECT 1 FROM usage_records existing, json_each(NEW.pricing_json) j
  WHERE existing.workspace_id=NEW.workspace_id AND existing.id=NEW.id
  AND json_extract(existing.pricing_json,'$.'||j.key) IS NOT NULL
  AND json_extract(existing.pricing_json,'$.'||j.key) IS NOT j.value
 ) THEN RAISE(ABORT,'usage conflict') END);
END;
