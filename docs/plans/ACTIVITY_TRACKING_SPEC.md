# Terminal Activity Tracking Feature Specification

This document captures the implementation of terminal activity tracking that was added between commits `f910fbf` and `9d9f9cc` (12 commits total, implemented Jan 31 2026).

## Feature Overview

### Goal
Provide visual and audio notifications when terminal streaming activity starts/stops, particularly for background tabs where Claude Code or Codex is running.

### State Machine

```
┌─────────┐  output starts   ┌──────────┐  output stops   ┌──────────┐
│  Ready  │ ──────────────── │ Working  │ ──────────────► │ Finished │
│ (idle)  │  (tab active)    │(streaming)│   (20s idle)    │ (done)   │
└─────────┘                  └──────────┘                  └──────────┘
     ▲                                                          │
     │                      user clicks tab                     │
     └──────────────────────────────────────────────────────────┘
```

**States:**
- **Ready** (default): Terminal is idle. Shows green dot.
- **Working**: Terminal is streaming output. Shows pulsing grey indicator. Can only enter this state when the tab is active AND user has typed input first.
- **Finished**: Streaming stopped on a background tab. Shows green ring around tab. Sound plays. Clears when user clicks tab.

**Rules:**
1. A pane must receive user input before it can enter Working state
2. Working state only enters when the tab is active (redundant to show "working" on background tabs)
3. Output within 200ms of input is considered "echo" and doesn't count as streaming
4. Streaming is considered stopped after 20s of no output
5. Sound plays when transitioning to Finished, with 30s debounce

## Files Added

### 1. `src/store/terminalActivitySlice.ts`
Redux slice for transient (non-persisted) terminal activity state.

```typescript
export interface TerminalActivityState {
  /** Map of paneId -> last output timestamp */
  lastOutputAt: Record<string, number>
  /** Map of paneId -> last input timestamp (for filtering echo) */
  lastInputAt: Record<string, number>
  /** Set of paneIds currently in "working" state */
  working: Record<string, boolean>
  /** Set of paneIds in "finished" state */
  finished: Record<string, boolean>
}
```

**Constants:**
- `STREAMING_THRESHOLD_MS = 20000` - How long idle before "finished"
- `WORKING_ENTER_THRESHOLD_MS = 2000` - Output must be this recent to enter working
- `INPUT_ECHO_WINDOW_MS = 200` - Output within this window of input is echo
- `SOUND_DEBOUNCE_MS = 30000` - Debounce window for notification sound

**Actions:**
- `recordOutput({ paneId })` - Called on every terminal.output message
- `recordInput({ paneId })` - Called on every terminal.input (user typing)
- `enterWorking({ paneId })` - Transition Ready → Working
- `finishWorking({ paneId })` - Transition Working → Finished
- `clearFinishedForTab({ paneIds })` - Clear finished state when tab selected
- `resetInputForTab({ paneIds })` - Reset stale input timestamps on tab switch
- `removePaneActivity({ paneId })` - Clean up when pane removed

### 2. `src/hooks/useTerminalActivityMonitor.ts`
Central hook that monitors all panes and manages state transitions.

```typescript
export interface TabActivityState {
  /** Tab has panes in working state */
  isWorking: boolean
  /** Tab has panes in finished state AND is a background tab */
  isFinished: boolean
}

export function useTerminalActivityMonitor(): {
  tabActivityStates: Record<string, TabActivityState>
}
```

**Logic:**
- Runs in TabBar component (single instance)
- Polls every 1s while streaming is active
- Detects streaming → idle transitions
- Plays sound on transition to finished (background tabs OR hidden browser tab)
- Clears finished state when tab becomes active
- Resets input timestamps on tab switch to prevent stale data

### 3. `src/hooks/useNotificationSound.ts`
Simple hook for playing debounced notification sounds.

```typescript
export function useNotificationSound(): {
  play: () => void
}
```

- Reuses Audio element
- Debounces to `SOUND_DEBOUNCE_MS` (30s)
- Volume at 0.5
- Catches play errors (browser may block autoplay)

### 4. `src/assets/your-code-is-ready.mp3`
Notification sound file (25KB).

### 5. MP3 module declaration in `src/vite-env.d.ts`
```typescript
declare module '*.mp3' {
  const src: string
  export default src
}
```

## Files Modified

### 1. `src/store/store.ts`
- Added `terminalActivityReducer` to store

### 2. `src/store/types.ts`
- Added `notifications` settings type:
```typescript
notifications: {
  visualWhenWorking: boolean
  visualWhenFinished: boolean
  soundWhenFinished: boolean
}
```
- Added `lastInputAt?: number` to Tab type

### 3. `src/store/settingsSlice.ts`
- Added default notifications settings:
```typescript
notifications: {
  visualWhenWorking: true,
  visualWhenFinished: true,
  soundWhenFinished: true,
}
```
- Updated `mergeSettings()` to handle notifications

### 4. `src/components/TerminalView.tsx`
- Import `recordOutput, recordInput` from terminalActivitySlice
- On `terminal.output`: dispatch `recordOutput({ paneId })`
- On `term.onData` (user input): dispatch `recordInput({ paneId })`

### 5. `src/components/TabBar.tsx`
- Import and call `useTerminalActivityMonitor()`
- Pass `isWorking` and `isFinished` to each TabItem
- Pass these props to DragOverlay TabItem as well

### 6. `src/components/TabItem.tsx`
- Added `isWorking` and `isFinished` props
- `StatusIndicator` shows pulsing grey when working
- Tab container gets `ring-2 ring-success` class when finished

### 7. `src/components/SettingsView.tsx`
- Added "Notifications" settings section with 3 toggles:
  - Show when working
  - Show when finished
  - Sound when finished

### 8. `README.md`
- Added feature bullet: "Cheery notifications — Audio and visual alerts when your agent needs your attention"

## Test Changes

Several test files needed mocks for `useTerminalActivityMonitor`:
- `test/unit/client/components/App.sidebar-resize.test.tsx`
- `test/unit/client/components/App.test.tsx`
- `test/unit/client/components/TabBar.deriveTitle.test.tsx`
- `test/unit/client/components/TabBar.test.tsx`
- `test/unit/client/components/component-edge-cases.test.tsx`

Mock pattern:
```typescript
vi.mock('@/hooks/useTerminalActivityMonitor', () => ({
  useTerminalActivityMonitor: () => ({ tabActivityStates: {} }),
}))
```

Settings test fixtures updated to include notifications defaults.

## Known Issues (Why We're Rolling Back)

1. **Patchy implementation** - Required 12 commits to get working, indicating unclear initial design
2. **Never quite right** - Various edge cases kept appearing (echo filtering, stale input, browser unfocused)
3. **Performance concerns** - recordOutput dispatches on every terminal output chunk
4. **Complexity** - State machine is complex with multiple thresholds and timing windows
5. **UX questions** - Working indicator may not be useful (you're already looking at it)

## Commits to Revert (chronological order)

1. `dd7f4d5` - feat(notifications): add terminal activity indicators and sound
2. `1c63354` - fix(settings): merge defaults in setSettings for new nested properties
3. `8b163b7` - fix(notifications): don't show working indicator for active tab
4. `99ec1c3` - refactor(notifications): simplify to ready/working/finished states
5. `9cc0c7c` - fix(notifications): filter out input echo from streaming detection
6. `652912e` - fix(notifications): remove working indicator, optimize performance
7. `68faa92` - fix(notifications): use 10s debounce constant from slice
8. `3013102` - fix(notifications): 20s idle threshold, 30s sound debounce
9. `59d8a53` - fix(notifications): trigger final check when streaming stops
10. `9c4268d` - feat(notifications): implement 3-state activity indicator
11. `4bc9d92` - fix(notifications): require user input before entering working state
12. `9d9f9cc` - feat(notifications): reset stale input on tab switch, play sound when browser unfocused

Note: `4654402` (Update settings tests for notifications) and `1c63354` also need reverting but are interleaved with other commits.

## Re-implementation Recommendations

If re-implementing from scratch:

1. **Simplify state machine** - Consider just "idle" and "finished" states
2. **Throttle updates** - Don't dispatch on every output chunk, sample at 500ms
3. **Use Web Worker** - Move activity monitoring off main thread
4. **Clearer UX** - Focus on the notification when agent finishes, not working state
5. **Write tests first** - TDD the state transitions before implementation
6. **Consider alternatives** - Could track at server level and push events
