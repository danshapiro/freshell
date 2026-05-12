// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { wireOpencodeActivityTracker } from '../../../../server/coding-cli/opencode-activity-wiring.js'

function makeRegistry(record: any) {
  const registry = new EventEmitter() as any
  registry.list = vi.fn(() => [])
  registry.get = vi.fn((terminalId: string) => (
    terminalId === record.terminalId ? record : undefined
  ))
  registry.bindSession = vi.fn(() => ({ ok: true }))
  registry.rebindSession = vi.fn(() => ({ ok: true }))
  return registry
}

describe('wireOpencodeActivityTracker', () => {
  it('notifies lifecycle callbacks for association', () => {
    const terminal = {
      terminalId: 'term-opencode-1',
      mode: 'opencode',
      status: 'running',
      resumeSessionId: undefined,
      opencodeServer: { hostname: '127.0.0.1', port: 32123 },
    }
    const registry = makeRegistry(terminal)
    const now = vi.fn(() => 12_345)
    const onAssociated = vi.fn()
    const wired = wireOpencodeActivityTracker({
      registry,
      now,
      onAssociated,
    })

    try {
      wired.tracker.emit('changed', {
        upsert: [{
          terminalId: 'term-opencode-1',
          sessionId: 'ses_open_1',
          phase: 'busy',
          updatedAt: 1,
        }],
        remove: [],
      })

      expect(onAssociated).toHaveBeenCalledWith({
        terminalId: 'term-opencode-1',
        sessionId: 'ses_open_1',
      })
    } finally {
      wired.dispose()
    }
  })
})
