import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    data: unknown
    constructor(status: number, message: string, data?: unknown) {
      super(message)
      this.status = status
      this.data = data
    }
  },
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { post: apiMocks.post, patch: apiMocks.patch },
}))

// The shared 429-retry helper `instanceof`-checks the REAL ApiError — the
// tests that exercise retry reject with THIS class, not the mock's shape twin.
const realApi = await import('@/lib/api')

import {
  bootstrapSessionNames,
  collectSessionNameRefs,
  renameSessionName,
} from '@/lib/session-names'
import { sessionNameRefKey, type SessionNameUpdate } from '@shared/session-names'

function sessionRef(sessionId: string) {
  return { kind: 'session' as const, provider: 'claude' as const, sessionId }
}

function pendingRef(id: string) {
  return { kind: 'pending' as const, id }
}

function acceptedUpdate(name: string, revision: number): SessionNameUpdate {
  return {
    record: { ref: sessionRef('s1'), name, source: 'manual', revision },
    documentGeneration: 10,
    redirects: [],
    changed: true,
  }
}

describe('bootstrapSessionNames', () => {
  beforeEach(() => {
    apiMocks.post.mockReset()
  })

  it('POSTs the read batch and returns the parsed updates', async () => {
    const update = acceptedUpdate('Booted name', 2)
    apiMocks.post.mockResolvedValueOnce({ names: [update] })

    const updates = await bootstrapSessionNames([sessionRef('s1')])

    expect(apiMocks.post).toHaveBeenCalledTimes(1)
    expect(apiMocks.post).toHaveBeenCalledWith('/api/session-names/read', { refs: [sessionRef('s1')] }, expect.anything())
    expect(updates).toEqual([update])
  })

  it('chunks refs into batches of at most 100 per request', async () => {
    const firstNames = Array.from({ length: 100 }, (_, i) => acceptedUpdate(`n${i}`, 1))
    const restNames = Array.from({ length: 50 }, (_, i) => acceptedUpdate(`n${100 + i}`, 1))
    apiMocks.post
      .mockResolvedValueOnce({ names: firstNames })
      .mockResolvedValueOnce({ names: restNames })

    const refs = Array.from({ length: 150 }, (_, i) => sessionRef(`s${i}`))
    const updates = await bootstrapSessionNames(refs)

    expect(apiMocks.post).toHaveBeenCalledTimes(2)
    const [firstPath, firstBody] = apiMocks.post.mock.calls[0]
    const [secondPath, secondBody] = apiMocks.post.mock.calls[1]
    expect(firstPath).toBe('/api/session-names/read')
    expect(secondPath).toBe('/api/session-names/read')
    expect((firstBody as { refs: unknown[] }).refs).toHaveLength(100)
    expect((secondBody as { refs: unknown[] }).refs).toHaveLength(50)
    expect(updates).toHaveLength(150)
  })

  it('returns updates for missing refs silently (the server omits unknown refs)', async () => {
    apiMocks.post.mockResolvedValueOnce({ names: [] })

    const updates = await bootstrapSessionNames([pendingRef('unknown-handle')])
    expect(updates).toEqual([])
  })

  it('propagates an abort signal to the request', async () => {
    const controller = new AbortController()
    apiMocks.post.mockImplementation((_path: string, _body: unknown, options: { signal?: AbortSignal }) => {
      expect(options?.signal?.aborted).toBe(false)
      return Promise.resolve({ names: [] })
    })
    await bootstrapSessionNames([sessionRef('s1')], { signal: controller.signal })
    expect(apiMocks.post).toHaveBeenCalled()
  })

  it('retries a rate-limited read (the reconnect burst) and still bootstraps', async () => {
    // The ready/reconnect batch bootstrap races the reconnect storm's own
    // API burst (sessions, directory, settings) on the ONE shared bucket: a
    // 429 there must not silently strand the client's canonical cache.
    const update = acceptedUpdate('Bursty boot name', 2)
    apiMocks.post
      .mockRejectedValueOnce(new realApi.ApiError(429, 'rate limited'))
      .mockResolvedValueOnce({ names: [update] })

    const updates = await bootstrapSessionNames([sessionRef('s1')])

    expect(apiMocks.post).toHaveBeenCalledTimes(2)
    expect(updates).toEqual([update])
  })

  it('stops retrying a rate-limited read after a bounded number of attempts and propagates', async () => {
    apiMocks.post.mockImplementation(
      () => Promise.reject(new realApi.ApiError(429, 'rate limited')),
    )
    await expect(bootstrapSessionNames([sessionRef('s1')])).rejects.toMatchObject({ status: 429 })
    const maxAttempts = apiMocks.post.mock.calls.length
    expect(maxAttempts).toBeGreaterThanOrEqual(1)
    expect(maxAttempts).toBeLessThanOrEqual(6)
  })

  it('does not retry a non-rate-limit failure', async () => {
    apiMocks.post.mockRejectedValueOnce(new realApi.ApiError(500, 'server error'))
    await expect(bootstrapSessionNames([sessionRef('s1')])).rejects.toMatchObject({ status: 500 })
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
  })
})

describe('collectSessionNameRefs', () => {
  it('collects refs from open panes, session-directory windows, and terminal-directory windows, deduped', () => {    const refs = collectSessionNameRefs({
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              terminalId: 't1',
              createRequestId: 'cr-1',
              status: 'running',
              nameRef: pendingRef('pane-handle'),
              sessionRef: { provider: 'claude', sessionId: 's1' },
            },
          } as never,
        },
      },
      sessions: {
        windows: {
          history: {
            projects: [
              {
                sessions: [
                  // Same ref as the open pane's session — collected once.
                  { nameRef: sessionRef('s1') },
                  { nameRef: sessionRef('s2') },
                ],
              },
            ],
          },
        },
      },
      terminalDirectory: {
        windows: {
          sidebar: {
            items: [
              // "Recently closed" background terminals.
              { nameRef: sessionRef('recently-closed') },
              { nameRef: sessionRef('s1') },
            ],
          },
        },
      },
    })

    expect(refs).toEqual([
      pendingRef('pane-handle'),
      sessionRef('s1'),
      sessionRef('s2'),
      sessionRef('recently-closed'),
    ])
  })

  it('ignores rows without a valid naming ref', () => {
    const refs = collectSessionNameRefs({
      sessions: {
        windows: {
          history: {
            projects: [
              { sessions: [{ nameRef: { kind: 'session', provider: 'claude', sessionId: '' } }, { title: 'no ref' }] },
            ],
          },
        },
      },
      terminalDirectory: {
        windows: {
          sidebar: {
            items: [{ nameRef: { kind: 'pending', id: '' } }, { title: 'no ref' }],
          },
        },
      },
    })
    expect(refs).toEqual([])
  })

  it('never collects out-of-scope provider refs (a gemini pane cannot 400 the whole bootstrap chunk)', async () => {
    // Round-3 review finding 1: the bootstrap ref collector walked every
    // terminal/fresh pane's sessionRef with no provider scope check, so an
    // out-of-scope coding CLI (gemini/kimi/amplifier) produced
    // {kind:'session',provider:'gemini',...} — a ref the server's wholesale
    // strict scope gate rejects with 400 for the ENTIRE chunked read, on
    // every ready/reconnect, defeating the convergence bootstrap. Out-of-scope
    // panes must simply never be collected.
    const { parseSessionNameRef } = await import('@/lib/session-names')
    const refs = collectSessionNameRefs({
      panes: {
        layouts: {
          // A gemini terminal pane that has acquired a durable sessionRef
          // (resumed/reconciled panes carry one — pane-reconcile promotes
          // resumeSessionId into a structured sessionRef).
          'tab-gemini': {
            type: 'leaf',
            id: 'pane-g',
            content: {
              kind: 'terminal',
              mode: 'gemini',
              terminalId: 't-g',
              createRequestId: 'cr-g',
              status: 'running',
              sessionRef: { provider: 'gemini', sessionId: 'gem-1' },
            },
          } as never,
          // A scoped claude pane beside it — its refs must still bootstrap.
          'tab-claude': {
            type: 'leaf',
            id: 'pane-c',
            content: {
              kind: 'terminal',
              mode: 'claude',
              terminalId: 't-c',
              createRequestId: 'cr-c',
              status: 'running',
              nameRef: pendingRef('h-claude'),
              sessionRef: { provider: 'claude', sessionId: 's-claude' },
            },
          } as never,
          // An out-of-scope kimi pane whose sessionRef would land in the
          // same 100-ref chunk after the claude pane.
          'tab-kimi': {
            type: 'leaf',
            id: 'pane-k',
            content: {
              kind: 'terminal',
              mode: 'kimi',
              terminalId: 't-k',
              createRequestId: 'cr-k',
              status: 'running',
              sessionRef: { provider: 'kimi', sessionId: 'kimi-1' },
            },
          } as never,
        },
      },
    })
    expect(refs).toEqual([pendingRef('h-claude'), sessionRef('s-claude')])
    // The provider typing itself must be sound: a validated whitelist, not
    // an unsound cast that lets any string become a NamedProvider.
    expect(parseSessionNameRef({ kind: 'session', provider: 'gemini', sessionId: 'g' })).toBeUndefined()
    expect(parseSessionNameRef({ kind: 'session', provider: 'amplifier', sessionId: 'a' })).toBeUndefined()
    expect(parseSessionNameRef({ kind: 'session', provider: 'claude', sessionId: 'c' })).toEqual(sessionRef('c'))
  })
})

describe('uncachedSessionNameRefs', () => {
  it('returns collected refs the cache lacks, once per ref (attempted set guards re-reads)', async () => {
    const { uncachedSessionNameRefs } = await import('@/lib/session-names')
    const state = {
      sessions: {
        windows: {
          history: {
            projects: [
              { sessions: [{ nameRef: sessionRef('s1') }, { nameRef: sessionRef('cached') }] },
            ],
          },
        },
      },
      sessionNames: {
        records: { [sessionNameRefKey(sessionRef('cached'))]: { name: 'Already known' } },
        redirects: {},
      },
    }
    const attempted = new Set<string>()

    const first = uncachedSessionNameRefs(state as never, attempted)
    expect(first).toEqual([sessionRef('s1')])
    // The attempted set now covers the ref: a fresh page's post-ready
    // projections never re-read a ref the bootstrap already attempted.
    const second = uncachedSessionNameRefs(state as never, attempted)
    expect(second).toEqual([])
  })

  it('follows pending redirects through the cache when checking coverage', async () => {
    const { uncachedSessionNameRefs } = await import('@/lib/session-names')
    const state = {
      sessions: {
        windows: {
          history: {
            projects: [
              { sessions: [{ nameRef: pendingRef('nh-redirected') }] },
            ],
          },
        },
      },
      sessionNames: {
        records: { [sessionNameRefKey(sessionRef('s-adopted'))]: { name: 'Adopted' } },
        redirects: { [sessionNameRefKey(pendingRef('nh-redirected'))]: { toKey: sessionNameRefKey(sessionRef('s-adopted')), revision: 3 } },
      },
    }
    const attempted = new Set<string>()
    expect(uncachedSessionNameRefs(state as never, attempted)).toEqual([])
  })
})

describe('renameSessionName', () => {
  beforeEach(() => {
    apiMocks.patch.mockReset()
  })

  it('PATCHes the canonical rename route with the full request body', async () => {
    const update = acceptedUpdate('Renamed by user', 3)
    apiMocks.patch.mockResolvedValueOnce(update)

    const result = await renameSessionName({
      target: sessionRef('s1'),
      name: 'Renamed by user',
      nameIntent: 'user',
      ifRevision: 2,
    })

    expect(apiMocks.patch).toHaveBeenCalledWith(
      '/api/session-names',
      {
        target: sessionRef('s1'),
        name: 'Renamed by user',
        nameIntent: 'user',
        ifRevision: 2,
      },
      expect.anything(),
    )
    expect(result).toEqual(update)
  })

  it('keeps the rename outcome a server reports (name-reliability Task 4)', async () => {
    const refused = { ...acceptedUpdate('LotL', 3), changed: false, outcome: { applied: false, reason: 'protected_name' } }
    apiMocks.patch.mockResolvedValueOnce(refused)
    const result = await renameSessionName({ target: sessionRef('s1'), name: 'Bot name' })
    expect(result.outcome).toEqual({ applied: false, reason: 'protected_name' })
    expect(result.record.name).toBe('LotL')
  })

  it('accepts a rename update without an outcome, and one with an unknown reason, keeping the record', async () => {
    apiMocks.patch.mockResolvedValueOnce(acceptedUpdate('Old server', 2))
    const old = await renameSessionName({ target: sessionRef('s1'), name: 'Old server' })
    expect(old.outcome).toBeUndefined()
    expect(old.record.name).toBe('Old server')

    apiMocks.patch.mockResolvedValueOnce({ ...acceptedUpdate('Newer server', 4), outcome: { applied: false, reason: 'some_future_reason' } })
    const newer = await renameSessionName({ target: sessionRef('s1'), name: 'Newer server' })
    expect(newer.record.name).toBe('Newer server')
    expect(newer.outcome).toBeUndefined()
  })

  it('retains the server error code and accepted record on a conflict (the bare-record payload the scoped routes really answer)', async () => {
    // The scoped rename routes answer a conflict with the CURRENT record
    // as a bare `sessionName` — not the update envelope (an envelope
    // would fabricate documentGeneration/redirects the conflict path
    // does not maintain). The typed error must parse the REAL shape.
    apiMocks.patch.mockRejectedValue(new realApi.ApiError(409, 'conflict: another rename won', {
      error: 'NAME_REVISION_CONFLICT',
      message: 'another rename won',
      sessionName: {
        ref: { kind: 'session', provider: 'claude', sessionId: 's1' },
        name: 'Other browser name',
        source: 'manual',
        revision: 5,
      },
      nameRef: { kind: 'session', provider: 'claude', sessionId: 's1' },
    }))

    await expect(renameSessionName({ target: sessionRef('s1'), name: 'Loser', nameIntent: 'user' }))
      .rejects.toMatchObject({
        status: 409,
        serverCode: 'NAME_REVISION_CONFLICT',
      })
    try {
      await renameSessionName({ target: sessionRef('s1'), name: 'Loser', nameIntent: 'user' })
    } catch (error: any) {
      // The accepted record survives for the error UI.
      expect(error.acceptedRecord?.name).toBe('Other browser name')
      expect(error.acceptedRecord?.revision).toBe(5)
      expect(error.acceptedRecord?.ref).toEqual({ kind: 'session', provider: 'claude', sessionId: 's1' })
    }
  })

  it('also accepts the update-envelope conflict payload (cross-version tolerance)', async () => {
    // A mixed-version server (or the success-path shape reused on a
    // conflict) still folds — the extraction accepts both.
    apiMocks.patch.mockRejectedValue(new realApi.ApiError(409, 'conflict: another rename won', {
      error: 'NAME_REVISION_CONFLICT',
      sessionName: {
        record: {
          ref: { kind: 'session', provider: 'claude', sessionId: 's1' },
          name: 'Envelope winner',
          source: 'manual',
          revision: 7,
        },
        documentGeneration: 40,
        redirects: [],
        changed: true,
      },
    }))
    try {
      await renameSessionName({ target: sessionRef('s1'), name: 'Loser', nameIntent: 'user' })
    } catch (error: any) {
      expect(error.acceptedRecord?.name).toBe('Envelope winner')
      expect(error.acceptedRecord?.revision).toBe(7)
    }
  })
})
