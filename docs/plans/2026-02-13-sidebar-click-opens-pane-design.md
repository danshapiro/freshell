# Sidebar Click Opens Pane Instead of Tab

## Problem

Clicking a session in the sidebar currently opens it in a new tab via `openSessionTab`. The desired behavior is to open it as a pane split in the current tab, matching the existing "Open in this tab" context menu action.

## Design

### 1. Add `findPaneForSession` utility (`src/lib/session-utils.ts`)

Walk all tabs' pane trees and return `{ tabId, paneId }` if a session (by provider + sessionId) is already open in any pane. Returns `undefined` if not found.

### 2. Change `handleItemClick` in `Sidebar.tsx`

Current: always dispatches `openSessionTab` (creates/focuses a tab).

New behavior, in order:

1. **Dedup check:** Call `findPaneForSession`. If found, `setActiveTab(tabId)` + `setActivePane({ tabId, paneId })` + `onNavigate('terminal')`. Done.
2. **No active tab fallback:** If `activeTabId` is null, fall back to `openSessionTab` (creates a new tab with the session). This handles the edge case of an empty workspace.
3. **Normal case:** Dispatch `addPane` on the active tab with terminal content for the session (same logic as `openSessionInThisTab` in ContextMenuProvider).

### 3. Context menu unchanged

"Open in new tab" and "Open in this tab" remain as right-click options for explicit control.

### 4. Tests

- Unit tests for `findPaneForSession` utility
- Tests for updated sidebar click behavior (dedup, fallback, normal split)
