//! Real routes over a switched live session before naming/index hydration.

use super::*;
use freshell_sessions::directory_index::{ClaudeSource, SessionIndex};
use freshell_ws::identity::TerminalIdentityRegistry;

const SESSION: &str = "88888888-9999-4aaa-8bbb-cccccccc0042";

#[derive(Clone, Copy, Debug)]
enum Surface {
    Canonical,
    Session,
    Terminal,
}

fn target() -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Claude,
        session_id: SESSION.into(),
    }
}

fn live_identity(names: &Arc<SessionNames>) -> TerminalIdentityRegistry {
    let identity = TerminalIdentityRegistry::new();
    identity.set_session_naming(names.clone());
    identity.upsert(
        "live",
        Some("claude"),
        Some(SESSION),
        Some("/work/billing"),
        1_000,
    );
    identity.set_name_binding("live", Some(target()), None);
    identity
}

fn route(
    surface: Surface,
    home: &std::path::Path,
    names: &Arc<SessionNames>,
    identity: TerminalIdentityRegistry,
    index: Option<Arc<SessionIndex>>,
) -> (Router, String) {
    match surface {
        Surface::Canonical => (
            super::super::router(SessionNamesState {
                auth_token: Arc::new("tok".into()),
                names: names.clone(),
                identity,
                index,
            }),
            "/api/session-names".into(),
        ),
        Surface::Session => {
            let metadata =
                crate::session_metadata::SessionMetadataStore::new(home.join(".freshell"));
            let mut state = sessions_router_state(home, names, metadata);
            state.identity = identity;
            state.index = index;
            (
                crate::sessions::router(state),
                format!("/api/sessions/claude:{SESSION}"),
            )
        }
        Surface::Terminal => {
            let registry = freshell_terminal::TerminalRegistry::new();
            registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
                terminal_id: "live".into(),
                stream_id: "stream".into(),
                mode: "claude".into(),
                resume_session_id: Some(SESSION.into()),
                create_request_id: None,
                created_at: None,
            });
            registry.set_naming("live", Some(target()), None);
            let (tx, _rx) = tokio::sync::broadcast::channel(16);
            (
                crate::terminals::router(crate::terminals::TerminalsState {
                    auth_token: Arc::new("tok".into()),
                    settings: crate::settings_store::SettingsStore::load(
                        Some(home),
                        vec!["claude".into()],
                    ),
                    registry,
                    broadcast_tx: Arc::new(tx),
                    terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
                    identity,
                }),
                "/api/terminals/live".into(),
            )
        }
    }
}

fn rename_body(name: &str, revision: Option<u64>) -> Value {
    let mut body =
        json!({"target": target(), "name": name, "titleOverride": name, "nameIntent": "user"});
    if let Some(revision) = revision {
        body["ifRevision"] = json!(revision);
    }
    body
}

#[tokio::test]
async fn known_live_session_can_be_named_from_every_session_surface() {
    for surface in [Surface::Canonical, Surface::Session, Surface::Terminal] {
        let home = temp_home();
        let names = names_state(&home).names;
        assert!(names.get(vec![target()]).await.unwrap().is_empty());
        let (router, uri) = route(surface, &home, &names, live_identity(&names), None);
        let (status, body) = patch(
            router,
            &uri,
            rename_body("Named before first message", None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{surface:?}: {body}");
        let record = &names.get(vec![target()]).await.unwrap()[0].record;
        assert_eq!(record.name, "Named before first message");
        assert_eq!(record.source, NameSource::Manual);
        std::fs::remove_dir_all(home).ok();
    }
}

#[tokio::test]
async fn known_live_admission_preserves_revision_conflicts_on_every_surface() {
    for surface in [Surface::Canonical, Surface::Session, Surface::Terminal] {
        let home = temp_home();
        let names = names_state(&home).names;
        let (router, uri) = route(surface, &home, &names, live_identity(&names), None);
        let (status, body) =
            patch(router.clone(), &uri, rename_body("Stale capture", Some(0))).await;
        assert_eq!(status, StatusCode::CONFLICT, "{surface:?}: {body}");
        assert_eq!(body["error"], "NAME_REVISION_CONFLICT");
        let current = names.get(vec![target()]).await.unwrap()[0].record.clone();
        assert_eq!(
            current.source,
            NameSource::Directory,
            "the stale rename never applies"
        );
        let (status, body) = patch(
            router,
            &uri,
            rename_body("Confirmed retry", Some(current.revision)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{surface:?}: {body}");
        assert_eq!(
            names.get(vec![target()]).await.unwrap()[0].record.name,
            "Confirmed retry"
        );
        std::fs::remove_dir_all(home).ok();
    }
}

#[tokio::test]
async fn unknown_or_only_prospective_session_targets_stay_not_found() {
    for surface in [Surface::Canonical, Surface::Session] {
        for kind in ["unknown", "pending", "retired"] {
            let home = temp_home();
            let names = names_state(&home).names;
            let identity = if kind == "unknown" {
                let identity = TerminalIdentityRegistry::new();
                identity.set_session_naming(names.clone());
                identity
            } else {
                live_identity(&names)
            };
            match kind {
                "unknown" => {}
                "pending" => identity.set_name_binding(
                    "live",
                    Some(SessionNameRef::Pending {
                        id: "still-pending".into(),
                    }),
                    None,
                ),
                "retired" => {
                    identity.retire("live");
                }
                _ => unreachable!(),
            }
            let (router, uri) = route(surface, &home, &names, identity, None);
            let (status, body) =
                patch(router, &uri, rename_body("Must not invent a session", None)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{surface:?}/{kind}: {body}");
            assert!(names.get(vec![target()]).await.unwrap().is_empty());
            std::fs::remove_dir_all(home).ok();
        }
    }
}

#[tokio::test]
async fn published_index_target_can_be_named_before_naming_hydrates_it() {
    for surface in [Surface::Canonical, Surface::Session] {
        let home = temp_home();
        let names = names_state(&home).names;
        let project = home.join(".claude/projects/-work-billing");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join(format!("{SESSION}.jsonl")), format!(
            "{{\"type\":\"user\",\"sessionId\":\"{SESSION}\",\"cwd\":\"/work/billing\",\"timestamp\":\"2026-10-23T10:00:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"Fix billing invoices\"}}}}\n"
        )).unwrap();
        let index = Arc::new(SessionIndex::new(vec![Arc::new(ClaudeSource::new(
            home.join(".claude"),
        ))]));
        assert!(
            index
                .snapshot()
                .await
                .iter()
                .any(|row| row.session_id == SESSION),
            "the real parser published the session"
        );
        let identity = TerminalIdentityRegistry::new();
        identity.set_session_naming(names.clone());
        let (router, uri) = route(surface, &home, &names, identity, Some(index));
        let (status, body) = patch(router, &uri, rename_body("Named from index", None)).await;
        assert_eq!(status, StatusCode::OK, "{surface:?}: {body}");
        assert_eq!(
            names.get(vec![target()]).await.unwrap()[0].record.name,
            "Named from index"
        );
        std::fs::remove_dir_all(home).ok();
    }
}
