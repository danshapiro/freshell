import { describe, expect, it } from 'vitest'
import reducer, { applyAgentRestartReplaced } from '@/store/panesSlice'
import type { PaneNode, PanesState } from '@/store/paneTypes'

function terminalPane(
  id: string,
  overrides: Partial<Extract<PaneNode, { type: 'leaf' }>['content']> = {},
): Extract<PaneNode, { type: 'leaf' }> {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'terminal',
      createRequestId: `create-${id}`,
      status: 'running',
      mode: 'claude',
      shell: 'system',
      sessionRef: { provider: 'claude', sessionId: 's1' },
      terminalId: 'terminal-old',
      runtimeId: 'terminal-old',
      runtimeGeneration: 7,
      ...overrides,
    },
  }
}

function stateWithViewers(): PanesState {
  return {
    layouts: {
      tab1: {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          terminalPane('pane-a'),
          terminalPane('pane-b'),
        ],
      },
      tab2: terminalPane('pane-other', {
        createRequestId: 'unchanged',
        sessionRef: { provider: 'claude', sessionId: 'other' },
        terminalId: 'terminal-other',
        runtimeId: 'terminal-other',
      }),
    },
    activePane: { tab1: 'pane-a', tab2: 'pane-other' },
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
    restoreFallbackAttemptsByPane: {},
  }
}

function leaves(node: PaneNode): Extract<PaneNode, { type: 'leaf' }>[] {
  return node.type === 'leaf' ? [node] : [...leaves(node.children[0]), ...leaves(node.children[1])]
}

const replacement = {
  type: 'agent.restart.replaced' as const,
  requestId: 'restart-1',
  provider: 'claude',
  sessionId: 's1',
  kind: 'terminal' as const,
  oldRuntimeId: 'terminal-old',
  oldGeneration: 7,
  runtimeId: 'terminal-new',
  generation: 8,
}

describe('panesSlice agent restart replacement', () => {
  it('rebinds every local viewer to the server-created replacement and no unrelated pane', () => {
    const next = reducer(stateWithViewers(), applyAgentRestartReplaced(replacement))
    const matching = leaves(next.layouts.tab1)
      .map((leaf) => leaf.content)
      .filter((content) => content.kind === 'terminal')

    expect(matching.map((content) => content.terminalId)).toEqual(['terminal-new', 'terminal-new'])
    expect(matching.map((content) => content.runtimeId)).toEqual(['terminal-new', 'terminal-new'])
    expect(matching.map((content) => content.runtimeGeneration)).toEqual([8, 8])
    expect(matching.map((content) => content.reconcileEpoch)).toEqual([1, 1])

    const unrelated = leaves(next.layouts.tab2)[0].content
    expect(unrelated.kind).toBe('terminal')
    if (unrelated.kind !== 'terminal') throw new Error('expected terminal')
    expect(unrelated.createRequestId).toBe('unchanged')
    expect(unrelated.terminalId).toBe('terminal-other')
  })

  it('drops duplicate, older, and wrong-old-runtime replacement events', () => {
    const once = reducer(stateWithViewers(), applyAgentRestartReplaced(replacement))
    const duplicate = reducer(once, applyAgentRestartReplaced(replacement))
    const stale = reducer(duplicate, applyAgentRestartReplaced({
      ...replacement,
      requestId: 'restart-stale',
      oldRuntimeId: 'terminal-new',
      oldGeneration: 6,
      runtimeId: 'terminal-stale',
      generation: 7,
    }))
    const wrongOldRuntime = reducer(stale, applyAgentRestartReplaced({
      ...replacement,
      requestId: 'restart-wrong-old',
      oldRuntimeId: 'not-the-current-runtime',
      oldGeneration: 8,
      runtimeId: 'terminal-wrong',
      generation: 9,
    }))

    expect(wrongOldRuntime).toEqual(once)
  })

  it('fails closed for a legacy pane without an exact runtime fence', () => {
    const initial = stateWithViewers()
    const legacy = leaves(initial.layouts.tab1)[0].content
    if (legacy.kind !== 'terminal') throw new Error('expected terminal')
    // terminalId is a durable/session-facing identifier in legacy persisted
    // layouts. It must not be treated as the opaque runtime identity.
    legacy.runtimeId = undefined
    legacy.runtimeGeneration = undefined

    const next = reducer(initial, applyAgentRestartReplaced(replacement))
    const content = leaves(next.layouts.tab1)[0].content
    expect(content).toMatchObject({
      kind: 'terminal',
      terminalId: 'terminal-old',
      runtimeId: undefined,
      runtimeGeneration: undefined,
    })
  })

  it('rebinds fresh-agent viewers while retaining durable identity and pane settings', () => {
    const initial = stateWithViewers()
    initial.layouts.tab1 = {
      type: 'leaf',
      id: 'fresh-pane',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId: 's1',
        createRequestId: 'fresh-create',
        status: 'idle',
        sessionRef: { provider: 'codex', sessionId: 's1' },
        resumeSessionId: 's1',
        initialCwd: '/workspace',
        model: 'gpt-5.4',
        effort: 'high',
        runtimeId: 'fresh-old',
        runtimeGeneration: 7,
      },
    }

    const next = reducer(initial, applyAgentRestartReplaced({
      ...replacement,
      provider: 'codex',
      kind: 'fresh-agent',
      oldRuntimeId: 'fresh-old',
      runtimeId: 'fresh-new',
    }))
    const content = leaves(next.layouts.tab1)[0].content
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionId: 's1',
      runtimeId: 'fresh-new',
      runtimeGeneration: 8,
      sessionRef: { provider: 'codex', sessionId: 's1' },
      initialCwd: '/workspace',
      model: 'gpt-5.4',
      effort: 'high',
      createRequestId: 'fresh-create',
    })
  })
})
