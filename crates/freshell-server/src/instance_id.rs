//! CFG-07: persist a stable server-installation identity keyed on the resolved
//! home. Port of `server/instance-id.ts` (`loadOrCreateServerInstanceId`).
//! Read-once at boot; `bootId` (per-boot) stays the restart signal (A.10:
//! never persist or rotate `bootId` here).
//!
//! On-disk path: `<config_dir>/instance-id`, where `config_dir` is the SAME
//! `<home>/.freshell` directory the rest of this crate uses for
//! `config.json`/`logs/` (see `settings_store.rs`'s `home.join(".freshell")`
//! and `logging.rs`'s `home.join(".freshell").join("logs")`). This matches
//! legacy's `getFreshellConfigDir()` (`server/freshell-home.ts:10-12`:
//! `path.join(getFreshellHomeDir(env), '.freshell')`) exactly, so a migrated
//! legacy home's existing `instance-id` file is adopted byte-for-byte on the
//! Node -> Rust cutover (installation continuity: tab-registry records,
//! session locators, and live-terminal handles keyed on this id remain
//! valid -- see the module's outer CFG-07 spec, A.8).

use std::path::{Path, PathBuf};
use uuid::Uuid;

const INSTANCE_ID_FILENAME: &str = "instance-id";

/// `<config_dir>/instance-id` (mirrors `resolveInstanceIdPath`,
/// `server/instance-id.ts:8-11`). `config_dir` is expected to already be the
/// resolved `.freshell` config dir (the caller passes `home.join(".freshell")`,
/// not the bare home).
fn instance_id_path(config_dir: &Path) -> PathBuf {
    config_dir.join(INSTANCE_ID_FILENAME)
}

/// Read the persisted id, or mint + atomically persist a new one. Returns the
/// stable `srv-<uuid>`. A corrupt/unreadable file (non-NotFound error) is
/// FATAL (`Err`) -- never silently regenerated (legacy `instance-id.ts:20`
/// `throw`s on any non-`ENOENT` read error).
pub fn load_or_create(config_dir: &Path) -> std::io::Result<String> {
    let path = instance_id_path(config_dir);
    match std::fs::read_to_string(&path) {
        Ok(existing) => {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
            // Empty file -> fall through and mint (legacy: empty => create).
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => { /* mint below */ }
        Err(err) => return Err(err), // non-NotFound is fatal, like legacy.
    }

    let id = format!("srv-{}", Uuid::new_v4());
    std::fs::create_dir_all(config_dir)?;
    // Atomic temp-then-rename (legacy `instance-id.ts:27-29`; same discipline
    // as this tree's other atomic writers, e.g. `settings_store.rs`). Unique
    // temp name avoids concurrent-boot clobber; rename is atomic on the same
    // filesystem (A.9: concurrent boots on one home is an accepted race,
    // matching legacy -- last rename wins, no locking added here).
    let tmp = config_dir.join(format!(
        "{INSTANCE_ID_FILENAME}.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    ));
    std::fs::write(&tmp, format!("{id}\n"))?;
    std::fs::rename(&tmp, &path)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Each test gets its own unique temp dir so parallel `cargo test`
    /// execution can't collide (same convention as `main.rs`'s
    /// `unique_temp_dir` test helper).
    fn unique_temp_dir(label: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "freshell-cfg07-instance-id-{label}-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn mint_then_persist() {
        let dir = unique_temp_dir("mint");
        // Deliberately do NOT create `dir` -- `load_or_create` must
        // `create_dir_all` it itself (legacy: `fs.mkdir(dir, {recursive:true})`).
        let id = load_or_create(&dir).expect("mint should succeed on an empty/missing dir");
        assert!(id.starts_with("srv-"), "id must be srv-<uuid>: {id}");

        let on_disk = std::fs::read_to_string(dir.join(INSTANCE_ID_FILENAME))
            .expect("instance-id file must exist after minting");
        assert_eq!(
            on_disk,
            format!("{id}\n"),
            "file must contain id + trailing newline"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reuse_existing() {
        let dir = unique_temp_dir("reuse");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(INSTANCE_ID_FILENAME), "srv-fixed\n").unwrap();
        let before_mtime = std::fs::metadata(dir.join(INSTANCE_ID_FILENAME))
            .unwrap()
            .modified()
            .unwrap();

        let id = load_or_create(&dir).expect("reuse should succeed");
        assert_eq!(id, "srv-fixed");

        let after_mtime = std::fs::metadata(dir.join(INSTANCE_ID_FILENAME))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            before_mtime, after_mtime,
            "existing file must not be rewritten"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn trims_whitespace() {
        let dir = unique_temp_dir("trim");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(INSTANCE_ID_FILENAME), "  srv-x \n").unwrap();

        let id = load_or_create(&dir).expect("should read the trimmed id");
        assert_eq!(id, "srv-x");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_file_remints() {
        let dir = unique_temp_dir("empty");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(INSTANCE_ID_FILENAME), "").unwrap();

        let id = load_or_create(&dir).expect("empty file should trigger a remint");
        assert!(id.starts_with("srv-"));
        let on_disk = std::fs::read_to_string(dir.join(INSTANCE_ID_FILENAME)).unwrap();
        assert_eq!(
            on_disk,
            format!("{id}\n"),
            "the reminted id must be persisted"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn distinct_homes_distinct_ids() {
        let dir_a = unique_temp_dir("home-a");
        let dir_b = unique_temp_dir("home-b");

        let id_a = load_or_create(&dir_a).unwrap();
        let id_b = load_or_create(&dir_b).unwrap();
        assert_ne!(id_a, id_b, "two distinct homes must mint distinct ids");

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    #[test]
    fn corrupt_is_fatal() {
        let dir = unique_temp_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        // Make the instance-id PATH itself a directory, forcing a non-NotFound
        // read error (`Err(IsADirectory)` on Linux) -- parity with legacy's
        // `throw` on any non-ENOENT error (`instance-id.ts:20`).
        std::fs::create_dir_all(dir.join(INSTANCE_ID_FILENAME)).unwrap();

        let result = load_or_create(&dir);
        assert!(
            result.is_err(),
            "a corrupt/unreadable instance-id must be fatal, not silently reminted"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
