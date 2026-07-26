# Non-throwing `fetchSessionWindow` (eliminate the session-window unhandled-rejection class) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `fetchSessionWindow` resolve a result object instead of rejecting on API failure, so that *no* fire-and-forget caller — current or future — can leak an unhandled promise rejection that fails `npm test`.

**Architecture:** `fetchSessionWindow` keeps its internal request logic exactly as-is (it still records the error in Redux via `setSessionWindowError` and `throw`s *internally* on the promise stored for in-flight coalescing), but the promise it *returns* is mapped to a `FetchSessionWindowResult` (`{ ok, unauthorized }`) that never rejects. The one consumer that depended on the throw — `App.tsx`'s sidebar-load 401 auth-teardown — is rewired to inspect the result. The per-site `.catch()` band-aids that the de-flake branch added to `queueActiveSessionWindowRefresh` then become dead code and are removed.

**Tech Stack:** TypeScript (NodeNext/ESM — these files use the `@/` alias, so no `.js` suffix needed), React 18, Redux Toolkit thunks, Vitest + Testing Library. Run focused tests with `npm run test:vitest -- run <file>` (passthrough, no coordinator gate).

---

## Current state & where this lands (read first)

This is the **root fix** for the same unhandled-rejection class the de-flake branch already patched at two sites. Current reality (verified against `HEAD`):

- The branch `fix/terminal-directory-refresh-unhandled-rejection` is at commit `bdb36774` ("fix: de-flake CI test suite (5 root causes)") and is open as **PR #382** against `origin/main`, **unmerged and not yet independently reviewed/approved**.
- `bdb36774` already contains symptom-patches: `void appStore.dispatch(queueActiveSessionWindowRefresh() as any).catch(...)` at `src/App.tsx:850` (the `sessions.changed` handler — "Fix #5") and `src/App.tsx:928` (the `terminal.inventory` handler). These `.catch()` guards exist **only on this branch**, not on `origin/main`.
- The remaining *uncontained* fire-and-forget callers of the throwing `fetchSessionWindow` are pre-existing and untouched: `src/components/Sidebar.tsx:279` (clear-search), `:289` (debounced search), `:479` (refresh), and `src/components/HistoryView.tsx:55` (history initial-load effect). These are fixed *transitively* by this plan — no per-site edits — because the thunk's returned promise will no longer reject.

**Landing decision (primary): fold this root fix into PR #382, replacing the Fix #5 band-aid.** Rationale: PR #382 is unmerged and unreviewed, the repo philosophy is "fix the system over the symptom" / "clean architecture over small patches," and shipping the band-aid in #382 and then deleting it in a second PR would leave dead code and two PRs touching the same lines. Task 4 folds Tasks 1–3 into `bdb36774` (squash + force-push the feature branch), updates the PR body, and re-runs the independent review.

**Alternative landing (only if the user wants #382 frozen):** ship Tasks 1–3 as a *separate stacked PR* with `--base fix/terminal-directory-refresh-unhandled-rejection`; the band-aid-removal (Task 3) then lives in the stacked PR and `origin/main` only sees it once both merge. Decide before Task 4 Step 6.

**Out of scope (deliberate):**
- `fetchTerminalDirectoryWindow` (in `src/store/terminalDirectoryThunks.ts`) still re-throws. Its fire-and-forget callers (`App.tsx` inventory + `BackgroundSessions.tsx`) are already `.catch()`-guarded and the prior review accepted them. The `terminal.inventory` directory `.catch()` (App.tsx:924-927) and the terminal-invalidation handler's `onRefreshError` containment **stay**. Leaving this thunk throwing keeps the change scoped to the `fetchSessionWindow` class; a follow-up can give it the same treatment for full symmetry.
- Flakes #2/#3/#4 (already fixed on this branch) are untouched.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/store/sessionsThunks.ts` | Session-window thunks | Add `FetchSessionWindowResult` type; map `fetchSessionWindow`'s returned promise to a non-rejecting result; propagate it through `loadInitialSessionsWindow`; import `isApiUnauthorizedError`. |
| `src/App.tsx` | Bootstrap / WS message handling | Extract `performAuthFailureTeardown`; rewire `ensureSidebarSessionsWindow` to inspect the result; import the result type; drop the now-dead `queueActiveSessionWindowRefresh` `.catch()` guards. |
| `test/unit/client/store/sessionsThunks.test.ts` | Thunk contract tests | Update the one reject-asserting test; add a 401 contract test. |
| `test/unit/client/components/App.ws-bootstrap.test.tsx` | App integration tests | Add a 401-sidebar-load auth-teardown regression test. (The existing Fix #5 no-leak test stays and keeps passing.) |

---

## Task 1: Non-throwing `fetchSessionWindow` contract

**Files:**
- Modify: `src/store/sessionsThunks.ts`
- Test: `test/unit/client/store/sessionsThunks.test.ts:420`

- [ ] **Step 1: Update the existing reject-asserting test to the new contract (RED)**

In `test/unit/client/store/sessionsThunks.test.ts`, in the test `it('preserves the previous applied search context when a replacement request errors before new data lands', ...)` (starts line 420), replace the dispatch+reject block (currently lines 450-455):

```typescript
    await expect(store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'beta',
      searchTier: 'fullText',
    }) as any)).rejects.toThrow('Search failed')
```

with:

```typescript
    const result = await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'beta',
      searchTier: 'fullText',
    }) as any)

    expect(result).toEqual({ ok: false, unauthorized: false })
```

Leave the five `store.getState().sessions.windows.sidebar` assertions that follow (query/searchTier/appliedQuery/appliedSearchTier/error, lines 457-461) unchanged.

- [ ] **Step 2: Add a 401 contract test (RED)**

In the same file, add this test immediately after the test edited in Step 1 (after its closing `})` at line 462):

```typescript
  it('resolves an unauthorized result without rejecting when the snapshot fetch returns 401', async () => {
    fetchSidebarSessionsSnapshot.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    const result = await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(result).toEqual({ ok: false, unauthorized: true })
    expect((store.getState().sessions.windows.sidebar as any).error).toBe('Unauthorized')
  })
```

- [ ] **Step 3: Run the two tests to verify they fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts -t "applied search context when a replacement request errors"
npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts -t "resolves an unauthorized result"
```
Expected: BOTH FAIL. The current `fetchSessionWindow` rejects, so `await store.dispatch(...)` throws — the first reports the thrown `Error: Search failed` instead of returning a result; the second reports the thrown `Error: Unauthorized`.

- [ ] **Step 4: Import `isApiUnauthorizedError` and add the result type**

In `src/store/sessionsThunks.ts`, change the `@/lib/api` import (lines 1-6):

```typescript
import {
  fetchSidebarSessionsSnapshot,
  searchSessions,
  type SearchOptions,
  type SearchResult,
} from '@/lib/api'
```

to:

```typescript
import {
  fetchSidebarSessionsSnapshot,
  isApiUnauthorizedError,
  searchSessions,
  type SearchOptions,
  type SearchResult,
} from '@/lib/api'
```

Then add the result type immediately after the `FetchSessionWindowArgs` type definition (after its closing `}` at line 29):

```typescript
export type FetchSessionWindowResult = {
  /** True when the window load committed (or the fetch was aborted/superseded); false on a real API failure. */
  ok: boolean
  /** True only when the failure was an authentication (HTTP 401) error. */
  unauthorized: boolean
}
```

- [ ] **Step 5: Map the returned promise to a non-rejecting result**

In `fetchSessionWindow` (starts line 446), leave the entire inner request body unchanged (it still dispatches `setSessionWindowError` and `throw error` internally). Make exactly three edits:

(a) Add the return-type annotation. Change line 447:

```typescript
  return async (dispatch: AppDispatch, getState: () => RootState) => {
```

to:

```typescript
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<FetchSessionWindowResult> => {
```

(b) Rename the `requestPromise` variable to `settled`. Change lines 476-477:

```typescript
    let requestPromise!: Promise<void>
    requestPromise = (async () => {
```

to:

```typescript
    let settled!: Promise<void>
    settled = (async () => {
```

and inside that IIFE's `finally` block, change the self-reference (lines 587-589):

```typescript
        if (inFlightRequests.get(surface) === requestPromise) {
          inFlightRequests.delete(surface)
        }
```

to:

```typescript
        if (inFlightRequests.get(surface) === settled) {
          inFlightRequests.delete(surface)
        }
```

(c) Replace the trailer (the last two lines of the thunk body, lines 593-594):

```typescript
    inFlightRequests.set(surface, requestPromise)
    return requestPromise
```

with:

```typescript
    inFlightRequests.set(surface, settled)
    // The returned promise never rejects: success/abort -> ok:true, real failure ->
    // ok:false. `settled` (the void promise stored for in-flight coalescing) still
    // rejects internally — queueActiveSessionWindowRefresh awaits it only inside
    // try/catch — but the .then below attaches a rejection handler to the *returned*
    // promise, so a fire-and-forget caller can never leak an unhandled rejection.
    return settled.then(
      (): FetchSessionWindowResult => ({ ok: true, unauthorized: false }),
      (error: unknown): FetchSessionWindowResult => ({
        ok: false,
        unauthorized: isApiUnauthorizedError(error),
      }),
    )
```

> Note: `inFlightRequests` is typed `Map<SessionSurface, Promise<void>>` and still stores `settled` (a `Promise<void>`), so its type is unchanged. The two existing `await activeRequest` sites in `queueActiveSessionWindowRefresh` (lines ~655 and ~694) are already wrapped in `try/catch {}`, so the still-rejecting `settled` is safe there.

- [ ] **Step 6: Run the two tests to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts -t "applied search context when a replacement request errors"
npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts -t "resolves an unauthorized result"
```
Expected: BOTH PASS.

- [ ] **Step 7: Run the whole thunk test file (no regressions)**

Run: `npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts`
Expected: all tests PASS.

- [ ] **Step 8: Propagate the result through `loadInitialSessionsWindow`**

In `src/store/sessionsThunks.ts`, change `loadInitialSessionsWindow` (lines 723-731):

```typescript
export function loadInitialSessionsWindow() {
  return async (dispatch: AppDispatch) => {
    dispatch(activateSessionSurface('sidebar'))
    await dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
  }
}
```

to:

```typescript
export function loadInitialSessionsWindow() {
  return async (dispatch: AppDispatch): Promise<FetchSessionWindowResult> => {
    dispatch(activateSessionSurface('sidebar'))
    return dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any) as Promise<FetchSessionWindowResult>
  }
}
```

> Leave `loadHistorySessionsWindow` (lines 733+) unchanged — it awaits and ignores the result; HistoryView's `refresh()` awaits it the same way. No behavior depends on its rejecting.

- [ ] **Step 9: Typecheck and the sidebar-staleness suite (callers that ignore the result still compile/pass)**

Run: `npm run typecheck:client`
Expected: no errors.
Run: `npm run test:vitest -- run test/unit/client/store/sidebar-staleness.test.ts`
Expected: all PASS (these `await` the thunks and ignore the return value).

- [ ] **Step 10: Commit**

```bash
git add src/store/sessionsThunks.ts test/unit/client/store/sessionsThunks.test.ts
git commit -m "refactor(sessions): make fetchSessionWindow resolve a result instead of throwing

fetchSessionWindow now returns { ok, unauthorized } and never rejects on
API failure (it still records the error in Redux). This removes the
unhandled-rejection hazard for every fire-and-forget caller at the source.
loadInitialSessionsWindow propagates the result.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> NOTE: after this commit the App sidebar-load 401 auth-teardown is temporarily inert (it relied on the now-removed throw). No existing test covers that path, so the suite stays green; Task 2 restores it and adds the missing coverage.

---

## Task 2: Preserve the sidebar-load auth teardown via the result

**Files:**
- Modify: `src/App.tsx`
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx`

- [ ] **Step 1: Write the auth-teardown regression test (RED)**

In `test/unit/client/components/App.ws-bootstrap.test.tsx`, inside the `describe('App WS bootstrap recovery', ...)` block (line 256), add this test immediately after the existing test `it('recovers bootstrap-owned provider availability and sidebar filters after transient pre-ready 503s', ...)` (it starts at line 465 and ends just before the `it('repairs missing bootstrap platform capabilities ...')` test at line 596):

```typescript
  it('tears down the session and surfaces an auth failure when the post-ready sidebar window load returns 401', async () => {
    const store = createStore()
    // Bootstrap auth succeeds (beforeEach default), but the follow-up sidebar
    // snapshot is unauthorized -> ensureSidebarSessionsWindow must perform the
    // auth teardown even though fetchSessionWindow no longer throws.
    fetchSidebarSessionsSnapshot.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))
    wsMocks.connect.mockResolvedValueOnce(undefined)

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).toBeTypeOf('function')
    })

    act(() => {
      messageHandler?.({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-401',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.lastError).toBe('Authentication failed')
      expect(store.getState().connection.status).toBe('disconnected')
    })
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx -t "post-ready sidebar window load returns 401"`
Expected: FAIL — after Task 1, `ensureSidebarSessionsWindow`'s `catch` no longer fires (the throw is gone), so `connection.lastError` is not `'Authentication failed'` and `waitFor` times out.

- [ ] **Step 3: Extract `performAuthFailureTeardown` in App.tsx**

In `src/App.tsx`, change the `handleBootstrapAuthFailure` definition (lines 488-501):

```typescript
      const handleBootstrapAuthFailure = (err: unknown): boolean => {
        if (!isApiUnauthorizedError(err)) return false
        if (!cancelled) {
          resetCodexActivityOverlay()
          resetClaudeActivityOverlay()
          dispatch(setStatus('disconnected'))
          dispatch(setError('Authentication failed'))
        }
        // Tear down WS subscriptions that were registered before the HTTP
        // fetches (cleanup + stopTabRegistrySync are already assigned by now).
        cleanup?.()
        stopTabRegistrySync?.()
        return true
      }
```

to:

```typescript
      const performAuthFailureTeardown = () => {
        if (!cancelled) {
          resetCodexActivityOverlay()
          resetClaudeActivityOverlay()
          dispatch(setStatus('disconnected'))
          dispatch(setError('Authentication failed'))
        }
        // Tear down WS subscriptions that were registered before the HTTP
        // fetches (cleanup + stopTabRegistrySync are already assigned by now).
        cleanup?.()
        stopTabRegistrySync?.()
      }

      const handleBootstrapAuthFailure = (err: unknown): boolean => {
        if (!isApiUnauthorizedError(err)) return false
        performAuthFailureTeardown()
        return true
      }
```

- [ ] **Step 4: Rewire `ensureSidebarSessionsWindow` to inspect the result**

In `src/App.tsx`, change the `try`/`catch`/`finally` body of `ensureSidebarSessionsWindow` (lines 740-758):

```typescript
        sidebarWindowLoading = true
        try {
          const activeSurface = appStore.getState().sessions.activeSurface
          if (activeSurface && activeSurface !== 'sidebar') {
            await dispatch(fetchSessionWindow({
              surface: 'sidebar',
              priority: 'visible',
            }) as any)
          } else {
            await dispatch(loadInitialSessionsWindow() as any)
          }
          return true
        } catch (err: unknown) {
          if (handleBootstrapAuthFailure(err)) return false
          log.warn('Failed to load initial sidebar session window', err)
          return true
        } finally {
          sidebarWindowLoading = false
        }
```

to:

```typescript
        sidebarWindowLoading = true
        try {
          const activeSurface = appStore.getState().sessions.activeSurface
          const result = (activeSurface && activeSurface !== 'sidebar'
            ? await dispatch(fetchSessionWindow({
                surface: 'sidebar',
                priority: 'visible',
              }) as any)
            : await dispatch(loadInitialSessionsWindow() as any)) as FetchSessionWindowResult | undefined
          if (result?.unauthorized) {
            performAuthFailureTeardown()
            return false
          }
          if (!result?.ok) {
            log.warn('Failed to load initial sidebar session window')
          }
          return true
        } finally {
          sidebarWindowLoading = false
        }
```

- [ ] **Step 5: Import the result type in App.tsx**

In `src/App.tsx`, change the `@/store/sessionsThunks` import (lines 12-16):

```typescript
import {
  fetchSessionWindow,
  loadInitialSessionsWindow,
  queueActiveSessionWindowRefresh,
} from '@/store/sessionsThunks'
```

to:

```typescript
import {
  fetchSessionWindow,
  loadInitialSessionsWindow,
  queueActiveSessionWindowRefresh,
  type FetchSessionWindowResult,
} from '@/store/sessionsThunks'
```

- [ ] **Step 6: Run the regression test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx -t "post-ready sidebar window load returns 401"`
Expected: PASS.

- [ ] **Step 7: Run the full App ws-bootstrap file (no regressions — incl. the 503 recovery + Fix #5 no-leak tests)**

Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx`
Expected: all PASS. In particular `recovers bootstrap-owned provider availability and sidebar filters after transient pre-ready 503s` (line 465 — a 503 is `unauthorized:false` -> `log.warn` + continue, same as before) and `contains a failing queued session-window refresh from a sessions.changed broadcast instead of leaking an unhandled rejection` (line 1559) both still pass.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck:client`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "fix(app): preserve sidebar-load 401 auth teardown without a throw

ensureSidebarSessionsWindow now reads the FetchSessionWindowResult instead
of catching a thrown error; performAuthFailureTeardown is extracted so both
the direct-fetch (401) bootstrap paths and the sidebar-window path share it.
Adds the previously-missing regression test for the 401 sidebar-load path.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Remove the now-dead `queueActiveSessionWindowRefresh` catches

**Files:**
- Modify: `src/App.tsx`

> `queueActiveSessionWindowRefresh` can no longer reject: its run loop `await`s the now-non-throwing `fetchSessionWindow` (and `refreshVisibleSessionWindowSilently` already swallows). The two inline `.catch()` guards on it are dead; remove them so the code is honest. KEEP the `fetchTerminalDirectoryWindow` guard — that thunk still throws.

- [ ] **Step 1: Simplify the `sessions.changed` dispatch**

In `src/App.tsx`, inside the `if (msg.type === 'sessions.changed')` handler, change (lines 848-850):

```typescript
            // Fire-and-forget refresh: the thunk re-throws on failure, so contain the
            // rejection rather than leak an unhandled rejection (matches the inventory site).
            void appStore.dispatch(queueActiveSessionWindowRefresh() as any).catch((error: unknown) => log.debug('active session window refresh failed', error))
```

to:

```typescript
            // Fire-and-forget refresh. queueActiveSessionWindowRefresh resolves even on
            // failure (fetchSessionWindow records the error in Redux), so it cannot leak.
            void appStore.dispatch(queueActiveSessionWindowRefresh() as any)
```

- [ ] **Step 2: Simplify the `terminal.inventory` queue dispatch (keep the directory guard)**

In `src/App.tsx`, inside the `if (msg.type === 'terminal.inventory')` handler, change (lines 922-928):

```typescript
          // Fire-and-forget refreshes: the thunks re-throw on failure, so
          // contain the rejection rather than leak an unhandled rejection.
          void appStore.dispatch(fetchTerminalDirectoryWindow({
            surface: 'sidebar',
            priority: 'visible',
          }) as any).catch((error: unknown) => log.debug('terminal directory background refresh failed', error))
          void appStore.dispatch(queueActiveSessionWindowRefresh() as any).catch((error: unknown) => log.debug('active session window refresh failed', error))
```

to:

```typescript
          // fetchTerminalDirectoryWindow still re-throws on failure, so contain its
          // rejection. queueActiveSessionWindowRefresh resolves even on failure.
          void appStore.dispatch(fetchTerminalDirectoryWindow({
            surface: 'sidebar',
            priority: 'visible',
          }) as any).catch((error: unknown) => log.debug('terminal directory background refresh failed', error))
          void appStore.dispatch(queueActiveSessionWindowRefresh() as any)
```

- [ ] **Step 3: Verify the no-leak guarantee still holds and nothing regressed**

Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx`
Expected: all PASS — crucially `contains a failing queued session-window refresh from a sessions.changed broadcast instead of leaking an unhandled rejection` (line 1559) still passes (now proving the *root* fix contains the leak, with no inline catch present).

- [ ] **Step 4: Typecheck (catches any now-unused import — `log` is still used elsewhere, so it stays)**

Run: `npm run typecheck:client`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "refactor(app): drop redundant queueActiveSessionWindowRefresh catches

With fetchSessionWindow non-throwing, queueActiveSessionWindowRefresh can no
longer reject, so the inline .catch guards on it are dead. The root fix now
provides the containment. fetchTerminalDirectoryWindow's guard is kept.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification, fold into PR #382, and re-review

**Files:** none (verification + history + review). **Requires the user's landing decision** (see "Current state & where this lands" — primary = fold into #382).

- [ ] **Step 1: Typecheck (client + server)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint the changed source files (expect 0 new errors/warnings)**

Run: `npx eslint src/store/sessionsThunks.ts src/App.tsx`
Expected: 0 errors, 0 warnings from these files.

- [ ] **Step 3: Robustness loop on the two touched test files (de-flake PR — new tests must be deterministic)**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/deflake-terminal-refresh
pass=0; fail=0
for i in $(seq 1 20); do
  if npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx >/tmp/optb-loop-$i.log 2>&1; then
    pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL run $i"; tail -25 /tmp/optb-loop-$i.log; fi
done
echo "PASS=$pass FAIL=$fail (of 20)"
```
Expected: `PASS=20 FAIL=0`.

- [ ] **Step 4: Full default-config unit suite**

Run: `FRESHELL_TEST_SUMMARY="Option B: fetchSessionWindow non-throwing" npm run test:unit`
Expected: all files/tests PASS (baseline before this work was 305 files / 3526 tests; this adds 2 tests → 3528).

- [ ] **Step 5: Run the e2e tests that touch these thunks**

Run: `npm run test:vitest -- run test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx`
Expected: all PASS (success behavior of the thunks is unchanged).

- [ ] **Step 6: Fold Tasks 1–3 into the de-flake commit `bdb36774` and rewrite its message**

The de-flake work is one logical unit. `bdb36774` is the only commit on the branch beyond `origin/main` (verify: `git diff --stat origin/main...HEAD` showed exactly 7 files before this work). Fold `bdb36774` + the three new commits into one and rewrite the message so root cause #5 describes the *root* fix rather than the per-site catch:

First write `/tmp/deflake-commit-msg-v2.txt`. Keep root causes #1–#4 exactly as in `bdb36774`'s current message (`git show -s --format=%B bdb36774`), and replace the #5 paragraph with:

```
5. session-window background-refresh unhandled rejections (production bug).
   fetchSessionWindow re-threw on API failure, so every fire-and-forget caller
   (App.tsx sessions.changed, the Sidebar search/clear/refresh sites, and the
   HistoryView initial-load effect) could leak an unhandled rejection that fails
   `npm test`. Root fix: fetchSessionWindow now resolves a { ok, unauthorized }
   result and never rejects (it still records the error in Redux); the sole
   consumer of the throw (the sidebar-load 401 auth teardown) reads the result
   via performAuthFailureTeardown. The previously-added per-site .catch guards on
   queueActiveSessionWindowRefresh are now dead and removed. Covered by thunk-
   contract tests + an App 401-teardown integration test.
```

Then fold + rewrite:
```bash
git reset --soft bdb36774~1   # == origin/main; un-commits bdb36774 + Tasks 1-3, keeps the tree
git add -A
git commit -F /tmp/deflake-commit-msg-v2.txt
```

Confirm the final diff still contains Fixes #2/#3/#4 and the `fetchTerminalDirectoryWindow` containment (handler `onRefreshError` + App inventory `.catch`), and that the message matches:
```bash
git diff --stat origin/main...HEAD
git show -s --format=%B HEAD
```

- [ ] **Step 7: Re-run the independent review (fresheyes) until it PASSES**

Use the `superpowers:fresheyes` skill (`--gpt`, a different model family) scoped to:
`Review the changes between origin/main and this branch using git -C /home/dan/code/freshell/.worktrees/deflake-terminal-refresh diff origin/main...HEAD`
If it raises a new blocking finding, root-cause and fix it TDD-style, then re-review. Do not force-push until the verdict is **PASSED**.

- [ ] **Step 8: Force-push the branch and update PR #382's body (only after PASSED)**

```bash
git push --force-with-lease origin fix/terminal-directory-refresh-unhandled-rejection
```

Update `/tmp/deflake-pr-body.md` so root cause #5 describes the non-throwing root fix (and drop the "Out of scope (follow-up)" paragraph about Sidebar/HistoryView — they are now fixed transitively). Then patch the PR body via the REST API (the GraphQL path `gh pr edit --body-file` fails here with a "Projects (classic) is being deprecated" error):

```bash
gh api repos/danshapiro/freshell/pulls/382 -X PATCH -F body=@/tmp/deflake-pr-body.md
```

Verify: `gh pr view 382 --json mergeable,state` → `MERGEABLE` / `OPEN`. PR #382 still needs independent review/merge — we cannot self-approve.

> **Branch-safety reminder:** This force-pushes the *feature* branch only. Do NOT touch local `main` (no merge/reset/force-push). This does NOT restart the self-hosted dev server (building/committing is fine; deploying needs explicit "APPROVED").

---

## Self-Review

**1. Spec coverage.**
- "fetchSessionWindow no longer rejects on API failure" → Task 1 Steps 4-5 + tests Steps 1-2.
- "loadInitialSessionsWindow propagates the result" → Task 1 Step 8.
- "preserve the sidebar-load 401 auth teardown" → Task 2 Steps 3-4 + regression test Step 1.
- "all fire-and-forget callers (Sidebar:279/289/479, HistoryView:55) stop leaking" → covered transitively by the thunk contract (Task 1); no per-site edits needed. The integration guarantee is proven by the existing Fix #5 `sessions.changed` no-leak test (Task 2 Step 7 / Task 3 Step 3).
- "remove redundant per-site catches" → Task 3.
- "the existing reject-asserting test is updated" → Task 1 Step 1.
- "land it" → Task 4 (fold into #382, primary; stacked-PR alternative noted up front).

**2. Placeholder scan.** No TBD/TODO/"handle errors"; every code step shows full before/after. The only prose-described artifact is the commit-message body in Task 4 Step 6, which is given verbatim — acceptable for a message.

**3. Type consistency.** `FetchSessionWindowResult = { ok: boolean; unauthorized: boolean }` is defined once in `sessionsThunks.ts` (Task 1 Step 4), exported, imported in `App.tsx` (Task 2 Step 5), used as `FetchSessionWindowResult | undefined` in `ensureSidebarSessionsWindow` and as the return type of `loadInitialSessionsWindow`. `performAuthFailureTeardown` is defined in Task 2 Step 3 and called in Task 2 Steps 3-4. `settled` replaces `requestPromise` consistently across Task 1 Step 5 (a/b/c). `isApiUnauthorizedError` is imported in Task 1 Step 4 (confirmed exported at `src/lib/api.ts:71`) and used in Task 1 Step 5(c).

**4. Green-per-commit.** Task 1's commit leaves one *untested* path (sidebar-load 401 teardown) temporarily inert — explicitly noted — and the suite stays green; Task 2 restores it with the RED→GREEN that proves it. All other commits are fully green.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-fetchsessionwindow-non-throwing.md`. **Decide the landing strategy first** (fold into #382 vs. stacked follow-up — see top), then choose execution:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Which approach?
