import { findFiles, readBoundedJsonl, safeOpaqueId } from './safe-io.js'
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

type TurnContext = { model: string; effort: string; modelProvenance: string; effortProvenance: string }

function contextFor(payload: Record<string, any>): TurnContext {
  const modelCandidates: [unknown, string][] = [
    [payload.model, 'codex-turn_context.model'],
    [payload.settings?.model, 'codex-turn_context.settings.model'],
  ]
  const effortCandidates: [unknown, string][] = [
    [payload.effort, 'codex-turn_context.effort'],
    [payload.reasoning_effort, 'codex-turn_context.reasoning_effort'],
    [payload.settings?.reasoning_effort, 'codex-turn_context.settings.reasoning_effort'],
    [payload.settings?.model_reasoning_effort, 'codex-turn_context.settings.model_reasoning_effort'],
  ]
  const model = modelCandidates.find(([value]) => typeof value === 'string' && value)?.[0]
  const modelProvenance = modelCandidates.find(([value]) => typeof value === 'string' && value)?.[1]
  const effort = effortCandidates.find(([value]) => typeof value === 'string' && value)?.[0]
  const effortProvenance = effortCandidates.find(([value]) => typeof value === 'string' && value)?.[1]
  return {
    model: requiredString(model, 'Codex turn_context model'),
    effort: requiredString(effort, 'Codex turn_context reasoning effort'),
    modelProvenance: requiredString(modelProvenance, 'Codex model provenance'),
    effortProvenance: requiredString(effortProvenance, 'Codex effort provenance'),
  }
}

function responseText(payload: Record<string, any>): string | null {
  if (payload.type !== 'message' || payload.role !== 'assistant') return null
  if (!Array.isArray(payload.content)) throw new Error('Codex assistant response_item content must be an array')
  const text = payload.content
    .map((raw) => object(raw, 'Codex assistant content item'))
    .filter((part) => part.type === 'output_text')
    .map((part) => requiredString(part.text, 'Codex assistant output text'))
    .join('')
  return boundedText(text, 'Codex native assistant response')
}

function toolCall(payload: Record<string, any>): NativeToolCall | null {
  const type = typeof payload.type === 'string' ? payload.type : ''
  if (!['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(type)) return null
  return { type, ...(optionalString(payload.name) ? { name: optionalString(payload.name)! } : {}) }
}

function ownsThread(filePath: string, threadId: string): boolean {
  const [first] = readBoundedJsonl(filePath, 'Codex rollout')
  if (first?.type !== 'session_meta') return false
  const payload = object(first.payload, 'Codex session_meta payload')
  return payload.id === threadId || payload.session_id === threadId
}

/** Reads the exact Codex 0.147.0 rollout, never a newest-rollout guess. */
export function readCodexNativeHistory(sessionsRoot: string, exactThreadId: string): NativeHistory {
  const threadId = safeOpaqueId(exactThreadId, 'Codex native thread id')
  // Rollout basenames vary by timestamp, so inspect bounded *.jsonl candidates' line-zero session_meta.
  const candidates = findFiles(
    sessionsRoot,
    (basename) => basename.endsWith('.jsonl') && basename.includes(threadId),
  )
  const matches = candidates.filter((candidate) => ownsThread(candidate, threadId))
  if (matches.length === 0) throw new Error(`Codex exact thread session_meta is missing: ${threadId}`)
  if (matches.length !== 1) throw new Error(`Codex exact thread rollout is ambiguous or duplicated: ${threadId}`)

  const rows = readBoundedJsonl(matches[0], 'Codex native rollout')
  const meta = object(rows[0]?.payload, 'Codex session_meta payload')
  const provider = requiredString(meta.model_provider, 'Codex session_meta model provider')
  const contexts = new Map<string, TurnContext>()
  const assistantItems: { id: string | null; text: string; parent: string | null }[] = []
  const pendingTools: NativeToolCall[] = []
  const turns: NativeAssistantTurn[] = []
  for (const row of rows.slice(1)) {
    const payload = object(row.payload, 'Codex rollout payload')
    if (row.type === 'turn_context') {
      contexts.set(requiredString(payload.turn_id, 'Codex turn_context turn id'), contextFor(payload))
      assistantItems.length = 0
      pendingTools.length = 0
      continue
    }
    if (row.type === 'response_item') {
      const call = toolCall(payload)
      if (call) pendingTools.push(call)
      const text = responseText(payload)
      if (text !== null) assistantItems.push({
        id: optionalString(payload.id), text, parent: optionalString(payload.parent_id ?? payload.parentId),
      })
      continue
    }
    if (row.type !== 'event_msg' || payload.type !== 'task_complete') continue
    const turnId = requiredString(payload.turn_id, 'Codex task_complete turn id')
    const context = contexts.get(turnId)
    if (!context) throw new Error(`Codex completed turn ${turnId} lacks turn_context profile metadata`)
    const finalText = requiredString(payload.last_agent_message, 'Codex task_complete last assistant message')
    const response = [...assistantItems].reverse().find((item) => item.text === finalText)
    // Codex rollouts do not promise a response_item id; the native completed turn UUID is authoritative.
    const messageId = response?.id ?? turnId
    turns.push({
      nativeEvidence: { kind: 'identified_message', turnId, messageId, parentMessageId: optionalString(response?.parent) },
      turnId,
      messageId,
      parentMessageId: response?.parent ?? null,
      completedAt: validTimestamp(row.timestamp, 'Codex task completion timestamp'),
      text: boundedText(finalText, 'Codex native assistant response'),
      toolCalls: boundedToolCalls([...pendingTools], 'Codex native tool calls'),
      resolvedProvider: provider,
      resolvedModel: context.model,
      resolvedReasoningEffort: context.effort,
      providerProvenance: 'codex-session_meta.model_provider',
      modelProvenance: context.modelProvenance,
      reasoningEffortProvenance: context.effortProvenance,
    })
    assistantItems.length = 0
    pendingTools.length = 0
    if (turns.length > MAX_NATIVE_TURNS) throw new Error('Codex native completed turns exceed the evidence bound')
  }
  if (turns.length === 0) throw new Error('Codex exact native thread has no completed assistant response')
  return { schemaVersion: NATIVE_HISTORY_SCHEMA_VERSION, provider: 'codex', nativeSessionId: threadId, turns }
}
