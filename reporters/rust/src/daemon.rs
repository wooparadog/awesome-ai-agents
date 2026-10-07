use crate::{
    hooks,
    store::{self, Paths},
    usage,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    net::UnixDatagram,
    sync::mpsc,
    time::{Instant, sleep_until},
};
const RECONCILE: Duration = Duration::from_secs(30);
const HEARTBEAT: Duration = Duration::from_secs(300);
const HORIZON: u64 = 7 * 86400 * 1000;
const CAPACITY: u64 = 32 * 1024 * 1024;

pub fn validate_url(url: &str) -> Result<()> {
    let url = reqwest::Url::parse(url)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("collector URL must not contain credentials, query or fragment")
    }
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && ["127.0.0.1", "localhost", "[::1]"].contains(&url.host_str().unwrap_or("")))
    {
        bail!("HTTPS required except for loopback development")
    }
    Ok(())
}
pub fn http_client(config: &Value, timeout: Duration) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .pool_max_idle_per_host(1);
    if let Some(proxy) = config["proxy_url"].as_str() {
        builder = builder.proxy(reqwest::Proxy::all(proxy)?.no_proxy(reqwest::NoProxy::from_env()));
    }
    Ok(builder.build()?)
}
struct Job {
    endpoint: &'static str,
    body: Value,
    files: Vec<PathBuf>,
    presence: bool,
    presence_summary: Option<Value>,
}
struct Reply {
    job: Job,
    status: u16,
    body: Value,
    retry: u64,
}
struct Engine {
    paths: Paths,
    installation: String,
    presence: bool,
    presence_after: usize,
    scan: VecDeque<PathBuf>,
    scan_complete: bool,
    ready: bool,
    retry_at: u64,
    attempts: u32,
    single_batches: usize,
    missing_transcripts: HashMap<String, Value>,
    last_presence: Value,
    presence_cycle: Value,
}
fn presence_due(previous: &Value, summary: &Value, now: u64, live: bool) -> bool {
    previous["summary"] != *summary
        || (live
            && now.saturating_sub(previous["observed_at"].as_u64().unwrap_or(0))
                >= HEARTBEAT.as_millis() as u64)
        || previous["observed_at"]
            .as_u64()
            .is_some_and(|time| time > now)
}
impl Engine {
    fn event(
        &self,
        run: &mut Value,
        source: &str,
        data: Value,
        time: u64,
        event_id: String,
    ) -> (PathBuf, Value) {
        run["sequence"] = json!(run["sequence"].as_u64().unwrap_or(0) + 1);
        let event = json!({"event_id":event_id,"installation_id":self.installation,"execution_id":run["execution_id"],"run_id":run["run_id"],"run_generation":run["run_generation"],"sequence":run["sequence"],"agent":run["agent"],"native_session_id":run["native_session_id"],"source_event":source,"observed_at":time,"data":data});
        (
            self.paths.state.join("outbox").join(format!(
                "{:019}.{:020}-{event_id}.json",
                time.saturating_mul(1_000_000),
                run["sequence"].as_u64().unwrap_or(0)
            )),
            json!({"kind":"event","event":event}),
        )
    }
    fn ingest(&mut self) -> Result<bool> {
        let files = store::files(&self.paths.state.join("inbox"))?;
        let more = files.len() > 128;
        for path in files.into_iter().take(128) {
            let value = match store::read(&path) {
                Ok(v) => v,
                Err(_) => {
                    self.quarantine(&path)?;
                    continue;
                }
            };
            if value["fingerprint"].as_str().is_none()
                || value["native_session_id"].as_str().is_none()
            {
                self.quarantine(&path)?;
                continue;
            }
            let key = store::hash(value["fingerprint"].as_str().unwrap());
            let dest = self.paths.state.join("runs").join(format!("{key}.json"));
            let mut run = if dest.exists() {
                store::read(&dest)?
            } else {
                json!({"execution_id":store::id(),"fingerprint":value["fingerprint"],"agent":value["agent"],"pid":value["pid"],"sequence":0,"run_generation":0})
            };
            let mut writes = Vec::new();
            if run["native_session_id"] != value["native_session_id"] || run["closed"] == true {
                if let Some(id) = run["run_id"].as_str().map(str::to_owned) {
                    // The collector supersedes older generations when the new
                    // attachment arrives. Archive locally without inventing an
                    // event from an old per-run sequence counter.
                    run["closed"] = json!(true);
                    writes.push((
                        self.paths.state.join("history").join(format!("{id}.json")),
                        run.clone(),
                    ));
                }
                run["native_session_id"] = value["native_session_id"].clone();
                run["run_id"] = json!(store::id());
                run["run_generation"] = json!(run["run_generation"].as_u64().unwrap_or(0) + 1);
                run["closed"] = json!(false);
                run["asking"] = json!(false);
                run["transcript"] = Value::Null;
            }
            if value["transcript"].is_string() {
                run["transcript"] = value["transcript"].clone()
            }
            run["cwd"] = value["data"]["cwd"].clone();
            run["model"] = value["data"]["model"].clone();
            let source = value["source_event"].as_str().unwrap_or("Notification");
            if source == "PermissionRequest"
                || value["data"]["notification_type"] == "permission_prompt"
            {
                run["asking"] = json!(true)
            } else if ["UserPromptSubmit", "Stop", "SessionEnd"].contains(&source) {
                run["asking"] = json!(false)
            }
            run["attention_size"] = json!(if run["asking"] == true {
                run["transcript"]
                    .as_str()
                    .and_then(|p| fs::metadata(p).ok())
                    .map(|m| m.len())
                    .unwrap_or(0)
            } else {
                0
            });
            writes.push(self.event(
                &mut run,
                source,
                value["data"].clone(),
                value["observed_at"].as_u64().unwrap_or(store::now()),
                value["id"].as_str().unwrap_or("").to_owned(),
            ));
            if source == "SessionEnd" {
                run["closed"] = json!(true)
            }
            writes.push((dest.clone(), run));
            self.paths.transaction(writes, Some(path))?;
            self.begin_scan()?;
            if !self.scan.contains(&dest) {
                self.scan.push_back(dest)
            }
            self.ready = false;
            self.presence = true;
        }
        Ok(more)
    }
    fn begin_scan(&mut self) -> Result<()> {
        if self.scan.is_empty() {
            self.scan_complete = true;
            self.scan
                .extend(store::files(&self.paths.state.join("runs"))?);
            self.scan
                .extend(store::files(&self.paths.state.join("history"))?);
        }
        self.finish_scan()
    }
    fn scan_one(&mut self) -> Result<()> {
        let Some(path) = self.scan.pop_front() else {
            return Ok(());
        };
        let mut run = store::read(&path)?;
        if run["closed"] == true && modified(&path) + HORIZON < store::now() {
            self.clear_missing_transcript(&run, "outside_retention");
            return self.finish_scan();
        }
        if path.parent() == Some(self.paths.state.join("history").as_path())
            && run["closed"] != true
        {
            run["closed"] = json!(true);
            run["asking"] = json!(false);
            store::write(&path, &run)?;
        }
        if run["closed"] != true && run["pid"].as_u64().unwrap_or(0) > 0 && !hooks::live(&run) {
            let event = self.event(
                &mut run,
                "SessionEnd",
                json!({"reason":"process_gone"}),
                store::now(),
                store::id(),
            );
            run["closed"] = json!(true);
            run["asking"] = json!(false);
            self.paths
                .transaction(vec![event, (path.clone(), run.clone())], None)?;
            self.presence = true;
        }
        let mut transcript = run["transcript"].as_str().map(PathBuf::from);
        if !transcript.as_ref().is_some_and(|p| p.is_file()) && run["agent"] == "codex" {
            transcript = usage::discover(run["native_session_id"].as_str().unwrap_or(""));
            if let Some(p) = &transcript {
                run["transcript"] = json!(p);
                store::write(&path, &run)?
            }
        }
        if let Some(p) = transcript.filter(|p| p.is_file()) {
            self.clear_missing_transcript(&run, "transcript_found");
            if run["asking"] == true
                && hooks::live(&run)
                && fs::metadata(&p)?.len() > run["attention_size"].as_u64().unwrap_or(0)
            {
                let event = self.event(
                    &mut run,
                    "AttentionCleared",
                    json!({"reason":"transcript_growth"}),
                    store::now(),
                    store::id(),
                );
                run["asking"] = json!(false);
                self.paths
                    .transaction(vec![event, (path.clone(), run.clone())], None)?;
                self.presence = true;
            }
            let (complete, more) = usage::collect(&self.paths, &run, &p)?;
            if more {
                self.scan.push_back(path.clone());
            } else if !complete {
                self.scan_complete = false;
            }
        } else if !(run["closed"] == true && !run["transcript"].is_string()) {
            self.scan_complete = false;
            self.log_missing_transcript(&run);
        } else {
            self.clear_missing_transcript(&run, "closed_without_observed_transcript");
        }
        self.finish_scan()
    }
    fn log_missing_transcript(&mut self, run: &Value) {
        let id = run["run_id"].as_str().unwrap_or("");
        let diagnostic = json!({
            "event": "usage_coverage_incomplete",
            "reason": if run["transcript"].is_string() { "transcript_missing" } else { "transcript_not_discovered" },
            "installation": self.installation,
            "agent": run["agent"],
            "run_id": run["run_id"],
            "native_session_id": run["native_session_id"],
            "closed": run["closed"].as_bool().unwrap_or(false),
            "transcript": run["transcript"],
        });
        // Report the cause once per change, not at every reconciliation tick.
        // JSON escaping keeps paths/session metadata on a single journal line.
        if self.missing_transcripts.get(id) != Some(&diagnostic) {
            eprintln!("usage coverage incomplete: {diagnostic}");
            self.missing_transcripts.insert(id.to_owned(), diagnostic);
        }
    }
    fn clear_missing_transcript(&mut self, run: &Value, reason: &str) {
        if let Some(mut diagnostic) = self
            .missing_transcripts
            .remove(run["run_id"].as_str().unwrap_or(""))
        {
            diagnostic["event"] = json!("usage_coverage_issue_cleared");
            diagnostic["reason"] = json!(reason);
            eprintln!("usage coverage issue cleared: {diagnostic}");
        }
    }
    fn finish_scan(&mut self) -> Result<()> {
        if self.scan.is_empty() {
            if self.ready != self.scan_complete {
                self.presence = true
            }
            self.ready = self.scan_complete;
            if self.ready && !self.paths.state.join("usage-ready").exists() {
                store::atomic(&self.paths.state.join("usage-ready"), b"")?
            } else if !self.ready {
                store::remove(&self.paths.state.join("usage-ready"))?
            }
        }
        Ok(())
    }
    fn dropped(&self) -> Result<usize> {
        Ok(fs::read_dir(&self.paths.state)?
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("dropped."))
            .count())
    }
    fn quarantine(&self, path: &Path) -> Result<()> {
        fs::rename(
            path,
            self.paths
                .state
                .join("quarantine")
                .join(path.file_name().unwrap()),
        )?;
        store::atomic(
            &self.paths.state.join(format!("dropped.{}", store::id())),
            b"",
        )
    }
    fn prune(&self) -> Result<()> {
        for dir in ["inbox", "outbox", "quarantine"] {
            let files = store::files(&self.paths.state.join(dir))?;
            let mut size: u64 = files
                .iter()
                .map(|p| fs::metadata(p).map(|m| m.len()).unwrap_or(0))
                .sum();
            for path in files {
                if modified(&path) + HORIZON < store::now() || size > CAPACITY {
                    size = size.saturating_sub(fs::metadata(&path)?.len());
                    store::remove(&path)?;
                    if dir != "quarantine" {
                        store::atomic(
                            &self.paths.state.join(format!("dropped.{}", store::id())),
                            b"",
                        )?
                    }
                }
            }
        }
        Ok(())
    }
    fn presence_job(&mut self) -> Result<Option<Job>> {
        let mut runs = Vec::new();
        let mut writes = Vec::new();
        let mut candidates = Vec::new();
        for path in store::files(&self.paths.state.join("runs"))? {
            let run = store::read(&path)?;
            if hooks::live(&run) {
                candidates.push((path, run));
            }
        }
        let now = store::now();
        let hostname = fs::read_to_string("/proc/sys/kernel/hostname")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        let usage = self.ready && store::files(&self.paths.state.join("outbox"))?.is_empty();
        let dropped = self.dropped()?;
        let summary = json!({"installation":self.installation,"hostname":hostname,"usage":usage,"dropped":dropped,
            "runs":candidates.iter().map(|(_,run)|json!({"run_id":run["run_id"],"execution_id":run["execution_id"]})).collect::<Vec<_>>()});
        if self.presence_after != 0 && self.presence_cycle != summary {
            self.presence_after = 0;
        }
        if self.presence_after == 0
            && !presence_due(&self.last_presence, &summary, now, !candidates.is_empty())
        {
            self.presence = false;
            return Ok(None);
        }
        self.presence_cycle = summary.clone();
        let end = (self.presence_after + 128).min(candidates.len());
        for (path, mut run) in candidates
            .iter()
            .take(end)
            .skip(self.presence_after)
            .cloned()
        {
            run["sequence"] = json!(run["sequence"].as_u64().unwrap_or(0) + 1);
            runs.push(json!({"run_id":run["run_id"],"execution_id":run["execution_id"],"sequence":run["sequence"]}));
            writes.push((path, run));
        }
        self.presence_after = if end < candidates.len() { end } else { 0 };
        self.presence = self.presence_after != 0;
        self.paths.transaction(writes, None)?;
        Ok(Some(Job {
            endpoint: "/v1/presence",
            body: json!({"schema_version":1,"observed_at":now,"hostname":hostname,"runs":runs,"usage":usage,"dropped":dropped}),
            files: vec![],
            presence: true,
            // Only the final acknowledged page commits the complete observation.
            presence_summary: (self.presence_after == 0)
                .then(|| json!({"observed_at":now,"summary":summary})),
        }))
    }
    fn next_job(&mut self) -> Result<Option<Job>> {
        if store::now() < self.retry_at {
            return Ok(None);
        }
        let paths = store::files(&self.paths.state.join("outbox"))?;
        let mut records = Vec::new();
        let mut files = Vec::new();
        let mut kind = String::new();
        let mut bytes = 0;
        // All lifecycle records precede usage, including imported shell queues.
        for path in paths {
            let value = match store::read(&path) {
                Ok(v) => v,
                Err(_) => {
                    self.quarantine(&path)?;
                    continue;
                }
            };
            let k = value["kind"].as_str().unwrap_or("");
            if !["event", "usage"].contains(&k) {
                self.quarantine(&path)?;
                continue;
            }
            if kind.is_empty()
                && k == "usage"
                && self.presence
                && let Some(job) = self.presence_job()?
            {
                return Ok(Some(job));
            }
            if !kind.is_empty() && kind != k {
                continue;
            }
            let items = if k == "event" {
                vec![value["event"].clone()]
            } else {
                value["records"]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![value["record"].clone()])
            };
            let len = serde_json::to_vec(&items)?.len();
            let max = if k == "event" { 16 } else { 64 };
            if len > 250_000 || items.len() > max {
                self.quarantine(&path)?;
                continue;
            }
            if records.len() + items.len() > max || bytes + len > 250_000 {
                break;
            }
            kind = k.to_owned();
            bytes += len;
            records.extend(items);
            files.push(path);
            if records.len() == max || self.single_batches > 0 {
                break;
            }
        }
        if !files.is_empty() {
            let (endpoint, key) = if kind == "event" {
                ("/v1/events", "events")
            } else {
                ("/v1/usage", "records")
            };
            return Ok(Some(Job {
                endpoint,
                body: json!({"schema_version":1,key:records}),
                files,
                presence: false,
                presence_summary: None,
            }));
        }
        if self.presence {
            // Do not advertise a transient scan state before local reconciliation
            // has had a chance to discover closures and late transcript records.
            if !self.scan.is_empty() {
                return Ok(None);
            }
            return self.presence_job();
        }
        Ok(None)
    }
    fn complete(&mut self, reply: Reply) -> Result<()> {
        let ack = reply.body["accepted"].as_array();
        let accepted = reply.status == 200
            && (reply.job.presence || {
                let ids: HashSet<_> = ack
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let (key, id) = if reply.job.endpoint == "/v1/events" {
                    ("events", "event_id")
                } else {
                    ("records", "native_record_id")
                };
                reply.job.body[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|v| v[id].as_str().is_some_and(|s| ids.contains(s)))
            });
        if accepted {
            if let Some(summary) = &reply.job.presence_summary {
                store::write(&self.paths.state.join("presence-last.json"), summary)?;
                self.last_presence = summary.clone();
            }
            self.single_batches = self.single_batches.saturating_sub(reply.job.files.len());
            for path in &reply.job.files {
                store::remove(path)?
            }
            if !reply.job.presence
                && (reply.job.endpoint == "/v1/events"
                    || store::files(&self.paths.state.join("outbox"))?.is_empty())
            {
                self.presence = true
            }
            self.retry_at = 0;
            self.attempts = 0;
            store::remove(&self.paths.state.join("retry-at"))?;
            store::remove(&self.paths.state.join("attempts"))?;
        } else if !reply.job.presence
            && (matches!(reply.status, 400 | 403 | 410 | 413 | 415)
                || (reply.status == 409 && reply.body["error"] != "run not yet ingested"))
        {
            if reply.job.files.len() > 1 {
                self.single_batches = reply.job.files.len();
                return Ok(());
            }
            if reply.job.endpoint == "/v1/usage" {
                let records = reply.job.body["records"].as_array().unwrap();
                if records.len() > 1 {
                    let writes = records
                        .iter()
                        .map(|record| {
                            let value = json!({"kind":"usage","records":[record]});
                            (
                                self.paths.state.join("outbox").join(format!(
                                    "usage-{}.json",
                                    store::hash(&value.to_string())
                                )),
                                value,
                            )
                        })
                        .collect();
                    self.paths
                        .transaction(writes, reply.job.files.first().cloned())?;
                    self.single_batches = records.len();
                    return Ok(());
                }
            }
            self.single_batches = self.single_batches.saturating_sub(1);
            for path in reply.job.files {
                self.quarantine(&path)?
            }
            self.presence = true;
            eprintln!(
                "collector rejected queued batch (HTTP {}); moved to quarantine",
                reply.status
            );
        } else {
            self.presence = true;
            self.presence_after = 0;
            self.attempts = (self.attempts + 1).min(10);
            let delay = (2u64 << self.attempts).min(300).max(reply.retry.min(86400));
            let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) % 5;
            self.retry_at = store::now() + (delay + jitter) * 1000;
            store::atomic(
                &self.paths.state.join("retry-at"),
                (self.retry_at / 1000).to_string().as_bytes(),
            )?;
            store::atomic(
                &self.paths.state.join("attempts"),
                self.attempts.to_string().as_bytes(),
            )?;
            eprintln!(
                "upload deferred (HTTP {}); retry in {} seconds",
                reply.status,
                delay + jitter
            );
        }
        Ok(())
    }
}
fn modified(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
fn lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.try_lock().with_context(|| {
        format!(
            "another reporter holds {}; stop it before starting the daemon",
            path.display()
        )
    })?;
    Ok(file)
}
async fn send(client: reqwest::Client, url: String, token: String, job: Job) -> Reply {
    let mut status = 0;
    let mut retry = 0;
    let mut body = Value::Null;
    if let Ok(mut response) = client
        .post(format!("{url}{}", job.endpoint))
        .bearer_auth(token)
        .json(&job.body)
        .send()
        .await
    {
        status = response.status().as_u16();
        retry = response
            .headers()
            .get("retry-after")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            if bytes.len() + chunk.len() > 262144 {
                break;
            }
            bytes.extend(chunk);
        }
        body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    }
    Reply {
        job,
        status,
        body,
        retry,
    }
}
pub async fn run(paths: Paths) -> Result<()> {
    paths.prepare()?;
    let _locks = [
        lock(&paths.state.join("lock"))?,
        lock(&paths.state.join("flush.lock"))?,
        lock(&paths.state.join("usage.lock"))?,
    ];
    paths.recover()?;
    let config = store::read(&paths.config.join("config.json"))?;
    let url = config["url"]
        .as_str()
        .context("missing collector URL")?
        .trim_end_matches('/')
        .to_owned();
    validate_url(&url)?;
    let token = fs::read_to_string(paths.config.join("write.token"))?
        .trim()
        .to_owned();
    let installation = config["installation_id"]
        .as_str()
        .context("missing installation ID")?
        .to_owned();
    let client = http_client(&config, Duration::from_secs(10))?;
    store::remove(&paths.socket())?;
    let socket = UnixDatagram::bind(paths.socket())?;
    fs::set_permissions(paths.socket(), fs::Permissions::from_mode(0o600))?;
    let retry_at = fs::read_to_string(paths.state.join("retry-at"))
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
        * 1000;
    let attempts = fs::read_to_string(paths.state.join("attempts"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let mut engine = Engine {
        paths: paths.clone(),
        installation,
        presence: true,
        presence_after: 0,
        scan: VecDeque::new(),
        scan_complete: true,
        ready: false,
        retry_at,
        attempts,
        single_batches: 0,
        missing_transcripts: HashMap::new(),
        last_presence: store::read(&paths.state.join("presence-last.json")).unwrap_or(Value::Null),
        presence_cycle: Value::Null,
    };
    let (tx, mut rx) = mpsc::channel(1);
    let mut inflight = false;
    let mut next_reconcile = Instant::now();
    let mut next_presence = Instant::now()
        + Duration::from_millis(
            engine.last_presence["observed_at"]
                .as_u64()
                .unwrap_or(0)
                .saturating_add(HEARTBEAT.as_millis() as u64)
                .saturating_sub(store::now())
                .min(HEARTBEAT.as_millis() as u64),
        );
    let mut next_scan = Instant::now();
    let mut next_prune = Instant::now();
    let mut buffer = [0; 64];
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    eprintln!(
        "reporting daemon started (installation {})",
        engine.installation
    );
    loop {
        let more = engine.ingest()?;
        if Instant::now() >= next_prune {
            engine.prune()?;
            next_prune = Instant::now() + HEARTBEAT;
        }
        if Instant::now() >= next_reconcile {
            engine.begin_scan()?;
            next_reconcile = Instant::now() + RECONCILE;
            store::write(
                &paths.state.join("daemon-status.json"),
                &json!({"pid":std::process::id(),"fingerprint":hooks::process(u64::from(std::process::id())).map(|p|p.0),"updated_at":store::now(),"usage_ready":engine.ready,"retry_at":engine.retry_at}),
            )?;
        }
        if Instant::now() >= next_presence {
            engine.presence = true;
            next_presence = Instant::now() + HEARTBEAT;
        }
        if Instant::now() >= next_scan && !engine.scan.is_empty() {
            engine.scan_one()?;
            next_scan = Instant::now() + Duration::from_millis(10);
        }
        if !inflight && let Some(job) = engine.next_job()? {
            let tx = tx.clone();
            let client = client.clone();
            let url = url.clone();
            let token = token.clone();
            inflight = true;
            tokio::spawn(async move {
                let reply = send(client, url, token, job).await;
                let _ = tx.send(reply).await;
            });
        }
        let mut deadline = next_reconcile.min(next_presence);
        if !engine.scan.is_empty() {
            deadline = deadline.min(next_scan)
        }
        if more {
            deadline = Instant::now()
        }
        if !inflight && engine.retry_at > store::now() {
            deadline = deadline.min(
                Instant::now()
                    + Duration::from_millis(engine.retry_at.saturating_sub(store::now())),
            )
        }
        tokio::select! {
            _=terminate.recv()=>break,
            _=interrupt.recv()=>break,
            received=socket.recv(&mut buffer)=>{let n=received?; if &buffer[..n]==b"reconcile" {next_reconcile=Instant::now();}},
            Some(reply)=rx.recv()=>{
                inflight=false;
                let renewed = reply.status == 200 && reply.job.presence_summary.is_some();
                engine.complete(reply)?;
                if renewed { next_presence = Instant::now() + HEARTBEAT; }
            },
            _=sleep_until(deadline)=>{},
        }
    }
    store::remove(&paths.socket())?;
    store::remove(&paths.state.join("daemon-status.json"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledged_idle_state_stays_silent_for_eight_hours() {
        let summary = json!({"runs":[],"usage":true,"dropped":0});
        let saved = json!({"observed_at":1000,"summary":summary});
        // Serialization models a daemon restart; elapsed time alone is not work.
        let restored: Value = serde_json::from_str(&saved.to_string()).unwrap();
        for minute in 0..=480 {
            assert!(!presence_due(
                &restored,
                &summary,
                1000 + minute * 60000,
                false
            ));
        }
        assert!(presence_due(
            &saved,
            &json!({"runs":[],"usage":false,"dropped":0}),
            2000,
            false
        ));
        assert!(presence_due(
            &saved,
            &json!({"runs":[],"usage":true,"dropped":1}),
            2000,
            false
        ));
    }
    #[test]
    fn live_processes_still_renew_leases_and_clock_rollback_is_not_suppressed() {
        let summary = json!({"runs":["r"],"usage":true});
        let saved = json!({"observed_at":1000,"summary":summary});
        assert!(!presence_due(&saved, &summary, 300999, true));
        assert!(presence_due(&saved, &summary, 301000, true));
        assert!(presence_due(&saved, &summary, 0, true));
        assert!(presence_due(
            &saved,
            &json!({"runs":[],"usage":true}),
            2000,
            false
        ));
        assert!(presence_due(&Value::Null, &summary, 2000, true));
    }
}
