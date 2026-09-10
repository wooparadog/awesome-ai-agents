use anyhow::{Context, Result, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub fn read(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(
        &fs::read(path).with_context(|| format!("read {}", path.display()))?,
    )?)
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("missing parent")?;
    let temp = parent.join(format!(".tmp-{}", id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn write(path: &Path, value: &Value) -> Result<()> {
    atomic(path, &serde_json::to_vec(value)?)
}
pub fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {
            File::open(path.parent().unwrap())?.sync_all()?;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub fn files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.path().extension().is_some_and(|e| e == "json") {
            files.push(entry.path());
        }
    }
    files.sort();
    Ok(files)
}
#[derive(Clone)]
pub struct Paths {
    pub config: PathBuf,
    pub state: PathBuf,
}
impl Paths {
    pub fn environment() -> Result<Self> {
        let home = PathBuf::from(env::var_os("HOME").context("HOME is unset")?);
        let config = env::var_os("AI_AGENTS_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".config"))
                    .join("ai-agents")
            });
        let state = env::var_os("AI_AGENTS_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::var_os("XDG_STATE_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".local/state"))
                    .join("ai-agents")
            });
        Ok(Self { config, state })
    }
    pub fn prepare(&self) -> Result<()> {
        for dir in [
            self.config.clone(),
            self.state.clone(),
            self.state.join("inbox"),
            self.state.join("outbox"),
            self.state.join("runs"),
            self.state.join("history"),
            self.state.join("cursors"),
            self.state.join("quarantine"),
        ] {
            fs::create_dir_all(&dir)?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
    pub fn socket(&self) -> PathBuf {
        self.state.join("daemon.sock")
    }
    // A tiny write-ahead transaction makes run/sequence updates and inbox removal
    // atomic across crashes. Replay is idempotent and precedes any network work.
    pub fn transaction(
        &self,
        writes: Vec<(PathBuf, Value)>,
        delete: Option<PathBuf>,
    ) -> Result<()> {
        write(
            &self.state.join("transaction.json"),
            &serde_json::json!({"writes":writes,"delete":delete}),
        )?;
        self.recover()
    }
    pub fn recover(&self) -> Result<()> {
        let path = self.state.join("transaction.json");
        if !path.exists() {
            return Ok(());
        }
        let value = read(&path)?;
        let writes: Vec<(PathBuf, Value)> = serde_json::from_value(value["writes"].clone())?;
        for (dest, value) in writes {
            if !dest.starts_with(&self.state) {
                bail!("invalid transaction path")
            }
            write(&dest, &value)?;
        }
        if let Some(dest) = value["delete"].as_str() {
            let dest = Path::new(dest);
            if !dest.starts_with(&self.state) {
                bail!("invalid transaction path")
            }
            remove(dest)?;
        }
        remove(&path)
    }
}
