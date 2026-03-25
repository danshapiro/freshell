# Tab Layout Integrity Test Plan

The implementation plan already matches the agreed strategy: pane-backed tabs must be created and restored through shared workspace actions, workspace persistence must become atomic, and existing missing-layout corruption must fail closed instead of fabricating content. No strategy change or approval change is needed.

## Harness requirements

The existing Playwright browser harness is sufficient. It already exposes `window.__FRESHELL_TEST_HARNESS__` for Redux state, sent WebSocket messages, tab counts, and terminal buffers, and it already supports reloads and multi-page contexts. Estimated complexity: low. Tests depending on it: 1, 2, 3, 4.

The existing browser storage seed helpers need to be extended so they can seed the new combined workspace payload as well as legacy split keys for compatibility regressions. Estimated complexity: low. Tests depending on it: 3, 4, 8.

No new bespoke harness is required. The browser fixtures and unit test utilities already cover the interaction surfaces this fix touches.

## Test plan

1. **Exact-session restore stays fail-closed across reload**
   Type: regression
   Disposition: existing
   Harness: Playwright browser harness with `terminal-exact-session-identity.spec.ts`
   Preconditions: two persisted pane-backed coding tabs exist, each with its own exact session identity and layout.
   Actions: boot Freshell, wait for both tabs, reload the page, switch between both tabs, and collect WebSocket create/attach traffic plus terminal output.
   Expected outcome: each tab reconnects to its own exact session, degraded restore still reports `[Restore blocked: exact session identity missing]`, and no tab is replaced with `New Tab` or a blank coding session. Source of truth: the implementation plan’s User-visible Contract and Frozen Decisions 1, 3, and 8, plus the existing exact-session browser regression.
   Interactions: localStorage bootstrap, terminal attach/reconnect, tab switching, and cross-tab sync.

2. **Switching away from a pane-backed tab does not erase its contents**
   Type: scenario
   Disposition: extend
   Harness: Playwright browser harness with `tab-management.spec.ts`
   Preconditions: at least two pane-backed tabs are open with distinct visible content.
   Actions: switch away from the active tab, return to it repeatedly, then reload and switch again.
   Expected outcome: the tab that was left behind still shows its original pane content when reselected, and the app does not regenerate that tab as `New Tab`, a blank coding session, or any other synthesized fallback. Source of truth: the user report, the implementation plan’s User-visible Contract, and Frozen Decisions 1 and 9.
   Interactions: hidden-tab rendering, pane bootstrap, tab selection, and persistence/sync of the active workspace.

3. **A corrupted persisted workspace shows an explicit missing-layout error**
   Type: regression
   Disposition: new
   Harness: Playwright browser harness with a new `tab-layout-integrity.spec.ts`
   Preconditions: browser storage is seeded so `tabs` contains an existing pane-backed tab while the matching layout entry is missing.
   Actions: boot Freshell from that seeded state, wait for the tab to render, and inspect the content area and test hooks.
   Expected outcome: the tab remains visible, the content area shows a stable explicit missing-layout error surface, the DOM exposes a deterministic marker such as `data-testid="missing-layout-error"`, and no replacement content is fabricated. Source of truth: the implementation plan’s User-visible Contract and Frozen Decisions 1, 7, 8, and 9.
   Interactions: storage bootstrap, hidden-tab rendering, error boundary behavior, and the no-fallback contract.

4. **Two clients do not synthesize fallback content for hidden tabs**
   Type: scenario
   Disposition: extend
   Harness: Playwright browser harness with `multi-client.spec.ts` and the new `tab-layout-integrity.spec.ts`
   Preconditions: two browser pages are connected to the same workspace and at least one pane-backed tab exists on the shared server.
   Actions: mutate tab visibility and layout state in one page, let the other page receive storage/broadcast updates, and then reselect the hidden tab there.
   Expected outcome: both clients converge on the same combined workspace state, hidden tabs do not auto-create replacement layouts, and mirrored payloads do not export fabricated fallback identity for corrupted tabs. Source of truth: Frozen Decisions 4, 5, 6, 7, and 10, plus the Integrity Invariants around one authoritative workspace snapshot.
   Interactions: BroadcastChannel, storage events, cross-tab hydration, mirrored layout sync, and hidden-tab rendering.

5. **Pane-backed tab creation and reopen flows use shared workspace actions, while session-view coding tabs remain exempt**
   Type: integration
   Disposition: extend
   Harness: Vitest with `ui-commands.test.ts`, `TabsView.test.tsx`, `ContextMenuProvider.test.tsx`, `codingCliThunks.test.ts`, and `tabsSlice.test.ts`
   Preconditions: unit stores start from minimal valid tab and pane state, and the relevant callers are wired to the store under test.
   Actions: dispatch `ui.command tab.create` with pane content, exercise representative reopen/open-copy paths from `TabsView` and `ContextMenuProvider`, and invoke `createCodingCliTab` for a session-view coding flow.
   Expected outcome: pane-backed creation and restore paths land in one coherent tab-plus-layout state through the shared workspace action boundary, caller-managed `addTab(...)` plus `initLayout(...)` orchestration is no longer the acceptance path, and `codingCliSessionId` session-view tabs still create only the session-view state they need. Source of truth: the implementation plan’s Frozen Decisions 2 and 3 and the User-visible Contract’s distinction between pane-backed tabs and session-view coding tabs.
   Interactions: UI command routing, tab reopen/copy behavior, coding CLI creation, session metadata propagation, and the shared reducer boundary.

6. **An existing missing-layout tab renders error UI and does not self-heal**
   Type: regression
   Disposition: extend
   Harness: Vitest with `TabContent.test.tsx`, `PaneLayout.test.tsx`, and `layout-mirror-middleware.test.ts`
   Preconditions: a store contains an already-existing pane-backed tab whose layout entry is missing.
   Actions: render `TabContent`, mount `PaneLayout`, and let layout mirroring observe the state.
   Expected outcome: the missing-layout error surface renders, `PaneLayout` does not dispatch `initLayout(...)`, `TabContent` does not trigger `terminal.create` or `addTerminalRestoreRequestId(...)`, and layout mirroring does not invent `fallbackSessionRef` for the corrupted tab. Source of truth: Frozen Decisions 1, 8, and 9, plus Integrity Invariants 3 and 6.
   Interactions: component rendering, missing-layout detection, restore bookkeeping, and mirrored layout export.

7. **Persistence writes one validated combined workspace snapshot or writes nothing**
   Type: invariant
   Disposition: new
   Harness: Vitest with `workspacePersistence.test.ts`, `persistedState.test.ts`, `tabsPersistence.test.ts`, `panesPersistence.test.ts`, and `persistBroadcast.test.ts`
   Preconditions: the store starts with a valid workspace, and a second case starts with a deliberately invalid workspace that violates pane-backed layout integrity.
   Actions: trigger persistence through normal tab and pane mutations, then inspect the authoritative workspace payload, compatibility mirrors, and failure behavior when validation fails.
   Expected outcome: the authoritative combined workspace key contains both `tabs` and `panes` together, the compatibility mirrors are derived from that same validated snapshot, and invalid pane-backed state does not advance persisted authority. Source of truth: Frozen Decisions 4, 6, and 7, plus Integrity Invariants 4 and 5.
   Interactions: localStorage write ordering, broadcast mirroring, validation failure handling, and legacy split-key compatibility.

8. **Bootstrap readers and restore bookkeeping consume the same combined snapshot**
   Type: boundary
   Disposition: new
   Harness: Vitest with `crossTabSync.test.ts`, `storage-migration.test.ts`, `terminal-restore.test.ts`, and `visible-first-audit-seed-browser-storage.test.ts`
   Preconditions: storage contains either the authoritative combined snapshot or legacy split keys, including at least one invalid legacy combination.
   Actions: boot the Redux slices, run restore bookkeeping, and replay cross-tab updates from storage and broadcast events.
   Expected outcome: tabs and panes hydrate from one shared workspace snapshot, legacy split keys are accepted only when the combined key is absent, invalid legacy combinations are reported as corruption instead of being normalized into healthy state, and restore-request IDs are collected from the same loaded snapshot as Redux bootstrap. Source of truth: Frozen Decisions 4, 5, and 10, plus Integrity Invariant 7.
   Interactions: snapshot parsing, migration compatibility, cross-tab dedupe, terminal restore bootstrap, and orphan-layout cleanup.

## Coverage summary

Covered: exact-session restore, ordinary tab switching, reload survival, corrupted no-layout bootstrap, multi-client hydration, shared pane-backed create/restore actions, explicit missing-layout error rendering, atomic persistence, compatibility mirrors, and bootstrap/restore cohesion.

Explicitly excluded: manual QA, screenshot-only approval, and any fallback path that fabricates content for an already-existing missing-layout tab. Those are rejected by the product contract, not accepted as a safety net.

Residual risk: a pure same-window in-memory layout-deletion path that bypasses persistence and cross-tab hydration entirely has not been proven separately here. The browser switch/reload scenarios are intended to catch it if it is reproducible, but if it exists outside those paths it would still need a separate follow-up fix.
