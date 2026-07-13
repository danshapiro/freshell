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
- **pinning_test (SATISFIED — Phase 3.6, `crates/freshell-opencode/tests/serve_health_bounded.rs`, 3 tests
  RED→GREEN: never-resolving health settles-not-hangs + stall-then-succeed resolves + healthy stays fast):**
  port-side test that injects a health source whose
  `/global/health` never resolves, drives the readiness wait, and asserts it settles within the deadline
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

### DEV-BATCH-0001 — live node-ORIGINAL uppercases PTY output in THIS session — **RECLASSIFIED: ENVIRONMENT/RUNTIME ARTIFACT (→ ENV-0001), NOT A DEVIATION; case-fold oracle-weakening REJECTED**

> **✅ RESOLVED (2026-07-06, commit follows).** Root cause CONFIRMED = a stale/corrupt `dist/server`
> build (the one bundled at 21:40 during this session). A **clean rebuild** (`rm -rf dist/server && npm
> run build:server` from the still-pristine source) restored the live node-original to correct lowercase
> output. Re-running both live legs afterward: `t1-equivalence-rust` **10/10 byte-exact, 0 skips** and
> `t1-batch-equivalence-rust` **44/44 byte-exact, 0 skips** — the node original is now byte-identical to
> rust and to the committed goldens (`echo-hello` sha `cd2eca35…` on both sides). The detect-and-quarantine
> posture **self-extinguished exactly as designed** (full byte-exact strictness auto-returned the instant
> `original == golden`). Confirms the port was byte-for-byte correct throughout; the quarantine is retained
> as a self-arming safety net for any future env drift. Precise mechanism of the stale build's fold remains
> unknown but is moot (the artifact is gone; source pristine; :3001 untouched throughout).

**Antagonist adjudication (session `0000000000000000-cb72533e1e304bd5_anchors-architect`, parent
`1d2dea08-9a63-4ecf-bc4b-ee25a852a4d8`, 2026-07-05). Two rulings:**
1. **This is NOT a ledger deviation.** The ledger records objective defects in the ORIGINAL that the PORT
   faithfully-or-deliberately handles (see Entry rules, lines 8-14). This is neither: the **port is
   byte-for-byte CORRECT**, and the pristine source is NOT objectively defective — its own earlier goldens
   AND a direct node-pty spawn of the exact shell it uses are both lowercase. The fold is an artifact of the
   **live node-original process's runtime in this session only**. Kept here for traceability, reclassified as
   **ENV-0001** (environment / oracle-infra note, below). No source change, no port change, and — critically —
   **NO differ whitelist and NO tolerance**: the T1/batch differ must NEVER case-fold; any real port
   case/letter corruption must still fail.
2. **The implementer's `original.toUpperCase() === rust.toUpperCase()` oracle weakening is REJECTED.** A
   case-insensitive equivalence assertion masks real divergence — it would pass a port that mangled case,
   dropped an SGR `m`→`M`, or corrupted any letter — and violates this campaign's byte-exact oracle
   principle (the same "weaken the oracle so it passes" move rejected in DEV-0001). It is replaced by the
   **detect-and-quarantine** posture specified below: keep `rust ≡ committed golden` byte-exact and hard, and
   only SKIP the *live-original* cross-check leg (loudly, with reason) while the live original is provably the
   case-folded image of its own golden — auto-restoring full strictness the instant the environment recovers.

**What I independently verified (not taken on report):**
- **Reproduced live, right now**, via the pristine committed `t1-equivalence-rust.test.ts` (unmodified):
  RUST `echo-hello` = `hello\r\n` sha256 `cd2eca35…` = the committed golden (leg (a) GREEN); NODE original
  = `HELLO\r\n` sha256 `be947859…`. `seq-3` and `fixed-width-fill` (no lowercase) are node≡rust **exact**;
  `echo-hello`/`multi-line` (lowercase) diverge. The sole divergence is a **pure ASCII lowercase→uppercase
  fold — nothing else** (2 failed / 8 passed).
- **node-pty is NOT the cause.** A direct `node-pty` spawn (same shared binary, `node-pty@1.2.0-beta.11`,
  native `pty.node` mtime **2026-05-19** — not rebuilt today) of **`/bin/bash -l`** (exactly what
  `terminal-registry` spawns) AND of plain `/bin/bash` both return **lowercase** `hello`. node-pty and the
  login-shell/profile path are exonerated.
- **Not a source or bundle transform.** `git diff server/ shared/` is empty (source pristine); grepping the
  built `dist/server/**` finds `toUpperCase` only in unrelated label/key/drive/model-name code — none on the
  terminal-output byte path.
- **The port is provably correct off the live original entirely:** the deterministic
  `crates/freshell-terminal/tests/batch_wire_golden.rs` is **2/2 GREEN** (batch framing reproduces every
  committed golden byte-for-byte + the UTF-16 `endOffset` proof), and RUST≡committed-golden is GREEN on the
  live wire. Neither touches the compromised live original.
- The node original boots from `dist/server/index.js` (`external-server.ts:25`; `ensureNodeBundle` →
  `npm run build:server`), mtime **2026-07-05 21:40** (today) vs newest source **2026-07-04 20:13** — so the
  node original executes a bundle rebuilt today. **Honesty caveat:** that rebuilt bundle contains no output
  case-transform and node-pty's addon predates today, so the *precise trigger* of the fold (why this live
  server-runtime uppercases when a direct node-pty of the same shell does not) is **UNDETERMINED**. This does
  NOT change the classification — it is confined to the live node-original runtime and is neither the port
  nor an inherent source defect — but I will not assert the rebuild is the proven cause.

- **objective_defect:** NONE in the port or the pristine source. The "corrupts data" bar applies only to the
  *live node-original process in this session*, not to freshell's code ⇒ no ledger deviation.
- **original_behavior (pristine / durable):** case-correct lowercase (the committed goldens; a direct
  node-pty of `/bin/bash -l`). **Live node-original (this session only):** folds ASCII lowercase→uppercase on
  the PTY output byte stream, incl. inside ANSI (`\x1b[31m`→`\x1b[31M`).
- **port_behavior:** portable-pty preserves case; reproduces every committed `<name>.golden` and
  `<name>.batch.golden` byte-for-byte. **The port is CORRECT; nothing to change.**
- **fingerprint:** **NONE — not a whitelisted deviation.** The differ gets zero tolerance and must never
  case-fold. The environmental fault is handled by the oracle-test *quarantine* below, not by the differ.
- **pinning_proof (port correctness, env-independent):** `crates/freshell-terminal/tests/batch_wire_golden.rs`
  (2/2) + the `rust ≡ committed golden` legs of `t1-equivalence-rust.test.ts` /
  `t1-batch-equivalence-rust.test.ts`.
- **adjudicated_by:** antagonist-reviewer session `0000000000000000-cb72533e1e304bd5_anchors-architect`
  (parent `1d2dea08-9a63-4ecf-bc4b-ee25a852a4d8`), 2026-07-05.
- **status:** reclassified — environment/runtime artifact (ENV-0001); **not a deviation; case-fold
  oracle-weakening REJECTED.**

**EXACT oracle-test posture fix (to be applied by the IMPLEMENTER — I did NOT touch the harness/tests):**
Keep the durable proof HARD; quarantine only the *live-original* leg. For each scenario let `g` = committed
golden text, `o`/`r` = live-original / rust captures.
- **Always-hard, unchanged (the real proof — currently GREEN):** every `rust ≡ committed golden` assertion —
  `t1-equivalence-rust.test.ts` leg (a); `t1-batch-equivalence-rust.test.ts` legs (a)(b)(c)(d)(e)(f). No
  case-folding anywhere in these.
- **`t1-batch-equivalence-rust.test.ts`, the `(PRIZE)` block (lines 265-293):** DELETE the
  `o.toUpperCase() === r.toUpperCase()` assertions and gate instead:
  - if `o === g` → `expect(o).toBe(r)` **byte-exact** (full live equivalence);
  - else if `r === g` **and** `o === g.toUpperCase()` (the original is exactly the ASCII-uppercased image of
    the golden — the detected ENV-0001 signature) → **SKIP this leg loudly** via `ctx.skip()` (or
    `it.skipIf(...)`) with, e.g. `[T1-batch][PRIZE] live-original leg SKIPPED for "<name>": node-original
    ENV-0001 case-fold; rust proven ≡ committed golden. See DEVIATIONS.md ENV-0001.` — derive NO pass from
    `o`;
  - else → `expect(o).toBe(r)` (fails — a real, non-case divergence).
  Keep the `seq-3` exact tail assertion (line 292): it proves live original≡rust EXACTLY where the fold
  cannot manifest.
- **`t1-equivalence-rust.test.ts`, the `(b) THE PRIZE` block (lines 167-196), now RED on echo-hello +
  multi-line:** apply the identical guard — byte-exact `expect(origCap.goldenBytes).toEqual(rustCap.goldenBytes)`
  when `o === g`; **skip (b) with the ENV-0001 reason** when `r === g && o === g.toUpperCase()` (turning the
  2 RED into 2 flagged SKIPS) while leg (a) rust≡golden stays hard/green; any other diff still fails.
- **Why this is NOT a re-weakening:** `toUpperCase` here is used only as a *classifier* to RECOGNIZE the
  known fault signature and then SKIP — never as the equivalence *assertion* (contrast the rejected use,
  where it WAS the assertion). The skip is (i) NARROW — fires only when the original is the exact
  case-folded image of its own golden; (ii) LOUD — a reported skip/warn, never a silent green;
  (iii) SELF-EXTINGUISHING — the instant the live original returns lowercase, the guard falls through to the
  hard byte-exact `original ≡ rust` assertion automatically. `toUpperCase()===toUpperCase()` would instead
  permanently accept case-mangling forever. Full power to catch a genuine port case-defect is retained
  because `rust ≡ committed golden` stays byte-exact and hard.

**ENV-0001 — root-cause follow-up (NON-BLOCKING; does NOT gate landing the batch work).**
The batch-framing code and the corrected oracle posture may land now: the port is proven correct against the
durable goldens, a direct node-pty, and the deterministic crate golden — none of which involve the
compromised live original, so there is nothing in port/source that depends on the fold's mechanism. Deeper
root-cause is NOT required before landing, but MUST be tracked before the live `original ≡ rust` cross-check
is relied on again (it is a valuable belt-and-suspenders leg): (a) re-run after a clean
`npm run build:server` / fresh environment and re-capture; (b) if it persists, bisect the today-rebuilt
`dist/server` bundle vs a session/toolchain change and read the live server's pty master bytes directly;
(c) confirm whether a slave-visible termios flag (OLCUC/IUCLC/XCASE) or an above-line-discipline transform is
responsible (the builder's note reports all three flags OFF). Until resolved, the quarantine above keeps the
oracle honest.

**Blast radius (ruled): T1/batch live-original leg ONLY.** The fold is at the terminal PTY output byte
layer. T2 assistant invariants arrive via provider SDK/SSE/JSON-RPC + provider DB (not the terminal PTY) and
are structural booleans / a fixed sentinel token we send — a PTY case-fold cannot flip them, so T2 greens
stand (if any future T2 assertion ever compared literal lowercase text captured from a PTY, revisit — none
does today). T3 runs against the RUST server and asserts presence/output/layout, not exact terminal case; its
committed visual baselines stand. All EARLIER green T1/batch results stand — captured before this session's
regression from a healthy (lowercase) original; the durable proof (rust≡committed golden, re-verified now) is
independent of the live original's later drift. Only the live-original cross-check is temporarily quarantined,
and only for lowercase-bearing scenarios (`seq-3`/`fixed-width-fill` still match exactly, proving the wire
path itself is intact).

### DEV-0004 — updater's live GitHub update-check gets a 5s bounded timeout (original's fetch is unbounded)

- **objective_defect:** *breaks an invariant the code itself asserts* — same bar as DEV-0001's
  un-timed health probe. The original's `GET /api/version` handler resolves `updateCheck` via
  `server/updater/version-checker.ts`'s `checkForUpdate`, which calls the bare Node `fetch()`
  against `https://api.github.com/repos/danshapiro/freshell/releases/latest` with **no timeout,
  no `AbortController`, no bound of any kind**. A slow or hung GitHub API (or a captive-portal/
  DNS-blackhole network) therefore blocks that request indefinitely, and — because
  `/api/version` awaits it inline — hangs the whole `/api/version` response with it. This is the
  identical bounded-wait defect class DEV-0001 already accepted: an un-timed network fetch on a
  path the caller expects to complete, breaking any bounded-wait expectation and risking an
  indefinite hang under real-world network conditions.
- **original_behavior:** `checkForUpdate` issues one un-timed `fetch()` to the GitHub releases
  API; a slow/unreachable GitHub blocks the call (and `/api/version`) with no upper bound.
- **port_behavior:** `crates/freshell-server/src/updater.rs`'s `check_for_update_live` issues the
  same GitHub call via `reqwest`, with `.timeout(REQUEST_TIMEOUT)` where
  `REQUEST_TIMEOUT = Duration::from_secs(5)` (`updater.rs:33`). On timeout/any transport error the
  call degrades to the same `UpdateCheckResult` shape with a populated `error` string (never a
  panic, never a hang) instead of blocking `/api/version`. A successful result is cached for 10
  minutes, success-only (`UpdateChecker::check`, `updater.rs:171-193` — an errored check is never
  cached, so a transient failure is retried on the very next request, matching the original's
  `createCachedUpdateChecker`, `version-checker.ts:80-99`).
- **fingerprint:** REST-parity sweep, `version.happy`/`version.cookie-auth` rows — timing-only:
  the differ tolerates the port completing (bounded, ≤5s) where the original could in principle
  hang; the `updateCheck` VALUES themselves (`updateAvailable`/`currentVersion`/`latestVersion`/
  `releaseUrl`/`error`) are still compared byte-for-byte (this is R5's fix, not a value-masking
  deviation — `updateCheck` is already registered `opaque` in the sweep's normalization list for
  the live-network-data reason, unrelated to this timeout).
- **pinning_test:** `crates/freshell-server/src/updater.rs`'s `updater::tests` module — `request_timeout_is_bounded_at_five_seconds`
  (pins the bound itself, deterministic/network-free) plus
  `unreachable_host_degrades_to_error_field_not_panic` (asserts the degrade-to-`error`-field shape,
  never a panic/hang) and `cache_reuses_result_within_ttl_for_same_version` (the success-only
  cache). All three existed or were extended for this entry; verified present and passing.
- **adjudicated_by:** antagonist-reviewer session
  `0000000000000000-dc849de1bd584a39_self-driving-reviewer`, 2026-07-11.
- **status:** accepted.

### DEV-0005 — WSL-hosted `cmd` shell pane strands the user in `C:\Windows` instead of the requested workspace cwd

- **objective_defect:** *errors* (primary bar — per adjudication condition 1): the original
  deterministically prints TWO error banners on every WSL-hosted cmd pane launch with a valid `/mnt`
  workspace cwd, and lands the user in the wrong directory. Secondary corroboration only: *breaks an
  invariant the code itself asserts* — the reference's cmd branch exists specifically to land the shell
  in the requested directory (on WSL it passes `cwd: undefined` to node-pty and injects `cd /d <winCwd>`
  into the `/K` command, `server/terminal-registry.ts:1177-1199`, comment "Use /K with cd command to
  change to Windows directory"). At runtime BOTH halves of that mechanism fail deterministically on a
  real WSL host:
  1. cmd.exe inherits the server's Linux cwd as a `\\wsl.localhost\...` UNC path → *"CMD.EXE was started
     with the above path as the current directory. UNC paths are not supported. Defaulting to Windows
     directory."*
  2. The injected `cd /d "<winCwd>"` is destroyed by WSL-interop argv→Windows-cmdline conversion (every
     embedded `"` from `quoteCmdArg`, `terminal-registry.ts:1014-1044`, arrives escaped as `\"`), and
     cmd's builtin `cd` rejects it → *"The filename, directory name, or volume label syntax is
     incorrect."* The shell is stranded in `C:\Windows`.
  Evidence: reproduced 3/3 against the freshly-booted pristine original (17871) with a valid, existing
  DrvFs workspace `/mnt/c/Users/Public/freshell-matrix-ws-*` — `port/oracle/matrix/notes-orig-cmd-fallback.md`
  (OCR transcript of `recheck-orig-cmd-1-cmd.png` shows both error banners + the `C:\Windows>` prompt).
  PowerShell is unaffected (its `Set-Location -LiteralPath '<path>'` uses single quotes that survive
  interop) — matching the matrix (original powershell PASS).
- **original_behavior:** A `terminal.create {shell:'cmd'}` with a valid `/mnt/<drive>/...` cwd on a
  WSL-hosted server opens cmd.exe in `C:\Windows` (after printing the two error banners), silently
  discarding the requested workspace directory.
- **port_behavior:** `wsl_windows_shell_inherit_cwd` (`crates/freshell-platform/src/spawn.rs:709-739`,
  in-code flagged "PORT FIX (deliberate, reported divergence)"): the port hands the child PTY a valid
  Linux mount cwd (`/mnt/<d>/...`) that WSL interop maps to the intended Windows directory — no UNC
  inheritance, no in-command `cd`. Gated on the mount actually existing (`FileProbe`), so a missing
  mount falls back to the faithful in-command mechanism. The cmd pane lands in the requested workspace.
- **fingerprint:** Matrix §7.E, `cmd` pane-kind cell on WSL-hosted servers only: differ tolerates
  original={cwd falls back to `C:\Windows`} vs port={cwd lands in the requested workspace}. Marker
  echo and every other cmd-cell assertion (creation, output round-trip, screenshot) must still match.
  No tolerance for the native-Windows-hosted server (17873): no interop layer there; both systems must
  land in the workspace.
- **pinning_test:** `crates/freshell-platform/tests/spawn_tests.rs` —
  `wsl_cmd_inherits_mount_cwd_when_present` (probe WITH the mount ⇒ spec carries the `/mnt` cwd and
  bare `/K`), `wsl_cmd_no_cwd_inherits_mnt_c_root_when_present`, and
  `wsl_cmd_falls_back_to_in_command_cd_when_mount_absent` (probe WITHOUT ⇒ the faithful
  `['/K','cd /d ...']` golden preserved) — pre-existing since the PORT FIX landed (4e148667 class).
  Live proof: matrix cmd cells (`sbp9-wsl-chrome-report.json`, `sbp9-win-chrome-report.json` PASS
  in-workspace) vs 3/3 original fallback re-drives (`recheck-orig-cmd-{1,2,3}-report.json`).
- **adjudicated_by:** council panel (intent-keeper, cranky-old-sam, crusty-old-engineer, user-advocate,
  tester-breaker; restless-old-brian unavailable — bundle not installed, gap disclosed), forked session
  `5b30a1942db44dc0-ccb27c93a63b41eb_self`, 2026-07-11. Verdict: **ACCEPT-WITH-CONDITIONS** — (A) objective
  defect: YES on the "errors" bar (primary) + code-asserted-intent (secondary); (B) proper DELIBERATE_FIX,
  not scope creep; (C) fingerprint appropriately narrow; (D) pinning tests directionally sufficient with
  named gaps. All 5 conditions SATISFIED same-day: (1) objective_defect reordered to lead with the errors
  bar; (2) fields closed (this entry); (3) is-dir gate — `FileProbe::is_dir` + `wsl_windows_shell_inherit_cwd`
  gates on it + `wsl_{cmd,powershell}_falls_back_when_mount_exists_as_a_file` tests; (4) TOCTOU guard —
  `PtyTerminal::spawn` degrades to a cwd-less spawn (logged) when the cwd spawn fails, never a raw error
  the original couldn't produce; (5) host-gated live integration tests
  `crates/freshell-terminal/tests/wsl_interop_live.rs` (`#[ignore]`, run green on this host — see commit).
- **status:** accepted


### DEV-0006 — codex terminal panes launch WITHOUT the `--remote <wsUrl> -c features.apps=false` pair (spec cli-argv-fidelity.md rev 2.1 §5 U2)
- objective_defect: none in the original — this is a PORT-SIDE reduced-scope deviation, pre-committed by the spec itself ("must be tracked as a deviation, not silently shipped", §5 U2).
- original_behavior: every live `terminal.create {mode:'codex'}` plans a codex app-server launch (`planCodexLaunch`, ws-handler.ts:934-943, 2474-2492) and emits `["--remote", "<ws://127.0.0.1:...>", "-c", "features.apps=false"]` as the first four codex argv tokens (live capture 2026-07-13, `~/freshell-scratch-006/orig-codex.json`: `[codex, --remote, ws://127.0.0.1:40781, -c, features.apps=false, -c, tui.notification_method=bel, ...]`).
- port_behavior: identical argv EXCEPT those four tokens are absent (`~/freshell-scratch-006/rust-codex.json`) — the codex TUI runs **unmanaged**: no app-server attach, and `features.apps` remains at the CLI default instead of being forced off. The rest of the argv (tui notification pair, inline MCP TOML) is byte-identical to the original.
- gating_site: `crates/freshell-ws/src/terminal.rs` (`codex_remote_ws_url: Option<String> = None`, comment references this entry). The resolver itself is argv-complete for `--remote` (goldens G-X1/G-X2/G-W2 in `crates/freshell-platform/src/cli_launch_goldens.rs` pass); only the terminal.create wiring to the `freshell-codex` launch plan is missing.
- pinning_test: `g_x0_codex_shipped_deviation_shape_dev_0006` (`cli_launch_goldens.rs`) pins the shipped gap-shape byte-for-byte so a refactor cannot half-emit the pair unnoticed (council condition 6).
- closure: wiring `freshell-codex`'s app-server launch plan into `terminal.create` — `port/machine/specs/coding-cli.md` (sidecar-lifecycle scope) remaining-work; owner: port campaign orchestrator (self-driving queue).
- user_facing_disclosure: to be carried in the EQUIVALENCE-REPORT known-limitations addendum (task-009): "codex panes in the Rust build run standalone, without freshell's managed app-server integration."
- adjudicated_by: /council fork, session e1b497f11d874275-50ff1d609ef44de9_self, 2026-07-13 — APPROVE (conditional, all conditions above incorporated). Implementer: restart #12 orchestrator (distinct from adjudicating panel).
- status: accepted (open gap, tracked for closure)

### U1-RATIFICATION — injected MCP server command adopts option (a): the reference's own Node repo layout (spec cli-argv-fidelity.md rev 2.1 §5 U1)
- decision: option (a) — resolve the SAME Node repo layout the reference resolves and inject `node --import <root>/node_modules/tsx/dist/loader.mjs <root>/server/mcp/server.ts` (dev) / `<root>/dist/server/mcp/server.js` (`NODE_ENV=production` + built). Rejected: (b) new Rust MCP server binary (bigger lift, out of task scope), (c) omit injection behind a flag (breaks live fidelity now).
- known_divergence (kept visible, not "no divergence"): reference walks up from its own module dir (`server/mcp/` __dirname) with fallback `__dirname/../..`; Rust walks up (max 5) from process CWD with fallback to the start dir (`crates/freshell-platform/src/mcp_inject.rs::find_repo_root`). Identical result whenever the server runs from inside the freshell checkout (the deployment under test); divergent only when the Rust server's cwd is outside any freshell repo — then the injected repo paths are bogus (MCP server fails to start inside the CLI; the CLI pane itself still works), same failure class as the reference run from a relocated build. tsx unresolvable raises the reference-exact error (pinned: `real_runtime_tsx_unresolvable_raises_reference_error`).
- evidence: 2026-07-13 live differential — claude/codex/opencode child argv byte-identical (modulo terminalId/uuid/port) between original 17871 and rust 17872, incl. MCP args (`~/freshell-scratch-006/*-{claude,codex,opencode}.json`, `oc-probe.mjs` lifecycle probe: config merge + $schema race + refcount + cleanup identical).
- seam: goldens inject `McpRuntime::server_command_args` so this ratification is revisitable (e.g. future Rust MCP server) without invalidating golden coverage.
- adjudicated_by: /council fork, session e1b497f11d874275-50ff1d609ef44de9_self, 2026-07-13 — APPROVE.
- status: accepted

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
