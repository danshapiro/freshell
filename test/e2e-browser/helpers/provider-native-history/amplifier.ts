import path from 'node:path'

import { findExactSessionDirectories, readBoundedJsonlWithPositions, safeOpaqueId, type PositionedJsonlRecord } from './safe-io.js'
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

function profileFromEvents(events: Record<string, any>[]): AmplifierProfile | null {
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
  if (profiles.length === 0) return null
  const canonical = JSON.stringify(profiles[0])
  if (profiles.some((profile) => JSON.stringify(profile) !== canonical)) {
    throw new Error('Amplifier native session:config profile evidence is conflicting')
  }
  return profiles[0]
}

type Completion = {
  completedAt: string
  ordinal: number
  eventSha256: string
  profile: AmplifierProfile
  observed?: { prompt: string; response: string; submittedAt: number; responseAt: number; requestId: string | null; responseEventSha256s: string[] }
}

/** The pinned CLI emits an orchestrator preview and a final CLI callback for
 * one prompt. Only the subsequent durable cleanup closes that prompt. */
function observedCompletions(records: PositionedJsonlRecord[]): Completion[] {
  const completions: Completion[] = []
  let lastEventAt = 0
  let current: { prompt: string; submittedAt: number; lastAt: number; requestId: string | null; responses: PositionedJsonlRecord[]; callbacks: Record<string, any>[] } | undefined
  for (const record of records) {
    const event = record.value
    if (!['prompt:submit', 'llm:response', 'prompt:complete', 'cleanup:store_end'].includes(event.event)) continue
    const at = Date.parse(validTimestamp(event.ts, 'Amplifier native prompt event timestamp'))
    if (at < lastEventAt) throw new Error('Amplifier native prompt timeline is reversed')
    lastEventAt = at
    const id = optionalString(event.request_id ?? event.span_id)
    if (event.event === 'prompt:submit') {
      if (current) throw new Error('Amplifier native events contain overlapping submitted prompts')
      current = { prompt: requiredString(object(event.data, 'Amplifier submitted prompt data').prompt, 'Amplifier submitted prompt'), submittedAt: at, lastAt: at, requestId: id, responses: [], callbacks: [] }
      continue
    }
    if (!current) throw new Error('Amplifier native completion/response lacks a preceding submitted prompt')
    if (at < current.lastAt || (id && current.requestId && id !== current.requestId)) throw new Error('Amplifier native response/completion has conflicting prompt identity or event order')
    current.lastAt = at; current.requestId ??= id
    if (event.status !== undefined && event.status !== 'ok') throw new Error('Amplifier native prompt response or persistence was unsuccessful')
    if (event.event === 'llm:response') {
      if (current.callbacks.length) throw new Error('Amplifier native response follows prompt completion')
      current.responses.push(record)
      continue
    }
    if (event.event === 'prompt:complete') {
      current.callbacks.push(object(event.data, 'Amplifier completion callback data'))
      continue
    }
    if (!current.responses.length || current.callbacks.length !== 2) throw new Error('Amplifier stored prompt lacks its native response and preview/full completion callbacks')
    const profiles = current.responses.map(response => {
      const data = object(response.value.data, 'Amplifier llm:response data')
      return { provider: requiredString(data.provider, 'Amplifier observed response provider'), model: requiredString(data.model, 'Amplifier observed response model'),
        effort: data.reasoning_effort === undefined || data.reasoning_effort === null ? 'unknown' : requiredString(data.reasoning_effort, 'Amplifier observed response effort') }
    })
    if (profiles.some(profile => JSON.stringify(profile) !== JSON.stringify(profiles[0]))) throw new Error('Amplifier native responses have conflicting per-prompt profile evidence')
    // The pinned producer establishes this pair; a preview alone cannot prove
    // the complete response or its exact submitted prompt.
    const [preview, full] = current.callbacks as [Record<string, any>, Record<string, any>]
    if (typeof preview.response_preview !== 'string' || !Number.isSafeInteger(preview.length) || typeof full.prompt !== 'string' || typeof full.response !== 'string'
      || full.response.length !== preview.length || !full.response.startsWith(preview.response_preview)) throw new Error('Amplifier native completion callbacks are duplicated or conflicting')
    if (full.prompt !== current.prompt) throw new Error('Amplifier completion callback conflicts with the submitted native prompt')
    const response = requiredString(full.response, 'Amplifier completed response')
    completions.push({ completedAt: event.ts, ordinal: completions.length + 1, eventSha256: record.recordSha256, profile: profiles[0]!,
      observed: { prompt: current.prompt, response, submittedAt: current.submittedAt, responseAt: Date.parse(current.responses.at(-1)!.value.ts), requestId: current.requestId, responseEventSha256s: current.responses.map(row => row.recordSha256) } })
    current = undefined
  }
  if (current) throw new Error('Amplifier native events end with an unpersisted submitted prompt')
  return completions
}

/** Preserve the older configuration-only shape without calling its defaults
 * observed response telemetry. */
function configuredCompletions(records: PositionedJsonlRecord[], profile: AmplifierProfile | null): Completion[] {
  if (!profile) throw new Error('Amplifier native events lack response or configured profile evidence')
  const completions: Completion[] = []
  let pendingPromptId: string | null | undefined
  let promptPending = false
  for (const record of records) {
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
    // Missing IDs are legitimate in the pinned schema. Qualification supplies
    // a serialized one-writer append boundary rather than inventing an ID.
    completions.push({ completedAt: validTimestamp(event.ts, 'Amplifier stored completion timestamp'),
      ordinal: completions.length + 1, eventSha256: record.recordSha256, profile })
    promptPending = false
    pendingPromptId = undefined
  }
  if (promptPending) throw new Error('Amplifier native events end with an unpersisted successful prompt')
  return completions
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

  const hasResponseTimeline = events.some(event => event.event === 'prompt:submit' || event.event === 'llm:response' || event.event === 'llm:request')
  const completions = hasResponseTimeline ? observedCompletions(positionedEvents) : configuredCompletions(positionedEvents, profile)
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
    if (completion.observed) {
      const observed = completion.observed, prior = transcript.find(prior => prior.recordIndex === record.recordIndex - 1)?.value
      if (prior?.role !== 'user' || prior.content !== observed.prompt) throw new Error('Amplifier native response does not map to the exact preceding transcript prompt')
      if (materialized.text !== observed.response) throw new Error('Amplifier native response does not match the stored assistant content')
      const transcriptId = optionalString(message.metadata?.request_id ?? message.request_id)
      if (transcriptId && observed.requestId && transcriptId !== observed.requestId) throw new Error('Amplifier transcript conflicts with the provider-supplied prompt identity')
      const assistantAt = Date.parse(validTimestamp(message.metadata?.timestamp ?? message.timestamp, 'Amplifier stored assistant timestamp'))
      if (assistantAt < observed.responseAt || assistantAt > Date.parse(completion.completedAt)) throw new Error('Amplifier stored assistant timestamp is outside its native response/persistence interval')
      const userAt = Date.parse(validTimestamp(prior.metadata?.timestamp ?? prior.timestamp, 'Amplifier stored user timestamp'))
      if (userAt < observed.submittedAt || userAt > observed.responseAt) throw new Error('Amplifier stored user timestamp is outside its native submission/response interval')
    }
    const nativeProfile = completion.profile
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
        ...(completion.observed ? { responseEventSha256s: completion.observed.responseEventSha256s } : {}),
      },
      completedAt: completion.completedAt,
      text: materialized.text,
      // The pinned hook schema does not correlate tool:pre to a specific turn.
      // Conservatively attach every exact-session invocation so no-tools
      // certification can never hide provider-native tool activity.
      toolCalls: boundedToolCalls([...materialized.calls, ...eventToolCalls], 'Amplifier native tool calls'),
      resolvedProvider: nativeProfile.provider,
      resolvedModel: nativeProfile.model,
      resolvedReasoningEffort: nativeProfile.effort,
      providerProvenance: completion.observed ? 'amplifier-llm:response.provider' : 'amplifier-session:config.provider',
      modelProvenance: completion.observed ? 'amplifier-llm:response.model' : 'amplifier-session:config.default_model',
      reasoningEffortProvenance: completion.observed ? nativeProfile.effort === 'unknown' ? 'unsupported-native-telemetry' : 'amplifier-llm:response.reasoning_effort' : 'amplifier-session:config.reasoning_effort',
    }
  })
  return { schemaVersion: NATIVE_HISTORY_SCHEMA_VERSION, provider: 'amplifier', nativeSessionId: sessionId, turns }
}
