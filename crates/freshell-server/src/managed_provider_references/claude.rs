//! Finite original Claude source selection and ordinary first-volume authority.
use freshell_platform::provider_input_profiles::{MAX_SOURCE_EVENTS, MAX_SOURCE_EVENT_BYTES};
use freshell_runtime_protocol::*;
use std::path::Path;

pub(crate) struct ClaudePreparation<'a> {
    pub client: &'a freshell_runtime_client::RuntimeClient,
    pub soul: &'a SoulId,
    pub creation_seed: &'a str,
    pub native_source_runtime: freshell_platform::claude_inputs::NativeSourceRuntime,
    pub reservation_provider: &'a str,
    pub selected_settings: Option<&'a str>,
    pub home: &'a Path,
    pub cwd: &'a Path,
    pub workspace: &'a Path,
    pub git_common_dir: Option<&'a Path>,
    pub original: &'a (dyn Fn(&str) -> Option<String> + Sync),
    pub args: &'a [String],
    pub plugins: &'a [String],
    pub references: &'a [ProviderSecretReference],
}

pub(crate) async fn prepare_managed(
    request: ClaudePreparation<'_>,
) -> Result<ProviderLaunchContext, String> {
    if !matches!(request.reservation_provider, "claude" | "kilroy") {
        return Err("Claude source preparation requires its exact supported runtime flavor".into());
    }
    let inline_settings = request.selected_settings.filter(|value| {
        freshell_platform::claude_inputs::is_inline_settings(value)
            && !freshell_platform::cli_launch::is_owned_claude_settings(value)
    });
    if inline_settings.is_some_and(|value| {
        value.len() > freshell_platform::claude_inputs::MAX_NATIVE_SETTINGS_BYTES
    }) {
        return Err("Claude inline --settings exceeds native 2 MiB limit".into());
    }
    let mut plugin_dirs = Vec::new();
    let mut path_bytes = 0usize;
    let cli = request
        .args
        .windows(2)
        .filter(|pair| pair[0] == "--plugin-dir")
        .map(|pair| pair[1].as_str());
    for selected in cli.chain(request.plugins.iter().map(String::as_str)) {
        let path = Path::new(selected);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            request.cwd.join(path)
        };
        if plugin_dirs.contains(&path) {
            continue;
        }
        path_bytes = path_bytes
            .checked_add(path.as_os_str().len())
            .ok_or("Claude plugin source metadata overflow")?;
        if plugin_dirs.len() >= MAX_SOURCE_EVENTS || path_bytes > MAX_SOURCE_EVENT_BYTES {
            return Err("Claude plugin source event metadata profile exceeded".into());
        }
        plugin_dirs.push(path);
    }
    let mut manifest = freshell_platform::claude_inputs::ClaudeInputManifest {
        version: 1,
        accepted_native_plan: None,
        native_source_runtime: Some(request.native_source_runtime),
        original_home: request.home.into(),
        cwd: request.cwd.into(),
        workspace: request.workspace.into(),
        config_root: Some(selected_config_root(
            request.home,
            request.cwd,
            request.original,
        )?),
        settings_file: selected_settings_file(request.cwd, request.selected_settings)?,
        settings_origin: None,
        inline_settings_sha256: inline_settings.map(|value| {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(value.as_bytes()))
        }),
        setting_sources: request
            .args
            .windows(2)
            .rfind(|pair| pair[0] == "--setting-sources")
            .map(|pair| freshell_platform::claude_inputs::parse_setting_sources(&pair[1]))
            .transpose()
            .map_err(str::to_string)?
            .unwrap_or_else(freshell_platform::claude_inputs::default_setting_sources),
        plugin_dirs,
    };
    manifest.validate().map_err(str::to_string)?;
    let context = ProviderLaunchContext {
        preparation: ProviderPreparation::Claude {
            mcp_args: vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()],
        },
        config: vec![],
        mcp_capability: None,
        prepared_inputs: None,
    };
    let reservation = request
        .client
        .reserve_provider_inputs(
            request.soul.clone(),
            request.reservation_provider.into(),
            request.creation_seed.into(),
        )
        .await
        .map_err(|error| error.to_string())?;
    if reservation.provider != request.reservation_provider
        || &reservation.soul_id != request.soul
        || reservation.creation_seed_ref != request.creation_seed
    {
        return Err("Claude selected resource reservation does not match this creation".into());
    }
    let observation_request = freshell_platform::claude_inputs::observation::ObservationRequest {
        version: 1,
        request_id: uuid::Uuid::new_v4().to_string(),
        native_source_runtime: request.native_source_runtime,
        cwd: std::fs::canonicalize(request.cwd)
            .map_err(|_| "Claude native cwd is unavailable; retain inputs and reprepare")?,
        home: "/home/freshell/provider".into(),
        setting_sources: manifest.setting_sources.clone(),
        selector_manifest_sha256: {
            use sha2::{Digest, Sha256};
            let bytes = bounded_json_bytes(&manifest, 64 * 1024 * 1024)
                .map_err(|_| "Claude selector metadata exceeds its finite profile")?;
            format!("{:x}", Sha256::digest(bytes))
        },
        plan_revision: 0,
        candidate_binding: None,
    };
    let observation_request_sha256 = {
        use sha2::{Digest, Sha256};
        let bytes = bounded_json_bytes(
            &observation_request,
            freshell_platform::claude_inputs::observation::MAX_REQUEST_BYTES,
        )
        .map_err(|_| "Claude source request exceeds its finite profile")?;
        format!("{:x}", Sha256::digest(bytes))
    };
    let observation = request
        .client
        .observe_claude_sources(ObserveClaudeSourcesRequest {
            expected_control_epoch: None,
            soul_id: request.soul.clone(),
            provider: request.reservation_provider.into(),
            authority: ClaudeSourceAuthority::InitialReservation {
                reservation_id: reservation.reservation_id.clone(),
            },
            workspace_path: request
                .workspace
                .to_str()
                .ok_or("Claude workspace is not UTF-8; retain inputs and reprepare")?
                .into(),
            git_common_dir: request
                .git_common_dir
                .map(|path| {
                    path.to_str().map(str::to_owned).ok_or(
                        "Claude git common directory is not UTF-8; retain inputs and reprepare",
                    )
                })
                .transpose()?,
            candidate: None,
            observation_request: observation_request.clone(),
        })
        .await
        .map_err(|_| "Claude native source evidence is unavailable; retain inputs and reprepare")?;
    observation.validate_for_request(&observation_request, &observation_request_sha256)?;
    manifest.accepted_native_plan =
        Some(freshell_platform::claude_inputs::AcceptedNativeSourcePlan {
            selector_manifest_sha256: observation_request.selector_manifest_sha256,
            plan_revision: observation_request.plan_revision,
            observation: observation.observation.clone(),
        });
    crate::managed_mcp_capability::issue_prepared_provider_context(
        "claude",
        request.soul,
        request.home,
        &context,
        crate::managed_mcp_capability::OpencodeEphemeralInput {
            claude_manifest: Some(&manifest),
            claude_observation: Some(&observation.observation),
            claude_inline_settings: inline_settings,
            cwd: Some(request.cwd),
            workspace: Some(request.workspace),
            secret_references: Some(request.references),
            initial_auth_reservation: Some(&reservation.reservation_id),
            ..Default::default()
        },
    )
}

fn selected_settings_file(
    cwd: &Path,
    selected: Option<&str>,
) -> Result<Option<std::path::PathBuf>, String> {
    let Some(value) =
        selected.filter(|value| !freshell_platform::cli_launch::is_owned_claude_settings(value))
    else {
        return Ok(None);
    };
    if freshell_platform::claude_inputs::is_inline_settings(value) {
        return Ok(None);
    }
    if value.len() > 64 * 1024 || value.chars().any(char::is_control) {
        return Err("Claude selected settings path profile is invalid".into());
    }
    let path = Path::new(value);
    let logical = freshell_platform::opencode_config::lexical_path(&if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    });
    std::fs::canonicalize(&logical).map(|_| Some(logical.clone())).map_err(|error| {
        tracing::warn!(event="provider.inputs.preparation.blocked",provider="claude",stage="controller",operation="select_explicit_settings",field="--settings",cwd=%cwd.display(),cause=%error,
            "Selected Claude settings source is unavailable");
        format!("Claude --settings selected file is unavailable: {error}; select an existing settings file or valid inline JSON")
    })
}

fn selected_config_root(
    home: &Path,
    cwd: &Path,
    original: &dyn Fn(&str) -> Option<String>,
) -> Result<std::path::PathBuf, String> {
    use unicode_normalization::UnicodeNormalization;
    let selected = original("CLAUDE_CONFIG_DIR").map(Ok).unwrap_or_else(|| {
        home.join(".claude")
            .to_str()
            .map(str::to_owned)
            .ok_or("Claude original configuration directory is not UTF-8")
    })?;
    if selected.len() > 64 * 1024 || selected.chars().any(char::is_control) {
        return Err("Claude selected configuration directory profile is invalid".into());
    }
    let mut normalized = String::new();
    for character in selected.nfc() {
        if normalized.len() + character.len_utf8() > 64 * 1024 {
            return Err("Claude normalized configuration directory profile exceeded".into());
        }
        normalized.push(character);
    }
    let path = Path::new(&normalized);
    Ok(freshell_platform::opencode_config::lexical_path(
        &if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_provider_claude_initial_source_failure_blocks_before_stage_and_dispatch() {
        use freshell_supervisor::{
            backend::{
                BackendCreated, BackendError, BackendInspection, ClaudeSourceOwner,
                CreateRuntimeSpec, RuntimeBackend,
            },
            registry::{OwnedInputReservation, OwnedRuntimeHandle, Registry},
            service::{serve_control, Supervisor, SupervisorConfig},
        };
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        struct UnavailableSources {
            daemon: DockerDaemonId,
            calls: AtomicUsize,
        }
        #[async_trait::async_trait]
        impl RuntimeBackend for UnavailableSources {
            async fn observe_initial_auth_volume(
                &self,
                _: &OwnedInputReservation,
            ) -> Result<InitialAuthVolumeObservation, BackendError> {
                Ok(InitialAuthVolumeObservation::Absent {
                    daemon_id: self.daemon.clone(),
                })
            }
            async fn observe_claude_sources(
                &self,
                owner: &ClaudeSourceOwner,
                request: &ObserveClaudeSourcesRequest,
                _: &str,
            ) -> Result<freshell_platform::claude_inputs::observation::ObservationReply, BackendError>
            {
                assert!(matches!(owner, ClaudeSourceOwner::Initial { .. }));
                assert_eq!(request.provider, "claude");
                assert_eq!(
                    request.observation_request.native_source_runtime,
                    freshell_platform::claude_inputs::NativeSourceRuntime::Terminal
                );
                assert_eq!(
                    request.observation_request.setting_sources,
                    vec![freshell_platform::claude_inputs::ClaudeSettingSource::Local]
                );
                self.calls.fetch_add(1, Ordering::SeqCst);
                Err(BackendError::Unavailable(
                    "synthetic fixed reader unavailable".into(),
                ))
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
            async fn inspect(
                &self,
                _: &OwnedRuntimeHandle,
            ) -> Result<BackendInspection, BackendError> {
                unreachable!()
            }
            async fn request_stop(
                &self,
                _: &OwnedRuntimeHandle,
                _: u64,
            ) -> Result<(), BackendError> {
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
            async fn read_limits(
                &self,
                _: &OwnedRuntimeHandle,
            ) -> Result<RuntimeLimits, BackendError> {
                unreachable!()
            }
            async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
                unreachable!()
            }
        }
        let owned = tempfile::tempdir().unwrap();
        let binary = owned.path().join("host");
        std::fs::write(&binary, "synthetic immutable host artifact").unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let selected = home.join(".claude/settings.json");
        let private = br#"{"env":{"SYNTHETIC_PRIVATE":"preserve-original-source"}}"#;
        std::fs::write(&selected, private).unwrap();
        let registry = Registry::open(owned.path().join("registry"), None).unwrap();
        let backend = Arc::new(UnavailableSources {
            daemon: DockerDaemonId::new(),
            calls: AtomicUsize::new(0),
        });
        let socket = owned.path().join("control.sock");
        let plugins = (0..5000)
            .map(|index| {
                workspace
                    .join(format!("selected-plugin-{index:04}-{}", "x".repeat(40)))
                    .to_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert!(
            plugins.iter().map(String::len).sum::<usize>()
                > freshell_platform::claude_inputs::observation::MAX_REQUEST_BYTES
        );
        assert!(plugins.iter().map(String::len).sum::<usize>() < MAX_SOURCE_EVENT_BYTES);
        let supervisor = Supervisor::new(
            registry.clone(),
            backend.clone(),
            SupervisorConfig {
                runtime_root: owned.path().join("runtime"),
                control_socket_path: socket.clone(),
                host_binary_path: binary,
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "synthetic-source-unavailable".into(),
                control_secret: "synthetic-control-secret".into(),
                lifecycle_log: owned.path().join("lifecycle.jsonl"),
                admission: freshell_supervisor::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap();
        let task = tokio::spawn({
            let socket = socket.clone();
            async move { serve_control(supervisor, &socket).await }
        });
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !socket.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            let client = freshell_runtime_client::RuntimeClient::new(
                socket.clone(),
                "synthetic-control-secret",
            );
            let soul = SoulId::new();
            prepare_managed(ClaudePreparation {
                client: &client,
                soul: &soul,
                creation_seed: "synthetic-initial-source",
                native_source_runtime:
                    freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
                reservation_provider: "claude",
                selected_settings: None,
                home: &home,
                cwd: &workspace,
                workspace: &workspace,
                git_common_dir: None,
                original: &|_| None,
                args: &["--setting-sources".into(), "local".into()],
                plugins: &plugins,
                references: &[],
            })
            .await
        })
        .await;
        task.abort();
        assert!(
            task.await.unwrap_err().is_cancelled(),
            "join the owned control service before assertions"
        );
        let result =
            result.expect("initial preparation must return within its finite test deadline");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1,
            "authoritative source evidence must be requested before private staging or grant publication");
        let error = result.unwrap_err();
        assert!(error.contains("retain inputs and reprepare"), "{error}");
        assert!(!error.contains("preserve-original-source"));
        assert!(registry.inventory().await.unwrap().is_empty());
        assert_eq!(std::fs::read(selected).unwrap(), private);
    }

    #[test]
    fn managed_provider_claude_settings_lookup_failure_keeps_private_document_out_of_errors_and_logs(
    ) {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::prelude::*;
        #[derive(Clone, Default)]
        struct Capture(Arc<Mutex<std::collections::BTreeMap<String, String>>>);
        impl tracing::field::Visit for Capture {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                self.0
                    .lock()
                    .unwrap()
                    .insert(field.name().into(), format!("{value:?}"));
            }
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                self.0
                    .lock()
                    .unwrap()
                    .insert(field.name().into(), value.into());
            }
        }
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Capture {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                event.record(&mut self.clone());
            }
        }
        let owned = tempfile::tempdir().unwrap();
        let capture = Capture::default();
        let subscriber = tracing_subscriber::registry().with(capture.clone());
        let dispatcher = tracing::Dispatch::new(subscriber);
        let raw = r#"{"env":{"PRIVATE_KEY":"synthetic-private-settings-value"}} trailing"#;
        let error = tracing::dispatcher::with_default(&dispatcher, || {
            selected_settings_file(owned.path(), Some(raw))
        })
        .err()
        .unwrap();
        assert!(
            !error.contains("synthetic-private-settings-value"),
            "failed settings selection must not return raw private input"
        );
        let fields = capture.0.lock().unwrap();
        assert!(
            !fields.is_empty(),
            "selection failure must emit its structured diagnostic"
        );
        assert!(
            !fields
                .values()
                .any(|value| value.contains("synthetic-private-settings-value")),
            "selection failure must not log raw private input"
        );
        assert_eq!(
            fields.get("operation").map(String::as_str),
            Some("select_explicit_settings")
        );
        assert!(fields.contains_key("cause"));
    }

    #[cfg(unix)]
    #[test]
    fn managed_provider_claude_settings_selector_resolves_updated_alias_for_next_preparation() {
        let owned = tempfile::tempdir().unwrap();
        let cwd = owned.path().join("workspace");
        std::fs::create_dir(&cwd).unwrap();
        let first = cwd.join("first-settings.json");
        let second = cwd.join("second-settings.json");
        let alias = cwd.join("selected-settings.json");
        std::fs::write(&first, b"first-source-nonce").unwrap();
        std::fs::write(&second, b"next-source-nonce").unwrap();
        std::os::unix::fs::symlink(&first, &alias).unwrap();
        let selected = selected_settings_file(&cwd, Some("selected-settings.json"))
            .unwrap()
            .unwrap();
        let accepted_snapshot = owned.path().join("accepted-snapshot");
        std::fs::copy(
            std::fs::canonicalize(&selected).unwrap(),
            &accepted_snapshot,
        )
        .unwrap();
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&second, &alias).unwrap();
        // Reissuing from accepted original selectors must resolve the next
        // original choice, while the accepted prior generation stays intact.
        let next_origin = std::fs::canonicalize(&selected).unwrap();
        assert_eq!(std::fs::read(next_origin).unwrap(), b"next-source-nonce");
        assert_eq!(
            std::fs::read(&accepted_snapshot).unwrap(),
            b"first-source-nonce"
        );
        assert_eq!(std::fs::read(&first).unwrap(), b"first-source-nonce");
    }

    #[test]
    fn managed_provider_claude_config_root_keeps_native_cwd_empty_tilde_and_unicode_selection() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace");
        let selected = cwd.join("caf\u{e9}");
        for root in [
            &home.join(".claude"),
            &cwd,
            &selected,
            &cwd.join("~/literal"),
        ] {
            std::fs::create_dir_all(root).unwrap();
            std::fs::write(root.join("resource"), "native-selected-resource").unwrap();
        }
        for selector in [
            None,
            Some(""),
            Some("./caf\u{65}\u{301}"),
            Some("~/literal"),
        ] {
            let original = |_: &str| selector.map(str::to_string);
            let root = selected_config_root(&home, &cwd, &original).unwrap();
            assert_eq!(
                std::fs::read(root.join("resource")).unwrap(),
                b"native-selected-resource"
            );
            if selector == Some("") {
                assert_eq!(root, cwd);
            }
            if selector == Some("~/literal") {
                assert_eq!(root, cwd.join("~/literal"));
            }
        }
        let invalid = |_: &str| Some("bad\npath".into());
        assert!(selected_config_root(&home, &cwd, &invalid).is_err());
        let oversized = |_: &str| Some("a".repeat(64 * 1024 + 1));
        assert!(selected_config_root(&home, &cwd, &oversized).is_err());
    }
}
