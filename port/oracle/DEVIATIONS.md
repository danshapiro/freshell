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
- **pinning_test (SATISFIED — Phase 3.5):** port-side liveness test —
  `crates/freshell-sessions/tests/late_root_watcher_liveness.rs` (4 tests green: a deterministic-fake
  drive of the exact close-during-add race + a real-`notify` end-to-end; co-located with the indexer it
  pins rather than the pre-crate-split path below). Arrange a watched provider home whose
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

### DEV-0003 — freshcodex reasoning-effort `none`/`minimal` "silent stall" (proposed as DEV-CODEX-EFFORT) — **REJECTED / NOT PROVEN**

**Antagonist adjudication: REJECTED — the objective-defect bar is NOT met, and the stated root cause is
contradicted by freshell's own committed codex contract.** This entry is recorded for traceability only.
It grants the differ **NO tolerance** (see fingerprint) — an unlisted original-vs-port divergence in codex
effort handling remains a port defect to fix, exactly as if this entry did not exist. Source stays pristine
(it already is; `git status` shows only `port/oracle/**` touched). The T2 codex slice is NOT blocked by this
rejection: it captured its baseline with `effort='low'` and stands on its own.

**What the implementer proposed:** freshcodex offers efforts `none`/`minimal`/`max`
(`shared/fresh-agent-models.ts:34,40,46`) and forwards `none`/`minimal` to the codex app-server verbatim
(`server/fresh-agent/adapters/codex/adapter.ts:130-131`, sent on `turn/start` at `:978`); a live run #1 with
`effort='minimal'` stalled ~180s with no reply and no error; therefore the PORT should map/clamp `none`/`minimal`
to a codex-valid effort. Proposed as an objective *hang*.

**Why REJECTED (independently verified, `file:line`):**
1. **The premise "codex accepts efforts ONLY `{low,medium,high,xhigh}`; `none`/`minimal` are rejected" is
   directly contradicted by freshell's own codex app-server protocol model.**
   - `CodexReasoningEffortSchema = z.enum(['none','minimal','low','medium','high','xhigh'])`
     (`server/coding-cli/codex-app-server/protocol.ts:26`) — `none`/`minimal` are modeled as VALID codex
     efforts. Set deliberately in commit `d4c7f5b5` ("Bring main to tested dev stack"), not incidental.
   - That schema governs BOTH the outbound `turn/start` params (`protocol.ts:312`, `effort:
     CodexReasoningEffortSchema…`) AND the inbound `thread` operation RESULT the app-server RETURNS
     (`protocol.ts:233`, `reasoningEffort: CodexReasoningEffortSchema…`). freshell modeling the server as
     *returning* `reasoningEffort ∈ {none,minimal,…}` means its authors observed/expected the server to
     accept and echo those values.
   - freshell's real-codex **contract-harness `model/list` fixture advertises `minimal` as a
     `supportedReasoningEffort`** (`test/helpers/coding-cli/real-session-contract-harness.ts:1121-1130`,
     `defaultReasoningEffort:'high'` at `:1120`). So `minimal` is a first-class codex effort in freshell's own
     model of the wire — the opposite of "not accepted by the codex models."
2. **The claimed failure mode (silent stall, NO error) is inconsistent with "the server rejected the value."**
   A schema-invalid/unsupported param yields a JSON-RPC error, which `startTurn`
   (`server/coding-cli/codex-app-server/runtime.ts:1017-1020`) would REJECT on and surface — not a silent hang.
   A silent 180s stall is evidence *against* "server rejected the effort" and *for* an unrelated stall
   (mirroring this campaign's earlier opencode "never emits idle" misdiagnosis, which was actually the
   DEV-0001 health wedge, and the false-green the antagonist previously caught).
3. **The stall is un-pinned and unreproducible from any deterministic artifact.** The fake app-server ignores
   `effort` entirely and always completes the turn (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs:228-232`;
   `turn/completed` only fires if the harness scripts it, `:333-345,547`). Nothing in the suite substantiates
   an effort-dependent hang; the sole evidence is one live observation whose interpretation conflicts with the
   committed contract. Burden of proof is on the party asserting the original is objectively defective; it is
   not discharged.
4. **`max` is NOT a defect — it is correctly handled.** `max`/`xhigh`→`xhigh` on the wire
   (`adapter.ts:129`), tested at `test/unit/server/fresh-agent/codex-adapter.test.ts:1418→1438`; and
   `normalizeFreshAgentEffort` already clamps any effort NOT in a model's declared list back to the model's
   `defaultEffort` (`shared/fresh-agent-models.ts:142-151`), tested at `codex-adapter.test.ts:1477-1509`
   (`gpt-5.4-flash` + `xhigh` → wire `high`). `none`/`minimal` survive only because freshell *declares them in
   the model's `thinkingEfforts`* — consistent with the protocol treating them as valid.
5. **Accepting would prescribe a silent behavior regression on contested evidence.** Clamping/mapping
   `none`/`minimal` would change a user's selected effort and diverge from the original with no *proven*
   objective defect — precisely the "scope creep / grading your own homework" failure the ledger's Entry rules
   (this file, "Entry rules", lines 8-14) and the DEV-0001 adjudication exist to prevent.

**One or two defects? Neither is adjudicable as objective right now:**
- *(A) Menu vs. reality:* `shared/fresh-agent-models.ts` HARDCODES per-model effort menus instead of deriving
  them from the app-server's live `model/list.supportedReasoningEfforts`, which is the DOCUMENTED design intent
  (`docs/plans/2026-04-30-freshcodex-contract-foundation.md:980-981,2625-2629`;
  `docs/plans/2026-05-03-freshcodex-contract-foundation-test-plan.md:406`, "efforts come from app-server
  model/list … not stale defaults"). A hardcoded-vs-dynamic gap is a completeness/design item (plausibly
  intended-future work), NOT a proven hang, and not what was proposed. If a real menu/reality mismatch is ever
  pinned, the fix belongs in the port's model-catalog layer (derive efforts from `model/list`), not a blind
  effort clamp.
- *(B) No turn-completion timeout:* `runtime.startTurn` returns after the JSON-RPC ack
  (`runtime.ts:1017-1020`); completion arrives only via the async `onTurnCompleted` notification
  (`adapter.ts:911-928`) with NO deadline — so a turn that never completes (for ANY reason) hangs unbounded
  with no user-visible error. This robustness gap is code-real and verifiable, but (i) it is orthogonal to the
  effort vocabulary, (ii) unbounded turns are a general/legitimate agentic property, (iii) freshell asserts no
  bounded-turn invariant anywhere (unlike DEV-0001's explicit `while (Date.now() < deadline)`), and adding a
  turn timeout could break legitimate long turns. Not an objective defect as-is, and not what was proposed.

- **objective_defect:** NONE ESTABLISHED. Fails every bar: no crash/error (a rejected effort would error, not
  hang), no leak, no WS-schema violation, no contradiction of documented behavior (the protocol schema +
  contract fixture document `none`/`minimal` as VALID), no data corruption, no code-asserted invariant broken.
  The only bar invoked — *hang* — is asserted from a single un-pinned live run and is refuted as to cause by
  `protocol.ts:26,233,312` and `real-session-contract-harness.ts:1121-1130`.
- **original_behavior:** freshcodex offers `none`/`minimal`/`max`, maps `max→xhigh`, and forwards
  `none`/`minimal` verbatim on `turn/start` (`adapter.ts:129-131,978`) as values its own protocol schema deems
  valid (`protocol.ts:26,312`). Claimed 180s silent stall on `minimal` is NOT reproduced/root-caused.
- **port_behavior:** UNCHANGED from the original until/unless the defect is proven. The port must reproduce the
  original's effort handling; it MUST NOT silently clamp `none`/`minimal` on the strength of this rejected claim.
- **fingerprint:** **NONE — this is not a whitelisted deviation.** The T2 codex differ must treat ANY
  original-vs-port divergence in effort handling (including `none`/`minimal` forwarding) as a **failure**, not a
  tolerated diff. No matcher is registered.
- **pinning_test:** N/A (rejected). See reconciliation conditions below for what a future *accepted* version
  would require.
- **adjudicated_by:** antagonist-reviewer session `0000000000000000-6ff6320fb70d4149_anchors-architect`
  (parent `1d2dea08-9a63-4ecf-bc4b-ee25a852a4d8`), 2026-07-04.
- **status:** rejected

**Reconciliation conditions to RE-OPEN (the burden is on the implementer):**
1. Resolve the contradiction with the committed contract: either (a) produce a captured, non-inference artifact
   (raw `turn/start` request + the app-server's response/behavior + that specific model's live
   `supportedReasoningEfforts`) showing the server does NOT accept `none`/`minimal` for the model in use — in
   which case the objective defect is a **schema/data mismatch** and the fix updates `CodexReasoningEffortSchema`
   / the model catalog (pinned by the real-codex **contract** test), NOT a blind effort clamp; OR (b) accept
   that the server DOES accept `none`/`minimal` (as `protocol.ts:26,233` and
   `real-session-contract-harness.ts:1121-1130` assert) — in which case there is no effort defect and the
   observed stall must be **re-pinned to its true cause** before any deviation is proposed (do not repeat the
   opencode-idle misdiagnosis).
2. Prove the failure mode: demonstrate the hang is caused by the effort value specifically (not setup/health
   races, not a slow/looping turn, not a dropped completion notification), with an artifact a deterministic test
   could assert against — otherwise it is not an objective *hang* attributable to effort.
3. Only after 1–2, a fresh candidate may be filed; harness pinning `effort='low'` for baseline capture remains
   acceptable test hygiene either way and needs no deviation.

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
