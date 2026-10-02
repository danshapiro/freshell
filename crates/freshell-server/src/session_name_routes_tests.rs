//! Unified agent names (Task 2): REAL service/router integration tests for
//! the canonical session-name routes and the route-compatibility contract —
//! every surface (session/terminal/pane/tab + the canonical route) resolves
//! the SAME durable record, pending names survive the bind, and a reopen of
//! the store reads identical name/revision (the shared-name guarantee the
//! plan's Step 1 pins).
//!
//! These drive the REAL `SessionNames` store on a temp dir (no mocks for the
//! authority — the cross-process strictness is the point) and the REAL
//! routers (`sessions`, `terminals`, and `freshell_freshagent`'s pane/tab
//! routes over a seeded layout).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::util::ServiceExt;

use freshell_freshagent::naming::{
    BindNameInput, PendingNameInput, RenameNameInput, SessionNaming,
};
use freshell_freshagent::FreshAgentState;
use freshell_protocol::native_location::{
    NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
};
use freshell_protocol::session_names::{
    NameIntent, NameSource, NamedProvider, SessionNameRecord, SessionNameRef, SessionNameUpdate,
};

use super::SessionNamesState;
use crate::session_names::SessionNames;

/// Same fake transport as `sessions_tests`'s: the wired-in result IS the
/// Gemini reply. NO live Gemini calls in tests, ever.
struct FakeGemini(Result<String, String>);
impl crate::ai_title::GeminiTransport for FakeGemini {
    fn generate_content(
        &self,
        _p: String,
        _m: u32,
    ) -> crate::ai_title::BoxFuture<Result<String, String>> {
        let r = self.0.clone();
        Box::pin(async move { r })
    }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

fn temp_home() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "frs-session-names-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn names_state(home: &std::path::Path) -> SessionNamesState {
    let names = SessionNames::open(home.join(".freshell")).expect("store opens");
    SessionNamesState {
        auth_token: Arc::new("tok".to_string()),
        names,
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
    }
}

/// The session rename surface with the SAME naming authority wired the way
/// `main.rs` wires it (the identity registry carries the sink), and — since
/// delta-review round 4, finding 1 — the SAME SESSION-06 metadata store every
/// server surface reads, so the shared kilroy-lane seam can discriminate a
/// kilroy-only claude session (legacy override ladder) from a scoped one
/// (naming authority) the way production does. Tests that need a kilroy
/// session tag the store and build through [`sessions_router_state`].
fn sessions_router(home: &std::path::Path, names: &Arc<SessionNames>) -> Router {
    let metadata = crate::session_metadata::SessionMetadataStore::new(home.join(".freshell"));
    crate::sessions::router(sessions_router_state(home, names, metadata))
}

/// The metadata-taking variant of [`sessions_router`] — the kilroy-lane
/// tests tag the store (the SPA's own `POST /api/session-metadata` write)
/// BEFORE the router is built over it.
fn sessions_router_state(
    home: &std::path::Path,
    names: &Arc<SessionNames>,
    metadata: crate::session_metadata::SessionMetadataStore,
) -> crate::sessions::SessionsState {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    identity.set_session_naming(names.clone());
    crate::sessions::SessionsState {
        auth_token: Arc::new("tok".to_string()),
        settings: crate::settings_store::SettingsStore::load(
            Some(home),
            vec!["claude".into(), "codex".into(), "opencode".into()],
        ),
        identity,
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: Arc::new(tx),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        name_auth: crate::ai_title::GeminiSessionNameAuth::direct_for_test(
            crate::ai_title::AiKeyCell::init(None, None),
        ),
        gemini: Arc::new(FakeGemini(Err("unused".into()))),
        metadata,
        index: None,
        generation_wake: None,
    }
}

/// The pane/tab rename surface: a fresh-agent state with the authority wired
/// and a seeded single-pane layout whose pane content is the given scoped
/// content (carrying `sessionRef` so the route resolves the durable record).
fn fresh_router(names: &Arc<SessionNames>, pane_content: Value) -> Router {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
    state.set_session_naming(names.clone());
    let sync: freshell_protocol::UiLayoutSync = serde_json::from_value(json!({
        "tabs": [{ "id": "t1", "title": "First" }],
        "activeTabId": "t1",
        "layouts": { "t1": { "type": "leaf", "id": "p1", "content": pane_content } },
        "activePane": { "t1": "p1" },
        "paneTitles": {},
        "paneTitleSetByUser": {},
        "timestamp": 1,
    }))
    .expect("UiLayoutSync parses");
    state.layout.update_from_ui(&sync, "test-conn");
    freshell_freshagent::router(state)
}

async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn patch(router: Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let resp = router
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(uri)
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

async fn post_read(router: Router, refs: Value) -> (StatusCode, Value) {
    let resp = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session-names/read")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "refs": refs }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

/// Admit a pending handle for `provider` (the create-lane admission).
async fn admit_pending(
    names: &Arc<SessionNames>,
    handle: &str,
    provider: NamedProvider,
    cwd: Option<&str>,
) -> SessionNameUpdate {
    names
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider,
            cwd: cwd.map(str::to_string),
        })
        .await
        .expect("pending admission")
}

/// Bind a pending handle onto a durable session with VERIFIED evidence (the
/// runtime lanes' verified transition).
async fn bind_verified(
    names: &Arc<SessionNames>,
    handle: &str,
    provider: NamedProvider,
    session_id: &str,
) -> SessionNameUpdate {
    let acquisition = NativeAcquisition {
        location: match provider {
            NamedProvider::Claude => NativeLocation::Claude {
                config_root: "/h/.claude".into(),
                transcript_path: Some(format!("/h/.claude/projects/-p/{session_id}.jsonl")),
                project_directory_key: None,
                transcript_cwd: None,
                effective_project_key_override: None,
            },
            NamedProvider::Codex => NativeLocation::Codex {
                codex_home: "/h/.codex".into(),
                native_thread_id: Some(session_id.to_string()),
                rollout_path: Some(format!("/h/.codex/sessions/{session_id}.jsonl")),
                persistence_evidence: None,
            },
            NamedProvider::Opencode => NativeLocation::Opencode {
                database_path: "/h/opencode.db".into(),
                native_session_id: Some(session_id.to_string()),
                original_directory: None,
                owned_local_endpoint: None,
            },
        },
        evidence: NativeEvidenceKind::PersistedMetadata,
        persistence: NativePersistence::Verified,
    };
    names
        .bind_pending(BindNameInput {
            pending: SessionNameRef::Pending {
                id: handle.to_string(),
            },
            target: SessionNameRef::Session {
                provider,
                session_id: session_id.to_string(),
            },
            acquisition,
        })
        .await
        .expect("verified bind")
}

/// The scoped pane content for a mode, carrying the durable `sessionRef` the
/// pane/tab routes resolve (the established-identity path).
fn scoped_pane_content(mode: &str, provider: &str, session_id: &str) -> Value {
    json!({
        "kind": "terminal",
        "mode": mode,
        "sessionRef": { "provider": provider, "sessionId": session_id },
    })
}

/// The scoped fresh-agent pane content for a session type.
fn scoped_fresh_content(session_type: &str, provider: &str, session_id: &str) -> Value {
    json!({
        "kind": "fresh-agent",
        "sessionType": session_type,
        "provider": provider,
        "sessionId": session_id,
        "sessionRef": { "provider": provider, "sessionId": session_id },
    })
}

// ── the canonical route + the route-compatibility contract ─────────────────

/// The six-mode parameterized core: for every scoped mode, a rename through
/// ANY surface targets the SAME durable record — the canonical route, the
/// session route, the terminal route, and the pane/tab routes all read back
/// one name/revision, and a store REOPEN reads the identical record (the
/// shared-name + durability guarantee).
#[tokio::test]
async fn every_surface_renames_the_same_durable_record_across_all_six_modes() {
    for (provider, session_id, label, pane_content) in [
        (
            NamedProvider::Claude,
            "aaaa1111-0000-4000-8000-000000000001",
            "claude",
            scoped_pane_content("claude", "claude", "aaaa1111-0000-4000-8000-000000000001"),
        ),
        (
            NamedProvider::Codex,
            "bbbb2222-0000-4000-8000-000000000002",
            "codex",
            scoped_pane_content("codex", "codex", "bbbb2222-0000-4000-8000-000000000002"),
        ),
        (
            NamedProvider::Opencode,
            "ses_opencode_0000000000000000003",
            "opencode",
            scoped_pane_content("opencode", "opencode", "ses_opencode_0000000000000000003"),
        ),
        (
            NamedProvider::Claude,
            "cccc3333-0000-4000-8000-000000000003",
            "freshclaude",
            scoped_fresh_content(
                "freshclaude",
                "claude",
                "cccc3333-0000-4000-8000-000000000003",
            ),
        ),
        (
            NamedProvider::Codex,
            "dddd4444-0000-4000-8000-000000000004",
            "freshcodex",
            scoped_fresh_content(
                "freshcodex",
                "codex",
                "dddd4444-0000-4000-8000-000000000004",
            ),
        ),
        (
            NamedProvider::Opencode,
            "ses_opencode_0000000000000000006",
            "freshopencode",
            scoped_fresh_content(
                "freshopencode",
                "opencode",
                "ses_opencode_0000000000000000006",
            ),
        ),
    ] {
        let home = temp_home();
        let state = names_state(&home);
        let names = state.names.clone();

        // The create lane's pending admission + the verified bind (identity
        // established with durable evidence).
        admit_pending(&names, "handle-1", provider, Some("/w")).await;
        let bound = bind_verified(&names, "handle-1", provider, session_id).await;
        assert_eq!(
            bound.record.name, "w",
            "{label}: the directory-basename fallback names the pending record"
        );
        // The pending handle now REDIRECTS to the durable record.
        let redirected = names
            .get(vec![SessionNameRef::Pending {
                id: "handle-1".into(),
            }])
            .await
            .expect("get");
        assert_eq!(redirected[0].record.name_ref, bound.record.name_ref);

        // 1. The canonical route.
        let (status, body) = {
            let canonical = super::router(state.clone());
            patch(
                canonical,
                "/api/session-names",
                json!({
                    "target": { "kind": "session", "provider": provider, "sessionId": session_id },
                    "name": "Canonical Name",
                    "nameIntent": "user",
                }),
            )
            .await
        };
        assert_eq!(status, StatusCode::OK, "{label}: {body}");
        let canonical_update: SessionNameUpdate =
            serde_json::from_value(body).expect("SessionNameUpdate shape");
        assert_eq!(canonical_update.record.name, "Canonical Name");

        // 2. The session route (titleOverride compatibility).
        let (status, body) = {
            let sessions = sessions_router(&home, &names);
            patch(
                sessions,
                &format!("/api/sessions/{session_id}?provider={}", provider.as_str()),
                json!({ "titleOverride": "Session Route Name", "nameIntent": "user" }),
            )
            .await
        };
        assert_eq!(status, StatusCode::OK, "{label}: {body}");
        let session_update: SessionNameUpdate = serde_json::from_value(body["sessionName"].clone())
            .unwrap_or_else(|_| panic!("{label}: session route carries the update: {body}"));

        // 3. The pane route (freshagent over the seeded scoped layout).
        let panes = fresh_router(&names, pane_content.clone());
        let (status, body) = patch(
            panes,
            "/api/panes/p1",
            json!({ "name": "Pane Route Name", "nameIntent": "user" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{label}: {body}");
        let pane_update: SessionNameUpdate =
            serde_json::from_value(body["data"]["sessionName"].clone())
                .unwrap_or_else(|_| panic!("{label}: pane route carries the update: {body}"));

        // 4. The tab route on the same seeded tab targets the SAME record.
        let tabs_router = fresh_router(&names, pane_content.clone());
        let (status, body) = patch(
            tabs_router,
            "/api/tabs/t1",
            json!({ "name": "Tab Route Name", "nameIntent": "user" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{label}: {body}");
        let tab_update: SessionNameUpdate =
            serde_json::from_value(body["data"]["sessionName"].clone())
                .unwrap_or_else(|_| panic!("{label}: tab route carries the update: {body}"));

        // Every surface's accepted record IS the same durable record: each
        // rename moved the SAME record (name + ref), and the revisions are
        // strictly increasing in rename order.
        for update in [&session_update, &pane_update, &tab_update] {
            assert_eq!(
                update.record.name_ref, canonical_update.record.name_ref,
                "{label}: every surface identifies the same record"
            );
        }
        assert!(pane_update.record.revision > canonical_update.record.revision);
        assert!(tab_update.record.revision > pane_update.record.revision);

        // 5. The read route resolves the same record — and a REOPEN of the
        // store (fresh process semantics) reads the identical name/revision.
        let (status, body) = {
            let canonical = super::router(state.clone());
            post_read(
                canonical,
                json!([{ "kind": "session", "provider": provider, "sessionId": session_id }]),
            )
            .await
        };
        assert_eq!(status, StatusCode::OK, "{label}: {body}");
        let read_record: SessionNameRecord =
            serde_json::from_value(body["names"][0]["record"].clone())
                .expect("{label}: read answers the record");
        assert_eq!(read_record.name, "Tab Route Name");
        assert_eq!(read_record.revision, tab_update.record.revision);

        let reopened = SessionNames::open(home.join(".freshell")).expect("reopen");
        let reopened_update = reopened
            .get(vec![SessionNameRef::Session {
                provider,
                session_id: session_id.to_string(),
            }])
            .await
            .expect("reopen get")[0]
            .clone();
        assert_eq!(
            reopened_update.record, read_record,
            "{label}: reopen reads identically"
        );

        // The settings override store NEVER acquired a competing scoped
        // title through any surface.
        let raw_config =
            std::fs::read_to_string(home.join(".freshell").join("config.json")).unwrap_or_default();
        assert!(
            !raw_config.contains("Canonical Name")
                && !raw_config.contains("Session Route Name")
                && !raw_config.contains("Pane Route Name")
                && !raw_config.contains("Tab Route Name"),
            "{label}: no competing settings override may carry the scoped title"
        );
        std::fs::remove_dir_all(&home).ok();
    }
}

/// A pending pane renamed BEFORE its durable identity exists keeps the name
/// through the verified bind: the pre-durable rename targets the pending
/// handle, and the bind transfers it onto the durable record atomically (the
/// user's manual rename outranks the fallback).
#[tokio::test]
async fn pending_pane_rename_survives_the_verified_bind() {
    let home = temp_home();
    let state = names_state(&home);
    let names = state.names.clone();

    admit_pending(&names, "handle-p", NamedProvider::Codex, Some("/w")).await;
    // Rename the PENDING pane (the pre-identity rename) with user intent.
    let (status, body) = {
        let canonical = super::router(state.clone());
        patch(
            canonical,
            "/api/session-names",
            json!({
                "target": { "kind": "pending", "id": "handle-p" },
                "name": "Named Before Identity",
                "nameIntent": "user",
            }),
        )
        .await
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    let renamed: SessionNameUpdate = serde_json::from_value(body).unwrap();
    assert_eq!(renamed.record.source, NameSource::Manual);

    // The verified bind transfers the manual name onto the durable record.
    let bound = bind_verified(&names, "handle-p", NamedProvider::Codex, "thread-uuid-9").await;
    assert_eq!(bound.record.name, "Named Before Identity");
    assert_eq!(bound.record.source, NameSource::Manual);
    // The pending ref now redirects to the durable record.
    let redirect = names
        .get(vec![SessionNameRef::Pending {
            id: "handle-p".into(),
        }])
        .await
        .unwrap()[0]
        .clone();
    assert_eq!(redirect.record.name_ref, bound.record.name_ref);
    std::fs::remove_dir_all(&home).ok();
}

/// Codex's prospective start: a `thread/start` id/path is NOT verified
/// persistence. Runtime-ID reads resolve the PENDING name (the handle
/// association), a restart/mint-initial RETAINS the handle, and the later
/// real materialization binds EXACTLY once (a second verified bind is the
/// idempotent Read of the same record).
#[tokio::test]
async fn codex_prospective_start_resolves_pending_until_verified_materialization() {
    let home = temp_home();
    let state = names_state(&home);
    let names = state.names.clone();

    admit_pending(&names, "handle-cx", NamedProvider::Codex, Some("/w")).await;
    // Prospective acquisition (thread started, rollout not yet written).
    names
        .record_acquisition(
            SessionNameRef::Pending {
                id: "handle-cx".into(),
            },
            NativeAcquisition {
                location: NativeLocation::Codex {
                    codex_home: "/h/.codex".into(),
                    native_thread_id: Some("thread-prosp".into()),
                    rollout_path: None,
                    persistence_evidence: None,
                },
                evidence: NativeEvidenceKind::InitializedRuntime,
                persistence: NativePersistence::Prospective,
            },
        )
        .await
        .expect("prospective retained");

    // Runtime-ID reads still resolve the PENDING name (the handle).
    let (status, body) = {
        let canonical = super::router(state.clone());
        post_read(canonical, json!([{ "kind": "pending", "id": "handle-cx" }])).await
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["names"][0]["record"]["name"], json!("w"));

    // A PROSPECTIVE bind is refused loudly (never a fabricated durable
    // binding off a bare start ack).
    let refused = names
        .bind_pending(BindNameInput {
            pending: SessionNameRef::Pending {
                id: "handle-cx".into(),
            },
            target: SessionNameRef::Session {
                provider: NamedProvider::Codex,
                session_id: "thread-prosp".into(),
            },
            acquisition: NativeAcquisition {
                location: NativeLocation::Codex {
                    codex_home: "/h/.codex".into(),
                    native_thread_id: Some("thread-prosp".into()),
                    rollout_path: None,
                    persistence_evidence: None,
                },
                evidence: NativeEvidenceKind::InitializedRuntime,
                persistence: NativePersistence::Prospective,
            },
        })
        .await;
    assert!(refused.is_err(), "prospective evidence cannot bind");

    // Zero-turn restart/mint-initial RETAINS the handle: the reopened store
    // still answers the pending record.
    let reopened = SessionNames::open(home.join(".freshell")).unwrap();
    let still_pending = reopened
        .get(vec![SessionNameRef::Pending {
            id: "handle-cx".into(),
        }])
        .await
        .unwrap()[0]
        .clone();
    assert_eq!(still_pending.record.name, "w");

    // Later real materialization binds — exactly once (the second verified
    // bind of the same target is the idempotent Read).
    let first = bind_verified(&names, "handle-cx", NamedProvider::Codex, "thread-prosp").await;
    let first_revision = first.record.revision;
    let second = bind_verified(&names, "handle-cx", NamedProvider::Codex, "thread-prosp").await;
    assert_eq!(
        second.record.revision, first_revision,
        "re-binding the same handle/target is the idempotent Read"
    );
    std::fs::remove_dir_all(&home).ok();
}

/// A scoped null/reset request NEVER clears a protected name through any
/// route: 400 NAME_RESET_UNSUPPORTED on the canonical route and the session
/// route alike.
#[tokio::test]
async fn scoped_reset_is_refused_on_every_surface() {
    let home = temp_home();
    let state = names_state(&home);
    let names = state.names.clone();
    admit_pending(&names, "handle-r", NamedProvider::Claude, Some("/w")).await;
    bind_verified(&names, "handle-r", NamedProvider::Claude, "sess-reset-1").await;
    names
        .rename(RenameNameInput {
            target: SessionNameRef::Session {
                provider: NamedProvider::Claude,
                session_id: "sess-reset-1".into(),
            },
            name: "Protected".into(),
            intent: NameIntent::User,
            if_revision: None,
        })
        .await
        .unwrap();

    // The canonical route.
    let (status, body) = {
        let canonical = super::router(state.clone());
        patch(
            canonical,
            "/api/session-names",
            json!({
                "target": { "kind": "session", "provider": "claude", "sessionId": "sess-reset-1" },
                "name": "  ",
            }),
        )
        .await
    };
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("NAME_RESET_UNSUPPORTED"));

    // The session route.
    let (status, body) = {
        let sessions = sessions_router(&home, &names);
        patch(
            sessions,
            "/api/sessions/sess-reset-1?provider=claude",
            json!({ "titleOverride": null }),
        )
        .await
    };
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], json!("NAME_RESET_UNSUPPORTED"));

    // The name SURVIVED every refusal.
    let survivor = names
        .get(vec![SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-reset-1".into(),
        }])
        .await
        .unwrap()[0]
        .clone();
    assert_eq!(survivor.record.name, "Protected");
    std::fs::remove_dir_all(&home).ok();
}

/// Delta-review round 4, finding 1 (the routes' kilroy blind spot): a
/// KILROY-ONLY session — the metadata store types it `kilroy`; its
/// provider string is `claude` — keeps the LEGACY session-override path.
/// Its user rename writes the settings override (never the scoped path's
/// 404 NAME_NOT_FOUND from the authority the sweep never gave it a record
/// in), and its still-offered reset clears the override (never the scoped
/// path's 400 NAME_RESET_UNSUPPORTED).
#[tokio::test]
async fn a_kilroy_only_session_rename_keeps_the_legacy_override_path() {
    let home = temp_home();
    let names = SessionNames::open(home.join(".freshell")).expect("store opens");
    // The SPA's own sessionType tag — the ONLY thing that says this
    // provider-`claude` session is kilroy.
    let metadata = crate::session_metadata::SessionMetadataStore::new(home.join(".freshell"));
    metadata
        .set("claude", "s-kilroy-rename", "kilroy", Some("explicit"))
        .await
        .unwrap();
    let st = sessions_router_state(&home, &names, metadata);
    let sessions = crate::sessions::router(st.clone());

    // Rename: 200 + the legacy override row — the kilroy UI's own path.
    let (status, body) = patch(
        sessions,
        "/api/sessions/s-kilroy-rename?provider=claude",
        json!({ "titleOverride": "Kilroy Renamed", "nameIntent": "user" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["titleOverride"], json!("Kilroy Renamed"));
    assert_eq!(body["titleSource"], json!("user"));
    let row = st
        .settings
        .session_overrides()
        .get("claude:s-kilroy-rename")
        .cloned()
        .expect("the legacy override row carries the kilroy rename");
    assert_eq!(row["titleOverride"], json!("Kilroy Renamed"));
    assert_eq!(row["titleSource"], json!("user"));
    // The naming authority NEVER acquired a record — never a competing
    // kilroy record (the sweep's own guarantee, kept intact by this route).
    assert!(
        names
            .get(vec![SessionNameRef::Session {
                provider: NamedProvider::Claude,
                session_id: "s-kilroy-rename".into(),
            }])
            .await
            .unwrap()
            .is_empty(),
        "a kilroy-only session never enters the naming authority through a rename"
    );

    // Reset: the still-offered kilroy control clears the override.
    let (status, body) = patch(
        crate::sessions::router(st.clone()),
        "/api/sessions/s-kilroy-rename?provider=claude",
        json!({ "titleOverride": null }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row = st
        .settings
        .session_overrides()
        .get("claude:s-kilroy-rename")
        .cloned()
        .unwrap_or_default();
    assert!(row.get("titleOverride").is_none(), "cleared row: {row}");
    assert!(row.get("titleSource").is_none(), "cleared row: {row}");
    std::fs::remove_dir_all(&home).ok();
}

/// The singular-name half of the same seam: a durable session the metadata
/// ALSO types kilroy, but whose canonical record exists through the claude
/// mode (the create-lane admission + verified bind — the dual-mode
/// scenario), is NOT kilroy-only. The rename routes through the naming
/// authority — ONE singular saved name everywhere, never a competing
/// settings title — exactly like every scoped surface.
#[tokio::test]
async fn a_dual_mode_kilroy_typed_session_renames_through_the_authority() {
    let home = temp_home();
    let names = SessionNames::open(home.join(".freshell")).expect("store opens");
    admit_pending(&names, "handle-dual", NamedProvider::Claude, Some("/w")).await;
    bind_verified(&names, "handle-dual", NamedProvider::Claude, "s-dual-mode").await;
    let metadata = crate::session_metadata::SessionMetadataStore::new(home.join(".freshell"));
    metadata
        .set("claude", "s-dual-mode", "kilroy", Some("explicit"))
        .await
        .unwrap();
    let st = sessions_router_state(&home, &names, metadata);
    let (status, body) = patch(
        crate::sessions::router(st.clone()),
        "/api/sessions/s-dual-mode?provider=claude",
        json!({ "titleOverride": "One Singular Name", "nameIntent": "user" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The ONE canonical record carries the rename...
    assert_eq!(
        body["sessionName"]["record"]["name"],
        json!("One Singular Name"),
        "the session route answers the accepted naming update: {body}"
    );
    let record = names
        .get(vec![SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "s-dual-mode".into(),
        }])
        .await
        .unwrap()[0]
        .clone();
    assert_eq!(record.record.name, "One Singular Name");
    assert_eq!(record.record.source, NameSource::Manual);
    // ...and the settings ladder never acquired a competing scoped title.
    assert!(
        st.settings
            .session_overrides()
            .get("claude:s-dual-mode")
            .is_none(),
        "the dual-mode session's one name lives in the authority alone"
    );
    std::fs::remove_dir_all(&home).ok();
}

/// Delta-review round 3, finding 8: an unknown `nameIntent` string (a typo
/// like `"User"`) must be rejected loudly by the convenience routes, exactly
/// as the canonical PATCH route rejects it (serde enum) and the CLI/MCP
/// reject it — never silently defaulted to `automatic`, which quietly strips
/// an intended rename's permanence. The safe direction is preserved either
/// way: rejection forces the caller to state the intent correctly.
#[tokio::test]
async fn an_unknown_name_intent_is_rejected_loudly_not_silently_defaulted() {
    let home = temp_home();
    let state = names_state(&home);
    let names = state.names.clone();
    admit_pending(&names, "handle-intent", NamedProvider::Claude, Some("/w")).await;
    bind_verified(
        &names,
        "handle-intent",
        NamedProvider::Claude,
        "sess-intent-1",
    )
    .await;

    // Control: the canonical PATCH route already rejects the typo loudly.
    let (status, body) = {
        let canonical = super::router(state.clone());
        patch(
            canonical,
            "/api/session-names",
            json!({
                "target": { "kind": "session", "provider": "claude", "sessionId": "sess-intent-1" },
                "name": "Typo Intent",
                "nameIntent": "User",
            }),
        )
        .await
    };
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // The session convenience route must match: the typo is a 400, and the
    // saved name is untouched (no silent automatic rename).
    let (status, body) = {
        let sessions = sessions_router(&home, &names);
        patch(
            sessions,
            "/api/sessions/sess-intent-1?provider=claude",
            json!({ "titleOverride": "Typo Intent", "nameIntent": "User" }),
        )
        .await
    };
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a typoed nameIntent is rejected loudly, not silently defaulted: {body}"
    );
    let survivor = names
        .get(vec![SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-intent-1".into(),
        }])
        .await
        .unwrap()[0]
        .clone();
    assert_ne!(
        survivor.record.name, "Typo Intent",
        "no silent automatic rename happened"
    );

    // The valid intents and the omitted default still work through the same
    // route (the loud gate must not over-apply).
    for intent in [None, Some("user"), Some("automatic")] {
        let (status, body) = {
            let sessions = sessions_router(&home, &names);
            patch(
                sessions,
                "/api/sessions/sess-intent-1?provider=claude",
                json!({ "titleOverride": "Valid Intent", "nameIntent": intent }),
            )
            .await
        };
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    std::fs::remove_dir_all(&home).ok();
}

/// Delta-review round 4, finding 3: a non-integer or beyond-JS-safe
/// `ifRevision` silently degraded the compare-and-set guard to an
/// UNGUARDED rename (the helper's `as_u64` + ceiling filter mapped every
/// malformed value to "no CAS"). Malformed revisions are now rejected
/// loudly with a 400 — the same discipline the helper's own `nameIntent`
/// handling (round 3, finding 8) and the canonical serde route already
/// apply — while a valid integer revision is still honored.
#[tokio::test]
async fn a_malformed_if_revision_is_rejected_loudly_not_silently_dropped() {
    let home = temp_home();
    let state = names_state(&home);
    let names = state.names.clone();
    admit_pending(&names, "handle-cas", NamedProvider::Claude, Some("/w")).await;
    let bound = bind_verified(&names, "handle-cas", NamedProvider::Claude, "sess-cas-1").await;
    let target = SessionNameRef::Session {
        provider: NamedProvider::Claude,
        session_id: "sess-cas-1".into(),
    };
    let uri = "/api/sessions/sess-cas-1?provider=claude";

    // Every malformed shape is a loud 400 — never a silently-unguarded
    // rename.
    for bad_revision in [
        json!("12"),                     // a string, not an integer
        json!(1.5),                      // a non-integral number
        json!(-5),                       // negative
        json!(true),                     // a bare boolean
        json!(9_007_199_254_740_993u64), // one beyond the JS-safe ceiling
    ] {
        let (status, body) = {
            let sessions = sessions_router(&home, &names);
            patch(
                sessions,
                uri,
                json!({ "titleOverride": "Must Not Land", "ifRevision": bad_revision }),
            )
            .await
        };
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "ifRevision {bad_revision} is rejected loudly, not silently dropped: {body}"
        );
        let survivor = names.get(vec![target.clone()]).await.unwrap()[0].clone();
        assert_ne!(
            survivor.record.name, "Must Not Land",
            "the malformed CAS attempt renamed nothing"
        );
    }

    // A VALID integer revision is still honored: matching the current
    // record revision succeeds...
    let (status, body) = {
        let sessions = sessions_router(&home, &names);
        patch(
            sessions,
            uri,
            json!({
                "titleOverride": "CAS Name",
                "ifRevision": bound.record.revision,
            }),
        )
        .await
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    let record = names.get(vec![target]).await.unwrap()[0].clone();
    assert_eq!(record.record.name, "CAS Name");

    // ...and a mismatched one still yields the conflict, not an overwrite.
    let (status, body) = {
        let sessions = sessions_router(&home, &names);
        patch(
            sessions,
            uri,
            json!({ "titleOverride": "Stale Editor", "ifRevision": 1u64 }),
        )
        .await
    };
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a stale valid revision still answers the CAS conflict: {body}"
    );
    let survivor = names
        .get(vec![SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-cas-1".into(),
        }])
        .await
        .unwrap()[0]
        .clone();
    assert_eq!(survivor.record.name, "CAS Name");
    std::fs::remove_dir_all(&home).ok();
}

/// A request that OMITS the title field still updates unrelated fields
/// through the legacy session route (archive), and a scoped title rename
/// never writes a competing settings override.
#[tokio::test]
async fn session_route_omitted_title_still_updates_unrelated_fields() {
    let home = temp_home();
    let state = names_state(&home);
    let names = state.names.clone();
    admit_pending(&names, "handle-u", NamedProvider::Opencode, Some("/w")).await;
    bind_verified(
        &names,
        "handle-u",
        NamedProvider::Opencode,
        "ses_unrelated_0000000000000001",
    )
    .await;

    // Archived-only patch (no titleOverride key): unchanged legacy behavior.
    let (status, body) = {
        let sessions = sessions_router(&home, &names);
        patch(
            sessions,
            "/api/sessions/ses_unrelated_0000000000000001?provider=opencode",
            json!({ "archived": true }),
        )
        .await
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["archived"], json!(true));

    // A scoped rename leaves the session-override store untouched.
    let (status, body) = {
        let sessions = sessions_router(&home, &names);
        patch(
            sessions,
            "/api/sessions/ses_unrelated_0000000000000001?provider=opencode",
            json!({ "titleOverride": "Unified Only" }),
        )
        .await
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    let raw_config =
        std::fs::read_to_string(home.join(".freshell").join("config.json")).unwrap_or_default();
    assert!(
        !raw_config.contains("Unified Only"),
        "no competing settings override may carry the scoped title: {raw_config}"
    );
    std::fs::remove_dir_all(&home).ok();
}

/// The terminal route resolves a scoped terminal's identity (live OR
/// retired) through the shared authority: the rename targets the session
/// record, the legacy terminal-override store stays untouched, and the
/// accepted update returns.
#[tokio::test]
async fn terminal_route_renames_the_scoped_terminal_through_the_authority() {
    let home = temp_home();
    let names = SessionNames::open(home.join(".freshell")).unwrap();

    // The terminal's identity row (provider claude, session bound) — the
    // route's resolver. Bind the record the terminal names through.
    names
        .ensure_pending(PendingNameInput {
            handle: "handle-t".into(),
            provider: NamedProvider::Claude,
            cwd: Some("/w".into()),
        })
        .await
        .unwrap();
    bind_verified(&names, "handle-t", NamedProvider::Claude, "sess-t1").await;

    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    identity.set_session_naming(names.clone());
    identity.upsert("term-1", Some("claude"), Some("sess-t1"), Some("/w"), 1_000);
    identity.set_name_binding(
        "term-1",
        Some(SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-t1".into(),
        }),
        None,
    );
    let terminals = crate::terminals::router(crate::terminals::TerminalsState {
        auth_token: Arc::new("tok".to_string()),
        settings: crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]),
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: Arc::new(tx),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        identity,
    });

    let (status, body) = patch(
        terminals,
        "/api/terminals/term-1",
        json!({ "titleOverride": "Terminal Route Renamed", "nameIntent": "user" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let update: SessionNameUpdate = serde_json::from_value(body["sessionName"].clone())
        .unwrap_or_else(|_| panic!("terminal route carries the update: {body}"));
    assert_eq!(update.record.name, "Terminal Route Renamed");
    assert_eq!(update.record.source, NameSource::Manual);

    // The retired-identity twin: the SAME rename works after the terminal
    // exits (the identity row survives retirement).
    let (tx2, _rx2) = tokio::sync::broadcast::channel::<String>(16);
    let identity2 = freshell_ws::identity::TerminalIdentityRegistry::new();
    identity2.set_session_naming(names.clone());
    identity2.upsert("term-2", Some("claude"), Some("sess-t2"), Some("/w"), 1_000);
    identity2.retire("term-2");
    identity2.set_name_binding(
        "term-2",
        Some(SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-t2".into(),
        }),
        None,
    );
    names
        .ensure_pending(PendingNameInput {
            handle: "handle-t2".into(),
            provider: NamedProvider::Claude,
            cwd: None,
        })
        .await
        .unwrap();
    bind_verified(&names, "handle-t2", NamedProvider::Claude, "sess-t2").await;
    let terminals2 = crate::terminals::router(crate::terminals::TerminalsState {
        auth_token: Arc::new("tok".to_string()),
        settings: crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]),
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: Arc::new(tx2),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        identity: identity2,
    });
    let (status, body) = patch(
        terminals2,
        "/api/terminals/term-2",
        json!({ "titleOverride": "Post Exit", "nameIntent": "user" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let update: SessionNameUpdate = serde_json::from_value(body["sessionName"].clone()).unwrap();
    assert_eq!(update.record.name, "Post Exit");

    // Neither rename wrote a legacy terminal override.
    let raw_config =
        std::fs::read_to_string(home.join(".freshell").join("config.json")).unwrap_or_default();
    assert!(
        !raw_config.contains("Terminal Route Renamed") && !raw_config.contains("Post Exit"),
        "no competing terminal override may carry the scoped title: {raw_config}"
    );
    std::fs::remove_dir_all(&home).ok();
}

/// Two ACTUAL store participants on one home with idle subscribers: the
/// rename through participant A reaches participant B's subscriber through
/// B's own unconditional refresh (adoption of A's committed generation) —
/// no index activity, no history polling — and a DELAYED stale snapshot
/// from A cannot revert the newer state.
#[tokio::test]
async fn two_store_participants_converge_through_unconditional_refresh() {
    let home = temp_home();
    let a = SessionNames::open(home.join(".freshell")).unwrap();
    let b = SessionNames::open(home.join(".freshell")).unwrap();
    let mut sub_b = b.subscribe();

    admit_pending(&a, "handle-2p", NamedProvider::Claude, Some("/w")).await;
    a.rename(RenameNameInput {
        target: SessionNameRef::Pending {
            id: "handle-2p".into(),
        },
        name: "Renamed By A".into(),
        intent: NameIntent::User,
        if_revision: None,
    })
    .await
    .unwrap();

    // B's unconditional refresh adopts A's generation and publishes the
    // renamed record to ITS subscribers (the tick's adoption path).
    let adopted = b.refresh_current().await.expect("B refreshes");
    adopted
        .iter()
        .find(|update| update.record.name == "Renamed By A")
        .expect("B adopted A's rename");
    let received = sub_b
        .try_recv()
        .expect("B's idle subscriber received the renamed record through the refresh");
    assert_eq!(received.record.name, "Renamed By A");

    // A DELAYED stale snapshot from A cannot revert B's newer state: B
    // re-refreshes (nothing changed on disk) and still answers the renamed
    // record, monotonic revision.
    let re_adopted = b.refresh_current().await.expect("B re-refreshes");
    let still = re_adopted
        .iter()
        .find(|update| update.record.name == "Renamed By A")
        .expect("the renamed record is still current");
    assert!(still.record.revision >= received.record.revision);
    std::fs::remove_dir_all(&home).ok();
}

/// Round-2 carried finding F5 (adjudicated): a foreign STATUS-ONLY nativeSync
/// transition (a cooperating same-home process's worker folds an unsynced
/// outcome — the record's name/revision/source do not move) must reach the
/// ADOPTING process's subscribers too: cross-process adoption used to
/// publish only revision/source-changed records, so the status change was
/// invisible to this process's WS clients until a bootstrap or later
/// change. The client folds status-only updates by documentGeneration, so
/// the adopted frame carries `changed:false` with the new projection.
#[tokio::test]
async fn a_foreign_status_only_native_sync_transition_republishes_on_adoption() {
    let home = temp_home();
    let a = SessionNames::open(home.join(".freshell")).unwrap();
    let b = SessionNames::open(home.join(".freshell")).unwrap();
    let mut sub_b = b.subscribe();
    let target = SessionNameRef::Pending {
        id: "handle-status".into(),
    };

    // A arms a manual series with a verified route.
    admit_pending(&a, "handle-status", NamedProvider::Claude, Some("/w")).await;
    a.rename(RenameNameInput {
        target: target.clone(),
        name: "Manually Named".into(),
        intent: NameIntent::User,
        if_revision: None,
    })
    .await
    .unwrap();
    a.record_acquisition(
        target.clone(),
        NativeAcquisition {
            location: NativeLocation::Claude {
                config_root: "/w/homes/status".into(),
                transcript_path: Some("/w/homes/status/projects/x/see.jsonl".into()),
                project_directory_key: None,
                transcript_cwd: None,
                effective_project_key_override: None,
            },
            evidence: NativeEvidenceKind::IndexedFile,
            persistence: NativePersistence::Verified,
        },
    )
    .await
    .unwrap();

    // B adopts A's committed rename (drain that frame).
    b.refresh_current().await.expect("B adopts the rename");
    let _ = sub_b.try_recv();

    // A's worker folds a status-only outcome: the record itself is unchanged
    // (same name, same revision, same source) — only the native series moved.
    let revision_before = a
        .get(vec![target.clone()])
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap()
        .record
        .revision;
    let claim = a
        .claim_native_cycle(target.clone(), "status-cycle-1".to_string())
        .await
        .unwrap()
        .expect("A's series claims its first cycle");
    a.fold_native_outcome(
        target.clone(),
        claim.location_revision,
        claim.series_epoch,
        crate::session_name_native::NativeOutcomeFold::Undelivered {
            reason: "connect refusal".to_string(),
        },
    )
    .await
    .unwrap();
    let after = a
        .get(vec![target.clone()])
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(after.record.revision, revision_before, "status-only fold");
    assert_eq!(after.record.name, "Manually Named");

    // B's refresh adopts A's committed status-only generation: B's idle
    // subscriber must receive the frame (changed:false, unsynced reason).
    b.refresh_current()
        .await
        .expect("B adopts the status-only change");
    let received = sub_b
        .try_recv()
        .expect("the adopted status-only transition republishes to B's subscriber");
    assert_eq!(received.record.name, "Manually Named");
    assert!(
        !received.changed,
        "a status-only frame never claims a rename"
    );
    assert_eq!(
        received.native_sync.as_ref().expect("projection").status,
        freshell_protocol::session_names::NativeSyncStatus::Unsynced,
        "the folded status reached B's subscriber"
    );
    assert_eq!(
        received.native_sync.as_ref().unwrap().reason.as_deref(),
        Some("connect refusal")
    );
    std::fs::remove_dir_all(&home).ok();
}

/// The read route chunks: more than 100 refs is a visible 400 (the client
/// batches), and unknown refs are omitted rather than erroring.
#[tokio::test]
async fn read_route_chunks_and_omits_unknown_refs() {
    let home = temp_home();
    let state = names_state(&home);
    admit_pending(&state.names, "handle-ch", NamedProvider::Claude, Some("/w")).await;
    let mut refs = vec![json!({ "kind": "pending", "id": "handle-ch" })];
    for i in 0..100 {
        refs.push(json!({ "kind": "pending", "id": format!("unknown-{i}") }));
    }
    let (status, body) = {
        let canonical = super::router(state.clone());
        post_read(canonical, Value::Array(refs.clone())).await
    };
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = {
        let canonical = super::router(state.clone());
        post_read(
            canonical,
            json!([
                { "kind": "pending", "id": "handle-ch" },
                { "kind": "pending", "id": "unknown-x" }
            ]),
        )
        .await
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["names"].as_array().unwrap().len(),
        1,
        "unknown refs are omitted"
    );
    std::fs::remove_dir_all(&home).ok();
}

/// A session whose identity was verified under one native location and is
/// then verified under a NEW location (same provider/session — a supported
/// relocation) RETAINS its name; a non-target session's record is untouched.
#[tokio::test]
async fn verified_relocation_retains_the_name_and_leaves_non_targets_untouched() {
    let home = temp_home();
    let names = SessionNames::open(home.join(".freshell")).unwrap();
    admit_pending(&names, "handle-loc", NamedProvider::Codex, Some("/w")).await;
    bind_verified(&names, "handle-loc", NamedProvider::Codex, "thread-loc").await;
    names
        .rename(RenameNameInput {
            target: SessionNameRef::Session {
                provider: NamedProvider::Codex,
                session_id: "thread-loc".into(),
            },
            name: "Kept Through Move".into(),
            intent: NameIntent::User,
            if_revision: None,
        })
        .await
        .unwrap();
    // A non-target record for the contrast.
    admit_pending(&names, "handle-other", NamedProvider::Codex, Some("/other")).await;
    bind_verified(&names, "handle-other", NamedProvider::Codex, "thread-other").await;

    // The same session verified under a NEW location (relocated home).
    names
        .record_acquisition(
            SessionNameRef::Session {
                provider: NamedProvider::Codex,
                session_id: "thread-loc".into(),
            },
            NativeAcquisition {
                location: NativeLocation::Codex {
                    codex_home: "/moved/.codex".into(),
                    native_thread_id: Some("thread-loc".into()),
                    rollout_path: Some("/moved/.codex/sessions/thread-loc.jsonl".into()),
                    persistence_evidence: None,
                },
                evidence: NativeEvidenceKind::PersistedMetadata,
                persistence: NativePersistence::Verified,
            },
        )
        .await
        .expect("relocation recorded");

    let moved = names
        .get(vec![
            SessionNameRef::Session {
                provider: NamedProvider::Codex,
                session_id: "thread-loc".into(),
            },
            SessionNameRef::Session {
                provider: NamedProvider::Codex,
                session_id: "thread-other".into(),
            },
        ])
        .await
        .unwrap();
    let relocated = moved
        .iter()
        .find(|u| {
            matches!(
                u.record.name_ref,
                SessionNameRef::Session { ref session_id, .. } if session_id == "thread-loc"
            )
        })
        .unwrap();
    assert_eq!(relocated.record.name, "Kept Through Move");
    let other = moved
        .iter()
        .find(|u| {
            matches!(
                u.record.name_ref,
                SessionNameRef::Session { ref session_id, .. } if session_id == "thread-other"
            )
        })
        .unwrap();
    assert_eq!(
        other.record.name, "other",
        "the non-target copy is untouched"
    );
    std::fs::remove_dir_all(&home).ok();
}

// ── Task 7: the legacy-name import endpoint ─────────────────────────────────

async fn post_import(router: Router, body: Value) -> (StatusCode, Value) {
    let resp = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session-names/import")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

#[tokio::test]
async fn import_endpoint_acknowledges_per_candidate_and_resolves_terminals() {
    let home = temp_home();
    let state = names_state(&home);
    let router = super::router(state.clone());
    // Seed a live scoped terminal identity so its legacy_terminal target
    // resolves through the ledger.
    state
        .identity
        .upsert("t-1", Some("claude"), Some("sess-1"), None, 1);

    let body = json!({
        "version": 1,
        "importId": "browser-import-1",
        "evidence": [
            { "storageKey": "freshell.layout.v3.w1", "raw": "{\"version\":4}" }
        ],
        "candidates": [
            {
                "id": "c-1",
                "target": { "kind": "legacy_terminal", "terminalId": "t-1", "serverInstanceId": "srv" },
                "name": "Resolved Terminal Label",
                "source": "legacy_protected",
                "scope": "terminal",
                "evidenceKey": "envelope#t-1",
                "protectionEvidence": "legacy_flag"
            },
            {
                "id": "c-2",
                "target": { "kind": "legacy_terminal", "terminalId": "t-gone", "serverInstanceId": "srv" },
                "name": "Ghost Terminal",
                "source": "legacy_protected",
                "scope": "terminal",
                "evidenceKey": "envelope#t-gone",
                "protectionEvidence": "legacy_flag"
            },
            {
                "id": "c-3",
                "target": { "kind": "session", "provider": "claude", "sessionId": "sess-2" },
                "name": "Claimed Human Rename",
                "source": "manual",
                "scope": "session",
                "evidenceKey": "envelope#sess-2",
                "protectionEvidence": "explicit_rename"
            },
        ],
    });
    let (status, body) = post_import(router, body).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Per-candidate acknowledgment — all three, including the unresolved
    // terminal (recovery-only) and the downgraded explicit claim.
    assert_eq!(body["acknowledged"], json!(["c-1", "c-2", "c-3"]), "{body}");
    // The resolved terminal's candidate installed as legacy-protected.
    let sess1 = body["names"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["record"]["ref"]["sessionId"] == json!("sess-1"))
        .unwrap();
    assert_eq!(sess1["record"]["name"], json!("Resolved Terminal Label"));
    assert_eq!(sess1["record"]["source"], json!("legacy_protected"));
    assert_eq!(sess1["record"]["legacyOrigin"], json!("unknown"));
    // The HTTP lane never honors an explicit-rename claim: the candidate is
    // downgraded to legacy-protected with unknown origin.
    let sess2 = body["names"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["record"]["ref"]["sessionId"] == json!("sess-2"))
        .unwrap();
    assert_eq!(sess2["record"]["source"], json!("legacy_protected"));
    assert_eq!(sess2["record"]["legacyOrigin"], json!("unknown"));
    assert!(sess2["record"].get("renamedAt").is_none());
    assert!(sess2["record"].get("manualRevision").is_none());
    // The immutable per-import backup landed before the acknowledgment.
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(b"browser-import-1");
        format!("{:x}", hasher.finalize())
    };
    let backup = home
        .join(".freshell")
        .join("name-migration-v1")
        .join("imports")
        .join(format!("{digest}.json"));
    assert!(backup.exists(), "the per-import backup precedes the ack");

    // The reserved boot import id is refused from the HTTP lane.
    let state2 = names_state(&home);
    let router2 = super::router(state2);
    let (status, body) = post_import(
        router2,
        json!({ "version": 1, "importId": "server-boot-v1", "evidence": [], "candidates": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["details"],
        json!("the server-boot import id is reserved")
    );

    // The whole reserved FAMILY is refused: a chunked boot derivation
    // (`server-boot-v1--0`) can never reach the store from the untrusted
    // lane either (only the in-process boot runner sends those).
    let state2b = names_state(&home);
    let router2b = super::router(state2b);
    let (status, body) = post_import(
        router2b,
        json!({ "version": 1, "importId": "server-boot-v1--0", "evidence": [], "candidates": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["details"],
        json!("the server-boot import id is reserved")
    );

    // An oversized envelope is refused.
    let state3 = names_state(&home);
    let router3 = super::router(state3);
    let mut oversized = Vec::new();
    for index in 0..101 {
        oversized.push(json!({
            "id": format!("o-{index}"),
            "target": { "kind": "session", "provider": "claude", "sessionId": format!("s{index}") },
            "name": "L",
            "source": "provider_ai",
            "scope": "pane",
            "evidenceKey": format!("e#{index}"),
            "protectionEvidence": "none"
        }));
    }
    let (status, body) = post_import(
        router3,
        json!({ "version": 1, "importId": "big", "evidence": [], "candidates": oversized }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    std::fs::remove_dir_all(&home).ok();
}

#[tokio::test]
async fn import_endpoint_requires_auth() {
    let home = temp_home();
    let state = names_state(&home);
    let router = super::router(state);
    let resp = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session-names/import")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "version": 1, "importId": "x", "evidence": [], "candidates": [] })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    std::fs::remove_dir_all(&home).ok();
}
