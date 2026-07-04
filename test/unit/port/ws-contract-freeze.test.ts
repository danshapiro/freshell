import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-version.js'
import {
  buildSchemaBundle,
  buildMessageInventory,
  serializeJson,
  SCHEMA_BUNDLE_PATH,
  MESSAGE_INVENTORY_PATH,
} from '../../../port/contract/generate-ws-contract.js'

/**
 * Frozen WebSocket wire contract — drift guard.
 *
 * These tests regenerate the language-neutral contract artifacts in-memory and
 * assert they are byte-for-byte identical to the committed files under
 * `port/contract/`. If someone edits `shared/ws-protocol.ts` (or a sibling
 * schema module) without re-running `npm run contract:generate`, these tests
 * fail — which is exactly the "frozen contract" guarantee the Rust port and the
 * equivalence oracle depend on.
 *
 * Pure in-process: imports the schemas, converts them, and compares. No server,
 * no dist rebuild, no network.
 */
describe('ws contract freeze', () => {
  it('committed JSON Schema bundle deep-equals a fresh regeneration', () => {
    const regenerated = buildSchemaBundle()
    const committed = JSON.parse(readFileSync(SCHEMA_BUNDLE_PATH, 'utf8'))
    expect(committed).toEqual(regenerated)
  })

  it('committed JSON Schema bundle is in canonical (deterministic) serialized form', () => {
    const regenerated = buildSchemaBundle()
    expect(readFileSync(SCHEMA_BUNDLE_PATH, 'utf8')).toBe(serializeJson(regenerated))
  })

  it('committed message inventory deep-equals a fresh regeneration', () => {
    const regenerated = buildMessageInventory()
    const committed = JSON.parse(readFileSync(MESSAGE_INVENTORY_PATH, 'utf8'))
    expect(committed).toEqual(regenerated)
  })

  it('committed message inventory is in canonical (deterministic) serialized form', () => {
    const regenerated = buildMessageInventory()
    expect(readFileSync(MESSAGE_INVENTORY_PATH, 'utf8')).toBe(serializeJson(regenerated))
  })

  it('committed contract version equals WS_PROTOCOL_VERSION', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_BUNDLE_PATH, 'utf8'))
    const inventory = JSON.parse(readFileSync(MESSAGE_INVENTORY_PATH, 'utf8'))
    expect(schema.wsProtocolVersion).toBe(WS_PROTOCOL_VERSION)
    expect(inventory.wsProtocolVersion).toBe(WS_PROTOCOL_VERSION)
  })

  it('inventory counts are internally consistent and the two directions are disjoint', () => {
    const inventory = buildMessageInventory()
    expect(inventory.clientToServer.count).toBe(inventory.clientToServer.types.length)
    expect(inventory.serverToClient.count).toBe(inventory.serverToClient.types.length)
    expect(inventory.clientToServer.count).toBeGreaterThan(0)
    expect(inventory.serverToClient.count).toBeGreaterThan(0)

    const overlap = inventory.clientToServer.types.filter((type) =>
      inventory.serverToClient.types.includes(type),
    )
    expect(overlap).toEqual([])
  })

  it('message-type discriminants are unique and sorted within each direction', () => {
    const inventory = buildMessageInventory()
    for (const direction of [inventory.clientToServer, inventory.serverToClient]) {
      const sorted = [...direction.types].sort()
      expect(direction.types).toEqual(sorted)
      expect(new Set(direction.types).size).toBe(direction.types.length)
    }
  })
})
