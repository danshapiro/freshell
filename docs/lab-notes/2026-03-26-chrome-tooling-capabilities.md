# Chrome Tooling Capabilities for Data Model Investigation

**Date:** 2026-03-26
**Context:** Testing what Chrome automation tools can actually observe to inform spike planning.

## What Works

### Redux Store Access (via React Fiber Tree)
- **In dev mode**, React exposes `__reactContainer` on the root element
- Can traverse fiber tree to find the Redux store on `memoizedProps.store`
- Full `getState()` access — all 17 slices readable at any time
- Can install `store.subscribe()` listeners to track state changes
- Can install `store.dispatch` interceptor to log all actions with timestamps
- Store reference survives as long as page doesn't reload (no HMR full refresh)
- **Confirmed:** Captured all 17 slice keys: tabs, connection, sessions, settings, codingCli, panes, sessionActivity, terminalActivity, terminalDirectory, turnCompletion, terminalMeta, codexActivity, agentChat, paneRuntimeActivity, network, tabRegistry, extensions

### Console Messages
- `read_console_messages` captures console.log/error/warn/debug
- Pattern filtering works
- Can clear and re-read for incremental capture
- **Limitation:** Freshell's client-logger wraps everything as "Object" in production build — need dev mode for readable messages

### Network Requests (HTTP only)
- `read_network_requests` captures all HTTP traffic including API calls
- URL pattern filtering works
- Can see bootstrap, session-directory, terminals, extensions API calls
- **Limitation:** Does NOT capture WebSocket frames — only the HTTP upgrade request
- **Workaround:** Use Redux dispatch interceptor to infer WS message flow (WS messages dispatch Redux actions)

### Screenshots
- Captures current visual state reliably
- Useful for verifying UI indicators (offline banner, "Recovering terminal output..." label, spinner states)

### JavaScript Execution
- Full page context access
- Can monkey-patch WebSocket constructor, store.dispatch, etc.
- Can install persistent listeners (survive until page reload)
- Can read/write localStorage

## What Doesn't Work

### WebSocket Frame Capture
- `read_network_requests` doesn't show WS frames
- Monkey-patching `WebSocket` constructor only catches NEW connections (not existing ones)
- Would need to patch before page load to catch the initial connection — not possible with injected JS
- **Workaround:** Redux dispatch log captures the effects of WS messages (actions dispatched in response to WS events)

### Production Build Introspection
- No `__reactFiber` on root element in production build
- No Redux DevTools extension available
- Console messages are opaque (minified object logs)
- **Must use dev mode for investigation**

### Surviving Page Reload
- All injected JS (store ref, dispatch interceptor, WS patches) is lost on page reload
- HMR partial updates in dev mode DO survive
- Full Vite dev server restart triggers page reload — wipes everything
- **Implication:** Can't instrument reconnect-after-server-restart scenarios without adding code to the source

## Key Findings From Testing

### Finding 1: Every Redux action fires twice
When dispatch interceptor is installed, every action appears in the log twice within <5ms. This is the cross-tab sync mechanism re-dispatching received actions. This means the persistence middleware is doing double work on every state change.

### Finding 2: Server restart reconnect is broken (or very slow) in dev mode
- Killed dev server, restarted it. Client showed "Offline" for 35+ seconds
- At +35s, a burst of activity: settings received, terminal re-created (new terminalId), pane content updated
- But `connection/setStatus` never went back to `ready` — only `connection/setError` dispatched
- The "Offline: input will queue until reconnected" banner persisted indefinitely
- Client was stuck in a loop of thunk dispatches every ~5s without recovering
- **This may be dev-mode-specific** (Vite proxy state changing) but worth investigating in production too

### Finding 3: INVALID_TERMINAL_ID cascade confirmed
- Console captured: `[TerminalView] [TRACE resumeSessionId] INVALID_TERMINAL_ID reconnecting`
- After server restart, the pane content got a completely new `terminalId` (old: `bEGLueZVTpuqWPap5_xvJ`, new: `ESzM8YiOYes4_plRTEpuV`)
- The terminal was re-created, but the connection never fully recovered
- This is the exact cascade the plan predicted

### Finding 4: "Recovering terminal output..." appears on fresh terminal creation
- Even on the very first terminal creation (not a reconnect), the UI briefly shows "Recovering terminal output..." in the pane header
- This suggests the recovery UI path fires even for new terminals, not just reconnects
- May contribute to the "flaky feel" even in normal usage

## Recommendations for Spike Approach

1. **For reconnect measurement:** Must add instrumentation to source code (ws-client.ts, TerminalView.tsx) rather than relying on runtime injection — the injection gets lost on the page reloads that happen during reconnect scenarios.

2. **For Redux action flow analysis:** Runtime dispatch interceptor works well for non-reload scenarios. Good for observing normal usage patterns, tab switches, sidebar interactions.

3. **For visual regression:** Screenshots are reliable. Can capture before/during/after states of UI transitions.

4. **For production testing:** Need to build with source maps or add a `window.__freshellStore` export to the store module. Production build gives no fiber access.

5. **Should test production mode (npm start) separately from dev mode (npm run dev)** — the Vite proxy adds a layer that may mask or create different failure modes.
