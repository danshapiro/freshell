import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-version.js'
import {
  buildSchemaBundle,
  buildMessageInventory,
  buildServerMessageSchemas,
  crossCheckServerMessageSchemas,
  serializeJson,
  SCHEMA_BUNDLE_PATH,
  MESSAGE_INVENTORY_PATH,
  SERVER_MESSAGES_SCHEMA_PATH,
} from '../../../port/contract/generate-ws-contract.js'

/**
 * The server→client messages that ALSO carry a runtime Zod schema. These are
 * the overlap where the TypeScript-derived shape contract and the Zod-derived
 * contract must agree on required field names. If this set changes, the
 * cross-check below (and the contract's authority story) must be revisited.
 */
const ZOD_BACKED_SERVER_MESSAGES = [
  'claude.activity.list.response',
  'claude.activity.updated',
  'codex.activity.list.response',
  'codex.activity.updated',
  'opencode.activity.list.response',
  'opencode.activity.updated',
  'terminal.meta.updated',
  'terminal.turn.complete',
].sort()

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

/**
 * Frozen server→client message shapes — drift guard + completeness.
 *
 * The client surface is Zod-validated, but the server surface is TypeScript
 * types only. `ws-server-messages.schema.json` closes that oracle gap: it is a
 * JSON Schema for every server→client message shape, synthesized from the
 * `ServerMessage` union via the TypeScript type checker. These tests assert the
 * committed file is a byte-for-byte regeneration AND that every outbound
 * discriminant in the inventory is schematized (full outbound coverage is the
 * acceptance bar).
 */
describe('ws server→client message shapes', () => {
  it('committed server-messages schema deep-equals a fresh regeneration', () => {
    const regenerated = buildServerMessageSchemas()
    const committed = JSON.parse(readFileSync(SERVER_MESSAGES_SCHEMA_PATH, 'utf8'))
    expect(committed).toEqual(regenerated)
  })

  it('committed server-messages schema is in canonical (deterministic) serialized form', () => {
    const regenerated = buildServerMessageSchemas()
    expect(readFileSync(SERVER_MESSAGES_SCHEMA_PATH, 'utf8')).toBe(serializeJson(regenerated))
  })

  it('committed server-messages version equals WS_PROTOCOL_VERSION', () => {
    const committed = JSON.parse(readFileSync(SERVER_MESSAGES_SCHEMA_PATH, 'utf8'))
    expect(committed.wsProtocolVersion).toBe(WS_PROTOCOL_VERSION)
  })

  it('every committed server→client inventory discriminant has a committed schema entry (full outbound coverage)', () => {
    // Read the COMMITTED artifacts (not fresh regenerations) so this also fails
    // if either committed file drifts: an inventory entry with no schema, or a
    // schema entry for a discriminant that is not an advertised outbound message.
    const inventory = JSON.parse(readFileSync(MESSAGE_INVENTORY_PATH, 'utf8'))
    const serverMessages = JSON.parse(readFileSync(SERVER_MESSAGES_SCHEMA_PATH, 'utf8'))
    const outbound = [...inventory.serverToClient.types].sort()
    const schematized = Object.keys(serverMessages.messages).sort()

    expect(schematized).toEqual(outbound)
    expect(serverMessages.messageCount).toBe(inventory.serverToClient.count)
    expect(serverMessages.messageCount).toBe(schematized.length)
  })

  it('each server→client schema is a discriminated object keyed by its own type', () => {
    const bundle = buildServerMessageSchemas()
    for (const [discriminant, schema] of Object.entries(bundle.messages)) {
      expect(schema.type).toBe('object')
      const typeProp = (schema.properties as Record<string, { const?: unknown }>).type
      expect(typeProp?.const).toBe(discriminant)
      // The discriminant is always a required field.
      expect(schema.required).toContain('type')
    }
  })

  it('TS-derived and Zod-derived schemas agree on required field names for overlapping messages', () => {
    const result = crossCheckServerMessageSchemas()
    // The cross-check must actually run over the known Zod-backed overlap —
    // guard against it silently comparing nothing.
    expect(result.comparedDiscriminants).toEqual(ZOD_BACKED_SERVER_MESSAGES)
    // Zod is the inbound authority; the TS-derived shape must not diverge from
    // it on required field names. Any mismatch is reported, never reconciled.
    expect(result.mismatches).toEqual([])
  })
})
