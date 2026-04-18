# Fresh Agent Platform Test Plan

The agreed testing strategy still holds after reconciling it against [2026-04-18-fresh-agent-platform.md](/home/user/code/freshell/.worktrees/fresh-agent-platform/docs/plans/2026-04-18-fresh-agent-platform.md:1). The plan expands the interaction surface beyond the earlier high-level summary, but it does not require paid APIs, external infrastructure, or manual validation. The main adjustment is emphasis: acceptance has to be led by the real migration and user-facing surfaces in this order: persisted layout/settings migration, remote snapshot and session-directory projection, fresh-agent WS and HTTP transport, rendered shared pane behavior, then browser flows for create/resume/fork/mobile.

## Harness requirements

- `fresh-agent-route-harness`
  What it does: extends the existing `read-model-route-harness` / `supertest` route coverage to mount `/api/fresh-agent/threads/...` routes with revision-aware snapshot, page, and turn-body handlers.
  Exposes: HTTP status/body assertions, revision conflict injection, lane/scheduler observation, route call logs.
  Estimated complexity: low-medium.
  Tests depending on it: 5, 6, 7.

- `fresh-agent-ws-harness`
  What it does: extends the existing `protocol-harness` / `WsHandler` integration setup so tests can send and observe `freshAgent.*` messages alongside legacy terminal traffic.
  Exposes: ordered outbound WS messages, adapter call capture, reconnect and lost-session simulation, ready-handshake transcript.
  Estimated complexity: medium.
  Tests depending on it: 4, 8, 9, 15.

- `adapter-fixture-harness`
  What it does: loads recorded Claude ledger fixtures and Codex app-server fixtures through the real normalization path, then exposes normalized snapshots/pages/bodies to server and client tests.
  Exposes: deterministic provider fixtures, normalized thread snapshots, extension payloads, capability flags, fork/worktree/subagent metadata.
  Estimated complexity: medium.
  Tests depending on it: 10, 11, 12, 13, 14, 16.

- `rendered-fresh-agent-app`
  What it does: extends the existing RTL app and pane harnesses so a `fresh-agent` pane can be rendered with the real reducers, tabs/panes persistence, fresh-agent store, and context-menu wiring.
  Exposes: rendered transcript/composer/banners, tab and pane state, persisted layout state, outbound WS/API calls.
  Estimated complexity: medium.
  Tests depending on it: 1, 2, 3, 8, 9, 12, 13, 14.

- `playwright-fresh-agent-fixtures`
  What it does: extends the existing Playwright `freshellPage`/`harness` fixtures to seed migrated browser storage and provider fixtures for Freshclaude and Freshcodex browser flows.
  Exposes: real browser UI, screenshots/snapshots, isolated server info, browser storage seeding, harness state inspection.
  Estimated complexity: medium.
  Tests depending on it: 15, 16, 17, 18.

## Test plan

1. **Name:** Reloading a saved Freshclaude tab migrates `agent-chat` storage to `fresh-agent` without losing the pane, settings, or resume identity
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `rendered-fresh-agent-app`
   - **Preconditions:** Browser storage contains a combined layout payload with `kind: 'agent-chat'`, legacy `settings.agentChat`, pane titles, and a matching tab resume fallback.
   - **Actions:** Run the real storage migration; bootstrap the app from the migrated browser storage; render the restored tab and pane.
   - **Expected outcome:** Per the implementation plan sections `Steady-State Product Behavior`, `Contracts And Invariants`, and Task 1, the restored pane renders as `kind: 'fresh-agent'`, preserves `sessionType: 'freshclaude'`, keeps the existing pane/tab titles and resume identity, and does not clear unrelated Freshell browser state. Primary assertions are the rendered pane shell and persisted layout payload; supporting assertions may inspect the migrated JSON written back to the real storage keys.
   - **Interactions:** `src/store/storage-migration.ts`, `src/store/persistedState.ts`, `src/store/paneTypes.ts`, `src/components/TabContent.tsx`, settings bootstrap.

2. **Name:** Cross-tab hydrate preserves the local canonical resume identity when a remote snapshot still carries the older session id
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** `rendered-fresh-agent-app`
   - **Preconditions:** Local store already holds a `fresh-agent` pane with canonical `resumeSessionId`; an incoming persisted layout broadcast contains the same pane id with an older resume id and matching session family.
   - **Actions:** Feed the remote persisted layout through the real cross-tab sync path.
   - **Expected outcome:** Per Task 1 and the plan invariant `runtime readers must accept both legacy agent-chat persisted data and the new fresh-agent shape until every ... hydrate path has been switched`, the hydrated layout keeps the local canonical resume id on the pane and tab fallback metadata while still applying non-conflicting remote layout updates. Primary assertions are the post-hydrate pane/tab state visible to the app.
   - **Interactions:** `src/store/crossTabSync.ts`, `src/store/persistControl.ts`, pane hydration, tab merge.

3. **Name:** Remote tab snapshots round-trip a `fresh-agent` pane back into a reopenable tab with the same session identity and pane kind
   - **Type:** integration
   - **Disposition:** new
   - **Harness:** `rendered-fresh-agent-app`
   - **Preconditions:** A tab registry record or layout snapshot exists for a remote device with a rich agent pane, pane title metadata, and a session locator.
   - **Actions:** Serialize the open tab via the real snapshot path; hydrate it through the real `TabsView` reopen flow; open the restored tab in the client.
   - **Expected outcome:** Per `Remote layout snapshots and tab registry records must serialize fresh-agent, not agent-chat`, the reopened tab builds a `fresh-agent` pane, keeps `sessionType`, restores the session locator, and renders the right pane label/icon instead of falling back to picker or terminal mode. Primary assertions are the reopened tab/pane behavior in the rendered UI.
   - **Interactions:** `server/agent-api/layout-store.ts`, `server/tabs-registry/types.ts`, `src/components/TabsView.tsx`, `src/lib/tab-registry-snapshot.ts`.

4. **Name:** `freshAgent.create` routes to the adapter selected by `sessionType` while terminal WS traffic remains unchanged
   - **Type:** integration
   - **Disposition:** new
   - **Harness:** `fresh-agent-ws-harness`
   - **Preconditions:** The WS handler is mounted with a provider registry containing at least `freshclaude` and `freshcodex` adapters plus a terminal registry.
   - **Actions:** Open a WS connection; send `freshAgent.create` for `freshcodex`; then send a normal `terminal.create`.
   - **Expected outcome:** Per Task 2, the fresh-agent create call is dispatched to the Codex adapter chosen by `sessionType`, emits fresh-agent namespaced responses, and does not alter or intercept the terminal create flow. Primary assertions are the ordered outbound WS messages and adapter call log.
   - **Interactions:** `server/ws-handler.ts`, `server/fresh-agent/runtime-manager.ts`, provider registry, existing terminal WS envelopes.

5. **Name:** Fresh-agent thread routes reject stale revisions instead of serving mixed snapshot and body data
   - **Type:** integration
   - **Disposition:** new
   - **Harness:** `fresh-agent-route-harness`
   - **Preconditions:** A thread exists at revision `N`; the route harness can serve snapshot/page/body reads and inject stale revision conditions.
   - **Actions:** Request the thread snapshot, turn page, and turn body with revision `N-1`; repeat with revision `N`.
   - **Expected outcome:** Per Task 2 and the invariant `Read-model routes stay revisioned and lane-aware and must never mix bodies from one revision with summaries from another`, stale requests return `409` with the stale-revision code, while current-revision requests succeed and return the matching revision. Primary assertions are HTTP status and JSON payloads.
   - **Interactions:** `shared/read-models.ts`, scheduler lane selection, fresh-agent router, revision handling.

6. **Name:** Fresh-agent read-model routes stay lane-aware and do not regress visible-first route discipline
   - **Type:** invariant
   - **Disposition:** extend
   - **Harness:** `fresh-agent-route-harness`
   - **Preconditions:** The route harness is recording scheduled lane events for bootstrap, session directory, and fresh-agent thread reads.
   - **Actions:** Fetch bootstrap, session directory, and fresh-agent thread routes with `critical`, `visible`, and `background` priorities.
   - **Expected outcome:** Per the existing visible-first acceptance contract and Task 2, fresh-agent thread reads use the declared lane, do not force forbidden session-directory pre-ready routes, and preserve the scheduler event ordering already required elsewhere in the app. Primary assertions are scheduler event logs and route transcripts.
   - **Interactions:** read-model scheduler, visible-first fixtures, bootstrap router, fresh-agent router.

7. **Name:** Posting session metadata updates changes `sessionType` without clobbering the stored derived title
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** `fresh-agent-route-harness`
   - **Preconditions:** Session metadata store already contains `derivedTitle` for a Codex session.
   - **Actions:** Call the real session metadata API with `{ provider: 'codex', sessionId, sessionType: 'freshcodex' }`; then read back the stored entry and session-directory projection.
   - **Expected outcome:** Per Task 5 and the invariant `Session metadata remains keyed by provider:sessionId; updating sessionType must keep derivedTitle`, the session now reports `sessionType: 'freshcodex'` while the prior derived title remains intact in both storage and projection. Primary assertions are API response and projected session-directory JSON.
   - **Interactions:** `server/session-metadata-store.ts`, `server/sessions-router.ts`, `server/session-directory/projection.ts`, index refresh.

8. **Name:** A `fresh-agent` pane reconnects after lost-session transport errors by surfacing the explicit session-lost state and reloading through the fresh-agent transport
   - **Type:** scenario
   - **Disposition:** new
   - **Harness:** `rendered-fresh-agent-app` plus `fresh-agent-ws-harness`
   - **Preconditions:** A rendered `fresh-agent` pane is attached to an active thread; the WS harness can inject a lost-session error and a subsequent successful resume/snapshot.
   - **Actions:** Deliver a fresh-agent lost-session error; trigger the pane’s retry or reconnect action; deliver the resumed snapshot/page stream.
   - **Expected outcome:** Per Task 6 and Task 7, the pane shows a clear user-facing lost-session state, retry uses the fresh-agent transport rather than legacy `sdk.*`, and a successful retry restores the thread instead of degrading to a terminal or blank pane. Primary assertions are rendered error/recovery states and outbound WS/API calls.
   - **Interactions:** `src/lib/ws-client.ts`, `src/lib/fresh-agent-ws.ts`, `src/store/freshAgentThunks.ts`, pane-level recovery UI.

9. **Name:** The normalized fresh-agent client store merges live and durable updates by thread locator and revision without duplicating turns
   - **Type:** invariant
   - **Disposition:** new
   - **Harness:** `rendered-fresh-agent-app`
   - **Preconditions:** The client store contains a thread locator, an initial snapshot, and a later live delta plus durable page for the same revision family.
   - **Actions:** Dispatch the real fresh-agent snapshot, page, and body handlers in the order expected during resume and live streaming.
   - **Expected outcome:** Per Task 6 and the architecture section `Shared normalized read model`, the store keys the thread by runtime locator, retains stable turn/item ids, and renders one transcript with no duplicate turns/items when live and durable sources overlap. Primary assertions are rendered transcript order and user-visible de-duplication.
   - **Interactions:** `src/store/freshAgentSlice.ts`, `src/store/freshAgentThunks.ts`, read-model hydration, transcript rendering.

10. **Name:** Claude adapter restores one canonical thread from ledger-backed durable history plus live stream state
   - **Type:** integration
   - **Disposition:** new
   - **Harness:** `adapter-fixture-harness`
   - **Preconditions:** Claude ledger fixtures cover durable backlog, live stream overlap, question state, approval state, and model/permission metadata.
   - **Actions:** Load the fixtures through the real Claude fresh-agent adapter; request snapshot, page, and body data for the same thread.
   - **Expected outcome:** Per Task 3 and the architecture section `Claude runtime implementation stays behind the adapter boundary; the ledger/history strategy is preserved`, the normalized snapshot contains one canonical thread, preserves questions/approvals/model settings, and exposes provider-native detail as extension data rather than flattening it away. Primary assertions are normalized snapshot/page/body outputs from the adapter harness.
   - **Interactions:** `server/fresh-agent/adapters/claude/*`, `server/sdk-bridge.ts`, `server/agent-timeline/*`.

11. **Name:** Codex adapter normalizes fork, worktree, review, token, and child-thread metadata into the shared fresh-agent model
   - **Type:** integration
   - **Disposition:** new
   - **Harness:** `adapter-fixture-harness`
   - **Preconditions:** Codex app-server fixtures include raw rich-session events with fork lineage, worktree info, review/diff references, token summaries, and subagent children.
   - **Actions:** Load the fixtures through the real Codex adapter and request snapshot/page/body data.
   - **Expected outcome:** Per Task 4 and `Freshcodex rich panes use the Codex app-server as the source of truth`, the normalized thread advertises the correct capabilities, exposes worktree and child-thread refs, and keeps provider-specific extensions for Codex-only metadata. Primary assertions are the normalized shared-model payloads.
   - **Interactions:** `server/coding-cli/codex-app-server/*`, `server/fresh-agent/adapters/codex/*`, provider extension payloads.

12. **Name:** The shared fresh-agent pane shell shows provider-specific capabilities without changing the core transcript, composer, or banner affordances
   - **Type:** scenario
   - **Disposition:** new
   - **Harness:** `rendered-fresh-agent-app`
   - **Preconditions:** One normalized Freshclaude thread fixture and one normalized Freshcodex thread fixture are available with differing capability flags.
   - **Actions:** Render the shared `FreshAgentView` with the Claude thread, then with the Codex thread; activate capability-backed controls such as interrupt, fork, and approval/question actions where available.
   - **Expected outcome:** Per Task 7 and `Existing Freshclaude UX stays intact unless the new shared shell makes it stronger`, both providers render the same shell structure, Claude-only or Codex-only actions appear only when their capability flags permit them, and activating those controls produces the expected user-visible state changes or outbound actions. Primary assertions are the rendered controls and their activation effects.
   - **Interactions:** `src/components/fresh-agent/*`, `src/lib/fresh-agent-capabilities.ts`, context menus, shared session rendering primitives.

13. **Name:** Freshclaude input history survives the architecture cutover and remains scoped to the pane
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** `rendered-fresh-agent-app`
   - **Preconditions:** A Freshclaude `fresh-agent` pane is rendered with a composer bound to a stable pane id.
   - **Actions:** Send multiple prompts, navigate history with ArrowUp/ArrowDown, reload or remount the pane, and reopen history.
   - **Expected outcome:** Per Task 7 and the requirement to preserve current Freshclaude behavior, the composer recalls sent prompts in order, preserves draft behavior, persists history across reload/remount, and keeps the history isolated to the pane id rather than global session state. Primary assertions are the rendered composer value and persisted input-history storage key contents.
   - **Interactions:** `src/lib/input-history-store.ts`, composer state, pane persistence.

14. **Name:** Fresh-agent context menus target the migrated pane/session surfaces and keep resume-command, diff, and copy actions working
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `rendered-fresh-agent-app`
   - **Preconditions:** A rendered fresh-agent transcript contains tool input, diff content, and a resumable session reference; tabs and panes are present in the real menu-building context.
   - **Actions:** Open the context menu on transcript text, tool input, diff content, and the pane/tab chrome; activate the copy-resume-command and agent-content copy actions.
   - **Expected outcome:** Per Task 7 and Task 8, the menu resolves targets against `fresh-agent` panes rather than `agent-chat`, exposes the right copy/resume items, and dispatches the expected action for each activated item. Primary assertions are rendered menu items and resulting clipboard/action calls.
   - **Interactions:** `src/components/context-menu/menu-defs.ts`, session refs, resume-command helpers, transcript DOM attributes.

15. **Name:** Browser user can create and resume Freshcodex with visible worktree and fork metadata in the shared pane
   - **Type:** scenario
   - **Disposition:** new
   - **Harness:** `playwright-fresh-agent-fixtures`
   - **Preconditions:** Playwright server fixture has Codex rich-session fixtures available and Freshcodex enabled in the pane picker.
   - **Actions:** Open the pane picker, create a Freshcodex pane, allow the thread to load, navigate away and back or reload to resume it, then activate the fork/worktree UI affordances.
   - **Expected outcome:** Per the user goal and Tasks 4, 6, and 7, the real browser UI shows a Freshcodex pane, preserves the resumed thread after reload, and visibly surfaces worktree/fork metadata through the shared shell. Primary assertions are browser-visible controls, labels, and thread content; supporting assertions may read harness state.
   - **Interactions:** pane picker, fresh-agent transport, Codex adapter, browser storage persistence, shared pane shell.

16. **Name:** Browser user can restore Freshclaude and still see approval and question banners after the migration
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `playwright-fresh-agent-fixtures`
   - **Preconditions:** Playwright browser storage or server fixture seeds a persisted Freshclaude rich pane with outstanding approval and question state.
   - **Actions:** Load the app, open the restored pane, respond to the approval/question controls, and reload the page.
   - **Expected outcome:** Per `Existing Freshclaude sessions, settings, reopen entries, local layouts, remote tab snapshots, and sidebar/history items survive migration with no manual repair`, the restored pane appears automatically, banners are visible and actionable, and their resolved state persists across reload. Primary assertions are the browser-visible alert/banner content and action effects.
   - **Interactions:** persisted layout migration, Claude adapter, fresh-agent client store, banner actions.

17. **Name:** Mobile browser flows keep the fresh-agent shell usable without regressing tab and sidebar navigation
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `playwright-fresh-agent-fixtures`
   - **Preconditions:** Playwright viewport is mobile-sized and the app starts with at least one rich agent tab plus standard tab strip controls.
   - **Actions:** Open the mobile tab switcher, create or switch to a fresh-agent tab, open the sidebar/history surface, and return to the pane.
   - **Expected outcome:** Per the implementation plan requirement `Mobile and sidebar behavior remain first-class requirements`, the mobile tab strip, tab switcher, sidebar open/close controls, and fresh-agent pane remain operable and visually coherent; the user can reach and return from the sidebar/history flows without losing the active rich pane. Primary assertions are browser-visible controls and resulting navigation state.
   - **Interactions:** `src/components/MobileTabStrip.tsx`, `src/components/Sidebar.tsx`, `src/components/HistoryView.tsx`, rich pane mount/unmount behavior.

18. **Name:** Full targeted verification replaces legacy `agent-chat` browser proofs with fresh-agent browser proofs before deletion
   - **Type:** regression
   - **Disposition:** new
   - **Harness:** `playwright-fresh-agent-fixtures`
   - **Preconditions:** Replacement browser specs exist for the flows currently covered by `agent-chat.spec.ts`, `agent-chat-input-history.spec.ts`, `pane-activity-indicator.spec.ts`, and the rich-pane portions of `tab-management.spec.ts`.
   - **Actions:** Run the fresh-agent browser specs that cover create, resume, input history, pane activity, and tab restoration; compare their covered user-visible behaviors against the legacy spec inventory before any legacy rich-pane spec is deleted or renamed away.
   - **Expected outcome:** Per Task 8 and `Port existing regression coverage forward; do not delete a test unless its behavior is demonstrably covered elsewhere`, the fresh-agent browser suite proves the same user-visible behaviors before legacy `agent-chat` browser coverage is removed. Primary assertions are passing browser scenarios and a one-to-one coverage mapping in the renamed replacement specs.
   - **Interactions:** Playwright fixtures, pane activity indicators, input history, restored tabs, spec migration inventory.

## Coverage summary

- Covered action space:
  storage migration on startup; local settings migration; persisted layout parsing and hydration; cross-tab persisted-layout broadcast handling; remote tab snapshot serialization and reopen; session metadata POST; session-directory projection refresh; fresh-agent WebSocket create/resume/reconnect/lost-session handling; fresh-agent thread snapshot/page/body HTTP reads; Claude and Codex adapter normalization; shared fresh-agent transcript/composer/banner/diff/context-menu actions; pane picker create flows; browser restore flows; mobile tab/sidebar navigation.

- Explicitly excluded per the agreed strategy:
  live external Claude/Codex/OpenCode processes, real paid provider APIs, production-only worktree/review backends outside the repo’s existing fixtures, and manual visual review.

- Risks carried by those exclusions:
  true subprocess timing issues, upstream protocol drift, or production-only review/worktree behaviors could still appear after local verification. The strongest practical mitigation here is fixture-backed adapter coverage plus real browser/UI coverage against the repo’s own transport and persistence paths, which this plan makes the acceptance gate.
