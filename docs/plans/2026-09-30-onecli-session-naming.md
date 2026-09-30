# OneCLI-First Session Naming and Codex Prompt Parsing Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix Freshell automatic session naming so a configured OneCLI Gemini credential route supplies authentication first, with existing direct key sources as fallback when no applicable OneCLI Gemini credential is available. Parse Codex CLI `event_msg` `user_message` records so the initiating prompt is available to naming. Restore the suite to green, including the reproducible OpenCode readiness failure blocking the base suite.

### Explicit constraints
- Prefer OneCLI's configured Gemini credential route; fall back to existing supported key sources when that route is absent or OneCLI explicitly reports no Gemini credential/app connected. Respect other OneCLI policy or authorization failures.
- Support Codex `event_msg` records with `payload.type == "user_message"` and the message text while keeping existing response-item user-message support.
- Fix the existing base-suite blocker and any additional failures found while establishing green.
- Use the the-usual workflow.
- Run Vitest using the user-selected Cloud Run backend (~$0.02 per run); do not silently switch to local.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** Automatic session naming uses OneCLI's configured Gemini credential route first, falls back to existing direct Gemini keys only when OneCLI is not configured or explicitly reports no connected Gemini credential, uses Codex's initiating event message, and leaves the supported test suite green.

**Architecture:** Keep the existing direct-key Gemini transport for non-naming AI features. Add a session-name-specific capability and transport used by the unified naming worker, automatic title sweep, and session title endpoint; it sends no direct key through a configured OneCLI route and retries with the existing direct key only for OneCLI's explicit missing-credential responses. Teach Codex parsing to feed both supported user-message record shapes through the same existing normalization and title extraction path. Repair OpenCode's readiness qualification first and require a full green Cloud Vitest checkpoint before the naming or parser tasks.

**Tech Stack:** Rust (Axum, Tokio, reqwest with rustls, serde_json), React/TypeScript, Vitest, Playwright, Cargo, pnpm 10.34.5.

## Global Constraints

- Preserve the current direct-key sources and precedence: non-empty GOOGLE_GENERATIVE_AI_API_KEY wins at boot, settings.ai.geminiApiKey is the existing fallback, and a later non-empty settings save force-updates the shared key cell. Do not add a new credential store, dependency, live Gemini call, or user setting.
- Use a scheme-appropriate OneCLI gateway proxy variable (HTTPS_PROXY/https_proxy for production Gemini HTTPS; HTTP_PROXY/http_proxy only for the HTTP test endpoint) and the OneCLI aoc_ marker. Do not use ONECLI_URL as a request endpoint. Treat NO_PROXY/no_proxy bypass for generativelanguage.googleapis.com as absence of an applicable proxy route. In production, requests still target the Gemini API host so OneCLI can apply host policy and inject its configured credential; the Rust client must trust the OneCLI CA through the platform's existing SSL_CERT_FILE configuration.
- Retry with a direct key only when a non-success response from the configured OneCLI route has JSON error exactly credential_not_found or app_not_connected. Never use a direct key after network/TLS errors, proxy authentication failures, access_restricted, approval/policy errors, generic upstream 401/403 responses, or any other response. Do not log prompts, direct keys, proxy URLs, proxy authorization, or response bodies.
- Keep OneCLI credential routing scoped to session naming. The existing shared Gemini transport and its direct-key behavior remain in place for terminal summaries and other non-naming AI features. Keep the existing title toggle semantics and the settings key-cell update behavior.
- Use pnpm 10.34.5 and the repo-owned test entry points. Every Vitest invocation must set FRESHELL_VITEST_BACKEND=cloud; broad agent gates also set GCLOUD_ROBOT_REQUIRE=1 and a meaningful FRESHELL_TEST_SUMMARY. Keep the configured FRESHELL_E2E_BACKEND=cloud for cloud-compatible browser specs. The OpenCode runtime qualification is marked local-only because it needs the Docker supervisor; run that one through its direct local Chromium script because Cloud E2E excludes it. Do not substitute local Vitest.
- Before each broad coordinated suite run, inspect pnpm run test:status and wait for the shared gate if occupied. Use the recorded base failure and reports/workspace-baseline.md; do not rebase this worktree or change base_ref to incorporate later origin/main commits.
- Use synthetic keys and loopback HTTP/proxy fixtures only. Never contact live Gemini while verifying the route.
- Do not deploy, restart, or mutate the self-hosted Freshell server. No end-user documentation change is needed because this work adds no user-facing setting or workflow.

---

## Files and Responsibilities

- test/e2e-browser/helpers/opencode-native-history.ts — recognize readiness only when bracketed-paste mode is enabled and the visible prompt includes the model configured by the qualification.
- test/unit/tooling/testing/opencode-native-history.test.ts — preserve the negative banner, terminal mode, ANSI, resumed prompt, and current model cases.
- test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts — make source-output and rendered-browser readiness require the same current model evidence and enabled browser input mode.
- crates/freshell-server/src/ai_title.rs — add session-name-specific OneCLI route detection, capability, request transport, and narrow OneCLI missing-credential response classification; leave the generic GeminiHttp direct-key path intact.
- crates/freshell-server/src/main.rs — construct and wire the session-name capability/transport while keeping the generic direct transport for non-naming AI.
- crates/freshell-server/src/session_name_generation.rs — gate background naming on the combined name capability and the existing autoGenerateTitles setting.
- crates/freshell-server/src/auto_title_sweep.rs — use the name capability for automatic generation availability and the name transport for its Gemini title call.
- crates/freshell-server/src/sessions.rs — use the name capability/transport in the session generate-title endpoint without changing its setting-toggle semantics.
- crates/freshell-server/src/session_name_generation_tests.rs — prove the real worker saves a title through the session-name transport and prove error fallback/policy boundaries with a local fixture.
- crates/freshell-sessions/src/parse/codex.rs — normalize event_msg/user_message and response_item user messages through one extraction branch.
- crates/freshell-sessions/tests/codex_fixture_parity.rs — compare the two message shapes and assert the committed event fixture now provides the first prompt/title.
- crates/freshell-sessions/src/directory_index.rs — assert CodexSource carries the parsed prompt into IndexedSession, the value consumed by the server naming sweep.

- test/e2e-browser/helpers/unified-agent-names.ts — add a synthetic OneCLI-compatible HTTP proxy fixture with safe request observations.
- test/e2e-browser/helpers/unified-agent-names-modes.ts — drive the owned fresh Codex server through the proxy fixture and close it with the journey.
- test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts — prove a browser-created session receives one shared saved name through the OneCLI route while a synthetic direct fallback key is configured.

## Task 1: Repair OpenCode Readiness and Clear the Base-Suite Blocker

**Files:**
- Modify: test/e2e-browser/helpers/opencode-native-history.ts
- Modify: test/unit/tooling/testing/opencode-native-history.test.ts
- Modify: test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts

**Interfaces:**
- Consumes: openCodeTerminalReady(rawOutput: string): boolean and the current GPT-5.6 Luna model banner in the qualification spec.
- Produces: hasOpenCodePromptModelText(renderedText: string, expectedVisibleModel: string): boolean and openCodeTerminalReady(rawOutput: string, expectedVisibleModel: string): boolean. The browser qualification uses the same model-text predicate as source output, plus the browser's bracketedPasteMode value.

- [ ] **Step 1: Add the current-model behavioral case while preserving the existing failing negative**

Add this case to the existing readiness describe block. Keep the current free-tier banner negative, last-mode-wins cases, and ANSI-colored valid prompt case unchanged.

~~~ts
it('accepts the current configured model prompt and rejects the generic banner', () => {
  expect(openCodeTerminalReady('\x1b[?2004h\x1b[24;1HBuild  GPT-5.6 Luna  OpenCode Zen', 'GPT-5.6 Luna')).toBe(true)
  expect(openCodeTerminalReady('\x1b[?2004hBuild Expensive model', 'GPT-5.6 Luna')).toBe(false)
})
~~~

- [ ] **Step 2: Run the focused Cloud Vitest test and confirm the intended failure**

Run: FRESHELL_VITEST_BACKEND=cloud pnpm run test:vitest run test/unit/tooling/testing/opencode-native-history.test.ts --config config/vitest/vitest.config.ts

Expected: FAIL at the existing free-tier-banner assertion because the helper accepts any rendered Build text. The positive GPT-5.6 Luna case must pass; setup, config loading, and unrelated tests must not be the reason for failure.

- [ ] **Step 3: Require the configured visible model in the helper and browser gate**

In opencode-native-history.ts, add hasOpenCodePromptModelText. It returns false for an empty expected model, locates that exact expected model in rendered text, and returns true only when Build occurs within the preceding 160 characters. Update openCodeTerminalReady to take the expected model, require that the final bracketed-paste mode is h, strip VT controls, then call the shared predicate.

Update every unit test call to supply its expected model: Big Pickle for the historical fixture and GPT-5.6 Luna for the current configured model. Preserve the negative free-tier banner, the disabled-input and no-input-mode cases, last-mode-wins behavior, and ANSI stripping.

In runtime-opencode-provider-qualification-rust.spec.ts, pass GPT-5.6 Luna to source readiness. Keep browserModelBanner as a diagnostic derived from hasOpenCodePromptModelText(rendered.text, 'GPT-5.6 Luna'), and do not accept replacement readiness unless that predicate and rendered.modes?.bracketedPasteMode are both true. Do not make the source helper or browser gate accept Build alone.

- [ ] **Step 4: Re-run the focused test and the affected browser qualification**

Run: FRESHELL_VITEST_BACKEND=cloud pnpm run test:vitest run test/unit/tooling/testing/opencode-native-history.test.ts --config config/vitest/vitest.config.ts

Expected: PASS, including the generic free-tier banner negative, ANSI-colored valid prompt, current GPT-5.6 Luna prompt, and existing mode boundaries.

Run: pnpm run test:e2e:chromium test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts

Expected: PASS locally against the Docker-backed qualification, with both source and rendered browser readiness requiring GPT-5.6 Luna and bracketed paste enabled. This spec is local-only in the Cloud E2E config.

- [ ] **Step 5: Refactor while green**

Keep the text predicate in one helper so source and browser readiness cannot drift. Do not retain a duplicate Build/model condition in the spec. No other refactor is needed.

- [ ] **Step 6: Run impacted tests and establish the required green checkpoint before continuing**

Run: FRESHELL_VITEST_BACKEND=cloud GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY='OpenCode readiness repair green checkpoint before naming and parser work' pnpm run test

Expected: PASS for the coordinated full repo suite. This is the required green checkpoint after the known base blocker is repaired and before any OneCLI or Codex implementation begins.

If this gate finds another failure, do not start Tasks 2–4. For each observed failure, add a focused behavior regression test, make the smallest in-scope fix, run that focused test and its impacted tests, commit that repair separately, then rerun this full gate. Continue only after the complete suite is green; the user's request explicitly includes additional failures found while establishing green.

- [ ] **Step 7: Commit the complete OpenCode repair**

~~~bash
git add test/e2e-browser/helpers/opencode-native-history.ts test/unit/tooling/testing/opencode-native-history.test.ts test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts
git commit -m "fix: require the configured OpenCode model for readiness"
~~~

## Task 2: Route Automatic Naming Through Configured OneCLI First

**Files:**
- Modify: crates/freshell-server/src/ai_title.rs
- Modify: crates/freshell-server/src/main.rs
- Modify: crates/freshell-server/src/session_name_generation.rs
- Modify: crates/freshell-server/src/auto_title_sweep.rs
- Modify: crates/freshell-server/src/sessions.rs
- Modify: crates/freshell-server/src/session_name_generation_tests.rs

**Interfaces:**
- Consumes: AiKeyCell with its current environment-over-settings boot precedence and force-applied non-empty settings writes; GeminiTransport; the current worker, title-sweep, and generate-title call paths.
- Produces:
  - GeminiCredentialRoute::{Direct, OneCliProxy}, deriving Clone, Copy, Debug, Eq, and PartialEq.
  - GeminiSessionNameAuth::from_environment(direct_key: AiKeyCell, gemini_base_url: &str) -> Self, plus enabled() -> bool and direct_key() -> Option<String>. enabled() is true when an applicable OneCLI proxy route exists or a non-empty direct key exists; direct_key() returns None for an empty key.
  - GeminiSessionNameAuth::route_for(gemini_base_url: &str, scheme_proxy: Option<&str>, no_proxy: Option<&str>) -> GeminiCredentialRoute, so scheme selection and NO_PROXY matching can be tested without changing process environment.
  - GeminiSessionNameHttp::new(client: reqwest::Client, auth: GeminiSessionNameAuth, base_url: String), implementing GeminiTransport.
  - OneCLI route mode is true only when the scheme-relevant HTTP proxy setting contains the OneCLI aoc_ marker and NO_PROXY/no_proxy does not bypass the Gemini hostname. Match the Gemini hostname exactly or by a comma-separated NO_PROXY domain suffix, including the tested `.googleapis.com` suffix. The direct key remains available for Task 3's explicit missing-credential retry.

- [ ] **Step 1: Add red transport and direct-fallback tests**

Add this route-selection unit case in ai_title.rs. It must use literal inputs and must not mutate process environment.

~~~rust
#[test]
fn onecli_route_detection_requires_scheme_marker_and_honors_no_proxy() {
    let gemini = "https://generativelanguage.googleapis.com/v1beta";
    assert_eq!(
        GeminiSessionNameAuth::route_for(
            gemini,
            Some("http://aoc_fixture@127.0.0.1:10255"),
            None,
        ),
        GeminiCredentialRoute::OneCliProxy,
    );
    assert_eq!(
        GeminiSessionNameAuth::route_for(gemini, Some("http://proxy.example:8080"), None),
        GeminiCredentialRoute::Direct,
    );
    assert_eq!(
        GeminiSessionNameAuth::route_for(
            gemini,
            Some("http://aoc_fixture@127.0.0.1:10255"),
            Some("generativelanguage.googleapis.com"),
        ),
        GeminiCredentialRoute::Direct,
    );
    assert_eq!(
        GeminiSessionNameAuth::route_for(
            gemini,
            Some("http://aoc_fixture@127.0.0.1:10255"),
            Some(".googleapis.com"),
        ),
        GeminiCredentialRoute::Direct,
    );
}
~~~

Add `#[tokio::test] async fn direct_session_name_route_uses_existing_key_when_onecli_proxy_is_absent()` in ai_title.rs. Use a loopback Gemini responder, a `GeminiSessionNameAuth` with no applicable proxy and a synthetic `AiKeyCell` direct key, and a reqwest client with `.no_proxy()` so ambient proxy variables cannot affect the test. Call `generate_content` and assert the selected route is Direct, the responder receives exactly one request with the synthetic x-goog-api-key, and the generated title is returned.

Add `#[tokio::test] async fn session_name_onecli_route_omits_direct_key()` in ai_title.rs. Use a loopback Gemini responder, a `GeminiSessionNameAuth` with the OneCLI route selected and a synthetic direct key available, and a reqwest client with `.no_proxy()`. Call `generate_content` and assert one request, no x-goog-api-key, and the returned generated title. The proxy-route choice itself is covered by the literal route-selection test above; this test isolates the transport's header behavior.

- [ ] **Step 2: Run the route tests and confirm the OneCLI path is missing**

Run: cargo test -p freshell-server onecli_route_detection_requires_scheme_marker_and_honors_no_proxy

Expected: FAIL because the production `GeminiSessionNameAuth` route interface is missing; compilation points only to the absent route implementation referenced by the test. It must not fail from malformed test syntax, an unavailable dependency, or an existing test regression.

- [ ] **Step 3: Add the session-name-specific route, capability, and transport**

In ai_title.rs, keep GeminiHttp and its direct-key behavior unchanged for terminal summaries and other non-naming consumers. Add GeminiCredentialRoute, GeminiSessionNameAuth, and GeminiSessionNameHttp with the interfaces above. Resolve the proxy for the scheme of gemini_base_url: HTTPS_PROXY/https_proxy for the production HTTPS Gemini URL, and HTTP_PROXY/http_proxy for the explicit HTTP e2e seam. Require the OneCLI aoc_ marker. If NO_PROXY/no_proxy matches generativelanguage.googleapis.com, select Direct because reqwest will bypass the gateway. Do not include proxy URL or proxy authorization in any logs.

In GeminiSessionNameHttp::generate_content, preserve the current generateContent URL, JSON body, content type, candidate parsing, thought-part filtering, and output behavior. With route Direct, preserve the current AiKeyCell header behavior. With route OneCliProxy, send the request to the Gemini API hostname without x-goog-api-key. Do not change the autoGenerateTitles toggle or direct key precedence.

In main.rs, build the existing generic GeminiHttp for current summary behavior and a separate GeminiSessionNameHttp plus cloned GeminiSessionNameAuth for session naming. Wire the latter to SessionNameGenerator, AutoTitleSweepState, and SessionsState's generate-title endpoint. Replace the direct-key capability checks in session_name_generation.rs and auto_title_sweep.rs with auth.enabled(), retaining the existing settings toggle check in the worker and title sweep. Do not change aiEnabled's meaning for the generic terminal-summary API. Existing coding-agent naming still posts to generate-title when its local fallback is applied, so the server can replace that provisional value with the OneCLI-generated title.

- [ ] **Step 4: Run the focused Rust transport tests**

Run: cargo test -p freshell-server onecli_route_detection_requires_scheme_marker_and_honors_no_proxy

Expected: PASS for route selection with and without the OneCLI marker and with NO_PROXY matching the Gemini hostname or its Google API domain suffix.

Run: cargo test -p freshell-server direct_session_name_route_uses_existing_key_when_onecli_proxy_is_absent

Expected: PASS with one direct request carrying the existing direct key and a generated title.

Run: cargo test -p freshell-server session_name_onecli_route_omits_direct_key

Expected: PASS with one OneCLI-routed naming request and no x-goog-api-key despite an available synthetic direct key.

- [ ] **Step 5: Refactor while green**

Share request-body construction and candidate parsing between GeminiHttp and GeminiSessionNameHttp so the two transports cannot drift. Keep auth selection name-specific; do not route terminal summaries through the new proxy policy. Keep route detection and the safe response observations covered by focused tests.

- [ ] **Step 6: Run impacted-test verification**

Run: cargo test -p freshell-server

Expected: PASS for all Rust server tests, including automatic naming, manual title generation, summary endpoints, and existing direct-key behavior.

- [ ] **Step 7: Commit the complete OneCLI-first route**

~~~bash
git add crates/freshell-server/src/ai_title.rs crates/freshell-server/src/main.rs crates/freshell-server/src/session_name_generation.rs crates/freshell-server/src/auto_title_sweep.rs crates/freshell-server/src/sessions.rs crates/freshell-server/src/session_name_generation_tests.rs
git commit -m "feat: route automatic session naming through OneCLI"
~~~

## Task 3: Fall Back Only on OneCLI's Explicit Missing-Credential Responses

**Files:**
- Modify: crates/freshell-server/src/ai_title.rs
- Modify: crates/freshell-server/src/session_name_generation_tests.rs

**Interfaces:**
- Consumes: GeminiSessionNameAuth, GeminiSessionNameHttp, and GeminiCredentialRoute from Task 2.
- Produces: a private OneCLI response classifier that recognizes only non-success JSON objects whose error field is exactly credential_not_found or app_not_connected; all other responses remain errors with no direct-key retry.

- [ ] **Step 1: Add the red response and worker tests**

In ai_title.rs tests, add a loopback handler that records the optional x-goog-api-key for each generateContent request. Add `#[tokio::test] async fn onecli_missing_credential_retries_with_direct_key()` and make its first response `{"error":"credential_not_found"}` with a non-success status, then make a request with the direct key return a Gemini candidates response; assert headers `[None, Some("direct-fallback-sentinel")]` and the returned generated title. Repeat the case with `{"error":"app_not_connected"}` in `onecli_missing_app_retries_with_direct_key()`.

Use the same handler in `onecli_missing_credential_does_not_retry_other_failures()` for JSON errors `access_restricted` and `approval_required`, unstructured 401 and 403 bodies, malformed JSON, and 407; each case must return an error after exactly one request with no direct key. In `onecli_missing_credential_without_direct_key_does_not_retry()`, return `{"error":"credential_not_found"}` and assert one request and an error. Assert only statuses, request counts, and presence/absence of the synthetic key; never include the key or response body in assertion messages.

Add `#[tokio::test] async fn onecli_missing_credential_worker_fallback_saves_ai_name()` in session_name_generation_tests.rs. It uses GeminiSessionNameHttp, arms a pending session with a first-message prompt, runs the real SessionNameWorker, receives `{"error":"credential_not_found"}` on its initial proxy request, then receives the synthetic direct-key retry and saves the generated title as NameSource::FreshellAi.

- [ ] **Step 2: Run the focused tests and confirm the missing fallback behavior**

Run: cargo test -p freshell-server onecli_missing_

Expected: FAIL because the new transport from Task 2 returns the OneCLI error without retrying with the configured direct key. Policy-denial and no-key assertions may already pass; the credential_not_found/app_not_connected cases must fail because the successful direct retry is absent.

- [ ] **Step 3: Retry once only for explicit OneCLI missing-credential responses**

In ai_title.rs, inspect a non-success response body as JSON without logging or returning the body. Return a fallback classification only for error == "credential_not_found" or error == "app_not_connected", and only when the selected route is OneCliProxy. If the direct key cell contains a non-empty key, retry the identical Gemini request once with x-goog-api-key set to that key; otherwise return the original non-success error. Do not retry a successful response, an unparseable response, a provider/network/TLS error, or any other OneCLI response, including access_restricted and approval or policy failures. A generic HTTP status is not sufficient to permit fallback.

Emit one structured debug event for the allowed fallback with operation and classification fields only. Do not log the request URL, prompt, key, proxy configuration, proxy authorization, or response body.

- [ ] **Step 4: Run the focused tests and confirm the fallback boundary**

Run: cargo test -p freshell-server onecli_missing_

Expected: PASS for credential_not_found and app_not_connected with one keyless proxy request followed by one direct-key retry; PASS for every listed policy/network/generic-response case with no retry; PASS for a missing direct key with no retry.

- [ ] **Step 5: Refactor while green**

Keep the response classification in one private function and preserve the existing Gemini response parser for both the first and fallback requests. Make the retry visibly single-shot; do not add retry loops or widen the two explicit error codes.

- [ ] **Step 6: Run impacted-test verification**

Run: cargo test -p freshell-server

Expected: PASS for the full server crate, including the real worker fallback integration and unaffected direct-key/summary routes.

- [ ] **Step 7: Commit the fallback policy**

~~~bash
git add crates/freshell-server/src/ai_title.rs crates/freshell-server/src/session_name_generation_tests.rs
git commit -m "fix: limit Gemini key fallback to unconnected OneCLI routes"
~~~

## Task 4: Parse Codex event_msg User Messages for Naming

**Files:**
- Modify: crates/freshell-sessions/src/parse/codex.rs
- Modify: crates/freshell-sessions/tests/codex_fixture_parity.rs
- Modify: crates/freshell-sessions/src/directory_index.rs
- Modify: test/e2e-browser/helpers/unified-agent-names.ts
- Modify: test/e2e-browser/helpers/unified-agent-names-modes.ts
- Modify: test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts

**Interfaces:**
- Consumes: parse_codex_session_content(&str) -> ParsedSessionMeta, extract_user_authored_text(&str), normalize_first_user_message(&str), extract_title_from_message(&str, usize), and CodexSource::scan() -> Vec<IndexedSession>.
- Produces: ParsedSessionMeta.first_user_message and title populated from the first valid event_msg/user_message message exactly as they are from response_item user messages. The CodexSource index projection carries that first prompt unchanged into IndexedSession.first_user_message.

- [ ] **Step 1: Add failing fixture-parity and index assertions**

In task_events_stream_matches_reference, set the expected first_user_message and title to Sanitized prompt. Add this behavioral equivalence test:

~~~rust
#[test]
fn event_user_message_matches_response_item_for_naming_input() {
    let event_msg = r#"{"type":"event_msg","payload":{"type":"user_message","message":"  \nRepair the sardine factory\nwith safe retries  "}}"#;
    let response_item = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"  \nRepair the sardine factory\nwith safe retries  "}]}}"#;

    let event = parse_codex_session_content(event_msg);
    let response = parse_codex_session_content(response_item);

    assert_eq!(
        event.first_user_message.as_deref(),
        Some("Repair the sardine factory\nwith safe retries")
    );
    assert_eq!(event.first_user_message, response.first_user_message);
    assert_eq!(event.title, response.title);
    assert_eq!(event.title.as_deref(), Some("Repair the sardine factory"));
}
~~~

In directory_index.rs, extend codex_source_scans_fixture_and_uses_parsed_session_id with:

~~~rust
assert_eq!(
    items[0].first_user_message.as_deref(),
    Some("Sanitized prompt")
);
~~~

Add startFakeOneCliGeminiProxy(replyText) to unified-agent-names.ts. It starts a loopback HTTP proxy, returns a deterministic Gemini candidates response, and records only destination hostname, path, whether x-goog-api-key was present, and whether the posted prompt contains the expected first message. It must not store or print proxy authorization, the full proxy URL, the request body, or any key value. Extend bootJourney's options to accept this fixture and a synthetic direct key; set FRESHELL_GEMINI_BASE_URL to http://generativelanguage.googleapis.com/v1beta, HTTP_PROXY and http_proxy to the fixture URL containing an aoc_ test marker, NO_PROXY and no_proxy to empty, and GOOGLE_GENERATIVE_AI_API_KEY to a sentinel string.

Add activityGeneratesOneSharedShortNameViaOneCliProxy(mode, browser) to unified-agent-names-modes.ts. It boots a fresh Codex journey through the fixture, creates the pane through the browser, sends “Repair the sardine factory line”, waits for the shared saved title, then asserts exactly one request reached generativelanguage.googleapis.com at /v1beta/models/gemini-3.5-flash-lite:generateContent, the expected prompt was present, and x-goog-api-key was absent. Add this spec to unified-agent-names-freshcodex.spec.ts:

~~~ts
test('activity uses the OneCLI route before the direct fallback key', async ({ browser }) => {
  await activityGeneratesOneSharedShortNameViaOneCliProxy('freshcodex', browser)
})
~~~

- [ ] **Step 2: Run the focused Cargo tests and confirm the intended failure**

Run: cargo test -p freshell-sessions --test codex_fixture_parity

Expected: FAIL because the event_msg message text is currently discarded, so the fixture equality and event/response equivalence assertions lack first_user_message and title.

Run: cargo test -p freshell-sessions codex_source_scans_fixture_and_uses_parsed_session_id

Expected: FAIL because the real Codex source/index projection currently has no first_user_message to carry.

Run: FRESHELL_E2E_BACKEND=cloud GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium --grep='OneCLI route' test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts

Expected: FAIL because the real Codex event_msg prompt is still discarded and naming receives no initiating prompt; the parser unit test above independently confirms that cause. The owned server must launch and the Cloud receipt must show the OneCLI route case selected.

- [ ] **Step 3: Parse both Codex user-message record shapes through the shared normalizer**

In codex.rs, replace the response_item-only text extraction branch with one branch that selects text from either (a) response_item with payload.type message and payload.role user, using the existing extract_text_content(payload.content), or (b) event_msg with payload.type user_message, using payload.message only when it is a string. Feed either selected text through extract_user_authored_text once. Preserve the existing first-valid-prompt behavior: set first_user_message only when it is None and normalization succeeds, set title only when it is None using the same sanitized text and the existing 200-character title limit, and continue parsing assistant messages, task events, timestamps, and token usage exactly as before. Do not change title_source or provider-generated semantics.

- [ ] **Step 4: Re-run the focused Cargo tests**

Run: cargo test -p freshell-sessions --test codex_fixture_parity

Expected: PASS with event and response-item forms producing identical normalized first_user_message and first-line title, and the committed sanitized task-events fixture matching the updated reference value.

Run: cargo test -p freshell-sessions codex_source_scans_fixture_and_uses_parsed_session_id

Expected: PASS with IndexedSession.first_user_message equal to Sanitized prompt.

Run: FRESHELL_E2E_BACKEND=cloud GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium --grep='OneCLI route' test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts

Expected: PASS with the proxy request evidence and the same saved name visible in the pane, tab, sidebar, and canonical session-name record. The Cloud receipt must show the test was selected.

- [ ] **Step 5: Refactor while green**

Keep the two JSON record shapes as inputs to the existing shared extraction, normalization, and title helpers. Do not duplicate text cleanup or alter semantic-event timestamp accounting.

- [ ] **Step 6: Run impacted-test verification**

Run: cargo test -p freshell-sessions

Expected: PASS for the complete sessions crate, including Codex parsing, indexing, malformed input, fixture parity, and all other provider parser tests.

Run: cargo test -p freshell-server

Expected: PASS for server consumers of IndexedSession and automatic naming.

Run: FRESHELL_E2E_BACKEND=cloud GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts

Expected: PASS for the full affected fresh-Codex naming spec; inspect pnpm run test:status before dispatch and wait if the shared gate is occupied.

- [ ] **Step 7: Commit the complete parser change**

~~~bash
git add crates/freshell-sessions/src/parse/codex.rs crates/freshell-sessions/tests/codex_fixture_parity.rs crates/freshell-sessions/src/directory_index.rs test/e2e-browser/helpers/unified-agent-names.ts test/e2e-browser/helpers/unified-agent-names-modes.ts test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts
git commit -m "fix: parse Codex event messages and cover OneCLI naming route"
~~~

## Final Gate After All Tasks

- [ ] Inspect pnpm run test:status and wait if another coordinator holds the suite gate.
- [ ] Run the complete coordinated suite after all code changes:

Run: FRESHELL_VITEST_BACKEND=cloud GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY='OneCLI session naming final full-suite gate' pnpm run test

Expected: PASS. Vitest must use Cloud Run; Rust and Electron lanes follow the repo's coordinated workflow.

- [ ] Run the complete affected Cloud browser spec after all code changes:

Run: FRESHELL_E2E_BACKEND=cloud GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts

Expected: PASS with a selected OneCLI route case, no direct key on the configured route, the same saved name visible through browser surfaces, and all existing fresh Codex name journeys green.

- [ ] Re-run the affected local-only OpenCode qualification after all code changes:

Run: pnpm run test:e2e:chromium test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts

Expected: PASS; the browser qualification is excluded from Cloud E2E because its Docker supervisor is local-only.

- [ ] Review pnpm run test:status and the final command receipts; record the complete suite and browser outcomes before reporting success.

## Self-Review Checklist

- The complete dispatcher-authored User Request block is copied unchanged once above; all six active obligations are assigned to tasks or gates: OneCLI-first auth, existing-key fallback when route is absent or explicitly unconnected, no fallback on other authorization/policy failures, both Codex user-message record shapes, OpenCode readiness repair, and a green suite before naming/parser work plus a final complete gate.
- The OneCLI transport is session-name-specific; terminal summary callers keep the existing direct transport. The new e2e proxy uses only synthetic credentials and local traffic. The exact OneCLI missing response codes are durably recorded in run-state before the plan commit.
- The OpenCode unit and browser contracts share one visible model predicate, preserve final bracketed-paste mode, ANSI output, and free-tier rejection, and the full Cloud Vitest checkpoint blocks later tasks.
- Codex parsing uses the existing text cleaning and title helpers; fixture parity and CodexSource scanning prove the prompt reaches IndexedSession, the value already consumed by the naming sweep.
- The two allowed OneCLI errors are exact JSON error-field matches. access_restricted, approval_required, generic status failures, transport/TLS failures, malformed response bodies, and a missing direct key have no key retry. No proxy route selects the existing direct-key source and precedence.
- The plan adds no dependency, changes no data format or migration, and adds no end-user setting. Structured fallback logging omits credentials, prompt, proxy URL, and response body.
- All modified paths and signatures are listed in the file map and tasks. Focused test commands use Cargo or the repo-owned Vitest/Playwright scripts. The OpenCode browser spec's local-only classification and the Cloud backend choices are explicit.
- No prohibited placeholders or uncovered requirements remain. All code-changing tasks use failing behavior tests before production changes, focused verification, impacted-test coverage, and a task commit. The required final full-suite gate follows every task.

## Commit and Handoff

Commit only this plan file with:

~~~bash
git add docs/plans/2026-09-30-onecli-session-naming.md
git commit -m "docs: add implementation plan for onecli session naming"
~~~

After verifying the commit contains only this plan, update the external run-state record with the absolute plan path, feature name, commit SHA, self-review result, Stage 1 completion time, and Stage 2 as current with next action “validate load-bearing assumptions”.
