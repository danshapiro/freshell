import type {
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

type OpencodeExportWithPageMetadata = OpencodeExport & {
  nextCursor?: string | null
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

function stripSurroundingQuotes(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1)
  return text
}

function itemFromPart(
  part: Record<string, any>,
  fallbackId: string,
  role?: FreshAgentTurn['role'],
): FreshAgentTranscriptItem | undefined {
  const id = typeof part.id === 'string' && part.id.length > 0 ? part.id : fallbackId
  if (part.type === 'text') {
    const rawText = typeof part.text === 'string' ? part.text : ''
    const text = role === 'user' ? stripSurroundingQuotes(rawText) : rawText
    return { id, kind: 'text', text }
  }
  if (part.type === 'reasoning') {
    const text = typeof part.text === 'string' ? part.text : ''
    return { id, kind: 'reasoning', summary: text ? [text] : [], content: text ? [text] : [], text }
  }
  if (part.type === 'tool') {
    const state = part.state && typeof part.state === 'object' ? part.state as Record<string, any> : {}
    return {
      id,
      kind: 'dynamic_tool',
      namespace: 'opencode',
      tool: typeof part.tool === 'string' ? part.tool : 'tool',
      status: state.status === 'completed' ? 'completed' : (state.status === 'error' ? 'failed' : 'running'),
      arguments: state.input ?? {},
      contentItems: typeof state.output === 'string' ? [state.output] : undefined,
      success: state.status === 'completed' ? true : undefined,
    }
  }
  if (part.type === 'file') {
    return { id, kind: 'text', text: `Attached file: ${fileAttachmentTarget(part)}` }
  }
  if (part.type === 'patch') {
    return {
      id,
      kind: 'file_change',
      status: 'completed',
      changes: normalizePatchChanges(part.files),
      extensions: { opencode: part },
    }
  }
  if (part.type === 'compaction') {
    return { id, kind: 'context_compaction' }
  }
  return undefined
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

export function normalizeOpencodeTurn(message: NonNullable<OpencodeExport['messages']>[number], ordinal: number): FreshAgentTurn {
  const info = message.info ?? {}
  const id = typeof info.id === 'string' && info.id.length > 0 ? info.id : `message-${ordinal}`
  const role: FreshAgentTurn['role'] = info.role === 'user' || info.role === 'assistant' || info.role === 'system' || info.role === 'tool' ? info.role : undefined
  const parts = Array.isArray(message.parts) ? message.parts : []
  const items = parts
    .map((part, index) => itemFromPart(part, `${id}:part-${index}`, role))
    .filter((item): item is FreshAgentTranscriptItem => Boolean(item))
  const textSummary = items.find((item) => item.kind === 'text')?.text
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
}): FreshAgentSnapshot {
  const info = input.exported?.info ?? {}
  const messages = Array.isArray(input.exported?.messages) ? input.exported.messages : []
  const turns = messages.map((message, index) => normalizeOpencodeTurn(message, index))
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
      fork: false,
      worktrees: false,
      diffs: true,
      childThreads: false,
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
    turns,
    extensions: { opencode: opencodeExtensions },
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
    turns: messages.map((message, index) => normalizeOpencodeTurn(message, index)),
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
  return {
    ...normalizeOpencodeTurn(messages[index], index),
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: input.threadId,
    revision: input.revision,
  }
}
