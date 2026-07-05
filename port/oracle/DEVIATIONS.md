# Deviation ledger — where the port INTENTIONALLY differs from the original

User directive: **fix bugs as found; do not replicate bug-for-bug.** Therefore
the port is behavior-equivalent to the original EXCEPT for the entries below.
The oracle whitelists exactly these diffs (by fingerprint); any *unlisted*
old-vs-new divergence is always a failure (a port defect to fix).

## Entry rules (enforced by the antagonist reviewer, not the implementer)

An entry may be added ONLY when the original is **objectively defective** — one
of: panics/crashes/errors, resource leak, violates the WS protocol schema,
contradicts documented behavior (AGENTS.md / docs / lab-notes), corrupts data,
or breaks an invariant the code itself asserts. Aesthetic preference is NOT a
defect and must be rejected as scope creep.

Every entry requires:
- **id**: DEV-NNNN
- **objective_defect**: which bar above, with evidence (`file:line`, error, or
  schema/doc citation)
- **original_behavior**: what freshell does today
- **port_behavior**: the corrected behavior
- **fingerprint**: how the differ recognizes this specific diff (tier + matcher)
- **pinning_test**: path to the new positive test asserting the fixed behavior
- **adjudicated_by**: antagonist-reviewer session id
- **status**: proposed | accepted | rejected

## Ledger

### DEV-0001 — opencode `serve` cold-start health probe is unbounded (defeats the bounded health-wait)

**Antagonist adjudication (two decisions):**
1. **Defect classification: ACCEPTED as OBJECTIVE** — the PORT shall bound the health probe.
2. **Submitted edit to the ORIGINAL source (`server/fresh-agent/adapters/opencode/serve-manager.ts`,
   `waitForHealth`): REJECTED — revert to pristine.** Bug-fixes go in the PORT (`port/AGENTS.md:40`);
   the ledger — not source mutation — records the original's defect. Editing the reference baseline
   erases the very divergence this ledger exists to whitelist and lets the implementer grade its own
   new T2 harness by doctoring the system-under-test.

- **objective_defect:** *breaks an invariant the code itself asserts* + internal inconsistency.
  - Bounded-wait invariant: `while (Date.now() < deadline)` at
    `server/fresh-agent/adapters/opencode/serve-manager.ts:276`, which throws
    `"opencode serve did not become healthy within ${healthTimeoutMs}ms"` once the deadline passes.
  - The inner health GET is UN-timed (`this.fetchFn(\`${baseUrl}/global/health\`, { method: 'GET' })`,
    pre-patch). A cold `opencode serve` accepts the TCP connection then withholds the response, so a
    single probe blocks (up to the undici headersTimeout — far past the deadline, not truly infinite)
    and the loop never re-evaluates `Date.now() < deadline`. The asserted bound is defeated.
  - Contradicts the class's OWN tested contract that fetches must not wait forever:
    `fetchWithRequestTimeout` (`serve-manager.ts:145-179`) + passing test *"aborts and fails hung JSON
    requests instead of waiting forever"* (`test/unit/server/fresh-agent/opencode-serve-manager.test.ts:325`).
    The health probe is the sole fetch that bypasses that protection.
  - Coverage gap (why it survived): the only deadline tests
    (`opencode-serve-manager.test.ts:187-192`, `:212-223`) use immediately-resolving mocks; no test
    injects a never-resolving `/global/health` fetch.
- **original_behavior:** On a cold/first `opencode serve` in an isolated home,
  `OpencodeServeManager.ensureStarted()` issues one un-timed GET `/global/health`; the serve holds the
  connection, so the probe blocks well beyond `healthTimeoutMs` (implementer A/B: `ensureStarted
  TIMEOUT ~35s`). The user's WARM production server answers instantly, so this is invisible in normal use.
- **port_behavior:** Each probe is bounded by a 2000 ms AbortController; on abort/refusal the loop
  retries every 150 ms until the serve answers or the overall `healthTimeoutMs` deadline elapses. Cold
  start then completes within the deadline (implementer A/B: `~3.5s`). A genuinely wedged serve still
  fails as the intended bounded `"did not become healthy within ${healthTimeoutMs}ms"` — the 2 s/retry
  does NOT mask a wedge, because the outer deadline is unchanged.
- **fingerprint:** T2 / opencode cold-serve-start slice. Differ tolerates: original `ensureStarted`
  {blocks past deadline | throws "did not become healthy"} vs port {healthy within `healthTimeoutMs`}.
  The port is NOT required to reproduce the original's cold-start block; every other opencode T2
  invariant must still match.
- **pinning_test (REQUIRED — does not exist yet):** port-side test that injects a `fetchFn` whose
  `/global/health` never resolves, drives `ensureStarted()`, and asserts it settles within the deadline
  (rejects with the bounded "did not become healthy" message, i.e. the loop advanced) rather than
  hanging; plus a companion where the probe stalls on the first N attempts then succeeds, asserting
  `ensureStarted()` resolves. Target: the port's opencode serve-manager suite
  (`crates/freshell-server/tests/opencode_serve_health.rs`; interim TS mirror
  `test/unit/port/oracle/opencode-health-probe-bounded.test.ts`). This is the exact case the current
  suite lacks.
- **adjudicated_by:** antagonist-reviewer session `0000000000000000-670a1870c51a41b5_anchors-architect`
  (parent `1d2dea08-9a63-4ecf-bc4b-ee25a852a4d8`), 2026-07-04.
- **status:** accepted (deviation) — **original-source edit REJECTED; revert required.**

**Conditions before this deviation is satisfied / committable:**
1. `git checkout -- server/fresh-agent/adapters/opencode/serve-manager.ts` — restore the pristine original.
2. Implement the bounded probe in the PORT and land the pinning test above (red → green).
3. PIN the real T2 stall first. `port/oracle/harness/t2-live.ts:52` states the stall point
   (health-probe vs createSession) is unpinned, and the live drive still stalls (`turnAccepted=false`,
   behavioral assertions skipped) even after this work — so this health fix must NOT be credited with
   unblocking T2 until the stall is proven to be the health probe. Do not let it mask the deeper
   "never flips to idle" / createSession stall (`t2-live.ts:32-33,44-52`).
4. T2 must obtain its original-side baseline WITHOUT mutating the original — drive a warm sidecar
   (`t2-live.ts:50-51` notes a directly-spawned serve with bounded polling already works; the user's
   warm server is unaffected).

### DEV-0002 — coding-CLI session-indexer crashes the whole process on a late provider session-root

**Antagonist adjudication (two decisions):**
1. **Defect classification: ACCEPTED as OBJECTIVE (crash / uncaught exception).** The PORT's Rust
   session-indexer must guard the late-root watcher: a provider home that exists while its
   session-root subdir is absent at boot, then gains that subdir at runtime, must **log + degrade and
   keep the process alive**, never abort.
2. **Harness env workaround (`seedClaudeCredsIntoHome()` `mkdir -p <HOME>/.claude/projects`,
   `port/oracle/harness/t2-live-claude.ts:221-238`): ACCEPTED for T2 baseline capture.** It is
   legitimate environment parity (make the isolated HOME match a real user's steady state), exactly
   the DEV-0001 warm-sidecar pattern — NOT a source mutation. Verified: `server/**` is pristine
   (`git status`: only `port/oracle/**` + `test/**` touched; `server/coding-cli/session-indexer.ts`
   unmodified). This does NOT self-approve the port fix; the pinning test below is mandatory and the
   port is held to the higher "no crash" bar the harness deliberately sidesteps for the original.

- **objective_defect:** *crashes / uncaught error* — a process-fatal, unhandled `'error'` on a
  chokidar `FSWatcher`. Independently reproduced (throwaway repro, zero model cost, repo chokidar
  3.6.0) with the byte-identical stack the implementer reported:
  ```
  TypeError: Cannot read properties of undefined (reading 'on')
      at NodeFsHandler._handleRead  (chokidar/lib/nodefs-handler.js:472:5)
      at NodeFsHandler._handleDir   (…/nodefs-handler.js:563:18)
      at NodeFsHandler._addToNodeFs (…/nodefs-handler.js:617:27)
  Emitted 'error' event on FSWatcher instance at:
      at FSWatcher._handleError     (chokidar/index.js:647:10)
      at NodeFsHandler._addToNodeFs (…/nodefs-handler.js:645:18)
  Node.js v22.21.1   → process.exit(1)
  ```
  Root cause is a **self-inflicted close-during-add race**, confirmed line-by-line:
  - claude root = `<HOME>/.claude/projects` (`providers/claude.ts:521-522`), watch-base = `<HOME>/.claude`
    (`providers/claude.ts:525-526`). Seeding only `.credentials.json` makes `<HOME>/.claude` exist but
    `…/projects` absent, so `startRootWatcher` walks to the nearest existing ancestor `<HOME>/.claude`
    (`session-indexer.ts:516-528`) and arms `chokidar.watch([ancestor], { depth: 1 })`
    (`session-indexer.ts:538-541`).
  - When the first turn creates `…/projects`, the rootWatcher's own `'addDir'` handler fires
    `void this.reconfigureWatchers()` (`session-indexer.ts:553-556`). The watcher-key now changes
    (root exists), so reconfigure closes the *old* rootWatcher (`session-indexer.ts:479-482`).
  - chokidar `close()` synchronously sets `closed = true` **and `this.removeAllListeners()`**
    (`chokidar/index.js:502-507`) — destroying the `'error'` guard installed at
    `session-indexer.ts:597`.
  - The in-flight `_addToNodeFs` for the new dir resumes on a later microtask; `_readdirp` now returns
    `undefined` because the watcher is closed (`chokidar/index.js:939-940`), so
    `undefined.on(STR_DATA, …)` throws (`nodefs-handler.js:468-472`). The `catch` re-routes it to
    `_handleError` (`nodefs-handler.js:644-645`), which `emit('error', …)` for a code-less TypeError
    (`chokidar/index.js:642-647`) — now on a **listener-less** FSWatcher → Node aborts the process.
  - Repro proof: root **absent** at boot → `CRASHED=true`, exit 1, the `'error'` handler never fires
    (removeAllListeners stripped it first); root **pre-created** → clean exit 0. Matches the
    implementer's table (`notes/t2-claude-haiku.md:51-57`).
  - Not merely an isolated-home artifact: the late-root watcher exists *specifically* to handle
    "root absent at startup, appears later" (`session-indexer.ts:432-435`), and it handles that
    designed-for case by crashing. Reachable by real users on a fresh Claude-Code install / after
    deleting `~/.claude/projects` while keeping creds; and structurally provider-agnostic (opencode's
    watch-base `path.dirname(homeDir)` = `~/.local/share` commonly exists on real Linux hosts —
    `providers/opencode.ts:334-335` — so it can hit the same race; it is spared only in the empty
    isolated HOME). claude is the sole crasher *in the oracle's isolated HOME* because it is the only
    provider whose ancestor exists there (creds seeding), per `notes/t2-claude-haiku.md:41-44` — verified.
- **original_behavior:** With `<provider-home>` present but its session-root subdir absent at server
  boot, freshell arms a depth-limited late-root watcher on the ancestor; the instant the subdir is
  created at runtime (e.g. the first freshclaude turn writing `…/projects/<hash>/<uuid>.jsonl`),
  chokidar throws an uncaught `TypeError` on the FSWatcher `'error'` path and **the entire freshell
  process exits mid-turn** (captured transcript stops at `system/init`, `msgs=0`; no assistant reply).
- **port_behavior:** The Rust session-indexer's late-root watcher tolerates the subdir appearing:
  on the reconfigure-triggered teardown it must not deref a closed watcher; a watcher error is
  **logged and the indexer degrades** (schedules a full rescan) while the **process stays up**; once
  the subdir exists, precise-root watching + indexing **resume** and the new session becomes visible.
- **fingerprint:** **Not a wire-message diff — a process-liveness / lifecycle invariant.** The T2
  live differ will *never* observe this diff: the harness pre-creates `…/projects` for BOTH original
  and port (env parity), so neither side crashes during baseline capture and there is nothing for the
  message-differ to whitelist. Therefore this deviation is **pinned by a dedicated liveness test, not
  whitelisted in the differ.** If any future harness/chaos run *omits* the pre-create, the expected
  (whitelisted) divergence is: original → abnormal WS close + `process.exit` (turn aborts, no further
  messages) vs port → process stays alive, WS open, `sessions.changed`/rescan proceeds once the subdir
  appears. Keyed on the env precondition {provider-home exists ∧ session-root subdir absent at boot ∧
  subdir created at runtime}, never on a message payload.
- **pinning_test (REQUIRED — does not exist yet):** port-side liveness test —
  `crates/freshell-server/tests/coding_cli_late_root_watcher.rs`. Arrange a watched provider home whose
  session-root subdir is absent at boot (indexer arms the late-root watcher on the existing ancestor);
  create the subdir + a session file at runtime; assert (a) the process/task does **not** panic or
  abort, (b) the watcher error is logged and a rescan is scheduled (degrade, not die), and (c) the new
  session under the subdir becomes visible (indexing resumed). Companion: reconfigure-on-appearance must
  not tear down liveness or double-fault. Interim TS red-documenting-original mirror (optional, proves
  the ledger's claim about the reference): `test/unit/port/oracle/session-indexer-late-root-liveness.test.ts`
  asserting the *current* TS original crashes/emits-uncaught under the precondition. The authoritative
  green assertion lives in the Rust port test.
- **adjudicated_by:** antagonist-reviewer session `0000000000000000-07e6276da5bd45cc_anchors-architect`
  (parent `1d2dea08-9a63-4ecf-bc4b-ee25a852a4d8`), 2026-07-04.
- **status:** accepted (deviation) — **no source mutation this time (harness/env fix only); harness
  workaround APPROVED for baseline capture; port owes the guarded watcher + pinning test above.**

**Conditions before this deviation is satisfied / committable:**
1. Keep `server/coding-cli/session-indexer.ts` pristine (confirmed unmodified). The fix lands only in
   the PORT.
2. Land the port-side liveness pinning test above (red on a naive port that mirrors the crash → green
   once the watcher is guarded).
3. The T2 claude/Haiku baseline may rely on the pre-created `…/projects` env parity, but the port must
   NOT be exempted from the projects-absent path — the pinning test is the sole mechanism that verifies
   the fix, since the T2 differ is blind to this lifecycle defect by construction.

<!--
Template:

### DEV-0001 — <short title>
- objective_defect: <bar> — <evidence file:line>
- original_behavior: <...>
- port_behavior: <...>
- fingerprint: T<0-3> / <matcher>
- pinning_test: <path>
- adjudicated_by: <session id>
- status: proposed
-->

## Related non-behavioral fix (test infrastructure, already landed)

Not a behavioral deviation, recorded here for traceability only: the
`test:real:coding-cli-contracts` launcher set the wrong env var and was a silent
no-op; fixed on this branch with a regression test. This changed test tooling,
not freshell's runtime behavior, so it needs no oracle whitelist.
