import { beforeEach, describe, expect, it, vi } from 'vitest'
import { broadcastTerminalSessionAssociation } from '../../server/session-association-broadcast'
import { recordSessionLifecycleEvent } from '../../server/session-observability'

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
})
