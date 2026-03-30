# Clickable Terminal URLs -- Test Plan

This test plan is aligned with the [implementation plan](./clickable-terminal-urls.md) and follows Red-Green-Refactor TDD order. Tests are grouped by implementation phase so the red phase of each feature can be written before the green.

---

## Phase 1: Utility Modules (terminal-hovered-url + url-utils)

### 1.1 `test/unit/client/lib/terminal-hovered-url.test.ts` (new file)

Tests for the module-level `Map<string, string>` that tracks the currently hovered URL per pane.

| # | Test name | Verifies | Setup/Mocking | Assertions |
|---|-----------|----------|---------------|------------|
| 1 | `getHoveredUrl returns undefined for unknown paneId` | Default state is empty | None | `getHoveredUrl('pane-x')` returns `undefined` |
| 2 | `setHoveredUrl stores a URL for a pane` | Basic set/get round-trip | `setHoveredUrl('pane-1', 'https://a.com')` | `getHoveredUrl('pane-1')` returns `'https://a.com'` |
| 3 | `setHoveredUrl overwrites a previous URL for the same pane` | Overwrite semantics | Set twice with different URLs for same paneId | `getHoveredUrl` returns the second URL |
| 4 | `clearHoveredUrl removes the stored URL` | Clear semantics | Set then clear | `getHoveredUrl` returns `undefined` |
| 5 | `clearHoveredUrl on unknown paneId is a no-op` | No-op on missing key | `clearHoveredUrl('nonexistent')` | No error thrown |
| 6 | `multiple panes are tracked independently` | Pane isolation | Set different URLs for `pane-1` and `pane-2` | Each `getHoveredUrl` returns its own URL; clearing `pane-1` does not affect `pane-2` |

**Module isolation note**: Since the module uses a singleton `Map`, each test must call `clearHoveredUrl` in `afterEach` (or the module should export a `clearAll()` for testing). Alternatively, Vitest's `vi.resetModules()` can re-import a fresh instance per test. The implementation should decide; the tests should verify isolation either way.

---

### 1.2 `test/unit/client/lib/url-utils.test.ts` (new file)

Tests for `findUrls(line: string): UrlMatch[]`.

| # | Test name | Verifies | Input | Assertions |
|---|-----------|----------|-------|------------|
| 1 | `finds a simple https URL` | Basic detection | `'Visit https://example.com for info'` | One match: `{ url: 'https://example.com', startIndex: 6, endIndex: 26 }` |
| 2 | `finds a simple http URL` | http scheme | `'See http://example.org/page'` | One match with correct url, startIndex, endIndex |
| 3 | `finds multiple URLs on one line` | Multi-match | `'Links: https://a.com and https://b.com/path'` | Two matches in order |
| 4 | `strips trailing period from URL` | Trailing punct trim | `'Go to https://example.com/path.'` | URL is `'https://example.com/path'`, not `'https://example.com/path.'` |
| 5 | `strips trailing comma` | Trailing punct trim | `'See https://example.com/path, then continue'` | URL does not end with `,` |
| 6 | `strips trailing semicolon` | Trailing punct trim | `'URL: https://example.com;'` | URL does not end with `;` |
| 7 | `strips trailing closing parenthesis` | Trailing punct trim | `'(see https://example.com/page)'` | URL is `'https://example.com/page'` (trailing `)` stripped) |
| 8 | `strips trailing exclamation mark` | Trailing punct trim | `'Check https://example.com!'` | URL does not end with `!` |
| 9 | `preserves URL with query string` | Query strings | `'https://example.com/search?q=test&page=1'` | Full URL including query preserved |
| 10 | `preserves URL with fragment` | Fragments | `'https://example.com/docs#section-2'` | Fragment preserved |
| 11 | `preserves URL with port number` | Ports | `'http://localhost:3000/api/health'` | Full URL including port preserved |
| 12 | `preserves URL with path and trailing slash` | Trailing slash | `'https://example.com/path/'` | Trailing slash preserved |
| 13 | `returns empty array for line with no URLs` | No false positives | `'Just a normal line of text'` | Empty array |
| 14 | `does not match ftp or other schemes` | http/https only | `'Download from ftp://files.example.com/data'` | Empty array |
| 15 | `handles URL at start of line` | Edge: start of line | `'https://example.com is great'` | One match with `startIndex: 0` |
| 16 | `handles URL at end of line` | Edge: end of line | `'Visit https://example.com'` | One match, `endIndex` equals line length minus nothing |
| 17 | `handles URL that is the entire line` | Edge: full line | `'https://example.com/path/to/resource'` | One match spanning entire line |
| 18 | `does not match bare domains without scheme` | No scheme = no match | `'Go to example.com for info'` | Empty array |
| 19 | `handles multiple trailing punctuation characters` | Multi-char trailing punct | `'See https://example.com/page.),'` | URL is `'https://example.com/page'` |
| 20 | `preserves URL with encoded characters` | Percent-encoding | `'https://example.com/path%20with%20spaces'` | Full URL preserved |

---

## Phase 2: Left-Click Behavior Change (TerminalView)

### 2.1 Update `test/unit/client/components/TerminalView.linkWarning.test.tsx` (existing file)

These tests currently assert `window.open` is called. After the implementation change, link confirm and bypass should dispatch `splitPane` to create a browser pane instead.

| # | Test name (existing, updated) | What changes | Assertions (before -> after) |
|---|-------------------------------|--------------|------------------------------|
| 1 | `opens link and closes modal on confirm` | Confirm now opens browser pane | **Remove**: `expect(windowOpenSpy).toHaveBeenCalledWith(...)`. **Add**: `store.getState().panes.layouts['tab-1']` is a split with second child having `content.kind === 'browser'` and `content.url === 'https://example.com/page'`. Modal still dismissed. |
| 2 | `bypasses modal when warnExternalLinks is disabled` | Direct click opens browser pane | **Remove**: `expect(windowOpenSpy).toHaveBeenCalledWith(...)`. **Add**: `store.getState().panes.layouts['tab-1']` is a split with browser pane. `window.open` not called. Modal never shown. |
| 3 | `shows confirm modal when link is clicked with warnExternalLinks enabled` | No change needed | Assertions remain the same (modal shown, window.open not called). Already correct. |
| 4 | `does not open link on cancel` | No change needed | Assertions remain the same (no window.open, no pane split). Optionally verify layout remains a leaf. |

**Setup/mocking**: The existing test infrastructure (`createStore`, `activateLinkHandler`, `terminalInstances`) is sufficient. The `windowOpenSpy` can remain for negative assertions (verifying `window.open` is NOT called). The key new assertion pattern is checking Redux state:

```ts
const layout = store.getState().panes.layouts['tab-1']
expect(layout.type).toBe('split')
if (layout.type === 'split') {
  expect(layout.children[1]).toMatchObject({
    type: 'leaf',
    content: { kind: 'browser', url: expectedUrl, devToolsOpen: false },
  })
}
```

---

### 2.2 Update `test/unit/client/components/TerminalView.keyboard.test.tsx` (existing file)

The `registerLinkProvider` mock currently captures only the last registered provider. After the implementation adds a second provider (URL link provider), the mock needs to distinguish between the file path provider (registered first) and the URL provider (registered second).

| # | Change description | What to modify |
|---|-------------------|----------------|
| 1 | Capture all registered link providers in an array | Change `capturedLinkProvider` from a single variable to `capturedLinkProviders: any[] = []`. Update the `registerLinkProvider` mock to `push` each provider onto the array. |
| 2 | Expose named references | After render + `waitFor`, set `capturedFilePathProvider = capturedLinkProviders[0]` and `capturedUrlProvider = capturedLinkProviders[1]`. |
| 3 | Update existing file path link tests | All existing tests that use `capturedLinkProvider` (lines 852-965) should use `capturedFilePathProvider` instead. No assertion changes needed -- only the variable name. |

The existing keyboard tests (paste, copy, tab switching, search, etc.) should not need any changes since they test `attachCustomKeyEventHandler`, not link providers.

---

### 2.3 `test/unit/client/components/TerminalView.urlClick.test.tsx` (new file)

Tests for the new left-click-opens-browser-pane behavior, including the URL link provider and the OSC 8 linkHandler changes.

**Test infrastructure**: Follow the same pattern as `TerminalView.linkWarning.test.tsx` -- mock `@xterm/xterm`, `@xterm/addon-fit`, `@/lib/ws-client`, `@/lib/terminal-themes`, `ResizeObserver`, and render `TerminalView` inside a `Provider` with a Redux store.

The `MockTerminal` should capture:
- `options.linkHandler` (for OSC 8 hover/leave callbacks)
- All `registerLinkProvider` calls (array, to get both file path and URL providers)
- `buffer.active.getLine` should return text containing a URL for the URL provider tests

| # | Test name | Verifies | Setup | Assertions |
|---|-----------|----------|-------|------------|
| 1 | `OSC 8 linkHandler.activate with warnExternalLinks=false dispatches splitPane with browser content` | Left-click opens browser pane (bypass mode) | Store with `warnExternalLinks: false`. Render TerminalView. Access `term.options.linkHandler.activate`. | Call `activate(mouseEvent, 'https://example.com')`. Check `store.getState().panes.layouts['tab-1']` has split with browser pane `{ kind: 'browser', url: 'https://example.com', devToolsOpen: false }`. `window.open` NOT called. |
| 2 | `OSC 8 linkHandler.activate with warnExternalLinks=true shows modal, confirm opens browser pane` | Warning modal + browser pane | Store with default settings (warnExternalLinks=true). Activate link handler. | Modal shown. Click "Open link". Layout becomes split with browser pane. `window.open` NOT called. |
| 3 | `OSC 8 linkHandler.hover sets hovered URL in module and data attribute` | Hover state tracking for OSC 8 | Render TerminalView. Get `term.options.linkHandler.hover`. | Call `hover(mouseEvent, 'https://hovered.example.com', mockRange)`. Verify `getHoveredUrl('pane-1')` returns `'https://hovered.example.com'`. Verify the wrapper div has `dataset.hoveredUrl === 'https://hovered.example.com'`. |
| 4 | `OSC 8 linkHandler.leave clears hovered URL from module and data attribute` | Leave clears state | Set hovered URL via hover callback, then call leave. | `getHoveredUrl('pane-1')` returns `undefined`. Wrapper div does not have `dataset.hoveredUrl`. |
| 5 | `URL link provider activate with warnExternalLinks=false dispatches splitPane with browser content` | Plain-text URL click opens browser pane | Mock `buffer.active.getLine` to return text with `'Visit https://detected.example.com here'`. Get the URL link provider (second `registerLinkProvider` call). Call `provideLinks` then `activate` on the returned link. | Layout becomes split with browser pane for `'https://detected.example.com'`. |
| 6 | `URL link provider hover sets hovered URL in module and data attribute` | Hover on plain-text URL | Get URL link provider. Call `provideLinks`, then `hover` on the link. | `getHoveredUrl('pane-1')` set. Wrapper div `dataset.hoveredUrl` set. |
| 7 | `URL link provider leave clears hovered URL` | Leave on plain-text URL | Hover then leave on URL link. | Hovered URL cleared. |
| 8 | `URL link provider detects URLs in terminal buffer line` | URL detection integration | Mock buffer line with `'Check http://localhost:3000/api/health for status'`. | `provideLinks` callback receives a link array with text `'http://localhost:3000/api/health'` and correct range. |
| 9 | `URL link provider returns undefined for lines with no URLs` | No false positives | Mock buffer line with `'Just a normal line with /tmp/file.txt'`. | `provideLinks` callback receives `undefined`. |
| 10 | `terminal dispose clears hovered URL` | Cleanup on unmount | Set hovered URL via hover callback. Unmount the component. | `getHoveredUrl('pane-1')` returns `undefined`. |

**Mocking details for wrapper div access**: To verify `dataset.hoveredUrl`, the test needs access to the DOM element with `data-context="terminal"`. Use `container.querySelector('[data-context="terminal"]')` from the render result, or `screen.getByTestId` if a testid is added. The existing pattern uses `data-context`, `data-pane-id`, and `data-tab-id` attributes which can be queried directly.

---

## Phase 3: Context Menu Integration

### 3.1 `test/unit/client/components/context-menu/context-menu-utils.test.ts` (new file)

Tests for `parseContextTarget` with the new `hoveredUrl` field on terminal targets.

| # | Test name | Verifies | Setup | Assertions |
|---|-----------|----------|-------|------------|
| 1 | `parseContextTarget for Terminal returns hoveredUrl from dataset` | hoveredUrl extraction | `contextId = ContextIds.Terminal`, `data = { tabId: 'tab-1', paneId: 'pane-1', hoveredUrl: 'https://example.com' }` | Returns `{ kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1', hoveredUrl: 'https://example.com' }` |
| 2 | `parseContextTarget for Terminal returns hoveredUrl as undefined when not in dataset` | Optional field | `data = { tabId: 'tab-1', paneId: 'pane-1' }` (no `hoveredUrl`) | Returns `{ kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1', hoveredUrl: undefined }` |
| 3 | `parseContextTarget for Terminal returns null when tabId is missing` | Existing behavior preserved | `data = { paneId: 'pane-1' }` | Returns `null` |
| 4 | `parseContextTarget for Terminal returns null when paneId is missing` | Existing behavior preserved | `data = { tabId: 'tab-1' }` | Returns `null` |
| 5 | `parseContextTarget for Global returns global target` | Regression guard | `contextId = ContextIds.Global`, `data = {}` | Returns `{ kind: 'global' }` |
| 6 | `parseContextTarget for Tab returns tab target with tabId` | Regression guard | `contextId = ContextIds.Tab`, `data = { tabId: 'tab-1' }` | Returns `{ kind: 'tab', tabId: 'tab-1' }` |

**No mocking needed** -- `parseContextTarget` is a pure function.

---

### 3.2 `test/unit/client/components/context-menu/menu-defs.test.ts` (new file)

Tests for `buildMenuItems` focusing on the terminal target with `hoveredUrl`. This is a new test file.

**Setup**: Create helper functions:
- `createMockActions()` -- returns a `MenuActions` object with `vi.fn()` for all actions (the current 67 + 4 new URL actions)
- `createMockContext(overrides)` -- returns a `MenuBuildContext` with sensible defaults

The mock actions object must match the full `MenuActions` type signature. The 4 new URL actions:
```ts
openUrlInPane: vi.fn(),
openUrlInTab: vi.fn(),
openUrlInBrowser: vi.fn(),
copyUrl: vi.fn(),
```

The `getTerminalActions` mock should return a mock `TerminalActions` with `hasSelection: () => false` and stubs for all other methods.

| # | Test name | Verifies | Setup | Assertions |
|---|-----------|----------|-------|------------|
| 1 | `terminal target with hoveredUrl includes URL menu items at the top` | URL items prepended | Target: `{ kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1', hoveredUrl: 'https://example.com' }` | Items array starts with: `url-open-pane`, `url-open-tab`, `url-open-browser`, `url-copy`, then a separator `url-sep`, then the existing terminal clipboard items (`terminal-copy`, `terminal-paste`, `terminal-select-all`). |
| 2 | `terminal target without hoveredUrl has no URL menu items` | No URL items when no hover | Target: `{ kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }` (no `hoveredUrl`) | First item is `terminal-copy` (no `url-*` items). |
| 3 | `url-open-pane item calls openUrlInPane with correct args` | Action wiring | Build items with `hoveredUrl: 'https://test.url'`. Find item with `id === 'url-open-pane'`. Call `onSelect`. | `mockActions.openUrlInPane` called with `('tab-1', 'pane-1', 'https://test.url')` |
| 4 | `url-open-tab item calls openUrlInTab with correct args` | Action wiring | Same setup. Find item `url-open-tab`. Call `onSelect`. | `mockActions.openUrlInTab` called with `('https://test.url')` |
| 5 | `url-open-browser item calls openUrlInBrowser with correct args` | Action wiring | Same setup. Find item `url-open-browser`. Call `onSelect`. | `mockActions.openUrlInBrowser` called with `('https://test.url')` |
| 6 | `url-copy item calls copyUrl with correct args` | Action wiring | Same setup. Find item `url-copy`. Call `onSelect`. | `mockActions.copyUrl` called with `('https://test.url')` |
| 7 | `URL items have correct labels` | UX labels | Build items with `hoveredUrl`. | Labels: `'Open URL in pane'`, `'Open URL in new tab'`, `'Open in external browser'`, `'Copy URL'` |
| 8 | `existing terminal menu items still present after URL items` | No regression | Build items with `hoveredUrl`. | Items include `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`, `terminal-clear`, `terminal-reset`, `replace-pane` (by id). |

---

## Phase 4: Integration Tests (E2E-style with full component tree)

### 4.1 `test/e2e/terminal-url-link-click.test.tsx` (new file)

Integration test modeled after `terminal-file-link-same-tab.test.tsx`. Renders `TabContent` (the full pane layout) and verifies that clicking a URL in a terminal pane opens a browser pane in the same tab.

**Test infrastructure**: Follow the exact same pattern as `terminal-file-link-same-tab.test.tsx`:
- Mock `@/lib/ws-client`, `@/lib/api`, `@/lib/terminal-themes`, `@/components/terminal/terminal-runtime`, `@xterm/xterm` (with `linkProvidersByPaneId` to capture providers per pane), `@xterm/addon-fit`, `@xterm/xterm/css/xterm.css`
- The buffer line mock should return a line containing a URL (e.g., `'Visit https://example.com/docs for more info'`)
- Create a multi-pane layout store

| # | Test name | Verifies | Setup | Assertions |
|---|-----------|----------|-------|------------|
| 1 | `clicking a URL in a nested terminal pane opens a browser pane on the same tab branch` | Full integration: URL detection + splitPane + layout | Multi-pane layout like `terminal-file-link-same-tab.test.tsx`. Buffer line contains `'Visit https://example.com/docs for more info'`. Access the URL link provider for `pane-clicked`. Call `provideLinks` + `activate`. | Tab count stays at 1. Active tab unchanged. Layout shows a new split off the clicked pane with `content: { kind: 'browser', url: 'https://example.com/docs', devToolsOpen: false }`. |
| 2 | `OSC 8 link click in a nested pane opens browser pane (with warnExternalLinks disabled)` | OSC 8 integration path | Same multi-pane layout. `warnExternalLinks: false`. Access `linkHandler.activate` on the terminal for the clicked pane. | Browser pane created on the clicked pane's branch. |

**Key difference from the file link test**: The file link test checks for `kind: 'editor'`; this test checks for `kind: 'browser'` with the URL. The mock buffer line must contain a URL instead of a file path.

---

### 4.2 `test/e2e/terminal-url-context-menu.test.tsx` (new file)

Integration test modeled after `pane-context-menu-stability.test.tsx`. Renders `PaneLayout` inside `ContextMenuProvider` and verifies that URL-specific context menu items appear when right-clicking while a URL is hovered.

**Test infrastructure**: Follow `pane-context-menu-stability.test.tsx`:
- Mock all the same modules
- Render with `ContextMenuProvider` wrapping `PaneLayout`
- Use `userEvent` for right-click interaction

| # | Test name | Verifies | Setup | Assertions |
|---|-----------|----------|-------|------------|
| 1 | `right-clicking a terminal pane with a hovered URL shows URL-specific menu items` | URL context menu integration | Render a two-pane layout. Set `data-hovered-url` on the terminal wrapper div (simulating hover state). Right-click the terminal surface. | Menu is visible. Menu contains items with labels: `'Open URL in pane'`, `'Open URL in new tab'`, `'Open in external browser'`, `'Copy URL'`. The standard terminal items (`Copy`, `Paste`, `Select all`, `Search`) are also present below. |
| 2 | `right-clicking a terminal pane without a hovered URL shows no URL-specific items` | No URL items without hover | Same layout, no `data-hovered-url` attribute. Right-click. | Menu visible. No items with labels matching `'Open URL'` or `'Copy URL'`. Standard terminal items present. |
| 3 | `selecting "Open URL in pane" creates a browser pane split` | End-to-end action | Render, set hovered URL, right-click, click `'Open URL in pane'`. | Menu closes. Layout becomes a split with a browser pane containing the hovered URL. |

**Mocking details for `data-hovered-url`**: The hover/leave callbacks are triggered by xterm.js link events which are hard to simulate in JSDOM. Instead, imperatively set `dataset.hoveredUrl` on the terminal wrapper div before triggering the right-click. The context menu system reads from `dataset` via `copyDataset`, so this accurately tests the integration path. Access the wrapper via `container.querySelector('[data-pane-id="pane-1"][data-context="terminal"]')`.

---

## Phase 5: Cleanup and Edge Cases

### 5.1 Additional tests in `TerminalView.urlClick.test.tsx`

| # | Test name | Verifies | Setup | Assertions |
|---|-----------|----------|-------|------------|
| 1 | `hover state is cleared when terminal tab becomes hidden` | Tab switch cleanup | Render TerminalView (visible). Set hovered URL via hover callback. Re-render with `hidden={true}`. | `getHoveredUrl('pane-1')` returns `undefined`. |
| 2 | `file path link provider is registered before URL link provider` | Registration order | Render TerminalView. Inspect `registerLinkProvider.mock.calls`. | First call registers a provider that detects file paths (test with a file path line). Second call registers a provider that detects URLs (test with a URL line). |

---

## Phase 6: Browser-Use E2E Smoke Test

### 6.1 `test/e2e-browser/specs/terminal-url-click.spec.ts` (new file)

A Playwright-based browser-use E2E test that verifies the URL click feature works in a real browser environment. This is a smoke test, not exhaustive.

**Test infrastructure**: Uses the existing Playwright fixtures from `test/e2e-browser/helpers/fixtures.js`.

| # | Test name | Verifies | Setup | Key assertions |
|---|-----------|----------|-------|----------------|
| 1 | `right-clicking a terminal shows URL menu items when hovering a link` | Full browser integration | Navigate to freshell. Wait for terminal. Need a URL to be present in terminal output. Use `send-keys` to echo a URL, then hover it. Right-click. | Context menu appears with `'Open URL in pane'`, `'Copy URL'` items. |

**Note**: This test depends on xterm.js actually rendering and detecting URLs in a real browser. It may be fragile since it requires the URL to be linkified by xterm. If this proves too brittle, the test can be scoped to just verifying that the context menu renders the URL items when the `data-hovered-url` attribute is present (set via Playwright's `evaluate`), which tests the context menu integration path without depending on xterm link detection.

---

## Execution Order (TDD Phases)

The implementation plan specifies this execution order, and the tests align to it:

| Step | Red (write failing test) | Green (make it pass) |
|------|--------------------------|----------------------|
| 1 | Write tests 1.1 (`terminal-hovered-url.test.ts`) and 1.2 (`url-utils.test.ts`) | Implement `src/lib/terminal-hovered-url.ts` and `src/lib/url-utils.ts` |
| 2 | Write tests 2.3 (`TerminalView.urlClick.test.tsx`) -- tests 1-2, 5, 8-9 (left-click + URL provider detection) | Update `TerminalView.tsx`: linkHandler activate/hover/leave, URL link provider, wrapperRef |
| 3 | Update tests 2.1 (`TerminalView.linkWarning.test.tsx`) -- assertions change | Update `TerminalView.tsx`: warning modal confirm handler |
| 4 | Update tests 2.2 (`TerminalView.keyboard.test.tsx`) -- provider capture | Already passing if mock is updated before green phase |
| 5 | Write tests 2.3 remaining (`TerminalView.urlClick.test.tsx`) -- tests 3-4, 6-7, 10 (hover/leave/cleanup) | Already implemented in step 2 green phase |
| 6 | Write tests 3.1 (`context-menu-utils.test.ts`) and 3.2 (`menu-defs.test.ts`) | Update context-menu-types, context-menu-utils, menu-defs, ContextMenuProvider |
| 7 | Write tests 4.1 (`terminal-url-link-click.test.tsx`) and 4.2 (`terminal-url-context-menu.test.tsx`) | Already passing (integration of all prior phases) |
| 8 | Write tests 5.1 (cleanup edge cases) | Add cleanup in TerminalView hidden effect and dispose |
| 9 | Refactor phase -- no new tests, ensure all existing pass | |
| 10 | Write test 6.1 (browser-use E2E smoke test) | Should pass against the completed implementation |

---

## New Test Files Summary

| File | Type | Count |
|------|------|-------|
| `test/unit/client/lib/terminal-hovered-url.test.ts` | Unit | 6 tests |
| `test/unit/client/lib/url-utils.test.ts` | Unit | 20 tests |
| `test/unit/client/components/TerminalView.urlClick.test.tsx` | Unit | 12 tests |
| `test/unit/client/components/context-menu/context-menu-utils.test.ts` | Unit | 6 tests |
| `test/unit/client/components/context-menu/menu-defs.test.ts` | Unit | 8 tests |
| `test/e2e/terminal-url-link-click.test.tsx` | Integration | 2 tests |
| `test/e2e/terminal-url-context-menu.test.tsx` | Integration | 3 tests |
| `test/e2e-browser/specs/terminal-url-click.spec.ts` | E2E smoke | 1 test |
| **Total new tests** | | **58 tests** |

## Modified Test Files Summary

| File | Changes |
|------|---------|
| `test/unit/client/components/TerminalView.linkWarning.test.tsx` | 2 tests updated (assertions change from `window.open` to Redux state check) |
| `test/unit/client/components/TerminalView.keyboard.test.tsx` | Mock updated to capture multiple link providers; variable references renamed |
