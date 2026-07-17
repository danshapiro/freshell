//! Auto-updater — the Rust analog of `electron/updater.ts` (`createUpdateManager`)
//! and its wiring (`entry.ts:294-316`, first check 10 s after load
//! `startup.ts:219-221`), retargeted onto `tauri-plugin-updater`.
//!
//! **The pipeline is a rebuild, not a swap (`electron-tauri.md §9 Risk 2`).**
//! `electron-updater` uses `latest.yml` + blockmap deltas + NSIS one-click and
//! code-sign trust; `tauri-plugin-updater` uses a signed **`latest.json`** + a
//! mandatory **Ed25519** signature (embedded pubkey) + **full-bundle** replacement.
//! So this module ports the parts that are decidable/testable HEADLESSLY —
//!
//!  * [`should_update`] — the version **check-decision** (is the feed's version
//!    strictly newer than ours?), the one piece the task pins with a unit test;
//!  * [`check_manifest`] — parse a `latest.json` fixture, resolve the artifact for
//!    a target triple, and decide (offer / up-to-date / no-artifact);
//!  * [`UpdaterConfig`] / [`updater_state`] — the config presence gate (pubkey +
//!    endpoints) that decides whether the updater is even armed;
//!
//! — and DOCUMENTS the rest as signing/release-gated. **Live update is NOT
//! verifiable on this headless host**: it needs a signed release bundle, a live
//! `latest.json` + `.sig` feed, and a per-OS install/relaunch. That is Phase-4
//! manual / cross-build QA (`electron-tauri.md §8` item 12 "⚠️ fixture"). The
//! runtime `tauri-plugin-updater` registration is armed only when a real pubkey is
//! configured (see `lib.rs`), so an unsigned dev build silently stays disarmed —
//! which surfaces CD-7 below.
//
// CD candidate: CD-7 updater-noop-silent — `entry.ts:307-315` warns once and
// installs a no-op stub when `electron-updater` is absent, so updates fail
// silently. `tauri-plugin-updater` is *always available when configured*, so the
// port CAN surface an explicit disabled/disarmed state ([`UpdaterState`]) instead
// of a silent no-op. Whether to change the user-visible behavior is an antagonist
// call — flagged, not pre-decided; the state is reported, the wiring stays faithful.

use serde::{Deserialize, Serialize};

/// First automatic update check delay after the main window loads — 10 s
/// (`startup.ts:219-221`). Manual checks (tray / Help menu) fire immediately.
pub const FIRST_CHECK_DELAY: std::time::Duration = std::time::Duration::from_secs(10);

/// The updater configuration the port reads (from `tauri.conf.json`
/// `plugins.updater` + env). `tauri-plugin-updater` requires BOTH a non-empty
/// `pubkey` (Ed25519, `tauri.conf.json`) and at least one `endpoint`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UpdaterConfig {
    /// The update feed endpoints (each serving `latest.json`).
    pub endpoints: Vec<String>,
    /// The embedded Ed25519 public key (base64). Empty/placeholder = disarmed.
    pub pubkey: String,
}

/// Whether the updater is armed, and if not, why — the explicit state CD-7 says the
/// port should surface instead of Electron's silent no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdaterState {
    /// pubkey + ≥1 endpoint present → the updater can check/verify/install.
    Armed,
    /// No (or placeholder) pubkey → cannot verify signatures → disarmed.
    DisarmedNoPubkey,
    /// pubkey present but no endpoints → nothing to check → disarmed.
    DisarmedNoEndpoint,
}

/// A pubkey is a placeholder (disarmed) if empty or the well-known TODO sentinel
/// this crate ships in `tauri.conf.json` until a real signing key exists.
pub const PLACEHOLDER_PUBKEY_MARKER: &str = "REPLACE_WITH_REAL_ED25519_PUBKEY";

/// Parse the runtime updater config out of `tauri.conf.json`'s `plugins` map (what
/// `app.config().plugins` yields). This is what makes the config block genuinely
/// wired: [`report_updater_state`](crate) reads it to decide armed vs disarmed
/// (CD-7), instead of the config being inert placeholder JSON. Missing keys →
/// empty (disarmed).
pub fn parse_updater_config(plugins: &serde_json::Value) -> UpdaterConfig {
    let updater = plugins.get("updater");
    let endpoints = updater
        .and_then(|u| u.get("endpoints"))
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let pubkey = updater
        .and_then(|u| u.get("pubkey"))
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();
    UpdaterConfig { endpoints, pubkey }
}

/// Decide the updater state from config (CD-7's explicit disabled state).
pub fn updater_state(config: &UpdaterConfig) -> UpdaterState {
    let pubkey_ok =
        !config.pubkey.trim().is_empty() && !config.pubkey.contains(PLACEHOLDER_PUBKEY_MARKER);
    if !pubkey_ok {
        return UpdaterState::DisarmedNoPubkey;
    }
    if config.endpoints.is_empty() {
        return UpdaterState::DisarmedNoEndpoint;
    }
    UpdaterState::Armed
}

/// The version check-decision. Compares the feed version to the running version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateDecision {
    /// The feed offers a strictly newer version → update available.
    UpdateAvailable,
    /// Same version → nothing to do.
    UpToDate,
    /// The feed version is older than ours (or a downgrade) → do NOT offer.
    /// `electron-updater`'s `allowDowngrade` defaults false, and
    /// `tauri-plugin-updater` only reports strictly-newer, so a downgrade is a
    /// no-offer in both.
    NoDowngrade,
    /// A version string did not parse as semver → cannot decide (treated as
    /// up-to-date, i.e. do not offer, erring safe).
    Unparseable,
}

/// Is `latest` a version we should update to, given we are running `current`?
/// Pure semver comparison — the check-decision the task pins.
pub fn should_update(current: &str, latest: &str) -> UpdateDecision {
    let (Ok(cur), Ok(new)) = (
        semver::Version::parse(current.trim_start_matches('v')),
        semver::Version::parse(latest.trim_start_matches('v')),
    ) else {
        return UpdateDecision::Unparseable;
    };
    match new.cmp(&cur) {
        std::cmp::Ordering::Greater => UpdateDecision::UpdateAvailable,
        std::cmp::Ordering::Equal => UpdateDecision::UpToDate,
        std::cmp::Ordering::Less => UpdateDecision::NoDowngrade,
    }
}

/// One platform's artifact entry in a `latest.json` (`tauri-plugin-updater`
/// format): the `.sig` (detached Ed25519 signature) + the bundle `url`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlatformEntry {
    pub signature: String,
    pub url: String,
}

/// A `tauri-plugin-updater` `latest.json` manifest. `platforms` is keyed by
/// `"<os>-<arch>"` (e.g. `linux-x86_64`, `windows-x86_64`, `darwin-aarch64`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatestManifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default, rename = "pub_date")]
    pub pub_date: String,
    pub platforms: std::collections::BTreeMap<String, PlatformEntry>,
}

/// The `latest.json` platform key for an OS + arch (`std::env::consts::OS`/`ARCH`
/// style: `linux`/`windows`/`macos`, `x86_64`/`aarch64`). `macos` maps to
/// `darwin` to match Tauri's convention.
pub fn platform_target(os: &str, arch: &str) -> String {
    let os = match os {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{arch}")
}

/// The result of checking a parsed manifest against the running version + target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckResult {
    /// An update is available AND an artifact exists for this platform.
    Offer { version: String, url: String },
    /// The feed is not newer.
    UpToDate,
    /// The feed is newer but has no artifact for this platform target.
    NoArtifactForPlatform { version: String, target: String },
    /// The manifest version is unparseable.
    Unparseable,
}

/// Decide from a parsed `latest.json`: newer? has an artifact for `target`?
pub fn check_manifest(current: &str, manifest: &LatestManifest, target: &str) -> CheckResult {
    match should_update(current, &manifest.version) {
        UpdateDecision::UpdateAvailable => match manifest.platforms.get(target) {
            Some(entry) => CheckResult::Offer {
                version: manifest.version.clone(),
                url: entry.url.clone(),
            },
            None => CheckResult::NoArtifactForPlatform {
                version: manifest.version.clone(),
                target: target.to_string(),
            },
        },
        UpdateDecision::UpToDate | UpdateDecision::NoDowngrade => CheckResult::UpToDate,
        UpdateDecision::Unparseable => CheckResult::Unparseable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_update_offers_newer_only() {
        assert_eq!(
            should_update("0.7.0", "0.8.0"),
            UpdateDecision::UpdateAvailable
        );
        assert_eq!(
            should_update("0.7.0", "0.7.1"),
            UpdateDecision::UpdateAvailable
        );
        assert_eq!(
            should_update("0.7.0", "1.0.0"),
            UpdateDecision::UpdateAvailable
        );
    }

    #[test]
    fn should_update_up_to_date_and_downgrade() {
        assert_eq!(should_update("0.7.0", "0.7.0"), UpdateDecision::UpToDate);
        assert_eq!(should_update("0.8.0", "0.7.0"), UpdateDecision::NoDowngrade);
        assert_eq!(should_update("1.0.0", "0.9.9"), UpdateDecision::NoDowngrade);
    }

    #[test]
    fn should_update_tolerates_v_prefix() {
        assert_eq!(
            should_update("v0.7.0", "v0.8.0"),
            UpdateDecision::UpdateAvailable
        );
        assert_eq!(should_update("0.7.0", "v0.7.0"), UpdateDecision::UpToDate);
    }

    #[test]
    fn should_update_prerelease_ordering() {
        // 0.8.0-beta < 0.8.0 (semver prerelease precedence).
        assert_eq!(
            should_update("0.8.0-beta", "0.8.0"),
            UpdateDecision::UpdateAvailable
        );
        assert_eq!(
            should_update("0.8.0", "0.8.0-beta"),
            UpdateDecision::NoDowngrade
        );
    }

    #[test]
    fn should_update_unparseable() {
        assert_eq!(
            should_update("not-a-version", "1.0.0"),
            UpdateDecision::Unparseable
        );
        assert_eq!(
            should_update("1.0.0", "garbage"),
            UpdateDecision::Unparseable
        );
    }

    #[test]
    fn updater_state_reflects_config_presence() {
        // Disarmed: no pubkey.
        assert_eq!(
            updater_state(&UpdaterConfig {
                endpoints: vec!["https://x/latest.json".into()],
                pubkey: "".into()
            }),
            UpdaterState::DisarmedNoPubkey
        );
        // Disarmed: placeholder pubkey (the sentinel this crate ships).
        assert_eq!(
            updater_state(&UpdaterConfig {
                endpoints: vec!["https://x/latest.json".into()],
                pubkey: format!("dW50cnVzdGVk{PLACEHOLDER_PUBKEY_MARKER}"),
            }),
            UpdaterState::DisarmedNoPubkey
        );
        // Disarmed: pubkey but no endpoint.
        assert_eq!(
            updater_state(&UpdaterConfig {
                endpoints: vec![],
                pubkey: "realkeybase64".into()
            }),
            UpdaterState::DisarmedNoEndpoint
        );
        // Armed: both present.
        assert_eq!(
            updater_state(&UpdaterConfig {
                endpoints: vec!["https://x/latest.json".into()],
                pubkey: "realkeybase64".into(),
            }),
            UpdaterState::Armed
        );
    }

    #[test]
    fn platform_target_maps_macos_to_darwin() {
        assert_eq!(platform_target("linux", "x86_64"), "linux-x86_64");
        assert_eq!(platform_target("windows", "x86_64"), "windows-x86_64");
        assert_eq!(platform_target("macos", "aarch64"), "darwin-aarch64");
    }

    fn fixture_manifest() -> LatestManifest {
        serde_json::from_str(
            r#"{
              "version": "0.8.0",
              "notes": "test release",
              "pub_date": "2026-01-01T00:00:00Z",
              "platforms": {
                "linux-x86_64": { "signature": "SIG_L", "url": "https://x/app_0.8.0_amd64.AppImage" },
                "windows-x86_64": { "signature": "SIG_W", "url": "https://x/app_0.8.0_x64.msi" }
              }
            }"#,
        )
        .expect("fixture manifest parses")
    }

    #[test]
    fn check_manifest_offers_for_matching_platform() {
        let m = fixture_manifest();
        let r = check_manifest("0.7.0", &m, "linux-x86_64");
        assert_eq!(
            r,
            CheckResult::Offer {
                version: "0.8.0".into(),
                url: "https://x/app_0.8.0_amd64.AppImage".into(),
            }
        );
    }

    #[test]
    fn check_manifest_up_to_date() {
        let m = fixture_manifest();
        assert_eq!(
            check_manifest("0.8.0", &m, "linux-x86_64"),
            CheckResult::UpToDate
        );
        assert_eq!(
            check_manifest("0.9.0", &m, "linux-x86_64"),
            CheckResult::UpToDate
        );
    }

    #[test]
    fn check_manifest_no_artifact_for_platform() {
        let m = fixture_manifest();
        // Newer feed but no darwin artifact in the fixture.
        assert_eq!(
            check_manifest("0.7.0", &m, "darwin-aarch64"),
            CheckResult::NoArtifactForPlatform {
                version: "0.8.0".into(),
                target: "darwin-aarch64".into(),
            }
        );
    }

    #[test]
    fn first_check_delay_is_ten_seconds() {
        assert_eq!(FIRST_CHECK_DELAY, std::time::Duration::from_secs(10));
    }

    #[test]
    fn parse_updater_config_reads_plugins_block() {
        // The shape of `tauri.conf.json` `plugins` (what app.config().plugins yields).
        let plugins = serde_json::json!({
            "updater": {
                "endpoints": ["https://releases.freshell.app/latest.json"],
                "pubkey": "REPLACE_WITH_REAL_ED25519_PUBKEY"
            }
        });
        let cfg = parse_updater_config(&plugins);
        assert_eq!(
            cfg.endpoints,
            vec!["https://releases.freshell.app/latest.json"]
        );
        assert_eq!(cfg.pubkey, "REPLACE_WITH_REAL_ED25519_PUBKEY");
        // The shipped placeholder key → disarmed (CD-7 surfaced, not silent).
        assert_eq!(updater_state(&cfg), UpdaterState::DisarmedNoPubkey);
    }

    #[test]
    fn parse_updater_config_missing_is_disarmed() {
        let cfg = parse_updater_config(&serde_json::json!({}));
        assert!(cfg.endpoints.is_empty());
        assert!(cfg.pubkey.is_empty());
        assert_eq!(updater_state(&cfg), UpdaterState::DisarmedNoPubkey);
    }
}
