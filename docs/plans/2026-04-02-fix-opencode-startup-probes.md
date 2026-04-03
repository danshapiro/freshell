# Fix OpenCode Startup Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore OpenCode startup inside Freshell by answering the exact startup probes newer OpenCode emits but Freshell currently leaves unanswered, without regressing the existing CSI request-mode bypass.

**Architecture:** Keep the existing xterm CSI request-mode bypass in `request-mode-bypass.ts`; it already solves a different, still-valid compatibility gap. Add a small incremental client-side startup-probe extractor for only the missing non-CSI probes observed in the failing repro, run it in `TerminalView` before OSC52 and turn-complete cleanup, and send truthful replies back through the existing `terminal.input` websocket path. Use captured probe bytes from the real failing session to drive tests so the implementation stays narrow and protocol-accurate.

**Tech Stack:** React 18, TypeScript, xterm.js, Vitest, Testing Library, Freshell websocket terminal protocol

---

## Strategy Gate

This plan intentionally does **not** rewrite the existing request-mode path.

Why this is the right problem:
- The PTY starts and remains alive; the blank pane happens after OpenCode emits terminal startup probes.
- The regression reproduces with different OpenCode versions under the same Freshell build, which points to an OpenCode compatibility change rather than a directory-picker or PTY-spawn failure.
- The known missing behavior is in non-CSI startup negotiation. Freshell already has a working CSI request-mode shim, so replacing it would be unnecessary risk.

Why this architecture is the right one:
- It fixes the actual missing contract with the smallest truthful surface area: only the startup probes proven to matter.
- It keeps reply injection in the client where terminal emulation already lives and avoids server-side OpenCode special cases.
- It preserves the existing xterm parser-based CSI workaround instead of moving a working path into a new raw-string parser.

Execution risks this plan must avoid:
- Do not replace `registerTerminalRequestModeBypass()` unless a failing test proves it is part of the bug. Current evidence says it is not.
- Do not implement speculative support for every OSC/APC form. Limit behavior to the exact probe bytes captured from the OpenCode repro plus safe buffering/passthrough.
- Do not claim kitty graphics support. Reply truthfully for recognized query forms only.
- Do not add a nonexistent test target such as `test/unit/client/components/TerminalView.lifecycle.test.tsx`.
- Do not weaken tests by asserting only that bytes disappear; assert both the cleaned terminal output and the outbound reply bytes.

## User-Visible Behavior And Invariants

- Selecting a directory for an `opencode` pane must lead to a live OpenCode UI instead of a blank hanging pane.
- Raw startup probe bytes must not appear in visible terminal output or scrollback.
- Replies for recognized startup probes must be sent before the cleaned visible payload from the same websocket frame is written to xterm.
- Existing CSI request-mode replies must keep working exactly as they do today.
- Partial startup probe sequences split across websocket frames must be buffered and completed correctly.
- Unknown, malformed, or unrelated OSC/APC traffic must pass through unchanged.

## File Structure

- Create: `src/lib/terminal-startup-probes.ts`
  - Pure incremental parser for the exact non-CSI startup probes observed in the OpenCode repro plus reply builders and passthrough buffering.
- Modify: `src/components/TerminalView.tsx`
  - Run startup-probe extraction before OSC52 and turn-complete processing while keeping `registerTerminalRequestModeBypass()` in place.
- Create: `test/unit/client/lib/terminal-startup-probes.test.ts`
  - Pure parser coverage for the captured probe bytes, reply generation, partial-frame buffering, and passthrough behavior.
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
  - Extend the existing raw-output preprocessing harness to assert startup-probe replies, cleaned writes, and reply-before-write ordering without regressing OSC52 handling.
- Create: `test/e2e/opencode-startup-probes.test.tsx`
  - App-level regression for attach-ready + replayed startup probe traffic + visible OpenCode output.

## Protocol Scope

- **Keep as-is:** `CSI Ps $ p` and `CSI ? Ps $ p` handling in `request-mode-bypass.ts`.
- **Add:** only the non-CSI startup probes proven by the current failing OpenCode session, expected at minimum to include:
  - the observed OSC background-color query
  - the observed kitty-style APC startup query or queries
- **Preserve:** unrelated OSC/APC traffic untouched.

If the captured repro bytes show fewer probe forms than expected, implement only those fewer forms. If they show more, extend coverage to exactly that observed set before writing production code.

## Task 1: Capture The Real Probe Contract In Tests

**Files:**
- Create: `test/unit/client/lib/terminal-startup-probes.test.ts`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Create: `test/e2e/opencode-startup-probes.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Use the exact startup probe bytes from the failing OpenCode repro as fixtures in tests. Add focused tests that lock down:

```ts
it('extracts the captured OSC startup query and returns the expected reply bytes', () => {})
it('extracts the captured kitty APC startup query and returns a truthful unsupported reply', () => {})
it('buffers a split startup probe across websocket frames', () => {})
it('passes unrelated OSC/APC traffic through unchanged', () => {})
```

Extend `TerminalView.osc52.test.tsx` with a websocket frame containing:
- captured startup probe bytes
- visible terminal text after those probes
- an OSC52 sequence in the same or a later frame

Assert:
- `ws.send` includes the expected `terminal.input` replies
- xterm `write()` receives only the cleaned visible text
- replies are sent before that visible text is written
- OSC52 behavior still works

Create `test/e2e/opencode-startup-probes.test.tsx` using the same websocket harness style as `test/e2e/terminal-create-attach-ordering.test.tsx`:
- attach a running `opencode` pane
- emit `terminal.attach.ready`
- replay the captured startup probes, including at least one split across frames
- follow with visible OpenCode output

Assert:
- visible OpenCode text renders
- reply traffic is sent back over `terminal.input`
- the pane does not stay blank

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected:
- the new pure-parser test fails because the module does not exist yet
- the `TerminalView` and e2e regressions fail because no startup-probe extraction/reply path exists for the captured non-CSI probes

- [ ] **Step 3: Write the minimal implementation scaffold**

Create `src/lib/terminal-startup-probes.ts` with a narrow API driven by the tests:

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
- support only the captured non-CSI startup probes
- preserve unknown content in `cleaned`
- buffer incomplete escape sequences in `state.pending`
- format any color reply in the exact form required by the captured query
- keep the module pure

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: parser tests pass; `TerminalView` and e2e tests may still fail until wiring is added in Task 2.

- [ ] **Step 5: Refactor and verify**

Refactor only for clarity:
- keep one buffering path for partial escape sequences
- keep reply builders small and query-specific
- keep captured probe fixtures obvious in tests so future regressions are readable

Re-run:

```bash
npm run test:vitest -- --run test/unit/client/lib/terminal-startup-probes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/terminal-startup-probes.ts \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
git commit -m "test: capture opencode startup probe contract"
```

## Task 2: Wire Startup Probe Replies Into TerminalView

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/terminal-startup-probes.ts`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Modify: `test/e2e/opencode-startup-probes.test.tsx`

- [ ] **Step 1: Identify or confirm the failing wiring tests**

Use the red tests from Task 1. Before changing production code, confirm:
- the pure parser test is green
- the `TerminalView` and e2e tests are still red for the integration reason, not due to a broken fixture

- [ ] **Step 2: Run the integration tests to verify they fail for the expected reason**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: FAIL because `TerminalView` does not yet strip the captured startup probes or send replies for them.

- [ ] **Step 3: Write the minimal implementation**

Update `TerminalView` to add startup-probe preprocessing while preserving the existing CSI bypass.

Required implementation details:
- add `startupProbeStateRef` alongside `osc52ParserRef` and `turnCompleteSignalStateRef`
- reset `startupProbeStateRef` in the same create/attach lifecycle effect that resets the other parser state
- derive reply colors from the resolved terminal theme Freshell is already using
- call the new extractor before `extractOsc52Events()` and `extractTurnCompleteSignals()`
- send each startup-probe reply with the existing `terminal.input` websocket path
- keep `registerTerminalRequestModeBypass(term, sendInput)` intact

The intended processing order is:

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
const { cleaned, count } = extractTurnCompleteSignals(osc.cleaned, mode, turnCompleteSignalStateRef.current)
```

Implementation notes:
- if `handleTerminalOutput` needs `sendInput`, move `sendInput` above it or extract a lower-level sender helper so hook dependency order stays valid
- avoid storing duplicate theme state if the resolved theme can be recomputed from existing settings where needed

- [ ] **Step 4: Run the integration tests to verify they pass**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Re-run the focused stack:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx \
  test/unit/client/components/terminal/request-mode-bypass.test.ts
```

Expected: PASS, including the unchanged request-mode coverage.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TerminalView.tsx \
  src/lib/terminal-startup-probes.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
git commit -m "fix: answer opencode startup probes"
```

## Task 3: Broad Verification And Manual Repro Check

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/terminal-startup-probes.ts`
- Modify: `test/unit/client/lib/terminal-startup-probes.test.ts`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Modify: `test/e2e/opencode-startup-probes.test.tsx`

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

Expected: no conflicting holder that requires intervention; if another holder is active, wait rather than interrupt it.

- [ ] **Step 3: Run the required broad suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="opencode startup probe fix" npm test
```

Expected: PASS.

- [ ] **Step 4: Manual worktree repro check**

Start a worktree-local server on a safe port:

```bash
PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

Check manually:
- create an `opencode` pane through the normal directory-picker flow
- confirm OpenCode renders instead of hanging
- confirm raw startup probe bytes are not visible in the pane

- [ ] **Step 5: Stop only the worktree-owned process and review logs if needed**

Run:

```bash
ps -fp "$(cat /tmp/freshell-3344.pid)"
kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid
```

If behavior is wrong, inspect `/tmp/freshell-3344.log` before making more code changes.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TerminalView.tsx \
  src/lib/terminal-startup-probes.ts \
  test/unit/client/lib/terminal-startup-probes.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
git commit -m "test: verify opencode startup probe fix"
```

## Notes For The Implementer

- Treat the captured OpenCode startup bytes as the source of truth. This is a compatibility fix, not a generic terminal-parser project.
- Preserve existing request-mode behavior unless a new failing test proves a defect there.
- Do not add a server-side OpenCode fallback, do not pin OpenCode versions, and do not fake kitty graphics success.
- If the real failing capture shows the background-color query alone is sufficient, keep the APC handling equally narrow rather than broadening scope “just in case”.
