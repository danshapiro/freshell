# HANDOFF v3 — freshell Rust + Tauri Port

**Updated 2026-07-11 on `SurfaceBookPro9`, branch `feat/rust-tauri-port`, from
setup-handoff commit `c8240743`.**
**This document REPLACES all earlier handoffs. This is the only handoff.**

**Audience:** the next Amplifier session taking over on this WSL host.
Read this whole file, then `port/GOAL.md` (the success criteria you are held to), then
`port/machine/STATE.yaml`, `port/oracle/EQUIVALENCE-REPORT.md`,
`port/oracle/DEVIATIONS.md`, and `port/machine/specs/cli-argv-fidelity.md` (rev 2.1).

---

## SETUP-ONLY RELAY — read before §0

**The port campaign has NOT started on this host.** The setup agent intentionally did
not run the Phase-0 probe, recipes, builds, tests, servers, oracle, or implementation.
Do not interpret installed dependencies as new equivalence evidence. Begin §9 item 1
only after every preflight gate below is green.

### Current checkout and Amplifier

- Checkout: `/home/dan/code/freshell`, clean `feat/rust-tauri-port`, tracking
  `origin/feat/rust-tauri-port`; cloned directly at bootstrap commit `b7b50fff`.
- Amplifier: `2026.07.09-dad1c21` (`core 1.6.0`). Global active bundle is
  `self-driving`.
- Always-composed Amplifier app bundles: Microsoft `skills` (including
  `cranky-old-sam`, `crusty-old-engineer`, `intent-keeper`, `tester-breaker`,
  `user-advocate`, `council`, `council-here`, and `personafy`) plus `dev-memory`.
- Selectable bundles already registered: `recipes`, `superpowers`, `longbuilder`,
  `self-driving`, `parallax-discovery`, and `workgraph`.
- GitHub CLI is authenticated as `danshapiro` with push-capable repo scope.
- Amplifier auth/config is installed. The restaged archive matched SHA-256 prefix
  `78c95a94b896a606`; its matched `~/.amplifier/settings.yaml`, mode-600
  `~/.amplifier/keys.env`, and `~/amplifier-overrides/provider-anthropic/` were
  extracted as the normal WSL user. Both Anthropic and OpenAI pass
  `amplifier provider test`. A real Anthropic/Haiku single-turn call returned exactly
  `AMPLIFIER_E2E_OK`, after which the live-key tarball was deleted from the public
  Windows staging directory. Never print or commit the installed keys.

### User-space provisioning completed

- Node `v24.12.0`, npm `11.6.2`.
- Rust stable `1.97.0`; installed targets:
  `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-gnu`.
- Root `npm ci` completed; `crates/freshell-claude-sidecar/npm install` completed.
  The install reported the repository's existing npm audit findings; do **not** run
  `npm audit fix` because that would mutate the locked dependency graph.
- Playwright Chromium 1208, headless shell 1208, and FFmpeg 1011 payloads are in
  `~/.cache/ms-playwright`. Their Linux shared-library prerequisites are not yet
  installed.
- WSL CLI binaries are installed: Claude Code `2.1.207`, Codex CLI `0.144.1`, and
  OpenCode `1.17.18`.
- WSL CLI auth: Claude uses the user's Claude Max account; Codex reports `Logged in
  using ChatGPT`; the user has live-verified Claude and OpenCode with their cheapest
  models. Absolute-path `"$WIN_WHERE"` probing finds Windows-side Claude and Codex;
  Windows-side OpenCode is absent.

### Windows interop command policy — absolute paths only

`/etc/wsl.conf` intentionally sets `[interop] appendWindowsPath=false`. **Do not
change that setting and do not append Windows directories to `PATH`, globally or for
the session.** Windows interop is live, but every WSL→Windows process invocation must
use an explicit executable path (or a shell-local variable containing that absolute
path). Never assume `cmd.exe`, `powershell.exe`, `where.exe`, `netstat.exe`,
`netsh.exe`, `ipconfig.exe`, or `wsl.exe` resolves through `PATH`.

The Phase-0 snippet in §3 defines the canonical shell-local variables. Re-establish
them in each new shell/session; do not export a modified PATH as a shortcut.

### System provisioning blocked on sudo

The committed `port/laptop-bootstrap/2-bootstrap-wsl.sh` was used after the staged
copy proved absent. Its apt and Playwright `--with-deps` phases reached an interactive
sudo password prompt. Consequently `cc`, `make`, `pkg-config`, the MinGW linker,
Tauri/WebKitGTK development libraries, ImageMagick, tesseract, and xdotool are still
missing. No readiness build was attempted with a knowingly incomplete compiler.

### Preflight gates before starting §9 item 1

1. **Amplifier auth/config — COMPLETE (2026-07-11).** The archive hash was verified,
   the matched settings/keys/local-provider override were installed, mode 600 was
   applied to `keys.env`, both providers passed discovery, and Anthropic completed a
   real Haiku turn. The public live-key archive was then securely removed. The import
   retained the selectable bundle registry but replaced app/active settings; `skills`
   and `dev-memory` were restored as app bundles and `self-driving` was restored as
   the global active bundle.

2. **Complete the sudo-owned toolchain phase** (a human must enter the WSL password):

   ```bash
   sudo apt-get update -y
   sudo apt-get install -y build-essential curl git pkg-config libssl-dev unzip \
     mingw-w64 imagemagick tesseract-ocr xdotool \
     libwebkit2gtk-4.1-dev libgtk-3-dev \
     libayatana-appindicator3-dev librsvg2-dev
   ```

   Then rerun the authoritative committed bootstrap, not a guessed replacement:

   ```bash
   cd /home/dan/code/freshell
   bash port/laptop-bootstrap/2-bootstrap-wsl.sh
   ```

3. **Complete the human-only CLI credentials once:** repair `claude` auth and run
   `opencode auth login`. Codex and `gh` are already authenticated. Install/auth the
   Windows-side CLIs where the §7 matrix requires them, or later record each missing
   leg as ENV-LIMITED with the §8.5 proof standard.

4. **Only after gates 1–3:** launch Amplifier from this checkout with the active
   `self-driving` bundle, read the full document chain named above, and begin with the
   recorded Phase-0 capability probe in §3 / work queue §9 item 1. Do not jump directly
   to CLI argv implementation or live QA.

---

## 0. Your environment (differs from prior sessions — read first)

- **WSL2 Linux is your shell.** You execute from WSL.
- **Windows interop works through absolute executable paths.** Windows PATH import is
  intentionally disabled and must remain disabled; use the §3 `WIN_*` shell-local
  variables for every WSL→Windows call. The **WSL × Windows combinations ARE
  verifiable here** (native-Windows server, Windows shells, PowerShell screenshots).
- **NO legacy freshell installation.** No installed Electron `Freshell.exe`, no
  pre-existing `.env` token, and no live production server to protect. Everything you
  need is in this repo: the ORIGINAL server runs from source (`npm start`), and the
  Electron client BUILDS from source (`electron` ^33 is a devDependency;
  `electron:dev` / `electron:build:win` scripts exist).
- **Unknown until probed:** node/npm, Rust toolchain, Playwright browsers, WSLg (GUI),
  ImageMagick, tesseract, the coding CLIs (claude/codex/opencode/gemini) and their
  credentials. Run the Phase-0 probe (§3) first; provision what's missing; record
  anything unprovisionable as ENV-LIMITED **with proof** (§8.5).

### The port rule (non-negotiable)

**All test servers bind in the nonstandard range `17870–17899`. Never bind 3000–3010**
(freshell's defaults — using them invites collision and ambiguity). Keep assignments
stable so logs and reports are readable:

| Port | Role |
|---|---|
| 17871 | ORIGINAL Node server (the reference), WSL |
| 17872 | Rust server, WSL |
| 17873 | Rust server, native Windows (`freshell-server.exe`) |
| 17874 | Tauri remote-mode target / second-server tests |
| 17875–17899 | mirrors, scratch, interchange, e2e external targets |

(Oracle harnesses that self-allocate ephemeral loopback ports are fine as-is — the
rule governs ports YOU choose.)

### Auth token

Generate your own once per session and reuse it everywhere (both servers must share it
for interchange tests): `openssl rand -hex 32`. The original server REFUSES tokens
< 16 chars or weak/default-looking ones (`server/auth.ts:16-24`). Never commit or
print the token; scripts should read it from an env var or an untracked file.

---

## 1. Mission and binding directives

Port freshell — a terminal-multiplexer web app with embedded coding-CLI agents — from
Node/TypeScript + Electron to **Rust + Tauri**, retaining everything else exactly:

- **Server** (`server/`, ~60k lines TS) → Rust crates. **Done, equivalence-proven** on
  the prior host; you re-prove on this one (§6–§7).
- **Desktop shell** (`electron/`) → Tauri v2 (`crates/freshell-tauri`). Built;
  client-matrix validation incomplete (§9).
- **Frontend** (`src/`, React SPA) → **RETAINED BYTE-IDENTICAL. Never modify it.**
- **JS only where there is no Rust equivalent**: the ONE sanctioned exception is
  `crates/freshell-claude-sidecar/` (Node wrapper for `@anthropic-ai/claude-agent-sdk`).

Standing user directives (these bind you):

1. **Autonomous, one-shot.** Do not stop at milestones. Every turn ends with an action
   in flight, true completion, or a proven hard blocker. (Mid-run stops have been
   called out repeatedly. Don't.)
2. **QA comprehensive and impeccable**: live APIs, real running systems, **cheapest
   models** (opencode→`umans-ai-coding-plan/umans-kimi-k2.7`, codex→`gpt-5.3-codex-spark`
   effort `low`, claude→Haiku). Single-digit live calls per run.
3. **Fix bugs; never replicate bug-for-bug.** Every original-vs-port difference is
   either fixed (with a regression test) or adjudicated in `port/oracle/DEVIATIONS.md`
   by an ADVERSARIAL reviewer. **Never self-approve a deviation. Never weaken an
   oracle assertion** (a case-insensitive "fix" was explicitly rejected once —
   see DEVIATIONS.md ENV-0001).
4. **Gemini is out of porting scope** (its CLI may still launch as a plain terminal
   pane — that's fine — but no gemini provider port or live QA).
5. **Work in this worktree, commit to `feat/rust-tauri-port`, push after each commit.
   No PR. Never commit to `main`.** Commit messages end with the Amplifier
   attribution block (copy the exact form from `git log`).
6. **Safety:** never execute mutating Windows network/firewall commands
   (`netsh add/delete`, elevated UAC) — STATUS reads only; mutation exists solely as
   golden-string-tested builders behind injected fakes. Reap every process you start
   (ownership-based checks). Isolated `HOME`s for all test servers.

---

## 2. Geography and architecture

| Thing | Where |
|---|---|
| Reference (pristine original) | `server/`, `shared/`, `src/` in this worktree — **byte-identical to the frozen base commit `98ed121c`; `git diff` on them must stay empty forever.** |
| The worktree | this repo checkout, branch `feat/rust-tauri-port` (pushed to `origin`, github.com/danshapiro/freshell). ~65 commits of port work. Do not rebase onto moved `main` unless the user asks. |
| The port | `crates/*` (11 Rust crates + 1 Node sidecar) + `dist/client` (built retained SPA). |

### Crate map (with what proves each)

| Crate | Role | Proven by |
|---|---|---|
| `freshell-protocol` | Frozen WS/REST wire types (serde, `preserve_order`) | T0 |
| `freshell-platform` | Platform detect (two WSL detectors — deliberate, CD-1), shell + CLI spawn builders (`spawn.rs`: buildSpawnSpec port incl. Windows branches, `build_windows_cli_spawn_spec`, `wsl_windows_shell_inherit_cwd` PORT-FIX, ArgvQuote quoting gate), `path.rs` (`resolve_launch_cwd`), network/bind/firewall builders (golden-string; mutation behind injected `CommandRunner`) | unit goldens + matrix |
| `freshell-terminal` | PTY via `portable-pty` (ConPTY on Windows), seq framing, ReplayRing, TerminalRegistry (multi-client attach/background), batch framing (VT barrier scanner, **UTF-16** offsets, char ring) | T1 + batch + T3 |
| `freshell-sessions` | Transcript parsers (claude jsonl, codex, opencode sqlite), session indexer, text normalization (char-boundary-safe — bug #7) | T2 + fixtures |
| `freshell-opencode` | `opencode serve` client (+ `LoopbackPortAllocator`, `transport.rs:323`) | T2 live |
| `freshell-codex` | codex app-server JSON-RPC client; effort forwarded VERBATIM (DEV-0003) | T2 live |
| `freshell-freshagent` | freshAgent.* WS surface; claude via the Node sidecar | T2 live |
| `freshell-ws` | WS handler: handshake, terminal.* (registry-backed, `attachRequestId` stamped, `mode` honored → CLI launch), tabs-sync, screenshot broker, settings broadcast | T0/T1/T3 |
| `freshell-api` | `/api/health` — full 7-field original shape (Electron discovery predicate passes) | health tests |
| `freshell-server` | The binary: SPA static serving + fallback, boot endpoints, files API, session-directory, network status, extensions/availableClis, HTTP proxy, screenshots. Env: `PORT`, `AUTH_TOKEN` (mandatory), `FRESHELL_BIND_HOST` (**defaults 0.0.0.0 on WSL** — original parity), `FRESHELL_HOME`/`HOME`, `FRESHELL_CLIENT_DIR` | everything |
| `freshell-tauri` | Tauri v2 shell: app-bound server spawn (health-gated, reaped), 2-property `window.freshellDesktop` shim, single-instance, tray/hotkey/window-state/wizard/chooser/updater-config/renderer-recovery, `provisioning.rs` **remote mode** (`FRESHELL_REMOTE_URL`+`FRESHELL_TOKEN` → skip spawn, load remote) — unit-tested, **never live-run** | matrix legs PENDING |
| `crates/freshell-claude-sidecar/` | Node pkg (own package.json + committed lockfile; run `npm install` inside it) | T2 claude |

### Builds

```bash
# Rust, Linux:
cargo build --release -p freshell-server          # → target/release/freshell-server
cargo build -p freshell-tauri                     # debug is fine (first build is slow)
# Rust, Windows (cross-compile; .cargo/config.toml already wires the linker):
rustup target add x86_64-pc-windows-gnu && sudo apt-get install -y mingw-w64
cargo build --release -p freshell-server --target x86_64-pc-windows-gnu
#   → target/x86_64-pc-windows-gnu/release/freshell-server.exe  (self-contained PE32+)
# Retained SPA (allowed to BUILD, never to modify src/):
npm ci && npm run build:client                    # → dist/client
# ORIGINAL (the reference — you need it running for every differential test):
npm run build                                     # typecheck + client + server → dist/
```

**After changing any shared crate, rebuild BOTH server binaries before re-running
matrix legs.** (A stale binary produced a false FAIL once; don't repeat it.)

---

## 3. Phase-0: capability probe + provisioning (do this before all else)

Run and RECORD (paste outputs into your first report):

```bash
# Windows PATH import is intentionally disabled. Define shell-local absolute paths;
# NEVER modify PATH or /etc/wsl.conf to make these commands resolve by basename.
WIN_SYSTEM32=/mnt/c/Windows/System32
WIN_CMD="$WIN_SYSTEM32/cmd.exe"
WIN_WHERE="$WIN_SYSTEM32/where.exe"
WIN_NETSTAT="$WIN_SYSTEM32/netstat.exe"
WIN_NETSH="$WIN_SYSTEM32/netsh.exe"
WIN_IPCONFIG="$WIN_SYSTEM32/ipconfig.exe"
WIN_WSL="$WIN_SYSTEM32/wsl.exe"
WIN_POWERSHELL="$WIN_SYSTEM32/WindowsPowerShell/v1.0/powershell.exe"

node --version; npm --version                      # need ≥ 20.x per package.json engines
rustc --version; rustup target list --installed    # need stable + x86_64-pc-windows-gnu
cat .cargo/config.toml                             # windows-gnu linker wiring (committed)
npx playwright --version; ls ~/.cache/ms-playwright 2>/dev/null | head -3   # browsers?
echo "DISPLAY=$DISPLAY WAYLAND=$WAYLAND_DISPLAY"; ls /mnt/wslg 2>/dev/null && echo WSLg  # GUI?
"$WIN_POWERSHELL" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'   # interop?
"$WIN_POWERSHELL" -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width"  # can screenshot the Windows desktop?
which import convert tesseract xdotool             # screenshots + OCR
for c in claude codex opencode gemini; do printf "%-10s wsl:%s win:%s\n" "$c" \
  "$(which $c >/dev/null && echo Y || echo n)" \
  "$("$WIN_WHERE" "$c" >/dev/null 2>&1 && echo Y || echo n)"; done
ip -4 addr show eth0 | grep -oE 'inet [0-9.]+'     # WSL IP (Windows→WSL reachability)
ip route show default | awk '{print $3}'           # WINDOWS HOST IP (WSL→Windows-process)
```

Provision as needed: `npm ci` at repo root; `npx playwright install chromium`;
apt packages `mingw-w64 imagemagick tesseract-ocr xdotool` (root/sudo as your host
allows); the rustup Windows target (§2); Tauri build deps (`libwebkit2gtk-4.1-dev`
etc.) if you will build the Tauri app; `npm install` inside
`crates/freshell-claude-sidecar/`. If a coding CLI or its credentials are absent on a
given side (WSL vs Windows), the affected legs are ENV-LIMITED — record the probe
output as proof and move on (§8.5). T2 live equivalence REQUIRES working
claude+codex+opencode credentials; if absent, T2 is blocked — say so loudly in your
report rather than skipping silently.

---

## 4. What is already proven (do not re-litigate; DO re-run)

All prior proofs ran on the original dev host. Deterministic suites must be **re-run
green on THIS host** early (§9 step 2) — cheap, and it revalidates the toolchain.
State at `b1b9a46b`:

- **All four oracle tiers `original ≡ rust`**: T0 5/5 (handshake deep-equal, schema,
  two-boot determinism); T1 10/10 + batch 44/44 (terminal bytes sha256-identical incl.
  UTF-16 emoji/CJK batch offsets); T2 3 providers × (9/9 invariants + structural
  baseline); T3 118/126 e2e — **matching the original's exact pass/fail profile**
  (the 8 fails are EQUIVALENT: red on the pristine original too; listed in
  EQUIVALENCE-REPORT §T3).
- **Mutation validation**: 28/28 planted divergences caught + e2e RED→GREEN — proof
  the oracle bites. It must stay green forever.
- **Client matrix (prior host)**: Rust-WSL×Chrome 9/9 and Rust-Windows×Chrome 9/9,
  vision-verified (screenshots + JSON reports in `port/oracle/matrix/`).
- **Rust tests**: workspace (excl tauri) ~430 green; freshell-tauri 145 green.

### Bugs found + fixed during validation (each has a regression test)

| # | Bug | Commit |
|---|---|---|
| 1 | `terminal.output` missing `attachRequestId` → SPA rendered nothing (T3 caught it; T1 structurally could not) | phase 3.10 |
| 2 | DEV-0001 opencode cold-serve probe unbounded (ORIGINAL bug → fixed in port, pinned) | ledger |
| 3 | DEV-0002 session-indexer crash on late root (ORIGINAL bug → fixed in port, pinned) | ledger |
| 4 | DEV-0003 REJECTED — codex effort "clamp" was a false defect; port forwards verbatim | ledger |
| 5 | `/api/health` lacked the 7-field shape → Electron launcher refused the server | `494a7d14` |
| 6 | Bound 127.0.0.1 on WSL → invisible to Windows (original binds 0.0.0.0 on WSL) | `f82b8ce8` |
| 7 | Panic: byte-slice inside `→` in `strip_image_tags` → session indexer died on real transcripts | `486c4e64` |
| 8 | `terminal.create.mode` ignored → coding-CLI panes silently spawned bash | `8d2b1d21` |
| 9 | WSL-launched cmd/powershell fell to `C:\Windows` (UNC cwd + interop quote-mangling) | `4e148667` |
| 10 | Native-Windows CLI launch branch missing → CLI panes never painted on the Windows server | `49ef0f7c` |
| 11 | T2-opencode harness read-timing race | `093c1050` |
| 12 | ENV-0001: "original uppercases output" was a STALE BUILD of the original — clean rebuild fixed it; the T1 tests carry a self-extinguishing quarantine | DEVIATIONS.md |

### Ledger state (`port/oracle/DEVIATIONS.md`)

Adjudicated: DEV-0001/0002 accepted+pinned; DEV-0003 rejected; ENV-0001 resolved.
Open candidate deviations (in-code flags + `port/machine/architecture-spec.md`
§8.1/§6.5): CD-1…CD-8, candidate-dirs HOME fallback, the cmd ArgvQuote quoting gate,
window-state clamp, tray-status refresh, updater Disarmed surfacing, per-boot token,
unknown-mode fallback-vs-throw, and **CLI argv reduced fidelity** — the big one, with
a full implementation spec at `port/machine/specs/cli-argv-fidelity.md` (rev 2.1,
adversarially hardened twice; includes BLOCKER B1 requiring a live native-Windows
check).

---

## 5. Running the real systems (verbatim recipes — all hard-won)

Every recipe uses an ISOLATED scratch home **under `$HOME`, never under `/tmp`**
(codex refuses to create helper binaries under /tmp). Pattern:
`SCRATCH=$HOME/.freshell-qa-<name>-$RANDOM && mkdir -p $SCRATCH`. Clean it on exit.
Export once per session: `TOK=$(openssl rand -hex 32)`.

### 5.1 The ORIGINAL Node server (the reference — port 17871)

```bash
npm ci && npm run build        # once per checkout / after any dist wipe
PORT=17871 AUTH_TOKEN=$TOK FRESHELL_BIND_HOST=127.0.0.1 \
  HOME=$SCRATCH FRESHELL_HOME=$SCRATCH \
  NODE_ENV=production node dist/server/index.js
```

**ENV-0001 lesson:** if the original ever behaves absurdly (e.g. case-folded output),
suspect a STALE `dist/` first — `rm -rf dist/server && npm run build:server` — before
blaming anything. Never weaken an assertion to paper over it.

### 5.2 The Rust server on WSL (port 17872)

```bash
PORT=17872 AUTH_TOKEN=$TOK FRESHELL_BIND_HOST=127.0.0.1 \
  HOME=$SCRATCH2 FRESHELL_HOME=$SCRATCH2 \
  FRESHELL_CLIENT_DIR=$PWD/dist/client ./target/release/freshell-server
```

Health-gate both: `curl -s http://127.0.0.1:PORT/api/health` → `"app":"freshell"`.
Use `FRESHELL_BIND_HOST=0.0.0.0` only when a Windows-side client must reach it (it is
then visible on your LAN — token-gated, but keep such runs short).

### 5.3 The Rust server as a NATIVE WINDOWS process (port 17873)

WSL env does NOT propagate into a Windows .exe, and `%SystemRoot%\System32\cmd.exe`
cannot cd to a
`\\wsl.localhost\...` UNC path. The proven launch:

```bash
# Requires the shell-local WIN_* absolute paths from §3; never modify PATH.
# 1. SPA at a NATIVE Windows path (cmd cannot serve from a UNC path reliably):
WINTMP_W='C:\Users\<winuser>\AppData\Local\Temp'   # discover via: "$WIN_CMD" /c "echo %USERNAME%"
cp -r dist/client "$(wslpath -u "$WINTMP_W")/freshell-qa-winclient"
# 2. Launch with an absolute-path cmd set-wrapper (NO space before &&, or values get a trailing space):
"$WIN_CMD" /d /c "cd /d $WINTMP_W && set PORT=17873&& set AUTH_TOKEN=$TOK&& set FRESHELL_BIND_HOST=0.0.0.0&& set FRESHELL_CLIENT_DIR=$WINTMP_W\freshell-qa-winclient&& $(wslpath -w target/x86_64-pc-windows-gnu/release/freshell-server.exe)" &
# 3. Reach it from WSL at the WINDOWS HOST IP (NOT 127.0.0.1 — that relay is one-way):
WINIP=$(ip route show default | awk '{print $3}')
curl -s http://$WINIP:17873/api/health            # → "app":"freshell"
# 4. REAP (taskkill.exe and wmic are BROKEN over interop — use this):
"$WIN_NETSTAT" -ano | grep ':17873 '             # → PID column
"$WIN_POWERSHELL" -NoProfile -Command "Stop-Process -Id <pid> -Force"
```

Native Windows clients (Chrome/Electron/Tauri on the Windows side) reach it at
`localhost:17873` directly. Windows→WSL localhost forwards; WSL→Windows does not.

### 5.4 The Tauri app (needs WSLg / a display)

```bash
cargo build -p freshell-tauri
# app-bound (spawns its own server on an ephemeral port + generated token):
FRESHELL_HOME=$SCRATCH3 FRESHELL_SERVER_BIN=$PWD/target/release/freshell-server \
  ./target/debug/freshell-tauri
# remote mode (provisioning.rs — unit-tested, NEVER live-run yet; first live run is queue item):
FRESHELL_REMOTE_URL=http://$WINIP:17873 FRESHELL_TOKEN=$TOK ./target/debug/freshell-tauri
```

You cannot Playwright a WebKitGTK window. Drive state via a **mirror client** (a
Playwright Chromium attached to the SAME server+token — tabs/terminals mirror across
clients) or pre-create terminals before launching Tauri (inventory + tabs registry
restore on load). Screenshot the real window: `import -window root out.png`.
Known WSLg/WebKitGTK fallback if the window is blank: `WEBKIT_DISABLE_COMPOSITING_MODE=1`.

### 5.5 The Electron client — BUILT FROM SOURCE (no installed legacy on this host)

Electron ^33 is a devDependency, so the legacy desktop client is fully buildable:

- **Linux Electron under WSLg (primary path):** `npm run electron:dev` runs the full
  dev stack. For testing against YOUR servers instead, build once
  (`npm run build:electron && npm run build:wizard && npm run build:launch-chooser`),
  then launch `npx electron dist/electron/entry.js` with an isolated Electron config
  home and provision the remote via the launcher's own mechanism: either the
  provisioning env pair (`FRESHELL_REMOTE_URL=http://127.0.0.1:17872
  FRESHELL_TOKEN=$TOK`) or a one-time `desktop.provision` file in its config dir
  (`electron/desktop-provisioning.ts` parses `KEY=value` lines). The launcher's
  discovery probes `GET /api/health` and accepts only `app==="freshell" && ok===true`;
  its token validation is `GET /api/settings` with `x-auth-token` (2xx/3xx = ok).
  There is NO client↔server version gate — a version mismatch is display-only.
- **Native Windows Electron (secondary):** `electron:build:win` requires a native
  Windows node toolchain (`scripts/assert-native-windows-build.ts` enforces it).
  Probe for node on the Windows side; if absent, record the packaged-Windows-Electron
  leg ENV-LIMITED (the WSLg Electron leg still fully exercises the Electron client
  code against both servers — it is the same `electron/` TS either way).
- Screenshot Linux Electron via `import -window root`; a native-Windows Electron via
  the PowerShell `CopyFromScreen` pattern (§5.6).

### 5.6 Driving and screenshotting browser/desktop clients

- Open `http://<server>:<port>/?token=$TOK&e2e=1` — `?token=` authenticates
  (localStorage + cookie + WS hello) and `&e2e=1` installs
  `window.__FRESHELL_TEST_HARNESS__` with `getTerminalBuffer(id)`,
  `getWsReadyState()`, `getState()` (Redux). Wait for ws `'ready'` AND
  `connection.status==='ready'`.
- Pane creation: new tab via `[data-context="tab-add"]`; picker toolbar
  `getByRole('toolbar', {name:/pane type picker/i})`; kind buttons by aria-label —
  `CMD`, `PowerShell`, `WSL`, `Shell`, `Claude CLI`, `Codex CLI`, `OpenCode`,
  `Gemini`, `Kimi`, `Editor`, `Browser`. CLI kinds show a directory-confirm step
  before spawning. Read output ONLY via the harness buffer (not the DOM).
- Reusable harnesses: `port/oracle/matrix/run-matrix.mjs` (WSL leg) and
  `run-matrix-win.mjs` (Windows leg) — self-booting, self-reaping, write PNGs +
  `*-report.json`. Adapt; don't rewrite.
- Windows-desktop screenshots from WSL:
  `"$WIN_POWERSHELL" -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$b.Size); $bmp.Save('C:\\...\\shot.png')"`
  then `cp` it into the worktree.

---

## 6. The equivalence method (how "perfect" is defined and measured)

Perfect equivalence is proven **differentially, against real running systems** —
never by reading code and asserting similarity. The invariant method:

1. **Boot the ORIGINAL (17871) and the RUST port (17872/17873) side by side**, same
   token, isolated homes, identically seeded state where a test needs state.
2. **Drive both with byte-identical inputs** (same WS frames, same HTTP requests,
   same keystrokes via the same Playwright script).
3. **Compare outputs at the strictest sustainable level**:
   - *byte-identical* for terminal output and file bytes;
   - *normalized deep-equal* for JSON (normalize ONLY the declared-volatile fields:
     token, instanceId, startedAt, timestamps, version strings, ephemeral ports,
     absolute paths that legitimately differ per host — the normalization list is in
     `port/oracle/harness/normalize.ts` and may only GROW via adjudication, never
     silently);
   - *exact pass/fail profile match* for the e2e suite (the port must fail exactly
     where the original fails — no better, no worse, or the difference is adjudicated).
4. **Prove the comparator can fail**: the mutation suite plants divergences and must
   catch 100%. If you add a new comparison, add a mutation that proves it bites.
5. **Anything non-deterministic gets a determinism harness**, not a looser assertion
   (see T2's steady-state DB wait, commit `093c1050`).

### Tier commands (run all; T0/T1/batch/mutation are free and deterministic)

```bash
npx vitest run --config config/vitest/vitest.oracle.config.ts \
  test/unit/port/oracle/t0-equivalence-rust.test.ts \
  test/unit/port/oracle/t1-equivalence-rust.test.ts \
  test/unit/port/oracle/t1-batch-equivalence-rust.test.ts \
  test/unit/port/oracle/mutation-validation.test.ts \
  test/unit/port/oracle/mutation-e2e.test.ts
# T2 (LIVE — needs CLI credentials; ~1 cheap call per provider):
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npx vitest run \
  --config config/vitest/vitest.oracle.config.ts \
  test/unit/port/oracle/t2-opencode-equivalence-rust.test.ts \
  test/unit/port/oracle/t2-codex-equivalence-rust.test.ts \
  test/unit/port/oracle/t2-claude-equivalence-rust.test.ts
# T3 (full retained e2e vs an EXTERNAL server you boot):
FRESHELL_E2E_TARGET_URL=http://127.0.0.1:17872 FRESHELL_E2E_TARGET_TOKEN=$TOK \
  npx playwright test --config port/oracle/t3/playwright.target.config.ts
# Rust unit/golden suites:
cargo test --workspace --exclude freshell-tauri   # fast gate (tauri is slow; run it when touched)
cargo test -p freshell-tauri
```

---

## 7. FULL TEST COVERAGE REQUIRED FOR PERFECT EQUIVALENCE

This is the coverage contract. Each item names WHAT to exercise on BOTH systems and
the comparison level. Existing suites already cover much of it (§4) — your job is to
re-run those here, close the rest, and leave every line either GREEN, ADJUDICATED, or
ENV-LIMITED-with-proof. Nothing may be silently absent.

### A. Protocol / handshake (compare: normalized deep-equal)

1. Full connect sequence on both: `hello` → `ready` → `settings.updated` →
   `tabs.sync` → `terminal.inventory` — field-complete deep-equal after volatile
   normalization. (T0 does this; re-run.)
2. Schema conformance of every frame both directions against `shared/ws-protocol.ts`.
3. Two-boot determinism per system (same server twice → same normalized handshake).
4. Capability negotiation: client with and without `terminalOutputBatchV1` — batch
   frames only when negotiated; single-frame path byte-identical to the original.
5. Auth failures over WS: no token / bad token → identical close/error behavior.

### B. Terminal byte-fidelity + lifecycle (compare: BYTES, sha256)

1. Golden scenarios (echo, seq, fixed-width fill, multi-line) byte-identical over the
   wire. (T1: 10/10.) Batch tier: 44 goldens incl. emoji/CJK proving `endOffset` is
   UTF-16 code units. (Re-run both.)
2. Input round-trip: keystrokes → PTY → output, for EVERY shell kind (§E list).
3. `terminal.resize` → identical SIGWINCH-visible behavior (`stty size` output).
4. Kill/exit propagation: `terminal.kill`, natural exit (`exit\n`), and PTY-side death
   → identical exit frames and registry cleanup on both.
5. Reconnect/replay: disconnect mid-stream, reconnect with `lastSeq` → gap-free
   replay, byte-identical scrollback (ReplayRing vs original's ring).
6. Background persistence: client disconnects entirely; terminal keeps running;
   reattach shows accumulated output identically on both.
7. Multi-client mirroring: 2+ clients on one terminal — byte-consistent streams, both
   systems.
8. Flood: `seq 1 200000` (and a binary-ish `head -c 5M /dev/urandom | base64`) —
   order preserved, no gaps, comparable chunking semantics (batch barriers may differ
   in framing but reassembled BYTES must be identical).
9. Churn: rapid create/kill ×50 — registry consistent, zero orphan PTY processes on
   either system afterward (verify via process table).
10. Multibyte torture: emoji/CJK/combining chars + the `→`-heavy transcript class that
    produced bug #7 — no panics, identical bytes, session indexer stays alive.

### C. REST surface parity sweep (compare: status + body, normalized deep-equal; run
the SAME requests against 17871 and 17872/17873)

For EVERY endpoint: happy path, auth-missing (401 shape), auth-bad, and the endpoint's
documented error cases. The list (from `server/index.ts` routing):

1. `/api/health` (unauthenticated; 7 fields; `instanceId == ready.serverInstanceId`).
2. `/api/version`.
3. `/api/settings` GET/PUT — including the `settings.updated` WS broadcast on PUT,
   enum validation failures, and persistence across restart (config.json shape in the
   scratch home).
4. `/api/platform` (availableClis matches WSL `which` and absolute-path
   `"$WIN_WHERE"` truth; never rely on Windows PATH import).
5. `/api/extensions` (5-entry registry, exact ClientExtensionEntry shape).
6. `/api/files/*`: read/write/stat/complete/mkdir/candidate-dirs/validate-dir —
   incl. the `allowedFilePaths` sandbox, 404-vs-400 semantics, directory-vs-file
   errors, atomic-write behavior.
7. `/api/session-directory` — empty home, seeded fixtures (`test/fixtures/sessions/`),
   filters/cursor/revision fields.
8. `/api/network/status` — full NetworkStatus shape (live READ-ONLY netsh/ipconfig on
   Windows-reachable hosts; no mutation ever).
9. `/api/proxy/http/{port}/*` — X-Frame-Options/CSP stripped, content-type preserved,
   400 bad port / 502 dead port / 401 unauth, cookie-vs-header auth.
10. `/api/screenshots` POST — validation errors (400/409/422/503) + ok envelope +
    the `ui.command`/`ui.screenshot.result` WS round-trip.
11. SPA serving: `/` consumes `?token=`; real assets 200 with correct content-type;
    deep-link SPA-fallback; missing asset 404; `/ws` upgrade auth.

### D. Coding-CLI + fresh-agent (compare: invariants + structural baselines + argv bytes)

1. **T2 live matrix** (needs credentials): opencode/Kimi, codex/GPT-spark, claude/Haiku
   — one real turn each through the freshAgent WS surface on BOTH systems; 9/9
   invariants + structural deep-equal vs the frozen baselines in
   `port/oracle/baselines/t2/`. Determinism harness (steady-state waits), never
   loosened assertions.
2. **Argv fidelity** (`port/machine/specs/cli-argv-fidelity.md` rev 2.1 — the
   implementation spec; currently the port launches BASE commands only):
   implement, then verify with the spec's golden tests G-C1…G-K1 — and verify the
   goldens themselves against the REAL original by driving
   `resolveCodingCliCommand`/`buildSpawnSpec` in a Node script and diffing argv
   arrays against the Rust builders' output. Includes: MCP config injection (file
   content bytes, 0600 perms, tmp paths), notification args, opencode loopback
   control endpoint, resume/model/sandbox/permission args, env layering
   (`FRESHELL_*`, `CLAUDECODE` strip), the four `resolveCodingCliCommand` call sites,
   error-frame `code` pinning (`INVALID_MESSAGE`/`INTERNAL_ERROR`/`PTY_SPAWN_FAILED`),
   and the unknown-mode divergence (reference throws; port currently falls back —
   close or ledger it).
3. **BLOCKER B1 live check** (native Windows): a claude pane launched via the DEFAULT
   cmd branch must receive its `--settings` JSON intact through the
   portable-pty/ArgvQuote layer (hook fires / claude parses it) — or the deviation is
   adjudicated and CLI launches are re-routed with proof the alternative carries
   quote-bearing payloads intact. BOTH cmd and powershell branches need the
   quote-bearing check.
4. **CLI pane launch** (no live turn needed): each installed CLI paints its real
   interactive UI in a pane on both systems (steady-UI text asserted via the harness
   buffer, then screenshot). Codex's first screen in a fresh dir is its TRUST PROMPT;
   npm `.cmd`-shim CLIs cold-start slowly on Windows — allow 90s.

### E. The client × server matrix (compare: per-cell PASS parity with the original)

Servers: {ORIGINAL 17871, Rust-WSL 17872, Rust-Windows 17873}.
Clients: {Playwright Chromium; Tauri app-bound; Tauri remote; Electron-from-source
(WSLg); native-Windows Electron if a Windows node toolchain exists}.
Pane kinds per server platform: WSL/Linux server → CMD, PowerShell, WSL(bash), each
WSL-installed CLI, Editor, Browser; native-Windows server → CMD, PowerShell,
WSL(via wsl.exe — a branch ONLY reachable on a native-Windows server), each
Windows-installed CLI, Editor, Browser.

Per cell: create each pane kind in a NEW tab → run the marker command
(`echo freshell-matrix-OK`; `&& uname -a` on bash; `&& cd` on cmd) or wait for the
CLI steady UI → assert via harness buffer (incl. the WORKSPACE cwd visible in the
prompt — not `C:\Windows`) → screenshot → md5-distinct → **vision-verified** (§8.4).
**The equivalence bar: the Rust servers' per-cell results must MATCH the original
server's per-cell results** — run the same matrix against 17871 and diff the tables.
The prior host's reports (`port/oracle/matrix/*-report.json`) are your format
reference.

### F. Interchange + multi-client (compare: behavior parity)

1. One client switches 17872 ↔ 17873 with the SAME token — reconnects, tabs restore,
   no reconfiguration beyond the URL.
2. Chromium + Tauri attached to the SAME server simultaneously — tab created in one
   appears in the other; terminal output mirrors byte-consistently.
3. The original accepts the same interchange (sanity: this is original behavior too).

### G. Windows-specific coverage (this host CAN verify these)

1. ConPTY parity: all §B lifecycle items repeated against 17873 (native ConPTY).
2. The `wsl.exe --exec bash -l` branch (native-Windows server only): bash lands in the
   translated `/mnt/...` workspace cwd.
3. cwd translation both directions (`resolve_launch_cwd` goldens + LIVE prompts):
   `/mnt/c/...` → `C:\...` for Windows shells; `C:\...` → `/mnt/c/...` for WSL;
   UNC paths dropped (never passed to cmd.exe).
4. Interop quoting: the documented ArgvQuote gate — commands whose args carry spaces
   and quotes survive spawn on both systems (and B1, §D.3).
5. Env-wrapper correctness (§5.3) and absolute-path reap calls
   (`"$WIN_NETSTAT"` + `"$WIN_POWERSHELL"` `Stop-Process`).
6. Reachability matrix: Windows client→WSL server via localhost; WSL→Windows server
   via $WINIP; both directions token-gated.
7. Network status READS on Windows (`"$WIN_NETSH" ... show`,
   `"$WIN_IPCONFIG"`) — shape parity; **zero mutating netsh/elevated calls, ever**.

### H. Desktop-shell parity (Tauri vs the Electron reference behavior)

1. App-bound: spawn → health-gate → window loads SPA → close reaps the server
   (verify no orphan after window close, both normal close and SIGKILL of the shell).
2. Remote mode (`provisioning.rs` — FIRST LIVE RUN pending): env pair and
   `desktop.provision` file (one-time consume: file deleted after apply; values
   verbatim incl. `=` and quotes in tokens); window loads the REMOTE server's SPA.
3. Single-instance: second launch focuses the first (both shells).
4. Window-state: move/resize → restart → geometry restored; off-screen clamp.
5. Electron-parity behaviors on the SAME servers: launcher discovery accepts the Rust
   server (`app==="freshell"`), token validation via `/api/settings`, wizard/chooser
   render, `openExternal` link handling.
6. Tray/hotkey: register + translate accelerators (WSLg-verifiable part); display-only
   items (tray icon pixels, OS-level keypress capture) may be ENV-LIMITED with proof.

### I. Robustness / edge (parity of failure behavior — run on both systems)

1. Server restart with a live client: reconnect, tabs restore, terminals resume or
   report death identically.
2. Reconnect storm: 20 rapid WS reconnects — no leaked registrations, stable memory.
3. 3+ concurrent clients driving distinct terminals — no cross-talk.
4. Large scrollback attach (100k+ lines) — replay complete, UI attaches.
5. Session indexer over a large seeded home (incl. multibyte + malformed transcript
   fixtures) — identical session-directory output; no panics (bug #7 regression).
6. Kill -9 the server → clients show the same disconnect UX; no orphaned PTYs.
7. After EVERY run: ownership-based orphan sweep (`pgrep -x freshell-server`,
   `"$WIN_NETSTAT"` for 1787x listeners, PTY child processes) → zero owned leftovers.

---

## 8. FULL QA CRITERIA (what "done" means for any claim)

### 8.1 Pass definitions

- **Byte-level items** (§B, argv goldens, file bytes): sha256-equal. No tolerance.
- **JSON/protocol items** (§A, §C): deep-equal after the DECLARED normalization list
  only. Adding a normalized field = an adjudicated decision, logged in DEVIATIONS.md.
- **Suite-level items** (T3, matrix): pass/fail-profile match with the original run
  ON THIS HOST (not the prior host's numbers — re-baseline the original here first).
- **Visual items**: §8.4 vision protocol. A buffer assert alone NEVER proves a pane.

### 8.2 Evidence standard

Every claim in reports/commits carries either pasted command output or a committed
artifact path (screenshot, JSON report). "It works" without evidence is a defect of
the report. Understate rather than overstate; an honest ENV-LIMITED beats a fake PASS.

### 8.3 Regression gates (before EVERY commit)

```bash
git diff --name-only server/ shared/ src/    # MUST be empty — the purity invariant
cargo test --workspace --exclude freshell-tauri
# + the oracle tiers affected by your change; + rebuild BOTH server binaries if crates changed
```

### 8.4 Vision-review protocol (screenshots)

Every screenshot batch goes to a SKEPTICAL vision-capable reviewer (delegate with
`model_role:"vision"`): per image, PASS/WEAK/FAIL + what is concretely visible
(prompt path, banner text, rendered content); md5-distinctness across the batch;
explicit checks for blank panes, error toasts, auth modals, wrong cwd
(`C:\Windows` = the historical failure). WEAK = re-drive and re-capture (settle
waits), not re-classify. OCR (tesseract) is acceptable evidence when the model lacks
image input.

### 8.5 ENV-LIMITED protocol

A leg may be declared unverifiable ONLY with proof of the limitation (the failing
probe's output, e.g. `"$WIN_WHERE" opencode` → not found), recorded in the final report
AND in `port/machine/STATE.yaml`. Silent skips are defects. If provisioning could
remove the limitation cheaply (install a CLI, playwright browsers), provision instead.

### 8.6 Deviation governance

Fix bugs, never replicate; every original-vs-port difference → PORT_DEFECT (fix+test)
| DELIBERATE_FIX (ledger + ADVERSARIAL adjudication — spawn an independent reviewer;
never self-approve) | EQUIVALENT (prove red-on-original too). Never weaken an oracle
assertion to make something pass. The mutation suite must stay green — if you extend
the oracle, extend the mutations.

### 8.7 Sub-agent verification

Independently verify every sub-agent claim that matters: rebuild the binary yourself,
re-run the exact test, check md5s, cross-check applied edits against the FULL review
text (a truncated-context builder once silently dropped 6 of 11 review items —
caught only by cross-check).

### 8.8 Final report requirements

Update `port/oracle/EQUIVALENCE-REPORT.md` (tier counts on THIS host + the full
matrix table with screenshot paths), `port/machine/STATE.yaml`, and this handoff's §9
statuses. Enumerate: everything GREEN, every adjudicated deviation, every ENV-LIMITED
item with proof, and the remaining ceiling. A fresh reader must be able to reproduce
every result from committed files alone.

---

## 9. Work queue (priority order)

1. **Phase-0 probe + provisioning** (§3). Commit the probe record.
2. **Re-green the deterministic base on this host**: `npm ci`, `npm run build`, both
   Rust binaries, then T0 + T1 + batch + mutation + `cargo test --workspace
   --exclude freshell-tauri` + `cargo test -p freshell-tauri`. Any host-specific
   failure is a finding — root-cause it (ENV-0001 lesson: check for stale builds
   first).
3. **Re-baseline the ORIGINAL on this host**: boot 17871, run the T3 suite against it,
   store the pass/fail profile — this is your comparison target for everything.
4. **REST parity sweep** (§7.C) — original vs Rust, scripted, committed as a report.
5. **Matrix legs** (§7.E): Chromium × all three servers first (adapting
   `run-matrix*.mjs`), then **Tauri leg A** (app-bound × WSL server), then
   **Tauri leg B** (remote mode — FIRST LIVE RUN of `provisioning.rs`; suspects if it
   fails: URL join, webview nav timing, token quoting), then **Electron-from-source**
   × both Rust servers (§5.5). Vision-verify every batch (§8.4).
6. **CLI argv fidelity** (§7.D.2): implement per spec rev 2.1, golden-test, verify
   goldens against the live original, B1 live check on native Windows, one live turn
   per provider. Move the in-code REDUCED-FIDELITY flag to the ledger as resolved.
7. **Interchange + robustness** (§7.F, §7.I). DONE 2026-07-14 (reports under
   `port/oracle/{robustness,interchange}/`). Tracked remaining-work out of this item:
   **terminal-metadata push subsystem** (`terminal.meta.updated` / TerminalMetadataService) —
   documented gap DEV-0008, closes together with DEV-0006's coding-CLI
   sidecar-lifecycle scope (`port/machine/specs/coding-cli.md`).
8. **T2 live** on this host (needs credentials — if absent, escalate loudly as the
   one human dependency).
9. **Close-out** (§8.8): final reports, STATE.yaml, push.

## 10. Known traps (each cost real time once — do not rediscover)

1. WSL env does NOT reach Windows .exes → cmd `set` wrapper, NO space before `&&`.
2. `taskkill.exe`/`wmic.exe` are broken over interop → `"$WIN_NETSTAT" -ano` +
   `"$WIN_POWERSHELL" -NoProfile -Command "Stop-Process -Id <pid> -Force"`.
3. WSL→Windows-process is NOT localhost → use the Windows host IP
   (`ip route show default | awk '{print $3}'`).
4. Windows cmd cannot cd to `\\wsl.localhost\...` (UNC) → cwd translation /
   inherit-cwd. Invoke it as `"$WIN_CMD"`; never rely on PATH.
5. Codex refuses helper binaries under `/tmp` → scratch homes under `$HOME`.
6. Codex's first screen in a fresh dir is the TRUST PROMPT (contains no "codex" text).
7. npm `.cmd`-shim CLIs cold-start slowly on Windows → 90s launch windows.
8. Stale `dist/` of the ORIGINAL produces phantom divergences (ENV-0001) → clean
   rebuild before believing an "original is broken" result.
9. Stale Rust binaries produce phantom port failures → rebuild BOTH binaries after
   crate changes.
10. Buffer asserts pass while the pane is visually blank → vision-verify (§8.4).
11. Sub-agents with truncated context silently drop work items → cross-check (§8.7).
12. Windows-side sessions write CRLF → keep repo files LF.
13. Monaco loads from the jsdelivr CDN → editor tests need network; a cold headless
    load can be slow/flaky (retry mount) — identical on the original, not a port bug.
14. WebKitGTK on WSLg can render blank → `WEBKIT_DISABLE_COMPOSITING_MODE=1`.
15. The pane picker only shows CLI buttons when the SERVER detects the CLI on ITS
    PATH (`availableClis`) AND the provider is enabled in settings.

## 11. File index (the doc chain)

```
port/GOAL.md                          ← success criteria (the /goal; unchanged, still binding)
port/HANDOFF.md                       ← THIS file (v2, 2026-07-10; v1 deleted)
port/machine/STATE.yaml               ← resumable state + constraints (vm_only = SUPERSEDED)
port/machine/architecture-spec.md     ← ADR: crate map, CD-1..8, sidecar justification
port/machine/specs/*.md               ← ground-truth behavior specs (+ cli-argv-fidelity rev 2.1)
port/machine/BLOCKER-*.md, PLAN-*.md  ← historical VM-detour records (superseded; banners inside)
port/oracle/EQUIVALENCE-REPORT.md     ← tier-by-tier results + addendum
port/oracle/DEVIATIONS.md             ← the ledger (adversarial rulings; entry rules at top)
port/oracle/contract/                 ← frozen wire contract
port/oracle/baselines/                ← T0/T1/T2/T3 + batch goldens
port/oracle/harness/                  ← normalize/capture/live harnesses
port/oracle/matrix/                   ← matrix harnesses + screenshots + JSON reports
port/oracle/t3/playwright.target.config.ts + run-against-rust.md
port/vm-bridge/                       ← DORMANT break-glass bridge (do not start; see README)
config/vitest/vitest.oracle.config.ts ← oracle test runner config
test/unit/port/oracle/                ← the oracle suites (T0/T1/batch/T2/mutation)
test/e2e-browser/                     ← the retained e2e suite (T3 drives it externally)
crates/                               ← the port (§2 crate map)
.cargo/config.toml                    ← Windows cross-compile linker wiring
```

**Final word:** the bar is `port/GOAL.md`, the method is §6, the coverage contract is
§7, and the honesty rules are §8. Run real systems, compare them, fix what differs,
prove the comparator bites, and never end a turn without the next action in flight.
