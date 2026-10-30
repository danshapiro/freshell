import { describe, expect, it } from 'vitest'

import { projectPaneCreationProbe } from '../../../../scripts/testing/pane-creation-probe.js'

describe('body-free pane-creation probe projection', () => {
  it('distinguishes a missing request ID from a correlated create request with no reply', () => {
    const frames = [{ type: 'terminal.create', requestId: 'private-request-id-sentinel' }]
    const missingRequestId = projectPaneCreationProbe({
      terminalId: null, createRequestId: null, provider: 'codex', sentMessages: frames,
      receivedMessages: [], inventoryRead: 'ok', inventory: [],
    })
    const correlatedNoReply = projectPaneCreationProbe({
      terminalId: null, createRequestId: 'private-request-id-sentinel', provider: 'codex', sentMessages: frames,
      receivedMessages: [], inventoryRead: 'ok', inventory: [],
    })
    const requestNotObserved = projectPaneCreationProbe({
      terminalId: null, createRequestId: 'private-request-id-sentinel', provider: 'codex', sentMessages: [],
      receivedMessages: [], inventoryRead: 'ok', inventory: [],
    })

    expect(missingRequestId.terminalCreateResult).toBe('request_id_missing')
    expect(correlatedNoReply.terminalCreateResult).toBe('no_reply')
    expect(requestNotObserved.terminalCreateResult).toBe('request_not_observed')
    expect(missingRequestId).not.toEqual(correlatedNoReply)
  })

  it('correlates an error frame by request ID and projects only its recognized code', () => {
    const probe = projectPaneCreationProbe({
      terminalId: null, createRequestId: 'private-request-id-sentinel', provider: 'codex',
      sentMessages: [{ type: 'terminal.create', requestId: 'private-request-id-sentinel' }],
      receivedMessages: [
        { type: 'error', requestId: 'other-request', code: 'PTY_SPAWN_FAILED', message: 'unrelated message' },
        { type: 'error', requestId: 'private-request-id-sentinel', code: 'PTY_SPAWN_FAILED',
          message: 'private-error-message-sentinel', terminalId: 'private-error-terminal-sentinel' },
      ],
      inventoryRead: 'failed', inventory: null,
    })

    expect(probe).toEqual({
      terminalCreateResult: 'error', wireErrorCode: 'PTY_SPAWN_FAILED', inventoryRead: 'failed',
      matchingRowCount: 0, matchingRows: [],
    })
    expect(JSON.stringify(probe)).not.toContain('private-request-id-sentinel')
    expect(JSON.stringify(probe)).not.toContain('private-error-message-sentinel')
    expect(JSON.stringify(probe)).not.toContain('private-error-terminal-sentinel')
  })

  it('recognizes a created reply before pane state folds its terminal ID and matches inventory by request ID', () => {
    const probe = projectPaneCreationProbe({
      terminalId: null, createRequestId: 'private-request-id-sentinel', provider: 'codex',
      sentMessages: [{ type: 'terminal.create', requestId: 'private-request-id-sentinel' }],
      receivedMessages: [{ type: 'terminal.created', requestId: 'private-request-id-sentinel',
        terminalId: 'private-terminal-id-sentinel' }],
      inventoryRead: 'ok',
      inventory: [
        { terminalId: 'other-terminal', terminalCreateRequestId: 'other-request', launchState: 'running',
          provider: 'codex', containerId: 'other-container' },
        { terminalId: 'private-terminal-id-sentinel', terminalCreateRequestId: 'private-request-id-sentinel',
          launchState: 'starting', provider: 'codex', containerId: 'private-container-id-sentinel',
          soulId: 'private-soul-id-sentinel' },
      ],
    })

    expect(probe).toEqual({
      terminalCreateResult: 'created', inventoryRead: 'ok', matchingRowCount: 1,
      matchingRows: [{ launchState: 'starting', providerMatch: true, containerIdPresent: true }],
    })
    const serialized = JSON.stringify(probe)
    for (const sentinel of [
      'private-request-id-sentinel', 'private-terminal-id-sentinel', 'private-container-id-sentinel',
      'private-soul-id-sentinel', 'other-terminal', 'other-request',
    ]) expect(serialized).not.toContain(sentinel)
  })

  it('uses the folded terminal ID for inventory matching when it is available', () => {
    const probe = projectPaneCreationProbe({
      terminalId: 'private-terminal-id-sentinel', createRequestId: 'private-request-id-sentinel',
      provider: 'codex', sentMessages: [],
      receivedMessages: [{ type: 'terminal.created', requestId: 'private-request-id-sentinel',
        terminalId: 'private-terminal-id-sentinel' }],
      inventoryRead: 'ok',
      inventory: [
        { terminalId: 'other-terminal', terminalCreateRequestId: 'private-request-id-sentinel', launchState: 'running',
          provider: 'codex', containerId: 'wrong-container' },
        { terminalId: 'private-terminal-id-sentinel', terminalCreateRequestId: 'other-request', launchState: 'starting',
          provider: 'codex', containerId: 'private-container-id-sentinel' },
      ],
    })

    expect(probe.matchingRowCount).toBe(1)
    expect(probe.matchingRows).toEqual([{ launchState: 'starting', providerMatch: true, containerIdPresent: true }])
    expect(JSON.stringify(probe)).not.toContain('private-terminal-id-sentinel')
  })

  it('caps matching rows and omits IDs, message bodies, and unrelated inventory fields', () => {
    const probe = projectPaneCreationProbe({
      terminalId: null, createRequestId: 'private-request-id-sentinel', provider: 'codex',
      sentMessages: [{ type: 'terminal.create', requestId: 'private-request-id-sentinel', mode: 'secret-mode' }],
      receivedMessages: [{ type: 'error', requestId: 'private-request-id-sentinel', code: 'private-wire-code-sentinel',
        message: 'private-message-sentinel', prompt: 'private-prompt-sentinel' }],
      inventoryRead: 'ok',
      inventory: Array.from({ length: 10_005 }, (_, index) => ({
        terminalCreateRequestId: 'private-request-id-sentinel', terminalId: `private-terminal-${index}`,
        launchState: index % 2 ? 'running' : 'private-launch-state-sentinel', provider: 'codex',
        containerId: 'private-container-id-sentinel', nativeSessionId: 'private-session-id-sentinel',
      })),
    })

    expect(probe.terminalCreateResult).toBe('error')
    expect(probe).not.toHaveProperty('wireErrorCode')
    expect(probe.inventoryRead).toBe('ok')
    expect(probe.matchingRowCount).toBe(10_000)
    expect(probe.matchingRows).toHaveLength(8)
    expect(probe.matchingRows[0]).toEqual({ launchState: 'unknown', providerMatch: true, containerIdPresent: true })
    const serialized = JSON.stringify(probe)
    for (const sentinel of [
      'private-request-id-sentinel', 'private-terminal-', 'private-wire-code-sentinel',
      'private-message-sentinel', 'private-prompt-sentinel', 'private-launch-state-sentinel',
      'private-container-id-sentinel', 'private-session-id-sentinel',
    ]) expect(serialized).not.toContain(sentinel)
  })
})
