//! WebSocket Origin policy (SAFE-03: "Enforce WebSocket Origin policy. Accept
//! configured trusted origins and reject hostile/malformed origins before
//! session state is exposed.").
//!
//! ## Deliberate hardening beyond the original
//!
//! `server/ws-handler.ts`'s Origin handling (both on the frozen `server/` and
//! `origin/main`, byte-identical) is explicitly **advisory-only**:
//!
//! ```text
//! // Origin validation is advisory-only — the auth token in the hello message
//! // is the real security gate. We log mismatches for diagnostics but never
//! // reject connections based on Origin, ...
//! ```
//!
//! It never closes a socket for a bad `Origin`; it only logs a warning and
//! still authenticates via the `hello` token. Neither the frozen legacy nor
//! `origin/main` implements a real Origin *policy* to mirror, so this module
//! implements the checklist item's stated intent directly: an allow-list
//! (mirroring `server/auth.ts#parseAllowedOrigins`'s exact defaults/env
//! contract) enforced by REJECTING the connection — closed before any
//! session state (`ready`/`settings.updated`/`terminal.inventory`) is ever
//! sent — rather than merely logging. This is required because the Rust
//! server's production binding is `0.0.0.0` (LAN-reachable), where an
//! advisory-only policy leaves a classic DNS-rebinding path open: a hostile
//! page in the browser can still complete the WS handshake and read session
//! state as long as it also knows/guesses a valid token.
//!
//! An absent `Origin` header is still ALLOWED (legacy parity: VPNs and some
//! mobile browsers omit it, and non-browser clients — curl, CLI tooling, MCP
//! — never send one at all).

/// The origin allow-list `server/auth.ts#parseAllowedOrigins` falls back to
/// when `ALLOWED_ORIGINS` is unset (`server/auth.ts:53-61`, byte-identical
/// set: localhost + 127.0.0.1 on the client dev port and both server ports).
pub fn default_allowed_origins() -> Vec<String> {
    [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3002",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

/// Mirrors `server/auth.ts#parseAllowedOrigins`: a non-empty `ALLOWED_ORIGINS`
/// value REPLACES the defaults entirely (comma-split, trimmed, empty entries
/// dropped) — it is not merged with them. An empty/unset value falls back to
/// [`default_allowed_origins`].
///
/// `extra_origins_env` mirrors `server/network-manager.ts`'s user-facing
/// `EXTRA_ALLOWED_ORIGINS` knob (`"Parse user-specified extra origins from
/// EXTRA_ALLOWED_ORIGINS env var"`): always appended on top, regardless of
/// which `ALLOWED_ORIGINS` branch was taken, with duplicates skipped.
pub fn resolve_allowed_origins(
    allowed_origins_env: Option<&str>,
    extra_origins_env: Option<&str>,
) -> Vec<String> {
    let mut origins = match allowed_origins_env {
        Some(env) if !env.is_empty() => split_csv(env),
        _ => default_allowed_origins(),
    };
    if let Some(extra) = extra_origins_env {
        for candidate in split_csv(extra) {
            if !origins.contains(&candidate) {
                origins.push(candidate);
            }
        }
    }
    origins
}

fn split_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// Outcome of the Origin policy check for a `/ws` upgrade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginDecision {
    /// No `Origin` header at all — a non-browser client (curl/CLI/MCP tooling)
    /// or a VPN/mobile browser that stripped it. Allowed (legacy parity).
    NoOrigin,
    /// `Origin` matches the request's own `Host` (same-origin) or an entry in
    /// the resolved allow-list.
    Allowed,
    /// `Origin` is present and neither same-origin nor allow-listed: a
    /// hostile origin (DNS rebinding), the literal string `"null"` (sandboxed
    /// iframe / `file://`), or anything else not on the list.
    Rejected,
}

/// Evaluate the Origin policy for a `/ws` upgrade request. `host` is the
/// request's own `Host` header (enables the same-origin check); `allowed` is
/// the list resolved by [`resolve_allowed_origins`].
pub fn evaluate_origin(
    origin: Option<&str>,
    host: Option<&str>,
    allowed: &[String],
) -> OriginDecision {
    let Some(origin) = origin else {
        return OriginDecision::NoOrigin;
    };
    // The `null` origin (sandboxed iframe, `file://`, some redirects) is
    // always hostile-or-ambiguous — never treat it as same-origin or
    // allow-listed, even if an operator's allow-list literally contains it.
    if origin.eq_ignore_ascii_case("null") {
        return OriginDecision::Rejected;
    }
    if let Some(host) = host {
        if origin == format!("http://{host}") || origin == format!("https://{host}") {
            return OriginDecision::Allowed;
        }
    }
    if allowed.iter().any(|candidate| candidate == origin) {
        return OriginDecision::Allowed;
    }
    OriginDecision::Rejected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_allowed_origins_matches_legacy_set() {
        assert_eq!(
            default_allowed_origins(),
            vec![
                "http://localhost:5173",
                "http://127.0.0.1:5173",
                "http://localhost:3001",
                "http://127.0.0.1:3001",
                "http://localhost:3002",
                "http://127.0.0.1:3002",
            ]
        );
    }

    #[test]
    fn resolve_allowed_origins_falls_back_to_defaults_when_env_unset() {
        assert_eq!(
            resolve_allowed_origins(None, None),
            default_allowed_origins()
        );
    }

    #[test]
    fn resolve_allowed_origins_falls_back_to_defaults_when_env_empty() {
        // Legacy: `if (env) ...` — an empty string is JS-falsy, so it falls
        // through to the default list exactly like an unset var.
        assert_eq!(
            resolve_allowed_origins(Some(""), None),
            default_allowed_origins()
        );
    }

    #[test]
    fn resolve_allowed_origins_replaces_defaults_when_env_set() {
        let resolved = resolve_allowed_origins(Some("https://a.example, https://b.example"), None);
        assert_eq!(resolved, vec!["https://a.example", "https://b.example"]);
    }

    #[test]
    fn resolve_allowed_origins_appends_extra_without_duplicating() {
        let resolved = resolve_allowed_origins(
            Some("https://a.example"),
            Some("https://b.example, https://a.example"),
        );
        assert_eq!(resolved, vec!["https://a.example", "https://b.example"]);
    }

    #[test]
    fn no_origin_header_is_allowed() {
        assert_eq!(
            evaluate_origin(None, Some("127.0.0.1:3001"), &default_allowed_origins()),
            OriginDecision::NoOrigin
        );
    }

    #[test]
    fn null_origin_is_rejected() {
        assert_eq!(
            evaluate_origin(
                Some("null"),
                Some("127.0.0.1:3001"),
                &default_allowed_origins()
            ),
            OriginDecision::Rejected
        );
    }

    #[test]
    fn same_origin_via_host_header_is_allowed() {
        let allowed = vec![]; // deliberately empty allow-list: same-origin must not depend on it
        assert_eq!(
            evaluate_origin(
                Some("http://192.168.1.50:3002"),
                Some("192.168.1.50:3002"),
                &allowed
            ),
            OriginDecision::Allowed
        );
    }

    #[test]
    fn configured_allow_listed_origin_is_allowed() {
        let allowed = default_allowed_origins();
        assert_eq!(
            evaluate_origin(
                Some("http://localhost:3002"),
                Some("127.0.0.1:3002"),
                &allowed
            ),
            OriginDecision::Allowed
        );
    }

    /// The DNS-rebinding case: a hostile page whose Origin never matches Host
    /// or the allow-list must be rejected regardless of any token it later
    /// presents (the origin check runs before the hello is ever read).
    #[test]
    fn hostile_origin_with_mismatched_host_is_rejected() {
        assert_eq!(
            evaluate_origin(
                Some("http://evil.example"),
                Some("127.0.0.1:3002"),
                &default_allowed_origins()
            ),
            OriginDecision::Rejected
        );
    }

    #[test]
    fn malformed_origin_is_rejected() {
        assert_eq!(
            evaluate_origin(
                Some("not-a-url"),
                Some("127.0.0.1:3002"),
                &default_allowed_origins()
            ),
            OriginDecision::Rejected
        );
    }
}
