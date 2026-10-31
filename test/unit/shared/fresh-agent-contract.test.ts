import { FreshAgentClientMessageSchema } from '../../../shared/ws-protocol.js'
import { describe, expect, it } from 'vitest'

import {
  FRESH_AGENT_CONTRACT_SCHEMA_NAMES,
  FreshAgentActionResultSchema,
  FreshAgentCapabilitiesSchema,
  FreshAgentChildObservationSchema,
  FreshAgentContractErrorSchema,
  FreshAgentRequestIdSchema,
  FreshAgentSessionCommandSchema,
  FreshAgentSnapshotSchema,
  FreshAgentTranscriptItemSchema,
  FreshAgentTranscriptPatchSchema,
  FreshAgentTurnBodySchema,
  FreshAgentTurnPageSchema,
  FreshAgentTurnSchema,
} from '../../../shared/fresh-agent-contract.js'
import {
  claudeContractSnapshot,
  claudeContractTurnBody,
  claudeContractTurnPage,
} from '../../fixtures/fresh-agent/claude/contract-fixtures.js'
import {
  codexContractSnapshot,
  codexContractTurnBody,
  codexContractTurnPage,
} from '../../fixtures/fresh-agent/codex/contract-fixtures.js'

describe('fresh-agent shared contract schemas', () => {
  it('requires the exact child body only for readable observations and preserves finite unavailable states', () => {
    const identity = { parentThreadId: 'parent', childThreadId: codexContractSnapshot.threadId }
    const saved = FreshAgentChildObservationSchema.parse({ ...identity, status: 'saved', snapshot: codexContractSnapshot })
    expect(saved.status).toBe('saved')
    for (const reason of ['ephemeral_history_unavailable', 'history_unavailable', 'source_unavailable']) {
      const unavailable = { ...identity, status: 'unavailable', reason, retryable: reason === 'source_unavailable' }
      expect(FreshAgentChildObservationSchema.safeParse(unavailable).success).toBe(true)
      expect(FreshAgentChildObservationSchema.safeParse({ ...unavailable, snapshot: codexContractSnapshot }).success).toBe(false)
    }
    expect(FreshAgentChildObservationSchema.safeParse({ ...identity, status: 'pending', reason: 'history_unmaterialized', retryable: true }).success).toBe(true)
    expect(FreshAgentChildObservationSchema.safeParse({ ...identity, childThreadId: 'wrong', status: 'live', snapshot: codexContractSnapshot }).success).toBe(false)
  })
  it('validates native delta patches and rejects unsafe revisions or malformed operations', () => {
    const patch = { type: 'freshAgent.transcript.patch', sessionId: 'thread', projectionId: 'runtime', historyGeneration: 0, ops: [{ op: 'appendItem', nativeTurnId: 'turn', rowId: 'turn:row-1', itemId: 'answer', field: 'text', text: '🙂', revision: 1 }] }
    expect(FreshAgentTranscriptPatchSchema.parse(patch).ops[0]).toMatchObject({ text: '🙂', revision: 1 })
    expect(FreshAgentTranscriptPatchSchema.safeParse({ ...patch, ops: [{ ...patch.ops[0], revision: Number.MAX_SAFE_INTEGER + 1 }] }).success).toBe(false)
    expect(FreshAgentTranscriptPatchSchema.safeParse({ ...patch, ops: [{ ...patch.ops[0], field: 'credentials' }] }).success).toBe(false)
    expect(FreshAgentTranscriptPatchSchema.safeParse({ ...patch, ops: [{ ...patch.ops[0], op: 'replaceEverything' }] }).success).toBe(false)
  })

  it('preserves observed zero usage, native model limit, supplied diff and finite interrupted provenance', () => {
    const parsed = FreshAgentSnapshotSchema.parse({ ...codexContractSnapshot, tokenUsage: { observed: true, inputTokens: 0, outputTokens: 0, totalTokens: 0, modelContextWindow: 258400 }, diffs: [{ id: 'turn:t', title: 'Turn changes', diff: '+native' }], turns: [{ id: 't', turnId: 't', summary: '', items: [], outputState: { provenance: 'saved', diagnostic: 'interrupted', refreshPending: false } }] })
    expect(parsed.tokenUsage.observed).toBe(true)
    expect(parsed.tokenUsage.modelContextWindow).toBe(258400)
    expect(parsed.diffs[0].diff).toBe('+native')
    expect(parsed.turns[0].outputState?.diagnostic).toBe('interrupted')
  })
  it('parses Claude and Codex snapshots through one shared durable contract', () => {
    const claudeSnapshot = FreshAgentSnapshotSchema.parse(claudeContractSnapshot)
    expect(claudeSnapshot.sessionType).toBe('freshclaude')
    expect(claudeSnapshot.extensions.claude).toMatchObject({
      historySessionId: '00000000-0000-4000-8000-000000000111',
      liveSessionId: 'sdk-claude-1',
    })
    expect(claudeSnapshot.extensions.claude).not.toHaveProperty('timelineSessionId')
    expect(FreshAgentSnapshotSchema.parse(codexContractSnapshot).sessionType).toBe('freshcodex')
    expect(claudeSnapshot.turns[0].summaryKind).toBe('echo')
    expect(FreshAgentSnapshotSchema.parse(codexContractSnapshot).turns[0].summaryKind).toBe('echo')
  })

  it('a claude pending approval carries the CLI\'s permission suggestions, and one malformed suggestion fails the strict parse', () => {
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'replaceRules', rules: [{ toolName: 'Read' }], behavior: 'deny', destination: 'projectSettings' },
      { type: 'removeRules', rules: [{ toolName: 'Edit', ruleContent: 'src/**' }], behavior: 'ask', destination: 'userSettings' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'setMode', mode: 'dontAsk', destination: 'cliArg' },
      { type: 'addDirectories', directories: ['/srv/data'], destination: 'session' },
      { type: 'removeDirectories', directories: ['/srv/old'], destination: 'localSettings' },
    ]
    const withSuggestions = (list: unknown[]) => ({
      ...claudeContractSnapshot,
      pendingApprovals: [{ requestId: 'req-1', toolName: 'Bash', input: { command: 'npm test' }, suggestions: list }],
    })
    expect(FreshAgentSnapshotSchema.parse(withSuggestions(suggestions)).pendingApprovals[0].suggestions).toEqual(suggestions)
    for (const bad of [
      { type: 'grantEverything', destination: 'session' },
      { type: 'setMode', mode: 'yolo', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'everywhere' },
      { type: 'addRules', rules: [{ toolName: 'Bash', note: 'x' }], behavior: 'allow', destination: 'session' },
      { type: 'setMode', mode: 'plan', destination: 'session', reason: 'extra key' },
      { type: 'addDirectories', directories: [], destination: 'session' },
    ]) {
      expect(FreshAgentSnapshotSchema.safeParse(withSuggestions([suggestions[0], bad])).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('parses turn pages and turn bodies with the full session locator', () => {
    expect(FreshAgentTurnPageSchema.parse(claudeContractTurnPage).provider).toBe('claude')
    expect(FreshAgentTurnPageSchema.parse(codexContractTurnPage).provider).toBe('codex')
    expect(FreshAgentTurnBodySchema.parse(claudeContractTurnBody).threadId).toBe('sdk-claude-1')
    expect(FreshAgentTurnBodySchema.parse(codexContractTurnBody).threadId).toBe('thread-codex-1')
  })

  it('keeps Codex server request ids as string or integer values', () => {
    expect(FreshAgentRequestIdSchema.parse('request-1')).toBe('request-1')
    expect(FreshAgentRequestIdSchema.parse(42)).toBe(42)
    expect(() => FreshAgentRequestIdSchema.parse(1.25)).toThrow()
  })

  it('rejects provider blobs that bypass the typed extension boundary', () => {
    expect(() => FreshAgentSnapshotSchema.parse({
      ...codexContractSnapshot,
      extensions: { codex: { review: { id: 'review-1' } }, extraProvider: {} },
    })).toThrow()
  })

  it('parses a snapshot carrying provider-advertised session commands and round-trips the rows', () => {
    const commands = [
      { name: 'compact', description: 'Compact the conversation', argumentHint: '[focus]', aliases: ['squeeze'] },
      { name: 'review', description: '' },
    ]
    const parsed = FreshAgentSnapshotSchema.parse({ ...claudeContractSnapshot, commands })
    expect(parsed.commands).toEqual(commands)
    expect(FreshAgentSessionCommandSchema.parse(commands[0])).toEqual(commands[0])
    expect(FreshAgentSessionCommandSchema.parse(commands[1])).toEqual(commands[1])
  })

  it('rejects garbage session-command rows on the row schema and inside the snapshot', () => {
    const garbageRows = [
      { description: 'missing name' },
      { name: '', description: 'empty name' },
      { name: 'compact', description: 'strict extra key', bogus: true },
    ]
    for (const row of garbageRows) {
      expect(() => FreshAgentSessionCommandSchema.parse(row)).toThrow()
      expect(() => FreshAgentSnapshotSchema.parse({ ...claudeContractSnapshot, commands: [row] })).toThrow()
    }
  })

  it('parses snapshots without commands exactly as before (graceful absence for Rust/codex/offline)', () => {
    const claudeParsed = FreshAgentSnapshotSchema.parse(claudeContractSnapshot)
    const codexParsed = FreshAgentSnapshotSchema.parse(codexContractSnapshot)
    expect('commands' in claudeParsed).toBe(false)
    expect('commands' in codexParsed).toBe(false)
    expect(claudeParsed.sessionType).toBe('freshclaude')
    expect(codexParsed.sessionType).toBe('freshcodex')
  })

  it('registers the session-command schema for contract traceability', () => {
    expect(FRESH_AGENT_CONTRACT_SCHEMA_NAMES).toContain('FreshAgentSessionCommandSchema')
  })

  it('parses action results and contract errors with locator context', () => {
    expect(FreshAgentActionResultSchema.parse({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-codex-1',
      action: 'fork',
      result: { threadId: 'thread-child-1' },
    }).action).toBe('fork')

    expect(FreshAgentContractErrorSchema.parse({
      code: 'FRESH_AGENT_CONTRACT_PARSE_FAILED',
      message: 'Invalid snapshot',
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-codex-1',
    }).code).toBe('FRESH_AGENT_CONTRACT_PARSE_FAILED')
  })
})

describe('rollback surface (kata 1wxv)', () => {
  it('capabilities accept optional undo/redo keys and stay strict', () => {
    const parsed = FreshAgentCapabilitiesSchema.safeParse({
      send: true, interrupt: true, approvals: false, questions: false, fork: false, undo: true, redo: false,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.undo).toBe(true)
    expect(parsed.data?.redo).toBe(false)
  })
  it('capabilities without the new keys still parse (legacy TS server never emits them)', () => {
    expect(FreshAgentCapabilitiesSchema.safeParse({
      send: true, interrupt: true, approvals: false, questions: false, fork: false,
    }).success).toBe(true)
  })
  it('a turn may carry rolledBack', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true,
    })
    expect(parsed.success).toBe(true)
  })
  it('a bucket turn may carry restorable', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true, restorable: true,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.restorable).toBe(true)
  })
  it('restorable is optional on turns (older servers omit it)', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.restorable).toBeUndefined()
  })
  it('snapshot round-trips restorable-stamped rolledBackTurns', () => {
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true, undo: true, redo: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [],
      rolledBackTurns: [{ id: 't2', turnId: 't2', summary: 'gone', items: [], rolledBack: true, restorable: true }],
      rollback: { canRedo: true, undoneDepth: 1, redoableTurnIds: ['t2'] },
      extensions: {},
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.rolledBackTurns?.[0]?.restorable).toBe(true)
  })
  it('a turn with an undeclared restorableTypo key rejects (turn stays strict)', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true, restorableTypo: true,
    }).success).toBe(false)
  })
  it('snapshot accepts rolledBackTurns + the inline rollback block', () => {
    const turn = { id: 't2', turnId: 't2', summary: 'gone', items: [], rolledBack: true }
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true, undo: true, redo: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [], rolledBackTurns: [turn], rollback: { canRedo: true, undoneDepth: 1 },
      extensions: {},
    })
    expect(parsed.success).toBe(true)
  })
  it('delta-r1 F6: the rollback block accepts the optional redoableTurnIds gate set, and the block stays strict', () => {
    const base = {
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle' as const,
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true, undo: true, redo: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [] as unknown[], extensions: {},
    }
    // The pre-F6 surface (no key) still parses — legacy harmlessness.
    expect(FreshAgentSnapshotSchema.safeParse({
      ...base, rollback: { canRedo: true, undoneDepth: 1 },
    }).success).toBe(true)
    // The F6 server shape parses; the set is exactly a string array.
    const withGate = FreshAgentSnapshotSchema.safeParse({
      ...base, rollback: { canRedo: true, undoneDepth: 1, redoableTurnIds: ['t2'] },
    })
    expect(withGate.success).toBe(true)
    expect(withGate.data?.rollback?.redoableTurnIds).toEqual(['t2'])
    // Strictness holds inside the block: undeclared keys reject.
    expect(FreshAgentSnapshotSchema.safeParse({
      ...base, rollback: { canRedo: true, undoneDepth: 1, redoableTurnIdsTypo: ['t2'] },
    }).success).toBe(false)
  })
  it('snapshot remains strict against undeclared keys', () => {
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [], extensions: {}, rollbackTypo: {},
    })
    expect(parsed.success).toBe(false)
  })

  describe('capabilities.settingScopes', () => {
    const minimalCapabilities = {
      send: true,
      interrupt: true,
      approvals: false,
      questions: false,
      fork: false,
    }

    it('round-trips a capabilities object advertising per-send scopes for every knob', () => {
      const settingScopes = {
        model: 'per-send',
        effort: 'per-send',
        sandbox: 'per-send',
        permissionMode: 'per-send',
      }
      const parsed = FreshAgentCapabilitiesSchema.parse({ ...minimalCapabilities, settingScopes })
      expect(parsed.settingScopes).toEqual(settingScopes)
    })

    it('still parses capabilities without settingScopes (backward compat)', () => {
      const parsed = FreshAgentCapabilitiesSchema.parse(minimalCapabilities)
      expect('settingScopes' in parsed).toBe(false)
      expect(parsed.settingScopes).toBeUndefined()
    })

    it('rejects an unknown scope value inside settingScopes', () => {
      expect(() => FreshAgentCapabilitiesSchema.parse({
        ...minimalCapabilities,
        settingScopes: { model: 'sometimes' },
      })).toThrow()
    })
  })
})

describe('task_delegation transcript item', () => {
  const fullItem = {
    id: 'part_task_1',
    kind: 'task_delegation',
    status: 'running',
    title: 'General Task — Fix the flaky harness',
    description: 'Fix the flaky harness',
    subagent: 'general',
    background: false,
    childSessionId: 'ses_child_1',
    startedAtMs: 1789406370320,
    endedAtMs: 1789408126081,
    durationMs: 1755761,
    activity: [
      { tool: 'bash', status: 'completed', preview: 'sed -n 92,112p src/store/paneTypes.ts' },
      { tool: 'grep', status: 'failed', preview: 'reasoningEffort in src' },
    ],
    result: '<task id="ses_child_1" state="completed"><task_result>ok</task_result></task>',
  }

  it('parses a full task_delegation item', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse(fullItem).success).toBe(true)
  })

  it('parses a minimal task_delegation item (title + status only)', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'part_task_1', kind: 'task_delegation', status: 'completed', title: 'General Task — x',
    }).success).toBe(true)
  })

  it('rejects unknown keys on task_delegation (strict)', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ ...fullItem, bogus: 1 }).success).toBe(false)
  })

  it('rejects an invalid delegation status', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ ...fullItem, status: 'finished' }).success).toBe(false)
  })
})

describe('retry transcript item', () => {
  it('parses attempt with error', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'part_retry_1', kind: 'retry', attempt: 2, error: 'stream disconnected',
    }).success).toBe(true)
  })

  it('parses attempt without error', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ id: 'part_retry_1', kind: 'retry', attempt: 1 }).success).toBe(true)
  })

  it('rejects non-positive attempts', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ id: 'r', kind: 'retry', attempt: 0 }).success).toBe(false)
  })
})

describe('delegated_task transcript item', () => {
  it('parses agent, description and command', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'part_sub_1', kind: 'delegated_task', agent: 'general',
      description: 'Fix the flaky harness', command: '/fix',
    }).success).toBe(true)
  })

  it('parses a bare marker', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ id: 'part_sub_1', kind: 'delegated_task' }).success).toBe(true)
  })
})

describe('reasoning duration and title fields', () => {
  it('parses reasoning with durationMs and title', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'part_reasoning_1', kind: 'reasoning',
      summary: ['weighing options'], content: ['weighing options'], text: 'weighing options',
      durationMs: 1831, title: 'planning the fix',
    }).success).toBe(true)
  })

  it('rejects negative durationMs', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'p', kind: 'reasoning', summary: [], content: [], durationMs: -1,
    }).success).toBe(false)
  })
})

describe('durable opencode error projection (turn-level and tool-level)', () => {
  const deadlineRaw = '{"message":"request deadline exceeded after 1195s before the response completed","type":"request_deadline_exceeded"}'
  const toolErrorText = 'The user has specified a rule which prevents you from using this specific tool call.'

  it('parses a turn carrying the projected opencode error', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [],
      error: { name: 'UnknownError', message: deadlineRaw },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error).toEqual({ name: 'UnknownError', message: deadlineRaw })
  })

  it('parses snapshots whose errored turn is the only carrier of the failure', () => {
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [{ id: 't1', turnId: 't1', summary: '', items: [], error: { name: 'MessageAbortedError', message: 'Aborted' } }],
      extensions: {},
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.turns[0]?.error?.name).toBe('MessageAbortedError')
  })

  it('keeps the turn error key optional (claude/codex/legacy servers omit it)', () => {
    const parsed = FreshAgentTurnSchema.safeParse({ id: 't1', turnId: 't1', summary: 's', items: [] })
    expect(parsed.success).toBe(true)
    expect(parsed.data && 'error' in parsed.data).toBe(false)
  })

  it('rejects a turn error without a message', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [], error: { name: 'UnknownError' },
    }).success).toBe(false)
  })

  it('rejects a blank turn error message', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [], error: { name: 'UnknownError', message: '' },
    }).success).toBe(false)
  })

  it('rejects unknown keys inside the turn error (strict)', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [],
      error: { name: 'UnknownError', message: 'boom', code: 'request_deadline_exceeded' },
    }).success).toBe(false)
  })

  it('parses a persisted opencode tool error on a dynamic_tool item', () => {
    const parsed = FreshAgentTranscriptItemSchema.safeParse({
      id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
      status: 'failed', arguments: { command: 'false' }, contentItems: null, success: null,
      error: toolErrorText,
    })
    expect(parsed.success && parsed.data.kind === 'dynamic_tool' && parsed.data.error).toBe(toolErrorText)
  })

  it('keeps the tool error key optional and rejects blank or non-string values', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
      status: 'completed', arguments: {}, contentItems: ['ok'], success: true,
    }).success).toBe(true)
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
      status: 'failed', arguments: {}, contentItems: null, success: null, error: '',
    }).success).toBe(false)
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
      status: 'failed', arguments: {}, contentItems: null, success: null, error: 42,
    }).success).toBe(false)
  })
})


it('keeps native question flags and retained MCP forms in the durable contract', () => {
  const parsed = FreshAgentSnapshotSchema.parse({ ...codexContractSnapshot, pendingQuestions: [{ requestId: '51', isBlocking: false, questions: [{ id: 'token', question: 'Token?', isOther: false, isSecret: true }] }], pendingElicitations: [{ requestId: '41', mode: 'openaiForm', serverName: 'contract', message: 'Form', fields: [{ id: 'enabled', title: 'Enabled', type: 'boolean', required: true }] }] })
  expect(parsed.pendingQuestions[0]).toMatchObject({ isBlocking: false, questions: [{ isOther: false, isSecret: true }] })
  expect(parsed.pendingElicitations[0]).toMatchObject({ mode: 'openaiForm', fields: [{ type: 'boolean' }] })
})


it('keeps elicitation replies separate from string-valued question answers and rejects nested content', () => {
  const locator = { provider: 'codex', sessionType: 'freshcodex', sessionId: 'native-thread', requestId: '41' }
  const frame = { ...locator, type: 'freshAgent.elicitation.respond', action: 'accept', content: { token: ' exact, answer! ', count: 3, enabled: false, colors: ['blue', 'green'] } }
  expect(FreshAgentClientMessageSchema.parse(frame)).toEqual(frame)
  for (const action of ['decline', 'cancel']) expect(FreshAgentClientMessageSchema.safeParse({ ...frame, action, content: null }).success).toBe(true)
  expect(FreshAgentClientMessageSchema.safeParse({ ...frame, content: { nested: { value: 'unsupported' } } }).success).toBe(false)
  expect(FreshAgentClientMessageSchema.safeParse({ ...frame, action: 'other' }).success).toBe(false)
  const question = { ...locator, type: 'freshAgent.question.respond', answers: { token: ' exact, answer! ' } }
  expect(FreshAgentClientMessageSchema.parse(question)).toEqual(question)
})
