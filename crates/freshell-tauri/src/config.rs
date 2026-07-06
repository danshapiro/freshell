//! `desktop.json` read + atomic patch — the Rust analog of the parts of
//! `electron/desktop-config.ts` the deferred features need (`readDesktopConfig`,
//! `patchDesktopConfig`, `desktop-config.ts:8-9,44-75`). The wizard's
//! `complete-setup` and the window-state persistence both merge into the SAME
//! `~/.freshell/desktop.json` the headless server reads (`electron-tauri.md §6`
//! desktop.json row), so keeping one file + one schema is the parity requirement.
//!
//! Faithful bits preserved: the path (`~/.freshell/desktop.json`), the **atomic
//! tmp+rename** write (`desktop-config.ts:44-52`), and **merge-preserving-keys**
//! semantics (`patchDesktopConfig` spreads over the existing config). The async
//! promise-chain mutex (`desktop-config.ts:57-75`) is not reproduced here: the
//! Tauri core patches config from the main thread, so a `&mut Value` merge is the
//! single-writer equivalent. HOME resolution mirrors the server: `FRESHELL_HOME`
//! then `HOME` (see `server.rs`).

use std::path::PathBuf;

/// The `~/.freshell` config dir under an explicit home. Pure — unit-tested without
/// touching process env (env mutation is racy under Rust's parallel test runner).
pub fn config_dir_for(home: &std::path::Path) -> PathBuf {
    home.join(".freshell")
}

/// Resolve the `~/.freshell` config dir, honoring `FRESHELL_HOME` then `HOME`
/// (the server's resolution order). Returns `None` if neither is set.
pub fn config_dir() -> Option<PathBuf> {
    let home = std::env::var_os("FRESHELL_HOME")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    Some(config_dir_for(&home))
}

/// The `~/.freshell/desktop.json` path (`desktop-config.ts:8-9`).
pub fn desktop_config_path() -> Option<PathBuf> {
    Some(config_dir()?.join("desktop.json"))
}

/// Read + parse `desktop.json` at `path`. Missing file → `Ok(json!({}))` (the
/// reference treats an absent config as "use defaults", `desktop-config.ts`). A
/// malformed file is an error (surfaced, not silently overwritten).
pub fn read_config_at(path: &std::path::Path) -> std::io::Result<serde_json::Value> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(e),
    }
}

/// Merge a patch object's keys into `base`, preserving every other key —
/// `patchDesktopConfig`'s spread (`{...existing, ...patch}`). Shallow merge: the
/// patch's top-level keys replace the base's (matching the reference, which
/// replaces whole values like `windowState`).
pub fn merge_patch(base: &mut serde_json::Value, patch: &serde_json::Value) {
    if !base.is_object() {
        *base = serde_json::json!({});
    }
    let (Some(base_obj), Some(patch_obj)) = (base.as_object_mut(), patch.as_object()) else {
        return;
    };
    for (k, v) in patch_obj {
        base_obj.insert(k.clone(), v.clone());
    }
}

/// Atomically write `value` to `path` via tmp+rename (`desktop-config.ts:44-52`),
/// creating the parent dir if needed. Pretty-printed (2-space) like the reference's
/// `JSON.stringify(config, null, 2)`.
pub fn write_config_atomic(
    path: &std::path::Path,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, body.as_bytes())?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Read → merge patch → atomic write, at `path`. The `patchDesktopConfig` flow
/// (`desktop-config.ts:57-75`) minus the async mutex (single main-thread writer).
pub fn patch_config_at(
    path: &std::path::Path,
    patch: &serde_json::Value,
) -> std::io::Result<serde_json::Value> {
    let mut config = read_config_at(path)?;
    merge_patch(&mut config, patch);
    write_config_atomic(path, &config)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_preserves_other_keys() {
        let mut base = serde_json::json!({ "serverMode": "app-bound", "port": 3001 });
        merge_patch(
            &mut base,
            &serde_json::json!({ "port": 4000, "setupCompleted": true }),
        );
        assert_eq!(base["serverMode"], "app-bound"); // preserved
        assert_eq!(base["port"], 4000); // replaced
        assert_eq!(base["setupCompleted"], true); // added
    }

    #[test]
    fn merge_into_non_object_resets() {
        let mut base = serde_json::json!("garbage");
        merge_patch(&mut base, &serde_json::json!({ "a": 1 }));
        assert_eq!(base, serde_json::json!({ "a": 1 }));
    }

    #[test]
    fn read_missing_is_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.json");
        assert_eq!(read_config_at(&path).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn read_malformed_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(read_config_at(&path).is_err());
    }

    #[test]
    fn patch_round_trips_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("desktop.json");
        // First patch creates the file (+ parent dir).
        let c = patch_config_at(&path, &serde_json::json!({ "serverMode": "remote" })).unwrap();
        assert_eq!(c["serverMode"], "remote");
        // Second patch preserves + adds; no .tmp left behind.
        let c2 = patch_config_at(&path, &serde_json::json!({ "setupCompleted": true })).unwrap();
        assert_eq!(c2["serverMode"], "remote");
        assert_eq!(c2["setupCompleted"], true);
        assert!(
            !path.with_extension("json.tmp").exists(),
            "tmp must be renamed away"
        );
        // Persisted content matches.
        let reread = read_config_at(&path).unwrap();
        assert_eq!(reread, c2);
    }

    #[test]
    fn config_dir_prefers_freshell_home() {
        // Save + restore the env so the test is isolated.
        let prev_fh = std::env::var_os("FRESHELL_HOME");
        let prev_home = std::env::var_os("HOME");
        std::env::set_var("FRESHELL_HOME", "/tmp/fh");
        std::env::set_var("HOME", "/tmp/home");
        assert_eq!(config_dir(), Some(PathBuf::from("/tmp/fh/.freshell")));
        std::env::remove_var("FRESHELL_HOME");
        assert_eq!(config_dir(), Some(PathBuf::from("/tmp/home/.freshell")));
        // Restore.
        match prev_fh {
            Some(v) => std::env::set_var("FRESHELL_HOME", v),
            None => std::env::remove_var("FRESHELL_HOME"),
        }
        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
