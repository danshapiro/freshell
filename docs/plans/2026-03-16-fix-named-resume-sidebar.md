# Fix Named Resume Session Sidebar Visibility Implementation Plan

> **For agentic workers:** REQUIRED: Use trycycle-executing to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bug where a Claude session resumed by human-readable name (e.g. `--resume "137 tour"`) doesn't appear in the sidebar because `normalizeResumeSessionId()` rejects non-UUID resume names for Claude sessions.

**Architecture:** Introduce a new concept: `resumeArg` (the raw value passed to `--resume`, which can be a UUID or a human-readable name) vs `resumeSessionId` (the canonical UUID session binding). The spawn path passes the raw resume arg through to Claude Code unchanged. The terminal starts without a session binding when the resume arg is non-UUID, and the existing `SessionAssociationCoordinator` discovers the actual UUID from the JSONL file and binds the terminal later. Client-side fallback sidebar item generation and session ref extraction are updated to handle non-UUID resume args through a new `pendingResumeName` field rather than trying to use them as session IDs.

**Tech Stack:** TypeScript, Vitest, node-pty (mocked), React Testing Library

---

## Root Cause Analysis

When a user resumes a Claude session by name (e.g., `--resume "137 tour"`), three gates reject the non-UUID resume name:

1. **`ws-handler.ts` line 1135**: Checks `isValidClaudeSessionId(effectiveResumeSessionId)` and sets it to `undefined` if invalid
2. **`terminal-registry.ts` `create()` line 1057**: Calls `normalizeResumeSessionId()` which returns `undefined` for non-UUID Claude names
3. **`terminal-registry.ts` `buildSpawnSpec()` line 724**: Also calls `normalizeResumeSessionId()` which returns `undefined`

This means: (a) `--resume "137 tour"` is never passed to Claude Code, so Claude starts a fresh session instead of resuming; (b) the terminal is created without any session binding; and (c) even when the association coordinator tries to bind later via `bindSession()` (line 1778), it would fail for the same reason.

The client side has parallel issues: `session-utils.ts`, `sidebarSelectors.ts`, `panesSlice.ts`, and `layoutMirrorMiddleware.ts` all gate Claude session refs on `isValidClaudeSessionId()`, so a pane with `resumeSessionId: "137 tour"` is invisible to the sidebar fallback path.

## Design Decisions

### Decision 1: Separate "resume arg" from "session ID" (chosen approach)

Claude Code's `--resume` flag accepts either a UUID or a human-readable name. The JSONL session file is always UUID-named. Freshell should:

- Pass the raw resume arg through to the CLI spawn unchanged
- Not use a non-UUID resume arg as a session binding key
- Store the raw resume arg on the terminal record as `pendingResumeName` (when non-UUID) so the terminal can be identified as "waiting for session discovery"
- Let the `SessionAssociationCoordinator` do its job: discover the UUID from the JSONL file, match by cwd, and bind

**Why not resolve the name to a UUID eagerly?** Claude Code's name-to-UUID mapping is internal and not exposed via any API. We would have to scan `~/.claude/projects/*/sessions/*.jsonl` and parse each file to find the session name -- which is complex, fragile, and duplicates work the indexer already does. The association coordinator already handles the "discover and bind" flow for any unassociated terminal. We just need to stop blocking the spawn.

**Why not treat non-UUID resume names as valid session IDs everywhere?** Session IDs are UUIDs throughout the system: they're used as map keys, JSONL filenames, and deduplication identifiers. Allowing arbitrary strings as session IDs would require auditing every session ID comparison, storage path, and API contract. The "pending resume name" approach is much safer.

### Decision 2: Store `pendingResumeName` on TerminalRecord

When a Claude terminal is created with a non-UUID resume name, we store it as `pendingResumeName` on the `TerminalRecord`. This serves two purposes:
- It lets the server pass the name through to the `--resume` flag
- It lets the client show something meaningful in the sidebar while waiting for the UUID to be discovered

Once the association coordinator binds the actual UUID, `resumeSessionId` is set and `pendingResumeName` becomes informational.

### Decision 3: Client-side approach

On the client side, the pane content stores `resumeSessionId` which may be a non-UUID name (set by the user when opening the tab). The existing `isValidClaudeSessionId` gates in `session-utils.ts`, `sidebarSelectors.ts`, `panesSlice.ts`, and `layoutMirrorMiddleware.ts` prevent this from creating any session association or sidebar entry.

The fix: when a Claude pane has a non-UUID `resumeSessionId`, it should still create a fallback sidebar item (with `hasTitle: false` initially, since we don't have the real session data yet) and should be discoverable by the session matching logic. However, we cannot use the non-UUID name as the session key -- instead, we use a synthetic key pattern `claude:pending:<resumeName>` for the fallback item so it doesn't collide with real UUID-keyed sessions.

Actually, the simpler and correct approach: the pane stores `resumeSessionId` as the raw user input. When the server discovers the real UUID and binds, the `terminal.session.associated` broadcast updates the pane's `resumeSessionId` to the real UUID (this already happens via `sessionRef` updates). The fallback sidebar item just needs to handle the non-UUID case during the interim period.

**Revised client-side approach:** Rather than adding complex synthetic keys, we make the client-side `isValidClaudeSessionId` checks in the *fallback path* more permissive. A fallback sidebar item for a non-UUID Claude resume name should still be created (it represents an "open tab for a session we're waiting to discover"). This item will be replaced by the real session once the indexer finds it and the server broadcasts the update.

Concretely:
- `session-utils.ts` `isValidSessionRef()`: Allow non-UUID Claude session refs when they look like a human-readable resume name (not empty)
- `sidebarSelectors.ts` `collectFallbackItemsFromNode()` and tab fallback loop: Allow non-UUID Claude resume names to create fallback items
- `panesSlice.ts` `buildPaneContent()`: Already stores the raw `resumeSessionId` when `hasLifecycleFields` is true; needs to also store it when it's a non-UUID name used for initial creation
- `layoutMirrorMiddleware.ts` `buildTabFallbackSessionRef()`: Allow non-UUID Claude session refs

**Wait -- this approach has a problem.** If we allow non-UUID strings as session refs, they'll be used as session keys throughout the system (e.g., `claude:137 tour`), which will never match the real UUID-based session key once it's discovered. This creates orphaned entries and potential confusion.

### Decision 3 (revised): Introduce `isValidCodingCliResumeId`

Create a new validation function that accepts either a UUID (for direct session ID references) or a non-empty string (for named resume references). Use this in the fallback/display paths only. The binding/authority paths continue to require UUIDs.

Actually, let me think about this more carefully. The real question is: what should happen in the sidebar during the window between "terminal spawned with `--resume '137 tour'`" and "association coordinator discovers the UUID and binds it"?

**Answer:** The terminal will appear as a running terminal in a tab. The tab should show in the sidebar as a fallback item. But since we don't know the real session UUID yet, we can't create a proper session-keyed sidebar item. We have two options:

1. **Don't show a sidebar item until the UUID is discovered.** The tab is still visible and usable; it just won't have a corresponding sidebar entry until the indexer runs (usually seconds). This is acceptable behavior -- it's the same experience as creating a brand new Claude session (which also starts unassociated).

2. **Show a temporary sidebar item keyed by the non-UUID name.** This creates complications with session key mismatches.

Option 1 is simpler and correct. The real fix is just on the **server side**: pass the resume name through to `--resume` so Claude Code actually resumes the right session, and don't block the association flow. The client doesn't need to change its UUID validation at all -- the sidebar item will appear once the UUID is discovered and bound.

**But wait:** The user's complaint is "the session is active but isn't showing up in the left panel." If we go with Option 1, the session would show up once the association coordinator binds it (seconds later). The user's complaint suggests it NEVER shows up. Why?

Because the server currently rejects the non-UUID resume name entirely, so:
- Claude Code is launched WITHOUT `--resume "137 tour"` (the arg is stripped)
- Claude Code starts a FRESH session instead of resuming "137 tour"
- The fresh session gets a new UUID
- The terminal IS associated with the new UUID (eventually)
- But the user expects to see the "137 tour" session, not a new session

So the primary fix is server-side: pass `--resume "137 tour"` through to Claude Code. Once that works, Claude Code resumes the correct session, writes to the correct UUID-named JSONL file, and the indexer + association coordinator do their job. The sidebar will show the session under its real title.

### Final Design

**Server changes:**
1. `normalizeResumeSessionId()` in `terminal-registry.ts` (line 297): Return the raw value for Claude when it's a non-empty string (not just when it's a valid UUID). Rename to clarify it normalizes for spawn, not for binding.
2. `buildSpawnSpec()` in `terminal-registry.ts`: Pass the raw resume arg through to the CLI command.
3. `create()` in `terminal-registry.ts`: Split the logic -- use the raw resume arg for spawning, but only bind the session if it's a valid UUID. Store the raw name as `pendingResumeName` when non-UUID.
4. `ws-handler.ts`: Remove the early `isValidClaudeSessionId` check that discards non-UUID resume names. Let the registry handle it.
5. `bindSession()`: Keep requiring valid UUIDs (this is correct -- bindings must use canonical IDs).

**The terminal record gets a new optional field:** `pendingResumeName?: string`. Set when a Claude terminal is created with a non-UUID resume name. This is informational -- it indicates the terminal was spawned with `--resume <name>` but hasn't been bound to a UUID session yet.

**No client changes required.** The client correctly handles the case where a terminal starts unassociated and gets bound later. The existing `terminal.session.associated` -> `sessionRef` update flow handles the transition.

**However**, the client's `panesSlice.ts` `buildPaneContent()` currently strips non-UUID `resumeSessionId` for Claude terminals without lifecycle fields. This means when a tab is restored from localStorage with `resumeSessionId: "137 tour"`, it becomes `undefined`. This is fine because:
- The tab was originally created with `resumeSessionId: "137 tour"`
- The server received it and (with our fix) spawned Claude with `--resume "137 tour"`
- Claude Code resumed the session, indexer found the UUID, association coordinator bound it
- The server sent `terminal.session.associated` with the real UUID
- The pane's `resumeSessionId` was updated to the real UUID
- That's what's persisted to localStorage

But what if the user refreshes the page BEFORE the UUID is discovered? Then `resumeSessionId` in localStorage is still "137 tour", and `buildPaneContent()` strips it. The terminal create request goes out with no resume ID, and Claude starts fresh. This is a pre-existing edge case that's not specific to this bug.

Actually, looking more carefully at the client code: when `hasLifecycleFields` is true (which it is after the terminal is created and the pane has `createRequestId` and `status`), the `resumeSessionId` is preserved as-is without UUID validation. So the non-UUID name IS kept in the pane content during the terminal's lifecycle. It's only stripped when `hasLifecycleFields` is false (initial pane creation / restore).

For the restore path: when the page reloads and the pane content is deserialized from localStorage, `hasLifecycleFields` is true (it has `createRequestId` and `status`), so `resumeSessionId: "137 tour"` is preserved. The terminal.create message will include it, the server will pass it through, and Claude will resume correctly. Good.

But the `sessionRef` won't be built for a non-UUID Claude `resumeSessionId` (line 31-35 and 39 in panesSlice.ts). This means the pane won't be tracked as having a session ref, which means `collectSessionRefsFromNode` won't find it, which means `collectFallbackItemsFromNode` won't be called for it. Actually wait -- `collectFallbackItemsFromNode` is called for ALL panes in a tab's layout tree (line 218-222 in sidebarSelectors.ts), not just ones with session refs. Let me re-read.

Looking at `sidebarSelectors.ts` lines 215-223:
```js
for (const tab of tabs || []) {
    const layout = panes.layouts?.[tab.id]
    if (layout) {
      const refs = collectSessionRefsFromNode(layout)
      if (refs.length > 0) {
        collectFallbackItemsFromNode(layout, tab)
      }
      continue
    }
```

So `collectFallbackItemsFromNode` is ONLY called if `collectSessionRefsFromNode` returns non-empty. And `collectSessionRefsFromNode` uses `isValidSessionRef` which requires UUID for Claude. So a tab with only a non-UUID Claude pane won't generate any fallback items!

This IS a client-side issue after all, but only for the interim period before the UUID is discovered. Once the UUID is bound and the pane's `sessionRef` is updated, the fallback items work fine. And the REAL session data from the indexer will show it in the sidebar regardless.

The question is: is the user seeing this bug because the UUID is never discovered? Or because there's a timing issue?

Given the user says the session "is active in this session" but not in the sidebar, the most likely scenario is: the server stripped `--resume "137 tour"`, Claude started fresh with a new UUID, that new UUID IS eventually indexed and shown in the sidebar, but the session titled "137 tour" was never actually resumed, so it never gets new activity, and its title/data is from a previous run. The sidebar shows the NEW session, not the one the user expected.

So the fix IS primarily server-side. Once the server passes through the named resume, Claude Code resumes the correct session, the indexer picks up activity on the existing UUID-named JSONL file, and the sidebar shows it.

For completeness, we should also fix the client-side fallback path so that a non-UUID Claude resume name doesn't block sidebar visibility during the discovery window. This is a defense-in-depth improvement.

## File Structure

### Files to Modify

1. **`server/terminal-registry.ts`** (primary fix)
   - `normalizeResumeSessionId()` (line 297-303): Split into two functions:
     - `normalizeResumeForSpawn()`: Returns the raw resume arg for any non-empty string (used by `buildSpawnSpec`)
     - `normalizeResumeForBinding()`: Returns only valid UUIDs for Claude (used by `bindSession` and the binding path in `create`)
   - `create()` (around line 1057): Use `normalizeResumeForSpawn` for spawn, `normalizeResumeForBinding` for session binding
   - `buildSpawnSpec()` (line 724): Use `normalizeResumeForSpawn`
   - `bindSession()` (line 1778): Use `normalizeResumeForBinding`
   - `TerminalRecord` type: Add optional `pendingResumeName?: string`
   - `findUnassociatedTerminals()`: Include terminals that have `pendingResumeName` but no `resumeSessionId`

2. **`server/ws-handler.ts`** (remove redundant gate)
   - Remove lines 1135-1138 that discard non-UUID Claude resume names. The terminal registry's normalization is the single source of truth.

3. **`server/session-association-coordinator.ts`** (no changes needed -- it already works correctly when terminals are unassociated)

4. **`src/store/selectors/sidebarSelectors.ts`** (client-side defense in depth)
   - `collectFallbackItemsFromNode()` (line 201): Remove the `isValidClaudeSessionId` check that prevents non-UUID Claude resume names from creating fallback items, OR change the condition to only skip empty strings
   - Tab fallback loop (line 228): Same treatment

5. **`src/lib/session-utils.ts`** (client-side defense in depth)
   - `isValidSessionRef()` (line 22-26): Allow non-UUID Claude session refs when they are non-empty strings

6. **`src/store/layoutMirrorMiddleware.ts`** (client-side defense in depth)
   - `buildTabFallbackSessionRef()` (line 16): Allow non-UUID Claude session refs

7. **`src/store/panesSlice.ts`** (client-side defense in depth)
   - `buildPaneContent()` (lines 29-35): Allow non-UUID Claude `resumeSessionId` to be preserved for initial pane creation

### Test Files to Modify/Create

1. **`test/unit/server/terminal-registry.test.ts`**: Update tests for `normalizeResumeSessionId` and `buildSpawnSpec` to verify non-UUID Claude resume names are passed through
2. **`test/unit/client/store/selectors/sidebarSelectors.test.ts`**: Add test for non-UUID Claude resume name fallback item
3. **`test/unit/client/lib/session-utils.test.ts`**: Add test for non-UUID Claude session ref in `isValidSessionRef`
4. **`test/server/session-association.test.ts`**: Add test for named-resume-to-UUID association flow
5. **`test/e2e/open-tab-session-sidebar-visibility.test.tsx`**: Add test for non-UUID resume name tab visibility

---

### Task 1: Server-side — Split resume normalization and pass named resume through to spawn

This is the core fix. We split `normalizeResumeSessionId` into two functions and update the three callsites.

**Files:**
- Modify: `server/terminal-registry.ts:297-303` (normalizeResumeSessionId)
- Modify: `server/terminal-registry.ts:694-` (buildSpawnSpec)
- Modify: `server/terminal-registry.ts:1050-` (create)
- Modify: `server/terminal-registry.ts:1735-1754` (findUnassociatedTerminals)
- Modify: `server/terminal-registry.ts:1768-1837` (bindSession)
- Modify: `server/ws-handler.ts:1135-1138` (remove early UUID check)
- Test: `test/unit/server/terminal-registry.test.ts`

- [ ] **Step 1: Write failing test — `buildSpawnSpec` should pass `--resume` with non-UUID Claude name**

In `test/unit/server/terminal-registry.test.ts`, find the test `'omits --resume when resumeSessionId is invalid'` (line 764) and add a new test alongside it:

```typescript
it('passes --resume with human-readable resume name for Claude', () => {
  delete process.env.CLAUDE_CMD

  const spec = buildSpawnSpec('claude', '/Users/john', 'system', '137 tour')

  expect(spec.args).toContain('--resume')
  expect(spec.args).toContain('137 tour')
})
```

Also add for Linux:

```typescript
it('passes --resume with human-readable resume name on Linux', () => {
  delete process.env.CLAUDE_CMD

  const spec = buildSpawnSpec('claude', '/home/user', 'system', '137 tour')

  expect(spec.args).toContain('--resume')
  expect(spec.args).toContain('137 tour')
})
```

And update the existing `'omits --resume when resumeSessionId is invalid'` test to be specific about WHAT is invalid -- an empty string should still omit resume, but a non-UUID non-empty name should pass through:

```typescript
it('omits --resume when resumeSessionId is empty string', () => {
  delete process.env.CLAUDE_CMD

  const spec = buildSpawnSpec('claude', '/Users/john', 'system', '')

  expect(spec.args).not.toContain('--resume')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts -t "passes --resume with human-readable resume name"`
Expected: FAIL — the current `normalizeResumeSessionId` returns `undefined` for non-UUID Claude names, so `--resume` is omitted.

- [ ] **Step 3: Implement — Split `normalizeResumeSessionId` into spawn and binding variants**

In `server/terminal-registry.ts`, replace the existing `normalizeResumeSessionId` function (line 297-303) with two functions:

```typescript
/**
 * Normalize a resume identifier for spawning the CLI process.
 * Claude Code accepts both UUIDs and human-readable names for --resume.
 * Returns the raw value for any non-empty string; undefined for empty/missing.
 */
function normalizeResumeForSpawn(_mode: TerminalMode, resumeSessionId?: string): string | undefined {
  if (!resumeSessionId) return undefined
  return resumeSessionId
}

/**
 * Normalize a resume identifier for session binding (the authoritative
 * terminal-to-session association).  Claude session files are UUID-named,
 * so only valid UUIDs can be used as binding keys.  Other providers
 * accept any non-empty string.
 */
function normalizeResumeForBinding(mode: TerminalMode, resumeSessionId?: string): string | undefined {
  if (!resumeSessionId) return undefined
  if (mode !== 'claude') return resumeSessionId
  if (isValidClaudeSessionId(resumeSessionId)) return resumeSessionId
  return undefined
}
```

Note: `normalizeResumeForSpawn` doesn't need the mode parameter since all modes pass through, but we keep it for symmetry and future extensibility. The leading underscore signals it's intentionally unused.

Update `buildSpawnSpec` (line 724) to use `normalizeResumeForSpawn`:

```typescript
const normalizedResume = normalizeResumeForSpawn(mode, resumeSessionId)
```

Update `create()` (line 1057) to use the spawn variant for spawning and the binding variant for session binding:

```typescript
const resumeForSpawn = normalizeResumeForSpawn(opts.mode, opts.resumeSessionId)
const resumeForBinding = normalizeResumeForBinding(opts.mode, opts.resumeSessionId)
```

Then update the `buildSpawnSpec` call (line 1073) to use `resumeForSpawn`, and the binding block (line 1222-1230) to use `resumeForBinding`:

```typescript
const { file, args, env, cwd: procCwd } = buildSpawnSpec(
  opts.mode,
  cwd,
  opts.shell || 'system',
  resumeForSpawn,
  opts.providerSettings,
  baseEnv,
)
```

And the binding:

```typescript
this.terminals.set(terminalId, record)
if (modeSupportsResume(opts.mode) && resumeForBinding) {
  const bound = this.bindSession(terminalId, opts.mode as CodingCliProviderName, resumeForBinding, 'resume')
  if (!bound.ok) {
    logger.warn(
      { terminalId, mode: opts.mode, sessionId: resumeForBinding, reason: bound.reason },
      'Failed to bind resume session during terminal create',
    )
  }
}
```

Also store `pendingResumeName` on the terminal record when we have a resume arg but no binding:

Add to the `TerminalRecord` interface:
```typescript
pendingResumeName?: string
```

In `create()`, after the binding block:
```typescript
if (resumeForSpawn && !resumeForBinding) {
  record.pendingResumeName = resumeForSpawn
  logger.info(
    { terminalId, mode: opts.mode, pendingResumeName: resumeForSpawn },
    'Terminal created with named resume; awaiting session association',
  )
}
```

Update `bindSession()` (line 1778) to use `normalizeResumeForBinding`:

```typescript
const normalized = normalizeResumeForBinding(provider, sessionId)
if (!normalized) return { ok: false, reason: 'invalid_session_id' }
```

Update `findUnassociatedTerminals()` (line 1735-1754) to also match terminals that have `pendingResumeName` but no `resumeSessionId`:

```typescript
for (const term of this.terminals.values()) {
  if (term.mode !== mode) continue
  if (term.resumeSessionId) continue // Already associated
  if (!term.cwd) continue
  if (normalize(term.cwd) === targetCwd) {
    results.push(term)
  }
}
```

This already works correctly — a terminal with `pendingResumeName` but no `resumeSessionId` will be matched. No change needed here.

Also update the export of `normalizeResumeSessionId` in the module's exports (search for any re-exports). The function `normalizeResumeSessionId` is also exported from `spawn-spec.ts` but that file is not imported by anything active. Check if `terminal-registry.ts` exports it:

The function at line 297 is not exported (it's a module-level `function`, not `export function`). Good — no export changes needed.

Finally, remove the redundant early check in `ws-handler.ts` (lines 1135-1138):

```typescript
// REMOVE these lines:
if (m.mode === 'claude' && effectiveResumeSessionId && !isValidClaudeSessionId(effectiveResumeSessionId)) {
  log.warn({ resumeSessionId: effectiveResumeSessionId, connectionId: ws.connectionId }, 'Ignoring invalid Claude resumeSessionId')
  effectiveResumeSessionId = undefined
}
```

The terminal registry's split normalization now handles this correctly — the spawn gets the raw name, the binding only uses valid UUIDs.

Update the existing test `'omits --resume when resumeSessionId is invalid'` (line 764) to reflect the new behavior. The test name and assertion should change: non-UUID names are NOW valid resume args for Claude. Change the test to verify that empty strings are rejected:

Old:
```typescript
it('omits --resume when resumeSessionId is invalid', () => {
  delete process.env.CLAUDE_CMD
  const spec = buildSpawnSpec('claude', '/Users/john', 'system', 'not-a-uuid')
  expect(spec.args).not.toContain('--resume')
})
```

New:
```typescript
it('passes --resume with human-readable name for claude', () => {
  delete process.env.CLAUDE_CMD
  const spec = buildSpawnSpec('claude', '/Users/john', 'system', 'not-a-uuid')
  expect(spec.args).toContain('--resume')
  expect(spec.args).toContain('not-a-uuid')
})
```

Similarly update all Windows-specific tests that assert `--resume` is omitted for invalid IDs:
- `'omits --resume in cmd.exe string when invalid'` (line 1581)
- `'omits --resume in PowerShell command when invalid'` (line 1587)
- `'omits --resume in WSL args when invalid'` (line 1593)

These should now assert that `--resume` IS present with the non-UUID name.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts`
Expected: All tests pass, including the new ones and the updated ones.

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar
git add server/terminal-registry.ts server/ws-handler.ts test/unit/server/terminal-registry.test.ts
git commit -m "fix: pass named Claude resume args through to CLI spawn

Split normalizeResumeSessionId into normalizeResumeForSpawn (pass-through)
and normalizeResumeForBinding (UUID-only for session authority). Claude Code
natively supports --resume with human-readable names; Freshell was incorrectly
stripping them."
```

---

### Task 2: Server-side — Integration test for named resume association flow

Verify that when a terminal is created with a non-UUID Claude resume name, the association coordinator can later bind the real UUID when it's discovered.

**Files:**
- Test: `test/server/session-association.test.ts`

- [ ] **Step 1: Write failing test — named resume terminal gets associated with UUID**

Add to `test/server/session-association.test.ts`:

```typescript
it('associates a Claude terminal created with a human-readable resume name after UUID discovery', () => {
  const registry = new TerminalRegistry()
  const coordinator = new SessionAssociationCoordinator(registry, 30_000)
  const onBound = vi.fn()

  // Terminal created with a non-UUID resume name — the server passes it
  // through to --resume but doesn't create a session binding.
  const terminal = registry.create({
    mode: 'claude',
    cwd: '/home/user/project',
    resumeSessionId: '137 tour',
  })

  expect(terminal.resumeSessionId).toBeUndefined()
  expect(terminal.pendingResumeName).toBe('137 tour')

  registry.on('terminal.session.bound', onBound)

  // The indexer discovers the real UUID from the JSONL file
  const realUuid = '550e8400-e29b-41d4-a716-446655440000'
  const result = coordinator.associateSingleSession({
    provider: 'claude',
    sessionId: realUuid,
    projectPath: '/home/user/project',
    lastActivityAt: Date.now(),
    cwd: '/home/user/project',
  })

  expect(result).toEqual({ associated: true, terminalId: terminal.terminalId })
  expect(registry.get(terminal.terminalId)?.resumeSessionId).toBe(realUuid)
  expect(onBound).toHaveBeenCalledWith({
    terminalId: terminal.terminalId,
    provider: 'claude',
    sessionId: realUuid,
    reason: 'association',
  })

  registry.shutdown()
})
```

- [ ] **Step 2: Run test to verify it fails (or passes — it may already work if Task 1 is complete)**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/server/session-association.test.ts -t "associates a Claude terminal created with a human-readable resume name"`
Expected: PASS (if Task 1 is implemented) or FAIL (if Task 1 is not yet implemented — the `pendingResumeName` field won't exist).

- [ ] **Step 3: Verify the test passes (no additional implementation needed if Task 1 is complete)**

The association coordinator already handles this: `findUnassociatedTerminals` returns terminals with no `resumeSessionId`, and `bindSession` accepts the real UUID. The new test just validates the end-to-end flow.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/server/session-association.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar
git add test/server/session-association.test.ts
git commit -m "test: add integration test for named resume -> UUID association flow"
```

---

### Task 3: Client-side — Allow non-UUID Claude resume names in sidebar fallback path

Fix the client-side fallback item generation so that a tab with a non-UUID Claude `resumeSessionId` still creates a sidebar entry during the interim period before the UUID is discovered and bound.

**Files:**
- Modify: `src/lib/session-utils.ts:22-26` (isValidSessionRef)
- Modify: `src/store/selectors/sidebarSelectors.ts:201` (collectFallbackItemsFromNode terminal guard)
- Modify: `src/store/selectors/sidebarSelectors.ts:228` (tab fallback loop guard)
- Modify: `src/store/layoutMirrorMiddleware.ts:16` (buildTabFallbackSessionRef guard)
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Test: `test/unit/client/lib/session-utils.test.ts` (if it exists)

- [ ] **Step 1: Write failing test — fallback sidebar item for non-UUID Claude resume name**

In `test/unit/client/store/selectors/sidebarSelectors.test.ts`, add a test in the `buildSessionItems` describe block:

```typescript
it('creates a fallback sidebar item for a Claude pane with a human-readable resume name', () => {
  const tabs = [
    { id: 'tab-named', title: 'Named Resume Session', mode: 'claude', createdAt: 3_000 },
  ] as any

  const panes = {
    layouts: {
      'tab-named': {
        type: 'leaf',
        id: 'pane-named',
        content: {
          kind: 'terminal',
          mode: 'claude',
          status: 'running',
          createRequestId: 'req-named',
          resumeSessionId: '137 tour',
        },
      },
    },
    activePane: {
      'tab-named': 'pane-named',
    },
    paneTitles: {
      'tab-named': {
        'pane-named': 'Named Resume Session',
      },
    },
  } as any

  const items = buildSessionItems([], tabs, panes, emptyTerminals, emptyActivity)

  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    sessionId: '137 tour',
    provider: 'claude',
    title: 'Named Resume Session',
    hasTab: true,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/unit/client/store/selectors/sidebarSelectors.test.ts -t "creates a fallback sidebar item for a Claude pane with a human-readable resume name"`
Expected: FAIL — current code skips non-UUID Claude session refs in the fallback path.

- [ ] **Step 3: Implement — Relax UUID requirement in fallback display paths**

**In `src/lib/session-utils.ts`**, modify `isValidSessionRef` to accept non-UUID Claude session refs when they are non-empty:

```typescript
function isValidSessionRef(provider: string, sessionId: string): provider is CodingCliProviderName {
  if (!isNonShellMode(provider) || sessionId.length === 0) return false
  // All non-empty session IDs are valid refs. Claude named resumes (non-UUID)
  // are legitimate: the terminal was launched with --resume "<name>" and is
  // waiting for the association coordinator to discover the real UUID.
  return true
}
```

**Justification:** `isValidSessionRef` is used by `extractSessionLocators`, `sanitizeSessionLocator`, `buildTabFallbackLocator`, and `collectSessionRefsFromNode`. These are all in the *display/navigation* path, not the *binding authority* path. Allowing non-UUID Claude refs here lets the sidebar show a fallback item for the tab while the UUID is being discovered. Once the UUID is bound, the pane's `sessionRef` is updated to the real UUID.

**In `src/store/selectors/sidebarSelectors.ts`**, modify the two `isValidClaudeSessionId` guards in the fallback path:

Line 201 (inside `collectFallbackItemsFromNode`, terminal kind branch):
```typescript
// OLD:
if (node.content.mode === 'claude' && !isValidClaudeSessionId(node.content.resumeSessionId)) return

// NEW:
// Allow non-UUID Claude resume names as fallback items — they represent
// terminals launched with --resume "<name>" that haven't been bound to
// a UUID yet.  The empty-string case is already handled by the
// !node.content.resumeSessionId check above.
```

Remove this line entirely. The previous `if (node.content.mode === 'shell' || !node.content.resumeSessionId) return` already handles the empty/missing case.

Line 228 (tab fallback loop):
```typescript
// OLD:
if (provider === 'claude' && !isValidClaudeSessionId(sessionId)) continue

// NEW: removed — isValidSessionRef in session-utils.ts now allows non-UUID Claude refs,
// and empty sessionId is handled by the !sessionId check above.
```

Remove this line entirely.

**In `src/store/layoutMirrorMiddleware.ts`**, modify `buildTabFallbackSessionRef` (line 16):
```typescript
// OLD:
if (provider === 'claude' && !isValidClaudeSessionId(sessionId)) return undefined

// NEW: removed — non-UUID Claude resume names are legitimate session refs
// for layout sync. The server uses them for terminal identification.
```

Remove this line.

**In `src/store/panesSlice.ts`**, modify `buildPaneContent` (lines 29-35) for terminal content:
```typescript
// OLD:
const resumeSessionId = hasLifecycleFields
  ? inputResumeSessionId
  : mode === 'claude' && isValidClaudeSessionId(input.resumeSessionId)
    ? input.resumeSessionId
    : mode === 'claude'
      ? undefined
      : input.resumeSessionId

// NEW:
const resumeSessionId = hasLifecycleFields
  ? inputResumeSessionId
  : inputResumeSessionId
```

Wait, that removes the UUID validation entirely, which is too permissive. The validation was there to prevent junk data from being stored. Let me think...

Actually, the validation for initial pane creation (non-lifecycle fields) should just check for non-empty string, not UUID format. If the user explicitly sets a resume name, we should preserve it:

```typescript
const resumeSessionId = inputResumeSessionId
```

This is simpler and correct. The `inputResumeSessionId` is already validated as a non-empty string (or undefined) on line 26-28. The only thing the old code added was stripping non-UUID Claude names, which is exactly the bug we're fixing.

For the `sessionRef` construction (line 42-45), it should still only create a `sessionRef` when the resume ID is a valid UUID (since `sessionRef` is used for cross-device identity):

```typescript
const sessionRef = explicitSessionRef
  ?? (resumeSessionId && mode !== 'shell'
    ? (mode === 'claude' && !isValidClaudeSessionId(resumeSessionId)
      ? undefined  // Non-UUID Claude names can't be used as session refs yet
      : { provider: mode, sessionId: resumeSessionId })
    : undefined)
```

Actually wait -- we changed `isValidSessionRef` in `session-utils.ts` to allow non-UUID Claude refs. And `sessionRef` is validated through `sanitizeSessionLocator` which uses `isValidSessionRef`. So if we allow it there, it will work. But `sessionRef` is used for cross-device session identity, and a named resume like "137 tour" is not stable across devices.

Hmm, let me reconsider. The `sessionRef` is set when the pane is first created. Once the real UUID is discovered and bound, the `sessionRef` is updated (via `terminal.session.associated` handling in `panesSlice.ts`). So a temporary non-UUID `sessionRef` will be replaced. And during the interim, having a sessionRef (even non-UUID) is better than not having one, because it lets the sidebar show the fallback item.

But the risk is: if the non-UUID sessionRef is synced to other devices via `layoutMirrorMiddleware`, those devices will have a ref that doesn't match any session. That's confusing but not harmful — it just means the other device won't show a sidebar item for it (same as today).

I think the cleanest approach is:
- `session-utils.ts`: Allow non-UUID Claude refs in `isValidSessionRef`
- `sidebarSelectors.ts`: Remove the UUID guards in the fallback path
- `layoutMirrorMiddleware.ts`: Remove the UUID guard (the other device just gets a ref it can't resolve, which is harmless)
- `panesSlice.ts`: Allow non-UUID Claude resumeSessionId to be stored, but don't auto-create a `sessionRef` for non-UUID Claude names (the ref will be set when the server associates the real UUID)

So for `panesSlice.ts`, the `resumeSessionId` line simplifies to:
```typescript
const resumeSessionId = inputResumeSessionId
```

And the `sessionRef` logic stays as-is for the auto-creation path, but relies on the `isValidClaudeSessionId` check in the existing code. Wait, let me re-read lines 42-45:

```typescript
const sessionRef = explicitSessionRef
  ?? (resumeSessionId && mode !== 'shell'
    ? { provider: mode, sessionId: resumeSessionId }
    : undefined)
```

This would create `sessionRef: { provider: 'claude', sessionId: '137 tour' }`. With our relaxed `isValidSessionRef`, this would be accepted as a valid ref. That's OK for the local display path, but might cause issues if it's sent to the server or other devices.

Looking at where `sessionRef` is consumed:
- `layoutMirrorMiddleware.ts`: Sent to server via `ui.layout.sync`
- `session-utils.ts`: Used for session matching / tab finding
- `sidebarSelectors.ts`: Used for session ref collection

For `ui.layout.sync`, the server uses it to track which sessions are open on which tabs. A non-UUID ref won't match any known session, so it's just ignored. That's fine.

OK, let me simplify the panesSlice change. Just remove the Claude-specific UUID validation for `resumeSessionId`:

```typescript
const resumeSessionId = inputResumeSessionId
```

And keep the sessionRef auto-creation as-is (it will create a ref with the non-UUID name, which is handled gracefully by the rest of the system).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/unit/client/store/selectors/sidebarSelectors.test.ts`
Expected: PASS — the new test passes, and existing tests still pass.

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar
git add src/lib/session-utils.ts src/store/selectors/sidebarSelectors.ts src/store/layoutMirrorMiddleware.ts src/store/panesSlice.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
git commit -m "fix: allow non-UUID Claude resume names in sidebar fallback path

Remove isValidClaudeSessionId gates from client-side display paths so
that a tab with --resume '<name>' shows a fallback sidebar item while
waiting for the association coordinator to discover the real UUID."
```

---

### Task 4: Update existing tests that assert old behavior

Several existing tests assert that non-UUID Claude resume names are rejected. These need to be updated to match the new behavior.

**Files:**
- Modify: `test/unit/server/terminal-registry.test.ts` (Windows-specific --resume tests)
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts` (hasTab test for invalid IDs)
- Modify: `test/server/ws-terminal-create-session-repair.test.ts` (if it has tests for invalid resume IDs)
- Test: `test/unit/client/lib/claude-session-id.test.ts` (verify UUID validation still works)

- [ ] **Step 1: Identify all tests that assert non-UUID Claude resume names are rejected**

Search for test assertions that check `--resume` is omitted for `'not-a-uuid'` or similar, and for tests that check non-UUID Claude session IDs are excluded from sidebar items.

The Windows tests in `terminal-registry.test.ts`:
- `'omits --resume in cmd.exe string when invalid'` (line 1581)
- `'omits --resume in PowerShell command when invalid'` (line 1587)
- `'omits --resume in WSL args when invalid'` (line 1593)

The sidebar test in `sidebarSelectors.test.ts`:
- `'keeps hasTab correct for layout-backed and no-layout fallback sessions'` (line 93) — this test asserts that `hasTab` is `false` for a Claude session with `invalidClaudeSessionId`. With our fix, `hasTab` should be `true` since the non-UUID resume name now creates a valid fallback item.

- [ ] **Step 2: Update the Windows `buildSpawnSpec` tests**

Change the three Windows tests to assert `--resume` IS present:

```typescript
it('passes --resume in cmd.exe string with human-readable name', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const spec = buildSpawnSpec('claude', 'C:\\tmp', 'cmd', 'not-a-uuid')
  expect(spec.args.join(' ')).toContain('--resume')
  expect(spec.args.join(' ')).toContain('not-a-uuid')
})

it('passes --resume in PowerShell command with human-readable name', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const spec = buildSpawnSpec('claude', 'C:\\tmp', 'powershell', 'not-a-uuid')
  expect(spec.args.join(' ')).toContain('--resume')
  expect(spec.args.join(' ')).toContain('not-a-uuid')
})

it('passes --resume in WSL args with human-readable name', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const spec = buildSpawnSpec('claude', 'C:\\tmp', 'wsl', 'not-a-uuid')
  expect(spec.args).toContain('--resume')
  expect(spec.args).toContain('not-a-uuid')
})
```

- [ ] **Step 3: Update the sidebar `hasTab` test**

In `sidebarSelectors.test.ts`, the test at line 93 (`'keeps hasTab correct for layout-backed and no-layout fallback sessions'`) currently expects:
```typescript
expect(hasTabBySessionId.get(invalidClaudeSessionId)).toBe(false)
```

With our fix, this should now be `true` because the non-UUID Claude resume name creates a valid fallback item:
```typescript
expect(hasTabBySessionId.get(invalidClaudeSessionId)).toBe(true)
```

BUT WAIT — look at how the test is constructed. The `invalidClaudeSessionId` (`'not-a-uuid'`) is used as BOTH a project session ID and a pane's resume ID. The project session already has this ID, so it shows up in the items list. The `hasTab` question is whether the pane fallback path also marks it. Let me re-read...

Looking at lines 93-175: the project has `invalidClaudeSessionId` as a session. The pane `'tab-invalid'` has `resumeSessionId: invalidClaudeSessionId`. The test checks whether the project-provided item gets `hasTab: true` based on the tab/pane fallback.

The `tabSessionMap` is built from `collectSessionRefsFromTabs(tabs, panes)`. Currently `collectSessionRefsFromNode` (via `extractSessionLocators`) rejects non-UUID Claude refs. With our fix, it will accept them, so `tabSessionMap` will have the key, and `hasTab` will be `true`.

Update the assertion:
```typescript
expect(hasTabBySessionId.get(invalidClaudeSessionId)).toBe(true)
```

- [ ] **Step 4: Run all tests to verify**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/lib/claude-session-id.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar
git add test/unit/server/terminal-registry.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
git commit -m "test: update assertions to match named resume pass-through behavior"
```

---

### Task 5: Edge case tests and session-utils unit tests

Add targeted tests for edge cases: empty string, strings with special characters, partial UUIDs.

**Files:**
- Test: `test/unit/server/terminal-registry.test.ts`
- Test: `test/unit/client/lib/session-utils.test.ts` (if exists, otherwise check `test/unit/client/lib/`)

- [ ] **Step 1: Write edge case tests for server-side normalization**

Add a describe block for `normalizeResumeForSpawn` and `normalizeResumeForBinding` in `test/unit/server/terminal-registry.test.ts`. These functions are not exported, so test them indirectly through `buildSpawnSpec` and `create`:

```typescript
describe('buildSpawnSpec with various Claude resume names', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CMD
  })

  it('passes --resume with name containing spaces', () => {
    const spec = buildSpawnSpec('claude', '/home/user', 'system', '137 tour')
    expect(spec.args).toContain('--resume')
    expect(spec.args).toContain('137 tour')
  })

  it('passes --resume with name containing special characters', () => {
    const spec = buildSpawnSpec('claude', '/home/user', 'system', "fix: can't parse")
    expect(spec.args).toContain('--resume')
    expect(spec.args).toContain("fix: can't parse")
  })

  it('does not pass --resume with empty string', () => {
    const spec = buildSpawnSpec('claude', '/home/user', 'system', '')
    expect(spec.args).not.toContain('--resume')
  })

  it('passes --resume with a partial UUID that is not a valid UUID', () => {
    const spec = buildSpawnSpec('claude', '/home/user', 'system', '550e8400-e29b')
    expect(spec.args).toContain('--resume')
    expect(spec.args).toContain('550e8400-e29b')
  })

  it('passes --resume with a valid UUID', () => {
    const spec = buildSpawnSpec('claude', '/home/user', 'system', VALID_CLAUDE_SESSION_ID)
    expect(spec.args).toContain('--resume')
    expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
  })

  it('always passes non-UUID resume names through for non-Claude modes', () => {
    const spec = buildSpawnSpec('codex', '/home/user', 'system', 'my-codex-session')
    expect(spec.args).toContain('resume')
    expect(spec.args).toContain('my-codex-session')
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts -t "buildSpawnSpec with various Claude resume names"`
Expected: All PASS (these test the behavior we implemented in Task 1)

- [ ] **Step 3: Write edge case test for client-side session ref validation**

Check if `test/unit/client/lib/session-utils.test.ts` exists. If not, add to the appropriate existing test file. Test that `isValidSessionRef` (via `collectSessionRefsFromNode`) now accepts non-UUID Claude refs:

Add to `test/unit/client/store/selectors/sidebarSelectors.test.ts`:

```typescript
it('creates fallback item for Claude session with special character resume name', () => {
  const tabs = [
    { id: 'tab-special', title: 'Special Name Session', mode: 'claude', createdAt: 3_000 },
  ] as any

  const panes = {
    layouts: {
      'tab-special': {
        type: 'leaf',
        id: 'pane-special',
        content: {
          kind: 'terminal',
          mode: 'claude',
          status: 'running',
          createRequestId: 'req-special',
          resumeSessionId: "fix: can't parse (issue #42)",
        },
      },
    },
    activePane: {},
    paneTitles: {},
  } as any

  const items = buildSessionItems([], tabs, panes, emptyTerminals, emptyActivity)

  expect(items).toHaveLength(1)
  expect(items[0].sessionId).toBe("fix: can't parse (issue #42)")
  expect(items[0].hasTab).toBe(true)
})
```

- [ ] **Step 4: Run all client-side tests**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/unit/client/store/selectors/sidebarSelectors.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar
git add test/unit/server/terminal-registry.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
git commit -m "test: add edge case coverage for named resume session IDs"
```

---

### Task 6: E2E test for named resume sidebar visibility

Add an end-to-end test that verifies a tab with a non-UUID Claude resume name appears in the sidebar.

**Files:**
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

- [ ] **Step 1: Write the E2E test**

Add to `test/e2e/open-tab-session-sidebar-visibility.test.tsx`:

```typescript
it('shows a fallback sidebar item for a Claude tab with a human-readable resume name', async () => {
  const namedResumeName = '137 tour'
  fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
    projects: [],
    totalSessions: 0,
    oldestIncludedTimestamp: 0,
    oldestIncludedSessionId: '',
    hasMore: false,
  })

  const store = createStore({
    tabs: [{
      id: 'tab-named',
      title: '137 tour',
      mode: 'claude',
      resumeSessionId: namedResumeName,
      createdAt: Date.now(),
    }],
    panes: {
      layouts: {
        'tab-named': {
          type: 'leaf',
          id: 'pane-named',
          content: {
            kind: 'terminal',
            mode: 'claude',
            createRequestId: 'req-named',
            status: 'running',
            resumeSessionId: namedResumeName,
          },
        },
      },
      activePane: {
        'tab-named': 'pane-named',
      },
      paneTitles: {
        'tab-named': {
          'pane-named': '137 tour',
        },
      },
    },
  })

  render(
    <Provider store={store}>
      <App />
    </Provider>,
  )

  await waitFor(() => {
    // The session should appear in the sidebar as a fallback item
    expect(screen.getAllByText('137 tour').length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails (before client-side fixes) or passes (after)**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/e2e/open-tab-session-sidebar-visibility.test.tsx -t "shows a fallback sidebar item for a Claude tab with a human-readable resume name"`
Expected: PASS (if Task 3 is implemented)

- [ ] **Step 3: Run all E2E tests**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run test/e2e/open-tab-session-sidebar-visibility.test.tsx`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar
git add test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "test: add e2e test for named resume session sidebar visibility"
```

---

### Task 7: Full test suite verification and cleanup

Run the complete test suite to catch any regressions.

- [ ] **Step 1: Run the full test suite**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run test:vitest -- --run`
Expected: All PASS

- [ ] **Step 2: Run typecheck**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run linter**

Run: `cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar && npm run lint`
Expected: No lint errors

- [ ] **Step 4: Clean up any unused imports**

Check if removing `isValidClaudeSessionId` imports left any unused:
- `src/store/selectors/sidebarSelectors.ts`: If `isValidClaudeSessionId` was only used in the removed lines, remove the import
- `src/store/layoutMirrorMiddleware.ts`: If the import is now unused, remove it
- `src/store/panesSlice.ts`: The import may still be used for `sessionRef` construction and agent-chat — check

- [ ] **Step 5: Final commit if cleanup was needed**

```bash
cd /home/user/code/freshell/.worktrees/fix-named-resume-sidebar
git add -A
git commit -m "refactor: remove unused imports after named resume fix"
```

---

## Summary of Changes

### Server (core fix)
- `server/terminal-registry.ts`: Split `normalizeResumeSessionId` into `normalizeResumeForSpawn` (pass-through for any non-empty string) and `normalizeResumeForBinding` (UUID-only for Claude session authority). Add `pendingResumeName` field to `TerminalRecord`.
- `server/ws-handler.ts`: Remove the redundant early `isValidClaudeSessionId` check that discarded non-UUID resume names.

### Client (defense in depth)
- `src/lib/session-utils.ts`: Remove Claude UUID gate from `isValidSessionRef` so non-UUID resume names are valid session refs.
- `src/store/selectors/sidebarSelectors.ts`: Remove `isValidClaudeSessionId` checks in fallback item generation paths.
- `src/store/layoutMirrorMiddleware.ts`: Remove `isValidClaudeSessionId` check in `buildTabFallbackSessionRef`.
- `src/store/panesSlice.ts`: Remove Claude-specific UUID validation for `resumeSessionId` storage on terminal panes.

### Tests
- Updated existing tests that asserted non-UUID Claude resume names are rejected
- New server unit tests for named resume pass-through in `buildSpawnSpec`
- New integration test for named-resume -> UUID association coordinator flow
- New client unit tests for sidebar fallback items with non-UUID Claude names
- New E2E test for named resume sidebar visibility
- Edge case tests for empty strings, special characters, partial UUIDs

### What doesn't change
- `bindSession()` still requires valid UUIDs for Claude (session authority uses canonical IDs)
- `SessionAssociationCoordinator` works unchanged (it already handles unassociated terminals)
- `isValidClaudeSessionId()` function itself is unchanged (UUID validation is still correct)
- Session indexer, session scanner, and JSONL parsing are unchanged
- The `getResumeArgs` and `getStreamArgs` in `coding-cli/providers/claude.ts` are unchanged (they're for the programmatic API path, not the interactive terminal path)
