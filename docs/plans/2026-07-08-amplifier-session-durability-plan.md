# Amplifier Session Durability — Final Remediation Plan

**Date:** 2026-07-08
**Status:** FINAL — approved for implementation (Phase 0 complete)
**Supersedes:** the 2026-07-05 amplifier title/recency fix pass (kept) and the draft remediation plan (revised here)

---

## 1. Context

Amplifier is the only coding-CLI provider in freshell with **none** of the codebase's three proven durability patterns:

1. **No provider-native end-of-turn signal.** Claude has the Stop-hook BEL; codex has the app-server protocol; opencode has its event stream. Amplifier's turn lifecycle is *inferred from PTY output timing*: 2s of output silence after Enter = "turn complete" (`server/coding-cli/amplifier-activity-tracker.ts:13`), with a 120s deadman that **fabricates** `turn.complete` events (`amplifier-activity-tracker.ts:8,210-235`). Slow tool calls → false idle; spinners → stuck busy.
2. **No launcher-assigned session ID.** PTY↔session association relies on the cwd + 30s-recency + single-candidate heuristic (`server/session-association-coordinator.ts:58-78`, `ASSOCIATION_MAX_AGE_MS` at `server/index.ts:166`). Two launches in the same cwd = permanent ambiguity — the exact failure class from the OpenCode ownership RCA (`docs/plans/2026-05-09-fix-opencode-ambiguous-ownership.md`), where zero of 21 affected terminals ever recovered.
3. **Assorted mtime/byte-sniffing fragilities** in the indexer path (bounded but heuristic).

**The core finding from research:** Amplifier already ships a durable signal freshell ignores. Every session writes a **schema-versioned** event log — `~/.amplifier/projects/<slug>/sessions/<id>/events.jsonl`, schema `amplifier.log` ver `1.0.0` — carrying `session:start`, `session:config`, `prompt:submit`, `prompt:complete`, `session:resume`, `session:end`, with `session_id` on every record. This plan replaces the timing heuristics with that contract, reusing freshell's existing cross-provider plumbing wherever it exists (a hard requirement — the DRY survey confirmed the WS broadcast pipe, association coordinator/controller pattern, and watcher stack are all generic and reusable).

MCP availability is **not** assumed anywhere in this plan; everything reads Amplifier's on-disk contract. `amplifierd` (localhost REST/SSE daemon) exists upstream but is optional, immature, and not required.

---

## 2. Phase 0 findings (settled contract facts)

Phase 0 (live experiments against `amplifier 2026.07.06-7ec5dcd`, core 1.6.0, driven by a real-PTY harness) is **DONE**. These are now treated as contract facts, not hypotheses. Raw captures live at `/tmp/amp-p0/` and `~/.amplifier/projects/-tmp-amp-p0-*/`; they must be converted into checked-in test fixtures during Phase 1 (`test/fixtures/coding-cli/amplifier/events/`).

| # | Finding | Consequence for design |
|---|---------|------------------------|
| E1/E8 | **Session dirs are created LAZILY** — dir + `events.jsonl` appear ~37ms after the **first prompt submit**, not at process spawn. An idle REPL has *nothing* on disk. Dir birth order tracks first-prompt order and can invert spawn order. | The locator correlates **PTY Enter-press ↔ new session dir**, not spawn ↔ dir. The watch must persist until first submit (or terminal exit), not any fixed window. An idle never-prompted terminal has no session to bind — **that is correct behavior, not a failure**. |
| E4 | `session:start` carries only `parent_id`. The **`session:config`** record (~10ms later) carries `data.raw.project_dir` / `working_dir` / `project_slug`. `metadata.json` appears only at first `prompt:complete` (~seconds later). | Use `session:config` for cwd confirmation. `metadata.json` demotes to a later consistency check. |
| E2/E3 | **`prompt:complete` is the single turn boundary.** Exactly one `execution:start`/`execution:end` pair per turn; tool loops are `provider:request` iterations *inside* it. But background session-naming `llm:request` / `provider:retry` events fire **after** `prompt:complete`. | Reducer must never interpret post-complete events as a new turn. **Only `prompt:submit` re-enters busy.** |
| E5 | **Ctrl+C writes NO events** and (via scripted PTY) cancels nothing. Mid-turn typing becomes queued steering (`orchestrator:steering_injected`) within the **same** turn — one `prompt:submit`/`prompt:complete` pair. Empty-Enter at idle writes zero events. | Enter-presses during busy must NOT re-arm anything. Keep the submit-grace reversion (provisional busy reverts if no `prompt:submit` record follows). PTY exit remains the authoritative end. |
| E3 (surprise 6) | `events.jsonl` is **not strictly time-ordered near shutdown**. | Reducer is a state machine keyed on **event type**, never on timestamps. |
| E6 | `kill -9` before first `prompt:complete` leaves a dir containing **only `events.jsonl`** — `metadata.json` never appears. | Indexer policy needed for metadata-less dirs (§7). They are not resumable. |
| E7 | PTY hangup lets amplifier finish the turn and write `session:end`. `continue`-attach-then-quit writes `session:end` with **no matching start/resume in that pass**. `resume` appends `session:resume` to the **same file**. | Reducer tolerates unbalanced lifecycle records. Tailer attaches at EOF for resume (confirmed correct design). |
| E9 | **No `--session-id` flag exists** anywhere. `session list --format json` truncates IDs even in JSON mode. | Both refutations are hard facts. Keep the upstream asks (§12); do not design around features that don't exist. |
| E10 | All 208 observed records were schema `amplifier.log` / `1.0.0`. | Schema-version gate: accept major version 1; anything else → degraded lane + single warn. |
| — | Sub-session dirs contain only `events.jsonl`, have `_` in the dir name, and `session:fork`/`parent_id` marks forks. | Locator ignores underscore-named dirs AND applies the same `isSubagent` guard the coordinator uses (`session-association-coordinator.ts:90`). |
| — | Observed volume ~450KB `events.jsonl` per turn, dominated by `content_block:*` / `tool:pre/post` noise; `llm:request` embeds full raw payloads. Append-only; no rotation observed. | Tailer must be offset-based/incremental, filter before parse, and never re-read. |

---

## 3. Goals / Non-Goals

**Goals**

1. Turn lifecycle (busy/idle, `turn.complete`) driven by Amplifier's own `events.jsonl` lifecycle records — no fabricated completions.
2. Deterministic PTY↔session association for fresh amplifier sessions via first-prompt correlation, terminating in the shared bind/broadcast path.
3. Keep the current timing heuristic **verbatim** as a degraded lane (pre-first-prompt, tailer failure, schema mismatch). No new `unknown` phase — the public phase model stays `'idle' | 'busy'`.
4. Zero churn in downstream consumers: `amplifier-activity-wiring.ts`, `ws-handler.ts`, `amplifierActivitySlice`, `pane-activity.ts` untouched. No new WS message family.
5. Consolidate the byte-for-byte quadruplicated turn-completion machinery across all four trackers.

**Non-Goals**

- No dependency on `amplifierd`, MCP, or any network endpoint.
- No parsing of `content_block:*` / `tool:pre/post` noise for streaming/rendering (out of scope).
- No changes to codex/opencode/claude association behavior (only mechanical ledger extraction in Phase 4).
- No attempt to pre-assign session IDs (E9: impossible today; upstream ask filed).

---

## 4. Target architecture

| Concern | Today (heuristic) | Target (durable) | Reused infrastructure |
|---|---|---|---|
| Turn end | 2s PTY output-silence debounce; 120s deadman **fabricates** completion (`amplifier-activity-tracker.ts:150-235`) | `prompt:complete` record from `events.jsonl` (events lane); timing heuristic verbatim as degraded lane; deadman repurposed as missed-signal force-read failsafe | Existing tracker public surface → `amplifier-activity-wiring.ts` → `index.ts:554-562` → `wsHandler.broadcastTerminalTurnComplete` (`ws-handler.ts:3814`, schema `shared/ws-protocol.ts:189`) — all unchanged |
| Turn start | PTY Enter (`noteInput` + `isSubmitInput`) | `prompt:submit` record; PTY Enter kept as provisional busy with grace reversion | Same |
| PTY↔session bind (fresh) | cwd + 30s recency + single-candidate (`session-association-coordinator.ts:58-78`) | Enter-press ↔ new-dir correlation + `session:config` cwd confirm, via a controller into `registry.bindSession(...)` + `broadcastTerminalSessionAssociation(...)` | `OpencodeSessionController` pattern (`opencode-session-controller.ts`), `session-association-broadcast.ts`, coordinator slow-path kept as fallback |
| PTY↔session bind (resume) | `resumeSessionId` at spawn (works) | Unchanged; tailer attaches at EOF of existing `events.jsonl` | `terminal.session.bound` event (already handled in wiring:47-55) |
| Fast path | Claude-only (`index.ts:916`) | Accept `'amplifier'` too (~5 lines) — free latency win and safety net | `associationCoordinator.noteSession/associateSingleSession` already handles amplifier correctly (watermarks, ambiguity, `isSubagent` guards) |
| Events file location | n/a (ignored) | `getLiveEventsPath?(filePath)` provider capability, next to `getActivityMtimeMs` (`provider.ts:30`, `providers/amplifier.ts:183` already encodes the sidecar layout) | `CodingCliProvider` optional-capability pattern |
| Reducer testability | n/a | Pure reducer, fixture-driven | Imitates `opencode-ownership-reducer.ts` |
| Watcher hygiene | n/a | One shared chokidar watcher for the locator | `session-indexer.ts` conventions: `ignoreInitial: true` (:501), nearest-existing-ancestor for missing dirs, unref'd timers, `close().catch(() => {})` (:537) |

**New modules (the only genuinely new code):**

```
server/coding-cli/amplifier-events-reducer.ts      # PURE: (state, record) -> (state, effects[])
server/coding-cli/amplifier-events-tailer.ts       # offset-based incremental reader, injected fsImpl
server/coding-cli/amplifier-session-locator.ts     # shared watcher + Enter↔dir correlation
server/coding-cli/amplifier-session-controller.ts  # thin bind gatekeeper (imitates OpencodeSessionController)
server/coding-cli/amplifier-activity-integration.ts # composition root (imitates opencode-activity-integration.ts)
server/coding-cli/turn-completion-ledger.ts        # Phase 4 consolidation
```

---

## 5. Association protocol (fresh sessions)

**Invariant:** all bindings flow through `registry.bindSession(terminalId, 'amplifier', sessionId, 'association')` and `broadcastTerminalSessionAssociation({ source: 'amplifier_locator' })`. Never hand-roll binding or broadcasts. (`AssociationBroadcastSource` union at `session-association-broadcast.ts:9` gains `'amplifier_locator'` and `'amplifier_new_session'`.)

**Protocol** (one shared `AmplifierSessionLocator` service; its single chokidar watcher runs only while ≥1 unbound amplifier terminal exists):

1. **Arm at spawn.** When an amplifier-mode terminal starts *without* `resumeSessionId`, register it with the locator: `{ terminalId, cwd, spawnedAt }`. Take a **pre-spawn snapshot** of existing top-level session dirs (no `_` in name) under `<amplifierHome>/projects/` to define "new". Watch `projects/` (nearest existing ancestor if absent — the sessions root itself is created lazily, E1).
2. **Watch until first submit or exit.** The 60s window from the draft is **wrong** (E1): an unprompted REPL writes nothing, ever. The watch persists until the terminal's first submit produces a binding, or the terminal exits. Cost: one watcher total, entries per unbound terminal. **An idle never-prompted terminal simply has no session to bind — correct behavior.**
3. **Correlate on Enter.** On PTY submit (`isSubmitInput`) for a registered terminal at time *t*, open a correlation window `[t, t + AMPLIFIER_DIR_APPEAR_WINDOW_MS]` (constant = 2_000ms; observed latency 37ms, E1). A **candidate** is a new top-level dir, not in the snapshot, no `_` in name, whose `events.jsonl` opens with `session:start` **without** `parent_id` (isSubagent guard, matching `session-association-coordinator.ts:90`).
4. **Confirm cwd via `session:config`** (E4): read the record's `data.raw.project_dir`/`working_dir` and require match with the terminal's cwd (realpath-normalized). Do **not** wait for `metadata.json`; do **not** guess project slugs. `metadata.json`, when it appears, is a consistency check only (mismatch → log warn, keep binding).
5. **Resolve.** Exactly one candidate matching cwd → hand to `AmplifierSessionController`, which validates the terminal (exists, `mode === 'amplifier'`, `status === 'running'` — mirroring `opencode-session-controller.ts:85-101`), then binds + broadcasts. Multiple candidates matching the same terminal's cwd within the window → **refuse** (log `amplifier_locator_ambiguous`), leave it to the coordinator slow-path. Zero candidates → keep watching (the submit may have been empty-Enter, which writes nothing, E5).
6. **Post-bind:** locator unregisters the terminal, tracker `bindSession` fires via the existing `terminal.session.bound` path, and the tailer attaches to `<dir>/events.jsonl` at offset 0 (fresh) — events lane activates.
7. **Resume path:** unchanged; the integration attaches the tailer at **EOF** of the existing `events.jsonl` (E7 confirms `session:resume` appends to the same file) using `provider.getLiveEventsPath(metadataPath)`.
8. **Fast path extension:** `index.ts:916` changes from `if (session.provider !== 'claude') return` to accept `'amplifier'` as well (broadcast `source: 'amplifier_new_session'`). This is a safety net that fires when `metadata.json` lands (first `prompt:complete`) if the locator somehow missed; the coordinator's watermark/ambiguity/`isSubagent` guards already handle amplifier correctly.

---

## 6. Tracker state machine

> **2026-07-08:** feature flag and degraded timing lane removed by maintainer
> decision — single code path; sessions without events.jsonl get no busy/turn
> signal. This supersedes §3 goal 3 and every "lane"/flag mention elsewhere in
> this plan (kept below only as historical record of the original design).

`AmplifierActivityTracker`'s **public surface is frozen**: `list` / `getActivity` / `listLatestCompletions` / `trackTerminal` / `bindSession` / `noteInput` / `noteOutput` / `noteExit` / `expire` / `dispose` + `'changed'` / `'turn.complete'` / `'events.force-read'` events, public phase `'idle' | 'busy'`. The integration module feeds it via `applyLifecycle(terminalId, reducedEffect)` and `noteEventsSignalLost(terminalId)`. Downstream (`amplifier-activity-wiring.ts`, `ws-handler`, `amplifierActivitySlice`, `pane-activity.ts`) is untouched; no new WS message family.

### Per-terminal state

```
phase:         'idle' | 'busy'            // public
submitGrace:   timer | undefined          // provisional busy awaiting prompt:submit
busyConfirmed: boolean                    // prompt:submit record confirmed the busy phase
lastObservedAt                            // feeds the deadman force-read failsafe
```

### Single events-driven path (no lanes)

There is exactly one state machine. `prompt:submit` / `prompt:complete` /
`session:end` records from `events.jsonl` are the only turn boundaries. PTY
Enter is only a provisional busy (submit-grace with one force-read retry, then
a silent revert); PTY output only refreshes liveness; PTY exit removes state.

**Signal-loss policy:** when the tailer degrades (schema mismatch — the
`amplifier.log` major-version-1 gate, E10 — file reset, persistent read
errors, attach failure) or detaches, there is **no fallback to timing
heuristics**. The terminal's phase reverts to idle silently (no
`turn.complete`), the single structured `amplifier_events_lane_degraded` warn
is logged, and tracking stops: from then on the terminal only ever shows the
2s provisional-busy pulses from submit-grace. The same holds for terminals
whose session never produces an `events.jsonl` (bundle without the
hooks-logging module): they simply never get confirmed busy or
`turn.complete` — acceptable, documented behavior.

### Events (inputs) and transitions

| Current | Input | Next | Effects / notes |
|---|---|---|---|
| idle | PTY submit (`noteInput`) | busy (provisional) | Arm `submitGrace` (= `AMPLIFIER_SUBMIT_GRACE_MS`, 2_000ms). Empty-Enter writes zero events (E5), so: |
| busy (provisional) | `submitGrace` expiry, no `prompt:submit` seen | idle | **Silent reversion** — no `turn.complete`. Validated by E5; keep. |
| any | `prompt:submit` record | busy (confirmed) | Clear `submitGrace`. **The only input that (re)enters busy.** |
| busy | `prompt:complete` record | idle | Emit exactly one `turn.complete` (via ledger). **The single turn boundary** (E2/E3). |
| idle | post-complete `llm:request` / `provider:retry` / any non-`prompt:submit` record | idle | Ignored — background session-naming fires after completion (E2). Never a new turn. |
| busy | PTY submit | busy | **No re-arm of anything** — mid-turn typing is queued steering within the same turn (E5). `orchestrator:steering_injected` is informational only. |
| busy | PTY output (`noteOutput`) | busy | Updates `lastObservedAt` only. Idle-debounce timer is **never armed** in events lane. |
| busy | `session:end` record | idle | Emit `turn.complete` (turn ended by quit/hangup; E7 shows amplifier finishes the turn on PTY hangup). Tolerate `session:end` with no matching start/resume (E7 continue-attach case). |
| any | `session:resume` record | idle (no change) | Resume does not imply busy. Same-file append; tailer already at EOF. |
| any | PTY Ctrl+C | (no change) | Writes no events, cancels nothing (E5). Not a lifecycle input. |
| any | `noteExit` (PTY exit) | state removed | **PTY exit is the authoritative end** — unconditional, both lanes. Tailer for that terminal is closed by the integration. |
| busy | deadman sweep (`expire`, silent ≥120s in file growth AND PTY output) | (see effect) | **Missed-signal failsafe ONLY:** trigger a **force-read** of the tail (stat + manual incremental read — the WSL2 inotify backstop; we run on WSL2 where inotify on 9p/drvfs paths can silently drop). If the read surfaces `prompt:complete`/`session:end` → process normally. If not → **stay busy** (genuine long turn) and log once. **Never fabricates a completion.** |
| any | tailer error / schema mismatch / file reset (size < offset) / detach | idle (silent) | Signal loss (`noteEventsSignalLost`): single warn (`amplifier_events_lane_degraded`, with reason), phase → idle with **no** `turn.complete`, tracking stops. No timing fallback. |

**Out-of-order tolerance (E3):** the reducer keys transitions on event **type** only; timestamps are carried through for `updatedAt`/`at` fields but never used to order or gate transitions. Unbalanced records (orphan `session:end`, missing `session:start` on continue-attach) are legal inputs.

**Reducer purity:** `amplifier-events-reducer.ts` is a pure function `(ReducerState, ParsedRecord) → { state, effects }` with effects like `{ kind: 'turn.began' } | { kind: 'turn.completed' } | { kind: 'session.identified', sessionId, cwd } | { kind: 'lane.degrade', reason }` — imitating `opencode-ownership-reducer.ts` so the entire E1–E10 catalog becomes a fixture-driven unit test suite.

**Tailer contract** (`amplifier-events-tailer.ts`): remembers a byte offset per file; on watcher change (or force-read), reads only appended bytes; buffers a partial trailing line until completed; cheap substring pre-filter (`'"event":"session:'`, `'"event":"prompt:'`, `'"event":"execution:'`, `'"event":"orchestrator:steering'`) before `JSON.parse` so ~450KB/turn of `content_block:*`/`tool:*` noise (Phase 0 observation) is skipped without parsing; validates the schema header once per file; injected `fsImpl` for tests (à la `codex-app-server/durability-proof.ts`); `size < offset` ⇒ treat as file reset → `lane.degrade` (rotation was never observed, but we refuse to guess).

---

## 7. Provider capability and indexer policy

**Provider capability** — add to `CodingCliProvider` (`server/coding-cli/provider.ts`, next to `getActivityMtimeMs?` at :30):

```ts
/** Absolute path of the live lifecycle event log sibling to the given canonical
 *  session file, if this provider maintains one. Enables event-driven activity
 *  tracking without hardcoding sidecar layouts outside the provider. */
getLiveEventsPath?(filePath: string): string | undefined
```

`providers/amplifier.ts` implements it as `path.join(path.dirname(filePath), 'events.jsonl')` — the same sidecar knowledge `getActivityMtimeMs` (:183-201) already encodes. The tracker/integration never hardcode paths; the locator (which discovers dirs before `metadata.json` exists) constructs the path from the discovered dir, which is inherently amplifier-layout-aware and lives in the amplifier-specific locator module — acceptable.

**Indexer policy for metadata-less dirs (E6):** dirs containing only `events.jsonl` (kill -9 before first `prompt:complete`) never gain `metadata.json` and are **not resumable**. Policy: **the indexer skips them** — which is already the emergent behavior, since discovery keys on `metadata.json` (`providers/amplifier.ts:168-170,203-210`). We now make that explicit and intentional (comment in the provider + test). Live visibility while such a session is running comes from the *activity* pipeline instead: the locator binds the sessionId to the live terminal, so busy/idle and turn-complete work from first submit; the sidebar entry appears naturally when `metadata.json` lands at first `prompt:complete`. If the process dies before that, the dir is dead weight and correctly invisible.

**Feature flag:** removed 2026-07-08 (maintainer decision — see §6 note). The events tracking, the locator/controller, and the fast-path extension are unconditional; there is no `FRESHELL_AMPLIFIER_EVENTS_TRACKING` environment variable and no degraded timing lane to revert to.

---

## 8. File-level change list

**New**

| File | Contents |
|---|---|
| `server/coding-cli/amplifier-events-reducer.ts` | Pure reducer: state machine of §6, schema gate, effect emission |
| `server/coding-cli/amplifier-events-tailer.ts` | Offset-based incremental reader; injected `fsImpl`; pre-filter; force-read entry point |
| `server/coding-cli/amplifier-session-locator.ts` | Shared chokidar watcher (session-indexer hygiene), pre-spawn snapshots, Enter↔dir correlation, `session:config` cwd confirm, underscore/`parent_id` guards |
| `server/coding-cli/amplifier-session-controller.ts` | Validates terminal (mode/status), calls `registry.bindSession`, emits `associated`; imitates `opencode-session-controller.ts` |
| `server/coding-cli/amplifier-activity-integration.ts` | Composition: tracker + tailer + locator + controller lifecycles; attaches tailer on bind (fresh: offset 0 with catch-up state-sync; resume: EOF); per-terminal attach serialization; closes on exit |
| `server/coding-cli/turn-completion-ledger.ts` | Phase 4: extracted `completionSeqByTerminalId` + `latestCompletions` + `recordTurnCompletion` + `listLatestCompletions` |
| `server/coding-cli/activity-wiring-factory.ts` | Phase 4 wiring unification: shared `wirePtyActivityTracker` (registry→tracker PTY-signal plumbing), parameterized by mode, sweep interval, and tracker disposal |

**Modified**

| File | Change |
|---|---|
| `server/coding-cli/amplifier-activity-tracker.ts` | Single events-driven state machine (`applyLifecycle`/`noteEventsSignalLost`); deadman = force-read request only, never fabricates; timing-heuristic code deleted (2026-07-08); public surface frozen |
| `server/coding-cli/provider.ts` | `getLiveEventsPath?` capability (:30 vicinity) |
| `server/coding-cli/providers/amplifier.ts` | Implement `getLiveEventsPath`; explicit metadata-less-dir policy comment |
| `server/session-association-broadcast.ts` | `AssociationBroadcastSource` (:9) += `'amplifier_locator' \| 'amplifier_new_session'` |
| `server/index.ts` | Fast path (:916) accepts `'amplifier'` (~5 lines, source `'amplifier_new_session'`); construct/wire the integration next to `opencodeActivity` wiring (:533-577 vicinity); flag plumb; `associated` → `broadcastTerminalSessionAssociation` (mirror of :563-577) |
| `server/coding-cli/{claude,codex,opencode,amplifier}-activity-tracker.ts` | Phase 4 only: adopt `TurnCompletionLedger` (claude :169-185, codex :463-479, opencode :654-670, amplifier :188-204 — byte-for-byte duplicates today) |
| `server/coding-cli/claude-activity-wiring.ts` | Phase 4 wiring unification: delegates to `wirePtyActivityTracker` (behavior-preserving) |
| `server/coding-cli/amplifier-activity-wiring.ts` | Phase 4 wiring unification: delegates to `wirePtyActivityTracker` (behavior-preserving; tracker disposal clears per-terminal timers) |
| `server/session-observability.ts` | Type-only change: `session_association_broadcast.source` uses the exported `AssociationBroadcastSource` union from `session-association-broadcast.ts` (dedupe) |

**Untouched (by design):** `server/ws-handler.ts`, `shared/ws-protocol.ts`, client `amplifierActivitySlice` / `pane-activity.ts`, `session-association-coordinator.ts`. (`amplifier-activity-wiring.ts` was originally in this list, but was ultimately unified in Phase 4 -- see the Modified table above, which supersedes the earlier "untouched" intent.)

**Deferred (noted, not scheduled):** unifying the near-identical claude/amplifier wiring modules — do it opportunistically in Phase 4 *only if* it falls out trivially from the ledger adoption; otherwise leave for a future mechanical-consolidation pass.

---

## 9. Phases

### Phase 0 — Empirical contract validation ✅ DONE
Findings settled in §2. Deliverable remaining: convert `/tmp/amp-p0/` captures and `~/.amplifier/projects/-tmp-amp-p0-*/` trees into `test/fixtures/coding-cli/amplifier/events/` during Phase 1 (they include: a full normal turn, steering-injection turn, kill -9 orphan, PTY-hangup completion, continue-attach `session:end` orphan, resume append, out-of-order shutdown tail).

### Phase 1 — Events contract core (pure, no wiring)
Reducer + tailer + fixtures. No behavior change in the running app.

**Success criteria**
- Reducer fixture suite covers every §6 transition, including: post-complete naming events (no re-busy), steering injection (single submit/complete pair), orphan `session:end`, out-of-order tail, schema-mismatch degrade, empty-file, `session:fork`/`parent_id` records ignored.
- Tailer tests (injected `fsImpl`): partial trailing line buffering, EOF-attach for resume, appended-bytes-only reads, pre-filter skips noise records without parsing, `size < offset` → degrade, force-read path.
- `npm test` green; zero changes under `server/` wiring.

### Phase 2 — Events-driven tracker + integration
Tracker becomes the single events-driven state machine; integration composes tailer→reducer→tracker; `index.ts` wires it unconditionally. (Originally shipped as a flagged two-lane design; flag and degraded lane removed 2026-07-08 — see §6 note.)

**Success criteria**
- Tracker/wiring tests cover the events-driven semantics (the old timing-heuristic tests were deleted with the behavior).
- Extended `test/server/ws-amplifier-activity.test.ts` (existing harness): busy on `prompt:submit`; exactly one `terminal.turn.complete` (correct `completionSeq`) on `prompt:complete`; a simulated 10-minute silent tool call produces **no** fabricated completion; post-complete naming events do not re-busy; submit-grace reversion on empty-Enter; tailer error mid-turn → phase reverts to idle with **no** `turn.complete` + single warn.
- Deadman force-read test: suppress watcher events (WSL2 simulation), confirm completion is recovered by force-read, and confirm a genuinely-busy session stays busy.

### Phase 3 — Locator + association
Locator, controller, broadcast-source extension, fast-path extension.

**Success criteria**
- Unit (mkdtemp + `AMPLIFIER_HOME` + `utimes`, per `amplifier-provider.test.ts` pattern): two same-cwd terminals, prompted in inverted order vs. spawn order → both bind correctly by Enter-correlation (E8 inversion case); never-prompted terminal → never bound, watcher entry cleaned on exit, no errors; ambiguous double-first-prompt within 2s window → refused + logged, slow-path coordinator still eligible; underscore dirs and `parent_id` starts ignored; cwd mismatch via `session:config` → candidate rejected.
- Resume terminals: locator never arms; tailer attaches at EOF; binding via existing `terminal.session.bound`.
- Fast path: amplifier `metadata.json` discovery binds a still-unbound terminal (locator-missed simulation) through `associateSingleSession`, broadcast source `'amplifier_new_session'`.
- Chokidar hygiene verified: `ignoreInitial: true`, nearest-existing-ancestor watch when `projects/` absent, unref'd timers, `close().catch(() => {})` on dispose.

### Phase 4 — Cross-provider consolidation (mechanical, behavior-preserving)
Extract `TurnCompletionLedger`; adopt in all four trackers.

**Success criteria**
- Snapshot tests: `listLatestCompletions()` output and `completionSeq` sequences byte-identical before/after for scripted turn sequences on each tracker.
- Diff review confirms deletion of the four duplicate blocks; no public-surface change; all existing tracker suites green.
- Claude/amplifier wiring unification attempted; merged only if the diff is trivially reviewable, else a `TODO` note referencing this plan.

### Phase 5 — Rollout & cleanup
- 2026-07-08: the feature flag AND the degraded timing lane were removed ahead of soak by maintainer decision — single code path, no revert lever. Signal loss ⇒ idle-and-stop (§6 signal-loss policy); sessions without events.jsonl get no busy/turn signal.
- Soak monitoring stays: watch `amplifier_events_lane_degraded`, `amplifier_locator_ambiguous`, `amplifier_events_lane_suspect`, and deadman-force-read log rates.
- `docs/plans/ACTIVITY_TRACKING_SPEC.md` updated with the single-path amplifier design; file/refresh the upstream issues (§12).

### Adversarial review round (post-build hardening)

Three adversarial agents (concurrency red-team with reproduced probes, spec
auditor, design reviewer) pressure-tested the implementation. Findings fixed:

- **A** Locator could recursively watch `$HOME` when `<amplifierHome>/projects/`
  was absent (nearest-existing-ancestor walk) → projects/ is now pre-created
  (`mkdir -p`) and watched directly at fixed depth; a persistent watcher error
  self-disables the locator with a single warn.
- **B** Concurrent `attachTailer` calls in one bind cascade leaked the first
  watcher and double-pumped the file → attach/detach are serialized per
  terminal (promise chain).
- **C** Offset-0 attach on `'association'` binds replayed finished history as
  live turns → catch-up state-sync: the initial drain adopts the reducer's
  final phase once and suppresses `turn.complete` emissions; backlogs over
  `AMPLIFIER_CATCHUP_MAX_BYTES` skip catch-up and attach at EOF.
- **D** Silent permanent-idle when inotify drops the `prompt:submit` change
  event → the first submit-grace expiry issues a force-read and extends the
  grace once; only the second expiry reverts. Three consecutive reversions log
  `amplifier_events_lane_suspect` once (soak signal; never auto-degrades).
- **E** Tailer memory unbounded → partial-line buffer capped
  (`AMPLIFIER_TAILER_PARTIAL_MAX_BYTES`, oversized lines dropped to the next
  newline without degrading); reads batched
  (`AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES`).
- **F** Correlation accepted dirs created up to `windowMs` before the Enter →
  lower bound tightened to `AMPLIFIER_DIR_PRE_EPSILON_MS` (jitter allowance
  only), restoring the §5 `[t, t+2000]` intent.
- **G** Lane-degrade racing an in-flight read dropped an already-read
  `turn.completed` → the tracker honors exactly one transitional completion
  after `disableEventsLane` on a busy terminal (cleared by any new
  degraded-lane submit).
- **H** Locator now arms running unbound amplifier terminals that existed
  before construction (registry catch-up sweep, mirroring the integration).
- **I** `probe_timeout` rejections re-probe on later `events.jsonl` changes
  (permanent rejection only for definitive classifications).
- **J** Zero-candidates-at-window-close performs a one-shot readdir
  snapshot-diff of `projects/*/sessions/*` (chokidar initial-scan blind spot).
- **K–O** `AssociationBroadcastSource` deduped (exported from
  `session-association-broadcast.ts`); stale comments/dead fields removed;
  locator test flake hardening (deterministic waits); this plan updated; the
  synthesized `pty-hangup-completes.jsonl` fixture + reducer test added.

Re-verification round (probe-driven) found three residual items plus one
quirk; all fixed:

- **N1** (P2, probe-reproduced) The finding-J zero-candidate rescan anchored
  unseen dirs at `window.openedAt`, auto-satisfying the finding-F eligibility
  bounds — with an inert watcher, a foreign same-cwd session dir created
  before the Enter press got bound (the exact wrong-binding class this
  feature eliminates) → rescanned dirs are now anchored at their
  `fs.stat` birthtime (mtime fallback when birthtime is 0/unavailable);
  dirs whose stat time predates `openedAt − AMPLIFIER_DIR_PRE_EPSILON_MS`
  are rejected, and a stat failure rejects the dir (refuse-to-guess; the
  coordinator slow-path remains).
- **N2** (P3) A synchronously-throwing `watchImpl` (e.g. chokidar ENOSPC)
  inside `doAttach` rejected the serialized chain promise, escaping the
  `void attachTailer(...)` call sites as an unhandled rejection (process
  crash on Node ≥15) → `doAttach` wraps its body in try/catch: partial
  state is cleaned up, the lane degrades via
  `disableEventsLane(terminalId, 'attach_error')` with a single structured
  warn, and the next attach for the same terminal works normally.
- **N3** (P3, cosmetic) The per-terminal `attachChains` serialization map
  never shrank (one settled-promise entry per terminalId forever) →
  mirror-delete when the settled chain tail is still the stored tail;
  `getAttachChainCount()` exposed for leak assertions (bind→exit cycles
  return the map to 0 entries).
- **Q1** (quirk) Catch-up adoption of an in-flight turn used the historical
  `prompt:submit` record ts for liveness, so a >120s-old adopted turn
  tripped an instant deadman force-read right after bind → the adoption
  `turn.began` `at` is clamped to max(recordTs, attachTime). Liveness
  bookkeeping only; turn-boundary/completion-ledger semantics unchanged
  (only `turn.completed` reaches the ledger).

Deferred (noted, not scheduled): sticky-degrade retry for the `read_error`
class (a transient stat failure currently degrades the lane for the rest of
the turn-set); `metadata.json` late consistency warn (§5 step 4 mismatch
check); real-CLI smoke extension (bind + busy + single turn-complete against
the live binary); converting the raw E7 PTY-hangup capture to replace the
synthesized fixture.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Upstream schema change (`amplifier.log` ver ≠ 1.x) — README warns "breaking changes happen" | Medium | Events tracking unusable | Version gate → signal-loss policy (§6): idle-and-stop + single warn; worst case = no busy/turn signal for that terminal |
| WSL2 inotify drops events on the sessions tree | Medium (we run on WSL2) | Stuck busy | Deadman repurposed as force-read (stat + manual incremental read every sweep past 120s silence); recovers missed `prompt:complete` without fabricating |
| Two same-cwd terminals first-prompted within the 2s window | Low | Wrong/no binding | cwd confirm via `session:config` first; residual ambiguity → refuse + coordinator slow-path (watermarked, single-candidate) — never guess |
| `events.jsonl` volume (~450KB/turn, raw LLM payloads inside) | High (normal) | CPU/IO cost | Offset-based appended-bytes reads; substring pre-filter before parse; one tailer per *bound live terminal* only, closed on exit |
| Log truncation/rotation appears upstream later | Low (never observed) | Tailer confusion | `size < offset` ⇒ signal loss (idle-and-stop) + warn; no guessing |
| Locator watcher lifetime bugs (leaks) | Low | fd leaks | Single shared watcher, active only while ≥1 unbound terminal; unregister on bind/exit; disposal test asserts closed |
| Sessions without events.jsonl (bundle lacks the hooks-logging module) | Low | No busy/turn signal for those terminals | Accepted by design (2026-07-08 decision): submit-grace pulses only; documented in §6 signal-loss policy |
| Fast-path extension destabilizes claude path | Very low | Association regressions | Change is a provider-set widening only; coordinator guards unchanged; covered by existing coordinator tests + new amplifier fast-path test |
| Metadata-less orphan dirs accumulate | Certain (E6) | Cosmetic disk noise | Explicitly out of scope to clean; documented policy (§7); not indexed, not resumable |

---

## 11. Test plan

**Unit (vitest, `test/unit/server/coding-cli/`)**
- `amplifier-events-reducer.test.ts` — fixture-driven, one fixture per Phase 0 capture (E1–E10 shapes) plus synthetic: out-of-order tail, orphan `session:end`, schema-mismatch, fork/underscore records, empty-Enter no-op, steering-injected same-turn.
- `amplifier-events-tailer.test.ts` — injected `fsImpl` (pattern: `codex-app-server/durability-proof.ts`): partial lines, EOF attach, append-only reads, pre-filter, reset detection, force-read.
- `amplifier-session-locator.test.ts` — mkdtemp + `AMPLIFIER_HOME` + `utimes` (pattern: `amplifier-provider.test.ts`): snapshot semantics, correlation window, cwd confirm, ambiguity refusal, subagent guards, watcher lifetime, spawn-order inversion (E8).
- `amplifier-session-controller.test.ts` — mode/status validation, bind result handling, reject paths (pattern: opencode controller tests).
- `amplifier-activity-tracker.test.ts` — events-driven semantics: submit-grace reversion (with the one-time force-read retry), lifecycle-record turn boundaries, deadman force-read request, PTY-exit authority, signal-loss idle-and-stop. (The pre-existing timing-heuristic cases were deleted with the behavior, 2026-07-08.)
- `turn-completion-ledger.test.ts` + before/after snapshot tests on all four trackers (Phase 4).

**Integration (`test/server/`)**
- `ws-amplifier-activity.test.ts` extended (existing WS harness): full events-driven turn over the wire (`terminal.turn.complete` with provider-scoped `completionSeq` per `shared/ws-protocol.ts:189`); tailer failure mid-turn → idle with no `turn.complete` + single warn; no new WS message types asserted.
- Association end-to-end: spawn-fake → Enter → dir appears (fixture writer) → `terminal.session.associated` broadcast with `source: 'amplifier_locator'`; fast-path variant with `metadata.json` drop-in.

**Real-CLI smoke (`test/integration/real/`, gated on amplifier binary presence)**
- Extend `amplifier-launch-smoke.test.ts`: launch, prompt, assert bind + busy + single turn-complete against the real CLI; resume a session and assert EOF-attach (no historical replay of completions).

**Manual acceptance (WSL2)**
- Two panes, same cwd, prompt second-spawned first → both bind correctly.
- Long tool call (>2 min silent) → stays busy, completes exactly once.
- Ctrl+C mid-turn → no state flap; PTY kill → pane cleans up.
- Idle pane left unprompted for an hour → no binding, no watcher errors, no log spam.

---

## 12. Upstream asks (microsoft/amplifier-app-cli)

Now grounded in hard refutations (E9) — file as issues, link back here:

1. `--session-id <uuid>` (or env var) on `amplifier` / `amplifier run` for launcher-assigned session identity — would delete the locator entirely.
2. `session list --format json` should emit **full** session IDs (JSON output currently truncates them).
3. Document `events.jsonl` (`amplifier.log` schema) as a stable, versioned integration surface; commit to major-version discipline.
4. Emit a lifecycle event on user interrupt (Ctrl+C currently writes nothing, E5).
5. (Nice-to-have) Write `metadata.json` (or a minimal identity stub) at session creation rather than first `prompt:complete`, eliminating the metadata-less orphan class (E6).

---

## Appendix A — Constants

| Constant | Value | Basis |
|---|---|---|
| `AMPLIFIER_DIR_APPEAR_WINDOW_MS` | 2_000 | Observed 37ms (E1); 50× margin |
| `AMPLIFIER_DIR_PRE_EPSILON_MS` | 250 | Clock-jitter/event-reorder allowance only — dirs meaningfully older than the Enter are foreign sessions (adversarial finding F) |
| `AMPLIFIER_SUBMIT_GRACE_MS` | 2_000 | Empty-Enter writes nothing (E5); provisional busy must revert. First expiry force-reads + extends once (finding D); second expiry reverts |
| `AMPLIFIER_GRACE_REVERSION_SUSPECT_THRESHOLD` | 3 | Consecutive silent reversions before the single `amplifier_events_lane_suspect` warn (finding D; soak signal, never auto-degrades) |
| `AMPLIFIER_BUSY_DEADMAN_MS` | 120_000 (existing) | Force-read trigger ONLY (missed-signal failsafe); never fabricates a completion |
| `AMPLIFIER_CATCHUP_MAX_BYTES` | 4 MiB | Offset-0 attach backlog cap (finding C): larger backlogs attach at EOF; observed events files reach hundreds of MB |
| `AMPLIFIER_TAILER_PARTIAL_MAX_BYTES` | 8 MiB | Partial-line buffer cap (finding E): oversized `llm:request` lines are dropped to the next newline, never degrading |
| `AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES` | 16 MiB | Single read-batch cap (finding E): no `Buffer.concat` scales with file size |
| Schema gate | `amplifier.log`, major ver 1 | 208/208 observed records (E10) |

## Appendix B — Phase 0 artifact locations

- PTY harness + timelines: `/tmp/amp-p0/` (incl. `ampdrv.py`)
- Live capture trees: `~/.amplifier/projects/-tmp-amp-p0-*/sessions/*/`
- Convert to: `test/fixtures/coding-cli/amplifier/events/` in Phase 1 (scrub any raw LLM payloads from `llm:request` records before check-in).
