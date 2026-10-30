import { stripVTControlCharacters } from 'node:util'
import { createHash } from 'node:crypto'

import type {
  NativeProofStage,
  ProviderNativeTurnProof,
} from './provider-qualification-receipt.js'
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
  /** Actual persisted components of a provider message, in source order. */
  components?: NativeMessageComponentEvidence[]
  /** Native attachment ancestry between the first component and its user. */
  parentChain?: NativeMessageComponentEvidence[]
}

export type NativeMessageComponentEvidence = {
  messageId: string
  parentMessageId: string | null
  recordIndex: number
  byteStart: number
  byteEnd: number
  recordSha256: string
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
  /** Native response rows that supplied the observed per-turn profile. */
  responseEventSha256s?: string[]
}

export type NativeTurnEvidence = IdentifiedMessageEvidence | AppendOnlyRecordEvidence

export type NativeAssistantTurn = {
  nativeEvidence: NativeTurnEvidence
  /** Convenience mirrors for providers that actually expose identifiers. */
  turnId?: string
  messageId?: string
  parentMessageId?: string | null
  completedAt: string | number
  /** Finalized OpenCode rows can contain an API error instead of a successful result. */
  outcome?: 'completed' | 'failed'
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

/** For prompts requesting an answer; tool-only history remains valid native history. */
export function hasSuccessfulNativeAnswer(turn: NativeAssistantTurn | undefined, provider: string): boolean {
  return !!turn?.text.trim() && turn.outcome !== 'failed'
    && (provider !== 'opencode' || turn.outcome === 'completed')
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

export function nativeTurnProof(
  stage: NativeProofStage,
  nativeSessionId: string,
  turn: NativeAssistantTurn,
  nonce: string,
): ProviderNativeTurnProof {
  if (!turn.text.includes(nonce)) throw new Error(`${stage} native assistant response does not contain the nonce`)
  const toolCallTypes = turn.toolCalls.map((call) => call.name ? `${call.type}:${call.name}` : call.type)
  return {
    schemaVersion: 2,
    stage,
    nativeSessionId,
    nativeEvidence: turn.nativeEvidence,
    completedAt: turn.completedAt,
    responseSha256: createHash('sha256').update(turn.text).digest('hex'),
    responseContainsNonce: true,
    toolCallCount: turn.toolCalls.length,
    toolCallTypes,
    resolvedProvider: turn.resolvedProvider,
    resolvedModel: turn.resolvedModel,
    resolvedReasoningEffort: turn.resolvedReasoningEffort,
    providerProvenance: turn.providerProvenance,
    modelProvenance: turn.modelProvenance,
    reasoningEffortProvenance: turn.reasoningEffortProvenance,
  }
}

export function selectNativeAssistantTurn(
  turns: readonly NativeAssistantTurn[],
  priorMessageIds: ReadonlySet<string>,
  expectedText: string,
): NativeAssistantTurn | null {
  return turns.find((turn) => (
    typeof turn.messageId === 'string' && turn.messageId.length > 0
    && !priorMessageIds.has(turn.messageId)
    && turn.toolCalls.length === 0
    && turn.text.includes(expectedText)
  )) ?? null
}


/** The configured model must appear after Build in the same visible header line. */
export function hasOpenCodePromptModelText(
  renderedText: string,
  expectedModelTexts: readonly string[],
): boolean {
  const modelTexts = expectedModelTexts.filter((modelText) => modelText.length > 0)
  if (modelTexts.length === 0) return false

  return renderedText.split(/\r\n|\n|\r/).some((line) => {
    const buildIndex = line.indexOf('Build')
    if (buildIndex === -1) return false
    const headerText = line.slice(buildIndex + 'Build'.length)
    return modelTexts.some((modelText) => headerText.includes(modelText))
  })
}

/** Resumed conversations omit the home-screen placeholder. Observe model text and actual TUI input mode. */
export function openCodeTerminalReady(
  rawOutput: string,
  expectedModelTexts: readonly string[],
): boolean {
  const modes = [...rawOutput.matchAll(/\x1b\[\?2004([hl])/g)]
  if (modes.at(-1)?.[1] !== 'h') return false
  const rendered = stripVTControlCharacters(rawOutput)
  return hasOpenCodePromptModelText(rendered, expectedModelTexts)
}
