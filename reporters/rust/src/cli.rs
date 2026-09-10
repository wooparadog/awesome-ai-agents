use crate::{
    daemon, hooks,
    store::{self, Paths},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, IsTerminal},
    time::Duration,
};

fn color(text: &str, code: &str) -> String {
    if io::stdout().is_terminal() && env::var_os("NO_COLOR").is_none() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_owned()
    }
}
fn field(label: &str, value: impl std::fmt::Display) {
    println!("  {label:<17} {value}")
}
fn safe(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}
fn count(paths: &Paths, directory: &str) -> Result<usize> {
    let path = paths.state.join(directory);
    if !path.exists() {
        return Ok(0);
    }
    Ok(store::files(&path)?.len())
}
pub fn status(paths: &Paths, as_json: bool) -> Result<()> {
    let mut health = store::read(&paths.state.join("daemon-status.json")).unwrap_or(json!({}));
    let running = hooks::process(health["pid"].as_u64().unwrap_or(0))
        .is_some_and(|p| Some(p.0.as_str()) == health["fingerprint"].as_str());
    health["running"] = json!(running);
    let config = if paths.config.join("config.json").exists() {
        store::read(&paths.config.join("config.json"))?
    } else {
        json!({})
    };
    let queued = count(paths, "outbox")?;
    let pending = count(paths, "inbox")?;
    let quarantined = count(paths, "quarantine")?;
    let value = json!({"installation":config["installation_id"],"collector":config["url"],"daemon":health,"queued":queued,"pending_hooks":pending,"quarantined":quarantined});
    if as_json {
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    println!(
        "\n  {}  {}\n",
        color("AGENT//GRID", "1;92"),
        color("reporter status", "90")
    );
    field(
        "Installation",
        safe(
            config["installation_id"]
                .as_str()
                .unwrap_or("not configured"),
        ),
    );
    field(
        "Collector",
        safe(config["url"].as_str().unwrap_or("not configured")),
    );
    field(
        "Daemon",
        if running {
            color(&format!("running · PID {}", health["pid"]), "92")
        } else {
            color("stopped", "93")
        },
    );
    if let Some(updated) = health["updated_at"].as_u64() {
        field(
            "Last health check",
            format!("{}s ago", store::now().saturating_sub(updated) / 1000),
        );
    }
    field("Pending hooks", pending);
    field("Queued uploads", queued);
    field("Quarantined", quarantined);
    field(
        "Usage coverage",
        if health["usage_ready"] == true && queued == 0 && pending == 0 {
            "complete"
        } else {
            "incomplete / awaiting reports"
        },
    );
    let retry = fs::read_to_string(paths.state.join("retry-at"))
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(0)
        * 1000;
    if retry > store::now() {
        field(
            "Next retry",
            format!("in {}s", (retry - store::now()).div_ceil(1000)),
        );
    }
    println!(
        "\n  {}\n",
        color("ai-agents web  →  open the live panel", "90")
    );
    Ok(())
}
pub fn help() {
    println!(
        "\n  {}  Local agent telemetry\n",
        color("AGENT//GRID", "1;92")
    );
    for (command, description) in [
        (
            "status [--json]",
            "Show reporter health and pending uploads",
        ),
        (
            "web [--expires 10m] [--json]",
            "Generate a single-use web login link (1m–1h)",
        ),
        (
            "reconcile / flush",
            "Wake the daemon; preserve server retry delays",
        ),
        ("daemon", "Run the reporter in the foreground"),
        (
            "init URL ID TOKEN_FILE",
            "Configure a collector and its write credential",
        ),
        ("hook AGENT EVENT", "Accept a native hook payload on stdin"),
    ] {
        println!("  {command:<34} {description}")
    }
    println!("\n  NO_COLOR=1 disables terminal colors. --json keeps output scriptable.\n");
}
pub fn duration(value: &str) -> Result<u64> {
    let (digits, multiplier) = if let Some(s) = value.strip_suffix('m') {
        (s, 60)
    } else if let Some(s) = value.strip_suffix('h') {
        (s, 3600)
    } else {
        (value.strip_suffix('s').unwrap_or(value), 1)
    };
    let seconds = digits
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_mul(multiplier))
        .context("invalid expiry; use 60s, 10m, or 1h")?;
    if !(60..=3600).contains(&seconds) {
        bail!("login link expiry must be between 60s and 1h")
    }
    Ok(seconds)
}
pub async fn web(paths: &Paths, args: &[String]) -> Result<()> {
    let mut seconds = 600;
    let mut as_json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => as_json = true,
            "--expires" => {
                i += 1;
                seconds = duration(
                    args.get(i)
                        .context("--expires needs a duration, for example 10m")?,
                )?;
            }
            "--help" => {
                help();
                return Ok(());
            }
            _ => bail!(
                "unknown web option {}; see ai-agents --help",
                safe(&args[i])
            ),
        }
        i += 1;
    }
    let config = store::read(&paths.config.join("config.json"))
        .context("configure the reporter with ai-agents init first")?;
    let url = config["url"]
        .as_str()
        .context("missing collector URL")?
        .trim_end_matches('/');
    daemon::validate_url(url)?;
    let token =
        fs::read_to_string(paths.config.join("write.token")).context("missing write credential")?;
    let client = daemon::http_client(&config, Duration::from_secs(15))?;
    let mut response = client
        .post(format!("{url}/v1/browser-links"))
        .bearer_auth(token.trim())
        .json(&json!({"schema_version":1,"expires_in":seconds}))
        .send()
        .await
        .context("cannot reach collector")?;
    let status = response.status();
    let retry = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 65536 {
            bail!("collector response exceeds limit")
        };
        bytes.extend(chunk)
    }
    let value: Value =
        serde_json::from_slice(&bytes).context("collector returned an invalid response")?;
    if !status.is_success() {
        bail!(
            "{} (HTTP {}){}",
            safe(
                value["error"]
                    .as_str()
                    .unwrap_or("login link request failed")
            ),
            status.as_u16(),
            if retry.is_empty() {
                String::new()
            } else {
                format!("; retry in {} seconds", safe(&retry))
            }
        )
    }
    let link = value["url"]
        .as_str()
        .context("collector response has no login URL")?;
    let parsed = reqwest::Url::parse(link)?;
    let collector = reqwest::Url::parse(url)?;
    if parsed.origin() != collector.origin()
        || parsed.path() != "/login"
        || parsed.fragment().is_none()
    {
        bail!("collector returned an unexpected login URL")
    }
    if as_json {
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    println!(
        "\n  {}  {}\n",
        color("AGENT//GRID", "1;92"),
        color("web access", "90")
    );
    field(
        "Installation",
        safe(config["installation_id"].as_str().unwrap_or("unknown")),
    );
    let expires = value["expires_at"]
        .as_u64()
        .context("missing link expiry")?;
    let browser_expires = value["browser_expires_at"]
        .as_u64()
        .context("missing browser expiry")?;
    field(
        "Login link",
        format!(
            "single use · expires in {}s",
            expires.saturating_sub(store::now()) / 1000
        ),
    );
    field(
        "Browser access",
        format!(
            "read only · up to {} days",
            browser_expires
                .saturating_sub(store::now())
                .div_ceil(86400000)
        ),
    );
    println!("\n  Open this URL in your browser:\n\n  {}\n", safe(link));
    println!(
        "  {}\n",
        color(
            "The link grants access to this workspace. Keep it private.",
            "90"
        )
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expiry_is_bounded_and_human_readable() {
        for (v, n) in [("10m", 600), ("1h", 3600), ("60s", 60), ("120", 120)] {
            assert_eq!(duration(v).unwrap(), n)
        }
        for v in ["0", "59s", "2h", "-1", "xyz", "18446744073709551615h"] {
            assert!(duration(v).is_err())
        }
    }
    #[test]
    fn server_values_cannot_inject_terminal_controls() {
        assert_eq!(safe("hello\x1b[31m\nworld"), "hello[31mworld");
    }
}
