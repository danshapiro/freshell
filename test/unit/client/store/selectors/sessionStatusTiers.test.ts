import { describe, it, expect } from 'vitest'
import { makeSelectSessionStatusTiers } from '@/store/selectors/sessionStatusTiers'
import type { RootState } from '@/store/store'
import type {
  RegistryPaneSnapshot,
  RegistryTabRecord,
} from '@/store/tabRegistryTypes'

function makeTab(sessionId: string, terminalId: string) {
  const sessionRef = { provider: 'claude', sessionId }
  return {
    id: `tab-${sessionId}`,
    mode: 'claude',
    resumeSessionId: sessionId,
    sessionRef,
    createdAt: 1,
  }
}

function makeLayout(sessionId: string, terminalId: string) {
  return {
    type: 'leaf',
    id: `pane-${sessionId}`,
    content: {
      kind: 'terminal',
      mode: 'claude',
      status: 'running',
      terminalId,
      createRequestId: `req-${sessionId}`,
      sessionRef: { provider: 'claude', sessionId },
    },
  }
}

/**
 * Fresh-agent restore-gap fixtures: the pane carries a STALE resume locator
 * while the live session in freshAgent.sessions has a DIFFERENT canonical
 * session id (e.g. the provider rebound the thread during restore).
 */
function makeFreshAgentTab(staleSessionId: string) {
  return {
    id: `tab-fresh-${staleSessionId}`,
    createdAt: 1,
  }
}

function makeFreshAgentLayout(staleSessionId: string, liveSessionId: string) {
  return {
    type: 'leaf',
    id: `pane-fresh-${staleSessionId}`,
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: liveSessionId,
      resumeSessionId: staleSessionId,
      createRequestId: `req-fresh-${staleSessionId}`,
      status: 'connected',
    },
  }
}

function makeLiveFreshSession(liveSessionId: string, busy: boolean) {
  return {
    sessionType: 'freshclaude',
    provider: 'claude',
    sessionId: liveSessionId,
    sessionKey: `freshclaude:claude:${liveSessionId}`,
    threadId: liveSessionId,
    status: busy ? 'running' : 'idle',
    turns: [],
    historyItems: [],
    historyBodies: {},
    streamingText: '',
    streamingActive: false,
    pendingPermissions: {},
    pendingQuestions: {},
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  }
}

function makeRemoteRecord(panePayloads: Array<Record<string, unknown>>): RegistryTabRecord {
  return {
    tabKey: 'device-b:tab-1',
    tabId: 'tab-1',
    serverInstanceId: 'srv-test',
    deviceId: 'device-b',
    deviceLabel: 'device-b',
    tabName: 'freshell',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: panePayloads.length,
    titleSetByUser: false,
    panes: panePayloads.map(
      (payload, i): RegistryPaneSnapshot => ({ paneId: `pane-${i}`, kind: 'terminal', payload }),
    ),
  }
}

const EMPTY_BY_ID: Record<string, never> = {}

function makeState(options: {
  localSessions?: Array<{ sessionId: string; busy?: boolean }>
  restoreGap?: { staleSessionId: string; liveSessionId: string; busy?: boolean }
  remoteOpen?: RegistryTabRecord[]
  sameDeviceOpen?: RegistryTabRecord[]
} = {}): RootState {
  const tabs: unknown[] = []
  const layouts: Record<string, unknown> = {}
  const busyClaude: Record<string, unknown> = {}
  let freshAgentSessions: Record<string, unknown> = EMPTY_BY_ID

  for (const local of options.localSessions ?? []) {
    const terminalId = `term-${local.sessionId}`
    tabs.push(makeTab(local.sessionId, terminalId))
    layouts[`tab-${local.sessionId}`] = makeLayout(local.sessionId, terminalId)
    if (local.busy) {
      busyClaude[terminalId] = { terminalId, phase: 'busy', updatedAt: 1 }
    }
  }

  if (options.restoreGap) {
    const { staleSessionId, liveSessionId, busy } = options.restoreGap
    tabs.push(makeFreshAgentTab(staleSessionId))
    layouts[`tab-fresh-${staleSessionId}`] = makeFreshAgentLayout(staleSessionId, liveSessionId)
    freshAgentSessions = {
      [`freshclaude:claude:${liveSessionId}`]: makeLiveFreshSession(liveSessionId, busy === true),
    }
  }

  return {
    tabs: { tabs },
    panes: { layouts },
    codexActivity: { byTerminalId: EMPTY_BY_ID },
    claudeActivity: { byTerminalId: busyClaude },
    amplifierActivity: { byTerminalId: EMPTY_BY_ID },
    opencodeActivity: { byTerminalId: EMPTY_BY_ID },
    paneRuntimeActivity: { byPaneId: EMPTY_BY_ID },
    freshAgent: { sessions: freshAgentSessions },
    tabRegistry: {
      remoteOpen: options.remoteOpen ?? [],
      sameDeviceOpen: options.sameDeviceOpen ?? [],
    },
  } as unknown as RootState
}

describe('makeSelectSessionStatusTiers', () => {
  it('marks a session whose local pane is busy as local-busy', () => {
    const select = makeSelectSessionStatusTiers()
    const tiers = select(makeState({ localSessions: [{ sessionId: 's-busy', busy: true }] }))

    expect(tiers).toEqual({ 'claude:s-busy': 'local-busy' })
  })

  it('marks an idle locally-open session as local-open', () => {
    const select = makeSelectSessionStatusTiers()
    const tiers = select(makeState({ localSessions: [{ sessionId: 's-idle' }] }))

    expect(tiers).toEqual({ 'claude:s-idle': 'local-open' })
  })

  it('maps genuinely remote records to remote-busy / remote-open', () => {
    const select = makeSelectSessionStatusTiers()
    const tiers = select(makeState({
      remoteOpen: [
        makeRemoteRecord([
          { sessionKeys: ['claude:r-busy'], busySessionKeys: ['claude:r-busy'] },
          { sessionKeys: ['claude:r-open'] },
        ]),
      ],
    }))

    expect(tiers).toEqual({
      'claude:r-busy': 'remote-busy',
      'claude:r-open': 'remote-open',
    })
  })

  it('lets local presence win over remote activity for the same session', () => {
    const select = makeSelectSessionStatusTiers()
    const tiers = select(makeState({
      localSessions: [{ sessionId: 'both' }],
      remoteOpen: [
        makeRemoteRecord([
          { sessionKeys: ['claude:both'], busySessionKeys: ['claude:both'] },
        ]),
      ],
    }))

    expect(tiers).toEqual({ 'claude:both': 'local-open' })
  })

  it('never emits a remote tier for same-device records', () => {
    const select = makeSelectSessionStatusTiers()
    const tiers = select(makeState({
      sameDeviceOpen: [
        makeRemoteRecord([
          { sessionKeys: ['claude:sd'], busySessionKeys: ['claude:sd'] },
        ]),
      ],
    }))

    expect(tiers).toEqual({})
  })

  it('restore-gap idle: live-canonical key stays grey while the stale locator key is local-open', () => {
    const select = makeSelectSessionStatusTiers()
    const tiers = select(makeState({
      restoreGap: { staleSessionId: 'stale-gap', liveSessionId: 'live-gap' },
    }))

    // The Sidebar renders the canonical row grey (no hasTab, not busy): the
    // identity collector's live key is a ring-suppression source, NOT a
    // local-open render gate.
    expect(tiers['claude:live-gap']).toBeUndefined()
    expect(tiers['claude:stale-gap']).toBe('local-open')
  })

  it('restore-gap busy: live-canonical key is local-busy', () => {
    const select = makeSelectSessionStatusTiers()
    const tiers = select(makeState({
      restoreGap: { staleSessionId: 'stale-gap', liveSessionId: 'live-gap', busy: true },
    }))

    expect(tiers['claude:live-gap']).toBe('local-busy')
    expect(tiers['claude:stale-gap']).toBe('local-open')
  })

  it('restore-gap remote guard: a remote record for the ring-suppressed canonical key stays tier-less', () => {
    const select = makeSelectSessionStatusTiers()
    const tiers = select(makeState({
      restoreGap: { staleSessionId: 'stale-gap', liveSessionId: 'live-gap' },
      remoteOpen: [
        makeRemoteRecord([{ sessionKeys: ['claude:live-gap'] }]),
      ],
    }))

    // Ring suppression says "open on this device" — the row neither rings nor
    // carries a local tier; it stays grey.
    expect(tiers['claude:live-gap']).toBeUndefined()
    expect(tiers['claude:stale-gap']).toBe('local-open')
  })

  it('omits sessions unknown to every source (grey is absence)', () => {
    const select = makeSelectSessionStatusTiers()
    expect(select(makeState())).toEqual({})
  })

  it('memoizes on selector inputs (stable reference for irrelevant store churn)', () => {
    const select = makeSelectSessionStatusTiers()
    const state = makeState({ localSessions: [{ sessionId: 's-idle' }] })
    const first = select(state)
    const second = select(state)
    const churned = select({ ...state, sessions: { projects: [] } } as unknown as RootState)

    expect(first).toBe(second)
    expect(first).toBe(churned)
  })
})
