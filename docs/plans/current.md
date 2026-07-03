# Replace Pane — Context Menu Feature

## Context
Users want to swap what's in a pane without removing the pane from the layout. "Replace pane" detaches the current content (terminal keeps running in background), then shows the pane picker so the user can choose a new agent/browser/editor/shell.

## Requirements
- Right-click context menu option "Replace pane" on: **pane header**, **terminal content**, **browser content**, **editor content**
- Detach terminal (keep PTY running) — same cleanup as close
- Always available, even when it's the only pane in a tab
- Replaces pane content with `{ kind: 'picker' }`, resetting auto-derived title

## Changes

### 1. New Redux action: `replacePane` in `panesSlice.ts`
Add a `replacePane` reducer alongside `updatePaneContent`. It:
- Sets pane content to `{ kind: 'picker' }`
- Clears `paneTitleSetByUser[tabId][paneId]` so the title resets
- Updates `paneTitles[tabId][paneId]` to the picker-derived title ("New Tab")

This is necessary because `updatePaneContent` alone won't reset user-set titles — if someone renamed a pane then replaced it, the old name would stick.

Export the action from the slice.

### 2. New menu action: `replacePane` in `menu-defs.ts`
- Add `replacePane: (tabId: string, paneId: string) => void` to `MenuActions` type
- Add a "Replace pane" menu item to:
  - `target.kind === 'pane'` — after "Rename pane", with a separator before it
  - `target.kind === 'terminal'` — at the end, after a separator
  - `target.kind === 'browser'` — at the end, after a separator
  - `target.kind === 'editor'` — at the end, after a separator

### 3. Handler: `replacePane` in `ContextMenuProvider.tsx`
- New `replacePane` callback:
  1. Guard: `if (!panes[tabId]) return` (handles stale menu / closed tab)
  2. Look up pane content via `findPaneContent(panes[tabId], paneId)`
  3. If content is terminal with `terminalId`, send `ws.send({ type: 'terminal.detach', terminalId })`
  4. Dispatch `replacePane({ tabId, paneId })`
- Wire into the `actions` object passed to `buildMenuItems`

### 4. Tests

**Unit test** (`test/unit/client/store/panesSlice.test.ts`):
- `replacePane` sets content to `{ kind: 'picker' }`
- `replacePane` clears `paneTitleSetByUser` and resets derived title
- `replacePane` on non-existent pane is a no-op

**Unit test** (`test/unit/client/context-menu/menu-defs.test.ts` — new file):
- `buildMenuItems` for `target.kind === 'pane'` includes "Replace pane" item
- `buildMenuItems` for `target.kind === 'terminal'` includes "Replace pane" item
- `buildMenuItems` for `target.kind === 'browser'` includes "Replace pane" item
- `buildMenuItems` for `target.kind === 'editor'` includes "Replace pane" item

**E2e test** (`test/e2e/replace-pane.test.tsx` — new file):
- Replace a terminal pane: right-click → Replace pane → verify picker is shown, terminal detached
- Replace in single-pane tab: verify works and picker renders
- Replace a renamed pane: verify title resets to "New Tab"

## Previously Known Issue (Fixed)
`tab.terminalId` was not cleared when panes were closed or replaced, causing `openTerminal` dedup to focus stale tabs. Fixed in this branch: `clearStaleTabTerminalId` helper clears `tab.terminalId` when the detached terminal matches, applied to `replacePaneAction`, `closePane` action (ContextMenuProvider), and `handleClose` (PaneContainer).

## Key Files
- `src/store/panesSlice.ts` — new `replacePane` action
- `src/components/context-menu/menu-defs.ts` — new menu items + `MenuActions` type
- `src/components/context-menu/ContextMenuProvider.tsx` — new handler + wiring
- `test/unit/client/store/panesSlice.test.ts` — Redux tests
- `test/unit/client/context-menu/menu-defs.test.ts` — menu definition tests (new)
- `test/e2e/replace-pane.test.tsx` — e2e tests (new)

## Verification
1. `npm test` — all existing + new tests pass
2. Manual: right-click pane header → "Replace pane" → pane shows picker
3. Manual: right-click terminal content → "Replace pane" → terminal detaches, picker shown
4. Manual: right-click browser/editor content → "Replace pane" → picker shown
5. Manual: single-pane tab → "Replace pane" still available and works
6. Manual: renamed pane → "Replace pane" → title resets to "New Tab"
