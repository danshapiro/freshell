import type {
  FreshAgentSnapshot,
  FreshAgentTranscriptItem,
  FreshAgentTurn,
  FreshAgentTurnBody,
  FreshAgentTurnPage,
} from '../../../../shared/fresh-agent-contract.js'

type OpencodeExport = {
  info?: Record<string, any>
  messages?: Array<{
    info?: Record<string, any>
    parts?: Array<Record<string, any>>
  }>
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

function itemFromPart(part: Record<string, any>, fallbackId: string): FreshAgentTranscriptItem | undefined {
  const id = typeof part.id === 'string' && part.id.length > 0 ? part.id : fallbackId
  if (part.type === 'text') {
    return { id, kind: 'text', text: typeof part.text === 'string' ? part.text : '' }
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
  return undefined
}

export function normalizeOpencodeTurn(message: NonNullable<OpencodeExport['messages']>[number], ordinal: number): FreshAgentTurn {
  const info = message.info ?? {}
  const id = typeof info.id === 'string' && info.id.length > 0 ? info.id : `message-${ordinal}`
  const parts = Array.isArray(message.parts) ? message.parts : []
  const items = parts
    .map((part, index) => itemFromPart(part, `${id}:part-${index}`))
    .filter((item): item is FreshAgentTranscriptItem => Boolean(item))
  const textSummary = items.find((item) => item.kind === 'text')?.text
  const reasoningSummary = items.find((item) => item.kind === 'reasoning')?.summary?.[0]
  return {
    id,
    turnId: id,
    messageId: id,
    ordinal,
    source: 'durable',
    role: info.role === 'user' || info.role === 'assistant' || info.role === 'system' || info.role === 'tool' ? info.role : undefined,
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
    extensions: { opencode: {} },
  }
}

export function normalizeOpencodeTurnPage(input: {
  threadId: string
  exported?: OpencodeExport
  revision: number
}): FreshAgentTurnPage {
  const messages = Array.isArray(input.exported?.messages) ? input.exported.messages : []
  return {
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: input.threadId,
    revision: input.revision,
    nextCursor: null,
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
