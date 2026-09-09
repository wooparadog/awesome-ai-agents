PRAGMA foreign_keys = ON;
CREATE TABLE workspaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, reporting_timezone TEXT NOT NULL DEFAULT 'Asia/Singapore',
 revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE installations (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), id TEXT NOT NULL, label TEXT NOT NULL,
 created_at INTEGER NOT NULL, last_contact_at INTEGER, capabilities_json TEXT NOT NULL DEFAULT '{}',
 disabled_at INTEGER, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE api_tokens (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), secret_hash TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('read','write')), installation_id TEXT,
 expires_at INTEGER, revoked_at INTEGER,
 CHECK(scope != 'write' OR installation_id IS NOT NULL),
 FOREIGN KEY(workspace_id,installation_id) REFERENCES installations(workspace_id,id)
);
CREATE TABLE rate_limits (token_id TEXT PRIMARY KEY REFERENCES api_tokens(id), window INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE notification_outbox (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), pending_revision INTEGER NOT NULL,
 delivered_revision INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE executions (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, installation_id TEXT NOT NULL, agent TEXT NOT NULL,
 current_generation INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,installation_id) REFERENCES installations(workspace_id,id)
);
CREATE TABLE sessions (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, agent TEXT NOT NULL, identity_namespace TEXT NOT NULL,
 native_session_id TEXT NOT NULL, first_observed_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,agent,identity_namespace,native_session_id)
);
CREATE TABLE session_runs (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, installation_id TEXT NOT NULL,
 session_id TEXT NOT NULL, execution_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 state TEXT NOT NULL DEFAULT 'unknown', state_sequence INTEGER NOT NULL DEFAULT 0,
 metadata_sequence INTEGER NOT NULL DEFAULT 0, presence_sequence INTEGER NOT NULL DEFAULT 0,
 cwd TEXT, model TEXT, pid INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT,
 last_activity_at INTEGER NOT NULL, last_alive_observed_at INTEGER, presence_received_at INTEGER,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,execution_id,generation),
 FOREIGN KEY(workspace_id,installation_id) REFERENCES installations(workspace_id,id),
 FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,id),
 FOREIGN KEY(workspace_id,execution_id) REFERENCES executions(workspace_id,id)
);
CREATE UNIQUE INDEX one_current_run ON session_runs(workspace_id,execution_id) WHERE ended_at IS NULL;
CREATE INDEX live_runs ON session_runs(workspace_id,installation_id,ended_at,last_activity_at);
CREATE TRIGGER presence_publish AFTER UPDATE OF presence_received_at ON session_runs
WHEN NEW.presence_received_at IS NOT OLD.presence_received_at BEGIN
 UPDATE workspaces SET revision=revision+1 WHERE id=NEW.workspace_id;
 INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces WHERE id=NEW.workspace_id
 ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0;
END;
CREATE TABLE events (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, installation_id TEXT NOT NULL,
 execution_id TEXT NOT NULL, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
 session_id TEXT NOT NULL, native_session_id TEXT NOT NULL, agent TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0), source_event TEXT NOT NULL, canonical_type TEXT NOT NULL,
 target_state TEXT, observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
 payload_hash TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
 schema_version INTEGER NOT NULL DEFAULT 1, normalizer_version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,execution_id,sequence)
);
CREATE INDEX event_history ON events(workspace_id,run_id,received_at,id);
CREATE INDEX event_retention ON events(received_at);
-- Conflicting retries abort the entire ingestion batch; identical retries do nothing.
CREATE TRIGGER event_validate BEFORE INSERT ON events BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM events WHERE workspace_id=NEW.workspace_id
  AND (id=NEW.id OR (execution_id=NEW.execution_id AND sequence=NEW.sequence))
  AND (id!=NEW.id OR payload_hash!=NEW.payload_hash)) THEN RAISE(ABORT,'event conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM executions WHERE workspace_id=NEW.workspace_id AND id=NEW.execution_id
  AND (installation_id!=NEW.installation_id OR agent!=NEW.agent)) THEN RAISE(ABORT,'execution conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM session_runs WHERE workspace_id=NEW.workspace_id
  AND (id=NEW.run_id OR (execution_id=NEW.execution_id AND generation=NEW.generation))
  AND (id!=NEW.run_id OR execution_id!=NEW.execution_id OR generation!=NEW.generation OR session_id!=NEW.session_id))
  THEN RAISE(ABORT,'run conflict') END;
END;
CREATE TRIGGER event_project AFTER INSERT ON events BEGIN
 INSERT INTO executions(workspace_id,id,installation_id,agent,created_at)
 VALUES(NEW.workspace_id,NEW.execution_id,NEW.installation_id,NEW.agent,NEW.received_at) ON CONFLICT DO NOTHING;
 INSERT INTO sessions(workspace_id,id,agent,identity_namespace,native_session_id,first_observed_at)
 VALUES(NEW.workspace_id,NEW.session_id,NEW.agent,NEW.installation_id,NEW.native_session_id,NEW.observed_at) ON CONFLICT DO NOTHING;
 UPDATE session_runs SET ended_at=NEW.observed_at,end_reason='superseded',state='ended'
 WHERE workspace_id=NEW.workspace_id AND execution_id=NEW.execution_id AND generation<NEW.generation AND ended_at IS NULL;
 INSERT INTO session_runs(workspace_id,id,installation_id,session_id,execution_id,generation,started_at,last_activity_at,ended_at,end_reason,state)
 SELECT NEW.workspace_id,NEW.run_id,NEW.installation_id,NEW.session_id,NEW.execution_id,NEW.generation,NEW.observed_at,NEW.observed_at,
 CASE WHEN current_generation>NEW.generation THEN NEW.observed_at END,
 CASE WHEN current_generation>NEW.generation THEN 'superseded' END,
 CASE WHEN current_generation>NEW.generation THEN 'ended' ELSE 'unknown' END
 FROM executions WHERE workspace_id=NEW.workspace_id AND id=NEW.execution_id ON CONFLICT DO NOTHING;
 UPDATE executions SET current_generation=MAX(current_generation,NEW.generation),last_sequence=MAX(last_sequence,NEW.sequence)
 WHERE workspace_id=NEW.workspace_id AND id=NEW.execution_id;
 UPDATE session_runs SET cwd=COALESCE(json_extract(NEW.data_json,'$.cwd'),cwd),model=COALESCE(json_extract(NEW.data_json,'$.model'),model),
 pid=COALESCE(json_extract(NEW.data_json,'$.pid'),pid),metadata_sequence=NEW.sequence,last_activity_at=NEW.observed_at
 WHERE workspace_id=NEW.workspace_id AND id=NEW.run_id AND metadata_sequence<NEW.sequence;
 UPDATE session_runs SET state=CASE WHEN NEW.canonical_type='idle.notification' AND state='asking' THEN state ELSE NEW.target_state END,
 state_sequence=NEW.sequence,ended_at=CASE WHEN NEW.target_state='ended' THEN NEW.observed_at END,
 end_reason=CASE WHEN NEW.target_state='ended' THEN COALESCE(json_extract(NEW.data_json,'$.reason'),'hook') END
 WHERE workspace_id=NEW.workspace_id AND id=NEW.run_id AND ended_at IS NULL AND state_sequence<NEW.sequence AND NEW.target_state IS NOT NULL;
 UPDATE installations SET last_contact_at=NEW.received_at WHERE workspace_id=NEW.workspace_id AND id=NEW.installation_id;
 UPDATE workspaces SET revision=revision+1 WHERE id=NEW.workspace_id;
 INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces WHERE id=NEW.workspace_id
 ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0;
END;
CREATE TABLE usage_records (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, installation_id TEXT NOT NULL, agent TEXT NOT NULL, provider TEXT NOT NULL,
 native_record_id TEXT NOT NULL, stream_id TEXT NOT NULL, counter_epoch TEXT NOT NULL,
 model TEXT, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL, measurement_kind TEXT NOT NULL CHECK(measurement_kind IN ('delta','cumulative')),
 input INTEGER NOT NULL CHECK(input>=0), output INTEGER NOT NULL CHECK(output>=0), cache_read INTEGER NOT NULL CHECK(cache_read>=0),
 cache_write_5m INTEGER NOT NULL CHECK(cache_write_5m>=0),cache_write_1h INTEGER NOT NULL CHECK(cache_write_1h>=0),
 payload_hash TEXT NOT NULL, normalizer_version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,provider,native_record_id),
 FOREIGN KEY(workspace_id,installation_id) REFERENCES installations(workspace_id,id)
);
CREATE INDEX usage_time ON usage_records(workspace_id,occurred_at);
CREATE INDEX usage_stream ON usage_records(workspace_id,stream_id,counter_epoch,occurred_at);
CREATE TABLE usage_observations (
 workspace_id TEXT NOT NULL, usage_id TEXT NOT NULL, run_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,usage_id,run_id),
 FOREIGN KEY(workspace_id,usage_id) REFERENCES usage_records(workspace_id,id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES session_runs(workspace_id,id)
);
CREATE TRIGGER usage_validate BEFORE INSERT ON usage_records BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM usage_records WHERE workspace_id=NEW.workspace_id
 AND id=NEW.id AND payload_hash!=NEW.payload_hash) THEN RAISE(ABORT,'usage conflict') END;
END;
CREATE TRIGGER usage_publish AFTER INSERT ON usage_records BEGIN
 UPDATE workspaces SET revision=revision+1 WHERE id=NEW.workspace_id;
 INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces WHERE id=NEW.workspace_id
 ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0;
END;
CREATE TABLE price_rates (
 provider TEXT NOT NULL, model TEXT NOT NULL, metric TEXT NOT NULL, nano_usd_per_token INTEGER NOT NULL CHECK(nano_usd_per_token>=0),
 effective_from INTEGER NOT NULL, effective_to INTEGER, source TEXT NOT NULL,
 PRIMARY KEY(provider,model,metric,effective_from)
);
-- Preserve cumulative evidence. The first sample and resets have an unknown baseline.
CREATE VIEW usage_deltas AS
WITH previous AS (
 SELECT *,LAG(input) OVER w AS pi,LAG(output) OVER w AS po,LAG(cache_read) OVER w AS pc,LAG(model) OVER w AS pm,
 LAG(occurred_at) OVER w AS previous_at
 FROM usage_records WINDOW w AS (PARTITION BY workspace_id,stream_id,counter_epoch ORDER BY occurred_at,id)
)
SELECT workspace_id,id,agent,provider,occurred_at,previous_at,
 CASE WHEN measurement_kind='delta' OR model=pm THEN model END AS model,
 CASE WHEN measurement_kind='cumulative' AND (pi IS NULL OR input<pi OR output<po OR cache_read<pc) THEN 1 ELSE 0 END AS incomplete,
 CASE WHEN measurement_kind='delta' THEN input WHEN pi IS NULL OR input<pi OR output<po OR cache_read<pc THEN 0 ELSE MAX(input-pi-(cache_read-pc),0) END AS input,
 CASE WHEN measurement_kind='delta' THEN output WHEN pi IS NULL OR input<pi OR output<po OR cache_read<pc THEN 0 ELSE output-po END AS output,
 CASE WHEN measurement_kind='delta' THEN cache_read WHEN pi IS NULL OR input<pi OR output<po OR cache_read<pc THEN 0 ELSE cache_read-pc END AS cache_read,
 cache_write_5m,cache_write_1h FROM previous;
