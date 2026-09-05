/**
 * HARNESS-04 — Amplifier session writer.
 *
 * Real layout (`server/coding-cli/providers/amplifier.ts`):
 *   $AMPLIFIER_HOME/projects/<project-slug>/sessions/<sessionId>/
 *     metadata.json   — session_id, working_dir, created, description_updated_at,
 *                       name (→ title, provider-generated), description (→ summary),
 *                       turn_count
 *     transcript.jsonl — role/content lines; first user message → preview
 *     events.jsonl     — live-activity sidecar
 *
 * Recency is `max(metadata timestamps, mtime(transcript.jsonl), mtime(events.jsonl))`
 * (`getActivityMtimeMs`), so every file is utimes-pinned to the seeded
 * `descriptionUpdatedAt` — otherwise build-time "now" silently dominates the
 */

import path from 'path'
import fsp from 'fs/promises'
import type { CorpusContext, CorpusSessionExpectation } from './types.js'
import { recordFile } from './manifest.js'

export interface AmplifierSessionSpec {
  role: string
  sessionId: string
  /** working_dir — becomes projectPath (modulo git-root resolution). */
  cwd: string
  /** Amplifier's AI-generated session title → provider-generated title. */
  name: string
  /** → wire summary. */
  description: string
  /** May be fractional; the parser floors it (parseTimestampMs). */
  created: number
  /** Integer epoch ms; drives lastActivityAt and the mtime pins. */
  descriptionUpdatedAt: number
  firstUserMessage?: string
  withEventsSidecar?: boolean
}

export async function writeAmplifierSession(
  ctx: CorpusContext,
  spec: AmplifierSessionSpec,
): Promise<CorpusSessionExpectation> {
  const slug = `${spec.role}-project`
  const dir = path.join(ctx.homeDir, '.amplifier', 'projects', slug, 'sessions', spec.sessionId)
  await fsp.mkdir(dir, { recursive: true })

  const metadata = {
    session_id: spec.sessionId,
    working_dir: spec.cwd,
    created: spec.created,
    description_updated_at: new Date(spec.descriptionUpdatedAt).toISOString(),
    name: spec.name,
    description: spec.description,
    turn_count: spec.firstUserMessage ? 1 : 0,
  }
  await fsp.writeFile(path.join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)

  const transcriptLines: string[] = []
  if (spec.firstUserMessage) {
    transcriptLines.push(JSON.stringify({ role: 'user', content: spec.firstUserMessage }))
    transcriptLines.push(JSON.stringify({ role: 'assistant', content: `${spec.name} reply 1` }))
  }
  await fsp.writeFile(path.join(dir, 'transcript.jsonl'), transcriptLines.map((l) => `${l}\n`).join(''))

  if (spec.withEventsSidecar) {
    await fsp.writeFile(
      path.join(dir, 'events.jsonl'),
      `${JSON.stringify({ type: 'prompt:complete', ts: spec.descriptionUpdatedAt })}\n`,
    )
  }

  // Pin ALL sidecar mtimes to the seeded activity instant BEFORE hashing, so
  // (a) the recency fold yields exactly descriptionUpdatedAt and (b) the
  // recorded hashes already reflect final bytes (utimes doesn't alter bytes).
  const pinDate = new Date(spec.descriptionUpdatedAt)
  const names = ['metadata.json', 'transcript.jsonl', ...(spec.withEventsSidecar ? ['events.jsonl'] : [])]
  for (const name of names) {
    await fsp.utimes(path.join(dir, name), pinDate, pinDate)
  }
  for (const name of names) {
    await recordFile(ctx.files, ctx.homeDir, path.join(dir, name), `amplifier-session:${spec.role}`)
  }

  const expectation: CorpusSessionExpectation = {
    key: `amplifier:${spec.sessionId}`,
    provider: 'amplifier',
    sessionId: spec.sessionId,
    role: spec.role,
    title: spec.name,
    summary: spec.description,
    projectPath: spec.cwd,
    cwd: spec.cwd,
    createdAt: Math.floor(spec.created),
    lastActivityAt: spec.descriptionUpdatedAt,
    visibility: 'listed',
  }
  ctx.sessions.push(expectation)
  return expectation
}
