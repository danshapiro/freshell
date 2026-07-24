# freshell → Rust/Tauri port — Equivalence Report (Phase 4 self-QA capstone)

**Generated:** 2026-07-05 (self-QA sweep, run end-to-end this session)
**Worktree:** `/home/dan/code/freshell/.worktrees/rust-tauri-port`
**Branch / HEAD:** `feat/rust-tauri-port` @ `c65b0355` (Phase 3.15 — REST/WS breadth)
**Host:** Linux 6.6.87.2-microsoft-standard-WSL2 (WSL2), `chromium-linux` snapshot platform
**Toolchain:** cargo 1.96.0 · node v22.21.1 · vitest 3.2.4 · playwright 1.58.2 (chromium-1200 / 145.0.7632.6)
**Reference (“the original”):** the pristine TS/Electron freshell (`server/` + `shared/` byte-unmodified; the React SPA retained unchanged in the port). `git diff server/ shared/` was **empty at every step**.

> **Reading this report honestly.** This is a QA capstone, not a victory lap. The oracle
> is a *differential* one: the port is graded equivalent to the original **except** for the
> adjudicated deviations in the ledger. Where a tier is not a clean pass, it is written up as
> a **finding**, not smoothed over. Nothing here was force-passed. (Update, commit `093c1050`:
> the one live tier that flaked this sweep — **T2 opencode** — has since been made deterministic
> and re-confirmed `original≡rust` stable across two live runs; see §T2.)

---

## 0. Verdict at a glance

| Tier | What it proves | Result (real numbers) | original ≡ rust? |
|---|---|---|---|
| **Rust build** | 11 crates compile + unit/integration green | **400 passed / 0 failed / 0 ignored** (`--exclude freshell-tauri`: 358; `freshell-tauri`: 42) | — |
| **T0 protocol** | WS handshake conforms to frozen contract + matches original | **5 / 5** · 4 server→client msgs schema-conformant · two-boot determinism | ✅ **deep-equal = true** |
| **T1 terminal** | Real PTY bytes reproduce over the wire | **10 / 10** · all 4 goldens sha256-identical | ✅ **byte-identical** (framing differs, bytes identical) |
| **T2 opencode/Kimi** | Live cheap-model turn holds invariants + matches baseline | invariants **9/9** PASS · liveModelCalls=1 · cold-start clean | ✅ **structural deep-equal** (after the §T2 determinism fix `093c1050`; re-run twice, stable msgs=2) |
| **T2 codex/gpt-5.3-codex-spark** | ″ | **2 / 2** · liveModelCalls=1 | ✅ **structural deep-equal** |
| **T2 claude/Haiku** | ″ (Node sidecar) | **2 / 2** · liveModelCalls=1 | ✅ **structural deep-equal** |
| **Mutation-validation** | The oracle actually *catches* divergence | **28/28 planted caught · 5/5 no-false-positive · GAPS: 0** (36 tests) + e2e **RED→GREEN** (3 tests) | ✅ oracle proven to detect |
| **T3 e2e / visual** | Retained SPA runs on the Rust backend, indistinguishably | **117 / 126** externally-targetable · **6/6 visual baselines MATCH** | ✅ except **1 PORT-GAP** (browser-pane proxy); 8 fails are red-on-original too |

**Live model calls this sweep: 3 total** (one per provider; each harness reported `liveModelCalls=1`). **0 orphan processes; user’s live `:3001` (pid 1262455) untouched; source byte-pristine; nothing committed.**

**Headline (honest):** the Rust port is **equivalence-proven on T0, T1, mutation-validation, all three T2 providers, and T3 (minus one deferred surface)**. The **T2 opencode** structural baseline flaked *this* sweep on two async-SQLite-flush-timing fields (the opencode `serve` binary, not the port, authors that DB); the follow-up commit `093c1050` made the harness wait for the durable assistant message row and re-confirmed `original≡rust` **stable across two live runs** (msgs=2 both). See §T2 for the full write-up of the original finding and its resolution.

---

## 0.1 Addendum — follow-ups landed after this capstone (2026-07-06)

The capstone above was written mid-Phase-3. These follow-ups landed after it; all are committed
and pushed, source still byte-pristine:

- **3.16 Terminal batch framing** (`freshell-terminal`): the stateful VT barrier scanner + the
  `terminal.output.batch` builder with **UTF-16** `endOffset`/`serializedBytes` (4-pass fixpoint) +
  the char `ChunkRingBuffer` attach snapshot. Proven env-independently: `batch_wire_golden` 2/2 +
  `t1-batch-equivalence-rust` 44/44 (incl. an emoji/CJK case proving `endOffset` is UTF-16 code
  units, not bytes). Single-frame T1 path unchanged/byte-identical.
- **3.17 Tauri desktop features** (`freshell-tauri`): tray, global hotkey (+ accelerator translation,
  xvfb-live-registered), window-state persistence (+ off-screen clamp), wizard + launch-chooser
  windows (per-window capabilities), updater config, renderer-recovery decision core. 89 new unit
  tests. Display/signing-gated items (tray render/click, OS keypress, live update, rendered
  wizard/chooser) are flagged fixture/manual — not faked.
- **ENV-0001 (raised + RESOLVED):** capturing live batch goldens surfaced the live node-original
  uppercasing PTY output. Antagonist REJECTED a proposed case-fold oracle-weakening; root-cause
  re-check proved it was a **stale `dist/server` build** — a clean rebuild restored byte-exact
  output (`t1` 10/10 + `t1-batch` 44/44, **0 skips**; self-extinguishing quarantine retained). The
  Rust port was byte-for-byte correct throughout. See DEVIATIONS.md ENV-0001.
- **3.18 REST breadth** (`freshell-server`/`freshell-ws`): browser-pane loopback reverse-proxy +
  `POST /api/screenshots` + `ui.screenshot.result` WS round-trip + files read/write/stat/mkdir.
  Full external e2e is now **118/126** — the sole genuine port-gap (`browser-pane-screenshot:56`)
  closed; **the remaining 8 are EQUIVALENT (red on the pristine original too)**, so the port now
  reproduces the original's **exact e2e pass/fail profile**. Mutating netsh/elevated NOT executed
  live (golden-string only, per safety).

**Updated tally:** 11 Rust crates + 1 Node sidecar; `cargo` workspace + oracle all green; the port
is equivalence-proven original≡rust on **all four tiers** (T2-opencode determinism fixed;
ENV-0001 resolved). Remaining is honestly-bounded (see §"what remains"): the off-host ceiling
(macOS; live Windows-elevated netsh/UAC) + the 8 EQUIVALENT-red-on-original specs (pre-existing,
CI-rotted on the original) + a few deep endpoints no failing spec gates.

---

## 0.2 Addendum — this-host campaign re-verification (2026-07-10 → 2026-07-14, SurfaceBookPro9 WSL2 + native Windows)

The self-driving port campaign (port/HANDOFF.md §9 queue, tasks 001–009, commits `8735bfce..HEAD`)
re-proved and extended the capstone above on THIS host. Everything below is evidence-linked to
committed artifacts.

### 0.2.1 Tier counts on this host (final, at task-009 close)

| Gate | Result on this host |
|---|---|
| Oracle deterministic suite (T0+T1+batch+mutation+pins) | **174 passed / 6 skipped** (the 6 = T2 live gates), re-run after every crate change; last run at `aadd41a6` |
| REST parity sweep (`port/oracle/rest-parity/sweep.mjs`) | **187/187** original ≡ rust (incl. 22-case terminal-search battery, zod-v4 byte shapes, PATCH/DELETE, session-directory) |
| Cargo workspace | **41 suites green** (incl. freshell-tauri 145) |
| T2 live (this host, task-008) | claude ✅ deep-equal, codex ✅ deep-equal (`liveModelCalls=1` each); **opencode SKIPPED — credentials absent, escalated** (`port/oracle/t2-live-rust-2026-07-14.md`) |
| Robustness battery (§7.I) | storm/multi/scroll/kill-9/SIGTERM **EQUIVALENT** (`port/oracle/robustness/report-2026-07-13.md`); 100k-line scrollback replay byte-identical (689191 bytes both) |
| Indexer seeded-home differential (§7.I.5) | 12 fixture variants (incl. multibyte + invalid-UTF-8) + cursor chain **EQUAL deep-key-sorted** (found+fixed lossy-read parity, `959e9d9b`) |
| Interchange (§7.F) + Tauri window-state (§7.H.4) | all legs PASS, 9/9 skeptical vision PASS (`port/oracle/interchange/report-2026-07-14.md`) |

### 0.2.2 Client × server matrix (this host; every leg vision-verified per §8.4)

| Client | Server | Evidence (screenshots + reports, `port/oracle/matrix/` unless noted) |
|---|---|---|
| Chromium | original 17871 (WSL) | `sbp9-orig-chrome-*.png` (overview/wsl/cmd/powershell/claude/codex/opencode/editor/browser), `vision-review-chrome-2026-07-11.md` |
| Chromium | rust 17872 (WSL) | `wsl-chrome-*.png`, `vision-review-chrome-2026-07-11.md` |
| Chromium | rust 17873 (native Windows) | `win-chrome-*.png` (incl. gemini) |
| Chromium — per-provider rendering differential (task-006 §7.D.4) | rust 17872 vs orig 17871 | `t6-wsl-chrome-{claude,codex,opencode,overview}.png` + orig leg, harness 3/3 PASS both, vision 6/6 PASS: `vision-review-t6-2026-07-13.md` |
| Tauri leg A (app-bound, spawns own rust server) | rust (app-bound) | `sbp9-tauriA-report.json`, `vision-review-tauri-2026-07-11.md` |
| Tauri leg B (remote mode, first live `provisioning.rs` run) | rust 17872 | `vision-review-tauri-2026-07-11.md` |
| Tauri + Chromium simultaneously (§7.F leg 4, liveness-controlled) | rust 17872 | `port/oracle/interchange/tauri-r16-{1..4}*.png` |
| Tauri window-state restore/clamp (§7.H.4) | rust 17872 | `port/oracle/interchange/ws-r16-run{1,2,4}-*.png` + `tauri-ws-r16-run*.log` |
| Electron (built from source) | rust 17872 (WSL) | `sbp9-elwsl-*.png`, `vision-review-electron-2026-07-11.md` |
| Electron | rust 17873 (native Windows) | `sbp9-elwin-*.png` |
| Client-interchange (same token, URL-only switch; cross-client) | 17871↔17872↔17873 | `port/oracle/interchange/leg{1,2,3}-*.png`, `interchange-results.json`, `report-2026-07-14.md` |

### 0.2.3 User-facing disclosures (council-mandated, verbatim from `port/oracle/DEVIATIONS.md`)

- **DEV-0006:** "codex panes in the Rust build run standalone, without freshell's managed
  app-server integration."
- **DEV-0007:** "On native Windows, coding-CLI panes do not receive their bootstrap
  `--settings`/hook payload — claude starts and prints a settings error (in the original it fails
  to launch at all via the default shell). This is a known, permanent condition of the current
  Windows shell-quoting pipeline; no workaround exists." (Council standing note: a user-reachable
  known-issues note is recommended at productization; product-surface decision, not taken here.)
- **DEV-0008:** "On the Rust server, live sidebar terminal metadata badges (git branch/dirty
  state, token usage) are not populated at all: the push channel that feeds them is not
  implemented, so those badges stay absent for the life of a terminal — they never show stale
  data, they show none. Terminal titles and the session directory still load and refresh via REST."
- **DEV-0004** (port-side bounded fix, disclosed): the updater's GitHub update-check is bounded at
  5s in the rust build (the original's fetch is unbounded); on a hung GitHub API the rust
  `/api/version` returns with `updateCheck` omitted instead of hanging.
- **DEV-0005** (original defect, bug-for-bug preserved surface): WSL-hosted `cmd` panes land in
  `C:\Windows` with two error banners — identical in original and port (see ledger for the
  adjudicated handling).

### 0.2.4 ENV-LIMITED / honest ceiling on this host (final enumeration)

1. **macOS: spec-only.** No macOS host; all macOS behavior unexercised (unchanged from §9).
2. **Elevated Windows `netsh`/UAC mutation: never executed.** Golden-string-only (§9.2).
3. **Windows opencode: absent** — opencode is not installed on the native-Windows side; the 17873
   matrix legs omit it (`vision-review-t6-2026-07-13.md` note).
4. **T2 opencode live on this host: credentials absent** (task-008 escalation):
   `~/.local/share/opencode/auth.json` does not exist and `opencode.jsonc` has no umans provider
   config. The one human dependency; original-side baseline committed, rust re-run is
   credential-only. Proof: `port/oracle/t2-live-rust-2026-07-14.md`.
5. **App-bound Electron SIGKILL semantics + `electron:build:win`**: proven only to the depth in
   `port/oracle/matrix/parity-desktop-2026-07-11.md` (WSLg/source-build ceiling; no signed
   packaged installer on this host).
6. **8 EQUIVALENT-red T3 specs** (+ the `:98` flake ruling): red on the pristine original on this
   host too — findings against the CI-rotted reference, not port gaps (§8).
7. **`pty-determinism-t1` echo-hello**: FLAKY-on-original under load (ruled at task-006: 2/3
   focused + full-suite green); re-run focused before believing a red.
8. **PORT-GAP-002**: DISCHARGED at task-005f (`b90b1d5d`) — search ported + byte-matched;
   viewport/scrollback remain YAGNI-deferred with the 404 pin (§8 status update).
9. **terminal.meta.updated push subsystem: DEV-0008 documented gap** — `terminals.changed`
   WS-lifecycle parity PORTED (aadd41a6); the metadata push closes together with DEV-0006's
   sidecar-lifecycle scope.
10. **WSLg Weston window-position offset**: the compositor applies +(6,27) to EVERY window move
    request (proven with a plain `xdotool windowmove` control) — Tauri window-state SIZE restore
    is exact; POSITION exact-restore is unverifiable on this display server (any client,
    including the Electron reference, gets the same shift). `port/oracle/interchange/report-2026-07-14.md`.
11. **Windows ConPTY exit/kill wedge**: found + fixed in the port at task-006 (`2eae97dd`);
    native-Windows kill/exit lifecycle live-verified on 17873 after the fix.

---

## 1. Rust crate map → which oracle tier proves each

The workspace has **11 Rust crates + 1 Node sidecar** (`cargo metadata --no-deps` = 11 packages; `freshell-claude-sidecar` is the one sanctioned Node package per ADR Decision 2 and is excluded from the cargo workspace).

> **Correction to the task brief:** the brief said “13 Rust crates.” The real, current workspace
> is **11 Rust crates** (+1 Node sidecar). Reported as measured, not as briefed.

| # | Crate | Kind | Tests (this sweep) | Proven by |
|---|---|---|---|---|
| 1 | `freshell-protocol` | Rust | 18 (inventory 3, roundtrip 10, version 5) | **T0** — 27→52 msg roundtrip vs frozen schema |
| 2 | `freshell-platform` | Rust | 135 (unit 98, detect 4, path 13, spawn 15, wsl_fallback 5) | platform goldens; feeds T1/T3 spawn+bind |
| 3 | `freshell-terminal` | Rust | 36 (unit 35, `t1_golden_repro` 1) | **T1** — PTY byte goldens |
| 4 | `freshell-ws` | Rust | 8 | **T0/T1** wire |
| 5 | `freshell-api` | Rust | 2 | **T0** REST surface |
| 6 | `freshell-server` | Rust | 18 | **T0/T1/T3** — boots the SUT |
| 7 | `freshell-sessions` | Rust | 28 (unit 6, claude-parity 10, codex-parity 2, **late_root_watcher_liveness 4 = DEV-0002**, opencode_sqlite 6) | **T2** transcript + **DEV-0002** liveness |
| 8 | `freshell-opencode` | Rust | 34 (unit 25, **serve_health_bounded 3 = DEV-0001**, serve_idle_edge 6) | **T2 opencode** + **DEV-0001** bounded probe |
| 9 | `freshell-codex` | Rust | 55 (unit 48, app_server_drive 4, completion_gating 3) | **T2 codex** + **DEV-0003** (verbatim effort) |
| 10 | `freshell-freshagent` | Rust | 24 | **T2** fresh-agent spine |
| 11 | `freshell-tauri` | Rust | 42 (unit 41, server_spawn_smoke 1) | **T3** desktop shell (xvfb-smoked only — see §Limitations) |
| — | `freshell-claude-sidecar` | **Node** | (driven live in T2 claude) | **T2 claude/Haiku** |

Raw sweep output (both invocations, exit 0):

```
cargo test --workspace --exclude freshell-tauri  → 358 passed; 0 failed; 0 ignored (35 result groups); 0 warnings
cargo test -p freshell-tauri                     →  42 passed; 0 failed; 0 ignored
                                        TOTAL      → 400 passed; 0 failed; 0 ignored
```

---

## 2. T0 — protocol/handshake equivalence

`test/unit/port/oracle/t0-equivalence-rust.test.ts` → **5/5 passed** (2.0 s). Boots the original (node) once and the Rust server twice on isolated ephemeral loopback ports.

```
[T0-eqv:rust] captured 4 server→client messages ({"ready":1,"settings.updated":1,"perf.logging":1,"terminal.inventory":1});
              validated 4, unknown types: [], conformant: true
[T0-eqv] original pid=… port=… msgs=5 [out:hello, in:ready, in:settings.updated, in:perf.logging, in:terminal.inventory]
[T0-eqv] rust     pid=… port=… msgs=5 [out:hello, in:ready, in:settings.updated, in:perf.logging, in:terminal.inventory]
[T0-eqv] original≡rust deep-equal: true
```

- (a) every Rust server→client message validates against the frozen `ws-server-messages.schema.json`; **0 unknown types**.
- (b) two fresh Rust boots normalize **deep-equal** (port is deterministic).
- (c) **THE PRIZE:** original- and rust-normalized handshakes are **deep-equal** (canonical-string identical).
- Ownership-safe teardown reaped all 3 spawned pids.

---

## 3. T1 — terminal byte-stream equivalence

`test/unit/port/oracle/t1-equivalence-rust.test.ts` → **10/10 passed** (3.3 s). Drives 4 deterministic PTY scenarios through the original and the Rust server, reassembles the `terminal.output` byte stream, sha256-compares.

```
scenario           bytes  sha256(prefix)   rust frames  node frames   original ≡ rust
echo-hello          7B    cd2eca353574…       18           16          true
seq-3               9B    2afa7715181f…        8            8          true
fixed-width-fill   42B    b30b0d73ca0f…        7            8          true
multi-line         16B    6c9d63a3e00a…        8            9          true
```

**Honest nuance:** the **frame boundaries differ** (node-pty vs portable-pty chunk the stream differently), but the **reassembled bytes are identical** (sha256 match). T1 proves *byte-stream* equivalence, deliberately **not** frame-count equivalence — framing is a non-semantic, normalized-away difference. This is the core port-fidelity thesis (node-pty → portable-pty), proven.

---

## 4. T2 — live behavioral-invariant equivalence (3 live calls total)

All three drive **one real turn** with the cheapest reachable model and a tiny pinned prompt, through the **Rust** server, in an **isolated HOME** seeded read-only from the user’s real credential store (mtime-verified untouched). Gate: `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`.

### 4.1 codex/`gpt-5.3-codex-spark` — ✅ PASS (2/2)
```
[T2-codex-rust] original ≡ rust: structural projection deep-equal ✓ (codex app-server over the wire)
liveModelCalls=1 · :3001 untouched
```
Structural projection deep-equals the committed baseline (`codex-gptmini.json`), completion on the status-guarded `freshAgent.turn.complete` edge. DEV-0003 honored (effort forwarded verbatim, no clamp).

### 4.2 claude/Haiku (Node sidecar) — ✅ PASS (2/2)
```
[T2-claude-rust] original ≡ rust: structural projection deep-equal ✓ (Node claude-sidecar over the wire)
liveModelCalls=1 · user ~/.claude/.credentials.json mtime unchanged · :3001 untouched
```
Structural projection deep-equals `claude-haiku.json`. The DEV-0002 late-root crash path is *not* exercised here (harness pre-creates `~/.claude/projects` for env parity); it is carried solely by the port liveness pinning test (green — see §Ledger).

### 4.3 opencode/Kimi-k2.7 — ✅ RESOLVED (commit `093c1050`): invariants PASS + structural deep-equal after the harness determinism fix

> **Resolution:** the finding below was a harness read-timing race, now fixed — the driver
> waits for the durable assistant message row (`dbMessageCount>=2 && dbHasAssistantMessage`)
> before snapshotting, identically for node-original and rust-port. Re-run twice live: `msgs=2`
> both, `original≡rust` structural deep-equal GREEN both. The diagnosis below is retained as the
> record of the finding.

```
[T2-rust] T2 invariants PASS (9/9) for opencode · umans-ai-coding-plan/umans-kimi-k2.7
  PASS session.created · session.durable-id-shape · turn.accepted · turn.completed
  PASS assistant.replied-sentinel · transcript.persisted · transcript.parseable
  PASS ownership.cleanup · provider.emits-idle-signal
  PASS (info) wire.session-materialized · cost.live-calls-bounded (liveModelCalls=1)
cold-start with NO warm-proxy (the DEV-0001 fingerprint, confirmed) · :3001 untouched

× structural projection deep-equal FAILED — 2 fields differ vs baseline (opencode-kimi.json):
      dbMessageCount:        original 2  →  rust 1
      dbHasAssistantMessage: original true → rust false
```

**What passed:** every asserted behavioral invariant (9/9) plus both informational ones. The turn was accepted (durable `ses_…`), completed on the idle edge, the assistant reply streamed and was captured (sentinel present, 159 B), a transcript row + part persisted, cleanup was ownership-clean, and the DEV-0001 bounded-probe fix let it **cold-start with no warm-proxy** (`liveModelCalls=1`).

**What failed:** the *exact* structural projection pins two DB fields that differed — the isolated `opencode.db` snapshot had **1** message row (user only), where the original baseline recorded **2** (user + assistant), and no assistant *message row* (`dbHasAssistantMessage=false`).

**Root-cause analysis (evidence, no extra live call spent):**
- The `opencode.db` is written by the **third-party `opencode serve` binary** — the *same* binary in both the original and port runs. The Rust port only **spawns** that serve and **reads** its SQLite DB; it does not author those rows. So a `dbMessageCount` difference **cannot be a Rust-port wire/behavioral defect** — it can only be a *timing* difference in when the DB is snapshotted relative to opencode’s asynchronous writes.
- The harness’s `pollForAssistantReply` (`port/oracle/harness/t2-live.ts`) returns at the **first `part` row containing the sentinel** (here 503 ms), which precedes opencode’s commit of the assistant **message row**. The original baseline was captured **warm-proxied** (`provenance.warmProxy=true`) and settled at **+5514 ms** (`notes/t2-opencode-stall.md:113`, “msgs=2 parts=1”), by which time the message row had committed.
- This test was previously committed **green** at `9b9fd4f4` with the same port code — consistent with the two fields being **non-deterministic** across cold-vs-warm serve flush timing.

**Classification: a harness determinism gap, flagged — NOT fixed, NOT a proven port defect.**
- Per the task I did not mutate the port and did not re-run to reconfirm (budget). The behavioral contract the oracle chose to *assert* held 9/9.
- **Recommended harness fix (deferred):** `pollForAssistantReply` should additionally wait for `hasAssistantMessage` (the assistant *message row*, not just the first sentinel-bearing part) before snapshotting the DB; **or** move `dbMessageCount`/`dbHasAssistantMessage` out of the pinned structural projection into the informational set (mirroring how the asserted invariants already avoid them). Either makes the tier deterministic without touching port behavior.
- **Residual risk if it *were* a port issue:** it would be an assistant-message-row *persistence-timing* nuance in the isolated DB only; the reply itself streams and is captured correctly. I am flagging it as **UNRESOLVED** rather than declaring the port equivalent on this tier.

---

## 5. Mutation-validation — the oracle catches divergence

`mutation-validation.test.ts` → **36 tests passed**; the coverage matrix:

```
caught 28/28 planted divergences · 5/5 no-false-positive checks · GAPS: 0
  T0/contract  10 planted (drop-required, unknown-discriminant, wrong-scalar, additional-property,
               wrong-boolean, 3× flip-enum, wsProtocolVersion mismatch+drift)  → all flagged
  norm/diff     6 planted + 4 nondet-pass                                        → all correct
  T1/pty        3 planted + 1 identical-pass                                     → all correct
  T2/invariant  9 planted (session.created, durable-id, turn.accepted/completed,
               replied-sentinel, transcript persisted/parseable, emits-idle, ownership) → all flagged
```

`mutation-e2e.test.ts` → **3 tests passed** (real dist mutate → rebuild pipeline):
```
[e2e-T0] RED  (mutated dist) → conformant=false; nonconformant=[{"type":"ready","reason":"schema-violation"}]
[e2e-T0] GREEN(rebuilt dist) → conformant=true
[e2e-T1] RED  (mutated dist) → capturedGolden="HELLO\r\n" (expected "hello\r\n")
[e2e-T1] GREEN(rebuilt dist) → capturedGolden="hello\r\n"
SAFETY: every spawned server reaped; live :3001 never touched
```

**Documented known gap (not weakened):** the frozen contract marks `ready.serverInstanceId` / `ready.bootId` **optional** though the server always sends them, so *dropping* them is **not** caught by T0. Logged as a schema-tightening candidate. (The T0 equivalence test asserts their presence anyway, which is stronger than the schema.)

---

## 6. T3 — retained SPA on the Rust backend (e2e + visual)

The **unchanged** React SPA was pointed at a freshly-booted isolated Rust `freshell-server` (ephemeral `127.0.0.1` port, isolated `$HOME`) via `FRESHELL_E2E_TARGET_URL`, and graded by the **identical** `test/e2e-browser/` specs + committed `*-chromium-linux.png` visual goldens (`port/oracle/t3/playwright.target.config.ts`, 1 worker, retries 0).

**Result: `9 failed · 117 passed (15.6 m)` of 126 externally-targetable tests.**
(126 = the 138-test baseline minus the 12 tests in the 6 spec files that own their server lifecycle and are excluded from external targeting.)

### 6.1 Every failure classified (reconciled against `baselines/t3/summary.json`)

| Spec | on original | on rust | Class |
|---|---|---|---|
| `browser-pane-screenshot.spec.ts:56` proxied-localhost iframe content renders | **PASS** | **FAIL** | 🔴 **PORT-GAP (deferred)** — browser-pane proxy content rendering |
| `editor-pane.spec.ts:83` lazy editor requests new JS asset | FAIL (visual-strictness) | FAIL | 🟡 EQUIVALENT |
| `fresh-agent-centralization-smoke.spec.ts:402` normalize remote legacy layout | FAIL | FAIL | 🟡 EQUIVALENT |
| `fresh-agent-centralization-smoke.spec.ts:448` keep fresh-agent settings/routes | FAIL | FAIL | 🟡 EQUIVALENT |
| `freshopencode-model-picker.spec.ts:41` MRU tiles / sorted sources | FAIL | FAIL | 🟡 EQUIVALENT |
| `mobile-viewport.spec.ts:195` permission-banner buttons on mobile | FAIL | FAIL | 🟡 EQUIVALENT |
| `multi-client.spec.ts:217` reconnecting 2nd viewer keeps PTY size stable | FAIL | FAIL | 🟡 EQUIVALENT |
| `multirow-tabs.spec.ts:9` enable multi-row tabs toggle | FAIL | FAIL | 🟡 EQUIVALENT |
| `pane-activity-indicator.spec.ts:79` freshclaude waiting→blue→idle | FAIL | FAIL | 🟡 EQUIVALENT |

- **PORT-GAP-deferred: 1** (`browser-pane-screenshot:56`).
- **EQUIVALENT (red-on-original too): 8** — all 8 of the quarantined-in-external-set tests reproduce their exact red-on-original status.
- **Force-greened (rust turned a red-on-original test green with no ledger entry): 0.** Verified explicitly — no un-adjudicated `DELIBERATE_FIX` slipped in.

### 6.2 Per-file — the port reproduces the original’s exact pass/fail profile except one file

Fully green on rust (identical to original): `auth 6/6`, `terminal-lifecycle 13/13`, `reconnection 6/6`, `pane-system 10/10`, `tab-management 11/11`, `settings 8/8`, `sidebar 8/8`, `stress 5/5`, `screenshot-baselines 6/6 (visual MATCH)`, `browser-pane 5/5`, `fresh-agent 9/9`, `pane-picker 2/2`, `fresh-agent-mobile 1/1`, `tab-recency-sync 1/1`, `tabs-client-retire 1/1`, `terminal-background-freeze-catchup 1/1`, `opencode-replay-write-progression 1/1`.
Same red-profile as original (EQUIVALENT): `editor-pane 5/6`, `fresh-agent-centralization-smoke 2/4`, `freshopencode-model-picker 0/1`, `mobile-viewport 6/7`, `multi-client 5/6`, `multirow-tabs 2/3`, `pane-activity-indicator 2/3`.
**Only divergence:** `browser-pane-screenshot 2/2 → 1/2` (the 1 PORT-GAP).

**T3 CORE (the stable gate) is fully green on the Rust backend:** load + auth (6/6), terminal create → live output → input → scrollback → resize → detach-survives → reconnect (13/13), reconnection (6/6), tab/pane systems, settings, sidebar, and **6/6 visual baselines MATCH** the original’s committed goldens.

---

## 7. Deviation ledger status

Source of truth: `port/oracle/DEVIATIONS.md` (DEV-*) and `port/machine/architecture-spec.md` §8.1 + §6.5 (CD-*).

### 7.1 Adjudicated (3)

| Id | Verdict | Pinning test (this sweep) | Original source |
|---|---|---|---|
| **DEV-0001** — opencode cold-serve health probe unbounded | **ACCEPTED**; fixed in the **port** (2 s per-probe AbortController + 150 ms retry, outer deadline unchanged). *Original-source edit was REJECTED by the antagonist and reverted.* | `crates/freshell-opencode/tests/serve_health_bounded.rs` → **3/3 GREEN** | pristine |
| **DEV-0002** — coding-CLI session-indexer crashes whole process on late provider session-root (chokidar close-during-add) | **ACCEPTED**; port guards the late-root watcher (log+degrade+rescan, process stays alive). Carried **solely** by a port liveness test (T2 differ is blind by construction). | `crates/freshell-sessions/tests/late_root_watcher_liveness.rs` → **4/4 GREEN** | pristine |
| **DEV-0003** — freshcodex `none`/`minimal` effort “silent stall” | **REJECTED** (contradicted by freshell’s own committed codex schema; not an objective defect). Differ grants **zero tolerance**; port forwards `none`/`minimal` **verbatim**, no clamp. | n/a (rejected). Verified by `freshell-codex` unit `model::tests::unsupported_effort_errors_like_the_reference` (green) + T2 codex structural match. | pristine |

Zero-tolerance for DEV-0003 is honored: no whitelist matcher is registered, and the T2 codex slice matched the baseline without any effort remap.

### 7.2 Open candidate deviations (not pre-fixed; adjudicate when the surface is built)

Tracked in `port/machine/architecture-spec.md` (Decision 8.1 table, and §6.5 for the shell ones):

| Id | Where | What | Disposition |
|---|---|---|---|
| **CD-1** | `platform-glue.md §0.2` | Unify two WSL-detection regimes | `DELIBERATE_FIX` only if unified; default = preserve both |
| **CD-2** | `platform-glue.md §2.0/§2.4` | Delete dead `platform-utils.ts` duplicate | non-behavioral cleanup; ledger note |
| **CD-3** | `terminal-core.md §6.2` | `terminal.status` defined-but-**unemitted** in reference | port need not emit; keep schema-valid if it does |
| **CD-4** | `electron-tauri.md §3.1/§10` | Tray status line never refreshes | fix on status-change when touched |
| **CD-5** | `electron-tauri.md §3.9/§10` | `daemon` mode dead-end (`install()` never wired) | antagonist: required-fix vs in-scope repair |
| **CD-6** | `electron-tauri.md §10` | Auth token in URL query | preserve for SPA compat; security-review flag |
| **CD-7** | `electron-tauri.md §10` | Updater silently no-ops when missing | surface disabled state when touched |
| **CD-8** | `platform-glue.md §3.4` | Origin advisory→rejecting CORS “hardening” | forbidden unless ledgered `DELIBERATE_FIX` |

**candidate-dirs flag** — tracked **in-code** in `crates/freshell-server/src/files.rs` (`candidate_dirs` handler). The port records a default terminal’s cwd as `None` where the reference passes `undefined`, so the endpoint applies a `defaultCwd || $HOME` fallback to yield the *same observable* candidate list for the DirectoryPicker. It is documented as producing the identical observable output (touching only the endpoint, not the PTY spawn / `terminal.created`, so T0/T1 are unaffected), but this claim is **not oracle-verified** (the files/editor T3 specs are deferred/red-on-original). Listed here as an open, self-asserted, oracle-unverified equivalence note.

---

## 8. Breadth coverage — what runs on the Rust server today

**Works on the Rust backend (oracle-proven this sweep):**
- Full WS handshake + frozen-contract conformance (T0).
- Terminal lifecycle end-to-end: create, live PTY output (byte-identical, T1), input/echo, resize, tab-switch survival, detach-keeps-running, close-tab-kills, scrollback, single-socket reconnect (T3 `terminal-lifecycle 13/13`).
- Cross-connection terminal registry: multi-client shared output + WS reconnection preserving tabs/panes + pending-terminal retry (T3 `multi-client 5/6`, `reconnection 6/6`) — the registry work closed the earlier gaps.
- Tabs (management, recency-sync, client-retire, drag-reorder, keyboard nav), panes (splits/resize/focus/zoom/nested, picker), sidebar, settings (incl. `PATCH` fan-out), stress (6+ panes, concurrent + large output).
- Auth gate (WS + REST, constant-time), static SPA serving + cache policy, boot REST surface (`/api/bootstrap|platform|version|settings|terminals|network/status|extensions|session-directory`, `logs/client`, `tabs-sync/client-retire`, `files/candidate-dirs|validate-dir`).
- Browser-pane basics (URL input, load, URL-bar update).
- Live provider turns: codex (app-server) ✅, claude (Node sidecar) ✅, opencode (invariants ✅ + structural deep-equal ✅ after the `093c1050` determinism fix).
- Visual parity: **6/6** committed screenshot baselines MATCH.

**EQUIVALENT-but-red (red on the pristine original on this host too — findings, not port gaps):** editor-pane lazy-load visual strictness; fresh-agent-centralization legacy-layout normalization; freshopencode model-picker MRU; mobile permission-banner; multi-client reconnecting-2nd-viewer PTY-size; multi-row-tabs toggle; pane-activity-indicator freshclaude color transition. (All reproduce against the original — CI runs none of these suites, so they have rotted unnoticed.)

**Genuinely DEFERRED (surface the port has not built / not gradable by pointing the suite at a URL):**
- **Browser-pane proxy content rendering** (the 1 live PORT-GAP — `browser-pane-screenshot:56`).
- **Terminal read-model subroutes** (`GET /api/terminals/:id/{viewport,scrollback,search}`) — **PORT-GAP-002** (council-adjudicated ACCEPT-WITH-CONDITIONS at task-005c, when the rest of `/api/terminals` reached full sweep parity 151/151): the original backs these with the `TerminalViewMirror` VT-screen subsystem, unported. The Rust server answers a clean JSON 404, **pinned** by sweep case `terminals.subroutes.rust-interim-404-pin` (live id + unknown id × all three subroutes; never 500/SPA-shell). Audited SPA impact: only `searchTerminalView` (the terminal search bar) is live-wired; `getTerminalViewport`/`getTerminalScrollbackPage` have **no production callers**. Follow-up: **task-005f** (right-sized to the live-wired search path; viewport/scrollback are a fresh build-when-needed decision) — a HARD GATE inside task-009 close-out. (Council condition 4 — gating the SPA search bar UI — is barred by the campaign's purity invariant (the retained SPA stays byte-identical; `src/` is never touched), so the regression is discharged by *closing* the gap via task-005f rather than masking it; until then a search against a Rust server surfaces the SPA's fetch-error path.) Pre-registered adversarial bar for the follow-up: scrollback pagination boundaries, empty/whitespace/regex-special queries, viewport on an exited-but-undeleted terminal, stale-cursor-after-id-reuse, DELETE racing an in-flight GET.
  **STATUS UPDATE (2026-07-12, task-005f): the search condition is DISCHARGED.** `GET /api/terminals/:id/search` is ported (`terminals.rs#search_terminal` + `mirror_lines`/`mirror_search` — the mirror's logical-line model needs only normalized-output line splitting, no VT state). Byte-matched against a 22-case live probe battery of the original (validation zod-v4 issue shapes/order incl. the outer-NaN + inner-undefined concatenation; `Number(cursor)` quirks `"abc"`→NaN→empty page, `" "`→0, `"0x5"/"1e1"/"+5"/"5.0"/"-0"`; the original's **500 `Cannot read properties of undefined (reading 'toLowerCase')`** on negative/fractional cursors, replicated deliberately as observable contract; case-insensitive UTF-16 column semantics; `nextCursor = String(lastMatchLine+1)`), truth files `~/freshell-scratch-005e/search-truth-{orig,rust}.json`, 22/22 rust≡original. Adversarial bar: pagination boundaries + past-end/stale cursors (unit + live), empty/whitespace/regex-special queries (400 too_small / space-match / literal-indexOf — all pinned), exited-but-undeleted terminals stay searchable (registry semantics, both sides), DELETE-then-search unaffected (`deleted` is an override flag; registry record persists identically on both sides). Sweep extended: 9 byte-parity validation/404/401 cases + 3 live-terminal cases (marker match, NaN-cursor empty page, negative-cursor 500 byte-identical) → **187/187**. viewport/scrollback remain YAGNI-deferred per the adjudication (no production callers); their 404 pin (`terminals.subroutes.rust-interim-404-pin`) now covers those two subroutes only.
- **Batch/coalesced terminal framing** tier — not yet built (T1 proves byte-equivalence of the stream, not the batch-frame protocol).
- **Desktop-shell features** (`freshell-tauri`): system tray, global hotkey, auto-updater, window-state persistence, daemon/service install (CD-4/5/7) — unit-tested + xvfb-smoked only, no real desktop/display/signing.
- **Server-lifecycle / provider restart-recovery** specs (`server-restart-recovery`, `opencode-restart-recovery`, `freshopencode-*`, `settings-persistence-split`) — excluded from external targeting (own their server lifecycle); the port’s restart/recovery is graded by T0/T1/T2 + crate tests, not this suite.
- **Sessions/history detail**, **files read/write + editor pane**, **network/LAN control**, **extensions serving detail** — REST endpoints exist; full behavioral parity is not oracle-covered.

---

## 9. HONEST LIMITATIONS — the completeness ceiling on THIS host

These are real ceilings of the campaign on a single WSL2 host; they bound how strong “equivalent” can be claimed:

1. **T2 opencode structural match — RESOLVED** (commit `093c1050`): was a harness read-timing race on two async-SQLite DB-flush fields (§4.3), now deterministic (the driver waits for the durable assistant message row) and re-confirmed `original≡rust` stable across two live runs (`msgs=2` both). Not a port defect — the opencode `serve` binary authors that DB identically for node and rust.
2. **Elevated / mutating Windows paths are golden-string-only, not live-mutated.** WSL2 can reach `powershell.exe`/`cmd.exe`, but network/LAN control that needs `netsh` + a UAC elevation prompt (firewall/port-proxy mutation) is verified against captured golden command strings, **never actually executed** against a live elevated Windows session.
3. **macOS is entirely unverified.** No macOS host was available; all macOS-specific platform/spawn/path/signing behavior is unexercised.
4. **Tauri live desktop launch is xvfb-smoked only.** `freshell-tauri` compiles and its server-spawn smoke passes under a virtual framebuffer; there is **no real display, no code-signing, no packaged bundle, no per-OS installer/updater install** exercised. Renderer-crash-recovery in particular **has no WRY equivalent tested** (Electron’s `render-process-gone` path is not reproduced on WRY).
5. **Batch/coalesced terminal-framing tier is not yet built.** T1 guarantees the reassembled byte stream, not the higher-level batch-frame protocol.
6. **T3 is single-host, single-browser (chromium-linux, 1 worker).** Visual goldens are valid only on this snapshot platform; 16/138 baseline specs are red on the pristine original here (CI runs none), so the reference itself is partial.
7. **Live model coverage is 3 turns, cheapest models, tiny prompts.** T2 proves *structural/behavioral invariants*, never LLM-text equivalence, and exercises one turn per provider — not multi-turn, tool-use, permission, or long-running-turn paths.
8. **`candidate-dirs` observable-equivalence claim is self-asserted, oracle-unverified** (§7.2).

---

## 10. What remains to reach “100% identical”

1. ~~**Resolve T2 opencode**~~ — **DONE** (commit `093c1050`): the harness now waits for the durable assistant message row; deterministic `original≡rust` re-confirmed stable across two live runs.
2. **Close the 1 PORT-GAP** — implement browser-pane proxy content rendering so `browser-pane-screenshot:56` goes green (route through the antagonist if it changes observable behavior).
3. **Close PORT-GAP-002** (task-005f, hard gate in task-009): port the live-wired terminal-search read-model (`GET /api/terminals/:id/search`); treat viewport/scrollback as a fresh YAGNI decision (no production callers today). Must land with the pre-registered adversarial pinning tests (§8) and pass the same adjudication bar as every other surface. **DONE 2026-07-12 (task-005f)** — search ported + byte-matched (22-case live battery, sweep 187/187 incl. live-terminal legs); viewport/scrollback re-affirmed YAGNI (404 pin retained). See the §8 PORT-GAP-002 status update.
4. **Build the deferred server surface** and extend the oracle to it: sessions/history detail, files read/write + editor pane, network/LAN control (incl. live-elevated Windows), extensions serving.
4. **Build the batch-framing tier** and add a golden for the coalesced frame protocol.
5. **Desktop shell on real hardware** — launch the packaged Tauri app on real Linux/Windows/macOS displays; verify tray (CD-4), global hotkey, updater feed + signing (CD-7), window-state, daemon install (CD-5); design a renderer-crash-recovery equivalent for WRY.
6. **macOS pass** — run the platform + T0–T3 tiers on a macOS host.
7. **Adjudicate the open CDs** as each surface is touched; convert the pristine-only findings (16 red-on-original T3 specs) into either fixes (ledgered `DELIBERATE_FIX`) or documented equivalence.
8. **Tighten the schema gap** — make `ready.serverInstanceId`/`bootId` required so their omission is caught by T0.

---

## 11. Safety attestation (this sweep)

- **Source pristine:** `git diff --name-only server/ shared/` → **empty** at every step (re-verified after each server-spawning tier).
- **Nothing committed:** worktree `git status --short` clean apart from this new untracked report; HEAD still `c65b0355`.
- **User’s live server untouched:** `:3001` / pid 1262455 (`node dist/server/index.js`) alive and listening throughout; every T2/T3 test independently re-asserted it.
- **0 orphan processes (ownership-based):** no stray `target/release/freshell-server`, no leftover `/tmp/freshell-oracle-*` homes, no orphan node oracle/testserver/sidecar procs. Two transient leftovers this session (a killed `mutation-e2e` run’s probe homes; one dying-bash `.bash_history` after the T3 trap’s `rm`) were verified as ours (probe-sentinel owner) and cleaned; the `mutation-e2e` was re-run to completion afterward.
- **Isolation:** every spawned server ran on an ephemeral `127.0.0.1` port under an isolated `$HOME`; T2 seeded provider auth **read-only** (mtime-verified) into temp homes; opencode/codex/claude session writes went to isolated DBs/dirs under those temp homes.

## 12. Reproduce

```bash
cd .worktrees/rust-tauri-port
# Rust sweep
cargo test --workspace --exclude freshell-tauri && cargo test -p freshell-tauri
# T0 / T1 / mutation (no live calls)
npx vitest run --config config/vitest/vitest.oracle.config.ts test/unit/port/oracle/t0-equivalence-rust.test.ts
npx vitest run --config config/vitest/vitest.oracle.config.ts test/unit/port/oracle/t1-equivalence-rust.test.ts
npx vitest run --config config/vitest/vitest.oracle.config.ts test/unit/port/oracle/mutation-validation.test.ts test/unit/port/oracle/mutation-e2e.test.ts
# T2 (gated, one live turn each)
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npx vitest run --config config/vitest/vitest.oracle.config.ts \
  test/unit/port/oracle/t2-{opencode,codex,claude}-equivalence-rust.test.ts
# T3 — boot an isolated Rust server (ephemeral port, isolated HOME, FRESHELL_CLIENT_DIR=$PWD/dist/client),
#      then: FRESHELL_E2E_TARGET_URL=… FRESHELL_E2E_TARGET_TOKEN=… FRESHELL_E2E_TARGET_HOME=… \
#            npx playwright test --config port/oracle/t3/playwright.target.config.ts
```
