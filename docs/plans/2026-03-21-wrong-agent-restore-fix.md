# Wrong Agent Restore Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every restored coding-agent tab or pane reopen only its own exact session after reload, reconnect, or server restart, while refusing degraded restores that cannot prove exact local identity.

**Architecture:** Use the exact provenance the system already has instead of inventing a new identity layer. Fresh Claude terminals become exact at birth with `--session-id <uuid>`, Codex discovered-session binding becomes exact by parsing the existing shell snapshot for `FRESHELL_TERMINAL_ID`, and the client treats pane-level `sessionRef` as authoritative for restore only when that ref is exact for the provider. Tab-level `resumeSessionId` and no-layout mirrors remain compatibility metadata only and lose ownership authority for restore, open-session lookup, and busy-state ownership.

**Tech Stack:** Node/Express, ws, node-pty, React 18, Redux Toolkit, Zod, Vitest, Playwright

---

## Frozen Decisions

1. `sessionRef` on pane content is the only authoritative persisted coding-session identity on the client, but only when it was derived from an exact provider-specific identifier. `resumeSessionId` remains a compatibility mirror.
2. The server fix uses existing exact launch provenance first. For Codex that means the shell snapshot’s `FRESHELL_TERMINAL_ID`; no new owner-tuple system is introduced.
3. Fresh Claude sessions are exact immediately by launching with `--session-id <uuid>`. Generic same-`cwd` association is removed for Codex and for fresh Claude sessions.
4. `SessionAssociationCoordinator` remains a narrow compatibility path only for providers that still lack exact launch provenance, currently named Claude resume terminals and Opencode. It must not be the generic path for Codex or fresh exact Claude sessions.
5. Restore of a coding pane must wait for `ready.serverInstanceId` and then fail closed unless the pane has a local exact `sessionRef`.
6. Session-open and restore flows that depend on session identity must seed pane layout immediately. Exact live `terminalId` attach may continue to hydrate through `TabContent` because it reattaches by terminal ID, not by guessed session ownership.
7. No-layout tab mirrors (`tab.resumeSessionId`, `fallbackSessionRef`) may remain as compatibility metadata and presentation hints, but they may not drive authoritative restore, open-session lookup, or busy-state ownership.
8. Never synthesize an exact `sessionRef` from a compatibility-only identifier. In particular, human-readable Claude resume names stay compatibility-only until the UUID association arrives.

## User-Visible Contract

- Reloading Freshell must reopen each coding tab or pane into the same session it owned before reload, even when sibling panes share provider and `cwd`.
- Clicking a session that is already open must focus the pane that owns that exact session, not another pane that merely shares `cwd` or tab-level fallback metadata.
- A copied or foreign snapshot must never auto-resume a local coding session unless its `sessionRef` proves it belongs to this server instance.
- If persisted state is too degraded to prove a coding pane’s exact local identity, the pane must stay inert and print `[Restore blocked: exact session identity missing]` instead of restoring the wrong session.
- Fresh Claude and Codex creation, same-server live `terminalId` attach, and explicit user-initiated session opens must continue to work.

## File Map

**Create**

- `server/coding-cli/codex-shell-snapshot.ts` — parse Codex shell snapshot provenance for exact launch identity.
- `server/discovered-session-association.ts` — exact discovered-session association helper with watermarks for Codex.
- `src/lib/exact-session-ref.ts` — provider-aware helper for deciding when a `sessionRef` is truly exact and safe to synthesize.
- `src/store/persisted-pane-migration.ts` — shared legacy pane migration to authoritative `sessionRef`.
- `test/unit/server/coding-cli/codex-shell-snapshot.test.ts` — Codex shell snapshot parsing coverage.
- `test/unit/server/discovered-session-association.test.ts` — exact discovered-session binding coverage.
- `test/unit/client/lib/exact-session-ref.test.ts` — client exact-session helper coverage.
- `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts` — browser reload regression for exact session restore.

**Modify**

- `server/spawn-spec.ts`
- `server/terminal-registry.ts`
- `server/ws-handler.ts`
- `server/index.ts`
- `server/session-association-coordinator.ts`
- `server/coding-cli/types.ts`
- `server/coding-cli/providers/codex.ts`
- `server/coding-cli/session-indexer.ts`
- `src/lib/session-type-utils.ts`
- `src/store/tabsSlice.ts`
- `src/lib/ui-commands.ts`
- `src/components/terminal-view-utils.ts`
- `src/components/TerminalView.tsx`
- `src/components/TabContent.tsx`
- `src/components/TabsView.tsx`
- `src/store/persistedState.ts`
- `src/store/persistMiddleware.ts`
- `src/store/panesSlice.ts`
- `src/lib/terminal-restore.ts`
- `src/lib/tab-registry-snapshot.ts`
- `src/lib/session-utils.ts`
- `src/lib/pane-activity.ts`
- `src/components/panes/PaneContainer.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`
- `src/store/types.ts`

**Tests**

- `test/unit/client/store/tabsSlice.test.ts`
- `test/unit/client/ui-commands.test.ts`
- `test/unit/client/store/persistedState.test.ts`
- `test/unit/client/store/panesPersistence.test.ts`
- `test/unit/client/store/crossTabSync.test.ts`
- `test/unit/client/store/panesSlice.test.ts`
- `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- `test/unit/client/components/TabContent.test.tsx`
- `test/unit/client/components/TabsView.test.tsx`
- `test/unit/client/lib/exact-session-ref.test.ts`
- `test/unit/client/lib/tab-registry-snapshot.test.ts`
- `test/unit/lib/terminal-restore.test.ts`
- `test/unit/client/lib/session-utils.test.ts`
- `test/unit/client/lib/pane-activity.test.ts`
- `test/unit/client/components/ContextMenuProvider.test.tsx`
- `test/unit/client/components/panes/PaneContainer.test.tsx`
- `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- `test/e2e/sidebar-click-opens-pane.test.tsx`
- `test/e2e/replace-pane.test.tsx`
- `test/e2e/tabs-view-flow.test.tsx`
- `test/unit/server/terminal-registry.test.ts`
- `test/unit/server/coding-cli/session-indexer.test.ts`
- `test/unit/server/coding-cli/codex-shell-snapshot.test.ts`
- `test/unit/server/discovered-session-association.test.ts`
- `test/unit/server/session-association-coordinator.test.ts`
- `test/unit/server/terminal-registry.findRunningTerminal.test.ts`
- `test/server/session-association.test.ts`
- `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- `test/server/ws-terminal-create-session-repair.test.ts`
- `test/integration/server/codex-session-rebind-regression.test.ts`

## Strategy Gate

Why this is the right fix:

- The browser-visible bug is a combination of two independent failures: wrong session identity can enter a pane early on the server, and stale tab-level fallback can later restore the wrong thing. Fixing only one side is incomplete.
- The previous plan overreached by inventing a new owner tuple even though Codex already writes exact launch provenance into `shell_snapshots` and Freshell already exports `FRESHELL_TERMINAL_ID`, `FRESHELL_TAB_ID`, and `FRESHELL_PANE_ID`.
- The client already has `sessionRef`, `serverInstanceId`, and pane-level persistence. The missing work is to seed exact `sessionRef` at ingress, preserve it through hydrate, gate restore on it, and stop letting no-layout tab mirrors pretend to own sessions.
- Any place that fabricates `sessionRef` from `resumeSessionId` has to use one provider-aware exactness rule. If that rule is not centralized, named Claude resumes and copied tab snapshots will silently reintroduce fake “exact” identity.
- A browser regression has to lead the work. This is a user-visible restore bug, so the highest-fidelity failure needs to exist before implementation starts and go green in the first client task.

Why not these alternatives:

- Do not patch same-`cwd` association with more heuristics. Exact launch provenance already exists for Codex, and fresh Claude can be exact at birth.
- Do not trust bare migrated `resumeSessionId` for restore or copy flows. That keeps stale-tab and foreign-snapshot corruption alive.
- Do not invent a new durable owner tuple unless existing exact provenance proves insufficient during implementation. It is extra state, extra routes, and extra failure surface with no evidence that it is needed.

Acceptance proof for this plan:

1. The new browser regression proves two persisted same-`cwd` coding tabs reload without cross-swapping sessions.
2. The browser regression also proves a degraded no-layout coding tab blocks restore instead of guessing.
3. Codex discovered-session association binds by exact launch provenance, not oldest same-`cwd` terminal.
4. Fresh Claude terminals are exact immediately and still resume/reuse correctly.
5. Existing compatibility association for providers that still lack exact launch provenance remains intact, especially Opencode and named Claude resume.
6. `npm run lint`, the browser regression, and `npm test` are green.

### Task 1: Write The Browser Repro First And Make Client Restore Exact

**Files:**
- Create: `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts`
- Create: `src/store/persisted-pane-migration.ts`
- Modify: `src/lib/session-type-utils.ts`
- Create: `src/lib/exact-session-ref.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/lib/ui-commands.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/components/terminal-view-utils.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/TabContent.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/lib/terminal-restore.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Test: `test/unit/client/store/tabsSlice.test.ts`
- Test: `test/unit/client/ui-commands.test.ts`
- Test: `test/unit/client/store/persistedState.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`
- Test: `test/unit/client/store/crossTabSync.test.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/unit/client/components/TabContent.test.tsx`
- Test: `test/unit/client/components/TabsView.test.tsx`
- Test: `test/unit/client/lib/exact-session-ref.test.ts`
- Test: `test/unit/client/lib/tab-registry-snapshot.test.ts`
- Test: `test/unit/lib/terminal-restore.test.ts`
- Test: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Test: `test/e2e/tabs-view-flow.test.tsx`
- Test: `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts`

- [ ] **Step 1: Write the failing browser and client tests**

Add the browser regression with two cases:

1. Use `page.addInitScript()` plus manual `page.goto()`/harness setup (not the auto-navigating `freshellPage` fixture) so the spec can seed `freshell.tabs.v2` and `freshell.panes.v2` before bootstrap. Seed two same-`cwd` coding tabs whose panes already carry distinct exact `sessionRef` values. Reload, switch tabs, and assert outbound `terminal.create` messages use the correct session for each tab and never cross-swap.
2. Seed a degraded no-layout coding tab with bare `resumeSessionId`, no pane layout, and coding mode. Assert reload does not restore the wrong session and the steady-state output becomes:

```text
[Restore blocked: exact session identity missing]
```

Extend the client tests to prove:

- `openSessionTab()` seeds pane layout immediately for PTY-backed coding sessions
- exact local session opens seed `sessionRef` only when the provider/session identifier is exact and `connection.serverInstanceId` is known
- named Claude resume values remain compatibility-only and never get synthesized into an exact `sessionRef` before UUID association
- `ui.command tab.create` and `ui.command pane.attach` preserve `createRequestId` and synthesize `sessionRef` only through the shared exactness helper
- persisted raw parse and cached pane load share one legacy coding-pane migration helper and preserve any existing `sessionRef`
- hydrate preserves the local exact `sessionRef` when incoming state with the same `createRequestId` omits it or conflicts with it
- restore waits for `ready.serverInstanceId` before deciding whether a pane is local
- restore of a coding pane only resumes when `sessionRef.serverInstanceId === localServerInstanceId`
- a foreign or legacy-migrated `sessionRef` never falls back to bare `resumeSessionId`
- `terminal.created` persists `sessionRef` from `effectiveResumeSessionId + localServerInstanceId`
- degraded no-layout coding restore reuses `tab.createRequestId` and prints the blocked-restore message instead of minting a fresh identity
- tab registry snapshots and TabsView copy/reopen flows preserve explicit exact `sessionRef`, but never fabricate one from a non-exact identifier such as a human-readable Claude resume name

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts test/unit/client/ui-commands.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/lib/exact-session-ref.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/lib/terminal-restore.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/tabs-view-flow.test.tsx
```

Expected: FAIL because exact `sessionRef` is not seeded consistently at client ingress, named Claude resumes can still masquerade as exact identity in some client paths, persisted migration is duplicated, PTY-backed `openSessionTab()` still creates no-layout tabs, restore still trusts degraded fallback state, copied tab snapshots can still fabricate exact-looking identity, and the browser regression can still drive the wrong restore behavior.

- [ ] **Step 3: Implement exact client ingress, migration, and restore gating**

Implementation rules:

- `src/lib/exact-session-ref.ts` owns the one provider-aware rule for exact session identity. It returns an exact `sessionRef` only when the identifier is exact for that provider:

```ts
buildExactSessionRef({ provider, sessionId, serverInstanceId })
```

- Named Claude resume values are never exact. They keep `resumeSessionId` only until the UUID association arrives.

- `buildResumeContent()` accepts optional exact session identity:

```ts
sessionRef: buildExactSessionRef({ provider, sessionId, serverInstanceId: localServerInstanceId })
```

- `openSessionTab()` must immediately `initLayout()` for PTY-backed coding sessions, not rely on no-layout fallback later.
- `handleUiCommand()` must preserve any provided `createRequestId`; when a server-originated coding pane has `mode + resumeSessionId`, synthesize `sessionRef` only through `buildExactSessionRef(getState().connection.serverInstanceId)`.
- `src/store/persisted-pane-migration.ts` owns shared legacy coding-pane normalization for both raw parsing and cached load. It preserves an existing `sessionRef`, normalizes mirrored `resumeSessionId`, and only synthesizes a new exact local `sessionRef` when the caller already knows `localServerInstanceId`.
- `panesSlice` hydrate merge keeps the local `sessionRef` authoritative and rewrites the mirrored `resumeSessionId` to `sessionRef.sessionId` when needed.
- `tab-registry-snapshot.ts` and `TabsView.tsx` must use the same exactness helper. They may preserve an explicit exact `sessionRef`, but they must not fabricate one from non-exact compatibility identifiers.
- Replace the resume helper with a restore-aware decision:

```ts
getResumeTarget({
  restore,
  mode,
  sessionRef,
  mirroredResumeSessionId,
  localServerInstanceId,
})
```

- `restore === false`: explicit local actions may still use the mirrored `resumeSessionId`.
- `restore === true` and `mode !== 'shell'`: only allow resume when `sessionRef` exists and `sessionRef.serverInstanceId === localServerInstanceId`.
- If `restore === true` and local server identity is not known yet, do not send `terminal.create` yet.
- If exact local identity cannot be proven, clear stale `terminalId`, keep `sessionRef` as metadata, mark the pane errored, and write `[Restore blocked: exact session identity missing]`.
- On `terminal.created`, when `effectiveResumeSessionId` exists for a coding pane, persist both:

```ts
sessionRef: buildExactSessionRef({ provider: mode, sessionId: effectiveResumeSessionId, serverInstanceId: localServerInstanceId })
resumeSessionId: effectiveResumeSessionId
```

- `TabContent` degraded no-layout coding restore must reuse `tab.createRequestId`, call `addTerminalRestoreRequestId(tab.createRequestId)`, and never mint a new coding identity.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/specs/terminal-exact-session-identity.spec.ts src/lib/exact-session-ref.ts src/store/persisted-pane-migration.ts src/lib/session-type-utils.ts src/store/tabsSlice.ts src/lib/ui-commands.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/panesSlice.ts src/components/terminal-view-utils.ts src/components/TerminalView.tsx src/components/TabContent.tsx src/components/TabsView.tsx src/lib/tab-registry-snapshot.ts src/lib/terminal-restore.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/ui-commands.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/lib/exact-session-ref.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/lib/terminal-restore.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/tabs-view-flow.test.tsx
git commit -m "feat: make client restore use exact session identity"
```

### Task 2: Make Live Session Binding Exact Using Existing Launch Provenance

**Files:**
- Create: `server/coding-cli/codex-shell-snapshot.ts`
- Create: `server/discovered-session-association.ts`
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/codex.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Modify: `server/session-association-coordinator.ts`
- Test: `test/unit/server/terminal-registry.test.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`
- Test: `test/unit/server/coding-cli/codex-shell-snapshot.test.ts`
- Test: `test/unit/server/discovered-session-association.test.ts`
- Test: `test/unit/server/session-association-coordinator.test.ts`
- Test: `test/unit/server/terminal-registry.findRunningTerminal.test.ts`
- Test: `test/server/session-association.test.ts`
- Test: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Test: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Test: `test/server/ws-terminal-create-session-repair.test.ts`
- Test: `test/integration/server/codex-session-rebind-regression.test.ts`

- [ ] **Step 1: Write the failing exact-binding tests**

Add tests proving:

- fresh Claude launch uses `--session-id <uuid>` when no UUID `resumeSessionId` was supplied
- `terminal.created` returns that new exact UUID as `effectiveResumeSessionId`
- Codex shell snapshot parsing accepts both `shell_snapshots/<sessionId>.sh` and `shell_snapshots/<sessionId>.*.sh`, preferring the newest matching file
- exact discovered Codex association binds by snapshot `FRESHELL_TERMINAL_ID`, not oldest same-`cwd` terminal
- repeated index updates preserve the original exact Codex owner
- if a Codex session first appears before its shell snapshot is available, Freshell leaves it unbound on that pass and binds it exactly on a later advanced update when launch provenance appears, never by same-`cwd` fallback
- `SessionAssociationCoordinator` no longer handles Codex, while named Claude resume and Opencode stay on the compatibility path until they have exact provenance
- `SessionAssociationCoordinator` unit coverage explicitly proves named Claude resume stays eligible while exact Codex and fresh exact Claude do not
- existing Opencode same-`cwd` association coverage stays green as an explicit non-regression

Target Codex launch-origin shape:

```ts
launchOrigin: {
  terminalId: 'term-2',
  tabId: 'tab-2',
  paneId: 'pane-2',
}
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/terminal-registry.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-shell-snapshot.test.ts test/unit/server/discovered-session-association.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/codex-session-rebind-regression.test.ts
```

Expected: FAIL because fresh Claude is not exact at birth, Codex sessions have no parsed launch provenance, the compatibility coordinator still accepts providers that should be exact, and discovered binding still uses generic same-`cwd` association.

- [ ] **Step 3: Implement exact live-session binding**

Implementation rules:

- `server/spawn-spec.ts` adds explicit fresh Claude launch args:

```ts
launchArgs: (sessionId) => ['--session-id', sessionId]
resumeArgs: (sessionId) => ['--resume', sessionId]
```

- `terminal-registry.create()` allocates a UUID up front for fresh Claude terminals, binds it immediately, and exposes it as `record.resumeSessionId`.
- `ws-handler` must send `record.resumeSessionId ?? effectiveResumeSessionId` in `terminal.created`, so fresh Claude creates return the exact UUID that was just allocated.
- `server/coding-cli/codex-shell-snapshot.ts` parses `FRESHELL_TERMINAL_ID`, `FRESHELL_TAB_ID`, and `FRESHELL_PANE_ID` from the newest matching shell snapshot.
- `CodingCliSession.launchOrigin` is populated from Codex shell snapshots and carried through the session indexer.
- `server/discovered-session-association.ts` owns exact Codex watermarking and binding by `launchOrigin.terminalId`.
- If a Codex session has not yet gained launch provenance, exact association must leave it unbound and retry on later advanced index updates; it must never fall back to same-`cwd` guessing.
- `server/index.ts` uses exact discovered association for Codex sessions, stops routing Codex through same-`cwd` association, and keeps providers without exact provenance on the compatibility path.
- `server/session-association-coordinator.ts` remains compatibility code for providers without exact provenance, currently named Claude resume terminals and Opencode. It must not handle Codex or fresh exact Claude sessions.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-shell-snapshot.ts server/discovered-session-association.ts server/coding-cli/types.ts server/coding-cli/providers/codex.ts server/coding-cli/session-indexer.ts server/terminal-registry.ts server/ws-handler.ts server/index.ts server/session-association-coordinator.ts test/unit/server/terminal-registry.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-shell-snapshot.test.ts test/unit/server/discovered-session-association.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/codex-session-rebind-regression.test.ts
git commit -m "feat: bind discovered coding sessions by exact provenance"
```

### Task 3: Remove No-Layout Coding Ownership Leaks And Clear Stale Tab Mirrors

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/lib/pane-activity.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/store/types.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`
- Test: `test/unit/client/lib/pane-activity.test.ts`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Test: `test/e2e/replace-pane.test.tsx`

- [ ] **Step 1: Write the failing no-layout ownership tests**

Add tests proving:

- `findTabIdForSession()` and `findPaneForSession()` ignore no-layout coding tab mirrors
- compatibility metadata like `fallbackSessionRef` may remain, but exact-session focus/open lookup still comes only from layout-backed coding panes
- busy indicators come only from layout-backed coding panes, not from no-layout tab metadata
- closing or replacing the owning pane clears stale `tab.resumeSessionId`

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/session-utils.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/replace-pane.test.tsx
```

Expected: FAIL because no-layout coding tabs still advertise ownership through tab-only metadata, busy ownership still consults degraded tab state, and stale `tab.resumeSessionId` survives pane cleanup.

- [ ] **Step 3: Implement no-layout authority removal and mirror cleanup**

Implementation rules:

- `collectSessionLocatorsFromTabs()` and other session lookup helpers must ignore tab-only coding metadata when no layout exists.
- compatibility metadata such as `fallbackSessionRef` may remain for presentation and server sync, but it must not affect authoritative restore/open-session lookup or busy ownership.
- `pane-activity` must stop deriving busy-session ownership from no-layout coding tab mirrors.
- `PaneContainer` and `ContextMenuProvider` must clear `tab.resumeSessionId` whenever the surviving layout no longer contains that exact coding session.
- Update the `Tab.resumeSessionId` comment to document that it is compatibility metadata only, not authoritative ownership.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/session-utils.ts src/lib/pane-activity.ts src/components/panes/PaneContainer.tsx src/components/context-menu/ContextMenuProvider.tsx src/store/types.ts test/unit/client/lib/session-utils.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/replace-pane.test.tsx
git commit -m "feat: remove no-layout coding session ownership leaks"
```

### Task 4: Run Final Verification

**Files:**
- Modify: `test/e2e-browser/helpers/fixtures.ts` only if a tiny helper is still needed after earlier tasks; otherwise keep the working tree clean

- [ ] **Step 1: Run the browser acceptance regression**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
```

Expected: PASS

- [ ] **Step 2: Run focused server verification**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/terminal-registry.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-shell-snapshot.test.ts test/unit/server/discovered-session-association.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/codex-session-rebind-regression.test.ts
```

Expected: PASS

- [ ] **Step 3: Run focused client verification**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts test/unit/client/ui-commands.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/lib/exact-session-ref.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/lib/terminal-restore.test.ts test/unit/client/lib/session-utils.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/replace-pane.test.tsx test/e2e/tabs-view-flow.test.tsx
npm run lint
```

Expected: PASS

- [ ] **Step 4: Run the coordinated full suite**

Run:

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="wrong-agent-restore exact identity" npm test
```

Expected: `test:status` shows the coordinator state clearly, and `npm test` passes once the coordinated run starts.

- [ ] **Step 5: Commit only if Step 1-4 required final helper edits**

```bash
git status --short
git add test/e2e-browser/helpers/fixtures.ts
git commit -m "test: finalize exact session restore regression"
```
