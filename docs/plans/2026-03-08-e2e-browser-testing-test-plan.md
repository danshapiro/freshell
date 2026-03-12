# E2E Browser Testing -- Test Plan

**Date:** 2026-03-08
**Implementation plan:** `docs/plans/2026-03-08-e2e-browser-testing-impl.md`
**Agreed testing strategy:** Heavy fidelity Playwright E2E (~80-100 scenarios), server isolation per spec file, test harness bridge, renderer-agnostic terminal assertions.

---

## Harness Requirements

The implementation plan defines four harnesses. All must be built before the scenario tests can run. They constitute Tasks 1-6 of the implementation plan.

### 1. TestServer (Task 2)

- **What it does:** Spawns an isolated Freshell production server as a child process with ephemeral port, unique AUTH_TOKEN, and isolated HOME directory.
- **Exposes:** `start() -> TestServerInfo { port, baseUrl, wsUrl, token, configDir, pid }`, `stop()`, `info` getter.
- **Key behavior:** Discovers free port via `net.createServer` bind-to-0 (not `PORT=0`); pre-seeds `config.json` to bypass SetupWizard; health-checks `/api/health` before resolving.
- **Estimated complexity:** Medium. ~160 lines of implementation, 6 vitest unit tests.
- **Tests depending on it:** Every scenario test (all 14 spec files).

### 2. TestHarness bridge (Task 4)

- **What it does:** Playwright-side wrapper around `window.__FRESHELL_TEST_HARNESS__`, which is installed in the client when URL contains `?e2e=1`.
- **Exposes:** `waitForHarness()`, `waitForConnection()`, `forceDisconnect()`, `getState()`, `getTerminalBuffer(terminalId?)`, `waitForTerminalText(text)`, `getTabCount()`, `getActiveTabId()`, `getPaneLayout(tabId)`, `waitForTabCount(n)`, `waitForTerminalStatus(status)`, `getConnectionStatus()`, `getSettings()`, `killAllTerminals(serverInfo)`.
- **Client-side piece:** `src/lib/test-harness.ts` with `installTestHarness()` gated by `?e2e=1` URL parameter (runtime check, not build-time).
- **Terminal buffer registration:** `TerminalView.tsx` registers buffer accessors via `useEffect` watching `terminalContent?.terminalId`. Uses xterm.js `Terminal.buffer.active` API (renderer-agnostic, works with WebGL/canvas/DOM).
- **Estimated complexity:** Medium-high. Client-side module (~50 lines), Playwright-side helper (~200 lines), App.tsx wiring, TerminalView.tsx wiring.
- **Tests depending on it:** All scenario/integration tests that assert on Redux state or terminal output.

### 3. TerminalHelper (Task 5)

- **What it does:** Playwright-side utilities for interacting with xterm.js terminals.
- **Exposes:** `getTerminalContainer(nth)`, `getTerminalInput(nth)`, `typeInTerminal(text)`, `pressKey(key)`, `executeCommand(command)`, `waitForOutput(text)`, `getVisibleText()`, `waitForPrompt()`, `waitForTerminal(nth)`.
- **Key behavior:** Types via `page.keyboard` targeting xterm's hidden textarea; reads output via test harness buffer API, not DOM scraping.
- **Estimated complexity:** Low-medium. ~100 lines.
- **Tests depending on it:** All tests that interact with terminals (terminal-lifecycle, pane-system, reconnection, stress, etc.).

### 4. Playwright Fixtures (Task 6)

- **What it does:** Extends Playwright `test` with custom fixtures: `testServer` (worker-scoped), `serverInfo`, `harness`, `terminal`, `freshellPage` (pre-navigated with harness ready).
- **Key behavior:** `freshellPage` navigates to `http://127.0.0.1:{port}/?token={token}&e2e=1`, waits for harness and WS connection, and kills all terminals on teardown.
- **Estimated complexity:** Low. ~60 lines.
- **Tests depending on it:** All spec files import `test` and `expect` from fixtures.

---

## Test Plan

Tests are numbered in priority order per the prompt template: scenarios first, then integration, invariant, boundary, and unit.

### Sources of Truth

- **ST-1:** Freshell codebase (`src/`, `server/`, `shared/`) -- the actual component implementations, Redux slices, WebSocket protocol handlers, and REST API routes.
- **ST-2:** Implementation plan (`docs/plans/2026-03-08-e2e-browser-testing-impl.md`) -- the planned test infrastructure architecture and spec file contents.
- **ST-3:** Project AGENTS.md -- architectural documentation covering WebSocket protocol, PTY lifecycle, Redux state management, configuration persistence, pane system.
- **ST-4:** Approved testing strategy (transcript) -- Heavy fidelity, Playwright, ~80-100 scenarios, server isolation, test harness.

---

### Scenario Tests

#### S-1: User opens Freshell and types a command

- **Name:** Terminal shows shell prompt and echoes command output after initial load
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`)
- **Preconditions:** Isolated test server running; page navigated with valid token and `?e2e=1`.
- **Actions:**
  1. Wait for terminal to appear in the DOM (`.xterm` visible).
  2. Wait for shell prompt character (`$`, `%`, `>`, `#`) via buffer API.
  3. Type `echo "e2e-test-output-12345"` and press Enter.
  4. Wait for `e2e-test-output-12345` to appear in terminal buffer.
- **Expected outcome:** Terminal buffer contains the echoed string within 10 seconds. (ST-1: TerminalView creates xterm instance and connects to PTY via WS; ST-3: PTY lifecycle -- stdout streams to attached clients.)
- **Interactions:** WebSocket handshake, PTY spawn via `terminal.create` WS message, terminal buffer registration in test harness.

#### S-2: User creates multiple tabs, switches between them, and verifies terminal isolation

- **Name:** Each tab has an independent terminal whose output survives tab switching
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`)
- **Preconditions:** Page loaded with one tab and terminal showing prompt.
- **Actions:**
  1. Type `echo "before-switch-marker"` and press Enter in first tab's terminal.
  2. Wait for `before-switch-marker` in buffer.
  3. Click "New shell tab" button (aria-label="New shell tab").
  4. Wait for tab count to reach 2 via `harness.waitForTabCount(2)`.
  5. Click first tab (via `page.getByRole('tab').first()`).
  6. Wait for `before-switch-marker` to appear in terminal buffer.
- **Expected outcome:** After switching back, the first tab's terminal buffer still contains the marker text. Tab count is 2. (ST-1: tabsSlice manages tab list; panesSlice preserves layouts per tab; PTY continues running in background via detach/attach; ST-3: scrollback buffer preserved.)
- **Interactions:** Tab creation (Redux dispatch), terminal detach/attach (WS protocol), scrollback buffer (64KB server-side).

#### S-3: User splits a terminal pane horizontally, types in both, and closes one

- **Name:** Horizontal pane split creates independent terminals and closing returns to single pane
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`)
- **Preconditions:** Page loaded with single terminal pane.
- **Actions:**
  1. Wait for terminal and shell prompt.
  2. Type `echo "pane-1-marker"` and press Enter.
  3. Right-click terminal, click "Split horizontally" (role="menuitem", name=/split horizontally/i).
  4. Wait for second `.xterm` element to become visible.
  5. Verify via `harness.getPaneLayout()` that layout type is `split` with direction `horizontal` and 2 children.
  6. Click `button[title="Close pane"]` on one pane.
  7. Verify layout returns to type `leaf`.
- **Expected outcome:** Layout transitions from `leaf` -> `split` (horizontal, 2 children) -> `leaf`. Each pane gets its own `createRequestId` and hence its own backend terminal. (ST-1: context menu in `menu-defs.ts` line 305 creates "Split horizontally" menu item that dispatches `splitPane`; panesSlice splits the pane tree; ST-3: each pane owns its terminal lifecycle via `createRequestId`.)
- **Interactions:** Context menu rendering, pane tree manipulation (Redux), two concurrent PTY processes, pane close kills one PTY.

#### S-4: User authenticates via the auth modal when no token is in the URL

- **Name:** Auth modal appears without token and authenticates successfully with correct token
- **Type:** scenario
- **Harness:** Playwright fixtures (`serverInfo`, `harness`)
- **Preconditions:** Test server running.
- **Actions:**
  1. Navigate to `serverInfo.baseUrl` (no token, no `?e2e=1`).
  2. Wait for auth dialog (role="dialog") to be visible.
  3. Find token input by placeholder text matching `/token/i` (actual placeholder: "Paste token (or a token URL) here").
  4. Fill the input with `serverInfo.token`.
  5. Click the submit button (role="button", name=/connect|submit|go/i).
  6. Navigate again with `?e2e=1` appended and wait for harness/connection.
  7. Verify `harness.getConnectionStatus()` returns `'connected'`.
- **Expected outcome:** Auth modal is shown when no token is present; submitting the correct token establishes a WebSocket connection. (ST-1: AuthRequiredModal.tsx line 174 placeholder; auth.ts `initializeAuthToken()` stores token; ws-client sends `hello` with token; ST-3: WebSocket handshake flow.)
- **Interactions:** Auth token validation (server-side), WebSocket handshake, Redux connection state update.

#### S-5: User changes settings and they persist across page reload

- **Name:** Settings changes (font size, cursor blink) survive page reload
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `harness`, `serverInfo`)
- **Preconditions:** Page loaded, connected.
- **Actions:**
  1. Open settings via sidebar button (role="button", name matching /settings/i based on title="Settings (Ctrl+B ,)").
  2. Find "Cursor blink" row, locate toggle (role="switch") within it.
  3. Record current value via `harness.getSettings()`.
  4. Click toggle.
  5. Verify setting changed via `harness.getSettings()`.
  6. Reload page (`page.goto` with token and `?e2e=1`).
  7. Wait for harness and connection.
  8. Verify setting persisted via `harness.getSettings()`.
- **Expected outcome:** `settings.terminal.cursorBlink` is toggled and retains its new value after reload. (ST-1: SettingsView.tsx line 934 renders "Cursor blink" row with toggle; settingsSlice dispatches update; server POST /api/settings persists to `config.json`; ST-3: configuration persistence via atomic writes.)
- **Interactions:** Settings POST API, config file write, settings broadcast via WS, localStorage.

#### S-6: User opens an editor pane, enters markdown content, toggles preview, and switches tabs

- **Name:** Editor pane renders markdown preview toggle and preserves content across tab switches
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`)
- **Preconditions:** Page loaded with terminal pane.
- **Actions:**
  1. Split terminal via context menu, select "Editor" from PanePicker (role="button", name=/^Editor$/i).
  2. Wait for editor pane (data-testid="editor-pane").
  3. Set editor content to markdown via `harness.dispatch` (updatePaneContent with `kind: 'editor'`, `filePath: 'test.md'`, `language: 'markdown'`, `content: '# Hello\n\nWorld'`).
  4. Click "Preview" button (role="button", name="Preview" from EditorToolbar.tsx line 202).
  5. Verify "Source" button appears (aria-label change from "Preview" to "Source").
  6. Toggle back to source.
  7. Create new tab, switch back to original tab.
  8. Verify Monaco editor still shows content (marker text visible).
- **Expected outcome:** Preview toggle switches view mode. Editor content persists across tab switches. (ST-1: EditorToolbar.tsx line 202 title toggles "Preview"/"Source"; panesSlice persists pane content per tab; ST-3: pane system -- tabs contain pane layouts.)
- **Interactions:** PanePicker selection, Redux pane content dispatch, Monaco editor rendering, tab switching with layout preservation.

#### S-7: User opens browser pane, navigates to URL, and verifies iframe loading

- **Name:** Browser pane loads URL in iframe and shows navigation controls
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`, `serverInfo`)
- **Preconditions:** Page loaded with terminal.
- **Actions:**
  1. Split terminal, select "Browser" from PanePicker (name=/^Browser$/i).
  2. Wait for URL input (placeholder="Enter URL...").
  3. Verify navigation buttons exist: `button[title="Back"]`, `button[title="Forward"]`, `button[title="Developer Tools"]`.
  4. Fill URL input with `${serverInfo.baseUrl}/api/health` and press Enter.
  5. Wait for iframe (title="Browser content") to have `src` containing `/api/health`.
- **Expected outcome:** Browser pane renders with URL input and navigation controls. Iframe loads the specified URL. (ST-1: BrowserPane.tsx lines 416-454 render Back/Forward/Refresh/DevTools buttons with exact titles; line 509 iframe has title="Browser content".)
- **Interactions:** BrowserPane component, iframe loading, pane content state.

#### S-8: User WebSocket disconnects and reconnects, terminal output resumes

- **Name:** Terminal remains functional after forced WebSocket disconnect and auto-reconnect
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`)
- **Preconditions:** Page loaded, terminal showing prompt, WS connected.
- **Actions:**
  1. Type `echo "before-reconnect"` and press Enter; wait for output.
  2. Call `harness.forceDisconnect()` (closes raw WS without setting `intentionalClose`).
  3. Wait for reconnection via `harness.waitForConnection()`.
  4. Wait for `before-reconnect` to appear in terminal buffer (scrollback reattach).
  5. Type `echo "after-reconnect"` and press Enter; wait for output.
- **Expected outcome:** Auto-reconnect completes. Previous terminal output is restored from server-side scrollback buffer. New commands work. (ST-1: ws-client.ts auto-reconnect logic; test-harness.ts `forceDisconnect` closes WS without `intentionalClose` flag; ST-3: PTY continues running on detach; 64KB scrollback buffer replayed on attach.)
- **Interactions:** WS close/reconnect, `hello` handshake, `terminal.attach` on reconnect, scrollback buffer replay.

#### S-9: User uses sidebar to navigate between views and collapse/expand

- **Name:** Sidebar navigation switches views and collapse/expand toggle works
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`)
- **Preconditions:** Page loaded, sidebar visible.
- **Actions:**
  1. Verify "Hide sidebar" button visible (aria-label="Hide sidebar").
  2. Click it, wait for "Show sidebar" button (aria-label="Show sidebar").
  3. Click "Show sidebar" to re-expand, verify "Hide sidebar" reappears.
  4. Click Settings nav button (title="Settings (Ctrl+B ,)").
  5. Wait for settings sections ("Terminal", "Appearance", "Debugging" text visible).
  6. Click Tabs nav button (title="Tabs (Ctrl+B A)") to return.
  7. Wait for terminal (`.xterm`) to be visible again.
- **Expected outcome:** Sidebar toggles between hidden and visible. Navigation buttons switch between Settings and terminal views. (ST-1: Sidebar.tsx line 568-569 aria-label="Hide sidebar"; TabBar.tsx lines 299-300 aria-label="Show sidebar"; nav items at lines 486-490.)
- **Interactions:** Sidebar state, CSS transitions, view routing.

#### S-10: User on mobile viewport sees mobile tab strip and creates/navigates tabs

- **Name:** Mobile viewport shows mobile-specific controls for tab management
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `harness`, `terminal`)
- **Preconditions:** Viewport set to 390x844 (iPhone 14).
- **Actions:**
  1. Verify "Show sidebar" button (aria-label="Show sidebar" from MobileTabStrip.tsx line 45).
  2. Verify "Open tab switcher" button (aria-label="Open tab switcher" from line 62).
  3. Verify "New tab" button (aria-label="New tab" when on last tab, from line 75).
  4. Click "New tab", wait for tab count 2.
  5. Verify "Previous tab" button (aria-label="Previous tab" from line 54) appears.
  6. Type `echo "mobile-test"` and press Enter; wait for output.
- **Expected outcome:** Mobile-specific UI controls render correctly. Tab creation and terminal interaction work on mobile viewport. (ST-1: MobileTabStrip.tsx lines 44-75 define exact aria-labels.)
- **Interactions:** Responsive layout, mobile detection hook (`useMobile`), touch-friendly controls.

#### S-11: User creates nested pane layout with zoom/restore

- **Name:** Nested pane splits work and zoom/restore hides/shows panes
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`)
- **Preconditions:** Page loaded with single terminal.
- **Actions:**
  1. Split horizontally (context menu on terminal).
  2. Wait for 2 `.xterm` elements.
  3. Split second pane vertically.
  4. Wait for 3rd `.xterm` element (or pane picker).
  5. Verify layout tree has nested split via `harness.getPaneLayout()`.
  6. Click "Maximize pane" button (aria-label="Maximize pane" from PaneHeader.tsx line 129-130).
  7. Verify only 1 visible `.xterm`.
  8. Verify Redux state has `zoomedPane` set.
  9. Click "Restore pane" (aria-label="Restore pane").
  10. Verify 2+ visible `.xterm` elements.
- **Expected outcome:** Nested splits create a tree structure. Zoom hides sibling panes; restore shows them. (ST-1: PaneHeader.tsx lines 129-130 aria-label toggles "Maximize pane"/"Restore pane"; panesSlice manages zoomedPane state.)
- **Interactions:** Pane tree nesting, zoom state management, visibility toggling.

#### S-12: Two browser tabs share the same test server and settings broadcast works

- **Name:** Multi-client: settings change in one tab propagates to another tab via WebSocket broadcast
- **Type:** scenario
- **Harness:** Playwright fixtures (`serverInfo`, browser context)
- **Preconditions:** Two browser pages opened to the same test server with valid token and `?e2e=1`.
- **Actions:**
  1. Open two pages to same server.
  2. Wait for both harnesses and connections.
  3. Record font size from page2 via `harness.getState()`.
  4. Change font size from page1 via `fetch POST /api/settings`.
  5. Wait for page2's font size to differ from initial value (WS broadcast).
- **Expected outcome:** Settings change on one client propagates to the other client via WebSocket `settings.updated` broadcast. (ST-1: settings-router.ts broadcasts settings updates via WS; ws-handler dispatches to all connected clients; ST-3: configuration persistence broadcast.)
- **Interactions:** Two concurrent WS connections, settings API, WS broadcast mechanism.

#### S-13: User resizes viewport and terminal adapts

- **Name:** Terminal resize updates dimensions without losing functionality
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`)
- **Preconditions:** Page loaded with terminal showing prompt.
- **Actions:**
  1. Set viewport to 1600x1200.
  2. Wait for terminal prompt.
  3. Type `echo "after-resize"` and press Enter; wait for output.
- **Expected outcome:** Terminal adapts to new viewport size. Commands continue to work after resize. (ST-1: TerminalView uses FitAddon to resize terminal; `terminal.resize` WS message sent to server; PTY dimensions updated.)
- **Interactions:** FitAddon, terminal resize WS message, PTY winsize update.

#### S-14: User renames a tab via double-click

- **Name:** Tab rename via double-click shows input, accepts new name, and displays it
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `harness`)
- **Preconditions:** Page loaded with at least one tab.
- **Actions:**
  1. Double-click the first tab (role="tab").
  2. Wait for text input to appear.
  3. Fill with "My Custom Tab" and press Enter.
  4. Verify "My Custom Tab" text is visible on the page.
- **Expected outcome:** Tab shows the renamed title. (ST-1: TabItem.tsx handles double-click to enter rename mode; tabsSlice `updateTab` action persists the name.)
- **Interactions:** Tab inline editing, Redux tab update, localStorage persistence.

#### S-15: User generates large terminal output without crash

- **Name:** Terminal handles 1000 lines of output without crashing and remains responsive
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`)
- **Preconditions:** Page loaded with terminal showing prompt.
- **Actions:**
  1. Execute `seq 1 1000`.
  2. Wait for "1000" to appear in buffer (30s timeout).
  3. Execute `echo "still-alive"`.
  4. Wait for "still-alive" in buffer.
- **Expected outcome:** Large output completes. Terminal remains responsive afterward. (ST-1: xterm.js scrollback buffer handles large output; server-side 64KB buffer truncates older data; ST-3: PTY stdout streams to attached clients.)
- **Interactions:** PTY stdout streaming, WS binary frames, xterm.js buffer management.

#### S-16: Detached terminal keeps running and output is available on return

- **Name:** Terminal process continues running when user switches away and buffered output is visible on return
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`)
- **Preconditions:** Page loaded with terminal showing prompt.
- **Actions:**
  1. Execute `echo "detach-test" && sleep 0.1 && echo "still-running"`.
  2. Create new tab ("New shell tab").
  3. Wait 500ms.
  4. Switch back to first tab.
  5. Wait for "still-running" to appear in terminal buffer.
- **Expected outcome:** Background process output is buffered server-side and replayed on reattach. (ST-3: PTY lifecycle -- on detach, process continues running; server maintains 64KB scrollback buffer.)
- **Interactions:** Terminal detach/attach, server-side scrollback, WS `terminal.attach` message.

#### S-17: User drag-and-drops to reorder tabs

- **Name:** Drag and drop changes tab order
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `harness`)
- **Preconditions:** Page loaded with 3 tabs.
- **Actions:**
  1. Create 2 additional tabs.
  2. Record initial tab order via `harness.getState().tabs.tabs.map(t => t.id)`.
  3. Drag first tab to last position via mouse events.
  4. Verify tab order changed via `harness.getState()`.
- **Expected outcome:** Tab order in Redux state differs from initial order. (ST-1: TabBar uses @dnd-kit SortableContext for drag-and-drop; tabsSlice `reorderTab` action.)
- **Interactions:** @dnd-kit drag events, Redux tab reordering, TabBar re-render.

#### S-18: Pane picker shows Shell, Editor, Browser options

- **Name:** Splitting a pane shows picker with Shell, Editor, and Browser options
- **Type:** scenario
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`)
- **Preconditions:** Page loaded with terminal.
- **Actions:**
  1. Right-click terminal, click "Split horizontally".
  2. Wait for PanePicker toolbar (role="toolbar", name=/pane type picker/i -- if implemented) or wait for Shell/Editor/Browser buttons.
  3. Verify "Shell" (role="button", name=/^Shell$/i), "Editor" (name=/^Editor$/i), "Browser" (name=/^Browser$/i) buttons are all visible.
- **Expected outcome:** All three base pane types are offered. (ST-1: PanePicker.tsx lines 25, 33-36 define shellOption, editorOption, browserOption with exact labels.)
- **Interactions:** Context menu, PanePicker rendering.

---

### Integration Tests

#### I-1: Test server isolation -- no interference with production ports

- **Name:** Test server binds to ephemeral port and does not touch ports 3001/3002
- **Type:** integration
- **Harness:** TestServer (vitest unit test)
- **Preconditions:** None.
- **Actions:**
  1. Create `new TestServer()` and call `start()`.
  2. Read `info.port`.
- **Expected outcome:** Port is >0, not 3001, not 3002. `baseUrl` matches `http://127.0.0.1:{port}`. (ST-2: TestServer implementation; port discovery via `net.createServer` bind-to-0.)
- **Interactions:** `net.createServer` port binding, child process spawn.

#### I-2: Test server auth enforcement

- **Name:** Test server rejects unauthenticated API requests and allows health check
- **Type:** integration
- **Harness:** TestServer (vitest unit test)
- **Preconditions:** TestServer started.
- **Actions:**
  1. `fetch(baseUrl + '/api/settings')` without auth header.
  2. `fetch(baseUrl + '/api/settings', { headers: { 'x-auth-token': info.token } })`.
  3. `fetch(baseUrl + '/api/health')`.
- **Expected outcome:** Step 1 returns 401. Step 2 returns 200. Step 3 returns 200 with `{ ok: true }`. (ST-1: server/index.ts auth middleware; /api/health bypasses auth; ST-2: TestServer generates unique AUTH_TOKEN.)
- **Interactions:** Express auth middleware, environment variable injection.

#### I-3: Test harness activation via URL parameter

- **Name:** Test harness is installed when URL has `?e2e=1` and absent without it
- **Type:** integration
- **Harness:** Playwright fixtures
- **Preconditions:** Test server running.
- **Actions:**
  1. Navigate to `baseUrl/?token={token}` (no `&e2e=1`).
  2. Evaluate `window.__FRESHELL_TEST_HARNESS__` -- should be undefined.
  3. Navigate to `baseUrl/?token={token}&e2e=1`.
  4. Wait for `window.__FRESHELL_TEST_HARNESS__` to be defined.
- **Expected outcome:** Harness is only installed with `?e2e=1`. (ST-2: Task 4 -- URL parameter gating, not build-time env check.)
- **Interactions:** Client-side URL parsing, conditional harness installation.

#### I-4: Terminal buffer registration timing

- **Name:** Terminal buffer is registered after terminalId is assigned, not at xterm creation time
- **Type:** integration
- **Harness:** Playwright fixtures (`freshellPage`, `harness`)
- **Preconditions:** Page loaded with `?e2e=1`.
- **Actions:**
  1. Wait for terminal to appear.
  2. Wait for terminal to have a `terminalId` in Redux state.
  3. Call `harness.getTerminalBuffer()`.
- **Expected outcome:** Buffer returns non-null string content after terminalId is assigned. (ST-2: Task 4 Step 3 -- useEffect watches `terminalContent?.terminalId`, registers after WS `terminal.created` response.)
- **Interactions:** xterm.js Terminal creation, WS `terminal.created` message, useEffect timing, harness buffer registry.

#### I-5: Config pre-seeding prevents SetupWizard

- **Name:** Test server pre-seeds config.json so SetupWizard does not block the UI
- **Type:** integration
- **Harness:** Playwright fixtures (`freshellPage`)
- **Preconditions:** Test server started with isolated HOME.
- **Actions:**
  1. Navigate to Freshell with token and `?e2e=1`.
  2. Verify that no dialog (role="dialog") for SetupWizard is visible within 5 seconds.
  3. Verify terminal or harness loads normally.
- **Expected outcome:** SetupWizard is bypassed because config.json has `network.configured: true`. (ST-1: SetupWizard.tsx only renders when config is not configured; ST-2: TestServer pre-seeds config.json.)
- **Interactions:** Config file reading, SetupWizard conditional rendering.

#### I-6: Terminal cleanup between tests

- **Name:** `killAllTerminals` in fixture teardown prevents PTY accumulation
- **Type:** integration
- **Harness:** Playwright fixtures (`freshellPage`, `harness`, `serverInfo`)
- **Preconditions:** Multiple terminals created during a test.
- **Actions:**
  1. In a test, create 3 tabs (3 terminals).
  2. After test completes, fixture teardown calls `harness.killAllTerminals(serverInfo)`.
  3. In next test, verify server has no terminals via `GET /api/terminals`.
- **Expected outcome:** All terminals from previous test are killed. New test starts clean. (ST-2: Task 6 -- freshellPage fixture teardown; TestHarness.killAllTerminals sends WS `terminal.kill` for each non-exited terminal.)
- **Interactions:** REST API `/api/terminals`, WS `terminal.kill` message, PTY process cleanup.

#### I-7: Pane resize via drag divider

- **Name:** Dragging pane resize divider preserves both panes
- **Type:** integration
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`, `harness`)
- **Preconditions:** Page loaded, terminal split into 2 panes.
- **Actions:**
  1. Split terminal horizontally.
  2. Locate resize handle (`[data-panel-resize-handle-id]`).
  3. Drag handle 50px to the right via mouse events.
  4. Verify both panes still exist in layout.
- **Expected outcome:** Layout remains `split` with 2 children after resize. (ST-1: PaneDivider component uses react-resizable-panels with `data-panel-resize-handle-id` attributes.)
- **Interactions:** react-resizable-panels drag events, pane size state.

#### I-8: Settings broadcast to multiple clients

- **Name:** POST to /api/settings broadcasts changes to all connected WebSocket clients
- **Type:** integration
- **Harness:** Playwright fixtures, two browser pages
- **Preconditions:** Two pages connected to same test server.
- **Actions:**
  1. Record page2 settings.
  2. Change settings via page1 POST to `/api/settings`.
  3. Wait for page2 settings to update.
- **Expected outcome:** Page2 receives the updated settings via WS broadcast. (ST-1: settings-router broadcasts via WS; ST-3: settings changes POST to /api/settings and broadcast.)
- **Interactions:** REST API, WS broadcast, Redux settings update.

---

### Invariant Tests

These are checked as postconditions after scenario tests.

#### V-1: Auth token is never exposed in URL bar

- **Name:** Token is stripped from the visible URL after initial authentication
- **Type:** invariant
- **Harness:** Playwright fixtures (`freshellPage`)
- **Preconditions:** Page loaded with token in URL.
- **Actions:**
  1. After `freshellPage` loads, read `page.url()`.
- **Expected outcome:** URL does not contain `token=`. (ST-1: auth.ts `initializeAuthToken()` uses `history.replaceState` to remove token from URL while preserving other params like `?e2e=1`.)
- **Interactions:** Browser history API, URL parameter stripping.

#### V-2: Every tab always has a valid pane layout

- **Name:** All tabs have a non-null pane layout in Redux at all times
- **Type:** invariant
- **Harness:** Playwright fixtures (`harness`)
- **Preconditions:** Multiple tabs exist (checked after scenario tests that create tabs).
- **Actions:**
  1. Get full Redux state via `harness.getState()`.
  2. For each tab in `state.tabs.tabs`, verify `state.panes.layouts[tab.id]` is truthy.
- **Expected outcome:** No tab has a null or undefined layout. (ST-1: panesSlice initializes layout for every new tab; ST-3: pane system -- tabs contain pane layouts.)
- **Interactions:** Redux state consistency between tabs and panes slices.

#### V-3: Test harness is not installed in production URLs

- **Name:** `window.__FRESHELL_TEST_HARNESS__` is undefined when URL lacks `?e2e=1`
- **Type:** invariant
- **Harness:** Playwright fixtures
- **Preconditions:** Test server running.
- **Actions:**
  1. Navigate without `?e2e=1`.
  2. Evaluate `window.__FRESHELL_TEST_HARNESS__`.
- **Expected outcome:** Returns `undefined`. (ST-2: harness gated by URL parameter.)
- **Interactions:** None beyond client-side initialization.

#### V-4: Connection status matches WebSocket state

- **Name:** Redux connection status accurately reflects the WebSocket ready state
- **Type:** invariant
- **Harness:** Playwright fixtures (`freshellPage`, `harness`)
- **Preconditions:** Page connected.
- **Actions:**
  1. Get `harness.getConnectionStatus()`.
  2. Get `harness.getWsReadyState()` via page.evaluate.
- **Expected outcome:** Connection status is `'connected'` and WS state is `'ready'` when the app is functioning normally. (ST-1: connectionSlice tracks status; ws-client.ts tracks `_state`.)
- **Interactions:** Redux state, WS client internal state.

---

### Boundary and Edge-Case Tests

#### B-1: Auth with wrong token shows error

- **Name:** Auth modal remains visible when an incorrect token is submitted
- **Type:** boundary
- **Harness:** Playwright fixtures (`serverInfo`)
- **Preconditions:** Test server running.
- **Actions:**
  1. Navigate to `baseUrl/?token=wrong-token-value`.
  2. Wait for auth dialog to be visible.
- **Expected outcome:** Auth modal appears because the token is invalid. (ST-1: WS handshake rejects invalid tokens; auth flow shows modal on rejection.)
- **Interactions:** WS handshake validation.

#### B-2: Cannot close the last tab

- **Name:** Closing the only remaining tab either is prevented or creates a replacement
- **Type:** boundary
- **Harness:** Playwright fixtures (`freshellPage`, `harness`)
- **Preconditions:** Page loaded with exactly 1 tab.
- **Actions:**
  1. Verify tab count is 1.
  2. Attempt to close the tab (if close button exists on single tab).
  3. Verify at least 1 tab still exists.
- **Expected outcome:** The app always has at least one tab. (ST-1: tabsSlice prevents closing the last tab or creates a replacement.)
- **Interactions:** Tab close logic in Redux.

#### B-3: Multiple rapid WebSocket disconnects

- **Name:** App handles 3 rapid forced disconnects without crashing
- **Type:** boundary
- **Harness:** Playwright fixtures (`freshellPage`, `harness`)
- **Preconditions:** Page connected.
- **Actions:**
  1. Force disconnect 3 times with 500ms intervals.
  2. Wait for stable reconnection.
  3. Verify connection status is `'connected'`.
  4. Verify terminal (`.xterm`) is still visible.
- **Expected outcome:** App survives rapid disconnects and re-establishes connection. (ST-1: ws-client.ts reconnect logic with exponential backoff.)
- **Interactions:** WS reconnect debouncing, state management during reconnect.

#### B-4: Terminal handles Ctrl+L (clear screen)

- **Name:** Ctrl+L clears the terminal screen and shows fresh prompt
- **Type:** boundary
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`)
- **Preconditions:** Terminal with some output.
- **Actions:**
  1. Execute `echo "before-clear"` and wait for output.
  2. Click terminal, press Ctrl+L.
  3. Wait for fresh prompt.
- **Expected outcome:** Screen is cleared; new prompt appears. (ST-1: Ctrl+L is handled by the shell process, not the app.)
- **Interactions:** PTY input, shell built-in clear.

#### B-5: Rapid tab switching (20 switches across 5 tabs)

- **Name:** App does not crash under rapid tab switching
- **Type:** boundary
- **Harness:** Playwright fixtures (`freshellPage`, `harness`)
- **Preconditions:** 5 tabs created.
- **Actions:**
  1. Create 4 additional tabs.
  2. Switch between tabs 20 times (cycling through all 5) with 50ms delays.
  3. Verify tab count is still 5.
- **Expected outcome:** App remains stable. All 5 tabs still exist. (ST-1: React rendering, Redux state updates, terminal attach/detach cycles.)
- **Interactions:** Heavy React re-rendering, concurrent WS attach/detach messages.

#### B-6: 10+ tabs trigger overflow handling

- **Name:** Creating 10+ tabs triggers tab bar overflow without losing tabs
- **Type:** boundary
- **Harness:** Playwright fixtures (`freshellPage`, `harness`)
- **Preconditions:** Page loaded.
- **Actions:**
  1. Create 10 additional tabs (11 total).
  2. Verify tab count is 11 via harness.
  3. Verify all tabs are present via `page.getByRole('tab')` count.
- **Expected outcome:** All tabs are navigable. Tab bar handles overflow (scrolling or wrapping). (ST-1: TabBar handles overflow.)
- **Interactions:** Tab bar overflow layout, scroll controls.

#### B-7: Mobile orientation change preserves terminal

- **Name:** Switching between portrait and landscape on mobile keeps terminal visible
- **Type:** boundary
- **Harness:** Playwright fixtures (`freshellPage`, `terminal`)
- **Preconditions:** Viewport set to mobile portrait (390x844).
- **Actions:**
  1. Switch to landscape (844x390).
  2. Verify terminal visible.
  3. Switch back to portrait (390x844).
  4. Verify terminal visible.
- **Expected outcome:** Terminal remains visible in both orientations. (ST-1: responsive layout adapts to viewport changes.)
- **Interactions:** Viewport resize, FitAddon resize, responsive CSS.

#### B-8: Server handles 5 concurrent browser connections

- **Name:** Test server supports 5 simultaneous WebSocket connections
- **Type:** boundary
- **Harness:** Playwright fixtures (`serverInfo`), browser context
- **Preconditions:** Test server running.
- **Actions:**
  1. Open 5 pages to the same server.
  2. Wait for all 5 to reach WS `ready` state.
- **Expected outcome:** All 5 clients connect successfully. (ST-1: WS handler supports multiple concurrent connections; ST-3: broadcast to all connected clients.)
- **Interactions:** WS connection pool, server resource management.

#### B-9: Client disconnect does not affect other clients

- **Name:** Closing one browser tab does not disrupt another connected tab
- **Type:** boundary
- **Harness:** Playwright fixtures (`serverInfo`), browser context
- **Preconditions:** Two pages connected.
- **Actions:**
  1. Close page1.
  2. Verify page2 still has `ready` WS state.
- **Expected outcome:** Remaining client is unaffected. (ST-1: WS handler removes disconnected client from broadcast list without affecting others.)
- **Interactions:** WS connection cleanup, broadcast list management.

---

### Regression Tests

#### R-1: Existing vitest tests are unaffected by E2E infrastructure

- **Name:** `npm test` passes with the E2E browser directory excluded from vitest
- **Type:** regression
- **Harness:** Vitest (command line)
- **Preconditions:** `test/e2e-browser/**` added to vitest.config.ts exclude list.
- **Actions:**
  1. Run `npm test`.
- **Expected outcome:** All existing tests pass. No regressions from the E2E infrastructure addition. (ST-2: Task 1 Step 6 adds exclusion.)
- **Interactions:** Vitest config, test file collection.

#### R-2: Production build succeeds with test harness code bundled

- **Name:** `npm run build` completes successfully with the ~50-line test harness module included
- **Type:** regression
- **Harness:** Build command
- **Preconditions:** `src/lib/test-harness.ts` and App.tsx modifications in place.
- **Actions:**
  1. Run `npm run build`.
- **Expected outcome:** Build succeeds. Harness code is bundled (negligible size impact). (ST-2: harness code is always bundled but only activates with `?e2e=1`.)
- **Interactions:** Vite build, TypeScript compilation.

---

### Unit Tests

#### U-1: TestServer findFreePort returns valid port

- **Name:** `findFreePort()` returns a port number > 0 and not in use
- **Type:** unit
- **Harness:** Vitest (test/e2e-browser/vitest.config.ts)
- **Preconditions:** None.
- **Actions:** Call `findFreePort()` (exposed via TestServer or extracted for testing).
- **Expected outcome:** Returns a number > 0, different from 3001 and 3002. (ST-2: TestServer implementation.)
- **Interactions:** None.

#### U-2: TestServer uses isolated HOME directory

- **Name:** TestServer creates a temp directory with `freshell-e2e-` prefix
- **Type:** unit
- **Harness:** Vitest
- **Preconditions:** None.
- **Actions:**
  1. Start TestServer.
  2. Read `info.configDir`.
- **Expected outcome:** `configDir` contains `freshell-e2e-` and does not contain `.freshell` (not the real home). (ST-2: TestServer creates `mkdtemp('freshell-e2e-')` for HOME.)
- **Interactions:** None.

#### U-3: TestServer stop is idempotent

- **Name:** Calling `stop()` twice does not throw
- **Type:** unit
- **Harness:** Vitest
- **Preconditions:** TestServer started and then stopped.
- **Actions:**
  1. Start, stop, stop again.
- **Expected outcome:** No error on second stop. (ST-2: TestServer.stop() checks `if (!this.process) return`.)
- **Interactions:** None.

---

## Coverage Summary

### Areas Covered

| Area | Scenarios | Integration | Boundary | Other | Total |
|------|-----------|-------------|----------|-------|-------|
| Authentication | S-4 | I-2, I-3 | B-1 | V-1, V-3 | 6 |
| Terminal lifecycle | S-1, S-15, S-16 | I-4 | B-4 | | 5 |
| Tab management | S-2, S-14, S-17 | | B-2, B-5, B-6 | V-2 | 7 |
| Pane system | S-3, S-11, S-18 | I-7 | | | 4 |
| Editor pane | S-6 | | | | 1 |
| Browser pane | S-7 | | | | 1 |
| Settings | S-5 | I-8 | | | 2 |
| Sidebar | S-9 | I-5 | | | 2 |
| WebSocket reconnection | S-8 | I-6 | B-3 | V-4 | 4 |
| Mobile viewport | S-10 | | B-7 | | 2 |
| Multi-client | S-12 | I-8 | B-8, B-9 | | 4 |
| Stress/performance | S-13, S-15 | | B-5 | | 3 |
| Test infrastructure | | I-1, I-2, I-3, I-4, I-5, I-6 | | R-1, R-2, U-1, U-2, U-3 | 11 |
| **Total** | **18** | **8** | **9** | **10** | **45** |

### Screenshot Baseline Tests (Deferred to Implementation)

The implementation plan includes 6 screenshot baseline scenarios (default layout, settings view, multiple tabs, auth modal, sidebar collapsed, mobile layout). These are implemented as part of Task 20 in the implementation plan and use Playwright's `toHaveScreenshot()` API with a 5% pixel diff tolerance. They are not enumerated in detail here because their expected outcomes are defined by the baseline images themselves (generated on first run), not by a source of truth document.

### Areas Explicitly Excluded

1. **Agent chat with live SDK sessions** -- The isolated test environment has no Claude/Codex/Gemini CLI installed. Tests verify the PanePicker shows base options (Shell/Editor/Browser) and conditionally shows agent chat options if a CLI is detected. Tests that require an actual SDK session (permission banners, chat I/O) are explicitly marked `test.skip`. Risk: Agent chat regressions would not be caught by E2E tests; mitigated by existing unit tests.

2. **File system operations in editor pane** -- The editor pane tests use harness dispatch to set content rather than reading actual files from the isolated HOME directory. Risk: File reading/writing via the `/api/files` endpoint is not E2E-tested from the browser perspective; mitigated by existing server integration tests.

3. **Cross-browser testing** -- Tests run on Chromium locally; Firefox and WebKit are CI-only. Risk: Browser-specific rendering differences could go undetected locally; mitigated by CI cross-browser matrix.

4. **AI-powered features** -- Session summaries, AI-generated descriptions require Gemini API access. Not tested in isolated environment. Risk: AI integration regressions; mitigated by API mocking in existing unit tests.
