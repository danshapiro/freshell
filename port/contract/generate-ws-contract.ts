/**
 * Freeze the freshell WebSocket wire contract as a language-neutral artifact.
 *
 * This generator is the FIRST oracle deliverable for the Rust/Tauri port. It
 * reads the single source of truth — `shared/ws-protocol.ts` — and emits two
 * committed, deterministic files under `port/contract/`:
 *
 *   1. `ws-protocol.schema.json`     — a JSON Schema bundle covering every
 *      exported Zod schema, plus the `WS_PROTOCOL_VERSION`. The future Rust
 *      `freshell-protocol` crate generates its types from this; the equivalence
 *      oracle validates real traffic against it.
 *   2. `ws-message-inventory.json`   — the T0 conformance surface: the `type`
 *      discriminants of every client→server and server→client message.
 *
 * The bundle is produced idiomatically with zod 4's native `z.toJSONSchema()`,
 * falling back per-schema to `zod-to-json-schema` only if native conversion
 * throws. The message inventory is resolved authoritatively from the two
 * canonical union types (`ClientMessage`, `ServerMessage`) via the TypeScript
 * type checker, so it stays complete and drift-safe for both the Zod-validated
 * client surface and the TypeScript-only server surface.
 *
 * Run: `npm run contract:generate` (or `tsx port/contract/generate-ws-contract.ts`).
 * The drift guard `test/unit/port/ws-contract-freeze.test.ts` regenerates this
 * in-memory and fails if the committed files are stale.
 *
 * DO NOT edit the emitted JSON by hand. Changing the wire contract is out of
 * scope for the port — see `port/contract/README.md`.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import ts from 'typescript'
import * as wsProtocol from '../../shared/ws-protocol.js'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-version.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Repository root (this file lives at `<root>/port/contract/`). */
export const REPO_ROOT = path.resolve(__dirname, '../..')
/** Single source of truth for the wire contract. */
export const WS_PROTOCOL_SOURCE = path.join(REPO_ROOT, 'shared', 'ws-protocol.ts')
/** Committed JSON Schema bundle. */
export const SCHEMA_BUNDLE_PATH = path.join(__dirname, 'ws-protocol.schema.json')
/** Committed message-type inventory (T0 conformance surface). */
export const MESSAGE_INVENTORY_PATH = path.join(__dirname, 'ws-message-inventory.json')

const SOURCE_REL = 'shared/ws-protocol.ts'
const GENERATOR_REL = 'port/contract/generate-ws-contract.ts'

type JsonSchema = Record<string, unknown>
type ConverterName = 'zod-native' | 'zod-to-json-schema'

export interface SchemaBundle {
  title: string
  description: string
  wsProtocolVersion: number
  jsonSchemaDialect: string
  source: string
  generator: string
  schemaCount: number
  schemas: Record<string, JsonSchema>
}

export interface MessageInventory {
  title: string
  description: string
  wsProtocolVersion: number
  source: string
  generator: string
  clientToServer: { count: number; types: string[] }
  serverToClient: { count: number; types: string[] }
}

// ────────────────────────────────────────────────────────────────────────────
// Deterministic serialization
// ────────────────────────────────────────────────────────────────────────────

/**
 * Recursively sort object keys so serialization is stable across runs and
 * machines. Array order is preserved — it is semantically meaningful in JSON
 * Schema (`oneOf`, `enum`, `required`, `prefixItems`, …) and is already emitted
 * deterministically by the converters.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** Canonical, deterministic JSON with a trailing newline. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`
}

// ────────────────────────────────────────────────────────────────────────────
// JSON Schema bundle (runtime Zod introspection)
// ────────────────────────────────────────────────────────────────────────────

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function' &&
    '_zod' in (value as object)
  )
}

/**
 * Every exported Zod schema from `shared/ws-protocol.ts`, sorted by export name.
 *
 * Detection is structural (any exported `ZodType`) rather than by a `*Schema`
 * name pattern, so first-class wire enums that break the convention — notably
 * `ErrorCode` — are still frozen. A superset is the safe choice for a contract
 * freeze: it cannot silently drop part of the contract.
 */
export function collectExportedSchemas(): Array<[string, z.ZodType]> {
  return Object.entries(wsProtocol)
    .filter((entry): entry is [string, z.ZodType] => isZodSchema(entry[1]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Convert one schema, preferring zod-4 native, falling back per-schema. */
function convertSchema(name: string, schema: z.ZodType): { json: JsonSchema; converter: ConverterName } {
  try {
    const json = z.toJSONSchema(schema) as JsonSchema
    return { json, converter: 'zod-native' }
  } catch (nativeError) {
    try {
      const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as JsonSchema
      return { json, converter: 'zod-to-json-schema' }
    } catch (fallbackError) {
      throw new Error(
        `Unable to convert schema "${name}" to JSON Schema.\n` +
          `  zod-native:         ${(nativeError as Error).message}\n` +
          `  zod-to-json-schema: ${(fallbackError as Error).message}`,
      )
    }
  }
}

interface SchemaConversion {
  schemas: Record<string, JsonSchema>
  converters: Record<string, ConverterName>
  dialect: string
}

/** Convert every exported schema, tracking which converter each one used. */
function convertAllSchemas(): SchemaConversion {
  const schemas: Record<string, JsonSchema> = {}
  const converters: Record<string, ConverterName> = {}
  let dialect = 'https://json-schema.org/draft/2020-12/schema'

  for (const [name, schema] of collectExportedSchemas()) {
    const { json, converter } = convertSchema(name, schema)
    if (typeof json.$schema === 'string') dialect = json.$schema
    schemas[name] = json
    converters[name] = converter
  }
  return { schemas, converters, dialect }
}

function assembleBundle(schemas: Record<string, JsonSchema>, dialect: string): SchemaBundle {
  return {
    title: 'freshell WebSocket wire protocol — frozen contract',
    description:
      'Auto-generated from shared/ws-protocol.ts. DO NOT EDIT BY HAND. ' +
      'Regenerate with `npm run contract:generate`. Each entry in `schemas` is a ' +
      'self-contained JSON Schema for one exported Zod schema. The wire contract ' +
      'is frozen for the Rust port — changing it is out of scope.',
    wsProtocolVersion: WS_PROTOCOL_VERSION,
    jsonSchemaDialect: dialect,
    source: SOURCE_REL,
    generator: GENERATOR_REL,
    schemaCount: Object.keys(schemas).length,
    schemas,
  }
}

/** Build the full JSON Schema bundle object (does not write to disk). */
export function buildSchemaBundle(): SchemaBundle {
  const { schemas, dialect } = convertAllSchemas()
  return assembleBundle(schemas, dialect)
}

// ────────────────────────────────────────────────────────────────────────────
// Message inventory (authoritative TypeScript type-checker resolution)
// ────────────────────────────────────────────────────────────────────────────

let discriminantCache: { clientToServer: string[]; serverToClient: string[] } | null = null

function resolveMessageDiscriminants(): { clientToServer: string[]; serverToClient: string[] } {
  if (discriminantCache) return discriminantCache

  const program = ts.createProgram([WS_PROTOCOL_SOURCE], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
  })
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(WS_PROTOCOL_SOURCE)
  if (!sourceFile) throw new Error(`Could not load source file: ${WS_PROTOCOL_SOURCE}`)
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) throw new Error(`No module symbol for ${WS_PROTOCOL_SOURCE}`)
  const moduleExports = checker.getExportsOfModule(moduleSymbol)

  const discriminantsOf = (unionExportName: string): string[] => {
    const exportSymbol = moduleExports.find((symbol) => symbol.getName() === unionExportName)
    if (!exportSymbol) throw new Error(`Expected export "${unionExportName}" in ${SOURCE_REL}`)
    const unionType = checker.getDeclaredTypeOfSymbol(exportSymbol)
    const members = unionType.isUnion() ? unionType.types : [unionType]
    const discriminants = new Set<string>()
    for (const member of members) {
      const typeProp = member.getProperty('type')
      if (!typeProp) {
        throw new Error(
          `Member of ${unionExportName} has no "type" discriminant: ${checker.typeToString(member)}`,
        )
      }
      const propType = checker.getTypeOfSymbolAtLocation(typeProp, sourceFile)
      const literals = propType.isUnion() ? propType.types : [propType]
      let matched = false
      for (const literal of literals) {
        if (literal.isStringLiteral()) {
          discriminants.add(literal.value)
          matched = true
        }
      }
      if (!matched) {
        throw new Error(
          `Member of ${unionExportName} has a non-string-literal "type": ` +
            `${checker.typeToString(member)} (type=${checker.typeToString(propType)})`,
        )
      }
    }
    return [...discriminants].sort()
  }

  discriminantCache = {
    clientToServer: discriminantsOf('ClientMessage'),
    serverToClient: discriminantsOf('ServerMessage'),
  }
  return discriminantCache
}

/** Build the message-type inventory object (does not write to disk). */
export function buildMessageInventory(): MessageInventory {
  const { clientToServer, serverToClient } = resolveMessageDiscriminants()
  return {
    title: 'freshell WebSocket message inventory — T0 conformance surface',
    description:
      'Auto-generated from shared/ws-protocol.ts. DO NOT EDIT BY HAND. ' +
      'Regenerate with `npm run contract:generate`. `type` discriminants for ' +
      'every message in each direction, resolved from the ClientMessage and ' +
      'ServerMessage union types via the TypeScript type checker.',
    wsProtocolVersion: WS_PROTOCOL_VERSION,
    source: SOURCE_REL,
    generator: GENERATOR_REL,
    clientToServer: { count: clientToServer.length, types: clientToServer },
    serverToClient: { count: serverToClient.length, types: serverToClient },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────

function main(): void {
  const { schemas, converters, dialect } = convertAllSchemas()
  const bundle = assembleBundle(schemas, dialect)
  const inventory = buildMessageInventory()

  writeFileSync(SCHEMA_BUNDLE_PATH, serializeJson(bundle))
  writeFileSync(MESSAGE_INVENTORY_PATH, serializeJson(inventory))

  const fallbackSchemas = Object.entries(converters)
    .filter(([, converter]) => converter !== 'zod-native')
    .map(([name]) => name)

  console.log(`WS_PROTOCOL_VERSION: ${bundle.wsProtocolVersion}`)
  console.log(`JSON Schema dialect: ${bundle.jsonSchemaDialect}`)
  console.log(`Schemas frozen:      ${bundle.schemaCount} (${SCHEMA_BUNDLE_PATH})`)
  console.log(
    `  converters:        zod-native=${bundle.schemaCount - fallbackSchemas.length}` +
      `, zod-to-json-schema=${fallbackSchemas.length}` +
      (fallbackSchemas.length ? ` [${fallbackSchemas.join(', ')}]` : ''),
  )
  console.log(`Client→Server types: ${inventory.clientToServer.count}`)
  console.log(`Server→Client types: ${inventory.serverToClient.count}`)
  console.log(`Inventory written:   ${MESSAGE_INVENTORY_PATH}`)
}

const invokedFromCli = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false
if (invokedFromCli) {
  main()
}
