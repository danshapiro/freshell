//! Headless integration smoke for the app-bound server machinery — drives the REAL
//! `freshell-server` binary through the same spawn → `/api/health` gate → reap path
//! the Tauri `setup` hook uses, with **no display and no webview** required. This is
//! the deterministic, this-host proof that the shell's non-GUI core works end-to-end
//! (the GUI launch itself is display-gated, covered separately by the xvfb smoke).
//!
//! The server binary is discovered via `FRESHELL_SERVER_BIN`, else as a sibling of
//! the test executable (`target/<profile>/freshell-server`, where a workspace
//! `cargo test` also builds/leaves the server bin). If it cannot be found, the test
//! SOFT-SKIPS with a printed notice rather than failing — so `cargo test -p
//! freshell-tauri` is green whether or not the sibling binary happens to be built,
//! while a workspace `cargo test` (which builds it) exercises the real path.

use std::path::PathBuf;
use std::time::Duration;

use freshell_tauri::health::{self, HealthProbe};
use freshell_tauri::server::{self, ReapOutcome, SpawnConfig};

/// Find the `freshell-server` binary to drive, or `None` to soft-skip.
fn discover_server_binary() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("FRESHELL_SERVER_BIN") {
        let p = PathBuf::from(explicit);
        return p.exists().then_some(p);
    }
    // The test exe lives in target/<profile>/deps/<name>; the server bin is two
    // levels up in target/<profile>/. Probe a few ancestor dirs for robustness.
    let exe = std::env::current_exe().ok()?;
    let suffix = std::env::consts::EXE_SUFFIX;
    for dir in exe.ancestors().skip(1).take(3) {
        let candidate = server::sibling_server_binary(dir, suffix);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[test]
fn app_bound_spawn_health_reap_end_to_end() {
    let Some(server_binary) = discover_server_binary() else {
        eprintln!(
            "SKIP app_bound_spawn_health_reap_end_to_end: freshell-server binary not found \
             (set FRESHELL_SERVER_BIN or run a workspace `cargo build`/`cargo test`)."
        );
        return;
    };
    eprintln!("using server binary: {}", server_binary.display());

    // Isolated HOME so the smoke never reads/writes the real ~/.freshell.
    let home = std::env::temp_dir().join(format!("freshell-tauri-smoke-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);

    let port = server::allocate_ephemeral_port().expect("allocate ephemeral port");
    let token = server::generate_auth_token();
    let cfg = SpawnConfig {
        server_binary,
        port,
        auth_token: token,
        bind_host: "127.0.0.1".to_string(),
        home: Some(home.clone()),
        client_dir: None,
        owner_tag: format!("freshell-tauri-smoke-{}", std::process::id()),
    };

    let plan = server::build_spawn_plan(&cfg);
    // Sanity: the plan is the app-bound Rust contract (no bundled-Node vars).
    assert_eq!(plan.env_get("PORT"), Some(port.to_string().as_str()));
    assert_eq!(plan.env_get("FRESHELL_BIND_HOST"), Some("127.0.0.1"));
    assert_eq!(plan.env_get("NODE_PATH"), None);

    let mut child = server::spawn_server(&plan).expect("spawn freshell-server");

    // Health-gate exactly like the shell (fail-fast on child exit).
    let health = health::wait_for_health("127.0.0.1", port, Duration::from_secs(20), || {
        matches!(child.try_wait(), Ok(Some(_)))
    });
    assert!(
        health.is_ok(),
        "server should become healthy within 20s: {health:?}"
    );

    // The port is live now (a direct probe agrees).
    assert_eq!(health::http_probe("127.0.0.1", port), HealthProbe::Ready);

    // Reap: a live long-running server dies on SIGTERM within the grace window.
    let outcome = server::reap_child(&mut child, Duration::from_secs(5), Duration::from_millis(50));
    assert_eq!(
        outcome,
        ReapOutcome::Graceful,
        "app-bound server must reap gracefully (no orphan, no SIGKILL escalation)"
    );

    // After reap the port is free again — no orphaned server holding it.
    assert_eq!(
        health::http_probe("127.0.0.1", port),
        HealthProbe::NotReady,
        "port must be released after reap (0 orphans)"
    );

    let _ = std::fs::remove_dir_all(&home);
}
