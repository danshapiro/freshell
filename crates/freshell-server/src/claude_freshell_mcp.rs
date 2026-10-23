//! The default server's Freshell MCP wiring for freshclaude and kilroy panes
//! (G19, api-hosted-ops plan §2.4): the recipe provider the claude lane asks at
//! every sidecar launch.
//!
//! It reads `settings.codingCli.mcpServer` from the live settings tree each
//! time, so a change from the Settings page applies to the next pane without a
//! restart, and resolves the same Freshell MCP server command the terminal
//! lanes inject (`build_mcp_server_command`, rendered for this host's own CLI).
//! The session host never installs it: a hosted lane keeps its fixed recipe.

use std::sync::Arc;

use freshell_freshagent::claude_freshell_mcp::{
    ClaudeFreshellMcp, ClaudeFreshellMcpProvider, ClaudeFreshellMcpResolution,
};
use freshell_platform::cli_launch::ProviderTarget;
use freshell_platform::mcp_inject::{build_mcp_server_command, McpRuntime};
use freshell_protocol::settings::ServerSettings;
use tokio::sync::RwLock;

/// The CLI a freshclaude sidecar starts runs on this host, natively.
pub(crate) fn host_native_target() -> ProviderTarget {
    if cfg!(windows) {
        ProviderTarget::Windows
    } else {
        ProviderTarget::Unix
    }
}

/// The provider: `Disabled` while the setting is off, otherwise the resolved
/// command, or `Unavailable` with the reason it could not be resolved.
pub(crate) fn claude_mcp_provider(
    settings: Arc<RwLock<ServerSettings>>,
    runtime: Arc<dyn McpRuntime + Send + Sync>,
    target: ProviderTarget,
) -> ClaudeFreshellMcpProvider {
    Arc::new(move || {
        let settings = Arc::clone(&settings);
        let runtime = Arc::clone(&runtime);
        Box::pin(async move {
            if !settings.read().await.agent_mcp_server_enabled() {
                return ClaudeFreshellMcpResolution::Disabled;
            }
            // Resolving can run a short path-conversion helper (WSL); keep it
            // off the async workers.
            let resolved = tokio::task::spawn_blocking(move || {
                build_mcp_server_command(runtime.as_ref(), target)
            })
            .await;
            match resolved {
                Ok(Ok((command, args))) => {
                    ClaudeFreshellMcpResolution::Resolved(ClaudeFreshellMcp { command, args })
                }
                Ok(Err(error)) => ClaudeFreshellMcpResolution::Unavailable(error.to_string()),
                Err(join) => ClaudeFreshellMcpResolution::Unavailable(join.to_string()),
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings_store::{router, SettingsRouterState, SettingsStore};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use freshell_platform::mcp_inject::{McpInjectError, McpServerArg};
    use serde_json::json;
    use std::path::PathBuf;
    use tower::ServiceExt;

    /// An MCP runtime whose server command is a fixed path (or fails).
    struct FixedRuntime(Option<&'static str>);

    impl McpRuntime for FixedRuntime {
        fn tmp_dir(&self) -> PathBuf {
            std::env::temp_dir()
        }
        fn is_wsl_environment(&self) -> bool {
            false
        }
        fn convert_to_windows_path(&self, path: &str) -> String {
            path.to_string()
        }
        fn server_command_args(&self) -> Result<Vec<McpServerArg>, McpInjectError> {
            match self.0 {
                Some(entry) => Ok(vec![McpServerArg::Path(entry.to_string())]),
                None => Err(McpInjectError {
                    message: "Unable to resolve MCP dependency \"tsx\".".into(),
                }),
            }
        }
    }

    /// The real settings route over a real store in a throwaway home.
    fn settings_route(home: &std::path::Path) -> (axum::Router, SettingsStore) {
        std::fs::create_dir_all(home.join(".freshell")).unwrap();
        let store = SettingsStore::load(Some(home), vec!["claude".into()]);
        let auth_token = Arc::new("tok".to_string());
        let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
        let state = SettingsRouterState {
            store: store.clone(),
            auth_token: Arc::clone(&auth_token),
            broadcast_tx: Arc::clone(&broadcast_tx),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                auth_token,
                broadcast_tx,
                json!({}),
            ),
            registry: freshell_terminal::TerminalRegistry::new(),
            ai_key: crate::ai_title::AiKeyCell::default(),
            log_secrets: Default::default(),
            naming_generation: None,
        };
        (router(state), store)
    }

    async fn patch(route: &axum::Router, body: serde_json::Value) {
        let response = route
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/settings")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    fn resolved(entry: &str) -> ClaudeFreshellMcpResolution {
        ClaudeFreshellMcpResolution::Resolved(ClaudeFreshellMcp {
            command: "node".into(),
            args: vec![entry.into()],
        })
    }

    /// The toggle on the Settings page reaches the next sidecar launch with no
    /// restart: the provider reads the live settings tree the route updates.
    #[tokio::test]
    async fn the_settings_toggle_turns_the_recipe_off_and_on_without_a_restart() {
        let home = tempfile::tempdir().unwrap();
        let (route, store) = settings_route(home.path());
        let provider = claude_mcp_provider(
            store.shared_settings_lock(),
            Arc::new(FixedRuntime(Some("/srv/freshell-mcp/server.js"))),
            ProviderTarget::Unix,
        );

        // On by default.
        assert_eq!(provider().await, resolved("/srv/freshell-mcp/server.js"));
        patch(&route, json!({ "codingCli": { "mcpServer": false } })).await;
        assert_eq!(provider().await, ClaudeFreshellMcpResolution::Disabled);
        patch(&route, json!({ "codingCli": { "mcpServer": true } })).await;
        assert_eq!(provider().await, resolved("/srv/freshell-mcp/server.js"));
    }

    /// A command that cannot be resolved is reported with its reason, so the
    /// lane logs it and starts the pane without the server.
    #[tokio::test]
    async fn an_unresolvable_command_is_unavailable_with_its_reason() {
        let home = tempfile::tempdir().unwrap();
        let (_, store) = settings_route(home.path());
        let provider = claude_mcp_provider(
            store.shared_settings_lock(),
            Arc::new(FixedRuntime(None)),
            ProviderTarget::Unix,
        );
        match provider().await {
            ClaudeFreshellMcpResolution::Unavailable(reason) => {
                assert!(reason.contains("tsx"), "{reason}")
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }
}
