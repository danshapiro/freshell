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
