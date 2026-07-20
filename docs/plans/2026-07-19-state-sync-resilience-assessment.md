# State-Sync & Crash-Resilience Assessment

**Date:** 2026-07-19
**Branch:** `feat/rust-tauri-port`
**Mode:** ASSESS (design assessment, not implementation)
**Trigger:** Four user-facing data-loss / desync incidents in three days
**User directive:** "Having pane, tab, and left-hand panel in sync and completely resilient/robust across crashes etc is critical to prevent data loss — analyze before we proceed."

> This is a design assessment with ranked hardening options. It contains **no code changes**. A parallel investigator is producing detailed cartography (`2026-07-19-state-sync-cartography.md`); this document samples the code only enough to ground its architectural claims and defers exhaustive call-graph mapping to that companion.

---

## 0. Executive Summary

**Authority verdict:** Client-authoritative *cosmetic* layout (tab order, split geometry, titles) is the right assignment and should stay. Client-authoritative *linkage/identity* — the binding of a pane to a live server terminal and to an on-disk session — is the **wrong** assignment and is the direct cause of all four incidents. Both facts the client must be correct about (which terminal is alive, which session exists on disk) are owned by the server. The client is running an unrefereed three-way JOIN across localStorage, the server terminal registry, and the disk session index, with no authority to correct itself when the join fails. Recommended target: **hybrid** — server-authoritative linkage/identity, client-owned cosmetic layout, reconciled by one handshake on connect.

**Top invariant gaps (enforced vs emergent-by-luck):**
1. *"A session open in a live pane is never grey in the sidebar"* — **emergent**, and broke in Incident 4. Open-state is a client-side join keyed on `sessionRef`, which is absent on the `ui.command` REST path until the terminal re-anchors.
2. *"Restore is idempotent under N interruptions"* — **partially enforced** (the one-shot latch became a non-destructive peek), but restore is still client-driven and races reconnect (Incidents 1 & 2).
3. *"A persisted layout is destroyed only by user intent"* — **now enforced** by a stateless empty-write guard + `.bak` + per-tab salvage (Incident 3's mechanism is closed; the *class* is not).
4. *"Every live terminal has a resolvable session identity"* — **emergent**; the server holds `resume_session_id`/`mode` per terminal but does not assert the pane↔session binding; the client re-derives it heuristically (`matchScore`).

**Recommended sequence (quick wins → structural):**
1. **Close the Incident-4 join** (minimal, in deviation budget): derive sidebar open-state from server terminal truth (`resume_session_id` + `mode`), not solely from client `sessionRef`.
2. **Add runtime invariant checkers** that turn silent grey/blank into visible, actionable errors (cheap; converts future regressions from data-loss into bug reports).
3. **Reconciliation-on-connect handshake** (structural keystone): client presents layout + identities; server confirms/corrects against terminal registry + disk. One protocol subsumes the N ad-hoc latches and moves linkage authority server-side incrementally, without a rewrite.
4. **Defer** event-sourced journal, CRDT, and full server-authoritative layout as over-engineering for a single-user self-hosted tool mid-port.

---

## 1. Problem Framing

Freshell replicates a single logical fact — *"what work is open and where"* — across three stores with three different owners, lifetimes, and trust models:

| Domain | Owner | Lifetime | Source of truth for |
|--------|-------|----------|---------------------|
| **Layout** (tabs, pane tree, titles, active pane) | Client (Redux + `localStorage['freshell.layout.v3']`) | Survives refresh; dies with cleared storage | Cosmetic arrangement |
| **Terminals** (PTYs, scrollback) | Server (in-memory `TerminalRegistry`) | Dies with the server process | Live process handles |
| **Sessions** (JSONL transcripts) | Disk (`~/.amplifier`, `~/.codex`, …), indexed by server | Effectively permanent | Conversation history |

Plus two derived/mirror layers:
- **Tabs-sync registry** (server, in-memory `TabsRegistry`): a passive cross-device mirror of client tab snapshots. Explicitly documented in `crates/freshell-ws/src/tabs.rs` as carrying records "verbatim (opaque `serde_json::Value`)" — it observes, it does not adjudicate.
- **Sidebar open/grey state** (client): computed by joining the disk session index to open panes in `buildSessionItems` (`src/store/selectors/sidebarSelectors.ts`).

The user's requirement — pane, tab, and sidebar in sync and resilient across crashes — is a requirement that this **replication stays consistent across every disruption**. Every incident is a failure of that consistency, not of any single store's internal correctness. Each store is individually fine; the *joins between them* are where the system loses data.

**The meta-pattern (from the four incidents):** JOIN failures between replicated domains; client-authoritative state with invariants that are hoped-for rather than enforced; and one-shot/latch recovery mechanisms that fail non-idempotently under repeated disruption.

---

## 2. Explicit Assumptions

1. **Single primary user, self-hosted.** Concurrency is dominated by multi-browser-tab and multi-device of *one* person, not contended multi-writer collaboration. This is the single most important sizing fact — it removes the justification for CRDTs.
2. **Mid-campaign Rust/Tauri port.** The client (`src/`) is frozen against a retained SPA baseline with an **8-file deviation budget** and a **233-item parity checklist**. Structural client rewrites are disproportionately expensive right now; server-side and protocol-side changes are comparatively cheap.
3. **Server terminals are ephemeral by design.** PTYs die with the process; restore is inherent, not a bug. The requirement is that restore be *reliable and idempotent*, not that terminals become durable.
4. **Sessions on disk are the durable ground truth.** No incident lost transcript data; every incident lost *linkage* to it. This bounds the blast radius: the worst realistic outcome is "can't get back to my work easily," not "my work is gone."
5. **The recently-added guards are real and load-bearing** (verified in `persistMiddleware.ts` and `terminal-restore.ts`): the stateless empty-write guard, `.bak`, per-tab `salvageTabs`, and the peek-not-consume restore flag. The assessment credits these and does not propose re-solving what they already solve.
6. **"Resilient across crashes" includes the server, the browser, and WSL** — all three tiers can restart independently or together.

---

## 3. System Boundaries

**Inside scope:** the consistency contract between layout ⇄ terminals ⇄ sessions ⇄ sidebar across restart/refresh/reconnect; the restore protocol; the sidebar open-state join; the persistence write path.

**Outside scope:** PTY internals, scrollback ring buffers, transcript parsing/indexing correctness, the tabs-sync cross-device *display* logic (working as designed), UI rendering.

**The load-bearing interfaces (where consistency is won or lost):**
- **Layout ⇄ Terminal:** `terminal.create {createRequestId, restore}` → `terminal.created {terminalId}`. This is where a pane "anchors" to a live PTY.
- **Terminal/Session ⇄ Sidebar:** the client-side join in `buildSessionItems`, keyed on `${provider}:${sessionId}` derived from `sessionRef` (`collectSessionRefsFromTabs`).
- **Remote ⇄ Layout:** `ui.command` broadcasts folded by `handleUiCommand` (`src/lib/ui-commands.ts`) — the REST/MCP agent-api ingress that created Incident 4.
- **Client ⇄ Tabs-registry:** `tabs.sync.push/query/retire` (`tabRegistrySync.ts` ⇄ `tabs.rs`) — cosmetic mirror, not authority.

---

## 4. Components and Responsibilities (as-built)

- **`persistMiddleware.ts`** — debounced (500 ms) writer of the combined `layout.v3` key. Now carries a *stateless* empty-tabs write guard: it will not overwrite a non-empty persisted layout with an empty one unless *this specific write* was caused by the genuine `tabs/removeTab` user action, and it backs up to `LAYOUT_BACKUP_STORAGE_KEY` unconditionally before any empty write. Source of truth: nothing — it serializes Redux.
- **`persistedState.ts`** — the parse/salvage boundary. `salvageTabs` validates tabs *per-element* (not all-or-nothing), and `zTab` uses `.passthrough()` + `zSanitizedOptionalString` for `mode`/`codingCliProvider`, so a foreign/out-of-enum value is sanitized to `undefined` rather than poisoning the whole payload. This is the specific fix for Incident 3's poison vector.
- **`terminal-restore.ts`** — arms `createRequestId`s found in the persisted layout. Critically, `consumeTerminalRestoreRequestId` is a **peek, not a consume** (kept the name for call-site compat): the flag persists across N interrupted restore rounds and is cleared only explicitly when the pane's fate settles. This is the fix for Incident 2's mechanism.
- **`sidebarSelectors.ts`** (`buildSessionItems`) — joins disk sessions to open panes. `hasTab` for a disk session is set only if the session key appears in `collectSessionRefsFromTabs`, i.e. only if a pane carries a resolvable `sessionRef`. **This is the Incident-4 fault line.**
- **`session-utils.ts`** — the heuristic matcher (`matchScore`, `findPaneForSession`). Its existence is itself evidence: the client must *score-match* panes to sessions because no authority hands it the binding. Scores are `serverInstanceId` hint (3) > live-handle hint (2) > bare locator (1).
- **`tabRegistrySync.ts` ⇄ `tabs.rs`** — cross-device mirror with per-client revision watermarks and client-lease collision handling. Robust for what it does; not a layout authority.
- **Server `TerminalRegistry`** (`crates/freshell-terminal/src/registry.rs`) — holds `resume_session_id` and `mode` per terminal. **The server already knows enough to assert the pane↔session binding — it simply doesn't, and the wire `inventory()` row currently sets `session_ref: None`, pushing derivation back to the client.**

---

## 5. Authority Analysis

### 5.1 Is client-authoritative layout the right assignment?

The question must be split by *dimension of state*, because the current design collapses two very different things into one authority:

| State dimension | Example | Who genuinely owns the truth | Current authority | Correct? |
|-----------------|---------|------------------------------|-------------------|----------|
| **Cosmetic layout** | tab order, split sizes, active pane, titles | The client/user (pure UI preference) | Client | ✅ **Correct** |
| **Live linkage** | does this pane's terminal exist right now? | Server (owns the PTY) | Client (infers from inventory + hints) | ❌ **Wrong** |
| **Session identity** | which on-disk session is this pane? | Server/disk (owns the index) | Client (heuristic `matchScore`) | ❌ **Wrong** |
| **Open-state** | is this session "open" (non-grey)? | Derivable from live linkage | Client join on `sessionRef` | ❌ **Wrong (derived from a wrong input)** |

The client-authoritative *layout* decision is sound and idiomatic for a browser app: layout is user preference and should survive independent of any server. The defect is that **linkage and identity were placed on the same authority as cosmetics** because they happen to travel together in the pane-content object. Linkage/identity are facts *about server and disk resources*, and the client can only ever *guess* at them — which is exactly what `session-utils.ts`'s scoring matcher is: institutionalized guessing.

### 5.2 The contrasted models

| Model | What it means here | Fit for Freshell |
|-------|--------------------|------------------|
| **Client-authoritative (status quo)** | Server ignorant of tabs except the passive sync mirror; client owns everything and re-derives linkage on every reconnect | Cheap, offline-friendly, but structurally cannot self-correct — every incident lives here |
| **Server-authoritative layout (client = view)** | Server owns the full tab/pane tree; client renders it | Solves consistency by fiat, but throws away the frozen client's local-first behavior, breaks offline/refresh independence, and is a massive deviation-budget spend mid-port. **Over-correction.** |
| **Log / CRDT sync** | Layout as a convergent replicated structure across devices | Solves a multi-writer conflict problem **that a single primary user does not have.** Pure ceremony here. |
| **Hybrid: server-authoritative linkage/identity + client-owned cosmetic layout** | Client owns arrangement; server owns "which terminal is live" and "which session this is," and *confirms/corrects* the client on connect | ✅ **Correct fit.** Keeps local-first cosmetics, moves the two facts the client can't actually know to the authority that does, and is reachable incrementally via a handshake. |

**Verdict:** Adopt the **hybrid**. Do not make layout server-authoritative; do not add a CRDT. Move *only linkage and identity* to server authority, and expose them through a single reconciliation handshake (Option B below) rather than the current scatter of inference points.

---

## 6. Invariant Inventory

Legend: **Enforced** = a mechanism guarantees it. **Emergent** = holds only when timing/paths cooperate. **Violated** = broke in an incident.

| # | Invariant | Status today | Evidence |
|---|-----------|--------------|----------|
| I1 | A session open in a live pane is never grey in the sidebar | **Emergent → Violated (Inc. 4)** | `buildSessionItems` sets `hasTab` only from `sessionRef`-bearing panes; `ui.command` `tab.create` panes carry `resumeSessionId` but no `sessionRef` until re-anchor |
| I2 | A persisted layout is destroyed only by explicit user intent | **Enforced (newly)** | stateless empty-write guard + `userClosedTabsIntent` gate + `.bak` in `persistMiddleware.ts`; per-tab `salvageTabs` in `persistedState.ts` |
| I3 | Restore is idempotent under N interruptions | **Partially enforced** | `terminal-restore.ts` peek-not-consume flag; but restore is still client-initiated and races reconnect ordering (Inc. 1) |
| I4 | Every live terminal has a resolvable session identity | **Emergent** | server holds `resume_session_id`/`mode` but `inventory()` emits `session_ref: None`; client re-derives via `matchScore` |
| I5 | A pane either anchors to a live terminal or shows an explicit, actionable error — never a silent blank | **Emergent → Violated (Inc. 1)** | "restore unavailable" rendered as blank; `RestoreError` exists but isn't a guaranteed terminal state of every restore attempt |
| I6 | Re-anchoring never mints a fresh session over an existing one | **Emergent → Violated (Inc. 2)** | fixed *mechanism* (peek flag), but the guarantee is a property of call-site discipline, not a checked invariant |
| I7 | The sidebar reflects server terminal reality within one reconcile cycle | **Emergent** | sidebar derives from client state + polled directory; no authoritative "these are the live terminals and their sessions" push |
| I8 | Cross-device tab display converges after a device disconnects | **Enforced** | `tabs.rs` revision watermark + retire beacon + client lease |

**The pattern in the table:** every *enforced* invariant is one that was recently, specifically, and locally hardened after an incident. Every *emergent* one is a latent future incident. Hardening should convert emergent invariants into enforced ones **systematically** (Option B + D) rather than one incident at a time.

---

## 7. Failure-Mode Table (guarantees vs hopes)

| Disruption | What the design **guarantees** | What it **hopes** | Incident |
|------------|-------------------------------|-------------------|----------|
| **Server restart (single)** | Sessions safe on disk; layout safe in localStorage | That restore re-anchors before the user notices; that reconnect ordering lets the peek-flag fire | **Inc. 1** (blank "restore unavailable") |
| **Double server restart (~50s apart)** | Same as above | That an interrupted restore round didn't leave a pane mid-flight; peek-flag now survives round 1 | **Inc. 2** (restored FRESH) |
| **Browser refresh** | Layout parses per-tab; empty-write guard protects prior layout; `.bak` exists | That no persisted field is out-of-enum in a way that survives salvage; that re-anchor repopulates `sessionRef` | **Inc. 3** (zero tabs) |
| **WSL restart** | = server restart + terminals gone; disk intact | That the reconnect + restore path behaves as single-restart (untested as a distinct mode) | — (latent) |
| **Server + browser at once** | Disk intact | That neither the layout write nor the restore arm was interrupted mid-flight | — (latent, highest-risk compound) |
| **Multi-browser-tab** | Tabs-registry client-lease rotates colliding instance ids; `BroadcastChannel` persist coordination | That two tabs don't race an empty-write vs a real-write into `layout.v3` | — (guarded, not proven) |
| **Remote tab creation mid-session** | Tab appears via `ui.command`; resume works | That the sidebar open-state join finds a `sessionRef` — **it doesn't on this path** | **Inc. 4** (grey sidebar) |

**Reading:** the design *guarantees* disk durability (strong) and *guarantees* several recently-added write protections. Everything else in the "resilience" requirement is currently a **hope about timing and code-path symmetry**. The two untested compound modes (WSL restart, server+browser together) are where the next incident most likely lives.

---

## 8. Hardening Options (ranked, with 8-dimension tradeoffs)

Each option is scored against the fixed frame. Ratings are qualitative (good / adequate / poor) with a note. "Prevents" maps to the incident numbers.

### Option A — Minimal fix: close the sidebar-grey join
Derive sidebar open-state from server terminal truth (`resume_session_id` + `mode`, already in the registry) in addition to client `sessionRef`; fold `resumeSessionId` into the join key in `buildSessionItems`/`collectSessionRefsFromTabs`.

| Dimension | Assessment |
|-----------|------------|
| Latency | good — pure selector change, no new round-trips |
| Complexity | good — localized to the join; no new protocol |
| Reliability | adequate — fixes I1/I7 for the known path; other emergent invariants remain |
| Cost | good — smallest possible |
| Security | good — no new surface |
| Scalability | good |
| Reversibility | good — easily reverted |
| Org fit | good — within the 8-file deviation budget |
| **Optimizes for** | shipping the visible bug fix now |
| **Sacrifices** | nothing structural — but leaves the class of JOIN failures intact |
| **Prevents** | **Inc. 4** (and the general "resume-only pane is grey" family) |

### Option B — Reconciliation-on-connect handshake (structural keystone)
One protocol: on `ready`/reconnect, the client presents its layout + pane identities; the server confirms each pane against the live terminal registry and disk index, and returns a corrected binding set (terminal alive? → attach; session on disk but no terminal? → restorable; neither? → explicit error). Replaces the scattered inference in `session-utils.ts`, the restore-arming latch, and the polled open-state derivation with a single authoritative exchange.

| Dimension | Assessment |
|-----------|------------|
| Latency | adequate — one extra handshake per connect; amortized, not per-render |
| Complexity | adequate — one *new* protocol, but it *removes* N ad-hoc mechanisms (net simplification over time) |
| Reliability | good — converts I3/I4/I5/I6/I7 from emergent to enforced; self-correcting by construction |
| Cost | moderate — the real engineering investment; mostly server-side + protocol (cheap side of the port) |
| Security | adequate — validate client-presented identities server-side (never trust client linkage claims) |
| Scalability | good — O(open panes) per connect |
| Reversibility | adequate — protocol contract is harder to unwind than a selector, but layout data model is untouched |
| Org fit | good — lands mostly in Rust/protocol, minimizing frozen-client deviation |
| **Optimizes for** | making linkage authoritative and consistency self-healing |
| **Sacrifices** | one round of protocol design; a slightly heavier connect path |
| **Prevents** | **Inc. 1, 2, 4** directly; hardens against the two latent compound modes |

### Option C — Event-sourced layout journal
Append-only layout log + compaction; destructive overwrites become impossible by construction.

| Dimension | Assessment |
|-----------|------------|
| Latency | adequate |
| Complexity | poor — new storage model, compaction, replay, migration of `layout.v3` |
| Reliability | good — for the *destruction* class specifically (I2) |
| Cost | high |
| Security | adequate |
| Scalability | adequate — log growth needs compaction management |
| Reversibility | poor — data-model change is the least reversible decision class |
| Org fit | poor — large frozen-client change mid-port |
| **Optimizes for** | absolute non-destructibility of layout |
| **Sacrifices** | simplicity, budget, reversibility — to solve a class **I2 already closed** by cheaper means |
| **Prevents** | Inc. 3 (already prevented) |

### Option D — Runtime invariant checkers
Assert the Section-6 invariants at runtime; a violation surfaces as a visible, actionable error (with a recovery affordance) instead of a silent grey/blank.

| Dimension | Assessment |
|-----------|------------|
| Latency | good — cheap checks |
| Complexity | good — additive, no architecture change |
| Reliability | good — doesn't prevent desync but converts silent data-loss into loud, diagnosable events |
| Cost | good |
| Security | good |
| Scalability | good |
| Reversibility | good |
| Org fit | good — small, mostly additive |
| **Optimizes for** | observability; making the *next* regression a bug report, not a data-loss incident |
| **Sacrifices** | nothing meaningful; not a fix on its own |
| **Prevents** | none outright — but caps the blast radius of I1/I5/I6/I7 regressions and shortens diagnosis |

### Option E — Full server-authoritative pane↔session linkage
Server owns the binding end-to-end; sidebar open-state and restore derive from server truth; client stops inferring entirely.

| Dimension | Assessment |
|-----------|------------|
| Latency | adequate |
| Complexity | moderate-high — larger than B; touches every linkage consumer at once |
| Reliability | good — the strongest correctness end state |
| Cost | high if done as a big-bang |
| Security | good |
| Scalability | good |
| Reversibility | moderate |
| Org fit | poor as big-bang; **good as the destination that Option B converges toward incrementally** |
| **Optimizes for** | eliminating client-side guessing permanently |
| **Sacrifices** | a lot of change surface if pursued directly instead of via B |
| **Prevents** | Inc. 1, 2, 4 — same as B, but at higher one-shot cost |

**Ranking (fit-adjusted for this campaign):** **A** (do now) → **D** (do now, cheap safety net) → **B** (structural keystone) → **E** (the destination B grows into) → **C** (rejected as over-engineering; its target is already solved).

---

## 9. Recommended Design & Sequence

Adopt the **hybrid authority model**, reached in four steps ordered quick-win → structural:

1. **Now — Option A:** Close the Incident-4 join. Sidebar open-state reads server terminal truth (`resume_session_id`/`mode`) in addition to client `sessionRef`. Smallest change, restores the visible invariant I1, fits the deviation budget.
2. **Now — Option D:** Land runtime invariant checkers for I1, I4, I5, I6, I7. This is the cheap insurance that changes the *character* of any future regression from "silent data-loss the user reports days later" to "loud error we see immediately." It also de-risks steps 3–4 by making their correctness observable.
3. **Next — Option B (keystone):** Design and implement the reconciliation-on-connect handshake. This is the load-bearing structural change: it makes linkage/identity server-authoritative *through one protocol* and lets you delete the ad-hoc restore latch, the polled open-state derivation, and most of the `matchScore` heuristic over time. Land it server-side/protocol-first to minimize frozen-client churn.
4. **Later — Option E convergence:** As consumers migrate onto the handshake's authoritative bindings, the client's inference code (`session-utils.ts` scoring) becomes dead and is removed. This is not a separate project; it is the natural end state of B, reached incrementally.

**Why this order:** Steps 1–2 buy immediate user-visible relief and a safety net without touching the data model or spending structural budget. Step 3 is where the *class* of JOIN failures is actually eliminated, and it is deliberately placed after the observability net so its rollout is provable. Step 4 is cleanup, not new risk.

**Simplest credible alternative:** Option A alone ("close the join, accept the architecture"). It stops today's bleeding but leaves I3–I7 emergent, i.e. the next disruption in an unhardened path produces incident #5. Given the user's explicit "completely resilient" bar and a *pattern* of four incidents in three days, A-alone under-serves the stated requirement — but it is the correct *first* step, not the *whole* answer. The added cost of B is justified precisely because the incidents are recurring across *different* paths, which is the signature of a structural cause, not a set of independent bugs.

---

## 10. NOT-to-Build Fences (over-engineering guards)

- **No CRDT / OT / convergent replicated layout.** Justified only by concurrent multi-writer conflict. A single primary user does not have that problem. This would be pure ceremony.
- **No event-sourced layout journal (Option C).** Its target (non-destructible layout, I2) is already met by the stateless empty-write guard + `.bak` + per-tab salvage. Rebuilding that with a log is re-solving a solved problem at high cost and low reversibility.
- **No server-authoritative *cosmetic* layout.** Tab order and split sizes are user preference; centralizing them breaks local-first/offline behavior and burns the deviation budget for zero resilience gain. Keep cosmetics on the client.
- **No big-bang Option E.** Do not rip out client linkage inference in one pass. Let it die incrementally as the handshake (B) takes over. Big-bang here maximizes risk during a port.
- **No new durable-terminal layer.** Terminals dying with the server is by design; the fix is reliable *re-anchoring*, not making PTYs survive restarts. Don't build process durability to avoid building a handshake.
- **No speculative multi-user auth/ownership model** on the linkage change. Server-side identity *validation* (don't trust client linkage claims) is required; a full multi-tenant ownership system is not.
- **No new persistence schema version unless B demands it.** Each `layout.v*` bump is migration risk; avoid churning the data model for changes that live in the protocol/derivation layers.

---

## 11. Success Metrics

- **I1–I7 converted from emergent to enforced**, each with a runtime checker that has fired zero *unexpected* violations in normal use (Option D gives this its own telemetry).
- **Zero silent blanks/greys:** every failed anchor or unresolved session renders an explicit, actionable state — measured by the absence of "why is this grey/blank" reports.
- **Restore idempotency proven under the two latent compound modes** (WSL restart; server+browser simultaneous restart), not just single restart — add these as explicit test scenarios.
- **Deletion, not just addition:** success for step 4 is measured by *lines removed* from `session-utils.ts` inference and the restore latch as the handshake subsumes them.
- **No layout-destruction incident** across a sustained window of daily restarts/refreshes — the direct read on the user's stated requirement.

---

## Appendix: Evidence Sampled

- `src/store/persistMiddleware.ts` — stateless empty-tabs write guard, `.bak`, `userClosedTabsIntent` gate.
- `src/store/persistedState.ts` — per-element `salvageTabs`, `zSanitizedOptionalString` mode sanitization, combined `layout.v3` schema.
- `src/lib/terminal-restore.ts` — peek-not-consume restore flag (idempotency under interruption).
- `src/store/selectors/sidebarSelectors.ts` — `buildSessionItems` open-state join (Incident-4 fault line).
- `src/lib/session-utils.ts` — `matchScore`/`findPaneForSession` client-side linkage inference (institutionalized guessing).
- `src/lib/ui-commands.ts` — `handleUiCommand` REST/MCP ingress (`tab.create` resume-only path).
- `src/store/tabRegistrySync.ts` ⇄ `crates/freshell-ws/src/tabs.rs` — passive cross-device mirror (not layout authority).
- `crates/freshell-terminal/src/registry.rs` — server holds `resume_session_id`/`mode` per terminal; `inventory()` emits `session_ref: None` (derivation pushed to client).
