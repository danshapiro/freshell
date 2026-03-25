# Test Plan: Wrong Agent Restore Fix

## Strategy reconciliation

The approved testing strategy still matches the finalized implementation plan.
The plan keeps the same proof shape the user approved:

- a new browser regression is still the top acceptance gate because the bug is a
  persisted restore bug the user sees in the real product surface
- existing client, server, and browser harnesses are sufficient; no paid APIs,
  external services, or new infrastructure are required
- the main risk is still split across two boundaries, not one: early server-side
  session ownership and later client-side fallback restore/state cleanup

The plan does clarify two details that sharpen the test mix, but they do not
change scope or cost:

- the `ready.serverInstanceId` gate is a real restore boundary, so the focused
  client regression should live in `TerminalView.lifecycle` plus the browser
  spec, not only in pure selector tests
- `layoutMirrorMiddleware.ts` and `TabBar.tsx` remain compatibility and
  presentation surfaces, not primary acceptance gates, because the plan keeps
  no-layout metadata for sync/display while removing its ownership authority in
  restore, open-session lookup, and busy-state ownership

No strategy changes requiring user approval are needed.

## Harness requirements

No new harness work is required.

- Browser restore scenario harness: the existing Playwright `TestServer` and
  `TestHarness`, plus raw `page.addInitScript()` and manual `page.goto()`, are
  enough to seed `freshell.tabs.v2` and `freshell.panes.v2` before bootstrap,
  inspect outbound WebSocket messages, inspect Redux state, and read terminal
  buffer text. Complexity: existing. Tests: 1, 2, 16.
- Client state and component harness: the existing Redux + RTL suites around
  `TerminalView`, `tabsSlice`, `ui-commands`, `TabsView`, `session-utils`,
  `pane-activity`, `ContextMenuProvider`, `PaneContainer`, and persisted-state
  loaders already expose preloaded store state, mocked WebSocket/API behavior,
  dispatched actions, and xterm writes. Complexity: existing. Tests: 3, 4, 5,
  6, 7, 8, 14, 15.
- Server interaction harness: the existing `TerminalRegistry`,
  `SessionAssociationCoordinator`, `WsHandler`, live WebSocket tests, and the
  current Codex reconnect regression already expose binding authority, emitted
  broadcasts, canonical reuse behavior, and repeated index updates. Complexity:
  existing. Tests: 9, 10, 11, 12, 13, 16.
- Focused helper harnesses: new unit files for `codex-shell-snapshot` and
  `exact-session-ref` need no new infrastructure beyond Vitest. Complexity:
  low. Tests: 13, 14.

## Test plan

1. **Name**: Reloading persisted same-cwd coding tabs restores each tab to its own exact session.
   **Type**: regression
   **Disposition**: new
   **Harness**: Browser scenario harness in `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts`.
   **Preconditions**: Before navigation, `freshell.tabs.v2` and `freshell.panes.v2` are seeded with two persisted coding tabs whose panes share provider and `cwd` but carry different exact local `sessionRef` values and different mirrored `resumeSessionId` values.
   **Actions**: Use `page.addInitScript()` to seed storage; navigate manually with `?token=...&e2e=1`; wait for harness installation and WS ready; inspect sent `terminal.create` messages; reload once; switch between the restored tabs and inspect the next restore messages.
   **Expected outcome**: The visible tabs remain distinct, and every outbound `terminal.create` for those panes uses the tab or pane's own exact session, never the sibling's. Supporting assertions can inspect `tabId`, `paneId`, and `resumeSessionId` on the sent WS payloads. Source of truth: implementation plan User-Visible Contract bullets 1 and 2, plus Frozen Decisions 1, 5, and 6.
   **Interactions**: LocalStorage bootstrap, `TabContent` restore surface, `TerminalView` restore gating, connection readiness, WebSocket create flow, Playwright test server.

2. **Name**: A degraded no-layout coding tab blocks restore instead of guessing.
   **Type**: regression
   **Disposition**: new
   **Harness**: Browser scenario harness in `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts`.
   **Preconditions**: `freshell.tabs.v2` contains a coding tab with a bare `resumeSessionId`, coding mode, and stable `createRequestId`; `freshell.panes.v2` omits that tab's layout or exact `sessionRef`.
   **Actions**: Seed storage before bootstrap; navigate manually; wait for WS ready and steady state; read the terminal buffer and sent WS messages.
   **Expected outcome**: The user-visible pane shows `[Restore blocked: exact session identity missing]`, and the app does not send an authoritative coding restore based only on the bare tab mirror. Supporting assertions can verify the stale `createRequestId` is reused for restore bookkeeping rather than minting a fresh coding identity. Source of truth: User-Visible Contract bullet 4 and Frozen Decisions 5, 6, and 7.
   **Interactions**: No-layout fallback path, restore request bookkeeping, xterm output, connection readiness, persisted tab-only metadata.

3. **Name**: Restored coding panes wait for local server identity and only resume when exact local identity is provable.
   **Type**: integration
   **Disposition**: extend
   **Harness**: Existing `TerminalView.lifecycle` and `terminal-restore` harnesses in `test/unit/client/components/TerminalView.lifecycle.test.tsx` and `test/unit/lib/terminal-restore.test.ts`.
   **Preconditions**: A restored coding pane is preloaded with a restore-marked `createRequestId`; one case has an exact local `sessionRef`, another has only a bare `resumeSessionId` or a foreign `sessionRef`; `connection.serverInstanceId` is initially unknown.
   **Actions**: Render the pane; assert that no `terminal.create` is sent before local server identity is known; then provide the local `serverInstanceId` and let the effect settle.
   **Expected outcome**: The exact-local case sends one authoritative restore create after the local server identity arrives. The degraded and foreign cases do not send a restore create and instead surface the blocked-restore message. Source of truth: Frozen Decisions 1, 5, 7, and 8, plus User-Visible Contract bullets 3 and 4.
   **Interactions**: Connection slice, restore gating helper, xterm writes, restore request registry, pane content updates.

4. **Name**: Clicking a session that is already open focuses the layout-backed owner, not a no-layout coding mirror.
   **Type**: scenario
   **Disposition**: extend
   **Harness**: Existing sidebar interaction harness in `test/e2e/sidebar-click-opens-pane.test.tsx`.
   **Preconditions**: The sidebar session list contains a target coding session. Store state contains one real owning pane in a layout and one separate no-layout tab carrying matching compatibility metadata.
   **Actions**: Render the sidebar flow and click the target session row.
   **Expected outcome**: Freshell activates the tab and pane that truly own the session in layout state, does not focus the no-layout mirror, and does not create an extra pane or tab. Source of truth: User-Visible Contract bullet 2 and Frozen Decisions 1, 6, and 7.
   **Interactions**: Sidebar session selection, `findPaneForSession`, `findTabIdForSession`, `openSessionTab`, active pane selection.

5. **Name**: Copy and reopen flows preserve explicit exact refs without inventing local exact identity from compatibility metadata.
   **Type**: regression
   **Disposition**: extend
   **Harness**: Existing `TabsView`, `tabs-view-flow`, and `tab-registry-snapshot` harnesses in `test/unit/client/components/TabsView.test.tsx`, `test/e2e/tabs-view-flow.test.tsx`, and `test/unit/client/lib/tab-registry-snapshot.test.ts`.
   **Preconditions**: Registry records cover three cases: a same-server exact coding pane with explicit `sessionRef`, a foreign-server exact coding pane, and a Claude pane that only has a human-readable resume name.
   **Actions**: Open a copy of a remote tab, open a pane into a new tab, and reopen a closed tab from registry snapshots.
   **Expected outcome**: Explicit exact refs survive copy or reopen when already present, foreign copies do not gain local resume authority, and human-readable Claude resume names never become synthesized exact refs during snapshot import or reopen. The copied or reopened tabs still render and open correctly. Source of truth: User-Visible Contract bullet 3 and Frozen Decisions 1, 7, and 8.
   **Interactions**: Registry snapshot serialization, `TabsView` sanitize paths, closed-tab reopen flow, local versus foreign server instance handling.

6. **Name**: Compatibility-only sidebar metadata stays visible and explicitly openable without regaining restore authority.
   **Type**: scenario
   **Disposition**: extend
   **Harness**: Existing sidebar visibility harness in `test/e2e/open-tab-session-sidebar-visibility.test.tsx`.
   **Preconditions**: Bootstrap state contains a no-layout coding tab that preserves compatibility metadata only, such as a named Claude resume or degraded local tab mirror, and there is no exact local pane owner for that session yet.
   **Actions**: Start the app from persisted state, inspect the sidebar session list, and trigger an explicit user session-open from the visible session entry.
   **Expected outcome**: The session remains visible as a compatibility hint, and the explicit open path still creates or focuses a layout-backed pane through normal session-open behavior. The compatibility-only no-layout tab does not auto-resume or claim ownership during bootstrap. Source of truth: User-Visible Contract bullets 4 and 5, plus Frozen Decisions 6, 7, and 8.
   **Interactions**: Sidebar session visibility, compatibility metadata, bootstrap hydration, `openSessionTab`, no-layout restore gating.

7. **Name**: No-layout coding metadata no longer owns busy state or session lookup, and pane cleanup clears stale tab mirrors.
   **Type**: regression
   **Disposition**: extend
   **Harness**: Existing `session-utils`, `pane-activity`, `ContextMenuProvider`, `PaneContainer`, and `replace-pane` harnesses in `test/unit/client/lib/session-utils.test.ts`, `test/unit/client/lib/pane-activity.test.ts`, `test/unit/client/components/ContextMenuProvider.test.tsx`, `test/unit/client/components/panes/PaneContainer.test.tsx`, and `test/e2e/replace-pane.test.tsx`.
   **Preconditions**: State includes a layout-backed coding owner, a no-layout coding tab with matching tab metadata, and a pane whose owning session is about to be replaced or closed while busy state exists on the real owner.
   **Actions**: Query session lookup and busy-session helpers; then replace and close the owning pane through the real UI or component handlers.
   **Expected outcome**: Lookup and busy ownership come only from layout-backed panes. When the owning pane is removed or replaced, `tab.resumeSessionId` is cleared along with stale `tab.terminalId`, so later focus or restore decisions cannot land on the cleaned-up tab. Source of truth: User-Visible Contract bullet 2 and Frozen Decision 7.
   **Interactions**: Session selectors, busy-state projection, context-menu replace flow, pane close flow, tab metadata cleanup.

8. **Name**: Local session-open and UI command ingress create layout-backed panes immediately and synthesize exact identity only through the shared exactness rule.
   **Type**: integration
   **Disposition**: extend
   **Harness**: Existing `tabsSlice` and `ui-commands` harnesses in `test/unit/client/store/tabsSlice.test.ts` and `test/unit/client/ui-commands.test.ts`.
   **Preconditions**: Test cases cover Codex exact session IDs, exact UUID Claude sessions, and human-readable Claude resume names, with local `serverInstanceId` present and absent.
   **Actions**: Dispatch `openSessionTab`, `ui.command tab.create`, and `ui.command pane.attach` for PTY-backed coding sessions.
   **Expected outcome**: PTY-backed coding sessions get layout-backed panes immediately instead of relying on no-layout fallback; provided `createRequestId` values survive ingress; exact `sessionRef` values appear only for exact provider/session identifiers when the local server identity is known; named Claude resumes remain compatibility-only. Source of truth: Frozen Decisions 1, 6, and 8, plus User-Visible Contract bullets 2 and 5.
   **Interactions**: `buildResumeContent`, `openSessionTab`, pane normalization, UI command handling, local server identity propagation.

9. **Name**: Discovered Codex sessions bind to the terminal identified by launch provenance, not the oldest same-cwd candidate.
   **Type**: integration
   **Disposition**: extend
   **Harness**: Existing server interaction harness in `test/server/session-association.test.ts`, with supporting unit coverage in the new `test/unit/server/discovered-session-association.test.ts`.
   **Preconditions**: Multiple running Codex terminals share a provider and `cwd`; one discovered Codex session includes shell snapshot launch provenance pointing to a specific `FRESHELL_TERMINAL_ID`.
   **Actions**: Feed the discovered session through the association path that processes indexer updates.
   **Expected outcome**: The terminal named by launch provenance becomes the only owner of the session, and older same-cwd candidates stay unbound. Supporting assertions can inspect the association broadcast and metadata update path. Source of truth: Frozen Decisions 2, 3, and 4, plus User-Visible Contract bullet 1.
   **Interactions**: Codex shell snapshot provenance, discovered-session association helper, binding authority, metadata broadcasts, session index updates.

10. **Name**: Fresh Claude terminals are exact at birth, while named Claude resumes stay compatibility-only until association.
   **Type**: regression
   **Disposition**: extend
   **Harness**: Existing spawn, registry, and WS create/reuse harnesses in `test/unit/server/terminal-registry.test.ts`, `test/server/ws-terminal-create-reuse-running-claude.test.ts`, and `test/server/ws-terminal-create-session-repair.test.ts`.
   **Preconditions**: One fresh Claude create omits `resumeSessionId`; one Claude create uses a human-readable resume name.
   **Actions**: Build spawn args and create terminals through the WS path; later drive UUID association for the named-resume case.
   **Expected outcome**: Fresh Claude launches use `--session-id <uuid>`, bind that UUID immediately, and return it as `effectiveResumeSessionId` in `terminal.created`. Named resumes still pass the raw `--resume <name>` through for compatibility but do not claim exact binding until the UUID association arrives. Source of truth: Frozen Decisions 2, 3, 4, and 8, plus User-Visible Contract bullet 5.
   **Interactions**: `spawn-spec`, terminal registry create and binding, session repair gating, WS `terminal.created` payloads, later compatibility association.

11. **Name**: The compatibility coordinator stays active only for providers that still lack exact provenance.
   **Type**: integration
   **Disposition**: extend
   **Harness**: Existing `SessionAssociationCoordinator` unit and integration harnesses in `test/unit/server/session-association-coordinator.test.ts` and `test/server/session-association.test.ts`.
   **Preconditions**: Candidate sessions cover exact-provenance Codex, fresh exact Claude, named Claude resume, and Opencode.
   **Actions**: Collect and attempt association for each candidate through coordinator-facing APIs.
   **Expected outcome**: Codex and fresh exact Claude do not flow through the generic same-cwd coordinator, while named Claude resume and Opencode still do and continue to associate when their current compatibility conditions are met. Source of truth: Frozen Decision 4 and User-Visible Contract bullet 5.
   **Interactions**: Coordinator filtering, provider resume support, registry unassociated-terminal lookup, backward-compatibility path.

12. **Name**: Reconnects and repeated index updates do not steal Codex ownership after exact binding.
   **Type**: regression
   **Disposition**: extend
   **Harness**: Existing integration harness in `test/integration/server/codex-session-rebind-regression.test.ts`.
   **Preconditions**: Several Codex sessions have already been exactly bound to distinct owners.
   **Actions**: Drive an initial index update, reconnect through `terminal.create` reuse, then replay both same-watermark and advanced-watermark updates.
   **Expected outcome**: Each session keeps its original owner across reconnect and repeated updates, and every later `terminal.create` reuse returns that same owner and session pairing. Source of truth: User-Visible Contract bullet 1 and Frozen Decisions 2, 3, and 4.
   **Interactions**: Binding authority, update watermarks, WS reuse-by-session, reconnect flow, repeated indexing.

13. **Name**: Codex shell snapshot parsing accepts the real filename patterns and prefers the newest matching snapshot.
   **Type**: unit
   **Disposition**: new
   **Harness**: New pure helper tests in `test/unit/server/coding-cli/codex-shell-snapshot.test.ts`.
   **Preconditions**: Synthetic shell snapshot directories contain both `<sessionId>.sh` and `<sessionId>.*.sh` files with varying mtimes and `FRESHELL_TERMINAL_ID`, `FRESHELL_TAB_ID`, and `FRESHELL_PANE_ID` values.
   **Actions**: Parse the snapshot directory for a given session ID.
   **Expected outcome**: The parser accepts both filename forms, prefers the newest matching snapshot, and returns the launch origin fields needed for exact association. Source of truth: Frozen Decision 2 and Task 2 of the implementation plan.
   **Interactions**: Filesystem parsing, Codex launch provenance extraction, discovered-session exact binding.

14. **Name**: Provider-aware exact-session helpers and snapshot sanitizers never fabricate exact identity from compatibility-only data.
   **Type**: unit
   **Disposition**: new
   **Harness**: New helper coverage in `test/unit/client/lib/exact-session-ref.test.ts`, with supporting extensions in `test/unit/client/components/TabsView.test.tsx` and `test/unit/client/lib/tab-registry-snapshot.test.ts`.
   **Preconditions**: Inputs cover exact Codex IDs, UUID Claude IDs, foreign same-session snapshots, and named Claude resume values.
   **Actions**: Call the exact-session helper directly and route those values through snapshot sanitize paths that consume it.
   **Expected outcome**: Exact refs are produced only when the provider/session identifier is exact and the context is local; foreign or compatibility-only inputs never get upgraded into exact local refs; explicit exact refs remain intact. Source of truth: Frozen Decisions 1, 7, and 8, plus User-Visible Contract bullet 3.
   **Interactions**: Exact-session helper, `TabsView`, tab registry snapshot serialization and import, remote copy behavior.

15. **Name**: Persisted pane migration, hydrate merge, and restore bookkeeping preserve authoritative pane identity.
   **Type**: regression
   **Disposition**: extend
   **Harness**: Existing persisted-state and pane hydration harnesses in `test/unit/client/store/persistedState.test.ts`, `test/unit/client/store/panesPersistence.test.ts`, `test/unit/client/store/crossTabSync.test.ts`, `test/unit/client/store/panesSlice.test.ts`, and `test/unit/lib/terminal-restore.test.ts`.
   **Preconditions**: Legacy and current pane payloads cover explicit `sessionRef`, bare mirrored `resumeSessionId`, conflicting incoming data for the same `createRequestId`, and restored request IDs loaded from persisted layouts.
   **Actions**: Parse raw persisted panes, load cached panes twice, hydrate conflicting remote pane trees, and inspect restore request registration and consumption.
   **Expected outcome**: One migration path preserves existing explicit `sessionRef`, local authoritative exact identity wins over conflicting or missing incoming data, degraded legacy data does not mint fake exact refs, and restored request IDs stay stable for blocked restore and reconnect flows. Source of truth: Frozen Decisions 1, 5, 6, and 8, plus User-Visible Contract bullet 4.
   **Interactions**: Persisted parser, cached load memoization, hydrate merge, create-request restore tracking, legacy migration behavior.

16. **Name**: The acceptance sweep keeps the new restore guarantees and adjacent behavior green.
   **Type**: invariant
   **Disposition**: existing
   **Harness**: Repo-wide verification via Playwright, focused Vitest suites, lint, and the coordinated full-suite runner.
   **Preconditions**: The implementation is complete and all focused regressions have gone green locally.
   **Actions**: Run the new browser spec, the focused client and server suites named above, `npm run lint`, and coordinated `npm test`.
   **Expected outcome**: The browser regression passes explicitly, the targeted client and server suites pass, lint passes, and `npm test` stays green. The acceptance argument does not assume Playwright is included in `npm test`; it is run separately on purpose. Source of truth: the implementation plan's acceptance proof and the repo test-coordination rules in `AGENTS.md`.
   **Interactions**: Playwright global setup/build, browser harness, client Vitest suites, server Vitest suites, ESLint, coordinator gate.

## Coverage summary

### Covered action space

- Restoring persisted coding tabs after reload, reconnect, and repeated restore attempts.
- Blocking degraded no-layout coding restores that cannot prove exact local identity.
- Focusing already-open sessions from the sidebar without being hijacked by no-layout tab mirrors.
- Opening copied and reopened tabs from registry snapshots without inventing local exact identity.
- Keeping compatibility-only sidebar visibility and explicit session-open behavior intact while restore stays fail-closed.
- Seeding layout-backed coding panes immediately for local session-open and UI-command ingress.
- Removing no-layout coding ownership leaks from restore, open-session lookup, and busy-state ownership.
- Clearing stale tab mirrors when the owning pane is replaced, detached, closed, or exited.
- Binding discovered Codex sessions by exact launch provenance instead of generic same-cwd age ordering.
- Making fresh Claude exact at birth while preserving named Claude resume compatibility behavior.
- Preserving exact Codex ownership across reconnects and repeated index updates.
- Keeping persisted migration, hydrate merge, and restore bookkeeping aligned with the new authority model.
- Final acceptance via explicit browser coverage, targeted client or server coverage, lint, and coordinated full-suite coverage.

### Explicitly excluded

- `layoutMirrorMiddleware` payload shape changes beyond the current characterization tests. The plan deliberately keeps `fallbackSessionRef` as compatibility metadata, so its sync payload is not a primary acceptance gate.
- Pure visual screenshot comparison. The relevant outcomes are already assertable through DOM state, terminal buffer text, Redux state, and sent WebSocket payloads.
- Dedicated performance benchmarking. The plan changes identity and restore authority, not high-volume rendering or transport throughput. A catastrophic regression will still surface in the browser and focused suite runtimes.
- External provider behavior beyond Freshell's own contracts. The tests validate Freshell's spawn arguments, provenance parsing, and restore decisions, not upstream CLI success or failure semantics after the command is launched.

### Residual risks from the exclusions

- A bug limited to layout-sync presentation metadata could still exist without breaking authoritative restore or open-session behavior.
- Upstream CLI contract drift around Codex shell snapshot contents or Claude CLI flags would still need maintenance if those tools change independently of Freshell.
- Because `npm test` does not include Playwright, skipping the explicit browser spec would leave the highest-fidelity user-visible regression unproven; that is why Test 16 treats the browser spec as a separate gate.
