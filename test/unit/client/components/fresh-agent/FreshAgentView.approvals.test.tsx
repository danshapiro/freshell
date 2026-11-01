import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { appReducers } from '@/store/appReducers'
import { initLayout } from '@/store/panesSlice'
import { sessionCreated } from '@/store/freshAgentSlice'
import { setStatus } from '@/store/connectionSlice'
import { useAppSelector } from '@/store/hooks'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { resetSnapshotSchedulerForTests, SNAPSHOT_DEBOUNCE_MS } from '@/lib/fresh-agent-snapshot-scheduler'

// Client-alerts plan G20 (D10): how a pane answers approvals. A claude
// approval offers Claude's own "don't ask again" (its suggestions go back as
// updatedPermissions) and never a client-only bypass, so no claude request is
// ever answered without a click; codex keeps its pane-scoped "Always allow".

const wsMock = vi.hoisted(() => ({
  handlers: new Set<(message: unknown) => void>(),
  send: vi.fn(),
}))

const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
}))

vi.mock('@/components/markdown/LazyMarkdown', () => ({ LazyMarkdown: ({ content }: { content: string }) => <span>{content}</span> }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMock.send,
    onMessage: (handler: (message: unknown) => void) => {
      wsMock.handlers.add(handler)
      return () => { wsMock.handlers.delete(handler) }
    },
    onReconnect: () => () => {},
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockRejectedValue(new Error('no server in tests')),
      post: vi.fn().mockRejectedValue(new Error('no server in tests')),
    },
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
    getFreshAgentCheckpointOutcomePage: vi.fn().mockResolvedValue({ outcomes: [], nextCursor: null }),
    getFreshAgentModelCapabilities: vi.fn().mockRejectedValue(new Error('no server in tests')),
    setSessionMetadata: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => ({ type: 'settings/saveServerSettingsPatch', payload: patch }),
}))

type Locator = { sessionId: string; sessionType: 'freshclaude' | 'kilroy' | 'freshcodex'; provider: 'claude' | 'codex' }
const CLAUDE: Locator = { sessionId: '550e8400-e29b-41d4-a716-44665544a001', sessionType: 'freshclaude', provider: 'claude' }
const KILROY: Locator = { sessionId: '550e8400-e29b-41d4-a716-44665544a002', sessionType: 'kilroy', provider: 'claude' }
const CODEX: Locator = { sessionId: 'thread-approvals-1', sessionType: 'freshcodex', provider: 'codex' }

const NPM_RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'localSettings' }
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

type Approval = { requestId: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[] }

function snapshot(locator: Locator, pendingApprovals: Approval[], revision: number) {
  return {
    sessionType: locator.sessionType,
    provider: locator.provider,
    threadId: locator.sessionId,
    sessionId: locator.sessionId,
    revision,
    latestTurnId: null,
    status: 'running',
    summary: '',
    capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    pendingApprovals,
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [],
    extensions: {},
  }
}

/** Serve these pending sets in order (the last one repeats); every read is a fresh object. */
function serve(locator: Locator, ...pendingSets: Approval[][]) {
  const queue = pendingSets.map((pending, index) => () => snapshot(locator, pending, index + 1))
  apiMock.getFreshAgentThreadSnapshot.mockImplementation(async () => (queue.length > 1 ? queue.shift()! : queue[0])())
}

function createStore(locator: Locator) {
  const store = configureStore({
    reducer: appReducers,
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
  })
  store.dispatch(setStatus('ready'))
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: { kind: 'fresh-agent', ...locator, createRequestId: 'req-approvals', status: 'running' },
  }))
  // The session's record, as a create leaves it (the WS events fold into it).
  store.dispatch(sessionCreated({ requestId: 'req-approvals', ...locator }))
  return store
}

type Store = ReturnType<typeof createStore>

function StoreBackedView() {
  const content = useAppSelector((state) => {
    const layout = state.panes.layouts['tab-1']
    if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') throw new Error('missing pane')
    return layout.content
  })
  return <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function mount(store: Store) {
  render(<Provider store={store}><StoreBackedView /></Provider>)
  await advance(0)
  await advance(SNAPSHOT_DEBOUNCE_MS)
}

/** The server raises another approval: the pane refetches its snapshot. */
async function raise(store: Store, locator: Locator, requestId: string) {
  const message = {
    type: 'freshAgent.event',
    ...locator,
    event: { type: 'freshAgent.permission.request', sessionId: locator.sessionId, requestId, subtype: 'can_use_tool' },
  }
  act(() => {
    handleFreshAgentMessage(store.dispatch, message)
    for (const handler of [...wsMock.handlers]) handler(message)
  })
  await advance(SNAPSHOT_DEBOUNCE_MS)
  await advance(0)
}

const responds = () => wsMock.send.mock.calls
  .map(([message]) => message)
  .filter((message) => message?.type === 'freshAgent.approval.respond')

beforeEach(() => {
  vi.useFakeTimers()
  resetSnapshotSchedulerForTests()
  wsMock.handlers.clear()
  wsMock.send.mockReset()
  apiMock.getFreshAgentThreadSnapshot.mockReset()
})

afterEach(() => {
  cleanup()
  resetSnapshotSchedulerForTests()
  vi.useRealTimers()
})

describe('FreshAgentView approvals (client-alerts G20)', () => {
  it.each([CLAUDE, KILROY])('a $sessionType "Allow and don\'t ask again" sends the CLI\'s suggestions as updatedPermissions', async (locator) => {
    serve(locator, [{ requestId: 'req-1', toolName: 'Bash', input: { command: 'npm test' }, suggestions: [NPM_RULE, ACCEPT_EDITS] }])
    const store = createStore(locator)
    await mount(store)

    fireEvent.click(screen.getByRole('button', { name: 'Allow and don\'t ask again' }))
    expect(responds()).toEqual([{
      type: 'freshAgent.approval.respond',
      sessionId: locator.sessionId,
      sessionType: locator.sessionType,
      provider: 'claude',
      requestId: 'req-1',
      decision: { behavior: 'allow', updatedPermissions: [NPM_RULE, ACCEPT_EDITS] },
    }])
  })

  it('a claude pane has no client-only bypass: a second request for the same tool waits for a click', async () => {
    const first = { requestId: 'req-1', toolName: 'Bash', input: { command: 'npm test' }, suggestions: [NPM_RULE] }
    const second = { requestId: 'req-2', toolName: 'Bash', input: { command: 'npm test -- --watch' } }
    serve(CLAUDE, [first], [second])
    const store = createStore(CLAUDE)
    await mount(store)

    expect(screen.queryByRole('button', { name: /always allow/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow and don\'t ask again' }))
    await raise(store, CLAUDE, 'req-2')

    expect(screen.getByRole('alert', { name: 'Permission request for Bash' })).toHaveTextContent('npm test -- --watch')
    expect(responds().map((message) => message.requestId)).toEqual(['req-1'])
    expect(screen.queryByRole('button', { name: /always allow/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow tool use' }))
    expect(responds().at(-1)).toMatchObject({ requestId: 'req-2', decision: { behavior: 'allow' } })
  })

  it('a claude ExitPlanMode request shows the plan card, and its choice goes out as the approval decision', async () => {
    serve(CLAUDE, [{ requestId: 'plan-1', toolName: 'ExitPlanMode', input: { plan: '# Plan\n\n1. Edit' } }])
    const store = createStore(CLAUDE)
    await mount(store)

    expect(screen.getByRole('alert', { name: 'Plan approval request' })).toBeInTheDocument()
    expect(screen.queryByRole('alert', { name: /permission request/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve and auto-accept edits' }))
    expect(responds()).toEqual([expect.objectContaining({
      requestId: 'plan-1',
      decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
    })])
  })

  it('a codex pane keeps "Always allow <Tool> in this pane": it answers the next request for that tool without a click', async () => {
    serve(
      CODEX,
      [{ requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } }],
      [{ requestId: 'req-2', toolName: 'Bash', input: { command: 'pwd' } }],
    )
    const store = createStore(CODEX)
    await mount(store)

    fireEvent.click(screen.getByRole('button', { name: 'Always allow Bash in this pane' }))
    await raise(store, CODEX, 'req-2')

    expect(responds()).toEqual([
      expect.objectContaining({ provider: 'codex', requestId: 'req-1', decision: { behavior: 'allow' } }),
      expect.objectContaining({ provider: 'codex', requestId: 'req-2', decision: { behavior: 'allow' } }),
    ])
  })
})


it('retains an MCP form from a snapshot and sends a separate typed answer', async () => {
  const current = { ...snapshot(CODEX, [], 1), pendingElicitations: [{ requestId: '41', mode: 'form', serverName: 'contract', message: 'Enter credentials', fields: [{ id: 'token', type: 'string', title: 'Token', required: true, secret: true }], providerRequest: { id: 41, method: 'mcpServer/elicitation/request' } }] }
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(current)
  await mount(createStore(CODEX))
  const token = screen.getByLabelText('Token')
  expect(token).toHaveAttribute('type', 'password')
  fireEvent.change(token, { target: { value: ' exact, token! ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue', exact: true }))
  expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.elicitation.respond', requestId: '41', action: 'accept', content: { token: ' exact, token! ' } }))
})

it.each(['freshAgent.elicitation.request', 'freshAgent.elicitation.cancelled'])('refreshes an idle native form from %s without waiting for a turn or poll', async (eventType) => {
  const request = { requestId: 'live-elicitation', mode: 'form', serverName: 'contract', message: 'Live form', fields: [{ id: 'name', title: 'Live name', type: 'string', required: true }] }
  const before = eventType === 'freshAgent.elicitation.request' ? [] : [request]
  const after = eventType === 'freshAgent.elicitation.request' ? [request] : []
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...snapshot(CODEX, [], 1), status: 'idle', pendingElicitations: before })
  const store = createStore(CODEX)
  await mount(store)
  expect(screen.queryAllByRole('region', { name: 'Request from contract' })).toHaveLength(before.length)
  const reads = apiMock.getFreshAgentThreadSnapshot.mock.calls.length
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...snapshot(CODEX, [], 2), status: 'idle', pendingElicitations: after })
  const message = { type: 'freshAgent.event', ...CODEX, event: { ...request, type: eventType } }
  act(() => {
    handleFreshAgentMessage(store.dispatch, message)
    for (const handler of wsMock.handlers) handler(message)
  })
  await advance(SNAPSHOT_DEBOUNCE_MS)
  await advance(0)
  expect(screen.queryAllByRole('region', { name: 'Request from contract' })).toHaveLength(after.length)
  expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(reads + 1)
  expect(wsMock.send.mock.calls.filter(([frame]) => frame.type === 'freshAgent.elicitation.respond' || frame.type === 'freshAgent.send')).toHaveLength(0)
})

it('native approvals expose only offered actions and no pane auto-grant', async () => {
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...snapshot(CODEX, [], 1), pendingApprovals: [{ requestId: '41', toolName: 'Bash', native: { networkApprovalContext: { host: 'example.com', protocol: 'https' }, availableDecisions: ['accept', 'cancel'] } }] })
  await mount(createStore(CODEX))
  expect(screen.getByRole('alert', { name: 'Permission request for Bash' })).toHaveTextContent('example.com')
  expect(screen.queryByRole('button', { name: /always allow/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Deny tool use' })).not.toBeInTheDocument()
  fireEvent.click(within(screen.getByRole('alert', { name: 'Permission request for Bash' })).getByRole('button', { name: 'Stop', exact: true }))
  expect(responds().at(-1)).toMatchObject({ requestId: '41', decision: { nativeDecision: 'cancel' } })
})


it.each([true, false])('answers async questions through the ordinary composer and waits for ordinary acceptance (native turn ID: %s)', async (hasTurnId) => {
  const current = { ...snapshot(CODEX, [], 1), status: 'idle', turns: [{ id: 'native-turn:row-1', turnId: 'native-turn', role: 'assistant', summary: '', items: [{ id: 'async-item', kind: 'text', text: 'I can keep working.', extensions: { codex: { delivery: 'async', itemId: 'native-async-item', questions: [{ title: 'Where?', options: ['Staging', 'Production'] }] } } }] }] }
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(current)
  const store = createStore(CODEX)
  await mount(store)
  fireEvent.click(screen.getByRole('button', { name: 'Staging', exact: true }))
  const composer = screen.getByRole('textbox', { name: 'Chat message input' })
  expect((composer as HTMLTextAreaElement).value).toContain('native-async-item')
  expect((composer as HTMLTextAreaElement).value).toContain('Staging')
  expect(wsMock.send.mock.calls.some(([m]) => m.type === 'freshAgent.question.respond')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }))
  await advance(0)
  const sent = wsMock.send.mock.calls.map(([m]) => m).find((m) => m.type === 'freshAgent.send')
  expect(sent).toMatchObject({ text: expect.stringContaining('Staging') })
  expect(screen.queryByText('Answer accepted as a message')).not.toBeInTheDocument()
  act(() => { for (const handler of wsMock.handlers) handler({ type: 'freshAgent.send.accepted', ...CODEX, requestId: sent.requestId, ...(hasTurnId ? { submittedTurnId: 'ordinary-next-turn' } : {}) }) })
  expect(screen.getByText('Answer accepted as a message')).toBeVisible()
})

it('changing an unsent async choice updates that answer and preserves the ordinary draft', async () => {
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...snapshot(CODEX, [], 1), status: 'idle', turns: [{ id: 'native-turn', turnId: 'native-turn', role: 'assistant', summary: '', items: [{ id: 'async-item', kind: 'text', text: 'Work continues', extensions: { codex: { delivery: 'async', itemId: 'native-async-item', questions: [{ title: 'Where?', options: ['Staging', 'Production'] }] } } }] }] })
  await mount(createStore(CODEX))
  const composer = screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: 'Keep my ordinary note' } })
  fireEvent.click(screen.getByRole('button', { name: 'Staging', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Production', exact: true }))
  expect(composer.value).toContain('Keep my ordinary note')
  expect(composer.value).toContain('Production')
  expect(composer.value).not.toContain('Staging')
  expect(wsMock.send.mock.calls.some(([message]) => message.type === 'freshAgent.send' || message.type === 'freshAgent.question.respond')).toBe(false)
})

it('restores an ordinary async-answer draft silently and associates acceptance only after explicit Send', async () => {
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...snapshot(CODEX, [], 1), status: 'idle', turns: [{ id: 'native-turn', turnId: 'native-turn', role: 'assistant', summary: '', items: [{ id: 'async-item', kind: 'text', text: 'Work continues', extensions: { codex: { delivery: 'async', itemId: 'native-async-item', questions: [{ title: 'Where?', options: ['Staging'] }] } } }] }] })
  const store = createStore(CODEX)
  await mount(store)
  fireEvent.click(screen.getByRole('button', { name: 'Staging', exact: true }))
  cleanup()
  resetSnapshotSchedulerForTests()
  await mount(store)
  const composer = screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
  expect(composer.value).toContain('native-async-item')
  expect(wsMock.send.mock.calls.filter(([message]) => message.type === 'freshAgent.send')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }))
  await advance(0)
  const sent = wsMock.send.mock.calls.map(([message]) => message).find((message) => message.type === 'freshAgent.send')
  expect(sent.text).toContain('Staging')
  act(() => { for (const handler of wsMock.handlers) handler({ type: 'freshAgent.send.accepted', ...CODEX, requestId: sent.requestId, submittedTurnId: 'ordinary-next-turn' }) })
  expect(screen.getByText('Answer accepted as a message')).toBeVisible()
  expect(wsMock.send.mock.calls.filter(([message]) => message.type === 'freshAgent.question.respond')).toHaveLength(0)
})

it.each([
  ['SESSION_RESERVED', 'Another resume is in flight', 'Answer not sent; your draft is in the composer.'],
  ['INTERNAL_ERROR', 'CODEX_DELIVERY_AMBIGUOUS: response was lost', 'Answer delivery uncertain; review the composer before sending again.'],
])('retains an ordinary async answer and its delivery indication after %s', async (code, message, indication) => {
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...snapshot(CODEX, [], 1), status: 'idle', turns: [{ id: 'native-turn', turnId: 'native-turn', role: 'assistant', summary: '', items: [{ id: 'async-item', kind: 'text', text: 'Work continues', extensions: { codex: { delivery: 'async', itemId: 'native-async-item', questions: [{ title: 'Where?', options: ['Staging'] }] } } }] }] })
  await mount(createStore(CODEX))
  fireEvent.click(screen.getByRole('button', { name: 'Staging', exact: true }))
  const composer = screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
  const original = composer.value
  fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }))
  await advance(0)
  const sent = wsMock.send.mock.calls.map(([frame]) => frame).find((frame) => frame.type === 'freshAgent.send')
  fireEvent.change(composer, { target: { value: 'A newer ordinary draft' } })
  act(() => { for (const handler of wsMock.handlers) handler({ type: 'error', requestId: sent.requestId, code, message }) })
  expect(composer).toHaveValue(`${original}\nA newer ordinary draft`)
  expect(screen.getByText(indication)).toBeVisible()
  expect(screen.queryByText('Answer accepted as a message')).not.toBeInTheDocument()
  await advance(1000)
  expect(wsMock.send.mock.calls.filter(([frame]) => frame.type === 'freshAgent.send')).toHaveLength(1)
  expect(wsMock.send.mock.calls.filter(([frame]) => frame.type === 'freshAgent.question.respond')).toHaveLength(0)
})
