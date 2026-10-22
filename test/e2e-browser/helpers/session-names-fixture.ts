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

/** Write the name document. The one-time legacy consolidation is marked
 * complete (a machine past its first post-migration boot), so the boot
 * runs no import over the seeded records. */
export async function writeSessionNamesDocument(homeDir: string, records: SeedNameRecord[]): Promise<void> {
  const freshellDir = path.join(homeDir, '.freshell')
  await fs.mkdir(freshellDir, { recursive: true })
  const now = Date.now()
  let revision = 0
  const out: Record<string, unknown> = {}
  const generation: Record<string, unknown> = {}
  for (const record of records) {
    revision += 1
    const key = sessionNameKey(record.provider, record.sessionId)
    out[key] = {
      ref: { kind: 'session', provider: record.provider, sessionId: record.sessionId },
      name: record.name,
      source: record.source,
      revision,
      ...(record.source === 'manual' ? { manualRevision: revision, renamedAt: now } : {}),
    }
    if (record.restingGenerationInput !== undefined) {
      generation[key] = restingSeries(record.restingGenerationInput)
    }
  }
  const document = {
    version: 1,
    documentGeneration: 1,
    nextRevision: revision + 1,
    records: out,
    redirects: {},
    generation,
    migration: { completed: true },
  }
  await fs.writeFile(path.join(freshellDir, 'session-names.json'), JSON.stringify(document, null, 2))
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
