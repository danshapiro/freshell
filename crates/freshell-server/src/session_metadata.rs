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
//! `get_all()` is a production read with TWO consumers: the resolve endpoint's
//! `sessionType` overlay (SYNC-06) and `session_directory`'s per-request `sessionType`
//! overlay (`apply_session_metadata`, Task 20, mirroring the reference embedding
//! `sessionType` inline via `codingCliIndexer`, `session-indexer.ts:1144-1148`);
//! `get()` remains for future read-surfaces. (This port's `crates/freshell-sessions`
//! directory index is a SEPARATE crate this module does not reach into — wiring
//! metadata into the directory listing is out of THIS module's
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
    ///
    /// b8ke e3r3 F4: the handoff commit's hidden-flavor preservation read
    /// is this method's first production caller (the gate is off).
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
    ///
    /// Production read (SYNC-06): the resolve endpoint overlays match
    /// `sessionType` from this store, mirroring Node's
    /// `session-indexer.ts:1159-1161` overlay. Keyed `"{provider}:{session_id}"`.
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
        self.set_with_checkpoint_workspace(
            provider,
            session_id,
            session_type,
            session_type_source,
            None,
        )
        .await
    }

    /// Merge the explicit workspace provenance selected when a fresh-agent
    /// session was created. Later flavor-only writes pass `None`, preserving
    /// this field along with the other metadata already stored for the session.
    pub async fn set_with_checkpoint_workspace(
        &self,
        provider: &str,
        session_id: &str,
        session_type: &str,
        session_type_source: Option<&str>,
        checkpoint_workspace: Option<&Value>,
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
        if let Some(workspace) = checkpoint_workspace {
            next.insert("checkpointWorkspace".to_string(), workspace.clone());
        }

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

    /// Unified agent names (Task 7): scope-only migration cleanup — remove
    /// one entry's `derivedTitle` field while preserving every other field
    /// (the same lossless copy-forward discipline as `set`). Returns
    /// `Ok(true)` iff the field was present and removed. The canonical
    /// session-names authority owns scoped titles once the consolidation
    /// receipt commits; a stale derived title must never remain a competing
    /// alias.
    pub async fn clear_derived_title(
        &self,
        provider: &str,
        session_id: &str,
    ) -> std::io::Result<bool> {
        let mut guard = self.inner.lock().await;
        let mut data = Self::load_locked(&mut guard, &self.path).await;

        let root = data
            .as_object_mut()
            .expect("metadata file root is always loaded as an object (see load_locked)");
        let Some(sessions_obj) = root.get_mut("sessions").and_then(Value::as_object_mut) else {
            return Ok(false);
        };
        let Some(provider_obj) = sessions_obj
            .get_mut(provider)
            .and_then(Value::as_object_mut)
        else {
            return Ok(false);
        };
        let Some(entry) = provider_obj
            .get_mut(session_id)
            .and_then(Value::as_object_mut)
        else {
            return Ok(false);
        };
        if entry.remove("derivedTitle").is_none() {
            return Ok(false);
        }
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

    /// b8ke ext r28 F4: the handoff flavor write's PRE-COMMIT probe —
    /// proves the metadata directory accepts a temp write WITHOUT any
    /// durable mutation (the probe file is removed immediately). The
    /// runner stages the flavor inside the Handoff window: a disk
    /// failure here answers the typed SESSION_METADATA_WRITE_FAILED
    /// failure BEFORE the target commits (the e3r2 F3 contract), while
    /// the durable rename happens only in the staged commit — after
    /// Live(targetKind). A dropped staged future can leak at most this
    /// inert, never-renamed probe file.
    pub async fn probe_writable(&self) -> std::io::Result<()> {
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
        let probe_path = dir.join(format!("session-metadata.json.probe-{pid}-{millis}"));
        tokio::fs::write(&probe_path, b"probe").await?;
        let _ = tokio::fs::remove_file(&probe_path).await;
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
    /// W5 fix-forward (mirroring `sessions::SessionsState`'s GAP-1 fix): the
    /// shared broadcast bus + monotonic `sessions.changed` revision counter --
    /// the SAME `Arc`s as `WsState`/`FreshAgentState`/`SessionsState`, unified
    /// in commit b068d28b -- so a metadata write that actually changes the
    /// persisted `sessionType` broadcasts directly, instead of waiting on the
    /// periodic session-directory sweep (which is structurally blind to
    /// metadata-only changes: `IndexedSession` carries no `sessionType`
    /// field). Legacy parity: `POST /api/session-metadata`
    /// (`sessions-router.ts:220-244`) triggers `codingCliIndexer.refresh()` on
    /// a successful write, and `SessionsSyncService`'s differ
    /// (`projection.ts:32-49`) treats `sessionType` as part of the comparable
    /// snapshot, so a tag change there fans out `sessions.changed` (indirectly,
    /// via the refresh) in the reference.
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    pub sessions_revision: Arc<std::sync::atomic::AtomicI64>,
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
        Ok(post) => {
            match apply_session_metadata_with_checkpoint_workspace(
                &state.store,
                &state.broadcast_tx,
                &state.sessions_revision,
                SessionMetadataUpdate {
                    provider: &post.provider,
                    session_id: &post.session_id,
                    session_type: &post.session_type,
                    session_type_source: post.session_type_source.as_deref(),
                    checkpoint_workspace: post.checkpoint_workspace.as_ref(),
                },
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

/// b8ke e3r2 F3: the metadata write's CORE — `store.set` plus the
/// changed-gated `sessions.changed` revision broadcast — shared by the
/// `POST /api/session-metadata` handler and the handoff commit's
/// server-atomic flavor writer, so the handoff path routes through the
/// metadata API's exact semantics (the revision broadcast fires).
pub async fn apply_session_metadata(
    store: &SessionMetadataStore,
    broadcast_tx: &tokio::sync::broadcast::Sender<String>,
    sessions_revision: &std::sync::atomic::AtomicI64,
    provider: &str,
    session_id: &str,
    session_type: &str,
    session_type_source: Option<&str>,
) -> std::io::Result<bool> {
    apply_session_metadata_with_checkpoint_workspace(
        store,
        broadcast_tx,
        sessions_revision,
        SessionMetadataUpdate {
            provider,
            session_id,
            session_type,
            session_type_source,
            checkpoint_workspace: None,
        },
    )
    .await
}

struct SessionMetadataUpdate<'a> {
    provider: &'a str,
    session_id: &'a str,
    session_type: &'a str,
    session_type_source: Option<&'a str>,
    checkpoint_workspace: Option<&'a Value>,
}

async fn apply_session_metadata_with_checkpoint_workspace(
    store: &SessionMetadataStore,
    broadcast_tx: &tokio::sync::broadcast::Sender<String>,
    sessions_revision: &std::sync::atomic::AtomicI64,
    update: SessionMetadataUpdate<'_>,
) -> std::io::Result<bool> {
    let changed = match update.checkpoint_workspace {
        Some(workspace) => {
            store
                .set_with_checkpoint_workspace(
                    update.provider,
                    update.session_id,
                    update.session_type,
                    update.session_type_source,
                    Some(workspace),
                )
                .await?
        }
        None => {
            store
                .set(
                    update.provider,
                    update.session_id,
                    update.session_type,
                    update.session_type_source,
                )
                .await?
        }
    };
    // W5 fix-forward: broadcast `sessions.changed` directly for a
    // metadata write that actually changed the persisted entry
    // (mirroring `sessions::patch_session`'s GAP-1 fix). Guarded on
    // `changed` -- the store's own no-op comparison (semantic `Map`
    // equality, see `SessionMetadataStore::set`'s doc comment) is the
    // same gate the periodic session-directory sweep would otherwise
    // never trip for a metadata-only change.
    if changed {
        let revision = sessions_revision.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let frame = json!({ "type": "sessions.changed", "revision": revision }).to_string();
        let _ = broadcast_tx.send(frame);
    }
    Ok(changed)
}

/// `SessionMetadataPostSchema.safeParse` (`sessions-router.ts:220-227`). Returns
/// `(provider, sessionId, sessionType, sessionTypeSource)` on success, or a list of
/// zod-issue-shaped `{path, message}` objects on failure (schema-approximate — the
/// reference's exact zod issue shape is not part of any client contract this port must
/// match; the client only reads the top-level `error` string on a 400).
struct ValidatedSessionMetadataPost {
    provider: String,
    session_id: String,
    session_type: String,
    session_type_source: Option<String>,
    checkpoint_workspace: Option<Value>,
}

fn validate_post_body(body: &Value) -> Result<ValidatedSessionMetadataPost, Vec<Value>> {
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

    let checkpoint_workspace = body.get("checkpointWorkspace");
    let checkpoint_workspace_value = match checkpoint_workspace {
        None => None,
        Some(Value::Object(workspace)) => {
            let path = workspace.get("path").and_then(Value::as_str);
            let provenance = workspace.get("provenance").and_then(Value::as_str);
            if path.is_some_and(|path| {
                !path.is_empty() && path.encode_utf16().count() <= 4096 && !path.contains('\0')
            }) && provenance == Some("directory-picker")
            {
                Some(json!({
                    "path": path.unwrap(),
                    "provenance": "directory-picker",
                }))
            } else {
                issues.push(json!({
                    "path": ["checkpointWorkspace"],
                    "message": "Expected a bounded directory-picker workspace",
                }));
                None
            }
        }
        Some(_) => {
            issues.push(json!({
                "path": ["checkpointWorkspace"],
                "message": "Expected a bounded directory-picker workspace",
            }));
            None
        }
    };

    if !issues.is_empty() {
        return Err(issues);
    }

    Ok(ValidatedSessionMetadataPost {
        provider: provider.unwrap().to_string(),
        session_id: session_id.unwrap().to_string(),
        session_type: session_type.unwrap().to_string(),
        session_type_source: session_type_source
            .and_then(Value::as_str)
            .map(str::to_string),
        checkpoint_workspace: checkpoint_workspace_value,
    })
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
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        SessionMetadataApiState {
            auth_token: Arc::new("tok".to_string()),
            store,
            broadcast_tx: Arc::new(tx),
            sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
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
    async fn explicit_checkpoint_workspace_survives_later_materialized_metadata_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        let workspace = json!({
            "path": "/tmp/non-git-workspace",
            "provenance": "directory-picker",
        });
        let mut selected = valid_body();
        selected["checkpointWorkspace"] = workspace.clone();
        let selected_response = post_session_metadata(
            State(state(store.clone())),
            headers_with_token("tok"),
            Json(selected),
        )
        .await;
        assert_eq!(selected_response.status(), StatusCode::OK);
        assert_eq!(
            store.get("codex", "sess-1").await.unwrap()["checkpointWorkspace"],
            workspace
        );

        let mut refreshed = valid_body();
        refreshed["sessionTypeSource"] = json!("materialized");
        let _ = post_session_metadata(
            State(state(store.clone())),
            headers_with_token("tok"),
            Json(refreshed),
        )
        .await;
        assert_eq!(
            store.get("codex", "sess-1").await.unwrap()["checkpointWorkspace"],
            workspace
        );
        let reloaded = SessionMetadataStore::new(dir.path());
        assert_eq!(
            reloaded.get("codex", "sess-1").await.unwrap()["checkpointWorkspace"],
            workspace
        );
    }

    #[tokio::test]
    async fn checkpoint_workspace_rejects_non_picker_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = valid_body();
        body["checkpointWorkspace"] = json!({
            "path": "/tmp/project",
            "provenance": "resolved-project",
        });
        let response = post_session_metadata(
            State(state(SessionMetadataStore::new(dir.path()))),
            headers_with_token("tok"),
            Json(body),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
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

    /// W5 fix-forward (mirroring `sessions.rs`'s
    /// `patch_rename_broadcasts_sessions_changed_with_increased_revision`):
    /// legacy indirectly broadcasts `sessions.changed` on a session-metadata
    /// tag change (`codingCliIndexer.refresh()` -> `SessionsSyncService`'s
    /// differ, which treats `sessionType` as part of the comparable
    /// projection, `projection.ts:32-49`). Proves a metadata write that
    /// actually changes the persisted tag produces exactly one
    /// `sessions.changed` frame with a positive revision.
    #[tokio::test]
    async fn metadata_change_broadcasts_sessions_changed_with_increased_revision() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(SessionMetadataStore::new(dir.path()));

        // Subscribe BEFORE the POST so the `sessions.changed` send lands in
        // this receiver's buffer.
        let mut broadcast_rx = st.broadcast_tx.subscribe();

        let resp = post_session_metadata(
            State(st.clone()),
            headers_with_token("tok"),
            Json(valid_body()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let frame = broadcast_rx
            .try_recv()
            .expect("sessions.changed broadcast fired for the metadata write");
        let frame: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(frame["type"], json!("sessions.changed"));
        let revision = frame["revision"].as_i64().expect("revision is a number");
        assert!(revision > 0, "revision must be a positive counter value");

        // Exactly one frame -- no duplicate/extra broadcast for a single
        // changing write.
        assert!(
            broadcast_rx.try_recv().is_err(),
            "exactly one broadcast frame expected for a single metadata change"
        );
    }

    /// Companion to the broadcast test above: a second, IDENTICAL POST is a
    /// no-op per the store's own change-detection gate (`changed: false`,
    /// proven separately by `second_identical_post_reports_changed_false`)
    /// and must NOT produce a second `sessions.changed` frame -- broadcasting
    /// on a write that persisted nothing would be a spurious client refetch.
    #[tokio::test]
    async fn metadata_no_op_write_does_not_broadcast_a_second_frame() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(SessionMetadataStore::new(dir.path()));
        let mut broadcast_rx = st.broadcast_tx.subscribe();

        // First write actually changes the tag -- must broadcast exactly once.
        let _ = post_session_metadata(
            State(st.clone()),
            headers_with_token("tok"),
            Json(valid_body()),
        )
        .await;
        broadcast_rx
            .try_recv()
            .expect("sessions.changed broadcast fired for the first (changing) write");

        // Second, IDENTICAL write is a no-op -- must NOT produce a second
        // broadcast frame.
        let resp = post_session_metadata(
            State(st.clone()),
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

        assert!(
            broadcast_rx.try_recv().is_err(),
            "no broadcast expected for a no-op metadata write"
        );
    }
}
