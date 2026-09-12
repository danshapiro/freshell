# MCP Focus Neutrality Implementation Plan

> **EXECUTED.** All tasks below have landed on branch
> `the-usual/mcp-focus-neutrality` in
> `/home/dan/code/freshell/.worktrees/mcp-focus-neutrality` (GREEN-verified and
> committed per task: Tasks 1–5 as `682ef8991`, `f9a7de069`, `dff5158e8`,
> `91b70bfca`, `d92154fca`; plus `4a5e09aaa` tab-focus-behavior repair,
> `e4b9b59ce` Task 6 inert gate, and the delta-round-2 followups). The checkbox
> steps are retained unchecked as historical detail — do not re-execute them.

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Agent/MCP/REST-driven tab and pane creation must never change which
tab or pane the user has focused; focus changes only via the explicit select
commands (`select-tab` / `select-pane`).

**Architecture:** Client-side fix in three layers. (1) `addTab` and
`splitPane` reducers gain an `activate?: boolean` flag (default: activate;
one bootstrap exception), and `handleUiCommand` marks the server-broadcast
`tab.create`/`pane.split` arms as non-activating while leaving the explicit
`tab.select`/`pane.select` arms untouched. (2) Every pane-content mount-time
DOM focus site (terminal, browser URL bar, editor, pane picker, directory
picker) is gated on `focusEligible` (`!hidden && activePane === node.id`), so
background-created panes mount quietly without stealing keyboard focus.
(3) `captureUiScreenshot`'s `restoreFocus` is hardened so it never resurrects
deleted tabs/panes and honestly reports `restoredFocus:false`. No server or
wire changes are needed: both servers (Node and Rust) broadcast identical
`ui.command` frames to every client, and `payload` is free-form in the frozen
schema — the `activate` flag lives only in *client* action payloads, never on
the wire.

**Tech Stack:** React 18 + Redux Toolkit client, Vitest + Testing Library for
unit/component tests, Playwright e2e against the owned RustServer wall harness.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/mcp-focus-neutrality`;
  branch `the-usual/mcp-focus-neutrality`; original base `f2c7ef7a`
  (origin/main), rebased mid-run onto `5b8717017` (upstream delta was
  doc-only: AGENTS.md rule lines + a skill deletion). All commands run from
  the worktree root.
- **Env sanitization is mandatory** for every test/build command in this run
  (we run inside a live Freshell pane and leaked vars break tests, e.g.
  `FRESHELL_BIND_HOST` poisons `test/unit/vite-config.test.ts`). Prefix every
  command with:
  `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL`
  Task 8 addendum: when the invoking shell ALSO exports `NODE_USE_ENV_PROXY=1`
  + `HTTPS_PROXY` (agent harness proxy), every spawned Node child prints the
  experimental UNDICI `EnvHttpProxyAgent` warning to stderr, breaking
  stderr-emptiness assertions (`test/e2e/update-flow.test.ts`,
  `test/unit/lib/visible-first-audit-gate.test.ts` — 5 tests). Add
  `-u NODE_USE_ENV_PROXY -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy`
  for full-suite runs from such shells.
- Focused unit/component test command shape:
  `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run <files...> --config config/vitest/vitest.config.ts`
- E2E command shape (Rust-only specs) — execution goes through the backend
  wrapper (see the "E2E backend policy" bullet below); discovery-only
  `--list` flags may run plain Playwright:
  `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL bash scripts/e2e-cloud.sh run --local --project=rust-chromium <spec-basename>`
  The wall harness boots its OWN RustServer on an ephemeral port — never touch
  the live self-hosted server (port 3001).
- **As-built (rounds 21–24 supersede the original client-only plan; the
  2026-09-09 simplification supersedes the round-21–27 screenshot machinery):
  this delta changes BOTH servers and the client.** Server-side: the two layout
  stores hold focus-neutral cursors for agent creates/splits
  (`server/agent-api/layout-store.ts`, `crates/freshell-freshagent/src/layout_store.rs`);
  the screenshot round-trip carries NO budget/cancel protocol anymore — the
  client renders through an off-DOM clone and never mutates UI, so the servers
  (`server/ws-handler.ts`, `crates/freshell-ws/src/screenshot.rs`,
  `crates/freshell-server/src/screenshots.rs`) just broadcast the capture frame
  and await the reply. Deployment therefore requires
  rebuilding + restarting the Rust server (`scripts/launch-rust.sh`), not a
  client-only refresh. Task 5's doc-string edit in `server/mcp/freshell-tool.ts`
  (agent-facing instructions) still ships with the MCP server binary as before.
  The frozen WS contract
  (`port/contract/ws-server-messages.schema.json:3205-3221`, `"payload": true`)
  remains untouched: the screenshot payload is free-form in the schema, no
  shape change on either side.
- **Base sync first.** At plan-write time the branch is 2 commits behind
  `origin/main`. Before executing Task 1: `git fetch origin` and
  fast-forward/rebase the branch onto `origin/main`, update run-state's base
  note. NOTE: the upstream delta DOES touch root `AGENTS.md` (a Task 5 edit
  site) — after syncing, re-verify that file's Fresh-Agent Orchestration
  paragraph anchor before applying Task 5's sentence, and refresh any shifted
  line anchors cited in this plan.
- **E2E backend policy.** All e2e EXECUTION goes through the backend wrapper
  (`bash scripts/e2e-cloud.sh run --local …` shown below; substitute
  `--cloud` when the configured `FRESHELL_E2E_BACKEND` is `cloud`). Discovery
  commands (`--list`) run plain Playwright directly — they never execute
  tests. Per repo policy the backend choice (`FRESHELL_E2E_BACKEND` /
  `FRESHELL_VITEST_BACKEND`) is pinned by the user before Stage 4
  (local = free/slower, cloud = ~$0.03/run/parallel).
- Default-`true` semantics preserve every local/user-driven flow (tab-bar "+",
  pane "+", picker, keyboard shortcuts, drag-splits): all existing reducer and
  component tests must keep passing unchanged. The only behavior change is for
  server-broadcast creates and background-mounted panes.
- Conventional commits, one per task. Never force-push. Do NOT open a PR
  without explicit user approval.
- Repository rule: root `AGENTS.md` MUST be updated (Task 5) since this
  changes documented behavior; `docs/index.html` needs no change (invisible
  in the mock).

## Current behavior / root-cause evidence

All line numbers verified in the worktree at base `f2c7ef7a`, re-checked against
the visible post-rebase state (`5b8717017`) during delta review followups.

1. **Redux activation (the primary steal).** The `addTab` reducer
   unconditionally sets `state.activeTabId = id` (`src/store/tabsSlice.ts:323`);
   the `splitPane` reducer unconditionally sets
   `state.activePane[tabId] = newPaneId` (`src/store/panesSlice.ts:1199`).
   Agent-driven creation arrives client-side as broadcast `ui.command`
   messages folded in `handleUiCommand` (`src/lib/ui-commands.ts:68-141`):
   `tab.create` → `addTab(...)` (L79-108), `pane.split` → `splitPane(...)`
   (L115-122). The explicit-focus verbs already exist: `tab.select` →
   `setActiveTab` (L109-110); `pane.select` → `setActiveTab` +
   `setActivePane` (L125-127). Server emission points: Node REST
   `server/agent-api/router.ts` (tab.create at :700/:771-785/:796-810,
   pane.split at :1280/:~1373) via `broadcastUiCommand`
   (`server/ws-handler.ts:3896-3898`, fans out to ALL sockets via `broadcast()`
   at :3879-3885); Rust `crates/freshell-freshagent/src/lib.rs:1856-1876`
   (broadcast_tab_create) and `pane_ops.rs` (select_pane/:339-382,
   tab.select/:~404). MCP funnels through the same REST surface
   (`server/mcp/freshell-tool.ts`: new-tab :655-681, split-pane :725-738,
   select-tab :697-703, select-pane :752-755) — fixing the client's fold fixes
   REST and MCP together.
2. **DOM focus steal (secondary).** All tab contents stay mounted behind the
   `.tab-hidden` CSS class. Mount-time focus sites that ignore visibility:
   - `TerminalView.tsx:1711-1713` — `flushScheduledLayout` runs
     `if (shouldFocus) term.focus()` ungated, fed by
     `requestTerminalLayout({ fit: true, focus: true })` at mount (:2300).
     (The OTHER focus effect at :1275-1285 IS gated by
     `shouldFocusActiveTerminal = !hidden && activeTabId === tabId &&
     activePaneId === paneId` at :1272 — do not touch it.)
   - `PanePicker.tsx:211-214` — unconditional container focus on mount.
   - `EditorPane.tsx:295-298` — `handleEditorMount` unconditionally calls
     `editor.focus()`.
   - `BrowserPane.tsx:435-441` — focuses the URL input when `url` is empty.
   - `DirectoryPicker.tsx:77-80` — unconditional input focus+select on mount.
   The threading seam is `PaneContainer.tsx`: `renderContent` is called once
   at :548 from the leaf branch with `hidden` and `activePane` both in scope
   (:525 `isActive={activePane === node.id}`).
3. **Screenshot restore (adjacent hardening).** `restoreFocus`
   (`src/lib/ui-screenshot.ts:293-320`, module-private) dispatches
   `setActivePane`/`setActiveTab` toward snapshot ids without checking the
   target still exists — a tab/pane deleted mid-capture gets resurrected as a
   stale `activePane`/`activeTabId` entry, blanking the work area.

## Stage-2 load-bearing validation — results (2026-08-25)

Validators dispatched one-assumption-per-subagent; full evidence in
`.worktrees/.the-usual-logs/mcp-focus-neutrality/load-bearing-ledger.md`.

1. **CONFIRMED with correction:** `handleUiCommand` (fed by WS frames only)
   is the single fold; every Node `ui.command` emission arm is agent-surface
   (`server/agent-api/router.ts` callers of `broadcastUiCommand`
   `server/ws-handler.ts:3896-3898`; `screenshot.capture` unicast at :1121-1130).
   No client code folds HTTP-response `uiCommand` payloads (`src/` has zero
   camelCase `uiCommand` references). Correction: the Rust server DOES embed
   `uiCommand` in HTTP responses (`crates/freshell-freshagent/src/terminal_tabs.rs:311,2293`)
   but only via `create_terminal_or_content_tab_deferred` (:181-186), which
   has ZERO callers (the `POST /api/tabs-sync/restore` consumer was never
   implemented) — unreachable dead code, irrelevant to this change.
2. **REVISED (plan updated):** hidden-pane-rebind-rust was NOT the only
   steal-reliant spec. Validator found three more: restore-contract-wall-rust
   (:2326-2331, :573ff), git-badges-rust (:194-196), sidebar-registry-sync-rust
   (case-c :339-341). All repairs are now in Task 1 Step 6.
3. **CONFIRMED:** no test asserts activation as the outcome of a ui.command
   tab.create/pane.split fold (`ui-commands.test.ts` asserts action types;
   `tabsPersistence.test.ts:488-514` asserts persistence outcomes only; server
   ws tests touch screenshot.capture only).
4. **CONFIRMED with FreshAgentView note:** the four gated components render
   ONLY via PaneContainer renderContent (no modal/onboarding callers), direct
   test renders get the default `focusEligible=true`, and no pre-existing test
   asserts focus behavior in hidden/non-active state. FreshAgentView needs no
   prop: it self-gates via `isActivePane = !hidden && activeTabId === tabId &&
   activePaneId === paneId` (FreshAgentView.tsx:652-658) and its focus effect
   early-returns when inactive (:2277-2291).

---

### Task 1: Focus-neutral Redux activation — `activate` flag + `ui.command` fold + e2e repair

**Files:**
- Modify: `src/store/tabsSlice.ts` (AddTabPayload at :274-290; addTab reducer at :296-324)
- Modify: `src/store/panesSlice.ts` (splitPane at :1163-1213)
- Modify: `src/lib/ui-commands.ts` (tab.create arm :79-108; pane.split arm :115-122)
- Test: `test/unit/client/store/tabsSlice.test.ts` (extend `describe('addTab')`, :56+)
- Test: `test/unit/client/store/panesSlice.test.ts` (extend `describe('splitPane')`, :612+)
- Test: `test/unit/client/ui-commands.test.ts` (192-line dispatch-capture file; extend + append integration describe)
- Test (repair, same commit): `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts` (:230-232 and :329-332), `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (:2326-2331 and :573ff), `test/e2e-browser/specs/git-badges-rust.spec.ts` (:194-196), `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` (case-c, before :339)

**Interfaces:**
- Consumes: existing reducers `addTab`, `splitPane`; existing `handleUiCommand` command arms; existing `revealTab(page, harness, tabId)` helper in the e2e spec (:190-200).
- Produces: `AddTabPayload.activate?: boolean`; `splitPane` payload `activate?: boolean`. Semantics: omitted/`true` = current activating behavior; `false` = insert without touching `activeTabId` / `activePane[tabId]`, EXCEPT `addTab` still activates when it creates the very first tab (bootstrap edge: `App.tsx` has no other promoter, so an empty-tabs client fed a silent create would otherwise show nothing).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/client/store/tabsSlice.test.ts`, inside `describe('addTab')`:

```ts
    it('activate: false does not change the active tab', () => {
      let state = tabsReducer(initialState, addTab({ title: 'One' }))
      const firstActiveId = state.activeTabId
      state = tabsReducer(state, addTab({ title: 'Two', activate: false }))

      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabId).toBe(firstActiveId)
    })

    it('activate: false still activates when this is the first tab (bootstrap edge)', () => {
      const state = tabsReducer(initialState, addTab({ title: 'Only', activate: false }))
      expect(state.tabs).toHaveLength(1)
      expect(state.activeTabId).toBe(state.tabs[0].id)
    })
```

Add to `test/unit/client/store/panesSlice.test.ts`, inside `describe('splitPane')`:

```ts
    it('activate: false keeps the current active pane', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: originalPaneId,
          direction: 'horizontal',
          newPaneId: 'pane-new',
          newContent: { kind: 'terminal', mode: 'claude' },
          activate: false,
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(split.type).toBe('split')
      expect((split.children[1] as Extract<PaneNode, { type: 'leaf' }>).id).toBe('pane-new')
      expect(state.activePane['tab-1']).toBe(originalPaneId)
      // Zoom-clear and title bookkeeping stay unconditional (layout invariants, not focus):
      expect(state.paneTitles['tab-1']['pane-new']).toBeDefined()
    })
```

Add to `test/unit/client/ui-commands.test.ts` (inside the existing `describe('handleUiCommand')`):

```ts
  it('tab.create dispatches addTab with activate: false (agent actions must not steal focus)', () => {
    const actions: any[] = []
    const dispatch = (action: any) => { actions.push(action); return action }

    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't1', title: 'Alpha' } }, dispatch)

    expect(actions[0].type).toBe('tabs/addTab')
    expect(actions[0].payload.activate).toBe(false)
  })

  it('pane.split dispatches splitPane with activate: false', () => {
    const actions: any[] = []
    const dispatch = (action: any) => { actions.push(action); return action }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.split',
      payload: { tabId: 't1', paneId: 'p1', direction: 'horizontal', newPaneId: 'p2', newContent: { kind: 'terminal', mode: 'shell' } },
    }, dispatch)

    expect(actions[0].type).toBe('panes/splitPane')
    expect(actions[0].payload.newPaneId).toBe('p2')
    expect(actions[0].payload.activate).toBe(false)
  })
```

Append a new integration describe at the END of `test/unit/client/ui-commands.test.ts` (folding real reducers proves the whole wire→state path, mirroring `tabsPersistence.test.ts`'s makeStore pattern at :35-55):

```ts
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../../src/store/tabsSlice'
import panesReducer from '../../../src/store/panesSlice'

describe('ui.command focus neutrality through a real Redux store', () => {
  function makeUiStore() {
    return configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'tab-A',
            createRequestId: 'req-A',
            title: 'Tab A',
            status: 'running' as const,
            mode: 'shell' as const,
            shell: 'system' as const,
            createdAt: 1,
          }],
          activeTabId: 'tab-A',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-A': { type: 'leaf' as const, id: 'pane-A1', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-A1' } },
          },
          activePane: { 'tab-A': 'pane-A1' },
          paneTitles: { 'tab-A': { 'pane-A1': 'Tab A' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as any,
    })
  }

  it('tab.create never activates; explicit tab.select still does', () => {
    const store = makeUiStore()
    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 'tab-B', title: 'Agent tab' } }, store.dispatch)
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['tab-A', 'tab-B'])
    expect(store.getState().tabs.activeTabId).toBe('tab-A')

    handleUiCommand({ type: 'ui.command', command: 'tab.select', payload: { id: 'tab-B' } }, store.dispatch)
    expect(store.getState().tabs.activeTabId).toBe('tab-B')
  })

  it('pane.split never activates; explicit pane.select still does', () => {
    const store = makeUiStore()
    handleUiCommand({
      type: 'ui.command',
      command: 'pane.split',
      payload: { tabId: 'tab-A', paneId: 'pane-A1', direction: 'horizontal', newPaneId: 'pane-A2', newContent: { kind: 'terminal', mode: 'shell' } },
    }, store.dispatch)
    expect(store.getState().panes.layouts['tab-A'].type).toBe('split')
    expect(store.getState().panes.activePane['tab-A']).toBe('pane-A1')

    handleUiCommand({ type: 'ui.command', command: 'pane.select', payload: { tabId: 'tab-A', paneId: 'pane-A2' } }, store.dispatch)
    expect(store.getState().panes.activePane['tab-A']).toBe('pane-A2')
    expect(store.getState().tabs.activeTabId).toBe('tab-A')
  })
})
```

(Place the three new imports at the top of the file with the existing imports; the `as any` on preloadedState relaxes full-state-shape friction, matching existing test-file conventions.)

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/ui-commands.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL, exactly:
- tabsSlice `activate: false does not change the active tab` — reducer ignores `activate` today, so `activeTabId` becomes the new tab.
- panesSlice `activate: false keeps the current active pane` — `activePane['tab-1']` becomes `pane-new` today.
- ui-commands `payload.activate` `toBe(false)` ×2 — `activate` is `undefined` today (and TypeScript may flag the unknown `activate` option in test code until the payload types change in Step 3; vitest runs regardless).
- integration describe: both `never activates` assertions fail (activation happens today).

Expected PASS already (pins, keep passing before AND after): the tabsSlice bootstrap-edge test (reducer always activates today) and all pre-existing tests in these files.

- [ ] **Step 3: Add the minimal production implementation**

`src/store/tabsSlice.ts` — extend the payload type (after `titleSetByUser?: boolean` at :289):

```ts
  /**
   * Server-driven creates (ui.command tab.create) pass activate:false so an
   * agent/MCP action never steals the user's focus. Local creates omit the
   * flag and keep the historical auto-activation. Bootstrap exception: the
   * very first tab always becomes active — nothing else promotes it.
   */
  activate?: boolean
```

and gate the activation at :322-323:

```ts
      state.tabs.push(tab)
      if (payload.activate !== false || state.tabs.length === 1) {
        state.activeTabId = id
      }
```

(`state.tabs.length === 1` after push means the list was empty before push — this is the "very first tab" bootstrap edge.)

`src/store/panesSlice.ts` — extend the splitPane payload type (:1165-1171) and destructure (:1173):

```ts
      action: PayloadAction<{
        tabId: string
        paneId: string
        direction: 'horizontal' | 'vertical'
        newContent: PaneContentInput
        newPaneId?: string
        /** ui.command pane.split passes false — agent-driven splits never steal focus-in-tab. */
        activate?: boolean
      }>
```

```ts
      const { tabId, paneId, direction, newContent, newPaneId: providedPaneId, activate } = action.payload
```

and gate the focus move at :1199 (zoom-clear at :1202-1204 and pane-title init at :1207-1210 remain unconditional — they are layout invariants, not focus):

```ts
      if (newRoot) {
        state.layouts[tabId] = newRoot
        if (activate !== false) {
          state.activePane[tabId] = newPaneId
        }
```

`src/lib/ui-commands.ts` — in the `tab.create` arm (:80-89) add one line to the addTab object:

```ts
      dispatch(addTab({
        id: msg.payload.id,
        title: msg.payload.title,
        mode: msg.payload.mode,
        shell: msg.payload.shell,
        initialCwd: msg.payload.initialCwd,
        sessionRef: msg.payload.sessionRef,
        resumeSessionId: msg.payload.resumeSessionId,
        status: msg.payload.status,
        activate: false,
      }))
```

and in the `pane.split` arm (:116-122) add one line:

```ts
      return dispatch(splitPane({
        tabId: msg.payload.tabId,
        paneId: msg.payload.paneId,
        direction: msg.payload.direction,
        newContent: msg.payload.newContent,
        newPaneId: msg.payload.newPaneId,
        activate: false,
      }))
```

The `tab.select` (:109-110) and `pane.select` (:125-127) arms are deliberately NOT touched: explicit focus verbs keep activating.

- [ ] **Step 4: Run the focused tests**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/ui-commands.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (all new tests green; all pre-existing tests in these files still green).

- [ ] **Step 5: Refactor while green**

No extraction warranted: each gate is a 3-line `if` with a comment; the
duplication across two reducers is structural, not semantic (different state
keys, different bootstrap rules). Keep the gates inline.

- [ ] **Step 6: Impacted-test verification + repair the e2e spec that relied on the steal**

Impacted set: every consumer of the two reducers and of `handleUiCommand`.
That is the store suite, the persistence fold (`tabsPersistence.test.ts:484-501`,
which folds `ui.command{tab.create}` through a real store and keeps passing
because insertion is unchanged), and the screenshot suite.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS (the optional-flag change is backward compatible).

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/store test/unit/client/ui-commands.test.ts test/unit/client/ui-screenshot.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

E2E repair (REQUIRED in this commit — Task 1's fold change turns the old
steal into failures in four spec files; load-bearing validator #2 located
every site). The repair pattern is uniform: after a REST create that a test
relied on for activation, add an explicit user-equivalent reveal (tab-strip
click, `[data-context="tab"][data-tab-id="..."]` — the DOM hook from
`hidden-pane-rebind-rust.spec.ts`'s revealTab comment at :187-189 and the
verbatim idiom at `reconnect-revive-rust.spec.ts:188`).

**Repair 1** — `hidden-pane-rebind-rust.spec.ts`, two sites, using this spec's
existing `revealTab` helper (:190-200).

Site 1 (:229-232), replace:

```ts
      // Hide it: a second tab becomes active.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(hiddenTabId)
```

with:

```ts
      // Hide it: a second tab becomes active. REST creates are focus-neutral
      // (agent-driven creates must not steal user focus), so hiding requires an
      // explicit user-equivalent reveal (tab-strip click) — that replaces the
      // activation the create used to perform implicitly.
      const shellTabId = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await revealTab(page, harness, shellTabId)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(hiddenTabId)
```

Site 2 (:329-332), replace:

```ts
      // Hide it behind a new shell tab.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(freshTabId)
```

with:

```ts
      // Hide it behind a new shell tab (explicit reveal — REST creates are
      // focus-neutral now; see site 1 above).
      const shellTabId = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await revealTab(page, harness, shellTabId)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(freshTabId)
```

**Repair 2** — `restore-contract-wall-rust.spec.ts`, two site groups (this
spec has no revealTab helper; use the tab-strip click idiom directly).

Site A (:2326-2331, the hidden-pane-rebind wall entry), replace:

```ts
      // Second tab becomes active; the first is now hidden.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect
        .poll(async () => harness.getActiveTabId(), { timeout: 15_000 })
        .not.toBe(hiddenTabId)
```

with:

```ts
      // Second tab becomes active; the first is now hidden. REST creates are
      // focus-neutral (agent-driven creates must not steal user focus), so the
      // switch requires an explicit reveal — a user-equivalent tab-strip click.
      const secondTabId = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await page.locator(`[data-context="tab"][data-tab-id="${secondTabId}"]`).click()
      await expect
        .poll(async () => harness.getActiveTabId(), { timeout: 15_000 })
        .not.toBe(hiddenTabId)
```

Site B (:573, 'shell terminal: SIGKILL restore yields a fresh shell in
initialCwd') — the test interacts with the new tab via `.xterm` clicks at
:587 and :612, which require the new tab active. Insert the reveal right
after the tab-count poll (:574-576) and before the terminalId poll (:578):

```ts
      // REST creates are focus-neutral; reveal the new tab explicitly
      // (user-equivalent tab-strip click) before driving its terminal.
      await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabId)
```

(The pre-existing `.xterm` `.last()` selectors keep working: the new tab is
appended last in DOM order and is now active+visible, exactly as the implicit
activation arranged before.)

**Repair 3** — `git-badges-rust.spec.ts` :194-196 (test 'a REST-created shell
tab (POST /api/tabs {cwd}) shows a git badge (seedFromTerminal parity)'). The
pane-visibility assertion requires the REST-created tab active. Insert
between the tab-strip text assertion (:194) and the paneShell assertion (:195):

```ts
      // REST creates are focus-neutral; reveal the tab explicitly (user-
      // equivalent tab-strip click) before asserting its pane is visible.
      await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
```

**Repair 4** — `sidebar-registry-sync-rust.spec.ts` case-c ('case-c: fresh
codex terminal collapses to a single green row'), before the `.xterm`
interactions at :339-341. The test REST-creates the codex tab at :308-314
(binding `restTabId`) and later types Enter into its PTY. Insert right after
the prompt-gate poll block (ends :332):

```ts
    // REST creates are focus-neutral; reveal the codex tab explicitly (user-
    // equivalent tab-strip click) before driving its terminal.
    await page.locator(`[data-context="tab"][data-tab-id="${restTabId}"]`).click()
    await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(restTabId)
```

Run the five repaired tests in three invocations through the backend wrapper
(`--grep` is a supported wrapper flag; substitute `--cloud` for `--local`
when the configured backend is cloud):

```bash
env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL bash scripts/e2e-cloud.sh run --local --project=rust-chromium hidden-pane-rebind-rust
env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL bash scripts/e2e-cloud.sh run --local --project=rust-chromium --grep="a REST-created shell tab|case-c: fresh codex terminal collapses" git-badges-rust sidebar-registry-sync-rust
env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL bash scripts/e2e-cloud.sh run --local --project=rust-chromium --grep="hidden-pane rebind: a background tab pane must rebind without being revealed|shell terminal: SIGKILL restore yields a fresh shell in initialCwd" restore-contract-wall-rust
```

Expected: PASS for all five repaired tests (the reveals have the same
semantic effect the implicit activation had, so every discriminating poll
downstream is untouched).

- [ ] **Step 7: Commit the task**

```bash
git add src/store/tabsSlice.ts src/store/panesSlice.ts src/lib/ui-commands.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/ui-commands.test.ts test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts test/e2e-browser/specs/restore-contract-wall-rust.spec.ts test/e2e-browser/specs/git-badges-rust.spec.ts test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts
git commit -m "feat(client): focus-neutral agent-driven tab/pane creation

addTab/splitPane gain activate?:boolean (default activate; addTab still
activates the very first tab). handleUiCommand folds server-broadcast
tab.create/pane.split with activate:false while the explicit tab.select/
pane.select verbs keep activating. hidden-pane-rebind-rust e2e repaired: its
tab-hiding step now uses an explicit reveal (REST create no longer activates)."
```

### Task 2: Gate mount-time DOM focus on pane focus eligibility

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` (leaf branch ~:515-549; PickerWrapper :585-593 & call sites :793-814; renderContent :817-907)
- Modify: `src/components/panes/BrowserPane.tsx` (props :14-20; destructure :176-182; effect :435-441)
- Modify: `src/components/panes/EditorPane.tsx` (props :129-138; destructure; handleEditorMount :295-298)
- Modify: `src/components/panes/PanePicker.tsx` (props :66-72; destructure :74; mount effect :211-214)
- Modify: `src/components/panes/DirectoryPicker.tsx` (props :8-16; destructure :47-56; mount effect :77-80)
- Modify: `src/components/TerminalView.tsx` (add ref at :1272 area; gate :1711)
- Test: `test/unit/client/components/panes/DirectoryPicker.test.tsx` (render helper at top; existing selection test pins default)
- Test: `test/unit/client/components/panes/BrowserPane.test.tsx` (renderBrowserPane helper)
- Test: `test/unit/client/components/panes/EditorPane.test.tsx` (monaco mock :23-36 gains onMount support)
- Test: `test/unit/client/components/panes/PanePicker.test.tsx` (renderPicker helper :120-136 + auto-focus describe :675-681)
- Test (create): `test/unit/client/components/TerminalView.focusGate.test.tsx`
- Test (create): `test/unit/client/components/panes/PaneContainer.focusEligible.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1 (independent layer; either can land first).
- Produces: optional prop `focusEligible?: boolean` (default `true`) on `BrowserPane`, `EditorPane`, `PanePicker`, `DirectoryPicker`, and on the local `PickerWrapper`. `PaneContainer` computes `focusEligible = !hidden && activePane === node.id` per leaf and passes it down. After this task, mounting any of these pane kinds in a hidden tab or non-active pane never moves DOM focus.

- [ ] **Step 1: Write the failing tests**

(a) `test/unit/client/components/panes/DirectoryPicker.test.tsx` — append a describe. `renderDirectoryPicker` already spreads prop overrides onto the component, so `focusEligible` flows without helper changes:

```tsx
  describe('focus gating', () => {
    it('focuses and selects the input by default (focusEligible omitted)', async () => {
      renderDirectoryPicker({ defaultCwd: '/tmp/work' })
      const input = screen.getByLabelText('Starting directory for Claude') as HTMLInputElement
      await waitFor(() => expect(input).toHaveFocus())
      await waitFor(() => expect(input.selectionEnd).toBe('/tmp/work'.length))
    })

    it('does not focus the input when focusEligible is false', async () => {
      renderDirectoryPicker({ defaultCwd: '/tmp/work', focusEligible: false })
      const input = screen.getByLabelText('Starting directory for Claude') as HTMLInputElement
      await waitFor(() => expect(input.value).toBe('/tmp/work'))
      expect(input).not.toHaveFocus()
    })
  })
```

(b) `test/unit/client/components/panes/BrowserPane.test.tsx` — append a describe (`renderBrowserPane` spreads overrides; the URL input has `placeholder="Enter URL..."`, BrowserPane.tsx:522):

```tsx
  describe('focus gating', () => {
    it('focuses the URL input for an empty-url pane that owns focus (default)', () => {
      renderBrowserPane({ url: '' })
      expect(screen.getByPlaceholderText('Enter URL...')).toHaveFocus()
    })

    it('does not focus the URL input when focusEligible is false', () => {
      renderBrowserPane({ url: '', focusEligible: false })
      expect(screen.getByPlaceholderText('Enter URL...')).not.toHaveFocus()
    })
  })
```

(c) `test/unit/client/components/panes/PanePicker.test.tsx` — extend the `renderPicker` helper's props bag (:120-136) with `focusEligible` and pass it through, then extend the existing `auto-focus on mount` describe (:675-681):

```tsx
function renderPicker(
  overrides?: Parameters<typeof createStore>[0],
  props?: { onSelect?: ReturnType<typeof vi.fn>; onCancel?: ReturnType<typeof vi.fn>; isOnlyPane?: boolean; focusEligible?: boolean }
) {
  const store = createStore(overrides)
  const onSelect = props?.onSelect ?? vi.fn()
  const onCancel = props?.onCancel ?? vi.fn()
  const isOnlyPane = props?.isOnlyPane ?? false
  const focusEligible = props?.focusEligible ?? true
  render(
    <Provider store={store}>
      <PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={isOnlyPane} focusEligible={focusEligible} />
    </Provider>
  )
  return { onSelect, onCancel, store }
}
```

```tsx
  describe('auto-focus on mount', () => {
    it('focuses the picker container on mount', () => {
      renderPicker()
      const container = getContainer()
      expect(container).toHaveFocus()
    })

    it('does not focus the picker container when focusEligible is false', () => {
      renderPicker(undefined, { focusEligible: false })
      expect(getContainer()).not.toHaveFocus()
    })
  })
```

(d) `test/unit/client/components/panes/EditorPane.test.tsx` — the current Monaco mock (:23-36) never calls `onMount`, so `handleEditorMount` never runs in jsdom. Extend the mock behind a hoisted control flag (default off ⇒ existing tests behave exactly as before):

```tsx
const monacoMountControl = vi.hoisted(() => ({
  enabled: false,
  /** Monaco's real onMount is async — tests can model the delay explicitly. */
  mountDelayMs: 0,
  focus: vi.fn(),
}))

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange, theme, onMount }: any) => {
    useEffect(() => {
      if (!monacoMountControl.enabled) return
      const timer = setTimeout(() => {
        onMount?.(
          { focus: monacoMountControl.focus, getValue: () => '', setValue: () => {}, updateOptions: () => {}, getModel: () => null } as any,
          {} as any,
        )
      }, monacoMountControl.mountDelayMs)
      return () => clearTimeout(timer)
    }, [])
    return (
      <textarea
        data-testid="monaco-mock"
        data-theme={theme}
        value={value}
        onChange={(e: any) => onChange?.(e.target.value)}
      />
    )
  }
  return {
    default: MonacoMock,
    Editor: MonacoMock,
  }
})
```

(add `import { useEffect } from 'react'` at the top of the file). Append:

```tsx
  describe('focus gating', () => {
    beforeEach(() => {
      monacoMountControl.focus.mockClear()
    })

    afterEach(() => {
      monacoMountControl.enabled = false
      monacoMountControl.mountDelayMs = 0
    })

    it('focuses the editor on ASYNC mount for an eligible pane (default — pins initial autofocus)', async () => {
      monacoMountControl.enabled = true
      monacoMountControl.mountDelayMs = 30
      render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" />
        </Provider>
      )
      await waitFor(() => expect(screen.getByTestId('monaco-mock')).toBeInTheDocument())
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalled())
    })

    it('does not focus the editor while ineligible, but focuses on the later false→true flip (explicit select)', async () => {
      monacoMountControl.enabled = true
      const { rerender } = render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible={false} />
        </Provider>
      )
      await waitFor(() => expect(screen.getByTestId('monaco-mock')).toBeInTheDocument())
      await new Promise((r) => setTimeout(r, 50))
      expect(monacoMountControl.focus).not.toHaveBeenCalled()

      rerender(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
        </Provider>
      )
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalledTimes(1))
    })
  })
```

(e) Create `test/unit/client/components/TerminalView.focusGate.test.tsx`: copy the harness verbatim from `TerminalView.urlClick.test.tsx` lines 1-157 (imports incl. `screen`/`fireEvent` may be pruned out; keep: wsMocks + `getWsClient` mock, `useNotificationSound` mock, `openExternalUrl` stub mock, `terminal-themes` mock, `MockTerminal` class — it already has `focus = vi.fn()` and pushes instances into `terminalInstances` —, `@xterm/addon-fit` mock, xterm.css stub, `MockResizeObserver`, `paneContent`, `createStore`). Change ONLY `createStore`: add an options parameter

```ts
function createStore(opts: { activeTabId?: string | null; activePaneId?: string; settings?: Partial<AppSettings> } = {}) {
  const mergedSettings = { ...defaultSettings, ...opts.settings, terminal: { ...defaultSettings.terminal, ...opts.settings?.terminal } }
```

and in `preloadedState` set `activeTabId: opts.activeTabId === undefined ? 'tab-1' : opts.activeTabId` and `activePane: { 'tab-1': opts.activePaneId ?? 'pane-1' }`. Then:

```tsx
describe('TerminalView scheduled-focus gate (agent focus neutrality)', () => {
  beforeEach(() => {
    terminalInstances.length = 0
    registeredLinkProviders.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('focuses the terminal on mount when the pane owns focus (pin: user default preserved)', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await waitFor(() => expect(terminalInstances[0].focus).toHaveBeenCalled())
  })

  it('never focuses a terminal that mounts in a hidden tab', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })

  it('never focuses a terminal when another pane holds tab focus', async () => {
    const store = createStore({ activePaneId: 'pane-other' })
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })
})
```

(The positive pin doubles as harness validation: if IT fails pre-change, the scheduler flush never fired — debug the harness, not the gate.)

(f) Create `test/unit/client/components/panes/PaneContainer.focusEligible.test.tsx` — the WIRING coverage that PaneContainer computes `focusEligible = !hidden && activePane === node.id` and forwards it to the browser, editor, and picker arms (a misrouted or omitted forward would otherwise pass every component-level test while real panes still steal focus). `PaneContainer`'s props are `{ tabId, node, hidden? }` (PaneContainer.tsx:74-78):

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PaneContainer from '@/components/panes/PaneContainer'
import panesReducer from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import sessionsReducer from '@/store/sessionsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

// PickerWrapper only routes a CLI provider into the directory step when the
// provider exists in extensions.entries (resolveFreshAgentType /
// isCodingCliProviderName) — preload the minimal entries (shape copied from
// PaneContainer.test.tsx:27-39) or 'claude' falls through and throws.
const defaultCliExtensions: ClientExtensionEntry[] = [
  {
    name: 'claude', version: '1.0.0', label: 'Claude CLI', description: '', category: 'cli',
    picker: { shortcut: 'L' },
    cli: { supportsPermissionMode: true, supportsResume: true, resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'] },
  },
] as ClientExtensionEntry[]

const captured = vi.hoisted(() => ({
  browser: [] as any[],
  editor: [] as any[],
  picker: [] as any[],
  directory: [] as any[],
}))

// Drives PickerWrapper from step 'type' into step 'directory' (the DirectoryPicker arm).
const wiringControl = vi.hoisted(() => ({ autoSelectProvider: null as string | null }))

vi.mock('@/components/panes/BrowserPane', () => ({
  default: (props: any) => { captured.browser.push(props); return null },
}))
vi.mock('@/components/panes/EditorPane', () => ({
  default: (props: any) => { captured.editor.push(props); return null },
}))
vi.mock('@/components/panes/PanePicker', () => {
  const React = require('react')
  return {
    default: (props: any) => {
      captured.picker.push(props)
      React.useEffect(() => {
        if (wiringControl.autoSelectProvider) props.onSelect?.(wiringControl.autoSelectProvider)
      }, [])
      return null
    },
  }
})
vi.mock('@/components/panes/DirectoryPicker', () => ({
  default: (props: any) => { captured.directory.push(props); return null },
}))
vi.mock('@/components/TerminalView', () => ({
  default: () => null,
}))

function makeStore(panesState: any) {
  return configureStore({
    reducer: {
      panes: panesReducer,
      tabs: tabsReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
      terminalMeta: terminalMetaReducer,
      sessions: sessionsReducer,
      freshAgent: freshAgentReducer,
      opencodeActivity: opencodeActivityReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{ id: 'tab-1', createRequestId: 'r1', title: 'T1', status: 'running', mode: 'shell', shell: 'system', createdAt: 1 }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      extensions: { entries: defaultCliExtensions },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
        ...panesState,
      },
    } as any,
  })
}

const browserLeaf: PaneNode = {
  type: 'leaf',
  id: 'pane-b',
  content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false, browserInstanceId: 'bi-1' },
} as any
const editorLeaf: PaneNode = {
  type: 'leaf',
  id: 'pane-e',
  content: { kind: 'editor', filePath: '/tmp/a.ts', language: 'typescript', readOnly: false, content: 'x', viewMode: 'source', wordWrap: true },
} as any
const pickerLeaf: PaneNode = { type: 'leaf', id: 'pane-k', content: { kind: 'picker' } } as any

function renderNode(node: PaneNode, opts: { hidden?: boolean; activePaneId?: string } = {}) {
  const leafId = (function firstLeaf(n: PaneNode): string { return n.type === 'leaf' ? n.id : firstLeaf(n.children[0]) })(node)
  const store = makeStore({
    layouts: { 'tab-1': node },
    activePane: { 'tab-1': opts.activePaneId ?? leafId },
  })
  return render(
    <Provider store={store}>
      <PaneContainer tabId="tab-1" node={node} hidden={opts.hidden} />
    </Provider>,
  )
}

describe('PaneContainer focusEligible wiring', () => {
  beforeEach(() => {
    captured.browser.length = captured.editor.length = captured.picker.length = captured.directory.length = 0
    wiringControl.autoSelectProvider = null
  })
  afterEach(() => cleanup())

  it('browser arm: eligible when visible + active pane', () => {
    renderNode(browserLeaf)
    expect(captured.browser[0].focusEligible).toBe(true)
  })

  it('browser arm: ineligible when the tab is hidden', () => {
    renderNode(browserLeaf, { hidden: true })
    expect(captured.browser[0].focusEligible).toBe(false)
  })

  it('browser arm: ineligible when another pane is active in the visible tab', () => {
    const terminalLeaf: PaneNode = { type: 'leaf', id: 'pane-t', content: { kind: 'terminal', mode: 'shell' } } as any
    const split: PaneNode = { type: 'split', id: 'split-1', direction: 'horizontal', sizes: [50, 50], children: [browserLeaf, terminalLeaf] }
    renderNode(split, { activePaneId: 'pane-t' })
    expect(captured.browser[0].focusEligible).toBe(false)
  })

  // EditorPane mounts through React.lazy (PaneContainer.tsx:72) — the capture
  // is asynchronous; synchronous reads can throw on an empty array even on a
  // GREEN tree.
  it('editor arm: eligible when visible + active pane', async () => {
    renderNode(editorLeaf)
    await waitFor(() => expect(captured.editor.length).toBeGreaterThan(0))
    expect(captured.editor[0].focusEligible).toBe(true)
  })

  it('editor arm: ineligible when the tab is hidden', async () => {
    renderNode(editorLeaf, { hidden: true })
    await waitFor(() => expect(captured.editor.length).toBeGreaterThan(0))
    expect(captured.editor[0].focusEligible).toBe(false)
  })

  it('picker arm: eligible when visible + active pane', () => {
    renderNode(pickerLeaf)
    expect(captured.picker[0].focusEligible).toBe(true)
  })

  it('picker arm: ineligible when the tab is hidden', () => {
    renderNode(pickerLeaf, { hidden: true })
    expect(captured.picker[0].focusEligible).toBe(false)
  })

  it('directory step: PickerWrapper forwards focusEligible=false into DirectoryPicker when hidden', async () => {
    // 'claude' reaches the directory step now that extensions.entries is
    // preloaded (see defaultCliExtensions above).
    wiringControl.autoSelectProvider = 'claude'
    try {
      renderNode(pickerLeaf, { hidden: true })
      await waitFor(() => expect(captured.directory.length).toBeGreaterThan(0))
      expect(captured.directory[0].focusEligible).toBe(false)
    } finally {
      wiringControl.autoSelectProvider = null
    }
  })
})
```

(DirectoryPicker sits one hop deeper, inside PickerWrapper's directory step;
the last test drives the wrapper THROUGH that step — the preloaded extension
entries are what route 'claude' there — so the full forward chain
PaneContainer → PickerWrapper → DirectoryPicker is pinned, not just the first
hop.)

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/components/panes/DirectoryPicker.test.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/unit/client/components/panes/PaneContainer.focusEligible.test.tsx test/unit/client/components/TerminalView.focusGate.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL, exactly —
- DirectoryPicker/BrowserPane/PanePicker: the `focusEligible is false` tests fail (focus happens unconditionally today; the prop is unknown/ignored).
- EditorPane: the ineligible-no-focus + false→true flip test fails (today `handleEditorMount` focuses unconditionally — the negative assertion fails before the flip is reached). The eligible + ASYNC-delay mount test passes today (pin); it would FAIL against an effect-only gate (Monaco's async onMount — round-2 review's exact hazard), which is its purpose.
- PaneContainer.focusEligible: ALL wiring tests fail (no `focusEligible` prop exists today → captured value is `undefined`, so the `=== true` and `=== false` assertions both fail; the directory-step test fails the same way after asserting the wrapper did route).
- TerminalView.focusGate: the two `never focuses` tests fail (`flushScheduledLayout`'s focus is ungated today).
Expected PASS already (pins): the four component-level `focusEligible` DEFAULT tests (DirectoryPicker/BrowserPane/PanePicker/EditorPane eligible cases — today's unconditional focus satisfies them).

- [ ] **Step 3: Add the minimal production implementation**

`src/components/panes/PaneContainer.tsx`:
- In the leaf branch of `renderNode`, immediately before the `return (<Pane ... >` (~:521), add:

```tsx
    // focusEligible: this pane may auto-focus DOM when it mounts. Requires the
    // VISIBLE tab (!hidden) AND this tab's active pane. Agent-created tabs land
    // hidden (Task 1 keeps Redux activeTabId on the user's tab), so their panes
    // mount without stealing keyboard focus.
    const focusEligible = !hidden && activePane === node.id
```

- Change the renderContent call (:548) to `{renderContent(tabId, node.id, node.content, isOnlyPane, hidden, focusEligible)}`.
- Extend `renderContent` (:817-823): add a 6th parameter `focusEligible = true`, and forward it in three arms:

```tsx
// browser arm:
        <BrowserPane
          paneId={paneId}
          tabId={tabId}
          browserInstanceId={content.browserInstanceId}
          url={content.url}
          devToolsOpen={content.devToolsOpen}
          focusEligible={focusEligible}
        />
// editor arm:
          <EditorPane
            paneId={paneId}
            tabId={tabId}
            filePath={content.filePath}
            language={content.language}
            readOnly={content.readOnly}
            content={content.content}
            viewMode={content.viewMode}
            wordWrap={content.wordWrap}
            focusEligible={focusEligible}
          />
// picker arm:
        <PickerWrapper
          tabId={tabId}
          paneId={paneId}
          isOnlyPane={isOnlyPane}
          focusEligible={focusEligible}
        />
```

- `PickerWrapper` (:585-593): add `focusEligible = true` to its destructured props and `focusEligible?: boolean` to its inline type; forward it to BOTH the `DirectoryPicker` (:793-803) and `PanePicker` (:806-814) JSX.

(Terminal and fresh-agent arms need no prop: TerminalView self-derives eligibility in-component; FreshAgentView already self-gates.)

`src/components/panes/BrowserPane.tsx`:
- `BrowserPaneProps` (:14-20): add `focusEligible?: boolean`.
- Destructure (:176-182): add `focusEligible = true`.
- Gate the mount effect (:435-441):

```tsx
  useEffect(() => {
    // Focus the URL input only when there's no initial URL (user just created a
    // new browser pane) AND this pane owns focus. Background-mounted browser
    // panes (agent-created hidden tabs) must not steal keyboard focus.
    if (focusEligible && !url && inputRef.current) {
      inputRef.current.focus()
    }
  }, [url, focusEligible])
```

`src/components/panes/EditorPane.tsx`:
- `EditorPaneProps` (:129-138): add `focusEligible?: boolean`.
- Destructure: add `focusEligible = true`.
- `@monaco-editor/react` (pinned 4.7.x) initializes Monaco ASYNCHRONOUSLY and
  invokes `onMount` only after readiness — by then the parent's
  `[focusEligible]` effect has already run with `editorRef.current === null`,
  and assigning the ref causes no rerender. So an eligibility effect ALONE
  silently drops initial mount autofocus. Gate BOTH moments (:295-298 + new
  flip effect; `useRef` is already imported):

```tsx
  function handleEditorMount(editor: Monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = editor
    // onMount is async — eligible-at-mount focus can only happen HERE.
    if (focusEligible) editor.focus()
  }

  // Later false→true eligibility flips (explicit select bringing a
  // background-mounted editor forward) — handleEditorMount never refires.
  const prevFocusEligibleRef = useRef(focusEligible)
  useEffect(() => {
    const was = prevFocusEligibleRef.current
    prevFocusEligibleRef.current = focusEligible
    if (focusEligible && !was) editorRef.current?.focus()
  }, [focusEligible])
```

`src/components/panes/PanePicker.tsx`:
- `PanePickerProps` (:66-72): add `focusEligible?: boolean`.
- Destructure (:74): add `focusEligible = true`.
- Mount effect (:211-214):

```tsx
  // Auto-focus the container when the picker owns focus, so keyboard shortcuts
  // work immediately; background-mounted pickers must not steal DOM focus.
  useEffect(() => {
    if (focusEligible) containerRef.current?.focus()
  }, [focusEligible])
```

`src/components/panes/DirectoryPicker.tsx`:
- `DirectoryPickerProps` (:8-16): add `focusEligible?: boolean`.
- Destructure: add `focusEligible = true`.
- Mount effect (:77-80):

```tsx
  useEffect(() => {
    if (!focusEligible) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusEligible])
```

(The dependency arrays gain `focusEligible` deliberately: when the user brings
a hidden picker/pane to the active position, it autofocuses then — the
original "so shortcuts work immediately" intent, now scoped to the pane that
actually owns focus.)

`src/components/TerminalView.tsx`:
- Declare the eligibility ref next to the other render-synced refs (near the
  render-sync block at :1261-1266):

```ts
  const shouldFocusActiveTerminalRef = useRef(false)
```

  and immediately after the derivation at :1272:

```ts
  const shouldFocusActiveTerminal = !hidden && activeTabId === tabId && activePaneId === paneId
  shouldFocusActiveTerminalRef.current = shouldFocusActiveTerminal
```

- Gate the scheduled flush focus (:1711-1713):

```ts
    if (shouldFocus && shouldFocusActiveTerminalRef.current) {
      term.focus()
    }
```

(`flushScheduledLayout` is a useCallback; refs are dep-free, so the existing
dependency array needs no change. The OTHER focus effect at :1275-1285 already
gates on `shouldFocusActiveTerminal` — no change.)

- [ ] **Step 4: Run the focused tests**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/components/panes/DirectoryPicker.test.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/unit/client/components/panes/PaneContainer.focusEligible.test.tsx test/unit/client/components/TerminalView.focusGate.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (new gates green; wiring green; all pins green).

- [ ] **Step 5: Refactor while green**

No shared abstraction: each site gates a different focus mechanism (xterm
focus, monaco focus, input focus, container focus) with slightly different
intent comments. A shared `useFocusEligible` hook would add indirection
without removing logic; keep the gates inline.

- [ ] **Step 6: Impacted-test verification**

Impacted: all pane-component suites, PaneContainer/PaneLayout suites, every
TerminalView suite, and typecheck (prop changes touch public component props —
`focusEligible` is optional so all existing call sites remain valid).

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/components --config config/vitest/vitest.config.ts`
Expected: PASS. Pay particular attention to: `PaneContainer.test.tsx`,
`PaneLayout.test.tsx`, `PaneContainer.createContent.test.tsx` (they exercise
renderContent indirectly), and all `TerminalView.*` files.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/panes/PaneContainer.tsx src/components/panes/BrowserPane.tsx src/components/panes/EditorPane.tsx src/components/panes/PanePicker.tsx src/components/panes/DirectoryPicker.tsx src/components/TerminalView.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/panes/DirectoryPicker.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/panes/PaneContainer.focusEligible.test.tsx test/unit/client/components/TerminalView.focusGate.test.tsx
git commit -m "feat(client): gate mount-time DOM focus on pane focus eligibility

PaneContainer computes focusEligible = !hidden && activePane === node.id and
threads it to BrowserPane/EditorPane/PickerWrapper (PanePicker +
DirectoryPicker). TerminalView gates the scheduled flush term.focus() on a
render-synced shouldFocusActiveTerminal ref. Background-mounted panes (agent-
created hidden tabs) no longer steal keyboard focus; defaults preserve all
user-flow autofocus."
```

### Task 3: Harden screenshot `restoreFocus` against mid-capture deletions

**Files:**
- Modify: `src/lib/ui-screenshot.ts` (`FocusSnapshot` type :38-41; `restoreFocus` :293-320; `nodeContainsPane` helper already at :280-284)
- Test: `test/unit/client/ui-screenshot.test.ts` (existing file, 421 lines; reducers + `configureStore` already imported at :6-16; append a new describe)

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (independent hardening).
- Produces: `restoreFocus` becomes exported (directly unit-testable) and
  `FocusSnapshot` becomes an exported type. Visible behavior change: a capture
  whose original focus target was deleted mid-capture now skips the dead
  target (never resurrecting a dead id into Redux state), restores every
  surviving target best-effort, and reports `restoredFocus:false` when any
  target was skipped.

- [ ] **Step 1: Write the failing tests**

**Behavior-neutral prerequisite (do first, as part of this step):** the RED
suite imports `restoreFocus`/`FocusSnapshot`, which are module-private today —
importing a missing export fails module loading, producing the WRONG RED. So
first make this logic-free change in `src/lib/ui-screenshot.ts`: add `export`
to the existing `type FocusSnapshot` (:38) and the existing
`async function restoreFocus` (:293) — nothing else. That keeps today's
behavior intact, which is exactly what the two pin tests below encode.

Add imports to `test/unit/client/ui-screenshot.test.ts` (the file already
imports `tabsReducer`, `panesReducer`, `configureStore`):

```ts
import { captureUiScreenshot, restoreFocus } from '../../../src/lib/ui-screenshot'
import { setActiveTab, removeTab } from '@/store/tabsSlice'
import { splitPane, closePane } from '@/store/panesSlice'
```

(replace the existing single-name `captureUiScreenshot` import). Append this describe:

```ts
describe('restoreFocus deleted-target hardening', () => {
  function createFocusStore() {
    return configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [
            { id: 'tab-1', createRequestId: 'req-1', title: 'One', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 1 },
            { id: 'tab-2', createRequestId: 'req-2', title: 'Two', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 2 },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-1': { type: 'leaf' as const, id: 'pane-1', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-1' } },
            'tab-2': { type: 'leaf' as const, id: 'pane-2', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-2' } },
          },
          activePane: { 'tab-1': 'pane-1', 'tab-2': 'pane-2' },
          paneTitles: { 'tab-1': { 'pane-1': 'One' }, 'tab-2': { 'pane-2': 'Two' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as any,
    })
  }

  it('restores a still-valid snapshot and reports success (pin)', async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2')) // simulate the capture switching away
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: {} },
      new Set(),
    )
    expect(ok).toBe(true)
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    expect(spy.mock.calls.map(([a]) => (a as any)?.type)).toContain('tabs/setActiveTab')
  })

  it('restores a still-valid pane focus and reports success (pin)', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    // activePane['tab-2'] is now 'pane-2b' (splits activate by default);
    // the snapshot says pane-2 owned focus.
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(true)
    expect(store.getState().panes.activePane['tab-2']).toBe('pane-2')
  })

  it('never dispatches setActiveTab for a tab deleted mid-capture (reports false)', async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2'))
    store.dispatch(removeTab('tab-1'))
    const spy = vi.spyOn(store, 'dispatch') // spy AFTER setup: only restore dispatches are observed
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: {} },
      new Set(),
    )
    expect(ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('never dispatches setActivePane for a pane deleted mid-capture (reports false)', async () => {
    const store = createFocusStore()
    // closePane is a no-op on a root leaf, so split first, then close the
    // snapshot pane (leaving layout collapsed to the sibling leaf).
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    store.dispatch(closePane({ tabId: 'tab-2', paneId: 'pane-2' }))
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(false)
    const setPaneCalls = spy.mock.calls.filter(([a]) => (a as any)?.type === 'panes/setActivePane')
    expect(setPaneCalls).toHaveLength(0)
  })

  it('still restores the surviving active tab when only a pane target vanished (best-effort, reports false)', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    store.dispatch(closePane({ tabId: 'tab-2', paneId: 'pane-2' }))
    store.dispatch(setActiveTab('tab-2')) // the capture itself switched the user away
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(false)                                   // incomplete restore, honestly reported
    expect(store.getState().tabs.activeTabId).toBe('tab-1')  // surviving tab focus STILL restored
    const setPaneCalls = spy.mock.calls.filter(([a]) => (a as any)?.type === 'panes/setActivePane')
    expect(setPaneCalls).toHaveLength(0)                     // never toward the dead pane
  })

  it('reports false when the owning TAB is deleted inside the restore window (mid-flight race pin)', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    // tab-2 exists and pane-2 is a restore target at dispatch time; the tab
    // vanishes inside restoreFocus's afterPaint window. Our rAF callback is
    // enqueued BEFORE restoreFocus's internal post-paint checks, so the
    // deletion deterministically lands in the verify window.
    requestAnimationFrame(() => { store.dispatch(removeTab('tab-2')) })
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(false)
  })

  it('reports false when the restore target is deleted DURING the restore window (race pin)', async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2')) // capture switched away
    // Delete the restore target inside the afterPaint window: restoreFocus
    // dispatches setActiveTab('tab-1') while tab-1 still exists, then awaits
    // two animation frames; our rAF-queued removeTab runs inside that window
    // (rAF callbacks fire FIFO), so the post-paint verify must see it gone.
    requestAnimationFrame(() => { store.dispatch(removeTab('tab-1')) })
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: {} },
      new Set(),
    )
    expect(ok).toBe(false)
  })
})
```

(vi, describe, it, expect are already imported at the top of the file.)

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/ui-screenshot.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL, exactly —
- tab-deleted test: today `restoreFocus` dispatches `tabs/setActiveTab` into the dead id (spy records it) and returns truthy.
- pane-deleted test: today, after split+close, `activePane['tab-2']` is the sibling `'pane-2b'` ≠ snapshot `'pane-2'`, so restore dispatches `panes/setActivePane` toward the dead pane (spy records it) and the post-paint verify passes → returns `true`. Both assertions fail.
- best-effort test: the zero-dead-pane-dispatch assertion fails identically (today's restore dispatches to the dead pane; it restores the tab too, so only that assertion is discriminating).
- owning-tab mid-flight race pin: outcome on today's code depends on `removeTab`'s slice coupling — it may pass today via the global mismatch path. It is a CONTRACT pin, not a discriminating RED: it locks the round-3 requirement (deletion of an owning TAB inside the restore window ⇒ `false`, caught by the verify loop's new owning-tab check) so the Step-3 implementation cannot regress it.
Expected PASS already (pins): the two restore-success tests (live targets) and
the during-restore race test — today it returns false via the global mismatch
check; after the best-effort refactor it must STILL return false via the
incomplete flag, i.e. the race semantics are locked so the verify-loop rewrite
cannot regress them.

- [ ] **Step 3: Add the minimal production implementation**

In `src/lib/ui-screenshot.ts`, export the snapshot type and replace `restoreFocus` (currently :293-320):

```ts
export type FocusSnapshot = {
  activeTabId: string | null
  activePaneByTab: Record<string, string>
}
```

```ts
export async function restoreFocus(ctx: RuntimeContext, before: FocusSnapshot, paneTabsToRestore: Set<string>): Promise<boolean> {
  let incomplete = false
  try {
    for (const tabId of paneTabsToRestore) {
      const originalPaneId = before.activePaneByTab[tabId]
      if (!originalPaneId) continue
      const state = ctx.getState()
      // Best-effort: a pane/tab deleted mid-capture can never receive focus
      // back — skip it (dispatching the restore would resurrect a dead
      // activePane entry and blank the tab's work area), mark the restore
      // incomplete, and KEEP restoring the surviving targets rather than
      // leaving the user parked on a capture-selected tab/pane.
      if (!state.tabs.tabs.some((t) => t.id === tabId)
        || !nodeContainsPane(state.panes.layouts[tabId], originalPaneId)) {
        incomplete = true
        continue
      }
      if (state.panes.activePane[tabId] !== originalPaneId) {
        ctx.dispatch(setActivePane({ tabId, paneId: originalPaneId }))
      }
    }

    if (before.activeTabId) {
      const state = ctx.getState()
      if (!state.tabs.tabs.some((t) => t.id === before.activeTabId)) {
        incomplete = true
      } else if (state.tabs.activeTabId !== before.activeTabId) {
        ctx.dispatch(setActiveTab(before.activeTabId))
      }
    }

    await afterPaint()

    const after = ctx.getState()
    if (before.activeTabId) {
      if (!after.tabs.tabs.some((t) => t.id === before.activeTabId)) {
        incomplete = true // deleted during the restore window
      } else if (after.tabs.activeTabId !== before.activeTabId) return false
    }
    for (const tabId of paneTabsToRestore) {
      const originalPaneId = before.activePaneByTab[tabId]
      if (!originalPaneId) continue
      // The OWNING TAB may have been deleted during the restore window while
      // stale pane layout/activePane entries linger (removeTab and the pane
      // cleanup are separate slices) — that must ALSO be incomplete, not true.
      if (!after.tabs.tabs.some((t) => t.id === tabId)
        || !nodeContainsPane(after.panes.layouts[tabId], originalPaneId)) {
        incomplete = true // deleted during the restore window
        continue
      }
      if (after.panes.activePane[tabId] !== originalPaneId) return false
    }
    return !incomplete
  } catch {
    return false
  }
}
```

(Delete the now-duplicated unexported `type FocusSnapshot` declaration; the exported one replaces it. `snapshotFocus`'s return type is already `FocusSnapshot` — no change needed there.)

- [ ] **Step 4: Run the focused test**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/ui-screenshot.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

No extraction: the existence checks are 2 lines each with distinct guards;
a shared `exists(...)` predicate would earn nothing. Keep inline.

- [ ] **Step 6: Impacted-test verification**

Consumers of `ui-screenshot.ts`: only `src/lib/ui-commands.ts` (screenshot.capture
arm) — covered by `ui-commands.test.ts`. The export additions are additive;
`captureUiScreenshot` behavior for live targets is pinned.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/ui-screenshot.test.ts test/unit/client/ui-commands.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/ui-screenshot.ts test/unit/client/ui-screenshot.test.ts
git commit -m "fix(client): screenshot restoreFocus never resurrects deleted tabs/panes

restoreFocus now verifies snapshot targets still exist (tab present, pane in
layout via nodeContainsPane) before dispatching setActivePane/setActiveTab,
and reports restoredFocus:false when a target vanished mid-capture instead of
reviving a dead id that would blank the work area. restoreFocus +
FocusSnapshot exported for direct unit tests."
```

### Task 4: E2E — MCP/REST focus-neutrality spec + registration

**Files:**
- Test (create): `test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (rust-chromium `testMatch` list, :353-383)

**Interfaces:**
- Consumes: Task 1 (the Redux-level behavior the spec asserts) and Task 2
  (the DOM-focus assertions). Helpers copied per this suite's
  per-spec-ownership convention (see header comment in
  `hidden-pane-rebind-rust.spec.ts:26-27`).
- Produces: e2e coverage of the user story end-to-end: REST-driven
  creates/splits leave the user's focus untouched client-side (Redux +
  `document.activeElement`), and the explicit select routes still move focus.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts`:

```ts
/**
 * MCP/REST FOCUS NEUTRALITY -- e2e proof that agent-surface mutations never
 * steal the user's focus. REST-driven POST /api/tabs and POST
 * /api/panes/:id/split must leave the client's active tab, per-tab active
 * pane, and document.activeElement untouched; the explicit routes
 * POST /api/tabs/:id/select and POST /api/panes/:id/select remain the only
 * agent-surface focus moves.
 *
 * Rust-only: registered in the rust-chromium project only, matching its donor
 * (hidden-pane-rebind-rust.spec.ts) — the helpers boot an owned RustServer on
 * an ephemeral port. Helpers are COPIED from hidden-pane-rebind-rust.spec.ts,
 * not imported, per this suite's per-spec-ownership convention.
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'
import os from 'node:os'

/** Dismiss the initial pane-type picker by choosing the first visible shell. */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
}

/** Boot an owned RustServer, navigate, and wait for harness + WS. */
async function bootWall(page: Page): Promise<{ server: RustServer; info: TestServerInfo; harness: TestHarness }> {
  const server = new RustServer({})
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
}

function restApiHeaders(info: TestServerInfo): Record<string, string> {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

/** POST /api/tabs; returns the created tabId (envelope is {status,data}). */
async function createTabViaRest(info: TestServerInfo, body: object): Promise<string> {
  const res = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: restApiHeaders(info),
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  expect(res.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  const tabId = payload?.data?.tabId
  expect(tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return tabId as string
}

/** Pane id currently holding document.activeElement (null when focus is outside panes). */
async function focusedPaneId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
  )
}

/** Tag the CURRENT document.activeElement with a marker attribute; returns the
 *  marker. Assert exact focus identity (not just "not the new pane") survives
 *  an agent-driven mutation. */
async function tagActiveElement(page: Page): Promise<string> {
  const marker = `focus-marker-${Math.random().toString(36).slice(2)}`
  await page.evaluate((m) => {
    (document.activeElement as HTMLElement | null)?.setAttribute('data-focus-marker', m)
  }, marker)
  return marker
}

async function activeElementStillTagged(page: Page, marker: string): Promise<boolean> {
  return page.evaluate(
    (m) => (document.activeElement as HTMLElement | null)?.getAttribute('data-focus-marker') === m,
    marker,
  )
}

/** Flush the client's mount + scheduled-focus work (layout scheduler is rAF-driven). */
async function flushClientFocusScheduling(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

test.describe('MCP/REST focus neutrality', () => {
  test.setTimeout(120_000)

  test('REST create/split never steal focus; explicit select routes do', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)
      const tabA = (await harness.getActiveTabId())!
      expect(tabA).toBeTruthy()
      // Readiness gate: selectShellIfPickerShowing returns right after the
      // click, but the picker's onSelect is delayed by its fade transition —
      // tagging activeElement before the terminal mounts would pin the marker
      // to an about-to-unmount picker element. (Donor specs wait for a visible
      // .xterm for the same reason.)
      await expect(page.locator('.xterm:visible').first()).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(async () => (await harness.getPaneLayout(tabA))?.content?.terminalId ?? null, { timeout: 15_000 })
        .not.toBeNull()
      await flushClientFocusScheduling(page)
      const marker = await tagActiveElement(page)

      // --- 1: REST tab create does NOT activate (the discriminating assertion:
      // on unfixed code activeTabId flips to the new tab atomically with the
      // fold, and waitForTabCount(2) proves the fold already ran).
      const tabB = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      const stateAfterB = await harness.getState()
      const paneB = stateAfterB.panes.layouts[tabB]?.id
      expect(paneB).toBeTruthy()
      // Wait until the background tab's pane is actually MOUNTED (its mount
      // effects are the only window in which a steal could occur), flush the
      // rAF scheduler, then assert.
      await page.waitForSelector(`[data-pane-id="${paneB}"]`, { state: 'attached', timeout: 15_000 })
      await flushClientFocusScheduling(page)
      expect(await harness.getActiveTabId()).toBe(tabA)
      expect(await focusedPaneId(page)).not.toBe(paneB)
      expect(await activeElementStillTagged(page, marker)).toBe(true) // exact focus identity preserved

      // --- 2: explicit REST tab.select activates AND moves DOM focus
      // (TerminalView's eligible-focus refocus effect fires on the flip).
      const selRes = await fetch(`${info.baseUrl}/api/tabs/${tabB}/select`, {
        method: 'POST', headers: restApiHeaders(info), body: '{}',
      })
      expect(selRes.ok).toBe(true)
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabB)
      await expect.poll(() => focusedPaneId(page), { timeout: 10_000 }).toBe(paneB)
      const markerB = await tagActiveElement(page) // re-tag: paneB's xterm now holds focus

      // --- 3: another REST create still does not activate nor move DOM focus.
      const tabC = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(3)
      const paneC = ((await harness.getState()).panes.layouts[tabC])?.id
      await page.waitForSelector(`[data-pane-id="${paneC}"]`, { state: 'attached', timeout: 15_000 })
      await flushClientFocusScheduling(page)
      expect(await harness.getActiveTabId()).toBe(tabB)
      expect(await focusedPaneId(page)).not.toBe(paneC)
      expect(await activeElementStillTagged(page, markerB)).toBe(true)

      // --- 4: REST pane.split does not change tab B's active pane nor DOM focus.
      const originalActivePane = (await harness.getState()).panes.activePane[tabB]
      expect(originalActivePane).toBeTruthy()
      const splitRes = await fetch(`${info.baseUrl}/api/panes/${originalActivePane}/split`, {
        method: 'POST',
        headers: restApiHeaders(info),
        body: JSON.stringify({ direction: 'horizontal', mode: 'shell' }),
      })
      const splitPayload = await splitRes.json()
      expect(splitRes.ok, `POST /api/panes/:id/split: ${JSON.stringify(splitPayload)}`).toBe(true)
      await expect
        .poll(async () => (await harness.getState()).panes.layouts[tabB]?.type, { timeout: 10_000 })
        .toBe('split')
      const newPaneId = (await harness.getState()).panes.layouts[tabB].children[1].id
      await page.waitForSelector(`[data-pane-id="${newPaneId}"]`, { state: 'attached', timeout: 15_000 })
      await flushClientFocusScheduling(page)
      expect((await harness.getState()).panes.activePane[tabB]).toBe(originalActivePane)
      // REMOUNT note: leaf→split replaces PaneContainer's rendered root (Pane →
      // nested split divs), so the original pane's tagged xterm element is
      // destroyed by construction — markerB cannot survive the split. (Exactly
      // the same remount already happens on USER-driven splits; this change
      // creates no new remount.) The DOM-focus contract for an agent split is:
      // (a) focus never lands in the new pane, and (b) the original active
      // pane reacquires DOM focus through its eligibility refocus effect.
      expect(await focusedPaneId(page)).not.toBe(newPaneId)
      await expect.poll(() => focusedPaneId(page), { timeout: 10_000 }).toBe(originalActivePane)

      // --- 5: explicit REST pane.select activates the new pane AND moves DOM focus to it.
      const paneSelRes = await fetch(`${info.baseUrl}/api/panes/${newPaneId}/select`, {
        method: 'POST', headers: restApiHeaders(info), body: '{}',
      })
      expect(paneSelRes.ok).toBe(true)
      await expect
        .poll(async () => (await harness.getState()).panes.activePane[tabB], { timeout: 10_000 })
        .toBe(newPaneId)
      await expect.poll(() => focusedPaneId(page), { timeout: 10_000 }).toBe(newPaneId)
      expect(await harness.getActiveTabId()).toBe(tabB)
    } finally {
      await server.stop()
    }
  })
})
```

- [ ] **Step 2: Add registration (no production code; MUST precede the first run — the rust-chromium project only discovers listed specs)**

Rust-only specs must appear in BOTH lists — the match-all `chromium` project
uses `RUST_ONLY_SPECS` as its `testIgnore` (playwright.config.ts:330), so an
entry missing there gets picked up by chromium and fails its own
`expect(e2eServerKind).toBe('rust')` guard (the cloud config inherits the
chromium project, so it is affected identically).

In `test/e2e-browser/playwright.config.ts`:

(a) Append to `RUST_ONLY_SPECS` (:176+, a list of regexes with rationale comments):

```ts
  // MCP/REST focus neutrality: hard `expect(e2eServerKind).toBe('rust')` guard
  // and owned-RustServer wall harness (same convention as the other entries,
  // e.g. terminal-activity-rust).
  /mcp-focus-neutrality-rust\.spec\.ts$/,
```

(b) Append to the rust-chromium project `testMatch` (:353-383), after the mcp-qa-smoke entry:

```ts
        // MCP/REST focus neutrality: agent-surface creates/splits must not
        // change client focus (Redux active tab/pane nor DOM focus); only the
        // explicit select routes may.
        /mcp-focus-neutrality-rust\.spec\.ts$/,
```

Verify discovery on both lanes (these are Discovery-only `--list` runs; they
never execute tests, so plain Playwright is correct here. GNU `grep -c`
PRINTS `0` but EXITS 1 when there is no match — capture the count with
`|| true` and compare, never assert on the pipeline's exit status):

```bash
c0=$(env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npx playwright test --config test/e2e-browser/playwright.config.ts --project=chromium --list 2>&1 | grep -c mcp-focus-neutrality || true); test "$c0" = "0"
c1=$(env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --list 2>&1 | grep -c mcp-focus-neutrality); test "$c1" = "1"
```

Expected: both commands exit 0 (chromium discovers 0 matches, rust-chromium discovers 1).

Cloud legality: the spec uses ONLY shell-mode terminals — no external CLIs —
so it must NOT be added to `CLOUD_SKIP_SPECS` in
`test/e2e-browser/playwright.cloud.config.ts`. Verify it is absent
(grep for `mcp-focus-neutrality` in that file; expect no matches).

- [ ] **Step 3: Run the focused tests**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL bash scripts/e2e-cloud.sh run --local --project=rust-chromium mcp-focus-neutrality-rust hidden-pane-rebind-rust` (substitute `--cloud` when the configured backend is cloud)

Expected: PASS for both specs (new coverage green; repaired spec still green).
This task is NOT RED against the unfixed base — Task 1 already landed the
Redux behavior; this is protective coverage. (Discrimination is structural:
section 1's `toBe(tabA)` fails atomically under the pre-Task-1 gate.)

- [ ] **Step 4: Refactor while green**

No shared helper extraction: this suite deliberately copies helpers per-spec
(per-spec-ownership convention) so one spec's helper drift can't break
another. Keep as-is.

- [ ] **Step 5: Impacted-test verification**

Task 4 adds a spec and two registration entries only — no runtime code.
NOTE: `npm run typecheck` does NOT cover `test/e2e-browser/**` (tsconfig
includes `src`, `shared`, one vite config, and `server` only) — do not claim
typecheck evidence for these files. The e2e files' correctness evidence is:
(a) the Step-3 `--list` discovery runs (they fully parse the spec and config;
a syntax error fails discovery), and (b) the Step-4 green executions on the
configured backend. No further verification exists for this task; treat the
runs as the gate.

- [ ] **Step 6: Commit the task**

```bash
git add test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): MCP/REST focus-neutrality coverage (rust)

New rust-only spec proves REST tab create + pane split leave the client's
active tab, per-tab active pane, and document.activeElement untouched, while
the explicit tab/pane select routes still move focus. Registered in BOTH
RUST_ONLY_SPECS (chromium testIgnore) and the rust-chromium testMatch.
Cloud-legal: shell-mode only, not in CLOUD_SKIP_SPECS."
```

### Task 5: Documentation — MCP tool text, orchestration skill, parity addendum, AGENTS.md

**Files:**
- Modify: `server/mcp/freshell-tool.ts` (TOOL/INSTRUCTIONS/HELP_TEXT — this text ships to every MCP agent)
- Modify: `.agents/skills/freshell-orchestration/SKILL.md`
- Modify: `docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` (dated addendum after the fold table at :106-119 — do NOT rewrite its history)
- Modify: `AGENTS.md` (root; mandatory repo convention for behavior changes)
- NOT modified: `docs/index.html` — the behavior difference is invisible in a static mock (no user-visible chrome changes).

**Interfaces:**
- Consumes: behavior shipped by Tasks 1-4.
- Produces: agent-facing documentation matching the new contract, so MCP
  agents learn "creates are focus-neutral; select explicitly to move focus".

- [ ] **Step 1: Write the failing verification test**

The instruction strings ARE executable surface (they ship to every MCP agent),
so pin their content rather than trusting unreviewed prose. Append to
`test/unit/server/mcp/freshell-tool.test.ts` (extend the existing import at :15
of `TOOL_DESCRIPTION, INPUT_SCHEMA, executeAction` with `INSTRUCTIONS`):

```ts
describe('focus-neutrality documentation', () => {
  it('agent-facing text documents focus neutrality and the explicit select verbs', async () => {
    expect(TOOL_DESCRIPTION).toContain('focus-neutral')
    expect(TOOL_DESCRIPTION).toContain('select-tab')
    expect(INSTRUCTIONS).toContain('focus-neutral')
    expect(INSTRUCTIONS).toContain('select-tab')
    expect(INSTRUCTIONS).toContain('select-pane')
    // HELP_TEXT is module-private but reachable through the tool's own help
    // action (freshell-tool.ts case 'help' returns HELP_TEXT directly, ~:944).
    expect(await executeAction('help', {})).toContain('focus-neutral')
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/server/mcp/freshell-tool.test.ts --config config/vitest/vitest.server.config.ts`

NOTE the config: `test/unit/server/**` is EXCLUDED from the default client
vitest config (config/vitest/vitest.config.ts:40) — every command touching this
file MUST use `config/vitest/vitest.server.config.ts`.

Expected: FAIL only in the new `focus-neutrality documentation` test (none of
the three strings contains the contract today); every pre-existing test PASS.

- [ ] **Step 3: Make the documentation edits**

`server/mcp/freshell-tool.ts`:
- TOOL_DESCRIPTION (:27+): append this sentence — `Creation actions (new-tab, split-pane) are focus-neutral; use select-tab to move the user's focus explicitly.`
- Add this bullet to the `KEY GOTCHAS` section of INSTRUCTIONS (:46+):

```
**Focus neutrality:** new-tab, split-pane, and every pane/tab creation are focus-neutral — they never change which tab or pane the user is looking at. Use select-tab / select-pane when you explicitly intend to move the user's focus. send-keys, capture-pane, and wait-for all target panes without moving focus.
```

- HELP_TEXT (:411+): on the `select-tab` / `select-pane` entry lines, append `(pane/tab creation is focus-neutral — select moves focus explicitly)`.

`.agents/skills/freshell-orchestration/SKILL.md` — add a short section (near the tab/pane focus documentation):

```
## Focus neutrality

All creation commands (new-tab, split-pane, MCP/REST creates) are focus-neutral: they never move the user's active tab or active pane, and background-created panes never steal DOM focus. Focus moves ONLY via explicit select-tab / select-pane (REST: POST /api/tabs/:id/select, POST /api/panes/:id/select). When scripting multi-pane work, select explicitly before measuring focus-dependent behavior.
```

`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` — insert after the fold table (:106-119):

```
### Addendum 2026-08-25 — focus neutrality

The fold table above describes the original behavior, where ui.command
tab.create/pane.split ACTIVATED the new tab/pane on every client. As of
2026-08-25 the create/split folds are focus-neutral: handleUiCommand passes
activate:false into addTab/splitPane, so they never change the user's active
tab or per-tab active pane (bootstrap exception: the client's very first tab
still activates). Focus changes remain exclusive to the explicit verbs
(tab.select, pane.select; REST /tabs/next|prev and MCP next-tab/prev-tab fold into tab.select). Screenshot capture still moves and
auto-restores focus, and now reports restoredFocus:false when a snapshot
target was deleted mid-capture instead of resurrecting dead ids. See
docs/plans/2026-08-25-mcp-focus-neutrality.md.
```

`AGENTS.md` (root) — append one sentence to the **Fresh-Agent Orchestration** paragraph:

```
Agent-driven tab/pane creation is focus-neutral by contract: server-broadcast ui.command create/split folds carry activate:false into addTab/splitPane and never change the user's active tab/pane — focus moves only via the explicit select-tab/select-pane verbs.
```

- [ ] **Step 4: Run the focused tests**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS (`freshell-tool.ts` is TypeScript — string edits typecheck trivially).

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/server/mcp/freshell-tool.test.ts --config config/vitest/vitest.server.config.ts`
Expected: PASS (new doc-content test green; the rest of the suite exercises tool actions/params unchanged).

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run lint`
Expected: PASS (a11y lint is CI-required before merge; unrelated to the doc edits but cheap to confirm).

- [ ] **Step 5: Refactor while green**

N/A — documentation only.

- [ ] **Step 6: Impacted-test verification**

Doc-only task; the typecheck + mcp tool suite above is the complete impacted set.

- [ ] **Step 7: Commit the task**

```bash
git add server/mcp/freshell-tool.ts test/unit/server/mcp/freshell-tool.test.ts .agents/skills/freshell-orchestration/SKILL.md docs/plans/2026-07-18-agent-api-mcp-parity-spec.md AGENTS.md
git commit -m "docs: document agent focus neutrality (MCP tool, orchestration skill, parity addendum, AGENTS)

Also pins the three agent-facing instruction surfaces (TOOL_DESCRIPTION,
INSTRUCTIONS, HELP_TEXT via the help action) in test/unit/server/mcp/freshell-tool.test.ts."
```

### Task 6 (post-hoc, landed): BrowserPane iframe inert gating

Added during Stage 5 after the Fresh Eyes delta review's round-1 Major finding.
A same-origin page loading inside a visible-but-NOT-focus-eligible browser
pane (agent split into the active tab — hidden background tabs' panes are
already un-focusable because `.tab-hidden` uses `visibility:hidden` + absolute
positioning + `pointer-events:none`, so hidden content has no focusable area)
could still focus its own document and seize keystrokes. Gate: the `<iframe>` carries the `inert` attribute while
`focusEligible` is false (`src/components/panes/BrowserPane.tsx`, iframe at
:580); removing it on a false→true flip does NOT reload (same element, src
untouched). Tests: `BrowserPane.test.tsx` focus-gating describe — inert set
when ineligible, absent when eligible (pin), flip removes without reload.
RED: both inert tests failed with `inert` absent. GREEN: 35/35. Committed as
e4b9b59ce.

Also during Stage 5: `test/e2e/tab-focus-behavior.test.tsx` phase-1 pinned the
removed hidden-mount steal (outside Task 2's components impacted-set; caught by
the full coordinated suite) — minimally inverted, phase-2 discrimination
intact. Committed as 4a5e09aaa.

### Task 7 (post-hoc, landed): BrowserPane/ExtensionPane focus parity

Added during Stage 5's delta-round-2 Major fix. Previously, DOM focus for
browser panes was content-dependent: an EMPTY pane focused the URL input while
a LOADED pane focused nothing (its iframe removed from sequential navigation
but never program-focused), so "the pane that owns the focus slot holds DOM
focus" broke on explicit select and after leaf→split remounts; ExtensionPane
had no eligibility support at all.

Change: BrowserPane's root div gained `ref` + `tabIndex={-1}` and Task 2's
URL-input effect was merged into a single owns-focus effect — eligible mount
or false→true flip focuses the URL input when the pane is empty and the pane
root when loaded. Navigation NEVER refocuses (url is read via a render-synced
ref, deps `[focusEligible]`). ExtensionPane gained the same `focusEligible`
prop threaded from PaneContainer's extension arm, Task-6-equivalent `inert`
gating on its sandboxed iframe, and an iframe focus effect for eligible
mount/flips. This also closes the same-origin extension-iframe steal vector
for extension category `client` (sandbox allows same-origin + scripts).

Tests: 2 new BrowserPane focus-gating tests (root-focus mount for loaded pane;
flip after hidden mount) + new `ExtensionPane.test.tsx` (inert when ineligible,
focused when eligible, flip re-eligible without reload). RED observed on all 5
(iframe inert attribute absent / nothing focused). GREEN: BrowserPane 37/37,
ExtensionPane 3/3, pane suites total 638/638. Plus wall e2e remains green after
the marker baseline now asserts pane A owns document focus pre-tag.

Also in this round: `panesSlice.test.ts` `activate:false` now pre-zooms the
original pane and asserts `zoomedPane` clears (unconditional layout-invariant
pinned on the non-activating path), and the plan doc corrections in the delta
round 2 record below.

### Task 8 (post-hoc, landed): ownership-gated mount focus + focus-steal rebuff guard

Added during Stage 5's delta-round-3 fix round (5 Major + 1 Minor).

**The platform findings that shaped the fix** (verified empirically in this
environment's Chromium via Playwright experiments): `inert` on an iframe does
NOT stop a script INSIDE the nested document from hoisting the iframe into the
outer document's `document.activeElement` — no attribute combination does
(tabindex=-1, sandbox ±allow-same-origin, inert ancestor all fail). The hoist
is event-silent on the winning side but the displaced element DOES fire
focusout (window blur covers displaced-is-body), and calling `blur()` on the
hoisted iframe restores control.

Two mechanisms close the round-3 Majors:

1. **Focus-steal rebuff guard** (`src/lib/focus-steal-guard.ts`, installed once
   via `useFocusStealGuard()` in `App()`): document `focusout` + window `blur`
   listeners; when `document.activeElement` becomes an iframe carrying
   `data-focus-locked`, the guard blurs it and restores the displaced element
   (body fallback). Non-eligible browser AND extension iframes now carry both
   `inert` AND `data-focus-locked='true'` — inert for pointer/sequential/outer-
   programmatic entry, the guard for the inside-script hoist. (M1, M2)

2. **Pane focus-ownership memory + adoption gate** (`src/lib/pane-focus-ownership.ts`
   + `src/hooks/usePaneFocusAdoption.ts`): pane content components record at
   teardown (layout-effect cleanup — passive cleanups run post-DOM-detach)
   whether their `[data-pane-id]` subtree contained `document.activeElement`.
   Eligible MOUNTS then consult `shouldFocusPaneOnEligibleMount(paneId)` —
   unknown ids (fresh creation, first visit) default to "may focus", preserving
   the user-create UX; a remounted pane only re-focuses if it OWNED focus before
   teardown. False→true eligibility flips (explicit select, tab switch) bypass
   the gate entirely. The adoption decision is consumed lazily (`mayFocusNow`)
   so async focus targets (Monaco onMount, deferred extension iframe, terminal
   attach) evaluate it when focus would actually happen. Adopted in all six
   mount-focus components: TerminalView (keeper effect + the mount-initiated
   `focus:true` layout consumption), BrowserPane (merged owns-focus effect),
   ExtensionPane (iframe effect; now also reacts to deferred iframe readiness —
   server start / hydration races no longer drop eligible-mount focus),
   EditorPane, PanePicker, DirectoryPicker (gains an optional paneId prop
   threaded from PaneContainer for identity). (M3, M4)

EditorPane additionally fixes the async-selection race with a render-synced
`focusEligibleRef` read inside `handleEditorMount` (the saved onMount callback
captured the initial prop; a select landing before Monaco's mount completed
left a selected editor unfocused forever). (M5)

Tests: new `pane-focus-ownership.test.ts` (5) and `focus-steal-guard.test.ts`
(4, hermetic under `sequence.shuffle`); BrowserPane remount-with/without-
ownership pair + navigation-never-refocuses pin (Minor); TerminalView
focusGate remount pair; ExtensionPane deferred-ready focus + data-focus-locked
pin; EditorPane stale-closure race (flip before async mount). The ownership
map resets globally between tests via `test/setup/dom.ts` (same pattern as
resetWsClientForTests). Wall e2e gained §6 (split while user focus is in app
chrome — the remounted pane must NOT reacquire it) and §7 (background browser
pane loading a self-focusing page — hoist rebuffed, inert+locked attribute
pins, §8 control: explicit select removes both and moves focus in).

### Task 9 (post-hoc, landed): round-4 contract closure — fresh-agent gate, flip recovery, same-target selects

Added during Stage 5's delta-round-4 fix round (3 Major + 2 Minor).

1. **FreshAgentView adoption gate** (M1): the fresh-agent composer/root focus
   effect keyed only off Redux activity — the one pane autofocus implementation
   outside Task 8's gate, and both servers permit splitting a fresh-agent leaf.
   Now `usePaneFocusAdoption(paneId, isActivePane, focusEpoch)` guards it; the
   existing "don't re-focus an editable inside the pane" guard still wins.

2. **Adoption latch recovery** (M2): `usePaneFocusAdoption`'s flip write was
   `pending`-only, so a denied remount could NEVER recover — a later tab-switch
   back (false→true flip) stayed unfocused, regressing baseline UX. Flips AND
   epoch bumps now resolve `adoptionRef` to `'allowed'` unconditionally.

3. **Same-target selects move DOM focus** (M3): `tab.select`/`pane.select`
   folds only assigned Redux ids — selecting the ALREADY-active target produced
   no eligibility transition and no focus effect re-run, violating "explicit
   select moves focus". Fix: a per-pane **focus epoch**
   (`PanesState.focusEpochByPaneId`, ephemeral, never persisted). The
   pane.select fold dispatches `setActivePane({…, focusNudge: true})` (the ONLY
   nudge source in setActivePane — pointer-driven activations from Pane
   mousedown must not bump, or in-pane inputs like rename/search would lose
   focus to the refocus effect); the tab.select fold dispatches
   `nudgePaneFocus({tabId})` which bumps the tab's active pane.
   `PaneContainer` reads the map once and forwards a `focusEpoch` prop into
   every content arm; `mayFocusNow`'s callback identity changes with the
   epoch, so consumers' focus effects simply re-run.

Minors: **ownership cap** now evicts oldest entries instead of wiping the map
(a clear() erased the record just written, re-enabling the chrome-steal at the
512-entry boundary); **PaneContainer wiring suite** gained the extension arm
(eligible/hidden/other-pane-active) so a dropped `focusEligible` prop on that
arm cannot pass green.

Test note: the shuffled parallel pool has a small family of load-sensitive
tests that intermittently exceed their timing under contention with heavyweight
co-tenants (seen this run: `storage-migration.fresh-agent`'s 500ms migration
budget, and `PaneContainer`'s lazily-imported-editor `findByTestId` 1s window).
New timing assertions in this change avoid sleeps entirely and use `waitFor`
with generous poll windows, which proved load-stable. The two pre-existing
offenders passed solo and in the eventual green broad runs; left unmodified.
One unrelated flake sighting during the earlier task — `test/e2e/open-tab-session-sidebar-visibility.test.tsx` "keeps direct refreshes on the visible applied search silent…" failed once in a full-suite run (call-count assertion), passed solo AND on the immediate full-suite re-run; changes here do not touch the sidebar/search flow. Recorded as a known one-off to watch.

Tests: ownership cap trim; BrowserPane denied→flip recovery + denied→epoch
re-select pins; FreshAgentView remount-denied + epoch re-select pair;
EditorPane epoch refocus pin (its flip effect now has an epoch branch);
panesSlice epoch/nudge semantics incl. the pointer-activation no-bump pin;
ui-commands same-target pane.select + tab.select nudge folds. Wall e2e gained
§6b: after the app-chrome split (focus still in chrome), a same-target
`POST /api/panes/:id/select` moves DOM focus back into the pane.

### Task 10 (post-hoc, landed): round-5 contract fidelity — element-identity restore, editor fallback, epoch wiring pins

Added during Stage 5's delta-round-5 fix round (3 Major + 2 Minor + 1 Nit).

1. **Element-identity focus memory** (M1): the round-4 boolean ownership record
   let a legitimate re-adoption refocus the content's DEFAULT target even when
   the user was typing in a different in-pane field (browser URL input, combobox
   inputs). `pane-focus-ownership.ts` now records a best-effort stable selector
   (id → aria-label → data-testid → placeholder → role) for the focused
   element; `usePaneFocusAdoption` mounts schedule a restore (rAF + macrotask,
   deliberately landing after components' own mount focus) that re-resolves the
   element in the new subtree via `resolveRecordedFocusTarget` and refocuses
   it. Elements that do not come back resolve to null and the default target
   stands. Transient in-pane UI (open terminal search bar, in-progress pane
   rename, agent splits destroy that state entirely) is pre-existing remount
   parity — identical for user-driven splits.

2. **EditorPane preview/empty-state select** (M2): flip/epoch paths only called
   `editorRef.current?.focus()`; preview and empty branches render no Monaco,
   so an explicit select stranded DOM focus. The pane root is now
   `tabIndex={-1}` + `rootRef`, and flip/epoch focus goes through
   `focusEditorOrRoot()`.

3. **Epoch wiring pins** (M3): PaneContainer wiring suite now asserts
   per-arm `focusEpoch` hand-off (browser/editor/picker/extension) seeded from
   the store map, and a pointer-activation pin drives the real
   `Pane.onMouseDown → handleFocus → setActivePane` path asserting no epoch
   bump (the earlier pin dispatched the bare action, which could not catch a
   future `focusNudge:true` on the pointer path). Epoch-bump refocus pins for
   PanePicker, DirectoryPicker (wrapped `data-pane-id` root), and ExtensionPane
   (same) close the per-content-type matrix; e2e §8b repeats the same-target
   select on the browser arm (§6b pinned only the terminal arm).

Minors: **persist denylist** gained `focusEpochByPaneId` (the write path
spreads `state.panes`; the field documents "never persisted" but was not
excluded) with a `panesPersistence.test.ts` pin; **e2e §7** now requires a
postMessage attempt-handshake from the self-focusing payload before the
preservation assertions (a sleep-only check could pass vacuously). Nit: the
`focusEpochByPaneId` doc comment corrected to describe the focusNudge-only
semantics.

Note: the round-5 runner exited 2 (a report-format contract hiccup on the
first issue entry), but the review content was complete and is treated as the
round-5 verdict. Delta review round cap (5) is now reached — remaining
residuals are surfaced, not iterated: (a) element-identity restore covers the
mount window only, so async late-mounting focus targets (Monaco onMount) apply
their own default after the restore; (b) transient in-pane UI state does not
survive splits by design.

### Task 11 (post-hoc, landed): round-6 restoration fidelity — disposed-editor ref, async-mount race, descriptor blind spots

Added during Stage 5's delta-round-6 fix round (3 Major + 2 Minor).

1. **Disposed-editor ref** (M1): `@monaco-editor/react` disposes on unmount
   silently; a source→preview/empty transition left `editorRef` pointing at a
   dead editor, and the round-5 `focusEditorOrRoot` would call into it instead
   of the root. `editorRendered` now tracks the render branch and an effect
   clears the ref on unmount; the flip then falls back to the pane root.
2. **Async Monaco mount stomping the restore** (M2): with a slow onMount, the
   mount-window descriptor restore could land first and the delayed editor
   autofocus would steal it back. `handleEditorMount` now skips its adoption
   focus when a recorded descriptor still resolves in the DOM
   (`resolveRecordedFocusTarget`) — suppressing exactly one focus, keeping the
   restored field (e.g. the toolbar path input) focused.
3. **Descriptor blind spots** (M3): a focused browser/extension iframe has no
   id/aria/test/placeholder/role, so `selector:null` killed the restore and
   dropped the user out of the embedded page. `describeInnerSelector` now walks
   ordered candidates — id → aria-label → data-testid → placeholder → role →
   sole-iframe → title — accepting only selectors that resolve UNIQUELY at
   record time. Browser iframe restore is pinned (remount → embedded page
   refocused).

Minors: the cap map is true LRU now (re-recording an existing pane refreshes
its position; `Map.set` alone kept it, letting a long-lived pane be evicted
right after a fresh record) with a refresh-then-evict pin; the PaneContainer
wiring suite covers focusEpoch forwarding for ALL seven arms (terminal,
fresh-agent, and the nested directory step joined browser/editor/picker/
extension) — a dropped prop on any arm can no longer pass green.

### Task 12 (post-hoc, landed): round-7 restore robustness — inactive-pane focus, burst atomicity, shell/leaf blind spots

Added during Stage 5's delta-round-7 fix round (3 Major + 2 Minor).

1. **Redux-inactive but DOM-focused panes** (M1): `Pane`'s shell is
   keyboard-focusable and receiving focus via Tab does NOT update
   `activePane`; an agent split of such a pane recorded `owned` at teardown
   but the adoption-pending replacement skipped both default focus AND the
   restore, dropping the user to body. The mount-window restore is now
   RECORD-driven (`schedulePaneFocusRestore` in `pane-focus-ownership.ts`),
   independent of adoption state, with a `.tab-hidden` visibility guard so
   background-tab remounts never pull focus.
2. **Burst split atomicity** (M2): a scheduled restore marks its record
   restore-pending; teardown during the window skips overwrite (the
   intermediate frame's focus is blank or the remount's own autofocus
   artifact — never the user's), so rapid sequential agent splits keep the
   pre-split descriptor. Pending clears when the restore fires.
3. **Shell/leaf blind spots** (M3): the pane shell itself is now
   describable (`:scope` sentinel when focus was on the root), and the
   candidate chain gained a `data-context` fallback after `title`.

Minors: the descriptor-candidate test now actually reaches `title` (the
prior iframe test had two resolution paths and always took the earlier one);
and the Task-5 `focus-neutrality documentation` prose-containment describe in
`freshell-tool.test.ts` is DELETED per the repo rule that prose/doc
containment does not qualify as behavioral coverage (pre-existing doc-string
tests elsewhere are untouched — out of scope).

## Fresh Eyes record

- **Simplification episode, focused round S3 (GPT, independent; repair base 91e407cfb): PASSED — 0 blocking, 1 advisory Minor + 1 advisory Nit**, both addressed post-pass: (Minor, addressed) the never-found-target test pinned only "no suspension" — it did not pin that renderers stay ACTIVE through iframe pre-render and freeze only for the main render; the hidden-tab iframe test now pins the full order (`iframe-render → suspend → main-render → resume`). (Nit, addressed) the out-of-scope annotation miscounted the broadcast bullet ("fourth" vs third); reworded to name it. The the-usual focused loop halts at the pass. This is the first PASSED review of the entire branch (after r18–r27 and S1 all failed).
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260909T081933Z-2053010.md`

- **Simplification episode, delta round S2 (GPT, independent; base 5b8717017): FAILED — 3 Majors + 4 Minors + 2 Nits**, fixed/declined: (M1+M2, valid, FIXED) both servers' `closeTab`/`close_tab` set the cursor to the FIRST remaining tab unconditionally — a failed agent create (terminal spawn failure) rolls the layout back and moved the server cursor to tab 1 even when the user sat on tab 2. Both mirrors now follow the client's `removeTab` semantics exactly: a BACKGROUND close never moves the cursor (rollback lands on the user's tab); only closing the cursor's own tab selects a survivor (previous neighbor, else the new first). RED-verified both stacks (new tests fail on the old code), pinned by layout-store tests on each side (Node `agent-layout-store.test.ts`, Rust `layout_store_tests.rs::close_tab_preserves_cursor_for_background_closes_and_advances_on_active_close`). (M3, valid, FIXED) the wall e2e only pixel-checked the TAB-scope capture; the pane-scope response was dimension-checked only, so a blank pane PNG passed. Both scopes now get the in-page pixel-variance proof. (m1, valid, FIXED) index+src iframe correlation could still mismatch same-URL iframes after a mid-capture tree change; the fingerprint now includes the owning PANE id (`iframe.closest('[data-pane-id]')` — each browser/extension pane hosts exactly one iframe), pinned by a same-src-different-pane no-replacement test. (m3, valid, FIXED) the renderer suspension started before target resolution and iframe pre-render, freezing terminal rendering for the full wait; it now starts immediately before the MAIN render only (the only step that reads WebGL canvases), and a never-found target suspends nothing at all. (m2, DECLINED) the body-stranded adoption exception ("an eligible mount with focus stranded on document.body adopts focus even when its record says owned:false") is the documented round-14/16 trade — permanent stranded keyboard input is worse than a rare honest refocus, and the reviewer notes it is tested as desired behavior. (m4+n1+n2, doc/nit, FIXED) plan doc's "Out of scope" superseded-items annotated, `screenshot-capture-env.ts` queue/deadline comment rewritten to the refcount-only reality, Rust `split_pane` doc comment no longer promises activation.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260909T073738Z-1009951.md`

- **Simplification (user-approved, 2026-09-09; after r18–r27 exhausted the 10-round budget without a pass): the entire screenshot capture-activation machinery was REPLACED by off-DOM clone rendering.** Root insight: `.tab-hidden` is CSS `visibility: hidden`, not `display: none` (kept that way so xterm can measure), so background tabs remain mounted AND fully laid out — html2canvas parses the target's bounds from its CLONE of the document and skips visibility-hidden subtrees while painting, so an inline `visibility: visible` on the cloned target's ancestor chain (via `onclone`, armed live-side only when the target actually has a hidden ancestor) renders the background tab without touching the live page. `captureUiScreenshot` now dispatches NOTHING: no tab/pane activation, no restore, no serial interaction — which deletes the whole apparatus the ten failed rounds kept patching: the capture queue + serialization, deadline/TTL budgets, `ttlMs` stamping, `screenshot.cancel` frames + client cancellation sets/waiters/render races, iframe-hoist/intent detection (focusout/blur listeners, Tab-key/pointer evidence windows), per-coordinate touched maps + co-touch rules, fenced abandonment + shared wind-down promises, `restoreFocus`, `selectTabForCapture`, `setActivePane`'s `capture:` flag, and the middleware's coordinate bookkeeping (the serial itself STAYS — it serves the ownership/adoption records). What remains: refcounted renderer suspension around the render (WebGL canvases need a fresh synchronous draw before clone readback), iframe pre-render with clone-side index+src-fingerprint correlation (no live-DOM markers; a tree that changed between prep and clone gets NO replacements rather than a wrong one), and the layout-gated (not paint-gated) iframe prep so hidden-tab iframes still capture. Server-side: Node `ws-handler.ts` and the Rust broker dropped cancel broadcasts and ttl stamping (no client state left to unwind; a stale capture is now a harmless clone render whose reply is ignored). `changedFocus`/`restoredFocus` stay on the wire/REST envelope (compat), always false. E2E: new wall-spec test proves a REST screenshot of a background tab (tab AND pane scope) returns a real non-blank render (in-page pixel-variance check on the saved PNG) while the user's active tab and exact DOM focus identity stay anchored. All gates green at the simplification commit; a fresh delta review episode starts here.

- **Delta round 27 (Codex, independent; base 5b8717017): FAILED — 2 Majors**, both assessed valid and fixed: (M1) the r25 intent window was GLOBAL — any keydown/pointermove anywhere counted — so a user typing in their own pane while the capture's flip triggered ExtensionPane autofocus launders that programmatic hoist into 'user engagement' (realistic false positive → no rollback → user stranded on the captured tab). Evidence is now BOUND: keyboard evidence only for focus-navigation Tab keydowns; pointer evidence only for activity over the SAME pane the hoist lands in. Pinned by a deterministic unrelated-input-elsewhere scenario (evidence dispatches inside the flip subscription, before the autofocus). (M2) r26's first-resolve cancel only reached discrete gates — a losing client parked in a multi-second html2canvas main render kept the capture selection for up to ~10s. Renders are now raced against a requestId-keyed cancel signal (watchCancellation/cancellationWaiters, released in wind-down; html2canvas abandonment is safe because onclone only mutates the clone). Both directions pinned (cancel DURING main render resolves with /cancelled by server/ immediately, instead of waiting out the render).
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260908T090251Z-4049718.md`
  **Budget status:** r27 fixes landed; this was the 10th authorized review round (r18–r27). The pass condition never triggered. **Resolution (2026-09-09): the user chose simplification** — see the Simplification entry above; the capture-activation machinery those rounds patched was replaced wholesale, and a fresh review episode reviews the simplified delta.

- **Delta round 26 (Codex, independent; base 5b8717017): FAILED — 3 Majors**, all assessed valid and fixed: (M1) the r25 receipt-side `consumeCancellation` ran synchronously at call time, eating the marker before the tail-scheduled job's own dequeue gate — the job then proceeded anyway. The check now runs BEFORE any job is enqueued (a cancel-before-frame consumes the marker and no work is ever created); the pin drains the queue and proves no renderer suspension/selection move happened. (M2) wind-down exactly-once was a DONE-flag + map-delete-at-start, creating two collision windows (natural-completion wind-down in flight when the abandon timer fires → timer saw no entry and advanced the tail mid-restore; timer-first wind-down in flight → job's own completion call returned early and won the tail race mid-wind-down). Wind-down is now a shared promise both drivers join, and the map entry survives until FULL settle (abandon timer waits on the same promise). Pinned by a fake-Date+setTimeout choreography asserting suspension #2 never begins before wind-down #1 ends. (M3) the Rust broker broadcasts captures to EVERY capable client but cancelled only on failure paths; the FIRST resolve left the other clients' queued/in-flight captures unanswerable. `resolve_from`/`resolve` now broadcast `screenshot.cancel` after answering the waiter (the winner's own finished job no-ops on it; losers unwind at the next gate). Node targets a single socket so it had no multi-client leak.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260908T082159Z-3068235.md`

- **Delta round 25 (Codex, independent; base 5b8717017): FAILED — 2 Majors + 1 Minor**, all assessed valid and fixed: (M1) the r24 hoist classifier counted EVERY active-iframe hoist after focusout/blur as user engagement — including ExtensionPane's deliberate `iframe.focus()` on eligibility flips (which captures trigger): tagged capture-side autofocus as user selection, vetoing the capture's own rollback. The classifier is now INTENT-GATED: a hoist only counts when real input preceded it within 1500ms (sequential-nav keydown landing on the parent document, or any pointer activity) — programmatic focus has no input trail. Both directions pinned vía jsdom (`KeyboardEvent` + real `iframe.focus()` vs. input-free autofocus). Residual documented: a mouse-click-into-iframe with zero recent parent-side pointer motion is misclassified and rolled back (conservative direction). (M2) the r24 receipt-time `min(ttlMs, 8s)` cap still gave delayed frames a fresh 8s budget post-timeout → the servers now broadcast a `screenshot.cancel` `ui.command` frame when they give up on a request (Node `ws-handler.ts` timeout callback; Rust `ScreenshotBroker.send_cancel` called from both failure branches in `screenshots.rs`); the client folds it into a requestId-keyed cancellation set consulted at queue-dequeue and at every staleness gate (ordering-robust for stalled clients). Old servers simply don't send it — the ttl path remains the old fallback. (m3/minor) `prepareIframeCapture` stamped markers before its throw-capable render loop and the throwing caller manually received no cleanup → leaf markers littered the live DOM; the prep path now reclaims its own markers on throw (shared fenced restore). Environment events this round: the shared ambient gcloud account was rotated away (another lane) — cloud gates now pin `GCLOUD_IDENT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com` explicitly; the worktree itself had lost group/other file bits (`drwx------`, 700/600) which broke dirty-image entrypoints (chmod-from-700 → container non-root could not exec) — repaired recursively to git-consistent modes.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260907T173320Z-3179368.md`

- **Delta round 24 (Codex, independent; base 5b8717017): FAILED — 4 Majors + 1 Minor**, all assessed valid and fixed: (M1) the r23 capture-scoped focusin listener treated EVERY pane focusin as user selection, including the capture's own capture-induced eligibility autofocus (components programmatically focus on flip) → the capture superseded itself / its own restore vetoed its targets. RESTATED with platform truth from focus-steal-guard.ts: nested-iframe engagement is a HoIST (activeElement becomes the iframe, no focusin fires parent-side) — the listener now observes focusout + window blur and attributes only when activeElement IS an iframe inside a pane subtree; the negative pin (in-pane input focus during capture fully restores) and the genuine-hoist pin both ride a real jsdom focus() instead of a fabricated focusin; (M2) the r23 test fabricated a parent-document focusin — impossible in Chromium — replaced by displacement-focusout observation (above); (M3) an abandoned capture's delayed iframe-marker cleanup could erase its successor's markers (`previousMarkers` restore unconditional) → cleanup now restores only markers it still owns (iframe→our marker map); (M4) even relative budgets started at COMMAND-HANDLING time, letting queued frames bank a full window → budget is now capped at receipt against the client-internal 8s ceiling (stale delivery can no longer inflate the window; fully enclosing skew would need clock negotiation — threat model); (Minor) the plan doc's "no runtime changes under server/ or crates/" claim was contradicted by rounds 21–23 — rewritten to state the as-built deployment (Rust server rebuild+restart required; frozen WS contract still untouched because ui.command payload is free-form).
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260907T164856Z-1385121.md`

- **Delta round 23 (Codex, independent; base 5b8717017): FAILED — 4 Majors**, all assessed valid and fixed: (M1) suspension depth incremented AFTER the suspend+paint window, so an abandon landing mid-acquisition (rAF can stall in background tabs) left the successor seeing depth 0: it re-suspended handlers and replace the resume bookkeeping → depth now increments at ENTRY and the acquisition paint/join logic skips re-collection; the capture registers its exactly-once wind-down fence BEFORE beginning suspension, with a late-resumer handoff when abandonment lands mid-acquisition (pinned by a same-tick double-entry test); (M2) the restore's own plain dispatches (r22 co-touch active-tab attribution) made pane restores mark the TAB coordinate touched, vetoing the tab restore that follows → restores now use the serial-invisible capture actions (setActivePane capture:true / selectTabForCapture), pinned by a "restore never self-poisons" test; (M3) the absolute server-epoch deadline compared against browser clocks — cross-device/phone clients share no wall clock → both servers now stamp a RELATIVE ttlMs budget and the client converts it to a local deadline at receipt (ws-protocol + broker payload tests updated); stale deadlineAtMs support dropped (never deployed); (M4) user interaction INSIDE an unlocked browser/extension iframe is invisible to shell handlers (nested-document events don't bubble) → during captures a document focusin (capture-phase) listener attributes focus landing inside any pane to its coordinates via noteDomPaneSelection (pane coordinate always, tab coordinate when that tab is active), pinned by a click-into-iframe-during-capture test. Test-hygiene: two park-then-release patterns now release in `finally`, and the supersession describe drains the capture queue in afterEach so deadline+grace deference cannot bleed across shuffled tests under suite load.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260907T153404Z-2637181.md`

- **Delta round 22 (Codex, independent; base 5b8717017): FAILED — 3 Majors**, all assessed valid and fixed: (M1) the round-21 abandon timer advanced the capture tail without fencing the abandoned job — a slow capture could resume after its successor started and overlap renderer resume / iframe-marker cleanup / restoreFocus, and capture-internal moves being serial-invisible meant the old restore could overwrite the successor's focus state → suspension is now REFCOUNTED in screenshot-capture-env (suspend increments depth, only the last resume releases renderers, every resumer idempotent), and abandonment is an EVENT that drives the abandoned job's exactly-once wind-down: Redux restore FIRST (its dispatches are synchronous up to the paint await) then renderer resume, with the tail advancing only after the wind-down promise settles — the successor snapshots restored state and never shares suspension with the abandoned job; choreographed-park test pins event order + final cursor, refcount/idempotence pinned by a focused env test; (M2) per-coordinate supersession treated the tab and its panes as independent even when the user clicked into a pane of the capture-exposed tab — a pane click dispatches only setActivePane so `pane:<tabId>` alone was marked touched and the restore hid the pane the user was engaging → touching a pane coordinate of the CURRENTLY-active tab now also marks the tab coordinate; pinned at middleware granularity + a restore-level pin; (M3) the deadline gate sat once before iframe preparation, but preparation renders one html2canvas per iframe and the main render followed unchecked → the gate (throwIfStale) now runs before EACH iframe render inside prepareIframeCapture and again after prep before the main render; fake-Date pin (deadline elapses inside the first iframe render → exactly one html2canvas call). Test determinism notes: the iframe-gate pin measures the deadline by fake Date with a jump inside the first render so loaded-box startup latency cannot preempt it, and diagnostics on tail leftovers confirmed each queue test drains its fence within ~700ms of completion.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260907T141253Z-3765372.md`

- **Delta round 21 (Codex, independent; base 5b8717017): FAILED — 2 Majors + 1 Minor**, all assessed valid and fixed: (M1) the round-20 queue TTL was measured from CLIENT receipt while both servers start their ~10s clock at SEND, the TTL was only checked at dequeue (a job could run unbounded past the caller's failure), and a never-settling head stalled queued jobs past their own TTL → both servers now stamp an absolute round-trip deadline on the capture frame (`deadlineAtMs`; Node ws-handler + Rust broker/screenshots), the client expires-against-deadline at dequeue AND before every mid-flight focus write/render, a deadline race un-blocks queued callers even behind a stalled head, and the capture tail abandons a wedged job at deadline+grace (2s) so one stuck capture can't starve later ones (stale-receipt fallback: local receipt + 8s TTL); (M2) focus-neutral creation was client-only: BOTH server layout stores immediately made an agent-created tab/pane active, so during the layout-mirror window server cursor-relative ops (next/prev tab, omitted-target listing/rename) addressed the background item → `createTab`/`create_tab` keep the cursor on the user's tab (first-tab activation retained) and `splitPane`/`split_pane` no longer promote the new pane; stale REST pins of "create sets the active tab" updated on both stacks (Node agent-cli-flow e2e, Rust pane_ops list test); (1 Minor) serial mismatch abandoned ALL restore coordinates — a capture's background pane move (e.g. inside a zoomed tab) outlived the user's unrelated tab selection → restores are now per-coordinate: the middleware records WHICH coordinate each selection gesture touched (LRU-bounded), and `restoreFocus` under supersession restores a coordinate only when the user never touched it and it still sits on the capture's own move target. Test-hygiene notes for the queue pins: neighboring tests' mock implementations survive `clearAllMocks` (only `resetAllMocks` severs them) and a never-releasing "stalled head" mock backlogged later tests' captures — every stalled-head scenario now explicitly waits for the head to park and releases it at test end. Environment note: 22 freshell-freshagent cargo tests fail inside worktrees without local `node_modules/tsx` (pre-existing, identical on base; the MCP-inject spawner resolves `tsx` under the repo root).
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260907T121838Z-3231145.md`

- **Delta round 20 (Codex, independent; base 5b8717017): FAILED — 1 Major**, assessed valid and fixed: the round-19 capture queue had no deadline — both servers drop a pending screenshot request ~10s after sending it (`server/ws-handler.ts` `opts.timeoutMs ?? 10_000`; `crates/freshell-server/src/screenshots.rs` `SCREENSHOT_TIMEOUT`), so a capture dequeued after its caller already failed would STILL execute: suspending renderers, moving tabs/panes, and sending an orphaned reply → queued jobs carry an 8s TTL checked at dequeue; an expired job returns an explicit failure result without suspending renderers or touching focus. Pinned with a fake-Date test (time jumps while a gated head capture holds the queue; the queued job expires behind it and never suspends or mutates the selection).
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260907T115120Z-2177546.md`

- **Delta round 19 (Codex, independent; base 5b8717017): FAILED — 2 Majors**, both assessed valid and fixed: (M1) screenshot captures ran fire-and-forget: concurrent captures interleave Redux focus moves and renderer suspension, and a second capture's restoreFocus dispatches PLAIN setActiveTab — bumping the serial — so the first capture's restore mislabels the overlapped capture as a user selection and abandons its rollback (user left on the wrong tab) → captures are serialized client-side on a promise-chained queue (the next capture starts only after the prior fully restores; failure of one does not stall the queue), pinned with a gated-suspend interleaving test; (M2) close-path fallback selections were invisible to the serial: `removeTab` selects a survivor when the ACTIVE tab closes, and `closePane` promotes a sibling when the ACTIVE pane closes (Alt+W / close buttons) — a mid-capture close could then be overwritten by the capture or its restore → the middleware state-diffs both actions and bumps only when the selection coordinate actually moved (background closes stay serial-invisible); positive + negative pins for both. (Environment note: the first full-suite attempt failed on an unrelated `App.ws-bootstrap` bootstrap-recovery timing flake under box load — green solo and on the rerun.)
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260907T092311Z-4109477.md`

- **Delta round 18 (Codex, independent; base 5b8717017): FAILED — 3 Majors**, all assessed valid and fixed: (M1) the selection serial covered only the fold actions (setActivePane/nudgePaneFocus/setActiveTab) — user gestures that move the selection through OTHER reducers went uncounted: default-activating `addTab` (new-tab shortcut, mobile strip, first tab), `switchToNextTab`/`switchToPrevTab` (keyboard navigation), default-activating `splitPane` (user split), `addPane` (local split); a screenshot restore could then roll back such a user's newer tab/pane → the middleware now diffs the selection coordinate before/after those actions and bumps only on actual movement, so agent folds (`activate:false`) stay serial-invisible; the masking screenshot test (addTab followed by an explicit setActiveTab) was un-masked to pin addTab-driven voiding directly; (M2) the serial was sampled once at snapshot time, but capture-internal focus writes happen AFTER async waits (WebGL renderer suspension = two frames) — a user selection landing mid-gap got stomped by `selectTabForCapture`, and the serial mismatch then simply disabled the restore, stranding the user on the capture's target → every capture-internal focus write now re-checks the serial and the capture aborts (`screenshot superseded by a newer user selection`) instead of stomping; tab-move and pane-move interleavings pinned, plus a no-interference move+restore control; (M3) an adoption-denied browser/extension iframe was unlockable ONLY by pointerdown: keyboard activation (Enter/Space on the focused pane shell → same-target setActivePane) produces neither an eligibility transition nor an epoch bump, so the lock never lifted for keyboard users (a11y violation) → `useIframeFocusLock` now listens on the pane SHELL (`[data-pane-shell]` — the target capture-phase keydowns actually reach; the inner component root never sees shell-targeted keys) and lifts on Enter/Space targeted at the shell, mirroring Pane.tsx's activation contract; keyboard-wake pinned in both pane types.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260907T084011Z-2258019.md`

- **Delta round 17 (Codex, independent; base 5b8717017): FAILED — 1 Major + 1 Minor**, both assessed valid and fixed: (Major) plain `tabs/setActiveTab` was invisible to the action-driven serial, so a user clicking the tab the capture was showing (activeTab still equals the capture's selection) looked indistinguishable from the capture's own switch and got rolled back → the serial now also counts tabs/setActiveTab, and the capture switches tabs via the new `selectTabForCapture` alias (serial-invisible, mirroring `setActivePane`'s `capture: true`); the captureSelectedTabId heuristic was removed entirely; same-target and third-tab mid-capture clicks pinned; (Minor) the MCP tool description told agents to `select-tab` after both new-tab and split-pane — a post-split select-tab doesn't focus the new pane, only the tab's existing active one → text now points split flows at select-pane.
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260906T000547Z-1361891.stderr`

- **Delta round 16 (Codex, independent; base 5b8717017): FAILED — 3 Majors**, all assessed valid and fixed: (M1) the stranded-body adoption rule was dead in the real lifecycle — the adoption hook's mount layout effect schedules the restore (marking the record restorePending) BEFORE components' passive focus effects consult the gate, so the pending guard on the strand exception never allowed it → strand exception no longer conditions on restorePending (pin via a real hook lifecycle test); (M2) my round-15 test wasn't actually deferred+denied (serverRunning flipped pre-remount) → rewritten to mount the denied remount with the server DOWN and then flip it (true regression coverage for the callback-ref wiring); (M3) `ui-screenshot.restoreFocus` could not distinguish the capture's own interim activations from a user/agent select that landed mid-capture and would forcibly roll the newer selection back → the selection serial is now ACTION-driven (`paneSelectionMiddleware`, store.ts): setActivePane/nudgePaneFocus dispatches bump it, with capture-internal moves marked `capture: true`; restoreFocus gates everything on the serial and, for plain tab clicks (which carry no epoch), distinguishes the capture's own tab switch via `captureSelectedTabId`. The wiring subscription (`wirePaneFocusOwnershipInvalidation`) now handles ONLY arrival-based invalidation.
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T231533Z-3516017.stderr`

- **Delta round 15 (Codex, independent; base 5b8717017): FAILED — 1 Major + 1 Minor**, both assessed valid and fixed: (1 Major) the click-to-wake listener in useIframeFocusLock depended on a ref read — a server extension whose iframe mounts late (serverRunning flip) never re-ran the effect, so its lock was un-liftable → the hook now takes the ELEMENT from a callback-ref state, re-running exactly when the node lands; (1 Minor) the burst rebuff could restore a stale displaced element when an ordinary focus transition preceded the hoist (and blurring the iframe re-queued the iframe itself as displaced) → burst-scoped: only the newest timer restores, restoring the burst's last NON-locked displaced element, gated on an actual hoist observation, with all timers cancel-on-dispose.
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T224200Z-2293339.stderr`

- **Delta round 14 (Codex, independent; base 5b8717017): FAILED — 2 Majors**, both assessed valid and fixed: (1 Major) an ownership-denied browser/extension remount latched the iframe lock permanently — the lock effect only reacts to eligibility/epoch inputs and plain pointer clicks produce neither, leaving the iframe inert until a tab switch → new `useIframeFocusLock` hook computes the lock post-commit AND lifts it on pointerdown inside the pane (click-to-wake; the inert click hits the pane shell, the NEXT click enters the iframe); (2 Major) the round-12 split/close race strand: a sibling whose teardown runs AFTER the focused pane's DOM vanished records body-focus, and bodyFocusAtRecord then denied its adoption permanently — the deliberate-leave/stranded distinction is unobservable at record time, so the rule now keys purely on read-time stranding (a record owned:false mount with focus on document.body always adopts; stranding typing is strictly worse than a rare honest remount refocus), the bodyFocusAtRecord field is removed, and the two mid-directive directives (race pin + deliberate-leave-with-focal-element pin) pin the semantics.
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T220629Z-903083.stderr`

- **Delta round 13 (Codex, independent; base 5b8717017): FAILED — 1 Major + 1 Minor**, both assessed valid and fixed: (1 Major) the round-12 iframe-lock change read `mayFocusNow()` during RENDER — React renders the replacement subtree before the outgoing subtree's layout cleanups write the ownership record, so a render-time adoption read latched "unknown → allowed" permanently and stole focus/unlocked the frame on every real split-swap of an active browser/extension pane → lock state is now computed in a post-commit layout effect (deletions' records exist by then; update applies before paint) and never latched at render; commit-order regression pinned with single-parented swap tests (the earlier separate unmount/render pattern could not see it); the wall-e2e browser-arm gap is disclaimed: MCP browser arms render cross-origin placeholders where nested-document hoisting cannot occur, so unit + the earlier Chromium verification carry focus autonomy for frames; (1 Minor) the focus-steal guard's queued rebuff timer survived disposal → timers are tracked and cancelled by the disposer, with a disposal pin.
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T212632Z-3356170.stderr`

- **Delta round 12 (Codex, independent; base 5b8717017): FAILED — 2 Major + 2 Minor**, all assessed valid and fixed: (1 Major) real close-of-active-pane ordering (dispatch before commit) left the close-promoted sibling with a non-owned record carrying the already-advanced serial, denying its adoption and stranding focus on body → records now distinguish "body focus at record time" (deliberate user choice) from post-teardown stranding, and an owned:false record yields adoption when focus has stranded on body; (2 Major) browser/extension iframe locks keyed only on Redux eligibility — an ownership-DENIED remount of an active pane rendered an unlocked iframe reachable by in-page autofocus scripts, which the focus-steal guard ignores → locks now follow actual focus-permission (`!focusEligible || !mayFocusNow()`); (1 Minor) DOM supersedence compared nearest-root ELEMENT identity while shells and inner content roots share the same data-pane-id → compares ids now, so same-pane focus movement can't mask a restore; (2 Minor) hydratePanes (cross-device sync) never pruned focusEpochByPaneId → entries for panes no longer present after a merge are deleted.
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T202905Z-965468.stderr`

- **Delta round 11 (Codex, independent; base 5b8717017): FAILED — 1 Major + 1 Minor**, both assessed valid and fixed: (1 Major) an activating (user-driven) split reassigns activePane BEFORE teardown, so the record carried the already-advanced serial and the restore yanked focus back from the new pane — the restore now ALSO applies DOM-level supersedence at fire time (focus that landed in another pane's subtree, or anywhere concrete, is not ours to take; only body-lost or same-subtree focus is restored), and records superseded by any later selection are voided for mount adoption (covers the close-promoted sibling that mounts already-eligible with no flip transition); (2 Minor) epoch-entry REMOVALS introduced by the round-10 closePane/removeLayout cleanup bumped the serial via the any-write epoch comparator → epoch bumps now count additions/changes only, matching activePane's exemption of non-selection churn.
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T043420Z-591576.stderr`

- **Delta round 10 (Codex, independent; base 5b8717017): FAILED — 1 Major + 4 Minor + 1 Nit**, all assessed valid and fixed: (1 Major) a late async Monaco mount consulted the stale descriptor without the selection serial — in split-then-select the select's effect hit only the pane root (editorRef still null), then onMount suppressed its own autofocus forever → `shouldRecordSuppressAutofocus(paneId)` gates the skip on BOTH descriptor resolution AND "no selection after the record"; (1 Minor) the serial bumped on activePane REMOVALS too (closes / cross-tab hydrate deltas masquerading as selections) → value-changes-only for activePane (additions + removals exempt; value changes count); (2 Minor) PaneContainer subscribed every mounted pane tree to the whole `focusEpochByPaneId` object and the reducers never pruned it → per-leaf selector (a select re-renders only the selected pane) + epoch cleanup in closePane/removeLayout; (3 Minor) descriptor uniqueness was verified only at record time → restore re-verifies uniqueness in the CURRENT subtree and abandons on ambiguity instead of first-match guessing; (4 Minor) no MCP-wrapper-to-focus coverage → MCP unit test pins that creation flows (new-tab variants, split-pane, rename-tab) never POST to `/select` endpoints (focus moves only via explicit select verbs); (1 Nit) store.ts comment said "removed from every layout are forgotten" contradicting the arrival-based lifecycle → comment corrected to the arrival semantics.
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T034853Z-2876838.stderr`

- **Delta round 9 (Codex, independent; base 5b8717017): FAILED — 1 Major + 1 Minor**, both assessed valid and fixed: (1 Major) removal-based record deletion in the store subscriber runs BEFORE React's layout-cleanup re-record, so closed-pane records survived anyway → invalidation is now ARRIVAL-based (a pane id re-appearing in any layout forgets its stale record; removal-side records simply linger LRU-bounded), immune to commit ordering and still covering reopenClosedTab's preserved leaf ids; (2 Minor) the round-8 selection serial bumped on ALL activePane identity changes, including focus-neutral background `tab.create` (new-key addition via initLayout) → the serial now bumps only on existing-key changes/removals for activePane, while the focus-epoch map keeps any-write semantics (every epoch write is an explicit select fold).
  Runner verdict captured in stderr (report write lost by runner): `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T023514Z-69175.stderr`

- **Delta round 8 (Codex, independent; base 5b8717017): FAILED — 1 Major + 3 Minor + 2 Nit**, all assessed valid and fixed: (1 Major) an agent restore in flight could override a NEWER explicit pane selection (scripted split-then-select) — restores now capture the selection serial at record time and skip when any explicit selection activity (activePane change or epoch nudge) landed since, wired via `wirePaneFocusOwnershipInvalidation(store)` in store.ts; (1 Minor) closed panes' records survived forever and regressed tab-reopen UX (`reopenClosedTab` preserves leaf ids) — records are forgotten the moment a pane id disappears from every layout (reopen mounts as fresh "unknown"); (2 Minor) cancelled-without-handler restores could strand `restorePending` indefinitely — pending records of dead panes are GC'd by the same layout walk; (3 Minor) multiline user-derived attribute text (e.g. the fresh-agent glom button's aria-label) made `querySelectorAll` throw during teardown recording — candidates with CSS string terminators are skipped and selection is wrapped defensively; (1 Nit) dead `INSTRUCTIONS` import + trailing blank line in `freshell-tool.test.ts` removed; (1 Nit) non-conventional commit subjects noted — new rounds use conventional prefixes; history left as-is.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T014837Z-2522869.md`

- **Delta round 7 (Codex, independent; base 5b8717017): FAILED — 3 Major + 2 Minor**, all assessed valid and fixed: (1 Major) split of a DOM-focused but Redux-inactive pane dropped focus to body → record-driven restore independent of adoption + `.tab-hidden` guard (Task 12.1); (2 Major) consecutive splits overwrote the descriptor with intermediate autofocus artifacts → restore-pending non-overwrite window (Task 12.2); (3 Major) pane-shell focus was not representable (querySelectorAll never matches root) → `:scope` sentinel + `data-context` fallback (Task 12.3); (1 Minor) title-candidate coverage pin tightened; (2 Minor) prose-containment test block deleted per repo policy.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T011958Z-1346781.md`

- **Delta round 6 (Codex, independent; base 5b8717017): FAILED — 3 Major + 2 Minor**, all assessed valid and fixed: (1 Major) stale `editorRef` on monaco unmount — flip called a disposed editor instead of the root fallback → `editorRendered` tracking + ref clear (Task 11.1); (2 Major) async Monaco onMount autofocus stomped the mount-window descriptor restore → `handleEditorMount` skips its adoption focus when a recorded descriptor resolves (Task 11.2); (3 Major) descriptor could not represent a focused embedded iframe (or title-only controls) → ordered unique-resolving candidates incl. sole-iframe and title, with BrowserPane embedded-page restore pinned (Task 11.3); (1 Minor) refresh-then-evict LRU defect at the 512 cap (re-recording did not refresh insertion order) → delete-then-set + pin; (2 Minor) wiring suite's "every content arm" missed terminal/fresh-agent/directory epoch forwarding → all seven arms pinned.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T004703Z-4055432.md`

- **Delta round 5 (Codex, independent; base 5b8717017): FAILED — 3 Major + 2 Minor + 1 Nit** (runner exited 2 on a report-format contract error; review content complete and treated as the verdict), all assessed valid and fixed: (1 Major) agent split of the focused pane redirected inner-element focus to the content default → element-identity descriptor record + mount-window restore (Task 10.1); (2 Major) explicit select could not focus preview/empty editors → focusable pane root + `focusEditorOrRoot` fallback (Task 10.2); (3 Major) epoch boundaries underprotected → per-arm wiring pins, real-pointer-path no-bump pin, epoch refocus pins for picker/directory/extension, e2e §8b browser-arm same-target select (Task 10.3); (1 Minor) `focusEpochByPaneId` reached persisted layout writes → denylisted + pin; (2 Minor) e2e §7 vacuous-without-payload risk → postMessage attempt handshake gate; (1 Nit) stale "EVERY activation" doc comment corrected.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260905T000019Z-2003515.md`

- **Delta round 4 (Codex, independent; base 5b8717017): FAILED — 3 Major + 2 Minor**, all assessed valid and fixed: (1 Major) FreshAgentView composer/root focus effect keyed only off Redux activity — the sole pane autofocus outside Task 8's gate → `usePaneFocusAdoption` adopted (Task 9.1); (2 Major) adoption latch was `pending`-only — a denied remount could never recover on a later eligibility flip → flips/epoch-bumps resolve `'allowed'` unconditionally (Task 9.2); (3 Major) same-target select produced no eligibility transition and no focus → per-pane focus epoch (`focusEpochByPaneId`; pane.select fold nudges via `setActivePane focusNudge:true`, tab.select fold via `nudgePaneFocus`; PaneContainer forwards `focusEpoch` to every arm; `mayFocusNow` identity re-runs focus effects) + wall e2e §6b (Task 9.3); (1 Minor) ownership 512-cap wiped the map including the just-written record → oldest-entry eviction; (2 Minor) PaneContainer wiring suite gained the extension arm. During implementation a regression was caught pre-merge: bumping the epoch inside every setActivePane re-ran terminal focus on pointer mousedowns (rename/search focus theft) — narrowed to explicit select folds only, pinned in panesSlice tests.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260904T231851Z-313099.md`

- **Delta round 3 (Codex, independent; base 5b8717017): FAILED — 5 Major + 1 Minor**, all assessed valid and fixed: (1 Major) BrowserPane inert insufficient — nested-document scripts hoist the iframe into outer activeElement regardless of attribute combination; fixed by the `data-focus-locked` rebuff guard (Task 8 mechanism 1); (2 Major) ExtensionPane same → same fix; (3 Major) ExtensionPane focus effect missed deferred iframe appearance (server start / registry hydration) → effect now also keyed on iframe-readiness, adoption consumed lazily; (4 Major) PaneContainer `focusEligible` is Redux selection, not DOM-focus ownership — agent split while the user was in app chrome stole focus back on remount → Task 8 mechanism 2 (ownership record + adoption gate in all six mount-focus components) + wall e2e §6; (5 Major) EditorPane stale-closure — saved onMount captured the initial `focusEligible=false`, so a select landing before Monaco's async mount never focused → render-synced `focusEligibleRef` + adoption-aware mount focus, flip-before-mount race test; (1 Minor) BrowserPane navigation-never-refocuses regression pin added.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260826T161259Z-1211030.md`

- **Delta round 2 (Codex, independent; base 5b8717017): FAILED — 2 Major + 3 Minor + 1 Nit**, all assessed valid and fixed: (1 Major) BrowserPane DOM-focus restoration was content-dependent — a LOADED browser pane (url set) had no focus path on explicit select or after a leaf→split remount, and ExtensionPane had no `focusEligible` support at all (same same-origin iframe steal vector Task 6 closed for browser panes) → Task 7 focus parity: BrowserPane root is now `tabIndex={-1}` with a merged owns-focus effect (empty pane → URL input, loaded pane → pane root; url tracked via ref so navigation never yanks focus), ExtensionPane threads `focusEligible` through PaneContainer's extension arm with the same inert gating + iframe focus (mount-while-eligible and false→true flip), verified by 2 new BrowserPane tests + a new `ExtensionPane.test.tsx` (638/638 pane suites green, wall e2e re-run green with the new baseline-focus step); (2 Major) plan doc no longer executable as written → EXECUTED banner at top, base note corrected for the mid-run rebase to 5b8717017; (1 Minor) e2e spec now asserts pane A owns document focus (`expect.poll(focusedPaneId).toBe(paneA)`) BEFORE tagging the identity marker, so the marker can never pin `body` or another tab's element; (2 Minor) the `activate:false` panesSlice test now pre-zooms the original pane so the unconditional zoom-clear invariant is pinned on that path; (3 Minor) Task 6's "inert via display:none" sentence corrected to the real `.tab-hidden` mechanism (`visibility:hidden` + absolute positioning + `pointer-events:none`); (1 Nit) duplicated Round 2 record entry removed.
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260826T082834Z-1938727.md`

- **Delta round 1 (Codex, independent; base 5b8717017): FAILED — 3 Major**, all assessed valid and fixed: (1) BrowserPane iframe focus-steal path → Task 6 inert gate (landed, e4b9b59ce); (2) Global Constraints' stale direct-`npx playwright` bullet contradicted the backend-wrapper policy — rewritten to reference the wrapper; (3) Task 3's test snippet had an unmatched `})` closing the describe early (the implementer had already applied the only valid reading; plan text corrected).
  Runner report: `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260826T073820Z-1241336.md`

- **Round 1 (Codex, independent): FAILED — 8 Major**, all assessed valid and
  fixed in this revision: (1) server-tree constraint vs Task 5's
  freshell-tool.ts text edit reconciled (doc-string-only carve-out + MCP
  rebuild deploy story); (2) PaneContainer focusEligible wiring tests added
  (new `PaneContainer.focusEligible.test.tsx` covers browser/editor/picker
  arms × eligible/hidden/other-pane-active, so a misrouted prop cannot pass
  green); (3) EditorPane focus moved out of mount-only `handleEditorMount`
  into a `focusEligible` effect (false→true flips focus on explicit select);
  (4) Task 3 deleted-pane fixture now split-then-close (root-leaf closePane
  is a no-op); (5) restoreFocus is best-effort + incomplete-reporting instead
  of early-return (surviving tab focus still restored); (6) the new e2e spec
  registers in BOTH `RUST_ONLY_SPECS` and rust-chromium testMatch (+ `--list`
  verification); (7) Task 5's MCP suite runs under
  `vitest.server.config.ts` (`test/unit/server/**` is excluded from the
  default config); (8) Task 5 pins the doc strings with a real RED test
  across TOOL_DESCRIPTION, INSTRUCTIONS, and HELP_TEXT (via the help action).
  Runner report:
  `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260826T010828Z-942802.md`

- **Round 2 (Codex, independent): FAILED — 6 Major + 1 Minor**, all assessed
  valid and fixed in this revision: (1 Minor) stale base → new "Base sync
  first" constraint step; (1 Major) e2e commands now go through the backend
  wrapper (`scripts/e2e-cloud.sh run --local/--cloud`); discovery-only `--list`
  exempted; backend choice is user-pinned before Stage 4 per repo policy;
  (2 Major) DirectoryPicker wiring coverage added by driving PickerWrapper
  through its directory step in the wiring test; (3 Major) EditorPane once more:
  the round-1 effect-only gate drops ASYNC Monaco onMount autofocus (the parent
  effect runs before onMount ever assigns editorRef) — now DUAL mode: gated
  `if (focusEligible) editor.focus()` inside handleEditorMount PLUS the
  prev-ref flip effect, with the mock gaining delayed-onMount support and a
  flip test; (4 Major) Task 3 exports restoreFocus/FocusSnapshot as a logic-free
  prerequisite before RED (a module-load RED is the wrong failure); (5 Major)
  the post-paint verify treats during-window deletion as incomplete (with an
  rAF race pin); (6 Major) the e2e spec pins exact active-element identity via
  tag markers + rAF-settle, and asserts explicit selects move DOM focus.
  Runner report:
  `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260826T014331Z-1577551.md`

- **Round 3 (Codex, independent): FAILED — 7 Major + 1 Minor** (final allowed
  review round), all assessed valid and fixed in this revision via the same
  commit: (1 Major) editor-arm wiring captures now await the pane's React.lazy
  boundary via `waitFor` (synchronous reads could throw on an empty capture);
  (2 Major) the wiring store preloads extension entries so 'claude' actually
  routes to PickerWrapper's directory step instead of throwing; (3 Major) the
  post-paint pane verify ALSO checks owning-tab existence (split-slice stale
  state), plus an owning-tab mid-flight race pin test; (4 Major) the e2e spec
  tags focus only after a readiness gate (the picker's fade transition delays
  onSelect, so a naive tag pins the about-to-unmount picker element); (5 Major)
  the split section's DOM contract became "new pane never focuses + original
  active pane reacquires focus" — leaf→split REMOUNTS the original pane's DOM
  subtree (pre-existing, same as user splits), so an identical-element
  assertion cannot survive; (6 Major) the `grep -c` discovery checks now
  capture+compare (`grep -c` exits 1 on zero matches); (7 Major) the false
  "typecheck covers the e2e config" claim was removed (`npm run typecheck` does
  not include test/e2e-browser/**); (1 Minor) base-sync note corrected —
  upstream delta DOES touch AGENTS.md (a Task 5 anchor), so that anchor must be
  re-verified post-sync. Plan review round cap (3) now reached; every valid
  finding across all three rounds is fixed in this revision.
  Runner report:
  `.worktrees/.the-usual-logs/mcp-focus-neutrality/review-logs/usual-fresheyes-20260826T021400Z-2126234.md`

## Out of scope (recorded, not fixed here)

> **Superseded items:** the first bullet below was FIXED by delta round 21
> (both layout stores became focus-neutral for agent creates/splits), and
> round S2 of the simplification episode additionally fixed the closeTab
> ROLLBACK path (background closes keep the cursor; active closes select the
> previous neighbor). The Rust-broadcast-vs-Node-unicast bullet is moot for
> captures: the client renders off-DOM and a losing client's stray result is
> ignored as an unknown requestId. Retained as history.

- **Server-side layout mirrors self-activate on create/split**
  (`server/…/layout-store` and `crates/freshell-…/layout_store.rs:446-465`):
  these feed only agent target resolution / `GET /api/tabs` snapshots, never
  the user's client focus. Unchanged by design.
- **tab.close/pane.close neighbor focus fallback** — picking a sibling on
  deletion is inherent to the deleted target disappearing. Unchanged.
- **Rust screenshot.capture broadcasts `ui.screenshot` to ALL clients while
  Node targets the requesting socket** (`crates/freshell-ws/src/screenshot.rs:159-185`)
  — pre-existing divergence, recorded as a known issue.
- **Node `broadcast()` sends ui.command frames to unauthenticated sockets too**
  (`server/ws-handler.ts:3879-3885`) — pre-existing surface note, recorded.
- **`test/unit/vite-config.test.ts` env fragility** — the suite inherits
  `FRESHELL_BIND_HOST` from a live Freshell pane; mitigated run-side by the
  mandatory env-sanitize prefix in Global Constraints, not by code here.

<!-- PLAN-END -->
