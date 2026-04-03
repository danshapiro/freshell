# Fix OpenCode Startup Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore OpenCode startup inside Freshell by intercepting the probe sequences newer OpenCode emits, replying truthfully, and keeping those probe bytes out of visible terminal output.

**Architecture:** Keep the fix in the client terminal bridge. Extend the existing raw-output preprocessing path in `TerminalView` so Freshell can detect startup probe sequences before they reach xterm, send replies back through the existing `terminal.input` websocket contract, and then continue the normal OSC52 and turn-complete cleanup pipeline on the remaining output. Implement the parsing and reply generation as a small pure module with incremental state so partial escape sequences across websocket frames are handled deterministically.

**Tech Stack:** React 18, TypeScript, xterm.js, Vitest, Testing Library, Freshell websocket terminal protocol

---

## Strategy Gate

This plan stays on the correct boundary and avoids the wrong fixes.

Why this is the right problem:
- The PTY launches and remains alive; the failure is after OpenCode starts emitting terminal capability probes.
- The regression reproduces against different OpenCode versions under the same Freshell build, which points to a compatibility gap in Freshell’s terminal emulation bridge, not spawn or directory-picker logic.
- Freshell already preprocesses raw terminal output in `TerminalView` for OSC52 and turn-complete signaling. That is the correct interception point for CSI, OSC, and APC startup probes too.

Why this architecture is the right one:
- It fixes the actual contract OpenCode is waiting on without adding a fake launcher fallback or pinning an older OpenCode version.
- It keeps replies flowing through `terminal.input`, so the PTY remains the source of truth and no server-side special case is introduced.
- It uses a focused incremental parser rather than broad escape swallowing, so unrelated terminal traffic keeps passing through untouched.

Execution risks this plan must avoid:
- Do not depend on a nonexistent `resolvedThemeRef`; derive color replies from the current terminal theme/settings using values that already exist in `TerminalView`.
- Do not wire `handleTerminalOutput` to call `sendInput` without first moving or extracting the sender helper so the callback order is valid in React/TypeScript.
- Do not claim kitty graphics support. Freshell should reply with a truthful unsupported or suppressed response only for the query forms it actually recognizes.
- Do not invent a “generic escape parser.” Limit the module to the specific startup queries Freshell now needs to handle.

## User-Visible Behavior And Invariants

- Selecting a directory for an `opencode` pane must lead to a live OpenCode UI instead of a blank hanging pane.
- Startup probe bytes must not appear in scrollback as raw escape garbage.
- Replies for recognized startup probes must be sent before the remaining cleaned output from the same websocket frame is written to xterm.
- CSI request-mode replies must reflect current xterm mode state, not hard-coded guesses.
- OSC color replies must reflect the current terminal theme colors that Freshell is actually using.
- Kitty graphics queries must receive a truthful unsupported or protocol-suppressed response; Freshell must not pretend graphics rendering exists.
- Partial escape sequences split across websocket frames must be buffered and completed correctly.
- Unknown or malformed sequences must pass through unchanged.

## File Structure

- Create: `src/lib/terminal-capability-probes.ts`
  - Pure incremental parser plus response builders for the startup queries Freshell needs to answer.
- Modify: `src/components/terminal/request-mode-bypass.ts`
  - Keep only the pure request-mode snapshot and reply helpers that the new parser will reuse.
- Modify: `src/components/TerminalView.tsx`
  - Replace xterm parser registration with raw-output capability-probe extraction and reply sending.
  - Reset the new parser state in the same lifecycle path that already resets OSC52 and turn-complete parser state.
- Create: `test/unit/client/lib/terminal-capability-probes.test.ts`
  - Pure parser tests for CSI, OSC, APC, partial-frame buffering, and passthrough behavior.
- Modify: `test/unit/client/components/terminal/request-mode-bypass.test.ts`
  - Keep coverage for snapshotting and request-mode reply bytes; remove the obsolete parser-registration assertions.
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
  - Extend the existing raw-output preprocessing test harness to cover capability replies, cleaned writes, and reply-before-write ordering.
- Create: `test/e2e/opencode-startup-probes.test.tsx`
  - App-level regression that drives an `opencode` pane through startup probe traffic and proves visible output renders.

## Protocol Scope

- **CSI request-mode queries:** Handle `CSI Ps $ p` and `CSI ? Ps $ p` by reusing the existing request-mode snapshot and response logic.
- **OSC color queries:** Handle query-only `OSC 10`, `OSC 11`, and `OSC 12` payloads (`?`) and return the current foreground, background, or cursor color in xterm-compatible `rgb:rrrr/gggg/bbbb` format.
- **Kitty graphics queries:** Detect the query forms OpenCode emits in APC `ESC _ ... ESC \\` startup traffic. Return only truthful unsupported or protocol-suppressed responses for recognized query forms. Preserve identifying fields that the protocol expects to round-trip when practical, but do not overfit to speculative fields that current evidence does not require.
- **Everything else:** Preserve unchanged.

## Task 1: Build The Capability-Probe Parser

**Files:**
- Create: `src/lib/terminal-capability-probes.ts`
- Modify: `src/components/terminal/request-mode-bypass.ts`
- Test: `test/unit/client/lib/terminal-capability-probes.test.ts`
- Test: `test/unit/client/components/terminal/request-mode-bypass.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add parser-focused tests that lock in the contract before implementation:

```ts
it('extracts CSI request-mode queries and returns reply bytes', () => {})
it('extracts OSC 11 color queries and returns rgb replies', () => {})
it('extracts recognized kitty APC queries and returns unsupported or suppressed replies', () => {})
it('buffers incomplete escape sequences across chunks', () => {})
it('passes malformed or unrelated sequences through unchanged', () => {})
```

Keep the existing `request-mode-bypass` tests for mode snapshots and reply bytes, but replace the parser-registration test with assertions against the pure helpers that will remain after the refactor.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts
```

Expected:
- `test/unit/client/lib/terminal-capability-probes.test.ts` fails because the new module does not exist yet.
- `test/unit/client/components/terminal/request-mode-bypass.test.ts` fails once its obsolete registration expectations are replaced with the new pure-helper contract.

- [ ] **Step 3: Write the minimal implementation**

Create a small pure module with explicit incremental state and deterministic outputs:

```ts
export type TerminalCapabilityProbeState = {
  pending: string
}

export type TerminalCapabilityProbeContext = {
  requestModes: TerminalRequestModeSnapshot
  colors: {
    foreground: string | undefined
    background: string | undefined
    cursor: string | undefined
  }
}

export type TerminalCapabilityProbeResult = {
  cleaned: string
  replies: string[]
}

export function createTerminalCapabilityProbeState(): TerminalCapabilityProbeState

export function extractTerminalCapabilityProbes(
  data: string,
  state: TerminalCapabilityProbeState,
  context: TerminalCapabilityProbeContext,
): TerminalCapabilityProbeResult
```

Implementation requirements:
- Reuse `snapshotTerminalRequestModes()` and `buildTerminalRequestModeResponse()` for CSI handling.
- Handle only query-only OSC 10/11/12 forms; set-color forms must remain passthrough.
- Normalize theme colors to `rgb:rrrr/gggg/bbbb`, with graceful handling when a specific color is absent.
- Recognize only the kitty APC query shapes OpenCode actually emits during startup. Unknown APC traffic must remain passthrough.
- Respect suppression when the recognized kitty query requests it.
- Leave unrecognized or malformed content in `cleaned`.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Refactor for clarity only:
- Keep CSI, OSC, and APC scanners in small helpers.
- Keep all reply builders pure.
- Keep partial-sequence buffering in one place instead of duplicating it per sequence family.

Re-run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/terminal-capability-probes.ts \
  src/components/terminal/request-mode-bypass.ts \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts
git commit -m "fix: add terminal capability probe parser"
```

## Task 2: Wire Capability Replies Into TerminalView

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`

- [ ] **Step 1: Identify or write the failing component tests**

Extend `test/unit/client/components/TerminalView.osc52.test.tsx` because it already exercises the raw-output preprocessing path with a mocked websocket and xterm terminal. Add a case that renders a running `opencode` pane, injects a websocket output frame containing:
- one request-mode CSI query
- one OSC color query
- one recognized kitty APC query
- normal visible text after the probes

Assert:
- `ws.send` receives `terminal.input` replies for the recognized queries
- xterm `write()` receives only the cleaned visible text
- the `terminal.input` replies are sent before the visible output write for that same frame
- unrelated OSC52 behavior still works after the new preprocessing pass

- [ ] **Step 2: Run the component test to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.osc52.test.tsx
```

Expected: FAIL because `TerminalView` still depends on `registerTerminalRequestModeBypass()` and does not preprocess startup capability probes in the raw-output path.

- [ ] **Step 3: Write the minimal implementation**

Update `TerminalView` so startup capability replies are produced in the existing raw-output pipeline.

Required implementation details:
- Introduce `capabilityProbeStateRef` alongside the existing OSC52 and turn-complete parser refs.
- Reset `capabilityProbeStateRef` in the same effect that currently resets `turnCompleteSignalStateRef` and `osc52ParserRef`.
- Move `sendInput` earlier in the component, or extract a stable lower-level sender helper first, so `handleTerminalOutput` can call it without an invalid declaration order.
- Replace `registerTerminalRequestModeBypass(term, sendInput)` with raw-output extraction inside `handleTerminalOutput`.
- Derive the color context from the current terminal theme already available to `TerminalView` and keep it in sync with settings changes.
- Preserve the output processing order:
  1. capability-probe extraction and reply sending
  2. OSC52 extraction
  3. turn-complete extraction
  4. `term.write`

Shape the wiring like this:

```ts
const capability = extractTerminalCapabilityProbes(raw, capabilityProbeStateRef.current, {
  requestModes: snapshotTerminalRequestModes(termRef.current),
  colors: resolveTerminalCapabilityColors(/* current theme source */),
})

for (const reply of capability.replies) {
  sendInput(reply)
}

const osc = extractOsc52Events(capability.cleaned, osc52ParserRef.current)
const { cleaned, count } = extractTurnCompleteSignals(osc.cleaned, mode, turnCompleteSignalStateRef.current)
```

- [ ] **Step 4: Run the component test to verify it passes**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.osc52.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Tighten the integration:
- Keep theme-to-color resolution in a small helper rather than spreading color parsing through `TerminalView`.
- Ensure parser state resets when a terminal instance or backend attach lifecycle is recreated.
- Verify non-OpenCode panes still tolerate the preprocessing path safely.

Re-run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TerminalView.tsx \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  src/lib/terminal-capability-probes.ts \
  src/components/terminal/request-mode-bypass.ts
git commit -m "fix: answer startup capability probes in TerminalView"
```

## Task 3: Add OpenCode Regression Coverage And Finish Verification

**Files:**
- Create: `test/e2e/opencode-startup-probes.test.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/terminal-capability-probes.ts`
- Modify: `test/unit/client/lib/terminal-capability-probes.test.ts`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`

- [ ] **Step 1: Identify or write the failing app-level regression test**

Create `test/e2e/opencode-startup-probes.test.tsx` using the existing app-level websocket harness style from `test/e2e/terminal-create-attach-ordering.test.tsx` and `test/e2e/turn-complete-notification-flow.test.tsx`.

Model the real regression:
- render a running `opencode` pane
- emit `terminal.attach.ready`
- send startup probe bytes split across multiple `terminal.output` frames
- follow with normal visible OpenCode output

Assert:
- the pane renders the visible OpenCode text
- websocket traffic includes the capability replies
- the terminal instance does not remain permanently blank
- no raw startup probe bytes are written to xterm

- [ ] **Step 2: Run the e2e regression test to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/e2e/opencode-startup-probes.test.tsx
```

Expected: FAIL until the production wiring is complete.

- [ ] **Step 3: Write the minimal implementation adjustments**

If the e2e test exposes remaining gaps, fix production code rather than weakening the test. Likely valid follow-ups:
- parser-state reset edge cases around remount or reattach
- reply ordering under multi-frame startup traffic
- color resolution or partial-sequence buffering defects

- [ ] **Step 4: Run the e2e regression test to verify it passes**

Run:

```bash
npm run test:vitest -- --run test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run the focused regression stack:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS.

Then run the required broad suite:

```bash
FRESHELL_TEST_SUMMARY="opencode startup probe fix" npm test
```

Expected: PASS.

Finally perform a manual spot check from the worktree on a safe port:

```bash
PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

Check:
- create an `opencode` pane through the normal picker flow
- confirm OpenCode renders instead of hanging
- confirm no raw probe bytes appear in scrollback

Stop only the worktree-owned process:

```bash
ps -fp "$(cat /tmp/freshell-3344.pid)"
kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid
```

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TerminalView.tsx \
  src/lib/terminal-capability-probes.ts \
  src/components/terminal/request-mode-bypass.ts \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
git commit -m "fix: restore opencode startup in Freshell"
```

## Notes For The Implementer

- Prefer captured startup-probe bytes from the failing OpenCode session in tests. This is a protocol compatibility fix, not an abstract parser exercise.
- Reuse existing test harnesses instead of introducing a brand-new `TerminalView` harness unless the existing ones prove insufficient.
- Keep the parser query-specific and small. This is not a general terminal emulator.
- Do not add a server-side fallback, OpenCode version pin, or fake kitty success reply.
- Do not swallow all OSC/APC traffic. Only recognized startup queries should be intercepted.
