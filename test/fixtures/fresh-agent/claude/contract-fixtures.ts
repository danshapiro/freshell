import type { FreshAgentSnapshot, FreshAgentTurnBody, FreshAgentTurnPage } from '../../../../shared/fresh-agent-contract.js'

export const claudeContractTurn = {
  id: 'turn:live-1',
  turnId: 'turn:live-1',
  messageId: 'live-1',
  ordinal: 0,
  source: 'live',
  role: 'assistant',
  timestamp: '2026-04-18T12:00:00.000Z',
  model: 'claude-fixture',
  summary: 'Workspace is clean.',
  items: [
    { id: 'turn:live-1:item:0', kind: 'thinking', text: 'Inspecting workspace' },
    { id: 'turn:live-1:item:1', kind: 'tool_use', toolUseId: 'tool-1', name: 'Bash', input: { command: 'git status --short' } },
    { id: 'turn:live-1:item:2', kind: 'tool_result', toolUseId: 'tool-1', content: 'clean', isError: false },
    { id: 'turn:live-1:item:3', kind: 'text', text: 'Workspace is clean.' },
  ],
} satisfies FreshAgentSnapshot['turns'][number]

export const claudeContractSnapshot = {
  sessionType: 'freshclaude',
  provider: 'claude',
  threadId: 'sdk-claude-1',
  sessionId: 'sdk-claude-1',
  revision: 5,
  latestTurnId: 'turn:live-1',
  status: 'running',
  summary: 'Workspace is clean.',
  capabilities: {
    send: true,
    interrupt: true,
    approvals: true,
    questions: true,
    fork: false,
  },
  settings: {
    model: 'claude-fixture',
    permissionMode: 'plan',
    plugins: ['/tmp/plugin-a'],
  },
  tokenUsage: {
    inputTokens: 12,
    outputTokens: 34,
    totalTokens: 46,
    costUsd: 1.25,
  },
  pendingApprovals: [{
    requestId: 'approval-1',
    toolName: 'Bash',
    input: { command: 'git push' },
  }],
  pendingQuestions: [],
  worktrees: [],
  diffs: [],
  childThreads: [],
  turns: [claudeContractTurn],
  extensions: {
    claude: {
      timelineSessionId: '00000000-0000-4000-8000-000000000111',
      liveSessionId: 'sdk-claude-1',
    },
  },
} satisfies FreshAgentSnapshot

export const claudeContractTurnPage = {
  sessionType: 'freshclaude',
  provider: 'claude',
  threadId: 'sdk-claude-1',
  revision: 5,
  nextCursor: null,
  turns: [claudeContractTurn],
} satisfies FreshAgentTurnPage

export const claudeContractTurnBody = {
  ...claudeContractTurn,
  sessionType: 'freshclaude',
  provider: 'claude',
  threadId: 'sdk-claude-1',
  revision: 5,
} satisfies FreshAgentTurnBody
