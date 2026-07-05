//! **T1 fidelity test** — the acceptance gate for Phase 3.3a.
//!
//! Spawns a REAL pseudo-terminal (portable-pty) with the same `SpawnSpec` the goldens
//! were captured with (system shell -> `/bin/bash -l` on this host, 120x30), drives the
//! SAME setup + sentinel-wrapped payload input each committed scenario used, feeds PTY
//! output through the ReplayRing -> `terminal.output` framing, reassembles by `seqStart`,
//! extracts the between-sentinels bytes, and asserts they are **BYTE-IDENTICAL** and
//! **sha256-equal** to `port/oracle/baselines/pty/<scenario>.golden` for ALL FOUR
//! scenarios.
//!
//! A mismatch is a REAL fidelity failure: this test prints a hex diff and fails; it
//! never retakes or alters the goldens. The reassembled between-sentinels bytes are
//! deterministic even though raw PTY read-chunk boundaries are not — that is exactly
//! the property the oracle proved and this crate must preserve.
//!
//! Drive mirrors `port/oracle/harness/pty-capture.ts` + `port/oracle/fixtures/pty-scenarios.ts`.
//!
//! SAFETY: every PTY spawned here is a local test child, SIGKILLed + reaped before the
//! next scenario (and on drop). This test never touches the user's live server (:3001).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use freshell_platform::detect::{host_os_live, is_wsl_env_live};
use freshell_platform::{build_spawn_spec, RealEnv, RealFileProbe, ShellType};
use freshell_terminal::{build_child_env_from_process, PtyTerminal};
use sha2::{Digest, Sha256};

// --- Sentinels + setup line (verbatim from pty-capture.ts DEFAULT_*) -----------

const SENTINEL_START: &str = "<<<FRESHELL_OSTART>>>";
const SENTINEL_END: &str = "<<<FRESHELL_OEND>>>";
const SENTINEL_SETUP_DONE: &str = "<<<FRESHELL_SETUP_DONE>>>";

const COLS: u16 = 120;
const ROWS: u16 = 30;
const WAIT_TIMEOUT: Duration = Duration::from_secs(20);

/// `DEFAULT_SETUP_TEMPLATE` (`pty-capture.ts:65-74`) with `{setupDone}` substituted:
/// neutralise line-editing + tty echo, empty the prompts, then print the setupDone
/// sentinel so we can prove echo is off before sending any payload byte.
fn setup_line() -> String {
    [
        "set +o emacs 2>/dev/null".to_string(),
        "set +o vi 2>/dev/null".to_string(),
        "stty -echo 2>/dev/null".to_string(),
        "PS1=''".to_string(),
        "PS2=''".to_string(),
        "PROMPT_COMMAND=''".to_string(),
        "unset PROMPT_COMMAND 2>/dev/null".to_string(),
        format!("printf '{SENTINEL_SETUP_DONE}\\n'"),
    ]
    .join("; ")
}

/// `printfLine` (`pty-capture.ts:129-133`): `printf '<marker>\n'` + submitting newline.
/// The `\n` before the closing quote is the two literal chars backslash+n (printf's
/// escape); the trailing newline submits the line.
fn printf_line(marker: &str) -> String {
    format!("printf '{marker}\\n'\n")
}

// --- Scenarios (verbatim from pty-scenarios.ts PTY_SCENARIOS) -------------------

struct Scenario {
    name: &'static str,
    input_lines: Vec<String>,
}

fn scenarios() -> Vec<Scenario> {
    vec![
        Scenario {
            name: "echo-hello",
            input_lines: vec![r"printf 'hello\n'".to_string()],
        },
        Scenario {
            name: "seq-3",
            input_lines: vec!["seq 3".to_string()],
        },
        Scenario {
            name: "fixed-width-fill",
            input_lines: vec![format!("printf '{}\\n'", "A".repeat(40))],
        },
        Scenario {
            name: "multi-line",
            input_lines: vec![
                r"printf 'line-1\n'".to_string(),
                r"printf 'line-2\n'".to_string(),
            ],
        },
    ]
}

// --- Golden helpers ------------------------------------------------------------

fn baseline_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = <worktree>/crates/freshell-terminal
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../port/oracle/baselines/pty")
}

fn read_golden(name: &str) -> Vec<u8> {
    let path = baseline_dir().join(format!("{name}.golden"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read golden {}: {e}", path.display()))
}

/// The committed `sha256` from `<name>.meta.json` — an independent check that our
/// extracted bytes match the sha the ORIGINAL recorded, not just the golden file.
fn read_golden_meta_sha256(name: &str) -> String {
    let path = baseline_dir().join(format!("{name}.meta.json"));
    let bytes =
        std::fs::read(&path).unwrap_or_else(|e| panic!("read meta {}: {e}", path.display()));
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("parse meta {name}: {e}"));
    value
        .get("sha256")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("meta {name} missing sha256"))
        .to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn spaced_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Port of `hexDiff` (`pty-capture.ts:254-279`): aligned hex around the first byte
/// that differs, plus the textual rendering — so a residual divergence is legible.
fn hex_diff(a: &[u8], b: &[u8]) -> String {
    if a == b {
        return String::new();
    }
    let max = a.len().max(b.len());
    let first = (0..max).find(|&i| a.get(i) != b.get(i)).unwrap_or(0);
    let from = first.saturating_sub(16);
    let to = (first + 16).min(max);
    let slice = |buf: &[u8]| spaced_hex(&buf[from.min(buf.len())..to.min(buf.len())]);
    format!(
        "lengths: extracted={} golden={}; first byte diff at offset {first}\n\
         extracted[{from}..{to}]: {}\n\
         golden   [{from}..{to}]: {}\n\
         extracted(txt): {:?}\n\
         golden   (txt): {:?}",
        a.len(),
        b.len(),
        slice(a),
        slice(b),
        String::from_utf8_lossy(&a[from.min(a.len())..to.min(a.len())]),
        String::from_utf8_lossy(&b[from.min(b.len())..to.min(b.len())]),
    )
}

// --- Drive ---------------------------------------------------------------------

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// True once `marker` appears in its terminal-OUTPUT form (CR-LF or LF), matching
/// `outputHasMarker` (`pty-capture.ts:180-182`). The echoed *command* form
/// (`printf '<marker>\n'`) never matches `marker\r\n`, so this cannot collide.
fn output_has_marker(stream: &str, marker: &str) -> bool {
    stream.contains(&format!("{marker}\r\n")) || stream.contains(&format!("{marker}\n"))
}

/// Poll the reassembled stream until `marker` lands, or fail with a hex tail
/// (`waitForOutputMarker`, `pty-capture.ts:188-207`).
fn wait_for_marker(pty: &PtyTerminal, marker: &str, label: &str) -> String {
    let start = Instant::now();
    let mut stream = String::new();
    while start.elapsed() < WAIT_TIMEOUT {
        stream = pty.reassemble();
        if output_has_marker(&stream, marker) {
            return stream;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let tail = stream.as_bytes();
    let tail = &tail[tail.len().saturating_sub(96)..];
    panic!(
        "timed out after {:?} waiting for {label} marker {marker:?}; \
         reassembled {} chars; tail(hex)={}",
        WAIT_TIMEOUT,
        stream.len(),
        spaced_hex(tail),
    );
}

/// `extractGolden` (`pty-capture.ts:218-238`): the bytes strictly between the START
/// sentinel's output line and the END marker.
fn extract_golden(stream: &str, start: &str, end: &str) -> String {
    let anchor = |m: &str| -> Option<(usize, usize)> {
        let crlf = format!("{m}\r\n");
        if let Some(i) = stream.find(&crlf) {
            return Some((i, crlf.len()));
        }
        let lf = format!("{m}\n");
        stream.find(&lf).map(|i| (i, lf.len()))
    };
    let (si, slen) = anchor(start).expect("start sentinel present in output");
    let golden_start = si + slen;
    let rest = &stream[golden_start..];
    let end_idx = match rest.find(&format!("{end}\r\n")) {
        Some(i) => golden_start + i,
        None => golden_start + rest.find(&format!("{end}\n")).expect("end sentinel after start"),
    };
    stream[golden_start..end_idx].to_string()
}

/// Run one scenario end-to-end and return the extracted between-sentinels bytes.
/// The spawned PTY is reaped before return (kill + drop-join).
fn capture_scenario(scenario: &Scenario) -> Vec<u8> {
    let host_os = host_os_live();
    let is_wsl = is_wsl_env_live();
    let terminal_id = format!("t1-{}-{}", scenario.name, unique_suffix());
    let stream_id = format!("stream-{}", unique_suffix());

    // Same SpawnSpec the goldens used: system shell -> /bin/bash -l on this host.
    let mut overrides = BTreeMap::new();
    // buildTerminalBaseEnv carries FRESHELL_TERMINAL_ID (URL/TOKEN are server-layer,
    // not part of the PTY byte stream). Present here for env faithfulness.
    overrides.insert("FRESHELL_TERMINAL_ID".to_string(), terminal_id.clone());
    let spec = build_spawn_spec(
        ShellType::System,
        host_os,
        is_wsl,
        None,
        &RealEnv,
        &RealFileProbe,
        &overrides,
        Some(COLS),
        Some(ROWS),
    );
    assert_eq!(
        (spec.program.as_str(), spec.args.as_slice()),
        ("/bin/bash", ["-l".to_string()].as_slice()),
        "this host must resolve system shell to /bin/bash -l (matches the goldens' resolvedShellArgv)",
    );

    // Isolate HOME to a fresh empty dir — mirrors the golden-generation server's
    // isolated HOME and removes any chance a personal profile injects bytes. HOME is
    // inherited (not in STRIP_ENV), so we override it in the assembled child env. It
    // does not affect the between-sentinels payload (printf/seq are HOME-independent).
    let home = std::env::temp_dir().join(format!("freshell-t1-home-{}", unique_suffix()));
    std::fs::create_dir_all(&home).expect("create isolated HOME");

    let mut child_env = build_child_env_from_process(&spec);
    child_env.insert("HOME".to_string(), home.to_string_lossy().into_owned());

    let extracted = {
        let mut pty = PtyTerminal::spawn(&spec, &child_env, terminal_id, stream_id, None)
            .expect("spawn /bin/bash -l pty");

        // 1) SETUP (excluded from golden): neutralise echo/line-editing/prompt, then
        //    prove it took effect via the setupDone sentinel in OUTPUT.
        pty.write_input(format!("{}\n", setup_line()).as_bytes())
            .expect("write setup line");
        wait_for_marker(&pty, SENTINEL_SETUP_DONE, "setup-done");

        // 2) START sentinel, payload lines, END sentinel — all echo-free now.
        pty.write_input(printf_line(SENTINEL_START).as_bytes())
            .expect("write start sentinel");
        for line in &scenario.input_lines {
            pty.write_input(format!("{line}\n").as_bytes())
                .expect("write payload line");
        }
        pty.write_input(printf_line(SENTINEL_END).as_bytes())
            .expect("write end sentinel");

        // 3) wait for END, reassemble (seq-ordered), extract between the sentinels.
        let stream = wait_for_marker(&pty, SENTINEL_END, "end-sentinel");
        let golden = extract_golden(&stream, SENTINEL_START, SENTINEL_END);

        pty.kill(); // explicit reap; Drop also kills + joins the reader thread.
        golden.into_bytes()
    };

    let _ = std::fs::remove_dir_all(&home);
    extracted
}

// --- The acceptance test -------------------------------------------------------

#[test]
fn t1_reproduces_all_four_pty_goldens_byte_for_byte() {
    let mut failures: Vec<String> = Vec::new();

    println!("\n=== T1 crate-level golden reproduction (portable-pty /bin/bash -l, {COLS}x{ROWS}) ===");
    for scenario in scenarios() {
        let extracted = capture_scenario(&scenario);
        let golden = read_golden(scenario.name);
        let meta_sha = read_golden_meta_sha256(scenario.name);

        let extracted_sha = sha256_hex(&extracted);
        let golden_sha = sha256_hex(&golden);

        let byte_identical = extracted == golden;
        let sha_matches = extracted_sha == golden_sha && extracted_sha == meta_sha;

        if byte_identical && sha_matches {
            println!(
                "  [PASS] {:<16} {} bytes  byte-identical=YES  sha256={} (== golden == meta)",
                scenario.name,
                extracted.len(),
                extracted_sha,
            );
        } else {
            println!(
                "  [FAIL] {:<16} byte-identical={}  sha256(extracted)={}  sha256(golden)={}  sha256(meta)={}",
                scenario.name, byte_identical, extracted_sha, golden_sha, meta_sha,
            );
            failures.push(format!(
                "scenario {}:\n{}",
                scenario.name,
                hex_diff(&extracted, &golden)
            ));
        }
    }
    println!("=== end T1 golden reproduction ===\n");

    assert!(
        failures.is_empty(),
        "T1 fidelity failure (real divergence — goldens NOT altered):\n{}",
        failures.join("\n\n"),
    );
}
