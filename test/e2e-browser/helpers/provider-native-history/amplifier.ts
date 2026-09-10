import path from 'node:path'

import { findExactSessionDirectories, readBoundedJsonlWithPositions, safeOpaqueId } from './safe-io.js'
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
      .filter((provider: Record<string, any>) => (provider.id ?? provider.instance_id) === 'lunaroute')
    if (matches.length !== 1) throw new Error('Amplifier session:config must contain exactly one approved OneCLI provider')
    const provider = matches[0]
    const config = object(provider.config, 'Amplifier OneCLI provider config')
    profiles.push({
      provider: requiredString(provider.id ?? provider.instance_id, 'Amplifier OneCLI provider id'),
      model: requiredString(config.default_model, 'Amplifier native default model'),
      effort: optionalString(config.reasoning ?? config.reasoning_effort) ?? 'provider-default',
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
 * Reads Amplifier's exact durable session after provider stop. The pinned
 * product exposes ordered transcript and lifecycle records, but does not
 * promise a message/turn identifier. We therefore prove continuity using its
 * native append positions and exact persisted record digests rather than
 * fabricating IDs for Freshell's certificate.
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

  const positionedEvents = readBoundedJsonlWithPositions(path.join(sessionDir, 'events.jsonl'), 'Amplifier native events')
  const events = positionedEvents.map((record) => record.value)
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

  type Completion = { completedAt: string, ordinal: number, eventSha256: string }
  const completions: Completion[] = []
  let pendingPromptId: string | null | undefined
  let promptPending = false
  for (const record of positionedEvents) {
    const event = record.value
    if (event.event === 'prompt:complete') {
      if (event.status !== undefined && event.status !== 'ok') continue
      if (promptPending) throw new Error('Amplifier native events contain overlapping successful prompts; ordinal continuity is ambiguous')
      pendingPromptId = optionalString(event.request_id ?? event.span_id)
      promptPending = true
      continue
    }
    if (event.event !== 'cleanup:store_end' || (event.status !== undefined && event.status !== 'ok')) continue
    if (!promptPending) throw new Error('Amplifier stored completion lacks a preceding successful prompt')
    const cleanupId = optionalString(event.request_id ?? event.span_id)
    if (pendingPromptId && cleanupId && pendingPromptId !== cleanupId) {
      throw new Error('Amplifier stored completion conflicts with the provider-supplied prompt identity')
    }
    // Missing IDs are legitimate in the pinned schema. Event order is native
    // evidence because qualification serializes prompt dispatch in one writer.
    completions.push({
      completedAt: validTimestamp(event.ts, 'Amplifier stored completion timestamp'),
      ordinal: completions.length + 1,
      eventSha256: record.recordSha256,
    })
    promptPending = false
    pendingPromptId = undefined
  }
  if (promptPending) throw new Error('Amplifier native events end with an unpersisted successful prompt')
  if (completions.length === 0) throw new Error('Amplifier exact native session has no stored completed prompt')

  const transcript = readBoundedJsonlWithPositions(path.join(sessionDir, 'transcript.jsonl'), 'Amplifier native transcript')
  const assistantRecords = transcript.filter((record) => record.value.role === 'assistant')
  if (assistantRecords.length !== completions.length) {
    throw new Error('Amplifier completed prompts do not map one-to-one to append-only assistant records')
  }
  if (assistantRecords.length > MAX_NATIVE_TURNS) throw new Error('Amplifier native completed turns exceed the evidence bound')

  const turns: NativeAssistantTurn[] = assistantRecords.map((record, index) => {
    const message = record.value
    const materialized = contentTextAndTools(message)
    const completion = completions[index]
    return {
      nativeEvidence: {
        kind: 'append_only_record',
        recordIndex: record.recordIndex,
        byteStart: record.byteStart,
        byteEnd: record.byteEnd,
        recordSha256: record.recordSha256,
        prefixSha256Before: record.prefixSha256Before,
        completionEventOrdinal: completion.ordinal,
        completionEventSha256: completion.eventSha256,
      },
      completedAt: completion.completedAt,
      text: materialized.text,
      // The pinned hook schema does not correlate tool:pre to a specific turn.
      // Conservatively attach every exact-session invocation so no-tools
      // certification can never hide provider-native tool activity.
      toolCalls: boundedToolCalls([...materialized.calls, ...eventToolCalls], 'Amplifier native tool calls'),
      resolvedProvider: profile.provider,
      resolvedModel: profile.model,
      resolvedReasoningEffort: profile.effort,
      providerProvenance: 'amplifier-session:config.provider',
      modelProvenance: 'amplifier-session:config.default_model',
      reasoningEffortProvenance: 'amplifier-session:config.reasoning_effort',
    }
  })
  return { schemaVersion: NATIVE_HISTORY_SCHEMA_VERSION, provider: 'amplifier', nativeSessionId: sessionId, turns }
}
