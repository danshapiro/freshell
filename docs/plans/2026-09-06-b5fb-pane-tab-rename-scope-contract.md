# Pane/Tab Rename Scope Contract (b5fb) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Stop pane/tab organization labels from silently overwriting durable provider
session titles (kata freshell#b5fb). Pane labels belong to panes, tab labels to
tabs; provider-native titles belong to provider sessions; an explicit durable
session rename remains available and continues to override the provider title;
and users with already-affected histories get a reviewable
reveal-provider-title / selective-reset flow. Add red/green/refactor coverage
across the enumerated rename/reuse/pre-ID/parity scenarios, on both servers
(Rust production + Node compatibility) and at browser level.

### Explicit constraints
- Pane rename: changes the pane label only; never mutates the durable provider
  session title by default; pane reuse A->B->C must not carry the label into
  durable history; a stopped pane with a retained `sessionRef` follows the same
  scope rule as a live pane.
- Tab rename: changes tab organization only; single-pane mirroring gains no
  broader durable semantics; multi-pane tab rename touches no session.
- Agent API rename (`PATCH /api/panes/:id`, and the MCP `freshell` tool that
  routes through it) obeys the same rules as the interactive UI; responses and
  events remain sufficient for clients to converge on pane/tab labels.
- Explicit durable session rename (sidebar/history rename, `PATCH
  /api/sessions/:key`) still writes the durable session override, updates the
  sidebar row for that exact provider/session id, converges open views, and
  remains sticky until explicitly cleared. Clearing an explicit durable rename
  reveals the current provider-native title per the title-source rules.
- Provider title updates without an explicit rename become visible in history;
  a pane/tab label cannot permanently shadow later provider title changes.
- Distinct sessions with distinct provider-native titles remain
  distinguishable; no deduplication or grouping may use title equality as
  identity; the historical 35-row collision group must stop growing AND
  existing affected rows must become distinguishable via a user-reviewed reset
  flow (not prevention alone).
- Data migration: existing overrides are inventoried by source/provenance where
  available; ambiguous overrides are never mass-deleted; a safe preview/report
  and rollback strategy exists before mutating user config; never infer intent
  solely from duplicate title text.
- Run focused unit/integration/E2E tests, accessibility lint where UI changes,
  Rust format/Clippy/type checks, and the coordinated repository suite before
  merge.

### Accepted tradeoffs and residuals
- No mass migration of existing overrides: provenance of historical writes is
  genuinely unknowable, so resolution is per-session and user-reviewed (a
  context-menu reset with a provider-title preview). Rollback is the existing
  one-generation `config.backup.json` refreshed on every persist.
- Reached ambiguity conservatively: when intent is unknowable, preserve data.
  Title-equality is never evidence that an override is accidental.
- The Node server is the legacy parity path (HARNESS-02 matrix): it is aligned
  to the new contract rather than diverged, with the deviations ledger updated.
- `docs/index.html` is unchanged: context menus and dialogs are transient UI
  that the nonfunctional mock does not represent (repo convention).

**Goal:** Pane/tab organization labels never touch durable session titles; the
only durable session renames come from explicit session-scope actions, and
existing accidental overrides become reviewably resettable with a provider-title
preview.

**Architecture:**
- Client (`src/store/titleSync.ts`): `applyPaneRename`/`applyTabRename` become
  Redux-local (delete `syncRenameToServer`). `applySessionRenameCascade`
  remains: an explicit session rename still mirrors into open panes.
- Servers: remove every pane/tab/terminal -> session "best-effort cascade"
  (client thunk, Node agent-API `persistSyncableTerminalRename`, Node/Rust
  terminals-route forward cascade, Rust fresh-agent `rename_persistence` seam
  + its `main.rs` production adapter). `PATCH /api/sessions/:key` stays the
  sole durable session-rename surface; its clear path (`titleOverride: null`)
  also clears `titleSource` so the title-source ladder is unblocked.
- Session-directory wire rows grow `titleOverridden`, `providerTitle`, and
  `titleOverrideSource` so a client can offer "Reset to provider title" with a
  preview, confirmed by the existing `ConfirmModal` pattern.

**Tech Stack:** TypeScript (React 18 + Redux Toolkit client, Express Node
server), Rust axum server (freshell-server/freshell-freshagent crates), zod
shared read-models, Vitest, supertest/superwstest, Playwright, cargo
(fmt/clippy/test).

## Global Constraints

- Baseline-ledger exceptions (never repair these; never re-run baseline):
  - `test/unit/vite-config.test.ts > getNetworkHost > ignores HOST env when configured`
  - `test/unit/vite-config.test.ts > getNetworkHost > returns 127.0.0.1 when config file does not exist`
  - `test/unit/vite-config.test.ts > getNetworkHost > returns 127.0.0.1 when config has no network settings`
- Full QA authority: `darkforge qa --repo '/home/dan/code/freshell' --id 'b5fb'`
  (runs `/home/dan/.local/share/darkforge/sources/freshell-qa.sh` in this
  worktree on a clean tree; acceptance = exit 0 OR every parsed failure
  identity in the baseline list above). The work-source oracle `npm run check`
  is plausible and is a strict subset of that gate (typecheck + coordinated
  vitest); Task 9 runs it directly. Note: `npm run check` will exit nonzero on
  the three baseline failures until repo main heals them - the Task 9 gate
  asserts the failure set equals the baseline list exactly.
- Node server code is NodeNext/ESM: relative imports carry `.js` extensions.
- Rust: `cargo fmt --all --check` clean; clippy clean under the QA script's
  three invocations (workspace minus freshell-tauri, plus the two
  real-transport feature lanes).
- Test runner discipline: focused runs via `npm run test:vitest -- run
  --config <config> <files>` (repo-owned passthrough); broad coordinated suites
  only inside `npm run check`. Do not invoke raw `npx vitest`.
- Destructive/config-corruption suites are out of scope here; if any test ever
  needs them, run them through `scripts/sandbox-test.sh`.
- Browser-level evidence (Task 8) runs the Playwright spec directly on the
  local harness: `npx playwright test --config
  test/e2e-browser/playwright.config.ts title-sync-convergence`. This covers
  the matched `chromium`, `legacy-chromium`, and `rust-chromium` projects with
  two REAL servers; it deliberately does not touch `FRESHELL_E2E_BACKEND`
  (owner-resolved QUESTION: run locally rather than asking; record in
  run-state).
- UI changes must respect the repo A11y requirements and pass `npm run lint`.
- Commit per task (conventional messages). Never force-push anything; never
  push during execution.
- `docs/index.html` deliberately unchanged (transient UI).
- AGENTS.md gets one durable pointer line to the new scope-contract doc.

---

### Task 1: Client pane/tab renames become layout-local

**Files:**
- Modify: `src/store/titleSync.ts`
- Create: `test/unit/client/store/titleSync.localScope.test.ts`
- Delete: `test/unit/client/store/titleSync.serverSync.test.ts`
- Modify: `test/unit/client/store/paneSessionTitleSync.test.ts`

**Interfaces:**
- Consumes: existing `updatePaneTitle`, `updateTab`, `updatePaneTitleByTerminalId`, `updatePaneTitleBySessionRef` actions.
- Produces: `applyPaneRename({tabId, paneId, title})` and `applyTabRename({tabId, title})` thunks with **identical existing signatures** (callers `PaneContainer.tsx:297`, `TabBar.tsx:393`, `lib/ui-commands.ts:112,129` unchanged); `applySessionRenameCascade` unchanged and still exported. No function in this module PATCHes the server after this task.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/client/store/titleSync.localScope.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, splitPane } from '@/store/panesSlice'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import { applyPaneRename, applyTabRename } from '@/store/titleSync'

vi.mock('nanoid', () => { let n = 0; return { nanoid: vi.fn(() => `pane-${++n}`) } })

// The contract under test: pane/tab renames must NOT touch the network. The
// mock stays as a tripwire even though nothing should call it.
const apiMocks = vi.hoisted(() => ({ patch: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/api', () => ({ api: { patch: apiMocks.patch } }))

function storeWith(content: PaneContent) {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'x', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, content }))
  const paneId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).id
  return { store, tabId, paneId }
}

describe('pane/tab rename local scope (b5fb)', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('live coding-CLI terminal pane rename updates local labels and PATCHes nothing', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'claude', terminalId: 'term-9' })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Project' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('My Project')
    // single-pane tab: tab title mirrors the pane label locally (existing org behavior)
    expect(store.getState().tabs.tabs[0].title).toBe('My Project')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('exited coding-CLI terminal pane with a retained sessionRef PATCHes nothing (stopped pane == live pane rule)', () => {
    const { store, tabId, paneId } = storeWith({
      kind: 'terminal', mode: 'claude', createRequestId: 'r-exited', status: 'exited',
      sessionRef: { provider: 'claude', sessionId: 's1' },
    } as unknown as PaneContent)
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'Offline name' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Offline name')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('multi-pane tab rename changes the tab label only — pane labels are untouched', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'claude', terminalId: 'term-1' })
    store.dispatch(splitPane({
      tabId,
      paneId,
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'opencode', terminalId: 'term-2' } as PaneContent,
      newPaneId: 'pane-99',
    }))
    store.dispatch(applyTabRename({ tabId, title: 'Multi tab' }))
    expect(store.getState().tabs.tabs[0].title).toBe('Multi tab')
    // neither pane gained a label from the tab-organisation rename
    expect(store.getState().panes.paneTitles[tabId]?.[paneId]).not.toBe('Multi tab')
    expect(store.getState().panes.paneTitles[tabId]?.['pane-99']).not.toBe('Multi tab')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('fresh-agent pane rename (sessionId present) PATCHes nothing', () => {
    const { store, tabId, paneId } = storeWith({
      kind: 'fresh-agent', sessionType: 'claude', provider: 'claude', sessionId: 'sess-7',
      createRequestId: 'r', status: 'idle',
    } as unknown as PaneContent)
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Chat' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('My Chat')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('pre-ID fresh-agent pane rename stays local and is never retro-synced on identity adoption', () => {
    const { store, tabId, paneId } = storeWith({
      kind: 'fresh-agent', sessionType: 'claude', provider: 'claude',
      createRequestId: 'r-pre', status: 'connecting',
    } as unknown as PaneContent)
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'Pre-ID label' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Pre-ID label')
    // Nothing is queued for later: with sync machinery deleted there is no
    // replay path, so an identity adoption (sessionId arriving later) can
    // never retro-persist this label. (FreshAgentView adoption coverage tests
    //  verify content adoption itself.)
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('single-pane tab rename mirrors into the pane label locally and PATCHes nothing', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'codex', terminalId: 'term-3' })
    store.dispatch(applyTabRename({ tabId, title: 'Tab org label' }))
    expect(store.getState().tabs.tabs[0].title).toBe('Tab org label')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Tab org label')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('shell terminal pane rename stays Redux-only (unchanged)', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'shell', terminalId: 'term-shell' })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Shell' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('My Shell')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })
})
```

In `test/unit/client/store/paneSessionTitleSync.test.ts` delete the entire
`describe('exited-terminal pane rename (D8)')` block (lines 65-96). Its three
pins (PATCH sessions on exited, PATCH terminals on live, no-PATCH orphan) are
superseded by the local-scope pins above. Keep every other describe. Multi-pane
tab organization coupling remains pinned by `tab-pane-title-sync.test.ts`
(unchanged).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/titleSync.localScope.test.ts`

Expected: FAIL — tests 1, 2, 4, 6 fail because `syncRenameToServer` still
issues `api.patch` for coding-agent content (and the single-pane tab rename
syncs too). The failure message shows unexpected `PATCH /api/terminals/...` or
`PATCH /api/sessions/...` calls.

- [ ] **Step 3: Add the minimal production implementation**

Rewrite `src/store/titleSync.ts`: delete the `syncRenameToServer` function, the
`findPaneContent` helper, and the `api` / `isCodingAgentContent` / `PaneContent`
imports. `applyPaneRename` keeps `updatePaneTitle` + the single-pane tab mirror;
`applyTabRename` keeps `updateTab` + the single-pane pane mirror — with NO server
call. `applySessionRenameCascade` is unchanged. Add a top-of-file comment:

```ts
/**
 * Rename scope contract (docs/development/rename-scope-contract.md):
 * pane and tab renames are LOCAL organization. They never write terminal or
 * session overrides — the only durable session rename flows through an
 * explicit session-scope action (`PATCH /api/sessions/:key` via the sidebar /
 * history rename, or Task 7's reset). `applySessionRenameCascade` is the one
 * sanctioned cross-scope mirror: session -> open panes.
 */
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/titleSync.localScope.test.ts test/unit/client/store/paneSessionTitleSync.test.ts test/unit/client/store/tab-pane-title-sync.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Delete `test/unit/client/store/titleSync.serverSync.test.ts` (its pins were the
old contract). Confirm no import of it remains (`grep -rn serverSync test/ src/`).

- [ ] **Step 6: Run impacted-test verification**

Impacted: every module calling `applyPaneRename`/`applyTabRename` and the jsdom
flow suite.

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/ test/e2e/title-sync-flow.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/titleSync.ts test/unit/client/store/titleSync.localScope.test.ts test/unit/client/store/titleSync.serverSync.test.ts test/unit/client/store/paneSessionTitleSync.test.ts
git commit -m "refactor(client): make pane/tab renames layout-local (b5fb)"
```

### Task 2: Node agent API `PATCH /api/panes/:id` becomes layout-only

**Files:**
- Modify: `server/agent-api/router.ts` (drop `SYNCABLE_TERMINAL_MODES` at :43,
  `persistSyncableTerminalRename` at :641-685, the snapshot read at :1407, and
  the cascade call at :1412; drop the `makeSessionKey` import at :16 — verified
  its only other use was inside the deleted function); ALSO remove
  `terminalMetadata` and `codingCliIndexer` from the factory-parameter
  destructuring at :498-500 (their ONLY uses are inside the deleted cascade —
  `noUnusedLocals` would fail the build; keep both in the options interface at
  :509-511 so call sites still compile; `configStore` stays — other routes use it
  for provider settings)
- Modify: `test/server/agent-panes-write.test.ts` (rewrite the seven
  old-contract pins: the six cascade tests at :681-922 plus the
  attach-then-rename test at ~:471-522 — see below)
- Modify: `test/server/agent-tabs-write.test.ts` (add one layout-only pin for
  `PATCH /api/tabs/:id`)

**Interfaces:**
- Consumes: `layoutStore.renamePane`, `layoutStore.listPanes`, `wsHandler.broadcastUiCommand`.
- Produces: route responds `ok({tabId, paneId, tabRenamed}, 'pane renamed')` and broadcasts `ui.command{pane.rename,...}` exactly as today — the automation contract is byte-identical; ONLY the side effects are removed. The `configStore`/`terminalMetadata`/`codingCliIndexer` router deps stay (other routes use them).

- [ ] **Step 1: Write the failing behavioral test**

Replace the old-contract pins in `test/server/agent-panes-write.test.ts`:
the six cascade tests at :681-922 ("persists syncable coding CLI pane
renames…", both "falls back…" tests, "does not fail the pane rename when coding
CLI session cascade refresh fails", "does not fail the pane rename when
terminal override persistence fails") PLUS the attach-then-rename test at
~:471-522 (`preserves coding CLI mode across attach so a later rename-pane
persists overrides`). For the attach test: keep the attach/mode-preservation
assertions (attach must still carry the resolved mode) and invert the rename
half — after the PATCH, `patchTerminalOverride`/`patchSessionOverride`/
`updateTitle`/`refresh`/`broadcastTerminalsChanged` are all NOT called. Use the
same harness shape. The two replacement pins for the cascade cluster:

```ts
it('persists NOTHING beyond the layout store for a syncable coding-CLI pane rename (b5fb)', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn().mockResolvedValue({})
  const updateTitle = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const broadcastTerminalsChanged = vi.fn()
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      listPanes: () => [{ id: 'pane_1' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: {
          kind: 'terminal', mode: 'codex', terminalId: 'term_1',
          resumeSessionId: 'session-1', sessionRef: { provider: 'codex', sessionId: 'session-1' },
        },
      }),
    } as any,
    registry: { get: () => ({ mode: 'codex' }), updateTitle } as any,
    wsHandler: { broadcastUiCommand, broadcastTerminalsChanged },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [{ terminalId: 'term_1', provider: 'codex', sessionId: 'session-1' }],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Agent' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Agent')
  expect(patchTerminalOverride).not.toHaveBeenCalled()
  expect(patchSessionOverride).not.toHaveBeenCalled()
  expect(updateTitle).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  expect(broadcastTerminalsChanged).not.toHaveBeenCalled()
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_1', title: 'Agent' },
  })
})
```

Second pin: same shape but with an assembly where the pane carries ONLY
`sessionRef` (no `terminalId`, no `resumeSessionId`) to cover the stopped-pane
surface. Assert the same six `.not.toHaveBeenCalled()`s.

In `test/server/agent-tabs-write.test.ts`, append (that file's convention:
`express()` + bare-object `layoutStore` + `createAgentApiRouter`):

```ts
it('PATCH /api/tabs/:id is layout-only: no override or registry writes, tab.rename broadcast only', async () => {
  const app = express()
  app.use(express.json())
  const renameTab = vi.fn(() => ({ tabId: 'tab_1' }))
  const broadcastUiCommand = vi.fn()
  const patchTerminalOverride = vi.fn()
  const patchSessionOverride = vi.fn()
  const updateTitle = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renameTab } as any,
    registry: { updateTitle } as any,
    wsHandler: { broadcastUiCommand },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
  }))

  const res = await request(app).patch('/api/tabs/tab_1').send({ name: 'Org label' })

  expect(res.status).toBe(200)
  expect(renameTab).toHaveBeenCalledWith('tab_1', 'Org label')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'tab.rename',
    payload: { id: 'tab_1', title: 'Org label' },
  })
  expect(patchTerminalOverride).not.toHaveBeenCalled()
  expect(patchSessionOverride).not.toHaveBeenCalled()
  expect(updateTitle).not.toHaveBeenCalled()
})
```

(This test is GREEN before the change as well — the tabs route was always
layout-only. It pins the invariant the work item requires, so a future cascade
cannot sneak in through the tab route.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/server/agent-panes-write.test.ts`

Expected: FAIL — the FIRST pin fails because `persistSyncableTerminalRename`
still writes terminal/session overrides, bumps the registry title, and
broadcasts `terminals.changed`. The second pin is a guard that is GREEN before
and after (the old cascade early-returns on `!terminalId`, so a sessionRef-only
pane never persisted anyway — it pins that gap can never reopen).

- [ ] **Step 3: Add the minimal production implementation**

In `server/agent-api/router.ts`:
1. Delete the `SYNCABLE_TERMINAL_MODES` constant (:43).
2. Delete `persistSyncableTerminalRename` (:641-685).
3. In the `PATCH /panes/:id` handler delete `const paneSnapshot = layoutStore.getPaneSnapshot?.(paneId)` (:1407) and `await persistSyncableTerminalRename(paneSnapshot, name)` (:1412).
4. Delete the now-unused `makeSessionKey` import (:16).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/server/agent-panes-write.test.ts test/server/agent-tabs-write.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Run `npm run typecheck` to catch any import/deps left dangling. Also delete the
`does not persist terminal rename side effects when the authoritative pane
rename fails` test's persistence scaffolding only insofar as it stays green and
meaningful (it now pins: rename miss → no broadcasts at all; keep it).

- [ ] **Step 6: Run impacted-test verification**

`createAgentApiRouter` is exercised by every `test/server/agent-*.test.ts` file.

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/server/`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/agent-api/router.ts test/server/agent-panes-write.test.ts test/server/agent-tabs-write.test.ts
git commit -m "refactor(server): agent-API pane rename is layout-only (b5fb)"
```

### Task 3: Node terminals/sessions routes — drop the forward cascade, fix the clear

**Files:**
- Modify: `server/terminals-router.ts` (remove the cascade block at :306-320 and
  the `cascadeTerminalRenameToSession` import)
- Modify: `server/sessions-router.ts` (key-presence-guarded patch builder at
  :179-186: absent `titleOverride` key no longer clears an existing title —
  today the unconditional spread drops it; explicit null clears BOTH
  `titleOverride` and `titleSource`)
- Modify: `server/rename-cascade.ts` (delete `cascadeTerminalRenameToSession`
  at :23-32 and the `TitleSource` import; keep `findTerminalForSession` and
  `cascadeSessionRenameToTerminal` — the explicit session→terminal mirror stays)
- Test: `test/unit/server/unified-rename.test.ts` (delete the
  `cascadeTerminalRenameToSession` suite :35-81; keep the rest)
- Test: `test/integration/server/unified-rename-integration.test.ts` (invert
  Tests 1-2, keep Test 3, add a clear test; update the buildTestApp mirror)
- Test: `test/unit/server/config-store.ladder.test.ts` (add the
  clear-both-keys + ladder-unblocked store-level pin)

**Interfaces:**
- Produces: `PATCH /api/terminals/:id` = terminal-scope only (override + registry write-through + `terminals.changed` — identical response shape); `PATCH /api/sessions/:key` = sole durable session rename; `{titleOverride: null}` clears both keys; `{archived: true}`-style no-title patches never touch the title.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/server/config-store.ladder.test.ts` — append (uses the suite's
existing `beforeEach` fixture: temp-home + `store = new ConfigStore()` + `KEY`):

```ts
it('clear patch removes titleOverride AND titleSource, unblocking the ladder', async () => {
  await store.patchSessionOverride(KEY, { titleOverride: 'Intentional', titleSource: 'user' })
  await store.patchSessionOverride(KEY, { titleOverride: undefined, titleSource: undefined })
  const row = await store.getSessionOverride(KEY)
  expect(row?.titleOverride).toBeUndefined()
  expect(row?.titleSource).toBeUndefined()
  // ladder unblocked: a lower-rung sourced title lands again
  await store.patchSessionOverride(KEY, { titleOverride: 'first msg name', titleSource: 'first-message' })
  expect((await store.getSessionOverride(KEY))?.titleOverride).toBe('first msg name')
})
```

This store-level pin is **GREEN from the start** (a guard, not RED evidence):
`patchSessionOverride` spread-merges `{...existing, ...patch}`, and with BOTH
patch keys `undefined` the merge clears both keys while the ladder gate is
skipped — the store already honors the contract the fixed route relies on. The
defect lives one layer up: the route never SENDS `titleSource: undefined` on a
clear (`...(cleanString(titleOverride) ? { titleSource: 'user' } : {})` omits
the key outright), so the stored rung survives. The RED for the route fix is
integration Test 4 below.

`test/integration/server/unified-rename-integration.test.ts` — rewrite:
- Test 1 → "terminal rename does NOT write a session override (live)":
  same seed/associate flow; expect 200 and `res.body.titleOverride === 'My Renamed Terminal'`; then `expect(await configStore.getSessionOverride(compositeKey)).toBeUndefined()`.
- Test 2 → "terminal rename does NOT write a session override (retired)": same
  after `terminalMetadata.retire(terminalId)`; same not-written assertion.
- Test 3 unchanged: session rename cascades TO the terminal (explicit session scope).
- New Test 4: "clearing an explicit session rename removes title and source":
  PATCH `{titleOverride: 'Kept'}` on the session; assert stored row has
  `titleSource: 'user'`; PATCH `{titleOverride: null}`; read the raw config file
  (`~/.freshell/config.json` under the temp home) and assert the
  `sessionOverrides[compositeKey]` row contains NEITHER `titleOverride` NOR
  `titleSource` keys (`Object.keys` check, not just undefined values).
- buildTestApp mirror changes: delete the inlined terminal→session cascade
  (:229-239), and mirror the new sessions builder:

```ts
app.patch('/api/sessions/:sessionId', async (req, res) => {
  const rawId = req.params.sessionId
  const provider = (req.query.provider as CodingCliProviderName) || 'claude'
  const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
  const { titleOverride } = req.body || {}
  const next = await configStore.patchSessionOverride(compositeKey, {
    ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, 'titleOverride')
      ? {
          titleOverride: typeof titleOverride === 'string' ? titleOverride.trim() || undefined : undefined,
          titleSource: typeof titleOverride === 'string' && titleOverride.trim() ? ('user' as const) : undefined,
        }
      : {}),
  })
  // session→terminal cascade (unchanged, inlined from cascadeSessionRenameToTerminal)
  const cleanTitle = typeof titleOverride === 'string' ? titleOverride.trim() || undefined : undefined
  let cascadedTerminalId: string | undefined
  if (cleanTitle) {
    const parts = compositeKey.split(':')
    const sessionProvider = (parts.length >= 2 ? parts[0] : provider) as CodingCliProviderName
    const sessionId = parts.length >= 2 ? parts.slice(1).join(':') : rawId
    const match = findTerminalForSession(terminalMetadata.list(), sessionProvider, sessionId)
    if (match) {
      await configStore.patchTerminalOverride(match.terminalId, { titleOverride: cleanTitle })
      cascadedTerminalId = match.terminalId
    }
  }
  res.json({ ...next, cascadedTerminalId })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/integration/server/unified-rename-integration.test.ts test/unit/server/config-store.ladder.test.ts`

Expected: FAIL — Tests 1/2 currently write the session override through the
today-behavior mirror app, and Test 4 fails because today's sessions route never
emits `titleSource: undefined`, so the stored `titleSource:'user'` survives the
clear and stays ladder-blocking. The store-level ladder pin passes already
(green-from-start guard — guard, not RED).

- [ ] **Step 3: Add the minimal production implementation**

`server/terminals-router.ts`: delete the cascade block (:306-320, including the
`deps.terminalMetadata.get?.(...) ?? .list().find(...)` lookup and the indexer
refresh tied to it), and delete `cascadeTerminalRenameToSession` from the import.

`server/sessions-router.ts` — replace the patch construction (:179-186):

```ts
const { titleOverride, summaryOverride, deleted, archived, createdAtOverride } = parsed.data
const titleTouched = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'titleOverride')
const cleanTitle = cleanString(titleOverride)
const next = await configStore.patchSessionOverride(compositeKey, {
  // b5fb scope contract: touching the title requires the KEY present. An
  // explicit null/blank clear removes the source rung too, so the ladder is
  // unblocked afterwards (a leftover titleSource:'user' was a permanent
  // freeze). A patch that never mentioned the title leaves it untouched.
  ...(titleTouched
    ? { titleOverride: cleanTitle, titleSource: cleanTitle ? ('user' as const) : undefined }
    : {}),
  summaryOverride: cleanString(summaryOverride),
  deleted,
  archived,
  createdAtOverride,
})
```

(The existing cascade block below already reads `cleanTitle` — reuse this
variable and delete its duplicate declaration at :189.)

`server/rename-cascade.ts`: delete `cascadeTerminalRenameToSession` and the
`TitleSource` import; keep the other two exports.

`test/unit/server/unified-rename.test.ts`: delete the
`describe('cascadeTerminalRenameToSession')` block (:35-81) and its import.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/integration/server/unified-rename-integration.test.ts test/unit/server/config-store.ladder.test.ts test/unit/server/unified-rename.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

`cleanString(undefined)` returning undefined relies on spread-merge semantics —
add nothing; the key-presence guard makes it explicit. Run `npm run typecheck`.

- [ ] **Step 6: Run impacted-test verification**

Terminals PATCH and sessions PATCH are pinned by several suites.

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/unified-rename.test.ts test/integration/server/unified-rename-integration.test.ts test/server/terminals-api.test.ts test/integration/server/session-directory-router.test.ts test/unit/server/config-store.ladder.test.ts`

Expected: PASS (the session-directory name-cascade pin at :267-310 keeps
passing: session→terminal cascade is retained).

- [ ] **Step 7: Commit the task**

```bash
git add server/terminals-router.ts server/sessions-router.ts server/rename-cascade.ts test/unit/server/unified-rename.test.ts test/integration/server/unified-rename-integration.test.ts test/unit/server/config-store.ladder.test.ts
git commit -m "fix(server): terminal renames stop writing session overrides; session-title clear unblocks ladder (b5fb)"
```

### Task 4: Rust server — drop the terminal→session cascade, fix the clear

**Files:**
- Modify: `crates/freshell-server/src/sessions.rs` (clear at :147-155 also pushes `("titleSource", None)`)
- Modify: `crates/freshell-server/src/terminals.rs` (delete the cascade block at :1010-1036; update the stale cascade doc comments at :41 and :88-95)
- Test: `crates/freshell-server/src/sessions_tests.rs` (add the clear test)
- Test: `crates/freshell-server/src/terminals.rs` `mod cascade_tests` → rename to `mod title_scope_tests` with inverted pins (:1089-1205)

**Interfaces:**
- Consumes: `SettingsStore::patch_session_override` (`None` = key-removal, per its JS-spread semantics; this is exactly what `migrations.rs:77-81` already uses to clear).
- Produces: `PATCH /api/terminals/{id}` = terminal-scope only; `PATCH /api/sessions/{id}` untouched in success behavior (explicit rename still cascades session→live-terminal); `{"titleOverride": null}` now removes both keys. `TerminalsState.identity` stays (consumed by the sidebar-projection join in this file).

- [ ] **Step 1: Write the failing behavioral test**

Add to `crates/freshell-server/src/sessions_tests.rs` (uses the file's `state()`, `body_json()`, and `uuid_like()` helpers):

```rust
/// b5fb: clearing a title (`{"titleOverride": null}`) removes BOTH the override
/// and its source. A leftover titleSource:"user" would permanently finalize the
/// row at rank 5, blocking every automatic title update forever after.
#[tokio::test]
async fn patch_clear_title_removes_override_and_source() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);
    let app = super::router(st.clone());

    // 1) Explicit user rename lands with the 'user' rung.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=claude")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"titleOverride":"Intentional rename"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let v = body_json(resp).await;
    assert_eq!(v["titleSource"], serde_json::json!("user"));

    // 2) Clear: the response and the stored row lose BOTH keys.
    let resp = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/sessions/abc123?provider=claude")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"titleOverride":null}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert!(
        v.get("titleOverride").map(|x| x.is_null()).unwrap_or(true),
        "titleOverride cleared from response: {v}"
    );
    assert!(
        v.get("titleSource").map(|x| x.is_null()).unwrap_or(true),
        "titleSource cleared from response: {v}"
    );

    let overrides = st.settings.session_overrides();
    let row = overrides.get("claude:abc123").cloned().unwrap_or_default();
    assert!(row.get("titleOverride").is_none(), "stored row: {row}");
    assert!(row.get("titleSource").is_none(), "stored row: {row}");

    // 3) The ladder is unblocked: a first-message sourced write lands again.
    st.settings
        .patch_session_override(
            "claude:abc123",
            &[
                ("titleOverride", Some(serde_json::json!("First message name"))),
                ("titleSource", Some(serde_json::json!("first-message"))),
            ],
        )
        .await;
    let row = st
        .settings
        .session_overrides()
        .get("claude:abc123")
        .cloned()
        .unwrap();
    assert_eq!(row["titleSource"], serde_json::json!("first-message"));
    std::fs::remove_dir_all(&dir).ok();
}
```

In `crates/freshell-server/src/terminals.rs`, rename `mod cascade_tests` to
`mod title_scope_tests` and rewrite its three tests as pins (same `state()`,
`dir()`, and `patch_terminal_title` helpers):

```rust
/// b5fb scope contract: renaming a terminal bound to a coding-CLI session
/// writes ONLY the terminal override — no session override, live or not.
#[tokio::test]
async fn rename_does_not_write_a_session_override_for_a_live_cli_terminal() {
    let dir = dir();
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let state = state(&dir);
    state.identity.upsert("term-1", Some("claude"), Some("sess-abc"), None, 1000);

    let resp = patch_terminal_title(state.clone(), "term-1", "Terminal Label").await;
    assert_eq!(resp["titleOverride"], json!("Terminal Label"));
    assert!(
        state.settings.session_overrides().is_empty(),
        "no session override: {:?}",
        state.settings.session_overrides()
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// The retired-identity lookup is equally in scope: an exited terminal's rename
/// stays terminal-scoped too.
#[tokio::test]
async fn rename_does_not_write_a_session_override_after_the_terminal_exits() {
    let dir = dir();
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let state = state(&dir);
    state.identity.upsert("term-2", Some("codex"), Some("sess-xyz"), None, 1000);
    state.identity.retire("term-2");

    let resp = patch_terminal_title(state.clone(), "term-2", "Post-Exit Label").await;
    assert_eq!(resp["titleOverride"], json!("Post-Exit Label"));
    assert!(state.settings.session_overrides().is_empty());
    std::fs::remove_dir_all(&dir).ok();
}
```

Keep `rename_of_plain_shell_terminal_does_not_create_a_session_override` unchanged
(it already pins the shell no-op and stays green across the change).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server patch_clear_title_removes_override_and_source` AND `cargo test -p freshell-server rename_does_not_write` (cargo test accepts exactly one name filter — two invocations)

Expected: FAIL — the clear test fails on the leftover `titleSource: 'user'`
(only `titleOverride` is removed today) and the two terminal pins fail because
`session_overrides()` contains the cascaded row.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-server/src/sessions.rs` — patch builder (:147-155):

```rust
let title = clean_string(body.get("titleOverride"));
let mut patch: Vec<(&str, Option<Value>)> = Vec::new();
if body.get("titleOverride").is_some() {
    patch.push(("titleOverride", title.clone().map(Value::from)));
    // titleSource:'user' only when a non-empty title is present (sessions-router.ts:132-133).
    if title.is_some() {
        patch.push(("titleSource", Some(json!("user"))));
    } else {
        // b5fb: an explicit clear removes BOTH keys — a leftover
        // titleSource:"user" would permanently finalize the row at the top
        // rung and block every automatic title update afterwards
        // (migrations.rs:77-81 clears the same pair).
        patch.push(("titleSource", None));
    }
}
```

`crates/freshell-server/src/terminals.rs`: delete the cascade block at
:1010-1036 (the `if let Some(t) = &title_override { if let Some(identity) = ...
}` writing the session override). Update: the module doc at :41 and the
`TerminalsState.identity` field doc at :88-95 — replace cascade language with
"retained for the sidebar-projection/sessionRef join" wording.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server patch_clear_title_removes_override_and_source rename_does_not_write rename_of_plain_shell`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

`cargo fmt --all --check`. Ensure `TerminalsState.identity` is still read by the
GET/projection code path in this file (it is — the sidebar projection joins on
it), so no dead-field clippy warning appears.

- [ ] **Step 6: Run impacted-test verification**

The sessions PATCH handler is also covered by `sessions_tests.rs` wholesale and
the auto-title sweep suite.

Run: `cargo test -p freshell-server sessions::tests && cargo test -p freshell-server terminals:: && cargo fmt --all --check` (test-name filters are substring matches on the module path: `sessions::tests`, not `sessions_tests`)

Expected: PASS. (`mod cascade_tests` was renamed — no stale module names in any
error output.)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/sessions.rs crates/freshell-server/src/terminals.rs crates/freshell-server/src/sessions_tests.rs
git commit -m "fix(rust): terminal renames stop writing session overrides; session-title clear unblocks ladder (b5fb)"
```

### Task 5: Rust fresh-agent pane rename loses the persistence cascade

Deletions are the implementation here; the TDD dance around a deleted seam is
spelled out in Step 1 notes.

**Files:**
- Delete: `crates/freshell-freshagent/src/rename_persistence.rs` (whole module)
- Modify: `crates/freshell-freshagent/src/lib.rs` — remove `pub mod rename_persistence;` (:49), `pub use rename_persistence::{BoxFuture, RenamePersistence, SYNCABLE_TERMINAL_MODES};` (:73), the `rename_persistence` field + its doc (:311-316), the `rename_persistence: None` init (:446), the `with_rename_persistence` builder (:632-634), and in `rename_pane`: the pre-rename `get_pane_snapshot` read (:2149) + `persist_syncable_terminal_rename` call (:2161-2163) + doc-comment steps 2/4 mentioning the cascade (:2117/:2120-2121)
- Modify: `crates/freshell-server/src/main.rs` — delete `struct SettingsRenamePersistence` + its `impl freshell_freshagent::RenamePersistence` (:94-147), the `.with_rename_persistence(Arc::new(SettingsRenamePersistence(settings_store.clone())))` chain call (:641), and the neighboring `.with_shared_terminals_revision(Arc::clone(&terminals_revision))` chain call + its shared-counter comment (:638-643 region: the comment covers both cascade wirings; rewrite it to cover only the remaining builder calls). NOTE: the load-bearing check confirmed `FreshAgentState::terminals_revision` (field `lib.rs:319-322`, init :447, builder `with_shared_terminals_revision` :648-654, the dangling rustdoc link at :641's doc comment) is read ONLY by the deleted `rename_persistence.rs` — remove field + init + builder + doc comments too, or clippy `-D warnings` fails on the never-read field
- Modify: `crates/freshell-server/src/auto_title_sweep.rs` — delete the obsolete `pane_rename_cascade_before_finalization_survives_next_sweep_pass` test + its doc block (:940-1003; its premise — the pane-rename cascade — no longer exists)
- Rename + rewrite: `crates/freshell-freshagent/src/rename_cascade_tests.rs` → `crate::rename_route_tests.rs` (update the `#[path]` decl at `lib.rs:3920-3921`)

**Interfaces:**
- Consumes: unchanged route contract — `{status:"ok", data:{tabId, paneId, tabRenamed}, message}` + `ui.command{pane.rename,{tabId,paneId,title}}`.
- Produces: `FreshAgentState` without any persistence seam; callers wiring it (`main.rs`) disappear with it. `BoxFuture` remains available from `freshell_opencode::serve` (other consumers use THAT alias — verified).

- [ ] **Step 1: Write the failing behavioral test**

TDD note for deletions: write the pin test wired to a recording fake FIRST (RED
while the machinery still exists), then remove machinery + fake together (GREEN
by structural absence). Put this in the existing `rename_cascade_tests.rs`
(which Step 3 renames):

```rust
/// b5fb pin: renaming a SYNCABLE coding-CLI pane writes nothing beyond the
/// layout store — no persistence calls land and no `terminals.changed` fires.
/// RED phase: the recording fake IS wired; today the cascade calls it.
#[tokio::test]
async fn rename_pane_never_cascades_for_a_syncable_claude_terminal() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let fake = Arc::new(RecordingPersistence::default());
    let state = state_with(tx.clone())
        .with_terminal_registry(registry.clone())
        .with_rename_persistence(Arc::clone(&fake) as Arc<dyn RenamePersistence>);

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "sess-ref-1" },
        })),
    );

    // Subscribe AFTER the create so only the rename's frames are captured.
    let mut rx = tx.subscribe();
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Local Only").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        fake.terminal_calls.lock().unwrap().is_empty()
            && fake.session_calls.lock().unwrap().is_empty(),
        "pane rename must not persist anywhere: {:?} {:?}",
        fake.terminal_calls.lock().unwrap(),
        fake.session_calls.lock().unwrap()
    );
    assert_ne!(
        registry.title_of(&terminal_id).as_deref(),
        Some("Local Only"),
        "registry title untouched by a pane rename"
    );
    let frames = drain_frames(&mut rx);
    assert!(
        frames.iter().all(|f| f["type"] != json!("terminals.changed")),
        "no terminals.changed from a pane rename: {frames:?}"
    );
    assert!(frames.iter().any(|f| f["type"] == json!("ui.command")
        && f["command"] == json!("pane.rename")), "pane.rename still broadcast: {frames:?}");
}

#[tokio::test]
async fn pane_reuse_across_sessions_never_leaves_durable_titles() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let fake = Arc::new(RecordingPersistence::default());
    let state = state_with(tx.clone())
        .with_terminal_registry(registry.clone())
        .with_rename_persistence(Arc::clone(&fake) as Arc<dyn RenamePersistence>);

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    let mut rx = tx.subscribe();
    // Session A displayed
    seed_layout(&state, lone_pane_layout(json!({
        "kind": "terminal", "mode": "claude", "terminalId": terminal_id,
        "sessionRef": { "provider": "claude", "sessionId": "sess-A" },
    })));
    let (_s, _b) = patch_pane(crate::router(state.clone()), "p1", "Reusable Name").await;
    // Pane reused for session B
    seed_layout(&state, lone_pane_layout(json!({
        "kind": "terminal", "mode": "claude", "terminalId": terminal_id,
        "sessionRef": { "provider": "claude", "sessionId": "sess-B" },
    })));
    let (_s, _b) = patch_pane(crate::router(state.clone()), "p1", "Reusable Name 2").await;

    drain_frames(&mut rx);
    assert!(
        fake.session_calls.lock().unwrap().is_empty(),
        "no durable session writes across pane reuse: {:?}",
        fake.session_calls.lock().unwrap()
    );
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent rename_pane_never_cascades` AND `cargo test -p freshell-freshagent pane_reuse_across_sessions_never_leaves_durable_titles`

Expected: FAIL — the current `persist_syncable_terminal_rename` calls the fake
(`session_calls` non-empty) on both.

- [ ] **Step 3: Add the minimal production implementation**

1. Delete `crates/freshell-freshagent/src/rename_persistence.rs`.
2. In `crates/freshell-freshagent/src/lib.rs`: remove the `pub mod` decl (:49),
   the `pub use` (:73), the field + doc (:311-316), the init (:446), the
   `with_rename_persistence` builder (:632-634), and in `rename_pane` remove the
   pre-rename snapshot (:2149) and cascade call (:2161-2163); rewrite the doc
   comment's steps 2/4 to describe layout-only behavior.
3. In `crates/freshell-server/src/main.rs`: delete `SettingsRenamePersistence`
   + its impl (:94-147) and `.with_rename_persistence(...)` (:641).
4. In `crates/freshell-server/src/auto_title_sweep.rs`: delete the
   `pane_rename_cascade_before_finalization_survives_next_sweep_pass` test and
   its doc comment (:940-1003).
5. `git mv crates/freshell-freshagent/src/rename_cascade_tests.rs
   crates/freshell-freshagent/src/rename_route_tests.rs`; update the `#[path]`
   attribute + `mod` name at `lib.rs:3920-3921`. In the two new pins, strip ONLY
   the fake-specific wiring and assertions (`RecordingPersistence`,
   `RenamePersistence`, `.with_rename_persistence(...)`, the
   `fake.*_calls.is_empty()` assertions) plus the now-dead `AtomicI64`/`Ordering`
   imports — but KEEP the frame assertions in the GREEN form so the pins stay
   non-vacuous: each rename yields exactly one `ui.command{pane.rename}` frame
   and zero `terminals.changed` frames (with a real `TerminalRegistry` wired and
   a pane bound to a `sessionRef`, the absence of any cascade is observable).
   Finally, delete the three removed-behavior tests
   (`rename_pane_cascades_to_syncable_terminal_via_injected_persistence`,
   `rename_pane_shell_pane_never_cascades` — the mode distinction is gone,
   `rename_pane_cascades_via_registry_session_binding_without_pane_content_session_fields`);
   keep `rename_pane_renames_store_and_broadcasts_ui_command`,
   `rename_pane_unknown_pane_is_200_with_message`, the multi-client test, and
   the panel of helpers.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent`

Expected: PASS (whole crate — routes, layout store, freshclaude/codex/opencode states).

- [ ] **Step 5: Refactor while green**

`cargo fmt --all --check` and, for the crate pair,
`cargo clippy -p freshell-freshagent -p freshell-server --all-targets -- -D warnings`.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-server auto_title_sweep && cargo fmt --all --check`

Expected: PASS (the sweep's remaining ladder tests are untouched and stay green).

- [ ] **Step 7: Commit the task**

```bash
git add -A crates/freshell-freshagent/src crates/freshell-server/src/main.rs crates/freshell-server/src/auto_title_sweep.rs
git commit -m "refactor(rust): remove fresh-agent pane-rename persistence cascade (b5fb)"
```

### Task 6: Session-directory rows carry override provenance

This task is the data enabler for Task 7's reviewed reset flow. Three NEW,
optional, additive wire fields: `titleOverridden` (boolean, true exactly when a
`titleOverride` currently applies on the row), `providerTitle` (the parsed
pre-override title, when it exists), `titleOverrideSource` (the stored
`titleSource` of the applied override, when it exists).

**Files:**
- Modify: `shared/read-models.ts` — extend `SessionDirectoryItemSchema` (:49-74)
- Modify: `src/store/types.ts` — extend client `CodingCliSession` (:90-113)
- Modify: `src/lib/api.ts` — the client allowlist mappers are NOT pass-through:
  `groupDirectoryItemsAsProjects` (:646-665) and `searchSessions`' results map
  (:757-774) pick fields one-by-one, and `SearchResult` (:551-574) is a separate
  type — ALL must forward the three new fields or they never reach Redux
  (load-bearing finding F1)
- Modify: `src/store/sessionsThunks.ts` — `searchResultsToProjects` (:74-118) is
  another explicit allowlist; forward the same three fields
- Modify: `server/coding-cli/types.ts` — extend server `CodingCliSession` (:173-196)
- Modify: `server/coding-cli/session-indexer.ts` — `applyOverride` (:222-238)
- Modify: `server/session-directory/projection.ts` — `toSessionDirectoryComparableItem` (:36-54) + `comparableItemsEqual` (:13-34)
- Modify: `crates/freshell-server/src/session_directory.rs` — `DirItem` (:102-162), `to_value` (:181-232), `apply_session_overrides` (:1051-1101), plus every `DirItem` constructor site
- Test: `crates/freshell-server/src/session_directory.rs` (overlay test mod, e.g. near :2707-3003)
- Test: `test/unit/server/coding-cli/session-indexer.test.ts` (provenance attach)
- Test: `test/integration/server/session-directory-router.test.ts` (wire passthrough; ensure revision/signature still fires on provenance change)
- Test: `test/unit/client/store/sessionsThunks.test.ts` (Redux-level pin: a
  directory refresh whose items carry the three fields lands them in
  `ctx.sessions` rows — follow this file's `fetchSidebarSessionsSnapshot`
  partial-mock convention at :22-29)

**Interfaces:**
- Consumes: existing override rows (`titleOverride`, `titleSource`), parsed titles, `title_source` (parsed guard).
- Produces: `SessionDirectoryItemSchema += { titleOverridden?; providerTitle?; titleOverrideSource?: 'user'|'ai'|'first-message'|'legacy'|'dir' }` on BOTH servers' responses; client `CodingCliSession` mirrors them. `matchedIn`-style `.optional()` semantics: absent means "not overridden / no provider title recorded".

- [ ] **Step 1: Write the failing behavioral test**

Rust — add beside the existing `apply_session_overrides` tests
(`session_directory.rs` test mods; build the `DirItem` with the same literal
those tests use, adding the three new fields defaulted):

```rust
#[test]
fn applied_title_override_exposes_provenance_on_the_wire() {
    let item = /* DirItem literal with title: Some("Provider native title".into()), title_source: None, new fields defaulted */;
    let mut overrides = serde_json::Map::new();
    overrides.insert(
        "claude:sess-1".to_string(),
        json!({ "titleOverride": "Accidental pane label", "titleSource": "user" }),
    );
    let out = apply_session_overrides(vec![item], &overrides);
    assert_eq!(out.len(), 1);
    let v = out[0].to_value();
    assert_eq!(v["title"], json!("Accidental pane label"));
    assert_eq!(v["titleOverridden"], json!(true));
    assert_eq!(v["providerTitle"], json!("Provider native title"));
    assert_eq!(v["titleOverrideSource"], json!("user"));
}

#[test]
fn non_applied_shadow_override_stays_invisible_to_provenance() {
    // parsed title_source: Some("provider-generated") + override titleSource:'dir':
    // guard suppresses the title write; provenance fields must stay absent.
}
```

Node — extend `test/unit/server/coding-cli/session-indexer.test.ts`
(follow its existing seeded-program/override fixture style):

```ts
it('exposes override provenance (titleOverridden/providerTitle/titleOverrideSource) on session rows', async () => {
  // arrange: a parsed session whose title is 'First prompt title' plus
  // sessionOverrides: { 'claude:<id>': { titleOverride: 'Accidental pane label', titleSource: 'user' } }
  // act: run the indexer's project listing (this file's entry point)
  // assert: row.title === 'Accidental pane label'
  //         row.titleOverridden === true
  //         row.providerTitle === 'First prompt title'
  //         row.titleOverrideSource === 'user'
  // and a control row with NO override carries NONE of the three fields
})
```

Node passthrough — extend `test/integration/server/session-directory-router.test.ts`:
build its app with a `codingCliIndexer.getProjects()` mock whose session object
ALREADY carries the three fields, GET the directory, and assert the wire item
contains them verbatim (this proves `projection.ts` + `service.ts` forward them
and the shared zod schema tolerates them).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/integration/server/session-directory-router.test.ts` and `cargo test -p freshell-server session_directory`

Expected: FAIL — fields absent everywhere today.

- [ ] **Step 3: Add the minimal production implementation**

`shared/read-models.ts` — inside `SessionDirectoryItemSchema`:

```ts
  /**
   * b5fb provenance exposure for the reviewed reset flow. `titleOverridden` is
   * true exactly when a stored titleOverride currently applies to this row;
   * `providerTitle` is the parsed pre-override title (absent when none was
   * parsed); `titleOverrideSource` is the override row's titleSource
   * (absent when the override never recorded one).
   */
  titleOverridden: z.boolean().optional(),
  providerTitle: z.string().optional(),
  titleOverrideSource: z.enum(['user', 'ai', 'first-message', 'legacy', 'dir']).optional(),
```

`src/store/types.ts` `CodingCliSession` += `titleOverridden?: boolean`,
`providerTitle?: string`, `titleOverrideSource?: TitleSource` (the shared
`TitleSource` union — add `import type { TitleSource } from '../../shared/title-source'`).

`server/coding-cli/types.ts` `CodingCliSession` += the same three fields
(`titleOverrideSource?: TitleSource`, importing `TitleSource` from
`../../shared/title-source.js`).

`server/coding-cli/session-indexer.ts` `applyOverride` — set them exactly when
the override APPLIES:

```ts
function applyOverride(session, ov, titleSource?) {
  if (ov?.deleted) return null
  const shouldApplyTitleOverride = !!ov?.titleOverride
    && !(titleSource === 'provider-generated' && (ov.titleSource === 'dir' || ov.titleSource === 'first-message'))
  return {
    ...session,
    title: shouldApplyTitleOverride ? ov.titleOverride : session.title,
    summary: ov?.summaryOverride || session.summary,
    createdAt: ov?.createdAtOverride ?? session.createdAt,
    archived: ov?.archived ?? session.archived ?? false,
    titleSource,
    ...(shouldApplyTitleOverride
      ? {
          titleOverridden: true,
          providerTitle: session.title,
          titleOverrideSource: ov?.titleSource,
        }
      : {}),
  }
}
```

`server/session-directory/projection.ts`: add the three fields to
`toSessionDirectoryComparableItem`'s return object AND to `comparableItemsEqual`
(provenance changes must bump the directory revision so `sessions.changed` fires).

`src/lib/api.ts` — in BOTH mappers, forward the fields:

```ts
...(item.titleOverridden ? { titleOverridden: true } : {}),
...(item.providerTitle !== undefined ? { providerTitle: item.providerTitle } : {}),
...(item.titleOverrideSource ? { titleOverrideSource: item.titleOverrideSource } : {}),
```

`SearchResult` gains the same three optional fields. Same three forwards inside
`src/store/sessionsThunks.ts` `searchResultsToProjects` (against `result.*`).

`crates/freshell-server/src/session_directory.rs`:
- `DirItem` += `title_overridden: bool`, `provider_title: Option<String>`,
  `title_override_source: Option<String>` (doc-commented as wire-facing).
- `to_value` emits `"titleOverridden": true` only when true (mirroring the
  `isSubagent`/`isNonInteractive` convention), and the two optionals when Some.
- Every `DirItem {}` constructor site initializes the three fields (the
  compiler lists them all).
- `apply_session_overrides`, exactly when the override is applied (the existing
  `!t.is_empty() && !provider_generated_shadow` gate), also writes:

```rust
item.title_overridden = true;
item.title_override_source = ov
    .get("titleSource")
    .and_then(Value::as_str)
    .map(str::to_string);
// Capture the pre-overlay (parsed/provider-native) title BEFORE replacing it.
item.provider_title = item.title.clone();
item.title = Some(t.to_string());
```

(capture `item.title` into `provider_title` BEFORE the assignment replaces it;
leave it None when the parse had no title.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/integration/server/session-directory-router.test.ts` and `cargo test -p freshell-server session_directory`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

- `npm run contract:generate && git diff --exit-code -- port/contract` — must be
  a no-op (REST read-models are not the WS contract; this also catches an
  accidental WS-schema edit).
- `cargo fmt --all --check`.
- `npm run typecheck`.

- [ ] **Step 6: Run impacted-test verification**

Directory read-models feed sidebar/history/overview thunks and the E2E seeding
helpers.

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/ test/integration/server/session-directory-router.test.ts` ; `cargo test -p freshell-server session_directory` ; `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/sessionsSlice* test/unit/client/lib/`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add shared/read-models.ts src/store/types.ts server/coding-cli/types.ts server/coding-cli/session-indexer.ts server/session-directory/projection.ts crates/freshell-server/src/session_directory.rs test/unit/server/coding-cli/session-indexer.test.ts test/integration/server/session-directory-router.test.ts
git commit -m "feat(session-directory): expose title override provenance for reset flow (b5fb)"
```

### Task 7: "Reset to provider title" UI (reviewed reveal/reset flow)

Per Entry point parity with Rename: the item lives in BOTH the sidebar session
menu (`menu-defs.ts:610-652`) and the history session menu (:670-683). Gating:
`session.titleOverridden === true` AND `session.titleOverrideSource` is NOT
`'first-message'` and NOT `'dir'` (Tasks 6). The two exclusions prevent offering
a no-op reset that the auto-title sweep would instantly re-apply (the sweep's
only rungs), while still serving every user/ai/legacy/sourced-or-source-less
override — including accidental pane-era overrides with no recorded source.
Confirm dialog:
`ConfirmModal`-driven (`ContextMenuProvider`'s existing `setConfirmState`
pattern), body previewing current vs provider-native title; confirm issues
`PATCH /api/sessions/:key {titleOverride: null}` then refreshes the session
window. Error handling keeps the dialog open with `role="alert"` text
(SESSION-03 precedent).

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts` (MenuActions + two menus)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (resetSessionTitle handler, actions registration + memo deps)
- Modify: `src/store/titleSync.ts` (add `clearSessionTitleOverride` helper + the `api` import it needs)
- Test: `test/unit/client/components/context-menu/menu-defs.test.ts` (gating pins)
- Test: `test/unit/client/store/paneSessionTitleSync.test.ts` (helper PATCH pin — the file already wires the api mock)

**Interfaces:**
- Consumes: `session.titleOverridden` / `session.providerTitle` / `session.title` (Task 6), `ConfirmModal` (`src/components/ui/confirm-modal.tsx`), `refreshActiveSessionWindow` (`src/store/sessionsThunks.ts`).
- Produces: `MenuActions.resetSessionTitle(sessionId, provider?)`; exported `clearSessionTitleOverride(provider, sessionId): Promise<void>` in `src/store/titleSync.ts`.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/client/store/paneSessionTitleSync.test.ts` — append:

```ts
describe('clearSessionTitleOverride (reset to provider title)', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('PATCHes the session with titleOverride:null by composite key', async () => {
    await clearSessionTitleOverride('claude', 's1')
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/sessions/claude%3As1', { titleOverride: null })
  })

  it('propagates server errors (caller surfaces them in the dialog)', async () => {
    apiMocks.patch.mockRejectedValueOnce(new Error('500 boom'))
    await expect(clearSessionTitleOverride('opencode', 'z9')).rejects.toThrow('500 boom')
  })
})
```

(add `clearSessionTitleOverride` to the titleSync import at the top of the file.)

`test/unit/client/components/context-menu/menu-defs.test.ts` — add the action
to `createMockActions()` (`resetSessionTitle: vi.fn()`) and then:

```ts
describe('buildMenuItems — session reset-to-provider-title gating (b5fb)', () => {
  const target = { kind: 'sidebar-session', sessionId: 's1', provider: 'claude' } as ContextTarget

  function ctxWithSession(sessionOverrides: Record<string, unknown>) {
    const actions = createMockActions()
    const ctx = createMockContext(actions)
    ctx.sessions = [{
      projectPath: '/repo/x',
      sessions: [{
        provider: 'claude', sessionId: 's1', projectPath: '/repo/x', lastActivityAt: 1,
        title: 'Shown title', ...sessionOverrides,
      } as never],
    }] as never
    return { actions, ctx }
  }

  it('offers the reset item when the row carries titleOverridden', () => {
    const { ctx } = ctxWithSession({ titleOverridden: true, providerTitle: 'Native title', titleOverrideSource: 'user' })
    const items = buildMenuItems(target, ctx)
    const reset = items.find((i) => i.type === 'item' && i.id === 'session-reset-title')
    expect(reset).toBeTruthy()
  })

  it('omits the reset item for rows without an applied override', () => {
    const { ctx } = ctxWithSession({})
    const items = buildMenuItems(target, ctx)
    expect(items.some((i) => i.type === 'item' && i.id === 'session-reset-title')).toBe(false)
  })

  it('omits the reset item for sweep-rung overrides the sweep would instantly re-apply', () => {
    const { ctx } = ctxWithSession({ titleOverridden: true, titleOverrideSource: 'first-message', providerTitle: 'Native title' })
    const items = buildMenuItems(target, ctx)
    expect(items.some((i) => i.type === 'item' && i.id === 'session-reset-title')).toBe(false)
  })

  it('offers the reset item for historical overrides with NO recorded source (pane-era accidents)', () => {
    const { ctx } = ctxWithSession({ titleOverridden: true, providerTitle: 'Native title' })
    const items = buildMenuItems(target, ctx)
    expect(items.some((i) => i.type === 'item' && i.id === 'session-reset-title')).toBe(true)
  })

  it('offers the same item on the history-session menu', () => {
    const { ctx } = ctxWithSession({ titleOverridden: true, providerTitle: 'Native title' })
    const historyTarget = { kind: 'history-session', sessionId: 's1', provider: 'claude' } as ContextTarget
    const items = buildMenuItems(historyTarget, ctx)
    expect(items.some((i) => i.type === 'item' && i.id === 'history-session-reset-title')).toBe(true)
  })
})
```

(Adjust only if the file's `createMockContext` signature drifted; fixtures in
this test file are already `as never`-style partials.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/store/paneSessionTitleSync.test.ts`

Expected: FAIL — `clearSessionTitleOverride` is not exported; menu items absent.

- [ ] **Step 3: Add the minimal production implementation**

`src/store/titleSync.ts` — the file loses nothing from Task 1 and gains:

```ts
import { api } from '@/lib/api'
// ... existing exports ...

/**
 * Reviewed reset: clear the durable session title override AND its source so
 * the provider-native title is revealed and the title-source ladder unblocks.
 * Session-scoped by definition — called only from an explicit per-session
 * "Reset to provider title" action. (`PATCH /api/sessions/:key` with
 * `{titleOverride: null}`; servers now clear titleSource too.)
 */
export async function clearSessionTitleOverride(provider: string, sessionId: string): Promise<void> {
  const compositeKey = `${provider}:${sessionId}`
  await api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, { titleOverride: null })
}
```

`src/components/context-menu/menu-defs.ts`:
- `MenuActions` += `resetSessionTitle: (sessionId: string, provider?: string) => void` (next to `renameSession` :54).
- Sidebar menu (after `session-rename` at :628):

```ts
...(sessionInfo?.session.titleOverridden
    && sessionInfo.session.titleOverrideSource !== 'first-message'
    && sessionInfo.session.titleOverrideSource !== 'dir'
  ? [{
      type: 'item' as const,
      id: 'session-reset-title',
      label: 'Reset to provider title',
      onSelect: () => actions.resetSessionTitle(target.sessionId, target.provider),
    }]
  : []),
```

- History menu (after `history-session-rename` at :676): same block with id `history-session-reset-title`.

`src/components/context-menu/ContextMenuProvider.tsx`:

```tsx
const resetSessionTitle = useCallback((sessionId: string, provider?: string) => {
  const info = getSessionInfo(sessionId, provider, menuState?.target)
  if (!info) return
  const resolvedProvider = provider || info.session.provider || 'claude'
  setConfirmState({
    title: 'Reset to provider title?',
    confirmLabel: 'Reset title',
    body: (
      <div className="space-y-2">
        <div className="text-xs">This removes the custom title override for this session only. A backup of the previous config is kept in config.backup.json.</div>
        <div className="text-xs">Current title: {info.session.title || '(untitled)'}</div>
        <div className="text-xs">Provider title: {info.session.providerTitle || '(none yet — the next generated title will show)'}</div>
      </div>
    ),
    onConfirm: async () => {
      try {
        await clearSessionTitleOverride(resolvedProvider, sessionId)
      } catch (err) {
        // SESSION-03: failed reset must not LOOK like success — keep the
        // dialog open and announce the failure.
        const message = err instanceof Error ? err.message : 'Reset failed'
        setConfirmState((prev) =>
          prev ? { ...prev, error: `Failed to reset title: ${message}` } : prev,
        )
        return
      }
      setConfirmState(null)
      await dispatch(refreshActiveSessionWindow() as any)
    },
  })
}, [dispatch, getSessionInfo, menuState?.target])
```

Register `resetSessionTitle` in the actions object (:1352 area) and its
`useCallback` memo dependency (:1424 area). Do NOT call
`applySessionRenameCascade` after a clear — a clear has no new title to mirror,
and pane labels remain pane-scoped.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/store/paneSessionTitleSync.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

`npm run lint` (a11y: the menu item is a native `role="menuitem"` button via
`ContextMenu`; the dialog reuses `ConfirmModal` — no new a11y surface, but the
lint must stay clean) and `npm run typecheck`.

- [ ] **Step 6: Run impacted-test verification**

ContextMenuProvider and menu-defs underpin every context menu.

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/` and `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/context-menu/menu-defs.ts src/components/context-menu/ContextMenuProvider.tsx src/store/titleSync.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/store/paneSessionTitleSync.test.ts
git commit -m "feat(ui): reviewed Reset to provider title flow for session rows (b5fb)"
```

### Task 8: Browser-level convergence spec rewritten to the scope contract

`test/e2e-browser/specs/title-sync-convergence.spec.ts` runs on BOTH
`legacy-chromium` (Node) and `rust-chromium` (Rust) — it is the cross-server
parity leg for this work item. Journey rewrites:

- Test 1 "pane header rename converges the sidebar" → INVERTED: pane header
  rename converges the pane header AND single-pane tab label; the sidebar row
  keeps its first-message title (never the pane label).
- Test 2 "sidebar context-menu rename converges the pane header" → UNCHANGED
  (explicit session rename: session→pane mirror still converges).
- Test 3 "automation PATCH /api/panes/:id converges pane header + tab + sidebar"
  → INVERTED sidebar leg (header + tab converge; sidebar keeps provider title).
- Test 4 "history-view rename converges the pane" → UNCHANGED.
- Test 5 "Overview inline rename converges pane + sidebar" → INVERTED sidebar
  leg (the terminal rename stops being session-scoped everywhere).
- NEW Test 6: single-pane TAB rename (dblclick → type → Enter, per
  `tab-management.spec.ts:97`) → tab label converges; sidebar keeps provider title.
- NEW Test 7: reset flow journey — explicit sidebar rename to a custom title,
  THEN "Reset to provider title" via context menu + ConfirmModal; sidebar
  reverts to the provider title; the reset item disappears afterwards.

**Files:**
- Modify: `test/e2e-browser/specs/title-sync-convergence.spec.ts`

**Interfaces:**
- Consumes: the spec's existing fixtures (`test = base.extend(...)`,
  `testServer`, `resumeSeededSession`, `sidebarRow`, `visiblePaneHeader`),
  `playwright.config.ts` project matrix (unchanged), Task 6 wire fields, Task 7
  menu item + dialog.
- Produces: two new seeded sessions `SESSION_TAB_RENAME` (…c606) and
  `SESSION_RESET` (…c707) in `SEEDED_SESSIONS` (directories `convergence-zeta`,
  `convergence-eta`); header comment rewritten to cite the new contract doc.

- [ ] **Step 1: Write the failing behavioral test**

Semantic rewrites (full code, using the file's existing helpers):

```ts
// Header comment replacement: describe the b5fb scope contract and cite
// docs/development/rename-scope-contract.md + the spec's twin role as the
// legacy/rust parity leg. Delete the EDEV-09-based header.

const SESSION_TAB_RENAME = '00000000-0000-4000-8000-00000000c606'
const SESSION_RESET = '00000000-0000-4000-8000-00000000c707'
// SEEDED_SESSIONS gains:
// { id: SESSION_TAB_RENAME, dirName: 'convergence-zeta', firstMessage: 'convergence zeta tab rename journey' },
// { id: SESSION_RESET, dirName: 'convergence-eta', firstMessage: 'convergence eta reset journey' },

// Test 1 rewrite:
test('pane header rename stays pane-local; the sidebar keeps the provider title', async ({ freshellPage, page, harness }) => {
  const NEW_NAME = 'Pane Rename Target One'
  await resumeSeededSession(page, harness, SESSION_PANE_RENAME)
  // Baseline: the sidebar shows the first-message title before any rename.
  await expect(sidebarRow(page, SESSION_PANE_RENAME)).toContainText('convergence alpha pane rename journey', { timeout: 15_000 })

  const header = visiblePaneHeader(page)
  await header.dblclick()
  const renameInput = page.getByLabel('Rename pane')
  await renameInput.fill(NEW_NAME)
  await renameInput.press('Enter')

  await expect(visiblePaneHeader(page)).toContainText(NEW_NAME, { timeout: 10_000 })
  // Deliberate settle: if any stray cascade/sync existed, a sessions.changed
  // refetch would flip the row well inside this window.
  await page.waitForTimeout(3000)
  await expect(sidebarRow(page, SESSION_PANE_RENAME)).toContainText('convergence alpha pane rename journey')
  await expect(sidebarRow(page, SESSION_PANE_RENAME)).not.toContainText(NEW_NAME)
})

// Test 3 rewrite: same journey as today, sidebar assertions inverted:
//   await expect(sidebarRow(page, SESSION_AUTOMATION_RENAME)).toContainText('convergence gamma automation rename journey', ...)  // baseline first
//   ... PATCH pane, assert pane header + tab converge (unchanged) ...
//   await page.waitForTimeout(3000)
//   await expect(sidebarRow(...)).toContainText('convergence gamma automation rename journey')
//   await expect(sidebarRow(...)).not.toContainText(NEW_NAME)

// Test 5 rewrite (Overview): header converges; sidebar keeps
// 'convergence epsilon overview rename journey' and never gains NEW_NAME.

// Test 6 (new):
test('tab rename stays tab-local; the sidebar keeps the provider title', async ({ freshellPage, page, harness }) => {
  const NEW_NAME = 'Tab Rename Target Six'
  const { tabId } = await resumeSeededSession(page, harness, SESSION_TAB_RENAME)
  await expect(sidebarRow(page, SESSION_TAB_RENAME)).toContainText('convergence zeta tab rename journey', { timeout: 15_000 })
  const tab = page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)
  await tab.dblclick()
  const input = tab.locator('input')
  await expect(input).toBeVisible({ timeout: 5_000 })
  await input.fill(NEW_NAME)
  await input.press('Enter')
  await expect(tab.getByText(NEW_NAME)).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(3000)
  await expect(sidebarRow(page, SESSION_TAB_RENAME)).toContainText('convergence zeta tab rename journey')
  await expect(sidebarRow(page, SESSION_TAB_RENAME)).not.toContainText(NEW_NAME)
})

// Test 7 (new):
test('explicit rename can be reset to the provider title from the context menu', async ({ freshellPage, page, harness }) => {
  await resumeSeededSession(page, harness, SESSION_RESET)
  const row = sidebarRow(page, SESSION_RESET)
  await expect(row).toContainText('convergence eta reset journey', { timeout: 15_000 })

  page.once('dialog', (dialog) => { void dialog.accept('Custom Reset Target') })
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await expect(row).toContainText('Custom Reset Target', { timeout: 15_000 })

  await row.click({ button: 'right' })
  const resetItem = page.getByRole('menuitem', { name: 'Reset to provider title' })
  await expect(resetItem).toBeVisible({ timeout: 5_000 })
  await resetItem.click()

  const dialog = page.getByRole('dialog', { name: 'Reset to provider title?' })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog).toContainText('Current title: Custom Reset Target')
  await expect(dialog).toContainText('Provider title: convergence eta reset journey')
  await dialog.getByRole('button', { name: 'Reset title' }).click()

  await expect(row).toContainText('convergence eta reset journey', { timeout: 15_000 })
  // Deterministic close-out: the sweep may re-apply a 'first-message' override
  // within ~2s, but the menu gate excludes that rung (Task 7), so the item
  // stays absent regardless of sweep timing.
  await row.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Reset to provider title' })).toHaveCount(0)
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

The spec rewrite lands after Tasks 1-7, so demonstrate RED by temporarily
reverting the production side only (test file stays). Keep `crates/` OUT of the
stash: this worktree lacks `target/release/freshell-server` and the
rust-chromium harness auto-builds it (`e2e-browser/helpers/rust-server.ts`), so
reverting crates would cost two full release builds. The legacy-chromium leg
(Node server) produces the RED with zero Rust involvement:

```bash
git stash push -- src server shared && \
npx playwright test --config test/e2e-browser/playwright.config.ts title-sync-convergence --project=legacy-chromium; \
git stash pop
```

Expected under the stash: FAIL on inverted Tests 1/3/5/6 (the old
cascades/sync flip the sidebar row to the organization label) and on Test 7
(the reset menu item does not exist). Tests 2/4 were session-scope and keep
passing. Record this RED evidence in the task ledger, then restore. GREEN then
runs the full matched matrix without `--project` flags.

- [ ] **Step 3: Add the minimal production implementation**

No new production code — this task is the browser-level convergent evidence for
Tasks 1-7. The implementation is the completed spec file above.

- [ ] **Step 4: Run the focused test**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts title-sync-convergence`

Expected: PASS on every matched project (`chromium`, `legacy-chromium`,
`rust-chromium`).

- [ ] **Step 5: Refactor while green**

Read the four untouched sibling specs that share the fixtures
(`restore-matrix.spec.ts`, `auto-title-rust.spec.ts`, `tab-management.spec.ts`,
`session-directory-matrix.spec.ts`) only if a shared-helper signature forced a
change — none does.

- [ ] **Step 6: Run impacted-test verification**

The spec seeds + harness are shared by the matrix.

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium auto-title-rust` (the auto-title suite shares the seeded claude corpus and the sweep conditions this spec relies on)

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/title-sync-convergence.spec.ts
git commit -m "test(e2e): pin the pane/tab/tab-organisation scope contract and the reset flow (b5fb)"
```

### Task 9: Contract documentation + deviations ledger + full suite

**Files:**
- Create: `docs/development/rename-scope-contract.md`
- Modify: `AGENTS.md` (one pointer line)
- Modify: `port/oracle/DEVIATIONS.md` (EDEV-09 amended; EDEV-10 / EDEV-11 marked REMOVED)

**Interfaces:**
- Consumes: the actual final behavior from Tasks 1-8 (the doc DESCRIBES landed code, never intent).
- Produces: the single documented scope contract this work item's acceptance criteria demand ("Client Redux, REST, WebSocket events, cross-device sync, and Rust server persistence use one documented scope contract").

- [ ] **Step 1: Write the failing behavioral test**

Docs are the deliverable; the failing check is the full coordinated suite before
docs exist. Skip to Step 2 — the RED evidence is today's suite state plus the
missing-doc state. (No test may assert on doc text per the repo quality bar.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run check` — **expected exit 1 with ONLY the three baseline
`getNetworkHost` identities.** This is the oracle reruns note for the run-state.

- [ ] **Step 3: Add the minimal production implementation**

`docs/development/rename-scope-contract.md`:

```markdown
# Rename Scope Contract (naming ownership)

Freshell shows several names for one underlying object. Each name has exactly
one owner and each rename surface writes exactly one scope:

| Scope | Owned by | Written by | Persists |
| --- | --- | --- | --- |
| Pane label | the pane (layout snapshot) | pane header inline rename; `PATCH /api/panes/:id` (agent API / MCP) | layout snapshot only |
| Tab label | the tab (layout organization) | TabBar inline rename; `PATCH /api/tabs/:id` | layout snapshot only |
| Terminal title | the terminal process | `PATCH /api/terminals/:id` (Overview card / terminal context menu) | `terminalOverrides[terminalId]` |
| Session title | the durable provider session | `PATCH /api/sessions/:key` (sidebar/history "Rename") | `sessionOverrides["provider:sessionId"]` |

Hard rules:

1. **Pane/tab renames never write terminal or session overrides.** The client
   `applyPaneRename`/`applyTabRename` thunks are Redux-only; the agent-API
   `PATCH /api/panes/:id` writes the layout store and broadcasts
   `ui.command{pane.rename}` with NO other side effect; nothing else PATCHes on
   a local rename. A stopped/exited pane with a retained `sessionRef` obeys the
   same rule — there is no "sessionRef fallback" write.
2. **`PATCH /api/sessions/:key` is the ONLY durable session-rename surface.**
   A non-empty `titleOverride` writes `{titleOverride, titleSource:"user"}` and
   cascades to the LIVE terminal running that session (terminal override +
   registry + `terminals.changed` + `cascadedTerminalId` in the response, then
   `sessions.changed`). `{"titleOverride": null}` REMOVES both `titleOverride`
   and `titleSource` — a leftover `titleSource:"user"` would permanently
   finalize the row at the top ladder rung and block all future automatic
   titles (both servers share this semantics).
3. **Terminal renames are terminal-scoped on both servers** and never cascade
   into session overrides (live OR retired identities). Rust ==
   Node here since b5fb; the older pane-rename cascade divisions EDEV-10 and
   EDEV-11 were removed, and `persistSyncableTerminalRename` is gone.
4. **Reset to provider title** (sidebar/history context menu, shown when the
   directory row reports `titleOverridden` and the override's source is not a
   sweep rung (`first-message`/`dir` — those would be re-applied instantly)):
   previews current vs
   provider-native title, then issues `{titleOverride: null}`. The directory
   wire carries `titleOverridden`, `providerTitle`, `titleOverrideSource` for
   this flow (Task 6/Task 7 of the b5fb plan). Reset does NOT rewrite any
   open terminal/pane title — those surfaces are their own scopes.
5. **Provider-title updates and the auto-title sweep never flip a `user`-rung
   override**, and pane/tab labels can no longer mint one — so provider titles
   update in history exactly until a user makes an explicit session rename.
6. **No title-equality inference, ever.** Identity is `provider + sessionId`;
   two same-titled rows are two sessions. No dedup, group, or cleanup infers
   sameness from equal titles.
7. **No mass migration of existing overrides.** Historical provenance is
   ambiguous; the reviewed per-session reset flow plus the existing
   one-generation `config.backup.json` (refreshed on every persist) are the
   recoverable path. The `titleSource` ladder (`shared/title-source.ts`)
   still governs all automatic writers.
```

`AGENTS.md` — add one pointer line at the end of the
`### Key Architectural Patterns` list (after the `**Pane System:** ...`
paragraph, matching house style):

```markdown
**Rename scope contract:** pane/tab labels are layout-local; only an explicit session rename writes a durable session title (terminal renames are terminal-scoped). The four name scopes and the reset-to-provider-title flow live in [docs/development/rename-scope-contract.md](docs/development/rename-scope-contract.md).
```

`port/oracle/DEVIATIONS.md`:
- EDEV-09 — append one line: `> Update (b5fb): the pane→server alignment this
  entry introduced is REMOVED by the rename scope contract
  (docs/development/rename-scope-contract.md): pane/tab renames no longer PATCH
  anything server-side and the D8 exited-terminal sessionRef fallback is gone.
  The session→pane mirror (`applySessionRenameCascade`) remains legitimate.`
- EDEV-10 — retitle as `### EDEV-10 — REMOVED (b5fb)` and append: the whole
  pane-rename persistence cascade was deleted on both servers; the divergence
  no longer exists. (Keep the historical entry text below the banner.)
- EDEV-11 — same treatment: `### EDEV-11 — REMOVED (b5fb)`; the `sessionRef`
  superset read is gone because the cascade itself is gone.

- [ ] **Step 4: Run the focused test**

Run: `npm run lint && npm run typecheck`

Expected: PASS (docs touch no code; lint covers AGENTS-adjacent markdown loosely
via eslint on src only — PASS expected either way).

- [ ] **Step 5: Refactor while green**

Re-read the doc against the merged code of Tasks 1-8 once; fix any drift.

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run check` (the full coordinated suite — typecheck + default-config +
server-config vitest).

Expected: exits nonzero ONLY on the three baseline identities
(`test/unit/vite-config.test.ts > getNetworkHost > ignores HOST env when
configured`, `... > returns 127.0.0.1 when config file does not exist`,
`... > returns 127.0.0.1 when config has no network settings`); zero other
failures. Then: `cargo fmt --all --check`.

- [ ] **Step 7: Commit the task**

```bash
git add docs/development/rename-scope-contract.md AGENTS.md port/oracle/DEVIATIONS.md
git commit -m "docs: rename scope contract + deviations ledger updates (b5fb)"
```

---

## Acceptance-criteria traceability

| Work-item criterion | Plan task(s) / evidence |
| --- | --- |
| Pane rename (live; exited w/ sessionRef; reuse A→B→C) | Task 1 client pins; Task 2 agent-API pins; Task 5 Rust pins incl. pane-reuse; Task 8 Test 1 |
| Tab rename (single-pane mirror; multi-pane untouched) | Task 1 pins (single-pane local mirror retained); Task 2 tab pin; Task 8 Test 6 |
| Agent API rename (REST + MCP surfaces) | Task 2 (Node) + Task 5 (Rust); MCP `freshell` tool inherits the REST route fix |
| Explicit durable session rename + clear reveals provider title | Tasks 3, 4 (clear fix both servers); existing session→terminal cascade retained on both; Task 8 Tests 2/4 unchanged + Test 7 reset journey |
| Provider title updates visible absent explicit rename | No change to sweep/ladder; ladder-unblock proven by Task 3 `config-store.ladder` pin + Task 4 Rust pin; shadow guard unchanged |
| History distinguishability (no growth + recoverable reset) | Cascades removed (Tasks 1-5) stop growth; Tasks 6-8 provide reveal/reset; no equal-title inference introduced anywhere |
| Same session across panes/devices | `applySessionRenameCascade` path untouched (Task 1 comment; Task 8 Test 2) |
| Pre-ID live rows never retro-persist | Task 1 pre-ID pin (no sessionId → nothing to write, and no replay path exists because the sync machinery is deleted) |
| Client/server documented contract | Task 9 doc + AGENTS.md link; Node aligned (no divergence recorded — EDEV-10/11 removed, not added) |
| Data migration safety | No mass migration (Task 9 rule 7); per-session reviewed reset (Tasks 6-8); config-store ladder pin (Task 3); Rust store pin (Task 4); backup = existing `config.backup.json` refresh on persist (rule 7 documents) |
| Sidebar identity/keying (titles not identity) | Unchanged `data-session-id` keying; negative: pane/tab renames never mint same-titled rows anymore (Tasks 1-2, 5, 8) |
| Restart/config persistence | Task 3 Test 4 reads the on-disk config.json; Task 4 store assertions |
