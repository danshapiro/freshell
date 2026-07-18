# Checklist reconciliation — campaign evidence mapped onto the 233-item parity checklist

**Date:** 2026-07-18
**Author:** read-only reconciliation pass (foundation:explorer)
**Base:** committed HEAD `85b4f318` on `feat/rust-tauri-port` (four other agents are
churning `crates/` and `test/` concurrently; every citation below is against committed HEAD,
not the live working tree).
**Checklist under reconciliation:** `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`
(233 items, **2 checked**: HARNESS-01, HARNESS-02).
**Campaign log:** `docs/plans/2026-07-17-rust-transition-campaign-status.md`
**Git range mined:** `6e3af242..85b4f318`.

> This document does NOT edit the checklist. It classifies every one of the 233 IDs so the
> orchestrator can check off only what genuinely qualifies and honestly sequence the rest.

---

## The bar (restated, because it decides everything)

An item is checkable ONLY when its **stated** acceptance evidence exists and passed. For almost
every item that evidence is an **isolated-home Playwright test driving the real Rust binary**
(`PW-RUST` via HARNESS-01), or a named gate. Implementation, crate unit tests, and the protocol
oracle are explicitly declared **insufficient** by the checklist's own "Completion rule"
(*"Passing a narrow protocol oracle … is not sufficient"*).

**The single most important structural fact for this reconciliation:** only **9 spec files**
actually run against the real Rust binary. `test/e2e-browser/playwright.config.ts` defines
`MATRIX_SPECS`, and only the `rust-chromium` project boots an owned `RustServer`. Every other
spec runs under the default `chromium` project, which `helpers/fixtures.ts:76` hard-defaults to
`e2eServerKind: 'legacy'` — i.e. the **Node** `TestServer`. So a spec that exercises (say)
freshcodex or opencode but is *not* in `MATRIX_SPECS` proves **legacy Node** behavior, not the
Rust port, and cannot satisfy `PW-RUST`.

The MATRIX_SPECS (run on `rust-chromium`) are:
`server-restart-recovery`, `settings-persistence-split`, `harness-02-matrix-bite`,
`terminal-lifecycle`, `browser-pane`, `multi-client`, `session-directory-matrix`,
`restore-matrix`, plus `harness-01-rust-server` (rust-only).

---

## Summary counts

| Classification | Count | Meaning |
|---|---:|---|
| **CHECKABLE-NOW** | **2** | Stated evidence exists and passed. (Both already checked.) |
| **PARTIAL** | **93** | Implementation and/or adjacent tests exist, but the *stated* evidence (usually a `PW-RUST` matrix spec) is missing. |
| **NO-EVIDENCE** | **72** | Nothing found on this branch. |
| **OUT-OF-SCOPE-HOST** | **66** | Requires native Windows / packaged app / Electron-profile (TAURI/PACKAGE/UPDATE/MIGRATE + Windows-firewall + native-Windows file/quoting). Environment-limited per campaign rules. |
| **Total** | **233** | |

**Headline:** the strict bar unlocks **zero new checkboxes** right now — the only two
fully-qualifying items (HARNESS-01/02) are already checked. The campaign's real output is a
large **PARTIAL** tier (93 items) that is "one matrix spec away," not a checkable one. See the
TOP-10 for the cheapest conversions and the "Surprises" section for the traps.

Classification legend used in the tables: **C** = CHECKABLE-NOW, **P** = PARTIAL,
**N** = NO-EVIDENCE, **H** = OUT-OF-SCOPE-HOST.

---

## Required Playwright test lanes (HARNESS-01 … 14)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| HARNESS-01 | Owned Rust-server fixture | **C** | `helpers/rust-server.ts` + `specs/harness-01-rust-server.spec.ts` ("boots, survives restart, and reaps only its own process group"), green on `rust-chromium` (commits 334f834b/2cb57287). **Already checked.** |
| HARNESS-02 | Node/Rust matrix seam | **C** | `playwright.config.ts` `MATRIX_SPECS` + `specs/harness-02-matrix-bite.spec.ts` ("the fixture-owned server is the one THIS project claims to own, across a restart"), RED-demoed. **Already checked.** |
| HARNESS-03 | Deterministic provider fixtures (7 providers) | **P** | Fake codex/opencode fixtures exist and are used by restore/opencode/fresh-agent specs. Missing: the **fixture-only contract spec** invoking each executable directly, and fakes for Kilroy/Amplifier/Gemini/Kimi. |
| HARNESS-04 | Multi-provider session corpus builder | **P** | `session-directory-matrix` seeds a Claude corpus; codex/opencode seeding exists inline. Missing: unified corpus manifest/hashes with archived/deleted/summaries/worktrees/pagination + real-home-untouched proof. |
| HARNESS-05 | Raw HTTP/WS clients in the runner | **N** | No raw-frame/slow-consumer socket helper spec found; specs use `page`/`page.request`. Blocks TERM-19, SAFE-03/05/07, AUTO-12. |
| HARNESS-06 | Proxy/file/SMB/editor/AI/update/HTTPS fixtures | **N** | Only `helpers/external-target.ts` (browser-pane) exists; the full fixture set is absent. |
| HARNESS-07 | Native Windows Tauri fixture | **H** | Requires native Windows + WebView2 CDP. |
| HARNESS-08 | Test-only Tauri control plane | **H** | Native Windows Tauri build. |
| HARNESS-09 | Windows host assertions | **H** | Windows process/firewall/service helpers. |
| HARNESS-10 | Legacy-profile + WebView migration fixtures | **H** | Electron-profile desktop migration; environment-limited. |
| HARNESS-11 | Accessibility selectors gate | **N** | No reusable role/label gate or lint self-test found. Blocks GATE-07. |
| HARNESS-12 | Leak & resource measurements | **P** | `perf/` visible-first audit captures RSS/latency/logs. Missing: the create/send/close/restart leak loop returning to a bounded baseline with retained process-tree artifact. |
| HARNESS-13 | Packaged Windows native-action automation | **H** | Installed release build + UI Automation. |
| HARNESS-14 | Controllable server clock | **N** | No shared test clock found. Blocks TERM-11, SAFE-02, AUTO-15. |

---

## P0 — Configuration safety and migration (CFG-01 … 12)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| CFG-01 | Lossless `config.json` writes | **P** | Batch-A lossless writer (commit 6e3af242) + "545 renames, secrets, migrations survive" + staging zero-loss write-probe + crate tests. Missing: a `PW-RUST` spec that seeds sentinels and deep-compares the file after each writer/restart. |
| CFG-02 | Serialize concurrent config writes | **P** | flock sidecar + dirty-key adopt-from-disk merge (commit 9c346fc6). Missing: `PW-RUST` two-context parallel-writer spec. |
| CFG-03 | Backup / fallback / visible write-error | **N** | Listed as first-week work in the status doc; no implementation or spec found on this branch. |
| CFG-04 | Legacy browser-preference seeding (`legacyLocalSettingsSeed`) | **P** | `specs/settings-persistence-split.spec.ts` rust leg is a committed `test.fail` citing CFG-04 — a RED-demoed *known gap*, not merely unevidenced. Needs the seed consumed once + one-time marker (green). |
| CFG-05 | Electron→Tauri browser-state umbrella gate | **H** | `PW-TAURI-WIN` migration suite over HARNESS-10. |
| CFG-06 | Eliminate boot-time settings snapshots | **P** | `multi-client` settings-broadcast leg (rust) covers a slice. Missing: the reconnect-without-restart "both handshakes use new values" spec. |
| CFG-07 | Persist a stable server installation identity | **P** | **Contradicted today:** HARNESS-02's bite spec keys on *"Node-persists / Rust-regenerates instanceId"* — i.e. Rust currently **regenerates** the instance ID across restart, the opposite of the clause. Needs instance-id persistence keyed on home, then a `PW-RUST` equality/inequality spec. |
| CFG-08 | Durable tab-registry storage + crash recovery | **N** | Records still in memory; `tabs-client-retire` spec is Node-only. Store not implemented on this branch. |
| CFG-09 | Recent directories MRU + candidate precedence | **N** | `recentDirectories` preserved losslessly (via CFG-01) but the 20-item MRU learning/precedence merge is not implemented. |
| CFG-10 | Idempotent, lossless schema/provider migrations | **P** | freshclaude/agentChat migration implemented; "CFG-10 boot-twice on a real-config clone = byte-identical" verified **manually** in bake-in. Missing: the parameterized `PW-RUST` interrupt/restart migration spec. |
| CFG-11 | Atomic writes crash-safe on Linux + Windows | **P** | temp-file+rename atomic writer + `port/oracle/robustness/*` kill artifacts. Missing: the native-Windows pause-after-flush crash spec. |
| CFG-12 | Preserve browser-local / server-wide split | **P** | `settings-persistence-split` rust leg = committed `test.fail` (known gap). Legacy leg passes; Rust does not yet keep appearance local while replicating cwd. |

---

## P0 — Session history and sidebar parity (SESSION-01 … 22)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| SESSION-01 | Index Claude/Codex/OpenCode/Amplifier | **P** | Claude leg green on rust (`session-directory-matrix.spec.ts` "seeded Claude sessions appear in the sidebar"). Codex+OpenCode sources (408d0cdb) and Amplifier source (64083989) landed, but only Claude has a green `PW-RUST` sidebar assertion, and none assert icons/titles/projects/ordering/resumable identity. **Amplifier is ambiguous** — bake-in caveat #3 says ":3002 doesn't index amplifier yet." |
| SESSION-02 | Apply all saved session overrides | **P** | "overrides cross-provider: smoke + matrix tests." Missing: the `PW-RUST` archived/hidden-deletion/created-time projection + restart spec. |
| SESSION-03 | Rename/summary/archive/delete/created-time | **P** | Naming cluster (d5cf534a) + session-metadata route (e5670aec); soft-delete verified manually (override flag only, provider `.jsonl` preserved). Missing: the accessible context-menu `PW-RUST` spec. |
| SESSION-04 | Provider-aware title + AI-title ladder | **P** | generate-title in smoke; precedence implemented. Missing: `PW-RUST` full priority-ladder + cleanup-marker spec. |
| SESSION-05 | Project colors on History headers | **N** | Colors preserved in config only; no save/broadcast/render implementation. |
| SESSION-06 | Session type/flavor metadata store | **N** | Not implemented. |
| SESSION-07 | Full-text search + pagination + stale-query cancel | **N** | Deferred to Phase 3; only basic sidebar search (Node). No >100-session pagination / cancellation. |
| SESSION-08 | Repository / worktree grouping | **N** | Not implemented. |
| SESSION-09 | Live watching + coalesced `sessions.changed` | **P** | Incremental refresh (ffa83d0c). Missing: two-page convergence-per-mutation `PW-RUST` spec across all four backends; `restore-matrix` scenario 3 (seeded-session visibility) is `test.fixme`. |
| SESSION-10 | Join history to live terminals | **P** | "sidebar live-terminal join" (d5cf534a). But `restore-matrix` scenario 3 ("open seeded historical session → real pane title + non-blank content") is **`test.fixme`/skipped**; open item #2 (fresh codex sidebar duplicate) is unresolved. |
| SESSION-11 | Session repair + truthful status events | **N** | Not implemented. |
| SESSION-12 | Terminal↔session rename/title sync | **P** | rename cascades (d5cf534a) + reverse-cascade positive test (3fae265e). Missing: `PW-RUST` tab→History→provider-title precedence spec. |
| SESSION-13 | First-chat exclusion controls | **P** | `settings-persistence-split` rust leg = committed `test.fail` citing SESSION-13 (RED-demoed gap). Not replicated/applied yet. |
| SESSION-14 | Normalize provider timestamps + recency | **P** | Directory-index projection exists. Missing: `PW-RUST` fractional-floor / stable-ordering spec. |
| SESSION-15 | Browser-local visibility filters | **N** | Empty/subagent/noninteractive local filters not restored. |
| SESSION-16 | Tolerate malformed/partial provider data | **P** | codex "tolerate unknown item types" (42f24759) + opencode robustness. Missing: `PW-RUST` malformed/truncated/invalid-UTF-8 quarantine + live-revalidate spec. |
| SESSION-17 | Provider-qualified identity everywhere | **P** | Provider-qualified override keys implemented (see SESSION-22). Missing: `PW-RUST` cross-provider no-leak spec. |
| SESSION-18 | Extension-owned session providers | **N** | Discovery still built-in only. |
| SESSION-19 | Accurate match tier + safe snippets | **N** | Deferred with SESSION-07. |
| SESSION-20 | Cached indexed read model | **P** | Index cache (5c020be3) + incremental (ffa83d0c) + staging perf (cold ~2s → warm 46ms). Missing: the **stress-project** `PW-RUST` spec asserting scan counters don't grow + bounded keystroke latency. |
| SESSION-21 | Backfill missing Claude history idempotently | **N** | Not implemented. |
| SESSION-22 | Legacy + provider-qualified override keys | **P** | Migration/apply of raw + `provider:id` keys implemented. Missing: `PW-RUST` precedence/no-leak spec. |

---

## P0 — Terminal creation, restoration, and safety (TERM-01 … 27)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| TERM-01 | Launch every registered terminal mode | **P** | Shell proven on rust (`terminal-lifecycle.spec.ts`, green matrix); amplifier mode manifest (d78e1f01). Missing: per-mode fixture-banner argv/env `PW-RUST` spec for all modes (needs HARNESS-03). |
| TERM-02 | Managed Codex app-server path | **P** | codex WS runtime (05fa66c5); `restore-matrix` scenario 2 ("FreshCodex reload rehydrates the same session") green on **rust**, proving reload-rehydrate + no second process. Missing: the server-**restart** leg of "resume same thread." *(codex-first)* |
| TERM-03 | Restore imported provider tabs by `sessionRef` | **P** | codex reload (restore scenario 2); opencode restart-recovery (Node). Full 16-tab restore is `PW-TAURI-WIN`. |
| TERM-04 | Deduplicate terminal creation (`createRequestId`) | **P** | `reconnection.spec.ts` "pending terminal creates retry after reconnect" runs **Node-only**. Missing: two-client single-PID `PW-RUST` spec. |
| TERM-05 | Reuse canonical live-session owners | **P** | liveTerminal join (d5cf534a); opencode continuity. Missing: two-context single-owner `PW-RUST` spec. |
| TERM-06 | Enforce `expectedSessionRef` identity | **P** | opencode/attach sessionRef checks + AUTO-07 conflict. Missing: four-op A/B `PW-RUST` table. |
| TERM-07 | Attach intent/priority/replay/geometry | **P** | `terminal-lifecycle` "no attach/resize when geometry unchanged" green on rust (a slice). Missing: full parameterized intent/replay-budget `PW-RUST` spec. |
| TERM-08 | Output-gap / stream-change events | **P** | T1 byte-stream oracle; `terminal-background-freeze-catchup` (Node, chromium-only). Missing: `PW-RUST` gap/`stream.changed` spec. |
| TERM-09 | Bound per-client output / slow clients | **P** | visible-first perf audit; `opencode-replay-write-progression` (Node). Missing: stress-project slow-client `PW-RUST` spec (HARNESS-05). |
| TERM-10 | Terminal admission controls | **P** | `server-restart-recovery` asserts "without rate limit errors" (limiter exists). Missing: burst-past-cap `PW-RUST` spec. |
| TERM-11 | Detached-idle cleanup (`autoKillIdleMinutes`) | **P** | Honored (commit f7b2c9e6). Missing: HARNESS-14 clock + `PW-RUST` eligible-only-exits spec. |
| TERM-12 | Exited-record cap | **N** | Not clearly implemented on this branch. |
| TERM-13 | Honor configured scrollback | **P** | UTF-16 scrollback cap (commit 4067721e; reviewer caught chars-vs-bytes) + crate test. Missing: `PW-RUST` two-setting detach/reconnect boundary spec. |
| TERM-14 | Restore terminal metadata (git/token/model) | **N** | Header/sidebar metadata not restored. |
| TERM-15 | Terminal-mode provider activity | **P** | `pane-activity-indicator.spec.ts` "claude terminals go blue … clear on idle" runs **Node-only**. Missing: `PW-RUST` correlated-frame activity spec. |
| TERM-16 | Server-authoritative terminal completion | **P** | T2 completion-edge invariants (oracle). Missing: `PW-RUST` green/sound-only-on-success + Gemini/Kimi-inert spec. |
| TERM-17 | Session-association + title broadcasts | **P** | pane titles on resume (b9e0c1a3). Missing: `PW-RUST` monotonic/dedup spec. |
| TERM-18 | Recover provider process loss | **P** | codex onExit self-heal (05fa66c5); `restore-matrix` scenario 4 ("exited state instead of blank") green on rust. Missing: kill-mid-turn + retry + no-chime `PW-RUST` spec. *(codex-first)* |
| TERM-19 | Errors for invalid terminal operations | **P** | crate/oracle only. Missing: HARNESS-05 raw-frame `PW-RUST` spec. |
| TERM-20 | Native Windows command quoting/paths | **H** | `PW-RUST` native Windows (argv/env byte-compare). Unit env tests exist in `helpers/test-server.test.ts`. |
| TERM-21 | Viewport + paged-scrollback endpoints | **N** | Not ported. |
| TERM-22 | Codex lifecycle hardening | **P** | reaping/self-heal (05fa66c5, 0d46bc3a). **Known gap:** open item #5 — codex crash-recovery mints a *new* thread id (model memory lost). Missing: stress-project + HARNESS-12 `PW-RUST` spec. *(codex-first)* |
| TERM-23 | Codex candidate-persistence handshake | **P** | Codex durability plumbing partial; open item #2 (session id unknown at spawn) unresolved. Missing: provisional→durable `PW-RUST` spec. *(codex-first)* |
| TERM-24 | Codex input-blocking/recovery reason matrix | **N** | Full reason matrix not evidenced. |
| TERM-25 | Prevent wrong-thread Codex recovery | **N** | Not evidenced (and related to the open-item #5 crash-thread risk). |
| TERM-26 | Native Windows home + terminal `~` | **H** | `PW-RUST` native Windows. Home-resolution fix (f7b2c9e6) + unit tests exist. |
| TERM-27 | Amplifier hardened association/event-log/recency | **P** | Only the amplifier terminal-mode manifest (d78e1f01) landed; hardened association/EOF-resume/recency is `main`'s #514 work, **not on this branch** (bake-in #3). |

---

## P0 — Rich-agent parity (AGENT-01 … 25)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| AGENT-01 | Provider-neutral create/send | **P** | codex+opencode WS runtimes; `fresh-agent.spec.ts` (Node). Missing: all-provider `PW-RUST` create/send spec. |
| AGENT-02 | Attach/resume + reload hydration | **P** | codex leg green on rust (`restore-matrix` scenario 2). Missing: "exactly 3 turn pairs after restart, resumed streaming, no duplicate process" assertions + non-codex legs. |
| AGENT-03 | Interrupt vs kill (separately) | **P** | codex WS interrupt/kill (05fa66c5). Missing: `PW-RUST` no-sound + session-preserved spec. |
| AGENT-04 | Compact | **N** | Deferred to Phase 3. |
| AGENT-05 | Approval responses + cancellation | **P** | `mobile-viewport`/`fresh-agent` permission banners (Node). Missing: `PW-RUST` zero-decisions-before-click + `permission.cancelled` spec. |
| AGENT-06 | Question responses | **N** | Not implemented. |
| AGENT-07 | Session fork | **P** | freshcodex fork **metadata display** only (`fresh-agent.spec.ts`, Node). Fork *operation* not implemented. |
| AGENT-08 | Preserve OpenCode continuity | **P** | Continuity fix (b1b853d1); `opencode-*`/`freshopencode-*` specs (Node). Missing: 3-REST-sends-one-ID `PW-RUST` spec. |
| AGENT-09 | Transcript snapshot + paged-turn APIs | **P** | thread-snapshot endpoint (0002a1d0) + rich items (ff8edc71) + includeTurns fallback (e5670aec). Missing: `PW-RUST` pagination/invalid-cursor spec. |
| AGENT-10 | Model capabilities + refresh | **P** | `freshopencode-model-picker.spec.ts` MRU/filtering (Node). Missing: refresh-without-restart `PW-RUST` spec. |
| AGENT-11 | File/image attachments | **N** | Deferred. |
| AGENT-12 | Per-send model/effort/sandbox/permission | **P** | model defaults/create payload (Node). Missing: per-send distinct-payload + durable-model `PW-RUST` spec. |
| AGENT-13 | Command-execution + diff APIs | **N** | Not implemented. |
| AGENT-14 | Checkpoint create/list/metadata/restore | **P** | **create-only** endpoint (a220d84e); list/restore deferred (open item #6). Missing: restore impl + `PW-RUST` spec. |
| AGENT-15 | Inject Freshell MCP tools into rich agents | **N** | Not evidenced. |
| AGENT-16 | Scope subscriptions per client/session | **P** | opencode isolation plumbing (see AGENT-23). Missing: `PW-RUST` authorized-only-markers spec. |
| AGENT-17 | Recover crashed sidecars, clear stale records | **P** | codex/opencode self-heal + `freshopencode-restart-recovery` (Node). Missing: no-green/sound + retry `PW-RUST` spec. |
| AGENT-18 | Server-authoritative waiting/completion dedupe | **P** | `freshagent-wireshape-differential` (codex) + completion-edge design; `pane-activity-indicator` freshclaude waiting→running (Node). Missing: dedupe-across-restart `PW-RUST` spec. |
| AGENT-19 | Complete rich-agent error contract | **P** | tolerate-unknown-codex-types (42f24759) avoids 500s. Missing: full status/code table `PW-RUST` spec. |
| AGENT-20 | Standalone `/api/fresh-agent/send` | **N** | Not evidenced as its own addressed-session endpoint. |
| AGENT-21 | Idempotent create/fork/send retries | **N** | Fresh-agent request-id dedup not evidenced. |
| AGENT-22 | Materialize OpenCode placeholder exactly once | **P** | `freshopencode-first-send-reload-repro` + `freshopencode-db-history` (Node) prove placeholder repair/materialization. Missing: re-target to `rust-chromium`. |
| AGENT-23 | Isolate OpenCode process + cwd routing | **P** | shared serve + route-bound sessions (f7358d04; `freshopencode-restart-recovery` "route-bound serve session", Node). Missing: cross-route no-leak `PW-RUST` spec. |
| AGENT-24 | Kilroy rich-agent parity | **N** | Not implemented. |
| AGENT-25 | Capability-matrix gate | **N** | Not implemented. |

---

## P1 — Tab, pane, CLI, and MCP automation (AUTO-01 … 15)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| AUTO-01 | `ui.layout.sync` authoritative | **P** | `fresh-agent-centralization-smoke` normalizes remote layout sync (Node). Missing: full-snapshot `PW-RUST` spec. |
| AUTO-02 | Provider-neutral tab creation + rollback | **P** | `/api/tabs` exists (AGENTS.md). Missing: parameterized-content `PW-RUST` + failure-rollback spec. |
| AUTO-03 | Tab list/select/rename/delete/exists/next/prev | **P** | `tab-management.spec.ts` (Node). Missing: `PW-RUST` route+layout-agree spec. |
| AUTO-04 | Layout snapshot + pane listing | **P** | layout snapshot plumbing. Missing: nested-layout `PW-RUST` compare + tab-ID filter spec. |
| AUTO-05 | Pane split every content type + rollback | **P** | `pane-system.spec.ts` (Node). Missing: `PW-RUST` split + failure-rollback spec. |
| AUTO-06 | Pane rename/close/select/resize/swap/respawn | **P** | `PATCH /api/panes/:id` (d5cf534a) + `pane-system` (Node). Missing: `PW-RUST` route + cleanup spec. |
| AUTO-07 | Attach-existing-terminal w/ identity checks | **P** | attach rehydrate (0d46bc3a). Missing: `PW-RUST` replay+one-PID+mismatch-conflict spec. |
| AUTO-08 | Browser-pane navigation | **P** | `browser-pane.spec.ts` green on **rust** (UI navigate + pane-ID stable + preserve across switch). Missing: **API** navigation + invalid-target-error assertions. |
| AUTO-09 | Pane send + capture (type-correct) | **P** | send-keys/capture (AGENTS.md). Missing: `PW-RUST` byte-exact + unsupported-pair spec. |
| AUTO-10 | Wait-for | **P** | wait-for endpoint exists. Missing: `PW-RUST` text/regex/exit/idle + isolation spec. |
| AUTO-11 | Legacy `/api/run` | **N** | Not evidenced. |
| AUTO-12 | `codingcli.create/input/kill` WS API | **N** | Not evidenced (needs HARNESS-05). |
| AUTO-13 | Every registered MCP command | **N** | MCP `freshell` tool exists but no generated-inventory `PW-RUST` coverage. |
| AUTO-14 | Target automation/screenshots to correct window | **P** | `POST /api/screenshots` + `ui.screenshot.result` (oracle §3.18). Missing: two-context correct-window `PW-RUST` spec. |
| AUTO-15 | Tab/device conflict + retirement | **N** | Depends on CFG-08 (absent); `tabs-client-retire` is Node-only. |

---

## P1 — Extensions (EXT-01 … 10)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| EXT-01 | Strict manifest schema | **N** | Not ported (beyond the amplifier CLI-mode manifest). |
| EXT-02 | Discovery roots/precedence/symlink safety | **N** | Not evidenced. |
| EXT-03 | Live manifest reload + broadcasts | **N** | Not evidenced. |
| EXT-04 | Enable/disable + extension-scoped settings | **N** | Not evidenced. |
| EXT-05 | CLI-extension launch + permission mappings | **N** | Not evidenced (amplifier mode aside). |
| EXT-06 | Serve client-extension assets | **N** | Not evidenced. |
| EXT-07 | Server-extension start + shared readiness | **N** | Not evidenced. |
| EXT-08 | Server-extension failure/retry/crash/stop | **N** | Not evidenced. |
| EXT-09 | Secure extension routes + process launch | **N** | Not evidenced. |
| EXT-10 | Amplifier manifest/icon/warning suppression | **P** | amplifier terminal-mode manifest (d78e1f01) + picker icon restored (f7b2c9e6). Depends on gapped TERM-27/SESSION amplifier legs; no `PW-RUST` picker/history spec. |

---

## P1 — Browser panes, proxying, files, editors (BROWSER-01 … 05, FILE-01 … 06)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| BROWSER-01 | Same-origin HTTP reverse proxy | **P** | loopback reverse-proxy (oracle §3.18); `browser-pane-screenshot.spec.ts` proves CSP/X-Frame content renders — but **Node-only** (not in MATRIX_SPECS). Missing: `PW-RUST` GET/POST/streaming upstream-input spec. |
| BROWSER-02 | WebSocket upgrade proxying | **N** | Not evidenced. |
| BROWSER-03 | Remote browser forwarding | **N** | Not evidenced. |
| BROWSER-04 | Restrict proxy destinations/requesters | **N** | Phase-1 security future. |
| BROWSER-05 | Proxy failure/retry + correct screenshot | **P** | `browser-pane-screenshot` cross-origin fallback (Node) + `/api/screenshots`. Missing: `PW-RUST` target-specific Retry + deterministic-frame spec. |
| FILE-01 | Authenticated `/local-file` | **P** | files read/write/stat/mkdir (oracle §3.18). Missing: `PW-RUST` MIME/bytes + credential-matrix spec. |
| FILE-02 | Windows drive + UNC file URLs | **H** | `PW-TAURI-WIN` + SMB share. |
| FILE-03 | POSIX/Windows/WSL/UNC normalization | **P** | file ops exist. Missing: paired-fixture `PW-RUST` Linux/WSL/Windows projects. |
| FILE-04 | `/api/files/open` + external editor/reveal | **N** | Not evidenced (editor-pane spec is the client editor, Node). |
| FILE-05 | `allowedFilePaths` live everywhere | **N** | Phase-1 future. |
| FILE-06 | Traversal/symlink/case-fold protection | **N** | Not evidenced as a negative matrix. |

---

## P1 — Network management (NET-01 … 10)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| NET-01 | Complete live network status | **N** | netsh golden-strings captured but not executed; no live-status `PW-RUST` spec. |
| NET-02 | Transactional configure/rebind | **N** | Not evidenced. |
| NET-03 | Accurate share URL (no token logging) | **N** | `PW-TAURI-WIN`; not evidenced. |
| NET-04 | Windows firewall configure/repair | **H** | Disposable elevated Windows VM. |
| NET-05 | WSL2 forwarding without WSLg | **H** | Native Windows + WSL. |
| NET-06 | Safe disable of remote access | **N** | Not evidenced. |
| NET-07 | Elevation denial/timeout/partial | **H** | Windows elevation fault fixture. |
| NET-08 | Secure every network mutation | **N** | Not evidenced. |
| NET-09 | Keep network writes lossless | **P** | Would ride the CFG-01 serialized store. Missing: `PW-RUST` toggle+restart byte-preserve spec. |
| NET-10 | Native Linux status + `ufw` guidance | **N** | Golden-string only; no `PW-RUST` native-Linux spec. |

---

## P1 — Diagnostics, logging, AI, bootstrap (DIAG-01 … 08)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| DIAG-01 | Structured JSONL server/Tauri logs | **P** | Logs exist (`perf/parse-server-logs.ts` consumes them). Missing: `PW-RUST` required-field/correlation spec. |
| DIAG-02 | Persist client logs | **N** | Not evidenced. |
| DIAG-03 | Redact secrets + rotate | **N** | First-week future; not implemented. |
| DIAG-04 | Live debug/perf toggles | **P** | `settings.spec.ts` "debug logging toggle" (Node) + perf harness. Missing: `PW-RUST` enabled-interval-only spec. |
| DIAG-05 | `/api/debug` `/api/perf` `/api/server-info` | **P** | server-info + counts (oracle). Missing: `PW-RUST` sanitized-redaction spec. |
| DIAG-06 | Terminal summaries + optional AI | **N** | Not evidenced (Gemini summary path unproven). |
| DIAG-07 | Truthful, bounded bootstrap | **P** | bootstrap payload with fallback/seed fields exists. Missing: `PW-RUST` barrier/abort spec. |
| DIAG-08 | Synchronize runtime version identity | **N** | Status notes stale `0.7.0`; not synced. |

---

## P1 — Protocol, security, reliability limits (SAFE-01 … 13)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| SAFE-01 | Token validation/auth rules | **P** | Auth hardening (1cb497ee) + deviation record (intentionally stricter than legacy) + `auth.spec.ts` (Node) + crate tests. Missing: parameterized bad-token `PW-RUST` spec. |
| SAFE-02 | Global authenticated rate limit | **P** | Limiter exists (`server-restart-recovery` "no rate limit errors"). Missing: 429/`Retry-After` `PW-RUST` spec + HARNESS-14. |
| SAFE-03 | WebSocket Origin policy | **P** | Enforced allow-list (1cb497ee; intentional deviation, stricter than legacy) + crate tests. Missing: raw-socket origin-matrix `PW-RUST` spec (HARNESS-05). |
| SAFE-04 | Max authenticated WS connections | **P** | `multi-client` "many concurrent connections" (Node). Missing: cap-enforcement `PW-RUST` spec. |
| SAFE-05 | Hello timeout + JSON ping/pong + heartbeat | **P** | Server-initiated keepalive (764242c4; "0 reconnect errors vs 7 baseline"). Missing: `PW-RUST` JSON-pong + stale-only-close spec (HARNESS-05). |
| SAFE-06 | Inbound/outbound/bootstrap bounds | **P** | Bounds plumbing. Missing: just-below/above-limit `PW-RUST` spec. |
| SAFE-07 | Complete client→server protocol inventory | **P** | T0 handshake deep-equal (oracle) covers a slice. Missing: generated-schema-table `PW-RUST` spec. |
| SAFE-08 | Client restore diagnostics + repair | **P** | bulletproof restore (89f4b2fe). Missing: restore-loop-prevention `PW-RUST` spec. |
| SAFE-09 | Cancel abandoned long-running requests | **N** | Not evidenced. |
| SAFE-10 | Critical broadcast-lag recovery | **N** | Phase-2 future. |
| SAFE-11 | Graceful ownership-safe shutdown | **P** | `port/oracle/robustness/*` kill/exit artifacts. Missing: native-Windows `PW-RUST` graceful-then-escalate spec (paired with TERM-22). |
| SAFE-12 | Bounded mixed-load soak | **N** | `stress.spec.ts` is Node-basic; no instrumented soak. |
| SAFE-13 | Server→client event inventory | **P** | T0 schema conformance + wire-shape differential cover slices. Missing: generated-manifest `PW-RUST` spec. |

---

## P1 — Native Windows Tauri (TAURI-01 … 30) — all OUT-OF-SCOPE-HOST

All 30 require `PW-TAURI-WIN` or `PW-TAURI-WIN-PACKAGED` (native Windows + WebView2 CDP,
tray/menu/hotkey via UI Automation, elevated VM, packaged installer). Environment-limited per
campaign rules. **Class = H for TAURI-01 through TAURI-30.**

Note (not checkable, but real): `freshell-tauri` has ~89 unit-test cores for tray, global hotkey
(+ accelerator translation), window-state persistence (+ off-screen clamp), wizard/chooser
windows, updater config, and renderer-recovery (EQUIVALENCE-REPORT §3.17). These support future
TAURI-16/21/22/23/25/27/29 work but cannot satisfy the native-host acceptance lane.

| Range | Class |
|---|:--:|
| TAURI-01 … TAURI-30 | **H** (×30) |

---

## P2 — Packaging, installer, updater, upgrade (PACKAGE, UPDATE, MIGRATE) — all OUT-OF-SCOPE-HOST

| Range | Class | Note |
|---|:--:|---|
| PACKAGE-01 … 04 | **H** (×4) | Packaged Windows NSIS installer / signing / VM. |
| UPDATE-01 … 05 | **H** (×5) | Packaged updater feed + signing in a VM. |
| MIGRATE-01 … 13 | **H** (×13) | Electron→Tauri Windows migration (HARNESS-10). MIGRATE-06 leans on the CFG-01 writer, but its acceptance is `PW-TAURI-WIN`. |

---

## P2 — Current-`main` catch-up (SYNC-00 … 05)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| SYNC-00 | Reconcile branch with current `main` | **N** | Status doc explicitly says reconciliation NOT done; branch predates `main` #514/#513/#512. Blocks the inventory gate. |
| SYNC-01 | UI scale to 400% direct input | **N** | Not implemented on this branch. |
| SYNC-02 | Terminal font to 64px direct input | **N** | Only the existing slider (Node); no 64px direct-input work. |
| SYNC-03 | Editor font follows terminal font | **N** | **Already shipped on `main` (#513 / commit 99927623), not this branch.** Acceptance satisfiable only after SYNC-00 reconciliation. |
| SYNC-04 | Remove deprecated `freshAgent.fontScale` | **N** | **Already removed on `main` (#512 / commit 1f6bedc8), not this branch.** |
| SYNC-05 | Gate current-main expected-restart behavior | **N** | Depends on TERM-22/SAFE-11/TAURI-30. |

---

## Final release gates (GATE-01 … 08)

| ID | One-line | Class | Evidence / missing piece |
|---|---|:--:|---|
| GATE-01 | Legacy suite on Node AND Rust, no rust-only skips | **P** | Matrix machinery exists (HARNESS-02), but only 8 specs run on `rust-chromium`; the empty-skip report is not achievable until the full suite runs on Rust. |
| GATE-02 | Full native Windows Tauri suite on packaged installer | **H** | Clean Windows VM. |
| GATE-03 | Upgrade safety on a representative legacy profile | **H** | Windows VM + Electron profile. |
| GATE-04 | Multi-client isolation + recovery | **P** | `multi-client.spec.ts` runs both kinds, but the reconnect leg is a **known flake on both kinds** + untouched baseline; crash/isolation coverage incomplete. |
| GATE-05 | Resource/process hygiene under stress | **N** | No instrumented stress gate (needs HARNESS-12). |
| GATE-06 | Security boundaries | **N** | No negative-matrix gate. |
| GATE-07 | Accessibility + keyboard | **N** | Needs HARNESS-11 (absent). |
| GATE-08 | One parity receipt | **N** | No receipt reporter/validator. |

---

## TOP-10 cheapest conversions (PARTIAL → CHECKABLE-NOW)

Ranked by effort (lowest first), with the standing **codex-first** directive bumping
codex-related items up. "Cheap" = the implementation already exists AND rust-adjacent evidence is
already green, so the only missing piece is a matrix spec (or extra assertions on an existing
green spec) — no new harness dependency.

| # | ID | Why it's cheap | The one addition | Codex? |
|---|---|---|---|:--:|
| 1 | **TERM-02** | `restore-matrix` scenario 2 already green on **rust** (FreshCodex reload-rehydrate, no 2nd process); pattern for a restart leg already exists in scenario 1. | Add a server-**restart** leg asserting the same thread resumes. | ✅ |
| 2 | **AGENT-02** | Same green codex reload spec covers attach/resume. | Add "exactly 3 turn pairs after restart + resumed streaming + no duplicate process" assertions to that spec. | ✅ |
| 3 | **TERM-18** | `restore-matrix` scenario 4 (exit surfacing) already green on rust; fake codex child already exists. | One `PW-RUST` spec: kill mid-turn → blue clears, exited/retry, **no chime**, retry resumes. | ✅ |
| 4 | **TERM-13** | Impl + crate test done (4067721e), no new harness. | One `PW-RUST` detach/reconnect boundary spec under two scrollback settings. | — |
| 5 | **AGENT-08** | Continuity impl done; Node specs green. | Add opencode to MATRIX_SPECS and assert one durable ID across 3 REST sends. | — |
| 6 | **AGENT-22** | `freshopencode-first-send-reload-repro` + `-db-history` already green (Node). | Re-target them to `rust-chromium`; assert one materialization + no placeholder remains. | — |
| 7 | **AUTO-08** | `browser-pane.spec.ts` already green on rust (UI nav + stable pane ID). | Add **API**-navigation + invalid-target-error assertions. | — |
| 8 | **SESSION-01** | Claude leg already green on rust (`session-directory-matrix`). | Extend the seeded corpus to Codex+OpenCode and assert icons/titles/ordering. | (codex leg) |
| 9 | **CFG-01** | Lossless writer + crate + staging probe done. | One `PW-RUST` seed-sentinels/deep-compare-per-writer spec (no new harness, but many writers). | — |
| 10 | **SAFE-05** | Keepalive impl done; browser-level evidence green. | A small raw-WS helper (HARNESS-05 slice) asserting the JSON pong + stale-only close. | — |

(Deliberately excluded from the top-10 despite strong impl: **TERM-11**, **SAFE-02**, **AUTO-15**
— all blocked on the missing **HARNESS-14 clock**; **SESSION-20** — needs the stress project;
**CFG-07** — needs a *behavior change* first, see surprise #2.)

---

## Surprises worth the orchestrator's attention

1. **The strict bar unlocks no new checkboxes.** Only HARNESS-01/02 fully qualify, and both are
   already checked. The recurring reason a rich, well-tested behavior still can't be checked is
   structural: its spec runs against the **Node** `TestServer` (default `chromium` project), not
   the Rust binary. Only the 9 MATRIX_SPECS drive Rust. This is a "wire the matrix," not a
   "write the feature," problem for a large fraction of the 93 PARTIALs.

2. **CFG-07 is currently *contradicted*, not merely unproven.** HARNESS-02's bite spec depends on
   *"Node-persists / Rust-regenerates instanceId across restart."* The Rust server regenerates
   its installation identity on restart — the exact opposite of CFG-07's "reuse one instance ID
   for the same home." CFG-07 as written would **fail** on today's binary; it needs a behavior
   change before any spec.

3. **Three items already have committed RED evidence (proven-missing, not just unevidenced):**
   `settings-persistence-split.spec.ts`'s rust leg is a committed `test.fail` citing **CFG-04,
   CFG-12, and SESSION-13**. Do not read "a spec exists" as "passing" for these.

4. **`restore-matrix` scenario 3 is `test.fixme` (skipped).** SESSION-10's "open a seeded
   historical session → real pane title + non-blank content" is explicitly not green. Nobody
   should check SESSION-10's restore clause on the strength of the restore suite.

5. **SYNC-03 and SYNC-04 describe work that already shipped on `main`** (editor-font-follows-
   terminal #513; `freshAgent.fontScale` removal #512), and are absent on this branch — the
   branch temporarily *trades them away* (status doc, SYNC-00). Their acceptance text is
   satisfiable only after the main-reconciliation, so they read as NO-EVIDENCE here even though a
   naive reader might assume they're done.

6. **Oracle green moves nothing.** T0/T1/T2/mutation/wire-shape are all green and impressive, but
   the checklist's own completion rule says a narrow protocol oracle is insufficient; every
   protocol item (SAFE-07/13, CFG-01, TERM-08, etc.) still needs its `PW-RUST` spec. The oracle
   supports PARTIAL, never CHECKABLE-NOW.

7. **Amplifier indexing is genuinely ambiguous.** Commit 64083989 says "add Amplifier as a fourth
   session-directory source," while bake-in caveat #3 says ":3002 doesn't index amplifier yet."
   SESSION-01 / TERM-27 / EXT-10 amplifier legs must be verified against the binary before any
   check — the commit log and the operator log disagree.

8. **A known correctness gap sits under a codex-first item:** open item #5 — codex crash-recovery
   mints a *new* thread id (UI continuity OK, model memory lost). This directly limits TERM-22
   and TERM-25 and should be resolved before either is considered.
