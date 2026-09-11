export const NATIVE_HISTORY_SCHEMA_VERSION = 1 as const
export const MAX_NATIVE_TURNS = 128
export const MAX_TOOL_CALLS_PER_TURN = 64
export const MAX_TOOL_TYPE_LENGTH = 64
export const MAX_RESPONSE_BYTES = 64 * 1024

export type NativeToolCall = {
  type: string
  name?: string
}

export type IdentifiedMessageEvidence = {
  kind: 'identified_message'
  turnId: string
  messageId: string
  parentMessageId: string | null
}

export type AppendOnlyRecordEvidence = {
  kind: 'append_only_record'
  recordIndex: number
  byteStart: number
  byteEnd: number
  recordSha256: string
  prefixSha256Before: string
  completionEventOrdinal: number
  completionEventSha256: string
}

export type NativeTurnEvidence = IdentifiedMessageEvidence | AppendOnlyRecordEvidence

export type NativeAssistantTurn = {
  nativeEvidence: NativeTurnEvidence
  /** Convenience mirrors for providers that actually expose identifiers. */
  turnId?: string
  messageId?: string
  parentMessageId?: string | null
  completedAt: string | number
  text: string
  toolCalls: NativeToolCall[]
  resolvedProvider: string
  resolvedModel: string
  resolvedReasoningEffort: string
  providerProvenance: string
  modelProvenance: string
  reasoningEffortProvenance: string
}

export type NativeHistory = {
  schemaVersion: typeof NATIVE_HISTORY_SCHEMA_VERSION
  provider: 'claude' | 'codex' | 'opencode' | 'amplifier'
  nativeSessionId: string
  turns: NativeAssistantTurn[]
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
  return value as Record<string, any>
}

export function boundedText(value: string, label: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_RESPONSE_BYTES) throw new Error(`${label} exceeds the evidence bound`)
  return value
}

export function boundedToolCalls(calls: NativeToolCall[], label: string): NativeToolCall[] {
  if (calls.length > MAX_TOOL_CALLS_PER_TURN) throw new Error(`${label} exceeds the tool-call evidence bound`)
  return calls.map((call) => {
    const type = requiredString(call.type, `${label} type`)
    const name = call.name === undefined ? undefined : requiredString(call.name, `${label} name`)
    if (type.length > MAX_TOOL_TYPE_LENGTH || (name?.length ?? 0) > MAX_TOOL_TYPE_LENGTH) {
      throw new Error(`${label} contains an overlong tool-call type or name`)
    }
    return name ? { type, name } : { type }
  })
}

export function validTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label)
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be a valid timestamp`)
  return timestamp
}
