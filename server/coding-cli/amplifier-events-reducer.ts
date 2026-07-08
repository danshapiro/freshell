/**
 * Pure reducer for Amplifier's `events.jsonl` lifecycle records.
 *
 * Implements the events-lane transition table of
 * docs/plans/2026-07-08-amplifier-session-durability-plan.md §6, restricted to
 * record inputs (PTY submit/output/exit and the submit-grace timer live in the
 * tracker; Phase 2). Imitates `opencode-ownership-reducer.ts`: no I/O, no
 * timers — `(state, record) -> { state, effects }`.
 *
 * Contract facts this encodes (plan §2):
 * - `prompt:submit` is the ONLY input that (re)enters busy (E2/E5).
 * - `prompt:complete` is the single turn boundary (E2/E3).
 * - `session:end` while busy ends the turn (E7); while idle it is ignored,
 *   which also makes orphan/duplicate `session:end` records legal (E7/E3).
 * - `session:resume` never implies a phase change (E7).
 * - Transitions key on event TYPE only; timestamps are carried through for
 *   `at` fields but never used to order or gate transitions (E3).
 * - Schema gate: `amplifier.log`, major version 1 (E10); anything else
 *   degrades the lane once and the reducer goes inert.
 * - `session:fork` / `session:start` with a `parent_id` are subagent
 *   indicators (plan §2 last rows) — observed in state, never effects.
 */

export type AmplifierLifecyclePhase = 'idle' | 'busy'

export type AmplifierParsedRecord = {
  ts?: string
  lvl?: string
  schema?: { name?: string; ver?: string }
  event: string
  session_id?: string
  data?: {
    parent_id?: string | null
    raw?: Record<string, unknown>
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

export type AmplifierReducerState = {
  phase: AmplifierLifecyclePhase
  /** Sticky: set by a schema-gate failure; the reducer ignores all further records. */
  degraded: boolean
  /** True once a subagent indicator was seen (`session:fork`, or `session:start` with `parent_id`). */
  subagent: boolean
  /** First `session_id` observed on any record. */
  sessionId?: string
}

export type AmplifierReducerEffect =
  | { kind: 'turn.began'; at?: string }
  | { kind: 'turn.completed'; at?: string }
  | { kind: 'session.identified'; sessionId?: string; cwd: string }
  | { kind: 'lane.degrade'; reason: AmplifierSchemaGateFailure }

export type AmplifierSchemaGateFailure =
  | 'schema_missing'
  | 'schema_name_mismatch'
  | 'schema_version_unsupported'

export type AmplifierReducerResult = {
  state: AmplifierReducerState
  effects: AmplifierReducerEffect[]
}

export const AMPLIFIER_LOG_SCHEMA_NAME = 'amplifier.log'
export const AMPLIFIER_LOG_SCHEMA_MAJOR = 1

export function createAmplifierReducerState(): AmplifierReducerState {
  return { phase: 'idle', degraded: false, subagent: false }
}

/**
 * Schema gate (plan §6, E10): accept `amplifier.log` major version 1;
 * anything else is a lane-degrade reason.
 */
export function checkAmplifierRecordSchema(
  record: AmplifierParsedRecord,
): AmplifierSchemaGateFailure | undefined {
  const schema = record.schema
  if (!schema || typeof schema !== 'object') return 'schema_missing'
  if (schema.name !== AMPLIFIER_LOG_SCHEMA_NAME) return 'schema_name_mismatch'
  const major = Number.parseInt(String(schema.ver ?? '').split('.')[0] ?? '', 10)
  if (!Number.isInteger(major) || major !== AMPLIFIER_LOG_SCHEMA_MAJOR) {
    return 'schema_version_unsupported'
  }
  return undefined
}

function isSubagentIndicator(record: AmplifierParsedRecord): boolean {
  if (record.event === 'session:fork') return true
  if (record.event === 'session:start') {
    const parentId = record.data?.parent_id
    return typeof parentId === 'string' && parentId.length > 0
  }
  return false
}

function sessionConfigCwd(record: AmplifierParsedRecord): string | undefined {
  const raw = record.data?.raw
  if (!raw || typeof raw !== 'object') return undefined
  const workingDir = raw.working_dir
  if (typeof workingDir === 'string' && workingDir.length > 0) return workingDir
  const projectDir = raw.project_dir
  if (typeof projectDir === 'string' && projectDir.length > 0) return projectDir
  return undefined
}

export function reduceAmplifierEvent(
  state: AmplifierReducerState,
  record: AmplifierParsedRecord,
): AmplifierReducerResult {
  if (state.degraded) {
    return { state, effects: [] }
  }

  const schemaFailure = checkAmplifierRecordSchema(record)
  if (schemaFailure) {
    return {
      state: { ...state, degraded: true },
      effects: [{ kind: 'lane.degrade', reason: schemaFailure }],
    }
  }

  let next = state
  if (!next.sessionId && typeof record.session_id === 'string' && record.session_id.length > 0) {
    next = { ...next, sessionId: record.session_id }
  }
  if (isSubagentIndicator(record) && !next.subagent) {
    next = { ...next, subagent: true }
  }

  switch (record.event) {
    case 'prompt:submit': {
      // The only input that (re)enters busy (E2/E5). busy -> busy is a
      // confirm, not a new turn: no duplicate turn.began.
      if (next.phase === 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'busy' },
        effects: [{ kind: 'turn.began', at: record.ts }],
      }
    }
    case 'prompt:complete': {
      // The single turn boundary (E2/E3). At idle it is just another
      // non-prompt:submit record: ignored.
      if (next.phase !== 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'idle' },
        effects: [{ kind: 'turn.completed', at: record.ts }],
      }
    }
    case 'session:end': {
      // Turn ended by quit/hangup (E7). Orphan/duplicate session:end at idle
      // is legal and ignored (E7 continue-attach, E3 out-of-order tail).
      if (next.phase !== 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'idle' },
        effects: [{ kind: 'turn.completed', at: record.ts }],
      }
    }
    case 'session:config': {
      const cwd = sessionConfigCwd(record)
      if (!cwd) return { state: next, effects: [] }
      return {
        state: next,
        effects: [{ kind: 'session.identified', sessionId: record.session_id, cwd }],
      }
    }
    case 'session:resume':
      // Resume does not imply busy; no phase change (E7).
      return { state: next, effects: [] }
    default:
      // Everything else (session:start, execution:*, provider:*, llm:*,
      // tool:*, content_block:*, orchestrator:*, cleanup:*, ...) never
      // changes phase. Post-complete background naming events are covered
      // here (E2): never a new turn.
      return { state: next, effects: [] }
  }
}
