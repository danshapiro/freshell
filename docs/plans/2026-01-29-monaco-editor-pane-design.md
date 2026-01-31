# Monaco Editor Pane Design

## Overview

Add a Monaco-based editor pane type to Freshell, alongside existing terminal and browser panes. The editor supports file editing, scratch pads, and read-only viewing with special handling for markdown and HTML files.

## Content Model

```typescript
type EditorPaneContent = {
  kind: 'editor'
  filePath: string | null      // null = scratch pad mode
  language: string | null      // auto-detect from extension, or explicit
  readOnly: boolean
  content: string              // current buffer
  viewMode: 'source' | 'preview'  // persisted toggle state
}
```

### Modes

| Mode | Condition |
|------|-----------|
| Scratch pad | `filePath === null` |
| File editing | `filePath !== null && readOnly === false` |
| Read-only | `readOnly === true` |

### View Mode by File Type

| Extension | Default `viewMode` | Preview renders as |
|-----------|-------------------|-------------------|
| `.md` | `'preview'` | Rendered markdown |
| `.htm`, `.html` | `'preview'` | iframe |
| All others | `'source'` | N/A (toggle hidden) |

## Server API

Three new REST endpoints under `/api/files`:

### GET `/api/files/read?path=<absolute-path>`

- Returns: `{ content: string, size: number, modifiedAt: string }`
- Errors: 404 if not found, 403 if restricted path

### POST `/api/files/write`

- Body: `{ path: string, content: string }`
- Returns: `{ success: true, modifiedAt: string }`
- Creates parent directories if needed
- Errors: 403 if read-only or restricted path

### GET `/api/files/complete?prefix=<partial-path>`

- Returns: `{ suggestions: Array<{ path: string, isDirectory: boolean }> }`
- Up to 20 matches, directories first
- Handles absolute and relative paths

All endpoints use existing auth token validation.

## File Selection UI

### Path Input with Autocomplete

- Text input in toolbar
- Server queries for path completions as user types (debounced)
- Supports absolute paths and paths relative to default root

### Native File Picker Button

- Finder icon next to path input
- Opens `showOpenFilePicker()` for visual selection
- Works when browser runs on same machine as server
- Graceful fallback message if API unavailable

### Default Browse Root

When no path entered, autocomplete uses the cwd of the first terminal in the tab:
- Depth-first traversal of pane layout tree
- First `kind: 'terminal'` pane with a `terminalId`
- Look up that terminal's current cwd from state
- Fall back to server's default cwd if no terminal found

## Component Structure

### New Files

| File | Purpose |
|------|---------|
| `src/components/panes/EditorPane.tsx` | Main component - toolbar, Monaco/preview, file picker |
| `src/components/panes/EditorToolbar.tsx` | Path input, autocomplete, picker button, view toggle |
| `src/components/panes/MarkdownPreview.tsx` | Renders markdown using `react-markdown` |

### Layout

```
┌─────────────────────────────────────────────────┐
│ [📁] [________________________] [👁️/</> toggle] │  ← Toolbar
├─────────────────────────────────────────────────┤
│                                                 │
│           Monaco Editor (source mode)           │
│                  - or -                         │
│        MarkdownPreview / iframe (preview)       │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Empty State

- Centered "Open File" button + "or start typing" hint
- Clicking button focuses the path input

### View Toggle

- Toggle button with `Eye` / `Code` icons
- Only visible for `.md` and `.html` files
- Switches between source and preview modes

## Auto-Save Behavior

- 5-second debounce after edits
- No dirty/unsaved indicator - saves happen silently
- Disabled for scratch pads (`filePath === null`)
- Works regardless of view mode (edits only happen in source mode)

## Integration Points

### Files to Modify

| File | Changes |
|------|---------|
| `src/store/paneTypes.ts` | Add `EditorPaneContent`, update `PaneContent` union |
| `src/store/panesSlice.ts` | Update `normalizeContent()` to handle editor type |
| `src/components/panes/PaneContainer.tsx` | Add editor case to `renderContent()` |
| `src/components/panes/PaneLayout.tsx` | Add `handleAddEditor` callback |
| `src/components/FloatingActionButton.tsx` | Add "Editor" menu item |

## Dependencies

New packages to install:

- `@monaco-editor/react` - React wrapper for Monaco
- `react-markdown` - Markdown rendering
- `remark-gfm` - GitHub-flavored markdown support

## Testing Strategy

### Unit Tests

| Test file | Coverage |
|-----------|----------|
| `test/unit/server/files-api.test.ts` | Read, write, complete endpoints |
| `test/unit/client/panesSlice.test.ts` | Editor content type normalization |
| `test/unit/client/EditorPane.test.ts` | Component rendering, mode switching |
| `test/unit/client/EditorToolbar.test.ts` | Autocomplete, file picker |

### Integration Tests

| Test file | Coverage |
|-----------|----------|
| `test/integration/files-api.test.ts` | Real filesystem operations |
| `test/integration/editor-pane.test.ts` | Full open → edit → save flow |

### Key Scenarios

- Path autocomplete returns correct suggestions
- Markdown files default to preview mode, toggle works
- HTML files render in iframe, toggle to source works
- Auto-save triggers after 5s debounce
- Scratch pad mode doesn't attempt save
- Default browse root inherits from terminal cwd
- Native file picker fallback when API unavailable

## Implementation Phases

### Phase 1 - Foundation

1. Add `EditorPaneContent` type to `paneTypes.ts`
2. Server endpoints: read, write, complete
3. Tests for all endpoints

### Phase 2 - Basic Editor

4. Install Monaco dependencies
5. Create `EditorPane.tsx` with Monaco integration
6. Wire up rendering in `PaneContainer.tsx`
7. Add to FAB menu
8. Tests for basic open/edit flow

### Phase 3 - File Selection

9. `EditorToolbar.tsx` with path input and autocomplete
10. Native file picker integration
11. Terminal cwd detection for default root
12. Tests for file selection flows

### Phase 4 - Preview & Polish

13. `MarkdownPreview.tsx` component
14. HTML iframe preview mode
15. View mode toggle (source/preview)
16. Auto-save with 5s debounce
17. Integration tests for full flows
