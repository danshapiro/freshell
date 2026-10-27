import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import { panesSlice, initCopiedLayout, initLayout, updatePaneTitle } from '@/store/panesSlice'
import { applySessionRenameCascade } from '@/store/titleSync'
import sessionsReducer, { commitSessionWindowVisibleRefresh } from '@/store/sessionsSlice'
import { sessionTitleMirrorMiddleware } from '@/store/sessionTitleMirror'
import { getFreshAgentLabel } from '@/lib/fresh-agent-registry'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import {
  foldTerminalInventoryTitles,
  recordTerminalTitleForReplay,
  terminalInventoryTitleReplayMiddleware,
} from '@/lib/terminal-inventory-titles'

function buildStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesSlice.reducer, sessions: sessionsReducer },
    // The sessions slice keeps a Set in state (expandedProjects); test
    // stores including it disable the serializable check, matching the
    // production store's ignoredPaths carve-out (sessionsThunks.test.ts
    // pattern).
    middleware: (gDM) => gDM({ serializableCheck: false }).concat(sessionTitleMirrorMiddleware),
  })
}

/**
 * Unified agent names (Task 5): the mirror now serves only the RETAINED
 * LEGACY scope — out-of-scope panes (kilroy here; shells and non-unified
 * providers below). Scoped agent panes (freshclaude/freshcodex/
 * freshopencode and the claude/codex/opencode terminal modes) are excluded:
 * their display comes from the canonical sessionNames cache. The full
 * behavioral matrix below keeps its meaning for the retained scope.
 */
function seedFreshAgentPane(store: ReturnType<typeof buildStore>, sessionId: string, provider = 'claude') {
  store.dispatch(addTab({ id: 'tab-z', title: 'ZZ probe' }))
  store.dispatch(initLayout({
    tabId: 'tab-z',
    paneId: 'pane-z',
    content: {
      kind: 'fresh-agent',
      provider,
      sessionId,
      sessionType: 'kilroy',
      sessionRef: { provider, sessionId },
    },
  }))
}

function landSessionRow(store: ReturnType<typeof buildStore>, row: {
  surface: string
  sessionId: string
  provider: string
  title?: string
  lastActivityAt?: number
}) {
  // There is no 'sessions/fetchSessionWindow/fulfilled' action — the fetch
  // thunk is hand-rolled and lands rows through the real commit action.
  store.dispatch(commitSessionWindowVisibleRefresh({
    surface: row.surface,
    projects: [{
      projectPath: '/freshell',
      sessions: [{
        provider: row.provider,
        sessionId: row.sessionId,
        projectPath: '/freshell',
        lastActivityAt: row.lastActivityAt ?? 1_000,
        ...(row.title !== undefined ? { title: row.title } : {}),
      }],
    }],
  }))
}

describe('sessionTitleMirrorMiddleware', () => {
  it('mirrors a session-directory title into a matching fresh-agent pane (the MCP-created-pane symptom)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'ZZ probe summarize' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('never overwrites a user-set pane title', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-z', title: 'My name', setByUser: true }))
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Directory title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('My name')
  })

  it('skips rows without a title and ignores non-sessions actions', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    const seeded = store.getState().panes.paneTitles['tab-z']['pane-z']
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude' })
    store.dispatch({ type: 'settings/updated', payload: {} })
    expect(store.getState().panes.paneTitles['tab-z']?.['pane-z']).toBe(seeded)
  })

  it('does not re-dispatch when the mirrored title already equals the pane title', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Same title' })
    const before = store.getState()
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Same title' })
    expect(store.getState().panes).toBe(before.panes)
  })

  it('a row RETAINED from an older fetch does not beat a fresher row another window fetched later (the deep-page retention case)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Retained sidebar title', lastActivityAt: 2_000 })
    landSessionRow(store, { surface: 'history', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Fresh history title', lastActivityAt: 2_000 })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Fresh history title')
    // The later sidebar refresh commits the merged window the real thunk
    // builds — the retained row carries its existing fetchSeq because
    // mergeProjects passes the previous window's row OBJECTS through.
    const retainedProjects = store.getState().sessions.windows['sidebar'].projects
    store.dispatch(commitSessionWindowVisibleRefresh({
      surface: 'sidebar',
      projects: retainedProjects,
    }))
    // The window-level stamps are now the freshest of all three commits;
    // the retained row must STILL lose to History's row.
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Fresh history title')
  })

  it('equal-activity rows fetched fresh by both windows: the later-fetched row wins (History holds the newer title)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Older sidebar title', lastActivityAt: 2_000 })
    landSessionRow(store, { surface: 'history', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Newer history title', lastActivityAt: 2_000 })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Newer history title')
  })

  it('titles a pane created AFTER its directory row is already loaded (the missed-ordering symptom)', () => {
    const store = buildStore()
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'ZZ probe summarize' })
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('titles a copied legacy pane when its directory row was loaded before the atomic copy', () => {
    const store = buildStore()
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Copied conversation' })
    store.dispatch(addTab({ id: 'tab-z', title: 'ZZ probe' }))

    store.dispatch(initCopiedLayout({
      tabId: 'tab-z',
      layout: { type: 'leaf', id: 'pane-z', content: {
        kind: 'fresh-agent', provider: 'claude', sessionType: 'kilroy',
        sessionId: DURABLE_CLAUDE, sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
      } as never },
    }))

    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Copied conversation')
  })

  it('a splitPane that binds a new pane to an already-landed session row mirrors the split pane (REST/MCP split binding path)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'ZZ probe summarize' })
    store.dispatch({
      type: 'panes/splitPane',
      payload: {
        tabId: 'tab-z',
        paneId: 'pane-z',
        direction: 'horizontal',
        newPaneId: 'pane-z-split',
        newContent: {
          kind: 'fresh-agent',
          provider: 'claude',
          sessionId: DURABLE_CLAUDE,
          sessionType: 'kilroy',
          sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
        },
      },
    })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z-split']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z-split']).toBeFalsy()
  })

  it('mirrors into EVERY pane bound to the same session (two panes in one tab; the churn guard then rests)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    store.dispatch({
      type: 'panes/splitPane',
      payload: {
        tabId: 'tab-z',
        paneId: 'pane-z',
        direction: 'horizontal',
        newPaneId: 'pane-z-2',
        newContent: {
          kind: 'fresh-agent',
          provider: 'claude',
          sessionId: DURABLE_CLAUDE,
          sessionType: 'kilroy',
          sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
        },
      },
    })
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Both mirror' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Both mirror')
    expect(store.getState().panes.paneTitles['tab-z']['pane-z-2']).toBe('Both mirror')
    const before = store.getState()
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Both mirror' })
    expect(store.getState().panes).toBe(before.panes)
  })

  // Reconcile-attach lifecycle (delta review round 1, finding 2): a
  // persisted fresh-agent pane rehydrates with sessionRef only (persistence
  // strips the top-level sessionId when a canonical sessionRef exists —
  // persistMiddleware stripTransientSessionFields), and the reconcile
  // verdicts that (re)bind sessions are generated panes actions the mirror
  // must trigger on.
  // e1r1 review finding 1 (the reviewer's exact failure case): a LIVE
  // FreshClaude pane keeps an EPHEMERAL nanoid runtime handle in the
  // top-level content.sessionId (minted by the SDK bridge with no
  // placeholder→durable materialization; FreshAgentView.tsx:1804-1828
  // retains it) while the DURABLE Claude UUID lives in content.sessionRef
  // — real shape verified in panesPersistence.test.ts:384-447 and
  // fresh-agent-turn-complete.test.ts:143-184. Directory rows key by the
  // durable UUID, so the mirror must title the pane through sessionRef.
  const DURABLE_CLAUDE = '11111111-2222-4333-8444-555555555555'
  const DURABLE_CLAUDE_2 = '22222222-3333-4444-8555-666666666666'

  function seedLiveDualIdClaudePane(store: ReturnType<typeof buildStore>) {
    store.dispatch(addTab({ id: 'tab-z', title: 'Claude probe' }))
    store.dispatch(initLayout({
      tabId: 'tab-z',
      paneId: 'pane-z',
      content: {
        kind: 'fresh-agent',
        provider: 'claude',
        sessionType: 'kilroy',
        sessionId: 'claude-runtime-nanoid',
        createRequestId: 'req-claude',
        status: 'connected',
        sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
      },
    }))
  }

  it('titles a live FreshClaude pane (ephemeral top-level sessionId, durable sessionRef) when its directory row lands', () => {
    const store = buildStore()
    seedLiveDualIdClaudePane(store)
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Durable row title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Durable row title')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('never overwrites a user-set pane title on a live dual-id FreshClaude pane', () => {
    const store = buildStore()
    seedLiveDualIdClaudePane(store)
    store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-z', title: 'My name', setByUser: true }))
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Directory title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('My name')
  })

  it('titles a persisted-shape fresh-agent pane (sessionRef only, no top-level sessionId) when its directory row lands — the healthy-reload pre-attach window', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-z', title: 'ZZ probe' }))
    store.dispatch(initLayout({
      tabId: 'tab-z',
      paneId: 'pane-z',
      content: {
        kind: 'fresh-agent',
        provider: 'claude',
        sessionType: 'kilroy',
        createRequestId: 'req-z',
        status: 'idle',
        sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
      },
    }))
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'ZZ probe summarize' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('updates the pane title when applyFreshAgentReconcileAttach rebinds the pane to a different titled session', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Old session title' })
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE_2, provider: 'claude', title: 'New session title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Old session title')
    store.dispatch({
      type: 'panes/applyFreshAgentReconcileAttach',
      payload: { tabId: 'tab-z', paneId: 'pane-z', sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE_2 } },
    })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('New session title')
  })

  // Delta review round 2, finding 1: the mirror's pane-walk targets
  // FRESH-AGENT panes only. Terminal panes' titles are owned by the
  // registry-title pipeline (server auto-title sweep, terminal renames
  // via PATCH /api/terminals/:id, the terminal.inventory fold, the live
  // terminal.title fold) — a session-bound terminal pane must NEVER be
  // re-titled by the session directory, or a terminal rename is undone
  // on the next sessions/* commit.
  function seedSessionBoundTerminalPane(store: ReturnType<typeof buildStore>) {
    store.dispatch(addTab({ id: 'tab-z', title: 'Claude probe' }))
    store.dispatch(initLayout({
      tabId: 'tab-z',
      paneId: 'pane-z',
      content: {
        kind: 'terminal',
        mode: 'shell',
        createRequestId: 'req-t',
        status: 'running',
        terminalId: 'term-1',
        sessionRef: { provider: 'claude', sessionId: 's1' },
      },
    }))
  }

  it('does not overwrite a session-bound terminal pane\u2019s folded terminal title when its session row lands (the reviewer\u2019s exact conflict)', () => {
    const store = buildStore()
    seedSessionBoundTerminalPane(store)
    // e2r5 finding 3: the pane's registry title arrives through the REAL
    // registry pipeline — the inventory frame that titles the pane also
    // caches the terminal-level title (the title source the mirror's
    // cache-aware skip checks). The old pin seeded the pane title with a
    // bare updatePaneTitle, which no longer represents any real sequence:
    // a pane holding a terminal-level title implies its window holds the
    // terminal-level title source that delivered it.
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 'term-1', title: 'Renamed via REST' }])).toBe(1)
    landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'Session directory title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Renamed via REST')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('leaves a session-bound terminal pane untouched when applyReconcileAttach rebinds it to a different titled session (registry-title pipeline owns terminal pane titles)', () => {
    const store = buildStore()
    seedSessionBoundTerminalPane(store)
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 'term-1', title: 'Renamed via REST' }])).toBe(1)
    landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'First claude title' })
    landSessionRow(store, { surface: 'sidebar', sessionId: 's2', provider: 'claude', title: 'Second claude title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Renamed via REST')
    store.dispatch({
      type: 'panes/applyReconcileAttach',
      payload: { tabId: 'tab-z', paneId: 'pane-z', terminalId: 'term-1', sessionRef: { provider: 'claude', sessionId: 's2' } },
    })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Renamed via REST')
  })

  it('never overwrites a user-set pane title when reconcile-attach rebinds the pane (rename-scope contract)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, DURABLE_CLAUDE)
    store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-z', title: 'My name', setByUser: true }))
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE_2, provider: 'claude', title: 'New session title' })
    store.dispatch({
      type: 'panes/applyFreshAgentReconcileAttach',
      payload: { tabId: 'tab-z', paneId: 'pane-z', sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE_2 } },
    })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('My name')
  })

  // e2r1 review finding 3: the fresh-agent-only walk gated only the
  // dispatch TRIGGER, not the reducer's targets — a mirror dispatch that
  // matched BOTH fresh-agent and terminal panes on one session re-titled
  // the terminal pane too, overwriting its registry/REST title — the exact
  // precedence defect the repair claimed to eliminate. The mirror must
  // dispatch per-pane (by tabId+paneId, through updatePaneTitle's user-set
  // guard) so no shared walk can ever over-reach; the session-rename
  // cascade (applySessionRenameCascade) keeps its all-kinds semantics
  // through its own per-pane walk (paneContentMatchesSessionRef).
  describe('combined fresh-agent + terminal panes on one session', () => {
    function seedCombinedSessionPanes(store: ReturnType<typeof buildStore>) {
      store.dispatch(addTab({ id: 'tab-z', title: 'Combined panes' }))
      store.dispatch(initLayout({
        tabId: 'tab-z',
        paneId: 'pane-fa',
        content: {
          kind: 'fresh-agent',
          provider: 'claude',
          sessionType: 'kilroy',
          sessionId: DURABLE_CLAUDE,
          createRequestId: 'req-fa',
          status: 'connected',
          sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
        },
      }))
      store.dispatch({
        type: 'panes/splitPane',
        payload: {
          tabId: 'tab-z',
          paneId: 'pane-fa',
          direction: 'horizontal',
          newPaneId: 'pane-term',
          newContent: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-term',
            status: 'running',
            terminalId: 'term-1',
            sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
          },
        },
      })
      store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-fa', title: 'Derived default', setByUser: false }))
      // e2r5 finding 3: pane-term's registry title arrives through the
      // real registry pipeline (the inventory frame that also caches the
      // terminal-level title the mirror's cache-aware skip checks).
      expect(foldTerminalInventoryTitles(store, [{ terminalId: 'term-1', title: 'Renamed via REST' }])).toBe(1)
    }

    it('re-titles ONLY the fresh-agent pane: the same-session terminal pane keeps its registry/REST title (the reviewer\u2019s exact combined case)', () => {
      const store = buildStore()
      seedCombinedSessionPanes(store)
      landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Session directory title' })
      expect(store.getState().panes.paneTitles['tab-z']['pane-fa']).toBe('Session directory title')
      expect(store.getState().panes.paneTitles['tab-z']['pane-term']).toBe('Renamed via REST')
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-term']).toBeFalsy()
    })

    it('user-set precedence holds on both pane kinds in the combined case', () => {
      const store = buildStore()
      seedCombinedSessionPanes(store)
      store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-fa', title: 'My agent name', setByUser: true }))
      store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-term', title: 'My terminal name', setByUser: true }))
      landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Session directory title' })
      expect(store.getState().panes.paneTitles['tab-z']['pane-fa']).toBe('My agent name')
      expect(store.getState().panes.paneTitles['tab-z']['pane-term']).toBe('My terminal name')
    })

    it('the session-rename cascade (applySessionRenameCascade) still updates BOTH pane kinds — its per-pane walk keeps all-kinds semantics', () => {
      const store = buildStore()
      seedCombinedSessionPanes(store)
      applySessionRenameCascade({
        dispatch: store.dispatch,
        getState: store.getState,
        provider: 'claude',
        sessionId: DURABLE_CLAUDE,
        title: 'Renamed from history',
        cascadedTerminalId: null,
      })
      expect(store.getState().panes.paneTitles['tab-z']['pane-fa']).toBe('Renamed from history')
      expect(store.getState().panes.paneTitles['tab-z']['pane-term']).toBe('Renamed from history')
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-fa']).toBe(true)
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-term']).toBe(true)
    })
  })

  // e2r2 review finding 4: the blanket fresh-agent filter removed the
  // directory fold from EVERY session-bound terminal pane — a terminal
  // pane with a valid sessionRef but NO usable terminalId (exited,
  // unavailable, not-yet-reattached after rebuild) can't receive
  // inventory or live terminal-title events; the directory row is its
  // only runtime title source. The requirement is a PRECEDENCE rule, not
  // a kind exclusion: the mirror titles a terminal pane IFF its content
  // has NO terminalId — once a terminalId exists, the inventory
  // fold/replay owns that pane's title (the delta-round-2 precedence
  // pins above stay green: those panes hold terminalIds).
  describe('no-terminalId terminal panes mirror until the registry fold takes over', () => {
    function seedUnboundSessionTerminalPane(store: ReturnType<typeof buildStore>) {
      store.dispatch(addTab({ id: 'tab-z', title: 'Unbound terminal probe' }))
      store.dispatch(initLayout({
        tabId: 'tab-z',
        paneId: 'pane-z',
        content: {
          kind: 'terminal',
          mode: 'shell',
          createRequestId: 'req-unbound',
          status: 'exited',
          sessionRef: { provider: 'claude', sessionId: 's1' },
        },
      }))
    }

    it('mirrors the directory row into a session-bound terminal pane WITHOUT a terminalId (its only runtime title source)', () => {
      const store = buildStore()
      seedUnboundSessionTerminalPane(store)
      landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'Session directory title' })
      expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Session directory title')
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
    })

    it('reattach ordering: once the replay binds the terminalId, the registry title WINS over the earlier mirror write (non-user-set)', () => {
      const store = configureStore({
        reducer: { tabs: tabsReducer, panes: panesSlice.reducer, sessions: sessionsReducer },
        middleware: (gDM) => gDM({ serializableCheck: false })
          .concat(terminalInventoryTitleReplayMiddleware, sessionTitleMirrorMiddleware),
      })
      seedUnboundSessionTerminalPane(store)
      landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'Session directory title' })
      expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Session directory title')
      // The boot inventory frame carries the terminal's registry title; the
      // pane has no terminalId yet, so the fold only caches it.
      expect(foldTerminalInventoryTitles(store, [{ terminalId: 'term-1', title: 'Registry title' }])).toBe(0)
      store.dispatch({
        type: 'panes/applyReconcileAttach',
        payload: { tabId: 'tab-z', paneId: 'pane-z', terminalId: 'term-1' },
      })
      // The binding action triggers BOTH middlewares: the mirror now skips
      // the pane (it holds a terminalId with a CACHED terminal title) and
      // the replay writes the cached registry title — the fold's write
      // beats the earlier mirror write.
      expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Registry title')
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
    })
  })

  // e2r5 review finding 3: a truthy terminalId is NOT proof that a
  // terminal-level title source exists — the replay cache holds only the
  // LAST CONNECTION's snapshot. A terminal created by ANOTHER client after
  // this window's handshake never appears in this window's inventory
  // frame, no live terminal.title event addresses its unopened pane, and
  // terminal.attach.ready carries no title, so the blanket terminalId skip
  // left the pane on its derived default forever. The mirror updates a
  // terminal pane IFF it holds NO terminalId OR NO cached terminal-level
  // title for that terminalId; a later terminal-level title (record →
  // replay) still overwrites the non-user-set mirror title exactly as
  // before.
  describe('cache-aware terminal-pane mirror precedence (e2r5 finding 3)', () => {
    function buildMirrorAndReplayStore() {
      return configureStore({
        reducer: { tabs: tabsReducer, panes: panesSlice.reducer, sessions: sessionsReducer },
        middleware: (gDM) => gDM({ serializableCheck: false })
          .concat(terminalInventoryTitleReplayMiddleware, sessionTitleMirrorMiddleware),
      })
    }

    function seedSessionTerminalPaneWithTerminalId(store: ReturnType<typeof buildMirrorAndReplayStore>, terminalId: string) {
      store.dispatch(addTab({ id: 'tab-z', title: 'Post-handshake probe' }))
      store.dispatch(initLayout({
        tabId: 'tab-z',
        paneId: 'pane-z',
        content: {
          kind: 'terminal',
          mode: 'shell',
          createRequestId: 'req-e2r5',
          status: 'running',
          terminalId,
          sessionRef: { provider: 'claude', sessionId: 's1' },
        },
      }))
    }

    it('mirrors the directory title into a post-handshake terminal pane (terminalId present, NO cached terminal title — its only runtime title source)', () => {
      const store = buildMirrorAndReplayStore()
      // The user opens another client's already-titled session row: the
      // pane arrives with terminalId + sessionRef, but this window's
      // replay cache holds NO entry for the terminal (created after this
      // window's last inventory frame).
      foldTerminalInventoryTitles(store, [])
      seedSessionTerminalPaneWithTerminalId(store, 'term-e2r5-new')
      landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'Directory title for a post-handshake terminal' })
      expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Directory title for a post-handshake terminal')
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
    })

    it('a terminal WITH a cached terminal-level title stays skipped (the delta-round-2 precedence, cache-aware)', () => {
      const store = buildMirrorAndReplayStore()
      seedSessionTerminalPaneWithTerminalId(store, 'term-e2r5-cached')
      // The real registry pipeline titled the pane AND cached the
      // terminal-level title.
      expect(foldTerminalInventoryTitles(store, [{ terminalId: 'term-e2r5-cached', title: 'Registry title' }])).toBe(1)
      landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'Directory title' })
      expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Registry title')
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
    })

    it('a later-recorded terminal title REPLACES the mirrored directory title, and later session commits never undo it', () => {
      const store = buildMirrorAndReplayStore()
      foldTerminalInventoryTitles(store, [])
      seedSessionTerminalPaneWithTerminalId(store, 'term-e2r5-new')
      landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'Directory title' })
      expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Directory title')
      // A terminal-level title later arrives (attach →
      // terminal.title.updated → record): the record REPLACES the mirror
      // as the pane's owner...
      recordTerminalTitleForReplay('term-e2r5-new', 'Registry title')
      // ...the next binding action replays it over the non-user-set
      // mirrored title...
      store.dispatch({
        type: 'panes/applyReconcileAttach',
        payload: { tabId: 'tab-z', paneId: 'pane-z', terminalId: 'term-e2r5-new' },
      })
      expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Registry title')
      // ...and the mirror now skips the pane (cache entry exists), so a
      // later sessions commit never re-mirrors the directory title over
      // the registry title.
      landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'Directory title again' })
      expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Registry title')
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
    })
  })

  /**
   * Unified agent names (Task 5): the scoped agent panes are EXCLUDED from
   * this legacy mirror — their display is the canonical session name from
   * the sessionNames cache, and no directory-row mirror write (or user
   * flag) ever lands on them. Kilroy, shells, and non-unified providers
   * keep the mirror (the matrix above).
   */
  describe('unified agent names: scoped panes never mirror', () => {
    it.each([
      ['freshclaude', 'claude'],
      ['freshcodex', 'codex'],
      ['freshopencode', 'opencode'],
      ['kilroy', 'claude'],
    ] as const)('fresh pane %s: mirrored only when out of scope', (sessionType, provider) => {
      const store = buildStore()
      store.dispatch(addTab({ id: 'tab-z', title: 'Scoped probe' }))
      store.dispatch(initLayout({
        tabId: 'tab-z',
        paneId: 'pane-z',
        content: {
          kind: 'fresh-agent',
          provider,
          sessionType,
          sessionId: DURABLE_CLAUDE,
          sessionRef: { provider, sessionId: DURABLE_CLAUDE },
        },
      }))
      landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider, title: 'Directory title' })
      const paneTitle = store.getState().panes.paneTitles['tab-z']?.['pane-z']
      if (sessionType === 'kilroy') {
        expect(paneTitle).toBe('Directory title')
      } else {
        // The pane keeps its derived default — the directory row never
        // mirrors into a scoped pane.
        expect(paneTitle).toBe(getFreshAgentLabel(sessionType))
        expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
      }
    })

    it.each(['claude', 'codex', 'opencode'] as const)('a scoped %s terminal pane never mirrors the directory row', (mode) => {
      const store = buildStore()
      store.dispatch(addTab({ id: 'tab-z', title: 'Scoped terminal probe' }))
      store.dispatch(initLayout({
        tabId: 'tab-z',
        paneId: 'pane-z',
        content: {
          kind: 'terminal',
          mode,
          createRequestId: 'req-scoped-term',
          status: 'running',
          sessionRef: { provider: mode, sessionId: DURABLE_CLAUDE },
        },
      }))
      landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: mode, title: 'Directory title' })
      // The pane keeps its derived provider label — the directory row never
      // mirrors into a scoped terminal pane.
      expect(store.getState().panes.paneTitles['tab-z']?.['pane-z']).toBe(getProviderLabel(mode))
      expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
    })
  })
})
