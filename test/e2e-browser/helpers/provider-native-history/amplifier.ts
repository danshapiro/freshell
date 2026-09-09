import path from 'node:path'

import { findExactSessionDirectories, readBoundedJsonl, safeOpaqueId } from './safe-io.js'
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
  type NativeToolCall,
} from './types.js'

type AmplifierProfile = {
  provider: string
  model: string
  effort: string
}

function profileFromEvents(events: Record<string, any>[]): AmplifierProfile {
  const profiles: AmplifierProfile[] = []
  for (const event of events.filter((row) => row.event === 'session:config' || row.type === 'session:config')) {
    const raw = object(object(event.data, 'Amplifier session:config data').raw, 'Amplifier session:config raw data')
    if (!Array.isArray(raw.providers)) throw new Error('Amplifier session:config lacks providers schema')
    const matches = raw.providers
      .map((value: unknown) => object(value, 'Amplifier provider config'))
      .filter((provider: Record<string, any>) => (provider.id ?? provider.instance_id) === 'freshell-onecli-anthropic')
    if (matches.length !== 1) throw new Error('Amplifier session:config must contain exactly one approved OneCLI provider')
    const provider = matches[0]
    const config = object(provider.config, 'Amplifier OneCLI provider config')
    profiles.push({
      provider: requiredString(provider.id ?? provider.instance_id, 'Amplifier OneCLI provider id'),
      model: requiredString(config.default_model, 'Amplifier native default model'),
      effort: requiredString(config.reasoning_effort, 'Amplifier native reasoning effort'),
    })
  }
  if (profiles.length === 0) throw new Error('Amplifier native events lack session:config profile evidence')
  const canonical = JSON.stringify(profiles[0])
  if (profiles.some((profile) => JSON.stringify(profile) !== canonical)) {
    throw new Error('Amplifier native session:config profile evidence is conflicting')
  }
  return profiles[0]
}

function contentTextAndTools(message: Record<string, any>): { text: string; calls: NativeToolCall[] } {
  const calls: NativeToolCall[] = []
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      const call = object(raw, 'Amplifier assistant tool call')
      calls.push({ type: 'tool_call', ...(optionalString(call.name ?? call.function?.name) ? { name: optionalString(call.name ?? call.function?.name)! } : {}) })
    }
  }
  if (typeof message.content === 'string') return { text: boundedText(message.content, 'Amplifier assistant response'), calls }
  if (!Array.isArray(message.content)) throw new Error('Amplifier assistant content must be text or an array')
  const text: string[] = []
  for (const raw of message.content) {
    const block = object(raw, 'Amplifier assistant content block')
    if (block.type === 'text') text.push(requiredString(block.text, 'Amplifier assistant text'))
    if (block.type === 'tool_use') calls.push({ type: 'tool_use', ...(optionalString(block.name) ? { name: optionalString(block.name)! } : {}) })
  }
  return { text: boundedText(text.join(''), 'Amplifier assistant response'), calls }
}

/**
 * Reads Amplifier app-cli 0.1.1's exact session directory after provider stop.
 * transcript.jsonl is content authority; prompt/store events prove completed persistence.
 */
export function readAmplifierNativeHistory(projectsRoot: string, exactSessionId: string): NativeHistory {
  const sessionId = safeOpaqueId(exactSessionId, 'Amplifier native session id')
  const matches = findExactSessionDirectories(projectsRoot, sessionId)
  if (matches.length === 0) throw new Error(`Amplifier exact native session directory is missing: ${sessionId}`)
  if (matches.length !== 1) throw new Error(`Amplifier exact native session directory is ambiguous or duplicated: ${sessionId}`)
  const sessionDir = matches[0]
  if (path.basename(sessionDir) !== sessionId || path.basename(path.dirname(sessionDir)) !== 'sessions') {
    throw new Error('Amplifier session path does not exactly bind the native session id')
  }
  const events = readBoundedJsonl(path.join(sessionDir, 'events.jsonl'), 'Amplifier native events')
  for (const event of events) {
    if (event.session_id !== sessionId) throw new Error('Amplifier native event has a conflicting exact session id')
    const schema = object(event.schema, 'Amplifier event schema')
    if (schema.name !== 'amplifier.log' || schema.ver !== '1.0.0') throw new Error('Amplifier event has an unsupported schema')
  }
  const profile = profileFromEvents(events)
  const eventToolCalls = boundedToolCalls(events
    .filter((event) => event.event === 'tool:pre')
    .map((event) => {
      const data = object(event.data, 'Amplifier tool:pre data')
      const name = optionalString(event.tool_name ?? data.tool_name ?? data.name)
      return { type: 'tool:pre', ...(name ? { name } : {}) }
    }), 'Amplifier native tool events')
  const completions = new Map<string, { completedAt: string }>()
  const promptCompletions = new Set<string>()
  for (const event of events) {
    const eventId = optionalString(event.request_id ?? event.span_id)
    if (event.event === 'prompt:complete') {
      if (!eventId) throw new Error('Amplifier prompt:complete lacks a native request/span id')
      if (event.status !== undefined && event.status !== 'ok') continue
      promptCompletions.add(eventId)
    }
    if (event.event === 'cleanup:store_end') {
      if (!eventId) throw new Error('Amplifier cleanup:store_end lacks a native request/span id')
      if (event.status !== undefined && event.status !== 'ok') continue
      if (!promptCompletions.has(eventId)) throw new Error('Amplifier stored completion is not correlated to prompt:complete')
      if (completions.has(eventId)) throw new Error('Amplifier duplicates a native completed turn id')
      completions.set(eventId, { completedAt: validTimestamp(event.ts, 'Amplifier stored completion timestamp') })
    }
  }
  if (completions.size === 0) throw new Error('Amplifier exact native session has no stored completed prompt')

  const transcript = readBoundedJsonl(path.join(sessionDir, 'transcript.jsonl'), 'Amplifier native transcript')
  const turns: NativeAssistantTurn[] = []
  const messageIds = new Set<string>()
  let pendingCalls: NativeToolCall[] = []
  for (const message of transcript) {
    if (message.role === 'user') {
      pendingCalls = []
      continue
    }
    if (message.role === 'tool') {
      pendingCalls.push({ type: 'tool', ...(optionalString(message.name) ? { name: optionalString(message.name)! } : {}) })
      continue
    }
    if (message.role !== 'assistant') continue
    const materialized = contentTextAndTools(message)
    pendingCalls.push(...materialized.calls)
    const metadata = message.metadata === undefined ? {} : object(message.metadata, 'Amplifier assistant metadata')
    const turnId = optionalString(message.request_id ?? message.turn_id ?? metadata.request_id ?? metadata.turn_id)
    if (!turnId || !completions.has(turnId)) continue
    const messageId = requiredString(message.id ?? message.message_id ?? metadata.id ?? metadata.message_id, 'Amplifier assistant message id')
    if (messageIds.has(messageId)) throw new Error(`Amplifier duplicates assistant message id ${messageId}`)
    messageIds.add(messageId)
    turns.push({
      turnId,
      messageId,
      parentMessageId: optionalString(message.parent_id ?? metadata.parent_id),
      completedAt: completions.get(turnId)!.completedAt,
      text: materialized.text,
      // The pinned hook schema does not guarantee a turn correlation id on
      // tool:pre. Conservatively attach every exact-session invocation so a
      // no-tools qualification can never hide one.
      toolCalls: boundedToolCalls([...pendingCalls, ...eventToolCalls], 'Amplifier native tool calls'),
      resolvedProvider: profile.provider,
      resolvedModel: profile.model,
      resolvedReasoningEffort: profile.effort,
      providerProvenance: 'amplifier-session:config.provider',
      modelProvenance: 'amplifier-session:config.default_model',
      reasoningEffortProvenance: 'amplifier-session:config.reasoning_effort',
    })
    pendingCalls = []
    if (turns.length > MAX_NATIVE_TURNS) throw new Error('Amplifier native completed turns exceed the evidence bound')
  }
  if (turns.length === 0) throw new Error('Amplifier exact native session has no correlated completed assistant response with native ids')
  if (turns.length !== completions.size) throw new Error('Amplifier completed prompts do not map one-to-one to stored assistant messages')
  return { schemaVersion: NATIVE_HISTORY_SCHEMA_VERSION, provider: 'amplifier', nativeSessionId: sessionId, turns }
}
