import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  getFreshAgentModelCapabilities,
  refreshFreshAgentModelCapabilities,
  getFreshAgentThreadSnapshot,
  fetchSidebarSessionsSnapshot,
  getBootstrap,
  getMachines,
  createMachine,
  renameMachine,
  getRecoveryInventory,
  getSessionDirectoryPage,
  getTerminalDirectoryPage,
  searchSessions,
  searchTerminalView,
  setSessionMetadata,
  requestSessionHandoff,
  SessionHandoffErrorCodeSchema,
  SessionHandoffResultSchema,
  stopManagedRuntimeSoul,
  getManagedRuntimeInventory,
} from '@/lib/api'
import {
  RestoreStaleRevisionResponseSchema,
  SessionDirectoryQuerySchema,
  TerminalDirectoryQuerySchema,
} from '@shared/read-models'
import {
  codexContractSnapshot,
} from '../../../fixtures/fresh-agent/codex/contract-fixtures.js'
import lostFreshAgentInventory from '../../../fixtures/managed-runtime/lost-fresh-agent-inventory.json'

const mockFetch = vi.fn()
global.fetch = mockFetch

describe('managed runtime stop outcome', () => {
  beforeEach(() => mockFetch.mockReset())

  it.each(['verified_empty', 'termination_unconfirmed', 'blocked_ownership', 'backend_unavailable'])(
    'returns the authoritative %s outcome while allowing additive soul fields', async (outcome) => {
      mockFetch.mockResolvedValueOnce(mockJson({ outcome, soul: { soulId: 'persisted/soul', intentRevision: 9, freshAgentSessionId: 'retained-thread' } }))
      expect(await stopManagedRuntimeSoul('persisted/soul', 8, 'stop-request')).toEqual({ outcome, soul: { soulId: 'persisted/soul', intentRevision: 9 } })
      expect(mockFetch).toHaveBeenCalledWith('/api/runtime/souls/persisted%2Fsoul/stop', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ requestId: 'stop-request', expectedIntentRevision: 8 }),
      }))
    },
  )

  it.each([{}, { outcome: 'stopped' }, { outcome: null }])('rejects a successful HTTP response without a known cleanup outcome: %j', async (body) => {
    mockFetch.mockResolvedValueOnce(mockJson(body))
    await expect(stopManagedRuntimeSoul('soul', 8)).rejects.toThrow()
  })

  it.each([
    { outcome: 'verified_empty' }, { outcome: 'verified_empty', soul: {} },
    { outcome: 'verified_empty', soul: { soulId: 'soul', intentRevision: -1 } },
  ])('rejects a stop response without valid returned revision authority: %j', async (body) => {
    mockFetch.mockResolvedValueOnce(mockJson(body))
    await expect(stopManagedRuntimeSoul('soul', 8)).rejects.toThrow()
  })

  it('accepts the persisted lost Fresh Agent inventory serialized by the real Rust route', async () => {
    // Captured by restored_web_stops_persisted_lost_soul_only_after_verified_cleanup.
    mockFetch.mockResolvedValueOnce(mockJson(lostFreshAgentInventory))
    const inventory = await getManagedRuntimeInventory()
    expect(inventory.souls[0]).toMatchObject({
      freshAgentSessionId: 'fresh-retained-thread', freshAgentSessionType: 'freshopencode',
      freshAgentRuntimeVariant: 'opencode', nativeSessionId: 'retained-thread',
      desiredState: 'stopped', recoveryState: 'lost', cleanupState: 'termination_unconfirmed',
    })
  })
})

function mockJson(value: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(value)),
  }
}

function mockJsonResponse(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? 'Service Unavailable' : 'Error',
    text: () => Promise.resolve(JSON.stringify(value)),
  }
}

function mockResponseWithHeaders(status: number, value: unknown, headers: Record<string, string>) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Too Many Requests',
    text: async () => JSON.stringify(value),
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
  })
}

function successCapabilityResponse(
  sessionType: string,
  runtimeProvider: 'claude' | 'codex' | 'opencode',
) {
  return {
    ok: true,
    sessionType,
    runtimeProvider,
    status: 'fresh',
    fetchedAt: 1_234,
    models: [
      {
        id: `${runtimeProvider}-opus`,
        displayName: `${runtimeProvider} Opus`,
        provider: runtimeProvider,
        supportsEffort: true,
        supportedEffortLevels: ['high'],
        supportsAdaptiveThinking: true,
      },
    ],
  }
}

describe('visible-first read-model helpers', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('getBootstrap targets only /api/bootstrap', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({ shell: { authenticated: true } }))

    await getBootstrap()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/bootstrap',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    )
  })

  it('accepts numeric machine timestamps from server-owned routes and scopes recovery to the selected machine', async () => {
    const machine = {
      id: 'machine-desktop',
      label: 'DANDESKTOP',
      createdAt: 1_789_171_200_000,
      lastSeenAt: 1_789_171_200_000,
    }
    mockFetch
      .mockResolvedValueOnce(mockJson({ machines: [machine] }))
      .mockResolvedValueOnce(mockJson({ machine }))
      .mockResolvedValueOnce(mockJson({ machine: { ...machine, label: 'Dan desktop' } }))
      .mockResolvedValueOnce(mockJson({
        recoverable: false,
        contentId: 'machine-desktop:empty',
        device: null,
        otherDevices: [],
        ledgerOnly: [],
      }))

    await expect(getMachines()).resolves.toEqual([machine])
    await expect(createMachine('DANDESKTOP')).resolves.toEqual(machine)
    await expect(renameMachine(machine.id, 'Dan desktop')).resolves.toEqual({ ...machine, label: 'Dan desktop' })
    await getRecoveryInventory('client-window-1', 123.6, { machineId: machine.id })

    expect(mockFetch).toHaveBeenNthCalledWith(1, '/api/machines', expect.objectContaining({
      headers: expect.any(Headers),
    }))
    expect(mockFetch).toHaveBeenNthCalledWith(2, '/api/machines', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ label: 'DANDESKTOP' }),
      headers: expect.any(Headers),
    }))
    expect(mockFetch).toHaveBeenNthCalledWith(3, '/api/machines/machine-desktop', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ label: 'Dan desktop' }),
      headers: expect.any(Headers),
    }))
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      '/api/recovery/inventory?clientInstanceId=client-window-1&bootAgoMs=124&machineId=machine-desktop',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('getSessionDirectoryPage encodes query, cursor, priority, revision, and limit while forwarding AbortSignal', async () => {
    const signal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(mockJson({ items: [] }))

    await getSessionDirectoryPage(
      {
        query: 'alpha',
        cursor: 'cursor-1',
        priority: 'visible',
        revision: 4,
        limit: 10,
      },
      { signal },
    )

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/session-directory?query=alpha&cursor=cursor-1&priority=visible&revision=4&limit=10',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
  })

  it('getTerminalDirectoryPage encodes cursor, priority, revision, and limit consistently', async () => {
    const signal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(mockJson({ items: [] }))

    await getTerminalDirectoryPage(
      {
        cursor: 'cursor-2',
        priority: 'background',
        revision: 6,
        limit: 5,
      },
      { signal },
    )

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/terminals?cursor=cursor-2&priority=background&revision=6&limit=5',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
  })

  it('preserves typed capability errors from non-2xx capability reads and refreshes', async () => {
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse(503, {
        ok: false,
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        status: 'unavailable',
        models: [],
        error: {
          code: 'CAPABILITY_PROBE_FAILED',
          message: 'Probe failed upstream',
          retryable: true,
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse(503, {
        ok: false,
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        status: 'unavailable',
        models: [],
        error: {
          code: 'CAPABILITY_PAYLOAD_INVALID',
          message: 'Capability payload invalid',
          retryable: false,
        },
      }))

    await expect(getFreshAgentModelCapabilities('freshclaude')).resolves.toEqual({
      ok: false,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'unavailable',
      models: [],
      error: {
        code: 'CAPABILITY_PROBE_FAILED',
        message: 'Probe failed upstream',
        retryable: true,
      },
    })
    await expect(refreshFreshAgentModelCapabilities('freshclaude')).resolves.toEqual({
      ok: false,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'unavailable',
      models: [],
      error: {
        code: 'CAPABILITY_PAYLOAD_INVALID',
        message: 'Capability payload invalid',
        retryable: false,
      },
    })
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      '/api/fresh-agent/model-capabilities/freshclaude',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      '/api/fresh-agent/model-capabilities/freshclaude/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    )
  })

  it('passes cwd when fetching Freshopencode model capabilities', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(successCapabilityResponse('freshopencode', 'opencode')))

    await getFreshAgentModelCapabilities('freshopencode', { cwd: '/repo/project-a' })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/fresh-agent/model-capabilities/freshopencode?cwd=%2Frepo%2Fproject-a',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('fresh-agent snapshot helper targets the fresh-agent route family and pins provider and revision', async () => {
    const signal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(mockJson(codexContractSnapshot))

    await getFreshAgentThreadSnapshot('freshcodex', 'codex', 'thread-1', { revision: 7, cwd: '/repo/worktree', signal })

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      '/api/fresh-agent/threads/freshcodex/codex/thread-1?revision=7&cwd=%2Frepo%2Fworktree',
      expect.objectContaining({ signal, headers: expect.any(Headers) }),
    )
  })

  it('reads managed history from the exact soul after web restart without an alias lookup', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(codexContractSnapshot))
    await getFreshAgentThreadSnapshot('freshcodex', 'codex', 'presentation-alias', { soulId: 'retained-soul' })
    expect(mockFetch).toHaveBeenCalledWith('/api/runtime/souls/retained-soul/history', expect.any(Object))
  })

  it('appends the snapshot trigger to the fresh-agent snapshot query when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(codexContractSnapshot))

    await getFreshAgentThreadSnapshot('freshcodex', 'codex', 'thread-1', { revision: 7, trigger: 'poll' })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/fresh-agent/threads/freshcodex/codex/thread-1?revision=7&trigger=poll',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('shares the stale-revision error contract from read-models', () => {
    expect(RestoreStaleRevisionResponseSchema.parse({
      error: 'Stale restore revision',
      code: 'RESTORE_STALE_REVISION',
      currentRevision: 13,
    })).toEqual({
      error: 'Stale restore revision',
      code: 'RESTORE_STALE_REVISION',
      currentRevision: 13,
    })
  })

  it('terminal search helper forwards AbortSignal', async () => {
    const signal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(mockJson({ matches: [] }))
    await searchTerminalView('term-1', { query: 'error', cursor: 'hit-2', limit: 25 }, { signal })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/terminals/term-1/search?query=error&cursor=hit-2&limit=25',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
  })

  it('keeps critical out of public client directory query schemas', () => {
    expect(() =>
      SessionDirectoryQuerySchema.parse({
        priority: 'critical',
      }),
    ).toThrow()

    expect(() =>
      TerminalDirectoryQuerySchema.parse({
        priority: 'critical',
      }),
    ).toThrow()
  })

  it('preserves sidebar visibility metadata when grouping session-directory items', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-1',
        provider: 'codex',
        projectPath: '/tmp/project-alpha',
        title: 'Hidden session',
        sessionType: 'codex',
        firstUserMessage: '__AUTO__ worktree cleanup',
        isSubagent: true,
        isNonInteractive: true,
        isRunning: false,
        lastActivityAt: 1_000,
      }],
      nextCursor: null,
      revision: 1,
    }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(response.projects).toEqual([
      expect.objectContaining({
        projectPath: '/tmp/project-alpha',
        sessions: [
          expect.objectContaining({
            sessionId: 'session-1',
            lastActivityAt: 1_000,
            sessionType: 'codex',
            firstUserMessage: '__AUTO__ worktree cleanup',
            isSubagent: true,
            isNonInteractive: true,
          }),
        ],
      }),
    ])
  })

  it('STATUS-STRIP: forwards includeKeys and maps tokenUsage onto window sessions + extras', async () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      totalTokens: 2,
      contextTokens: 96000,
      compactPercent: 47,
      compactThresholdTokens: 200000,
    }
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-windowed',
        provider: 'claude',
        projectPath: '/tmp/project-alpha',
        isRunning: false,
        lastActivityAt: 1_000,
        tokenUsage: usage,
      }],
      nextCursor: null,
      revision: 1,
      contextUsageExtras: [
        { provider: 'claude', sessionId: 'session-excluded', tokenUsage: usage },
      ],
    }))

    const response = await fetchSidebarSessionsSnapshot({ includeKeys: ['claude:session-excluded'] })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('includeKeys=claude%3Asession-excluded')
    expect(response.projects[0]?.sessions[0]?.tokenUsage).toEqual(usage)
    expect(response.contextUsageExtras).toEqual([
      { provider: 'claude', sessionId: 'session-excluded', tokenUsage: usage },
    ])
  })

  it('preserves a quarantined identity-collision state in sidebar snapshots', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 1,
      partial: true,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 1,
        duplicateItemCount: 2,
      },
    }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(response).toMatchObject({
      partial: true,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 1,
        duplicateItemCount: 2,
      },
    })
  })

  it('preserves session-directory running state in sidebar snapshots', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'codex-live-1',
        provider: 'codex',
        projectPath: '/repo/live',
        title: 'Live Codex',
        sessionType: 'codex',
        isRunning: true,
        runningTerminalId: 'term-codex-1',
        lastActivityAt: 1_700,
      }],
      nextCursor: null,
      revision: 1_700,
    }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(response.projects[0].sessions[0]).toMatchObject({
      provider: 'codex',
      sessionId: 'codex-live-1',
      isRunning: true,
      runningTerminalId: 'term-codex-1',
    })
  })

  it('preserves live-terminal-only state in sidebar snapshots', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'terminal:term-opencode-live',
        provider: 'opencode',
        projectPath: '/repo/live',
        title: 'OpenCode',
        sessionType: 'opencode',
        isRunning: true,
        runningTerminalId: 'term-opencode-live',
        liveTerminalOnly: true,
        lastActivityAt: 1_700,
      }],
      nextCursor: null,
      revision: 1_700,
    }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(response.projects[0].sessions[0]).toMatchObject({
      provider: 'opencode',
      sessionId: 'terminal:term-opencode-live',
      isRunning: true,
      runningTerminalId: 'term-opencode-live',
      liveTerminalOnly: true,
    })
  })

  it('encodes session-directory cursors with lastActivityAt', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await fetchSidebarSessionsSnapshot({
      before: 1_000,
      beforeId: 'codex:session-1',
    })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    const cursor = new URL(`http://localhost${requestUrl}`).searchParams.get('cursor')
    expect(cursor).toBeTruthy()
    expect(JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8'))).toEqual({
      lastActivityAt: 1_000,
      key: 'codex:session-1',
    })
  })

  it('preserves search visibility metadata from session-directory items', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-2',
        provider: 'codex',
        projectPath: '/tmp/project-beta',
        title: 'Queued session',
        matchedIn: 'title',
        sessionType: 'codex',
        firstUserMessage: 'queued task',
        isSubagent: false,
        isNonInteractive: true,
        isRunning: false,
        lastActivityAt: 2_000,
      }],
      nextCursor: null,
      revision: 2,
    }))

    const response = await searchSessions({ query: 'queued' })

    expect(response.results).toEqual([
      expect.objectContaining({
        sessionId: 'session-2',
        lastActivityAt: 2_000,
        sessionType: 'codex',
        firstUserMessage: 'queued task',
        isSubagent: false,
        isNonInteractive: true,
      }),
    ])
  })

  it('preserves session-directory running state in search results', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'ses_live_opencode',
        provider: 'opencode',
        projectPath: '/repo/live',
        title: 'Live OpenCode',
        matchedIn: 'title',
        isRunning: true,
        runningTerminalId: 'term-opencode-1',
        lastActivityAt: 1_800,
      }],
      nextCursor: null,
      revision: 1_800,
    }))

    const response = await searchSessions({ query: 'live', tier: 'title' })

    expect(response.results[0]).toMatchObject({
      provider: 'opencode',
      sessionId: 'ses_live_opencode',
      isRunning: true,
      runningTerminalId: 'term-opencode-1',
    })
  })

  it('preserves live-terminal-only state in search results', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'terminal:term-opencode-live',
        provider: 'opencode',
        projectPath: '/repo/live',
        title: 'OpenCode',
        matchedIn: 'title',
        isRunning: true,
        runningTerminalId: 'term-opencode-live',
        liveTerminalOnly: true,
        lastActivityAt: 1_800,
      }],
      nextCursor: null,
      revision: 1_800,
    }))

    const response = await searchSessions({ query: 'OpenCode', tier: 'title' })

    expect(response.results[0]).toMatchObject({
      provider: 'opencode',
      sessionId: 'terminal:term-opencode-live',
      isRunning: true,
      runningTerminalId: 'term-opencode-live',
      liveTerminalOnly: true,
    })
  })

  it('forwards title-override provenance from a raw page item into grouped sidebar window sessions', async () => {
    // b5fb: groupDirectoryItemsAsProjects is an explicit ALLOWLIST mapper —
    // deleting one of its provenance spreads silently drops reset-flow data
    // before Redux ever sees it. Pin all three fields through from the raw
    // server payload, mirroring the STATUS-STRIP tokenUsage pin above; a
    // plain control item in the same payload proves absence stays absence.
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-provenance',
        provider: 'claude',
        projectPath: '/tmp/project-alpha',
        title: 'Accidental pane label',
        isRunning: false,
        lastActivityAt: 1_000,
        titleOverridden: true,
        providerTitle: 'First prompt title',
        titleOverrideSource: 'user',
      }, {
        sessionId: 'session-plain',
        provider: 'claude',
        projectPath: '/tmp/project-alpha',
        title: 'Plain title',
        isRunning: false,
        lastActivityAt: 900,
      }],
      nextCursor: null,
      revision: 1,
    }))

    const response = await fetchSidebarSessionsSnapshot()

    const sessions = response.projects[0]?.sessions ?? []
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-provenance',
      title: 'Accidental pane label',
      titleOverridden: true,
      providerTitle: 'First prompt title',
      titleOverrideSource: 'user',
    })
    const plain = sessions.find((s: { sessionId: string }) => s.sessionId === 'session-plain')
    expect(plain).toBeTruthy()
    expect(plain).not.toHaveProperty('titleOverridden')
    expect(plain).not.toHaveProperty('providerTitle')
    expect(plain).not.toHaveProperty('titleOverrideSource')
  })

  it('forwards the unified-names projection (nameRef + sessionName) from a raw page item into grouped sidebar window sessions', async () => {
    // Unified agent names (Task 2): the server merges the canonical
    // record's ref + current name onto every directory row additively.
    // The sidebar mapper's allowlist must forward both — a fresh second
    // client's redux cache bootstraps FROM these refs (its ready-time
    // batch read races its own state hydration), and dropping the ref
    // strands the cache cold for sessions it never renamed live.
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-named',
        provider: 'claude',
        projectPath: '/tmp/project-alpha',
        title: 'Provider title',
        isRunning: false,
        lastActivityAt: 1_000,
        nameRef: { kind: 'session', provider: 'claude', sessionId: 'session-named' },
        sessionName: 'Pre-restart pending name',
      }, {
        sessionId: 'session-plain',
        provider: 'claude',
        projectPath: '/tmp/project-alpha',
        title: 'Plain title',
        isRunning: false,
        lastActivityAt: 900,
      }],
      nextCursor: null,
      revision: 1,
    }))

    const response = await fetchSidebarSessionsSnapshot()

    const sessions = response.projects[0]?.sessions ?? []
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-named',
      nameRef: { kind: 'session', provider: 'claude', sessionId: 'session-named' },
      sessionName: 'Pre-restart pending name',
    })
    const plain = sessions.find((s: { sessionId: string }) => s.sessionId === 'session-plain')
    expect(plain).toBeTruthy()
    expect(plain).not.toHaveProperty('nameRef')
    expect(plain).not.toHaveProperty('sessionName')
  })

  it('retries a rate-limited sidebar snapshot fetch (the post-restart boot burst) and still returns the page', async () => {
    // A fresh page's boot burst (settings, sessions, terminal directory,
    // the naming bootstrap) races the ONE shared rate-limit bucket right
    // after a server restart: a 429 on the SIDEBAR snapshot left the
    // sidebar permanently empty (the fetch had no retry and nothing
    // re-triggers it until the next invalidation). Retry it, bounded.
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse(429, { error: 'rate limited' }))
      .mockResolvedValueOnce(mockJson({
        items: [{
          sessionId: 'session-boot',
          provider: 'claude',
          projectPath: '/tmp/project-alpha',
          title: 'Boot name',
          isRunning: false,
          lastActivityAt: 1_000,
        }],
        nextCursor: null,
        revision: 1,
      }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const sessions = response.projects[0]?.sessions ?? []
    expect(sessions[0]).toMatchObject({ sessionId: 'session-boot', title: 'Boot name' })
  })

  it('forwards title-override provenance from a raw page item into search results', async () => {
    // b5fb: searchSessions' results map is the second b5fb allowlist site —
    // same pin as the sidebar mapper, one layer up (query page → SearchResponse).
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-search-provenance',
        provider: 'codex',
        projectPath: '/tmp/project-beta',
        title: 'Accidental pane label',
        matchedIn: 'title',
        isRunning: false,
        lastActivityAt: 2_000,
        titleOverridden: true,
        providerTitle: 'First prompt title',
        titleOverrideSource: 'first-message',
      }, {
        sessionId: 'session-search-plain',
        provider: 'codex',
        projectPath: '/tmp/project-beta',
        title: 'Plain title',
        matchedIn: 'title',
        isRunning: false,
        lastActivityAt: 1_900,
      }],
      nextCursor: null,
      revision: 2,
    }))

    const response = await searchSessions({ query: 'accidental' })

    const provenance = response.results.find((r) => r.sessionId === 'session-search-provenance')
    expect(provenance).toMatchObject({
      title: 'Accidental pane label',
      titleOverridden: true,
      providerTitle: 'First prompt title',
      titleOverrideSource: 'first-message',
    })
    const plain = response.results.find((r) => r.sessionId === 'session-search-plain')
    expect(plain).toBeTruthy()
    expect(plain).not.toHaveProperty('titleOverridden')
    expect(plain).not.toHaveProperty('providerTitle')
    expect(plain).not.toHaveProperty('titleOverrideSource')
  })
})

describe('searchSessions tier forwarding', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('includes tier in session directory URL when not title', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await searchSessions({ query: 'test', tier: 'fullText' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).toContain('tier=fullText')
  })

  it('omits tier from URL when tier is title (the default)', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await searchSessions({ query: 'test', tier: 'title' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).not.toContain('tier=')
  })

  it('defaults tier to title when not specified', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await searchSessions({ query: 'test' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).not.toContain('tier=')
  })

  it('includes tier=userMessages in URL', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await searchSessions({ query: 'test', tier: 'userMessages' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).toContain('tier=userMessages')
  })

  it('forwards partial and partialReason from server response', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-1',
        provider: 'claude',
        projectPath: '/repo',
        title: 'Result',
        matchedIn: 'userMessage',
        snippet: 'found it',
        isRunning: false,
        lastActivityAt: 1000,
      }],
      nextCursor: null,
      revision: 1,
      partial: true,
      partialReason: 'budget',
    }))

    const response = await searchSessions({ query: 'test', tier: 'userMessages' })

    expect(response.partial).toBe(true)
    expect(response.partialReason).toBe('budget')
  })

  it('forwards a quarantined identity-collision state without exposing session ids', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 1,
      partial: true,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 2,
        duplicateItemCount: 4,
      },
    }))

    const response = await searchSessions({ query: 'test', tier: 'title' })

    expect(response).toMatchObject({
      partial: true,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 2,
        duplicateItemCount: 4,
      },
    })
  })

  it('does not include partial fields when server omits them', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    const response = await searchSessions({ query: 'test', tier: 'userMessages' })

    expect(response.partial).toBeUndefined()
    expect(response.partialReason).toBeUndefined()
  })
})

describe('searchSessions cursor pagination', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('surfaces nextCursor and hasMore=true when the server returns a non-null nextCursor', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-42',
        provider: 'claude',
        projectPath: '/repo',
        title: 'Match 42',
        matchedIn: 'title',
        isRunning: false,
        lastActivityAt: 4_200,
      }],
      nextCursor: 'cursor-page-2',
      revision: 7,
    }))

    const response = await searchSessions({ query: 'widget' })

    expect(response.nextCursor).toBe('cursor-page-2')
    expect(response.hasMore).toBe(true)
  })

  it('reports hasMore=false and a null nextCursor when the server has no further pages', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 7,
    }))

    const response = await searchSessions({ query: 'widget' })

    expect(response.nextCursor).toBeNull()
    expect(response.hasMore).toBe(false)
  })

  it('forwards the cursor to the session-directory request when paginating a search', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 7,
    }))

    await searchSessions({ query: 'widget', cursor: 'cursor-page-2' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).toContain('cursor=cursor-page-2')
  })
})

describe('setSessionMetadata()', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('POSTs to /api/session-metadata with provider, sessionId, sessionType, and explicit source by default', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('claude', 'sess-abc', 'freshclaude')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/session-metadata',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider: 'claude',
          sessionId: 'sess-abc',
          sessionType: 'freshclaude',
          sessionTypeSource: 'explicit',
        }),
      }),
    )
  })

  it('POSTs materialized session metadata source when requested', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('opencode', 'ses_real_1', 'freshopencode', {
      sessionTypeSource: 'materialized',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/session-metadata',
      expect.objectContaining({
        body: JSON.stringify({
          provider: 'opencode',
          sessionId: 'ses_real_1',
          sessionType: 'freshopencode',
          sessionTypeSource: 'materialized',
        }),
      }),
    )
  })

  it('sends auth token in headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('claude', 'sess-abc', 'freshclaude')

    const call = mockFetch.mock.calls[0]
    const headers = call[1].headers as Headers
    expect(headers.get('x-auth-token')).toBe('test-token')
  })

  it('sets Content-Type to application/json', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('claude', 'sess-abc', 'freshclaude')

    const call = mockFetch.mock.calls[0]
    const headers = call[1].headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
  })
})

describe('api error mapping', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('prefers agent-api message fields on error responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.resolve(JSON.stringify({ status: 'error', message: 'name required' })),
    })

    await expect(api.patch('/api/panes/pane-1', { name: '' })).rejects.toMatchObject({
      status: 400,
      message: 'name required',
    })
  })

  it('carries retryAfterMs from a 429 Retry-After seconds header', async () => {
    mockResponseWithHeaders(429, { error: 'Too many requests' }, { 'retry-after': '17' })
    await expect(api.get('/api/fresh-agent/threads/freshopencode/opencode/ses_1')).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 17_000,
    })
  })

  it('leaves retryAfterMs undefined when the header is absent', async () => {
    mockResponseWithHeaders(429, { error: 'Too many requests' }, {})
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 429, retryAfterMs: undefined })
  })

  it('parses an HTTP-date Retry-After into a forward delta', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString()
    mockResponseWithHeaders(429, { error: 'Too many requests' }, { 'retry-after': future })
    const err = await api.get('/api/x').catch((e) => e)
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBeGreaterThan(20_000)
    expect(err.retryAfterMs).toBeLessThanOrEqual(31_000)
  })

  it('locks the delete contract the failure-surfacing UI relies on: a 404 JSON body rejects as an ApiError', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(404, { error: 'Not found' }))

    await expect(api.delete('/api/sessions/claude%3Amissing')).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
  })
})

describe('requestSessionHandoff()', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('posts the handoff body and parses a committed terminal owner', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      ok: true,
      operationId: 'handoff-1',
      generation: 2,
      owner: { kind: 'terminal', terminalId: 't-77', mode: 'codex' },
    }))

    const result = await requestSessionHandoff({
      provider: 'codex',
      sessionId: '019ec8c9-2b12-7001-a11d-e2e089860320',
      targetKind: 'terminal',
      mode: 'codex',
      cwd: '/repo',
      tabId: 'tab-1',
      paneId: 'pane-1',
      observedEpoch: 1,
      observedGeneration: 1,
      deviceId: 'device-a',
    })

    expect(result).toEqual({
      ok: true,
      operationId: 'handoff-1',
      generation: 2,
      owner: { kind: 'terminal', terminalId: 't-77', mode: 'codex' },
    })
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions/handoff',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider: 'codex',
          sessionId: '019ec8c9-2b12-7001-a11d-e2e089860320',
          targetKind: 'terminal',
          mode: 'codex',
          cwd: '/repo',
          tabId: 'tab-1',
          paneId: 'pane-1',
          observedEpoch: 1,
          observedGeneration: 1,
          deviceId: 'device-a',
        }),
      }),
    )
  })

  it('parses a committed fresh-agent owner', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      ok: true,
      operationId: 'handoff-2',
      generation: 3,
      owner: { kind: 'fresh-agent', sessionId: 'sid-k', sessionType: 'kilroy', provider: 'claude' },
    }))

    const result = await requestSessionHandoff({
      provider: 'claude',
      sessionId: 'sid-k',
      targetKind: 'fresh-agent',
      sessionType: 'kilroy',
    })

    expect(result).toEqual({
      ok: true,
      operationId: 'handoff-2',
      generation: 3,
      owner: { kind: 'fresh-agent', sessionId: 'sid-k', sessionType: 'kilroy', provider: 'claude' },
    })
  })

  // b8ke delta round-3 F4: the REAL server frame for the INITIAL
  // PLATFORM_LIMITED reap failure (session_handoff.rs's typed_failure
  // serializes exactly this shape) must PARSE — pre-fix the schema
  // rejected the code, requestSessionHandoff rethrew, and the caller
  // converted it to generic HANDOFF_REQUEST_FAILED, making the Banner's
  // Force-clear action unreachable through the real API path. This is
  // the integration path (the emitted frame body through the schema),
  // not a directly-constructed enum value.
  it('parses the server-emitted initial PLATFORM_LIMITED failure frame (the integration path)', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(409, {
      ok: false,
      error: {
        code: 'PLATFORM_LIMITED',
        message: "the prior runtime's teardown cannot confirm the descendant tree on this platform; the session stays fenced (no new writer can start) and remains recoverable",
        retryable: true,
        ownerGeneration: 6,
      },
    }))

    const result = await requestSessionHandoff({
      provider: 'claude',
      sessionId: 'sid-pl',
      targetKind: 'terminal',
      mode: 'claude',
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'PLATFORM_LIMITED',
        message: "the prior runtime's teardown cannot confirm the descendant tree on this platform; the session stays fenced (no new writer can start) and remains recoverable",
        retryable: true,
        ownerGeneration: 6,
      },
    })
  })

  // b8ke delta round-3 F5: the StaleStart-fence ordinary-retry refusal
  // (the acknowledged force-clear is the only recovery) parses through
  // the same integration path.
  // b8ke e3r3 F5/F6 — THE PARSER-BOUNDARY CLASS-KILLER: every failure
  // code and cleared value the SERVER can emit MUST be accepted by the
  // client schemas. This enumeration is the LOCKED CONTRACT LIST —
  // mirroring session_handoff.rs's complete typed_failure + cleared-label
  // set. Adding a server-emitted code or label REQUIRES updating this list
  // and the schemas in the SAME commit; a miss fails here loudly (the
  // pre-e3r3 class: SESSION_METADATA_WRITE_FAILED rejected by the schema
  // and the cleared 'stale-start-fence' threw during parse — the typed
  // recoverable results were lost at the parser boundary).
  it('accepts EVERY server-emitted handoff failure code (the locked contract list)', () => {
    const SERVER_EMITTED_FAILURE_CODES = [
      'BAD_REQUEST',
      'STALE_GENERATION',
      'SESSION_FENCED',
      'HANDOFF_IN_PROGRESS',
      'REAP_TIMEOUT',
      'PLATFORM_LIMITED',
      'PLATFORM_LIMITED_PRECHECK',
      'PLATFORM_LIMITED_FENCED',
      'TARGET_SPAWN_FAILED',
      'SESSION_METADATA_WRITE_FAILED',
      'STALE_START_FENCED',
      'STALE_STOP_FENCED',
      // b8ke ext r28 F2: the unacknowledged start against a
      // CLEARED-UNVERIFIED key (the r16-F4 clear's typed refusal after an
      // ordinary retry on the cleared fence).
      'CLEARED_UNVERIFIED_FENCED',
      // b8ke ext r34 F3: the typed 400 for a half-supplied observed
      // (epoch, generation) fence pair — the server's documented
      // wire_fence refusal (session_handoff.rs), parsed as the typed
      // error instead of the generic HANDOFF_REQUEST_FAILED.
      'INVALID_FENCE',
    ] as const
    for (const code of SERVER_EMITTED_FAILURE_CODES) {
      expect(SessionHandoffErrorCodeSchema.safeParse(code).success, code).toBe(true)
    }
    // The failure frame with each code parses through the RESULT schema.
    for (const code of SERVER_EMITTED_FAILURE_CODES) {
      const parsed = SessionHandoffResultSchema.safeParse({
        ok: false,
        error: {
          code,
          message: `typed ${code}`,
          retryable: true,
          ownerGeneration: 2,
        },
      })
      expect(parsed.success, code).toBe(true)
    }
  })

  it('accepts EVERY server-emitted cleared label (the force-clear result)', () => {
    // b8ke ext r28 F2: the r25 server change made the acknowledged
    // force-clear accept the STALE-reason fences — the server now emits
    // all three typed cleared labels (the pre-r28 closed literal was the
    // e3r4 DESIGN RECONCILIATION's PlatformLimited-only set, which the
    // r25 repair made stale: a successful stale-fence clear failed the
    // client parse and downgraded to a generic handoff failure).
    const SERVER_EMITTED_CLEARED_LABELS = [
      'platform-limited-fence',
      'stale-start-fence',
      'stale-stop-fence',
    ] as const
    for (const cleared of SERVER_EMITTED_CLEARED_LABELS) {
      const parsed = SessionHandoffResultSchema.safeParse({
        ok: true,
        cleared,
        operationId: 'op-clear',
        generation: 3,
      })
      expect(parsed.success, cleared).toBe(true)
    }
  })

  // b8ke ext r34 F3: the typed 400 for a HALF-SUPPLIED observed fence
  // pair parses as the typed INVALID_FENCE error — never the generic
  // HANDOFF_REQUEST_FAILED ("could not reach the server") diagnostic
  // the malformed-caller conversion produced pre-r34.
  it('parses the server-emitted INVALID_FENCE 400 as the typed error', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(400, {
      ok: false,
      error: {
        code: 'INVALID_FENCE',
        message: 'observedEpoch and observedGeneration must be sent together — a half-fence is invalid',
        retryable: false,
      },
    }))

    const result = await requestSessionHandoff({
      provider: 'codex',
      sessionId: 'sid-half-fence',
      targetKind: 'terminal',
      mode: 'codex',
      observedEpoch: 3,
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_FENCE',
        message: 'observedEpoch and observedGeneration must be sent together — a half-fence is invalid',
        retryable: false,
      },
    })
  })

  it('parses the server-emitted STALE_START_FENCED refusal frame', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(409, {
      ok: false,
      error: {
        code: 'STALE_START_FENCED',
        message: 'the session is fenced pending recovery: the prior runtime\u0027s death could not be confirmed (a stale start left it unconfirmable). Retry with the acknowledged force-clear (acknowledgePlatformLimitedRisk: true) to release the fence, accepting that the unconfirmed runtime\u0027s processes may remain.',
        retryable: true,
        ownerGeneration: 9,
      },
    }))

    const result = await requestSessionHandoff({
      provider: 'claude',
      sessionId: 'sid-ss',
      targetKind: 'terminal',
      mode: 'claude',
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'STALE_START_FENCED',
        message: 'the session is fenced pending recovery: the prior runtime\u0027s death could not be confirmed (a stale start left it unconfirmable). Retry with the acknowledged force-clear (acknowledgePlatformLimitedRisk: true) to release the fence, accepting that the unconfirmed runtime\u0027s processes may remain.',
        retryable: true,
        ownerGeneration: 9,
      },
    })
  })

  // b8ke ext r28 F2: the r25 server's stale-fence acknowledged force-clear
  // answers the TYPED clear with the stale-reason labels — pre-r28 the
  // closed literal rejected them, requestSessionHandoff THREW, and the
  // caller downgraded the successful clear to HANDOFF_REQUEST_FAILED.
  it('parses the server-emitted stale-stop-fence cleared result (the acknowledged force-clear)', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: true,
      cleared: 'stale-stop-fence',
      operationId: 'op-clear-ss',
      generation: 7,
    }))

    const result = await requestSessionHandoff({
      provider: 'claude',
      sessionId: 'sid-clear',
      targetKind: 'terminal',
      mode: 'claude',
      acknowledgePlatformLimitedRisk: true,
    })

    expect(result).toEqual({
      ok: true,
      cleared: 'stale-stop-fence',
      operationId: 'op-clear-ss',
      generation: 7,
      shutdownConfirmed: false,
    })
  })

  // b8ke ext r28 F2: the unacknowledged start against a CLEARED-UNVERIFIED
  // key answers the typed refusal — the browser's acknowledged-start flow
  // depends on the code parsing.
  it('parses the server-emitted CLEARED_UNVERIFIED_FENCED refusal frame', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(409, {
      ok: false,
      error: {
        code: 'CLEARED_UNVERIFIED_FENCED',
        message: 'the session sits in the cleared-unverified state: the prior runtime\'s descendant processes were never confirmed dead. The prior clear is not permission to start a writer — retry with the acknowledged risk (acknowledgePlatformLimitedRisk: true; the pane\'s start-again action carries it).',
        retryable: true,
        ownerGeneration: 4,
      },
    }))

    const result = await requestSessionHandoff({
      provider: 'claude',
      sessionId: 'sid-cu',
      targetKind: 'terminal',
      mode: 'claude',
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CLEARED_UNVERIFIED_FENCED',
        message: 'the session sits in the cleared-unverified state: the prior runtime\'s descendant processes were never confirmed dead. The prior clear is not permission to start a writer — retry with the acknowledged risk (acknowledgePlatformLimitedRisk: true; the pane\'s start-again action carries it).',
        retryable: true,
        ownerGeneration: 4,
      },
    })
  })

  it('surfaces the typed failure body of a 409 conflict as the failure arm instead of throwing', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(409, {
      ok: false,
      error: {
        code: 'REAP_TIMEOUT',
        message: 'the prior runtime did not confirm its exit in time',
        retryable: true,
        ownerGeneration: 4,
      },
    }))

    const result = await requestSessionHandoff({
      provider: 'codex',
      sessionId: 'sid-x',
      targetKind: 'terminal',
      mode: 'codex',
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'REAP_TIMEOUT',
        message: 'the prior runtime did not confirm its exit in time',
        retryable: true,
        ownerGeneration: 4,
      },
    })
  })

  it('parses the stale-generation failure with its owner generation', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(409, {
      ok: false,
      error: {
        code: 'STALE_GENERATION',
        message: 'observed ownership fence is stale; refresh and retry',
        retryable: false,
        ownerKind: 'terminal',
        ownerGeneration: 9,
      },
    }))

    const result = await requestSessionHandoff({
      provider: 'claude',
      sessionId: 'sid-s',
      targetKind: 'fresh-agent',
      sessionType: 'freshclaude',
      observedEpoch: 1,
      observedGeneration: 5,
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'STALE_GENERATION',
        message: 'observed ownership fence is stale; refresh and retry',
        retryable: false,
        ownerKind: 'terminal',
        ownerGeneration: 9,
      },
    })
  })

  it('rejects when a non-2xx body is not the typed failure shape', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(500, { error: 'boom' }))

    await expect(requestSessionHandoff({
      provider: 'codex',
      sessionId: 'sid-x',
      targetKind: 'terminal',
      mode: 'codex',
    })).rejects.toMatchObject({ status: 500 })
  })

  it('rejects a 2xx body that matches neither arm of the result union', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({ hello: 'world' }))

    await expect(requestSessionHandoff({
      provider: 'codex',
      sessionId: 'sid-x',
      targetKind: 'terminal',
      mode: 'codex',
    })).rejects.toThrow()
  })
})
