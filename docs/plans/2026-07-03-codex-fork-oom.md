# Codex Fork OOM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal Codex `/fork` memory-safe in Freshell by preventing giant fork history payloads from being requested or fully parsed by the server proxy.

**Architecture:** Keep the fix in `CodexRemoteProxy`, the terminal Codex WebSocket proxy that sits between the Codex TUI and the Codex app-server. Rewrite terminal `thread/fork` requests so upstream always sees `params.excludeTurns: true`, preserve frame forwarding, and replace full upstream JSON parsing with full-frame top-level JSON-RPC envelope scanning plus bounded parsing only for proxy-owned side effects.

**Tech Stack:** Node.js 22, TypeScript/ESM, `ws`, Zod schemas in `server/coding-cli/codex-app-server/protocol.ts`, Vitest through `npm run test:vitest`.

---

## Strategy Gate

The OOM path is not a general UI problem. It is a terminal Codex proxy problem:

- `server/coding-cli/codex-app-server/remote-proxy.ts` currently calls `parseJson(raw)`, which does `JSON.parse(raw.toString())`, for every upstream WebSocket message.
- Terminal `/fork` travels through that proxy as a JSON-RPC `thread/fork` request.
- `server/coding-cli/codex-app-server/protocol.ts` already models `CodexThreadForkParamsSchema.excludeTurns`.
- The fresh-agent Codex path already calls `runtime.forkThread(..., excludeTurns: true)` in `server/fresh-agent/adapters/codex/adapter.ts`, and `test/unit/server/fresh-agent/codex-adapter.test.ts` asserts that behavior.

The previous plan relied on a 64 KiB prefix inspection idea. Do not implement that. It is not strong enough because a JSON-RPC response can legally put top-level `id` after `result`, and nested `result.thread.turns[*].id` fields can appear before the top-level response id. A prefix or regex scanner can corrupt `pendingMethods` by matching nested ids, or can fail to clear the correct pending method if the top-level id appears late.

The revised design uses these rules instead:

- Request path:
  - Do top-level envelope scanning first to learn `method` and `id` without full parse where possible.
  - Fully parse client requests only when needed and below a request parse cap.
  - For `thread/fork`, parse the request, force `params.excludeTurns = true`, then forward the rewritten text frame. If a `thread/fork` request is too large to parse safely or is not a JSON object, return a JSON-RPC error to the TUI using the scanned id when available and do not forward it upstream.
  - For normal non-fork requests, preserve current behavior for ordinary small frames. For oversized non-fork frames, forward raw if no proxy-owned behavior needs the parsed body; do not materialize huge request bodies just for logging.
- Response path:
  - Forward the original upstream frame to the TUI with the original text/binary flag.
  - Scan the full frame for only top-level JSON-RPC envelope fields (`id`, `method`) without constructing the full JSON object.
  - Use the scanned top-level `id` to read and clear `connection.pendingMethods`, even if `id` appears after a large `result`.
  - Only run `JSON.parse` for proxy-owned side-effect messages when the frame is under a strict parse cap.
  - If a side-effect-bearing upstream message is oversized, forward it and log a structured warning that the proxy skipped local side effects for an oversized frame. Do not parse it.

Compatibility stance:

- The local code proves `excludeTurns` is a known Freshell Codex app-server fork parameter and that fresh-agent Codex already depends on it.
- The local fake app-server does not implement `thread/fork`, so it cannot prove live terminal TUI behavior.
- Implementation must include proxy-level compatibility tests proving the rewritten request is accepted by a controlled upstream and the fork response reaches the TUI unchanged.
- If the executor has a real Codex app-server environment available, run the opt-in real-provider smoke/contract check after unit tests. If not, document that live TUI `/fork` verification is unavailable in that environment; do not block the memory-safety fix on unavailable external tooling.

No user decision is required. The user approved implementing the safer behavior, and this plan avoids relying on the unproven assumptions from the review.

## File Structure

- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
  - Add a `ProxyFrame` shape so held requests and forwarding preserve raw data plus the text/binary flag.
  - Add terminal `thread/fork` request rewriting with `excludeTurns: true`.
  - Add a request parse cap and an upstream side-effect parse cap.
  - Add a full-frame top-level JSON-RPC envelope scanner that does not inspect nested payload fields.
  - Use scanned envelope fields for `pendingMethods`, logging, and response attribution.
  - Parse only bounded proxy-owned upstream messages for candidate capture, turn completion, fs-change repair, and lifecycle events.

- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
  - Add regression coverage for forced terminal `thread/fork` `excludeTurns`.
  - Add regression coverage for rejecting an oversized `thread/fork` request instead of parsing or forwarding it.
  - Add regression coverage that a large `thread/fork` response is forwarded without passing the full payload to `JSON.parse`.
  - Add regression coverage that a top-level response id after a large `result` still clears the correct pending method.
  - Add regression coverage that nested `result.thread.turns[*].id` values are not mistaken for top-level JSON-RPC ids.
  - Keep existing candidate, turn notification, lifecycle, interrupt, and frame forwarding tests green.

- Do not modify: `server/fresh-agent/adapters/codex/adapter.ts`
  - Fresh-agent Codex already forks with `excludeTurns: true`; this is supporting evidence, not an implementation target.

- Do not modify: `docs/index.html`
  - This is a server-side reliability fix with no new user-facing UI.

## Contracts And Invariants

- Terminal `thread/fork` requests sent upstream must preserve original JSON-RPC fields and all params the TUI supplied, except `params.excludeTurns` is always `true`.
- If the TUI explicitly sends `excludeTurns: false`, the upstream request must still contain `excludeTurns: true`.
- If `params` is absent or not an object on a `thread/fork` request, Freshell must either forward an object with `excludeTurns: true` only when the request is otherwise parseable, or return a JSON-RPC error. Do not forward an unrewritten `thread/fork`.
- The proxy must not run full `JSON.parse` on large upstream frames such as a fork response containing `thread.turns`.
- The proxy must preserve text-vs-binary forwarding. Text frames must be sent with `{ binary: false }`; binary frames must be sent with `{ binary: true }`.
- `pendingMethods` must be keyed and cleared only by top-level JSON-RPC `id`, not nested `id` fields in `result` or `params`.
- A response whose top-level `id` appears after a large `result` must still clear the matching pending method.
- Candidate capture from small `thread/start` responses and `thread/started` notifications must still work.
- Turn started/completed, fs changed, and thread lifecycle side effects from small notifications must still work.
- Oversized side-effect-bearing messages must be forwarded even when local side effects are skipped; Freshell must not parse them just to preserve local side effects.
- Logs must remain structured and must never include full request or response bodies.

## Implementation Tasks

### Task 1: Prove And Implement Terminal Fork Request Rewriting

**Files:**
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`

- [ ] **Step 1: Add the failing fork rewrite test**

Add a test near the forwarding tests in `describe('CodexRemoteProxy', ...)`:

```ts
it('forces excludeTurns on terminal thread/fork requests before forwarding upstream', async () => {
  const upstream = await startUpstream((socket, message) => {
    if (message.method === 'thread/fork') {
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          thread: { id: 'thread-fork-1', path: '/tmp/codex/fork.jsonl', ephemeral: false },
          cwd: '/repo',
          model: 'gpt-5.3-codex',
          modelProvider: 'openai',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: 'danger-full-access',
        },
      }))
    }
  })
  const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
  const tui = await connect(proxy.wsUrl)

  tui.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 21,
    method: 'thread/fork',
    params: {
      threadId: 'thread-parent-1',
      cwd: '/repo',
      model: 'gpt-5.3-codex',
      excludeTurns: false,
    },
  }))

  await expect(nextResponseWithIdWithin(tui, 21, 100)).resolves.toMatchObject({
    id: 21,
    result: { thread: { id: 'thread-fork-1' } },
  })
  expect(upstream.messages).toEqual([
    {
      jsonrpc: '2.0',
      id: 21,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent-1',
        cwd: '/repo',
        model: 'gpt-5.3-codex',
        excludeTurns: true,
      },
    },
  ])
})
```

- [ ] **Step 2: Run the test to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "forces excludeTurns"
```

Expected: FAIL because the current proxy forwards `excludeTurns: false`.

- [ ] **Step 3: Implement the minimal rewrite**

In `server/coding-cli/codex-app-server/remote-proxy.ts`:

- Add `type ProxyFrame = { data: WebSocket.RawData | string; isBinary: boolean }`.
- Replace `framePayload` use for forwarding with `createFrame(raw, isBinary)`.
- Add `rewriteThreadForkRequest(parsed, raw, isBinary): ProxyFrame | undefined`.
- In `handleClientMessage`, when `method === 'thread/fork'`, forward only the rewritten text frame.

Implementation shape:

```ts
function rewriteThreadForkRequest(parsed: unknown, raw: WebSocket.RawData, isBinary: boolean): ProxyFrame | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const message = parsed as Record<string, unknown>
  if (message.method !== 'thread/fork') return createFrame(raw, isBinary)
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? { ...(message.params as Record<string, unknown>), excludeTurns: true }
    : { excludeTurns: true }
  return { data: JSON.stringify({ ...message, params }), isBinary: false }
}
```

Keep the implementation small in this task. The parser caps and scanner come next.

- [ ] **Step 4: Run the test to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "forces excludeTurns"
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify existing proxy tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: all tests in `remote-proxy.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: force codex fork requests to exclude turns"
```

### Task 2: Add Proxy Frame And Scanner Regression Tests

**Files:**
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`

- [ ] **Step 1: Add test helpers**

Add helpers near the existing `nextMessageFrame` helper:

```ts
async function waitForCondition(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await delay(5)
    }
  }
  if (lastError) throw lastError
  assertion()
}

function nextRawMessageFrame(socket: WebSocket): Promise<{ raw: WebSocket.RawData; isBinary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (raw, isBinary) => resolve({ raw, isBinary }))
  })
}
```

- [ ] **Step 2: Add the large fork response no-full-parse test**

```ts
it('forwards terminal thread/fork responses without full proxy-side JSON parsing', async () => {
  const upstream = await startUpstream()
  const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
  const tui = await connect(proxy.wsUrl)

  tui.send(JSON.stringify({
    id: 31,
    method: 'thread/fork',
    params: { threadId: 'thread-parent-1' },
  }))
  await waitForCondition(() => {
    expect(upstream.messages).toHaveLength(1)
  })

  const rawFrame = nextRawMessageFrame(tui)
  const parseSpy = vi.spyOn(JSON, 'parse')
  parseSpy.mockClear()
  const response = JSON.stringify({
    id: 31,
    result: {
      thread: {
        id: 'thread-fork-1',
        path: '/tmp/codex/fork.jsonl',
        turns: Array.from({ length: 3_000 }, (_, index) => ({
          id: `turn-${index}`,
          items: [{ type: 'text', text: `large response body ${index} ${'x'.repeat(512)}` }],
        })),
      },
    },
  })
  for (const socket of upstream.sockets) socket.send(response)

  const frame = await rawFrame
  expect(frame.isBinary).toBe(false)
  expect(frame.raw.toString()).toBe(response)
  const parsedPayloads = parseSpy.mock.calls.map(([payload]) => (
    typeof payload === 'string' ? payload : String(payload)
  ))
  expect(parsedPayloads).not.toContain(response)
  expect(parsedPayloads.every((payload) => payload.length < 256)).toBe(true)
  parseSpy.mockRestore()
})
```

- [ ] **Step 3: Add the top-level-id-after-result attribution test**

This test proves the implementation cannot rely on a prefix scan:

```ts
it('attributes large responses when the top-level id appears after result', async () => {
  const upstream = await startUpstream()
  const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
  const candidates: unknown[] = []
  proxy.onCandidate((candidate) => candidates.push(candidate))
  const tui = await connect(proxy.wsUrl)

  tui.send(JSON.stringify({ id: 'pending-thread-start', method: 'thread/start', params: {} }))
  await waitForCondition(() => {
    expect(upstream.messages).toHaveLength(1)
  })

  const response = JSON.stringify({
    result: {
      thread: {
        id: 'thread-1',
        path: '/tmp/codex/rollout.jsonl',
        ephemeral: false,
        turns: Array.from({ length: 3_000 }, (_, index) => ({
          id: `turn-${index}`,
          items: [{ type: 'text', text: `large response body ${index} ${'x'.repeat(512)}` }],
        })),
      },
    },
    id: 'pending-thread-start',
  })
  for (const socket of upstream.sockets) socket.send(response)
  await nextRawMessageFrame(tui)

  expect(candidates).toEqual([])

  tui.send(JSON.stringify({ id: 'after-large', method: 'thread/start', params: {} }))
  await waitForCondition(() => {
    expect(upstream.messages).toHaveLength(2)
  })
  for (const socket of upstream.sockets) {
    socket.send(JSON.stringify({
      id: 'after-large',
      result: {
        thread: {
          id: 'thread-2',
          path: '/tmp/codex/rollout-2.jsonl',
          ephemeral: false,
        },
      },
    }))
  }

  await waitForCondition(() => {
    expect(candidates).toEqual([
      {
        source: 'thread_start_response',
        thread: {
          id: 'thread-2',
          path: '/tmp/codex/rollout-2.jsonl',
          ephemeral: false,
        },
      },
    ])
  })
})
```

The expected `candidates` value stays empty after the large response because the side-effect parse cap will intentionally skip oversized `thread/start` candidate extraction. The important assertion is that the proxy did find and clear the late top-level id, so the later small `thread/start` response still attributes normally.

- [ ] **Step 4: Add the nested-id safety test**

```ts
it('does not treat nested response body ids as JSON-RPC envelope ids', async () => {
  const upstream = await startUpstream()
  const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
  const candidates: unknown[] = []
  proxy.onCandidate((candidate) => candidates.push(candidate))
  const tui = await connect(proxy.wsUrl)

  tui.send(JSON.stringify({ id: 'pending-thread-start', method: 'thread/start', params: {} }))
  await waitForCondition(() => {
    expect(upstream.messages).toHaveLength(1)
  })

  const confusingResponse = JSON.stringify({
    result: {
      id: 'pending-thread-start',
      thread: {
        id: 'fork-thread',
        turns: Array.from({ length: 2_000 }, (_, index) => ({
          id: `turn-${index}`,
          items: [{ type: 'text', text: `large response body ${index}` }],
        })),
      },
    },
    id: 'unrelated-large-response',
  })
  for (const socket of upstream.sockets) socket.send(confusingResponse)
  await nextRawMessageFrame(tui)

  for (const socket of upstream.sockets) {
    socket.send(JSON.stringify({
      id: 'pending-thread-start',
      result: {
        thread: {
          id: 'thread-1',
          path: '/tmp/codex/rollout.jsonl',
          ephemeral: false,
        },
      },
    }))
  }

  await waitForCondition(() => {
    expect(candidates).toEqual([
      {
        source: 'thread_start_response',
        thread: {
          id: 'thread-1',
          path: '/tmp/codex/rollout.jsonl',
          ephemeral: false,
        },
      },
    ])
  })
})
```

- [ ] **Step 5: Add the oversized fork request rejection test**

```ts
it('rejects oversized thread/fork requests instead of parsing or forwarding them', async () => {
  const upstream = await startUpstream()
  const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
  const tui = await connect(proxy.wsUrl)

  const giantRequest = JSON.stringify({
    id: 'giant-fork',
    method: 'thread/fork',
    params: {
      threadId: 'thread-parent-1',
      developerInstructions: 'x'.repeat(10 * 1024 * 1024),
    },
  })
  tui.send(giantRequest)

  await expect(nextResponseWithIdWithin(tui, 'giant-fork', 100)).resolves.toMatchObject({
    id: 'giant-fork',
    error: {
      code: -32000,
      message: expect.stringContaining('too large'),
    },
  })
  await delay(25)
  expect(upstream.messages).toEqual([])
})
```

If `nextResponseWithIdWithin` is typed only for numbers, generalize it to `id: string | number`.

- [ ] **Step 6: Run the new tests to verify red**

Run each new test name individually with `--testNamePattern`, or run the file:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: the parse-spy, late-id, and oversized-request tests FAIL before the scanner/refactor because the current proxy parses every upstream frame and does not cap fork request parsing. The nested-id test may already PASS against the current full parser; keep it because it protects against an unsafe prefix or regex scanner during refactor.

### Task 3: Implement Safe Frames, Caps, And Full-Frame Envelope Scanning

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add constants and frame helpers**

Add near the existing constants:

```ts
const MAX_CLIENT_PARSE_BYTES = 8 * 1024 * 1024
const MAX_UPSTREAM_SIDE_EFFECT_PARSE_BYTES = 1024 * 1024
```

Use `ProxyFrame` everywhere the proxy stores or forwards message frames:

```ts
type ProxyFrame = {
  data: WebSocket.RawData | string
  isBinary: boolean
}
```

Update `PendingTurnStart.raw` to `frame: ProxyFrame`.

Implement:

```ts
function createFrame(raw: WebSocket.RawData | string, isBinary = false): ProxyFrame {
  return { data: raw, isBinary }
}

function sendIfOpen(socket: WebSocket, frame: ProxyFrame | WebSocket.RawData | string): void {
  const send = () => {
    if (isProxyFrame(frame)) {
      socket.send(frame.data, { binary: frame.isBinary })
    } else {
      socket.send(frame)
    }
  }
  if (socket.readyState === WebSocket.OPEN) {
    send()
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.once('open', () => {
      if (socket.readyState === WebSocket.OPEN) send()
    })
  }
}
```

- [ ] **Step 2: Add byte-length helpers**

Implement byte length without converting whole frames to strings:

```ts
function rawByteLength(raw: WebSocket.RawData | string): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw)
  if (Buffer.isBuffer(raw)) return raw.byteLength
  if (raw instanceof ArrayBuffer) return raw.byteLength
  if (Array.isArray(raw)) return raw.reduce((sum, part) => sum + part.byteLength, 0)
  return Buffer.byteLength(String(raw))
}
```

- [ ] **Step 3: Implement a full-frame top-level JSON-RPC envelope scanner**

Add:

```ts
type JsonRpcEnvelope = {
  id?: JsonRpcId
  method?: string
}
```

Implement `scanJsonRpcEnvelope(raw, isBinary): JsonRpcEnvelope`.

Requirements for the scanner:

- Return `{}` for binary frames.
- Scan the full text frame, not a bounded prefix.
- Walk JSON at top level only.
- Skip nested objects/arrays without looking at their keys or values.
- Correctly skip quoted strings and escaped characters.
- Extract only top-level `id` values that are JSON strings or numbers.
- Extract only top-level `method` values that are JSON strings.
- Work regardless of whether top-level `id` appears before or after `result`.
- Do not call `JSON.parse` on the whole frame.
- It is acceptable to call `JSON.parse` only on the tiny substring for a top-level string literal such as `"thread/start"` or `"pending-thread-start"`.

Implementation guidance:

- Convert only small string literal slices to strings for decoding.
- For a `Buffer`, iterate by byte and compare ASCII JSON structural bytes (`{`, `}`, `[`, `]`, `"`, `:`, `,`, `\`).
- For `string`, iterate by character.
- For `ArrayBuffer` or `Buffer[]`, either add an iterator wrapper or normalize to a `Buffer` with a comment explaining `ws` normally supplies `Buffer` for server-side text frames. Preserve the no-full-`JSON.parse` invariant.

- [ ] **Step 4: Use the scanner in `handleUpstreamMessage`**

Refactor `handleUpstreamMessage`:

```ts
private handleUpstreamMessage(connection: ProxyConnection, raw: WebSocket.RawData, isBinary: boolean): void {
  const forward = createFrame(raw, isBinary)
  const envelope = scanJsonRpcEnvelope(raw, isBinary)

  if (envelope.id !== undefined) {
    const method = connection.pendingMethods.get(envelope.id)
    connection.pendingMethods.delete(envelope.id)
    log.debug({ proxyWsUrl: this.endpoint ? this.wsUrl : undefined, upstreamWsUrl: this.upstreamWsUrl, method, id: envelope.id }, 'Codex remote proxy forwarding upstream response')
    if (method === 'thread/start') {
      this.maybeEmitThreadStartResponseCandidate(this.parseUpstreamForSideEffects(raw, isBinary, method))
    }
  } else {
    const method = envelope.method
    if (typeof method === 'string') {
      log.debug({ proxyWsUrl: this.endpoint ? this.wsUrl : undefined, upstreamWsUrl: this.upstreamWsUrl, method }, 'Codex remote proxy forwarding upstream notification')
    }
    this.handleUpstreamNotification(this.parseUpstreamForSideEffects(raw, isBinary, method))
  }

  sendIfOpen(connection.client, forward)
}
```

Add:

```ts
private parseUpstreamForSideEffects(raw: WebSocket.RawData, isBinary: boolean, method?: string): unknown {
  if (isBinary) return undefined
  if (rawByteLength(raw) > MAX_UPSTREAM_SIDE_EFFECT_PARSE_BYTES) {
    log.warn({
      proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
      upstreamWsUrl: this.upstreamWsUrl,
      method,
      bytes: rawByteLength(raw),
      maxBytes: MAX_UPSTREAM_SIDE_EFFECT_PARSE_BYTES,
    }, 'Codex remote proxy skipped oversized upstream side-effect parse')
    return undefined
  }
  return parseJson(raw)
}
```

- [ ] **Step 5: Add request parse caps in `handleClientMessage`**

Use the scanner before full parse:

```ts
const envelope = scanJsonRpcEnvelope(raw, isBinary)
const method = envelope.method
const id = envelope.id
```

For small frames, keep full parse behavior where needed:

- Parse normal requests under `MAX_CLIENT_PARSE_BYTES` so existing `completedTurnInterrupt`, fork rewrite, and held `turn/start` behavior remain intact.
- If `method === 'thread/fork'` and the frame is over `MAX_CLIENT_PARSE_BYTES`, send a JSON-RPC error with the scanned id and return without forwarding.
- If the frame is over the cap and is not a fork request, forward raw with scanned method/id bookkeeping only when possible. Do not call `completedTurnInterrupt` on an oversized request.

Add a clear JSON-RPC error message:

```ts
this.sendJsonRpcError(connection.client, id, 'Codex thread/fork request is too large for Freshell to rewrite safely.')
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
npm run typecheck:server
```

Expected: all PASS.

- [ ] **Step 7: Refactor**

Tighten names and boundaries:

- Keep scanner helpers private to `remote-proxy.ts`; do not export them just for tests unless the tests cannot exercise them through proxy behavior.
- Keep constants near the proxy constants.
- Keep logging structured and body-free.
- Remove the old `framePayload` helper once all forwarding uses `ProxyFrame`.
- Ensure held `turn/start` stores the rewritten/preserved `ProxyFrame`, not a string produced from `raw.toString()`.

Re-run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
npm run typecheck:server
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: avoid parsing large codex proxy frames"
```

### Task 4: Verify Broader Codex Proxy Behavior

**Files:**
- No new files expected.
- Possible modify only if tests reveal real regressions in files already touched.

- [ ] **Step 1: Run focused Codex app-server unit tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/ --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 2: Run Freshcodex adapter regression tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/fresh-agent/codex-adapter.test.ts --config vitest.server.config.ts --testNamePattern "forks Codex threads with stored runtime settings and excludeTurns|lazily resumes a Codex runtime before forking"
```

Expected: PASS. This confirms the existing fresh-agent `excludeTurns` contract still holds and was not accidentally changed.

- [ ] **Step 3: Run server typecheck**

Run:

```bash
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 4: Run coordinated relevant suites**

Run:

```bash
npm run test:unit
npm run test:integration
```

Expected: PASS. These are coordinated repo-owned runs; wait if the coordinator gate is held.

- [ ] **Step 5: Optional real-provider smoke if available**

If the environment has the real Codex app-server binary and credentials expected by the existing opt-in tests, run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/ --config vitest.server.config.ts --testNamePattern "codex"
```

Expected: PASS or SKIP for unavailable external provider. If unavailable, record that live provider verification was not available. Do not restart the self-hosted Freshell server.

- [ ] **Step 6: Commit any follow-up fixes**

Only commit if Task 4 required code/test changes:

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "test: cover codex proxy fork memory safety"
```

### Task 5: Final Verification And Delivery

**Files:**
- No file changes expected.

- [ ] **Step 1: Inspect the final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
```

Expected: the diff is scoped to the remote proxy and its tests.

- [ ] **Step 2: Run final verification**

Run:

```bash
npm run typecheck:server
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

If time and coordinator availability allow, also run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 3: Confirm no server restart occurred**

Do not stop or restart the self-hosted Freshell process. This implementation does not require a production restart during development.

- [ ] **Step 4: Final commit status**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: clean worktree after the implementation commits, unless unrelated user/agent changes are present. Do not revert unrelated changes.

## Evidence Collected During Plan Revision

- `server/coding-cli/codex-app-server/remote-proxy.ts` currently fully parses every client and upstream frame via `parseJson(raw)` and forwards text frames through `raw.toString()`.
- `remote-proxy.ts` uses `connection.pendingMethods` to attribute upstream responses to request methods, and `thread/start` response attribution drives candidate capture.
- `remote-proxy.ts` proxy-owned side effects are limited to candidate capture, turn started/completed, fs-changed repair, lifecycle events, duplicate completed-turn interrupt acknowledgement, and held `turn/start` release.
- `server/coding-cli/codex-app-server/protocol.ts` includes `excludeTurns` in both `CodexThreadResumeParamsSchema` and `CodexThreadForkParamsSchema`.
- `server/coding-cli/codex-app-server/client.ts` validates `thread/fork` params through `CodexThreadForkParamsSchema` and only needs `result.thread.id` from the response.
- `server/fresh-agent/adapters/codex/adapter.ts` already forks with `excludeTurns: true`.
- `test/unit/server/fresh-agent/codex-adapter.test.ts` already asserts fresh-agent fork calls include `excludeTurns: true`.
- `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` implements `thread/read` turn inclusion with `includeTurns`, but does not implement `thread/fork`; therefore local fake-server behavior cannot prove live terminal TUI `/fork` compatibility.
- Baseline command run during plan revision: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts` passed with 15 tests.

## Validated Assumptions

- Terminal Codex proxy is the right implementation boundary: validated by `remote-proxy.ts` handling Codex TUI WebSocket messages and already owning request holds, candidate capture, and notification side effects.
- `excludeTurns` is a supported local Codex app-server fork parameter: validated by `CodexThreadForkParamsSchema` and fresh-agent adapter tests.
- Full upstream `JSON.parse` is the direct proxy-side memory hazard: validated by `handleUpstreamMessage` calling `parseJson(raw)` before forwarding every upstream frame.
- Prefix-only envelope inspection is unsafe: validated by `pendingMethods` requiring top-level response IDs and Codex thread payloads containing nested `id` fields in `thread.turns`.
- Proxy-owned side effects can be bounded without blocking the TUI: validated by all upstream frames being forwardable independently of local side effects, and by side effects being additive Freshell bookkeeping rather than the actual terminal protocol payload.

## Notes For Executor

- Keep commits focused and atomic.
- Do not restart the self-hosted Freshell server.
- Do not weaken or delete existing tests.
- Do not create a PR unless the user explicitly approves PR creation.
