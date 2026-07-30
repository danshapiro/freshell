//! Launcher-assigned amplifier session identity: pre-create ("stub") session
//! dirs on disk so the broker can spawn `amplifier resume <id>` with an
//! identity it minted itself — no post-spawn correlation.
//!
//! Unlike [`crate::amplifier`] (read-only indexing; "never mutates provider
//! data"), this module deliberately WRITES into the amplifier home. The
//! on-disk layout and the cwd→slug algorithm are EXTERNAL contracts owned by
//! the amplifier CLI (amplifier_app_cli `project_utils.py:22-30`); they are
//! pinned by `test/integration/real/amplifier-stub-adoption-contract.test.ts`
//! and re-checked at broker start by `verify_amplifier_layout_contract`.

use std::path::{Path, PathBuf};

/// amplifier's cwd→project-slug algorithm (amplifier_app_cli
/// `project_utils.py:22-30`), byte-exact:
/// `str(Path.cwd().resolve()).replace("/", "-").replace("\\", "-").replace(":", "")`,
/// then prefix `-` unless it already starts with one. Dots/underscores
/// preserved. Input must already be RESOLVED — callers use [`canonical_cwd`],
/// mirroring Python's `Path.cwd().resolve()` (symlinks resolved).
/// A slug mismatch fails SILENTLY in production (our stub dir and
/// amplifier's own dir diverge), which is why the exact-match contract test
/// (`amplifier-stub-adoption-contract.test.ts`) and the boot canary exist.
pub fn cwd_slug(resolved_cwd: &str) -> String {
    // Deliberately three consecutive replaces: a 1:1 visual mirror of the
    // Python contract line above, so a byte-match audit against
    // `project_utils.py` is a straight read (clippy would collapse the
    // first two into `replace(['/', '\\'], "-")`).
    #[allow(clippy::collapsible_str_replace)]
    let slug = resolved_cwd
        .replace('/', "-")
        .replace('\\', "-")
        .replace(':', "");
    if slug.starts_with('-') {
        slug
    } else {
        format!("-{slug}")
    }
}

/// `Path.cwd().resolve()` equivalent for the slug contract: canonicalize,
/// falling back to the raw path when canonicalization fails (dir vanished
/// between validation and spawn — the spawn itself surfaces that error).
pub fn canonical_cwd(cwd: &str) -> PathBuf {
    std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd))
}

/// The amplifier home ROOT (the dir containing `projects/`):
/// `$FRESHELL_AMPLIFIER_HOME` (freshell-specific test/dev override, used
/// as-is) if set and non-empty, else `$HOME/.amplifier` (real `HOME` only —
/// deliberately NOT `FRESHELL_HOME`). `None` when neither resolves (callers
/// surface a create error).
///
/// VALIDATED divergence — do NOT "fix" this to read `AMPLIFIER_HOME`: the
/// real CLI hardcodes `Path.home()/.amplifier` for session storage
/// (`session_store.py:96-98`) and honors `AMPLIFIER_HOME` ONLY for
/// bundle/module caches + `registry.json`. A user setting `AMPLIFIER_HOME`
/// moves caches, NOT sessions — consulting it here would place stubs where
/// the CLI never looks (silent identity divergence).
///
/// ONE broker-side resolution: [`crate::amplifier::amplifier_home`] (session
/// index + activity events-path resolver) is retargeted in this same task to
/// the identical `FRESHELL_AMPLIFIER_HOME`-else-`<home>/.amplifier` rule, so
/// the resolver that attaches the events lane at create time always looks in
/// the SAME home this module writes stubs into (pinned by the env test).
pub fn resolve_amplifier_home() -> Option<PathBuf> {
    match std::env::var("FRESHELL_AMPLIFIER_HOME") {
        Ok(v) if !v.is_empty() => Some(PathBuf::from(v)),
        _ => std::env::var("HOME")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|h| PathBuf::from(h).join(".amplifier")),
    }
}

/// The outcome of [`ensure_session`]: where the session dir is, whether
/// THIS call created it (`created` gates the exit-hook GC — the broker only
/// ever deletes litter it wrote itself), and — for FOUND sessions — slug
/// provenance (validated fix F4/V6): whether the dir lives under a project
/// slug DIFFERENT from slug(canonical cwd), plus that session's own
/// metadata `working_dir`. On a divergent find the caller MUST override the
/// spawn cwd with `working_dir_of_existing` (if it exists and is a dir) or
/// reject the create — `amplifier resume` only searches the spawn cwd's
/// slug, so spawning at the requested cwd would silently find nothing.
#[derive(Debug, Clone)]
pub struct EnsuredSession {
    pub session_dir: PathBuf,
    pub created: bool,
    pub found_under_divergent_slug: bool,
    pub working_dir_of_existing: Option<String>,
}

/// Make `amplifier resume <session_id>` guaranteed-resumable from `cwd`
/// BEFORE spawn. If the session dir already exists under ANY project slug
/// (a real session, or a stub from a previous run), it is found and left
/// untouched — with slug provenance reported (see [`EnsuredSession`]).
/// Otherwise a stub is written under the slug of the CANONICAL cwd
/// (HARD INVARIANT: amplifier only searches the current cwd's slug — the
/// caller must spawn the PTY with this same cwd).
///
/// Stub shape (validated against the real CLI; see the Tier-1 contract
/// test): `metadata.json` with `session_id`, `created` (ISO-8601 UTC),
/// `working_dir` (canonical cwd), custom `freshell_terminal_id` (best-effort
/// durable-linkage bonus — validation observed a real turn's save REWRITE
/// metadata.json and add `*.backup` files, so the field may not survive use;
/// Freshell's own registry stays primary and nothing keys off it), NO `bundle`; plus empty `transcript.jsonl` and empty
/// `events.jsonl` (the latter so the activity hub's create-time resolver
/// attach finds a file — see the module design note).
pub fn ensure_session(
    amplifier_home: &Path,
    session_id: &str,
    cwd: &str,
    terminal_id: &str,
) -> std::io::Result<EnsuredSession> {
    // Path-safety gate (defense in depth): the id is joined into
    // filesystem paths (`projects/<slug>/sessions/<session_id>`) that this
    // function creates and writes, and that the exit-hook GC later
    // `remove_dir_all`s. Reject anything that is not a plain single path
    // segment BEFORE touching disk — an id containing `/`, `\`, or a bare
    // `.`/`..` would escape the amplifier home (client-supplied via WS
    // sessionRef, the REST body, or poisoned persisted state). Enforcing
    // it HERE covers every caller and the GC's delete path (the GC only
    // ever deletes dirs this function returned with `created: true`).
    if session_id.is_empty()
        || session_id == "."
        || session_id == ".."
        || session_id.contains(['/', '\\', '\0'])
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("amplifier session id {session_id:?} is not a valid single path segment"),
        ));
    }

    let resolved = canonical_cwd(cwd);
    let expected_slug = cwd_slug(&resolved.to_string_lossy());
    let projects = amplifier_home.join("projects");
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("sessions").join(session_id);
            if candidate.is_dir() {
                let found_slug = entry.file_name().to_string_lossy().to_string();
                let divergent = found_slug != expected_slug;
                // On a divergent find, surface the session's own recorded
                // working_dir so the caller can spawn there (F4).
                let working_dir_of_existing = if divergent {
                    std::fs::read_to_string(candidate.join("metadata.json"))
                        .ok()
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                        .and_then(|meta| {
                            meta.get("working_dir")
                                .and_then(|v| v.as_str())
                                .map(str::to_string)
                        })
                } else {
                    None
                };
                // A dir at this exact leaf path with no parseable
                // metadata.json is rare and worth a loud signal (unlike the
                // ordinary re-stub path, which is INFO-logged elsewhere):
                // it's the wedged-id shape a rollback bug (or an external
                // process racing this one) would produce -- this function
                // silently ADOPTS it as "found" either way, so this is the
                // only place that surfaces the anomaly.
                if std::fs::read_to_string(candidate.join("metadata.json"))
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .is_none()
                {
                    tracing::warn!(
                        session_id = %session_id,
                        session_dir = %candidate.display(),
                        "amplifier_stub: adopting an existing session dir with missing or unparseable metadata.json"
                    );
                }
                return Ok(EnsuredSession {
                    session_dir: candidate,
                    created: false,
                    found_under_divergent_slug: divergent,
                    working_dir_of_existing,
                });
            }
        }
    }

    let dir = projects
        .join(expected_slug)
        .join("sessions")
        .join(session_id);
    std::fs::create_dir_all(&dir)?;
    let metadata = serde_json::json!({
        "session_id": session_id,
        "created": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "working_dir": resolved.to_string_lossy(),
        "freshell_terminal_id": terminal_id,
    });
    // The three stub-file writes below can fail partway through (ENOSPC,
    // permissions, ...) after create_dir_all already succeeded. On that
    // path, best-effort roll back the directory rather than leaving a
    // metadata-less dir behind: such a dir has no parseable metadata.json,
    // so `stub_is_unused` conservatively KEEPS it forever (never GC-able),
    // and a later `ensure_session` call for the same id would silently
    // ADOPT it via the bare `candidate.is_dir()` check above, treating a
    // half-written stub as a legitimate find. Council-scoped: ONE
    // best-effort `remove_dir_all` — no atomic-write/rollback scaffolding.
    // The rollback's own error is ignored; the original write error wins.
    let write_result: std::io::Result<()> = (|| {
        std::fs::write(
            dir.join("metadata.json"),
            serde_json::to_string_pretty(&metadata)?,
        )?;
        std::fs::write(dir.join("transcript.jsonl"), "")?;
        std::fs::write(dir.join("events.jsonl"), "")?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(EnsuredSession {
        session_dir: dir,
        created: true,
        found_under_divergent_slug: false,
        working_dir_of_existing: None,
    })
}

/// The verified-unambiguous "never used" signature (validated fix F3/V4):
/// `metadata.json` lacks `turn_count` AND `transcript.jsonl` is empty or
/// absent AND `events.jsonl` (if present) contains NO `prompt:submit`
/// event. A lifecycle-only `events.jsonl` of any size is tolerated
/// (zero-turn resumes leave metadata byte-identical but may write a small
/// events file). The `prompt:submit` clause is a data-loss guard: the CLI
/// handles only SIGINT, a PTY close is SIGHUP, and a kill mid-FIRST-turn
/// persists nothing to metadata/transcript — but the user's typed prompt is
/// already in events.jsonl; deleting the dir would destroy it. (Saves are
/// otherwise per-turn synchronous + atomic tmp+rename, so no transient
/// mid-write windows exist and synchronous exit-hook GC is safe with this
/// predicate.) A dir without parseable metadata is NOT recognizably a stub
/// — never touched. Conservative on I/O errors: any error other than
/// NotFound on transcript.jsonl or events.jsonl means we cannot PROVE the
/// never-used signature — keep.
pub fn stub_is_unused(session_dir: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(session_dir.join("metadata.json")) else {
        return false;
    };
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    if meta.get("turn_count").is_some() {
        return false;
    }
    match std::fs::metadata(session_dir.join("transcript.jsonl")) {
        Ok(m) if m.len() > 0 => return false,
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        // Cannot prove the transcript is empty — keep.
        Err(_) => return false,
    }
    // Substring scan over raw BYTES is deliberate: the event line shape is
    // the CLI's own (hooks-logging module), and any `"prompt:submit"` hit —
    // parseable or not — must veto deletion. Bytes (not read_to_string)
    // because the exact kill-mid-first-turn scenario this guard exists for
    // can truncate events.jsonl mid multi-byte codepoint, making it invalid
    // UTF-8; a decode failure must not skip the veto.
    const PROMPT_SUBMIT: &[u8] = b"\"prompt:submit\"";
    match std::fs::read(session_dir.join("events.jsonl")) {
        Ok(events) => {
            if events
                .windows(PROMPT_SUBMIT.len())
                .any(|w| w == PROMPT_SUBMIT)
            {
                return false;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        // Cannot prove the absence of a prompt:submit trace — keep.
        Err(_) => return false,
    }
    true
}

/// Delete a broker-created stub iff it is still unused ("own our litter" —
/// without this, every never-typed-in terminal becomes a permanent '0 msgs'
/// row in the user's `amplifier session list`). Returns whether the dir was
/// removed. Best-effort: IO errors just leave the dir in place.
pub fn gc_stub_if_unused(session_dir: &Path) -> bool {
    if !stub_is_unused(session_dir) {
        return false;
    }
    std::fs::remove_dir_all(session_dir).is_ok()
}

/// Read-only disk-existence answer for one amplifier session id, scanning ALL
/// project slugs under `<amplifier_home>/projects/` (a session may live under
/// a different slug than the current cwd — see `ensure_session`'s divergent-
/// slug handling). Never creates anything.
///
/// Semantics (resume-validation feature — errors-seen accumulator, V3):
/// * session dir found under any project => `Present` (short-circuits);
/// * `projects/` missing (NotFound, parent readable) or scanned WITHOUT any
///   error and without a hit => `Absent` (store readable, definitively
///   absent — AD-1: missing root is positive absence, matching today's
///   warm-path steady state);
/// * `projects/` unreadable at the root, OR any per-entry error during the
///   scan (unreadable project subdir, EACCES stat, dropped dir entry) with
///   no hit => `Unreadable` (callers must fail OPEN — treat as unknown,
///   never as absent). NEVER adjudicate via `.is_dir()` alone: it returns
///   `false` on EACCES and would manufacture a false Absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmplifierSessionAnswer {
    Present,
    Absent,
    Unreadable,
}

pub fn session_on_disk(
    amplifier_home: &std::path::Path,
    session_id: &str,
) -> AmplifierSessionAnswer {
    let projects = amplifier_home.join("projects");
    let entries = match std::fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return AmplifierSessionAnswer::Absent; // AD-1: root missing, parent readable
        }
        Err(_) => return AmplifierSessionAnswer::Unreadable,
    };
    let mut saw_error = false;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                saw_error = true; // dropped dir entry (EIO, network fs) — cannot rule out
                continue;
            }
        };
        let candidate = entry.path().join("sessions").join(session_id);
        match std::fs::metadata(&candidate) {
            Ok(meta) if meta.is_dir() => return AmplifierSessionAnswer::Present,
            Ok(_) => {} // stray FILE named like the id — not a session dir
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => saw_error = true, // EACCES etc. — the session may be hiding here
        }
    }
    if saw_error {
        AmplifierSessionAnswer::Unreadable
    } else {
        AmplifierSessionAnswer::Absent
    }
}

/// Outcome of the boot-time layout canary ([`verify_amplifier_layout_contract`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanaryOutcome {
    Pass {
        sessions_checked: usize,
    },
    /// No amplifier home / no sessions with a `working_dir` — nothing to
    /// verify (amplifier unused or brand new). Not an error.
    NothingToCheck,
    Broken {
        detail: String,
    },
}

/// Cheap, re-runnable self-test of the on-disk contract this whole feature
/// rests on (undocumented upstream; microsoft/amplifier#315/#316 track a
/// `--session-id` flag that would collapse this layer into a flag): for a
/// bounded sample of sessions AMPLIFIER ITSELF wrote, verify the project dir
/// name equals [`cwd_slug`] of the session's own `working_dir`. A mismatch
/// means amplifier changed its slug/layout and our pre-created stubs would
/// silently diverge — callers log ERROR loudly but MUST NOT block broker
/// start.
///
/// VALIDATED skip classes (F6/V5 full-corpus census: 5216/5216 parseable
/// sessions match; 0 mismatches) — these are real shapes in real data, NOT
/// violations, and must be skipped rather than reported Broken: (a) session
/// dirs with no/unparseable `metadata.json` or no `working_dir`; (b)
/// `projects/` entries with no `sessions/` subdir (a literal `{project}`
/// template dir exists in real data).
pub fn verify_amplifier_layout_contract(amplifier_home: &Path) -> CanaryOutcome {
    const MAX_SESSIONS: usize = 20;
    let projects = amplifier_home.join("projects");
    let Ok(project_dirs) = std::fs::read_dir(&projects) else {
        return CanaryOutcome::NothingToCheck;
    };
    let mut checked = 0usize;
    for project in project_dirs.flatten() {
        let Some(project_name) = project.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(sessions) = std::fs::read_dir(project.path().join("sessions")) else {
            continue;
        };
        for session in sessions.flatten() {
            if checked >= MAX_SESSIONS {
                return CanaryOutcome::Pass {
                    sessions_checked: checked,
                };
            }
            let Ok(raw) = std::fs::read_to_string(session.path().join("metadata.json")) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(working_dir) = meta.get("working_dir").and_then(|v| v.as_str()) else {
                continue;
            };
            // `working_dir` was written RESOLVED by amplifier — slug it
            // directly (no canonicalize: the dir may no longer exist).
            let expected = cwd_slug(working_dir);
            if expected != project_name {
                return CanaryOutcome::Broken {
                    detail: format!(
                        "session {} has working_dir {working_dir} → expected project slug {expected}, but lives under {project_name}",
                        session.path().display()
                    ),
                };
            }
            checked += 1;
        }
    }
    if checked == 0 {
        CanaryOutcome::NothingToCheck
    } else {
        CanaryOutcome::Pass {
            sessions_checked: checked,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_home(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("amp-stub-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cwd_slug_matches_amplifiers_algorithm_exactly() {
        // project_utils.py:22-30: replace / \ : then ensure a leading '-'.
        assert_eq!(cwd_slug("/home/dan/code/pedal"), "-home-dan-code-pedal");
        // Dots and underscores are PRESERVED.
        assert_eq!(cwd_slug("/home/dan/my.project_x"), "-home-dan-my.project_x");
        // Root: "/" -> "-".
        assert_eq!(cwd_slug("/"), "-");
        // Windows-shaped input: backslashes -> '-', drive colon stripped,
        // and the result gains a leading '-' because it doesn't start with one.
        assert_eq!(cwd_slug("C:\\Users\\dan"), "-C-Users-dan");
        // Already-leading '-' is not doubled.
        assert_eq!(cwd_slug("-already"), "-already");
    }

    #[test]
    fn canonical_cwd_resolves_symlinks_and_falls_back_on_missing_dirs() {
        let tmp = std::env::temp_dir();
        assert_eq!(
            canonical_cwd(tmp.to_str().unwrap()),
            std::fs::canonicalize(&tmp).unwrap()
        );
        // A vanished path falls back to the raw path (the spawn itself
        // surfaces the error).
        assert_eq!(
            canonical_cwd("/definitely/not/a/dir/xyz"),
            PathBuf::from("/definitely/not/a/dir/xyz")
        );
    }

    #[test]
    fn resolve_amplifier_home_prefers_freshell_override_then_home_dot_amplifier() {
        // NOTE: env is process-global; this test is the only one in this
        // crate that sets FRESHELL_AMPLIFIER_HOME, and it restores the prior
        // value.
        let prior = std::env::var("FRESHELL_AMPLIFIER_HOME").ok();
        std::env::set_var("FRESHELL_AMPLIFIER_HOME", "/custom/amp/home");
        // The override IS the amplifier home ROOT, used as-is (callers join
        // `projects/...` onto it) — no `.amplifier` appended.
        assert_eq!(
            resolve_amplifier_home(),
            Some(std::path::PathBuf::from("/custom/amp/home"))
        );
        // Reconciliation (F1): the pre-existing index/resolver resolution
        // (`crate::amplifier::amplifier_home`, retargeted from AMPLIFIER_HOME
        // in this task) must AGREE with resolve_amplifier_home() under both
        // env states — otherwise the create-time events-lane attach would
        // look in a different home than the stub writer wrote into.
        assert_eq!(
            crate::amplifier::amplifier_home(std::path::Path::new("/fake/home")),
            std::path::PathBuf::from("/custom/amp/home")
        );
        // Fallback: `$HOME/.amplifier` — the `.amplifier` segment IS
        // appended here, mirroring the CLI's hardcoded
        // `Path.home()/.amplifier` (session_store.py:96-98).
        std::env::remove_var("FRESHELL_AMPLIFIER_HOME");
        if let Ok(home) = std::env::var("HOME") {
            assert_eq!(
                resolve_amplifier_home(),
                Some(std::path::PathBuf::from(home).join(".amplifier"))
            );
        }
        assert_eq!(
            crate::amplifier::amplifier_home(std::path::Path::new("/fake/home")),
            std::path::PathBuf::from("/fake/home/.amplifier")
        );
        match prior {
            Some(v) => std::env::set_var("FRESHELL_AMPLIFIER_HOME", v),
            None => std::env::remove_var("FRESHELL_AMPLIFIER_HOME"),
        }
    }

    #[test]
    fn ensure_session_writes_the_designed_stub_shape() {
        let home = unique_temp_home("shape");
        let cwd_dir = home.join("workdir");
        std::fs::create_dir_all(&cwd_dir).unwrap();
        let canonical = std::fs::canonicalize(&cwd_dir).unwrap();

        let ensured = ensure_session(
            &home,
            "11111111-2222-3333-4444-555555555555",
            cwd_dir.to_str().unwrap(),
            "term-1",
        )
        .unwrap();
        assert!(ensured.created);
        assert!(!ensured.found_under_divergent_slug);
        assert!(ensured.working_dir_of_existing.is_none());

        let expected_dir = home
            .join("projects")
            .join(cwd_slug(&canonical.to_string_lossy()))
            .join("sessions")
            .join("11111111-2222-3333-4444-555555555555");
        assert_eq!(ensured.session_dir, expected_dir);

        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(expected_dir.join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["session_id"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(meta["working_dir"], canonical.to_str().unwrap());
        assert_eq!(meta["freshell_terminal_id"], "term-1");
        // ISO-8601 with tz — must parse through the crate's own parser.
        assert!(crate::time::parse_timestamp_ms(&meta["created"]).is_some());
        // Omit `bundle` so the user's default bundle resolves.
        assert!(meta.get("bundle").is_none());
        // No turn_count on a fresh stub (the GC "unused" signature).
        assert!(meta.get("turn_count").is_none());
        // Empty transcript + empty events (events.jsonl is load-bearing for
        // the create-time activity events-lane attach).
        assert_eq!(
            std::fs::metadata(expected_dir.join("transcript.jsonl"))
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            std::fs::metadata(expected_dir.join("events.jsonl"))
                .unwrap()
                .len(),
            0
        );

        // Ensure-exists: a second call FINDS the dir, does not recreate.
        let again = ensure_session(
            &home,
            "11111111-2222-3333-4444-555555555555",
            cwd_dir.to_str().unwrap(),
            "term-2",
        )
        .unwrap();
        assert!(!again.created);
        // metadata untouched (still term-1).
        let meta2: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(expected_dir.join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta2["freshell_terminal_id"], "term-1");
    }

    #[test]
    fn ensure_session_rolls_back_the_directory_on_a_partial_write_failure() {
        // FIX (council-mandated rollback): a partial write failure (e.g.
        // ENOSPC/permissions) after create_dir_all succeeded must not leave
        // a metadata-less directory behind -- `stub_is_unused` conservatively
        // KEEPS an unparseable/missing metadata.json forever (never
        // GC-able), and a LATER `ensure_session` call for the same id would
        // silently ADOPT such a half-written dir via the bare
        // `candidate.is_dir()` "found" check above, treating broker litter
        // as a legitimate session.
        //
        // Injection: this function's "found" check treats ANY pre-existing
        // directory at the session leaf as legitimate (see the test above),
        // so the write failure can only be injected via the mode the LEAF
        // gets at creation time -- not via any pre-arranged file/dir at that
        // exact path. We pre-create every ancestor NORMALLY (writable) up to
        // (not including) the leaf, then run just the `ensure_session` call
        // on a DEDICATED thread with `unshare(CLONE_FS)` + a restrictive
        // umask: `unshare(CLONE_FS)` gives that one thread its own private
        // fs_struct (root/cwd/umask) per `man 2 unshare`, so the umask flip
        // cannot leak into the process-wide umask and flake unrelated
        // concurrent tests. umask 0o222 makes the freshly-created leaf
        // directory mode 0o555 (r-xr-xr-x): create_dir_all still succeeds
        // (mkdir only needs write+execute on the PARENT, which stays
        // normal), but writing metadata.json into the new leaf fails
        // (EACCES -- the leaf itself now lacks the write bit), while the
        // leaf remains readable+executable so the rollback's own
        // `remove_dir_all` (which must read_dir an empty leaf before
        // rmdir-ing it) can still succeed.
        let home = unique_temp_home("rollback");
        let cwd_dir = home.join("workdir");
        std::fs::create_dir_all(&cwd_dir).unwrap();
        let canonical = std::fs::canonicalize(&cwd_dir).unwrap();
        let session_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let slug = cwd_slug(&canonical.to_string_lossy());

        let sessions_dir = home.join("projects").join(&slug).join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let expected_dir = sessions_dir.join(session_id);
        assert!(
            !expected_dir.exists(),
            "precondition: the session leaf must not pre-exist"
        );

        let home_for_thread = home.clone();
        let cwd_str = cwd_dir.to_str().unwrap().to_string();
        let session_id_owned = session_id.to_string();
        let result = std::thread::spawn(move || {
            // SAFETY: unshare(CLONE_FS) only detaches THIS thread's
            // fs_struct (root/cwd/umask) from the rest of the process, per
            // `man 2 unshare`; it takes no pointers and cannot violate
            // memory safety. Scoped to this one throwaway test thread,
            // which exits immediately after, so no isolation is left
            // dangling either.
            let rc = unsafe { libc::unshare(libc::CLONE_FS) };
            assert_eq!(
                rc,
                0,
                "unshare(CLONE_FS) failed: {}",
                std::io::Error::last_os_error()
            );
            // SAFETY: umask() only reads/writes this (now-private) thread's
            // umask and returns the prior value; no pointers involved.
            let prior = unsafe { libc::umask(0o222) };
            let outcome = ensure_session(
                &home_for_thread,
                &session_id_owned,
                &cwd_str,
                "term-rollback",
            );
            unsafe { libc::umask(prior) };
            outcome
        })
        .join()
        .expect("rollback-injection thread panicked");

        let err = result.expect_err("a write into a mode-555 leaf must fail");
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(
            !expected_dir.exists(),
            "the partial-write leaf must be rolled back, not left behind un-GC-able"
        );

        // A subsequent ensure_session for the SAME id/cwd, under the
        // process's normal umask, must succeed cleanly -- proving the
        // rollback left no residue that corrupts the next attempt.
        let retried =
            ensure_session(&home, session_id, cwd_dir.to_str().unwrap(), "term-retry").unwrap();
        assert!(retried.created);
        assert_eq!(retried.session_dir, expected_dir);
        assert!(expected_dir.join("metadata.json").is_file());
        assert!(expected_dir.join("transcript.jsonl").is_file());
        assert!(expected_dir.join("events.jsonl").is_file());
    }

    #[test]
    fn ensure_session_finds_an_existing_dir_under_any_slug_and_does_not_touch_it() {
        let home = unique_temp_home("divergent");
        // A real session written by amplifier under some OTHER slug.
        let existing = home
            .join("projects")
            .join("-some-other-slug")
            .join("sessions")
            .join("sess-1");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(
            existing.join("metadata.json"),
            r#"{"session_id":"sess-1","working_dir":"/x","turn_count":3}"#,
        )
        .unwrap();

        let cwd_dir = home.join("elsewhere");
        std::fs::create_dir_all(&cwd_dir).unwrap();
        let ensured = ensure_session(&home, "sess-1", cwd_dir.to_str().unwrap(), "term-9").unwrap();
        assert!(!ensured.created);
        assert!(ensured.found_under_divergent_slug);
        assert_eq!(ensured.working_dir_of_existing.as_deref(), Some("/x"));
        assert_eq!(ensured.session_dir, existing);
        // Untouched: turn_count kept, no freshell_terminal_id injected.
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(existing.join("metadata.json")).unwrap())
                .unwrap();
        assert_eq!(meta["turn_count"], 3);
        assert!(meta.get("freshell_terminal_id").is_none());
    }

    #[test]
    fn ensure_session_rejects_ids_that_are_not_a_single_path_segment() {
        let home = unique_temp_home("pathsafety");
        let cwd = std::env::temp_dir();
        for bad in ["", ".", "..", "../../../etc/passwd", "a/b", "a\\b", "x\0y"] {
            let err = ensure_session(&home, bad, cwd.to_str().unwrap(), "t").unwrap_err();
            assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "id {bad:?}");
        }
        // Rejected BEFORE touching disk: projects/ never appears.
        assert!(!home.join("projects").exists());
    }

    fn write_gc_fixture(
        home: &Path,
        id: &str,
        metadata: &str,
        transcript: Option<&str>,
    ) -> PathBuf {
        let dir = home.join("projects").join("-p").join("sessions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("metadata.json"), metadata).unwrap();
        if let Some(t) = transcript {
            std::fs::write(dir.join("transcript.jsonl"), t).unwrap();
        }
        dir
    }

    #[test]
    fn stub_is_unused_recognizes_only_the_never_used_signature() {
        let home = unique_temp_home("gc-pred");
        let meta_unused = r#"{"session_id":"x","working_dir":"/w"}"#;
        let meta_used = r#"{"session_id":"x","working_dir":"/w","turn_count":2}"#;

        // Never used: no turn_count + empty transcript.                 -> true
        let a = write_gc_fixture(&home, "a", meta_unused, Some(""));
        assert!(stub_is_unused(&a));
        // Never used: no turn_count + transcript ABSENT.                -> true
        let b = write_gc_fixture(&home, "b", meta_unused, None);
        assert!(stub_is_unused(&b));
        // Used: turn_count present.                                     -> false
        let c = write_gc_fixture(&home, "c", meta_used, Some(""));
        assert!(!stub_is_unused(&c));
        // Used: non-empty transcript (even without turn_count).         -> false
        let d = write_gc_fixture(&home, "d", meta_unused, Some("{\"role\":\"user\"}\n"));
        assert!(!stub_is_unused(&d));
        // A zero-turn resume may create a small events.jsonl of session
        // LIFECYCLE events — tolerated (still unused).                  -> true
        let e = write_gc_fixture(&home, "e", meta_unused, Some(""));
        std::fs::write(e.join("events.jsonl"), "{\"event\":\"session:start\"}\n").unwrap();
        assert!(stub_is_unused(&e));
        // VALIDATED data-loss guard (F3/V4): an events.jsonl holding a
        // `prompt:submit` event means the user TYPED a prompt — a SIGHUP
        // mid-first-turn persists nothing to metadata/transcript, so this is
        // the ONLY trace of their content. NOT unused.                  -> false
        let f = write_gc_fixture(&home, "f", meta_unused, Some(""));
        std::fs::write(f.join("events.jsonl"), "{\"event\":\"prompt:submit\"}\n").unwrap();
        assert!(!stub_is_unused(&f));
        // Conservative byte-scan: a SIGHUP kill can truncate events.jsonl
        // mid multi-byte codepoint, making it invalid UTF-8 — the
        // `prompt:submit` veto must still fire on raw bytes.            -> false
        let h = write_gc_fixture(&home, "h", meta_unused, Some(""));
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend_from_slice(b"{\"event\":\"prompt:submit\"}\n");
        bytes.push(0xFF); // trailing truncated codepoint
        std::fs::write(h.join("events.jsonl"), bytes).unwrap();
        assert!(!stub_is_unused(&h));
        // Unparseable (present but invalid JSON) metadata.json: NOT
        // recognizably a stub — never delete.                           -> false
        let i = write_gc_fixture(&home, "i", "not json {", Some(""));
        assert!(!stub_is_unused(&i));
        // Missing metadata.json: NOT recognizably a stub — never delete. -> false
        let j = home.join("projects").join("-p").join("sessions").join("j");
        std::fs::create_dir_all(&j).unwrap();
        assert!(!stub_is_unused(&j));
    }

    #[test]
    fn gc_stub_if_unused_deletes_only_unused_dirs() {
        let home = unique_temp_home("gc-rm");
        let unused = write_gc_fixture(
            &home,
            "u",
            r#"{"session_id":"u","working_dir":"/w"}"#,
            Some(""),
        );
        let used = write_gc_fixture(
            &home,
            "v",
            r#"{"session_id":"v","working_dir":"/w","turn_count":1}"#,
            Some(""),
        );
        assert!(gc_stub_if_unused(&unused));
        assert!(!unused.exists());
        assert!(!gc_stub_if_unused(&used));
        assert!(used.exists());
    }

    #[test]
    fn canary_passes_when_real_session_dirs_match_our_slug() {
        let home = unique_temp_home("canary-pass");
        let dir = home
            .join("projects")
            .join(cwd_slug("/home/user/proj"))
            .join("sessions")
            .join("s1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            r#"{"session_id":"s1","working_dir":"/home/user/proj"}"#,
        )
        .unwrap();
        assert_eq!(
            verify_amplifier_layout_contract(&home),
            CanaryOutcome::Pass {
                sessions_checked: 1
            }
        );
    }

    #[test]
    fn canary_reports_broken_on_slug_divergence() {
        let home = unique_temp_home("canary-broken");
        // A hypothetical NEW upstream scheme (underscores instead of dashes).
        let dir = home
            .join("projects")
            .join("home_user_repos_app")
            .join("sessions")
            .join("s1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            r#"{"session_id":"s1","working_dir":"/home/user/repos/app"}"#,
        )
        .unwrap();
        assert!(matches!(
            verify_amplifier_layout_contract(&home),
            CanaryOutcome::Broken { .. }
        ));
    }

    #[test]
    fn canary_has_nothing_to_check_on_an_empty_or_missing_home() {
        let empty = unique_temp_home("canary-empty");
        assert_eq!(
            verify_amplifier_layout_contract(&empty),
            CanaryOutcome::NothingToCheck
        );
        assert_eq!(
            verify_amplifier_layout_contract(Path::new("/definitely/not/a/home")),
            CanaryOutcome::NothingToCheck
        );
    }

    #[test]
    fn canary_skips_validated_real_world_shapes_without_false_alarms() {
        let home = unique_temp_home("canary-skips");
        // (a) session dir with no metadata.json (events.jsonl-only, 2.4% of
        // the validated corpus) — skipped, not Broken.
        let no_meta = home
            .join("projects")
            .join("-p1")
            .join("sessions")
            .join("s1");
        std::fs::create_dir_all(&no_meta).unwrap();
        // (b) a projects/ entry with no sessions/ subdir (a literal
        // `{project}` template dir exists in real data) — skipped.
        std::fs::create_dir_all(home.join("projects").join("{project}")).unwrap();
        // One qualifying session still yields Pass{1}.
        let good = home
            .join("projects")
            .join(cwd_slug("/home/user/ok"))
            .join("sessions")
            .join("s2");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            good.join("metadata.json"),
            r#"{"session_id":"s2","working_dir":"/home/user/ok"}"#,
        )
        .unwrap();
        assert_eq!(
            verify_amplifier_layout_contract(&home),
            CanaryOutcome::Pass {
                sessions_checked: 1
            }
        );
    }

    // ============ session_on_disk tests ============
    use std::sync::atomic::{AtomicU64, Ordering as TestOrdering};

    static SCAN_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scan_temp_home(label: &str) -> std::path::PathBuf {
        let n = SCAN_COUNTER.fetch_add(1, TestOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-amplifier-scan-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Permission tests are meaningless as root (root ignores mode bits) —
    /// e.g. sandboxed/container suites. Skip (return early) when euid == 0.
    fn running_as_root() -> bool {
        std::process::Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false)
    }

    #[test]
    fn session_on_disk_present_under_cwd_slug() {
        let home = scan_temp_home("present");
        let sess = home.join("projects/-home-dan-proj/sessions/sid-1");
        std::fs::create_dir_all(&sess).unwrap();
        assert!(matches!(
            session_on_disk(&home, "sid-1"),
            AmplifierSessionAnswer::Present
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_on_disk_present_under_divergent_slug() {
        // The tab may have moved cwd; the session lives under ANOTHER project
        // slug. Scanning all project dirs must still find it (plan decision:
        // search all projects, documented in Global Constraints).
        let home = scan_temp_home("divergent");
        std::fs::create_dir_all(home.join("projects/-some-other-project/sessions/sid-2")).unwrap();
        std::fs::create_dir_all(home.join("projects/-home-dan-proj")).unwrap();
        assert!(matches!(
            session_on_disk(&home, "sid-2"),
            AmplifierSessionAnswer::Present
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_on_disk_absent_when_store_readable() {
        let home = scan_temp_home("absent");
        std::fs::create_dir_all(home.join("projects/-home-dan-proj/sessions/other-sid")).unwrap();
        assert!(matches!(
            session_on_disk(&home, "sid-3"),
            AmplifierSessionAnswer::Absent
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_on_disk_absent_when_projects_dir_missing() {
        // Store root exists but amplifier has never created projects/:
        // readable-and-empty => definitively absent.
        let home = scan_temp_home("noprojects");
        assert!(matches!(
            session_on_disk(&home, "sid-4"),
            AmplifierSessionAnswer::Absent
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn session_on_disk_unreadable_projects_dir_fails_open() {
        use std::os::unix::fs::PermissionsExt;
        if running_as_root() {
            return; // root ignores mode bits — test is meaningless
        }
        let home = scan_temp_home("unreadable");
        let projects = home.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
        let answer = session_on_disk(&home, "sid-5");
        // Restore perms before asserting so cleanup works even on failure.
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(answer, AmplifierSessionAnswer::Unreadable));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn session_on_disk_unreadable_project_subdir_fails_open() {
        // V3 case E2a: a chmod-000 PROJECT dir with the session inside must
        // answer Unreadable, never Absent (`.is_dir()` returns false on
        // EACCES — the errors-seen accumulator catches the metadata error).
        use std::os::unix::fs::PermissionsExt;
        if running_as_root() {
            return;
        }
        let home = scan_temp_home("locked-project");
        let locked = home.join("projects/-locked-proj");
        std::fs::create_dir_all(locked.join("sessions/sid-7")).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let answer = session_on_disk(&home, "sid-7");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(answer, AmplifierSessionAnswer::Unreadable));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn session_on_disk_listable_not_traversable_projects_fails_open() {
        // V3 case E2b: projects/ mode 444 — read_dir succeeds (needs r) but
        // stat into children needs x, so every per-entry metadata call errors.
        // Any-error-and-no-hit => Unreadable.
        use std::os::unix::fs::PermissionsExt;
        if running_as_root() {
            return;
        }
        let home = scan_temp_home("no-traverse");
        let projects = home.join("projects");
        std::fs::create_dir_all(projects.join("-p/sessions/sid-8")).unwrap();
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o444)).unwrap();
        let answer = session_on_disk(&home, "sid-8");
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(answer, AmplifierSessionAnswer::Unreadable));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_on_disk_matches_a_file_only_as_absent() {
        // A stray FILE named like the session id is not a session dir.
        let home = scan_temp_home("file-not-dir");
        let sessions = home.join("projects/-p/sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("sid-6"), b"junk").unwrap();
        assert!(matches!(
            session_on_disk(&home, "sid-6"),
            AmplifierSessionAnswer::Absent
        ));
        let _ = std::fs::remove_dir_all(&home);
    }
}
