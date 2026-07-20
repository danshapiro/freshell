# State-Sync Cartography: Tab Strip, Panes, and Session Sidebar

**Date:** 2026-07-19/20 (investigation run at HEAD `1845cedd`, branch `feat/rust-tauri-port`)
**Scope:** Read-only map of every piece of state that determines what the user sees in (1) the tab strip, (2) the panes, (3) the left-hand session sidebar — and every mechanism that keeps them in sync. Feeds the resilience redesign after four data-loss/desync incidents in three days.
**Codebase:** frozen client `src/` (8-file deviation from main) served by the rust server `crates/`. Legacy `server/` is frozen reference only. All `file:line` references are worktree-relative.

---

## Executive Summary

1. **Sidebar-grey root cause (one line):** REST `POST /api/tabs {mode:'amplifier', resumeSessionId}` mints pane content carrying ONLY `resumeSessionId` (`crates/freshell-freshagent/src/terminal_tabs.rs:745-753`), but the sidebar's open-state matcher only promotes a terminal pane's `resumeSessionId` to a session locator when `mode === 'claude'` (`src/lib/session-utils.ts:135-139`) — so the amplifier pane produces no `provider:sessionId` key, `hasTab` stays false, and the entry renders grey; the sidebar-click path works because `buildResumeContent` always sets `sessionRef` (`src/lib/session-type-utils.ts:157-160`).
2. **Top-5 structural weaknesses ranked by data-loss risk:**
   1. **Split-brain durable identity** — `sessionRef` vs `resumeSessionId` vs `codexDurability`, with provider-conditional promotion rules duplicated in ≥6 places that disagree (client matcher, shared migrator, rust REST deriver, resume-content builder, persist-save stripper, persist-load normalizer). Every write path that sets one key but not another mints a desync. (Incidents 1 & 4.)
   2. **localStorage is the sole authoritative home for tabs+layout**, written by a debounced read-modify-write loop with destructive normalizers on both save and load; one parse failure used to equal "user has no tabs". (Incidents 3, partially 1.)
   3. **Repair channels are asymmetric and partly dead in the rust port** — `terminal.inventory` always carries `session_ref: None` (`crates/freshell-terminal/src/registry.rs:258,631`), `terminal.meta.updated` is never folded into pane identity, and the amplifier associator refuses already-bound (resumed) terminals — so an identity missed at create time is missed forever.
   4. **Heterogeneous writers into the same Redux state with no identity-completeness contract** — user thunks, `ui.command` folds, crossTab hydrate, tabs-sync, restore machinery each set a different subset of the join keys.
   5. **Restore intent lives in ephemeral client module state** keyed by `createRequestId` with manual arm/clear discipline (`src/lib/terminal-restore.ts`). (Incident 2.)
3. **The single architectural change that eliminates the largest class:** make session identity **server-authoritative and single-keyed** — the rust server's identity registry mints one canonical `sessionRef {provider, sessionId}` for every non-shell terminal (fresh or resumed, every provider) and stamps it on every frame that names a `terminalId` (`terminal.created`, `terminal.inventory`, `terminal.meta.updated`, `ui.command` paneContent); the client stores only `sessionRef` and deletes `resumeSessionId` from all persisted/Redux state (demoting it to a create-request argument). This collapses incidents 1 and 4, revives every repair channel in weakness 3, and removes the per-provider promotion matrix entirely.

---

## Part 1 — The Triggering Defect (sidebar shows REST-created amplifier tabs as grey)

### 1.1 The open-state matcher

The sidebar computes "this session is open in a tab" per session key `${provider}:${sessionId}`:

- **Matcher entry:** `buildSessionItems` builds `tabSessionMap` from `collectSessionRefsFromTabs(tabs, panes)` — `src/store/selectors/sidebarSelectors.ts:198-203`; the item's `hasTab` is read at `sidebarSelectors.ts:232` (and grey vs open rendering keys off `hasTab`/`isRunning`).
- **Locator extraction (THE matcher):** `extractSessionLocators` — `src/lib/session-utils.ts:107-141`:
  - explicit `content.sessionRef` → locator (`:116-119`, sanitized via `:29-32`, which only requires a non-shell provider);
  - `fresh-agent` panes → `resumeSessionId` + runtime provider → locator (`:121-127`);
  - terminal panes → codex durability thread id (`:131-134`); then `resumeSessionId` is promoted **only if `content.mode === 'claude'` AND `isValidClaudeSessionId(...)`** (`:135-139`). Any other mode's `resumeSessionId` (amplifier, gemini, kimi, extension CLIs) is **invisible to the matcher**.
- A secondary fallback path in the same selector (`sidebarSelectors.ts:340-408`) merges pane-derived items into existing session rows and can set `hasTab` (`:286`), but for terminal panes it also requires `node.content.sessionRef` (`:376-377`) — same blind spot.
- The same extraction underlies `findTabIdForSession` / `findPaneForSession` (`session-utils.ts:331-405`), so the defect ALSO breaks tab dedupe: clicking the grey sidebar entry while the REST tab is open opens a **duplicate** tab rather than focusing the existing one (`src/store/tabsSlice.ts:721-763`).

### 1.2 The sidebar-click write path (works)

- Click handler → `openSessionTab` — `src/components/Sidebar.tsx:374` / `:394`.
- `openSessionTab` thunk — `src/store/tabsSlice.ts:569-801`: builds `desiredResumeContent` via `buildResumeContent` (`src/lib/session-type-utils.ts:91-163`). The terminal branch (`:147-162`) **always** sets `sessionRef: {provider, sessionId}` on pane content; the tab also gets `sessionRef` (`tabsSlice.ts:787-795`, and `:703/:713` for the live-terminal variant) before `initLayout` (`:796-799`).
- Result: pane and tab both carry the explicit `sessionRef` join key → matcher hit → sidebar shows open.

### 1.3 The REST / ui.command write path (broken)

Server side (`crates/freshell-freshagent/src/terminal_tabs.rs`):

- `derive_resume_identity` (`:410-434`, called at `:519`): a supplied `sessionRef` is accepted only when `sessionRef.provider == mode` (`accepted_session_ref_for_mode`, `:83-88`); otherwise the **legacy** `resumeSessionId` string is accepted for every mode except codex (`requested_resume_session_id_for_mode`, `:115-123`; codex raw resume is rejected outright, `:57-63`).
- Pane content mints the two keys **mutually exclusively**: `sessionRef` if accepted, else bare `resumeSessionId` (`:745-753`). The `ui.command tab.create` payload mirrors whichever key paneContent carries (`:824-843`).
- The triggering request `{mode:'amplifier', resumeSessionId:<id>}` supplies no `sessionRef` → paneContent = `{kind:'terminal', mode:'amplifier', terminalId, resumeSessionId}` — **no `sessionRef`**.

Client side:

- `handleUiCommand` `tab.create` fold — `src/lib/ui-commands.ts:79-107`: `addTab` (tab-level `sessionRef` is whatever the payload carried — here nothing; `addTab` explicitly discards any `resumeSessionId`, `tabsSlice.ts:302,315`) then `initLayout` with the payload's `paneContent` verbatim (`ui-commands.ts:90-92`).
- The session resumes fine (the PTY was spawned server-side with the resume args), but the pane's only identity key is a `resumeSessionId` under mode `amplifier` → matcher blind spot (§1.1) → **grey**.

### 1.4 Why no later mechanism repairs the linkage

| Repair channel | Why it doesn't fire here |
|---|---|
| `terminal.created` frame | Rust port always sends `session_ref: None` on this path (`crates/freshell-ws/src/terminal.rs:1077`), so the App fold (`src/App.tsx:946-959`) has nothing to reconcile. |
| `terminal.inventory` on (re)connect | Registry inventory hardcodes `session_ref: None` (`crates/freshell-terminal/src/registry.rs:258` and `:631`) — the inventory reconcile loop (`src/App.tsx:976-985`) is **dead code against the rust server**. |
| `terminal.session.associated` (amplifier locator) | Only fires for FRESH amplifier terminals; a terminal whose registry entry already has `resume_session_id` is rejected as `terminal_already_bound` (`crates/freshell-ws/src/amplifier_association.rs:120-134`; broadcast at `:150-156,165-176`). Resumed = bound = never broadcast. |
| `terminal.meta.updated` create-time slice | The server DOES broadcast provider+sessionId for a resumed amplifier terminal (`crates/freshell-ws/src/terminal.rs:1090-1110`, record built at `:1147-1170`) — but the client folds this only into `terminalMetaSlice` (pane header labels, `src/store/terminalMetaSlice.ts:58-62`), never into pane `sessionRef`. The knowledge exists client-side and is not joined. |
| Persistence round-trip | Worse: at save, `stripTransientSessionFields` deletes `resumeSessionId` from pane content and keeps only a sanitized `sessionRef` (`src/store/persistMiddleware.ts:245-264`) — the REST amplifier pane's ONLY durable key never reaches disk. (The load-time migrator `migrateLegacyTerminalDurableState` would actually promote a non-claude/codex/opencode `resumeSessionId` to a `sessionRef` — `shared/session-contract.ts:117-122` — but it never gets the chance because the field is stripped at save.) After browser refresh the pane reattaches by `terminalId`; after **server restart + refresh** it has no durable identity at all. |

**Fix directions (for the redesign, not applied here):** (a) make `terminal_tabs.rs:745-753` mint `sessionRef {provider: mode, sessionId}` for every accepted non-codex resume (the mutual-exclusivity faithfully ports `router.ts:762-771` legacy behavior — the port froze the bug); (b) or generalize `session-utils.ts:135-139` beyond `claude`; (c) or fold `terminal.meta.updated` / a non-None inventory `session_ref` into `reconcileTerminalSessionAssociation`. (a) is the authoritative-home fix; (b)/(c) are replica-side patches.

---

## Part 2 — The Cartography (per state domain)

Identity-key legend: `tabId`, `paneId`, `createRequestId`, `terminalId`, `sessionRef{provider,sessionId}`, `resumeSessionId`, `serverInstanceId`, `bootId`, `deviceId`/`clientInstanceId`.

### 2.1 Tab list

| Aspect | Detail |
|---|---|
| Authoritative home | Redux `tabs.tabs` (`src/store/tabsSlice.ts:48-56,292-324`), seeded at module init from localStorage `freshell.layout.v3` (`loadInitialTabsState`, `tabsSlice.ts:217-272`; key at `src/store/storage-keys.ts:2`). **No server-side authoritative copy.** |
| Replicas + sync | (a) localStorage combined layout, written debounced 500 ms by `persistMiddleware` (`src/store/persistMiddleware.ts:35,605-621`), flushed on hide/unload (`:50-68`) and by `flushPersistedLayoutNow` (`:687-690`); (b) other browser tabs via BroadcastChannel `broadcastPersistedRaw` → `crossTabSync` → `hydrateTabs` merge (`src/store/crossTabSync.ts:27-38`; merge logic `tabsSlice.ts:360-413`, winner picking `:111-124` by layout `persistedAt` then `updatedAt`, user-title protection `:126-138`, identity protection `:151-213`); (c) server tabs-sync registry: open/closed snapshots published per device over WS, folded from `tabs.sync.snapshot` (`src/store/tabRegistrySync.ts:440`, revision persisted at `freshell.tabs.snapshot-revision.v1`, `storage-keys.ts:18`) — feeds TabsView/reopen, not the live strip; (d) rolling backup `freshell.layout.v3.bak` written before any empty-over-nonempty write (`persistMiddleware.ts:538-551`). |
| Identity keys | `tabId` (client `nanoid()` `tabsSlice.ts:300`, or server-minted for REST tabs); `createRequestId` defaults to tab id (`:305`, migration `:101`); tab-level `sessionRef` (sanitized `:302,313`); `tab.resumeSessionId` is **always normalized to `undefined`** in live state (`:106,315`) — tab-level durable identity is sessionRef-only. Joins: `tabId → panes.layouts[tabId]` (exact); `tab.sessionRef → sidebar session key` (exact, fallback-only when no layout exists — `session-utils.ts:143-157,287-288`). |
| Crash/restart | Browser refresh: rebuilt from localStorage with per-tab salvage (`persistedState.ts:88-102`) and `sanitizeTabsAgainstLayouts` (`tabsSlice.ts:246-249`); total-loss parse falls back to empty + `markTabsLoadRecovery` (`:234,250-255`) which arms the persist guard. Server restart: tabs survive (client-owned); only terminal handles inside them go stale. Both: tabs survive iff localStorage survives — WSL restart is irrelevant, browser-profile loss is total loss (modulo `.bak`). |

### 2.2 Active tab

| Aspect | Detail |
|---|---|
| Authoritative home | Redux `tabs.activeTabId` (`tabsSlice.ts:50`), persisted inside the same layout payload (`persistMiddleware.ts:609`). |
| Replicas + sync | Same three channels as the tab list; cross-tab hydrate prefers the LOCAL active id if it survived the merge (`tabsSlice.ts:402-410`). `ui.command tab.select` (`ui-commands.ts:109-110`) and every `addTab` (`tabsSlice.ts:323`) write it. |
| Identity keys | `tabId` only; exact. |
| Crash/restart | Refresh: restored if the id still exists, else first tab (`tabsSlice.ts:256-261`). Stale only when the persisted active tab was pruned. |

### 2.3 Pane layout tree

| Aspect | Detail |
|---|---|
| Authoritative home | Redux `panes.layouts[tabId]` (PaneNode tree), `panes.activePane`, `panes.paneTitles`, `panes.paneTitleSetByUser` (`src/store/panesSlice.ts:307,866+`), seeded from the same `freshell.layout.v3` payload (`loadPersistedPanes`, `persistMiddleware.ts:345-360`). No server copy. |
| Replicas + sync | localStorage (panes section of the combined payload, `persistMiddleware.ts:585-612`); cross-tab `hydratePanes` (`panesSlice.ts:1559`); tabs-sync registry snapshots include layouts for reopen/adoption (`src/lib/tab-registry-snapshot.ts`); `layoutMirrorMiddleware` mirrors layout for observability. |
| Identity keys | `paneId` (leaf id) joins `paneTitles`/`activePane`/attention/drafts (exact). Malformed trees are dropped per-tab at load by `isWellFormedPaneTree` (`persistMiddleware.ts:379-402`) and the owning tab is then pruned by `sanitizeTabsAgainstLayouts` — a layout parse problem deletes the tab (by design, post-salvage). |
| Crash/restart | Refresh: rebuilt from disk with migrations v1→7 (`persistMiddleware.ts:373-475`). Server restart: tree survives; leaf contents go stale (next row). |

### 2.4 Pane content fields (terminalId / sessionRef / resumeSessionId / status / mode)

| Aspect | Detail |
|---|---|
| Authoritative home | Redux leaf `content` (`src/store/paneTypes.ts:71-97`): `terminalId` (server-minted, ephemeral), `createRequestId` (client idempotency key, `:76`), `status`, `mode`, `resumeSessionId` (legacy), `sessionRef` (canonical durable), `codexDurability`, `serverInstanceId` (runtime-only locality hint, `:90`), `streamId`, `restoreError`. |
| Replicas + sync | Persisted with the layout, BUT save strips `resumeSessionId`/loose `sessionId` and keeps only sanitized `sessionRef` (`persistMiddleware.ts:245-264`); load re-normalizes via `migrateLegacyTerminalDurableState` (`shared/session-contract.ts:80-123`: claude-canonical → sessionRef; claude-non-canonical, codex, opencode legacy ids → `restoreError RESTORE_UNAVAILABLE` `:110-115`; any other provider → promoted sessionRef `:117-122`) inside `normalizeTerminalContent`/`normalizeFreshAgentContent` (`src/store/persistedState.ts:231-330`). Server→client identity sync: `terminal.session.associated` / `terminal.created` / `terminal.attach.ready` frames carrying `sessionRef` → `reconcileTerminalSessionAssociation` (`src/App.tsx:946-959`; `src/lib/terminal-session-association.ts:62-141`; reducer `panesSlice.ts:1686`) with conflict detection and immediate flush; TerminalView also invokes it from attach/scrape paths (`src/components/TerminalView.tsx:3665,3744,3868`). |
| Identity keys | `createRequestId → terminal.created.requestId` (exact, the anchor join); `terminalId → registry/meta/liveness` (exact, ephemeral); `sessionRef → sidebar/session dedupe` (exact); `resumeSessionId → sessionRef` promotion is **provider-conditional and site-dependent** (the poison join); `serverInstanceId` scores match candidates (`session-utils.ts:163-185`). |
| Crash/restart | Browser refresh: `terminalId` persists and reattaches if the terminal is still live; `clearDeadTerminals`/`clearTerminalLiveHandles` (`panesSlice.ts:1724,1754`) strip stale handles when `terminal.inventory` arrives (`App.tsx:986-991`). Server restart: all `terminalId`s dead; restore machinery re-creates by `createRequestId` with restore flag (§2.9). Both: durable identity survives only as `sessionRef` — anything living solely in `resumeSessionId` for a non-claude terminal pane is silently dropped at the next persist flush. |

### 2.5 Terminal liveness

| Aspect | Detail |
|---|---|
| Authoritative home | Rust server in-memory PTY registry (`crates/freshell-terminal/src/registry.rs`; directory/inventory accessors). Not persisted — a server restart empties it by definition. `serverInstanceId`/`bootId` scope it (`crates/freshell-ws/src/lib.rs:312-346`). |
| Replicas + sync | `terminal.inventory` on every WS ready (`freshell-ws/src/lib.rs:337-346`) → `setLiveTerminalIds` + `clearDeadTerminals` (`App.tsx:986-991`); `terminals.changed` revision pings (`freshell-ws/src/terminal.rs:1188-1199`) → directory refetch; client windows in `terminalDirectorySlice` (`src/store/terminalDirectorySlice.ts:31-39`, sidebar reads `windows.sidebar.items`, `src/components/Sidebar.tsx:211-213`); `terminalMetaSlice` snapshot/upsert (`src/store/terminalMetaSlice.ts:38-62`) from `terminal.meta.updated`. |
| Identity keys | `terminalId` (exact everywhere); `BackgroundTerminal.sessionRef` joins running terminals to sidebar sessions (`sidebarSelectors.ts:146-196`) — **but rust inventory never populates it** (`registry.rs:258,631`), so "running" enrichment currently rides on the server-side session-directory join instead (`session.isRunning`/`runningTerminalId`, `sidebarSelectors.ts:210-212`). |
| Crash/restart | Server restart: inventory arrives empty with a new `bootId`; client strips handles and enters restore. Browser refresh: no effect on liveness. WSL restart: equals server restart plus PTY children death. |

### 2.6 Session-directory entries + open/grey state

| Aspect | Detail |
|---|---|
| Authoritative home | Provider session files on disk (`~/.claude/projects/**`, codex/opencode stores, amplifier `events.jsonl`) indexed by the rust `SessionIndex` (`crates/freshell-sessions`, warm sweep from `freshell-server/src/main.rs`; snapshot preserved across panicked sweeps since `c76c1462`), enriched with the live-terminal join via the server identity registry (`session_directory.rs`; populated at create, `freshell-ws/src/terminal.rs:1102-1108`, and by associators). |
| Replicas + sync | REST `/api/sessions` windows + WS `sessions.updated` pings → `sessionsSlice.projects` / `windows.sidebar` (`src/store/sessionsSlice.ts:75-88`; refresh queue `App.tsx:930`). **Open/grey is computed client-side only** (§1.1) — the server never says "open in a tab". |
| Identity keys | `${provider}:${sessionId}` (exact) both server- and client-side (`sessionsSlice.ts:27-29`, `sidebarSelectors.ts:208`). |
| Crash/restart | Server restart: directory rebuilt from disk (authoritative survives); `isRunning` enrichment resets with the registry. Browser refresh: refetched. Grey-state correctness is exactly as good as the pane-side locator extraction — the weakest join in the system. |

### 2.7 Tab titles / pane titles

| Aspect | Detail |
|---|---|
| Authoritative home | `tab.title`+`titleSetByUser` (tabsSlice) and `panes.paneTitles[tabId][paneId]`+`paneTitleSetByUser` (panesSlice `:1607-1638`), persisted in the layout payload. Server-side session title overrides live with the session index (renames cascade via the identity registry, `freshell-ws/src/terminal.rs:1097-1101` comment). |
| Replicas + sync | `ui.command tab.rename`/`pane.rename` → `applyTabRename`/`applyPaneRename` (`ui-commands.ts:111-133`, `src/store/titleSync.ts`); `openSessionTab` syncs real session titles into existing tabs/panes only when `hasTitle` (`tabsSlice.ts:683-688,730-759`); cross-device merge keeps user renames sticky (`tabsSlice.ts:126-138`). |
| Identity keys | `tabId`/`paneId` exact; title-to-session sync matches by explicit sessionRef OR implicit `(mode|provider)+resumeSessionId` (`tabsSlice.ts:736-757`) — one of the few matchers that handles both keys. |
| Crash/restart | Fully client-persisted; survives everything localStorage survives. |

### 2.8 Fresh-agent session state

| Aspect | Detail |
|---|---|
| Authoritative home | Server `FreshAgentRuntimeManager` runtimes (`crates/freshell-freshagent`) + provider-durable stores on disk (claude session JSONL; opencode `serve` sidecar sessions; codex durability refs). Client runtime status in `freshAgentSlice`/activity slices. |
| Replicas + sync | Pane content carries `sessionType/provider/resumeSessionId/sessionRef` (fresh-agent panes get BOTH keys from `buildResumeContent`, `session-type-utils.ts:108-141`); server-authoritative discrete edges `freshAgent.turn.complete` (at-monotonic dedupe) and `freshAgent.turn.waiting` (separate dedupe namespace) per AGENTS.md; `materializeFreshAgentSession`/`restartFreshAgentCreate` reducers (`panesSlice.ts:1353,1430`). |
| Identity keys | fresh-agent matcher accepts `resumeSessionId`+runtimeProvider directly (`session-utils.ts:121-127`) — fresh-agent panes do NOT suffer the sidebar-grey defect; only terminal panes do. |
| Crash/restart | Claude/kilroy: durable resume by sessionId. Opencode: rides the shared sidecar; refresh-restore per `2026-06-01` plan. Codex: durability proof machinery (`codexDurability` states). Persisted pane keeps `sessionRef` (save-stripper keeps a bare `sessionId` only for the serverInstanceId-scoped case, `persistMiddleware.ts:259-261`). |

---

## Part 3 — Write-path inventory into tabs/panes state (identity-completeness)

"Complete" = sets tab-and/or-pane `sessionRef` such that every matcher (sidebar hasTab, dedupe, restore) can join.

| # | Write path | Entry point | Keys it sets | Keys it omits → consequence |
|---|---|---|---|---|
| 1 | User: new tab / picker | `addTab` + TabContent fallback `initLayout` | tabId, createRequestId; shell panes need no identity | non-shell identity arrives later only via reconcile frames — OK for claude (create-time sessionRef exists), gap for others (see #10) |
| 2 | User: sidebar/history click | `openSessionTab` (`tabsSlice.ts:569-801`; Sidebar `:374,394`; HistoryView `:121`; ContextMenu `:423,651`) | tab.sessionRef + pane.sessionRef (+ resumeSessionId for claude fresh-agent), metadata | **Complete** — the gold standard |
| 3 | REST/MCP `ui.command tab.create` fold | `ui-commands.ts:79-107` ← `terminal_tabs.rs:824-843` | tabId, terminalId, mode, status; sessionRef only if caller passed a provider-matching sessionRef | omits pane.sessionRef for legacy `resumeSessionId` calls (`terminal_tabs.rs:745-753`) → **TODAY's incident**; also omits tab.sessionRef (addTab discards resumeSessionId, `tabsSlice.ts:315`) |
| 4 | `ui.command pane.split/attach` folds | `ui-commands.ts:115-135` ← `pane_ops.rs` | whatever payload carries | same mutual-exclusivity rule as #3 — same latent gap for non-claude resumes |
| 5 | localStorage boot | `loadInitialTabsState` / `loadPersistedPanes` | everything persisted, re-normalized | drops invalid tabs per-element (`persistedState.ts:88-102`), drops malformed layouts + their tabs; legacy non-claude ids for codex/opencode become `restoreError` (`session-contract.ts:113-115`) → **Thu incident class** |
| 6 | crossTabSync hydrate | `crossTabSync.ts` → `hydrateTabs`/`hydratePanes` | full remote snapshots, merged | merge is heuristic (persistedAt/updatedAt winner, `tabsSlice.ts:111-124`); identity protected by `protectCanonicalFallbackIdentity` (`:151-213`) but only for keys that EXIST — an incomplete tab replicates its incompleteness |
| 7 | tabs-sync registry adoption/reopen | `tabRegistrySync.ts`, `reopenClosedTab` (`tabsSlice.ts:538-567`) | tab fields + restored layout | `addTab` discards `entry.tab.resumeSessionId` (`:315`) — reopen identity rides ONLY on pane contents in the restored layout |
| 8 | Restore machinery | TerminalView `terminal.create` with restore flag (`terminal-restore.ts:51-54` peek; armed from persisted layouts `:28-33`); inventory-driven `clearDeadTerminals` + re-arm (`App.tsx:986-1005`) | new terminalId onto existing pane | restore target = pane `sessionRef` (or codex durability); panes holding only non-claude `resumeSessionId` have nothing to restore FROM after a persist cycle (§1.4 last row) |
| 9 | Reconcile folds (server → pane identity) | `App.tsx:946-985`, `TerminalView.tsx:3665,3744,3868` → `terminal-session-association.ts:62-141` | pane.sessionRef + single-pane tab.sessionRef, clears stale resumeSessionId, flushes | only fires for frames that carry `sessionRef`; in the rust port that is effectively ONLY `terminal.session.associated` (fresh amplifier/opencode) — created/inventory frames carry None (§1.4) |
| 10 | Server associators (amplifier/opencode) | `amplifier_association.rs:86-157`, `opencode_association.rs` | server identity registry + meta + `terminal.session.associated` broadcast | fresh-only; resumed terminals rejected `terminal_already_bound` (`:128-134`) — resumed non-claude terminals never get a client-visible sessionRef |
| 11 | Codex identity repair | `repairCodexIdentityMismatch` (`panesSlice.ts:1778`), durability reconcilers | codexDurability / sessionRef | codex-only |

**Where desyncs are born:** rows 3, 4, 7, 10 — every path that carries `resumeSessionId` without minting `sessionRef`, on any provider the matcher doesn't special-case.

---

## Part 4 — The four incidents mapped to broken joins

| Incident | Broken join | Mechanism | Status at HEAD |
|---|---|---|---|
| **Thu — blank tabs / `restore_unavailable`** | pane legacy `resumeSessionId` → canonical `sessionRef` (destructive migration) | `migrateLegacyTerminalDurableState` hard-poisons codex/opencode (and non-canonical claude) legacy ids into `restoreError RESTORE_UNAVAILABLE` at load (`shared/session-contract.ts:110-115`; applied in `persistedState.ts:231-330`); panes render restore-unavailable instead of resuming | Mitigated by #516 (bounded resume, breadcrumb, re-anchor) on main; the migration remains destructive by design for non-provable ids |
| **Fri — fresh-not-resumed after double restart** | `createRequestId` → restore-intent lifetime | restore flag was one-shot-consumed on first `terminal.create`; a second server restart before the pane anchored re-sent create WITHOUT `restore:true` → server minted a fresh session, history invisible | Fixed `263bae08`: peek semantics + explicit `clearTerminalRestoreRequestId` on settle (`src/lib/terminal-restore.ts:35-63`) |
| **Fri/Sat — layout nuke (mode-enum poisoning, all-or-nothing parse)** | persisted tab compat fields → tabs-array validity; parse failure → "no tabs" | a REST/extension-authored tab with a non-enum `mode` (e.g. `amplifier`) failed `zTab`; `z.array` was atomic so ONE bad tab nulled the whole parse; boot saw empty tabs; the debounced flush then persisted empty over the good layout | Fixed by trio: per-element `salvageTabs` + passthrough compat fields (`persistedState.ts:29-54,88-102`, `6b1d0633`); stateless empty-write guard v2 + rolling `.bak` + `userClosedTabsIntent` (`persistMiddleware.ts:492-569,716-718`, `2c58ef9b`/`a853ce03`); repro spec `ad77b571` |
| **TODAY — sidebar grey for REST tabs** | pane `resumeSessionId(mode='amplifier')` → sidebar session key | full chain in Part 1: server mints resumeSessionId-only paneContent (`terminal_tabs.rs:745-753`); client matcher promotes terminal resumeSessionId only for claude (`session-utils.ts:135-139`); every repair channel structurally misses (§1.4) | **Open** — this report |

Pattern across all four: each incident is a different write path (or migration) handling the **dual-key durable identity** or the **all-or-nothing client persistence** differently from the read path that consumes it. None were concurrency bugs; all were contract bugs between writer and matcher.

---

## Part 5 — Ranked weaknesses and the recommended architectural change

(Expanded from the executive summary; ranked by expected data-loss, not by ease.)

1. **Dual-key durable identity with per-provider promotion matrices** — `sessionRef` is canonical but optional; `resumeSessionId` is legacy but still minted by live server code (REST tabs, `terminal_tabs.rs`). Promotion rules differ at: `session-utils.ts:135-139` (claude-only), `session-contract.ts:101-122` (claude-canonical / codex+opencode-poison / others-promote), `terminal_tabs.rs:83-123` (provider==mode / non-codex-legacy), `session-type-utils.ts:112` (claude-only extra key), `persistMiddleware.ts:245-264` (strip at save), `tabsSlice.ts:735-757` (both keys). Six rule sets, no shared function, three of them disagree about `amplifier`.
2. **Client-authoritative, all-or-nothing layout persistence** — one localStorage key holds tabs+panes+titles+tombstones; salvage and guard were added AFTER incident 3, but the architecture (debounced overwrite of the single source of truth by whatever Redux currently holds) still amplifies any boot-time misparse into a persisted loss; the `.bak` is one rolling generation deep.
3. **Dead/partial repair channels in the rust port** — inventory `session_ref: None` (`registry.rs:258,631`), meta-not-folded, associate-fresh-only. The system was designed with belt-and-suspenders identity repair; the port shipped the belt only.
4. **`ui.command` as an unversioned, contract-free writer** — the server composes Redux-action payloads by hand (`terminal_tabs.rs:824-843`) and the client folds them verbatim (`ui-commands.ts`); nothing asserts identity-completeness of a `tab.create` payload.
5. **Ephemeral client-side restore intent** — module-level `Set`/`Map` keyed by `createRequestId` (`terminal-restore.ts:9-11`) with manual arm/peek/clear choreography across TerminalView, App, and inventory handling.

**The one change:** server-authoritative canonical identity (executive summary §3). Concretely: (i) rust identity registry (`WsState::identity`) becomes the single mint — every non-shell create (fresh or resume, REST or WS) registers `{provider, sessionId}`; (ii) `terminal.created`, `terminal.inventory`, `terminal.meta.updated`, and REST `paneContent` all carry that `sessionRef`; (iii) client deletes `resumeSessionId` from Redux/persisted state and all matchers reduce to one function over `sessionRef`. Incidents 1 and 4 become unrepresentable; incident 3's blast radius shrinks (tabs regain identity from the server after any local corruption); incident 2's fix stays but could later move server-side (restore-by-sessionRef instead of restore-by-createRequestId flag).

---

## Appendix — Key file index

| Concern | File:line |
|---|---|
| Sidebar hasTab matcher | `src/store/selectors/sidebarSelectors.ts:198-203,232` → `src/lib/session-utils.ts:107-141` (blind spot `:135-139`) |
| Sidebar-click write | `src/components/Sidebar.tsx:374,394` → `src/store/tabsSlice.ts:569-801` → `src/lib/session-type-utils.ts:147-162` |
| REST write | `crates/freshell-freshagent/src/terminal_tabs.rs:83-123,410-434,745-753,824-843` → `src/lib/ui-commands.ts:79-107` |
| Reconcile machinery | `src/App.tsx:946-985`; `src/lib/terminal-session-association.ts:62-141`; `src/store/panesSlice.ts:1686` |
| Dead repair evidence | `crates/freshell-ws/src/terminal.rs:1077,1090-1110,1147-1170`; `crates/freshell-terminal/src/registry.rs:258,631`; `crates/freshell-ws/src/amplifier_association.rs:120-134` |
| Persistence | `src/store/storage-keys.ts:2-3`; `src/store/persistMiddleware.ts:245-264,492-569,605-621,716-718`; `src/store/persistedState.ts:29-54,88-102,231-330` |
| Identity migration | `shared/session-contract.ts:80-123` |
| Restore flag | `src/lib/terminal-restore.ts:9-11,35-86` |
| Cross-tab sync | `src/store/crossTabSync.ts:27-38`; `src/store/tabsSlice.ts:111-138,151-213,360-413` |
| Tabs-sync registry | `src/store/tabRegistrySync.ts:440`; `src/store/storage-keys.ts:17-18` |
