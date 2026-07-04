/**
 * Freeze the freshell WebSocket wire contract as a language-neutral artifact.
 *
 * This generator is the FIRST oracle deliverable for the Rust/Tauri port. It
 * reads the single source of truth — `shared/ws-protocol.ts` — and emits three
 * committed, deterministic files under `port/contract/`:
 *
 *   1. `ws-protocol.schema.json`       — a JSON Schema bundle covering every
 *      exported Zod schema, plus the `WS_PROTOCOL_VERSION`. This is the inbound
 *      (client→server) runtime authority. The future Rust `freshell-protocol`
 *      crate generates its types from this; the oracle validates real traffic
 *      against it.
 *   2. `ws-server-messages.schema.json` — a JSON Schema for every server→client
 *      message shape (the outbound surface is TypeScript types only), keyed by
 *      `type` discriminant and synthesized from the `ServerMessage` union via
 *      the TypeScript type checker. This is the outbound shape contract.
 *   3. `ws-message-inventory.json`     — the T0 conformance surface: the `type`
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
/** Committed server→client message shape schemas (TypeScript-derived). */
export const SERVER_MESSAGES_SCHEMA_PATH = path.join(__dirname, 'ws-server-messages.schema.json')

/** JSON Schema dialect emitted for the TypeScript-derived server shapes. */
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'

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

interface TsModuleContext {
  checker: ts.TypeChecker
  sourceFile: ts.SourceFile
  moduleExports: ts.Symbol[]
}

let tsModuleContextCache: TsModuleContext | null = null

/**
 * Compile `shared/ws-protocol.ts` once and cache the type checker. Both the
 * message inventory and the server-message shape synthesis resolve types from
 * this single program, so imported types (`ServerSettings`, `ClientExtensionEntry`,
 * `SessionLocator`, `CodexDurabilityRef`, …) are fully resolved structurally.
 */
function getTsModuleContext(): TsModuleContext {
  if (tsModuleContextCache) return tsModuleContextCache

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

  tsModuleContextCache = { checker, sourceFile, moduleExports }
  return tsModuleContextCache
}

/** Resolve the declared type of a named export, or throw if it is missing. */
function getExportedType(name: string): ts.Type {
  const { checker, moduleExports } = getTsModuleContext()
  const exportSymbol = moduleExports.find((symbol) => symbol.getName() === name)
  if (!exportSymbol) throw new Error(`Expected export "${name}" in ${SOURCE_REL}`)
  return checker.getDeclaredTypeOfSymbol(exportSymbol)
}

/** Flatten a (possibly nested) discriminated union export into its members. */
function unionMembersOf(unionExportName: string): ts.Type[] {
  const unionType = getExportedType(unionExportName)
  // TypeScript flattens nested unions (e.g. `FreshAgentServerMessage` inside
  // `ServerMessage`), so `.types` already yields every leaf member.
  return unionType.isUnion() ? unionType.types : [unionType]
}

let discriminantCache: { clientToServer: string[]; serverToClient: string[] } | null = null

function resolveMessageDiscriminants(): { clientToServer: string[]; serverToClient: string[] } {
  if (discriminantCache) return discriminantCache
  const { checker, sourceFile } = getTsModuleContext()

  const discriminantsOf = (unionExportName: string): string[] => {
    const discriminants = new Set<string>()
    for (const member of unionMembersOf(unionExportName)) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Server→client message shapes (TypeScript type-checker synthesis)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server→client messages are TypeScript types only (the client trusts the
 * server and does not runtime-validate). To give the equivalence oracle a
 * schema for the EMITTED wire, we synthesize a JSON Schema for each member of
 * the `ServerMessage` union directly from the resolved TypeScript type.
 *
 * Conversion rules (faithful to the type; permissive only where the type is):
 *   - primitives           → { type: 'string' | 'number' | 'boolean' }
 *   - string/number lits    → { const } (single) / { enum } (union)
 *   - `type` discriminant   → { type: 'string', const: '<message type>' }
 *   - optional `k?: T`      → property present, omitted from `required`
 *   - objects               → { type: 'object', properties, required, additionalProperties }
 *   - arrays / tuples       → { type: 'array', items }
 *   - unions                → enum (all literals) or { anyOf } (otherwise)
 *   - unknown / any         → true      (opaque; see nondeterministic-fields.md)
 *   - index sigs / Record   → additionalProperties = <index schema> (true for unknown)
 *
 * A closed object gets `additionalProperties: false`; an object with a string
 * index signature stays open with the index type as `additionalProperties`.
 */

/** JSON Schema fragment; `true` represents the permissive "any value" schema. */
type JsonSchemaValue = JsonSchema | boolean

/**
 * A few TypeScript checker helpers used here are not on the public `.d.ts`
 * surface but are stable at runtime. Narrow them explicitly rather than reach
 * for `any`, so their use is intentional and typed.
 */
interface InternalTypeChecker extends ts.TypeChecker {
  isArrayType(type: ts.Type): boolean
  isTupleType(type: ts.Type): boolean
  getElementTypeOfArrayType(type: ts.Type): ts.Type | undefined
}

interface SynthContext {
  checker: InternalTypeChecker
  sourceFile: ts.SourceFile
}

/** Depth ceiling: a safety net against pathological/recursive types. */
const MAX_SYNTHESIS_DEPTH = 32

function collapseVariants(variants: JsonSchemaValue[]): JsonSchemaValue {
  return variants.length === 1 ? variants[0] : { anyOf: variants }
}

function enumOrConst(values: Array<string | number>, jsType: 'string' | 'number'): JsonSchema {
  return values.length === 1 ? { type: jsType, const: values[0] } : { type: jsType, enum: values }
}

function withNullable(schema: JsonSchemaValue, nullable: boolean): JsonSchemaValue {
  return nullable ? { anyOf: [schema, { type: 'null' }] } : schema
}

/** Locate a string index signature's value type (`Record<string, T>` → `T`). */
function stringIndexType(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  for (const info of checker.getIndexInfosOfType(type)) {
    if (info.keyType.flags & ts.TypeFlags.String) return info.type
  }
  return undefined
}

function isObjectLike(type: ts.Type, ctx: SynthContext): boolean {
  if (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) return true
  if (ctx.checker.getPropertiesOfType(type).length > 0) return true
  return stringIndexType(type, ctx.checker) !== undefined
}

function synthesizeUnion(
  type: ts.UnionType,
  ctx: SynthContext,
  seen: ReadonlySet<ts.Type>,
  depth: number,
): JsonSchemaValue {
  let nullable = false
  const kept: ts.Type[] = []
  for (const member of type.types) {
    // `undefined` in a property's type expresses optionality, which the owning
    // object records via `required` — so it never belongs in the value schema.
    if (member.flags & ts.TypeFlags.Undefined) continue
    if (member.flags & ts.TypeFlags.Null) {
      nullable = true
      continue
    }
    kept.push(member)
  }
  if (kept.length === 0) return nullable ? { type: 'null' } : true

  // `boolean` is modeled as the literal pair `true | false`.
  if (kept.every((m) => m.flags & ts.TypeFlags.BooleanLiteral)) {
    return withNullable({ type: 'boolean' }, nullable)
  }
  if (kept.every((m) => m.flags & ts.TypeFlags.StringLiteral)) {
    const values = kept.map((m) => (m as ts.StringLiteralType).value)
    return withNullable(enumOrConst(values, 'string'), nullable)
  }
  if (kept.every((m) => m.flags & ts.TypeFlags.NumberLiteral)) {
    const values = kept.map((m) => (m as ts.NumberLiteralType).value)
    return withNullable(enumOrConst(values, 'number'), nullable)
  }
  const variants = kept.map((m) => synthesizeType(m, ctx, seen, depth + 1))
  if (nullable) variants.push({ type: 'null' })
  return collapseVariants(variants)
}

function synthesizeObject(
  type: ts.Type,
  ctx: SynthContext,
  seen: ReadonlySet<ts.Type>,
  depth: number,
): JsonSchema {
  // Cycle guard: if this object type is already on the ancestor stack, stop.
  if (seen.has(type)) return { type: 'object' }
  const nextSeen = new Set(seen).add(type)

  const { checker, sourceFile } = ctx
  const properties: Record<string, JsonSchemaValue> = {}
  const required: string[] = []
  for (const prop of checker.getPropertiesOfType(type)) {
    const name = prop.getName()
    const propType = checker.getTypeOfSymbolAtLocation(prop, sourceFile)
    properties[name] = synthesizeType(propType, ctx, nextSeen, depth + 1)
    if (!(prop.flags & ts.SymbolFlags.Optional)) required.push(name)
  }

  const schema: JsonSchema = { type: 'object' }
  if (Object.keys(properties).length > 0) schema.properties = properties
  if (required.length > 0) schema.required = required.sort()

  const indexType = stringIndexType(type, checker)
  schema.additionalProperties = indexType ? synthesizeType(indexType, ctx, nextSeen, depth + 1) : false
  return schema
}

/** Recursively synthesize a JSON Schema fragment for a resolved TypeScript type. */
function synthesizeType(
  type: ts.Type,
  ctx: SynthContext,
  seen: ReadonlySet<ts.Type>,
  depth: number,
): JsonSchemaValue {
  if (depth > MAX_SYNTHESIS_DEPTH) return true
  const { checker } = ctx
  const flags = type.flags

  // Opaque values → permissive (see nondeterministic-fields.md).
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true
  if (flags & ts.TypeFlags.Null) return { type: 'null' }
  // `boolean` carries the Boolean flag on its synthetic union; catch it first.
  if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
  if (flags & ts.TypeFlags.BooleanLiteral) {
    return { type: 'boolean', const: (type as unknown as { intrinsicName: string }).intrinsicName === 'true' }
  }
  if (flags & ts.TypeFlags.StringLiteral) return { type: 'string', const: (type as ts.StringLiteralType).value }
  if (flags & ts.TypeFlags.String) return { type: 'string' }
  if (flags & ts.TypeFlags.NumberLiteral) return { type: 'number', const: (type as ts.NumberLiteralType).value }
  if (flags & ts.TypeFlags.Number) return { type: 'number' }

  if (type.isUnion()) return synthesizeUnion(type, ctx, seen, depth)

  if (checker.isArrayType(type)) {
    const element = checker.getElementTypeOfArrayType(type)
    return { type: 'array', items: element ? synthesizeType(element, ctx, seen, depth + 1) : true }
  }
  if (checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference)
    const variants = args.map((arg) => synthesizeType(arg, ctx, seen, depth + 1))
    return { type: 'array', items: variants.length > 0 ? collapseVariants(variants) : true }
  }

  if (isObjectLike(type, ctx)) return synthesizeObject(type, ctx, seen, depth)

  // Anything exotic that resisted resolution → permissive rather than wrong.
  return true
}

/** Extract the single string-literal `type` discriminant of a union member. */
function memberDiscriminant(member: ts.Type, ctx: SynthContext): string {
  const { checker, sourceFile } = ctx
  const typeProp = member.getProperty('type')
  if (!typeProp) {
    throw new Error(`ServerMessage member has no "type" discriminant: ${checker.typeToString(member)}`)
  }
  const propType = checker.getTypeOfSymbolAtLocation(typeProp, sourceFile)
  const literals = propType.isUnion() ? propType.types : [propType]
  const discriminants = literals
    .filter((literal): literal is ts.StringLiteralType => literal.isStringLiteral())
    .map((literal) => literal.value)
  if (discriminants.length !== 1) {
    throw new Error(
      `ServerMessage member must have exactly one string-literal "type" ` +
        `(found ${discriminants.length}): ${checker.typeToString(member)}`,
    )
  }
  return discriminants[0]
}

export interface ServerMessageSchemaBundle {
  title: string
  description: string
  wsProtocolVersion: number
  jsonSchemaDialect: string
  source: string
  generator: string
  authority: string
  messageCount: number
  messages: Record<string, JsonSchema>
}

/**
 * Build a JSON Schema for every server→client message shape, keyed by its
 * `type` discriminant. Does not write to disk.
 */
export function buildServerMessageSchemas(): ServerMessageSchemaBundle {
  const context = getTsModuleContext()
  const ctx: SynthContext = {
    checker: context.checker as InternalTypeChecker,
    sourceFile: context.sourceFile,
  }

  const messages: Record<string, JsonSchema> = {}
  for (const member of unionMembersOf('ServerMessage')) {
    const discriminant = memberDiscriminant(member, ctx)
    if (messages[discriminant]) {
      throw new Error(`Duplicate server→client discriminant "${discriminant}"`)
    }
    const shape = synthesizeObject(member, ctx, new Set(), 0)
    messages[discriminant] = { $schema: JSON_SCHEMA_DIALECT, ...shape }
  }

  return {
    title: 'freshell server→client message shapes — frozen contract',
    description:
      'Auto-generated from shared/ws-protocol.ts. DO NOT EDIT BY HAND. ' +
      'Regenerate with `npm run contract:generate`. Each entry is a JSON Schema for ' +
      'one server→client message shape, keyed by its `type` discriminant and ' +
      'synthesized from the ServerMessage union via the TypeScript type checker. ' +
      'Opaque values (unknown / index signatures / any) are intentionally permissive ' +
      '— see nondeterministic-fields.md. The wire contract is frozen for the Rust port.',
    wsProtocolVersion: WS_PROTOCOL_VERSION,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    source: SOURCE_REL,
    generator: GENERATOR_REL,
    authority:
      'Server→client messages are TypeScript types only; this file is their shape ' +
      'authority for the oracle. Inbound (client→server) runtime authority remains the ' +
      'Zod schemas frozen in ws-protocol.schema.json.',
    messageCount: Object.keys(messages).length,
    messages,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-check: TS-derived vs Zod-derived required fields (overlapping messages)
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerMessageCrossCheckMismatch {
  type: string
  schemaName: string
  requiredOnlyInTs: string[]
  requiredOnlyInZod: string[]
}

export interface ServerMessageCrossCheck {
  /** Discriminants compared (server→client messages that also have a Zod schema). */
  comparedDiscriminants: string[]
  mismatches: ServerMessageCrossCheckMismatch[]
}

/** Read a single string discriminant from a converted Zod JSON Schema, if any. */
function discriminantOfJsonSchema(schema: JsonSchema): string | null {
  const properties = schema.properties as Record<string, JsonSchema> | undefined
  const typeSchema = properties?.type
  if (!typeSchema) return null
  if (typeof typeSchema.const === 'string') return typeSchema.const
  const enumValues = typeSchema.enum
  if (Array.isArray(enumValues) && enumValues.length === 1 && typeof enumValues[0] === 'string') {
    return enumValues[0]
  }
  return null
}

function requiredNamesOf(schema: { required?: unknown }): Set<string> {
  return new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
}

/**
 * For every server→client message that ALSO has a runtime Zod schema, verify the
 * TypeScript-derived shape and the Zod-derived schema agree on required field
 * names. Mismatches are reported, never silently reconciled.
 */
export function crossCheckServerMessageSchemas(): ServerMessageCrossCheck {
  const zodRequiredByType = new Map<string, { schemaName: string; required: Set<string> }>()
  for (const [name, schema] of collectExportedSchemas()) {
    const { json } = convertSchema(name, schema)
    const discriminant = discriminantOfJsonSchema(json)
    if (discriminant === null) continue
    zodRequiredByType.set(discriminant, { schemaName: name, required: requiredNamesOf(json) })
  }

  const server = buildServerMessageSchemas()
  const comparedDiscriminants: string[] = []
  const mismatches: ServerMessageCrossCheckMismatch[] = []
  for (const discriminant of Object.keys(server.messages).sort()) {
    const zod = zodRequiredByType.get(discriminant)
    if (!zod) continue // server-only shape — no runtime Zod schema to compare against
    comparedDiscriminants.push(discriminant)

    const tsRequired = requiredNamesOf(server.messages[discriminant])
    const requiredOnlyInTs = [...tsRequired].filter((name) => !zod.required.has(name)).sort()
    const requiredOnlyInZod = [...zod.required].filter((name) => !tsRequired.has(name)).sort()
    if (requiredOnlyInTs.length > 0 || requiredOnlyInZod.length > 0) {
      mismatches.push({ type: discriminant, schemaName: zod.schemaName, requiredOnlyInTs, requiredOnlyInZod })
    }
  }
  return { comparedDiscriminants, mismatches }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────

function main(): void {
  const { schemas, converters, dialect } = convertAllSchemas()
  const bundle = assembleBundle(schemas, dialect)
  const inventory = buildMessageInventory()
  const serverMessages = buildServerMessageSchemas()
  const crossCheck = crossCheckServerMessageSchemas()

  writeFileSync(SCHEMA_BUNDLE_PATH, serializeJson(bundle))
  writeFileSync(MESSAGE_INVENTORY_PATH, serializeJson(inventory))
  writeFileSync(SERVER_MESSAGES_SCHEMA_PATH, serializeJson(serverMessages))

  const fallbackSchemas = Object.entries(converters)
    .filter(([, converter]) => converter !== 'zod-native')
    .map(([name]) => name)

  const missingOutbound = inventory.serverToClient.types.filter(
    (type) => !(type in serverMessages.messages),
  )

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
  console.log(
    `Server shapes frozen: ${serverMessages.messageCount}/${inventory.serverToClient.count}` +
      ` (${SERVER_MESSAGES_SCHEMA_PATH})`,
  )
  if (missingOutbound.length > 0) {
    throw new Error(`Incomplete outbound coverage — no schema for: ${missingOutbound.join(', ')}`)
  }
  console.log(
    `Zod cross-check:     ${crossCheck.comparedDiscriminants.length} overlapping,` +
      ` ${crossCheck.mismatches.length} required-field mismatch(es)`,
  )
  for (const mismatch of crossCheck.mismatches) {
    console.log(
      `  ! ${mismatch.type} (${mismatch.schemaName}): ` +
        `onlyTs=[${mismatch.requiredOnlyInTs.join(', ')}] onlyZod=[${mismatch.requiredOnlyInZod.join(', ')}]`,
    )
  }
}

const invokedFromCli = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false
if (invokedFromCli) {
  main()
}
