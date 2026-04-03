# Fix OpenCode Startup Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode panes start reliably in Freshell by answering the startup terminal capability probes that newer OpenCode/OpenTUI releases wait on.

**Architecture:** Implement a client-side raw terminal-output capability responder that runs before `term.write`, recognizes the specific startup query families OpenCode emits, strips those query bytes from the visible stream, and sends protocol-correct replies back to the PTY through the existing `terminal.input` path. Keep the implementation truthful: report actual current xterm mode/color state for CSI/OSC queries, and return an explicit unsupported reply for kitty graphics queries instead of pretending Freshell supports graphics.

**Tech Stack:** React 18, TypeScript, xterm.js, Vitest, Testing Library, Freshell websocket terminal protocol

---

## Strategy Gate

The right fix is in Freshell’s client terminal bridge, not in the OpenCode launcher or server spawn path.

Why this is the right problem:
- The PTY starts successfully; the hang occurs after OpenCode emits startup probes.
- xterm’s public parser hooks do not support APC, and kitty graphics queries use APC (`ESC _ ... ESC \\`), so a parser-only shim cannot fully fix the regression.
- Freshell already has a raw-output preprocessing seam in [`src/components/TerminalView.tsx`](src/components/TerminalView.tsx) for OSC 52 and turn-complete extraction. That is the correct steady-state interception point for all startup capability queries.

Why this architecture is correct:
- It handles CSI, OSC, and APC in one place, with one incremental parser model and one ordering rule.
- It avoids fake terminal support. Freshell should not reply `OK` to kitty graphics queries because Freshell does not implement kitty graphics rendering.
- It keeps the terminal transport contract intact: replies still go back through `terminal.input`, so the PTY remains the source of truth.

## User-Visible Behavior And Invariants

- Selecting a directory for an `opencode` pane must result in a live OpenCode UI instead of a blank hanging pane.
- Startup probe sequences must never leak into visible scrollback as raw escape garbage.
- Query replies must be sent before the remaining cleaned output from the same websocket chunk is written to xterm, so OpenCode sees prompt replies with minimal latency.
- CSI request-mode replies must reflect current terminal state, not hard-coded guesses.
- OSC color replies must reflect the active Freshell terminal theme in a stable xterm-compatible format.
- Kitty graphics queries must receive a protocol-valid failure response that tells OpenCode graphics are unsupported; Freshell must not pretend graphics support exists.
- Incomplete escape sequences split across websocket frames must be buffered and handled correctly on the next chunk.
- Unknown or malformed escape sequences must pass through unchanged; only known query forms are intercepted.

## File Structure

- Create: `src/lib/terminal-capability-probes.ts`
  - Pure incremental parser for startup capability query families.
  - Owns parser state, query extraction, response generation, and stream cleaning.
- Modify: `src/components/TerminalView.tsx`
  - Replaces the parser-registration bypass with raw-output capability response handling.
  - Maintains parser state refs and sends replies before writing cleaned output.
- Modify: `src/components/terminal/request-mode-bypass.ts`
  - Keep only the pure request-mode snapshot and response helpers used by the new raw-stream parser.
  - Remove the xterm parser registration responsibility from this file.
- Create: `test/unit/client/lib/terminal-capability-probes.test.ts`
  - Pure parser coverage for CSI, OSC, APC, partial chunks, malformed sequences, and passthrough behavior.
- Modify: `test/unit/client/components/terminal/request-mode-bypass.test.ts`
  - Retain coverage for request-mode snapshots and response bytes; remove the obsolete parser-registration test.
- Create: `test/unit/client/components/TerminalView.capability-probes.test.tsx`
  - Verifies `TerminalView` sends replies through websocket input and only writes cleaned output to xterm.
- Create: `test/e2e/opencode-startup-probes.test.tsx`
  - App-level regression proving an OpenCode pane survives a realistic startup probe burst and proceeds to visible output.

## Protocol Decisions

- **CSI request-mode queries:** Continue supporting `CSI Ps $ p` and `CSI ? Ps $ p`, but answer them from the raw websocket output stream instead of xterm parser hooks.
- **OSC color queries:** Support `OSC 10`, `OSC 11`, and `OSC 12` when the payload is a query (`?`). Reply with the active foreground, background, or cursor color in `rgb:rrrr/gggg/bbbb` form.
- **Kitty graphics queries:** Intercept APC sequences of the form `ESC _ G ... a=q ... ESC \\`. Reply with a failure, not success. Recommended payload: echo identifying keys (`i`, `I`, `p` when present) and append a clear ASCII error such as `ENOSYS: kitty graphics unsupported`.
- **Suppression flags:** Honor kitty’s `q=2` suppression for failure replies if present. Do not invent replies for forms the protocol says should be suppressed.

## Task 1: Build The Raw Capability Probe Parser

**Files:**
- Create: `src/lib/terminal-capability-probes.ts`
- Modify: `src/components/terminal/request-mode-bypass.ts`
- Test: `test/unit/client/lib/terminal-capability-probes.test.ts`
- Test: `test/unit/client/components/terminal/request-mode-bypass.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add pure tests for the startup query families Freshell must handle:

```ts
it('extracts CSI request-mode queries and emits reply bytes', () => {})
it('extracts OSC 11 color query and returns rgb reply', () => {})
it('extracts kitty graphics APC query and returns unsupported reply', () => {})
it('buffers split escape sequences across chunks', () => {})
it('passes through malformed or unrelated sequences unchanged', () => {})
```

Keep the existing request-mode snapshot/response tests, but delete the registration-specific assertion because the fix is moving away from xterm parser hooks.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts
```

Expected:
- New parser test file fails because the module does not exist yet.
- The old registration test fails once removed or rewritten to the new contract.

- [ ] **Step 3: Write the minimal implementation**

Implement a pure parser with explicit state and reply planning:

```ts
export type TerminalCapabilityProbeState = { pending: string }

export type TerminalCapabilityContext = {
  requestModes: TerminalRequestModeSnapshot
  colors: {
    foreground: string
    background: string
    cursor: string
  }
}

export type TerminalCapabilityExtraction = {
  cleaned: string
  replies: string[]
}

export function extractTerminalCapabilityProbes(
  data: string,
  state: TerminalCapabilityProbeState,
  context: TerminalCapabilityContext,
): TerminalCapabilityExtraction
```

Implementation requirements:
- Reuse `snapshotTerminalRequestModes()` and `buildTerminalRequestModeResponse()` for CSI bytes.
- Parse only query-only OSC 10/11/12 forms; preserve set-color forms unchanged.
- Convert `#RRGGBB` theme colors to `rgb:rrrr/gggg/bbbb`.
- Parse kitty APC control data just enough to recognize `G...a=q...`.
- Echo identifying kitty ids in the reply and return a failure string, not `OK`.
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

Refactor for clarity without broadening scope:
- Keep scanner helpers small and sequence-family-specific.
- Keep response builders pure and deterministic.
- Ensure partial-sequence buffering is shared, not duplicated.

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
- Create: `test/unit/client/components/TerminalView.capability-probes.test.tsx`

- [ ] **Step 1: Identify or write the failing component test**

Add a `TerminalView` test that renders a running `opencode` pane, injects output containing:
- a request-mode CSI query
- an OSC 11 background query
- a kitty graphics APC query
- normal visible text after the probes

The test must assert:
- `ws.send` receives `terminal.input` replies for all intercepted queries
- the mocked xterm `write()` only receives the visible text, not the probe bytes
- reply sends happen before the normal output write for that chunk

- [ ] **Step 2: Run the component test to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.capability-probes.test.tsx
```

Expected: FAIL because `TerminalView` does not yet use the new parser and still depends on the old xterm parser-registration bypass.

- [ ] **Step 3: Write the minimal implementation**

Update `TerminalView` to use the new raw-output path:

```ts
const capabilityProbeStateRef = useRef(createTerminalCapabilityProbeState())

const handleTerminalOutput = useCallback((raw, mode, tid) => {
  const capability = extractTerminalCapabilityProbes(raw, capabilityProbeStateRef.current, {
    requestModes: snapshotTerminalRequestModes(termRef.current),
    colors: resolveTerminalCapabilityColors(termRef.current, resolvedThemeRef.current),
  })

  for (const reply of capability.replies) {
    sendInput(reply)
  }

  const osc = extractOsc52Events(capability.cleaned, osc52ParserRef.current)
  const { cleaned, count } = extractTurnCompleteSignals(osc.cleaned, mode, turnCompleteSignalStateRef.current)
  if (cleaned) enqueueTerminalWrite(cleaned)
})
```

Also remove the obsolete `registerTerminalRequestModeBypass(term, sendInput)` setup and disposal path.

- [ ] **Step 4: Run the component test to verify it passes**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.capability-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Tighten the wiring:
- Reset capability parser state whenever a terminal instance is recreated.
- Keep the preprocessing order explicit: capability probes first, OSC 52 second, turn-complete extraction third, then `term.write`.
- Verify non-OpenCode panes still use the same output path safely.

Re-run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/unit/client/components/TerminalView.capability-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TerminalView.tsx \
  test/unit/client/components/TerminalView.capability-probes.test.tsx \
  src/lib/terminal-capability-probes.ts \
  src/components/terminal/request-mode-bypass.ts
git commit -m "fix: answer startup capability probes in TerminalView"
```

## Task 3: Add App-Level Regression Coverage For OpenCode Startup

**Files:**
- Create: `test/e2e/opencode-startup-probes.test.tsx`

- [ ] **Step 1: Identify or write the failing app-level regression test**

Use the existing React app/websocket harness style from `test/e2e/*` to model the real user path:
- render the app with an `opencode` pane
- send `terminal.created`
- inject a startup probe burst split across multiple `terminal.output` websocket frames
- follow with normal visible OpenCode text such as a prompt/header line

Expected assertions:
- the terminal pane stays alive and eventually renders the visible OpenCode text
- websocket traffic includes the capability replies
- the pane does not remain in a permanently blank state

- [ ] **Step 2: Run the e2e regression test to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/e2e/opencode-startup-probes.test.tsx
```

Expected: FAIL until the full output-path fix is wired through the app-level harness.

- [ ] **Step 3: Write the minimal implementation adjustments**

If the e2e harness reveals any missing cutover details, fix the production code, not the test. Likely follow-up fixes:
- ensuring state refs reset on remount/reconnect
- ensuring reply ordering remains stable under output chunking
- ensuring pane status transitions do not depend on the removed parser-registration path

- [ ] **Step 4: Run the e2e regression test to verify it passes**

Run:

```bash
npm run test:vitest -- --run test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Keep the e2e test narrow and deterministic:
- use captured startup-probe bytes, not a fake abstracted API
- assert the user-visible result, not internal implementation details only
- avoid timing sleeps when websocket message ordering or `waitFor` can express the contract directly

Re-run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/unit/client/components/TerminalView.capability-probes.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/opencode-startup-probes.test.tsx src/components/TerminalView.tsx src/lib/terminal-capability-probes.ts
git commit -m "test: cover opencode startup probe recovery"
```

## Task 4: Final Verification And Cutover Check

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/terminal-capability-probes.ts`
- Modify: `test/unit/client/lib/terminal-capability-probes.test.ts`
- Modify: `test/unit/client/components/TerminalView.capability-probes.test.tsx`
- Modify: `test/e2e/opencode-startup-probes.test.tsx`

- [ ] **Step 1: Run the focused verification stack**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/unit/client/components/TerminalView.capability-probes.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run any additional directly related regression coverage**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TerminalView.renderer.test.tsx \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS, proving the new preprocessing layer did not regress renderer selection, OSC 52 handling, or terminal lifecycle flow.

- [ ] **Step 3: Run the required full project suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="opencode startup probe fix" npm test
```

Expected: PASS.

- [ ] **Step 4: Manual spot check in the worktree server**

Run the worktree server on a safe port, reproduce the original path, and verify an `opencode` pane now renders:

```bash
PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

Check:
- create an `opencode` pane through the directory picker
- confirm the pane renders normal OpenCode output
- confirm no raw probe bytes appear in scrollback

Then stop only that worktree-owned process:

```bash
ps -fp "$(cat /tmp/freshell-3344.pid)"
kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid
```

- [ ] **Step 5: Refactor and verify**

If any check exposed a real defect:
- fix the code, not the tests
- re-run the focused stack
- re-run `npm test`

Do not ship with a weakened test or a fake kitty-success reply.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TerminalView.tsx \
  src/lib/terminal-capability-probes.ts \
  src/components/terminal/request-mode-bypass.ts \
  test/unit/client/lib/terminal-capability-probes.test.ts \
  test/unit/client/components/terminal/request-mode-bypass.test.ts \
  test/unit/client/components/TerminalView.capability-probes.test.tsx \
  test/e2e/opencode-startup-probes.test.tsx
git commit -m "fix: restore opencode startup in Freshell"
```

## Notes For The Implementer

- Prefer using the exact probe bytes captured from the failing OpenCode session in tests. The fix is for a real protocol interaction, not an abstract “startup hook.”
- Keep the capability parser small and query-specific. This is not a general escape-sequence emulator.
- Do not add a server-side fallback or an OpenCode-version pin. The user asked for a real fix, and the correct long-term boundary is Freshell’s terminal emulation bridge.
- Do not silently swallow all APC/OSC traffic. Only recognized startup queries should be intercepted.
- If OpenCode emits additional startup queries during implementation, add them only if they are query-only and protocol-understood. Unknown sequences should remain passthrough by default.
