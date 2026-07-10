# HANDOFF — freshell Rust + Tauri Port

**Audience:** the next agent taking over this project.
**Read this whole file before doing anything.** Then read `port/GOAL.md` (the success
criteria you are being held to), `port/machine/STATE.yaml`, `port/oracle/EQUIVALENCE-REPORT.md`,
and `port/oracle/DEVIATIONS.md`.

Last updated: 2026-07-08. Handoff written at branch `feat/rust-tauri-port` @ `1c2c9c7d`.

> ## ADDENDUM 2026-07-10 — the VM detour (read before using §8's recipes)
>
> Between this handoff and now, a session ran on the **TauriDebugVM** with no command
> execution and left four artifacts, since reconciled (adversarially reviewed, hardened,
> committed):
>
> - `port/machine/BLOCKER-2026-07-08-vm-session.md` — why the VM sandbox couldn't
>   execute anything. **RESOLVED-BY-RELOCATION** (addendum in the file): on 2026-07-10
>   the user brought the session back to DANDESKTOP WSL2. The interim "operate ONLY on
>   the TauriDebugVM" directive is **rescinded** — this handoff's DANDESKTOP recipes
>   (§8) are live again.
> - `port/vm-bridge/` — file-drop execution bridge, **DORMANT, do not start** (its
>   README carries the security hardening: gitignored inboxes, startup quarantine,
>   temp-then-rename protocol).
> - `port/machine/PLAN-2026-07-09-vm-windows-on-windows.md` — **SUPERSEDED** (banner in
>   place); keep for salvage: legacy Electron installer location (its D9), VM inventory.
> - `port/machine/specs/cli-argv-fidelity.md` — the spec for queue item §9.4, now
>   **rev 2**: corrected per adversarial review (live fresh-claude `--session-id`
>   preallocation; native-Windows-host MCP path forms; U5/cmd.exe reclassified as a
>   blocker for the default native-Windows CLI path; gemini/kimi
>   `generateMcpInjection` branches added). Use it when implementing argv fidelity.
>
> `port/machine/STATE.yaml` (`constraints.vm_only`, `blockers[0]`) records the
> supersession authoritatively.

---

## 1. Mission (what the user asked for)

Port freshell — a terminal-multiplexer web app with embedded coding-CLI agents — from
Node/TypeScript + Electron to **Rust + Tauri**, while **retaining everything else exactly
the same**:

- **Server** (`server/`, ~60k lines TS on Node) → Rust crates. **DONE, equivalence-proven.**
- **Desktop shell** (`electron/`) → Tauri v2 (`crates/freshell-tauri`). **Built; client-matrix validation in progress.**
- **Frontend** (`src/`, React SPA) → **RETAINED BYTE-IDENTICAL. Never modify it.**
- **JS allowed only where there is no Rust equivalent** and it's a massive saving. The ONE
  sanctioned exception: `crates/freshell-claude-sidecar/` (Node, wraps
  `@anthropic-ai/claude-agent-sdk`). Justified in the ADR.

### Standing user directives (verbatim intent — these bind you)

1. **One-shot, autonomous.** No human in the loop. Plan → execute → QA to full equivalence.
   **Do not stop at milestones.** Every turn ends with an action in flight, true completion,
   or a proven hard blocker. (The user has called out mid-run stops three times. Don't.)
2. **QA must be comprehensive and impeccable**: live APIs, real tasks, **cheapest models**
   on each harness (opencode→`umans-ai-coding-plan/umans-kimi-k2.7`, codex→`gpt-5.3-codex-spark`
   effort `low`, claude→Haiku). Keep live calls to single digits per run.
3. **Fix bugs as you find them; do NOT replicate bug-for-bug.** Any original-vs-port behavior
   difference must be either fixed (with regression test) or adjudicated in the deviations
   ledger by an adversarial reviewer. **Never self-approve a deviation. Never weaken an oracle
   assertion** (a case-fold "fix" was explicitly rejected — see DEVIATIONS.md ENV-0001).
4. **Gemini is out of porting scope** (its CLI still launches as a terminal pane — that's fine
   and was validated — but no gemini provider port / live QA).
5. **Never touch the user's live server or personal state.** Port **:3001 is reserved for the
   user** (something is listening on `0.0.0.0:3001` — do not kill it, do not bind it for tests).
   Use scratch ports (3030-3060 range was used) + isolated `HOME`s. Never mutate the live
   Windows firewall/portproxy (netsh add/delete, elevated UAC) — **STATUS reads only**;
   mutating commands exist only as golden-string-tested builders behind injected fakes.
6. **Do all work in the worktree** (`.worktrees/rust-tauri-port`), commit to
   `feat/rust-tauri-port`, push to origin. **No PR. Never commit to `main`.**
7. Windows verification via WSL↔Windows interop (powershell.exe etc.) — "do your best."
   macOS is out of reach on this host (documented ceiling).
8. **Current active directive** (the task in flight when this handoff was written):
   *"Spin up servers and clients in all combinations: Windows, WSL, Chrome, Electron, Tauri.
   Make sure all of them work properly and interchange properly. Start every kind of shell in
   each one and screenshot to validate that it's really working. Fix everything that you find.
   … Don't stop until you've achieved parity, or as close to it as you can get with the CLIs
   installed."*

---

## 2. Geography

| Thing | Where |
|---|---|
| **Reference repo** (pristine original) | `/home/dan/code/freshell` — branch `main`. `server/`, `shared/`, `src/` here and in the worktree are THE REFERENCE. `git diff` on them must stay empty in the worktree. |
| **The port worktree (work here)** | `/home/dan/code/freshell/.worktrees/rust-tauri-port` — branch `feat/rust-tauri-port`, pushed to `origin` (github.com/danshapiro/freshell). ~60 commits of port work. |
| **User's legacy auth token** | `/home/dan/code/freshell/.env` → `AUTH_TOKEN=` (64 hex chars). The worktree's own `.env` has a DIFFERENT token — always use the main-repo one for anything the user's apps connect to. Never print the token. |
| **Legacy Electron app (installed)** | `C:\Users\dan\AppData\Local\Temp` sibling installs exist; the real one: `C:\Users\dan\AppData\Local\Programs\Freshell\Freshell.exe` (v0.7.0). Its config lives in the WINDOWS user profile (Electron `~/.freshell`/desktop.json on the Windows side) — **back up before touching, restore after**. |
| **Machine** | WSL2 Ubuntu on DANDESKTOP (Windows 11). WSLg active (`DISPLAY=:0`). This is the user's real desktop — treat everything outside scratch dirs as production. |

---

## 3. Architecture of the port

### Rust workspace (in the worktree)

| Crate | What it is | Proven by |
|---|---|---|
| `freshell-protocol` | Frozen WS/REST wire types (serde), `preserve_order` on | T0 |
| `freshell-platform` | Platform detect (two WSL detectors — CD-1, do NOT unify), shell/CLI spawn-spec builders (`spawn.rs` — buildSpawnSpec port incl. Windows branches + `build_windows_cli_spawn_spec` + `wsl_windows_shell_inherit_cwd`), `path.rs` (`resolve_launch_cwd`), network/bind/firewall/portproxy/elevated **command builders** (golden-string tested, mutation behind injected `CommandRunner`) | unit goldens + matrix |
| `freshell-terminal` | PTY via `portable-pty` (ConPTY on Windows), seq framing, ReplayRing, **TerminalRegistry** (multi-client attach/detach/background), batch framing (VT barrier scanner, UTF-16 offsets, char ChunkRingBuffer) | T1 + batch tier + T3 |
| `freshell-sessions` | Transcript parsers (claude jsonl, codex, opencode sqlite), session indexer (DEV-0002 liveness fix), text normalization (**char-boundary safe** — see bug #7) | T2 + fixtures |
| `freshell-opencode` | `opencode serve` client (DEV-0001 bounded probe fix) | T2 live |
| `freshell-codex` | codex app-server JSON-RPC/WS client, status-guarded completion, effort VERBATIM (DEV-0003 rejected) | T2 live |
| `freshell-freshagent` | freshAgent.* WS surface for the three agents; claude via the Node sidecar | T2 live |
| `freshell-ws` | WS handler: handshake, terminal.* (registry-backed, attachRequestId stamped, **`mode` honored** → CLI launch), tabs-sync, screenshot broker, settings broadcast | T0/T1/T3 |
| `freshell-api` | `/api/health` (full 7-field shape — legacy-Electron discovery compatible) | health + Electron predicate |
| `freshell-server` | The binary: static SPA serving + SPA-fallback, boot endpoints, files (candidate-dirs/validate/read/write/stat/mkdir/complete), sessions directory, network status, extensions/availableClis, proxy (`/api/proxy/http/{port}/*`), screenshots. Env: `PORT`, `AUTH_TOKEN` (mandatory), `FRESHELL_BIND_HOST` (defaults **0.0.0.0 on WSL**, else 127.0.0.1), `FRESHELL_HOME`/`HOME`, `FRESHELL_CLIENT_DIR` | everything |
| `freshell-tauri` | Tauri v2 shell: app-bound server spawn (health-gated, reaped), 2-property `window.freshellDesktop` shim (`isElectron`, `openExternal`), single-instance, tray/hotkey/window-state/wizard/chooser/updater-config/renderer-recovery, **NEW: `provisioning.rs` remote mode (`FRESHELL_REMOTE_URL`+`FRESHELL_TOKEN` → skip spawn, load remote)** — unit-tested (145 green), **not yet live-validated** | xvfb smoke; matrix legs PENDING |
| `crates/freshell-claude-sidecar/` | Node pkg (own package.json + lockfile; node_modules gitignored — `npm install` inside it if needed). stdio JSON protocol around the claude SDK | T2 claude live |

### Builds

- Linux release: `cargo build --release -p freshell-server` → `target/release/freshell-server`
- **Windows exe** (cross-compile): `cargo build --release -p freshell-server --target x86_64-pc-windows-gnu`
  → `target/x86_64-pc-windows-gnu/release/freshell-server.exe` (PE32+, self-contained).
  Toolchain: `rustup target add x86_64-pc-windows-gnu` + `apt mingw-w64`; linker wired in
  the committed `.cargo/config.toml`.
- Tauri: `cargo build -p freshell-tauri` (debug is fine; ~250 dep crates, slow first build).
- SPA: `npm run build:client` → `dist/client` (the retained frontend; rebuilding it is allowed,
  modifying `src/` is NOT).
- **After changing any shared crate, rebuild BOTH server binaries** before re-running matrix
  legs (a stale-binary incident caused a false FAIL once).

---

## 4. The equivalence oracle (how correctness is defined)

All under `port/oracle/`. Grades the port against the PRISTINE original. Deterministic
tiers run free; live tiers are gated.

| Tier | What | How to run | State |
|---|---|---|---|
| T0 | WS handshake ≡ original (normalized deep-equal, schema, two-boot determinism) | `npx vitest run --config config/vitest/vitest.oracle.config.ts test/unit/port/oracle/t0-equivalence-rust.test.ts` | ✅ 5/5 |
| T1 | Terminal bytes over the wire ≡ original (sha256 goldens) + **batch tier** (UTF-16 offsets, multibyte proof) | `…/t1-equivalence-rust.test.ts`, `…/t1-batch-equivalence-rust.test.ts` | ✅ 10/10 + 44/44. Contains the **ENV-0001 detect-and-quarantine** posture (self-extinguishing; `toUpperCase` appears ONLY as a skip-vs-fail classifier, never an assertion). |
| T2 | Live provider matrix (opencode/Kimi, codex/GPT, claude/Haiku): 9/9 invariants + structural deep-equal vs frozen baselines | gate: `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`, tests `t2-{opencode,codex,claude}-equivalence-rust.test.ts` (~1 live call each) | ✅ 3/3 providers |
| T3 | Full e2e (`test/e2e-browser/`) against the Rust server via the external-target seam | `FRESHELL_E2E_TARGET_URL=http://127.0.0.1:<port> FRESHELL_E2E_TARGET_TOKEN=<tok> npx playwright test --config port/oracle/t3/playwright.target.config.ts` | ✅ 118/126 — **matches the original's exact pass/fail profile**; the 8 fails are EQUIVALENT (red on the pristine original too; listed in EQUIVALENCE-REPORT) |
| Mutation | Proves the oracle bites (28/28 planted divergences caught + e2e RED→GREEN) | `…/mutation-validation.test.ts`, `…/mutation-e2e.test.ts` | ✅ |
| **Matrix** (current phase) | Real clients × real servers × every pane kind, screenshot + **skeptical vision review** | `port/oracle/matrix/run-matrix.mjs` (WSL leg), `run-matrix-win.mjs` (Windows leg) — self-booting, self-reaping | WSL×Chrome ✅ 9/9 · Win×Chrome ✅ 9/9 · Tauri/Electron PENDING |

**The e2e/matrix client trick:** open `http://<server>/?token=<tok>&e2e=1` → the SPA installs
`window.__FRESHELL_TEST_HARNESS__` (`getTerminalBuffer(id)`, `getWsReadyState()`, `getState()`).
Pane picker: new tab via `[data-context="tab-add"]`; toolbar `role=toolbar name=/pane type picker/i`;
buttons by aria-label: `CMD`, `PowerShell`, `WSL`, `Shell`, `Claude CLI`, `Codex CLI`, `OpenCode`,
`Gemini`, `Kimi`, `Editor`, `Browser`. CLI kinds show a directory-confirm step before spawning.
Read output via the harness buffer, not the DOM.

---

## 5. What is PROVEN (do not re-litigate; spot-check if suspicious)

- **All four oracle tiers `original ≡ rust`**, deterministically (T2-opencode flake fixed via
  steady-state DB wait, commit `093c1050`).
- **Matrix — WSL Rust server × Chrome: 9/9 vision-verified** (`port/oracle/matrix/wsl-chrome-*.png`
  + `wsl-chrome-report.json`): CMD, PowerShell, WSL/bash (all landing in the workspace cwd),
  Claude/Codex/OpenCode steady interactive UIs, Editor (Monaco mounted + typed text), Browser
  (example.com rendered), multi-tab overview.
- **Matrix — Windows Rust server (.exe, native ConPTY) × Chrome: 9/9 vision-verified**
  (`win-chrome-*.png` + report): same set, plus the `wsl.exe → bash` branch (only reachable on a
  native-Windows server). Claude/Codex/Gemini all paint real UIs. **opencode = ENV-LIMITED on
  Windows** (`where.exe opencode` → not installed) — not a bug.
- **Legacy-Electron compatibility handshake**: `/api/health` full 7-field shape (Electron's
  discovery predicate passes), token validation via `/api/settings` (200/401), **no version gate**.
- **Interchange plumbing**: `run-rust-server.sh` runs the Rust server with the user's legacy
  token on :3001-style config so the user can swap engines under the same desktop app.
- Rust tests: workspace (excl tauri) ~430+ green; tauri 145 green; clippy clean.

## 6. Bugs found + fixed during validation (all committed, each with tests)

| # | Bug | Fix commit |
|---|---|---|
| 1 | `terminal.output` missing `attachRequestId` → SPA rendered nothing (caught by T3, invisible to T1) | Phase 3.10 |
| 2 | DEV-0001: opencode cold-serve health probe unbounded (ORIGINAL bug → fixed in port, pinned `serve_health_bounded.rs`) | ledger |
| 3 | DEV-0002: session-indexer crash on late root (ORIGINAL bug → fixed in port, pinned `late_root_watcher_liveness.rs`) | ledger |
| 4 | DEV-0003 REJECTED: codex effort clamp was a false defect — port forwards `none`/`minimal` verbatim | ledger |
| 5 | `/api/health` lacked `app:"freshell"` etc. → legacy Electron refused to recognize the server | `494a7d14` |
| 6 | Server bound 127.0.0.1 on WSL → invisible to Windows apps (original binds 0.0.0.0 on WSL) | `f82b8ce8` |
| 7 | Panic: byte-slice inside `→` in `strip_image_tags` → session indexer worker died on real transcripts | `486c4e64` |
| 8 | `terminal.create.mode` ignored → coding-CLI panes silently spawned bash | `8d2b1d21` |
| 9 | WSL-launched cmd/powershell fell back to `C:\Windows` (UNC cwd + interop quote-mangling) → inherit-`/mnt` cwd fix | `4e148667` |
| 10 | Native-Windows CLI launch branch missing (`cli=None` on win32) → CLI panes never painted on the Windows server | `49ef0f7c` |
| 11 | T2-opencode harness read-timing race (dbMessageCount 1 vs 2) | `093c1050` |
| 12 | ENV-0001: live node-original uppercased PTY output — **stale dist build**, resolved by clean rebuild; quarantine posture retained in T1 tests | DEVIATIONS.md |

## 7. Deviations ledger state (`port/oracle/DEVIATIONS.md`)

- **Adjudicated:** DEV-0001 accepted+pinned · DEV-0002 accepted+pinned · DEV-0003 rejected
  (zero tolerance) · ENV-0001 resolved (environment note, port always correct).
- **Open candidate deviations** (flagged in-code / in `port/machine/architecture-spec.md` §8.1, §6.5):
  CD-1…CD-8; candidate-dirs HOME fallback (`freshell-server/src/files.rs`); **cmd-branch quoting
  gate** (portable-pty ArgvQuote vs node-pty — documented PORT-FIX in `spawn.rs`); window-state
  off-screen clamp; tray-status refresh; updater `Disarmed` surfacing; per-boot token in app-bound
  mode; **CLI argv reduced fidelity** (see §9 item 4 — the big one).
- Rules: the ledger is only for objective ORIGINAL defects the port handles deliberately.
  Candidate deviations go to an adversarial reviewer (`anchors:architect` was used); never
  self-approve; never patch `server/`/`shared/`.

---

## 8. Operational recipes (hard-won; use them verbatim)

### WSL Rust server
```bash
cd .worktrees/rust-tauri-port
PORT=3031 AUTH_TOKEN=<tok> FRESHELL_BIND_HOST=127.0.0.1 \
  HOME=<scratch-under-$HOME-not-/tmp> FRESHELL_HOME=<same> \
  FRESHELL_CLIENT_DIR=$PWD/dist/client ./target/release/freshell-server
# user-facing run with the legacy token: ./run-rust-server.sh  (PORT=3001, bind 0.0.0.0)
```
Scratch HOMEs **must not be under /tmp** (codex refuses helper binaries there). Health-gate on
`GET /api/health` → `app:"freshell"`.

### Windows Rust server (as a real Windows process, from WSL)
```bash
# 1. SPA must be at a NATIVE Windows path:
cp -r dist/client "$(wslpath -u 'C:\Users\dan\AppData\Local\Temp')/freshell-matrix-winclient"
# 2. WSL env does NOT propagate to .exe — use a cmd set-wrapper (no space before &&):
cmd.exe /d /c "cd /d C:\Users\dan\AppData\Local\Temp && set PORT=3041&& set AUTH_TOKEN=<tok>&& set FRESHELL_BIND_HOST=0.0.0.0&& set FRESHELL_CLIENT_DIR=C:\Users\dan\AppData\Local\Temp\freshell-matrix-winclient&& <wslpath -w of freshell-server.exe>" &
# 3. Reach it from WSL at the WINDOWS HOST IP (NOT 127.0.0.1):
WINIP=$(ip route show default | awk '{print $3}')   # ~172.30.144.1
curl -s http://$WINIP:3041/api/health
# 4. REAP (taskkill.exe and wmic are BROKEN over interop):
netstat.exe -ano | grep ':3041 '   # → PID
powershell.exe -NoProfile -Command "Stop-Process -Id <pid> -Force"
```
Native Windows clients (Chrome/Electron/Tauri on the Windows side) can use `localhost:<port>`
directly. From Windows→WSL, localhost forwards; from WSL→Windows-process it does NOT.

### Tauri app
```bash
cargo build -p freshell-tauri
# app-bound (spawns its own server; sibling target/debug/freshell-server or FRESHELL_SERVER_BIN):
FRESHELL_SERVER_BIN=$PWD/target/release/freshell-server ./target/debug/freshell-tauri
# remote mode (NEW, unit-tested only — needs live validation):
FRESHELL_REMOTE_URL=http://<host>:<port> FRESHELL_TOKEN=<tok> ./target/debug/freshell-tauri
```
WSLg gives a real window (`DISPLAY=:0`). Screenshot: `import -window root out.png`
(ImageMagick; xdotool availability unverified). Known WebKitGTK/WSLg fallback if blank:
`WEBKIT_DISABLE_COMPOSITING_MODE=1`. You cannot Playwright a WebKitGTK window — drive state
via a **mirror client** (second browser client on the same server; the terminal registry +
tabs-sync mirror tabs/terminals across clients) or pre-create terminals before launch.

### Matrix harnesses
`node port/oracle/matrix/run-matrix.mjs` (WSL leg) and `run-matrix-win.mjs` (Windows leg) —
each boots its server, drives Chromium through every pane kind, asserts buffer output,
screenshots to `port/oracle/matrix/*.png`, writes `*-report.json`, reaps. Adapt them for the
remaining legs. Windows CLI quirks already encoded: codex's first screen in a fresh dir is its
**trust prompt**; npm `.cmd`-shim CLIs cold-start slowly (90s launch window).

### Screenshot verification
Every screenshot claim must survive a **skeptical vision review** (delegate with
`model_role: "vision"`; OCR via tesseract; check md5-distinctness; verify cwd in prompts, real
UI text, no blank panes/error toasts). Buffer asserts alone are NOT sufficient — they passed
while claude/codex screenshots showed blank panes once.

### Windows-side screenshots (for Electron legs)
PowerShell can capture the Windows desktop:
`Add-Type System.Windows.Forms,System.Drawing; [Windows.Forms.Screen]::PrimaryScreen.Bounds` +
`Graphics.CopyFromScreen` → save PNG → copy into the worktree. Probe-verified (2560px wide).

---

## 9. REMAINING WORK (in priority order — this is your queue)

1. **Tauri × WSL server (app-bound), Leg A.** Launch under WSLg with an isolated
   `FRESHELL_HOME`, pre-create/mirror terminals (CMD, PowerShell, WSL, one CLI) via a Playwright
   mirror client on the same port+token, let the Tauri window attach, `import` screenshot the
   real window, vision-verify, assert via the mirror buffers. If tabs don't auto-appear, create
   terminals BEFORE launching Tauri (inventory + tabs registry restore them on load).
2. **Tauri × Windows server (remote), Leg B.** `provisioning.rs` is committed and unit-tested
   (`1c2c9c7d`) but **never live-run**. Boot the Windows server (recipe §8), pre-create
   terminals, launch Tauri with `FRESHELL_REMOTE_URL=http://$WINIP:<port> FRESHELL_TOKEN=<tok>`,
   screenshot + vision-verify. Fix whatever the first live run reveals (likely candidates:
   URL join, webview nav timing, token quoting).
3. **Electron (legacy Freshell.exe) × both servers.** The handshake is proven; do the real
   click-through: **back up the Electron desktop config first** (Windows-side `desktop.json` /
   `.env` under the Windows user profile), provision remote URL+token (its provisioning file or
   the wizard), launch `Freshell.exe`, confirm it connects and shells work, PowerShell-screenshot,
   vision-verify, **restore the user's config after**. Test against (a) the WSL Rust server at
   `http://localhost:3001`-style and (b) the Windows Rust server at `localhost:<port>`.
   Use the user's legacy token so their config keeps working.
4. **CLI argv fidelity pass** (flagged candidate deviation): the port launches CLIs with the
   base command only. The original layers: MCP-config injection (`generateMcpInjection` →
   `--mcp-config`/`-c mcp_servers.*`), turn-complete notification args (codex `-c tui.*`,
   claude `--settings` hook), the opencode loopback control endpoint (`--hostname/--port`),
   resume/model/sandbox/permission args (`server/terminal-registry.ts:200-300` +
   `resolveCodingCliCommand`). Port these faithfully into `freshell-platform/spawn.rs` +
   `freshell-ws`, golden-test argv against the reference, and prove one live turn still works
   per CLI. Then move the in-code flag to the ledger as resolved.
5. **Interchange sweep + final report.** One table: {WSL server, Windows server} ×
   {Chrome, Electron, Tauri} — connect with the SAME legacy token, shells work, screenshot
   each cell. Update `EQUIVALENCE-REPORT.md` (add the matrix addendum), `STATE.yaml`, and
   the final matrix section in this file.
6. **Documented ceiling (do NOT attempt here):** macOS entirely; live Windows-elevated
   netsh/UAC mutation; the 8 EQUIVALENT-red e2e specs (they're red on the pristine original —
   frontend territory, out of scope); opencode-on-Windows (not installed).
7. Optional polish: session-persistence sanity on the Windows server ("No sessions yet"
   observation in matrix shots); post-trust-prompt input round-trip screenshots for codex/gemini
   on Windows; Tauri↔Chrome live mirror assertion.

---

## 10. Non-negotiable invariants (check before EVERY commit)

```bash
git diff --name-only server/ shared/ src/   # MUST be empty
pgrep -x freshell-server                     # only your scratch instances; reap them
# :3001 belongs to the user — never bind, never kill
```
- Commit to `feat/rust-tauri-port` only; push after each commit; no PR; `main` untouched.
- Commit messages end with the Amplifier attribution block (see git log for the exact form).
- Independently verify subagent claims (rebuild binaries, re-run the exact test, check md5s).
- Live model spend: cheapest models, single-digit calls, only when a tier demands it.
- Anything you must change in user-owned config: back up first, restore after, say so.

## 11. Key file index

```
port/GOAL.md                          ← the success criteria (the /goal)
port/HANDOFF.md                       ← this file
port/machine/STATE.yaml               ← phase state (resumable control surface)
port/machine/architecture-spec.md     ← ADR (crate map, CD-1..8, sidecar justification)
port/machine/specs/*.md               ← 4 ground-truth behavior specs (from CODE, cited)
port/oracle/EQUIVALENCE-REPORT.md     ← per-tier results + addendum (the capstone)
port/oracle/DEVIATIONS.md             ← ledger (DEV/ENV entries, antagonist rulings)
port/oracle/matrix/                   ← matrix harnesses + screenshots + reports
port/oracle/t3/playwright.target.config.ts / run-against-rust.md
crates/                               ← the port (see §3)
run-rust-server.sh                    ← user-facing launcher (legacy token, :3001)
.cargo/config.toml                    ← Windows cross-compile linker
test/unit/port/oracle/                ← the oracle test suites
config/vitest/vitest.oracle.config.ts
```
