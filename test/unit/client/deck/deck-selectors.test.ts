import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import antigravityActivityReducer from '@/store/antigravityActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import settingsReducer from '@/store/settingsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import repoIconsReducer from '@/store/repoIconsSlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { DeckKeyLayout, DeckTileStyle } from '@shared/settings'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'
import type { RepoIconEntry } from '@/store/repoIconsSlice'
import { buildRepoIconUrl } from '@/lib/repo-icon'
import { hueFromString } from '@/components/icons/RepoIcon'
import {
  findApproveTarget, findStopTarget, getTabRepoIcons, getTabStatusFlags, getTabPaneIcons, selectDeckModel,
} from '@/deck/deck-selectors'
import { getTabDisplayTitle } from '@/lib/tab-title'
import type { RootState } from '@/store/store'

const reducer = {
  tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer,
  freshAgent: freshAgentReducer, codexActivity: codexActivityReducer,
  claudeActivity: claudeActivityReducer, amplifierActivity: amplifierActivityReducer,
  antigravityActivity: antigravityActivityReducer,
  opencodeActivity: opencodeActivityReducer, paneRuntimeActivity: paneRuntimeActivityReducer,
  settings: settingsReducer, terminalMeta: terminalMetaReducer, repoIcons: repoIconsReducer,
}

const s1Key = makeFreshAgentSessionKey({ sessionType: 'freshclaude', provider: 'claude', sessionId: 's1' })

function makeState(overrides: {
  claudeBusy?: boolean
  attention?: Record<string, boolean>
  pendingPermissions?: Record<string, { requestId: string }>
  freshAgentRunning?: boolean
  paneStatus?: Record<string, Tab['status']>
  terminalMeta?: Record<string, TerminalMetaRecord>
  repoIcons?: Record<string, RepoIconEntry>
  t1Layout?: PaneNode
  /** Extra tab fields merged into the default fixture's t1 (e.g. title/titleSetByUser for title-parity tests). */
  t1Tab?: Partial<Tab>
  /** When set, replaces the default 2-tab fixture with tabs t1..tN, each a terminal leaf pane pN (terminalId term-N, mode 'claude'). */
  tabs?: number
  activeTab?: string
  /** terminalIds marked busy via claudeActivity (mirrors the e2e fixture's busy option). */
  busy?: string[]
} = {}) {
  let tabsList: unknown[]
  let layouts: Record<string, unknown>
  let activePane: Record<string, string>
  if (overrides.tabs !== undefined) {
    const n = overrides.tabs
    tabsList = Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`, createRequestId: `c${i + 1}`, title: `tab${i + 1}`, status: 'running', mode: 'shell', createdAt: i + 1,
    }))
    layouts = {}
    activePane = {}
    for (let i = 1; i <= n; i++) {
      layouts[`t${i}`] = {
        type: 'leaf', id: `p${i}`,
        content: { kind: 'terminal', terminalId: `term-${i}`, createRequestId: `c${i}`, status: overrides.paneStatus?.[`p${i}`] ?? 'running', mode: 'claude' },
      }
      activePane[`t${i}`] = `p${i}`
    }
  } else {
    tabsList = [
      { id: 't1', createRequestId: 'c1', title: 'build', status: 'running', mode: 'shell', createdAt: 1, ...overrides.t1Tab },
      { id: 't2', createRequestId: 'c2', title: 'claude', status: 'running', mode: 'shell', createdAt: 2 },
    ]
    layouts = {
      t1: overrides.t1Layout ?? { type: 'leaf', id: 'p1', content: { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: overrides.paneStatus?.p1 ?? 'running', mode: 'claude' } },
      t2: { type: 'leaf', id: 'p2', content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1', createRequestId: 'c2', status: 'running' } },
    }
    activePane = { t1: 'p1', t2: 'p2' }
  }
  const busyByTerminalId: Record<string, unknown> = Object.fromEntries(
    (overrides.busy ?? []).map((terminalId) => [terminalId, { terminalId, phase: 'busy', updatedAt: 1 }]),
  )
  if (overrides.claudeBusy) busyByTerminalId['term-1'] = { phase: 'busy' }
  const store = configureStore({
    reducer,
    preloadedState: {
      tabs: {
        tabs: tabsList,
        activeTabId: overrides.activeTab ?? 't1', renameRequestTabId: null, tombstones: [],
      },
      panes: {
        layouts,
        activePane,
        paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
        zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
      },
      claudeActivity: { byTerminalId: busyByTerminalId },
      terminalMeta: { byTerminalId: overrides.terminalMeta ?? {} },
      repoIcons: { byCwd: overrides.repoIcons ?? {} },
      turnCompletion: {
        seq: 0, lastAtByTerminalId: {}, lastIdleAtByTerminalId: {}, pendingEvents: [],
        attentionByTab: overrides.attention ?? {}, attentionByPane: {},
      },
      freshAgent: {
        sessions: {
          [s1Key]: {
            sessionKey: s1Key, threadId: 's1', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1',
            status: overrides.freshAgentRunning ? 'running' : 'idle', streamingActive: false,
            pendingPermissions: overrides.pendingPermissions ?? {}, pendingQuestions: {},
          },
        },
        pendingCreates: {}, pendingCreateFailures: {}, availableModels: [],
      },
    } as never,
  })
  return store.getState() as never
}

describe('deck-selectors', () => {
  it('quiet tabs are neither busy nor attention', () => {
    const state = makeState()
    const model = selectDeckModel(state)
    expect(model.tabs).toHaveLength(2)
    expect(model.tabs[0]).toMatchObject({ id: 't1', title: 'build', active: true, busy: false, attention: false })
  })

  it('busy terminal pane -> busy tab', () => {
    const state = makeState({ claudeBusy: true })
    expect(selectDeckModel(state).tabs.find((t) => t.id === 't1')!.busy).toBe(true)
  })

  it('attentionByTab -> attention flag', () => {
    const state = makeState({ attention: { t1: true } })
    expect(selectDeckModel(state).tabs.find((t) => t.id === 't1')!.attention).toBe(true)
  })

  it('pending permission suppresses busy on the fresh-agent tab', () => {
    const state = makeState({ pendingPermissions: { r1: { requestId: 'r1' } }, freshAgentRunning: true })
    const t2 = selectDeckModel(state).tabs.find((t) => t.id === 't2')!
    expect(t2.busy).toBe(false) // isFreshAgentBusy yields false while waiting
    const model = selectDeckModel(state)
    const freshTab = model.tabs.find((t) => t.id === 't2')!
    expect(freshTab.pendingApproval).toBe(true)
    expect(model.tabs.filter((t) => t.pendingApproval)).toHaveLength(1)
  })

  it('findApproveTarget returns the pending permission for the tab', () => {
    const state = makeState({ pendingPermissions: { r1: { requestId: 'r1' } } })
    expect(findApproveTarget(state, 't2')).toEqual({
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1',
    })
    expect(findApproveTarget(state, 't1')).toBeNull()
  })

  it('findStopTarget: busy fresh-agent wins; busy terminal otherwise; null when quiet', () => {
    const busyAgent = makeState({ freshAgentRunning: true })
    expect(findStopTarget(busyAgent, 't2')).toEqual({
      kind: 'fresh-agent', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
    })
    expect(findStopTarget(busyAgent, 't2')).not.toHaveProperty('cwd') // claude stays cwd-less
    const busyTerm = makeState({ claudeBusy: true })
    expect(findStopTarget(busyTerm, 't1')).toMatchObject({ kind: 'terminal', paneId: 'p1', terminalId: 'term-1' })
    expect(findStopTarget(makeState(), 't1')).toBeNull()
  })
})

describe('freshopencode targets carry cwd (server auth keys embed it — A8)', () => {
  const oKey = makeFreshAgentSessionKey({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1' })
  function makeOpencodeState(overrides: { pendingPermissions?: Record<string, { requestId: string }>; running?: boolean } = {}) {
    const store = configureStore({
      reducer,
      preloadedState: {
        tabs: {
          tabs: [{ id: 't3', createRequestId: 'c3', title: 'oc', status: 'running', mode: 'shell', createdAt: 3 }],
          activeTabId: 't3', renameRequestTabId: null, tombstones: [],
        },
        panes: {
          layouts: {
            t3: { type: 'leaf', id: 'p3', content: { kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1', createRequestId: 'c3', status: 'running', initialCwd: '/repo/a' } },
          },
          activePane: { t3: 'p3' },
          paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
          zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
        },
        freshAgent: {
          sessions: {
            [oKey]: {
              sessionKey: oKey, threadId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1',
              status: overrides.running ? 'running' : 'idle', streamingActive: false,
              pendingPermissions: overrides.pendingPermissions ?? {}, pendingQuestions: {},
            },
          },
          pendingCreates: {}, pendingCreateFailures: {}, availableModels: [],
        },
      } as never,
    })
    return store.getState() as never
  }

  it('findApproveTarget includes cwd for a freshopencode pane', () => {
    const state = makeOpencodeState({ pendingPermissions: { r9: { requestId: 'r9' } } })
    expect(findApproveTarget(state, 't3')).toEqual({
      sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', requestId: 'r9', cwd: '/repo/a',
    })
  })

  it('findStopTarget includes cwd for a busy freshopencode pane', () => {
    const state = makeOpencodeState({ running: true })
    expect(findStopTarget(state, 't3')).toEqual({
      kind: 'fresh-agent', sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/a',
    })
  })
})

function tabsOf(state: never): Tab[] {
  return (state as { tabs: { tabs: Tab[] } }).tabs.tabs
}

function withTabAttentionStyle(state: never, style: 'none' | 'highlight'): never {
  const clone = structuredClone(state) as { settings: { settings: { panes: { tabAttentionStyle: string } } } }
  clone.settings.settings.panes.tabAttentionStyle = style
  return clone as never
}

function withTileStyle(state: never, tileStyle: DeckTileStyle): never {
  const clone = structuredClone(state) as { settings: { settings: { streamDeck: { tileStyle: string } } } }
  clone.settings.settings.streamDeck.tileStyle = tileStyle
  return clone as never
}

function withKeyLayout(state: never, keyLayout: DeckKeyLayout): never {
  const clone = structuredClone(state) as { settings: { settings: { streamDeck: { keyLayout: string } } } }
  clone.settings.settings.streamDeck.keyLayout = keyLayout
  return clone as never
}

describe('getTabStatusFlags', () => {
  it('greenIcon: running non-busy pane sets greenIcon (tab bar green icon condition)', () => {
    const state = makeState() // default fixture: t1 has a claude terminal pane, status running, not busy
    const tab = tabsOf(state)[0]
    expect(getTabStatusFlags(state, tab)).toEqual({ busy: false, attention: false, greenIcon: true })
  })

  it('busy pane sets busy and suppresses greenIcon when it is the only pane', () => {
    const state = makeState({ claudeBusy: true }) // term-1 busy; p1 is t1's only pane
    expect(getTabStatusFlags(state, tabsOf(state)[0])).toEqual({ busy: true, attention: false, greenIcon: false })
  })

  it('attention flag mirrors turnCompletion.attentionByTab', () => {
    const state = makeState({ attention: { t1: true } })
    expect(getTabStatusFlags(state, tabsOf(state)[0]).attention).toBe(true)
  })

  it("attention is gated off when tabAttentionStyle is 'none' (tab bar shows no bar/fill then)", () => {
    const state = withTabAttentionStyle(makeState({ attention: { t1: true } }), 'none')
    expect(getTabStatusFlags(state, tabsOf(state)[0]).attention).toBe(false)
  })

  it('exited terminal pane yields no greenIcon', () => {
    const state = makeState({ paneStatus: { p1: 'exited' } })
    expect(getTabStatusFlags(state, tabsOf(state)[0]).greenIcon).toBe(false)
  })

  it('tab with NO pane layout classifies from the synthesized pane (tab.mode/tab.status), matching the tab bar', () => {
    // Real transient: addTab (tabsSlice.ts:296) never seeds a layout — PaneLayout.tsx:30-35
    // initializes it in a post-paint useEffect, persisted-state restore can omit layout entries,
    // and the deck repaints synchronously per dispatch, so it WILL paint layout-less tabs.
    const state = makeState()
    // Fixture tabs carry mode: 'shell' (only pane CONTENTS are mode 'claude'). The synthesized
    // pane inherits tab.mode, and a shell-mode pane never yields greenIcon — so override the
    // tab under test.
    const tab = { ...tabsOf(state)[0], mode: 'claude' as const, status: 'running' as const }
    const base = state as { panes: Record<string, unknown> }
    const noLayout = { ...(state as object), panes: { ...base.panes, layouts: {} } } as never
    expect(getTabStatusFlags(noLayout, tab)).toEqual({ busy: false, attention: false, greenIcon: true })
  })
})

function meta(terminalId: string, cwd: string): TerminalMetaRecord {
  return { terminalId, cwd, updatedAt: 1 }
}

function claudeLeaf(id: string, terminalId: string, initialCwd?: string): PaneNode {
  return { type: 'leaf', id, content: { kind: 'terminal', terminalId, createRequestId: 'c1', status: 'running', mode: 'claude', ...(initialCwd ? { initialCwd } : {}) } }
}

function split(id: string, a: PaneNode, b: PaneNode): PaneNode {
  return { type: 'split', id, direction: 'horizontal', children: [a, b], sizes: [50, 50] }
}

describe('getTabRepoIcons', () => {
  it('maps a resolved repo cwd with an icon to a repo-icon URL + letter + hue', () => {
    const state = makeState({
      terminalMeta: { 'term-1': meta('term-1', '/repos/alpha') },
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    })
    expect(getTabRepoIcons(state, tabsOf(state)[0])).toEqual([
      { url: buildRepoIconUrl('/repos/alpha'), letter: 'A', hue: hueFromString('alpha') },
    ])
  })

  it('falls back to letter-only (url null) when the repo has no icon', () => {
    const state = makeState({
      terminalMeta: { 'term-1': meta('term-1', '/repos/beta') },
      repoIcons: { '/repos/beta': { status: 'error', hasIcon: false, repoName: 'beta' } },
    })
    expect(getTabRepoIcons(state, tabsOf(state)[0])).toEqual([
      { url: null, letter: 'B', hue: hueFromString('beta') },
    ])
  })

  it('skips cwds still loading, dedupes by repoKey, caps at 3 distinct repos', () => {
    // 6 panes in one tab across cwds: loading, r1, r1-worktree (same repoRoot), r2, r3, r4.
    // Expect exactly r1, r2, r3 in first-appearance order (r4 truncated by the cap).
    const state = makeState({
      t1Layout: split('s1',
        claudeLeaf('p1', 'term-loading'),
        split('s2',
          claudeLeaf('p2', 'term-r1a'),
          split('s3',
            claudeLeaf('p3', 'term-r1b'),
            split('s4',
              claudeLeaf('p4', 'term-r2'),
              split('s5', claudeLeaf('p5', 'term-r3'), claudeLeaf('p6', 'term-r4')))))),
      terminalMeta: {
        'term-loading': meta('term-loading', '/repos/loading'),
        'term-r1a': meta('term-r1a', '/repos/r1'),
        'term-r1b': meta('term-r1b', '/repos/r1-wt'),
        'term-r2': meta('term-r2', '/repos/r2'),
        'term-r3': meta('term-r3', '/repos/r3'),
        'term-r4': meta('term-r4', '/repos/r4'),
      },
      repoIcons: {
        '/repos/loading': { status: 'loading' },
        '/repos/r1': { status: 'ready', repoRoot: '/repos/r1', repoName: 'r1', hasIcon: true },
        '/repos/r1-wt': { status: 'ready', repoRoot: '/repos/r1', repoName: 'r1', hasIcon: true },
        '/repos/r2': { status: 'error', hasIcon: false, repoName: 'r2' },
        '/repos/r3': { status: 'ready', repoRoot: '/repos/r3', repoName: 'r3', hasIcon: true },
        '/repos/r4': { status: 'ready', repoRoot: '/repos/r4', repoName: 'r4', hasIcon: true },
      },
    })
    expect(getTabRepoIcons(state, tabsOf(state)[0])).toEqual([
      { url: buildRepoIconUrl('/repos/r1'), letter: 'R', hue: hueFromString('r1') },
      { url: null, letter: 'R', hue: hueFromString('r2') },
      { url: buildRepoIconUrl('/repos/r3'), letter: 'R', hue: hueFromString('r3') },
    ])
  })

  it('returns [] for a tab with no repo-resolvable panes', () => {
    const state = makeState() // no terminalMeta seeded, no initialCwd anywhere
    expect(getTabRepoIcons(state, tabsOf(state)[0])).toEqual([])
  })

  it('tab with NO pane layout derives its icon from the synthesized pane (tab.initialCwd), matching the tab bar', () => {
    const state = makeState({
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    })
    // Fixture tabs are mode: 'shell', and resolvePaneRepoCwd resolves terminal panes only
    // when their mode is non-shell (isNonShellMode); the synthesized pane inherits tab.mode.
    // Override mode alongside initialCwd or the icon can never appear.
    const tab = { ...tabsOf(state)[0], mode: 'claude' as const, initialCwd: '/repos/alpha' }
    const base = state as { panes: Record<string, unknown> }
    const noLayout = { ...(state as object), panes: { ...base.panes, layouts: {} } } as never
    expect(getTabRepoIcons(noLayout, tab)).toEqual([
      { url: buildRepoIconUrl('/repos/alpha'), letter: 'A', hue: hueFromString('alpha') },
    ])
  })
})

describe('selectDeckModel (sorted, tile fields)', () => {
  it('sorts tabs by priority: barTop, greenFill, greenIcon, blueIcon, rest', () => {
    // t1 exited pane (rest), t2 busy (blueIcon), t3 running idle (greenIcon),
    // t4 attention inactive (greenFill), t5 attention + active (barTop)
    const state = makeState({
      tabs: 5,
      activeTab: 't5',
      paneStatus: { p1: 'exited' },
      busy: ['term-2'],
      attention: { t4: true, t5: true },
    })
    const model = selectDeckModel(state)
    expect(model.tabs.map((t) => t.id)).toEqual(['t5', 't4', 't3', 't2', 't1'])
    expect(model.tabs.map((t) => t.priority)).toEqual([0, 1, 2, 3, 4])
  })

  it('is stable within a priority group (tab-bar order preserved)', () => {
    const state = makeState({ tabs: 3 }) // all three are greenIcon
    const model = selectDeckModel(state)
    expect(model.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('exposes the tile style on the model (default status-icons)', () => {
    const state = makeState({ tabs: 3 })
    expect(selectDeckModel(state).tileStyle).toBe('status-icons')
  })

  it('terminal-previews style keeps raw tab-bar order (no priority sort)', () => {
    // Same fixture as the priority-sort test: sorted order is t5,t4,t3,t2,t1,
    // so raw tab-bar order (t1..t5) genuinely differs from sorted output.
    const base = makeState({
      tabs: 5,
      activeTab: 't5',
      paneStatus: { p1: 'exited' },
      busy: ['term-2'],
      attention: { t4: true, t5: true },
    })
    const state = withTileStyle(base, 'terminal-previews') // clone idiom — direct mutation throws (frozen state)
    const model = selectDeckModel(state)
    expect(model.tileStyle).toBe('terminal-previews')
    expect(model.tabs.map((t) => t.id)).toEqual(tabsOf(state).map((t) => t.id))
    expect(tabsOf(state).map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  it('exposes keyLayout on the model (default auto)', () => {
    const base = makeState({ tabs: 1 })
    expect(selectDeckModel(base).keyLayout).toBe('auto')
    expect(selectDeckModel(withKeyLayout(base, 'newest-first')).keyLayout).toBe('newest-first')
  })

  it('stamps tabIndex with the tab-bar position, surviving the priority sort', () => {
    // Reuse the sort fixture from 'sorts tabs by priority...': after the
    // sort, each DeckTab.tabIndex still equals its position in state.tabs.tabs.
    const sortFixtureState = makeState({
      tabs: 5,
      activeTab: 't5',
      paneStatus: { p1: 'exited' },
      busy: ['term-2'],
      attention: { t4: true, t5: true },
    })
    const model = selectDeckModel(sortFixtureState)
    expect(model.tabs.map((t) => t.id)).toEqual(['t5', 't4', 't3', 't2', 't1']) // sort actually reordered
    for (const t of model.tabs) {
      expect(t.tabIndex).toBe(tabsOf(sortFixtureState).findIndex((tab) => tab.id === t.id))
    }
  })

  it('quiet tabs report pendingApproval false', () => {
    const state = makeState() // default fixture: no busy panes, no pending permissions
    expect(selectDeckModel(state).tabs.every((t) => t.pendingApproval === false)).toBe(true)
  })

  it('carries fill, dot, and repoIcons per tab', () => {
    const state = makeState({
      tabs: 2,
      activeTab: 't1',
      attention: { t1: true },
      busy: ['term-2'],
      terminalMeta: { 'term-1': meta('term-1', '/repos/alpha') },
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    })
    const model = selectDeckModel(state)
    const t1 = model.tabs.find((t) => t.id === 't1')!
    const t2 = model.tabs.find((t) => t.id === 't2')!
    expect(t1.fill).toBe('barTop')
    expect(t1.repoIcons).toEqual([{ url: buildRepoIconUrl('/repos/alpha'), letter: 'A', hue: hueFromString('alpha') }])
    expect(t2.fill).toBe('none')
    expect(t2.dot).toBe('blue')
  })
})

describe('getTabPaneIcons', () => {
  it('non-shell terminal pane -> provider = mode, tint green when running and not busy', () => {
    const state = makeState()
    expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([{ provider: 'claude', tint: 'green' }])
  })

  it('busy wins over status: busy claude pane tints blue', () => {
    const state = makeState({ claudeBusy: true })
    expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([{ provider: 'claude', tint: 'blue' }])
  })

  it('fresh-agent pane -> provider = sessionType, treated as running (green) unless busy', () => {
    const state = makeState()
    expect(getTabPaneIcons(state, tabsOf(state)[1])).toEqual([{ provider: 'freshclaude', tint: 'green' }])
  })

  it('shell panes yield no agent icon', () => {
    const state = makeState({
      t1Layout: { type: 'leaf', id: 'p1', content: { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: 'running', mode: 'shell' } } as never,
    })
    expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([])
  })

  it('status maps like the tab bar: exited -> mutedDim, error -> red, creating -> muted, recovering -> amber', () => {
    for (const [status, tint] of [['exited', 'mutedDim'], ['error', 'red'], ['creating', 'muted'], ['recovering', 'amber']] as const) {
      const state = makeState({ paneStatus: { p1: status } })
      expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([{ provider: 'claude', tint }])
    }
  })

  it('multiple agent panes stay in layout order and are NOT capped here', () => {
    const state = makeState({
      t1Layout: split('s1', claudeLeaf('p1', 'term-1'), split('s2', claudeLeaf('p2', 'term-2'), claudeLeaf('p3', 'term-3'))),
      busy: ['term-2'],
    })
    expect(getTabPaneIcons(state, tabsOf(state)[0])).toEqual([
      { provider: 'claude', tint: 'green' },
      { provider: 'claude', tint: 'blue' },
      { provider: 'claude', tint: 'green' },
    ])
  })

  it('selectDeckModel carries paneIcons per tab', () => {
    const state = makeState({ claudeBusy: true })
    const model = selectDeckModel(state)
    const t1 = model.tabs.find((t) => t.id === 't1')!
    expect(t1.paneIcons).toEqual([{ provider: 'claude', tint: 'blue' }])
  })
})

describe('deck titles match the tab bar (getTabDisplayTitle parity)', () => {
  // The tab bar's exact call shape (TabBar.tsx:199, test/e2e/coding-agent-naming-flow.test.tsx:43).
  // extensions uses ?. because this unit-test store does not register the extensions reducer.
  function tabBarTitle(state: never, tab: Tab): string {
    const s = state as unknown as RootState
    return getTabDisplayTitle(tab, s.panes.layouts[tab.id], s.panes.paneTitles?.[tab.id], s.extensions?.entries)
  }

  it('replaces a "Tab N" placeholder with the tab bar derived label (cwd basename)', () => {
    // One tab whose stored title is the raw placeholder and whose single
    // claude pane has initialCwd '/home/dan/code/freshell'.
    const state = makeState({
      t1Tab: { title: 'Tab 1' },
      t1Layout: claudeLeaf('p1', 'term-1', '/home/dan/code/freshell'),
    })
    const model = selectDeckModel(state)
    const t1 = model.tabs.find((t) => t.id === 't1')!
    expect(t1.title).toBe('freshell')
    // Load-bearing parity assertion: byte-identical with the tab bar's call.
    expect(t1.title).toBe(tabBarTitle(state, tabsOf(state)[0]))
  })

  it('keeps a user-set custom title verbatim', () => {
    const state = makeState({
      t1Tab: { title: 'my custom name', titleSetByUser: true },
      t1Layout: claudeLeaf('p1', 'term-1', '/tmp/x'),
    })
    expect(selectDeckModel(state).tabs.find((t) => t.id === 't1')!.title).toBe('my custom name')
  })

  it('layout-less tab falls back to the stored title, exactly like the tab bar', () => {
    const base = makeState({ t1Tab: { title: 'Tab 1' } })
    // Clone idiom from the layout-less tests above: drop all pane layouts.
    const noLayout = { ...(base as object), panes: { ...(base as { panes: Record<string, unknown> }).panes, layouts: {} } } as never
    const tab = tabsOf(noLayout)[0]
    const t1 = selectDeckModel(noLayout).tabs.find((t) => t.id === 't1')!
    expect(t1.title).toBe('Tab 1')
    expect(t1.title).toBe(tabBarTitle(noLayout, tab))
  })
})
