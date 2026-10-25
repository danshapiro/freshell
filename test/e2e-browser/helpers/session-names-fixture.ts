import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Name-reliability Task 4: seed an owned server's home BEFORE boot with a
 * valid version-1 name document (`<home>/.freshell/session-names.json`) and
 * the provider transcripts its records name — the shape a real machine has
 * after the old builds saved junk names. No other e2e seeds the name
 * document; the field names follow the store's `StoredDocument` (camelCase
 * serde) and the wire `SessionNameRecord`.
 *
 * Only ever pointed at a spec-owned temp home (the `setupHome` hook of an
 * owned `RustServer`); never at a real `~/.freshell`.
 */

export type SeedNameSource =
  | 'directory'
  | 'first_message'
  | 'provider_ai'
  | 'freshell_ai'
  | 'legacy_protected'
  | 'manual'

export interface SeedNameRecord {
  provider: 'claude' | 'codex' | 'opencode'
  sessionId: string
  name: string
  source: SeedNameSource
  /** Name-reliability Task 5: the AI-naming input an old build absorbed
   * for this session at rest (an Idle, never-attempted generation series
   * holding this first message) — e.g. the wrapper text the old extraction
   * took as the first message. */
  restingGenerationInput?: string
}

/** The store's bounded generation excerpt (`PROMPT_MESSAGE_CHAR_CAP`
 * chars) and its input fingerprint (sha-256 hex of the excerpt). */
const PROMPT_MESSAGE_CHAR_CAP = 2000

function restingSeries(input: string): Record<string, unknown> {
  const excerpt = Array.from(input).slice(0, PROMPT_MESSAGE_CHAR_CAP).join('')
  return {
    status: 'idle',
    seriesId: `seeded-${createHash('sha256').update(input).digest('hex').slice(0, 12)}`,
    inputFingerprint: createHash('sha256').update(excerpt).digest('hex'),
    excerpt,
    consumed: 0,
  }
}

/** The store's record key for a durable session ref (`name_ref_key`). */
export function sessionNameKey(provider: string, sessionId: string): string {
  return JSON.stringify(['session', provider, sessionId])
}

interface SeededNameDocument {
  version: 1
  documentGeneration: number
  nextRevision: number
  records: Record<string, unknown>
  redirects: Record<string, unknown>
  generation: Record<string, unknown>
  migration: {
    completed: boolean
    acknowledgedCandidateIds?: string[]
    winningEvidence?: Record<string, unknown>
  }
}

/** A document whose one-time legacy consolidation is marked complete (a
 * machine past its first post-migration boot), so the boot runs no import
 * over the seeded records. */
function emptyNameDocument(): SeededNameDocument {
  return {
    version: 1,
    documentGeneration: 1,
    nextRevision: 1,
    records: {},
    redirects: {},
    generation: {},
    migration: { completed: true },
  }
}

/** Add `record` at the document's next revision; returns its key and
 * revision. */
function addRecord(document: SeededNameDocument, record: SeedNameRecord, now: number): { key: string; revision: number } {
  const revision = document.nextRevision
  document.nextRevision += 1
  const key = sessionNameKey(record.provider, record.sessionId)
  document.records[key] = {
    ref: { kind: 'session', provider: record.provider, sessionId: record.sessionId },
    name: record.name,
    source: record.source,
    revision,
    ...(record.source === 'manual' ? { manualRevision: revision, renamedAt: now } : {}),
  }
  if (record.restingGenerationInput !== undefined) {
    document.generation[key] = restingSeries(record.restingGenerationInput)
  }
  return { key, revision }
}

async function writeNameDocument(homeDir: string, serialized: string): Promise<void> {
  const freshellDir = path.join(homeDir, '.freshell')
  await fs.mkdir(freshellDir, { recursive: true })
  await fs.writeFile(path.join(freshellDir, 'session-names.json'), serialized)
}

/** Write the name document holding exactly `records`. */
export async function writeSessionNamesDocument(homeDir: string, records: SeedNameRecord[]): Promise<void> {
  const document = emptyNameDocument()
  const now = Date.now()
  for (const record of records) addRecord(document, record, now)
  await writeNameDocument(homeDir, JSON.stringify(document, null, 2))
}

/** Name-reliability Task 11 (RC9): the live machine's name document when
 * name reads were slow and failed — 5,000 records, 1,200 never-attempted
 * (idle) AI-naming series each holding a 1.5 KB first-message excerpt, and
 * 1,600 acknowledged migration candidate ids with their winning evidence;
 * at least 4.5 MB in all. */
export const LIVE_SIZE_NAME_DOCUMENT = {
  records: 5_000,
  idleSeries: 1_200,
  excerptChars: 1_536,
  acknowledgedIds: 1_600,
  minBytes: 4_500_000,
} as const

/** Write a live-size name document: `records` (the sessions a spec uses)
 * plus synthetic sessions that no provider index knows, filling it to the
 * {@link LIVE_SIZE_NAME_DOCUMENT} shape. Written compactly, the way the
 * store writes it. Returns the document's size in bytes. */
export async function writeSessionNamesLoadDocument(homeDir: string, records: SeedNameRecord[]): Promise<number> {
  const shape = LIVE_SIZE_NAME_DOCUMENT
  const document = emptyNameDocument()
  const now = Date.now()
  for (const record of records) addRecord(document, record, now)
  const acknowledged: string[] = []
  const evidence: Record<string, unknown> = {}
  for (let i = 0; i < shape.records - records.length; i += 1) {
    const n = String(i).padStart(4, '0')
    const name = `Investigate the importer regression number ${n} in the build pipeline`
    const { key, revision } = addRecord(document, {
      provider: 'claude',
      sessionId: `5e55${n}-0000-4000-8000-00000000${n}`,
      name,
      source: 'first_message',
      ...(i < shape.idleSeries
        ? { restingGenerationInput: `First message ${n}: `.padEnd(shape.excerptChars, 'x') }
        : {}),
    }, now)
    if (i < shape.acknowledgedIds) {
      const candidateId = `import-${n}-0000-4000-8000-000000000000:freshell.layout.v3.window-${n}:tab-${n}-0000-4000-8000-000000000000:pane-${n}-0000-4000-8000-000000000000:title`
      acknowledged.push(candidateId)
      evidence[key] = {
        candidateId,
        name,
        source: 'first_message',
        scope: 'session',
        evidenceKey: `freshell.layout.v3.window-${n}-0000-4000-8000-000000000000`,
        installedRevision: revision,
      }
    }
  }
  document.migration.acknowledgedCandidateIds = acknowledged
  document.migration.winningEvidence = evidence
  const serialized = JSON.stringify(document)
  const bytes = Buffer.byteLength(serialized)
  if (bytes < shape.minBytes) {
    throw new Error(`the live-size name document is ${bytes} bytes, below ${shape.minBytes}`)
  }
  await writeNameDocument(homeDir, serialized)
  return bytes
}

/** Real Claude Code project dir name: every non-alphanumeric rune → '-'. */
function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface ClaudeTranscriptSpec {
  sessionId: string
  cwd: string
  /** The user prompts in order; each gets an assistant reply. Two or more
   * keep the session interactive (visible under the sidebar's default
   * filter). */
  prompts: string[]
  /** Raw JSONL records written BEFORE the prompts (for example the caveat →
   * command → stdout records a slash command leaves). */
  leadingRecords?: Array<Record<string, unknown>>
}

/** Write one real-shape Claude transcript (`projects/<slug>/<id>.jsonl`:
 * a `system`/`init` line, then parent-chained user/assistant turns) whose
 * first user message is exactly `prompts[0]`. */
export async function writeClaudeTranscript(homeDir: string, spec: ClaudeTranscriptSpec): Promise<string> {
  const dir = path.join(homeDir, '.claude', 'projects', claudeProjectSlug(spec.cwd))
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${spec.sessionId}.jsonl`)
  const createdAt = Date.now() - 60_000
  const base = (offset: number) => ({
    cwd: spec.cwd,
    version: '2.1.23',
    gitBranch: 'main',
    timestamp: new Date(createdAt + offset).toISOString(),
    sessionId: spec.sessionId,
  })
  const lines: string[] = []
  let previous = `${spec.sessionId}-sys`
  lines.push(JSON.stringify({ ...base(0), type: 'system', subtype: 'init', session_id: spec.sessionId, uuid: previous }))
  let offset = 1
  for (const [index, record] of (spec.leadingRecords ?? []).entries()) {
    const uuid = `${spec.sessionId}-lead${index}`
    lines.push(JSON.stringify({ ...base(offset), parentUuid: previous, uuid, ...record }))
    previous = uuid
    offset += 1
  }
  spec.prompts.forEach((prompt, index) => {
    const userUuid = `${spec.sessionId}-u${index}`
    const assistantUuid = `${spec.sessionId}-a${index}`
    lines.push(JSON.stringify({
      ...base(offset),
      parentUuid: previous,
      type: 'user',
      message: { role: 'user', content: prompt },
      uuid: userUuid,
    }))
    lines.push(JSON.stringify({
      ...base(offset + 1),
      parentUuid: userUuid,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `Reply ${index + 1}` }],
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      uuid: assistantUuid,
    }))
    previous = assistantUuid
    offset += 2
  })
  await fs.writeFile(file, `${lines.join('\n')}\n`)
  return file
}
