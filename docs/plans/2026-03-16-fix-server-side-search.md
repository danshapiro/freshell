# Fix Server-Side Search

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Make the sidebar search entirely server-side, supporting all three search tiers (`title`, `userMessages`, `fullText`) correctly, so that each option does what it claims.

**Tech Stack:** Node.js/Express, TypeScript, Zod, React, Redux Toolkit, Vitest, supertest

---

## Problem Statement

Search is broken. The UI offers three search tiers via a dropdown:

| Tier | UI Label | Expected Behavior | Actual Behavior |
|------|----------|-------------------|-----------------|
| `title` | Title | Search title + summary | Works partially -- the server's `applySearch` in `session-directory/service.ts` searches `title`, `summary`, and `firstUserMessage` |
| `userMessages` | User Msg | Search all user messages in the JSONL session files | **Broken** -- tier is never sent to the server; all tiers behave like `title` |
| `fullText` | Full Text | Search all user + assistant messages in the JSONL files | **Broken** -- same as above |

Root causes:

1. **`SessionDirectoryQuerySchema` has no `tier` field.** The shared schema only has `query` (string) -- no concept of search depth.
2. **Client `searchSessions()` in `api.ts` ignores the `tier` parameter.** It calls `getSessionDirectoryPage` passing `query` but never the tier, so all searches go through the same title-level `applySearch`.
3. **The server `querySessionDirectory` only has a shallow `applySearch`** that searches `title`, `summary`, and `firstUserMessage` metadata fields. It never opens JSONL session files.
4. **The old `session-search.ts` module has working file-based search** (`searchSessionFile`, `searchSessions`, `extractUserMessages`, `extractAllMessages`) that already implements the `userMessages` and `fullText` tiers correctly by streaming JSONL files through provider-specific `parseEvent`. But this module is completely disconnected from the new session-directory read model pathway.

## Architecture Decision

**Approach: Integrate the existing file-based search into the session-directory service layer.**

Rationale:
- The old `session-search.ts` already has well-tested, provider-aware JSONL streaming for `userMessages` and `fullText` tiers.
- The session-directory service already owns the session list, sorting, cursor pagination, and running-state join.
- The clean integration point is to: (a) add `tier` to the shared schema, (b) plumb it through the API and client, (c) call `searchSessionFile` from within the session-directory service when the tier requires file I/O.
- The `title` tier keeps its current fast metadata-only behavior (no file I/O).

**What changes and what stays the same:**

- `shared/read-models.ts`: Add `tier` to `SessionDirectoryQuerySchema` (optional, defaults to `title`).
- `server/session-directory/service.ts`: When `tier` is `userMessages` or `fullText`, iterate sorted items, call `searchSessionFile` for each session that has a `sourceFile`, and decorate matches with `snippet`/`matchedIn`. Keep the `title` tier path unchanged.
- `server/session-directory/types.ts`: Re-export the new schema types (no changes needed beyond the shared type flowing through).
- `server/sessions-router.ts`: Parse and forward the `tier` query parameter.
- `server/session-directory/service.ts` needs access to `CodingCliProvider` instances (for `parseEvent`) and the `sourceFile` from each session. The `sourceFile` is already on `CodingCliSession` in the `ProjectGroup` data. The `CodingCliProvider[]` will be threaded through from the router.
- `src/lib/api.ts`: Pass `tier` to `getSessionDirectoryPage` in the `searchSessions` function.
- `src/components/Sidebar.tsx`: No changes needed -- it already passes `searchTier` to `fetchSessionWindow`, which passes it to `searchSessions`. The only missing link was the API layer not forwarding it.
- `src/store/sessionsThunks.ts`: No changes needed -- already passes `searchTier` as `tier`.
- Client-side `filterSessionItems` in `sidebarSelectors.ts`: No changes needed. When a `sidebarWindow` with results exists, the local filter is already bypassed (line 245 of `Sidebar.tsx` passes `''` as the filter).

**Contracts and invariants:**

1. **`title` tier** searches `title`, `summary`, and `firstUserMessage` metadata fields only (no file I/O). This is the existing behavior and must not regress.
2. **`userMessages` tier** streams each JSONL session file, searching only `message.user` events. Returns on first hit per session.
3. **`fullText` tier** streams each JSONL session file, searching both `message.user` and `message.assistant` events. Returns on first hit per session.
4. **Sort order** is canonical (non-archived by recency, then archived by recency) for all tiers.
5. **Partial results** are reported with `partial: true` and `partialReason: 'budget' | 'io_error'` when file I/O tiers hit budget or errors.
6. **Cursor pagination** works for all tiers: the cursor is based on `lastActivityAt` + session key, not on search results. For file-based tiers, pagination is position-based in the full session list (scan from cursor position), not in the result list.
7. **Abort signals** propagate through to file streaming, allowing the server to stop scanning when the client navigates away.
8. **`SessionDirectoryItem.matchedIn`** enum adds `'userMessage'` and `'assistantMessage'` variants for file-based search results.

**Boundary conditions:**

- Sessions without `sourceFile` are skipped in file-based tiers (no match, no error).
- Sessions whose provider is unknown (no matching `CodingCliProvider`) are skipped.
- File read errors mark the result as `partial` with `partialReason: 'io_error'` but don't abort the entire search.
- The `maxFiles` budget concept from old `session-search.ts` maps to the page `limit` for file-based tiers -- we scan at most `limit * 10` sessions (configurable) to avoid unbounded I/O.

**Cutover and regression risk:**

- The `title` tier path is unchanged -- zero regression risk for the default search.
- Adding `tier` as an optional field with `default('title')` to the shared schema is backward-compatible.
- The `matchedIn` enum expanding from `['title', 'summary', 'firstUserMessage']` to include `'userMessage'` and `'assistantMessage'` requires updating the Zod schema. Existing clients that don't use these new values are unaffected.
- The session-directory router already passes `signal` through the read-model scheduler, so abort propagation is handled.

---

## Scope Notes

- Terminal search (`TerminalSearchBar`, `searchTerminalView`) is a separate feature -- not in scope.
- The `session-search.ts` module's `searchSessions` orchestrator function and `searchTitleTier` function become dead code after this change. They should NOT be deleted in this PR (they have tests and may be referenced elsewhere); instead, mark them with `@deprecated` JSDoc comments.
- No changes to `docs/index.html` needed -- search is an existing feature, not a new one.
- The old client-side `SearchOptions.tier` type and `SearchResponse` type in `api.ts` are already correct and match the intended behavior.

---

### Task 1: Add `tier` to `SessionDirectoryQuerySchema` and expand `matchedIn` enum

**Files:**
- Modify: `shared/read-models.ts`

**Step 1: Write failing tests**

Add tests to the existing `test/unit/server/session-directory/service.test.ts` that exercise the new tiers. These will fail because the schema and service don't support `tier` yet.

```ts
// In test/unit/server/session-directory/service.test.ts, add to describe('querySessionDirectory'):

it('searches user messages in session files with userMessages tier', async () => {
  // This requires sourceFile on sessions and providers in the input
  // Will fail until Task 3 implements the service-level file search
})

it('searches all messages in session files with fullText tier', async () => {
  // Will fail until Task 3
})
```

But first, add a schema-level test:

Create `test/unit/shared/session-directory-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SessionDirectoryQuerySchema, SessionDirectoryItemSchema } from '../../../shared/read-models'

describe('SessionDirectoryQuerySchema tier field', () => {
  it('accepts title tier', () => {
    const result = SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'title' })
    expect(result.tier).toBe('title')
  })

  it('accepts userMessages tier', () => {
    const result = SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'userMessages' })
    expect(result.tier).toBe('userMessages')
  })

  it('accepts fullText tier', () => {
    const result = SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'fullText' })
    expect(result.tier).toBe('fullText')
  })

  it('defaults to title when tier is omitted', () => {
    const result = SessionDirectoryQuerySchema.parse({ priority: 'visible' })
    expect(result.tier).toBe('title')
  })

  it('rejects unknown tier values', () => {
    expect(() => SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'bogus' })).toThrow()
  })
})

describe('SessionDirectoryItemSchema matchedIn field', () => {
  const baseItem = {
    sessionId: 'test-session',
    provider: 'claude',
    projectPath: '/test',
    lastActivityAt: 1000,
    isRunning: false,
  }

  it('accepts userMessage matchedIn', () => {
    const result = SessionDirectoryItemSchema.parse({ ...baseItem, matchedIn: 'userMessage' })
    expect(result.matchedIn).toBe('userMessage')
  })

  it('accepts assistantMessage matchedIn', () => {
    const result = SessionDirectoryItemSchema.parse({ ...baseItem, matchedIn: 'assistantMessage' })
    expect(result.matchedIn).toBe('assistantMessage')
  })

  it('continues to accept existing matchedIn values', () => {
    for (const value of ['title', 'summary', 'firstUserMessage']) {
      const result = SessionDirectoryItemSchema.parse({ ...baseItem, matchedIn: value })
      expect(result.matchedIn).toBe(value)
    }
  })
})
```

**Step 2: Make the tests pass**

In `shared/read-models.ts`:

1. Add `tier` to `SessionDirectoryQuerySchema`:
```ts
export const SessionDirectoryQuerySchema = z.object({
  query: z.string().optional(),
  tier: z.enum(['title', 'userMessages', 'fullText']).default('title'),
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema,
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_DIRECTORY_PAGE_ITEMS).optional(),
})
```

2. Expand `matchedIn` in `SessionDirectoryItemSchema`:
```ts
matchedIn: z.enum(['title', 'summary', 'firstUserMessage', 'userMessage', 'assistantMessage']).optional(),
```

**Step 3: Refactor**

Verify no type errors. Run the full test suite to confirm no regressions. The new `tier` field defaults to `title`, so all existing callers are unaffected.

---

### Task 2: Plumb `tier` through the HTTP route and client API

**Files:**
- Modify: `server/sessions-router.ts`
- Modify: `src/lib/api.ts`

**Step 1: Write failing tests**

Add a test to `test/integration/server/session-directory-router.test.ts`:

```ts
it('forwards the tier query parameter to the session-directory service', async () => {
  const res = await request(app)
    .get('/api/session-directory?priority=visible&query=deploy&tier=userMessages')
    .set('x-auth-token', TEST_AUTH_TOKEN)

  expect(res.status).toBe(200)
  // The response should work (even if no file-based results yet)
})
```

Add a test to `test/unit/client/lib/api.test.ts` (or create it if section doesn't exist):

```ts
it('passes tier to getSessionDirectoryPage when searching', async () => {
  // Mock fetch, call searchSessions with tier: 'fullText', verify the URL includes tier=fullText
})
```

**Step 2: Make the tests pass**

In `server/sessions-router.ts`, parse `tier` from the query string and include it in the `SessionDirectoryQuerySchema.safeParse` call:

```ts
router.get('/session-directory', async (req, res) => {
  const parsed = SessionDirectoryQuerySchema.safeParse({
    query: typeof req.query.query === 'string' ? req.query.query : undefined,
    tier: typeof req.query.tier === 'string' ? req.query.tier : undefined,
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    priority: req.query.priority,
    revision: typeof req.query.revision === 'string' ? Number(req.query.revision) : undefined,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
  })
  // ... rest unchanged
})
```

In `src/lib/api.ts`, update `searchSessions` to pass `tier`:

```ts
export async function searchSessions(options: SearchOptions): Promise<SearchResponse> {
  const { query, tier = 'title', limit, signal } = options
  const page = SessionDirectoryPageSchema.parse(await getSessionDirectoryPage({
    priority: 'visible',
    query,
    tier,
    ...(limit ? { limit } : {}),
  }, {
    signal,
  })) as ReadModelSessionDirectoryPage

  // ... rest unchanged
}
```

Also update `getSessionDirectoryPage` to include `tier` in the query string:

```ts
export async function getSessionDirectoryPage(
  query: SessionDirectoryQuery,
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = SessionDirectoryQuerySchema.parse(query)
  return api.get(
    `/api/session-directory${buildQueryString([
      ['query', parsed.query],
      ['tier', parsed.tier === 'title' ? undefined : parsed.tier],
      ['cursor', parsed.cursor],
      ['priority', parsed.priority],
      ['revision', parsed.revision],
      ['limit', parsed.limit],
    ])}`,
    options,
  )
}
```

Note: we omit `tier` from the URL when it equals `title` (the default) to keep URLs clean for the common case.

**Step 3: Refactor**

Verify that existing tests still pass. The `tier` defaults to `title` everywhere, so all existing callers remain backward-compatible.

---

### Task 3: Implement file-based search in the session-directory service

This is the core task. The session-directory service's `querySessionDirectory` must support `userMessages` and `fullText` tiers by streaming JSONL session files.

**Files:**
- Modify: `server/session-directory/service.ts`
- Modify: `server/sessions-router.ts` (to pass providers)

**Step 1: Write failing tests**

Extend `test/unit/server/session-directory/service.test.ts` with tests that exercise file-based search:

```ts
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { claudeProvider } from '../../../../server/coding-cli/providers/claude.js'

describe('querySessionDirectory file-based search', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-dir-search-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('userMessages tier finds matches in user messages only', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the authentication bug"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working on the login system"}]}}',
    ].join('\n'))

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'authentication', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0].matchedIn).toBe('userMessage')
    expect(page.items[0].snippet).toContain('authentication')
  })

  it('userMessages tier does NOT match assistant messages', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication system is broken"}]}}',
    ].join('\n'))

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'authentication', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(0)
  })

  it('fullText tier finds matches in assistant messages', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication system is broken"}]}}',
    ].join('\n'))

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'authentication', tier: 'fullText' },
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0].matchedIn).toBe('assistantMessage')
  })

  it('title tier still works without file I/O (does not require providers)', async () => {
    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Deploy pipeline fix',
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      query: { priority: 'visible', query: 'deploy', tier: 'title' },
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0].matchedIn).toBe('title')
  })

  it('file-based search skips sessions without sourceFile', async () => {
    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-no-file',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'No source file',
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'anything', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(0)
  })

  it('file-based search handles missing files gracefully', async () => {
    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-missing',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Missing file',
        sourceFile: '/nonexistent/path.jsonl',
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'anything', tier: 'fullText' },
    })

    expect(page.items).toHaveLength(0)
    // No throw -- graceful handling
  })

  it('file-based search respects abort signals', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}\n')

    const controller = new AbortController()
    controller.abort()

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    await expect(querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'Hello', tier: 'userMessages' },
      signal: controller.signal,
    })).rejects.toThrow(/aborted/i)
  })

  it('file-based search respects page limit for results', async () => {
    // Create multiple sessions, each matching
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(
        path.join(tempDir, `session-${i}.jsonl`),
        `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"needle match ${i}"}]}}\n`
      )
    }

    const sessions = Array.from({ length: 5 }, (_, i) => makeSession({
      sessionId: `session-${i}`,
      projectPath: '/repo',
      lastActivityAt: 5000 - i,
      title: `Session ${i}`,
      sourceFile: path.join(tempDir, `session-${i}.jsonl`),
    }))

    const page = await querySessionDirectory({
      projects: [makeProject('/repo', sessions)],
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'needle', tier: 'userMessages', limit: 2 },
    })

    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeTruthy()
  })
})
```

**Step 2: Make the tests pass**

**2a. Update the `QuerySessionDirectoryInput` type** in `server/session-directory/service.ts`:

```ts
import type { CodingCliProvider } from '../coding-cli/provider.js'
import { searchSessionFile } from '../session-search.js'

type QuerySessionDirectoryInput = {
  projects: ProjectGroup[]
  query: SessionDirectoryQuery
  terminalMeta: TerminalMeta[]
  providers?: CodingCliProvider[]
  signal?: AbortSignal
}
```

**2b. Update the `applySearch` function** to handle file-based tiers. The key design is:

- For `title` tier (default): keep the existing `applySearch` that checks metadata fields.
- For `userMessages` / `fullText` tiers: call `searchSessionFile` from `session-search.ts` on each session's `sourceFile`.

Modify `querySessionDirectory`:

```ts
export async function querySessionDirectory(input: QuerySessionDirectoryInput): Promise<SessionDirectoryPage> {
  const limit = Math.min(input.query.limit ?? MAX_DIRECTORY_PAGE_ITEMS, MAX_DIRECTORY_PAGE_ITEMS)
  const tier = input.query.tier ?? 'title'
  const cursor = input.query.cursor ? decodeCursor(input.query.cursor) : null
  const revision = Math.max(
    0,
    ...input.projects.flatMap((project) => project.sessions.map((session) => session.lastActivityAt)),
    ...input.terminalMeta.map((meta) => meta.updatedAt),
  )

  throwIfAborted(input.signal)

  let items = toItems(input.projects, input.terminalMeta).sort(compareItems)

  if (cursor) {
    items = items.filter((item) => (
      item.lastActivityAt < cursor.lastActivityAt ||
      (item.lastActivityAt === cursor.lastActivityAt && buildSessionKey(item).localeCompare(cursor.key) < 0)
    ))
  }

  throwIfAborted(input.signal)

  if (input.query.query?.trim()) {
    if (tier === 'title') {
      // Existing metadata-only search
      items = items
        .map((item) => applySearch(item, input.query.query!.trim()))
        .filter((item): item is SessionDirectoryItem => item !== null)
    } else {
      // File-based search for userMessages / fullText
      items = await applyFileSearch(items, input.query.query!.trim(), tier, input, limit)
    }
  }

  const pageItems = items.slice(0, limit)
  const tail = pageItems.at(-1)
  const nextCursor = items.length > limit && tail
    ? encodeCursor({ lastActivityAt: tail.lastActivityAt, key: buildSessionKey(tail) })
    : null

  return {
    items: pageItems,
    nextCursor,
    revision,
  }
}
```

The new `applyFileSearch` function:

```ts
async function applyFileSearch(
  items: SessionDirectoryItem[],
  queryText: string,
  tier: 'userMessages' | 'fullText',
  input: QuerySessionDirectoryInput,
  limit: number,
): Promise<SessionDirectoryItem[]> {
  const providersByName = new Map(
    (input.providers ?? []).map((p) => [p.name, p])
  )
  // Build a lookup from sessionKey -> sourceFile from the original projects
  const sourceFiles = new Map<string, string>()
  for (const project of input.projects) {
    for (const session of project.sessions) {
      if (session.sourceFile) {
        sourceFiles.set(buildSessionKey({ provider: session.provider, sessionId: session.sessionId }), session.sourceFile)
      }
    }
  }

  const results: SessionDirectoryItem[] = []
  const maxScan = limit * 10  // Scan budget to avoid unbounded I/O

  let scanned = 0
  for (const item of items) {
    if (scanned >= maxScan || results.length >= limit + 1) break
    throwIfAborted(input.signal)

    const key = buildSessionKey(item)
    const sourceFile = sourceFiles.get(key)
    if (!sourceFile) continue

    const provider = providersByName.get(item.provider)
    if (!provider) continue

    scanned++

    try {
      const match = await searchSessionFile(provider, sourceFile, queryText, tier)
      if (match) {
        results.push({
          ...item,
          matchedIn: match.matchedIn as SessionDirectoryItem['matchedIn'],
          snippet: match.snippet,
        })
      }
    } catch {
      // Graceful: skip sessions with I/O errors
      continue
    }
  }

  return results
}
```

**2c. Update `sessions-router.ts`** to pass `providers` to the service:

```ts
run: (scheduledSignal) => querySessionDirectory({
  projects: codingCliIndexer.getProjects(),
  query: parsed.data,
  terminalMeta: deps.terminalMetadata?.list() ?? [],
  providers: codingCliProviders,
  signal: scheduledSignal,
}),
```

**Step 3: Refactor**

- Ensure that the `matchedIn` type on `SessionDirectoryItem` accommodates `'userMessage' | 'assistantMessage'` from `searchSessionFile`. The `searchSessionFile` return type uses these strings.
- Add `@deprecated` JSDoc to `searchTitleTier` and the old `searchSessions` in `session-search.ts` -- they are now superseded but should not be deleted in this PR.
- Run the full test suite.

---

### Task 4: Integration test for the full round-trip

**Files:**
- Modify: `test/integration/server/session-directory-router.test.ts`

**Step 1: Write failing tests**

```ts
describe('search tiers through the HTTP route', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'router-search-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('title tier searches metadata only', async () => {
    // Setup app with projects that have titles
    // GET /api/session-directory?priority=visible&query=deploy&tier=title
    // Expect match in title
  })

  it('userMessages tier searches JSONL user messages', async () => {
    // Setup app with projects that have sourceFile pointing to JSONL
    // GET /api/session-directory?priority=visible&query=authentication&tier=userMessages
    // Expect match with matchedIn=userMessage
  })

  it('fullText tier searches JSONL user + assistant messages', async () => {
    // GET /api/session-directory?priority=visible&query=secret_keyword&tier=fullText
    // Where secret_keyword appears only in an assistant message
    // Expect match with matchedIn=assistantMessage
  })

  it('defaults to title tier when tier parameter is omitted', async () => {
    // GET /api/session-directory?priority=visible&query=deploy
    // Should behave same as tier=title
  })
})
```

**Step 2: Make the tests pass**

These should already pass once Tasks 1-3 are complete. The test is to confirm the full HTTP round-trip works correctly.

**Step 3: Refactor**

Review test clarity and remove any duplication.

---

### Task 5: Client-side thunk tests for tier forwarding

**Files:**
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/lib/api.test.ts`

**Step 1: Write failing tests**

In `test/unit/client/store/sessionsThunks.test.ts`, add:

```ts
it('passes tier to searchSessions when a query is active', async () => {
  searchSessions.mockResolvedValue({
    results: [],
    tier: 'userMessages',
    query: 'needle',
    totalScanned: 0,
  })

  const store = createStore()
  store.dispatch(setActiveSessionSurface('sidebar'))

  await store.dispatch(fetchSessionWindow({
    surface: 'sidebar',
    priority: 'visible',
    query: 'needle',
    searchTier: 'userMessages',
  }) as any)

  expect(searchSessions).toHaveBeenCalledWith({
    query: 'needle',
    tier: 'userMessages',
    signal: expect.any(AbortSignal),
  })
})
```

In `test/unit/client/lib/api.test.ts`, verify that the `tier` parameter is included in the URL:

```ts
it('includes tier in session directory query when not title', async () => {
  // Mock global fetch
  // Call searchSessions({ query: 'test', tier: 'fullText' })
  // Verify fetch was called with URL containing tier=fullText
})
```

**Step 2: Make the tests pass**

These should pass once Task 2's changes are in place.

**Step 3: Refactor**

Ensure test descriptions are clear and match the existing test style.

---

### Task 6: E2E Sidebar search behavior tests

**Files:**
- Create: `test/e2e/sidebar-search-tiers.test.tsx`

**Step 1: Write failing tests**

Test the full UI flow: type in search box, change tier, verify the correct API calls are made with the correct tier.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { enableMapSet } from 'immer'
import sessionsReducer from '@/store/sessionsSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import Sidebar from '@/components/Sidebar'

enableMapSet()

const fetchMock = vi.fn()
const searchMock = vi.fn()

vi.mock('@/lib/api', () => ({
  fetchSidebarSessionsSnapshot: (...args: any[]) => fetchMock(...args),
  searchSessions: (...args: any[]) => searchMock(...args),
  getBootstrap: vi.fn().mockResolvedValue({}),
  getSessionDirectoryPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null, revision: 0 }),
}))

function createTestStore() {
  return configureStore({
    reducer: {
      sessions: sessionsReducer,
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      settings: { settings: defaultSettings, loaded: true },
      connection: { status: 'connected' as const, error: null },
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
  })
}

describe('sidebar search tiers (e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockReset()
    searchMock.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows tier dropdown when search input has text', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <Sidebar view="terminal" onNavigate={vi.fn()} />
      </Provider>
    )

    expect(screen.queryByLabelText('Search tier')).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'test' } })
    expect(screen.getByLabelText('Search tier')).toBeInTheDocument()
  })

  it('hides tier dropdown when search is cleared', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <Sidebar view="terminal" onNavigate={vi.fn()} />
      </Provider>
    )

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'test' } })
    expect(screen.getByLabelText('Search tier')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: '' } })
    expect(screen.queryByLabelText('Search tier')).not.toBeInTheDocument()
  })

  it('dispatches search with the selected tier', async () => {
    searchMock.mockResolvedValue({
      results: [],
      tier: 'userMessages',
      query: 'needle',
      totalScanned: 0,
    })

    const store = createTestStore()
    store.dispatch({ type: 'sessions/setActiveSessionSurface', payload: 'sidebar' })

    render(
      <Provider store={store}>
        <Sidebar view="terminal" onNavigate={vi.fn()} />
      </Provider>
    )

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    fireEvent.change(screen.getByLabelText('Search tier'), { target: { value: 'userMessages' } })

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(400)

    await waitFor(() => {
      expect(searchMock).toHaveBeenCalledWith(
        expect.objectContaining({ tier: 'userMessages' })
      )
    })
  })
})
```

**Step 2: Make the tests pass**

These should pass once the full pipeline is wired. If there are issues with the sidebar window not being set up, adjust the preloaded state.

**Step 3: Refactor**

Ensure tests are clean, well-documented, and don't duplicate coverage from other test files.

---

## Remember

- Always run the full test suite before declaring a task complete (`npm test`)
- Use `npm run test:vitest -- --run path/to/test.ts` for focused test runs during development
- Server uses NodeNext/ESM; relative imports must include `.js` extensions
- Work in the worktree at `/home/user/code/freshell/.worktrees/fix-server-side-search`
- Commit after each task
- The `searchSessionFile` function already handles resource cleanup (file handles, streams) correctly -- reuse it as-is
- The `CodingCliProvider.parseEvent` is the provider-specific JSONL line parser; it's already used by `searchSessionFile`
- `sourceFile` is on `CodingCliSession` but NOT on `SessionDirectoryItem` or `SessionDirectoryComparableItem`. The service needs to look it up from the original `ProjectGroup[]` input, not from the sorted items.
- The `toItems` function in `service.ts` calls `toSessionDirectoryComparableItem` which strips `sourceFile`. The file-based search path must look up `sourceFile` from the original projects, keyed by `provider:sessionId`.
