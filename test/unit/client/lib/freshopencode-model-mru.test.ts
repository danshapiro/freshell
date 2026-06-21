import { describe, expect, it } from 'vitest'
import {
  buildFreshOpencodeVisibleMru,
  loadFreshOpencodeModelMru,
  recordFreshOpencodeModelUse,
} from '@/lib/freshopencode-model-mru'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

const capability = (id: string, displayName = id) => ({
  id,
  displayName,
  provider: 'opencode' as const,
  source: { id: id.split('/')[0], displayName: id.split('/')[0] },
  supportsEffort: true,
  supportedEffortLevels: ['high'],
  supportsAdaptiveThinking: true,
})

const capabilities = {
  sessionType: 'freshopencode',
  runtimeProvider: 'opencode',
  status: 'fresh',
  fetchedAt: 1_000,
  models: [
    capability('opencode-go/current', 'Current'),
    capability('opencode-go/a', 'Alpha'),
    capability('opencode-go/b', 'Beta'),
  ],
} as const

describe('freshopencode model MRU', () => {
  it('records unique verified entries with display metadata, cwd scope, and most recent first', () => {
    const storage = memoryStorage()
    recordFreshOpencodeModelUse(capability('opencode-go/a', 'Alpha'), '/repo/a', 1_000, storage)
    recordFreshOpencodeModelUse(capability('opencode-go/b', 'Beta'), '/repo/a', 2_000, storage)
    recordFreshOpencodeModelUse(capability('opencode-go/a', 'Alpha'), '/repo/a', 3_000, storage)

    expect(loadFreshOpencodeModelMru(storage)).toEqual([
      {
        id: 'opencode-go/a',
        displayName: 'Alpha',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: '/repo/a',
        lastVerifiedAt: 3_000,
      },
      {
        id: 'opencode-go/b',
        displayName: 'Beta',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: '/repo/a',
        lastVerifiedAt: 2_000,
      },
    ])
  })

  it('renders same-cwd cached MRU immediately before the live catalog resolves', () => {
    const entries = [
      { id: 'opencode-go/current', displayName: 'Current', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'opencode-go/a', displayName: 'Alpha', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'opencode-go/b', displayName: 'Beta', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/b', lastVerifiedAt: 1_000 },
    ]

    expect(buildFreshOpencodeVisibleMru({
      currentModelId: 'opencode-go/current',
      cwdKey: '/repo/a',
      entries,
      capabilities: undefined,
      now: 1_000,
      maxVisible: 3,
    }).map((entry) => [entry.model.id, entry.stale])).toEqual([
      ['opencode-go/current', true],
      ['opencode-go/a', true],
    ])
  })

  it('uses the live enabled catalog to remove stale cached entries after refresh', () => {
    const entries = [
      { id: 'opencode-go/current', displayName: 'Current', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'missing/model', displayName: 'Missing', source: { id: 'missing', displayName: 'missing' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
    ]

    expect(buildFreshOpencodeVisibleMru({
      currentModelId: 'opencode-go/current',
      cwdKey: '/repo/a',
      entries,
      capabilities,
      now: 2_000,
      maxVisible: 3,
    }).map((entry) => [entry.model.id, entry.stale])).toEqual([
      ['opencode-go/current', false],
    ])
  })
})
