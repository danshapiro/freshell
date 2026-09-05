# Terminal mode replay sync — plan (v6, implemented; four load-bearing rounds + hazard resolution)

## Context

After any browser page load, a pane's xterm is recreated and rehydrated from the server's retained replay buffer. Apps enable DEC private modes (mouse `?1000/?1002/?1003h`, SGR mouse `?1006h`, alt screen `?1049h`, cursor `?25l`, bracketed paste `?2004h`, focus `?1004h`) and XTMODIFYKEYS (`CSI >4;1m`) **once at startup**; those bytes scroll out of the retained window, so the recreated xterm reverts to defaults and wheel input is never forwarded (`mouseTrackingMode === 'none'`). Proven live 2026-08-16 (1.7 MB replay tail contained zero mouse sequences; fresh opencode emits the full set in its first burst; resize does not re-emit). Distinct from the geometry-stomp fix (PR #649).

## Load-bearing disposition (rounds 1+2)

- **R-1 wire encoding**: seq-frame surgery dead; v3 message type survives (see Validator C ordering proof, Validator D write-path proof).
- **R-2 contract**: additive optional `surfaceReset` + new `terminal.modes.sync` server→client type; WS protocol version stays 7; all four old/new quadrants valid (Zod non-strict strips, serde accept-and-strip with zero real `deny_unknown_fields`, client dispatch has no default-reject). Gated files enumerated incl. `crates/freshell-protocol/tests/inventory.rs` hard counts (57→58 / 87→88) and gateway: `port-contract.yml` (test:port + regen-idempotency + `cargo test -p freshell-protocol`).
- **R-3 delivery machinery**: `terminal.modes.sync` sent by immediate `safeSend`(Node: broker.ts between :520-522) / `sink`(Rust: registry.rs:1262) inside the attach critical section; strictly ready < sync < replay < live (Node: sync section contains zero awaits, replay flushes on later macrotask; Rust: reader blocked on the per-terminal lock, comment registry.rs:1230-1232). Bypasses every loss channel (queue overflow, supersede/detach discards — all operate on queued output; sync never enters the queue). Empty-replay problem deleted by construction (sync is seq-less).
- **R-4 probe interplay**: sync bytes never traverse `handleTerminalOutput`/extractors (sole funnel proven); near-spawn probe disarm removal; DECRQM/OSC/title side effects suppressed because sync writes use `mode: 'replay'` write-scope.
- **R-new (sync tagging)**: sync carries `attachRequestId` AND `streamId` (isCurrentAttachStreamMessage guard, TerminalView:2557-2701); untagged → fail closed (`missing_attach_request_id` reject); handler additionally rejects when `currentAttachRef.current === null`.
- **R-new (Rust channel pin)**: `TerminalModesSync` must route the direct channel (output_frame_meta wildcard → None today); pin with a unit test so a future queue-delegation edit can't break ready<sync<replay.
- **xterm facts (G2/E)**: family-slot semantics verified ({9,1000,1002,1003} one protocol slot, {1006,1016} one encoding slot, W-L-W unconditional clears); RIS resets everything except cursor-hidden(25); DECSTR broad but NOT mouse; `?1049h/l` idempotent (active-buffer last-wins law); 47/1047/1049 fold into one alt state (hazard if not); 1048 never synthesized standalone; emit-as-tracked policy for ?1049 chosen with bounded artifact budget.
- **App traffic (G3)**: no RIS/DECSTR/C1 in opencode/vim/tmux startup+teardown (byte-faithful capture, C1-corruption-safe harness); scanner handles them anyway (cheap); kitty `>7u/<u` keyboard stack = deferred residual (own cycle).
- **Scanner domain (F)**: both servers scan decoded strings (node-pty default UTF-8; Rust Utf8StreamDecoder lossy port); openers = `ESC[` + U+009B; 64-CODE-POINT carry (existing constant on both scanners: output-barrier-scanner.ts:44 / barrier_scanner.rs:105); U+FFFD = ground content, resync; Node tracker scans the PRE-normalize data at replay-ring.ts:63; fixtures authored in decoded-string domain.
- **Client marker (A + F)**: new `surfaceFreshRef` (positive polarity). SET at exactly two sites: init-effect construction (TerminalView.tsx:2048, covers mount-fresh + renderer-recreate — one construction site) and user reset (term.reset() at :2215). NOT on term.clear() (:2796) nor cleanup. CLEAR at first applied write of a non-stale generation — anchor terminal-write-queue.ts:134 after the :133 stale guard (wire via new optional onWriteApplied; parity direct-write mirror :1680-1704). Read synchronously at buildTerminalAttachMessage send (~:2859-2869). Required addition (A-5.1): when `surfaceFreshRef.current` is true, the attach MUST force `intent='viewport_hydrate'`, `sinceSeq=0` (else a checkpoint-blessed delta would continue content onto a fresh blank surface — data hole). The hidden-attach wire swap (:2765-2766) applies after this resolution.
- **Hazard-closure e2e (F)**: harness dispatch `{type:'panes/requestPaneRefresh', payload:{tabId,paneId}}` (slice panesSlice.ts:985/1593), PRECONDITION pane content already terminalId-folded; no `.focus()` on the refresh chain; assertion after settle: no terminal.input containing `\x1b[I`/`\x1b[O`.
- **1049 ordering (E-A5)**: synthesize `?1049h` before any cursor-effect bytes (only 1048 matters; trivially satisfied by param sort).

### Round 3 additions

- **Finder-flagged critical (#1/#2/#3) — clear-rule redesign (coupled, generation-scoped)**: the naive "clear at first applied write of a non-stale generation" fails because old-generation live output can apply onto a recreated surface (queue reborn with `activeGeneration === undefined` ⇒ nothing stale) and because post-user-reset live output of the *current* generation would clear the flag before any marker attach exists. Final rule: `surfaceFreshMarker: { attachRequestId } | null`. When an attach is SENT with the flag true, record its `attachRequestId`. CLEAR (flag=false, marker=null) only when `createTerminalWriteQueue`'s new optional `onItemApplied(item)` hook fires at terminal-write-queue.ts:134 (the stale-guard proven release point at :133) AND `item.generation === marker.attachRequestId` AND `item.mode === 'replay'`. In practice the clearing write IS the sync write itself (or the first retained-replay write of that generation). Local 'live' notices are excluded by mode; stale generations excluded by the guard; pre-send socket death leaves flag true (trap-door held). Defensive parity: direct-write fallback site (:1680-1704) only fires when the queue is absent (no attach in flight) — clear impossible there, no hazard.
- **Codex recovery corner (#5, Node-only)**: recovery PTY output is emitted into the ring before `terminal.stream.replaced` publishes (emitter at terminal-registry.ts:3825-3831, publication at :3727-3732), so death-on-replace would discard the new process's startup burst. Rule: on `replaceStreamIdentity`, the tracker is NOT discarded; it is reset and re-scanned over the retained ring (terminal-state remains at broker.ts:~2176; ring survives replacement by design — round-1). Bounded cost (ring ≤ configured cap), exact truth for the live process (ring order ⇒ new burst's transitions win). Rust has no replace lifecycle (grep-confirmed) — explicitly asymmetric, fixture coverage Node-only.
- **Synthesis set narrowed (#9/#21)**: tracker still records everything, but the synthesized BYTES exclude `?2026` (per-frame rendering hint; arming on a wedged mid-frame state could stall paints; never a user-visible regression when absent) and all XTMODIFYKEYS `>Pm m` (xterm 6.0.0 implements zero modifyOtherKeys handling — verified zero bundle matches; kept tracked for fidelity + future). Synthesized set = mouse protocol slot, SGR encoding slot, flat ?Pn (focus 1004, bracketed paste 2004, cursor visibility 25, alt fold 1049, others tracked), that order-sorted, `?1049h` ahead of any cursor-affecting bytes.
- **Server emission guard (#16)**: server skips sync emission when the attach lacks `attachRequestId` (schema keeps it optional; client would fail closed with `missing_attach_request_id` anyway).
- **Fixture contract switch (#13/#14)**: fixtures are raw shared OUTPUT STREAMS + `{ surfaceReset, expectedSyncData }` (not tracker-state serialization — avoids a second cross-language contract + a hydrate entry point); the 128-entry-eviction divergence window (Map-LRU vs IndexMap/BTreeMap choice) is excluded from parity scope; spec mandates insertion-order eviction structure on both sides for hygiene.
- **Test topology notes (#8/#10/#12)**: Node dead-attach rejection (INVALID_TERMINAL_ID at ws-handler.ts:2759-2774) is untouched — sync+exit adjacency is Rust-only e2e, Node unit pins the error path. Renderer-recreate e2e leg must INDUCE its attach (no automatic re-attach post-recreate — verified the attach effect dep list has no recreate signal): drive it via `panes/requestPaneRefresh` dispatch or a page reload, with the heartbeat emitter streaming in the gap so the test discriminates the coupled clear rule. xterm focus reports fire only on real focus transitions, not on 1004-arm — hazard test's invariant is just "no focus event during the settle window" (construct-once focus :2234 precedes any attach; refresh chain has zero focus calls).
- **Validated downward (no plan change)**: empty/quiet attach bookkeeping is sync-orthogonal (#17); supersede-before-ready ordering holds on both servers with stale-drop covering old-generation sync content (#18); harness seams all exist incl. accessor anchoring (#19); contract/inventory mechanics incl. regen-before-rust-test ordering (#20); sync-write-order FIFO within single socket (#D.6); extractor monopoly (#D.3-4).

### Round 4 corrections (survival audit)

- **A(ii) FALSIFIED → completion-clear added; downgrade flips clearViewportFirst:false→true.** The coupled clear had a silent-forever shape: empty sync (empty tracker) + empty replay → no `mode:'replay'` item of the marker generation ever applies → flag never clears → every later attach full-replays FROM 0 and APPENDS onto the already-hydrated surface (duplicated scrollback; the round-3 "sync-orthogonal" verdict stopped being true once the flag forces hydrate). Fix: clear flag+marker additionally at the two generation-bound attach-completion edges — `completeAttachGeneration` (TerminalView.tsx:3551-3575, generation-checked at :3558, reached from the write path and the no-write replay queue-task at :3620-3630) and the no-pending-replay `markAttachComplete` at :4212-4221 (under the current-attach gate). And the downgrade now sends `clearViewportFirst: true` (wipe-then-full-replay: no-op on genuinely fresh surfaces, self-healing on stuck-flag shapes). User-reset SET site also NULLS the marker (A(iii): prevents a pre-reset in-flight marker from satisfying a post-reset clear).
- **B FALSIFIED → no rescan; keyed rebirth, premise corrected.** Whole-ring rescan would inject old-process modes when the new process is silent. Round-3's premise was itself wrong: candidate-PTY output pre-publication is DROPPED at the registry (guards terminal-registry.ts:3826, :1752), publication+emit are one synchronous block (:3727-3728), and appends stamp the CURRENT identity at call time — ring content is strictly streamId-partitioned, and the production replay already filters to current-stream frames (`filterReplayFramesForStream`, broker.ts:1067-1089). Final rule: on replace, reset tracker to defaults (key (terminalId, streamId); old key dies, new key born — exactly the L5 lifecycle). No retrospective truth exists to lose.
- **C: survives with two strengthened pins (tests):** `output_frame_meta(&modes_sync).is_none()` at crates/freshell-terminal/src/output_queue.rs (location correction from round 3: freshell-terminal, not freshell-ws) PLUS the direct-lane routing pin (at the time: `ConnectionOutputQueue::route(modes_sync).is_some()` covering the TerminalExit carve-out at backpressure.rs; after the connection-writer split, `crates/freshell-ws/src/connection_writer.rs`'s `push_server` routes modes.sync to the control lane by construction — the adapter was retired).
- **D small additions:** plan tasks now include threading `surfaceReset` through both servers' attach ingress (ws-handler.ts:2786-2838 structural type + call sites; broker attach signatures; terminal.rs ingress; registry.attach params). Server skips emission when sync data is empty (with completion-clear this is provably safe). Emission keys on `surfaceReset` REGARDLESS of wire intent — hidden fresh surfaces attach as keepalive_delta sinceSeq=0 and must receive sync (background hydration is exactly where recreated hidden panes get modes before reveal).

### Round 5+ / fresheyes loop (5 iterations, never a clean PASS; dispositions)

Fresh-eyes rounds landed real fixes (stale-actions wipe regression →
marker-gated wipe; wire-observed sync assertions; stale XTMODIFYKEYS doc
claims; e2e arm-command `[>4;1m` typo; user-reset reconnect duplication
→ surfaceWritesSinceFresh wipe gate + unit regression; Node/Rust u32 param
parity; XTM map now capped at 128 with eviction both sides; `?7l` DECAWM
disable restores via trailing disable — fixture f16, f17 new), plus a volume
of fabricated round-2 findings refuted by greps and recorded below. Round 5's
alt-buffer early-arm deliberation stays an accepted round-1 residual
(bounded artifacts; app self-repaints; sync-first required for the common
in-alt case). Final gate: full suites green locally; e2e 6/6.

### Round 5 / implementation-era resolution (hazard closure)

- **Downgrade wipe refinement landed (marker-gated):** the forced
  `clearViewportFirst` wipe applies only when a marker exists (i.e., an
  earlier claim was abandoned mid-hydration — the trap-door case the wipe
  exists to heal). Genuinely fresh first attaches (flag set at
  construction/user-reset, marker null) skip the wipe; this also removes a
  spurious `term.clear()` that broke the stale-actions lifecycle invariant
  (TerminalView.keyboard.test.tsx).

- **xterm 6.0.0 fires an immediate focus report on EVERY `?1004` arm**
  (InputHandler DECSET-1004 → `_onRequestSendFocus` → `_reportFocus` emits
  `ESC[I`/`ESC[O` gated only on the surface's current focus class, not on a
  real transition). Consequences: (a) the sync preamble must NEVER emit
  `?1004h` — landed as track-but-never-emit in both synthesis sets (README
  rule 2 updated; fixture f11 + unit expectations carry the rationale);
  (b) a pre-existing leak where replaying the ORIGINAL arming byte from the
  retained window re-fires the report — not in this branch's scope; tracked
  as kata 9gy8.
- Happy-path e2e claim-count relaxed post-boot supersession: multiple fresh
  claims are legal (claim clears only on marker completion), assertions pin
  all-claims-full-hydrate + post-hydration non-claim instead.
- Renderer-recreate e2e leg folded: construction is a single code site
  (unit-pinned); e2e covers reload + refresh classes instead. Rust-leg
  Emitted-sync exclusion verified live for chromium/legacy/rust e2e legs.

## Design (final)

**Server tracks a per-terminal emulator-state projection from the output stream; the client marks attach frames with `surfaceReset` only when its xterm surface is fresh; on such attaches (only), the server emits one `terminal.modes.sync` message (attachRequestId + streamId + data) immediately after `terminal.attach.ready` and before replay; the client writes it through the generation-gated write queue with replay-side-effect suppression. Everything else (seq accounting, replay content, ring contents, other sockets) is untouched.**

### 1. Mode tracker (both servers, one spec)

- Placement: Node — inside `ReplayRing.append` next to `barrierScanner` (replay-ring.ts:62-63), scanning the pre-normalize `data`; serve-lived at `getOrCreateTerminalState` (ring birth). Rust — inside `registry.rs ingest` beside `s.scanner` (:2614), per-terminal existing scanner slot.
- String-domain state machine: CSI openers `ESC[` + U+009B; finals `h/l` for `?Pn` (DEC private), final `m` for `>Pm` (XTMODIFYKEYS resource sets, incl. `>4;m`/`>4;0m` clears); plain `ESC c` (RIS → clear protocol slot + encoding slot + all tracked DEC privates except 25 which xterm leaves); `CSI ! p` (DECSTR → apply the verified DECSTR table: clears ?1,?6,?45,?66,?1004,?2004,?2026, cursor visibility(25), margins, saved cursor; NOT mouse families); `$p`/`$y` finals never mutate (DECRQM guard).
- State: protocol slot ({9,1000,1002,1003}), encoding slot ({1006,1016}), flat map of other tracked ?Pn, XTMODIFYKEYS resource map, alt-folded {47,1047,1049}. 64-code-point carry, U+FFFD resync, 128-entry overflow eviction (log).
- Lifecycle (L5 spec): keyed to (terminalId, streamId); Node birth at getOrCreateTerminalState, extra death at replaceStreamIdentity; dropped at exit (Node broker exit) / kill (Rust row removal).

### 2. Preamble synthesis + sync emission

- Byte shape from tracker state: deterministic param-sorted sequence of `CSI ? Pm h` enables (protocol slot leader; encoding slot leader; then flat modes ascending), `?1049h` placed before any other cursor-affecting bytes (only 1048 interplay; none emitted standalone). XTMODIFYKEYS `>Pm m` is TRACKED but never emitted (round-3 narrowing: xterm 6.0.0 has no modifyOtherKeys handling), as is `?2026` (per-frame rendering hint) and `?1004` (round-5: xterm fires an immediate focus report on every arm → deterministic stdin junk).
- Emission condition: `attach.surfaceReset === true` only. Node insertion broker.ts:520-522 (after ready guard, pre-gap); Rust insertion registry.rs:1262 (after `sink(ready)`) — including the dead-terminal Exited path (sync of frozen state is correct for retained-tail rendering; client must tolerate sync-immediately-followed-by-exit edge).
- Payload: `{ type:'terminal.modes.sync', terminalId, attachRequestId, streamId, data }`. No seq fields (control-plane).
- Direct-channel pin (Rust): test that output_frame_meta returns None for TerminalModesSync.

### 3. Client changes (minimal, two files)

- `shared/ws-protocol.ts`: `TerminalAttachSchema` +`surfaceReset: z.boolean().optional()`; new `TerminalModesSyncMessage` TS type (previousSessionId modeling precedent: TS-type-only, server→client, not client-validated) in `ServerMessage` union. `crates/freshell-protocol`: TerminalAttach +`surface_reset: Option<bool>` (skip_serializing_if); server_messages.rs new variant + `SERVER_MESSAGE_TYPES` 57→58; tests/inventory.rs counts 57→58 / 87→88; fix the stale "52 discriminants"/"27 discriminants" header comments (pre-existing drift).
- `TerminalView.tsx`: `surfaceFreshRef` (SET at xterm construction :1992→:2048 & user reset :2215; CLEAR per the coupled rule in §Round-3): marker generation recorded at marker-bearing send; new `createTerminalWriteQueue` optional arg `onItemApplied(item)` fired at terminal-write-queue.ts:134 (behind the :133 stale-guard) — TerminalView clears iff `item.generation === marker.attachRequestId && item.mode === 'replay'`; `attachTerminal` downgrade rule (`surfaceFresh ⇒ intent='viewport_hydrate', sinceSeq=0, clearViewportFirst:false`, before the hidden clamp swap); pass marker into buildTerminalAttachMessage; new embed handler at the :3486 chain (sizing of the writeQueue null-drop window: recreate gap — self-healed by the coupled clear rule's flag survival; LOG the drop for diagnosability):
  ```ts
  if (msg.type === 'terminal.modes.sync' && msg.terminalId === tid) {
    if (!currentAttachRef.current) return
    if (!isCurrentAttachStreamMessage(msg)) return
    if (typeof msg.data !== 'string' || msg.data.length === 0) return
    writeQueueRef.current?.enqueue(msg.data, undefined, { mode: 'replay', generation: msg.attachRequestId })
  }
  ```
- Port-contract regen committed in the PR; CI already gates regen idempotency.

### 4. Parity fixture

One shared JSON family `port/oracle/baselines/mode-preamble/*.json` (input: tracker state serialization + attach flag; expected: sync data bytes). Consumed by Rust unit tests and Node vitest unit tests (mirrors the baselines/batch golden pattern). Budgeted CI step: add `cargo test -p freshell-terminal` (at least the fixture test) to port-contract.yml — currently missing (G5-A1).

### 5. E2E (multi-client.spec.ts, both matrix legs)

- Happy path: emitter pane sets `?1003h ?1006h ?1049h >4;1m` once, heartbeats; reload page; via new harness accessor `getTerminalModes(terminalId)` (additive, per G5 sketch — returns IModes + bufferType) assert `mouseTrackingMode==='any'` + `'alternate'`; `page.mouse.wheel` over pane → `terminal.input` with `\x1b[<64;` on wire.
- Hazard closure (SHIPPED FORM, updated): the ?1004 focus-report hazard is
  pinned at WIRE level — the reload path's sync frame must exist, be ordered
  before replay, contain the armed-mode bytes (?2004h), and NEVER contain
  1004. The original plan's "dispatch panes/requestPaneRefresh and assert
  zero focus junk" shape was abandoned because xterm 6.0.0 re-fires a focus
  report on ANY arm — including the REPLAY of the original arming byte while
  it is still inside the retained window — a pre-existing leak (kata 9gy8)
  that would make any junk-free window assertion conflate two distinct
  mechanisms. **RESOLVED (follow-up branch the-usual/kata-9gy8-focus-silence)**:
  replay-sourced focus reports are silenced at the client onData gate;
  see docs/plans/2026-08-17-kata-9gy8-replay-focus-silence.md. The
  sync-exclusion wire pin is the property this branch owns.
- Marker-forcing rule coverage: renderer-recreate (settings change) → next attach has surfaceReset=true AND sinceSeq=0 (no delta-on-blank-surface).

### 6. Live verification (same shape as PR#649 Task 3)

Scratch dev instance (setsid, pinned ports, owned process-group teardown), long-lived real opencode pane, hard refresh, immediate wheel scroll works; pane refresh produces no junk input; user-reset + reconnect reproducibility sweep.

## Tasks

1. **Rust**: mode scanner (string-domain; verified tables), tracker at ingest, sync emission at registry attach, direct-channel pin test, fixture consumption. TDD.
2. **Node parity**: same in ReplayRing/broker (getOrCreateTerminalState birth, replaceStreamIdentity death, pre-normalize scan ordering), broker.ts:520 insertion, fixture consumption.
3. **Client + protocol**: schema/type additions, surfaceFreshRef lifecycle, attach downgrade rule, sync handler, port-contract regen, inventory counts fix, unit coverage (lifecycle file).
4. **E2E** per §5 (accessor additive surface included).
5. **Live verification** per §6 + gate (`npm run check` + cargo workspace green modulo ledgered flakes jgpc/ep0f/xqfc) + whole-branch review.

## Acceptance

- E2E green on both servers, incl. hazard-closure and marker/downgrade assertions.
- Live hard-refresh mouse-scroll regression not reproducible; pane refresh produces no junk input.
- Gate green modulo ledgered pre-existing flakes.

## Accepted residuals (all deliberately surfaced and chosen)

- Cross-server-restart adoptions (Rust inventory/restore): a terminal row
  born at adoption starts with an EMPTY tracker; arms that scrolled out of
  the server's own retained replay before the restart are not projectable.
  Strictly better than pre-feature behavior (nothing was ever restored),
  bounded by retained-window pinning; surfaced by fresh-eyes round 2’s only valid corner.
- Fresh-eyes round 2 was otherwise fabricated (verified by grep/code):
  no `populate_keyset_error_ids` function exists anywhere in crates/; tracker
  construction sites are both row-birth (registry.rs :1063/:1973), never
  per-attach; replay-ring.ts has no rebuild site; the cited frame logs name
  a marker (`__MODESYNC_HZ__`) and helpers (`wireReplayStreaming`) that do
  not exist in the spec; every claimed-attach wire assertion in the e2e
  suite pins sinceSeq=0 (no delta claim can race a fresh surface).

- Kitty keyboard `>7u/<u` stack not tracked (needs own cycle; kodas: to file).
- `?1004h` on a fresh surface may cause one synthetic focus report to reach apps that armed 1004 — mirrors what the app requested at startup; drop from synthesized set if noisy in practice.
- Bounded 1049 artifact: if the app later exits alt in live streaming after an in-window freshell-era entry, normal-buffer contents/cursor are approximate (Case-1/Case-2 tables, Validator E). Self-heals on repaint; accepted.
- User-reset asymmetry (A-5.2): if a ws attach happens before any output after a user Reset, history replays from 0 (reset ephemeral) rather than staying wiped; after any applied output the wipe persists via delta continuity. Chosen: server history is authority; Reset wipes the VIEW only.
- Sync-immediately-followed-by-exit (Rust dead-terminal attach) is legal on the wire; client tolerates (sync applies, then synthesized exit).
- Same-attachRequestId literal duplicate: Node suppresses (broker.ts:344-347), Rust re-emits idempotently. Idempotent re-assert on a fresh surface is safe by the fresh-surface premise (A3 premise owned by marker design).

## Katas to file on landing

- Kitty keyboard stack replay loss (deferred this branch).
- `cargo test -p freshell-terminal` missing from port-contract.yml (add in this branch; kata only if descoped).
