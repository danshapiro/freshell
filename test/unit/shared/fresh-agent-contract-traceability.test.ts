import { describe, expect, it } from 'vitest'

import { FRESH_AGENT_CONTRACT_SCHEMA_NAMES } from '../../../shared/fresh-agent-contract.js'
import { FRESH_AGENT_CONTRACT_TRACEABILITY } from '../../fixtures/fresh-agent/contract-traceability.js'

describe('fresh-agent contract traceability', () => {
  it('assigns every shared schema to producers, parsers, state, UI, fixtures, and tests', () => {
    expect(FRESH_AGENT_CONTRACT_TRACEABILITY.map((entry) => entry.schema).sort()).toEqual(
      [...FRESH_AGENT_CONTRACT_SCHEMA_NAMES].sort(),
    )

    for (const entry of FRESH_AGENT_CONTRACT_TRACEABILITY) {
      expect(entry.producers.length, `${entry.schema} producers`).toBeGreaterThan(0)
      expect(entry.serverParser, `${entry.schema} serverParser`).toMatch(/\S/)
      expect(entry.clientParser, `${entry.schema} clientParser`).toMatch(/\S/)
      expect(entry.stateOwner, `${entry.schema} stateOwner`).toMatch(/\S/)
      expect(entry.uiConsumer, `${entry.schema} uiConsumer`).toMatch(/\S/)
      expect(entry.fixtures.length, `${entry.schema} fixtures`).toBeGreaterThan(0)
      expect(entry.tests.length, `${entry.schema} tests`).toBeGreaterThan(0)
    }
  })
})
