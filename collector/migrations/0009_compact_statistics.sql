-- Compact statistics: maintain daily totals at ingestion, never scan evidence on refresh.
-- Existing evidence is backfilled once by scripts/compact-usage.mjs before reads resume.
ALTER TABLE usage_records ADD COLUMN day_start INTEGER;
ALTER TABLE usage_records ADD COLUMN day_end INTEGER;
ALTER TABLE session_runs ADD COLUMN usage_model TEXT;
ALTER TABLE session_runs ADD COLUMN usage_observed_at INTEGER;
CREATE TABLE statistics_state (id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL);
INSERT INTO statistics_state VALUES(1, (CASE WHEN EXISTS(SELECT 1 FROM usage_records WHERE archived=0) THEN 0 ELSE 1 END));
CREATE TABLE usage_rollups (
 workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, day_start INTEGER NOT NULL, day_end INTEGER NOT NULL,
 agent TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, rates TEXT NOT NULL,
 input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
 cache_write_5m INTEGER NOT NULL DEFAULT 0, cache_write_1h INTEGER NOT NULL DEFAULT 0,
 records INTEGER NOT NULL, incomplete INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,run_id,day_start,agent,provider,model,rates)
);
CREATE INDEX rollup_retention ON usage_rollups(day_start);
CREATE TABLE usage_contributions (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, day_start INTEGER NOT NULL, day_end INTEGER NOT NULL,
 agent TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, rates TEXT NOT NULL,
 input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
 cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, incomplete INTEGER NOT NULL,
 frozen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,id)
);
CREATE INDEX contribution_retention ON usage_contributions(day_start);
CREATE INDEX observation_by_run ON usage_observations(workspace_id,run_id,usage_id);
CREATE INDEX usage_workspace_time ON usage_records(workspace_id,occurred_at,id);
CREATE INDEX usage_stream_order ON usage_records(workspace_id,provider,stream_id,counter_epoch,occurred_at,id);
CREATE INDEX usage_expiry ON usage_records(archived,occurred_at);
CREATE INDEX active_run_snapshot ON session_runs(workspace_id,last_activity_at DESC) WHERE ended_at IS NULL;
CREATE INDEX ended_run_expiry ON session_runs(ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX archive_expiry ON usage_daily(day_end);
CREATE INDEX session_expiry ON sessions(first_observed_at);
CREATE INDEX execution_expiry ON executions(created_at);
CREATE VIEW usage_normalized AS
SELECT u.workspace_id,u.id,u.day_start,u.day_end,u.agent,u.provider,
 COALESCE((CASE WHEN u.measurement_kind='delta' OR u.model=p.model THEN u.model END),'') AS model,
 (CASE WHEN u.measurement_kind='delta' OR u.model=p.model THEN COALESCE((SELECT json_group_object(metric,nano_usd_per_token) FROM price_rates p
 WHERE p.provider=u.provider AND (p.model=u.model OR (substr(u.model,1,length(p.model)+1)=p.model||'-'
 AND length(u.model)=length(p.model)+9 AND substr(u.model,length(p.model)+2) NOT GLOB '*[^0-9]*')
 OR (substr(u.model,1,length(p.model)+1)=p.model||'@' AND length(u.model)>length(p.model)+1
 AND substr(u.model,length(p.model)+2) NOT GLOB '*[^0-9]*')) AND p.effective_from<=u.occurred_at AND (p.effective_to IS NULL OR p.effective_to>u.occurred_at)),'{}') ELSE '{}' END) AS rates,
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
CREATE TRIGGER contribution_add AFTER INSERT ON usage_contributions BEGIN
 INSERT INTO usage_rollups(workspace_id,run_id,day_start,agent,provider,model,rates,day_end,input,output,cache_read,cache_write_5m,cache_write_1h,records,incomplete) SELECT NEW.workspace_id,'',NEW.day_start,NEW.agent,NEW.provider,NEW.model,NEW.rates,NEW.day_end,NEW.input,NEW.output,NEW.cache_read,NEW.cache_write_5m,NEW.cache_write_1h,1,NEW.incomplete  WHERE 1 ON CONFLICT(workspace_id,run_id,day_start,agent,provider,model,rates) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,cache_read=cache_read+excluded.cache_read,cache_write_5m=cache_write_5m+excluded.cache_write_5m,cache_write_1h=cache_write_1h+excluded.cache_write_1h,records=records+excluded.records,incomplete=incomplete+excluded.incomplete;
 INSERT INTO usage_rollups(workspace_id,run_id,day_start,agent,provider,model,rates,day_end,input,output,cache_read,cache_write_5m,cache_write_1h,records,incomplete) SELECT NEW.workspace_id,o.run_id,NEW.day_start,NEW.agent,NEW.provider,NEW.model,NEW.rates,NEW.day_end,NEW.input,NEW.output,NEW.cache_read,NEW.cache_write_5m,NEW.cache_write_1h,1,NEW.incomplete FROM usage_observations o WHERE o.workspace_id=NEW.workspace_id AND o.usage_id=NEW.id ON CONFLICT(workspace_id,run_id,day_start,agent,provider,model,rates) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,cache_read=cache_read+excluded.cache_read,cache_write_5m=cache_write_5m+excluded.cache_write_5m,cache_write_1h=cache_write_1h+excluded.cache_write_1h,records=records+excluded.records,incomplete=incomplete+excluded.incomplete;
END;
CREATE TRIGGER contribution_remove AFTER DELETE ON usage_contributions WHEN OLD.frozen=0 BEGIN
 INSERT INTO usage_rollups(workspace_id,run_id,day_start,agent,provider,model,rates,day_end,input,output,cache_read,cache_write_5m,cache_write_1h,records,incomplete) SELECT OLD.workspace_id,'',OLD.day_start,OLD.agent,OLD.provider,OLD.model,OLD.rates,OLD.day_end,-OLD.input,-OLD.output,-OLD.cache_read,-OLD.cache_write_5m,-OLD.cache_write_1h,-1,-OLD.incomplete  WHERE 1 ON CONFLICT(workspace_id,run_id,day_start,agent,provider,model,rates) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,cache_read=cache_read+excluded.cache_read,cache_write_5m=cache_write_5m+excluded.cache_write_5m,cache_write_1h=cache_write_1h+excluded.cache_write_1h,records=records+excluded.records,incomplete=incomplete+excluded.incomplete;
 INSERT INTO usage_rollups(workspace_id,run_id,day_start,agent,provider,model,rates,day_end,input,output,cache_read,cache_write_5m,cache_write_1h,records,incomplete) SELECT OLD.workspace_id,o.run_id,OLD.day_start,OLD.agent,OLD.provider,OLD.model,OLD.rates,OLD.day_end,-OLD.input,-OLD.output,-OLD.cache_read,-OLD.cache_write_5m,-OLD.cache_write_1h,-1,-OLD.incomplete FROM usage_observations o WHERE o.workspace_id=OLD.workspace_id AND o.usage_id=OLD.id ON CONFLICT(workspace_id,run_id,day_start,agent,provider,model,rates) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,cache_read=cache_read+excluded.cache_read,cache_write_5m=cache_write_5m+excluded.cache_write_5m,cache_write_1h=cache_write_1h+excluded.cache_write_1h,records=records+excluded.records,incomplete=incomplete+excluded.incomplete;
 DELETE FROM usage_rollups WHERE workspace_id=OLD.workspace_id AND day_start=OLD.day_start AND records=0;
END;
CREATE TRIGGER observation_rollup AFTER INSERT ON usage_observations BEGIN
 INSERT INTO usage_rollups(workspace_id,run_id,day_start,agent,provider,model,rates,day_end,input,output,cache_read,cache_write_5m,cache_write_1h,records,incomplete) SELECT c.workspace_id,NEW.run_id,c.day_start,c.agent,c.provider,c.model,c.rates,c.day_end,c.input,c.output,c.cache_read,c.cache_write_5m,c.cache_write_1h,1,c.incomplete FROM usage_contributions c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.usage_id ON CONFLICT(workspace_id,run_id,day_start,agent,provider,model,rates) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,cache_read=cache_read+excluded.cache_read,cache_write_5m=cache_write_5m+excluded.cache_write_5m,cache_write_1h=cache_write_1h+excluded.cache_write_1h,records=records+excluded.records,incomplete=incomplete+excluded.incomplete;
 UPDATE session_runs SET usage_model=(SELECT model FROM usage_records WHERE workspace_id=NEW.workspace_id AND id=NEW.usage_id),
 usage_observed_at=(SELECT occurred_at FROM usage_records WHERE workspace_id=NEW.workspace_id AND id=NEW.usage_id)
 WHERE workspace_id=NEW.workspace_id AND id=NEW.run_id AND COALESCE(usage_observed_at,-1)<=(SELECT occurred_at FROM usage_records WHERE workspace_id=NEW.workspace_id AND id=NEW.usage_id);
END;
CREATE TRIGGER usage_materialize AFTER INSERT ON usage_records WHEN NEW.day_start IS NOT NULL AND NEW.archived=0 BEGIN
 DELETE FROM usage_contributions WHERE workspace_id=NEW.workspace_id AND id IN (NEW.id,(SELECT n.id FROM usage_records n WHERE NEW.measurement_kind='cumulative' AND n.workspace_id=NEW.workspace_id
 AND n.provider=NEW.provider AND n.stream_id=NEW.stream_id AND n.counter_epoch=NEW.counter_epoch
 AND (n.occurred_at,n.id)>(NEW.occurred_at,NEW.id) ORDER BY n.occurred_at,n.id LIMIT 1));
 DELETE FROM usage_contributions WHERE NEW.counter_epoch='responses-v1' AND workspace_id=NEW.workspace_id AND id IN (
  SELECT old.id FROM usage_records old WHERE old.workspace_id=NEW.workspace_id AND old.provider=NEW.provider
  AND old.stream_id=NEW.stream_id AND old.measurement_kind='cumulative' AND old.occurred_at>=NEW.occurred_at
 ) AND NOT EXISTS(SELECT 1 FROM usage_records prior WHERE prior.workspace_id=NEW.workspace_id AND prior.provider=NEW.provider
  AND prior.stream_id=NEW.stream_id AND prior.counter_epoch='responses-v1' AND prior.id!=NEW.id AND prior.occurred_at<=NEW.occurred_at);
 INSERT INTO usage_contributions(workspace_id,id,day_start,day_end,agent,provider,model,rates,input,output,cache_read,cache_write_5m,cache_write_1h,incomplete) SELECT workspace_id,id,day_start,day_end,agent,provider,model,rates,input,output,cache_read,cache_write_5m,cache_write_1h,incomplete FROM usage_normalized
 WHERE workspace_id=NEW.workspace_id AND id IN (NEW.id,(SELECT n.id FROM usage_records n WHERE NEW.measurement_kind='cumulative' AND n.workspace_id=NEW.workspace_id
 AND n.provider=NEW.provider AND n.stream_id=NEW.stream_id AND n.counter_epoch=NEW.counter_epoch
 AND (n.occurred_at,n.id)>(NEW.occurred_at,NEW.id) ORDER BY n.occurred_at,n.id LIMIT 1));
END;
CREATE TRIGGER usage_backfill AFTER UPDATE OF day_start,day_end ON usage_records WHEN NEW.day_start IS NOT NULL AND NEW.archived=0 AND (OLD.day_start IS NOT NEW.day_start OR OLD.day_end IS NOT NEW.day_end) BEGIN
 DELETE FROM usage_contributions WHERE workspace_id=NEW.workspace_id AND id IN (NEW.id,(SELECT n.id FROM usage_records n WHERE NEW.measurement_kind='cumulative' AND n.workspace_id=NEW.workspace_id
 AND n.provider=NEW.provider AND n.stream_id=NEW.stream_id AND n.counter_epoch=NEW.counter_epoch
 AND (n.occurred_at,n.id)>(NEW.occurred_at,NEW.id) ORDER BY n.occurred_at,n.id LIMIT 1));
 DELETE FROM usage_contributions WHERE NEW.counter_epoch='responses-v1' AND workspace_id=NEW.workspace_id AND id IN (
  SELECT old.id FROM usage_records old WHERE old.workspace_id=NEW.workspace_id AND old.provider=NEW.provider
  AND old.stream_id=NEW.stream_id AND old.measurement_kind='cumulative' AND old.occurred_at>=NEW.occurred_at
 ) AND NOT EXISTS(SELECT 1 FROM usage_records prior WHERE prior.workspace_id=NEW.workspace_id AND prior.provider=NEW.provider
  AND prior.stream_id=NEW.stream_id AND prior.counter_epoch='responses-v1' AND prior.id!=NEW.id AND prior.occurred_at<=NEW.occurred_at);
 INSERT INTO usage_contributions(workspace_id,id,day_start,day_end,agent,provider,model,rates,input,output,cache_read,cache_write_5m,cache_write_1h,incomplete) SELECT workspace_id,id,day_start,day_end,agent,provider,model,rates,input,output,cache_read,cache_write_5m,cache_write_1h,incomplete FROM usage_normalized
 WHERE workspace_id=NEW.workspace_id AND id IN (NEW.id,(SELECT n.id FROM usage_records n WHERE NEW.measurement_kind='cumulative' AND n.workspace_id=NEW.workspace_id
 AND n.provider=NEW.provider AND n.stream_id=NEW.stream_id AND n.counter_epoch=NEW.counter_epoch
 AND (n.occurred_at,n.id)>(NEW.occurred_at,NEW.id) ORDER BY n.occurred_at,n.id LIMIT 1));
END;
CREATE INDEX rollup_day_cleanup ON usage_rollups(workspace_id,day_start);
CREATE TABLE maintenance_runs (id TEXT PRIMARY KEY, last_run INTEGER NOT NULL);
CREATE INDEX run_by_session ON session_runs(workspace_id,session_id);
-- Old Worker versions cannot insert unprojected evidence during the cutover.
CREATE TRIGGER usage_requires_reporting_day BEFORE INSERT ON usage_records WHEN NEW.day_start IS NULL OR NEW.day_end IS NULL BEGIN
 SELECT RAISE(ABORT,'statistics migration requires reporting day');
END;
-- Publish once per ingestion batch, not twice per individual usage record.
CREATE TABLE statistics_dirty (workspace_id TEXT PRIMARY KEY);
DROP TRIGGER usage_publish;
DROP TRIGGER usage_observation_publish;
CREATE TRIGGER usage_publish AFTER INSERT ON usage_records BEGIN
 INSERT INTO statistics_dirty(workspace_id) VALUES(NEW.workspace_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER usage_observation_publish AFTER INSERT ON usage_observations BEGIN
 INSERT INTO statistics_dirty(workspace_id) VALUES(NEW.workspace_id) ON CONFLICT DO NOTHING;
END;
