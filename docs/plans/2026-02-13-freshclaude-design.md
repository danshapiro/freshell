# Freshclaude Client Improvements — Design

**Date:** 2026-02-13
**Branch:** claude-client-fixes

## Overview

A collection of fixes and improvements to the Claude Web chat client pane, renamed to "freshclaude". Covers renaming, default configuration, a per-pane settings popover, a new icon, scroll preservation, and permission-status clarity.

## 1. Rename "Claude Web" → "freshclaude"

Cosmetic rename in all user-facing text. Internal identifiers (`claude-chat`, `ClaudeChatView`, `ClaudeChatPaneContent`, slice names, WS message types) remain unchanged.

**Touch points:**
- `PanePicker.tsx` — picker label
- `derivePaneTitle.ts` — default pane/tab title
- `ClaudeChatView.tsx` — welcome heading, aria-label
- `PaneContainer.tsx` — provider label in directory picker flow

## 2. Default Model & Permission Mode

- Default model: `claude-opus-4-6`
- Default permission mode: `dangerouslySkipPermissions`
- Passed in the `sdk.create` WebSocket message (schema already has `model` and `permissionMode` fields)
- Stored per-pane in `ClaudeChatPaneContent` so they can be overridden via settings

## 3. Settings Popover

### New fields on `ClaudeChatPaneContent`

All optional, with sensible defaults applied at render time:

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `model` | `string?` | `'claude-opus-4-6'` | Locked after first message sent |
| `permissionMode` | `string?` | `'dangerouslySkipPermissions'` | Locked after first message sent |
| `showThinking` | `boolean?` | `true` | Live toggle |
| `showTools` | `boolean?` | `true` | Live toggle |
| `showTimecodes` | `boolean?` | `false` | Live toggle |
| `settingsDismissed` | `boolean?` | `false` | Tracks first-time auto-open |

### UI

- **Trigger:** Gear icon in the `ClaudeChatView` status bar (top bar)
- **Auto-open:** Popover opens automatically on first mount when `settingsDismissed` is falsy
- **Close behavior:** Closing sets `settingsDismissed = true`, persisted with the pane
- **Contents:**
  - Model picker (dropdown: opus 4.6, sonnet 4.5, haiku 4.5) — disabled after first message
  - Permission mode (dropdown: dangerouslySkipPermissions, default) — disabled after first message
  - Show thinking (toggle)
  - Show tools (toggle)
  - Show timecodes (toggle)
- **State management:** All changes dispatch `updatePaneContent` → persisted to localStorage

### New component

`src/components/claude-chat/FreshclaudeSettings.tsx`

## 4. Freshclaude Icon

- New SVG: Claude sparkle/asterisk inside a chat bubble, visually distinct from the plain Claude Code terminal icon
- Saved as `assets/icons/freshclaude.svg`
- Add `claude-chat` case to `PaneIcon.tsx` → renders inline SVG component
- Update `PanePicker.tsx` to use the new icon URL
- Automatically updates tab bar icons and pane header icons

## 5. Scroll Preservation Fix

### Root cause

`ClaudeChatView` returns `null` when `hidden=true`, unmounting the DOM tree and losing scroll position.

### Fix

- Use CSS-based hiding like `TerminalView`: wrap in a div with `tab-hidden`/`tab-visible` classes instead of returning null
- Smart auto-scroll: only scroll to bottom when user is already at/near the bottom (within ~50px threshold)
- When user has scrolled up to read history, new messages do not force scroll

## 6. "Waiting for answer..." Status

### Current behavior

When Claude requests a permission (Allow/Deny), status bar shows "Running..." — no indication that user action is needed.

### Fix

When `pendingPermissions.length > 0`, override status bar text to **"Waiting for answer..."** so the user knows Claude is blocked on their input.

## Files Modified

| File | Changes |
|------|---------|
| `src/store/paneTypes.ts` | Add optional fields to `ClaudeChatPaneContent` |
| `src/components/claude-chat/ClaudeChatView.tsx` | Rename text, CSS hiding, smart scroll, permission status, settings gear icon, pass model/permissionMode to sdk.create |
| `src/components/claude-chat/FreshclaudeSettings.tsx` | **New** — settings popover component |
| `src/components/claude-chat/MessageBubble.tsx` | Respect `showThinking`, `showTools`, `showTimecodes` props |
| `src/components/panes/PanePicker.tsx` | Rename label, update icon |
| `src/components/icons/PaneIcon.tsx` | Add `claude-chat` case |
| `src/lib/derivePaneTitle.ts` | Return `'freshclaude'` |
| `src/components/panes/PaneContainer.tsx` | Update provider label |
| `assets/icons/freshclaude.svg` | **New** — freshclaude icon |
