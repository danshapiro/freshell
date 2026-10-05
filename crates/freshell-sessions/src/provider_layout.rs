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
    /// Short provider name: "claude", "codex", "opencode", "amplifier".
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

/// All four provider layouts. Convenience for callers that need to iterate
/// all providers (e.g. the session watcher, the ledger GC).
pub fn all_layouts() -> Vec<Box<dyn ProviderLayout>> {
    vec![
        Box::new(ClaudeLayout),
        Box::new(CodexLayout),
        Box::new(OpencodeLayout),
        Box::new(AmplifierLayout),
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
}
