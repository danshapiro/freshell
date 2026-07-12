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

## PORT DEFECT found (open — fix before task-005 close)

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
