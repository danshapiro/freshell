import assert from 'node:assert/strict'
import type { ErrorMessage } from '../../shared/ws-protocol.js'

type ManagedCreateOwner = {
  web: { capturedOutput(): { stdout: string; stderr: string } }
  runtime: { containerLogs(id: string): string; writeIncident(name: string, value: unknown): void }
  supervisor: { containerId: string }
}

export function assertManagedTerminalCreated(_owner: ManagedCreateOwner,
  response: ErrorMessage | { type: 'terminal.created' }) {
  assert.equal(response.type, 'terminal.created')
}
