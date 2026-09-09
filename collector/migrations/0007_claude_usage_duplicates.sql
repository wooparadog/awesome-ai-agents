-- Claude writes the same message usage on multiple content blocks. Their local
-- transcript timestamps differ, but the provider message/request ID is identical.
-- Keep the first timestamp; changed models, counters or identities still conflict.
DROP TRIGGER usage_validate;
CREATE TRIGGER usage_validate BEFORE INSERT ON usage_records BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM usage_records WHERE workspace_id=NEW.workspace_id
 AND id=NEW.id AND payload_hash!=NEW.payload_hash AND NOT (
   provider='anthropic' AND NEW.provider=provider AND agent=NEW.agent
   AND measurement_kind='delta' AND NEW.measurement_kind=measurement_kind
   AND native_record_id=NEW.native_record_id AND stream_id=NEW.stream_id
   AND counter_epoch=NEW.counter_epoch AND model IS NEW.model
   AND input=NEW.input AND output=NEW.output AND cache_read=NEW.cache_read
   AND cache_write_5m=NEW.cache_write_5m AND cache_write_1h=NEW.cache_write_1h
 )) THEN RAISE(ABORT,'usage conflict') END);
END;
