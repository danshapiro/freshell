import AjvImport from 'ajv'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapturedMessage } from './ws-capture-client.js'

/**
 * Validates captured server→client messages against the FROZEN wire contract in
 * `port/contract/` — the shared source of truth for the TS original, the future
 * Rust `freshell-protocol` crate, and this oracle.
 *
 * ajv v6 caveat: the committed schemas declare `$schema: draft/2020-12` but only
 * use draft-07 keywords (they were synthesized permissively from the TS types).
 * ajv6 refuses unknown meta-schemas, so we strip `$schema` before compiling.
 */

// ── ajv6 CJS/ESM interop ──────────────────────────────────────────────────────
// ajv6 exports the constructor as `module.exports` (no `.default`). Normalize so
// this works under esbuild/vitest and Node ESM alike.
type CompiledValidator = ((data: unknown) => boolean) & {
  errors?: Array<Record<string, unknown>> | null
}
interface AjvInstance {
  compile(schema: unknown): CompiledValidator
}
type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance
const Ajv = ((AjvImport as unknown as { default?: unknown }).default ?? AjvImport) as AjvConstructor

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CONTRACT_DIR = path.resolve(__dirname, '../../contract')

interface ServerMessagesContract {
  wsProtocolVersion: number
  messageCount: number
  messages: Record<string, Record<string, unknown>>
}

interface WsProtocolContract {
  wsProtocolVersion: number
  schemaCount: number
  schemas: Record<string, Record<string, unknown>>
}

export interface ValidationResult {
  valid: boolean
  /** The message's `type` discriminant, if present. */
  type: string | undefined
  /** Whether a frozen schema exists for this message type. */
  known: boolean
  /** ajv validation errors (empty when valid). */
  errors: Array<Record<string, unknown>>
}

export interface NonconformantEntry {
  type: string | undefined
  tMs: number
  reason: 'no-schema' | 'schema-violation'
  errors: Array<Record<string, unknown>>
  raw: string
}

export interface TranscriptConformanceReport {
  /** Count of server→client messages inspected. */
  serverMessageCount: number
  /** Count that had a frozen schema AND validated cleanly. */
  validatedCount: number
  /** True iff there were zero unknown types AND zero schema violations. */
  allConformant: boolean
  /** Server→client types observed that have NO frozen schema (a real T0 finding). */
  unknownTypes: string[]
  /** Every message that failed (unknown type or schema violation). */
  nonconformant: NonconformantEntry[]
  /** Histogram of observed server→client types. */
  countByType: Record<string, number>
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

export class ContractValidator {
  readonly wsProtocolVersion: number
  readonly serverMessageTypes: string[]
  private readonly serverMessages: ServerMessagesContract
  private readonly wsProtocol: WsProtocolContract
  private readonly ajv: AjvInstance
  private readonly validators = new Map<string, CompiledValidator>()

  constructor(contractDir: string = CONTRACT_DIR) {
    this.serverMessages = loadJson<ServerMessagesContract>(
      path.join(contractDir, 'ws-server-messages.schema.json'),
    )
    this.wsProtocol = loadJson<WsProtocolContract>(path.join(contractDir, 'ws-protocol.schema.json'))

    if (this.serverMessages.wsProtocolVersion !== this.wsProtocol.wsProtocolVersion) {
      throw new Error(
        `Contract version mismatch: ws-server-messages=${this.serverMessages.wsProtocolVersion} ` +
          `ws-protocol=${this.wsProtocol.wsProtocolVersion}`,
      )
    }

    this.wsProtocolVersion = this.serverMessages.wsProtocolVersion
    this.serverMessageTypes = Object.keys(this.serverMessages.messages).sort()
    this.ajv = new Ajv({ allErrors: true })
  }

  /** True iff a frozen server→client schema exists for `type`. */
  hasServerMessageSchema(type: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.serverMessages.messages, type)
  }

  private validatorFor(type: string): CompiledValidator | null {
    const cached = this.validators.get(type)
    if (cached) return cached
    const schema = this.serverMessages.messages[type]
    if (!schema) return null
    // ajv6 rejects the draft/2020-12 meta-schema URI; the schemas only use
    // draft-07 keywords, so drop `$schema` before compiling.
    const { $schema: _drop, ...rest } = schema
    const validate = this.ajv.compile(rest)
    this.validators.set(type, validate)
    return validate
  }

  /**
   * Validate a single server→client message by looking up its schema via the
   * `type` discriminant in the frozen ws-server-messages contract.
   */
  validateServerMessage(msg: unknown): ValidationResult {
    const type =
      msg && typeof msg === 'object' && typeof (msg as { type?: unknown }).type === 'string'
        ? (msg as { type: string }).type
        : undefined

    if (type === undefined) {
      return {
        valid: false,
        type,
        known: false,
        errors: [{ message: 'message has no string "type" discriminant' }],
      }
    }

    const validate = this.validatorFor(type)
    if (!validate) {
      return {
        valid: false,
        type,
        known: false,
        errors: [{ message: `no frozen server→client schema for type "${type}"` }],
      }
    }

    const valid = validate(msg) === true
    return {
      valid,
      type,
      known: true,
      errors: valid ? [] : (validate.errors ?? []).map((e) => ({ ...e })),
    }
  }

  /**
   * Validate every server→client message in a captured transcript and return a
   * structured conformance report. A captured message that fails its frozen
   * schema — or whose type has no schema at all — is a REAL T0 finding.
   */
  assertTranscriptConformant(transcript: CapturedMessage[]): TranscriptConformanceReport {
    const serverMessages = transcript.filter((m) => m.dir === 'in')
    const nonconformant: NonconformantEntry[] = []
    const unknownTypes = new Set<string>()
    const countByType: Record<string, number> = {}
    let validatedCount = 0

    for (const m of serverMessages) {
      const key = m.type ?? '<no-type>'
      countByType[key] = (countByType[key] ?? 0) + 1

      const result = this.validateServerMessage(m.parsed)
      if (!result.known) {
        if (m.type) unknownTypes.add(m.type)
        nonconformant.push({
          type: m.type,
          tMs: m.tMs,
          reason: 'no-schema',
          errors: result.errors,
          raw: m.raw,
        })
        continue
      }
      if (!result.valid) {
        nonconformant.push({
          type: m.type,
          tMs: m.tMs,
          reason: 'schema-violation',
          errors: result.errors,
          raw: m.raw,
        })
        continue
      }
      validatedCount += 1
    }

    return {
      serverMessageCount: serverMessages.length,
      validatedCount,
      allConformant: nonconformant.length === 0,
      unknownTypes: [...unknownTypes].sort(),
      nonconformant,
      countByType,
    }
  }
}
