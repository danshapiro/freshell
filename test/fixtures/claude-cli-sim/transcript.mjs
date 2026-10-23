// Transcript (JSONL) persistence for the CLI simulator, shaped like the
// pinned CLI's files under CLAUDE_CONFIG_DIR/projects/<cwd slug>/<id>.jsonl:
//   - nothing is written until the session is materialized (its first
//     command), so a fresh or forked session leaves no file behind (T3, T6);
//   - lines are buffered and flushed in batches about 100 ms after they are
//     produced, so a reader sees the transcript "around the result" (T3);
//   - every line that carries a uuid extends one parentUuid chain;
//   - once the CLI is gone (its stream ended) nothing more is written, so a
//     caller may delete the config directory as soon as the stream ends;
//   - a fork copies the parent's lines through the fork point with their
//     uuids preserved, re-stamped with the child's session id (T6).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const CLI_VERSION = '2.1.237'

export function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude')
}

/** The CLI's project directory slug: every non-alphanumeric character becomes '-'. */
export function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

/** Locate `<sessionId>.jsonl` in any project directory, or null. */
export function findTranscript(configDir, sessionId) {
  const projects = path.join(configDir, 'projects')
  let dirs
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }) } catch { return null }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const candidate = path.join(projects, dir.name, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export function readTranscriptLines(file) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { lines.push(JSON.parse(line)) } catch { /* a torn last line is not part of the transcript */ }
  }
  return lines
}

export class Transcript {
  /**
   * @param {{configDir:string, cwd:string, sessionId:string, flushMs:(ms:number)=>number, prefix?:object[], existing?:string|null}} opts
   *   prefix: lines (already chained) copied in front of this session's own lines (a fork)
   *   existing: path of an existing transcript to continue (a resume)
   */
  constructor({ configDir, cwd, sessionId, flushMs, prefix = [], existing = null }) {
    this.cwd = cwd
    this.sessionId = sessionId
    this.flushMs = flushMs
    this.file = existing ?? path.join(configDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`)
    this.pending = prefix.map((line) => ({ ...line, sessionId }))
    this.materialized = existing !== null
    this.closed = false
    this.timer = null
    const known = existing ? readTranscriptLines(existing) : this.pending
    const chained = known.filter((line) => typeof line.uuid === 'string')
    this.lastUuid = chained.at(-1)?.uuid ?? null
    // The first prompt of a conversation carries the full context listing.
    this.hasPrompt = known.some((line) => line.type === 'user' && line.promptSource === 'sdk')
      || chained.some((line) => line.type === 'assistant')
  }

  common() {
    return {
      isSidechain: false,
      userType: 'external',
      entrypoint: 'sdk-ts',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: CLI_VERSION,
      gitBranch: 'HEAD',
    }
  }

  /** Append one chained line; returns its uuid. */
  append(fields) {
    const uuid = fields.uuid ?? randomUUID()
    this.pending.push({ parentUuid: this.lastUuid, ...this.common(), timestamp: new Date().toISOString(), ...fields, uuid })
    this.lastUuid = uuid
    this.schedule()
    return uuid
  }

  /** Append a bookkeeping line with no uuid (queue operations). */
  appendRaw(fields) {
    this.pending.push({ ...fields, timestamp: new Date().toISOString(), sessionId: this.sessionId })
    this.schedule()
  }

  /** The prompt's own lines: queue bookkeeping, the user line and its context attachments. */
  appendPrompt({ uuid, content, permissionMode }) {
    const promptId = randomUUID()
    this.appendRaw({ type: 'queue-operation', operation: 'enqueue', content: typeof content === 'string' ? content : undefined })
    this.appendRaw({ type: 'queue-operation', operation: 'dequeue' })
    this.append({ promptId, type: 'user', message: { role: 'user', content }, uuid, permissionMode, promptSource: 'sdk' })
    const attachments = this.hasPrompt
      ? [{ type: 'total_tokens_reminder', text: '<total_tokens>15000000 tokens left</total_tokens>' }]
      : [
          { type: 'agent_listing_delta', addedTypes: [], addedLines: [], removedTypes: [], isInitial: true },
          { type: 'skill_listing', content: '', skillCount: 0, isInitial: true, names: [] },
          { type: 'total_tokens_reminder', text: '<total_tokens>15000000 tokens left</total_tokens>' },
        ]
    for (const attachment of attachments) this.append({ type: 'attachment', attachment })
    this.hasPrompt = true
    return promptId
  }

  materialize() {
    if (this.materialized) return
    this.materialized = true
    this.schedule()
  }

  schedule() {
    if (this.closed || !this.materialized || this.timer || this.pending.length === 0) return
    this.timer = setTimeout(() => this.flush(), this.flushMs(100))
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.closed || !this.materialized || this.pending.length === 0) return
    const lines = this.pending.splice(0)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  }

  /** The CLI is gone: write what is buffered, then nothing more. */
  close() {
    this.flush()
    this.closed = true
  }
}

/**
 * The parent's lines through `at` (inclusive), for a fork. Throws the CLI's
 * own refusal text when `at` is not in the parent.
 */
export function forkPrefix(parentLines, at) {
  if (!at) return parentLines
  const index = parentLines.findIndex((line) => line.uuid === at)
  if (index < 0) throw new Error(`No message found with message.uuid of: ${at}`)
  return parentLines.slice(0, index + 1)
}
