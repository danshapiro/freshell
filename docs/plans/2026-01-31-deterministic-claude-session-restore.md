# Deterministic Claude Session Restore Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure Claude terminal panes resume deterministically using only known, valid session IDs discovered from Claude sessions, while keeping legacy paths and session repair aligned.

**Architecture:** New Claude panes start without a resume ID; pane content stores `resumeSessionId` only when known (legacy tab seed or indexer association), and tab-level IDs are compatibility-only. The server validates UUIDs before storing or passing `--resume` (TerminalRegistry + ClaudeSession), skips resume entirely when scans are missing to avoid CLI errors, and echoes the effective ID in `terminal.created`. The indexer canonicalizes **valid UUID** session IDs from JSONL (fallback to filename when valid) and maintains filePath<->sessionId mapping so refresh/incremental/remove and session repair (via `CLAUDE_HOME`) stay consistent.

**Tech Stack:** TypeScript, React/Redux Toolkit, Node/Express, WebSocket (ws), Vitest

---

## Prerequisites

### Task 0: Validate Claude CLI Resume Contract (manual) -- completed 2026-02-01

**Goal:** Determine how `claude --resume <id>` behaves before coding around it.

**Manual Steps (for reproducibility):**
1. Run `claude --resume nonexistent-uuid-12345` in a clean directory.
2. Observe whether it:
   - Errors out
   - Creates a session with **that exact ID**
   - Creates a session with a **different** ID
3. Locate the resulting JSONL in `CLAUDE_HOME/projects/*/*.jsonl` (or `~/.claude/projects`).
4. Inspect the first few lines to see embedded `sessionId/session_id` and note accepted formats (UUID, length/charset).

**Findings (2026-02-01):**
- `claude --resume` **requires a UUID format**; non-UUID values error with "session IDs must be UUIDs".
- For a **valid UUID that does not exist**, `claude -p "ping" --resume <uuid>` returns "No conversation found with session ID: <uuid>".
- No JSONL is created in the missing case; **CLI does not create-if-missing**.

**Plan impact:** Do **not** pre-assign resume IDs. Only pass `--resume` for known, valid UUIDs and skip resume when scans are missing to avoid CLI errors.

---

### Task 1: Add Claude session ID validation helper (UUID-only) on the server

**Files:**
- Create: `server/claude-session-id.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/claude-session.ts`
- Test: `test/unit/server/terminal-registry.test.ts`
- Test: `test/unit/server/claude-session.test.ts`

**Step 1: Write the failing tests**

Add near the top of `test/unit/server/terminal-registry.test.ts`:

```ts
import { isValidClaudeSessionId } from '../../../server/claude-session-id.js'
```

Add tests (near other helper tests):

```ts
describe('isValidClaudeSessionId', () => {
  it('accepts UUID strings', () => {
    expect(isValidClaudeSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })

  it('rejects non-UUID values', () => {
    expect(isValidClaudeSessionId('nanoid-123')).toBe(false)
    expect(isValidClaudeSessionId('')).toBe(false)
  })
})

it('omits --resume when resumeSessionId is invalid (non-windows)', () => {
  const spec = buildSpawnSpec('claude', undefined, 'system', 'not-a-uuid')
  expect(spec.args).not.toContain('--resume')
})

it('includes --resume when resumeSessionId is valid (non-windows)', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000'
  const spec = buildSpawnSpec('claude', undefined, 'system', id)
  expect(spec.args).toContain('--resume')
  expect(spec.args).toContain(id)
})

describe('buildSpawnSpec resume validation on Windows shells', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
  })

  it('omits --resume in cmd.exe string when invalid', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.WINDOWS_SHELL = 'cmd'
    const spec = buildSpawnSpec('claude', 'C:\\tmp', 'system', 'not-a-uuid')
    expect(spec.args.join(' ')).not.toContain('--resume')
  })

  it('omits --resume in PowerShell command when invalid', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.WINDOWS_SHELL = 'powershell'
    const spec = buildSpawnSpec('claude', 'C:\\tmp', 'system', 'not-a-uuid')
    expect(spec.args.join(' ')).not.toContain('--resume')
  })

  it('omits --resume in WSL args when invalid', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.WINDOWS_SHELL = 'wsl'
    const spec = buildSpawnSpec('claude', '/home/user', 'system', 'not-a-uuid')
    expect(spec.args).not.toContain('--resume')
  })
})
```

Add tests in `test/unit/server/claude-session.test.ts`:

```ts
it('skips --resume when resumeSessionId is invalid', () => {
  const spawn = vi.fn(() => ({ stdout: null, stderr: null, on: vi.fn() }))
  new ClaudeSession({ prompt: 'ping', resumeSessionId: 'not-a-uuid', _spawn: spawn })
  const args = spawn.mock.calls[0][1]
  expect(args).not.toContain('--resume')
})

it('includes --resume when resumeSessionId is valid', () => {
  const spawn = vi.fn(() => ({ stdout: null, stderr: null, on: vi.fn() }))
  const id = '550e8400-e29b-41d4-a716-446655440000'
  new ClaudeSession({ prompt: 'ping', resumeSessionId: id, _spawn: spawn })
  const args = spawn.mock.calls[0][1]
  expect(args).toContain('--resume')
  expect(args).toContain(id)
})
```

**Step 2: Run test to verify it fails**

Run:
- `CI=true npm test -- test/unit/server/terminal-registry.test.ts -t "resume"`
- `CI=true npm test -- test/unit/server/claude-session.test.ts -t "resumeSessionId"`
Expected: FAIL (missing helper + invalid resume still included in command paths)

**Step 3: Write minimal implementation**

Create `server/claude-session-id.ts`:

```ts
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidClaudeSessionId(value?: string): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value)
}
```

Update `server/terminal-registry.ts` to guard all resume paths (WSL args, cmd.exe string, PowerShell command, non-Windows args):

```ts
import { isValidClaudeSessionId } from './claude-session-id.js'

const validResume = mode === 'claude' && isValidClaudeSessionId(resumeSessionId)
if (mode === 'claude' && resumeSessionId && !validResume) {
  logger.warn({ resumeSessionId }, 'Ignoring invalid Claude resumeSessionId')
}

if (validResume) cmdArgs.push('--resume', resumeSessionId!)
```

Apply `validResume` to every `--resume` construction in this file (string commands and arg arrays).

When constructing the `TerminalRecord`, store only validated IDs:

```ts
const normalizedResume = validResume ? resumeSessionId : undefined
...
resumeSessionId: normalizedResume,
```

Update `server/claude-session.ts` to guard resume there as well:

```ts
import { isValidClaudeSessionId } from './claude-session-id.js'

if (options.resumeSessionId && !isValidClaudeSessionId(options.resumeSessionId)) {
  logger.warn({ resumeSessionId: options.resumeSessionId }, 'Ignoring invalid Claude resumeSessionId')
} else if (options.resumeSessionId) {
  args.push('--resume', options.resumeSessionId)
}
```

**Step 4: Run test to verify it passes**

Run:
- `CI=true npm test -- test/unit/server/terminal-registry.test.ts -t "resume"`
- `CI=true npm test -- test/unit/server/claude-session.test.ts -t "resumeSessionId"`
Expected: PASS

**Step 5: Commit**

```bash
git add server/claude-session-id.ts server/terminal-registry.ts server/claude-session.ts test/unit/server/terminal-registry.test.ts test/unit/server/claude-session.test.ts
git commit -m "fix(server): validate claude resume session ids"
```

---

### Task 2: Ensure new panes do NOT auto-assign resumeSessionId and drop invalid IDs

**Rationale:** The CLI only accepts known UUIDs; new panes must start without resume IDs and ignore invalid values.

**Files:**
- Create: `src/lib/claude-session-id.ts`
- Modify: `src/store/panesSlice.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/lib/claude-session-id.test.ts`

**Step 1: Write the failing tests**

Remove any `vi.mock('@/lib/claude-session-id', ...)` from `test/unit/client/store/panesSlice.test.ts` if present.

Add a new test file `test/unit/client/lib/claude-session-id.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isValidClaudeSessionId } from '../../../../src/lib/claude-session-id'

describe('isValidClaudeSessionId', () => {
  it('accepts UUIDs and rejects non-UUIDs', () => {
    expect(isValidClaudeSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isValidClaudeSessionId('not-a-uuid')).toBe(false)
    expect(isValidClaudeSessionId('')).toBe(false)
  })
})
```

Add tests to `test/unit/client/store/panesSlice.test.ts`:

```ts
it('does not auto-assign resumeSessionId for claude panes in initLayout', () => {
  const state = panesReducer(
    initialState,
    initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'claude' } })
  )

  const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  expect(leaf.content.kind).toBe('terminal')
  if (leaf.content.kind === 'terminal') {
    expect(leaf.content.resumeSessionId).toBeUndefined()
  }
})

it('preserves existing resumeSessionId for claude panes', () => {
  const state = panesReducer(
    initialState,
    initLayout({
      tabId: 'tab-1',
      content: { kind: 'terminal', mode: 'claude', resumeSessionId: '550e8400-e29b-41d4-a716-446655440000' },
    })
  )

  const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  if (leaf.content.kind === 'terminal') {
    expect(leaf.content.resumeSessionId).toBe('550e8400-e29b-41d4-a716-446655440000')
  }
})

it('does not assign resumeSessionId for shell panes', () => {
  const state = panesReducer(
    initialState,
    initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
  )

  const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  if (leaf.content.kind === 'terminal') {
    expect(leaf.content.resumeSessionId).toBeUndefined()
  }
})

it('does not auto-assign resumeSessionId for claude panes created by splitPane', () => {
  let state = panesReducer(
    initialState,
    initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
  )
  const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

  state = panesReducer(
    state,
    splitPane({
      tabId: 'tab-1',
      paneId: originalPaneId,
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'claude' },
    })
  )

  const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
  const claudeLeaf = split.children[1] as Extract<PaneNode, { type: 'leaf' }>
  if (claudeLeaf.content.kind === 'terminal') {
    expect(claudeLeaf.content.resumeSessionId).toBeUndefined()
  }
})

it('drops invalid resumeSessionId for claude panes', () => {
  const state = panesReducer(
    initialState,
    initLayout({
      tabId: 'tab-1',
      content: { kind: 'terminal', mode: 'claude', resumeSessionId: 'not-a-uuid' },
    })
  )

  const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  if (leaf.content.kind === 'terminal') {
    expect(leaf.content.resumeSessionId).toBeUndefined()
  }
})
```

**Step 2: Run test to verify it fails**

Run:
- `CI=true npm test -- test/unit/client/lib/claude-session-id.test.ts`
- `CI=true npm test -- test/unit/client/store/panesSlice.test.ts -t "resumeSessionId"`
Expected: FAIL

**Step 3: Write minimal implementation**

Create `src/lib/claude-session-id.ts`:

```ts
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidClaudeSessionId(value?: string): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value)
}
```

Update `normalizeContent` in `src/store/panesSlice.ts`:

```ts
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

const mode = input.mode || 'shell'
const resumeSessionId =
  mode === 'claude' && isValidClaudeSessionId(input.resumeSessionId)
    ? input.resumeSessionId
    : undefined

return {
  kind: 'terminal',
  terminalId: input.terminalId,
  createRequestId: input.createRequestId || nanoid(),
  status: input.status || 'creating',
  mode,
  shell: input.shell || 'system',
  resumeSessionId,
  initialCwd: input.initialCwd,
}
```

**Step 4: Run test to verify it passes**

Run:
- `CI=true npm test -- test/unit/client/lib/claude-session-id.test.ts`
- `CI=true npm test -- test/unit/client/store/panesSlice.test.ts -t "resumeSessionId"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/claude-session-id.ts src/store/panesSlice.ts test/unit/client/store/panesSlice.test.ts test/unit/client/lib/claude-session-id.test.ts
git commit -m "fix(client): validate and avoid auto-assigning claude resumeSessionId"
```

---

### Task 3: Migrate legacy tab resumeSessionId into Claude panes on load (validated)

**Rationale:** Existing users may have `tab.resumeSessionId` persisted but pane content lacks it. We need a best-effort migration during pane state initialization that only targets valid UUIDs and Claude panes.

**Files:**
- Modify: `src/store/panesSlice.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`

**Step 1: Write the failing tests**

Add tests near the end of `test/unit/client/store/panesPersistence.test.ts`:

```ts
it('migrates tab resumeSessionId into the active claude pane when panes load without it', async () => {
  localStorage.setItem('freshell.tabs.v1', JSON.stringify({
    tabs: {
      tabs: [
        { id: 'tab-1', mode: 'claude', resumeSessionId: '550e8400-e29b-41d4-a716-446655440000', status: 'running', title: 'Claude', createRequestId: 'tab-1' },
      ],
      activeTabId: 'tab-1',
    },
  }))

  localStorage.setItem('freshell.panes.v1', JSON.stringify({
    version: 3,
    layouts: {
      'tab-1': {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-1', status: 'running' },
      },
    },
    activePane: { 'tab-1': 'pane-1' },
    paneTitles: {},
  }))

  vi.resetModules()
  const panesReducer = (await import('../../../../src/store/panesSlice')).default
  const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  const layout = store.getState().panes.layouts['tab-1'] as any
  expect(layout.content.resumeSessionId).toBe('550e8400-e29b-41d4-a716-446655440000')
})

it('does not migrate resumeSessionId into non-claude panes', async () => {
  localStorage.setItem('freshell.tabs.v1', JSON.stringify({
    tabs: {
      tabs: [
        { id: 'tab-1', mode: 'claude', resumeSessionId: '550e8400-e29b-41d4-a716-446655440000', status: 'running', title: 'Claude', createRequestId: 'tab-1' },
      ],
      activeTabId: 'tab-1',
    },
  }))

  localStorage.setItem('freshell.panes.v1', JSON.stringify({
    version: 3,
    layouts: {
      'tab-1': {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' },
      },
    },
    activePane: { 'tab-1': 'pane-1' },
    paneTitles: {},
  }))

  vi.resetModules()
  const panesReducer = (await import('../../../../src/store/panesSlice')).default
  const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  const layout = store.getState().panes.layouts['tab-1'] as any
  expect(layout.content.resumeSessionId).toBeUndefined()
})

it('migrates resumeSessionId to the first claude pane when active pane is shell', async () => {
  localStorage.setItem('freshell.tabs.v1', JSON.stringify({
    tabs: {
      tabs: [
        { id: 'tab-1', mode: 'claude', resumeSessionId: '550e8400-e29b-41d4-a716-446655440000', status: 'running', title: 'Claude', createRequestId: 'tab-1' },
      ],
      activeTabId: 'tab-1',
    },
  }))

  localStorage.setItem('freshell.panes.v1', JSON.stringify({
    version: 3,
    layouts: {
      'tab-1': {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-shell', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shell', status: 'running' } },
          { type: 'leaf', id: 'pane-claude', content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-claude', status: 'running' } },
        ],
      },
    },
    activePane: { 'tab-1': 'pane-shell' },
    paneTitles: {},
  }))

  vi.resetModules()
  const panesReducer = (await import('../../../../src/store/panesSlice')).default
  const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  const layout = store.getState().panes.layouts['tab-1'] as any
  expect(layout.children[1].content.resumeSessionId).toBe('550e8400-e29b-41d4-a716-446655440000')
})

it('skips migration when resumeSessionId is invalid', async () => {
  localStorage.setItem('freshell.tabs.v1', JSON.stringify({
    tabs: {
      tabs: [
        { id: 'tab-1', mode: 'claude', resumeSessionId: 'not-a-uuid', status: 'running', title: 'Claude', createRequestId: 'tab-1' },
      ],
      activeTabId: 'tab-1',
    },
  }))

  localStorage.setItem('freshell.panes.v1', JSON.stringify({
    version: 3,
    layouts: {
      'tab-1': {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-1', status: 'running' },
      },
    },
    activePane: { 'tab-1': 'pane-1' },
    paneTitles: {},
  }))

  vi.resetModules()
  const panesReducer = (await import('../../../../src/store/panesSlice')).default
  const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  const layout = store.getState().panes.layouts['tab-1'] as any
  expect(layout.content.resumeSessionId).toBeUndefined()
})
```

**Step 2: Run test to verify it fails**

Run: `CI=true npm test -- test/unit/client/store/panesPersistence.test.ts -t "migrates tab resumeSessionId"`
Expected: FAIL

**Step 3: Write minimal implementation**

In `src/store/panesSlice.ts`, extend `loadInitialPanesState()` with a migration helper that only targets valid IDs and Claude panes:

```ts
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

function applyLegacyResumeSessionIds(state: PanesState): PanesState {
  if (typeof localStorage === 'undefined') return state
  const rawTabs = localStorage.getItem('freshell.tabs.v1')
  if (!rawTabs) return state

  let parsedTabs: any
  try {
    parsedTabs = JSON.parse(rawTabs)
  } catch {
    return state
  }

  const tabsState = parsedTabs?.tabs
  if (!tabsState?.tabs) return state

  const resumeByTabId = new Map<string, string>()
  for (const tab of tabsState.tabs) {
    if (isValidClaudeSessionId(tab?.resumeSessionId)) {
      resumeByTabId.set(tab.id, tab.resumeSessionId)
    }
  }

  const nextLayouts: Record<string, PaneNode> = {}
  let changed = false

  const findLeaf = (node: PaneNode, targetId: string): Extract<PaneNode, { type: 'leaf' }> | null => {
    if (node.type === 'leaf') return node.id === targetId ? node : null
    return findLeaf(node.children[0], targetId) || findLeaf(node.children[1], targetId)
  }

  const findFirstClaudeLeaf = (node: PaneNode): Extract<PaneNode, { type: 'leaf' }> | null => {
    if (node.type === 'leaf') {
      if (node.content.kind === 'terminal' && node.content.mode === 'claude') return node
      return null
    }
    return findFirstClaudeLeaf(node.children[0]) || findFirstClaudeLeaf(node.children[1])
  }

  const assignToTarget = (node: PaneNode, targetId: string, resumeSessionId: string): PaneNode => {
    if (node.type === 'leaf') {
      if (node.id !== targetId) return node
      if (node.content.kind !== 'terminal' || node.content.mode !== 'claude') return node
      if (node.content.resumeSessionId) return node
      changed = true
      return { ...node, content: { ...node.content, resumeSessionId } }
    }

    const left = assignToTarget(node.children[0], targetId, resumeSessionId)
    const right = assignToTarget(node.children[1], targetId, resumeSessionId)
    if (left === node.children[0] && right === node.children[1]) return node
    return { ...node, children: [left, right] }
  }

  for (const [tabId, node] of Object.entries(state.layouts)) {
    const resume = resumeByTabId.get(tabId)
    if (!resume) {
      nextLayouts[tabId] = node as PaneNode
      continue
    }

    const activeId = state.activePane[tabId]
    const activeLeaf = activeId ? findLeaf(node as PaneNode, activeId) : null
    const targetLeaf =
      activeLeaf && activeLeaf.content.kind === 'terminal' && activeLeaf.content.mode === 'claude'
        ? activeLeaf
        : findFirstClaudeLeaf(node as PaneNode)

    if (!targetLeaf) {
      nextLayouts[tabId] = node as PaneNode
      continue
    }

    nextLayouts[tabId] = assignToTarget(node as PaneNode, targetLeaf.id, resume)
  }

  return changed ? { ...state, layouts: nextLayouts } : state
}
```

Call it inside `loadInitialPanesState()` right before returning the parsed state.

**Step 4: Run test to verify it passes**

Run: `CI=true npm test -- test/unit/client/store/panesPersistence.test.ts -t "migrates tab resumeSessionId"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/store/panesSlice.ts test/unit/client/store/panesPersistence.test.ts
git commit -m "fix(client): migrate legacy tab resumeSessionId into claude panes"
```

---

### Task 4: Add pane-based session helpers and update sidebar selectors (filter invalid IDs)

**Rationale:** UI and sidebar must track sessions based on pane content, not tab-level fields, and ignore invalid IDs.

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`
- Test: `test/unit/client/components/Sidebar.test.tsx`

**Step 1: Write failing tests (session-utils + Sidebar behavior)**

Add a new test file `test/unit/client/lib/session-utils.test.ts`:
- `getSessionsForHello` returns `active/visible/background` based on **pane** content (no `tab.resumeSessionId` dependency).
- Invalid/non-UUID IDs are filtered from all buckets.
- Non-claude terminal panes are ignored.

Update `test/unit/client/components/Sidebar.test.tsx` to ensure session tabs are detected from panes, not `tab.resumeSessionId`.

Add a test case where the tab has **no** `resumeSessionId`, but pane content does, and verify that the sidebar treats it as an open session (hasTab=true, active highlighting, etc). Create a minimal tab + pane layout in test state for this case.

Add a test case with an **invalid** `resumeSessionId` in a pane and verify it does **not** produce a session item or hasTab state.

Add a selector test in `test/unit/client/store/selectors/sidebarSelectors.test.ts` that verifies activity sorting uses `sessionActivity` (ratcheted) ordering, not `tab.lastInputAt`.

**Step 2: Run test to verify it fails**

Run:
- `CI=true npm test -- test/unit/client/lib/session-utils.test.ts -t "getSessionsForHello"`
- `CI=true npm test -- test/unit/client/components/Sidebar.test.tsx -t "pane resumeSessionId"`
- `CI=true npm test -- test/unit/client/store/selectors/sidebarSelectors.test.ts -t "activity sort"`
Expected: FAIL (session-utils + sidebar still use tab.resumeSessionId / unfiltered IDs)

**Step 3: Add pane-based helpers**

Update `src/lib/session-utils.ts` to export pane-level helpers and filter invalid IDs:

```ts
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

export function collectSessionIdsFromNode(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    const content = node.content
    if (
      content.kind === 'terminal' &&
      content.mode === 'claude' &&
      isValidClaudeSessionId(content.resumeSessionId)
    ) {
      return [content.resumeSessionId]
    }
    return []
  }
  return [
    ...collectSessionIdsFromNode(node.children[0]),
    ...collectSessionIdsFromNode(node.children[1]),
  ]
}

export function getActiveSessionIdForTab(state: RootState, tabId: string): string | undefined {
  const layout = state.panes.layouts[tabId]
  if (!layout) return undefined
  const activePaneId = state.panes.activePane[tabId]
  if (!activePaneId) return undefined

  const findLeaf = (node: PaneNode): PaneNode | null => {
    if (node.type === 'leaf') return node.id === activePaneId ? node : null
    return findLeaf(node.children[0]) || findLeaf(node.children[1])
  }

  const leaf = findLeaf(layout)
  if (leaf?.type === 'leaf' && leaf.content.kind === 'terminal' && leaf.content.mode === 'claude') {
    return isValidClaudeSessionId(leaf.content.resumeSessionId) ? leaf.content.resumeSessionId : undefined
  }
  return undefined
}

export function getTabSessionIds(state: RootState, tabId: string): string[] {
  const layout = state.panes.layouts[tabId]
  if (!layout) return []
  return collectSessionIdsFromNode(layout)
}

export function findTabIdForSession(state: RootState, sessionId: string): string | undefined {
  for (const tab of state.tabs.tabs) {
    const ids = getTabSessionIds(state, tab.id)
    if (ids.includes(sessionId)) return tab.id
  }
  return undefined
}
```

Update `getSessionsForHello` in the same file to use `collectSessionIdsFromNode` + `getActiveSessionIdForTab`, so it only emits valid UUIDs from Claude panes.

**Step 4: Update sidebar selectors to use panes and session activity**

In `src/store/selectors/sidebarSelectors.ts`:
- Add `selectPanes` selector.
- Update `buildSessionItems` to accept panes and use `collectSessionIdsFromNode` (from session-utils) to build `tabSessionMap` (hasTab only).
- Use `sessionActivity` (ratcheted) for activity sort instead of `tab.lastInputAt`.
- Remove `tabLastInputAt` from `SidebarSessionItem` and update sort logic accordingly.
- Update `makeSelectSortedSessionItems` to include panes in the selector dependency list.

Example change:

```ts
const selectPanes = (state: RootState) => state.panes

function buildSessionItems(
  projects: RootState['sessions']['projects'],
  tabs: RootState['tabs']['tabs'],
  panes: RootState['panes'],
  terminals: BackgroundTerminal[],
  sessionActivity: Record<string, number>
): SidebarSessionItem[] {
  ...
  for (const tab of tabs || []) {
    const layout = panes.layouts[tab.id]
    if (!layout) continue
    const sessionIds = collectSessionIdsFromNode(layout)
    for (const sessionId of sessionIds) {
      tabSessionMap.set(sessionId, { hasTab: true })
    }
  }
  ...
}

export const makeSelectSortedSessionItems = () =>
  createSelector(
    [selectProjects, selectTabs, selectPanes, selectSessionActivityForSort, selectSortMode, selectTerminals, selectFilter],
    (projects, tabs, panes, sessionActivity, sortMode, terminals, filter) => {
      const items = buildSessionItems(projects, tabs, panes, terminals, sessionActivity)
      ...
    }
  )
```

**Step 5: Run tests to verify pass**

Run:
- `CI=true npm test -- test/unit/client/lib/session-utils.test.ts -t "getSessionsForHello"`
- `CI=true npm test -- test/unit/client/components/Sidebar.test.tsx -t "pane resumeSessionId"`
- `CI=true npm test -- test/unit/client/store/selectors/sidebarSelectors.test.ts -t "activity sort"`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/session-utils.ts src/store/selectors/sidebarSelectors.ts test/unit/client/lib/session-utils.test.ts test/unit/client/components/Sidebar.test.tsx
git commit -m "refactor(client): derive sidebar session state from panes"
```

---

### Task 5: Centralize session-open dedupe across entry points

**Rationale:** Dedupe must not depend on Sidebar-only logic. HistoryView and future entry points should use a shared thunk that checks pane state.

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/types.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/unit/client/store/tabsSlice.test.ts`

**Step 1: Write failing tests**

Add tests to `test/unit/client/store/tabsSlice.test.ts` to cover a new thunk `openClaudeSessionTab`:
- When a pane already owns the sessionId, it dispatches `setActiveTab` without creating a new tab.
- When no pane owns the sessionId, it dispatches `addTab` with `resumeSessionId`.

Update Sidebar tests to assert:
- Clicking a session with an **existing pane session** activates that tab (even if `tab.resumeSessionId` is undefined).
- Clicking a session when **no pane** matches creates a new tab (as before).

**Step 2: Run tests to verify they fail**

Run:
- `CI=true npm test -- test/unit/client/components/Sidebar.test.tsx -t "activates existing tab"`
- `CI=true npm test -- test/unit/client/store/tabsSlice.test.ts -t "openClaudeSessionTab"`
Expected: FAIL

**Step 3: Add a shared thunk in tabsSlice**

In `src/store/tabsSlice.ts`, add a thunk that consults pane state and reuses existing tabs:

```ts
import { findTabIdForSession } from '@/lib/session-utils'
import type { RootState } from './store'

export const openClaudeSessionTab = createAsyncThunk(
  'tabs/openClaudeSessionTab',
  async (
    { sessionId, title, cwd }: { sessionId: string; title?: string; cwd?: string },
    { dispatch, getState }
  ) => {
    const state = getState() as RootState
    const existingTabId = findTabIdForSession(state, sessionId)
    if (existingTabId) {
      dispatch(setActiveTab(existingTabId))
      return
    }
    dispatch(addTab({ title: title || 'Claude', mode: 'claude', initialCwd: cwd, resumeSessionId: sessionId }))
  }
)
```

Remove reducer-level dedupe in `addTab` (the block that early-returns on `payload.resumeSessionId`) and add a comment noting dedupe happens in `openClaudeSessionTab` using pane state.

Update `Tab` comment in `src/store/types.ts`:

```ts
resumeSessionId?: string // Compatibility-only seed for the initial pane; pane content is authoritative (do not mutate after creation)
```

**Step 4: Update Sidebar + HistoryView to use the thunk**

In `src/components/Sidebar.tsx`:
- Replace direct `addTab` calls with `dispatch(openClaudeSessionTab({ sessionId: item.sessionId, title: item.title, cwd: item.cwd }))`.
- Use `getActiveSessionIdForTab` for active-session highlighting rather than `activeTab.resumeSessionId`.

In `src/components/HistoryView.tsx`:
- Replace `dispatch(addTab({ ... resumeSessionId }))` with the same `openClaudeSessionTab` thunk.

**Step 5: Run tests to verify pass**

Run:
- `CI=true npm test -- test/unit/client/components/Sidebar.test.tsx -t "activates existing tab"`
- `CI=true npm test -- test/unit/client/store/tabsSlice.test.ts -t "openClaudeSessionTab"`
Expected: PASS

**Step 6: Commit**

```bash
git add src/store/tabsSlice.ts src/store/types.ts src/components/Sidebar.tsx src/components/HistoryView.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/store/tabsSlice.test.ts
git commit -m "refactor(client): centralize session tab dedupe"
```

---

### Task 6: Update TerminalView to use pane-level resumeSessionId and apply effectiveResumeSessionId

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.lastInputAt.test.tsx`
- Test: `test/unit/client/components/TerminalView.resumeSession.test.tsx`

**Step 1: Write failing tests**

Add a test to `TerminalView.resumeSession.test.tsx` that sends a `terminal.created` message with `effectiveResumeSessionId` and asserts the pane content is updated with that ID.

Adjust `TerminalView.lastInputAt.test.tsx` to rely on pane `resumeSessionId` (not tab resumeSessionId) for session activity tracking.

**Step 2: Run tests to verify they fail**

Run:
- `CI=true npm test -- test/unit/client/components/TerminalView.resumeSession.test.tsx -t "effectiveResumeSessionId"`
- `CI=true npm test -- test/unit/client/components/TerminalView.lastInputAt.test.tsx -t "resumeSessionId"`
Expected: FAIL

**Step 3: Update TerminalView implementation**

In `src/components/TerminalView.tsx`:
- Replace the `useEffect` dependency that resets `lastSessionActivityAtRef` to use `terminalContent?.resumeSessionId` (pane-level).
- When handling `terminal.created`, if `msg.effectiveResumeSessionId` is present and differs, call `updateContent({ resumeSessionId: msg.effectiveResumeSessionId })`.
- When handling `terminal.session.associated`, update **pane content only** (remove `updateTab` resumeSessionId updates).
- Do **not** clear or mutate `tab.resumeSessionId` here; keep it as a compatibility seed only.

Example additions:

```ts
useEffect(() => {
  lastSessionActivityAtRef.current = 0
}, [terminalContent?.resumeSessionId])

if (msg.type === 'terminal.created' && msg.requestId === reqId) {
  ...
  if (msg.effectiveResumeSessionId) {
    updateContent({ resumeSessionId: msg.effectiveResumeSessionId })
  }
}

if (msg.type === 'terminal.session.associated' && msg.terminalId === tid) {
  updateContent({ resumeSessionId: msg.sessionId as string })
}
```

**Step 4: Run tests to verify pass**

Run:
- `CI=true npm test -- test/unit/client/components/TerminalView.resumeSession.test.tsx -t "effectiveResumeSessionId"`
- `CI=true npm test -- test/unit/client/components/TerminalView.lastInputAt.test.tsx -t "resumeSessionId"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lastInputAt.test.tsx
git commit -m "fix(client): treat pane resumeSessionId as authoritative"
```

---

### Task 7: Clear effectiveResumeSessionId on missing scans and skip resume at spawn

**Files:**
- Modify: `server/ws-handler.ts`
- Test: `test/server/ws-protocol.test.ts`
- Test: `test/server/ws-edge-cases.test.ts`

**Step 1: Write failing tests**

Add tests to ensure:
- `terminal.created` includes `effectiveResumeSessionId` equal to the resumeSessionId used to spawn or reuse.
- When session repair returns `missing`, the server clears `effectiveResumeSessionId` (undefined) **and** spawns without `--resume`.
- When `resumeSessionId` is invalid (non-UUID), `effectiveResumeSessionId` is cleared and the spawn omits `--resume`.
- When `resumeSessionId` is invalid, `sessionRepairService.waitForSession` is **not** called.

Add a ws test that stubs session repair to return `missing` and spies on `TerminalRegistry.prototype.create` to assert the passed `resumeSessionId` is `undefined`.

**Step 2: Run tests to verify they fail**

Run:
- `CI=true npm test -- test/server/ws-protocol.test.ts -t "effectiveResumeSessionId"`
- `CI=true npm test -- test/server/ws-edge-cases.test.ts -t "missing"`
Expected: FAIL

**Step 3: Update ws-handler**

In `server/ws-handler.ts`:
- Compute `effectiveResumeSessionId` before calling `registry.create` and pass **only** that value to `create`.
- Validate `m.resumeSessionId` with `isValidClaudeSessionId`; if invalid, log and set `effectiveResumeSessionId = undefined`.
- If scan status is `missing`, log and set `effectiveResumeSessionId = undefined`.
- Include `effectiveResumeSessionId` in `terminal.created` payload when present.
 - Import `isValidClaudeSessionId` from `./claude-session-id.js`.
- Only call `sessionRepairService.waitForSession` when `effectiveResumeSessionId` is still defined (valid).

Example:

```ts
let effectiveResumeSessionId = m.resumeSessionId

if (effectiveResumeSessionId && !isValidClaudeSessionId(effectiveResumeSessionId)) {
  logger.warn({ resumeSessionId: effectiveResumeSessionId }, 'Ignoring invalid Claude resumeSessionId')
  effectiveResumeSessionId = undefined
}

let result: { status: 'healthy' | 'corrupted' | 'missing' } | undefined
if (effectiveResumeSessionId && this.sessionRepairService) {
  result = await this.sessionRepairService.waitForSession(effectiveResumeSessionId, 10000)
  if (result.status === 'missing') {
    logger.warn({ sessionId: effectiveResumeSessionId }, 'Session file missing, skipping resume')
    effectiveResumeSessionId = undefined
  }
}

const record = this.registry.create({
  mode: m.mode,
  shell: m.shell,
  cwd: m.cwd,
  cols: m.cols,
  rows: m.rows,
  resumeSessionId: effectiveResumeSessionId,
})

this.send(ws, {
  type: 'terminal.created',
  requestId: m.requestId,
  terminalId: record.terminalId,
  snapshot: record.buffer.snapshot(),
  createdAt: record.createdAt,
  effectiveResumeSessionId,
})
```

**Step 4: Run tests to verify pass**

Run:
- `CI=true npm test -- test/server/ws-protocol.test.ts -t "effectiveResumeSessionId"`
- `CI=true npm test -- test/server/ws-edge-cases.test.ts -t "missing"`
Expected: PASS

**Step 5: Commit**

```bash
git add server/ws-handler.ts test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts
git commit -m "fix(server): skip resume on missing scans"
```

---

### Task 8: Shared CLAUDE_HOME utilities and session-repair path alignment

**Files:**
- Create: `server/claude-home.ts`
- Modify: `server/claude-indexer.ts`
- Modify: `server/session-scanner/service.ts`
- Test: `test/unit/server/claude-indexer.test.ts`
- Test: `test/integration/session-repair.test.ts`

**Step 1: Write failing tests**

Add a test in `test/integration/session-repair.test.ts` to verify `CLAUDE_HOME` is used:

```ts
it('uses CLAUDE_HOME when discovering sessions', async () => {
  const original = process.env.CLAUDE_HOME
  process.env.CLAUDE_HOME = path.join(tempDir, 'custom-claude')
  const projectsDir = path.join(process.env.CLAUDE_HOME, 'projects', 'test-project')
  await fs.mkdir(projectsDir, { recursive: true })

  const sessionId = '550e8400-e29b-41d4-a716-446655440000'
  const sessionFile = path.join(projectsDir, `${sessionId}.jsonl`)
  await fs.copyFile(path.join(FIXTURES_DIR, 'healthy.jsonl'), sessionFile)

  const service2 = new SessionRepairService({ cacheDir: tempDir, scanner: createSessionScanner() })
  await service2.start()

  const queue = (service2 as any).queue
  expect(queue.size()).toBeGreaterThan(0)

  await service2.stop()
  process.env.CLAUDE_HOME = original
})
```

Update `claude-indexer` tests to reference `getClaudeHome()` (new function) instead of `defaultClaudeHome()`.

**Step 2: Run tests to verify they fail**

Run:
- `CI=true npm test -- test/integration/session-repair.test.ts -t "CLAUDE_HOME"`
- `CI=true npm test -- test/unit/server/claude-indexer.test.ts -t "CLAUDE_HOME"`
Expected: FAIL

**Step 3: Implement shared CLAUDE_HOME helpers**

Create `server/claude-home.ts`:

```ts
import os from 'os'
import path from 'path'

export function getClaudeHome(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
}

export function getClaudeProjectsDir(): string {
  return path.join(getClaudeHome(), 'projects')
}
```

Update imports in `server/claude-indexer.ts` and `server/session-scanner/service.ts` to use `getClaudeHome` / `getClaudeProjectsDir` (with `.js` extensions in import paths).

**Step 4: Run tests to verify pass**

Run:
- `CI=true npm test -- test/integration/session-repair.test.ts -t "CLAUDE_HOME"`
- `CI=true npm test -- test/unit/server/claude-indexer.test.ts -t "CLAUDE_HOME"`
Expected: PASS

**Step 5: Commit**

```bash
git add server/claude-home.ts server/claude-indexer.ts server/session-scanner/service.ts test/integration/session-repair.test.ts test/unit/server/claude-indexer.test.ts
git commit -m "fix(server): share CLAUDE_HOME resolution"
```

---

### Task 9: Canonicalize sessionId from JSONL content (full consistency)

**Files:**
- Modify: `server/claude-indexer.ts`
- Test: `test/unit/server/claude-indexer.test.ts`

**Step 1: Write failing tests**

Add to `test/unit/server/claude-indexer.test.ts`:

```ts
it('extracts sessionId from content when present', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000'
  const content = `{"sessionId":"${id}","cwd":"/tmp"}`
  const meta = parseSessionContent(content)
  expect(meta.sessionId).toBe(id)
})

it('accepts session_id when sessionId is not present', () => {
  const id = '6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'
  const content = `{"type":"system","session_id":"${id}"}`
  const meta = parseSessionContent(content)
  expect(meta.sessionId).toBe(id)
})

it('ignores non-UUID sessionId candidates', () => {
  const content = '{"sessionId":"not-a-uuid","cwd":"/tmp"}'
  const meta = parseSessionContent(content)
  expect(meta.sessionId).toBeUndefined()
})
```

Add integration-style tests using temp directories to validate refresh/upsert/remove paths use the canonical ID (embedded sessionId is a valid UUID that differs from a **different valid UUID** filename). Use `process.env.CLAUDE_HOME` to point at a temp dir and call `indexer.refresh()`.

Add a test where both the embedded sessionId and filename are **invalid** (non-UUID); assert the session is skipped (not indexed) and a warning is logged.

**Step 2: Run tests to verify they fail**

Run: `CI=true npm test -- test/unit/server/claude-indexer.test.ts -t "sessionId"`
Expected: FAIL (meta.sessionId undefined)

**Step 3: Implement canonical sessionId extraction and mapping**

Update `JsonlMeta` and `parseSessionContent` to validate UUIDs:

```ts
import { isValidClaudeSessionId } from './claude-session-id.js'

export type JsonlMeta = {
  cwd?: string
  title?: string
  summary?: string
  messageCount?: number
  sessionId?: string
}

export function parseSessionContent(content: string): JsonlMeta {
  ...
  let sessionId: string | undefined

  for (const line of lines) {
    ...
    if (!sessionId) {
      const candidates = [
        obj?.sessionId,
        obj?.session_id,
        obj?.message?.sessionId,
        obj?.message?.session_id,
        obj?.data?.sessionId,
        obj?.data?.session_id,
      ].filter((v: any) => typeof v === 'string') as string[]
      const valid = candidates.find((v) => isValidClaudeSessionId(v))
      if (valid) sessionId = valid
    }

    if (cwd && title && summary && sessionId) break
  }

  return { cwd, title, summary, messageCount: lines.length, sessionId }
}
```

Add mapping fields and helpers inside `ClaudeSessionIndexer`:

```ts
private filePathToSessionId = new Map<string, string>()
private sessionIdToFilePath = new Map<string, string>()

private setSessionMapping(filePath: string, sessionId: string) {
  const oldSessionId = this.filePathToSessionId.get(filePath)
  if (oldSessionId && oldSessionId !== sessionId) {
    this.sessionIdToFilePath.delete(oldSessionId)
  }
  this.filePathToSessionId.set(filePath, sessionId)
  this.sessionIdToFilePath.set(sessionId, filePath)
}

private clearSessionMapping(filePath: string) {
  const sessionId = this.filePathToSessionId.get(filePath)
  if (sessionId) this.sessionIdToFilePath.delete(sessionId)
  this.filePathToSessionId.delete(filePath)
}

public getFilePathForSession(sessionId: string): string | undefined {
  return this.sessionIdToFilePath.get(sessionId)
}
```

Update `refresh()`, `upsertSessionFromFile()`, and `scheduleFileRemove()` to:
- Use `meta.sessionId` if valid; otherwise use filename **only if** it is a valid UUID.
- If neither content nor filename yields a valid UUID, log a warning and skip indexing that session file.
- Call `setSessionMapping`/`clearSessionMapping`.
- Remove sessions by canonical ID (not filename).

Add override compatibility:
- When `canonicalId !== legacyId`, look for overrides by canonical ID first, then fall back to legacy ID.
- If a legacy override is used, log a structured warning (no emoji) so we can audit and migrate later.

**Step 4: Run tests to verify pass**

Run: `CI=true npm test -- test/unit/server/claude-indexer.test.ts -t "sessionId"`
Expected: PASS

**Step 5: Commit**

```bash
git add server/claude-indexer.ts test/unit/server/claude-indexer.test.ts
git commit -m "feat(server): canonicalize claude sessionId from JSONL"
```

---

### Task 10: Align session repair queue with canonical sessionId

**Files:**
- Modify: `server/session-scanner/service.ts`
- Modify: `server/session-scanner/queue.ts`
- Modify: `server/index.ts`
- Test: `test/integration/session-repair.test.ts`
- Test: `test/unit/server/session-queue.test.ts`

**Step 1: Write failing tests**

Add a test to `test/integration/session-repair.test.ts` that:
- Creates a JSONL file with embedded `sessionId = "550e8400-e29b-41d4-a716-446655440000"` but filename `6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b.jsonl`.
- Provides a fake `getFilePathForSession` resolver that returns that file path.
- Calls `service.waitForSession('550e8400-e29b-41d4-a716-446655440000')` and asserts it resolves.

Add unit tests in `test/unit/server/session-queue.test.ts` to cover a new `has(sessionId)` helper (if added).
Add a unit test to ensure `waitForSession` does **not** enqueue duplicate work when a canonical sessionId resolves to a legacy filename already queued/processing.

**Step 2: Run tests to verify they fail**

Run:
- `CI=true npm test -- test/integration/session-repair.test.ts -t "canonical-id"`
- `CI=true npm test -- test/unit/server/session-queue.test.ts -t "has"`
Expected: FAIL

**Step 3: Update SessionRepairService to resolve canonical IDs**

In `server/session-scanner/service.ts`:
- Add optional `getFilePathForSession?: (sessionId: string) => string | undefined` to `SessionRepairServiceOptions`.
- Store it on the instance, and add a `setFilePathResolver` method so `server/index.ts` can attach the indexer after startup.
- In `prioritizeSessions`, resolve file paths using the resolver first; fall back to `glob` if needed.
- In `waitForSession`, if `queue.waitFor(sessionId)` rejects with "not in queue", try to resolve filePath and enqueue using the **file-based ID** (`path.basename(filePath, '.jsonl')`), then wait for that ID instead.
- Before enqueuing, call `queue.has()` for both the canonical ID and the file-based ID to avoid duplicate queue entries.

In `server/index.ts`:
- After `claudeIndexer.start()`, call `sessionRepairService.setFilePathResolver((id) => claudeIndexer.getFilePathForSession(id))`.

**Step 4: Update SessionRepairQueue**

Add a small helper to detect whether a session is queued/processing (used to avoid duplicate enqueues):

```ts
has(sessionId: string): boolean {
  return this.queuedBySessionId.has(sessionId) || this.processing.has(sessionId) || this.processed.has(sessionId)
}
```

**Step 5: Run tests to verify pass**

Run:
- `CI=true npm test -- test/integration/session-repair.test.ts -t "canonical-id"`
- `CI=true npm test -- test/unit/server/session-queue.test.ts -t "has"`
Expected: PASS

**Step 6: Commit**

```bash
git add server/session-scanner/service.ts server/session-scanner/queue.ts server/index.ts test/integration/session-repair.test.ts test/unit/server/session-queue.test.ts
git commit -m "fix(server): map canonical sessionId to session repair queue"
```

---

### Task 11: Prevent duplicate Claude terminals resuming the same session

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Test: `test/server/ws-edge-cases.test.ts`
- Test: `test/unit/server/terminal-registry.test.ts`

**Step 1: Write failing tests**

Add a unit test in `test/unit/server/terminal-registry.test.ts` for a new helper:

```ts
it('finds a running claude terminal by resumeSessionId', () => {
  const reg = new TerminalRegistry()
  const id = '550e8400-e29b-41d4-a716-446655440000'
  const t1 = reg.create({ mode: 'claude', resumeSessionId: id })
  const found = reg.findRunningClaudeTerminalBySession(id)
  expect(found?.terminalId).toBe(t1.terminalId)
})
```

Add a ws test in `test/server/ws-edge-cases.test.ts` that:
- Creates a claude terminal with a **valid UUID** resumeSessionId.
- Sends a second `terminal.create` with the same resumeSessionId.
- Asserts the second `terminal.created` returns the **same** terminalId and includes `effectiveResumeSessionId`.

**Step 2: Run tests to verify they fail**

Run:
- `CI=true npm test -- test/unit/server/terminal-registry.test.ts -t "finds a running"`
- `CI=true npm test -- test/server/ws-edge-cases.test.ts -t "same session"`
Expected: FAIL

**Step 3: Implement duplicate prevention**

In `server/terminal-registry.ts`, add:

```ts
findRunningClaudeTerminalBySession(sessionId: string): TerminalRecord | undefined {
  for (const term of this.terminals.values()) {
    if (term.mode !== 'claude') continue
    if (term.status !== 'running') continue
    if (term.resumeSessionId === sessionId) return term
  }
  return undefined
}
```

In `server/ws-handler.ts`, before `registry.create`:
- Use `effectiveResumeSessionId` (validated/missing-checked) for dedupe, not raw `m.resumeSessionId`.
- Ordering: validate -> dedupe -> (if still resuming) sessionRepair wait -> create.

```ts
let existing: TerminalRecord | undefined
const resumeId = effectiveResumeSessionId
if (m.mode === 'claude' && resumeId) {
  existing = this.registry.findRunningClaudeTerminalBySession(resumeId)
}

if (existing) {
  this.registry.attach(existing.terminalId, ws)
  state.attachedTerminalIds.add(existing.terminalId)
  state.createdByRequestId.set(m.requestId, existing.terminalId)
  this.send(ws, {
    type: 'terminal.created',
    requestId: m.requestId,
    terminalId: existing.terminalId,
    snapshot: existing.buffer.snapshot(),
    createdAt: existing.createdAt,
    effectiveResumeSessionId: existing.resumeSessionId,
  })
  return
}
```

**Step 4: Run tests to verify pass**

Run:
- `CI=true npm test -- test/unit/server/terminal-registry.test.ts -t "finds a running"`
- `CI=true npm test -- test/server/ws-edge-cases.test.ts -t "same session"`
Expected: PASS

**Step 5: Commit**

```bash
git add server/terminal-registry.ts server/ws-handler.ts test/unit/server/terminal-registry.test.ts test/server/ws-edge-cases.test.ts
git commit -m "fix(server): reuse claude terminal for identical session"
```

---

### Task 12: Full verification + e2e/integration coverage

**Automated unit/integration tests:**
- `CI=true npm test`

**Integration/e2e coverage:**
- Extend `test/integration/server/claude-session-flow.test.ts` (guarded by `RUN_CLAUDE_INTEGRATION=true`) to:
  - Set `process.env.CLAUDE_HOME` to a temp dir (restore after) to avoid polluting real sessions
  - Seed a session JSONL file with a **known UUID** in `CLAUDE_HOME/projects/...`
  - Call `await claudeIndexer.refresh()` (or poll until `indexer.getFilePathForSession(uuid)` returns) before creating the terminal to avoid race conditions
  - Create a `terminal.create` in claude mode with that resumeSessionId
  - Assert `terminal.created.effectiveResumeSessionId` equals the requested UUID
  - Assert the JSONL remains present and the embedded `sessionId` matches the requested UUID

**Manual verification:**
1. `npm run dev`
2. Create a new Claude terminal tab
3. Split the pane and create another Claude terminal
4. Verify both panes start without `resumeSessionId` and then receive unique IDs after association (Redux DevTools)
5. Hard-restart the server and reload the browser
6. Verify each pane resumes its correct session (no cross-pane swap)
7. Verify clicking a session in Sidebar activates the correct pane/tab

---

## Implementation Order

1. **Task 0** - Validate CLI resume contract (manual)
2. **Task 1** - Server session ID validation helper
3. **Task 2** - Client validator + avoid auto-assigning resumeSessionId
4. **Task 3** - Migrate legacy tab resumeSessionId into Claude panes
5. **Task 4** - Pane-based helpers + sidebar selectors (filter invalid IDs)
6. **Task 5** - Centralize session-open dedupe (Sidebar + HistoryView)
7. **Task 6** - TerminalView pane-level resumeSessionId + effective ID handling
8. **Task 7** - Skip resume on missing scans at spawn
9. **Task 8** - Shared CLAUDE_HOME helpers
10. **Task 9** - Canonicalize indexer sessionId
11. **Task 10** - Align session repair queue with canonical IDs
12. **Task 11** - Prevent duplicate Claude terminals
13. **Task 12** - Full test + integration/e2e verification

---

## Notes / Design Guarantees

- New Claude panes start **without** a `resumeSessionId`; IDs are set only when known/associated.
- Client and server both validate UUIDs; invalid IDs are dropped or ignored (including `effectiveResumeSessionId` and non-terminal ClaudeSession resumes).
- Migration only applies to Claude panes (active Claude pane if available, else first Claude pane).
- Pane content is authoritative; tab `resumeSessionId` is a compatibility seed only and is not mutated/cleared after panes take over.
- `claude-indexer` treats embedded `sessionId` as canonical **only when valid UUID**; invalid IDs are logged and skipped.
- Session repair respects `CLAUDE_HOME` and can resolve canonical IDs to file paths.
- `terminal.created` echoes `effectiveResumeSessionId`; missing scans clear it and **spawn without** resume.
- Duplicate Claude terminals for the same session are prevented by reusing the running terminal.
- Legacy cwd-based association remains only for terminals lacking a sessionId.
- Sidebar activity sorting uses per-session activity (ratcheted) instead of `tab.lastInputAt`.
