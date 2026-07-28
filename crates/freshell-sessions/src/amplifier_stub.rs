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

use std::path::PathBuf;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
