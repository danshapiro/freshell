# Codex Durable Promotion Stability Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Codex's current whole-tree rollout polling with a provider-witnessed exact-path promotion flow that stays cheap, eventual, and correct, while keeping Claude, FreshClaude, and OpenCode aligned under the same durable-session contract.

**Architecture:** Treat each provider's durable promotion as a provider-specific witness, not a generic timeout. For Codex, consume the `thread.path` surfaced by `thread/started`, register provider-native `fs/watch` subscriptions on that exact future rollout path and its parent directory, and confirm durability with O(1) existence checks plus a low-frequency backoff that has no 10 second cutoff. Keep the existing live-versus-durable split for the other providers: Claude stays transcript/UUID-backed, FreshClaude keeps live SDK identity separate from durable history identity, and OpenCode continues to promote only from its authoritative control surface.

**Tech Stack:** TypeScript, Node.js, WebSocket (`ws`), app-server JSON-RPC, Node filesystem APIs, Vitest, existing real-provider contract probes

---

This plan is intended to be self-contained: an implementer should be able to execute it using only the listed files, tests, and commands without needing additional transcript context.

## Research Snapshot

These are planning inputs from this machine on 2026-04-21. Re-prove them in Task 1 and then treat the checked-in tests and lab note as authoritative.

- Current shipped Codex promotion path is still the global scan in `server/coding-cli/codex-app-server/sidecar.ts`:
  - `DEFAULT_ARTIFACT_POLL_MS = 100`
  - `DEFAULT_ARTIFACT_TIMEOUT_MS = 10_000`
  - `waitForDurableArtifact()` walks the entire `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` tree on every pass.
- Current local Codex corpus size is already large enough that "just poll slower" is still the wrong mechanism:
  - `find ~/.codex/sessions -type f -name 'rollout-*.jsonl' | wc -l` -> `3432`
  - `du -sh ~/.codex/sessions` -> `3.7G`
  - one local reproduction of the shipped scan shape (`readdir` walk + `stat` on every rollout) took about `363ms` on this machine.
- Current official Codex app-server docs expose the primitives the shipped implementation is not using:
  - `thread/start` and `thread/started` return a thread object.
  - non-ephemeral threads have a concrete `thread.path`.
  - `fs/watch`, `fs/unwatch`, and `fs/changed` are stable app-server methods/notifications.
  - Source: `https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`
- A live local probe against the installed `codex-cli 0.122.0` showed:
  - `thread/start` already returns a concrete `thread.path` before the file exists.
  - the rollout file and even its date directory do **not** exist immediately after `thread/start`.
  - app-server accepts `fs/watch` on the missing rollout path and on the missing parent directory.
  - after the first real turn, the rollout file appears at the exact `thread.path`, and both watches emit `fs/changed`.
- The checked-in lab note currently records `codex-cli 0.121.0`, so Task 1 must explicitly reconcile the version of record instead of silently assuming the newer probe supersedes it.
- Recent upstream Codex issues still report "no rollout found" / rollout-materialization failures on real installs. We should therefore never treat "10 seconds elapsed" as proof of durability or proof of failure.
  - `https://github.com/openai/codex/issues/16872`
  - `https://github.com/openai/codex/issues/16994`

## Strategy Guardrails

- Do not keep the current `listRolloutArtifacts()` tree walk in any form.
- Do not replace the current 100ms poll loop with a slower whole-tree poll loop.
- Do not introduce a provider-wide watcher on all of `CODEX_HOME`, `CODEX_HOME/sessions`, or every date directory.
- Do not read or depend on Codex internal indexes such as `state_5.sqlite` or `session_index.jsonl`.
- Do not use `thread/list` or `thread/read` as the durability proof. The proof is the provider-owned rollout artifact at the provider-reported `thread.path`.
- Do not add a new cross-provider abstraction that forces Claude, FreshClaude, and OpenCode to mimic Codex internals. Share the invariant, not the mechanism.
- Do not reintroduce any "10 seconds or bust" promotion semantics. Pending Codex promotion must remain active until success or sidecar shutdown.
- Do not silently fall back from "restore this session" to "start a fresh session".

## Cross-Provider Contract

This plan intentionally keeps one invariant across all providers:

- Canonical durable identity is promoted only after a provider-specific durable witness exists.
- Same-server live reattach remains separate from durable restore.
- A missing durable witness is an explicit pending or restore-unavailable state, not a reason to guess.

Provider witnesses after this work:

- Codex: exact rollout file existence at provider-reported `thread.path`, observed through path-specific watch notifications plus path-specific existence checks.
- Claude terminal: exact transcript-backed UUID through the existing session repair / scanner path.
- FreshClaude: durable history identity through the existing history resolver; live SDK `sessionId` stays separate.
- OpenCode: authoritative control-plane session id through the existing health / status / event path.

## File Structure

- Create: `server/coding-cli/codex-app-server/durable-rollout-tracker.ts`
  Responsibility: own path-specific Codex durability tracking, watch registration, fallback existence probes, cleanup, and promotion callback.
- Create: `test/unit/server/coding-cli/codex-app-server/durable-rollout-tracker.test.ts`
  Responsibility: prove the tracker never scans the rollout tree, survives missed watch events, and keeps retrying past the old 10 second cutoff.
- Modify: `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`
  Responsibility: record the newly verified `thread.path` / `fs/watch` Codex contract explicitly.
- Modify: `test/helpers/coding-cli/real-session-contract-harness.ts`
  Responsibility: expose the real-provider probe helpers needed to assert `thread.path`, missing-path watch registration, and watch notifications after the first turn.
- Modify: `test/integration/real/coding-cli-session-contract.test.ts`
  Responsibility: lock the live Codex contract into executable tests.
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
  Responsibility: model the full `thread` shape and `fs/watch` / `fs/unwatch` / `fs/changed` RPCs.
- Modify: `server/coding-cli/codex-app-server/client.ts`
  Responsibility: surface rich `thread/started` payloads, expose path-watch RPC helpers, and deliver `fs/changed` notifications.
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
  Responsibility: forward richer thread notifications and watcher notifications to the sidecar layer.
- Modify: `server/coding-cli/codex-app-server/sidecar.ts`
  Responsibility: remove whole-tree polling and delegate Codex durability promotion to the exact-path tracker.
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
  Responsibility: emulate the current Codex contract closely enough for unit/integration coverage, including `thread.path` and watch notifications.
- Modify: `test/unit/server/coding-cli/codex-app-server/client.test.ts`
  Responsibility: lock protocol parsing and notification fanout.
- Modify: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
  Responsibility: verify runtime passthrough of richer payloads.
- Modify: `test/unit/server/coding-cli/codex-app-server/sidecar.test.ts`
  Responsibility: verify sidecar lifecycle, cleanup, and durable-promotion handoff using the new tracker.
- Modify: `test/integration/server/codex-session-flow.test.ts`
  Responsibility: verify Codex end-to-end promotion behavior through the terminal registry and websocket layer.
- Modify: `test/integration/server/durable-session-contract.test.ts`
  Responsibility: keep the provider-wide invariant explicit so Codex hardening does not regress Claude, FreshClaude, or OpenCode behavior.
- Modify: `test/integration/server/opencode-session-flow.test.ts`
  Responsibility: keep OpenCode's authoritative-control-surface witness explicit while the provider-parity tests are tightened.
- Modify: `test/unit/client/components/TerminalView.resumeSession.test.tsx`
  Responsibility: pin the client-visible boundary between live-only Codex state and durable promotion, while keeping the other providers' client resume behavior unchanged.

## Chunk 1: Lock The Provider Contract

### Task 1: Re-Prove The Codex Witness We Actually Want To Depend On

**Files:**
- Modify: `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`
- Modify: `test/helpers/coding-cli/real-session-contract-harness.ts`
- Modify: `test/integration/real/coding-cli-session-contract.test.ts`

- [ ] **Step 1: Write the failing real-provider assertions**

Add or tighten the real Codex probe so it asserts all of these facts together:

```ts
// This repo currently uses Vitest 3.2.4, so `toBeOneOf()` is available.
const rolloutWatchId = 'probe-rollout-path'
const parentWatchId = 'probe-rollout-parent'

expect(start.thread.ephemeral).toBe(false)
expect(start.thread.path).toMatch(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.+\.jsonl$/)
expect(await exists(start.thread.path)).toBe(false)
expect(await exists(path.dirname(start.thread.path))).toBe(false)
expect(await client.fsWatch(start.thread.path, rolloutWatchId)).toEqual({ path: start.thread.path })
expect(await client.fsWatch(path.dirname(start.thread.path), parentWatchId)).toEqual({ path: path.dirname(start.thread.path) })
expect(changed.params.watchId).toBeOneOf([rolloutWatchId, parentWatchId])
```

- [ ] **Step 2: Run the Codex real-provider section and verify it fails for the right reason**

Run:

```bash
FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts
```

Expected: the Codex section fails because the current checked-in harness and note do not yet encode `thread.path` or missing-path watch behavior.

- [ ] **Step 3: Extend the harness to capture path and watch behavior**

Teach the probe client/helpers to:

```ts
type CodexThreadHandle = {
  id: string
  path: string | null
  ephemeral: boolean
}

type FsChangedNotification = {
  watchId: string
  changedPaths: string[]
}
```

Also add one probe that waits for the first real turn to produce both:

- the rollout file appearing at `thread.path`
- at least one `fs/changed` notification mentioning that path

- [ ] **Step 4: Update the checked-in lab note with the new contract**

Record, in prose and in one short JSON-ish transcript snippet:

- whether the checked-in `0.121.0` note is being superseded by a newly captured `0.122.0` contract or whether the earlier note needs correction; record the version the probes actually ran against as the version of record
- `thread.path` is available before the file exists.
- `watchId` is caller-supplied to `fs/watch`, the response only returns canonicalized `path`, and later `fs/changed` notifications echo the original caller-supplied `watchId`.
- app-server accepts watches on the missing rollout path and missing parent directory.
- the first real turn materializes the rollout at the exact reported path.
- the watch notifications are usable as an event source, but durability still needs a direct path-specific existence check.

- [ ] **Step 5: Re-run the real-provider suite and commit**

Run the same command again.

Expected: PASS for the Codex section, with Claude and OpenCode still passing or explicitly skipped according to the existing opt-in rules.

Commit:

```bash
git add docs/lab-notes/2026-04-20-coding-cli-session-contract.md test/helpers/coding-cli/real-session-contract-harness.ts test/integration/real/coding-cli-session-contract.test.ts
git commit -m "test: lock codex rollout path contract"
```

## Chunk 2: Surface The Right Signals In The App-Server Layer

### Task 2: Teach The Protocol, Client, Runtime, And Fixture About `thread.path` And Watches

**Files:**
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
- Modify: `server/coding-cli/codex-app-server/client.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
- Modify: `test/unit/server/coding-cli/codex-app-server/client.test.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

- [ ] **Step 1: Write the failing unit tests first**

Cover:

- `thread/start` and `thread/resume` preserve `thread.path`, `ephemeral`, and any other fields the sidecar now depends on.
- `thread/started` handlers receive the full thread object, not just the id.
- `fs/watch` and `fs/unwatch` use JSON-RPC envelopes correctly.
- `fs/changed` notifications reach subscribers with the original `watchId`.

- [ ] **Step 2: Extend the protocol schemas**

Model at least these shapes explicitly:

```ts
const CodexThreadSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).nullable().optional(),
  ephemeral: z.boolean().optional(),
})

const CodexFsChangedNotificationSchema = z.object({
  method: z.literal('fs/changed'),
  params: z.object({
    watchId: z.string().min(1),
    changedPaths: z.array(z.string()),
  }),
})
```

- [ ] **Step 3: Update the client and runtime API**

Give the sidecar the exact surface it needs:

```ts
onThreadStarted(handler: (thread: CodexThreadHandle) => void): () => void
onFsChanged(handler: (event: CodexFsChangedEvent) => void): () => void
watchPath(path: string, watchId: string): Promise<{ path: string }>
unwatchPath(watchId: string): Promise<void>
```

Pin this explicitly in the implementation notes:

- `watchId` is generated by Freshell, not by Codex.
- `watchPath()` returns only the canonicalized watched path.
- correlation between `fs/watch` registration and later `fs/changed` events is performed through the original caller-supplied `watchId`.
- if `fs/watch` fails for a specific path, log the failure, keep the tracker alive, and fall back to backoff-only exact-path existence probes rather than hard-failing or silently dropping promotion

- [ ] **Step 4: Update the fake app-server fixture to match the live contract**

When the fixture emits `thread/started`, include a realistic `thread.path` and `ephemeral: false`.
When the fixture materializes the durable artifact, emit `fs/changed` for:

- the watched rollout path
- the watched parent directory

Ordering is not semantically important and duplicate notifications are allowed; Task 3's tracker tests must prove the tracker is resilient to both.

- [ ] **Step 5: Run the unit suite and commit**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: PASS.

Commit:

```bash
git add server/coding-cli/codex-app-server/protocol.ts server/coding-cli/codex-app-server/client.ts server/coding-cli/codex-app-server/runtime.ts test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "refactor: surface codex rollout path and watch events"
```

## Chunk 3: Replace The Codex Whole-Tree Poller

### Task 3: Build A Path-Specific Codex Durable Rollout Tracker

**Files:**
- Create: `server/coding-cli/codex-app-server/durable-rollout-tracker.ts`
- Create: `test/unit/server/coding-cli/codex-app-server/durable-rollout-tracker.test.ts`
- Modify: `server/coding-cli/codex-app-server/sidecar.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/sidecar.test.ts`

- [ ] **Step 1: Write the failing tracker and sidecar tests**

Cover these cases explicitly:

- promotion succeeds when the exact `thread.path` appears
- path and parent watches both work even when the watched target did not exist at registration time
- `thread.path === null` or `thread.ephemeral === true` skips promotion entirely
- if a second non-ephemeral `thread/started` arrives before promotion, the tracker cancels the older pending witness and follows the newest thread instead
- a missed or delayed watch event still promotes via the fallback existence check
- the rollout file appearing during watch registration still promotes because the tracker performs an immediate post-registration existence check
- promotion still happens after the old 10 second boundary
- shutdown unregisters outstanding watches and stops future timers
- no code path enumerates `CODEX_HOME/sessions`

- [ ] **Step 2: Create the dedicated tracker file instead of growing `sidecar.ts` further**

Use a focused tracker state like:

```ts
type PendingDurableRollout = {
  threadId: string
  rolloutPath: string
  rolloutParentPath: string
  pathWatchId: string
  parentWatchId: string
  backoffIndex: number
}
```

Use a low-frequency backoff schedule with no hard cutoff, for example:

```ts
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
```

After the last entry, keep repeating `60_000`.

Also pin the pending-thread semantics:

- ignore `thread/started` payloads whose `path` is missing or whose thread is explicitly ephemeral
- treat `path === undefined`, `path === null`, and `path === ''` as non-durable and skip promotion for those payloads
- before promotion, newest durable-capable thread wins, explicitly calls `unwatchPath()` for the older path/parent watch ids, and replaces the older pending witness for the same sidecar
- after promotion, leave behavior unchanged in this follow-up and record any later multi-thread/session-replacement follow-up work in `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`
- tracker lifetime is bound to sidecar lifetime, not to whether a terminal is currently attached; detach does not stop pending durability tracking while the sidecar still owns the live Codex session

- [ ] **Step 3: Make the proof O(1)**

The tracker's promotion proof must be:

```ts
await fsp.access(rolloutPath)
```

or an equivalent exact-path metadata check. Do not reopen content scanning and do not walk sibling artifacts.

Perform that exact-path check in two places:

- probe the same `thread.path` string Codex reported; use the canonicalized `watchPath()` response only for watch bookkeeping and diagnostics
- immediately after both watches are registered, to close the "file appeared during registration" race
- on each relevant `fs/changed` and scheduled backoff probe

- [ ] **Step 4: Wire the sidecar to the tracker**

Replace:

- `DEFAULT_ARTIFACT_POLL_MS`
- `DEFAULT_ARTIFACT_TIMEOUT_MS`
- `listRolloutArtifacts()`
- `rolloutArtifactMatchesThread()`
- `waitForDurableArtifact()`
- public `artifactPollMs` / `artifactTimeoutMs` sidecar options

with:

- `thread/started` -> extract `thread.id` + `thread.path`
- register watches immediately
- run the exact-path tracker until promotion or shutdown
- if tests still need a seam, replace the old poll knobs with a tracker-factory or backoff-schedule injection hook instead of preserving the old timeout semantics

- [ ] **Step 5: Run the tracker/sidecar suite and commit**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/durable-rollout-tracker.test.ts test/unit/server/coding-cli/codex-app-server/sidecar.test.ts
```

Expected: PASS, including the "older than 10 seconds but still eventually promotes" case.

Commit:

```bash
git add server/coding-cli/codex-app-server/durable-rollout-tracker.ts server/coding-cli/codex-app-server/sidecar.ts test/unit/server/coding-cli/codex-app-server/durable-rollout-tracker.test.ts test/unit/server/coding-cli/codex-app-server/sidecar.test.ts
git commit -m "refactor: track codex durability by exact rollout path"
```

## Chunk 4: Prove End-To-End Behavior And Keep The Other Providers Honest

### Task 4: Update Codex Integration Coverage To Match The New Promotion Mechanism

**Files:**
- Modify: `test/integration/server/codex-session-flow.test.ts`

- [ ] **Step 1: Write the failing integration assertions**

Keep the existing good behavior and add these expectations:

- fresh create still does **not** persist `effectiveResumeSessionId`
- durable promotion happens only after the rollout file exists at the provider-reported path
- unrelated file activity does not promote the session
- durable restore (`codex --remote <ws> resume <sessionId>`) stays unchanged

- [ ] **Step 2: Update the fake remote + fake app-server flow to drive the new proof**

The integration test should no longer depend on "any matching rollout anywhere under `CODEX_HOME`".
It should depend on the concrete rollout path carried in the fixture's `thread/started` payload.

- [ ] **Step 3: Run the Codex integration suite**

Run:

```bash
npm run test:vitest -- test/integration/server/codex-session-flow.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration/server/codex-session-flow.test.ts
git commit -m "test: codex promotion follows rollout path witness"
```

### Task 5: Re-State The Cross-Provider Invariant So Codex Hardening Does Not Distort The Others

**Files:**
- Modify: `test/integration/server/durable-session-contract.test.ts`
- Modify: `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- Modify: `test/integration/server/opencode-session-flow.test.ts`

- [ ] **Step 1: Write the failing parity assertions**

Make the contract explicit:

- Codex durable promotion is witness-based and eventual, not timer-based.
- `TerminalView.resumeSession.test.tsx` must pin the client-visible corollary: a pending Codex session stays live-only and is not persisted as durable until `terminal.session.associated`, while the non-Codex client resume flows keep their existing behavior.
- Claude durable restore is still transcript/UUID-based.
- OpenCode durable promotion is still authoritative-control-surface-based.
- FreshClaude still separates live SDK identity from durable history identity.

- [ ] **Step 2: Update the tests and only the production code that those tests truly require**

If Codex internal changes are enough, keep the other provider code untouched.
Only patch shared helpers or copy if the parity tests expose a real regression.

- [ ] **Step 3: Run the parity suite**

Run:

```bash
npm run test:vitest -- test/integration/server/durable-session-contract.test.ts test/unit/client/components/TerminalView.resumeSession.test.tsx test/integration/server/opencode-session-flow.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration/server/durable-session-contract.test.ts test/unit/client/components/TerminalView.resumeSession.test.tsx test/integration/server/opencode-session-flow.test.ts
git commit -m "test: preserve provider-specific durable witnesses"
```

## Final Verification

- [ ] **Step 1: Run the focused Codex suites together**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/durable-rollout-tracker.test.ts test/unit/server/coding-cli/codex-app-server/sidecar.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/durable-session-contract.test.ts
```

Expected: PASS.

- [ ] **Step 2: Re-run the opt-in real-provider contract suite**

Run:

```bash
npm run test:real:coding-cli-contracts
```

Expected: PASS, with the Codex section now explicitly proving the rollout-path witness contract.

- [ ] **Step 3: Run the coordinated repo suite before merge**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Confirm the branch is already fully committed**

Run:

```bash
git status --short
```

Expected: no output. Do not create an extra "final commit" if Tasks 1 through 5 already produced the planned commits.

## Recommended Course Of Action

Implement the Codex change as a narrow follow-up, not a second broad session-contract rewrite:

1. Re-prove and check in the Codex `thread.path` / `fs/watch` contract.
2. Teach the app-server layer to surface those signals directly.
3. Replace the full-tree poller with a path-specific tracker that has no hard timeout.
4. Keep the other providers on their own durable witnesses and lock that into parity tests.

The plan is intentionally opinionated:

- Prefer exact-path watch plus exact-path existence checks over any form of corpus scan.
- Prefer an eventual tracker over a short, aggressive polling deadline.
- Prefer provider-specific witnesses over a fake "one mechanism for everyone" abstraction.
