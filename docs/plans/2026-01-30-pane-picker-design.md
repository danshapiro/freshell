# Pane Picker Design

## Overview

Replace the current "new pane opens as shell immediately" behavior with a picker UI. When a new pane appears (via new tab or FAB), the user sees centered icons for each pane type and clicks to choose. A user setting controls whether new tabs show the picker or auto-open a default pane type.

## Goals

- Unified pane creation experience via picker UI
- User-configurable default for new tabs
- Scalable design that accommodates future pane types
- Keyboard accessible with shortcuts for power users

## Data Model

### New Pane Content Type

Add `picker` as a first-class pane content kind:

```typescript
// src/store/paneTypes.ts

export type PickerPaneContent = {
  kind: 'picker'
}

export type PaneContent =
  | TerminalPaneContent
  | BrowserPaneContent
  | EditorPaneContent
  | PickerPaneContent
```

The picker content type:
- Persists to localStorage like other content types
- Refreshing with picker open shows picker again
- No additional fields needed

### New Setting

Add `panes` section to `AppSettings`:

```typescript
// src/store/types.ts

export interface AppSettings {
  // ... existing fields
  panes: {
    defaultNewPane: 'ask' | 'shell' | 'browser' | 'editor'
  }
}
```

Default value: `'ask'`

Server-side default in `config-store.ts`:
```typescript
panes: {
  defaultNewPane: 'ask'
}
```

## Behavior

### New Tab Creation

When a new tab is created:

1. Check `settings.panes.defaultNewPane`
2. If `'ask'` → create pane with `{ kind: 'picker' }`
3. If `'shell'` | `'browser'` | `'editor'` → create pane with that content type directly (current behavior for shell)

This means setting default to `'shell'` preserves today's behavior exactly.

### FAB Behavior

The FAB changes from a dropdown menu to a simple "add pane" button:

1. User clicks FAB
2. New pane added with `{ kind: 'picker' }`
3. Picker shows in the new pane
4. User selects pane type

The current `FloatingActionButton` dropdown menu is removed entirely. The FAB always creates a picker pane, regardless of the default setting.

### Picker Selection

When user clicks an icon in the picker:

1. Fast fade-out animation on picker (150-200ms)
2. Replace pane content with selected type:
   - Shell → `{ kind: 'terminal', mode: 'shell' }`
   - Browser → `{ kind: 'browser', url: '', devToolsOpen: false }`
   - Editor → `{ kind: 'editor', filePath: null, ... }`
3. Content loads (shows its own loading state)

### Escape/Cancel Behavior

When picker is showing and user presses Escape or clicks outside:

- **If only pane in tab:** Do nothing (force selection)
- **If multiple panes exist:** Close the picker pane entirely

This prevents users from getting stuck with an empty tab, while allowing cancellation of "extra" panes spawned via FAB.

### Tab Title

While picker is showing, tab title is `"New Tab"`.

## UI Design

### Picker Component

`src/components/panes/PanePicker.tsx`

**Layout:**
- Full pane height/width container
- Content vertically and horizontally centered
- Horizontal row of options (wraps to multiple rows as options grow)
- Generous whitespace (padding) around the group

**Visual style:**
- Icons: Lucide icons (Terminal, Globe, FileText)
- Icon color: 50% opacity, theme-aware (black in light mode, white in dark mode)
- Icon size: Large (48-64px suggested)
- Labels: Below each icon, same opacity treatment
- Hover state: Increase opacity to 80-100%, subtle scale or glow

**Options (initial):**
1. Shell (Terminal icon) - shortcut: S
2. Browser (Globe icon) - shortcut: B
3. Editor (FileText icon) - shortcut: E

### Keyboard Interaction

**Arrow navigation:**
- Left/Right arrows move focus between options
- Up/Down arrows also work (for multi-row future)
- Enter selects focused option
- No initial focus on render

**Single-key shortcuts:**
- `S` selects Shell
- `B` selects Browser
- `E` selects Editor
- Shortcuts work regardless of focus state
- Shortcut hint appears on hover/focus only (e.g., underlined letter or small badge)

**Escape:**
- Closes pane if multiple panes exist
- Ignored if only pane in tab

### Settings UI

Add new "Panes" section in `SettingsView.tsx`:

```
Panes
─────────────────────────────
Default new pane    [Ask ▾]

                    Ask
                    Shell
                    Browser
                    Editor
```

Position: After "Sidebar" section, before any future sections.

## Component Structure

### New Components

**`PanePicker.tsx`**
- Renders the picker UI
- Handles keyboard events (arrows, Enter, shortcuts, Escape)
- Calls `onSelect(contentType)` when user chooses
- Props: `paneId`, `isOnlyPane`, `onSelect`, `onCancel`

**`PickerOption.tsx`** (optional, for cleaner code)
- Single option: icon + label
- Handles hover/focus states
- Shows shortcut hint on hover/focus

### Modified Components

**`PaneContainer.tsx`**
- Add case for `kind: 'picker'` → render `<PanePicker />`
- Wire up selection to dispatch content update

**`PaneLayout.tsx`**
- Remove dropdown menu logic from FAB
- FAB onClick → `dispatch(addPane({ tabId, newContent: { kind: 'picker' } }))`

**`FloatingActionButton.tsx`**
- Simplify to just a button (remove menu state, keyboard nav for menu)
- Single click → calls `onAdd()`

**`TabContent.tsx`**
- Check `settings.panes.defaultNewPane`
- If `'ask'` → pass `{ kind: 'picker' }` as defaultContent
- Otherwise → pass appropriate content type

**`SettingsView.tsx`**
- Add "Panes" section with dropdown for `defaultNewPane`

### Redux Changes

**`panesSlice.ts`**
- `initLayout` and `addPane` already accept `PaneContentInput`
- Add `PickerPaneInput` type (just `{ kind: 'picker' }`)
- Add action `setPaneContent(paneId, content)` for picker → real content transition

**`settingsSlice.ts`**
- No changes needed (settings are fetched from server)

**Server `config-store.ts`**
- Add default for `panes.defaultNewPane: 'ask'`
- Add to settings schema validation

## Animation

Picker fade-out on selection:
- Duration: 150ms
- Easing: ease-out
- Opacity: 1 → 0
- After animation completes, swap content

Implementation: CSS transition on wrapper, or Framer Motion if already in use.

## Accessibility

- All options are buttons with proper labels
- Arrow key navigation follows WAI-ARIA grid pattern
- Keyboard shortcuts are discoverable (shown on focus)
- Focus is trapped in picker when open (Tab cycles through options)
- Screen readers announce "New pane: choose type" or similar

## Testing Strategy

### Unit Tests

**PanePicker.tsx**
- Renders all options with correct icons and labels
- Arrow keys move focus correctly
- Enter selects focused option
- Shortcut keys (S, B, E) trigger selection
- Escape calls onCancel when isOnlyPane=false
- Escape does nothing when isOnlyPane=true
- Hover/focus shows shortcut hints

**FloatingActionButton.tsx (updated)**
- Click calls onAdd
- No dropdown menu rendered

**PaneContainer.tsx**
- Renders PanePicker for `kind: 'picker'`

**TabContent.tsx**
- Uses picker content when setting is 'ask'
- Uses shell content when setting is 'shell'
- (etc for browser, editor)

**SettingsView.tsx**
- Renders Panes section with dropdown
- Dropdown has correct options
- Selection updates setting

### Integration Tests

- New tab with default='ask' shows picker
- New tab with default='shell' shows terminal
- FAB click creates picker pane
- Selecting option in picker loads correct content
- Escape on FAB-spawned picker closes it
- Escape on only-pane picker does nothing
- Setting change persists and affects new tabs

## Migration

No data migration needed:
- New `panes.defaultNewPane` setting has server-side default
- Existing persisted panes won't have `kind: 'picker'` (they're all terminal/browser/editor)
- New picker content type only appears from new interactions

## Future Extensibility

The picker design accommodates growth:
- Adding new pane types: Add to options array, add shortcut
- Multi-row layout: CSS flex-wrap handles automatically
- Categories/grouping: Could add section headers if options exceed ~6-8
- Recent/favorites: Could add a "recent" row above main options
- Search: Could add search box for many options (far future)

## Implementation Order

1. Add `PickerPaneContent` type to `paneTypes.ts`
2. Add `panes.defaultNewPane` setting (types, server default, SettingsView)
3. Create `PanePicker.tsx` component with full keyboard support
4. Update `PaneContainer.tsx` to render picker
5. Update `TabContent.tsx` to respect default setting
6. Simplify `FloatingActionButton.tsx` (remove dropdown)
7. Update `PaneLayout.tsx` FAB handler
8. Add tests throughout
9. Manual testing pass
