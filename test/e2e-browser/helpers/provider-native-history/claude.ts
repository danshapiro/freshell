import path from 'node:path'

import { findExactFiles, readBoundedJsonl, safeOpaqueId } from './safe-io.js'
import {
  MAX_NATIVE_TURNS,
  NATIVE_HISTORY_SCHEMA_VERSION,
  boundedText,
  boundedToolCalls,
  object,
  optionalString,
  requiredString,
  validTimestamp,
  type NativeAssistantTurn,
  type NativeHistory,
} from './types.js'

function textAndTools(content: unknown): { text: string; toolCalls: { type: string, name?: string }[] } {
  if (!Array.isArray(content)) throw new Error('Claude assistant content must be an array')
  const text: string[] = []
  const toolCalls: { type: string, name?: string }[] = []
  for (const rawBlock of content) {
    const block = object(rawBlock, 'Claude assistant content block')
    const type = requiredString(block.type, 'Claude assistant content type')
    if (type === 'text') text.push(requiredString(block.text, 'Claude assistant text'))
    if (type === 'tool_use') toolCalls.push({ type: 'tool_use', ...(optionalString(block.name) ? { name: optionalString(block.name)! } : {}) })
  }
  return {
    text: boundedText(text.join(''), 'Claude native assistant response'),
    toolCalls: boundedToolCalls(toolCalls, 'Claude native tool calls'),
  }
}

/**
 * Reads Claude Code 2.1.263's projects/<project>/<session UUID>.jsonl.
 * The caller must stop the provider first so the flat JSONL is immutable.
 */
export function readClaudeNativeHistory(projectsRoot: string, exactSessionId: string): NativeHistory {
  const sessionId = safeOpaqueId(exactSessionId, 'Claude native session id')
  const matches = findExactFiles(projectsRoot, `${sessionId}.jsonl`)
  if (matches.length === 0) throw new Error(`Claude exact native session transcript is missing: ${sessionId}`)
  if (matches.length !== 1) throw new Error(`Claude exact native session transcript is ambiguous or duplicated: ${sessionId}`)
  if (path.basename(matches[0]) !== `${sessionId}.jsonl`) throw new Error('Claude transcript basename does not exactly match the session id')

  const rows = readBoundedJsonl(matches[0], 'Claude native transcript')
  const turns: NativeAssistantTurn[] = []
  const messageIds = new Set<string>()
  let pendingToolCalls: { type: string, name?: string }[] = []
  for (const row of rows) {
    if (row.sessionId !== undefined && row.sessionId !== sessionId) {
      throw new Error('Claude transcript contains a conflicting native session id')
    }
    if (row.type === 'user') {
      pendingToolCalls = []
      continue
    }
    if (row.type !== 'assistant') continue
    const message = object(row.message, 'Claude assistant message')
    if (message.role !== 'assistant') throw new Error('Claude assistant row has an invalid message role')
    const materialized = textAndTools(message.content)
    pendingToolCalls.push(...materialized.toolCalls)
    // A null stop_reason is streaming/incomplete; tool_use asks the kernel to
    // continue the same user turn. Neither is a final completed response.
    if (typeof message.stop_reason !== 'string' || !message.stop_reason || message.stop_reason === 'tool_use') continue
    const messageId = requiredString(row.uuid, 'Claude transcript assistant UUID')
    if (messageIds.has(messageId)) throw new Error(`Claude transcript duplicates assistant message id ${messageId}`)
    messageIds.add(messageId)
    const turnId = requiredString(message.id, 'Claude provider assistant message id')
    const model = requiredString(message.model, 'Claude assistant model')
    const effort = requiredString(row.effort ?? message.effort, 'Claude assistant reasoning effort')
    turns.push({
      nativeEvidence: { kind: 'identified_message', turnId, messageId, parentMessageId: optionalString(row.parentUuid) },
      turnId,
      messageId,
      parentMessageId: optionalString(row.parentUuid),
      completedAt: validTimestamp(row.timestamp, 'Claude assistant completion timestamp'),
      text: materialized.text,
      toolCalls: boundedToolCalls([...pendingToolCalls], 'Claude native tool calls for completed turn'),
      resolvedProvider: 'anthropic',
      resolvedModel: model,
      resolvedReasoningEffort: effort,
      providerProvenance: 'claude-assistant-message',
      modelProvenance: 'claude-assistant-message.model',
      reasoningEffortProvenance: row.effort !== undefined
        ? 'claude-transcript.effort'
        : 'claude-assistant-message.effort',
    })
    pendingToolCalls = []
    if (turns.length > MAX_NATIVE_TURNS) throw new Error('Claude native assistant turns exceed the evidence bound')
  }
  if (turns.length === 0) throw new Error('Claude exact native session has no completed assistant response')
  return { schemaVersion: NATIVE_HISTORY_SCHEMA_VERSION, provider: 'claude', nativeSessionId: sessionId, turns }
}
