import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  broadcastTerminalSessionAssociation,
  createTerminalSessionAssociationPublisher,
} from '../../server/session-association-broadcast'
import { recordSessionLifecycleEvent } from '../../server/session-observability'
import { TerminalMetadataService } from '../../server/terminal-metadata-service'

vi.mock('../../server/session-observability.js', () => ({
  recordSessionLifecycleEvent: vi.fn(),
}))

const SESSION_ID_ONE = '550e8400-e29b-41d4-a716-446655440000'
const SESSION_ID_TWO = '6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'

function createHarness() {
  const metaUpsert = {
    terminalId: 'term-meta',
    provider: 'claude',
    sessionId: SESSION_ID_ONE,
    updatedAt: 123,
  }
  return {
    wsHandler: {
      broadcast: vi.fn(),
    },
    terminalMetadata: {
      associateSession: vi.fn(() => metaUpsert),
    },
    broadcastTerminalMetaUpserts: vi.fn(),
    metaUpsert,
  }
}

function createPublisherHarness() {
  let now = 100
  const terminalMetadata = new TerminalMetadataService({
    now: () => ++now,
    git: {
      resolveCheckoutRoot: async (cwd) => cwd,
      resolveRepoRoot: async (cwd) => cwd,
      resolveBranchAndDirty: async () => ({}),
    },
  })
  const wsHandler = {
    broadcast: vi.fn(),
  }
  const broadcastTerminalMetaUpserts = vi.fn()
  const publisher = createTerminalSessionAssociationPublisher({
    wsHandler,
    terminalMetadata,
    broadcastTerminalMetaUpserts,
  })

  return {
    publisher,
    terminalMetadata,
    wsHandler,
    broadcastTerminalMetaUpserts,
  }
}

describe('broadcastTerminalSessionAssociation', () => {
  beforeEach(() => {
    vi.mocked(recordSessionLifecycleEvent).mockClear()
  })

  it('records and broadcasts Claude new-session associations once', () => {
    const {
      wsHandler,
      terminalMetadata,
      broadcastTerminalMetaUpserts,
      metaUpsert,
    } = createHarness()

    broadcastTerminalSessionAssociation({
      wsHandler,
      terminalMetadata,
      broadcastTerminalMetaUpserts,
      provider: 'claude',
      terminalId: 'term-claude',
      sessionId: SESSION_ID_ONE,
      source: 'claude_new_session',
    })

    expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
      kind: 'session_association_broadcast',
      provider: 'claude',
      terminalId: 'term-claude',
      sessionId: SESSION_ID_ONE,
      source: 'claude_new_session',
    })
    expect(wsHandler.broadcast).toHaveBeenCalledWith({
      type: 'terminal.session.associated',
      terminalId: 'term-claude',
      sessionRef: {
        provider: 'claude',
        sessionId: SESSION_ID_ONE,
      },
    })
    expect(terminalMetadata.associateSession).toHaveBeenCalledWith('term-claude', 'claude', SESSION_ID_ONE)
    expect(broadcastTerminalMetaUpserts).toHaveBeenCalledWith([metaUpsert])
    expect(recordSessionLifecycleEvent).toHaveBeenCalledTimes(1)
  })

  it('records indexer update associations with correlation fields', () => {
    const {
      wsHandler,
      terminalMetadata,
      broadcastTerminalMetaUpserts,
    } = createHarness()

    broadcastTerminalSessionAssociation({
      wsHandler,
      terminalMetadata,
      broadcastTerminalMetaUpserts,
      provider: 'codex',
      terminalId: 'term-codex',
      sessionId: SESSION_ID_TWO,
      source: 'indexer_update',
    })

    expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
      kind: 'session_association_broadcast',
      provider: 'codex',
      terminalId: 'term-codex',
      sessionId: SESSION_ID_TWO,
      source: 'indexer_update',
    })
  })

  it('records OpenCode controller associations', () => {
    const {
      wsHandler,
      terminalMetadata,
      broadcastTerminalMetaUpserts,
    } = createHarness()

    broadcastTerminalSessionAssociation({
      wsHandler,
      terminalMetadata,
      broadcastTerminalMetaUpserts,
      provider: 'opencode',
      terminalId: 'term-opencode',
      sessionId: 'opencode-session-1',
      source: 'opencode_controller',
    })

    expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
      kind: 'session_association_broadcast',
      provider: 'opencode',
      terminalId: 'term-opencode',
      sessionId: 'opencode-session-1',
      source: 'opencode_controller',
    })
  })

  it('dedupes repeated publications for the same provider/session/terminal pair', async () => {
    const {
      publisher,
      terminalMetadata,
      wsHandler,
      broadcastTerminalMetaUpserts,
    } = createPublisherHarness()

    await terminalMetadata.seedFromTerminal({
      terminalId: 'term-claude',
      mode: 'claude',
      cwd: '/tmp/project',
    })

    expect(publisher.publish({
      provider: 'claude',
      terminalId: 'term-claude',
      sessionId: SESSION_ID_ONE,
      source: 'claude_new_session',
    })).toBe('published')

    expect(publisher.publish({
      provider: 'claude',
      terminalId: 'term-claude',
      sessionId: SESSION_ID_ONE,
      source: 'indexer_update',
    })).toBe('deduped')

    expect(wsHandler.broadcast).toHaveBeenCalledTimes(1)
    expect(broadcastTerminalMetaUpserts).toHaveBeenCalledTimes(1)
    expect(terminalMetadata.get('term-claude')).toMatchObject({
      provider: 'claude',
      sessionId: SESSION_ID_ONE,
    })
  })

  it('publishes a pending association after terminal metadata is seeded', async () => {
    const {
      publisher,
      terminalMetadata,
      wsHandler,
      broadcastTerminalMetaUpserts,
    } = createPublisherHarness()

    expect(publisher.publish({
      provider: 'opencode',
      terminalId: 'term-opencode',
      sessionId: 'opencode-session-1',
      source: 'opencode_controller',
    })).toBe('pendingMetadata')

    expect(wsHandler.broadcast).not.toHaveBeenCalled()

    await expect(publisher.seedFromTerminal({
      terminalId: 'term-opencode',
      mode: 'opencode',
      cwd: '/tmp/project',
    })).resolves.toBe('published')

    expect(wsHandler.broadcast).toHaveBeenCalledWith({
      type: 'terminal.session.associated',
      terminalId: 'term-opencode',
      sessionRef: {
        provider: 'opencode',
        sessionId: 'opencode-session-1',
      },
    })
    expect(broadcastTerminalMetaUpserts).toHaveBeenCalledTimes(1)
    expect(terminalMetadata.get('term-opencode')).toMatchObject({
      provider: 'opencode',
      sessionId: 'opencode-session-1',
    })

    expect(publisher.publish({
      provider: 'opencode',
      terminalId: 'term-opencode',
      sessionId: 'opencode-session-1',
      source: 'indexer_update',
    })).toBe('deduped')
    expect(wsHandler.broadcast).toHaveBeenCalledTimes(1)
  })

  it('clears stale active metadata when a durable session rebinds to another terminal', async () => {
    const {
      publisher,
      terminalMetadata,
      wsHandler,
      broadcastTerminalMetaUpserts,
    } = createPublisherHarness()

    await terminalMetadata.seedFromTerminal({
      terminalId: 'term-old',
      mode: 'claude',
      cwd: '/tmp/project',
    })
    await terminalMetadata.seedFromTerminal({
      terminalId: 'term-new',
      mode: 'claude',
      cwd: '/tmp/project',
    })

    expect(publisher.publish({
      provider: 'claude',
      terminalId: 'term-old',
      sessionId: SESSION_ID_ONE,
      source: 'claude_new_session',
    })).toBe('published')

    expect(publisher.publish({
      provider: 'claude',
      terminalId: 'term-new',
      sessionId: SESSION_ID_ONE,
      source: 'indexer_update',
    })).toBe('rebound')

    expect(wsHandler.broadcast).toHaveBeenCalledTimes(2)
    expect(terminalMetadata.get('term-old')).toMatchObject({
      terminalId: 'term-old',
      cwd: '/tmp/project',
    })
    expect(terminalMetadata.get('term-old')?.provider).toBeUndefined()
    expect(terminalMetadata.get('term-old')?.sessionId).toBeUndefined()
    expect(terminalMetadata.get('term-new')).toMatchObject({
      provider: 'claude',
      sessionId: SESSION_ID_ONE,
    })
    expect(broadcastTerminalMetaUpserts).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ terminalId: 'term-old', provider: undefined, sessionId: undefined }),
      expect.objectContaining({ terminalId: 'term-new', provider: 'claude', sessionId: SESSION_ID_ONE }),
    ]))
  })

  it('deletes pending association metadata when a terminal exits before seed', async () => {
    const {
      publisher,
      wsHandler,
      broadcastTerminalMetaUpserts,
    } = createPublisherHarness()

    expect(publisher.publish({
      provider: 'opencode',
      terminalId: 'term-exit-before-seed',
      sessionId: 'opencode-session-1',
      source: 'opencode_controller',
    })).toBe('pendingMetadata')

    publisher.forgetTerminal('term-exit-before-seed')

    await expect(publisher.seedFromTerminal({
      terminalId: 'term-exit-before-seed',
      mode: 'opencode',
      cwd: '/tmp/reused',
    })).resolves.toBe('seeded')

    expect(wsHandler.broadcast).not.toHaveBeenCalled()
    expect(broadcastTerminalMetaUpserts).toHaveBeenCalledTimes(1)
    expect(broadcastTerminalMetaUpserts).toHaveBeenCalledWith([
      expect.objectContaining({
        terminalId: 'term-exit-before-seed',
        provider: 'opencode',
        sessionId: undefined,
      }),
    ])
  })
})
