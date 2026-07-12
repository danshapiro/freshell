# Desktop-shell matrix legs — Tauri A (app-bound) + Tauri B (remote) — §7.E/§7.H

**Host:** SurfaceBookPro9 (WSL2/WSLg), 2026-07-11. Companion to
`parity-chromium-2026-07-11.md` (Chromium × all three servers, committed e19dfead).
Harness: `run-matrix-mirror.mjs` (Playwright mirror client attached to the SAME
server+token the desktop shell is attached to; assertions identical to
`run-matrix-generic.mjs`). Desktop window driven natively via xdotool (WSLg X11,
`GDK_BACKEND=x11`), captured via `import -window <id>`. Vision review:
`vision-review-tauri-2026-07-11.md`.

## Tauri leg A — app-bound × Rust server (WSL)

Launch: `FRESHELL_HOME=<scratch> FRESHELL_SERVER_BIN=target/release/freshell-server
target/debug/freshell-tauri` (WSLg, `WEBKIT_DISABLE_COMPOSITING_MODE=1`).

- **Spawn→health→window: PASS.** Log: `spawning app-bound server … on 127.0.0.1:<ephemeral>`
  → `server healthy` → `main window loading …?token=<redacted>` (token redacted by the app).
- **Ready UI: PASS.** First-run Network wizard rendered in the Tauri webview
  (`sbp9-tauriA-wizard.png`); dismissed natively via xdotool click → main UI with full
  pane picker (`sbp9-tauriA-wizard-dismissed.png`, vision PASS).
- **Native in-window pane: PASS.** WSL pane created by clicking the picker IN the Tauri
  window; typed `echo freshell-matrix-OK && pwd && uname -a` natively; output rendered
  in-window (`sbp9-tauriA-tauriwin-wsl.png`, vision PASS: marker + uname + prompt).
- **8-kind matrix on the app-bound server (mirror client): 8/8 PASS**
  (`sbp9-tauriA-report.json`): cmd/powershell/wsl land in the `/mnt/c/Users/Public/...`
  workspace (cmd NOT in `C:\Windows` — DEV-0005 port fix live in the app-bound spawn
  path), editor Monaco mounts, browser renders example.com, claude/codex/opencode steady
  UIs paint. Buffer-level asserts identical to the Chromium legs.
  NOTE: per-kind DESKTOP-window screenshots were md5-duplicates (the desktop client's
  active tab does not follow tabs created by a second client — same SPA behavior as the
  original, client-side code is byte-identical) and were therefore deleted as
  non-evidence; the per-kind evidence for this cell is the mirror report + the native
  in-window WSL drive above. (Whether the ORIGINAL live-mirrors tab creation to other
  clients is a §7.F task-007 differential item.)
- **Reap on graceful exit: PASS (live).** `FRESHELL_TAURI_SMOKE_EXIT_MS=12000` run:
  `smoke exit after 12000ms` → `server reaped (SIGTERM)` → zero freshell processes left.
- **Single-instance: PASS.** Second launch (same config dir) exited immediately (code 0)
  while first instance + its single server kept running (process table: 1 tauri, 1 server).
- **Window-state:** resize 1200x800→900x650 applied live (xdotool). Restore-across-restart
  NOT verified live this session (window close crashed — see caveat) — remains covered by
  the crate's unit tests; live restart-restore owed in task-007 leftovers.
- **CAVEAT (environment):** `xdotool windowclose` under WSLg/X11 killed the shell via a
  GDK `BadDrawable` X error (abort ≈ SIGKILL) → no RunEvent::Exit → the app-bound server
  survived and was swept manually. This is a WSLg/GDK-x11 artifact of the synthetic close,
  not the port's close path (the reap path is proven by the smoke run above + unit suite).
  Orphan-after-SIGKILL parity vs Electron reference: to be compared in the Electron leg.

## Tauri leg B — remote mode (provisioning.rs FIRST LIVE RUN)

Rust server booted on **17874** (WSL, scratch home, session token).

- **Env pair (`FRESHELL_REMOTE_URL` + `FRESHELL_TOKEN`): PASS.** Log:
  `remote mode — connecting to 127.0.0.1:17874 (no app-bound spawn)` → `remote server
  healthy` → window loads the REMOTE SPA (`sbp9-tauriB-envpair-initial.png`, wizard
  renders = authenticated SPA loaded). No URL-join/nav-timing/token-quoting defects —
  provisioning.rs worked first try.
- **Remote pane through the window: PASS.** WSL pane created natively in the Tauri
  window spawned `/bin/bash -l` as a child of the 17874 server (verified in the process
  table) and rendered its full output in-window (`sbp9-tauriB-envpair-wsl.png`, vision
  PASS). xdotool keyboard input flaked in this leg (Weston focus; input round-trip
  through the Tauri webview already proven in leg A — identical client code).
- **Mirror sanity on 17874:** cmd+wsl 2/2 PASS (`sbp9-tauriB-report.json`).
- **`desktop.provision` file: PASS.** File with `FRESHELL_REMOTE_URL=…` +
  `FRESHELL_TOKEN=…` in `<FRESHELL_HOME>/.freshell/`: consumed (DELETED after apply),
  `desktop.json` = `{serverMode:"remote", remoteUrl:"http://127.0.0.1:17874",
  remoteToken:<verbatim>, setupCompleted:true}`, window loaded the remote SPA
  (`sbp9-tauriB-provisionfile.png`).

## PORT DEFECT found — **FIXED** (task-005c)

**Resolution (task-005c commit):** full `/api/terminals` port landed —
`crates/freshell-server/src/terminals.rs` (GET directory incl. override merge /
deleted filter / lastLine algorithm / sort + the paged read-model branch with
exact zod-v4 issue objects and keyset cursor; PATCH `/:id` with cleanString +
JS-spread override merge + registry write-through + `terminals.changed`
broadcast + express strict-JSON 400-HTML parity; DELETE `/:id` → `{ok:true}`),
`registry.rs` meta fields (`set_meta`/`update_title`/`update_description`/
`directory()`), `settings_store.rs` persisted `terminalOverrides`. Verified by
the extended REST differential sweep vs the live original: **151/151 PASS**
(30 new /api/terminals cases incl. live WS-created terminals on both servers),
oracle T0/T1/batch/mutation green, cargo workspace green. The
viewport/scrollback/search read-model subroutes remain deliberately unported —
council-adjudicated **PORT-GAP-002** (ACCEPT-WITH-CONDITIONS), pinned to clean
JSON 404 by sweep case `terminals.subroutes.rust-interim-404-pin`; see
`port/oracle/EQUIVALENCE-REPORT.md` §8/§10.

### Original defect record (historical)

**`GET /api/terminals` on the Rust server is a stub returning `[]` always**
(`crates/freshell-server/src/boot.rs:158-166`), while the ORIGINAL returns the live
terminal directory (`server/index.ts:625` → `server/terminals-router.ts` →
`terminalViewService.listTerminalDirectory()`): items
`{terminalId,title,description,mode,sessionRef?,codexDurability?,createdAt,
lastActivityAt,status,hasClients,cwd?,lastLine,last_line}` with title/description
overrides from config `terminalOverrides` (deleted filtered out), sorted by
`lastActivityAt` desc then `terminalId` desc. The SPA consumes it in OverviewView,
EditorPane, ContextMenuProvider; PATCH/DELETE `/api/terminals/:id` and
viewport/scrollback/search subroutes are ALSO absent in the port. Discovered because the
mirror harness's kill helper got `[]` from the Rust server while live PTYs existed
(original-vs-port divergence; not covered by the §7.C sweep list, which omits
/api/terminals). **Status: PORT_DEFECT → implement directory GET (+ assess PATCH/DELETE
/subroutes) with regression tests, rebuild both binaries, re-run oracle + REST sweep.**

## Electron legs (task-005d) — Electron-from-source (WSLg) × both Rust servers — §7.E/§7.H

Build once: `build:electron` + `build:wizard` + `build:launch-chooser`; entry is
`dist/electron/electron/entry.js` (package.json `main`). Launched with an ISOLATED
config home (`HOME`/`XDG_CONFIG_HOME` → scratch; configDir = `$HOME/.freshell`).
NOTE: the `FRESHELL_REMOTE_URL`/`FRESHELL_TOKEN` **env pair is a Tauri-only
mechanism** — `electron/` never reads them from `process.env` (verified by grep);
Electron's own provisioning mechanism is the one-time `desktop.provision` file
(`electron/desktop-provisioning.ts`), which is what both legs used.

### Electron leg 1 — × Rust server (WSL, 17872)

- **Provisioning file: PASS.** `desktop.provision` (`FRESHELL_REMOTE_URL=http://127.0.0.1:17872`
  + `FRESHELL_TOKEN`) consumed (DELETED after apply → `desktop.json`), window loaded the
  REMOTE SPA: first-run Remote Access wizard rendered = authenticated SPA
  (`sbp9-elwsl-initial.png`, vision PASS); dismissed natively via xdotool click
  ("No, just this computer").
- **8-kind matrix on 17872 (mirror client): 8/8 PASS** (`sbp9-elwsl-report.json`) —
  cmd/powershell/wsl land in the `/mnt/c/Users/Public/...` workspace, editor Monaco
  mounts, browser renders example.com, claude/codex/opencode steady UIs paint.
  Assertions identical to the Chromium/Tauri legs. Per-kind DESKTOP-window screenshots
  were md5-duplicates (desktop client's active tab does not follow tabs created by a
  second client — same behavior as the Tauri legs; SPA byte-identical) → deleted as
  non-evidence, exactly as in the Tauri legs.
- **Native in-window pane: PASS.** WSL pane created by clicking the picker IN the
  Electron window. xdotool keyboard input flaked (Weston focus — same artifact as
  Tauri leg B; click input path proven by the modal + picker clicks), so the marker
  line was driven via WS `terminal.input` to the SAME terminal id; the Electron window
  rendered the live PTY output: `freshell-matrix-OK` + `pwd` + full `uname -a`
  (`sbp9-elwsl-elwin-wsl.png`, vision PASS).
- **kill -9 (remote mode): PASS.** SIGKILL of the Electron main process → ALL electron
  processes exited, zero orphans; the external server was (correctly) untouched.

### Electron leg 2 — × Rust server (NATIVE WINDOWS, 17873)

Server per §5.3 (`FRESHELL_BIND_HOST=0.0.0.0`, reached at `http://$WINIP:17873`).

- **Provisioning file: PASS.** Fresh config home; provision file consumed; window
  loaded the remote SPA served by the native-Windows rust server (Remote Access modal
  = authenticated SPA; `sbp9-elwin-initial.png`, vision PASS); dismissed natively.
  Observed: picker grid omits OpenCode (Windows `availableClis` — opencode absent on
  the Windows side, host-legit).
- **Native in-window pane: PASS.** CMD pane created by clicking the picker in the
  Electron window (ConPTY spawn on the Windows side); marker via WS input; window
  rendered `echo freshell-matrix-OK && ver` → `freshell-matrix-OK` +
  `Microsoft Windows [Version 10.0.26200.8655]` (`sbp9-elwin-elwin-cmd.png`, vision PASS).

### App-bound Electron (kill -9 orphan comparison owed from Tauri leg A caveat)

**ENV-LIMITED (live run), with proof — architectural comparison recorded.**
From-source Electron cannot run app-bound on this host:

- production spawn mode requires a PACKAGED install (`startup.ts` needs
  `resourcesPath/bundled-node/bin/node` + `resources/server/index.js`); observed:
  `Error: Server process exited before health check succeeded`.
- dev spawn mode resolves `server/index.ts` relative to the config dir; observed:
  `ERR_MODULE_NOT_FOUND … url: file://<configDir>/.freshell/server/index.ts`.

Architectural parity: `electron/server-spawner.ts` spawns the server with
`detached: false` and NO parent-death watchdog → SIGKILL of the Electron shell
orphans the server child by POSIX semantics — the SAME orphan class observed for
the Tauri app-bound server after the synthetic WSLg SIGKILL (leg A caveat). Both
shells reap the server on the GRACEFUL exit path (Tauri: live smoke-exit reap
proven; Electron: `stop()` path unit-covered). No parity defect.

### Native-Windows Electron (`electron:build:win`) — deep probe

**ENV-LIMITED, with proof.** `scripts/assert-native-windows-build.ts` requires
native win32 (node-pty must compile for win32). Windows side has node v22.5.1 +
npm 10.8.2 (`C:\Program Files\nodejs`) and Python 3.11/3.12, **but no MSVC
toolchain**: `where.exe cl` → not found; `vswhere.exe` ABSENT; no
`Microsoft Visual Studio` directory under either Program Files root → `node-gyp`
cannot build node-pty; installing VS Build Tools requires elevation (blocked on
this host). Additionally the repo lives on the WSL filesystem and `cmd.exe` cannot
cd to `\\wsl.localhost` UNC paths, so the required Windows-side `npm install`
would first need a full native-path repo copy. The WSLg Electron legs above fully
exercise the same `electron/` TypeScript against both Rust servers.
