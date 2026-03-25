# Tab Title Source Precedence Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The approved strategy still holds. The implementation plan confirms the same core fix: durable title-source metadata plus an ephemeral runtime-title slice. The only refinement is acceptance scope: persistence, reopen, cross-tab hydration, and client-to-server layout mirroring are no longer optional supporting checks because the implementation plan explicitly changes those contracts. The browser acceptance path also needs one narrow harness addition so Playwright can seed a durable stable title through the shared terminal-id sync path instead of brittle direct reducer writes.

## Sources Of Truth
- `S1 User-visible contract`: The reported regression is that a history/session tab titled `codex resume ...` must not downgrade to generic `codex` after tab switching. The approved strategy makes primary acceptance a real-browser test with a real shell PTY emitting a real OSC title while the tab is backgrounded.
- `S2 Title-source architecture`: The implementation plan requires durable sources `user > stable > derived`, raw xterm titles to live only in an ephemeral runtime slice, separate runtime eligibility for tab labels versus pane headers, and runtime-title clearing on durable update, content replacement, terminal identity change, and exit.
- `S3 Display-surface contract`: Tab bar, mobile strip, tab switcher, pane headers, context-menu rename surfaces, sidebar fallback items, reopened tabs, and hydrated state must resolve the same durable precedence.
- `S4 Durable-write contract`: `terminal.title.updated`, history/session open and rename flows, copied-tab snapshot titles, prompt-derived coding-CLI titles, fixed workflow titles, and explicit titled UI-command flows are the durable paths. Raw `onTitleChange` is not.
- `S5 Mirror/server contract`: Agent layout mirroring and server-side layout mutations must round-trip durable title metadata and never persist or mirror runtime titles. Server session-title promotion and unified rename semantics otherwise stay unchanged.
- `S6 Repo acceptance gate`: Final acceptance must be a fresh coordinated `npm test`. `npm run test:status` currently shows the coordinator idle and the latest full suite green, but stale `test:unit` and `verify` failures remain in history.

## Harness Requirements
1. **Browser durable-title sync helper**
   - **What it does:** Adds one narrow page-side test helper that routes a stable title by `terminalId` through the shared durable terminal-id sync path, so browser specs can seed the same non-user stable title a history/session flow would produce without reconstructing internal reducer details.
   - **What it exposes:** A browser test-harness method such as `syncStableTitleByTerminalId(terminalId, title)` callable from Playwright page context, alongside the existing state, buffer, and websocket helpers.
   - **Estimated complexity to build:** Low; extend `src/lib/test-harness.ts` and `test/e2e-browser/helpers/test-harness.ts`.
   - **Tests that depend on it:** 1, 2.

2. **Existing Playwright real-terminal harness**
   - **What it does:** Boots an isolated Freshell server, opens a real browser, and drives a real shell PTY whose output can emit actual OSC titles.
   - **What it exposes:** Browser navigation, visible tab-label assertions, terminal focus and input helpers, terminal buffer inspection, and direct page-side access to the browser test harness.
   - **Estimated complexity to build:** None beyond the helper above; already present in `test/e2e-browser/helpers/fixtures.ts`, `test/e2e-browser/helpers/test-server.ts`, `test/e2e-browser/helpers/test-harness.ts`, and `test/e2e-browser/helpers/terminal-helpers.ts`.
   - **Tests that depend on it:** 1, 2, 12.

3. **TerminalView lifecycle harness**
   - **What it does:** Renders the real `TerminalView` with mocked xterm and websocket collaborators while letting tests drive hidden and visible transitions, attach state, and captured `onTitleChange` callbacks.
   - **What it exposes:** Controlled tab and pane state, runtime title callbacks, sent-websocket inspection, and rendered DOM assertions around tab and pane visibility.
   - **Estimated complexity to build:** None; extend the existing lifecycle suite.
   - **Tests that depend on it:** 3, 4, 9.

4. **Client title-state and persistence harness**
   - **What it does:** Exercises Redux reducers, selectors, persistence parsers and middleware, reopen snapshots, cross-tab hydration, and RTL-rendered consumers against controlled tab and pane states.
   - **What it exposes:** Direct store dispatch, localStorage payload inspection, render-time title text, and selector results.
   - **Estimated complexity to build:** None; reuse existing unit and integration suites.
   - **Tests that depend on it:** 4, 5, 6, 7, 8, 10.

5. **Layout mirror and server layout-store harness**
   - **What it does:** Verifies the client mirror payload and the server's agent-layout schema and store behavior across rename, attach, split, swap, and remove operations.
   - **What it exposes:** Mirrored layout payloads, parsed schemas, and server-side stored layout snapshots after mutations.
   - **Estimated complexity to build:** None; reuse existing middleware and server unit suites.
   - **Tests that depend on it:** 11, 13.

6. **Pure helper and reducer harness**
   - **What it does:** Calls title-source helpers and the runtime-title slice directly for deterministic precedence, normalization, and cleanup logic.
   - **What it exposes:** Pure function outputs and reducer state transitions only.
   - **Estimated complexity to build:** Low; new Vitest files only.
   - **Tests that depend on it:** 9, 14.

7. **Broad verification harness**
   - **What it does:** Runs the coordinated repo suite after focused checks are green.
   - **What it exposes:** End-to-end repo pass and fail for merge safety.
   - **Estimated complexity to build:** None.
   - **Tests that depend on it:** 15.

## Test Plan
1. **Name:** Backgrounded session-titled tab keeps its visible label after a later generic OSC title.
   - **Type:** regression
   - **Disposition:** new
   - **Harness:** Existing Playwright real-terminal harness plus the browser durable-title sync helper.
   - **Preconditions:** Freshell is open in Playwright, two real shell tabs exist, the target tab has a live terminal and no user rename, and its terminal id is known through the page harness.
   - **Actions:** Create the second tab, seed its durable stable title to `codex resume 019d1213-9c59-7bb0-80ae-70c74427f346` through the terminal-id sync helper, switch to the first tab so the target tab is hidden, emit a real OSC title `codex` plus a sentinel line from the target PTY, then switch back to the target tab.
   - **Expected outcome:** The visible tab label remains `codex resume 019d1213-9c59-7bb0-80ae-70c74427f346` rather than `codex`, and the terminal buffer contains the sentinel proving the background PTY command executed. Source of truth: `S1`, `S2`, `S4`.
   - **Interactions:** Real shell PTY, xterm `onTitleChange`, hidden-tab reveal and reattach, shared durable title sync path, tab-label rendering.

2. **Name:** Runtime-only terminal titles are visible live but disappear after reload until the terminal emits them again.
   - **Type:** scenario
   - **Disposition:** new
   - **Harness:** Existing Playwright real-terminal harness plus the browser durable-title sync helper only for control assertions if needed.
   - **Preconditions:** A single real terminal tab exists with only a derived durable title and no stable or user override.
   - **Actions:** Emit a real OSC title such as `vim README.md`, assert the live tab label and pane header, reload the page, assert the visible title after hydration, then emit the same OSC title again.
   - **Expected outcome:** Before reload, the visible single-pane title can show `vim README.md`. After reload it falls back to the durable derived title because runtime titles are ephemeral. After re-emission the live runtime title becomes visible again. Source of truth: `S1`, `S2`, `S3`.
   - **Interactions:** Real PTY title emission, browser reload, persistence and hydration, tab-label and pane-header resolution.

3. **Name:** Hidden single-pane stable titles do not downgrade when a raw runtime title arrives while the tab is inactive.
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** TerminalView lifecycle harness.
   - **Preconditions:** Store state contains a single-pane tab and pane pair with a durable stable title, the tab is inactive or hidden, xterm title callbacks are captured, and websocket traffic is observable.
   - **Actions:** Render `TerminalView`, fire the captured `onTitleChange('codex')` while the tab is hidden, then reveal or reactivate the tab.
   - **Expected outcome:** The rendered title shown for that tab remains the durable stable title, and the raw runtime event does not write a durable tab rename. Source of truth: `S1`, `S2`, `S4`.
   - **Interactions:** Hidden and visible `TerminalView` lifecycle, raw xterm title callback path, Redux state updates, DOM title rendering.

4. **Name:** Durable `terminal.title.updated` promotions outrank runtime titles and clear stale runtime state.
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** TerminalView lifecycle harness plus the existing client title-state harness.
   - **Preconditions:** A pane has a derived durable title plus a live runtime title, and the shared stable terminal-id sync path is available.
   - **Actions:** Seed a runtime title, dispatch the durable stable title update for the same terminal id, then inspect the visible title surfaces for the matching tab and pane.
   - **Expected outcome:** The stable title becomes the visible durable title, the stale runtime title is cleared for that pane, and unrelated tabs remain unchanged. Source of truth: `S2`, `S4`.
   - **Interactions:** Shared durable sync thunk, runtime-title slice cleanup, tab and pane display resolution, terminal-id matching.

5. **Name:** Tab bar, mobile strip, tab switcher, and context-menu labels all resolve the same title-source precedence.
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** Client title-state and persistence harness.
   - **Preconditions:** Controlled store states cover single-pane and multi-pane tabs with combinations of `user`, `stable`, `derived`, and runtime titles.
   - **Actions:** Render the tab bar, mobile tab strip, tab switcher, and context menu against those states and capture the displayed title text in each surface.
   - **Expected outcome:** `user` titles beat everything, stable titles beat runtime titles, runtime titles appear only for eligible live single-pane tab labels, and multi-pane tabs do not adopt one pane's runtime title as the tab label. Source of truth: `S2`, `S3`.
   - **Interactions:** Shared title-resolution helpers, component renderers, active-tab and single-pane eligibility logic.

6. **Name:** Pane headers and rename entry points can use runtime titles without promoting them into durable tab names.
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** Client title-state and persistence harness.
   - **Preconditions:** A pane has a live runtime title and either no stronger durable override or a stronger stable or user override, and the rename UI is reachable from the pane surface.
   - **Actions:** Render the pane header and open the rename flow for both cases.
   - **Expected outcome:** The pane header shows the runtime title only when no stronger durable pane title exists, the rename prefill matches the currently visible pane title, and the tab's durable title source remains unchanged by viewing that runtime title. Source of truth: `S2`, `S3`.
   - **Interactions:** `PaneContainer`, rename UI plumbing, pane-title visibility rules, tab-versus-pane title separation.

7. **Name:** Durable title metadata survives persistence, reopen, restore, and cross-tab hydration while runtime titles do not.
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** Client title-state and persistence harness.
   - **Preconditions:** Canonical and legacy stored tab and pane payloads exist, including legacy non-user titles that need pane or layout context to resolve, plus in-memory runtime titles on live panes.
   - **Actions:** Parse persisted state, run persist middleware rewrites, restore layouts, capture reopen snapshots, and simulate cross-tab hydration from storage events.
   - **Expected outcome:** Durable `titleSource` and `paneTitleSources` survive and canonicalize once pane or layout context is available, reopened tabs keep their durable titles, and runtime titles are absent after hydrate, reopen, and cross-tab sync. Source of truth: `S2`, `S3`.
   - **Interactions:** `persistedState`, `persistMiddleware`, `tabsSlice`, `panesSlice`, `tabRegistrySlice`, `crossTabSync`, layout-restore reducers.

8. **Name:** History, attach, copy, workflow, CLI, and titled UI-command entry points mark only the intended titles as durable stable.
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** Client title-state and persistence harness.
   - **Preconditions:** Existing entry surfaces are mounted or dispatchable: session and history open, terminal attach and open, copied tab snapshots, prompt-derived coding-CLI flows, fixed workflow tabs, and explicit titled UI commands.
   - **Actions:** Trigger each entry path once, including at least one plain untitled tab creation as a control.
   - **Expected outcome:** Session and history titles, copied snapshots, prompt-derived CLI titles, fixed workflow titles, and explicit titled UI-command tabs are stored with a stable durable source, while plain default tab creation stays derived unless a stronger durable path later updates it. Source of truth: `S2`, `S4`.
   - **Interactions:** `HistoryView`, `OverviewView`, `BackgroundSessions`, `TabsView`, `SetupWizard`, `SafetySettings`, `codingCliThunks`, `ui-commands`, tab and pane reducers.

9. **Name:** Runtime titles clear on durable replacement, terminal identity changes, content replacement, and terminal exit.
   - **Type:** boundary
   - **Disposition:** extend
   - **Harness:** TerminalView lifecycle harness plus the pure helper and reducer harness.
   - **Preconditions:** One or more panes have live runtime titles under each affected lifecycle condition: durable rename, pane content replacement, terminal id replacement in place, and terminal exit with varying durable sources.
   - **Actions:** Apply each lifecycle transition in turn and inspect both the runtime-title slice and the rendered visible titles.
   - **Expected outcome:** Runtime titles are cleared for the affected panes in every case, stable and user durable titles survive non-destructive lifecycle updates, and exit decoration applies only when the remaining durable title is derived rather than stable or user. Source of truth: `S2`, `S4`.
   - **Interactions:** Runtime-title reducers, `TerminalView` exit handler, pane lifecycle reducers, exit-title helper logic.

10. **Name:** Sidebar fallback rows and background or open-tab session views ignore runtime-only titles and keep durable names.
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** Client title-state and persistence harness.
   - **Preconditions:** Session and sidebar fixtures include tabs with stable titles, user titles, derived defaults, and live runtime titles.
   - **Actions:** Run sidebar selectors and render the overview, background, and tab-session views for those fixtures.
   - **Expected outcome:** Sidebar fallback items and session-oriented views show durable titles only, not runtime-only titles, and copied or reopened session snapshots preserve the stable durable title where the implementation plan says they should. Source of truth: `S3`, `S4`.
   - **Interactions:** Sidebar selectors, overview and background views, reopen snapshot state, copied-tab metadata.

11. **Name:** Mirrored layouts round-trip durable title metadata and never serialize runtime titles.
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** Layout mirror and server layout-store harness.
   - **Preconditions:** A client layout contains panes with mixed durable title sources plus live runtime titles.
   - **Actions:** Mirror the layout to the agent payload, parse it through the shared schema, and run server-side rename, split, attach, swap, and remove operations against the stored layout.
   - **Expected outcome:** Mirrored payloads include durable `titleSource` and `paneTitleSources`, runtime titles are absent from the mirrored schema and stored payload, and server-side layout mutations preserve or move the durable metadata correctly. Source of truth: `S2`, `S5`.
   - **Interactions:** `layoutMirrorMiddleware`, shared layout schema, agent layout store mutation helpers.

12. **Name:** Tab switching after restore still avoids extra attach, resize, or replay churn.
   - **Type:** regression
   - **Disposition:** existing
   - **Harness:** Existing Playwright real-terminal harness.
   - **Preconditions:** The existing restored-hot-tabs browser scenario is available with websocket traffic inspection.
   - **Actions:** Run the current restore and reload tab-switch scenario and observe switch-time websocket traffic after the title-source refactor.
   - **Expected outcome:** Restored hot tabs still switch without extra attach, resize, or replay traffic beyond the existing expected pattern. Source of truth: `S1`, `S2`.
   - **Interactions:** Browser reload, tab-switching lifecycle, websocket terminal attach and resize protocol.

13. **Name:** Server session-title promotion and unified rename cascade remain behaviorally unchanged.
   - **Type:** regression
   - **Disposition:** existing
   - **Harness:** Layout mirror and server layout-store harness.
   - **Preconditions:** Existing server unit and integration fixtures for provider-title promotion and unified rename are available.
   - **Actions:** Re-run the current session-title promotion and unified rename integration suites after the client and server title-source changes.
   - **Expected outcome:** Session titles still promote only over default provider titles, and unified rename flows still cascade across terminal and session state without regressing unrelated server semantics. Source of truth: `S4`, `S5`.
   - **Interactions:** Server session-title sync, websocket title updates, unified rename integration.

14. **Name:** Title-source helpers and the runtime-title slice resolve deterministic precedence, legacy inference, normalization, and exit decoration.
   - **Type:** unit
   - **Disposition:** new
   - **Harness:** Pure helper and reducer harness.
   - **Preconditions:** Direct helper inputs cover legacy tabs without source metadata, pane and title combinations with and without layout context, runtime-title normalization, and exit-title formatting cases.
   - **Actions:** Call the shared title-source helpers and exercise the runtime-title slice reducers directly.
   - **Expected outcome:** Helpers resolve the same effective durable-source decisions the implementation plan describes, runtime normalization trims or ignores invalid raw titles, and exit-title decoration is deterministic for derived titles only. Source of truth: `S2`.
   - **Interactions:** None beyond the public helper and reducer interfaces.

15. **Name:** The coordinated full suite passes after the title-source refactor.
   - **Type:** regression
   - **Disposition:** existing
   - **Harness:** Broad verification harness.
   - **Preconditions:** Focused client, browser, and server checks above are green, and `npm run test:status` has been consulted so acceptance does not rely on stale coordinator history.
   - **Actions:** Run a fresh coordinated `npm test` with a meaningful `FRESHELL_TEST_SUMMARY`.
   - **Expected outcome:** The full repo suite passes, and merge readiness is established from the fresh run rather than the stale `test:unit` and `verify` history entries. Source of truth: `S6`.
   - **Interactions:** Whole-repo unit, integration, browser, and server test coordination.

## Coverage Summary
- **Covered action space:**
  - Real-browser background-tab regression with a real shell PTY and real OSC title emission.
  - Live runtime-title visibility and reload ephemerality.
  - Hidden-tab lifecycle timing around `TerminalView`.
  - Stable terminal-id sync and runtime-title clearing.
  - All visible title consumers named in the implementation plan: tab bar, mobile strip, tab switcher, pane headers, rename surfaces, sidebar fallback, background and open-tab views.
  - Durable-title entry points across session and history, terminal attach and copy, workflow tabs, coding-CLI thunks, and titled UI commands.
  - Persistence, reopen, restore-layout, and cross-tab hydration paths, including legacy missing-source inference.
  - Runtime-title cleanup on content replacement, terminal replacement, and exit.
  - Client layout mirroring plus server-side layout schema and store mutations.
  - Existing no-replay tab-switching guard, server session-title promotion guard, and the final coordinated full-suite gate.

- **Explicit exclusions from the agreed strategy:**
  - No provider-authenticated `codex resume` or `claude` browser journey.
    - **Why excluded:** The approved strategy explicitly prefers a real shell PTY emitting OSC titles over a provider-dependent flow that would make CI depend on CLI install or auth state.
    - **Risk carried by exclusion:** Provider-specific timing around when Codex or Claude emits OSC titles remains indirectly covered rather than directly reproduced, but the core Freshell contract being fixed is title-source handling, not provider auth behavior.
  - No screenshot-diff or manual visual validation.
    - **Why excluded:** Every user-visible assertion here can be expressed as explicit DOM text, terminal buffer text, websocket traffic, or persisted payloads.
    - **Risk carried by exclusion:** Minimal. A purely cosmetic typography or layout regression in the tab chrome would not be caught by this plan, but that is outside the stated bug.
  - No standalone performance benchmark.
    - **Why excluded:** The approved strategy treats performance risk as low and already identifies attach and replay churn as the meaningful regression surface.
    - **Risk carried by exclusion:** A catastrophic performance bug would need to surface through the existing no-replay or no-extra-attach regression or the full suite rather than a dedicated benchmark.
