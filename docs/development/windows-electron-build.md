# Building the Windows Electron App

This documents how to produce the Windows desktop installer
(`release/Freshell Setup <version>.exe`).

## Key constraint: it must run on native Windows

The Windows build **cannot be produced from WSL/Linux**. `npm run
electron:build:win` begins with `scripts/assert-native-windows-build.ts`, which
hard-fails unless `process.platform === 'win32'` — because `node-pty` has to be
compiled for win32. Running the pipeline from Linux produces a broken installer
(a tiny NSIS stub with no bundled `node.exe`) and, if you let it, a Linux
AppImage instead. If you see a ~few-hundred-KB `Freshell Setup *.exe`, you built
on the wrong platform.

## Prerequisites (on the Windows side)

- Node.js (matching `engines.node`, currently `>=22.5.0`) and npm.
- Visual Studio Build Tools with the **Desktop development with C++** workload,
  and Python 3 — required for `node-gyp` to compile `node-pty`.
- No extra download tools are needed: `scripts/prepare-bundled-node.ts` fetches
  the standalone Node binary and headers over Node's own `http`/`https` and
  extracts them with the bundled `tar` and `extract-zip` packages (not external
  `curl`/`tar`/`unzip`).

## Option A — from a native Windows shell

```powershell
npm install                       # installs Windows-native deps (compiles node-pty for win32)
$env:CI = "true"
npm run electron:build:win        # assert win32 → build → prepare:bundled-node → electron-builder --win nsis
```

`electron:build:win` runs, in order: the platform assert, `npm run build`
(typecheck + client + server), `build:electron`, `build:wizard`,
`build:launch-chooser`, `prepare:bundled-node` (downloads the standalone Node,
recompiles `node-pty`, prunes `server-node-modules`), then `electron-builder
--win nsis --publish never`.

Output lands in `release/`.

## Option B — driving the Windows build from WSL

Your dev checkout usually lives on the WSL filesystem, but the build must run as
a native Windows process. **Do not** build over the `\\wsl.localhost\...` UNC
path (slow and fragile over 9p). Instead, copy the working tree to a
Windows-local path and run Windows' own npm against it via interop.

1. Copy the worktree to a Windows-local dir, excluding regenerable/platform dirs:

   ```bash
   rsync -rlt --delete --no-perms --no-owner --no-group \
     --exclude='.git' --exclude='node_modules/' --exclude='dist/' \
     --exclude='release/' --exclude='bundled-node/' --exclude='server-node-modules/' \
     ./ "/mnt/c/Users/<you>/AppData/Local/Temp/freshell-electron-build/"
   ```

2. Run Windows npm in that dir via `cmd.exe`. Always `cd /d` to a real Windows
   path first — `cmd.exe` launched from WSL inherits the UNC cwd and will warn
   and mangle relative paths:

   ```bash
   cmd.exe /c 'cd /d C:\Users\<you>\AppData\Local\Temp\freshell-electron-build && set "CI=true" && set "PORT=39517" && npm install && npm run electron:build:win'
   ```

   - `PORT=<unused>` is belt-and-suspenders for the `prebuild` guard. (It
     normally auto-skips here because the copied `.git` is a worktree pointer,
     so `isLinkedWorktreeCheckout` is true — but WSL2 forwards `localhost`, so a
     live dev server on the default port is otherwise visible to the guard.)
   - Reusing a previous build dir keeps its warm Windows `node_modules` (with the
     already-compiled win32 `node-pty`), making `npm install` a fast no-op.

3. To move artifacts off `/mnt/c`, prefer WSL `cp` over `cmd copy` — `cmd`'s
   quote/path handling through interop is unreliable for paths with spaces.

## What you get

`config/electron-builder.yml` targets **`nsis`** for Windows: a one-click, per-user
installer (`oneClick: true`, `perMachine: false`).

- `release/Freshell Setup <version>.exe` — the installer. Running it installs to
  `%LOCALAPPDATA%\Programs\Freshell\Freshell.exe` and (with `runAfterFinish`)
  launches the app.
- `release/win-unpacked/Freshell.exe` — the app executable itself; run it
  directly to launch without installing.

The installer is **unsigned** unless a code-signing certificate is configured, so
Windows SmartScreen will warn on first run.

## Sanity-check a build

A good build should show:

- `release/Freshell Setup <version>.exe` is full size (hundreds of MB), not a
  small stub.
- `release/win-unpacked/resources/bundled-node/bin/node.exe` exists (the bundled
  server runtime — absent in broken cross-builds).
- `release/win-unpacked/resources/server-node-modules/node-pty/prebuilds/win32-x64/conpty.node`
  exists.
