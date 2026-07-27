# Restart Resilience Architecture Analysis — Rust Freshell

**Date:** 2026-07-24
**Status:** rev 3 — council-reviewed twice (rev 1: CONCERN 6/6, diagnosis affirmed; rev 2: conditional graduation — P0 actionable immediately, P1.7/P1.8 gated on the five gate paragraphs now present in §4.2/§4.3 and the named red tests in §5). This revision incorporates all round-2 gates; pending final council confirmation.
**Scope:** The Rust server (`crates/`) + the shared web client, for every pane type except kimi/gemini (being removed). Goal contract, per the user: *"each pane has its restore information set quickly, and it's restored properly after a server restart."*

**Scope note (per intent-keeper; amended by user ruling 2026-07-24):** The original 2026-07-19 directive covered pane + tab + **sidebar** sync across crashes (Incident 4 was a sidebar join failure). Sidebar/tab-registry sync is **part of this campaign** (P1.14), sequenced after the identity truth it depends on: sidebar joins run on pane↔session bindings, so fixing the sidebar *before* the ledger and verdicts land would rebuild it on the same client-guessed data that caused Incident 4. Same campaign, dependency-ordered — not a separate follow-up.

---

## 0. Executive summary

The Rust port's restart resilience is **entirely client-driven and localStorage-anchored**. The server persists no authoritative pane→session record; PTYs, scrollback, agent sidecars, identity registries, and fresh-agent session maps are all in-memory and die with the process. Recovery works only because the browser remembers what existed and replays `terminal.create` / `freshAgent.attach` from its own Redux/localStorage state.

This architecture has already been diagnosed as the root cause of four production data-loss incidents (`docs/plans/2026-07-19-state-sync-resilience-assessment.md`): *linkage/identity being client-authoritative is wrong* — the client must guess two facts only the server knows (is this terminal alive? does this session exist on disk?). The fix — a server-authoritative reconciliation handshake — was designed (`2026-07-22-reconciliation-handshake-design.md`), and Phases 1–2 shipped in PR #523. **Phase 3 (client adoption) was never done, so ~1,400 lines of reconcile/dedupe/respawn-cap machinery are dormant in production.** This is the single biggest place prior work "came up short."

Beyond that structural issue, the per-pane resilience quality is wildly uneven:

| Pane type | "Restore info set quickly"? | "Restored properly after restart"? |
|---|---|---|
| Shell terminal | N/A (stateless by design) | ✅ cwd restored; scrollback lost |
| Terminal: claude | ✅ t=0 (server pre-allocates `--session-id`) | ⚠️ works, but `restore:true` + lost sessionRef silently produces an un-resumable pane |
| Terminal: codex | ❌ **never** — no server-side capture at all | ⚠️ works only if client remembered the id |
| Terminal: opencode | ⚠️ ~2s locator window; fragile | ⚠️ works if locator resolved in time |
| Fresh-agent: codex | ✅ thread id durable at create | ✅ best story; 3 resume paths; snapshot works |
| Fresh-agent: opencode | ⚠️ durable only at first send | ✅ serve DB survives; settings dropped on resume |
| Fresh-agent: claude/kilroy | ❌ durable id never recorded server-side | ❌ **no attach route, no snapshot (503), BUSY can wedge** |
| Browser / editor | ✅ trivially (pure client state) | ✅ |

The recommended target is the already-decided **hybrid authority model**, completed and extended:
1. Server-authoritative identity/linkage — finish handshake Phase 3 and **extend verdicts to fresh-agent panes**,
2. A **server-side durable pane-identity ledger** (keyed on server-minted identity, not client `createRequestId`) written at identity-establishment time, activated read-first so it is never dormant machinery, and
3. Per-provider identity capture fixed so every resumable pane has a durable identity within ~1s of it existing — with **exactly one writer per identity fact**.

---

## 1. Top-down architecture: how restore works today

### 1.1 The three state stores and their owners

| Store | Owner | Survives restart? | Role |
|---|---|---|---|
| Client Redux + `localStorage['freshell.layout.v3']` | Client | ✅ (per browser) | **Authoritative** pane tree, per-pane restore fields (`sessionRef`, `createRequestId`, `mode`, `initialCwd`, `codexDurability`…) |
| Server in-memory: `TerminalRegistry`, `TerminalIdentityRegistry`, fresh-agent session maps | Server | ❌ | Live PTYs, scrollback ring, identity bindings, sidecar handles |
| `~/.freshell/tabs-snapshots/<device>/*.json` | Server disk (client-pushed mirror) | ✅ | Disaster-recovery mirror; consumed **only** by operator-triggered `POST /api/tabs-sync/restore` (no SPA call site) |

Provider-native durable state (claude `.jsonl` transcripts, codex `rollout-*.jsonl`, opencode `opencode.db`) survives on disk, but the **binding** from pane → provider session lives only in the client.

### 1.2 The restart sequence (as-built)

1. Server restarts: `TerminalRegistry::new()` empty; fresh `bootId`; nothing rehydrated from disk except instance-id, settings, and a parse cache. **The server never proactively respawns anything.**
2. Client reconnects (4009 fast-reconnect), re-sends `hello` (WITHOUT `paneReconcileV1`), gets `ready {bootId}` → detects restart via `bootId` change → `terminal.inventory` (empty).
3. Client's `clearDeadTerminals` rewrites every pane to `status:'creating'` with a **new `createRequestId`**, arms restore intent, and `TerminalView`/`FreshAgentView` re-issue `terminal.create {sessionRef, restore:true}` / `freshAgent.attach`.
4. Server treats each create as ordinary, rebuilding a resume argv from `sessionRef` (`resolve_coding_cli_command`, `cli_launch.rs:361-505`).

### 1.3 Structural defects of this shape

- **D1 — Identity is client-authoritative.** All four documented incidents plus the 2026-07-22 codex-terminal-bounce trace to the client guessing server/disk facts. The assessment doc's verdict (hybrid authority) is accepted and half-implemented.
- **D2 — The reconciliation handshake is dormant.** `pane.reconcile.request` → `attach/respawn/fresh/dead_session/retry` verdicts, keyed-create single-flight dedupe, and the respawn-generation cap are all gated on `hello.capabilities.paneReconcileV1`, which the shipped client never sends (zero hits in `src/`). The duplicate-PTY (two JSONL writers on one session file) and respawn-loop protections are therefore **not in force**. Additionally, the shipped verdict system covers *terminal panes only*: `reconcile.rs:167-171` returns `invalid:unsupported_kind` for any other kind, so fresh-agent panes — including the worst hole (claude/kilroy) — are structurally outside it.
- **D3 — No server-side durable pane-identity record.** The only disk artifact is the client-pushed tabs-snapshot (5s cadence, gated, 1 MiB silent skip). A pane created <5s before SIGKILL, or whose sessionRef hadn't resolved yet, is not recoverable from disk. If the browser is closed when the server restarts and localStorage is lost, the binding is gone even though transcripts survive.
- **D4 — `createRequestId` is not persisted in snapshots and is not stable.** It's the join key for reconcile/dedupe, but exists only in localStorage; the client re-mints it wholesale — most consequentially `clearTerminalContentForRecreate` (`panesSlice.ts:525-549`) mints a fresh id for every pane on every dead-terminal census, with the hydrate path (`persistMiddleware.ts` area) as a secondary source; REST ingress mints none, and `pane_to_create_body` emits none. Any durable structure keyed on it inherits this instability (see §4.2 key choice).
- **D5 — Dead repair channels.** The client sends `liveTerminal`, `codexDurability`, `recoveryIntent`, and `terminal.codex.candidate.persisted`; the Rust server **accepts and drops all four**. The codex durability store (`durability.rs`) is exported dead code ("S5"). "Belt-and-suspenders identity repair; the port shipped the belt only."
- **D6 — No shutdown flush.** Graceful shutdown reaps PTYs/sidecars but writes nothing. SIGKILL is the tested mode; disk state = whatever the last client push contained. *(Design consequence: any durable store must assume clean-close events never fire — see §4.2 lifecycle.)*
- **D7 — Scrollback is unconditionally lost** (in-memory ring; client surface checkpoint invalidated on `serverInstanceId` change).
- **D8 — Multi-client duplicate respawn is unhandled.** Two devices holding the same pane bound to the same `sessionRef` carry DIFFERENT `createRequestId`s. The shipped dedupe keys solely on `createRequestId` (`reconcile.rs:162-196`), so both clients can receive `respawn` for the same session → two PTYs → two JSONL writers on one session file — verbatim the corruption the handshake exists to prevent. There is no sessionRef-level serialization anywhere. *(Found independently by two council lenses; the design needs an explicit multi-client section — see §4.3.)*

---

## 2. Per-pane analysis: current vs. should

For each pane type: (a) how restore info is captured today, (b) what happens on restart today, (c) how it SHOULD work.

### 2.1 Plain shell terminal

- **Today:** No identity by design (`terminal_meta_record_for_create` → `None` for shell). On restart the client re-creates with persisted `initialCwd`; server fallback cwd chain works. Scrollback, process state, env are lost.
- **Should:** Acceptable — shells are stateless by design (reconcile verdict: `fresh`); restored as a fresh, empty shell in the directory the pane was **opened** in (`initialCwd` — USER RULING 2026-07-24: keep the opened directory, live-pwd tracking stays out of scope for now). **Shell content/scrollback is deliberately NOT restored** (USER RULING 2026-07-25 — see §4.5).

### 2.2 Terminal running claude CLI

- **Today:** Best terminal story. Fresh create pre-allocates a UUID at t=0 and launches `claude --session-id <uuid>`; identity is in `terminal.created.sessionRef` immediately and the client persists it. Restore builds `claude --resume <id>`.
- **Defect:** `should_preallocate_fresh_claude` requires `restore != true`. If the client asserts `restore:true` but its `sessionRef` was lost (F5 below), claude launches with **neither** `--session-id` nor `--resume` — silently un-resumable forever.
- **Should (USER RULING 2026-07-24):** **Auto-resume, never ask.** A `restore:true` create without a client-supplied resume id triggers server-side resolution — identity registry, ledger, disk transcript scan — and if ANY source yields the session, the server **just resumes it** (no offer, no button; a `corrected` note at most). The goal of the whole architecture is that this lookup always succeeds. Only when the identity is genuinely gone from every source does the pane get `error{RESTORE_UNAVAILABLE}` — and that is an **invariant violation, a "never happens" state**: it pages us (structured ERROR + invariant counter + CI-gating red test). **The fallback pane preserves every scrap of state that survives** (USER RULING 2026-07-24): same tab/position, pane title, working directory, mode/shell — a fresh session in the pane's old context — with a persistent **error bar: "couldn't be resumed"**. Maximum continuity, zero pretense of health. It is an alarm, not a designed fallback tier. Pre-allocating a session id silently in that state remains forbidden ("silently fresh, indistinguishable from healthy" — Principle 4). *(Rev 2/3 had the error state offering a "resume it?" affordance; user ruling: if we know enough to offer, we know enough to just do it.)*

### 2.3 Terminal running codex CLI  ← biggest terminal-side hole

- **Today:** **No server-side session capture path exists.** No pre-allocation, no locator, `terminal.codex.candidate.persisted` (which the client sends) matches nothing, the JSONL-reconcile lane is "not yet ported," `plan_codex_create_restore_decision` and `CodexTracker::bind_session` have zero non-test callers. A codex terminal's id can only come from the client. The identity-unresolved invariant WARNs after 10s — an alarm, not a repair.
- **Restart:** Works only when the client still holds `sessionRef` (post-incident fix reads `sessionRef` not just `resumeSessionId`). Resume argv `codex … resume <id>` is correct (goldens).
- **Should — one writer, guarded:**
  1. **Near-term (P0):** wire `terminal.codex.candidate.persisted` → identity registry + `set_meta` + `terminal.session.associated` broadcast — **with the mismatch guard the legacy server had** (`server/ws-handler.ts:2951-2960`) **plus a fourth, disk-truth check**: the candidate is validated against server state (terminal exists, is codex-mode, has no conflicting bound identity) **and against disk — the claimed `rolloutPath` must be contained within the expected `CODEX_HOME/sessions` root (client-supplied paths are never trusted raw), stat'd, and verified to contain the claimed thread id — and the claimed sessionRef must not already be bound to a different terminal** (blocks a cross-pane candidate hijacking another pane's genuine rollout). A candidate failing any check is logged and ignored, never adopted and never ledgered. Without the guards, this channel makes identity client-writable — re-installing D1 — and a replayed stale candidate would be laundered into the ledger, which precedence would then defend. *(Red tests: `stale-candidate-replay`, `cross-pane-candidate-hijack`.)*
  2. **End-state (P1):** port a server-side rollout-appear locator (analogous to the opencode locator). **When the locator lands, it SUPERSEDES the client channel — the candidate message is retired from the accepted set**, not kept as a second unsynchronized writer racing last-write-wins into the same identity fact. Exactly one writer per identity fact at any point in time.
  3. Honor-or-reject `codexDurability` on create rather than silently dropping it.

### 2.4 Terminal running opencode CLI

- **Today:** `OpencodeLocator` diffs `opencode.db` session rows within `[spawn−250ms, spawn+2s]`, extended by Enter presses. On resolve → identity + `terminal.session.associated`. Resume argv re-allocates the loopback port and deliberately suppresses `--model`.
- **Defects:** 2s correlation window can close unresolved (slow start, no Enter); restart inside the window loses identity permanently; live activity tracking deferred.
- **Should:** Keep the locator but (a) persist the resolved identity to the server ledger immediately, with a ledger **pending marker** from spawn until resolution so restore can distinguish "fresh by intent" from "fresh by race" (§4.2), and (b) **re-arm the locator on restore-created panes that lack identity** *(numbered in roadmap: P1.10)*. *(Rev 3: rev 2's separate client-snapshot `identityPending` flag is deleted — the ledger pending marker answers the same question with server truth; two mechanisms for one question is how D5 happened.)*

### 2.5 Terminal: CLI launched by hand inside a shell pane

- **Today:** Structurally invisible — identity is only stamped at `terminal.create` or by mode-armed locators. Typing `claude` into a shell pane yields no identity, no activity, no restore.
- **Should (USER RULING 2026-07-24):** Restore it **as a fresh shell that preserves the pane's place in the world** — same tab, same position, same title, in the directory the pane was **opened** in (`initialCwd`; live-pwd tracking explicitly deferred by user). No warning-label heuristic — the preserved context is how the user finds their way back.

### 2.6 Fresh-agent codex (`freshcodex`)

- **Today:** The reference implementation. Thread id is a durable UUID from create (before first message). Sidecar dies with the server (kill_on_drop) but `thread/resume` is implemented on three paths (attach-not-tracked, lazy crash restart, create-with-resume), TERM-25 rejects wrong-thread resumes loudly, snapshots work via resumed sidecar.
- **Defects:** (a) durability store is dead code — pane→thread binding still client-only; (b) `respawn_as_new_thread_after_crash` silently discards conversation memory (only a `warn!`); (c) resume-after-restart runs with **no settings** (`model: None`, `sandbox: None`) until the next send; (d) unbounded `sessions`/`resuming` maps.
- **Should:** (a) write the thread id + full resume-invocation record (settings included, §4.2) to the server ledger at create (subsuming/deleting the dead durability-store exports); (b) surface a user-visible degradation frame when a new thread is minted after crash; (c) resume **reapplies the user's settings from the ledger automatically** — the "settings reset" breadcrumb survives only as the alarm for a missing record (never-happens state); (d) bound the maps.

### 2.7 Fresh-agent opencode (`freshopencode`)

- **Today:** Durable `ses_*` id minted at **first send** (placeholder before that). Shared `opencode serve` sidecar dies with the server, but its DB survives; attach cold-starts serve and `GET /session/:id`. 404 → lost-session frame; transport error → distinct failure (correctly never mis-declared lost).
- **Defects:** (a) pre-first-send window where the pane has no durable identity; (b) `resume_durable_session` drops model/effort/cwd → serve defaults until next send; (c) overlapping sends not serialized.
- **Should:** (a) accept the materialize-at-first-send model but persist to the ledger (full resume-invocation record incl. model/effort, §4.2) the moment `session.materialized` fires; (b) resume reapplies settings from the ledger automatically; (c) serialize sends per session.

### 2.8 Fresh-agent claude / kilroy  ← biggest hole overall

- **Today:** **Not restart-resilient at all.**
  - `freshAgent.attach` is routed for codex and opencode only; claude falls into `_ => {}` and is **silently swallowed** — no error frame, so the client never even marks the session `.lost`, so `triggerRecovery` never fires. A pane that was BUSY at restart **wedges BUSY**.
  - Snapshot endpoint 503s (no adapter) — chat history cannot rehydrate.
  - The Rust side keys sessions by the ephemeral nanoid placeholder; the durable `cliSessionId` (from `sdk.session.init`) is forwarded to the client and never retained server-side.
  - Resume exists only at create time (`options.resume` via sidecar).
  - Pending approvals: the sidecar auto-allows every tool call (waiting edge only) — so nothing pends, nothing to persist; but this also means the "waiting" UX is cosmetic in the Rust port.
- **Should (target parity with codex), sliced thin per council:**
  1. **First, its own PR: stop the swallow.** Route claude attach to an arm that emits `INVALID_SESSION_ID`/lost frames. This alone un-wedges BUSY and engages the existing client recovery machinery. Prove it with a kill-server-while-busy e2e before building more.
  2. Record `cliSessionId` server-side when `sdk.session.init` passes through the consumer; dual-key the session map; write to ledger.
  3. Real attach arm: not-tracked → spawn sidecar with `options.resume = cliSessionId`, register, emit idle snapshot.
  4. Snapshot adapter reading the isolated `CLAUDE_HOME/projects/**.jsonl` transcript (or via the SDK), so history rehydrates like codex's `thread/read`.
  5. Approvals: as long as auto-allow stands, no persistence needed; if real interactive approvals return, pending approvals must live in the ledger with a deny-on-restart-with-notice policy.

### 2.9 Browser and editor panes

- **Today:** Pure client state (`url`, `devToolsOpen`; `filePath`, `viewMode`…) persisted in layout + snapshots; nothing server-side to restore. The operator-restore path deliberately fails loud (`in-progress-unconfirmed`) for content panes.
- **Should:** Fine as-is. Only note: they inherit whatever we decide about snapshot/ledger fidelity (D3/D4).

---

## 3. Cross-cutting client-side fragilities (apply to all pane types)

| # | Fragility | Why it matters |
|---|---|---|
| F2 | `bootId` is `.optional()` in the client schema; restart detection silently disabled if absent | Make it required; fall back to `serverInstanceId` change |
| F3 | `clearDeadTerminals` runs on EVERY `terminal.inventory`, not just after restart — a partial/early census destroys live panes | Root shape behind several incidents; reconcile verdicts remove this class |
| F4 | Restore-arming is module-global mutable state seeded at import; a missed `addTerminalRestoreRequestId` call = silent fresh session | Replace with server verdicts |
| F5 | `restoreFallbackAttemptsByPane` (the only restore-vs-fresh discriminator) is deliberately not persisted; browser reload mid-recovery re-arms restore against nothing | Feeds the claude §2.2 hole |
| F8 | Hidden panes never send create/attach/reconnect; background tabs don't rebind until revealed | **Promoted to P1** — a terminal multiplexer's panes are mostly hidden; recovering only the visible pane "lies by omission about the rest" |
| F9 | Launch-time `INVALID_TERMINAL_ID` → permanent `status:'error'`, no retry — a create landing on a half-initialized server is dead until refresh | **Must ship with or before Phase 3** — attach verdicts racing terminal exit funnel into this dead-end |
| F10 | Turn-completion dedupe baselines reset only on `bootId` change | Combined with F2, chimes can be swallowed |
| F11 | Post-restart full-rehydrate is a thundering herd (no stagger) across all visible panes | Interacts with the legacy FIFO spawn-gate lesson (2026-07-06 WSL RCA). **Also unhandled: the *human's* herd — N panes surfacing `dead_session` adjudication at once needs a batched UX, not N modals** |

Server-side snapshot-store issues worth fixing regardless of architecture: corrupt device dir scores `capturedAt=0` and is evicted FIRST; >1 MiB snapshots silently skipped while the push still ACKs; keyed-create reservation fails open after ~5s. One honest existence-probe caveat: a *known* provider whose home directory is missing (provider not installed on this machine) yields `Unknown`; under the bounded-deferral design (§4.3) that must NOT be labeled `INDEX_WARMING` forever — it gets its own honest terminal label (`error{PROVIDER_UNAVAILABLE}`), because "warming" that never completes is a lying label.

---

## 4. Target architecture

### 4.1 Principles

1. **Hybrid authority (already decided; finish it).** Server owns linkage/identity truth (is the terminal alive; does the session exist on disk; which session does this pane bind to). Client owns cosmetics (layout, titles, order).
2. **Identity capture is event-driven and server-durable.** "Restore info set quickly" must be a *server* guarantee tied to identity-establishment events, not a function of a 5s client push cadence surviving until SIGKILL.
3. **Restore is verdict-driven, not guess-driven.** The client proposes (its persisted pane list); the server adjudicates per pane (`attach`/`respawn`/`fresh`/`dead_session`) — the machinery already built in PR #523, extended to fresh-agent panes.
4. **Never silent when we could act.** When the server can resolve an identity ("auto-resume, not offer it as a choice"), never prompt. When it cannot resolve, surface the alarm loud (Principle 3: error verdict, visible breadcrumb, invariant counter). When the truth is unknown, explicitly label it "`unknown`" (e.g. `error{INDEX_WARMING}` for warming; `error{PROVIDER_UNAVAILABLE}` for a missing provider home). Silently-wrong is worse than an honest error.
5. **Exactly one writer per identity fact.** As identity-capture machinery lands (locators, guards, ledger writes), old channels retire. Do not defend old channels and new ones simultaneously; once a writer lands, earlier guesses defer to it.
6. **Read-first activation (Principle 1, specialized).** The ledger ships with writes paired to reads from day one. It is never "dormant machinery" waiting for client adoption before it begins consuming disk.

### 4.2 Server-side durable pane-identity ledger (read-first, append-only, GC'd)

**Stores:** a simple SQLite3 append-only log + in-memory read-on-boot cache (keyed on `sessionRef`; panes look up via `sessionRef` → `bound` row; verdicts draw from it).

**Scope:** every resumable pane (shell: no; claude/codex/opencode terminals: yes; fresh-agent: yes; browser/editor: client-only).

**Key choice:** the join key is the **server-minted identity** (`sessionRef` for terminals; `threadId` / `ses_*` / `cliSessionId` for fresh-agent). `createRequestId` is stored only as an advisory field. **Endgame:** once P1.6 stabilizes it, `createRequestId` remains what it was designed to be — an ephemeral create-dedupe/reservation key — and is permanently demoted from identity: all identity joins run on `sessionRef`.

**Write triggers:** claude terminal pre-allocation; codex candidate/locator resolution (guarded, §2.3); opencode locator resolution; fresh-agent created/materialized (`thread/start`, `ses_*`, `sdk.session.init`); pending markers at spawn of any identity-bearing pane; retire on observed clean close.

**Write-failure policy (hot path):** a ledger write failure never blocks the create/identity event — the in-memory registry proceeds (today's behavior) — but it is never silent, and **the warning must arrive before the restart it warns about**: at failure time the server pushes a live frame to attached clients (ride the existing `terminal.meta.updated` / a `durability.degraded` notice) so the pane immediately shows "this pane may not survive a restart," in addition to a structured ERROR log and the `terminal_identity_unresolved`-class invariant counter. (A flag on "the pane's next verdict" alone would be a posthumous warning — the verdict typically arrives after the restart that already lost the pane, delivered by the process whose death it warned about.) Fail loud, degrade to status quo. *(Red test: `ledger-write-failure-surfaces-live`.)*

**Supersession retires, never defends (G3):** when a pane's binding legitimately moves (codex crash-respawn mints a new thread; a corrected identity lands), the writer retires the old row (`state: retired, retiredReason: superseded, supersededBy: <new ref>`) and writes the new one. These are two per-row atomic operations, not one transaction, so the order is pinned — **write the new `bound` row FIRST, then retire the old** — and a boot-scan repair rule closes the crash window: if two `bound` rows reference the same pane lineage (same `liveTerminalId`/pane linkage), the newer `updatedAt` wins and the older is auto-retired as `superseded` at boot, loudly logged (red test: `crash-mid-supersession-two-bound-rows`). **Reader rule for retired rows:** a client claiming a superseded ref is answered from the chain terminus — follow `supersededBy` to the live `bound` row and return it with `corrected:true` (never `respawn` the retired ref, even if its transcript still exists on disk); chains cannot cycle because a supersession write always targets a fresh row and retires its predecessor in the same act (red test: `client-claims-superseded-ref`). The precedence rule below applies only to `bound` rows — a retired row is never used to overrule a client, preventing the ledger from confidently defending a stale binding. Per Principle 4's "never silently wrong": a user attached to the wrong conversation is worse than one who lost it.

**Lifecycle & hygiene (rev 2 — council finding):** because SIGKILL is the tested mode (D6), "retire on clean close" is best-effort and **must not be load-bearing**. Rows carry `lastObservedAt`, refreshed opportunistically (identity events, reconcile requests, existence probes); a boot-time + periodic GC expires `bound` rows not observed within a TTL (e.g. 30 days) **to tombstones** (`retired/gc_expired`), never to deletion. A pane returning after expiry whose transcript still stats on disk is **auto-resumed** — `retired/gc_expired → bound` is a legal transition, taken automatically and loudly logged (per Principle 4's never-ask-when-we-can-act); only genuine transcript absence yields the loud dead-session notice. Tombstones themselves are deleted after a second, longer TTL **conditioned on the transcript no longer existing on disk** — so silent-fresh never returns by timer while the conversation is still recoverable. A `ledgerVersion` field gates schema migration. **Corruption policy: fail loud per-row, never per-store** — an unparsable row is quarantined (renamed aside + logged), never silently dropped, and never causes healthy rows to be skipped; **and quarantine surfaces in the affected pane's verdict** (`ledger_quarantined` reason → visible breadcrumb), not only in a log a user never reads. A corrupt-ledger boot test is part of the slice (red test: `corrupt-ledger-boot`). (Prior art for getting this wrong: the snapshot store evicts the fully-corrupt device dir FIRST.)

**Precedence rule (rev 2 — council finding):** when the ledger's `bound` row and a reconnecting client disagree about pane X's binding, **the ledger wins for identity; the client's claim is recorded and answered with a `corrected` verdict** (the reconcile protocol already has `corrected:true` semantics) — and per Principle 4 the correction is user-visible, never a silent switch. The authority chain for any identity question is: in-memory registry (live process truth) → ledger `bound` rows (durable server truth) → client claim (proposal only) → tabs-snapshot (rescue mirror, never consulted while the former exist). This makes the ledger the *single durable home* for identity; tabs-snapshots remain a layout mirror and stop being treated as an identity source.

**Reads that make it non-dormant (Principle 6):** the ledger ships read-first — slice 1 wires it into (a) `terminal.inventory` sessionRef stamping and (b) the existence probe's `ever_observed` input, so a transcript deleted while the server was down yields a loud `dead_session`, not silent `fresh` (today `ever_observed` is per-process memory only, `reconcile.rs:229-247`). Verdict derivation reads it from the same PR that introduces writes.

**What a binding row stores — the resume-invocation record (USER RULING 2026-07-24):** the crisp schema boundary is *"persist exactly what the resume command needs."* A binding row therefore carries every parameter required to re-issue the provider's resume (`model`, `sandbox`, `permissionMode`, `effort`, `cwd` — whatever `resolve_coding_cli_command` / `thread/resume` / session attach consume), updated when the user changes them. Resume then reapplies the user's settings automatically; the "settings reset — reconfirm" breadcrumb survives only as the alarm for the never-happens case where even this record is missing. **Deliberately NOT stored:** scrollback (no store exists — provider resume repaints agent panes, §4.5), transcripts are provider-owned, layout is client-owned (+ snapshot mirror). *(This supersedes the rev-3 breadcrumb-now/durable-later split — the user ruled settings are part of the resume unit and persist from v1.)*

### 4.3 Finish reconciliation handshake Phase 3 (client adoption) — with a multi-client spec

- Send `capabilities.paneReconcileV1`; on reconnect, send `pane.reconcile.request` with persisted panes; fold verdicts: `attach` → plain attach (no recreate), `respawn` → create-with-resume, `fresh` → clean create, `dead_session` → loud breadcrumb + **batched** user adjudication UX (one panel listing all dead panes, not N modals — F11-human).
- **Retry verdict: DELETE from the wire** (council unanimous, see §6.1). The deletion stands on the complexity math alone: a fifth verdict state + client retry bookkeeping + an undesigned exhaustion state, for an undemonstrated problem. *(Rev 3 correction: rev 2 also cited a permanent-`Unknown` existence-probe defect for missing provider homes; `existence.rs:63-86` already returns `Absent` for unknown providers — stale citation, withdrawn.)* The `index_warming` case is handled server-side by deferring the reconcile response — **bounded** (e.g. 2s budget, single deferral): if the index is still cold at the deadline, the pane gets a loud `error{INDEX_WARMING}` verdict with a visible breadcrumb and a manual retry affordance — never a fake `fresh`/`dead_session` verdict, never an unbounded await. A *known provider with no home on this machine* is NOT warming — it gets the honest `error{PROVIDER_UNAVAILABLE}` label (§3). Under a post-restart storm, warming notices are **batched into one banner** ("waiting for session index — N panes"), the same anti-N-modal rule as `dead_session`. *(Red tests: `warming-never-completes`, `restart-storm-all-panes-warming`.)*
- **Preconditions, ordered explicitly:** (1) stop re-minting `createRequestId` on hydrate (`persistMiddleware.ts:229`) and mint one at REST ingress — this is its own P1 item *before* anything else joins on the key; (2) persist `createRequestId` in tabs-snapshots (fixes D4's snapshot half).
- **Multi-client single-flight (rev 2 — closes D8):** the server serializes respawn **per `sessionRef`**, not just per `createRequestId`. The first respawn winner binds `sessionRef → new terminalId` (registry + ledger); every other client's reconcile/create for the same `sessionRef` — regardless of its `createRequestId` — receives `attach {terminalId}` to the winner (or `duplicate` if it insists on a keyed create). The keyed-create reservation gains a sessionRef-level reservation alongside the existing key-level one, and it **fails closed** rather than open when the claim window expires. **The lock has an unlock (rev 3 — G2):** the reservation is a **liveness-bound lease** — released automatically when the holder's spawn completes (bind), fails (error), or the holding task/connection dies; a wall-clock lease TTL (~2× spawn budget) backstops a *hung* holder. **TTL expiry is kill-before-release:** the holder's in-flight spawn is killed and its death confirmed before the lease releases — if the kill cannot be confirmed, the lease is NOT released (fail loud, hold closed) — otherwise TTL expiry on a slow-but-alive holder would mint exactly the two-writers corruption the lease exists to prevent. Losers receive `error{SESSION_RESERVED, retryAfterMs}`; the **named retryer** is the client's existing unanchored-pane re-drive loop (`TerminalView` re-sends create-on-reconnect and on `retryAfterMs` — the same bounded machinery as the F9 fix), with the **retry window sized to exceed the lease TTL plus margin** so a healthy-but-slow winner cannot exhaust losers by arithmetic. **Exhaustion state:** after retries exhaust, the pane resolves **automatically against current state** — if a binding now exists (the winner succeeded), the pane silently attaches to it; if the winner ultimately *failed* (no binding), the pane falls back to the dead_session/fresh-recovery flow with a visible notice. Never a button where an action will do (Principle 4). Never a silent wedge, never a duplicate writer. *(Red tests: `two-clients-same-sessionRef`, `winner-dies-mid-claim`, `winner-hangs-mid-claim`, `loser-exhausts-then-holder-fails`.)*
- **F9 fix ships in the same slice** (bounded retry for launch-time `INVALID_TERMINAL_ID` during reconnect windows) — otherwise attach verdicts racing terminal exit funnel into a permanent-error dead-end.
- **Fresh-agent panes enter the verdict system** (design doc §12 promoted from "sketch"): reconcile accepts `kind: fresh-agent`, answering from the fresh-agent session maps + ledger with the same verdict vocabulary (`attach` = session tracked live; `respawn` = resumable via provider-native resume; `dead_session` = transcript gone). This gives the biggest hole (claude/kilroy) the same dedupe/cap protections as terminals. Until it lands, fresh-agent restore continues via attach/lost-frame flows (§2.8) — but the end-state is one verdict system for all restorable panes, not two regimes.

### 4.4 User-facing recovery surface

The ledger + snapshot store are only as valuable as their consumer. Today the sole disk-backed recovery consumer is an operator-only `curl` endpoint. **Add a minimal in-product "recover my panes" flow** (e.g. on connect with an empty client layout and a non-empty ledger/snapshot: offer "restore N panes from server memory?"), fed by ledger + snapshots. This is what makes browser-loss recovery real for a user rather than for the developer who built it. *(Rev 2 — council: "recovery for the tired user, not the operator." Also the honest answer to intent-keeper's browser-loss scope note.)*

### 4.5 Explicit non-goals / deferred

- **Server-side proactive respawn at boot:** rejected for v1 — ownership semantics, spawn storms with zero observers; verdict-driven client-triggered respawn achieves the contract. Revisit for headless/MCP-driven use.
- **Scrollback persistence: NO SEPARATE STORE (USER RULING 2026-07-25, superseding the 2026-07-24 "in scope" reading).** The unit of resilience is the provider's resume function: for coding-agent panes, `--resume` / thread-resume / snapshot endpoints repaint the conversation from the provider's own session logs — that IS the scrollback story. Plain shells are deliberately not content-restored (fresh empty shell, tab/title/opened-cwd preserved — §2.1/§2.5). A disk-persistence layer for terminal output (built as lane A5, `feat/scrollback-persistence`) was **discarded before landing**: redundant with resume, and replaying saved bytes atop a resume repaint would double-show history. One standalone fix was salvaged from that lane: attach.ready vs queued-output-frame ordering (`fix/ws-attach-ready-ordering`).
- **In-flight turn resumption (USER FRAMING 2026-07-24: "the unit of resilience is the resume function"):** freshell restores exactly what each provider's own resume restores. All three providers' resume functions (`claude --resume`, codex `thread/resume`, opencode session lookup) restore the conversation to the provider's **last durably written point**; none of them continues a half-finished generation — that capability does not exist provider-side. So a response being generated at the instant of restart is lost back to the last persisted point regardless of freshell's architecture, and keeping sidecars alive across restarts would not change that (the generation state lives in the provider process being killed either way). Freshell's obligations are therefore: invoke resume correctly and automatically, rehydrate everything the provider persisted (via snapshots), and never wedge status (§2.8).
- **Hand-launched CLIs in shell panes:** the CLI session itself is not restored (freshell never knew about it); the pane comes back as a fresh shell in its opened directory, same tab/position/title (§2.5, user ruling).
- **Live cwd tracking:** deferred (USER RULING 2026-07-24 — restore uses the opened directory, not the live pwd, for now).

### 4.6 Sidecar ownership — decided

Keep sidecars as children that die with the server (council unanimous, no dissent): "orphan management buys in-flight-turn preservation at the price of a permanent ownership-reaping subsystem; fast resume is the cheaper asset to own." Invest in fast, correct resume instead.

---

## 5. Prioritized roadmap

*(Rev 2 reordering per council: activate-before-build; dead-code deletion pulled forward; each ledger write paired with its read; contract test first.)*

**P0 — the ruler + correctness holes (each independently shippable, TDD, worktree per repo rules):**
1. **The contract test, first:** a restore-matrix e2e that kills the server (SIGKILL) with ALL pane types live — shell, claude/codex/opencode terminals, freshclaude, freshcodex, freshopencode, browser, editor — and asserts each comes back per its §2 contract. This is the ruler every subsequent fix is measured against; it will start mostly red. **Provider fidelity:** the matrix runs on fake CLIs (deterministic, CI-safe, per the destructive-test sandbox rules); the opt-in real-provider contract suite (`FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`) gains a restart-resume case per provider so the fakes' resume semantics are pinned against reality. The wall also carries the design-gate red tests as expected-fail entries from day one: `SIGKILL-inside-locator-window`, `SIGKILL-within-5s-of-pane-creation`, `pending-resolution-collision`, `crash-between-binding-write-and-marker-delete`, `crash-mid-supersession-two-bound-rows`, `client-claims-superseded-ref`, `winner-dies-mid-claim`, `winner-hangs-mid-claim`, `loser-exhausts-then-holder-fails`, `warming-never-completes`, `restart-storm-all-panes-warming`, `rebind-retires-old-row`, `stale-candidate-replay`, `cross-pane-candidate-hijack`, `two-clients-same-sessionRef`, `corrupt-ledger-boot`, `ledger-write-failure-surfaces-live`.
2. **Claude/kilroy: stop the attach swallow** (own PR): emit lost/`INVALID_SESSION_ID` frames → un-wedges BUSY, engages existing client recovery. Then, as follow-on slices: `cliSessionId` recording, real attach arm, snapshot adapter (§2.8.2–4).
3. **Codex terminal identity capture:** wire `terminal.codex.candidate.persisted` **with the legacy mismatch guard PLUS the disk-truth check** — path containment under `CODEX_HOME/sessions`, stat + thread-id verification, and no-conflicting-binding check (§2.3.1, all four guards; executors: read that section, not just this line).
4. **Claude terminal `restore:true`-without-sessionRef → fail loud** with `RESTORE_UNAVAILABLE` (§2.2).
5. **Dead-code audit (delete or activate):** `launch_plan.rs` decision table, `CodexTracker::bind_session`, durability-store exports, and the dropped create fields (`liveTerminal`/`recoveryIntent` — honor or reject). Cheap, removes context poison *before* new work reads the wrong code as the restore path.

**P1 — structural (ordering is load-bearing; items 7–8 were council-gated on the §4.2/§4.3 gate paragraphs, which rev 3 now contains):**
6. **Key stabilization:** stop re-minting `createRequestId` on hydrate; mint at REST ingress; persist it in tabs-snapshots. *(Precondition for anything joining on the key.)*
7. **Handshake Phase 3 client adoption** (§4.3) incl. multi-client sessionRef single-flight with liveness-bound lease, bounded index-warming deferral, retry-verdict deletion, F9 bounded retry, batched dead_session UX. *(Activates the dormant 1,400 lines BEFORE new stores are built.)*
8. **Pane-identity ledger** (§4.2), shipped read-first (inventory stamping + `ever_observed`), then wired into all identity events. Includes pending markers, supersession retirement, GC-to-tombstone, corruption quarantine surfaced in verdicts, write-failure policy, precedence rule.
9. **User-facing "recover my panes" surface** (§4.4), fed by ledger + snapshots. *(Own item — it is a product feature, not ledger plumbing.)*
10. **Opencode locator re-arm on restore** + `identityPending` snapshot marker (§2.4).
11. **F8: hidden panes rebind on reconnect** (promoted from P2 — most panes in a multiplexer are hidden).
12. **Codex server-side rollout locator**, superseding + retiring the candidate message (§2.3.2).
13. **Fresh-agent panes into the verdict system** (§4.3 last bullet) — with settings **reapplied from the ledger's resume-invocation record** on every resume (user ruling: persist what the resume command needs), and the user-visible degradation frame on codex new-thread-after-crash: a sandbox/permission posture the user set must never silently revert.
14. **Sidebar/tab-registry sync (in-campaign, user ruling):** once 6–13 land, re-verify the original Incident-4 sidebar contract against the ledger-backed joins and fix whatever remains — same campaign, last because it consumes the identity truth items 6–13 create (see scope note).

**P2 — hardening:**
15. *(absorbed into P1.8/P1.13 by user ruling — settings persist in the ledger's resume-invocation record from v1.)*
16. Client F2/F10 fixes; restart-storm stagger (F11-server).
17. Snapshot-store defects (corrupt-dir eviction order, silent 1 MiB skip); the use-it-or-remove-it decision for the whole tabs-snapshots store + `POST /api/tabs-sync/restore` is tracked as **kata `h9vt`** (either outcome lands after the ledger, P1.8).
18. ~~Scrollback persistence~~ **WITHDRAWN (USER RULING 2026-07-25, §4.5):** covered by provider resume for agent panes; shells deliberately not content-restored. No store to build.

**Verification wall (existing + to-extend):** `compound-restart-rust.spec.ts`, `codex-terminal-bounce-rust.spec.ts`, `restore-matrix.spec.ts`, `reconcile-handshake-rust.spec.ts`, `npm run smoke:continuity`, plus new specs: the P0.1 all-pane-types matrix; freshclaude busy-restart un-wedge; SIGKILL-within-5s-of-pane-creation (ledger proves durability); two-clients-same-sessionRef duplicate-respawn (must produce 1 PTY); hidden-pane rebind; double-restart mid-recovery; corrupt-ledger boot. The invariant `terminal_identity_unresolved` WARN remains the live "restore info set quickly" tripwire — **note (tester-breaker): it goes quiet when fed corrupted identity, so it must be paired with an identity-validity check**, and should gate CI.

---

## 6. Decisions

### Resolved in rev 2 (per council; overridable by user)
1. **Retry verdict: deleted from the wire.** The `index_warming` case is absorbed server-side (bounded deferral, then loud `error{INDEX_WARMING}` — §4.3). Rationale: a fifth verdict state + client retry bookkeeping + an undesigned exhaustion state, for an undemonstrated problem. *(Rev 3: the earlier existence-probe citation was stale — `existence.rs:63-86` already returns `Absent` for unknown providers; deletion stands on the complexity math.)*
2. **Sidecar ownership: die-with-server** (§4.6). Unanimous.
3. **Claude restore-without-ref:** auto-resolve from server sources and resume; the unresolvable state is an invariant-violation error, never silent pre-allocation (§2.2 — USER RULING: auto-resume, never ask; error = "never happens" alarm).
4. **Settings: persist in ledger v1** (USER RULING 2026-07-24, superseding the council's breadcrumb-now/durable-later split): the ledger row is defined as *the resume-invocation record* — it stores exactly what the resume command needs, settings included (§4.2). The reconfirm breadcrumb survives only as the missing-record alarm.
5. **Pending-identity shape (rev 3 — G1):** pending markers are never promoted and never joined — resolution writes a fresh binding row and deletes the marker (§4.2). *(Sam's deletion-shaped answer chosen over promotion machinery; tester-breaker's `pending-resolution-collision` test pins the race semantics.)*

### Decided by user, 2026-07-24
6. **Recovery is automatic, never offered:** any state where the server could offer a "resume it?" choice is a state where it just resumes. Error states are invariant violations that page us, not fallback UX tiers. (Applied throughout: §2.2, §4.1(4), §4.2 GC, §4.3 exhaustion.)
7. **In-flight turns:** unit of resilience is the provider's resume function — restore to the provider's last durable point automatically; no orphan-sidecar machinery (§4.5).
8. **Browser-triggered restore at boot:** confirmed (§4.5 first bullet).
9. **Hand-launched CLIs:** restore as a fresh shell preserving tab/position/title/opened-directory; no warning-label heuristic; live-pwd tracking deferred (§2.5).
10. **Scrollback persistence: withdrawn** (USER RULING 2026-07-25 — provider resume covers agent panes; shells deliberately not restored; §4.5). **Unresumable-pane fallback keeps maximum state** (title, cwd, tab position) plus a "couldn't be resumed" error bar (§2.2).
11. **PR #519: close it.**
12. **Sidebar sync: same campaign** (P1.14), sequenced last because it consumes the identity truth the earlier items create.

### Remaining minor call (delegated unless overridden)
13. **Ledger store location/format:** new `~/.freshell/pane-ledger/` (recommended — different write cadence and authority than tabs-snapshots) vs extending the snapshot dir. Proceeding with the new store unless told otherwise.
