// Tool calls for the CLI simulator: the streamed tool_use block, canUseTool
// (with the pinned CLI's suggestion shapes), execution on a virtual timeline
// (Bash task promotion, 30 s heartbeats, the BASH_MAX_TIMEOUT_MS cap), sends
// absorbed while a tool runs (T10), and background agents (T19).

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLAN_TEXT } from './prompt-markers.mjs'
import { READ_ONLY_COMMANDS, T } from './sdk-shapes.mjs'

/** Whether the pinned CLI would ask canUseTool for this call in the current permission mode. */
function needsPermission(cli, name, input) {
  if (name === 'AskUserQuestion') return true
  if (cli.permissionMode === 'bypassPermissions') return false
  if (name === 'ExitPlanMode') return true
  if (name === 'Bash') return !READ_ONLY_COMMANDS.has(String(input?.command ?? '').trim().split(/\s+/)[0])
  if (name.startsWith('mcp__')) return true
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') return cli.permissionMode !== 'acceptEdits'
  return false
}

/** canUseTool's options: a program's own fields, or the CLI's shapes (a file-writing Bash call offers rules, the directory and acceptEdits). */
function permissionOptions(cli, name, input, toolUseID, data) {
  const base = { displayName: name, toolUseID, requestId: randomUUID() }
  if (data.suggestions || data.blockedPath || data.decisionReason) {
    return {
      ...(data.suggestions ? { suggestions: data.suggestions } : {}),
      ...(data.blockedPath ? { blockedPath: data.blockedPath } : {}),
      ...(data.decisionReason ? { decisionReason: data.decisionReason } : {}),
      ...base,
      ...(input?.description ? { description: input.description } : {}),
    }
  }
  if (name !== 'Bash') return base
  const command = String(input?.command ?? '')
  const touched = /^touch\s+(\S+)/.exec(command)?.[1]
  return {
    suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: command }], behavior: 'allow', destination: 'localSettings' },
      ...(touched ? [
        { type: 'addDirectories', directories: [cli.cwd], destination: 'session' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ] : []),
    ],
    ...(touched ? { blockedPath: path.join(cli.cwd, touched) } : {}),
    displayName: 'Bash',
    ...(input?.description ? { description: input.description } : {}),
    toolUseID,
    requestId: base.requestId,
  }
}

/** Ask the host's canUseTool and wait for the answer or an interrupt. */
async function askPermission(cli, turn, name, input, toolUseID, data) {
  const canUseTool = cli.options.canUseTool
  if (typeof canUseTool !== 'function') return { behavior: 'allow', updatedInput: input }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  turn.waiters.add(onAbort)
  try {
    const answer = Promise.resolve(canUseTool(name, input, { signal: controller.signal, ...permissionOptions(cli, name, input, toolUseID, data) }))
    answer.then(
      (decision) => cli.ledger('can_use_tool', { toolName: name, toolUseID, decision }),
      (error) => cli.ledger('can_use_tool', { toolName: name, toolUseID, error: String(error?.message ?? error) }),
    )
    const aborted = new Promise((resolve) => turn.waiters.add(() => resolve(null)))
    return await Promise.race([answer.catch((error) => ({ behavior: 'deny', message: `Tool permission request failed: ${error}` })), aborted])
  } finally {
    turn.waiters.delete(onAbort)
  }
}

function applyPermissionUpdates(cli, updates) {
  for (const update of updates ?? []) {
    if (update?.type === 'setMode' && update.mode) cli.setMode(update.mode)
  }
}

/** Pieces a streamed tool input arrives in (when it streams for a while). */
const INPUT_STREAM_PIECES = 8

/**
 * The model streams the call's input as input_json_delta events. A large
 * input (a Write of a long file) takes a while: with `streamMs` it arrives in
 * pieces spread over that long, the call completing only after the last.
 * Returns true when the turn was aborted meanwhile.
 */
async function streamToolInput(cli, turn, input, streamMs) {
  const json = JSON.stringify(input)
  if (streamMs <= 0) {
    cli.emitStream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } })
    return false
  }
  const pieces = Math.min(INPUT_STREAM_PIECES, json.length)
  const size = Math.ceil(json.length / pieces)
  for (let offset = 0; offset < json.length; offset += size) {
    cli.emitStream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(offset, offset + size) } })
    if (await cli.wait(streamMs / pieces, turn)) return true
  }
  return false
}

/** A tool call: its streamed tool_use block, permission, execution and result. */
export async function toolCall(cli, turn, step) {
  const data = step.data ?? {}
  // An `approval` is a tool call the CLI asks canUseTool for. Under
  // bypassPermissions the pinned CLI asks for none (needsPermission), so a
  // program that scripts one there would pin a behavior the real CLI does not
  // have: fail the stream loudly instead.
  if (step.kind === 'approval' && cli.permissionMode === 'bypassPermissions') {
    throw new Error('a program `approval` step ran under bypassPermissions, where the pinned CLI never asks canUseTool for a tool call; run the session in another permission mode, or script a `question` step (AskUserQuestion asks in every mode)')
  }
  // The model names its tool calls; a program may choose the id.
  const toolUseId = data.id ?? `toolu_sim_${++cli.toolSeq}`
  let name
  let input
  switch (step.kind) {
    case 'approval': name = data.tool ?? 'Bash'; input = data.input ?? { command: 'ls' }; break
    case 'question': name = 'AskUserQuestion'; input = data.input ?? { questions: data.questions ?? [] }; break
    case 'exit_plan': name = 'ExitPlanMode'; input = { plan: data.plan ?? PLAN_TEXT }; break
    case 'agent': name = 'Agent'; input = { description: 'local provider background agent', prompt: 'SUBAGENT-TASK SLOW', subagent_type: 'general-purpose', run_in_background: true }; break
    default: name = data.name ?? 'Bash'; input = data.input ?? {}
  }
  cli.emitStream(cli.messageStart())
  cli.emitStream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name, input: {} } })
  if (await streamToolInput(cli, turn, input, Number(data.inputStreamMs ?? 0) || 0)) {
    await cli.abortStreaming(turn, '')
    return 'aborted'
  }
  cli.assistant([{ type: 'tool_use', id: toolUseId, name, input }])

  if (step.kind === 'agent') return launchAgent(cli, turn, toolUseId, input)

  if (step.kind === 'approval' || step.kind === 'question' || needsPermission(cli, name, input)) {
    cli.emitState('requires_action')
    const decision = await askPermission(cli, turn, name, input, toolUseId, data)
    cli.trailingStream('tool_use')
    if (turn.aborted || decision === null) return cli.abortTool(turn, toolUseId)
    cli.emitState('running')
    if (decision.behavior !== 'allow') {
      turn.denials.push({ tool_name: name, tool_use_id: toolUseId, tool_input: input })
      cli.toolResult(toolUseId, decision.message ?? 'Permission denied', { isError: true, toolUseResult: `Error: ${decision.message ?? 'Permission denied'}`, extra: { tool_result_meta: [{ id: toolUseId, non_execution_kind: 'permission-rule' }] } })
      return 'done'
    }
    applyPermissionUpdates(cli, decision.updatedPermissions)
    input = decision.updatedInput ?? input
  } else {
    cli.trailingStream('tool_use')
  }
  if (name === 'ExitPlanMode') {
    if (cli.permissionMode === 'plan') cli.setMode('default')
    cli.toolResult(toolUseId, 'User has approved exiting plan mode. You can now proceed.', { toolUseResult: { plan: null, isAgent: false } })
    return 'done'
  }
  if (name === 'AskUserQuestion') {
    cli.toolResult(toolUseId, `User has answered your questions: ${JSON.stringify(input.answers ?? {})}`, { toolUseResult: { questions: input.questions, answers: input.answers ?? {} } })
    return 'done'
  }
  return executeTool(cli, turn, toolUseId, name, input, data)
}

/** Run a tool; sends pushed meanwhile are absorbed into this turn (T10). */
async function executeTool(cli, turn, toolUseId, name, input, data) {
  turn.absorbing = true
  let promoted = null
  let beats = 0
  const hangs = data.hang === true
  let runMs = Number(data.seconds ?? 0) * 1000 || T.toolOverhead
  let limitMs = Number.POSITIVE_INFINITY
  if (name === 'Bash') {
    const defaultTimeout = Number(cli.env.BASH_DEFAULT_TIMEOUT_MS) > 0 ? Number(cli.env.BASH_DEFAULT_TIMEOUT_MS) : 120_000
    const maxTimeout = Math.max(Number(cli.env.BASH_MAX_TIMEOUT_MS) > 0 ? Number(cli.env.BASH_MAX_TIMEOUT_MS) : 600_000, defaultTimeout)
    limitMs = Math.min(input.timeout || defaultTimeout, maxTimeout)
    const sleep = /^sleep\s+(\d+(?:\.\d+)?)/.exec(String(input.command ?? ''))
    if (sleep) runMs = Number(sleep[1]) * 1000
  }
  const endMs = hangs ? Number.POSITIVE_INFINITY : Math.min(runMs, limitMs)
  const timedOut = !hangs && runMs > limitMs
  // Virtual timeline: Bash promotes itself to a background task after ~3 s;
  // every running tool sends a heartbeat every 30 s.
  let now = 0
  for (;;) {
    const nextBeat = (beats + 1) * T.heartbeat
    const nextPromotion = name === 'Bash' && !promoted ? T.taskPromotion : Number.POSITIVE_INFINITY
    const next = Math.min(nextBeat, nextPromotion, endMs)
    if (await cli.wait(next - now, turn)) break
    now = next
    if (now >= endMs) break
    if (now === nextPromotion) {
      promoted = { task_id: randomUUID().replaceAll('-', '').slice(0, 9), description: input.description ?? String(input.command ?? '') }
      cli.emit({ type: 'system', subtype: 'task_started', task_id: promoted.task_id, tool_use_id: toolUseId, description: promoted.description, task_type: 'local_bash' })
    } else {
      cli.emit({ type: 'tool_progress', tool_use_id: `${toolUseId}-heartbeat-${beats}`, tool_name: name, parent_tool_use_id: toolUseId, elapsed_time_seconds: Math.floor(now / 1000), heartbeat: true })
      beats += 1
    }
  }
  turn.absorbing = false
  if (turn.aborted) return cli.abortTool(turn, toolUseId)
  if (promoted) cli.emit({ type: 'system', subtype: 'task_notification', task_id: promoted.task_id, tool_use_id: toolUseId, status: 'completed', output_file: '', summary: promoted.description })
  if (timedOut) {
    const seconds = `${Math.round(limitMs / 100) / 10}`.replace(/\.0$/, '')
    const text = `Exit code 143\nCommand timed out after ${seconds}s`
    cli.toolResult(toolUseId, text, { isError: true, toolUseResult: `Error: ${text}` })
  } else if (name === 'Bash') {
    cli.toolResult(toolUseId, '(Bash completed with no output)', { toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } })
  } else {
    cli.toolResult(toolUseId, data.output ?? 'ok', { isError: data.isError === true, toolUseResult: data.output ?? 'ok' })
  }
  startAbsorbed(cli, turn)
  return 'done'
}

/** Sends absorbed during the tool are replayed and started in this turn. */
function startAbsorbed(cli, turn) {
  turn.absorbedTexts = []
  for (const cmd of turn.absorbed) {
    if (cmd.started) continue
    cmd.started = true
    const uuid = cmd.uuid ?? randomUUID()
    cli.emit({ type: 'user', message: { role: 'user', content: cmd.content }, parent_tool_use_id: null, uuid, timestamp: new Date().toISOString(), isReplay: true })
    if (cmd.uuid) cli.emit({ type: 'command_lifecycle', command_uuid: cmd.uuid, state: 'started' })
    cli.recordPrompt(cmd)
    cli.transcript.append({ type: 'user', uuid, message: { role: 'user', content: cmd.content }, promptSource: 'sdk', permissionMode: cli.permissionMode })
    turn.absorbedTexts.push(cmd.text)
  }
}

/** An async Agent: it launches at once; its completion later starts a CLI turn (T19). */
async function launchAgent(cli, turn, toolUseId, input) {
  const task = { task_id: randomUUID().replaceAll('-', '').slice(0, 17), description: input.description }
  cli.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: task.task_id, task_type: 'local_agent', description: task.description }] })
  cli.emit({ type: 'system', subtype: 'task_started', task_id: task.task_id, tool_use_id: toolUseId, description: task.description, subagent_type: input.subagent_type, task_type: 'local_agent', prompt: input.prompt })
  cli.emitStream({ type: 'content_block_stop', index: 0 })
  await cli.sleep(T.agentLaunch)
  cli.toolResult(toolUseId, [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${task.task_id}\nThe agent is working in the background. You will be notified automatically when it completes.` }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: task.task_id, description: task.description, prompt: input.prompt } })
  cli.emitStream({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
  cli.emitStream({ type: 'message_stop' })
  const timer = setTimeout(() => {
    cli.timers.delete(timer)
    cli.finishBackgroundTask(task, toolUseId)
  }, cli.ms(T.subagent))
  cli.timers.add(timer)
  return 'done'
}
