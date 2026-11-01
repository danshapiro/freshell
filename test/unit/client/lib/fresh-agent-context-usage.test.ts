import { describe, expect, it } from 'vitest'
import type { CodingCliSession, ProjectGroup } from '@/store/types'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import {
  resolveFreshAgentContextUsage,
  guardContextUsageTokenSummary,
  collectFreshAgentContextUsageKeys,
  latestCodexUsage,
} from '@/lib/fresh-agent-context-usage'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'

it('preserves the native latest and cumulative samples without counting token subsets twice', () => {
  expect(latestCodexUsage({ last: { totalTokens: 20, inputTokens: 15, cachedInputTokens: 8, outputTokens: 5, reasoningOutputTokens: 3 }, total: { totalTokens: 200, inputTokens: 150, outputTokens: 50 }, modelContextWindow: 258400 })).toEqual({ observed: true, latestTokens: 20, totalTokens: 200, modelContextWindow: 258400 })
  expect(latestCodexUsage({ last: { totalTokens: 0 }, total: { totalTokens: 0 } })).toEqual({ observed: true, latestTokens: 0, totalTokens: 0 })
  expect(latestCodexUsage(undefined)).toEqual({ observed: false })
})

// Fixture style mirrors PaneContainer.test.tsx's makeSession/makeContent
// builders: minimal objects carrying only the fields under test, cast to the
// imported types.

function makeTokenUsage(overrides: Record<string, unknown> = {}): CodingCliSession['tokenUsage'] {
  return {
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    totalTokens: 2,
    contextTokens: 96000,
    compactPercent: 47,
    compactThresholdTokens: 200000,
    ...overrides,
  } as CodingCliSession['tokenUsage']
}

function makeProjects(tokenUsage: CodingCliSession['tokenUsage'] = makeTokenUsage()): ProjectGroup[] {
  const session: CodingCliSession = {
    provider: 'claude',
    sessionId: 'abc',
    projectPath: '/repo/freshell',
    cwd: '/repo/freshell',
    lastActivityAt: 1,
    tokenUsage,
  }
  return [{ projectPath: '/repo/freshell', sessions: [session] }]
}

function projectsWith(mutateTokenUsage: (base: Record<string, unknown>) => Record<string, unknown>): ProjectGroup[] {
  const base = makeTokenUsage() as unknown as Record<string, unknown>
  return makeProjects(makeTokenUsage(mutateTokenUsage(base)))
}

function makeContent(overrides: Partial<FreshAgentPaneContent> = {}): FreshAgentPaneContent {
  return {
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    createRequestId: 'req-1',
    status: 'connected',
    ...overrides,
  }
}

describe('resolveFreshAgentContextUsage', () => {
  it('resolves percent + tokens from the indexed session via content.resumeSessionId', () => {
    const usage = resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'abc' }), undefined, makeProjects())
    expect(usage).toEqual({ percent: 47, contextTokens: 96000, thresholdTokens: 200000 })
  })

  it('returns null for a pane with only a live (non-durable) sessionId and no resume link', () => {
    expect(resolveFreshAgentContextUsage(makeContent({ sessionId: 'abc' }), undefined, makeProjects())).toBeNull()
  })

  it('resolves via the sessionRef tail when resumeSessionId was stripped (restored pane)', () => {
    const usage = resolveFreshAgentContextUsage(
      makeContent({ sessionRef: { provider: 'claude', sessionId: 'abc' } }),
      undefined,
      makeProjects(),
    )
    expect(usage?.percent).toBe(47)
  })

  it('ignores a sessionRef whose provider does not match the pane', () => {
    expect(
      resolveFreshAgentContextUsage(
        makeContent({ sessionRef: { provider: 'codex', sessionId: 'abc' } }),
        undefined,
        makeProjects(),
      ),
    ).toBeNull()
  })

  it('prefers getPreferredResumeSessionId(session) over content.resumeSessionId (canonical chain, matches PaneContainer)', () => {
    // historySessionId 'abc' IS indexed; resumeSessionId 'zzz' is NOT — the
    // session-preferred id must win.
    const session = { historySessionId: 'abc' } as FreshAgentSessionState
    const usage = resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'zzz' }), session, makeProjects())
    expect(usage?.percent).toBe(47)
  })

  it('returns null when the id chain points at nothing indexed', () => {
    expect(resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'nope' }), undefined, makeProjects())).toBeNull()
  })

  it('returns null when the indexed session has no compactPercent', () => {
    const projects = projectsWith((base) => ({ ...base, compactPercent: undefined }))
    expect(resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'abc' }), undefined, projects)).toBeNull()
  })

  it('returns null on partial records (missing contextTokens or compactThresholdTokens) — the meter/tooltip pair never degrades to "x% full" without exact tokens', () => {
    const noContext = projectsWith((base) => ({ ...base, contextTokens: undefined }))
    expect(resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'abc' }), undefined, noContext)).toBeNull()

    const noThreshold = projectsWith((base) => ({ ...base, compactThresholdTokens: undefined }))
    expect(resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'abc' }), undefined, noThreshold)).toBeNull()
  })

  it('returns null on non-finite values (NaN is not a percent)', () => {
    const nanPercent = projectsWith((base) => ({ ...base, compactPercent: Number.NaN }))
    expect(resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'abc' }), undefined, nanPercent)).toBeNull()

    const nanTokens = projectsWith((base) => ({ ...base, contextTokens: Number.NaN }))
    expect(resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'abc' }), undefined, nanTokens)).toBeNull()
  })

  it('clamps percent into 0–100 and rounds', () => {
    const over = projectsWith((base) => ({ ...base, compactPercent: 100.7 }))
    expect(resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'abc' }), undefined, over)?.percent).toBe(100)

    const under = projectsWith((base) => ({ ...base, compactPercent: -3 }))
    expect(resolveFreshAgentContextUsage(makeContent({ resumeSessionId: 'abc' }), undefined, under)?.percent).toBe(0)
  })
})

describe('guardContextUsageTokenSummary', () => {
  it('nulls undefined and partial records, resolves complete ones', () => {
    expect(guardContextUsageTokenSummary(undefined)).toBeNull()
    expect(guardContextUsageTokenSummary({ inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2 })).toBeNull()
    expect(guardContextUsageTokenSummary({
      inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2,
      contextTokens: 96000, compactPercent: 47, compactThresholdTokens: 200000,
    })).toEqual({ percent: 47, contextTokens: 96000, thresholdTokens: 200000 })
  })
})

describe('collectFreshAgentContextUsageKeys', () => {
  const layout = {
    type: 'leaf' as const,
    content: makeContent({ resumeSessionId: 'abc' }),
  }

  it('collects provider:sessionId keys for fresh-agent panes only', () => {
    const keys = collectFreshAgentContextUsageKeys({
      layouts: {
        'tab-1': layout as never,
        'tab-2': {
          type: 'leaf',
          content: { kind: 'terminal', mode: 'shell', createRequestId: 'r', status: 'running' } as never,
        },
        'tab-3': {
          type: 'leaf',
          // fresh-agent pane with no resolvable durable id → no key
          content: makeContent({ resumeSessionId: undefined }) as never,
        } as never,
      },
      freshAgentSessions: {},
    })
    expect(keys).toEqual(['claude:abc'])
  })

  it('prefers the live session record (preferred resume id) over the pane content chain when the pane is session-bound', () => {
    const liveDurableId = '5f4e3d2c-1b0a-4f5e-8d7c-6b5a4f3e2d1c'
    const boundLayout = {
      type: 'leaf' as const,
      content: makeContent({ resumeSessionId: 'abc', sessionId: 'abc' }),
    }
    const sessionKey = makeFreshAgentSessionKey({
      sessionId: 'abc',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    const keys = collectFreshAgentContextUsageKeys({
      layouts: { 'tab-1': boundLayout as never },
      freshAgentSessions: {
        [sessionKey]: {
          sessionId: 'abc',
          sessionType: 'freshclaude',
          provider: 'claude',
          cliSessionId: liveDurableId,
        } as never,
      },
    })
    expect(keys).toEqual([`claude:${liveDurableId}`])
  })

  it('returns an empty list with no panes', () => {
    expect(collectFreshAgentContextUsageKeys({ layouts: undefined, freshAgentSessions: undefined })).toEqual([])
  })
})
