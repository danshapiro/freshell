//! codex **durability / thread-id** handling — the id shapes the T2
//! `session.durable-id-shape` invariant grades, the rollout-filename → threadId extraction
//! (`providers/codex.ts:417-421`), and the sidecar ownership identifiers the `/proc` reaper
//! keys on (parity with `freshell-opencode`'s `OPENCODE_SIDECAR_OWNERSHIP_ENV`).
//!
//! Codex thread ids are **UUIDs and STABLE from create** — placeholder == durable, so NO
//! `freshAgent.session.materialized` event fires (`coding-cli.md §1c`; `codex-gptmini.json`
//! shapes `placeholderIdPattern == durableIdPattern`). The on-disk transcript is
//! `rollout-<ts>-<threadId>.jsonl` under `<CODEX_HOME>/sessions/<date-dirs>/`
//! (`codex-gptmini.json` provenance).

use std::path::Path;

use uuid::Uuid;

/// The env var that tags an owned `codex app-server` sidecar so the `/proc` reaper can
/// SIGTERM exactly our detached child and no other (`runtime.ts:494,1258`). The reaper
/// needle is `"{CODEX_SIDECAR_OWNERSHIP_ENV}={ownership_id}"`. Mirror of
/// `freshell-opencode`'s `OPENCODE_SIDECAR_OWNERSHIP_ENV`.
pub const CODEX_SIDECAR_OWNERSHIP_ENV: &str = "FRESHELL_CODEX_SIDECAR_ID";

/// `true` iff `value` is a bare UUID (8-4-4-4-12 hex) — the codex thread-id / durable-id
/// shape (`codex-gptmini.json` `placeholderIdPattern`/`durableIdPattern`). Case-insensitive
/// hex, matching the reference's `[0-9a-fA-F]` classes (`providers/codex.ts:419`).
pub fn is_codex_thread_id(value: &str) -> bool {
    matches_uuid_at(value.as_bytes(), 0) == Some(value.len())
}

/// The `/proc environ` reaper needle for an owned sidecar (`runtime.ts:494`).
pub fn ownership_needle(ownership_id: &str) -> String {
    format!("{CODEX_SIDECAR_OWNERSHIP_ENV}={ownership_id}")
}

/// Mint a fresh sidecar ownership id `codex-sidecar-<uuid>` (`ownershipIdFactory`,
/// `runtime.ts:924`).
pub fn mint_ownership_id() -> String {
    format!("codex-sidecar-{}", Uuid::new_v4())
}

/// The default server-instance id: `FRESHELL_SERVER_INSTANCE_ID` or `srv-<pid>`
/// (`runtime.ts:923`). Stamped into ownership metadata + durability records.
pub fn default_server_instance_id() -> String {
    std::env::var("FRESHELL_SERVER_INSTANCE_ID")
        .unwrap_or_else(|_| format!("srv-{}", std::process::id()))
}

// ── history mode (kata 1wxv Task 2, LBC-1) ─────────────────────────────────

/// The codex thread history mode. `thread/revert` (0.149.0 conversation
/// rollback) REFUSES legacy threads, so rollback capability is gated on the
/// thread being [`HistoryMode::Paginated`]. There is deliberately no `Legacy`
/// variant: "not paginated" (missing/unparseable durable meta, an explicit
/// `"legacy"` value) reads as `Option<HistoryMode>::None` at every consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryMode {
    Paginated,
}

impl HistoryMode {
    /// The `thread/start` wire value (`historyMode`).
    pub fn wire_name(&self) -> &'static str {
        match self {
            HistoryMode::Paginated => "paginated",
        }
    }

    /// Parse the rollout `session_meta.payload.history_mode` value. Only the
    /// exact durable `"paginated"` string upgrades a thread; anything else
    /// (missing key, non-string, unknown value) stays legacy.
    fn from_meta_value(value: Option<&serde_json::Value>) -> Option<HistoryMode> {
        match value.and_then(serde_json::Value::as_str) {
            Some("paginated") => Some(HistoryMode::Paginated),
            _ => None,
        }
    }
}

/// The `<CODEX_HOME|~/.codex>/sessions` root (same resolution as
/// `defaultCodexHome()`, `providers/codex.ts:25-27`). `None` when neither
/// `CODEX_HOME` nor `HOME` is set — there is no rollout tree to read.
fn codex_sessions_root() -> Option<std::path::PathBuf> {
    if let Ok(v) = std::env::var("CODEX_HOME") {
        if !v.is_empty() {
            return Some(std::path::PathBuf::from(v).join("sessions"));
        }
    }
    let home = std::env::var("HOME").ok().filter(|v| !v.is_empty())?;
    Some(
        std::path::PathBuf::from(home)
            .join(".codex")
            .join("sessions"),
    )
}

/// The first line of `path`, trimmed. Rollout session_meta is ALWAYS line 0
/// (the rollout writer emits it first; a file still in codex's
/// create→session_meta git-info gap has no readable first line yet and
/// answers `None`).
fn first_line(path: &Path) -> Option<String> {
    read_first_line(path).ok().flatten()
}

/// [`first_line`], with the read error kept (an empty first line is
/// `Ok(None)`).
fn read_first_line(path: &Path) -> std::io::Result<Option<String>> {
    use std::io::{BufRead, Read};
    let file = std::fs::File::open(path)?;
    let mut reader = std::io::BufReader::new(file).take(1024 * 1024);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let trimmed = first.trim();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

/// Parse a rollout `session_meta` first line into its payload. `None` for any
/// line that is not a `{"type":"session_meta","payload":{…}}` record.
fn session_meta_payload(line: &str) -> Option<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
        return None;
    }
    value.get("payload").cloned()
}

/// What a lookup of a thread's rollout under a `sessions` root found.
#[derive(Debug)]
pub enum RolloutLookup {
    /// The rollout the thread owns.
    Found(std::path::PathBuf),
    /// The whole tree was read and holds no rollout of the thread. A missing
    /// `sessions` root counts: nothing was ever written there.
    Absent,
    /// Part of the tree could not be read (a permission error, an I/O
    /// error, a symlink loop), so the rollout's absence is not proven.
    Unreadable(std::io::Error),
}

/// Look up the rollout owned by `thread_id` under `sessions_root`. The
/// filename containment is a cheap PREFILTER; ownership is proven by the
/// first line being a `session_meta` whose `payload.id`/`payload.session_id`
/// equals the thread id — substring matching alone is unsafe (rollouts embed
/// foreign uuids as fork/resume lineage; the codex_reconcile walk in
/// freshell-ws uses the same proof). Bounded recursive walk: the tree is
/// `sessions/YYYY/MM/DD/rollout-*.jsonl` (flat `<id>.jsonl` in tests). The
/// day folders a time-ordered id dates ([`day_folders_for`]) are looked in
/// first, so the common case (the rollout exists) reads a few folders, not
/// the whole tree.
///
/// Absence is concluded only from a tree the walk read in full: something
/// that vanished during the walk (NotFound) is simply not there, but any
/// other error reading a directory, an entry or a candidate file answers
/// [`RolloutLookup::Unreadable`] unless the rollout was found anyway.
fn lookup_rollout(sessions_root: &Path, thread_id: &str) -> RolloutLookup {
    lookup_rollout_observed(sessions_root, thread_id, &mut |_| {})
}

/// The Unix time (ms) a time-ordered thread id carries: Codex thread ids are
/// UUIDv7 (RFC 9562), whose first 48 bits are the Unix time in ms. `None`
/// for any other id (a v4 UUID, a test id).
fn uuid_v7_unix_ms(thread_id: &str) -> Option<u64> {
    let bytes = thread_id.as_bytes();
    if !is_codex_thread_id(thread_id)
        || bytes[14] != b'7'
        || !matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
    {
        return None;
    }
    u64::from_str_radix(&format!("{}{}", &thread_id[..8], &thread_id[9..13]), 16).ok()
}

/// The proleptic Gregorian `(year, month, day)` of a day count since
/// 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153; // March = 0
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The `YYYY/MM/DD` day folders (relative to `sessions`) a rollout of
/// `thread_id` can be in, most likely first. Codex files a rollout under the
/// LOCAL date its thread was created, the time its UUIDv7 id carries. Local
/// dates lie within a day of the UTC date (offsets run from -12 h to +14 h),
/// so the UTC day and the days either side cover every offset. `None` when
/// the id carries no time.
fn day_folders_for(thread_id: &str) -> Option<[std::path::PathBuf; 3]> {
    let day = i64::try_from(uuid_v7_unix_ms(thread_id)? / 86_400_000).ok()?;
    let folder = |days: i64| {
        let (year, month, day) = civil_from_days(days);
        Path::new(&format!("{year:04}"))
            .join(format!("{month:02}"))
            .join(format!("{day:02}"))
    };
    Some([folder(day), folder(day - 1), folder(day + 1)])
}

/// [`lookup_rollout`], telling `listed` each directory it lists (tests).
fn lookup_rollout_observed(
    sessions_root: &Path,
    thread_id: &str,
    listed: &mut dyn FnMut(&Path),
) -> RolloutLookup {
    use std::io::ErrorKind::NotFound;
    /// Whether the candidate `path` is `thread_id`'s rollout. A file whose
    /// first line is not (yet) a `session_meta` is not; a file that cannot
    /// be read is an error.
    fn owns(path: &Path, thread_id: &str) -> std::io::Result<bool> {
        let Some(first) = read_first_line(path)? else {
            return Ok(false);
        };
        let Some(payload) = session_meta_payload(&first) else {
            return Ok(false);
        };
        Ok(
            payload.get("id").and_then(serde_json::Value::as_str) == Some(thread_id)
                || payload
                    .get("session_id")
                    .and_then(serde_json::Value::as_str)
                    == Some(thread_id),
        )
    }
    /// Walks `dir`; the first read error (other than NotFound) is kept in
    /// `error`.
    fn walk(
        dir: &Path,
        thread_id: &str,
        depth: u8,
        error: &mut Option<std::io::Error>,
        listed: &mut dyn FnMut(&Path),
    ) -> Option<std::path::PathBuf> {
        if depth > 5 {
            return None;
        }
        listed(dir);
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == NotFound => return None,
            Err(e) => {
                error.get_or_insert(e);
                return None;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    error.get_or_insert(e);
                    continue;
                }
            };
            let path = entry.path();
            // The entry's type comes with the listing (no extra stat); a
            // symlink is followed, as before.
            let is_dir = match entry.file_type() {
                Ok(kind) if kind.is_symlink() => match std::fs::metadata(&path) {
                    Ok(meta) => meta.is_dir(),
                    Err(e) if e.kind() == NotFound => continue, // dangling
                    Err(e) => {
                        error.get_or_insert(e);
                        continue;
                    }
                },
                Ok(kind) => kind.is_dir(),
                Err(e) if e.kind() == NotFound => continue,
                Err(e) => {
                    error.get_or_insert(e);
                    continue;
                }
            };
            if is_dir {
                if let Some(hit) = walk(&path, thread_id, depth + 1, error, listed) {
                    return Some(hit);
                }
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".jsonl") && n.contains(thread_id))
            {
                match owns(&path, thread_id) {
                    Ok(true) => return Some(path),
                    Ok(false) => {}
                    Err(e) if e.kind() == NotFound => {}
                    Err(e) => {
                        error.get_or_insert(e);
                    }
                }
            }
        }
        None
    }
    // The day folders the id dates come first: a hit there needs no walk of
    // the whole tree. Their read errors are not kept: a miss walks the whole
    // tree, which meets them again.
    for day in day_folders_for(thread_id).into_iter().flatten() {
        if let Some(hit) = walk(&sessions_root.join(day), thread_id, 3, &mut None, listed) {
            return RolloutLookup::Found(hit);
        }
    }
    let mut error = None;
    match (walk(sessions_root, thread_id, 0, &mut error, listed), error) {
        (Some(hit), _) => RolloutLookup::Found(hit),
        (None, None) => RolloutLookup::Absent,
        (None, Some(error)) => RolloutLookup::Unreadable(error),
    }
}

/// The rollout owned by `thread_id` under `sessions_root`, when the walk
/// found it ([`lookup_rollout`]; a tree it could not read answers `None`).
fn locate_rollout(sessions_root: &Path, thread_id: &str) -> Option<std::path::PathBuf> {
    match lookup_rollout(sessions_root, thread_id) {
        RolloutLookup::Found(path) => Some(path),
        RolloutLookup::Absent | RolloutLookup::Unreadable(_) => None,
    }
}

/// The thread's DURABLE history mode, read from its rollout's persisted
/// `session_meta.history_mode` (kata 1wxv Task 2, r3: validator-C proved the
/// mode persists there, and `thread/resume` takes no mode param — the durable
/// rollout meta is the ONLY source of truth; the app-server exposes no live
/// read-back). `Some(Paginated)` only when the meta says so; a missing rollout,
/// a missing/unparseable mode, or an IO/parse failure all answer `None` ⇒
/// legacy (capability never over-advertised: `undo:false`).
pub fn read_rollout_history_mode(thread_id: &str) -> Option<HistoryMode> {
    let root = codex_sessions_root()?;
    let path = locate_rollout(&root, thread_id)?;
    let line = first_line(&path)?;
    let payload = session_meta_payload(&line)?;
    HistoryMode::from_meta_value(payload.get("history_mode"))
}

/// Unified agent names (Task 3, T2-M6): the rollout-walk under an EXPLICIT
/// `codex_home` — the same ownership-proofed walk as
/// [`read_rollout_history_mode`], but rooted at the initialized home a
/// connection or proxy CAPTURED rather than ambient env (the remote-proxy
/// initialize correlation pins that a proxied client's captured home is the
/// root its rollouts live under). The freshness-codex bind lane and the
/// native name adapter use this to verify durability at the captured root.
pub fn locate_thread_rollout_in_home(
    codex_home: &Path,
    thread_id: &str,
) -> Option<std::path::PathBuf> {
    locate_rollout(&codex_home.join("sessions"), thread_id)
}

/// [`locate_thread_rollout_in_home`], telling a tree that holds no rollout
/// of the thread ([`RolloutLookup::Absent`]) from one that could not be read
/// ([`RolloutLookup::Unreadable`]). The planner decides "never materialized"
/// only from `Absent`.
pub fn lookup_thread_rollout_in_home(codex_home: &Path, thread_id: &str) -> RolloutLookup {
    lookup_rollout(&codex_home.join("sessions"), thread_id)
}

/// `extractSessionIdFromFilename(filePath)` (`providers/codex.ts:417-421`): the UUID embedded
/// in a `rollout-<ts>-<threadId>.jsonl` basename, else the basename (minus `.jsonl`) verbatim.
pub fn extract_session_id_from_filename(file_path: &str) -> String {
    let base = Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_path);
    let base = base.strip_suffix(".jsonl").unwrap_or(base);
    match find_uuid(base) {
        Some(uuid) => uuid,
        None => base.to_string(),
    }
}

// ── UUID matching (no regex crate; hand-rolled 8-4-4-4-12 hex) ──────────────────────────

fn is_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b.to_ascii_lowercase())
}

/// If `bytes[start..]` begins with a UUID (8-4-4-4-12 hex), return the index just past it.
fn matches_uuid_at(bytes: &[u8], start: usize) -> Option<usize> {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let mut i = start;
    for (g, &len) in GROUPS.iter().enumerate() {
        if g > 0 {
            if bytes.get(i) != Some(&b'-') {
                return None;
            }
            i += 1;
        }
        for _ in 0..len {
            match bytes.get(i) {
                Some(&b) if is_hex(b) => i += 1,
                _ => return None,
            }
        }
    }
    Some(i)
}

/// The first UUID-shaped substring of `text`, if any (`String.match(uuidRegex)`).
fn find_uuid(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if let Some(end) = matches_uuid_at(bytes, start) {
            return Some(text[start..end].to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_thread_id_shape_is_a_bare_uuid() {
        // The exact codex-gptmini.json placeholder/durable pattern.
        assert!(is_codex_thread_id("019810de-1e5f-7db3-9c47-1c2a3b4c5d6e"));
        assert!(is_codex_thread_id("ABCDEF01-2345-6789-abcd-ef0123456789")); // case-insensitive
                                                                             // Rejections: too short, extra chars, non-hex, wrong grouping.
        assert!(!is_codex_thread_id("thread-new-1"));
        assert!(!is_codex_thread_id("freshopencode-abc"));
        assert!(!is_codex_thread_id("019810de-1e5f-7db3-9c47-1c2a3b4c5d6")); // 11 in last group
        assert!(!is_codex_thread_id("019810de-1e5f-7db3-9c47-1c2a3b4c5d6ef")); // 13 in last group
        assert!(!is_codex_thread_id("g19810de-1e5f-7db3-9c47-1c2a3b4c5d6e")); // non-hex
        assert!(!is_codex_thread_id(" 019810de-1e5f-7db3-9c47-1c2a3b4c5d6e")); // leading space
    }

    #[test]
    fn rollout_filename_yields_embedded_thread_uuid() {
        // rollout-<ts>-<threadId>.jsonl → the UUID (codex-gptmini.json transcript layout).
        assert_eq!(
            extract_session_id_from_filename(
                "/codex/sessions/2026/07/05/rollout-2026-07-05T06-25-37-019810de-1e5f-7db3-9c47-1c2a3b4c5d6e.jsonl"
            ),
            "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e"
        );
        // No UUID → the basename verbatim (reference fallback).
        assert_eq!(
            extract_session_id_from_filename("/x/session-activity.jsonl"),
            "session-activity"
        );
        assert_eq!(
            extract_session_id_from_filename("rollout-plain.jsonl"),
            "rollout-plain"
        );
    }

    #[test]
    fn ownership_id_and_needle_shapes() {
        let id = mint_ownership_id();
        assert!(id.starts_with("codex-sidecar-"));
        assert!(
            is_codex_thread_id(id.trim_start_matches("codex-sidecar-")),
            "the tail is a UUID"
        );
        assert_eq!(
            ownership_needle("codex-sidecar-abc"),
            "FRESHELL_CODEX_SIDECAR_ID=codex-sidecar-abc"
        );
    }

    #[test]
    fn server_instance_id_defaults_to_srv_pid_without_env() {
        // No env override → srv-<pid> shape (we cannot mutate global env safely in parallel
        // tests, so only assert the default branch shape when the var is absent).
        if std::env::var("FRESHELL_SERVER_INSTANCE_ID").is_err() {
            let id = default_server_instance_id();
            assert!(id.starts_with("srv-"), "got {id}");
        }
    }

    // ── history mode (kata 1wxv Task 2) ────────────────────────────────────

    fn write_rollout(root: &Path, dir: &str, name: &str, payload: &str) {
        let dir = root.join(dir);
        std::fs::create_dir_all(&dir).expect("sessions dir");
        std::fs::write(
            dir.join(name),
            format!("{{\"timestamp\":\"2026-08-23T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{{payload}}}}}\n"),
        )
        .expect("write rollout");
    }

    /// A thread's rollout is proven absent only from a tree the walk read in
    /// full; a tree it could not read proves nothing.
    #[test]
    fn a_rollout_lookup_tells_an_unreadable_tree_from_an_absent_rollout() {
        let tid = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";
        let home = tempfile::tempdir().expect("tempdir");
        let lookup = || lookup_thread_rollout_in_home(home.path(), tid);

        // No `sessions` root: nothing was ever written.
        assert!(matches!(lookup(), RolloutLookup::Absent), "{:?}", lookup());

        // A readable tree without the thread's rollout.
        let sessions = home.path().join("sessions");
        write_rollout(
            &sessions,
            "2026/08/23",
            "rollout-2026-08-23T00-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
            "\"id\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\"",
        );
        assert!(matches!(lookup(), RolloutLookup::Absent), "{:?}", lookup());

        // A directory entry that cannot be resolved (a symlink loop).
        std::os::unix::fs::symlink("loop", sessions.join("2026/loop")).expect("symlink loop");
        assert!(
            matches!(lookup(), RolloutLookup::Unreadable(_)),
            "{:?}",
            lookup()
        );

        // Found anyway: the unreadable part does not matter.
        write_rollout(
            &sessions,
            "2026/08/24",
            &format!("rollout-2026-08-24T00-00-00-{tid}.jsonl"),
            &format!("\"id\":\"{tid}\""),
        );
        assert!(
            matches!(lookup(), RolloutLookup::Found(_)),
            "{:?}",
            lookup()
        );

        // A `sessions` root that is not a directory cannot be listed.
        let other = tempfile::tempdir().expect("tempdir");
        std::fs::write(other.path().join("sessions"), "not a directory").unwrap();
        assert!(matches!(
            lookup_thread_rollout_in_home(other.path(), tid),
            RolloutLookup::Unreadable(_)
        ));
        assert_eq!(locate_thread_rollout_in_home(other.path(), tid), None);
    }

    /// A UUIDv7 thread id for the Unix time `ms` (the rest of the id fixed).
    fn v7_id_at(ms: u64) -> String {
        let hex = format!("{ms:012x}");
        format!("{}-{}-7db3-9c47-1c2a3b4c5d6e", &hex[..8], &hex[8..])
    }

    /// Codex thread ids are time-ordered (UUIDv7): their rollout is filed
    /// under the local date of their time, which lies within a day of its UTC
    /// date. Other ids carry no usable time.
    #[test]
    fn a_time_ordered_id_dates_the_day_folders_around_its_time() {
        let folders = |id: &str| {
            day_folders_for(id).map(|days| {
                days.iter()
                    .map(|day| day.to_string_lossy().replace('\\', "/"))
                    .collect::<Vec<_>>()
            })
        };
        // A real Codex id: 2026-05-03T23:54:37.949Z, filed under 2026/05/03 (UTC-7).
        assert_eq!(
            folders("019df043-f1fd-79d0-85c8-3ae11fb2237d"),
            Some(vec![
                "2026/05/03".into(),
                "2026/05/02".into(),
                "2026/05/04".into()
            ])
        );
        // Across a month and a year: 2026-01-01T00:30:00Z.
        assert_eq!(
            folders(&v7_id_at(1_767_227_400_000)),
            Some(vec![
                "2026/01/01".into(),
                "2025/12/31".into(),
                "2026/01/02".into()
            ])
        );
        // A leap day: 2028-02-29T12:00:00Z.
        assert_eq!(
            folders(&v7_id_at(1_835_438_400_000)),
            Some(vec![
                "2028/02/29".into(),
                "2028/02/28".into(),
                "2028/03/01".into()
            ])
        );
        assert_eq!(
            folders("b7936c10-4935-441c-837c-c1f33cafec2d"),
            None,
            "a v4 id"
        );
        assert_eq!(folders("thr-legacy"), None, "not a UUID");
    }

    /// The rollout of a time-ordered thread id is looked up first in the day
    /// folders its id dates, and a hit there is found without the full walk:
    /// the tree's root is never listed, so an unrelated unreadable subtree,
    /// which a full walk would meet, is never read. A miss there, or an id
    /// with no time, walks the whole tree, so absence is still proven only
    /// from a tree read in full.
    #[test]
    fn a_rollout_in_the_day_folder_its_id_dates_is_found_without_the_full_walk() {
        let tid = "019df043-f1fd-79d0-85c8-3ae11fb2237d"; // 2026-05-03T23:54:37.949Z
        let owned = |root: &Path, dir: &str| {
            write_rollout(
                root,
                dir,
                &format!("rollout-2026-05-03T16-54-38-{tid}.jsonl"),
                &format!("\"id\":\"{tid}\""),
            )
        };
        let lookup = |root: &Path, id: &str| {
            let mut listed = Vec::new();
            let found =
                lookup_rollout_observed(root, id, &mut |dir: &Path| listed.push(dir.to_path_buf()));
            (found, listed)
        };

        let dated = tempfile::tempdir().expect("tempdir");
        owned(dated.path(), "2026/05/03");
        std::fs::create_dir_all(dated.path().join("2025")).unwrap();
        std::os::unix::fs::symlink("loop", dated.path().join("2025/loop")).expect("symlink loop");
        let (found, listed) = lookup(dated.path(), tid);
        assert!(matches!(found, RolloutLookup::Found(_)), "{found:?}");
        assert!(
            !listed.contains(&dated.path().to_path_buf()),
            "found in its day folder, without the full walk: {listed:?}"
        );

        // Filed under a date its id does not give (its day folder holds
        // another thread's rollout): the full walk finds it.
        let elsewhere = tempfile::tempdir().expect("tempdir");
        owned(elsewhere.path(), "2026/08/23");
        write_rollout(
            elsewhere.path(),
            "2026/05/03",
            "rollout-2026-05-03T10-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
            "\"id\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\"",
        );
        let (found, listed) = lookup(elsewhere.path(), tid);
        assert!(matches!(found, RolloutLookup::Found(_)), "{found:?}");
        assert!(
            listed.contains(&elsewhere.path().to_path_buf()),
            "{listed:?}"
        );

        // Absent: proven by the full walk, after the day folders missed.
        let (found, listed) = lookup(elsewhere.path(), &v7_id_at(1_777_852_477_949));
        assert!(matches!(found, RolloutLookup::Absent), "{found:?}");
        assert!(
            listed.contains(&elsewhere.path().to_path_buf()),
            "{listed:?}"
        );

        // An id with no time: the full walk only.
        let (found, listed) = lookup(dated.path(), "b7936c10-4935-441c-837c-c1f33cafec2d");
        assert!(matches!(found, RolloutLookup::Unreadable(_)), "{found:?}");
        assert_eq!(
            listed.first(),
            Some(&dated.path().to_path_buf()),
            "{listed:?}"
        );
    }

    #[test]
    fn history_mode_wire_and_meta_parse() {
        assert_eq!(HistoryMode::Paginated.wire_name(), "paginated");
        assert_eq!(
            HistoryMode::from_meta_value(Some(&serde_json::json!("paginated"))),
            Some(HistoryMode::Paginated)
        );
        // Missing key, wrong type, unknown value, explicit legacy → all legacy (None).
        assert_eq!(HistoryMode::from_meta_value(None), None);
        assert_eq!(
            HistoryMode::from_meta_value(Some(&serde_json::json!(42))),
            None
        );
        assert_eq!(
            HistoryMode::from_meta_value(Some(&serde_json::json!("legacy"))),
            None
        );
        assert_eq!(
            HistoryMode::from_meta_value(Some(&serde_json::json!("Paginated"))),
            None,
            "the durable value is matched exactly (no case laundering)"
        );
    }

    #[test]
    fn locate_rollout_proves_ownership_by_the_session_meta_first_line() {
        let root = tempfile::tempdir().expect("tempdir");
        let tid = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";
        // The owned rollout, nested in the dated tree.
        write_rollout(
            root.path(),
            "2026/08/23",
            &format!("rollout-2026-08-23T00-00-00-{tid}.jsonl"),
            &format!("\"id\":\"{tid}\",\"history_mode\":\"paginated\""),
        );
        // A FOREIGN rollout whose filename embeds the searched id via lineage —
        // the prefilter hits, the ownership proof must reject it.
        write_rollout(
            root.path(),
            "2026/08/23",
            "rollout-2026-08-23T01-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
            &format!(
                "\"id\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\",\"forked_from_id\":\"{tid}\""
            ),
        );
        // A filename-match decoy whose session_meta names a DIFFERENT id (the
        // documented-unsafe substring case): a copy of tid's rollout under a
        // mangled name.
        write_rollout(
            root.path(),
            "",
            &format!("flat-{tid}.jsonl"),
            "\"id\":\"ffffffff-0000-4111-8222-333333333333\"",
        );

        // The walk must find SOME owned file (the dated-tree one) even though the
        // flat foreign decoy exists at the root...
        let hit = locate_rollout(root.path(), tid).expect("owned rollout found");
        assert!(
            hit.to_string_lossy().contains("2026/08/23"),
            "the dated-tree owned rollout wins: {hit:?}"
        );
        // ...and must skip both decoys when the owned one is absent.
        std::fs::remove_file(&hit).expect("remove owned");
        assert_eq!(locate_rollout(root.path(), tid), None);
    }

    #[test]
    fn read_rollout_history_mode_parses_the_meta_of_an_explicit_root() {
        let root = tempfile::tempdir().expect("tempdir");
        let tid = "thr-paged";
        write_rollout(
            root.path(),
            "2026/08/23",
            "rollout-2026-08-23T00-00-00-thr-paged.jsonl",
            "\"id\":\"thr-paged\",\"history_mode\":\"paginated\"",
        );
        let hit = locate_rollout(root.path(), tid).expect("found");
        let line = first_line(&hit).expect("first line");
        let payload = session_meta_payload(&line).expect("payload");
        assert_eq!(
            HistoryMode::from_meta_value(payload.get("history_mode")),
            Some(HistoryMode::Paginated)
        );
        write_rollout(
            root.path(),
            "2026/08/24",
            "rollout-2026-08-24T00-00-00-thr-legacy.jsonl",
            "\"id\":\"thr-legacy\"",
        );
        let hit = locate_rollout(root.path(), "thr-legacy").expect("found");
        let line = first_line(&hit).expect("first line");
        let payload = session_meta_payload(&line).expect("payload");
        assert_eq!(
            HistoryMode::from_meta_value(payload.get("history_mode")),
            None,
            "a missing durable mode stamps legacy (undo:false)"
        );
    }
}
