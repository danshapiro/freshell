# Fresh-agent attachments on the Rust server + visible composer upload failures (te1m)

> **For agentic workers:** REQUIRED: Use subagent-driven development (subagents for each task) and socratic questioning (present findings, discuss approach, settle decisions before implementing).

## User Request

> Implement the REST upload route on the Rust server with the Node route as the behavioral contract, and make the composer surface upload failures visibly:
>
> - **Task 1 — Missing Rust REST route.** `crates/freshell-server/src/main.rs` still lacks `POST /api/fresh-agent/attachments`; the SPA composer (`src/components/fresh-agent/FreshAgentComposer.tsx:160-174`) issues `fetch('/api/fresh-agent/attachments?name=...')` — unusable on the Rust leg per the exercised-statement and test inventory. Implement it on the Rust server with the Node route as the behavioral contract.
> - **Task 2 — Composer upload failures swallowed.** The composer shows upload errors via an error chip (`src/components/fresh-agent/FreshAgentComposer.tsx:166-178`), which the hypothesis pins as silent because the fetch lacks the localhost-400 signal only; per the exercised-statement audit, preserving Node behavior is the contract, make failures visible (add diagnostics/messages where Node parity allows) and keep chip state faithful to the server's response.
> - **Acceptance.** Tests must execute at every layer. A factory spec must assert a visible error chip for an upload failure; it must not depend on the silent catch. Full suite green and the production deployment serving 200 for this route with all layers exercised.
>
> **Forbidden.** GitHub-flavored orchestration only, forbidden TDD policy violations, never push before Gates 3-5, never mark done until evidence is collected, never accept test skips/weak assertions.

*(Note on wording: the acceptance refers to Darkforge Gates; "the production deployment" is satisfied by the squash-merged canonical landing this work item performs — no live self-hosted server restart is performed; that requires the user's explicit separate approval and is out of scope for this job.)*

## Goal

The fresh-agent composer's paperclip upload flow works end to end on the self-hosted **Rust** server (port 3001 world): `POST /api/fresh-agent/attachments` exists on `freshell-server` with behavior parity against the legacy Node route (the oracle), and upload failures (unsupported server / oversized file / server error) produce a **visible, human-readable** error chip in the composer instead of a silent abort.

## Architecture

Freshell runs as two server legs. The browser SPA composer's paperclip (hidden `<input type="file">`) buffers bytes and `fetch`es `POST /api/fresh-agent/attachments?name=<raw>` with the raw `File` as body (`FreshAgentComposer.tsx:160-174`). The legacy Node leg serves the route from `server/fresh-agent-extras-router.ts:260-287` (imported at `server/index.ts`); the Rust leg (`crates/freshell-server/`, production) currently 404s, and today the composer's catch falls back to `res.json()`-or-`upload failed (<status>)` text that wasn't designed for the 404/413 cases.

The fix follows the existing **same-origin Node-router port** pattern already used for `POST /api/fresh-agent/checkpoints`: a new leaf module `crates/freshell-server/src/attachments.rs`, one state struct (auth token + boot-resolved home), one `router()` merged into the app router in `main.rs` next to `checkpoints::router`. The composer change is a narrow, exported status→message mapping (`attachmentUploadErrorMessage`) used in the existing `uploadAttachment` error branch — no capability probing, no client-side size pre-check, no new UI elements (the existing error-chip list renders the messages).

Node behavior is the contract, recorded as an explicit parity table; deliberate divergences (a 500 with JSON instead of the Node route's hang-on-fs-error, and the axum 413 body format) are documented with rationale. Tests mirror the Node oracle suite (`test/server/fresh-agent-extras.test.ts` attachments describe) one-for-one as Rust in-module tests, plus component tests for the composer mapping/visibility, plus one new Playwright matrix spec exercising the full browser→Rust-server path.

## Tech Stack

- Rust: `crates/freshell-server` (axum 0.8, tokio, tower, tempfile [dev], uuid, serde_json, tracing) — existing deps only, **no Cargo.toml change** (verified: `checkpoints.rs` already uses `tokio::fs` in library code via workspace feature unification; `uuid` v4 at `crates/freshell-server/Cargo.toml:49`; `tower`+`tempfile` dev-deps at lines 115-117).
- Client: React 18 + TypeScript; component tests via Vitest + Testing Library + `@testing-library/user-event` (dev dep).
- E2E: Playwright matrix specs (`test/e2e-browser/specs/`, projects `legacy-chromium` / `rust-chromium`), fake codex app-server fixture (`test/e2e-browser/fixtures/providers/fake-codex-app-server.mjs`), `createE2eServerHandle` isolated-home server boot.

## Global Constraints

1. **Node route is the behavioral oracle.** Response shape, status codes, error strings, filename sanitization, and storage location must match `server/fresh-agent-extras-router.ts:10,15-22,260-287` and its oracle tests unless a divergence is explicitly listed in this plan with rationale.
2. **TDD, red first, real behavior.** Every task: failing test on behavior first, then minimal implementation, then refactor. Tests must execute the real route/component/spec paths — no tautological mocks. Orchestration follows the Darkforge subagent-driven-development skill at execution time.
3. **Repo rules.** Work stays in this worktree on branch `darkforge/te1m` (base `398a866f`). Never push directly to `origin/main`; landing happens via the Darkforge landed flow (squash to canonical) at Gate 5. `cargo fmt --all --check` and `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings` (plus the two real-transport clippy lanes) must stay clean — they are part of the full QA gate.
4. **A11y discipline.** No new interactive elements are added; existing selectors (`role="list"`/`listitem` on the attachment chips, `aria-label="uploading"` spinner, hidden file input) are reused — do not regress them.
5. **docs/index.html rule assessment:** the paperclip already exists in the UI today; this change alters neither the control nor the default experience, so no `docs/index.html` update.
6. **Full QA gate** (`/home/dan/.local/share/darkforge/sources/freshell-qa.sh`, run via `darkforge qa`): `npm ci` if needed → `npm run check` (typecheck + coordinated full vitest) → `cargo fmt --all --check` → workspace clippy lanes. Current baseline on this base commit: exit 1 with exactly 3 pre-existing failures, all in `test/unit/vite-config.test.ts > getNetworkHost` ("ignores HOST env when configured", "returns 127.0.0.1 when config file does not exist", "returns 127.0.0.1 when config has no network settings"). Success = exit 0, or nonzero **only if** the failing identities are a subset of these three. The work-source's `npm run check` oracle is subsumed by this gate.
7. **No production restart.** Do not restart/redeploy the live self-hosted server (requires explicit user APPROVED, out of scope). Validation happens in this worktree (unit/component/e2e) and the QA gate.

## Functional De-Risking / Evidence

Sources actually read and verified in this worktree at the base commit (research reports under `$LOGS_DIR/reports/plan-{node-oracle,rust-server,composer}.md` plus direct spot-checks):

| Area | Evidence | read_ranges |
| ---- | -------- | ----------- |
| Node oracle route | `server/fresh-agent-extras-router.ts` | lines 10, 15-22, 258-287 |
| Node oracle tests | `test/server/fresh-agent-extras.test.ts` | attachments `describe` (save/sanitize/400s/cap/401) |
| Rust wiring precedent | `crates/freshell-server/src/main.rs` | mod list ~20-40, `checkpoints_state` ~1544-1553, merge chain ~1577-1590 |
| Rust module precedent | `crates/freshell-server/src/checkpoints.rs` | state 86-94, router 99-109, test `state()` 674-679, oneshot test 931-949 |
| Auth helpers | `crates/freshell-server/src/boot.rs` | `is_authed` ~730, `unauthorized` ~757 (pub(crate); header+cookie) |
| axum body-limit behavior | `crates/freshell-server/src/proxy.rs` tests | L3 bytes/default-limit tests ~1092-1103 |
| Composer upload+chips | `src/components/fresh-agent/FreshAgentComposer.tsx` | types 60-73, `uploadAttachment` 160-180, chip render ~679-713, paperclip/input 776-785 |
| Composer test file | `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx` | imports `render/fireEvent/screen/waitFor/within`, mocks `@/lib/api` |
| E2E boilerplate | `test/e2e-browser/specs/agent-checkpoint-rewind.spec.ts` | fake-codex installer ~94+, `createE2eServerHandle` boot ~100-205 |
| Server handle lifecycle | `test/e2e-browser/helpers/external-target.ts` | `stop(): Promise<void>` ~31, `start()` ~180 |
| Spec registration | `test/e2e-browser/playwright.config.ts` | `MATRIX_SPECS` ~13-36, projects ~333-354; cloud config reuses same lists (`playwright.cloud.config.ts:7`) |

Load-bearing flags for the load-bearing stage (verified or scheduled):

- [verified 2026-09-06] `uuid` is a real dep; `tower`/`tempfile` are dev-deps of `freshell-server`.
- [verified 2026-09-06] `tokio::fs` appears in `checkpoints.rs` library code (lines 150-647) and the crate builds today → no Cargo.toml feature change needed for `tokio::fs` in new library code.
- [verified 2026-09-06] No helper test enumerates `MATRIX_SPECS`; cloud Playwright config inherits the same lists → registering one regex is sufficient.
- [scheduled] Compile-time: `Query<Vec<(String, String)>>` deserializer (axum idiom for repeated params) and `DefaultBodyLimit::max` layer scoping to this sub-router — compile/red phase of Task 1 settles both.
- [scheduled] Playwright `setInputFiles` name spoofing accepts `../../etc/passwd` (name is an arbitrary string; standard API) — Task 3 red phase confirms.

## Task 1 — Rust endpoint `POST /api/fresh-agent/attachments`

**Goal.** Self-hosted (Rust) freshell accepts composer uploads on the Rust leg with Node-oracle parity.

**Files.**

- *Create:* `crates/freshell-server/src/attachments.rs` (route + state + in-module tests)
- *Modify:* `crates/freshell-server/src/main.rs` (mod declaration, state construction, router merge)
- *Test:* in-module `#[cfg(test)] mod tests` inside `attachments.rs` (mirrors the Node oracle suite)

**Architecture.** New leaf module following `checkpoints.rs`. Merged into the same app router as `checkpoints::router`, adjacent to it. All fs access stays under the boot-resolved `home` (e2e isolation pattern F2). Uses only existing deps. No ledger/checkpoint side effects here (checkpoints stay client-driven via the existing route).

**Interfaces.**

- *Consumes:* `crate::boot::is_authed(&HeaderMap, &str)`, `crate::boot::unauthorized()` (both `pub(crate)`); axum 0.8 `Router`/`Bytes`/`Query`/`DefaultBodyLimit`; `serde_json::json`; `uuid::Uuid`; `tokio::fs`.
- *Produces:* `pub struct AttachmentsApiState { pub auth_token: Arc<String>, pub home: Arc<PathBuf> }`; `pub fn router(state: AttachmentsApiState) -> Router` serving `POST /api/fresh-agent/attachments`; `pub(crate) fn sanitize_filename(name: &str) -> String`.
- *Behavioral contract (parity with `fresh-agent-extras-router.ts:260-287`):*

| Request condition | Response |
| ----------------- | -------- |
| unauthenticated (bad/absent token header and cookie) | `401 {"error":"Unauthorized"}` |
| `?name` missing, empty, or repeated | `400 {"error":"name query parameter required"}` |
| empty body **or** content-type not `application/octet-stream` | `400 {"error":"attachment body must be a non-empty application/octet-stream"}` |
| body > 10 MiB (`ATTACHMENT_MAX_BYTES`) | `413` empty-ish body (axum default; status is the contract) |
| success | `200 {"path": "<home>/.freshell/attachments/<uuid8>-<sanitized>", "bytes": <len>}` — plain JSON, no `{ok:true}` envelope |
| fs write failure | `500 {"error":"failed to save attachment"}` (**deliberate divergence** from Node's hang — client aborts after 30s otherwise) |

**Implementation.**

1. **Red — create the module skeleton, tests, and wiring; watch tests fail for the right reason.** Create `crates/freshell-server/src/attachments.rs` with the state struct, a `router(state)` that registers **no route** (or a stub returning 404), a deliberately wrong `sanitize_filename(name) -> name.to_string()`, and the full test module below. Wire `mod attachments;` + state + `.merge(...)` into `main.rs` (patch below). Run `cargo test -p freshell-server attachments` — router tests fail (404 vs expected statuses; missing error strings), sanitize table fails on hostile names.

   Skeleton + full tests (`crates/freshell-server/src/attachments.rs`):

   ```rust
   //! `POST /api/fresh-agent/attachments` — the Rust port of the legacy Node
   //! route (`server/fresh-agent-extras-router.ts:260-287`), the behavioral
   //! oracle for this module. Parity contract:
   //!
   //! | Request condition                                 | Response                          |
   //! | ------------------------------------------------- | --------------------------------- |
   //! | unauthenticated                                   | 401 {"error":"Unauthorized"}      |
   //! | `?name` missing / empty / repeated                | 400 {"error":"name query parameter required"} |
   //! | empty body or non-octet-stream content type       | 400 {"error":"attachment body must be a non-empty application/octet-stream"} |
   //! | body over 10 MiB                                  | 413 (body format server-specific) |
   //! | success                                           | 200 {"path","bytes"} (plain JSON, no envelope) |
   //!
   //! Deliberate divergence from the oracle: on a filesystem write failure
   //! the Node route never responds (results hang until the client's 30s
   //! AbortController trips); this route returns
   //! 500 {"error":"failed to save attachment"} and logs the error.

   use std::{path::PathBuf, sync::Arc};

   use axum::{
       body::Bytes,
       extract::{DefaultBodyLimit, Query, State},
       http::{header, HeaderMap, StatusCode},
       response::{IntoResponse, Response},
       routing::post,
       Json, Router,
   };
   use serde_json::json;
   use uuid::Uuid;

   /// `ATTACHMENT_MAX_BYTES` parity: `server/fresh-agent-extras-router.ts:10`.
   const ATTACHMENT_MAX_BYTES: usize = 10 * 1024 * 1024;

   pub struct AttachmentsApiState {
       pub auth_token: Arc<String>,
       /// The resolved home whose `.freshell/attachments/` holds uploads
       /// (mirrors `os.homedir()` in `attachmentsDir`,
       /// `fresh-agent-extras-router.ts:20-22`). Boot-resolved and shared with
       /// `checkpoints_state` (same convention as
       /// `CheckpointsApiState::home`).
       pub home: Arc<PathBuf>,
   }

   pub fn router(state: AttachmentsApiState) -> Router {
       Router::new()
           .route("/api/fresh-agent/attachments", post(upload_attachment))
           // The 10 MiB contract is above axum's 2 MiB default; raise it for
           // this sub-router only. Over-cap bodies 413 before the handler.
           .layer(DefaultBodyLimit::max(ATTACHMENT_MAX_BYTES))
           .with_state(state)
   }

   async fn upload_attachment(
       State(state): State<AttachmentsApiState>,
       headers: HeaderMap,
       Query(query): Query<Vec<(String, String)>>,
       body: Bytes,
   ) -> Response {
       if !crate::boot::is_authed(&headers, &state.auth_token) {
           return crate::boot::unauthorized();
       }

       // `req.query.name` parity: express's querystring parser yields an
       // array for a repeated key, which fails the Node route's
       // `typeof name !== 'string'` check — so missing, empty, OR repeated
       // all produce the same 400.
       let name = match name_param(&query) {
           Some(name) => name,
           None => return bad_request("name query parameter required"),
       };

       let content_type_ok = headers
           .get(header::CONTENT_TYPE)
           .and_then(|v| v.to_str().ok())
           .map(|v| {
               v.split(';')
                   .next()
                   .unwrap_or("")
                   .trim()
                   .eq_ignore_ascii_case("application/octet-stream")
           })
           .unwrap_or(false);
       if !content_type_ok || body.is_empty() {
           return bad_request(
               "attachment body must be a non-empty application/octet-stream",
           );
       }

       let dir = state.home.join(".freshell").join("attachments");
       if let Err(err) = tokio::fs::create_dir_all(&dir).await {
           tracing::warn!(?dir, %err, "fresh-agent attachment: failed to create storage directory");
           return save_error();
       }
       let filename = format!(
           "{}-{}",
           &Uuid::new_v4().simple().to_string()[..8],
           sanitize_filename(&name),
       );
       let target = dir.join(filename);
       let bytes = body.len();
       if let Err(err) = tokio::fs::write(&target, &body).await {
           tracing::warn!(?target, %err, "fresh-agent attachment: failed to save upload");
           return save_error();
       }

       Json(json!({ "path": target.display().to_string(), "bytes": bytes })).into_response()
   }

   fn name_param(query: &[(String, String)]) -> Option<String> {
       let mut names = query.iter().filter(|(k, _)| k == "name");
       match (names.next(), names.next()) {
           (Some((_, value)), None) if !value.is_empty() => Some(value.clone()),
           _ => None,
       }
   }

   /// Port of `sanitizeFilename` (`fresh-agent-extras-router.ts:15-18`):
   /// POSIX `path.basename` (strip trailing `/`, keep the segment after the
   /// LAST `/`; `\` is not a separator), then replace every character
   /// outside `[a-zA-Z0-9._-]` with `_` **per UTF-16 code unit** like Node's
   /// regex — astral characters (e.g. emoji) yield TWO underscores. Empty
   /// result falls back to `attachment`.
   pub(crate) fn sanitize_filename(name: &str) -> String {
       let trimmed = name.trim_end_matches('/');
       let base = trimmed.rsplit('/').next().unwrap_or("");
       let mut out = String::with_capacity(base.len());
       for c in base.chars() {
           if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
               out.push(c);
           } else {
               if u32::from(c) > 0xFFFF {
                   out.push('_');
               }
               out.push('_');
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

   fn save_error() -> Response {
       (
           StatusCode::INTERNAL_SERVER_ERROR,
           Json(json!({ "error": "failed to save attachment" })),
       )
           .into_response()
   }

   #[cfg(test)]
   mod tests {
       //! Every HTTP test mirrors a Node-oracle assertion from
       //! `test/server/fresh-agent-extras.test.ts` (`fresh-agent router ›
       //! attachments`), run hermetically against an isolated `home`
       //! (e2e isolation pattern F2 — nothing here can touch the real
       //! home directory).
       use super::*;
       use axum::body::Body;
       use axum::http::Request;
       use serde_json::Value;
       use tempfile::TempDir;
       use tower::ServiceExt;

       fn state(home: &TempDir) -> AttachmentsApiState {
           AttachmentsApiState {
               auth_token: Arc::new("tok".to_string()),
               home: Arc::new(home.path().to_path_buf()),
           }
       }

       fn upload_request(uri: &str, content_type: &str, body: Body) -> Request<Body> {
           Request::builder()
               .method("POST")
               .uri(uri)
               .header("x-auth-token", "tok")
               .header(header::CONTENT_TYPE, content_type)
               .body(body)
               .unwrap()
       }

       async fn json_body(response: Response) -> Value {
           let bytes = axum::body::to_bytes(response.into_body(), ATTACHMENT_MAX_BYTES * 2)
               .await
               .unwrap();
           serde_json::from_slice(&bytes).unwrap()
       }

       fn attachments_dir(home: &TempDir) -> PathBuf {
           home.path().join(".freshell").join("attachments")
       }

       // Node oracle: "saves a raw binary attachment and returns its path"
       #[tokio::test]
       async fn saves_a_raw_binary_attachment_and_returns_its_path() {
           let home = TempDir::new().unwrap();
           let app = router(state(&home));
           let response = app
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments?name=note.txt",
                   "application/octet-stream",
                   Body::from("hello attachment"),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::OK);
           let body = json_body(response).await;
           assert_eq!(body["bytes"], 16);
           let stored = PathBuf::from(body["path"].as_str().unwrap());
           assert_eq!(stored.parent().unwrap(), attachments_dir(&home).as_path());
           let basename = stored.file_name().unwrap().to_str().unwrap();
           let (uuid_part, rest) = basename.split_once('-').unwrap();
           assert_eq!(uuid_part.len(), 8);
           assert!(uuid_part.chars().all(|c| c.is_ascii_hexdigit()));
           assert_eq!(rest, "note.txt");
           assert_eq!(std::fs::read(&stored).unwrap(), b"hello attachment");
       }

       // Node oracle: "sanitizes hostile filenames before saving"
       #[tokio::test]
       async fn sanitizes_hostile_filenames_before_saving() {
           let home = TempDir::new().unwrap();
           let app = router(state(&home));
           let response = app
               .oneshot(upload_request(
                   // express decodes %2F inside the query value; emulate the
                   // already-decoded form the client query param arrives as.
                   "/api/fresh-agent/attachments?name=../../etc/passwd",
                   "application/octet-stream",
                   Body::from("x"),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::OK);
           let body = json_body(response).await;
           let stored = PathBuf::from(body["path"].as_str().unwrap());
           assert_eq!(stored.parent().unwrap(), attachments_dir(&home).as_path());
           let basename = stored.file_name().unwrap().to_str().unwrap();
           assert!(!basename.contains(".."));
           assert!(basename.ends_with("-passwd"));
           assert_eq!(basename.len(), 8 + 1 + "passwd".len());
           assert_eq!(std::fs::read(&stored).unwrap(), b"x");
       }

       // Node oracle: "rejects missing name and empty body"
       #[tokio::test]
       async fn rejects_missing_name_repeated_name_and_empty_body() {
           let home = TempDir::new().unwrap();

           // no name at all + empty body -> name error message wins (Node
           // checks `name` first)
           let response = router(state(&home))
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments",
                   "application/octet-stream",
                   Body::empty(),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::BAD_REQUEST);
           assert_eq!(
               json_body(response).await["error"],
               "name query parameter required"
           );

           // empty name
           let response = router(state(&home))
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments?name=",
                   "application/octet-stream",
                   Body::from("data"),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::BAD_REQUEST);
           assert_eq!(
               json_body(response).await["error"],
               "name query parameter required"
           );

           // repeated name (express yields an array -> typeof !== 'string')
           let response = router(state(&home))
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments?name=a.txt&name=b.txt",
                   "application/octet-stream",
                   Body::from("data"),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::BAD_REQUEST);
           assert_eq!(
               json_body(response).await["error"],
               "name query parameter required"
           );

           // name present but body empty
           let response = router(state(&home))
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments?name=x.txt",
                   "application/octet-stream",
                   Body::empty(),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::BAD_REQUEST);
           assert_eq!(
               json_body(response).await["error"],
               "attachment body must be a non-empty application/octet-stream"
           );
       }

       // Node oracle (composition gap): the empty-body guard rejects
       // non-octet-stream too.
       #[tokio::test]
       async fn rejects_a_non_empty_body_with_the_wrong_content_type() {
           let home = TempDir::new().unwrap();
           let response = router(state(&home))
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments?name=x.txt",
                   "text/plain",
                   Body::from("hello"),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::BAD_REQUEST);
           assert_eq!(
               json_body(response).await["error"],
               "attachment body must be a non-empty application/octet-stream"
           );
       }

       // Node oracle: unauthenticated requests never reach the route
       // (protected by `authenticateToken`).
       #[tokio::test]
       async fn rejects_unauthenticated_requests() {
           let home = TempDir::new().unwrap();
           let request = Request::builder()
               .method("POST")
               .uri("/api/fresh-agent/attachments?name=note.txt")
               .header(header::CONTENT_TYPE, "application/octet-stream")
               .body(Body::from("data"))
               .unwrap();
           let response = router(state(&home)).oneshot(request).await.unwrap();
           assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
           assert_eq!(json_body(response).await["error"], "Unauthorized");
           // and nothing was written
           assert!(!attachments_dir(&home).exists());
       }

       // Node oracle: cap behavior — exactly 10 MiB succeeds, 10 MiB + 1 is
       // rejected with 413 (axum's body-limit rejection; status is the
       // contract, the empty body differs from express's HTML page).
       #[tokio::test]
       async fn allows_the_cap_and_rejects_one_byte_over() {
           let home = TempDir::new().unwrap();
           let at_cap = vec![7u8; ATTACHMENT_MAX_BYTES];
           let response = router(state(&home))
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments?name=cap.bin",
                   "application/octet-stream",
                   Body::from(at_cap),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::OK);

           let over_cap = vec![7u8; ATTACHMENT_MAX_BYTES + 1];
           let response = router(state(&home))
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments?name=over.bin",
                   "application/octet-stream",
                   Body::from(over_cap),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
       }

       // Deliberate divergence: fs failure is a visible 500, not Node's hang.
       #[tokio::test]
       async fn a_save_failure_is_a_visible_500_not_a_hang() {
           let home = TempDir::new().unwrap();
           // Block `<home>/.freshell/attachments` creation by squatting on
           // `.freshell` with a regular file.
           std::fs::write(home.path().join(".freshell"), b"occupied").unwrap();
           let response = router(state(&home))
               .oneshot(upload_request(
                   "/api/fresh-agent/attachments?name=note.txt",
                   "application/octet-stream",
                   Body::from("data"),
               ))
               .await
               .unwrap();
           assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
           assert_eq!(
               json_body(response).await["error"],
               "failed to save attachment"
           );
       }

       // ── sanitize_filename (Node: `sanitizeFilename`,
       //    fresh-agent-extras-router.ts:15-18) ─────────────────────────

       #[test]
       fn sanitize_filename_ports_the_node_basename_plus_replace_semantics() {
           // happy path untouched
           assert_eq!(sanitize_filename("note.txt"), "note.txt");
           // POSIX basename: keep the segment after the LAST '/'
           assert_eq!(sanitize_filename("/a/b/c.png"), "c.png");
           assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
           // '\' is not a separator (POSIX basename semantics)
           assert_eq!(sanitize_filename("C:\\foo:bar.txt"), "C__foo_bar.txt");
           // each disallowed char -> '_'; spaces included
           assert_eq!(sanitize_filename("a  b.txt"), "a__b.txt");
           // BMP astral parity: 'é' is one UTF-16 code unit -> one '_'
           assert_eq!(sanitize_filename("café.png"), "caf_.png");
           // astral chars are TWO UTF-16 code units in Node -> two '_'
           assert_eq!(sanitize_filename("😀.png"), "__.png");
           // all-trailing-'/' empties out -> fallback
           assert_eq!(sanitize_filename("///"), "attachment");
       }
   }
   ```

   `main.rs` patch (three edits):

   ```rust
   // (a) mod list, after `mod ai_title;` (alphabetical):
   mod attachments;

   // (b) state construction, immediately AFTER the existing
   //     `let checkpoints_state = ...;` block (~line 1553):
   // `POST /api/fresh-agent/attachments` (`fresh-agent-extras-router.ts:260-287`):
   // raw octet-stream uploads from the composer paperclip, stored under
   // `<home>/.freshell/attachments/`. Shares the same boot-resolved home as
   // checkpoints_state above.
   let attachments_state = attachments::AttachmentsApiState {
       auth_token: Arc::clone(&auth_token),
       home: Arc::new(home.clone().unwrap_or_else(|| PathBuf::from("."))),
   };

   // (c) merge chain, immediately AFTER
   //     `.merge(checkpoints::router(checkpoints_state))`:
   .merge(attachments::router(attachments_state))
   ```

   Success criteria: `cargo test -p freshell-server attachments` compiles; router tests fail with 404/wrong-body assertions pointing at the unimplemented handler and `sanitize_filename` table fails on the hostile-name cases (a real red, not a compile error).

2. **Green — implement the handler + sanitize as written in the full listing above** (the listing IS the intended final code; the red phase stubs the handler body to `StatusCode::NOT_FOUND.into_response()` and `sanitize_filename` to `name.to_string()`). Success: `cargo test -p freshell-server attachments` — all tests pass (7 HTTP tests + sanitize table).

3. **Refactor / lint.** `cargo fmt -p freshell-server`, then `cargo clippy -p freshell-server --all-targets -- -D warnings` clean. No extraction expected (single handler); keep the parity doc comments.

- **Per-task verification gate:** `cargo test -p freshell-server` (whole crate — `main.rs` wiring changed) green, `cargo clippy -p freshell-server --all-targets -- -D warnings` clean, `cargo fmt --all --check` clean.
- **Commit:** `feat(rust): add POST /api/fresh-agent/attachments with Node-route parity`
- [~] Update `run-state.md` task progress.

## Task 2 — Composer: visible, mapped upload-failure chips

**Goal.** Upload failures on either leg render a clear, human-readable error chip — notably "route missing on this server" (404) and "file too large" (413) — while preserving the existing contract with `foldServerTextRef` (Node-oracle `error`/`message` still wins when present).

**Files.**

- *Modify:* `src/components/fresh-agent/FreshAgentComposer.tsx` — new exported `attachmentUploadErrorMessage(status, data, filename)` helper; use it in `uploadAttachment`'s `!res.ok` branch.
- *Test:* `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx` — new `describe('attachmentUploadErrorMessage')` + new `describe('attachments')` component tests.

**Interfaces.**

- *Consumes:* `fetch` (raw upload, already present), existing chip state (`setAttachments`) and error-chip render (role `list`/`listitem`, `title` attr).
- *Produces:*

  ```ts
  /**
   * Map an attachments upload failure to user-facing text. The Node oracle
   * sends `{error}`/`{message}` JSON for its own 4xx paths, so the server's
   * own message wins when present. Two statuses carry client-added clarity:
   * 404 means the route does not exist on this server (an older Rust server
   * that predates the attachments route), and 413 is the server's 10 MB
   * body cap whose express body is an HTML page the composer cannot parse.
   */
  export function attachmentUploadErrorMessage(
    status: number,
    data: { error?: string; message?: string } | null,
    filename: string,
  ): string {
    if (status === 404) return 'Attachments are not supported by this server'
    if (status === 413) return `"${filename}" exceeds the 10 MB attachment size limit`
    return data?.error || data?.message || `upload failed (${status})`
  }
  ```

  and in `uploadAttachment` (~line 160-180), replace the `!res.ok` branch:

  ```ts
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: string
        message?: string
      } | null
      throw new Error(attachmentUploadErrorMessage(res.status, data, file.name))
    }
  ```

**Implementation.**

1. **Red.** Add the import of `attachmentUploadErrorMessage` to the test file (extend the existing `FreshAgentComposer` import) and append the tests below; run `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx` — fails because the export does not exist and the error text differs.

   ```tsx
   import userEvent from '@testing-library/user-event'  // add to imports

   describe('attachmentUploadErrorMessage', () => {
     it('maps statuses and server messages to user-facing text', () => {
       expect(attachmentUploadErrorMessage(404, { error: 'Not found' }, 'a.txt'))
         .toBe('Attachments are not supported by this server')
       expect(attachmentUploadErrorMessage(413, null, 'big.bin'))
         .toBe('"big.bin" exceeds the 10 MB attachment size limit')
       // server-oracle messages keep winning (foldServerTextRef parity)
       expect(attachmentUploadErrorMessage(401, { error: 'Unauthorized' }, 'a.txt'))
         .toBe('Unauthorized')
       expect(attachmentUploadErrorMessage(500, null, 'a.txt'))
         .toBe('upload failed (500)')
     })
   })

   describe('attachments', () => {
     const fetchMock = vi.fn()

     beforeEach(() => {
       fetchMock.mockReset()
       vi.stubGlobal('fetch', fetchMock)
     })

     afterEach(() => {
       vi.unstubAllGlobals()
     })

     const jsonResponse = (status: number, body: unknown) => ({
       ok: status < 400,
       status,
       json: async () => body,
     })

     function fileInput(container: HTMLElement): HTMLInputElement {
       const input = container.querySelector('input[type="file"]')
       if (!(input instanceof HTMLInputElement)) throw new Error('file input missing')
       return input
     }

     it('uploads an attachment and sends its server path with the message', async () => {
       fetchMock.mockResolvedValue(jsonResponse(200, {
         path: '/home/u/.freshell/attachments/abcd1234-note.txt',
         bytes: 16,
       }))
       const onSend = vi.fn()
       const { container } = render(
         <FreshAgentComposer commands={GROUPED_COMMANDS} onSend={onSend} />,
       )
       await userEvent.upload(
         fileInput(container),
         new File(['hello attachment'], 'note.txt', { type: 'text/plain' }),
       )
       expect(fetchMock).toHaveBeenCalledWith(
         '/api/fresh-agent/attachments?name=note.txt',
         expect.objectContaining({ method: 'POST', body: expect.any(File) }),
       )
       const list = await screen.findByRole('list', { name: 'Attachments' })
       await waitFor(() => {
         expect(within(list).getByRole('listitem')).toHaveAttribute(
           'title',
           '/home/u/.freshell/attachments/abcd1234-note.txt',
         )
       })
       fireEvent.change(getInput(), { target: { value: 'look at this' } })
       fireEvent.click(screen.getByRole('button', { name: 'Send' }))
       expect(onSend).toHaveBeenCalledWith('look at this', [
         '/home/u/.freshell/attachments/abcd1234-note.txt',
       ])
     })

     it('shows a visible error chip when the server does not support attachments', async () => {
       fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Not found' }))
       const { container } = render(<FreshAgentComposer commands={GROUPED_COMMANDS} />)
       await userEvent.upload(
         fileInput(container),
         new File(['x'], 'note.txt', { type: 'text/plain' }),
       )
       const list = await screen.findByRole('list', { name: 'Attachments' })
       await within(list).findByText('— Attachments are not supported by this server')
     })

     it('shows a visible error chip when the file exceeds the server size limit', async () => {
       // express's 413 body is an HTML page; json() must fail and the status
       // mapping must still produce the human-readable message.
       fetchMock.mockResolvedValue({
         ok: false,
         status: 413,
         json: async () => { throw new Error('Unexpected token < in JSON') },
       })
       const { container } = render(<FreshAgentComposer commands={GROUPED_COMMANDS} />)
       await userEvent.upload(
         fileInput(container),
         new File(['x'], 'huge.bin', { type: 'application/octet-stream' }),
       )
       const list = await screen.findByRole('list', { name: 'Attachments' })
       await within(list).findByText(/exceeds the 10 MB attachment size limit/)
     })
   })
   ```

   (If the composer's actual prop names differ from `commands`/`onSend` or the send button's accessible name, the implementer adjusts to what the existing tests in this file already use — `getInput()`/`GROUPED_COMMANDS` are local helpers of that file.)

   Success criteria: suite red on the new assertions for behavioral reasons (missing export / old fallback text `'upload failed (404)'`).

2. **Green.** Add `attachmentUploadErrorMessage` (exact code above) and rewire the `!res.ok` branch (exact diff above). Success: the full `FreshAgentComposer.test.tsx` file passes.

3. **Refactor.** Verify no other callers construct the same fallback inline; confirm lint (`npm run lint` scoped to the file if repo supports, else rely on the typecheck+QA gate). No behavior change.

- **Per-task verification gate:** `npm run test:vitest -- run test/unit/client/components/fresh-agent/` green (composer + the view/approval-card/mobile suites that render the composer).
- **Commit:** `feat(freshagent): map attachment upload failures to clear composer error chips`
- [~] Update `run-state.md` task progress.

## Task 3 — E2E spec: upload through the composer on the Rust lane

**Goal.** A Playwright matrix spec proves the full browser→server path on the **rust-chromium** project (and legacy parity): attaching files through the composer paperclip stores sanitized files under the isolated `HOME/.freshell/attachments/` on the Rust server, and an over-cap upload renders a visible error chip and stores nothing.

**Files.**

- *Create:* `test/e2e-browser/specs/agent-attachments.spec.ts`
- *Modify:* `test/e2e-browser/playwright.config.ts` — register the spec in `MATRIX_SPECS`.

**Interfaces.**

- *Consumes:* `createE2eServerHandle(process.env, { kind: e2eServerKind, construct: {...} })`, `TestHarness`, `openPanePicker`, fake-codex installer convention copied from `agent-checkpoint-rewind.spec.ts:94+`, the `e2eServerKind` worker option (`base.extend<{}, { e2eServerKind: 'legacy' | 'rust' }>({})`).
- *Produces:* spec + `MATRIX_SPECS` entry `/agent-attachments\.spec\.ts$/`.

**Implementation.**

1. **Red.** Add the spec and registration; run the rust lane — it must FAIL today with a 404-driven chip (`upload failed (404)` pre-Task-2, or "not supported" post-Task-2) because the Rust route does not exist on this base. Success of the red step = failure output names the 404, proving the spec executes the real upload path.

   `test/e2e-browser/specs/agent-attachments.spec.ts`:

   ```ts
   /**
    * AGENT-11 (slice): fresh-agent composer attachments across both server
    * legs. The composer POSTs raw bytes to /api/fresh-agent/attachments; the
    * server stores them under `<HOME>/.freshell/attachments/<uuid8>-<name>`.
    * This spec proves the Rust leg implements the Node-oracle contract end
    * to end (storage + sanitization) and that failures are visible in the
    * composer (over-cap -> error chip, nothing stored). Message-path folding
    * of the returned path is covered by the composer's unit tests (the
    * optimistic echo clears too fast on the rust lane to assert e2e).
    *
    * Template: agent-checkpoint-rewind.spec.ts (fake-codex installer +
    * isolated-home server boot). This spec does NOT check the AGENT-11
    * checklist box — image previews, transcript metadata, and the
    * below/above-cap matrix are separate work.
    */
   import fs from 'node:fs/promises'
   import os from 'node:os'
   import path from 'node:path'
   import { Buffer } from 'node:buffer'
   import { fileURLToPath } from 'node:url'
   import { test as base, expect } from '../helpers/fixtures.js'
   import { createE2eServerHandle } from '../helpers/external-target.js'
   import { TestHarness } from '../helpers/test-harness.js'
   import { openPanePicker } from '../helpers/pane-picker.js'

   const __filename = fileURLToPath(import.meta.url)
   const __dirname = path.dirname(__filename)
   const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
     __dirname,
     '../fixtures/providers/fake-codex-app-server.mjs',
   )
   const FAKE_CODEX_DIR = '.runopencode-fake-codex-app-server'

   async function installFakeCodexAppServer(destDir: string): Promise<string> {
     // Same wrapper convention as agent-checkpoint-rewind.spec.ts: the fake
     // terminates under the corpus dir on launch failure, so wrap it.
     const source = await fs.readFile(FAKE_CODEX_APP_SERVER_SOURCE, 'utf8')
     const rewritten = source.replaceAll(FAKE_CODEX_DIR, destDir.split('/').pop() ?? FAKE_CODEX_DIR)
     const dest = path.join(destDir, 'fake-codex-app-server.mjs')
     await fs.mkdir(path.dirname(dest), { recursive: true })
     await fs.writeFile(dest, rewritten, { mode: 0o755 })
     return dest
   }

   function findFreshAgentLeaf(node: any): any {
     const self = Array.isArray(node) ? undefined : node
     if (self?.content?.type === 'freshclaude') return self
     const children: any[] = Array.isArray(node)
       ? node
       : Array.isArray(self?.children)
         ? self.children
         : []
     for (const child of children) {
       const found = findFreshAgentLeaf(child)
       if (found) return found
     }
     return undefined
   }

   const test = base.extend<{}, { e2eServerKind: 'legacy' | 'rust' }>({})

   async function bootFreshCodexPane(
     page: import('@playwright/test').Page,
     e2eServerKind: 'legacy' | 'rust',
   ): Promise<{ homeDir: () => string; paneRoot: ReturnType<import('@playwright/test').Page['locator']>; stop: () => Promise<void> }> {
     const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agent11-attach-'))
     const projectCwd = path.join(sharedRoot, 'project')
     await fs.mkdir(projectCwd, { recursive: true })
     const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))
     let homeDir = ''
     const server = await createE2eServerHandle(process.env, {
       kind: e2eServerKind,
       construct: {
         env: { CODEX_CMD: fakeCodexPath },
         setupHome: async (home) => {
           homeDir = home
           const freshellDir = path.join(home, '.freshell')
           await fs.mkdir(freshellDir, { recursive: true })
           await fs.writeFile(
             path.join(freshellDir, 'config.json'),
             JSON.stringify({
               version: 1,
               settings: {
                 freshAgent: { enabled: true },
                 codingCli: {
                   enabledProviders: ['codex'],
                   providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
                 },
               },
             }, null, 2),
           )
         },
       },
     })
     const info = await server.start()
     await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
     const harness = new TestHarness(page)
     await harness.waitForHarness()
     await harness.waitForConnection()
     await page.evaluate(() => {
       window.__FRESHELL_TEST_HARNESS__?.dispatch({
         type: 'connection/setAvailableClis',
         payload: { claude: false, codex: true },
       })
     })
     const picker = await openPanePicker(page)
     await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
     const directoryInput = page.getByRole('combobox', { name: 'Starting directory for Freshcodex' })
     await expect(directoryInput).toBeVisible({ timeout: 10_000 })
     await directoryInput.fill(projectCwd)
     await directoryInput.press('Enter')
     const paneRoot = page.locator('[data-context="fresh-agent"]').last()
     await expect(paneRoot).toBeVisible({ timeout: 15_000 })
     const tabId = await harness.getActiveTabId()
     expect(tabId).toBeTruthy()
     await expect
       .poll(async () => {
         const layout = await harness.getPaneLayout(tabId!)
         return findFreshAgentLeaf(layout)?.content?.status
       }, { timeout: 30_000 })
       .toBe('idle')
     return {
       homeDir: () => homeDir,
       paneRoot,
       stop: async () => {
         await server.stop().catch(() => {})
         await fs.rm(sharedRoot, { recursive: true, force: true })
       },
     }
   }

   test.describe('Agent attachments (AGENT-11 slice)', () => {
     test('attaching files through the composer stores them on the server under sanitized names', async ({ page, e2eServerKind }) => {
       test.setTimeout(120_000)
       const session = await bootFreshCodexPane(page, e2eServerKind)
       try {
         const attachmentsDir = path.join(session.homeDir(), '.freshell', 'attachments')
         const fileInput = session.paneRoot.locator('input[type="file"]')
         const list = session.paneRoot.getByRole('list', { name: 'Attachments' })

         // Happy path: paperclip's hidden input accepts a raw buffer; the
         // chip settles into its ready state (tooltip becomes the stored
         // path, spinner gone) and the server holds the exact bytes.
         await fileInput.setInputFiles({
           name: 'note.txt',
           mimeType: 'text/plain',
           buffer: Buffer.from('hello attachment'),
         })
         await expect(list.getByRole('listitem')).toHaveCount(1, { timeout: 15_000 })
         await expect
           .poll(async () => session.paneRoot.getByLabel('uploading').count(), { timeout: 15_000 })
           .toBe(0)
         await expect(list.getByRole('listitem').first())
           .toHaveAttribute('title', /[0-9a-f]{8}-note\.txt$/)
         await expect
           .poll(async () => (await fs.readdir(attachmentsDir).catch(() => [])).join('\n'), { timeout: 15_000 })
           .toMatch(/^[0-9a-f]{8}-note\.txt$/)
         const stored = (await fs.readdir(attachmentsDir))[0]
         expect(await fs.readFile(path.join(attachmentsDir, stored), 'utf8')).toBe('hello attachment')

         // Traversal name: `../../etc/passwd` must be stored (not rejected)
         // but confined to the isolated attachments dir under `passwd`.
         await fileInput.setInputFiles({
           name: '../../etc/passwd',
           mimeType: 'application/octet-stream',
           buffer: Buffer.from('x'),
         })
         await expect
           .poll(async () => (await fs.readdir(attachmentsDir)).length, { timeout: 15_000 })
           .toBe(2)
         const names = (await fs.readdir(attachmentsDir)).sort()
         const traversalStored = names.find((n) => n.endsWith('-passwd'))
         expect(traversalStored).toBeTruthy()
         expect(traversalStored).not.toContain('..')
         expect(path.dirname(path.join(attachmentsDir, traversalStored!))).toBe(attachmentsDir)
       } finally {
         await session.stop()
       }
     })

     test('an oversized upload shows a visible error in the composer and stores nothing', async ({ page, e2eServerKind }) => {
       test.setTimeout(120_000)
       const session = await bootFreshCodexPane(page, e2eServerKind)
       try {
         const attachmentsDir = path.join(session.homeDir(), '.freshell', 'attachments')
         const fileInput = session.paneRoot.locator('input[type="file"]')
         const list = session.paneRoot.getByRole('list', { name: 'Attachments' })

         await fileInput.setInputFiles({
           name: 'huge.bin',
           mimeType: 'application/octet-stream',
           buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 7),
         })
         // The visible error chip — the same text on both legs because the
         // mapping keys off res.status (Task 2), not the response body
         // (express 413 HTML vs axum 413 empty).
         await expect(list.getByText(/exceeds the 10 MB attachment size limit/)).toBeVisible({ timeout: 30_000 })
         const entries = await fs.readdir(attachmentsDir).catch(() => [] as string[])
         expect(entries.filter((n) => n.includes('huge'))).toEqual([])
       } finally {
         await session.stop()
       }
     })
   })
   ```

   Registration in `test/e2e-browser/playwright.config.ts` `MATRIX_SPECS` (add after the rewind entry, with a comment):

   ```ts
   /agent-checkpoint-rewind\.spec\.ts$/, // AGENT-11: checkpoint rewind flow
   /agent-attachments\.spec\.ts$/, // AGENT-11 (slice): composer uploads land on the server; failures are visible
   ```

2. **Green.** After Tasks 1-2 land, `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/agent-attachments.spec.ts` passes. (First rust-lane run builds the release binary — slow once, then incremental.)

3. **Refactor / parity leg.** Run the legacy lane: `--project=legacy-chromium` passes (Node expresses its own 413 page; the chip text is identical via the Task 2 mapping). Judge any divergence: a legitimately different accepted behavior (e.g. Node 413 body shape) must NOT be "fixed" client-side; the mapping already absorbs it.

- **Per-task verification gate:** rust-chromium lane of the new spec green; legacy-chromium lane of the new spec green; `agent-checkpoint-rewind.spec.ts` still green on rust-chromium (adjacent surface).
- **Commit:** `test(e2e): cover composer attachment upload and oversized-failure on both server lanes`
- [~] Update `run-state.md` task progress.

## Task 4 — Full verification & QA gate

**Goal.** Impacted-verification expansion, clean tree, full QA gate through the Darkforge wrapper, identity-checked against the recorded baseline.

1. Impacted suites:
   - `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/lib/fresh-agent-checkpoints.test.ts`
   - `cargo test -p freshell-server`
   - Both Playwright lanes of `agent-attachments.spec.ts` (already done in Task 3, note as reused evidence).
2. Tree hygiene: `git status --porcelain` clean; `git log origin/main..HEAD` shows exactly the planned task commits; plan self-review re-checked (tests before impl in every task history).
3. Full QA: `darkforge qa --repo '/home/dan/code/freshell' --id 'te1m'`. Accept exit 0; a nonzero exit is acceptable **only if** every failing identity is one of the three recorded baseline failures (`test/unit/vite-config.test.ts > getNetworkHost` × 3).
4. Evidence package for the code-review stage: QA gate output, both e2e lane results, task commit list.
- **Commit:** none new (only if stragglers exist); keep tree clean.
- [~] Update `run-state.md`: mark Stage 4 tasks complete, QA evidence recorded, prepare Stage 5 (code review) handoff.
