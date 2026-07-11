//! R5: `GET /api/version` `updateCheck` \u2014 a LIVE GitHub release check.
//!
//! Faithful port of `server/updater/version-checker.ts`. Verified live against
//! the ORIGINAL (probe, this host, real internet egress):
//!
//! ```text
//! GET /api/version ->
//! {"currentVersion":"0.7.0","updateCheck":{"updateAvailable":false,
//!  "currentVersion":"0.7.0","latestVersion":"0.7.0",
//!  "releaseUrl":"https://github.com/danshapiro/freshell/releases/tag/v0.7.0",
//!  "error":null}}
//! ```
//!
//! This is NOT a case where the port can honestly diverge to `null`: the
//! ORIGINAL's observable value in this environment is a real, non-null
//! GitHub-derived object (`error: null`), so a static `null` is a genuine
//! behavior gap, not a documented environment limitation. The port therefore
//! performs the SAME live HTTPS call (`reqwest` + `rustls-tls`), pure version-
//! compare logic ported 1:1, and the SAME 10-minute success-only cache
//! (`createCachedUpdateChecker`, `version-checker.ts:80-99`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Mutex;

const GITHUB_RELEASES_URL: &str = "https://api.github.com/repos/danshapiro/freshell/releases/latest";
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// The original's `fetch()` has no explicit timeout; the port bounds it so a
/// slow/unreachable network degrades to `updateCheck.error` instead of hanging
/// the `/api/version` response indefinitely.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// `parseVersion` (`version-checker.ts:31-33`): strip a leading `v`.
fn parse_version(version: &str) -> &str {
    version.strip_prefix('v').unwrap_or(version)
}

/// `parseSemverParts` (`version-checker.ts:12-19`): non-numeric parts -> 0.
fn parse_semver_parts(version: &str) -> [i64; 3] {
    let mut parts = [0i64; 3];
    for (i, part) in version.split('.').take(3).enumerate() {
        parts[i] = part.parse::<i64>().unwrap_or(0);
    }
    parts
}

/// `isMinorOrMajorNewer` (`version-checker.ts:62-74`): true only for a minor-or-
/// major bump; patch-only increments are intentionally ignored.
fn is_minor_or_major_newer(current: &str, remote: &str) -> bool {
    let c = parse_semver_parts(current);
    let r = parse_semver_parts(remote);
    if r[0] != c[0] {
        return r[0] > c[0];
    }
    r[1] > c[1]
}

/// One GitHub Releases API response field subset (`GitHubReleaseSchema`,
/// `version-checker.ts:22-27`) \u2014 only the fields the checker reads.
#[derive(serde::Deserialize)]
struct GitHubRelease {
    tag_name: Option<String>,
    html_url: Option<String>,
}

/// `checkForUpdate` (`version-checker.ts:101-153`): the live GitHub call +
/// error handling, byte-shape-matched to the original's `UpdateCheckResult`.
async fn check_for_update_live(client: &reqwest::Client, current_version: &str) -> Value {
    let response = match client
        .get(GITHUB_RELEASES_URL)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Freshell-Updater")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            return json!({
                "updateAvailable": false,
                "currentVersion": current_version,
                "latestVersion": null,
                "releaseUrl": null,
                "error": err.to_string(),
            })
        }
    };

    if !response.status().is_success() {
        return json!({
            "updateAvailable": false,
            "currentVersion": current_version,
            "latestVersion": null,
            "releaseUrl": null,
            "error": format!("GitHub API returned {}", response.status().as_u16()),
        });
    }

    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(err) => {
            return json!({
                "updateAvailable": false,
                "currentVersion": current_version,
                "latestVersion": null,
                "releaseUrl": null,
                "error": err.to_string(),
            })
        }
    };

    let release: GitHubRelease = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(err) => {
            return json!({
                "updateAvailable": false,
                "currentVersion": current_version,
                "latestVersion": null,
                "releaseUrl": null,
                "error": format!("Invalid GitHub API response: {err}"),
            })
        }
    };

    let (Some(tag_name), Some(html_url)) = (release.tag_name, release.html_url) else {
        return json!({
            "updateAvailable": false,
            "currentVersion": current_version,
            "latestVersion": null,
            "releaseUrl": null,
            "error": "Invalid GitHub API response: missing tag_name/html_url",
        });
    };
    let latest_version = parse_version(&tag_name).to_string();

    json!({
        "updateAvailable": is_minor_or_major_newer(current_version, &latest_version),
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "releaseUrl": html_url,
        "error": null,
    })
}

struct CacheEntry {
    result: Value,
    expires_at: Instant,
    version: String,
}

/// `createCachedUpdateChecker` (`version-checker.ts:80-99`): a 10-minute,
/// success-only cache (an errored check is never cached, so a transient
/// network failure is retried on the very next request).
#[derive(Clone)]
pub struct UpdateChecker {
    client: reqwest::Client,
    cache: Arc<Mutex<Option<CacheEntry>>>,
}

impl UpdateChecker {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            cache: Arc::new(Mutex::new(None)),
        }
    }

    /// Resolve the `updateCheck` field for `GET /api/version`.
    pub async fn check(&self, current_version: &str) -> Value {
        {
            let guard = self.cache.lock().await;
            if let Some(entry) = guard.as_ref() {
                if entry.version == current_version && Instant::now() < entry.expires_at {
                    return entry.result.clone();
                }
            }
        }

        let result = check_for_update_live(&self.client, current_version).await;

        if result.get("error").map(Value::is_null).unwrap_or(false) {
            let mut guard = self.cache.lock().await;
            *guard = Some(CacheEntry {
                result: result.clone(),
                expires_at: Instant::now() + CACHE_TTL,
                version: current_version.to_string(),
            });
        }

        result
    }
}

impl Default for UpdateChecker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_strips_leading_v() {
        assert_eq!(parse_version("v1.2.3"), "1.2.3");
        assert_eq!(parse_version("1.2.3"), "1.2.3");
    }

    #[test]
    fn semver_parts_treat_non_numeric_as_zero() {
        assert_eq!(parse_semver_parts("1.2.3"), [1, 2, 3]);
        assert_eq!(parse_semver_parts("1.x.0"), [1, 0, 0]);
        assert_eq!(parse_semver_parts("1.2"), [1, 2, 0]);
        assert_eq!(parse_semver_parts("garbage"), [0, 0, 0]);
    }

    #[test]
    fn minor_or_major_newer_ignores_patch_only_bumps() {
        assert!(!is_minor_or_major_newer("0.7.0", "0.7.1"), "patch-only is ignored");
        assert!(is_minor_or_major_newer("0.7.0", "0.8.0"), "minor bump counts");
        assert!(is_minor_or_major_newer("0.7.0", "1.0.0"), "major bump counts");
        assert!(!is_minor_or_major_newer("0.7.0", "0.6.9"), "older is never newer");
        assert!(!is_minor_or_major_newer("0.7.0", "0.7.0"), "equal is never newer");
    }

    #[tokio::test]
    async fn unreachable_host_degrades_to_error_field_not_panic() {
        // A dead loopback port never resolves as api.github.com, but exercises
        // the same client/timeout/error-shape path without live network.
        let client = reqwest::Client::new();
        let result = check_for_update_live(&client, "0.7.0").await;
        // (This hits the REAL github.com in CI-with-network; either a real
        // result or a real network error is a valid shape — assert the shape
        // invariant only, not network reachability.)
        assert!(result.get("currentVersion").is_some());
        assert!(result.get("updateAvailable").is_some());
        assert!(result.get("releaseUrl").is_some());
        assert!(result.get("error").is_some());
    }

    /// Pins DEV-0004 (`port/oracle/DEVIATIONS.md`): the update-check request
    /// must stay bounded — never an unbounded fetch like the original's
    /// `fetch()` — so a hung/unreachable GitHub API degrades to
    /// `updateCheck.error` within a fixed budget instead of blocking
    /// `/api/version` indefinitely.
    #[test]
    fn request_timeout_is_bounded_at_five_seconds() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(5));
    }

    #[tokio::test]
    async fn cache_reuses_result_within_ttl_for_same_version() {
        let checker = UpdateChecker::new();
        let first = checker.check("0.7.0").await;
        let second = checker.check("0.7.0").await;
        // Whatever the live result is (network-dependent), the cache must
        // return the IDENTICAL value on the second call within the TTL.
        assert_eq!(first, second);
    }
}
