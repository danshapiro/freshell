//! Centralized provider-layout knowledge: where each coding-CLI provider
//! stores session files on disk. ONE source of truth consumed by the
//! session-directory index, the session watcher, the ledger GC, and any
//! other code that needs to know provider file layouts.
//!
//! Each provider implements [`ProviderLayout`]. The trait exposes:
//! - `session_root`: the directory tree containing session data
//! - `watch_bases`: directories to arm inotify watchers on
//! - `qualifies`: does a given path look like a session file for this provider?
//! - `watch_mode`: recursive vs non-recursive watching
//! - `is_direct_listed`: true for providers like OpenCode that use a single
//!   database rather than per-session files

use std::path::{Path, PathBuf};

/// How the session watcher should watch this provider's `watch_bases`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchMode {
    /// Watch recursively (claude, codex, amplifier — directory trees).
    Recursive,
    /// Watch non-recursively (opencode — single db file + wal).
    NonRecursive,
}

/// Whether a relevant change reparses one discovered file or recomposes
/// the provider, including dependencies outside its discovery tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchChangeScope {
    File,
    Provider,
}

/// A provider's on-disk session layout. One trait, one source of truth.
pub trait ProviderLayout: Send + Sync {
    /// Short provider name: "claude", "codex", "opencode", "amplifier",
    /// "antigravity".
    fn name(&self) -> &str;

    /// The root directory (or file, for opencode) containing this provider's
    /// session data. Callers join subdirectories from here.
    /// `home` is the provider-specific home (e.g. `~/.claude`, `~/.codex`).
    fn session_root(&self, home: &Path) -> PathBuf;

    /// Directories (or files) the session watcher should arm inotify on.
    /// For most providers this is the provider home itself; the watcher
    /// watches recursively from there.
    fn watch_bases(&self, home: &Path) -> Vec<PathBuf>;

    /// Whether watcher targets should be watched recursively or not.
    fn watch_mode(&self) -> WatchMode;

    /// Override the mode for providers with both metadata and history roots.
    fn watch_mode_for_base(&self, _home: &Path, _base: &Path) -> WatchMode {
        self.watch_mode()
    }

    /// Ignore unrelated provider state, or select the refresh scope.
    /// Existing providers retain their file-versus-directory behavior.
    fn watch_change_scope(&self, _home: &Path, path: &Path) -> Option<WatchChangeScope> {
        Some(if self.qualifies(path) {
            WatchChangeScope::File
        } else {
            WatchChangeScope::Provider
        })
    }

    /// Does `path` look like a session file for this provider? Used by the
    /// session watcher to filter raw inotify events down to relevant changes.
    /// Does NOT check whether the file exists or is readable — pure path shape.
    fn qualifies(&self, path: &Path) -> bool;

    /// True for providers that enumerate sessions from a single database
    /// (e.g. opencode's SQLite) rather than per-session files. The watcher
    /// watches the database file(s) and marks the whole provider dirty on
    /// any change, rather than tracking individual session paths.
    fn is_direct_listed(&self) -> bool {
        false
    }
}

/// Claude: `<home>/projects/<project>/<session>.jsonl` (top-level sessions)
/// and `<home>/projects/<project>/<session>/subagents/<child>.jsonl` (subagents).
pub struct ClaudeLayout;

impl ProviderLayout for ClaudeLayout {
    fn name(&self) -> &str {
        "claude"
    }

    fn session_root(&self, home: &Path) -> PathBuf {
        home.join("projects")
    }

    fn watch_bases(&self, home: &Path) -> Vec<PathBuf> {
        vec![self.session_root(home)]
    }

    fn watch_mode(&self) -> WatchMode {
        WatchMode::Recursive
    }

    fn qualifies(&self, path: &Path) -> bool {
        // Must be a .jsonl file
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            return false;
        }
        // Two valid shapes:
        // 1. .../<project>/<session>.jsonl — parent is a project dir
        // 2. .../<session>/subagents/<child>.jsonl — parent is "subagents"
        //
        // Reject anything deeper (e.g. .../subagents/deep/child.jsonl).
        let parent = match path.parent() {
            Some(p) => p,
            None => return false,
        };
        let parent_name = parent.file_name().and_then(|n| n.to_str());
        if parent_name == Some("subagents") {
            // Shape: .../subagents/<child>.jsonl — valid subagent
            return true;
        }
        // For the top-level shape, reject if "subagents" appears anywhere
        // in the ancestor chain — that means we're nested too deep inside
        // a subagent tree (e.g. .../subagents/deep/child.jsonl).
        for ancestor in path.ancestors().skip(1) {
            if ancestor.file_name().and_then(|n| n.to_str()) == Some("subagents") {
                return false;
            }
        }
        true
    }
}

/// Codex: `<home>/sessions/**/*.jsonl` — arbitrary nesting depth
/// (`sessions/YYYY/MM/DD/*.jsonl`).
pub struct CodexLayout;

impl ProviderLayout for CodexLayout {
    fn name(&self) -> &str {
        "codex"
    }

    fn session_root(&self, home: &Path) -> PathBuf {
        home.join("sessions")
    }

    fn watch_bases(&self, home: &Path) -> Vec<PathBuf> {
        // Keep the home watch permanently: it catches SQLite inode replacement
        // and late history roots without recursive config/log churn.
        vec![
            home.to_path_buf(),
            self.session_root(home),
            home.join("archived_sessions"),
        ]
    }

    fn watch_mode(&self) -> WatchMode {
        WatchMode::Recursive
    }

    fn watch_mode_for_base(&self, home: &Path, base: &Path) -> WatchMode {
        if base == home {
            WatchMode::NonRecursive
        } else {
            WatchMode::Recursive
        }
    }

    fn watch_change_scope(&self, home: &Path, path: &Path) -> Option<WatchChangeScope> {
        let active = self.session_root(home);
        let archived = home.join("archived_sessions");
        if path == home || path == active || path == archived {
            return Some(WatchChangeScope::Provider);
        }
        if path.starts_with(&active) {
            return if self.qualifies(path) {
                Some(WatchChangeScope::File)
            } else if path.extension().is_none() {
                Some(WatchChangeScope::Provider)
            } else {
                None
            };
        }
        if path.starts_with(&archived) {
            // These files are bounded ancestors, not independently listed rows.
            return (self.qualifies(path) || path.extension().is_none())
                .then_some(WatchChangeScope::Provider);
        }
        if path.parent() == Some(home)
            && matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("state_5.sqlite" | "state_5.sqlite-wal")
            )
        {
            return Some(WatchChangeScope::Provider);
        }
        None
    }

    fn qualifies(&self, path: &Path) -> bool {
        path.extension().and_then(|s| s.to_str()) == Some("jsonl")
    }
}

/// OpenCode: a single `<data_home>/opencode.db` (+ `-wal`). Direct-listed
/// from SQLite, not per-session files. The watcher watches the db + wal
/// files non-recursively and marks the whole provider dirty on any change.
pub struct OpencodeLayout;

impl ProviderLayout for OpencodeLayout {
    fn name(&self) -> &str {
        "opencode"
    }

    fn session_root(&self, data_home: &Path) -> PathBuf {
        data_home.join("opencode.db")
    }

    fn watch_bases(&self, data_home: &Path) -> Vec<PathBuf> {
        // Watch the directory containing opencode.db so we catch both
        // the db file and the WAL file changes.
        vec![data_home.to_path_buf()]
    }

    fn watch_mode(&self) -> WatchMode {
        WatchMode::NonRecursive
    }

    fn qualifies(&self, path: &Path) -> bool {
        // The db file or its WAL companion
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name == "opencode.db" || name == "opencode.db-wal"
    }

    fn is_direct_listed(&self) -> bool {
        true
    }
}

/// Amplifier: `<amplifier_home>/projects/<project>/sessions/<session>/metadata.json`.
/// Only `metadata.json` qualifies — sidecar `events.jsonl`/`transcript.jsonl`
/// changes fall to the directory-event handler which marks amplifier dirty.
pub struct AmplifierLayout;

impl ProviderLayout for AmplifierLayout {
    fn name(&self) -> &str {
        "amplifier"
    }

    fn session_root(&self, amplifier_home: &Path) -> PathBuf {
        amplifier_home.join("projects")
    }

    fn watch_bases(&self, amplifier_home: &Path) -> Vec<PathBuf> {
        vec![self.session_root(amplifier_home)]
    }

    fn watch_mode(&self) -> WatchMode {
        WatchMode::Recursive
    }

    fn qualifies(&self, path: &Path) -> bool {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name != "metadata.json" {
            return false;
        }
        // Must be at: projects/<project>/sessions/<session>/<file>
        // Check that the grandparent is named "sessions"
        let session_dir = match path.parent() {
            Some(p) => p,
            None => return false,
        };
        let sessions_dir = match session_dir.parent() {
            Some(p) => p,
            None => return false,
        };
        sessions_dir.file_name().and_then(|n| n.to_str()) == Some("sessions")
    }
}

/// Antigravity: `<antigravity_home>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
///
/// // Stage-1 candidate contract: the transcript PATH is
/// documented+probe-validated, but only `transcript.jsonl` files with the
/// full ancestor chain are treated as sessions; the record schema inside is
/// fixture-validated only (see `parse/antigravity.rs`).
///
/// `home` here is the ALREADY-RESOLVED antigravity home (the
/// `antigravity-cli` subtree — callers apply [`antigravity_home`] at their
/// wiring seams; the layout must NOT re-apply it or the watcher
/// double-expands to `.../antigravity-cli/.gemini/antigravity-cli/brain`).
/// `cache/last_conversations.json` is deliberately NOT a session source or
/// identity evidence (plan Global Constraint 2): it never qualifies and its
/// churn never dirty-marks the provider.
pub struct AntigravityLayout;

impl ProviderLayout for AntigravityLayout {
    fn name(&self) -> &str {
        "antigravity"
    }

    fn session_root(&self, home: &Path) -> PathBuf {
        home.join("brain")
    }

    fn watch_bases(&self, home: &Path) -> Vec<PathBuf> {
        // TWO bases (the codex home+sessions split): the home itself,
        // NonRecursive, catches a late-created `brain/` root without
        // recursive config/cache churn; `brain` is watched recursively.
        vec![home.to_path_buf(), home.join("brain")]
    }

    fn watch_mode(&self) -> WatchMode {
        WatchMode::Recursive
    }

    fn watch_mode_for_base(&self, home: &Path, base: &Path) -> WatchMode {
        if base == home {
            WatchMode::NonRecursive
        } else {
            WatchMode::Recursive
        }
    }

    fn watch_change_scope(&self, home: &Path, path: &Path) -> Option<WatchChangeScope> {
        // Only a qualifying transcript re-parses one file. Any OTHER
        // change under the brain root — the nested directory cascade a
        // fresh conversation creates before writing its transcript
        // (whole-delta review round 5, Major 2: the inotify cascade miss
        // suppresses the transcript's own file event, so the directory
        // event is the only prompt signal), sidecar files, the root
        // itself — marks the provider dirty. This is the amplifier
        // default discipline (`qualifies ? File : Provider`) bounded to
        // the brain root: a directory event does not itself prove a new
        // transcript — it only triggers the existing dirty/reconcile
        // path, which discovers the file; the watcher's debounce
        // coalesces the cascade exactly as it does file events. A
        // late-created `brain/` root is covered by the watcher's rearm
        // tick AND now by this provider-dirty mark (the codex
        // root-event precedent).
        //
        // Everything OUTSIDE the brain root — cache churn
        // (`cache/last_conversations.json` is never a session source or
        // identity evidence, plan Global Constraint 2) and config
        // writes — is ignored entirely, so unrelated writes never
        // dirty-mark the provider.
        if self.qualifies(path) {
            return Some(WatchChangeScope::File);
        }
        if path.starts_with(self.session_root(home)) {
            return Some(WatchChangeScope::Provider);
        }
        None
    }

    fn qualifies(&self, path: &Path) -> bool {
        // Pure path-shape check (no disk access): a file named
        // `transcript.jsonl` whose ancestor chain is exactly
        // `brain/<conversationId>/.system_generated/logs/`.
        if path.file_name().and_then(|n| n.to_str()) != Some("transcript.jsonl") {
            return false;
        }
        let Some(logs) = path.parent() else {
            return false;
        };
        if logs.file_name().and_then(|n| n.to_str()) != Some("logs") {
            return false;
        }
        let Some(system_generated) = logs.parent() else {
            return false;
        };
        if system_generated.file_name().and_then(|n| n.to_str()) != Some(".system_generated") {
            return false;
        }
        let Some(conversation) = system_generated.parent() else {
            return false;
        };
        // The conversation dir must be a real, non-empty component
        // (`file_name()` is None for a path terminating in `..`).
        let Some(conversation_id) = conversation.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        if conversation_id.is_empty() {
            return false;
        }
        let Some(brain) = conversation.parent() else {
            return false;
        };
        brain.file_name().and_then(|n| n.to_str()) == Some("brain")
    }
}

/// How [`resolve_antigravity_home`] chose the root — the structured
/// announcement's `source` field (round 7, Major 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravityRootSource {
    /// `FRESHELL_ANTIGRAVITY_HOME`, used as-is (never probed).
    EnvOverride,
    /// `<home>/.gemini/antigravity-cli` — the raw binary's store.
    DefaultRoot,
    /// `<home>/snap/antigravity-cli/common/.gemini/antigravity-cli` —
    /// the snap install's store (snap confinement pins the CLI's HOME
    /// to `~/snap/antigravity-cli/common`, so the CLI writes its usual
    /// relative store under it).
    SnapFallback,
}

impl AntigravityRootSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::EnvOverride => "env_override",
            Self::DefaultRoot => "default",
            Self::SnapFallback => "snap_fallback",
        }
    }
}

/// The full resolution decision: the resolved home, how it was chosen,
/// and whether ANY candidate root existed on disk (the absence log's
/// predicate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityHomeResolution {
    pub home: PathBuf,
    pub source: AntigravityRootSource,
    /// Whether the default or the snap root existed on disk at all (an
    /// env override is treated as present: it is never probed).
    pub any_root_present: bool,
}

/// Antigravity home resolution — ONE resolution shared by every wiring
/// seam (the `AntigravitySource::new` home, the `WatchedProvider` home,
/// the ws association's locator root, and the existence
/// `provider_roots`):
///
/// 1. `FRESHELL_ANTIGRAVITY_HOME` (used as-is — the `amplifier_home`
///    precedent, amplifier.rs:57);
/// 2. else `<home>/.gemini/antigravity-cli` — the raw binary's store
///    (NEVER bare `~/.gemini`: that subtree is shared with the
///    maintained Gemini CLI's config, and watching/indexing it would
///    flood provider-dirty marks with unrelated config churn) — chosen
///    when it is the materially-present store, i.e. its `brain/` holds
///    at least one conversation;
/// 3. else the SNAP install's store (round 7, Major 2 — the probed
///    layout, receipts in the plan's Provider Contract Record): snap
///    confinement pins the CLI's `HOME` to
///    `~/snap/antigravity-cli/common`, so a snap-installed `agy` writes
///    the SAME relative store under it —
///    `<home>/snap/antigravity-cli/common/.gemini/antigravity-cli` —
///    chosen when the default root is ABSENT or conversation-less and
///    the snap root holds at least one conversation;
/// 4. else the DEFAULT root (honest empty: the place a non-snap CLI
///    writes; discovery/locator/watcher all point where the next
///    conversation will land).
///
/// A conversation-less but existing default does NOT shadow a
/// conversation-bearing snap root: a raw-binary run creates the default
/// subtree without ever starting a conversation, which must not hide the
/// user's real snap store (the observed dev-machine shape:
/// `~/.gemini/antigravity-cli` exists with an EMPTY `brain/` while every
/// real conversation lives under the snap root). Resolution is decided
/// from disk truth at each call; only the CHOSEN root is watched/indexed
/// (a machine whose two roots BOTH hold conversations follows the
/// default — recorded in the README and the plan's Known limitations).
///
/// Global Constraint 7: the chosen root is announced once per process
/// per resolved path (`antigravity_store_root_resolved`, naming the root
/// and its source), and a machine where NEITHER root exists logs the
/// absence loudly (`antigravity_store_root_missing`) — on such a host
/// every history/locator/existence feature is a silent no-op without
/// that line.
///
/// Applied ONLY at wiring seams — never inside [`AntigravityLayout`].
pub fn antigravity_home(home: &Path) -> PathBuf {
    let resolution = resolve_antigravity_home(home);
    announce_antigravity_root(home, &resolution);
    resolution.home
}

/// The pure resolution (no logging) — the decision core the tests pin.
pub fn resolve_antigravity_home(home: &Path) -> AntigravityHomeResolution {
    if let Ok(v) = std::env::var("FRESHELL_ANTIGRAVITY_HOME") {
        if !v.is_empty() {
            return AntigravityHomeResolution {
                home: PathBuf::from(v),
                source: AntigravityRootSource::EnvOverride,
                any_root_present: true,
            };
        }
    }
    let default_root = home.join(".gemini").join("antigravity-cli");
    let snap_root = snap_antigravity_root(home);
    if root_holds_conversations(&default_root) {
        return AntigravityHomeResolution {
            home: default_root,
            source: AntigravityRootSource::DefaultRoot,
            any_root_present: true,
        };
    }
    if root_holds_conversations(&snap_root) {
        return AntigravityHomeResolution {
            home: snap_root,
            source: AntigravityRootSource::SnapFallback,
            any_root_present: true,
        };
    }
    AntigravityHomeResolution {
        any_root_present: default_root.exists() || snap_root.exists(),
        home: default_root,
        source: AntigravityRootSource::DefaultRoot,
    }
}

/// The snap install's store root under `home`: the snap pins the CLI's
/// HOME to `<home>/snap/antigravity-cli/common`, and the CLI writes its
/// usual `.gemini/antigravity-cli` store under that HOME (probed
/// read-only on the real snap install, 2026-11-01 — see the Provider
/// Contract Record).
fn snap_antigravity_root(home: &Path) -> PathBuf {
    home.join("snap")
        .join("antigravity-cli")
        .join("common")
        .join(".gemini")
        .join("antigravity-cli")
}

/// Whether `root` is the materially-present store: its `brain/` holds
/// at least one readable entry (a conversation directory). A root that
/// exists without conversations is indistinguishable from a never-used
/// subtree and does not shadow the other candidate.
fn root_holds_conversations(root: &Path) -> bool {
    std::fs::read_dir(root.join("brain"))
        .map(|mut entries| entries.next().is_some_and(|entry| entry.is_ok()))
        .unwrap_or(false)
}

/// The once-per-resolved-path announcement lane: every wiring seam calls
/// [`antigravity_home`] at boot, so the lines are deduped per resolved
/// root — one announcement per distinct root per process, never one per
/// seam (bounded: the set holds one path per distinct resolution).
static ANNOUNCED_ANTIGRAVITY_ROOTS: std::sync::OnceLock<std::sync::Mutex<Vec<PathBuf>>> =
    std::sync::OnceLock::new();

fn announce_antigravity_root(home: &Path, resolution: &AntigravityHomeResolution) {
    let announced = ANNOUNCED_ANTIGRAVITY_ROOTS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let Ok(mut announced) = announced.lock() else {
        return;
    };
    if announced.contains(&resolution.home) {
        return; // this root was already announced this process
    }
    announced.push(resolution.home.clone());
    drop(announced);
    if !resolution.any_root_present {
        tracing::warn!(
            target: "freshell_sessions::provider_layout",
            event = "antigravity_store_root_missing",
            root = %resolution.home.display(),
            source = resolution.source.as_str(),
            default_root = %home.join(".gemini").join("antigravity-cli").display(),
            snap_root = %snap_antigravity_root(home).display(),
            "antigravity_store_root_missing: no antigravity store root exists \
             (neither the default nor the snap install's); history, search, \
             identity, and activity will all be empty until the CLI creates \
             its store — set FRESHELL_ANTIGRAVITY_HOME to point at a \
             nonstandard store root"
        );
    }
    tracing::info!(
        target: "freshell_sessions::provider_layout",
        event = "antigravity_store_root_resolved",
        root = %resolution.home.display(),
        source = resolution.source.as_str(),
        "antigravity_store_root_resolved: the antigravity store root every \
         seam (history source, watcher, locator, existence) reads"
    );
}

/// All five provider layouts. Convenience for callers that need to iterate
/// all providers (e.g. the session watcher, the ledger GC).
pub fn all_layouts() -> Vec<Box<dyn ProviderLayout>> {
    vec![
        Box::new(ClaudeLayout),
        Box::new(CodexLayout),
        Box::new(OpencodeLayout),
        Box::new(AmplifierLayout),
        Box::new(AntigravityLayout),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn claude_layout_session_root_joins_projects() {
        let layout = ClaudeLayout;
        let root = layout.session_root(Path::new("/home/user/.claude"));
        assert_eq!(root, Path::new("/home/user/.claude/projects"));
    }

    #[test]
    fn claude_layout_qualifies_top_level_jsonl() {
        let layout = ClaudeLayout;
        // Top-level .jsonl inside a project dir: qualifies
        assert!(layout.qualifies(Path::new(
            "/home/user/.claude/projects/myproj/abc-123.jsonl"
        )));
    }

    #[test]
    fn claude_layout_qualifies_subagent_jsonl() {
        let layout = ClaudeLayout;
        // Subagent .jsonl: qualifies
        assert!(layout.qualifies(Path::new(
            "/home/user/.claude/projects/myproj/abc-123/subagents/child.jsonl"
        )));
    }

    #[test]
    fn claude_layout_rejects_non_jsonl() {
        let layout = ClaudeLayout;
        assert!(!layout.qualifies(Path::new("/home/user/.claude/projects/myproj/abc-123.json")));
    }

    #[test]
    fn claude_layout_rejects_deeply_nested_jsonl() {
        let layout = ClaudeLayout;
        // Too deep — not a session file
        assert!(!layout.qualifies(Path::new(
            "/home/user/.claude/projects/myproj/abc/subagents/deep/child.jsonl"
        )));
    }

    #[test]
    fn claude_layout_watch_bases_returns_session_root() {
        let layout = ClaudeLayout;
        let bases = layout.watch_bases(Path::new("/home/user/.claude"));
        assert_eq!(bases, vec![Path::new("/home/user/.claude/projects")]);
    }

    #[test]
    fn claude_layout_is_not_direct_listed() {
        assert!(!ClaudeLayout.is_direct_listed());
    }

    #[test]
    fn codex_layout_session_root_joins_sessions() {
        let root = CodexLayout.session_root(Path::new("/home/user/.codex"));
        assert_eq!(root, Path::new("/home/user/.codex/sessions"));
    }

    #[test]
    fn codex_layout_qualifies_any_depth_jsonl() {
        assert!(CodexLayout.qualifies(Path::new(
            "/home/user/.codex/sessions/2026/08/16/rollout.jsonl"
        )));
        assert!(CodexLayout.qualifies(Path::new("/home/user/.codex/sessions/flat.jsonl")));
    }

    #[test]
    fn codex_layout_rejects_non_jsonl() {
        assert!(!CodexLayout.qualifies(Path::new("/home/user/.codex/sessions/data.json")));
    }

    #[test]
    fn codex_layout_is_not_direct_listed() {
        assert!(!CodexLayout.is_direct_listed());
    }

    #[test]
    fn opencode_layout_is_direct_listed() {
        assert!(OpencodeLayout.is_direct_listed());
    }

    #[test]
    fn opencode_layout_qualifies_db_and_wal() {
        assert!(OpencodeLayout.qualifies(Path::new("/data/opencode.db")));
        assert!(OpencodeLayout.qualifies(Path::new("/data/opencode.db-wal")));
        assert!(!OpencodeLayout.qualifies(Path::new("/data/other.db")));
    }

    #[test]
    fn opencode_layout_watch_mode_is_non_recursive() {
        assert_eq!(OpencodeLayout.watch_mode(), WatchMode::NonRecursive);
    }

    #[test]
    fn amplifier_layout_qualifies_canonical_metadata() {
        assert!(AmplifierLayout.qualifies(Path::new(
            "/home/user/.amplifier/projects/myproj/sessions/abc-123/metadata.json"
        )));
    }

    #[test]
    fn amplifier_layout_rejects_nested_metadata() {
        // Sidecar metadata (e.g. context-intelligence/metadata.json) should not qualify
        assert!(!AmplifierLayout.qualifies(Path::new(
            "/home/user/.amplifier/projects/myproj/sessions/abc/context-intelligence/metadata.json"
        )));
    }

    #[test]
    fn amplifier_layout_rejects_events_jsonl() {
        assert!(!AmplifierLayout.qualifies(Path::new(
            "/home/user/.amplifier/projects/myproj/sessions/abc/events.jsonl"
        )));
    }

    #[test]
    fn amplifier_layout_rejects_transcript_jsonl() {
        assert!(!AmplifierLayout.qualifies(Path::new(
            "/home/user/.amplifier/projects/myproj/sessions/abc/transcript.jsonl"
        )));
    }

    #[test]
    fn amplifier_layout_is_not_direct_listed() {
        assert!(!AmplifierLayout.is_direct_listed());
    }

    // ── Cross-check: layout roots match existing discover functions ──

    #[test]
    fn claude_layout_root_matches_discover_claude_home_join() {
        // Cross-check: ClaudeLayout.session_root must produce the same
        // path that discover_claude_home hardcodes.
        let home = Path::new("/home/user/.claude");
        let layout_root = ClaudeLayout.session_root(home);
        let hardcoded_root = home.join("projects");
        assert_eq!(layout_root, hardcoded_root);
    }

    #[test]
    fn codex_layout_root_matches_discover_codex_sessions_join() {
        let home = Path::new("/home/user/.codex");
        let layout_root = CodexLayout.session_root(home);
        let hardcoded_root = home.join("sessions");
        assert_eq!(layout_root, hardcoded_root);
    }

    #[test]
    fn amplifier_layout_root_matches_discover_amplifier_join() {
        let home = Path::new("/home/user/.amplifier");
        let layout_root = AmplifierLayout.session_root(home);
        let hardcoded_root = home.join("projects");
        assert_eq!(layout_root, hardcoded_root);
    }

    #[test]
    fn codex_watch_modes_and_change_scopes_keep_active_rows_separate_from_references() {
        let layout = CodexLayout;
        let home = Path::new("/home/user/.codex");
        let bases = layout.watch_bases(home);
        assert_eq!(
            bases,
            vec![
                home.to_path_buf(),
                home.join("sessions"),
                home.join("archived_sessions")
            ]
        );
        assert_eq!(
            layout.watch_mode_for_base(home, &bases[0]),
            WatchMode::NonRecursive
        );
        assert_eq!(
            layout.watch_mode_for_base(home, &bases[1]),
            WatchMode::Recursive
        );
        assert_eq!(
            layout.watch_mode_for_base(home, &bases[2]),
            WatchMode::Recursive
        );
        for path in [
            home.to_path_buf(),
            home.join("sessions"),
            home.join("sessions/2026/10"),
            home.join("archived_sessions"),
            home.join("archived_sessions/rollout.jsonl"),
            home.join("state_5.sqlite"),
            home.join("state_5.sqlite-wal"),
        ] {
            assert_eq!(
                layout.watch_change_scope(home, &path),
                Some(WatchChangeScope::Provider),
                "provider dependency {path:?}"
            );
        }
        assert_eq!(
            layout.watch_change_scope(home, &home.join("sessions/2026/10/rollout.jsonl")),
            Some(WatchChangeScope::File)
        );
        for path in [
            home.join("config.toml"),
            home.join("log/codex-tui.log"),
            home.join("history.jsonl"),
            home.join("auth.json"),
            home.join("unrelated.sqlite"),
        ] {
            assert_eq!(
                layout.watch_change_scope(home, &path),
                None,
                "unrelated Codex state {path:?}"
            );
        }
    }

    #[test]
    fn provider_watch_scope_defaults_preserve_existing_providers() {
        let home = Path::new("/home/user/.claude");
        let claude = ClaudeLayout;
        assert_eq!(
            claude.watch_mode_for_base(home, &home.join("projects")),
            claude.watch_mode()
        );
        assert_eq!(
            claude.watch_change_scope(home, &home.join("projects/project/session.jsonl")),
            Some(WatchChangeScope::File)
        );
        assert_eq!(
            claude.watch_change_scope(home, &home.join("projects/project")),
            Some(WatchChangeScope::Provider)
        );
        let opencode = OpencodeLayout;
        assert_eq!(
            opencode.watch_mode_for_base(home, home),
            opencode.watch_mode()
        );
        assert_eq!(
            opencode.watch_change_scope(home, &home.join("opencode.db-wal")),
            Some(WatchChangeScope::File)
        );
    }

    // ── Antigravity: brain/<conversationId>/.system_generated/logs/ ──

    const ANTIGRAVITY_HOME: &str = "/home/user/.gemini/antigravity-cli";

    fn antigravity_transcript(id: &str) -> std::path::PathBuf {
        Path::new(ANTIGRAVITY_HOME)
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl")
    }

    #[test]
    fn antigravity_layout_name_is_antigravity() {
        assert_eq!(AntigravityLayout.name(), "antigravity");
        assert!(!AntigravityLayout.is_direct_listed());
    }

    #[test]
    fn antigravity_layout_session_root_joins_brain() {
        // `home` is the ALREADY-RESOLVED antigravity home (the
        // `antigravity-cli` subtree, never bare `~/.gemini`); the layout must
        // NOT re-apply `antigravity_home()` or the watcher double-expands to
        // `.../antigravity-cli/.gemini/antigravity-cli/brain`.
        let root = AntigravityLayout.session_root(Path::new(ANTIGRAVITY_HOME));
        assert_eq!(root, Path::new("/home/user/.gemini/antigravity-cli/brain"));
    }

    #[test]
    fn antigravity_layout_qualifies_canonical_transcript_chain() {
        assert!(AntigravityLayout.qualifies(&antigravity_transcript(
            "11111111-2222-3333-4444-555555555555"
        )));
    }

    #[test]
    fn antigravity_layout_rejects_non_transcript_shapes() {
        let home = Path::new(ANTIGRAVITY_HOME);
        // Not a transcript.jsonl at all.
        assert!(!AntigravityLayout.qualifies(&home.join("cache/last_conversations.json")));
        assert!(!AntigravityLayout.qualifies(&home.join("brain/conv-1/notes.md")));
        // transcript.jsonl at the wrong depth in the chain.
        assert!(!AntigravityLayout.qualifies(&home.join("brain/conv-1/transcript.jsonl")));
        assert!(!AntigravityLayout.qualifies(&home.join("brain/transcript.jsonl")));
        assert!(!AntigravityLayout
            .qualifies(&home.join("brain/conv-1/.system_generated/transcript.jsonl")));
        assert!(!AntigravityLayout.qualifies(&home.join("brain/conv-1/logs/transcript.jsonl")));
        // Deeper than logs/ (a sidecar under a nested dir).
        assert!(!AntigravityLayout
            .qualifies(&home.join("brain/conv-1/.system_generated/logs/sub/transcript.jsonl")));
    }

    #[test]
    fn antigravity_layout_watch_bases_split_home_and_brain_with_per_base_modes() {
        let layout = AntigravityLayout;
        let home = Path::new(ANTIGRAVITY_HOME);
        let bases = layout.watch_bases(home);
        // TWO bases: the home (NonRecursive — catches a late-created
        // `brain/` root without config/cache churn) and `brain` (Recursive).
        assert_eq!(bases, vec![home.to_path_buf(), home.join("brain")]);
        assert_eq!(
            layout.watch_mode_for_base(home, &bases[0]),
            WatchMode::NonRecursive
        );
        assert_eq!(
            layout.watch_mode_for_base(home, &bases[1]),
            WatchMode::Recursive
        );
    }

    #[test]
    fn antigravity_layout_watch_change_scope_bounds_provider_dirty_to_the_brain_root() {
        let layout = AntigravityLayout;
        let home = Path::new(ANTIGRAVITY_HOME);
        // Qualifying transcript: re-parse exactly one file.
        assert_eq!(
            layout.watch_change_scope(home, &antigravity_transcript("conv-1")),
            Some(WatchChangeScope::File)
        );
        // Any OTHER change under the brain root — the directory cascade a
        // fresh conversation creates before writing its transcript
        // (whole-delta review round 5, Major 2: the inotify cascade miss
        // suppresses the transcript's own file event, so the directory
        // event is the only prompt signal), sidecar files, the root
        // itself — marks the provider dirty (the amplifier default
        // discipline, bounded to the brain root: a directory event only
        // triggers the existing dirty/reconcile path that discovers the
        // file; the watcher's debounce coalesces the cascade).
        for path in [
            home.join("brain"),
            home.join("brain/conv-1"),
            home.join("brain/conv-1/.system_generated"),
            home.join("brain/conv-1/.system_generated/logs"),
            home.join("brain/conv-1/notes.md"),
            home.join("brain/conv-1/transcript.jsonl"),
        ] {
            assert_eq!(
                layout.watch_change_scope(home, &path),
                Some(WatchChangeScope::Provider),
                "brain-root descendant {path:?} must provider-dirty the index"
            );
        }
        // Everything OUTSIDE the brain root — cache churn
        // (`cache/last_conversations.json` is never a session source or
        // identity evidence), config writes — is ignored ENTIRELY, so
        // unrelated writes never dirty-mark the provider.
        for path in [
            home.join("cache/last_conversations.json"),
            home.join("cache/last_conversations.json.tmp"),
            home.join("config/settings.json"),
        ] {
            assert_eq!(
                layout.watch_change_scope(home, &path),
                None,
                "unrelated antigravity state {path:?}"
            );
        }
    }

    #[test]
    fn antigravity_home_env_override_wins_and_default_is_antigravity_cli_subtree() {
        // Mutates process env: serialize on the crate-wide
        // HOME_ENV_TEST_LOCK (the `parse::opencode` home_dir tests and the
        // directory_index persist-path test share it). The save/restore
        // runs through a DROP GUARD (the `parse::opencode`
        // `home_dir_tests::EnvVarGuard` model): a mid-test panic can never
        // leak `FRESHELL_ANTIGRAVITY_HOME` into the rest of the test
        // binary, where it would cross-contaminate every later test that
        // resolves an antigravity home (the Task-5 source tests included).
        let _lock = crate::HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _guard = EnvVarGuard::set("FRESHELL_ANTIGRAVITY_HOME", "/custom/antigravity-home");

        // Env override is used AS-IS (the `amplifier_home` precedent).
        assert_eq!(
            antigravity_home(Path::new("/home/user")),
            Path::new("/custom/antigravity-home")
        );

        // Default: the `antigravity-cli` subtree of `~/.gemini` — NEVER bare
        // `~/.gemini`, which is shared with the maintained Gemini CLI config.
        std::env::remove_var("FRESHELL_ANTIGRAVITY_HOME");
        assert_eq!(
            antigravity_home(Path::new("/home/user")),
            Path::new("/home/user/.gemini/antigravity-cli")
        );
        // `_guard`'s Drop restores the saved value on scope exit, panic
        // included.
    }

    /// Save-and-restore guard for one env var; restores on drop, panic
    /// included (same shape as `parse::opencode`'s `home_dir_tests::EnvVarGuard`
    /// — kept local to this module's tests rather than hoisted, matching
    /// the crate's existing per-module test-guard precedent).
    struct EnvVarGuard {
        name: &'static str,
        saved: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(name: &'static str, value: &str) -> Self {
            let saved = std::env::var_os(name);
            std::env::set_var(name, value);
            Self { name, saved }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.saved.take() {
                Some(v) => std::env::set_var(self.name, v),
                None => std::env::remove_var(self.name),
            }
        }
    }
}

// Round 7, Major 2 (whole-delta review): the antigravity home-resolution
// tests live in a `#[path]`-included sibling child (the
// `codex_locator_tests_warn.rs` convention) — this file sits against the
// 1K-line cap. The include sits at the TOP level (the codex precedent):
// inside the inline `mod tests`, a `#[path]` child would resolve against
// the nonexistent `src/provider_layout/tests/` base.
#[cfg(test)]
#[path = "provider_layout_antigravity_home_tests.rs"]
mod antigravity_home_tests;
