//! The ordinary Freshell MCP server inside freshclaude and kilroy panes (G19,
//! api-hosted-ops plan §2.4).
//!
//! Terminal panes give their coding CLI the Freshell MCP server and the context
//! it needs (`FRESHELL_URL`, `FRESHELL_TOKEN`, the pane). A claude sidecar gets
//! the same through three pieces, all wired by `freshell-server` (the session
//! host wires none of them: a hosted lane keeps its own fixed recipe):
//!
//! - the endpoint ([`FreshellEndpoint`]): every sidecar's environment carries
//!   `FRESHELL=1`, `FRESHELL_URL` and `FRESHELL_TOKEN` from the server's own
//!   bound port and token, and none of another pane's ids;
//! - the recipe ([`ClaudeFreshellMcpProvider`]): asked once per sidecar launch,
//!   so `settings.codingCli.mcpServer` applies to the next launch without a
//!   restart. Only the command and its arguments travel in the `create` line
//!   (`freshellMcp`); the SDK puts that config on the CLI's argv, so the token
//!   never goes there;
//! - the pane ([`ClaudeFreshellContext`]): the `create` line's
//!   `freshellContext`, merged by the sidecar into the CLI's environment, from
//!   which the CLI hands it to the MCP child.

use std::sync::{Arc, OnceLock};

use futures_util::future::BoxFuture;
use serde::Serialize;

pub use freshell_platform::freshell_context_env::FreshellEndpoint;

use crate::claude_launch::ClaudeLaunchSpec;

/// The command that starts the Freshell MCP server for a sidecar's CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaudeFreshellMcp {
    pub command: String,
    pub args: Vec<String>,
}

/// What the server's Freshell MCP setting and command resolver answer for one
/// sidecar launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeFreshellMcpResolution {
    /// `settings.codingCli.mcpServer` is off.
    Disabled,
    /// The setting is on, but the server command could not be resolved (the
    /// reason). The pane starts without the MCP server; it never fails over it.
    Unavailable(String),
    /// The setting is on and this is the command.
    Resolved(ClaudeFreshellMcp),
}

/// Asked once per sidecar launch for the Freshell MCP recipe.
pub type ClaudeFreshellMcpProvider =
    Arc<dyn Fn() -> BoxFuture<'static, ClaudeFreshellMcpResolution> + Send + Sync>;

/// The pane a session runs for: the `create` line's `freshellContext`, which
/// becomes `FRESHELL_TAB_ID` / `FRESHELL_PANE_ID` in the CLI's environment.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeFreshellContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

impl ClaudeFreshellContext {
    /// The context of `tab_id` and `pane_id`; `None` when neither names
    /// anything (an empty id names nothing).
    pub fn from_ids(tab_id: Option<&str>, pane_id: Option<&str>) -> Option<Self> {
        let id = |value: Option<&str>| value.filter(|v| !v.is_empty()).map(str::to_string);
        let context = Self {
            tab_id: id(tab_id),
            pane_id: id(pane_id),
        };
        (context.tab_id.is_some() || context.pane_id.is_some()).then_some(context)
    }
}

/// A claude lane's Freshell MCP wiring: set once each, after construction
/// (the `set_identity_sink` pattern), shared by every clone of the lane.
#[derive(Clone, Default)]
pub(crate) struct ClaudeFreshellMcpWiring {
    endpoint: Arc<OnceLock<FreshellEndpoint>>,
    provider: Arc<OnceLock<ClaudeFreshellMcpProvider>>,
}

impl ClaudeFreshellMcpWiring {
    /// Install the endpoint; `false` when one already was.
    pub(crate) fn set_endpoint(&self, endpoint: FreshellEndpoint) -> bool {
        self.endpoint.set(endpoint).is_ok()
    }

    /// Install the recipe provider; `false` when one already was.
    pub(crate) fn set_provider(&self, provider: ClaudeFreshellMcpProvider) -> bool {
        self.provider.set(provider).is_ok()
    }

    /// The endpoint every sidecar's environment carries, once installed.
    pub(crate) fn endpoint(&self) -> Option<&FreshellEndpoint> {
        self.endpoint.get()
    }

    /// `spec` with the Freshell MCP recipe this launch gets: none for a lane
    /// that selected the hosted recipe or has no provider, else the provider's
    /// answer, asked now. Logged per launch (`freshagent.claude.mcp_injection`,
    /// and `freshagent.claude.mcp_unavailable` when the command could not be
    /// resolved).
    pub(crate) async fn launch(&self, mut spec: ClaudeLaunchSpec) -> ClaudeLaunchSpec {
        spec.freshell_mcp = None;
        if spec.hosted_mcp {
            return spec;
        }
        let Some(provider) = self.provider.get() else {
            return spec;
        };
        let resolution = provider().await;
        if let ClaudeFreshellMcpResolution::Unavailable(error) = &resolution {
            tracing::warn!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.mcp_unavailable",
                request_id = %spec.request_id,
                session_type = %spec.session_type,
                error = %error,
                "the Freshell MCP server command could not be resolved; the pane starts without it"
            );
        }
        tracing::info!(
            target: "freshell_freshagent::claude",
            event = "freshagent.claude.mcp_injection",
            request_id = %spec.request_id,
            session_type = %spec.session_type,
            boot = spec.boot.kind(),
            enabled = !matches!(resolution, ClaudeFreshellMcpResolution::Disabled),
            resolved = matches!(resolution, ClaudeFreshellMcpResolution::Resolved(_)),
            has_pane_context = spec.freshell_context.is_some(),
            "the Freshell MCP selection for a claude sidecar launch"
        );
        if let ClaudeFreshellMcpResolution::Resolved(recipe) = resolution {
            spec.freshell_mcp = Some(recipe);
        }
        spec
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_launch::ClaudeBoot;
    use crate::identity_sink::FreshAgentSettings;

    fn recipe() -> ClaudeFreshellMcp {
        ClaudeFreshellMcp {
            command: "node".into(),
            args: vec!["/srv/freshell-mcp/server.js".into()],
        }
    }

    fn spec(hosted_mcp: bool) -> ClaudeLaunchSpec {
        ClaudeLaunchSpec::new(
            "req",
            "freshclaude",
            ClaudeBoot::Fresh,
            None,
            &FreshAgentSettings::default(),
            hosted_mcp,
        )
    }

    fn answering(resolution: ClaudeFreshellMcpResolution) -> ClaudeFreshellMcpWiring {
        let wiring = ClaudeFreshellMcpWiring::default();
        let provider: ClaudeFreshellMcpProvider = Arc::new(move || {
            let resolution = resolution.clone();
            Box::pin(async move { resolution })
        });
        assert!(wiring.set_provider(provider));
        wiring
    }

    #[tokio::test]
    async fn a_launch_gets_the_recipe_the_provider_resolves_now() {
        let launched = answering(ClaudeFreshellMcpResolution::Resolved(recipe()))
            .launch(spec(false))
            .await;
        assert_eq!(launched.freshell_mcp, Some(recipe()));
    }

    #[tokio::test]
    async fn a_disabled_or_unresolvable_recipe_launches_without_one() {
        for resolution in [
            ClaudeFreshellMcpResolution::Disabled,
            ClaudeFreshellMcpResolution::Unavailable("no tsx".into()),
        ] {
            let launched = answering(resolution.clone()).launch(spec(false)).await;
            assert_eq!(launched.freshell_mcp, None, "{resolution:?}");
        }
    }

    #[tokio::test]
    async fn a_lane_without_a_provider_launches_without_a_recipe() {
        let launched = ClaudeFreshellMcpWiring::default().launch(spec(false)).await;
        assert_eq!(launched.freshell_mcp, None);
    }

    /// The hosted lane keeps its fixed recipe and never gets the ordinary one,
    /// even when a provider would answer one.
    #[tokio::test]
    async fn a_hosted_lane_never_gets_the_ordinary_recipe() {
        let launched = answering(ClaudeFreshellMcpResolution::Resolved(recipe()))
            .launch(spec(true))
            .await;
        assert_eq!(launched.freshell_mcp, None);
    }

    #[test]
    fn a_pane_context_names_only_what_it_was_given() {
        assert_eq!(ClaudeFreshellContext::from_ids(None, None), None);
        assert_eq!(ClaudeFreshellContext::from_ids(Some(""), Some("")), None);
        assert_eq!(
            ClaudeFreshellContext::from_ids(Some("tab-1"), None),
            Some(ClaudeFreshellContext {
                tab_id: Some("tab-1".into()),
                pane_id: None,
            })
        );
        assert_eq!(
            serde_json::to_value(ClaudeFreshellContext::from_ids(Some("t"), Some("p")).unwrap())
                .unwrap(),
            serde_json::json!({ "tabId": "t", "paneId": "p" })
        );
    }

    #[test]
    fn the_endpoint_and_provider_are_set_once() {
        let wiring = ClaudeFreshellMcpWiring::default();
        assert!(wiring.endpoint().is_none());
        assert!(wiring.set_endpoint(FreshellEndpoint::local(4100, "tok")));
        assert!(!wiring.set_endpoint(FreshellEndpoint::local(4200, "other")));
        assert_eq!(wiring.endpoint().unwrap().url, "http://localhost:4100");
    }
}
