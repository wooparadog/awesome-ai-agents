use crate::store::{self, Paths};
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
const CHUNK: usize = 1024 * 1024;
const MAX_LINE: usize = 16 * 1024 * 1024;
fn n(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap_or(0)
}

fn pricing_metadata(usage: &Value, response: &Value) -> Value {
    let mut result = json!({});
    for key in ["service_tier", "speed", "inference_geo", "billing_provider"] {
        // Returned billing metadata takes precedence over request preferences.
        let value = usage
            .get(key)
            .filter(|v| v.is_string())
            .or_else(|| response.get(key));
        if let Some(value) = value.filter(|v| v.is_string()) {
            result[key] = value.clone();
        }
    }
    result
}

// Preserve provider IDs and the shell reporter's cumulative ID serialization.
// Content/tool text is never copied into records.
pub fn parse(
    line: &Value,
    agent: &str,
    sid: &str,
    rid: &str,
    model: &mut Value,
    responses: bool,
) -> Option<Value> {
    if agent == "codex" && line["type"] == "turn_context" {
        if line["payload"]["model"].is_string() {
            *model = line["payload"]["model"].clone()
        };
        return None;
    }
    let (provider, id, stream, epoch, kind, record_model, u, counters) = if agent == "claude"
        && line["type"] == "assistant"
        && line["message"]["usage"].is_object()
    {
        let m = &line["message"];
        let id = m["id"].as_str()?;
        let u = &m["usage"];
        let id = format!("{id}|{}", line["requestId"].as_str().unwrap_or(""));
        (
            "anthropic",
            id.clone(),
            id,
            "0",
            "delta",
            m["model"].clone(),
            u,
            json!({"input":n(u,"input_tokens"),"output":n(u,"output_tokens"),"cache_read":n(u,"cache_read_input_tokens"),"cache_write_5m":u["cache_creation"]["ephemeral_5m_input_tokens"].as_u64().unwrap_or(n(u,"cache_creation_input_tokens").saturating_sub(n(&u["cache_creation"],"ephemeral_1h_input_tokens"))),"cache_write_1h":n(&u["cache_creation"],"ephemeral_1h_input_tokens")}),
        )
    } else if agent == "codex"
        && line["type"] == "token_usage_record"
        && line["payload"]["usage"].is_object()
    {
        let p = &line["payload"];
        let u = &p["usage"];
        let id = p["response_id"].as_str()?.to_owned();
        let cached = u["cached_input_tokens"]
            .as_u64()
            .unwrap_or(n(&u["input_tokens_details"], "cached_tokens"));
        let written = u["cache_write_input_tokens"]
            .as_u64()
            .unwrap_or(n(&u["input_tokens_details"], "cache_write_tokens"));
        (
            "openai",
            id,
            p["thread_id"].as_str().unwrap_or(sid).to_owned(),
            "responses-v1",
            "delta",
            p.get("model")
                .filter(|m| m.is_string())
                .unwrap_or(model)
                .clone(),
            u,
            json!({"input":n(u,"input_tokens").saturating_sub(cached).saturating_sub(written),"output":n(u,"output_tokens"),"cache_read":cached,"cache_write_5m":written,"cache_write_1h":0}),
        )
    } else if agent == "codex"
        && !responses
        && line["type"] == "event_msg"
        && line["payload"]["type"] == "token_count"
        && line["payload"]["info"]["total_token_usage"].is_object()
    {
        let u = &line["payload"]["info"]["total_token_usage"];
        let id = format!("{sid}|{}|{}", line["timestamp"].as_str()?, u);
        (
            "openai",
            id,
            sid.to_owned(),
            "0",
            "cumulative",
            model.clone(),
            u,
            json!({"input":n(u,"input_tokens"),"output":n(u,"output_tokens"),"cache_read":n(u,"cached_input_tokens"),"cache_write_5m":0,"cache_write_1h":0}),
        )
    } else {
        return None;
    };
    if record_model == "<synthetic>" || line["timestamp"].is_null() {
        return None;
    }
    let mut record = json!({"agent":agent,"provider":provider,"run_id":rid,"native_record_id":id,"stream_id":stream,"counter_epoch":epoch,"model":record_model,"occurred_at":line["timestamp"],"measurement_kind":kind,"counters":counters});
    if kind == "delta" {
        let metadata = pricing_metadata(
            u,
            if agent == "claude" {
                &line["message"]
            } else {
                &line["payload"]
            },
        );
        if metadata.as_object().is_some_and(|m| !m.is_empty()) {
            record["pricing"] = metadata;
        }
    }
    Some(record)
}
pub fn discover(sid: &str) -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".codex")
        });
    let mut dirs = vec![home.join("archived_sessions"), home.join("sessions")];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                dirs.push(entry.path())
            } else if kind.is_file()
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|s| s.ends_with(".jsonl") && s.contains(sid))
            {
                return Some(entry.path());
            }
        }
    }
    None
}
/// Read at most 1 MiB per run per pass. Partial lines stay unconsumed; an
/// exceptionally long line uses bounded reads up to the legacy 16 MiB limit.
/// Outbox writes reach disk before cursor advancement, so crashes only replay IDs.
pub fn collect(paths: &Paths, run: &Value, path: &Path) -> Result<(bool, bool)> {
    let rid = run["run_id"].as_str().unwrap_or("");
    let sid = run["native_session_id"].as_str().unwrap_or("");
    let agent = run["agent"].as_str().unwrap_or("");
    let key = store::hash(&format!("{rid}\n{}", path.display()));
    let cursor_path = paths.state.join("cursors").join(format!("{key}.json"));
    let mut cursor = if cursor_path.exists() {
        store::read(&cursor_path)?
    } else {
        json!({"offset":0,"model":null})
    };
    let closed = run["closed"].as_bool().unwrap_or(false);
    if closed && cursor["finalized"] == true && cursor["version"].as_u64().unwrap_or(0) >= 3 {
        return Ok((true, false));
    }
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    let inode = format!("{}:{}", meta.dev(), meta.ino());
    let size = meta.len();
    let mut offset = cursor["offset"].as_u64().unwrap_or(0);
    if size < offset
        || cursor["inode"].as_str() != Some(&inode)
        || cursor["version"].as_u64().unwrap_or(0) < 3
    {
        offset = 0;
        cursor = json!({"model":null,"mode":"cumulative"});
    }
    if size <= offset {
        if closed {
            cursor["finalized"] = json!(true);
            store::write(&cursor_path, &cursor)?
        }
        return Ok((true, false));
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::with_capacity(CHUNK);
    (&mut file).take(CHUNK as u64).read_to_end(&mut bytes)?;
    while !bytes.contains(&b'\n') && bytes.len() < MAX_LINE && offset + (bytes.len() as u64) < size
    {
        (&mut file).take(CHUNK as u64).read_to_end(&mut bytes)?;
    }
    let Some(last) = bytes.iter().rposition(|&b| b == b'\n') else {
        if bytes.len() >= MAX_LINE {
            store::atomic(&paths.state.join(format!("dropped.oversized-{key}")), b"")?;
            cursor["offset"] = json!(offset + bytes.len() as u64);
            cursor["inode"] = json!(inode);
            cursor["discard"] = json!(true);
            cursor["version"] = json!(3);
            store::write(&cursor_path, &cursor)?;
        }
        return Ok((
            false,
            bytes.len() >= MAX_LINE && offset + (bytes.len() as u64) < size,
        ));
    };
    let more = offset + (bytes.len() as u64) < size;
    let consumed = last + 1;
    bytes.truncate(consumed);
    let mut lines = bytes.split(|&b| b == b'\n').filter(|s| !s.is_empty());
    if cursor["discard"] == true {
        lines.next();
    }
    // Two passes avoid retaining parsed transcript text. Matching the legacy
    // adapter suppresses cumulative counters in chunks with exact responses.
    let responses = cursor["mode"] == "responses"
        || lines.clone().any(|raw| {
            serde_json::from_slice::<Value>(raw).is_ok_and(|v| {
                v["type"] == "token_usage_record" && v["payload"]["response_id"].is_string()
            })
        });
    let mut model = cursor["model"].clone();
    if model == "" {
        model = Value::Null
    }
    let mut records = Vec::new();
    let mut record_bytes = 0;
    for raw in lines {
        match serde_json::from_slice::<Value>(raw) {
            Ok(line) => {
                if let Some(record) = parse(&line, agent, sid, rid, &mut model, responses) {
                    let len = serde_json::to_vec(&record)?.len();
                    if len > 200_000 {
                        store::atomic(&paths.state.join(format!("dropped.invalid-{key}")), b"")?;
                        continue;
                    }
                    if records.len() == 64 || record_bytes + len > 200_000 {
                        queue(paths, &records)?;
                        records.clear();
                        record_bytes = 0;
                    }
                    // Claude content blocks repeat message usage with a new timestamp.
                    let mut comparison = record.clone();
                    comparison.as_object_mut().unwrap().remove("occurred_at");
                    let duplicate = agent == "claude"
                        && records.iter().any(|r: &Value| {
                            let mut r = r.clone();
                            r.as_object_mut().unwrap().remove("occurred_at");
                            r == comparison
                        });
                    if !duplicate {
                        record_bytes += len;
                        records.push(record)
                    }
                }
            }
            Err(_) => store::atomic(&paths.state.join(format!("dropped.invalid-{key}")), b"")?,
        }
    }
    queue(paths, &records)?;
    let offset = offset + consumed as u64;
    store::write(
        &cursor_path,
        &json!({"offset":offset,"model":model,"inode":inode,"mode":if responses{"responses"}else{"cumulative"},"version":3,"finalized":closed && offset>=size,"discard":false}),
    )?;
    Ok((offset >= size, more))
}
fn queue(paths: &Paths, records: &[Value]) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }
    let value = json!({"kind":"usage","records":records});
    store::write(
        &paths
            .state
            .join("outbox")
            .join(format!("usage-{}.json", store::hash(&value.to_string()))),
        &value,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn response_billing_metadata_and_nested_cache_counters_are_preserved() {
        let line = json!({"type":"token_usage_record","timestamp":"2026-09-11T00:00:00Z",
            "payload":{"response_id":"r","model":"gpt-5.6-sol","service_tier":"fast",
                "usage":{"input_tokens":300000,"output_tokens":1000,
                    "input_tokens_details":{"cached_tokens":200000,"cache_write_tokens":10000}},
                "content":"PRIVATE"}});
        let record = parse(&line, "codex", "s", "run", &mut json!("gpt-5"), false).unwrap();
        assert_eq!(record["model"], "gpt-5.6-sol");
        assert_eq!(
            record["counters"],
            json!({"input":90000,"cache_read":200000,"cache_write_5m":10000,"cache_write_1h":0,"output":1000})
        );
        assert_eq!(record["pricing"], json!({"service_tier":"fast"}));
        assert!(!record.to_string().contains("PRIVATE"));
    }
    #[test]
    fn claude_cache_fallback_does_not_count_hour_writes_twice() {
        let line = json!({"type":"assistant","timestamp":"2026-09-11T00:00:00Z",
            "message":{"id":"msg","model":"claude-opus-5","usage":{
                "input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":100,
                "cache_creation":{"ephemeral_1h_input_tokens":60},
                "service_tier":"standard","speed":"fast","inference_geo":"us"}}});
        let record = parse(&line, "claude", "s", "r", &mut Value::Null, false).unwrap();
        assert_eq!(record["counters"]["cache_write_5m"], 40);
        assert_eq!(record["counters"]["cache_write_1h"], 60);
        assert_eq!(
            record["pricing"],
            json!({"service_tier":"standard","speed":"fast","inference_geo":"us"})
        );
    }
    #[test]
    fn cumulative_identity_preserves_transcript_key_order() {
        let line:Value=serde_json::from_str(r#"{"type":"event_msg","timestamp":"2026-09-10T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":5,"input_tokens":100,"cached_input_tokens":20}}}}"#).unwrap();
        let record = parse(&line, "codex", "session", "run", &mut json!("model"), false).unwrap();
        assert_eq!(
            record["native_record_id"],
            "session|2026-09-10T00:00:00Z|{\"output_tokens\":5,\"input_tokens\":100,\"cached_input_tokens\":20}"
        );
        assert!(parse(&line, "codex", "session", "run", &mut Value::Null, true).is_none());
    }
    #[test]
    fn malformed_and_oversized_lines_do_not_stall_following_usage() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths {
            config: temp.path().join("config"),
            state: temp.path().join("state"),
        };
        paths.prepare().unwrap();
        let path = temp.path().join("transcript");
        let mut bytes = vec![b'x'; MAX_LINE + 30];
        bytes.extend_from_slice(b"\ninvalid-json\n");
        let line = json!({"type":"assistant","timestamp":"2026-09-10T00:00:00Z","message":{"id":"good","model":"claude","usage":{"input_tokens":5}}});
        bytes.extend_from_slice(line.to_string().as_bytes());
        bytes.push(b'\n');
        fs::write(&path, bytes).unwrap();
        let run = json!({"run_id":"run","native_session_id":"session","agent":"claude"});
        assert_eq!(collect(&paths, &run, &path).unwrap(), (false, true));
        assert_eq!(collect(&paths, &run, &path).unwrap(), (true, false));
        let queued = store::files(&paths.state.join("outbox")).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(
            store::read(&queued[0]).unwrap()["records"][0]["native_record_id"],
            "good|"
        );
        assert_eq!(
            fs::read_dir(&paths.state)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("dropped."))
                .count(),
            2
        );
    }
}
