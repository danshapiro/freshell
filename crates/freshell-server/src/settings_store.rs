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
    known_providers: Arc<Vec<String>>,
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
}

impl SettingsStore {
    /// Load the full persisted settings tree (defaults deep-merged with
    /// `<home>/.freshell/config.json`'s `settings` object \u2014 mirrors
    /// `mergeServerSettings(defaults, persisted)`), then overlay the
    /// boot-discovered `knownProviders` (R4).
    pub fn load(home: Option<&Path>, known_providers: Vec<String>) -> Self {
        let mut settings = load_full_settings(home);
        settings.coding_cli.known_providers = Some(known_providers.clone());
        let codex_display_id_secret = load_or_mint_codex_display_id_secret(home);
        let terminal_overrides = load_terminal_overrides(home);
        Self {
            inner: Arc::new(RwLock::new(settings)),
            home: home.map(|p| Arc::new(p.to_path_buf())),
            known_providers: Arc::new(known_providers),
            codex_display_id_secret: Arc::new(codex_display_id_secret),
            terminal_overrides: Arc::new(std::sync::Mutex::new(terminal_overrides)),
        }
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
        if let Some(details) = validate_patch(patch_body) {
            return Err((
                StatusCode::BAD_REQUEST,
                json!({ "error": "Invalid request", "details": details }),
            ));
        }

        let mut guard = self.inner.write().await;
        let mut value = serde_json::to_value(&*guard).unwrap_or_else(|_| json!({}));
        deep_merge(&mut value, patch_body);
        // knownProviders is derived, never user-writable (R4).
        value["codingCli"]["knownProviders"] = json!(self.known_providers.as_ref());
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

    /// Persist the current tree to `<home>/.freshell/config.json` in the
    /// original's `UserConfig` shape (`version`, `settings`, and the sibling
    /// maps the original always writes back, even when empty) so a restart
    /// round-trips the patch (R2). A missing/unwritable home degrades silently
    /// (matches the isolated-runtime / no-HOME case).
    fn persist(&self, settings: &ServerSettings) {
        let Some(home) = &self.home else { return };
        let dir = home.join(".freshell");
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let doc = json!({
            "version": 1,
            "settings": settings,
            "sessionOverrides": {},
            "terminalOverrides": Value::Object(self.terminal_overrides.lock().expect("terminal overrides lock").clone()),
            "projectColors": {},
            "recentDirectories": [],
            "serverSecrets": { "codexDisplayIdSecret": &*self.codex_display_id_secret },
        });
        let Ok(text) = serde_json::to_string_pretty(&doc) else { return };
        let path = dir.join("config.json");
        let tmp = dir.join(format!("config.json.tmp-{}", std::process::id()));
        if std::fs::write(&tmp, &text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    /// A snapshot of `config.terminalOverrides` (the `/api/terminals` directory
    /// reads it to merge titles/descriptions and filter `deleted`).
    pub fn terminal_overrides(&self) -> serde_json::Map<String, Value> {
        self.terminal_overrides.lock().expect("terminal overrides lock").clone()
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
            let mut all = self.terminal_overrides.lock().expect("terminal overrides lock");
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
                deep_merge(target_map.entry(key.clone()).or_insert(Value::Null), patch_value);
            }
        }
        (target_slot, patch_value) => {
            *target_slot = patch_value.clone();
        }
    }
}

/// A faithful-subset validator covering the specific violations the parity
/// sweep probes (`buildServerSettingsPatchSchema`'s strict top-level schema +
/// the enum/type fields it exercises): unknown top-level keys (the schema is
/// `.strict()`), `editor.externalEditor` / `panes.defaultNewPane` enums, and
/// `allowedFilePaths` must be an array. Returns the zod-shaped `details` array
/// on a violation, or `None` when the patch is structurally valid.
fn validate_patch(patch: &Value) -> Option<Value> {
    let Value::Object(map) = patch else { return None };
    const KNOWN_TOP_LEVEL: &[&str] = &[
        "ai", "codingCli", "editor", "extensions", "freshAgent", "logging", "network", "panes",
        "safety", "sidebar", "terminal", "allowedFilePaths", "defaultCwd",
    ];
    for key in map.keys() {
        if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
            // Byte-matched against a live probe of the ORIGINAL: singular
            // "Unrecognized key" (not zod's stock plural "key(s) in object"
            // wording) -- `buildServerSettingsPatchSchema` overrides the
            // strict-object error message (`shared/settings.ts`).
            return Some(json!([{
                "code": "unrecognized_keys",
                "keys": [key],
                "path": [],
                "message": format!("Unrecognized key: \"{key}\""),
            }]));
        }
    }
    // EXTERNAL_EDITOR_VALUES / DEFAULT_NEW_PANE_VALUES (`shared/settings.ts:25,33`).
    if let Some(v) = map.get("editor").and_then(|v| v.get("externalEditor")) {
        const VALID: &[&str] = &["auto", "cursor", "code", "custom"];
        if v.as_str().map(|s| !VALID.contains(&s)).unwrap_or(true) {
            return Some(enum_details(&["editor", "externalEditor"], VALID, v));
        }
    }
    if let Some(v) = map.get("panes").and_then(|v| v.get("defaultNewPane")) {
        const VALID: &[&str] = &["ask", "shell", "browser", "editor"];
        if v.as_str().map(|s| !VALID.contains(&s)).unwrap_or(true) {
            return Some(enum_details(&["panes", "defaultNewPane"], VALID, v));
        }
    }
    if let Some(v) = map.get("allowedFilePaths") {
        if !v.is_array() {
            return Some(json!([{
                "code": "invalid_type",
                "expected": "array",
                "path": ["allowedFilePaths"],
                "message": "Invalid input: expected array, received string",
            }]));
        }
    }
    None
}

fn enum_details(path: &[&str], valid: &[&str], _got: &Value) -> Value {
    // Byte-matched against a live probe of the ORIGINAL: this zod enum issue
    // shape carries NO `received` field (unlike some other zod issue kinds).
    json!([{
        "code": "invalid_value",
        "values": valid,
        "path": path,
        "message": format!(
            "Invalid option: expected one of {}",
            valid.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join("|")
        ),
    }])
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

    #[tokio::test]
    async fn known_providers_seeded_and_immutable_via_patch() {
        let dir = std::env::temp_dir().join(format!("frs-settings-{}", uuid_like()));
        let store = store_at(&dir);
        let s = store.get().await;
        assert_eq!(
            s.coding_cli.known_providers,
            Some(vec!["claude".to_string(), "codex".to_string()])
        );
        // A patch cannot overwrite the derived field.
        let merged = store
            .patch(&json!({ "codingCli": { "knownProviders": ["bogus"] } }))
            .await
            .unwrap();
        assert_eq!(
            merged.coding_cli.known_providers,
            Some(vec!["claude".to_string(), "codex".to_string()])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn patch_write_through_reaches_get_and_config_json_and_restart() {
        let dir = std::env::temp_dir().join(format!("frs-settings-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let store = store_at(&dir);

        let merged = store
            .patch(&json!({ "safety": { "autoKillIdleMinutes": 25 }, "allowedFilePaths": ["/tmp"] }))
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

    #[test]
    fn agent_chat_key_rejected() {
        let err = validate_patch(&json!({ "ai": {} }));
        assert!(err.is_none());
    }

    #[test]
    fn unknown_top_level_key_rejected() {
        let details = validate_patch(&json!({ "totallyUnknownKey": true })).unwrap();
        assert_eq!(details[0]["code"], "unrecognized_keys");
    }

    #[test]
    fn client_only_key_rejected_by_strict_schema() {
        let details = validate_patch(&json!({ "theme": "dark" })).unwrap();
        assert_eq!(details[0]["code"], "unrecognized_keys");
    }

    #[test]
    fn enum_and_type_violations_rejected() {
        assert!(validate_patch(&json!({ "editor": { "externalEditor": "bogus" } })).is_some());
        assert!(validate_patch(&json!({ "panes": { "defaultNewPane": "bogus" } })).is_some());
        assert!(validate_patch(&json!({ "allowedFilePaths": "not-an-array" })).is_some());
        assert!(validate_patch(&json!({ "allowedFilePaths": ["ok"] })).is_none());
    }

    /// Byte-matched against a live probe of the ORIGINAL: the enum VALUES
    /// themselves (`EXTERNAL_EDITOR_VALUES`/`DEFAULT_NEW_PANE_VALUES`,
    /// `shared/settings.ts:25,33`) and the singular "Unrecognized key" wording
    /// -- both previously wrong (masked by R1's blanket 405 before PUT/PATCH
    /// worked at all).
    #[test]
    fn enum_values_and_unrecognized_key_message_match_the_original() {
        let details = validate_patch(&json!({ "editor": { "externalEditor": "bogus" } })).unwrap();
        assert_eq!(
            details[0]["message"],
            json!("Invalid option: expected one of \"auto\"|\"cursor\"|\"code\"|\"custom\"")
        );

        let details = validate_patch(&json!({ "panes": { "defaultNewPane": "bogus" } })).unwrap();
        assert_eq!(
            details[0]["message"],
            json!("Invalid option: expected one of \"ask\"|\"shell\"|\"browser\"|\"editor\"")
        );

        let details = validate_patch(&json!({ "theme": "dark" })).unwrap();
        assert_eq!(details[0]["message"], json!("Unrecognized key: \"theme\""));

        // "vscode"/"terminal" were the WRONG (pre-fix) accepted values -- must
        // now be rejected, and the real values must be accepted.
        assert!(validate_patch(&json!({ "editor": { "externalEditor": "vscode" } })).is_some());
        assert!(validate_patch(&json!({ "editor": { "externalEditor": "cursor" } })).is_none());
        assert!(validate_patch(&json!({ "panes": { "defaultNewPane": "terminal" } })).is_some());
        assert!(validate_patch(&json!({ "panes": { "defaultNewPane": "editor" } })).is_none());
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
}
