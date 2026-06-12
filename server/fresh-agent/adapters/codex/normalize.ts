import { createHmac } from 'node:crypto'

import {
  CodexThreadItemTypeSchema,
} from '../../../coding-cli/codex-app-server/protocol.js'
import {
  FreshAgentSnapshotSchema,
  FreshAgentTurnBodySchema,
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

type CodexDisplayRole = NonNullable<FreshAgentTurn['role']>
type CodexDisplaySyntheticKind = 'empty-response' | 'error' | 'submitted-input'
type CodexThreadItemVariant = (typeof CodexThreadItemTypeSchema.options)[number]

const CODEX_DISPLAY_ID_PREFIX = 'codex-display:v1:'
const CODEX_DISPLAY_HANDLE_LENGTH = 22

export class CodexDisplayProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexDisplayProtocolError'
  }
}

export class CodexDisplayConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexDisplayConfigError'
  }
}

export class CodexDisplayTurnNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexDisplayTurnNotFoundError'
  }
}

export type CodexDisplayIdentity = {
  secret: string
  threadId: string
  providerTurnId: string
  role: CodexDisplayRole
  itemIds?: string[]
  partIndexes?: number[]
  syntheticKind?: CodexDisplaySyntheticKind
  requestId?: string | number
}

export type CodexDisplayRow = {
  turnId: string
  role: CodexDisplayRole
  providerTurnId: string
  itemIds: string[]
  partIndexes: number[]
  items: FreshAgentTranscriptItem[]
  syntheticKind?: CodexDisplaySyntheticKind
  requestId?: string | number
}

type NormalizeCodexDisplayTurnsOptions = {
  model?: string
  secret?: string
  threadId?: string
  submittedRequestIdByProviderTurnId?: ReadonlyMap<string, string | number>
}

type CodexNormalizedContribution = {
  role: CodexDisplayRole
  itemId: string
  partIndex: number
  item: FreshAgentTranscriptItem
}

type CodexPendingRow = {
  role: CodexDisplayRole
  itemIds: string[]
  partIndexes: number[]
  items: FreshAgentTranscriptItem[]
  syntheticKind?: CodexDisplaySyntheticKind
}

function normalizeCommandStatus(status: unknown): 'running' | 'completed' | 'failed' | 'declined' {
  return status === 'inProgress'
    ? 'running'
    : status === 'declined'
      ? 'declined'
      : status === 'failed'
        ? 'failed'
        : 'completed'
}

function normalizeToolStatus(status: unknown): 'running' | 'completed' | 'failed' {
  return status === 'inProgress'
    ? 'running'
    : status === 'failed'
      ? 'failed'
      : 'completed'
}

function assertNever(value: never): never {
  throw new CodexDisplayProtocolError(`Unsupported Codex thread item type: ${String(value)}`)
}

function readRequiredCodexDisplaySecret(secret: string | undefined): string {
  if (typeof secret === 'string' && secret.trim().length > 0) {
    return secret
  }
  throw new CodexDisplayConfigError('Codex display-turn normalization requires a non-empty adapter-supplied display-id secret.')
}

function readRequiredCodexThreadId(threadId: string | undefined): string {
  if (typeof threadId === 'string' && threadId.trim().length > 0) {
    return threadId
  }
  throw new CodexDisplayConfigError('Codex display-turn normalization requires a non-empty adapter-supplied threadId.')
}

function readCodexThreadItemType(item: Record<string, unknown>): CodexThreadItemVariant {
  const parsed = CodexThreadItemTypeSchema.safeParse(item.type)
  if (!parsed.success) {
    throw new CodexDisplayProtocolError(`Unsupported Codex thread item type: ${String(item.type)}`)
  }
  return parsed.data
}

function readCodexItemId(providerTurnId: string, item: Record<string, unknown>): string {
  if (typeof item.id === 'string' && item.id.length > 0) {
    return item.id
  }
  throw new CodexDisplayProtocolError(
    `Codex provider item in turn ${providerTurnId} is missing a stable item id.`,
  )
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  if (typeof value === 'string') {
    return [value]
  }
  return []
}

function summarizeFreshAgentItems(items: FreshAgentTranscriptItem[]): string {
  for (const item of items) {
    switch (item.kind) {
      case 'text':
      case 'thinking':
        return item.text.slice(0, 140)
      case 'reasoning':
        return (item.text ?? (item.summary.join('\n') || item.content.join('\n'))).slice(0, 140)
      case 'command':
        return item.command.slice(0, 140)
      case 'file_change':
        return 'File change'
      case 'mcp_tool':
        return `${item.server}:${item.tool}`.slice(0, 140)
      case 'dynamic_tool':
        return item.tool.slice(0, 140)
      case 'collab_agent':
        return item.tool.slice(0, 140)
      case 'web_search':
        return item.query.slice(0, 140)
      case 'image_view':
        return item.path.slice(0, 140)
      case 'image_generation':
        return item.result.slice(0, 140)
      case 'review_mode':
        return `${item.event} review mode`.slice(0, 140)
      case 'context_compaction':
        return 'Context compacted'
      case 'tool_use':
        return item.name.slice(0, 140)
      case 'tool_result':
        return item.isError ? 'Tool error' : 'Tool result'
      default: {
        const neverItem: never = item
        return String(neverItem)
      }
    }
  }
  return ''
}

function readUserMessageTextParts(item: Record<string, unknown>): Array<{ partIndex: number; text: string }> {
  const content = Array.isArray(item.content) ? item.content : []
  const contentParts = content.map((part, partIndex) => {
    const typedPart = part && typeof part === 'object' && !Array.isArray(part)
      ? part as Record<string, unknown>
      : {}
    if (typedPart.type === 'text' || typedPart.type === 'input_text') {
      return {
        partIndex,
        text: typeof typedPart.text === 'string' ? typedPart.text : '',
      }
    }
    return {
      partIndex,
      text: `[${String(typedPart.type ?? 'input')}]`,
    }
  })
  if (contentParts.length > 0) {
    return contentParts
  }
  if (typeof item.text === 'string') {
    return [{ partIndex: 0, text: item.text }]
  }
  if (typeof item.summary === 'string') {
    return [{ partIndex: 0, text: item.summary }]
  }
  return [{ partIndex: 0, text: '' }]
}

function normalizeCodexItem(
  providerTurnId: string,
  item: Record<string, unknown>,
): CodexNormalizedContribution[] {
  const type = readCodexThreadItemType(item)
  const itemId = readCodexItemId(providerTurnId, item)

  switch (type) {
    case 'userMessage':
      return readUserMessageTextParts(item).map(({ partIndex, text }) => ({
        role: 'user',
        itemId,
        partIndex,
        item: {
          id: `${itemId}:part:${partIndex}`,
          kind: 'text',
          text,
        },
      }))
    case 'agentMessage':
      return [{
        role: 'assistant',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'text',
          text: typeof item.text === 'string'
            ? item.text
            : typeof item.summary === 'string'
              ? item.summary
              : '',
        },
      }]
    case 'plan':
      return [{
        role: 'assistant',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'text',
          text: typeof item.text === 'string'
            ? item.text
            : typeof item.summary === 'string'
              ? item.summary
              : '',
        },
      }]
    case 'reasoning': {
      const summary = stringArray(item.summary)
      const content = stringArray(item.content)
      return [{
        role: 'assistant',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'reasoning',
          summary,
          content,
          text: summary.join('\n') || content.join('\n'),
        },
      }]
    }
    case 'commandExecution':
      return [{
        role: 'tool',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'command',
          command: typeof item.command === 'string' ? item.command : '',
          cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
          status: normalizeCommandStatus(item.status),
          output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
          exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
          extensions: { codex: item },
        },
      }]
    case 'fileChange':
      return [{
        role: 'tool',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'file_change',
          status: normalizeCommandStatus(item.status),
          changes: Array.isArray(item.changes)
            ? item.changes.filter((change): change is Record<string, unknown> => !!change && typeof change === 'object' && !Array.isArray(change))
            : [],
          extensions: { codex: item },
        },
      }]
    case 'mcpToolCall':
      return [{
        role: 'tool',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'mcp_tool',
          server: typeof item.server === 'string' ? item.server : '',
          tool: typeof item.tool === 'string' ? item.tool : '',
          status: normalizeToolStatus(item.status),
          arguments: item.arguments ?? null,
          result: item.result,
          error: item.error,
        },
      }]
    case 'dynamicToolCall':
      return [{
        role: 'tool',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'dynamic_tool',
          namespace: typeof item.namespace === 'string' ? item.namespace : null,
          tool: typeof item.tool === 'string' ? item.tool : '',
          status: normalizeToolStatus(item.status),
          arguments: item.arguments ?? null,
          contentItems: Array.isArray(item.contentItems) ? item.contentItems : null,
          success: typeof item.success === 'boolean' ? item.success : null,
        },
      }]
    case 'collabAgentToolCall':
      return [{
        role: 'tool',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'collab_agent',
          tool: String(item.tool ?? ''),
          status: normalizeToolStatus(item.status),
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
        },
      }]
    case 'webSearch':
      return [{
        role: 'tool',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'web_search',
          query: typeof item.query === 'string' ? item.query : '',
          action: item.action ?? null,
        },
      }]
    case 'imageView':
      return [{
        role: 'tool',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'image_view',
          path: typeof item.path === 'string' ? item.path : '',
        },
      }]
    case 'imageGeneration':
      return [{
        role: 'tool',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'image_generation',
          status: String(item.status ?? ''),
          revisedPrompt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt : null,
          result: String(item.result ?? ''),
          savedPath: typeof item.savedPath === 'string' ? item.savedPath : undefined,
        },
      }]
    case 'enteredReviewMode':
      return [{
        role: 'system',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'review_mode',
          event: 'entered',
          review: String(item.review ?? ''),
        },
      }]
    case 'exitedReviewMode':
      return [{
        role: 'system',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'review_mode',
          event: 'exited',
          review: String(item.review ?? ''),
        },
      }]
    case 'contextCompaction':
      return [{
        role: 'system',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'context_compaction',
        },
      }]
    case 'hookPrompt':
      return [{
        role: 'system',
        itemId,
        partIndex: 0,
        item: {
          id: itemId,
          kind: 'text',
          text: typeof item.text === 'string' ? item.text : 'Hook prompt',
        },
      }]
    default:
      return assertNever(type)
  }
}

export function classifyCodexItemRole(item: Record<string, unknown>): CodexDisplayRole {
  const type = readCodexThreadItemType(item)
  switch (type) {
    case 'userMessage':
      return 'user'
    case 'agentMessage':
    case 'plan':
    case 'reasoning':
      return 'assistant'
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'webSearch':
    case 'imageView':
    case 'imageGeneration':
      return 'tool'
    case 'hookPrompt':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'contextCompaction':
      return 'system'
    default:
      return assertNever(type)
  }
}

function readCodexRawItems(rawTurn: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(rawTurn.items)
    ? rawTurn.items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : []
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

function createSyntheticPendingRow(kind: Exclude<CodexDisplaySyntheticKind, 'submitted-input'>, text: string): CodexPendingRow {
  return {
    role: 'assistant',
    itemIds: [],
    partIndexes: [],
    items: [{
      id: `codex-display-synthetic:${kind}`,
      kind: 'text',
      text,
    }],
    syntheticKind: kind,
  }
}

function buildDisplayTurn(input: {
  providerTurnId: string
  ordinal: number
  model?: string
  threadId: string
  secret: string
  row: CodexPendingRow
  submittedRequestId?: string | number
}): FreshAgentTurn & { requestId?: string | number; syntheticKind?: CodexDisplaySyntheticKind } {
  const { row } = input
  const requestId = input.submittedRequestId
  const syntheticKind = requestId !== undefined && row.role === 'user'
    ? 'submitted-input'
    : row.syntheticKind
  const turnId = createCodexDisplayId({
    secret: input.secret,
    threadId: input.threadId,
    providerTurnId: input.providerTurnId,
    role: row.role,
    itemIds: requestId !== undefined && row.role === 'user' ? undefined : row.itemIds,
    partIndexes: requestId !== undefined && row.role === 'user' ? undefined : row.partIndexes,
    syntheticKind,
    ...(requestId !== undefined ? { requestId } : {}),
  })

  return {
    id: turnId,
    turnId,
    ordinal: input.ordinal,
    source: 'durable',
    role: row.role,
    ...(input.model ? { model: input.model } : {}),
    summary: summarizeFreshAgentItems(row.items),
    items: row.items,
    ...(syntheticKind ? { syntheticKind } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  }
}

export function createCodexDisplayId(identity: CodexDisplayIdentity): string {
  const payload = JSON.stringify({
    threadId: identity.threadId,
    providerTurnId: identity.providerTurnId,
    role: identity.role,
    parts: (identity.itemIds ?? []).map((itemId, index) => ({
      itemId,
      partIndex: identity.partIndexes?.[index] ?? 0,
    })),
    syntheticKind: identity.syntheticKind ?? null,
    requestId: identity.requestId ?? null,
  })
  const handle = createHmac('sha256', identity.secret)
    .update(payload)
    .digest()
    .subarray(0, 16)
    .toString('base64url')

  return `${CODEX_DISPLAY_ID_PREFIX}${handle}`
}

export function parseCodexDisplayIdHandle(turnId: string): { handle: string } | null {
  const match = turnId.match(new RegExp(`^${CODEX_DISPLAY_ID_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([A-Za-z0-9_-]{${CODEX_DISPLAY_HANDLE_LENGTH}})$`))
  return match ? { handle: match[1] } : null
}

export function normalizeCodexDisplayTurns(
  rawTurn: Record<string, unknown>,
  ordinal = 0,
  options: NormalizeCodexDisplayTurnsOptions = {},
): { turns: FreshAgentTurn[]; displayRows: CodexDisplayRow[] } {
  const providerTurnId = String(rawTurn.id ?? `turn:${ordinal}`)
  const threadId = readRequiredCodexThreadId(options.threadId)
  const secret = readRequiredCodexDisplaySecret(options.secret)
  const model = typeof rawTurn.model === 'string' && rawTurn.model.length > 0
    ? rawTurn.model
    : options.model
  const rawItems = Array.isArray(rawTurn.items)
    ? rawTurn.items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : []

  const pendingRows: CodexPendingRow[] = []
  for (const rawItem of rawItems) {
    const role = classifyCodexItemRole(rawItem)
    const normalizedItems = normalizeCodexItem(providerTurnId, rawItem)
    const currentRow = pendingRows.at(-1)
    if (!currentRow || currentRow.role !== role || currentRow.syntheticKind) {
      pendingRows.push({
        role,
        itemIds: normalizedItems.map((item) => item.itemId),
        partIndexes: normalizedItems.map((item) => item.partIndex),
        items: normalizedItems.map((item) => item.item),
      })
      continue
    }
    currentRow.itemIds.push(...normalizedItems.map((item) => item.itemId))
    currentRow.partIndexes.push(...normalizedItems.map((item) => item.partIndex))
    currentRow.items.push(...normalizedItems.map((item) => item.item))
  }

  const hasAssistantOutput = rawItems.some((item) => {
    const role = classifyCodexItemRole(item)
    return role === 'assistant'
  })
  const hasUserOutput = rawItems.some((item) => classifyCodexItemRole(item) === 'user')
  const turnError = readCodexTurnError(rawTurn)
  if (turnError) {
    pendingRows.push(createSyntheticPendingRow('error', `Codex turn failed: ${turnError}`))
  } else if (
    rawTurn.status === 'completed'
    && hasUserOutput
    && rawItems.every((item) => classifyCodexItemRole(item) === 'user')
    && !hasAssistantOutput
  ) {
    pendingRows.push(createSyntheticPendingRow(
      'empty-response',
      'Codex completed this turn without recording an assistant response.',
    ))
  }

  const submittedRequestId = options.submittedRequestIdByProviderTurnId?.get(providerTurnId)
  let submittedAliasConsumed = false
  const turns = pendingRows.map((row, rowIndex) => {
    const useSubmittedAlias = submittedRequestId !== undefined && !submittedAliasConsumed && row.role === 'user'
    if (useSubmittedAlias) {
      submittedAliasConsumed = true
    }
    return buildDisplayTurn({
      providerTurnId,
      ordinal: ordinal + rowIndex,
      model,
      threadId,
      secret,
      row,
      ...(useSubmittedAlias ? { submittedRequestId } : {}),
    })
  })

  const displayRows = turns.map((turn, index) => ({
    turnId: turn.turnId,
    role: turn.role ?? 'assistant',
    providerTurnId,
    itemIds: pendingRows[index]?.itemIds ?? [],
    partIndexes: pendingRows[index]?.partIndexes ?? [],
    items: turn.items,
    ...(typeof turn.syntheticKind === 'string' ? { syntheticKind: turn.syntheticKind } : {}),
    ...(turn.requestId !== undefined ? { requestId: turn.requestId } : {}),
  }))

  return { turns, displayRows }
}

export function normalizeCodexTurn(
  rawTurn: Record<string, unknown>,
  ordinal = 0,
  options: NormalizeCodexDisplayTurnsOptions = {},
): FreshAgentTurn {
  const normalized = normalizeCodexDisplayTurns(rawTurn, ordinal, options).turns[0]
  if (normalized) {
    const { syntheticKind: _syntheticKind, requestId: _requestId, ...turn } = normalized as FreshAgentTurn & {
      syntheticKind?: CodexDisplaySyntheticKind
      requestId?: string | number
    }
    return turn
  }
  const providerTurnId = String(rawTurn.id ?? `turn:${ordinal}`)
  const model = typeof rawTurn.model === 'string' && rawTurn.model.length > 0
    ? rawTurn.model
    : options.model
  return {
    id: providerTurnId,
    turnId: providerTurnId,
    ordinal,
    source: 'durable',
    ...(model ? { model } : {}),
    summary: '',
    items: [],
  }
}

export function normalizeCodexTurnBody(input: {
  threadId: string
  revision: number
  requestedTurnId: string
  rawTurn: Record<string, unknown>
  model?: string
  secret?: string
  submittedRequestIdByProviderTurnId?: ReadonlyMap<string, string | number>
}) {
  const { turns } = normalizeCodexDisplayTurns(input.rawTurn, 0, {
    threadId: input.threadId,
    model: input.model,
    secret: input.secret,
    submittedRequestIdByProviderTurnId: input.submittedRequestIdByProviderTurnId,
  })
  const selectedTurn = turns.find((turn) => turn.turnId === input.requestedTurnId)
  if (!selectedTurn) {
    throw new CodexDisplayTurnNotFoundError(
      `Codex display turn ${input.requestedTurnId} was not found in provider turn ${String(input.rawTurn.id ?? 'unknown')}.`,
    )
  }
  const { syntheticKind: _syntheticKind, requestId: _requestId, ...turn } = selectedTurn as FreshAgentTurn & {
    syntheticKind?: CodexDisplaySyntheticKind
    requestId?: string | number
  }
  return FreshAgentTurnBodySchema.parse({
    ...turn,
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
