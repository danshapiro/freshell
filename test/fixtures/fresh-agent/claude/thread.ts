import type { RestoreResolution } from '../../../../../server/fresh-agent/history/claude/history-ledger.js'
import type { SdkSessionState } from '../../../../../server/sdk-bridge-types.js'
import type { ChatMessage } from '../../../../../server/session-history-loader.js'

function makeMessage(
  role: 'user' | 'assistant',
  content: ChatMessage['content'],
  options: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    role,
    content,
    timestamp: '2026-04-18T12:00:00.000Z',
    ...options,
  }
}

export function makeClaudeLiveSession(overrides: Partial<SdkSessionState> = {}): SdkSessionState {
  return {
    sessionId: 'sdk-claude-1',
    cliSessionId: '00000000-0000-4000-8000-000000000111',
    resumeSessionId: 'resume-claude-1',
    cwd: '/repo',
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'plan',
    plugins: ['/tmp/plugin-a', '/tmp/plugin-b'],
    status: 'running',
    createdAt: 1,
    messages: [
      makeMessage(
        'assistant',
        [
          { type: 'thinking', thinking: 'Inspecting workspace' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status --short' } },
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'clean', is_error: false },
          { type: 'text', text: 'Workspace is clean.' },
        ],
        { messageId: 'live-2' },
      ),
    ],
    streamingActive: false,
    streamingText: '',
    pendingPermissions: new Map([
      ['approval-1', {
        toolName: 'Bash',
        input: { command: 'git push' },
        toolUseID: 'tool-approve-1',
        blockedPath: '/repo',
        decisionReason: 'Needs approval',
        resolve: () => ({ behavior: 'allow' }),
      }],
    ]),
    pendingQuestions: new Map([
      ['question-1', {
        originalInput: { questions: [] },
        questions: [{
          question: 'Proceed?',
          header: 'Approval',
          options: [{ label: 'Yes', description: 'Continue the run' }],
          multiSelect: false,
        }],
        resolve: () => ({ behavior: 'allow' }),
      }],
    ]),
    costUsd: 1.25,
    totalInputTokens: 12,
    totalOutputTokens: 34,
    ...overrides,
  }
}

export function makeClaudeRestoreResolution(): Extract<RestoreResolution, { kind: 'resolved' }> {
  return {
    kind: 'resolved',
    queryId: 'sdk-claude-1',
    liveSessionId: 'sdk-claude-1',
    timelineSessionId: '00000000-0000-4000-8000-000000000111',
    readiness: 'merged',
    revision: 5,
    latestTurnId: 'turn:live-2',
    turns: [
      {
        turnId: 'turn:durable-1',
        messageId: 'durable-1',
        ordinal: 0,
        source: 'durable',
        message: makeMessage(
          'user',
          [{ type: 'text', text: 'Summarize the repo state' }],
          { messageId: 'durable-1' },
        ),
      },
      {
        turnId: 'turn:live-2',
        messageId: 'live-2',
        ordinal: 1,
        source: 'live',
        message: makeClaudeLiveSession().messages[0]!,
      },
    ],
  }
}
