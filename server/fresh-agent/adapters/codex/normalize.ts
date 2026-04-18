type CodexTranscriptTurn = {
  id: string
  turnId: string
  messageId: string
  ordinal: number
  source: 'durable' | 'live'
  role: 'user' | 'assistant'
  summary: string
  timestamp?: string
  items: Array<Record<string, unknown>>
}

type CodexRawSnapshot = {
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

export function normalizeCodexThreadSnapshot(input: {
  threadId: string
  revision: number
  status: string
  transcript: { turns: CodexTranscriptTurn[] }
  rawSnapshot: CodexRawSnapshot
}) {
  const extensions = input.rawSnapshot.extension?.codex ?? {}
  return {
    provider: 'codex' as const,
    threadId: input.threadId,
    revision: input.revision,
    status: input.status,
    summary: input.rawSnapshot.summary ?? input.transcript.turns[0]?.summary ?? '',
    capabilities: {
      send: true,
      interrupt: true,
      approvals: false,
      questions: false,
      fork: Boolean((extensions as { fork?: unknown }).fork),
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
  }
}
