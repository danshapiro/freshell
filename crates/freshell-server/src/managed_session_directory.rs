//! Presentation-only composition of actual owned fresh-agent history.
use super::*;
use freshell_runtime_client::RuntimeClient;
use freshell_runtime_protocol::{DesiredState, IncarnationId, LaunchState, RuntimeView, SoulId};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::{Duration, Instant},
};

const MAX_NATIVE_READS: usize = 50;
const READ_CONCURRENCY: usize = 4;
const READ_BUDGET: Duration = Duration::from_secs(10);
const PRESENTATION_TTL: Duration = Duration::from_secs(3);

#[derive(Clone, Default)]
pub(super) struct Cache(Arc<tokio::sync::Mutex<PresentationCache>>);

#[derive(Default)]
struct PresentationCache {
    entries: HashMap<String, CachedRead>,
    next_after: Option<SoulId>,
}

struct CachedRead {
    attempted_at: Instant,
    refresh_succeeded: bool,
    item: Option<CachedItem>,
}

impl CachedRead {
    fn refresh_due(&self) -> bool {
        // Until history has a saved row, its first turn may arrive at any time.
        self.item.is_none() || self.attempted_at.elapsed() >= PRESENTATION_TTL
    }
}

struct CachedItem {
    incarnation_id: IncarnationId,
    item: DirItem,
}

pub(super) struct Snapshot {
    pub(super) items: Vec<DirItem>,
    pub(super) partial: bool,
}

pub(super) async fn read(client: &RuntimeClient, cache: &Cache) -> Snapshot {
    let deadline = tokio::time::Instant::now() + READ_BUDGET;
    let mut snapshot = Snapshot {
        items: Vec::new(),
        partial: false,
    };
    let inventory = match tokio::time::timeout_at(deadline, client.inventory()).await {
        Ok(Ok(inventory)) => inventory,
        _ => {
            tracing::warn!(target: "freshell_server::session_directory", reason = "managed_inventory_unavailable", "managed_directory_partial");
            snapshot.partial = true;
            return snapshot;
        }
    };
    // Serialize discovery passes, including the lock wait in the same budget.
    // TTL schedules refresh; it must not erase already discovered presentation.
    let mut cached = match tokio::time::timeout_at(deadline, cache.0.lock()).await {
        Ok(cached) => cached,
        Err(_) => {
            tracing::warn!(target: "freshell_server::session_directory", reason = "managed_discovery_busy", "managed_directory_partial");
            snapshot.partial = true;
            return snapshot;
        }
    };
    let mut souls = BTreeMap::new();
    for view in inventory
        .into_iter()
        .filter(|v| v.fresh_agent_session_type.is_some())
    {
        souls
            .entry(view.soul_id.clone())
            .or_insert_with(Vec::new)
            .push(view);
    }
    let mut groups = Vec::new();
    for views in souls.into_values() {
        let view = &views[0];
        let Some(native_id) = view
            .native_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
        else {
            diagnostic(view, "native_identity_unavailable");
            snapshot.partial = true;
            continue;
        };
        let key = format!(
            "{}:{}:{}:{}:{:?}",
            view.soul_id,
            view.intent_revision,
            view.evidence_revision,
            native_id,
            views
                .iter()
                .map(|v| (
                    &v.incarnation_id,
                    &v.container_id,
                    v.execution_generation,
                    v.launch_state
                ))
                .collect::<Vec<_>>()
        );
        groups.push((key, views));
    }
    let current_keys: HashSet<_> = groups.iter().map(|(key, _)| key.as_str()).collect();
    cached
        .entries
        .retain(|key, _| current_keys.contains(key.as_str()));
    let mut pending: Vec<_> = groups
        .iter()
        .filter(|(key, _)| cached.entries.get(key).is_none_or(CachedRead::refresh_due))
        .cloned()
        .collect();
    // Advance past actual dispatched reads, even if they fail or time out.
    // Otherwise expired/unreadable roots at the beginning starve the tail.
    if let Some(after) = &cached.next_after {
        let split = pending.partition_point(|(_, views)| &views[0].soul_id <= after);
        pending.rotate_left(split);
    }
    if pending.len() > MAX_NATIVE_READS {
        tracing::warn!(target: "freshell_server::session_directory", reason = "native_read_budget", pending_count = pending.len(), "managed_directory_partial");
        snapshot.partial = true;
    }
    let mut tasks = tokio::task::JoinSet::new();
    let mut pending = pending.into_iter().take(MAX_NATIVE_READS);
    loop {
        while tasks.len() < READ_CONCURRENCY {
            let Some((key, views)) = pending.next() else {
                break;
            };
            cached.next_after = Some(views[0].soul_id.clone());
            let client = client.clone();
            tasks.spawn(async move {
                let history = client.fresh_agent_history(views[0].soul_id.clone()).await;
                (key, views, history)
            });
        }
        if tasks.is_empty() {
            break;
        }
        match tokio::time::timeout_at(deadline, tasks.join_next()).await {
            Ok(Some(Ok((key, views, history)))) => {
                let projected = history
                    .ok()
                    .and_then(|history| project_owned(&views, &history));
                if projected.is_none() {
                    diagnostic(&views[0], "owned_history_unavailable_or_invalid");
                    snapshot.partial = true;
                }
                let entry = cached.entries.entry(key).or_insert(CachedRead {
                    attempted_at: Instant::now(),
                    refresh_succeeded: false,
                    item: None,
                });
                entry.attempted_at = Instant::now();
                entry.refresh_succeeded = projected.is_some();
                // A failed refresh may retain the last presentation for the
                // unchanged owner identity, but it always remains partial.
                if let Some(item) = projected {
                    entry.item = Some(item);
                }
            }
            _ => {
                snapshot.partial = true;
                tracing::warn!(target: "freshell_server::session_directory", reason = "native_read_timeout", "managed_directory_partial");
                tasks.abort_all();
                while tasks.join_next().await.is_some() {}
                break;
            }
        }
    }
    for (key, views) in groups {
        let Some(entry) = cached.entries.get(&key) else {
            snapshot.partial = true;
            continue;
        };
        let Some(saved) = &entry.item else {
            snapshot.partial = true;
            continue;
        };
        let Some(current) = views
            .iter()
            .find(|v| v.incarnation_id == saved.incarnation_id)
        else {
            snapshot.partial = true;
            continue;
        };
        if !entry.refresh_succeeded || entry.refresh_due() {
            snapshot.partial = true;
        }
        let mut item = saved.item.clone();
        item.is_running = running(current);
        snapshot.items.push(item);
    }
    snapshot
}

fn project_owned(views: &[RuntimeView], history: &Value) -> Option<CachedItem> {
    let incarnation_id = history["managedDirectory"]["incarnationId"].as_str()?;
    let view = views
        .iter()
        .find(|v| v.incarnation_id.as_str() == incarnation_id)?;
    Some(CachedItem {
        incarnation_id: view.incarnation_id.clone(),
        item: project(view, history)?,
    })
}

fn diagnostic(view: &RuntimeView, reason: &str) {
    tracing::warn!(target: "freshell_server::session_directory", soul_id = %view.soul_id,
        incarnation_id = %view.incarnation_id, intent_revision = view.intent_revision,
        execution_generation = view.execution_generation, reason, "managed_directory_partial");
}

fn running(view: &RuntimeView) -> bool {
    view.desired_state == DesiredState::Running && view.launch_state == LaunchState::Running
}

fn project(view: &RuntimeView, history: &Value) -> Option<DirItem> {
    let native_id = view.native_session_id.as_deref()?;
    let native_provider = view.provider.as_deref()?;
    let provider = if native_provider == "kilroy" {
        "claude"
    } else {
        native_provider
    };
    let context = &history["managedDirectory"];
    let session_type = view.fresh_agent_session_type.as_deref()?;
    if history["threadId"].as_str() != Some(native_id)
        || history["provider"].as_str() != Some(provider)
        || context["sessionType"].as_str() != Some(session_type)
    {
        return None;
    }
    let turns = history["turns"].as_array()?;
    if turns.is_empty() {
        return None;
    }
    let cwd = context["cwd"].as_str()?.to_owned();
    if !Path::new(&cwd).is_absolute() {
        return None;
    }
    let project_path = context["gitCommonDir"]
        .as_str()
        .and_then(|common| {
            Path::new(common)
                .file_name()
                .filter(|name| *name == ".git")
                .and_then(|_| Path::new(common).parent())
        })
        .map(|root| root.to_string_lossy().into_owned())
        .or_else(|| freshell_platform::git_meta::resolve_git_repo_root(&cwd))?;
    let title = history["summary"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            turns
                .iter()
                .find_map(|turn| turn["summary"].as_str().filter(|s| !s.trim().is_empty()))
        })
        .map(|s| s.chars().take(160).collect::<String>());
    let last_activity_at =
        history["extensions"][provider]["nativeHistoryActivity"]["at"].as_i64()?;
    let managed_history_search = normalized_managed_history_search(
        provider,
        turns,
        history["extensions"][provider]["nativeHistoryRetention"]["partial"]
            .as_bool()
            .unwrap_or(false),
    );
    let indexed = IndexedSession {
        session_id: native_id.into(),
        legacy_session_id: None,
        provider: provider.into(),
        project_path,
        title,
        title_provider_generated: false,
        summary: None,
        first_user_message: None,
        title_source: None,
        last_activity_at,
        created_at: None,
        cwd: Some(cwd),
        git_branch: None,
        is_subagent: false,
        is_non_interactive: false,
        source_file: None,
        token_usage: None,
    };
    let mut item = dir_item_from_indexed_with_source_files(&indexed, Vec::new());
    item.managed_history_search = Some(managed_history_search);
    item.session_type = Some(session_type.into());
    item.is_running = running(view);
    Some(item)
}

fn normalized_managed_history_search(
    provider: &str,
    turns: &[Value],
    partial: bool,
) -> ManagedHistorySearch {
    let mut messages = Vec::new();
    for turn in turns {
        if provider == "codex" {
            for item in turn["items"].as_array().into_iter().flatten() {
                let (role, text) = match item["type"].as_str() {
                    Some("userMessage") => ("user", normalized_text_parts(&item["content"])),
                    Some("agentMessage") => (
                        "assistant",
                        item["text"].as_str().unwrap_or_default().to_owned(),
                    ),
                    _ => continue,
                };
                if !text.trim().is_empty() {
                    messages.push(ManagedSearchMessage { role, text });
                }
            }
            continue;
        }

        let role = match turn["role"].as_str() {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let text = turn["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["kind"] == "text")
            .filter_map(|item| item["text"].as_str())
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            messages.push(ManagedSearchMessage { role, text });
        }
    }
    ManagedHistorySearch { messages, partial }
}

fn normalized_text_parts(parts: &Value) -> String {
    parts
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| matches!(part["type"].as_str(), Some("input_text" | "text")))
        .filter_map(|part| part["text"].as_str())
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use freshell_runtime_protocol::*;
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        backend::{
            BackendCreated, BackendError, BackendInspection, CreateRuntimeSpec, RuntimeBackend,
        },
        registry::{BackendCreatedRecord, LaunchPreparation, OwnedRuntimeHandle, Registry},
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use tower::ServiceExt;

    /// No processes or containers are created. The real supervisor owns the stop
    /// decision and registry writes; only the external runtime backend is replaced.
    #[derive(Default)]
    struct NativeBackend {
        history_home: Option<PathBuf>,
        history_overrides: HashMap<String, Value>,
        mismatch: bool,
        reads: Arc<std::sync::atomic::AtomicUsize>,
        turn_counts: Arc<std::sync::Mutex<Vec<usize>>>,
        slow_souls: HashSet<SoulId>,
    }

    #[async_trait]
    impl RuntimeBackend for NativeBackend {
        async fn read_native_history(
            &self,
            handle: &OwnedRuntimeHandle,
            provider: &str,
            native_id: &str,
            _: &std::path::Path,
        ) -> Result<serde_json::Value, BackendError> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.slow_souls.contains(handle.soul_id()) {
                tokio::time::sleep(READ_BUDGET + Duration::from_secs(1)).await;
            }
            assert_eq!(handle.fresh_agent().unwrap().provider.as_str(), provider);
            let mut snapshot = match self.history_overrides.get(native_id) {
                Some(snapshot) => snapshot.clone(),
                None => freshell_freshagent::native_history::read(
                    provider,
                    self.history_home.as_deref().expect("owned native fixture"),
                    native_id,
                )
                .map_err(BackendError::Unavailable)?,
            };
            self.turn_counts
                .lock()
                .unwrap()
                .push(snapshot["turns"].as_array().unwrap().len());
            if self.mismatch {
                snapshot["threadId"] = json!("wrong-owned-root");
            }
            Ok(snapshot)
        }
        async fn create_stopped(
            &self,
            _: &CreateRuntimeSpec,
        ) -> Result<BackendCreated, BackendError> {
            unreachable!()
        }
        async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!()
        }
        async fn inspect(&self, _: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
            unreachable!()
        }
        async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
            unreachable!()
        }
        async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!()
        }
        async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
            unreachable!()
        }
        async fn list_known(
            &self,
            _: &[OwnedRuntimeHandle],
        ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
            unreachable!()
        }
        async fn read_limits(&self, _: &OwnedRuntimeHandle) -> Result<RuntimeLimits, BackendError> {
            unreachable!()
        }
        async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!()
        }
    }

    fn limits() -> RuntimeLimits {
        RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 64 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 32,
        }
    }

    async fn register(
        root: &Path,
        provider: &str,
        session_type: &str,
        native_id: &str,
        cwd: &str,
    ) -> (Registry, RuntimeView) {
        let registry = Registry::open(root, None).unwrap();
        let view = register_in(&registry, root, provider, session_type, native_id, cwd).await;
        (registry, view)
    }

    async fn register_in(
        registry: &Registry,
        root: &Path,
        provider: &str,
        session_type: &str,
        native_id: &str,
        cwd: &str,
    ) -> RuntimeView {
        let soul_id = SoulId::new();
        let store_id = format!("store-{soul_id}");
        let fresh_agent: FreshAgentLaunchSpec = serde_json::from_value(json!({
            "sessionId": "fresh-retained-thread", "provider": provider, "sessionType": session_type,
            "runtimeVariant": provider, "providerStoreId": store_id, "cwd": cwd,
            "workspacePath": "/workspace", "runAsUid": 1000, "runAsGid": 1000,
            "nativeSessionId": native_id
        }))
        .unwrap();
        let prepared = registry
            .prepare_launch(LaunchPreparation {
                soul_id: soul_id.clone(),
                provider: provider.into(),
                provider_store_id: store_id,
                native_session_id: Some(native_id.into()),
                creation_seed_ref: "seed-test".into(),
                request_id: RequestId::new(),
                payload_digest: "payload-test".into(),
                requested_limits: limits(),
                profile: RuntimeProfile::Custom,
                project_key: format!("project-{soul_id}"),
                fixture: None,
                terminal: None,
                fresh_agent: Some(fresh_agent),
                view_intent: None,
                admission: AdmissionPolicy::default(),
            })
            .await
            .unwrap();
        start_registered(registry, root, &soul_id, prepared.incarnation_id, native_id).await;
        registry
            .inventory()
            .await
            .unwrap()
            .into_iter()
            .find(|v| v.soul_id == soul_id)
            .unwrap()
    }

    async fn start_registered(
        registry: &Registry,
        root: &Path,
        soul_id: &SoulId,
        incarnation_id: IncarnationId,
        native_id: &str,
    ) {
        registry
            .commit_created(
                incarnation_id.clone(),
                BackendCreatedRecord {
                    daemon_id: DockerDaemonId::new(),
                    container_id: "a".repeat(64),
                    image_ref: format!("sha256:{}", "b".repeat(64)),
                    runtime_dir: root.join("runtime"),
                    host_binary_path: root.join("host"),
                    immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
                    launch_policy: None,
                },
            )
            .await
            .unwrap();
        let grant = registry
            .commit_execution_grant(incarnation_id.clone(), HostBootId::new(), limits())
            .await
            .unwrap();
        let context = registry.recovery_context(soul_id.clone()).await.unwrap();
        let launch = registry
            .bind_native_identity_launch(NativeIdentityLaunch {
                incarnation_id: incarnation_id.clone(),
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: grant.execution_generation,
                requested_native_session_id: context.native_session_id.clone(),
            })
            .await
            .unwrap();
        let context = registry.recovery_context(soul_id.clone()).await.unwrap();
        // Controlled setup for the retained-runtime backend fixture, not native
        // qualification: exercise the production current-launch publication gate.
        registry
            .record_native_identity_observation(
                soul_id.clone(),
                NativeIdentityObservation {
                    native_session_id: native_id.into(),
                    incarnation_id: launch.incarnation_id,
                    launch_nonce: launch.launch_nonce,
                    evidence_revision: launch.evidence_revision,
                    source: NativeIdentitySource::FreshProviderHandshake,
                    evidence_digest: "a".repeat(64),
                },
                context.write_fence(),
            )
            .await
            .unwrap();
        registry.mark_running(incarnation_id).await.unwrap();
    }
    async fn start_control(
        root: &std::path::Path,
        registry: Registry,
        backend: Arc<dyn RuntimeBackend>,
    ) -> (PathBuf, tokio::task::JoinHandle<()>) {
        let socket = root.join("control.sock");
        let supervisor = Supervisor::new(
            registry.clone(),
            backend.clone(),
            SupervisorConfig {
                runtime_root: root.into(),
                control_socket_path: socket.clone(),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                test_run_id: "stop-lost-fixture".into(),
                control_secret: "test-control-secret".into(),
                lifecycle_log: root.join("lifecycle.jsonl"),
                admission: AdmissionPolicy::default(),
            },
        )
        .unwrap();
        let socket_for_server = socket.clone();
        let control =
            tokio::spawn(
                async move { serve_control(supervisor, &socket_for_server).await.unwrap() },
            );
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !socket.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        (socket, control)
    }

    fn native_fixture(home: &Path, provider: &str, native_id: &str) {
        if provider == "opencode" {
            let folder = home.join(".local/share/opencode");
            std::fs::create_dir_all(&folder).unwrap();
            let db = rusqlite::Connection::open(folder.join("opencode.db")).unwrap();
            db.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);").unwrap();
            db.execute(
                "INSERT INTO session VALUES(?1,'Saved managed request',1791712801000)",
                [native_id],
            )
            .unwrap();
            for (ordinal, role) in [(0, "user"), (1, "assistant")] {
                let id = format!("message{ordinal}");
                let data = json!({"id":id,"sessionID":native_id,"role":role,"time":{"created":1791712800000i64+ordinal,"completed":1791712801000i64+ordinal}});
                db.execute(
                    "INSERT INTO message VALUES(?1,?2,?3,?4)",
                    rusqlite::params![id, native_id, ordinal, data.to_string()],
                )
                .unwrap();
                let part = json!({"id":format!("part{ordinal}"),"sessionID":native_id,"messageID":id,"type":"text","text":format!("Saved managed {role}")});
                db.execute(
                    "INSERT INTO part VALUES(?1,?2,?3,?4,?5)",
                    rusqlite::params![
                        format!("part{ordinal}"),
                        native_id,
                        id,
                        ordinal,
                        part.to_string()
                    ],
                )
                .unwrap();
            }
        } else {
            let (folder, records) = if provider == "codex" {
                (
                    home.join(".codex/sessions/2026/10/11"),
                    vec![
                        json!({"type":"session_meta","timestamp":"2026-10-11T10:00:00Z","payload":{"id":native_id,"cwd":"/workspace"}}),
                        json!({"type":"turn_context","timestamp":"2026-10-11T10:00:00Z","payload":{"turn_id":"turn187"}}),
                        json!({"type":"response_item","timestamp":"2026-10-11T10:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Saved managed request"}]}}),
                        json!({"type":"response_item","timestamp":"2026-10-11T10:00:01Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Saved managed answer"}]}}),
                        json!({"type":"event_msg","timestamp":"2026-10-11T10:00:01Z","payload":{"type":"task_complete","turn_id":"turn187"}}),
                    ],
                )
            } else {
                (
                    home.join(".claude/projects/fixture"),
                    claude_fixture_records(native_id).to_vec(),
                )
            };
            std::fs::create_dir_all(&folder).unwrap();
            let filename = if provider == "codex" {
                format!("rollout-2026-10-11T10-00-00-{native_id}.jsonl")
            } else {
                format!("{native_id}.jsonl")
            };
            std::fs::write(
                folder.join(filename),
                records
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
        }
    }

    fn claude_fixture_records(native_id: &str) -> [Value; 2] {
        [
            json!({"type":"user","uuid":"user187","sessionId":native_id,"cwd":"/workspace","timestamp":"2026-10-11T10:00:00Z","message":{"role":"user","content":"Saved managed request"}}),
            json!({"type":"assistant","uuid":"answer187","parentUuid":"user187","sessionId":native_id,"timestamp":"2026-10-11T10:00:01Z","message":{"id":"msg187","role":"assistant","content":[{"type":"text","text":"Saved managed answer"}],"stop_reason":"end_turn"}}),
        ]
    }

    fn directory_state(home: &Path) -> SessionDirectoryState {
        SessionDirectoryState {
            auth_token: Arc::new("tok".into()),
            settings: crate::settings_store::SettingsStore::load(
                Some(home),
                vec!["claude".into(), "codex".into(), "opencode".into()],
            ),
            session_index: None,
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: Arc::new("srv-managed-test".into()),
            collision_signatures: Default::default(),
            legacy_name_migration_completed: false,
        }
    }

    async fn directory_page(app: Router) -> Value {
        directory_query(app, "").await
    }

    async fn directory_query(app: Router, query: &str) -> Value {
        use axum::{
            body::{to_bytes, Body},
            http::Request,
        };
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/session-directory?surface=history&priority=visible{query}"
                    ))
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn managed_history_search_uses_normalized_messages_for_supported_providers() {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let cwd = root.path().to_string_lossy().into_owned();
        let registry = Registry::open(root.path(), None).unwrap();
        let providers = [
            ("claude", "freshclaude", "managed-claude-search"),
            ("codex", "freshcodex", "managed-codex-search"),
            ("opencode", "freshopencode", "managed-opencode-search"),
        ];
        let mut history_overrides = HashMap::new();
        for (provider, session_type, native_id) in providers {
            let view = register_in(
                &registry,
                root.path(),
                provider,
                session_type,
                native_id,
                &cwd,
            )
            .await;
            let user_marker = format!("managed-user-{provider}-marker");
            let assistant_marker = format!("managed-assistant-{provider}-marker");
            let turns = match provider {
                "claude" => json!([
                    {"role":"user","items":[{"kind":"text","text":user_marker}]},
                    {"role":"assistant","items":[{"kind":"text","text":assistant_marker}]}
                ]),
                "codex" => json!([
                    {"items":[{"type":"userMessage","content":[{"type":"input_text","text":user_marker}]}]},
                    {"items":[{"type":"agentMessage","text":assistant_marker}]}
                ]),
                "opencode" => json!([
                    {"role":"user","items":[{"kind":"text","text":user_marker}]},
                    {"role":"assistant","items":[{"kind":"text","text":assistant_marker}]}
                ]),
                _ => unreachable!(),
            };
            let history = json!({
                "threadId":native_id,
                "provider":provider,
                "summary":"synthetic managed search fixture",
                "turns":turns,
                "extensions":{
                    provider:{
                        "nativeHistoryActivity":{"at":1791712801000i64},
                        "nativeHistoryRetention":{"partial":provider == "opencode","omittedNativeTurns":1,"omittedItems":0,"omittedBodies":0}
                    }
                },
                "managedDirectory":{
                    "incarnationId":view.incarnation_id,
                    "cwd":cwd,
                    "gitCommonDir":format!("{cwd}/.git"),
                    "sessionType":session_type
                }
            });
            assert_eq!(
                history["extensions"][provider]["nativeHistoryRetention"]["partial"],
                provider == "opencode",
                "{provider} retention fixture"
            );
            history_overrides.insert(native_id.to_string(), history);
        }
        let backend = Arc::new(NativeBackend {
            history_overrides,
            ..Default::default()
        });
        let (socket, control) = start_control(root.path(), registry, backend.clone()).await;
        let app = Router::new()
            .route(
                "/api/session-directory",
                axum::routing::get(session_directory),
            )
            .with_state(directory_state(web.path()))
            .layer(axum::Extension(Cache::default()))
            .layer(axum::Extension(RuntimeClient::new(
                socket,
                "test-control-secret",
            )));

        for (provider, _, _) in providers {
            let user_marker = format!("managed-user-{provider}-marker");
            let assistant_marker = format!("managed-assistant-{provider}-marker");
            let users = directory_query(
                app.clone(),
                &format!("&query={user_marker}&tier=userMessages"),
            )
            .await;
            assert_eq!(users["items"][0]["matchedIn"], "userMessage", "{provider}");
            assert!(users["items"][0]["snippet"]
                .as_str()
                .unwrap()
                .contains(&user_marker));
            assert!(!users["items"][0].to_string().contains(&assistant_marker));
            assert!(users["items"][0].get("managedSearchMessages").is_none());
            assert!(
                users.get("partial").is_some(),
                "OpenCode retention omits native history, so every directory-wide content search must disclose partial results: {provider}"
            );

            let full_text = directory_query(
                app.clone(),
                &format!("&query={assistant_marker}&tier=fullText"),
            )
            .await;
            assert_eq!(
                full_text["items"][0]["matchedIn"], "assistantMessage",
                "{provider}"
            );
            assert!(full_text["items"][0]["snippet"]
                .as_str()
                .unwrap()
                .contains(&assistant_marker));
            assert!(!full_text["items"][0].to_string().contains(&user_marker));
            assert!(full_text["items"][0].get("managedSearchMessages").is_none());
            assert!(full_text.get("partial").is_some());

            let assistant_only = directory_query(
                app.clone(),
                &format!("&query={assistant_marker}&tier=userMessages"),
            )
            .await;
            assert!(
                assistant_only["items"].as_array().unwrap().is_empty(),
                "{provider}"
            );
            assert!(assistant_only.get("partial").is_some());
        }
        assert_eq!(backend.reads.load(std::sync::atomic::Ordering::SeqCst), 3);
        control.abort();
    }

    #[tokio::test]
    async fn managed_directory_discovers_first_saved_turn_before_negative_cache_expires() {
        use std::io::Write;

        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let provider_home = root.path().join("provider");
        let native_id = "63333000-0000-4333-8333-000000000275";
        let folder = provider_home.join(".claude/projects/fixture");
        std::fs::create_dir_all(&folder).unwrap();
        let transcript = folder.join(format!("{native_id}.jsonl"));
        let metadata = json!({"type":"system","subtype":"init","sessionId":native_id,"cwd":"/workspace","timestamp":"2026-10-11T10:00:00Z"});
        std::fs::write(&transcript, format!("{metadata}\n")).unwrap();
        let cwd = root.path().to_str().unwrap();
        let (registry, view) = register(root.path(), "claude", "freshclaude", native_id, cwd).await;
        let inventory_before = serde_json::to_value(registry.inventory().await.unwrap()).unwrap();
        let launch_before = serde_json::to_value(
            registry
                .recovery_context(view.soul_id.clone())
                .await
                .unwrap()
                .prior_handle
                .fresh_agent(),
        )
        .unwrap();
        let backend = Arc::new(NativeBackend {
            history_home: Some(provider_home),
            ..Default::default()
        });
        let (socket, control) = start_control(root.path(), registry.clone(), backend.clone()).await;
        let cache = Cache::default();
        // Use the production HTTP handler with an owned cache so the unexpired
        // decision window is observable without an extra request or a sleep.
        let app = Router::new()
            .route(
                "/api/session-directory",
                axum::routing::get(session_directory),
            )
            .with_state(directory_state(web.path()))
            .layer(axum::Extension(cache.clone()))
            .layer(axum::Extension(RuntimeClient::new(
                socket,
                "test-control-secret",
            )));
        let initial = directory_page(app.clone()).await;
        let initial_reads = backend.reads.load(std::sync::atomic::Ordering::SeqCst);
        let initial_negative = {
            let cached = cache.0.lock().await;
            let entry = cached.entries.values().next().unwrap();
            cached.entries.len() == 1 && entry.item.is_none() && !entry.refresh_succeeded
        };
        let mut saved = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        for record in claude_fixture_records(native_id) {
            writeln!(saved, "{record}").unwrap();
        }
        drop(saved);
        let negative_attempt = {
            let mut cached = cache.0.lock().await;
            let entry = cached.entries.values_mut().next().unwrap();
            // Keep setup delays out of the causal assertion. An overrun during
            // the actual request still fails the unexpired-window precondition.
            entry.attempted_at = Instant::now();
            entry.attempted_at
        };
        let refreshed = directory_page(app).await;
        let request_age = negative_attempt.elapsed();
        let final_reads = backend.reads.load(std::sync::atomic::Ordering::SeqCst);
        let turn_counts = backend.turn_counts.lock().unwrap().clone();
        let inventory_after = serde_json::to_value(registry.inventory().await.unwrap()).unwrap();
        let launch_after = serde_json::to_value(
            registry
                .recovery_context(view.soul_id)
                .await
                .unwrap()
                .prior_handle
                .fresh_agent(),
        )
        .unwrap();
        control.abort();
        let _ = control.await;

        assert!(initial["items"].as_array().unwrap().is_empty());
        assert_eq!(initial["partial"], true);
        assert_eq!(initial_reads, 1);
        assert_eq!(
            turn_counts.first(),
            Some(&0),
            "initial native store is valid and zero-turn"
        );
        assert!(initial_negative, "initial read must cache no presentation");
        assert!(
            request_age < PRESENTATION_TTL,
            "setup failed: request exceeded negative TTL"
        );
        assert_eq!(
            inventory_after, inventory_before,
            "ownership must remain unchanged"
        );
        assert_eq!(
            launch_after, launch_before,
            "same owned store, profile and UID"
        );
        assert_eq!(
            final_reads, 2,
            "next original request must reread the owned store"
        );
        assert_eq!(
            turn_counts,
            [0, 2],
            "real native reader sees the first completed turn"
        );
        let rows = refreshed["items"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "{refreshed}");
        assert_eq!(rows[0]["provider"], "claude");
        assert_eq!(rows[0]["sessionId"], native_id);
        assert_eq!(rows[0]["sessionType"], "freshclaude");
        assert_eq!(rows[0]["cwd"], cwd);
        assert_eq!(rows[0]["projectPath"], cwd);
        assert_eq!(rows[0]["isRunning"], true);
        assert_eq!(rows[0]["title"], "Saved managed request");
        assert!(refreshed.get("partial").is_none());
        assert!(refreshed.get("integrityError").is_none());
    }

    #[tokio::test]
    async fn managed_directory_timeout_advances_past_dispatched_souls() {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let provider_home = root.path().join("provider");
        let registry = Registry::open(root.path(), None).unwrap();
        let mut views = Vec::new();
        for ordinal in 0..5 {
            let native_id = format!("63333000-0000-4333-8333-000000001{ordinal:03}");
            native_fixture(&provider_home, "claude", &native_id);
            views.push(
                register_in(
                    &registry,
                    root.path(),
                    "claude",
                    "freshclaude",
                    &native_id,
                    root.path().to_str().unwrap(),
                )
                .await,
            );
        }
        views.sort_by(|a, b| a.soul_id.cmp(&b.soul_id));
        let later_id = views.last().unwrap().native_session_id.as_deref().unwrap();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (socket, control) = start_control(
            root.path(),
            registry,
            Arc::new(NativeBackend {
                history_home: Some(provider_home),
                mismatch: false,
                reads: reads.clone(),
                slow_souls: views
                    .iter()
                    .take(4)
                    .map(|view| view.soul_id.clone())
                    .collect(),
                ..Default::default()
            }),
        )
        .await;
        let app = router(directory_state(web.path())).layer(axum::Extension(RuntimeClient::new(
            socket,
            "test-control-secret",
        )));
        let initial = directory_page(app.clone()).await;
        assert!(initial["items"].as_array().unwrap().is_empty());
        assert_eq!(initial["partial"], true);
        assert_eq!(
            reads.load(std::sync::atomic::Ordering::SeqCst),
            4,
            "deadline holds the per-request concurrency bound"
        );
        let refreshed = directory_page(app).await;
        assert_eq!(
            refreshed["items"][0]["sessionId"], later_id,
            "the next request must advance beyond timed-out reads"
        );
        assert_eq!(refreshed["partial"], true);
        control.abort();
    }

    #[tokio::test]
    async fn managed_directory_retains_partial_after_failed_refresh_on_warm_requests() {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let provider_home = root.path().join("provider");
        let native_id = "63333000-0000-4333-8333-000000000212";
        native_fixture(&provider_home, "claude", native_id);
        let (registry, _) = register(
            root.path(),
            "claude",
            "freshclaude",
            native_id,
            root.path().to_str().unwrap(),
        )
        .await;
        let (socket, control) = start_control(
            root.path(),
            registry,
            Arc::new(NativeBackend {
                history_home: Some(provider_home.clone()),
                mismatch: false,
                ..Default::default()
            }),
        )
        .await;
        let app = router(directory_state(web.path())).layer(axum::Extension(RuntimeClient::new(
            socket,
            "test-control-secret",
        )));
        let initial = directory_page(app.clone()).await;
        assert!(initial.get("partial").is_none());
        tokio::time::sleep(PRESENTATION_TTL + Duration::from_millis(30)).await;
        std::fs::write(
            provider_home
                .join(".claude/projects/fixture")
                .join(format!("{native_id}.jsonl")),
            "{malformed",
        )
        .unwrap();
        for _ in 0..2 {
            let failed = directory_page(app.clone()).await;
            assert_eq!(
                failed["items"][0]["sessionId"], native_id,
                "last known presentation survives failed refresh"
            );
            assert_eq!(
                failed["partial"], true,
                "warm failed-refresh state must remain truthful"
            );
        }
        control.abort();
    }

    #[tokio::test]
    async fn managed_directory_discovers_beyond_read_cap_across_expired_refresh_and_pages() {
        check_discovery_progress(false).await;
    }

    #[tokio::test]
    async fn managed_directory_unreadable_first_batch_cannot_starve_later_history() {
        check_discovery_progress(true).await;
    }

    async fn check_discovery_progress(unreadable_first_batch: bool) {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let provider_home = root.path().join("provider");
        let registry = Registry::open(root.path(), None).unwrap();
        let mut views = Vec::new();
        for ordinal in 0..51 {
            let native_id = format!("63333000-0000-4333-8333-{ordinal:012}");
            views.push(
                register_in(
                    &registry,
                    root.path(),
                    "claude",
                    "freshclaude",
                    &native_id,
                    root.path().to_str().unwrap(),
                )
                .await,
            );
        }
        views.sort_by(|a, b| a.soul_id.cmp(&b.soul_id));
        let newest_id = views.last().unwrap().native_session_id.as_deref().unwrap();
        for view in &views {
            let native_id = view.native_session_id.as_deref().unwrap();
            if !unreadable_first_batch || native_id == newest_id {
                native_fixture(&provider_home, "claude", native_id);
            }
        }
        let newest_file = provider_home
            .join(".claude/projects/fixture")
            .join(format!("{newest_id}.jsonl"));
        let records = std::fs::read_to_string(&newest_file)
            .unwrap()
            .replace("2026-10-11T10:00:00Z", "2026-10-12T10:00:00Z")
            .replace("2026-10-11T10:00:01Z", "2026-10-12T10:00:01Z")
            .replace("Saved managed request", "Newest late discovered request");
        std::fs::write(newest_file, records).unwrap();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (socket, control) = start_control(
            root.path(),
            registry,
            Arc::new(NativeBackend {
                history_home: Some(provider_home),
                mismatch: false,
                reads: reads.clone(),
                ..Default::default()
            }),
        )
        .await;
        let app = router(directory_state(web.path())).layer(axum::Extension(RuntimeClient::new(
            socket,
            "test-control-secret",
        )));
        let initial = directory_page(app.clone()).await;
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 50);
        assert_eq!(initial["partial"], true);
        assert!(!initial["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["sessionId"] == newest_id));
        tokio::time::sleep(PRESENTATION_TTL + Duration::from_millis(30)).await;
        let refreshed = directory_page(app.clone()).await;
        assert_eq!(
            refreshed["items"][0]["sessionId"], newest_id,
            "ordinary refresh must discover the later, newest native root"
        );
        assert!(reads.load(std::sync::atomic::Ordering::SeqCst) <= 100);
        if unreadable_first_batch {
            assert_eq!(refreshed["partial"], true);
            assert_eq!(refreshed["items"].as_array().unwrap().len(), 1);
        } else {
            let cursor = refreshed["nextCursor"]
                .as_str()
                .expect("discovered inventory must support normal paging");
            let second_page = directory_query(app.clone(), &format!("&cursor={cursor}")).await;
            assert_eq!(second_page["items"].as_array().unwrap().len(), 1);
            assert_eq!(second_page["nextCursor"], Value::Null);
            let mut ids = refreshed["items"]
                .as_array()
                .unwrap()
                .iter()
                .chain(second_page["items"].as_array().unwrap())
                .map(|row| row["sessionId"].as_str().unwrap())
                .collect::<Vec<_>>();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), 51);
            assert!(second_page.get("partial").is_none());
        }
        let search = directory_query(app, "&query=Newest&tier=title").await;
        assert_eq!(search["items"].as_array().unwrap().len(), 1);
        assert_eq!(search["items"][0]["sessionId"], newest_id);
        control.abort();
    }

    #[tokio::test]
    async fn managed_directory_keeps_one_current_row_after_owned_replacement() {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let provider_home = root.path().join("provider");
        let native_id = "63333000-0000-4333-8333-000000000210";
        native_fixture(&provider_home, "claude", native_id);
        let (registry, old) = register(
            root.path(),
            "claude",
            "freshclaude",
            native_id,
            root.path().to_str().unwrap(),
        )
        .await;
        let (socket, control) = start_control(
            root.path(),
            registry.clone(),
            Arc::new(NativeBackend {
                history_home: Some(provider_home),
                mismatch: false,
                ..Default::default()
            }),
        )
        .await;
        let app = router(directory_state(web.path())).layer(axum::Extension(RuntimeClient::new(
            socket,
            "test-control-secret",
        )));
        let original = directory_page(app.clone()).await;
        assert_eq!(original["items"][0]["sessionId"], native_id);
        assert_eq!(original["items"][0]["isRunning"], true);
        let fence = registry
            .recovery_context(old.soul_id.clone())
            .await
            .unwrap()
            .write_fence();
        let recovery = registry
            .begin_recovery_fenced(
                old.soul_id.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
                fence,
            )
            .await
            .unwrap();
        let agent = recovery.context.prior_handle.fresh_agent().unwrap().clone();
        registry
            .mark_stop_outcome(old.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let replacement = registry
            .prepare_replacement(
                recovery,
                None,
                Some(agent),
                None,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        start_registered(
            &registry,
            root.path(),
            &old.soul_id,
            replacement.prepared.incarnation_id.clone(),
            native_id,
        )
        .await;
        let inventory = registry.inventory().await.unwrap();
        assert_eq!(inventory.len(), 2);
        assert_eq!(
            inventory
                .iter()
                .find(|v| v.incarnation_id == old.incarnation_id)
                .unwrap()
                .launch_state,
            LaunchState::Stopped
        );
        assert_eq!(
            registry
                .recovery_context(old.soul_id.clone())
                .await
                .unwrap()
                .prior_handle
                .incarnation_id(),
            &replacement.prepared.incarnation_id
        );
        for stopping in [false, true] {
            if stopping {
                registry.begin_stop(old.soul_id.clone()).await.unwrap();
            }
            let page = directory_page(app.clone()).await;
            let rows = page["items"].as_array().unwrap();
            assert_eq!(
                rows.len(),
                1,
                "one saved store/root must remain visible after replacement: {page}"
            );
            assert_eq!(rows[0]["sessionId"], native_id);
            assert_eq!(rows[0]["sessionType"], "freshclaude");
            assert_eq!(rows[0]["isRunning"], !stopping);
            assert!(page.get("integrityError").is_none(), "{page}");
        }
        control.abort();
    }

    #[tokio::test]
    async fn managed_directory_quarantines_distinct_owned_stores_with_same_native_identity() {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let provider_home = root.path().join("provider");
        let native_id = "63333000-0000-4333-8333-000000000211";
        native_fixture(&provider_home, "claude", native_id);
        let (registry, first) = register(
            root.path(),
            "claude",
            "freshclaude",
            native_id,
            root.path().to_str().unwrap(),
        )
        .await;
        let second = register_in(
            &registry,
            root.path(),
            "claude",
            "freshclaude",
            native_id,
            root.path().to_str().unwrap(),
        )
        .await;
        assert_ne!(first.soul_id, second.soul_id);
        let (socket, control) = start_control(
            root.path(),
            registry,
            Arc::new(NativeBackend {
                history_home: Some(provider_home),
                mismatch: false,
                ..Default::default()
            }),
        )
        .await;
        let page = directory_page(router(directory_state(web.path())).layer(axum::Extension(
            RuntimeClient::new(socket, "test-control-secret"),
        )))
        .await;
        assert!(page["items"].as_array().unwrap().is_empty(), "{page}");
        assert_eq!(page["integrityError"]["collisionCount"], 1);
        assert_eq!(page["partial"], true);
        control.abort();
    }

    #[tokio::test]
    async fn managed_directory_keeps_history_from_non_git_workspace() {
        let root = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        let provider_home = root.path().join("provider");
        let native_id = "63333000-0000-4333-8333-000000000188";
        native_fixture(&provider_home, "codex", native_id);
        let workspace = root.path().join("ordinary-folder");
        std::fs::create_dir_all(&workspace).unwrap();
        let cwd = workspace.to_str().unwrap();
        let (registry, view) = register(root.path(), "codex", "freshcodex", native_id, cwd).await;
        let (socket, control) = start_control(
            root.path(),
            registry,
            Arc::new(NativeBackend {
                history_home: Some(provider_home),
                ..Default::default()
            }),
        )
        .await;
        let client = RuntimeClient::new(socket, "test-control-secret");
        let saved = client.fresh_agent_history(view.soul_id).await.unwrap();
        assert!(!saved["turns"].as_array().unwrap().is_empty());
        let page =
            directory_page(router(directory_state(web.path())).layer(axum::Extension(client)))
                .await;
        control.abort();
        let row = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["sessionId"] == native_id)
            .expect("saved managed history from an ordinary folder must remain discoverable");
        assert_eq!(row["projectPath"], cwd);
        assert_eq!(row["cwd"], cwd);
    }

    #[tokio::test]
    async fn managed_history_directory_reads_owned_native_store_with_empty_web_home() {
        for (provider, session_type) in [
            ("claude", "freshclaude"),
            ("kilroy", "kilroy"),
            ("codex", "freshcodex"),
            ("opencode", "freshopencode"),
        ] {
            for stopped in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let web = tempfile::tempdir().unwrap();
                let provider_home = root.path().join("provider");
                let native_id = "63333000-0000-4333-8333-000000000187";
                native_fixture(&provider_home, provider, native_id);
                let project = root.path().join("project");
                let gitdir = project.join(".git/worktrees/managed");
                let cwd = root.path().join("checkout");
                std::fs::create_dir_all(&gitdir).unwrap();
                std::fs::create_dir_all(&cwd).unwrap();
                std::fs::write(cwd.join(".git"), format!("gitdir: {}\n", gitdir.display()))
                    .unwrap();
                std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
                let cwd = cwd.to_str().unwrap();
                let (registry, view) =
                    register(root.path(), provider, session_type, native_id, cwd).await;
                if stopped {
                    registry.begin_stop(view.soul_id.clone()).await.unwrap();
                }
                let (socket, control) = start_control(
                    root.path(),
                    registry,
                    Arc::new(NativeBackend {
                        history_home: Some(provider_home),
                        mismatch: false,
                        ..Default::default()
                    }),
                )
                .await;
                let client = RuntimeClient::new(socket, "test-control-secret");
                let saved = client
                    .fresh_agent_history(view.soul_id.clone())
                    .await
                    .unwrap();
                assert_eq!(saved["threadId"], native_id);
                assert!(!saved["turns"].as_array().unwrap().is_empty(), "{provider}");
                let page = directory_page(
                    router(directory_state(web.path())).layer(axum::Extension(client)),
                )
                .await;
                control.abort();
                let row = page["items"].as_array().unwrap().iter().find(|v| {
                    v["provider"]
                        == if provider == "kilroy" {
                            "claude"
                        } else {
                            provider
                        }
                        && v["sessionId"] == native_id
                });
                assert!(row.is_some(), "completed owned native root missing from actual session directory: {provider} {page}");
                let row = row.unwrap();
                assert_eq!(row["cwd"], cwd);
                assert_eq!(row["projectPath"], project.to_str().unwrap());
                assert_eq!(row["checkoutPath"], cwd);
                assert_eq!(row["sessionType"], session_type);
                assert_eq!(row["isRunning"], !stopped);
                assert!(row.get("isNonInteractive").is_none());
            }
        }
    }
    #[tokio::test]
    async fn managed_directory_refuses_missing_unreadable_and_mismatched_identity_without_hiding_local_rows(
    ) {
        use freshell_sessions::directory_index::ClaudeSource;
        for fault in [
            "missing_identity",
            "missing_store",
            "malformed_store",
            "mismatched_root",
            "local_collision",
        ] {
            let root = tempfile::tempdir().unwrap();
            let web = tempfile::tempdir().unwrap();
            let provider_home = root.path().join("provider");
            let native_id = "63333000-0000-4333-8333-000000000187";
            let local_id = "63333000-0000-4333-8333-000000000188";
            native_fixture(&provider_home, "claude", native_id);
            native_fixture(web.path(), "claude", local_id);
            if fault == "local_collision" {
                native_fixture(web.path(), "claude", native_id);
            }
            if fault == "missing_store" {
                std::fs::remove_file(
                    provider_home
                        .join(".claude/projects/fixture")
                        .join(format!("{native_id}.jsonl")),
                )
                .unwrap();
            }
            if fault == "malformed_store" {
                std::fs::write(
                    provider_home
                        .join(".claude/projects/fixture")
                        .join(format!("{native_id}.jsonl")),
                    "{malformed",
                )
                .unwrap();
            }
            let (registry, view) = register(
                root.path(),
                "claude",
                "freshclaude",
                native_id,
                root.path().to_str().unwrap(),
            )
            .await;
            if fault == "missing_identity" {
                rusqlite::Connection::open(root.path().join("runtime.sqlite3"))
                    .unwrap()
                    .execute(
                        "UPDATE souls SET native_session_id=NULL WHERE soul_id=?1",
                        [view.soul_id.as_str()],
                    )
                    .unwrap();
            }
            let (socket, control) = start_control(
                root.path(),
                registry.clone(),
                Arc::new(NativeBackend {
                    history_home: Some(provider_home),
                    mismatch: fault == "mismatched_root",
                    ..Default::default()
                }),
            )
            .await;
            let client = RuntimeClient::new(socket, "test-control-secret");
            let mut state = directory_state(web.path());
            state.session_index = Some(Arc::new(SessionIndex::with_ttl_and_cache_path(
                vec![Arc::new(ClaudeSource::new(web.path().join(".claude")))],
                Duration::from_secs(1),
                None,
            )));
            let app = router(state).layer(axum::Extension(client));
            use axum::{
                body::{to_bytes, Body},
                http::Request,
            };
            let response = app.oneshot(Request::builder().uri("/api/session-directory?surface=history&priority=visible&includeNonInteractive=true").header("x-auth-token","tok").body(Body::empty()).unwrap()).await.unwrap();
            let page: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            control.abort();
            let rows = page["items"].as_array().unwrap();
            assert!(
                rows.iter().any(|row| row["sessionId"] == local_id),
                "healthy local row hidden: {fault} {page}"
            );
            assert!(
                !rows.iter().any(|row| row["sessionId"] == native_id),
                "invalid or ambiguous managed row invented: {fault} {page}"
            );
            assert_eq!(page["partial"], true, "{fault}");
            let current = registry.inventory().await.unwrap();
            assert_eq!(current[0].desired_state, DesiredState::Running);
            assert_ne!(current[0].recovery_state, RecoveryState::Lost);
        }
    }
}
