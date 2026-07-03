# Codex Fork OOM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal Codex `/fork` memory-safe in Freshell without breaking the Codex TUI route or silently losing Freshell-owned proxy state.

**Architecture:** Keep the fix in the terminal Codex remote proxy, but separate three concerns: compact fork requests, bounded parsing, and explicit unsafe-frame policy. The proxy forces `thread/fork.params.excludeTurns = true`, parses only frames under byte caps, raw-forwards only oversized frames that do not carry Freshell-owned state and are under a proven raw-forward cap, and fail-closes oversized state-bearing frames so recovery starts instead of silently skipping candidate, turn, fs, or lifecycle effects.

**Tech Stack:** Node.js 22, TypeScript/ESM, `ws`, Zod schemas in `server/coding-cli/codex-app-server/protocol.ts`, Vitest through `npm run test:vitest`, opt-in real Codex contracts gated by `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`.

---

## Strategy Gate

Inspection and baseline verification prove the crash path and the safe boundaries:

- `server/coding-cli/codex-app-server/remote-proxy.ts` currently calls `parseJson(raw)`, which runs `JSON.parse(raw.toString())`, for every client and upstream frame.
- The proxy owns important side effects beyond forwarding: `thread/start` response candidate capture, `thread/started` candidate and lifecycle capture, `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, and `thread/status/changed`.
- `proxy_error` and `proxy_close` are routed in `server/terminal-registry.ts` to lifecycle-loss recovery. `fs/changed` is routed separately to durability proof. Candidate capture controls the input gate and must not be skipped.
- `server/coding-cli/codex-app-server/protocol.ts` already includes `excludeTurns` in `CodexThreadForkParamsSchema`.
- Fresh-agent Codex already forks with `excludeTurns: true` in `server/fresh-agent/adapters/codex/adapter.ts`, with unit coverage in `test/unit/server/fresh-agent/codex-adapter.test.ts`.
- Baseline command run during plan revision: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts` passed with 15 tests.

Do not implement a regex or prefix-only scanner. A large response can place top-level `id` after `result`, and nested `result.thread.turns[*].id` fields can appear before the top-level id.

Do not raw-forward oversized side-effect frames and rely on a generic repair signal. That was falsified by load-bearing review: top-level id and method do not provide enough data to update candidate, turn, fs, or lifecycle state, and existing repair paths are not equivalent to those skipped updates.

Use this revised policy instead:

- Client frames larger than `MAX_CLIENT_PARSE_BYTES` are rejected before forwarding, because client frames are where the proxy must decide request method, pending response attribution, `turn/start` holding, duplicate interrupt acks, and `thread/fork` rewriting.
- Terminal `thread/fork` requests under the client parse cap are parsed, rewritten to `excludeTurns: true`, and forwarded as compact JSON.
- Upstream frames are first attributed with a byte-level top-level JSON-RPC scanner. Full `JSON.parse` is allowed only under `MAX_PROXY_PARSE_BYTES`.
- Oversized upstream state-bearing frames are not treated as successful normal traffic. The proxy logs structured metadata, emits the relevant repair/lifecycle signal, closes the proxied connection, and lets terminal recovery or non-restorable handling run. For a pre-persistence oversized `thread/start` response or `thread/started` notification, fail candidate capture rather than opening the input gate without a durable identity.
- Oversized upstream non-state frames, including `thread/fork` responses, may be raw-forwarded only up to `MAX_RAW_FORWARD_BYTES`, only after a constrained-heap child-process stress test proves the path does not call full-frame `toString()` or `JSON.parse` and does not exceed the child heap limit.
- Any upstream frame above `MAX_RAW_FORWARD_BYTES` fail-closes. This is intentionally conservative: surviving the server OOM matters more than forwarding an arbitrarily huge payload.
- The real TUI `/fork` contract is a required compatibility proof. If it fails because the installed Codex TUI needs `thread.turns` in the fork response, stop and revise the production approach before handoff.

No user decision is required. The next proofs are local: unit tests, a constrained-heap child-process stress test, and the opt-in real Codex TUI contract.

## File Structure

- Create: `server/coding-cli/codex-app-server/json-rpc-envelope.ts`
  - Owns byte-level JSON-RPC top-level envelope scanning.
  - Exports `scanJsonRpcEnvelope(raw)` returning `{ id?: string | number; method?: string }`.
  - Does not parse nested objects, arrays, or result payloads.

- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts`
  - Covers top-level id/method extraction, late top-level id after huge result, nested id safety, escaped strings, chunked frames, malformed JSON, unsupported batch arrays, and no `JSON.parse`.

- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
  - Preserves raw `WebSocket.RawData` and explicit text/binary frame type.
  - Exports parse and forwarding caps.
  - Forces `thread/fork.params.excludeTurns = true`.
  - Rejects oversized client frames.
  - Uses scanner attribution before bounded upstream parsing.
  - Fail-closes oversized state-bearing upstream frames instead of silently skipping side effects.
  - Raw-forwards only oversized non-state upstream frames under the raw-forward cap.

- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
  - Adds regression coverage for fork rewriting, oversized client rejection, state-bearing fail-close behavior, non-state raw forwarding, frame type preservation, pending id attribution, nested id safety, and duplicate interrupt behavior under the parse cap.

- Create: `test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts`
  - Child-process fixture for the constrained-heap large-frame stress test.
  - Starts a proxy and controlled upstream, sends a large non-state response, asserts receipt, and exits with non-zero status if heap, parsing, or forwarding behavior regresses.

- Create: `test/integration/real/codex-remote-fork-contract.test.ts`
  - Opt-in real-provider contract for terminal TUI `/fork`.
  - Skips unless `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1` and `codex` is on `PATH`.
  - Uses an isolated `CODEX_HOME`, `CodexRemoteProxy`, a controlled WebSocket app-server, and `node-pty` to drive the actual terminal route.

- Do not modify: `server/fresh-agent/adapters/codex/adapter.ts`
  - Fresh-agent Codex already uses `excludeTurns: true`; this remains supporting evidence only.

- Do not modify: `docs/index.html`
  - This is a server reliability fix with no user-facing UI change.

## Contracts And Invariants

- Terminal `thread/fork` requests sent upstream must preserve original JSON-RPC fields and params except `params.excludeTurns` is always `true`.
- If the TUI sends `excludeTurns: false`, upstream still receives `excludeTurns: true`.
- If a client request is too large to parse safely, Freshell returns a JSON-RPC error using the scanned id when available and does not forward it upstream.
- The proxy must never run full `JSON.parse` on frames larger than `MAX_PROXY_PARSE_BYTES`.
- The proxy must never call full-frame `raw.toString()` on oversized frames.
- Text frames must be forwarded as text frames and binary frames as binary frames.
- Held `turn/start` frames must preserve their original frame type and release only after `markCandidatePersisted()`.
- `pendingMethods` must use only top-level JSON-RPC ids. Nested `id` fields in `params`, `result`, `thread`, or `turns` must never clear or set pending methods.
- A response whose top-level id appears after a large result must still clear the matching pending method.
- Oversized `thread/fork` responses are non-state frames. They may be raw-forwarded only under `MAX_RAW_FORWARD_BYTES` and only after the constrained-heap test passes.
- Oversized `thread/start`, `thread/started`, `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, and `thread/status/changed` frames are state-bearing. They must fail-close instead of being silently forwarded as successful normal traffic.
- Small candidate capture, turn notification, fs-change, lifecycle, and duplicate interrupt messages must continue to behave exactly as current tests assert.
- Logs remain structured and must not include full request or response bodies.

## Constants

Use exported named constants where tests need to assert cap behavior:

```ts
export const MAX_CLIENT_PARSE_BYTES = 8 * 1024 * 1024
export const MAX_PROXY_PARSE_BYTES = 8 * 1024 * 1024
export const MAX_RAW_FORWARD_BYTES = 64 * 1024 * 1024

const STATEFUL_RESPONSE_METHODS = new Set([
  'thread/start',
])

const STATEFUL_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'turn/started',
  'turn/completed',
  'fs/changed',
  'thread/closed',
  'thread/status/changed',
])
```

`MAX_CLIENT_PARSE_BYTES` is a reject cap. `MAX_PROXY_PARSE_BYTES` is a full-parse cap. `MAX_RAW_FORWARD_BYTES` is a forwarding cap for non-state upstream frames only; frames above it fail-close.

## Implementation Tasks

### Task 1: Add A Tested JSON-RPC Envelope Scanner

**Files:**
- Create: `server/coding-cli/codex-app-server/json-rpc-envelope.ts`
- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts`

- [ ] **Step 1: Write failing scanner tests**

Add tests that define the scanner contract before production code uses it:

```ts
import { describe, expect, it, vi } from 'vitest'
import { scanJsonRpcEnvelope } from '../../../../../server/coding-cli/codex-app-server/json-rpc-envelope.js'

describe('scanJsonRpcEnvelope', () => {
  it('extracts top-level method and numeric id', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('{"jsonrpc":"2.0","id":7,"method":"thread/fork","params":{"id":"nested"}}'))).toEqual({
      id: 7,
      method: 'thread/fork',
    })
  })

  it('extracts a top-level id after a large result without JSON.parse', () => {
    const turns = Array.from({ length: 2000 }, (_, index) => `{"id":"turn-${index}","text":"${'x'.repeat(512)}"}`).join(',')
    const payload = `{"result":{"thread":{"turns":[${turns}]}},"id":"late-id"}`
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      expect(scanJsonRpcEnvelope(Buffer.from(payload))).toEqual({ id: 'late-id' })
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })

  it('ignores nested ids before the top-level id', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('{"result":{"id":"nested","thread":{"id":"thread-1"}},"id":"top"}'))).toEqual({
      id: 'top',
    })
  })

  it('handles escaped top-level strings', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('{"method":"thread\\/fork","id":"a\\\\b\\\"c"}'))).toEqual({
      id: 'a\\b"c',
      method: 'thread/fork',
    })
  })

  it('returns an empty or partial envelope for unsupported or malformed values', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('[{"id":1,"method":"thread/fork"}]'))).toEqual({})
    expect(scanJsonRpcEnvelope(Buffer.from('{"id":'))).toEqual({})
    expect(scanJsonRpcEnvelope(Buffer.from('{"id":null,"method":"x"}'))).toEqual({ method: 'x' })
    expect(scanJsonRpcEnvelope(Buffer.from('{"id":{"bad":true},"method":"x"}'))).toEqual({ method: 'x' })
  })
})
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts --config vitest.server.config.ts
```

Expected: FAIL because the scanner module does not exist.

- [ ] **Step 3: Implement the scanner**

Implement `scanJsonRpcEnvelope(raw)` as a byte-level state machine. Do not convert the whole frame to a string and do not use `JSON.parse`.

Required behavior:

- accept `Buffer`, `ArrayBuffer`, `Buffer[]`, and `string`
- require a root object, not a JSON-RPC batch
- track root depth, string state, and escapes byte-by-byte
- decode only top-level property names and top-level string values for keys `id` and `method`
- collect only top-level numeric id characters while reading the top-level id value
- skip nested values without recording nested keys or nested string values
- return `{}` or a partial envelope on malformed or unsupported values
- guard top-level key/value accumulators with a small limit such as 8 KiB

- [ ] **Step 4: Run scanner tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and broaden scanner coverage**

Add table coverage for string ids, numeric ids, method before and after params, `Buffer[]` frames, irrelevant escaped unicode in nested strings, positive and negative integer ids, and unsupported floating point ids.

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/json-rpc-envelope.ts test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts
git commit -m "test: cover codex json rpc envelope scanning"
```

### Task 2: Preserve Proxy Frames And Bound Client Parsing

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add failing frame preservation and oversized client tests**

Add helpers near `nextMessageFrame`:

```ts
function nextRawMessageFrame(socket: WebSocket): Promise<{ raw: WebSocket.RawData; isBinary: boolean }> {
  return new Promise((resolve) => socket.once('message', (raw, isBinary) => resolve({ raw, isBinary })))
}

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
```

Add tests proving:

- text and binary upstream frames are forwarded with their original `isBinary` flag
- held `turn/start` text frames preserve text framing after release
- an oversized client request receives a JSON-RPC error and is not forwarded upstream
- oversized `turn/start` is rejected, not held without parsed params
- duplicate `turn/interrupt` acks still work for normal small requests

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "frame|oversized client|oversized turn/start|duplicate turn/interrupt"
```

Expected: FAIL because the current proxy fully parses every client frame and normalizes text frames through `raw.toString()`.

- [ ] **Step 3: Implement frame and bounded parse helpers**

In `remote-proxy.ts`, add focused helpers:

```ts
type ProxyFrame = {
  data: WebSocket.RawData | string
  isBinary?: boolean
}

function createFrame(raw: WebSocket.RawData, isBinary: boolean): ProxyFrame {
  return { data: raw, isBinary }
}

function frameByteLength(raw: WebSocket.RawData | string): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw)
  if (Buffer.isBuffer(raw)) return raw.byteLength
  if (Array.isArray(raw)) return raw.reduce((sum, part) => sum + part.byteLength, 0)
  return raw.byteLength
}

function rawDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw)
}

function parseJsonIfWithin(raw: WebSocket.RawData, maxBytes: number): unknown {
  if (frameByteLength(raw) > maxBytes) return undefined
  try {
    return JSON.parse(rawDataToBuffer(raw).toString('utf8'))
  } catch {
    return undefined
  }
}
```

Change `PendingTurnStart.raw` to `frame: ProxyFrame`. Change `sendIfOpen` to accept `ProxyFrame | WebSocket.RawData | string` and call `socket.send(frame.data, { binary: frame.isBinary })` when a frame object is passed.

In `handleClientMessage`:

- call `scanJsonRpcEnvelope(raw)` before parsing
- if `frameByteLength(raw) > MAX_CLIENT_PARSE_BYTES`, send an error to the client using the scanned id and return
- only parse under `MAX_CLIENT_PARSE_BYTES`
- only add `pendingMethods` after a request is accepted for forwarding
- keep duplicate `turn/interrupt` parsing under the cap
- hold `turn/start` only when parsed/scanned as a normal in-cap request

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: bound codex proxy client parsing"
```

### Task 3: Force Terminal Fork Requests To Exclude Turns

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add failing fork rewrite tests**

Add a test proving `excludeTurns: false` becomes `true`:

```ts
it('forces excludeTurns on terminal thread/fork requests before forwarding upstream', async () => {
  const upstream = await startUpstream((socket, message) => {
    if (message.method === 'thread/fork') {
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          thread: { id: 'thread-fork-1', path: '/tmp/codex/fork.jsonl', ephemeral: false },
          cwd: '/repo',
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: { mode: 'danger-full-access' },
        },
      }))
    }
  })
  const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
  const tui = await connect(proxy.wsUrl)

  tui.send(JSON.stringify({
    id: 21,
    method: 'thread/fork',
    params: {
      threadId: 'thread-parent-1',
      cwd: '/repo',
      model: 'gpt-5-codex',
      excludeTurns: false,
    },
  }))

  await expect(nextResponseWithIdWithin(tui, 21, 100)).resolves.toMatchObject({
    id: 21,
    result: { thread: { id: 'thread-fork-1' } },
  })
  expect(upstream.messages).toEqual([{
    id: 21,
    method: 'thread/fork',
    params: {
      threadId: 'thread-parent-1',
      cwd: '/repo',
      model: 'gpt-5-codex',
      excludeTurns: true,
    },
  }])
})
```

Add tests for omitted `params`, existing `excludeTurns: true`, and `excludeTurns: null`.

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "excludeTurns"
```

Expected: FAIL because the current proxy forwards fork requests unchanged.

- [ ] **Step 3: Implement request rewriting**

Add:

```ts
function rewriteThreadForkRequest(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const message = parsed as Record<string, unknown>
  if (message.method !== 'thread/fork') return undefined
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? { ...(message.params as Record<string, unknown>), excludeTurns: true }
    : { excludeTurns: true }
  return JSON.stringify({ ...message, params })
}
```

In `handleClientMessage`, when scanned method is `thread/fork`, require in-cap parsing, rewrite the request, and forward the rewritten string frame. Do not store a pending method until the rewritten request has been accepted for forwarding.

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "excludeTurns"
```

Expected: PASS.

- [ ] **Step 5: Refactor and run focused proxy tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: force codex fork requests to exclude turns"
```

### Task 4: Implement Explicit Oversized Upstream Policy

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add failing oversized upstream tests**

Add tests proving:

- a large `thread/fork` response with top-level id after `result` is raw-forwarded under `MAX_RAW_FORWARD_BYTES`, clears `pendingMethods`, and does not call `JSON.parse` or full-frame `Buffer.prototype.toString`
- nested `result.id` does not clear `pendingMethods`
- an oversized `thread/start` response does not forward as a normal successful frame, emits repair/lifecycle handling, and closes the proxied sockets
- an oversized `thread/started` notification before candidate persistence fails candidate capture and closes rather than opening the input gate
- oversized `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, and `thread/status/changed` notifications fail-close instead of silently skipping local side effects
- normal small `thread/started`, `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, and `thread/status/changed` still emit the current handlers
- a frame above `MAX_RAW_FORWARD_BYTES` fail-closes even if it is non-state

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "large thread/fork|oversized.*thread/start|oversized.*thread/started|oversized.*turn|oversized.*fs|oversized.*thread/status|raw forward cap"
```

Expected: FAIL because the current proxy fully parses every upstream frame and does not have explicit oversized policy.

- [ ] **Step 3: Implement upstream attribution and policy**

In `handleUpstreamMessage`:

- create a `ProxyFrame` from the original raw frame and `isBinary`
- scan top-level id/method before parsing
- if scanned id matches `pendingMethods`, capture and delete the pending method
- if frame bytes exceed `MAX_RAW_FORWARD_BYTES`, call `failUnsafeUpstreamFrame(connection, method, 'raw_forward_cap_exceeded')` and return
- if frame bytes exceed `MAX_PROXY_PARSE_BYTES` and the pending method or notification method is state-bearing, call `failUnsafeUpstreamFrame(connection, method, 'oversized_stateful_frame')` and return
- if frame bytes exceed `MAX_PROXY_PARSE_BYTES` and the frame is non-state, send the raw frame and return
- otherwise parse under `MAX_PROXY_PARSE_BYTES`, emit existing side effects, and forward the original frame

Implement `failUnsafeUpstreamFrame` as fail-closed behavior, not a normal forwarding path:

```ts
private failUnsafeUpstreamFrame(connection: ProxyConnection, method: string | undefined, reason: string): void {
  const error = new Error(`Unsafe oversized Codex app-server frame${method ? ` for ${method}` : ''}: ${reason}`)
  log.warn({ method, reason, proxyWsUrl: this.endpoint ? this.wsUrl : undefined }, 'Closing Codex remote proxy after unsafe oversized frame')
  if (method === 'thread/start' || method === 'thread/started') {
    this.failCandidateCapture('Freshell could not safely capture Codex restore identity from an oversized app-server frame.')
  } else {
    this.emitRepairTrigger({ kind: 'proxy_error', error })
    connection.client.close()
    connection.upstream.close()
  }
}
```

Keep small-frame side effects on the current Zod-backed path. Do not add partial param parsers unless a test proves a specific side effect can be safely recovered from bounded metadata.

- [ ] **Step 4: Run focused tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: fail closed on oversized codex side effects"
```

### Task 5: Add A Constrained-Heap Large-Forward Stress Test

**Files:**
- Create: `test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Write the child-process fixture**

Create a fixture that:

- starts a controlled upstream WebSocket server
- starts `CodexRemoteProxy` with `requireCandidatePersistence: false`
- connects a TUI WebSocket to the proxy
- sends a small client request with id `77` and method `thread/fork`
- has upstream send a large non-state response for id `77` whose top-level id appears after a large `result`
- asserts the TUI receives the same byte length and the process remains alive
- exits with code `0` on success and `1` on failure

Keep the payload below `MAX_RAW_FORWARD_BYTES` but large enough to catch accidental full JSON parsing, for example 24 MiB.

- [ ] **Step 2: Add the parent Vitest case**

In `remote-proxy.test.ts`, add a test that launches the fixture with a constrained heap:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

it('raw-forwards a large non-state response under constrained heap', async () => {
  const childPath = new URL('./remote-proxy-large-forward-child.ts', import.meta.url)
  await expect(execFileAsync(process.execPath, [
    '--max-old-space-size=128',
    '--import',
    'tsx',
    childPath.pathname,
  ], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })).resolves.toMatchObject({ stderr: '' })
}, 45_000)
```

- [ ] **Step 3: Run the stress test to verify red or meaningful failure**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "constrained heap"
```

Expected before the raw-forward implementation is complete: FAIL by child OOM, timeout, or explicit assertion.

- [ ] **Step 4: Make the stress test pass without weakening it**

If the test fails after Task 4, fix the forwarding path. Do not raise the child heap limit, lower payload below meaningful size, or remove the assertion that the large response arrives.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts server/coding-cli/codex-app-server/remote-proxy.ts
git commit -m "test: stress codex proxy large response forwarding"
```

### Task 6: Add The Opt-In Real TUI Fork Contract

**Files:**
- Create: `test/integration/real/codex-remote-fork-contract.test.ts`

- [ ] **Step 1: Write the skipped contract test**

Follow the existing real-provider pattern in `test/integration/real/codex-app-server-readiness-contract.test.ts`: skip unless `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1` and `codex` is available. Import `CodexRemoteProxy`, `MAX_CLIENT_PARSE_BYTES`, and `CODEX_MANAGED_REMOTE_CONFIG_ARGS` so the contract uses the same proxy and launch flags as terminal Codex.

The test should:

- start a controlled WebSocket app-server on localhost
- start `CodexRemoteProxy` with the controlled app-server as `upstreamWsUrl`
- launch `codex --remote <proxy.wsUrl> ...CODEX_MANAGED_REMOTE_CONFIG_ARGS --no-alt-screen` through `node-pty`
- respond to `initialize`, `thread/start`, and common bootstrap methods with minimal valid results
- wait until a root thread is started
- write `/fork\r` to the PTY
- capture the `thread/fork` request received by the controlled upstream after proxy rewriting
- assert the upstream request body byte length is below `MAX_CLIENT_PARSE_BYTES`
- assert the upstream request includes `excludeTurns: true`
- respond with a minimal fork result without `turns`
- assert the TUI stays alive long enough to accept a follow-up harmless key or exit command

- [ ] **Step 2: Run the contract to verify it passes locally**

Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS when `codex` and auth/config are available. If it fails because Codex changed the TUI protocol or `/fork` needs a different response shape, stop and revise the production approach before continuing.

- [ ] **Step 3: Run default focused tests**

Run:

```bash
npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS with the test skipped when the opt-in env var is absent.

- [ ] **Step 4: Commit**

```bash
git add test/integration/real/codex-remote-fork-contract.test.ts
git commit -m "test: add codex remote fork contract"
```

### Task 7: Final Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused server tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 2: Run the opt-in real fork contract when Codex is available**

Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS or a documented skip if `codex` or required auth/config is unavailable. A protocol failure is a blocker.

- [ ] **Step 3: Run the repo check**

Coordinate through the repo wrapper:

```bash
FRESHELL_TEST_SUMMARY="codex fork oom bounded proxy parsing" npm run check
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only the planned files changed; no whitespace errors.

- [ ] **Step 5: Commit any final cleanup**

If verification required small cleanup:

```bash
git add server/coding-cli/codex-app-server/json-rpc-envelope.ts server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts test/integration/real/codex-remote-fork-contract.test.ts
git commit -m "chore: finalize codex fork oom fix"
```

## Completion Criteria

- Terminal `thread/fork` upstream requests always include `excludeTurns: true`.
- Oversized client requests are rejected before they can reach upstream unmodified.
- Oversized fork responses under `MAX_RAW_FORWARD_BYTES` are forwarded to the TUI without full proxy-side JSON parsing, full-frame `toString()`, or constrained-heap failure.
- Upstream frames above `MAX_RAW_FORWARD_BYTES` fail-close instead of risking server OOM.
- The proxy preserves text/binary WebSocket frame semantics.
- Pending method attribution is based only on top-level JSON-RPC ids, including ids after large results.
- Oversized state-bearing frames are not silently ignored; they fail-close and trigger candidate/lifecycle recovery.
- Existing candidate capture, turn notification, fs-change, lifecycle, and duplicate interrupt behavior remains covered and passing.
- The opt-in real Codex TUI `/fork` contract passes locally, or execution stops with the exact protocol failure.
- `npm run check` passes before handoff.
