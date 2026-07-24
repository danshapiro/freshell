# Claude Generated Session Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code session rows use Claude's generated `type:"summary"` name as the session title instead of falling back to the first user prompt.

**Architecture:** Add a Claude-provider title helper for generated-name records, have the Claude parser return both the chosen title and whether it came from provider-generated metadata, and make the indexer treat provider-generated titles as authoritative over Freshell's directory and first-message fallback overrides. Keep Gemini AI titles, explicit user renames, legacy titles, and sourceless legacy overrides ahead of parsed provider-generated titles; keep lightweight indexing provider-scoped so non-Claude session formats cannot be mis-titled by Claude-only records.

**Tech Stack:** TypeScript, NodeNext ESM imports with `.js` suffixes, Vitest, existing `CodingCliSessionIndexer`.

## Global Constraints

- Work in `.worktrees/claude-code-generated-title` on branch `fix/claude-code-generated-title`.
- Do not restart the self-hosted Freshell server.
- Preserve unrelated changes from other agents.
- Keep behavior scoped to Claude Code JSONL session title extraction and title precedence.
- Use Red-Green-Refactor TDD for behavior changes.
- Do not skip, weaken, or delete tests.
- Server imports must use NodeNext-compatible `.js` relative extensions.
- End-user docs are not required; this fixes existing session naming behavior without adding UI or a visible feature.

---

## Load-Bearing Findings Applied

- Local validation found only one `type:"summary"` sample, [test/fixtures/sessions/real-corrupted.jsonl](/home/dan/code/freshell/.worktrees/claude-code-generated-title/test/fixtures/sessions/real-corrupted.jsonl:6). The implementation supports that known Claude Code shape and the tests lock the regression; broader Claude corpus coverage remains a residual format risk.
- Existing sourced `sessionOverrides.titleOverride` values mask parsed titles today. The fix must bypass only automatic directory/first-message fallbacks when the parsed title is provider-generated, while preserving explicit `titleSource:"user"`, `titleSource:"ai"`, `titleSource:"legacy"`, and sourceless legacy overrides.
- The lightweight scanner is generic. Claude generated-title extraction must be passed only for Claude providers.
- The current lightweight head loop and tail loop can stop before seeing a summary record. The fix must scan complete head lines and continue the tail scan until both newest timestamp and generated title are found, or the bounded tail is exhausted.
- Claude-specific title logic belongs under `server/coding-cli/providers/`, not in the generic `server/title-utils.ts` module.

## File Structure

- Create `server/coding-cli/providers/claude-title.ts`: Claude-only helper that extracts generated display names from `type:"summary"` JSONL records.
- Modify `server/coding-cli/types.ts`: add an internal parsed-title source marker for provider-generated titles.
- Modify `server/coding-cli/providers/claude.ts`: return Claude generated summary titles above prompt/explicit fallback titles, use the latest summary record when multiple exist, and mark them as provider-generated.
- Modify `server/coding-cli/session-indexer.ts`: carry parsed-title source through cache entries, let provider-generated titles beat only `dir`/`first-message` automatic overrides, scan truncated Claude files for generated titles, and provider-scope lightweight generated-title extraction.
- Modify `test/unit/server/coding-cli/claude-provider.test.ts`: cover parser title precedence and source marking.
- Modify `test/unit/server/coding-cli/session-indexer.test.ts`: cover source-aware override precedence, truncated full enrichment, provider-scoped lightweight indexing, and tail-loop robustness.

## Task 1: Full Claude Parser Generated Title

**Files:**
- Create: `server/coding-cli/providers/claude-title.ts`
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/claude.ts`
- Test: `test/unit/server/coding-cli/claude-provider.test.ts`

**Interfaces:**
- Produces: `extractClaudeGeneratedTitleFromJsonlObject(obj: unknown, maxLen?: number): string | undefined`
- Produces: `type ParsedSessionTitleSource = 'provider-generated'`
- Consumes: existing `extractTitleFromMessage(content: string, maxLen?: number): string`

- [ ] **Step 1: Write failing parser tests**

Add these tests inside `describe('parseSessionContent() - title extraction', ...)` in `test/unit/server/coding-cli/claude-provider.test.ts`:

```ts
    it('uses Claude generated summary records as the session title over the prompt fallback', () => {
      const meta = parseSessionContent([
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'can you take a look at this?' } }),
        JSON.stringify({ type: 'summary', summary: 'Auth Redirect Fix' }),
      ].join('\n'))

      expect(meta.title).toBe('Auth Redirect Fix')
      expect(meta.titleSource).toBe('provider-generated')
      expect(meta.summary).toBe('Auth Redirect Fix')
      expect(meta.firstUserMessage).toBe('can you take a look at this?')
    })

    it('keeps Claude rename records ahead of generated summary titles', () => {
      const meta = parseSessionContent([
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'can you take a look at this?' } }),
        JSON.stringify({ type: 'summary', summary: 'Auth Redirect Fix' }),
        JSON.stringify({ type: 'agent-name', agentName: 'Agent Name' }),
        JSON.stringify({ type: 'custom-title', customTitle: 'Pinned Name' }),
      ].join('\n'))

      expect(meta.title).toBe('Pinned Name')
      expect(meta.titleSource).toBe('provider-generated')
      expect(meta.summary).toBe('Auth Redirect Fix')
    })

    it('uses the latest Claude generated summary record when multiple summary records exist', () => {
      const meta = parseSessionContent([
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'can you take a look at this?' } }),
        JSON.stringify({ type: 'summary', summary: 'Initial Investigation' }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } }),
        JSON.stringify({ type: 'summary', summary: 'Auth Redirect Fix' }),
      ].join('\n'))

      expect(meta.title).toBe('Auth Redirect Fix')
      expect(meta.titleSource).toBe('provider-generated')
    })
```

- [ ] **Step 2: Run parser tests and verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/claude-provider.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: FAIL for `uses Claude generated summary records as the session title over the prompt fallback`, with received title `can you take a look at this?` and no `titleSource`.

- [ ] **Step 3: Add the Claude title helper**

Create `server/coding-cli/providers/claude-title.ts`:

```ts
import { extractTitleFromMessage } from '../../title-utils.js'

export function extractClaudeGeneratedTitleFromJsonlObject(obj: unknown, maxLen = 200): string | undefined {
  const record = obj as { type?: unknown; summary?: unknown }
  if (record?.type !== 'summary') return undefined
  if (typeof record.summary !== 'string' || !record.summary.trim()) return undefined
  const title = extractTitleFromMessage(record.summary, maxLen)
  return title || undefined
}
```

- [ ] **Step 4: Add the parsed-title source type**

In `server/coding-cli/types.ts`, add this near the other session metadata types:

```ts
export type ParsedSessionTitleSource = 'provider-generated'
```

Then add the optional field to both `ParsedSessionMeta` and the local `JsonlMeta` interface in `server/coding-cli/providers/claude.ts`:

```ts
  titleSource?: ParsedSessionTitleSource
```

- [ ] **Step 5: Use generated titles in the Claude parser**

In `server/coding-cli/providers/claude.ts`:

1. Add:

```ts
import { extractClaudeGeneratedTitleFromJsonlObject } from './claude-title.js'
```

2. Add `let generatedSummaryTitle: string | undefined` near the existing `let title`, `let customTitle`, and `let agentName` declarations.
3. Inside the JSONL record loop, after custom-title/agent-name handling, add:

```ts
    const generatedTitle = extractClaudeGeneratedTitleFromJsonlObject(obj, 200)
    if (generatedTitle) {
      generatedSummaryTitle = generatedTitle
    }
```

This intentionally keeps the latest generated summary title in file order so full parsing matches the lightweight tail scan when multiple summary records exist.

4. Before the return object, add:

```ts
  const resolvedTitle = customTitle ?? agentName ?? generatedSummaryTitle ?? title
  const titleSource = customTitle || agentName || generatedSummaryTitle ? 'provider-generated' : undefined
```

5. Change the returned title fields to:

```ts
    title: resolvedTitle,
    titleSource,
```

- [ ] **Step 6: Run parser tests and verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/claude-provider.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add server/coding-cli/providers/claude-title.ts server/coding-cli/types.ts server/coding-cli/providers/claude.ts test/unit/server/coding-cli/claude-provider.test.ts
git commit -m "fix: use claude generated summary as session title"
```

## Task 2: Source-Aware Indexer Precedence And Truncated Files

**Files:**
- Modify: `server/coding-cli/session-indexer.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`

**Interfaces:**
- Consumes: `ParsedSessionMeta.titleSource`
- Consumes: `extractClaudeGeneratedTitleFromJsonlObject(obj: unknown, maxLen?: number): string | undefined`
- Produces: cached title source used only by the server-side indexer.

- [ ] **Step 1: Write failing override precedence tests**

Add these tests near the existing metadata-store title tests in `test/unit/server/coding-cli/session-indexer.test.ts`:

```ts
    it('lets a provider-generated parsed title beat a first-message automatic override', async () => {
      const fileA = path.join(tempDir, 'session-provider-title.jsonl')
      await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a' }) + '\n')

      vi.mocked(configStore.snapshot).mockResolvedValue({
        sessionOverrides: {
          [makeSessionKey('claude', 'session-provider-title')]: {
            titleOverride: 'Prompt fallback title',
            titleSource: 'first-message',
          },
        },
        settings: { codingCli: { enabledProviders: ['claude'], providers: {} } },
      })

      const provider = makeProvider([fileA], {
        parseSessionFile: async () => ({
          cwd: '/project/a',
          title: 'Auth Redirect Fix',
          titleSource: 'provider-generated',
        }),
      })

      const indexer = new CodingCliSessionIndexer([provider])
      await indexer.refresh()

      expect(indexer.getProjects()[0]?.sessions[0]?.title).toBe('Auth Redirect Fix')
    })

    it('keeps a finalized ai override ahead of a provider-generated parsed title', async () => {
      const fileA = path.join(tempDir, 'session-ai-title.jsonl')
      await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a' }) + '\n')

      vi.mocked(configStore.snapshot).mockResolvedValue({
        sessionOverrides: {
          [makeSessionKey('claude', 'session-ai-title')]: {
            titleOverride: 'Gemini Generated Title',
            titleSource: 'ai',
          },
        },
        settings: { codingCli: { enabledProviders: ['claude'], providers: {} } },
      })

      const provider = makeProvider([fileA], {
        parseSessionFile: async () => ({
          cwd: '/project/a',
          title: 'Auth Redirect Fix',
          titleSource: 'provider-generated',
        }),
      })

      const indexer = new CodingCliSessionIndexer([provider])
      await indexer.refresh()

      expect(indexer.getProjects()[0]?.sessions[0]?.title).toBe('Gemini Generated Title')
    })

    it('keeps an explicit user override ahead of a provider-generated parsed title', async () => {
      const fileA = path.join(tempDir, 'session-user-title.jsonl')
      await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a' }) + '\n')

      vi.mocked(configStore.snapshot).mockResolvedValue({
        sessionOverrides: {
          [makeSessionKey('claude', 'session-user-title')]: {
            titleOverride: 'My Rename',
            titleSource: 'user',
          },
        },
        settings: { codingCli: { enabledProviders: ['claude'], providers: {} } },
      })

      const provider = makeProvider([fileA], {
        parseSessionFile: async () => ({
          cwd: '/project/a',
          title: 'Auth Redirect Fix',
          titleSource: 'provider-generated',
        }),
      })

      const indexer = new CodingCliSessionIndexer([provider])
      await indexer.refresh()

      expect(indexer.getProjects()[0]?.sessions[0]?.title).toBe('My Rename')
    })
```

- [ ] **Step 2: Write failing truncated-file scan test**

Add this test near the same title tests:

```ts
    it('finds a Claude generated title in the middle of a truncated full-enrichment file', async () => {
      const fileA = path.join(tempDir, 'large-claude-summary.jsonl')
      const beforeSummary = Array.from({ length: 150 }, (_, i) =>
        JSON.stringify({ type: 'noise', payload: `${i}:${'x'.repeat(1024)}` }),
      )
      const afterSummary = Array.from({ length: 180 }, (_, i) =>
        JSON.stringify({ type: 'noise', payload: `${i}:${'y'.repeat(1024)}` }),
      )
      await fsp.writeFile(fileA, [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'large-claude-summary',
          cwd: '/project/a',
          timestamp: '2026-01-01T09:00:00.000Z',
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Prompt fallback title' },
          timestamp: '2026-01-01T09:01:00.000Z',
        }),
        ...beforeSummary,
        JSON.stringify({ type: 'summary', summary: 'Auth Redirect Fix' }),
        ...afterSummary,
      ].join('\n'))

      const { parseSessionContent } = await import('../../../../server/coding-cli/providers/claude')
      const provider = makeProvider([fileA], {
        parseSessionFile: async (content) => parseSessionContent(content),
      })

      const indexer = new CodingCliSessionIndexer([provider])
      await indexer.refresh()

      expect(indexer.getProjects()[0]?.sessions[0]?.title).toBe('Auth Redirect Fix')
    })
```

- [ ] **Step 3: Run indexer tests and verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/session-indexer.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: FAIL for provider-generated override precedence and/or truncated summary discovery.

- [ ] **Step 4: Carry title source through cached sessions**

In `server/coding-cli/session-indexer.ts`:

1. Import the helper and type:

```ts
import { extractClaudeGeneratedTitleFromJsonlObject } from './providers/claude-title.js'
import type { ParsedSessionTitleSource } from './types.js'
```

2. Add `titleSource?: ParsedSessionTitleSource` to `CachedSessionEntry` and `LightweightFileMeta`.
3. Update `resolveSessionTitle` use in `updateCacheEntry` so it also computes a matching source:

```ts
    let resolvedTitleSource: ParsedSessionTitleSource | undefined
    if (parsedTitle) {
      resolvedTitleSource = meta.titleSource
    } else if (sameSession && previous?.title) {
      resolvedTitleSource = cached?.titleSource
    }
```

4. Store `titleSource: resolvedTitleSource` on the cache entry.

- [ ] **Step 5: Make dir and first-message overrides yield to provider-generated titles**

In `server/coding-cli/session-indexer.ts`, change `applyOverride` to accept the cached source:

```ts
function applyOverride(
  session: CodingCliSession,
  ov: SessionOverride | undefined,
  titleSource?: ParsedSessionTitleSource,
): CodingCliSession | null {
  if (ov?.deleted) return null
  const shouldApplyTitleOverride =
    !!ov?.titleOverride &&
    !(titleSource === 'provider-generated' && (ov.titleSource === 'dir' || ov.titleSource === 'first-message'))
  return {
    ...session,
    title: shouldApplyTitleOverride ? ov?.titleOverride : session.title,
    summary: ov?.summaryOverride || session.summary,
    createdAt: ov?.createdAtOverride ?? session.createdAt,
    archived: ov?.archived ?? session.archived ?? false,
  }
}
```

Then update the call site in `buildProjectGroups`:

```ts
      const merged = applyOverride(cached.baseSession, ov, cached.titleSource)
```

- [ ] **Step 6: Add a safe truncated-file scan for Claude generated titles**

In `server/coding-cli/session-indexer.ts`, add:

```ts
async function scanFileForClaudeGeneratedTitle(filePath: string): Promise<string | undefined> {
  try {
    const fd = await fsp.open(filePath, 'r')
    try {
      const stat = await fd.stat()
      const chunkSize = 64 * 1024
      const buf = Buffer.alloc(chunkSize)
      let position = 0
      let pending = ''
      let latestTitle: string | undefined
      while (position < stat.size) {
        const { bytesRead } = await fd.read(buf, 0, Math.min(chunkSize, stat.size - position), position)
        if (bytesRead <= 0) break
        position += bytesRead
        pending += buf.subarray(0, bytesRead).toString('utf8')
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          try {
            const title = extractClaudeGeneratedTitleFromJsonlObject(JSON.parse(line), 200)
            if (title) latestTitle = title
          } catch {
            // Skip malformed session lines.
          }
        }
      }
      if (pending) {
        try {
          latestTitle = extractClaudeGeneratedTitleFromJsonlObject(JSON.parse(pending), 200) ?? latestTitle
        } catch {
          // Skip malformed trailing line.
        }
      }
      return latestTitle
    } finally {
      await fd.close()
    }
  } catch {
    return undefined
  }
  return undefined
}
```

This scan intentionally reads a truncated Claude file in 64 KiB chunks and returns the latest generated title in file order. It only runs for truncated Claude files whose normal snippet parse did not already find a provider-generated title.

After `provider.parseSessionFile(snippet.content, filePath)` in `updateCacheEntry`, add:

```ts
    if (snippet.truncated && provider.name === 'claude' && meta.titleSource !== 'provider-generated') {
      const generatedTitle = await scanFileForClaudeGeneratedTitle(filePath)
      if (generatedTitle) {
        meta.title = generatedTitle
        meta.titleSource = 'provider-generated'
      }
    }
```

- [ ] **Step 7: Run indexer tests and verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/session-indexer.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add server/coding-cli/session-indexer.ts test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "fix: prefer claude provider titles over automatic overrides"
```

## Task 3: Provider-Scoped Lightweight Generated Titles

**Files:**
- Modify: `server/coding-cli/session-indexer.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`

**Interfaces:**
- Consumes: `extractClaudeGeneratedTitleFromJsonlObject`
- Preserves: existing prompt-title extraction for non-Claude providers.

- [ ] **Step 1: Write failing lightweight Claude tail test**

Add this test near the existing lightweight title tests in `test/unit/server/coding-cli/session-indexer.test.ts`:

```ts
  it('extracts a lightweight Claude generated summary title from the tail even when a later timestamp follows it', async () => {
    const files: string[] = []
    const olderSessionId = 'older-claude-summary-session'
    const olderFile = path.join(tempDir, `${olderSessionId}.jsonl`)
    const laterTimestamp = new Date(2026, 0, 1, 9, 3).toISOString()
    await fsp.writeFile(olderFile, [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: olderSessionId,
        cwd: '/project/claude-summary',
        timestamp: new Date(2026, 0, 1, 9).toISOString(),
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'can you look at this bug?' },
        timestamp: new Date(2026, 0, 1, 9, 1).toISOString(),
      }),
      'x'.repeat(5000),
      JSON.stringify({
        type: 'summary',
        summary: 'Auth Redirect Fix',
        timestamp: new Date(2026, 0, 1, 9, 2).toISOString(),
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        timestamp: laterTimestamp,
      }),
    ].join('\n'))
    await fsp.utimes(olderFile, new Date(2026, 0, 1), new Date(2026, 0, 1))
    files.push(olderFile)

    for (let i = 0; i < 151; i += 1) {
      const file = path.join(tempDir, `recent-claude-${i}.jsonl`)
      await fsp.writeFile(file, JSON.stringify({
        cwd: `/project/${i}`,
        title: `Recent ${i}`,
        timestamp: new Date(2026, 3, 5, 12, i).toISOString(),
      }) + '\n')
      files.push(file)
    }

    vi.mocked(configStore.snapshot).mockResolvedValue({
      sessionOverrides: {},
      settings: { codingCli: { enabledProviders: ['claude'], providers: {} } },
    })

    const indexer = new CodingCliSessionIndexer([makeProvider(files)], { fullScanIntervalMs: 0 })
    await indexer.refresh()

    const olderSession = indexer.getProjects()
      .flatMap((group) => group.sessions)
      .find((session) => session.sessionId === olderSessionId)

    expect(olderSession?.title).toBe('Auth Redirect Fix')
    expect(olderSession?.lastActivityAt).toBe(Date.parse(laterTimestamp))
  })
```

- [ ] **Step 2: Write failing non-Claude guard test**

Add this test near the same lightweight title tests:

```ts
  it('does not use Claude summary records as lightweight generated titles for non-Claude providers', async () => {
    const files: string[] = []
    const olderSessionId = 'older-codex-summary-shaped-session'
    const olderFile = path.join(tempDir, `${olderSessionId}.jsonl`)
    await fsp.writeFile(olderFile, [
      JSON.stringify({
        sessionId: olderSessionId,
        cwd: '/project/not-claude',
        role: 'user',
        content: 'Prompt fallback title',
        timestamp: new Date(2026, 0, 1, 9).toISOString(),
      }),
      JSON.stringify({
        type: 'summary',
        summary: 'Should Not Become Title',
        timestamp: new Date(2026, 0, 1, 9, 1).toISOString(),
      }),
    ].join('\n'))
    await fsp.utimes(olderFile, new Date(2026, 0, 1), new Date(2026, 0, 1))
    files.push(olderFile)

    for (let i = 0; i < 151; i += 1) {
      const file = path.join(tempDir, `recent-codex-${i}.jsonl`)
      await fsp.writeFile(file, JSON.stringify({
        cwd: `/project/${i}`,
        title: `Recent ${i}`,
        timestamp: new Date(2026, 3, 5, 12, i).toISOString(),
      }) + '\n')
      files.push(file)
    }

    vi.mocked(configStore.snapshot).mockResolvedValue({
      sessionOverrides: {},
      settings: { codingCli: { enabledProviders: ['codex'], providers: {} } },
    })

    const provider = makeProvider(files, { name: 'codex' })
    const indexer = new CodingCliSessionIndexer([provider], { fullScanIntervalMs: 0 })
    await indexer.refresh()

    const olderSession = indexer.getProjects()
      .flatMap((group) => group.sessions)
      .find((session) => session.sessionId === olderSessionId)

    expect(olderSession?.title).toBe('Prompt fallback title')
  })
```

- [ ] **Step 3: Run indexer tests and verify red**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/session-indexer.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: FAIL for the Claude lightweight summary test.

- [ ] **Step 4: Provider-scope generated title extraction in lightweight metadata**

In `server/coding-cli/session-indexer.ts`:

1. Change `readLightweightMeta` to accept an optional extractor:

```ts
async function readLightweightMeta(
  filePath: string,
  options: { generatedTitleExtractor?: (obj: unknown, maxLen?: number) => string | undefined } = {},
): Promise<LightweightFileMeta> {
```

2. Add `let generatedTitle: string | undefined` beside the existing `let title`.
3. In the head loop, after parsing `obj`, add:

```ts
        if (!generatedTitle) {
          generatedTitle = options.generatedTitleExtractor?.(obj, 200)
        }
```

4. Remove the `if (sessionId && cwd && title && createdAt) break` early exit, because complete head lines are bounded to 4KB.
5. In the tail loop, keep scanning until both `lastActivityAt` and `generatedTitle` are known:

```ts
            if (!generatedTitle) {
              generatedTitle = options.generatedTitleExtractor?.(obj, 200)
            }
            if (!lastActivityAt && obj?.timestamp) {
              const parsed = typeof obj.timestamp === 'number' ? obj.timestamp : Date.parse(obj.timestamp)
              if (Number.isFinite(parsed)) lastActivityAt = parsed
            }
            if (lastActivityAt && generatedTitle) break
```

6. Return the generated title and source when present:

```ts
      return {
        filePath,
        mtimeMs,
        size,
        sessionId,
        cwd,
        title: generatedTitle ?? title,
        titleSource: generatedTitle ? 'provider-generated' : undefined,
        createdAt,
        lastActivityAt,
      }
```

7. In `lightweightScan`, call `readLightweightMeta` with the Claude extractor only for Claude:

```ts
        readLightweightMeta(filePath, {
          generatedTitleExtractor: provider.name === 'claude' ? extractClaudeGeneratedTitleFromJsonlObject : undefined,
        }).then((meta) => ({ provider, meta })),
```

8. Store `titleSource: meta.titleSource` on each lightweight cache entry.

- [ ] **Step 5: Run indexer tests and verify green**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/session-indexer.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Run focused regression suite**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/server/sessions-router-generate-title.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add server/coding-cli/session-indexer.ts test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "fix: index claude generated titles on cold start"
```

## Final Verification

- [ ] Run:

```bash
npm run build:server
```

Expected: PASS.

- [ ] Run:

```bash
npm run check
```

Expected: PASS.

- [ ] Run:

```bash
npm run verify
```

Expected: PASS.

## Self-Review

1. Spec coverage: Task 1 fixes the full Claude parser; Task 2 fixes visible-title precedence when stored automatic overrides exist and handles truncated full-enrichment files; Task 3 fixes cold-start lightweight rows that may not be enriched immediately.
2. No silent deferrals: The production parser and production indexer consume real JSONL session records; no fake provider path replaces production behavior. The only residual risk is the breadth of current Claude Code summary-record formats beyond the locally available fixture.
3. Placeholder scan: No `TBD`, `TODO`, or deferred implementation remains.
4. Type consistency: The helper signature, parsed-title source marker, cache source marker, and tests all use `provider-generated`; all runtime imports include `.js` suffixes.
