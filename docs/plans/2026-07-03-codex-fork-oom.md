# Codex Fork OOM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal Codex `/fork` memory-safe in Freshell without breaking the Codex TUI protocol or losing essential proxy lifecycle behavior.

**Architecture:** Keep the behavior in the terminal Codex remote proxy, but split the risky work into a tested JSON-RPC envelope scanner and bounded message parsing. The proxy will force `thread/fork.params.excludeTurns = true`, reject unrewritable oversized fork requests, raw-forward oversized upstream frames, and emit repair/lifecycle signals instead of silently dropping essential local side effects. The real TUI contract exercises the same terminal route Freshell launches in production: Codex TUI -> `CodexRemoteProxy` -> controlled app-server.

**Tech Stack:** Node.js 22, TypeScript/ESM, `ws`, Zod schemas in `server/coding-cli/codex-app-server/protocol.ts`, Vitest through `npm run test:vitest`, opt-in real Codex contracts gated by `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`.

---

## Strategy Gate

The crash path is the terminal Codex remote proxy:

- `server/coding-cli/codex-app-server/remote-proxy.ts` currently calls `parseJson(raw)`, which does `JSON.parse(raw.toString())`, for every client and upstream WebSocket frame.
- `thread/fork` is modeled in `server/coding-cli/codex-app-server/protocol.ts`, and `CodexThreadForkParamsSchema` includes `excludeTurns`.
- Fresh-agent Codex already calls `runtime.forkThread(..., excludeTurns: true)` in `server/fresh-agent/adapters/codex/adapter.ts`, with coverage in `test/unit/server/fresh-agent/codex-adapter.test.ts`.
- Existing proxy tests pass today: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts` reports 15 passing tests.

Do not implement a prefix regex scan. It is unsafe because a large response can put top-level `id` after `result`, and nested `result.thread.turns[*].id` fields can appear first.

The revised design avoids the unproven parts of the earlier plan:

- Build a dedicated byte-level JSON-RPC envelope scanner in a small module with heavy tests before using it in the proxy. It extracts only top-level `id` and `method`, ignores nested `id` fields, handles escaped strings, and does not materialize nested JSON values.
- Keep full `JSON.parse` only below explicit caps. Oversized messages are forwarded raw with the original text/binary flag.
- Do not silently skip essential side effects on oversized upstream messages. Oversized `thread/fork` responses have no Freshell-owned side effect and may be raw-forwarded. Oversized side-effect response methods (`thread/start`) and oversized side-effect notification methods (`thread/started`, `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, `thread/status/changed`) must either be parsed under the cap or trigger the existing repair/lifecycle path via `proxy_error` while still forwarding the frame to the TUI.
- Prove terminal TUI `/fork` compatibility before relying on it. Add an opt-in real Codex contract that launches the installed Codex TUI against a `CodexRemoteProxy` connected to a controlled app-server, sends `/fork`, captures the upstream request after proxy rewriting, verifies it is small enough for the cap, verifies the upstream request receives `excludeTurns: true`, and verifies the TUI remains connected after a minimal fork response. Do not add a production test hook only to observe the pre-rewrite TUI frame; unit tests cover false-to-true rewriting, while the real contract should prove the actual launched route remains usable. If that contract cannot run in the executor environment, keep the unit-level memory-safety fix but report the unavailable real-provider proof explicitly before PR creation.

No user decision is required now. The next proofs are implementable locally with the installed `codex` binary and repo test harnesses; if they fail, execution should stop with the failing evidence.

## File Structure

- Create: `server/coding-cli/codex-app-server/json-rpc-envelope.ts`
  - Owns the byte-level top-level JSON-RPC envelope scanner.
  - Exports `scanJsonRpcEnvelope(raw)` returning `{ id?: string | number; method?: string }`.
  - Does not parse nested objects, arrays, or result payloads.

- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts`
  - Covers top-level id/method extraction, late top-level id after huge result, nested id safety, escaped strings, binary buffers, arrays/batches, malformed JSON, and large payload allocation behavior.

- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
  - Preserve raw `WebSocket.RawData` and explicit `isBinary` on held and forwarded frames; never convert an oversized text frame to a UTF-16 string just to forward it.
  - Use the envelope scanner for request/response attribution before bounded parsing.
  - Force `thread/fork.params.excludeTurns = true` for terminal requests.
  - Reject oversized `thread/fork` requests instead of forwarding them unmodified.
  - Parse upstream frames only under method-specific side-effect caps.
  - Emit `proxy_error` repair for oversized side-effect messages that cannot be safely parsed.

- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
  - Add regression tests for fork rewriting, oversized fork request rejection, large fork response forwarding without full parse, late top-level id attribution, nested id safety, text/binary preservation, oversized `turn/start` holding, and oversized side-effect repair.

- Create: `test/integration/real/codex-remote-fork-contract.test.ts`
  - Opt-in real-provider contract for terminal TUI `/fork`.
  - Skips unless `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1` and `codex` is on `PATH`.
  - Uses an isolated `CODEX_HOME`, `CodexRemoteProxy`, a controlled WebSocket app-server, and `node-pty` to drive the TUI.

- Do not modify: `server/fresh-agent/adapters/codex/adapter.ts`
  - Fresh-agent Codex already uses `excludeTurns: true`; this remains supporting evidence only.

- Do not modify: `docs/index.html`
  - This is a server reliability fix with no user-facing UI change.

## Contracts And Invariants

- Terminal `thread/fork` requests sent upstream must preserve original JSON-RPC fields and params except `params.excludeTurns` is always `true`.
- If the TUI sends `excludeTurns: false`, upstream still receives `excludeTurns: true`.
- If a `thread/fork` request is too large to parse and rewrite safely, Freshell returns a JSON-RPC error to the TUI using the scanned id when available and does not forward the request upstream.
- The proxy must never run full `JSON.parse` on frames larger than the configured parse caps.
- The proxy must never call `raw.toString()` on an oversized frame. All UTF-8 decoding must happen behind a byte cap.
- Text frames must be forwarded as text frames and binary frames as binary frames.
- Held `turn/start` frames must preserve their original frame type and release only after `markCandidatePersisted()`.
- `pendingMethods` must use only top-level JSON-RPC ids. Nested `id` fields in `params`, `result`, `thread`, or `turns` must never clear or set pending methods.
- A response whose top-level id appears after a large result must still clear the matching pending method.
- Oversized `thread/fork` responses are raw-forwarded and do not need Freshell side effects.
- Oversized side-effect-bearing upstream messages are raw-forwarded and must trigger a repair/lifecycle signal rather than silently skipping local state updates.
- Small candidate capture, turn notification, fs-change, and lifecycle messages must continue to behave exactly as current tests assert.
- Logs remain structured and must not include full request or response bodies.

## Constants

Use exported named constants in `remote-proxy.ts` so the real contract can assert against the same request-size cap the proxy enforces:

```ts
export const MAX_CLIENT_PARSE_BYTES = 8 * 1024 * 1024
export const MAX_UPSTREAM_SIDE_EFFECT_PARSE_BYTES = 8 * 1024 * 1024
const SIDE_EFFECT_RESPONSE_METHODS = new Set([
  'thread/start',
])
const SIDE_EFFECT_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'turn/started',
  'turn/completed',
  'fs/changed',
  'thread/closed',
  'thread/status/changed',
])
```

Use `MAX_CLIENT_PARSE_BYTES` for rewriting `thread/fork` and parsing duplicate `turn/interrupt` acks. Use `MAX_UPSTREAM_SIDE_EFFECT_PARSE_BYTES` only for proxy-owned side effects. It is a parsing cap, not a forwarding cap.

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
    const payload = `{"result":{"thread":{"turns":[${Array.from({ length: 2000 }, (_, index) => `{"id":"turn-${index}","text":"${'x'.repeat(512)}"}`).join(',')}]}}, "id":"late-id"}`
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

  it('returns an empty envelope for arrays, malformed JSON, null ids, and object ids', () => {
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

Implement `scanJsonRpcEnvelope(raw)` as a byte-level state machine. Do not convert the whole frame to a string and do not use `JSON.parse`:

```ts
export type JsonRpcEnvelope = {
  id?: string | number
  method?: string
}

export function scanJsonRpcEnvelope(raw: Buffer | ArrayBuffer | Buffer[] | string): JsonRpcEnvelope {
  // Normalize to iterable byte chunks, not one giant UTF-16 string.
  // Implement a depth-aware scanner:
  // - require root object
  // - track string state and escapes byte-by-byte
  // - decode only top-level property names and top-level string values for keys "id" and "method"
  // - collect top-level numeric id characters only while reading the id value
  // - skip all nested values without recording nested keys or nested string values
  // - return {} on malformed/unsupported envelopes
}
```

Use a small internal string accumulator only for top-level key names plus top-level `id`/`method` string values. Guard those accumulators with a small limit such as 8 KiB; if a top-level field exceeds the limit, ignore that field and keep scanning for the other field.

- [ ] **Step 4: Run scanner tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and broaden scanner coverage**

Add table coverage for:

- string ids and numeric ids
- top-level `method` before and after `params`
- binary `Buffer[]` frames
- escaped unicode in irrelevant nested strings
- positive and negative integer ids, matching local `JsonRpcId`

Re-run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/json-rpc-envelope.ts test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts
git commit -m "test: cover codex json rpc envelope scanning"
```

### Task 2: Preserve Proxy Frames And Bound Parsing

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add failing frame and oversized parse tests**

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

- a large upstream response with top-level id after `result` is forwarded raw and clears `pendingMethods`
- nested `result.id` does not clear `pendingMethods`
- text upstream frames are forwarded as text and binary frames as binary
- an oversized text upstream frame is forwarded without calling `toString()` on that large raw buffer
- oversized `turn/start` is held without full `JSON.parse` and released after `markCandidatePersisted()`

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "large upstream|nested|binary|oversized turn/start"
```

Expected: FAIL because the current proxy fully parses frames and stores held frames without an explicit binary flag.

- [ ] **Step 3: Implement proxy frame preservation and bounded parse helpers**

In `remote-proxy.ts`, add:

```ts
type ProxyFrame = {
  data: WebSocket.RawData | string
  isBinary: boolean
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

function rawDataToUtf8(raw: WebSocket.RawData): string {
  return rawDataToBuffer(raw).toString('utf8')
}

function parseJsonIfWithin(raw: WebSocket.RawData, maxBytes: number): unknown {
  if (frameByteLength(raw) > maxBytes) return undefined
  try {
    return JSON.parse(rawDataToUtf8(raw))
  } catch {
    return undefined
  }
}
```

Change `PendingTurnStart.raw` to `frame: ProxyFrame`. Change `sendIfOpen` to accept `ProxyFrame | WebSocket.RawData | string` and call `socket.send(frame.data, { binary: frame.isBinary })` for frames. For original text frames, pass the original `raw` buffer/array buffer/buffer chunks with `{ binary: false }`; do not normalize text frames to strings unless they are below a parse/rewrite cap. Only rewritten `thread/fork` requests and JSON-RPC proxy-generated errors/successes should be sent as strings.

- [ ] **Step 4: Use the scanner for attribution**

In `handleClientMessage` and `handleUpstreamMessage`, call `scanJsonRpcEnvelope(raw)` before bounded parsing. Use scanned `id` and `method` to update `pendingMethods`, hold `turn/start`, and clear response attribution.

Do not emit proxy-owned side effects from oversized upstream frames unless the frame is a `thread/fork` response. For oversized side-effect methods, raw-forward first, then:

```ts
this.emitRepairTrigger({
  kind: 'proxy_error',
  error: new Error(`Skipped oversized Codex app-server side-effect frame for ${method}`),
})
```

- [ ] **Step 5: Run tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: bound codex proxy parsing"
```

### Task 3: Force Terminal Fork Requests To Exclude Turns

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add failing fork rewrite and rejection tests**

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
          sandbox: 'danger-full-access',
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

Add a test proving an oversized `thread/fork` request returns an error and is not forwarded.

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "excludeTurns|oversized thread/fork"
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

In `handleClientMessage`:

- scan the envelope first
- if `method === 'thread/fork'` and `frameByteLength(raw) > MAX_CLIENT_PARSE_BYTES`, send JSON-RPC error and return
- parse within cap
- rewrite and forward the rewritten text frame
- set `pendingMethods` only after the request is accepted for forwarding

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "excludeTurns|oversized thread/fork"
```

Expected: PASS.

- [ ] **Step 5: Refactor and run all focused proxy tests**

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

### Task 4: Add Large Fork Response And Side-Effect Repair Regressions

**Files:**
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`

- [ ] **Step 1: Add a large fork response no-full-parse test**

Use `vi.spyOn(JSON, 'parse')`, send a `thread/fork` request, then have upstream send a response with thousands of turns. Assert:

- the TUI receives exactly the same raw response
- the response frame is text, not binary
- `JSON.parse` is not called with that large response
- `Buffer.prototype.toString` is not called for a buffer with the large response byte length while the proxy handles that response

- [ ] **Step 2: Add oversized side-effect repair tests**

Add tests for:

- oversized `thread/start` response is forwarded and emits `proxy_error` because it may carry the restore-identity candidate
- oversized `thread/started` notification is forwarded and emits `proxy_error`
- oversized `turn/completed` notification is forwarded and emits `proxy_error`
- normal small `thread/started`, `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, and `thread/status/changed` still emit the current handlers

- [ ] **Step 3: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "large fork|oversized.*side-effect|thread/started|turn/completed"
```

Expected: any missing regression fails before the implementation is complete.

- [ ] **Step 4: Implement method-specific oversized handling**

In `handleUpstreamMessage`, after scanning:

- clear `pendingMethods` when a scanned top-level id matches
- if a response is oversized and the matched pending method is `thread/fork`, raw-forward and return
- if an oversized response matches `SIDE_EFFECT_RESPONSE_METHODS`, raw-forward, emit `proxy_error`, and return
- if an oversized notification method matches `SIDE_EFFECT_NOTIFICATION_METHODS`, raw-forward, emit `proxy_error`, and return
- otherwise raw-forward oversized frames without parsing

Small frames keep using the existing Zod-backed side-effect handlers.

- [ ] **Step 5: Run focused tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "test: cover codex fork response memory safety"
```

### Task 5: Add The Opt-In Real TUI Fork Contract

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

Expected: PASS when `codex` is available. If it fails because Codex changed the TUI protocol or `/fork` needs a different response shape, stop and revise the production approach before continuing.

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

### Task 6: Final Verification

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

Expected: PASS or a documented skip if `codex` is unavailable. A protocol failure is a blocker.

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
git add server/coding-cli/codex-app-server/json-rpc-envelope.ts server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/integration/real/codex-remote-fork-contract.test.ts
git commit -m "chore: finalize codex fork oom fix"
```

## Completion Criteria

- Terminal `thread/fork` upstream requests always include `excludeTurns: true`.
- Oversized fork requests are rejected before they can reach upstream unmodified.
- Oversized fork responses are forwarded to the TUI without full proxy-side JSON parsing.
- The proxy preserves text/binary WebSocket frame semantics.
- Pending method attribution is based only on top-level JSON-RPC ids, including ids after large results.
- Oversized side-effect frames are not silently ignored; they trigger repair/lifecycle handling.
- Existing candidate capture, turn notification, fs-change, lifecycle, and duplicate interrupt behavior remains covered and passing.
- The opt-in real Codex TUI `/fork` contract passes locally, or execution stops with the exact protocol failure.
- `npm run check` passes before handoff.
