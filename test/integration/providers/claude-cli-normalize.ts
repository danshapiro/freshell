// Normalized traces for the simulator conformance suite.
//
// claude-cli-conformance.test.ts runs every scenario on the real CLI and on
// the simulator (test/fixtures/claude-cli-sim/query.mjs) and requires the two
// normalized traces to be equal. Normalization keeps what the sidecar and the
// Rust runtime depend on and drops what is timing noise:
//   - every uuid is already a scenario label (claude-cli-trace.ts relabel);
//   - inputs (pushes, interrupt calls) are dropped: their effects are visible
//     as lifecycle frames, and their position relative to outputs is racy;
//   - runs of stream_event frames collapse to one "stream" token;
//   - frames from a subagent (parent_tool_use_id set, except tool heartbeats)
//     go to a separate per-session list, because they interleave with the
//     main thread by timing;
//   - interrupt receipts go to a separate list; a cold-start receipt keeps
//     only its outcome, never its contents (T13: both shapes are real);
//   - the CLI process's exit is kept apart from the ordered frames: Node can
//     report a child's exit before it delivers the child's last stdout line;
//   - everything after the scenario closed a session is dropped except how
//     its stream ended.

import path from 'node:path'
import { relabel, type ScenarioResult } from './claude-cli-trace'

function blockKinds(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? 'string' : 'none'
  return content.map((b: any) => (b?.type === 'tool_use' ? `tool_use:${b.name}` : b?.type)).join(',')
}

/** One token per SDK message (labelled already). */
export function messageToken(m: any): string {
  switch (m.type) {
    case 'system': {
      switch (m.subtype) {
        case 'init': return `init sid=${m.session_id}`
        case 'session_state_changed': return `state ${m.state}`
        case 'status': {
          const parts = [`status ${m.status ?? 'null'}`]
          if (m.compact_result) parts.push(`compact=${m.compact_result}`)
          if (m.permissionMode) parts.push(`mode=${m.permissionMode}`)
          return parts.join(' ')
        }
        case 'compact_boundary': return `compact_boundary ${m.compact_metadata?.trigger}`
        case 'task_notification': return `system task_notification ${m.status}`
        default: return `system ${m.subtype}`
      }
    }
    case 'command_lifecycle': return `lifecycle ${m.command_uuid} ${m.state}`
    case 'conversation_reset': return `conversation_reset sid=${m.session_id} new=${m.new_conversation_id}`
    case 'user':
      return m.isReplay === true ? `replay ${m.uuid} ${blockKinds(m.message?.content)}` : `user ${blockKinds(m.message?.content)}`
    case 'assistant':
      return `assistant ${blockKinds(m.message?.content)}${m.is_api_error_message ? ' api_error' : ''}`
    case 'result':
      return `result ${m.subtype} ${m.terminal_reason ?? 'none'} error=${m.is_error} turns=${m.num_turns} sid=${m.session_id}`
    case 'tool_progress':
      return m.heartbeat ? `heartbeat ${m.tool_name} ${m.elapsed_time_seconds}` : `tool_progress ${m.tool_name}`
    case 'stream_event': return 'stream'
    default: return m.type
  }
}

export interface NormalizedSession {
  main: string[]
  sub: string[]
  receipts: string[]
  exit: string | null
}

export interface NormalizedTrace {
  scenario: string
  sessions: Record<string, NormalizedSession>
  observations: any
}

const isSubagentFrame = (m: any) => m.type !== 'tool_progress' && typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id.length > 0

function normalizeObservations(result: ScenarioResult): any {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {}
      for (const [key, x] of Object.entries(v)) {
        if (key === 'files' && Array.isArray(x)) out[key] = x.map((f: string) => path.basename(f)).sort()
        else if (key === 'msAfterResult' || key === 'elapsedMs') out[key] = typeof x === 'number' ? 'ms' : x
        else if (key === 'stderr' && typeof x === 'string') out[key] = x.trim()
        else out[key] = walk(x)
      }
      return out
    }
    return v
  }
  return walk(relabel(result, result.observations))
}

export function normalize(result: ScenarioResult): NormalizedTrace {
  const sessions: Record<string, NormalizedSession> = {}
  const closed = new Set<string>()
  for (const raw of result.events) {
    if (!raw.s) continue
    const e = relabel(result, raw)
    const session = (sessions[e.s!] ??= { main: [], sub: [], receipts: [], exit: null })
    const after = closed.has(e.s!)
    const pushMain = (token: string) => {
      if (token === 'stream' && session.main.at(-1) === 'stream') return
      session.main.push(token)
    }
    switch (e.k) {
      case 'msg': {
        if (after) break
        if (isSubagentFrame(e.m)) {
          const token = messageToken(e.m)
          if (!(token === 'stream' && session.sub.at(-1) === 'stream')) session.sub.push(token)
        } else {
          pushMain(messageToken(e.m))
        }
        break
      }
      case 'interrupt-settled':
        session.receipts.push(e.tag === 'cold' ? `${e.tag} ok` : `${e.tag} ok still_queued=${JSON.stringify(e.receipt?.still_queued ?? null)}`)
        break
      case 'interrupt-rejected':
        session.receipts.push(`${e.tag} rejected`)
        break
      case 'init-resolved':
        pushMain(`init-resolved mode=${e.result?.current_permission_mode} pid=${e.result?.pidIsCli} keys=${(e.result?.keys ?? []).join(',')}`)
        break
      case 'init-rejected':
        pushMain(`init-rejected ${e.message}`)
        break
      case 'call':
        pushMain(`call ${e.name} ${e.ok ? 'ok' : `failed ${e.message}`}`)
        break
      case 'throw':
        pushMain(`throw ${e.message}`)
        break
      case 'end':
        pushMain('end')
        break
      case 'cli-exit':
        if (!after) session.exit = `code=${e.code} signal=${e.signal}`
        break
      case 'close':
        closed.add(e.s!)
        break
      case 'wait-missed':
        pushMain(`missed ${e.what}`)
        break
      default:
        break
    }
  }
  return { scenario: result.scenario, sessions, observations: normalizeObservations(result) }
}
