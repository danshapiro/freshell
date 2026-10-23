//! The Freshell context a child process gets so it can reach this server
//! (the Freshell CLI and MCP client read it): `FRESHELL=1`, `FRESHELL_URL`,
//! `FRESHELL_TOKEN`, and the pane it runs for (`FRESHELL_TERMINAL_ID`,
//! `FRESHELL_TAB_ID`, `FRESHELL_PANE_ID`).
//!
//! One builder for every lane that hands it out: the terminal lanes
//! (`buildTerminalBaseEnv`, `terminal-registry.ts:1529-1542`) and the
//! freshclaude/kilroy sidecar, so the names and the omission rules cannot drift.

use std::collections::BTreeMap;

use crate::Env;

/// The context names this module writes, in no particular order.
pub const FRESHELL: &str = "FRESHELL";
pub const FRESHELL_URL: &str = "FRESHELL_URL";
pub const FRESHELL_TOKEN: &str = "FRESHELL_TOKEN";
pub const FRESHELL_TERMINAL_ID: &str = "FRESHELL_TERMINAL_ID";
pub const FRESHELL_TAB_ID: &str = "FRESHELL_TAB_ID";
pub const FRESHELL_PANE_ID: &str = "FRESHELL_PANE_ID";

/// The pane-scoped names: a child launched for one pane must never inherit
/// another pane's values (for example from the environment of a server that
/// itself runs inside a Freshell terminal).
pub const FRESHELL_PANE_CONTEXT_ENV_VARS: [&str; 3] =
    [FRESHELL_TERMINAL_ID, FRESHELL_TAB_ID, FRESHELL_PANE_ID];

/// Where this server answers its REST API, and the token that authorizes it.
#[derive(Clone, PartialEq, Eq)]
pub struct FreshellEndpoint {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for FreshellEndpoint {
    // The token never reaches a log line.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FreshellEndpoint")
            .field("url", &self.url)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl FreshellEndpoint {
    /// The endpoint of a server listening on `port` on this host.
    pub fn local(port: u16, token: impl Into<String>) -> Self {
        Self {
            url: format!("http://localhost:{port}"),
            token: token.into(),
        }
    }

    /// The terminal lanes' endpoint, from the process environment
    /// (`terminal-registry.ts:1529-1542`): `FRESHELL_URL` when set, else
    /// `http://localhost:<PORT>` (`PORT` defaults to 3001, coerced the way the
    /// reference's `Number(...)` does), and `AUTH_TOKEN` (empty when unset).
    pub fn from_env(env: &dyn Env) -> Self {
        // `const port = Number(process.env.PORT || 3001)` (truthy: '' → 3001).
        let port_raw = env
            .get("PORT")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "3001".to_string());
        let url = env
            .get(FRESHELL_URL)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| format!("http://localhost:{}", js_number_string(&port_raw)));
        Self {
            url,
            token: env.get("AUTH_TOKEN").unwrap_or_default(),
        }
    }
}

/// The context environment for a child: `FRESHELL=1`, the endpoint, and each
/// of `terminal_id`, `tab_id`, `pane_id` that is present and non-empty (an
/// absent or empty id leaves its key out, `...(tabId ? {...} : {})`).
pub fn freshell_context_env(
    endpoint: &FreshellEndpoint,
    terminal_id: Option<&str>,
    tab_id: Option<&str>,
    pane_id: Option<&str>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    out.insert(FRESHELL.to_string(), "1".to_string());
    out.insert(FRESHELL_URL.to_string(), endpoint.url.clone());
    out.insert(FRESHELL_TOKEN.to_string(), endpoint.token.clone());
    for (name, value) in [
        (FRESHELL_TERMINAL_ID, terminal_id),
        (FRESHELL_TAB_ID, tab_id),
        (FRESHELL_PANE_ID, pane_id),
    ] {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            out.insert(name.to_string(), value.to_string());
        }
    }
    out
}

/// JS `String(Number(s))` for the `PORT` template slot: every real deployment is
/// a plain integer; whitespace-only → `0`, unparseable → `NaN` (faithful to the
/// reference's `Number(...)` coercion in the template literal).
pub fn js_number_string(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return "0".to_string();
    }
    match t.parse::<f64>() {
        Ok(n) if n.is_finite() => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", n as i64)
            } else {
                format!("{n}")
            }
        }
        _ => "NaN".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_string_coercion() {
        assert_eq!(js_number_string("17872"), "17872");
        assert_eq!(js_number_string(" 17872 "), "17872");
        assert_eq!(js_number_string("abc"), "NaN");
        assert_eq!(js_number_string(" "), "0");
    }

    #[test]
    fn a_local_endpoint_names_this_hosts_port() {
        let endpoint = FreshellEndpoint::local(3344, "tok");
        assert_eq!(endpoint.url, "http://localhost:3344");
        assert_eq!(endpoint.token, "tok");
    }

    #[test]
    fn the_debug_form_never_shows_the_token() {
        let shown = format!("{:?}", FreshellEndpoint::local(1, "secret-token"));
        assert!(!shown.contains("secret-token"), "{shown}");
    }

    #[test]
    fn a_context_without_a_terminal_carries_the_endpoint_and_the_pane() {
        let out = freshell_context_env(
            &FreshellEndpoint::local(9, "tok"),
            None,
            Some("tab-1"),
            Some("pane-1"),
        );
        let expected: BTreeMap<String, String> = [
            ("FRESHELL", "1"),
            ("FRESHELL_URL", "http://localhost:9"),
            ("FRESHELL_TOKEN", "tok"),
            ("FRESHELL_TAB_ID", "tab-1"),
            ("FRESHELL_PANE_ID", "pane-1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(out, expected);
    }
}
