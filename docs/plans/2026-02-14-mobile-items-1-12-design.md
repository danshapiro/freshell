# Mobile Items 1-12: Design Document

**Date:** 2026-02-14

## Architectural Decisions

### Gesture Handling: `@use-gesture/react`
The most popular React gesture library. Handles swipe detection with velocity thresholds, edge swiping, drag, and long-press. Items #1, #3, #5, #11 all need gesture handling — a library prevents reinventing each gesture.

### Mobile CSS Strategy: Tailwind Responsive Utilities
Mobile-first defaults with `md:` prefix for desktop overrides. Example: `min-h-11 md:min-h-0` gives 44px touch targets on mobile, normal on desktop. Zero JS, handles orientation changes and resize automatically.

### Mobile Detection for JS: `useMobile()` Hook
A custom hook wrapping `window.matchMedia('(max-width: 767px)')`. Components that need JS-level mobile detection (gesture handlers, conditional rendering) import the hook directly. No prop drilling, no context boilerplate.

## Implementation Batches

### Batch A — Foundation
- Install `@use-gesture/react`
- Create `useMobile()` hook with `matchMedia`
- Establish mobile-first Tailwind pattern

### Batch B — Touch Targets (#6, #7, #8, #9, #10)
CSS-only Tailwind class changes, no JS logic. Can be done in parallel across components.

- **#6**: Add `min-h-11 min-w-11 md:min-h-0 md:min-w-0` to close buttons, new tab button, session action buttons, settings gear, header buttons, terminal search buttons
- **#7**: Tab bar `h-10` → `h-12 md:h-10` (48px mobile, 40px desktop)
- **#8**: Sidebar session item padding `py-2` → `py-3 md:py-2`; verify action buttons meet 44px
- **#9**: Context menu item padding `px-3 py-2` → `px-4 py-3 md:px-3 md:py-2`
- **#10**: Header icon buttons get `min-h-11 min-w-11 md:min-h-0 md:min-w-0`

### Batch C — Sidebar Gestures & Overlay (#11, #12)
- **#11**: `useDrag` on main content area. Right-swipe from left 30px edge → open sidebar. Left-swipe while sidebar open → close. Guard with `useMobile()`.
- **#12**: Verify existing backdrop (App.tsx lines 536-546) works reliably on touch. Fix if needed.

### Batch D — Tab Navigation (#1, #2, #3, #4, #5)
- **#1**: `useDrag` on terminal container. Horizontal swipe → switch tabs. Leftmost tab + swipe right → open sidebar.
- **#2**: New `MobileTabStrip` component. Centered `< Tab Name (2/5) >` with chevrons. Tap center → bottom-sheet tab picker. Rendered conditionally on mobile.
- **#3**: Long-press on tab (500ms without movement) → context menu instead of drag. Hook into dnd-kit lifecycle or separate `useLongPress` hook.
- **#4**: New `TabSwitcher` component. Fullscreen overlay, tabs as cards in 2-column grid. Tap to switch. Triggered from mobile tab strip.
- **#5**: Swipe down to reveal hidden tab bar. Depends on future fullscreen mode (#29). For now, add the gesture infrastructure; defer full implementation.

## Key Files to Modify

| File | Changes |
|------|---------|
| `src/hooks/useMobile.ts` | NEW — mobile detection hook |
| `src/components/TabBar.tsx` | Height, conditional mobile strip, touch targets |
| `src/components/TabItem.tsx` | Close button touch targets, long-press |
| `src/components/MobileTabStrip.tsx` | NEW — simplified mobile tab navigation |
| `src/components/TabSwitcher.tsx` | NEW — fullscreen tab grid overlay |
| `src/components/Sidebar.tsx` | Session item padding, action button sizing |
| `src/components/App.tsx` | Header button sizing, sidebar swipe gesture, backdrop fix |
| `src/components/TerminalView.tsx` | Tab swipe gesture |
| `src/components/context-menu/ContextMenu.tsx` | Item padding |
| `package.json` | Add `@use-gesture/react` |
