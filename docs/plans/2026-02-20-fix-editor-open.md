# Fix External Editor / File Opening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the broken "Open with system viewer" feature on WSL2, add a configurable external editor setting with line/column support, and provide proper error feedback.

**Architecture:** Extract file-opening logic from the inline `files-router.ts` switch into a dedicated `server/file-opener.ts` module that uses the existing `detectPlatform()` for WSL2 awareness. Add an `editor.externalEditor` setting (enum: `auto|cursor|code|custom`) across all layers (types, schema, defaults, merge, UI). Extend the `/api/files/open` API with optional `line`/`column` params and propagate them from EditorPane's Monaco cursor position.

**Tech Stack:** Node.js (child_process), Zod, React, Redux Toolkit, Monaco Editor

---

## Task 1: Create `server/file-opener.ts` with platform-aware open logic

**Files:**
- Create: `server/file-opener.ts`
- Create: `test/unit/server/file-opener.test.ts`

This module encapsulates all file-opening logic: platform detection, editor presets, template substitution, and spawn management.

**Step 1: Write the failing tests**

```typescript
// test/unit/server/file-opener.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock child_process
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

// Mock platform detection
const mockDetectPlatform = vi.fn()
vi.mock('../../server/platform', () => ({
  detectPlatform: () => mockDetectPlatform(),
}))

const { resolveOpenCommand } = await import('../../server/file-opener')

describe('resolveOpenCommand', () => {
  describe('with no custom editor configured (auto)', () => {
    it('uses "open" on macOS', async () => {
      mockDetectPlatform.mockResolvedValue('darwin')
      const result = await resolveOpenCommand({
        filePath: '/Users/me/file.ts',
        platform: 'darwin',
      })
      expect(result.command).toBe('open')
      expect(result.args).toEqual(['/Users/me/file.ts'])
    })

    it('uses "open -R" for reveal on macOS', async () => {
      mockDetectPlatform.mockResolvedValue('darwin')
      const result = await resolveOpenCommand({
        filePath: '/Users/me/file.ts',
        reveal: true,
        platform: 'darwin',
      })
      expect(result.command).toBe('open')
      expect(result.args).toEqual(['-R', '/Users/me/file.ts'])
    })

    it('uses "cmd /c start" on win32', async () => {
      const result = await resolveOpenCommand({
        filePath: 'C:\\Users\\me\\file.ts',
        platform: 'win32',
      })
      expect(result.command).toBe('cmd')
      expect(result.args).toEqual(['/c', 'start', '', 'C:\\Users\\me\\file.ts'])
    })

    it('uses "explorer.exe /select," for reveal on win32', async () => {
      const result = await resolveOpenCommand({
        filePath: 'C:\\Users\\me\\file.ts',
        reveal: true,
        platform: 'win32',
      })
      expect(result.command).toBe('explorer.exe')
      expect(result.args).toEqual(['/select,', 'C:\\Users\\me\\file.ts'])
    })

    it('uses "xdg-open" on native linux', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        platform: 'linux',
      })
      expect(result.command).toBe('xdg-open')
      expect(result.args).toEqual(['/home/user/file.ts'])
    })

    it('uses "explorer.exe /select," for reveal on WSL2', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        reveal: true,
        platform: 'wsl',
      })
      expect(result.command).toBe('explorer.exe')
    })

    it('uses "cmd.exe /c start" for non-reveal on WSL2 (no editor)', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        platform: 'wsl',
      })
      // WSL2 auto: falls back to Windows start command
      expect(result.command).toBe('/mnt/c/Windows/System32/cmd.exe')
      expect(result.args).toEqual(['/c', 'start', '', '/home/user/file.ts'])
    })
  })

  describe('with editor preset', () => {
    it('uses cursor with -r -g and line:col', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        line: 42,
        column: 10,
        editorSetting: 'cursor',
        platform: 'linux',
      })
      expect(result.command).toBe('cursor')
      expect(result.args).toEqual(['-r', '-g', '/home/user/file.ts:42:10'])
    })

    it('uses code with -g and line:col', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        line: 5,
        editorSetting: 'code',
        platform: 'linux',
      })
      expect(result.command).toBe('code')
      expect(result.args).toEqual(['-g', '/home/user/file.ts:5'])
    })

    it('omits line:col when not provided', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        editorSetting: 'cursor',
        platform: 'linux',
      })
      expect(result.command).toBe('cursor')
      expect(result.args).toEqual(['-r', '-g', '/home/user/file.ts'])
    })

    it('falls back to platform default for reveal even with editor set', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        reveal: true,
        editorSetting: 'cursor',
        platform: 'darwin',
      })
      // reveal always uses the platform file manager, not the editor
      expect(result.command).toBe('open')
      expect(result.args).toEqual(['-R', '/home/user/file.ts'])
    })
  })

  describe('with custom editor template', () => {
    it('substitutes {file}, {line}, {col} placeholders', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        line: 10,
        column: 5,
        editorSetting: 'custom',
        customEditorCommand: 'nvim +{line} {file}',
        platform: 'linux',
      })
      expect(result.command).toBe('nvim')
      expect(result.args).toEqual(['+10', '/home/user/file.ts'])
    })

    it('removes unfilled placeholders when line/col not provided', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        editorSetting: 'custom',
        customEditorCommand: 'myeditor --file {file} --line {line}',
        platform: 'linux',
      })
      expect(result.command).toBe('myeditor')
      expect(result.args).toEqual(['--file', '/home/user/file.ts'])
    })

    it('falls back to auto when custom is set but command is empty', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        editorSetting: 'custom',
        customEditorCommand: '',
        platform: 'darwin',
      })
      expect(result.command).toBe('open')
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/file-opener.test.ts`
Expected: FAIL — module `../../server/file-opener` does not exist

**Step 3: Write minimal implementation**

```typescript
// server/file-opener.ts
import path from 'path'

export type EditorPreset = 'auto' | 'cursor' | 'code' | 'custom'

export interface ResolveOpenCommandOptions {
  filePath: string
  reveal?: boolean
  line?: number
  column?: number
  editorSetting?: EditorPreset
  customEditorCommand?: string
  /** Pre-resolved platform string from detectPlatform(). */
  platform: string
}

export interface OpenCommand {
  command: string
  args: string[]
}

function buildLocationSuffix(line?: number, column?: number): string {
  if (line == null) return ''
  return column != null ? `:${line}:${column}` : `:${line}`
}

function resolveEditorPreset(
  preset: 'cursor' | 'code',
  filePath: string,
  line?: number,
  column?: number,
): OpenCommand {
  const location = buildLocationSuffix(line, column)
  switch (preset) {
    case 'cursor':
      return { command: 'cursor', args: ['-r', '-g', `${filePath}${location}`] }
    case 'code':
      return { command: 'code', args: ['-g', `${filePath}${location}`] }
  }
}

function parseCustomTemplate(
  template: string,
  filePath: string,
  line?: number,
  column?: number,
): OpenCommand | null {
  if (!template.trim()) return null

  const parts = template.trim().split(/\s+/)
  const command = parts[0]
  const args = parts.slice(1)
    .map((arg) => {
      let result = arg.replace(/\{file\}/g, filePath)
      if (line != null) {
        result = result.replace(/\{line\}/g, String(line))
      }
      if (column != null) {
        result = result.replace(/\{col\}/g, String(column))
      }
      return result
    })
    // Remove args that still contain unfilled placeholders
    .filter((arg) => !arg.match(/\{(line|col)\}/))

  return { command, args }
}

function platformReveal(platform: string, filePath: string): OpenCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', filePath] }
    case 'win32':
      return { command: 'explorer.exe', args: ['/select,', filePath] }
    case 'wsl':
      return { command: 'explorer.exe', args: ['/select,', filePath] }
    default:
      return { command: 'xdg-open', args: [path.dirname(filePath)] }
  }
}

function platformOpen(platform: string, filePath: string): OpenCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [filePath] }
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '', filePath] }
    case 'wsl':
      return {
        command: '/mnt/c/Windows/System32/cmd.exe',
        args: ['/c', 'start', '', filePath],
      }
    default:
      return { command: 'xdg-open', args: [filePath] }
  }
}

export async function resolveOpenCommand(
  options: ResolveOpenCommandOptions,
): Promise<OpenCommand> {
  const {
    filePath,
    reveal,
    line,
    column,
    editorSetting = 'auto',
    customEditorCommand,
    platform,
  } = options

  // Reveal always uses platform file manager, regardless of editor setting
  if (reveal) {
    return platformReveal(platform, filePath)
  }

  // Check for explicit editor setting
  if (editorSetting === 'cursor' || editorSetting === 'code') {
    return resolveEditorPreset(editorSetting, filePath, line, column)
  }

  if (editorSetting === 'custom' && customEditorCommand) {
    const parsed = parseCustomTemplate(customEditorCommand, filePath, line, column)
    if (parsed) return parsed
  }

  // Auto / fallback: platform default
  return platformOpen(platform, filePath)
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/file-opener.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/file-opener.ts test/unit/server/file-opener.test.ts
git commit -m "feat: add file-opener module with platform-aware open logic

Extract file-opening into a dedicated module that handles macOS, Windows,
WSL2, and Linux. Supports editor presets (cursor, code) with line:column,
custom template commands, and platform-appropriate reveal/open defaults.
WSL2 uses cmd.exe directly instead of unreliable xdg-open chain."
```

---

## Task 2: Add `editor` settings to schema, types, and defaults

**Files:**
- Modify: `src/store/types.ts:124-174` (add `editor` to `AppSettings`)
- Modify: `src/store/settingsSlice.ts:9-63` (add default)
- Modify: `src/store/settingsSlice.ts:87-124` (add merge logic)
- Modify: `server/config-store.ts:32-96` (add to server `AppSettings`)
- Modify: `server/config-store.ts:133-187` (add to `defaultSettings`)
- Modify: `server/config-store.ts:380-421` (add to `mergeSettings`)
- Modify: `server/settings-schema.ts:13-113` (add Zod schema)
- Create: `test/unit/server/editor-settings.test.ts`
- Modify: `test/unit/client/store/settingsSlice.test.ts` (if it exists, add merge test)

The setting shape:

```typescript
editor?: {
  externalEditor: 'auto' | 'cursor' | 'code' | 'custom'
  customEditorCommand?: string
}
```

**Step 1: Write the failing test**

Add tests to the existing settings test infrastructure to verify the new `editor` setting is properly merged, defaulted, and schema-validated.

```typescript
// test/unit/server/editor-settings.test.ts
import { describe, it, expect } from 'vitest'
import { SettingsPatchSchema } from '../../../server/settings-schema'

describe('editor settings schema', () => {
  it('accepts valid editor preset', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: { externalEditor: 'cursor' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts custom editor with command', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: {
        externalEditor: 'custom',
        customEditorCommand: 'nvim +{line} {file}',
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown editor preset', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: { externalEditor: 'emacs' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown keys inside editor (strict)', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: { externalEditor: 'auto', unknownKey: true },
    })
    expect(result.success).toBe(false)
  })

  it('accepts empty editor object', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: {},
    })
    expect(result.success).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/editor-settings.test.ts`
Expected: FAIL — `editor` key rejected by `.strict()` on the schema

**Step 3: Add the setting across all layers**

Add to `server/settings-schema.ts` (inside `SettingsPatchSchema`):
```typescript
editor: z
  .object({
    externalEditor: z.enum(['auto', 'cursor', 'code', 'custom']).optional(),
    customEditorCommand: z.string().optional(),
  })
  .strict()
  .optional(),
```

Add to `server/config-store.ts` `AppSettings` type:
```typescript
editor: {
  externalEditor: 'auto' | 'cursor' | 'code' | 'custom'
  customEditorCommand?: string
}
```

Add to `server/config-store.ts` `defaultSettings`:
```typescript
editor: {
  externalEditor: 'auto',
},
```

Add to `server/config-store.ts` `mergeSettings()`:
```typescript
editor: { ...base.editor, ...(patch.editor || {}) },
```

Add to `src/store/types.ts` `AppSettings`:
```typescript
editor: {
  externalEditor: 'auto' | 'cursor' | 'code' | 'custom'
  customEditorCommand?: string
}
```

Add to `src/store/settingsSlice.ts` `defaultSettings`:
```typescript
editor: {
  externalEditor: 'auto' as const,
},
```

Add to `src/store/settingsSlice.ts` `mergeSettings()`:
```typescript
editor: { ...base.editor, ...(patch.editor || {}) },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/editor-settings.test.ts`
Expected: PASS

**Step 5: Run full test suite to check for regressions**

Run: `npx vitest run test/unit/server/files-router.test.ts test/unit/server/file-opener.test.ts test/unit/server/editor-settings.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add server/settings-schema.ts server/config-store.ts src/store/types.ts src/store/settingsSlice.ts test/unit/server/editor-settings.test.ts
git commit -m "feat: add editor.externalEditor setting across all layers

Add 'editor' settings group with externalEditor enum (auto|cursor|code|custom)
and optional customEditorCommand template string. Added to client types, server
types, Zod validation schema, default settings, and merge logic on both sides."
```

---

## Task 3: Wire `files-router.ts` to use `file-opener.ts` and accept line/column

**Files:**
- Modify: `server/files-router.ts:175-220`
- Modify: `test/unit/server/files-router.test.ts:197-245`

**Step 1: Write failing tests for the new API parameters**

Add to the existing `describe('POST /api/files/open')` block in `test/unit/server/files-router.test.ts`:

```typescript
it('passes line and column to the opener', async () => {
  mockGetSettings.mockResolvedValue({
    allowedFilePaths: undefined,
    editor: { externalEditor: 'cursor' },
  })
  mockStat.mockResolvedValue({ isFile: () => true })
  mockSpawn.mockReturnValue({ unref: vi.fn() })

  const res = await request(app)
    .post('/api/files/open')
    .send({ path: '/home/user/file.ts', line: 42, column: 10 })

  expect(res.status).toBe(200)
  expect(mockSpawn).toHaveBeenCalledWith(
    'cursor',
    ['-r', '-g', '/home/user/file.ts:42:10'],
    expect.any(Object),
  )
})

it('uses configured editor setting', async () => {
  mockGetSettings.mockResolvedValue({
    allowedFilePaths: undefined,
    editor: { externalEditor: 'code' },
  })
  mockStat.mockResolvedValue({ isFile: () => true })
  mockSpawn.mockReturnValue({ unref: vi.fn() })

  const res = await request(app)
    .post('/api/files/open')
    .send({ path: '/home/user/file.ts' })

  expect(res.status).toBe(200)
  expect(mockSpawn).toHaveBeenCalledWith(
    'code',
    ['-g', '/home/user/file.ts'],
    expect.any(Object),
  )
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/files-router.test.ts`
Expected: FAIL — current implementation ignores line/column and editor setting

**Step 3: Rewrite the open endpoint to use `file-opener.ts`**

Replace the body of `filesRouter.post('/open', ...)` in `server/files-router.ts`:

```typescript
import { detectPlatform } from './platform.js'
import { resolveOpenCommand } from './file-opener.js'

filesRouter.post('/open', validatePath, async (req, res) => {
  const { path: filePath, reveal, line, column } = req.body || {}
  if (!filePath) {
    return res.status(400).json({ error: 'path is required' })
  }

  const resolved = await resolveUserFilesystemPath(filePath)

  try {
    await fsp.stat(resolved)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' })
    }
    return res.status(500).json({ error: err.message })
  }

  const settings = await configStore.getSettings()
  const platform = await detectPlatform()

  const { command, args } = await resolveOpenCommand({
    filePath: resolved,
    reveal,
    line: typeof line === 'number' ? line : undefined,
    column: typeof column === 'number' ? column : undefined,
    editorSetting: settings.editor?.externalEditor,
    customEditorCommand: settings.editor?.customEditorCommand,
    platform,
  })

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return res.json({ ok: true })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/server/files-router.test.ts test/unit/server/file-opener.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add server/files-router.ts test/unit/server/files-router.test.ts
git commit -m "feat: wire files-router to file-opener with line/column support

Replace inline platform switch with file-opener module. The /api/files/open
endpoint now accepts optional line and column parameters and reads the
editor.externalEditor setting to choose the right command."
```

---

## Task 4: Pass cursor position from EditorPane

**Files:**
- Modify: `src/components/panes/EditorPane.tsx:627-642`
- Modify: `src/lib/pane-action-registry.ts:12-22`

**Step 1: Write failing test**

```typescript
// In existing EditorPane test file or create test/unit/client/components/panes/EditorPane.open.test.ts
// Verify that openSystemViewer sends line/column from the Monaco editor position
```

Note: Since EditorPane is tightly coupled to Monaco (a browser-only component), this is better tested via integration/browser-use tests. For TDD, we'll add a unit test for the action registry type change and manually verify.

**Step 2: Update EditorActions type**

In `src/lib/pane-action-registry.ts`, add a `getPosition` method:

```typescript
export type EditorActions = {
  cut: () => Promise<void> | void
  copy: () => Promise<void> | void
  paste: () => Promise<void> | void
  selectAll: () => Promise<void> | void
  saveNow: () => Promise<void> | void
  togglePreview: () => void
  copyPath: () => Promise<void> | void
  revealInExplorer: () => Promise<void> | void
  openInEditor: () => Promise<void> | void  // renamed from openWithSystemViewer
}
```

**Step 3: Update EditorPane to pass cursor position**

In `src/components/panes/EditorPane.tsx`, modify `openSystemViewer`:

```typescript
const openInEditor = useCallback(async (reveal: boolean) => {
  const resolved = resolvePath(filePath)
  if (!resolved) return

  // Read cursor position from Monaco editor
  const position = editorRef.current?.getPosition()

  try {
    await api.post('/api/files/open', {
      path: resolved,
      reveal,
      line: position?.lineNumber,
      column: position?.column,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(
      JSON.stringify({
        severity: 'error',
        event: 'editor_open_external_failed',
        error: message,
      })
    )
  }
}, [filePath, resolvePath])
```

Update the action registration accordingly.

**Step 4: Update context menu label**

In `src/components/context-menu/menu-defs.ts`, rename the label:

```typescript
{ type: 'item', id: 'editor-open', label: 'Open in external editor', onSelect: () => editorActions?.openInEditor(), disabled: !editorActions },
```

**Step 5: Run lint and type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/components/panes/EditorPane.tsx src/lib/pane-action-registry.ts src/components/context-menu/menu-defs.ts
git commit -m "feat: pass cursor line/column when opening files in editor

EditorPane now reads Monaco's cursor position and sends line/column
to the /api/files/open API. Renamed action from openWithSystemViewer
to openInEditor for clarity."
```

---

## Task 5: Add spawn health check with timeout

**Files:**
- Modify: `server/file-opener.ts` (add `spawnAndMonitor` function)
- Modify: `server/files-router.ts` (use `spawnAndMonitor` instead of raw `spawn`)
- Modify: `test/unit/server/file-opener.test.ts`

**Step 1: Write the failing test**

```typescript
describe('spawnAndMonitor', () => {
  it('returns ok when process does not exit within timeout', async () => {
    // Mock spawn returning a process that stays alive
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(), // never calls the 'error' or 'exit' callback
      removeListener: vi.fn(),
    })
    const { spawnAndMonitor } = await import('../../server/file-opener')
    const result = await spawnAndMonitor({ command: 'cursor', args: ['-g', 'file.ts'] })
    expect(result.ok).toBe(true)
  })

  it('returns error when process exits immediately with non-zero', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') setTimeout(() => cb(127), 10) // ENOENT-like
      }),
      removeListener: vi.fn(),
    })
    const { spawnAndMonitor } = await import('../../server/file-opener')
    const result = await spawnAndMonitor({ command: 'nonexistent', args: [] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exited')
  })

  it('returns error when spawn emits error event', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn((event: string, cb: (err: Error) => void) => {
        if (event === 'error') setTimeout(() => cb(new Error('ENOENT')), 10)
      }),
      removeListener: vi.fn(),
    })
    const { spawnAndMonitor } = await import('../../server/file-opener')
    const result = await spawnAndMonitor({ command: 'nonexistent', args: [] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ENOENT')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/file-opener.test.ts`
Expected: FAIL — `spawnAndMonitor` doesn't exist

**Step 3: Implement `spawnAndMonitor`**

Add to `server/file-opener.ts`:

```typescript
import { spawn } from 'child_process'

export interface SpawnResult {
  ok: boolean
  error?: string
}

const HEALTH_CHECK_TIMEOUT_MS = 2000

export function spawnAndMonitor(cmd: OpenCommand): Promise<SpawnResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore' })
      child.unref()

      let settled = false

      const onError = (err: Error) => {
        if (settled) return
        settled = true
        child.removeListener('exit', onExit)
        resolve({ ok: false, error: `Failed to launch "${cmd.command}": ${err.message}` })
      }

      const onExit = (code: number | null) => {
        if (settled) return
        settled = true
        child.removeListener('error', onError)
        if (code !== null && code !== 0) {
          resolve({ ok: false, error: `"${cmd.command}" exited with code ${code}` })
        }
        // code === 0 or null (still running) — both fine
      }

      child.on('error', onError)
      child.on('exit', onExit)

      // If no error/exit within timeout, assume success
      setTimeout(() => {
        if (settled) return
        settled = true
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        resolve({ ok: true })
      }, HEALTH_CHECK_TIMEOUT_MS)
    } catch (err: any) {
      resolve({ ok: false, error: err.message })
    }
  })
}
```

**Step 4: Wire into files-router**

Update `server/files-router.ts` to use `spawnAndMonitor` instead of raw `spawn`:

```typescript
import { resolveOpenCommand, spawnAndMonitor } from './file-opener.js'

// In the open handler, replace the spawn block:
const result = await spawnAndMonitor({ command, args })
if (!result.ok) {
  return res.status(502).json({ error: result.error })
}
return res.json({ ok: true })
```

**Step 5: Run tests**

Run: `npx vitest run test/unit/server/file-opener.test.ts test/unit/server/files-router.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add server/file-opener.ts server/files-router.ts test/unit/server/file-opener.test.ts
git commit -m "feat: add spawn health check with 2s timeout

spawnAndMonitor watches for early exit (code != 0) or error events within
2 seconds. Returns structured result so the API can report failures to
the client instead of silently succeeding."
```

---

## Task 6: Add settings UI for external editor

**Files:**
- Modify: `src/components/SettingsView.tsx`

**Step 1: Add the Editor section to SettingsView**

Add a new `SettingsSection` after the existing sections (follow the pattern of Appearance, Terminal, etc.):

```tsx
<SettingsSection title="Editor" description="External editor for file opening">
  <SettingsRow label="External editor" description="Which editor to use when opening files from the editor pane">
    <select
      value={settings.editor?.externalEditor ?? 'auto'}
      onChange={(e) => {
        const value = e.target.value as 'auto' | 'cursor' | 'code' | 'custom'
        dispatch(updateSettingsLocal({ editor: { externalEditor: value } }))
        scheduleSave({ editor: { externalEditor: value } })
      }}
      className="..."
    >
      <option value="auto">Auto (system default)</option>
      <option value="cursor">Cursor</option>
      <option value="code">VS Code</option>
      <option value="custom">Custom command</option>
    </select>
  </SettingsRow>
  {settings.editor?.externalEditor === 'custom' && (
    <SettingsRow
      label="Custom command"
      description="Command template. Use {file}, {line}, {col} as placeholders."
    >
      <input
        type="text"
        value={settings.editor?.customEditorCommand ?? ''}
        placeholder="nvim +{line} {file}"
        onChange={(e) => {
          dispatch(updateSettingsLocal({
            editor: { customEditorCommand: e.target.value },
          }))
          scheduleSave({
            editor: { customEditorCommand: e.target.value },
          })
        }}
        className="..."
      />
    </SettingsRow>
  )}
</SettingsSection>
```

**Step 2: Verify visually and with lint**

Run: `npm run lint`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/SettingsView.tsx
git commit -m "feat: add External Editor settings UI

Add Editor section to Settings with a dropdown for editor preset
(Auto, Cursor, VS Code, Custom) and a text input for custom command
template with {file}/{line}/{col} placeholders."
```

---

## Task 7: Run full test suite and verify

**Step 1: Run full test suite**

Run: `npm test`
Expected: Same pass/fail baseline as before (no regressions from our changes)

**Step 2: Manual smoke test**

1. Start dev server: `npm run dev`
2. Open an editor pane with a file
3. Right-click → "Open in external editor"
4. Verify the file opens in the configured editor
5. Change settings to "Cursor" and verify it opens in Cursor at the right line
6. Change to "Custom" and enter a custom command, verify it works
7. Try "Reveal in file explorer" and verify it opens the file manager

**Step 3: Final commit if any fixups needed**

---

## Summary of Changes

| File | Change |
|------|--------|
| `server/file-opener.ts` | **NEW** — Platform-aware file open logic with editor presets, custom templates, spawn monitoring |
| `server/files-router.ts` | Replace inline platform switch with `file-opener` module; add `line`/`column` API params |
| `server/settings-schema.ts` | Add `editor` Zod schema |
| `server/config-store.ts` | Add `editor` to types, defaults, merge |
| `src/store/types.ts` | Add `editor` to `AppSettings` |
| `src/store/settingsSlice.ts` | Add `editor` to defaults and merge |
| `src/lib/pane-action-registry.ts` | Rename `openWithSystemViewer` → `openInEditor` |
| `src/components/panes/EditorPane.tsx` | Pass cursor position to API; use new action name |
| `src/components/context-menu/menu-defs.ts` | Update menu label and action |
| `src/components/SettingsView.tsx` | Add Editor settings section |
| `test/unit/server/file-opener.test.ts` | **NEW** — Tests for resolveOpenCommand and spawnAndMonitor |
| `test/unit/server/editor-settings.test.ts` | **NEW** — Tests for Zod schema validation |
| `test/unit/server/files-router.test.ts` | Add tests for line/column and editor setting |
