# Read only complete JSONL records. Output contains accounting metadata only.
# Carry model context across chunks for Codex's cumulative snapshots.
foreach inputs as $raw ({model:$model, records:[]};
  (try ($raw|fromjson) catch {__parse_error:true}) as $line |
  .invalid=($line.__parse_error//false) |
  .records=[] |
  if $agent=="claude" then
    if $line.type=="assistant" and $line.message.usage!=null and $line.message.id!=null and $line.timestamp!=null then
      $line.message as $m | $m.usage as $u |
      .records=[{agent:$agent,provider:"anthropic",run_id:$run,
        native_record_id:($m.id+"|"+($line.requestId//"")),stream_id:($m.id+"|"+($line.requestId//"")),counter_epoch:"0",
        model:$m.model,occurred_at:$line.timestamp,measurement_kind:"delta",
        counters:{input:($u.input_tokens//0),output:($u.output_tokens//0),cache_read:($u.cache_read_input_tokens//0),
          cache_write_5m:($u.cache_creation.ephemeral_5m_input_tokens//$u.cache_creation_input_tokens//0),
          cache_write_1h:($u.cache_creation.ephemeral_1h_input_tokens//0)}}] else . end
  elif $agent=="codex" then
    if $line.type=="turn_context" then .model=($line.payload.model//.model)
    elif $mode=="responses" and $line.type=="token_usage_record" and $line.payload.response_id!=null and $line.payload.usage!=null then
      $line.payload as $p | $p.usage as $u |
      .records=[{agent:$agent,provider:"openai",run_id:$run,
        native_record_id:$p.response_id,stream_id:($p.thread_id//$session),counter_epoch:"responses-v1",
        model:(if .model=="" then null else .model end),occurred_at:$line.timestamp,measurement_kind:"delta",
        counters:{input:([0,($u.input_tokens//0)-($u.cached_input_tokens//0)-($u.cache_write_input_tokens//0)]|max),
          output:($u.output_tokens//0),cache_read:($u.cached_input_tokens//0),
          cache_write_5m:($u.cache_write_input_tokens//0),cache_write_1h:0}}]
    elif $mode!="responses" and $line.type=="event_msg" and $line.payload.type=="token_count" and $line.payload.info.total_token_usage!=null then
      $line.payload.info.total_token_usage as $u |
      .records=[{agent:$agent,provider:"openai",run_id:$run,
        native_record_id:($session+"|"+$line.timestamp+"|"+($u|tojson)),stream_id:$session,counter_epoch:"0",
        model:(if .model=="" then null else .model end),occurred_at:$line.timestamp,measurement_kind:"cumulative",
        counters:{input:($u.input_tokens//0),output:($u.output_tokens//0),cache_read:($u.cached_input_tokens//0),cache_write_5m:0,cache_write_1h:0}}]
    else . end
  else . end;
  {model,records,invalid})
