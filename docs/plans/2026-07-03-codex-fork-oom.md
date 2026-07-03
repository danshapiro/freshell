# Codex Fork OOM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal Codex `/fork` memory-safe in Freshell without breaking the terminal Codex TUI route or silently losing Freshell-owned proxy state.

**Architecture:** Keep request compaction and large-frame memory safety inside the terminal Codex remote proxy, with one explicit TerminalRegistry state transition for the new thread identity created by `/fork`. The proxy will first prove a byte-level JSON-RPC envelope scanner, a `thread/fork` request rewriter, and bounded side-effect extractors against differential and adversarial fixtures; only after those helpers are proven will it integrate them into proxy forwarding. Large frames Freshell does not own are raw-forwarded only below a measured cap, while stateful frames either produce the same local side effects as small frames or fail closed.

**Tech Stack:** Node.js 22, TypeScript/ESM, `ws` 8.19, Zod schemas in `server/coding-cli/codex-app-server/protocol.ts`, Vitest through `npm run test:vitest`, opt-in real Codex contracts gated by `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`.

---

## Strategy Gate

Plan revision evidence changed the implementation direction:

- `server/coding-cli/codex-app-server/remote-proxy.ts` currently calls `JSON.parse(raw.toString())` for every client and upstream frame. That is the OOM-prone behavior.
- `protocol.ts` proves `thread/fork.params.excludeTurns` is already in the local schema, and fresh-agent Codex already uses `excludeTurns: true` in `server/fresh-agent/adapters/codex/adapter.ts`.
- `remote-proxy.ts` owns stateful side effects for `thread/start` responses, `thread/started`, `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, and `thread/status/changed`.
- `terminal-registry.ts` consumes those side effects for candidate persistence, turn durability, rollout proof, and lifecycle loss. Dropping them silently is not safe.
- Terminal `/fork` can move the Codex TUI to a new thread through a `thread/fork` response. `terminal-registry.ts` currently ignores mismatched candidates after the initial restore identity, which is correct for accidental startup races but wrong for an intentional fork handoff. A memory-safe `/fork` that leaves Freshell bound to the old parent thread would satisfy the OOM symptom while breaking durable terminal identity.
- `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts` lists many other Codex server notifications and server requests. Those are forwarded to the TUI, but Freshell's terminal proxy does not currently derive local state from them.
- Baseline verification passed: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts` passed with 15 tests.
- The load-bearing review falsified two implementation assumptions:
  - `terminal-registry.ts` does not support fork handoff through the existing candidate path. It returns early when `resumeSessionId` exists and ignores mismatched candidates after one candidate has been persisted. Fork must become a deliberate source-specific transition.
  - A 64 MiB frame is not safe if the proxy converts it to a string and parses it. The memory-safety claim must be proven for the new raw-forward path, not inferred from the old implementation.
- Local investigation during plan revision 5 confirmed that `ws` 8.19 defaults `maxPayload` to 100 MiB, enforces payload length before message emission, and emits text messages as `Buffer` objects. A disposable raw WebSocket proxy under `node --max-old-space-size=128` forwarded 8, 16, 32, 48, and 64 MiB text JSON frames without full parsing or stringification; the 64 MiB case completed with about 6 MB JS heap used, about 268 MB RSS, and about 136 MB external memory. This supports keeping 64 MiB only as a raw-forward cap that must be guarded by a constrained-heap regression test.
- No streaming JSON parser dependency exists in `package.json`. Keep the scanner/extractor code local and small, but prove it before integration with adversarial fixtures and differential tests against `JSON.parse` on bounded frames.

Use this policy instead:

- Never full-parse a frame solely to route or attribute it. Use a byte-level top-level JSON-RPC scanner for `id` and `method`.
- Do not reject all large client frames. Large valid `initialize`, `thread/start`, `thread/resume`, `turn/start`, or other requests should raw-forward unless the proxy must transform them.
- Always transform terminal `thread/fork` requests to include `params.excludeTurns: true`. Implement this as a byte-level JSON object rewrite, not as `JSON.parse` plus `JSON.stringify`, so a large but valid fork request does not require materializing params as JS objects.
- If a `thread/fork` request is malformed enough that the rewriter cannot safely force `excludeTurns: true`, return a JSON-RPC error and do not forward it. Forwarding an un-compacted fork request reintroduces the crash class.
- Hold `turn/start` before candidate persistence using only the scanned top-level method and id. Do not require parsing `turn/start.params`.
- Keep the duplicate `turn/interrupt` ack optimization only for frames whose params can be parsed or bounded-extracted safely. If params cannot be inspected without full materialization, forward the interrupt normally.
- For upstream frames, scan first. Full `JSON.parse` is an optimization only for small frames, never the only correctness path.
- For stateful upstream frames that are too large for full parsing, use method-specific bounded extractors for just the fields Freshell owns:
  - `thread/start` response and `thread/started`: `thread.id`, `thread.path`, `thread.ephemeral`
  - `thread/fork` response: `thread.id`, `thread.path`, `thread.ephemeral`
  - `turn/started`: `params.threadId`, `params.turnId`
  - `turn/completed`: `params.threadId`, `params.turnId`, `params.status`, `params.turn.status`
  - `fs/changed`: `params.watchId`, and bounded `changedPaths`; if `changedPaths` is too large but `watchId` is known, emit an empty `changedPaths` array to conservatively request durability proof
  - `thread/closed`: `params.threadId`
  - `thread/status/changed`: `params.threadId`, `params.status.type`
- If a stateful upstream frame cannot be fully parsed and the required bounded side-effect extractor also cannot recover the owned fields, fail closed with structured logging, `proxy_error` or candidate-capture failure as appropriate, and socket closure. Do not forward it as a successful normal frame.
- Treat `thread/fork` response candidates as intentional thread handoffs. Preserve the existing startup-race protection for ordinary mismatched `thread_start_response` and `thread_started_notification` candidates, but let a valid `thread_fork_response` replace the terminal's Codex durability candidate, release the old session binding, and require the normal rollout proof before the forked thread becomes durable.
- A fork handoff must also be a user-input gate, not only a registry state update. The proxy emits a fork candidate while handling the upstream fork response, but TerminalRegistry persists that candidate asynchronously. Without a second gate, the TUI can receive the fork response, immediately send `turn/start` for the new thread, and have the turn events ignored because Freshell is still bound to the parent identity. Generalize the existing candidate-persistence gate so `thread/fork` responses start a source-aware `fork_handoff` gate; subsequent `turn/start` requests are held until TerminalRegistry positively acknowledges the fork candidate through `markCandidatePersisted()`, or the proxy fails closed. This fork gate applies even when `requireCandidatePersistence: false`, because resumed Codex terminals skip startup capture but still need safe `/fork` identity handoff.
- Do not continue a terminal after an invalid `thread_fork_response` candidate. Preserving the old durable identity after the TUI has moved to a forked thread would silently bind future activity to the wrong Codex session. If the fork response cannot yield a deterministic absolute rollout path, keep the old store record intact but fail the proxy connection before accepting post-fork user input, with structured `proxy_error` repair signaling rather than marking the old identity non-restorable.
- Raw-forward oversized non-state upstream frames only up to a raw-forward limit that is proven at the limit boundary by a constrained-heap child-process stress test using the actual proxy. Treat that limit as an operational memory-safety cap, not as proof that larger frames are invalid. Frames above it fail closed to preserve the Freshell server.
- The opt-in real terminal TUI `/fork` contract is required before completion in any environment with `codex` and local Codex credentials. Plan revision 5 confirmed this workspace has `codex` 0.142.5 plus `~/.codex/auth.json` and `~/.codex/config.toml`, so the executor must run the opt-in contract here. If the installed Codex TUI cannot continue after receiving a compact fork response without `thread.turns`, stop and revise the production approach.

No user decision is required for this revision. The remaining proofs are local automated tests and the opt-in real Codex contract.

## File Structure

- Create: `server/coding-cli/codex-app-server/json-rpc-envelope.ts`
  - Byte-level scanner for top-level JSON-RPC `id` and `method`.
  - Does not call `JSON.parse` or full-frame `toString()`.

- Create: `server/coding-cli/codex-app-server/json-rpc-side-effects.ts`
  - Byte-level bounded extractors for the small fields Freshell owns in large stateful upstream frames.
  - Byte-level `thread/fork` request rewriter that forces `params.excludeTurns = true`.

- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts`
  - Scanner contract and malformed-frame coverage.
  - Differential corpus comparing scanner output to `JSON.parse` for bounded generated JSON-RPC messages.

- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts`
  - Fork rewrite and side-effect extractor coverage, including large payloads with nested `id`, `method`, and `turns`.
  - Differential corpus comparing bounded extractor output to existing Zod-backed behavior for bounded frames.

- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
  - Preserve raw frame data and text/binary framing.
  - Generalize candidate persistence from a one-time startup boolean into a source-aware identity gate for `initial_capture` and `fork_handoff`; `requireCandidatePersistence: false` disables only the startup `initial_capture` gate, not later fork handoff gates.
  - After emitting a valid-looking `thread_fork_response` candidate, hold later `turn/start` requests until TerminalRegistry acknowledges persistence through `markCandidatePersisted()`.
  - Fail closed if a fork handoff gate times out or TerminalRegistry never acknowledges it; do not silently forward post-fork user input against the old durable identity.
  - Use scanner attribution for pending methods and turn/start hold.
  - Force `thread/fork.params.excludeTurns = true` through the byte-level rewriter.
  - Emit candidate side effects from `thread/fork` responses with source `thread_fork_response`.
  - Use bounded side-effect extractors before fail-closing large stateful upstream frames.
  - Raw-forward non-state upstream frames under the tested raw-forward limit.

- Modify: `shared/codex-durability.ts`
  - Add `thread_fork_response` as a valid Codex candidate source.

- Modify: `server/terminal-registry.ts`
  - Add deliberate Codex fork identity handoff handling for candidates whose source is `thread_fork_response`.
  - Preserve existing initial-candidate mismatch protection for non-fork candidates.

- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
  - Regression coverage for fork rewriting, fork response candidate emission, large valid client forwarding, stateful side-effect recovery, fail-closed unrecoverable state frames, raw forwarding, frame type preservation, pending id attribution, and duplicate interrupt behavior.

- Modify: `test/unit/server/terminal-registry.codex-sidecar.test.ts`
  - Regression coverage for fork candidate handoff replacing the old durable identity while ordinary mismatched startup candidates remain ignored.

- Create: `test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts`
  - Constrained-heap stress fixture proving the actual proxy forwards both a large stateful `thread/fork` response after bounded candidate extraction and large non-state frames below `MAX_RAW_FORWARD_BYTES` without full-parse or full-stringify, and fail-closes frames above the cap.

- Create: `test/integration/real/codex-remote-fork-contract.test.ts`
  - Opt-in real terminal Codex TUI `/fork` contract using `codex --remote`, `node-pty`, an isolated `CODEX_HOME`, `CODEX_MANAGED_REMOTE_CONFIG_ARGS`, and a controlled WebSocket app-server.

- Do not modify: `server/fresh-agent/adapters/codex/adapter.ts`
  - Fresh-agent Codex already uses `excludeTurns: true`; keep it as supporting evidence only.

- Do not modify: `docs/index.html`
  - This is a server reliability fix with no user-facing UI change.

## Contracts And Invariants

- Terminal `thread/fork` requests sent upstream must preserve original JSON-RPC fields and params except `params.excludeTurns` is always `true`.
- If the TUI sends `excludeTurns: false` or `excludeTurns: null`, upstream receives `excludeTurns: true`.
- If the TUI omits `params`, upstream receives a params object containing `excludeTurns: true`.
- A large valid non-fork client request is not rejected merely because of size.
- Held `turn/start` frames preserve their original raw bytes and original text/binary framing until candidate persistence releases them.
- Duplicate `turn/interrupt` acks remain best-effort. They are synthesized only when the proxy can safely identify `threadId` and `turnId`; otherwise the request forwards to upstream.
- The proxy must never run full `JSON.parse` or full-frame `raw.toString()` on large frames.
- Pending method attribution must use only top-level JSON-RPC ids. Nested `id` fields inside `params`, `result`, `thread`, or `turns` must not set or clear pending methods.
- A response whose top-level id appears after a large result must still clear the matching pending method.
- Large `thread/start`, `thread/fork`, `thread/started`, `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, and `thread/status/changed` frames either emit the same Freshell-owned side effects as small frames or fail closed. They are never silently raw-forwarded as successful normal traffic.
- A `thread/fork` response with a valid deterministic rollout path is an intentional Codex terminal identity handoff: the old session binding is released, the forked thread becomes the current candidate, stale proof state is cleared, and the normal rollout proof must pass before the forked thread is marked durable.
- Once a `thread/fork` response candidate is observed, the proxy must not forward subsequent `turn/start` requests until the fork handoff is persisted or rejected. This closes the race where post-fork turns arrive before TerminalRegistry has replaced the old candidate.
- `requireCandidatePersistence: false` means "do not wait for a fresh startup identity before first user input." It must not disable `fork_handoff` gates, because resumed terminals can still fork into a new durable thread.
- `markCandidatePersisted()` releases held `turn/start` frames for both startup capture and fork handoff gates. The proxy should log the gate reason so timeout and release behavior can be diagnosed without logging frame bodies.
- A `thread_fork_response` candidate without a deterministic absolute rollout path must not keep the terminal running under the old durable identity. The registry keeps the old store record untouched, but the proxy times out or fails the fork handoff gate and emits `proxy_error`/socket closure before user input is accepted on the untracked fork.
- A mismatched candidate from `thread_start_response` or `thread_started_notification` after an initial candidate is already persisted remains ignored; fork handoff must not weaken the startup-race protection.
- `fs/changed` extraction may collapse an oversized `changedPaths` array to `[]` only after extracting the watch id. This is conservative because terminal registry treats an empty changed path list as a durability proof request rather than as "no change."
- Raw forwarding for non-state upstream frames is allowed only under `MAX_RAW_FORWARD_BYTES` after the constrained-heap stress test passes against the actual proxy implementation.
- Logs remain structured and must not include full request or response bodies.

## Constants

Use exported named constants where tests need to assert policy:

```ts
export const MAX_FULL_PARSE_BYTES = 1 * 1024 * 1024
export const MAX_RAW_FORWARD_BYTES = 64 * 1024 * 1024
export const MAX_SCANNED_TOKEN_BYTES = 8 * 1024
```

`MAX_FULL_PARSE_BYTES` is only a threshold for choosing between existing Zod-backed full parsing and bounded extraction. It is not a validity limit and must not cause large valid client requests to be rejected. `MAX_RAW_FORWARD_BYTES` is an operational server memory-safety cap for frames Freshell does not own; keep 64 MiB only if the constrained-heap actual-proxy fixture in Task 6 passes at `MAX_RAW_FORWARD_BYTES - 1024`, otherwise lower the constant to the highest passing boundary and update the above-cap test to match. `MAX_SCANNED_TOKEN_BYTES` limits individual key/string token accumulation in scanners and rewriters, not whole-frame size.

## Proven Inputs For This Plan

- Existing focused proxy baseline is green before implementation: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts` passed 15 tests during plan revision 5.
- `server/coding-cli/codex-app-server/remote-proxy.ts` is the OOM-prone path: both `handleClientMessage` and `handleUpstreamMessage` call `parseJson(raw)`, and `parseJson` calls `JSON.parse(raw.toString())`.
- `server/coding-cli/codex-app-server/protocol.ts` defines `CodexThreadForkParamsSchema.excludeTurns` and `CodexThreadOperationResultSchema.thread`, so compact fork requests and compact operation responses are first-class protocol shapes locally.
- `server/fresh-agent/adapters/codex/adapter.ts` already sends `excludeTurns: true` for fresh-agent forks.
- `shared/codex-durability.ts` currently omits `thread_fork_response` from `CodexCandidateSourceSchema`.
- `server/terminal-registry.ts` currently drops fork-like identity changes: `persistCodexCandidateSerial` returns immediately when `record.resumeSessionId` exists and logs/ignores mismatched candidates when `record.codexDurability.candidate` already exists.
- `server/terminal-registry.ts` already has the primitives needed for a narrow handoff: `buildCodexDurabilityRef`, `replaceCodexDurabilityStoreRecord`, `releaseBinding(..., 'rebind', ...)`, `unwatchCodexRollout`, `armCodexRolloutWatch`, and the existing rollout proof path that binds only after proof success.
- `node_modules/ws/lib/websocket-server.js` and `node_modules/ws/lib/websocket.js` show the default `maxPayload` is 100 MiB. `node_modules/ws/lib/receiver.js` shows payload-length enforcement before emission and text messages emitted as `Buffer` objects.
- A disposable raw WebSocket proxy experiment under `node --max-old-space-size=128` forwarded 64 MiB text JSON frames as buffers without full parse/stringify. The actual implementation must reproduce this through the Task 6 child-process fixture before depending on the cap.
- `codex --version` reports `codex-cli 0.142.5` in this workspace, and both `~/.codex/auth.json` and `~/.codex/config.toml` exist, so the opt-in real terminal TUI fork contract is expected to run rather than skip during execution.

## Implementation Tasks

### Task 1: Add A Tested JSON-RPC Envelope Scanner

**Files:**
- Create: `server/coding-cli/codex-app-server/json-rpc-envelope.ts`
- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts`

- [ ] **Step 1: Write failing scanner tests**

Add tests for:

- top-level string and numeric ids
- method before and after params
- top-level id after a large `result`
- nested ids before the top-level id
- escaped strings
- `Buffer`, `ArrayBuffer`, `Buffer[]`, and string input
- unsupported batch arrays
- malformed JSON
- no `JSON.parse` calls
- no full-frame `Buffer.prototype.toString` on large buffers
- a deterministic generated corpus of bounded JSON-RPC objects where scanner output is compared with `JSON.parse` for top-level `id` and `method`

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts --config vitest.server.config.ts
```

Expected: FAIL because the scanner module does not exist.

- [ ] **Step 3: Implement the scanner**

Implement `scanJsonRpcEnvelope(raw)` as a byte-level state machine:

- require a root object, not a batch
- track root depth, string state, escapes, and token boundaries
- decode only top-level property names and top-level string or integer values for `id` and `method`
- ignore nested properties
- return `{}` or a partial envelope on malformed or unsupported values
- limit individual scanned tokens with `MAX_SCANNED_TOKEN_BYTES`
- expose enough instrumentation in tests, not production behavior, to prove large-buffer scanner tests do not call `JSON.parse` or full-frame `toString`

- [ ] **Step 4: Run scanner tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-app-server/json-rpc-envelope.ts test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts
git commit -m "test: cover codex json rpc envelope scanning"
```

### Task 2: Add Bounded Fork Rewrite And Side-Effect Extractors

**Files:**
- Create: `server/coding-cli/codex-app-server/json-rpc-side-effects.ts`
- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts`

- [ ] **Step 1: Write failing fork rewrite tests**

Add tests proving `rewriteThreadForkExcludeTurns(raw)`:

- changes `excludeTurns: false` to `true`
- changes `excludeTurns: null` to `true`
- preserves `excludeTurns: true`
- appends `excludeTurns: true` to a params object that lacks it
- creates `params: { excludeTurns: true }` when params is absent
- preserves unrelated top-level fields and params fields
- rewrites large fork requests without `JSON.parse` or full-frame `toString`
- returns a structured failure for malformed frames or a non-object params value
- matches `JSON.parse` plus an object-level `excludeTurns: true` rewrite for a deterministic generated corpus of bounded valid fork requests

- [ ] **Step 2: Write failing side-effect extractor tests**

Add tests proving large frames can recover:

- candidate from `thread/start` response with `result.thread.turns` before top-level id
- candidate from `thread/fork` response with `result.thread.turns` before top-level id
- candidate from `thread/started` notification with a huge `thread.turns`
- turn started and completed metadata when the turn body is huge
- `thread/closed` and `thread/status/changed` lifecycle metadata
- `fs/changed` watch id with bounded paths
- `fs/changed` watch id with an oversized path list collapsed to `[]`

Also add negative tests proving nested decoy fields do not win over the owned path and malformed/unrecoverable frames return failure.
For every bounded valid side-effect fixture, add a paired differential assertion: parse the same frame through existing Zod schemas and verify the bounded extractor returns the same candidate, turn event, lifecycle event, or repair trigger fields that Freshell owns.

- [ ] **Step 3: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts --config vitest.server.config.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement the rewriter and extractors**

Use byte-level scanning helpers. Do not introduce a general JSON parser. Keep helpers focused on the known JSON-RPC shapes:

- top-level request object
- top-level `params` object for fork rewrite
- `result.thread` for `thread/start` responses
- `params.thread` and selected `params` fields for notifications

Return discriminated results such as:

```ts
type RewriteResult =
  | { ok: true; frame: ProxyFrame }
  | { ok: false; reason: string }

type ExtractResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }
```

- [ ] **Step 5: Run tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/json-rpc-side-effects.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts
git commit -m "test: cover bounded codex proxy extraction"
```

### Task 3: Preserve Proxy Frames And Stop Client-Wide Size Rejection

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add failing proxy client tests**

Add tests proving:

- text and binary upstream frames are forwarded with their original `isBinary` flag
- held `turn/start` text frames preserve text framing after release
- large valid non-fork client requests raw-forward rather than receiving a size error
- large `turn/start` requests are held and then raw-forwarded after `markCandidatePersisted()`
- held `turn/start` requests identify whether they are waiting on `initial_capture` or `fork_handoff`, and both gate reasons release through the same `markCandidatePersisted()` acknowledgement path
- large `thread/fork` requests are rewritten to include `excludeTurns: true`
- malformed or unrewriteable `thread/fork` requests receive a JSON-RPC error and are not forwarded
- duplicate `turn/interrupt` acks still work for normal small requests
- large `turn/interrupt` frames that cannot safely expose params are forwarded rather than parsed

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "frame|large valid|thread/fork|turn/start|turn/interrupt"
```

Expected: FAIL because the current proxy full-parses and stringifies every frame.

- [ ] **Step 3: Implement raw frame preservation and client routing**

In `remote-proxy.ts`:

- introduce a `ProxyFrame` type carrying original raw data plus explicit text/binary framing
- replace the single `candidatePersisted` boolean with a small identity-gate state, for example `{ reason: 'initial_capture' | 'fork_handoff'; timer?: NodeJS.Timeout } | undefined`; initialize it only for `initial_capture` when `requireCandidatePersistence` is true, but allow `thread/fork` responses to create a `fork_handoff` gate regardless of that option
- make `sendIfOpen` preserve text/binary framing with `socket.send(data, { binary })`
- use `scanJsonRpcEnvelope(raw)` for method and id
- store `pendingMethods` from scanned top-level id and method only after deciding the request will be forwarded
- hold `turn/start` by scanned method/id without parsing params whenever an identity gate is active
- call `rewriteThreadForkExcludeTurns(raw, isBinary)` for `thread/fork`; forward the rewritten frame on success and send a JSON-RPC error on failure
- keep small-frame duplicate interrupt ack behavior through existing Zod parsing under `MAX_FULL_PARSE_BYTES`
- forward large non-fork requests raw

- [ ] **Step 4: Run focused tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: compact codex fork requests without rejecting large clients"
```

### Task 4: Implement Large Upstream Side-Effect Recovery

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add failing upstream policy tests**

Add tests proving:

- a large `thread/fork` response with top-level id after `result` is raw-forwarded and clears `pendingMethods`
- small and large `thread/fork` responses recover and emit a `thread_fork_response` candidate before forwarding
- after a `thread/fork` response emits a fork candidate, an immediate client `turn/start` is held and not forwarded upstream until `markCandidatePersisted()` is called
- if a fork handoff gate times out before `markCandidatePersisted()`, the proxy emits `proxy_error`, sends a clear JSON-RPC error for the held `turn/start`, and closes both sockets without emitting `candidate_capture_timeout`
- nested `result.id` does not clear `pendingMethods`
- large `thread/start` responses recover and emit candidate side effects before forwarding
- large `thread/started` notifications recover candidate and lifecycle side effects before forwarding
- large `turn/started` and `turn/completed` notifications recover turn side effects before forwarding
- large `fs/changed` notifications recover watch id and trigger durability proof, using `[]` when path list is too large
- large `thread/closed` and `thread/status/changed` notifications recover lifecycle/lifecycle-loss side effects before forwarding
- unrecoverable large stateful upstream frames close both sockets and emit candidate-capture failure or `proxy_error`, depending on lifecycle state
- small stateful frames still use the current Zod-backed behavior
- frames above `MAX_RAW_FORWARD_BYTES` fail closed even when non-state

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "large thread/fork|large thread/start|large thread/started|large turn|large fs|large thread/status|raw forward cap|unrecoverable"
```

Expected: FAIL because the current proxy has no bounded upstream side-effect recovery.

- [ ] **Step 3: Implement upstream policy**

In `handleUpstreamMessage`:

- create a `ProxyFrame` from original raw data and frame type
- scan top-level id and method
- if scanned id matches a pending method, capture and delete that pending method
- if frame bytes exceed `MAX_RAW_FORWARD_BYTES`, fail closed before forwarding
- ensure the proxy-side `WebSocketServer` and upstream `WebSocket` client set `maxPayload: MAX_RAW_FORWARD_BYTES` so `ws` rejects above-cap messages before application handlers receive them where possible
- if frame bytes are under `MAX_FULL_PARSE_BYTES`, keep existing full-parse/Zod behavior
- if frame is large and stateful, call the matching bounded extractor and emit the same side effects as the existing parsed path
- when a `thread/fork` response yields a candidate, begin a `fork_handoff` identity gate before forwarding the response to the TUI; release the gate only when TerminalRegistry calls `markCandidatePersisted()`
- if the extractor succeeds, forward the original frame
- if the extractor fails, call `failUnsafeUpstreamFrame(connection, method, reason)`
- if frame is large and non-state, raw-forward the original frame

Stateful methods are:

```ts
const STATEFUL_RESPONSE_METHODS = new Set(['thread/start', 'thread/fork'])
const STATEFUL_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'turn/started',
  'turn/completed',
  'fs/changed',
  'thread/closed',
  'thread/status/changed',
])
```

Implement fail-closed behavior:

- candidate-bearing `thread/start` or `thread/fork` frame before required identity capture can complete: `failCandidateCapture('Freshell could not safely capture Codex restore identity from an oversized app-server frame.')`
- fork handoff timeout after the original identity was already durable: structured warning, `emitRepairTrigger({ kind: 'proxy_error', error })`, fail any held `turn/start` request with a JSON-RPC error explaining the fork identity was not persisted, and close client and upstream; do not emit `candidate_capture_timeout`
- all other unrecoverable stateful or above-cap frames: structured warning, `emitRepairTrigger({ kind: 'proxy_error', error })`, close client and upstream

- [ ] **Step 4: Run focused tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: recover codex proxy side effects from large frames"
```

### Task 5: Preserve Codex Terminal Identity Across Fork Handoffs

**Files:**
- Modify: `shared/codex-durability.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.codex-sidecar.test.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Add failing fork identity tests**

Add tests proving:

- `CodexRemoteProxy` emits a candidate with `source: 'thread_fork_response'` when a `thread/fork` response contains `result.thread.id`, `result.thread.path`, and `result.thread.ephemeral`
- a terminal with an existing durable Codex identity accepts a valid `thread_fork_response` candidate as an intentional handoff
- the handoff releases the old session binding, clears stale `durableThreadId`, stale `turnCompletedAt`, stale proof failure, and in-flight proof state, writes the forked candidate as `captured_pre_turn`, arms the new rollout watch, and broadcasts `terminal.codex.durability.updated`
- the forked thread is not broadcast as `terminal.session.associated` until the normal rollout proof succeeds
- after the next forked-thread `turn/completed` and rollout proof success, the terminal binds to the forked thread and broadcasts the new session association
- ordinary mismatched `thread_start_response` and `thread_started_notification` candidates after initial persistence are still ignored and keep the existing warning behavior
- invalid fork candidates without an absolute rollout path do not unbind the old durable identity and do not call `markCandidatePersisted()`, so the proxy's fork handoff gate fails closed instead of allowing untracked post-fork input
- an immediate post-fork `turn/started` or `turn/completed` notification that arrives before `markCandidatePersisted()` is not the success path; the proxy-level gate must be the mechanism that prevents this race by holding the initiating `turn/start`

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "fork.*identity|thread_fork_response|mismatched Codex restore identity"
```

Expected: FAIL because `thread_fork_response` is not a valid candidate source and terminal registry currently ignores all mismatched candidates after initial persistence.

- [ ] **Step 3: Implement fork handoff**

Implement the handoff as a narrow source-specific path:

- add `thread_fork_response` to `CodexCandidateSourceSchema`
- extend `CodexRemoteProxyCandidate['source']` with `thread_fork_response`
- emit `thread_fork_response` from `remote-proxy.ts` for small and large `thread/fork` responses after matching the pending top-level response id
- in `persistCodexCandidateSerial`, keep the existing mismatched-candidate ignore path for non-fork sources
- for `thread_fork_response`, validate the candidate with `buildCodexDurabilityRef`
- release the current binding with reason `rebind` using the old durable `resumeSessionId` or `durableThreadId`, clear `resumeSessionId`, clear stale Codex active turn/unconfirmed-input/proof state, replace durability with the forked candidate in `captured_pre_turn`, unwatch the old rollout path, arm the new rollout watch, and broadcast durability
- call `record.codexSidecar?.markCandidatePersisted?.()` only after the valid fork handoff durability record is written and installed on the running terminal record; this releases proxy-held post-fork `turn/start` traffic after Freshell can attribute its turn events to the new candidate
- do not mark the forked thread durable or send `terminal.session.associated` until the normal rollout proof succeeds
- if the fork candidate is invalid, log and preserve the existing durable identity, but do not acknowledge the proxy gate; the proxy must close on fork handoff timeout rather than allowing future turns to run under stale identity

- [ ] **Step 4: Run focused tests to verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "fork.*identity|thread_fork_response|mismatched Codex restore identity"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/codex-durability.ts server/terminal-registry.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: preserve codex terminal identity after fork"
```

### Task 6: Add A Constrained-Heap Large-Forward Stress Test

**Files:**
- Create: `test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Write the child-process fixture**

Create a fixture that:

- starts a controlled upstream WebSocket server
- starts `CodexRemoteProxy` with `requireCandidatePersistence: false`
- connects a TUI WebSocket to the proxy
- supports separate modes for:
  - a large stateful `thread/fork` response whose top-level id appears after `result.thread.turns`
  - a large non-state response whose top-level id appears after a large `result`
  - an above-cap non-state response
- for the `thread/fork` mode, sends a `thread/fork` request, has upstream assert the rewritten request contains `excludeTurns: true`, then sends a large response with `result.thread.id`, `result.thread.path`, `result.thread.ephemeral`, and a huge `result.thread.turns` decoy before the top-level id
- subscribe to `proxy.onCandidate`, assert the `thread_fork_response` candidate, and call `proxy.markCandidatePersisted()` in the child fixture before sending any follow-up `turn/start` traffic; this proves the fork gate can be released without depending on TerminalRegistry in the stress fixture
- for the non-state modes, sends a request with a method outside `STATEFUL_RESPONSE_METHODS` such as `model/list`, then has upstream send the large or above-cap response with the matching top-level id after the large `result`
- asserts the TUI receives the same byte length for both below-cap success modes and that the proxy emits `thread_fork_response` for the stateful fork mode
- exits non-zero if the process OOMs, times out, parses the body, loses the response, fails to recover the fork candidate, or incorrectly forwards the above-cap frame

Use payloads at the limit boundary, not merely convenient large samples. Build text JSON-RPC response buffers with total byte length `MAX_RAW_FORWARD_BYTES - 1024` so both successful paths prove the actual configured cap. Generate them from `Buffer` chunks instead of constructing huge JS strings, have the upstream send them as text WebSocket frames with `{ binary: false }`, and assert the client receives `isBinary === false`.

- [ ] **Step 2: Add the parent Vitest cases**

Launch the fixture once for the stateful fork-response mode and once for the non-state raw-forward mode with a constrained heap:

```ts
await execFileAsync(process.execPath, [
  '--max-old-space-size=128',
  '--import',
  'tsx',
  childPath.pathname,
], {
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
})
```

- [ ] **Step 3: Run the stress tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "constrained heap"
```

Expected before the bounded extractor and raw-forward paths are complete: FAIL by child OOM, timeout, missing `thread_fork_response`, or explicit assertion. Expected after Task 4 implementation is complete: PASS and report the forwarded byte length, `isBinary === false`, and an RSS/heap sample for both success modes confirming the proxy did not materialize the payload as a parsed JS object.

If either success mode fails at the 64 MiB boundary after the no-parse path is implemented, do not weaken the test. Lower `MAX_RAW_FORWARD_BYTES` to the highest boundary where both success modes pass, update all boundary tests, and document the measured RSS/heap output in the implementation report.

- [ ] **Step 4: Add the above-cap child-process case**

Extend the child fixture or add a sibling mode that sends a non-state upstream frame with total byte length `MAX_RAW_FORWARD_BYTES + 1024`, again generated from `Buffer` chunks. Assert the proxy fail-closes the frame and emits `proxy_error` instead of forwarding it to the TUI.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts server/coding-cli/codex-app-server/remote-proxy.ts
git commit -m "test: stress codex proxy large response forwarding"
```

### Task 7: Add The Opt-In Real TUI Fork Contract

**Files:**
- Create: `test/integration/real/codex-remote-fork-contract.test.ts`

- [ ] **Step 1: Write the skipped contract test**

Follow the existing real-provider pattern in `test/integration/real/codex-app-server-readiness-contract.test.ts`: skip unless `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1` and `codex` is available. Use an isolated temporary `CODEX_HOME`; copy `~/.codex/auth.json` and `~/.codex/config.toml` when available, and skip with a clear reason when required local Codex credentials are unavailable. Clean the temporary root in test cleanup.

The test must:

- start a controlled WebSocket app-server on localhost
- start `CodexRemoteProxy` with that app-server as `upstreamWsUrl`
- subscribe to proxy candidates and call `proxy.markCandidatePersisted()` after observing the root `thread_start_response` and the later `thread_fork_response`, mirroring TerminalRegistry's positive persistence acknowledgement so the real TUI contract tests compact fork compatibility rather than hanging on the intentional identity gate
- launch `codex --remote <proxy.wsUrl> ...CODEX_MANAGED_REMOTE_CONFIG_ARGS --no-alt-screen` through `node-pty`
- respond to `initialize`, `thread/start`, and common bootstrap requests with minimal valid results; the `thread/start` result must include a deterministic absolute rollout path so the startup candidate can be acknowledged
- wait until a root thread is started
- write `/fork\r` to the PTY
- capture the upstream `thread/fork` request after proxy rewriting
- assert the upstream request contains `excludeTurns: true`
- respond with a minimal fork result that omits `turns` but includes a deterministic forked thread id and rollout path
- assert the TUI stays alive long enough to accept a follow-up harmless key or exit command
- assert the proxy emits `thread_fork_response`; TerminalRegistry durability handoff remains covered by the focused tests in Task 5

- [ ] **Step 2: Run the contract opt-in**

Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS in this workspace because `codex` and local auth/config are available. A protocol failure is a blocker and means the production approach must be revised before continuing. If a future execution environment lacks `codex` or credentials, stop and report `USER_DECISION_REQUIRED` for the missing real-provider proof instead of treating the opt-in contract as optional completion evidence.

- [ ] **Step 3: Run the default skipped contract path**

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

### Task 8: Final Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused server tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused TerminalRegistry fork identity tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts --config vitest.server.config.ts --testNamePattern "fork.*identity|mismatched Codex restore identity"
```

Expected: PASS.

- [ ] **Step 3: Run the opt-in real fork contract when Codex is available**

Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS in this workspace. If `codex` or auth/config are unexpectedly missing, stop and report the missing proof; do not accept a skip as completion evidence for the terminal TUI compatibility risk. A protocol failure is a blocker.

- [ ] **Step 4: Run the repo check**

Coordinate through the repo wrapper:

```bash
FRESHELL_TEST_SUMMARY="codex fork oom bounded proxy extraction" npm run check
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only the planned files changed; no whitespace errors.

- [ ] **Step 6: Commit any final cleanup**

If verification required small cleanup:

```bash
git add shared/codex-durability.ts server/terminal-registry.ts server/coding-cli/codex-app-server/json-rpc-envelope.ts server/coding-cli/codex-app-server/json-rpc-side-effects.ts server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts test/integration/real/codex-remote-fork-contract.test.ts
git commit -m "chore: finalize codex fork oom fix"
```

## Completion Criteria

- Terminal `thread/fork` upstream requests always include `excludeTurns: true`.
- Large valid non-fork client requests are not rejected solely because they are large.
- Large fork requests are compacted without full-frame JSON parsing.
- Large fork responses under the proven raw-forward cap reach the TUI without full proxy-side JSON parsing or full-frame `toString()`.
- Terminal fork responses update Freshell's Codex durable identity to the forked thread candidate without marking it durable before rollout proof.
- Immediate post-fork `turn/start` requests are held until the forked identity is persisted, including for resumed terminals whose startup identity capture was disabled with `requireCandidatePersistence: false`.
- Invalid fork candidates do not unbind the old durable identity and do not allow the terminal to continue accepting untracked post-fork input.
- Upstream frames above `MAX_RAW_FORWARD_BYTES` fail closed instead of risking server OOM.
- The proxy preserves text/binary WebSocket frame semantics.
- Pending method attribution is based only on top-level JSON-RPC ids, including ids after large results.
- Large state-bearing frames either produce the same Freshell-owned side effects as small frames or fail closed with recovery; none are silently ignored.
- Existing candidate capture, turn notification, fs-change, lifecycle, and duplicate interrupt behavior remains covered and passing.
- The opt-in real Codex TUI `/fork` contract passes locally in this workspace, or execution stops with the exact missing-proof or protocol failure.
- `npm run check` passes before handoff.
