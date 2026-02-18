# Mobile Search Access Design

## Date: 2026-02-14

## Problem

Terminal search (Ctrl+F) is inaccessible on mobile — no keyboard shortcut exists.

## Solution

Expose search via two new entry points:

1. **Search icon in PaneHeader** — always visible, between meta label and Maximize button
2. **"Search" entry in terminal context menu** — after "Select all"

Both use the existing `pane-action-registry` pattern to invoke `openSearch` on the target TerminalView.

## Architecture

Add `openSearch` to `TerminalActions` interface. TerminalView registers it wrapping `setSearchOpen(true)`. PaneHeader renders a Search icon button for terminal panes only. Context menu adds a "Search" item calling `terminalActions?.openSearch()`.

## Files

1. `src/lib/pane-action-registry.ts` — add `openSearch` to `TerminalActions`
2. `src/components/TerminalView.tsx` — register `openSearch`
3. `src/components/panes/PaneHeader.tsx` — add search button + `onSearch` prop
4. `src/components/panes/Pane.tsx` — wire `onSearch`
5. `src/components/panes/PaneContainer.tsx` — provide `onSearch` handler
6. `src/components/context-menu/menu-defs.ts` — add "Search" menu item
