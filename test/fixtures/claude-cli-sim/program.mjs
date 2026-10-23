// Scenario programs for the CLI simulator, in the rule language of the e2e
// provider fixtures (test/e2e-browser/fixtures/providers/fixture-core.mjs):
//
//   {
//     "rules": [
//       { "on": "msg:prompt", "match": { "text": "please ask" }, "once": true,
//         "emit": [ { "kind": "question", "data": { ... } }, { "kind": "completion" } ] }
//     ]
//   }
//
// Triggers: "start" (the CLI finished booting) and "msg:prompt" (a prompt
// starts its turn; the payload is { type: 'prompt', text, uuid }). `match` is
// the fixtures' deep-subset match; `once` and per-emission `delayMs` behave as
// there. A matching prompt rule replaces the prompt-marker behavior for that
// turn; its emissions run in order as the model's side of the turn:
//
//   text / activity  { text?, chunks?, delayMs? }   one streamed assistant text block
//   tool             { name, input, id?, seconds?, output?, isError?, inputStreamMs? }
//                                                   a tool call and its result; with inputStreamMs
//                                                   the model streams the call's input for that long
//                                                   (a long Write) before the call completes
//   approval         { tool, input, id?, suggestions?, blockedPath?, decisionReason? }
//                    a tool call that asks canUseTool, with these fields; under
//                    bypassPermissions (where the pinned CLI asks for no tool
//                    call) it fails the stream as a simulator failure
//   question         { questions | input, id? }     AskUserQuestion through canUseTool
//                                                   (`input`: the whole tool input)
//   exit_plan        { plan? }                      ExitPlanMode through canUseTool
//   completion       { subtype?, text?, errors? }   end the turn with this result subtype
//   api_error        { status?, message? }          the model request fails
//   api_retry        { status?, attempts? }         the model request fails `attempts` times
//                                                   (default 1) with `status` (default 529)
//                                                   and the CLI retries: one system/api_retry
//                                                   per failure, after its backoff the next step
//   replay           { recording, holdBeforeMs?, pace? }   the model's side of a turn the
//                                                   pinned CLI really ran (replay.mjs)
//   hang             {}                             the model request never completes
//   crash            { signal? | code? }            the CLI process dies (default SIGKILL);
//                                                   with code 0 the stream ends with no error
//   stall_stdin      {}                             the host process stops reading stdin
//   cli_turn         { afterMs? }                   a background task finishes later and
//                                                   starts a CLI-initiated turn
//   marker           {}                             no effect (diagnostics)
//
// `id` is the tool_use id the model gives the call (default toolu_sim_<n>).
//
// "start" rules may use crash, stall_stdin, cli_turn and marker.
//
// The program comes from FRESHELL_CLAUDE_SIM_PROGRAM (inline JSON),
// FRESHELL_CLAUDE_SIM_PROGRAM_FILE (a path), or FRESHELL_CLAUDE_SDK_SCRIPT
// (the transcript-live plan's alias: inline JSON or a path).

import fs from 'node:fs'
import { isSubset, parseOn } from '../../e2e-browser/fixtures/providers/fixture-core.mjs'

export const PROGRAM_ENV = 'FRESHELL_CLAUDE_SIM_PROGRAM'
export const PROGRAM_FILE_ENV = 'FRESHELL_CLAUDE_SIM_PROGRAM_FILE'
export const PROGRAM_ALIAS_ENV = 'FRESHELL_CLAUDE_SDK_SCRIPT'

export const EMISSION_KINDS = new Set([
  'text', 'activity', 'tool', 'approval', 'question', 'exit_plan', 'completion',
  'api_error', 'api_retry', 'replay', 'hang', 'crash', 'stall_stdin', 'cli_turn', 'marker',
])

function parseProgram(text, source) {
  let program
  try { program = JSON.parse(text) } catch (error) {
    throw new Error(`Invalid simulator program in ${source}: ${error?.message ?? error}`)
  }
  if (!program || typeof program !== 'object' || Array.isArray(program)) {
    throw new Error(`The simulator program in ${source} must be a JSON object`)
  }
  const rules = Array.isArray(program.rules) ? program.rules : []
  for (const rule of rules) {
    parseOn(rule.on)
    for (const emission of rule.emit ?? []) {
      if (!EMISSION_KINDS.has(emission?.kind)) {
        throw new Error(`Unknown simulator emission kind ${JSON.stringify(emission?.kind)} in ${source}`)
      }
    }
  }
  return { ...program, rules }
}

/** Load the program named by the environment; an absent program has no rules. */
export function loadProgram(env) {
  if (env[PROGRAM_ENV]?.trim()) return parseProgram(env[PROGRAM_ENV], PROGRAM_ENV)
  if (env[PROGRAM_FILE_ENV]) return parseProgram(fs.readFileSync(env[PROGRAM_FILE_ENV], 'utf8'), env[PROGRAM_FILE_ENV])
  const alias = env[PROGRAM_ALIAS_ENV]?.trim()
  if (alias) return parseProgram(alias.startsWith('{') ? alias : fs.readFileSync(alias, 'utf8'), PROGRAM_ALIAS_ENV)
  return { rules: [] }
}

export class ProgramEngine {
  constructor(program) {
    this.program = program
    this.fired = new Set()
  }

  /**
   * The emissions of every rule matching this trigger, in rule order (rules
   * marked `once` are consumed). Returns null when no rule matched.
   */
  match(trigger, payload) {
    let matched = null
    this.program.rules.forEach((rule, index) => {
      if (rule.once && this.fired.has(index)) return
      const spec = parseOn(rule.on)
      const hit = spec.kind === 'start'
        ? trigger === 'start'
        : spec.kind === 'msg' && trigger === 'msg' && payload?.type === spec.arg && isSubset(rule.match, payload)
      if (!hit) return
      if (rule.once) this.fired.add(index)
      matched ??= []
      for (const emission of rule.emit ?? []) {
        matched.push({ kind: emission.kind, delayMs: Number(emission.delayMs ?? 0) || 0, data: { ...(emission.data ?? {}) } })
      }
    })
    return matched
  }
}
