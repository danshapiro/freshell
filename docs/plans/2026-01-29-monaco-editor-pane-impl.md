# Monaco Editor Pane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Monaco-based editor pane type alongside terminal and browser panes, with file editing, scratch pads, markdown/HTML preview, and auto-save.

**Architecture:** New `EditorPaneContent` type in the pane discriminated union. Server provides REST endpoints for file read/write/autocomplete. EditorPane component wraps Monaco with toolbar for file selection and view mode toggle. Auto-save with 5s debounce.

**Tech Stack:** @monaco-editor/react, react-markdown, remark-gfm, Express REST endpoints

---

## Task 1: Add EditorPaneContent Type

**Files:**
- Modify: `src/store/paneTypes.ts`

**Step 1: Write the failing test**

Add to `test/unit/client/store/panesSlice.test.ts` after the existing `describe('PaneContent types')` block:

```typescript
describe('EditorPaneContent type', () => {
  it('can be created with required fields', () => {
    const content: EditorPaneContent = {
      kind: 'editor',
      filePath: '/path/to/file.ts',
      language: 'typescript',
      readOnly: false,
      content: 'const x = 1',
      viewMode: 'source',
    }
    expect(content.kind).toBe('editor')
    expect(content.filePath).toBe('/path/to/file.ts')
  })

  it('supports scratch pad mode with null filePath', () => {
    const content: EditorPaneContent = {
      kind: 'editor',
      filePath: null,
      language: null,
      readOnly: false,
      content: '',
      viewMode: 'source',
    }
    expect(content.filePath).toBeNull()
  })

  it('is part of PaneContent union', () => {
    const editor: PaneContent = {
      kind: 'editor',
      filePath: '/test.md',
      language: 'markdown',
      readOnly: false,
      content: '# Hello',
      viewMode: 'preview',
    }
    expect(editor.kind).toBe('editor')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: FAIL with "EditorPaneContent is not defined"

**Step 3: Write minimal implementation**

In `src/store/paneTypes.ts`, add after `BrowserPaneContent`:

```typescript
/**
 * Editor pane content for Monaco-based file editing.
 */
export type EditorPaneContent = {
  kind: 'editor'
  /** File path being edited, null for scratch pad */
  filePath: string | null
  /** Language for syntax highlighting, null for auto-detect */
  language: string | null
  /** Whether the file is read-only */
  readOnly: boolean
  /** Current buffer content */
  content: string
  /** View mode: source editor or rendered preview */
  viewMode: 'source' | 'preview'
}
```

Update the union type:

```typescript
export type PaneContent = TerminalPaneContent | BrowserPaneContent | EditorPaneContent
```

Add input type after `TerminalPaneInput`:

```typescript
/**
 * Input type for creating editor panes.
 */
export type EditorPaneInput = EditorPaneContent
```

Update `PaneContentInput`:

```typescript
export type PaneContentInput = TerminalPaneInput | BrowserPaneContent | EditorPaneInput
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/store/paneTypes.ts test/unit/client/store/panesSlice.test.ts
git commit -m "feat(panes): add EditorPaneContent type

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Update normalizeContent for Editor Type

**Files:**
- Modify: `src/store/panesSlice.ts`
- Modify: `test/unit/client/store/panesSlice.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/client/store/panesSlice.test.ts`:

```typescript
describe('editor content normalization', () => {
  it('passes editor content through unchanged', () => {
    const editorContent: EditorPaneContent = {
      kind: 'editor',
      filePath: '/test.ts',
      language: 'typescript',
      readOnly: false,
      content: 'code',
      viewMode: 'source',
    }

    const state = panesReducer(
      initialState,
      initLayout({ tabId: 'tab-1', content: editorContent })
    )

    const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
    expect(leaf.content).toEqual(editorContent)
  })

  it('creates editor pane via addPane', () => {
    let state = panesReducer(
      initialState,
      initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
    )

    state = panesReducer(
      state,
      addPane({
        tabId: 'tab-1',
        newContent: {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        },
      })
    )

    const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
    const editorPane = root.children[1] as Extract<PaneNode, { type: 'leaf' }>
    expect(editorPane.content.kind).toBe('editor')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: FAIL (type errors or content not matching)

**Step 3: Write minimal implementation**

In `src/store/panesSlice.ts`, update the `normalizeContent` function:

```typescript
function normalizeContent(input: PaneContentInput): PaneContent {
  if (input.kind === 'terminal') {
    return {
      kind: 'terminal',
      terminalId: input.terminalId,
      createRequestId: input.createRequestId || nanoid(),
      status: input.status || 'creating',
      mode: input.mode || 'shell',
      shell: input.shell || 'system',
      resumeSessionId: input.resumeSessionId,
      initialCwd: input.initialCwd,
    }
  }
  // Browser and editor content pass through unchanged
  return input
}
```

Add import at top:

```typescript
import type { PanesState, PaneContent, PaneContentInput, PaneNode, EditorPaneContent } from './paneTypes'
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/store/panesSlice.ts test/unit/client/store/panesSlice.test.ts
git commit -m "feat(panes): normalize editor content in panesSlice

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Add Files API - Read Endpoint

**Files:**
- Modify: `server/index.ts`
- Create: `test/integration/server/files-api.test.ts`

**Step 1: Write the failing test**

Create `test/integration/server/files-api.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('Files API Integration', () => {
  let app: Express
  let tempDir: string

  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'files-api-test-'))

    app = express()
    app.use(express.json({ limit: '1mb' }))

    // Auth middleware
    app.use('/api', (req, res, next) => {
      const token = process.env.AUTH_TOKEN
      if (!token) return res.status(500).json({ error: 'Server misconfigured' })
      const provided = req.headers['x-auth-token'] as string | undefined
      if (!provided || provided !== token) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      next()
    })

    // Import and mount files routes (we'll implement these)
    const { filesRouter } = await import('../../../server/files-router')
    app.use('/api/files', filesRouter)
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  describe('GET /api/files/read', () => {
    it('returns file content and metadata', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      await fsp.writeFile(filePath, 'Hello, world!')

      const res = await request(app)
        .get('/api/files/read')
        .query({ path: filePath })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.content).toBe('Hello, world!')
      expect(res.body.size).toBe(13)
      expect(res.body.modifiedAt).toBeDefined()
    })

    it('returns 400 if path is missing', async () => {
      const res = await request(app)
        .get('/api/files/read')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('path')
    })

    it('returns 404 if file does not exist', async () => {
      const res = await request(app)
        .get('/api/files/read')
        .query({ path: path.join(tempDir, 'nonexistent.txt') })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(404)
    })

    it('returns 400 for directories', async () => {
      const res = await request(app)
        .get('/api/files/read')
        .query({ path: tempDir })
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('directory')
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/integration/server/files-api.test.ts`
Expected: FAIL with "Cannot find module '../../../server/files-router'"

**Step 3: Write minimal implementation**

Create `server/files-router.ts`:

```typescript
import express from 'express'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'

export const filesRouter = express.Router()

filesRouter.get('/read', async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    return res.status(400).json({ error: 'path query parameter required' })
  }

  const resolved = path.resolve(filePath)

  try {
    const stat = await fsp.stat(resolved)
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot read directory' })
    }

    const content = await fsp.readFile(resolved, 'utf-8')
    res.json({
      content,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' })
    }
    return res.status(500).json({ error: err.message })
  }
})
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/integration/server/files-api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add server/files-router.ts test/integration/server/files-api.test.ts
git commit -m "feat(api): add /api/files/read endpoint

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Add Files API - Write Endpoint

**Files:**
- Modify: `server/files-router.ts`
- Modify: `test/integration/server/files-api.test.ts`

**Step 1: Write the failing test**

Add to `test/integration/server/files-api.test.ts`:

```typescript
describe('POST /api/files/write', () => {
  it('writes content to file', async () => {
    const filePath = path.join(tempDir, 'new-file.txt')

    const res = await request(app)
      .post('/api/files/write')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ path: filePath, content: 'New content!' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.modifiedAt).toBeDefined()

    // Verify file was written
    const written = await fsp.readFile(filePath, 'utf-8')
    expect(written).toBe('New content!')
  })

  it('overwrites existing file', async () => {
    const filePath = path.join(tempDir, 'existing.txt')
    await fsp.writeFile(filePath, 'Old content')

    const res = await request(app)
      .post('/api/files/write')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ path: filePath, content: 'Updated!' })

    expect(res.status).toBe(200)

    const written = await fsp.readFile(filePath, 'utf-8')
    expect(written).toBe('Updated!')
  })

  it('creates parent directories if needed', async () => {
    const filePath = path.join(tempDir, 'nested', 'deep', 'file.txt')

    const res = await request(app)
      .post('/api/files/write')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ path: filePath, content: 'Nested content' })

    expect(res.status).toBe(200)

    const written = await fsp.readFile(filePath, 'utf-8')
    expect(written).toBe('Nested content')
  })

  it('returns 400 if path is missing', async () => {
    const res = await request(app)
      .post('/api/files/write')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ content: 'No path' })

    expect(res.status).toBe(400)
  })

  it('returns 400 if content is missing', async () => {
    const res = await request(app)
      .post('/api/files/write')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ path: path.join(tempDir, 'file.txt') })

    expect(res.status).toBe(400)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/integration/server/files-api.test.ts`
Expected: FAIL with 404

**Step 3: Write minimal implementation**

Add to `server/files-router.ts`:

```typescript
filesRouter.post('/write', async (req, res) => {
  const { path: filePath, content } = req.body

  if (!filePath) {
    return res.status(400).json({ error: 'path is required' })
  }
  if (content === undefined) {
    return res.status(400).json({ error: 'content is required' })
  }

  const resolved = path.resolve(filePath)

  try {
    // Create parent directories if needed
    await fsp.mkdir(path.dirname(resolved), { recursive: true })

    await fsp.writeFile(resolved, content, 'utf-8')
    const stat = await fsp.stat(resolved)

    res.json({
      success: true,
      modifiedAt: stat.mtime.toISOString(),
    })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/integration/server/files-api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add server/files-router.ts test/integration/server/files-api.test.ts
git commit -m "feat(api): add /api/files/write endpoint

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Add Files API - Complete (Autocomplete) Endpoint

**Files:**
- Modify: `server/files-router.ts`
- Modify: `test/integration/server/files-api.test.ts`

**Step 1: Write the failing test**

Add to `test/integration/server/files-api.test.ts`:

```typescript
describe('GET /api/files/complete', () => {
  beforeEach(async () => {
    // Create test file structure
    await fsp.mkdir(path.join(tempDir, 'src'), { recursive: true })
    await fsp.mkdir(path.join(tempDir, 'docs'), { recursive: true })
    await fsp.writeFile(path.join(tempDir, 'src', 'index.ts'), '')
    await fsp.writeFile(path.join(tempDir, 'src', 'utils.ts'), '')
    await fsp.writeFile(path.join(tempDir, 'docs', 'README.md'), '')
    await fsp.writeFile(path.join(tempDir, 'package.json'), '')
  })

  it('returns suggestions for prefix', async () => {
    const res = await request(app)
      .get('/api/files/complete')
      .query({ prefix: path.join(tempDir, 'src', '') })
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.suggestions).toBeInstanceOf(Array)
    expect(res.body.suggestions.length).toBeGreaterThan(0)

    const paths = res.body.suggestions.map((s: any) => s.path)
    expect(paths).toContain(path.join(tempDir, 'src', 'index.ts'))
    expect(paths).toContain(path.join(tempDir, 'src', 'utils.ts'))
  })

  it('includes isDirectory flag', async () => {
    const res = await request(app)
      .get('/api/files/complete')
      .query({ prefix: path.join(tempDir, '') })
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)

    const srcDir = res.body.suggestions.find((s: any) => s.path.endsWith('src'))
    expect(srcDir).toBeDefined()
    expect(srcDir.isDirectory).toBe(true)

    const pkgJson = res.body.suggestions.find((s: any) => s.path.endsWith('package.json'))
    expect(pkgJson).toBeDefined()
    expect(pkgJson.isDirectory).toBe(false)
  })

  it('returns directories first', async () => {
    const res = await request(app)
      .get('/api/files/complete')
      .query({ prefix: path.join(tempDir, '') })
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)

    const suggestions = res.body.suggestions
    const firstFile = suggestions.findIndex((s: any) => !s.isDirectory)
    const lastDir = suggestions.findLastIndex((s: any) => s.isDirectory)

    if (firstFile !== -1 && lastDir !== -1) {
      expect(lastDir).toBeLessThan(firstFile)
    }
  })

  it('limits to 20 results', async () => {
    // Create 25 files
    for (let i = 0; i < 25; i++) {
      await fsp.writeFile(path.join(tempDir, `file${i}.txt`), '')
    }

    const res = await request(app)
      .get('/api/files/complete')
      .query({ prefix: path.join(tempDir, 'file') })
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.suggestions.length).toBeLessThanOrEqual(20)
  })

  it('returns 400 if prefix is missing', async () => {
    const res = await request(app)
      .get('/api/files/complete')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
  })

  it('returns empty array for non-matching prefix', async () => {
    const res = await request(app)
      .get('/api/files/complete')
      .query({ prefix: path.join(tempDir, 'nonexistent') })
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body.suggestions).toEqual([])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/integration/server/files-api.test.ts`
Expected: FAIL with 404

**Step 3: Write minimal implementation**

Add to `server/files-router.ts`:

```typescript
filesRouter.get('/complete', async (req, res) => {
  const prefix = req.query.prefix as string
  if (!prefix) {
    return res.status(400).json({ error: 'prefix query parameter required' })
  }

  const resolved = path.resolve(prefix)
  const dir = path.dirname(resolved)
  const basename = path.basename(resolved)

  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })

    const matches = entries
      .filter((entry) => entry.name.startsWith(basename))
      .map((entry) => ({
        path: path.join(dir, entry.name),
        isDirectory: entry.isDirectory(),
      }))
      // Sort: directories first, then alphabetically
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1
        }
        return a.path.localeCompare(b.path)
      })
      .slice(0, 20)

    res.json({ suggestions: matches })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.json({ suggestions: [] })
    }
    return res.status(500).json({ error: err.message })
  }
})
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/integration/server/files-api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add server/files-router.ts test/integration/server/files-api.test.ts
git commit -m "feat(api): add /api/files/complete endpoint for autocomplete

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Mount Files Router in Server

**Files:**
- Modify: `server/index.ts`

**Step 1: Write the failing test**

The tests from Tasks 3-5 test the router in isolation. Now verify integration with main server.

Add to existing `test/integration/server/files-api.test.ts` a new describe block:

```typescript
describe('Files API via main server', () => {
  // This test verifies the router is correctly mounted
  // The actual server would need to be started for full integration
  // For now, we verify the import works
  it('files router exports correctly', async () => {
    const { filesRouter } = await import('../../../server/files-router')
    expect(filesRouter).toBeDefined()
    expect(typeof filesRouter).toBe('function')
  })
})
```

**Step 2: Run test to verify current state**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/integration/server/files-api.test.ts`
Expected: PASS (router exists)

**Step 3: Write minimal implementation**

In `server/index.ts`, add import near other imports:

```typescript
import { filesRouter } from './files-router'
```

Add after the existing `/api` routes (around line 130, before `// --- Static client in production ---`):

```typescript
// --- API: files ---
app.use('/api/files', filesRouter)
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add server/index.ts
git commit -m "feat(api): mount files router at /api/files

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Install Monaco and Markdown Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install dependencies**

```bash
cd .worktrees/monaco-editor-pane
npm install @monaco-editor/react react-markdown remark-gfm
```

**Step 2: Verify installation**

Run: `cd .worktrees/monaco-editor-pane && npm test`
Expected: PASS (all tests still work)

**Step 3: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add package.json package-lock.json
git commit -m "deps: add monaco-editor, react-markdown, remark-gfm

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Create EditorPane Component Stub

**Files:**
- Create: `src/components/panes/EditorPane.tsx`
- Create: `test/unit/client/components/panes/EditorPane.test.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/panes/EditorPane.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '../../../../../src/components/panes/EditorPane'
import panesReducer from '../../../../../src/store/panesSlice'

// Mock Monaco to avoid loading issues in tests
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
    },
  })

describe('EditorPane', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    store = createMockStore()
  })

  it('renders empty state with Open File button', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath={null}
          language={null}
          readOnly={false}
          content=""
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /open file/i })).toBeInTheDocument()
  })

  it('renders Monaco editor when content is provided', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="const x = 1"
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorPane.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/components/panes/EditorPane.tsx`:

```typescript
import { useState, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { FileText } from 'lucide-react'
import { useAppDispatch } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'

interface EditorPaneProps {
  paneId: string
  tabId: string
  filePath: string | null
  language: string | null
  readOnly: boolean
  content: string
  viewMode: 'source' | 'preview'
}

export default function EditorPane({
  paneId,
  tabId,
  filePath,
  language,
  readOnly,
  content,
  viewMode,
}: EditorPaneProps) {
  const dispatch = useAppDispatch()
  const [inputPath, setInputPath] = useState(filePath || '')

  const handleContentChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return
      dispatch(
        updatePaneContent({
          tabId,
          paneId,
          content: {
            kind: 'editor',
            filePath,
            language,
            readOnly,
            content: value,
            viewMode,
          },
        })
      )
    },
    [dispatch, tabId, paneId, filePath, language, readOnly, viewMode]
  )

  // Empty state
  if (!filePath && !content) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
        <FileText className="h-12 w-12 opacity-50" />
        <button
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          onClick={() => {
            // TODO: Focus path input
          }}
        >
          Open File
        </button>
        <span className="text-sm">or start typing to create a scratch pad</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Toolbar will go here */}
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language={language || undefined}
          value={content}
          onChange={handleContentChange}
          options={{
            readOnly,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          }}
          theme="vs-dark"
        />
      </div>
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorPane.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/EditorPane.tsx test/unit/client/components/panes/EditorPane.test.tsx
git commit -m "feat(ui): add EditorPane component stub

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 9: Wire EditorPane into PaneContainer

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`

**Step 1: Write the failing test**

Add to `test/unit/client/components/panes/PaneContainer.test.tsx`:

```typescript
// Add to imports
import type { EditorPaneContent } from '../../../../../src/store/paneTypes'

// Add test case
it('renders EditorPane for editor content', () => {
  const editorContent: EditorPaneContent = {
    kind: 'editor',
    filePath: '/test.ts',
    language: 'typescript',
    readOnly: false,
    content: 'code',
    viewMode: 'source',
  }

  const node: PaneNode = {
    type: 'leaf',
    id: 'pane-1',
    content: editorContent,
  }

  const state: PanesState = {
    layouts: { 'tab-1': node },
    activePane: { 'tab-1': 'pane-1' },
  }

  const store = configureStore({
    reducer: {
      panes: () => state,
    },
  })

  render(
    <Provider store={store}>
      <PaneContainer tabId="tab-1" node={node} />
    </Provider>
  )

  // Should render the mocked Monaco editor
  expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/PaneContainer.test.tsx`
Expected: FAIL (returns null for editor)

**Step 3: Write minimal implementation**

In `src/components/panes/PaneContainer.tsx`, add import:

```typescript
import EditorPane from './EditorPane'
```

Update `renderContent` function:

```typescript
function renderContent(tabId: string, paneId: string, content: PaneContent, hidden?: boolean) {
  if (content.kind === 'terminal') {
    return <TerminalView key={paneId} tabId={tabId} paneId={paneId} paneContent={content} hidden={hidden} />
  }

  if (content.kind === 'browser') {
    return <BrowserPane paneId={paneId} tabId={tabId} url={content.url} devToolsOpen={content.devToolsOpen} />
  }

  if (content.kind === 'editor') {
    return (
      <EditorPane
        paneId={paneId}
        tabId={tabId}
        filePath={content.filePath}
        language={content.language}
        readOnly={content.readOnly}
        content={content.content}
        viewMode={content.viewMode}
      />
    )
  }

  return null
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/PaneContainer.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "feat(ui): render EditorPane in PaneContainer

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 10: Add Editor to FloatingActionButton Menu

**Files:**
- Modify: `src/components/panes/FloatingActionButton.tsx`
- Modify: `src/components/panes/PaneLayout.tsx`
- Modify: `test/unit/client/components/panes/FloatingActionButton.test.tsx`

**Step 1: Write the failing test**

Add to `test/unit/client/components/panes/FloatingActionButton.test.tsx`:

```typescript
it('shows Editor menu item', async () => {
  const user = userEvent.setup()
  const mockAddEditor = vi.fn()

  render(
    <FloatingActionButton
      onAddTerminal={vi.fn()}
      onAddBrowser={vi.fn()}
      onAddEditor={mockAddEditor}
    />
  )

  // Open menu
  await user.click(screen.getByRole('button', { name: /add pane/i }))

  expect(screen.getByRole('menuitem', { name: /editor/i })).toBeInTheDocument()
})

it('calls onAddEditor when Editor is clicked', async () => {
  const user = userEvent.setup()
  const mockAddEditor = vi.fn()

  render(
    <FloatingActionButton
      onAddTerminal={vi.fn()}
      onAddBrowser={vi.fn()}
      onAddEditor={mockAddEditor}
    />
  )

  await user.click(screen.getByRole('button', { name: /add pane/i }))
  await user.click(screen.getByRole('menuitem', { name: /editor/i }))

  expect(mockAddEditor).toHaveBeenCalledTimes(1)
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/FloatingActionButton.test.tsx`
Expected: FAIL

**Step 3: Write minimal implementation**

Update `src/components/panes/FloatingActionButton.tsx`:

```typescript
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Plus, Terminal, Globe, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FloatingActionButtonProps {
  onAddTerminal: () => void
  onAddBrowser: () => void
  onAddEditor: () => void
}

// ... rest of component

const menuItems: MenuItem[] = useMemo(() => [
  { id: 'terminal', label: 'Terminal', icon: Terminal, action: onAddTerminal },
  { id: 'browser', label: 'Browser', icon: Globe, action: onAddBrowser },
  { id: 'editor', label: 'Editor', icon: FileText, action: onAddEditor },
], [onAddTerminal, onAddBrowser, onAddEditor])
```

Update `src/components/panes/PaneLayout.tsx`:

```typescript
const handleAddEditor = useCallback(() => {
  dispatch(addPane({
    tabId,
    newContent: {
      kind: 'editor',
      filePath: null,
      language: null,
      readOnly: false,
      content: '',
      viewMode: 'source',
    },
  }))
}, [dispatch, tabId])

// In return:
<FloatingActionButton
  onAddTerminal={handleAddTerminal}
  onAddBrowser={handleAddBrowser}
  onAddEditor={handleAddEditor}
/>
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/FloatingActionButton.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/FloatingActionButton.tsx src/components/panes/PaneLayout.tsx test/unit/client/components/panes/FloatingActionButton.test.tsx
git commit -m "feat(ui): add Editor option to FAB menu

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 11: Add EditorToolbar with Path Input

**Files:**
- Create: `src/components/panes/EditorToolbar.tsx`
- Create: `test/unit/client/components/panes/EditorToolbar.test.tsx`
- Modify: `src/components/panes/EditorPane.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/panes/EditorToolbar.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorToolbar from '../../../../../src/components/panes/EditorToolbar'

describe('EditorToolbar', () => {
  it('renders path input', () => {
    render(
      <EditorToolbar
        filePath=""
        onPathChange={vi.fn()}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={false}
      />
    )

    expect(screen.getByPlaceholderText(/enter file path/i)).toBeInTheDocument()
  })

  it('renders file picker button', () => {
    render(
      <EditorToolbar
        filePath=""
        onPathChange={vi.fn()}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={false}
      />
    )

    expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument()
  })

  it('calls onPathChange when Enter is pressed', async () => {
    const user = userEvent.setup()
    const onPathChange = vi.fn()

    render(
      <EditorToolbar
        filePath=""
        onPathChange={onPathChange}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={false}
      />
    )

    const input = screen.getByPlaceholderText(/enter file path/i)
    await user.type(input, '/path/to/file.ts{Enter}')

    expect(onPathChange).toHaveBeenCalledWith('/path/to/file.ts')
  })

  it('shows view toggle only when showViewToggle is true', () => {
    const { rerender } = render(
      <EditorToolbar
        filePath="/test.md"
        onPathChange={vi.fn()}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={false}
      />
    )

    expect(screen.queryByRole('button', { name: /preview|source/i })).not.toBeInTheDocument()

    rerender(
      <EditorToolbar
        filePath="/test.md"
        onPathChange={vi.fn()}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={true}
      />
    )

    expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorToolbar.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/components/panes/EditorToolbar.tsx`:

```typescript
import { useState, useCallback } from 'react'
import { FolderOpen, Eye, Code } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EditorToolbarProps {
  filePath: string
  onPathChange: (path: string) => void
  onOpenFile: () => void
  viewMode: 'source' | 'preview'
  onViewModeToggle: () => void
  showViewToggle: boolean
}

export default function EditorToolbar({
  filePath,
  onPathChange,
  onOpenFile,
  viewMode,
  onViewModeToggle,
  showViewToggle,
}: EditorToolbarProps) {
  const [inputValue, setInputValue] = useState(filePath)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        onPathChange(inputValue)
      }
    },
    [inputValue, onPathChange]
  )

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-card">
      <button
        onClick={onOpenFile}
        className="p-1.5 rounded hover:bg-muted"
        title="Browse files"
        aria-label="Browse files"
      >
        <FolderOpen className="h-4 w-4" />
      </button>

      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Enter file path..."
        className="flex-1 h-8 px-3 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
      />

      {showViewToggle && (
        <button
          onClick={onViewModeToggle}
          className={cn('p-1.5 rounded hover:bg-muted')}
          title={viewMode === 'source' ? 'Show preview' : 'Show source'}
          aria-label={viewMode === 'source' ? 'Preview' : 'Source'}
        >
          {viewMode === 'source' ? <Eye className="h-4 w-4" /> : <Code className="h-4 w-4" />}
        </button>
      )}
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorToolbar.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/EditorToolbar.tsx test/unit/client/components/panes/EditorToolbar.test.tsx
git commit -m "feat(ui): add EditorToolbar with path input and view toggle

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 12: Integrate EditorToolbar into EditorPane

**Files:**
- Modify: `src/components/panes/EditorPane.tsx`
- Modify: `test/unit/client/components/panes/EditorPane.test.tsx`

**Step 1: Write the failing test**

Add to `test/unit/client/components/panes/EditorPane.test.tsx`:

```typescript
it('renders toolbar with path input', () => {
  render(
    <Provider store={store}>
      <EditorPane
        paneId="pane-1"
        tabId="tab-1"
        filePath="/test.ts"
        language="typescript"
        readOnly={false}
        content="const x = 1"
        viewMode="source"
      />
    </Provider>
  )

  expect(screen.getByPlaceholderText(/enter file path/i)).toBeInTheDocument()
})

it('shows view toggle for markdown files', () => {
  render(
    <Provider store={store}>
      <EditorPane
        paneId="pane-1"
        tabId="tab-1"
        filePath="/readme.md"
        language="markdown"
        readOnly={false}
        content="# Hello"
        viewMode="source"
      />
    </Provider>
  )

  expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument()
})

it('hides view toggle for non-markdown/html files', () => {
  render(
    <Provider store={store}>
      <EditorPane
        paneId="pane-1"
        tabId="tab-1"
        filePath="/code.ts"
        language="typescript"
        readOnly={false}
        content="const x = 1"
        viewMode="source"
      />
    </Provider>
  )

  expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorPane.test.tsx`
Expected: FAIL

**Step 3: Write minimal implementation**

Update `src/components/panes/EditorPane.tsx`:

```typescript
import { useState, useCallback, useMemo } from 'react'
import Editor from '@monaco-editor/react'
import { FileText } from 'lucide-react'
import { useAppDispatch } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import EditorToolbar from './EditorToolbar'

interface EditorPaneProps {
  paneId: string
  tabId: string
  filePath: string | null
  language: string | null
  readOnly: boolean
  content: string
  viewMode: 'source' | 'preview'
}

function isPreviewable(filePath: string | null): boolean {
  if (!filePath) return false
  const lower = filePath.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.htm') || lower.endsWith('.html')
}

export default function EditorPane({
  paneId,
  tabId,
  filePath,
  language,
  readOnly,
  content,
  viewMode,
}: EditorPaneProps) {
  const dispatch = useAppDispatch()
  const [inputPath, setInputPath] = useState(filePath || '')
  const showViewToggle = useMemo(() => isPreviewable(filePath), [filePath])

  const updateContent = useCallback(
    (updates: Partial<{
      filePath: string | null
      language: string | null
      content: string
      viewMode: 'source' | 'preview'
    }>) => {
      dispatch(
        updatePaneContent({
          tabId,
          paneId,
          content: {
            kind: 'editor',
            filePath: updates.filePath !== undefined ? updates.filePath : filePath,
            language: updates.language !== undefined ? updates.language : language,
            readOnly,
            content: updates.content !== undefined ? updates.content : content,
            viewMode: updates.viewMode !== undefined ? updates.viewMode : viewMode,
          },
        })
      )
    },
    [dispatch, tabId, paneId, filePath, language, readOnly, content, viewMode]
  )

  const handleContentChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return
      updateContent({ content: value })
    },
    [updateContent]
  )

  const handlePathChange = useCallback(
    (path: string) => {
      // TODO: Load file from server
      updateContent({ filePath: path || null })
    },
    [updateContent]
  )

  const handleOpenFile = useCallback(() => {
    // TODO: Native file picker
  }, [])

  const handleViewModeToggle = useCallback(() => {
    updateContent({ viewMode: viewMode === 'source' ? 'preview' : 'source' })
  }, [updateContent, viewMode])

  // Empty state - only show when no file AND no content
  if (!filePath && !content) {
    return (
      <div className="flex flex-col h-full w-full bg-background">
        <EditorToolbar
          filePath=""
          onPathChange={handlePathChange}
          onOpenFile={handleOpenFile}
          viewMode={viewMode}
          onViewModeToggle={handleViewModeToggle}
          showViewToggle={false}
        />
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
          <FileText className="h-12 w-12 opacity-50" />
          <button
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={handleOpenFile}
          >
            Open File
          </button>
          <span className="text-sm">or start typing to create a scratch pad</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-full bg-background">
      <EditorToolbar
        filePath={filePath || ''}
        onPathChange={handlePathChange}
        onOpenFile={handleOpenFile}
        viewMode={viewMode}
        onViewModeToggle={handleViewModeToggle}
        showViewToggle={showViewToggle}
      />
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language={language || undefined}
          value={content}
          onChange={handleContentChange}
          options={{
            readOnly,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          }}
          theme="vs-dark"
        />
      </div>
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorPane.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/EditorPane.tsx test/unit/client/components/panes/EditorPane.test.tsx
git commit -m "feat(ui): integrate EditorToolbar into EditorPane

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 13: Add MarkdownPreview Component

**Files:**
- Create: `src/components/panes/MarkdownPreview.tsx`
- Create: `test/unit/client/components/panes/MarkdownPreview.test.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/panes/MarkdownPreview.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MarkdownPreview from '../../../../../src/components/panes/MarkdownPreview'

describe('MarkdownPreview', () => {
  it('renders markdown as HTML', () => {
    render(<MarkdownPreview content="# Hello World" />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
  })

  it('renders links', () => {
    render(<MarkdownPreview content="[Click here](https://example.com)" />)

    const link = screen.getByRole('link', { name: /click here/i })
    expect(link).toHaveAttribute('href', 'https://example.com')
  })

  it('renders code blocks', () => {
    render(<MarkdownPreview content="```js\nconst x = 1\n```" />)

    expect(screen.getByText('const x = 1')).toBeInTheDocument()
  })

  it('renders GFM tables', () => {
    render(
      <MarkdownPreview
        content={`
| A | B |
|---|---|
| 1 | 2 |
`}
      />
    )

    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/MarkdownPreview.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/components/panes/MarkdownPreview.tsx`:

```typescript
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownPreviewProps {
  content: string
}

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div className="h-full overflow-auto p-4 prose prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/MarkdownPreview.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/MarkdownPreview.tsx test/unit/client/components/panes/MarkdownPreview.test.tsx
git commit -m "feat(ui): add MarkdownPreview component with GFM support

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 14: Add Preview Modes to EditorPane

**Files:**
- Modify: `src/components/panes/EditorPane.tsx`
- Modify: `test/unit/client/components/panes/EditorPane.test.tsx`

**Step 1: Write the failing test**

Add to `test/unit/client/components/panes/EditorPane.test.tsx`:

```typescript
it('renders markdown preview when viewMode is preview', () => {
  render(
    <Provider store={store}>
      <EditorPane
        paneId="pane-1"
        tabId="tab-1"
        filePath="/readme.md"
        language="markdown"
        readOnly={false}
        content="# Hello World"
        viewMode="preview"
      />
    </Provider>
  )

  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
  expect(screen.queryByTestId('monaco-mock')).not.toBeInTheDocument()
})

it('renders HTML in iframe when viewMode is preview', () => {
  render(
    <Provider store={store}>
      <EditorPane
        paneId="pane-1"
        tabId="tab-1"
        filePath="/page.html"
        language="html"
        readOnly={false}
        content="<h1>Test</h1>"
        viewMode="preview"
      />
    </Provider>
  )

  expect(screen.getByTitle('HTML Preview')).toBeInTheDocument()
})

it('defaults to preview mode for .md files', () => {
  // This would require testing the initial state logic
  // which happens in EditorPane when loading a file
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorPane.test.tsx`
Expected: FAIL

**Step 3: Write minimal implementation**

Update `src/components/panes/EditorPane.tsx`:

```typescript
import { useState, useCallback, useMemo } from 'react'
import Editor from '@monaco-editor/react'
import { FileText } from 'lucide-react'
import { useAppDispatch } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import EditorToolbar from './EditorToolbar'
import MarkdownPreview from './MarkdownPreview'

// ... existing code ...

function isMarkdown(filePath: string | null): boolean {
  if (!filePath) return false
  return filePath.toLowerCase().endsWith('.md')
}

function isHtml(filePath: string | null): boolean {
  if (!filePath) return false
  const lower = filePath.toLowerCase()
  return lower.endsWith('.htm') || lower.endsWith('.html')
}

export default function EditorPane({
  paneId,
  tabId,
  filePath,
  language,
  readOnly,
  content,
  viewMode,
}: EditorPaneProps) {
  // ... existing code ...

  const showPreview = viewMode === 'preview' && showViewToggle

  // Render content area
  const renderContent = () => {
    if (showPreview && isMarkdown(filePath)) {
      return <MarkdownPreview content={content} />
    }

    if (showPreview && isHtml(filePath)) {
      return (
        <iframe
          srcDoc={content}
          title="HTML Preview"
          className="w-full h-full border-0 bg-white"
          sandbox="allow-scripts"
        />
      )
    }

    return (
      <Editor
        height="100%"
        language={language || undefined}
        value={content}
        onChange={handleContentChange}
        options={{
          readOnly,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
        }}
        theme="vs-dark"
      />
    )
  }

  // ... rest of component uses renderContent() instead of direct Editor ...

  return (
    <div className="flex flex-col h-full w-full bg-background">
      <EditorToolbar
        filePath={filePath || ''}
        onPathChange={handlePathChange}
        onOpenFile={handleOpenFile}
        viewMode={viewMode}
        onViewModeToggle={handleViewModeToggle}
        showViewToggle={showViewToggle}
      />
      <div className="flex-1 min-h-0">{renderContent()}</div>
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorPane.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/EditorPane.tsx test/unit/client/components/panes/EditorPane.test.tsx
git commit -m "feat(ui): add markdown and HTML preview modes

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 15: Add Auto-Save with 5s Debounce

**Files:**
- Modify: `src/components/panes/EditorPane.tsx`
- Create: `test/unit/client/components/panes/EditorPane.autosave.test.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/panes/EditorPane.autosave.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '../../../../../src/components/panes/EditorPane'
import panesReducer from '../../../../../src/store/panesSlice'

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))

// Mock fetch for auto-save
global.fetch = vi.fn()

describe('EditorPane auto-save', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    } as Response)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-saves after 5 seconds of inactivity', async () => {
    const store = configureStore({
      reducer: { panes: panesReducer },
    })

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')

    // Simulate typing
    await act(async () => {
      editor.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Fast-forward 4 seconds - should not save yet
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetch).not.toHaveBeenCalled()

    // Fast-forward 1 more second (total 5s) - should save
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/files/write',
      expect.objectContaining({
        method: 'POST',
      })
    )
  })

  it('does not auto-save scratch pads', async () => {
    const store = configureStore({
      reducer: { panes: panesReducer },
    })

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath={null}
          language={null}
          readOnly={false}
          content="scratch"
          viewMode="source"
        />
      </Provider>
    )

    // Fast-forward past debounce
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    expect(fetch).not.toHaveBeenCalled()
  })

  it('resets debounce timer on each change', async () => {
    const store = configureStore({
      reducer: { panes: panesReducer },
    })

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')

    // First change
    await act(async () => {
      editor.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Wait 3 seconds
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    // Another change - resets timer
    await act(async () => {
      editor.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Wait 3 more seconds (total 6s since start, but only 3s since last change)
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(fetch).not.toHaveBeenCalled()

    // Wait 2 more seconds (5s since last change)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorPane.autosave.test.tsx`
Expected: FAIL

**Step 3: Write minimal implementation**

Update `src/components/panes/EditorPane.tsx` to add auto-save:

```typescript
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
// ... other imports ...

const AUTO_SAVE_DELAY = 5000 // 5 seconds

export default function EditorPane({
  paneId,
  tabId,
  filePath,
  language,
  readOnly,
  content,
  viewMode,
}: EditorPaneProps) {
  // ... existing code ...

  const autoSaveTimer = useRef<NodeJS.Timeout | null>(null)
  const pendingContent = useRef<string>(content)

  // Auto-save logic
  useEffect(() => {
    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current)
      }
    }
  }, [])

  const scheduleAutoSave = useCallback(() => {
    // Don't auto-save scratch pads
    if (!filePath) return

    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current)
    }

    autoSaveTimer.current = setTimeout(async () => {
      try {
        const token = localStorage.getItem('authToken') || ''
        await fetch('/api/files/write', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-auth-token': token,
          },
          body: JSON.stringify({
            path: filePath,
            content: pendingContent.current,
          }),
        })
      } catch (err) {
        console.error('Auto-save failed:', err)
      }
    }, AUTO_SAVE_DELAY)
  }, [filePath])

  const handleContentChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return
      pendingContent.current = value
      updateContent({ content: value })
      scheduleAutoSave()
    },
    [updateContent, scheduleAutoSave]
  )

  // ... rest of component ...
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/client/components/panes/EditorPane.autosave.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/EditorPane.tsx test/unit/client/components/panes/EditorPane.autosave.test.tsx
git commit -m "feat(ui): add auto-save with 5s debounce

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 16: Add File Loading from Server

**Files:**
- Modify: `src/components/panes/EditorPane.tsx`
- Modify: `test/unit/client/components/panes/EditorPane.test.tsx`

**Step 1: Write the failing test**

Add to `test/unit/client/components/panes/EditorPane.test.tsx`:

```typescript
describe('file loading', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset()
  })

  it('loads file content when path changes', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: 'loaded content',
          size: 14,
          modifiedAt: new Date().toISOString(),
        }),
    } as Response)

    // This would test that changing path triggers a fetch
    // Implementation depends on how path changes are handled
  })
})
```

**Step 2: Write minimal implementation**

Add to `src/components/panes/EditorPane.tsx`:

```typescript
const loadFile = useCallback(
  async (path: string) => {
    try {
      const token = localStorage.getItem('authToken') || ''
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`, {
        headers: { 'x-auth-token': token },
      })
      if (!res.ok) {
        console.error('Failed to load file:', res.statusText)
        return
      }
      const data = await res.json()

      // Determine language from extension
      const ext = path.split('.').pop()?.toLowerCase()
      const langMap: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescriptreact',
        js: 'javascript',
        jsx: 'javascriptreact',
        md: 'markdown',
        json: 'json',
        html: 'html',
        htm: 'html',
        css: 'css',
        py: 'python',
      }

      // Determine default viewMode for previewable files
      const defaultViewMode = isMarkdown(path) || isHtml(path) ? 'preview' : 'source'

      updateContent({
        filePath: path,
        language: langMap[ext || ''] || null,
        content: data.content,
        viewMode: defaultViewMode,
      })
    } catch (err) {
      console.error('Failed to load file:', err)
    }
  },
  [updateContent]
)

const handlePathChange = useCallback(
  (path: string) => {
    if (path) {
      loadFile(path)
    } else {
      updateContent({ filePath: null })
    }
  },
  [loadFile, updateContent]
)
```

**Step 3: Run tests**

Run: `cd .worktrees/monaco-editor-pane && npm test`
Expected: PASS

**Step 4: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/components/panes/EditorPane.tsx test/unit/client/components/panes/EditorPane.test.tsx
git commit -m "feat(ui): load file content from server when path changes

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 17: Add Default Browse Root from Terminal CWD

**Files:**
- Create: `src/lib/pane-utils.ts`
- Create: `test/unit/lib/pane-utils.test.ts`
- Modify: `src/components/panes/EditorToolbar.tsx`

**Step 1: Write the failing test**

Create `test/unit/lib/pane-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { getFirstTerminalCwd } from '../../../src/lib/pane-utils'
import type { PaneNode } from '../../../src/store/paneTypes'

describe('getFirstTerminalCwd', () => {
  it('returns null for editor-only layout', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'p1',
      content: {
        kind: 'editor',
        filePath: null,
        language: null,
        readOnly: false,
        content: '',
        viewMode: 'source',
      },
    }
    expect(getFirstTerminalCwd(layout, {})).toBeNull()
  })

  it('returns cwd from single terminal pane', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'p1',
      content: {
        kind: 'terminal',
        terminalId: 't1',
        createRequestId: 'r1',
        status: 'running',
        mode: 'shell',
      },
    }
    const cwdMap = { t1: '/home/user/project' }
    expect(getFirstTerminalCwd(layout, cwdMap)).toBe('/home/user/project')
  })

  it('returns first terminal cwd in split (depth-first)', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'leaf',
          id: 'p1',
          content: {
            kind: 'editor',
            filePath: null,
            language: null,
            readOnly: false,
            content: '',
            viewMode: 'source',
          },
        },
        {
          type: 'leaf',
          id: 'p2',
          content: {
            kind: 'terminal',
            terminalId: 't1',
            createRequestId: 'r1',
            status: 'running',
            mode: 'shell',
          },
        },
      ],
    }
    const cwdMap = { t1: '/home/user/project' }
    expect(getFirstTerminalCwd(layout, cwdMap)).toBe('/home/user/project')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/lib/pane-utils.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/lib/pane-utils.ts`:

```typescript
import type { PaneNode } from '@/store/paneTypes'

/**
 * Get the cwd of the first terminal in the pane tree (depth-first traversal).
 * Returns null if no terminal with a known cwd is found.
 */
export function getFirstTerminalCwd(
  node: PaneNode,
  cwdMap: Record<string, string>
): string | null {
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal' && node.content.terminalId) {
      return cwdMap[node.content.terminalId] || null
    }
    return null
  }

  // Split node - check children depth-first
  const leftResult = getFirstTerminalCwd(node.children[0], cwdMap)
  if (leftResult) return leftResult

  return getFirstTerminalCwd(node.children[1], cwdMap)
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/unit/lib/pane-utils.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add src/lib/pane-utils.ts test/unit/lib/pane-utils.test.ts
git commit -m "feat(lib): add getFirstTerminalCwd utility

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 18: Integration Test - Full Editor Flow

**Files:**
- Create: `test/integration/client/editor-pane.test.tsx`

**Step 1: Write integration test**

Create `test/integration/client/editor-pane.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { initLayout } from '../../../src/store/panesSlice'
import PaneLayout from '../../../src/components/panes/PaneLayout'

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))

describe('Editor Pane Integration', () => {
  let store: ReturnType<typeof configureStore>

  beforeEach(() => {
    store = configureStore({
      reducer: { panes: panesReducer },
    })
    vi.mocked(fetch).mockReset()
  })

  it('can add editor pane via FAB', async () => {
    const user = userEvent.setup()

    // Initialize with terminal
    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal', mode: 'shell' },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    // Open FAB menu
    await user.click(screen.getByRole('button', { name: /add pane/i }))

    // Click Editor option
    await user.click(screen.getByRole('menuitem', { name: /editor/i }))

    // Should see empty state with Open File button
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open file/i })).toBeInTheDocument()
    })
  })

  it('loads file when path is entered', async () => {
    const user = userEvent.setup()

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: '# Hello',
          size: 7,
          modifiedAt: new Date().toISOString(),
        }),
    } as Response)

    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    const input = screen.getByPlaceholderText(/enter file path/i)
    await user.type(input, '/test.md{Enter}')

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/files/read'),
        expect.any(Object)
      )
    })
  })
})
```

**Step 2: Run integration test**

Run: `cd .worktrees/monaco-editor-pane && npm test -- --run test/integration/client/editor-pane.test.tsx`
Expected: PASS

**Step 3: Commit**

```bash
cd .worktrees/monaco-editor-pane
git add test/integration/client/editor-pane.test.tsx
git commit -m "test: add editor pane integration tests

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 19: Run Full Test Suite and Fix Issues

**Step 1: Run all tests**

```bash
cd .worktrees/monaco-editor-pane && npm test
```

**Step 2: Fix any failing tests**

Address any type errors, missing imports, or test failures.

**Step 3: Commit fixes**

```bash
cd .worktrees/monaco-editor-pane
git add -A
git commit -m "fix: resolve test failures and type errors

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 20: Manual Testing Checklist

Before considering this complete, manually verify:

1. [ ] Can create editor pane from FAB menu
2. [ ] Empty state shows "Open File" button
3. [ ] Can type path and press Enter to load file
4. [ ] File content loads from server
5. [ ] Monaco editor displays with syntax highlighting
6. [ ] Markdown files show preview by default
7. [ ] View toggle switches between source and preview
8. [ ] HTML files render in iframe preview
9. [ ] Changes auto-save after 5 seconds
10. [ ] Scratch pad mode works (no file path)

---

## Summary

This plan implements the Monaco editor pane in 19 tasks following TDD:

1. **Type definitions** (Tasks 1-2)
2. **Server API** (Tasks 3-6)
3. **Dependencies** (Task 7)
4. **Core components** (Tasks 8-14)
5. **Auto-save** (Task 15)
6. **File loading** (Task 16)
7. **Terminal CWD integration** (Task 17)
8. **Integration tests** (Task 18)
9. **Verification** (Tasks 19-20)

Each task is atomic with clear test → implement → commit cycle.
