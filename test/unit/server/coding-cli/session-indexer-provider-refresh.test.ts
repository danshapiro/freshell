// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodingCliSessionIndexer } from '../../../../server/coding-cli/session-indexer.js'
import type { CodingCliProvider } from '../../../../server/coding-cli/provider.js'

vi.mock('../../../../server/config-store', () => ({
  configStore: {
    getProjectColors: vi.fn().mockResolvedValue({}),
    snapshot: vi.fn().mockResolvedValue({
      settings: {
        codingCli: {
          enabledProviders: ['opencode'],
          providers: {},
        },
      },
    }),
  },
}))

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() }))
loggerMock.child.mockReturnValue(loggerMock)
vi.mock('../../../../server/logger', () => ({ logger: loggerMock, sessionLifecycleLogger: loggerMock }))

import { configStore } from '../../../../server/config-store'

function makeDirectProvider(): CodingCliProvider {
  return {
    name: 'opencode',
    displayName: 'OpenCode',
    homeDir: '/tmp/opencode-home',
    listSessionsDirect: vi.fn(async () => []),
    getSessionGlob: () => '/tmp/opencode-home/{opencode.db,opencode.db-wal}',
    getSessionRoots: () => ['/tmp/opencode-home/opencode.db'],
    getSessionWatchBases: () => ['/tmp'],
    listSessionFiles: async () => [],
    parseSessionFile: async () => ({}),
    resolveProjectPath: async () => '/tmp/opencode-home',
    extractSessionId: () => 'unused',
    getCommand: () => 'opencode',
    getStreamArgs: () => [],
    getResumeArgs: (sessionId: string) => ['--session', sessionId],
    parseEvent: () => [],
    supportsLiveStreaming: () => false,
    supportsSessionResume: () => true,
  }
}

describe('CodingCliSessionIndexer provider refresh', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces urgent direct-provider refresh requests', async () => {
    const provider = makeDirectProvider()
    const indexer = new CodingCliSessionIndexer([provider], {
      debounceMs: 100,
      throttleMs: 1000,
    })

    indexer.scheduleProviderRefresh('opencode', { urgent: true, reason: 'turn_complete' })
    indexer.scheduleProviderRefresh('opencode', { urgent: true, reason: 'association' })

    await vi.runAllTimersAsync()
    await Promise.resolve()

    expect(provider.listSessionsDirect).toHaveBeenCalledTimes(1)
  })

  it('preserves cached direct-provider sessions (and does not warn-log the raw error) when listSessionsDirect throws during a full scan', async () => {
    vi.useRealTimers() // this test drives refresh() directly, no timers needed
    loggerMock.warn.mockClear()
    loggerMock.debug.mockClear()
    // First refresh: opencode enabled. Second refresh: enabled-set changes
    // (add 'claude') -> enabledKey changes -> needsFullScan -> full-scan path.
    vi.mocked(configStore.snapshot)
      .mockResolvedValueOnce({ settings: { codingCli: { enabledProviders: ['opencode'], providers: {} } } } as never)
      .mockResolvedValueOnce({ settings: { codingCli: { enabledProviders: ['opencode', 'claude'], providers: {} } } } as never)

    const sessions = [{ provider: 'opencode', sessionId: 's1', projectPath: '/repo', cwd: '/repo', lastActivityAt: 2000, createdAt: 1000 }]
    const listSessionsDirect = vi.fn()
      .mockResolvedValueOnce(sessions)                         // full scan #1 succeeds -> s1 cached
      .mockRejectedValue(new Error('worker exploded at /secret/path'))  // full scan #2 throws
    const provider = { ...makeDirectProvider(), listSessionsDirect }
    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh() // full scan #1 (needsFullScan defaults true)
    expect(indexer.getProjects().flatMap((g) => g.sessions).map((s) => s.sessionId)).toEqual(['s1'])

    await indexer.refresh() // full scan #2 (enabled-set changed) — listSessionsDirect throws
    // The cached session must survive the global full-scan prune.
    expect(indexer.getProjects().flatMap((g) => g.sessions).map((s) => s.sessionId)).toEqual(['s1'])

    // The catch must NOT warn-log the failure (it logs debug now), and NO warn/debug
    // payload may carry a raw `err`/Error. NOTE: do NOT assert via JSON.stringify —
    // Error objects serialize to "{}", so a leaked `{ err: new Error('/secret/path') }`
    // would pass a string check. Inspect the call args STRUCTURALLY.
    expect(loggerMock.warn).not.toHaveBeenCalledWith(expect.anything(), 'Could not list provider sessions directly')
    const allLogCalls = [...loggerMock.warn.mock.calls, ...loggerMock.debug.mock.calls]
    for (const [payload] of allLogCalls) {
      if (payload && typeof payload === 'object') {
        expect(Object.prototype.hasOwnProperty.call(payload, 'err')).toBe(false)
        expect(Object.values(payload).some((v) => v instanceof Error)).toBe(false)
      }
    }
    // Assert the exact intended debug call shape (provider only, no error).
    expect(loggerMock.debug).toHaveBeenCalledWith(
      { provider: 'opencode' },
      'Direct provider listing failed; preserving cached sessions',
    )
  })
})
