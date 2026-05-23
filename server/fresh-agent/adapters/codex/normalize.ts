import {
  FreshAgentSnapshotSchema,
  FreshAgentTurnBodySchema,
  FreshAgentTurnPageSchema,
  type FreshAgentTranscriptItem,
  type FreshAgentTurn,
} from '../../../../shared/fresh-agent-contract.js'

type CodexRawSnapshot = {
  thread?: {
    preview?: string
    turns?: unknown[]
  }
  summary?: string
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    cachedTokens?: number
    totalTokens: number
    contextTokens?: number
    compactPercent?: number
  }
  worktrees?: Array<{ id: string; path: string; branch?: string }>
  diffs?: Array<{ id: string; path: string; title?: string }>
  childThreads?: Array<{ id: string; threadId: string; origin: string; title?: string }>
  extension?: { codex?: Record<string, unknown> }
}

function normalizeCodexItem(turnId: string, item: Record<string, unknown>, index: number): FreshAgentTranscriptItem[] {
  const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : `${turnId}:item:${index}`
  switch (item.type) {
    case 'userMessage': {
      const content = Array.isArray(item.content) ? item.content : []
      if (content.length === 0) {
        return [{ id, kind: 'text', text: '' }]
      }
      return content.map((part, partIndex) => {
        const typedPart = part && typeof part === 'object' ? part as Record<string, unknown> : {}
        if (typedPart.type === 'text') {
          return {
            id: `${id}:part:${partIndex}`,
            kind: 'text' as const,
            text: typeof typedPart.text === 'string' ? typedPart.text : '',
          }
        }
        return {
          id: `${id}:part:${partIndex}`,
          kind: 'text' as const,
          text: `[${String(typedPart.type ?? 'input')}]`,
        }
      })
    }
    case 'agentMessage':
      return [{ id, kind: 'text', text: typeof item.text === 'string' ? item.text : '' }]
    case 'plan':
      return [{ id, kind: 'text', text: typeof item.text === 'string' ? item.text : '' }]
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === 'string') : []
      const content = Array.isArray(item.content) ? item.content.filter((value): value is string => typeof value === 'string') : []
      return [{
        id,
        kind: 'reasoning',
        summary,
        content,
        text: summary.join('\n') || content.join('\n'),
      }]
    }
    case 'commandExecution':
      return [{
        id,
        kind: 'command',
        command: typeof item.command === 'string' ? item.command : '',
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
        status: item.status === 'inProgress' ? 'running' : item.status === 'declined' ? 'declined' : item.status === 'failed' ? 'failed' : 'completed',
        output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
        extensions: { codex: item },
      }]
    case 'fileChange':
      return [{
        id,
        kind: 'file_change',
        status: item.status === 'inProgress' ? 'running' : item.status === 'declined' ? 'declined' : item.status === 'failed' ? 'failed' : 'completed',
        changes: Array.isArray(item.changes)
          ? item.changes.filter((change): change is Record<string, unknown> => !!change && typeof change === 'object' && !Array.isArray(change))
          : [],
        extensions: { codex: item },
      }]
    case 'mcpToolCall':
      return [{
        id,
        kind: 'mcp_tool',
        server: typeof item.server === 'string' ? item.server : '',
        tool: typeof item.tool === 'string' ? item.tool : '',
        status: item.status === 'inProgress' ? 'running' : item.status === 'failed' ? 'failed' : 'completed',
        arguments: item.arguments ?? null,
        result: item.result,
        error: item.error,
      }]
    case 'dynamicToolCall':
      return [{
        id,
        kind: 'dynamic_tool',
        namespace: typeof item.namespace === 'string' ? item.namespace : null,
        tool: typeof item.tool === 'string' ? item.tool : '',
        status: item.status === 'inProgress' ? 'running' : item.status === 'failed' ? 'failed' : 'completed',
        arguments: item.arguments ?? null,
        contentItems: Array.isArray(item.contentItems) ? item.contentItems : null,
        success: typeof item.success === 'boolean' ? item.success : null,
      }]
    case 'collabAgentToolCall':
      return [{
        id,
        kind: 'collab_agent',
        tool: String(item.tool ?? ''),
        status: item.status === 'inProgress' ? 'running' : item.status === 'failed' ? 'failed' : 'completed',
        senderThreadId: String(item.senderThreadId ?? ''),
        receiverThreadIds: Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string')
          : [],
        prompt: typeof item.prompt === 'string' ? item.prompt : null,
        model: typeof item.model === 'string' ? item.model : null,
        reasoningEffort: typeof item.reasoningEffort === 'string' ? item.reasoningEffort : null,
        agentsStates: item.agentsStates && typeof item.agentsStates === 'object' && !Array.isArray(item.agentsStates)
          ? item.agentsStates as Record<string, unknown>
          : {},
      }]
    case 'webSearch':
      return [{
        id,
        kind: 'web_search',
        query: typeof item.query === 'string' ? item.query : '',
        action: item.action ?? null,
      }]
    case 'imageView':
      return [{ id, kind: 'image_view', path: typeof item.path === 'string' ? item.path : '' }]
    case 'imageGeneration':
      return [{
        id,
        kind: 'image_generation',
        status: String(item.status ?? ''),
        revisedPrompt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt : null,
        result: String(item.result ?? ''),
        savedPath: typeof item.savedPath === 'string' ? item.savedPath : undefined,
      }]
    case 'enteredReviewMode':
      return [{ id, kind: 'review_mode', event: 'entered', review: String(item.review ?? '') }]
    case 'exitedReviewMode':
      return [{ id, kind: 'review_mode', event: 'exited', review: String(item.review ?? '') }]
    case 'contextCompaction':
      return [{ id, kind: 'context_compaction' }]
    case 'hookPrompt':
      return [{ id, kind: 'text', text: 'Hook prompt' }]
    default:
      throw new Error(`Unsupported Codex thread item type: ${String(item.type)}`)
  }
}

function inferCodexTurnRole(rawItems: Record<string, unknown>[]): FreshAgentTurn['role'] {
  if (rawItems.some((item) => item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan')) {
    return 'assistant'
  }
  if (rawItems.some((item) => item.type === 'userMessage')) {
    return 'user'
  }
  if (rawItems.some((item) => (
    item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch'
    || item.type === 'imageView'
    || item.type === 'imageGeneration'
  ))) {
    return 'tool'
  }
  return undefined
}

function readCodexTurnError(rawTurn: Record<string, unknown>): string | undefined {
  const error = rawTurn.error
  if (!error) return undefined
  if (typeof error === 'string') return error
  if (typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
  }
  return String(error)
}

export function normalizeCodexTurn(
  rawTurn: Record<string, unknown>,
  ordinal = 0,
  options: { model?: string } = {},
): FreshAgentTurn {
  const turnId = String(rawTurn.id ?? `turn:${ordinal}`)
  const model = typeof rawTurn.model === 'string' && rawTurn.model.length > 0
    ? rawTurn.model
    : options.model
  const rawItems = Array.isArray(rawTurn.items)
    ? rawTurn.items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : []
  const items = rawItems.flatMap((item, index) => normalizeCodexItem(turnId, item, index))
  const hasAssistantOutput = rawItems.some((item) => item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan')
  const turnError = readCodexTurnError(rawTurn)
  if (turnError) {
    items.push({
      id: `${turnId}:error`,
      kind: 'text',
      text: `Codex turn failed: ${turnError}`,
    })
  } else if (
    rawTurn.status === 'completed'
    && rawItems.some((item) => item.type === 'userMessage')
    && rawItems.every((item) => item.type === 'userMessage')
    && !hasAssistantOutput
  ) {
    items.push({
      id: `${turnId}:empty-response`,
      kind: 'text',
      text: 'Codex completed this turn without recording an assistant response.',
    })
  }
  const firstText = items.find((item): item is Extract<FreshAgentTranscriptItem, { kind: 'text' }> => item.kind === 'text')
  return {
    id: turnId,
    turnId,
    ordinal,
    source: 'durable',
    role: inferCodexTurnRole(rawItems),
    ...(model ? { model } : {}),
    summary: firstText?.text.slice(0, 140) ?? '',
    items,
  }
}

export function normalizeCodexTurnPage(input: {
  threadId: string
  revision: number
  rawPage: { turns?: unknown[]; nextCursor?: string | null; backwardsCursor?: string | null }
  model?: string
  modelByTurn?: Map<string, string>
}) {
  const turns = (Array.isArray(input.rawPage.turns) ? input.rawPage.turns : [])
    .filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === 'object' && !Array.isArray(turn))
    .map((turn, index) => normalizeCodexTurn(turn, index, {
      model: (typeof turn.id === 'string' ? input.modelByTurn?.get(turn.id) : undefined) ?? input.model,
    }))

  return FreshAgentTurnPageSchema.parse({
    sessionType: 'freshcodex',
    provider: 'codex',
    threadId: input.threadId,
    revision: input.revision,
    nextCursor: input.rawPage.nextCursor ?? null,
    backwardsCursor: input.rawPage.backwardsCursor ?? null,
    turns,
    bodies: Object.fromEntries(turns.map((turn) => [turn.turnId, turn])),
  })
}

export function normalizeCodexTurnBody(input: {
  threadId: string
  revision: number
  rawTurn: Record<string, unknown>
  model?: string
}) {
  return FreshAgentTurnBodySchema.parse({
    ...normalizeCodexTurn(input.rawTurn, 0, { model: input.model }),
    sessionType: 'freshcodex',
    provider: 'codex',
    threadId: input.threadId,
    revision: input.revision,
  })
}

export function normalizeCodexThreadSnapshot(input: {
  threadId: string
  revision: number
  status: string
  transcript: { turns: FreshAgentTurn[] }
  rawSnapshot: CodexRawSnapshot
}) {
  const extensions = input.rawSnapshot.extension?.codex ?? {}
  const isRunning = input.status === 'running' || input.status === 'compacting'
  return FreshAgentSnapshotSchema.parse({
    sessionType: 'freshcodex',
    provider: 'codex' as const,
    threadId: input.threadId,
    revision: input.revision,
    status: input.status,
    summary: input.rawSnapshot.summary ?? input.rawSnapshot.thread?.preview ?? input.transcript.turns[0]?.summary ?? '',
    capabilities: {
      send: !isRunning,
      interrupt: isRunning,
      approvals: false,
      questions: false,
      fork: !isRunning,
      worktrees: (input.rawSnapshot.worktrees?.length ?? 0) > 0,
      diffs: (input.rawSnapshot.diffs?.length ?? 0) > 0,
      childThreads: (input.rawSnapshot.childThreads?.length ?? 0) > 0,
    },
    tokenUsage: input.rawSnapshot.tokenUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    },
    worktrees: input.rawSnapshot.worktrees ?? [],
    diffs: input.rawSnapshot.diffs ?? [],
    childThreads: input.rawSnapshot.childThreads ?? [],
    turns: input.transcript.turns,
    extensions: {
      codex: extensions,
    },
  })
}
