# Fix OpenCode Startup Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore OpenCode startup inside Freshell by handling the exact terminal startup probes that current OpenCode emits during bootstrap, without regressing existing terminal protocol behavior.

**Architecture:** Keep the existing CSI request-mode bypass exactly as-is; it solves a separate compatibility contract and should not be reworked unless new failing tests prove it is wrong. Add a small incremental non-CSI startup-probe parser on the client side, feed it the real captured OpenCode bootstrap bytes, and send only truthful replies for the exact probe forms proven by that capture. Reuse one shared fixture across pure-parser, `TerminalView`, and attach/replay regression tests so the fix stays narrow and protocol-accurate.

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
- Do not invent reply formats from memory. First capture the exact bytes, then encode the exact contract in shared fixtures and tests.
- Do not assume kitty/APC handling is required unless the capture proves OpenCode emitted an APC probe that matters.
- Do not claim support for a terminal feature Freshell does not actually implement. Unsupported replies must be explicit and truthful.
- Do not rely on manual QA for completion. Manual repro is optional supporting evidence after automated checks are green.

## User-Visible Behavior And Invariants

- Selecting a directory for an `opencode` pane must lead to a visible OpenCode UI instead of a blank hanging pane.
- Recognized startup probe bytes must not be written into visible terminal output or retained in replayed scrollback.
- For a frame that contains recognized startup probes plus visible text, Freshell must send probe replies before writing the cleaned visible text to xterm.
- Partial recognized probe sequences split across websocket frames must be buffered and completed correctly.
- Unknown, malformed, or unrelated OSC/APC traffic must pass through unchanged.
- Existing CSI request-mode replies must continue to work exactly as they do today.

## File Structure

- Create: `src/lib/terminal-startup-probes.ts`
  - Pure incremental parser for the exact captured non-CSI OpenCode startup probes plus truthful reply builders.
- Modify: `src/components/TerminalView.tsx`
  - Run startup-probe extraction before OSC52 and turn-complete processing; send any generated replies over the existing `terminal.input` websocket path.
- Create: `test/helpers/opencode-startup-probes.ts`
  - Single shared fixture module containing the exact captured probe bytes, expected cleaned output, expected replies, and split-frame variants used by all tests.
- Create: `test/unit/client/lib/terminal-startup-probes.test.ts`
  - Pure parser coverage for the shared fixture contract, partial-frame buffering, and passthrough behavior.
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
  - Extend the existing terminal-output preprocessing harness to assert startup-probe replies, cleaned writes, reply-before-write ordering, and preserved OSC52 behavior with deterministic terminal theme colors.
- Create: `test/e2e/opencode-startup-probes.test.tsx`
  - Attach/replay regression using the shared fixture bytes and visible OpenCode output.

## Protocol Scope

- **Keep as-is:** `CSI Ps $ p` and `CSI ? Ps $ p` handling in `src/components/terminal/request-mode-bypass.ts`.
- **Add only if capture proves it:** non-CSI startup probe forms emitted by the failing OpenCode session.
- **Preserve:** unrelated OSC/APC/DCS traffic untouched.

If the capture shows only an OSC color query, implement only that. If it shows an APC or other non-CSI probe that requires a reply, implement exactly that form and no more.

## Task 1: Freeze The Real OpenCode Probe Contract

**Files:**
- Create: `test/helpers/opencode-startup-probes.ts`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Create: `test/e2e/opencode-startup-probes.test.tsx`

- [ ] **Step 1: Identify the exact failing probe bytes and encode them once**

Source the probe contract from the real failing OpenCode repro before writing parser logic. Use one of these acceptable sources:
- an existing captured failing session artifact already present in the workspace
- a reproducible rerun against the current failing OpenCode version that records the raw startup bytes

Create `test/helpers/opencode-startup-probes.ts` exporting:

```ts
export const OPEN_CODE_STARTUP_PROBE_FRAME = '...exact raw bytes...'
export const OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES = ['...part 1...', '...part 2...']
export const OPEN_CODE_STARTUP_VISIBLE_TEXT = '...first visible OpenCode text...'
export const OPEN_CODE_STARTUP_EXPECTED_REPLIES = ['...exact reply 1...', '...exact reply 2...']
export const OPEN_CODE_STARTUP_EXPECTED_CLEANED = '...visible text with probes removed...'
```

Rules:
- Record bytes exactly as captured, including ESC/BEL/ST delimiters.
- If the capture proves there is no APC probe, do not export APC expectations.
- Add a short comment naming where the bytes came from so future debugging can reproduce the fixture source.

- [ ] **Step 2: Write the failing tests against the shared contract**

Create `test/unit/client/lib/terminal-startup-probes.test.ts` with tests shaped by the shared fixture:

```ts
it('extracts the captured startup probes and returns the exact expected replies', () => {})
it('buffers a captured startup probe split across frames', () => {})
it('passes unrelated OSC/APC traffic through unchanged', () => {})
it('preserves incomplete unknown escape traffic until the frame completes', () => {})
```

Extend `test/unit/client/components/TerminalView.osc52.test.tsx` so one test frame includes:
- `OPEN_CODE_STARTUP_PROBE_FRAME`
- visible text after the probes
- an OSC52 sequence in the same or later frame

Assert:
- `ws.send` includes the expected `terminal.input` reply messages
- xterm `write()` receives only `OPEN_CODE_STARTUP_EXPECTED_CLEANED`
- reply messages are sent before the cleaned write from that frame
- existing OSC52 policy behavior still works

Use a deterministic mocked terminal theme in this file so any color-query reply bytes are stable and explicit.

Create `test/e2e/opencode-startup-probes.test.tsx` using the existing attach/replay harness style from `test/e2e/terminal-create-attach-ordering.test.tsx`. Replay the shared fixture, including a split-frame variant, then visible OpenCode text. Assert that visible text renders and reply traffic is emitted.

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
- the `TerminalView` and attach/replay tests fail because startup probes are still written through and no replies are sent

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
- reset `startupProbeStateRef` in the same lifecycle effect that resets the other parser states
- derive reply colors from `getTerminalTheme(settings.terminal.theme, settings.theme)`
- call `extractTerminalStartupProbes()` before `extractOsc52Events()` and `extractTurnCompleteSignals()`
- send each reply through the existing `sendInput()` path
- keep `registerTerminalRequestModeBypass(term, sendInput)` unchanged

Intended output flow:

```ts
const startup = extractTerminalStartupProbes(raw, startupProbeStateRef.current, {
  foreground: resolvedTheme.foreground,
  background: resolvedTheme.background,
  cursor: resolvedTheme.cursor,
})

for (const reply of startup.replies) {
  sendInput(reply)
}

const osc = extractOsc52Events(startup.cleaned, osc52ParserRef.current)
const { cleaned, count } = extractTurnCompleteSignals(
  osc.cleaned,
  mode,
  turnCompleteSignalStateRef.current,
)
```

Keep the implementation narrow:
- do not special-case OpenCode by mode if the captured probe handling is safe for all terminals
- do not move protocol logic to the server
- do not reorder OSC52 or turn-complete handling after visible writes

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

## Task 4: Broad Verification

**Files:**
- Modify only if broad verification exposes a real defect that requires code or test changes

- [ ] **Step 1: Run the focused regression stack one more time**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Check broad-suite coordination status**

Run:

```bash
npm run test:status
```

Expected: no conflicting holder that requires waiting. If another holder is active, wait rather than interrupt it.

- [ ] **Step 3: Run the required broad suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="opencode startup probe fix" npm test
```

Expected: PASS.

- [ ] **Step 4: If broad verification reveals a real defect, fix it before proceeding**

If any valid check fails:
- diagnose the actual defect
- update code and/or tests without weakening coverage
- re-run the focused stack and `npm test`
- make an additional commit only if this step required real file changes

- [ ] **Step 5: Optional manual repro for extra confidence**

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

- The shared probe fixture is the source of truth. If the implementation starts drifting away from those exact bytes, stop and recapture rather than guessing.
- Preserve existing request-mode behavior unless a new failing test proves a defect there.
- Do not pin OpenCode versions, do not add server-side OpenCode fallbacks, and do not fake support for unsupported terminal features.
- If the capture proves only one probe form matters, keep the implementation limited to that one form.
