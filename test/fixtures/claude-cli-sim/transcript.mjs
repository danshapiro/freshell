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

/** Locate a saved conversation by native id or absolute transcript path. */
export function findTranscript(configDir, sessionId) {
  if (typeof sessionId === 'string' && path.isAbsolute(sessionId)) {
    try { return fs.statSync(sessionId).isFile() ? sessionId : null } catch { return null }
  }
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

  /**
   * Append a line exactly as given (a replayed real-CLI line, replay.mjs).
   * A line with a uuid extends the chain like any other.
   */
  appendVerbatim(line) {
    this.pending.push(line)
    if (typeof line.uuid === 'string') this.lastUuid = line.uuid
    this.schedule()
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

// ── the --resume-drops-turn guard (T5; decision 2 of the core design) ───────
//
// A port of the pinned CLI's validator. A truncating resume that declares
// `resumeDropsTurn: D` is refused unless every entry it discards (the parent's
// chain entries after the fork point) is attributable to the turn D prompted:
// after any leading furniture, D's own prompt, then only that turn's assistant
// replies, tool results, system lines, meta lines and furniture attachments.
// A send absorbed mid-turn (a `queued_command` attachment), a task
// notification, another prompt or a compaction summary in the range refuses.

const INTERRUPT_MARKERS = ['[Request interrupted by user]', '[Request interrupted by user for tool use]']
const DECLINE_TEXT = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
const REJECT_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
const CORRECTION_NOTE = " Note: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions."
const CANCELLED_TOOL_TEXTS = new Set([...INTERRUPT_MARKERS, DECLINE_TEXT, DECLINE_TEXT + CORRECTION_NOTE, REJECT_TEXT, REJECT_TEXT + CORRECTION_NOTE])
const INTERRUPTION_PREFIXES = [...INTERRUPT_MARKERS, DECLINE_TEXT]
/** Attachment kinds the CLI treats as context furniture (the pinned CLI's list). */
const FURNITURE_ATTACHMENTS = new Set([
  'agent_listing_delta', 'agent_mention', 'peer_mention', 'already_read_file', 'attention_budget', 'audio_transcript',
  'auto_mode', 'auto_mode_exit', 'budget_usd', 'command_permissions', 'compact_file_reference', 'context_efficiency',
  'critical_system_reminder', 'date_change', 'deferred_tools_delta', 'diagnostics', 'directory', 'dynamic_skill',
  'edited_image_file', 'edited_text_file', 'file', 'goal_status', 'hook_additional_context', 'hook_blocking_error',
  'hook_cancelled', 'hook_deferred_tool', 'hook_error_during_execution', 'hook_non_blocking_error',
  'hook_permission_decision', 'hook_plugin_listing', 'hook_stopped_continuation', 'hook_success',
  'hook_system_message', 'invoked_skills', 'max_turns_reached', 'mcp_instructions_delta', 'mcp_dropped_tools_delta',
  'mcp_resource', 'memory_update', 'nested_memory', 'opened_file_in_ide', 'output_style', 'output_token_usage',
  'pdf_reference', 'plan_file_reference', 'plan_mode', 'plan_mode_exit', 'plan_mode_reentry', 'proactivity',
  'read_truncation_notice', 'bash_output_audience_note', 'relevant_memories', 'selected_lines_in_diff',
  'selected_lines_in_ide', 'silent_turn_reminder', 'skill_listing', 'structured_output', 'task_reminder',
  'team_context', 'teammate_shutdown_batch', 'todo_reminder', 'token_usage', 'tool_search_usage_reminder',
  'total_tokens_reminder', 'batching_reminder', 'batching_reminder_sent', 'ultra_effort_enter', 'ultra_effort_exit',
  'ultrathink_effort', 'workflow_keyword_request', 'workflow_size_guideline_change',
])
/** Furniture that still belongs to the kept turn when it leads the range. */
const KEPT_TURN_PAYLOAD = new Set(['mcp_resource', 'structured_output'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const contentOf = (line) => line.message?.content
const isHumanOrigin = (line) => line.origin === undefined || line.origin.kind === 'human' || line.origin.kind === 'auto-continuation'

function isInterruptMarker(line) {
  const content = contentOf(line)
  if (typeof content === 'string') return INTERRUPT_MARKERS.includes(content)
  return Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && INTERRUPT_MARKERS.includes(content[0].text)
}

function isCancelledToolBatch(line) {
  const content = contentOf(line)
  return Array.isArray(content) && content.length > 0
    && content.every((b) => b?.type === 'tool_result' && b.is_error === true && typeof b.content === 'string' && CANCELLED_TOOL_TEXTS.has(b.content))
}

function isAllToolResults(line) {
  const content = contentOf(line)
  return Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === 'tool_result')
}

function isInterruption(line) {
  if (line.type !== 'user') return false
  const content = contentOf(line)
  if (typeof content === 'string') return INTERRUPTION_PREFIXES.some((prefix) => content.startsWith(prefix))
  return Array.isArray(content) && content.length > 0 && content.every((b) => {
    const text = b?.type === 'text' ? b.text : (b?.type === 'tool_result' && b.is_error === true ? b.content : undefined)
    return typeof text === 'string' && INTERRUPTION_PREFIXES.some((prefix) => text.startsWith(prefix))
  })
}

function isSyntheticNoReply(line) {
  const content = contentOf(line)
  return line.message?.model === '<synthetic>' && Array.isArray(content) && content.length === 1
    && content[0]?.type === 'text' && content[0].text === 'No response requested.'
}

/** Entries the guard skips before the declared prompt. */
function isLeadingFurniture(line) {
  if (line.type === 'user') {
    return isHumanOrigin(line) && line.isCompactSummary !== true
      && (isInterruptMarker(line) || isCancelledToolBatch(line) || (line.isMeta === true && line.promptSource === undefined))
  }
  if (line.type === 'assistant') return isSyntheticNoReply(line)
  if (line.type === 'attachment') return !KEPT_TURN_PAYLOAD.has(line.attachment?.type) && FURNITURE_ATTACHMENTS.has(line.attachment?.type)
  return line.type === 'system' || line.type === 'progress'
}

function describeEntry(line, index) {
  const kind = line.type === 'attachment' ? ` (${line.attachment?.type})` : ''
  return `entry ${index} [type=${line.type}${kind}, uuid=${line.uuid}]`
}

/**
 * Why the CLI refuses a resume that discards `discarded` (chain entries in
 * file order) declaring the turn `declared`, or null when it accepts it.
 */
export function dropsTurnRefusal(discarded, declared) {
  if (!UUID_RE.test(declared)) return `declared turn id is not a UUID: ${declared}`
  let start = 0
  while (start < discarded.length && isLeadingFurniture(discarded[start])) start++
  if (start === discarded.length) return null
  const prompt = discarded[start]
  if (!(prompt.type === 'user' && prompt.uuid === declared)) return `range does not start with the declared turn prompt; first discarded ${describeEntry(prompt, start)}`
  if (prompt.isMeta === true || prompt.isCompactSummary === true || prompt.stackedExpansion === true || isInterruption(prompt) || isAllToolResults(prompt)) {
    return `declared turn id names a non-prompt user entry; ${describeEntry(prompt, start)}`
  }
  if (!isHumanOrigin(prompt)) return `declared turn id names an externally-sourced entry; ${describeEntry(prompt, start)}`
  if (discarded.slice(start).some((line) => line.type === 'attachment' && line.attachment?.type === 'poll_events')) return 'range contains a delivered poll-event record'
  for (let i = start + 1; i < discarded.length; i++) {
    const line = discarded[i]
    switch (line.type) {
      case 'assistant':
      case 'progress':
      case 'system':
        continue
      case 'attachment':
        if (line.attachment?.type === 'queued_command') return `range contains absorbed queued content; ${describeEntry(line, i)}`
        if (!FURNITURE_ATTACHMENTS.has(line.attachment?.type)) return `range contains a non-furniture attachment; ${describeEntry(line, i)}`
        continue
      case 'user':
        if (line.uuid === declared) continue
        if (line.isCompactSummary === true) return `range contains a compaction summary; ${describeEntry(line, i)}`
        if (!isHumanOrigin(line)) return `range contains an externally-sourced user entry; ${describeEntry(line, i)}`
        if (line.stackedExpansion === true || isInterruptMarker(line) || isAllToolResults(line)) continue
        if (line.isMeta === true && line.promptSource !== undefined) return `range contains a system-injected turn prompt; ${describeEntry(line, i)}`
        if (line.isMeta === true) continue
        return `range contains a user entry not attributable to the declared turn; ${describeEntry(line, i)}`
      default:
        return `range contains an unrecognized entry; ${describeEntry(line, i)}`
    }
  }
  return null
}
