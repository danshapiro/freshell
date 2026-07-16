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
}

impl SettingsStore {
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
    fn persist(&self, settings: &ServerSettings) {
        let Some(home) = &self.home else { return };
        let dir = home.join(".freshell");
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join("config.json");

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
        map.insert(
            "sessionOverrides".to_string(),
            Value::Object(
                self.session_overrides
                    .lock()
                    .expect("session overrides lock")
                    .clone(),
            ),
        );
        map.insert(
            "terminalOverrides".to_string(),
            Value::Object(
                self.terminal_overrides
                    .lock()
                    .expect("terminal overrides lock")
                    .clone(),
            ),
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
        if std::fs::write(&tmp, &text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    /// A snapshot of `config.terminalOverrides` (the `/api/terminals` directory
    /// reads it to merge titles/descriptions and filter `deleted`).
    pub fn terminal_overrides(&self) -> serde_json::Map<String, Value> {
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
            (Value::Object(next), changed)
        };
        if changed {
            let settings = self.get().await;
            self.persist(&settings);
        }
        next
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn store_at(dir: &Path) -> SettingsStore {
        SettingsStore::load(Some(dir), vec!["claude".into(), "codex".into()])
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
}
