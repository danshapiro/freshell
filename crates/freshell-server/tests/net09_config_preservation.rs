#![cfg(unix)]
//! NET-09: a network mutation must route through the serialized config store and
//! leave every unrelated top-level document key byte-identical, across restart.
//! Harness helpers copied from safe11_term22_shutdown_reaping.rs (attribution).

use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const AUTH_TOKEN: &str = "net09-preservation-token-abcdef012345";

// --- Harness helpers copied from safe11_term22_shutdown_reaping.rs ---

/// Locate the compiled `freshell-server` binary (same discovery order as
/// `diag01_diag03_logging.rs`): explicit override, sibling of this test
/// binary, then a self-sufficient `cargo build --bin freshell-server`.
fn discover_server_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("FRESHELL_SERVER_BIN") {
        return PathBuf::from(explicit);
    }
    let suffix = std::env::consts::EXE_SUFFIX;
    if let Some(found) = find_sibling(suffix) {
        return found;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new(env!("CARGO"))
        .args(["build", "--bin", "freshell-server"])
        .current_dir(&manifest_dir)
        .status()
        .expect("spawn `cargo build --bin freshell-server`");
    assert!(status.success(), "cargo build --bin freshell-server failed");
    find_sibling(suffix).expect("freshell-server binary not found even after building it")
}

fn find_sibling(suffix: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for dir in exe.ancestors().skip(1).take(3) {
        let candidate = dir.join(format!("freshell-server{suffix}"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn allocate_ephemeral_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

async fn wait_for_health(port: u16, child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let url = format!("http://127.0.0.1:{port}/api/health");
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return false; // exited early -- never healthy
        }
        if let Ok(resp) = reqwest::Client::new().get(&url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

// --- Test utilities ---

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

#[tokio::test]
async fn network_mutation_preserves_every_unmanaged_top_level_key() {
    let home = tempfile::tempdir().unwrap();
    // Include codexDisplayIdSecret in serverSecrets so it survives byte-for-byte
    // across restart (load_or_mint_codex_display_id_secret reads it back from disk).
    let seed = serde_json::json!({
        "version": 1,
        "settings": { "network": { "host": "127.0.0.1", "configured": false } },
        "sessionOverrides": { "SENTINEL_SESSION": { "keep": "me" } },
        "terminalOverrides": { "SENTINEL_TERM": { "keep": "me" } },
        "serverSecrets": { "codexDisplayIdSecret": "constant-sentinel-secret-value", "SENTINEL_SECRET": "do-not-touch" },
        // `completedMigrations` is a MANAGED key now: the boot migration
        // (`migrations::run_ai_title_shadow_cleanup`) appends its marker on a
        // first boot. Seed the marker so the migration no-ops and this test
        // keeps asserting the network mutation itself preserves the key
        // byte-for-byte (unknown entries like m-001/m-002 must still survive).
        "completedMigrations": ["m-001", "m-002", "ai-title-shadow-cleanup"],
        "recentDirectories": ["/tmp/a", "/tmp/b"],
        "projectColors": { "/tmp/a": "#123456" },
        "someUnknownFutureKey": { "arbitrary": [1, 2, 3] }
    });
    let cfg_dir = home.path().join(".freshell");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        serde_json::to_vec_pretty(&seed).unwrap(),
    )
    .unwrap();

    let orig: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cfg_dir.join("config.json")).unwrap()).unwrap();
    let watched = [
        "sessionOverrides",
        "terminalOverrides",
        "serverSecrets",
        "completedMigrations",
        "recentDirectories",
        "projectColors",
        "someUnknownFutureKey",
    ];
    let before: std::collections::HashMap<_, _> = watched
        .iter()
        .map(|k| (*k, sha256_hex(&serde_json::to_vec(&orig[*k]).unwrap())))
        .collect();

    let port = allocate_ephemeral_port();
    let bin = discover_server_binary();
    let mut child = Command::new(&bin)
        .env("PORT", port.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .env("FRESHELL_DISABLE_WSL_PORT_FORWARD", "1")
        .spawn()
        .unwrap();
    assert!(wait_for_health(port, &mut child, Duration::from_secs(20)).await);

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{port}/api/network/configure"))
        .header("x-auth-token", AUTH_TOKEN)
        .json(&serde_json::json!({"host":"0.0.0.0","configured":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // SIGTERM the first server: the process is an owned child of this test;
    // the unreaped PID cannot be recycled until we wait() for it.
    let pid = child.id();
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    let status = child.wait().unwrap();
    assert!(status.success(), "server should exit gracefully on SIGTERM");

    let after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cfg_dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(after["settings"]["network"]["host"], "0.0.0.0");
    assert_eq!(after["settings"]["network"]["configured"], true);
    for k in watched {
        let now = sha256_hex(&serde_json::to_vec(&after[k]).unwrap());
        assert_eq!(before[k], now, "top-level key `{k}` was not byte-preserved");
    }

    // === RESTART LEG ===
    // Respawn the server with the same env (same home, same token) but a fresh ephemeral port.
    // This exercises the boot-load path: the server must read config.json, parse the mutated
    // state, and preserve all unmanaged top-level keys when it writes the config back on shutdown.
    let port2 = allocate_ephemeral_port();
    let mut child2 = Command::new(&bin)
        .env("PORT", port2.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .env("FRESHELL_DISABLE_WSL_PORT_FORWARD", "1")
        .spawn()
        .unwrap();
    assert!(
        wait_for_health(port2, &mut child2, Duration::from_secs(20)).await,
        "respawned server failed to become healthy"
    );

    // SIGTERM the second server and wait for graceful exit.
    let pid2 = child2.id();
    unsafe {
        libc::kill(pid2 as i32, libc::SIGTERM);
    }
    let status2 = child2.wait().unwrap();
    assert!(
        status2.success(),
        "respawned server should exit gracefully on SIGTERM"
    );

    // Re-read config and verify the mutation persisted and all watched keys are unchanged.
    let after_restart: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cfg_dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(after_restart["settings"]["network"]["host"], "0.0.0.0");
    assert_eq!(after_restart["settings"]["network"]["configured"], true);
    for k in watched {
        let now = sha256_hex(&serde_json::to_vec(&after_restart[k]).unwrap());
        assert_eq!(
            before[k], now,
            "top-level key `{k}` was not byte-preserved across restart"
        );
    }
}
