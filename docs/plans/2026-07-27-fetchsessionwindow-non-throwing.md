# Non-throwing `fetchSessionWindow` (kata xxqj) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make `fetchSessionWindow` resolve a result object instead of rejecting on API failure, so that no fire-and-forget caller — current or future — can leak an unhandled promise rejection that fails `npm test`.

**Architecture:** `fetchSessionWindow` keeps its internal request logic exactly as-is (it still records the error in Redux via `setSessionWindowError` and `throw`s *internally* on the void promise stored for in-flight coalescing), but the promise it *returns* is mapped to a `FetchSessionWindowResult` (`{ ok, unauthorized }`) that never rejects. The one consumer that depended on the throw — `App.tsx`'s sidebar-load 401 auth-teardown in `ensureSidebarSessionsWindow` — is rewired to inspect the result via a newly extracted `performAuthFailureTeardown`. The per-site `.catch()` band-aids on `queueActiveSessionWindowRefresh` in `App.tsx` then become dead code and are removed.

**Tech Stack:** TypeScript (these files use the `@/` alias — no `.js` suffix needed), React 18, Redux Toolkit thunks, Vitest + Testing Library. All test files in this plan are client-side (`test/unit/client/**`), so the default vitest config applies: `npm run test:vitest -- run <file> -t "<name>"`.

## Global Constraints

- Work inside the worktree `/home/dan/code/freshell/.worktrees/fetchsessionwindow-non-throwing` on branch `fix/fetchsessionwindow-non-throwing`. Land as a normal standalone feature branch. Do NOT force-push anything, do NOT modify any existing PR, do NOT run `gh pr create` (needs explicit user approval per AGENTS.md).
- Reference kata xxqj in every commit: put `(xxqj)` at the end of the commit subject line.
- Line numbers below were verified on 2026-07-27 at HEAD `3f096412`, and every quoted snippet was re-verified matching at `9d716374`. Treat them as hints — ALWAYS locate edit targets by the quoted code content, not by line number.
- Out of scope (deliberate — do NOT touch): `fetchTerminalDirectoryWindow` (`src/store/terminalDirectoryThunks.ts`) keeps throwing; its `.catch()` at the App `terminal.inventory` site and the terminal-invalidation handler's `onRefreshError` containment STAY. The internal `try { await activeRequest } catch {}` blocks inside `queueActiveSessionWindowRefresh` (sessionsThunks.ts ~704-712 and ~744-751) STAY — they await the stored *internal* promise, which still rejects by design.
- Test commands: always `npm run test:vitest -- run ...` (coordinator passthrough). Never raw `npx vitest`. Broad runs (`npm run test:unit`) may wait on the coordinator gate; never kill a foreign gate holder.
- `-t` gates: vitest exits 0 when a `-t` filter matches NO tests (all-skipped counts as pass — verified on this worktree's vitest 3.2.4). NEVER judge a `-t` run by exit code alone: a GREEN gate must show the named test(s) as passed in the output (e.g. `1 passed`), and a RED gate must show the named test actually ran and FAILED — `0 passed, N skipped` means the name filter matched nothing (typo/rename), not a verdict.
- TDD RED→GREEN per task. Do not create any new markdown docs besides this plan.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/store/sessionsThunks.ts` | Session-window thunks | Add exported `FetchSessionWindowResult` type; map `fetchSessionWindow`'s returned promise to a non-rejecting result; propagate it through `loadInitialSessionsWindow`; import `isApiUnauthorizedError`. |
| `src/App.tsx` | Bootstrap / WS message handling | Extract `performAuthFailureTeardown`; rewire `ensureSidebarSessionsWindow` to inspect the result; import the result type; drop the two now-dead `queueActiveSessionWindowRefresh` `.catch()` guards. |
| `test/unit/client/store/sessionsThunks.test.ts` | Thunk contract tests | Update the one reject-asserting test; add a 401 result-contract test. |
| `test/unit/client/components/App.ws-bootstrap.test.tsx` | App integration tests | Add a 401 sidebar-load auth-teardown regression test; refresh two stale comments in the existing no-leak test. |

---

## Task 1: Non-throwing `fetchSessionWindow` contract

**Files:**
- Modify: `src/store/sessionsThunks.ts` (thunk at ~456, trailer at ~645, `loadInitialSessionsWindow` at ~775)
- Test: `test/unit/client/store/sessionsThunks.test.ts` (target test at ~420)

**Interfaces:**
- Consumes: `isApiUnauthorizedError(error: unknown): error is ApiError` — exported from `@/lib/api` (currently `src/lib/api.ts:110`; returns true iff `error` is an object with `status === 401`).
- Produces (later tasks rely on these exact names/types):
  - `export type FetchSessionWindowResult = { ok: boolean; unauthorized: boolean }` exported from `@/store/sessionsThunks`.
  - `fetchSessionWindow(args)` — inner thunk now returns `Promise<FetchSessionWindowResult>` and NEVER rejects. Success or abort/supersede → `{ ok: true, unauthorized: false }`; real API failure → `{ ok: false, unauthorized: isApiUnauthorizedError(error) }`. The error is still recorded in Redux (`sessions.windows.<surface>.error`) exactly as before.
  - `loadInitialSessionsWindow()` — inner thunk now returns `Promise<FetchSessionWindowResult>` (propagated from `fetchSessionWindow`).

- [ ] **Step 1: Update the existing reject-asserting test to the new contract (RED)**

In `test/unit/client/store/sessionsThunks.test.ts`, find the test `it('preserves the previous applied search context when a replacement request errors before new data lands', ...)` (currently starts at line 420). Inside it, replace this dispatch+reject block (currently lines 450-455 — this is the ONLY `.rejects` assertion in the file):

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

Leave the five `store.getState().sessions.windows.sidebar` assertions that follow (query/searchTier/appliedQuery/appliedSearchTier/error — currently lines 457-461) unchanged.

- [ ] **Step 2: Add a 401 contract test (RED)**

In the same file, add this test immediately after the closing `})` of the test edited in Step 1 (currently line 462), before the `it('preserves the previous applied search context when a replacement request is aborted before new data lands', ...)` test. Note: this file's `vi.mock('@/lib/api', ...)` uses `importActual`, so the REAL `isApiUnauthorizedError` runs — an `Error` carrying `status: 401` satisfies it. `setActiveSessionSurface` is already imported at the top of the file (from `@/store/sessionsSlice`), and `fetchSidebarSessionsSnapshot` / `createStore` are existing module-scope helpers.

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

In `src/store/sessionsThunks.ts`, change the `@/lib/api` import (currently lines 1-6):

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

Then add the result type immediately after the `FetchSessionWindowArgs` type definition (its closing `}` is currently at line 29; note that `FetchSessionWindowArgs` is a bare non-exported `type` — leave it non-exported):

```typescript
export type FetchSessionWindowResult = {
  /** True when the window load committed (or the fetch was aborted/superseded); false on a real API failure. */
  ok: boolean
  /** True only when the failure was an authentication (HTTP 401) error. */
  unauthorized: boolean
}
```

- [ ] **Step 5: Map the returned promise to a non-rejecting result**

In `fetchSessionWindow` (currently starts at line 456), leave the entire inner request body unchanged — it still dispatches `setSessionWindowError` and `throw error` internally (the file's single `throw`, currently line 634), and its `finally` block still clears both `controllers` and `inFlightRequests`. Make exactly three edits:

(a) Add the return-type annotation. Change the inner-thunk signature (currently line 457):

```typescript
  return async (dispatch: AppDispatch, getState: () => RootState) => {
```

to:

```typescript
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<FetchSessionWindowResult> => {
```

(b) Rename the `requestPromise` variable to `settled` (so the code reads honestly: the stored promise tracks settlement and still rejects; the returned promise is a mapped result). Change the declaration + IIFE assignment (currently lines 486-487):

```typescript
    let requestPromise!: Promise<void>
    requestPromise = (async () => {
```

to:

```typescript
    let settled!: Promise<void>
    settled = (async () => {
```

and inside that IIFE's `finally` block, change the identity check (currently lines 639-641; do NOT touch the adjacent `controllers` cleanup):

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

(c) Replace the trailer (the last two lines of the thunk body, currently lines 645-646):

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
    // try/catch — but the .then below attaches a rejection handler to it, so a
    // fire-and-forget caller can never leak an unhandled rejection.
    return settled.then(
      (): FetchSessionWindowResult => ({ ok: true, unauthorized: false }),
      (error: unknown): FetchSessionWindowResult => ({
        ok: false,
        unauthorized: isApiUnauthorizedError(error),
      }),
    )
```

> Notes: `inFlightRequests` is typed `Map<SessionSurface, Promise<void>>` (currently line 32) and still stores `settled` (a `Promise<void>`), so its type annotation is unchanged. The abort short-circuit (`if (controller.signal.aborted) return`, currently line 623) makes the internal IIFE *resolve* on abort, so aborts map to `ok: true` — this matches the doc comment on the type. The two `try { await activeRequest } catch {}` sites in `queueActiveSessionWindowRefresh` (currently ~707 and ~746) await the still-rejecting `settled` and MUST stay as-is. The uncaught `await dispatch(fetchSessionWindow(...))` inside `queueActiveSessionWindowRefresh` (currently ~716) and inside `refreshActiveSessionWindow` (currently ~657) now receive the never-rejecting mapped promise, so they stop being rejection sources with no edits.

- [ ] **Step 6: Run the two tests to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts -t "applied search context when a replacement request errors"
npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts -t "resolves an unauthorized result"
```
Expected: BOTH PASS.

- [ ] **Step 7: Run the whole thunk test file (no regressions)**

Run: `npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts`
Expected: all tests PASS. (The six `await x.catch(() => {})` swallow sites in the two-phase-search describe become harmless no-ops; `Promise.allSettled` in the abort test stays valid.)

- [ ] **Step 8: Propagate the result through `loadInitialSessionsWindow`**

In `src/store/sessionsThunks.ts`, change `loadInitialSessionsWindow` (currently lines 775-783):

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

> Leave `loadHistorySessionsWindow` (currently lines 785-793, end of file) unchanged — it awaits and ignores the result; HistoryView's `refresh()` awaits it the same way. No behavior depends on it rejecting, and after this task it no longer can.

- [ ] **Step 9: Typecheck and the sidebar-staleness suite (callers that ignore the result still compile/pass)**

Run: `npm run typecheck:client`
Expected: no errors. (Note: every call site casts `as any`, so this catches only internal type errors — the contract is enforced by the tests, not the compiler.)
Run: `npm run test:vitest -- run test/unit/client/store/sidebar-staleness.test.ts`
Expected: all PASS (these `await` the thunks and ignore the return value).
Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx`
Expected: all PASS. This guards the intermediate commit: the no-leak test (`contains a failing queued session-window refresh ...`, ~1944) depends on the failure still committing `windows.sidebar.error` and never committing window data — semantics this task preserves because the internal IIFE is unchanged; this run proves it before committing.

- [ ] **Step 10: Commit**

```bash
git add src/store/sessionsThunks.ts test/unit/client/store/sessionsThunks.test.ts
git commit -m "refactor(sessions): make fetchSessionWindow resolve a result instead of throwing (xxqj)

fetchSessionWindow now returns { ok, unauthorized } and never rejects on
API failure (it still records the error in Redux). This removes the
unhandled-rejection hazard for every fire-and-forget caller at the source
(App.tsx sessions.changed, Sidebar search/clear/append, HistoryView loads).
loadInitialSessionsWindow propagates the result.

Related-To: kata xxqj"
```

> NOTE: after this commit the App sidebar-load 401 auth-teardown is temporarily inert (it relied on the now-removed throw reaching `ensureSidebarSessionsWindow`'s catch). No existing test covers that path (verified: the only 'Authentication failed' coverage is the `/api/bootstrap` 401 test), so the suite stays green; Task 2 restores the behavior and adds the missing coverage.

---

## Task 2: Preserve the sidebar-load auth teardown via the result

**Files:**
- Modify: `src/App.tsx` (`handleBootstrapAuthFailure` at ~509, `ensureSidebarSessionsWindow` at ~772, sessionsThunks import at ~13)
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Interfaces:**
- Consumes (from Task 1): `FetchSessionWindowResult` and the non-rejecting `fetchSessionWindow` / `loadInitialSessionsWindow` contracts, exported from `@/store/sessionsThunks`.
- Produces: `performAuthFailureTeardown(): void` — a closure inside `bootstrap()` in `App.tsx` shared by `handleBootstrapAuthFailure` and `ensureSidebarSessionsWindow`. `ensureSidebarSessionsWindow` keeps its existing `Promise<boolean>` contract (`false` = bootstrap must stop) — it has TWO callers (currently lines 815 and 1397) that both do `if (!(await ensureSidebarSessionsWindow())) return`.

- [ ] **Step 1: Write the auth-teardown regression test (RED)**

In `test/unit/client/components/App.ws-bootstrap.test.tsx`, inside the `describe('App WS bootstrap recovery', ...)` block (currently starts line 265), add this test immediately after the closing `})` of the existing test `it('recovers bootstrap-owned provider availability and sidebar filters after transient pre-ready 503s', ...)` (currently ends at line 606, just before the `it('repairs missing bootstrap platform capabilities ...')` test).

Context you need: this file's `vi.mock('@/lib/api', ...)` is a FULL replacement whose `isApiUnauthorizedError` is `(err) => !!err && typeof err === 'object' && err.status === 401`, so the rejection value MUST carry `status: 401`. The `beforeEach` defaults make `/api/bootstrap` succeed and `fetchSidebarSessionsSnapshot` resolve `[]`; App calls `ensureSidebarSessionsWindow` during initial bootstrap (pre-ready), so overriding the snapshot mock to reject 401 exercises the sidebar-load path directly — no `ready` message needed. `Sidebar` is mocked out, so assert against Redux state only. `createStore`, `render`, `Provider`, `App`, `waitFor` are all existing local helpers/imports; `wsMocks` is the file's module-scope websocket mock object (its `connect` is a reset `vi.fn()`, so bootstrap's `await ws.connect()` resolves).

```typescript
  it('tears down the session and surfaces an auth failure when the sidebar window load returns 401', async () => {
    const store = createStore()
    // Bootstrap auth succeeds (beforeEach default apiGet), but the follow-up sidebar
    // snapshot is unauthorized -> ensureSidebarSessionsWindow must perform the auth
    // teardown even though fetchSessionWindow no longer throws.
    fetchSidebarSessionsSnapshot.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      // Proves the thunk path actually ran and recorded the failure...
      expect(store.getState().sessions.windows.sidebar?.error).toBe('Unauthorized')
      // ...and that the 401 drove the full auth teardown.
      expect(store.getState().connection.lastError).toBe('Authentication failed')
      expect(store.getState().connection.status).toBe('disconnected')
    })

    // Residue-proof discriminator: the teardown makes ensureSidebarSessionsWindow
    // return false, so bootstrap exits before the pre-connect clears and never
    // connects the websocket. (Without the teardown, bootstrap proceeds and
    // connect IS called — so this assertion alone keeps the test RED even if
    // transient 'Authentication failed' residue were ever observable.)
    expect(wsMocks.connect).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx -t "sidebar window load returns 401"`
Expected: FAIL — after Task 1, `ensureSidebarSessionsWindow`'s `catch` no longer fires (the throw is gone), so bootstrap proceeds past the failed sidebar load to the pre-connect block, which clears `connection.lastError` and drives status to `'ready'` via `ws.connect()`. Steady state therefore fails the teardown assertions and `waitFor` times out (the `sessions.windows.sidebar?.error` assertion alone will be satisfied — the failure is specifically the missing teardown); the final `wsMocks.connect` assertion also fails, since without the teardown bootstrap DOES connect. (An unmocked-`getAuthToken` branch sets `'Authentication failed'` transiently at bootstrap start in this file, but it is cleared on the same sequential path — the `connect` discriminator makes the RED gate immune to that residue regardless.)

- [ ] **Step 3: Extract `performAuthFailureTeardown` in App.tsx**

In `src/App.tsx`, inside `async function bootstrap()`, change the `handleBootstrapAuthFailure` definition (currently lines 509-524 — note it has FOUR overlay resets, not two):

```typescript
      const handleBootstrapAuthFailure = (err: unknown): boolean => {
        if (!isApiUnauthorizedError(err)) return false
        if (!cancelled) {
          resetCodexActivityOverlay()
          resetClaudeActivityOverlay()
          resetAmplifierActivityOverlay()
          resetOpencodeActivityOverlay()
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
          resetAmplifierActivityOverlay()
          resetOpencodeActivityOverlay()
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

> Placement note: keep both functions exactly where `handleBootstrapAuthFailure` sits today (top of `bootstrap()`). The four overlay-reset helpers are `const` arrow functions declared ~220 lines later in the same `bootstrap()` body (currently 731-749); this is safe for the same reason the current code is safe — these closures are only *invoked* after `bootstrap()` has evaluated past those declarations. Do not add any new call site that runs earlier.

- [ ] **Step 4: Rewire `ensureSidebarSessionsWindow` to inspect the result**

In `src/App.tsx`, change the `try`/`catch`/`finally` portion of `ensureSidebarSessionsWindow` (currently lines 779-797; leave the two early returns above it — the `sidebarWindowLoading` re-entrancy guard and the `lastLoadedAt` short-circuit — untouched):

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

> Both branches now resolve a `FetchSessionWindowResult` (Task 1 made `loadInitialSessionsWindow` propagate it), and neither can reject, so the `catch` is dead and removed. The `Promise<boolean>` return contract is preserved: `false` (stop bootstrap) exactly when unauthorized, `true` otherwise — identical decision table to the old throw-based code (a non-401 failure logs a warning and returns `true`, same as before).

- [ ] **Step 5: Import the result type in App.tsx**

In `src/App.tsx`, change the `@/store/sessionsThunks` import (currently lines 13-17):

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

Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx -t "sidebar window load returns 401"`
Expected: PASS.

- [ ] **Step 7: Run the full App ws-bootstrap file (no regressions)**

Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx`
Expected: all PASS. In particular:
- `recovers bootstrap-owned provider availability and sidebar filters after transient pre-ready 503s` — a 503 maps to `{ ok: false, unauthorized: false }` → `log.warn` + return `true`, same recovery flow as before;
- `marks connection as auth-required and skips websocket connect when the bootstrap request returns 401` — the `/api/bootstrap` path still goes through `handleBootstrapAuthFailure`, which now delegates to `performAuthFailureTeardown`;
- `contains a failing queued session-window refresh from a sessions.changed broadcast instead of leaking an unhandled rejection` — still passes (the root fix now provides the containment).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck:client`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "fix(app): preserve sidebar-load 401 auth teardown without a throw (xxqj)

ensureSidebarSessionsWindow now reads the FetchSessionWindowResult instead
of catching a thrown error; performAuthFailureTeardown is extracted so the
direct-fetch bootstrap 401 paths and the sidebar-window path share it.
Adds the previously-missing regression test for the 401 sidebar-load path.

Related-To: kata xxqj"
```

---

## Task 3: Remove the now-dead `queueActiveSessionWindowRefresh` catches

**Files:**
- Modify: `src/App.tsx` (two dispatch sites, currently ~1136 and ~1216)
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx` (two stale comments in the existing no-leak test, currently ~1944)

**Interfaces:**
- Consumes (from Task 1): `queueActiveSessionWindowRefresh` can no longer reject — its run loop `await`s the now-non-throwing `fetchSessionWindow`, and its `await activeRequest` sites are internally try/caught. The two inline `.catch()` guards on it in `App.tsx` are dead code.
- Produces: nothing new — deletions plus comment accuracy only. KEEP the `fetchTerminalDirectoryWindow` `.catch()` — that thunk (from `@/store/terminalDirectoryThunks`, a different module) still throws.

- [ ] **Step 1: Simplify the `sessions.changed` dispatch**

In `src/App.tsx`, inside the `if (msg.type === 'sessions.changed')` handler, change (currently lines 1134-1136):

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

In `src/App.tsx`, inside the `if (msg.type === 'terminal.inventory')` handler, change (currently lines 1210-1216 — note the shared plural comment covers both dispatches and must be rescoped, since `fetchTerminalDirectoryWindow` still throws):

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

- [ ] **Step 3: Refresh the stale comments in the existing no-leak test**

In `test/unit/client/components/App.ws-bootstrap.test.tsx`, in the test `it('contains a failing queued session-window refresh from a sessions.changed broadcast instead of leaking an unhandled rejection', ...)` (currently starts line 1944 — the test BODY stays byte-for-byte identical; only two comments change so they stop describing a throw that no longer exists). Change the opening comment:

```typescript
    // Regression: the sessions.changed handler dispatched queueActiveSessionWindowRefresh()
    // fire-and-forget with no .catch(). That thunk re-throws when it falls through to
    // fetchSessionWindow() without committed window data (e.g. a sessions.changed before the
    // sidebar window commits, or after a failed direct fetch retry), so a transient refresh
    // failure leaked an unhandled rejection that fails the whole test run even though every
    // test "passed" — the same failure class the terminal.inventory site already contains.
```

to:

```typescript
    // Regression: the sessions.changed handler dispatches queueActiveSessionWindowRefresh()
    // fire-and-forget with no .catch(). fetchSessionWindow used to re-throw on API failure,
    // so a transient refresh failure leaked an unhandled rejection that failed the whole
    // test run even though every test "passed". fetchSessionWindow now resolves a result
    // instead of rejecting, so containment is provided at the source — this test proves the
    // fire-and-forget dispatch can never leak, with no inline .catch present.
```

and change the second comment (a few lines below, above the `fetchSidebarSessionsSnapshot.mockRejectedValue(...)` line):

```typescript
    // Reject every snapshot fetch. The bootstrap sidebar load fails but is contained by
    // ensureSidebarSessionsWindow (so no window ever commits -> hasCommittedWindow stays
    // false), and the queued refresh then takes the re-throwing fetchSessionWindow branch.
```

to:

```typescript
    // Reject every snapshot fetch. The bootstrap sidebar load fails but is contained by
    // ensureSidebarSessionsWindow (so no window ever commits -> hasCommittedWindow stays
    // false), and the queued refresh then exercises the failing fetchSessionWindow branch.
```

- [ ] **Step 4: Verify the no-leak guarantee still holds and nothing regressed**

Run: `npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx`
Expected: all PASS — crucially `contains a failing queued session-window refresh from a sessions.changed broadcast instead of leaking an unhandled rejection` still passes, now proving the *root* fix contains the leak with no inline catch present (its `process.on('unhandledRejection')` listener must record zero matching rejections).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:client`
Expected: no errors. (`log` is still used elsewhere in App.tsx, so no unused-import fallout.)

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "refactor(app): drop redundant queueActiveSessionWindowRefresh catches (xxqj)

With fetchSessionWindow non-throwing, queueActiveSessionWindowRefresh can no
longer reject, so the inline .catch guards on it are dead. The root fix now
provides the containment. fetchTerminalDirectoryWindow's guard is kept, and
the no-leak regression test's comments are updated to describe the new
contract (its body is unchanged and still guards against leaks).

Related-To: kata xxqj"
```

---

## Task 4: Full verification of the branch

**Files:** none (verification only — the branch lands as a normal standalone feature branch via the workflow's own finish stage; do NOT force-push, do NOT touch any PR).

**Interfaces:**
- Consumes: the three commits from Tasks 1-3 on `fix/fetchsessionwindow-non-throwing`.
- Produces: a verified branch — typecheck clean, lint clean on touched files, deterministic focused suites, green full unit suite.

- [ ] **Step 1: Typecheck (client + server)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint the changed source files (expect 0 new errors/warnings)**

Run: `npx eslint src/store/sessionsThunks.ts src/App.tsx`
Expected: 0 errors, 0 warnings from these files.

- [ ] **Step 3: Robustness loop on the two touched test files (new tests must be deterministic — this change exists to kill CI flakes, so it must not introduce any)**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/fetchsessionwindow-non-throwing
pass=0; fail=0
for i in $(seq 1 20); do
  if npm run test:vitest -- run test/unit/client/store/sessionsThunks.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx >/tmp/xxqj-loop-$i.log 2>&1; then
    pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL run $i"; tail -25 /tmp/xxqj-loop-$i.log; fi
done
echo "PASS=$pass FAIL=$fail (of 20)"
```
Expected: `PASS=20 FAIL=0`.

- [ ] **Step 4: Full default-config unit suite**

Run: `FRESHELL_TEST_SUMMARY="kata xxqj: fetchSessionWindow non-throwing" npm run test:unit`
Expected: all files/tests PASS (this branch adds 2 tests net; do not assert absolute counts — the baseline moves with main). This is a broad coordinator-gated run: if the gate is held by another session, WAIT — never kill the holder.

- [ ] **Step 5: Run the e2e tests that touch these thunks**

Run: `npm run test:vitest -- run test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx`
Expected: all PASS (success-path behavior of the thunks is unchanged; `pane-activity-indicator-flow` mocks `fetchSessionWindow` at module level and is unaffected by the return-type change).

---

## Self-Review

**1. Spec coverage.**
- "fetchSessionWindow no longer rejects on API failure; returns `{ ok, unauthorized }`" → Task 1 Steps 4-5, proven by tests in Steps 1-2 (non-throwing contract + 401 result contract).
- "loadInitialSessionsWindow propagates the result" → Task 1 Step 8.
- "preserve the sidebar-load 401 auth teardown" → Task 2 Steps 3-5, proven by the new regression test (Steps 1-2) — the spec's third required new test.
- "all fire-and-forget callers (Sidebar ~281/291/489, HistoryView ~55, plus the uncaught awaits in HistoryView `refresh()` ~87 and `refreshActiveSessionWindow` ~657) stop leaking" → covered transitively by the thunk contract (Task 1); no per-site edits needed. The integration guarantee is proven in production code (not stubs) by the existing `unhandledRejection`-listener no-leak test, re-verified with the catches deleted in Task 3 Step 4.
- "remove the now-dead `.catch()` band-aids on queueActiveSessionWindowRefresh" → Task 3 Steps 1-2 (both sites: `sessions.changed` and `terminal.inventory`).
- "the existing throwing-contract test (`.rejects.toThrow('Search failed')`) is updated" → Task 1 Step 1 (verified: it is the only rejection assertion in the file).
- Scope guard: `fetchTerminalDirectoryWindow` untouched and its guard kept → Global Constraints + Task 3 Step 2; internal `try { await activeRequest } catch {}` kept → Task 1 Step 5 note.
- Landing corrections honored: no PR #382 folding, no squash/force-push — Task 4 is verification-only; branch lands via the workflow.
- Quality bar: typecheck + lint + focused vitest runs → Task 4 Steps 1-5; kata xxqj in every commit → Tasks 1/2/3 commit steps.

**1b. No silent deferrals.** No stubs, mocks-as-product, or deferred behavior: the production outcome (an API failure becomes a recorded Redux error instead of an unhandled rejection) is proven by (a) the thunk contract tests against the real thunk, (b) the App-level `process.on('unhandledRejection')` no-leak test running the real App bootstrap + real thunks (only the HTTP/WS layer is mocked, as is standard for this suite), and (c) the 401 teardown regression test asserting real `connection` state transitions. Nothing is moved to known limitations or future work. No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan.** No TBD/TODO/"handle errors appropriately"/"similar to Task N"; every code step shows the full before/after code; every run step has an exact command and expected outcome.

**3. Type consistency.** `FetchSessionWindowResult = { ok: boolean; unauthorized: boolean }` is defined and exported once (Task 1 Step 4), used as the inner-thunk return type (Task 1 Steps 5a, 8), imported as `type FetchSessionWindowResult` in App.tsx (Task 2 Step 5), and consumed as `FetchSessionWindowResult | undefined` in `ensureSidebarSessionsWindow` (Task 2 Step 4). `performAuthFailureTeardown` is defined in Task 2 Step 3 with all four overlay resets and called in Task 2 Steps 3-4. `settled` replaces `requestPromise` consistently at all three references (Task 1 Step 5 a/b/c). `isApiUnauthorizedError` is imported in Task 1 Step 4 (verified exported at `src/lib/api.ts:110`, real predicate `status === 401`) and used in Task 1 Step 5c; the App test file's mocked predicate has the same `status === 401` semantics, and both new tests reject with `Object.assign(new Error('Unauthorized'), { status: 401 })`, satisfying both the real and mocked predicates plus the `error.message` extraction in `setSessionWindowError`.

**4. Green-per-commit.** Task 1's commit leaves one untested path (sidebar-load 401 teardown) temporarily inert — explicitly noted — and the suite stays green (verified: no existing test covers that path; Task 1 Step 9 additionally runs App.ws-bootstrap.test.tsx before the commit to prove the intermediate state empirically, since its no-leak test depends on the preserved error-commit/no-window-commit semantics). Task 2 restores it with a RED→GREEN regression test. Tasks 3 and 4 are fully green.
