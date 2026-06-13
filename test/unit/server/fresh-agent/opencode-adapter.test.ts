import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { createOpencodeFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/opencode/adapter.js'
import { OpencodeHistoryReaderError, type OpencodeHistoryReader } from '../../../../server/fresh-agent/adapters/opencode/history-runner.js'
import { FreshAgentLostSessionError } from '../../../../server/fresh-agent/runtime-manager.js'

function makeSpawn(fixtures: Record<string, { stdout: string; stderr?: string; code?: number }>) {
  const calls: string[][] = []
  const cwdCalls: Array<string | undefined> = []
  const spawnFn = vi.fn((_command: string, args: string[], options?: { cwd?: string }) => {
    calls.push(args)
    cwdCalls.push(options?.cwd)
    const child = new EventEmitter() as any
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.stdin.end = vi.fn()
    child.kill = vi.fn()
    const key = args.join(' ')
    const fixture = fixtures[key] ?? { stdout: '', stderr: `missing fixture for ${key}`, code: 1 }
    queueMicrotask(() => {
      child.stdout.end(fixture.stdout)
      child.stderr.end(fixture.stderr ?? '')
      child.emit('close', fixture.code ?? 0)
    })
    return child
  })
  return { spawnFn, calls, cwdCalls }
}

function makeHangingSpawn() {
  const child = new EventEmitter() as any
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdin.end = vi.fn()
  child.kill = vi.fn((signal?: string) => {
    child.killed = true
    queueMicrotask(() => child.emit('close', signal === 'SIGTERM' ? null : 1))
    return true
  })
  return { spawnFn: vi.fn(() => child), child }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeHistoryReader(overrides: Partial<OpencodeHistoryReader> = {}): OpencodeHistoryReader {
  return {
    readSessionInfo: vi.fn().mockRejectedValue(new OpencodeHistoryReaderError('missing_db', 'missing db')),
    readSnapshotPage: vi.fn().mockRejectedValue(new OpencodeHistoryReaderError('missing_db', 'missing db')),
    readTurnPage: vi.fn().mockRejectedValue(new OpencodeHistoryReaderError('missing_db', 'missing db')),
    readTurnBody: vi.fn().mockRejectedValue(new OpencodeHistoryReaderError('missing_db', 'missing db')),
    ...overrides,
  }
}

const exportedSession = {
  info: {
    id: 'ses_real_1',
    title: 'OpenCode title',
    model: { providerID: 'opencode-go', id: 'deepseek-v4-flash', variant: 'max' },
    tokens: { input: 3, output: 4, cache: { read: 5 } },
    time: { updated: 12 },
  },
  messages: [
    {
      info: { id: 'msg_user_1', role: 'user', time: { created: 1779557095868 } },
      parts: [{ id: 'prt_user_1', type: 'text', text: 'reply ok' }],
    },
    {
      info: { id: 'msg_assistant_1', role: 'assistant', providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      parts: [
        { id: 'prt_reason_1', type: 'reasoning', text: 'Thinking briefly.' },
        { id: 'prt_text_1', type: 'text', text: 'ok' },
      ],
    },
  ],
}

describe('OpenCode fresh-agent adapter', () => {
  it('creates a placeholder and materializes it on first send with model and effort', async () => {
    const { spawnFn, calls } = makeSpawn({
      'run reply ok --format json --model opencode-go/deepseek-v4-flash --variant max': {
        stdout: '{"type":"step_start","sessionID":"ses_real_1"}\n{"type":"text","part":{"text":"ok"}}\n',
      },
      'export ses_real_1': {
        stdout: `Exporting session: ses_real_1\n${JSON.stringify(exportedSession)}`,
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({
      spawnFn: spawnFn as any,
      historyReader: makeHistoryReader(),
    })

    const created = await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'max',
    })

    expect(created).toEqual({
      sessionId: 'freshopencode-req-1',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
    })

    await expect(adapter.send?.('freshopencode-req-1', { text: 'reply ok' })).resolves.toEqual({
      sessionId: 'ses_real_1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })
    expect((spawnFn.mock.results[0].value as any).stdin.end).toHaveBeenCalled()
    expect(calls[0]).toEqual([
      'run',
      'reply ok',
      '--format',
      'json',
      '--model',
      'opencode-go/deepseek-v4-flash',
      '--variant',
      'max',
    ])

    await expect(adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-req-1',
    }, 12)).resolves.toMatchObject({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-req-1',
      sessionId: 'ses_real_1',
      summary: 'OpenCode title',
      tokenUsage: { inputTokens: 3, outputTokens: 4, cachedTokens: 5 },
      turns: [
        { turnId: 'msg_user_1', role: 'user', summary: 'reply ok' },
        { turnId: 'msg_assistant_1', role: 'assistant', summary: 'ok' },
      ],
    })
  })

  it('continues a materialized session on later sends', async () => {
    const { spawnFn, calls } = makeSpawn({
      'run first --format json --model opencode-go/glm-5.1 --variant high': {
        stdout: '{"type":"step_start","sessionID":"ses_real_2"}\n',
      },
      'run second --format json --session ses_real_2 --model opencode-go/glm-5.1 --variant high': {
        stdout: '{"type":"step_start","sessionID":"ses_real_2"}\n',
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({
      spawnFn: spawnFn as any,
      historyReader: makeHistoryReader(),
    })
    await adapter.create({
      requestId: 'req-2',
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.1',
      effort: 'high',
    })

    await adapter.send?.('freshopencode-req-2', { text: 'first' })
    await adapter.send?.('freshopencode-req-2', { text: 'second' })

    expect(calls[1]).toContain('--session')
    expect(calls[1]).toContain('ses_real_2')
  })

  it('hydrates an attached restored session for send, compact, and turn loading', async () => {
    const restoredExport = {
      ...exportedSession,
      info: { ...exportedSession.info, id: 'ses_restored_1' },
    }
    const historyReader = makeHistoryReader({
      readSessionInfo: vi.fn().mockResolvedValue({ id: 'ses_restored_1', directory: '/db/repo' }),
      readTurnBody: vi.fn().mockResolvedValue({
        message: restoredExport.messages[1],
        revision: 12,
      }),
    })
    const { spawnFn, calls, cwdCalls } = makeSpawn({
      'run reply ok --format json --session ses_restored_1': {
        stdout: '{"type":"step_start","sessionID":"ses_restored_1"}\n',
      },
      'run /compact keep decisions --format json --session ses_restored_1': {
        stdout: '{"type":"step_start","sessionID":"ses_restored_1"}\n',
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any, historyReader })

    await adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_restored_1',
    })
    await adapter.send?.('ses_restored_1', { text: 'reply ok' })
    await adapter.compact?.('ses_restored_1', { instructions: 'keep decisions' })

    expect(calls[0]).toEqual([
      'run',
      'reply ok',
      '--format',
      'json',
      '--session',
      'ses_restored_1',
    ])
    expect(calls[1]).toEqual([
      'run',
      '/compact keep decisions',
      '--format',
      'json',
      '--session',
      'ses_restored_1',
    ])
    expect(cwdCalls[0]).toBe('/db/repo')
    expect(cwdCalls[1]).toBe('/db/repo')
    await expect(adapter.getTurnBody?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_restored_1',
      turnId: 'msg_assistant_1',
    }, 12)).resolves.toMatchObject({
      threadId: 'ses_restored_1',
      turnId: 'msg_assistant_1',
      role: 'assistant',
      items: expect.arrayContaining([
        expect.objectContaining({ kind: 'text', text: 'ok' }),
      ]),
    })
    expect(historyReader.readTurnBody).toHaveBeenCalledWith('ses_restored_1', 'msg_assistant_1')
  })

  it('hydrates a resumed restored session cwd from DB before later runs', async () => {
    const historyReader = makeHistoryReader({
      readSessionInfo: vi.fn().mockResolvedValue({ id: 'ses_restored_1', directory: '/db/resume-repo' }),
    })
    const { spawnFn, cwdCalls } = makeSpawn({
      'run reply ok --format json --session ses_restored_1 --model opencode-go/deepseek-v4-flash --variant max': {
        stdout: '{"type":"step_start","sessionID":"ses_restored_1"}\n',
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any, historyReader })

    await adapter.resume?.({
      requestId: 'req-resume',
      sessionType: 'freshopencode',
      provider: 'opencode',
      resumeSessionId: 'ses_restored_1',
    })
    await adapter.send?.('ses_restored_1', { text: 'reply ok' })

    expect(historyReader.readSessionInfo).toHaveBeenCalledWith('ses_restored_1')
    expect(cwdCalls[0]).toBe('/db/resume-repo')
  })

  it('uses DB history before export and does not call truncated export when DB succeeds', async () => {
    const historyReader = makeHistoryReader({
      readSessionInfo: vi.fn().mockResolvedValue({ id: 'ses_real_1', directory: '/repo' }),
      readSnapshotPage: vi.fn().mockResolvedValue({
        exported: exportedSession,
        revision: 12,
        nextCursor: null,
        hasMoreBefore: false,
      }),
    })
    const { spawnFn, calls } = makeSpawn({
      'run reply ok --format json --model opencode-go/deepseek-v4-flash --variant max': {
        stdout: '{"type":"step_start","sessionID":"ses_real_1"}\n',
      },
      'export ses_real_1': {
        stdout: '{"info":{"id":"ses_real_1"},"messages":[',
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any, historyReader })
    await adapter.create({
      requestId: 'req-db-first',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })

    await adapter.send?.('freshopencode-req-db-first', { text: 'reply ok' })
    await expect(adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-req-db-first',
    }, 12)).resolves.toMatchObject({
      sessionId: 'ses_real_1',
      revision: 12,
      turns: [
        { turnId: 'msg_user_1' },
        { turnId: 'msg_assistant_1' },
      ],
    })

    expect(historyReader.readSnapshotPage).toHaveBeenCalledWith('ses_real_1', 200)
    expect(calls.some((args) => args[0] === 'export')).toBe(false)
  })

  it('returns an empty live snapshot for a newly-created placeholder before first materialization', async () => {
    const historyReader = makeHistoryReader()
    const { spawnFn, calls } = makeSpawn({
      'export freshopencode-req-empty': {
        stdout: JSON.stringify(exportedSession),
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any, historyReader })
    await adapter.create({
      requestId: 'req-empty',
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'max',
    })

    await expect(adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-req-empty',
    }, 0)).resolves.toMatchObject({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-req-empty',
      sessionId: 'freshopencode-req-empty',
      status: 'idle',
      turns: [],
      settings: {
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
      },
    })
    expect(historyReader.readSnapshotPage).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('only materializes from top-level ses-prefixed run sessionID values', async () => {
    const historyReader = makeHistoryReader()
    const { spawnFn, calls } = makeSpawn({
      'run reply ok --format json --model opencode-go/deepseek-v4-flash --variant max': {
        stdout: [
          JSON.stringify({
            type: 'part',
            part: { state: { metadata: { sessionId: 'ses_child_1' } } },
          }),
          JSON.stringify({ type: 'step_start', sessionID: 'not-a-session' }),
          '',
        ].join('\n'),
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any, historyReader })
    await adapter.create({
      requestId: 'req-nested',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })

    await expect(adapter.send?.('freshopencode-req-nested', { text: 'reply ok' })).resolves.toBeUndefined()
    await expect(adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-req-nested',
    }, 0)).resolves.toMatchObject({
      sessionId: 'freshopencode-req-nested',
      turns: [],
    })
    expect(historyReader.readSessionInfo).not.toHaveBeenCalled()
    expect(historyReader.readSnapshotPage).not.toHaveBeenCalled()
    expect(calls.some((args) => args[0] === 'export')).toBe(false)
  })

  it('leaves placeholders unmaterialized when run output has no authoritative top-level sessionID', async () => {
    const historyReader = makeHistoryReader()
    const { spawnFn, calls } = makeSpawn({
      'run reply ok --format json --model opencode-go/deepseek-v4-flash --variant max': {
        stdout: '{"type":"text","part":{"text":"ok"}}\n',
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any, historyReader })
    await adapter.create({
      requestId: 'req-no-session-id',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo',
    })

    await expect(adapter.send?.('freshopencode-req-no-session-id', { text: 'reply ok' })).resolves.toBeUndefined()
    await expect(adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-req-no-session-id',
    }, 0)).resolves.toMatchObject({
      sessionId: 'freshopencode-req-no-session-id',
      turns: [],
    })
    expect(historyReader.readSessionInfo).not.toHaveBeenCalled()
    expect(historyReader.readSnapshotPage).not.toHaveBeenCalled()
    expect(calls.some((args) => args[0] === 'export')).toBe(false)
  })

  it('serializes concurrent first sends so the second uses the materialized session', async () => {
    const firstClose = deferred()
    const calls: string[][] = []
    const spawnFn = vi.fn((_command: string, args: string[]) => {
      calls.push(args)
      const child = new EventEmitter() as any
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.stdin.end = vi.fn()
      child.kill = vi.fn()
      const complete = () => {
        child.stdout.end('{"type":"step_start","sessionID":"ses_real_1"}\n')
        child.stderr.end('')
        child.emit('close', 0)
      }
      if (args[1] === 'first') {
        void firstClose.promise.then(complete)
      } else {
        queueMicrotask(complete)
      }
      return child
    })
    const adapter = createOpencodeFreshAgentAdapter({
      spawnFn: spawnFn as any,
      historyReader: makeHistoryReader({
        readSessionInfo: vi.fn().mockResolvedValue({ id: 'ses_real_1', directory: '/repo' }),
      }),
    })
    await adapter.create({
      requestId: 'req-queue',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })

    const first = adapter.send?.('freshopencode-req-queue', { text: 'first' })
    const second = adapter.send?.('freshopencode-req-queue', { text: 'second' })
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1))
    firstClose.resolve()
    await Promise.all([first, second])

    expect(calls[1].slice(0, 6)).toEqual([
      'run',
      'second',
      '--format',
      'json',
      '--session',
      'ses_real_1',
    ])
  })

  it('throws for restored freshopencode placeholders without calling export', async () => {
    const historyReader = makeHistoryReader()
    const { spawnFn, calls } = makeSpawn({
      'export freshopencode-restored': {
        stdout: JSON.stringify(exportedSession),
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any, historyReader })

    await expect(adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'freshopencode-restored',
    })).rejects.toBeInstanceOf(FreshAgentLostSessionError)
    await expect(adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-restored',
    }, 0)).rejects.toBeInstanceOf(FreshAgentLostSessionError)
    expect(calls).toEqual([])
  })

  it('accepts partial per-turn settings from the client send path', async () => {
    const { spawnFn, calls } = makeSpawn({
      'run reply ok --format json --model opencode-go/deepseek-v4-flash --variant high': {
        stdout: '{"type":"step_start","sessionID":"ses_real_3"}\n',
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({
      spawnFn: spawnFn as any,
      historyReader: makeHistoryReader(),
    })
    await adapter.create({
      requestId: 'req-3',
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'max',
    })

    await adapter.send?.('freshopencode-req-3', {
      text: 'reply ok',
      settings: {
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'high',
      } as any,
    })

    expect(calls[0]).toEqual([
      'run',
      'reply ok',
      '--format',
      'json',
      '--model',
      'opencode-go/deepseek-v4-flash',
      '--variant',
      'high',
    ])
  })

  it('times out and terminates stuck OpenCode runs', async () => {
    const { spawnFn, child } = makeHangingSpawn()
    const adapter = createOpencodeFreshAgentAdapter({
      spawnFn: spawnFn as any,
      historyReader: makeHistoryReader(),
      runTimeoutMs: 5,
    })
    await adapter.create({
      requestId: 'req-timeout',
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'max',
    })

    await expect(adapter.send?.('freshopencode-req-timeout', { text: 'reply ok' })).rejects.toThrow('OpenCode timed out')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
