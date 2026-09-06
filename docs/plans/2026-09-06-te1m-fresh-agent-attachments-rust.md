# Fresh-agent attachments on the Rust server + visible composer upload failures (te1m)

> **For agentic workers:** REQUIRED: Use subagent-driven development (subagents for each task) and socratic questioning (present findings, discuss approach, settle decisions before implementing).

Plan revision 2 (2026-09-06) — updated from revision 1 (a57baa5f4) by the Stage-2 load-bearing validation. Ledger: `$LOGS_DIR/load-bearing-ledger.md`; validator evidence: `$LOGS_DIR/reports/load-bearing-validator-{1..5}.md` and `load-bearing-finder.md` (cited by path; evidence itself stays out of this plan). Corrections applied: client extension gate forces `.txt` test fixtures (LB-6); e2e installer + leaf matcher now copied verbatim from the proven rewind spec (LB-7/LB-8); `#[derive(Clone)]` on axum state (LB-9); auth enforced as outermost middleware to preserve Node's 401-before-413 ordering (LB-10); e2e acceptance runs on the configured **cloud** backend with the content-addressed auto-built image (LB-12); per-test cloud budget 90s, no server-restart leg (LB-13).

## User Request

> Implement the REST upload route on the Rust server with the Node route as the behavioral contract, and make the composer surface upload failures visibly:
>
> - **Task 1 — Missing Rust REST route.** `crates/freshell-server/src/main.rs` still lacks `POST /api/fresh-agent/attachments`; the SPA composer (`src/components/fresh-agent/FreshAgentComposer.tsx:160-174`) issues `fetch('/api/fresh-agent/attachments?name=...')` — unusable on the Rust leg per the exercised-statement and test inventory. Implement it on the Rust server with the Node route as the behavioral contract.
> - **Task 2 — Composer upload failures swallowed.** The composer shows upload errors via an error chip (`src/components/fresh-agent/FreshAgentComposer.tsx:166-178`), which the hypothesis pins as silent because the fetch lacks the localhost-400 signal only; per the exercised-statement audit, preserving Node behavior is the contract, make failures visible (add diagnostics/messages where Node parity allows) and keep chip state faithful to the server's response.
> - **Acceptance.** Tests must execute at every layer. A factory spec must assert a visible error chip for an upload failure; it must not depend on the silent catch. Full suite green and the production deployment serving 200 for this route with all layers exercised.
> - **Forbidden.** GitHub-flavored orchestration only, forbidden TDD policy violations, never push before Gates 3-5, never mark done until evidence is collected, never accept test skips/weak assertions.

*(Reading of "the production deployment serving 200": satisfied by Task 4 step 4 — a production-mode scratch server built from this branch, exercising the route end to end (401/200+bytes-on-disk/413) — plus the canonical squash landing; the user's live self-hosted server is never restarted by this job (explicit constraint, LB-14).)*

## Goal

The fresh-agent composer's paperclip upload flow works end to end on the self-hosted **Rust** server: `POST /api/fresh-agent/attachments` exists on `freshell-server` with behavior parity against the legacy Node route (the oracle), including Node's auth-before-body-limit ordering, and upload failures (unsupported server / oversized file / server error) produce a **visible, human-readable** error chip in the composer.

## Architecture

Two server legs. The SPA composer's paperclip (hidden `<input type="file">`) fetches `POST /api/fresh-agent/attachments?name=<raw>` with the raw `File` body (`FreshAgentComposer.tsx:160-180`). Legacy Node leg: `server/fresh-agent-extras-router.ts:260-287`. Rust leg (production): currently 404 — this work adds it as a new leaf module `crates/freshell-server/src/attachments.rs` merged in `main.rs` next to `checkpoints::router` (same prior-art pattern as the checkpoints port).

Route internals (corrected at Stage 2):

- **Auth as the router's outermost layer** (`axum::middleware::from_fn_with_state` guard calling `crate::boot::is_authed`/`unauthorized`), added AFTER the `DefaultBodyLimit` layer so it runs first — preserving Node's `authenticateToken`-middleware-then-`express.raw`-limit ordering: an unauthenticated request is 401 even when its body exceeds the cap (LB-10; axum 0.8.9 layer/wrap semantics verified from vendored source, validator-1 report).
- **Body**: `Bytes` extractor honoring `DefaultBodyLimit::max(10 * 1024 * 1024)` on this sub-router — over-cap rejects with 413 (verified: vendored axum-core rejection status + axum's own chunked `body_limited_by_default` test + in-repo precedent `crates/freshell-server/src/proxy.rs:804-837`; validator-1 report).
- **Storage**: boot-resolved `home` (same value threaded to `checkpoints_state`, `main.rs:~1544-1553`) joined with `.freshell/attachments`. Deliberate choice over a fresh `os.homedir()` resolution: boot `home` is the server-wide storage convention and equals `os.homedir()` whenever `FRESHELL_HOME` is unset (the production default); the e2e harness forces `FRESHELL_HOME`/`HOME` to the isolated dir (LB-11 acceptable; validator-2 report).
- **Filename**: `<uuid4-simple[..8]>-<sanitize_filename(name)>` where `sanitize_filename` ports Node's `sanitizeFilename` (POSIX basename + `[^a-zA-Z0-9._-]`→`_` per UTF-16 code unit, astral chars → two `_`, empty → `attachment`).
- **Repeated `?name`**: `Query<Vec<(String, String)>>` preserves duplicates (verified: axum 0.8.9 Query → serde_urlencoded "sequences of pairs"; validator-1), enabling the missing/empty/repeated → 400 parity with express's array-that-isn't-a-string.

The composer change is a narrow, exported status→message mapping (`attachmentUploadErrorMessage`) used in the existing `uploadAttachment` error branch — no capability probing, no client-side size pre-check, no new UI. The composer **already gates extensions client-side** before any upload (`attachmentRejection`, `FreshAgentComposer.tsx:93-103`, called from `addFiles` at :400-411): extensionless/text/image names pass, `.bin` etc. are rejected with a "not supported" chip and never reach `fetch` — all tests below therefore use textual fixture names (LB-6).

## Tech Stack

- Rust: `crates/freshell-server` (axum 0.8.9, tokio tokio::fs, tower, tempfile [dev], uuid, serde_json, tracing) — existing deps only, **no Cargo.toml change** (verified: `checkpoints.rs` library code already uses `tokio::fs`; `uuid` v4 at `crates/freshell-server/Cargo.toml:49`).
- Client: React 18 + TypeScript; Vitest + Testing Library + `@testing-library/user-event` 14.6.1 (works on the composer's never-disabled hidden file input; validator-3).
- E2E: Playwright matrix specs; fake codex app-server fixture at `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`; `createE2eServerHandle` with isolated HOME (forces `FRESHELL_HOME`+`HOME`; validator-2).
- Cloud: both `FRESHELL_E2E_BACKEND` and `FRESHELL_VITEST_BACKEND` are `cloud` in `~/.bashrc`; the cloud e2e image is content-addressed to HEAD sha and auto-built+pushed when absent (`scripts/e2e-cloud.sh`:419-427, 452-478; binary baked via `FRESHELL_E2E_RUST_SERVER_BIN`, `docker/cloud-run/Dockerfile:126`; validator-5).

## Global Constraints

1. **Node route is the behavioral oracle.** Statuses, error strings, sanitization, storage location, AND middleware ordering must match `server/fresh-agent-extras-router.ts:10,15-22,260-287` unless a divergence is declared here. Declared divergences: (a) fs write failure → `500 {"error":"failed to save attachment"}` + warn log (Node leaves the response hanging forever on an fs rejection — a visible 500 preserves the failure visibility this work item is about); (b) 413 body format (express HTML error page vs axum default rejection body) — status is the contract; the client maps on status and never parses the 413 body.
2. **TDD, red first, real behavior.** Failing test on behavior first, minimal implementation, refactor. Real route/component/spec paths only. Subagent-driven orchestration per the execution skill.
3. **Repo rules.** Worktree only, branch `darkforge/te1m` (base `398a866f`), never push directly to `origin/main` (Darkforge landing handles canonical at the end). `cargo fmt --all --check` + workspace clippy `-D warnings` lanes stay clean (part of the QA gate).
4. **Backends are cloud.** With `FRESHELL_E2E_BACKEND=cloud`, affected e2e specs must actually pass on the cloud backend before landing (AGENTS.md): the new spec MUST be cloud-legal (≤120s per test, no server-restart leg — the property that got `agent-checkpoint-rewind.spec.ts` listed in `CLOUD_SKIP_SPECS`; fake codex sidecar via `CODEX_CMD` only, same shape as the cloud-legal `agent-continuity-matrix.spec.ts`) and must NOT be added to `CLOUD_SKIP_SPECS`. Cloud verification command: `npm run test:e2e:cloud -- --project=rust-chromium test/e2e-browser/specs/agent-attachments.spec.ts` (and legacy-chromium); first run at a given HEAD auto-builds the image (~13 min cold, ~$0.03/run). The QA gate's vitest lanes inherit `FRESHELL_VITEST_BACKEND=cloud` automatically.
5. **QA gate acceptance.** `/home/dan/.local/share/darkforge/sources/freshell-qa.sh` via `darkforge qa`: `npm run check` (typecheck + coordinated full vitest) then `cargo fmt --all --check` + clippy lanes. Recorded baseline at base: exit 1 with exactly 3 pre-existing failures, all `test/unit/vite-config.test.ts > getNetworkHost` (identities listed in run-state). Success = exit 0, or nonzero whose failing identities are a subset of those three (LB-13: baseline recorded under this exact environment, so the tolerance stays sound).
6. **No production restart** of the live self-hosted server (explicit user approval out of scope). "Production deployment serving 200" evidence comes from the Task 4 scratch production-mode smoke instead.
7. **A11y discipline.** No new interactive elements; reuse existing roles/labels (`role="list"` aria-label `Attachments`, `role="listitem"` chips, `aria-label="uploading"` spinner, `aria-label="Send"` submit).
8. docs/index.html: paperclip already exists in the shipped UI; no change.

## Functional De-Risking / Evidence

All claims resolved in Stage 2 — full ledger at `$LOGS_DIR/load-bearing-ledger.md`; reports at `$LOGS_DIR/reports/load-bearing-*.md`. Headline resolutions: axum behavior verified from vendored 0.8.9 sources + in-repo tests (V1); e2e isolated-HOME chain confirmed end to end incl. `resolve_home()` FRESHELL_HOME-first (`main.rs:175`, `:2230-2236`) and `setupHome`-before-spawn (V2); composer DOM/test mechanics byte-verified (V3); `setInputFiles` name pass-through proven empirically on the resolved Playwright 1.58.2 + system Chrome (V4); cloud image/routing model + skip-list analysis (V5).

## Task 1 — Rust endpoint `POST /api/fresh-agent/attachments`

**Files.**

- *Create:* `crates/freshell-server/src/attachments.rs` (route + state + in-module tests)
- *Modify:* `crates/freshell-server/src/main.rs` (`mod attachments;` after `mod ai_title;` [alphabetical]; state construction immediately after the `checkpoints_state` block ~line 1553 with the same comment style; `.merge(attachments::router(attachments_state))` immediately after `.merge(checkpoints::router(checkpoints_state))`)

**Interfaces.** Consumes `crate::boot::{is_authed, unauthorized}` (pub(crate)); axum 0.8 `middleware::from_fn_with_state`, `DefaultBodyLimit`, `Query`, `Bytes`; `serde_json::json`; `uuid::Uuid`; `tokio::fs`. Produces:

```rust
#[derive(Clone)]  // LB-9: axum Router state + from_fn_with_state require Clone
pub struct AttachmentsApiState {
    /// Mirrors CheckpointsApiState::auth_token.
    pub auth_token: Arc<String>,
    /// Boot-resolved home (see Architecture; LB-11).
    pub home: Arc<PathBuf>,
}

pub fn router(state: AttachmentsApiState) -> Router
pub(crate) fn sanitize_filename(name: &str) -> String
```

**Module doc comment** (place at top of `attachments.rs`): the parity table from Architecture plus the two declared divergences and the auth-ordering note; state explicitly that Node middleware ordering (auth before body read) is reproduced by putting auth in the outermost layer.

**Behavioral contract** (the implementation target; implementer authors the code at red phase — Stage-2 rule: corrections of falsified planned code are stated as decision + behavior, validated pieces are reused):

1. `router(state)` shape (all semantics verified in validator-1):

   ```text
   Router::new()
     .route("/api/fresh-agent/attachments", post(upload_attachment))
     .layer(DefaultBodyLimit::max(ATTACHMENT_MAX_BYTES)) // 10 MiB, scoped to this sub-router
     .layer(middleware::from_fn_with_state(state.clone(), require_auth)) // OUTERMOST: runs first
     .with_state(state)
   ```

   `require_auth(State, Request, Next) -> Response`: `is_authed(request.headers(), &state.auth_token)` else `unauthorized()`; else `next.run(request).await` (axum 0.8 `from_fn` signature).
2. `upload_attachment(State, HeaderMap, Query<Vec<(String, String)>>, Bytes) -> Response` — no auth code here (already enforced):
   - `name`: exactly one non-empty `name` pair, else 400 `{"error":"name query parameter required"}` (repeated key also 400 — express array parity).
   - content-type `application/octet-stream` (exact type token, case-insensitive, ignoring parameters) AND non-empty body, else 400 `{"error":"attachment body must be a non-empty application/octet-stream"}`.
   - `tokio::fs::create_dir_all(<home>/.freshell/attachments)` then `tokio::fs::write(<dir>/<uuid8>-<sanitize_filename(name)>, body)`; any fs error → 500 `{"error":"failed to save attachment"}` + `tracing::warn!`.
   - success → 200 `Json({"path": target.display().to_string(), "bytes": body.len()})` (plain, no envelope).
3. `sanitize_filename` — port verified in plan revision 1 (trim trailing `/`, last-`/` segment, `[a-zA-Z0-9._-]` kept, other BMP chars → one `_`, astral chars → two `_`, empty → `attachment`).
4. `main.rs` wiring — `auth_token: Arc::clone(&auth_token)`, `home: Arc::new(home.clone().unwrap_or_else(|| PathBuf::from(".")))` (verbatim checkpoints precedent).

**Implementation (TDD).**

1. **Red.** Create the module with the state struct, a `router()` whose single route is a stub returning `StatusCode::NOT_FOUND.into_response()`, `sanitize_filename` as identity, wire `main.rs`, and add the test module below. Run `cargo test -p freshell-server attachments` — compiles (drives out any signature errors early) and every test fails on behavior (404/mismatch), not on missing symbols.

   Tests (in `#[cfg(test)] mod tests`, following `checkpoints.rs`'s oneshot idiom: local `use tower::ServiceExt;`, `tempfile::TempDir` home, `state()` helper with `auth_token: "tok"`, `Request::builder()` with `x-auth-token: tok` + content-type, `Body::from(...)`; `json_body` helper via `axum::body::to_bytes`):

   - `saves_a_raw_binary_attachment_and_returns_its_path` — `?name=note.txt`, body `hello attachment` → 200; `bytes == 16`; `path` parent == `<temp>/.freshell/attachments`; basename `[0-9a-f]{8}-note.txt`; disk bytes equal. *(Node oracle: "saves a raw binary attachment and returns its path".)*
   - `sanitizes_hostile_filenames_before_saving` — `?name=../../etc/passwd` → 200; parent == attachments dir; basename no `..`, ends `-passwd`; on-disk bytes. *(Node oracle: "sanitizes hostile filenames before saving".)*
   - `rejects_missing_name_empty_name_and_empty_body` — four sub-requests in one test: no name + empty body, `?name=` + body, `?name=a.txt&name=b.txt` + body, `?name=x.txt` + empty body → all 400 with the exact oracle error strings (name message for the first three, body message for the last). *(Node oracle: "rejects missing name and empty body" + repeated-name parity from `typeof name !== 'string'`.)*
   - `rejects_a_non_empty_body_with_the_wrong_content_type` — `text/plain` + non-empty body → 400 body message. *(Parity from route source; the oracle suite's 400 case uses json content.)*
   - `rejects_unauthenticated_requests` — no token header → 401 `{"error":"Unauthorized"}`; attachments dir not created. *(Parity from Node `authenticateToken` middleware at the mount.)*
   - `unauthenticated_over_cap_is_401_not_413` — no token + `10 MiB + 1` body → **401**. *(LB-10: Node's middleware-first ordering; would be 413 if auth lived inside the handler.)*
   - `allows_the_cap_and_rejects_one_byte_over` — authenticated: exactly `ATTACHMENT_MAX_BYTES` → 200; `+1` → 413. *(Parity from `ATTACHMENT_MAX_BYTES` + `express.raw limit`; status is the contract.)*
   - `a_save_failure_is_a_visible_500_not_a_hang` — squat `<temp>/.freshell` with a regular file so `create_dir_all` fails → 500 `{"error":"failed to save attachment"}`. *(Declared divergence.)*
   - `sanitize_filename_ports_the_node_basename_plus_replace_semantics` — table: `note.txt`, `/a/b/c.png`, `../../etc/passwd`, `C:\foo:bar.txt` → `C__foo_bar.txt`, `a  b.txt` → `a__b.txt`, `café.png` → `caf_.png`, `😀.png` → `__.png`, `///` → `attachment`.

2. **Green.** Implement per the behavioral contract above. `cargo test -p freshell-server attachments` all pass.
3. **Refactor.** `cargo fmt` + `cargo clippy -p freshell-server --all-targets -- -D warnings` clean.

- **Per-task verification gate:** `cargo test -p freshell-server` (whole crate — `main.rs` changed) green; clippy + fmt clean.
- **Commit:** `feat(rust): add POST /api/fresh-agent/attachments with Node-route parity`

## Task 2 — Composer: visible, mapped upload-failure chips

**Files.**

- *Modify:* `src/components/fresh-agent/FreshAgentComposer.tsx` — export `attachmentUploadErrorMessage` + rewire the `!res.ok` branch in `uploadAttachment` (current code: `const data = await res.json().catch(() => null); throw new Error(data?.error || data?.message || \`upload failed (${res.status})\`)`, lines ~160-180).
- *Test:* `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx` — add `userEvent` import; new `describe('attachmentUploadErrorMessage')` + `describe('attachments')`.

**Client gate awareness (LB-6).** `addFiles` (lines 400-426) calls `attachmentRejection(provider, file.name)` FIRST: names without `.` pass; `TEXTUAL_EXTENSIONS`/`IMAGE_EXTENSIONS` pass; `pdf` passes for claude only; anything else (`bin`, and any name whose last-`.` suffix is unknown — including `../../etc/passwd` whose suffix parses to `/etc/passwd`) produces an immediate "not supported" error chip and **never calls fetch**. Every test below that must reach the network therefore uses a textual name (`note.txt`, `huge.txt`).

**Implementation (TDD).**

1. **Red.** Add to the test file (file-local helpers already present: `getInput()`, `GROUPED_COMMANDS`; `@/lib/api` is mocked; jsdom has no global `fetch` — stub it, `vi.stubGlobal` + `vi.unstubAllGlobals` in afterEach):

   ```tsx
   describe('attachmentUploadErrorMessage', () => {
     it('maps statuses and server messages to user-facing text', () => {
       expect(attachmentUploadErrorMessage(404, { error: 'Not found' }, 'a.txt'))
         .toBe('Attachments are not supported by this server')
       expect(attachmentUploadErrorMessage(413, null, 'big.txt'))
         .toBe('"big.txt" exceeds the 10 MB attachment size limit')
       expect(attachmentUploadErrorMessage(401, { error: 'Unauthorized' }, 'a.txt'))
         .toBe('Unauthorized')
       expect(attachmentUploadErrorMessage(500, null, 'a.txt'))
         .toBe('upload failed (500)')
     })
   })
   ```

   Component tests (verified DOM facts — validator-3: chips list is `<div role="list" aria-label="Attachments">` with `<span role="listitem">` children; `title={attachment.error ?? attachment.path ?? attachment.name}`; error renders as `— <text>` with a real em-dash U+2014; spinner `<Loader2 aria-label="uploading">`; file input `type="file" multiple hidden aria-hidden`, never disabled; submit button `aria-label="Send"`; `onSend?: (value: string, attachmentPaths: string[])`):

   - `uploads an attachment and sends its server path with the message` — fetch stub resolves 200 `json: async () => ({ path: '/home/u/.freshell/attachments/abcd1234-note.txt', bytes: 16 })`; `userEvent.upload(container.querySelector('input[type="file"]'), new File(['hello attachment'], 'note.txt', { type: 'text/plain' }))`; assert fetch called with `'/api/fresh-agent/attachments?name=note.txt'` + `objectContaining({ method: 'POST' })`; listitem `toHaveAttribute('title', '/home/u/.freshell/attachments/abcd1234-note.txt')` (via `waitFor`); type `look at this` via `getInput()`; click `getByRole('button', { name: 'Send' })`; assert `onSend` called with `('look at this', ['/home/u/.freshell/attachments/abcd1234-note.txt'])`.
   - `shows a visible error chip when the server does not support attachments` — fetch stub 404 `json: async () => ({ error: 'Not found' })`; upload `note.txt`; `within(list).findByText('— Attachments are not supported by this server')`.
   - `shows a visible error chip when the file exceeds the server size limit` — fetch stub 413 whose `json()` THROWS (express's HTML page cannot be parsed — the mapping must be status-driven); upload **`huge.txt`**; assert `fetch` was called (proves the extension gate passed it); `within(list).findByText(/exceeds the 10 MB attachment size limit/)`.

   Success criteria: red on missing export / old fallback text.
2. **Green.** Implementation (exact):

   ```ts
   /**
    * Map an attachments upload failure to user-facing text. The Node oracle
    * sends `{error}`/`{message}` JSON for its own 4xx paths, so the server's
    * own message wins when present. Two statuses carry client-added clarity:
    * 404 means the route does not exist on this server, and 413 is the
    * server's 10 MB body cap whose express body is an HTML page that cannot
    * be parsed as JSON.
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

   and the `!res.ok` branch:

   ```ts
   if (!res.ok) {
     const data = (await res.json().catch(() => null)) as {
       error?: string
       message?: string
     } | null
     throw new Error(attachmentUploadErrorMessage(res.status, data, file.name))
   }
   ```

3. **Refactor.** Nothing to extract; confirm lint/typecheck clean.

- **Per-task verification gate:** `npm run test:vitest -- run test/unit/client/components/fresh-agent/` green.
- **Commit:** `feat(freshagent): map attachment upload failures to clear composer error chips`

## Task 3 — E2E spec `agent-attachments.spec.ts`

**Files.**

- *Create:* `test/e2e-browser/specs/agent-attachments.spec.ts`
- *Modify:* `test/e2e-browser/playwright.config.ts` — add `/agent-attachments\.spec\.ts$/, // AGENT-11 (slice): composer uploads land on the server; failures are visible` to `MATRIX_SPECS` after the rewind entry.

**Authoring rule (LB-7/LB-8):** the spec's boilerplate is COPIED VERBATIM from `test/e2e-browser/specs/agent-checkpoint-rewind.spec.ts`, not paraphrased:

- imports (fs/os/path/fileURLToPath/fixtures.js/external-target.js/test-harness.js/pane-picker.js) + `import { Buffer } from 'node:buffer'`
- `__filename`/`__dirname` + `FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(__dirname, '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')`
- `installFakeCodexAppServer(destDir)` — the **spawnSync re-exec wrapper** (verbatim from the rewind spec; rationale: ESM bare-specifier `ws` resolution and permission bits when running from /tmp)
- `findFreshAgentLeaf(node)` — verbatim: `node.type === 'leaf' && node.content?.kind === 'fresh-agent'`; recurse `split` children
- `const test = base.extend<{}, { e2eServerKind: 'legacy' | 'rust' }>({})`
- the boot sequence — verbatim from the rewind spec's first test: `mkdtemp` shared root, `createE2eServerHandle(process.env, { kind: e2eServerKind, construct: { env: { CODEX_CMD: fakeCodexPath }, setupHome: async (homeDir) => { ...config.json with freshAgent enabled + codex provider gpt-5-codex... } } })`, `server.start()`, `page.goto(baseUrl/?token&e2e=1)`, `TestHarness` waitForHarness/waitForConnection, `setAvailableClis({ claude: false, codex: true })` dispatch, `openPanePicker` → Freshcodex button → directory combobox fill + Enter, `paneRoot = page.locator('[data-context="fresh-agent"]').last()`, `getActiveTabId`, idle-status poll via `findFreshAgentLeaf(...)?.content?.status`

**Deviations copied flow intentionally makes (cloud legality, LB-12/LB-13):** no server-restart leg at all (the rewind spec's restart is why it's cloud-skipped); `test.setTimeout(90_000)` per test; capture the `homeDir` argument in a test-scoped `let` (the rewind spec receives it as `setupHome`'s parameter — same mechanism); teardown via `server.stop().catch(() => {})` in an inner `try/finally` and `fs.rm(sharedRoot, ...)` in the outer `finally` (rewind's pattern).

**The two tests.**

1. `'attaching files through the composer stores them on the server under sanitized names'`:
   - `attachmentsDir = path.join(homeDir, '.freshell', 'attachments')`; `fileInput = paneRoot.locator('input[type="file"]')`; `list = paneRoot.getByRole('list', { name: 'Attachments' })`.
   - Happy path: `fileInput.setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello attachment') })`; listitem count 1; `paneRoot.getByLabel('uploading')` count polls to 0; first listitem `toHaveAttribute('title', /[0-9a-f]{8}-note\.txt$/)` (auto-retrying — this is the readiness gate, so the spinner probe can never race); `fs.readdir(attachmentsDir)` polls to match `/^[0-9a-f]{8}-note\.txt$/`; file contents == `hello attachment`.
   - Traversal: `setInputFiles({ name: '../../etc/secret.txt', mimeType: 'application/octet-stream', buffer: Buffer.from('x') })` (the `.txt` suffix passes the client extension gate — LB-6; server-side sanitization is what's under test); dir entry count → 2; the entry ending `-secret.txt` has no `..` and its dirname is exactly `attachmentsDir`.
2. `'an oversized upload shows a visible error in the composer and stores nothing'`:
   - `setInputFiles({ name: 'huge.txt', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 7) })`; `list.getByText(/exceeds the 10 MB attachment size limit/)` visible within 30s (identical text on both legs — Task 2 maps on `res.status`, never the body); `fs.readdir(attachmentsDir)` contains no `huge` entry.
   - This is the acceptance "factory spec asserting a visible error chip for an upload failure".

3. Do NOT check the AGENT-11 golden-checklist box in `docs/plans/AGENT-11-...`-style tracking docs — this work item covers a slice; state that in the spec's file-level comment.

**Implementation (TDD-flavored for e2e).**

1. **Red.** Add spec + registration; run the rust lane: expected FAIL showing the 404-era chip (`Attachments are not supported by this server`, Task 2 landed) in test 1's title assertion — proving the spec executes the real upload path on the Rust leg. Dev-loop command: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/agent-attachments.spec.ts` (same form as the repo's `test:e2e:chromium` script; first rust run builds `target/release/freshell-server` from source — bootstrap slowness expected once, then incremental).
2. **Green.** After Task 1: rust lane passes.
3. **Parity leg.** legacy-chromium lane passes; on divergence, prefer server-parity reasoning (Node route is oracle); the 413-body difference is already absorbed by the status-based mapping.

- **Per-task verification gate:** rust-chromium + legacy-chromium local lanes of the new spec green; `agent-checkpoint-rewind.spec.ts` (rust-chromium) still green (adjacent surface; it `test.skip`s its rust gesture already).
- **Commit:** `test(e2e): cover composer attachment upload and oversized-failure on both server lanes`

## Task 4 — Full verification, cloud e2e acceptance, production-mode smoke, QA gate

1. Impacted suites: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/lib/fresh-agent-checkpoints.test.ts`; `cargo test -p freshell-server`; tree clean, commit list equals planned tasks.
2. **Cloud e2e acceptance (required — `FRESHELL_E2E_BACKEND=cloud`, AGENTS.md):** after all task commits are pushed nowhere but committed locally at HEAD, run `npm run test:e2e:cloud -- --project=rust-chromium test/e2e-browser/specs/agent-attachments.spec.ts` and `npm run test:e2e:cloud -- --project=legacy-chromium test/e2e-browser/specs/agent-attachments.spec.ts`. First run at this HEAD auto-builds the content-addressed image (~13 min cold; ~$0.03/run; gcloud identity per the documented ladder — do NOT modify gcloud config). Verify from run output that the spec actually executed (non-zero matched-test counts on both projects).
3. **Production-mode scratch smoke ("production deployment serving 200" evidence):** with `target/release/freshell-server` current (the e2e rust lane built it; else `cargo build --release -p freshell-server`): choose a free high port (`ss -tln`), isolated `SMOKE_HOME=$(mktemp -d)`, `AUTH_TOKEN=te1m-smoke FRESHELL_HOME=$SMOKE_HOME scripts/launch-rust.sh --port <p> --skip-build`; assert: (a) POST with the token + octet-stream body `smoke-bytes` + `?name=smoke.txt` → 200 with `bytes: 11` and a path under `$SMOKE_HOME/.freshell/attachments/` whose bytes on disk equal; (b) POST without token → 401; (c) POST with token and a 10 MiB + 1 body → 413; then `scripts/launch-rust.sh --stop --port <p>` and `rm -rf "$SMOKE_HOME"`. Record outputs into `$LOGS_DIR/reports/task4-prod-smoke.md`. Never touch ports 3001/3002.
4. **Full QA gate:** `darkforge qa --repo '/home/dan/code/freshell' --id 'te1m'`; accept exit 0 or nonzero ⊆ the three recorded baseline identities (Global Constraint 5).
5. Evidence package for Gate 5: QA output, both cloud e2e legs, smoke receipt, commit list; update `run-state.md` (tasks complete, QA evidence paths, Stage 5 ready).
- **Commit:** none new beyond straggler fixups; keep the tree clean.

## Run-state cadence

Update `$LOGS_DIR/run-state.md` after every landed task commit (task count, note) and at every stage boundary per the run contract.
