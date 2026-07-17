//! DEV-0005 condition 5: host-gated LIVE integration test — spawn a real
//! `cmd.exe` through WSL interop via portable-pty with an inherited `/mnt`
//! mount cwd (the `wsl_windows_shell_inherit_cwd` PORT FIX path) and assert
//! the shell actually lands in the requested Windows directory, NOT in
//! `C:\Windows` (the original's stranding, `port/oracle/DEVIATIONS.md`
//! DEV-0005). Also exercises the DEV-0005 condition-4 TOCTOU guard: a cwd
//! that vanished degrades to a cwd-less spawn instead of a raw spawn error.
//!
//! `#[ignore]`d by default: requires a WSL2 host with Windows interop and a
//! writable `/mnt/c/Users/Public`. Run explicitly:
//!   cargo test -p freshell-terminal --test wsl_interop_live -- --ignored

use std::io::Read;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn wsl_interop_available() -> bool {
    std::path::Path::new("/mnt/c/Windows/System32/cmd.exe").exists()
        && std::path::Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()
}

/// Spawn `program` with optional cwd over a real PTY; read output until
/// `needle` appears or the deadline passes. Returns the captured output.
fn drive_pty(program: &str, args: &[&str], cwd: Option<&str>, needle: &str, secs: u64) -> String {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.cwd(c);
    }
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut writer = pair.master.take_writer().expect("writer");
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut out = String::new();
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(chunk) => {
                let text = String::from_utf8_lossy(&chunk).into_owned();
                // A real terminal answers DSR (ESC[6n) with a cursor-position report;
                // cmd.exe-over-interop stalls until it gets one (xterm.js does this
                // for the live client — mirror it here).
                if text.contains("\u{1b}[6n") {
                    use std::io::Write;
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
                out.push_str(&text);
                if out.contains(needle) {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break,
        }
    }
    let _ = child.kill();
    out
}

#[test]
#[ignore = "live WSL interop; run with -- --ignored on a WSL2 host"]
fn live_cmd_inherits_mnt_mount_cwd_and_lands_in_workspace() {
    assert!(wsl_interop_available(), "requires WSL2 + Windows interop");
    let ws = format!(
        "/mnt/c/Users/Public/freshell-dev0005-live-{}",
        std::process::id()
    );
    std::fs::create_dir_all(&ws).expect("mkdir workspace");
    // The PORT-FIX spec shape: cmd.exe, bare /K, inherited /mnt cwd. Wait for the
    // PROMPT containing the workspace dir itself (a bare ">" appears in banner
    // fragments long before the prompt paints; interop cold start can be slow).
    let win_tail = ws.trim_start_matches("/mnt/c/").replace('/', "\\");
    let out = drive_pty(
        "/mnt/c/Windows/System32/cmd.exe",
        &["/K"],
        Some(&ws),
        &win_tail,
        90,
    );
    assert!(
        out.to_lowercase().contains(&win_tail.to_lowercase()),
        "prompt must show the workspace dir (C:\\{win_tail}); got: {out:?}"
    );
    assert!(
        !out.contains("UNC paths are not supported"),
        "must not strand via UNC fallback; got: {out:?}"
    );
    assert!(
        !out.contains("C:\\Windows>"),
        "must not strand in C:\\Windows; got: {out:?}"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
#[ignore = "live WSL interop; run with -- --ignored on a WSL2 host"]
fn live_toctou_vanished_cwd_degrades_instead_of_erroring() {
    assert!(wsl_interop_available(), "requires WSL2 + Windows interop");
    // Exercise the PtyTerminal-level guard end-to-end via the public API.
    use freshell_platform::spawn::SpawnSpec;
    use freshell_terminal::PtyTerminal;
    let gone = format!(
        "/mnt/c/Users/Public/freshell-dev0005-gone-{}",
        std::process::id()
    );
    // Deliberately DO NOT create `gone` — simulates the mount/dir vanishing
    // between the FileProbe gate and the spawn (TOCTOU).
    let spec = SpawnSpec {
        program: "/bin/echo".to_string(),
        args: vec!["dev0005-toctou-ok".to_string()],
        env_overrides: std::collections::BTreeMap::new(),
        cwd: Some(gone),
        cols: 80,
        rows: 24,
    };
    let env: std::collections::BTreeMap<String, String> =
        [("PATH".to_string(), "/usr/bin:/bin".to_string())].into();
    let term = PtyTerminal::spawn(&spec, &env, "t-dev0005", "s-dev0005", None);
    let mut term = term.expect("TOCTOU guard must degrade to a cwd-less spawn, not error");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = false;
    while Instant::now() < deadline {
        if term.reassemble().contains("dev0005-toctou-ok") {
            seen = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    term.kill();
    assert!(seen, "degraded spawn must still run the program");
}
