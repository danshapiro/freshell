import path from 'node:path'

import { findExactFiles, readBoundedJsonlWithPositions, safeOpaqueId, type PositionedJsonlRecord } from './safe-io.js'
import type { NativeMessageComponentEvidence } from '../../../../scripts/testing/provider-native-history.js'
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
    if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(type)) throw new Error('Claude assistant content has an unclassifiable block')
  }
  return {
    text: boundedText(text.join(''), 'Claude native assistant response'),
    toolCalls: boundedToolCalls(toolCalls, 'Claude native tool calls'),
  }
}

function componentEvidence(record: PositionedJsonlRecord): NativeMessageComponentEvidence {
  return {
    messageId: requiredString(record.value.uuid, 'Claude transcript UUID'),
    parentMessageId: optionalString(record.value.parentUuid),
    recordIndex: record.recordIndex, byteStart: record.byteStart, byteEnd: record.byteEnd,
    recordSha256: record.recordSha256,
  }
}

function messageEffort(row: Record<string, any>): { effort: string; provenance: string } {
  const raw = row.effort !== undefined ? row.effort : row.message.effort
  const effort = raw === undefined || raw === null ? 'unknown' : requiredString(raw, 'Claude assistant reasoning effort')
  return { effort, provenance: effort === 'unknown' ? 'unsupported-native-telemetry'
    : row.effort !== undefined ? 'claude-transcript.effort' : 'claude-assistant-message.effort' }
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

  const records = readBoundedJsonlWithPositions(matches[0], 'Claude native transcript')
  const turns: NativeAssistantTurn[] = []
  const byUuid = new Map<string, PositionedJsonlRecord>()
  const providerIds = new Set<string>()
  for (const record of records) {
    const row = record.value
    for (const field of ['sessionId', 'session_id']) {
      if (row[field] !== undefined && row[field] !== sessionId) throw new Error('Claude transcript contains a conflicting native session id')
    }
    const uuid = optionalString(row.uuid)
    if (uuid) {
      if (byUuid.has(uuid)) throw new Error(`Claude transcript duplicates native UUID ${uuid}`)
      byUuid.set(uuid, record)
    }
  }
  let components: PositionedJsonlRecord[] = []
  let pendingToolCalls: { type: string, name?: string }[] = []
  const finishMessage = (): void => {
    if (!components.length) return
    const first = components[0]!, last = components.at(-1)!, row = last.value
    const firstMessage = object(first.value.message, 'Claude assistant message')
    const turnId = requiredString(firstMessage.id, 'Claude provider assistant message id')
    if (providerIds.has(turnId)) throw new Error('Claude transcript reuses a provider message id across separate messages')
    providerIds.add(turnId)
    const model = requiredString(firstMessage.model, 'Claude assistant model')
    const stop = firstMessage.stop_reason
    const { effort, provenance: effortProvenance } = messageEffort(first.value)
    let contentBlockIndex = 0
    const materialized = components.map((record, index) => {
      const part = record.value, body = object(part.message, 'Claude assistant message')
      if (part.isSidechain === true || body.role !== 'assistant' || body.model !== model || body.stop_reason !== stop
        || (part.requestId ?? null) !== (first.value.requestId ?? null)) throw new Error('Claude message components contain conflicting native identity, model or completion')
      if (messageEffort(part).effort !== effort) throw new Error('Claude message components contain conflicting reasoning effort')
      if (index && part.parentUuid !== components[index - 1]!.value.uuid) throw new Error('Claude message components lack ordered native parent ancestry')
      if (part.apiBlockIndex !== undefined && part.apiBlockIndex !== contentBlockIndex) throw new Error('Claude message components have conflicting native block order')
      const at = validTimestamp(part.timestamp, 'Claude assistant completion timestamp')
      if (index && Date.parse(at) < Date.parse(components[index - 1]!.value.timestamp)) throw new Error('Claude message components have reversed completion timestamps')
      const material = textAndTools(body.content)
      contentBlockIndex += body.content.length
      return material
    })
    const sourceComponents = components.map(componentEvidence)
    const calls = materialized.flatMap(part => part.toolCalls)
    pendingToolCalls = boundedToolCalls([...pendingToolCalls, ...calls], 'Claude native tool calls for user turn')
    components = []
    // Streaming-only and tool-use messages are never completed responses.
    if (stop === null || stop === undefined || stop === 'tool_use') return
    if (!['end_turn', 'max_tokens', 'stop_sequence', 'refusal'].includes(stop)) throw new Error('Claude assistant has an unclassifiable completion reason')
    if (!materialized.some(part => part.text)) throw new Error('Claude completed assistant response has no text')
    const messageId = requiredString(row.uuid, 'Claude transcript assistant UUID')
    // Resolve only the pinned native attachment chain, preserving its original
    // UUIDs and positions rather than assuming that the latest user owns a reply.
    let parentMessageId = optionalString(first.value.parentUuid)
    const parentChain: NativeMessageComponentEvidence[] = []
    let childPosition = first.recordIndex
    while (parentMessageId && byUuid.get(parentMessageId)?.value.type === 'attachment') {
      const ancestor = byUuid.get(parentMessageId)!
      if (ancestor.recordIndex >= childPosition || ancestor.value.isSidechain === true) throw new Error('Claude native attachment ancestry is ambiguous')
      parentChain.push(componentEvidence(ancestor)); childPosition = ancestor.recordIndex
      parentMessageId = requiredString(ancestor.value.parentUuid, 'Claude native attachment parent')
    }
    turns.push({
      nativeEvidence: { kind: 'identified_message', turnId, messageId, parentMessageId,
        ...(sourceComponents.length > 1 ? { components: sourceComponents } : {}), ...(parentChain.length ? { parentChain } : {}) },
      turnId,
      messageId,
      parentMessageId,
      completedAt: validTimestamp(row.timestamp, 'Claude assistant completion timestamp'),
      text: boundedText(materialized.map(part => part.text).join(''), 'Claude native assembled assistant response'),
      toolCalls: boundedToolCalls([...pendingToolCalls], 'Claude native tool calls for completed turn'),
      resolvedProvider: 'anthropic',
      resolvedModel: model,
      resolvedReasoningEffort: effort,
      providerProvenance: 'claude-assistant-message',
      modelProvenance: 'claude-assistant-message.model',
      reasoningEffortProvenance: effortProvenance,
    })
    pendingToolCalls = []
    if (turns.length > MAX_NATIVE_TURNS) throw new Error('Claude native assistant turns exceed the evidence bound')
  }
  for (const record of records) {
    const row = record.value
    if (row.type === 'user') {
      finishMessage()
      if (typeof row.message?.content === 'string' || row.message?.content?.some((part: Record<string, any>) => part.type === 'text')) pendingToolCalls = []
      continue
    }
    if (row.type !== 'assistant') continue
    const message = object(row.message, 'Claude assistant message')
    const id = requiredString(message.id, 'Claude provider assistant message id')
    requiredString(row.uuid, 'Claude transcript assistant UUID')
    if (components.length && components[0]!.value.message.id !== id) finishMessage()
    components.push(record)
  }
  finishMessage()
  if (turns.length === 0) throw new Error('Claude exact native session has no completed assistant response')
  return { schemaVersion: NATIVE_HISTORY_SCHEMA_VERSION, provider: 'claude', nativeSessionId: sessionId, turns }
}
