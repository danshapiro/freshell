import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FRESH_AGENT_INGRESS_INVENTORY,
  validateFreshAgentIngressInventory,
} from '../../../../scripts/testing/fresh-agent-ingress-inventory.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('fresh-agent executable structural inventory', () => {
  it('resolves every external ingress and its common supervisor operation', () => {
    expect(validateFreshAgentIngressInventory(repoRoot)).toHaveLength(12)
  })

  it('does not substitute one doorway for another', () => {
    expect(new Set(FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress)).size).toBe(12)
    expect(new Set(FRESH_AGENT_INGRESS_INVENTORY.map(({ sharedSupervisorOperation }) =>
      `${sharedSupervisorOperation.source}#${sharedSupervisorOperation.symbol}`,
    ))).toEqual(new Set(['crates/freshell-supervisor/src/service.rs#activate_prepared']))
  })
})
