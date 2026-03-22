# Wrong Agent Restore Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every restored coding-agent tab or pane reopen only its own exact session after reload, reconnect, or server restart, and refuse ambiguous degraded-state restores instead of guessing.

**Architecture:** Treat pane-local `sessionRef` as the only authoritative coding-session identity on the client and persist one durable owner tuple `{tabId, paneId, createRequestId}` on every PTY-backed coding terminal on the server. Replace discovered same-`cwd` session binding with exact provenance: fresh Claude is exact at birth, fresh Codex becomes exact only when indexed shell-snapshot provenance matches the durable owner tuple, and restore paths fail closed unless the client can prove the session is exact and local.

**Tech Stack:** Node/Express, ws, node-pty, React 18, Redux Toolkit, Zod, Vitest, Playwright

---

## Frozen Decisions

1. `sessionRef` on pane content is the only authoritative coding-session identity on the client. Bare `resumeSessionId` remains a compatibility mirror only.
2. Every PTY-backed coding terminal record stores one durable owner tuple `{tabId, paneId, createRequestId}`. Child-process Freshell env exports are derived from that stored tuple, not from transient request payloads.
3. Provider + `cwd` + age-window discovered-session association is removed for exactable sessions. Exact provenance or no bind.
4. Fresh Claude terminals are exact at birth via `--session-id <uuid>`. Non-UUID Claude named resumes stay a narrow compatibility case and must never reuse generic same-`cwd` matching.
5. Fresh Codex terminals are not exact until indexed launch provenance from `shell_snapshots/<sessionId>.sh` matches the durable owner tuple exactly.
6. Restore of a coding pane must wait until the client knows `ready.serverInstanceId`, then fail closed unless `sessionRef.serverInstanceId === localServerInstanceId`. Legacy migrated refs without a server id are metadata only and may not authorize restore.
7. Same-server live attach by `terminalId` stays supported and remains separate from discovered session ownership.
8. Tab-level mirrors (`tab.resumeSessionId`, `tab.terminalId`, `fallbackSessionRef`) may remain as compatibility metadata, but they may not drive authoritative coding-session restore, lookup, open-session advertising, or busy-state ownership when pane layout is absent.
9. PTY-backed coding-session tabs must be born with pane layout immediately. A no-layout coding tab is a degraded restore case only.
10. Protocol cutover is double-read/double-write inside the same landing: exactness comes from `sessionRef`, while legacy fields (`effectiveResumeSessionId`, bare `sessionId`) stay as optional mirrors until all client paths consume `sessionRef`.

## User-Visible Contract

- Reloading Freshell must reopen each coding tab or pane into the same session it owned before reload, even when sibling panes share provider and `cwd`.
- Clicking a session that is already open must focus the pane that owns that exact session, not another pane that merely shares `cwd` or tab-level fallback metadata.
- A copied or foreign snapshot must never auto-resume a local coding session unless its `sessionRef` proves it belongs to this server instance.
- If persisted state is too degraded to prove a coding pane’s exact local identity, the pane must stay inert and print `[Restore blocked: exact session identity missing]` instead of restoring the wrong session.
- Fresh Claude and Codex creation, same-server `terminalId` reattach, and explicit user-initiated session opens must continue to work.

## Critical Invariants

- `createRequestId` is the stable logical create identity from pane content to `terminal.create` to server owner tuple to child-process env. It must not be regenerated except when the pane intentionally starts a new terminal after `INVALID_TERMINAL_ID`.
- `TerminalRecord.owner*` is immutable for that terminal’s lifetime. Repair may move a session binding to a different terminal, but it does not mutate a terminal’s owner tuple.
- `sessionRef` outranks `resumeSessionId` everywhere. If they disagree, preserve `sessionRef` and rewrite or clear the mirror.
- Cross-tab hydrate may not downgrade a pane from an exact local `sessionRef` to a bare mirrored `resumeSessionId`.
- No-layout coding tabs may render UI affordances, but they may not claim session ownership, advertise an open session, or auto-resume from tab-only mirrors.
- Named Claude resume compatibility, if still needed after Task 3, must be scoped only to `pendingResumeName` terminals. No other path may match by `cwd`.

## Non-Goals

- Do not redesign overall layout persistence beyond removing coding-session authority from degraded no-layout fallback.
- Do not introduce managed per-pane CLI homes or any other heavyweight isolation model.
- Do not change shell-mode restore semantics.
- Do not add new heuristics to replace the deleted same-`cwd` association path.
- Do not update `docs/index.html` unless implementation grows beyond the terminal output message into a new dedicated UI surface.

## File Map

**Create**

- `server/terminal-owner.ts` — durable owner tuple helpers for PTY-backed coding terminals.
- `server/discovered-session-association.ts` — exact discovered-session association policy and watermarking.
- `server/coding-cli/codex-shell-snapshot.ts` — parse Codex shell snapshot launch provenance.
- `src/store/persisted-pane-migration.ts` — shared migration helpers for persisted pane trees and legacy `resumeSessionId` -> `sessionRef`.
- `test/unit/server/coding-cli/codex-shell-snapshot.test.ts` — shell snapshot provenance parsing coverage.
- `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts` — real-browser reload regression for exact session restore.

**Delete**

- `server/session-association-coordinator.ts` — heuristic same-`cwd` association coordinator; its remaining useful behavior moves into exact discovered association.

**Modify**

- `shared/ws-protocol.ts` — exact lifecycle message contract with `sessionRef` and compatibility mirrors.
- `server/spawn-spec.ts` — fresh Claude `--session-id` support.
- `server/terminal-registry.ts` — owner persistence, exact reuse, exact discovered bind and repair.
- `server/ws-handler.ts` — owner-aware create/reuse wiring and exact lifecycle broadcasts.
- `server/index.ts` — remove heuristic association and use exact discovered-session association.
- `server/coding-cli/types.ts` — `SessionLaunchOrigin` / `launchOrigin` support.
- `server/coding-cli/providers/codex.ts` — read launch provenance from shell snapshots.
- `server/coding-cli/session-indexer.ts` — carry `launchOrigin` through indexed session projection.
- `server/agent-api/router.ts` — allocate stable `createRequestId` and owner tuple on all PTY create routes.
- `src/components/terminal-view-utils.ts` — exact restore eligibility helpers.
- `src/components/TerminalView.tsx` — restore gate, exact `sessionRef` persistence, restore-blocked output.
- `src/components/TabContent.tsx` — degraded no-layout coding restore only, with existing `createRequestId`.
- `src/components/TabBar.tsx` — presentation-only fallback synthesis for no-layout tabs; no session ownership leak.
- `src/store/tabsSlice.ts` — initialize layout immediately for PTY-backed coding session tabs.
- `src/store/persistedState.ts` — use shared pane migration during raw persisted-state parsing.
- `src/store/persistMiddleware.ts` — use shared pane migration during cached load/persist bootstrap.
- `src/store/panesSlice.ts` — preserve authoritative `sessionRef` during hydrate merges.
- `src/lib/terminal-restore.ts` — register degraded no-layout restore request ids explicitly.
- `src/lib/session-utils.ts` — exact-pane session lookup only.
- `src/store/layoutMirrorMiddleware.ts` — stop advertising no-layout coding ownership.
- `src/store/selectors/sidebarSelectors.ts` — stop treating no-layout coding tabs as authoritative open sessions.
- `src/lib/pane-activity.ts` — stop deriving busy session ownership from no-layout coding tab mirrors.
- `src/components/panes/PaneContainer.tsx` — symmetric stale mirror cleanup when the owning pane disappears.
- `src/components/context-menu/ContextMenuProvider.tsx` — symmetric stale mirror cleanup on close and replace paths.
- `src/store/types.ts` — document compatibility-only semantics of tab-level mirrors.

**Tests**

- `test/server/session-association.test.ts`
- `test/server/agent-tabs-write.test.ts`
- `test/server/agent-panes-write.test.ts`
- `test/server/ws-protocol.test.ts`
- `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- `test/server/ws-terminal-create-session-repair.test.ts`
- `test/unit/server/terminal-registry.test.ts`
- `test/unit/server/terminal-env.test.ts`
- `test/unit/server/spawn-spec.test.ts`
- `test/unit/server/coding-cli/session-indexer.test.ts`
- `test/unit/client/store/persistedState.test.ts`
- `test/unit/client/store/panesPersistence.test.ts`
- `test/unit/client/store/crossTabSync.test.ts`
- `test/unit/client/store/panesSlice.test.ts`
- `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- `test/unit/client/components/TabContent.test.tsx`
- `test/unit/client/components/TabBar.test.tsx`
- `test/unit/client/lib/terminal-restore.test.ts`
- `test/unit/client/lib/session-utils.test.ts`
- `test/unit/client/lib/pane-activity.test.ts`
- `test/unit/client/layout-mirror-middleware.test.ts`
- `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- `test/e2e/sidebar-click-opens-pane.test.tsx`
- `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- `test/e2e/replace-pane.test.tsx`

## Strategy Gate

Why this is the right fix:

- Fixing only stale tab mirrors would still leave early wrong association, which is one of the two proven systemic sources.
- Fixing only server association would still let degraded tab-only restore, lookup, and busy-state code attach a valid session to the wrong place.
- Terminal identity cannot live on `terminalId`; that id dies across restart. The right persistent identity is `{provider, sessionId, serverInstanceId}` on the pane and `{tabId, paneId, createRequestId}` on the live terminal.
- The codebase already has most of the right primitives: panes already carry `sessionRef`, `terminal.create` already carries `tabId` and `paneId`, and the server already exports Freshell env vars. The missing pieces are durable owner persistence, exact discovery, and a fail-closed restore policy.
- Extracting shared persisted-pane migration is worth the extra file because exact identity must be migrated the same way for initial load, cached load, `terminal-restore`, and cross-tab sync. Duplicating that logic again would recreate the same class of divergence.

Why not these alternatives:

- Do not patch the old same-`cwd` coordinator with more heuristics. It is ambiguous by design.
- Do not trust migrated legacy `resumeSessionId` alone for restore. That would keep cross-device and stale-tab corruption paths alive.
- Do not leave PTY-backed `openSessionTab()` as a no-layout path. That keeps the bug alive in brand-new tabs, not just old persisted ones.

Acceptance proof for this plan:

1. Two coding panes with the same provider and the same `cwd` reload without cross-swapping sessions.
2. A degraded no-layout coding tab cannot auto-resume a session from tab-only mirrors.
3. Fresh Claude and Codex creation still work.
4. Same-server live `terminalId` attach still works.
5. `npm run lint`, the new Playwright regression, and `npm test` are green.

### Task 1: Persist Durable Owner Identity On Every PTY Create Path

**Files:**
- Create: `server/terminal-owner.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/agent-api/router.ts`
- Test: `test/unit/server/terminal-registry.test.ts`
- Test: `test/unit/server/terminal-env.test.ts`
- Test: `test/server/agent-tabs-write.test.ts`
- Test: `test/server/agent-panes-write.test.ts`

- [ ] **Step 1: Write the failing owner-persistence tests**

Add tests proving that PTY-backed coding terminal creation stores one exact owner tuple and exports it to the child environment.

```ts
expect(record.ownerTabId).toBe('tab-1')
expect(record.ownerPaneId).toBe('pane-1')
expect(record.ownerCreateRequestId).toBe('req-1')
expect(env.FRESHELL_CREATE_REQUEST_ID).toBe('req-1')
```

Extend the HTTP route tests so `/api/tabs`, `/api/run`, `/panes/:id/split`, and `/panes/:id/respawn` each:

- allocate exactly one `createRequestId`
- pass the same tuple into `registry.create()`
- emit pane content carrying that same `createRequestId`

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/terminal-registry.test.ts test/unit/server/terminal-env.test.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts
```

Expected: FAIL because `TerminalRecord` does not persist owner identity, `FRESHELL_CREATE_REQUEST_ID` is absent, and HTTP create routes do not keep one stable `createRequestId`.

- [ ] **Step 3: Implement the durable owner tuple**

Create `server/terminal-owner.ts`:

```ts
export type TerminalOwnerIdentity = {
  tabId: string
  paneId: string
  createRequestId: string
}
```

Then wire it through:

```ts
registry.create({
  mode,
  shell,
  cwd,
  resumeSessionId,
  owner: { tabId, paneId, createRequestId },
})
```

Implementation rules:

- `TerminalRegistry.create()` accepts `owner?: TerminalOwnerIdentity`.
- `TerminalRecord` persists `ownerTabId`, `ownerPaneId`, and `ownerCreateRequestId`.
- Child-process env is derived from the persisted owner tuple:

```ts
FRESHELL_TAB_ID
FRESHELL_PANE_ID
FRESHELL_CREATE_REQUEST_ID
```

- WS `terminal.create` uses `{ tabId: m.tabId, paneId: m.paneId, createRequestId: m.requestId }`.
- HTTP PTY create routes allocate `createRequestId = nanoid()` once and reuse it for both pane content and `registry.create()`.
- `/panes/:id/attach` stays attach-only and does not invent session ownership.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/terminal-owner.ts server/terminal-registry.ts server/ws-handler.ts server/agent-api/router.ts test/unit/server/terminal-registry.test.ts test/unit/server/terminal-env.test.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts
git commit -m "feat: persist exact pane ownership on terminals"
```

### Task 2: Make Fresh Claude Exact At Birth And Carry Exact `sessionRef` Through Terminal Lifecycle

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/spawn-spec.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Test: `test/unit/server/spawn-spec.test.ts`
- Test: `test/server/ws-protocol.test.ts`
- Test: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Test: `test/server/ws-terminal-create-session-repair.test.ts`

- [ ] **Step 1: Write the failing exact-Claude lifecycle tests**

Add tests proving:

- fresh Claude launch uses `--session-id <uuid>` when no UUID `resumeSessionId` is provided
- `terminal.created` carries exact `sessionRef`
- `terminal.attach.ready` mirrors exact `sessionRef` for reused attaches
- `terminal.session.associated` carries exact `sessionRef`
- repaired or reused Claude terminals keep returning the canonical local `sessionRef`

Target message shape:

```ts
{
  type: 'terminal.created',
  requestId: 'req-1',
  terminalId: 'term-1',
  createdAt: 1,
  sessionRef: {
    provider: 'claude',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    serverInstanceId: 'srv-1',
  },
  effectiveResumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
}
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/spawn-spec.test.ts test/server/ws-protocol.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-session-repair.test.ts
```

Expected: FAIL because fresh Claude still launches without `--session-id`, `terminal.attach.ready` does not carry `sessionRef`, and lifecycle messages still rely on bare IDs.

- [ ] **Step 3: Implement exact-at-birth Claude and exact lifecycle messages**

Update the spawn spec so Claude supports both fresh launch and resume:

```ts
launchArgs: (sessionId) => ['--session-id', sessionId]
resumeArgs: (sessionId) => ['--resume', sessionId]
```

Implementation rules:

- When creating a fresh Claude terminal with no UUID `resumeSessionId`, allocate one UUID up front and store it on the record.
- Do not use `--session-id` for non-UUID named resumes; keep those on `pendingResumeName`.
- `terminal.created` and `terminal.attach.ready` both include `sessionRef` when the terminal has an exact local session.
- `terminal.session.associated` carries `sessionRef` as the authoritative payload.
- Keep `effectiveResumeSessionId` and bare `sessionId` as optional mirrors during the cutover; exactness comes from `sessionRef`.
- `sessionRef.serverInstanceId` is the current server instance id.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/spawn-spec.ts server/terminal-registry.ts server/ws-handler.ts test/unit/server/spawn-spec.test.ts test/server/ws-protocol.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-session-repair.test.ts
git commit -m "feat: make claude terminal lifecycle exact"
```

### Task 3: Replace Heuristic Discovered Binding With Exact Provenance

**Files:**
- Create: `server/discovered-session-association.ts`
- Create: `server/coding-cli/codex-shell-snapshot.ts`
- Delete: `server/session-association-coordinator.ts`
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/codex.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/coding-cli/codex-shell-snapshot.test.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`
- Test: `test/server/session-association.test.ts`
- Test: `test/server/ws-terminal-create-reuse-running-codex.test.ts`

- [ ] **Step 1: Write the failing exact-discovery tests**

Add tests proving:

- Codex session indexing reads launch provenance from `shell_snapshots/<sessionId>.sh`
- discovered-session association binds only when `terminalId` and the full owner tuple match exactly
- the oldest same-`cwd` terminal is no longer a valid tie-breaker
- a poisoned live owner is repaired back to the exact launch terminal
- a missing or partial `launchOrigin` leaves the session unbound
- named Claude compatibility, if still needed, is scoped only to `pendingResumeName`

Target launch-origin shape:

```ts
launchOrigin: {
  terminalId: 'term-2',
  tabId: 'tab-2',
  paneId: 'pane-2',
  createRequestId: 'req-2',
}
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/codex-shell-snapshot.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
```

Expected: FAIL because Codex sessions have no `launchOrigin`, `server/index.ts` still routes through same-`cwd` association, and exact rebind/repair behavior is absent.

- [ ] **Step 3: Implement exact discovered-session association**

Create `server/coding-cli/codex-shell-snapshot.ts` with the only accepted provenance inputs:

```ts
const SNAPSHOT_EXPORTS: Array<[string, keyof SessionLaunchOrigin]> = [
  ['FRESHELL_TERMINAL_ID', 'terminalId'],
  ['FRESHELL_TAB_ID', 'tabId'],
  ['FRESHELL_PANE_ID', 'paneId'],
  ['FRESHELL_CREATE_REQUEST_ID', 'createRequestId'],
]
```

Implementation rules:

- `CodingCliSession.launchOrigin` is complete only when all four fields are present.
- `server/discovered-session-association.ts` owns watermarking and association policy.
- `TerminalRegistry.associateDiscoveredSession()` matches `terminalId` and the full owner tuple before binding.
- If the discovered provenance proves a different running terminal is exact, repair the session owner to that terminal.
- If launch provenance is missing or partial, leave the session unbound.
- `server/index.ts` uses the new exact association helper for both `onUpdate` and `onNewSession`.
- If the named-Claude-resume tests still need compatibility, keep only a narrow `pendingResumeName` shim. Do not restore generic same-`cwd` matching.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A server/discovered-session-association.ts server/coding-cli/codex-shell-snapshot.ts server/session-association-coordinator.ts server/coding-cli/types.ts server/coding-cli/providers/codex.ts server/coding-cli/session-indexer.ts server/terminal-registry.ts server/index.ts test/unit/server/coding-cli/codex-shell-snapshot.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
git commit -m "feat: replace heuristic session binding with exact provenance"
```

### Task 4: Share Persisted Pane Migration And Preserve Exact `sessionRef` Across Hydrate

**Files:**
- Create: `src/store/persisted-pane-migration.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/panesSlice.ts`
- Test: `test/unit/client/store/persistedState.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`
- Test: `test/unit/client/store/crossTabSync.test.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`

- [ ] **Step 1: Write the failing persisted-identity tests**

Add tests proving:

- both `parsePersistedPanesRaw()` and `loadPersistedPanes()` migrate legacy pane `resumeSessionId` to `sessionRef` the same way
- cached load and raw parse agree on `createRequestId` and migrated `sessionRef`
- `hydratePanes()` preserves local `sessionRef` when incoming state with the same `createRequestId` omits it or conflicts with it
- cross-tab sync cannot downgrade an exact local `sessionRef` to a stale remote mirror

Key hydrate expectation:

```ts
expect(content.sessionRef).toEqual({
  provider: 'codex',
  sessionId: 'session-A',
  serverInstanceId: 'srv-local',
})
expect(content.resumeSessionId).toBe('session-A')
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesSlice.test.ts
```

Expected: FAIL because persisted pane migration is duplicated and incomplete, and hydrate preserves only `resumeSessionId`, not authoritative `sessionRef`.

- [ ] **Step 3: Implement shared pane migration and exact hydrate merge**

Create `src/store/persisted-pane-migration.ts` with helpers like:

```ts
export function deriveLegacySessionRef(content: Record<string, unknown>): SessionLocator | undefined
export function migratePersistedPaneContent(content: unknown): unknown
export function migratePersistedPaneTree(node: unknown): unknown
```

Implementation rules:

- `persistedState.ts` and `persistMiddleware.ts` both call the shared migration helpers.
- Legacy terminal panes migrate to:

```ts
{ sessionRef: { provider: mode, sessionId: resumeSessionId } }
```

- Legacy agent-chat panes migrate to:

```ts
{ sessionRef: { provider: 'claude', sessionId: resumeSessionId } }
```

- `mergeTerminalState()` and the agent-chat hydrate path preserve local `sessionRef` when incoming state with the same `createRequestId` omits or conflicts with it.
- When preserving local `sessionRef`, preserve or rewrite the mirrored `resumeSessionId` to `sessionRef.sessionId`.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/persisted-pane-migration.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/panesSlice.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesSlice.test.ts
git commit -m "feat: preserve exact pane identity in persisted state"
```

### Task 5: Gate Coding Restore In `TerminalView` On Exact Local Identity

**Files:**
- Modify: `src/components/terminal-view-utils.ts`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Write the failing restore-gate tests**

Add tests proving:

- restore waits for `ready.serverInstanceId` before deciding whether an exact session is local
- restore of a coding pane only resumes when `sessionRef.serverInstanceId === localServerInstanceId`
- foreign `sessionRef` does not fall back to mirrored `resumeSessionId`
- a migrated legacy `sessionRef` without `serverInstanceId` blocks restore
- `terminal.created`, `terminal.attach.ready`, and `terminal.session.associated` all persist exact `sessionRef` and keep `resumeSessionId` as a mirror only

Blocked restore expectation:

```ts
expect(term.writeln).toHaveBeenCalledWith('\r\n[Restore blocked: exact session identity missing]\r\n')
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because restore still trusts bare `resumeSessionId`, does not wait for `serverInstanceId`, and does not treat `sessionRef` as authoritative on every lifecycle message.

- [ ] **Step 3: Implement the exact restore gate**

Replace the current helper with a restore-aware version:

```ts
getSafeResumeSessionId({
  restore,
  sessionRef,
  mirroredResumeSessionId,
  localServerInstanceId,
})
```

Implementation rules:

- `restore === false`: explicit local user actions may still use `resumeSessionId`.
- `restore === true` and `mode !== 'shell'`: only allow resume when `sessionRef` exists and `sessionRef.serverInstanceId === localServerInstanceId`.
- If `restore === true` and local server identity is not known yet, do not send `terminal.create` yet.
- If exact local identity cannot be proven, clear `terminalId`, clear stale bare `resumeSessionId`, keep `sessionRef` for metadata, mark the pane errored, and write the restore-blocked terminal message.
- On `terminal.created` and `terminal.attach.ready`, consume `sessionRef` as authority and mirror `resumeSessionId = sessionRef.sessionId` only when present.
- On `terminal.session.associated`, write both `sessionRef` and the mirrored `resumeSessionId`.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal-view-utils.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat: gate coding restore on exact local identity"
```

### Task 6: Remove No-Layout Coding Authority And Clear Stale Tab Mirrors Symmetrically

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/components/TabContent.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/lib/terminal-restore.ts`
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/layoutMirrorMiddleware.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/lib/pane-activity.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/store/types.ts`
- Test: `test/unit/client/components/TabContent.test.tsx`
- Test: `test/unit/client/components/TabBar.test.tsx`
- Test: `test/unit/client/lib/terminal-restore.test.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`
- Test: `test/unit/client/lib/pane-activity.test.ts`
- Test: `test/unit/client/layout-mirror-middleware.test.ts`
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Test: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Test: `test/e2e/replace-pane.test.tsx`

- [ ] **Step 1: Write the failing no-layout and stale-mirror tests**

Add tests proving:

- `openSessionTab()` creates pane layout immediately for PTY-backed coding sessions
- `TabContent` rehydrates a degraded no-layout coding tab using the tab’s existing `createRequestId`, not a fresh one
- `terminal-restore` marks that degraded no-layout request id as restore-backed
- `findTabIdForSession()` / `findPaneForSession()` ignore no-layout coding tab mirrors
- `layoutMirrorMiddleware` does not emit `fallbackSessionRef` for no-layout coding tabs
- `sidebarSelectors` and `pane-activity` do not treat no-layout coding tabs as authoritative open or busy sessions
- closing or replacing the owning pane clears stale `tab.resumeSessionId`

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/lib/terminal-restore.test.ts test/unit/client/lib/session-utils.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/replace-pane.test.tsx
```

Expected: FAIL because PTY-backed `openSessionTab()` still creates no-layout tabs, no-layout coding tabs still advertise fallback ownership, and stale `tab.resumeSessionId` survives pane cleanup.

- [ ] **Step 3: Implement the no-layout authority cutover**

Implementation rules:

- `openSessionTab()` must immediately `initLayout()` for PTY-backed coding sessions.

```ts
dispatch(addTab({ id: tabId, createRequestId: requestId, ... }))
dispatch(initLayout({ tabId, content: desiredResumeContent }))
```

- `TabContent` may still synthesize a terminal for a no-layout coding tab, but only as a degraded restore path using `tab.createRequestId`. It must call `addTerminalRestoreRequestId(tab.createRequestId)` before that pane mounts so `TerminalView` treats it as restore, not as a fresh session.
- `TabBar` fallback synthesis for no-layout tabs is presentation-only. It must not synthesize session-owning metadata that feeds context menus or open-session lookup.
- `findTabIdForSession()`, `findPaneForSession()`, sidebar selectors, layout mirror sync, and busy-session collection must ignore tab-only coding metadata when no layout exists.
- `PaneContainer` and `ContextMenuProvider` must clear `tab.resumeSessionId` whenever the surviving layout no longer contains that exact coding session.
- `tab.resumeSessionId` remains useful as compatibility metadata for a single-pane live tab, but it is never authoritative once layout is absent or changed.

- [ ] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/tabsSlice.ts src/components/TabContent.tsx src/components/TabBar.tsx src/lib/terminal-restore.ts src/lib/session-utils.ts src/store/layoutMirrorMiddleware.ts src/store/selectors/sidebarSelectors.ts src/lib/pane-activity.ts src/components/panes/PaneContainer.tsx src/components/context-menu/ContextMenuProvider.tsx src/store/types.ts test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/lib/terminal-restore.test.ts test/unit/client/lib/session-utils.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/replace-pane.test.tsx
git commit -m "feat: remove no-layout coding session authority"
```

### Task 7: Add The Browser Reload Regression And Run Final Verification

**Files:**
- Create: `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts`
- Modify: `test/e2e-browser/helpers/fixtures.ts` only if a tiny helper materially reduces duplication; otherwise keep the spec self-contained

- [ ] **Step 1: Write the failing browser regression**

Add a Playwright spec with two cases:

1. Seed `freshell.tabs.v2` and `freshell.panes.v2` before `goto()` with two same-`cwd` coding panes that have distinct exact `sessionRef` values and mirrored `resumeSessionId` values. After reload and tab switching, assert the outbound `terminal.create` messages use the correct session per tab and never cross-swap.
2. Seed a degraded no-layout coding tab in `freshell.tabs.v2` with bare `resumeSessionId`, a coding mode, and no pane layout. Assert no wrong restore happens: either no restore-time `terminal.create` is sent for that tab, or the pane mounts and prints the restore-blocked message before any attach to the wrong session. The expected steady-state user-visible output is:

```text
[Restore blocked: exact session identity missing]
```

Use `page.addInitScript()` to seed storage before `page.goto()` and `window.__FRESHELL_TEST_HARNESS__.getSentWsMessages()` to inspect create messages.

- [ ] **Step 2: Run the browser regression to verify failure**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
```

Expected: FAIL because reload still trusts degraded fallback or cross-swaps same-`cwd` coding panes.

- [ ] **Step 3: Run the browser regression and focused suites to verify pass**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
npm run test:vitest -- --config vitest.server.config.ts test/server/session-association.test.ts test/server/ws-protocol.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts
npm run test:vitest -- test/unit/client/store/persistedState.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/lib/session-utils.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
npm run lint
```

Expected: PASS

- [ ] **Step 4: Run the coordinated full suite**

Run:

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="wrong-agent-restore exact identity" npm test
```

Expected: `test:status` shows the coordinator is idle or clearly identifies the current holder, and `npm test` passes once the run starts.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/specs/terminal-exact-session-identity.spec.ts test/e2e-browser/helpers/fixtures.ts
git commit -m "test: cover exact wrong-agent restore regression"
```
