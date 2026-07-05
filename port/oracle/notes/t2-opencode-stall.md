# T2 opencode/Kimi stall — root-cause diagnosis (pristine original)

**Session:** `anchors-debugger` (parent `1d2dea08-…`) · **Date:** 2026-07-04
**Scope:** diagnosis only — NO rework, NO commit, NO source under `server/`/`shared/` touched.
**Live model calls used:** **2 / 2** (exp4, exp5b) — both `umans-ai-coding-plan/umans-kimi-k2.7`, tiny pinned prompt.
**Isolation:** every serve ran under an isolated `HOME`/`XDG_DATA_HOME` (mkdtemp); the
opencode.db read was always the isolated `<tmp>/.local/share/opencode/opencode.db`, never the
user's store. Every spawned pid was ownership-tagged and reaped by pid/sentinel. The user's live
server (**pid 1262455 / :3001**) and its opencode/codex sessions were verified alive & untouched
before and after every run.

---

## TL;DR

- The T2 `turnAccepted=false` stall has **ONE root cause**: the **cold-serve health probe is
  UN-timed** and wedges. **This IS DEV-0001**, and it is squarely **on the critical path** — *not*
  a red herring.
- `createSession` and DB persistence are **fine** (session row lands in ~2 ms once healthy).
- The harness's central premise — *"opencode's headless serve replies fast yet never flips to
  idle"* — is **FALSE / a misdiagnosis**. opencode **1.17.13 emits `session.idle` and
  `session.status{type:idle}`** ~5 s after the turn. The builder never observed idle because the
  health wedge stopped the turn from ever starting.
- **Proven end-to-end:** removing *only* the health race (a warm-proxy `OPENCODE_CMD`, **zero
  source mutation**) makes the **full turn complete through the pristine freshell surface** —
  `send-keys` returns `200 {status:"idle"}`, durable `ses_…` materializes, reply persists. ⇒ **No
  deeper stall exists.**
- **No second deviation is needed.** DEV-0001 is the sole objective defect on this path.

---

## The turn lifecycle (traced, with file:line)

`POST /api/tabs` → adapter `create()` registers a placeholder only, **no serve** (`adapter.ts:423-436`).
`POST /panes/:id/send-keys` (fresh-agent branch, `router.ts:1669-1755`) →
`freshAgentRuntimeManager.send()` → opencode adapter `send()` → **`materializeOrSend()`
(`adapter.ts:324-387`)**, which on the first turn:

1. `serveManager.createSession()` (`adapter.ts:340`) → `OpencodeServeManager.createSession`
   (`serve-manager.ts:337`) → `json()` → **`requireBase()` → `ensureStarted()` → `start()` →
   `await this.waitForHealth(...)` (`serve-manager.ts:232`)**  ← **STALL IS HERE**
2. `onceIdle(realId, …)` armed (`adapter.ts:356`) + `promptAsync()` (`adapter.ts:363`) ← the model call
3. `await idle` (`adapter.ts:368`) blocks until the serve reports idle; then emits `sdk.turn.complete`.

Because opencode's `send` blocks server-side until idle, `router.ts:1700` (`runSend`) does not
return until step 3 resolves; `router.ts:1715` (`waitForFreshAgentIdle`) then re-confirms idle.

---

## Evidence

### Exp1 ($0, direct-spawn, faithful `waitForHealth` copy)
Cold `opencode serve`, freshell's exact isolation recipe:
```
TCP accept at +2870ms ; serve logs "listening" at +3334ms
pristine UN-timed GET /global/health  → BLOCKED ≥90s (hit my 90s safety cap; pristine has NO cap)
bounded (2s-abort + retry) health      → healthy in ~30ms
createSession POST /session            → 200 ses_… in 532ms
opencode.db session row                → persisted +2ms
SUMMARY: pristineHealthy=false  createSessionId=ses_…  dbPersisted=true
```

### Exp2 ($0, mechanism)
Same cold serve, probes fired **after** the "listening" line: `node:http`, `fetch{Connection:close}`,
and `fetch{keep-alive}` **all return 200 in 25–33 ms**. ⇒ The hang is **not** client- or
keep-alive-specific; it is a **timing race**: a request that connects during the window between
*TCP-accept-available* and *HTTP-handler-ready* is **orphaned by opencode and never answered**. A
request that connects after readiness is instant.

Why freshell reliably hits it: `waitForHealth` starts probing immediately and the moment the port
stops refusing (i.e. the *start* of the orphan window) is exactly when its first probe connects —
and being **un-timed** it can never advance to the 150 ms retry (`serve-manager.ts:271-294`).

### Exp3 ($0, through the REAL freshell serve-manager)
Booted the real external server, `POST /api/tabs`, fired `send-keys` (not awaited):
```
freshell spawned opencode serve child: pid 484718 / port 33469
MY bounded /global/health on that child: attempt1 wedged (2002ms abort), attempts2-5 = 13/5/3/6ms  ← serve IS up & health-capable
freshell created NO ses_ session in 40s ; send-keys stayed "pending" ; model call reached = NO
teardown: strays=[]  remaining=[]  :3001 untouched
```
⇒ The serve is healthy-capable, yet **freshell is wedged on its own un-timed probe** → no
`createSession`, no durable session, **no model call**. This is `turnAccepted=false` reproduced,
localized to `waitForHealth`.

### Exp4 (LIVE #1, direct-spawn turn — the idle question)
Warm (bounded-health) serve, `createSession` + `prompt_async`, SSE `/global/event` + `/session/status`
captured:
```
prompt_async → 204 ; reply persisted (sentinel) +557ms
/session/status: ABSENT → busy(+4814) → ABSENT(+9682)
SSE session.status{type:busy} … then at +9525ms:  session.status{type:idle}  AND  session.idle
onceIdle WOULD resolve via SSE idle?            true
onceIdle WOULD resolve via status-poll (busy→idle/absent ×2)?  true
liveModelCalls=1
```
Raw idle frame shape (matches `serve-events.ts` parser exactly):
`{"payload":{"type":"session.status","properties":{"sessionID":"ses_…","status":{"type":"idle"}}}}`
⇒ **REFUTES "never emits idle."** Both `onceIdle` paths (`serve-manager.ts:507` SSE + `:471-496`
status-poll) fire. The adapter's completion detection is **correct**.

### Exp5a ($0) + Exp5b (LIVE #2, end-to-end through pristine freshell)
`OPENCODE_CMD` set to a **warm-proxy** that spawns the real `opencode serve` on an inner port,
bounded-waits for its health, then opens an L4 TCP proxy on freshell's port — so freshell's port only
accepts **after** the serve is HTTP-ready (the orphan window never exists). **No freshell source
changed.**

- Exp5a: the pristine **un-timed** `waitForHealth` against the proxied port now succeeds in ~4.15 s
  (fast `ECONNREFUSED` until the proxy opens, then 200 in 9 ms — **no wedge**).
- Exp5b (through the real fresh-agent surface, awaiting the blocking `send-keys`):
```
durable session in DB: ses_… at +5012ms                 → turnAccepted=TRUE
reply persisted (sentinel) at +5514ms (msgs=2 parts=1)  → turnCompleted=TRUE
send-keys RETURNED 200 body={...,"status":"idle"} at +10462ms  → onceIdle resolved through freshell
final DB: messages=2 parts=5 sentinel=true ; liveModelCalls=1
strays=[] remaining=[]  :3001 untouched
FULL TURN COMPLETED THROUGH PRISTINE FRESHELL (health-race removed only)? true
```
⇒ **DEV-0001 is the SOLE blocker.** With the race gone, the entire pristine path works.

---

## Findings, classified

| # | Finding | file:line | Classification |
|---|---|---|---|
| 1 | Un-timed `GET /global/health` in `waitForHealth` wedges on a cold serve; the un-timed loop can't retry, so `ensureStarted`→`createSession` never proceeds → `turnAccepted=false`. | `serve-manager.ts:286` (loop `:271-294`, throw `:297`) | **Genuine BUG (objective defect).** = **DEV-0001**, already ledgered. On the critical path. |
| 2 | `createSession` + opencode.db persistence work (532 ms create / 2 ms persist). | `serve-manager.ts:337-346`; `adapter.ts:340` | Not a defect. The "no session written" symptom is **downstream of #1**. |
| 3 | opencode 1.17.13 **does** emit `session.idle` + `session.status{idle}`; the adapter's `onceIdle` correctly resolves on either. | `serve-manager.ts:440-520`; `serve-events.ts:35-40,99-118` | **By-design / correct.** No defect. |
| 4 | Harness header + `serverReportedIdle` invariant assert opencode "never flips to idle" and build a fire-and-don't-await design around it. | `t2-live.ts:32-35,44-55,68-70`; `invariants.ts:279-291` | **HARNESS deficiency** (false premise). In `port/oracle/**`, not the baseline — fix in the harness, not the ledger. |
| 5 | freshell cannot be pointed at an existing serve — `OpencodeServeManager` always spawns its own on a fresh port; only `OPENCODE_CMD` overrides the *command*, there is no URL/port attach. | `serve-manager.ts:116,202-212`; ctor `server/index.ts:327` (no options) | Design fact (informs T2 strategy below). |

**Is DEV-0001 on the critical path or a red herring?** → **On the critical path. It is THE cause of
`turnAccepted=false`.** (And it does *not* mask a deeper stall — exp5b proves the full turn completes
once, and only, the race is removed.)

---

## Recommended minimal T2 strategy (against the pristine original)

1. **Boot strategy: warm, not cold.** Cold-start through pristine freshell genuinely wedges (that's
   the whole finding). Since freshell has no attach-to-existing-serve hook (#5), capture the
   original-side baseline by making freshell's spawned serve *warm-before-first-probe* via an
   **`OPENCODE_CMD` warm-proxy** harness aid (design proven in exp5a/5b: spawn real serve on an inner
   port, bounded-wait its health, then open an L4 passthrough on freshell's port; carries the run's
   ownership sentinel so it is reaped normally). This drives the **real fresh-agent surface**
   end-to-end (materialized event, `/capture`, blocking `send-keys` return) without mutating source.
   (Driving raw `opencode serve` directly, exp4-style, is a valid fallback but loses the freshell-surface coverage.)

2. **Turn-completion detection: use the IDLE edge, not the reply-poll workaround.** Detect completion
   via `session.idle` / `session.status{idle}` over SSE, with the `/session/status` busy→idle/absent
   poll as fallback — exactly what the adapter already does and what the product uses. Persisted-reply
   polling is fine as a *secondary* corroboration, but must not be the *primary* edge, and the
   `serverReportedIdle=false`/`provider.emits-idle-signal(expected false)` assertions must be
   **inverted to expect TRUE** (`invariants.ts:284-291`).

3. **Port side:** implement DEV-0001's fix (per the ledger: per-attempt `AbortController` ~2 s +
   retry until the outer `healthTimeoutMs`), which makes cold-start work natively through freshell.
   The port's T2Observation then diffs against the warm original baseline, with the DEV-0001
   fingerprint whitelisting *only* the cold-start-block difference.

4. **Second deviation?** **No.** DEV-0001 is the only objective defect on this path; the idle
   behavior and the adapter are correct. The remaining fixes are harness-side (`port/oracle/**`) and
   need no ledger entry.

---

## Warm-proxy design (reference; instrumentation itself removed)

`OPENCODE_CMD` = a shim invoked as `<shim> serve --hostname H --port P` that: (1) `freePort()` →
INNER; (2) `spawn(REAL_OPENCODE, ['serve','--hostname','127.0.0.1','--port',INNER])` inheriting env;
(3) bounded-poll `http://127.0.0.1:INNER/global/health` (2 s abort + 150 ms retry) until healthy;
(4) `net.createServer` on `P` L4-piping each socket to INNER; (5) SIGTERM → kill inner + close.
It inherits `FRESHELL_OPENCODE_SIDECAR_ID`/`FRESHELL_PROBE_SENTINEL`, so existing reapers cover it.
This is a **diagnostic proof aid only**, not the port's fix (the port fixes the probe itself).

## Safety ledger for this diagnosis
2 live calls total. All serves isolated (`HOME`/`XDG_DATA_HOME` = mkdtemp; opencode.db isolated).
0 orphaned pids after each run (verified by /proc sentinel scan). `server/` + `shared/` still
pristine (`git status` clean). :3001 / pid 1262455 verified alive & untouched throughout.
