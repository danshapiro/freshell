import type { FreshAgentSnapshot, FreshAgentTurnBody, FreshAgentTurnPage } from '../../../../shared/fresh-agent-contract.js'

export const codexContractTurn = {
  id: 'turn-1',
  turnId: 'turn-1',
  messageId: 'msg-1',
  ordinal: 0,
  source: 'durable',
  role: 'assistant',
  summary: 'Codex finished a review pass',
  items: [
    { id: 'turn-1:item-0', kind: 'text', text: 'Codex finished a review pass.' },
    {
      id: 'turn-1:item-1',
      kind: 'reasoning',
      summary: ['Reviewed changed files'],
      content: ['Inspected the diff and checked the tests.'],
      text: 'Reviewed changed files',
    },
  ],
} satisfies FreshAgentSnapshot['turns'][number]

export const codexContractSnapshot = {
  sessionType: 'freshcodex',
  provider: 'codex',
  threadId: 'thread-codex-1',
  revision: 7,
  status: 'idle',
  summary: 'Codex finished a review pass',
  capabilities: {
    send: true,
    interrupt: true,
    approvals: true,
    questions: true,
    fork: true,
    worktrees: true,
    diffs: true,
    childThreads: true,
  },
  tokenUsage: {
    inputTokens: 10,
    outputTokens: 6,
    cachedTokens: 2,
    totalTokens: 18,
    contextTokens: 18,
    compactPercent: 4,
  },
  pendingApprovals: [{
    requestId: 17,
    toolName: 'shell',
    input: { command: 'git diff' },
  }],
  pendingQuestions: [{
    requestId: 'question-1',
    questions: [{
      question: 'Proceed?',
      header: 'Approval',
      options: [{ label: 'Yes', description: 'Continue' }],
      multiSelect: false,
    }],
  }],
  worktrees: [{ id: 'wt-1', path: '/repo/.worktrees/task-1', branch: 'feature/task-1' }],
  diffs: [{ id: 'diff-1', path: 'src/app.ts', title: 'src/app.ts' }],
  childThreads: [{ id: 'child-1', threadId: 'thread-child-1', origin: 'subagent', title: 'Review shell' }],
  turns: [codexContractTurn],
  extensions: {
    codex: {
      review: { id: 'review-1', status: 'pending' },
      fork: { parentThreadId: 'thread-parent-1' },
      sourceVersion: '0.129.0',
    },
  },
} satisfies FreshAgentSnapshot

export const codexContractTurnPage = {
  sessionType: 'freshcodex',
  provider: 'codex',
  threadId: 'thread-codex-1',
  revision: 7,
  nextCursor: null,
  backwardsCursor: null,
  turns: [codexContractTurn],
  bodies: {
    'turn-1': codexContractTurn,
  },
} satisfies FreshAgentTurnPage

export const codexContractTurnBody = {
  ...codexContractTurn,
  sessionType: 'freshcodex',
  provider: 'codex',
  threadId: 'thread-codex-1',
  revision: 7,
} satisfies FreshAgentTurnBody
