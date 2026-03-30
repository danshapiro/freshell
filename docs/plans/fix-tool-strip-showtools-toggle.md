# Fix Tool Strip showTools Toggle Behavior

## Overview

This plan addresses the tool strip toggle behavior to make it session-only (not persisted to localStorage) and controlled by the `showTools` prop as the default state.

### Requirements

1. `showTools` is the default state at render
2. `showTools=false`: strip collapsed, all tools collapsed
3. `showTools=true`: strip expanded, all tools expanded
4. Strip chevron toggles strip only (show/hide individual tools list)
5. Tool chevron toggles that specific tool only
6. All toggles are session-only (lost on refresh)
7. On reload: reset to `showTools` default

## Files to Modify

### 1. `src/components/agent-chat/ToolStrip.tsx`

**Changes:**
- Remove `useSyncExternalStore` and related imports from `browser-preferences`
- Remove localStorage-based persistence
- Replace `expandedPref` with local `useState` initialized to `showTools`
- Pass `initialExpanded={showTools}` to each `ToolBlock` instead of `initialExpanded={shouldAutoExpand}`
- Remove the `autoExpandAbove` and `completedToolOffset` props (no longer needed)

**Before:**
```tsx
import { memo, useMemo, useSyncExternalStore } from 'react'
import {
  getToolStripExpandedPreference,
  setToolStripExpandedPreference,
  subscribeToolStripPreference,
} from '@/lib/browser-preferences'

// ...
const expandedPref = useSyncExternalStore(
  subscribeToolStripPreference,
  getToolStripExpandedPreference,
  () => false,
)
const expanded = showTools && expandedPref

const handleToggle = () => {
  setToolStripExpandedPreference(!expandedPref)
}
```

**After:**
```tsx
import { memo, useMemo, useState } from 'react'

// ...
const [stripExpanded, setStripExpanded] = useState(showTools)

const handleToggle = () => {
  setStripExpanded(!stripExpanded)
}

// In ToolBlock rendering:
<ToolBlock
  key={pair.id}
  name={pair.name}
  input={pair.input}
  output={pair.output}
  isError={pair.isError}
  status={pair.status}
  initialExpanded={showTools}
/>
```

### 2. `src/lib/browser-preferences.ts`

**Changes:**
- Remove `toolStrip` from `BrowserPreferencesRecord` type
- Remove `toolStrip` handling in `normalizeRecord()`
- Remove `toolStrip` handling in `patchBrowserPreferencesRecord()`
- Remove `toolStrip` handling in `migrateLegacyKeys()`
- Remove `getToolStripExpandedPreference()` function
- Remove `setToolStripExpandedPreference()` function
- Remove `subscribeToolStripPreference()` function
- Remove `LEGACY_TOOL_STRIP_STORAGE_KEY` constant

**Removed exports:**
- `getToolStripExpandedPreference`
- `setToolStripExpandedPreference`
- `subscribeToolStripPreference`

### 3. `src/components/agent-chat/MessageBubble.tsx`

**Changes:**
- Remove `completedToolOffset` and `autoExpandAbove` props from the interface
- Remove the `toolGroupOffsets` useMemo (no longer needed)
- Remove `completedToolOffset` and `autoExpandAbove` from ToolStrip props

**Before:**
```tsx
interface MessageBubbleProps {
  // ...
  completedToolOffset?: number
  autoExpandAbove?: number
}

// ...
<ToolStrip
  key={`tools-${group.startIndex}`}
  pairs={group.pairs}
  isStreaming={isStreaming}
  completedToolOffset={toolGroupOffsets[group.toolGroupIndex]}
  autoExpandAbove={autoExpandAbove}
  showTools={showTools}
/>
```

**After:**
```tsx
interface MessageBubbleProps {
  // ...
  // Remove completedToolOffset and autoExpandAbove
}

// ...
<ToolStrip
  key={`tools-${group.startIndex}`}
  pairs={group.pairs}
  isStreaming={isStreaming}
  showTools={showTools}
/>
```

### 4. `src/components/agent-chat/ToolBlock.tsx`

**No changes required.** The component already supports `initialExpanded` prop which controls the initial expanded state.

## Test Updates

### `test/unit/client/components/agent-chat/ToolStrip.test.tsx`

**Remove tests:**
- `'expands on chevron click and persists to browser preferences'` - no longer persists
- `'starts expanded when browser preferences have a stored preference'` - no longer reads from localStorage
- `'collapses on second chevron click and stores false in browser preferences'` - no longer persists
- `'passes autoExpandAbove props through to ToolBlocks in expanded mode'` - autoExpandAbove removed
- `'migrates the legacy tool-strip key through the browser preferences helper'` - legacy migration removed

**Modify tests:**
- `'always shows collapsed view when showTools is false, even if localStorage says expanded'` - simplify to just `'always shows collapsed view when showTools is false'`

**Add new tests:**
- `'starts expanded when showTools is true'`
- `'starts collapsed when showTools is false'`
- `'strip toggle is session-only (not persisted to localStorage)'`
- `'ToolBlocks start expanded when showTools is true'`
- `'ToolBlocks start collapsed when showTools is false'`
- `'individual ToolBlock toggles work independently'`

### `test/unit/client/components/agent-chat/MessageBubble.test.tsx`

**Modify tests:**
- Remove `completedToolOffset` and `autoExpandAbove` from any test setup if present
- Update tests that verify localStorage interaction to verify session-only behavior instead

### `test/unit/lib/browser-preferences.test.ts` (if exists)

**Remove tests:**
- Any tests for `getToolStripExpandedPreference`, `setToolStripExpandedPreference`, `subscribeToolStripPreference`
- Any tests for `toolStrip` field handling

## Implementation Steps

1. **browser-preferences.ts**: Remove tool strip persistence functions and types
2. **ToolStrip.tsx**: Replace localStorage with local state, pass `showTools` to ToolBlocks
3. **MessageBubble.tsx**: Remove unused props
4. **Update tests**: Remove localStorage-related tests, add session-only behavior tests
5. **Run full test suite**: `npm test`
6. **Manual verification**: Test in browser

## Commit Message

```
fix: make tool strip toggle session-only, controlled by showTools prop

- Remove localStorage persistence for tool strip expanded state
- ToolStrip now uses local useState initialized from showTools prop
- ToolBlocks inherit initial expanded state from showTools
- Remove autoExpandAbove/completedToolOffset props (no longer needed)
- All toggle state is session-only, resets on page refresh
```