# Electron Desktop Shell → Tauri — Ground-Truth Behavioral Spec + Mapping

**Scope:** the Electron main-process shell in `electron/**` that wraps the retained React SPA and the
`freshell-server` process. This is the surface a Rust **Tauri** app + `tauri-plugin-*` must reproduce so
the desktop experience (boot modes, tray, hotkey, updater, window-state, single-instance, close-to-tray,
crash recovery, setup wizard, launch chooser) is behaviorally equivalent.

**Source of truth = the CODE**, not docs. Every claim cites `file:line` in `.worktrees/rust-tauri-port`.
Where the code has a latent bug/gap the port should *fix, not replicate*, it is flagged **[DEFECT]**
(candidate deviation-ledger entry). Where a feature has no clean Tauri equivalent it is **[PORT RISK]**.

**The port's shape (from `port/machine/architecture-spec.md:9-19`):**
```
Tauri shell (Rust core) ──spawns/embeds──▶ freshell-server (single Rust binary)
   │  webview (WRY: WebKitGTK/WebView2/WKWebView)
   └─ React/TS SPA (UNCHANGED) ──WS/HTTP──▶ server (loopback or remote)
```
The single Rust `freshell-server` binary **replaces** the Electron model of *bundled-Node + recompiled
node-pty in extraResources* (see §5). The frontend is retained verbatim; only the `electron/preload.ts`
IPC bridge becomes Tauri commands (see §2, §7).

**Primary files**
- `electron/entry.ts` (686 ln) — the only file importing real `electron`; DI wiring, IPC handler registration, window/tray/crash-recovery construction, `main()` re-entrancy.
- `electron/startup.ts` (381 ln) — `runStartup()` decides wizard / chooser / main; server-mode dispatch; `loadMainWindow`.
- `electron/main.ts` (75 ln) — `initMainProcess()`: single-instance lock, close-to-tray, before-quit, activate, second-instance.
- `electron/server-spawner.ts` (199 ln) — spawns the bundled-Node server, health-poll, SIGTERM→SIGKILL stop.
- `electron/preload.ts` (83 ln) — `contextBridge` surface `window.freshellDesktop` (the exact command set to port).
- `electron/daemon/**` — launchd / systemd / windows-service managers + `installers/*.template`.
- `electron/{tray,hotkey,updater,window-state,renderer-recovery,external-url,menu,icon-path}.ts` — desktop features.
- `electron/{launch-policy,launch-discovery,launch-options,launch-choice-handler,token-resolver,port-check,desktop-config,desktop-provisioning}.ts` — launch decision + config.
- `electron/setup-wizard/**`, `electron/launch-chooser/**` — the two auxiliary renderer windows.
- `config/electron-builder.yml`, `assets/electron/installer.nsh`, `package.json` — packaging.

---

## 0. Boot & process model — the big picture

`package.json:9` sets `main: dist/electron/electron/entry.js`. Electron runs `entry.ts`'s `main()`
(`entry.ts:686 void main()`). `main()` is **re-entrant**: it re-runs itself after the wizard closes
(`entry.ts:571-577`) and after a launch-chooser selection (`entry.ts:543-554`). A module-level
`wizardPhase` flag (`entry.ts:227`) keeps the app alive across those transitions by suppressing
`window-all-closed` quit (`entry.ts:251-258`) and `will-quit` (`entry.ts:679-683`).

```
app.whenReady (entry.ts:239)
   └─ applyProvisioningFile  (entry.ts:263  — consume ~/.freshell/desktop.provision once)
   └─ read desktop.json / defaults  (entry.ts:281; port default 3001 :282)
   └─ build DI: daemonManager, serverSpawner, hotkeyManager, windowState, updateManager (entry.ts:286-316)
   └─ register IPC handlers (complete-setup, get-launch-options, choose-launch-option, open-external-url …)
   └─ runStartup(ctx)  (entry.ts:558 → startup.ts:300)
        ├─ result 'wizard'  → createWizardWindow, on close → main() again  (entry.ts:560-579)
        ├─ result 'chooser' → new 760×720 BrowserWindow, load launch-chooser (entry.ts:581-610)
        └─ result 'main'    → register main-window IPC, buildAppMenu, initMainProcess (entry.ts:612-672)
```

`runStartup` (`startup.ts:300-381`) is the **mode-selection brain** and is pure/DI-tested (no `electron`
import). Its decision order:

1. `!setupCompleted` → `{type:'wizard'}` (`startup.ts:303-305`).
2. `forcedLaunch` present (a chooser selection being honored) → `executeForcedLaunch` (`startup.ts:307-309, 286-298`).
3. Otherwise: discover local servers + probe saved remote, then `chooseLaunchAction()` (`startup.ts:311-324` → `launch-policy.ts:26-80`) yields `show-setup | show-chooser | auto-connect | start-local`.
4. `start-local`/mode dispatch → `daemon` / `app-bound` / `remote` (`startup.ts:344-370`).
5. `loadMainWindow()` builds the real window and loads `serverUrl[?token=…]` (`startup.ts:134-245`).

---

## 1. Boot / mode selection (detail + evidence)

### 1.1 Three server modes (`DesktopConfig.serverMode`, `types.ts:10`)

| Mode | Meaning | Server obtained by | Evidence |
|---|---|---|---|
| `app-bound` | server lives & dies with the app | `serverSpawner.start(...)` spawns bundled-Node | `startup.ts:356-358` → `startAppBoundServer` `247-279` |
| `daemon` | server is an OS service (survives app) | `daemonManager.status()`; if not running, `.start()` | `startup.ts:345-355` |
| `remote` | connect to another machine | use `desktopConfig.remoteUrl` + `remoteToken` | `startup.ts:360-366, 374-375` |

Default config (`desktop-config.ts:16-27`): `serverMode:'app-bound'`, `port:3001`,
`globalHotkey:'CommandOrControl+\`'`, `startOnLogin:false`, `minimizeToTray:true`, `setupCompleted:false`.
Config is `~/.freshell/desktop.json` (`desktop-config.ts:8-9`), written atomically via tmp+rename
(`desktop-config.ts:44-52`) under a promise-chain mutex (`desktop-config.ts:57-75`). Schema =
`DesktopConfigSchema` (`types.ts:9-27`).

### 1.2 Local-server discovery + launch policy

- **Probe URLs** (`launch-discovery.ts:31-52`): `localhost:{config.port}`, `localhost:3001`, then a
  scan of `localhost:3001..3010`, then every `knownServers[].url`; loopback-only filter.
- **Discovery** (`launch-discovery.ts:66-96`): `GET {url}/api/health`; a candidate counts only if
  `health.app==='freshell' && health.ok===true`; `requiresAuth` defaults to `true` when absent (`:87`).
- **Policy** (`launch-policy.ts:26-80`): `!setupCompleted`→setup; `alwaysAskOnLaunch`→chooser
  (`reason:'always-ask'`); remote reachable+token→auto-connect, else chooser with a specific reason
  (`missing-token` / `saved-remote-token-invalid` / `saved-remote-unreachable`); `candidates.length>1`
  →chooser (`multiple-candidates`); exactly one → auto-connect (or `missing-token`); else
  `app-bound|daemon`→`start-local`; else chooser (`manual-choice`).
- **Token resolution for a candidate** (`token-resolver.ts:52-75`): matching saved remoteToken → else
  loopback reads `~/.freshell/.env` `AUTH_TOKEN=` → else `~/.freshell/config.json` `authToken|token`.

### 1.3 The main window load (`loadMainWindow`, `startup.ts:134-245`)

- Window bounds come from persisted `windowState` (`startup.ts:139-150`; defaults 1200×800,
  `window-state.ts:19-23`). `show()` immediately, `maximize()` if persisted (`startup.ts:156-160`).
- **Auth token is passed in the URL**: `loadUrl = token ? \`${serverUrl}?token=${encodeURIComponent(token)}\` : serverUrl` (`startup.ts:155`). The SPA reads it back from `URLSearchParams`. **[PORT RISK: security]** the token appears in the loaded URL; the Tauri webview must load the same `?token=` URL for the SPA's existing auth path to work unchanged.
- Registers window `resize`/`move` → debounced (500 ms) `windowState.save` (`startup.ts:183-202`).
- Registers the **global hotkey** to toggle window visibility (`startup.ts:204-211`).
- Creates the **tray** (best-effort; failure is non-fatal, `startup.ts:213-217`).
- Schedules the **first update check** at **10 s** after load (`startup.ts:219-221`).
- Wires **renderer crash recovery** (`startup.ts:223-242` → §3.7).

### 1.4 Server spawn (`server-spawner.ts`) — becomes "spawn the Rust binary"

`createServerSpawner()` (`server-spawner.ts:38-198`):
- **production** (`:100-108`): `cmd = {resourcesPath}/bundled-node/bin/node[.exe]`, `args=[server/index.js]`, `NODE_ENV=production`, `NODE_PATH = nativeModulesDir : serverNodeModulesDir` (native node-pty wins) — see `startup.ts:266-277`.
- **dev** (`:109-114`): `npx tsx server/index.ts`; returns `http://localhost:5173` (Vite) (`startup.ts:259`).
- Spawns with `cwd=configDir`, stdout/stderr piped to `~/.freshell/logs/server.log` (`server-spawner.ts:124-149`).
- **Health-gate**: `pollHealthCheck` polls `GET localhost:{port}/api/health` with exponential backoff (100 ms→5 s cap), fails fast if the child exits, overall timeout 30 s (`server-spawner.ts:46-81`).
- `stop()`: SIGTERM, then SIGKILL after 5 s (`server-spawner.ts:154-189`).
- `isRunning()`/`pid()` feed tray + `get-server-status` (`server-spawner.ts:191-197`).

**Port change:** in Tauri this becomes "spawn one Rust `freshell-server` binary on `PORT` and health-poll
`/api/health`." No `NODE_PATH`, no bundled-node, no native-module dir. The health-poll + SIGTERM→SIGKILL
lifecycle is preserved 1:1 in Rust (`tokio::process` + a poll loop). `app-bound` mode maps to a child
process owned by the Tauri core; `daemon` mode maps to an OS service (see §3.9).

---

## 2. `preload.ts` IPC surface — the exact command set to port

`registerPreloadApi` exposes `window.freshellDesktop` via `contextBridge.exposeInMainWorld('freshellDesktop', api)`
(`preload.ts:52-71`). **Every channel below must become a Tauri command (or event).** Handlers live in
`entry.ts` unless noted.

| # | `freshellDesktop.*` | Preload → IPC | Args | Returns | Main-process handler | Consumed by |
|---|---|---|---|---|---|---|
| 1 | `platform` | (static `process.platform`) | — | `string` | n/a (`preload.ts:57`) | *(unused by SPA — see §7)* |
| 2 | `isElectron` | (static `true`) | — | `boolean` | n/a (`preload.ts:58`) | **SPA** `useElectronExternalLinks.ts:17-18` |
| 3 | `getServerMode()` | invoke `get-server-mode` | — | `Promise<string>` | `entry.ts:613` | *(unused by SPA)* |
| 4 | `getServerStatus()` | invoke `get-server-status` | — | `Promise<{running,mode}>` | `entry.ts:615-618` | *(unused by SPA)*; tray uses internal path |
| 5 | `setGlobalHotkey(acc)` | invoke `set-global-hotkey` | `accelerator:string` | `Promise<boolean>` | `entry.ts:620-633` (re-registers + rebinds toggle) | *(unused by SPA)* |
| 6 | `onUpdateAvailable(cb)` | on `update-available` | `callback` | `void` | emitter `update-available` (`updater.ts:28-30`) | *(unused by SPA)* |
| 7 | `onUpdateDownloaded(cb)` | on `update-downloaded` | `callback` | `void` | emitter `update-downloaded` (`updater.ts:32-34`) | *(unused by SPA)* |
| 8 | `installUpdate()` | invoke `install-update` | — | `Promise<void>` | `entry.ts:635-637` → `quitAndInstall` | *(unused by SPA)* |
| 9 | `completeSetup(cfg)` | invoke `complete-setup` | `WizardSetupConfig` (`preload.ts:6-12`) | `Promise<void>` | `entry.ts:513-528` → `patchDesktopConfig` | **Wizard** `setup-wizard/main.tsx:19` |
| 10 | `getLaunchOptions()` | invoke `get-launch-options` | — | `Promise<LaunchOptionsResponse>` | `entry.ts:530-532` → `buildLaunchOptions` (`launch-options.ts:16-27`) | **Chooser** `chooser.tsx:39` |
| 11 | `chooseLaunchOption(choice)` | invoke `choose-launch-option` | `LaunchChoice` (`preload.ts:14-22`) | `Promise<LaunchChoiceResult>` | `entry.ts:534-555` → `launch-choice-handler.ts:30-135` | **Chooser** `chooser.tsx:50` |
| 12 | `openExternal(url)` | invoke `open-external-url` | `url:string` | `Promise<void>` | `external-url.ts:33-43` (registered `entry.ts:487-509`) | **SPA** `src/lib/open-url.ts:34-38` |

**Security scoping the port must preserve** (`entry.ts` gates two channels by *sender identity*, since
preload exposes them to every window):
- `open-external-url` (#12): `isAllowedSender` requires `sender.id === mainWebContentsId` **and** the
  frame origin === the main server origin (`entry.ts:490-509`). Only canonical absolute `http/https`,
  no control chars, no embedded credentials (`external-url.ts:6-20`).
- `choose-launch-option` (#11): `isAllowedSender` requires `sender.id === chooserWebContentsId`
  (`entry.ts:538-541`); payload is re-validated with `LaunchChoiceSchema.safeParse` (`launch-choice-handler.ts:38-42`).

→ In Tauri this becomes **per-window capabilities**: the `open-external-url` command allowed only for the
main window at the expected origin; `choose-launch-option`/`get-launch-options` allowed only for the
chooser window; `complete-setup` only for the wizard window. See §6 + §9-Risk-3.

---

## 3. Desktop features — behavior & triggers

### 3.1 System tray (`tray.ts`, constructed `entry.ts:403-451`)
- Icon resolved per platform (`icon-path.ts:12-35`): `tray-icon-win.ico` on win32 else `tray-icon.png`;
  dev path `assets/electron/…`, packaged `{resourcesPath}/assets/…`.
- Tooltip `"Freshell"` (`tray.ts:38`). Context menu (`tray.ts:43-52`): **Show/Hide**, separator,
  `Server: Running|Stopped` (disabled), `Mode: {mode}` (disabled), separator, **Settings**,
  **Check for Updates**, **Quit**.
- Callbacks (`entry.ts:415-449`): Show→first window `.show()+.focus()`; Hide→`.hide()`;
  Settings→show+focus; CheckUpdates→`updateManager.checkForUpdates()`; Quit→`app.quit()`;
  `getServerStatus`→`{running:serverSpawner.isRunning(), mode}`.
- **[DEFECT]** the menu is built **once** (`tray.ts:59 void buildMenu()`); the `Server: Running/Stopped`
  line never refreshes after boot. Port should rebuild on status change.

### 3.2 Global hotkey (`hotkey.ts`)
- `createHotkeyManager(globalShortcut)` (`hotkey.ts:20-56`): `register/unregister/update/current`; wraps
  Electron `globalShortcut.register/unregister`.
- Default accelerator `CommandOrControl+\`` (`types.ts:16`). Bound at window load to toggle
  show/hide/focus (`startup.ts:204-211`); re-bound live by `set-global-hotkey` (`entry.ts:620-633`);
  unregistered on server stop (`entry.ts:667`).
- Accelerator strings are **Electron format** (`CommandOrControl+\``). Tauri global-shortcut uses a
  different string grammar → **needs an accelerator translator** (see §6).

### 3.3 Auto-updater (`updater.ts`; wired `entry.ts:294-316`)
- Real impl only when packaged: dynamic `import('electron-updater')` → `createUpdateManager(autoUpdater)`
  (`entry.ts:304-306`). Dev / missing package → **no-op stub** (`entry.ts:294-315`).
- `createUpdateManager` (`updater.ts:24-57`) forwards `update-available` / `update-downloaded` / `error`
  to an `EventEmitter`; exposes `checkForUpdates`, `downloadUpdate`, `installAndRestart`(=`quitAndInstall`).
- Triggers: first check 10 s after main window load (`startup.ts:219-221`); manual via tray / Help menu.
- **[PORT RISK — see §9-Risk-2]** electron-updater's feed/format (`latest.yml`, blockmap deltas, NSIS
  one-click) is entirely different from `tauri-plugin-updater` (signed `latest.json` + `.sig`, full-bundle
  replacement, mandatory Ed25519 signature). The update pipeline is a rebuild, not a swap.

### 3.4 Window-state persistence (`window-state.ts`)
- `load()`/`save()` read/write `desktop.json.windowState {x,y,width,height,maximized}`
  (`window-state.ts:25-44`; schema `types.ts:20-26`). Defaults 1200×800, not maximized.
- Save is debounced 500 ms on `resize`/`move` (`startup.ts:183-202`).

### 3.5 Single-instance lock (`main.ts:24-28`)
- `app.requestSingleInstanceLock()`; if not acquired → `app.quit()` and bail. Second launch fires
  `second-instance` on the primary → restore + focus the main window (`main.ts:63-70`).

### 3.6 Close-to-tray (`main.ts:40-47`)
- When `minimizeToTray` (default true), intercept window `close`: `preventDefault()` + `hide()` unless
  `isQuitting`. `before-quit` sets `isQuitting=true` and stops the server (`main.ts:50-53`). macOS
  `activate` re-shows (`main.ts:56-60`).

### 3.7 Renderer crash recovery (`renderer-recovery.ts` 331 ln + `entry.ts:53-224`) — **the hard one**
Two cooperating layers:
1. **Reload/recover state machine** (`renderer-recovery.ts:61-330`), wired only when a logger + webContents
   exist (`startup.ts:223-242`). It listens on `webContents`:
   - `render-process-gone` → recover mode `reload` (`:247-265`).
   - `did-fail-load` → recover mode `load-url`, but only main-frame and not `ABORTED (-3)` (`:267-301`).
   - `unresponsive` → after a **15 s** threshold, `forcefullyCrashRenderer()` then `reload` (`:303-319`);
     `responsive` cancels (`:321-330`).
   - Circuit breaker: ≤ **3** attempts per **60 s** window; backoff delays `[250, 1000, 3000]` ms
     (`:47-49, 217-245`); success verified via optional `verifyRecovered` (`:161`).
2. **Whole-window replacement** (`entry.ts:53-224`): the DI `createBrowserWindow` returns a proxy that, on
   `reload()`, **creates a fresh `BrowserWindow`**, `loadURL(recoveryUrl)`, transfers bounds / visibility /
   focus / maximized, re-attaches all listeners, and destroys the crashed window (`entry.ts:92-149`).
- **[PORT RISK — §9-Risk-1]** WRY/Tauri exposes **none** of `render-process-gone`, `did-fail-load` (with
  error codes), `unresponsive`/`responsive`, `forcefullyCrashRenderer()`, nor cheap live BrowserWindow
  replacement. This layer has no clean Tauri equivalent and needs custom per-platform work.

### 3.8 Application menu (`menu.ts`) + external-url (`external-url.ts`)
- `buildAppMenu` (`menu.ts:16-99`): macOS app menu (About, Preferences ⌘,, hide/quit), Edit, View
  (reload/devtools/zoom/fullscreen), Window, Help (Check for Updates, About vN). Wired `entry.ts:640-650`.
- `open-external-url` opens the system browser via `shell.openExternal` after canonicalization
  (`external-url.ts:33-43`). SPA routes ctrl/shift-click + markdown links through it (`open-url.ts`,
  `useElectronExternalLinks.ts`).

### 3.9 Daemon managers (`electron/daemon/**`) — OS service install/control
`createDaemonManager(resourcesPath)` picks by platform (`create-daemon-manager.ts:3-20`). All three
implement `DaemonManager {install, uninstall, start, stop, status, isInstalled}` (`daemon-manager.ts:22-42`)
by rendering an `installers/*.template` (placeholders `{{NODE_BINARY}} {{SERVER_ENTRY}} {{PORT}}
{{NODE_PATH}} {{CONFIG_DIR}} {{LOG_DIR}}`) and shelling out:

| Platform | Service id | Unit path | Control | Evidence |
|---|---|---|---|---|
| macOS | `com.freshell.server` (LaunchAgent) | `~/Library/LaunchAgents/…plist` | `launchctl load -w / start / stop / list` | `launchd.ts:12-113` |
| Linux | `freshell.service` (user unit) | `~/.config/systemd/user/…` | `systemctl --user daemon-reload/enable/start/stop/show` | `systemd.ts:12-131` |
| Windows | `Freshell Server` (Scheduled Task) | `~/.freshell/freshell-task.xml` | `schtasks /Create|/Run|/End|/Query`; stop finds PID via `wmic` + `taskkill` | `windows-service.ts:12-159` |

- **[DEFECT — high value]** `install()`/`uninstall()` are **never called anywhere** in the codebase
  (verified: no callers in `electron/`, `server/`, `scripts/`, `src/`). `startup.ts:345-352` only calls
  `status()`/`start()` and **throws "Daemon service is not installed. Please re-run setup to configure the
  daemon."** if absent — but nothing (not even the wizard) ever installs it. So **`daemon` mode is a
  dead end today**. The Tauri port should wire install/uninstall into setup (ledger candidate).
- Templates hardcode `{{NODE_BINARY}} {{SERVER_ENTRY}}` + `NODE_PATH`; the port rewrites them to launch
  the single Rust binary with `PORT`/`FRESHELL_CONFIG_DIR` only (no `NODE_PATH`). See §5.

### 3.10 One-time provisioning (`desktop-provisioning.ts`, installer.nsh)
- Silent Windows install writes raw `FRESHELL_REMOTE_URL=` / `FRESHELL_TOKEN=` lines to
  `~/.freshell/desktop.provision` (`installer.nsh:28-43`). On next boot `applyProvisioningFile`
  (`entry.ts:263` → `desktop-provisioning.ts:48-81`) parses it, writes a proper `desktop.json`
  (`serverMode:'remote', setupCompleted:true`), then deletes the file (once-only, malformed-tolerant).

---

## 4. Setup wizard + launch chooser — two auxiliary renderer windows

Both are **separate Vite bundles** loaded into their own `BrowserWindow` with the same preload; they are
NOT part of the retained SPA and must be **rebuilt as Tauri windows** (small React apps or native).

### 4.1 Setup wizard (`electron/setup-wizard/**`)
- Window 640×500, `resizable:false`, centered, `autoHideMenuBar` (`wizard-window.ts:14-40`). Dev loads
  `http://localhost:5174`; packaged loads `dist/wizard/index.html` from the ASAR app root (`:31-39`).
- Shown when `runStartup` returns `{type:'wizard'}` (i.e. `!setupCompleted`) (`entry.ts:560-579`). On
  `closed`, `main()` re-runs after 500 ms (`entry.ts:571-577`).
- 5 steps `welcome → server-mode → configuration → hotkey → complete` (`wizard-logic.ts:17`,
  `wizard.tsx:19-318`). Validates port 1024–65535 and URL (`wizard-logic.ts:29-47`). On finish calls
  `freshellDesktop.completeSetup(config)` then `window.close()` (`setup-wizard/main.tsx:18-21`) →
  `complete-setup` handler persists config (`entry.ts:513-528`).

### 4.2 Launch chooser (`electron/launch-chooser/**`)
- Window 760×720, `show:false` until loaded (`entry.ts:588-608`); dev `http://localhost:5175`, packaged
  `{resourcesPath}/launch-chooser/index.html`. Its `webContents.id` is captured so only it may drive
  `choose-launch-option` (`entry.ts:599`).
- Shown when policy returns `{type:'chooser', candidates, reason}` (`entry.ts:581-609`). `wizardPhase`
  is set **false** here (`entry.ts:582`).
- UI (`chooser.tsx:27-185`): lists discovered local servers (with per-candidate token entry when
  `requiresAuth && !token`), a remote URL+token form, and a "start new local server on port" form; plus
  "Always ask on launch" / "Remember this choice" toggles. Choice builders in `chooser-logic.ts:41-88`.
- Handler (`launch-choice-handler.ts:30-135`): validates schema + sender; for `remote|connect` validates
  URL scheme + (optionally) the token against `{url}/api/settings`; for `start-local` validates the port
  and **authoritatively bind-checks** it (`port-check.ts:11-21`); persists if `remember`; then
  `restartMain(forced)` which closes all windows, sets `pendingForcedLaunch`, re-enters `main()` after
  250 ms (`entry.ts:543-554`).

---

## 5. Packaging (reference) — bundled-Node model → single Rust binary

`electron:build` (`package.json:31`): `build → build:electron → build:wizard → build:launch-chooser →
prepare:bundled-node → electron-builder --config config/electron-builder.yml`.

**`config/electron-builder.yml`** (targets `:73-90`): **mac** `dmg`, **win** `nsis` (oneClick,
runAfterFinish, `installer.nsh` `:92-95`), **linux** `AppImage` + `deb`. `appId: com.freshell.desktop`.

**The critical ASAR / extraResources split** (`electron-builder.yml:9-71`):
- ASAR (`files`): `dist/electron/**` (main), `dist/wizard/**`, `package.json`.
- **extraResources** (real filesystem, because a vanilla Node can't read ASAR): `bundled-node/bin/**`
  (standalone Node), `bundled-node/native-modules/**` (**node-pty recompiled** against the bundled Node
  ABI), `dist/server → server`, `dist/client → client`, `dist/launch-chooser`, `server-node-modules`
  (pruned deps), `assets/tray-icon*`, `installers/**` (daemon templates).

**How Tauri changes this (`architecture-spec.md:17-19`):**
- **No bundled Node, no `server-node-modules`, no recompiled `native-modules`, no ASAR.** The server is a
  single Rust `freshell-server` binary; node-pty → `portable-pty` (compiled in). extraResources collapses
  to: the server binary (a Tauri **sidecar** or a workspace-built binary the core spawns), tray icons,
  and the daemon templates (now Rust-binary-based).
- Bundlers change: `dmg`(mac), **`nsis`/`msi`**(win), **`AppImage`/`deb`/`rpm`**(linux) via
  `tauri bundle`. NSIS `installer.nsh` custom hooks (running-process guard `:5-26`, provisioning write
  `:28-43`) → Tauri NSIS `installerHooks` / a Rust provisioning step.
- Two auxiliary bundles (`dist/wizard`, `dist/launch-chooser`) become additional Tauri windows/bundles.

---

## 6. Electron → Tauri mapping table

Legend: **P** = official `tauri-plugin-*`; **Core** = built into `tauri`; **Custom** = bespoke Rust; **⚠** = no clean equivalent / real gap.

| Electron feature | File:line | Tauri equivalent | Kind | Notes / gap |
|---|---|---|---|---|
| `main:entry.js`, `main()` lifecycle | `entry.ts:236,686` | `tauri::Builder … .run()` + `setup` | Core | Re-entrant `main()` → an explicit window/state machine (no re-entrancy). |
| Preload `contextBridge` `freshellDesktop.*` | `preload.ts:52-71` | `#[tauri::command]` + `@tauri-apps/api` `invoke` / a JS shim exposing `window.freshellDesktop` | Core | Keep the SPA unchanged by shimming `window.freshellDesktop.{isElectron:true, openExternal}` over `invoke` (§7). |
| `ipcMain.handle` (12 channels) | §2 table | Tauri commands; `on*Update*` → `emit`/`listen` events | Core | Per-window capability scoping replaces webContents-id gating. |
| System tray + menu | `tray.ts`, `entry.ts:403-451` | `tauri::tray::TrayIconBuilder` + `tauri::menu::Menu` | Core | Rebuild menu on server-status change (fixes §3.1 defect). |
| Global hotkey | `hotkey.ts`, `startup.ts:204-211` | `tauri-plugin-global-shortcut` | P | **Accelerator grammar differs** — translate `CommandOrControl+\`` → plugin shortcut. Live re-register = unregister+register. |
| Auto-updater | `updater.ts`, `entry.ts:294-316` | `tauri-plugin-updater` | P **⚠** | Different manifest (`latest.json`+`.sig`), mandatory Ed25519 signing, full-bundle (no delta). Feed/signing pipeline rebuild. §9-Risk-2. |
| Window-state persistence | `window-state.ts` | `tauri-plugin-window-state` | P | Plugin persists to its own store; either adopt it or keep writing `desktop.json.windowState` from Rust for parity. |
| Single-instance + focus | `main.ts:24-28,63-70` | `tauri-plugin-single-instance` | P | Callback `(app,args,cwd)` runs in first instance → focus main window. Register **first**. (Linux uses DBus; Snap/Flatpak need manifest entries.) |
| Close-to-tray / hide-on-close | `main.ts:40-47` | window `CloseRequested` → `api.prevent_close()` + `window.hide()` | Core | Gate on `minimizeToTray`; real quit via tray/menu sets an `is_quitting` flag. |
| `before-quit` → stop server | `main.ts:50-53`, `entry.ts:665-668` | `RunEvent::ExitRequested` / window destroy handler | Core | Kill child server (SIGTERM→SIGKILL), unregister hotkey, clear timers. |
| macOS `activate` re-show | `main.ts:56-60` | `RunEvent::Reopen` (macOS) | Core | macOS-only; not verifiable on this host. |
| Renderer crash recovery | `renderer-recovery.ts`, `entry.ts:53-224` | **Custom Rust** + platform webview hooks | Custom **⚠** | No `render-process-gone`/`did-fail-load`/`unresponsive`/`forcefullyCrashRenderer`/window-replace in WRY. §9-Risk-1. |
| Open external URL | `external-url.ts`, `entry.ts:487-509` | `tauri-plugin-opener` (`open_url`) | P | Re-implement canonicalization + origin/sender gate as a command guard (capabilities). |
| App menu | `menu.ts` | `tauri::menu` | Core | Roles map closely; `Preferences`/`Check for Updates` → commands. |
| Server spawn (bundled Node) | `server-spawner.ts`, `startup.ts:247-279` | `tauri-plugin-shell` sidecar **or** `tokio::process` in core | P/Custom | Spawn one Rust binary; keep `/api/health` poll + SIGTERM→SIGKILL. |
| Daemon: launchd | `launchd.ts` | Custom Rust (`launchctl` + plist template) | Custom | Template now launches the Rust binary. mac-only → fixture/spec on this host. |
| Daemon: systemd | `systemd.ts` | Custom Rust (`systemctl --user` + unit template) | Custom | **Live-verifiable on this WSL2 host** (if systemd-user present). |
| Daemon: Windows Task | `windows-service.ts` | Custom Rust (`schtasks`/`wmic`/`taskkill`) | Custom | Partially live-verifiable via `powershell.exe`/`cmd.exe` interop. |
| Startup provisioning | `desktop-provisioning.ts` | Rust startup step reading `~/.freshell/desktop.provision` | Custom | Straight port. |
| `desktop.json` read/write + mutex | `desktop-config.ts` | Rust (`serde_json` + atomic tmp+rename + async mutex) or `tauri-plugin-store` | Custom/P | Keep the **same file + schema** so headless server and Tauri agree. |
| `startOnLogin` (config field, unused) | `types.ts:17` | `tauri-plugin-autostart` | P | Field exists but nothing acts on it today; port can actually honor it. |
| Wizard window | `setup-wizard/**` | Tauri window + retained mini React bundle | Core | Loads its own bundle; `completeSetup` command. |
| Launch-chooser window | `launch-chooser/**` | Tauri window + retained mini React bundle | Core | `get-launch-options`/`choose-launch-option` commands scoped to this window. |
| Port bind-check | `port-check.ts` | Rust `TcpListener::bind` | Custom | Direct equivalent. |
| Packaging (dmg/nsis/AppImage/deb) | `electron-builder.yml` | `tauri bundle` (dmg/nsis/msi/appimage/deb/rpm) | Core | §5. |

---

## 7. Frontend seam — what the retained SPA actually needs

**Confirmed by grep across `src/`**: the retained React SPA touches `window.freshellDesktop` in exactly
**two** places:
1. `src/hooks/useElectronExternalLinks.ts:17-18` — reads `freshellDesktop.isElectron` to decide whether
   to intercept ctrl/shift-clicks.
2. `src/lib/open-url.ts:6,34-38` — calls `freshellDesktop.openExternal(url)`, falling back to
   `window.open` when absent (`:40`).

That's it. `openExternalUrl()` is the shared entrypoint used by `TerminalView`, `ContextMenuProvider`,
`menu-defs`, `BrowserPane` (their `openExternal` is the browser-pane action, which routes through the same
helper). So to keep the SPA **byte-for-byte unchanged**, the Tauri shell only needs to expose:

```js
window.freshellDesktop = { isElectron: true, openExternal: (url) => invoke('open_external_url', { url }) }
```

**Finding (low-risk but important):** `platform`, `getServerMode`, `getServerStatus`, `setGlobalHotkey`,
`onUpdateAvailable`, `onUpdateDownloaded`, `installUpdate` are exposed by preload but **not consumed by the
SPA at all** — they are used only by the wizard/chooser (`completeSetup`, `getLaunchOptions`,
`chooseLaunchOption`) or internally. The port should still provide them for the wizard/chooser and for
forward-compat, but the *main-window* capability surface can be as small as `open_external_url` (+ the
`isElectron` flag). **Electron-only assumption to preserve:** the SPA gets its auth token from the
`?token=` query on the loaded URL (`startup.ts:155`), so the Tauri webview must load the same URL form.

---

## 8. Verification note — what's testable on this headless WSL2 host (Phase 4 QA scoping)

Host: WSL2 Linux, headless, with `powershell.exe` 5.1 + `cmd.exe` reachable via interop; **no macOS host**;
webview libs present (WebKitGTK 2.52.3 per parent env). GUI-dependent items need a virtual display
(Xvfb/weston-headless) or are fixture-only.

### Tauri shell acceptance checklist

| # | Item | This-host verifiability | How |
|---|---|---|---|
| 1 | Mode selection `runStartup` (wizard/chooser/auto-connect/start-local) | ✅ **live (logic)** | Pure DI logic — port to Rust with unit tests mirroring `startup.ts`/`launch-policy.ts`; no GUI. |
| 2 | Local discovery + health probe + token resolution | ✅ **live** | Boot a real server on loopback; assert candidate/token behavior (`launch-discovery.ts`, `token-resolver.ts`). |
| 3 | Server spawn + `/api/health` gate + SIGTERM→SIGKILL | ✅ **live** | Spawn the Rust server binary headless; assert lifecycle (`server-spawner.ts` parity). |
| 4 | `desktop.json` read/write/mutex/atomicity + provisioning | ✅ **live** | Filesystem only; property-test concurrent patches; provision-file consume-once. |
| 5 | Port bind-check | ✅ **live** | `TcpListener::bind` on an occupied vs free port. |
| 6 | Single-instance lock + focus callback | ⚠️ **partial** | Lock acquisition/DBus service testable headless; window-focus side-effect needs a display. |
| 7 | Global hotkey register + accelerator translation | ⚠️ **partial** | Accelerator-string translation unit-testable; actual OS keypress capture needs a display/session. |
| 8 | System tray + menu + status refresh | ⚠️ **display-gated** | Needs a tray-capable session; verify menu-model construction headless, interaction under Xvfb/manual. |
| 9 | Window-state persistence (save/restore bounds/maximized) | ⚠️ **display-gated** | Persistence I/O testable headless; real bounds require a window. |
| 10 | Close-to-tray / hide-on-close / before-quit stop-server | ⚠️ **partial** | `is_quitting` + stop-server logic unit-testable; window hide needs a display. |
| 11 | Renderer crash recovery | ❌ **hard / fixture** | No WRY hooks; can only test any custom watchdog logic in isolation. §9-Risk-1. |
| 12 | Auto-updater (check/download/install + signature verify) | ⚠️ **fixture** | Stand up a static `latest.json`+`.sig` fixture; verify check/verify/download logic; real install is per-OS + signed-build-gated. §9-Risk-2. |
| 13 | Daemon: systemd (linux) | ✅ **likely live** | `systemctl --user` install/enable/start/status/stop against the Rust binary, if user-systemd is available in this WSL2. |
| 14 | Daemon: Windows Task Scheduler | ⚠️ **partial (interop)** | Drive `schtasks`/`wmic`/`taskkill` via `powershell.exe`/`cmd.exe`; verify create/query/run/stop. |
| 15 | Daemon: launchd (mac) | ❌ **spec/fixture only** | No mac host — template-render + arg-shape assertions only. |
| 16 | Wizard flow (5 steps, validation, completeSetup) | ✅ **live (logic)** | Wizard logic is pure (`wizard-logic.ts`); command handler testable headless; window render under Xvfb. |
| 17 | Launch-chooser (choice build + handler + sender scope) | ✅ **live (logic)** | Handler + validators pure (`launch-choice-handler.ts`, `chooser-logic.ts`); UI under Xvfb. |
| 18 | Open-external-url canonicalization + origin/sender gate | ✅ **live** | Pure guard logic (`external-url.ts`); assert reject/accept matrix. |
| 19 | Frontend seam (`window.freshellDesktop.{isElectron,openExternal}`) | ✅ **live** | Load the SPA in the Tauri webview under Xvfb; assert external-link routing (§7). |
| 20 | Packaging (bundle produces deb/AppImage) | ✅ **live (linux)** | `tauri bundle` on this host; mac dmg / win nsis are cross-build/fixture. |

---

## 9. Top 3 porting risks (hardest to reproduce in Tauri)

**Risk 1 — Renderer crash recovery has no Tauri/WRY equivalent.**
`renderer-recovery.ts` (331 ln) + the window-replacement proxy (`entry.ts:53-224`) depend on Electron-only
webContents signals (`render-process-gone`, `did-fail-load` w/ error codes, `unresponsive`/`responsive`,
`forcefullyCrashRenderer()`) and cheap live `BrowserWindow` re-creation with state transfer. WRY exposes
none of these. Reproducing "detect webview crash/hang → reload → escalate to full reload → circuit-break
after 3/60 s" requires custom per-platform webview instrumentation (WebKitGTK/WebView2/WKWebView), and full
behavioral parity may be **impossible on some platforms**. *Mitigation:* implement a server-reachability
watchdog + navigation-timeout + `window.reload`/recreate as a best-effort approximation; explicitly scope
which triggers are covered per OS; oracle it as fixture-only.

**Risk 2 — Auto-update pipeline is a rebuild, not a swap.**
`electron-updater` (feed `latest.yml`, blockmap **delta** downloads, NSIS one-click, code-sign-based trust)
maps to `tauri-plugin-updater` which uses a signed `latest.json` + per-artifact `.sig`, a **mandatory
Ed25519 signature** (embedded pubkey), and **full-bundle** replacement (no deltas). The entire release/
update-server/signing pipeline, artifact layout, and the `checkForUpdates/downloadUpdate/installAndRestart`
event surface (`updater.ts`) must be re-created and re-keyed. Cross-platform install is signed-build-gated
and only partially verifiable here (mac not at all). *Mitigation:* stand up a static `latest.json`+`.sig`
fixture server for logic tests; treat real per-OS install as Phase-4 manual/cross-build QA.

**Risk 3 — Re-entrant multi-window lifecycle + per-sender IPC trust.**
Electron drives the whole flow by **re-invoking `main()`** after the wizard/chooser close (`entry.ts:543-554,
571-577`) held together by `wizardPhase` guards on `window-all-closed`/`will-quit`
(`entry.ts:251-258, 679-683`), and gates privileged IPC by **webContents id + origin** (`open-external-url`
main-window-only `entry.ts:490-509`; `choose-launch-option` chooser-only `entry.ts:538-541`). Tauri has no
re-entrant `main()` and a different (capability/permission) security model. This must be redesigned as an
explicit state machine over long-lived windows, with per-window capabilities enforcing "only the chooser
window may choose a launch, only the main window at the expected origin may open external URLs." Getting the
transition timing (close-all → re-derive mode → open next window) and the trust boundaries wrong risks either
deadlocks (app won't advance past the wizard) or a privilege-escalation regression.

*(Honorable mention — the `daemon`-mode `install()` gap, §3.9 [DEFECT]: never wired today, so the port must
implement it correctly rather than replicate the dead path.)*

---

## 10. Divergences / latent defects found (deviation-ledger candidates)

| Id-candidate | Where | Defect | Suggested port behavior |
|---|---|---|---|
| tray-status-stale | `tray.ts:59` | Tray `Server: Running/Stopped` built once, never refreshed. | Rebuild tray menu on server-status change. |
| daemon-install-unwired | `electron/daemon/**`, `startup.ts:347-349` | `install()`/`uninstall()` never called; `daemon` mode throws "not installed" with no install path. | Wire install/uninstall into the wizard's daemon selection. |
| token-in-url | `startup.ts:155` | Auth token placed in the loaded URL query (`?token=`). | Preserve for SPA compatibility, but consider a header/handshake token path in the port and flag as security review. |
| updater-noop-silent | `entry.ts:307-315` | Missing `electron-updater` silently disables updates (warn only). | Tauri updater is always signed/available when configured; surface a clear disabled state. |

**Do NOT modify source; this is a read-only spec.** Behavior above is derived from code at HEAD
`aa626985` in `.worktrees/rust-tauri-port`.
