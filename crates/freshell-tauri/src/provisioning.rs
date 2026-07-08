//! Remote provisioning — the Rust port of `electron/desktop-provisioning.ts`
//! plus the minimal remote auto-connect wiring of `electron/entry.ts:260-274`
//! (apply the one-time `desktop.provision` file) and `electron/startup.ts:360-380`
//! (serverMode `'remote'` → `serverUrl = remoteUrl`, `authToken = remoteToken`,
//! load the main window at the remote's `?token=` URL — no app-bound spawn).
//!
//! Two provisioning inputs are honored, mirroring how the silent installer hands
//! `FRESHELL_REMOTE_URL` + `FRESHELL_TOKEN` to the desktop shell:
//!
//! 1. **Environment pair** — `FRESHELL_REMOTE_URL` + `FRESHELL_TOKEN` both set and
//!    non-empty (the values the installer receives; the port accepts them directly
//!    so a remote can be provisioned without a file). Matches the truthiness gate
//!    `if (remoteUrl && remoteToken)` of `desktop-provisioning.ts:67`.
//! 2. **Provision file** — `~/.freshell/desktop.provision`, the line-based
//!    `KEY=value` file the installer writes (it cannot safely emit JSON). Parsed
//!    by [`parse_provisioning`] (a 1:1 port of `parseProvisioning`,
//!    `desktop-provisioning.ts:23-34`), persisted into `desktop.json` as
//!    `{serverMode:'remote', remoteUrl, remoteToken, setupCompleted:true}` via the
//!    same atomic patch the reference uses (`patchDesktopConfig`), and ALWAYS
//!    removed so it only takes effect once (`applyProvisioningFile`,
//!    `desktop-provisioning.ts:48-81`).
//!
//! The full `serverMode:'remote'`-from-a-cold-`desktop.json` startup (reachability
//! → chooser fallback, `startup.ts:313-317,360-368`) stays a 3.14 chooser concern;
//! this module provisions and connects, which is exactly the installer flow.

use std::path::Path;

use crate::config;

/// The provision file name under `~/.freshell` (`entry.ts:263`).
pub const PROVISION_FILE_NAME: &str = "desktop.provision";

/// Parsed provisioning values (`ParsedProvisioning`, `desktop-provisioning.ts:12-15`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedProvisioning {
    pub remote_url: Option<String>,
    pub remote_token: Option<String>,
}

/// A fully-resolved remote connection: where to load the SPA from and the token
/// to authenticate with. Only constructed when BOTH values are present + non-empty
/// (the reference's `if (remoteUrl && remoteToken)` truthiness gate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteConfig {
    pub remote_url: String,
    pub remote_token: String,
}

/// Parse `KEY=value` lines — a 1:1 port of `parseProvisioning`
/// (`desktop-provisioning.ts:23-34`). The value keeps every character after the
/// FIRST `=` verbatim (so a token may contain `=`, `"`, `\`, or meaningful
/// surrounding whitespace); only the line ending is stripped, by the split. The
/// key is trimmed for tolerance. Unknown or malformed lines are ignored.
pub fn parse_provisioning(content: &str) -> ParsedProvisioning {
    let mut result = ParsedProvisioning::default();
    // `split(/\r?\n/)`: split on '\n', then strip one trailing '\r' if present.
    for raw_line in content.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let Some(idx) = line.find('=') else { continue };
        let key = line[..idx].trim();
        let value = &line[idx + 1..];
        if key == "FRESHELL_REMOTE_URL" {
            result.remote_url = Some(value.to_string());
        } else if key == "FRESHELL_TOKEN" {
            result.remote_token = Some(value.to_string());
        }
    }
    result
}

/// Resolve a remote from the env pair. Both must be present and non-empty (JS
/// truthiness: `'' || undefined` → absent). Pure — the caller passes the values.
pub fn remote_from_env(url: Option<&str>, token: Option<&str>) -> Option<RemoteConfig> {
    match (url, token) {
        (Some(u), Some(t)) if !u.is_empty() && !t.is_empty() => Some(RemoteConfig {
            remote_url: u.to_string(),
            remote_token: t.to_string(),
        }),
        _ => None,
    }
}

/// Apply a provision file if present, then always remove it — the faithful port
/// of `applyProvisioningFile` (`desktop-provisioning.ts:48-81`):
///   * absent file → `Ok(false)` (nothing consumed);
///   * unreadable file → best-effort delete, `Ok(true)` (must not brick startup);
///   * parsed with both values → patch `desktop.json` at `config_path` with
///     `{serverMode:'remote', remoteUrl, remoteToken, setupCompleted:true}`
///     (persist errors swallowed, as in the reference);
///   * the provision file is ALWAYS deleted (one-shot).
pub fn apply_provisioning_file(provision_path: &Path, config_path: &Path) -> bool {
    let content = match std::fs::read_to_string(provision_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => {
            // Exists but unreadable (locked / a directory / bad perms): clear it
            // best-effort and bail (desktop-provisioning.ts:55-61).
            let _ = std::fs::remove_file(provision_path);
            return true;
        }
    };

    let parsed = parse_provisioning(&content);
    if let (Some(url), Some(token)) = (&parsed.remote_url, &parsed.remote_token) {
        if !url.is_empty() && !token.is_empty() {
            // Persist failure is swallowed: a malformed provision file or a failed
            // write must never block startup (desktop-provisioning.ts:75-77).
            let _ = config::patch_config_at(
                config_path,
                &serde_json::json!({
                    "serverMode": "remote",
                    "remoteUrl": url,
                    "remoteToken": token,
                    "setupCompleted": true,
                }),
            );
        }
    }
    let _ = std::fs::remove_file(provision_path); // finally { deleteFile } — one-shot
    true
}

/// Extract a remote from a `desktop.json` value: `serverMode == 'remote'` with
/// non-empty `remoteUrl` + `remoteToken` (`startup.ts:360-368,374-376`).
pub fn remote_from_desktop_config(cfg: &serde_json::Value) -> Option<RemoteConfig> {
    if cfg.get("serverMode").and_then(|v| v.as_str()) != Some("remote") {
        return None;
    }
    let url = cfg.get("remoteUrl").and_then(|v| v.as_str()).unwrap_or("");
    let token = cfg.get("remoteToken").and_then(|v| v.as_str()).unwrap_or("");
    remote_from_env(Some(url), Some(token))
}

/// Normalize a server URL exactly like `normalizeServerUrl`
/// (`launch-discovery.ts`): trim whitespace, strip ALL trailing slashes.
pub fn normalize_server_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

/// Build the remote webview load URL: `<normalized>/?token=<encodeURIComponent>`.
/// Token percent-encoding matches `startup.ts:152-155` (the renderer reads it back
/// via `URLSearchParams`, so a raw `+ & # =` would corrupt it).
pub fn remote_load_url(remote_url: &str, token: &str) -> String {
    format!(
        "{}/?token={}",
        normalize_server_url(remote_url),
        crate::shim::encode_uri_component(token)
    )
}

/// Resolve a provisioned remote for THIS boot (impure orchestrator):
/// 1. `FRESHELL_REMOTE_URL` + `FRESHELL_TOKEN` env pair (installer hand-off);
/// 2. else consume `~/.freshell/desktop.provision` (one-shot, patches
///    `desktop.json` exactly like `entry.ts:263-274`) and read the resulting
///    remote back from `desktop.json`.
///
/// `None` → not provisioned → the caller proceeds app-bound.
pub fn resolve_provisioned_remote() -> Option<RemoteConfig> {
    let env_url = std::env::var("FRESHELL_REMOTE_URL").ok();
    let env_token = std::env::var("FRESHELL_TOKEN").ok();
    if let Some(remote) = remote_from_env(env_url.as_deref(), env_token.as_deref()) {
        return Some(remote);
    }

    let config_dir = config::config_dir()?;
    let provision_path = config_dir.join(PROVISION_FILE_NAME);
    let config_path = config_dir.join("desktop.json");
    if !apply_provisioning_file(&provision_path, &config_path) {
        return None;
    }
    let cfg = config::read_config_at(&config_path).ok()?;
    remote_from_desktop_config(&cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parseProvisioning (1:1 with desktop-provisioning.test coverage) ──────

    #[test]
    fn parses_both_keys() {
        let parsed =
            parse_provisioning("FRESHELL_REMOTE_URL=http://box:3051\nFRESHELL_TOKEN=abc123\n");
        assert_eq!(parsed.remote_url.as_deref(), Some("http://box:3051"));
        assert_eq!(parsed.remote_token.as_deref(), Some("abc123"));
    }

    #[test]
    fn value_is_verbatim_after_first_equals() {
        // A token may contain `=`, `"`, `\`, and surrounding whitespace — all kept.
        let parsed = parse_provisioning("FRESHELL_TOKEN=a=b\"c\\d \n");
        assert_eq!(parsed.remote_token.as_deref(), Some("a=b\"c\\d "));
    }

    #[test]
    fn key_is_trimmed_but_value_whitespace_kept() {
        let parsed = parse_provisioning("  FRESHELL_REMOTE_URL = http://x\n");
        // Key trim: `  FRESHELL_REMOTE_URL ` → `FRESHELL_REMOTE_URL`... but note the
        // reference trims the SLICE BEFORE the first `=`, so the key here is
        // `FRESHELL_REMOTE_URL` and the value is ` http://x` (leading space kept).
        assert_eq!(parsed.remote_url.as_deref(), Some(" http://x"));
    }

    #[test]
    fn crlf_line_endings_are_stripped() {
        let parsed = parse_provisioning("FRESHELL_REMOTE_URL=http://y\r\nFRESHELL_TOKEN=t\r\n");
        assert_eq!(parsed.remote_url.as_deref(), Some("http://y"));
        assert_eq!(parsed.remote_token.as_deref(), Some("t"));
    }

    #[test]
    fn malformed_and_unknown_lines_are_ignored() {
        let parsed = parse_provisioning("no-equals-line\nOTHER_KEY=zzz\n\nFRESHELL_TOKEN=t\n");
        assert_eq!(parsed.remote_url, None);
        assert_eq!(parsed.remote_token.as_deref(), Some("t"));
    }

    #[test]
    fn empty_content_parses_to_nothing() {
        assert_eq!(parse_provisioning(""), ParsedProvisioning::default());
    }

    // ── env resolution (JS truthiness gate) ──────────────────────────────────

    #[test]
    fn env_pair_resolves_only_when_both_nonempty() {
        assert!(remote_from_env(Some("http://x:1"), Some("tok")).is_some());
        assert!(remote_from_env(Some("http://x:1"), None).is_none());
        assert!(remote_from_env(None, Some("tok")).is_none());
        assert!(remote_from_env(Some(""), Some("tok")).is_none(), "'' is falsy");
        assert!(remote_from_env(Some("http://x:1"), Some("")).is_none());
    }

    #[test]
    fn env_values_are_verbatim() {
        let r = remote_from_env(Some("http://x:1"), Some("t=ok\"n\\")).unwrap();
        assert_eq!(r.remote_token, "t=ok\"n\\");
    }

    // ── applyProvisioningFile (one-shot consume + desktop.json patch) ────────

    #[test]
    fn apply_missing_file_returns_false() {
        let dir = tempfile::tempdir().unwrap();
        let consumed = apply_provisioning_file(
            &dir.path().join("desktop.provision"),
            &dir.path().join("desktop.json"),
        );
        assert!(!consumed);
    }

    #[test]
    fn apply_patches_config_and_deletes_file() {
        let dir = tempfile::tempdir().unwrap();
        let prov = dir.path().join("desktop.provision");
        let cfg = dir.path().join("desktop.json");
        std::fs::write(&prov, "FRESHELL_REMOTE_URL=http://box:3051\nFRESHELL_TOKEN=tok=1\n")
            .unwrap();
        assert!(apply_provisioning_file(&prov, &cfg));
        assert!(!prov.exists(), "provision file is one-shot (always removed)");
        let value = config::read_config_at(&cfg).unwrap();
        assert_eq!(value["serverMode"], "remote");
        assert_eq!(value["remoteUrl"], "http://box:3051");
        assert_eq!(value["remoteToken"], "tok=1", "token kept verbatim (incl. '=')");
        assert_eq!(value["setupCompleted"], true);
    }

    #[test]
    fn apply_incomplete_file_deletes_without_patching() {
        let dir = tempfile::tempdir().unwrap();
        let prov = dir.path().join("desktop.provision");
        let cfg = dir.path().join("desktop.json");
        std::fs::write(&prov, "FRESHELL_TOKEN=only-token\n").unwrap();
        assert!(apply_provisioning_file(&prov, &cfg));
        assert!(!prov.exists());
        assert!(!cfg.exists(), "no patch without BOTH url+token");
    }

    #[test]
    fn apply_preserves_other_desktop_json_keys() {
        let dir = tempfile::tempdir().unwrap();
        let prov = dir.path().join("desktop.provision");
        let cfg = dir.path().join("desktop.json");
        std::fs::write(&cfg, r#"{ "globalHotkey": "F9" }"#).unwrap();
        std::fs::write(&prov, "FRESHELL_REMOTE_URL=http://u\nFRESHELL_TOKEN=t\n").unwrap();
        assert!(apply_provisioning_file(&prov, &cfg));
        let value = config::read_config_at(&cfg).unwrap();
        assert_eq!(value["globalHotkey"], "F9", "patch merges, never clobbers");
        assert_eq!(value["serverMode"], "remote");
    }

    // ── desktop.json → RemoteConfig ──────────────────────────────────────────

    #[test]
    fn desktop_config_remote_roundtrip() {
        let cfg = serde_json::json!({
            "serverMode": "remote", "remoteUrl": "http://h:1", "remoteToken": "t"
        });
        let r = remote_from_desktop_config(&cfg).unwrap();
        assert_eq!(r.remote_url, "http://h:1");
        assert_eq!(r.remote_token, "t");
        // Non-remote modes and missing fields resolve to None.
        assert!(remote_from_desktop_config(&serde_json::json!({"serverMode": "app-bound"}))
            .is_none());
        assert!(remote_from_desktop_config(
            &serde_json::json!({"serverMode": "remote", "remoteUrl": "http://h:1"})
        )
        .is_none());
    }

    // ── load URL ─────────────────────────────────────────────────────────────

    #[test]
    fn load_url_normalizes_and_encodes() {
        assert_eq!(
            remote_load_url("http://172.30.144.1:3051", "tauriwin"),
            "http://172.30.144.1:3051/?token=tauriwin"
        );
        // Trailing slashes stripped (normalizeServerUrl), whitespace trimmed.
        assert_eq!(
            remote_load_url("  http://box:3051// ", "t"),
            "http://box:3051/?token=t"
        );
        // Token percent-encoded like encodeURIComponent (`=` → %3D etc.).
        assert_eq!(
            remote_load_url("http://box:3051", "a=b c&"),
            "http://box:3051/?token=a%3Db%20c%26"
        );
    }
}
