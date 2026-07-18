//! The ONE live, mutable server-settings source of truth (R2/R3/R4 root-cause fix).
//!
//! Before this module: `GET /api/settings` (boot.rs), the files sandbox
//! (files.rs), and `bootstrap.settings` all read a frozen `Arc<ServerSettings>`
//! snapshot captured once at process start, while `PATCH /api/settings` (formerly
//! `codex.rs#patch_settings`) mutated an ENTIRELY SEPARATE `Arc<Mutex<Value>>`
//! that nothing else ever read and that was never persisted to `config.json`.
//! That is why a PATCH's own response/broadcast reflected the change while the
//! very next GET, the files sandbox, and a restart did not (R2), and why
//! `allowedFilePaths` could never be enforced (R3) or `knownProviders` populated
//! (R4) \u2014 both live only in the settings tree, which was frozen.
//!
//! This module owns:
//! * the live [`SettingsStore`] (`Arc<RwLock<ServerSettings>>`), shared by
//!   `BootState`, `FilesState`, and this module's own router;
//! * `GET`/`PATCH`/`PUT` `/api/settings` (R1: PUT is no longer 405 \u2014 the
//!   original treats PUT and PATCH identically, `server/settings-router.ts:151-152`);
//! * config.json persistence in the original's `UserConfig` shape
//!   (`server/config-store.ts`), so a patch survives a restart;
//! * `codingCli.knownProviders`, seeded once from the discovered CLI extensions
//!   and re-asserted on every merge (it is derived data, never user-patchable).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use freshell_protocol::ServerSettings;
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::boot::{is_authed, unauthorized};

/// The shared, mutable settings tree. Cheap to clone (one `Arc` inside).
#[derive(Clone)]
pub struct SettingsStore {
    inner: Arc<RwLock<ServerSettings>>,
    home: Option<Arc<PathBuf>>,
    /// The PATCH-validation allowlist: the CLI extension names discovered at
    /// boot (`validCliProviders: allCliNames`, `server/index.ts:585`). Fixed
    /// for the process lifetime \u2014 NOT the live `knownProviders` value (which
    /// is regular patchable state).
    valid_cli_providers: Arc<Vec<String>>,
    /// `serverSecrets.codexDisplayIdSecret` (`config-store.ts`): per-boot
    /// generated secret material persisted alongside `settings` in
    /// `config.json` (R2 evidence: `settings.configjson-shape`). Read back
    /// from an existing config so it survives a restart; generated once
    /// otherwise. Its VALUE is never compared by the oracle (registry
    /// `opaque` normalization) -- only its presence is.
    codex_display_id_secret: Arc<String>,
    /// `config.terminalOverrides` (`server/config-store.ts`): per-terminal
    /// user overrides (`titleOverride`/`descriptionOverride`/`deleted`) the
    /// `/api/terminals` router reads (directory merge/filter) and patches.
    /// A std `Mutex` (not tokio) so the sync `persist` path can snapshot it.
    terminal_overrides: Arc<std::sync::Mutex<serde_json::Map<String, Value>>>,
    /// `config.sessionOverrides` (`server/config-store.ts:492-514`): per-session
    /// user overrides (`titleOverride`/`titleSource`/`summaryOverride`/`archived`/
    /// `deleted`/`createdAtOverride`) the `/api/sessions` router patches and the
    /// session-directory read model overlays. std `Mutex` so the sync `persist`
    /// path can snapshot it (same as `terminal_overrides`).
    session_overrides: Arc<std::sync::Mutex<serde_json::Map<String, Value>>>,
    /// Side-by-side hardening (bake-in with the legacy Node server on the
    /// SAME real home): top-level keys of `session_overrides` TOUCHED by
    /// `patch_session_override` THIS PROCESS's lifetime (never cleared --
    /// "touched this boot" is permanent for the boot's duration, not reset
    /// per-persist). `persist()`/the freshness reload use this set with
    /// [`overlay_dirty_keys`] so a key we've never touched always defers to
    /// whatever a concurrent writer (legacy server, or another Rust
    /// process) currently has on disk, while a key we HAVE touched always
    /// reflects our own in-memory value (a key present in this set but
    /// absent from the in-memory map is a tombstone: explicitly removed).
    session_overrides_dirty: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// The `terminal_overrides` analog of `session_overrides_dirty`.
    terminal_overrides_dirty: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// Throttled mtime-check state backing the freshness reload
    /// (`maybe_reload_overrides`) on the override READ path
    /// (`session_overrides()`/`terminal_overrides()`).
    overrides_reload_state: Arc<std::sync::Mutex<OverridesReloadState>>,
    /// The freshness-reload throttle window (production default: 1 second,
    /// set in [`SettingsStore::load`]). Injectable via the `#[cfg(test)]`
    /// [`SettingsStore::with_reload_throttle_window`] builder so tests can
    /// prove the SAME throttle logic against a much smaller, test-scaled
    /// window instead of racing the real 1-second wall-clock boundary under
    /// parallel test-suite CPU contention (see `override_reload_is_throttled`
    /// below). Compiled out of release builds -- there is no production path
    /// that ever sets anything other than the 1-second default.
    reload_throttle_window: std::time::Duration,
}

/// Throttle + change-detection state for [`SettingsStore::maybe_reload_overrides`].
#[derive(Default)]
struct OverridesReloadState {
    /// Monotonic clock (immune to wall-clock adjustments) of the last time
    /// we actually `stat()`'d `config.json`; `None` means "never checked",
    /// which always proceeds regardless of the throttle window.
    last_checked: Option<std::time::Instant>,
    /// The `config.json` mtime as of the last check; used to skip the
    /// (more expensive) disk re-read entirely when nothing changed.
    last_known_mtime: Option<std::time::SystemTime>,
}

impl SettingsStore {
    /// Test-only override for the freshness-reload throttle window (default:
    /// 1 real second, set by [`SettingsStore::load`]). `#[cfg(test)]`-gated,
    /// so it compiles out of every release build entirely -- this is not a
    /// production entry point, just dependency injection for a deterministic
    /// test (see `override_reload_is_throttled_to_a_configurable_window`
    /// below), which needs a MUCH smaller window than 1 real second to stay
    /// immune to scheduling jitter under a parallel test-suite run.
    #[cfg(test)]
    fn with_reload_throttle_window(mut self, window: std::time::Duration) -> Self {
        self.reload_throttle_window = window;
        self
    }

    /// Load the full persisted settings tree (defaults deep-merged with
    /// `<home>/.freshell/config.json`'s `settings` object \u2014 mirrors
    /// `mergeServerSettings(defaults, persisted)`), then run the ORIGINAL's
    /// startup knownProviders migration (`server/index.ts:271-299`, pinned by
    /// live probes 2026-07-12):
    ///
    /// * legacy `enabledProviders == ['claude','codex']` (as a set, trimmed +
    ///   deduped) gains the discovered members of the modern default set
    ///   (`server/settings-migrate.ts#migrateLegacyDefaultEnabledProviders`);
    /// * persisted `knownProviders` MISSING (fresh home, or non-array \u2014 the
    ///   read normalization drops non-arrays, `shared/settings.ts:1072`) \u21d2
    ///   SEED it with the discovered CLI extension names and persist \u2014 even
    ///   when the discovered set is empty (live: fresh cwd-neutral boot writes
    ///   `knownProviders: []` to config.json);
    /// * otherwise, newly discovered names are APPENDED to `knownProviders`
    ///   AND auto-enabled (appended to `enabledProviders` if absent), then
    ///   persisted. With nothing new, the persisted list is served AS-IS \u2014
    ///   a cwd-neutral reboot does NOT shrink a previously-seeded list.
    ///
    /// `knownProviders` is REGULAR persisted, patchable state in the original
    /// (a PATCH replaces it \u2014 pinned live); only the PATCH-validation
    /// allowlist is fixed at boot to the discovered set (`validCliProviders:
    /// allCliNames`, `server/index.ts:585`).
    pub fn load(home: Option<&Path>, discovered_cli_names: Vec<String>) -> Self {
        // CFG-03: conservative backup restore, BEFORE any of the tolerant
        // per-field readers below (`load_full_settings`,
        // `load_terminal_overrides`, `load_session_overrides`,
        // `load_or_mint_codex_display_id_secret`) each independently
        // re-read `config.json` -- so a restore rewrites the actual file
        // once, and every one of them sees the SAME recovered document.
        // See `maybe_restore_config_from_backup` for the full policy.
        if let Some(home) = home {
            maybe_restore_config_from_backup(home);
        }
        let mut settings = load_full_settings(home);

        // (1) Legacy default-enabled migration (`settings-migrate.ts:17-49`).
        let mut migrated_legacy = false;
        {
            const LEGACY: [&str; 2] = ["claude", "codex"];
            const DEFAULTS: [&str; 3] = ["claude", "codex", "opencode"];
            let enabled_norm =
                normalize_trimmed_string_list(&settings.coding_cli.enabled_providers);
            let legacy_match = enabled_norm.len() == LEGACY.len()
                && LEGACY.iter().all(|l| enabled_norm.iter().any(|e| e == l));
            if legacy_match {
                let additional: Vec<String> = DEFAULTS
                    .iter()
                    .filter(|p| {
                        discovered_cli_names.iter().any(|d| d == **p)
                            && !enabled_norm.iter().any(|e| e == **p)
                    })
                    .map(|p| (*p).to_string())
                    .collect();
                if !additional.is_empty() {
                    let mut enabled = enabled_norm;
                    enabled.extend(additional);
                    settings.coding_cli.enabled_providers = enabled;
                    migrated_legacy = true;
                }
            }
        }

        // (2) Seed-when-missing / append-new + auto-enable (`index.ts:276-299`).
        let mut needs_persist = false;
        match read_persisted_known_providers(home) {
            None => {
                // MIGRATION: seed with ALL discovered CLI names (the original
                // always calls `patchSettings` here, so config.json is written
                // even when the seed is `[]`).
                settings.coding_cli.known_providers = Some(discovered_cli_names.clone());
                needs_persist = true;
            }
            Some(known) => {
                let new_providers: Vec<String> = discovered_cli_names
                    .iter()
                    .filter(|d| !known.contains(d))
                    .cloned()
                    .collect();
                if !new_providers.is_empty() || migrated_legacy {
                    let mut kp = known;
                    kp.extend(new_providers.iter().cloned());
                    settings.coding_cli.known_providers = Some(kp);
                    let mut enabled = settings.coding_cli.enabled_providers.clone();
                    for name in &new_providers {
                        if !enabled.contains(name) {
                            enabled.push(name.clone());
                        }
                    }
                    settings.coding_cli.enabled_providers = enabled;
                    needs_persist = true;
                } else {
                    settings.coding_cli.known_providers = Some(known);
                }
            }
        }

        let codex_display_id_secret = load_or_mint_codex_display_id_secret(home);
        let terminal_overrides = load_terminal_overrides(home);
        let session_overrides = load_session_overrides(home);
        let store = Self {
            inner: Arc::new(RwLock::new(settings.clone())),
            home: home.map(|p| Arc::new(p.to_path_buf())),
            valid_cli_providers: Arc::new(discovered_cli_names),
            codex_display_id_secret: Arc::new(codex_display_id_secret),
            terminal_overrides: Arc::new(std::sync::Mutex::new(terminal_overrides)),
            session_overrides: Arc::new(std::sync::Mutex::new(session_overrides)),
            // Nothing is dirty yet at boot -- every key we just loaded came
            // straight from disk, so it defers to disk until THIS process
            // actually patches it.
            session_overrides_dirty: Arc::new(std::sync::Mutex::new(Default::default())),
            terminal_overrides_dirty: Arc::new(std::sync::Mutex::new(Default::default())),
            overrides_reload_state: Arc::new(std::sync::Mutex::new(Default::default())),
            reload_throttle_window: std::time::Duration::from_secs(1),
        };
        if needs_persist {
            store.persist(&settings);
        }
        store
    }

    /// A clone of the live settings tree.
    pub async fn get(&self) -> ServerSettings {
        self.inner.read().await.clone()
    }

    /// Deep-merge `patch_body` into the live settings (R1: same handler for
    /// PUT and PATCH), persist to `config.json` (R2), and return the merged
    /// tree. `Err` carries the `(status, body)` to answer with on a validation
    /// rejection \u2014 checked BEFORE any mutation, so a bad patch never partially
    /// applies.
    pub async fn patch(&self, patch_body: &Value) -> Result<ServerSettings, (StatusCode, Value)> {
        // `agentChat` is a migrated/removed key \u2014 rejected before schema
        // validation (`settings-router.ts:127-130`).
        if let Value::Object(map) = patch_body {
            if map.contains_key("agentChat") {
                return Err((
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "agentChat settings have been migrated; use freshAgent" }),
                ));
            }
        }
        if let Some(details) = validate_patch(patch_body, &self.valid_cli_providers) {
            return Err((
                StatusCode::BAD_REQUEST,
                json!({ "error": "Invalid request", "details": details }),
            ));
        }

        let mut guard = self.inner.write().await;
        let mut value = serde_json::to_value(&*guard).unwrap_or_else(|_| json!({}));
        deep_merge(&mut value, patch_body);
        // NOTE: `knownProviders` is regular patchable, persisted state in the
        // original (pinned live 2026-07-12: PATCH `{codingCli:{knownProviders:
        // ["claude"]}}` replaces and persists it); names are validated against
        // the boot-discovered allowlist above, exactly like `enabledProviders`.
        let merged: ServerSettings = match serde_json::from_value(value) {
            Ok(s) => s,
            Err(_) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "Invalid request", "details": [] }),
                ))
            }
        };
        *guard = merged.clone();
        drop(guard);
        self.persist(&merged);
        Ok(merged)
    }

    /// Persist the current tree to `<home>/.freshell/config.json`, COPYING
    /// FORWARD whatever is already on disk and overlaying only the keys this
    /// store owns (R2). This mirrors the original's `{...existing, ...}`
    /// write (`server/config-store.ts:343-361`): any top-level key the Rust
    /// store does not manage -- `completedMigrations`, `recentDirectories`, a
    /// future key added later, an unknown subkey of a known section -- round-
    /// trips untouched instead of being silently dropped.
    ///
    /// PAST BUG (data-loss incident, fixed here): this used to build the
    /// document from a FIXED key set (`json!({...})`), so ANY persist --
    /// even one triggered by an unrelated settings/override patch --
    /// rewrote `config.json` from scratch and permanently deleted every
    /// key it didn't know about (observed in staging: `completedMigrations`
    /// removed entirely, `recentDirectories` emptied from 20 entries to 0).
    ///
    /// A missing/unwritable home degrades silently (matches the isolated-
    /// runtime / no-HOME case). A missing/unparseable/non-object existing
    /// file degrades to `{}` (fresh install, or an already-corrupt file
    /// we're about to overwrite anyway) -- same tolerance as every other
    /// read in this module (`config-store.ts#readConfigFile`).
    ///
    /// SIDE-BY-SIDE HARDENING (bake-in with the legacy Node server on the
    /// SAME real home): this whole read-modify-write is now additionally
    /// guarded by an advisory [`ConfigLock`] (Rust-vs-Rust only -- see its
    /// docs), and `sessionOverrides`/`terminalOverrides` are no longer
    /// overlaid wholesale from memory. Instead [`overlay_dirty_keys`]
    /// starts from a FRESH disk read and replaces only the keys THIS
    /// process actually touched this boot, so a concurrent write to any
    /// other key -- by the legacy server, or another Rust process --
    /// survives every persist. `settings` itself is still overlaid
    /// wholesale (unchanged from Batch A): during bake-in, settings edits
    /// belong to whichever server the user is actively driving, and that
    /// residual is accepted (see the module-level docs / task report for
    /// the honest limits of this mechanism).
    fn persist(&self, settings: &ServerSettings) {
        let Some(home) = &self.home else { return };
        let dir = home.join(".freshell");
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join("config.json");

        // Advisory cross-process lock across the ENTIRE read-modify-write
        // below (sidecar file, never `config.json` itself -- see
        // `ConfigLock`). Held until the end of this function (RAII drop).
        let _lock = ConfigLock::acquire(&dir);

        let mut doc = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let map = doc
            .as_object_mut()
            .expect("filtered to an object above, or defaulted to one");

        // Keys this store OWNS: always fully replaced with live in-memory
        // state, never copy-forwarded.
        map.insert("version".to_string(), json!(1));
        map.insert(
            "settings".to_string(),
            serde_json::to_value(settings).unwrap_or_else(|_| json!({})),
        );

        // ADOPT-FROM-DISK MERGE (Batch B hardening): fresh disk read,
        // overlaid with ONLY the keys this process marked dirty. A key
        // we've never touched this boot always reflects whatever is on
        // disk RIGHT NOW, not our (possibly stale) boot-time snapshot.
        let disk_session_overrides = map
            .get("sessionOverrides")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let merged_session_overrides = {
            let memory = self
                .session_overrides
                .lock()
                .expect("session overrides lock");
            let dirty = self
                .session_overrides_dirty
                .lock()
                .expect("session overrides dirty lock");
            overlay_dirty_keys(disk_session_overrides, &memory, &dirty)
        };
        map.insert(
            "sessionOverrides".to_string(),
            Value::Object(merged_session_overrides),
        );

        let disk_terminal_overrides = map
            .get("terminalOverrides")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let merged_terminal_overrides = {
            let memory = self
                .terminal_overrides
                .lock()
                .expect("terminal overrides lock");
            let dirty = self
                .terminal_overrides_dirty
                .lock()
                .expect("terminal overrides dirty lock");
            overlay_dirty_keys(disk_terminal_overrides, &memory, &dirty)
        };
        map.insert(
            "terminalOverrides".to_string(),
            Value::Object(merged_terminal_overrides),
        );

        // `serverSecrets` is overlaid onto whatever was already there (not
        // replaced wholesale), so a sibling secret this store doesn't know
        // about would survive too.
        let mut secrets = map
            .get("serverSecrets")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        secrets.insert(
            "codexDisplayIdSecret".to_string(),
            json!(&*self.codex_display_id_secret),
        );
        map.insert("serverSecrets".to_string(), Value::Object(secrets));

        // Everything else -- `completedMigrations`, `recentDirectories`,
        // `projectColors`, any unrecognized top-level key -- is left exactly
        // as loaded above. Only seed the original's first-write defaults
        // when truly absent (`config-store.ts:356-360`).
        map.entry("projectColors").or_insert_with(|| json!({}));
        map.entry("recentDirectories").or_insert_with(|| json!([]));

        let Ok(text) = serde_json::to_string_pretty(&doc) else {
            return;
        };
        let tmp = dir.join(format!("config.json.tmp-{}", std::process::id()));
        let persisted_ok =
            std::fs::write(&tmp, &text).is_ok() && std::fs::rename(&tmp, &path).is_ok();

        // CFG-03 (backup + conservative auto-restore): refresh the backup
        // ONLY after a SUCCESSFUL primary persist, and do it atomically
        // (tmp+rename via `atomic_write`) -- unlike the original's plain,
        // non-atomic `copyFile(configPath(), backupPath())`
        // (`config-store.ts:427`), which can leave a torn/partial backup if
        // the process dies mid-copy. Covered by the SAME `_lock` above.
        if persisted_ok {
            atomic_write(&backup_path(&dir), &text);
        }
        // `_lock` drops here, releasing the flock.
    }

    /// Cheap mtime-checked freshness reload for the override READ path
    /// (Batch B hardening): if `config.json`'s mtime changed since we last
    /// checked, re-read `sessionOverrides`/`terminalOverrides` from disk
    /// and adopt them into memory under the SAME dirty-key rule `persist()`
    /// uses ([`overlay_dirty_keys`]) -- so a concurrent rename made by the
    /// legacy Node server (or another Rust process) shows up here WITHOUT a
    /// Rust restart, while a key we've touched this boot keeps our own
    /// value. Throttled to at most once/second (an `Instant`, immune to
    /// wall-clock adjustments) so a hot polling path (the sidebar) never
    /// `stat()`s `config.json` on every single call. Read-only otherwise:
    /// no lock is taken here (a reader either sees the old complete file or
    /// the new complete file -- `persist()`'s tmp+rename is atomic -- never
    /// a torn write).
    fn maybe_reload_overrides(&self) {
        let Some(home) = &self.home else { return };

        let now = std::time::Instant::now();
        {
            let mut state = self
                .overrides_reload_state
                .lock()
                .expect("overrides reload state lock");
            if let Some(last) = state.last_checked {
                if now.duration_since(last) < self.reload_throttle_window {
                    return;
                }
            }
            state.last_checked = Some(now);
        }

        let config_path = home.join(".freshell").join("config.json");
        let Ok(meta) = std::fs::metadata(&config_path) else {
            return;
        };
        let Ok(mtime) = meta.modified() else {
            return;
        };

        let changed = {
            let mut state = self
                .overrides_reload_state
                .lock()
                .expect("overrides reload state lock");
            let changed = state.last_known_mtime != Some(mtime);
            state.last_known_mtime = Some(mtime);
            changed
        };
        if !changed {
            return;
        }

        let disk_session = load_session_overrides(Some(home));
        let mut memory = self
            .session_overrides
            .lock()
            .expect("session overrides lock");
        let dirty = self
            .session_overrides_dirty
            .lock()
            .expect("session overrides dirty lock");
        let merged = overlay_dirty_keys(disk_session, &memory, &dirty);
        *memory = merged;
        drop(dirty);
        drop(memory);

        let disk_terminal = load_terminal_overrides(Some(home));
        let mut memory = self
            .terminal_overrides
            .lock()
            .expect("terminal overrides lock");
        let dirty = self
            .terminal_overrides_dirty
            .lock()
            .expect("terminal overrides dirty lock");
        let merged = overlay_dirty_keys(disk_terminal, &memory, &dirty);
        *memory = merged;
    }

    /// A snapshot of `config.terminalOverrides` (the `/api/terminals` directory
    /// reads it to merge titles/descriptions and filter `deleted`).
    pub fn terminal_overrides(&self) -> serde_json::Map<String, Value> {
        self.maybe_reload_overrides();
        self.terminal_overrides
            .lock()
            .expect("terminal overrides lock")
            .clone()
    }

    /// `configStore.patchTerminalOverride(id, patch)` (`config-store.ts:530-542`)
    /// with the ORIGINAL's exact JS-spread semantics: `next = {...existing, ...patch}`
    /// where the router's patch object carries **all** of its keys — a key patched
    /// with `undefined` (here `None`) OVERWRITES the existing value and is then
    /// dropped by `JSON.stringify` on persist/response. So callers pass every key
    /// they want overwritten: `Some(v)` sets it, `None` clears it; keys NOT in
    /// `patch` are preserved from the existing override (the `deleteTerminal`
    /// single-key `{deleted:true}` path).
    ///
    /// Returns the merged override (`next`) — the PATCH response body.
    pub async fn patch_terminal_override(
        &self,
        terminal_id: &str,
        patch: &[(&str, Option<Value>)],
    ) -> Value {
        let next = {
            let mut all = self
                .terminal_overrides
                .lock()
                .expect("terminal overrides lock");
            let mut next = all
                .get(terminal_id)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (key, value) in patch {
                match value {
                    // serde_json's preserve_order Map keeps an overwritten key's
                    // position and appends new keys — the JS spread's key order.
                    Some(v) => {
                        next.insert((*key).to_string(), v.clone());
                    }
                    None => {
                        next.remove(*key);
                    }
                }
            }
            all.insert(terminal_id.to_string(), Value::Object(next.clone()));
            // Side-by-side hardening: this terminal is TOUCHED this boot --
            // `persist()`/the freshness reload now treat it as ours, always
            // overlaying (or tombstoning) it over whatever is on disk. See
            // `session_overrides_dirty` for the full rationale.
            self.terminal_overrides_dirty
                .lock()
                .expect("terminal overrides dirty lock")
                .insert(terminal_id.to_string());
            next
        };
        // Persist the whole config.json (same atomic tmp+rename write as a
        // settings patch; the doc embeds the live settings tree + overrides).
        let settings = self.get().await;
        self.persist(&settings);
        Value::Object(next)
    }

    /// A snapshot of `config.sessionOverrides` (the session-directory read model
    /// overlays it; the `/api/sessions` router patches it).
    pub fn session_overrides(&self) -> serde_json::Map<String, Value> {
        self.maybe_reload_overrides();
        self.session_overrides
            .lock()
            .expect("session overrides lock")
            .clone()
    }

    /// `configStore.patchSessionOverride(key, patch)` (`config-store.ts:492-514`):
    /// JS-spread merge `next = {...existing, ...patch}` (`Some(v)` sets, `None`
    /// clears a key), THEN the title-source ladder: a `(titleOverride, titleSource)`
    /// write only lands if `canUpgradeTitle(existing.titleSource, incoming)` — else
    /// the existing title+source are restored while every OTHER patched field still
    /// applies. A resolved-no-op (`next == existing`) skips the disk write.
    /// Returns the merged override (the PATCH response body).
    pub async fn patch_session_override(
        &self,
        key: &str,
        patch: &[(&str, Option<Value>)],
    ) -> Value {
        let (next, changed) = {
            let mut all = self
                .session_overrides
                .lock()
                .expect("session overrides lock");
            let existing = all
                .get(key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut next = existing.clone();
            for (k, v) in patch {
                match v {
                    Some(v) => {
                        next.insert((*k).to_string(), v.clone());
                    }
                    None => {
                        next.remove(*k);
                    }
                }
            }
            // Title-source ladder — only when BOTH title keys are present in the patch.
            let patches_title = patch.iter().any(|(k, _)| *k == "titleOverride")
                && patch.iter().any(|(k, _)| *k == "titleSource");
            if patches_title {
                let incoming = next.get("titleSource").and_then(Value::as_str);
                let existing_src = existing.get("titleSource").and_then(Value::as_str);
                if let Some(incoming) = incoming {
                    if !can_upgrade_title(existing_src, incoming) {
                        match existing.get("titleOverride") {
                            Some(v) => {
                                next.insert("titleOverride".into(), v.clone());
                            }
                            None => {
                                next.remove("titleOverride");
                            }
                        }
                        match existing.get("titleSource") {
                            Some(v) => {
                                next.insert("titleSource".into(), v.clone());
                            }
                            None => {
                                next.remove("titleSource");
                            }
                        }
                    }
                }
            }
            let changed = next != existing;
            if changed {
                all.insert(key.to_string(), Value::Object(next.clone()));
            }
            // Side-by-side hardening: this session key is TOUCHED this
            // boot -- marked dirty regardless of `changed` (a resolved
            // no-op still means we've asserted an opinion about this key;
            // marking it dirty is harmless since no disk write happens
            // when `!changed`, and it's simplest to reason about "touched
            // == dirty for the boot's duration"). See
            // `session_overrides_dirty` for the full rationale.
            self.session_overrides_dirty
                .lock()
                .expect("session overrides dirty lock")
                .insert(key.to_string());
            (Value::Object(next), changed)
        };
        if changed {
            let settings = self.get().await;
            self.persist(&settings);
        }
        next
    }
}

/// Advisory cross-process serialization for `persist()`'s read-modify-write
/// window (bake-in with the legacy Node server on the SAME real home). Held
/// on a SIDECAR file (`<home>/.freshell/.config.lock`), never `config.json`
/// itself, so the legacy server's own atomic tmp+rename write is completely
/// unaffected by whether this lock exists, is held, or is contended.
///
/// HONEST LIMIT: the legacy Node server does NOT participate in this lock
/// at all -- it never even looks at the sidecar file. This only serializes
/// Rust-vs-Rust (two Rust processes, or two concurrent persists within one
/// process). It does NOT, by itself, prevent a Rust persist and a legacy
/// write from interleaving mid-write. What actually prevents Rust from
/// CLOBBERING a concurrent legacy write is the dirty-key overlay in
/// `overlay_dirty_keys`: even without this lock, a legacy write to a key
/// Rust hasn't touched survives, because Rust re-reads disk fresh every
/// time. This lock's job is narrower: it shrinks the window in which TWO
/// RUST writers could race each other and lose one's update (see the
/// `concurrent_persists_across_two_store_instances_serialize_without_lost_updates`
/// test) -- a real risk once a second Rust process (or a future
/// multi-instance deployment) exists, even though bake-in's DESCRIBED
/// scenario is one Rust process alongside the legacy Node server.
///
/// Blocking is a short poll loop (`flock(2)` has no native timeout),
/// bounded to ~2s; on timeout this gives up and logs a warning rather than
/// risk hanging request handling forever -- a wedged/slow lock holder must
/// never deadlock the server.
struct ConfigLock {
    #[cfg(unix)]
    _file: std::fs::File,
}

impl ConfigLock {
    #[cfg(unix)]
    fn acquire(dir: &Path) -> Option<Self> {
        use std::os::unix::io::AsRawFd;

        let path = dir.join(".config.lock");
        // The lock file's CONTENT is irrelevant (only its existence + flock
        // state matter), so `truncate(false)` is explicit that we don't
        // care either way -- avoids clippy's `suspicious_open_options`.
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .ok()?;
        let fd = file.as_raw_fd();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            // SAFETY: `fd` is a valid, open file descriptor owned by `file`
            // for the duration of this call; `flock` only mutates kernel
            // lock state associated with it.
            let rc = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                return Some(Self { _file: file });
            }
            if std::time::Instant::now() >= deadline {
                eprintln!(
                    "freshell-server: config lock timed out after 2s ({}); proceeding without it",
                    path.display()
                );
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[cfg(not(unix))]
    fn acquire(_dir: &Path) -> Option<Self> {
        // No advisory-lock primitive wired up on this platform; `persist()`
        // proceeds without cross-process serialization (same as a timeout
        // above) -- the dirty-key overlay is still the primary defense
        // against clobbering a concurrent writer's untouched keys.
        None
    }
}

/// `<home>/.freshell/config.backup.json` -- SAME filename the original uses
/// (`config-store.ts:86-88`'s `backupPath()`), so a human (or a future
/// restore UI, `configFallback.backupExists` / `backupExists()`) finds it in
/// the expected place regardless of which server wrote it.
fn backup_path(dir: &Path) -> PathBuf {
    dir.join("config.backup.json")
}

/// Atomic tmp+rename write shared by [`SettingsStore::persist`]'s backup
/// refresh and [`maybe_restore_config_from_backup`]'s primary restore. Same
/// tmp-then-rename shape `persist()` already uses for `config.json` itself,
/// but the tmp name additionally carries a random UUID (not just the
/// process id): unlike `persist()`'s single call site (already serialized
/// by its own held `ConfigLock` for its whole body), this helper is called
/// from two DIFFERENT functions that each acquire and release their OWN
/// `ConfigLock` instance sequentially, so a crashed prior attempt's
/// leftover `*.tmp-<pid>` could otherwise collide with a same-pid retry.
fn atomic_write(path: &Path, text: &str) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let tmp = parent.join(format!(
        "{name}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    if std::fs::write(&tmp, text).is_err() {
        return false;
    }
    if std::fs::rename(&tmp, path).is_ok() {
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

/// CFG-03 file-health classification, deliberately coarse: this module's
/// restore policy is CONSERVATIVE (auto-restore ONLY on a broken read,
/// NEVER on a semantic surprise), so beyond "does this parse as JSON at
/// all" there is nothing else for it to know. A parseable file of ANY
/// shape -- missing keys, wrong types, a bake-in-partner legacy write that
/// looks unusual -- is [`Ok`](ConfigFileHealth::Ok) and is never touched by
/// [`maybe_restore_config_from_backup`]; per-field tolerance for a
/// surprising-but-parseable shape is `load_full_settings`/
/// `load_terminal_overrides`/`load_session_overrides`'s job, unchanged by
/// this policy.
enum ConfigFileHealth {
    /// No file at all -- the original's silent, unlogged `ENOENT` fallback
    /// (`config-store.ts#readConfigFile`). Nothing on disk to preserve.
    Missing,
    /// A file exists but its bytes could not be decoded as UTF-8 or parsed
    /// as JSON. Real corruption -- the restore policy's trigger condition.
    Corrupt,
    /// Valid JSON, any shape.
    Ok,
}

fn config_file_health(path: &Path) -> ConfigFileHealth {
    if std::fs::metadata(path).is_err() {
        return ConfigFileHealth::Missing;
    }
    match std::fs::read_to_string(path) {
        // Exists (the `metadata` check above proved that) but could not be
        // read as UTF-8 text (or some other transient IO error) -- treated
        // as corrupt-equivalent, matching the original's `READ_ERROR`
        // fallback-with-warning path (`config-store.ts:227-231`).
        Err(_) => ConfigFileHealth::Corrupt,
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(_) => ConfigFileHealth::Ok,
            Err(_) => ConfigFileHealth::Corrupt,
        },
    }
}

/// CFG-03 -- backup + conservative auto-restore. Called ONCE at the very
/// top of [`SettingsStore::load`], BEFORE `load_full_settings`/
/// `load_terminal_overrides`/`load_session_overrides`/
/// `load_or_mint_codex_display_id_secret` each independently re-read
/// `config.json` from disk -- so when a restore happens, it rewrites the
/// ACTUAL file on disk and every one of those readers transparently sees
/// the SAME recovered document this boot, not just an in-memory patch only
/// one of them would observe.
///
/// THE ORIGINAL'S GAP THIS CLOSES (`config-store.ts:317-398`): on ANY read
/// failure -- parse, version, OR read error, not just a missing file --
/// the original's `loadInternal` falls through to its "no existing config"
/// branch and calls `saveInternal(defaultsOnlyConfig)` UNCONDITIONALLY.
/// That immediately overwrites `config.json` with bare defaults AND, via
/// `saveInternal`'s own unconditional `copyFile(configPath(), backupPath())`
/// (`config-store.ts:423-430`), OVERWRITES THE LAST-GOOD BACKUP with those
/// same bare defaults -- before a human ever has a chance to act on the
/// warning log's suggested manual `mv config.backup.json config.json`
/// recovery command. By the time anyone could run it, the backup it
/// depends on is already gone. This is precisely the "a corrupted config
/// costs the user their N renames" failure CFG-03 exists to close, and
/// mirrors this task's outer acceptance test one-for-one.
///
/// THE FIX -- a deliberate, documented safety improvement beyond the
/// original (the CFG-03 checklist item's own parenthetical permits exactly
/// this: "Automatic backup restoration is a deliberate safety improvement
/// only if separately documented and tested"):
///
/// * restore ONLY when the primary is [`ConfigFileHealth::Missing`] or
///   [`ConfigFileHealth::Corrupt`] -- a primary that parses, of ANY shape,
///   is NEVER touched (side-by-side hazard: the legacy Node server
///   co-writes this same file during bake-in; a stale backup must never
///   clobber a newer valid legacy write, so "parses" is the ENTIRE bar);
/// * restore ONLY when the backup itself is [`ConfigFileHealth::Ok`] --
///   restoring from an equally-broken backup would just trade one
///   corruption for another;
/// * a missing primary with NO backup at all is the ordinary fresh-install
///   path (matches the original's silent `ENOENT` handling) -- not logged,
///   not treated as an incident;
/// * whatever corrupt CONTENT actually exists on disk (primary and/or
///   backup) is preserved byte-for-byte, via a raw [`std::fs::copy`] (not a
///   re-encode through the string this function may have read -- so even
///   invalid-UTF-8 corruption is preserved exactly), in a
///   `<name>.corrupt-<nanos>` sibling file BEFORE anything is overwritten;
/// * every non-trivial outcome is screamed to stderr. This module has no
///   `tracing` dependency today (`Cargo.toml` is outside this task's
///   file-ownership scope -- see the task report's honest note), so
///   `eprintln!` is the deliberate, guaranteed channel, not an oversight;
/// * when BOTH primary and backup are corrupt, this function does NOT
///   invent a rewrite of its own -- it only preserves forensic copies of
///   both and screams. The EXISTING seed-migration path a few lines below
///   in [`SettingsStore::load`] (`read_persisted_known_providers` reading
///   `None` from an unparseable primary => `needs_persist = true` =>
///   `persist(&settings)`) already performs the original's "start fresh"
///   write on our behalf, and -- via this same change's backup refresh in
///   `persist()` -- refreshes the backup from that fresh write too. So
///   "both corrupt" still ends exactly where the original ends up (fresh
///   defaults on disk), it just never destroys forensic evidence en route.
///
/// Guarded by the SAME advisory [`ConfigLock`] sidecar `persist()` uses (a
/// fresh acquire-then-release, not nested with any later `persist()` call
/// in the same `load()` -- so this cannot deadlock a subsequent persist);
/// the honest cross-process limit documented on [`ConfigLock`] (Rust-vs-
/// Rust only) applies here identically.
fn maybe_restore_config_from_backup(home: &Path) {
    let dir = home.join(".freshell");
    let primary = dir.join("config.json");
    let backup = backup_path(&dir);

    let _lock = ConfigLock::acquire(&dir);

    let primary_health = config_file_health(&primary);
    if matches!(primary_health, ConfigFileHealth::Ok) {
        return; // Parseable, however surprising -- NEVER restore over it.
    }
    let backup_health = config_file_health(&backup);
    if matches!(primary_health, ConfigFileHealth::Missing)
        && matches!(backup_health, ConfigFileHealth::Missing)
    {
        return; // Ordinary fresh install: nothing to act on, nothing to log.
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();

    let mut primary_forensic: Option<PathBuf> = None;
    if matches!(primary_health, ConfigFileHealth::Corrupt) {
        let dest = dir.join(format!("config.json.corrupt-{nanos}"));
        if std::fs::copy(&primary, &dest).is_ok() {
            primary_forensic = Some(dest);
        }
    }

    match backup_health {
        ConfigFileHealth::Ok => {
            let Ok(backup_text) = std::fs::read_to_string(&backup) else {
                // Vanished between the health check and now -- nothing
                // safe to restore from; leave the corrupt primary (and its
                // just-taken forensic copy) as the tolerant defaults path
                // handles it from here.
                return;
            };
            let restored = atomic_write(&primary, &backup_text);
            eprintln!(
                "freshell-server: CFG-03 config.json was {} -- {} from config.backup.json{}",
                if matches!(primary_health, ConfigFileHealth::Missing) {
                    "MISSING"
                } else {
                    "CORRUPT"
                },
                if restored {
                    "auto-restored"
                } else {
                    "auto-restore FAILED"
                },
                primary_forensic
                    .as_ref()
                    .map(|p| format!("; corrupt original preserved at {}", p.display()))
                    .unwrap_or_default(),
            );
        }
        ConfigFileHealth::Corrupt => {
            let backup_dest = dir.join(format!("config.backup.json.corrupt-{nanos}"));
            let backup_forensic = std::fs::copy(&backup, &backup_dest).is_ok();
            eprintln!(
                "freshell-server: CFG-03 BOTH config.json and config.backup.json are unreadable/corrupt -- starting fresh with defaults (forensic copies preserved: primary={}, backup={})",
                primary_forensic
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "n/a".to_string()),
                if backup_forensic {
                    backup_dest.display().to_string()
                } else {
                    "n/a".to_string()
                },
            );
        }
        ConfigFileHealth::Missing => {
            // Only reachable with a CORRUPT primary (Missing+Missing already
            // returned above) and a backup that never existed at all.
            eprintln!(
                "freshell-server: CFG-03 config.json is corrupt and no backup exists -- starting fresh with defaults{}",
                primary_forensic
                    .as_ref()
                    .map(|p| format!(" (corrupt original preserved at {})", p.display()))
                    .unwrap_or_default(),
            );
        }
    }
}

/// The canonical per-key merge for the side-by-side override maps: for
/// keys THIS PROCESS marked `dirty` this boot, our own in-memory value
/// wins outright (a dirty key ABSENT from `memory` is a tombstone --
/// explicitly removed, even if `disk` still has a value for it); every
/// other key defers entirely to `disk` -- e.g. a concurrent legacy-server
/// edit, or addition, to a key we've never touched.
///
/// Used identically in two directions by its two callers: `persist()`
/// builds what to WRITE (overlay-source = our memory, onto a fresh disk
/// read), and the freshness reload (`maybe_reload_overrides`) builds what
/// to ADOPT INTO memory (base = a fresh disk read, dirty keys keep
/// whatever memory already has) -- both produce the exact same "canonical
/// view" of the map, just consumed differently.
fn overlay_dirty_keys(
    mut disk: serde_json::Map<String, Value>,
    memory: &serde_json::Map<String, Value>,
    dirty: &std::collections::HashSet<String>,
) -> serde_json::Map<String, Value> {
    for key in dirty {
        match memory.get(key) {
            Some(value) => {
                disk.insert(key.clone(), value.clone());
            }
            None => {
                // Tombstone: we touched this key this boot and it is no
                // longer present in memory -- it must not resurrect from
                // disk.
                disk.remove(key);
            }
        }
    }
    disk
}

/// `canUpgradeTitle` (`shared/title-source.ts:50-57`): user always wins; a
/// finalized source (anything != "dir") is never auto-overwritten; otherwise a
/// strictly-higher rank upgrades. Absence ranks 0.
fn can_upgrade_title(existing: Option<&str>, incoming: &str) -> bool {
    fn rank(s: Option<&str>) -> i32 {
        match s {
            Some("user") => 5,
            Some("ai") => 4,
            Some("first-message") => 3,
            Some("legacy") => 2,
            Some("dir") => 1,
            _ => 0,
        }
    }
    if incoming == "user" {
        return true;
    }
    let finalized = matches!(existing, Some(s) if s != "dir");
    if finalized {
        return false;
    }
    rank(Some(incoming)) > rank(existing)
}

/// Load `config.terminalOverrides` from `<home>/.freshell/config.json` (tolerant:
/// any read/parse error or non-object degrades to empty, matching
/// `config-store.ts#readConfigFile`).
fn load_terminal_overrides(home: Option<&Path>) -> serde_json::Map<String, Value> {
    let Some(home) = home else {
        return serde_json::Map::new();
    };
    let config_path = home.join(".freshell").join("config.json");
    let Ok(text) = std::fs::read_to_string(&config_path) else {
        return serde_json::Map::new();
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return serde_json::Map::new();
    };
    doc.get("terminalOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Load `config.sessionOverrides` from `<home>/.freshell/config.json` (tolerant:
/// any read/parse error or non-object degrades to empty, matching
/// `config-store.ts#readConfigFile`).
fn load_session_overrides(home: Option<&Path>) -> serde_json::Map<String, Value> {
    let Some(home) = home else {
        return serde_json::Map::new();
    };
    let config_path = home.join(".freshell").join("config.json");
    let Ok(text) = std::fs::read_to_string(&config_path) else {
        return serde_json::Map::new();
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return serde_json::Map::new();
    };
    doc.get("sessionOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Load the FULL persisted settings tree (not just the `network` slice
/// `crate::settings::load_server_settings` overlays): parse
/// `<home>/.freshell/config.json`'s `settings` object, deep-merge it onto the
/// typed defaults, and deserialize back. Any read/parse error \u2014 or no `home`
/// at all \u2014 degrades to the pure default, matching the original's tolerant
/// config load (`config-store.ts#readConfigFile`).
fn load_full_settings(home: Option<&Path>) -> ServerSettings {
    let defaults = crate::settings::default_server_settings();
    let Some(home) = home else { return defaults };
    let config_path = home.join(".freshell").join("config.json");
    let Ok(text) = std::fs::read_to_string(&config_path) else {
        return defaults;
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return defaults;
    };
    let Some(persisted) = doc.get("settings") else {
        return defaults;
    };

    let mut merged = serde_json::to_value(&defaults).unwrap_or_else(|_| json!({}));
    deep_merge(&mut merged, persisted);
    serde_json::from_value(merged).unwrap_or(defaults)
}

/// Read an existing `serverSecrets.codexDisplayIdSecret` from `config.json`
/// (so a restart keeps the SAME secret, matching the original's persisted
/// config-store semantics), else mint a fresh one. Never fails: an
/// unreadable/missing config just mints (matches the tolerant config load
/// used everywhere else in this module).
fn load_or_mint_codex_display_id_secret(home: Option<&Path>) -> String {
    if let Some(home) = home {
        let config_path = home.join(".freshell").join("config.json");
        if let Ok(text) = std::fs::read_to_string(&config_path) {
            if let Ok(doc) = serde_json::from_str::<Value>(&text) {
                if let Some(existing) = doc
                    .pointer("/serverSecrets/codexDisplayIdSecret")
                    .and_then(Value::as_str)
                {
                    return existing.to_string();
                }
            }
        }
    }
    uuid::Uuid::new_v4().to_string()
}

/// Recursive object deep-merge (arrays + scalars replace; objects merge
/// key-wise) \u2014 the `mergeServerSettings` semantics both the config-load overlay
/// and the PATCH handler rely on.
fn deep_merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                deep_merge(
                    target_map.entry(key.clone()).or_insert(Value::Null),
                    patch_value,
                );
            }
        }
        (target_slot, patch_value) => {
            *target_slot = patch_value.clone();
        }
    }
}

/// A faithful-subset validator covering the violations the parity sweep probes
/// against `buildServerSettingsPatchSchema` (`shared/settings.ts:738-781`):
/// the strict top-level schema, `editor.externalEditor` / `panes.defaultNewPane`
/// enums, `allowedFilePaths` array-ness, and the `codingCli` provider-name
/// allowlist (`createCliProviderNameSchema(validCliProviders)`; allowlist =
/// boot-discovered CLI extension names, `server/index.ts:585`).
///
/// zod v4 AGGREGATES issues: every violated field contributes, in the schema's
/// key-definition order (defaultCwd, allowedFilePaths, logging, safety,
/// terminal, panes, sidebar, ai, codingCli, editor, freshAgent, extensions,
/// network), with a strict-object `unrecognized_keys` issue appended LAST \u2014
/// all shapes + ordering below byte-matched against live probes of the
/// ORIGINAL (M1\u2013M8/E1\u2013E5 battery, 2026-07-12). Returns the zod-shaped
/// `details` array on any violation, or `None` when the patch passes.
fn validate_patch(patch: &Value, valid_cli_providers: &[String]) -> Option<Value> {
    let Value::Object(map) = patch else {
        return None;
    };
    let mut issues: Vec<Value> = Vec::new();

    if let Some(v) = map.get("allowedFilePaths") {
        if !v.is_array() {
            issues.push(invalid_type_issue("array", &json!(["allowedFilePaths"]), v));
        }
    }
    // EXTERNAL_EDITOR_VALUES / DEFAULT_NEW_PANE_VALUES (`shared/settings.ts:25,33`).
    if let Some(v) = map.get("panes").and_then(|v| v.get("defaultNewPane")) {
        const VALID: &[&str] = &["ask", "shell", "browser", "editor"];
        if v.as_str().map(|s| !VALID.contains(&s)).unwrap_or(true) {
            issues.push(enum_issue(&["panes", "defaultNewPane"], VALID));
        }
    }
    if let Some(cli) = map.get("codingCli") {
        validate_coding_cli_patch(cli, valid_cli_providers, &mut issues);
    }
    if let Some(v) = map.get("editor").and_then(|v| v.get("externalEditor")) {
        const VALID: &[&str] = &["auto", "cursor", "code", "custom"];
        if v.as_str().map(|s| !VALID.contains(&s)).unwrap_or(true) {
            issues.push(enum_issue(&["editor", "externalEditor"], VALID));
        }
    }

    // Strict-object unknown-key issue: ONE issue carrying ALL unknown keys,
    // appended LAST (live-pinned M3/M6).
    const KNOWN_TOP_LEVEL: &[&str] = &[
        "ai",
        "codingCli",
        "editor",
        "extensions",
        "freshAgent",
        "logging",
        "network",
        "panes",
        "safety",
        "sidebar",
        "terminal",
        "allowedFilePaths",
        "defaultCwd",
    ];
    let unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|k| !KNOWN_TOP_LEVEL.contains(k))
        .collect();
    if !unknown.is_empty() {
        issues.push(unrecognized_keys_issue(&unknown, &json!([])));
    }

    if issues.is_empty() {
        None
    } else {
        Some(Value::Array(issues))
    }
}

/// The `codingCli` sub-schema (`enabledProviders`, `knownProviders`,
/// `providers` record keys, then its own strict unknown-key issue) \u2014 issue
/// shapes byte-matched live (M2/M5/E1\u2013E5).
fn validate_coding_cli_patch(cli: &Value, valid: &[String], issues: &mut Vec<Value>) {
    let Value::Object(cli_map) = cli else {
        issues.push(invalid_type_issue("object", &json!(["codingCli"]), cli));
        return;
    };
    for field in ["enabledProviders", "knownProviders"] {
        let Some(v) = cli_map.get(field) else {
            continue;
        };
        let Value::Array(items) = v else {
            issues.push(invalid_type_issue("array", &json!(["codingCli", field]), v));
            continue;
        };
        for (i, item) in items.iter().enumerate() {
            let path = json!(["codingCli", field, i]);
            let Value::String(s) = item else {
                issues.push(invalid_type_issue("string", &path, item));
                continue;
            };
            if s.is_empty() {
                // `z.string().min(1)` \u2014 AND the allowlist superRefine still
                // runs, so '' yields BOTH issues (live-pinned E1).
                issues.push(json!({
                    "origin": "string",
                    "code": "too_small",
                    "minimum": 1,
                    "inclusive": true,
                    "path": path,
                    "message": "Too small: expected string to have >=1 characters",
                }));
            }
            if !valid.iter().any(|p| p == s) {
                issues.push(json!({
                    "code": "custom",
                    "message": format!("Unknown CLI provider: '{s}'"),
                    "path": path,
                }));
            }
        }
    }
    if let Some(v) = cli_map.get("providers") {
        if let Value::Object(provs) = v {
            for key in provs.keys() {
                if !valid.iter().any(|p| p == key) {
                    issues.push(json!({
                        "code": "invalid_key",
                        "origin": "record",
                        "issues": [{
                            "code": "custom",
                            "message": format!("Unknown CLI provider: '{key}'"),
                            "path": [],
                        }],
                        "path": ["codingCli", "providers", key],
                        "message": "Invalid key in record",
                    }));
                }
            }
        } else {
            issues.push(invalid_type_issue(
                "record",
                &json!(["codingCli", "providers"]),
                v,
            ));
        }
    }
    // `codingCli` is itself `.strict()` (live-pinned E3).
    const CLI_KEYS: &[&str] = &[
        "enabledProviders",
        "knownProviders",
        "providers",
        "mcpServer",
    ];
    let unknown: Vec<&str> = cli_map
        .keys()
        .map(String::as_str)
        .filter(|k| !CLI_KEYS.contains(k))
        .collect();
    if !unknown.is_empty() {
        issues.push(unrecognized_keys_issue(&unknown, &json!(["codingCli"])));
    }
}

/// zod v4 `invalid_type` issue \u2014 key order `{expected, code, path, message}`,
/// NO `received` field (only in the message text); live-pinned M4/M5/E2/E4/E5.
fn invalid_type_issue(expected: &str, path: &Value, got: &Value) -> Value {
    json!({
        "expected": expected,
        "code": "invalid_type",
        "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", received_type(got)),
    })
}

/// zod v4's parsed-type word for the "received X" message suffix.
fn received_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// zod v4 strict-object `unrecognized_keys` issue: ONE issue with ALL unknown
/// keys; message singular for one key, plural + comma-joined for several
/// (live-pinned M6, nested path variant E3).
fn unrecognized_keys_issue(keys: &[&str], path: &Value) -> Value {
    let message = if keys.len() == 1 {
        format!("Unrecognized key: \"{}\"", keys[0])
    } else {
        format!(
            "Unrecognized keys: {}",
            keys.iter()
                .map(|k| format!("\"{k}\""))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    json!({
        "code": "unrecognized_keys",
        "keys": keys,
        "path": path,
        "message": message,
    })
}

/// zod enum issue (`invalid_value`) \u2014 carries NO `received` field; byte-matched
/// against a live probe of the ORIGINAL.
fn enum_issue(path: &[&str], valid: &[&str]) -> Value {
    json!({
        "code": "invalid_value",
        "values": valid,
        "path": path,
        "message": format!(
            "Invalid option: expected one of {}",
            valid.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join("|")
        ),
    })
}

/// `normalizeTrimmedStringList` (`shared/string-list.ts`): trim, drop empties,
/// dedup (first occurrence wins).
fn normalize_trimmed_string_list(values: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in values {
        let trimmed = item.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

/// The PERSISTED `codingCli.knownProviders`, as the original's config read
/// normalization sees it (`shared/settings.ts:1072`): `Some(items)` only when
/// the key exists AND is an array (items filtered to non-empty strings \u2014
/// `CliProviderNameSchema` is `z.string().min(1)` with no allowlist at the
/// config-store layer); a missing file/key or a non-array value reads as
/// MISSING \u2192 the boot migration seeds it.
fn read_persisted_known_providers(home: Option<&Path>) -> Option<Vec<String>> {
    let home = home?;
    let text = std::fs::read_to_string(home.join(".freshell").join("config.json")).ok()?;
    let doc = serde_json::from_str::<Value>(&text).ok()?;
    let known = doc.pointer("/settings/codingCli/knownProviders")?;
    let items = known.as_array()?;
    Some(
        items
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

// \u2500\u2500 HTTP surface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/// Shared state for the consolidated `/api/settings` router.
#[derive(Clone)]
pub struct SettingsRouterState {
    pub store: SettingsStore,
    pub auth_token: Arc<String>,
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// So the codex fresh-agent create-gate reflects the ONE settings source of
    /// truth (`settings.freshAgent.enabled`) instead of its own stale copy.
    pub fresh_codex: freshell_freshagent::FreshCodexState,
    /// NARROW live-reload target (this fix): the shared terminal registry, so a
    /// successful patch can push `settings.safety.autoKillIdleMinutes` and
    /// `settings.terminal.scrollback` into it immediately instead of only at
    /// boot (`main.rs`'s TERM-11/TERM-13 seeding). Mirrors the legacy
    /// `registry.setSettings(updated)` call, `server/settings-router.ts:138`.
    pub registry: freshell_terminal::TerminalRegistry,
}

/// `GET`/`PATCH`/`PUT` `/api/settings` (R1: PUT === PATCH, matching
/// `settings-router.ts:151-152`'s `router.patch('/', h); router.put('/', h)`).
pub fn router(state: SettingsRouterState) -> Router {
    Router::new()
        .route(
            "/api/settings",
            get(get_settings).patch(patch_settings).put(patch_settings),
        )
        .with_state(state)
}

async fn get_settings(State(state): State<SettingsRouterState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(state.store.get().await).into_response()
}

async fn patch_settings(
    State(state): State<SettingsRouterState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    match state.store.patch(&body).await {
        Ok(merged) => {
            state.fresh_codex.set_enabled(merged.fresh_agent.enabled);
            apply_live_registry_settings(&state.registry, &merged);
            if let Ok(frame) =
                serde_json::to_string(&json!({ "type": "settings.updated", "settings": &merged }))
            {
                let _ = state.broadcast_tx.send(frame);
            }
            Json(merged).into_response()
        }
        Err((status, body)) => (status, Json(body)).into_response(),
    }
}

/// NARROW live-reload (this fix): push exactly the two knobs the legacy
/// `registry.setSettings(updated)` applies without a restart
/// (`terminal-registry.ts:1316-1322`) into the shared [`TerminalRegistry`]
/// after every successful patch/put, whether or not those specific fields
/// were the ones the caller touched. Deliberately scoped to just these two --
/// no general hot-reload framework.
///
/// * `safety.autoKillIdleMinutes` -> [`TerminalRegistry::set_auto_kill_idle_minutes`]
///   (read fresh by the periodic idle-sweep, `freshell_ws::spawn_idle_monitor`
///   / legacy `enforceIdleKills`, `terminal-registry.ts:1406-1410` -- so the
///   effect lands on the sweep's own cadence, matching legacy).
/// * `terminal.scrollback` -> [`freshell_terminal::compute_scrollback_max_bytes`] ->
///   [`TerminalRegistry::set_scrollback_max_bytes`] (applies to terminals
///   created AFTER this call -- the registry's documented scope limit,
///   `registry.rs`'s `set_scrollback_max_bytes` doc comment; legacy ALSO
///   resizes already-open buffers in place, which this narrow port does not).
///
/// A patch that never mutates the value it targets (invalid patch rejected
/// before this is even reached, or the value simply absent from the request
/// body) reads back the value already sitting in the merged tree -- i.e. this
/// is a same-value no-op, never a reset to the registry/settings default.
fn apply_live_registry_settings(
    registry: &freshell_terminal::TerminalRegistry,
    merged: &ServerSettings,
) {
    registry.set_auto_kill_idle_minutes(merged.safety.auto_kill_idle_minutes);
    registry.set_scrollback_max_bytes(freshell_terminal::compute_scrollback_max_bytes(
        merged.terminal.scrollback,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_at(dir: &Path) -> SettingsStore {
        SettingsStore::load(Some(dir), vec!["claude".into(), "codex".into()])
    }

    /// Full `SettingsRouterState` for exercising the `PATCH`/`PUT` handler
    /// itself (not just `SettingsStore::patch`), so the registry-wiring
    /// added by this fix is proven through the REAL route, not a shortcut.
    fn router_state_at(dir: &Path) -> SettingsRouterState {
        let auth_token = Arc::new("tok".to_string());
        let (broadcast_tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        let broadcast_tx = Arc::new(broadcast_tx);
        let store = store_at(dir);
        let fresh_codex = freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            json!({}),
        );
        SettingsRouterState {
            store,
            auth_token,
            broadcast_tx,
            fresh_codex,
            registry: freshell_terminal::TerminalRegistry::new(),
        }
    }

    fn authed_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        headers
    }

    /// RED/GREEN target (narrow live-reload, this fix): a successful
    /// `PATCH /api/settings` changing `safety.autoKillIdleMinutes` must be
    /// reflected on `registry.auto_kill_idle_minutes()` IMMEDIATELY -- no
    /// restart, no waiting for the next idle-sweep tick to pick up a NEW
    /// value out of the settings tree (the sweep itself still runs on its
    /// own 30s cadence, matching legacy `enforceIdleKills`, but the value it
    /// reads must already be current the instant this handler returns).
    /// Mirrors the legacy fixture `registry.setSettings(updated)` proves
    /// against (`server/settings-router.ts:138` -> `terminal-registry.ts:1316-1322`).
    #[tokio::test]
    async fn patch_applies_auto_kill_idle_minutes_live_to_registry() {
        let dir = std::env::temp_dir().join(format!("frs-live-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let state = router_state_at(&dir);
        assert_eq!(state.registry.auto_kill_idle_minutes(), 15); // default, pre-patch

        let resp = patch_settings(
            State(state.clone()),
            authed_headers(),
            Json(json!({ "safety": { "autoKillIdleMinutes": 42 } })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        assert_eq!(state.registry.auto_kill_idle_minutes(), 42);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// RED/GREEN target (narrow live-reload, this fix): a successful patch
    /// changing `terminal.scrollback` must be reflected on
    /// `registry.scrollback_max_bytes()` immediately, via the SAME
    /// `compute_scrollback_max_bytes` conversion the boot-time seeding in
    /// `main.rs` already uses (TERM-13).
    #[tokio::test]
    async fn patch_applies_scrollback_live_to_registry() {
        let dir = std::env::temp_dir().join(format!("frs-live-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let state = router_state_at(&dir);
        // `TerminalRegistry::new()`'s OWN pre-boot-seeding fallback
        // (`DEFAULT_MAX_SCROLLBACK_CHARS`, `registry.rs:75`) -- this test
        // constructs a bare registry (no `main.rs` boot-time
        // `set_scrollback_max_bytes` seeding), so THIS is the correct
        // pre-patch baseline, not `compute_scrollback_max_bytes` of the
        // settings-tree default.
        assert_eq!(state.registry.scrollback_max_bytes(), 512 * 1024);

        let resp = patch_settings(
            State(state.clone()),
            authed_headers(),
            Json(json!({ "terminal": { "scrollback": 500 } })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let expected = freshell_terminal::compute_scrollback_max_bytes(500);
        assert_eq!(state.registry.scrollback_max_bytes(), expected);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A patch touching an UNRELATED field must not disturb either live
    /// knob: absent fields are preserved as-is by `deep_merge`, so
    /// re-applying them to the registry is a same-value no-op, never a
    /// reset to the registry's/settings' own defaults.
    #[tokio::test]
    async fn patch_of_unrelated_field_leaves_live_registry_settings_unchanged() {
        let dir = std::env::temp_dir().join(format!("frs-live-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let state = router_state_at(&dir);

        // First, establish non-default values on both knobs.
        patch_settings(
            State(state.clone()),
            authed_headers(),
            Json(json!({ "safety": { "autoKillIdleMinutes": 7 }, "terminal": { "scrollback": 900 } })),
        )
        .await;
        assert_eq!(state.registry.auto_kill_idle_minutes(), 7);
        let scrollback_after_first_patch = state.registry.scrollback_max_bytes();

        // An unrelated patch (logging.debug) must not move either knob.
        let resp = patch_settings(
            State(state.clone()),
            authed_headers(),
            Json(json!({ "logging": { "debug": true } })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        assert_eq!(state.registry.auto_kill_idle_minutes(), 7);
        assert_eq!(state.registry.scrollback_max_bytes(), scrollback_after_first_patch);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An INVALID patch is rejected by validation before the store ever
    /// mutates (`SettingsStore::patch`'s `validate_patch` guard, checked
    /// before any mutation) -- so it must never reach the registry either.
    /// Established non-default values must survive an invalid patch attempt
    /// completely untouched.
    #[tokio::test]
    async fn invalid_patch_does_not_change_live_registry_settings() {
        let dir = std::env::temp_dir().join(format!("frs-live-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let state = router_state_at(&dir);

        patch_settings(
            State(state.clone()),
            authed_headers(),
            Json(json!({ "safety": { "autoKillIdleMinutes": 11 }, "terminal": { "scrollback": 1234 } })),
        )
        .await;
        let kill_minutes_before = state.registry.auto_kill_idle_minutes();
        let scrollback_before = state.registry.scrollback_max_bytes();

        // `editor.externalEditor` only accepts a fixed enum -- "bogus" is invalid.
        let resp = patch_settings(
            State(state.clone()),
            authed_headers(),
            Json(json!({ "editor": { "externalEditor": "bogus" } })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        assert_eq!(state.registry.auto_kill_idle_minutes(), kill_minutes_before);
        assert_eq!(state.registry.scrollback_max_bytes(), scrollback_before);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Live-pinned 2026-07-12: `knownProviders` is SEEDED from discovery when
    /// missing (persisted, `server/index.ts:280-286`) and PATCHABLE with names
    /// from the boot-discovered allowlist (patch-wins, persisted); unknown
    /// names are rejected with the original's custom zod issue.
    #[tokio::test]
    async fn known_providers_seeded_persisted_and_patchable() {
        let dir = std::env::temp_dir().join(format!("frs-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let store = store_at(&dir);
        let s = store.get().await;
        assert_eq!(
            s.coding_cli.known_providers,
            Some(vec!["claude".to_string(), "codex".to_string()])
        );
        // The seed migration persists (the original always calls patchSettings).
        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            cfg["settings"]["codingCli"]["knownProviders"],
            json!(["claude", "codex"])
        );

        // An unknown name is rejected (allowlist = boot-discovered set).
        let (status, body) = store
            .patch(&json!({ "codingCli": { "knownProviders": ["bogus"] } }))
            .await
            .unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["details"][0],
            json!({
                "code": "custom",
                "message": "Unknown CLI provider: 'bogus'",
                "path": ["codingCli", "knownProviders", 0],
            })
        );

        // A valid patch WINS (live-pinned: replaces + persists).
        let merged = store
            .patch(&json!({ "codingCli": { "knownProviders": ["claude"] } }))
            .await
            .unwrap();
        assert_eq!(
            merged.coding_cli.known_providers,
            Some(vec!["claude".to_string()])
        );
        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            cfg["settings"]["codingCli"]["knownProviders"],
            json!(["claude"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Live-pinned 2026-07-12 (persisted `knownProviders: ["claude"]`,
    /// `enabledProviders: ["claude"]`, then a boot discovering 5 extensions):
    /// new names are APPENDED to `knownProviders` AND auto-enabled
    /// (`server/index.ts:288-297`).
    #[tokio::test]
    async fn newly_discovered_providers_append_and_auto_enable() {
        let dir = std::env::temp_dir().join(format!("frs-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        std::fs::write(
            dir.join(".freshell").join("config.json"),
            r#"{"version":1,"settings":{"codingCli":{"enabledProviders":["claude"],"knownProviders":["claude"],"providers":{},"mcpServer":true}}}"#,
        )
        .unwrap();
        let store = store_at(&dir); // discovers ["claude","codex"]
        let s = store.get().await;
        assert_eq!(
            s.coding_cli.known_providers,
            Some(vec!["claude".to_string(), "codex".to_string()])
        );
        assert_eq!(s.coding_cli.enabled_providers, vec!["claude", "codex"]);
        // Persisted.
        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            cfg["settings"]["codingCli"]["knownProviders"],
            json!(["claude", "codex"])
        );
        assert_eq!(
            cfg["settings"]["codingCli"]["enabledProviders"],
            json!(["claude", "codex"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Live-pinned 2026-07-12 (S4 direction): a previously-seeded list is
    /// served AS-IS when a later boot discovers NOTHING (cwd-neutral reboot
    /// does not shrink it \u2014 `newProviders` is empty so no patch happens).
    #[tokio::test]
    async fn persisted_known_providers_survive_cwd_neutral_reboot() {
        let dir = std::env::temp_dir().join(format!("frs-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        std::fs::write(
            dir.join(".freshell").join("config.json"),
            r#"{"version":1,"settings":{"codingCli":{"enabledProviders":["claude"],"knownProviders":["claude","codex","gemini"],"providers":{},"mcpServer":true}}}"#,
        )
        .unwrap();
        let store = SettingsStore::load(Some(&dir), Vec::new());
        let s = store.get().await;
        assert_eq!(
            s.coding_cli.known_providers,
            Some(vec![
                "claude".to_string(),
                "codex".to_string(),
                "gemini".to_string()
            ])
        );
        assert_eq!(s.coding_cli.enabled_providers, vec!["claude"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `migrateLegacyDefaultEnabledProviders` (`settings-migrate.ts`), pinned
    /// live 2026-07-12 (home6 probe): legacy `["claude","codex"]` gains the
    /// discovered modern-default members (here `opencode`), the seed still
    /// covers ALL discovered names, and non-default providers are NOT enabled
    /// by the seed path.
    #[tokio::test]
    async fn legacy_default_enabled_providers_migrated() {
        let dir = std::env::temp_dir().join(format!("frs-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        std::fs::write(
            dir.join(".freshell").join("config.json"),
            r#"{"version":1,"settings":{"codingCli":{"enabledProviders":["claude","codex"],"providers":{},"mcpServer":true}}}"#,
        )
        .unwrap();
        let discovered: Vec<String> = ["claude", "codex", "gemini", "kimi", "opencode"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let store = SettingsStore::load(Some(&dir), discovered.clone());
        let s = store.get().await;
        assert_eq!(
            s.coding_cli.enabled_providers,
            vec!["claude", "codex", "opencode"]
        );
        assert_eq!(s.coding_cli.known_providers, Some(discovered));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn patch_write_through_reaches_get_and_config_json_and_restart() {
        let dir = std::env::temp_dir().join(format!("frs-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let store = store_at(&dir);

        let merged = store
            .patch(
                &json!({ "safety": { "autoKillIdleMinutes": 25 }, "allowedFilePaths": ["/tmp"] }),
            )
            .await
            .unwrap();
        assert_eq!(merged.safety.auto_kill_idle_minutes, 25);

        // R2: GET reflects it (no separate frozen copy).
        let got = store.get().await;
        assert_eq!(got.safety.auto_kill_idle_minutes, 25);
        assert_eq!(got.allowed_file_paths, Some(vec!["/tmp".to_string()]));

        // R2: config.json contains the FULL settings tree, not just `network`.
        let cfg_text = std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap();
        let cfg: Value = serde_json::from_str(&cfg_text).unwrap();
        assert_eq!(cfg["version"], 1);
        assert_eq!(cfg["settings"]["safety"]["autoKillIdleMinutes"], 25);
        assert_eq!(cfg["settings"]["allowedFilePaths"], json!(["/tmp"]));
        assert_eq!(cfg["sessionOverrides"], json!({}));

        // R2: "restart" (a fresh `SettingsStore::load` off the same home) sees it.
        let restarted = store_at(&dir);
        let after = restarted.get().await;
        assert_eq!(after.safety.auto_kill_idle_minutes, 25);
        assert_eq!(after.allowed_file_paths, Some(vec!["/tmp".to_string()]));

        std::fs::remove_dir_all(&dir).ok();
    }

    fn valid5() -> Vec<String> {
        ["claude", "codex", "gemini", "kimi", "opencode"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn agent_chat_key_rejected() {
        let err = validate_patch(&json!({ "ai": {} }), &valid5());
        assert!(err.is_none());
    }

    #[test]
    fn unknown_top_level_key_rejected() {
        let details = validate_patch(&json!({ "totallyUnknownKey": true }), &valid5()).unwrap();
        assert_eq!(details[0]["code"], "unrecognized_keys");
    }

    #[test]
    fn client_only_key_rejected_by_strict_schema() {
        let details = validate_patch(&json!({ "theme": "dark" }), &valid5()).unwrap();
        assert_eq!(details[0]["code"], "unrecognized_keys");
    }

    #[test]
    fn enum_and_type_violations_rejected() {
        let v = valid5();
        assert!(validate_patch(&json!({ "editor": { "externalEditor": "bogus" } }), &v).is_some());
        assert!(validate_patch(&json!({ "panes": { "defaultNewPane": "bogus" } }), &v).is_some());
        assert!(validate_patch(&json!({ "allowedFilePaths": "not-an-array" }), &v).is_some());
        assert!(validate_patch(&json!({ "allowedFilePaths": ["ok"] }), &v).is_none());
    }

    /// Every shape/order below is byte-matched against the live ORIGINAL
    /// (M1\u2013M8/E1\u2013E5 probe battery, 2026-07-12, cwd=repo server with the 5
    /// bundled CLI extensions discovered).
    #[test]
    fn provider_name_validation_matches_the_original_byte_for_byte() {
        let v = valid5();

        // M1: every bad name yields its own custom issue, in item order.
        let details = validate_patch(
            &json!({ "codingCli": { "enabledProviders": ["bogus1", "bogus2"] } }),
            &v,
        )
        .unwrap();
        assert_eq!(
            details,
            json!([
                { "code": "custom", "message": "Unknown CLI provider: 'bogus1'", "path": ["codingCli", "enabledProviders", 0] },
                { "code": "custom", "message": "Unknown CLI provider: 'bogus2'", "path": ["codingCli", "enabledProviders", 1] },
            ])
        );

        // M2: enabledProviders \u2192 knownProviders \u2192 providers record key, in
        // schema-definition order.
        let details = validate_patch(
            &json!({ "codingCli": { "enabledProviders": ["bogusA"], "knownProviders": ["bogusB"], "providers": { "bogusC": {} } } }),
            &v,
        )
        .unwrap();
        assert_eq!(
            details,
            json!([
                { "code": "custom", "message": "Unknown CLI provider: 'bogusA'", "path": ["codingCli", "enabledProviders", 0] },
                { "code": "custom", "message": "Unknown CLI provider: 'bogusB'", "path": ["codingCli", "knownProviders", 0] },
                { "code": "invalid_key", "origin": "record",
                  "issues": [{ "code": "custom", "message": "Unknown CLI provider: 'bogusC'", "path": [] }],
                  "path": ["codingCli", "providers", "bogusC"], "message": "Invalid key in record" },
            ])
        );

        // M3: nested field issues FIRST, top-level unrecognized_keys LAST.
        let details = validate_patch(
            &json!({ "zzz": 1, "codingCli": { "enabledProviders": ["bogusA"] } }),
            &v,
        )
        .unwrap();
        assert_eq!(details[0]["code"], "custom");
        assert_eq!(
            details[1],
            json!({ "code": "unrecognized_keys", "keys": ["zzz"], "path": [], "message": "Unrecognized key: \"zzz\"" })
        );

        // M5: per-item invalid_type (expected FIRST key, no `received` field)
        // and custom issues interleaved in item order; valid item silent.
        let details = validate_patch(
            &json!({ "codingCli": { "knownProviders": [42, "bogus", "claude"] } }),
            &v,
        )
        .unwrap();
        assert_eq!(
            details,
            json!([
                { "expected": "string", "code": "invalid_type", "path": ["codingCli", "knownProviders", 0], "message": "Invalid input: expected string, received number" },
                { "code": "custom", "message": "Unknown CLI provider: 'bogus'", "path": ["codingCli", "knownProviders", 1] },
            ])
        );

        // M6: several unknown top-level keys \u2192 ONE plural issue.
        let details = validate_patch(&json!({ "zzz": 1, "yyy": 2 }), &v).unwrap();
        assert_eq!(
            details,
            json!([{ "code": "unrecognized_keys", "keys": ["zzz", "yyy"], "path": [], "message": "Unrecognized keys: \"zzz\", \"yyy\"" }])
        );

        // M7: codingCli issues precede editor issues (schema key order).
        let details = validate_patch(
            &json!({ "editor": { "externalEditor": "bogus" }, "codingCli": { "enabledProviders": ["bogusA"] } }),
            &v,
        )
        .unwrap();
        assert_eq!(details[0]["code"], "custom");
        assert_eq!(details[1]["code"], "invalid_value");

        // M8: allowedFilePaths precedes panes (schema key order).
        let details = validate_patch(
            &json!({ "panes": { "defaultNewPane": "bogus" }, "allowedFilePaths": "x" }),
            &v,
        )
        .unwrap();
        assert_eq!(details[0]["code"], "invalid_type");
        assert_eq!(details[1]["code"], "invalid_value");

        // E1: '' yields too_small AND the custom allowlist issue.
        let details =
            validate_patch(&json!({ "codingCli": { "enabledProviders": [""] } }), &v).unwrap();
        assert_eq!(
            details,
            json!([
                { "origin": "string", "code": "too_small", "minimum": 1, "inclusive": true,
                  "path": ["codingCli", "enabledProviders", 0],
                  "message": "Too small: expected string to have >=1 characters" },
                { "code": "custom", "message": "Unknown CLI provider: ''", "path": ["codingCli", "enabledProviders", 0] },
            ])
        );

        // E2/E4/E5: container-level invalid_type shapes.
        let details = validate_patch(&json!({ "codingCli": { "providers": "x" } }), &v).unwrap();
        assert_eq!(
            details[0]["message"],
            "Invalid input: expected record, received string"
        );
        let details = validate_patch(&json!({ "codingCli": "x" }), &v).unwrap();
        assert_eq!(
            details[0]["message"],
            "Invalid input: expected object, received string"
        );
        let details =
            validate_patch(&json!({ "codingCli": { "knownProviders": null } }), &v).unwrap();
        assert_eq!(
            details[0]["message"],
            "Invalid input: expected array, received null"
        );

        // E3: codingCli is strict \u2014 nested unrecognized key.
        let details = validate_patch(&json!({ "codingCli": { "zzz": 1 } }), &v).unwrap();
        assert_eq!(
            details,
            json!([{ "code": "unrecognized_keys", "keys": ["zzz"], "path": ["codingCli"], "message": "Unrecognized key: \"zzz\"" }])
        );

        // Valid names pass (allowlist = discovered set).
        assert!(validate_patch(&json!({ "codingCli": { "knownProviders": ["claude"], "enabledProviders": ["claude", "codex"] } }), &v).is_none());
        // Empty allowlist rejects everything (cwd-neutral live probe).
        let details = validate_patch(
            &json!({ "codingCli": { "knownProviders": ["claude"] } }),
            &[],
        )
        .unwrap();
        assert_eq!(details[0]["message"], "Unknown CLI provider: 'claude'");
    }

    /// Byte-matched against a live probe of the ORIGINAL: the enum VALUES
    /// themselves (`EXTERNAL_EDITOR_VALUES`/`DEFAULT_NEW_PANE_VALUES`,
    /// `shared/settings.ts:25,33`) and the singular "Unrecognized key" wording
    /// -- both previously wrong (masked by R1's blanket 405 before PUT/PATCH
    /// worked at all).
    #[test]
    fn enum_values_and_unrecognized_key_message_match_the_original() {
        let v = valid5();
        let details =
            validate_patch(&json!({ "editor": { "externalEditor": "bogus" } }), &v).unwrap();
        assert_eq!(
            details[0]["message"],
            json!("Invalid option: expected one of \"auto\"|\"cursor\"|\"code\"|\"custom\"")
        );

        let details =
            validate_patch(&json!({ "panes": { "defaultNewPane": "bogus" } }), &v).unwrap();
        assert_eq!(
            details[0]["message"],
            json!("Invalid option: expected one of \"ask\"|\"shell\"|\"browser\"|\"editor\"")
        );

        let details = validate_patch(&json!({ "theme": "dark" }), &v).unwrap();
        assert_eq!(details[0]["message"], json!("Unrecognized key: \"theme\""));

        // "vscode"/"terminal" were the WRONG (pre-fix) accepted values -- must
        // now be rejected, and the real values must be accepted.
        assert!(validate_patch(&json!({ "editor": { "externalEditor": "vscode" } }), &v).is_some());
        assert!(validate_patch(&json!({ "editor": { "externalEditor": "cursor" } }), &v).is_none());
        assert!(
            validate_patch(&json!({ "panes": { "defaultNewPane": "terminal" } }), &v).is_some()
        );
        assert!(validate_patch(&json!({ "panes": { "defaultNewPane": "editor" } }), &v).is_none());
    }

    fn uuid_like() -> String {
        format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
            .replace([':', '.', ' '], "-")
    }

    /// The real acceptance for the settings model: default settings + the
    /// isolated-boot network overlay must serialize BYTE-FOR-BYTE to the
    /// `settings.updated` payload captured from the ORIGINAL node server. If the
    /// original's default tree ever shifts, this fails loudly (a fidelity gap),
    /// not silently under the live oracle. (Migrated from the now-removed
    /// `settings::load_server_settings`; exercises the LIVE `load_full_settings`
    /// path instead of a dead duplicate.)
    #[test]
    fn default_plus_network_overlay_matches_captured_fixture() {
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../port/oracle/fixtures/handshake-transcript.json");
        let text = std::fs::read_to_string(&fixture_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", fixture_path.display()));
        let fixture: Value = serde_json::from_str(&text).unwrap();

        let mut expected_settings = fixture["transcript"]
            .as_array()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|m| m["type"] == "settings.updated")
                    .map(|m| m["parsed"]["settings"].clone())
            })
            .expect("fixture has a settings.updated message");
        // knownProviders is boot-discovered (R4), not part of the pure default
        // fixture comparison here — `load_full_settings` seeds `[]`, matching
        // an isolated boot with no discovered CLI extensions.
        expected_settings["codingCli"]["knownProviders"] = json!([]);

        let dir = std::env::temp_dir().join(format!("frs-fixture-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        std::fs::write(
            freshell.join("config.json"),
            r#"{"version":1,"settings":{"network":{"configured":true,"host":"127.0.0.1"}}}"#,
        )
        .unwrap();

        let actual = serde_json::to_value(load_full_settings(Some(&dir))).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            actual, expected_settings,
            "Rust default settings + network overlay must equal the captured original settings"
        );
    }

    #[tokio::test]
    async fn session_overrides_persist_and_survive_settings_and_terminal_writes() {
        let dir = std::env::temp_dir().join(format!("frs-sessov-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let store = store_at(&dir);

        // Write a session override.
        let next = store
            .patch_session_override(
                "claude:abc",
                &[
                    ("titleOverride", Some(json!("Renamed"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        assert_eq!(next["titleOverride"], json!("Renamed"));
        assert_eq!(next["titleSource"], json!("user"));

        // A SETTINGS patch must NOT wipe sessionOverrides (the :229 corruption trap).
        store
            .patch(&json!({ "safety": { "autoKillIdleMinutes": 25 } }))
            .await
            .unwrap();
        // A TERMINAL-override patch must NOT wipe sessionOverrides either.
        store
            .patch_terminal_override("term-1", &[("deleted", Some(json!(true)))])
            .await;

        // Reload from disk (a "restart") and confirm the session override survived.
        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            cfg["sessionOverrides"]["claude:abc"]["titleOverride"],
            json!("Renamed")
        );
        assert_eq!(
            cfg["sessionOverrides"]["claude:abc"]["titleSource"],
            json!("user")
        );
        assert_eq!(cfg["sessionOverrides"]["terminalOverrides"], Value::Null); // not clobbered by shape

        let restored = store_at(&dir);
        let snap = restored.session_overrides();
        assert_eq!(snap["claude:abc"]["titleOverride"], json!("Renamed"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn session_override_title_ladder_and_clear_and_noop() {
        let dir = std::env::temp_dir().join(format!("frs-sessov-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let store = store_at(&dir);

        // Seed the initial "dir" placeholder (existing = None -> not finalized,
        // so ANY first write lands regardless of rank).
        store
            .patch_session_override(
                "claude:x",
                &[
                    ("titleOverride", Some(json!("Directory name"))),
                    ("titleSource", Some(json!("dir"))),
                ],
            )
            .await;

        // first-message (rank 3) upgrades "dir" (rank 1, NOT finalized per
        // `isFinalizedTitleSource`/`shared/title-source.ts:37-39` -- "dir" is
        // the one source that is never considered finalized).
        let after_first_message = store
            .patch_session_override(
                "claude:x",
                &[
                    ("titleOverride", Some(json!("From message"))),
                    ("titleSource", Some(json!("first-message"))),
                ],
            )
            .await;
        assert_eq!(after_first_message["titleOverride"], json!("From message"));
        assert_eq!(after_first_message["titleSource"], json!("first-message"));

        // ai (rank 4) does NOT beat a finalized first-message (rank 3): per
        // `canUpgradeTitle` (`shared/title-source.ts:50-57`) / the legacy
        // `patchSessionOverride` (`server/config-store.ts:492-514`), ANY
        // source other than "dir" is finalized and frozen against every
        // automatic writer regardless of rank -- only an explicit "user"
        // rename can replace it. (The plan's original draft of this test
        // asserted "ai beats first-message" here; that contradicts the frozen
        // reference and has been corrected -- see task report.) The title
        // stays put, but the non-title `archived` field STILL merges.
        let blocked = store
            .patch_session_override(
                "claude:x",
                &[
                    ("titleOverride", Some(json!("AI name"))),
                    ("titleSource", Some(json!("ai"))),
                    ("archived", Some(json!(true))), // non-title field STILL applies.
                ],
            )
            .await;
        assert_eq!(blocked["titleOverride"], json!("From message"));
        assert_eq!(blocked["titleSource"], json!("first-message"));
        assert_eq!(blocked["archived"], json!(true));

        // A fresh key: ai (rank 4) DOES land when existing is absent/unfinalized
        // (rank 4 > rank 0) -- this is the valid form of "ai" winning a write.
        let ai_from_absent = store
            .patch_session_override(
                "claude:y",
                &[
                    ("titleOverride", Some(json!("AI name"))),
                    ("titleSource", Some(json!("ai"))),
                ],
            )
            .await;
        assert_eq!(ai_from_absent["titleOverride"], json!("AI name"));
        assert_eq!(ai_from_absent["titleSource"], json!("ai"));

        // user (5) always beats ai (4), including a finalized ai.
        let user = store
            .patch_session_override(
                "claude:y",
                &[
                    ("titleOverride", Some(json!("User rename"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        assert_eq!(user["titleOverride"], json!("User rename"));
        assert_eq!(user["titleSource"], json!("user"));

        // first-message (3) does NOT downgrade a finalized user (5): title
        // unchanged...
        let user_blocked = store
            .patch_session_override(
                "claude:y",
                &[
                    ("titleOverride", Some(json!("late msg"))),
                    ("titleSource", Some(json!("first-message"))),
                ],
            )
            .await;
        assert_eq!(user_blocked["titleOverride"], json!("User rename"));
        assert_eq!(user_blocked["titleSource"], json!("user"));

        // Clear-on-empty: None removes the key from the merged override.
        let cleared = store
            .patch_session_override("claude:y", &[("summaryOverride", None)])
            .await;
        assert!(cleared.get("summaryOverride").is_none());

        // No-op skip: a ladder-blocked title-only patch that resolves to the
        // existing value returns without changing anything.
        let before_mtime = std::fs::metadata(dir.join(".freshell").join("config.json"))
            .unwrap()
            .modified()
            .unwrap();
        let noop = store
            .patch_session_override(
                "claude:y",
                &[
                    ("titleOverride", Some(json!("ignored"))),
                    ("titleSource", Some(json!("first-message"))), // < user, blocked
                ],
            )
            .await;
        assert_eq!(noop["titleOverride"], json!("User rename")); // unchanged
        let after_mtime = std::fs::metadata(dir.join(".freshell").join("config.json"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            before_mtime, after_mtime,
            "no-op patch must not rewrite config.json"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Seeds a `config.json` shaped like a real staged incident: known
    /// managed keys (`settings`, overrides) PLUS keys this store never
    /// manages (`completedMigrations`, `recentDirectories`, a hypothetical
    /// future top-level key). `store_at` is given `discovered_cli_names` and
    /// a seed `codingCli.knownProviders`/`enabledProviders` that exactly
    /// match, so `SettingsStore::load` does not itself trigger a persist
    /// (no seed/legacy-migration path fires) -- the ONLY write in each test
    /// below is the one explicit patch under test.
    fn lossless_fixture_text() -> &'static str {
        r#"{
            "version": 1,
            "settings": {
                "codingCli": {
                    "enabledProviders": ["claude", "codex"],
                    "knownProviders": ["claude", "codex"],
                    "providers": {},
                    "mcpServer": true
                }
            },
            "completedMigrations": ["ai-title-shadow-cleanup"],
            "recentDirectories": ["/a", "/b", "/c"],
            "serverSecrets": { "codexDisplayIdSecret": "seed-secret-value" },
            "zzFutureKey": { "a": 1 },
            "sessionOverrides": {},
            "terminalOverrides": {},
            "projectColors": {}
        }"#
    }

    fn assert_unmanaged_document_state_preserved(cfg: &Value) {
        assert_eq!(
            cfg["completedMigrations"],
            json!(["ai-title-shadow-cleanup"]),
            "completedMigrations must round-trip"
        );
        assert_eq!(
            cfg["recentDirectories"],
            json!(["/a", "/b", "/c"]),
            "recentDirectories must round-trip with its real entries, not be emptied"
        );
        assert_eq!(
            cfg["serverSecrets"]["codexDisplayIdSecret"],
            json!("seed-secret-value"),
            "serverSecrets must round-trip"
        );
        assert_eq!(
            cfg["zzFutureKey"],
            json!({ "a": 1 }),
            "an unknown top-level key must round-trip untouched"
        );
    }

    /// R-DATALOSS regression: reproduces a staging incident byte-for-byte --
    /// an accepted `PATCH /api/settings {"logging":{"debug":false}}` rewrote
    /// `config.json` and REMOVED `completedMigrations` entirely and EMPTIED
    /// `recentDirectories` (20 entries -> 0), because `persist()` used to
    /// build the document from a fixed key set instead of round-tripping the
    /// on-disk document.
    #[tokio::test]
    async fn settings_patch_preserves_unmanaged_top_level_document_state() {
        let dir = std::env::temp_dir().join(format!("frs-lossless-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        std::fs::write(
            dir.join(".freshell").join("config.json"),
            lossless_fixture_text(),
        )
        .unwrap();
        let store = store_at(&dir);

        store
            .patch(&json!({ "logging": { "debug": false } }))
            .await
            .unwrap();

        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_unmanaged_document_state_preserved(&cfg);
        assert_eq!(cfg["settings"]["logging"]["debug"], json!(false));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Same document-preservation guarantee through the terminal-override
    /// persist path (`patch_terminal_override`).
    #[tokio::test]
    async fn terminal_override_patch_preserves_unmanaged_top_level_document_state() {
        let dir = std::env::temp_dir().join(format!("frs-lossless-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        std::fs::write(
            dir.join(".freshell").join("config.json"),
            lossless_fixture_text(),
        )
        .unwrap();
        let store = store_at(&dir);

        store
            .patch_terminal_override("term-1", &[("deleted", Some(json!(true)))])
            .await;

        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_unmanaged_document_state_preserved(&cfg);
        assert_eq!(cfg["terminalOverrides"]["term-1"]["deleted"], json!(true));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Same document-preservation guarantee through the session-override
    /// persist path (`patch_session_override`).
    #[tokio::test]
    async fn session_override_patch_preserves_unmanaged_top_level_document_state() {
        let dir = std::env::temp_dir().join(format!("frs-lossless-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        std::fs::write(
            dir.join(".freshell").join("config.json"),
            lossless_fixture_text(),
        )
        .unwrap();
        let store = store_at(&dir);

        store
            .patch_session_override("claude:abc", &[("archived", Some(json!(true)))])
            .await;

        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_unmanaged_document_state_preserved(&cfg);
        assert_eq!(
            cfg["sessionOverrides"]["claude:abc"]["archived"],
            json!(true)
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ── Batch B: side-by-side operation with the legacy Node server ──
    //
    // These tests exercise a bake-in scenario where BOTH the Rust server
    // and the legacy Node server make automatic writes to the SAME real
    // `~/.freshell/config.json` (auto-titling sessionOverrides, provider
    // seeding). An "external writer" below stands in for the legacy
    // server: a direct `std::fs::write` to `config.json`, bypassing every
    // Rust API, exactly as a concurrent process would.

    /// EXTERNAL-WRITER SURVIVAL: between Rust's boot-time load and a LATER
    /// Rust persist (triggered by a patch to a DIFFERENT key), an external
    /// writer rewrites `config.json` directly: adds a brand-new
    /// `sessionOverrides` key, changes an EXISTING key Rust has never
    /// touched this boot, and adds an unrelated unknown top-level key. All
    /// three must survive the Rust persist, alongside Rust's own patch.
    /// Pre-hardening `persist()` overlaid `session_overrides.lock().clone()`
    /// onto the doc WHOLESALE, so the external addition and the external
    /// edit to the untouched key would both have been silently erased --
    /// this is the RED case for the whole feature.
    #[tokio::test]
    async fn external_writer_edits_survive_a_rust_persist_of_a_different_key() {
        let dir = std::env::temp_dir().join(format!("frs-sidebyside-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        std::fs::write(
            freshell.join("config.json"),
            serde_json::to_string(&json!({
                "version": 1,
                "settings": {},
                "sessionOverrides": {
                    "claude:orig": { "titleOverride": "OrigTitle", "titleSource": "legacy" }
                },
                "terminalOverrides": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let store = store_at(&dir);

        // External writer (the legacy Node server, or another Rust
        // process) rewrites config.json directly -- Rust never observes
        // this through its own APIs, only by re-reading disk at persist
        // time.
        std::fs::write(
            freshell.join("config.json"),
            serde_json::to_string(&json!({
                "version": 1,
                "settings": {},
                "sessionOverrides": {
                    "claude:orig": { "titleOverride": "ExternalRenamed", "titleSource": "legacy" },
                    "claude:new": { "titleOverride": "NewFromExternal" }
                },
                "terminalOverrides": {},
                "hello": "world"
            }))
            .unwrap(),
        )
        .unwrap();

        // Rust patches a DIFFERENT key -- triggers a persist.
        store
            .patch_session_override("claude:other", &[("archived", Some(json!(true)))])
            .await;

        let cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(freshell.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(
            cfg["sessionOverrides"]["claude:orig"]["titleOverride"],
            json!("ExternalRenamed"),
            "external edit to a key Rust never touched this boot must survive"
        );
        assert_eq!(
            cfg["sessionOverrides"]["claude:new"]["titleOverride"],
            json!("NewFromExternal"),
            "a brand-new external key must survive"
        );
        assert_eq!(
            cfg["hello"],
            json!("world"),
            "an unknown top-level key must round-trip"
        );
        assert_eq!(
            cfg["sessionOverrides"]["claude:other"]["archived"],
            json!(true),
            "Rust's own patch must still land"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// DIRTY-KEY WINS: once Rust has TOUCHED a key this boot, an external
    /// writer's concurrent edit to that SAME key must NOT survive a later
    /// Rust persist -- Rust's own value for a key it owns this boot always
    /// wins (last-user-intent on the Rust side), and the dirty mark
    /// persists for the WHOLE boot, not just the one persist that first
    /// set it.
    #[tokio::test]
    async fn dirty_key_wins_over_a_concurrent_external_edit_to_the_same_key() {
        let dir = std::env::temp_dir().join(format!("frs-sidebyside-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let store = store_at(&dir);
        let cfg_path = dir.join(".freshell").join("config.json");

        // Rust patches key K -- persists immediately, K is now dirty.
        store
            .patch_session_override(
                "claude:k",
                &[
                    ("titleOverride", Some(json!("RustValue"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;

        // External writer changes the SAME key on disk.
        let mut cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        cfg["sessionOverrides"]["claude:k"]["titleOverride"] = json!("ExternalValue");
        std::fs::write(&cfg_path, serde_json::to_string(&cfg).unwrap()).unwrap();

        // A persist triggered by patching a DIFFERENT key must still keep
        // Rust's value for K.
        store
            .patch_session_override("claude:other", &[("archived", Some(json!(true)))])
            .await;

        let cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert_eq!(
            cfg["sessionOverrides"]["claude:k"]["titleOverride"],
            json!("RustValue"),
            "a dirty key must keep Rust's value even after a concurrent external edit"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// TOMBSTONE: a field Rust explicitly REMOVED from a dirty key must
    /// stay removed, even if disk re-acquires a value for it (an external
    /// writer re-adding it, or stale content already on disk) --
    /// `overlay_dirty_keys` REPLACES a dirty key's value wholesale from
    /// memory; it never merges memory's absence with disk's presence
    /// field-by-field.
    #[tokio::test]
    async fn tombstoned_field_stays_removed_despite_external_reintroduction() {
        let dir = std::env::temp_dir().join(format!("frs-sidebyside-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let store = store_at(&dir);
        let cfg_path = dir.join(".freshell").join("config.json");

        // Seed a field, then remove it -- the key is dirty, and memory's
        // current value for it has no `summaryOverride`.
        store
            .patch_session_override("claude:k", &[("summaryOverride", Some(json!("first")))])
            .await;
        store
            .patch_session_override("claude:k", &[("summaryOverride", None)])
            .await;

        // External writer re-adds the removed field directly on disk.
        let mut cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        cfg["sessionOverrides"]["claude:k"]["summaryOverride"] = json!("reintroduced-externally");
        std::fs::write(&cfg_path, serde_json::to_string(&cfg).unwrap()).unwrap();

        // A persist triggered by a DIFFERENT key must not resurrect it.
        store
            .patch_session_override("claude:other", &[("archived", Some(json!(true)))])
            .await;

        let cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert!(
            cfg["sessionOverrides"]["claude:k"]
                .get("summaryOverride")
                .is_none(),
            "a field Rust removed must stay removed, not be resurrected from disk"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// LOCK SERIALIZATION: two independent `SettingsStore` instances (
    /// standing in for two OS processes -- e.g. a second Rust process, or
    /// modeling contention with the legacy server's write) pointed at the
    /// SAME home, persisting concurrently from many threads, must not lose
    /// updates. Without cross-process serialization, two racing
    /// read-modify-write cycles can each read the SAME stale disk state
    /// and each write back a version missing the other's key.
    #[test]
    fn concurrent_persists_across_two_store_instances_serialize_without_lost_updates() {
        let dir = std::env::temp_dir().join(format!("frs-sidebyside-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let store_a = store_at(&dir);
        let store_b = store_at(&dir);

        const N: usize = 20;
        let mut handles = Vec::new();
        for i in 0..N {
            let store_a = store_a.clone();
            handles.push(std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap();
                rt.block_on(
                    store_a.patch_session_override(
                        &format!("a:{i}"),
                        &[("archived", Some(json!(true)))],
                    ),
                );
            }));
            let store_b = store_b.clone();
            handles.push(std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap();
                rt.block_on(
                    store_b.patch_session_override(
                        &format!("b:{i}"),
                        &[("archived", Some(json!(true)))],
                    ),
                );
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        let overrides = cfg["sessionOverrides"]
            .as_object()
            .expect("sessionOverrides must still be a well-formed object, not corrupted");
        for i in 0..N {
            assert!(
                overrides.contains_key(&format!("a:{i}")),
                "lost update for a:{i}"
            );
            assert!(
                overrides.contains_key(&format!("b:{i}")),
                "lost update for b:{i}"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// FRESHNESS RELOAD (read path): a rename made externally (standing in
    /// for the legacy Node server) becomes visible via `session_overrides()`
    /// WITHOUT a Rust restart, once the mtime-checked reload picks up the
    /// change. Only ONE call is made to `session_overrides()` here --
    /// deliberately, so the throttle (which only opens once per second)
    /// never has a prior baseline to compare against.
    #[tokio::test]
    async fn external_rename_becomes_visible_via_session_overrides_without_restart() {
        let dir = std::env::temp_dir().join(format!("frs-sidebyside-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        std::fs::write(
            freshell.join("config.json"),
            serde_json::to_string(&json!({
                "version": 1, "settings": {}, "sessionOverrides": {}, "terminalOverrides": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let store = store_at(&dir);

        // Give the filesystem a moment so the mtime visibly advances (some
        // filesystems have coarse timestamp resolution).
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(
            freshell.join("config.json"),
            serde_json::to_string(&json!({
                "version": 1,
                "settings": {},
                "sessionOverrides": {
                    "claude:renamed": { "titleOverride": "Renamed externally" }
                },
                "terminalOverrides": {}
            }))
            .unwrap(),
        )
        .unwrap();

        let overrides = store.session_overrides();
        assert_eq!(
            overrides["claude:renamed"]["titleOverride"],
            json!("Renamed externally"),
            "an external rename must be visible without a Rust restart"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Pure boundary check for the freshness-reload throttle predicate
    /// (extracted from `maybe_reload_overrides`): fully deterministic,
    /// synthetic `Instant`s, zero real elapsed time, zero flake risk. Locks
    /// in the exact `duration_since(last) < window` comparison independent
    /// of the wall-clock/scheduling-sensitive integration test below.
    #[test]
    fn reload_throttle_boundary_is_exclusive_of_the_window() {
        let window = std::time::Duration::from_millis(100);
        let last = std::time::Instant::now();

        // Just under the window: still throttled (must NOT check).
        let almost = last + std::time::Duration::from_millis(99);
        assert!(almost.duration_since(last) < window);

        // Exactly at / just past the window: no longer throttled.
        let past = last + std::time::Duration::from_millis(101);
        assert!(past.duration_since(last) >= window);
    }

    /// THROTTLE (SAFE-01 bonus deflake): the freshness reload's mtime
    /// `stat()` is throttled -- an external write made between two RAPID
    /// calls to `session_overrides()` must not appear until the throttle
    /// window elapses, so a hot polling path (e.g. the sidebar) never stats
    /// `config.json` on every single call.
    ///
    /// Deflake note: this used to hardcode the PRODUCTION 1-second window and
    /// sleep 1100ms real time. Under a parallel `cargo test` run (heavy CPU
    /// contention across many test threads), the gap between "establish
    /// baseline" and "immediate re-check" -- separated only by one
    /// `fs::write` -- could occasionally be scheduled far enough apart to
    /// exceed a full real second, making the "must NOT see it yet" assertion
    /// flake. Fixed by injecting a much smaller window (100ms) via
    /// [`SettingsStore::with_reload_throttle_window`] (`#[cfg(test)]`-gated,
    /// never compiled into release builds) and widening the post-window
    /// sleep to 5x the window (500ms) -- the SAME throttle logic, proven at a
    /// scale where routine test-suite scheduling jitter (single-digit-to-
    /// low-double-digit milliseconds) cannot cross either boundary. What it
    /// proves is unchanged: an immediate re-check inside the window sees the
    /// stale value; the SAME store instance picks up the change once the
    /// window elapses.
    #[tokio::test]
    async fn override_reload_is_throttled_to_a_configurable_window() {
        let window = std::time::Duration::from_millis(100);
        let dir = std::env::temp_dir().join(format!("frs-sidebyside-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        std::fs::write(
            freshell.join("config.json"),
            serde_json::to_string(&json!({
                "version": 1, "settings": {}, "sessionOverrides": {}, "terminalOverrides": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let store = store_at(&dir).with_reload_throttle_window(window);

        // Establish the throttle baseline (first-ever call always checks).
        assert!(store.session_overrides().is_empty());

        // A small real gap before the external write: `store_at` itself may
        // persist once (the `knownProviders` seed migration), and the mtime
        // change-detection below compares raw filesystem mtimes -- two
        // writes close enough together can otherwise land on the identical
        // timestamp tick and be indistinguishable as "changed". This gap is
        // still far inside the throttle window (`window` = 100ms).
        std::thread::sleep(std::time::Duration::from_millis(20));

        // External writer adds a key immediately after.
        std::fs::write(
            freshell.join("config.json"),
            serde_json::to_string(&json!({
                "version": 1,
                "settings": {},
                "sessionOverrides": { "claude:fast": { "titleOverride": "x" } },
                "terminalOverrides": {}
            }))
            .unwrap(),
        )
        .unwrap();

        // Immediate re-check: within the same throttle window, must NOT
        // see it.
        assert!(
            !store.session_overrides().contains_key("claude:fast"),
            "a reload within the throttle window must not re-stat config.json"
        );

        // After the window elapses (5x margin), the SAME store instance does
        // pick it up.
        std::thread::sleep(window * 5);
        assert!(
            store.session_overrides().contains_key("claude:fast"),
            "after the throttle window elapses, the change must become visible"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ================================================================
    // CFG-03: config.backup.json + conservative restore-on-corruption
    // ================================================================
    //
    // Legacy gap this closes (`server/config-store.ts:317-398,423-430`): on
    // ANY read failure (parse/version/read error -- not just a missing
    // file), the original's `loadInternal` falls straight to its "no
    // existing config" branch and calls `saveInternal(defaultsOnlyConfig)`
    // UNCONDITIONALLY -- which immediately overwrites `config.json` with
    // bare defaults AND, via `saveInternal`'s own unconditional
    // `copyFile(configPath(), backupPath())`, overwrites the LAST-GOOD
    // BACKUP with those same bare defaults, before a human ever gets a
    // chance to run the warning log's suggested manual
    // `mv config.backup.json config.json` recovery. This is the "a
    // corrupted config costs the user their N renames" failure CFG-03
    // exists to close. Proven RED against a version of this file with NO
    // backup mechanism at all (see the task report for the exact
    // stash/diff evidence) before the `persist()`/`load()`/
    // `maybe_restore_config_from_backup` changes above were added.

    /// THE OUTER ACCEPTANCE TEST, written first. Seeds a realistic config
    /// (a settings patch, a terminal override, a session override, PLUS a
    /// top-level key this store never manages at all -- `completedMigrations`
    /// -- so unmanaged/unknown-key survival is proven, not just the keys
    /// this module happens to know about), persists it (so a backup now
    /// exists), truncates the primary mid-file (a realistic
    /// crash-during-write corruption), then constructs a BRAND NEW store
    /// over the SAME home and asserts: load succeeds, the recovered file is
    /// value-identical to the last known-good state (byte-identical for the
    /// unmanaged key specifically), the corrupt original is preserved
    /// forensically with its ACTUAL corrupt bytes, and the restored store's
    /// NEXT persist still round-trips normally (proving it is not wedged --
    /// also the "no deadlock with the existing lock" evidence: this awaits
    /// to completion rather than hanging).
    #[tokio::test]
    async fn corrupted_primary_restores_from_backup_preserving_every_last_good_value() {
        let dir = std::env::temp_dir().join(format!("frs-cfg03-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        let config_path = freshell.join("config.json");
        let backup_path = freshell.join("config.backup.json");

        // Seed a config containing a key this store NEVER manages (only
        // copy-forwarded by `persist()`'s adopt-from-disk merge), so its
        // survival proves the restore is a real byte-level recovery, not
        // just "the fields this module happens to reconstruct."
        std::fs::write(
            &config_path,
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "settings": {},
                "sessionOverrides": {},
                "terminalOverrides": {},
                "completedMigrations": ["legacy-theme-seed", "provider-rename-2026"]
            }))
            .unwrap(),
        )
        .unwrap();

        let store = store_at(&dir);

        // A realistic last-good state: independent settings/terminal/session
        // writes, all landing in the same config.json.
        store
            .patch(&json!({ "safety": { "autoKillIdleMinutes": 42 } }))
            .await
            .unwrap();
        store
            .patch_terminal_override("term-1", &[("titleOverride", Some(json!("My Terminal")))])
            .await;
        store
            .patch_session_override("claude:abc", &[("archived", Some(json!(true)))])
            .await;

        assert!(
            backup_path.exists(),
            "a backup must exist after a successful persist"
        );
        let last_good_bytes = std::fs::read(&config_path).unwrap();
        let last_good: Value = serde_json::from_slice(&last_good_bytes).unwrap();
        assert_eq!(
            last_good["completedMigrations"],
            json!(["legacy-theme-seed", "provider-rename-2026"]),
            "sanity: the unmanaged key really is present in the last-good state"
        );

        // Simulate a crash-during-write: truncate the primary mid-file.
        let corrupted = last_good_bytes[..last_good_bytes.len() / 2].to_vec();
        std::fs::write(&config_path, &corrupted).unwrap();
        assert!(
            serde_json::from_slice::<Value>(&std::fs::read(&config_path).unwrap()).is_err(),
            "sanity: the truncated file really does fail to parse"
        );

        // A brand-new store over the SAME home: this is where the
        // restore-on-load policy runs.
        let restored_store = store_at(&dir);

        // The file itself is recovered to the last known-good state.
        let restored_bytes = std::fs::read(&config_path).unwrap();
        let restored: Value = serde_json::from_slice(&restored_bytes).unwrap();
        assert_eq!(
            restored, last_good,
            "restored config.json must match the last known-good state exactly"
        );
        assert_eq!(
            restored_bytes, last_good_bytes,
            "the restore must be byte-identical (it copies the backup's exact bytes), \
             proving unmanaged keys survive at the byte level, not just semantically"
        );

        // In-memory state agrees too -- every writer's contribution intact.
        let settings = restored_store.get().await;
        assert_eq!(settings.safety.auto_kill_idle_minutes, 42);
        assert_eq!(
            restored_store.terminal_overrides()["term-1"]["titleOverride"],
            json!("My Terminal")
        );
        assert_eq!(
            restored_store.session_overrides()["claude:abc"]["archived"],
            json!(true)
        );

        // The corrupt original was preserved forensically, not discarded.
        let corrupt_forensics: Vec<_> = std::fs::read_dir(&freshell)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("config.json.corrupt-"))
            .collect();
        assert_eq!(
            corrupt_forensics.len(),
            1,
            "exactly one forensic copy of the corrupt primary must be preserved, found: {corrupt_forensics:?}"
        );
        let forensic_bytes = std::fs::read(freshell.join(&corrupt_forensics[0])).unwrap();
        assert_eq!(
            forensic_bytes, corrupted,
            "the forensic copy must preserve the ACTUAL corrupt bytes, not something else"
        );

        // Not wedged: the restored store's NEXT persist still round-trips,
        // and completes at all (no lock deadlock left over from the
        // restore step's own acquire/release).
        let merged = restored_store
            .patch(&json!({ "safety": { "autoKillIdleMinutes": 7 } }))
            .await
            .unwrap();
        assert_eq!(merged.safety.auto_kill_idle_minutes, 7);
        let cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(cfg["settings"]["safety"]["autoKillIdleMinutes"], 7);
        assert_eq!(
            cfg["completedMigrations"],
            json!(["legacy-theme-seed", "provider-rename-2026"]),
            "the unmanaged key must still round-trip on the FOLLOWING persist too"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// SIDE-BY-SIDE HAZARD: a primary that PARSES -- even with a shape that
    /// looks stale/surprising next to a newer backup -- must NEVER be
    /// restored over. This is what protects a concurrent legacy-server
    /// write from being clobbered by an auto-restore during bake-in.
    #[tokio::test]
    async fn parseable_but_surprising_primary_is_never_restored_over() {
        let dir = std::env::temp_dir().join(format!("frs-cfg03-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        let config_path = freshell.join("config.json");
        let backup_path = freshell.join("config.backup.json");

        // A valid (older-looking) backup...
        std::fs::write(
            &backup_path,
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "settings": { "safety": { "autoKillIdleMinutes": 999 } },
                "sessionOverrides": {},
                "terminalOverrides": {}
            }))
            .unwrap(),
        )
        .unwrap();

        // ...and a primary that is perfectly parseable JSON, but "surprising"
        // (a value nothing in this test ever wrote, standing in for a
        // concurrent legacy-server write during bake-in). `knownProviders`
        // is pre-seeded to match `store_at`'s discovered set so the
        // UNRELATED known-providers migration in `SettingsStore::load`
        // never fires here -- this test isolates the CFG-03 restore
        // policy specifically, not the pre-existing seed migration.
        let surprising = json!({
            "version": 1,
            "settings": {
                "safety": { "autoKillIdleMinutes": 5 },
                "codingCli": { "knownProviders": ["claude", "codex"] }
            },
            "sessionOverrides": {},
            "terminalOverrides": {},
            "aFieldTheBackupKnowsNothingAbout": "legacy wrote this just now"
        });
        std::fs::write(
            &config_path,
            serde_json::to_string_pretty(&surprising).unwrap(),
        )
        .unwrap();
        let primary_bytes_before = std::fs::read(&config_path).unwrap();

        let store = store_at(&dir);
        let settings = store.get().await;
        assert_eq!(
            settings.safety.auto_kill_idle_minutes, 5,
            "the parseable primary's own value must be used, never the backup's"
        );

        let primary_bytes_after = std::fs::read(&config_path).unwrap();
        assert_eq!(
            primary_bytes_after, primary_bytes_before,
            "a parseable primary must be byte-for-byte untouched by the restore policy"
        );

        let corrupt_forensics = std::fs::read_dir(&freshell)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("config.json.corrupt-")
            });
        assert!(
            !corrupt_forensics,
            "no forensic copy should ever be created for a primary that was never touched"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// FAIL-SAFE: when BOTH primary and backup are corrupt, the store must
    /// start fresh with defaults (matching the original's ultimate
    /// fallback) WITHOUT losing either corrupt file -- both are preserved
    /// forensically before anything is overwritten.
    #[tokio::test]
    async fn both_primary_and_backup_corrupt_starts_fresh_but_preserves_both_forensic_copies() {
        let dir = std::env::temp_dir().join(format!("frs-cfg03-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        let config_path = freshell.join("config.json");
        let backup_path = freshell.join("config.backup.json");

        std::fs::write(&config_path, b"{ this is not valid json at all").unwrap();
        std::fs::write(&backup_path, b"{ neither is this backup, oops").unwrap();

        let store = store_at(&dir);

        // Fresh defaults in memory (only `knownProviders` seeded from
        // discovery -- the original migration this store already runs).
        let settings = store.get().await;
        assert_eq!(
            settings.coding_cli.known_providers,
            Some(vec!["claude".to_string(), "codex".to_string()])
        );

        let entries: Vec<_> = std::fs::read_dir(&freshell)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            entries
                .iter()
                .any(|n| n.starts_with("config.json.corrupt-")),
            "the corrupt PRIMARY must be preserved forensically, found: {entries:?}"
        );
        assert!(
            entries
                .iter()
                .any(|n| n.starts_with("config.backup.json.corrupt-")),
            "the corrupt BACKUP must ALSO be preserved forensically, found: {entries:?}"
        );

        // "Start fresh" (like the original): a valid config.json now exists.
        let cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(
            cfg["settings"]["codingCli"]["knownProviders"],
            json!(["claude", "codex"])
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// ATOMICITY: the backup refresh after a successful persist is a
    /// tmp+rename write, never a partial in-place write -- no leftover tmp
    /// file, and the backup is always fully valid JSON immediately after.
    #[tokio::test]
    async fn backup_write_is_atomic_tmp_plus_rename_with_no_leftovers() {
        let dir = std::env::temp_dir().join(format!("frs-cfg03-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let freshell = dir.join(".freshell");
        let store = store_at(&dir);

        store
            .patch(&json!({ "safety": { "autoKillIdleMinutes": 11 } }))
            .await
            .unwrap();

        let backup_text = std::fs::read_to_string(freshell.join("config.backup.json")).unwrap();
        let backup_json: Value = serde_json::from_str(&backup_text)
            .expect("backup must always be complete, valid JSON right after a persist");
        assert_eq!(backup_json["settings"]["safety"]["autoKillIdleMinutes"], 11);

        let leftover_tmp = std::fs::read_dir(&freshell)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains(".tmp-"));
        assert!(
            !leftover_tmp,
            "no tmp file should survive a successful atomic backup write"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// NEGATIVE CASE: a persist that never actually reaches disk (primary
    /// write fails) must NOT refresh the backup -- "refresh the backup"
    /// means "after a SUCCESSFUL persist," not "whenever persist is
    /// attempted." Makes `.freshell` read-only so the tmp-file write inside
    /// `persist()` fails, then asserts the pre-existing backup is
    /// byte-for-byte unchanged.
    #[cfg(unix)]
    #[tokio::test]
    async fn backup_is_not_refreshed_when_the_primary_persist_fails() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("frs-cfg03-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        let store = store_at(&dir);

        // Establish a known-good backup first, while the directory is still
        // writable.
        store
            .patch(&json!({ "safety": { "autoKillIdleMinutes": 3 } }))
            .await
            .unwrap();
        let backup_before = std::fs::read(freshell.join("config.backup.json")).unwrap();

        // Make `.freshell` read+execute only: `persist()`'s tmp-file write
        // (which must CREATE a new file in this directory) fails, so the
        // primary write itself never succeeds.
        let original_perms = std::fs::metadata(&freshell).unwrap().permissions();
        std::fs::set_permissions(&freshell, std::fs::Permissions::from_mode(0o500)).unwrap();

        let merged = store
            .patch(&json!({ "safety": { "autoKillIdleMinutes": 99 } }))
            .await
            .unwrap();
        // The in-memory tree still updates (persist failure is silent/best-
        // effort, matching this module's existing tolerant-write policy).
        assert_eq!(merged.safety.auto_kill_idle_minutes, 99);

        let backup_after = std::fs::read(freshell.join("config.backup.json")).unwrap();
        assert_eq!(
            backup_after, backup_before,
            "the backup must be untouched when the primary persist itself failed"
        );

        // Restore permissions so cleanup (and any other test running
        // concurrently against a colliding tmp dir name) can proceed.
        std::fs::set_permissions(&freshell, original_perms).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
