//! `GET /api/repo-icon` and `GET /api/repo-icon/meta` — detect and serve the
//! icon of the git repo containing a supplied cwd. Cookie/header authed
//! (`boot::is_authed`), sandboxed (`files::is_path_allowed` + canonicalize
//! containment), cached in-process per repo root.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::repo_icon_detect::{detect_icon, sha256_hex, svg_is_dangerous};
use crate::repo_icon_git::{resolve_repo, RepoInfo};
use crate::settings_store::SettingsStore;

const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct RepoIconState {
    pub auth_token: Arc<String>,
    pub settings: SettingsStore,
    pub cache: Arc<Mutex<HashMap<PathBuf, CacheEntry>>>,
}

#[derive(Clone)]
pub struct CacheEntry {
    pub icon: Option<IconFile>,
    pub checked_at: Instant,
}

#[derive(Clone)]
pub struct IconFile {
    pub path: PathBuf,
    pub mtime: SystemTime,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct CwdQuery {
    cwd: Option<String>,
}

pub fn router(state: RepoIconState) -> Router {
    Router::new()
        .route("/api/repo-icon", get(serve_icon))
        .route("/api/repo-icon/meta", get(icon_meta))
        .with_state(state)
}

#[derive(Debug)]
enum ResolveFailure {
    BadRequest(&'static str),
    Forbidden,
    NotFound,
}

fn failure_response(failure: ResolveFailure) -> Response {
    match failure {
        ResolveFailure::BadRequest(msg) => crate::files::bad_request(msg),
        ResolveFailure::Forbidden => crate::files::forbidden(),
        ResolveFailure::NotFound => crate::files::not_found("Path not found"),
    }
}

/// Sandbox + resolve + detect (with cache). The `allowed_file_paths` sandbox
/// is a hard security boundary for file disclosure (see the "security-relevant"
/// R3/FILE-05 notes in files.rs and the rest-parity report), and this surface
/// walks UPWARD from the cwd — so the allowlist is enforced three times:
/// 1. on the raw normalized cwd (parity with the files.rs surfaces),
/// 2. re-checked on the CANONICAL cwd — a symlinked cwd inside an allowed root
///    must not escape it (parity with Node's realpath-before-allowlist in
///    `isPathAllowed`, `server/path-utils.ts:291-313`; since FILE-06
///    `files::is_path_allowed` itself canonicalizes both sides, check (1)
///    already resolves symlinks — this re-check is retained to keep the
///    raw → canonical → repo-root containment chain explicit),
/// 3. on the CANONICAL resolved repo root — the `.git` walk can land on an
///    ancestor outside every allowed root, and everything served comes from
///    under it.
///
/// Separately, the winning candidate is canonicalized and must stay inside the
/// repo root after symlink resolution (repo-root containment, not allowlist).
fn resolve_repo_and_icon(
    state: &RepoIconState,
    cwd_param: &str,
    allowed_roots: Option<&[String]>,
) -> Result<(RepoInfo, Option<IconFile>), ResolveFailure> {
    let normalized = crate::files::normalize_user_path(cwd_param);
    if !Path::new(&normalized).is_absolute() {
        return Err(ResolveFailure::BadRequest("cwd must be an absolute path"));
    }
    // (1) raw-path check first: clearly-disallowed paths get Forbidden before
    // any repo resolution (matches files.rs ordering; since FILE-06
    // is_path_allowed itself canonicalizes, so symlinked raw paths deny here).
    if !crate::files::is_path_allowed(&normalized, allowed_roots) {
        return Err(ResolveFailure::Forbidden);
    }
    let canonical_cwd = std::fs::canonicalize(&normalized).map_err(|_| ResolveFailure::NotFound)?;
    // (2) re-check the canonical cwd: symlink-escape defense.
    if !crate::files::is_path_allowed(&canonical_cwd.to_string_lossy(), allowed_roots) {
        return Err(ResolveFailure::Forbidden);
    }
    let repo = resolve_repo(&canonical_cwd);
    let repo_root = std::fs::canonicalize(&repo.repo_root).map_err(|_| ResolveFailure::NotFound)?;
    // (3) the upward `.git` walk must not leave the sandbox: bytes are served
    // from under repo_root, so repo_root itself must be allowed.
    if !crate::files::is_path_allowed(&repo_root.to_string_lossy(), allowed_roots) {
        return Err(ResolveFailure::Forbidden);
    }
    let repo = RepoInfo {
        checkout_root: repo.checkout_root,
        repo_root: repo_root.clone(),
    };

    if let Ok(cache) = state.cache.lock() {
        if let Some(entry) = cache.get(&repo_root).cloned() {
            match &entry.icon {
                Some(icon) => {
                    if let Ok(meta) = std::fs::metadata(&icon.path) {
                        if meta.modified().ok() == Some(icon.mtime) && meta.len() == icon.size {
                            return Ok((repo, entry.icon));
                        }
                    }
                    // Winner changed or vanished -> fall through to re-detect.
                }
                None => {
                    if entry.checked_at.elapsed() < NEGATIVE_CACHE_TTL {
                        return Ok((repo, None));
                    }
                }
            }
        }
    }

    let icon = detect_icon(&repo_root)
        .and_then(|path| std::fs::canonicalize(&path).ok())
        .filter(|canonical| canonical.starts_with(&repo_root))
        .and_then(|canonical| {
            let meta = std::fs::metadata(&canonical).ok()?;
            Some(IconFile {
                path: canonical,
                mtime: meta.modified().ok()?,
                size: meta.len(),
            })
        });
    if let Ok(mut cache) = state.cache.lock() {
        cache.insert(
            repo_root,
            CacheEntry {
                icon: icon.clone(),
                checked_at: Instant::now(),
            },
        );
    }
    Ok((repo, icon))
}

fn content_type_for(ext: &str) -> &'static str {
    // Mirrors serve_client.rs's hand-rolled table for the image surface.
    match ext {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

async fn icon_meta(
    State(state): State<RepoIconState>,
    headers: HeaderMap,
    Query(q): Query<CwdQuery>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }
    let Some(cwd) = q.cwd.filter(|c| !c.is_empty()) else {
        return crate::files::bad_request("cwd query parameter required");
    };
    let settings = state.settings.get().await;
    match resolve_repo_and_icon(&state, &cwd, settings.allowed_file_paths.as_deref()) {
        Ok((repo, icon)) => {
            let repo_name = repo
                .repo_root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| repo.repo_root.to_string_lossy().into_owned());
            Json(json!({
                "repoRoot": repo.repo_root.to_string_lossy(),
                "checkoutRoot": repo.checkout_root.to_string_lossy(),
                "repoName": repo_name,
                "hasIcon": icon.is_some(),
            }))
            .into_response()
        }
        Err(failure) => failure_response(failure),
    }
}

async fn serve_icon(
    State(state): State<RepoIconState>,
    headers: HeaderMap,
    Query(q): Query<CwdQuery>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }
    let Some(cwd) = q.cwd.filter(|c| !c.is_empty()) else {
        return crate::files::bad_request("cwd query parameter required");
    };
    let settings = state.settings.get().await;
    let icon = match resolve_repo_and_icon(&state, &cwd, settings.allowed_file_paths.as_deref()) {
        Ok((_, Some(icon))) => icon,
        Ok((_, None)) => return crate::files::not_found("No repo icon detected"),
        Err(failure) => return failure_response(failure),
    };
    let Ok(mut bytes) = std::fs::read(&icon.path) else {
        return crate::files::not_found("No repo icon detected");
    };
    let ext = icon
        .path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    // Belt-and-braces: the detector already rejects dangerous SVGs, but the
    // file may have changed between detection and serving.
    if ext == "svg" && svg_is_dangerous(&String::from_utf8_lossy(&bytes)) {
        return crate::files::not_found("No repo icon detected");
    }
    let mut content_type = content_type_for(&ext);
    // .icns cannot render in <img>; serve the embedded PNG instead.
    if ext == "icns" {
        match crate::repo_icon_detect::icns_embedded_png(&bytes) {
            Some(png) => {
                bytes = png;
                content_type = "image/png";
            }
            None => return crate::files::not_found("No repo icon detected"),
        }
    }
    let mtime_ms = icon
        .mtime
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let etag_input = format!("{}|{}|{}", icon.path.display(), mtime_ms, icon.size);
    let etag = format!("\"{}\"", &sha256_hex(etag_input.as_bytes())[..16]);
    let etag_header = HeaderValue::from_str(&etag).ok();
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        let mut resp = StatusCode::NOT_MODIFIED.into_response();
        if let Some(v) = etag_header {
            resp.headers_mut().insert(header::ETAG, v);
        }
        return resp;
    }
    let mut resp = (StatusCode::OK, bytes).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=60"),
    );
    if let Some(v) = etag_header {
        h.insert(header::ETAG, v);
    }
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if ext == "svg" {
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"),
        );
        h.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("inline"),
        );
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::fs;
    use std::sync::Arc;
    use tower::util::ServiceExt;

    use crate::settings_store::SettingsStore;

    fn test_state() -> RepoIconState {
        RepoIconState {
            auth_token: Arc::new("tok".to_string()),
            settings: SettingsStore::load(None, Vec::new()),
            cache: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    fn mkrepo_with_icon(tmp: &tempfile::TempDir) -> std::path::PathBuf {
        let repo = tmp.path().join("proj");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("public")).unwrap();
        fs::write(
            repo.join("public/favicon.svg"),
            "<svg viewBox=\"0 0 16 16\"><circle r=\"8\"/></svg>",
        )
        .unwrap();
        repo
    }

    async fn get(
        router: axum::Router,
        uri: &str,
        auth: bool,
        extra: &[(&str, &str)],
    ) -> axum::response::Response {
        let mut req = Request::builder().method("GET").uri(uri);
        if auth {
            req = req.header("x-auth-token", "tok");
        }
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        router
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn icon_uri(repo: &std::path::Path) -> String {
        format!(
            "/api/repo-icon?cwd={}",
            urlencoding_encode(&repo.to_string_lossy())
        )
    }

    /// Minimal percent-encoder for test URIs (only what a path needs).
    fn urlencoding_encode(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn unauthenticated_is_401() {
        let resp = get(router(test_state()), "/api/repo-icon?cwd=/tmp", false, &[]).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn relative_cwd_is_400_and_missing_dir_is_404() {
        let router1 = router(test_state());
        let resp = get(router1, "/api/repo-icon/meta?cwd=relative/path", true, &[]).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let router2 = router(test_state());
        let resp = get(
            router2,
            "/api/repo-icon/meta?cwd=/definitely/not/a/real/dir/anywhere",
            true,
            &[],
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn disallowed_path_is_forbidden() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp);
        let state = test_state();
        let outcome = resolve_repo_and_icon(
            &state,
            &repo.to_string_lossy(),
            Some(&["/some/other/allowed/root".to_string()]),
        );
        assert!(matches!(outcome, Err(ResolveFailure::Forbidden)));
    }

    #[tokio::test]
    async fn meta_reports_repo_and_icon() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp);
        let sub = repo.join("src");
        fs::create_dir_all(&sub).unwrap();
        let uri = format!(
            "/api/repo-icon/meta?cwd={}",
            urlencoding_encode(&sub.to_string_lossy())
        );
        let resp = get(router(test_state()), &uri, true, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["repoName"], "proj");
        assert_eq!(v["hasIcon"], true);
        let canonical = std::fs::canonicalize(&repo).unwrap();
        assert_eq!(v["repoRoot"], canonical.to_string_lossy().as_ref());
    }

    #[tokio::test]
    async fn icon_serves_svg_with_security_headers_and_etag_304() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp);
        let uri = icon_uri(&repo);
        let resp = get(router(test_state()), &uri, true, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let headers = resp.headers().clone();
        assert_eq!(headers["content-type"], "image/svg+xml");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(
            headers["content-security-policy"],
            "default-src 'none'; style-src 'unsafe-inline'"
        );
        assert_eq!(headers["content-disposition"], "inline");
        assert_eq!(headers["cache-control"], "private, max-age=60");
        let etag = headers["etag"].to_str().unwrap().to_string();
        let resp2 = get(
            router(test_state()),
            &uri,
            true,
            &[("if-none-match", etag.as_str())],
        )
        .await;
        assert_eq!(resp2.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn serves_icns_winner_as_png() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        fs::create_dir_all(repo.join(".git")).unwrap();
        // Build an icns wrapping a 128x128 synthetic PNG (same layout as icns_tests).
        let mut png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&128u32.to_be_bytes());
        png.extend_from_slice(&128u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut body = b"ic07".to_vec();
        body.extend_from_slice(&((png.len() as u32) + 8).to_be_bytes());
        body.extend_from_slice(&png);
        let mut icns = b"icns".to_vec();
        icns.extend_from_slice(&((body.len() as u32) + 8).to_be_bytes());
        icns.extend_from_slice(&body);
        fs::write(repo.join("icon.icns"), icns).unwrap();

        let resp = get(router(test_state()), &icon_uri(&repo), true, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers().get("content-type").unwrap(), "image/png");
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            &bytes[0..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
    }

    #[tokio::test]
    async fn no_icon_is_404_and_meta_has_icon_false() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("bare");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let resp = get(router(test_state()), &icon_uri(&repo), true, &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let uri = format!(
            "/api/repo-icon/meta?cwd={}",
            urlencoding_encode(&repo.to_string_lossy())
        );
        let resp = get(router(test_state()), &uri, true, &[]).await;
        let v = body_json(resp).await;
        assert_eq!(v["hasIcon"], false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_escape_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.png");
        // A valid square PNG outside the repo.
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&128u32.to_be_bytes());
        png.extend_from_slice(&128u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        fs::write(&outside, png).unwrap();
        let repo = tmp.path().join("proj");
        fs::create_dir_all(repo.join(".git")).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("logo.png")).unwrap();
        let resp = get(router(test_state()), &icon_uri(&repo), true, &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn repo_root_outside_allowlist_is_forbidden() {
        // cwd is inside an allowed root, but the `.git` walk resolves the repo
        // root to an ANCESTOR outside every allowed root -> Forbidden. The
        // upward walk must never serve bytes from outside the sandbox.
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp); // tmp/proj: has .git + icon
        let inner = repo.join("workdir");
        fs::create_dir_all(&inner).unwrap();
        let state = test_state();
        let outcome = resolve_repo_and_icon(
            &state,
            &inner.to_string_lossy(),
            Some(&[inner.to_string_lossy().into_owned()]), // only workdir allowed
        );
        assert!(matches!(outcome, Err(ResolveFailure::Forbidden)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_cwd_escaping_allowlist_is_forbidden() {
        // A symlink INSIDE an allowed root pointing OUTSIDE it: the raw path
        // passes the string-prefix check, so the canonical path must be
        // re-checked (Node realpath parity).
        let tmp = tempfile::tempdir().unwrap();
        let outside_repo = mkrepo_with_icon(&tmp); // tmp/proj, outside allowed
        let allowed = tmp.path().join("allowed");
        fs::create_dir_all(&allowed).unwrap();
        std::os::unix::fs::symlink(&outside_repo, allowed.join("link")).unwrap();
        let state = test_state();
        let outcome = resolve_repo_and_icon(
            &state,
            &allowed.join("link").to_string_lossy(),
            Some(&[allowed.to_string_lossy().into_owned()]),
        );
        assert!(matches!(outcome, Err(ResolveFailure::Forbidden)));
    }

    #[tokio::test]
    async fn cache_invalidates_when_icon_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp);
        let state = test_state();
        let r1 = router(state.clone());
        assert_eq!(
            get(r1, &icon_uri(&repo), true, &[]).await.status(),
            StatusCode::OK
        );
        fs::remove_file(repo.join("public/favicon.svg")).unwrap();
        let r2 = router(state);
        assert_eq!(
            get(r2, &icon_uri(&repo), true, &[]).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn serves_icon_found_by_deep_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("deep");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let assets = repo.join("src/App/Assets");
        fs::create_dir_all(&assets).unwrap();
        // Minimal valid ICO (same byte layout as tier4_tests::write_ico).
        let mut ico = vec![0u8, 0, 1, 0, 1, 0];
        ico.extend_from_slice(&[64, 64, 0, 0, 1, 0, 32, 0]);
        ico.extend_from_slice(&40u32.to_le_bytes());
        ico.extend_from_slice(&22u32.to_le_bytes());
        ico.resize(22 + 40, 0);
        fs::write(assets.join("AppIcon.ico"), ico).unwrap();

        let uri = format!(
            "/api/repo-icon/meta?cwd={}",
            urlencoding_encode(&repo.to_string_lossy())
        );
        let meta = get(router(test_state()), &uri, true, &[]).await;
        assert_eq!(meta.status(), StatusCode::OK);
        assert_eq!(body_json(meta).await["hasIcon"], true);
        let icon = get(router(test_state()), &icon_uri(&repo), true, &[]).await;
        assert_eq!(icon.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn worktree_cwd_resolves_to_main_repo_icon() {
        let tmp = tempfile::tempdir().unwrap();
        let main_repo = mkrepo_with_icon(&tmp); // "proj", has public/favicon.svg
        let wt_gitdir = main_repo.join(".git/worktrees/wt1");
        fs::create_dir_all(&wt_gitdir).unwrap();
        fs::write(wt_gitdir.join("commondir"), "../..\n").unwrap();
        let worktree = tmp.path().join("wt1");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", wt_gitdir.display()),
        )
        .unwrap();
        let uri = format!(
            "/api/repo-icon/meta?cwd={}",
            urlencoding_encode(&worktree.to_string_lossy())
        );
        let resp = get(router(test_state()), &uri, true, &[]).await;
        let v = body_json(resp).await;
        assert_eq!(v["repoName"], "proj");
        assert_eq!(v["hasIcon"], true);
    }
}
