# Close-Tab Activity Ratchet Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Treat closing a tab as a user touch on that session: ratchet its locally-stored session activity timestamp at close time so the just-closed session sorts near the top of the non-pinned (grey) sidebar section under the default activity sort mode. The pinned status-tier ordering already shipped on main (feat `6bbdb6219`); this run covers only the close-touch behavior and its composition with that existing sort.

### Explicit constraints
- None stated beyond the requested result.

### Accepted tradeoffs and residuals
- A session whose only sidebar row was a client-side placeholder row disappears at close; no row remains to float (the stored value still applies once the server indexes the session).
- A browser reload landing between an in-terminal Codex fork's close and the backgrounded terminal's later identity broadcast can lose the touch across the reload (only the old key was persisted).
- A legacy shell-mode pane closed while the terminal directory is unavailable gets no touch.
- Tab closes initiated via REST/MCP/server broadcast flow through the same client thunk on every connected client and therefore also ratchet locally (a mirrored close ratchets harmlessly).
- The float is visible under the default activity sort; other sort modes get no ratchet input by existing design.

**Goal:** Closing a tab ratchets the locally-stored session activity timestamp of every sidebar row that tab stood for, so the just-closed session floats to the top of the grey (non-pinned) section under the default activity sort.

**Architecture:** The ratchet is a close-commit-time dispatch inside the existing evidence-gated `closeTab` thunk (src/store/tabsSlice.ts): two ratchet-only `updateSessionActivity` loops over the frozen pre-close snapshot — one over the tab's canonical session refs (`collectSessionRefsFromTabs`), one over its terminal leaf contents whose identity lives elsewhere (registry-only sessionRef / codex durability, identity-less live-terminal fallback rows, directory-load gaps) via a ported pure helper `liveTerminalRowIdentity` (src/lib/session-utils.ts). Because a touch recorded under one key can end up orphaned when the terminal's identity later binds or rebinds, the reviewed alias→canonical and canonical→canonical folds are ported at the two identity choke points: `reconcileTerminalSessionAssociation` (src/lib/terminal-session-association.ts) and `fetchTerminalDirectoryWindow` (src/store/terminalDirectoryThunks.ts). No change to the tier-sort machinery: the grey tier already consumes `ratchetedActivity` with presence-priority inside `compareByStatusTiers`.

**Tech Stack:** TypeScript, Redux Toolkit (`createAsyncThunk` / `createSlice` / `createSelector`), Vitest + Testing Library.

## Planner verification notes (bounded reads at current base `12c408f879f39744640763745da280dfef44a8026`)

The brief's stated baseline `de1662095` is an ancestor of this worktree HEAD (`git merge-base --is-ancestor de1662095 HEAD` → true); HEAD `12c408f8` is current `origin/main` including the focus-neutrality merge #759 and sidebar fixes #753/#754/#757/#758. All citations below are from the worktree at HEAD.

1. **Grey-tier ratchet composition (decision A verification).** `sortSessionItems` (src/store/selectors/sidebarSelectors.ts:679-801) in `activity` mode: applied search (`disableTabPinning`) sorts by `compareByActivity` (:759-761); `options.statusTiers` (fed unconditionally by `makeSelectSortedSessionItems` at :858 from the module-level `makeSelectSessionStatusTiers()` instance :21) sorts by `compareByStatusTiers` (:763-764). `compareByStatusTiers` (:729-735) ranks via `sessionStatusTierRank` (src/store/selectors/sessionStatusTiers.ts:30-36; grey = rank 4 per :28) and within a tier uses `compareByActivityRecency` for ranks ≤ 1 (local tiers, :709-713 — pure `ratchetedActivity ?? timestamp` recency) and **`compareByActivity` for ranks ≥ 2, which includes grey** (:694-701 — ratchet-presence first, then recency). **The grey tier still puts ratcheted entries first** — a close-time ratchet floats the just-closed session to the very top of grey. `buildSessionItems` fills `ratchetedActivity` from `sessionActivity[key]` for project sessions (:254, :274), pane/tab fallback rows (:367), and identity-less live-terminal rows keyed `<provider>:terminal:<terminalId>` (:506-524, `liveTerminalSessionId` :89-91). `updateSessionActivity` is ratchet-only (`if (lastInputAt > existing)`, src/store/sessionActivitySlice.ts:81-96) and `makeSessionKey` passes pre-composed colon keys through unchanged (:13-17). Persistence: 5s-debounced localStorage middleware (src/store/sessionActivityPersistence.ts:4, :51, :59). Non-`activity` modes get `EMPTY_ACTIVITY` (sidebarSelectors.ts:68-72) — residual 5 verified.
2. **Main already ships a grey-transition touch watcher** (the dominant drift since the prior run): `src/store/sessionGreyTouch.ts` (commit `bb192a997` + wiring `05428658e`, Sep 2 — the same series as the tier sort `6bbdb6219`) subscribes to the store and touches every tier-map key that transitions non-grey → grey with `updateSessionActivity({ sessionId: <full composite key>, lastInputAt: now })`; wired in src/App.tsx:738. The tier map (sessionStatusTiers.ts:79-157) derives from tabs/panes/activity-slices/remote-registry only — it never reads the terminal directory. Its tests pin the close path (test/unit/client/store/sessionGreyTouch.test.ts:182-194 — `removeTab` → local-open → grey touch). Coverage vs. the five reviewed behavior classes: (a) canonical refs are covered at close (they are `localOpenKeys`, sessionStatusTiers.ts:118-129) except when the session is simultaneously open in another local tab (no grey transition → no touch); (b) identity-less live-terminal rows are covered only when the pane *content* `status === 'running'` (`resolveTerminalFallbackRowKey`, src/lib/pane-activity.ts:382-393); (c) registry-only identities are NOT covered — the canonical key never enters the tier map from the registry, and the content-derived alias key gets a junk touch; (d) directory-load gaps are covered only in the content-running identity-less variant; (e) no folds exist anywhere. This plan therefore ports the reviewed close-time thunk ratchet (classes a-d, exact reviewed semantics) and the folds (class e); the watcher remains and the overlap is harmless because both paths are ratchet-only (max wins).
3. **`closeTab` current shape (insert point).** src/store/tabsSlice.ts:689-823: evidence-gated. `stateAtClose = getState() as RootState` (:733); in-flight guard (:734-737); frozen layout/tab/paneTitles (:738-741); `markTabClosing` (:743); batch ack via `sendPanesClosedAndAwait` (KILL_ACK_TIMEOUT_MS = 5000, src/lib/kill-ack.ts:45; the ws mock in tabsSlice.test.ts:41-75 answers success inline); **on ack failure the tab STAYS and the thunk returns at :757** — the ratchet must sit on the success path only; success path pushes the closed-tab snapshot (:766-789) and reopen-stack entry (:791-800), then `dispatch(removeTab(tabId))` + `dispatch(removeLayout(...))` (:807-808). **Insert the ratchet between the reopen-stack block (ends :800) and the `// The frozen set is authoritative (F3):` comment (:802).** Mirrored closes: `ui.command` `tab.close` → `dispatch(closeTab(msg.payload.id))` (src/lib/ui-commands.ts:117-118) — residual 4's mechanism statement is true at the current base.
4. **`session-utils.ts` current state.** `collectSessionRefsFromTabs` (:294-305) covers layout tabs via node locators and layout-less tabs via `buildTabFallbackLocator` (:143-157 — tab.sessionRef, then tab-level codex durability, then claude resumeSessionId). `extractSessionLocators` (:107-141): explicit sessionRef, codex durability locator, claude resumeSessionId (codex `resumeSessionId` is NOT a locator, :136-138). `liveTerminalRowIdentity` does NOT exist on main (the prior branch was never merged — `origin/the-usual/sidebar-pinned-status-sort` HEAD `803a050f7` holds it; this plan ports it from commits `5c74ab168`/`632cb3338`).
5. **`terminal-session-association.ts` current state.** `reconcileTerminalSessionAssociation` (:62-156) returns 'ignored' | 'reconciled' | 'conflict'; the conflict gate is :98-105/:114; the orphan path is `if (!matchedAnyPane) return 'ignored'` :115; `previousSessionId` is the server-authoritative rebind token (:93-97). No folds, and `SessionAssociationState` picks only `panes | tabs` (:13). It is called from App.tsx's ws handler for `terminal.session.associated` / `terminal.created` / `terminal.attach.ready` (App.tsx:1278-1296) and from `terminal.inventory` (:1313-1321) — always with the full store `getState`, and regardless of pane presence, so post-close orphan frames still reach it. **The fold hook belongs after the conflict gate (:114) and before the ignored return (:115), pane-match independent.**
6. **`terminalDirectoryThunks.ts` / slice current state.** `fetchTerminalDirectoryWindow` (:55-109) fetches a page, checks abort (:83), and applies it via `setTerminalDirectoryWindowData` (:85-91) — no folds. Sidebar feeds `state.terminalDirectory.windows.sidebar.items` as the `terminals` selector input (src/components/Sidebar.tsx:237-239), and `buildSessionItems` still rows identity-less running terminals under `<mode>:terminal:<terminalId>` (sidebarSelectors.ts:481-534). Refreshes reach the thunk on every `terminals.changed` / `terminal.meta.updated` broadcast (src/lib/terminal-invalidation-handler.ts:64-119 — debounced `runRefresh`) and on connect (App.tsx:1341-1343), mounted or not. **Fold insert point: between the abort check (:83) and the `setTerminalDirectoryWindowData` dispatch (:85).**
7. **Test harnesses verified.** tabsSlice.test.ts: ws mock answers `panes.closed.result` success (:41-75); `closeTab` completes; stores compose tabs/panes (+connection). terminal-session-association.test.ts: `createState(content, tabOverrides)` harness (:7-27). terminalDirectoryThunks.test.ts: `getTerminalDirectoryPage` mocked (:10-20). Sidebar.test.tsx: `createTestStore` (:122-300) supports `projects/tabs/terminals/sessionActivity/sortMode` with inferred running pane content (:171-184); `renderSidebar(store, terminals)` (:308-320); its ws mock does NOT answer close acks (:51-57) and no existing test dispatches a close thunk (verified by grep) — Task 2 upgrades the mock inertly. activity-sort.test.tsx: localStorage round-trip integration home (:16-34). sessionGreyTouch.test.ts: watcher harness (:121-169).
8. **Residual verification (decision E — all five still true at the current base).** (1) Placeholder rows are built from `panes.layouts` (sidebarSelectors.ts:384-479) so they vanish on close; the projects loop fills `ratchetedActivity` once the server indexes the session (:254/:274). (2) The folds are runtime dispatches; persistence stores pre-fold keys, and a post-reload first directory sighting has no previous-window evidence of the superseded identity. (3) Shell-mode content yields no locator and no fallback key (pane-activity.ts:385, session-utils.ts:129). (4) Mirrored closes flow through the same client thunk (ui-commands.ts:117-118). (5) Non-activity modes get `EMPTY_ACTIVITY` (sidebarSelectors.ts:68-72). No wording adjustments required through the dispatcher.
9. **Prior-run behavior classes (brief item 3) — port/drop dispositions, with evidence.** The five classes were encoded in repair commits `632cb3338`, `5c74ab168`, `6d33b9d2b`, `c65962158`, `803a050f7` on `origin/the-usual/sidebar-pinned-status-sort` (HEAD `803a050f7`, 8 commits; `git show 803a050f7 --stat` read in full). (a) canonical session refs — **ported** (Task 2 canonical loop; preserves the reviewed unconditional semantics the watcher does not fully cover, e.g. a session still open in another local tab); (b) identity-less live-terminal fallback rows — **ported** (Task 1+2 terminal-key branches; the watcher only covers the content-running variant per pane-activity.ts:383); (c) registry-only canonical identities — **ported** (Task 1+2 registry sessionRef / codex durability branches; the tier map cannot see registry identity, sessionStatusTiers.ts:48-57); (d) terminal-directory load gaps — **ported** (Task 1+2 content-branch fallback key, keyed regardless of content status or directory presence); (e) alias→canonical folds on late identity binding (association reconcile path AND the directory-apply path, which folds every provider's `<provider>:terminal:<terminalId>` alias onto the applied item's canonical identity — codex durability AND non-codex sessionRef bindings, the latter stranded when the association frame passes during closeTab's ack wait, before the close-time ratchet writes the alias) and canonical→canonical rebinds (codex fork handoffs, including silent directory-snapshot identity swaps for disconnected clients) — **ported in full** (Tasks 3-4; nothing equivalent exists on main per notes 5-6). No class dropped: every trigger condition still exists at the current base. The prior branch's interim TerminalView fold call was superseded within that branch itself (`c65962158` moved it to the directory thunk) and is not ported.
10. **Deviations from coordinator decisions A-E: none.** A: no changes to `statusTiers` / `sessionStatusTierRank` / `compareByStatusTiers` / `makeSelectSessionStatusTiers` — the verified grey-tier comparator already surfaces `ratchetedActivity`-first within grey (note 1), so the float composes with main's actual comparator and no redesign is needed. B: all five reviewed classes ported with ratchet-only semantics (note 9). C: test levels per task below PLUS a seeded e2e phase — Task 5 appends a close-touch phase to the existing `test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts` (registered in RUST_ONLY_SPECS and NOT in CLOUD_SKIP_SPECS, so it covers both the local rust-chromium project and the cloud backend): that harness already seeds JSONL sessions with a fake claude CLI, opens local tabs by row clicks, and asserts exact sidebar order, so the phase is ~20-40 lines — close the OLDEST-seeded session's tab through the real TabBar close button (the real Rust server answers the batch ack) and assert it floats to the top of the grey section. The phase pins the user-visible Requested result end-to-end (real close-ack path included); its known boundary — it cannot isolate the closeTab ratchet from the pre-existing grey-transition watcher (same canonical key, max-wins) — is stated plainly in Task 5's text, with mechanism isolation remaining in the unit tests' watcher-gap shapes. Unit (thunk + helper), integration (persistence debounce), and component (Sidebar float) levels still cover every new branch with observable verification. (Decision C's original "a meaningful e2e would need a real streaming agent session" premise was falsified against that harness by the Stage-2 load-bearing review; see `/home/dan/code/freshell/.worktrees/.the-usual-logs/sidebar-close-touch-ratchet/reports/load-bearing-strategist.md`, LB-3.) D: no settings, toggles, docs pages, or UI beyond ordering; **`docs/index.html` not updated** — the mock does not encode row-order semantics and no new control, section, or visual affordance is introduced; ring visuals and busy/green icon logic untouched. E: residuals carried verbatim and each verified true (note 8).

## Global Constraints

- Server uses NodeNext/ESM (relative imports include .js) — client code follows existing TS/React/Redux Toolkit conventions.
- Coordinated test commands: focused vitest via `npm run test:vitest -- run <paths>` (never raw npx vitest); broad suites through the coordinator (`npm test` / `npm run check`) from the worktree.
- TDD red/green/refactor for every change; no coverage reductions, no skipped tests.
- Commit author identity inherited from repo config — do not touch git config.
- Commit messages: conventional, focused.

### Task 1: `liveTerminalRowIdentity` — resolve the sidebar row activity key for a closing tab's terminal content

**Files:**
- Modify: src/lib/session-utils.ts:9 (extend the `@/store/types` type import), insert the new interface + function after `collectSessionRefsFromTabs` (ends at line 305, before `getActiveSessionRefForTab` at line 307)
- Test: test/unit/client/lib/session-utils.test.ts (add `liveTerminalRowIdentity` to the import block at lines 2-11; add `import type { BackgroundTerminal } from '@/store/types'` after the line-19 import; append a new `describe` at end of file)

**Interfaces:**
- Consumes: `extractSessionLocators(content: PaneContent)` (same module, :107), `sanitizeSessionLocator(locator?)` (same module, :54), `isNonShellMode(mode)` (already imported, :5), types `PaneContent` (:7), `CodingCliProviderName` (:9), `BackgroundTerminal` (to import), `BackgroundTerminal['sessionRef']`/`['codexDurability']`.
- Produces: `export interface LiveTerminalRowIdentity { provider: CodingCliProviderName; key: string }` and `export function liveTerminalRowIdentity(content: PaneContent, terminal: Pick<BackgroundTerminal, 'terminalId' | 'status' | 'mode' | 'sessionRef' | 'codexDurability'> | undefined): LiveTerminalRowIdentity | undefined` (Task 2 consumes).

- [ ] **Step 1: Write the failing behavioral test**

In test/unit/client/lib/session-utils.test.ts, add `liveTerminalRowIdentity` to the existing import from `@/lib/session-utils` (lines 2-11), add `import type { BackgroundTerminal } from '@/store/types'` near the line-19 type imports, and append at the end of the file:

```ts
describe('liveTerminalRowIdentity', () => {
  function registryTerminal(overrides: Partial<BackgroundTerminal> = {}): BackgroundTerminal {
    return {
      terminalId: 'term-1',
      title: 'Agent pane',
      createdAt: 1,
      lastActivityAt: 1,
      status: 'running',
      hasClients: true,
      mode: 'opencode',
      ...overrides,
    }
  }

  function agentContent(
    mode: TerminalPaneContent['mode'] = 'opencode',
    options: Parameters<typeof terminalContent>[1] = {},
  ): TerminalPaneContent {
    return terminalContent(mode, { terminalId: 'term-1', ...options })
  }

  it('keys a running identity-less agent terminal as <mode>:terminal:<terminalId>', () => {
    expect(liveTerminalRowIdentity(agentContent(), registryTerminal())).toEqual({
      provider: 'opencode',
      key: 'opencode:terminal:term-1',
    })
  })

  it('falls back to the content-mode terminal key when the registry entry is missing', () => {
    expect(liveTerminalRowIdentity(agentContent(), undefined)).toEqual({
      provider: 'opencode',
      key: 'opencode:terminal:term-1',
    })
    // Registry miss never keys shell content (shell terminals produce no row)
    expect(liveTerminalRowIdentity(agentContent('shell'), undefined)).toBeUndefined()
  })

  it('returns undefined when the terminal is not running and carries no canonical identity', () => {
    expect(liveTerminalRowIdentity(agentContent(), registryTerminal({ status: 'exited' }))).toBeUndefined()
  })

  it('returns undefined for shell-mode registry terminals', () => {
    expect(liveTerminalRowIdentity(agentContent('shell'), registryTerminal({ mode: 'shell' }))).toBeUndefined()
    expect(liveTerminalRowIdentity(agentContent('shell'), registryTerminal({ mode: undefined }))).toBeUndefined()
  })

  it('returns the canonical key when the registry terminal carries a sessionRef', () => {
    expect(liveTerminalRowIdentity(agentContent(), registryTerminal({
      sessionRef: { provider: 'opencode', sessionId: 'session-1' },
    }))).toEqual({
      provider: 'opencode',
      key: 'opencode:session-1',
    })
    // Canonical rows do not depend on terminal liveness
    expect(liveTerminalRowIdentity(agentContent(), registryTerminal({
      status: 'exited',
      sessionRef: { provider: 'opencode', sessionId: 'session-1' },
    }))).toEqual({
      provider: 'opencode',
      key: 'opencode:session-1',
    })
  })

  it('returns the codex canonical key for codex terminals with registry durability identity', () => {
    const durable = {
      schemaVersion: 1,
      state: 'durable',
      durableThreadId: 'durable-1',
    } as const
    expect(liveTerminalRowIdentity(agentContent('codex'), registryTerminal({
      mode: 'codex',
      codexDurability: durable,
    }))).toEqual({ provider: 'codex', key: 'codex:durable-1' })
    const candidateOnly = {
      schemaVersion: 1,
      state: 'identity_pending',
      candidate: {
        provider: 'codex',
        candidateThreadId: 'cand-1',
        rolloutPath: '/tmp/rollout.jsonl',
        source: 'thread_start_response',
        capturedAt: 1,
      },
    } as const
    expect(liveTerminalRowIdentity(agentContent('codex'), registryTerminal({
      mode: 'codex',
      codexDurability: candidateOnly,
    }))).toEqual({ provider: 'codex', key: 'codex:cand-1' })
    // codex WITHOUT any durability identity still gets a terminal key
    expect(liveTerminalRowIdentity(agentContent('codex'), registryTerminal({ mode: 'codex' }))).toEqual({
      provider: 'codex',
      key: 'codex:terminal:term-1',
    })
  })

  it('returns nothing when the content already carries canonical identity (canonical loop covers it)', () => {
    const withRef = agentContent('claude', {
      sessionRef: { provider: 'claude', sessionId: VALID_SESSION_ID },
    })
    expect(liveTerminalRowIdentity(withRef, registryTerminal())).toBeUndefined()
    expect(liveTerminalRowIdentity(withRef, undefined)).toBeUndefined()
    const withDurability = {
      ...agentContent('codex'),
      codexDurability: { schemaVersion: 1, state: 'durable', durableThreadId: 'durable-own' } as const,
    }
    expect(liveTerminalRowIdentity(withDurability, undefined)).toBeUndefined()
  })

  it('returns undefined for non-terminal contents and terminals without a terminalId', () => {
    expect(liveTerminalRowIdentity(freshAgentContent(), registryTerminal())).toBeUndefined()
    expect(liveTerminalRowIdentity(freshAgentContent(), undefined)).toBeUndefined()
    expect(liveTerminalRowIdentity(terminalContent('opencode'), registryTerminal())).toBeUndefined()
    expect(liveTerminalRowIdentity(terminalContent('opencode'), undefined)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

```bash
npm run test:vitest -- run test/unit/client/lib/session-utils.test.ts -t 'liveTerminalRowIdentity'
```

FAIL because `@/lib/session-utils` does not export `liveTerminalRowIdentity` — the import resolves to `undefined` and the first call throws (`liveTerminalRowIdentity is not a function`), i.e. no key resolution exists.

- [ ] **Step 3: Add the minimal production implementation**

In src/lib/session-utils.ts, change line 9 to:

```ts
import type { BackgroundTerminal, CodingCliProviderName } from '@/store/types'
```

Insert immediately after `collectSessionRefsFromTabs` (after line 305, before `getActiveSessionRefForTab`):

```ts
export interface LiveTerminalRowIdentity {
  provider: CodingCliProviderName
  /** activity/sessionActivity bucket key the sidebar row reads */
  key: string
}

/**
 * Activity key of the sidebar row a closing tab's leaf content corresponds
 * to, for contents whose own canonical identity (extractSessionLocators) is
 * empty — those contents are already ratcheted by the canonical refs loop in
 * closeTab, so this returns undefined for them (never a second key).
 *
 * For the rest, the registry terminal (resolved by the caller via the
 * content's terminalId) decides, in priority order:
 *
 * 1. registry sessionRef → the canonical `<provider>:<sessionId>` row key
 *    (the identity-less alias would be junk: no row ever reads it);
 * 2. registry codex durability → the canonical `codex:<durabilitySessionId>`
 *    row key (mirrors getCodexDurabilitySessionId in sidebarSelectors.ts);
 * 3. running, identity-less, non-shell registry terminal → the live-terminal
 *    fallback row key `<mode>:terminal:<terminalId>` (the `for (const
 *    terminal of terminals)` loop in store/selectors/sidebarSelectors.ts —
 *    the predicate MUST stay in sync with that loop's guard and with
 *    resolveTerminalFallbackRowKey in lib/pane-activity.ts);
 * 4. NO registry entry at all (directory not yet loaded, failed, stale, or
 *    paged out) → the content's own `<mode>:terminal:<terminalId>` key, so
 *    the still-running terminal's fallback row sorts fresh once it appears.
 *
 * Returns undefined when no sidebar row can result: non-terminal content,
 * no terminalId, or a registry terminal that exists but is not running and
 * carries no canonical identity (its live row is gone).
 */
export function liveTerminalRowIdentity(
  content: PaneContent,
  terminal: Pick<BackgroundTerminal, 'terminalId' | 'status' | 'mode' | 'sessionRef' | 'codexDurability'> | undefined,
): LiveTerminalRowIdentity | undefined {
  if (content.kind !== 'terminal' || !content.terminalId) return undefined
  if (extractSessionLocators(content).length > 0) return undefined

  if (terminal) {
    const sessionRef = sanitizeSessionLocator(terminal.sessionRef)
    if (sessionRef) {
      return { provider: sessionRef.provider, key: `${sessionRef.provider}:${sessionRef.sessionId}` }
    }
    const durabilitySessionId = terminal.mode === 'codex'
      ? terminal.codexDurability?.durableThreadId
        ?? terminal.codexDurability?.candidate?.candidateThreadId
      : undefined
    if (durabilitySessionId) {
      return { provider: 'codex', key: `codex:${durabilitySessionId}` }
    }
    if (terminal.status !== 'running') return undefined
    if (!isNonShellMode(terminal.mode)) return undefined
    const provider = terminal.mode as CodingCliProviderName
    return { provider, key: `${provider}:terminal:${terminal.terminalId}` }
  }

  if (!isNonShellMode(content.mode)) return undefined
  const provider = content.mode as CodingCliProviderName
  return { provider, key: `${provider}:terminal:${content.terminalId}` }
}
```

- [ ] **Step 4: Run the focused test**

```bash
npm run test:vitest -- run test/unit/client/lib/session-utils.test.ts
```

Expected: PASS — the new describe plus every pre-existing describe in the file.

- [ ] **Step 5: Refactor while green** — No-op by design: a single pure function with no branching duplication worth extracting; it mirrors the priority ladder the doc comment documents.

- [ ] **Step 6: Run impacted-test verification** — the sibling suites that import this module:

```bash
npm run test:vitest -- run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sessionStatusTiers.test.ts
```

Expected: PASS. `sidebarSelectors`/`sessionStatusTiers` consume `collectSessionRefsFromTabs` from this module; the addition is purely additive (one new export).

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/session-utils.ts test/unit/client/lib/session-utils.test.ts && git commit -m "feat(client): add liveTerminalRowIdentity for close-tab ratchet key resolution"
```

### Task 2: Close-time activity ratchet in the evidence-gated `closeTab` thunk

**Files:**
- Modify: src/store/tabsSlice.ts:7 (extend the session-utils import), :22 (extend the pane-utils import), imports block (add `updateSessionActivity`, grouped with the store imports after the line-5 turnCompletion import), :800-802 (insert the ratchet between the reopen-stack block and the `// The frozen set is authoritative (F3):` comment)
- Test: test/unit/client/store/tabsSlice.test.ts (extend the line-14 panes import with `splitPane`; add sessionActivity/terminalDirectory reducer imports and the `BackgroundTerminal` type import; extend the hoisted ws-mock with a fail switch and reset it in the `beforeEach` at :85-91; new `describe('closeTab session activity ratchet')` after the `closeTab with multiple panes` block ending at :630)
- Test: test/unit/client/components/Sidebar.test.tsx (upgrade the ws mock at :44-57 to answer close acks; extend the line-8 tabs import with `closeTab`; new `it` inside `describe('activity sort mode')` after the test ending at :1249)
- Test: test/integration/activity-sort.test.tsx (ws mock + reducer imports; `resetSessionActivityFlushListenersForTests()` in `beforeEach`; new `it` after the existing test)

**Interfaces:**
- Consumes: `liveTerminalRowIdentity` (Task 1), `collectSessionRefsFromTabs(tabs, panes): SessionRef[]` (src/lib/session-utils.ts:294), `collectPaneContents(node): PaneContent[]` (src/lib/pane-utils.ts:89), `updateSessionActivity({ sessionId, provider?, lastInputAt })` ratchet-only (src/store/sessionActivitySlice.ts:81-96), the `closeTab` thunk's frozen snapshot (`stateAtClose`, `frozenTab`, `frozenLayout`, tabsSlice.ts:733-741), `VALID_CLAUDE_SESSION_ID` (tabsSlice.test.ts:19), `hydrateTabs` (already imported in tabsSlice.test.ts:8), `createTestStore`/`renderSidebar`/`sessionId` (Sidebar.test.tsx:107-320), `SESSION_ACTIVITY_STORAGE_KEY` / `sessionActivityPersistMiddleware` / `SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS` / `resetSessionActivityFlushListenersForTests` (src/store/sessionActivitySlice.ts:4, src/store/sessionActivityPersistence.ts:4/:51/:59).
- Produces: no new exported names; behavior: every successful `closeTab` dispatch ratchets `sessionActivity.sessions` to `Date.now()` for (i) each canonical session ref of the closing tab and (ii) each `liveTerminalRowIdentity`-resolved key of the closing tab's terminal leaf contents.

- [ ] **Step 1: Write the failing behavioral test**

In test/unit/client/store/tabsSlice.test.ts — first extend the imports:

- line 14 → `import panesReducer, { initLayout, splitPane } from '../../../../src/store/panesSlice'`
- add after line 16:
```ts
import sessionActivityReducer from '../../../../src/store/sessionActivitySlice'
import terminalDirectoryReducer from '../../../../src/store/terminalDirectorySlice'
```
- line 17 → `import type { BackgroundTerminal, Tab } from '../../../../src/store/types'`

Then extend the hoisted mock block (lines 41-43) to carry a fail switch:

```ts
const { paneCloseAckHandlers, paneCloseAckMode } = vi.hoisted(() => ({
  paneCloseAckHandlers: new Set<(msg: unknown) => void>(),
  paneCloseAckMode: { fail: false },
}))
```

and inside the `vi.mock('@/lib/ws-client', ...)` factory (lines 49-75), change the `panes.closed` answer to `success: !paneCloseAckMode.fail`. Add `paneCloseAckMode.fail = false` to the outer `beforeEach` (lines 85-91).

Then append after the `closeTab with multiple panes` describe (ends line 630):

```ts
  describe('closeTab session activity ratchet', () => {
    const SECOND_CLAUDE_ID = '550e8400-e29b-41d4-a716-446655440001'

    function createRatchetStore(
      sessions: Record<string, number> = {},
      terminals: BackgroundTerminal[] = [],
    ) {
      return configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          sessionActivity: sessionActivityReducer,
          terminalDirectory: terminalDirectoryReducer,
        },
        preloadedState: {
          sessionActivity: { sessions },
          terminalDirectory: {
            windows: { sidebar: { items: terminals, nextCursor: null } },
            searches: {},
          },
        },
      })
    }

    function claudeRefContent(sessionId: string) {
      return {
        kind: 'terminal' as const,
        mode: 'claude' as const,
        resumeSessionId: sessionId,
        sessionRef: { provider: 'claude', sessionId },
      }
    }

    it('ratchets activity for every session ref of the closing tab', async () => {
      const store = createRatchetStore()
      store.dispatch(addTab({ mode: 'claude' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({ tabId, content: claudeRefContent(VALID_CLAUDE_SESSION_ID) }))
      const leafId = (store.getState().panes.layouts[tabId] as any).id
      store.dispatch(splitPane({
        tabId,
        paneId: leafId,
        direction: 'horizontal',
        newContent: claudeRefContent(SECOND_CLAUDE_ID),
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab(tabId))

      const sessions = store.getState().sessionActivity.sessions
      expect(sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]).toBeGreaterThanOrEqual(beforeClose)
      expect(sessions[`claude:${SECOND_CLAUDE_ID}`]).toBeGreaterThanOrEqual(beforeClose)
    })

    it('records no activity when closing a sessionless shell tab', async () => {
      const store = createRatchetStore()
      store.dispatch(addTab({ mode: 'shell' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))

      await store.dispatch(closeTab(tabId))

      expect(store.getState().sessionActivity.sessions).toEqual({})
    })

    it('never downgrades a newer existing ratchet value', async () => {
      const future = Date.now() + 60_000
      const store = createRatchetStore({ [`claude:${VALID_CLAUDE_SESSION_ID}`]: future })
      store.dispatch(addTab({ mode: 'claude' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: {
          kind: 'terminal',
          mode: 'claude',
          resumeSessionId: VALID_CLAUDE_SESSION_ID,
        },
      }))

      await store.dispatch(closeTab(tabId))

      expect(store.getState().sessionActivity.sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]).toBe(future)
    })

    it('ratchets layout-less tabs via tab-level fallback identity', async () => {
      const store = createRatchetStore()
      store.dispatch(hydrateTabs({
        tabs: [{
          id: 'layout-less',
          createRequestId: 'layout-less',
          title: 'Layout-less',
          status: 'running',
          mode: 'claude',
          resumeSessionId: VALID_CLAUDE_SESSION_ID,
          createdAt: 1,
        } as any],
        activeTabId: 'layout-less',
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab('layout-less'))

      expect(store.getState().sessionActivity.sessions[`claude:${VALID_CLAUDE_SESSION_ID}`])
        .toBeGreaterThanOrEqual(beforeClose)
    })

    it('ratchets the fallback row key of every running identity-less registry terminal in the layout', async () => {
      // Running agent terminals without sessionRef surface in the sidebar as
      // fallback rows keyed `<mode>:terminal:<terminalId>`; the row persists
      // after tab close because the terminal keeps running.
      const store = createRatchetStore({}, [
        {
          terminalId: 'term-op-1',
          title: 'OpenCode one',
          createdAt: 1,
          lastActivityAt: 1,
          status: 'running',
          hasClients: true,
          mode: 'opencode',
        },
        {
          terminalId: 'term-op-2',
          title: 'OpenCode two',
          createdAt: 1,
          lastActivityAt: 1,
          status: 'running',
          hasClients: true,
          mode: 'opencode',
        },
      ])
      store.dispatch(addTab({ mode: 'opencode' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'opencode', terminalId: 'term-op-1' },
      }))
      const leafId = (store.getState().panes.layouts[tabId] as any).id
      store.dispatch(splitPane({
        tabId,
        paneId: leafId,
        direction: 'horizontal',
        newContent: { kind: 'terminal', mode: 'opencode', terminalId: 'term-op-2' },
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab(tabId))

      const sessions = store.getState().sessionActivity.sessions
      expect(sessions['opencode:terminal:term-op-1']).toBeGreaterThanOrEqual(beforeClose)
      expect(sessions['opencode:terminal:term-op-2']).toBeGreaterThanOrEqual(beforeClose)
    })

    it('skips the terminal key when a codex registry terminal has durability identity', async () => {
      // That row is keyed codex:<durabilitySessionId> and is already ratcheted
      // by the canonical refs loop (pane-content codex durability locator).
      const codexDurability = { schemaVersion: 1, state: 'durable', durableThreadId: 'durable-cx-1' } as const
      const store = createRatchetStore({}, [{
        terminalId: 'term-cx-1',
        title: 'Codex pane',
        createdAt: 1,
        lastActivityAt: 1,
        status: 'running',
        hasClients: true,
        mode: 'codex',
        codexDurability,
      }])
      store.dispatch(addTab({ mode: 'codex' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'codex', terminalId: 'term-cx-1', codexDurability },
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab(tabId))

      const sessions = store.getState().sessionActivity.sessions
      expect(sessions['codex:durable-cx-1']).toBeGreaterThanOrEqual(beforeClose)
      expect(sessions['codex:terminal:term-cx-1']).toBeUndefined()
    })

    it('ratchets the registry canonical key when the sessionRef exists only in the registry', async () => {
      // Canonical identity lives in the registry, not the pane content: the
      // content yields no locator, so the canonical loop ratchets nothing.
      // The sidebar rows this terminal under claude:<sessionId>; the ratchet
      // must target that canonical key, not a terminal alias (which would be
      // junk — no row ever reads it).
      const store = createRatchetStore({}, [{
        terminalId: 'term-ref-1',
        title: 'Claude pane',
        createdAt: 1,
        lastActivityAt: 1,
        status: 'running',
        hasClients: true,
        mode: 'claude',
        sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      }])
      store.dispatch(addTab({ mode: 'claude' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'claude', terminalId: 'term-ref-1' },
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab(tabId))

      const sessions = store.getState().sessionActivity.sessions
      expect(sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]).toBeGreaterThanOrEqual(beforeClose)
      expect(sessions['claude:terminal:term-ref-1']).toBeUndefined()
    })

    it('ratchets the registry codex canonical key when durability identity exists only in the registry', async () => {
      // Same registry-only-identity gap as the sessionRef case: the content
      // carries no codexDurability, so the canonical loop yields nothing, but
      // the sidebar rows the terminal under codex:<durabilitySessionId>.
      const store = createRatchetStore({}, [{
        terminalId: 'term-cx-2',
        title: 'Codex pane',
        createdAt: 1,
        lastActivityAt: 1,
        status: 'running',
        hasClients: true,
        mode: 'codex',
        codexDurability: { schemaVersion: 1, state: 'durable', durableThreadId: 'durable-cx-2' } as const,
      }])
      store.dispatch(addTab({ mode: 'codex' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'codex', terminalId: 'term-cx-2' },
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab(tabId))

      const sessions = store.getState().sessionActivity.sessions
      expect(sessions['codex:durable-cx-2']).toBeGreaterThanOrEqual(beforeClose)
      expect(sessions['codex:terminal:term-cx-2']).toBeUndefined()
    })

    it('falls back to the pane-mode terminal key when the registry entry is missing', async () => {
      // terminalDirectory.windows.sidebar.items loads asynchronously, can
      // fail or be stale, and is capped: closing before the entry arrives
      // must still ratchet the key the still-running terminal's fallback row
      // will read once it registers.
      const store = createRatchetStore()
      store.dispatch(addTab({ mode: 'opencode' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'opencode', terminalId: 'term-miss-1' },
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab(tabId))

      expect(store.getState().sessionActivity.sessions['opencode:terminal:term-miss-1'])
        .toBeGreaterThanOrEqual(beforeClose)
    })

    it('ratchets nothing when the close evidence fails (the tab stays)', async () => {
      paneCloseAckMode.fail = true
      const store = createRatchetStore()
      store.dispatch(addTab({ mode: 'claude' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({ tabId, content: claudeRefContent(VALID_CLAUDE_SESSION_ID) }))

      await store.dispatch(closeTab(tabId))

      expect(store.getState().tabs.tabs).toHaveLength(1)
      expect(store.getState().sessionActivity.sessions).toEqual({})
    })
  })
```

In test/unit/client/components/Sidebar.test.tsx — first upgrade the ws mock (lines 44-57) so the evidence-gated `closeTab` can complete in component tests (no existing test sends a close message — verified — so the added answers are inert elsewhere):

```ts
// Mock the WebSocket client
const mockSend = vi.fn()
const wsMessageHandlers = new Set<(msg: unknown) => void>()
const mockOnMessage = vi.fn((handler: (msg: unknown) => void) => {
  wsMessageHandlers.add(handler)
  return () => {
    wsMessageHandlers.delete(handler)
  }
})
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockFetchSidebarSessionsSnapshot = vi.fn()
const mockGetTerminalDirectoryPage = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    // Answer the evidence-gated close thunks' acknowledgements inline (the
    // healthy-server shape, mirroring tabsSlice.test.ts) so component tests
    // can dispatch the REAL closeTab and watch the close complete.
    send: (msg: unknown) => {
      mockSend(msg)
      const m = msg as { type?: string; requestId?: string; createRequestId?: string }
      if (m?.type === 'panes.closed' && m.requestId) {
        for (const handler of [...wsMessageHandlers]) {
          handler({ type: 'panes.closed.result', requestId: m.requestId, success: true })
        }
      }
      if (m?.type === 'pane.closed' && m.createRequestId) {
        for (const handler of [...wsMessageHandlers]) {
          handler({ type: 'pane.closed.result', createRequestId: m.createRequestId, success: true })
        }
      }
    },
    onMessage: mockOnMessage,
    connect: mockConnect,
  }),
}))
```

(All names stay identical; only `mockOnMessage` gains a real registration implementation and `send` gains the inline ack answers on top of recording into `mockSend`.) Extend line 8 to `import tabsReducer, { closeTab } from '@/store/tabsSlice'`, then append inside `describe('activity sort mode')` (after the test ending at line 1249):

```tsx
    it('floats a just-closed session to the top of the grey section', async () => {
      const now = Date.now()
      const closerSid = sessionId('closing-float')
      const greyNewerSid = sessionId('grey-newer')
      const greyOlderSid = sessionId('grey-older')
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: closerSid,
              projectPath: '/home/user/project',
              lastActivityAt: now - 7200000,
              title: 'Closing session',
              cwd: '/home/user/project',
            },
            {
              sessionId: greyNewerSid,
              projectPath: '/home/user/project',
              lastActivityAt: now - 1000,
              title: 'Grey newer session',
              cwd: '/home/user/project',
            },
            {
              sessionId: greyOlderSid,
              projectPath: '/home/user/project',
              lastActivityAt: now - 5000,
              title: 'Grey older session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [{
        id: 'tab-closing',
        resumeSessionId: closerSid,
        sessionRef: { provider: 'claude', sessionId: closerSid },
        mode: 'claude',
      }]
      const store = createTestStore({ projects, tabs, sortMode: 'activity' })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const buttons = () => screen.getAllByRole('button').filter(
        // endsWith would never match: every session row button's textContent
        // ends with the appended relative-timestamp span (Sidebar.tsx), so
        // match with `includes`, exactly like the neighboring ratchet tests.
        (btn) => btn.textContent?.includes('session')
      )

      // Pinned (local-open tier) first while its tab is open, then grey newest-first.
      expect(buttons()[0]).toHaveTextContent('Closing session')
      expect(buttons()[1]).toHaveTextContent('Grey newer session')
      expect(buttons()[2]).toHaveTextContent('Grey older session')

      const beforeClose = Date.now()
      await act(async () => {
        await store.dispatch(closeTab('tab-closing') as any)
        vi.advanceTimersByTime(100)
      })

      // The close ratcheted the session's activity timestamp...
      expect(store.getState().sessionActivity.sessions[`claude:${closerSid}`])
        .toBeGreaterThanOrEqual(beforeClose)
      // ...so the stale session — grey order [newer, older, closer] without it —
      // lands on top of the grey section instead of sinking below both.
      expect(buttons()).toHaveLength(3)
      expect(buttons()[0]).toHaveTextContent('Closing session')
      expect(buttons()[0]).toHaveAttribute('data-has-tab', 'false')
      expect(buttons()[1]).toHaveTextContent('Grey newer session')
      expect(buttons()[2]).toHaveTextContent('Grey older session')
    })
```

In test/integration/activity-sort.test.tsx — extend the imports and mock at the top:

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import settingsReducer from '@/store/settingsSlice'
import sessionActivityReducer, { SESSION_ACTIVITY_STORAGE_KEY } from '@/store/sessionActivitySlice'
import tabsReducer, { addTab, closeTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import {
  sessionActivityPersistMiddleware,
  SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS,
  resetSessionActivityFlushListenersForTests,
} from '@/store/sessionActivityPersistence'

const paneCloseAckHandlers = new Set<(msg: unknown) => void>()

// The evidence-gated closeTab awaits a `panes.closed.result` ack — answer it
// inline (the healthy-server shape, mirroring tabsSlice.test.ts) so the
// integration can dispatch the REAL thunk. Inert for the localStorage
// round-trip test above, which sends nothing.
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: (msg: unknown) => {
      const m = msg as { type?: string; requestId?: string }
      if (m?.type === 'panes.closed' && m.requestId) {
        for (const handler of [...paneCloseAckHandlers]) {
          handler({ type: 'panes.closed.result', requestId: m.requestId, success: true })
        }
      }
    },
    onMessage: (handler: (msg: unknown) => void) => {
      paneCloseAckHandlers.add(handler)
      return () => paneCloseAckHandlers.delete(handler)
    },
    resetWsClientForTests: vi.fn(),
  }),
}))
```

Add `resetSessionActivityFlushListenersForTests()` inside the `beforeEach` after `localStorage.clear()`, then append inside the describe:

```tsx
  it('persists the close-tab activity ratchet to localStorage after the debounce', async () => {
    const claudeSessionId = '550e8400-e29b-41d4-a716-446655440000'
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessionActivity: sessionActivityReducer,
      },
      middleware: (getDefault) => getDefault().concat(sessionActivityPersistMiddleware),
    })

    store.dispatch(addTab({ mode: 'claude' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId,
      content: {
        kind: 'terminal',
        mode: 'claude',
        resumeSessionId: claudeSessionId,
        sessionRef: { provider: 'claude', sessionId: claudeSessionId },
      },
    }))

    const beforeClose = Date.now()
    await store.dispatch(closeTab(tabId))

    expect(store.getState().sessionActivity.sessions[`claude:${claudeSessionId}`])
      .toBeGreaterThanOrEqual(beforeClose)
    expect(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS)

    const persisted = JSON.parse(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY) || '{}')
    expect(persisted[`claude:${claudeSessionId}`]).toBeGreaterThanOrEqual(beforeClose)
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

```bash
npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts -t 'closeTab session activity ratchet'
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx -t 'floats a just-closed session'
npm run test:vitest -- run test/integration/activity-sort.test.tsx
```

FAIL because `closeTab` never dispatches `updateSessionActivity`: the ratchet assertions read `undefined` (`expected undefined to be >= <timestamp>`), the Sidebar float test's closed session sinks to `['Grey newer session', 'Grey older session', 'Closing session']` instead of the closed row leading the grey section, and the integration test's `sessions[...]` is `undefined`. Three tests are expected GREEN at red — they are gating tests asserting boundaries the step-3 code could wrongly change, and they fail on such a mis-implementation: 'records no activity when closing a sessionless shell tab' (fails if the ratchet keys shell content), 'never downgrades a newer existing ratchet value' (fails if the loop bypasses the ratchet-only reducer), and 'ratchets nothing when the close evidence fails' (fails if the ratchet is placed before the evidence gate). Likewise the `toBeUndefined()` no-alias assertions inside otherwise-red tests pass at red and guard against junk-key writes.

- [ ] **Step 3: Add the minimal production implementation**

In src/store/tabsSlice.ts:

1. Line 7 → `import { findTabIdForSession, collectSessionRefsFromTabs, liveTerminalRowIdentity } from '@/lib/session-utils'`
2. Line 22 → `import { collectSessionPaneIdentities, collectPaneContents, findPaneContent } from '@/lib/pane-utils'`
3. Add after the line-5 turnCompletion import: `import { updateSessionActivity } from './sessionActivitySlice'`
4. Insert between the reopen-stack block (ends line 800) and the `// The frozen set is authoritative (F3):` comment (line 802):

```ts
      // Closing a tab counts as a user touch on its sessions: ratchet each
      // one's locally-stored activity timestamp at close-commit time so the
      // just-closed session floats to the top of the grey section under the
      // default 'activity' sort (the grey tier consumes the ratchet with
      // presence-priority — compareByStatusTiers in
      // selectors/sidebarSelectors.ts). Two loops over the frozen pre-close
      // snapshot, both ratchet-only (updateSessionActivity never lowers a
      // stored value):
      //
      // 1. Canonical session refs — collectSessionRefsFromTabs covers both
      //    layout leaves and layout-less tabs (buildTabFallbackLocator).
      // 2. Leaf contents whose own locators are empty but still correspond
      //    to sidebar rows: registry-only canonical identity (sessionRef /
      //    codex durability known only to the terminal directory),
      //    identity-less live-terminal fallback rows keyed
      //    `<mode>:terminal:<terminalId>`, and terminals whose directory
      //    entry hasn't loaded yet — liveTerminalRowIdentity resolves the
      //    right key (or none) per content.
      //
      // Unconditional by design: REST/MCP/server-broadcast closes flow
      // through this same thunk on every connected client (ui-commands.ts
      // tab.close → closeTab), so a mirrored close ratchets too —
      // harmless-to-useful under ratchet-only semantics. The app-level
      // grey-transition touch watcher (store/sessionGreyTouch.ts) also
      // touches tier-visible keys at close; the overlap is equally harmless.
      if (frozenTab) {
        const touchedAt = Date.now()
        for (const ref of collectSessionRefsFromTabs([frozenTab], stateAtClose.panes)) {
          dispatch(updateSessionActivity({
            sessionId: ref.sessionId,
            provider: ref.provider,
            lastInputAt: touchedAt,
          }))
        }
        if (frozenLayout) {
          const directoryItems = (stateAtClose as {
            terminalDirectory?: RootState['terminalDirectory']
          }).terminalDirectory?.windows?.sidebar?.items
          for (const content of collectPaneContents(frozenLayout)) {
            const identity = liveTerminalRowIdentity(
              content,
              content.kind === 'terminal' && content.terminalId
                ? directoryItems?.find((item) => item.terminalId === content.terminalId)
                : undefined,
            )
            if (!identity) continue
            // identity.key is pre-composed and contains colons, so
            // makeSessionKey passes it through unchanged (provider is kept
            // for dispatch parity with the canonical loop above, not for
            // key construction).
            dispatch(updateSessionActivity({
              sessionId: identity.key,
              provider: identity.provider,
              lastInputAt: touchedAt,
            }))
          }
        }
      }
```

(The guarded cross-slice cast mirrors the tabRegistry read at tabsSlice.ts:766 and keeps partial test stores honest; the insert sits after the ack so a failed close evidence path — which returns at :757 — never ratchets.)

- [ ] **Step 4: Run the focused test**

```bash
npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts test/unit/client/components/Sidebar.test.tsx test/integration/activity-sort.test.tsx
```

Expected: PASS — all new tests plus every pre-existing close-tab, sort, render, and persistence test in the three files.

- [ ] **Step 5: Refactor while green** — No-op by design: the insertion is two guarded loops reusing the existing pure extractor (Task 1), the existing ratchet-only action, and the existing persistence middleware; the slice already handles monotonicity, pruning, and debounced persistence, and no helper extraction is warranted for code this size.

- [ ] **Step 6: Run impacted-test verification** — every suite that dispatches or pins `closeTab` / `removeTab` / session-activity behavior, plus the watcher and Sidebar pipelines:

```bash
npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsSlice.closed-registry.test.ts test/unit/client/store/tabsSlice.reopen.test.ts test/unit/client/store/persistTabsEmptyGuard.test.ts test/unit/client/store/sessionActivitySlice.test.ts test/unit/client/store/sessionActivityPersistence.test.ts test/unit/client/store/sessionGreyTouch.test.ts test/unit/client/components/Sidebar.test.tsx test/integration/activity-sort.test.tsx
```

Expected: PASS. Stores in adjacency suites without a `sessionActivity` reducer silently ignore the added dispatches; attention-clearing, closed-snapshot, reopen-stack, and tombstone assertions are behaviorally untouched; the watcher suite pins the parallel grey-transition mechanism this ratchet composes with.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/tabsSlice.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/components/Sidebar.test.tsx test/integration/activity-sort.test.tsx && git commit -m "feat(client): ratchet session activity when a tab closes"
```

### Task 3: Alias→canonical and canonical→canonical activity folds at the association reconcile point

**Files:**
- Modify: src/lib/terminal-session-association.ts:1-13 (add the `updateSessionActivity` import; widen `SessionAssociationState` to pick `sessionActivity`), insert `foldSessionActivityFromKey` / `foldTerminalAliasActivity` / `foldCanonicalSessionActivity` before `collectMatchingTerminalPanes` (line 15), insert the two fold call sites between the conflict gate (line 114) and the orphan return (line 115)
- Test: test/unit/client/lib/terminal-session-association.test.ts (extend imports; append two new describes at end of file)

**Interfaces:**
- Consumes: `updateSessionActivity({ sessionId, provider?, lastInputAt })` (src/store/sessionActivitySlice.ts:81-96), `reconcileTerminalSessionAssociation`'s existing shape ({ dispatch, getState, terminalId, sessionRef, previousSessionId }) and return statuses, the file's `createState(content, tabOverrides)` test harness (:7-27).
- Produces:
  - `export function foldTerminalAliasActivity({ dispatch, state, terminalId, provider, sessionId }): void` — copies the timestamp stored under `<provider>:terminal:<terminalId>` onto the canonical `<provider>:<sessionId>` key, ratchet-only (Task 4 consumes).
  - `export function foldCanonicalSessionActivity({ dispatch, state, provider, previousSessionId, sessionId }): void` — same, from `<provider>:<previousSessionId>`; no-op when `previousSessionId` is empty or equals `sessionId` (Task 4 consumes).

- [ ] **Step 1: Write the failing behavioral test**

In test/unit/client/lib/terminal-session-association.test.ts, extend the imports (line 2 stays; add after line 5):

```ts
import sessionActivityReducer, { updateSessionActivity } from '@/store/sessionActivitySlice'
```

Append at the end of the file:

```ts
describe('alias activity fold on later identity binding', () => {
  // An identity-less terminal touched by the close-tab ratchet is recorded
  // under `<provider>:terminal:<terminalId>` (liveTerminalRowIdentity's
  // identity-less live-terminal row key). When the still-running terminal
  // later acquires canonical identity, the sidebar rekeys the row to
  // `<provider>:<sessionId>` and reads activity only from there, so the
  // alias timestamp must be folded across at the binding point.

  const ALIAS_KEY = 'claude:terminal:t-1'
  const CANONICAL_KEY = 'claude:s-1'

  function identityLessClaudePane(terminalId = 't-1') {
    return {
      kind: 'terminal',
      terminalId,
      createRequestId: 'req-1',
      status: 'running',
      mode: 'claude',
      shell: 'system',
    }
  }

  function createFoldHarness(
    sessions: Record<string, number>,
    content: Record<string, unknown> = identityLessClaudePane(),
  ) {
    const state = createState(content) as any
    state.sessionActivity = { sessions: { ...sessions } }
    const dispatch = vi.fn((action: any) => {
      if (action?.type === updateSessionActivity.type) {
        state.sessionActivity = sessionActivityReducer(state.sessionActivity, action)
      }
    })
    return { state, dispatch, getState: () => state }
  }

  function bindClaudeSession(harness: ReturnType<typeof createFoldHarness>) {
    return reconcileTerminalSessionAssociation({
      dispatch: harness.dispatch,
      getState: harness.getState,
      terminalId: 't-1',
      sessionRef: { provider: 'claude', sessionId: 's-1' },
    })
  }

  it('migrates the close-tab alias timestamp into the canonical key when identity binds', () => {
    const harness = createFoldHarness({ [ALIAS_KEY]: 1111 })
    const result = bindClaudeSession(harness)
    expect(result).toBe('reconciled')
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBe(1111)
  })

  it('still folds the alias when the closed tab left no pane to match (the actual orphan)', () => {
    // The close happened earlier: the tab is gone, so no pane matches the
    // terminal and the reconciliation itself is 'ignored'. The fold must not
    // depend on a pane match -- this IS the orphan scenario.
    const harness = createFoldHarness({ [ALIAS_KEY]: 1111 }, identityLessClaudePane('t-other'))
    const result = bindClaudeSession(harness)
    expect(result).toBe('ignored')
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBe(1111)
  })

  it('never lowers an already-newer canonical timestamp (ratchet non-regression)', () => {
    const harness = createFoldHarness({ [ALIAS_KEY]: 1111, [CANONICAL_KEY]: 9999 })
    bindClaudeSession(harness)
    // The fold is attempted with the alias timestamp...
    expect(harness.dispatch).toHaveBeenCalledWith(
      updateSessionActivity({ sessionId: 's-1', provider: 'claude', lastInputAt: 1111 }),
    )
    // ...and the real reducer keeps the max.
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBe(9999)
  })

  it('writes nothing to the canonical key when no alias activity exists', () => {
    const harness = createFoldHarness({})
    bindClaudeSession(harness)
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: updateSessionActivity.type }),
    )
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBeUndefined()
  })

  it('does not fold onto a session the association itself rejects (conflict)', () => {
    // A stale/rejected association frame must not stamp alias activity onto
    // the session it declines to bind: folding happens only when the
    // association is accepted or harmlessly stale, never on the conflict
    // path. (The pane below is already bound to a different claude session,
    // so the s-1 frame is a conflict.)
    const harness = createFoldHarness({ [ALIAS_KEY]: 1111 }, {
      ...identityLessClaudePane(),
      sessionRef: { provider: 'claude', sessionId: 's-bound' },
    })
    const result = bindClaudeSession(harness)
    expect(result).toBe('conflict')
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: updateSessionActivity.type }),
    )
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBeUndefined()
  })
})

describe('canonical activity fold on accepted rebind (previousSessionId)', () => {
  // Codex fork-handoff scenario: the tab was closed while the pane carried
  // the PARENT identity, so the close-tab ratchet wrote the parent canonical
  // key `codex:parent-1` (no terminal alias — liveTerminalRowIdentity yields
  // none for identity-bearing content). When the detached terminal later
  // commits the CHILD session and broadcasts previousSessionId, the sidebar
  // rekeys the row to the child, so the parent key's timestamp must be folded
  // across with the same ratchet-only mechanism as the terminal alias.

  function codexPane(terminalId: string, sessionId: string) {
    return {
      kind: 'terminal',
      terminalId,
      createRequestId: 'req-1',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      sessionRef: { provider: 'codex', sessionId },
    }
  }

  function createRebindHarness(
    sessions: Record<string, number>,
    content: Record<string, unknown>,
  ) {
    const state = createState(content) as any
    state.sessionActivity = { sessions: { ...sessions } }
    const dispatch = vi.fn((action: any) => {
      if (action?.type === updateSessionActivity.type) {
        state.sessionActivity = sessionActivityReducer(state.sessionActivity, action)
      }
    })
    return { state, dispatch, getState: () => state }
  }

  function broadcastForkRebind(harness: ReturnType<typeof createRebindHarness>) {
    return reconcileTerminalSessionAssociation({
      dispatch: harness.dispatch,
      getState: harness.getState,
      terminalId: 't-1',
      sessionRef: { provider: 'codex', sessionId: 'child-1' },
      previousSessionId: 'parent-1',
    })
  }

  it('folds the parent canonical timestamp onto the child when a live pane accepts the rebind', () => {
    const harness = createRebindHarness({ 'codex:parent-1': 1111 }, codexPane('t-1', 'parent-1'))
    const result = broadcastForkRebind(harness)
    expect(result).toBe('reconciled')
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBe(1111)
  })

  it('still folds the parent timestamp when the tab closed before the rebind broadcast (orphan)', () => {
    // THE finding scenario: the close happened while the pane carried the
    // parent identity (parent key ratcheted, no terminal alias written) and
    // the pane is gone now; the detached terminal's rebind broadcast must
    // still fold, so the fold must not depend on a pane match.
    const harness = createRebindHarness({ 'codex:parent-1': 1111 }, codexPane('t-other', 'parent-1'))
    const result = broadcastForkRebind(harness)
    expect(result).toBe('ignored')
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBe(1111)
  })

  it('never lowers an already-newer child timestamp (ratchet non-regression)', () => {
    const harness = createRebindHarness(
      { 'codex:parent-1': 1111, 'codex:child-1': 9999 },
      codexPane('t-1', 'parent-1'),
    )
    broadcastForkRebind(harness)
    // The fold is attempted with the parent timestamp...
    expect(harness.dispatch).toHaveBeenCalledWith(
      updateSessionActivity({ sessionId: 'child-1', provider: 'codex', lastInputAt: 1111 }),
    )
    // ...and the real reducer keeps the max.
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBe(9999)
  })

  it('writes nothing when the parent key holds no activity', () => {
    const harness = createRebindHarness({}, codexPane('t-1', 'parent-1'))
    broadcastForkRebind(harness)
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: updateSessionActivity.type }),
    )
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBeUndefined()
  })

  it('does not fold onto the child when the rebind itself is rejected (conflict)', () => {
    // The pane carries a third identity, so previousSessionId does not
    // authorize the swap — a rejected frame must not stamp the parent's
    // activity onto a session this client never accepted.
    const harness = createRebindHarness({ 'codex:parent-1': 1111 }, codexPane('t-1', 'some-other'))
    const result = broadcastForkRebind(harness)
    expect(result).toBe('conflict')
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: updateSessionActivity.type }),
    )
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBeUndefined()
  })

  it('does not move another session\'s activity on a plain association frame (no previousSessionId)', () => {
    // Without the supersession token nothing authorizes a canonical swap:
    // only the terminal alias may fold, never another session's key.
    const harness = createRebindHarness({ 'codex:parent-1': 1111 }, {
      kind: 'terminal',
      terminalId: 't-1',
      createRequestId: 'req-1',
      status: 'running',
      mode: 'codex',
      shell: 'system',
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch: harness.dispatch,
      getState: harness.getState,
      terminalId: 't-1',
      sessionRef: { provider: 'codex', sessionId: 'child-1' },
    })
    expect(result).toBe('reconciled')
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBeUndefined()
    expect(harness.state.sessionActivity.sessions['codex:parent-1']).toBe(1111)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

```bash
npm run test:vitest -- run test/unit/client/lib/terminal-session-association.test.ts
```

FAIL because `reconcileTerminalSessionAssociation` performs no activity folds: every `sessions[CANONICAL_KEY]` / `sessions['codex:child-1']` assertion reads `undefined` (and the fold-attempt `toHaveBeenCalledWith` assertions fail on a mock that was never called with `updateSessionActivity`). The four 'writes nothing' / conflict-rejection tests are expected GREEN at red — gating tests asserting the folds never fire on empty sources or rejected frames; they fail if the step-3 code over-folds (e.g. drops the conflict gate or folds without a source timestamp).

- [ ] **Step 3: Add the minimal production implementation**

In src/lib/terminal-session-association.ts — add after the line-2 panesSlice import:

```ts
import { updateSessionActivity } from '@/store/sessionActivitySlice'
```

Change line 13 to:

```ts
type SessionAssociationState = Pick<RootState, 'panes' | 'tabs' | 'sessionActivity'>
```

Insert before `collectMatchingTerminalPanes` (before line 15):

```ts
/**
 * Shared ratchet-only migration core: copy the activity stored under one
 * sidebar row key onto a canonical session key. updateSessionActivity is
 * ratchet-only (max wins), so folding is safe even when the canonical key
 * already holds a newer value. The source entry may remain stored — old keys
 * are pruned by the slice's existing retention.
 */
function foldSessionActivityFromKey({
  dispatch,
  state,
  fromKey,
  provider,
  sessionId,
}: {
  dispatch: Dispatch
  state: Pick<RootState, 'sessionActivity'>
  fromKey: string
  provider: string
  sessionId: string
}): void {
  const fromAt = state.sessionActivity?.sessions?.[fromKey]
  if (typeof fromAt !== 'number') return
  dispatch(updateSessionActivity({ sessionId, provider, lastInputAt: fromAt }))
}

/**
 * Migration fold for the close-tab ratchet alias: a terminal identity-less
 * at close time had its touch recorded under
 * `<provider>:terminal:<terminalId>` (liveTerminalRowIdentity in
 * lib/session-utils.ts — the sidebar's identity-less live-terminal row key).
 * When the terminal later acquires canonical identity, the sidebar rekeys
 * the row to `<provider>:<sessionId>` and reads activity only from there,
 * so the alias timestamp must be folded across at each binding point:
 * sessionRef association here, and every applied directory page in
 * fetchTerminalDirectoryWindow (store/terminalDirectoryThunks.ts) — the
 * store-level directory-apply choke point, reached by every
 * terminals.changed refresh whether or not any pane is mounted — folding
 * ANY provider's alias, not only codex durability (a binding whose
 * association frame passed before the ratchet wrote the alias has no
 * other fold opportunity).
 */
export function foldTerminalAliasActivity({
  dispatch,
  state,
  terminalId,
  provider,
  sessionId,
}: {
  dispatch: Dispatch
  state: Pick<RootState, 'sessionActivity'>
  terminalId: string
  provider: string
  sessionId: string
}): void {
  foldSessionActivityFromKey({
    dispatch,
    state,
    fromKey: `${provider}:terminal:${terminalId}`,
    provider,
    sessionId,
  })
}

/**
 * Migration fold for a canonical-to-canonical rebind (codex fork handoff):
 * a terminal closed while carrying the PARENT identity had its touch
 * recorded under `<provider>:<previousSessionId>` — liveTerminalRowIdentity
 * deliberately yields no terminal alias for identity-bearing content. When
 * the rebind is accepted and the sidebar rekeys the row to
 * `<provider>:<sessionId>`, the superseded key's timestamp must be folded
 * across the same way the terminal alias is, or the child row loses the
 * close-touch float. previousSessionId equal to sessionId folds nothing
 * (source and target would be the same key).
 */
export function foldCanonicalSessionActivity({
  dispatch,
  state,
  provider,
  previousSessionId,
  sessionId,
}: {
  dispatch: Dispatch
  state: Pick<RootState, 'sessionActivity'>
  provider: string
  previousSessionId: string
  sessionId: string
}): void {
  if (previousSessionId.length === 0 || previousSessionId === sessionId) return
  foldSessionActivityFromKey({
    dispatch,
    state,
    fromKey: `${provider}:${previousSessionId}`,
    provider,
    sessionId,
  })
}
```

Then insert between the conflict gate (`if (conflictingPane) return 'conflict'`, line 114) and the orphan return (`if (!matchedAnyPane) return 'ignored'`, line 115):

```ts
  // Close-tab activity migration runs only once the association is known NOT
  // to conflict: folding a rejected frame's alias onto the pane's canonical
  // session would stamp recent activity onto a session that never bound,
  // visibly misordering the sidebar. It must NOT depend on the pane-match
  // outcome — the orphan case is precisely a post-close association, where
  // the tab is gone and no pane is left to match.
  foldTerminalAliasActivity({
    dispatch,
    state,
    terminalId,
    provider: sessionRef.provider,
    sessionId: sessionRef.sessionId,
  })

  // Canonical-to-canonical migration on a server-authoritative rebind:
  // previousSessionId names the superseded session, whose stored activity
  // (e.g. the close-tab touch recorded under the parent key — identity-
  // bearing closes never write a terminal alias) folds onto the new key.
  // Same conflict-gate and pane-match independence rules as the alias fold.
  if (typeof previousSessionId === 'string') {
    foldCanonicalSessionActivity({
      dispatch,
      state,
      provider: sessionRef.provider,
      previousSessionId,
      sessionId: sessionRef.sessionId,
    })
  }
```

- [ ] **Step 4: Run the focused test**

```bash
npm run test:vitest -- run test/unit/client/lib/terminal-session-association.test.ts
```

Expected: PASS — the two new describes plus every pre-existing describe in the file (the folds only add dispatches; every existing 'ignored'/'reconciled'/'conflict' verdict is unchanged).

- [ ] **Step 5: Refactor while green** — No-op by design: the refactor is built into the step-3 shape (both exported folds share the `foldSessionActivityFromKey` core; the prior run's reviewed final structure is ported as-is).

- [ ] **Step 6: Run impacted-test verification** — the suites driving the association's production callers:

```bash
npm run test:vitest -- run test/unit/client/lib/terminal-session-association.test.ts test/unit/client/components/TerminalView.codex-identity.test.tsx test/unit/client/components/TerminalView.hidden-rebind.test.tsx test/unit/client/components/App.reconcile-adoption.test.tsx
```

Expected: PASS. App.tsx and TerminalView.tsx are `reconcileTerminalSessionAssociation`'s only production callers; their stores either lack a `sessionActivity` reducer (the added dispatches are no-ops) or hold no activity under the folded keys.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/terminal-session-association.ts test/unit/client/lib/terminal-session-association.test.ts && git commit -m "feat(client): fold close-touch activity across identity binds and rebinds"
```

### Task 4: Directory-level folds — all-provider alias and canonical snapshot swap on every applied page

**Files:**
- Modify: src/store/terminalDirectoryThunks.ts:1-16 (add the fold imports and the `TerminalDirectoryItem` type import), insert `directoryItemCanonicalIdentity` before the `TerminalDirectorySurface` type (line 18), insert the fold block between the abort check (line 83) and the `setTerminalDirectoryWindowData` dispatch (line 85)
- Test: test/unit/client/store/terminalDirectoryThunks.test.ts (add the sessionActivity, tabs, and panes reducer imports plus `addTab`/`closeTab`/`initLayout` and `reconcileTerminalSessionAssociation`; add a hoisted ws-client mock with a mid-wait hook beside the existing `@/lib/api` mock; append the new describes at end of file)

**Interfaces:**
- Consumes: `foldTerminalAliasActivity` / `foldCanonicalSessionActivity` (Task 3), `fetchTerminalDirectoryWindow(args: { surface, priority, append?, cursor? })` (:55), `TerminalDirectoryItem` (src/store/terminalDirectorySlice.ts:4), `getTerminalDirectoryPage` (mocked in the test file), the store's `terminalDirectory.windows[surface].items` previous-window state. The stranding scenario test additionally composes the real `closeTab` thunk (src/store/tabsSlice.ts) with `addTab`/`initLayout` (src/store/panesSlice.ts) and routes a mid-wait binding through `reconcileTerminalSessionAssociation` (src/lib/terminal-session-association.ts — the same routing App.tsx performs for `terminal.session.associated`).
- Produces: no new exported names; behavior: every applied directory page folds (i) alias→canonical for EVERY item carrying a canonical identity — sessionRef for any provider, codex durability for codex terminals, both via `directoryItemCanonicalIdentity` — whenever an alias activity entry exists under `<provider>:terminal:<terminalId>`, and (ii) canonical→canonical when the same terminalId's canonical identity changed between the previous window and the applied page — both ratchet-only (max wins). The all-provider alias fold is the heal for a binding that arrived during closeTab's ack wait: the association-reconcile fold's single opportunity passed before the close-time ratchet wrote the alias, and the once-per-binding broadcast never re-fires.

- [ ] **Step 1: Write the failing behavioral test**

In test/unit/client/store/terminalDirectoryThunks.test.ts, add after the line-3 import:

```ts
import sessionActivityReducer from '@/store/sessionActivitySlice'
import tabsReducer, { addTab, closeTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
```

Then add the hoisted ws-client mock after the existing `vi.mock('@/lib/api', ...)` block (it answers the evidence-gated `closeTab` inline, mirroring tabsSlice.test.ts:41-75, and carries the mid-wait hook the stranding scenario installs; inert for every other test in the file — nothing else here touches the ws client):

```ts
const { paneCloseAckHandlers, midWaitAssociation } = vi.hoisted(() => ({
  paneCloseAckHandlers: new Set<(msg: unknown) => void>(),
  midWaitAssociation: { onPanesClosed: null as null | (() => void) },
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: (msg: unknown) => {
      const m = msg as { type?: string; requestId?: string }
      if (m?.type === 'panes.closed' && m.requestId) {
        // The mid-ack-wait moment: after closeTab captured its frozen
        // snapshot and sent the batch close, BEFORE the ack answers —
        // exactly when App.tsx would route a terminal.session.associated
        // frame (App.tsx:1278-1296).
        midWaitAssociation.onPanesClosed?.()
        for (const handler of [...paneCloseAckHandlers]) {
          handler({ type: 'panes.closed.result', requestId: m.requestId, success: true })
        }
      }
    },
    onMessage: (handler: (msg: unknown) => void) => {
      paneCloseAckHandlers.add(handler)
      return () => {
        paneCloseAckHandlers.delete(handler)
      }
    },
  }),
  resetWsClientForTests: vi.fn(),
}))
```

Then append at the end of the file (the first describe covers all providers, with the codex durability tests as the codex-specific cases inside):

```ts
describe('directory alias fold on application (all providers)', () => {
  // A terminal closed while identity-less had its close-tab touch recorded
  // under <provider>:terminal:<terminalId> (liveTerminalRowIdentity's
  // identity-less live-terminal row key). When the still-running terminal
  // later gains canonical identity — a sessionRef for ANY provider, or codex
  // durability for codex terminals — the sidebar rekeys the row to the
  // canonical key (mirroring directoryItemCanonicalIdentity /
  // buildSessionItems' runningSessionMap in selectors/sidebarSelectors.ts),
  // so the applied page must fold the alias across. Refreshes reach the
  // thunk on every terminals.changed / terminal.meta.updated broadcast and
  // on (re)connect, regardless of whether any pane is still mounted — the
  // applied directory page is the store-level binding point. The all-provider
  // pass is also the ONLY heal for a binding that arrived during closeTab's
  // ack wait (see the mid-ack-wait stranding describe below): its
  // association-reconcile fold ran before the ratchet wrote the alias, and
  // the once-per-binding broadcast never re-fires.

  beforeEach(() => {
    getTerminalDirectoryPage.mockReset()
    _resetTerminalDirectoryThunkControllers()
  })

  const CANDIDATE = {
    provider: 'codex',
    candidateThreadId: 'cand-1',
    rolloutPath: '/tmp/rollout-cand-1.jsonl',
    source: 'thread_start_response',
    capturedAt: 1,
  } as const

  function codexItem(codexDurability: Record<string, unknown>) {
    return {
      terminalId: 'term-cx-1',
      title: 'Codex',
      createdAt: 1,
      lastActivityAt: 10,
      status: 'running',
      hasClients: false,
      mode: 'codex',
      codexDurability,
    }
  }

  function createStoreWithActivity(sessions: Record<string, number>) {
    return configureStore({
      reducer: {
        terminalDirectory: terminalDirectoryReducer,
        sessionActivity: sessionActivityReducer,
      },
      preloadedState: {
        sessionActivity: { sessions },
      },
    })
  }

  it('folds the alias timestamp into codex:<durabilitySessionId> when the applied page carries durable identity', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'durable', durableThreadId: 'durable-1' })],
      nextCursor: null,
      revision: 11,
    })

    const store = createStoreWithActivity({ 'codex:terminal:term-cx-1': 1111 })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['codex:durable-1']).toBe(1111)
  })

  it('folds candidate-only durability identity the same way (identity_pending rekeys the row too)', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'identity_pending', candidate: CANDIDATE })],
      nextCursor: null,
      revision: 12,
    })

    const store = createStoreWithActivity({ 'codex:terminal:term-cx-1': 2222 })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['codex:cand-1']).toBe(2222)
  })

  it('never lowers an already-newer canonical timestamp (ratchet non-regression)', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'durable', durableThreadId: 'durable-1' })],
      nextCursor: null,
      revision: 13,
    })

    const store = createStoreWithActivity({
      'codex:terminal:term-cx-1': 1111,
      'codex:durable-1': 9999,
    })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['codex:durable-1']).toBe(9999)
  })

  it('writes nothing when no alias activity exists for the terminal', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'durable', durableThreadId: 'durable-1' })],
      nextCursor: null,
      revision: 14,
    })

    const store = createStoreWithActivity({})
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['codex:durable-1']).toBeUndefined()
    expect(Object.keys(store.getState().sessionActivity.sessions)).toHaveLength(0)
  })

  it('writes nothing when the applied item carries no durability identity', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'identity_pending' })],
      nextCursor: null,
      revision: 15,
    })

    const store = createStoreWithActivity({ 'codex:terminal:term-cx-1': 3333 })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    // The identity-less fallback row is still the one shown; the alias must
    // not be folded onto a session that does not exist.
    expect(store.getState().sessionActivity.sessions['codex:terminal:term-cx-1']).toBe(3333)
    expect(Object.keys(store.getState().sessionActivity.sessions)).toHaveLength(1)
  })

  it('folds the alias timestamp into <provider>:<sessionId> for non-codex sessionRef identity (all providers)', async () => {
    // The mid-ack-wait stranding class for non-codex providers: a claude/
    // opencode binding that lands after the close wrote the alias has no
    // codex durability lane — the sessionRef-keyed applied page is the only
    // fold this alias ever gets.
    getTerminalDirectoryPage.mockResolvedValue({
      items: [{
        terminalId: 'term-op-9',
        title: 'OpenCode',
        createdAt: 1,
        lastActivityAt: 10,
        status: 'running',
        hasClients: false,
        mode: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 's-op-9' },
      }],
      nextCursor: null,
      revision: 16,
    })

    const store = createStoreWithActivity({ 'opencode:terminal:term-op-9': 5555 })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['opencode:s-op-9']).toBe(5555)
  })

  it('writes nothing for a non-codex item with no alias activity entry (the common case)', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [{
        terminalId: 'term-cl-4',
        title: 'Claude',
        createdAt: 1,
        lastActivityAt: 10,
        status: 'running',
        hasClients: false,
        mode: 'claude',
        sessionRef: { provider: 'claude', sessionId: 's-cl-4' },
      }],
      nextCursor: null,
      revision: 17,
    })

    const store = createStoreWithActivity({})
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['claude:s-cl-4']).toBeUndefined()
    expect(Object.keys(store.getState().sessionActivity.sessions)).toHaveLength(0)
  })
})

describe('canonical rebind fold on directory refresh (snapshot swap)', () => {
  // The sidebar rows a running terminal under the directory item's own
  // sessionRef (buildSessionItems' runningSessionMap reads
  // state.terminalDirectory.windows.sidebar.items directly — the directory is
  // applied here and never passes through reconcileTerminalSessionAssociation).
  // The terminal.session.associated frame carrying previousSessionId is a
  // single transient broadcast: a client disconnected at rebind time (fresh
  // page load, second device) only ever sees the parent->child swap as two
  // consecutive directory snapshots for the same terminalId. The previous
  // window is the client's only record of the superseded identity, so the
  // canonical previous->new fold must run here too, ratchet-only.

  beforeEach(() => {
    getTerminalDirectoryPage.mockReset()
    _resetTerminalDirectoryThunkControllers()
  })

  function codexSessionItem(terminalId: string, sessionId: string) {
    return {
      terminalId,
      title: 'Codex',
      createdAt: 1,
      lastActivityAt: 10,
      status: 'running',
      hasClients: false,
      mode: 'codex',
      sessionRef: { provider: 'codex', sessionId },
    }
  }

  function createStoreWithActivity(sessions: Record<string, number>) {
    return configureStore({
      reducer: {
        terminalDirectory: terminalDirectoryReducer,
        sessionActivity: sessionActivityReducer,
      },
      preloadedState: {
        sessionActivity: { sessions },
      },
    })
  }

  async function fetchSidebarPage(store: ReturnType<typeof createStoreWithActivity>) {
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
  }

  it('folds the superseded canonical timestamp onto the new identity when a refresh swaps the same terminal\'s sessionRef', async () => {
    getTerminalDirectoryPage
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-cx-9', 'parent-1')],
        nextCursor: null,
        revision: 20,
      })
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-cx-9', 'child-1')],
        nextCursor: null,
        revision: 21,
      })

    const store = createStoreWithActivity({ 'codex:parent-1': 4444 })
    await fetchSidebarPage(store)
    expect(store.getState().sessionActivity.sessions['codex:child-1']).toBeUndefined()

    await fetchSidebarPage(store)
    expect(store.getState().sessionActivity.sessions['codex:child-1']).toBe(4444)
    // The old key stays (ratchet-only, pruned by existing retention).
    expect(store.getState().sessionActivity.sessions['codex:parent-1']).toBe(4444)
  })

  it('never lowers an already-newer new-identity timestamp (ratchet non-regression)', async () => {
    getTerminalDirectoryPage
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-cx-9', 'parent-1')],
        nextCursor: null,
        revision: 20,
      })
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-cx-9', 'child-1')],
        nextCursor: null,
        revision: 21,
      })

    const store = createStoreWithActivity({ 'codex:parent-1': 4444, 'codex:child-1': 9999 })
    await fetchSidebarPage(store)
    await fetchSidebarPage(store)

    expect(store.getState().sessionActivity.sessions['codex:child-1']).toBe(9999)
  })

  it('writes nothing when the refreshed identity is unchanged', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexSessionItem('term-cx-9', 'parent-1')],
      nextCursor: null,
      revision: 20,
    })

    const store = createStoreWithActivity({ 'codex:parent-1': 4444 })
    await fetchSidebarPage(store)
    await fetchSidebarPage(store)

    // No canonical->canonical fold happened: the map is untouched.
    expect(store.getState().sessionActivity.sessions).toEqual({ 'codex:parent-1': 4444 })
  })

  it('writes nothing when the previous window never carried the terminal (first sighting)', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexSessionItem('term-cx-9', 'child-1')],
      nextCursor: null,
      revision: 20,
    })

    const store = createStoreWithActivity({ 'codex:parent-1': 4444 })
    await fetchSidebarPage(store)

    // There is no evidence the terminal ever stood for parent-1 on this
    // client, so nothing may move.
    expect(store.getState().sessionActivity.sessions).toEqual({ 'codex:parent-1': 4444 })
  })

  it('does not fold across providers (a provider change is not a rebind)', async () => {
    getTerminalDirectoryPage
      .mockResolvedValueOnce({
        items: [{
          terminalId: 'term-x-1',
          title: 'Claude',
          createdAt: 1,
          lastActivityAt: 10,
          status: 'running',
          hasClients: false,
          mode: 'claude',
          sessionRef: { provider: 'claude', sessionId: 'claude-1' },
        }],
        nextCursor: null,
        revision: 20,
      })
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-x-1', 'child-1')],
        nextCursor: null,
        revision: 21,
      })

    const store = createStoreWithActivity({ 'claude:claude-1': 4444 })
    await fetchSidebarPage(store)
    await fetchSidebarPage(store)

    expect(store.getState().sessionActivity.sessions).toEqual({ 'claude:claude-1': 4444 })
  })
})

describe('mid-ack-wait identity binding stranding (composition)', () => {
  // LB-1 composition, end to end through the real thunks: an identity
  // binding delivered during closeTab's <=5s ack wait is routed through
  // reconcileTerminalSessionAssociation BEFORE the close-commit ratchet
  // writes the alias key, so Task 3's fold is a no-op on an empty source,
  // and the once-per-binding broadcast never re-fires. The ratchet then
  // reads the FROZEN identity-less directory snapshot and writes the alias
  // key — stranded. The next applied directory page carries the bound
  // identity, and the all-provider directory alias fold is the heal.

  beforeEach(() => {
    getTerminalDirectoryPage.mockReset()
    _resetTerminalDirectoryThunkControllers()
    midWaitAssociation.onPanesClosed = null
  })

  function identityLessOpencodeItem() {
    return {
      terminalId: 't-strand',
      title: 'OpenCode pane',
      createdAt: 1,
      lastActivityAt: 1,
      status: 'running',
      hasClients: true,
      mode: 'opencode',
    }
  }

  function boundOpencodeItem() {
    return {
      ...identityLessOpencodeItem(),
      sessionRef: { provider: 'opencode', sessionId: 's-strand' },
    }
  }

  it('heals a mid-ack-wait binding: the alias written by the close ratchet folds to canonical on the next applied page', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessionActivity: sessionActivityReducer,
        terminalDirectory: terminalDirectoryReducer,
      },
      preloadedState: {
        // The frozen directory window the ratchet reads at close-commit:
        // the terminal is identity-less here.
        terminalDirectory: {
          windows: { sidebar: { items: [identityLessOpencodeItem()] } },
          searches: {},
        },
      },
    })
    store.dispatch(addTab({ mode: 'opencode' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'opencode', terminalId: 't-strand' },
    }))

    // The binding lands mid-wait: the ws mock routes it through the real
    // reconcile the moment the batch close is sent (before the ack
    // answers), exactly as App.tsx routes a terminal.session.associated
    // frame. Task 3's fold no-ops — the alias does not exist yet.
    midWaitAssociation.onPanesClosed = () => {
      reconcileTerminalSessionAssociation({
        dispatch: store.dispatch,
        getState: store.getState,
        terminalId: 't-strand',
        sessionRef: { provider: 'opencode', sessionId: 's-strand' },
      })
    }
    const beforeClose = Date.now()
    await store.dispatch(closeTab(tabId))

    // The stranding (characterization): the ratchet wrote the alias under
    // the frozen identity-less directory item, and the association's one
    // fold opportunity already passed — the canonical key is untouched.
    const sessions = store.getState().sessionActivity.sessions
    expect(sessions['opencode:terminal:t-strand']).toBeGreaterThanOrEqual(beforeClose)
    expect(sessions['opencode:s-strand']).toBeUndefined()

    // The next applied page carries the bound identity — the directory
    // alias fold must land the alias's value on the canonical key.
    getTerminalDirectoryPage.mockResolvedValue({
      items: [boundOpencodeItem()],
      nextCursor: null,
      revision: 31,
    })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    const folded = store.getState().sessionActivity.sessions
    expect(folded['opencode:s-strand']).toBe(sessions['opencode:terminal:t-strand'])
    // Ratchet-only: the source entry stays (pruned by existing retention).
    expect(folded['opencode:terminal:t-strand']).toBe(sessions['opencode:terminal:t-strand'])
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

```bash
npm run test:vitest -- run test/unit/client/store/terminalDirectoryThunks.test.ts
```

FAIL because `fetchTerminalDirectoryWindow` applies pages without any fold: `sessions['codex:durable-1']` / `sessions['codex:cand-1']` / `sessions['codex:child-1']` read `undefined` after the fetches, `sessions['opencode:s-op-9']` reads `undefined` (a non-codex sessionRef item a codex-gated fold would skip), and the stranding scenario's post-fetch `folded['opencode:s-strand']` reads `undefined` (the stranded alias never folds) — while the scenario's mid-close assertions (alias written, canonical still absent) hold, pinning the stranding itself (and the untouched-map tests fail only if a mis-implementation over-folds).

- [ ] **Step 3: Add the minimal production implementation**

In src/store/terminalDirectoryThunks.ts — extend the imports (after line 4) with:

```ts
import {
  foldCanonicalSessionActivity,
  foldTerminalAliasActivity,
} from '@/lib/terminal-session-association'
```

and extend the terminalDirectorySlice import block (lines 6-16) with `type TerminalDirectoryItem,`.

Insert before the `TerminalDirectorySurface` type (before line 18):

```ts
/**
 * Canonical identity the sidebar rows a directory item under — mirrors
 * buildSessionItems' runningSessionMap derivation in
 * selectors/sidebarSelectors.ts: sessionRef first, then the codex durability
 * id for codex terminals (getCodexDurabilitySessionId). Items with neither
 * are rowed under the identity-less `<mode>:terminal:<terminalId>` fallback
 * key, which is not a canonical identity. This identity is ALSO the alias
 * fold's target: a touch recorded under that fallback key folds onto the
 * key the row actually reads once an applied page carries this identity.
 */
function directoryItemCanonicalIdentity(
  item: TerminalDirectoryItem,
): { provider: string; sessionId: string } | undefined {
  const ref = item?.sessionRef
  if (
    typeof ref?.provider === 'string'
    && typeof ref.sessionId === 'string'
    && ref.sessionId.length > 0
  ) {
    return { provider: ref.provider, sessionId: ref.sessionId }
  }
  if (item?.mode === 'codex') {
    const durabilitySessionId = item.codexDurability?.durableThreadId
      ?? item.codexDurability?.candidate?.candidateThreadId
    if (typeof durabilitySessionId === 'string' && durabilitySessionId.length > 0) {
      return { provider: 'codex', sessionId: durabilitySessionId }
    }
  }
  return undefined
}
```

Then replace the `try` block's dispatch section (lines 83-91) — insert the fold block between `if (controller.signal.aborted) return` and the `dispatch(setTerminalDirectoryWindowData({` call, and hoist the items array:

```ts
      if (controller.signal.aborted) return

      // Close-tab activity migration runs at this store-level choke point —
      // the sidebar rows running terminals straight from the applied window
      // (buildSessionItems reads terminalDirectory.windows.sidebar.items;
      // the directory never passes through
      // reconcileTerminalSessionAssociation), and the refresh fires on every
      // terminals.changed / terminal.meta.updated broadcast as well as on
      // (re)connect, mounted or not. Two folds over every applied item
      // carrying a canonical identity (directoryItemCanonicalIdentity —
      // sessionRef for any provider, codex durability for codex terminals),
      // both ratchet-only:
      //
      // 1. Canonical-to-canonical: the terminal.session.associated frame
      //    carrying previousSessionId is a single transient broadcast, so a
      //    client disconnected at rebind time only ever sees a codex fork
      //    handoff as the SAME terminalId swapping canonical identity between
      //    two applied pages. The previous window is the only record of the
      //    superseded identity — fold its activity onto the new one.
      // 2. Alias-to-canonical, ALL providers: a terminal closed while
      //    identity-less had its touch recorded under
      //    `<provider>:terminal:<terminalId>`; once the applied item carries
      //    a canonical identity the row rekeys, so fold the alias across
      //    (onto the same key the sidebar rows the item under — the
      //    sessionRef identity wins over durability when both exist, exactly
      //    like the row derivation). This is the only heal for a binding
      //    that arrived during closeTab's ack wait: its
      //    association-reconcile fold ran before the ratchet wrote the
      //    alias (a no-op on an empty source), and the once-per-binding
      //    broadcast never re-fires — without it, a non-codex alias stays
      //    stranded until a reconnect/attach re-reconcile.
      const items = Array.isArray(response?.items) ? response.items : []
      const stateBeforeFold = getState()
      const previousIdentityByTerminalId = new Map<string, { provider: string; sessionId: string }>()
      for (const previous of stateBeforeFold.terminalDirectory?.windows?.[args.surface]?.items ?? []) {
        if (typeof previous?.terminalId !== 'string') continue
        const identity = directoryItemCanonicalIdentity(previous)
        if (identity) previousIdentityByTerminalId.set(previous.terminalId, identity)
      }
      for (const item of items) {
        if (typeof item?.terminalId !== 'string') continue
        const identity = directoryItemCanonicalIdentity(item)
        if (!identity) continue
        const previous = previousIdentityByTerminalId.get(item.terminalId)
        if (
          previous
          && previous.provider === identity.provider
          && previous.sessionId !== identity.sessionId
        ) {
          foldCanonicalSessionActivity({
            dispatch,
            state: stateBeforeFold,
            provider: identity.provider,
            previousSessionId: previous.sessionId,
            sessionId: identity.sessionId,
          })
        }
        foldTerminalAliasActivity({
          dispatch,
          state: stateBeforeFold,
          terminalId: item.terminalId,
          provider: identity.provider,
          sessionId: identity.sessionId,
        })
      }

      dispatch(setTerminalDirectoryWindowData({
        surface: args.surface,
        items,
        revision: response?.revision,
        nextCursor: response?.nextCursor ?? null,
        append: args.append,
      }))
```

- [ ] **Step 4: Run the focused test**

```bash
npm run test:vitest -- run test/unit/client/store/terminalDirectoryThunks.test.ts
```

Expected: PASS — the new describes plus every pre-existing describe in the file (pages whose items carry no canonical identity, or no alias activity entry under their row keys, dispatch no folds at all).

- [ ] **Step 5: Refactor while green** — No-op by design: the single fold loop shares Task 3's core helpers, the canonical-identity derivation is already extracted as `directoryItemCanonicalIdentity` and now drives both folds (the alias fold targets the same key the sidebar rows the item under), and the `items` hoist removes the duplicated array-guard expression.

- [ ] **Step 6: Run impacted-test verification** — the directory consumers:

```bash
npm run test:vitest -- run test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/lib/terminal-session-association.test.ts test/unit/client/components/Sidebar.test.tsx
```

Expected: PASS. Sidebar renders from the applied window (its directory items carry no alias-activity entries under their row keys, so the folds are no-ops there); the association suite pins the shared fold core; the stranding scenario's ws mock and mid-wait hook are scoped to its own describe and reset in its `beforeEach`.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/terminalDirectoryThunks.ts test/unit/client/store/terminalDirectoryThunks.test.ts && git commit -m "feat(client): fold close-touch activity at terminal directory apply"
```

### Task 5: E2E close-touch phase — append the close-float acceptance pin to the seeded tier-sort spec

**Files:**
- Modify: test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts (add the `getSessionTabId` helper after `getSessionTerminalId`, before `test.describe.serial` (between :415 and :417); append the Phase-6 block inside the single serial test, after the Phase-5 final order assertion `await expectSidebarOrder(page, [S_GREY, S_OPEN, S_BUSY], 30_000)` (:569), before the test's closing `})`)

**Interfaces:**
- Consumes: the spec's existing machinery — the seeded sessions S_GREY/S_BUSY/S_OPEN with fixed timestamps (S_OPEN is the OLDEST: T(3.5)/T(3)), the `rowOpen` locator (:489), `expectSidebarOrder` (:334-350), the `getSessionTerminalId` store-walk pattern (:357-415), and the TabBar close-button precedent (tab-management.spec.ts:61-73 — a plain click on the tab's `title="Close (Shift+Click to kill)"` button dispatches the evidence-gated `closeTab`, which the real Rust server acks). The spec is registered in RUST_ONLY_SPECS (playwright.config.ts:364) and NOT in CLOUD_SKIP_SPECS, so the phase covers both the local rust-chromium project and the cloud backend.
- Produces: no production changes; one new spec phase (the close-touch acceptance pin) and one helper (`getSessionTabId`).

**Known coverage boundary (stated plainly):** the phase pins the user-visible close-float, not the closeTab ratchet in isolation. The pre-existing grey-transition watcher (`src/store/sessionGreyTouch.ts`) touches the same canonical key on `removeTab` for this shape, and both writers are ratchet-only (max wins) — the phase passes on the watcher alone and cannot attribute the float to either writer. Mechanism isolation (the watcher's gap shapes: a session still open in another local tab, registry-only identity, non-running content) lives in the Task 2 unit tests. The phase's non-vacuity is against losing the close-time touch ENTIRELY: with neither writer, grey recency alone sinks the OLDEST-seeded S_OPEN below S_BUSY (`[S_GREY, S_BUSY, S_OPEN]`), so the asserted `[S_GREY, S_OPEN, S_BUSY]` can only hold through a touch.

- [ ] **Step 1: Write the behavioral test**

In test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts, add after `getSessionTerminalId` (before `test.describe.serial`):

```ts
/**
 * The tabId of the page's own local claude tab for sessionId, read from the
 * client pane-layout store (the layouts map is keyed by tabId). Sibling of
 * getSessionTerminalId above — same store walk, returning the owning tab's
 * id instead of the leaf's terminalId (copied-and-adapted per this suite's
 * per-spec-ownership convention: helpers are copied, not imported).
 */
async function getSessionTabId(
  page: import('@playwright/test').Page,
  sessionId: string,
): Promise<string> {
  await expect
    .poll(
      async () =>
        page.evaluate((sid) => {
          const state = window.__FRESHELL_TEST_HARNESS__?.getState?.()
          const layouts = state?.panes?.layouts ?? {}
          for (const [tabId, layout] of Object.entries(layouts)) {
            const collect = (node: any): any[] => {
              if (!node) return []
              if (node.type === 'leaf') return [node]
              if (node.type === 'split') return [...collect(node.children?.[0]), ...collect(node.children?.[1])]
              return []
            }
            const hit = collect(layout).find(
              (leaf: any) =>
                leaf?.content?.kind === 'terminal' &&
                leaf?.content?.sessionRef?.provider === 'claude' &&
                leaf?.content?.sessionRef?.sessionId === sid,
            )
            if (hit) return tabId
          }
          return null
        }, sessionId),
      { timeout: 30_000 },
    )
    .not.toBeNull()
  return (await page.evaluate((sid) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState?.()
    const layouts = state?.panes?.layouts ?? {}
    for (const [tabId, layout] of Object.entries(layouts)) {
      const collect = (node: any): any[] => {
        if (!node) return []
        if (node.type === 'leaf') return [node]
        if (node.type === 'split') return [...collect(node.children?.[0]), ...collect(node.children?.[1])]
        return []
      }
      const hit = collect(layout).find(
        (leaf: any) =>
          leaf?.content?.kind === 'terminal' &&
          leaf?.content?.sessionRef?.provider === 'claude' &&
          leaf?.content?.sessionRef?.sessionId === sid,
      )
      if (hit) return tabId
    }
    return null
  }, sessionId)) as string
}
```

Then append inside the single serial test, after the Phase-5 final order assertion (`await expectSidebarOrder(page, [S_GREY, S_OPEN, S_BUSY], 30_000)`) and before the closing `})`:

```ts
    // Phase 6 — close-touch acceptance pin (the Requested result), in two
    // ordered steps:
    //
    // (a) Clear S_OPEN from device B's registry FIRST, while the local tab
    //     is still open. Phase 2's pushed snapshot still carries it, and a
    //     local close against that stale record demotes S_OPEN
    //     local-open → REMOTE-open (rank 3), which outranks grey (rank 4)
    //     with no touch at all — the float assertion would pass vacuously.
    //     records: [] replaces the device snapshot wholesale
    //     (replace_client_snapshot, crates/freshell-ws/src/tabs.rs:146),
    //     and the page absorbs it on its next 30s registry query
    //     (QUERY_INTERVAL_MS, src/store/tabRegistrySync.ts:24) — so the
    //     poll below reads the client store directly (the row's remote ring
    //     is suppressed while the session is locally open; the DOM cannot
    //     show the removal). Local-open wins over remote, making this a
    //     visually inert stability step: order unchanged.
    // (b) Close S_OPEN's local tab through the real TabBar close button.
    //     With no local tab AND no remote record anywhere, S_OPEN is
    //     GENUINELY grey carrying the OLDEST seeded timestamps (T(3.5)/T(3));
    //     only a close-time touch floats it above S_BUSY to the top of the
    //     grey section. S_GREY stays local-open (tier 1, above grey).
    //
    // NON-VACUITY: with the close-time touch lost entirely (both the Task 2
    // closeTab ratchet and the pre-existing grey-transition watcher dead at
    // the close), S_OPEN falls into grey on its seeded timestamps while
    // S_BUSY's grey recency is at least its newer seeds (T(2.5)/T(2)) and
    // at most its Phase-2 watcher touch — either way S_BUSY outranks S_OPEN
    // and the order settles to [S_GREY, S_BUSY, S_OPEN], failing the final
    // assertion. The asserted order can only hold through a close-time
    // touch on S_OPEN.
    //
    // KNOWN COVERAGE BOUNDARY: that close-time touch is over-determined —
    // the closeTab ratchet (Task 2) and the grey-transition watcher
    // (store/sessionGreyTouch.ts) write the SAME canonical key with
    // max-wins semantics at this transition, so this phase pins the
    // user-visible float, not the ratchet in isolation (mechanism
    // isolation lives in the unit tests' watcher-gap shapes, Task 2).
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [],
    })
    // Remote-driven liveness (the spec's 30s query model, poll ≤45s): the
    // page's remote registry must no longer carry claude:S_OPEN BEFORE the
    // close, or the vacuity this phase exists to remove comes back through
    // the stale record.
    await expect
      .poll(
        () =>
          page.evaluate((key) => {
            const remoteOpen = window.__FRESHELL_TEST_HARNESS__?.getState?.()?.tabRegistry?.remoteOpen ?? []
            return remoteOpen.some((record: any) =>
              (record?.panes ?? []).some((pane: any) =>
                (pane?.payload?.sessionKeys ?? []).includes(key)))
          }, `claude:${S_OPEN}`),
        { timeout: 45_000 },
      )
      .toBe(false)
    // Stability: the clear changed nothing — local-open still owns the top.
    await expectSidebarOrder(page, [S_GREY, S_OPEN, S_BUSY])
    const sOpenTabId = await getSessionTabId(page, S_OPEN)
    const sOpenTab = page.locator(`[data-context="tab"][data-tab-id="${sOpenTabId}"]`)
    // Plain click = the evidence-gated detach-close (the button's title is
    // "Close (Shift+Click to kill)"); the real Rust server answers the
    // batch ack, the close commits, and the touch composes into the grey
    // order. tab-management.spec.ts:61-73 is the close-button precedent.
    await sOpenTab.getByRole('button', { name: /close/i }).click()
    await expect(rowOpen).toHaveAttribute('data-has-tab', 'false', { timeout: 30_000 })
    await expectSidebarOrder(page, [S_GREY, S_OPEN, S_BUSY], 15_000)
```

- [ ] **Step 2: Run the test and verify the intended failure mode**

```bash
env -u FRESHELL_BIND_HOST npm run test:e2e -- --grep "status-tier sort"
```

Unlike Tasks 1-4 there is no red-first run to observe here: the phase is an acceptance pin over a close-touch composition whose writers — the Task 2 ratchet and the pre-existing grey-transition watcher — BOTH pre-exist this task (the known coverage boundary above; disabling either one alone leaves the float, and disabling the watcher also breaks the spec's own Phase 2). The first run is therefore expected GREEN: PASS (1 test, all phases). The failure the phase exists to catch is the composition loss — a regression that drops the close-time touch entirely leaves the OLDEST-seeded S_OPEN below S_BUSY (`[S_GREY, S_BUSY, S_OPEN]`), the non-vacuity anchor documented in the phase comment. If the run fails, diagnose per phase (the spec header explains each expected state); never weaken assertions, widen deadlines beyond the documented liveness/grace model, or drop phases. Run through `npm run test:e2e` so the configured `FRESHELL_E2E_BACKEND` (local|cloud) applies — per repo rules, if that variable is unset, confirm the backend choice with the user before the first e2e run. The first local run in this worktree may compile the Rust release server inside `beforeAll` (600s hook budget; the cloud image ships a prebuilt binary).

- [ ] **Step 3: Add the minimal production implementation**

None by design — a test-only task: the pinned close-float behavior shipped in Task 2 (and, for this shape, on main via the watcher — the known coverage boundary). Do not touch production files.

- [ ] **Step 4: Run the focused test**

```bash
env -u FRESHELL_BIND_HOST npm run test:e2e -- --grep "status-tier sort"
```

Expected: PASS (1 test) — all phases green in one serial run; the appended phase must not destabilize the earlier phases (shared 300s test budget; the phase adds up to ~45s, dominated by the remote-snapshot absorption poll waiting out the page's 30s registry-query interval — the same remote-driven liveness model Phases 1-2 already use).

- [ ] **Step 5: Refactor while green** — No-op by design: the helper duplicates the `getSessionTerminalId` walk VERBATIM per this suite's per-spec-ownership convention (helpers are copied, not imported); extracting a shared walk would violate it.

- [ ] **Step 6: Run impacted-test verification** — the sibling spec sharing the copied raw-device harness convention (guards against accidental cross-edits), same backend:

```bash
env -u FRESHELL_BIND_HOST npm run test:e2e -- --grep "status-tier sort|remote status rings"
```

Expected: PASS (both files green). The repo-wide gate is the final gate below, not this step.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts && git commit -m "test(e2e): pin the close-tab grey-section float in the seeded tier-sort spec"
```

## Final gate (after the last task, before any PR)

- [ ] Typecheck + lint + full coordinated suite from the worktree:

```bash
npm run lint
FRESHELL_TEST_SUMMARY="sidebar-close-touch-ratchet final gate" npm run check
```

Expected: both exit 0.

- [ ] E2E close-touch phase on the configured backend (`npm run check` does NOT run Playwright):

```bash
env -u FRESHELL_BIND_HOST npm run test:e2e -- --grep "status-tier sort"
```

Expected: exit 0 — the spec (rust-chromium project; cloud-runnable, not in CLOUD_SKIP_SPECS) green including the Task 5 close-touch phase.

- [ ] Confirm dispositions: e2e coverage is the Task 5 phase appended to the existing seeded tier-sort spec (no new spec file; decision C as amended in planner note 10); no `docs/index.html` update (planner note 10); no settings, toggles, or visual changes (decision D); no changes to the tier-sort machinery, remote-ring render suppression, ring visuals, or busy/green icon logic (decision A — none of `sidebarSelectors.ts`, `sessionStatusTiers.ts`, or `sessionGreyTouch.ts` is touched).
- [ ] Stop before `gh pr create`: PR creation requires explicit user approval per repo rules.
