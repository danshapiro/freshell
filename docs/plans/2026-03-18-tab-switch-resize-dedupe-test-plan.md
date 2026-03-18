# Tab Switch Resize Dedupe - Test Plan

## Strategy Reconciliation
The implementation plan matches the agreed strategy: the hot path is same-geometry `terminal.resize` churn on reveal, not primary attach replay. The new outbound WebSocket recorder is a test-only harness extension, so there are no strategy changes requiring user approval.

## Sources Of Truth
- `src/components/TerminalView.tsx` defines the reveal/attach/layout flow and the current resize send path.
- `server/terminal-registry.ts` is the server choke point that forwards `terminal.resize` into `pty.resize()`.
- `test/unit/client/components/TerminalView.lifecycle.test.tsx` already contains the v2 stream lifecycle harness used for the client boundary checks.
- `test/unit/server/terminal-lifecycle.test.ts` already covers resize lifecycle behavior and is the right place for no-op resize regression coverage.
- `test/e2e-browser/specs/terminal-lifecycle.spec.ts` and `test/e2e-browser/specs/tab-management.spec.ts` cover the real browser tab-switch and persistence surfaces.
- `test/e2e-browser/helpers/test-harness.ts` and `test/e2e-browser/helpers/terminal-helpers.ts` are the browser-facing observability surfaces for the new outbound log assertions.
- `test/e2e-browser/helpers/fixtures.ts` activates the harness through `?e2e=1`.

## Harness Requirements

| ID | Harness | What it does | Exposes | Complexity | Depends on |
|----|---------|--------------|---------|------------|------------|
| H1 | Outbound WS recorder | Captures actual client wire sends in `?e2e=1` mode so browser tests can assert on real traffic rather than inferred UI state | `WsClient` outbound observer hook; `window.__FRESHELL_TEST_HARNESS__.recordSentWsMessage`, `getSentWsMessages`, `clearSentWsMessages` | Low to moderate | T01, T02, T03 |
| H2 | Playwright test-harness helpers | Lets Playwright clear and read the outbound WS log from the page | `harness.getSentWsMessages()`, `harness.clearSentWsMessages()` | Low | T01, T02, T03 |

No additional harness work is required for the unit tests; they already use the existing client and server test harnesses.

## Test Plan

1. **Switching between already-live top terminal tabs does not replay the screen or emit attach/resize**
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** H1, H2, `test/e2e-browser/specs/terminal-lifecycle.spec.ts`
   - **Preconditions:** Two terminal tabs are already live, both show prompt/output text, and the page viewport has not changed. Clear the outbound WS log before the tab-switch sequence.
   - **Actions:** Create the second terminal tab through the normal UI flow, wait for its prompt, clear the outbound log, then switch back and forth between the two top tabs several times.
   - **Expected outcome:** Each tab still shows its prior terminal buffer contents after the switches, and the outbound log contains zero `terminal.attach` messages and zero `terminal.resize` messages during the reveal sequence. This is the user-visible proof that a plain top-tab switch no longer replays history through redundant network traffic.
   - **Interactions:** Tab bar selection, xterm rendering, client outbound WS observation, server PTY resize propagation.
   - **Source of truth:** `src/components/TerminalView.tsx`, `server/terminal-registry.ts`, `test/e2e-browser/specs/terminal-lifecycle.spec.ts`.

2. **Restored top tabs stay hot across page reload and still switch without replay**
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** H1, H2, `test/e2e-browser/specs/tab-management.spec.ts`
   - **Preconditions:** At least two terminal tabs exist and have prior output in their buffers before the page reload. The browser is running with `?e2e=1` so the harness is available after restore.
   - **Actions:** Reload the app through the existing e2e URL, wait for the harness and shell prompt, clear the outbound log, then switch among the restored top tabs and re-read the visible buffers.
   - **Expected outcome:** The restored buffers still contain the earlier marker output, and switching between the restored tabs does not emit `terminal.attach` or `terminal.resize`. This verifies that persistence does not regress into a fresh replay on first post-reload reveal.
   - **Interactions:** LocalStorage tab persistence, reconnect/bootstrap flow, terminal visibility attach path, outbound WS capture.
   - **Source of truth:** `src/App.tsx`, `src/components/TerminalView.tsx`, `test/e2e-browser/specs/tab-management.spec.ts`.

3. **A real viewport change still emits one resize and keeps the terminal usable**
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** H1, H2, `test/e2e-browser/specs/terminal-lifecycle.spec.ts`
   - **Preconditions:** Two live terminal tabs are present, the terminal prompt is visible, and the outbound log is clear.
   - **Actions:** Change the browser viewport size, switch away from and back to the active tab, then wait for the terminal prompt/output to settle.
   - **Expected outcome:** The outbound log contains exactly one `terminal.resize` for the affected terminal and zero `terminal.attach` messages for the same reveal sequence. The terminal remains responsive and the visible output buffer is still intact after the redraw.
   - **Interactions:** ResizeObserver, xterm fit behavior, server PTY resize path, browser layout recalculation.
   - **Source of truth:** `src/components/TerminalView.tsx`, `server/terminal-registry.ts`, `test/e2e-browser/specs/terminal-lifecycle.spec.ts`.

4. **Server resize stays idempotent for same-size requests but still applies real size changes**
   - **Type:** boundary
   - **Disposition:** extend
   - **Harness:** `test/unit/server/terminal-lifecycle.test.ts`
   - **Preconditions:** A running terminal exists in a `TerminalRegistry` test instance, and the mocked PTY exposes a spyable `resize` method.
   - **Actions:** Call `registry.resize()` once with the terminal's current `cols` and `rows`, then call it again with a different size.
   - **Expected outcome:** The same-size call returns success without calling `pty.resize()`. The changed-size call still returns success and invokes `pty.resize()` exactly once with the new dimensions. This pins the server-side backstop that prevents no-op PTY repaints from escaping the client.
   - **Interactions:** PTY lifecycle, registry logging, resize propagation to the backend terminal.
   - **Source of truth:** `server/terminal-registry.ts`, `test/unit/server/terminal-lifecycle.test.ts`.

5. **Revealing an already-live terminal only sends resize when geometry actually changes**
   - **Type:** boundary
   - **Disposition:** extend
   - **Harness:** `test/unit/client/components/TerminalView.lifecycle.test.tsx`
   - **Preconditions:** A running terminal is rendered with the existing `renderTerminalHarness()` helper, and the mock WebSocket send log is cleared before the reveal sequence.
   - **Actions:** Rerender the terminal from visible to hidden and back to visible without changing geometry, then repeat with the fit addon mocked to change the terminal dimensions before the reveal completes.
   - **Expected outcome:** The same-geometry reveal sends no `terminal.resize` and no `terminal.attach` for that already-live terminal. The changed-geometry reveal sends exactly one `terminal.resize`. This proves the client cache is keyed to the last viewport that actually went over the wire, not to an internal re-render.
   - **Interactions:** xterm fit addon, visibility effect, attach suppression, outbound WS send path.
   - **Source of truth:** `src/components/TerminalView.tsx`, `test/unit/client/components/TerminalView.lifecycle.test.tsx`.

## Coverage Summary
- Covered: top-tab switching between already-live terminals, top-tab switching after page reload/persistence, real geometry changes, server no-op resize idempotence, and client same-geometry reveal dedupe.
- Covered indirectly by existing tests: hidden first-reveal attach behavior, reconnect attach semantics, and replay ordering. Those remain important invariants but are already exercised by the current lifecycle suite.
- Explicitly excluded: manual visual inspection, mock-only proof of the browser traffic path, and any rewrite of attach hydration or reconnect policy before the resize dedupe lands.
- Residual risk: if the outbound WS recorder misses a send path, the browser scenarios could under-report traffic. The server and client boundary tests reduce that risk by pinning the two resize choke points directly.
