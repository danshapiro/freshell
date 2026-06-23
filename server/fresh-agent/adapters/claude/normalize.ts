import type { ClaudeFreshAgentHistoryRestoreResolution } from '../../history/claude/history-ledger.js'
import type {
  ClaudeFreshAgentHistoryPage,
  ClaudeFreshAgentHistoryTurn,
} from '../../history/claude/history-types.js'
import type { QuestionDefinition, SdkSessionState } from '../../../sdk-bridge-types.js'
import type { SdkSessionStatus } from '../../../sdk-bridge-types.js'
import type { ContentBlock } from '../../../../shared/ws-protocol.js'
import { extractUserAuthoredText, isSystemContext } from '../../../coding-cli/utils.js'
import {
  FreshAgentSnapshotSchema,
  FreshAgentTurnBodySchema,
  FreshAgentTurnPageSchema,
} from '../../../../shared/fresh-agent-contract.js'

export type FreshAgentNormalizedItem =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool_use'; toolUseId: string; name: string; input?: Record<string, unknown> }
  | { id: string; kind: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }

export type FreshAgentNormalizedTurn = {
  id: string
  turnId: string
  messageId: string
  ordinal: number
  source: 'durable' | 'live'
  role: 'user' | 'assistant'
  timestamp?: string
  model?: string
  summary: string
  items: FreshAgentNormalizedItem[]
}

export type FreshAgentPendingApproval = {
  requestId: string
  toolName: string
  toolUseID?: string
  blockedPath?: string
  decisionReason?: string
  input?: Record<string, unknown>
}

export type FreshAgentPendingQuestion = {
  requestId: string
  questions: QuestionDefinition[]
}

export type FreshAgentClaudeSnapshot = {
  provider: 'claude'
  threadId: string
  sessionId: string
  revision: number
  latestTurnId: string | null
  status: SdkSessionStatus
  capabilities: {
    send: boolean
    interrupt: boolean
    approvals: boolean
    questions: boolean
    fork: boolean
  }
  settings: {
    model?: string
    permissionMode?: string
    plugins: string[]
  }
  tokenUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
  }
  pendingApprovals: FreshAgentPendingApproval[]
  pendingQuestions: FreshAgentPendingQuestion[]
  turns: FreshAgentNormalizedTurn[]
  extensions: {
    claude: {
      historySessionId?: string
      liveSessionId?: string
      cliSessionId?: string
      readiness?: ClaudeFreshAgentHistoryRestoreResolution extends infer T ? T extends { kind: 'resolved'; readiness: infer R } ? R : never : never
    }
  }
}

export type FreshAgentClaudeTurnPage = {
  threadId: string
  revision: number
  nextCursor: string | null
  turns: FreshAgentNormalizedTurn[]
  bodies?: Record<string, FreshAgentNormalizedTurn>
}

function blockSummary(blocks: ContentBlock[]): string {
  const textBlock = blocks.find((block) => block.type === 'text' && block.text.trim().length > 0)
  if (textBlock?.type === 'text') {
    return textBlock.text.trim().slice(0, 140)
  }
  const thinkingBlock = blocks.find((block) => block.type === 'thinking' && block.thinking.trim().length > 0)
  if (thinkingBlock?.type === 'thinking') {
    return thinkingBlock.thinking.trim().slice(0, 140)
  }
  const toolBlock = blocks.find((block) => block.type === 'tool_use')
  if (toolBlock?.type === 'tool_use') {
    return toolBlock.name.slice(0, 140)
  }
  return ''
}

function itemSummary(items: FreshAgentNormalizedItem[]): string {
  const textItem = items.find((item): item is Extract<FreshAgentNormalizedItem, { kind: 'text' }> => (
    item.kind === 'text' && item.text.trim().length > 0
  ))
  if (textItem) return textItem.text.trim().slice(0, 140)

  const thinkingItem = items.find((item): item is Extract<FreshAgentNormalizedItem, { kind: 'thinking' }> => (
    item.kind === 'thinking' && item.text.trim().length > 0
  ))
  if (thinkingItem) return thinkingItem.text.trim().slice(0, 140)

  const toolItem = items.find((item): item is Extract<FreshAgentNormalizedItem, { kind: 'tool_use' }> => (
    item.kind === 'tool_use'
  ))
  if (toolItem) return toolItem.name.slice(0, 140)

  return ''
}

function normalizeClaudeItem(
  role: FreshAgentNormalizedTurn['role'],
  turnId: string,
  block: ContentBlock,
  index: number,
): FreshAgentNormalizedItem | null {
  const id = `${turnId}:item:${index}`
  switch (block.type) {
    case 'text': {
      const text = role === 'user' ? extractUserAuthoredText(block.text) : block.text
      return text ? { id, kind: 'text', text } : null
    }
    case 'thinking':
      return { id, kind: 'thinking', text: block.thinking }
    case 'tool_use':
      return { id, kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return {
        id,
        kind: 'tool_result',
        toolUseId: block.tool_use_id,
        content: block.content,
        isError: Boolean(block.is_error),
      }
  }
}

export function normalizeClaudeTurn(
  input: Pick<ClaudeFreshAgentHistoryTurn, 'turnId' | 'messageId' | 'ordinal' | 'source' | 'message'>,
): FreshAgentNormalizedTurn | null {
  const items = input.message.content
    .map((block, index) => normalizeClaudeItem(input.message.role, input.turnId, block, index))
    .filter((item): item is FreshAgentNormalizedItem => item !== null)

  if (input.message.role === 'user' && items.length === 0) {
    return null
  }

  return {
    id: input.turnId,
    turnId: input.turnId,
    messageId: input.messageId,
    ordinal: input.ordinal,
    source: input.source,
    role: input.message.role,
    ...(input.message.timestamp ? { timestamp: input.message.timestamp } : {}),
    ...(input.message.model ? { model: input.message.model } : {}),
    summary: itemSummary(items) || blockSummary(input.message.content),
    items,
  }
}

function isSyntheticUserTimelineItem(item: Pick<ClaudeFreshAgentHistoryPage['items'][number], 'role' | 'summary'>): boolean {
  return item.role === 'user' && isSystemContext(item.summary)
}

function normalizePendingApprovals(liveSession?: SdkSessionState): FreshAgentPendingApproval[] {
  if (!liveSession) return []
  return Array.from(liveSession.pendingPermissions.entries()).map(([requestId, approval]) => ({
    requestId,
    toolName: approval.toolName,
    toolUseID: approval.toolUseID,
    blockedPath: approval.blockedPath,
    decisionReason: approval.decisionReason,
    input: approval.input,
  }))
}

function normalizePendingQuestions(liveSession?: SdkSessionState): FreshAgentPendingQuestion[] {
  if (!liveSession) return []
  return Array.from(liveSession.pendingQuestions.entries()).map(([requestId, question]) => ({
    requestId,
    questions: question.questions,
  }))
}

export function normalizeClaudeThreadSnapshot(input: {
  threadId: string
  resolved: Extract<ClaudeFreshAgentHistoryRestoreResolution, { kind: 'resolved' }>
  liveSession?: SdkSessionState
  status: SdkSessionStatus
}): FreshAgentClaudeSnapshot {
  const sessionId = input.liveSession?.sessionId ?? input.resolved.liveSessionId ?? input.threadId
  const turns = input.resolved.turns
    .map((turn) => normalizeClaudeTurn(turn))
    .filter((turn): turn is FreshAgentNormalizedTurn => turn !== null)
  const inputTokens = input.liveSession?.totalInputTokens ?? 0
  const outputTokens = input.liveSession?.totalOutputTokens ?? 0
  return FreshAgentSnapshotSchema.parse({
    sessionType: 'freshclaude',
    provider: 'claude',
    threadId: input.threadId,
    sessionId,
    revision: input.resolved.revision,
    latestTurnId: turns.at(-1)?.turnId ?? null,
    status: input.status,
    capabilities: {
      send: true,
      interrupt: input.status !== 'exited',
      approvals: normalizePendingApprovals(input.liveSession).length > 0,
      questions: normalizePendingQuestions(input.liveSession).length > 0,
      fork: false,
    },
    settings: {
      ...(input.liveSession?.model ? { model: input.liveSession.model } : {}),
      ...(input.liveSession?.permissionMode ? { permissionMode: input.liveSession.permissionMode } : {}),
      plugins: input.liveSession?.plugins ? [...input.liveSession.plugins] : [],
    },
    tokenUsage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: input.liveSession?.costUsd ?? 0,
    },
    pendingApprovals: normalizePendingApprovals(input.liveSession),
    pendingQuestions: normalizePendingQuestions(input.liveSession),
    turns,
    extensions: {
      claude: {
        historySessionId: input.resolved.timelineSessionId,
        liveSessionId: input.resolved.liveSessionId,
        cliSessionId: input.liveSession?.cliSessionId,
        readiness: input.resolved.readiness,
      },
    },
  }) as FreshAgentClaudeSnapshot
}

export function normalizeClaudeTurnPage(input: {
  threadId: string
  page: ClaudeFreshAgentHistoryPage
}): FreshAgentClaudeTurnPage {
  const items = input.page.items.filter((item) => !isSyntheticUserTimelineItem(item))
  const bodies = input.page.bodies
    ? Object.fromEntries(
        Object.entries(input.page.bodies)
          .map(([turnId, turn]) => [turnId, normalizeClaudeTurn(turn)] as const)
          .filter((entry): entry is readonly [string, FreshAgentNormalizedTurn] => entry[1] !== null),
      )
    : undefined

  return FreshAgentTurnPageSchema.parse({
    sessionType: 'freshclaude',
    provider: 'claude',
    threadId: input.threadId,
    revision: input.page.revision,
    nextCursor: input.page.nextCursor,
    turns: items.map((item) => ({
      id: item.turnId,
      turnId: item.turnId,
      messageId: item.messageId,
      ordinal: item.ordinal,
      source: item.source,
      role: item.role,
      ...(item.timestamp ? { timestamp: item.timestamp } : {}),
      summary: item.summary,
      items: [],
    })),
    ...(bodies ? { bodies } : {}),
  }) as FreshAgentClaudeTurnPage
}

export function normalizeClaudeTurnBody(input: {
  turn: ClaudeFreshAgentHistoryTurn
  revision: number
  threadId: string
}) {
  const turn = normalizeClaudeTurn(input.turn)
  if (!turn) return null
  return FreshAgentTurnBodySchema.parse({
    ...turn,
    sessionType: 'freshclaude',
    provider: 'claude',
    threadId: input.threadId,
    revision: input.revision,
  })
}
