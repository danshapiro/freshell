# Fix OpenCode Startup Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore OpenCode startup inside Freshell by handling the exact terminal startup probes that current OpenCode emits during bootstrap, without regressing existing terminal protocol behavior.

**Architecture:** Keep the existing CSI request-mode bypass exactly as-is; it solves a separate compatibility contract and should not be reworked unless new failing tests prove it is wrong. Add a small incremental non-CSI startup-probe parser on the client side, but drive it from the exact failing websocket `terminal.output` frame sequence instead of a reconstructed combined payload: the real contract starts with a probe-only frame and continues with later post-reply frames, plus a synthetic split-frame variant only for buffering coverage. Strip recognized probes from both live and replayed output, emit synthetic replies only for live frames outside replay, apply the startup-probe preprocessor regardless of terminal mode, and reset parser state whenever an attach generation starts or replay completes, including replay completion announced by `terminal.output.gap`, so replay fragments cannot leak into later live traffic. Reuse one shared frame fixture across the pure-parser, `TerminalView`, and attach/replay regression tests so the fix stays narrow and protocol-accurate, while keeping the picker handoff as a separate boundary regression.

**Tech Stack:** React 18, TypeScript, xterm.js, Vitest, Testing Library, Freshell websocket terminal protocol

---

## Strategy Gate

Why this is the right problem:
- The PTY launches and stays alive, so this is not a pane-picker, cwd, or spawn failure.
- The repro differs by OpenCode version under the same Freshell build, which points to a compatibility change in OpenCode startup negotiation.
- The observed stall happens before UI rendering and after startup probe output begins, so the missing contract is terminal-probe handling.

Why this architecture is the right one:
- Terminal capability negotiation belongs in the terminal client path, not in server-side OpenCode-specific launch hacks.
- A narrow incremental parser matches Freshell’s existing OSC52 and turn-complete preprocessing pattern and avoids destabilizing xterm parser registration for unrelated traffic.
- One shared captured-fixture source prevents three tests from drifting into three different guesses about what OpenCode really sent.

Execution risks this plan must avoid:
- Do not replace or broaden `registerTerminalRequestModeBypass()` unless a new failing test proves the CSI path is part of this bug.
- Do not invent reply formats or websocket frame shapes from memory. First capture the exact websocket bytes and frame boundaries, then encode that contract in shared fixtures and tests.
- Do not collapse a captured multi-frame startup sequence into a synthetic `probe + visible output` websocket payload just because it is easier to test.
- Do not assume kitty/APC handling is required unless the capture proves OpenCode emitted an APC probe that matters.
- Do not claim support for a terminal feature Freshell does not actually implement. Unsupported replies must be explicit and truthful.
- Do not emit synthetic replies while processing replayed attach history or stale attach generations. Replay needs cleanup, not new PTY input.
- Do not let pending recognized probe bytes survive from replay hydration into the first accepted live frame, or from one attach generation into the next.
- Do not rely on manual QA for completion. Manual repro is optional supporting evidence after automated checks are green.

## User-Visible Behavior And Invariants

- Selecting a directory for an `opencode` pane must lead to a visible OpenCode UI instead of a blank hanging pane.
- Recognized startup probe bytes must not be written into visible terminal output or retained in replayed scrollback.
- For the captured live startup sequence, Freshell must send truthful replies for the standalone probe frame before writing any later captured post-reply output to xterm.
- If a live frame completes a split recognized probe and also carries later output, Freshell must send the reply before writing the cleaned remainder of that same frame.
- Replayed startup bytes during attach hydration must be stripped from visible output but must not generate fresh `terminal.input` traffic.
- Pending recognized probe fragments from replay hydration must be discarded before the first accepted live frame, including when replay completion is announced by `terminal.output.gap`, and pending probe state must reset across attach generations.
- Partial recognized probe sequences split across websocket frames must be buffered and completed correctly.
- Unknown, malformed, or unrelated OSC/APC traffic must pass through unchanged.
- Existing CSI request-mode replies must continue to work exactly as they do today.
- Identical captured startup-probe bytes must be handled the same way regardless of pane mode; the helper's startup-only contract, not an `opencode`-only gate, defines the safe scope.

## File Structure

- Create: `src/lib/terminal-startup-probes.ts`
  - Pure incremental parser for the exact captured non-CSI OpenCode startup probes plus truthful reply builders.
- Modify: `src/components/TerminalView.tsx`
  - Run startup-probe extraction before OSC52 and turn-complete processing; send any generated replies over the existing `terminal.input` websocket path and reset parser state at attach/replay boundaries.
- Create: `test/helpers/opencode-startup-probes.ts`
  - Single shared fixture module containing the exact captured websocket startup frame sequence, expected cleaned output, expected replies, and split-frame variants used by all tests.
- Create: `test/unit/client/lib/terminal-startup-probes.test.ts`
  - Pure parser coverage for the shared fixture contract, partial-frame buffering, and passthrough behavior.
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
  - Extend the existing terminal-output preprocessing harness to assert startup-probe replies, probe-only-frame handling, cleaned writes, reply-before-write ordering, preserved OSC52 behavior, and mode-agnostic handling with deterministic terminal theme colors.
- Create: `test/e2e/opencode-startup-probes.test.tsx`
  - Attach/replay regression using the shared fixture frames, including replay/live boundary handling and replay completion via `terminal.output.gap`.
- Modify: `test/e2e/directory-picker-flow.test.tsx`
  - Boundary regression for the real picker handoff into an `opencode` terminal pane with the confirmed cwd.
- Modify: `src/components/TabsView.tsx`
  - Verification-only accessibility cleanup required so Task 4 Step 3's repo-wide lint gate passes without unrelated a11y errors in this worktree.
- Modify: `src/components/Sidebar.tsx`
  - Verification-only dead-code cleanup required so Task 4 Step 3's repo-wide lint gate passes without unrelated unused-variable errors in this worktree.
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
  - Verification-only dead-code cleanup required so Task 4 Step 3's repo-wide lint gate passes without unrelated unused-variable errors in this worktree.
- Modify: `src/store/persistMiddleware.ts`
  - Verification-only dead-import cleanup required so Task 4 Step 3's repo-wide lint gate passes without unrelated unused-import errors in this worktree.
- Modify: `test/unit/client/components/TabsView.test.tsx`
  - Keep the `TabsView` accessibility assertion aligned with the required lint-gate cleanup above.

## Protocol Scope

- **Keep as-is:** `CSI Ps $ p` and `CSI ? Ps $ p` handling in `src/components/terminal/request-mode-bypass.ts`.
- **Add only if capture proves it:** non-CSI startup probe forms emitted by the failing OpenCode session.
- **Preserve:** unrelated OSC/APC/DCS traffic untouched.

If the capture shows only an OSC color query, implement only that. If it shows an APC or other non-CSI probe that requires a reply, implement exactly that form and no more. If a captured form appears only in replay coverage and does not require a live reply, strip it without inventing a reply.

## Task 1: Freeze The Real OpenCode Websocket Probe Contract

**Files:**
- Create: `test/helpers/opencode-startup-probes.ts`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Create: `test/e2e/opencode-startup-probes.test.tsx`

- [ ] **Step 1: Identify the exact failing websocket startup frames and encode them once**

Source the probe contract from the real failing OpenCode websocket repro before writing parser logic. Do not guess from release notes, raw PTY chunks, or terminal lore.

Capture the first hung `terminal.output.data` websocket frames from the real failing Freshell session, because that is the exact client-side contract this fix must process. Save the raw bytes exactly as delivered to `handleTerminalOutput`, including the frame boundaries for:
- the first standalone recognized probe frame
- the later post-reply startup frames that arrive after the truthful reply is written
- one split-sequence variant for buffering coverage; this split case may be synthetic if it is derived directly from the captured recognized probe bytes and is only used for the buffering boundary test

Use a one-off local logging patch or devtools capture during repro, but do not keep temporary instrumentation in the repo. A raw `node-pty` harness may corroborate the byte values inside a frame, but it is not allowed to define the websocket frame boundaries for the fixture. If you cannot freeze the websocket sequence, stop and recapture instead of inventing one.

Create `test/helpers/opencode-startup-probes.ts` exporting:

```ts
export const OPEN_CODE_STARTUP_PROBE_FRAME = '...exact raw bytes...'
export const OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES = ['...part 1...', '...part 2...']
export const OPEN_CODE_STARTUP_POST_REPLY_FRAMES = ['...frame 1...', '...frame 2...']
export const OPEN_CODE_STARTUP_POST_REPLY_OUTPUT = OPEN_CODE_STARTUP_POST_REPLY_FRAMES.join('')
export const OPEN_CODE_STARTUP_EXPECTED_REPLIES = ['...exact reply 1...', '...exact reply 2...']
export const OPEN_CODE_STARTUP_EXPECTED_CLEANED = OPEN_CODE_STARTUP_POST_REPLY_OUTPUT
```

Rules:
- Record bytes exactly as captured, including ESC/BEL/ST delimiters.
- Preserve the real websocket frame boundaries for the captured live startup path; do not concatenate the probe frame and post-reply frames into a synthetic single payload.
- If the capture proves there is no APC probe, do not export APC expectations.
- Add a short comment naming the exact capture source so future debugging can reproduce the fixture source.

- [ ] **Step 2: Write the failing tests against the shared contract**

Create `test/unit/client/lib/terminal-startup-probes.test.ts` with tests shaped by the shared fixture:

```ts
it('extracts the captured standalone startup probe and passes the post-reply frames through unchanged', () => {})
it('buffers a captured startup probe split across frames', () => {})
it('passes unrelated OSC/APC traffic through unchanged', () => {})
it('preserves incomplete unknown escape traffic until the frame completes', () => {})
```

Extend `test/unit/client/components/TerminalView.osc52.test.tsx` so the startup path follows the real websocket contract:
- first emit `OPEN_CODE_STARTUP_PROBE_FRAME` by itself and assert that it generates replies but no write
- then emit one or more `OPEN_CODE_STARTUP_POST_REPLY_FRAMES`, with an OSC52 sequence in a later frame
- run the same startup-probe assertions for at least one non-`opencode` terminal mode so a `mode === 'opencode'` gate cannot satisfy the tests

Assert:
- `ws.send` includes the expected `terminal.input` reply messages
- xterm `write()` receives only `OPEN_CODE_STARTUP_EXPECTED_CLEANED`
- the reply messages are sent before the first cleaned post-reply write
- the same reply-before-write behavior occurs in both the `opencode` case and the non-`opencode` case
- existing OSC52 policy behavior still works

Use a deterministic mocked terminal theme in this file so any color-query reply bytes are stable and explicit.

Create `test/e2e/opencode-startup-probes.test.tsx` using the existing attach/replay harness style from `test/e2e/terminal-create-attach-ordering.test.tsx`. Cover the real multi-frame startup contract plus the boundary cases that can regress it:
- live startup: emit `OPEN_CODE_STARTUP_PROBE_FRAME`, assert replies and no writes, then emit `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` and assert the cleaned writes
- replay startup: emit the same historical frames during replay hydration and assert they are stripped from visible output without fresh reply traffic
- replay/live boundary on `terminal.output`: prove a replay fragment cannot be completed by the first live frame, but a complete recognized probe on the first accepted post-replay live frame still replies normally
- replay/live boundary on `terminal.output.gap`: emit only a replay fragment, complete replay with a gap message, then prove the first accepted live frame discards the stale fragment instead of completing it
- split live startup: prove a live split probe buffers until completion and replies exactly once

- [ ] **Step 3: Run the new tests to verify the contract is red**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected:
- the new pure parser test fails because the implementation module does not exist yet
- the `TerminalView` and attach/replay tests fail because startup probes are still written through, replay/live boundaries are not handled correctly, the gap-completion boundary leaks stale probe fragments, the path is still mode-gated, and no replies are sent

- [ ] **Step 4: Commit the frozen failing contract**

```bash
git add \
  test/helpers/opencode-startup-probes.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx \
  test/unit/client/lib/terminal-startup-probes.test.ts
git commit -m "test: capture opencode startup probe contract"
```

## Task 2: Implement The Narrow Startup-Probe Parser

**Files:**
- Create: `src/lib/terminal-startup-probes.ts`
- Modify: `test/unit/client/lib/terminal-startup-probes.test.ts`

- [ ] **Step 1: Write the failing pure-parser test or confirm it is still failing**

Use the parser test from Task 1 as the red target. Confirm it is failing for the missing-implementation reason, not because the shared fixture is malformed.

- [ ] **Step 2: Run the pure parser test to verify it fails for the expected reason**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/terminal-startup-probes.test.ts
```

Expected: FAIL because `src/lib/terminal-startup-probes.ts` does not exist or does not yet satisfy the captured contract.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/terminal-startup-probes.ts` with a narrow API:

```ts
export type TerminalStartupProbeState = {
  pending: string
}

export type TerminalStartupProbeColors = {
  foreground?: string
  background?: string
  cursor?: string
}

export type TerminalStartupProbeResult = {
  cleaned: string
  replies: string[]
}

export function createTerminalStartupProbeState(): TerminalStartupProbeState

export function extractTerminalStartupProbes(
  chunk: string,
  state: TerminalStartupProbeState,
  colors: TerminalStartupProbeColors,
): TerminalStartupProbeResult
```

Implementation constraints:
- support only the exact captured probe forms exported by `test/helpers/opencode-startup-probes.ts`
- preserve unrelated content in `cleaned`
- buffer incomplete escape sequences in `state.pending`
- generate only truthful replies for the recognized captured forms
- keep the module pure and independent of React/xterm/websocket concerns

- [ ] **Step 4: Run the pure parser test to verify it passes**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/terminal-startup-probes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Tighten the parser without broadening scope:
- keep one buffering path for incomplete escape traffic
- keep reply builders query-specific and small
- keep fixture-driven expectations readable

Re-run:

```bash
npm run test:vitest -- --run test/unit/client/lib/terminal-startup-probes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/terminal-startup-probes.ts \
  test/unit/client/lib/terminal-startup-probes.test.ts
git commit -m "fix: parse opencode startup probes"
```

## Task 3: Wire Startup-Probe Replies Into TerminalView

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Modify: `test/e2e/opencode-startup-probes.test.tsx`

- [ ] **Step 1: Confirm the integration tests are still red**

Before changing `TerminalView`, confirm:
- the pure parser test is green
- the `TerminalView` and attach/replay tests are still red for integration reasons

- [ ] **Step 2: Run the integration tests to verify they fail for the expected reason**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: FAIL because `TerminalView` does not yet strip the captured startup probes or send replies for them.

- [ ] **Step 3: Write the minimal implementation**

Update `src/components/TerminalView.tsx`:
- add `startupProbeStateRef` alongside `osc52ParserRef` and `turnCompleteSignalStateRef`
- reset `startupProbeStateRef` in the same lifecycle effect that resets the other parser states, at the start of each attach generation, and again when replay completes so replay fragments cannot leak into later live frames
- derive reply colors from the same resolved theme object that is applied to xterm
- call `extractTerminalStartupProbes()` before `extractOsc52Events()` and `extractTurnCompleteSignals()` for every terminal mode; rely on the helper's startup-only contract rather than a `mode === 'opencode'` gate
- thread an explicit `allowReplies` flag from the output-frame handling path so live frames can reply and replay hydration frames can only strip
- send each permitted reply through the existing `sendInput()` path
- when replay completion is detected on `terminal.output.gap`, call the same discard-remainder reset path used for replay completion on `terminal.output` so a replay-carried probe prefix cannot leak into the next live frame
- keep `registerTerminalRequestModeBypass(term, sendInput)` unchanged

Intended output flow:

```ts
const startup = extractTerminalStartupProbes(raw, startupProbeStateRef.current, {
  foreground: resolvedTheme.foreground,
  background: resolvedTheme.background,
  cursor: resolvedTheme.cursor,
})

if (allowReplies) {
  for (const reply of startup.replies) {
    sendInput(reply)
  }
}

const osc = extractOsc52Events(startup.cleaned, osc52ParserRef.current)
const { cleaned, count } = extractTurnCompleteSignals(
  osc.cleaned,
  mode,
  turnCompleteSignalStateRef.current,
)
```

Keep the implementation narrow:
- do not keep or add a `mode === 'opencode'` gate around startup-probe extraction unless a new failing test proves the captured handling is unsafe outside OpenCode
- do not move protocol logic to the server
- do not reorder OSC52 or turn-complete handling after visible writes
- do not send replies for replay hydration or stale attach output just because the parser recognized a probe
- do not let replay-carried pending probe bytes complete on the first accepted live frame after replay, including when replay completion was announced by `terminal.output.gap`; use discard-before-live semantics for both completion paths

- [ ] **Step 4: Run the integration tests to verify they pass**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Re-run the focused regression stack:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS, including unchanged request-mode coverage.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TerminalView.tsx \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
git commit -m "fix: answer opencode startup probes"
```

## Task 4: Protect The Picker Handoff Boundary

**Files:**
- Modify: `test/e2e/directory-picker-flow.test.tsx`

- [ ] **Step 1: Confirm the picker path still needs explicit OpenCode coverage**

Use the existing picker flow harness as the red target for the user entry path. Confirm there is no existing `opencode` coverage that proves directory confirmation still yields an `opencode` terminal pane with the confirmed cwd.

- [ ] **Step 2: Extend the picker regression**

Update `test/e2e/directory-picker-flow.test.tsx` to cover:
- selecting `opencode` in the real provider picker
- confirming a directory through the existing directory picker flow
- asserting the resulting pane becomes `kind: 'terminal'` with `mode: 'opencode'` and `initialCwd` equal to the confirmed directory
- asserting the provider cwd patch is persisted for `opencode`

- [ ] **Step 3: Run the picker regression**

Run:

```bash
npm run test:vitest -- --run test/e2e/directory-picker-flow.test.tsx
```

Expected: PASS, including the new `opencode` path.

- [ ] **Step 4: Refactor and verify**

Re-run the focused regression stack including the user entry path:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/e2e/opencode-startup-probes.test.tsx \
  test/e2e/directory-picker-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/directory-picker-flow.test.tsx
git commit -m "test: cover opencode picker handoff"
```

## Task 5: Broad Verification

**Files:**
- Modify only if broad verification exposes a real defect that requires code or test changes

- [ ] **Step 1: Run the focused regression stack one more time**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/e2e/opencode-startup-probes.test.tsx \
  test/e2e/directory-picker-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Check broad-suite coordination status**

Run:

```bash
npm run test:status
```

Expected: no conflicting holder that requires waiting. If another holder is active, wait rather than interrupt it.

- [ ] **Step 3: Run lint before the broad suite**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Run the required broad verification**

Run:

```bash
FRESHELL_TEST_SUMMARY="opencode startup probe fix" npm run check
```

Expected: PASS with typecheck plus the coordinated full test suite green.

- [ ] **Step 5: If broad verification reveals a real defect, fix it before proceeding**

If any valid check fails:
- diagnose the actual defect
- update code and/or tests without weakening coverage
- re-run the focused stack, `npm run lint`, and `FRESHELL_TEST_SUMMARY="opencode startup probe fix" npm run check`
- make an additional commit only if this step required real file changes

- [ ] **Step 6: Optional manual repro for extra confidence**

Only after automated checks are green, optionally confirm the original user path in a worktree-local server:

```bash
PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

Check:
- create an `opencode` pane through the normal directory-picker flow
- confirm OpenCode renders instead of hanging
- confirm raw startup probe bytes are not visible

Then stop only the worktree-owned process:

```bash
ps -fp "$(cat /tmp/freshell-3344.pid)"
kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid
```

## Notes For The Implementer

- The shared probe fixture is the source of truth for both bytes and websocket frame boundaries. Do not collapse the standalone probe frame and later post-reply frames into one synthetic payload.
- Preserve existing request-mode behavior unless a new failing test proves a defect there.
- Do not pin OpenCode versions, do not add server-side OpenCode fallbacks, and do not fake support for unsupported terminal features.
- If the capture proves only one probe form matters, keep the implementation limited to that one form.
- Apply the startup-probe extractor independent of pane mode; the helper's own startup-only semantics are the scope limiter.
- Reset the startup-probe parser whenever replay or attach-generation state changes, and use discard-remainder reset when replay completes on either `terminal.output` or `terminal.output.gap`; otherwise a replay fragment can be completed incorrectly by the next live frame.
