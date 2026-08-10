//! One-time boot migrations ported from Node's `startBackgroundTasks()`
//! (`server/index.ts:1039-1054`). Exactly one exists today:
//! `ai-title-shadow-cleanup`. Marker I/O lives on `SettingsStore`
//! (`is_migration_done` / `mark_migration_done`) because the config path and
//! `ConfigLock` are private to `settings_store.rs`.

use serde_json::Value;

/// Node's authoritative-title provider set: providers whose sessions always
/// carry their own AI-generated title. Derived in Node from
/// `providesAuthoritativeTitle()` -- amplifier is the ONLY implementer
/// (`server/coding-cli/providers/amplifier.ts:319-323`); Claude is NOT in
/// the set. Hardcoded: one implementer on both sides, a capability trait
/// would be speculative generality.
pub const AUTHORITATIVE_TITLE_PROVIDERS: [&str; 1] = ["amplifier"];

/// The migration id / `completedMigrations` marker string.
pub const AI_TITLE_SHADOW_CLEANUP: &str = "ai-title-shadow-cleanup";

/// Port of `overrideKeysToClear`
/// (`server/coding-cli/provider-title-cleanup.ts:17-30`). A key qualifies
/// when ALL hold: its provider (parsed from the composite key; a key with no
/// ':' is legacy provider "claude", `types.ts:122-131`, never authoritative)
/// is in `authoritative`; the row carries a truthy `titleOverride` (absent /
/// null / "" all disqualify -- JS truthiness); and `titleSource != "user"`
/// (absent titleSource ALSO qualifies). Explicit user renames are always
/// preserved.
pub fn override_keys_to_clear(
    session_overrides: &serde_json::Map<String, Value>,
    authoritative: &[&str],
) -> Vec<String> {
    let mut keys = Vec::new();
    for (key, row) in session_overrides {
        let provider = match key.split_once(':') {
            Some((p, _)) => p,
            None => "claude",
        };
        if !authoritative.contains(&provider) {
            continue;
        }
        let has_title = row
            .get("titleOverride")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
        if !has_title {
            continue;
        }
        if row.get("titleSource").and_then(Value::as_str) == Some("user") {
            continue;
        }
        keys.push(key.clone());
    }
    keys
}

use crate::settings_store::SettingsStore;

/// Port of the one-time `ai-title-shadow-cleanup` migration
/// (`server/index.ts:1039-1054`): drop auto-written (non-user) title
/// overrides that shadow an authoritative provider-generated title (e.g.
/// Amplifier's own AI name). Guard -> compute -> clear -> flush -> mark, in
/// Node's order; the marker is written even when nothing qualified, so a
/// clean home never re-scans. Error model matches Node too: a failed
/// override write in Node THROWS and the chain's `.catch` aborts BEFORE
/// `markMigrationDone` (retry next boot) -- here, clears that cannot be
/// flushed to disk leave the migration unmarked (see below). Node's
/// trailing `codingCliIndexer.refresh()` deliberately has NO analogue here:
/// the Rust session index is poll-based and `session_overrides()`
/// freshness-reloads (`maybe_reload_overrides`), so the next sweep tick
/// already sees the cleared rows.
pub async fn run_ai_title_shadow_cleanup(settings: &SettingsStore) {
    if settings.is_migration_done(AI_TITLE_SHADOW_CLEANUP) {
        return;
    }
    let overrides = settings.session_overrides();
    let keys = override_keys_to_clear(&overrides, &AUTHORITATIVE_TITLE_PROVIDERS);
    for key in &keys {
        settings
            .patch_session_override(key, &[("titleOverride", None), ("titleSource", None)])
            .await;
    }
    if !keys.is_empty() {
        // `patch_session_override` swallows persist errors (best-effort,
        // settings_store.rs:758-767): a marker-gated one-shot must not
        // record completion on unknown persistence state. Re-flush and
        // abort unmarked on failure, mirroring Node's abort-before-marker.
        if let Err(err) = settings.flush_to_disk().await {
            tracing::warn!(
                event = "ai_title_shadow_cleanup_flush_failed",
                error = %err,
                "clears not persisted; leaving migration unmarked to retry next boot"
            );
            return;
        }
    }
    if let Err(err) = settings.mark_migration_done(AI_TITLE_SHADOW_CLEANUP) {
        tracing::warn!(
            event = "ai_title_shadow_cleanup_mark_failed",
            error = %err,
            "failed to persist the ai-title-shadow-cleanup marker"
        );
    }
    if !keys.is_empty() {
        tracing::info!(
            event = "ai_title_shadow_cleanup",
            cleared = keys.len(),
            "one-time stale AI-title cleanup complete"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn overrides(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    // Ports of test/unit/server/coding-cli/provider-title-cleanup.test.ts
    // (4 cases) plus the two edge cases Node's parser implies.

    #[test]
    fn clears_authoritative_auto_written_titles() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert_eq!(
            override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS),
            vec!["amplifier:a1".to_string()]
        );
    }

    #[test]
    fn skips_non_authoritative_provider() {
        let ov = overrides(json!({
            "claude:c1": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn skips_user_renames() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Mine", "titleSource": "user" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn skips_rows_without_title_override() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleSource": "ai" },
            "amplifier:a2": { "titleOverride": "", "titleSource": "ai" },
            "amplifier:a3": { "titleOverride": null, "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn absent_title_source_still_qualifies() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Auto" }
        }));
        assert_eq!(
            override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS),
            vec!["amplifier:a1".to_string()]
        );
    }

    #[test]
    fn legacy_unprefixed_key_parses_as_claude_and_is_skipped() {
        let ov = overrides(json!({
            "legacykey": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    use crate::settings_store::SettingsStore;

    /// Seeds a real config.json. `completed: None` = no marker key at all --
    /// NOTE the settings_store lossless fixture already seeds the marker
    /// (settings_store.rs:2511-2530), which would make a load-time migration
    /// pass accidentally; these tests therefore always build their own
    /// marker-free fixtures.
    fn seed_config(dir: &std::path::Path, session_overrides: Value, completed: Option<Value>) {
        let mut doc = json!({
            "version": 1,
            "settings": { "codingCli": {
                "enabledProviders": ["claude", "codex"],
                "knownProviders": ["claude", "codex"],
                "providers": {},
                "mcpServer": true
            } },
            "recentDirectories": ["/a", "/b"],
            "zzFutureKey": { "a": 1 },
            "sessionOverrides": session_overrides,
            "terminalOverrides": {},
            "projectColors": {}
        });
        if let Some(c) = completed {
            doc["completedMigrations"] = c;
        }
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        std::fs::write(
            dir.join(".freshell").join("config.json"),
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .unwrap();
    }

    fn store_at(dir: &std::path::Path) -> SettingsStore {
        SettingsStore::load(Some(dir), vec!["claude".into(), "codex".into()])
    }

    fn read_config(dir: &std::path::Path) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap()
    }

    // Mirrors test/unit/server/config-store.test.ts:975-997.
    #[test]
    fn migration_marker_roundtrip_is_idempotent_and_reload_visible() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(dir, json!({}), None);
        let store = store_at(dir);
        assert!(!store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
        store.mark_migration_done(AI_TITLE_SHADOW_CLEANUP).unwrap();
        store.mark_migration_done(AI_TITLE_SHADOW_CLEANUP).unwrap();
        assert!(store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
        assert_eq!(
            read_config(dir)["completedMigrations"],
            json!([AI_TITLE_SHADOW_CLEANUP]),
            "append-only, no duplicates"
        );
        let reloaded = store_at(dir);
        assert!(reloaded.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
    }

    #[test]
    fn mark_migration_done_preserves_unmanaged_document_state() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(dir, json!({}), None);
        let store = store_at(dir);
        store.mark_migration_done(AI_TITLE_SHADOW_CLEANUP).unwrap();
        let cfg = read_config(dir);
        assert_eq!(cfg["recentDirectories"], json!(["/a", "/b"]));
        assert_eq!(cfg["zzFutureKey"], json!({ "a": 1 }));
        assert_eq!(cfg["completedMigrations"], json!([AI_TITLE_SHADOW_CLEANUP]));
    }

    #[tokio::test]
    async fn cleanup_clears_amplifier_shadow_titles_and_marks_done() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(
            dir,
            json!({
                "amplifier:a1": { "titleOverride": "Auto Name", "titleSource": "ai",
                                   "summaryOverride": "keep me", "archived": true },
                "amplifier:a2": { "titleOverride": "Mine", "titleSource": "user" },
                "amplifier:a3": { "titleOverride": "No Source" },
                "claude:c1":    { "titleOverride": "Auto", "titleSource": "ai" },
                "legacykey":    { "titleOverride": "Legacy", "titleSource": "ai" }
            }),
            None,
        );
        let store = store_at(dir);

        run_ai_title_shadow_cleanup(&store).await;

        let ov = store.session_overrides();
        let a1 = ov.get("amplifier:a1").unwrap();
        // titleSource "ai" is ladder-FINALIZED: the (None, None) clear must
        // bypass the can_upgrade_title gate, exactly like Node's
        // {undefined, undefined} patch (config-store.ts:502-507).
        assert!(a1.get("titleOverride").is_none(), "{a1:?}");
        assert!(a1.get("titleSource").is_none(), "{a1:?}");
        // Non-title fields on the row survive (Node: {...existing, ...patch}).
        assert_eq!(a1["summaryOverride"], json!("keep me"));
        assert_eq!(a1["archived"], json!(true));
        // Absent titleSource also qualifies.
        let a3 = ov.get("amplifier:a3").unwrap();
        assert!(a3.get("titleOverride").is_none(), "{a3:?}");
        // Untouched: user rename, non-authoritative provider, legacy key.
        assert_eq!(
            ov.get("amplifier:a2").unwrap()["titleOverride"],
            json!("Mine")
        );
        assert_eq!(ov.get("claude:c1").unwrap()["titleOverride"], json!("Auto"));
        assert_eq!(
            ov.get("legacykey").unwrap()["titleOverride"],
            json!("Legacy")
        );

        // Marker persisted; unmanaged keys preserved on disk.
        let cfg = read_config(dir);
        assert_eq!(cfg["completedMigrations"], json!([AI_TITLE_SHADOW_CLEANUP]));
        assert_eq!(cfg["recentDirectories"], json!(["/a", "/b"]));
        assert_eq!(cfg["zzFutureKey"], json!({ "a": 1 }));
        assert!(store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
    }

    #[tokio::test]
    async fn cleanup_never_reruns_once_marked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(
            dir,
            json!({ "amplifier:a1": { "titleOverride": "Would Qualify", "titleSource": "ai" } }),
            Some(json!([AI_TITLE_SHADOW_CLEANUP])),
        );
        let store = store_at(dir);
        run_ai_title_shadow_cleanup(&store).await;
        let ov = store.session_overrides();
        assert_eq!(
            ov.get("amplifier:a1").unwrap()["titleOverride"],
            json!("Would Qualify"),
            "marker present => migration must not run"
        );
    }

    #[tokio::test]
    async fn cleanup_marks_done_even_when_nothing_qualifies() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(dir, json!({}), None);
        let store = store_at(dir);
        run_ai_title_shadow_cleanup(&store).await;
        assert!(store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
        // Second run: guard short-circuits, marker not duplicated.
        run_ai_title_shadow_cleanup(&store).await;
        assert_eq!(
            read_config(dir)["completedMigrations"],
            json!([AI_TITLE_SHADOW_CLEANUP])
        );
    }

    /// Error-model pin (validated divergence): a clear that cannot reach
    /// disk must NOT be recorded as complete -- Node aborts before
    /// markMigrationDone and retries next boot. Self-skips when the process
    /// can write through a read-only dir (e.g. root/CAP_DAC_OVERRIDE).
    #[tokio::test]
    async fn cleanup_skips_marker_when_clears_cannot_persist() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(
            dir,
            json!({ "amplifier:a1": { "titleOverride": "Auto", "titleSource": "ai" } }),
            None,
        );
        let store = store_at(dir);
        let fdir = dir.join(".freshell");
        let mut ro = std::fs::metadata(&fdir).unwrap().permissions();
        ro.set_mode(0o555); // no tmp-file writes => persist AND mark both fail
        std::fs::set_permissions(&fdir, ro).unwrap();
        if std::fs::write(fdir.join("probe"), b"x").is_ok() {
            let _ = std::fs::remove_file(fdir.join("probe"));
            eprintln!("SKIP cleanup_skips_marker_when_clears_cannot_persist: read-only dir not enforceable here");
            return;
        }

        run_ai_title_shadow_cleanup(&store).await;

        let mut rw = std::fs::metadata(&fdir).unwrap().permissions();
        rw.set_mode(0o755);
        std::fs::set_permissions(&fdir, rw).unwrap();
        assert!(!store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
        let cfg = read_config(dir);
        assert_eq!(
            cfg["sessionOverrides"]["amplifier:a1"]["titleOverride"],
            json!("Auto"),
            "the clear never reached disk, so nothing may claim it did"
        );
    }
}
