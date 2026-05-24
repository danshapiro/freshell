import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { createOpencodeFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/opencode/adapter.js'

function makeSpawn(fixtures: Record<string, { stdout: string; stderr?: string; code?: number }>) {
  const calls: string[][] = []
  const spawnFn = vi.fn((_command: string, args: string[]) => {
    calls.push(args)
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
  return { spawnFn, calls }
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
      'run reply ok --format json --dangerously-skip-permissions --model opencode-go/deepseek-v4-flash --variant max': {
        stdout: '{"type":"step_start","sessionID":"ses_real_1"}\n{"type":"text","part":{"text":"ok"}}\n',
      },
      'export ses_real_1': {
        stdout: `Exporting session: ses_real_1\n${JSON.stringify(exportedSession)}`,
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any })

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

    await adapter.send?.('freshopencode-req-1', { text: 'reply ok' })
    expect((spawnFn.mock.results[0].value as any).stdin.end).toHaveBeenCalled()
    expect(calls[0]).toEqual([
      'run',
      'reply ok',
      '--format',
      'json',
      '--dangerously-skip-permissions',
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
      'run first --format json --dangerously-skip-permissions --model opencode-go/glm-5.1 --variant high': {
        stdout: '{"type":"step_start","sessionID":"ses_real_2"}\n',
      },
      'run second --format json --dangerously-skip-permissions --session ses_real_2 --model opencode-go/glm-5.1 --variant high': {
        stdout: '{"type":"step_start","sessionID":"ses_real_2"}\n',
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any })
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
    const { spawnFn, calls } = makeSpawn({
      'run reply ok --format json --dangerously-skip-permissions --session ses_restored_1': {
        stdout: '{"type":"step_start","sessionID":"ses_restored_1"}\n',
      },
      'run /compact keep decisions --format json --dangerously-skip-permissions --session ses_restored_1': {
        stdout: '{"type":"step_start","sessionID":"ses_restored_1"}\n',
      },
      'export ses_restored_1': {
        stdout: `Exporting session: ses_restored_1\n${JSON.stringify(restoredExport)}`,
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any })

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
      '--dangerously-skip-permissions',
      '--session',
      'ses_restored_1',
    ])
    expect(calls[1]).toEqual([
      'run',
      '/compact keep decisions',
      '--format',
      'json',
      '--dangerously-skip-permissions',
      '--session',
      'ses_restored_1',
    ])
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
  })

  it('accepts partial per-turn settings from the client send path', async () => {
    const { spawnFn, calls } = makeSpawn({
      'run reply ok --format json --dangerously-skip-permissions --model opencode-go/deepseek-v4-flash --variant high': {
        stdout: '{"type":"step_start","sessionID":"ses_real_3"}\n',
      },
    })
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any })
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
      '--dangerously-skip-permissions',
      '--model',
      'opencode-go/deepseek-v4-flash',
      '--variant',
      'high',
    ])
  })

  it('times out and terminates stuck OpenCode runs', async () => {
    const { spawnFn, child } = makeHangingSpawn()
    const adapter = createOpencodeFreshAgentAdapter({ spawnFn: spawnFn as any, runTimeoutMs: 5 })
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
