# Clickable Terminal URLs

## Goal

URLs rendered in terminal panes (OSC 8 hyperlinks from Claude Code, opencode, Codex CLI, etc.) should be interactive:
- **Left-click** opens the URL in a browser pane in the same tab (split right)
- **Right-click** shows a context menu with URL-specific options: open in pane, open in tab, open in browser, copy URL

Currently, the OSC 8 `linkHandler.activate` either shows a warning modal or calls `window.open`. Custom `registerLinkProvider` links (file paths) already open editor panes via `splitPane`. We extend both mechanisms.

## Architecture Overview

### Key Touch Points

1. **`src/components/TerminalView.tsx`** -- Terminal creation, linkHandler, registerLinkProvider, hover state
2. **`src/components/context-menu/context-menu-types.ts`** -- ContextTarget union type
3. **`src/components/context-menu/context-menu-constants.ts`** -- ContextIds enum
4. **`src/components/context-menu/context-menu-utils.ts`** -- parseContextTarget
5. **`src/components/context-menu/menu-defs.ts`** -- buildMenuItems, MenuActions
6. **`src/components/context-menu/ContextMenuProvider.tsx`** -- Action implementations, menu wiring
7. **`src/store/panesSlice.ts`** -- splitPane action
8. **`src/store/paneTypes.ts`** -- BrowserPaneContent

### Design Decisions

- **Hover state tracking via a module-level map** (not React state or Redux): The xterm.js `ILinkHandler.hover`/`leave` and `ILink.hover`/`leave` callbacks fire on raw DOM events, outside the React render cycle. We use a simple `Map<string, string>` keyed by paneId, storing the currently hovered URL. This avoids unnecessary re-renders and is synchronous to read at context-menu time.

- **`ILinkHandler` vs `ILink` hover/leave signatures differ**: The `ILinkHandler` callbacks (OSC 8) receive `(event, text, range)` while `ILink` callbacks (custom link providers) receive `(event, text)`. Both are optional. Our implementations can safely ignore trailing params but should use the correct signature for each context to satisfy TypeScript.

- **Context menu uses `dataset` attributes**: Following the existing pattern (e.g., `data-tab-id`, `data-pane-id`), we add `data-hovered-url` to the TerminalView wrapper div. The context menu system reads this from `dataset` when building menu items. This is the same pattern used by `data-context`, `data-tab-id`, etc.

- **No new ContextTarget kind**: Rather than adding a new `terminal-url` kind, we enrich the existing `terminal` target with an optional `hoveredUrl` field. This is simpler and avoids splitting the terminal menu into two separate code paths. The `buildMenuItems` function checks for `hoveredUrl` in the dataset and conditionally prepends URL-specific items.

- **New URL actions are separate from existing `splitPane` action in MenuActions**: The existing `actions.splitPane` in `ContextMenuProvider` always opens a picker pane (`{ kind: 'picker' }`). Our new `openUrlInPane` action dispatches `splitPaneAction` directly with browser content, bypassing the picker. This is intentional -- URL links should open directly in browser panes without a picker step.

- **Left-click opens browser pane**: The `linkHandler.activate` callback dispatches `splitPane` with browser content, similar to how file path links dispatch `splitPane` with editor content. The warning modal is preserved as a setting but the default behavior changes from `window.open` to split-pane-browser.

- **Warning modal still applies**: When `warnExternalLinks` is enabled, the warning modal still fires on left-click. But on confirm, it opens in a browser pane instead of `window.open`. The "Open in external browser" option in the context menu always uses `window.open`.

---

## Implementation Plan

### Phase 1: Hover State Tracking

**File: `src/lib/terminal-hovered-url.ts`** (new)

Create a small utility module to track hovered URLs per pane:

```ts
const hoveredUrls = new Map<string, string>()

export function setHoveredUrl(paneId: string, url: string): void {
  hoveredUrls.set(paneId, url)
}

export function clearHoveredUrl(paneId: string): void {
  hoveredUrls.delete(paneId)
}

export function getHoveredUrl(paneId: string): string | undefined {
  return hoveredUrls.get(paneId)
}
```

**File: `src/components/TerminalView.tsx`**

1. Import the new module.

2. Update the `linkHandler` on the Terminal constructor to add `hover` and `leave` callbacks:

```ts
linkHandler: {
  activate: (_event: MouseEvent, uri: string) => {
    // Changed: open in browser pane instead of window.open
    if (warnExternalLinksRef.current !== false) {
      setPendingLinkUriRef.current(uri)
    } else {
      dispatch(splitPane({
        tabId,
        paneId,
        direction: 'horizontal',
        newContent: { kind: 'browser', url: uri, devToolsOpen: false },
      }))
    }
  },
  // ILinkHandler.hover signature: (event, text, range) -- range unused
  hover: (_event: MouseEvent, text: string, _range: import('@xterm/xterm').IBufferRange) => {
    setHoveredUrl(paneId, text)
  },
  // ILinkHandler.leave signature: (event, text, range) -- all unused
  leave: () => {
    clearHoveredUrl(paneId)
  },
},
```

Note: The `leave` callback ignores all parameters. TypeScript allows fewer params than the signature requires, so `() => void` is valid for `(event, text, range) => void`.

3. The existing file path link provider's `ILink` objects do not need `hover`/`leave` callbacks. File paths are not URLs, and they already open in editor panes. Leave them unchanged -- do **not** add empty hover/leave stubs.

4. Add a URL link provider via `registerLinkProvider` to detect plain-text URLs in terminal output (non-OSC-8). This ensures URLs that are visually styled but not wrapped in OSC 8 sequences are also clickable. **Register this BEFORE the file path provider** (currently at line 1044 in TerminalView.tsx) so file paths get higher priority (xterm.js: last registered = highest priority):

```ts
const urlLinkDisposable = typeof term.registerLinkProvider === 'function'
  ? term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const bufferLine = term.buffer.active.getLine(bufferLineNumber - 1)
      if (!bufferLine) { callback(undefined); return }
      const text = bufferLine.translateToString()
      const urls = findUrls(text)  // new utility function
      if (urls.length === 0) { callback(undefined); return }
      callback(urls.map((m) => ({
        range: {
          start: { x: m.startIndex + 1, y: bufferLineNumber },
          end: { x: m.endIndex, y: bufferLineNumber },
        },
        text: m.url,
        activate: (_event: MouseEvent) => {
          if (warnExternalLinksRef.current !== false) {
            setPendingLinkUriRef.current(m.url)
          } else {
            dispatch(splitPane({
              tabId,
              paneId,
              direction: 'horizontal',
              newContent: { kind: 'browser', url: m.url, devToolsOpen: false },
            }))
          }
        },
        hover: () => setHoveredUrl(paneId, m.url),
        leave: () => clearHoveredUrl(paneId),
      })))
    },
  })
  : { dispose: () => {} }
```

5. Add cleanup in the terminal teardown to call `clearHoveredUrl(paneId)` and dispose the new link provider.

6. Update the warning modal confirm handler to open in browser pane instead of `window.open`:

```ts
onConfirm={() => {
  if (pendingLinkUri) {
    dispatch(splitPane({
      tabId,
      paneId,
      direction: 'horizontal',
      newContent: { kind: 'browser', url: pendingLinkUri, devToolsOpen: false },
    }))
  }
  setPendingLinkUri(null)
}}
```

**File: `src/lib/url-utils.ts`** (new, or add to existing path-utils.ts)

Create a `findUrls(line: string)` utility that finds http/https URLs in terminal output text. This mirrors `findLocalFilePaths` but for URLs. Must be careful to not match URLs that are already handled by `findLocalFilePaths` -- but since xterm.js link providers have priority ordering (last registered = highest priority), and file paths should not look like URLs, this should not conflict. If a range overlaps with a file path link, xterm's own priority system handles it.

```ts
export type UrlMatch = {
  url: string
  startIndex: number
  endIndex: number
}

export function findUrls(line: string): UrlMatch[] {
  // Match http:// and https:// URLs
  // Use a regex similar to what WebLinksAddon uses
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g
  const results: UrlMatch[] = []
  let match
  while ((match = urlRegex.exec(line)) !== null) {
    // Trim trailing punctuation that's likely not part of the URL
    let url = match[0]
    const trailingPunct = /[.,;:!?)]+$/
    const trailingMatch = trailingPunct.exec(url)
    const endTrim = trailingMatch ? trailingMatch[0].length : 0
    url = url.slice(0, url.length - endTrim)
    results.push({
      url,
      startIndex: match.index,
      endIndex: match.index + url.length,
    })
  }
  return results
}
```

### Phase 2: Context Menu Integration

**File: `src/components/TerminalView.tsx`**

Update the wrapper div to include the hovered URL in a data attribute. Since the hovered URL changes frequently (on mouse move) but we only need it at context-menu-open time, we use a ref-based approach to update a data attribute imperatively.

1. Add a `wrapperRef` and attach it to the outer div (the one at approx line 2003 that currently has `data-context={ContextIds.Terminal}`, `data-pane-id={paneId}`, `data-tab-id={tabId}` but no ref):

```tsx
// In the component body (near containerRef at line 231):
const wrapperRef = useRef<HTMLDivElement | null>(null)

// In the JSX, add ref to the outer div:
<div
  ref={wrapperRef}
  className={cn('h-full w-full', hidden ? 'tab-hidden' : 'tab-visible relative')}
  data-context={ContextIds.Terminal}
  data-pane-id={paneId}
  data-tab-id={tabId}
>
```

**Timing note**: The hover/leave callbacks reference `wrapperRef.current`, but are defined inside the terminal creation `useEffect` (line 976, dependency `[isTerminal]`). This is safe because `wrapperRef.current` is set during the initial render (before any user interaction can trigger hover events), and the callbacks only execute when the user hovers a link.

2. In the hover/leave callbacks (both in the `linkHandler` and in the URL link provider), also update the DOM attribute:

```tsx
// For linkHandler hover/leave:
hover: (_event, text, _range) => {
  setHoveredUrl(paneId, text)
  if (wrapperRef.current) {
    wrapperRef.current.dataset.hoveredUrl = text
  }
},
leave: () => {
  clearHoveredUrl(paneId)
  if (wrapperRef.current) {
    delete wrapperRef.current.dataset.hoveredUrl
  }
},

// For URL link provider ILink hover/leave:
hover: () => {
  setHoveredUrl(paneId, m.url)
  if (wrapperRef.current) {
    wrapperRef.current.dataset.hoveredUrl = m.url
  }
},
leave: () => {
  clearHoveredUrl(paneId)
  if (wrapperRef.current) {
    delete wrapperRef.current.dataset.hoveredUrl
  }
},
```

The `data-hovered-url` attribute will be picked up by the context menu system's `copyDataset` call, which copies all `dataset` properties from the nearest context element.

**File: `src/components/context-menu/context-menu-types.ts`**

Add `hoveredUrl` to the `terminal` kind in the ContextTarget union:

```ts
| { kind: 'terminal'; tabId: string; paneId: string; hoveredUrl?: string }
```

**File: `src/components/context-menu/context-menu-utils.ts`**

Update `parseContextTarget` for the Terminal case to extract `hoveredUrl`:

```ts
case ContextIds.Terminal:
  return data.tabId && data.paneId
    ? {
        kind: 'terminal',
        tabId: data.tabId,
        paneId: data.paneId,
        hoveredUrl: data.hoveredUrl,
      }
    : null
```

**File: `src/components/context-menu/menu-defs.ts`**

1. Add new URL-related actions to the `MenuActions` type:

```ts
openUrlInPane: (tabId: string, paneId: string, url: string) => void
openUrlInTab: (url: string) => void
openUrlInBrowser: (url: string) => void
copyUrl: (url: string) => void
```

2. Update the `terminal` section of `buildMenuItems` to prepend URL-specific items when `hoveredUrl` is present:

```ts
if (target.kind === 'terminal') {
  const terminalActions = actions.getTerminalActions(target.paneId)
  const hasSelection = terminalActions?.hasSelection() ?? false
  // ... existing code ...

  const urlItems: MenuItem[] = target.hoveredUrl ? [
    {
      type: 'item',
      id: 'url-open-pane',
      label: 'Open URL in pane',
      onSelect: () => actions.openUrlInPane(target.tabId, target.paneId, target.hoveredUrl!),
    },
    {
      type: 'item',
      id: 'url-open-tab',
      label: 'Open URL in new tab',
      onSelect: () => actions.openUrlInTab(target.hoveredUrl!),
    },
    {
      type: 'item',
      id: 'url-open-browser',
      label: 'Open in external browser',
      onSelect: () => actions.openUrlInBrowser(target.hoveredUrl!),
    },
    {
      type: 'item',
      id: 'url-copy',
      label: 'Copy URL',
      onSelect: () => actions.copyUrl(target.hoveredUrl!),
    },
    { type: 'separator', id: 'url-sep' },
  ] : []

  return [
    ...urlItems,
    ...buildTerminalClipboardItems(terminalActions, hasSelection),
    // ... rest of existing items
  ]
}
```

**File: `src/components/context-menu/ContextMenuProvider.tsx`**

Add the action implementations:

```ts
const openUrlInPane = useCallback((tabId: string, paneId: string, url: string) => {
  dispatch(splitPaneAction({
    tabId,
    paneId,
    direction: 'horizontal',
    newContent: { kind: 'browser', url, devToolsOpen: false },
  }))
}, [dispatch])

const openUrlInTab = useCallback((url: string) => {
  const id = nanoid()
  dispatch(addTab({ id, mode: 'shell' }))
  dispatch(initLayout({ tabId: id, content: { kind: 'browser', url, devToolsOpen: false } }))
}, [dispatch])

const openUrlInBrowser = useCallback((url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer')
}, [])

const copyUrlAction = useCallback(async (url: string) => {
  await copyText(url)
}, [])
```

Define these as `useCallback` hooks alongside the existing action callbacks (before line 886). Then wire them into the `actions` object inside the `useMemo` at line 900 (add them after `copyAgentChatFilePath`). Also add them to the `useMemo` dependency array at lines 965-1019. The new action signatures should also be added to the `MenuActions` type in `menu-defs.ts`.

Note: `copyText`, `nanoid`, `addTab`, `initLayout`, and `splitPaneAction` are all already imported in ContextMenuProvider.tsx -- no new imports needed for the action implementations.

### Phase 3: Update Existing Tests

**File: `test/unit/client/components/TerminalView.linkWarning.test.tsx`**

The existing tests verify that:
1. The warning modal shows when a link is clicked
2. Confirming opens the link via `window.open`
3. Canceling does not open the link
4. Disabling `warnExternalLinks` opens immediately via `window.open`

These tests need updating because:
- The confirm action now dispatches `splitPane` instead of calling `window.open`
- The bypass (warnExternalLinks=false) now dispatches `splitPane` instead of `window.open`

Update the assertions to check that `store.getState().panes.layouts['tab-1']` becomes a split with a browser pane, instead of checking `window.open`.

**File: `test/unit/client/components/TerminalView.keyboard.test.tsx`**

This file captures `registerLinkProvider` callbacks via `capturedLinkProvider`. Since we add a new URL link provider, `registerLinkProvider` will now be called twice (URL provider first, then file path provider). The mock at line 58-61 saves only the last provider registered. If any keyboard tests depend on the captured file path provider, verify they still capture the correct one. The URL provider registration means `registerLinkProvider.mock.calls` will have two entries. Adjust the `capturedLinkProvider` capture if needed (e.g., capture the last call or both calls).

### Phase 4: New Tests

**File: `test/unit/client/lib/terminal-hovered-url.test.ts`** (new)

Test the module-level map utilities:
- `setHoveredUrl` / `getHoveredUrl` / `clearHoveredUrl` basic CRUD
- Multiple panes tracked independently
- Clear removes correctly

**File: `test/unit/client/lib/url-utils.test.ts`** (new, or extend path-utils test)

Test `findUrls`:
- Matches `http://` and `https://` URLs
- Strips trailing punctuation (periods, commas, parentheses)
- Returns correct startIndex/endIndex
- Handles multiple URLs per line
- Does not match non-URL text
- Edge cases: URLs at end of line, URLs with query strings, URLs with fragments
- Edge case: URLs with balanced parentheses (e.g., Wikipedia URLs like `https://en.wikipedia.org/wiki/Foo_(bar)`) -- the trailing punctuation stripper may over-trim. Decide whether to handle balanced parens or accept this limitation. A simple approach: only strip a trailing `)` if there is no matching `(` in the URL.

**File: `test/unit/client/components/TerminalView.urlClick.test.tsx`** (new)

Test the left-click behavior:
- Clicking a URL (via linkHandler.activate) with warnExternalLinks=true shows modal, confirming dispatches splitPane with browser content
- Clicking a URL with warnExternalLinks=false directly dispatches splitPane with browser content
- Verify the browser pane content has the correct URL

**File: `test/unit/client/components/context-menu/menu-defs.test.ts`** (update existing -- this is the canonical test file using `@/` imports)

Note: There is also a stale `test/unit/client/context-menu/menu-defs.test.ts` with outdated function names (`copyFreshclaude*` instead of `copyAgentChat*`). Use the `test/unit/client/components/context-menu/` version.

**Important pre-existing issue:** The `createMockActions()` function in this test file is already missing 6 actions that exist in the current `MenuActions` type: `refreshTab`, `reopenClosedTab`, `refreshPane`, `replacePane`, `generateSessionTitle`, `showKeyboardShortcuts`. These were added after the test was written. When adding the 4 new URL actions (`openUrlInPane`, `openUrlInTab`, `openUrlInBrowser`, `copyUrl`), also add the 6 missing pre-existing actions to bring the mock fully in sync with the `MenuActions` type. The `createMockContext()` is also missing the `aiEnabled` field (should be `aiEnabled: false`).

Add tests for the terminal context target with `hoveredUrl`:
- When `hoveredUrl` is set, URL-specific menu items appear at the top
- When `hoveredUrl` is not set, no URL items appear
- Each URL menu item calls the correct action with the correct URL

**File: `test/unit/client/components/context-menu/context-menu-utils.test.ts`** (new -- no existing test for this util)

Test that `parseContextTarget` for Terminal correctly extracts `hoveredUrl` from dataset.

### Phase 5: Hover State Cleanup and Edge Cases

1. **Terminal dispose cleanup**: When the terminal is disposed (component unmount), `clearHoveredUrl(paneId)` must be called AND `delete wrapperRef.current.dataset.hoveredUrl` must be called. Add both to the existing cleanup function in TerminalView (approx line 1197, inside the `return () => { ... }` block). Also dispose the new URL link provider disposable.

2. **Tab switch / hidden state**: When a terminal tab becomes hidden, the hover state should be cleared (the mouse is no longer over it). The existing `hiddenRef.current = hidden` effect (line 404-406) is a good place to add `clearHoveredUrl(paneId)` when `hidden` becomes true.

3. **Multiple terminals**: Each terminal pane has its own paneId, so hover states are independent. The context menu reads from the correct pane's wrapper div.

4. **OSC 8 vs custom link provider priority**: xterm.js checks OSC 8 links first, then registered link providers in reverse order (last registered = highest priority). Our custom URL link provider should be registered BEFORE the file path provider (currently at line 1044) so file paths get higher priority. However, the URL regex should not match file paths (no `http://` prefix), so overlap is unlikely. Concretely: insert the URL provider registration between `term.open(containerRef.current)` (line 1040) and the file path provider (line 1044).

5. **Data attribute cleanup on leave**: The `leave` callback must always clear the `data-hovered-url` attribute. If the user right-clicks while hovering a link and then moves the mouse away before the context menu renders, the attribute should already be set at the time of the `contextmenu` event because `leave` fires after the mouse moves off the link, not when the context menu opens.

### Phase 6: Refactor and Polish

After all tests pass, evaluate:
- Whether `terminal-hovered-url.ts` should be merged into `pane-action-registry.ts` or kept separate
- Whether the URL link provider logic should be extracted into its own file (similar to how file path links use `findLocalFilePaths` from `path-utils.ts`)
- Whether the `findUrls` utility belongs in `path-utils.ts` or its own file

**Update `docs/index.html`**: Per repo rules, update the docs mock to reflect the new clickable URL feature (URL context menu items in terminal panes). This is a significant user-facing UX change.

---

## File Change Summary

### New Files
- `src/lib/terminal-hovered-url.ts` -- Hover state tracking map
- `src/lib/url-utils.ts` -- URL detection in terminal text
- `test/unit/client/lib/terminal-hovered-url.test.ts`
- `test/unit/client/lib/url-utils.test.ts`
- `test/unit/client/components/TerminalView.urlClick.test.tsx`
- `test/unit/client/components/context-menu/context-menu-utils.test.ts`

### Modified Files
- `src/components/TerminalView.tsx` -- linkHandler hover/leave, URL link provider, left-click behavior change, data attribute, wrapperRef
- `src/components/context-menu/context-menu-types.ts` -- Add hoveredUrl to terminal target
- `src/components/context-menu/context-menu-constants.ts` -- No changes needed (Terminal context ID already exists)
- `src/components/context-menu/context-menu-utils.ts` -- Parse hoveredUrl from dataset
- `src/components/context-menu/menu-defs.ts` -- URL menu items, new MenuActions (4 new action signatures)
- `src/components/context-menu/ContextMenuProvider.tsx` -- New action implementations + useMemo dependency array update
- `test/unit/client/components/TerminalView.linkWarning.test.tsx` -- Update assertions for splitPane instead of window.open
- `test/unit/client/components/TerminalView.keyboard.test.tsx` -- Update registerLinkProvider mock to handle two providers
- `test/unit/client/components/context-menu/menu-defs.test.ts` -- Add URL menu item tests + new mock actions

### Unchanged
- `src/store/panesSlice.ts` -- Already has splitPane with browser content support
- `src/store/paneTypes.ts` -- BrowserPaneContent already exists
- `src/components/panes/BrowserPane.tsx` -- No changes needed

---

## Execution Order

1. Red: Write `terminal-hovered-url.test.ts` and `url-utils.test.ts` (new utility tests)
2. Green: Implement `terminal-hovered-url.ts` and `url-utils.ts`
3. Red: Write `TerminalView.urlClick.test.tsx` (left-click opens browser pane)
4. Green: Update `TerminalView.tsx` linkHandler activate/hover/leave and URL link provider
5. Red: Update `TerminalView.linkWarning.test.tsx` (assertions change from window.open to splitPane)
6. Green: Update TerminalView.tsx confirm handler
7. Red: Write context menu tests (menu-defs with hoveredUrl, parseContextTarget)
8. Green: Update context-menu-types, context-menu-utils, menu-defs, ContextMenuProvider
9. Refactor: Clean up, extract shared patterns, review naming
10. Full test suite run to verify no regressions

## Risk Assessment

- **Low risk**: The hover state tracking is purely additive and non-breaking.
- **Medium risk**: Changing left-click behavior from `window.open` to splitPane changes existing UX. Mitigated by keeping the warning modal flow unchanged (just different confirm action).
- **Low risk**: Context menu additions are purely additive to the existing terminal menu.
- **Note**: The custom URL link provider (for non-OSC-8 URLs) overlaps with xterm.js's built-in URL detection. If xterm already detects and underlines URLs via its default link provider, our custom provider may create duplicate links. Need to verify xterm's default behavior -- if it already has a built-in web link matcher, we may only need the hover/leave callbacks on the existing `linkHandler` (for OSC 8) without adding a new `registerLinkProvider` for plain URLs. The built-in web link matcher in xterm.js is actually provided by `@xterm/addon-web-links`, which is not currently used (verified by grep). So we do need our own URL link provider.
