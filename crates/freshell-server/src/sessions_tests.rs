use axum::body::Body;
use axum::http::{Request, StatusCode};
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
        // AI disabled by default; tests that exercise the AI branch
        // overwrite these fields (the no-key path never touches gemini).
        ai_key: crate::ai_title::AiKeyCell::init(None, None),
        gemini: std::sync::Arc::new(FakeGemini(Err("unused in default test state".into()))),
        index: None,
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
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = super::router(state(&dir));
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=claude")
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

    // A terminal currently running `claude:sess-live` (the session key
    // this PATCH targets) -- `find_by_session` needs a LIVE (non-retired)
    // match, and the registry write-through needs a REAL registered
    // terminal_id (`update_title` is a no-op against an unknown id).
    st.identity
        .upsert("term-live", Some("claude"), Some("sess-live"), None, 1000);
    spawn_headless_terminal_for_test(&st.registry, "term-live");

    // Subscribe BEFORE the PATCH so the `terminals.changed` send lands in
    // this receiver's buffer.
    let mut broadcast_rx = st.broadcast_tx.subscribe();

    let app = super::router(st.clone());
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/sess-live?provider=claude")
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
/// `null`. This pins the live-only semantic against the OPPOSITE
/// (terminal -> session) direction's `.get()`-based
/// `rename_cascades_even_after_the_terminal_has_exited` test in
/// `terminals.rs`, which deliberately DOES still cascade for a retired
/// terminal -- the two directions are asymmetric on purpose.
#[tokio::test]
async fn patch_rename_to_a_retired_terminal_identity_does_not_cascade() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);

    st.identity.upsert(
        "term-exited",
        Some("claude"),
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
                .uri("/api/sessions/sess-exited?provider=claude")
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
                .uri("/api/sessions/abc123?provider=claude")
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
                .uri("/api/sessions/abc/generate-title")
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
            "claude:abc",
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
                .uri("/api/sessions/abc/generate-title")
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
                .uri("/api/sessions/abc/generate-title")
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
#[tokio::test]
async fn patch_override_is_visible_through_session_directory_overlay() {
    use axum::http::Request as HttpRequest;

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

    // Patch title + archived through the sessions router.
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let sessions_app = super::router(super::SessionsState {
        auth_token: std::sync::Arc::clone(&auth_token),
        settings: settings.clone(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: std::sync::Arc::new(tx),
        terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
        ai_key: crate::ai_title::AiKeyCell::init(None, None),
        gemini: std::sync::Arc::new(FakeGemini(Err("unused in default test state".into()))),
        index: None,
    });
    let patch_resp = sessions_app
        .oneshot(
            HttpRequest::builder()
                .method("PATCH")
                .uri("/api/sessions/healthy-session-id?provider=claude")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"titleOverride":"Overlay Title","archived":true}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(patch_resp.status(), StatusCode::OK);

    // Query the session-directory read model with the SAME settings store.
    // Batch B: the read model is backed by a `SessionIndex` now, not a
    // per-request `home: Option<PathBuf>` scan.
    let session_index =
        std::sync::Arc::new(freshell_sessions::directory_index::SessionIndex::new(vec![
            std::sync::Arc::new(freshell_sessions::directory_index::ClaudeSource::new(
                crate::session_directory::claude_home(&home),
            )) as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
        ]));
    let dir_app =
        crate::session_directory::router(crate::session_directory::SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
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
    assert_eq!(item["title"], serde_json::json!("Overlay Title"));
    assert_eq!(item["archived"], serde_json::json!(true));

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
    st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("  Sardine crash investigation  ".into())));
    let mut rx = st.broadcast_tx.subscribe();
    let sid = uuid_like();
    let resp = post_generate_title(&st, &sid, "investigate the sardine crash").await;
    let body = body_json(resp).await;
    assert_eq!(body["title"], "Sardine crash investigation");
    assert_eq!(body["source"], "ai");
    let row = st
        .settings
        .session_overrides()
        .get(&format!("claude:{sid}"))
        .cloned()
        .unwrap();
    assert_eq!(row["titleSource"], "ai");
    let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(frames.iter().any(|f| f.contains("sessions.changed")));
}

#[tokio::test]
async fn generate_title_gemini_error_returns_200_none_with_error_and_no_write() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
    st.gemini = std::sync::Arc::new(FakeGemini(Err("boom".into())));
    let sid = uuid_like();
    let body = body_json(post_generate_title(&st, &sid, "hello").await).await;
    assert_eq!(body["title"], serde_json::Value::Null);
    assert_eq!(body["source"], "none");
    assert_eq!(body["error"], "boom");
    assert!(st
        .settings
        .session_overrides()
        .get(&format!("claude:{sid}"))
        .is_none());
}

#[tokio::test]
async fn generate_title_after_user_rename_is_still_ladder_blocked_for_ai() {
    // AI write attempted, ladder rejects, response echoes the user's stored title.
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("AI Title".into())));
    let sid = uuid_like();
    st.settings
        .patch_session_override(
            &format!("claude:{sid}"),
            &[
                ("titleOverride", Some(serde_json::json!("Mine"))),
                ("titleSource", Some(serde_json::json!("user"))),
            ],
        )
        .await;
    let body = body_json(post_generate_title(&st, &sid, "hello").await).await;
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
    st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("AI Title".into())));
    st.index = Some(std::sync::Arc::new(
        freshell_sessions::directory_index::SessionIndex::new(vec![std::sync::Arc::new(
            freshell_sessions::directory_index::ClaudeSource::new(
                crate::session_directory::claude_home(&home),
            ),
        )
            as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>]),
    ));
    let sid = "b7936c10-4935-441c-837c-c1f33cafec2d"; // the fixture's sessionId
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
