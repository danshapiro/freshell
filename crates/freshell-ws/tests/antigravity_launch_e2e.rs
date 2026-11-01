//! Antigravity launch e2e (plan Task 3,
//! docs/plans/2026-10-29-google-cli-first-class-support.md): the manifest's
//! launch templates, proven through the REAL create route.
//!
//! The antigravity `CliCommandSpec` is compiled from the real
//! `extensions/antigravity/freshell.json` — the field mapping of
//! `ExtensionRegistry::cli_command_specs()`
//! (`crates/freshell-server/src/extensions.rs:197-223`) — with ONE test-only
//! override: `default_cmd` points at an argv-capturing `#!/bin/sh` shim (the
//! manifest ships `agy`, which no test host has on PATH). The argv rows the
//! real in-process server spawns therefore pin the manifest's launch shape
//! against the PROBED binary's argv contract (round 6: real pinned binaries
//! v1.4.10 AND v1.4.12 probed 2026-11-01 — bare `agy` is the interactive
//! default; `-i`/`--prompt-interactive` take a prompt VALUE and a bare one
//! exits 2; the headless `-p` spellings never appear; the exact adjacent
//! `--conversation <id>` resume pair, never `--continue`), and an
//! unknown-mode create is rejected with the valid-mode list naming
//! `antigravity`.
//!
//! Raw-WS integration against an in-process axum server on an ephemeral
//! loopback port (the shared `common` harness convention; the
//! `auto_resume_e2e.rs` shim model). Kills are limited to the terminals this
//! suite itself creates (`registry.kill` of the created ids) — never broad
//! process patterns.

mod common;

use std::time::Duration;

use common::next_frame_of_type;
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// `#!/bin/sh` argv-capture shim (the `auto_resume_e2e.rs`
/// `write_executable` convention): appends `"$@"` (space-joined) as ONE line
/// per invocation to `capture`, then stays alive (`exec sleep 30`) so the
/// created terminal never dies mid-create — a shim that exits during the
/// create's post-spawn tail races the dead-PTY ownership guard (the
/// crash-once flake lesson documented on `crash_once_claude_spec`).
fn write_executable(path: &std::path::Path, capture: &std::path::Path) {
    let script = format!(
        "#!/bin/sh\necho \"$@\" >> \"{cap}\"\nexec sleep 30\n",
        cap = capture.display(),
    );
    std::fs::write(path, script).expect("write argv-capture shim");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }
}

/// Compile the real antigravity manifest's `cli` block into a
/// `CliCommandSpec` — the `ExtensionRegistry::cli_command_specs()`
/// (`crates/freshell-server/src/extensions.rs:197-223`) field mapping — with
/// ONE test-only override: `default_cmd` points at the argv-capture shim, so
/// the templates this test proves are exactly the manifest's (they flow
/// automatically when the manifest is edited — no hand-mirrored spec to
/// drift).
fn antigravity_capture_spec(shim: &std::path::Path) -> freshell_platform::CliCommandSpec {
    let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/antigravity/freshell.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("missing antigravity manifest at {manifest_path:?}: {e}"));
    let json: serde_json::Value = serde_json::from_str(&raw).expect("manifest must be valid JSON");
    let cli = &json["cli"];
    let str_array = |value: &serde_json::Value| -> Option<Vec<String>> {
        value.as_array().map(|items| {
            items
                .iter()
                .map(|item| {
                    item.as_str()
                        .expect("manifest argv templates hold strings")
                        .to_string()
                })
                .collect()
        })
    };
    freshell_platform::CliCommandSpec {
        name: json["name"].as_str().expect("manifest name").to_string(),
        label: json["label"].as_str().expect("manifest label").to_string(),
        env_var: cli["envVar"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_string),
        default_cmd: shim.to_string_lossy().to_string(),
        base_args: str_array(&cli["args"]).unwrap_or_default(),
        base_env: cli["env"]
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            v.as_str()
                                .expect("manifest env values are strings")
                                .to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        resume_args: str_array(&cli["resumeArgs"]),
        create_session_args: str_array(&cli["createSessionArgs"]),
        model_args: str_array(&cli["modelArgs"]),
        effort_args: str_array(&cli["effortArgs"]),
        sandbox_args: str_array(&cli["sandboxArgs"]),
        permission_mode_args: str_array(&cli["permissionModeArgs"]),
    }
}

/// Send a `terminal.create` for `mode` (optionally with a `sessionRef`) and
/// return the `terminal.created` terminalId.
async fn create_terminal(
    ws: &mut common::TestWs,
    request_id: &str,
    mode: &str,
    session_ref: Option<serde_json::Value>,
) -> String {
    let mut create = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": mode,
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    if let Some(sr) = session_ref {
        create["sessionRef"] = sr;
    }
    ws.send(WsMessage::Text(create.to_string()))
        .await
        .expect("send terminal.create");
    let created = next_frame_of_type(ws, "terminal.created").await;
    assert_eq!(
        created["requestId"], request_id,
        "terminal.created answers its own create: {created}"
    );
    created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string()
}

/// Poll the argv-capture file until `want` rows exist (bounded): the shim
/// writes its line at spawn, which races the `terminal.created` reply by
/// construction, so the rows may trail the frames by a few milliseconds.
async fn wait_capture_rows(capture: &std::path::Path, want: usize) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let rows: Vec<String> = std::fs::read_to_string(capture)
            .map(|s| s.lines().map(str::to_string).collect())
            .unwrap_or_default();
        if rows.len() >= want || tokio::time::Instant::now() >= deadline {
            return rows;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The PROBED-binary argv contract (mirrors
/// `cli_launch_goldens.rs::assert_probed_agy_argv_contract`; receipts in
/// the plan's Provider Contract Record): a pane launch must never carry
/// the prompt-taking `-i`/`--prompt-interactive` (bare -> the real binary
/// exits 2), never the headless `-p`/`--print`/`--prompt`, never
/// `--continue`, and a resume row must carry `--conversation <id>` as an
/// adjacent pair while a fresh row must not resume at all.
fn assert_probed_agy_argv_contract(argv: &[&str], expected_resume_id: Option<&str>) {
    let is_flag = |a: &str| a.starts_with('-') && a.len() > 1;
    let mut saw_resume = false;
    let mut i = 0;
    while i < argv.len() {
        match argv[i] {
            "-i" | "--prompt-interactive" => panic!(
                "prompt-taking interactive flag on a pane launch (the real binary \
                 requires a value; bare exits 2): {argv:?}"
            ),
            "-p" | "--print" | "--prompt" => panic!("headless spelling on a pane launch: {argv:?}"),
            "-c" | "--continue" => panic!("weaker continue mechanism on a pane launch: {argv:?}"),
            "--conversation" => {
                let id = argv
                    .get(i + 1)
                    .unwrap_or_else(|| panic!("--conversation without an adjacent id: {argv:?}"));
                assert!(
                    !is_flag(id),
                    "a flag where the conversation id belongs: {argv:?}"
                );
                assert_eq!(
                    expected_resume_id,
                    Some(*id),
                    "resume argv must carry the exact id adjacently: {argv:?}"
                );
                saw_resume = true;
                i += 2;
                continue;
            }
            "--model" | "--effort" => {
                let value = argv
                    .get(i + 1)
                    .unwrap_or_else(|| panic!("{argv:?}: {} without a value", argv[i]));
                assert!(
                    !is_flag(value),
                    "a flag where a settings value belongs: {argv:?}"
                );
                i += 2;
                continue;
            }
            other => panic!(
                "unmodeled flag or positional residue {other:?} (the misparse shape): {argv:?}"
            ),
        }
    }
    assert_eq!(
        saw_resume,
        expected_resume_id.is_some(),
        "resume happens exactly when a sessionRef was given: {argv:?}"
    );
}

/// The plan's Task-3 argv proof over the real create route: a fresh
/// `mode:"antigravity"` create spawns BARE `agy` (the interactive default
/// on the probed binaries — never a prompt-taking `-i`, never the headless
/// `-p`, never a `--conversation` pair); a provider-matched `sessionRef`
/// resume create spawns the exact adjacent `--conversation conv-9` pair
/// (never `--continue`); and an unknown-mode create (`antigravityy`) is
/// rejected with `Invalid terminal mode` listing `antigravity` as valid.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn antigravity_launch_argv_is_manifest_template_driven() {
    let tag = std::process::id();
    let shim = std::env::temp_dir().join(format!("freshell-antigravity-e2e-shim-{tag}.sh"));
    let capture = std::env::temp_dir().join(format!("freshell-antigravity-e2e-argv-{tag}.txt"));
    let _ = std::fs::remove_file(&capture);
    write_executable(&shim, &capture);

    let (url, registry) =
        common::spawn_server_with_specs(vec![antigravity_capture_spec(&shim)]).await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // Fresh create: mode "antigravity", NO sessionRef — launcher-side
    // preallocation is claude/amplifier-only, so a fresh antigravity pane
    // carries no resume args at all.
    let fresh_tid = create_terminal(&mut ws, "req-antigravity-fresh", "antigravity", None).await;

    // Await and assert the fresh argv row BEFORE issuing the resume create,
    // so no cross-create ordering assumption exists (the sibling
    // auto_resume_e2e.rs bar: "no timing assumption anywhere" — a heavily
    // loaded host can never invert the rows).
    let fresh_rows = wait_capture_rows(&capture, 1).await;
    assert_eq!(fresh_rows.len(), 1, "fresh argv row: {fresh_rows:?}");
    let fresh_argv: Vec<&str> = fresh_rows[0].split_whitespace().collect();
    assert_probed_agy_argv_contract(&fresh_argv, None);
    assert!(
        fresh_argv.is_empty(),
        "an unconfigured fresh launch is BARE agy (interactive by default — \
         probed; a static `-i` would exit 2 on every launch): {fresh_rows:?}"
    );

    // Resume create: provider-matched sessionRef (the frozen client's only
    // identity carrier for terminal-mode panes).
    let resume_tid = create_terminal(
        &mut ws,
        "req-antigravity-resume",
        "antigravity",
        Some(serde_json::json!({ "provider": "antigravity", "sessionId": "conv-9" })),
    )
    .await;

    // The resume row is the NEW row: the fresh row was already asserted, so
    // anything beyond it can only be the resume spawn's argv.
    let resume_rows = wait_capture_rows(&capture, 2).await;
    assert_eq!(
        resume_rows.len(),
        2,
        "exactly one new argv row for the resume create: {resume_rows:?}"
    );
    let resume_argv: Vec<&str> = resume_rows[1].split_whitespace().collect();
    let i = resume_argv
        .iter()
        .position(|a| *a == "--conversation")
        .unwrap_or_else(|| panic!("resume row carries --conversation: {:?}", resume_rows[1]));
    assert_eq!(
        resume_argv[i + 1],
        "conv-9",
        "resume id is the ADJACENT argument: {:?}",
        resume_rows[1]
    );
    assert_probed_agy_argv_contract(&resume_argv, Some("conv-9"));

    // Unknown-mode create: rejected with the valid list naming antigravity.
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-antigravity-unknown",
            "mode": "antigravityy",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send unknown-mode terminal.create");
    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(
        err["code"], "PTY_SPAWN_FAILED",
        "unknown mode rejects: {err}"
    );
    assert_eq!(err["requestId"], "req-antigravity-unknown", "{err}");
    assert_eq!(
        err["message"].as_str().expect("message string"),
        "Invalid terminal mode: 'antigravityy'. Valid: shell, antigravity",
        "exact unknown-mode wording with antigravity in the valid list"
    );

    // The rejected create spawned NOTHING: the capture file still holds
    // exactly the two asserted rows (assert_never_captured spirit).
    let final_rows = wait_capture_rows(&capture, 2).await;
    assert_eq!(
        final_rows.len(),
        2,
        "the rejected unknown-mode create spawns no process: {final_rows:?}"
    );

    // Cleanup: only the terminals this test created (never a broad kill).
    registry.kill(&fresh_tid);
    registry.kill(&resume_tid);
}
