# Session Type Decoupling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decouple sidebar icon/label rendering from filesystem provider so freshclaude sessions show the correct icon.

**Architecture:** Add a `sessionType` field (open string) persisted in `~/.freshell/session-metadata.json`, merged into sessions at indexer refresh time, and used by the frontend for icon/label resolution instead of `provider`. The `provider` field remains unchanged for filesystem/CLI/matching concerns.

**Tech Stack:** Node.js/Express (server), React/Redux (frontend), Vitest (testing)

**Worktree:** `/Users/justin/Documents/code/ai-playground/freshell/.worktrees/session-type`

**Design doc:** `docs/plans/2026-02-28-session-type-decoupling-design.md`

---

## Task 1: SessionMetadataStore — server-side persistence

**Files:**
- Create: `server/session-metadata-store.ts`
- Test: `test/unit/server/session-metadata-store.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/unit/server/session-metadata-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { SessionMetadataStore } from '../../../server/session-metadata-store.js'

describe('SessionMetadataStore', () => {
  let tmpDir: string
  let store: SessionMetadataStore

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-meta-'))
    store = new SessionMetadataStore(tmpDir)
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined for unknown session', async () => {
    const meta = await store.get('claude', 'nonexistent')
    expect(meta).toBeUndefined()
  })

  it('writes and reads sessionType', async () => {
    await store.set('claude', 'abc-123', { sessionType: 'freshclaude' })
    const meta = await store.get('claude', 'abc-123')
    expect(meta?.sessionType).toBe('freshclaude')
  })

  it('returns all entries via getAll', async () => {
    await store.set('claude', 'a', { sessionType: 'freshclaude' })
    await store.set('claude', 'b', { sessionType: 'kilroy' })
    const all = await store.getAll()
    expect(all['claude:a']?.sessionType).toBe('freshclaude')
    expect(all['claude:b']?.sessionType).toBe('kilroy')
  })

  it('handles missing file gracefully', async () => {
    // Store with nonexistent dir works on first read
    const emptyStore = new SessionMetadataStore(path.join(tmpDir, 'nodir'))
    const meta = await emptyStore.get('claude', 'x')
    expect(meta).toBeUndefined()
  })

  it('handles corrupt file gracefully', async () => {
    await fsp.writeFile(path.join(tmpDir, 'session-metadata.json'), 'not json', 'utf-8')
    const meta = await store.get('claude', 'x')
    expect(meta).toBeUndefined()
  })

  it('persists across instances', async () => {
    await store.set('claude', 'abc', { sessionType: 'freshclaude' })
    const store2 = new SessionMetadataStore(tmpDir)
    const meta = await store2.get('claude', 'abc')
    expect(meta?.sessionType).toBe('freshclaude')
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/justin/Documents/code/ai-playground/freshell/.worktrees/session-type && npx vitest run test/unit/server/session-metadata-store.test.ts`
Expected: FAIL — module not found

**Step 3: Implement SessionMetadataStore**

```typescript
// server/session-metadata-store.ts
import fsp from 'fs/promises'
import path from 'path'
import { logger } from './logger.js'

export interface SessionMetadataEntry {
  sessionType?: string
}

interface MetadataFile {
  version: 1
  sessions: Record<string, SessionMetadataEntry>
}

export class SessionMetadataStore {
  private dir: string
  private cache: MetadataFile | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  private filePath(): string {
    return path.join(this.dir, 'session-metadata.json')
  }

  private makeKey(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`
  }

  private async load(): Promise<MetadataFile> {
    if (this.cache) return this.cache
    try {
      const raw = await fsp.readFile(this.filePath(), 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed?.version === 1 && parsed?.sessions) {
        this.cache = parsed as MetadataFile
        return this.cache
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, event: 'session_metadata_read_error' }, 'Failed to read session metadata')
      }
    }
    this.cache = { version: 1, sessions: {} }
    return this.cache
  }

  private async save(data: MetadataFile): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    const tmpPath = this.filePath() + '.tmp'
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    await fsp.rename(tmpPath, this.filePath())
    this.cache = data
  }

  async get(provider: string, sessionId: string): Promise<SessionMetadataEntry | undefined> {
    const data = await this.load()
    return data.sessions[this.makeKey(provider, sessionId)]
  }

  async getAll(): Promise<Record<string, SessionMetadataEntry>> {
    const data = await this.load()
    return data.sessions
  }

  async set(provider: string, sessionId: string, entry: SessionMetadataEntry): Promise<void> {
    const data = await this.load()
    data.sessions[this.makeKey(provider, sessionId)] = entry
    await this.save(data)
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/justin/Documents/code/ai-playground/freshell/.worktrees/session-type && npx vitest run test/unit/server/session-metadata-store.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add server/session-metadata-store.ts test/unit/server/session-metadata-store.test.ts
git commit -m "feat: add SessionMetadataStore for session-level metadata persistence"
```

---

## Task 2: Add `sessionType` to server-side `CodingCliSession` and merge in indexer

**Files:**
- Modify: `server/coding-cli/types.ts:156-174` (add `sessionType` field to `CodingCliSession`)
- Modify: `server/coding-cli/session-indexer.ts:39-48,605` (merge sessionType in `applyOverride` and refresh)
- Modify: `server/index.ts` (instantiate and wire `SessionMetadataStore`)
- Test: `test/unit/server/coding-cli/session-indexer.test.ts` (add sessionType merge test)

**Step 1: Write the failing test**

Add a test to the existing session indexer test file that verifies sessionType is merged from metadata. The test should create a session indexer with a mock metadata store that returns `{ sessionType: 'freshclaude' }` for a specific session, and verify the returned session has `sessionType: 'freshclaude'`.

Check the existing test file structure first: `test/unit/server/coding-cli/session-indexer.test.ts`. The test should follow existing patterns in that file.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/coding-cli/session-indexer.test.ts -t "sessionType"`
Expected: FAIL — sessionType not in CodingCliSession

**Step 3: Add `sessionType` to `CodingCliSession`**

In `server/coding-cli/types.ts`, add to `CodingCliSession` interface (after line 173):
```typescript
  sessionType?: string
```

Also add to `ProjectGroup` or keep it on session — sessions already flow through to the frontend.

**Step 4: Merge sessionType in session indexer**

In `server/coding-cli/session-indexer.ts`:

1. Import `SessionMetadataStore` and accept it as a constructor parameter (or use a module-level instance).

2. In `performRefresh()` around line 493, load metadata alongside config:
```typescript
const [colors, cfg, sessionMetadata] = await Promise.all([
  configStore.getProjectColors(),
  configStore.snapshot(),
  this.sessionMetadataStore.getAll(),
])
```

3. After `applyOverride` at line 605, merge sessionType:
```typescript
const merged = applyOverride(cached.baseSession, ov)
if (!merged) continue
// Merge sessionType from metadata store
const metaKey = makeSessionKey(merged.provider, merged.sessionId)
const meta = sessionMetadata[metaKey]
if (meta?.sessionType) {
  merged.sessionType = meta.sessionType
}
```

**Step 5: Wire SessionMetadataStore in server/index.ts**

Instantiate `SessionMetadataStore` with the freshell config directory and pass it to the session indexer constructor.

**Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/server/coding-cli/session-indexer.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add server/coding-cli/types.ts server/coding-cli/session-indexer.ts server/index.ts test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "feat: merge sessionType from metadata store into session indexer output"
```

---

## Task 3: Add `POST /api/session-metadata` endpoint

**Files:**
- Modify: `server/routes/sessions.ts` (add POST endpoint)
- Test: add test for the endpoint (check existing integration test patterns)

**Step 1: Write the failing test**

Test that `POST /api/session-metadata` with `{ provider, sessionId, sessionType }` writes to the metadata store and returns 200.

**Step 2: Run test to verify it fails**

Expected: FAIL — 404 not found

**Step 3: Implement the endpoint**

In `server/routes/sessions.ts`, add:
```typescript
router.post('/session-metadata', async (req, res) => {
  const { provider, sessionId, sessionType } = req.body
  if (!provider || !sessionId || !sessionType) {
    return res.status(400).json({ error: 'Missing required fields: provider, sessionId, sessionType' })
  }
  await sessionMetadataStore.set(provider, sessionId, { sessionType })
  res.json({ ok: true })
})
```

Wire `sessionMetadataStore` into the routes (pass as parameter or import singleton).

**Step 4: Run tests to verify they pass**

Expected: PASS

**Step 5: Commit**

```bash
git add server/routes/sessions.ts test/...
git commit -m "feat: add POST /api/session-metadata endpoint for tagging sessions"
```

---

## Task 4: Frontend — add `sessionType` to Redux types and propagate through selectors

**Files:**
- Modify: `src/store/types.ts:54-69` (add `sessionType` to client CodingCliSession)
- Modify: `src/store/selectors/sidebarSelectors.ts:7-26,102` (add `sessionType` to SidebarSessionItem, propagate in buildSessionItems)
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`

**Step 1: Write the failing test**

Add test that verifies `buildSessionItems` propagates `sessionType` from session data to sidebar items, defaulting to `provider` when absent.

**Step 2: Run test to verify it fails**

Expected: FAIL — sessionType not on types

**Step 3: Add `sessionType` to client types**

In `src/store/types.ts`, add to `CodingCliSession`:
```typescript
  sessionType?: string
```

**Step 4: Add `sessionType` to `SidebarSessionItem` and propagate**

In `src/store/selectors/sidebarSelectors.ts`:

1. Add to `SidebarSessionItem` interface:
```typescript
  sessionType: string  // Defaults to provider when not explicitly set
```

2. In `buildSessionItems()`, when building each item (around line 109-128):
```typescript
  sessionType: session.sessionType || provider,
```

**Step 5: Update memo comparators**

In `src/components/Sidebar.tsx`:
- Add `sessionType` to `areSessionItemsEqual` comparator
- Add `sessionType` to `areSidebarItemPropsEqual` comparator

**Step 6: Run tests**

Run: `npx vitest run test/unit/client/store/selectors/sidebarSelectors.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/store/types.ts src/store/selectors/sidebarSelectors.ts src/components/Sidebar.tsx test/...
git commit -m "feat: add sessionType to Redux types and sidebar selectors"
```

---

## Task 5: Frontend — unified icon/label resolution

**Files:**
- Create: `src/lib/session-type-utils.ts`
- Test: `test/unit/client/lib/session-type-utils.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/unit/client/lib/session-type-utils.test.ts
import { describe, it, expect } from 'vitest'
import { resolveSessionTypeConfig } from '@/lib/session-type-utils'

describe('resolveSessionTypeConfig', () => {
  it('returns claude config for "claude"', () => {
    const config = resolveSessionTypeConfig('claude')
    expect(config.label).toBe('Claude CLI')
    expect(config.icon).toBeDefined()
  })

  it('returns codex config for "codex"', () => {
    const config = resolveSessionTypeConfig('codex')
    expect(config.label).toBe('Codex CLI')
  })

  it('returns freshclaude config for "freshclaude"', () => {
    const config = resolveSessionTypeConfig('freshclaude')
    expect(config.label).toBe('Freshclaude')
    expect(config.icon).toBeDefined()
  })

  it('returns kilroy config for "kilroy"', () => {
    const config = resolveSessionTypeConfig('kilroy')
    expect(config.label).toBe('Kilroy')
  })

  it('returns fallback for unknown type', () => {
    const config = resolveSessionTypeConfig('graphviz-viewer')
    expect(config.label).toBe('graphviz-viewer')
    expect(config.icon).toBeDefined() // generic fallback icon
  })
})
```

**Step 2: Run tests to verify they fail**

Expected: FAIL — module not found

**Step 3: Implement resolveSessionTypeConfig**

```typescript
// src/lib/session-type-utils.ts
import type { ComponentType } from 'react'
import { PROVIDER_ICONS, DefaultProviderIcon } from '@/components/icons/provider-icons'
import { CODING_CLI_PROVIDER_LABELS } from '@/lib/coding-cli-utils'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import { isCodingCliMode } from '@/lib/coding-cli-utils'

export interface SessionTypeConfig {
  icon: ComponentType<{ className?: string }>
  label: string
}

export function resolveSessionTypeConfig(sessionType: string): SessionTypeConfig {
  // 1. Check coding CLI providers
  if (isCodingCliMode(sessionType)) {
    return {
      icon: PROVIDER_ICONS[sessionType as keyof typeof PROVIDER_ICONS] || DefaultProviderIcon,
      label: CODING_CLI_PROVIDER_LABELS[sessionType as keyof typeof CODING_CLI_PROVIDER_LABELS] || sessionType,
    }
  }

  // 2. Check agent-chat providers
  const agentConfig = getAgentChatProviderConfig(sessionType)
  if (agentConfig) {
    return {
      icon: agentConfig.icon,
      label: agentConfig.label,
    }
  }

  // 3. Fallback for unknown types
  return {
    icon: DefaultProviderIcon,
    label: sessionType,
  }
}
```

Note: May need to export `CODING_CLI_PROVIDER_LABELS` from `coding-cli-utils.ts` and `DefaultProviderIcon` from `provider-icons.tsx` if not already exported. Check and add exports as needed.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/client/lib/session-type-utils.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/session-type-utils.ts test/unit/client/lib/session-type-utils.test.ts
git commit -m "feat: add resolveSessionTypeConfig for unified icon/label lookup"
```

---

## Task 6: Frontend — use `sessionType` in Sidebar rendering

**Files:**
- Modify: `src/components/Sidebar.tsx` (SidebarItem icon and tooltip)
- Modify: `src/components/icons/provider-icons.tsx` (export DefaultProviderIcon if needed)

**Step 1: Write the failing test**

Add a test (or update existing) in sidebar tests that renders a `SidebarItem` with `sessionType: 'freshclaude'` and verifies the freshclaude icon is rendered (not the claude icon).

**Step 2: Run test to verify it fails**

Expected: FAIL — still rendering claude icon

**Step 3: Update SidebarItem to use sessionType**

In `src/components/Sidebar.tsx`, update the `SidebarItem` component:

1. Import `resolveSessionTypeConfig` from `@/lib/session-type-utils`
2. Replace `<ProviderIcon provider={item.provider} ... />` with:
```tsx
const { icon: SessionIcon } = resolveSessionTypeConfig(item.sessionType)
// Then use <SessionIcon className={...} /> instead of <ProviderIcon>
```
3. Replace `getProviderLabel(item.provider)` in tooltip with:
```tsx
const { label } = resolveSessionTypeConfig(item.sessionType)
```

**Step 4: Run tests to verify they pass**

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/components/icons/provider-icons.tsx
git commit -m "feat: render sidebar icons based on sessionType instead of provider"
```

---

## Task 7: Tag freshclaude sessions on creation

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx` (fire metadata write when cliSessionId is known)
- Modify: `src/lib/api.ts` (add `setSessionMetadata` API call)

**Step 1: Write the failing test**

Test that when AgentChatView receives a `cliSessionId`, it calls the session-metadata API with the correct sessionType.

**Step 2: Run test to verify it fails**

Expected: FAIL — no API call made

**Step 3: Add API helper**

In `src/lib/api.ts`:
```typescript
export async function setSessionMetadata(
  provider: string,
  sessionId: string,
  sessionType: string
): Promise<void> {
  await fetch('/api/session-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, sessionId, sessionType }),
  })
}
```

**Step 4: Hook into AgentChatView**

In `src/components/agent-chat/AgentChatView.tsx`, in the existing `useEffect` that persists `cliSessionId` as `resumeSessionId` (around line 119-130):

After the existing `resumeSessionId` persistence, add:
```typescript
// Tag this Claude Code session as belonging to this agent-chat provider
setSessionMetadata(
  agentChatConfig.codingCliProvider,  // 'claude'
  cliSessionId,
  paneContent.provider,               // 'freshclaude' or 'kilroy'
).catch((err) => {
  console.warn('Failed to tag session metadata:', err)
})
```

This fires once when `cliSessionId` first becomes available. The API is best-effort with error logging — no `await` needed in the effect.

**Step 5: Run tests to verify they pass**

Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/api.ts src/components/agent-chat/AgentChatView.tsx test/...
git commit -m "feat: tag freshclaude sessions with sessionType on creation"
```

---

## Task 8: Final integration verification

**Step 1: Run full test suite**

Run: `npm test`
Verify no regressions.

**Step 2: Manual smoke test**

1. Start dev server in worktree: `PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid`
2. Open freshclaude session
3. Verify sidebar shows freshclaude icon (not claude icon)
4. Verify regular Claude CLI sessions still show claude icon
5. Restart server, verify freshclaude session still shows correct icon
6. Stop server: `kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid`

**Step 3: Commit any fixes**

**Step 4: Final commit / squash if needed**

---

## Summary of Changes

| Layer | File | Change |
|-------|------|--------|
| Server persistence | `server/session-metadata-store.ts` | New file — read/write `~/.freshell/session-metadata.json` |
| Server types | `server/coding-cli/types.ts` | Add `sessionType?: string` to `CodingCliSession` |
| Server indexer | `server/coding-cli/session-indexer.ts` | Merge `sessionType` from metadata store during refresh |
| Server routes | `server/routes/sessions.ts` | Add `POST /api/session-metadata` endpoint |
| Server wiring | `server/index.ts` | Instantiate and wire `SessionMetadataStore` |
| Frontend types | `src/store/types.ts` | Add `sessionType?: string` to client `CodingCliSession` |
| Frontend selectors | `src/store/selectors/sidebarSelectors.ts` | Add `sessionType` to `SidebarSessionItem`, propagate from session |
| Frontend utils | `src/lib/session-type-utils.ts` | New file — `resolveSessionTypeConfig()` unified lookup |
| Frontend sidebar | `src/components/Sidebar.tsx` | Use `sessionType` for icon/label, update memo comparators |
| Frontend API | `src/lib/api.ts` | Add `setSessionMetadata()` helper |
| Frontend agent-chat | `src/components/agent-chat/AgentChatView.tsx` | Tag session on creation |
| Icons | `src/components/icons/provider-icons.tsx` | Export `DefaultProviderIcon` if not already |
