# Fix Kimi Float Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Zod validation failure caused by sub-millisecond-precision `fs.Stats.mtimeMs` floats in the Kimi provider's `lastActivityAt` field, and add a schema-level regression anchor so no provider can reintroduce floating-point timestamps.

**Architecture:** The root cause is a single line in `KimiProvider.loadSessionCandidate()` that assigns `contextStat.mtimeMs` directly to `lastActivityAt` without truncation. On certain filesystems (ext4, btrfs, NTFS via WSL2), `mtimeMs` has sub-millisecond precision (e.g., `1774212239458.0225`), producing a float that fails the `z.number().int().nonnegative()` constraint in `SessionDirectoryItemSchema`. The fix is `Math.trunc()` at the assignment site. All other providers already produce integers: Claude and Codex use semantic clocks from `parseTimestampMs()` / `Math.round()`, and Kimi's own `normalizeTimestampMs()` for `createdAt` already applies `Math.round()`. Only `lastActivityAt` is unprotected.

**Tech Stack:** TypeScript, Vitest, Zod

---

**Execution note:** Use @trycycle-executing and keep the red-green-refactor order below. Execute in `/home/user/code/freshell/.worktrees/fix-kimi-float-timestamps`.

## Root Cause

`server/coding-cli/providers/kimi.ts:581`:

```typescript
lastActivityAt: contextStat.mtimeMs || contextStat.mtime.getTime(),
```

`fs.Stats.mtimeMs` is typed as `number` and may be a float with sub-millisecond precision on certain filesystems. The fallback `contextStat.mtime.getTime()` always returns an integer (it is the millisecond-precision Date epoch), but the primary path `contextStat.mtimeMs` does not.

This float propagates through `CodingCliSession.lastActivityAt` (a plain `number` in `server/coding-cli/types.ts:193`) into `SessionDirectoryItemSchema.lastActivityAt` (constrained to `z.number().int().nonnegative()` in `shared/read-models.ts:49`), where Zod rejects it. The rejection surfaces as an unhandled promise rejection on the client, which then POSTs to `/api/logs/client`, consuming rate-limit budget.

## Design Decisions

1. **Fix at the source, not the schema.** Loosening the Zod schema to accept floats would weaken a correct contract. Timestamps are millisecond-epoch integers throughout Freshell. The Kimi provider must conform.

2. **Use `Math.trunc()`, not `Math.round()`.** `mtimeMs` already represents milliseconds. Rounding `1774212239458.9` up to `1774212239459` would claim the file was modified one millisecond later than it was. Truncation preserves the correct millisecond bucket. This matches the semantics of `Date.prototype.getTime()` which is the fallback.

3. **Apply to both the primary and fallback paths uniformly.** Although `Date.prototype.getTime()` returns an integer today, wrapping the entire expression in `Math.trunc()` is defensive and communicates intent.

4. **Schema regression test, not a schema change.** Adding a test that explicitly rejects `lastActivityAt: 1000.5` prevents future schema loosening and catches any new provider that emits floats.

5. **Kimi provider unit test validates end-to-end integer contract.** The existing `kimi-provider.test.ts` never asserts on `lastActivityAt`. A new test creates a session fixture with a known float `mtimeMs`, calls `listSessionsDirect()`, and verifies the returned `lastActivityAt` is an integer that passes `SessionDirectoryItemSchema.parse()`.

## File Structure

- **Modify:** `server/coding-cli/providers/kimi.ts:581` — wrap `lastActivityAt` assignment in `Math.trunc()`
- **Test (extend):** `test/unit/server/coding-cli/kimi-provider.test.ts` — add test for integer `lastActivityAt`
- **Test (extend):** `test/unit/shared/session-directory-schema.test.ts` — add regression anchor rejecting float `lastActivityAt`

---

### Task 1: Schema regression anchor — reject float `lastActivityAt`

**Files:**
- Test: `test/unit/shared/session-directory-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test case to `test/unit/shared/session-directory-schema.test.ts` inside the existing `SessionDirectoryItemSchema matchedIn field` describe block's sibling scope (or a new describe block):

```typescript
describe('SessionDirectoryItemSchema lastActivityAt integer enforcement', () => {
  const baseItem = {
    sessionId: 'test-session',
    provider: 'kimi',
    projectPath: '/test',
    lastActivityAt: 1000,
    isRunning: false,
  }

  it('accepts integer lastActivityAt', () => {
    expect(() => SessionDirectoryItemSchema.parse(baseItem)).not.toThrow()
  })

  it('rejects float lastActivityAt', () => {
    expect(() =>
      SessionDirectoryItemSchema.parse({ ...baseItem, lastActivityAt: 1774212239458.0225 }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it passes (this is a regression anchor, not a red test)**

Run: `npm run test:vitest -- --run test/unit/shared/session-directory-schema.test.ts`
Expected: Both new tests PASS (the schema already enforces `.int()`)

This is a regression anchor: it documents and locks the existing correct behavior. If someone later loosens the schema, this test catches it.

- [ ] **Step 3: No implementation needed**

The schema already enforces the integer constraint. This task only adds the anchor.

- [ ] **Step 4: Verify all schema tests pass**

Run: `npm run test:vitest -- --run test/unit/shared/session-directory-schema.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add test/unit/shared/session-directory-schema.test.ts
git commit -m "test: add regression anchor rejecting float lastActivityAt in schema"
```

---

### Task 2: Kimi provider unit test — assert integer `lastActivityAt`

**Files:**
- Test: `test/unit/server/coding-cli/kimi-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new test to `test/unit/server/coding-cli/kimi-provider.test.ts` that creates a temp fixture with a known context file, sets its mtime to a float value, calls `listSessionsDirect()`, and asserts `lastActivityAt` is an integer that passes Zod validation:

```typescript
import { SessionDirectoryItemSchema } from '../../../../shared/read-models'

// Inside the existing describe('KimiProvider', ...) block:

it('returns integer lastActivityAt even when filesystem mtimeMs has sub-millisecond precision', async () => {
  const tempShareDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kimi-provider-float-mtime-'))
  const workDirHash = createHash('md5').update('/test/project').digest('hex')
  const sessionDir = path.join(tempShareDir, 'sessions', workDirHash, 'float-mtime-session')
  await fsp.mkdir(sessionDir, { recursive: true })
  await fsp.writeFile(
    path.join(tempShareDir, 'kimi.json'),
    JSON.stringify({
      work_dirs: [{ path: '/test/project', last_session_id: 'float-mtime-session' }],
    }),
  )
  const contextPath = path.join(sessionDir, 'context.jsonl')
  await fsp.writeFile(
    contextPath,
    JSON.stringify({ role: 'user', content: 'test message' }) + '\n',
  )
  // Set mtime to a value that will have sub-millisecond precision on most filesystems.
  // Note: utimes accepts seconds, so 1774212239.4580225 → mtimeMs ≈ 1774212239458.0225
  const floatTimeSec = 1774212239.4580225
  await fsp.utimes(contextPath, floatTimeSec, floatTimeSec)

  try {
    const provider = new KimiProvider(tempShareDir)
    const sessions = await provider.listSessionsDirect()
    const session = sessions.find((s) => s.sessionId === 'float-mtime-session')

    expect(session).toBeDefined()
    expect(Number.isInteger(session!.lastActivityAt)).toBe(true)

    // Must pass Zod schema validation
    expect(() =>
      SessionDirectoryItemSchema.parse({
        ...session,
        isRunning: false,
      }),
    ).not.toThrow()
  } finally {
    await fsp.rm(tempShareDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts`
Expected: FAIL — `Number.isInteger(session!.lastActivityAt)` returns `false` because `contextStat.mtimeMs` is a float on the test filesystem.

**Note:** If the test filesystem does not produce a float `mtimeMs` (some tmpfs mount points only have millisecond precision), the test will pass vacuously. That is acceptable: the fix is still needed for production filesystems, the schema regression anchor in Task 1 is the primary defense, and the implementation change in Task 3 is correct regardless. Proceed to Task 3 either way.

- [ ] **Step 3: No implementation in this task — proceed to Task 3**

- [ ] **Step 4: Commit the failing test**

```bash
git add test/unit/server/coding-cli/kimi-provider.test.ts
git commit -m "test: add failing test for Kimi float lastActivityAt (red)"
```

---

### Task 3: Fix the Kimi provider — truncate `mtimeMs` to integer

**Files:**
- Modify: `server/coding-cli/providers/kimi.ts:581`

- [ ] **Step 1: Implement the fix**

In `server/coding-cli/providers/kimi.ts`, change line 581 from:

```typescript
lastActivityAt: contextStat.mtimeMs || contextStat.mtime.getTime(),
```

to:

```typescript
lastActivityAt: Math.trunc(contextStat.mtimeMs || contextStat.mtime.getTime()),
```

This wraps the entire expression so both the primary (`mtimeMs`) and fallback (`mtime.getTime()`) paths produce a truncated integer.

- [ ] **Step 2: Run the Kimi provider tests to verify they pass**

Run: `npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts`
Expected: All PASS (including the new float-mtime test from Task 2)

- [ ] **Step 3: Run the schema tests to confirm the anchor still holds**

Run: `npm run test:vitest -- --run test/unit/shared/session-directory-schema.test.ts`
Expected: All PASS

- [ ] **Step 4: Refactor and verify**

Review the change for clarity. The `Math.trunc()` wrapping is minimal and self-documenting. No further refactoring is needed for a single-line fix.

Run the broader test suite to confirm no regressions:

Run: `npm run test:vitest -- --run test/unit/server/coding-cli/`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/providers/kimi.ts
git commit -m "fix: truncate Kimi lastActivityAt to integer to satisfy Zod schema"
```

---

### Task 4: Full suite verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Commit any fixups if needed**

If the full suite reveals any issues, fix them before proceeding.
