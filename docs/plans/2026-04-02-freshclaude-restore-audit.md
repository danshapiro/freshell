# FreshClaude Restore Audit And Completeness Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FreshClaude restore deterministic and complete across reloads, remounts, reconnects, and server restarts, so the first visible restored frame and its linked pane metadata both match the latest recoverable session state instead of a partial or stale subset.

**Architecture:** Move restore-source selection to the server and make it canonical. A shared agent-history source will resolve live SDK session state against durable Claude JSONL history, `sdk.session.snapshot` will carry the authoritative timeline identity plus live-stream metadata, and the client will consume that canonical identity everywhere restore depends on a durable Claude session ID: the first visible timeline fetch, header/runtime metadata lookups, and busy-session key projection.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket (`ws`), Anthropic Claude Agent SDK, Vitest, Testing Library

---

## Restore Contract

- A visible FreshClaude pane must restore from one authoritative history source. The UI cannot guess whether live SDK state or durable Claude JSONL is fresher.
- The client must never infer timeline identity from a mix of `resumeSessionId`, `cliSessionId`, and `sessionId`. The server must provide the canonical restore ID.
- Any client consumer that needs the durable Claude identity during restore must use that canonical `timelineSessionId` when it exists. Header/runtime metadata and busy-session projections cannot keep guessing from `cliSessionId` or persisted `resumeSessionId` alone.
- The first visible restore page must arrive with bodies inline. The current "summaries first, then fetch the newest body separately" path is why restore looks partial even when the server has enough data.
- Live reconnects must restore the latest committed turns even when durable JSONL lags behind in-memory SDK state.
- Mid-stream reconnects must restore enough state to show that work is still in progress; otherwise the UI regresses to "Running..." with missing output.
- Hidden panes should stay cheap: they can attach for ownership and status, but should not do the visible-history fetch until they are visible again.
- Server-restart recovery stays supported: if the live SDK session is gone, the client must recover through the durable Claude session ID without trapping the pane in restore mode.
- Divergent live-vs-durable history is a real boundary condition. Handle it explicitly and log it; do not silently interleave mismatched histories.

## File Structure

- Create: `server/agent-timeline/history-source.ts`
  Responsibility: canonical restore-history resolution and live-vs-durable merge rules.
- Modify: `server/agent-timeline/service.ts`
  Responsibility: build paginated timeline pages from the canonical history source instead of raw JSONL reads.
- Modify: `server/index.ts`
  Responsibility: instantiate the shared history source once and wire it into both HTTP timeline reads and WebSocket restore flows.
- Modify: `server/sdk-bridge-types.ts`
  Responsibility: extend in-memory SDK session state with streaming snapshot fields needed for reconnect restore.
- Modify: `server/sdk-bridge.ts`
  Responsibility: track streaming snapshot state and expose lookup by CLI session ID.
- Modify: `server/ws-handler.ts`
  Responsibility: send authoritative `sdk.session.snapshot` payloads for both `sdk.create` and `sdk.attach`, sourced from the shared history source.
- Modify: `shared/ws-protocol.ts`
  Responsibility: define the richer `sdk.session.snapshot` wire contract.
- Modify: `src/lib/api.ts`
  Responsibility: let the client request initial timeline pages with `includeBodies=true`.
- Modify: `src/store/agentChatTypes.ts`
  Responsibility: model canonical timeline identity and streamed restore metadata in Redux.
- Modify: `src/store/agentChatSlice.ts`
  Responsibility: persist snapshot metadata and inline bodies without weakening the existing `historyLoaded` contract.
- Modify: `src/store/agentChatThunks.ts`
  Responsibility: request inline bodies for the first visible page and skip the redundant newest-turn fetch when the bodies already arrived.
- Modify: `src/lib/sdk-message-handler.ts`
  Responsibility: pass richer snapshot payloads into Redux unchanged.
- Modify: `src/components/agent-chat/AgentChatView.tsx`
  Responsibility: consume the authoritative timeline identity and render a complete restored first page.
- Modify: `src/components/panes/PaneContainer.tsx`
  Responsibility: resolve FreshClaude runtime metadata from the canonical timeline identity before `sdk.session.init` backfills `cliSessionId`.
- Modify: `src/lib/pane-activity.ts`
  Responsibility: derive restored FreshClaude busy-session keys from the canonical timeline identity.
- Create: `test/unit/server/agent-timeline-history-source.test.ts`
  Responsibility: pin merge rules and identity resolution.
- Modify: `test/unit/server/agent-timeline/service.test.ts`
  Responsibility: verify timeline pagination is built from the canonical source.
- Modify: `test/unit/server/agent-timeline-include-bodies.test.ts`
  Responsibility: verify inline-body pages still work on the canonical source.
- Modify: `test/integration/server/agent-timeline-router.test.ts`
  Responsibility: verify route-level `includeBodies` behavior and canonical session identity.
- Modify: `test/unit/server/sdk-bridge.test.ts`
  Responsibility: verify reconnect-restorable streaming snapshot state.
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
  Responsibility: verify `sdk.session.snapshot` ordering and contents for live, durable-only, and mid-stream restore paths.
- Modify: `test/unit/server/ws-sdk-session-history-cache.test.ts`
  Responsibility: verify injected restore-source wiring replaces the previous raw loader seam.
- Modify: `test/unit/client/agentChatSlice.test.ts`
  Responsibility: verify richer snapshot and inline-body reducer semantics.
- Modify: `test/unit/client/store/agentChatThunks.test.ts`
  Responsibility: verify initial visible fetch uses `includeBodies=true` and does not double-fetch newest turns.
- Modify: `test/unit/client/sdk-message-handler.test.ts`
  Responsibility: verify richer snapshot payloads reach Redux intact.
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
  Responsibility: verify user-visible reload restore is complete.
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
  Responsibility: verify remount restore stays complete after tree restructuring.
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
  Responsibility: verify restored FreshClaude runtime metadata uses canonical timeline identity before `cliSessionId` exists.
- Modify: `test/unit/client/lib/pane-activity.test.ts`
  Responsibility: verify busy-session keys use canonical timeline identity during restore gaps.
- Create: `test/e2e/agent-chat-restore-flow.test.tsx`
  Responsibility: pin the real visible restore flow from websocket snapshot through timeline hydration.
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
  Responsibility: verify pane header metadata restores when only canonical timeline identity is known.

## Strategy Gate

- Do not fix this only in `AgentChatView.tsx`. The visible symptom is in the component, but the real defect is the split restore contract: WebSocket attach/create and HTTP timeline reads do not use the same source of truth.
- Do not patch only the HTTP timeline fetch to request more bodies. That would make restore look better while still dropping live-only turns and mid-stream state.
- Do not make the client infer which identifier to use. The server already knows whether the live SDK session, the durable Claude session, or both exist.
- Keep the visible-first behavior. Hidden panes can still defer the heavier history read until visible, but the first visible fetch must be complete.
- Prefer one explicit merge rule over heuristic client-side stitching. The current design scatters restore knowledge across `ws-handler`, `agent-timeline`, `sdk-message-handler`, `agentChatThunks`, and `AgentChatView`; this plan consolidates that knowledge on the server and keeps the client dumb.

### Task 1: Canonical Server Restore Source

**Files:**
- Create: `server/agent-timeline/history-source.ts`
- Modify: `server/agent-timeline/service.ts`
- Modify: `server/index.ts`
- Modify: `server/sdk-bridge.ts`
- Create: `test/unit/server/agent-timeline-history-source.test.ts`
- Modify: `test/unit/server/agent-timeline/service.test.ts`
- Modify: `test/unit/server/agent-timeline-include-bodies.test.ts`
- Modify: `test/integration/server/agent-timeline-router.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Create `test/unit/server/agent-timeline-history-source.test.ts` with the restore-source cases that are currently unowned:

```ts
it('prefers live sdk history when durable history is only a strict prefix', async () => {
  const source = createAgentHistorySource({
    loadSessionHistory: vi.fn().mockResolvedValue([
      makeMessage('user', 'older'),
      makeMessage('assistant', 'older reply'),
    ]),
    getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
      sessionId: 'sdk-1',
      cliSessionId: 'cli-1',
      messages: [
        makeMessage('user', 'older'),
        makeMessage('assistant', 'older reply'),
        makeMessage('user', 'live only turn'),
      ],
    })),
    getLiveSessionByCliSessionId: vi.fn(),
  })

  const resolved = await source.resolve('sdk-1')
  expect(resolved?.timelineSessionId).toBe('cli-1')
  expect(resolved?.messages).toEqual([
    makeMessage('user', 'older'),
    makeMessage('assistant', 'older reply'),
    makeMessage('user', 'live only turn'),
  ])
})

it('resolves the same live session when queried by cli session id', async () => {
  const live = makeLiveSession({ sessionId: 'sdk-2', cliSessionId: 'cli-2', messages: [makeMessage('assistant', 'hello')] })
  const source = createAgentHistorySource({
    loadSessionHistory: vi.fn().mockResolvedValue([makeMessage('assistant', 'hello')]),
    getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(undefined),
    getLiveSessionByCliSessionId: vi.fn().mockReturnValue(live),
  })

  const resolved = await source.resolve('cli-2')
  expect(resolved?.liveSessionId).toBe('sdk-2')
  expect(resolved?.timelineSessionId).toBe('cli-2')
})

it('chooses durable history when the live message list is empty after restart', async () => {
  const source = createAgentHistorySource({
    loadSessionHistory: vi.fn().mockResolvedValue([
      makeMessage('user', 'persisted'),
      makeMessage('assistant', 'persisted reply'),
    ]),
    getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
      sessionId: 'sdk-3',
      resumeSessionId: 'cli-3',
      messages: [],
    })),
    getLiveSessionByCliSessionId: vi.fn(),
  })

  const resolved = await source.resolve('sdk-3')
  expect(resolved?.messages).toHaveLength(2)
  expect(resolved?.timelineSessionId).toBe('cli-3')
})
```

Extend `test/unit/server/agent-timeline/service.test.ts` and `test/unit/server/agent-timeline-include-bodies.test.ts` so the service is forced to use the canonical source instead of a raw `loadSessionHistory()` stub.

Extend `test/integration/server/agent-timeline-router.test.ts` with:

```ts
it('passes includeBodies through the route family', async () => {
  await request(app)
    .get('/api/agent-sessions/agent-session-1/timeline?priority=visible&includeBodies=true')
    .set('x-auth-token', TEST_AUTH_TOKEN)

  expect(getTimelinePage).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'agent-session-1',
    includeBodies: true,
  }))
})
```

- [ ] **Step 2: Run the focused server tests to verify they fail**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/agent-timeline/service.test.ts test/unit/server/agent-timeline-include-bodies.test.ts
npm run test:integration -- --run test/integration/server/agent-timeline-router.test.ts
```

Expected: FAIL because the history-source module does not exist yet, the service still reads only durable JSONL, and the router path does not yet exercise `includeBodies`.

- [ ] **Step 3: Write the minimal implementation**

Create `server/agent-timeline/history-source.ts` with one explicit seam:

```ts
export type ResolvedAgentHistory = {
  liveSessionId?: string
  timelineSessionId: string
  messages: ChatMessage[]
  revision: number
}

export function createAgentHistorySource(deps: {
  loadSessionHistory: (sessionId: string) => Promise<ChatMessage[] | null>
  getLiveSessionBySdkSessionId: (sdkSessionId: string) => SdkSessionState | undefined
  getLiveSessionByCliSessionId: (cliSessionId: string) => SdkSessionState | undefined
}) {
  return {
    async resolve(queryId: string): Promise<ResolvedAgentHistory | null> {
      // 1. Find a live session by SDK id or CLI id.
      // 2. Resolve the canonical durable id: cliSessionId -> resumeSessionId -> queryId.
      // 3. Load durable JSONL once.
      // 4. If one side is a strict prefix of the other, return the longer list.
      // 5. If histories diverge, prefer live messages and log the divergence.
      // 6. Compute revision from the resolved list and return the canonical timeline id.
    },
  }
}
```

Update `server/sdk-bridge.ts` with a narrow lookup helper instead of leaking list scans everywhere:

```ts
findSessionByCliSessionId(cliSessionId: string): SdkSessionState | undefined {
  for (const session of this.sessions.values()) {
    if (session.cliSessionId === cliSessionId || session.resumeSessionId === cliSessionId) {
      return session
    }
  }
  return undefined
}
```

Update `server/agent-timeline/service.ts` so it accepts the history source and paginates `resolved.messages`, not `loadSessionHistory(sessionId)` directly. Keep the existing cursor shape.

Wire the shared source once in `server/index.ts` and pass it into `createAgentTimelineService(...)`.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/agent-timeline/service.test.ts test/unit/server/agent-timeline-include-bodies.test.ts
npm run test:integration -- --run test/integration/server/agent-timeline-router.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Tighten the merge helper so the prefix comparison is explicit and deterministic:

- compare `role`
- compare normalized `content`
- compare `model` when present
- treat timestamp mismatch as a divergence signal, not a merge key

Re-run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/agent-timeline/service.test.ts test/unit/server/agent-timeline-include-bodies.test.ts
npm run test:integration -- --run test/integration/server/agent-timeline-router.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/agent-timeline/history-source.ts server/agent-timeline/service.ts server/index.ts server/sdk-bridge.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/agent-timeline/service.test.ts test/unit/server/agent-timeline-include-bodies.test.ts test/integration/server/agent-timeline-router.test.ts
git commit -m "fix: canonicalize freshclaude restore history source"
```

### Task 2: Enrich SDK Restore Snapshots

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Modify: `test/unit/server/sdk-bridge.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/unit/server/ws-sdk-session-history-cache.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Extend `test/unit/server/sdk-bridge.test.ts` with reconnect-restorable stream-state coverage:

```ts
it('tracks streaming state for reconnect restore', async () => {
  mockKeepStreamOpen = true
  mockMessages.push({
    type: 'stream_event',
    event: { type: 'content_block_start' },
    session_id: 'cli-123',
    uuid: 'uuid-1',
  })
  mockMessages.push({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } },
    session_id: 'cli-123',
    uuid: 'uuid-2',
  })

  const session = await bridge.createSession({ cwd: '/tmp' })
  bridge.subscribe(session.sessionId, () => {})
  await new Promise(resolve => setTimeout(resolve, 100))

  expect(bridge.getSession(session.sessionId)).toMatchObject({
    streamingActive: true,
    streamingText: 'par',
  })
})
```

Extend `test/unit/server/ws-handler-sdk.test.ts` with:

```ts
it('sdk.attach snapshot includes canonical timelineSessionId and stream snapshot', async () => {
  mockSdkBridge.getSession.mockReturnValue({
    sessionId: 'sdk-sess-1',
    cliSessionId: 'cli-sess-1',
    status: 'running',
    messages: [makeMessage('user', 'hello')],
    streamingActive: true,
    streamingText: 'partial reply',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
  })

  // Expect sdk.session.snapshot to include timelineSessionId, latestTurnId, streamingActive, streamingText.
})
```

Also update the resumed-create ordering test so the snapshot assertions include:

```ts
expect(messages[1]).toEqual(expect.objectContaining({
  type: 'sdk.session.snapshot',
  sessionId: 'sdk-sess-1',
  timelineSessionId: durableSessionId,
}))
```

Update `test/unit/server/ws-sdk-session-history-cache.test.ts` so it verifies the injected restore seam now goes through the shared history source instead of the legacy raw-loader-only path.

- [ ] **Step 2: Run the focused server tests to verify they fail**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/sdk-bridge.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts
```

Expected: FAIL because the wire protocol does not yet include the richer snapshot payload and `SdkSessionState` does not track reconnect-restorable stream state.

- [ ] **Step 3: Write the minimal implementation**

Extend `shared/ws-protocol.ts`:

```ts
| {
    type: 'sdk.session.snapshot'
    sessionId: string
    latestTurnId: string | null
    status: SdkSessionStatus
    timelineSessionId?: string
    revision?: number
    streamingActive?: boolean
    streamingText?: string
  }
```

Extend `SdkSessionState` in `server/sdk-bridge-types.ts`:

```ts
streamingActive: boolean
streamingText: string
```

Update `server/sdk-bridge.ts` so `stream_event` mutates those fields:

```ts
if (event.type === 'content_block_start') {
  state.streamingActive = true
  state.streamingText = ''
}
if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
  state.streamingText += event.delta.text
}
if (event.type === 'content_block_stop') {
  state.streamingActive = false
}
if (msg.type === 'assistant' || msg.type === 'result') {
  state.streamingActive = false
  state.streamingText = ''
}
```

Update `server/ws-handler.ts` so both `sdk.create` and `sdk.attach` build the snapshot from the canonical history source instead of hand-assembling `latestTurnId`. The helper should:

```ts
const snapshot = await this.agentHistorySource.resolve(sessionIdOrTimelineId)
this.send(ws, {
  type: 'sdk.session.snapshot',
  sessionId,
  latestTurnId: snapshot ? `turn-${snapshot.messages.length - 1}` : null,
  status,
  timelineSessionId: snapshot?.timelineSessionId,
  revision: snapshot?.revision,
  streamingActive: liveSession?.streamingActive,
  streamingText: liveSession?.streamingText,
})
```

Keep the existing ordering invariant:

1. `sdk.created`
2. `sdk.session.snapshot`
3. `sdk.session.init`

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/sdk-bridge.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Remove duplicated snapshot-building branches from `server/ws-handler.ts` and keep one helper for:

- live attach
- durable-only attach
- resumed `sdk.create`

Re-run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/sdk-bridge.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts test/unit/server/agent-timeline-history-source.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/ws-protocol.ts server/sdk-bridge-types.ts server/sdk-bridge.ts server/ws-handler.ts server/index.ts test/unit/server/sdk-bridge.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts
git commit -m "fix: enrich freshclaude restore snapshots"
```

### Task 3: Client Restore Transport And Store Contract

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/store/agentChatThunks.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `test/unit/client/store/agentChatThunks.test.ts`
- Modify: `test/unit/client/sdk-message-handler.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Extend `test/unit/client/agentChatSlice.test.ts`:

```ts
it('stores timelineSessionId and stream snapshot from sdk.session.snapshot', () => {
  const state = agentChatReducer(initial, sessionSnapshotReceived({
    sessionId: 'sdk-1',
    latestTurnId: 'turn-2',
    status: 'running',
    timelineSessionId: 'cli-1',
    revision: 12,
    streamingActive: true,
    streamingText: 'partial reply',
  }))

  expect(state.sessions['sdk-1']).toMatchObject({
    timelineSessionId: 'cli-1',
    streamingActive: true,
    streamingText: 'partial reply',
  })
})

it('hydrates inline page bodies without a second newest-turn fetch', () => {
  const state = agentChatReducer(initial, timelinePageReceived({
    sessionId: 'sdk-1',
    items: [{ turnId: 'turn-2', sessionId: 'cli-1', role: 'assistant', summary: 'hello' }],
    nextCursor: null,
    revision: 12,
    replace: true,
    bodies: {
      'turn-2': {
        sessionId: 'cli-1',
        turnId: 'turn-2',
        message: makeChatMessage('assistant', 'hello'),
      },
    },
  }))

  expect(state.sessions['sdk-1'].timelineBodies['turn-2']).toEqual(makeChatMessage('assistant', 'hello'))
})
```

Extend `test/unit/client/store/agentChatThunks.test.ts`:

```ts
it('requests includeBodies on the first visible page and skips getAgentTurnBody when bodies are present', async () => {
  getAgentTimelinePage.mockResolvedValue({
    sessionId: 'cli-sess-1',
    items: [{ turnId: 'turn-2', sessionId: 'cli-sess-1', role: 'assistant', summary: 'Latest summary' }],
    nextCursor: null,
    revision: 2,
    bodies: {
      'turn-2': {
        sessionId: 'cli-sess-1',
        turnId: 'turn-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Latest full body' }],
          timestamp: '2026-03-10T10:01:00.000Z',
        },
      },
    },
  })

  await store.dispatch(loadAgentTimelineWindow({
    sessionId: 'sdk-sess-1',
    timelineSessionId: 'cli-sess-1',
    requestKey: 'tab-1:pane-1',
  }))

  expect(getAgentTimelinePage).toHaveBeenCalledWith(
    'cli-sess-1',
    expect.objectContaining({ priority: 'visible', includeBodies: true }),
    expect.anything(),
  )
  expect(getAgentTurnBody).not.toHaveBeenCalled()
})
```

Extend `test/unit/client/sdk-message-handler.test.ts` so the snapshot payload assertion includes `timelineSessionId`, `revision`, `streamingActive`, and `streamingText`.

- [ ] **Step 2: Run the focused client tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts
```

Expected: FAIL because the API client does not send `includeBodies`, the thunk always fetches the newest turn again, and the reducer drops the richer snapshot fields.

- [ ] **Step 3: Write the minimal implementation**

Update `src/lib/api.ts`:

```ts
export async function getAgentTimelinePage(sessionId: string, query: AgentTimelinePageQuery = {}, options: ApiRequestOptions = {}) {
  const parsed = AgentTimelinePageQuerySchema.parse(query)
  return api.get(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/timeline${buildQueryString([
      ['cursor', parsed.cursor],
      ['priority', parsed.priority],
      ['limit', parsed.limit],
      ['includeBodies', parsed.includeBodies ? 'true' : undefined],
    ])}`,
    options,
  )
}
```

Update `src/store/agentChatTypes.ts` and `src/store/agentChatSlice.ts`:

```ts
timelineSessionId?: string
timelineRevision?: number

sessionSnapshotReceived(state, action) {
  const session = ensureSession(state, action.payload.sessionId)
  session.latestTurnId = action.payload.latestTurnId
  session.status = action.payload.status
  session.timelineSessionId = action.payload.timelineSessionId
  session.timelineRevision = action.payload.revision
  session.streamingActive = action.payload.streamingActive ?? false
  session.streamingText = action.payload.streamingText ?? ''
  if (action.payload.latestTurnId === null) {
    session.historyLoaded = true
  }
}

timelinePageReceived(state, action) {
  const session = ensureSession(state, action.payload.sessionId)
  session.timelineItems = action.payload.replace === false
    ? [...session.timelineItems, ...action.payload.items]
    : action.payload.items
  session.timelineBodies = action.payload.replace === false
    ? { ...session.timelineBodies, ...(action.payload.bodies ?? {}) }
    : { ...(action.payload.bodies ?? {}) }
  session.timelineRevision = action.payload.revision
  session.historyLoaded = true
}
```

Update `src/store/agentChatThunks.ts` so the first visible page uses inline bodies and only falls back to `getAgentTurnBody()` when the page did not already include the newest body.

Update `src/lib/sdk-message-handler.ts` to forward the richer snapshot payload unchanged.

- [ ] **Step 4: Run the focused client tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Tighten the reducer so replace-mode page hydration does not accidentally retain stale inline bodies from a previous session snapshot.

Re-run:

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/lib/sdk-message-handler.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts
git commit -m "fix: hydrate freshclaude restore state from canonical snapshots"
```

### Task 4: Complete The Visible Restore Flow

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Create: `test/e2e/agent-chat-restore-flow.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Extend `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx` with the user-visible cases the current code misses:

```tsx
it('uses timelineSessionId from sdk.session.snapshot for visible restore hydration', async () => {
  store.dispatch(sessionSnapshotReceived({
    sessionId: 'sdk-sess-1',
    latestTurnId: 'turn-2',
    status: 'idle',
    timelineSessionId: 'cli-sess-1',
    revision: 2,
  }))

  render(
    <Provider store={store}>
      <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-1' }} />
    </Provider>,
  )

  await waitFor(() => {
    expect(getAgentTimelinePage).toHaveBeenCalledWith(
      'cli-sess-1',
      expect.objectContaining({ includeBodies: true }),
      expect.anything(),
    )
  })
})

it('shows a restored partial assistant stream after reconnect', () => {
  store.dispatch(sessionSnapshotReceived({
    sessionId: 'sdk-sess-1',
    latestTurnId: 'turn-2',
    status: 'running',
    timelineSessionId: 'cli-sess-1',
    streamingActive: true,
    streamingText: 'partial reply',
  }))

  render(
    <Provider store={store}>
      <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-1' }} />
    </Provider>,
  )
  expect(screen.getByText('partial reply')).toBeInTheDocument()
})
```

Extend `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx` so a remount restore with page bodies inline shows the restored body immediately and never calls `getAgentTurnBody()` for the newest item.

Create `test/e2e/agent-chat-restore-flow.test.tsx` as the real visible-flow harness:

```tsx
it('restores a live session with inline bodies and canonical timeline identity', async () => {
  // 1. Render a pane with persisted sdk session id.
  // 2. Deliver sdk.session.snapshot through handleSdkMessage() with timelineSessionId + running state.
  // 3. Mock getAgentTimelinePage() to return page bodies inline.
  // 4. Assert the restored first page is fully visible without a follow-up newest-turn fetch.
})
```

- [ ] **Step 2: Run the focused UI tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: FAIL because `AgentChatView` still guesses the timeline identity, still expects a separate newest-turn fetch, and does not render a restored partial stream.

- [ ] **Step 3: Write the minimal implementation**

Update `src/components/agent-chat/AgentChatView.tsx`:

```ts
const timelineSessionId = session?.timelineSessionId
  ?? paneContent.resumeSessionId
  ?? session?.cliSessionId
  ?? paneContent.sessionId
```

Keep the visible-first load gate, but rely on the thunk to request inline bodies on the first page. The component should not manually assume the newest turn still needs a second request.

Preserve the existing restored-stream rendering path by letting the richer snapshot seed `session.streamingActive` and `session.streamingText`.

Do not clear restore mode until one of these is true:

- `latestTurnId === null`
- the first timeline page landed
- the pane recovered through the existing stale-session timeout path

- [ ] **Step 4: Run the focused UI tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run the targeted client/server regressions, then the coordinated broad suite:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/sdk-bridge.test.ts
npm run test:integration -- --run test/integration/server/agent-timeline-router.test.ts
npm run lint
FRESHELL_TEST_SUMMARY="freshclaude restore audit" npm run check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
git commit -m "fix: complete freshclaude visible restore flow"
```

### Task 5: Canonical Identity For Metadata And Activity

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/lib/pane-activity.ts`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/lib/pane-activity.test.ts`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Extend `test/unit/client/components/panes/PaneContainer.test.tsx` with a restore-gap case:

```tsx
it('uses timelineSessionId for FreshClaude runtime metadata before sdk.session.init arrives', () => {
  const node: PaneNode = {
    type: 'leaf',
    id: 'pane-fresh',
    content: {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-fresh',
      sessionId: 'sdk-session-1',
      status: 'idle',
    },
  }

  const store = createStore(
    {
      layouts: { 'tab-1': node },
      activePane: { 'tab-1': 'pane-fresh' },
    },
    {},
    {
      projects: [
        {
          projectPath: '/home/user/code/freshell',
          sessions: [
            makeClaudeIndexedSession({ sessionId: 'claude-session-1', sessionType: 'freshclaude' }),
          ],
        },
      ],
    },
    {
      sessions: {
        'sdk-session-1': {
          sessionId: 'sdk-session-1',
          timelineSessionId: 'claude-session-1',
          status: 'idle',
          messages: [],
          timelineItems: [],
          timelineBodies: {},
          streamingText: '',
          streamingActive: false,
          pendingPermissions: {},
          pendingQuestions: {},
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
      },
      pendingCreates: {},
      availableModels: [],
    },
  )

  renderWithStore(store, node)
  expect(screen.getByText(/25%/)).toBeInTheDocument()
})
```

Extend `test/unit/client/lib/pane-activity.test.ts` with:

```ts
it('collects FreshClaude busy session keys from timelineSessionId during restore gaps', () => {
  const busySessionKeys = collectBusySessionKeys({
    tabs: [
      {
        id: 'tab-fresh',
        title: 'Fresh',
        createRequestId: 'req-fresh',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        createdAt: 1,
      },
    ],
    paneLayouts: {
      'tab-fresh': {
        type: 'leaf',
        id: 'pane-fresh',
        content: {
          kind: 'agent-chat',
          provider: 'freshclaude',
          createRequestId: 'req-fresh',
          sessionId: 'sdk-1',
          status: 'running',
        },
      },
    },
    codexActivityByTerminalId: {},
    paneRuntimeActivityByPaneId: {},
    agentChatSessions: {
      'sdk-1': {
        sessionId: 'sdk-1',
        timelineSessionId: 'claude-session-1',
        status: 'running',
        messages: [],
        timelineItems: [],
        timelineBodies: {},
        streamingText: '',
        streamingActive: true,
        pendingPermissions: {},
        pendingQuestions: {},
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    },
  })

  expect(busySessionKeys).toEqual(['claude:claude-session-1'])
})
```

Extend `test/e2e/pane-header-runtime-meta-flow.test.tsx` so the restored FreshClaude header path still resolves indexed Claude metadata when the restored Redux session has `timelineSessionId: 'claude-session-1'` but no `cliSessionId` and the pane content has no `resumeSessionId`.

- [ ] **Step 2: Run the focused metadata/activity tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/pane-activity.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: FAIL because restored FreshClaude metadata and busy-session projections still depend on `cliSessionId` or persisted `resumeSessionId`, not the canonical timeline identity.

- [ ] **Step 3: Write the minimal implementation**

Update `src/components/panes/PaneContainer.tsx`:

```ts
const indexedSessionId = session?.timelineSessionId
  ?? session?.cliSessionId
  ?? content.resumeSessionId
```

Update `src/lib/pane-activity.ts`:

```ts
const sessionId = session?.timelineSessionId
  ?? session?.cliSessionId
  ?? content.resumeSessionId
```

Keep `timelineSessionId` as the preferred restored identity only for FreshClaude/Claude-index lookups. Do not change Codex exact-match semantics or terminal session-key rules.

- [ ] **Step 4: Run the focused metadata/activity tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/pane-activity.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run the restore regressions that now share canonical identity:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/pane-activity.test.ts test/e2e/agent-chat-restore-flow.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/sdk-bridge.test.ts
npm run test:integration -- --run test/integration/server/agent-timeline-router.test.ts
npm run lint
FRESHELL_TEST_SUMMARY="freshclaude restore audit" npm run check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/lib/pane-activity.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/pane-activity.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "fix: restore freshclaude metadata from canonical timeline identity"
```

## Notes For Execution

- Preserve the existing `historyLoaded` contract. The new snapshot fields enrich restore; they do not change the rule that a resumed session stays in restore mode until durable or canonical history is known.
- Once `timelineSessionId` exists in Redux, every FreshClaude consumer that needs the durable Claude identity must prefer it over `cliSessionId` and persisted `resumeSessionId`. Do not leave per-component precedence rules drifting apart.
- When histories diverge, log the conflict with enough detail to diagnose the source (`sdk session id`, `timeline session id`, live count, durable count). Do not try to weave mismatched lists together.
- Keep the existing session-lost recovery path intact. This plan improves restore completeness, but it does not change the stale-session recovery model already covered by `sdk.error` with `INVALID_SESSION_ID`.
- If any broader suite fails outside this feature area, stop and fix the failure before merging. The repo rules for main-branch safety still apply.
