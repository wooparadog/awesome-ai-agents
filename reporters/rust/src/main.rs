mod daemon;
mod hooks;
mod store;
mod usage;
use anyhow::{Result, bail};
use serde_json::json;
use std::{env, fs};
use store::Paths;
fn main() {
    let args: Vec<_> = env::args().collect();
    // Reporting is best effort and must never influence agent execution.
    if args.get(1).is_some_and(|s| s == "hook") {
        if args.len() == 4 {
            let _ = Paths::environment().and_then(|p| hooks::report(&p, &args[2], &args[3]));
        }
        return;
    }
    if let Err(e) = run(&args) {
        eprintln!("ai-agents: {e:#}");
        std::process::exit(1)
    }
}
fn run(args: &[String]) -> Result<()> {
    let paths = Paths::environment()?;
    match args.get(1).map(String::as_str).unwrap_or("help") {
        "daemon" => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()?
            .block_on(daemon::run(paths)),
        "init" if args.len() == 5 => {
            daemon::validate_url(&args[2])?;
            let token = fs::read_to_string(&args[4])?;
            let token = token.trim();
            let parts: Vec<_> = token.split('.').collect();
            if parts.len() != 2
                || parts[0].is_empty()
                || !(40..=100).contains(&parts[1].len())
                || !parts.iter().all(|s| {
                    s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                })
            {
                bail!("invalid token")
            }
            paths.prepare()?;
            store::atomic(&paths.config.join("write.token"), token.as_bytes())?;
            store::write(
                &paths.config.join("config.json"),
                &json!({"url":args[2].trim_end_matches('/'),"installation_id":args[3]}),
            )?;
            Ok(())
        }
        "status" => {
            let mut health =
                store::read(&paths.state.join("daemon-status.json")).unwrap_or(json!({}));
            health["running"] = json!(
                hooks::process(health["pid"].as_u64().unwrap_or(0))
                    .is_some_and(|p| Some(p.0.as_str()) == health["fingerprint"].as_str())
            );
            println!(
                "{}",
                json!({"daemon":health,"queued":store::files(&paths.state.join("outbox"))?.len(),"pending_hooks":store::files(&paths.state.join("inbox"))?.len(),"quarantined":store::files(&paths.state.join("quarantine"))?.len()})
            );
            Ok(())
        }
        "reconcile" | "flush" => {
            let socket = std::os::unix::net::UnixDatagram::unbound()?;
            socket.set_nonblocking(true)?;
            socket.send_to(b"reconcile", paths.socket())?;
            Ok(())
        }
        "help" | "--help" => {
            println!(
                "ai-agents daemon | hook AGENT EVENT | status | reconcile | flush | init URL INSTALLATION_ID TOKEN_FILE"
            );
            Ok(())
        }
        _ => bail!("unknown command; see ai-agents --help"),
    }
}
