# Building the Windows Electron App

This documents how to produce the Windows desktop installer
(`release/Freshell Setup <version>.exe`). The desktop app has one app-bound
backend: the native Rust `freshell-server` executable. Node is packaged only
for the standalone MCP client and the isolated Claude SDK sidecar.

## Key constraint: build on native Windows

The Windows build must run as a native Windows process. `npm run
electron:build:win` begins with `scripts/assert-native-windows-build.ts`, which
hard-fails unless `process.platform === 'win32'`. This ensures Cargo produces a
native `freshell-server.exe` and Electron Builder packages the Windows
artifact, rather than a Linux binary or a non-runnable installer stub.

## Prerequisites (on the Windows side)

- Node.js (matching `engines.node`, currently `>=22.5.0`) and npm for the
  client, tooling, and Electron build.
- A Rust stable toolchain with the MSVC target (`rustup`, Cargo, and the
  Visual Studio Build Tools **Desktop development with C++** workload).
- No Node native-module compiler or Python setup is required for the
  app-bound backend. The Rust server owns PTY support.

## Option A — from a native Windows shell

```powershell
npm install
$env:CI = "true"
npm run electron:build:win        # assert win32 → client/tools/Rust → Electron Builder NSIS
```

`electron:build:win` runs, in order: the native-platform assertion, client and
tool typechecks/builds, the release `freshell-server.exe` Cargo build,
`build:electron`, `build:wizard`, `build:launch-chooser`,
`prepare:electron-runtime`, `electron-builder --win nsis --publish never`, and
the artifact verifier. Output lands in `release/`.

## Option B — driving the Windows build from WSL

Your dev checkout usually lives on the WSL filesystem, but the build must run
as a native Windows process. **Do not** build over the `\\wsl.localhost\...`
UNC path (slow and fragile over 9p). Copy the worktree to a Windows-local path
and run Windows' own npm and Cargo against it via interop.

1. Copy the worktree to a Windows-local directory, excluding generated and
   platform-specific directories:

   ```bash
   rsync -rlt --delete --no-perms --no-owner --no-group \
     --exclude='.git' --exclude='node_modules/' --exclude='dist/' \
     --exclude='target/' --exclude='release/' --exclude='electron-runtime/' \
     ./ "/mnt/c/Users/<you>/AppData/Local/Temp/freshell-electron-build/"
   ```

2. Run Windows npm in that directory via `cmd.exe`. Always `cd /d` to a real
   Windows path first — `cmd.exe` launched from WSL inherits the UNC cwd and
   will warn and mangle relative paths:

   ```bash
   cmd.exe /c 'cd /d C:\Users\<you>\AppData\Local\Temp\freshell-electron-build && set "CI=true" && set "PORT=39517" && npm install && npm run electron:build:win'
   ```

   `PORT=<unused>` keeps the build's preflight isolated from any unrelated
   local service. Reusing a previous Windows-local build directory keeps its
   native dependencies warm, while `target/`, `dist/`, and `electron-runtime/`
   are rebuilt for the copied checkout.

3. To move artifacts off `/mnt/c`, prefer WSL `cp` over `cmd copy` — `cmd`'s
   quote/path handling through interop is unreliable for paths with spaces.

## What you get

`config/electron-builder.yml` targets **`nsis`** for Windows: a one-click,
per-user installer (`oneClick: true`, `perMachine: false`).

- `release/Freshell Setup <version>.exe` — the installer. Running it installs
  to `%LOCALAPPDATA%\Programs\Freshell\Freshell.exe` and launches the app
  when `runAfterFinish` is enabled.
- `release/win-unpacked/Freshell.exe` — the app executable itself; run it
  directly to launch without installing.

The installer is **unsigned** unless a code-signing certificate is configured,
so Windows SmartScreen may warn on first run.

## Sanity-check a build

A good build should show:

- `release/Freshell Setup <version>.exe` is a full-size installer, not a small
  stub.
- `release/win-unpacked/resources/bin/freshell-server.exe` exists and is the
  app-bound backend.
- `release/win-unpacked/resources/client/index.html` exists.
- `release/win-unpacked/resources/node/bin/node.exe` exists only for the
  packaged MCP client and Claude sidecar.
- The packaged resources contain no legacy backend directory or compiled
  legacy backend artifact, and no backend-specific native Node addon is
  packaged.

The authoritative checkout-free checks are `npm run verify:electron-artifact`
and `npm run test:electron:runtime`.
