# Freshclaude Plugin Injection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow freshclaude sessions to load plugins (which expose skills) at creation time, defaulting to `freshell-orchestration`.

**Architecture:** Add a `plugins` parameter (array of absolute paths to plugin directories) that flows from `ClaudeChatPaneContent` through the WS protocol to `SdkBridge.createSession()`, which maps them to the SDK's `plugins` option on `query()`. The server resolves a default plugin path for `freshell-orchestration` at runtime.

**Tech Stack:** TypeScript, Zod (WS protocol), React/Redux (client), Node.js (server), Vitest (tests)

---

### Task 1: Add `plugins` to WS Protocol Schema

**Files:**
- Modify: `shared/ws-protocol.ts:260-268`
- Test: `test/unit/server/ws-handler-sdk.test.ts`

**Step 1: Write the failing test**

In `test/unit/server/ws-handler-sdk.test.ts`, add a test in the `schema parsing` describe block (after the existing `sdk.create` tests around line 63):

```typescript
it('parses sdk.create with plugins array', () => {
  const result = SdkCreateSchema.safeParse({
    type: 'sdk.create',
    requestId: 'req-1',
    cwd: '/home/user/project',
    plugins: ['/path/to/.claude/plugins/my-skill'],
  })
  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data.plugins).toEqual(['/path/to/.claude/plugins/my-skill'])
  }
})

it('parses sdk.create without plugins (optional)', () => {
  const result = SdkCreateSchema.safeParse({
    type: 'sdk.create',
    requestId: 'req-1',
  })
  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data.plugins).toBeUndefined()
  }
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/ws-handler-sdk.test.ts`
Expected: FAIL — `plugins` not recognized by schema

**Step 3: Add plugins to SdkCreateSchema**

In `shared/ws-protocol.ts:260-268`, add the `plugins` field:

```typescript
export const SdkCreateSchema = z.object({
  type: z.literal('sdk.create'),
  requestId: z.string().min(1),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  plugins: z.array(z.string()).optional(),
})
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/ws-handler-sdk.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "feat(ws-protocol): add plugins field to SdkCreateSchema"
```

---

### Task 2: Add `plugins` to SdkBridge.createSession()

**Files:**
- Modify: `server/sdk-bridge.ts:44-96`
- Test: `test/unit/server/sdk-bridge.test.ts`

**Step 1: Write the failing tests**

In `test/unit/server/sdk-bridge.test.ts`, add a new describe block after the `effort option` describe (around line 517):

```typescript
describe('plugins option', () => {
  it('passes plugins to SDK query options as SdkPluginConfig array', async () => {
    await bridge.createSession({
      cwd: '/tmp',
      plugins: ['/path/to/plugin-a', '/path/to/plugin-b'],
    })
    expect(mockQueryOptions?.plugins).toEqual([
      { type: 'local', path: '/path/to/plugin-a' },
      { type: 'local', path: '/path/to/plugin-b' },
    ])
  })

  it('omits plugins from SDK query options when not set', async () => {
    await bridge.createSession({ cwd: '/tmp' })
    expect(mockQueryOptions?.plugins).toBeUndefined()
  })

  it('passes empty plugins array when given empty array', async () => {
    await bridge.createSession({ cwd: '/tmp', plugins: [] })
    expect(mockQueryOptions?.plugins).toEqual([])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts -t "plugins option"`
Expected: FAIL — `plugins` not accepted by createSession

**Step 3: Add plugins to createSession()**

In `server/sdk-bridge.ts`, modify the `createSession` method signature (line 44) to accept `plugins`:

```typescript
async createSession(options: {
  cwd?: string
  resumeSessionId?: string
  model?: string
  permissionMode?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  plugins?: string[]
}): Promise<SdkSessionState> {
```

Then in the `query()` call (line 75-96), add `plugins` mapping after `settingSources`:

```typescript
const sdkQuery = query({
  prompt: inputIterable as AsyncIterable<any>,
  options: {
    cwd: options.cwd || undefined,
    resume: options.resumeSessionId,
    model: options.model,
    permissionMode: options.permissionMode as any,
    effort: options.effort,
    ...(options.permissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
    pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
    includePartialMessages: true,
    abortController,
    env: cleanEnv,
    stderr: (data: string) => {
      log.warn({ sessionId, data: data.trimEnd() }, 'SDK subprocess stderr')
    },
    canUseTool: async (toolName, input, ctx) => {
      return this.handlePermissionRequest(sessionId, toolName, input as Record<string, unknown>, ctx)
    },
    settingSources: ['user', 'project', 'local'],
    ...(options.plugins && { plugins: options.plugins.map(p => ({ type: 'local' as const, path: p })) }),
  },
})
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts -t "plugins option"`
Expected: PASS

**Step 5: Commit**

```bash
git add server/sdk-bridge.ts test/unit/server/sdk-bridge.test.ts
git commit -m "feat(sdk-bridge): accept plugins option and pass to SDK query"
```

---

### Task 3: Pass plugins through WS handler

**Files:**
- Modify: `server/ws-handler.ts:1372-1378`

**Step 1: Write the failing test**

This is a thin passthrough — the WS handler just passes `m.plugins` to `createSession`. The schema test (Task 1) already validates parsing. Add a focused integration test in `test/unit/server/ws-handler-sdk.test.ts`:

```typescript
it('sdk.create with plugins field is valid in BrowserSdkMessageSchema', () => {
  const { BrowserSdkMessageSchema } = require('../../../shared/ws-protocol.js')
  const result = BrowserSdkMessageSchema.safeParse({
    type: 'sdk.create',
    requestId: 'req-1',
    cwd: '/tmp',
    plugins: ['/path/to/plugin'],
  })
  expect(result.success).toBe(true)
})
```

**Step 2: Run test to verify it passes** (schema already updated in Task 1)

Run: `npx vitest run test/unit/server/ws-handler-sdk.test.ts`
Expected: PASS

**Step 3: Update ws-handler to pass plugins**

In `server/ws-handler.ts:1372-1378`, add `plugins`:

```typescript
const session = await this.sdkBridge.createSession({
  cwd: m.cwd,
  resumeSessionId: m.resumeSessionId,
  model: m.model,
  permissionMode: m.permissionMode,
  effort: m.effort,
  plugins: m.plugins,
})
```

**Step 4: Run all tests to verify nothing broke**

Run: `npx vitest run test/unit/server/`
Expected: PASS

**Step 5: Commit**

```bash
git add server/ws-handler.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "feat(ws-handler): pass plugins from sdk.create to SdkBridge"
```

---

### Task 4: Add `plugins` to ClaudeChatPaneContent and AppSettings

**Files:**
- Modify: `src/store/paneTypes.ts:72-100`
- Modify: `src/store/types.ts:173-177`
- Modify: `server/config-store.ts:97-101`

**Step 1: Add plugins to ClaudeChatPaneContent**

In `src/store/paneTypes.ts`, add after line 91 (`effort` field):

```typescript
/** Plugin paths to load into this session (absolute paths to plugin directories) */
plugins?: string[]
```

**Step 2: Add defaultPlugins to AppSettings.freshclaude**

In `src/store/types.ts:173-177`:

```typescript
freshclaude?: {
  defaultModel?: string
  defaultPermissionMode?: string
  defaultEffort?: 'low' | 'medium' | 'high' | 'max'
  defaultPlugins?: string[]
}
```

**Step 3: Mirror in server config-store types**

In `server/config-store.ts:97-101`:

```typescript
freshclaude?: {
  defaultModel?: string
  defaultPermissionMode?: string
  defaultEffort?: 'low' | 'medium' | 'high' | 'max'
  defaultPlugins?: string[]
}
```

**Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (new optional fields are backwards-compatible)

**Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/types.ts server/config-store.ts
git commit -m "feat(types): add plugins to ClaudeChatPaneContent and AppSettings"
```

---

### Task 5: Wire plugins through client creation flow

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx:430-441`
- Modify: `src/components/claude-chat/ClaudeChatView.tsx:104-112`

**Step 1: Include plugins in createContentForType**

In `src/components/panes/PaneContainer.tsx:430-441`, add `plugins` from settings:

```typescript
const createContentForType = useCallback((type: PanePickerType, cwd?: string): PaneContent => {
  if (type === 'claude-web') {
    const defaults = settings?.freshclaude
    return {
      kind: 'claude-chat',
      createRequestId: nanoid(),
      status: 'creating',
      model: defaults?.defaultModel,
      permissionMode: defaults?.defaultPermissionMode,
      effort: defaults?.defaultEffort,
      plugins: defaults?.defaultPlugins,
      ...(cwd ? { initialCwd: cwd } : {}),
    }
  }
  // ... rest unchanged
```

**Step 2: Include plugins in sdk.create WS message**

In `src/components/claude-chat/ClaudeChatView.tsx:104-112`, add plugins:

```typescript
ws.send({
  type: 'sdk.create',
  requestId: paneContent.createRequestId,
  model: paneContent.model ?? DEFAULT_MODEL,
  permissionMode: paneContent.permissionMode ?? DEFAULT_PERMISSION_MODE,
  effort: paneContent.effort ?? DEFAULT_EFFORT,
  ...(paneContent.initialCwd ? { cwd: paneContent.initialCwd } : {}),
  ...(paneContent.resumeSessionId ? { resumeSessionId: paneContent.resumeSessionId } : {}),
  ...(paneContent.plugins?.length ? { plugins: paneContent.plugins } : {}),
})
```

**Step 3: Run typecheck and existing tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/components/claude-chat/ClaudeChatView.tsx
git commit -m "feat(client): wire plugins through pane creation and sdk.create message"
```

---

### Task 6: Add default freshell-orchestration plugin resolution

**Files:**
- Modify: `server/sdk-bridge.ts` (top of file + createSession)
- Test: `test/unit/server/sdk-bridge.test.ts`

**Step 1: Write the failing test**

```typescript
describe('default plugins', () => {
  it('resolves freshell-orchestration as default when no plugins specified', async () => {
    await bridge.createSession({ cwd: '/tmp' })
    expect(mockQueryOptions?.plugins).toBeDefined()
    expect(mockQueryOptions?.plugins).toHaveLength(1)
    expect(mockQueryOptions?.plugins[0].type).toBe('local')
    expect(mockQueryOptions?.plugins[0].path).toContain('.claude/plugins/freshell-orchestration')
  })

  it('does not add defaults when plugins are explicitly provided', async () => {
    await bridge.createSession({ cwd: '/tmp', plugins: ['/custom/plugin'] })
    expect(mockQueryOptions?.plugins).toEqual([
      { type: 'local', path: '/custom/plugin' },
    ])
  })

  it('does not add defaults when empty plugins array is provided', async () => {
    await bridge.createSession({ cwd: '/tmp', plugins: [] })
    expect(mockQueryOptions?.plugins).toEqual([])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts -t "default plugins"`
Expected: FAIL — currently plugins is undefined when not set

**Step 3: Implement default plugin resolution**

At top of `server/sdk-bridge.ts`, add path resolution:

```typescript
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const DEFAULT_PLUGINS = [
  path.resolve(PROJECT_ROOT, '.claude/plugins/freshell-orchestration'),
]
```

Then update the plugins mapping in `createSession` to use defaults:

```typescript
const resolvedPlugins = options.plugins !== undefined
  ? options.plugins.map(p => ({ type: 'local' as const, path: p }))
  : DEFAULT_PLUGINS.map(p => ({ type: 'local' as const, path: p }))
```

And pass `plugins: resolvedPlugins` directly (not spread-conditionally) in the query options.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts -t "default plugins"`
Expected: PASS

**Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS — the `omits plugins when not set` test from Task 2 will now fail and needs updating to expect the default plugin instead. Update it:

```typescript
it('uses default plugins when not set', async () => {
  await bridge.createSession({ cwd: '/tmp' })
  expect(mockQueryOptions?.plugins).toBeDefined()
  expect(mockQueryOptions?.plugins).toHaveLength(1)
  expect(mockQueryOptions?.plugins[0].path).toContain('freshell-orchestration')
})
```

**Step 6: Commit**

```bash
git add server/sdk-bridge.ts test/unit/server/sdk-bridge.test.ts
git commit -m "feat(sdk-bridge): resolve freshell-orchestration as default plugin"
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Manual smoke test (if dev server available)**

1. Create a freshclaude pane (no custom plugins) — should load freshell-orchestration by default
2. Verify the session can use the freshell-orchestration skill

**Step 4: Final commit (if any fixups needed)**
