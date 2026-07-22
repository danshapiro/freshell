# DEV-0006 — Codex Managed App-Server Launch Planning: Implementer-Ready Spec

- **Status:** proposed (read-only investigation; no live-tree changes)
- **Date:** 2026-07-19
- **Workspace:** `/home/dan/code/freshell/.worktrees/rust-tauri-port` (branch `feat/rust-tauri-port`, HEAD `8e7482e1`)
- **Frozen reference:** `server/ shared/ src/` (Jul-4 port snapshot; `origin/main` in `/home/dan/code/freshell` is newer — Jul-8 — but the port targets the frozen snapshot)
- **Scope of this doc:** close DEV-0006 (wire codex managed app-server launch planning into the two terminal-mode create paths). Read-only; produces the plan only.

> **Concurrency note:** five implementer agents are editing the live tree. Every `file:line` below is against the committed state at `8e7482e1` and will drift. Re-anchor with `grep`/LSP before editing.

---

## 0. The deviation record (quoted verbatim)

From `port/oracle/DEVIATIONS.md:517-526`:

```
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
```

Council record: **a PARTIAL port (create-upsert/exit-remove only) was REJECTED** (`DEVIATIONS.md:608`, in DEV-0008). DEV-0008 (`terminal.meta.updated` metadata badges) is explicitly tracked to **close together with DEV-0006** (`DEVIATIONS.md:643-652`, `HANDOFF.md:763`).

---

## 1. Legacy behavior — end to end

### 1.1 The one decision that matters: codex terminal mode ALWAYS launches managed

There is **no "app-server vs plain CLI" branch** for codex terminal panes. Every live `terminal.create {mode:'codex'}` (WS) and every `POST /api/tabs {mode:'codex'}` (REST) calls `planCodexLaunch → CodexLaunchPlanner.planCreate`, which **unconditionally** spins up an app-server runtime + a remote proxy, whether the create is fresh or a resume. The fresh-vs-resume distinction only tunes three knobs — it never bypasses the app-server.

Concretely (`launch-planner.ts:125-175`): `planCreate` calls `runtime.ensureReady(cwd)` in **both** branches; the only differences are `requireCandidatePersistence` (false on resume, default-true on fresh) and whether `plan.sessionId` is set.

### 1.2 The decision table

| Input (codex mode) | binding reason | `plan.sessionId` | `requireCandidatePersistence` | launches app-server? | first argv tokens | source |
|---|---|---|---|---|---|---|
| fresh (no resumeSessionId) | `start` | (unset) | true (default) | **YES** | `--remote <proxyWs> -c features.apps=false` + notif pair + mcp | `launch-planner.ts:153-163`; `codex-launch-config.ts:22-27` |
| valid resume (resumeSessionId set) | `resume` | resumeSessionId | false | **YES** | same `--remote` 4-tuple, plus resume args | `launch-planner.ts:136-151` |
| REST raw `resumeSessionId`, no matching `sessionRef` | — | — | — | **REJECT 400** `INVALID_RAW_CODEX_RESUME_MESSAGE` | (no launch) | `router.ts:221-226`; `restore-decision.ts:27-28,40-46` |
| restore requested, no session ref (repair path) | — | — | — | **REJECT** `RESTORE_UNAVAILABLE` | (no launch) | `restore-decision.ts:56-62` |
| `shell` / non-codex modes | n/a | — | — | NO | mode-specific | — |

`getCodexSessionBindingReason(mode, requestedResumeSessionId)` (`codex-launch-config.ts:22-28`) is the whole reason function: `mode !== 'codex' → undefined`; else `requestedResumeSessionId ? 'resume' : 'start'`. `SessionBindingReason = 'start' | 'resume' | 'association'` (`terminal-stream/registry-events.ts:3`).

`planCodexCreateRestoreDecision` / `resolveCodexCreateRestoreDecision` (`restore-decision.ts:32-77`, used at `ws-handler.ts:2029,2255`) is the **restore-identity validator** (reconnect / session-repair), NOT a launch-vs-no-launch switch. It yields `fresh_codex_launch` | `durable_session_ref_resume` | reject; the first two both still flow into `planCodexLaunch`.

### 1.3 The managed launch flow (WS path, the exemplar)

`ws-handler.ts:2438-2519`:

1. `requestedCodexResumeSessionId = m.mode==='codex' ? effectiveResumeSessionId : undefined` (`:2438`).
2. `codexPlan = await this.planCodexLaunch(cwd, requestedCodexResumeSessionId, providerSettings, CODEX_INITIAL_LAUNCH_ATTEMPTS)` (`:2442-2449`). `planCodexLaunch` (`:928-950`) requires `this.codexLaunchPlanner`, builds `{cwd, resumeSessionId, model, sandbox, approvalPolicy}` and calls `planCodexLaunchWithRetry({planner, input, attempts, logger})` (`launch-retry.ts:16-33` → `planner.planCreate(input)`).
3. `planCreate` (`launch-planner.ts:125-175`): `runtime.ensureReady(cwd)` → upstream app-server `wsUrl`; `proxy = new CodexRemoteProxy({upstreamWsUrl})`; `proxyReady = await proxy.start()`. Returns `{ sessionId?, remote: { wsUrl: proxyReady.wsUrl }, sidecar }`. **The proxy's wsUrl — not the runtime's — is what the TUI is pointed at.**
4. Provider settings for the spawn carry the plan: `codexAppServer: { ...codexPlan.remote, sidecar, recovery, deferLifecycleUntilPublished: true }` (`:2474-2492`); model/sandbox/permissionMode are STRIPPED from the codex spawn settings (`:2464-2465`) because they route through the plan instead.
5. `terminalSessionBindingReason = getCodexSessionBindingReason(m.mode, requestedCodexResumeSessionId)` (`:2496-2498`), passed to `registry.create`.
6. After create: `codexPlan.sidecar.adopt({ terminalId, generation: 0 })` (`:2511`), `assertCodexCreateTerminalRunning`, `registry.publishCodexSidecar(terminalId)` (`:2515`). Recovery closure re-plans on sidecar loss (`:2454-2459`).

The argv is finally assembled in `terminal-registry.ts:295-307`: when `providerSettings.codexAppServer` is present, it validates the `wsUrl` is `ws://127.0.0.1:*` and pushes `'--remote', wsUrl, ...CODEX_MANAGED_REMOTE_CONFIG_ARGS` where `CODEX_MANAGED_REMOTE_CONFIG_ARGS = ['-c','features.apps=false']` (`codex-managed-config.ts:1-4`).

REST path is the same shape: `agent-api/router.ts:160-195` (`planCodexLaunchWithRetry`), `:737` + `:742` (`getCodexSessionBindingReason`), `:1175/:1335/:1572` (`codexLaunchPlanner` threaded through the three create call-sites), and the same `sidecar.adopt/publish` lifecycle.

### 1.4 The proxy is the point (why it's not just an argv token)

`CodexRemoteProxy` (`remote-proxy.ts`, ~52 KB) is a `WebSocketServer` the codex TUI connects to; it relays frames to/from the upstream app-server while **scanning JSON-RPC envelopes** (`json-rpc-envelope.ts`) and **extracting side effects** (`json-rpc-side-effects.ts`): thread-start candidates (`CodexRemoteProxyCandidate`), thread-lifecycle events, turn started/completed params, fork-request rewrites, fs-changed repair triggers. That capture is what feeds durability (a durable `sessionRef` for the pane), turn/activity tracking (`codex-activity-tracker.ts`), and session association. **A `--remote` URL that points at nothing is useless** — the token and the machinery are one deliverable.

### 1.5 What the `codexDisplayIdSecret` is NOT (scoping fence)

`codexDisplayIdSecret` (`config-store.ts:439-451`, `serverSecrets.codexDisplayIdSecret`) is consumed **only** by the fresh-agent (chat pane) codex adapter — `index.ts:322-324` passes it into `createCodexFreshAgentAdapter`, where `adapter.ts:287-294,472,981-982` uses it as the HMAC secret for **stable turn display IDs** (`createCodexDisplayId`). The terminal-mode launch planner (`index.ts:359`) does **not** take it. **Display-id wiring is out of scope for DEV-0006** — it is a chat-pane (freshcodex) concern, already ported, unrelated to `--remote` terminal launches.

---

## 2. The port's current state

### 2.1 What the two create paths do for codex today (the gap)

- **WS** `crates/freshell-ws/src/terminal.rs:831-835`: `let codex_remote_ws_url: Option<String> = None;` with a DEV-0006 comment. Codex terminal panes spawn plain `codex` with notif + MCP argv but **no `--remote` 4-tuple**. Raw codex `resumeSessionId` is accepted unconditionally (`:779-782`) — the legacy REST rejection is NOT enforced here (noted at `terminal_tabs.rs:100-107`).
- **REST** `crates/freshell-freshagent/src/terminal_tabs.rs:601-604`: `codex_remote_ws_url: None` in `CliLaunchInputs`, same gap; but this path DOES enforce the raw-resume rejection (`:124-129`, `INVALID_RAW_CODEX_RESUME_MESSAGE`).
- **Golden pin** `crates/freshell-platform/src/cli_launch_goldens.rs:623-650` `g_x0_codex_shipped_deviation_shape_dev_0006`: pins the exact shipped argv WITHOUT the `--remote` pair. The doc says: *"When the codex app-server plan is wired into terminal.create, this golden is REPLACED by G-X1 as the live-path shape."*
- **Resolver is ready:** `resolve_coding_cli_command` already emits the `--remote` 4-tuple when `codex_remote_ws_url: Some(_)` — goldens **G-X1/G-X2/G-W2 already pass** (per DEV-0006 record). The resolver is argv-complete; only a `Some(proxy_ws_url)` is missing.

### 2.2 What machinery the port already has (reusable)

The `freshell-codex` crate (`crates/freshell-codex/`) is a faithful port of the codex app-server **client** core:

- `app_server.rs` — `CodexAppServerClient`: `initialize→initialized` handshake, `thread/start`, `thread/resume`, `turn/start`, request/response correlation, notification consumer, over the injected `WsTransport` seam.
- `transport.rs` (behind `real-transport`) — `TungsteniteTransport` (real `tokio-tungstenite`) + the Linux `/proc` **ownership reaper** (`reap_owned_codex_sidecars`).
- `durability.rs` — thread-id / rollout shapes, `mint_ownership_id`, `CODEX_SIDECAR_OWNERSHIP_ENV`.
- `protocol.rs`, `events.rs`, `model.rs` — framing, status-guarded completion, effort/model normalization.

And the fresh-agent codex slice (`crates/freshell-freshagent/src/codex.rs`, ~5954 lines) already **spawns and owns a real sidecar**: `spawn_sidecar` (`codex.rs:1343-1449`) runs `codex -c features.apps=false app-server --listen ws://127.0.0.1:<port>`, connects the WS, runs `initialize`, and wires an **exit-watcher** + ownership reap + a notification consumer. `CODEX_MANAGED_CONFIG_ARGS` const at `codex.rs:79`.

**This is the chat-pane topology, and it is the reusable half:** freshell spawns the app-server and connects a *client* to it.

### 2.3 What is genuinely MISSING

The terminal-mode topology differs from chat in ONE structural way, and that difference is the whole gap:

| | fresh-agent chat (freshcodex) — **PORTED** | terminal codex TUI — **MISSING** |
|---|---|---|
| user-facing process | none; freshell renders chat | the real `codex` **TUI** |
| freshell ↔ app-server | freshell is the **client** (drives turns) | freshell is a **proxy in the middle**; the TUI drives |
| what freshell points the child at | n/a (no child TUI) | `--remote <proxy wsUrl>` |
| snooping | freshell owns every RPC | must scan relayed frames for candidates/turns |

Missing, in dependency order:

1. **A codex remote proxy** — a Rust port of `CodexRemoteProxy` + `json-rpc-envelope.ts` + `json-rpc-side-effects.ts`: a loopback `WebSocketServer` that accepts the TUI, relays to an upstream app-server, and extracts candidates / turn events / lifecycle. **Nothing like this exists in Rust** (grep: no `RemoteProxy`/`remote_proxy` in `crates/`). This is the large, novel deliverable.
2. **A launch planner** — a Rust `plan_create`: ensure an app-server runtime is ready (reuse `spawn_sidecar` mechanics) → start the proxy → return `{ sessionId?, remote_ws_url, sidecar_handle }`.
3. **Sidecar lifecycle** — `adopt(terminalId, generation)` → `publish` → cleanup-on-failure/teardown, mirroring `launch-planner.ts:221-316` and the `ws-handler.ts:2510-2516` adopt/publish sequence.
4. **Wiring** — populate `codex_remote_ws_url: Some(proxy_ws_url)` in BOTH create paths via shared code; strip codex model/sandbox/permissionMode from the spawn (already stripped at `terminal.rs:800`).
5. **Downstream consumers (DEV-0008-entangled, stage separately):** codex durability→`sessionRef` binding, `codex-activity-tracker` turn events, `terminal.meta.updated` push. Council REJECTED a partial port that ships (1)-(4) confidently but leaves (5) half-wired producing divergent records vs an honest absence — see §6.

---

## 3. Impact — what differs for users today

The EQUIVALENCE-REPORT disclosure (`EQUIVALENCE-REPORT.md:109`): *"codex panes in the Rust build run standalone, without freshell's managed app-server integration."* Concretely, because the TUI runs unmanaged (no `--remote`, no proxy):

1. **No durable session binding for codex terminal panes.** With no proxy, no thread-start candidate is captured, so the durability/session-association subsystem has nothing to bind the pane to. This is the mechanism behind the **"codex sessions open blank"** sidebar class: a codex terminal pane's session is never captured/associated, so the sidebar cannot resolve or reopen it.
2. **`features.apps` is not forced off.** The reference forces `features.apps=false` for managed panes; the port leaves it at the CLI default — a real (if subtle) behavioral divergence.
3. **No managed turn/activity tracking** for codex terminal panes (the proxy's turn started/completed capture). Note: the bel-based turn-complete notification (`tui.notification_method=bel`) IS in the ported argv and is a separate path; the *managed* activity/durability stream is what's absent.
4. **DEV-0008 metadata badges** (`terminal.meta.updated`: git branch/dirty, token usage) stay absent for codex panes — the producer is entangled with this same session-association subsystem and is tracked to close **with** DEV-0006 (`DEVIATIONS.md:641-652`).

No crash / no stale-confident data: absent, not wrong. That is exactly why council accepted the gap as ship-safe but keeps it tracked for closure.

---

## 4. Verify-before-you-trust (partial-mootness check)

The task asked to verify whether the gap is partially moot (e.g. legacy uses app-server only for chat panes, not terminal panes). **It is NOT moot.** Legacy calls `planCodexLaunch` on the terminal `terminal.create` path for **every** codex pane (`ws-handler.ts:2442-2449`, `agent-api/router.ts:165` for REST), fresh or resume. Terminal-mode codex is *always* managed in legacy. The port omits it for all codex terminal panes. The full parity target stands.

The only genuinely-narrow part is the **argv**: the resolver already emits the 4-tuple given a URL (G-X1/G-X2/G-W2 pass). Everything behind the URL (runtime + proxy + lifecycle) is the real work.

---

## 5. Implementation spec (minimal slices to parity)

Build a new `crates/freshell-codex/src/remote_proxy.rs` (+ envelope/side-effect helpers) and a launch-planner seam, then wire both create paths through ONE shared function. Slices are ordered so each is independently testable and lands green.

### Slice 1 — Envelope scan + side-effect extraction (pure, no IO)

Port `json-rpc-envelope.ts` (`scanJsonRpcEnvelope`, `MAX_FULL_PARSE_BYTES`, `MAX_RAW_FORWARD_BYTES`) and `json-rpc-side-effects.ts` (`extractThreadStartResponseCandidate`, `extractThreadStartedNotificationSideEffects`, `extractTurnNotificationEvent`, `extractThreadLifecycleEvent`, `extractFsChangedRepairTrigger`, `extractForkResponseCandidate`, `rewriteThreadForkRequestExcludeTurns`, `normalizeThreadForkResponseForTui`) as pure functions over `serde_json::Value` / raw bytes. Output types mirror `CodexRemoteProxyCandidate` (`remote-proxy.ts:29-32`) and `CodexRemoteProxyRepairTrigger` (`:34-36`).

- **Tests:** table-driven unit tests over recorded frame fixtures for each extractor; byte-limit boundary tests; a fork-request rewrite round-trip test.

### Slice 2 — The remote proxy (loopback WS server)

`remote_proxy.rs`: a `tokio-tungstenite` server bound to `ws://127.0.0.1:<ephemeral>` that accepts the TUI connection, dials the upstream app-server wsUrl, and relays frames bidirectionally, running each frame through Slice 1. Expose `start() -> {ws_url}`, `close()`, and candidate/turn/lifecycle/repair subscription hooks matching the `CodexLaunchProxy` surface (`launch-planner.ts:73-86`). Reuse `LoopbackPortAllocator` (already used at `terminal.rs:818-820`).

- **Tests:** in-memory upstream fake (reuse the `freshell-codex` `ChannelTransport`/fake-app-server shapes); assert a TUI→upstream→TUI round-trip; assert a `thread/start` response yields one captured candidate; assert `close()` tears both sockets down and the ownership reaper runs.

### Slice 3 — Launch planner + sidecar lifecycle

`plan_create(input) -> CodexLaunchPlan` where `input = { cwd, resume_session_id, model, sandbox, approval_policy }` and `CodexLaunchPlan = { session_id: Option<String>, remote_ws_url: String, sidecar: CodexLaunchSidecar }`. Reuse `codex.rs::spawn_sidecar` mechanics to bring up `codex -c features.apps=false app-server --listen ws://127.0.0.1:<port>` (extract the spawn into a shared helper in `freshell-codex` rather than duplicating). Then start a Slice-2 proxy against that app-server; return the proxy's ws_url. Sidecar handle exposes `adopt(terminal_id, generation)`, teardown, and cleanup-on-plan-failure (mirror `launch-planner.ts:135-175,221-316`). Fresh vs resume: set `session_id` when `resume_session_id` is present; `requireCandidatePersistence=false` on resume (`launch-planner.ts:140`).

- **Tests:** decision-table unit tests (fresh → no `session_id`, capture-persist on; resume → `session_id` set, capture-persist off) driven by a fake runtime/proxy factory (mirror `CodexLaunchPlannerOptions.proxyFactory`, `launch-planner.ts:88-90`); plan-failure teardown test (planning error → sidecar shut down, error surfaced); shutdown-rejects-new-plans test (`launch-planner.ts:197-201`).

### Slice 4 — Wire BOTH create paths through shared code

> **LANDED (2026-07-22, FLAG-GATED default OFF — council fence).** Commits: `d5d6e423`
> (inc.1: lifecycle glue `crates/freshell-codex/src/launch_lifecycle.rs` — planner +
> sidecar state machine + `SpawnedCodexAppServerRuntime` + the terminal-keyed
> `CodexTerminalLaunchManager`; WS `terminal.create` branch; explicit
> `require_candidate_persistence` on the proxy options) and the inc.2 commit (REST
> `terminal_tabs.rs` branch with the `router.ts:177` resumeSessionId echo; `main.rs`
> shutdown-owner wiring; the e2e leg
> `crates/freshell-ws/tests/codex_managed_launch_e2e.rs`). Gate:
> `FRESHELL_CODEX_MANAGED_LAUNCH=1`; flag OFF is byte-identical to the shipped
> deviation shape, so **G-X0 is NOT retired yet** — it stays the live-path pin until
> S5 lands and the flag default flips (G-X0 → G-X1 swap happens at that flip, with the
> DEV-0006 record moving to `closed`). The shared seam is
> `CodexTerminalLaunchManager::global()` (one planner per server process, matching
> `server/index.ts:359`), consumed by both create paths + both exit hooks.
>
> **S5 follow-ups recorded from the S4 review:**
> 1. *Spawn-helper unification*: the canonical terminal-mode app-server spawn now lives
>    in `freshell-codex::launch_lifecycle::SpawnedCodexAppServerRuntime` (argv/env from
>    `codex_sidecar_spawn_spec`); `freshell-freshagent/src/codex.rs::spawn_sidecar`
>    (chat-pane topology) still carries its own copy of the spawn mechanics — point it
>    at the shared runtime when a slice owns that file.
> 2. *Singleton vs DI*: the manager is a process-global (`global()`) because `WsState`
>    (`freshell-ws/src/lib.rs`) was out of the S4 file grant; if DI is preferred,
>    thread it through `WsState`/`FreshAgentState` in S5.
> 3. *Binding reason*: `CodexLaunchPlan.binding_reason` is computed (S3) but the Rust
>    registry has no `sessionBindingReason` consumer yet — wire it with S5's
>    durability binding (review note 1's non-codex fallback applies at that call site).
> 4. *Recovery re-plan-on-loss* (`recovery.planCreate`, `deferLifecycleUntilPublished`)
>    stays deferred per §6's risk fence; the 5-vs-1 attempt asymmetry is already
>    structural (`plan_create_with_retry` takes the caller's budget).

A single `resolve_codex_launch(...) -> Option<CodexLaunchInto>` used by both `crates/freshell-ws/src/terminal.rs` (replace `codex_remote_ws_url = None` at `:835`) and `crates/freshell-freshagent/src/terminal_tabs.rs` (replace `codex_remote_ws_url: None` at `:604`). It runs `plan_create`, sets `codex_remote_ws_url: Some(plan.remote_ws_url)`, threads `session_binding_reason` (port `getCodexSessionBindingReason`), and returns the sidecar handle for post-create `adopt`/`publish`. Keep the model/sandbox/permissionMode strip (already at `terminal.rs:800`). REST retains its raw-resume rejection (`terminal_tabs.rs:124-129`); consider aligning the WS path's raw-resume acceptance (`terminal.rs:779-782`) to the legacy reject as a follow-up (flag, do not silently change).

- **Tests / goldens:** **retire `g_x0_codex_shipped_deviation_shape_dev_0006`** and promote **G-X1** (fresh live-path shape, `--remote <ws> -c features.apps=false` + notif + mcp) as the live golden; add a resume golden. Update DEV-0006 record to `status: closed` with the closing commit. *(Deferred with the flag flip: while the S4 gate defaults OFF, G-X0 remains the live-path shape and the record stays open — see the LANDED note above.)*

### Slice 5 (SEPARATE stage, gated) — durability binding + activity + `terminal.meta.updated` (DEV-0008)

Consume the proxy's captured candidates to mint a durable `sessionRef`, drive `codex-activity-tracker`-equivalent turn events, and emit `terminal.meta.updated`. **Do not ship Slices 1-4 with Slice 5 half-wired** (see §6). Land Slice 5 as its own tracked change that closes DEV-0008 alongside DEV-0006.

### e2e leg (one)

> **LANDED (inc.2):** `crates/freshell-ws/tests/codex_managed_launch_e2e.rs` —
> host-gated `#[ignore]`, run alone with `--ignored --test-threads=1`. Flag OFF
> control (today's argv, no `--remote`) + flag ON (the `--remote` 4-tuple first,
> bel pair next, live TUI→proxy→fake-app-server initialize round-trip).

A host-gated live integration test (`#[ignore]`, opt-in like `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS`): `terminal.create {mode:'codex'}` over the Rust WS server, capture the spawned child argv, assert the first four tokens are `--remote ws://127.0.0.1:<port> -c features.apps=false` and that the proxy accepts the TUI connection. This is the `original ≡ rust` differential the DEV-0006 live capture (`~/freshell-scratch-006/*-codex.json`) established.

---

## 6. Risks & NOT-to-build fences

**Risks:**

- **The proxy is a large, novel port** (`remote-proxy.ts` ~52 KB + two envelope files). Highest-risk slice; byte-limit / frame-boundary handling and fork-request rewriting are fiddly. Mitigate with the pure Slice-1 extractors fully fixture-tested before the socket plumbing.
- **Sidecar leaks.** Two owned children (app-server) per pane across create/resume/crash; the `/proc` ownership reaper (`reap_owned_codex_sidecars`) and exit-watcher already exist — reuse them, do not reinvent. Test the teardown-on-plan-failure path explicitly.
- **Session-repair / recovery** (`recovery.planCreate`, `deferLifecycleUntilPublished`) interacts with the frozen session-repair subsystem that is itself only partially ported; keep recovery minimal in Slices 1-4 and defer aggressive re-plan-on-loss.

**NOT to build (fences):**

- **NO display-id wiring.** `codexDisplayIdSecret` is a fresh-agent chat concern (§1.5); it has nothing to do with terminal `--remote`.
- **NO partial DEV-0008 shipment.** Council REJECTED create-upsert/exit-remove-only metadata (`DEVIATIONS.md:608`) as strictly worse than honest absence. Slice 5 lands whole or not at all.
- **NO resolver rework.** The argv resolver is done (G-X1/G-X2/G-W2 pass). Feed it a URL; don't touch it.
- **NO new codex app-server client.** Reuse `freshell-codex::CodexAppServerClient` + `spawn_sidecar` mechanics; the proxy is additive, not a replacement.
- **NO behavior change to non-codex modes** and no touching `server/ shared/ src/` (campaign additive-only purity rule).
- **NO scope creep into the WS raw-resume rejection** beyond flagging it; align it only as an explicit, separately-approved follow-up.

---

## 7. Key file:line index (anchor before editing — will drift)

Legacy (frozen `server/`):
- `coding-cli/codex-launch-config.ts:22-28` — `getCodexSessionBindingReason`
- `coding-cli/codex-managed-config.ts:1-4` — `['-c','features.apps=false']`
- `coding-cli/codex-app-server/restore-decision.ts:32-77` — restore-identity validator
- `coding-cli/codex-app-server/launch-planner.ts:125-175,221-316` — `planCreate` + sidecar lifecycle
- `coding-cli/codex-app-server/remote-proxy.ts` (~52 KB) — the proxy (unported)
- `coding-cli/codex-app-server/{json-rpc-envelope,json-rpc-side-effects}.ts` — scan/extract (unported)
- `ws-handler.ts:928-950,2438-2519` — `planCodexLaunch` + WS create wiring
- `agent-api/router.ts:160-195,737-749,1175,1335,1572-1584` — REST create wiring
- `terminal-registry.ts:295-307` — argv assembly (`--remote`)
- `index.ts:322-326,359-365` — display-id→chat adapter; launch planner ctor (no secret)

Port (`crates/`):
- `freshell-ws/src/terminal.rs:779-782,800,831-835` — WS gap + resume + strip
- `freshell-freshagent/src/terminal_tabs.rs:90-129,566-609` — REST gap + raw-resume reject
- `freshell-platform/src/cli_launch_goldens.rs:623-650` — G-X0 pin (to retire)
- `freshell-codex/src/lib.rs` — reusable client core surface
- `freshell-freshagent/src/codex.rs:79,1343-1449` — `spawn_sidecar` (reusable mechanics)
- `port/machine/specs/coding-cli.md:380-387` — §4e launch-planning scope note
- `port/oracle/DEVIATIONS.md:517-526` — the record to flip to `closed`
