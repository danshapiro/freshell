//! Pure logic port of `server/auto-title.ts` (decision functions),
//! `shared/path-basename.ts::basenameSegment`, and
//! `shared/title-source.ts::isFinalizedTitleSource`.
//! No IO. See docs/plans/2026-08-08-naming-persistence-sweep.md Task 1.

/// `shared/title-source.ts:37` — `!!src && src !== 'dir'`.
pub fn is_finalized_title_source(src: Option<&str>) -> bool {
    matches!(src, Some(s) if !s.is_empty() && s != "dir")
}

/// `shared/path-basename.ts:9-22`.
pub fn basename_segment(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return if path.starts_with('/') {
            Some("/".to_string())
        } else {
            None
        };
    }
    let b = trimmed.as_bytes();
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Some(format!("{}\\", trimmed));
    }
    let last = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
    if last.is_empty() {
        None
    } else {
        Some(last.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoTitlePatch {
    pub title_override: String,
    pub title_source: &'static str,
}

/// `server/auto-title.ts:24-46`. `existing_title_override`/`existing_title_source`
/// are the current sessionOverrides row fields (None when absent).
pub fn compute_auto_title_patch(
    cwd: Option<&str>,
    first_user_message: Option<&str>,
    existing_title_override: Option<&str>,
    existing_title_source: Option<&str>,
    ai_will_auto_name: bool,
) -> Option<AutoTitlePatch> {
    if is_finalized_title_source(existing_title_source) {
        return None;
    }
    let first_nonempty = first_user_message
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    if first_nonempty && !ai_will_auto_name {
        // NOTE: pass the RAW message (extract trims internally) — auto-title.ts:36.
        let title = freshell_sessions::text::extract_title_from_message(
            first_user_message.unwrap_or(""),
            50,
        );
        if !title.is_empty() {
            return Some(AutoTitlePatch {
                title_override: title,
                title_source: "first-message",
            });
        }
    }
    let has_override = existing_title_override.is_some_and(|s| !s.is_empty());
    if !has_override {
        if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
            if let Some(segment) = basename_segment(cwd) {
                return Some(AutoTitlePatch {
                    title_override: segment,
                    title_source: "dir",
                });
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct SessionTerminal {
    pub terminal_id: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TitleSyncPlan {
    pub override_patch: Option<AutoTitlePatch>,
    pub canonical_title: Option<String>,
    pub terminal_ids_to_update: Vec<String>,
    pub should_generate_ai: bool,
}

/// `server/auto-title.ts:61-91`. `session_title` must already be the
/// override-applied session title (i.e. what `/api/session-directory` serves).
#[allow(clippy::too_many_arguments)]
pub fn compute_session_title_sync(
    session_title: Option<&str>,
    override_title: Option<&str>,
    override_source: Option<&str>,
    cwd: Option<&str>,
    first_user_message: Option<&str>,
    ai_will_auto_name: bool,
    parsed_title_source: Option<&str>,
    terminals: &[SessionTerminal],
) -> TitleSyncPlan {
    let override_patch = compute_auto_title_patch(
        cwd,
        first_user_message,
        override_title,
        override_source,
        ai_will_auto_name,
    );
    // JS `??` then truthiness: empty string collapses to "no canonical title".
    let canonical_title: Option<String> = override_patch
        .as_ref()
        .map(|p| p.title_override.clone())
        .or_else(|| session_title.map(str::to_string))
        .filter(|t| !t.is_empty());
    let terminal_ids_to_update = match &canonical_title {
        Some(canon) => terminals
            .iter()
            .filter(|t| t.title.as_deref() != Some(canon.as_str()))
            .map(|t| t.terminal_id.clone())
            .collect(),
        None => Vec::new(),
    };
    let should_generate_ai = ai_will_auto_name
        && first_user_message
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
        && !is_finalized_title_source(override_source)
        && parsed_title_source != Some("provider-generated");
    TitleSyncPlan {
        override_patch,
        canonical_title,
        terminal_ids_to_update,
        should_generate_ai,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- basename_segment (shared/path-basename.ts:9-22) ---
    #[test]
    fn basename_segment_plain_unix_path() {
        assert_eq!(
            basename_segment("/home/dan/code/freshell").as_deref(),
            Some("freshell")
        );
    }
    #[test]
    fn basename_segment_strips_trailing_slashes_both_kinds() {
        assert_eq!(basename_segment("/a/b///").as_deref(), Some("b"));
        assert_eq!(basename_segment("C:\\repo\\x\\\\").as_deref(), Some("x"));
    }
    #[test]
    fn basename_segment_unix_root_is_slash() {
        assert_eq!(basename_segment("/").as_deref(), Some("/"));
    }
    #[test]
    fn basename_segment_windows_drive_root_gets_backslash() {
        assert_eq!(basename_segment("C:").as_deref(), Some("C:\\"));
        assert_eq!(basename_segment("C:/").as_deref(), Some("C:\\"));
        assert_eq!(basename_segment("C:\\").as_deref(), Some("C:\\"));
    }
    #[test]
    fn basename_segment_empty_is_none() {
        assert_eq!(basename_segment(""), None);
    }

    // --- is_finalized_title_source (shared/title-source.ts:37) ---
    #[test]
    fn finalized_is_any_nonempty_source_except_dir() {
        assert!(!is_finalized_title_source(None));
        assert!(!is_finalized_title_source(Some("")));
        assert!(!is_finalized_title_source(Some("dir")));
        for s in ["user", "ai", "first-message", "legacy"] {
            assert!(is_finalized_title_source(Some(s)), "{s} must be finalized");
        }
    }

    // --- compute_auto_title_patch (server/auto-title.ts:24-46) ---
    #[test]
    fn finalized_existing_source_returns_none() {
        let p = compute_auto_title_patch(
            Some("/x/y"),
            Some("hello"),
            Some("Old"),
            Some("user"),
            false,
        );
        assert!(p.is_none());
    }
    #[test]
    fn first_message_wins_when_ai_off_even_over_existing_dir_placeholder() {
        let p = compute_auto_title_patch(
            Some("/x/y"),
            Some("Fix the flux capacitor\nmore"),
            Some("y"),
            Some("dir"),
            false,
        )
        .expect("patch");
        assert_eq!(p.title_override, "Fix the flux capacitor");
        assert_eq!(p.title_source, "first-message");
    }
    #[test]
    fn ai_on_holds_dir_placeholder_and_never_writes_first_message() {
        // aiWillAutoName=true: step 2 is skipped entirely (auto-title.ts:35).
        let p = compute_auto_title_patch(Some("/x/proj"), Some("Fix stuff"), None, None, true)
            .expect("patch");
        assert_eq!(p.title_override, "proj");
        assert_eq!(p.title_source, "dir");
        // and with a dir placeholder already present -> nothing to do
        let p2 = compute_auto_title_patch(
            Some("/x/proj"),
            Some("Fix stuff"),
            Some("proj"),
            Some("dir"),
            true,
        );
        assert!(p2.is_none());
    }
    #[test]
    fn dir_seed_requires_no_existing_override_string() {
        // auto-title.ts:40 checks existing?.titleOverride (the string), not the source.
        let p = compute_auto_title_patch(Some("/x/proj"), None, Some("anything"), None, false);
        assert!(p.is_none());
        let p2 = compute_auto_title_patch(Some("/x/proj"), None, None, None, false).expect("patch");
        assert_eq!(p2.title_override, "proj");
        assert_eq!(p2.title_source, "dir");
    }
    #[test]
    fn heuristic_title_is_capped_at_50() {
        let long = "a".repeat(80);
        let p = compute_auto_title_patch(None, Some(&long), None, None, false).expect("patch");
        assert_eq!(p.title_override.chars().count(), 50);
    }

    // --- compute_session_title_sync (server/auto-title.ts:61-91) ---
    fn term(id: &str, title: Option<&str>) -> SessionTerminal {
        SessionTerminal {
            terminal_id: id.to_string(),
            title: title.map(str::to_string),
        }
    }
    #[test]
    fn canonical_title_prefers_patch_then_session_title() {
        let plan = compute_session_title_sync(
            Some("Persisted"),
            Some("Persisted"),
            Some("user"),
            Some("/x/y"),
            Some("hi"),
            false,
            None,
            &[term("t1", Some("stale")), term("t2", Some("Persisted"))],
        );
        assert!(plan.override_patch.is_none()); // user is finalized
        assert_eq!(plan.canonical_title.as_deref(), Some("Persisted"));
        assert_eq!(plan.terminal_ids_to_update, vec!["t1".to_string()]);
        assert!(!plan.should_generate_ai);
    }
    #[test]
    fn should_generate_ai_requires_all_four_conditions() {
        // aiWillAutoName && first non-empty && !finalized && parsed != provider-generated
        let base = |ai: bool, first: Option<&str>, src: Option<&str>, parsed: Option<&str>| {
            compute_session_title_sync(None, None, src, Some("/x/y"), first, ai, parsed, &[])
                .should_generate_ai
        };
        assert!(base(true, Some("hi"), None, None));
        assert!(base(true, Some("hi"), Some("dir"), None));
        assert!(!base(false, Some("hi"), None, None));
        assert!(!base(true, None, None, None));
        assert!(!base(true, Some("   "), None, None));
        assert!(!base(true, Some("hi"), Some("first-message"), None));
        assert!(!base(true, Some("hi"), None, Some("provider-generated")));
    }
    #[test]
    fn no_canonical_title_means_no_terminal_pushes() {
        let plan = compute_session_title_sync(
            None,
            None,
            None,
            None,
            None,
            false,
            None,
            &[term("t1", Some("x"))],
        );
        assert!(plan.canonical_title.is_none());
        assert!(plan.terminal_ids_to_update.is_empty());
    }
    #[test]
    fn empty_session_title_is_treated_as_absent() {
        // JS: `canonicalTitle ? ... : []` — empty string is falsy.
        let plan = compute_session_title_sync(
            Some(""),
            None,
            None,
            None,
            None,
            false,
            None,
            &[term("t1", Some("x"))],
        );
        assert!(plan.terminal_ids_to_update.is_empty());
    }
}
