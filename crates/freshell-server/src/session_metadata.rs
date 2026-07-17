//! `POST /api/session-metadata` — a faithful port of `server/sessions-router.ts:220-244`
//! backed by `server/session-metadata-store.ts`'s `SessionMetadataStore`.
//!
//! The SPA calls this to tag a session with an explicit/materialized `sessionType`
//! (`src/lib/api.ts:519-531` `setSessionMetadata`, used by the sidebar/context-menu "set
//! session type" flow and by fresh-agent materialization). Persisted to
//! `<home>/.freshell/session-metadata.json` — a real deployed instance's copy of this file
//! can be 1MB+ (one entry per historical session ever tagged), so loading MUST be tolerant
//! of a large, already-populated file and MUST NOT drop any field it doesn't explicitly
//! model (the same lossless "copy-forward" discipline `settings_store.rs`'s `persist()`
//! established for `config.json` in Batch A) — a `SessionMetadataEntry` can carry fields
//! this port never reads (e.g. `derivedTitle`, written by the AI-title-generation path,
//! which is out of this port's scope) and they must round-trip byte-for-byte on any write
//! to a DIFFERENT field of the same entry.
//!
//! ## Shape
//!
//! ```json
//! { "version": 1, "sessions": { "<provider>": { "<sessionId>": { "sessionType": "...", "sessionTypeSource": "explicit" } } } }
//! ```
//!
//! `get_all()`/`get()` are provided for future read-surfaces (the sidebar directory listing
//! embeds `sessionType` inline via `codingCliIndexer` server-side in the reference; this
//! port's `crates/freshell-sessions` directory index is a SEPARATE crate this module does
//! not reach into — wiring metadata into the directory listing is out of THIS module's
//! scope and tracked separately) but are not (yet) exposed over HTTP: the reference has no
//! `GET /api/session-metadata` route either (confirmed by exhaustive grep of
//! `server/sessions-router.ts` and `server/index.ts` — only the `POST` exists).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex as TokioMutex;

use crate::boot::{is_authed, unauthorized};

/// `DEFAULT_CLI_PROVIDER_NAMES` (`shared/session-flavor.ts` `CLI_SESSION_TYPES` /
/// `server/coding-cli/*`) — the provider set `sessionMetadataProviderSchema`
/// (`sessions-router.ts:65-71`) validates against by default (no `validCliProviders`
/// override is wired through this port).
const VALID_PROVIDERS: &[&str] = &["claude", "codex", "opencode"];
/// `KNOWN_SESSION_METADATA_TYPES` (`shared/session-flavor.ts:12-14`).
const KNOWN_SESSION_METADATA_TYPES: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "freshclaude",
    "freshcodex",
    "freshopencode",
    "kilroy",
];
/// `SESSION_TYPE_METADATA_SOURCES` (`shared/session-flavor.ts:15`).
const VALID_SESSION_TYPE_SOURCES: &[&str] = &["explicit", "materialized"];

/// A provider→sessionId→entry store, persisted to `session-metadata.json`. Cheaply
/// cloneable (the guts live behind an `Arc`), matching the other `*Store` types in this
/// crate (`SettingsStore`).
#[derive(Clone)]
pub struct SessionMetadataStore {
    path: Arc<PathBuf>,
    /// `None` = not yet loaded from disk. Guarding the whole cache behind one lock (rather
    /// than the reference's separate `cache` field + `writeMutex`) is simpler in Rust and
    /// strictly more conservative: every read AND write is serialized, whereas the
    /// reference only serializes writes (reads are unguarded, safe only because Node is
    /// single-threaded between `await` points).
    inner: Arc<TokioMutex<Option<Value>>>,
}

impl SessionMetadataStore {
    /// `dir` is the freshell config directory (`<home>/.freshell`), matching
    /// `SessionMetadataStore`'s constructor (`session-metadata-store.ts:59-61`).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            path: Arc::new(dir.into().join("session-metadata.json")),
            inner: Arc::new(TokioMutex::new(None)),
        }
    }

    /// `load()` (`session-metadata-store.ts:67-88`): tolerant read — any I/O error, parse
    /// failure, or shape mismatch (`version !== 1` or missing/non-object `sessions`)
    /// degrades to a fresh `{version:1, sessions:{}}` rather than propagating an error.
    /// This is a faithful port of the reference's behavior, including its (pre-existing,
    /// not introduced by this port) data-loss-on-corruption edge case: a malformed file on
    /// disk is silently replaced by an empty structure on the next successful `set()`. This
    /// module does not "fix" that — it is out of scope, and the real, currently-deployed
    /// file this port must load is well-formed.
    async fn load_locked(guard: &mut Option<Value>, path: &std::path::Path) -> Value {
        if let Some(v) = guard.as_ref() {
            return v.clone();
        }
        let loaded = tokio::fs::read_to_string(path)
            .await
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(|v| {
                v.get("version").and_then(Value::as_i64) == Some(1)
                    && v.get("sessions").map(Value::is_object).unwrap_or(false)
            })
            .unwrap_or_else(|| json!({ "version": 1, "sessions": {} }));
        *guard = Some(loaded.clone());
        loaded
    }

    /// `get(provider, sessionId)` (`session-metadata-store.ts:102-106`).
    pub async fn get(&self, provider: &str, session_id: &str) -> Option<Value> {
        let mut guard = self.inner.lock().await;
        let data = Self::load_locked(&mut guard, &self.path).await;
        data.get("sessions")
            .and_then(Value::as_object)
            .and_then(|s| s.get(provider))
            .and_then(Value::as_object)
            .and_then(|p| p.get(session_id))
            .cloned()
    }

    /// `getAll()` (`session-metadata-store.ts:113-122`): flattened `provider:sessionId` →
    /// entry map.
    pub async fn get_all(&self) -> HashMap<String, Value> {
        let mut guard = self.inner.lock().await;
        let data = Self::load_locked(&mut guard, &self.path).await;
        let mut result = HashMap::new();
        if let Some(sessions) = data.get("sessions").and_then(Value::as_object) {
            for (provider, provider_sessions) in sessions {
                if let Some(map) = provider_sessions.as_object() {
                    for (session_id, entry) in map {
                        result.insert(format!("{provider}:{session_id}"), entry.clone());
                    }
                }
            }
        }
        result
    }

    /// `set(provider, sessionId, entry)` (`session-metadata-store.ts:124-158`). Returns
    /// `Ok(true)` iff the persisted entry actually changed (matching the reference's
    /// `JSON.stringify(existing) === JSON.stringify(next)` no-op guard, implemented here as
    /// a semantic `Map` comparison instead of a string comparison — strictly more correct,
    /// since it can't be fooled by insertion-order differences that don't affect content).
    pub async fn set(
        &self,
        provider: &str,
        session_id: &str,
        session_type: &str,
        session_type_source: Option<&str>,
    ) -> std::io::Result<bool> {
        let mut guard = self.inner.lock().await;
        let mut data = Self::load_locked(&mut guard, &self.path).await;

        let root = data
            .as_object_mut()
            .expect("metadata file root is always loaded as an object (see load_locked)");
        let sessions_val = root
            .entry("sessions".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !sessions_val.is_object() {
            *sessions_val = Value::Object(Map::new());
        }
        let sessions_obj = sessions_val.as_object_mut().unwrap();
        let provider_val = sessions_obj
            .entry(provider.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !provider_val.is_object() {
            *provider_val = Value::Object(Map::new());
        }
        let provider_obj = provider_val.as_object_mut().unwrap();

        let existing: Map<String, Value> = provider_obj
            .get(session_id)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        // `next = {...existing, ...entry}` where `entry = {sessionType, [sessionTypeSource]}`
        // — sessionType is ALWAYS overwritten; sessionTypeSource only if the caller supplied
        // one (matching the JS spread: an absent key in `entry` never touches `next`).
        let mut next = existing.clone();
        next.insert("sessionType".to_string(), json!(session_type));

        if let Some(source) = session_type_source {
            let existing_type = existing.get("sessionType").and_then(Value::as_str);
            let existing_source = existing.get("sessionTypeSource").and_then(Value::as_str);
            next.insert("sessionTypeSource".to_string(), json!(source));
            let should_apply = should_apply_session_type_metadata(
                existing_type,
                existing_source,
                session_type,
                source,
            );
            if !should_apply {
                // Revert sessionType/sessionTypeSource to whatever existing had — removing
                // the key entirely if existing didn't have it (matches JS: spreading an
                // `undefined` value in, then `JSON.stringify`, drops that key).
                match existing_type {
                    Some(t) => {
                        next.insert("sessionType".to_string(), json!(t));
                    }
                    None => {
                        next.remove("sessionType");
                    }
                }
                match existing_source {
                    Some(s) => {
                        next.insert("sessionTypeSource".to_string(), json!(s));
                    }
                    None => {
                        next.remove("sessionTypeSource");
                    }
                }
            }
        }

        if next == existing {
            return Ok(false);
        }

        provider_obj.insert(session_id.to_string(), Value::Object(next));
        self.persist(&mut guard, data).await?;
        Ok(true)
    }

    /// `save()` (`session-metadata-store.ts:90-100`): write to a pid+timestamp-scoped temp
    /// file, then atomically rename over the real path, then best-effort clean up the temp
    /// file (a no-op if the rename already consumed it — mirrors `fsp.rm(tmp, {force:true})`).
    async fn persist(&self, guard: &mut Option<Value>, data: Value) -> std::io::Result<()> {
        let dir = self
            .path
            .parent()
            .expect("session-metadata.json always has a parent directory");
        tokio::fs::create_dir_all(dir).await?;
        let pid = std::process::id();
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let file_name = format!("session-metadata.json.tmp-{pid}-{millis}");
        let tmp_path = dir.join(file_name);
        let serialized =
            serde_json::to_string_pretty(&data).expect("session metadata always serializes");
        tokio::fs::write(&tmp_path, &serialized).await?;
        let rename_result = tokio::fs::rename(&tmp_path, self.path.as_path()).await;
        let _ = tokio::fs::remove_file(&tmp_path).await;
        rename_result?;
        *guard = Some(data);
        Ok(())
    }
}

/// `shouldApplySessionTypeMetadata` (`shared/session-flavor.ts:79-90`).
fn should_apply_session_type_metadata(
    existing_type: Option<&str>,
    existing_source: Option<&str>,
    incoming_type: &str,
    incoming_source: &str,
) -> bool {
    let has_existing_type = existing_type.map(|s| !s.is_empty()).unwrap_or(false);
    if !has_existing_type {
        return true;
    }
    let existing_type = existing_type.unwrap();
    if existing_type == incoming_type {
        return existing_source != Some("explicit") && incoming_source == "explicit";
    }
    if existing_source != Some("materialized") && incoming_source == "materialized" {
        return false;
    }
    true
}

/// Shared state for the `/api/session-metadata` route.
#[derive(Clone)]
pub struct SessionMetadataApiState {
    pub auth_token: Arc<String>,
    pub store: SessionMetadataStore,
}

/// The `/api/session-metadata` sub-router.
pub fn router(state: SessionMetadataApiState) -> Router {
    Router::new()
        .route("/api/session-metadata", post(post_session_metadata))
        .with_state(state)
}

async fn post_session_metadata(
    State(state): State<SessionMetadataApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    match validate_post_body(&body) {
        Err(details) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "Missing required fields: provider, sessionId, sessionType",
                "details": details,
            })),
        )
            .into_response(),
        Ok((provider, session_id, session_type, session_type_source)) => {
            match state
                .store
                .set(
                    &provider,
                    &session_id,
                    &session_type,
                    session_type_source.as_deref(),
                )
                .await
            {
                Ok(changed) => Json(json!({ "ok": true, "changed": changed })).into_response(),
                Err(err) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": err.to_string() })),
                )
                    .into_response(),
            }
        }
    }
}

/// `SessionMetadataPostSchema.safeParse` (`sessions-router.ts:220-227`). Returns
/// `(provider, sessionId, sessionType, sessionTypeSource)` on success, or a list of
/// zod-issue-shaped `{path, message}` objects on failure (schema-approximate — the
/// reference's exact zod issue shape is not part of any client contract this port must
/// match; the client only reads the top-level `error` string on a 400).
fn validate_post_body(
    body: &Value,
) -> Result<(String, String, String, Option<String>), Vec<Value>> {
    let mut issues = Vec::new();

    let provider = body.get("provider").and_then(Value::as_str);
    let provider_valid = provider
        .map(|p| !p.is_empty() && VALID_PROVIDERS.contains(&p))
        .unwrap_or(false);
    if !provider_valid {
        issues.push(json!({ "path": ["provider"], "message": "Invalid provider" }));
    }

    let session_id = body.get("sessionId").and_then(Value::as_str);
    let session_id_valid = session_id.map(|s| !s.is_empty()).unwrap_or(false);
    if !session_id_valid {
        issues.push(json!({ "path": ["sessionId"], "message": "Required" }));
    }

    let session_type = body.get("sessionType").and_then(Value::as_str);
    let session_type_valid = session_type
        .map(|t| KNOWN_SESSION_METADATA_TYPES.contains(&t))
        .unwrap_or(false);
    if !session_type_valid {
        issues.push(json!({ "path": ["sessionType"], "message": "Invalid sessionType" }));
    }

    let session_type_source = body.get("sessionTypeSource");
    let session_type_source_valid = match session_type_source {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => VALID_SESSION_TYPE_SOURCES.contains(&s.as_str()),
        Some(_) => false,
    };
    if !session_type_source_valid {
        issues
            .push(json!({ "path": ["sessionTypeSource"], "message": "Invalid sessionTypeSource" }));
    }

    if !issues.is_empty() {
        return Err(issues);
    }

    Ok((
        provider.unwrap().to_string(),
        session_id.unwrap().to_string(),
        session_type.unwrap().to_string(),
        session_type_source
            .and_then(Value::as_str)
            .map(str::to_string),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", token.parse().unwrap());
        headers
    }

    fn state(store: SessionMetadataStore) -> SessionMetadataApiState {
        SessionMetadataApiState {
            auth_token: Arc::new("tok".to_string()),
            store,
        }
    }

    // ── Store-level tests ──────────────────────────────────────────────────

    #[tokio::test]
    async fn set_persists_and_get_returns_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        let changed = store
            .set("codex", "sess-1", "freshcodex", Some("explicit"))
            .await
            .unwrap();
        assert!(changed);
        let entry = store.get("codex", "sess-1").await.unwrap();
        assert_eq!(entry["sessionType"], json!("freshcodex"));
        assert_eq!(entry["sessionTypeSource"], json!("explicit"));

        // A fresh store instance (simulating a server restart) must read the same value
        // back from disk.
        let reloaded = SessionMetadataStore::new(dir.path());
        let entry2 = reloaded.get("codex", "sess-1").await.unwrap();
        assert_eq!(entry2, entry);
    }

    #[tokio::test]
    async fn set_without_source_always_overwrites_session_type() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        store
            .set("codex", "sess-1", "freshcodex", Some("explicit"))
            .await
            .unwrap();
        let changed = store.set("codex", "sess-1", "kilroy", None).await.unwrap();
        assert!(changed);
        let entry = store.get("codex", "sess-1").await.unwrap();
        assert_eq!(entry["sessionType"], json!("kilroy"));
        // sessionTypeSource is untouched when the caller doesn't supply one.
        assert_eq!(entry["sessionTypeSource"], json!("explicit"));
    }

    #[tokio::test]
    async fn set_does_not_downgrade_explicit_with_materialized() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        store
            .set("codex", "sess-1", "freshcodex", Some("explicit"))
            .await
            .unwrap();
        // Same sessionType, materialized source should NOT downgrade an explicit tag.
        let changed = store
            .set("codex", "sess-1", "freshcodex", Some("materialized"))
            .await
            .unwrap();
        assert!(!changed);
        let entry = store.get("codex", "sess-1").await.unwrap();
        assert_eq!(entry["sessionTypeSource"], json!("explicit"));
    }

    #[tokio::test]
    async fn set_applies_explicit_over_materialized() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        store
            .set("codex", "sess-1", "freshcodex", Some("materialized"))
            .await
            .unwrap();
        let changed = store
            .set("codex", "sess-1", "kilroy", Some("explicit"))
            .await
            .unwrap();
        assert!(changed);
        let entry = store.get("codex", "sess-1").await.unwrap();
        assert_eq!(entry["sessionType"], json!("kilroy"));
        assert_eq!(entry["sessionTypeSource"], json!("explicit"));
    }

    #[tokio::test]
    async fn set_no_op_returns_false_and_does_not_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        store
            .set("codex", "sess-1", "freshcodex", Some("explicit"))
            .await
            .unwrap();
        let changed = store
            .set("codex", "sess-1", "freshcodex", Some("explicit"))
            .await
            .unwrap();
        assert!(!changed);
    }

    #[tokio::test]
    async fn unknown_fields_on_disk_round_trip_losslessly() {
        // Simulates a real, already-populated session-metadata.json written by a version
        // of this store (or the legacy Node store) that persists a field this Rust port
        // never reads (`derivedTitle`, from the AI-title-generation path) alongside an
        // entry this port DOES touch.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-metadata.json");
        tokio::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "sessions": {
                    "codex": {
                        "sess-1": {
                            "sessionType": "freshcodex",
                            "sessionTypeSource": "explicit",
                            "derivedTitle": "A title nobody in this module wrote"
                        }
                    },
                    "claude": {
                        "sess-unrelated": { "sessionType": "freshclaude", "futureField": 42 }
                    }
                }
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        let store = SessionMetadataStore::new(dir.path());
        // Touch a DIFFERENT session (different provider/id) so sess-1's record is never
        // written to directly -- proves the whole file round-trips through load+save.
        let changed = store
            .set("opencode", "sess-2", "freshopencode", Some("explicit"))
            .await
            .unwrap();
        assert!(changed);

        let raw = tokio::fs::read_to_string(&path).await.unwrap();
        let on_disk: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            on_disk["sessions"]["codex"]["sess-1"]["derivedTitle"],
            json!("A title nobody in this module wrote")
        );
        assert_eq!(
            on_disk["sessions"]["claude"]["sess-unrelated"]["futureField"],
            json!(42)
        );
        assert_eq!(
            on_disk["sessions"]["opencode"]["sess-2"]["sessionType"],
            json!("freshopencode")
        );
    }

    #[tokio::test]
    async fn malformed_json_on_disk_is_tolerated_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-metadata.json");
        tokio::fs::write(&path, "{ not valid json").await.unwrap();
        let store = SessionMetadataStore::new(dir.path());
        // Must not panic/error -- degrades to an empty structure (matches the reference).
        assert_eq!(store.get("codex", "sess-1").await, None);
        let changed = store
            .set("codex", "sess-1", "freshcodex", Some("explicit"))
            .await
            .unwrap();
        assert!(changed);
    }

    #[tokio::test]
    async fn get_all_flattens_provider_session_id_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        store
            .set("codex", "sess-1", "freshcodex", Some("explicit"))
            .await
            .unwrap();
        store
            .set("opencode", "sess-2", "freshopencode", Some("explicit"))
            .await
            .unwrap();
        let all = store.get_all().await;
        assert_eq!(all.len(), 2);
        assert_eq!(all["codex:sess-1"]["sessionType"], json!("freshcodex"));
        assert_eq!(
            all["opencode:sess-2"]["sessionType"],
            json!("freshopencode")
        );
    }

    // ── Route-level tests ──────────────────────────────────────────────────

    fn valid_body() -> Value {
        json!({
            "provider": "codex",
            "sessionId": "sess-1",
            "sessionType": "freshcodex",
            "sessionTypeSource": "explicit",
        })
    }

    #[tokio::test]
    async fn missing_auth_header_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_session_metadata(
            State(state(SessionMetadataStore::new(dir.path()))),
            HeaderMap::new(),
            Json(valid_body()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_auth_token_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_session_metadata(
            State(state(SessionMetadataStore::new(dir.path()))),
            headers_with_token("wrong"),
            Json(valid_body()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn valid_post_returns_200_ok_true_changed_true() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        let resp = post_session_metadata(
            State(state(store.clone())),
            headers_with_token("tok"),
            Json(valid_body()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["ok"], json!(true));
        assert_eq!(value["changed"], json!(true));

        // And it actually persisted.
        let entry = store.get("codex", "sess-1").await.unwrap();
        assert_eq!(entry["sessionType"], json!("freshcodex"));
    }

    #[tokio::test]
    async fn second_identical_post_reports_changed_false() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        let _ = post_session_metadata(
            State(state(store.clone())),
            headers_with_token("tok"),
            Json(valid_body()),
        )
        .await;
        let resp = post_session_metadata(
            State(state(store)),
            headers_with_token("tok"),
            Json(valid_body()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["changed"], json!(false));
    }

    #[tokio::test]
    async fn missing_required_field_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_session_metadata(
            State(state(SessionMetadataStore::new(dir.path()))),
            headers_with_token("tok"),
            Json(json!({ "provider": "codex", "sessionId": "sess-1" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert!(value["error"]
            .as_str()
            .unwrap()
            .contains("Missing required fields"));
    }

    #[tokio::test]
    async fn unknown_provider_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = valid_body();
        body["provider"] = json!("not-a-real-provider");
        let resp = post_session_metadata(
            State(state(SessionMetadataStore::new(dir.path()))),
            headers_with_token("tok"),
            Json(body),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn unknown_session_type_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = valid_body();
        body["sessionType"] = json!("not-a-known-type");
        let resp = post_session_metadata(
            State(state(SessionMetadataStore::new(dir.path()))),
            headers_with_token("tok"),
            Json(body),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn session_type_source_is_optional() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = valid_body();
        body.as_object_mut().unwrap().remove("sessionTypeSource");
        let resp = post_session_metadata(
            State(state(SessionMetadataStore::new(dir.path()))),
            headers_with_token("tok"),
            Json(body),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
