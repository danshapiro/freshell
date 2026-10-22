// Slash commands for the CLI simulator: /compact (T15), /clear (T16), /cost
// and /usage, /model, other catalog commands, and unknown commands. Each is
// one command with one result and no model request.

import { randomUUID } from 'node:crypto'
import { parsePromptMarkers } from './prompt-markers.mjs'
import { CAVEAT, CATALOG, commandLine, T, usage } from './sdk-shapes.mjs'
import { Transcript } from './transcript.mjs'

export async function runLocalCommand(cli, turn, { name, args }) {
  const { cmd } = turn
  const commandText = commandLine(name === 'cost' ? 'usage' : name, args)
  const localResult = (text) => cli.finishTurn(turn, { subtype: 'success', numTurns: 0, stopReason: null, text, local: true })
  const replay = (content, uuid) => cli.emit({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: uuid ?? randomUUID(), timestamp: new Date().toISOString(), isReplay: true })
  const recordCommand = (output, { stream = 'stdout' } = {}) => {
    cli.transcript.append({ type: 'user', isMeta: true, message: { role: 'user', content: CAVEAT } })
    cli.transcript.append({ type: 'user', uuid: cmd.uuid, message: { role: 'user', content: commandText } })
    cli.transcript.append({ type: 'system', subtype: 'local_command', content: `<local-command-${stream}>${output}</local-command-${stream}>`, level: 'info', isMeta: false })
  }
  const synthetic = (text) => {
    const uuid = randomUUID()
    cli.emit({ type: 'assistant', message: { id: randomUUID(), container: null, model: '<synthetic>', role: 'assistant', stop_details: null, stop_reason: 'end_turn', stop_sequence: null, type: 'message', usage: usage(0, 0), content: [{ type: 'text', text }], context_management: null }, parent_tool_use_id: null, uuid, timestamp: new Date().toISOString() })
  }

  if (name === 'compact') {
    cli.emit({ type: 'system', subtype: 'status', status: 'compacting' })
    await cli.sleep(T.compaction)
    const marker = parsePromptMarkers(args)
    const error = marker.kind === 'api_error'
      ? `Error during compaction: API Error: ${marker.status} local provider error`
      : cli.modelTurnsSinceCompact === 0 ? 'Not enough messages to compact.' : null
    if (error) {
      cli.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: error })
      cli.emit(cli.systemInit())
      synthetic(error)
      replay(commandText, cmd.uuid)
      recordCommand(error, { stream: 'stderr' })
      return localResult('')
    }
    cli.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })
    cli.emit(cli.systemInit())
    const summaryUuid = randomUUID()
    cli.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 99, post_tokens: 729, cumulative_dropped_tokens: 0, duration_ms: T.compaction }, logical_parent_uuid: cli.transcript.lastUuid })
    cli.transcript.append({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual' }, logicalParentUuid: cli.transcript.lastUuid })
    const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nok'
    cli.emit({ type: 'user', message: { role: 'user', content: summary }, parent_tool_use_id: null, uuid: summaryUuid, timestamp: new Date().toISOString(), isReplay: false, isSynthetic: true })
    cli.transcript.append({ type: 'user', uuid: summaryUuid, isCompactSummary: true, message: { role: 'user', content: summary } })
    replay('<local-command-stdout>Compacted </local-command-stdout>')
    replay(commandText, cmd.uuid)
    recordCommand('Compacted ')
    cli.modelTurnsSinceCompact = 0
    return localResult('')
  }

  if (name === 'clear') {
    const previous = cli.sessionId
    cli.emit({ type: 'conversation_reset', new_conversation_id: randomUUID(), session_id: previous })
    cli.transcript.flush()
    cli.sessionId = randomUUID()
    cli.transcript = new Transcript({ configDir: cli.configDir, cwd: cli.cwd, sessionId: cli.sessionId, flushMs: (ms) => cli.ms(ms) })
    cli.transcript.materialize()
    await cli.sleep(T.localCommand)
    cli.emit(cli.systemInit())
    replay(commandText, cmd.uuid)
    cli.transcript.append({ type: 'user', uuid: cmd.uuid, message: { role: 'user', content: commandText } })
    cli.transcript.flush()
    cli.modelTurnsSinceCompact = 0
    return localResult('')
  }

  await cli.sleep(T.localCommand)
  cli.emit(cli.systemInit())
  if (name === 'cost' || name === 'usage') {
    const text = 'Total cost:            $0.0000\nTotal duration (API):  0s\nTotal duration (wall): 0s\nTotal code changes:    0 lines added, 0 lines removed'
    synthetic(text)
    replay(commandText, cmd.uuid)
    recordCommand(text)
    return localResult(text)
  }
  if (name === 'model' && args) {
    cli.model = args
    const text = `Set model to ${args}`
    synthetic(text)
    replay(commandText, cmd.uuid)
    recordCommand(text)
    return localResult(text)
  }
  const known = CATALOG.initializationResult.commands.some((row) => row.name === name)
  if (!known) {
    synthetic(`Unknown command: /${name}`)
    return localResult(`Unknown command: /${name}`)
  }
  const text = `/${name} ran in the simulator`
  synthetic(text)
  replay(commandText, cmd.uuid)
  recordCommand(text)
  return localResult(text)
}
