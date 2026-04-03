# FreshClaude Restore Audit And Completeness Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use @trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FreshClaude restore complete and deterministic across reloads, remounts, reconnects, and server restarts by restoring one canonical history, preserving the durable Claude identity as soon as the server knows it, and rendering the first visible restored page with full bodies and in-progress stream state.

**Architecture:** Introduce a shared server-side agent history source that understands two live-history modes: full live transcript for fresh SDK sessions and post-resume delta for resumed SDK sessions. That source merges durable Claude JSONL history with live delta, exposes an optional canonical durable `timelineSessionId`, and feeds both HTTP timeline reads and WebSocket restore snapshots. The client stores those richer snapshots, requests `includeBodies=true` for the first visible timeline page, persists the canonical durable ID back into pane content before `sdk.session.init` arrives, and updates FreshClaude metadata/activity consumers to prefer that identity during restore gaps.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket (`ws`), Anthropic Claude Agent SDK, Vitest, Testing Library

---

## Restore Contract

- A resumed FreshClaude session has two distinct history sources:
  - durable Claude JSONL history for the backlog that existed before this bridge process started
  - in-memory SDK messages for work observed after this bridge process started
- For resumed sessions, `SdkSessionState.messages` is a post-resume delta, not a full transcript. Do not choose between durable and live history by message count alone.
- `timelineSessionId` means the canonical durable Claude session ID. It is optional. Never populate it with an SDK session ID.
- When `timelineSessionId` exists, every FreshClaude restore consumer that needs the durable Claude identity must prefer it over `cliSessionId` and persisted `resumeSessionId`.
- As soon as `sdk.session.snapshot` carries `timelineSessionId`, persist that value back into pane content as `resumeSessionId` so later recovery does not depend on `sdk.session.init` arriving first.
- The first visible restore page must arrive with bodies inline. The client may still fetch older collapsed turns on demand, but it must not immediately double-fetch the newest turn if the page already contains it.
- Hidden panes should remain cheap: attach for ownership/status, but defer the visible-history fetch until visible.
- Server-restart recovery must still work: once a snapshot revealed the durable Claude ID, a later lost-session recovery must be able to re-create the session with that durable ID even if `sdk.session.init` never happened.
- Mid-stream reconnects must restore enough state to show work in progress. A restored running pane cannot regress to a blank "Running..." state with no visible partial output.
- Divergent live-vs-durable histories are a real boundary. Log them with enough context to diagnose the source (`sdk session id`, `timeline session id`, live mode, live count, durable count). Do not silently weave contradictory middles together.

## File Structure

- Create: `server/agent-timeline/history-source.ts`
  Responsibility: canonical restore-history resolution, resumed-delta merge rules, divergence logging, and durable timeline identity discovery.
- Modify: `server/agent-timeline/service.ts`
  Responsibility: build timeline pages and turn bodies from the shared history source, returning the canonical timeline session ID when known.
- Modify: `server/index.ts`
  Responsibility: instantiate the shared history source once and wire it into both HTTP timeline reads and WebSocket restore flows.
- Modify: `server/sdk-bridge-types.ts`
  Responsibility: extend in-memory SDK session state with reconnect-restorable stream snapshot fields.
- Modify: `server/sdk-bridge.ts`
  Responsibility: track stream snapshot state and expose lookup by durable Claude session ID.
- Modify: `server/ws-handler.ts`
  Responsibility: send authoritative `sdk.session.snapshot` payloads from the shared history source for `sdk.create` and `sdk.attach`, without falling back to the legacy raw loader seam.
- Modify: `shared/ws-protocol.ts`
  Responsibility: define the richer `sdk.session.snapshot` server-to-client contract.
- Modify: `src/lib/api.ts`
  Responsibility: send `includeBodies=true` on the first visible timeline page request.
- Modify: `src/store/agentChatTypes.ts`
  Responsibility: model canonical durable timeline identity and timeline revision in Redux.
- Modify: `src/store/agentChatSlice.ts`
  Responsibility: store richer snapshot fields, accept inline page bodies, and clear stale replace-mode bodies correctly.
- Modify: `src/store/agentChatThunks.ts`
  Responsibility: request inline bodies for the first visible page and skip the redundant newest-turn fetch when the body already arrived.
- Modify: `src/lib/sdk-message-handler.ts`
  Responsibility: forward richer snapshot payloads into Redux unchanged.
- Modify: `src/components/agent-chat/AgentChatView.tsx`
  Responsibility: use the canonical timeline identity for restore fetches, persist it back into pane content before `sdk.session.init`, and render restored partial streams.
- Modify: `src/components/panes/PaneContainer.tsx`
  Responsibility: resolve FreshClaude runtime metadata from the canonical timeline identity during restore gaps.
- Modify: `src/lib/pane-activity.ts`
  Responsibility: derive FreshClaude busy-session keys from the canonical timeline identity during restore gaps.
- Create: `test/unit/server/agent-timeline-history-source.test.ts`
  Responsibility: pin resumed-delta merge rules, overlap de-duplication, durable-only fallback, and divergence handling.
- Modify: `test/unit/server/agent-timeline/service.test.ts`
  Responsibility: verify the timeline service pages and turn bodies come from the shared history source and surface the canonical timeline session ID.
- Modify: `test/unit/server/agent-timeline-include-bodies.test.ts`
  Responsibility: verify inline bodies still work through the canonical history source.
- Modify: `test/integration/server/agent-timeline-router.test.ts`
  Responsibility: verify route-level `includeBodies` pass-through remains intact.
- Modify: `test/unit/server/sdk-bridge.test.ts`
  Responsibility: verify reconnect-restorable stream snapshot state is tracked in memory.
- Modify: `test/unit/server/sdk-bridge-types.test.ts`
  Responsibility: keep the `SdkSessionState` type tests aligned with the richer stream snapshot fields.
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
  Responsibility: verify snapshot ordering and contents for fresh create, resumed create, live attach, durable-only attach, and mid-stream restore.
- Modify: `test/unit/server/ws-sdk-session-history-cache.test.ts`
  Responsibility: verify `WsHandler` now depends on the shared history source seam instead of the legacy raw loader seam.
- Modify: `test/unit/client/agentChatSlice.test.ts`
  Responsibility: verify richer snapshot fields and inline-body reducer semantics.
- Modify: `test/unit/client/store/agentChatThunks.test.ts`
  Responsibility: verify the first visible page uses `includeBodies=true` and avoids the redundant newest-turn fetch.
- Modify: `test/unit/client/sdk-message-handler.test.ts`
  Responsibility: verify richer snapshot payloads reach Redux intact.
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
  Responsibility: verify visible restore uses `timelineSessionId`, persists it back into pane content, and renders restored partial streams.
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
  Responsibility: verify remount restore stays complete with inline bodies and still lazy-loads older collapsed turns.
- Modify: `test/e2e/agent-chat-resume-history-flow.test.tsx`
  Responsibility: update the existing resumed-create end-to-end flow to the inline-body contract and canonical timeline identity.
- Create: `test/e2e/agent-chat-restore-flow.test.tsx`
  Responsibility: pin the reload/attach restore path from `sdk.session.snapshot` through visible timeline hydration and `resumeSessionId` persistence.
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
  Responsibility: verify restored FreshClaude runtime metadata uses `timelineSessionId` before `cliSessionId` exists and over stale persisted resume IDs.
- Modify: `test/unit/client/lib/pane-activity.test.ts`
  Responsibility: verify FreshClaude busy-session keys prefer `timelineSessionId` during restore gaps.
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
  Responsibility: verify pane header metadata restores from `timelineSessionId` when only the canonical durable ID is known.

## Strategy Gate

- Do not patch only `AgentChatView.tsx`. The visible symptom is in the component, but the underlying defect is that WebSocket restore and HTTP timeline reads do not use the same history model.
- Do not treat live SDK messages as a full transcript for resumed sessions. In this codebase they are only the post-resume delta, so a count comparison or "prefer longer list" rule is wrong.
- Do not populate `timelineSessionId` with SDK session IDs. That would make metadata/activity consumers and later recovery persist the wrong identity.
- Do not fix the restore fetch and leave `resumeSessionId` persistence untouched. If the canonical durable ID is not written back into pane content before `sdk.session.init`, later server-restart recovery can still regress.
- Do not add a second client-side heuristic for "which session ID should I trust". The server already knows whether live session state is fresh, resumed-delta, or durable-only.
- Keep the visible-first behavior. Hidden panes still defer the heavier history read until visible, but the first visible fetch must be complete.

### Task 1: Canonical Server History Source

**Files:**
- Create: `server/agent-timeline/history-source.ts`
- Modify: `server/agent-timeline/service.ts`
- Modify: `server/index.ts`
- Create: `test/unit/server/agent-timeline-history-source.test.ts`
- Modify: `test/unit/server/agent-timeline/service.test.ts`
- Modify: `test/unit/server/agent-timeline-include-bodies.test.ts`
- Modify: `test/integration/server/agent-timeline-router.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Create `test/unit/server/agent-timeline-history-source.test.ts` with the cases that the current plan missed:

```ts
it('appends live post-resume delta onto durable backlog', async () => {
  const source = createAgentHistorySource({
    loadSessionHistory: vi.fn().mockResolvedValue([
      makeMessage('user', 'older question'),
      makeMessage('assistant', 'older answer'),
    ]),
    getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
      sessionId: 'sdk-1',
      resumeSessionId: 'cli-1',
      messages: [
        makeMessage('user', 'new prompt'),
        makeMessage('assistant', 'new reply'),
      ],
    })),
    getLiveSessionByCliSessionId: vi.fn(),
    logDivergence: vi.fn(),
  })

  const resolved = await source.resolve('sdk-1')

  expect(resolved?.timelineSessionId).toBe('cli-1')
  expect(resolved?.messages).toEqual([
    makeMessage('user', 'older question'),
    makeMessage('assistant', 'older answer'),
    makeMessage('user', 'new prompt'),
    makeMessage('assistant', 'new reply'),
  ])
})

it('de-duplicates the overlap when durable history has already flushed the first live delta turn', async () => {
  const source = createAgentHistorySource({
    loadSessionHistory: vi.fn().mockResolvedValue([
      makeMessage('user', 'older question'),
      makeMessage('assistant', 'older answer'),
      makeMessage('user', 'new prompt'),
    ]),
    getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
      sessionId: 'sdk-2',
      resumeSessionId: 'cli-2',
      messages: [
        makeMessage('user', 'new prompt'),
        makeMessage('assistant', 'new reply'),
      ],
    })),
    getLiveSessionByCliSessionId: vi.fn(),
    logDivergence: vi.fn(),
  })

  const resolved = await source.resolve('sdk-2')
  expect(resolved?.messages).toEqual([
    makeMessage('user', 'older question'),
    makeMessage('assistant', 'older answer'),
    makeMessage('user', 'new prompt'),
    makeMessage('assistant', 'new reply'),
  ])
})

it('prefers the live full transcript when a fresh session has outrun durable JSONL', async () => {
  const source = createAgentHistorySource({
    loadSessionHistory: vi.fn().mockResolvedValue([
      makeMessage('user', 'prompt'),
    ]),
    getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
      sessionId: 'sdk-3',
      cliSessionId: 'cli-3',
      messages: [
        makeMessage('user', 'prompt'),
        makeMessage('assistant', 'reply'),
      ],
    })),
    getLiveSessionByCliSessionId: vi.fn(),
    logDivergence: vi.fn(),
  })

  const resolved = await source.resolve('sdk-3')
  expect(resolved?.timelineSessionId).toBe('cli-3')
  expect(resolved?.messages).toEqual([
    makeMessage('user', 'prompt'),
    makeMessage('assistant', 'reply'),
  ])
})

it('returns durable-only history after restart when no live session exists', async () => {
  const source = createAgentHistorySource({
    loadSessionHistory: vi.fn().mockResolvedValue([
      makeMessage('user', 'persisted'),
      makeMessage('assistant', 'persisted reply'),
    ]),
    getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(undefined),
    getLiveSessionByCliSessionId: vi.fn().mockReturnValue(undefined),
    logDivergence: vi.fn(),
  })

  const resolved = await source.resolve('00000000-0000-4000-8000-000000000123')
  expect(resolved?.timelineSessionId).toBe('00000000-0000-4000-8000-000000000123')
  expect(resolved?.messages).toHaveLength(2)
})
```

Extend `test/unit/server/agent-timeline/service.test.ts` so a query by SDK session ID returns `page.sessionId === 'cli-1'` and `getTurnBody()` also returns `sessionId === 'cli-1'` when the shared history source resolved a canonical durable session ID.

Extend `test/unit/server/agent-timeline-include-bodies.test.ts` so the bodies map comes from the canonical history source and uses the canonical timeline session ID on the returned turn bodies.

Extend `test/integration/server/agent-timeline-router.test.ts` with the route pass-through assertion the executor still needs:

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

Expected:

- `test/unit/server/agent-timeline-history-source.test.ts` fails because the module does not exist yet.
- The service tests fail because `createAgentTimelineService()` still reads raw JSONL directly and cannot surface canonical timeline IDs.
- The include-bodies tests fail because the bodies still use the query session ID instead of the canonical history session ID.

- [ ] **Step 3: Write the minimal implementation**

Create `server/agent-timeline/history-source.ts` with one explicit contract:

```ts
export type ResolvedAgentHistory = {
  liveSessionId?: string
  timelineSessionId?: string
  messages: ChatMessage[]
  revision: number
}

export function createAgentHistorySource(deps: {
  loadSessionHistory: (sessionId: string) => Promise<ChatMessage[] | null>
  getLiveSessionBySdkSessionId: (sdkSessionId: string) => SdkSessionState | undefined
  getLiveSessionByCliSessionId: (timelineSessionId: string) => SdkSessionState | undefined
  logDivergence?: (details: {
    queryId: string
    sdkSessionId?: string
    timelineSessionId?: string
    liveMode: 'full' | 'delta'
    liveCount: number
    durableCount: number
  }) => void
}) {
  return {
    async resolve(queryId: string): Promise<ResolvedAgentHistory | null> {
      // 1. Resolve the live session by SDK id or canonical durable id.
      // 2. Resolve timelineSessionId only when a durable Claude id is known:
      //    live.cliSessionId ?? live.resumeSessionId ?? (isValidClaudeSessionId(queryId) ? queryId : undefined)
      // 3. Load durable history once when timelineSessionId exists.
      // 4. If the live session was created with resumeSessionId, treat live messages as post-resume delta:
      //    append them onto durable history after removing the longest durable-tail/live-head overlap.
      // 5. Otherwise treat live messages as a full transcript for this process:
      //    prefer the full live list when durable is a strict prefix,
      //    prefer durable when live is a strict prefix,
      //    and log divergence before preferring live on true conflict.
      // 6. Compute revision from the merged list and return the optional timelineSessionId.
    },
  }
}
```

Keep the message-equality helper deterministic:

- compare `role`
- compare normalized content block payloads
- compare `model` when present
- do not use timestamp equality as the merge key

Update `server/agent-timeline/service.ts` so it accepts the shared history source instead of `loadSessionHistory` directly, and uses `resolved.timelineSessionId ?? query.sessionId` for:

- `page.sessionId`
- `item.sessionId`
- `bodies[turnId].sessionId`
- `getTurnBody().sessionId`

Keep the existing cursor shape unchanged.

Wire the shared source once in `server/index.ts` and pass it into `createAgentTimelineService(...)`.

- [ ] **Step 4: Run the focused server tests to verify they pass**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/agent-timeline/service.test.ts test/unit/server/agent-timeline-include-bodies.test.ts
npm run test:integration -- --run test/integration/server/agent-timeline-router.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Refactor the merge helper so the resumed-delta path and the fresh-live path are explicit, not hidden behind one "choose longer list" heuristic.

Re-run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/agent-timeline/service.test.ts test/unit/server/agent-timeline-include-bodies.test.ts
npm run test:integration -- --run test/integration/server/agent-timeline-router.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/agent-timeline/history-source.ts server/agent-timeline/service.ts server/index.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/agent-timeline/service.test.ts test/unit/server/agent-timeline-include-bodies.test.ts test/integration/server/agent-timeline-router.test.ts
git commit -m "fix: canonicalize freshclaude restore history resolution"
```

### Task 2: Enrich SDK Restore Snapshots

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Modify: `test/unit/server/sdk-bridge.test.ts`
- Modify: `test/unit/server/sdk-bridge-types.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/unit/server/ws-sdk-session-history-cache.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Extend `test/unit/server/sdk-bridge.test.ts` with reconnect-restorable stream-state coverage:

```ts
it('tracks stream snapshot state for reconnect restore', async () => {
  mockKeepStreamOpen = true
  mockMessages.push({
    type: 'stream_event',
    event: { type: 'content_block_start' },
    session_id: 'cli-123',
    uuid: 'uuid-1',
  })
  mockMessages.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'par' },
    },
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

Update `test/unit/server/sdk-bridge-types.test.ts` so any literal `SdkSessionState` used there includes the new required stream snapshot fields.

Extend `test/unit/server/ws-handler-sdk.test.ts` with:

```ts
it('sdk.attach snapshot includes canonical timelineSessionId, revision, and stream snapshot', async () => {
  mockSdkBridge.getSession.mockReturnValue({
    sessionId: 'sdk-sess-1',
    resumeSessionId: 'cli-sess-1',
    status: 'running',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'delta prompt' }], timestamp: '2026-03-10T10:02:00.000Z' }],
    streamingActive: true,
    streamingText: 'partial reply',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
  })
  mockHistorySource.resolve.mockResolvedValue({
    liveSessionId: 'sdk-sess-1',
    timelineSessionId: 'cli-sess-1',
    revision: 123,
    messages: [
      makeMessage('user', 'older prompt'),
      makeMessage('assistant', 'older reply'),
      makeMessage('user', 'delta prompt'),
    ],
  })

  // Expect sdk.session.snapshot to include timelineSessionId, revision,
  // streamingActive, and streamingText.
})
```

Update the resumed-create ordering test so the snapshot assertion includes:

```ts
expect(messages[1]).toEqual(expect.objectContaining({
  type: 'sdk.session.snapshot',
  sessionId: 'sdk-sess-1',
  timelineSessionId: durableSessionId,
  latestTurnId: 'turn-1',
}))
```

Update `test/unit/server/ws-sdk-session-history-cache.test.ts` so it verifies the injected seam is now the shared history source:

```ts
expect(injectedHistorySource.resolve).toHaveBeenCalledWith('resume-sess-1')
expect(moduleLoadSessionHistoryMock).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run the focused server tests to verify they fail**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts
```

Expected:

- the bridge tests fail because `SdkSessionState` does not yet track reconnect-restorable stream snapshot state
- the handler tests fail because `sdk.session.snapshot` does not yet include `timelineSessionId`, `revision`, or stream snapshot fields
- the DI test fails because `WsHandler` still uses the legacy raw loader seam instead of the shared history source

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

Initialize those fields in `server/sdk-bridge.ts` and update them from `stream_event`:

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

Also add one narrow lookup helper in `server/sdk-bridge.ts`:

```ts
findSessionByCliSessionId(timelineSessionId: string): SdkSessionState | undefined {
  for (const session of this.sessions.values()) {
    if (session.cliSessionId === timelineSessionId || session.resumeSessionId === timelineSessionId) {
      return session
    }
  }
  return undefined
}
```

Update `server/ws-handler.ts` so both `sdk.create` and `sdk.attach` build `sdk.session.snapshot` from the shared history source instead of hand-assembling `latestTurnId` from raw JSONL or `session.messages.length`.

Use one helper:

```ts
private async sendSdkSessionSnapshot(
  ws: LiveWebSocket,
  opts: { sessionId: string; status: SdkSessionStatus; historyQueryId: string; liveSession?: SdkSessionState },
) {
  const resolved = await this.agentHistorySource.resolve(opts.historyQueryId)
  this.send(ws, {
    type: 'sdk.session.snapshot',
    sessionId: opts.sessionId,
    latestTurnId: resolved && resolved.messages.length > 0 ? `turn-${resolved.messages.length - 1}` : null,
    status: opts.status,
    timelineSessionId: resolved?.timelineSessionId,
    revision: resolved?.revision,
    streamingActive: opts.liveSession?.streamingActive,
    streamingText: opts.liveSession?.streamingText,
  })
}
```

For `sdk.attach`:

- when a live SDK session exists, query the shared history source with the live SDK session ID
- when only a durable Claude session exists, query the shared history source with the durable Claude session ID and send an idle snapshot plus idle status
- when neither exists, continue sending `sdk.error` with `INVALID_SESSION_ID`

Keep the existing ordering invariant:

1. `sdk.created`
2. `sdk.session.snapshot`
3. `sdk.session.init`

- [ ] **Step 4: Run the focused server tests to verify they pass**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Remove the legacy raw `loadSessionHistory` branching from `server/ws-handler.ts` so the snapshot path is single-sourced through the shared history source.

Re-run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts test/unit/server/agent-timeline-history-source.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/ws-protocol.ts server/sdk-bridge-types.ts server/sdk-bridge.ts server/ws-handler.ts server/index.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts
git commit -m "fix: enrich freshclaude restore snapshots"
```

### Task 3: Client Snapshot And Timeline Store Contract

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
it('stores timelineSessionId, timelineRevision, and stream snapshot from sdk.session.snapshot', () => {
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
    timelineRevision: 12,
    streamingActive: true,
    streamingText: 'partial reply',
  })
})

it('hydrates inline page bodies and clears stale replace-mode bodies', () => {
  let state = agentChatReducer(initial, turnBodyReceived({
    sessionId: 'sdk-1',
    turnId: 'stale-turn',
    message: makeChatMessage('assistant', 'stale'),
  }))

  state = agentChatReducer(state, timelinePageReceived({
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
  expect(state.sessions['sdk-1'].timelineBodies['stale-turn']).toBeUndefined()
})
```

Extend `test/unit/client/store/agentChatThunks.test.ts`:

```ts
it('requests includeBodies on the first visible page and skips getAgentTurnBody when the newest body is inline', async () => {
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

Expected:

- the reducer tests fail because the snapshot fields and inline bodies are currently dropped
- the thunk test fails because the first visible page does not yet request `includeBodies=true` and still calls `getAgentTurnBody()` for the newest turn
- the message-handler test fails because it does not forward the richer snapshot payload

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
  session.nextTimelineCursor = action.payload.nextCursor
  session.timelineLoading = false
  session.timelineError = undefined
  session.historyLoaded = true
}
```

Update `src/store/agentChatThunks.ts`:

- send `includeBodies: true` only on the first visible page (`!cursor`)
- dispatch `timelinePageReceived()` with `bodies: page.bodies`
- only call `getAgentTurnBody()` when `page.items[0]` exists and `page.bodies?.[page.items[0].turnId]` is missing

Update `src/lib/sdk-message-handler.ts` to forward the richer snapshot payload unchanged.

- [ ] **Step 4: Run the focused client tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Keep the reducer rules explicit:

- replace-mode page hydration clears stale bodies
- append-mode page hydration preserves already-expanded bodies
- snapshot stream state seeds the reconnect UI without interfering with normal `sdk.stream` updates

Re-run:

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts
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
- Modify: `test/e2e/agent-chat-resume-history-flow.test.tsx`
- Create: `test/e2e/agent-chat-restore-flow.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Extend `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx` with the cases the old plan still missed:

```tsx
it('uses timelineSessionId from sdk.session.snapshot for visible restore hydration', async () => {
  getAgentTimelinePage.mockResolvedValue({ sessionId: 'cli-sess-1', items: [], nextCursor: null, revision: 1 })

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

it('persists timelineSessionId into pane content before sdk.session.init arrives', () => {
  const pane = { kind: 'agent-chat', provider: 'freshclaude', createRequestId: 'req-1', sessionId: 'sdk-sess-1', status: 'starting' } satisfies AgentChatPaneContent
  store.dispatch(initLayout({ tabId: 't1', paneId: 'p1', content: pane }))

  render(
    <Provider store={store}>
      <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
    </Provider>,
  )

  act(() => {
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: 'cli-session-abc-123',
      revision: 2,
    }))
  })

  expect(getPaneContent(store, 't1', 'p1')?.resumeSessionId).toBe('cli-session-abc-123')
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

Extend `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx` so the remount restore path asserts:

- the first visible page is requested with `includeBodies: true`
- the newest restored turn renders immediately from inline bodies
- `getAgentTurnBody()` is still used when the user expands an older collapsed turn

Update `test/e2e/agent-chat-resume-history-flow.test.tsx` so the resumed-create path expects:

- `sdk.session.snapshot` to include `timelineSessionId`
- the first visible page request to include `includeBodies: true`
- no immediate `getAgentTurnBody()` call for the newest turn when the body was inline

Create `test/e2e/agent-chat-restore-flow.test.tsx` as the reload/attach harness:

```tsx
it('restores a reloaded pane from sdk.session.snapshot, persists timelineSessionId, and shows the first page without a newest-turn refetch', async () => {
  // 1. Render a pane with persisted sdk session id but no resumeSessionId.
  // 2. Deliver sdk.session.snapshot with timelineSessionId + latestTurnId + optional stream snapshot.
  // 3. Mock getAgentTimelinePage() to return inline bodies.
  // 4. Assert resumeSessionId is written back into pane content.
  // 5. Assert the restored first page is visible and getAgentTurnBody() was not called.
})
```

- [ ] **Step 2: Run the focused UI and e2e tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
```

Expected:

- the reload tests fail because `AgentChatView` still prefers persisted `resumeSessionId` over `session.timelineSessionId`
- the persistence test fails because the canonical durable ID is not yet written back into pane content before `sdk.session.init`
- the e2e resumed-create test fails because the old path still expects a second newest-turn fetch

- [ ] **Step 3: Write the minimal implementation**

Update `src/components/agent-chat/AgentChatView.tsx`:

```ts
const timelineSessionId = session?.timelineSessionId
  ?? session?.cliSessionId
  ?? paneContent.resumeSessionId

useEffect(() => {
  const durableId = session?.timelineSessionId ?? session?.cliSessionId
  if (!durableId) return
  if (paneContentRef.current.resumeSessionId === durableId) return
  dispatch(mergePaneContent({
    tabId,
    paneId,
    updates: { resumeSessionId: durableId },
  }))
}, [session?.timelineSessionId, session?.cliSessionId, tabId, paneId, dispatch])
```

Keep the visible-first load gate, but rely on the thunk to request inline bodies on the first page. The component must not assume it still needs a separate newest-turn fetch.

Preserve the existing restored-stream rendering path by letting the richer snapshot seed `session.streamingActive` and `session.streamingText`.

Do not clear restore mode until one of these is true:

- `latestTurnId === null`
- the first timeline page landed
- the pane recovered through the existing stale-session timeout path

- [ ] **Step 4: Run the focused UI and e2e tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Re-run the targeted restore regressions:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
git commit -m "fix: complete freshclaude visible restore flow"
```

### Task 5: Canonical Identity For Metadata, Activity, And Final Verification

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/lib/pane-activity.ts`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/lib/pane-activity.test.ts`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Extend `test/unit/client/components/panes/PaneContainer.test.tsx` with the restore-gap cases the executor still needs to pin:

```tsx
it('uses timelineSessionId for FreshClaude runtime metadata before sdk.session.init arrives', () => {
  // store session has timelineSessionId but no cliSessionId and pane content has no resumeSessionId
  // expect the indexed FreshClaude metadata to render immediately
})

it('prefers timelineSessionId over a stale persisted resumeSessionId', () => {
  // pane content resumeSessionId points at stale metadata
  // redux session.timelineSessionId points at the correct indexed Claude session
  // expect the correct metadata to render and the stale one to stay hidden
})
```

Extend `test/unit/client/lib/pane-activity.test.ts` with:

```ts
it('collects FreshClaude busy session keys from timelineSessionId during restore gaps', () => {
  const busySessionKeys = collectBusySessionKeys({
    tabs: [/* freshclaude tab */],
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

Extend `test/e2e/pane-header-runtime-meta-flow.test.tsx` so the restored FreshClaude header path still resolves indexed Claude metadata when the Redux session has `timelineSessionId: 'claude-session-1'`, no `cliSessionId`, and the pane content has no `resumeSessionId`.

- [ ] **Step 2: Run the focused metadata/activity tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/pane-activity.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected:

- the FreshClaude metadata tests fail because runtime metadata still depends on `cliSessionId` or persisted `resumeSessionId`
- the pane-activity test fails because busy-session keys still ignore `timelineSessionId`

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

Keep this identity preference scoped to FreshClaude/Claude-index lookups. Do not change Codex exact-match semantics or terminal session-key rules.

- [ ] **Step 4: Run the focused metadata/activity tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/pane-activity.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run the restore regressions that now share canonical identity, then the coordinated broad suite:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts
npm run test:integration -- --run test/integration/server/agent-timeline-router.test.ts
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/pane-activity.test.ts test/e2e/agent-chat-resume-history-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
npm run lint
npm run test:status
FRESHELL_TEST_SUMMARY="freshclaude restore audit" npm run check
```

Expected:

- all targeted server tests PASS
- all targeted client/e2e tests PASS
- `npm run lint` PASS
- `npm run check` PASS after the coordinated test gate is available

- [ ] **Step 6: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/lib/pane-activity.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/pane-activity.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "fix: restore freshclaude metadata from canonical timeline identity"
```

## Notes For Execution

- `timelineSessionId` is the durable Claude session ID only. If the server only knows an SDK session ID, leave `timelineSessionId` undefined and keep using the existing fallback path for live-only fetches.
- Resumed-session live messages are post-resume delta. Never regress this plan back to "choose the longer list" or "prefer live on any mismatch" logic.
- The key recovery guarantee is: once any snapshot exposes the durable Claude ID, it must be written back into `paneContent.resumeSessionId` before `sdk.session.init` arrives.
- No extra `session-utils` or sidebar identity plumbing is planned here. Task 4's immediate `resumeSessionId` persistence keeps pane-content-only consumers aligned without introducing a parallel client-side identity system.
- If any broader suite fails outside this feature area, stop and fix the failure before merging. The repo rules for main-branch safety still apply.
