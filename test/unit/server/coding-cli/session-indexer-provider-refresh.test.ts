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
})
