//! `POST /api/fresh-agent/attachments` — a faithful port of the Node oracle
//! route (`server/fresh-agent-extras-router.ts:10,15-22,268-287`) so the
//! fresh-agent composer's paperclip upload
//! (`src/components/fresh-agent/FreshAgentComposer.tsx:160-174`, which fetches
//! `POST /api/fresh-agent/attachments?name=<raw>` with the raw `File` body)
//! works on the Rust server leg.
//!
//! # Parity table (Node oracle → this port)
//!
//! | Node oracle behavior | This port |
//! |---|---|
//! | `ATTACHMENT_MAX_BYTES = 10*1024*1024` (router.ts:10), enforced by `raw({ type, limit })` | `ATTACHMENT_MAX_BYTES`; `DefaultBodyLimit::max(...)` scoped to this sub-router — `Bytes` extraction over the cap rejects 413 |
//! | missing/empty/non-string `?name` → 400 `{"error":"name query parameter required"}` (repeated `name` is an array, not a string) | `Query<Vec<(String, String)>>` preserves repeated keys; missing/empty/repeated → the identical 400 |
//! | body must be a non-empty `application/octet-stream` buffer (raw's `type-is` gate) → 400 `{"error":"attachment body must be a non-empty application/octet-stream"}` | content-type matched case-insensitively on the type token before `;`, AND body non-empty → the identical 400 |
//! | stores under `<os.homedir()>/.freshell/attachments/` (router.ts:20-22) | the same boot-resolved `home` threaded to `checkpoints_state` (`main.rs`) — equals `os.homedir()` whenever `FRESHELL_HOME` is unset — joined with `.freshell/attachments` |
//! | filename `<randomUUID().slice(0,8)>-<sanitizeFilename(name)>` | `<first 8 hex of uuid4-simple>-<sanitize_filename(name)>` (same first-8-hex rendering) |
//! | 200 `{path, bytes}` — plain body, no envelope | identical |
//! | `sanitizeFilename`: POSIX basename (`path.basename`), then every char outside `[a-zA-Z0-9._-]` → `_` per UTF-16 code unit (astral chars become TWO `_`), empty → `'attachment'` | `sanitize_filename` below |
//!
//! # Declared divergences
//!
//! 1. fs write failure → `500 {"error":"failed to save attachment"}` +
//!    `tracing::warn!`. Node leaves the response hanging forever on an fs
//!    rejection (the `await fsp.writeFile(...)` rejection is unhandled). A
//!    visible 500 preserves the failure visibility this work item is about.
//! 2. 413 body format: express emits an HTML error page, axum emits its
//!    default rejection body. The STATUS is the contract; the client maps on
//!    status and never parses the 413 body (`attachmentUploadErrorMessage` in
//!    `FreshAgentComposer.tsx`).
//! 3. At the (wrong content-type × over-cap) intersection Node yields 400
//!    while this port yields 413: express's `raw({ type })` never buffers the
//!    body on a type mismatch so the handler's 400 is reached, whereas `Bytes`
//!    extraction rejects over-cap with 413 before the handler's content-type
//!    check. Unreachable from the real composer, which always sends
//!    `application/octet-stream`.
//!
//! # Auth ordering (reproduces Node's middleware-first behavior)
//!
//! Node wires `authenticateToken` as app middleware BEFORE this route's
//! `raw({ limit })` body parser, so an UNAUTHENTICATED over-cap request is
//! 401, never 413. Axum `.layer()` calls wrap in reverse application order,
//! so `middleware::from_fn_with_state(state, require_auth)` — added AFTER
//! `DefaultBodyLimit::max(...)` — is the OUTERMOST layer of this sub-router
//! and runs before the body limit is consulted. The handler itself contains
//! no auth code.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::json;

use crate::boot::{is_authed, unauthorized};

/// `ATTACHMENT_MAX_BYTES` (`fresh-agent-extras-router.ts:10`): 10 MiB upload
/// cap, enforced here by `DefaultBodyLimit` + `Bytes` extraction rather than
/// express's `raw({ limit })`.
const ATTACHMENT_MAX_BYTES: usize = 10 * 1024 * 1024;

/// Shared state for the `/api/fresh-agent/attachments` route.
#[derive(Clone)]
pub struct AttachmentsApiState {
    /// Mirrors `CheckpointsApiState::auth_token` — consumed by the outermost
    /// `require_auth` middleware, never by the handler.
    pub auth_token: Arc<String>,
    /// Boot-resolved home whose `.freshell/attachments/` holds saved uploads
    /// (mirrors `os.homedir()` in Node's `attachmentsDir`,
    /// `fresh-agent-extras-router.ts:20-22`; boot `home` equals `os.homedir()`
    /// whenever `FRESHELL_HOME` is unset).
    pub home: Arc<PathBuf>,
}

/// The `/api/fresh-agent/attachments` sub-router. `require_auth` is layered
/// last precisely so it becomes the OUTERMOST layer (axum layers wrap in
/// reverse order), preserving Node's auth-before-body-read ordering — see the
/// module doc comment.
pub fn router(state: AttachmentsApiState) -> Router {
    Router::new()
        .route("/api/fresh-agent/attachments", post(upload_attachment))
        .layer(DefaultBodyLimit::max(ATTACHMENT_MAX_BYTES))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state)
}

/// Node middleware-first ordering, reproduced: this runs BEFORE the body
/// limit, so an unauthenticated over-cap request is 401, not 413.
async fn require_auth(
    State(state): State<AttachmentsApiState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if !is_authed(request.headers(), &state.auth_token) {
        return unauthorized();
    }
    next.run(request).await
}

/// `router.post('/attachments', ...)` handler (`fresh-agent-extras-router.ts:268-287`),
/// minus auth (enforced by the outermost `require_auth` layer above). Named
/// checks come before body checks, exactly like the oracle.
async fn upload_attachment(
    State(state): State<AttachmentsApiState>,
    headers: HeaderMap,
    Query(names): Query<Vec<(String, String)>>,
    body: Bytes,
) -> Response {
    // Express `typeof req.query.name !== 'string'` parity: `Query<Vec<..>>`
    // keeps repeated keys AND unrelated keys, so first filter to pairs whose
    // key IS `name` (Node reads `req.query.name`; other keys are ignored),
    // then require exactly one non-empty value — missing, empty (`?name=`),
    // and repeated `name` keys all reject.
    let names: Vec<&String> = names
        .iter()
        .filter(|(key, _)| key == "name")
        .map(|(_, value)| value)
        .collect();
    let name = match names.as_slice() {
        [value] if !value.is_empty() => (*value).clone(),
        _ => return bad_request("name query parameter required"),
    };

    if !is_octet_stream(&headers) || body.is_empty() {
        return bad_request("attachment body must be a non-empty application/octet-stream");
    }

    let dir = state.home.join(".freshell").join("attachments");
    if let Err(error) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!(%error, dir = %dir.display(), "failed to save attachment (mkdir)");
        return save_failure();
    }
    let uuid8 = uuid::Uuid::new_v4().simple().to_string();
    // `simple()` renders exactly 32 lowercase hex chars, so the first-8 slice
    // mirrors Node's `randomUUID().slice(0, 8)` and can never run short.
    let filename = format!("{}-{}", &uuid8[..8], sanitize_filename(&name));
    let target = dir.join(filename);
    if let Err(error) = tokio::fs::write(&target, &body).await {
        tracing::warn!(%error, target = %target.display(), "failed to save attachment (write)");
        return save_failure();
    }

    Json(json!({ "path": target.display().to_string(), "bytes": body.len() })).into_response()
}

/// `sanitizeFilename` (`fresh-agent-extras-router.ts:15-18`): POSIX basename
/// semantics (strip trailing '/', take the segment after the LAST '/' — '\'
/// is NOT a separator), then every char outside `[a-zA-Z0-9._-]` → '_' PER
/// UTF-16 CODE UNIT (astral chars like emoji become TWO underscores; é becomes
/// ONE), empty → 'attachment'.
pub(crate) fn sanitize_filename(name: &str) -> String {
    // Node's `path.posix.basename`: trailing slashes do not produce a segment,
    // so an all-slashes input basenames to '' (→ 'attachment'), never '/'.
    let base = name.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let mut out = String::with_capacity(base.len());
    for unit in base.encode_utf16() {
        let kept = char::from_u32(u32::from(unit))
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        match kept {
            Some(c) => out.push(c),
            // Surrogate halves (and every other disallowed code unit) each
            // become one '_', so an astral char yields two.
            None => out.push('_'),
        }
    }
    if out.is_empty() {
        "attachment".to_string()
    } else {
        out
    }
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn save_failure() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "failed to save attachment" })),
    )
        .into_response()
}

/// Node's `type-is` semantics behind `raw({ type })`: the content-type header
/// (absent → false) matches when its type token — everything before the first
/// `;`, trimmed — equals `application/octet-stream` case-insensitively.
fn is_octet_stream(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/octet-stream")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tower::ServiceExt;

    const OCTET_STREAM: &str = "application/octet-stream";
    const NAME_MSG: &str = "name query parameter required";
    const BODY_MSG: &str = "attachment body must be a non-empty application/octet-stream";

    fn state(home: &Path) -> AttachmentsApiState {
        AttachmentsApiState {
            auth_token: Arc::new("tok".to_string()),
            home: Arc::new(home.to_path_buf()),
        }
    }

    fn post_upload(
        query: &str,
        token: Option<&str>,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> axum::http::Request<axum::body::Body> {
        let mut builder = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/api/fresh-agent/attachments{query}"));
        if let Some(token) = token {
            builder = builder.header("x-auth-token", token);
        }
        if let Some(content_type) = content_type {
            builder = builder.header("content-type", content_type);
        }
        builder.body(axum::body::Body::from(body)).unwrap()
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    async fn assert_error(resp: Response, status: StatusCode, message: &str) {
        assert_eq!(resp.status(), status);
        let value = body_json(resp).await;
        assert_eq!(value, json!({ "error": message }));
    }

    /// Node oracle: "saves a raw binary attachment and returns its path".
    #[tokio::test]
    async fn saves_a_raw_binary_attachment_and_returns_its_path() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(post_upload(
                "?name=note.txt",
                Some("tok"),
                Some(OCTET_STREAM),
                b"hello attachment".to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["bytes"], json!(16));

        let saved_path = PathBuf::from(value["path"].as_str().unwrap());
        let attachments_dir = home.path().join(".freshell").join("attachments");
        assert_eq!(saved_path.parent().unwrap(), attachments_dir.as_path());
        let basename = saved_path.file_name().unwrap().to_str().unwrap();
        assert!(
            regex::Regex::new(r"^[0-9a-f]{8}-note\.txt$")
                .unwrap()
                .is_match(basename),
            "unexpected saved basename: {basename}"
        );
        let disk = tokio::fs::read(&saved_path).await.unwrap();
        assert_eq!(disk, b"hello attachment");
    }

    /// Node oracle: "sanitizes hostile filenames".
    #[tokio::test]
    async fn sanitizes_hostile_filenames_before_saving() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(post_upload(
                "?name=../../etc/passwd",
                Some("tok"),
                Some(OCTET_STREAM),
                b"x".to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;

        let saved_path = PathBuf::from(value["path"].as_str().unwrap());
        let attachments_dir = home.path().join(".freshell").join("attachments");
        assert_eq!(saved_path.parent().unwrap(), attachments_dir.as_path());
        let basename = saved_path.file_name().unwrap().to_str().unwrap();
        assert!(
            !basename.contains(".."),
            "basename must not retain traversal: {basename}"
        );
        assert!(
            basename.ends_with("-passwd"),
            "basename must keep the sanitized name: {basename}"
        );
        let disk = tokio::fs::read(&saved_path).await.unwrap();
        assert_eq!(disk, b"x");
    }

    /// Node oracle: "rejects missing name and empty body", plus repeated-name
    /// parity (`typeof name !== 'string'` when express yields an array).
    #[tokio::test]
    async fn rejects_missing_name_empty_name_and_empty_body() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));

        // No `name` at all (empty body alongside — name is checked first).
        let resp = app
            .clone()
            .oneshot(post_upload("", Some("tok"), Some(OCTET_STREAM), Vec::new()))
            .await
            .unwrap();
        assert_error(resp, StatusCode::BAD_REQUEST, NAME_MSG).await;

        // `name=` — present but empty.
        let resp = app
            .clone()
            .oneshot(post_upload(
                "?name=",
                Some("tok"),
                Some(OCTET_STREAM),
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_error(resp, StatusCode::BAD_REQUEST, NAME_MSG).await;

        // Repeated `name` — express yields an array, not a string.
        let resp = app
            .clone()
            .oneshot(post_upload(
                "?name=a.txt&name=b.txt",
                Some("tok"),
                Some(OCTET_STREAM),
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_error(resp, StatusCode::BAD_REQUEST, NAME_MSG).await;

        // Valid name but an empty body.
        let resp = app
            .clone()
            .oneshot(post_upload(
                "?name=x.txt",
                Some("tok"),
                Some(OCTET_STREAM),
                Vec::new(),
            ))
            .await
            .unwrap();
        assert_error(resp, StatusCode::BAD_REQUEST, BODY_MSG).await;
    }

    /// Node oracle: `req.query.name` is `undefined` for `?foo=bar`, so the
    /// oracle 400s. The key must BE `name`; a single non-empty pair with a
    /// different key is not a name.
    #[tokio::test]
    async fn rejects_a_single_query_pair_whose_key_is_not_name() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(post_upload(
                "?foo=bar",
                Some("tok"),
                Some(OCTET_STREAM),
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_error(resp, StatusCode::BAD_REQUEST, NAME_MSG).await;

        let attachments_dir = home.path().join(".freshell").join("attachments");
        assert!(
            tokio::fs::metadata(&attachments_dir).await.is_err(),
            "attachments dir must not be created for a nameless request"
        );
    }

    /// Node oracle: `?name=a.txt&other=x` has `req.query.name === 'a.txt'`
    /// (a string), so the oracle 200s with name `a.txt`; unrelated params
    /// beside a valid `name` are ignored.
    #[tokio::test]
    async fn accepts_a_name_alongside_unrelated_query_params() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(post_upload(
                "?name=a.txt&other=x",
                Some("tok"),
                Some(OCTET_STREAM),
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;

        let saved_path = PathBuf::from(value["path"].as_str().unwrap());
        let attachments_dir = home.path().join(".freshell").join("attachments");
        assert_eq!(saved_path.parent().unwrap(), attachments_dir.as_path());
        let basename = saved_path.file_name().unwrap().to_str().unwrap();
        assert!(
            regex::Regex::new(r"^[0-9a-f]{8}-a\.txt$")
                .unwrap()
                .is_match(basename),
            "unexpected saved basename: {basename}"
        );
        let disk = tokio::fs::read(&saved_path).await.unwrap();
        assert_eq!(disk, b"data");
    }

    /// Node oracle: express's `raw({ type })` parses the body only when the
    /// content type matches, so both a WRONG and an ABSENT Content-Type leave
    /// `req.body` unparsed and the oracle 400s with the body message.
    #[tokio::test]
    async fn rejects_a_non_empty_body_with_the_wrong_content_type() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));

        let resp = app
            .clone()
            .oneshot(post_upload(
                "?name=note.txt",
                Some("tok"),
                Some("text/plain"),
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_error(resp, StatusCode::BAD_REQUEST, BODY_MSG).await;

        // No Content-Type header at all: `headers.get(..)` misses, so
        // `is_octet_stream`'s `None` branch is false and the same 400 fires —
        // matching the oracle's type-skip on a missing content type.
        let resp = app
            .clone()
            .oneshot(post_upload(
                "?name=note.txt",
                Some("tok"),
                None,
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_error(resp, StatusCode::BAD_REQUEST, BODY_MSG).await;

        // The type match is case-insensitive on the token before any `;`
        // parameters (Node's `type-is` semantics behind `raw({ type })`).
        let resp = app
            .oneshot(post_upload(
                "?name=note.txt",
                Some("tok"),
                Some("APPLICATION/OCTET-STREAM; charset=binary"),
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    /// Parity from Node's `authenticateToken` middleware at the mount.
    #[tokio::test]
    async fn rejects_unauthenticated_requests() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(post_upload(
                "?name=note.txt",
                None,
                Some(OCTET_STREAM),
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_error(resp, StatusCode::UNAUTHORIZED, "Unauthorized").await;

        let attachments_dir = home.path().join(".freshell").join("attachments");
        assert!(
            tokio::fs::metadata(&attachments_dir).await.is_err(),
            "attachments dir must not be created for a rejected request"
        );
    }

    /// LB-10: Node's middleware-first ordering — auth is checked before the
    /// body is read, so this is 401. It would be 413 if auth lived inside the
    /// handler (behind Bytes extraction).
    #[tokio::test]
    async fn unauthenticated_over_cap_is_401_not_413() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let over_cap = vec![7u8; ATTACHMENT_MAX_BYTES + 1];
        let resp = app
            .oneshot(post_upload(
                "?name=big.bin",
                None,
                Some(OCTET_STREAM),
                over_cap,
            ))
            .await
            .unwrap();
        assert_error(resp, StatusCode::UNAUTHORIZED, "Unauthorized").await;
    }

    /// Parity from `ATTACHMENT_MAX_BYTES` + express `raw({ limit })`; status
    /// is the contract (declared divergence: 413 body format).
    #[tokio::test]
    async fn allows_the_cap_and_rejects_one_byte_over() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));

        let at_cap = vec![7u8; ATTACHMENT_MAX_BYTES];
        let resp = app
            .clone()
            .oneshot(post_upload(
                "?name=big.bin",
                Some("tok"),
                Some(OCTET_STREAM),
                at_cap,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["bytes"], json!(ATTACHMENT_MAX_BYTES));

        let over_cap = vec![7u8; ATTACHMENT_MAX_BYTES + 1];
        let resp = app
            .oneshot(post_upload(
                "?name=big.bin",
                Some("tok"),
                Some(OCTET_STREAM),
                over_cap,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// Declared divergence: Node hangs silently on an fs rejection; this port
    /// answers a visible 500.
    #[tokio::test]
    async fn a_save_failure_is_a_visible_500_not_a_hang() {
        let home = tempfile::tempdir().unwrap();
        // Squat `.freshell` with a regular FILE so
        // `create_dir_all(.freshell/attachments)` fails with NotADirectory.
        tokio::fs::write(home.path().join(".freshell"), b"file, not a dir")
            .await
            .unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(post_upload(
                "?name=note.txt",
                Some("tok"),
                Some(OCTET_STREAM),
                b"data".to_vec(),
            ))
            .await
            .unwrap();
        assert_error(
            resp,
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to save attachment",
        )
        .await;
    }

    #[test]
    fn sanitize_filename_ports_the_node_basename_plus_replace_semantics() {
        let cases = [
            ("note.txt", "note.txt"),
            ("/a/b/c.png", "c.png"),
            ("../../etc/passwd", "passwd"),
            ("C:\\foo:bar.txt", "C__foo_bar.txt"),
            ("a  b.txt", "a__b.txt"),
            ("caf\u{e9}.png", "caf_.png"),
            ("\u{1F600}.png", "__.png"),
            ("///", "attachment"),
        ];
        for (input, expected) in cases {
            assert_eq!(sanitize_filename(input), expected, "input: {input:?}");
        }
    }
}
