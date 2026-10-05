use axum::body::Body;
use axum::http::{Request, StatusCode};
use freshell_freshagent::naming::SessionNaming;
use tower::ServiceExt;

fn state(dir: &std::path::Path) -> super::SessionsState {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    super::SessionsState {
        auth_token: std::sync::Arc::new("tok".into()),
        settings: crate::settings_store::SettingsStore::load(Some(dir), vec!["claude".into()]),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: std::sync::Arc::new(tx),
        terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
        name_auth: crate::ai_title::GeminiSessionNameAuth::direct_for_test(
            crate::ai_title::AiKeyCell::init(None, None),
        ),
        // AI disabled by default; tests that exercise the AI branch
        // overwrite these fields (the no-key path never touches gemini).
        gemini: std::sync::Arc::new(FakeGemini(Err("unused in default test state".into()))),
        metadata: crate::session_metadata::SessionMetadataStore::new(dir.join(".freshell")),
        index: None,
        generation_wake: None,
    }
}

async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn patch_rename_persists_and_returns_merged_plus_cascade_null() {
    // Unified agent names (Task 2): the settings-override merge/cascade path
    // now applies to EXCLUDED providers only — a scoped provider's title
    // rename routes to the naming authority (see
    // `session_name_routes_tests`). This pin keeps the excluded-provider
    // behavior: provider=gemini.
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"titleOverride":"My Title"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["titleOverride"], serde_json::json!("My Title"));
    assert_eq!(v["titleSource"], serde_json::json!("user"));
    assert_eq!(v["cascadedTerminalId"], serde_json::Value::Null);
    std::fs::remove_dir_all(&dir).ok();
}

/// b5fb: clearing a title (`{"titleOverride": null}`) removes BOTH the override
/// and its source. A leftover titleSource:"user" would permanently finalize the
/// row at rank 5, blocking every automatic title update forever after.
/// Unified agent names (Task 2): the clear path applies to EXCLUDED providers
/// only (a scoped provider's null/reset is refused — see
/// `session_name_routes_tests`), so this pin uses provider=gemini.
#[tokio::test]
async fn patch_clear_title_removes_override_and_source() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);
    let app = super::router(st.clone());

    // 1) Explicit user rename lands with the 'user' rung.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"titleOverride":"Intentional rename"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let v = body_json(resp).await;
    assert_eq!(v["titleSource"], serde_json::json!("user"));

    // 2) Clear: the response and the stored row lose BOTH keys.
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"titleOverride":null}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert!(
        v.get("titleOverride").map(|x| x.is_null()).unwrap_or(true),
        "titleOverride cleared from response: {v}"
    );
    assert!(
        v.get("titleSource").map(|x| x.is_null()).unwrap_or(true),
        "titleSource cleared from response: {v}"
    );

    let overrides = st.settings.session_overrides();
    let row = overrides.get("gemini:abc123").cloned().unwrap_or_default();
    assert!(row.get("titleOverride").is_none(), "stored row: {row}");
    assert!(row.get("titleSource").is_none(), "stored row: {row}");

    // 3) The ladder is unblocked: a first-message sourced write lands again.
    st.settings
        .patch_session_override(
            "gemini:abc123",
            &[
                (
                    "titleOverride",
                    Some(serde_json::json!("First message name")),
                ),
                ("titleSource", Some(serde_json::json!("first-message"))),
            ],
        )
        .await;
    let row = st
        .settings
        .session_overrides()
        .get("gemini:abc123")
        .cloned()
        .unwrap();
    assert_eq!(row["titleSource"], serde_json::json!("first-message"));
    std::fs::remove_dir_all(&dir).ok();
}

/// Registers a REAL (but throwaway, immediately killable) terminal in the
/// shared `TerminalRegistry` so the reverse cascade's registry
/// write-through (`registry.update_title`) has an actual entry to mutate.
/// `TerminalRegistry::insert_headless` (used by `freshell-terminal`'s own
/// unit tests to avoid a real spawn) is private to that crate's test
/// module, so this port spawns a minimal `sleep` child instead -- the
/// caller is responsible for `registry.kill(terminal_id)` afterward.
fn spawn_headless_terminal_for_test(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) {
    use freshell_platform::spawn::{SpawnSpec, DEFAULT_COLS, DEFAULT_ROWS};
    let spec = SpawnSpec {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), "sleep 5".into()],
        env_overrides: Default::default(),
        cwd: None,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
    };
    registry
        .create(
            &spec,
            &std::collections::BTreeMap::new(),
            terminal_id.to_string(),
            "stream-test".to_string(),
            "shell",
            None,
            None,
            None,
            None,
        )
        .expect("spawn headless test terminal");
}

/// Reviewer finding (Important, commit d5cf534a): the REVERSE rename
/// cascade (`cascadeSessionRenameToTerminal`, `rename-cascade.ts:39-50`,
/// implemented in `patch_session` above) had ZERO positive-match test
/// coverage -- reverting the entire cascade block still left all prior
/// tests green, since they only covered the no-match case. This proves
/// all FOUR effects a live match must produce: (a) the terminal's OWN
/// override is written with the new title, (b) the in-memory registry
/// title is updated (write-through, not just the on-disk override), (c) a
/// `terminals.changed` broadcast fires, and (d) the response echoes the
/// REAL `cascadedTerminalId` (not the always-null placeholder a prior
/// version of this router emitted).
#[tokio::test]
async fn patch_rename_cascades_all_four_effects_to_a_live_terminal() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);

    // A terminal currently running `gemini:sess-live` (the session key
    // this PATCH targets) -- `find_by_session` needs a LIVE (non-retired)
    // match, and the registry write-through needs a REAL registered
    // terminal_id (`update_title` is a no-op against an unknown id).
    // Unified agent names (Task 2): gemini is an EXCLUDED provider — the
    // reverse cascade is the settings-override flow's own reach-back and
    // stays with it (scoped providers rename through the naming authority,
    // which the publisher reflects without a cascade).
    st.identity
        .upsert("term-live", Some("gemini"), Some("sess-live"), None, 1000);
    spawn_headless_terminal_for_test(&st.registry, "term-live");

    // Subscribe BEFORE the PATCH so the `terminals.changed` send lands in
    // this receiver's buffer.
    let mut broadcast_rx = st.broadcast_tx.subscribe();

    let app = super::router(st.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/sess-live?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"titleOverride":"Renamed From Session"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;

    // (d) the REAL cascadedTerminalId, not null.
    assert_eq!(
        v["cascadedTerminalId"],
        serde_json::json!("term-live"),
        "response must echo the live terminal's id, not null"
    );

    // (a) the terminal's OWN override was written with the new title.
    let terminal_overrides = st.settings.terminal_overrides();
    let term_override = terminal_overrides
        .get("term-live")
        .expect("terminal override written by the reverse cascade");
    assert_eq!(
        term_override["titleOverride"],
        serde_json::json!("Renamed From Session")
    );

    // (b) the in-memory registry title was updated (write-through, not
    // just the on-disk override).
    let entry = st
        .registry
        .directory()
        .into_iter()
        .find(|e| e.terminal_id == "term-live")
        .expect("terminal present in the registry directory");
    assert_eq!(entry.title, "Renamed From Session");

    // (c) a `terminals.changed` broadcast fired.
    let frame = broadcast_rx
        .try_recv()
        .expect("terminals.changed broadcast fired");
    let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(frame["type"], serde_json::json!("terminals.changed"));

    st.registry.kill("term-live");
    std::fs::remove_dir_all(&dir).ok();
}

/// The reverse cascade's terminal lookup is LIVE-only (`.list()` via
/// `find_by_session`, matching `deps.terminalMetadata.list()`,
/// `sessions-router.ts:149`): a RETIRED (already-exited) terminal's
/// session can still be renamed through this route, but the rename does
/// NOT reach back into the exited terminal -- `cascadedTerminalId` stays
/// `null`. The OPPOSITE (terminal -> session) direction no longer exists at
/// all: b5fb removed that cascade outright (a terminal rename never writes a
/// session override -- see `title_scope_tests` in `terminals.rs`), so this
/// live-only session -> terminal reach-back is the only rename cascade left.
/// Unified agent names (Task 2): gemini is an EXCLUDED provider — the
/// cascade behavior belongs to the settings-override flow it observes.
#[tokio::test]
async fn patch_rename_to_a_retired_terminal_identity_does_not_cascade() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);

    st.identity.upsert(
        "term-exited",
        Some("gemini"),
        Some("sess-exited"),
        None,
        1000,
    );
    st.identity.retire("term-exited");

    let app = super::router(st.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/sess-exited?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"titleOverride":"Renamed After Exit"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;

    assert_eq!(v["cascadedTerminalId"], serde_json::Value::Null);
    assert_eq!(
        v["titleOverride"],
        serde_json::json!("Renamed After Exit"),
        "the session override itself still lands -- only the reach-back to the terminal is skipped"
    );
    assert!(
        st.settings.terminal_overrides().is_empty(),
        "no terminal override should be fabricated for a retired terminal"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// GAP-1 fix (reviewer Important, SESSION-09 follow-up): the periodic
/// session-directory sweep (`spawn_sessions_sweep`, `main.rs`) is
/// structurally blind to override-only changes -- its `(count, max
/// lastActivityAt)` signature never moves for a title-override write,
/// since `IndexedSession` carries no override fields at all. Legacy
/// broadcasts `sessions.changed` on ANY sidebar-visible change (its
/// differ, `projection.ts:23`, diffs the full comparable snapshot
/// including `title`), so THIS write site must broadcast directly.
/// Proves a rename PATCH produces exactly one `sessions.changed` frame
/// with a positive, monotonic revision.
/// Unified agent names (Task 2): gemini is an EXCLUDED provider — this
/// direct-broadcast behavior belongs to the settings-override write
/// (a scoped provider's rename reaches clients through the naming
/// publisher instead).
#[tokio::test]
async fn patch_rename_broadcasts_sessions_changed_with_increased_revision() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);

    // Subscribe BEFORE the PATCH so the `sessions.changed` send lands in
    // this receiver's buffer.
    let mut broadcast_rx = st.broadcast_tx.subscribe();

    let app = super::router(st.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"titleOverride":"Renamed Session"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let frame = broadcast_rx
        .try_recv()
        .expect("sessions.changed broadcast fired for the rename override write");
    let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(frame["type"], serde_json::json!("sessions.changed"));
    let revision = frame["revision"].as_i64().expect("revision is a number");
    assert!(revision > 0, "revision must be a positive counter value");

    // Exactly one frame -- no duplicate/extra broadcast for a plain
    // rename (no live-terminal cascade in play here).
    assert!(
        broadcast_rx.try_recv().is_err(),
        "exactly one broadcast frame expected for a plain rename PATCH"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// Companion to the rename case above: an archive toggle is exactly the
/// kind of sidebar-visible, sweep-invisible change GAP-1 covers (the
/// reviewer's own example). Also proves the revision counter is shared
/// across successive PATCHes (strictly increasing, not reset per call).
#[tokio::test]
async fn patch_archive_broadcasts_sessions_changed_and_revision_is_monotonic() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);
    let mut broadcast_rx = st.broadcast_tx.subscribe();

    let app = super::router(st.clone());
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=claude")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"archived":true}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let first_frame = broadcast_rx
        .try_recv()
        .expect("sessions.changed broadcast fired for the archive override write");
    let first_frame: serde_json::Value = serde_json::from_str(&first_frame).unwrap();
    let first_revision = first_frame["revision"].as_i64().unwrap();

    // A second override write on the SAME state must bump the counter
    // further (shared, monotonic sequence -- not reset per request).
    let resp2 = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=claude")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"archived":false}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);
    let second_frame = broadcast_rx
        .try_recv()
        .expect("sessions.changed broadcast fired for the second override write");
    let second_frame: serde_json::Value = serde_json::from_str(&second_frame).unwrap();
    let second_revision = second_frame["revision"].as_i64().unwrap();

    assert!(
        second_revision > first_revision,
        "revision must strictly increase across successive override writes"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn patch_requires_auth() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn patch_url_encoded_composite_key_is_decoded() {
    // A raw id already containing ':' (url-encoded %3A) is used verbatim.
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/codex%3Axyz")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"archived":true}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let cfg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        cfg["sessionOverrides"]["codex:xyz"]["archived"],
        serde_json::json!(true)
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn generate_title_blank_first_message_is_400() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions/abc/generate-title")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"firstMessage":"   "}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let v = body_json(resp).await;
    assert_eq!(v["error"], serde_json::json!("firstMessage is required"));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn generate_title_no_key_uses_first_message_heuristic() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions/abc/generate-title?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"firstMessage":"Fix the login bug\nmore detail"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["title"], serde_json::json!("Fix the login bug")); // first non-empty line
    assert_eq!(v["source"], serde_json::json!("first-message"));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn generate_title_after_user_rename_is_ladder_blocked() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);
    // Pre-seed a user rename (rank 5).
    st.settings
        .patch_session_override(
            "gemini:abc",
            &[
                ("titleOverride", Some(serde_json::json!("User Named"))),
                ("titleSource", Some(serde_json::json!("user"))),
            ],
        )
        .await;
    let app = super::router(st);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions/abc/generate-title?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"firstMessage":"Some prompt"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    // first-message (3) cannot upgrade user (5): store keeps the user title; the
    // response reflects the STORED (merged) value, faithfully (sessions-router.ts:185-190).
    assert_eq!(v["title"], serde_json::json!("User Named"));
    assert_eq!(v["source"], serde_json::json!("user"));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn generate_title_multiline_takes_first_nonempty_line_truncated() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let long_line = "a".repeat(80);
    let first_message = format!("\n   \n{long_line}\nsecond line");
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions/abc/generate-title?provider=gemini")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "firstMessage": first_message }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["title"], serde_json::json!("a".repeat(50)));
    assert_eq!(v["source"], serde_json::json!("first-message"));
    std::fs::remove_dir_all(&dir).ok();
}

/// End-to-end sanity: a PATCH through THIS router persists a
/// `sessionOverride` that `session_directory`'s overlay (Task 2) then
/// surfaces on the matching item — the same `SettingsStore` backs both.
/// Unified agent names (Task 2): the claude title is now a NAMING record
/// (created through the create-lane admission — modeled here by a direct
/// store admit+bind), so the overlay assertion covers the non-title
/// (`archived`) settings surface while the title rides the naming
/// projection (`title` + additive `sessionName`/`nameRef`).
#[tokio::test]
async fn patch_override_is_visible_through_session_directory_overlay() {
    use axum::http::Request as HttpRequest;
    use freshell_freshagent::naming::{BindNameInput, PendingNameInput, SessionNaming};
    use freshell_protocol::native_location::{
        NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
    };
    use freshell_protocol::session_names::{NamedProvider, SessionNameRef};

    let home = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    let project = home.join(".claude").join("projects").join("-tmp-proj");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    // Inline transcript (not the committed `healthy.jsonl` fixture, which
    // deliberately has no `cwd` and is excluded at discovery, R10b): a
    // `cwd`-bearing, two-user-message session so it survives both the
    // discovery `cwd` requirement and the default `isNonInteractive` filter.
    let content = [
        r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"user","message":{"role":"user","content":"first prompt"},"timestamp":"2025-01-30T10:00:00.000Z"}"#,
        r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"assistant","message":{"role":"assistant","content":"ack"},"timestamp":"2025-01-30T10:00:01.000Z"}"#,
        r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"user","message":{"role":"user","content":"second prompt"},"timestamp":"2025-01-30T10:00:02.000Z"}"#,
    ]
    .join("\n");
    std::fs::write(project.join("healthy-session-id.jsonl"), content).unwrap();

    let settings = crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
    let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());

    // The ONE naming authority, shared by both routers below (the identity
    // registries carry the sink) — and the session's durable record,
    // admitted + bound the way the create lane does.
    let names = crate::session_names::SessionNames::open(home.join(".freshell")).unwrap();
    names
        .ensure_pending(PendingNameInput {
            handle: "handle-overlay".into(),
            provider: NamedProvider::Claude,
            cwd: Some("/tmp/proj".into()),
        })
        .await
        .unwrap();
    names
        .bind_pending(BindNameInput {
            pending: SessionNameRef::Pending {
                id: "handle-overlay".into(),
            },
            target: SessionNameRef::Session {
                provider: NamedProvider::Claude,
                session_id: "healthy-session-id".into(),
            },
            acquisition: NativeAcquisition {
                location: NativeLocation::Claude {
                    config_root: home.join(".claude").to_string_lossy().into_owned(),
                    transcript_path: Some(
                        project
                            .join("healthy-session-id.jsonl")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    project_directory_key: None,
                    transcript_cwd: Some("/tmp/proj".into()),
                    effective_project_key_override: None,
                },
                evidence: NativeEvidenceKind::SelectedTranscript,
                persistence: NativePersistence::Verified,
            },
        })
        .await
        .unwrap();

    // Patch title + archived through the sessions router (the title routes
    // to the naming authority; archived patches the settings store).
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let sessions_identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    sessions_identity.set_session_naming(names.clone());
    let sessions_app = super::router(super::SessionsState {
        auth_token: std::sync::Arc::clone(&auth_token),
        settings: settings.clone(),
        identity: sessions_identity,
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: std::sync::Arc::new(tx),
        terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
        name_auth: crate::ai_title::GeminiSessionNameAuth::direct_for_test(
            crate::ai_title::AiKeyCell::init(None, None),
        ),
        gemini: std::sync::Arc::new(FakeGemini(Err("unused in default test state".into()))),
        metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
        index: None,
        generation_wake: None,
    });
    let patch_resp = sessions_app
        .oneshot(
            HttpRequest::builder()
                .method("PATCH")
                .uri("/api/sessions/healthy-session-id?provider=claude")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"titleOverride":"Overlay Title","archived":true,"nameIntent":"user"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(patch_resp.status(), StatusCode::OK);
    let patch_body = body_json(patch_resp).await;
    // The scoped title rename answers the accepted naming record — no
    // settings title override was written, and `archived` (a non-title
    // field in the SAME request) still patched the settings store.
    assert_eq!(
        patch_body["sessionName"]["record"]["name"],
        serde_json::json!("Overlay Title"),
        "the session route carries the accepted naming update: {patch_body}"
    );
    assert_eq!(patch_body["archived"], serde_json::json!(true));

    // Query the session-directory read model with the SAME settings store.
    // Batch B: the read model is backed by a `SessionIndex` now, not a
    // per-request `home: Option<PathBuf>` scan.
    let session_index = std::sync::Arc::new(
        freshell_sessions::directory_index::SessionIndex::with_ttl_and_cache_path(
            vec![
                std::sync::Arc::new(freshell_sessions::directory_index::ClaudeSource::new(
                    // Pin the temp home's claude root DIRECTLY, never through
                    // `claude_home(&home)` (which lets the process-global
                    // CLAUDE_HOME env var win over the explicit home — the
                    // production override parity). Parallel test modules
                    // mutate CLAUDE_HOME process-globally while holding
                    // their OWN lock, so a test that does not take that
                    // lock can resolve a FOREIGN temp home at construction
                    // and scan the wrong root forever (the observed
                    // full-parallelism flake; green solo and at 4 threads).
                    home.join(".claude"),
                ))
                    as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
            ],
            std::time::Duration::from_millis(1_000),
            None,
        ),
    );
    let dir_identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    dir_identity.set_session_naming(names.clone());
    let dir_app =
        crate::session_directory::router(crate::session_directory::SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: dir_identity,
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
            collision_signatures: Default::default(),
            legacy_name_migration_completed: false,
        });
    let dir_resp = dir_app
        .oneshot(
            HttpRequest::builder()
                .method("GET")
                .uri("/api/session-directory?priority=visible")
                .header("x-auth-token", "tok")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(dir_resp.status(), StatusCode::OK);
    let page = body_json(dir_resp).await;
    let items = page["items"].as_array().unwrap();
    let item = items
        .iter()
        .find(|i| i["sessionId"] == serde_json::json!("healthy-session-id"))
        .expect("patched session present in directory");
    // The durable manual name wins the displayed title and rides the page
    // additively; the archived settings overlay still applies.
    assert_eq!(item["title"], serde_json::json!("Overlay Title"));
    assert_eq!(item["sessionName"], serde_json::json!("Overlay Title"));
    assert_eq!(
        item["nameRef"],
        serde_json::json!({ "kind": "session", "provider": "claude", "sessionId": "healthy-session-id" }),
        "the item carries the record's identity: {item}"
    );
    assert_eq!(item["archived"], serde_json::json!(true));

    std::fs::remove_dir_all(&home).ok();
}

// ── DELETE /api/sessions/:sessionId (soft delete, sessions-router.ts:243-251) ──

/// Node parity: `router.delete('/sessions/:sessionId')` requires the same
/// token gate as PATCH — an unauthenticated DELETE never reaches the store.
#[tokio::test]
async fn delete_requires_auth() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/sessions/abc123?provider=claude")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    std::fs::remove_dir_all(&dir).ok();
}

/// The core soft-delete write: a single-key `{deleted:true}` override patch
/// (`configStore.deleteSession`) lands on disk under the composite key, the
/// response is exactly `{"ok":true}`, and no provider `.jsonl` is touched.
#[tokio::test]
async fn delete_persists_soft_delete_override_and_returns_ok() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/sessions/del-me?provider=claude")
                .header("x-auth-token", "tok")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v, serde_json::json!({ "ok": true }));
    let cfg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        cfg["sessionOverrides"]["claude:del-me"]["deleted"],
        serde_json::json!(true)
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Node parity: the route NEVER 404s — an unknown id just writes a harmless
/// tombstone override and still answers `{"ok":true}`.
#[tokio::test]
async fn delete_unknown_session_returns_ok_tombstone() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/sessions/no-such-session?provider=claude")
                .header("x-auth-token", "tok")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v, serde_json::json!({ "ok": true }));
    let cfg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        cfg["sessionOverrides"]["claude:no-such-session"]["deleted"],
        serde_json::json!(true)
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Key shaping: axum percent-decodes the path param BEFORE we see it, so an
/// already-composite `codex%3Axyz` passes through verbatim, while a BARE id
/// gets the `?provider=` prefix — same ladder as `composite_key` for PATCH.
#[tokio::test]
async fn delete_decodes_composite_key_and_prefixes_bare_ids() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    for uri in [
        "/api/sessions/codex%3Axyz",
        "/api/sessions/plain-id?provider=codex",
    ] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(uri)
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "DELETE {uri}");
    }
    let cfg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        cfg["sessionOverrides"]["codex:xyz"]["deleted"],
        serde_json::json!(true)
    );
    assert_eq!(
        cfg["sessionOverrides"]["codex:plain-id"]["deleted"],
        serde_json::json!(true)
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// GAP-1 twin of the archive test: a delete is an override-only,
/// sidebar-visible change the directory sweep is blind to, so the route must
/// broadcast `sessions.changed` directly — and successive deletes must bump
/// the SHARED counter (monotonic, not reset per request).
#[tokio::test]
async fn delete_broadcasts_sessions_changed_and_revision_is_monotonic() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);
    let mut broadcast_rx = st.broadcast_tx.subscribe();
    let app = super::router(st.clone());

    for uri in [
        "/api/sessions/abc123?provider=claude",
        "/api/sessions/def456?provider=claude",
    ] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(uri)
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "DELETE {uri}");
    }

    let first_frame = broadcast_rx
        .try_recv()
        .expect("sessions.changed broadcast fired for the first delete");
    let first_frame: serde_json::Value = serde_json::from_str(&first_frame).unwrap();
    assert_eq!(first_frame["type"], serde_json::json!("sessions.changed"));
    let first_revision = first_frame["revision"].as_i64().unwrap();
    let second_frame = broadcast_rx
        .try_recv()
        .expect("sessions.changed broadcast fired for the second delete");
    let second_frame: serde_json::Value = serde_json::from_str(&second_frame).unwrap();
    let second_revision = second_frame["revision"].as_i64().unwrap();
    assert!(
        second_revision > first_revision,
        "revision must strictly increase across successive deletes"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// Round-trip through the READ model: a session visible in the directory
/// disappears after a DELETE through THIS router because the overlay
/// (`apply_session_overrides`, session_directory.rs) filters `deleted:true`
/// rows — and the underlying index/jsonl are untouched.
#[tokio::test]
async fn deleted_session_disappears_from_session_directory_overlay() {
    let home = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    let project = home.join(".claude").join("projects").join("-tmp-proj");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    // Same discovery-safe shape as the overlay donor above: `cwd`-bearing,
    // two user messages (survives the default `isNonInteractive` filter).
    let content = [
        r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"user","message":{"role":"user","content":"first prompt"},"timestamp":"2025-01-30T10:00:00.000Z"}"#,
        r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"assistant","message":{"role":"assistant","content":"ack"},"timestamp":"2025-01-30T10:00:01.000Z"}"#,
        r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"user","message":{"role":"user","content":"second prompt"},"timestamp":"2025-01-30T10:00:02.000Z"}"#,
    ]
    .join("\n");
    std::fs::write(project.join("healthy-session-id.jsonl"), content).unwrap();

    let settings = crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
    let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let sessions_app = super::router(super::SessionsState {
        auth_token: std::sync::Arc::clone(&auth_token),
        settings: settings.clone(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: std::sync::Arc::new(tx),
        terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
        name_auth: crate::ai_title::GeminiSessionNameAuth::direct_for_test(
            crate::ai_title::AiKeyCell::init(None, None),
        ),
        gemini: std::sync::Arc::new(FakeGemini(Err("unused in default test state".into()))),
        metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
        index: None,
        generation_wake: None,
    });
    let session_index =
        std::sync::Arc::new(freshell_sessions::directory_index::SessionIndex::new(vec![
            std::sync::Arc::new(freshell_sessions::directory_index::ClaudeSource::new(
                // Pin the temp home's claude root DIRECTLY, never through
                // `claude_home(&home)` (which lets the process-global
                // CLAUDE_HOME env var win over the explicit home — the
                // production override parity). Parallel test modules
                // mutate CLAUDE_HOME process-globally while holding their
                // OWN lock, so a test that does not take that lock can
                // resolve a FOREIGN temp home at construction and scan the
                // wrong root forever (the observed full-parallelism flake;
                // green solo and at 4 threads).
                home.join(".claude"),
            )) as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
        ]));
    let dir_app =
        crate::session_directory::router(crate::session_directory::SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
            collision_signatures: Default::default(),
            legacy_name_migration_completed: false,
        });

    // Present BEFORE the delete.
    let before_resp = dir_app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/session-directory?priority=visible")
                .header("x-auth-token", "tok")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(before_resp.status(), StatusCode::OK);
    let before = body_json(before_resp).await;
    let items = before["items"].as_array().unwrap();
    assert!(
        items
            .iter()
            .any(|i| i["sessionId"] == serde_json::json!("healthy-session-id")),
        "seeded session must be visible before DELETE"
    );

    // Soft-delete through the sessions router.
    let del_resp = sessions_app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/sessions/healthy-session-id?provider=claude")
                .header("x-auth-token", "tok")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(del_resp.status(), StatusCode::OK);

    // Gone AFTER the delete — and the source .jsonl is still on disk, since
    // a soft delete only writes the override.
    let after_resp = dir_app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/session-directory?priority=visible")
                .header("x-auth-token", "tok")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after_resp.status(), StatusCode::OK);
    let after = body_json(after_resp).await;
    let items = after["items"].as_array().unwrap();
    assert!(
        items
            .iter()
            .all(|i| i["sessionId"] != serde_json::json!("healthy-session-id")),
        "deleted session must be filtered from the directory, got {items:?}"
    );
    assert!(project.join("healthy-session-id.jsonl").exists());

    std::fs::remove_dir_all(&home).ok();
}

/// Same 4-line fake as `auto_title_sweep`'s test transport: the wired-in
/// result IS the Gemini reply. NO live Gemini calls in tests, ever.
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

/// Oneshots `POST /api/sessions/{sid}/generate-title` with
/// `{"firstMessage": first}` and the auth header against a router built
/// from a CLONE of `st` (the caller keeps the original for post-request
/// assertions on settings/broadcast state).
async fn post_generate_title(
    st: &super::SessionsState,
    sid: &str,
    first: &str,
) -> axum::response::Response {
    super::router(st.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{sid}/generate-title"))
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "firstMessage": first }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn generate_title_uses_gemini_when_key_present_and_broadcasts_sessions_changed() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.name_auth = crate::ai_title::GeminiSessionNameAuth::direct_for_test(
        crate::ai_title::AiKeyCell::init(Some("k".into()), None),
    );
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("  Sardine crash investigation  ".into())));
    let mut rx = st.broadcast_tx.subscribe();
    let sid = uuid_like();
    let resp = post_generate_title(
        &st,
        &format!("gemini:{sid}"),
        "investigate the sardine crash",
    )
    .await;
    let body = body_json(resp).await;
    assert_eq!(body["title"], "Sardine crash investigation");
    assert_eq!(body["source"], "ai");
    let row = st
        .settings
        .session_overrides()
        .get(&format!("gemini:{sid}"))
        .cloned()
        .unwrap();
    assert_eq!(row["titleSource"], "ai");
    let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(frames.iter().any(|f| f.contains("sessions.changed")));
}

/// Delta-review round 4, finding 1: a KILROY-ONLY session's generate-title
/// keeps kilroy's RETAINED server-side AI titling — the Gemini answer
/// persists through the settings ladder and broadcasts `sessions.changed`,
/// never the scoped compatibility arm (which could only answer
/// `{title:null}` — the sweep guarantees a kilroy-only session never has a
/// naming record to read a name from).
#[tokio::test]
async fn kilroy_generate_title_keeps_the_retained_server_side_ai_titling() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.name_auth = crate::ai_title::GeminiSessionNameAuth::direct_for_test(
        crate::ai_title::AiKeyCell::init(Some("k".into()), None),
    );
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("Kilroy AI Title".into())));
    st.metadata
        .set("claude", "s-kilroy-gen", "kilroy", Some("explicit"))
        .await
        .unwrap();
    // The naming authority is wired (the way production wires it) so the
    // test also proves it was never given a record.
    let names = crate::session_names::SessionNames::open(dir.path().join(".freshell")).unwrap();
    st.identity.set_session_naming(names.clone());
    let mut rx = st.broadcast_tx.subscribe();
    let body =
        body_json(post_generate_title(&st, "claude:s-kilroy-gen", "a kilroy prompt").await).await;
    assert_eq!(body["title"], serde_json::json!("Kilroy AI Title"));
    assert_eq!(body["source"], "ai");
    let row = st
        .settings
        .session_overrides()
        .get("claude:s-kilroy-gen")
        .cloned()
        .expect("the retained ladder persisted the AI title");
    assert_eq!(row["titleOverride"], "Kilroy AI Title");
    assert_eq!(row["titleSource"], "ai");
    let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(frames.iter().any(|f| f.contains("sessions.changed")));
    assert!(
        names
            .get(vec![freshell_protocol::SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "s-kilroy-gen".into(),
            }])
            .await
            .unwrap()
            .is_empty(),
        "the retained AI titling never enters the naming authority"
    );
}

#[tokio::test]
async fn generate_title_gemini_error_returns_200_none_with_error_and_no_write() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.name_auth = crate::ai_title::GeminiSessionNameAuth::direct_for_test(
        crate::ai_title::AiKeyCell::init(Some("k".into()), None),
    );
    st.gemini = std::sync::Arc::new(FakeGemini(Err("boom".into())));
    let sid = uuid_like();
    let body = body_json(post_generate_title(&st, &format!("gemini:{sid}"), "hello").await).await;
    assert_eq!(body["title"], serde_json::Value::Null);
    assert_eq!(body["source"], "none");
    assert_eq!(body["error"], "boom");
    assert!(st
        .settings
        .session_overrides()
        .get(&format!("gemini:{sid}"))
        .is_none());
}

#[tokio::test]
async fn generate_title_after_user_rename_is_still_ladder_blocked_for_ai() {
    // AI write attempted, ladder rejects, response echoes the user's stored
    // title. Unified agent names (Task 4): claude is scoped, so this pin of
    // the RETAINED ladder runs on an excluded provider.
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.name_auth = crate::ai_title::GeminiSessionNameAuth::direct_for_test(
        crate::ai_title::AiKeyCell::init(Some("k".into()), None),
    );
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("AI Title".into())));
    let sid = uuid_like();
    st.settings
        .patch_session_override(
            &format!("gemini:{sid}"),
            &[
                ("titleOverride", Some(serde_json::json!("Mine"))),
                ("titleSource", Some(serde_json::json!("user"))),
            ],
        )
        .await;
    let body = body_json(post_generate_title(&st, &format!("gemini:{sid}"), "hello").await).await;
    assert_eq!(body["title"], "Mine");
    assert_eq!(body["source"], "user");
}

/// The provider-generated short-circuit (`sessions-router.ts:186-192`):
/// a session whose PARSED title is provider-authored is never renamed by
/// this route -- the parsed title is echoed with NO override write, even
/// with an AI key present and a transport that WOULD return a title. The
/// index fixture is the committed claude `real-corrupted.jsonl` (its
/// `type:'summary'` record marks the parsed title provider-generated --
/// proven by directory_index.rs's
/// `indexed_session_carries_first_user_message_and_provider_generated_title_source`;
/// opencode sessions can never be provider-generated), seeded the same
/// way `patch_override_is_visible_through_session_directory_overlay`
/// above builds its `SessionIndex`.
#[tokio::test]
async fn generate_title_provider_generated_short_circuits_without_write() {
    let home = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    let project = home.join(".claude").join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/sessions/real-corrupted.jsonl");
    std::fs::copy(&fixture, project.join("real-corrupted.jsonl")).unwrap();

    let mut st = state(&home);
    st.name_auth = crate::ai_title::GeminiSessionNameAuth::direct_for_test(
        crate::ai_title::AiKeyCell::init(Some("k".into()), None),
    );
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("AI Title".into())));
    st.index = Some(std::sync::Arc::new(
        freshell_sessions::directory_index::SessionIndex::with_ttl_and_cache_path(
            vec![
                std::sync::Arc::new(freshell_sessions::directory_index::ClaudeSource::new(
                    // Pin the temp home's claude root DIRECTLY, never through
                    // `claude_home(&home)` (which lets the process-global
                    // CLAUDE_HOME env var win over the explicit home — the
                    // production override parity). Parallel test modules
                    // mutate CLAUDE_HOME process-globally while holding
                    // their OWN lock, so a test that does not take that
                    // lock can resolve a FOREIGN temp home at construction
                    // and scan the wrong root forever (the observed
                    // full-parallelism flake; green solo and at 4 threads).
                    home.join(".claude"),
                ))
                    as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
            ],
            std::time::Duration::from_millis(1_000),
            None,
        ),
    ));
    // Claude's canonical identity is the transcript filename, even when an
    // embedded record carries a different (for example parent-agent) id.
    // Unified agent names (Task 4): claude is SCOPED, so the route is the
    // compatibility arm — a provider-authored title NEVER suppresses the
    // naming pipeline; it lands at its own fallback rank and the route
    // answers the SAVED name.
    let sid = "real-corrupted";
    let names = crate::session_names::SessionNames::open(home.join(".freshell")).unwrap();
    let parsed = st
        .index
        .as_ref()
        .unwrap()
        .snapshot()
        .await
        .iter()
        .find(|s| s.session_id == sid)
        .cloned()
        .expect("the fixture session is indexed");
    names
        .hydrate_indexed(
            crate::session_name_generation::IndexedNameInput {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: sid.to_string(),
                cwd: parsed.cwd.clone(),
                first_user_message: parsed.first_user_message.clone(),
                provider_title: parsed.title.clone(),
            },
            false,
        )
        .await
        .unwrap();
    st.identity.set_session_naming(names);
    let body = body_json(post_generate_title(&st, sid, "hello").await).await;
    assert_eq!(body["title"], "Test Session 1"); // the fixture's parsed summary title
    assert_eq!(body["source"], "provider-generated");
    assert!(st
        .settings
        .session_overrides()
        .get(&format!("claude:{sid}"))
        .is_none());
    std::fs::remove_dir_all(&home).ok();
}

fn uuid_like() -> String {
    format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
        .replace([':', '.', ' '], "-")
}

// ---------------------------------------------------------------------------
// Unified agent names (Task 4): the scoped generate-title compatibility path
// ---------------------------------------------------------------------------

fn uuid_like_scoped() -> String {
    format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
        .replace([':', '.', ' '], "-")
}

/// A scoped session's generate-title call is the COMPATIBILITY route only:
/// it answers the saved session name (mapped to the legacy source
/// vocabulary), never writes the settings ladder, never calls Gemini
/// itself, and never arms or re-arms the durable series. An un-armed
/// session stays un-armed; an exhausted series stays exhausted.
#[tokio::test]
async fn scoped_generate_title_answers_the_saved_name_and_never_touches_the_ladder() {
    let dir = std::env::temp_dir().join(format!("frs-sess-gen-{}", uuid_like_scoped()));
    std::fs::create_dir_all(&dir).unwrap();
    let names = crate::session_names::SessionNames::open(dir.join(".freshell")).unwrap();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    identity.set_session_naming(names.clone());
    let mut scoped_state = state(&dir);
    scoped_state.identity = identity;

    // A saved FirstMessage fallback for the scoped claude session, plus an
    // armed (unattempted) series.
    let target = freshell_protocol::SessionNameRef::Session {
        provider: freshell_protocol::session_names::NamedProvider::Claude,
        session_id: "ses-scoped-gen".to_string(),
    };
    names
        .hydrate_indexed(
            crate::session_name_generation::IndexedNameInput {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "ses-scoped-gen".to_string(),
                cwd: Some("/w/proj".to_string()),
                first_user_message: Some("Saved fallback message".to_string()),
                provider_title: None,
            },
            false,
        )
        .await
        .unwrap();

    let app = super::router(scoped_state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions/claude%3Ases-scoped-gen/generate-title")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"firstMessage":"A late compatibility request"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["title"], serde_json::json!("Saved fallback message"));
    assert_eq!(v["source"], serde_json::json!("first-message"));
    // The settings ladder never acquired a competing scoped title.
    assert!(state(&dir)
        .settings
        .session_overrides()
        .get("claude:ses-scoped-gen")
        .is_none());
    // The record's own name is untouched by the compatibility call.
    let updates = names.get(vec![target]).await.unwrap();
    assert_eq!(updates[0].record.name, "Saved fallback message");

    // A scoped session with NO naming record answers `{title: null}` without
    // creating one.
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions/codex%3Ases-unknown/generate-title")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"firstMessage":"anything"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["title"], serde_json::Value::Null);
    assert_eq!(v["source"], serde_json::json!("none"));

    std::fs::remove_dir_all(&dir).ok();
}
