# Agent Chat Mobile Keyboard — Test Plan

## Harness Requirements

### Existing Harnesses (reuse)

1. **Vitest + Testing Library + jsdom** — The default-config unit test harness. Used for all component tests below. The `test/setup/dom.ts` setup file provides `setMobileForTest()` for simulating mobile viewports via the `useMobile()` hook, `ResizeObserver` stubs, and `console.error` capture.

2. **Playwright e2e-browser fixtures** — The `test/e2e-browser/helpers/fixtures.ts` harness provides `freshellPage` (a pre-navigated Freshell instance), `page` (Playwright Page), `harness` (Redux state introspection via `TestHarness`), and `terminal` (xterm.js interaction helper). Used with `test.use({ viewport })` for mobile dimensions.

3. **visualViewport mock pattern** — Established in `test/unit/client/components/TerminalView.mobile-viewport.test.tsx` and `test/e2e/terminal-mobile-viewport-flow.test.tsx`. Provides `createVisualViewportMock()` utility and `requestAnimationFrame`/`cancelAnimationFrame` spies. This pattern is reused for the `useKeyboardInset` hook tests and any component test that needs to simulate keyboard open/close.

### No new harnesses needed

All tests can be written using the existing harness infrastructure. The `useKeyboardInset` hook uses the same `visualViewport` mock pattern already proven for TerminalView, and all component tests use the standard Vitest + Testing Library + Redux store pattern already established across the agent chat test suite.

---

## Test Plan

### 1. useKeyboardInset returns 0 on desktop (no keyboard detection attempted)

- **Type**: unit
- **Disposition**: new
- **Harness**: Vitest + Testing Library `renderHook`
- **Preconditions**: `setMobileForTest(false)`, `visualViewport` mock installed with `height: 800`, `innerHeight: 800`.
- **Actions**: Render hook via `renderHook(() => useKeyboardInset())`.
- **Expected outcome**: `result.current === 0`. No `visualViewport.addEventListener` calls are made (the hook skips setup on desktop). Source of truth: implementation plan Task 1 and TerminalView's existing behavior — desktop mode never tracks `visualViewport`.
- **Interactions**: `useMobile()` hook (via `setMobileForTest`).

### 2. useKeyboardInset returns 0 on mobile when no keyboard is open

- **Type**: unit
- **Disposition**: new
- **Harness**: Vitest + Testing Library `renderHook`
- **Preconditions**: `setMobileForTest(true)`, `visualViewport` mock with `height: 800`, `innerHeight: 800` (viewport matches inner height = no keyboard).
- **Actions**: Render hook, then fire the registered `resize` handler.
- **Expected outcome**: `result.current === 0`. Event listeners are registered on `visualViewport`. Source of truth: TerminalView's existing inline implementation — `rawInset = max(0, 800 - (800 + 0)) = 0`, which is below the 80px threshold.
- **Interactions**: `visualViewport` API, `requestAnimationFrame`.

### 3. useKeyboardInset returns keyboard height on mobile when keyboard is open

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library `renderHook`
- **Preconditions**: `setMobileForTest(true)`, `visualViewport` mock with `height: 400` (keyboard takes 400px), `innerHeight: 800`.
- **Actions**: Render hook, then fire the registered `resize` handler.
- **Expected outcome**: `result.current === 400`. Source of truth: TerminalView lines 601-632 — `rawInset = max(0, 800 - (400 + 0)) = 400`, which exceeds the 80px activation threshold.
- **Interactions**: `visualViewport` API, `requestAnimationFrame`.

### 4. useKeyboardInset ignores small viewport changes below activation threshold

- **Type**: boundary
- **Disposition**: new
- **Harness**: Vitest + Testing Library `renderHook`
- **Preconditions**: `setMobileForTest(true)`, `visualViewport` mock with `height: 750` (only 50px smaller), `innerHeight: 800`.
- **Actions**: Render hook, then fire the registered `resize` handler.
- **Expected outcome**: `result.current === 0`. The 50px difference is below the 80px activation threshold, so URL bar collapse does not trigger keyboard mode. Source of truth: TerminalView constant `KEYBOARD_INSET_ACTIVATION_PX = 80`.
- **Interactions**: `visualViewport` API, `requestAnimationFrame`.

### 5. useKeyboardInset cleans up event listeners on unmount

- **Type**: unit
- **Disposition**: new
- **Harness**: Vitest + Testing Library `renderHook`
- **Preconditions**: `setMobileForTest(true)`, `visualViewport` mock with `addEventListener`/`removeEventListener` as `vi.fn()`.
- **Actions**: Render hook, then call `unmount()`.
- **Expected outcome**: `removeEventListener` called with `'resize'` and `'scroll'` and the corresponding listener functions. Source of truth: TerminalView cleanup pattern at lines 625-631.
- **Interactions**: `visualViewport` API.

### 6. TerminalView continues working after migration to shared useKeyboardInset hook

- **Type**: regression
- **Disposition**: existing (extend)
- **Harness**: Vitest + Testing Library, existing `TerminalView.mobile-viewport.test.tsx`
- **Preconditions**: TerminalView rendered with mobile mode enabled, `visualViewport` mock simulating keyboard open.
- **Actions**: Run all 5 existing tests in `TerminalView.mobile-viewport.test.tsx` without modification.
- **Expected outcome**: All 5 tests pass with identical behavior. The refactor (replacing inline `visualViewport` code with `useKeyboardInset()`) must be transparent. Source of truth: current green test results on the branch.
- **Interactions**: `useKeyboardInset` hook (now shared), xterm Terminal mock, ws-client mock.

### 7. AgentChatView applies keyboard inset padding on mobile when keyboard is open

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library, Redux store with `agentChat` + `panes` + `settings` reducers
- **Preconditions**: `setMobileForTest(true)`, `useKeyboardInset` mocked to return `300`. AgentChatView rendered with a valid `paneContent` of kind `agent-chat`.
- **Actions**: Render `AgentChatView` inside a `Provider` with a configured store.
- **Expected outcome**: The outer container (the element with `role="region"`) has `style.paddingBottom === '300px'`. Source of truth: implementation plan Task 3 Step 3 — the `keyboardContainerStyle` computation applies `paddingBottom: ${keyboardInsetPx}px` when mobile and inset > 0.
- **Interactions**: `useKeyboardInset` (mocked), `useMobile` (via `setMobileForTest`), ws-client mock, Redux store.

### 8. AgentChatView does not apply keyboard inset on desktop

- **Type**: boundary
- **Disposition**: new
- **Harness**: Vitest + Testing Library, Redux store
- **Preconditions**: `setMobileForTest(false)`, `useKeyboardInset` mocked to return `0`.
- **Actions**: Render `AgentChatView`.
- **Expected outcome**: The outer container's `style.paddingBottom` is empty/falsy. Source of truth: implementation plan Task 3 — the style is only applied when `isMobile && keyboardInsetPx > 0`.
- **Interactions**: `useKeyboardInset` (mocked), ws-client mock, Redux store.

### 9. ChatComposer send button has 44px minimum touch target on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`.
- **Actions**: Render `ChatComposer` with `onSend` and `onInterrupt` callbacks. Query the send button by its aria-label `"Send message"`.
- **Expected outcome**: The send button's className contains `min-h-11` and `min-w-11` (Tailwind's 44px utility classes). Source of truth: iOS HIG minimum 44x44pt touch target requirement; implementation plan Task 4 Step 3.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 10. ChatComposer stop button has 44px minimum touch target on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`, `isRunning={true}`.
- **Actions**: Render `ChatComposer` with `isRunning` true. Query the stop button by aria-label `"Stop generation"`.
- **Expected outcome**: The stop button's className contains `min-h-11` and `min-w-11`. Source of truth: iOS HIG 44pt requirement; implementation plan Task 4.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 11. ChatComposer buttons do not have inflated touch targets on desktop

- **Type**: boundary
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(false)`.
- **Actions**: Render `ChatComposer`. Query the send button.
- **Expected outcome**: The send button's className does NOT contain `min-h-11`. Desktop retains the compact `p-2` styling. Source of truth: implementation plan architectural decision "Why increase touch targets conditionally rather than always?" — desktop density is preserved.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 12. PermissionBanner Allow and Deny buttons have 44px minimum touch target on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`.
- **Actions**: Render `PermissionBanner` with a permission for the `Bash` tool.
- **Expected outcome**: Both the `"Allow tool use"` and `"Deny tool use"` buttons have `min-h-11` in their className. Source of truth: iOS HIG; implementation plan Task 5.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 13. PermissionBanner buttons do not have inflated touch targets on desktop

- **Type**: boundary
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(false)`.
- **Actions**: Render `PermissionBanner`.
- **Expected outcome**: The `"Allow tool use"` button's className does NOT contain `min-h-11`. Source of truth: implementation plan Task 5 — conditional sizing.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 14. QuestionBanner option buttons have 44px minimum touch target on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`.
- **Actions**: Render `QuestionBanner` with a single-select question with two options ("Option A", "Option B").
- **Expected outcome**: The `"Option A"` button has `min-h-11` in its className. Source of truth: iOS HIG; implementation plan Task 6.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 15. QuestionBanner Other button has 44px minimum touch target on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`.
- **Actions**: Render `QuestionBanner` with options. Query the `"Other"` button.
- **Expected outcome**: The `"Other"` button has `min-h-11` in its className. Source of truth: implementation plan Task 6.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 16. AgentChatSettings bottom sheet accounts for keyboard inset on mobile

- **Type**: scenario
- **Disposition**: extend (existing test file `AgentChatSettings.mobile.test.tsx`)
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`, `useKeyboardInset` mocked to return `300`. Settings rendered with `defaultOpen={true}`.
- **Actions**: Render `AgentChatSettings`. Query the dialog element.
- **Expected outcome**: The dialog's `style.bottom === '300px'`. The settings bottom sheet is pushed above the keyboard. Source of truth: implementation plan Task 7 — "the bottom sheet should not render behind the keyboard".
- **Interactions**: `useKeyboardInset` (mocked), `useMobile` (via `setMobileForTest`).

### 17. AgentChatSettings bottom sheet is at bottom:0 when no keyboard is open on mobile

- **Type**: boundary
- **Disposition**: extend (existing test file)
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`, `useKeyboardInset` mocked to return `0`.
- **Actions**: Render `AgentChatSettings` with `defaultOpen={true}`.
- **Expected outcome**: The dialog's `style.bottom === '0px'` (or empty/default). Source of truth: implementation plan Task 7 — `bottom: ${keyboardInsetPx}px`, when inset is 0.
- **Interactions**: `useKeyboardInset` (mocked), `useMobile` (via `setMobileForTest`).

### 18. ToolStrip toggle button has adequate touch target on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`.
- **Actions**: Render `ToolStrip` with a pair of completed tools (collapsed state). Query the `"Toggle tool details"` button.
- **Expected outcome**: The button's className contains `min-h-11` and `min-w-11`. Source of truth: iOS HIG; implementation plan Task 8.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 19. ToolStrip expanded toggle button has adequate touch target on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`.
- **Actions**: Render `ToolStrip` with `showTools={true}` (starts expanded). Query the `"Toggle tool details"` button.
- **Expected outcome**: The button's className contains `min-h-11` and `min-w-11`. Source of truth: implementation plan Task 8 — both collapsed and expanded toggle buttons get mobile sizing.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 20. ToolStrip toggle button stays compact on desktop

- **Type**: boundary
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(false)`.
- **Actions**: Render `ToolStrip` with completed tools.
- **Expected outcome**: The toggle button's className does NOT contain `min-h-11`. It keeps the compact `p-0.5` sizing. Source of truth: implementation plan — conditional sizing preserves desktop density.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 21. AgentChatView uses tighter horizontal padding on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library, Redux store
- **Preconditions**: `setMobileForTest(true)`, `useKeyboardInset` mocked to return `0`.
- **Actions**: Render `AgentChatView`. Inspect the scroll container's className.
- **Expected outcome**: The scroll container (data-context="agent-chat") has `px-2` in its className (not `px-3`). The status bar also has `px-2`. Source of truth: implementation plan Task 9 — mobile uses `px-2` for tighter horizontal padding.
- **Interactions**: `useMobile` (via `setMobileForTest`), ws-client mock, Redux store.

### 22. AgentChatView uses standard horizontal padding on desktop

- **Type**: boundary
- **Disposition**: new
- **Harness**: Vitest + Testing Library, Redux store
- **Preconditions**: `setMobileForTest(false)`.
- **Actions**: Render `AgentChatView`. Inspect the scroll container.
- **Expected outcome**: The scroll container has `px-3` in its className. Source of truth: current existing desktop behavior preserved.
- **Interactions**: ws-client mock, Redux store.

### 23. ChatComposer uses tighter horizontal padding on mobile

- **Type**: scenario
- **Disposition**: new
- **Harness**: Vitest + Testing Library
- **Preconditions**: `setMobileForTest(true)`.
- **Actions**: Render `ChatComposer`. Inspect the outer div's className.
- **Expected outcome**: The outer div has `px-2` in its className (not `px-3`). Source of truth: implementation plan Task 9.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 24. Existing PermissionBanner functionality preserved (Allow sends response)

- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest + Testing Library, existing `PermissionBanner.test.tsx`
- **Preconditions**: Standard desktop mode (default).
- **Actions**: Run all existing tests in `PermissionBanner.test.tsx`.
- **Expected outcome**: All existing tests pass. Adding `useMobile()` and conditional classes must not break Allow/Deny click behavior or rendering. Source of truth: current green test suite.
- **Interactions**: None new.

### 25. Existing QuestionBanner functionality preserved (option selection and "Other" flow)

- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest + Testing Library, existing `QuestionBanner.test.tsx`
- **Preconditions**: Standard desktop mode (default).
- **Actions**: Run all existing tests in `QuestionBanner.test.tsx`.
- **Expected outcome**: All existing tests pass. Source of truth: current green test suite.
- **Interactions**: None new.

### 26. Existing ChatComposer functionality preserved (send, Enter key, disabled state)

- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest + Testing Library, existing `ChatComposer.test.tsx`
- **Preconditions**: Standard desktop mode (default).
- **Actions**: Run all existing tests in `ChatComposer.test.tsx`.
- **Expected outcome**: All existing tests pass. Source of truth: current green test suite.
- **Interactions**: None new.

### 27. Existing AgentChatView behavior preserved (scroll, status, sessions)

- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest + Testing Library, existing `AgentChatView.*.test.tsx` suite
- **Preconditions**: Standard desktop mode (default).
- **Actions**: Run all existing AgentChatView test files.
- **Expected outcome**: All tests pass. The addition of `useMobile()`, `useKeyboardInset()`, and padding changes must not regress existing behavior. Source of truth: current green test suite.
- **Interactions**: ws-client mock, Redux store.

### 28. Existing ToolStrip behavior preserved (expand/collapse, slot reel)

- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest + Testing Library, existing `ToolStrip.test.tsx`
- **Preconditions**: Standard desktop mode (default).
- **Actions**: Run all existing tests in `ToolStrip.test.tsx`.
- **Expected outcome**: All tests pass. Source of truth: current green test suite.
- **Interactions**: None new.

### 29. Existing AgentChatSettings mobile behavior preserved (bottom sheet, backdrop close)

- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest + Testing Library, existing `AgentChatSettings.mobile.test.tsx`
- **Preconditions**: Standard mobile mode.
- **Actions**: Run all existing tests in `AgentChatSettings.mobile.test.tsx`.
- **Expected outcome**: All tests pass. Source of truth: current green test suite.
- **Interactions**: `useMobile` (via `setMobileForTest`).

### 30. E2E: Agent chat composer and region are visible on mobile viewport

- **Type**: scenario
- **Disposition**: extend (existing `mobile-viewport.spec.ts`)
- **Harness**: Playwright e2e-browser fixtures
- **Preconditions**: Freshell running, viewport set to `{ width: 390, height: 844 }` (iPhone 14). An agent-chat pane created via Redux dispatch (injecting `freshclaude` pane content to avoid needing a real Claude CLI).
- **Actions**: Set up an agent-chat pane. Verify the chat region and composer are visible.
- **Expected outcome**: `page.getByRole('region', { name: /chat/i })` is visible. `page.getByRole('button', { name: /send message/i })` is visible. Source of truth: implementation plan Task 10 — the agent chat UI must render correctly on a mobile viewport with all interactive elements reachable.
- **Interactions**: Freshell server, WebSocket connection, Redux store (via test harness).

### 31. E2E: Agent chat permission banner buttons are usable on mobile

- **Type**: scenario
- **Disposition**: extend (existing `agent-chat.spec.ts` pattern)
- **Harness**: Playwright e2e-browser fixtures
- **Preconditions**: Freshell running, mobile viewport `{ width: 390, height: 844 }`. Agent-chat pane with a pending permission request injected via Redux.
- **Actions**: Verify the permission banner's Allow and Deny buttons are visible and clickable. Click Allow.
- **Expected outcome**: The `sdk.permission.respond` WebSocket message is sent with `behavior: 'allow'`. Buttons are large enough to be tap-targeted on mobile. Source of truth: existing `agent-chat.spec.ts` test "permission banners appear and allow sends a response" — this extends it to mobile dimensions.
- **Interactions**: Freshell server, WebSocket protocol, Redux store.

### 32. Full test suite passes (coordinated run)

- **Type**: invariant
- **Disposition**: existing
- **Harness**: `npm test` (coordinated full suite)
- **Preconditions**: All implementation tasks complete.
- **Actions**: Run `npm test`.
- **Expected outcome**: All unit, integration, and server tests pass. Source of truth: the project's CI gate.
- **Interactions**: Full system.

### 33. Typecheck passes

- **Type**: invariant
- **Disposition**: existing
- **Harness**: `npm run check` (typecheck + test suite)
- **Preconditions**: All implementation tasks complete.
- **Actions**: Run `npm run check`.
- **Expected outcome**: Zero TypeScript errors, all tests pass. Source of truth: project CI requirement.
- **Interactions**: Full system.

---

## Coverage Summary

### Covered areas

| Area | Tests | Coverage quality |
|------|-------|-----------------|
| `useKeyboardInset` hook (core logic) | #1-5 | Full: desktop, mobile no-keyboard, mobile keyboard-open, threshold boundary, cleanup |
| TerminalView migration (refactor safety) | #6 | Full: existing 5-test suite serves as refactor regression gate |
| AgentChatView keyboard-aware layout | #7-8, #21-22, #27 | Full: mobile inset applied, desktop unchanged, padding adaptation, existing behavior preserved |
| ChatComposer mobile touch targets | #9-11, #23, #26 | Full: send/stop at 44px on mobile, compact on desktop, padding adaptation, existing behavior preserved |
| PermissionBanner mobile touch targets | #12-13, #24 | Full: Allow/Deny at 44px on mobile, compact on desktop, existing behavior preserved |
| QuestionBanner mobile touch targets | #14-15, #25 | Full: option/Other buttons at 44px on mobile, existing behavior preserved |
| AgentChatSettings keyboard awareness | #16-17, #29 | Full: bottom sheet offset by keyboard inset, no-keyboard baseline, existing behavior preserved |
| ToolStrip mobile touch targets | #18-20, #28 | Full: collapsed/expanded toggle at 44px on mobile, compact on desktop, existing behavior preserved |
| E2E mobile viewport integration | #30-31 | Key scenarios: agent chat visible on mobile, permission banner usable on mobile |
| Full suite invariants | #32-33 | Coordinated run + typecheck confirm no regressions |

### Explicitly excluded per agreed strategy

- **Virtual keyboard simulation in Playwright**: Playwright does not support simulating `visualViewport` changes from a real virtual keyboard on emulated mobile devices. The `useKeyboardInset` hook is thoroughly tested at the unit level (tests #1-5) where `visualViewport` can be mocked precisely. The e2e tests (#30-31) verify the UI structure and interactivity on mobile viewports without keyboard simulation.

- **Container query responsive layout**: The implementation plan does not include container queries (they were discussed in the conversation but not selected for this phase). No tests needed.

- **iOS safe-area padding**: `env(safe-area-inset-bottom)` is a CSS feature that cannot be meaningfully asserted in jsdom or headless Chromium. The implementation is a single-class addition that is visually verifiable but not programmatically testable in the test environment.

### Risk assessment of exclusions

- The virtual keyboard exclusion is low-risk because the unit tests cover the exact same code path (the `useKeyboardInset` hook) that runs in production, and the integration point (applying `paddingBottom` to the container) is tested in test #7.

- The safe-area exclusion is low-risk because it is a single CSS class addition (`safe-area-bottom`) that is defined in `index.css` and used by other components already.
