import type {
  FreshAgentSessionCommand,
  FreshAgentSnapshot,
  FreshAgentTranscriptItem,
  FreshAgentTurn,
  FreshAgentTurnBody,
  FreshAgentTurnPage,
} from '../../../../shared/fresh-agent-contract.js'

export type OpencodeExport = {
  info?: Record<string, any>
  messages?: Array<{
    info?: Record<string, any>
    parts?: Array<Record<string, any>>
  }>
}

const STRUCTURAL_PART_TYPES = new Set(['step-start', 'step-finish'])
const VISIBLE_PART_TYPES = new Set(['text', 'reasoning', 'tool', 'file', 'patch', 'compaction'])

/** Per-turn interruption evidence surfaced under `extensions.opencode.turnEvidence`
 * (kata zrrj). Field names validated against opencode 1.18.x live data; extraction
 * stays defensive because future sidecar versions may drift. NEVER carries payload
 * beyond error name/message — no prompt/assistant/tool text. */
export type OpencodeTurnEvidence = {
  turnId: string
  role: string
  timeCreated?: number
  timeCompleted?: number // absent => unfinished (assistant)
  error?: { name?: string; message?: string } // e.g. { name: 'MessageAbortedError' }
  tokens?: { input?: number; output?: number }
  cost?: number
  runningToolPartCount: number // parts with state.status === 'running'
  stepStartCount: number
  stepFinishCount: number
}

/** Pure extraction of interruption evidence from the raw sidecar message passthrough.
 * Tolerates `{ name, message }`, `{ data: { message } }`, and plain-string error shapes
 * (mirroring opencodeErrorMessage in serve-events.ts). Absent fields yield absent
 * evidence properties; malformed input never crashes. */
function extractTurnEvidence(messages: NonNullable<OpencodeExport['messages']>): OpencodeTurnEvidence[] {
  return messages.map((message) => {
    const info = message?.info ?? {}
    const parts = Array.isArray(message?.parts) ? message.parts : []
    const err = info?.error
    const error = err
      ? {
          ...(typeof err?.name === 'string' ? { name: err.name } : {}),
          ...(typeof err?.message === 'string'
            ? { message: err.message }
            : typeof err?.data?.message === 'string'
              ? { message: err.data.message }
              : typeof err === 'string' ? { message: err } : {}),
        }
      : undefined
    const counts = { running: 0, stepStart: 0, stepFinish: 0 }
    for (const part of parts) {
      if (part?.type === 'tool' && part?.state?.status === 'running') counts.running += 1
      if (part?.type === 'step-start') counts.stepStart += 1
      if (part?.type === 'step-finish') counts.stepFinish += 1
    }
    const tokens = info?.tokens && typeof info.tokens === 'object'
      ? {
          ...(Number.isFinite(info.tokens.input) ? { input: Number(info.tokens.input) } : {}),
          ...(Number.isFinite(info.tokens.output) ? { output: Number(info.tokens.output) } : {}),
        }
      : undefined
    return {
      turnId: String(info?.id ?? ''),
      role: typeof info?.role === 'string' ? info.role : 'unknown',
      ...(Number.isFinite(info?.time?.created) ? { timeCreated: Number(info.time.created) } : {}),
      ...(Number.isFinite(info?.time?.completed) ? { timeCompleted: Number(info.time.completed) } : {}),
      ...(error && (error.name || error.message) ? { error } : {}),
      ...(tokens && (tokens.input !== undefined || tokens.output !== undefined) ? { tokens } : {}),
      ...(Number.isFinite(info?.cost) ? { cost: Number(info.cost) } : {}),
      runningToolPartCount: counts.running,
      stepStartCount: counts.stepStart,
      stepFinishCount: counts.stepFinish,
    }
  })
}

type OpencodeExportWithPageMetadata = OpencodeExport & {
  nextCursor?: string | null
}

function normalizeOpencodeRole(value: unknown): FreshAgentTurn['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool'
    ? value
    : undefined
}

function modelFromInfo(info: Record<string, any> | undefined): string | undefined {
  const providerId = info?.providerID ?? info?.model?.providerID
  const modelId = info?.modelID ?? info?.model?.modelID ?? info?.model?.id
  if (typeof providerId === 'string' && typeof modelId === 'string') {
    return `${providerId}/${modelId}`
  }
  return typeof modelId === 'string' ? modelId : undefined
}

function tokenUsage(info: Record<string, any> | undefined): FreshAgentSnapshot['tokenUsage'] {
  const tokens = info?.tokens && typeof info.tokens === 'object' ? info.tokens as Record<string, any> : {}
  const inputTokens = Number.isFinite(tokens.input) ? Number(tokens.input) : 0
  const outputTokens = Number.isFinite(tokens.output) ? Number(tokens.output) : 0
  const cachedTokens = Number.isFinite(tokens.cache?.read) ? Number(tokens.cache.read) : undefined
  return {
    inputTokens,
    outputTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    totalTokens: Number.isFinite(tokens.total) ? Number(tokens.total) : inputTokens + outputTokens + (cachedTokens ?? 0),
    ...(Number.isFinite(tokens.reasoning) ? { contextTokens: Number(tokens.reasoning) } : {}),
    ...(info && Number.isFinite(info.cost) ? { costUsd: Number(info.cost) } : {}),
  }
}

function fileAttachmentTarget(part: Record<string, any>): string {
  for (const key of ['filename', 'name', 'url', 'path']) {
    if (typeof part[key] === 'string' && part[key].trim().length > 0) return part[key].trim()
  }
  return 'unknown file'
}

function normalizePatchChange(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string' && value.length > 0) return { path: value }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const change: Record<string, unknown> = { ...record }
  if (typeof change.path !== 'string') {
    const path = typeof record.file === 'string'
      ? record.file
      : typeof record.name === 'string'
        ? record.name
        : undefined
    if (path) change.path = path
  }
  return change
}

function normalizePatchChanges(files: unknown): Record<string, unknown>[] {
  const values = Array.isArray(files)
    ? files
    : (typeof files === 'string' || (files && typeof files === 'object' && !Array.isArray(files)))
        ? [files]
        : []
  return values
    .map((value) => normalizePatchChange(value))
    .filter((value): value is Record<string, unknown> => Boolean(value))
}

/**
 * The OpenCode `run` subcommand stores a single positional prompt that
 * contains spaces by wrapping it in literal double quotes. Other input paths
 * (interactive composer, API-level sends, ACP) store the text as-is. We can
 * therefore remove one outer pair of double quotes deterministically for user
 * text turns without touching assistant text or legitimate inline quoting.
 */
function stripOpencodeRunArgumentQuoting(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1)
  return text
}

type NormalizedTextSegment = {
  kind: 'text' | 'thinking'
  text: string
}

const THINK_TAG_PATTERN = /<\/?thinking\b[^>]*>|<\/?think\b[^>]*>/gi
const BALANCED_THINK_TAG_PATTERN = /<(thinking|think)\b[^>]*>([\s\S]*?)<\/\1>/gi
const LEADING_THINK_CLOSER_PATTERN = /^\s*(?:(?:<\/thinking>|<\/think>)\s*)+/i
const THINK_OPEN_TAG_PATTERN = /<(thinking|think)\b[^>]*>/i
const THINK_CLOSE_TAG_PATTERN = /<\/(?:thinking|think)>/i
const SYNTHETIC_TEXT_SEGMENT_ID_SUFFIX_PATTERN = /:(?:text|thinking)-\d+$/

function hasThinkTag(text: string): boolean {
  THINK_TAG_PATTERN.lastIndex = 0
  return THINK_TAG_PATTERN.test(text)
}

function stripThinkTagMarkers(text: string): string {
  THINK_TAG_PATTERN.lastIndex = 0
  return text.replace(THINK_TAG_PATTERN, '')
}

function normalizeBalancedThinkTags(text: string): NormalizedTextSegment[] | null {
  const segments: NormalizedTextSegment[] = []
  let cursor = 0
  let matched = false
  BALANCED_THINK_TAG_PATTERN.lastIndex = 0
  for (const match of text.matchAll(BALANCED_THINK_TAG_PATTERN)) {
    matched = true
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: stripThinkTagMarkers(text.slice(cursor, match.index)) })
    }
    segments.push({ kind: 'thinking', text: (match[2] ?? '').trim() })
    cursor = match.index + match[0].length
  }
  if (!matched) return null
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: stripThinkTagMarkers(text.slice(cursor)) })
  }
  return segments
}

function segmentsToItems(id: string, segments: NormalizedTextSegment[]): FreshAgentTranscriptItem[] {
  const visibleSegments = segments.filter((segment) => segment.text.length > 0)
  if (visibleSegments.length === 0) return []
  return visibleSegments.map((segment, index) => ({
    id: visibleSegments.length === 1 ? id : `${id}:${segment.kind}-${index}`,
    kind: segment.kind,
    text: segment.text,
  }))
}

/** OpenCode / Kimi can leak internal reasoning tags into assistant text.
 * OpenCode should surface those as thinking blocks; until it does, normalize
 * the provider-specific leakage here and keep user-authored text untouched. */
function itemsFromAssistantTextPart(text: string, id: string, leadingCloserIsThinking: boolean): FreshAgentTranscriptItem[] {
  if (!hasThinkTag(text)) return [{ id, kind: 'text', text }]

  const balanced = normalizeBalancedThinkTags(text)
  if (balanced) return segmentsToItems(id, balanced)

  const withoutMarkers = stripThinkTagMarkers(text)
  if (LEADING_THINK_CLOSER_PATTERN.test(text)) {
    const normalized = withoutMarkers.trim()
    if (!normalized) return []
    return [{
      id,
      kind: leadingCloserIsThinking ? 'thinking' : 'text',
      text: normalized,
    }]
  }

  const openMatch = THINK_OPEN_TAG_PATTERN.exec(text)
  if (openMatch?.index !== undefined) {
    return segmentsToItems(id, [
      { kind: 'text', text: stripThinkTagMarkers(text.slice(0, openMatch.index)) },
      { kind: 'thinking', text: stripThinkTagMarkers(text.slice(openMatch.index + openMatch[0].length)).trim() },
    ])
  }

  const closeMatch = THINK_CLOSE_TAG_PATTERN.exec(text)
  if (closeMatch?.index !== undefined) {
    return segmentsToItems(id, [
      { kind: 'thinking', text: stripThinkTagMarkers(text.slice(0, closeMatch.index)).trim() },
      { kind: 'text', text: stripThinkTagMarkers(text.slice(closeMatch.index + closeMatch[0].length)) },
    ])
  }

  return withoutMarkers.length > 0 ? [{ id, kind: 'text', text: withoutMarkers }] : []
}

function itemFromPart(
  part: Record<string, any>,
  fallbackId: string,
  role?: FreshAgentTurn['role'],
  followedByTool = false,
): FreshAgentTranscriptItem[] {
  const id = typeof part.id === 'string' && part.id.length > 0 ? part.id : fallbackId
  if (part.type === 'text') {
    const rawText = typeof part.text === 'string' ? part.text : ''
    if (role === 'user') {
      return [{ id, kind: 'text', text: stripOpencodeRunArgumentQuoting(rawText) }]
    }
    return itemsFromAssistantTextPart(rawText, id, followedByTool)
  }
  if (part.type === 'reasoning') {
    const text = typeof part.text === 'string' ? part.text : ''
    return [{ id, kind: 'reasoning', summary: text ? [text] : [], content: text ? [text] : [], text }]
  }
  if (part.type === 'tool') {
    const state = part.state && typeof part.state === 'object' ? part.state as Record<string, any> : {}
    return [{
      id,
      kind: 'dynamic_tool',
      namespace: 'opencode',
      tool: typeof part.tool === 'string' ? part.tool : 'tool',
      status: state.status === 'completed' ? 'completed' : (state.status === 'error' ? 'failed' : 'running'),
      arguments: state.input ?? {},
      contentItems: typeof state.output === 'string' ? [state.output] : undefined,
      success: state.status === 'completed' ? true : undefined,
    }]
  }
  if (part.type === 'file') {
    return [{ id, kind: 'text', text: `Attached file: ${fileAttachmentTarget(part)}` }]
  }
  if (part.type === 'patch') {
    return [{
      id,
      kind: 'file_change',
      status: 'completed',
      changes: normalizePatchChanges(part.files),
      extensions: { opencode: part },
    }]
  }
  if (part.type === 'compaction') {
    return [{ id, kind: 'context_compaction' }]
  }
  return []
}

function computeToolAfterByPartIndex(parts: Record<string, any>[]): boolean[] {
  const toolAfterByPartIndex = new Array<boolean>(parts.length).fill(false)
  let hasToolAfter = false
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    toolAfterByPartIndex[index] = hasToolAfter
    if (parts[index]?.type === 'tool') hasToolAfter = true
  }
  return toolAfterByPartIndex
}

function textSummaryFromItems(items: FreshAgentTranscriptItem[]): string | undefined {
  const textItems = items.filter((item): item is Extract<FreshAgentTranscriptItem, { kind: 'text' }> => item.kind === 'text')
  if (textItems.length === 0) return undefined
  const groups: string[] = []
  let currentSourceId: string | undefined
  let currentText = ''
  for (const item of textItems) {
    const sourceId = item.id.replace(SYNTHETIC_TEXT_SEGMENT_ID_SUFFIX_PATTERN, '')
    if (currentSourceId === undefined || sourceId === currentSourceId) {
      currentSourceId = sourceId
      currentText += item.text
      continue
    }
    if (currentText.length > 0) groups.push(currentText)
    currentSourceId = sourceId
    currentText = item.text
  }
  if (currentText.length > 0) groups.push(currentText)
  return groups.join('\n\n')
}

function collectOpencodePartMetadata(messages: NonNullable<OpencodeExport['messages']>): Record<string, unknown> {
  const structuralPartTypes: Array<{ type: string; id?: string; messageId?: string }> = []
  const unsupportedPartTypes: Array<{ type: string; id?: string; messageId?: string }> = []
  const structuralParts: Array<{ messageId?: string; part: Record<string, any> }> = []
  const unsupportedParts: Array<{ messageId?: string; part: Record<string, any> }> = []
  const fileParts: Array<{ messageId?: string; part: Record<string, any> }> = []
  const compactionParts: Array<{ messageId?: string; part: Record<string, any> }> = []
  const structuralPartCounts: Record<string, number> = {}

  messages.forEach((message) => {
    const messageId = typeof message.info?.id === 'string' ? message.info.id : undefined
    const parts = Array.isArray(message.parts) ? message.parts : []
    parts.forEach((part) => {
      const type = typeof part.type === 'string' ? part.type : undefined
      if (!type) return
      const entry = {
        type,
        ...(typeof part.id === 'string' ? { id: part.id } : {}),
        ...(messageId ? { messageId } : {}),
      }
      const rawEntry = {
        ...(messageId ? { messageId } : {}),
        part,
      }
      if (STRUCTURAL_PART_TYPES.has(type)) {
        structuralPartTypes.push(entry)
        structuralParts.push(rawEntry)
        structuralPartCounts[type] = (structuralPartCounts[type] ?? 0) + 1
        return
      }
      if (type === 'file') {
        fileParts.push(rawEntry)
        return
      }
      if (type === 'compaction') {
        compactionParts.push(rawEntry)
        return
      }
      if (!VISIBLE_PART_TYPES.has(type)) {
        unsupportedPartTypes.push(entry)
        unsupportedParts.push(rawEntry)
      }
    })
  })

  return {
    ...(structuralPartTypes.length > 0 ? { structuralPartTypes, structuralPartCounts, structuralParts } : {}),
    ...(unsupportedPartTypes.length > 0 ? { unsupportedPartTypes, unsupportedParts } : {}),
    ...(fileParts.length > 0 ? { fileParts } : {}),
    ...(compactionParts.length > 0 ? { compactionParts } : {}),
  }
}

export function normalizeOpencodeTurn(
  message: NonNullable<OpencodeExport['messages']>[number],
  ordinal: number,
): FreshAgentTurn | null {
  const info = message.info ?? {}
  const id = typeof info.id === 'string' && info.id.length > 0 ? info.id : `message-${ordinal}`
  const role = normalizeOpencodeRole(info.role)
  const parts = Array.isArray(message.parts) ? message.parts : []
  const toolAfterByPartIndex = computeToolAfterByPartIndex(parts)
  const items = parts
    .flatMap((part, index) => itemFromPart(
      part,
      `${id}:part-${index}`,
      role,
      toolAfterByPartIndex[index] ?? false,
    ))
  if (!role && items.length > 0) return null
  const textSummary = textSummaryFromItems(items)
  const reasoningSummary = items.find((item) => item.kind === 'reasoning')?.summary?.[0]
  return {
    id,
    turnId: id,
    messageId: id,
    ordinal,
    source: 'durable',
    role,
    timestamp: typeof info.time?.created === 'number' ? new Date(info.time.created).toISOString() : undefined,
    model: modelFromInfo(info),
    summary: textSummary ?? reasoningSummary ?? '',
    items,
  }
}

export function normalizeOpencodeSnapshot(input: {
  sessionType: 'freshopencode'
  threadId: string
  exported?: OpencodeExport
  status?: string
  model?: string
  effort?: string
  /** Server half of the client busy-clear gate (kata zrrj): true only when the
   * adapter holds live state whose initial status reconcile completed. Absent
   * when the caller has no live-state notion (e.g. turn pages). */
  statusFromLiveState?: boolean
  /** Sidecar-advertised session commands captured for this session's directory;
   * absent until the create-time catalog fetch lands (graceful absence). */
  commands?: readonly FreshAgentSessionCommand[]
}): FreshAgentSnapshot {
  const info = input.exported?.info ?? {}
  const messages = Array.isArray(input.exported?.messages) ? input.exported.messages : []
  const turns = messages
    .map((message, index) => normalizeOpencodeTurn(message, index))
    .filter((turn): turn is FreshAgentTurn => Boolean(turn))
  const sessionModel = modelFromInfo(info) ?? input.model
  const durableSessionId = typeof info.id === 'string' && info.id.length > 0 ? info.id : input.threadId
  const opencodeExtensions = collectOpencodePartMetadata(messages)
  return {
    sessionType: input.sessionType,
    provider: 'opencode',
    threadId: input.threadId,
    sessionId: durableSessionId,
    revision: Number.isFinite(info.time?.updated) ? Number(info.time.updated) : turns.length,
    latestTurnId: turns.at(-1)?.turnId ?? null,
    status: input.status ?? 'idle',
    summary: typeof info.title === 'string' ? info.title : undefined,
    capabilities: {
      send: true,
      interrupt: true,
      approvals: false,
      questions: false,
      fork: true,
      worktrees: false,
      diffs: true,
      childThreads: false,
      // kata z7j7: model/effort are per-send (re-sent in the prompt_async body);
      // sandbox/permissionMode have no opencode wire concept.
      settingScopes: {
        model: 'per-send',
        effort: 'per-send',
        sandbox: 'unsupported',
        permissionMode: 'unsupported',
      },
    },
    settings: {
      ...(sessionModel ? { model: sessionModel } : {}),
      ...(input.effort ? { effort: input.effort as any } : {}),
    },
    tokenUsage: tokenUsage(info),
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    ...(input.commands ? { commands: input.commands } : {}),
    turns,
    extensions: {
      opencode: {
        ...opencodeExtensions,
        turnEvidence: extractTurnEvidence(messages),
        ...(typeof input.statusFromLiveState === 'boolean' ? { statusFromLiveState: input.statusFromLiveState } : {}),
      },
    },
  }
}

export function normalizeOpencodeTurnPage(input: {
  threadId: string
  exported?: OpencodeExportWithPageMetadata
  revision: number
  nextCursor?: string | null
}): FreshAgentTurnPage {
  const messages = Array.isArray(input.exported?.messages) ? input.exported.messages : []
  const nextCursor = Object.prototype.hasOwnProperty.call(input, 'nextCursor')
    ? input.nextCursor
    : input.exported?.nextCursor
  return {
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: input.threadId,
    revision: input.revision,
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
    turns: messages
      .map((message, index) => normalizeOpencodeTurn(message, index))
      .filter((turn): turn is FreshAgentTurn => Boolean(turn)),
  }
}

export function normalizeOpencodeTurnBody(input: {
  threadId: string
  exported?: OpencodeExport
  turnId: string
  revision: number
}): FreshAgentTurnBody | null {
  const messages = Array.isArray(input.exported?.messages) ? input.exported.messages : []
  const index = messages.findIndex((message) => message.info?.id === input.turnId)
  if (index < 0) return null
  const turn = normalizeOpencodeTurn(messages[index], index)
  if (!turn) return null
  return {
    ...turn,
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: input.threadId,
    revision: input.revision,
  }
}
