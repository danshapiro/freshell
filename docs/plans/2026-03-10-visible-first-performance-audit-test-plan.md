# Visible-First Performance Audit Test Plan

Date: 2026-03-10
Source plan: `/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/docs/plans/2026-03-10-visible-first-performance-audit.md`

## Strategy changes requiring user approval
No approval required.

## Strategy reconciliation

The accepted strategy still holds after reading the implementation plan and current codebase.

Adjustments that do not change user-approved scope:

1. Most audit verification should live in `test/unit/**` as pure Node or jsdom tests because the root `vitest.config.ts` excludes `test/e2e-browser/**`, while only reduced-run smoke coverage belongs under `test/e2e-browser/perf/**`. This matches the implementation plan and keeps the audit logic TDD-friendly.
2. The interaction and output-capture harnesses must treat Chromium CDP as the transport authority and the server debug JSONL file from `TestServerInfo.debugLogPath` as the server authority. Browser console forwarding to `/api/logs/client` is explicitly not a valid audit path.
3. Browser-persisted layout seeds and HOME fixture seeds must be tested separately because the plan and current codebase split them across `localStorage` (`freshell.tabs.v2`, `freshell.panes.v2`) and the temp HOME directory created by `TestServer`.

Named sources of truth used below:

- `USR`: the user request in the trycycle transcript for a comprehensive, repeatable audit that outputs one machine-readable file.
- `STRAT`: the accepted audit strategy in the transcript, including six scenarios and exactly two measured profiles: `desktop_local` and `mobile_restricted`.
- `PLAN`: the implementation plan sections `Goal`, `Architecture`, `Strategy Gate`, and `Codebase Findings`.
- `MATRIX`: the implementation plan sections `Fixed Audit Matrix`, `Scenario Definitions`, and `Transport Normalization Rules`.
- `CONTRACT`: the implementation plan sections `Artifact Contract` and `Failure Policy`.
- `CODE`: current repo interfaces that the plan explicitly builds on: `test/e2e-browser/helpers/test-server.ts`, `src/lib/test-harness.ts`, `src/lib/perf-logger.ts`, `server/request-logger.ts`, `server/perf-logger.ts`, `server/logger.ts`, `src/store/persistedState.ts`, and `src/lib/pwa.ts`.

## Harness requirements

1. `Direct API harness`
   What it does: runs pure Node and jsdom tests for matrix definitions, schema validation, route normalization, aggregation, comparison, CLI arg parsing, browser-storage seeds, HOME seeds, network capture reduction, and server-log parsing.
   Exposes: direct imports of the audit modules, fixture builders, temp filesystem helpers, and schema parsing.
   Estimated complexity: medium.
   Tests that depend on it: 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26.

2. `Programmatic state harness`
   What it does: extends `window.__FRESHELL_TEST_HARNESS__` and the in-memory perf audit bridge so tests can read browser milestones, perf events, WS readiness, and terminal buffers without screenshots.
   Exposes: `getPerfAuditSnapshot()`, Redux state, WS state, terminal buffer reads, and focus/selection state.
   Estimated complexity: medium.
   Tests that depend on it: 2, 3, 4, 5, 6, 7, 11, 12, 18.

3. `Interaction harness`
   What it does: runs production-built Chromium samples through `TestServer`, Playwright, fresh browser contexts, browser-storage seeding, scenario interactions, and focused-ready waits.
   Exposes: per-sample navigation, input simulation, tab selection, sidebar search, reconnect control, and fresh server/browser lifecycle.
   Estimated complexity: high.
   Tests that depend on it: 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 21.

4. `Output capture harness`
   What it does: captures authoritative browser, transport, and server telemetry for one sample, then merges it into the schema-shaped artifact.
   Exposes: CDP HTTP and WebSocket observations, parsed debug JSONL logs, browser milestone snapshots, derived visible-first metrics, and artifact writing.
   Estimated complexity: high.
   Tests that depend on it: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 16, 17, 18, 19, 20, 21.

5. `Reference comparison harness`
   What it does: loads two validated artifacts and computes a machine-readable diff by scenario and profile.
   Exposes: compare helper, compare CLI, zero-delta and changed-delta fixtures.
   Estimated complexity: low.
   Tests that depend on it: 10, 14.

The harnesses above are the first TDD task. Without them, the highest-value scenario tests cannot be written before implementation.

## Test plan

### Scenario tests

1. **Name**: Running `npm run perf:audit:visible-first` writes one schema-valid baseline artifact at the default path
   **Type**: scenario
   **Harness**: Interaction harness + Output capture harness
   **Preconditions**: Production build is available or buildable; deterministic HOME seed and scenario/profile matrix are available; `artifacts/perf/` is writable.
   **Actions**: Run `npm run perf:audit:visible-first` with no flags from the repo root.
   **Expected outcome**: The command writes `artifacts/perf/visible-first-audit.json`; the file parses with the audit schema; it contains `schemaVersion: 1`, stable profile IDs, six scenario IDs in plan order, and exactly two samples per scenario in `desktop_local`, `mobile_restricted` order; no manual setup step is required before the command. Sources: `USR`, `STRAT`, `PLAN`, `MATRIX`, `CONTRACT`.
   **Interactions**: `package.json` script wiring, build step, serial audit runner, artifact writer, schema validation.

2. **Name**: The auth-required cold boot sample records the auth gate as the focused-ready surface and counts no protected pre-ready work
   **Type**: scenario
   **Harness**: Interaction harness + Programmatic state harness + Output capture harness
   **Preconditions**: Scenario ID is `auth-required-cold-boot`; no token is supplied; browser context is cold.
   **Actions**: Run the sample for both accepted profiles and wait for the sample to reach focused-ready or fail.
   **Expected outcome**: The browser snapshot contains `app.auth_required_visible`; the sample’s `focusedReadyMilestone` is that ID; pre-ready normalized HTTP work is limited to `/api/settings`; pre-ready WebSocket work is empty; offscreen HTTP and WS counts before ready are zero. Sources: `STRAT`, `MATRIX`, `CONTRACT`.
   **Interactions**: `App.tsx` auth bootstrap, browser milestone bridge, CDP transport capture, derived-metrics reducer.

3. **Name**: The terminal cold boot sample records first visible terminal output and the allowed startup transport only
   **Type**: scenario
   **Harness**: Interaction harness + Programmatic state harness + Output capture harness
   **Preconditions**: Scenario ID is `terminal-cold-boot`; terminal pane is the active persisted surface; browser context and server HOME are cold.
   **Actions**: Run the sample for both accepted profiles.
   **Expected outcome**: The browser snapshot contains `terminal.first_output`; pre-ready normalized HTTP routes are limited to `/api/settings` and `/api/terminals`; pre-ready WebSocket frame types are limited to the scenario allowlist; the artifact contains browser, transport, server, and derived subtrees for the sample. Sources: `STRAT`, `MATRIX`, `CONTRACT`, `CODE`.
   **Interactions**: `App.tsx`, `TerminalView.tsx`, `ws-client.ts`, CDP capture, server log parsing.

4. **Name**: The agent-chat cold boot sample records visible chat readiness from browser state rather than transport guesses
   **Type**: scenario
   **Harness**: Interaction harness + Programmatic state harness + Output capture harness
   **Preconditions**: Scenario ID is `agent-chat-cold-boot`; browser storage is seeded to the long-history session; browser context is cold.
   **Actions**: Run the sample for both accepted profiles and wait for the browser milestone.
   **Expected outcome**: The browser snapshot contains `agent_chat.surface_visible`; the sample uses the seeded agent-chat layout, not HOME state, to pick the visible pane; pre-ready normalized HTTP routes are limited to `/api/settings`, `/api/sessions`, and `/api/sessions/:sessionId`; pre-ready WS types are limited to the scenario allowlist. Sources: `STRAT`, `PLAN`, `MATRIX`, `CODE`.
   **Interactions**: browser-storage seed helper, `AgentChatView.tsx`, Redux state persistence, CDP capture.

5. **Name**: The sidebar search sample records search-result visibility for the active query against the large seeded corpus
   **Type**: scenario
   **Harness**: Interaction harness + Programmatic state harness + Output capture harness
   **Preconditions**: Scenario ID is `sidebar-search-large-corpus`; HOME contains the deterministic 12-project, 180-session corpus with 36 `alpha` matches; the app starts on a lightweight terminal tab with the sidebar hidden.
   **Actions**: Run the sample, open the sidebar, type `alpha`, and wait for the readiness milestone.
   **Expected outcome**: The browser snapshot contains `sidebar.search_results_visible`; the active query is non-empty; transport capture shows `/api/sessions/search` before ready and does not classify `/api/health` or `/api/logs/client`; the resulting sample is tied to the large seeded corpus, not toy data. Sources: `STRAT`, `PLAN`, `MATRIX`, `CODE`.
   **Interactions**: HOME seeding, `Sidebar.tsx`, session search route, route normalization, CDP capture.

6. **Name**: The terminal reconnect sample records viewport-first recovery and short-tail replay against the backlog script
   **Type**: scenario
   **Harness**: Interaction harness + Programmatic state harness + Output capture harness
   **Preconditions**: Scenario ID is `terminal-reconnect-backlog`; the deterministic backlog script exists in the seeded HOME; a real terminal can be created and then forcibly disconnected after backlog is established.
   **Actions**: Run the scenario setup, force disconnect through the test harness, allow reconnect, and wait for focused-ready.
   **Expected outcome**: The browser snapshot contains `terminal.first_output`; pre-ready HTTP routes are limited to `/api/settings` and `/api/terminals`; pre-ready WS types are limited to `hello`, `ready`, `terminal.attach`, `terminal.snapshot`, `terminal.output`, `terminal.list`, `terminal.meta.list`, and `terminal.meta.list.response`; the sample retains transport and server evidence for backlog restore rather than dropping reconnect observations. Sources: `STRAT`, `PLAN`, `MATRIX`, `CONTRACT`, `CODE`.
   **Interactions**: `TestServer`, terminal backlog script, `TerminalView.tsx`, reconnect path in `ws-client.ts`, CDP and server log capture.

7. **Name**: The offscreen-tab-selection sample keeps startup focused on the active tab and measures the heavy tab only after user selection
   **Type**: scenario
   **Harness**: Interaction harness + Programmatic state harness + Output capture harness
   **Preconditions**: Scenario ID is `offscreen-tab-selection`; browser storage seeds one lightweight active tab and one heavy background agent-chat tab; sidebar starts closed.
   **Actions**: Run the sample, wait for initial paint, select the heavy background tab, and wait for `tab.selected_surface_visible`.
   **Expected outcome**: The browser snapshot contains `tab.selected_surface_visible`; pre-ready transport before the tab-selection milestone is limited to `/api/settings` plus `hello` and `ready`; offscreen-before-ready counts are derived mechanically from non-allowlisted observations; no pre-ready `/api/sessions` or `sdk.history` work is classified as allowed. Sources: `STRAT`, `PLAN`, `MATRIX`, `CONTRACT`.
   **Interactions**: browser-storage seed helper, `TabContent.tsx`, `App.tsx`, CDP capture, offscreen-work classifier.

8. **Name**: Running the audit with `--scenario` and `--profile` writes a reduced artifact without changing the contract
   **Type**: scenario
   **Harness**: Interaction harness + Output capture harness
   **Preconditions**: CLI supports `--scenario` and `--profile`; output path is writable.
   **Actions**: Run the main audit CLI with one scenario and one profile, for example `--scenario auth-required-cold-boot --profile desktop_local`.
   **Expected outcome**: The command succeeds; the artifact schema remains valid; the artifact contains only the requested scenario/profile subset and still preserves the same field names and per-sample structure as the full run. Sources: `USR`, `PLAN`, `CONTRACT`.
   **Interactions**: CLI parser, serial runner filtering, artifact writer.

9. **Name**: The reduced smoke run executes under `test:e2e:helpers` and proves the pipeline works without running the full matrix
   **Type**: scenario
   **Harness**: Interaction harness + Output capture harness
   **Preconditions**: `test/e2e-browser/vitest.config.ts` includes perf smoke tests; a temp output directory is writable.
   **Actions**: Run the reduced smoke test for an auth-only desktop sample and write the resulting artifact to a temp directory.
   **Expected outcome**: The smoke test passes under the E2E helper config; the written artifact parses with the shared schema; the reduced run does not require changing the production audit contract. Sources: `PLAN`, `CONTRACT`, `CODE`.
   **Interactions**: E2E helper vitest config, reduced runner path, schema, artifact writer.

### Integration tests

10. **Name**: Comparing two artifacts produces machine-readable zero deltas for identical runs and scoped deltas for changed runs
   **Type**: differential
   **Harness**: Reference comparison harness + Direct API harness
   **Preconditions**: Two validated artifacts are available: one identical pair and one pair with known per-scenario/per-profile differences.
   **Actions**: Run the compare helper and compare CLI against both pairs.
   **Expected outcome**: Identical artifacts produce zero deltas; changed artifacts produce deltas grouped by scenario ID and profile ID; compare output remains JSON only. Sources: `USR`, `PLAN`, `CONTRACT`.
   **Interactions**: comparison helper, compare CLI parser, filesystem reads, schema validation.

11. **Name**: The browser perf audit bridge and test harness expose serializable milestones, perf events, and terminal latency samples to the runner
   **Type**: integration
   **Harness**: Programmatic state harness + Direct API harness
   **Preconditions**: Perf-audit mode is active in the browser; the bridge is installed once per page load.
   **Actions**: Mark browser milestones, emit client perf events, emit terminal latency samples, and read the snapshot through `window.__FRESHELL_TEST_HARNESS__`.
   **Expected outcome**: The snapshot is serializable; it includes milestone timestamps, perf events, and terminal latency samples; existing harness APIs continue to work unchanged. Sources: `PLAN`, `CONTRACT`, `CODE`.
   **Interactions**: `src/lib/perf-audit-bridge.ts`, `src/lib/test-harness.ts`, Playwright helper wrapper, `perf-logger.ts`.

12. **Name**: App and visible surfaces mark only the accepted readiness milestones at the right user-visible moments
   **Type**: integration
   **Harness**: Programmatic state harness + Direct API harness
   **Preconditions**: Perf-audit mode is active; the app can render auth-required, terminal, agent-chat, sidebar-search, and offscreen-tab-selection states in isolation.
   **Actions**: Exercise each visible state transition in component or app tests and inspect the bridge snapshot after render.
   **Expected outcome**: The bridge records `app.bootstrap_started`, `app.settings_loaded`, `app.auth_required_visible`, `terminal.first_output`, `agent_chat.surface_visible`, `sidebar.search_results_visible`, and `tab.selected_surface_visible` only when the plan-defined visible conditions are met; hidden panes do not mark visible readiness. Sources: `PLAN`, `MATRIX`, `CODE`.
   **Interactions**: `App.tsx`, `TerminalView.tsx`, `AgentChatView.tsx`, `Sidebar.tsx`, `TabContent.tsx`, bridge snapshot plumbing.

13. **Name**: The sample runner produces one schema-shaped sample by combining browser, transport, server, and derived data from a cold isolated run
   **Type**: integration
   **Harness**: Interaction harness + Programmatic state harness + Output capture harness
   **Preconditions**: One scenario ID and one profile ID are selected; `TestServer` can preserve HOME and logs for capture; cold browser-context helper is available.
   **Actions**: Run one sample end to end and inspect the returned sample object before any file write.
   **Expected outcome**: The sample includes `profileId`, `status`, `startedAt`, `finishedAt`, `durationMs`, `browser`, `transport`, `server`, `derived`, and `errors`; cleanup happens in `finally`; the sample uses a fresh `TestServer` and fresh browser context. Sources: `PLAN`, `CONTRACT`, `CODE`.
   **Interactions**: sample runner, `TestServer`, Playwright Chromium, CDP session, server-log parser, derived-metrics helper.

14. **Name**: The serial audit runner executes the accepted matrix in stable order and the compare path reads the same contract
   **Type**: integration
   **Harness**: Output capture harness + Reference comparison harness
   **Preconditions**: Matrix definitions and sample runner are available.
   **Actions**: Run the serial audit runner over the accepted matrix, build `summaryByProfile`, validate the artifact, then feed the artifact into the compare path.
   **Expected outcome**: Scenario order is exactly the accepted six-item order; each scenario’s sample order is stable; `summaryByProfile` is derived from the authoritative one-sample-per-profile data without inventing medians; the same contract is accepted by runner, writer, smoke test, and compare tool. Sources: `STRAT`, `PLAN`, `MATRIX`, `CONTRACT`.
   **Interactions**: matrix definitions, serial runner, aggregator, schema, compare helper.

15. **Name**: The network recorder treats Chromium CDP as the transport source of truth and preserves both raw observations and summaries
   **Type**: integration
   **Harness**: Output capture harness + Direct API harness
   **Preconditions**: Fake or recorded CDP request, response, loading-finished, and WebSocket-frame events are available.
   **Actions**: Feed normalized and edge-case CDP events into the recorder and inspect the raw capture plus summarized maps.
   **Expected outcome**: Only `/api/**` requests are counted; `/api/health` and `/api/logs/client` are ignored; bytes come from `encodedDataLength` where available; summarized HTTP data is keyed by normalized route ID and WS data by top-level `type` or `unknown`. Sources: `STRAT`, `PLAN`, `MATRIX`, `CONTRACT`.
   **Interactions**: CDP event reducer, route normalizer, WS-frame classifier, derived-metrics helper.

16. **Name**: The server-log parser reads the exact debug-log path from `TestServerInfo` and separates HTTP requests, perf events, system samples, and diagnostics
   **Type**: integration
   **Harness**: Output capture harness + Direct API harness
   **Preconditions**: `TestServer` exposes `debugLogPath`; a structured JSONL file with valid and malformed lines is available.
   **Actions**: Parse the file line by line and inspect the parser output.
   **Expected outcome**: HTTP request logs, perf events, and `perf_system` samples are preserved separately; malformed lines become parser diagnostics instead of fatal exceptions; the parser does not guess log file locations. Sources: `PLAN`, `CONTRACT`, `CODE`.
   **Interactions**: `TestServer`, `server/logger.ts`, `server/request-logger.ts`, `server/perf-logger.ts`, JSONL parser.

17. **Name**: `TestServer` exposes retained HOME and log paths for audit collection without regressing default cleanup behavior
   **Type**: integration
   **Harness**: Interaction harness + Direct API harness
   **Preconditions**: `TestServer` supports `setupHome` and `preserveHomeOnStop`; temp directories are writable.
   **Actions**: Start a server with HOME setup and retention enabled, inspect returned info, then stop it; repeat with retention disabled.
   **Expected outcome**: `TestServerInfo` includes `homeDir`, `logsDir`, and `debugLogPath`; `setupHome` runs before server start; retained HOME survives only when `preserveHomeOnStop` is true; legacy cleanup remains the default. Sources: `PLAN`, `CODE`.
   **Interactions**: `TestServer`, temp HOME creation, server startup, log directory resolution.

18. **Name**: Perf collection reaches the audit sink without being forwarded through `/api/logs/client`
   **Type**: regression
   **Harness**: Programmatic state harness + Direct API harness
   **Preconditions**: Client perf logging is enabled; remote client logger capture is installed; audit sink is installed.
   **Actions**: Emit browser perf events and terminal latency samples, then inspect both the audit sink and remote-log forwarding path.
   **Expected outcome**: The audit sink receives the perf entries; console behavior is unchanged; `/api/logs/client` filtering of `perf: true` entries remains intact. Sources: `PLAN`, `CODE`.
   **Interactions**: `perf-logger.ts`, `client-logger.ts`, browser audit bridge, remote log batching.

### Invariant tests

19. **Name**: The artifact contract rejects untrustworthy runs and accepts only the required top-level, per-scenario, and per-sample fields
   **Type**: invariant
   **Harness**: Direct API harness
   **Preconditions**: One valid artifact fixture and multiple invalid fixtures are available.
   **Actions**: Parse artifacts that omit `focusedReadyMilestone`, `transport`, `server`, or other required contract fields, and parse one fully valid artifact.
   **Expected outcome**: The valid artifact parses; invalid artifacts fail schema validation; the contract enforces required top-level fields, six-scenario shape, stable sample order, and required sample subtrees. Sources: `CONTRACT`.
   **Interactions**: Zod schema, runner, smoke test, compare helper.

20. **Name**: Cold browser-context rules always block service workers, disable cache, and apply mobile throttling only to `mobile_restricted`
   **Type**: invariant
   **Harness**: Output capture harness + Direct API harness
   **Preconditions**: Profile helper is available for both profile IDs.
   **Actions**: Build context options and apply profile network conditions for both profiles.
   **Expected outcome**: Both profiles block service workers and disable cache; `mobile_restricted` applies Playwright `iPhone 14` emulation plus the fixed download, upload, and latency throttles; `desktop_local` does not apply mobile throttling. Sources: `STRAT`, `PLAN`, `MATRIX`, `CODE`.
   **Interactions**: Playwright context options, Chromium CDP `Network` domain, `src/lib/pwa.ts`.

21. **Name**: Failed scenarios are recorded explicitly and still cause the audit command to fail instead of silently dropping samples
   **Type**: invariant
   **Harness**: Output capture harness + Direct API harness
   **Preconditions**: One scenario is forced to time out or miss its focused-ready milestone.
   **Actions**: Run the sample and runner paths with the induced failure.
   **Expected outcome**: The affected sample records `status` as `timeout` or `error`, preserves `errors`, and does not disappear from the artifact shape; the audit command exits non-zero because the run is untrustworthy. Sources: `STRAT`, `CONTRACT`.
   **Interactions**: sample runner, serial runner, artifact writer, CLI exit handling.

### Boundary and edge-case tests

22. **Name**: Route normalization and WS frame classification ignore non-audit traffic and normalize dynamic IDs consistently
   **Type**: boundary
   **Harness**: Direct API harness
   **Preconditions**: URLs include static routes, dynamic session and terminal routes, ignored routes, non-API routes, query strings, and malformed or non-JSON WS payloads.
   **Actions**: Normalize routes and classify WS frames with the helper functions.
   **Expected outcome**: `/api/sessions/<id>` becomes `/api/sessions/:sessionId`; `/api/terminals/<id>` becomes `/api/terminals/:terminalId`; `/api/health` and `/api/logs/client` are ignored; non-API routes return null; malformed or missing-`type` WS frames are classified as `unknown`. Sources: `MATRIX`, `CONTRACT`.
   **Interactions**: route normalizer, WS classifier, network recorder, derived-metrics helper.

23. **Name**: Derived visible-first metrics count only observations at or before focused-ready and compute offscreen work from scenario allowlists
   **Type**: boundary
   **Harness**: Direct API harness
   **Preconditions**: Authoritative browser milestone timestamps, HTTP observations, and WS observations exist on both sides of the focused-ready boundary.
   **Actions**: Run the derived-metrics helper for samples with mixed allowed and disallowed observations before and after focused-ready.
   **Expected outcome**: Counts and bytes stop at `focusedReadyTimestamp`; only pre-ready observations contribute to `httpRequestsBeforeReady`, `wsFramesBeforeReady`, and offscreen metrics; the authoritative collector output is not mutated. Sources: `MATRIX`, `CONTRACT`.
   **Interactions**: derived-metrics helper, network recorder output, scenario definitions.

### Unit tests

24. **Name**: The accepted profile IDs and scenario IDs stay frozen as contract-level constants
   **Type**: unit
   **Harness**: Direct API harness
   **Preconditions**: Matrix definition modules can be imported in Node tests.
   **Actions**: Read exported profile and scenario arrays.
   **Expected outcome**: Profiles are exactly `desktop_local` and `mobile_restricted`; scenarios are exactly `auth-required-cold-boot`, `terminal-cold-boot`, `agent-chat-cold-boot`, `sidebar-search-large-corpus`, `terminal-reconnect-backlog`, and `offscreen-tab-selection`, in that order. Sources: `STRAT`, `MATRIX`.
   **Interactions**: profile definitions, scenario definitions, schema enums.

25. **Name**: The deterministic HOME seed writes the accepted session corpus, long-history session, and backlog script in real app formats
   **Type**: unit
   **Harness**: Direct API harness
   **Preconditions**: Temp HOME directory is writable; current JSONL session fixtures are available as format references.
   **Actions**: Run the HOME seeding helper and inspect the returned summary plus written files.
   **Expected outcome**: The seed writes 12 projects, 180 session summaries, 36 `alpha` titles, one long-history session with 240 turns, and the backlog script; JSONL files follow the app’s existing session-file shape. Sources: `STRAT`, `PLAN`, `MATRIX`, `CODE`.
   **Interactions**: HOME seed helper, `test/fixtures/sessions/*.jsonl`, filesystem layout under `~/.claude/projects`.

26. **Name**: The browser-storage seed writes only the accepted keys and round-trips through current persisted-state parsers
   **Type**: unit
   **Harness**: Direct API harness
   **Preconditions**: Browser-storage seed helpers and persisted-state parsers are available.
   **Actions**: Build the agent-chat and offscreen-tab storage seeds and parse their `freshell.tabs.v2` and `freshell.panes.v2` payloads with the current parser functions.
   **Expected outcome**: The seed contains only `freshell_version`, `freshell.tabs.v2`, and `freshell.panes.v2`; `freshell_version` is `3`; tabs and panes payloads are accepted by the current parsers without schema drift. Sources: `PLAN`, `MATRIX`, `CODE`.
   **Interactions**: browser-storage seed helper, `src/store/storage-keys.ts`, `src/store/persistedState.ts`.

## Coverage summary

Covered action space:

- Running the main audit command at its default path and with explicit `--scenario`, `--profile`, and compare arguments.
- All six accepted measured scenarios: auth-required bootstrap, terminal cold boot, agent-chat cold boot, sidebar search on the large corpus, terminal reconnect backlog, and offscreen tab selection.
- The full audit data path: deterministic HOME seeding, browser-storage seeding, cold browser contexts, CDP HTTP and WS capture, browser readiness milestones, server JSONL parsing, derived metrics, artifact validation, artifact writing, smoke coverage, and artifact-to-artifact diffing.
- The failure and trust boundaries that matter for this project: missing milestones, missing capture, malformed logs, timeout/error samples, ignored routes, dynamic route normalization, unknown WS frames, service worker isolation, and log-path correctness.

Explicit exclusions from this plan:

- No latency-budget pass/fail assertions beyond catastrophic audit-integrity failures. The accepted strategy is characterization-first, so the test plan verifies completeness and correctness of measurement rather than hard thresholds.
- No multi-browser or multi-device matrix beyond Chromium `desktop_local` and `mobile_restricted`. The accepted strategy explicitly narrowed measurement to those two profiles.
- No screenshots, traces, or visual snapshots as primary assertions. They remain optional debug artifacts, not the product.
- No external or paid infrastructure. The plan relies entirely on local production builds, local temp HOME fixtures, Playwright Chromium, and existing server logging.

Residual risks from those exclusions:

- The audit can prove that capture is correct and repeatable without proving that absolute timings are stable across every workstation or browser engine.
- Visual regressions in the audit UI itself would be caught indirectly through milestone and artifact assertions, not through screenshot diffs.
- Because the audit intentionally avoids threshold-heavy gates, later transport work must use the produced baseline artifact and compare path to decide whether measured changes are acceptable.
