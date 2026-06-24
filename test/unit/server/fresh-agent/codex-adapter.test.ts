import { describe, expect, it, vi } from 'vitest'

import { createCodexFreshAgentAdapter as createRawCodexFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/codex/adapter.js'
import { createCodexDisplayId } from '../../../../server/fresh-agent/adapters/codex/normalize.js'
import {
  FreshAgentInvalidDisplayIdError,
  FreshAgentInvalidTurnCursorError,
  FreshAgentStaleThreadRevisionError,
  FreshAgentUnprovableThreadRevisionError,
  FreshAgentTurnNotFoundError,
} from '../../../../server/fresh-agent/runtime-manager.js'

const DISPLAY_SECRET = 'task-3-persisted-display-secret'

function createCodexFreshAgentAdapter(
  deps: Omit<Parameters<typeof createRawCodexFreshAgentAdapter>[0], 'displayIdSecret'> & { displayIdSecret?: string },
) {
  return createRawCodexFreshAgentAdapter({ displayIdSecret: DISPLAY_SECRET, ...deps })
}

function makeCodexThread(id: string) {
  return {
    id,
    sessionId: id,
    preview: 'Codex summary',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1770000000,
    updatedAt: 7,
    status: { type: 'idle' },
    cwd: '/repo',
    cliVersion: 'codex-cli 0.129.0',
    source: 'appServer',
    turns: [],
  }
}

function makeCodexTurn(id: string) {
  return {
    id,
    status: 'completed',
    items: [{
      type: 'agentMessage',
      id: `${id}:item-1`,
      text: 'Codex summary',
      phase: null,
      memoryCitation: null,
    }],
  }
}

function makeMixedCodexTurn(id: string) {
  return {
    id,
    status: 'completed',
    items: [
      {
        type: 'userMessage',
        id: `${id}:user`,
        content: [{ type: 'text', text: 'Review the diff.' }],
      },
      {
        type: 'reasoning',
        id: `${id}:reasoning`,
        summary: ['Checking changes'],
        content: [],
      },
      {
        type: 'agentMessage',
        id: `${id}:assistant`,
        text: 'The patch is safe.',
      },
    ],
  }
}

describe('Codex fresh-agent adapter', () => {
  it('paginates Codex history by display rows within a split provider turn', async () => {
    const firstTurn = makeMixedCodexTurn('turn-1')
    const secondTurn = makeCodexTurn('turn-2')
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn()
        .mockResolvedValueOnce({ revision: 7, nextCursor: 'provider-after-turn-1', turns: [firstTurn] })
        .mockResolvedValueOnce({ revision: 7, nextCursor: null, turns: [secondTurn] }),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const firstPage: any = await adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1 })

    expect(firstPage.turns).toHaveLength(1)
    expect(firstPage.turns[0]).toMatchObject({ role: 'user', summary: 'Review the diff.' })
    expect(firstPage.nextCursor).toMatch(/^codex-cursor:v1:[A-Za-z0-9_-]+$/)
    expect(firstPage.nextCursor).not.toContain('provider-after-turn-1')
    expect(firstPage.nextCursor).not.toContain('turn-1')
    expect(() => JSON.parse(Buffer.from(firstPage.nextCursor.split(':').at(-1) ?? '', 'base64url').toString('utf8'))).toThrow()

    const secondPage: any = await adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1, cursor: firstPage.nextCursor })

    expect(secondPage.turns).toHaveLength(1)
    expect(secondPage.turns[0]).toMatchObject({ role: 'assistant', summary: 'Checking changes' })
    expect(secondPage.turns[0].turnId).not.toBe(firstPage.turns[0].turnId)
    expect(runtime.listThreadTurns).toHaveBeenCalledTimes(1)

    const thirdPage: any = await adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1, cursor: secondPage.nextCursor })

    expect(thirdPage.turns).toHaveLength(1)
    expect(thirdPage.turns[0]).toMatchObject({ role: 'assistant', summary: 'Codex summary' })
    expect(thirdPage.nextCursor).toBeNull()
    expect(runtime.listThreadTurns).toHaveBeenCalledTimes(2)
    expect(runtime.listThreadTurns).toHaveBeenNthCalledWith(1, {
      threadId: 'thread-new-1',
      limit: 1,
      itemsView: 'full',
    })
    expect(runtime.listThreadTurns).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-new-1',
      cursor: 'provider-after-turn-1',
      limit: 1,
      itemsView: 'full',
    })
  })

  it('does not refetch from the beginning after draining a final cached provider turn with a larger page limit', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [makeMixedCodexTurn('turn-1')],
      }),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const firstPage: any = await adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1 })
    expect(firstPage.turns).toHaveLength(1)
    expect(firstPage.turns[0]).toMatchObject({ role: 'user' })

    const secondPage: any = await adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 30, cursor: firstPage.nextCursor })

    expect(secondPage.turns).toHaveLength(1)
    expect(secondPage.turns[0]).toMatchObject({ role: 'assistant' })
    expect(secondPage.turns.map((turn: any) => turn.turnId)).not.toContain(firstPage.turns[0].turnId)
    expect(secondPage.nextCursor).toBeNull()
    expect(runtime.listThreadTurns).toHaveBeenCalledTimes(1)
  })

  it('applies includeBodies to display-row limited pages with display turn body keys', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: 'provider-after-turn-1',
        turns: [makeMixedCodexTurn('turn-1')],
      }),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const page: any = await adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1, includeBodies: true })

    expect(page.turns).toHaveLength(1)
    expect(Object.keys(page.bodies)).toEqual([page.turns[0].turnId])
    expect(page.bodies[page.turns[0].turnId]).toMatchObject({ role: 'user' })
    expect(page.bodies).not.toHaveProperty('turn-1')
  })

  it('rejects malformed, cross-thread, expired, and stale-revision display cursors with typed errors', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: 'provider-after-turn-1',
        turns: [makeMixedCodexTurn('turn-1')],
      }),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
    const firstPage: any = await adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1 })

    await expect(adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1, cursor: 'not-a-codex-cursor' })).rejects.toBeInstanceOf(FreshAgentInvalidTurnCursorError)

    await expect(adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'other-thread',
    }, { revision: 7, limit: 1, cursor: firstPage.nextCursor })).rejects.toBeInstanceOf(FreshAgentInvalidTurnCursorError)

    await expect(adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 8, limit: 1, cursor: firstPage.nextCursor })).rejects.toBeInstanceOf(FreshAgentStaleThreadRevisionError)

    await adapter.shutdown?.()
    await expect(adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1, cursor: firstPage.nextCursor })).rejects.toBeInstanceOf(FreshAgentInvalidTurnCursorError)
  })

  it('throws a typed invalid display id error for malformed Codex display body ids', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.getTurnBody?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
      turnId: 'codex-display:v1:not-a-valid-envelope',
    }, 7)).rejects.toBeInstanceOf(FreshAgentInvalidDisplayIdError)
    expect(runtime.readThreadTurn).not.toHaveBeenCalled()
  })

  it('returns unprovable revision when an indexed display body no longer matches the provider turn body', async () => {
    const durableTurn = makeMixedCodexTurn('turn-1')
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [durableTurn],
      }),
      readThreadTurn: vi.fn().mockResolvedValue(makeCodexTurn('turn-1')),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
    const page: any = await adapter.getTurnPage?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, { revision: 7, limit: 1 })

    await expect(adapter.getTurnBody?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
      turnId: page.turns[0].turnId,
    }, 7)).rejects.toBeInstanceOf(FreshAgentUnprovableThreadRevisionError)
  })

  it('rescans display indexes through provider pagination before returning an exact miss', async () => {
    const targetTurn = makeMixedCodexTurn('turn-target')
    const targetDisplayTurnId = createCodexDisplayId({
      secret: DISPLAY_SECRET,
      threadId: 'thread-new-1',
      providerTurnId: 'turn-target',
      role: 'user',
      itemIds: ['turn-target:user'],
      partIndexes: [0],
    })
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn()
        .mockResolvedValueOnce({
          revision: 7,
          nextCursor: 'provider-page-2',
          turns: [makeCodexTurn('turn-before-target')],
        })
        .mockResolvedValueOnce({
          revision: 7,
          nextCursor: null,
          turns: [targetTurn],
        }),
      readThreadTurn: vi.fn().mockResolvedValue(targetTurn),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.getTurnBody?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
      turnId: targetDisplayTurnId,
    }, 7)).resolves.toMatchObject({
      turnId: targetDisplayTurnId,
      role: 'user',
      summary: 'Review the diff.',
    })
    expect(runtime.listThreadTurns).toHaveBeenNthCalledWith(1, {
      threadId: 'thread-new-1',
      limit: 100,
      itemsView: 'full',
    })
    expect(runtime.listThreadTurns).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-new-1',
      cursor: 'provider-page-2',
      limit: 100,
      itemsView: 'full',
    })
  })

  it('allocates separate runtimes for fresh Codex threads in different cwd values', async () => {
    const runtimes = ['/repo/one', '/repo/two'].map((cwd, index) => ({
      startThread: vi.fn().mockImplementation(async (input) => {
        if (input.cwd !== cwd) {
          throw new Error(`runtime ${index + 1} received unexpected cwd ${input.cwd}`)
        }
        return {
          threadId: `thread-${index + 1}`,
          wsUrl: `ws://127.0.0.1:${43000 + index}`,
        }
      }),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }))
    const runtimeFactory = vi.fn()
      .mockReturnValueOnce(runtimes[0])
      .mockReturnValueOnce(runtimes[1])
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: runtimeFactory as any })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo/one',
    })).resolves.toMatchObject({ sessionId: 'thread-1' })
    await expect(adapter.create({
      requestId: 'req-2',
      sessionType: 'freshcodex',
      cwd: '/repo/two',
    })).resolves.toMatchObject({ sessionId: 'thread-2' })

    expect(runtimeFactory).toHaveBeenCalledTimes(2)
    expect(runtimes[0].startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/one' }))
    expect(runtimes[1].startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/two' }))

    await adapter.shutdown?.()
    expect(runtimes[0].shutdown).toHaveBeenCalledTimes(1)
    expect(runtimes[1].shutdown).toHaveBeenCalledTimes(1)
  })

  it('starts fresh Codex threads with generated app-server params', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-resume-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-new-1'),
      }),
      listThreadTurns: vi.fn().mockResolvedValue({ turns: [], nextCursor: null, revision: 7 }),
      readThreadTurn: vi.fn().mockResolvedValue(null),
    }
    const adapter = createCodexFreshAgentAdapter({
      runtime: runtime as any,
    })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
      permissionMode: 'on-request',
      model: 'gpt-5.3-codex-spark',
    })).resolves.toEqual({ sessionId: 'thread-new-1', sessionRef: { provider: 'codex', sessionId: 'thread-new-1' } })

    await expect(adapter.resume?.({
      requestId: 'req-2',
      sessionType: 'freshcodex',
      resumeSessionId: 'thread-resume-1',
      cwd: '/repo',
      permissionMode: 'never',
      model: 'gpt-5.3-codex-spark',
    })).resolves.toEqual({ sessionId: 'thread-resume-1', sessionRef: { provider: 'codex', sessionId: 'thread-resume-1' } })

    expect(runtime.startThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      model: 'gpt-5.3-codex-spark',
      approvalPolicy: 'on-request',
    }))
    expect(runtime.startThread).toHaveBeenCalledWith(expect.not.objectContaining({
      excludeTurns: expect.anything(),
    }))
    expect(runtime.resumeThread).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-resume-1',
      cwd: '/repo',
      model: 'gpt-5.3-codex-spark',
      approvalPolicy: 'never',
    }))
  })

  it('fails clearly for Claude-only Freshcodex approval policies', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      permissionMode: 'bypassPermissions',
    })).rejects.toThrow('Freshcodex does not support approval policy "bypassPermissions"')
    expect(runtime.startThread).not.toHaveBeenCalled()
  })

  it('reads snapshots and turns from the official Codex thread APIs', async () => {
    const durableTurn = makeMixedCodexTurn('turn-1')
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: {
          ...makeCodexThread('thread-new-1'),
          turns: [durableTurn],
        },
      }),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [durableTurn],
      }),
      readThreadTurn: vi.fn().mockResolvedValue(durableTurn),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const snapshot: any = await adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1' }, 7)
    expect(snapshot).toMatchObject({
      provider: 'codex',
      threadId: 'thread-new-1',
      revision: 7,
    })
    expect(snapshot.turns).toHaveLength(2)
    expect(snapshot.turns[0]).toMatchObject({ role: 'user', ordinal: 0 })
    expect(snapshot.turns[1]).toMatchObject({ role: 'assistant', ordinal: 1 })
    expect(snapshot.turns[0].turnId).toMatch(/^codex-display:v1:[A-Za-z0-9_-]{22}$/)
    expect(snapshot.turns[1].turnId).toMatch(/^codex-display:v1:[A-Za-z0-9_-]{22}$/)
    expect(snapshot.turns[0].turnId).not.toContain('turn-1')
    expect(snapshot.turns[0]).not.toHaveProperty('providerTurnId')
    expect(runtime.readThread).toHaveBeenCalledWith({ threadId: 'thread-new-1', includeTurns: true })
    const page: any = await adapter.getTurnPage?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1' }, { revision: 7 })
    expect(page).toMatchObject({
      revision: 7,
      turns: [
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ],
    })
    expect(page.turns[1].items).toEqual([
      expect.objectContaining({ kind: 'reasoning' }),
      expect.objectContaining({ kind: 'text', text: 'The patch is safe.' }),
    ])
    expect(page.bodies[page.turns[1].turnId]).toMatchObject({ role: 'assistant' })
    await expect(adapter.getTurnBody?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1', turnId: page.turns[1].turnId }, 7)).resolves.toMatchObject({
      turnId: page.turns[1].turnId,
      revision: 7,
      items: [
        expect.objectContaining({ kind: 'reasoning' }),
        expect.objectContaining({ kind: 'text', text: 'The patch is safe.' }),
      ],
    })
    expect(runtime.readThreadTurn).toHaveBeenCalledWith({
      threadId: 'thread-new-1',
      turnId: 'turn-1',
      revision: 7,
    })
  })

  it('keeps display ids short and opaque for long native ids and item ids', async () => {
    const longProviderId = `turn-${'native-id-'.repeat(40)}`
    const longItemId = `item-${'item-id-'.repeat(40)}`
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: {
          ...makeCodexThread('thread-long-ids'),
          updatedAt: 11,
          turns: [{
            id: longProviderId,
            status: 'completed',
            items: [{ type: 'agentMessage', id: longItemId, text: 'Short public id' }],
          }],
        },
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const snapshot: any = await adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-long-ids',
    }, 11)

    expect(snapshot.turns[0].turnId).toMatch(/^codex-display:v1:[A-Za-z0-9_-]{22}$/)
    expect(snapshot.turns[0].turnId.length).toBeLessThan(45)
    expect(snapshot.turns[0].turnId).not.toContain(longProviderId.slice(0, 20))
    expect(snapshot.turns[0].turnId).not.toContain(longItemId.slice(0, 20))
  })

  it('does not pass unknown or malformed display ids to Codex body reads', async () => {
    const durableTurn = makeMixedCodexTurn('turn-1')
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: { ...makeCodexThread('thread-new-1'), turns: [durableTurn] },
      }),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [durableTurn],
      }),
      readThreadTurn: vi.fn().mockResolvedValue(durableTurn),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.getTurnBody?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
      turnId: 'codex-display:v1:not-a-valid-envelope',
    }, 7)).rejects.toBeInstanceOf(FreshAgentInvalidDisplayIdError)
    expect(runtime.readThreadTurn).not.toHaveBeenCalled()

    await expect(adapter.getTurnBody?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
      turnId: 'codex-display:v1:abcdefghijklmnopqrstu1',
    }, 7)).rejects.toBeInstanceOf(FreshAgentTurnNotFoundError)
    expect(runtime.readThreadTurn).not.toHaveBeenCalled()
  })

  it('returns stale revision when a display body read has no matching cached revision', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 9,
        nextCursor: null,
        turns: [makeMixedCodexTurn('turn-current')],
      }),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.getTurnBody?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
      turnId: 'codex-display:v1:abcdefghijklmnopqrstu1',
    }, 7)).rejects.toBeInstanceOf(FreshAgentStaleThreadRevisionError)
    expect(runtime.readThreadTurn).not.toHaveBeenCalled()
  })

  it('accepts native body ids only when they normalize to one display row', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn()
        .mockResolvedValueOnce(makeCodexTurn('turn-single'))
        .mockResolvedValueOnce(makeMixedCodexTurn('turn-mixed')),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const single: any = await adapter.getTurnBody?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
      turnId: 'turn-single',
    }, 7)
    expect(single.turnId).toMatch(/^codex-display:v1:/)
    expect(single.items).toEqual([expect.objectContaining({ text: 'Codex summary' })])

    await expect(adapter.getTurnBody?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
      turnId: 'turn-mixed',
    }, 7)).rejects.toThrow(/display turns/)
  })

  it('materializes submitted input rows until Codex returns the provider user message', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-submitted-1' }),
      readThread: vi.fn()
        .mockResolvedValueOnce({
          thread: {
            ...makeCodexThread('thread-new-1'),
            updatedAt: 8,
            turns: [{
              id: 'turn-submitted-1',
              status: 'inProgress',
              items: [{ type: 'agentMessage', id: 'assistant-1', text: 'Working on it.' }],
            }],
          },
        })
        .mockResolvedValueOnce({
          thread: {
            ...makeCodexThread('thread-new-1'),
            updatedAt: 9,
            turns: [{
              id: 'turn-submitted-1',
              status: 'completed',
              items: [
                { type: 'userMessage', id: 'real-user-1', content: [{ type: 'text', text: 'Review this image' }] },
                { type: 'agentMessage', id: 'assistant-1', text: 'Done.' },
              ],
            }],
          },
        }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const sendResult: any = await adapter.send?.('thread-new-1', {
      requestId: 'send-1',
      text: 'Review this image',
      images: [
        { kind: 'local', path: '/tmp/screenshot.png', mediaType: 'image/png' },
        { kind: 'data', mediaType: 'image/png', data: 'abc123' },
      ],
    })

    expect(sendResult).toMatchObject({
      requestId: 'send-1',
      submittedTurnId: expect.stringMatching(/^codex-display:v1:/),
    })
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      input: [
        { type: 'text', text: 'Review this image', text_elements: [] },
        { type: 'localImage', path: '/tmp/screenshot.png' },
        { type: 'image', url: 'data:image/png;base64,abc123' },
      ],
    }))

    const pendingSnapshot: any = await adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, 8)
    expect(pendingSnapshot.turns[0]).toMatchObject({
      turnId: sendResult.submittedTurnId,
      role: 'user',
      source: 'durable',
    })
    expect(pendingSnapshot.turns[0].summary).toBe('Review this image')

    const materializedSnapshot: any = await adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, 9)
    expect(materializedSnapshot.turns[0]).toMatchObject({
      turnId: sendResult.submittedTurnId,
      role: 'user',
    })
    expect(materializedSnapshot.turns.filter((turn: any) => turn.role === 'user')).toHaveLength(1)
  })

  it('keeps same-text queued submitted rows distinct by request id', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      startTurn: vi.fn()
        .mockResolvedValueOnce({ turnId: 'turn-submitted-1' })
        .mockResolvedValueOnce({ turnId: 'turn-submitted-2' }),
      readThread: vi.fn().mockResolvedValue({
        thread: {
          ...makeCodexThread('thread-new-1'),
          updatedAt: 8,
          turns: [
            {
              id: 'turn-submitted-1',
              status: 'inProgress',
              items: [{ type: 'agentMessage', id: 'assistant-1', text: 'Working.' }],
            },
            {
              id: 'turn-submitted-2',
              status: 'inProgress',
              items: [{ type: 'agentMessage', id: 'assistant-2', text: 'Still working.' }],
            },
          ],
        },
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const first: any = await adapter.send?.('thread-new-1', { requestId: 'send-1', text: 'Same prompt' })
    const second: any = await adapter.send?.('thread-new-1', { requestId: 'send-2', text: 'Same prompt' })
    const snapshot: any = await adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, 8)

    const userRows = snapshot.turns.filter((turn: any) => turn.role === 'user')
    expect(first.submittedTurnId).not.toBe(second.submittedTurnId)
    expect(userRows.map((turn: any) => turn.turnId)).toEqual([first.submittedTurnId, second.submittedTurnId])
  })

  it('reads a just-created Codex thread without turns when includeTurns is not materialized yet', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-empty-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      readThread: vi.fn()
        .mockRejectedValueOnce(new Error('Codex app-server thread/read failed: thread thread-empty-1 is not materialized yet; includeTurns is unavailable before first user message'))
        .mockResolvedValueOnce({
          thread: makeCodexThread('thread-empty-1'),
        }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await adapter.create({
      requestId: 'req-empty',
      sessionType: 'freshcodex',
      cwd: '/repo',
    })

    await expect(adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-empty-1',
    }, 0)).resolves.toMatchObject({
      threadId: 'thread-empty-1',
      status: 'idle',
      turns: [],
    })

    expect(runtime.readThread).toHaveBeenNthCalledWith(1, { threadId: 'thread-empty-1', includeTurns: true })
    expect(runtime.readThread).toHaveBeenNthCalledWith(2, { threadId: 'thread-empty-1', includeTurns: false })
  })

  it('lazily resumes a Codex runtime before reading a persisted thread after server reload', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-existing-1'),
      }),
      listThreadTurns: vi.fn().mockResolvedValue({ turns: [], nextCursor: null, revision: 7 }),
      readThreadTurn: vi.fn().mockResolvedValue(makeCodexTurn('turn-1')),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await expect(adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-existing-1',
    }, 7)).resolves.toMatchObject({
      provider: 'codex',
      threadId: 'thread-existing-1',
      revision: 7,
    })

    expect(runtime.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1' })
    expect(runtime.readThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1', includeTurns: true })

    await adapter.shutdown?.()
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
  })

  it('lazily resumes a Codex runtime in the saved cwd before reading a persisted thread after server reload', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-cwd',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-existing-cwd'),
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await expect(adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-existing-cwd',
      cwd: '/repo/persisted-worktree',
    } as any, 7)).resolves.toMatchObject({
      provider: 'codex',
      threadId: 'thread-existing-cwd',
    })

    expect(runtime.resumeThread).toHaveBeenCalledWith({
      threadId: 'thread-existing-cwd',
      cwd: '/repo/persisted-worktree',
    })

    await adapter.shutdown?.()
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent lazy runtime resumes for the same persisted thread', async () => {
    let resolveResume: ((value: { threadId: string; wsUrl: string }) => void) | undefined
    const resumePromise = new Promise<{ threadId: string; wsUrl: string }>((resolve) => {
      resolveResume = resolve
    })
    const off = vi.fn()
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockReturnValue(resumePromise),
      onThreadLifecycle: vi.fn(() => off),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-existing-1'),
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const runtimeFactory = vi.fn(() => runtime)
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: runtimeFactory as any })

    const snapshotPromise = adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-existing-1',
    }, 7)
    const subscribePromise = adapter.subscribe?.('thread-existing-1', vi.fn())

    resolveResume?.({ threadId: 'thread-existing-1', wsUrl: 'ws://127.0.0.1:43123' })
    await Promise.all([snapshotPromise, subscribePromise])

    expect(runtimeFactory).toHaveBeenCalledTimes(1)
    expect(runtime.resumeThread).toHaveBeenCalledTimes(1)
  })

  it('does not attach a lazy runtime resume that completes after the thread is killed', async () => {
    let resolveResume: ((value: { threadId: string; wsUrl: string }) => void) | undefined
    const resumePromise = new Promise<{ threadId: string; wsUrl: string }>((resolve) => {
      resolveResume = resolve
    })
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockReturnValue(resumePromise),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-existing-1'),
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    const snapshotPromise = adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-existing-1',
    }, 7)
    await Promise.resolve()
    await adapter.kill?.('thread-existing-1')
    resolveResume?.({ threadId: 'thread-existing-1', wsUrl: 'ws://127.0.0.1:43123' })

    await expect(snapshotPromise).rejects.toThrow(/resume was cancelled/)
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
    expect(runtime.readThread).not.toHaveBeenCalled()
  })

  it('lazily resumes a Codex runtime with send settings before starting a turn after server reload', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      forkThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-active-1' }),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await adapter.send?.('thread-existing-1', {
      text: 'Continue',
      settings: {
        requestId: 'req-1',
        sessionType: 'freshcodex',
        cwd: '/repo',
        model: 'gpt-5.3-codex-spark',
        permissionMode: 'never',
        sandbox: 'workspace-write',
      },
    })

    expect(runtime.resumeThread).toHaveBeenCalledWith({
      threadId: 'thread-existing-1',
      cwd: '/repo',
      model: 'gpt-5.3-codex-spark',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-existing-1',
      cwd: '/repo',
      model: 'gpt-5.3-codex-spark',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite' },
    }))
  })

  it('uses per-turn send models without relabeling earlier turns', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-2' }),
      readThread: vi.fn().mockResolvedValue({
        thread: {
          ...makeCodexThread('thread-new-1'),
          turns: [makeCodexTurn('turn-1'), makeCodexTurn('turn-2')],
        },
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
      model: 'gpt-5-codex',
    })
    await adapter.send?.('thread-new-1', {
      requestId: 'send-model-1',
      text: 'Use the small model',
      settings: { model: 'gpt-5.4-flash' },
    })

    const snapshot = await adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, 7) as any
    expect(snapshot.turns).toHaveLength(3)
    expect(snapshot.turns[0]).not.toHaveProperty('model')
    expect(snapshot.turns[1]).toMatchObject({ role: 'user', model: 'gpt-5.4-flash' })
    expect(snapshot.turns[2]).toMatchObject({ role: 'assistant', model: 'gpt-5.4-flash' })
  })

  it('subscribes to Codex lifecycle notifications and projects matching thread updates', async () => {
    let lifecycleHandler: ((event: any) => void) | undefined
    const off = vi.fn()
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      onThreadLifecycle: vi.fn((handler) => {
        lifecycleHandler = handler
        return off
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
    const listener = vi.fn()

    const unsubscribe = await adapter.subscribe?.('thread-new-1', listener)

    expect(runtime.onThreadLifecycle).toHaveBeenCalledWith(expect.any(Function))

    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'other-thread',
      status: { type: 'active', activeFlags: [] },
    })
    expect(listener).not.toHaveBeenCalled()

    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'thread-new-1',
      status: { type: 'active', activeFlags: [] },
    })
    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'thread-new-1',
      status: { type: 'idle' },
    })
    lifecycleHandler?.({
      kind: 'thread_closed',
      threadId: 'thread-new-1',
    })

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sdk.session.snapshot',
      sessionId: 'thread-new-1',
      status: 'running',
    }))
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sdk.session.snapshot',
      sessionId: 'thread-new-1',
      status: 'idle',
    }))
    expect(listener).toHaveBeenCalledWith({
      type: 'sdk.status',
      sessionId: 'thread-new-1',
      status: 'exited',
    })

    unsubscribe?.()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('emits a server-authoritative sdk.turn.complete only for a completed turn on the subscribed thread', async () => {
    let turnCompletedHandler: ((event: any) => void) | undefined
    const offLifecycle = vi.fn()
    const offTurnCompleted = vi.fn()
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      onThreadLifecycle: vi.fn(() => offLifecycle),
      onTurnCompleted: vi.fn((handler) => {
        turnCompletedHandler = handler
        return offTurnCompleted
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
    const listener = vi.fn()

    const unsubscribe = await adapter.subscribe?.('thread-new-1', listener)
    expect(runtime.onTurnCompleted).toHaveBeenCalledWith(expect.any(Function))

    // Real codex turn/completed carries the authoritative status inline at params.turn.status.
    // A completed turn on a different thread is ignored.
    turnCompletedHandler?.({
      threadId: 'other-thread',
      params: { threadId: 'other-thread', turn: { id: 'turn-x', status: 'completed' } },
    })
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.turn.complete' }))

    // An interrupted turn on the subscribed thread must NOT chime.
    turnCompletedHandler?.({
      threadId: 'thread-new-1',
      params: { threadId: 'thread-new-1', turn: { id: 'turn-1', status: 'interrupted' } },
    })
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.turn.complete' }))

    // A completed turn on the subscribed thread chimes exactly once.
    turnCompletedHandler?.({
      threadId: 'thread-new-1',
      params: { threadId: 'thread-new-1', turn: { id: 'turn-2', status: 'completed' } },
    })
    const completeCalls = listener.mock.calls.filter(([event]) => event?.type === 'sdk.turn.complete')
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0][0]).toMatchObject({ type: 'sdk.turn.complete', sessionId: 'thread-new-1' })
    expect(typeof completeCalls[0][0].at).toBe('number')

    unsubscribe?.()
    expect(offLifecycle).toHaveBeenCalledTimes(1)
    expect(offTurnCompleted).toHaveBeenCalledTimes(1)
  })

  it('emits a snapshot event after a codex turn completes so the client re-fetches the committed transcript', async () => {
    let lifecycleHandler: ((event: any) => void) | undefined
    let turnCompletedHandler: ((event: any) => void) | undefined
    const offLifecycle = vi.fn()
    const offTurnCompleted = vi.fn()
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      onThreadLifecycle: vi.fn((handler: any) => {
        lifecycleHandler = handler
        return offLifecycle
      }),
      onTurnCompleted: vi.fn((handler: any) => {
        turnCompletedHandler = handler
        return offTurnCompleted
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
    const listener = vi.fn()

    const unsubscribe = await adapter.subscribe?.('thread-new-1', listener)

    expect(runtime.onThreadLifecycle).toHaveBeenCalledWith(expect.any(Function))
    expect(runtime.onTurnCompleted).toHaveBeenCalledWith(expect.any(Function))

    // thread_status_changed(idle) fires BEFORE the completed turn is committed
    // to the app-server's thread history, so the client re-fetches but gets
    // an empty transcript. This produces one idle snapshot.
    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'thread-new-1',
      status: { type: 'idle' },
    })

    const idleSnapshotsBeforeCompletion = listener.mock.calls.filter(
      ([event]: any[]) => event?.type === 'sdk.session.snapshot' && event?.status === 'idle',
    )
    expect(idleSnapshotsBeforeCompletion).toHaveLength(1)

    // onTurnCompleted fires AFTER the turn is committed to the thread history.
    // The adapter must emit another snapshot-invalidating event so the client
    // re-fetches and renders the committed transcript (parity with freshopencode).
    turnCompletedHandler?.({ threadId: 'thread-new-1', turnId: 'turn-1', params: {} })

    const idleSnapshotsAfterCompletion = listener.mock.calls.filter(
      ([event]: any[]) => event?.type === 'sdk.session.snapshot' && event?.status === 'idle',
    )
    expect(idleSnapshotsAfterCompletion).toHaveLength(2)

    // Turn-completed events for other threads must not trigger emission.
    turnCompletedHandler?.({ threadId: 'other-thread', turnId: 'turn-2', params: {} })
    expect(idleSnapshotsAfterCompletion).toHaveLength(2)

    unsubscribe?.()
    expect(offLifecycle).toHaveBeenCalledTimes(1)
    expect(offTurnCompleted).toHaveBeenCalledTimes(1)
  })

  it('chimes for a flat params.status completion shape and skips a flat interrupted', async () => {
    // The app-server client passes the notification params straight through, and the
    // repo's own client tests model turn/completed as a FLAT { threadId, turnId, status }
    // (status at params.status, not params.turn.status). Freshcodex must detect that shape
    // too, or green/sound silently never fires.
    let turnCompletedHandler: ((event: any) => void) | undefined
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      onThreadLifecycle: vi.fn(() => vi.fn()),
      onTurnCompleted: vi.fn((handler) => {
        turnCompletedHandler = handler
        return vi.fn()
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
    const listener = vi.fn()
    await adapter.subscribe?.('thread-new-1', listener)

    turnCompletedHandler?.({ threadId: 'thread-new-1', params: { threadId: 'thread-new-1', turnId: 'turn-1', status: 'interrupted' } })
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.turn.complete' }))

    turnCompletedHandler?.({ threadId: 'thread-new-1', params: { threadId: 'thread-new-1', turnId: 'turn-2', status: 'completed' } })
    const completeCalls = listener.mock.calls.filter(([event]) => event?.type === 'sdk.turn.complete')
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0][0]).toMatchObject({ type: 'sdk.turn.complete', sessionId: 'thread-new-1' })
  })

  it('stamps a strictly-increasing at on successive completed turns even within the same millisecond', async () => {
    let turnCompletedHandler: ((event: any) => void) | undefined
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      onThreadLifecycle: vi.fn(() => vi.fn()),
      onTurnCompleted: vi.fn((handler) => {
        turnCompletedHandler = handler
        return vi.fn()
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
    const listener = vi.fn()
    await adapter.subscribe?.('thread-new-1', listener)

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(7000)
    try {
      turnCompletedHandler?.({ threadId: 'thread-new-1', params: { threadId: 'thread-new-1', turn: { id: 'turn-1', status: 'completed' } } })
      turnCompletedHandler?.({ threadId: 'thread-new-1', params: { threadId: 'thread-new-1', turn: { id: 'turn-2', status: 'completed' } } })
    } finally {
      nowSpy.mockRestore()
    }

    const ats = listener.mock.calls
      .map(([event]) => event)
      .filter((event) => event?.type === 'sdk.turn.complete')
      .map((event) => event.at)
    expect(ats).toHaveLength(2)
    expect(ats[1]).toBeGreaterThan(ats[0])
  })

  it('keeps the turn-complete clock monotonic per thread across a re-subscribe (WS reconnect)', async () => {
    // WS fresh-agent subscriptions are torn down and recreated on reconnect, but the
    // client store's dedupe state survives. The monotonic `at` clamp must therefore live
    // on per-thread adapter state (like Claude/OpenCode session state), not the subscribe
    // closure, or a same-ms / backward-clock completion right after a reconnect is dropped.
    let turnCompletedHandler: ((event: any) => void) | undefined
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      onThreadLifecycle: vi.fn(() => vi.fn()),
      onTurnCompleted: vi.fn((handler) => {
        turnCompletedHandler = handler
        return vi.fn()
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(9000)
    try {
      const firstListener = vi.fn()
      const unsub1 = await adapter.subscribe?.('thread-new-1', firstListener)
      turnCompletedHandler?.({ threadId: 'thread-new-1', params: { threadId: 'thread-new-1', turn: { id: 't1', status: 'completed' } } })
      unsub1?.()

      // Reconnect: a brand-new subscription to the same thread, same wall-clock ms.
      const secondListener = vi.fn()
      await adapter.subscribe?.('thread-new-1', secondListener)
      turnCompletedHandler?.({ threadId: 'thread-new-1', params: { threadId: 'thread-new-1', turn: { id: 't2', status: 'completed' } } })

      const firstAt = firstListener.mock.calls.map(([e]) => e).find((e) => e?.type === 'sdk.turn.complete')?.at
      const secondAt = secondListener.mock.calls.map(([e]) => e).find((e) => e?.type === 'sdk.turn.complete')?.at
      expect(firstAt).toBe(9000)
      expect(secondAt).toBeGreaterThan(firstAt)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('resets the per-thread turn-complete clock on shutdown (not just on reconnect)', async () => {
    // shutdown() must clear *all* per-thread state, including the turn-complete clock,
    // so a reused-in-process adapter never clamps a fresh completion against a stale
    // pre-shutdown timestamp. (A plain reconnect deliberately keeps the clock — see the
    // test above — but a full shutdown is a clean slate.)
    let turnCompletedHandler: ((event: any) => void) | undefined
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      onThreadLifecycle: vi.fn(() => vi.fn()),
      onTurnCompleted: vi.fn((handler) => {
        turnCompletedHandler = handler
        return vi.fn()
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    // Injected (non-owned) runtime survives shutdown(), so the post-shutdown resubscribe
    // reuses it and we can observe the clock starting fresh.
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(9000)
      const firstListener = vi.fn()
      await adapter.subscribe?.('thread-new-1', firstListener)
      turnCompletedHandler?.({ threadId: 'thread-new-1', params: { threadId: 'thread-new-1', turn: { id: 't1', status: 'completed' } } })

      await adapter.shutdown?.()

      // Reuse the same thread id after shutdown, with an *earlier* wall clock.
      nowSpy.mockReturnValue(5000)
      const secondListener = vi.fn()
      await adapter.subscribe?.('thread-new-1', secondListener)
      turnCompletedHandler?.({ threadId: 'thread-new-1', params: { threadId: 'thread-new-1', turn: { id: 't2', status: 'completed' } } })

      const firstAt = firstListener.mock.calls.map(([e]) => e).find((e) => e?.type === 'sdk.turn.complete')?.at
      const secondAt = secondListener.mock.calls.map(([e]) => e).find((e) => e?.type === 'sdk.turn.complete')?.at
      expect(firstAt).toBe(9000)
      // Without the shutdown reset, the stale 9000 would clamp this to 9001.
      expect(secondAt).toBe(5000)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('lazily resumes a Codex runtime before subscribing to a persisted thread after server reload', async () => {
    let lifecycleHandler: ((event: any) => void) | undefined
    const off = vi.fn()
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      onThreadLifecycle: vi.fn((handler) => {
        lifecycleHandler = handler
        return off
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })
    const listener = vi.fn()

    const unsubscribe = await adapter.subscribe?.('thread-existing-1', listener)

    expect(runtime.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1' })
    expect(runtime.onThreadLifecycle).toHaveBeenCalledWith(expect.any(Function))

    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'thread-existing-1',
      status: { type: 'active', activeFlags: [] },
    })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'thread-existing-1',
      status: 'running',
    }))
    lifecycleHandler?.({
      kind: 'thread_closed',
      threadId: 'thread-existing-1',
    })
    await vi.waitFor(() => {
      expect(runtime.shutdown).toHaveBeenCalledTimes(1)
    })

    unsubscribe?.()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('starts turns with Codex-shaped input/settings and interrupts the active turn', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      forkThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-active-1' }),
      interruptTurn: vi.fn().mockResolvedValue(undefined),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
      permissionMode: 'on-request',
      sandbox: 'workspace-write',
      effort: 'max',
      model: 'gpt-5.5',
    })

    await adapter.send?.('thread-new-1', {
      text: 'Review this image',
      images: [{ kind: 'data', mediaType: 'image/png', data: 'abc123' }],
    })
    await adapter.interrupt?.('thread-new-1')

    expect(runtime.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-new-1',
      input: [
        { type: 'text', text: 'Review this image', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,abc123' },
      ],
      cwd: '/repo',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite' },
      model: 'gpt-5.5',
      effort: 'xhigh',
    })
    expect(runtime.interruptTurn).toHaveBeenCalledWith({
      threadId: 'thread-new-1',
      turnId: 'turn-active-1',
    })
  })

  it('recovers an in-progress turn id before interrupting a restored running thread', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      readThread: vi.fn().mockResolvedValue({
        thread: {
          ...makeCodexThread('thread-existing-1'),
          status: { type: 'active', activeFlags: [] },
          turns: [
            makeCodexTurn('turn-done-1'),
            { ...makeCodexTurn('turn-active-1'), status: 'inProgress' },
          ],
        },
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      interruptTurn: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await adapter.interrupt?.('thread-existing-1')

    expect(runtime.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1' })
    expect(runtime.readThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1', includeTurns: true })
    expect(runtime.interruptTurn).toHaveBeenCalledWith({ threadId: 'thread-existing-1', turnId: 'turn-active-1' })
  })

  it('normalizes Freshcodex effort values against the requested model before app-server calls', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      forkThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-1' }),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      model: 'gpt-5.4-flash',
      effort: 'xhigh',
    })).resolves.toEqual({ sessionId: 'thread-new-1', sessionRef: { provider: 'codex', sessionId: 'thread-new-1' } })

    await adapter.send?.('thread-new-1', { text: 'reply ok' })

    expect(runtime.startThread).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-flash',
    }))
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-flash',
      effort: 'high',
    }))
  })

  it('forks Codex threads with stored runtime settings and excludeTurns', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      forkThread: vi.fn().mockResolvedValue({
        threadId: 'thread-fork-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
      model: 'gpt-5.3-codex-spark',
      permissionMode: 'never',
      sandbox: 'read-only',
    })

    await expect(adapter.fork?.('thread-new-1')).resolves.toEqual({
      threadId: 'thread-fork-1',
      wsUrl: 'ws://127.0.0.1:43123',
    })
    expect(runtime.forkThread).toHaveBeenCalledWith({
      threadId: 'thread-new-1',
      cwd: '/repo',
      model: 'gpt-5.3-codex-spark',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      excludeTurns: true,
    })
  })

  it('keeps a shared fork runtime alive until all sibling threads are released', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      forkThread: vi.fn().mockResolvedValue({
        threadId: 'thread-fork-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-fork-1'),
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
    })
    await adapter.fork?.('thread-new-1')

    await adapter.kill?.('thread-new-1')
    expect(runtime.shutdown).not.toHaveBeenCalled()
    await expect(adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-fork-1',
    }, 7)).resolves.toMatchObject({
      threadId: 'thread-fork-1',
    })

    await adapter.kill?.('thread-fork-1')
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
  })

  it('keeps an owned runtime retryable when final release shutdown fails', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      forkThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn()
        .mockRejectedValueOnce(new Error('teardown failed'))
        .mockResolvedValueOnce(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
    })
    await expect(adapter.kill?.('thread-new-1')).rejects.toThrow(/teardown failed/)
    await adapter.shutdown?.()

    expect(runtime.shutdown).toHaveBeenCalledTimes(2)
  })

  it('lazily resumes a Codex runtime before forking a persisted thread after server reload', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      forkThread: vi.fn().mockResolvedValue({
        threadId: 'thread-fork-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await expect(adapter.fork?.('thread-existing-1')).resolves.toEqual({
      threadId: 'thread-fork-1',
      wsUrl: 'ws://127.0.0.1:43123',
    })

    expect(runtime.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1' })
    expect(runtime.forkThread).toHaveBeenCalledWith({
      threadId: 'thread-existing-1',
      cwd: undefined,
      model: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      excludeTurns: true,
    })
  })
})
