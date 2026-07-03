# Codex Fork OOM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal Codex `/fork` memory-safe in Freshell without breaking the terminal Codex TUI route or silently losing Freshell-owned proxy state.

**Architecture:** Keep request compaction and large-frame memory safety inside the terminal Codex remote proxy, with an explicit staged TerminalRegistry handoff for the new thread identity created by `/fork`. The proxy will first prove a byte-level JSON-RPC envelope scanner, a `thread/fork` request rewriter, and bounded side-effect extractors against differential and adversarial fixtures; only after those helpers are proven will it integrate them into proxy forwarding. Large frames Freshell does not own are raw-forwarded only below a measured cap, while stateful frames either produce the same local side effects as small frames or fail closed. The old durable Codex binding remains the restore/recovery anchor until the forked rollout path is proven and the handoff is committed.

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
- Follow-up read-only review confirmed that `releaseBinding()` immediately clears `resumeSessionId`, while Codex restore/session references and durable recovery depend on the old `resumeSessionId` remaining authoritative. Releasing the old binding at fork-candidate time is unsafe because the forked thread is not durable until rollout proof succeeds.
- Pre-implementation contract runs proved the current real shapes for Codex 0.142.5:
  - A just-created empty parent thread cannot be forked by the app-server; `thread/fork` fails with `no rollout found for thread id ...`. The real fork-shape contract must materialize the parent with one completed turn before forking.
  - With `excludeTurns: true` against a materialized parent, the real app-server `thread/fork` response carries the child durable path at `result.thread.path`; no `rolloutPath` or `rollout_path` alias is needed.
  - The real terminal TUI rejects a compact fork response that omits `result.thread.turns` with `thread/fork response decode error: missing field turns`.
  - The real terminal TUI accepts the same compact fork response when the proxy/app-server response includes `result.thread.turns: []`.

Use this policy instead:

- Never full-parse a frame solely to route or attribute it. Use a byte-level top-level JSON-RPC scanner for `id` and `method`.
- Support exactly one JSON-RPC object per WebSocket frame. Root arrays/batches are unsupported until a live Codex contract proves they are required; do not raw-forward them as non-state traffic because a batch could contain `thread/fork` or stateful frames that Freshell must transform or observe.
- Do not reject all large client frames. Large valid `initialize`, `thread/start`, `thread/resume`, `turn/start`, or other requests below `MAX_RAW_FORWARD_BYTES` should raw-forward unless the proxy must transform them. Frames above the cap fail closed in either direction because the cap is the server memory-safety boundary, not an upstream-only policy.
- Always transform terminal `thread/fork` requests to include `params.excludeTurns: true`. Implement this as a byte-level JSON object rewrite, not as `JSON.parse` plus `JSON.stringify`, so a large but valid fork request does not require materializing params as JS objects.
- If a `thread/fork` request is malformed enough that the rewriter cannot safely force `excludeTurns: true`, return a JSON-RPC error and do not forward it. Forwarding an un-compacted fork request reintroduces the crash class.
- Hold startup `turn/start` before initial candidate persistence using only the scanned top-level method and id. Do not require parsing `turn/start.params`.
- Keep the duplicate `turn/interrupt` ack optimization only for frames whose params can be parsed or bounded-extracted safely. If params cannot be inspected without full materialization, forward the interrupt normally.
- For upstream frames, scan first. Full `JSON.parse` is an optimization only for small frames, never the only correctness path.
- For frames larger than `MAX_FULL_PARSE_BYTES`, do not call full-frame `JSON.parse`, `JSON.stringify`, or `raw.toString()`. `JSON.stringify` is allowed only for small proxy-generated errors/acks, never to reconstruct a forwarded frame.
- For stateful upstream frames that are too large for full parsing, use method-specific bounded extractors for just the fields Freshell owns:
  - `thread/start` response and `thread/started`: `thread.id`, `thread.path`, `thread.ephemeral`
  - `thread/fork` response: `thread.id`, `thread.path`, `thread.ephemeral`
  - `turn/started`: `params.threadId`, `params.turnId`
  - `turn/completed`: `params.threadId`, `params.turnId`, `params.status`, `params.turn.status`
  - `fs/changed`: `params.watchId`, and bounded `changedPaths`; if `changedPaths` is too large but `watchId` is known, emit an empty `changedPaths` array to conservatively request durability proof
  - `thread/closed`: `params.threadId`
  - `thread/status/changed`: `params.threadId`, `params.status.type`
- If a stateful upstream frame cannot be fully parsed and the required bounded side-effect extractor also cannot recover the owned fields, fail closed with structured logging, `proxy_error` or candidate-capture failure as appropriate, and socket closure. Do not forward it as a successful normal frame.
- Treat `thread/fork` response candidates as intentional staged handoffs, not immediate rebinds. Preserve the existing startup-race protection for ordinary mismatched `thread_start_response` and `thread_started_notification` candidates.
- A `thread_fork_response` candidate is valid only when it is matched by top-level JSON-RPC id to a forwarded `thread/fork` request, uses `result.thread.id`, uses the same response thread's `path`, has a nonempty absolute path, has `ephemeral !== true`, and the child thread id differs from the old durable/resume/request parent id. If multiple path-like fields are present, they must agree exactly after normalization; disagreement, missing/null/relative path, same-as-parent id, or `ephemeral: true` makes the candidate invalid.
- Because current Codex TUI requires `thread.turns` in fork operation responses, the proxy must normalize the TUI-facing `thread/fork` response to include `result.thread.turns: []` when upstream omitted it due to `excludeTurns: true`. This response normalization must be bounded and must not re-expand or fetch historical turns.
- A fork handoff has these required states, whether represented as a transient `TerminalRecord` subobject or equivalent code: `fork_handoff_staged`, `fork_turn_in_progress_unproven`, `fork_proof_checking`, `fork_durable_committed`, and `fork_handoff_failed`. In the staged/proof states, the old `resumeSessionId`, old session binding, and old durable store record remain authoritative for restore/recovery.
- The proxy-side `fork_handoff` gate starts before forwarding the matching `thread/fork` response to the TUI. TerminalRegistry may call `markCandidatePersisted()` only after it has staged the fork candidate and can attribute fork-thread events to that staged candidate. This releases queued post-fork traffic; it does not mean the fork is durable.
- During a fork handoff gate, queue bounded, raw-frame-preserving post-fork stateful client traffic, not only `turn/start`. At minimum this includes `turn/start`, `turn/steer`, `turn/interrupt`, nested `thread/fork`, `thread/compact/start`, and other thread-mutating methods. Queue or fail closed stateful upstream notifications attributable to the fork thread until the staged candidate is installed. Allow only the rewritten `thread/fork` request, the matching `thread/fork` response after candidate extraction and gate setup, and clearly non-state/global traffic under the raw-forward cap.
- Do not call `releaseBinding()`, clear `resumeSessionId`, replace the old durable identity, or broadcast `terminal.session.associated` when the fork candidate is merely staged. On proof success, commit atomically: rebind from the old durable thread to the proven fork thread, set `resumeSessionId` and `durableThreadId` to the fork id, write the new durable record, clear staged handoff/proof state, unwatch stale rollout paths, and then broadcast the new session association. There must be no externally visible unbound interval.
- On invalid candidate, persistence failure, timeout, queue overflow, or proof failure, preserve the old durable binding and store record, fail/close the proxy before accepting more post-fork traffic, and do not let the terminal continue under an untracked fork identity.
- Raw-forward oversized non-state frames only up to a raw-forward limit that is proven at the limit boundary by a constrained-heap child-process stress test using the actual proxy. Treat that limit as an operational memory-safety cap, not as proof that larger frames are invalid. Frames above it fail closed in both client-to-upstream and upstream-to-client directions to preserve the Freshell server.
- The opt-in real app-server fork-shape and real terminal TUI fork contracts have now run in this workspace with `codex` 0.142.5 plus local auth/config. Implementation may rely on `result.thread.path` for fork candidate extraction and must preserve TUI compatibility by injecting `turns: []` into compact fork responses forwarded to the TUI.

No user decision is required for this revision. The remaining proof before completion is the opt-in constrained-heap final gate. Keep ordinary implementation iterations resource-light by using bounded generated fixtures and small test-cap overrides; reserve 64 MiB actual-proxy stress for the final gate.

## File Structure

- Create: `server/coding-cli/codex-app-server/json-rpc-envelope.ts`
  - Byte-level scanner for top-level JSON-RPC `id` and `method`.
  - Does not call `JSON.parse` or full-frame `toString()`.

- Create: `server/coding-cli/codex-app-server/json-rpc-side-effects.ts`
  - Byte-level bounded extractors for the small fields Freshell owns in large stateful upstream frames.
  - Byte-level `thread/fork` request rewriter that forces `params.excludeTurns = true`.
  - Bounded `thread/fork` response normalizer that injects `result.thread.turns: []` for the TUI when upstream omitted turns.

- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts`
  - Scanner contract and malformed-frame coverage.
  - Differential corpus comparing scanner output to `JSON.parse` for bounded generated JSON-RPC messages.

- Create: `test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts`
  - Fork rewrite and side-effect extractor coverage, including large payloads with nested `id`, `method`, and `turns`.
  - Differential corpus comparing bounded extractor output to existing Zod-backed behavior for bounded frames.

- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
  - Preserve raw frame data and text/binary framing.
  - Generalize candidate persistence from a one-time startup boolean into a source-aware identity gate for `initial_capture` and `fork_handoff`; `requireCandidatePersistence: false` disables only the startup `initial_capture` gate, not later fork handoff gates.
  - After emitting a valid-looking `thread_fork_response` candidate, hold bounded stateful post-fork client requests until TerminalRegistry acknowledges staged persistence through `markCandidatePersisted()`.
  - Fail closed if a fork handoff gate times out or TerminalRegistry never acknowledges it; do not silently forward post-fork user input against the old durable identity.
  - Use scanner attribution for pending methods and identity-gate holds.
  - Force `thread/fork.params.excludeTurns = true` through the byte-level rewriter.
  - Normalize matching `thread/fork` responses before forwarding them to the TUI so `result.thread.turns` is an empty array when upstream omitted it.
  - Emit candidate side effects from `thread/fork` responses with source `thread_fork_response`.
  - Use bounded side-effect extractors before fail-closing large stateful upstream frames.
  - Raw-forward non-state frames under the tested raw-forward limit and fail closed above the cap in both directions.

- Modify: `shared/codex-durability.ts`
  - Add `thread_fork_response` as a valid Codex candidate source.

- Modify: `server/terminal-registry.ts`
  - Add deliberate staged Codex fork identity handoff handling for candidates whose source is `thread_fork_response`.
  - Keep the old durable binding authoritative until fork rollout proof commits the handoff.
  - Preserve existing initial-candidate mismatch protection for non-fork candidates.

- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
  - Regression coverage for fork rewriting, fork response candidate emission, large valid client forwarding, stateful side-effect recovery, fail-closed unrecoverable state frames, raw forwarding, frame type preservation, pending id attribution, and duplicate interrupt behavior.

- Modify: `test/unit/server/terminal-registry.codex-sidecar.test.ts`
  - Regression coverage for fork candidate staging, proof-time durable replacement, and ordinary mismatched startup candidates remaining ignored.

- Create: `test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts`
  - Constrained-heap stress fixture proving the actual proxy forwards both a large stateful `thread/fork` response after bounded candidate extraction and large non-state frames below `MAX_RAW_FORWARD_BYTES` without full-parse or full-stringify, and fail-closes frames above the cap.

- Create: `test/integration/real/codex-app-server-fork-shape-contract.test.ts`
  - Opt-in real Codex app-server fork-shape contract proving the exact response path field for `thread/fork` with `excludeTurns: true`.

- Create: `test/integration/real/codex-remote-fork-contract.test.ts`
  - Opt-in real terminal Codex TUI `/fork` contract using `codex --remote`, `node-pty`, an isolated `CODEX_HOME`, `CODEX_MANAGED_REMOTE_CONFIG_ARGS`, and a controlled WebSocket app-server.

- Do not modify: `server/fresh-agent/adapters/codex/adapter.ts`
  - Fresh-agent Codex already uses `excludeTurns: true`; keep it as supporting evidence only.

- Do not modify: `docs/index.html`
  - This is a server reliability fix with no user-facing UI change.

## Contracts And Invariants

- The terminal Codex proxy supports one JSON-RPC object per WebSocket frame. Root arrays/batches are unsupported until a live Codex contract proves they are required. Root arrays must not be classified as non-state traffic and must not be raw-forwarded; client batches fail with an invalid-request error when possible plus `proxy_error`/socket close, and upstream batches fail closed before forwarding.
- Terminal `thread/fork` requests sent upstream must preserve original JSON-RPC fields and params except `params.excludeTurns` is always `true`.
- If the TUI sends `excludeTurns: false` or `excludeTurns: null`, upstream receives `excludeTurns: true`.
- If the TUI omits `params`, upstream receives a params object containing `excludeTurns: true`.
- Upstream compact `thread/fork` responses may omit `result.thread.turns`; the TUI-facing response must include `result.thread.turns: []`. Codex 0.142.5 rejects a missing `turns` field during fork bootstrap.
- A large valid non-fork client request below `MAX_RAW_FORWARD_BYTES` is not rejected merely because of size.
- Raw-forwarding means forwarding the original frame bytes with the original WebSocket `isBinary` flag. Held identity-gate frames preserve their original raw bytes and original text/binary framing until candidate persistence releases them. Rewritten `thread/fork` frames preserve framing and all original bytes except the minimal `params.excludeTurns: true` mutation.
- Duplicate `turn/interrupt` acks remain best-effort. They are synthesized only when the proxy can safely identify `threadId` and `turnId`; otherwise the request forwards to upstream.
- The proxy must never run full `JSON.parse`, full-frame `raw.toString()`, or full-frame `JSON.stringify()` on large frames. `JSON.stringify` is allowed only for small proxy-generated errors/acks, never to reconstruct a forwarded frame.
- Pending method attribution must use only top-level JSON-RPC ids. Nested `id` fields inside `params`, `result`, `thread`, or `turns` must not set or clear pending methods.
- A response whose top-level id appears after a large result must still clear the matching pending method.
- Large `thread/start`, `thread/fork`, `thread/started`, `turn/started`, `turn/completed`, `fs/changed`, `thread/closed`, and `thread/status/changed` frames either emit the same Freshell-owned side effects as small frames or fail closed. They are never silently raw-forwarded as successful normal traffic.
- Duplicate or escaped keys in any frame the proxy must transform or use for Freshell-owned side effects must be handled deterministically. If the scanner/rewriter cannot match bounded `JSON.parse` semantics for that bounded fixture, it must classify the frame as unsafe and fail closed rather than forwarding an uncompacted fork or silently dropping side effects.
- Terminology: `thread.path` is the Codex fork-response wire field proven by the real fork-shape contract; `rolloutPath` is Freshell's durability-store name. Implementation must not read or emit wire `rolloutPath`/`rollout_path` for fork candidates unless a future real fork-shape contract proves that exact field.
- A `thread_fork_response` candidate is valid only when matched by top-level JSON-RPC id to a forwarded `thread/fork` request, uses `result.thread.id`, uses the same response thread's `path`, has a nonempty absolute path, has `ephemeral !== true`, and the child thread id differs from the old durable/resume/request parent id.
- If multiple path-like fields are present, they must agree exactly after normalization; disagreement is an invalid fork candidate. Missing/null/relative path, `ephemeral: true`, same-as-parent id, or alias conflict must not call `markCandidatePersisted()`.
- A `thread/fork` response with a valid deterministic rollout path is an intentional Codex terminal identity handoff, but it is staged first. Persist the staged fork candidate in transient TerminalRegistry state, make registry event matching accept the staged fork candidate, and release the proxy's fork gate only after that state is installed. Do not call `releaseBinding()`, clear `resumeSessionId`, replace the old durable identity, or broadcast `terminal.session.associated` until rollout proof for the forked thread succeeds.
- The required fork handoff lifecycle is: `fork_handoff_staged` after a valid candidate is installed; `fork_turn_in_progress_unproven` after a fork-thread `turn/started`; `fork_proof_checking` after fork-thread completion or rollout-path change triggers proof; `fork_durable_committed` only after proof succeeds; and `fork_handoff_failed` for invalid candidate, persistence failure, timeout, queue overflow, proxy loss, or proof failure. These names may be represented as explicit enum values or equivalent structured state, but tests must prove each transition.
- During `fork_handoff_staged`, `fork_turn_in_progress_unproven`, and `fork_proof_checking`, the old durable binding remains the restore/recovery identity. The old `resumeSessionId` must remain set and the old durable store record must remain recoverable.
- On fork proof success, commit the handoff atomically: rebind from the old durable thread to the proven fork thread, set `resumeSessionId` and `durableThreadId` to the fork id, clear staged proof state, unwatch stale rollout paths, write the new durable record, and then broadcast the new session association. There must be no externally visible unbound interval.
- On invalid candidate, persistence failure, timeout, queue overflow, proxy loss, or proof failure, preserve the old durable binding and store record, fail/close the proxy before accepting further post-fork traffic, and do not let the terminal continue under an untracked fork identity.
- Once a `thread/fork` response candidate is observed, the proxy must not forward subsequent stateful post-fork client requests until the staged fork candidate is persisted or rejected. This closes the race where post-fork turns arrive before TerminalRegistry can attribute them to the staged fork candidate.
- Stateful post-fork traffic is broader than `turn/start`: queue bounded raw frames for `turn/start`, `turn/steer`, `turn/interrupt`, nested `thread/fork`, `thread/compact/start`, rollback/inject/name/metadata/archive-style thread mutations, and any other request that can mutate or advance the fork thread. Reject nested forks while a handoff is active.
- Stateful upstream notifications attributable to the fork thread must be queued or fail closed until the staged fork candidate is installed. Non-state/global traffic under the raw-forward cap may pass only when it cannot mutate or advance the fork thread.
- `requireCandidatePersistence: false` means "do not wait for a fresh startup identity before first user input." It must not disable `fork_handoff` gates, because resumed terminals can still fork into a new durable thread.
- `markCandidatePersisted()` releases held `turn/start` frames for startup capture and releases bounded held post-fork traffic for fork handoff gates. The proxy should log the gate reason so timeout and release behavior can be diagnosed without logging frame bodies.
- A `thread_fork_response` candidate without a deterministic absolute rollout path must not keep the terminal running under an untracked fork identity. The registry keeps the old store record untouched, but the proxy times out or fails the fork handoff gate and emits `proxy_error`/socket closure before user input is accepted on the untracked fork.
- A mismatched candidate from `thread_start_response` or `thread_started_notification` after an initial candidate is already persisted remains ignored; fork handoff must not weaken the startup-race protection.
- `fs/changed` extraction may collapse an oversized `changedPaths` array to `[]` only after extracting the watch id. This is conservative because terminal registry treats an empty changed path list as a durability proof request rather than as "no change."
- Any frame whose byte length exceeds `MAX_RAW_FORWARD_BYTES` fails closed in both directions before forwarding, regardless of method or statefulness. `ws` `maxPayload` rejections and application-level cap rejections must normalize to structured `proxy_error` repair signaling.
- Raw forwarding for non-state frames is allowed only under `MAX_RAW_FORWARD_BYTES` after the constrained-heap stress test passes against the actual proxy implementation; above-cap frames fail closed regardless of direction.
- The configured `MAX_RAW_FORWARD_BYTES` is valid only after an opt-in/final-gate child-process stress test proves the actual `CodexRemoteProxy`, under `node --max-old-space-size=128`, forwards `MAX_RAW_FORWARD_BYTES - 1024` text frames for both large `thread/fork` response extraction and non-state raw forwarding, rejects `MAX_RAW_FORWARD_BYTES + 1024`, preserves `isBinary === false`, and reports heap/RSS/external memory. If it fails, lower the cap to the highest passing boundary and update tests/spec.
- Logs remain structured and must not include full request or response bodies.

## Constants

Use exported named constants where tests need to assert policy:

```ts
export const MAX_FULL_PARSE_BYTES = 1 * 1024 * 1024
export const MAX_RAW_FORWARD_BYTES = 64 * 1024 * 1024
export const MAX_SCANNED_TOKEN_BYTES = 8 * 1024
export const MAX_IDENTITY_GATE_HELD_FRAMES = 16
export const MAX_IDENTITY_GATE_HELD_BYTES = MAX_RAW_FORWARD_BYTES
```

`MAX_FULL_PARSE_BYTES` is only a threshold for choosing between existing Zod-backed full parsing and bounded extraction. It is not a validity limit and must not cause otherwise valid client requests below `MAX_RAW_FORWARD_BYTES` to be rejected. `MAX_RAW_FORWARD_BYTES` is an operational server memory-safety cap for frames Freshell does not own in either direction; keep 64 MiB only if the constrained-heap actual-proxy fixture in Task 6 passes at `MAX_RAW_FORWARD_BYTES - 1024`, otherwise lower the constant to the highest passing boundary and update the above-cap tests to match. `MAX_SCANNED_TOKEN_BYTES` limits individual key/string token accumulation in scanners and rewriters, not whole-frame size. The identity-gate queue limits prevent fork handoff from becoming an unbounded memory buffer; overflow is a fork handoff failure that preserves the old durable binding and closes the proxy.

## Proven Inputs For This Plan

- Existing focused proxy baseline is green before implementation: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts` passed 15 tests during plan revision 5.
- `server/coding-cli/codex-app-server/remote-proxy.ts` is the OOM-prone path: both `handleClientMessage` and `handleUpstreamMessage` call `parseJson(raw)`, and `parseJson` calls `JSON.parse(raw.toString())`.
- `server/coding-cli/codex-app-server/protocol.ts` defines `CodexThreadForkParamsSchema.excludeTurns` and `CodexThreadOperationResultSchema.thread`, so compact fork requests and compact operation responses are first-class protocol shapes locally.
- `server/coding-cli/codex-app-server/protocol.ts` also defines `CodexThreadSchema.path` as optional/nullable with a default of `null`. The opt-in real fork-shape contract now proves current Codex 0.142.5 compact fork responses use `result.thread.path` for the child rollout path after the parent has one completed turn.
- `server/fresh-agent/adapters/codex/adapter.ts` already sends `excludeTurns: true` for fresh-agent forks.
- `shared/codex-durability.ts` currently omits `thread_fork_response` from `CodexCandidateSourceSchema`.
- `server/terminal-registry.ts` currently drops fork-like identity changes: `persistCodexCandidateSerial` returns immediately when `record.resumeSessionId` exists and logs/ignores mismatched candidates when `record.codexDurability.candidate` already exists.
- `server/terminal-registry.ts` already has some primitives needed for a narrow handoff: `buildCodexDurabilityRef`, `replaceCodexDurabilityStoreRecord`, `unwatchCodexRollout`, `armCodexRolloutWatch`, and the existing rollout proof path that binds only after proof success. It must not use `releaseBinding(..., 'rebind', ...)` until proof success, because `releaseBinding()` clears `resumeSessionId`.
- `node_modules/ws/lib/websocket-server.js` and `node_modules/ws/lib/websocket.js` show the default `maxPayload` is 100 MiB. `node_modules/ws/lib/receiver.js` shows payload-length enforcement before emission and text messages emitted as `Buffer` objects.
- A disposable raw WebSocket proxy experiment under `node --max-old-space-size=128` forwarded 64 MiB text JSON frames as buffers without full parse/stringify. The actual implementation must reproduce this through the Task 6 child-process fixture before depending on the cap.
- `codex --version` reports `codex-cli 0.142.5` in this workspace, and both `~/.codex/auth.json` and `~/.codex/config.toml` exist. Both opt-in real contracts ran locally:
  - `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-app-server-fork-shape-contract.test.ts --config vitest.server.config.ts` passed after adding one minimal parent turn; the initial no-turn version failed with `no rollout found for thread id ...`.
  - `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts` passed with a fake app-server response that includes `result.thread.turns: []`; the same contract failed when `turns` was omitted with `thread/fork response decode error: missing field turns`.
- Pre-implementation red tests are installed and intentionally failing until production code is implemented:
  - `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts --config vitest.server.config.ts` fails 8 tests on the scanner placeholder.
  - `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts --config vitest.server.config.ts` fails 9 tests on request rewrite, fork candidate extraction, and TUI response-normalization placeholders.
  - `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts -t "thread/fork|root array|post-fork"` fails because the current proxy forwards `excludeTurns:false`, forwards root batches, does not inject `turns: []`, and does not stage fork candidates.
  - `npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts --config vitest.server.config.ts -t "fork candidate|fork handoff"` fails because the current registry ignores `thread_fork_response` candidates when `resumeSessionId` is already set.

## Implementation Tasks

### Task 0: Prove The Real Fork Response Shape

**Files:**
- Create: `test/integration/real/codex-app-server-fork-shape-contract.test.ts`

- [x] **Step 1: Write the opt-in fork-shape contract**

Follow the existing real-provider contract pattern and skip unless `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`, `codex` is available, and local Codex credentials/config are available. Use an isolated temporary `CODEX_HOME` and clean it in test cleanup. The contract uses exactly one minimal parent turn because the real app-server will not fork an empty thread without a rollout.

The test must:

- connect to a real Codex app-server/runtime with local credentials
- send `initialize`
- send `thread/start` with a deterministic cwd and capture the parent `result.thread`
- send one minimal `turn/start` and wait for parent `turn/completed`
- send `thread/fork` with `excludeTurns: true`
- capture the raw fork response and assert:
  - the fork response has top-level JSON-RPC id matching the fork request
  - `result.thread.id` is nonempty
  - the child id differs from the parent thread id and requested parent id
  - the durable path field is present, non-null, absolute, and belongs to the same `result.thread`
  - `ephemeral !== true`
  - if more than one path-like field exists (`path`, `rolloutPath`, `rollout_path`), all present path-like fields agree exactly after normalization
  - `turns` may be absent or present when `excludeTurns: true`; this app-server proof does not decide the TUI-facing response shape

Record the proven wire field name in the test description and implementation comments as `result.thread.path`. The production extractor must use `path` unless this contract is updated with evidence for a different real shape.

- [x] **Step 2: Run the opt-in fork-shape contract before implementation**

Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-app-server-fork-shape-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS in this workspace because `codex` and local auth/config are available. This passed and proved `result.thread.path`. If a future run uses an unplanned field, has no deterministic absolute path, marks the fork ephemeral, or returns the same id as the parent, stop and revise this plan before implementing extraction or handoff logic.

- [x] **Step 3: Run the default skipped contract path**

Run:

```bash
npm run test:vitest -- run test/integration/real/codex-app-server-fork-shape-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS with the test skipped when the opt-in env var is absent.

- [x] **Step 4: Commit pre-implementation evidence**

```bash
git add test/integration/real/codex-app-server-fork-shape-contract.test.ts
git commit -m "test: add codex fork oom preimplementation contracts"
```

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
- escaped top-level property names such as `meth\u006fd`
- duplicate top-level `id` and `method` keys with deterministic behavior matching bounded `JSON.parse` semantics
- integer ids without coercing null, float, object, array, or boolean ids
- `Buffer`, `ArrayBuffer`, `Buffer[]`, and string input
- unsupported batch arrays reported as unsafe, not non-state traffic
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
- handle duplicate and escaped top-level keys deterministically; if bounded semantics cannot be matched, classify the frame as unsafe
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
- returns a structured failure for root arrays/batches
- handles escaped `params` and `excludeTurns` keys according to bounded `JSON.parse` semantics
- handles duplicate `params` or duplicate `excludeTurns` deterministically; if it cannot safely preserve bounded semantics while forcing `excludeTurns: true`, it fails closed
- matches `JSON.parse` plus an object-level `excludeTurns: true` rewrite for a deterministic generated corpus of bounded valid fork requests

- [ ] **Step 2: Write failing side-effect extractor tests**

Add tests proving large frames can recover:

- candidate from `thread/start` response with `result.thread.turns` before top-level id
- candidate from `thread/fork` response with `result.thread.turns` before top-level id
- candidate from `thread/fork` response using `result.thread.path`, established in Task 0
- candidate from `thread/started` notification with a huge `thread.turns`
- turn started and completed metadata when the turn body is huge
- `thread/closed` and `thread/status/changed` lifecycle metadata
- `fs/changed` watch id with bounded paths
- `fs/changed` watch id with an oversized path list collapsed to `[]`

Also add negative tests proving nested decoy fields do not win over the owned path and malformed/unrecoverable frames return failure.
Add fork-candidate negative tests for nested decoy parent ids/paths in `turns`, `path: null`, `ephemeral: true`, same-as-parent child id, conflicting path aliases, root arrays, duplicate owned keys with ambiguous semantics, and top-level response id after a large `result`.
For every bounded valid side-effect fixture, add a paired differential assertion: parse the same frame through existing Zod schemas and verify the bounded extractor returns the same candidate, turn event, lifecycle event, or repair trigger fields that Freshell owns.

- [ ] **Step 2b: Write failing TUI fork-response normalization tests**

Add tests proving `normalizeThreadForkResponseForTui(raw)`:

- adds `result.thread.turns: []` when upstream omitted it from a compact `thread/fork` response
- preserves an existing bounded `turns` array
- preserves unrelated response fields and thread metadata
- rejects root arrays/batches
- fails closed on duplicate owned keys if it cannot preserve bounded `JSON.parse` semantics

- [ ] **Step 3: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts --config vitest.server.config.ts
```

Expected: FAIL because the helper module currently contains placeholder exports only.

- [ ] **Step 4: Implement the rewriter and extractors**

Use byte-level scanning helpers. Do not introduce a general JSON parser. Keep helpers focused on the known JSON-RPC shapes:

- top-level request object
- top-level `params` object for fork rewrite
- `result.thread` for `thread/start` responses
- `params.thread` and selected `params` fields for notifications
- `result.thread.path` from Task 0 for `thread/fork` candidates; do not accept unproven path aliases in production extraction
- `result.thread.turns` insertion for TUI-facing `thread/fork` responses when upstream omitted it due to `excludeTurns: true`

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
- large valid non-fork client requests below `MAX_RAW_FORWARD_BYTES` raw-forward rather than receiving a size error
- above-cap client requests fail closed with `proxy_error` instead of reaching upstream
- large `turn/start` requests are held and then raw-forwarded after `markCandidatePersisted()`
- held identity-gate requests identify whether they are waiting on `initial_capture` or `fork_handoff`, and both gate reasons release through the same `markCandidatePersisted()` acknowledgement path
- root-array/batch client frames fail closed and are not raw-forwarded as non-state traffic
- large `thread/fork` requests are rewritten to include `excludeTurns: true`
- malformed or unrewriteable `thread/fork` requests receive a JSON-RPC error and are not forwarded
- nested `thread/fork` while a fork handoff is active fails closed instead of starting a second handoff
- identity-gate queue overflow by frame count or held bytes fails the handoff and closes the proxy
- duplicate `turn/interrupt` acks still work for normal small requests
- large `turn/interrupt` frames that cannot safely expose params are forwarded rather than parsed

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "frame|large valid|above-cap|thread/fork|turn/start|turn/interrupt"
```

Expected: FAIL because the current proxy full-parses and stringifies every frame.

- [ ] **Step 3: Implement raw frame preservation and client routing**

In `remote-proxy.ts`:

- introduce a `ProxyFrame` type carrying original raw data plus explicit text/binary framing
- replace the single `candidatePersisted` boolean with a small identity-gate state, for example `{ reason: 'initial_capture' | 'fork_handoff'; timer?: NodeJS.Timeout; heldFrames: ProxyFrame[]; heldBytes: number } | undefined`; initialize it only for `initial_capture` when `requireCandidatePersistence` is true, but allow `thread/fork` responses to create a `fork_handoff` gate regardless of that option
- make `sendIfOpen` preserve text/binary framing with `socket.send(data, { binary })`
- use `scanJsonRpcEnvelope(raw)` for method and id
- store `pendingMethods` from scanned top-level id and method only after deciding the request will be forwarded
- hold startup `turn/start` by scanned method/id without parsing params whenever an `initial_capture` gate is active
- hold bounded fork-thread stateful client requests whenever a `fork_handoff` gate is active; reject nested `thread/fork` and fail closed on queue overflow
- fail closed for root-array/batch frames instead of raw-forwarding
- call `rewriteThreadForkExcludeTurns(raw, isBinary)` for `thread/fork`; forward the rewritten frame on success and send a JSON-RPC error on failure
- keep small-frame duplicate interrupt ack behavior through existing Zod parsing under `MAX_FULL_PARSE_BYTES`
- forward large non-fork requests raw when they are below `MAX_RAW_FORWARD_BYTES`
- fail closed above-cap client frames with structured logging and `proxy_error`

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
- after a `thread/fork` response emits a fork candidate, immediate client stateful requests such as `turn/start`, `turn/steer`, and `turn/interrupt` are held and not forwarded upstream until `markCandidatePersisted()` is called
- stateful upstream notifications attributable to the fork thread that arrive before `markCandidatePersisted()` are queued or fail closed, not silently forwarded after their side effects are ignored
- if a fork handoff gate times out before `markCandidatePersisted()`, the proxy emits `proxy_error`, sends clear JSON-RPC errors for held client requests, and closes both sockets without emitting `candidate_capture_timeout`
- nested `result.id` does not clear `pendingMethods`
- root-array/batch upstream frames fail closed before forwarding and do not clear pending ids or derive side effects
- large `thread/start` responses recover and emit candidate side effects before forwarding
- large `thread/started` notifications recover candidate and lifecycle side effects before forwarding
- large `turn/started` and `turn/completed` notifications recover turn side effects before forwarding
- large `fs/changed` notifications recover watch id and trigger durability proof, using `[]` when path list is too large
- large `thread/closed` and `thread/status/changed` notifications recover lifecycle/lifecycle-loss side effects before forwarding
- unrecoverable large stateful upstream frames close both sockets and emit candidate-capture failure or `proxy_error`, depending on lifecycle state
- small stateful frames still use the current Zod-backed behavior
- frames above `MAX_RAW_FORWARD_BYTES` fail closed even when non-state, for both client and upstream frames

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "large thread/fork|large thread/start|large thread/started|large turn|large fs|large thread/status|raw forward cap|above-cap|unrecoverable"
```

Expected: FAIL because the current proxy has no bounded upstream side-effect recovery.

- [ ] **Step 3: Implement upstream policy**

In `handleUpstreamMessage`:

- create a `ProxyFrame` from original raw data and frame type
- scan top-level id and method
- if scanned id matches a pending method, capture and delete that pending method
- if frame bytes exceed `MAX_RAW_FORWARD_BYTES`, fail closed before forwarding
- ensure the proxy-side `WebSocketServer` and upstream `WebSocket` client set `maxPayload: MAX_RAW_FORWARD_BYTES` so `ws` rejects above-cap messages before application handlers receive them where possible, and normalize both paths to the same `proxy_error` repair signal
- if the root scanner reports an array/batch, fail closed before forwarding; do not clear pending ids and do not attempt batch side effects in this plan
- if frame bytes are under `MAX_FULL_PARSE_BYTES`, keep existing full-parse/Zod behavior
- if frame is large and stateful, call the matching bounded extractor and emit the same side effects as the existing parsed path
- when a `thread/fork` response yields a candidate, begin a `fork_handoff` identity gate before forwarding the response to the TUI; release the gate only when TerminalRegistry calls `markCandidatePersisted()` after staging the candidate
- while the `fork_handoff` gate is active, queue bounded stateful upstream notifications attributable to the fork thread or fail closed if they cannot be queued safely
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
- fork handoff timeout after the original identity was already durable: structured warning, `emitRepairTrigger({ kind: 'proxy_error', error })`, fail any held post-fork client requests with JSON-RPC errors explaining the fork identity was not persisted, and close client and upstream; do not emit `candidate_capture_timeout`
- all other unrecoverable stateful or above-cap frames in either direction: structured warning, `emitRepairTrigger({ kind: 'proxy_error', error })`, close client and upstream

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
- a terminal with an existing durable Codex identity accepts a valid `thread_fork_response` candidate as an intentional staged handoff
- staging the handoff does not release the old session binding, does not clear `resumeSessionId`, does not replace the old durable store record, and does not broadcast `terminal.session.unbound` or `terminal.session.associated`
- staging the handoff records a transient fork candidate with state `fork_handoff_staged`, arms the new rollout watch, and makes `codexCandidateMatches` accept the forked thread for turn/lifecycle attribution while the old durable identity remains recoverable
- `markCandidatePersisted()` is called only after the staged handoff exists on the running terminal record; this releases proxy-held post-fork traffic after Freshell can attribute fork events
- after a forked-thread `turn/started`, the transient handoff enters `fork_turn_in_progress_unproven`
- after a forked-thread `turn/completed`, the transient handoff enters `fork_proof_checking` and runs rollout proof against the staged fork candidate
- the forked thread is not broadcast as `terminal.session.associated` until the normal rollout proof succeeds
- after rollout proof success, the terminal atomically rebinds from the old durable thread to the forked thread, sets `resumeSessionId` and `durableThreadId` to the fork id, writes the new durable store record, clears staged handoff state, unwatches stale rollout paths, and broadcasts the new session association without an externally visible unbound interval
- ordinary mismatched `thread_start_response` and `thread_started_notification` candidates after initial persistence are still ignored and keep the existing warning behavior
- invalid fork candidates without an absolute rollout path, with `path: null`, with `ephemeral: true`, with a same-as-parent child id, or with conflicting path aliases do not unbind the old durable identity and do not call `markCandidatePersisted()`, so the proxy's fork handoff gate fails closed instead of allowing untracked post-fork input
- fork proof failure preserves the old durable binding and old store record, clears or marks the staged handoff as `fork_handoff_failed`, and closes/fails the proxy before more post-fork traffic is accepted
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
- for `thread_fork_response`, validate the candidate with a fork-specific helper that enforces `result.thread.path`, absolute path, `ephemeral !== true`, child id differs from parent/old durable id, and path-alias agreement
- add a transient `record.codexForkHandoff` or equivalent structured state that stores the staged fork candidate, the old durable session id, the old durability ref, staged/proof timestamps, and the handoff state
- do not call `releaseBinding()`, do not clear `resumeSessionId`, and do not replace the old durable store record when staging the fork candidate
- make `codexCandidateMatches` and fork proof routing accept `record.codexForkHandoff.candidateThreadId` while preserving old durable recovery through `resumeSessionId`
- call `record.codexSidecar?.markCandidatePersisted?.()` only after the valid staged fork handoff is installed on the running terminal record; this releases proxy-held post-fork traffic after Freshell can attribute its turn events to the staged fork candidate
- route forked-thread `turn/started`, `turn/completed`, and `fs/changed` proof triggers through the staged handoff state instead of mutating the old durable record
- do not mark the forked thread durable or send `terminal.session.associated` until the fork rollout proof succeeds
- on fork proof success, commit under a single registry critical section: update binding authority from the old session to the proven fork session, set `resumeSessionId` and `durableThreadId`, write the new durable record with `source: 'thread_fork_response'`, clear staged state, unwatch stale rollout paths, and then broadcast durability/session association
- if the fork candidate is invalid or proof fails, log and preserve the existing durable identity, do not acknowledge the proxy gate for invalid candidates, and close/fail the proxy rather than allowing future turns to run under stale identity

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

### Task 6: Add Constrained-Heap Large-Forward Stress Tests

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
- accepts a cap argument so ordinary tests can run the exact code path with a small cap override, while the final gate runs at the real `MAX_RAW_FORWARD_BYTES`
- for the `thread/fork` mode, sends a `thread/fork` request, has upstream assert the rewritten request contains `excludeTurns: true`, then sends a large response with `result.thread.id`, `result.thread.path`, `result.thread.ephemeral`, and a huge nested decoy before the top-level id; the TUI-facing response still receives `result.thread.turns: []`
- subscribe to `proxy.onCandidate`, assert the `thread_fork_response` candidate, and call `proxy.markCandidatePersisted()` in the child fixture before sending any follow-up `turn/start` traffic; this proves the fork gate can be released without depending on TerminalRegistry in the stress fixture
- for the non-state modes, sends a request with a method outside `STATEFUL_RESPONSE_METHODS` such as `model/list`, then has upstream send the large or above-cap response with the matching top-level id after the large `result`
- asserts the TUI receives the same byte length for both below-cap success modes and that the proxy emits `thread_fork_response` for the stateful fork mode
- exits non-zero if the process OOMs, times out, parses the body, loses the response, fails to recover the fork candidate, or incorrectly forwards the above-cap frame

Use payloads at the active cap boundary, not merely convenient large samples. Build text JSON-RPC response buffers with total byte length `activeCap - 1024` so both successful paths prove the configured path. Generate them from `Buffer` chunks instead of constructing huge JS strings, have the upstream send them as text WebSocket frames with `{ binary: false }`, and assert the client receives `isBinary === false`.

- [ ] **Step 2: Add resource-light parent Vitest cases**

Launch the fixture for the stateful fork-response mode and the non-state raw-forward mode with a small cap override, such as 2 MiB, so ordinary focused runs prove the scanner/extractor/raw-forward path without allocating 64 MiB frames:

```ts
await execFileAsync(process.execPath, [
  '--max-old-space-size=96',
  '--import',
  'tsx',
  childPath.pathname,
  '--cap-bytes',
  String(2 * 1024 * 1024),
], {
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
})
```

These default cases must also include an above-cap rejection using `activeCap + 1024`.

- [ ] **Step 3: Add the opt-in full-boundary parent Vitest cases**

Add a skipped-by-default test block gated by `FRESHELL_RUN_LARGE_PROXY_STRESS=1`. When opted in, launch the fixture once for the stateful fork-response mode and once for the non-state raw-forward mode with the real cap and a constrained heap:

```ts
await execFileAsync(process.execPath, [
  '--max-old-space-size=128',
  '--import',
  'tsx',
  childPath.pathname,
  '--cap-bytes',
  String(MAX_RAW_FORWARD_BYTES),
], {
  timeout: 60_000,
  maxBuffer: 1024 * 1024,
})
```

- [ ] **Step 4: Run the resource-light stress tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "constrained heap"
```

Expected before the bounded extractor and raw-forward paths are complete: FAIL by child OOM, timeout, missing `thread_fork_response`, or explicit assertion. Expected after Task 4 implementation is complete: PASS using the small cap override and report the forwarded byte length, `isBinary === false`, and an RSS/heap sample for both success modes confirming the proxy did not materialize the payload as a parsed JS object.

- [ ] **Step 5: Run the opt-in full-boundary final gate**

Run only as a final gate, not during ordinary iteration:

```bash
FRESHELL_RUN_LARGE_PROXY_STRESS=1 npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "constrained heap"
```

If either success mode fails at the 64 MiB boundary after the no-parse path is implemented, do not weaken the test. Lower `MAX_RAW_FORWARD_BYTES` to the highest boundary where both success modes pass, update all boundary tests, and document the measured RSS/heap output in the implementation report.

- [ ] **Step 6: Add the above-cap child-process case**

Extend the child fixture or add a sibling mode that sends a non-state upstream frame with total byte length `activeCap + 1024`, again generated from `Buffer` chunks. Assert the proxy fail-closes the frame and emits `proxy_error` instead of forwarding it to the TUI. The opt-in full-boundary run must execute this case at `MAX_RAW_FORWARD_BYTES + 1024`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts server/coding-cli/codex-app-server/remote-proxy.ts
git commit -m "test: stress codex proxy large response forwarding"
```

### Task 7: Add The Opt-In Real TUI Fork Contract

**Files:**
- Create: `test/integration/real/codex-remote-fork-contract.test.ts`

- [x] **Step 1: Write the skipped contract test**

Follow the existing real-provider pattern in `test/integration/real/codex-app-server-readiness-contract.test.ts`: skip unless `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1` and `codex` is available. Use an isolated temporary `CODEX_HOME`; copy `~/.codex/auth.json` and `~/.codex/config.toml` when available, and skip with a clear reason when required local Codex credentials are unavailable. Clean the temporary root in test cleanup.

The test must:

- start a controlled WebSocket app-server on localhost
- launch `codex --remote <app-server.wsUrl> ...CODEX_MANAGED_REMOTE_CONFIG_ARGS --no-alt-screen fork <parentThreadId>` through `node-pty`
- respond to `initialize`, `account/read`, model/skills/plugin/bootstrap requests, `thread/read`, `thread/fork`, `turn/start`, and `thread/turns/list` with minimal valid results
- capture the TUI's `thread/fork` request and assert it targets the deterministic parent thread id
- respond with a minimal fork result that includes `turns: []` plus a deterministic forked thread id and rollout path under `path`
- assert the TUI stays alive long enough to accept a follow-up harmless key or exit command
- keep this as a direct TUI compatibility contract. Freshell proxy rewrite, `thread_fork_response` emission, and TerminalRegistry durability handoff remain covered by the focused red tests in Tasks 4 and 5.

- [x] **Step 2: Run the contract opt-in**

Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS in this workspace because `codex` and local auth/config are available. This passed with `result.thread.turns: []`; the same contract failed when the compact fork response omitted `turns` with `thread/fork response decode error: missing field turns`. A future protocol failure is a blocker and means the production approach must be revised before continuing. If a future execution environment lacks `codex` or credentials, stop and report `USER_DECISION_REQUIRED` for the missing real-provider proof instead of treating the opt-in contract as optional completion evidence.

- [x] **Step 3: Run the default skipped contract path**

Run:

```bash
npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS with the test skipped when the opt-in env var is absent.

- [x] **Step 4: Commit pre-implementation evidence**

```bash
git add test/integration/real/codex-remote-fork-contract.test.ts
git commit -m "test: add codex fork oom preimplementation contracts"
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

- [ ] **Step 3: Run the opt-in real app-server fork-shape contract when Codex is available**

Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-app-server-fork-shape-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS in this workspace. If `codex` or auth/config are unexpectedly missing, stop and report the missing proof; do not accept a skip as completion evidence for the fork response shape risk. A protocol failure is a blocker.

- [ ] **Step 4: Run the opt-in real TUI fork contract when Codex is available**

Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-remote-fork-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS in this workspace. If `codex` or auth/config are unexpectedly missing, stop and report the missing proof; do not accept a skip as completion evidence for the terminal TUI compatibility risk. A protocol failure is a blocker.

- [ ] **Step 5: Run the opt-in full-boundary large-proxy stress gate**

Run:

```bash
FRESHELL_RUN_LARGE_PROXY_STRESS=1 npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "constrained heap"
```

Expected: PASS at the configured `MAX_RAW_FORWARD_BYTES` boundary, or lower the cap to the highest passing boundary and rerun focused tests.

- [ ] **Step 6: Run the repo check**

Coordinate through the repo wrapper:

```bash
FRESHELL_TEST_SUMMARY="codex fork oom bounded proxy extraction" npm run check
```

Expected: PASS.

- [ ] **Step 7: Inspect final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only the planned files changed; no whitespace errors.

- [ ] **Step 8: Commit any final cleanup**

If verification required small cleanup:

```bash
git add shared/codex-durability.ts server/terminal-registry.ts server/coding-cli/codex-app-server/json-rpc-envelope.ts server/coding-cli/codex-app-server/json-rpc-side-effects.ts server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts test/integration/real/codex-app-server-fork-shape-contract.test.ts test/integration/real/codex-remote-fork-contract.test.ts
git commit -m "chore: finalize codex fork oom fix"
```

## Completion Criteria

- Terminal `thread/fork` upstream requests always include `excludeTurns: true`.
- Large valid non-fork client requests below `MAX_RAW_FORWARD_BYTES` are not rejected solely because they are large.
- Large fork requests are compacted without full-frame JSON parsing.
- Large fork responses under the proven raw-forward cap reach the TUI without full proxy-side JSON parsing or full-frame `toString()`.
- The real app-server fork-shape contract proves the fork response path field before production extraction depends on it.
- Terminal fork responses stage a fork candidate while preserving the old durable binding and old store record until rollout proof succeeds.
- Terminal fork proof success commits the handoff atomically to the forked thread and only then broadcasts the new session association.
- Immediate post-fork stateful client requests are held until the staged fork identity is persisted, including for resumed terminals whose startup identity capture was disabled with `requireCandidatePersistence: false`.
- Invalid fork candidates do not unbind the old durable identity and do not allow the terminal to continue accepting untracked post-fork input.
- Root-array/batch JSON-RPC frames fail closed instead of being raw-forwarded as non-state traffic.
- Frames above `MAX_RAW_FORWARD_BYTES` fail closed instead of risking server OOM.
- The proxy preserves text/binary WebSocket frame semantics.
- Pending method attribution is based only on top-level JSON-RPC ids, including ids after large results.
- Large state-bearing frames either produce the same Freshell-owned side effects as small frames or fail closed with recovery; none are silently ignored.
- Existing candidate capture, turn notification, fs-change, lifecycle, and duplicate interrupt behavior remains covered and passing.
- The opt-in full-boundary large-proxy stress gate passes locally or the raw-forward cap is lowered to the highest passing boundary.
- The opt-in real Codex app-server fork-shape contract passes locally in this workspace, or execution stops with the exact missing-proof or protocol failure.
- The opt-in real Codex TUI `/fork` contract passes locally in this workspace, or execution stops with the exact missing-proof or protocol failure.
- `npm run check` passes before handoff.
