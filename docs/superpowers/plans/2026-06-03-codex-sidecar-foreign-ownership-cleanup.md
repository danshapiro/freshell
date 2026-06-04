# Codex Sidecar Foreign-Ownership Cleanup Implementation Plan

> **For implementers:** Execute this plan task-by-task with native tooling (`git worktree`, `npm`) — each task is self-contained and needs no plugin. Steps use checkbox (`- [ ]`) syntax for tracking. If your harness offers plan-execution helpers (e.g. `superpowers:executing-plans` / `subagent-driven-development`), they are optional and must not override the repo's `AGENTS.md` rules.

**Goal:** When a Codex app-server sidecar's process group is no longer ours (it exited and the PGID is now foreign), runtime shutdown should clean up the stale ownership-metadata file and resolve quietly, instead of leaking the file and logging an `error`.

**Architecture:** Replace the boolean `verifyOwnedProcessGroup` with a discriminated `classifyOwnedProcessGroup` returning `gone | self | owned | foreign | indeterminate`. In `teardownOwnedProcessGroup`, a `foreign` classification (our wrapper has left the group AND every readable member is provably not ours) means our sidecar is gone: unlink the metadata, log at `info`, and return `true` (success) — which stops `beginOwnershipTeardown` from throwing and therefore silences the downstream `terminal-registry.ts` `error` log. `self` and `indeterminate` keep the existing conservative refusal (never SIGKILL a group we can't prove is ours; keep the metadata). Crucially, ownership proof is tri-state — a member whose `/proc/<pid>/environ` cannot be read is `indeterminate` (absence of evidence), never `foreign`.

**Tech Stack:** TypeScript (NodeNext/ESM, `.js` import suffixes), Node v22, Vitest, Linux `/proc` + `process.kill(-pgid, sig)` process-group control.

---

## Background

Diagnosed from production logs: a sidecar teardown logged `error` "Refusing SIGKILL ... because ownership changed during shutdown" (`runtime.ts:355`) and the metadata file `~/.freshell/codex-sidecars/codex-sidecar-<id>.json` was left on disk even though the process (pid/pgid) was dead. Load-bearing-assumptions testing established:

- The refusal branch is reachable **only when the group is alive-but-not-ours** (`verifyOwnedProcessGroup` short-circuits to `true` when the group is gone), so a "if group gone → unlink" fix would never fire. The correct trigger is "ownership changed / our sidecar gone."
- The observed `error` line is emitted at `terminal-registry.ts:3265` (logging the Error thrown at `runtime.ts:1168` when teardown returns `false`), **not** at `runtime.ts:355`. Making teardown return `true` for the foreign case is what actually silences it.
- A live-and-ours sidecar always classifies as `owned` and never reaches the refusal branch, so disowning on `foreign` cannot orphan an owned sidecar — **provided** we never treat an unprovable group as foreign. The unprovable shapes that must stay conservative (`indeterminate`): (1) the wrapper is still resident in the group but its identity no longer matches; (2) the wrapper has left the group but a member's ownership proof (`/proc/<pid>/environ`) could not be read; (3) any `/proc/<pid>/stat` read the classifier depends on fails for a non-gone reason (so wrapper-group membership or member enumeration is unprovable).
- The classifier must therefore distinguish "gone" from "unreadable" for **every** `/proc` read it relies on — both `environ` (owner-only) **and** `stat` (used by `getProcessGroupId`/`processGroupMembers`, which today collapse any read/parse failure to `null`/silent-drop). `/proc/<pid>/stat` is world-readable on a normal kernel, so this only diverges under hardened `/proc` (hidepid/SELinux) or a parse anomaly — where the safe outcome is "don't disown" (`indeterminate`), never `foreign`.
- Teardown must **only** signal a group it has *just* classified `owned`. Each signal (SIGTERM and SIGKILL) is gated on a fresh `classifyOwnedProcessGroup` call immediately before it — not on a bare liveness check — so a PGID reused after the sidecar exited classifies as `foreign`/`gone` and is not signaled. `gone` (already dead — the normal clean-shutdown case) is a silent success: unlink and return `true`. **Caveat (irreducible):** PGID-targeted signaling has an unavoidable TOCTOU window between the classification and the `process.kill` syscall; re-classifying right before each signal narrows it to that gap but cannot eliminate it. The original code shares this race; the plan narrows it and does not claim to remove it.
- No new production injection seam is needed; the existing test harness reproduces `foreign` deterministically by repointing `ownership.metadata.processGroupId` at a second live sidecar's group, reaches the second (SIGKILL) gate with a `process.kill` spy, and reproduces `gone` by killing the real group before shutdown.

## File Structure

- **Modify:** `server/coding-cli/codex-app-server/runtime.ts`
  - Replace `processHasOwnershipEnv` (~lines 241-248) with a tri-state `readProcessOwnershipProof` returning `match | no-match | unreadable | gone`, plus an `OwnershipProof` type.
  - Add a tri-state `readProcessGroupIdResult` (`gone | unreadable | value`) and a `scanProcessGroupMembers` that reports whether any member's `stat` was unreadable; keep `getProcessGroupId` (~line 166) and `processGroupMembers` (~line 250) as thin wrappers so existing callers (reaper, `remainingPids` logging) are unchanged.
  - Replace `verifyOwnedProcessGroup` (~lines 274-298) with `classifyOwnedProcessGroup` (discriminated `OwnedProcessGroupStatus`) that consumes the tri-state readers.
  - Add helpers `unlinkOwnershipMetadata(ownership)`, `disownStaleOwnership(ownership, when)`, and `concludeIfNotOwned(ownership, status, when)` (single dispatch for every non-`owned` status).
  - Rewrite `teardownOwnedProcessGroup` (~lines 319-385) to re-classify ownership immediately before each signal (SIGTERM and SIGKILL), signaling only when still `owned`.
  - Reuse `unlinkOwnershipMetadata` in `assertNoBlockedOwnership` (~line 1141).
  - One responsibility: ownership-aware process-group teardown. No other files change (the metadata leak and the `error` severity are both fixed here because the foreign case now returns `true`).
- **Modify (tests):** `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
  - Update the existing "different process group" test (~line 815) to assert first-gate foreign cleanup (was: rejects; now: resolves + metadata removed + foreign group untouched).
  - Add a second-gate foreign-cleanup test (ownership changes after SIGTERM).
  - Add a safety test: a member whose ownership proof is unreadable → `indeterminate` → refuse + keep metadata.
  - Add a metadata-presence assertion to the existing `indeterminate` test (~line 844).

No `docs/index.html` change: this is internal lifecycle behavior with no user-facing UI.

---

### Task 1: Set up the worktree on a green baseline

**Files:** none (environment only)

- [ ] **Step 1: Confirm the repo-supported test suite is green on the intended base (`origin/main`)**

From a checkout of `origin/main`, run the coordinated full suite and wait for the shared test-coordinator gate (do not kill a foreign holder):

Run: `FRESHELL_TEST_SUMMARY="baseline for codex sidecar foreign-ownership cleanup" npm test`
Expected: PASS across every config the coordinated suite runs — `client`/default, `server`, and `electron` (see `scripts/run-standard-tests.ts`, which fans out to all three). If the suite is **not** green, STOP — do not create the worktree; notify the user with the failing command and a failure summary (AGENTS.md repo rule).

- [ ] **Step 2: Create a fresh implementation branch from CURRENT `origin/main`**

This plan doc currently lives on branch `fix/codex-sidecar-foreign-ownership-cleanup`, which was branched from an **earlier** `origin/main` and is now behind it. Per the repo branch model, behavior branches must start from the up-to-date `origin/main` — implementing on the stale branch would put unrelated divergence into the PR. Fetch and branch fresh, with a name that matches the push/PR step below:

Run: `git fetch origin`
Run: `git worktree add .worktrees/codex-foreign-ownership-impl -b fix/codex-sidecar-foreign-ownership-impl origin/main`

Carry only this plan doc onto the fresh branch (it is the sole artifact worth keeping from the stale branch):

Run: `git -C .worktrees/codex-foreign-ownership-impl checkout fix/codex-sidecar-foreign-ownership-cleanup -- docs/superpowers/plans/2026-06-03-codex-sidecar-foreign-ownership-cleanup.md`
Run: `git -C .worktrees/codex-foreign-ownership-impl add docs/superpowers/plans && git -C .worktrees/codex-foreign-ownership-impl commit -m "docs: carry Codex foreign-ownership cleanup plan onto impl branch"`

Do all implementation in `.worktrees/codex-foreign-ownership-impl`.

Run: `git -C .worktrees/codex-foreign-ownership-impl status -sb`
Expected: `## fix/codex-sidecar-foreign-ownership-impl...origin/main` ahead only by your own commits (clean base = current `origin/main`, not behind).

---

### Task 2: Red — failing tests for foreign-ownership cleanup at BOTH gates

The production failure is the **second** gate (after the SIGTERM grace window). Write both gate tests first so the implementation cannot satisfy the suite while leaving the recheck branch broken.

**Files:**
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts:815-842`

- [ ] **Step 1: Rewrite the existing "different process group" test to assert FIRST-gate foreign cleanup**

Replace the whole `it('does not use matching wrapper identity to authorize teardown of a different process group', ...)` block (currently ~lines 815-842) with:

```ts
  it('cleans up the stale record and refuses to signal when ownership moved to a different process group', async () => {
    const firstRuntime = createRuntime({
      metadataDir: await makeTempDir(),
      serverInstanceId: 'srv-runtime-test',
    })
    const secondRuntime = createRuntime({
      metadataDir: await makeTempDir(),
      serverInstanceId: 'srv-runtime-test',
    })
    let firstReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined
    let secondReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined

    try {
      firstReady = await firstRuntime.ensureReady()
      secondReady = await secondRuntime.ensureReady()
      const ownership = (firstRuntime as any).ownership
      const firstMetadataPath = ownership.metadataPath as string
      // Our wrapper is no longer in this group and nothing in it carries our ownership env:
      // the sidecar is effectively gone and the PGID is foreign.
      ownership.metadata.processGroupId = secondReady.processGroupId

      // Foreign ownership: shutdown resolves, cleans up our stale record, and never signals the
      // foreign group.
      await firstRuntime.shutdown()

      await expect(fsp.stat(firstMetadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await isProcessGroupAlive(secondReady.processGroupId)).toBe(true)
      expect(await isProcessGroupAlive(firstReady.processGroupId)).toBe(true)
    } finally {
      runtimes.delete(firstRuntime)
      runtimes.delete(secondRuntime)
      if (firstReady) await killProcessGroupForTest(firstReady.processGroupId)
      if (secondReady) await killProcessGroupForTest(secondReady.processGroupId)
    }
  })
```

- [ ] **Step 2: Add a SECOND-gate foreign-cleanup test directly after it**

Insert this new `it(...)` block immediately after the test from Step 1:

```ts
  it('cleans up the stale record at the SIGKILL gate when ownership changes during shutdown', async () => {
    const firstRuntime = createRuntime({
      metadataDir: await makeTempDir(),
      serverInstanceId: 'srv-runtime-test',
    })
    const secondRuntime = createRuntime({
      metadataDir: await makeTempDir(),
      serverInstanceId: 'srv-runtime-test',
    })
    let firstReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined
    let secondReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined
    const originalKill = process.kill.bind(process)
    let killSpy: ReturnType<typeof vi.spyOn> | undefined

    try {
      firstReady = await firstRuntime.ensureReady()
      secondReady = await secondRuntime.ensureReady()
      const ownership = (firstRuntime as any).ownership
      const firstMetadataPath = ownership.metadataPath as string
      const ownedGroup = firstReady.processGroupId
      const foreignGroup = secondReady.processGroupId

      // Ownership is valid at the first gate. When the runtime SIGTERMs the owned group, swallow the
      // signal (so the owned group survives the 1s grace window and we reach the SIGKILL gate) and
      // move ownership to a live foreign group, so the recheck classifies `foreign`. Liveness probes
      // (signal 0) and every other signal pass through unchanged.
      killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -ownedGroup && signal === 'SIGTERM') {
          ownership.metadata.processGroupId = foreignGroup
          return true
        }
        return originalKill(pid as any, signal as any)
      }) as typeof process.kill)

      await firstRuntime.shutdown()

      await expect(fsp.stat(firstMetadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await isProcessGroupAlive(foreignGroup)).toBe(true)
      expect(await isProcessGroupAlive(ownedGroup)).toBe(true)
    } finally {
      killSpy?.mockRestore()
      runtimes.delete(firstRuntime)
      runtimes.delete(secondRuntime)
      if (firstReady) await killProcessGroupForTest(firstReady.processGroupId)
      if (secondReady) await killProcessGroupForTest(secondReady.processGroupId)
    }
  }, 20_000)
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "cleans up the stale record" --run`
Expected: FAIL for both. On current code `shutdown()` rejects in **both** cases with the thrown wrapper error `"Codex app-server sidecar process-group teardown failed for ownership ..."` (from `beginOwnershipTeardown`, `runtime.ts:1168`). The `"... ownership could not be verified"` (first gate) and `"Refusing SIGKILL ... ownership changed during shutdown"` (second gate) strings are only *logged* inside teardown — never thrown — so do not assert on them. Either way `await firstRuntime.shutdown()` throws before the `ENOENT` assertions run, so both tests fail.

---

### Task 3: Green — classify ownership (tri-state proof) and disown the foreign case

**Files:**
- Modify: `server/coding-cli/codex-app-server/runtime.ts:241-385`, `:1141`

- [ ] **Step 1: Make the classifier's `/proc` reads tri-state (env proof + stat/membership)**

Replace the entire `processHasOwnershipEnv` function (currently ~lines 241-248) with a tri-state env proof:

```ts
type OwnershipProof = 'match' | 'no-match' | 'unreadable' | 'gone'

async function readProcessOwnershipProof(pid: number, ownershipId: string): Promise<OwnershipProof> {
  try {
    const raw = await fsp.readFile(`/proc/${pid}/environ`)
    return raw.toString('utf8').split('\0').includes(`FRESHELL_CODEX_SIDECAR_ID=${ownershipId}`)
      ? 'match'
      : 'no-match'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // The process vanished mid-scan: it carries no live ownership, so it is not evidence either way.
    if (code === 'ENOENT' || code === 'ESRCH') return 'gone'
    // Any other failure (e.g. EACCES) means we could not read the proof — absence of evidence, not
    // evidence of absence. We must not treat that as "not ours".
    return 'unreadable'
  }
}
```

Then make the `stat`-based reads tri-state too. Add `readProcessGroupIdResult` and a membership scanner, and rewrite `getProcessGroupId` (~lines 166-173) and `processGroupMembers` (~lines 250-262) as thin wrappers so existing callers keep their current contracts:

```ts
type ProcessGroupIdResult =
  | { kind: 'value'; processGroupId: number }
  | { kind: 'gone' }
  | { kind: 'unreadable' }

async function readProcessGroupIdResult(pid: number | 'self'): Promise<ProcessGroupIdResult> {
  let stat: string
  try {
    stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' }
    return { kind: 'unreadable' }
  }
  const parsed = parseProcStat(stat)
  // Present but unparseable: we cannot prove the process group, so it is unprovable, not "gone".
  if (!parsed) return { kind: 'unreadable' }
  return { kind: 'value', processGroupId: parsed.pgrp }
}

async function getProcessGroupId(pid: number | 'self'): Promise<number | null> {
  const result = await readProcessGroupIdResult(pid)
  return result.kind === 'value' ? result.processGroupId : null
}

async function scanProcessGroupMembers(
  processGroupId: number,
): Promise<{ members: number[]; sawUnreadable: boolean }> {
  const entries = await fsp.readdir('/proc')
  const members: number[] = []
  let sawUnreadable = false

  await Promise.all(entries.map(async (entry) => {
    if (!/^\d+$/.test(entry)) return
    const pid = Number(entry)
    const result = await readProcessGroupIdResult(pid)
    if (result.kind === 'value') {
      if (result.processGroupId === processGroupId) members.push(pid)
    } else if (result.kind === 'unreadable') {
      // A process we could not classify might be one of our members — stay conservative.
      sawUnreadable = true
    }
    // 'gone' → exited mid-scan; ignore.
  }))

  return { members: members.sort((a, b) => a - b), sawUnreadable }
}

async function processGroupMembers(processGroupId: number): Promise<number[]> {
  return (await scanProcessGroupMembers(processGroupId)).members
}
```

- [ ] **Step 2: Replace `verifyOwnedProcessGroup` with `classifyOwnedProcessGroup`**

Replace the entire `verifyOwnedProcessGroup` function (currently ~lines 274-298) with:

```ts
type OwnedProcessGroupStatus = 'gone' | 'self' | 'owned' | 'foreign' | 'indeterminate'

async function classifyOwnedProcessGroup(
  metadata: CodexSidecarOwnershipMetadata,
): Promise<OwnedProcessGroupStatus> {
  if (await isProcessGroupGone(metadata.processGroupId)) return 'gone'

  // /proc/self/stat is normally always readable, but stay tri-state for consistency: if we cannot
  // read our own process group, we cannot rule out that this PGID is the server's own group, so
  // refuse conservatively rather than risk signaling ourselves.
  const selfResult = await readProcessGroupIdResult('self')
  if (selfResult.kind === 'unreadable') return 'indeterminate'
  if (selfResult.kind === 'value' && metadata.processGroupId === selfResult.processGroupId) {
    return 'self'
  }

  // Tri-state wrapper read: 'gone' means the wrapper genuinely left the group; 'unreadable' means we
  // could not prove where it is, which must stay conservative (NOT "left the group").
  const wrapperResult = await readProcessGroupIdResult(metadata.wrapperPid)
  const wrapperInGroup =
    wrapperResult.kind === 'value' && wrapperResult.processGroupId === metadata.processGroupId
  if (wrapperInGroup) {
    const currentWrapperIdentity = await readProcessIdentity(metadata.wrapperPid)
    if (wrapperIdentityMatches(metadata, currentWrapperIdentity)) {
      return 'owned'
    }
  }

  const { members, sawUnreadable } = await scanProcessGroupMembers(metadata.processGroupId)
  let sawUnprovable = sawUnreadable || wrapperResult.kind === 'unreadable'
  for (const pid of members) {
    const proof = await readProcessOwnershipProof(pid, metadata.ownershipId)
    if (proof === 'match') return 'owned'
    if (proof === 'unreadable') sawUnprovable = true
  }

  // Cannot prove the group is not ours — stay conservative and never disown/kill it:
  //  - wrapper still resident but its identity no longer matches, or
  //  - the wrapper read, member enumeration, or a member's ownership proof was unreadable.
  if (wrapperInGroup || sawUnprovable) return 'indeterminate'

  // Wrapper has provably left the group and every readable member is provably not ours: our sidecar
  // is gone and the PGID is foreign (reused). The ownership record is stale.
  return 'foreign'
}
```

- [ ] **Step 3: Add the metadata-cleanup helpers**

Immediately after `classifyOwnedProcessGroup` (before `signalProcessGroup`), add:

```ts
async function unlinkOwnershipMetadata(ownership: ActiveOwnership): Promise<void> {
  await fsp.unlink(ownership.metadataPath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  })
}

async function disownStaleOwnership(ownership: ActiveOwnership, when: string): Promise<true> {
  const { metadata } = ownership
  logger.info(
    {
      ownershipId: metadata.ownershipId,
      terminalId: metadata.terminalId,
      generation: metadata.generation,
      wsUrl: metadata.wsUrl,
      wrapperPid: metadata.wrapperPid,
      processGroupId: metadata.processGroupId,
      serverInstanceId: metadata.serverInstanceId,
    },
    `Codex app-server sidecar process group is no longer owned (${when}); cleaning up stale ownership record without signaling`,
  )
  await unlinkOwnershipMetadata(ownership)
  return true
}

// Single dispatch for every non-`owned` classification, so the decision (and its safety guarantees)
// is identical everywhere teardown re-classifies. Returns the teardown result for a terminal status,
// or `null` for `owned` (meaning: the caller may signal). `gone` is a silent success (the normal
// clean-shutdown case); `foreign` cleans up with an info log; `self`/`indeterminate` refuse.
async function concludeIfNotOwned(
  ownership: ActiveOwnership,
  status: OwnedProcessGroupStatus,
  when: string,
): Promise<boolean | null> {
  const { metadata } = ownership
  if (status === 'gone') {
    await unlinkOwnershipMetadata(ownership)
    return true
  }
  if (status === 'foreign') {
    return disownStaleOwnership(ownership, when)
  }
  if (status === 'self' || status === 'indeterminate') {
    logger.error(
      {
        ownershipId: metadata.ownershipId,
        terminalId: metadata.terminalId,
        generation: metadata.generation,
        wsUrl: metadata.wsUrl,
        wrapperPid: metadata.wrapperPid,
        processGroupId: metadata.processGroupId,
        serverInstanceId: metadata.serverInstanceId,
      },
      `Refusing to signal Codex app-server sidecar because its process-group ownership is not verified (${when})`,
    )
    return false
  }
  return null // 'owned' — the caller may signal
}
```

- [ ] **Step 4: Rewrite `teardownOwnedProcessGroup` to re-verify ownership immediately before every signal**

Replace the entire `teardownOwnedProcessGroup` function (currently ~lines 319-385) with:

```ts
async function teardownOwnedProcessGroup(
  ownership: ActiveOwnership,
  terminateGraceMs: number,
): Promise<boolean> {
  const { metadata } = ownership

  // Gate the SIGTERM on a FRESH ownership classification rather than mere liveness: a PGID that was
  // reused after the sidecar exited classifies as `foreign`/`gone`, so it is never signaled. This
  // narrows — but cannot fully close — the residual classify->process.kill window inherent to any
  // PGID-targeted signal.
  const beforeTerm = await concludeIfNotOwned(ownership, await classifyOwnedProcessGroup(metadata), 'before SIGTERM')
  if (beforeTerm !== null) return beforeTerm
  signalProcessGroup(metadata.processGroupId, 'SIGTERM')

  if (!(await waitForProcessGroupGone(metadata.processGroupId, terminateGraceMs))) {
    // Re-verify ownership before escalating: if it exited during the grace window and the PGID was
    // reused, this re-classifies as `gone`/`foreign` and we never SIGKILL a non-owned group.
    const beforeKill = await concludeIfNotOwned(ownership, await classifyOwnedProcessGroup(metadata), 'before SIGKILL')
    if (beforeKill !== null) return beforeKill
    signalProcessGroup(metadata.processGroupId, 'SIGKILL')
  }

  const gone = await waitForProcessGroupGone(metadata.processGroupId, terminateGraceMs)
  if (!gone) {
    logger.error(
      {
        ownershipId: metadata.ownershipId,
        terminalId: metadata.terminalId,
        generation: metadata.generation,
        wsUrl: metadata.wsUrl,
        wrapperPid: metadata.wrapperPid,
        processGroupId: metadata.processGroupId,
        serverInstanceId: metadata.serverInstanceId,
        remainingPids: await processGroupMembers(metadata.processGroupId),
      },
      'Codex app-server sidecar process group remained alive after shutdown',
    )
    return false
  }

  await unlinkOwnershipMetadata(ownership)
  return true
}
```

- [ ] **Step 5: Reuse `unlinkOwnershipMetadata` in the deferred recovery path (DRY)**

In `assertNoBlockedOwnership` (~line 1141), replace the inline `await fsp.unlink(ownership.metadataPath).catch(...)` block with `await unlinkOwnershipMetadata(ownership)`. Leave the surrounding logic (clearing `this.ownership` and `this.ownershipTeardownFailure`) unchanged.

- [ ] **Step 6: Run the Task 2 tests to verify both now pass**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "cleans up the stale record" --run`
Expected: PASS for both the first-gate and second-gate tests.

- [ ] **Step 7: Commit**

```bash
git add server/coding-cli/codex-app-server/runtime.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "fix: clean up stale Codex sidecar ownership when the process group is foreign"
```

---

### Task 4: Lock the safety boundary — unprovable groups must NEVER be disowned

These tests lock the boundary against a future change that disowns a possibly-owned sidecar. The two `indeterminate` tests (Steps 1-2) would FAIL against a naive classifier that treats "wrapper not in group + no positive env/stat proof" as `foreign`; the reaper test (Step 4) is Red→Green against the current code (which reports a foreign-PGID record as `failed`).

**Files:**
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts` (new `indeterminate` env + `stat` tests after ~line 844; the existing `indeterminate` test ~line 844; a new reaper test after ~line 1124)

- [ ] **Step 1: New test — an unreadable member ownership proof yields `indeterminate` (refuse + keep metadata)**

Add this `it(...)` block immediately after the existing `it('does not use wrapper start ticks alone when command line and cwd no longer match', ...)` test:

```ts
  it('refuses to disown and keeps the record when a group member ownership proof is unreadable', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    const metadataPath = ownership.metadataPath as string
    // Force the member scan (wrapper no longer resident in the group), then make every
    // /proc/<pid>/environ read fail with EACCES so no live member can be proven ours.
    ownership.metadata.wrapperPid = 1
    const originalReadFile = fsp.readFile.bind(fsp)
    const readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation(((target: any, options?: any) => {
      if (/^\/proc\/\d+\/environ$/.test(String(target))) {
        const error = new Error('permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        return Promise.reject(error) as any
      }
      return originalReadFile(target, options as any) as any
    }) as typeof fsp.readFile)

    try {
      await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed|ownership/i)
      await expect(fsp.stat(metadataPath)).resolves.toBeDefined()
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      readFileSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  }, 20_000)
```

- [ ] **Step 2: New test — an unreadable wrapper `stat` yields `indeterminate` (refuse + keep metadata)**

Add this `it(...)` block immediately after the test from Step 1. It guards the `stat`-layer tri-state specifically: a readable-but-non-matching env (bogus id) plus an unreadable wrapper `stat` must classify `indeterminate`, not `foreign`.

```ts
  it('refuses to disown and keeps the record when the wrapper stat is unreadable', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    const metadataPath = ownership.metadataPath as string
    // No member can positively match (bogus id), and the wrapper's /proc/<pid>/stat is unreadable —
    // so membership is unprovable and the group must classify `indeterminate`, never `foreign`.
    ownership.metadata.ownershipId = 'no-such-ownership-id'
    const wrapperStatPath = `/proc/${ready.processPid}/stat`
    const originalReadFile = fsp.readFile.bind(fsp)
    const readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation(((target: any, options?: any) => {
      if (String(target) === wrapperStatPath) {
        const error = new Error('permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        return Promise.reject(error) as any
      }
      return originalReadFile(target, options as any) as any
    }) as typeof fsp.readFile)

    try {
      await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed|ownership/i)
      await expect(fsp.stat(metadataPath)).resolves.toBeDefined()
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      readFileSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  }, 20_000)
```

- [ ] **Step 3: Add a metadata-survives assertion to the existing `indeterminate` (wrapper-resident) test**

In the `it('does not use wrapper start ticks alone when command line and cwd no longer match', ...)` block (~line 844), immediately after `const ownership = (runtime as any).ownership`, add:

```ts
    const indeterminateMetadataPath = ownership.metadataPath as string
```

Then, inside the `try` block, immediately after the existing `expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)` assertion, add:

```ts
      await expect(fsp.stat(indeterminateMetadataPath)).resolves.toBeDefined()
```

- [ ] **Step 4: New reaper test — a stale record whose PGID is foreign is reaped (not "failed")**

The reaper (`reapOrphanedCodexAppServerSidecars`) calls the same `teardownOwnedProcessGroup`. This is a Red→Green test for the intended reaper behavior change: a stale record (dead owner server) whose recorded PGID now belongs to a live *foreign* group must move from `failedOwnershipIds` to `reapedOwnershipIds` and have its file removed, **without** signaling the foreign group. Add it immediately after the existing `it('does not treat a live reused owner pid as active without matching owner identity', ...)` reaper test (~line 1124):

```ts
  it('reaps a stale ownership record whose process group was reused by a foreign process', async () => {
    const metadataDir = await makeTempDir()
    const ownerRuntime = createRuntime({ metadataDir, serverInstanceId: 'srv-previous' })
    const foreignRuntime = createRuntime({
      metadataDir: await makeTempDir(),
      serverInstanceId: 'srv-foreign',
    })
    let ownerReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined
    let foreignReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined

    try {
      ownerReady = await ownerRuntime.ensureReady()
      foreignReady = await foreignRuntime.ensureReady()
      // Dead owner server + the recorded PGID now belongs to a live, unrelated (foreign) group.
      await markOwnershipRecordStale(ownerReady.metadataPath, {
        processGroupId: foreignReady.processGroupId,
      })

      const result = await reapOrphanedCodexAppServerSidecars({
        metadataDir,
        serverInstanceId: 'srv-current',
        terminateGraceMs: 1,
      })

      expect(result.reapedOwnershipIds).toContain(ownerReady.ownershipId)
      expect(result.failedOwnershipIds).not.toContain(ownerReady.ownershipId)
      await expect(fsp.stat(ownerReady.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await isProcessGroupAlive(foreignReady.processGroupId)).toBe(true)
    } finally {
      runtimes.delete(ownerRuntime)
      runtimes.delete(foreignRuntime)
      if (ownerReady) await killProcessGroupForTest(ownerReady.processGroupId)
      if (foreignReady) await killProcessGroupForTest(foreignReady.processGroupId)
    }
  }, 20_000)
```

- [ ] **Step 5: New test — an already-gone process group is cleaned up without any signal**

Add this `it(...)` block in the same describe as the other teardown tests. It locks the `gone` contract: an already-dead group is unlinked and `shutdown()` resolves with **no** `SIGTERM`/`SIGKILL` sent to the PGID (so a reused PGID can never be signaled).

```ts
  it('cleans up and never signals when the process group is already gone', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const metadataPath = (runtime as any).ownership.metadataPath as string

    const originalKill = process.kill.bind(process)
    const signalsToGroup: Array<NodeJS.Signals | number> = []
    // Install the spy BEFORE the group dies so it observes *any* teardown — the runtime's child-exit
    // handler may run teardown before shutdown() is even called. Liveness probes (signal 0) are
    // ignored; the setup kill below uses originalKill so it is not counted as a teardown signal.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -ready.processGroupId && signal !== 0) signalsToGroup.push(signal as any)
      return originalKill(pid as any, signal as any)
    }) as typeof process.kill)

    try {
      // The sidecar exits independently of teardown: its process group is genuinely gone.
      originalKill(-ready.processGroupId, 'SIGKILL')
      await waitForProcessExit(ready.processGroupId).catch(() => undefined)

      await runtime.shutdown()
      await expect(fsp.stat(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(signalsToGroup).toEqual([])
    } finally {
      killSpy.mockRestore()
      runtimes.delete(runtime)
    }
  }, 20_000)
```

This deterministically covers the **first** gate's `gone` branch. The second gate's `recheck === 'gone'` is the identical early-return (unlink + return `true`, no signal); reproducing the post-grace gone-then-reused race deterministically would require spying the module-private `isProcessGroupGone`, which this plan avoids — so that branch is covered by the shared code path plus static review (stated here so the gap is explicit, not silent).

- [ ] **Step 6: Run the safety + reaper tests**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "ownership proof is unreadable" --run`
Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "wrapper stat is unreadable" --run`
Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "does not use wrapper start ticks alone" --run`
Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "already gone" --run`
Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "reused by a foreign process" --run`
Expected: PASS for all five (`indeterminate` is never disowned and keeps its metadata; an already-gone group is cleaned up with no signal; the foreign reaper record is reaped without signaling the foreign group).

- [ ] **Step 7: Commit**

```bash
git add test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "test: never disown an unprovable Codex sidecar process group; reap foreign records; never signal a gone group"
```

---

### Task 5: Full-file regression + coordinated suite + typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run the entire runtime test file**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts --run`
Expected: PASS, including the new reaper test from Task 4 Step 4. The existing reaper tests at `:1073` and `:1097` filter at the owner-pid check (`runtime.ts:477`/`:487`) and never reach `teardownOwnedProcessGroup`, so they should be unaffected. **Do not pre-approve any reaper assertion change.** If a previously-passing reaper test flips (e.g. a record moves from `failedOwnershipIds` to `reapedOwnershipIds`), STOP and investigate which classification produced it: a `foreign` record moving to reaped is the intended behavior, but an `owned` or `indeterminate` record being reaped is a misclassification regression and must be fixed in the classifier, not in the test. Only update a test assertion once you have confirmed the new value reflects a `foreign` classification. If a `runtime.test.ts` failure is a real-subprocess startup-timeout flake (see the codex runtime startup flake note), re-run once; do not mask a real failure.

- [ ] **Step 2: Typecheck and run the coordinated full suite**

Run: `FRESHELL_TEST_SUMMARY="codex sidecar foreign-ownership cleanup" npm run check`
Expected: typecheck passes, then the coordinated full suite runs green across every config it fans out to — `client`/default, `server`, and `electron` (`scripts/run-standard-tests.ts`). Wait for the shared test-coordinator gate rather than killing a foreign holder.

- [ ] **Step 3: Commit any reaper-assertion follow-ups (only if Step 1 required them)**

```bash
git add test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "test: reclassify reused-PGID Codex reaper record as reaped"
```

---

### Task 6: Open the PR to `origin/main`

**Files:** none

- [ ] **Step 1: Push the branch and open the PR**

```bash
git push -u origin fix/codex-sidecar-foreign-ownership-impl
gh pr create --base main --title "fix: clean up stale Codex sidecar ownership when the process group is foreign" --body "$(cat <<'EOF'
## Summary
- Classify a Codex sidecar's process group as `gone | self | owned | foreign | indeterminate` during teardown.
- When the group is `foreign` (our wrapper has left the group AND every readable member is provably not ours), the sidecar is gone: unlink the stale `~/.freshell/codex-sidecars/<id>.json` record, log at `info`, and return success — which stops `beginOwnershipTeardown` from throwing and silences the downstream `Codex sidecar shutdown failed` error log.
- `self` and `indeterminate` keep the existing conservative refusal: never SIGKILL a group we can't prove is ours, and keep the metadata. Every `/proc` read the classifier relies on is tri-state — an unreadable `/proc/<pid>/environ` or `/proc/<pid>/stat` is `indeterminate`, never `foreign`.

## Why
Production teardown logged an `error` and leaked the ownership-metadata file when a sidecar's PGID became foreign (the process had already exited / the PGID was reused). The previous "refuse + keep metadata + throw" path left a stale file for the life of the server and produced misleading error-level noise.

## Tests
- First-gate foreign ownership resolves, removes the stale record, and never signals the foreign group.
- Second-gate foreign ownership (ownership changes after SIGTERM) — the actual production symptom — same behavior, driven via a `process.kill` spy.
- An unreadable member ownership proof (env) or wrapper `stat` yields `indeterminate`: refuse + keep metadata (locks the safety boundary against orphaning a possibly-owned sidecar).
- The wrapper-resident `indeterminate` case keeps its metadata.
- An already-`gone` process group is cleaned up with no `SIGTERM`/`SIGKILL` sent. Each signal is gated on a fresh ownership classification, narrowing (not eliminating) the irreducible classify→`process.kill` window for reused PGIDs.
- A stale reaper record whose PGID is foreign is reaped (not reported failed) without signaling the foreign group.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Apply the PR head to `dev` only after independent review** (per repo branch model — do not self-approve; `dev` consumes PR heads, never local-only behavior changes).

---

## Self-Review

**Spec coverage:**
- Leak fix (unlink stale metadata on foreign) → Task 3 Steps 2-4.
- `error`-severity fix (observed log silenced) → Task 3 (foreign returns `true` ⇒ no throw ⇒ no `terminal-registry.ts:3265` error); proven at BOTH gates by Task 2.
- Safety (disown): never disown an unprovable group → **every** `/proc` read the classifier depends on is tri-state (`readProcessOwnershipProof` for env, `readProcessGroupIdResult` + `scanProcessGroupMembers` for stat/membership), and `foreign` requires the wrapper to have *provably* left and *all* readable members to be provably not ours (Task 3 Steps 1-2). Guarded by Task 4 Steps 1-3 (wrapper-resident, unreadable-env, unreadable-stat).
- Safety (signal): each signal is gated on a fresh `classifyOwnedProcessGroup` via `concludeIfNotOwned` immediately before it, so a reused PGID (now `foreign`/`gone`) is not `SIGTERM`/`SIGKILL`'d (Task 3 Steps 3-4). This **narrows but does not eliminate** the irreducible classify→`process.kill` TOCTOU window — the plan documents that residual race rather than claiming to remove it (the original code shares it). Locked by Task 4 Step 5 (no-signal-on-gone).
- Reaper behavior change is tested and fenced → Task 4 Step 4 (dedicated foreign-PGID reaped test) + Task 5 Step 1 (no pre-approval; investigate any flip).
- Green baseline before branching → Task 1 Step 1 (full coordinated suite).
- No new production seam → tests use the existing repoint + `process.kill`/`fsp.readFile`-spy harness (Tasks 2 & 4).
- DRY: single `unlinkOwnershipMetadata` helper used by teardown success, `disownStaleOwnership`, and `assertNoBlockedOwnership` (Task 3 Steps 3 & 5).

**Placeholder scan:** none — every code and command step is concrete.

**Type consistency:** `OwnershipProof`, `readProcessOwnershipProof(pid, ownershipId)`, `ProcessGroupIdResult`, `readProcessGroupIdResult(pid)`, `scanProcessGroupMembers(pgid)`, `OwnedProcessGroupStatus`, `classifyOwnedProcessGroup`, `unlinkOwnershipMetadata(ownership)`, `disownStaleOwnership(ownership, when)`, `concludeIfNotOwned(ownership, status, when)` are defined in Task 3 and used consistently; `getProcessGroupId` and `processGroupMembers` keep their existing signatures (now thin wrappers), and `teardownOwnedProcessGroup` keeps its `(ownership, terminateGraceMs) => Promise<boolean>` signature so callers (`reapOrphanedCodexAppServerSidecars` at `runtime.ts:493`, `beginOwnershipTeardown` at `:1166`) are unchanged. `processHasOwnershipEnv` is fully replaced (its only caller was the old `verifyOwnedProcessGroup`).

**Coverage note:** both teardown gates are now exercised deterministically (Task 2). The second-gate test pays the `DEFAULT_TERMINATE_GRACE_MS` (1s) wait while the foreign group stays alive — hence the explicit `20_000` ms test timeout — and never SIGKILLs the foreign group.
