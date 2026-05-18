export const codexRichSnapshotFixture = {
  provider: 'codex',
  threadId: 'thread-codex-1',
  status: 'idle',
  revision: 7,
  summary: 'Implement the fresh-agent shell',
  tokenUsage: {
    inputTokens: 120,
    outputTokens: 45,
    cachedTokens: 12,
    totalTokens: 177,
    contextTokens: 177,
    compactPercent: 18,
  },
  worktrees: [
    {
      id: 'wt-1',
      path: '/repo/.worktrees/fresh-agent-platform',
      branch: 'feature/fresh-agent-platform',
    },
  ],
  diffs: [
    {
      id: 'diff-1',
      path: 'src/components/fresh-agent/FreshAgentView.tsx',
      title: 'FreshAgentView.tsx',
    },
  ],
  childThreads: [
    {
      id: 'child-1',
      threadId: 'thread-codex-child-1',
      origin: 'subagent',
      title: 'Review shell states',
    },
  ],
  extension: {
    codex: {
      review: {
        id: 'review-1',
        status: 'pending',
      },
      fork: {
        parentThreadId: 'thread-parent-1',
      },
    },
  },
  turns: [
    {
      id: 'turn-1',
      turnId: 'turn-1',
      messageId: 'msg-1',
      ordinal: 0,
      source: 'durable',
      role: 'user',
      summary: 'Implement the fresh-agent shell',
      items: [
        { id: 'turn-1:item-0', kind: 'text', text: 'Implement the fresh-agent shell' },
      ],
    },
    {
      id: 'turn-2',
      turnId: 'turn-2',
      messageId: 'msg-2',
      ordinal: 1,
      source: 'live',
      role: 'assistant',
      summary: 'Created worktree and queued review',
      items: [
        { id: 'turn-2:item-0', kind: 'text', text: 'Created worktree and queued review.' },
      ],
    },
  ],
} as const
