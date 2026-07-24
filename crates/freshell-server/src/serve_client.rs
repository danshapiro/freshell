//! Static serving of the RETAINED `dist/client` SPA + SPA-fallback routing
//! (Phase 3.10). A faithful port of `server/static-client-routes.ts`:
//!
//! * serve any real file under `dist/client` (index.html, `/assets/*`, icons,
//!   manifest, favicon) with the same cache policy the original applies;
//! * a missing `/assets/*` asset \u2192 `404` (never the SPA shell \u2014 a stale hashed
//!   asset must fail loudly, not silently resolve to index.html);
//! * every other unmatched path \u2192 `index.html` (the SPA client-router entry),
//!   served `no-store`.
//!
//! Unmatched `/api/*` requests are gated by the SAME auth check the original
//! applies BEFORE routing (`app.use('/api', httpAuthMiddleware)` \u2014
//! `server/index.ts:173` \u2014 runs ahead of every `/api` route, including the
//! catch-all 404 at `server/index.ts:667`): an unauthenticated unmatched `/api/*`
//! request is `401`, never a `404` that would disclose route existence (R12).
//! An authenticated unmatched `/api/*` request still gets a clean `404 {error}`
//! JSON here, never the HTML shell.
//!
//! Hand-rolled (no new crate deps) so the build stays hermetic; the content-type
//! and cache-header tables below cover Vite's output surface.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};

/// The axum fallback: resolve a request to a static file, the SPA shell, or a
/// clean 404/401 (for `/api/*` and missing hashed assets).
pub async fn serve(
    uri: Uri,
    headers: HeaderMap,
    client_dir: Arc<PathBuf>,
    auth_token: Arc<String>,
) -> Response {
    let raw_path = uri.path();

    // Unmatched /api/* (and bare /api): auth gate FIRST (R12), matching the
    // original's `app.use('/api', httpAuthMiddleware)` running ahead of the
    // catch-all 404 \u2014 an unauthenticated caller never learns the route is missing.
    if raw_path == "/api" || raw_path.starts_with("/api/") {
        if !crate::boot::is_authed(&headers, &auth_token) {
            return crate::boot::unauthorized();
        }
        return not_found_json();
    }

    let index = client_dir.join("index.html");
    let rel = sanitize_path(raw_path);

    // Root \u2192 the SPA entry.
    if rel.as_os_str().is_empty() {
        return serve_index(&index).await;
    }

    let candidate = client_dir.join(&rel);
    // Path-traversal guard: the resolved candidate must stay under client_dir.
    if !candidate.starts_with(client_dir.as_path()) {
        return not_found_plain();
    }

    match tokio::fs::read(&candidate).await {
        Ok(bytes) => file_response(&rel, bytes),
        Err(_) => {
            // A missing hashed asset must 404 (matches registerStaticClientRoutes'
            // `/assets/*` guard) rather than fall through to the SPA shell.
            if raw_path.starts_with("/assets/") {
                not_found_plain()
            } else {
                serve_index(&index).await
            }
        }
    }
}

/// Turn a request path into a safe relative path: drop empty/`.` segments, keep
/// `..` from escaping via `pop()`, and percent-decode each segment.
fn sanitize_path(raw: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for segment in raw.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                out.pop();
            }
            other => out.push(percent_decode(other)),
        }
    }
    out
}

/// Serve `index.html` with the original's no-store headers (so a client never
/// caches a stale shell that points at rotated asset hashes).
async fn serve_index(index: &Path) -> Response {
    match tokio::fs::read(index).await {
        Ok(bytes) => {
            let mut response = (StatusCode::OK, bytes).into_response();
            let h = response.headers_mut();
            // S2: Express's `res.type('html')` / `sendFile` reports the charset in
            // UPPERCASE (`UTF-8`) for the SPA shell \u2014 byte-match it exactly.
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=UTF-8"),
            );
            set_no_store(h);
            response
        }
        // If the client bundle is missing, say so plainly rather than 500-looping.
        Err(_) => (
            StatusCode::NOT_FOUND,
            "freshell client bundle not found (build dist/client)",
        )
            .into_response(),
    }
}

/// Serve a real static file with its content-type + the original's cache policy.
fn file_response(rel: &Path, bytes: Vec<u8>) -> Response {
    let mut response = (StatusCode::OK, bytes).into_response();
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(rel)),
    );

    let file_name = rel.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if file_name == "index.html" {
        set_no_store(h);
    } else if is_hashed_asset(rel) {
        // Vite content-hashes everything under /assets/ \u2192 safe to cache forever.
        h.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    } else {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    response
}

/// The no-store trio the original sets on index.html.
fn set_no_store(h: &mut axum::http::HeaderMap) {
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
    h.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    h.insert(header::EXPIRES, HeaderValue::from_static("0"));
}

/// A content-hashed immutable asset: lives under `assets/` and has a fingerprinted
/// name (Vite emits `assets/<name>-<hash>.<ext>`). Approximates the original's
/// `HASHED_ASSET_RE` without a regex dependency.
fn is_hashed_asset(rel: &Path) -> bool {
    let under_assets = rel
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .map(|first| first == "assets")
        .unwrap_or(false);
    if !under_assets {
        return false;
    }
    matches!(
        extension(rel),
        "js" | "mjs" | "css" | "svg" | "png" | "jpg" | "jpeg" | "gif" | "woff" | "woff2"
    )
}

/// Lowercased file extension, or `""` if none.
fn extension(rel: &Path) -> &str {
    rel.extension().and_then(|e| e.to_str()).unwrap_or("")
}

/// Map a file extension to a content-type covering Vite's output surface.
///
/// S2: `.js`/`.mjs` match Express's `mime`-package default of
/// `application/javascript` (not `text/javascript`), and the HTML shell's
/// charset casing is `UTF-8` (uppercase) to byte-match the original.
fn content_type(rel: &Path) -> &'static str {
    match extension(rel) {
        "html" => "text/html; charset=UTF-8",
        "js" | "mjs" => "application/javascript; charset=UTF-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Clean JSON 404 for an authenticated unmatched `/api/*` (mirrors
/// `res.status(404).json`).
fn not_found_json() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Body::from(r#"{"error":"Not found"}"#),
    )
        .into_response()
}

/// Plain 404 for a missing static/asset file. S2: Express's default
/// `res.status(404).send('Not found')` reports `text/html; charset=utf-8`
/// (lowercase, connect's plain-text-as-html default) \u2014 NOT `text/plain`.
fn not_found_plain() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        Body::from("Not found"),
    )
        .into_response()
}

/// Minimal `%XX` percent-decoder for request-path segments. Invalid escapes pass
/// through unchanged.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_and_contains_traversal() {
        assert_eq!(sanitize_path("/"), PathBuf::new());
        assert_eq!(
            sanitize_path("/assets/app-abc123.js"),
            PathBuf::from("assets/app-abc123.js")
        );
        // `..` can never escape the root.
        assert_eq!(
            sanitize_path("/../../etc/passwd"),
            PathBuf::from("etc/passwd")
        );
        assert_eq!(sanitize_path("/a/../b"), PathBuf::from("b"));
    }

    #[test]
    fn hashed_asset_detection() {
        assert!(is_hashed_asset(Path::new("assets/index-DEADBEEF.js")));
        assert!(is_hashed_asset(Path::new("assets/style-abc123.css")));
        assert!(!is_hashed_asset(Path::new("index.html")));
        assert!(!is_hashed_asset(Path::new("favicon.ico")));
        assert!(!is_hashed_asset(Path::new("manifest.webmanifest")));
    }

    #[test]
    fn content_types_cover_bundle_surface() {
        assert_eq!(
            content_type(Path::new("index.html")),
            "text/html; charset=UTF-8"
        );
        assert_eq!(
            content_type(Path::new("assets/x.js")),
            "application/javascript; charset=UTF-8"
        );
        assert_eq!(
            content_type(Path::new("assets/x.css")),
            "text/css; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("manifest.webmanifest")),
            "application/manifest+json; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("favicon.ico")), "image/x-icon");
        assert_eq!(content_type(Path::new("icon-512.png")), "image/png");
    }

    #[test]
    fn percent_decode_paths() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("plain.js"), "plain.js");
    }

    #[tokio::test]
    async fn unmatched_api_route_without_auth_is_401_not_404() {
        // R12: the auth gate must run BEFORE the unmatched-route 404, matching the
        // original's `app.use('/api', httpAuthMiddleware)` ordering.
        let dir = Arc::new(std::env::temp_dir());
        let auth = Arc::new("s3cr3t".to_string());
        let resp = serve(
            Uri::from_static("/api/definitely-not-a-route"),
            HeaderMap::new(),
            dir,
            auth,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn unmatched_api_route_with_auth_is_404_json() {
        let dir = Arc::new(std::env::temp_dir());
        let auth = Arc::new("s3cr3t".to_string());
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "s3cr3t".parse().unwrap());
        let resp = serve(
            Uri::from_static("/api/definitely-not-a-route"),
            headers,
            dir,
            auth,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json; charset=utf-8"
        );
    }
}
