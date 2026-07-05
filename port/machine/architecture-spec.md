# Target architecture — FROZEN ADR (Phase 2, systems-design)

**Status: FROZEN.** This ADR supersedes the Phase-1 draft. It is the committed
architecture that drives Phase-3 implementation. It may be amended only with a
recorded tradeoff and antagonist sign-off; it may **never** change the WS wire
contract (frozen at `WS_PROTOCOL_VERSION=7`, `port/contract/*.schema.json`).

**Synthesized from** the four Phase-1 ground-truth specs — `terminal-core.md`,
`coding-cli.md`, `platform-glue.md`, `electron-tauri.md` — under the guardrails in
`port/AGENTS.md` and the oracle in `port/oracle/{DESIGN,DEVIATIONS}.md`. Every
decision below cites the spec/`file:line` it rests on.

## Ground rules this ADR is bound by

1. **This is an "identical" port.** Behavior-equivalent to the original EXCEPT
   where the original is objectively defective and a `DEVIATIONS.md` entry
   (antagonist-adjudicated) says otherwise. **Any redesign beyond fixing a
   ledgered/objective defect is OUT OF SCOPE** and must be rejected as scope creep
   (`AGENTS.md:35-42`). Where a Phase-1 spec flags a `[DEFECT]`/`[BUG?]`, this ADR
   *lists it as a candidate deviation* and defers the fix to adjudication-when-touched;
   it does **not** pre-fix.
2. **Rust-first, single Cargo workspace.** JS/Node only as a spawned sidecar with a
   concrete no-Rust-equivalent justification (`AGENTS.md:45-53`). Exactly one such
   sidecar is authorized here (Decision 2).
3. **Frozen WS contract is the shared seam** for TS side, Rust side, and oracle
   (Decision 5). Changing the wire is out of scope.
4. **Structural limits (hard):** ≤10K LOC per crate, ≤1K lines per file
   (`AGENTS.md:77`). LOC budgets below use current TS non-test line counts as a
   planning proxy and flag every crate that lands "tight."
5. **No source mutation, no PR** during the port campaign; push branch periodically
   (`AGENTS.md:79-88`).

---

## Shape (unchanged from draft, now frozen)

```
freshell-tauri (Rust core)  ──spawns/embeds──►  freshell-server (single Rust binary)
   │  webview (WRY: WebKitGTK / WebView2 / WKWebView)
   └─ React/TS SPA (UNCHANGED) ──WS + HTTP──────┘   headless/daemon mode: same binary,
        window.freshellDesktop = { isElectron, openExternal }   phone/LAN-reachable (0.0.0.0 on WSL)
```

- One Cargo workspace. `freshell-server` is a standalone binary → the
  **headless/daemon/phone-reachable** mode is preserved exactly (`AGENTS.md:54-55`;
  `electron-tauri.md §1.4`).
- Frontend retained verbatim; the only rewrite is the `electron/preload.ts` bridge →
  a 2-property Tauri shim (`electron-tauri.md §7`).
- Windows integration is **partially live-verifiable** from this WSL2 host
  (`powershell.exe` 5.1 + `cmd.exe`); macOS is **spec/fixture-only**
  (`platform-glue.md §7`, `STATE.yaml` constraints).

---

# Decision 1 — Cargo workspace + crate decomposition

**Rationale for splitting beyond the draft's 7 boxes:** the harness domain alone is
~23K TS LOC (`coding-cli/` 14.3K + `fresh-agent/` 8.6K) — it *cannot* be one crate
under the ≤10K limit. The split follows the natural seams the specs already draw:
the three-layer model (`coding-cli.md §0`, layers A/B/C) and the per-provider adapter
architecture (`coding-cli.md §1`). Every crate below justifies its existence by a
distinct responsibility + a distinct oracle-tier obligation; none is a convenience
wrapper (Rule 1). Workspace root: `crates/` (already assumed by
`DEVIATIONS.md` pinning-test paths, e.g. `crates/freshell-server/tests/...`).

### 1.1 The workspace (12 Rust crates + 1 Node sidecar package)

| # | Crate | Responsibility (maps TS →) | Key deps | Spec | Oracle tier(s) | LOC budget (TS proxy) |
|---|-------|----------------------------|----------|------|----------------|-----------------------|
| 1 | **freshell-protocol** | Generated wire types + enums + `WS_PROTOCOL_VERSION=7`; (de)serialization only, **no logic**. From `shared/ws-protocol.ts` via `port/contract/*.schema.json`. | `serde`, `serde_json` | contract/README, all specs' "type" tables | **T0** | ~2–4K (generated) |
| 2 | **freshell-platform** | OS glue: dual WSL/Win/mac/Linux detection, WSL↔Windows path conversion, **shell `SpawnSpec` builder**, network bind/LAN/CORS-advisory, WSL port-forward, firewall, elevated-PS, **/proc PGID ownership-reaper** (relief valve, see OD-2). | `tokio::process`, `procfs`-style `/proc` reads | `platform-glue.md` (all) | **T1** (spawn goldens) + **T0** (network) + fixtures | ~3.3K + reaper |
| 3 | **freshell-terminal** | PTY core: `portable-pty` spawn, `TerminalRecord` lifecycle, `ChunkRingBuffer`, `ReplayRing`/`ReplayDeque` seq contract, broker (attach/replay/backpressure), output framing + batch + **barrier scanner**. `terminal-registry.ts` (minus platform glue) + `terminal-stream/**`. | `portable-pty` (wezterm), `bytes` | `terminal-core.md` (all) | **T1** (primary) + **T0** | ~7.8K **(largest — tight)** |
| 4 | **freshell-sessions** | Layer C: `session-indexer` (`notify` watchers + **DEV-0002 late-root liveness**) + read-only transcript parsers (claude JSONL, codex rollout, opencode.db). | `notify`, `rusqlite` | `coding-cli.md §2` | **T2** side-effects + **LT** (DEV-0002) | ~4K |
| 5 | **freshell-harness** | Provider-agnostic spine: `runtime-manager`, `provider-registry`, adapter trait, `sdk-events`, `turn-complete-clock`, model+effort normalization + capability registry, fresh-agent read-model router; **claude adapter + its sidecar client**; legacy `codingcli.*` (session-manager + activity-trackers → `terminal.turn.complete`). | `serde`; sidecar transport | `coding-cli.md §1b,§3,§5,§6c` | **T2** (claude) + **T0** | ~8K **(tight)** |
| 6 | **freshell-codex** | Codex provider: fresh-agent adapter + `codex app-server` JSON-RPC-over-WS runtime, protocol, durability store, launch-planner/retry/recovery, remote-proxy. | `tokio-tungstenite` (client), `serde` | `coding-cli.md §1c,§4,§5` | **T2** (codex) + **T0** + **LT** | ~9.2K **(tightest — see OD-2 split)** |
| 7 | **freshell-opencode** | OpenCode provider: adapter + `opencode serve` HTTP client + SSE stream bind, materialization (`freshopencode-*`→`ses_*`), cwd-recovery, **DEV-0001 bounded health**. | `reqwest`, `eventsource`/SSE | `coding-cli.md §1a,§3` | **T2** (opencode) + **LT** (DEV-0001) | ~3.3K |
| 8 | **freshell-ws** | WS transport + dispatch (port of `ws-handler.ts`): tokio-tungstenite upgrade, per-conn state, `hello`/capabilities negotiation, routing to terminal/harness/api, origin-**advisory** logging, backpressure bridge (`bufferedAmount`). | `tokio-tungstenite`, `axum` (upgrade) | all specs' `ws-handler` cites | **T0** | ~3–4K |
| 9 | **freshell-api** | REST surface: `axum` routers mirroring `server/*-router.ts` + `agent-api/**` (terminals, sessions, settings, files, network, fresh-agent REST, health, proxy) + **auth token gate**; mounts the `/api/ai` stub. | `axum`, `tower` | `coding-cli.md §6b`, `platform-glue.md §3.4` | **T0** + **T1** (HTTP) + **T3** | ~6K |
| 10 | **freshell-llm** | Model-facing auxiliary surface: the **MCP `freshell` tool server** (`rmcp`) the claude harness injects (routes actions back to `freshell-api` over HTTP); the **AI-assist title** route (`/api/ai`, Gemini) — **Gemini OUT of scope → implemented as the original's not-configured/disabled path** for contract-shape parity. | `rmcp`, `reqwest` | `coding-cli.md §6a`, `server/ai-router.ts`/`ai-title.ts` | **T0** + **LT** | ~1.6K (MCP) + stub |
| 11 | **freshell-server** *(bin)* | The standalone headless/daemon binary. Wires one `axum` app (HTTP + WS upgrade), boots all domain crates, `tokio` runtime, network bind + startup banner + config, spawned-child ownership. **This is the system-under-test.** | `tokio`, `axum`, all crates | `electron-tauri.md §1.4,§5`; `platform-glue.md §3` | **T0–T3** (SUT) | ~1–2K glue |
| 12 | **freshell-tauri** *(bin, the app)* | Tauri v2 core: spawns/embeds `freshell-server`; **window state-machine** (replaces re-entrant `main()`); tray, global-shortcut, updater, single-instance, window-state, close-to-tray, renderer-recovery (best-effort); wizard + chooser windows; preload shim; daemon managers. | `tauri` v2 + `tauri-plugin-{shell,global-shortcut,updater,single-instance,window-state,opener,autostart}` | `electron-tauri.md` (all) | **T3** + fixtures | ~4K + plugins |
| — | **freshell-claude-sidecar** *(Node pkg, NOT a crate)* | The one authorized JS: thin Node process wrapping `@anthropic-ai/claude-agent-sdk` (`SdkBridge`), speaking newline-JSON/loopback-WS to `freshell-harness`. | `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk` (reuse) | `coding-cli.md §8b` | **T2** (claude/Haiku) + **LT** | thin wrapper over `sdk-bridge.ts` (841) |

### 1.2 Structural discipline for the tight crates (≤1K lines/file)

- **freshell-terminal (~7.8K):** split into modules `pty` (spawn/lifecycle),
  `chunk_ring`, `replay_deque`, `replay_ring`, `broker` (attach/replay/flush),
  `output_fragments`, `output_batch`, `barrier_scanner`, `client_queue`,
  `stream_identity`. Each ≤1K; `broker.ts` (2285) alone splits into ≥3 files.
- **freshell-codex (~9.2K):** modules `adapter`, `client`, `protocol`,
  `json_rpc` (envelope + side-effects), `durability`, `launch` (planner/retry/
  recovery/restore), `remote_proxy`. **If Rust overruns 10K** (likely — protocol
  structs are verbose), execute OD-2: extract `remote_proxy` (1551 TS) into a
  `freshell-codex-proxy` crate and the /proc reaper into `freshell-platform`.
- **freshell-harness (~8K):** modules `runtime_manager`, `registry`, `adapter`
  (trait), `events`, `models` (normalization + capability registry), `claude`
  (adapter + sidecar client), `codingcli` (legacy layer A + activity trackers).

### 1.3 Where the draft's boxes went (traceability)

- Draft `freshell-llm = "AI SDK / Anthropic / MCP layer"` was three unrelated things.
  **Resolved:** Anthropic/Claude → `freshell-harness` (+ sidecar); MCP → `freshell-llm`
  (rmcp); the "AI SDK" is **Gemini** (`@ai-sdk/google` in `ai-router.ts`/`ai-title.ts`)
  which is **OUT of scope** (user directive) → disabled stub. The draft's aspirational
  `unified-llm` Rust dep is **not needed** (no multi-provider text layer survives).
  The AI-*settings* shape is still reported (as disabled) so the SPA's settings/context-
  menu surface is byte-shape-preserved; only Gemini *generation* is not ported.
- Draft `freshell-harness` (one box) → split into `freshell-harness` +
  `freshell-codex` + `freshell-opencode` + `freshell-sessions` on the LOC limit and
  the layer-A/B/C + per-provider seams.

---

# Decision 2 — Sidecar verdict (DECISIVE)

**VERDICT: exactly ONE Node sidecar — for the Claude runtime. Everything else is
pure Rust.** This is the single place JS is authorized, and the AGENTS.md bar is met.

### 2.1 Claude runtime → **Node sidecar (ADOPT)**

- **Missing-crate justification (the AGENTS.md:48-53 bar):** `@anthropic-ai/claude-agent-sdk`
  (^0.2.40) has **no Rust equivalent or near-equivalent** — it is a JS-only vendor SDK
  (`coding-cli.md §8a`, verified against `package.json`). It encapsulates a large,
  behavior-sensitive surface the **T2 grader is directly sensitive to**: subprocess
  `stream-json` framing; the `result.subtype==='success'` completion chime
  (`sdk-bridge.ts:469`); partial-message streaming; `canUseTool`/`AskUserQuestion`
  permission+question flows and their `0→≥1` waiting edge (`sdk-bridge.ts:515-518`);
  `/compact`; plugin loading; `settingSources`; clean-env
  (`createClaudeSdkCleanEnv`, `sdk-bridge.ts:64-66`); and the placeholder-nanoid ↔
  `cliSessionId`-durable split (`coding-cli.md §1b`). Reimplementing this against the
  raw `claude` CLI is the **#1 T2 divergence risk** (`coding-cli.md §8c.1`). Adopting
  the SDK behind a process boundary is a *massive net savings* and the bar is met.
- **Process boundary + oracle plan:** a thin Node process wraps the existing
  `SdkBridge`, exposing a small newline-JSON (or loopback-WS) request/response +
  event stream to `freshell-harness`. It is **spawned, isolated, killable, and
  ownership-tracked exactly like the codex sidecar** (via the `freshell-platform`
  /proc PGID reaper) so the oracle's "no orphans" safety holds. It is graded by
  **T2 claude/Haiku** (already GREEN in Phase 0, baseline
  `port/oracle/baselines/t2/claude-haiku.json`) + **T0** (its `freshAgent.*` output
  must conform to the frozen contract) + **LT** (DEV-0002 liveness; the waiting edge).
- **New failure mode it introduces (must be handled):** the sidecar process can
  crash/exit independently — the original in-process SDK could not. The harness must
  surface a sidecar death as `sdk.status exited` **without** a false completion chime
  (mirroring codex `onExit`, `coding-cli.md §3`), and restart/rebind per the runtime-
  manager recovery discipline. This is a **top-3 risk** (Risk 2).
- **Escape hatch (allowed, not default):** replace the sidecar with a pure-Rust
  `claude` CLI (`--output-format stream-json --verbose`) reimplementation **only** if
  a red/green spike proves byte/edge parity pinned to `claude-haiku.json`
  (`coding-cli.md §8b`). Until then, **the sidecar is the frozen choice.**

### 2.2 Everything else → **pure Rust (confirmed)**

- **Codex runtime: pure Rust.** Spawned `codex … app-server --listen ws://…` binary
  driven over JSON-RPC-2.0-shaped WS (`coding-cli.md §4a`) → `tokio-tungstenite` +
  `serde`. No SDK. Behavior lives in freshell's own adapter, which ports directly.
- **OpenCode runtime: pure Rust.** Spawned `opencode serve` binary over HTTP + SSE
  (`coding-cli.md §1a,§3`) → `reqwest` + an SSE client. No SDK.
- **MCP `@modelcontextprotocol/sdk`: NOT a sidecar.** A Rust MCP SDK (`rmcp`) exists,
  so the "no equivalent" bar is **not** met (`coding-cli.md §8b`). Reimplement the
  `freshell` tool server in Rust with `rmcp` (`freshell-llm`). **Accepted interim:**
  if the Claude sidecar is running, the existing Node MCP server may be *reused as-is*
  behind that sidecar boundary (it is already `node`-spawned by the SDK,
  `sdk-bridge.ts:72`) — that is retained tooling, **not** a new sidecar. Target =
  rmcp reimplementation.
- **node-pty → `portable-pty`; `node:sqlite` → `rusqlite`; chokidar → `notify`;
  nanoid → a nanoid crate; ws/express → tokio-tungstenite/axum.** All have Rust
  equivalents (`coding-cli.md §8a`; `AGENTS.md:45-46`).
- **Gemini (`@ai-sdk/google`): NOT ported (user directive).** `/api/ai` returns the
  original's not-configured/disabled response for contract-shape parity. No Rust
  Gemini client, no sidecar.

---

# Decision 3 — Process / threading model

**Runtime:** `tokio` multi-threaded. `freshell-server` hosts **one `axum` app** that
serves HTTP REST (`freshell-api`) and the WS upgrade (`freshell-ws`) on the resolved
bind host/port. All long-lived work is structured as tokio tasks + a few blocking
threads where the underlying I/O is blocking.

### 3.1 Tauri core ↔ server (preserve all three modes)

`freshell-tauri` obtains the server per `DesktopConfig.serverMode`
(`electron-tauri.md §1.1`):

- **`app-bound`** → spawn `freshell-server` as a **child owned by the Tauri core**
  (`tauri-plugin-shell` sidecar **or** `tokio::process`), health-poll `/api/health`
  (exponential backoff 100 ms→5 s cap, 30 s overall), stop via **SIGTERM→SIGKILL(5 s)**
  — 1:1 with `server-spawner.ts:46-189`. No `NODE_PATH`, no bundled Node, no native-
  modules dir (`electron-tauri.md §1.4,§5`).
- **`daemon`** → an OS service launches the *same* binary (systemd-user / launchd /
  Scheduled Task), `freshell-tauri` only `status()`/`start()`s it (`electron-tauri.md
  §3.9`). *(daemon-install gap = candidate deviation CD-5.)*
- **`remote`** → connect to `remoteUrl` + `remoteToken`; no local spawn.
- **headless** → `freshell-server` runs standalone with no Tauri (phone/LAN-reachable,
  `0.0.0.0` on WSL per `platform-glue.md §3.1`).

### 3.2 Task structure inside `freshell-server`

- **Per-WS-connection:** a read task + a write half fed by a **bounded mpsc**; the
  bounded channel + the broker's thresholds reproduce `bufferedAmount` backpressure
  (background pause @512 KiB, catastrophic close @16 MiB/10 s, queue overflow @32 MiB
  → gap; `terminal-core.md §4.3`). `bufferedAmount` is a transport property, so it
  lives here, not in `freshell-terminal` (`terminal-core.md §9.1`).
- **Per-terminal actor:** `portable-pty` read is **blocking** → runs on a dedicated
  blocking thread that forwards `Vec<u8>` over a channel to the terminal's broker
  **actor task**. The actor is the *single writer* of that terminal's `ReplayDeque`,
  which **guarantees** per-terminal seq monotonicity + per-terminal attach
  serialization (the `withTerminalLock` chain, `terminal-core.md §7.1-7.2`) **without
  locks** — the idiomatic Rust mapping of the JS single-threaded ordering guarantee.
  Multi-client fan-out = each client registers an mpsc with the actor; every client
  sees the same seq stream; per-client drops surface as per-client `terminal.output.gap`,
  never reorder (`terminal-core.md §7.3`).
- **Per-harness-session tasks:** codex WS-client task; opencode SSE task; claude
  sidecar stdio task. Each owns its provider connection and normalizes `sdk.* →
  freshAgent.*` (`coding-cli.md §1d`).
- **Session-indexer:** a `notify` watcher task + debounced rescan (`coding-cli.md §2d`).
- **Spawned children** (codex app-server, opencode serve, claude sidecar) are tracked
  by the **/proc PGID ownership-reaper** in `freshell-platform` so no orphans survive
  (`coding-cli.md §4d`; matches oracle safety `AGENTS.md:79-85`). Naive `pkill` is a
  divergence + safety risk and is forbidden.

---

# Decision 4 — Per-OS strategy (`freshell-platform`)

**Pure Rust, CLI-parity:** every external call is a plain subprocess the reference
already uses (`netsh.exe`, `ipconfig.exe`, `wsl.exe`, `reg.exe`, `powershell.exe`,
`ufw`, `firewall-cmd`, `ip`, `hostname`, `defaults`) via `std::process`/`tokio::process`
with arg-vectors + timeouts. **No `windows-rs` needed**; prefer CLI parity to keep the
oracle diff aligned (`platform-glue.md §8`). `is-wsl` = a 3-line `/proc/version` read,
inline (no dep).

### 4.1 The dual WSL-detection regimes — **PRESERVE BOTH (do not self-unify)**

Compute one `Platform` enum once (`Linux | Macos | Windows | Wsl1 | Wsl2`) but expose
**both** predicates, because they legitimately drive different subsystems and can
disagree (`platform-glue.md §0`):

- **Regime A (env-var:** `WSL_DISTRO_NAME|WSL_INTEROP|WSLENV`, `terminal-registry.ts:870`)
  → drives **terminal shell-spawn routing** (a `cmd`/`powershell` request goes to
  Windows interop **only when env-var WSL is detected**).
- **Regime B (`/proc/version` `microsoft|wsl`,** `platform.ts:12-32`) → drives
  **network bind (0.0.0.0), firewall, WSL port-forward**.

> **CANDIDATE DEVIATION CD-1 — do NOT self-approve.** A scrubbed-env WSL2 process
> (systemd unit, `env -i`) has Regime A = false but Regime B = true. Naively unifying
> the two into one predicate **changes behavior** in that case (`platform-glue.md
> §0.2 [BUG?]`). **The port preserves both by default.** If unification is desired it
> is a `DELIBERATE_FIX` requiring an antagonist-adjudicated ledger entry. This ADR
> does **not** decide to unify.

### 4.2 Live-verifiable vs fixture-only (do the live ones)

- **LIVE ✓ on this WSL2 host** (`platform-glue.md §7`): env+`/proc` detection;
  `wslpath` conversion (§1.3/1.4) golden vs `wslpath -w/-u`; `COMPUTERNAME` via
  `powershell.exe`; WSL IP (`ip -4 addr show eth0`); Windows LAN IPs (`ipconfig.exe`);
  firewall/portproxy **READ** (`netsh … show`); `reg.exe … Lxss` probe; cmd/pwsh exe
  presence; **all pure script/arg/quoting goldens**; systemd-user daemon (likely);
  Windows Task Scheduler via interop (partial); bind-host + port + LAN-ranking logic.
- **FIXTURE / MANUAL only:** native-Windows `wsl.exe wslpath -w` fallback (§1.5 — we
  ARE the WSL side); macOS firewall/zsh/launchd (§5.1, §2.5); **actual elevated
  `netsh add/delete` MUTATE + UAC `Start-Process -Verb RunAs`** (§4.4/§6 — DO NOT run
  on the live `DANDESKTOP` host; goldens + a disposable-Windows manual run only);
  auto-update install.

### 4.3 Two behaviors that MUST be preserved verbatim (not "cleaned up")

- **Port the LIVE copies from `terminal-registry.ts`, delete the dead
  `platform-utils.ts`.** The dead duplicate's `getWindowsDefaultCwd` differs
  materially; porting it is a T1-invisible Windows cwd defect (`platform-glue.md
  §2.0/§2.4`). Removing the dead file is candidate deviation **CD-2** (non-behavioral).
- **Origin handling is advisory-only** — Origin is logged, never rejected; the **auth
  token is the security gate** (`platform-glue.md §3.4`). Do **not** harden into a
  rejecting CORS layer (breaks VPN/mobile, diverges). Hardening = `DELIBERATE_FIX` +
  antagonist (candidate CD-8).

---

# Decision 5 — The frozen WS contract seam

`freshell-protocol` is **generated** from the immutable contract in `port/contract/`
(`contract/README.md`):

- **`ws-protocol.schema.json`** = the inbound (client→server) **Zod runtime authority**
  → generate serde structs the server validates against.
- **`ws-server-messages.schema.json`** = the outbound (server→client, all 52) **shape
  contract** → generate serde structs the server emits.
- **`ws-message-inventory.json`** = the T0 conformance surface (every `type`
  discriminant) → the checklist every implementation must speak.
- `WS_PROTOCOL_VERSION = 7` is a compile-time const, **asserted equal by T0**.

**Rules baked in from Phase-0 findings (`STATE.yaml`):**

- **Inbound authority is Zod, shape contract is JSON Schema.** zod4 emits
  `additionalProperties:false` but the runtime **strips** (accept-and-strip) → treat
  Zod parse as inbound authority, JSON Schema as outbound shape; the Rust
  deserializer mirrors accept-and-strip (`serde` `deny_unknown_fields` is **wrong**
  here for inbound).
- **Opaque blobs → `serde_json::Value`, excluded from byte-diff:** `Usage.passthrough`,
  `Record<string,unknown>` layouts / `tool_use.input` / `decision` / `fork.input`,
  `tool_result.content`, and `codingcli`/`freshAgent` `event` payloads (`STATE.yaml`;
  `terminal-core.md §8`; `coding-cli.md §7`).
- **Enum member order is non-contractual** — only the value *set* matters
  (`contract/README.md`). The generator must be deterministic (sorted keys, 2-space,
  trailing newline).
- **Drift guard:** a Rust-side test mirrors `test/unit/port/ws-contract-freeze.test.ts`
  — regenerate types in-memory, assert byte-identical to committed, assert
  `WS_PROTOCOL_VERSION==7`. No silent wire drift.
- **Codegen tool = OD-3** (typify vs a custom JSON-Schema→serde generator); pick in
  the protocol step; must be deterministic + drift-guarded.

**Changing the wire is out of scope.** The bug-fix directive applies to *behavior*,
never the frozen wire (`contract/README.md`, "Out of scope").

---

# Decision 6 — Electron → Tauri shell

### 6.1 Frontend seam (keep the SPA byte-for-byte)

The retained SPA touches `window.freshellDesktop` in exactly **two** places
(`electron-tauri.md §7`). The Tauri shell exposes only:

```js
window.freshellDesktop = { isElectron: true, openExternal: (url) => invoke('open_external_url', { url }) }
```

The webview loads the **same `?token=` URL form** so the SPA's existing auth path is
unchanged (`electron-tauri.md §1.3,§7`; token-in-url is candidate CD-6).

### 6.2 Re-entrant `main()` → explicit window state-machine

Electron drives the flow by **re-invoking `main()`** after the wizard/chooser close,
held together by `wizardPhase` guards (`electron-tauri.md §0,§9-Risk-3`). Tauri has no
re-entrant main. Redesign as an **explicit state machine over long-lived windows**:
`Boot → (Wizard | Chooser | Main)`, transitions on window-close / launch-choice.
**Per-window capabilities** replace webContents-id gating: `open_external_url` only for
the main window at the expected origin; `choose-launch-option`/`get-launch-options`
only for the chooser; `complete-setup` only for the wizard (`electron-tauri.md §2,§6`).
Getting transition timing / trust boundaries wrong risks deadlock or privilege
escalation → treat as a first-class design task, not a mechanical port.

### 6.3 Renderer-crash-recovery — **best-effort, explicitly a capability gap**

WRY exposes **none** of `render-process-gone`, `did-fail-load` (w/ codes),
`unresponsive`/`responsive`, `forcefullyCrashRenderer()`, nor cheap live
BrowserWindow replacement (`electron-tauri.md §3.7,§9-Risk-1`). Plan: a
**server-reachability watchdog + navigation-timeout + `window.reload`/recreate**
approximation, with **explicitly scoped per-OS coverage**, oracle'd as **fixture-only**.
Full parity may be impossible on some platforms; this is an **accepted platform
limitation, not a defect to fix** (do not ledger; document the scoped coverage).

### 6.4 Updater re-keying — a rebuild, not a swap

`electron-updater` (`latest.yml`, blockmap **deltas**, NSIS one-click, code-sign
trust) → `tauri-plugin-updater` (signed `latest.json` + per-artifact `.sig`,
**mandatory Ed25519**, **full-bundle**, no deltas) (`electron-tauri.md §3.3,§9-Risk-2`).
The whole release/signing/feed pipeline + the `check/download/install` event surface
is re-created and **re-keyed**. Fixture-tested here (`latest.json`+`.sig` static
server); real per-OS install = Phase-4 manual/cross-build.

### 6.5 Candidate deviations surfaced by the shell (list; adjudicate when touched)

From `electron-tauri.md §10` + cross-spec — **do NOT pre-fix**:

- **CD-4 tray-status-stale** — `Server: Running/Stopped` built once, never refreshes
  (`tray.ts:59`).
- **CD-5 daemon-mode dead-end** — `install()`/`uninstall()` never called anywhere;
  `daemon` mode throws "not installed" with no install path (`electron-tauri.md §3.9`).
  The port likely must wire install to make daemon mode *work at all* → antagonist
  decides whether "make it work" is a required `DELIBERATE_FIX` or in-scope repair.
- **CD-6 token-in-url** — auth token in the loaded URL query (`startup.ts:155`);
  preserve for SPA compat, flag for security review.
- **CD-7 updater-noop-silent** — missing updater silently disables updates
  (`entry.ts:307-315`).

---

# Decision 7 — Port order for Phase 3 (dependency-ordered, each gated by its tier)

Refines the draft order; each step is **gated** — do not advance until the named
oracle tier is green against the port.

1. **freshell-protocol** — generate types from frozen schema. **Gate:** compiles +
   Rust drift-guard passes, `WS_PROTOCOL_VERSION==7`. *(Unblocks everything.)*
2. **freshell-platform** — detection, `SpawnSpec`, path conv, network bind, script
   goldens, /proc reaper. **Gate:** platform unit + golden-string tests + this-host
   Windows live-verify (`platform-glue.md` P1-P29). *(Terminal + server need SpawnSpec
   + bind before they can boot.)*
3. **freshell-terminal** — PTY core + broker/seq/framing. **Gate:** **T1 PTY byte
   goldens (HARD)** + T0 `terminal.*` + the terminal slice of T3.
4. **freshell-ws + freshell-api** — bring the wire + REST up. **Gate:** **T0 protocol
   conformance GREEN vs the port** (handshake, every message shape) + T1 HTTP
   responses. *(The port now boots and speaks the frozen wire.)*
5. **freshell-sessions** — indexer + parsers. **Gate:** T2 `transcript.persisted`/
   `transcript.parseable` side-effects + **LT DEV-0002 liveness** (differ-blind).
6. **freshell-harness spine + freshell-opencode + freshell-codex** — the **pure-Rust**
   providers first. **Gate:** **T2 live-invariant matrix** (opencode/Kimi, codex/GPT-mini)
   + **LT DEV-0001** (opencode bounded health) + T0. DEV-0003 = forward codex
   `none`/`minimal` **verbatim, no clamp** (differ grants **no tolerance**).
7. **freshell-claude (+ Node claude-sidecar) + freshell-llm (MCP)** — the sidecar
   boundary last in the harness. **Gate:** **T2 claude/Haiku** + LT (waiting-edge; MCP
   tool routes back to REST).
8. **freshell-server bin** integration. **Gate:** full **T0–T2** against the external-
   process capture harness (the SUT wiring; `oracle/DESIGN.md §"external-process"`).
9. **freshell-tauri shell**. **Gate:** **T3 e2e/visual** (retained SPA against the
   port's server via `FRESHELL_E2E_TARGET_URL`) + desktop fixtures. *(Last — the SPA
   is backend-agnostic once T0-T2 hold.)*

---

# Decision 8 — Open decisions, risks, and the candidate-deviation register

### 8.1 Candidate deviations to route through the antagonist (list; adjudicate when touched; do NOT pre-fix)

| Id | Source | What | Disposition |
|----|--------|------|-------------|
| **CD-1** | `platform-glue.md §0.2` | Unify the two WSL-detection regimes | `DELIBERATE_FIX` **only if** unified; default = preserve both |
| **CD-2** | `platform-glue.md §2.0/§2.4` | Delete dead `platform-utils.ts` duplicate | Non-behavioral cleanup; ledger note |
| **CD-3** | `terminal-core.md §6.2` | `terminal.status` is defined-but-**unemitted** in the reference | Latent contract/impl mismatch; port need not emit; keep schema-valid if it does |
| **CD-4** | `electron-tauri.md §3.1/§10` | Tray status line never refreshes | Fix on status-change (when touched) |
| **CD-5** | `electron-tauri.md §3.9/§10` | `daemon` mode dead-end (`install()` never wired) | Antagonist: required-`DELIBERATE_FIX` vs in-scope repair |
| **CD-6** | `electron-tauri.md §10` | Auth token in URL query | Preserve for compat; security-review flag |
| **CD-7** | `electron-tauri.md §10` | Updater silently no-ops when missing | Surface disabled state (when touched) |
| **CD-8** | `platform-glue.md §3.4` | Origin advisory→rejecting CORS "hardening" | Forbidden unless ledgered `DELIBERATE_FIX` |

**Already-ledgered — carry as-is (not re-adjudicated here):** **DEV-0001** (opencode
`waitForHealth` bounded per-probe: 2 s AbortController + 150 ms retry, outer deadline
unchanged; **port-side fix + pinning test**; original stays pristine). **DEV-0002**
(session-indexer late-root watcher: **log + degrade + rescan, process stays alive**;
carried **solely** by the mandatory port liveness test — the T2 differ is blind).
**DEV-0003** (codex effort — **REJECTED**: forward `none`/`minimal` verbatim, no clamp;
differ grants **no tolerance**).

### 8.2 Open decisions to resolve before/during Phase 3

- **OD-1 — Legacy `codingcli.*` (layer A):** in the frozen v7 contract but no T2
  baseline drives it (`coding-cli.md §6c`). **Default: carry it** for T0 contract
  completeness; verify via T0. Confirm at the harness step.
- **OD-2 — freshell-codex LOC (~9.2K, tightest):** if the Rust exceeds 10K, extract
  `remote-proxy` (1551 TS) → `freshell-codex-proxy` and the /proc PGID reaper →
  `freshell-platform`. Pre-planned relief valve; decide at the codex step.
- **OD-3 — WS-type codegen tool:** `typify` vs a custom JSON-Schema→serde generator;
  must be deterministic + drift-guarded (Decision 5).
- **OD-4 — Claude sidecar transport + MCP reuse:** newline-JSON stdio vs loopback-WS;
  rmcp reimpl vs retain Node MCP behind the sidecar. Both oracle-covered; decide at
  the claude step.
- **OD-5 — portable-pty read-chunk determinism** (`terminal-core.md §9.1`, top risk):
  raw OS PTY read boundaries are timing-dependent. Either keep **T1 fixtures < one
  batch** so chunk boundaries can't affect the merged frame set, **or** the port
  **buffers-and-refragments deterministically** via the same
  `fragmentTerminalOutputForPayloadBudget` code-point split. Decide the refragmentation
  strategy at the terminal step.
- **OD-6 — renderer-crash-recovery coverage:** best-effort; the covered-triggers set
  per OS is decided at the Tauri step (accepted capability gap, not a defect).

---

# Top 3 architectural risks

**Risk 1 — Terminal seq/byte/framing fidelity (highest surface area).**
Bytes are **UTF-8** (`frame.bytes = byteLength(utf8)`, `replay-deque.ts:68`) while
offsets are **UTF-16 code units** (`endOffset = data.length`, `output-batch.ts:194`);
the **barrier scanner is byte-exact and stateful across frames** and decides batch
boundaries, so `segments[]`/`endOffset`/`rawFrameCount`/the `serializedBytes` fixpoint
all hang off it (`terminal-core.md §9.3`). A Rust port using byte offsets everywhere
gets `endOffset`/`serializedBytes` wrong and silently diverges under T1.
**Mitigation:** port `output-barrier-scanner` + `output-batch` 1:1; keep UTF-16
code-unit offsets *explicitly typed apart* from UTF-8 byte counts; unit-diff against
fixtures; apply OD-5 to dodge PTY-read-boundary nondeterminism.

**Risk 2 — Claude SDK behavioral edges across the new sidecar boundary.**
No Rust equivalent forces the Node sidecar (Decision 2), and it must faithfully surface
the placeholder-nanoid↔`cliSessionId` split, the `subtype==='success'` chime, the
`0→≥1` waiting edge, MCP injection, and clean-env — **plus** it adds a failure mode the
original lacked: the sidecar process can die mid-turn and must degrade to
`sdk.status exited` **without a false completion** and restart cleanly.
**Mitigation:** pin to the `claude-haiku.json` T2 baseline; ownership-track +
liveness-test the sidecar (DEV-0002); keep the pure-Rust-CLI escape hatch behind a
parity spike.

**Risk 3 — The parts the oracle cannot fully see on this host (the completeness
ceiling).** Elevated/mutating Windows paths (`netsh add/delete` + UAC), macOS
packaging/firewall, renderer-crash-recovery (no WRY hooks), and the updater re-key are
**not fully CI-verifiable here** (`platform-glue.md §7`, `electron-tauri.md §8`). Since
"if the oracle cannot detect a divergence, that divergence is invisible to the whole
campaign" (`AGENTS.md:12-14`), a Windows/mac-only regression could ship silently.
**Mitigation:** maximize live WSL-interop verification (Decision 4.2); **golden-string
every generated script/arg** (diff exact strings, never re-run elevation); label mac +
native-Windows-mutate + updater-install as **fixture/manual Phase-4 QA**; never claim
mac parity from a live run.

---

## Cross-reference index

- Crate ↔ spec ↔ tier: Decision 1.1 table.
- Frozen wire: `port/contract/{ws-protocol.schema.json, ws-server-messages.schema.json,
  ws-message-inventory.json, nondeterministic-fields.md}`, `contract/README.md`.
- Oracle tiers T0–T3 + adjudication: `port/oracle/DESIGN.md`.
- Deviations DEV-0001/0002/0003 (carried) + CD-1..CD-8 (candidate): `port/oracle/DEVIATIONS.md` + Decision 8.1.
- Guardrails: `port/AGENTS.md`. Phase state: `port/machine/STATE.yaml`.

**Frozen at HEAD `f29ccea5` (Phase 1 complete). Source unmodified; no commit made by
this Phase-2 pass.**
