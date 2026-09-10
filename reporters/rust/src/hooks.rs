use crate::store::{self, Paths};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Read},
    os::unix::net::UnixDatagram,
};

pub fn process(pid: u64) -> Option<(String, u64)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    let parent = fields.get(1)?.parse().ok()?;
    let start = fields.get(19)?;
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    Some((format!("{}:{pid}:{start}", boot.trim()), parent))
}
pub fn ancestor() -> u64 {
    let mut pid = u64::from(std::process::id());
    for _ in 0..16 {
        let Some((_, parent)) = process(pid) else {
            break;
        };
        pid = parent;
        if pid <= 1 {
            break;
        }
        if fs::read_to_string(format!("/proc/{pid}/comm"))
            .is_ok_and(|s| s.starts_with("codex") || s.starts_with("claude"))
        {
            return pid;
        }
    }
    0
}
pub fn live(run: &Value) -> bool {
    !run["closed"].as_bool().unwrap_or(false)
        && process(run["pid"].as_u64().unwrap_or(0))
            .is_some_and(|(fp, _)| Some(fp.as_str()) == run["fingerprint"].as_str())
}
pub fn envelope(agent: &str, event: &str, payload: &Value) -> Result<Value> {
    if !["claude", "codex"].contains(&agent)
        || ![
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "Notification",
            "Stop",
            "SessionEnd",
        ]
        .contains(&event)
    {
        bail!("unsupported hook")
    }
    let sid = payload["session_id"]
        .as_str()
        .or_else(|| payload["sessionId"].as_str())
        .filter(|s| !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control))
        .ok_or_else(|| anyhow::anyhow!("missing session ID"))?;
    let pid = ancestor();
    let fingerprint = process(pid)
        .map(|v| v.0)
        .unwrap_or_else(|| format!("unknown:{agent}:{sid}"));
    let message = payload["message"].as_str().unwrap_or("").to_lowercase();
    let notification = payload["notification_type"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control))
        .or_else(|| {
            if ["permission", "approve", "confirm"]
                .iter()
                .any(|v| message.contains(v))
            {
                Some("permission_prompt")
            } else if ["waiting", "input", "idle"]
                .iter()
                .any(|v| message.contains(v))
            {
                Some("idle_prompt")
            } else {
                None
            }
        });
    let mut data = json!({"pid":pid,"notification_type":notification});
    for (key, max) in [("cwd", 2048), ("model", 200), ("source", 200)] {
        if let Some(s) = payload[key]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        {
            data[key] = json!(s)
        }
    }
    let transcript = payload["transcript_path"]
        .as_str()
        .filter(|s| s.len() <= 4096);
    Ok(
        json!({"id":store::id(),"observed_at":store::now(),"agent":agent,"source_event":event,"native_session_id":sid,"pid":pid,"fingerprint":fingerprint,"transcript":transcript,"data":data}),
    )
}
pub fn report(paths: &Paths, agent: &str, event: &str) -> Result<()> {
    let mut bytes = Vec::new();
    io::stdin().take(1_048_577).read_to_end(&mut bytes)?;
    if bytes.len() > 1_048_576 {
        bail!("hook payload too large")
    }
    let value = envelope(agent, event, &serde_json::from_slice(&bytes)?)?;
    paths.prepare()?;
    // Persist only allowlisted metadata before waking the daemon. If it is down,
    // startup consumes this same inbox without losing the event.
    let name = format!(
        "{:020}-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        value["id"].as_str().unwrap()
    );
    store::write(&paths.state.join("inbox").join(name), &value)?;
    wake(paths);
    Ok(())
}
pub fn wake(paths: &Paths) {
    if let Ok(socket) = UnixDatagram::unbound() {
        let _ = socket.set_nonblocking(true);
        let _ = socket.send_to(b"wake", paths.socket());
    }
}
