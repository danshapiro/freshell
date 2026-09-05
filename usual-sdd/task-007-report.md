# Task 7 Implementer Report

## Result

Electron app-bound mode now starts and owns the Rust server directly. The
supported desktop modes are `app-bound` and `remote`; persisted `daemon`
configuration is migrated atomically to `app-bound`. Electron daemon managers,
their installer templates, and their unit tests were removed. The standalone
`installers/systemd/freshell-rust.service` remains.

## TDD evidence

The required legacy RED command was run before the new behavioral tests and
passed unexpectedly because the old tests still encoded the old Node/daemon
contract:

```text
npm run test:electron -- test/unit/electron/server-spawner.test.ts test/unit/electron/startup.test.ts test/unit/electron/desktop-config.test.ts test/unit/electron/launch-policy.test.ts test/unit/electron/setup-wizard/wizard.test.tsx test/unit/electron/daemon
```

Result: 10 files, 173 tests passed. After adding the Task 7 assertions, the
new Rust spawner/startup/config/wizard tests failed against the old
implementation, as intended. The focused GREEN command then passed:

```text
npm run test:electron -- test/unit/electron/server-spawner.test.ts test/unit/electron/startup.test.ts test/unit/electron/desktop-config.test.ts test/unit/electron/launch-policy.test.ts test/unit/electron/setup-wizard/wizard.test.tsx
```

Result: 5 files, 116 tests passed.

## Verification

```text
npm run test:electron
```

Result: 30 files, 296 tests passed.

```text
! rg -n "server/index|NODE_PATH|server-node-modules|nativeModules|nodeBinary|serverEntry" electron
! rg -n "serverMode.*daemon|Always-running daemon|createDaemonManager|electron/daemon|freshell\.(service\.template|task\.xml)|com\.freshell\.server" electron config/electron-builder.yml
test ! -d electron/daemon
test ! -e installers/systemd/freshell.service.template
test -f installers/systemd/freshell-rust.service
```

Result: all forbidden-content and absence checks passed.

```text
cargo build -p freshell-server --locked
npm run build:client
npm run build:electron
```

Result: all builds passed. The client build emitted only the existing
Browserslist/stable chunk-size warnings.

The required E2E command was also run exactly:

```text
npm run test:e2e:electron -- test/e2e-electron/app-bound-rust-server.test.ts
```

It could not launch Electron on this headless host and failed with Chromium's
`Missing X server or $DISPLAY` error. With the host's virtual framebuffer, the
same test passed:

```text
xvfb-run -a npm run test:e2e:electron -- test/e2e-electron/app-bound-rust-server.test.ts
```

Result: 1 test passed. It uses OS-assigned non-3001 ports, a temporary
`.freshell` home, explicit Rust/Claude/MCP resource paths, authenticated
`/api/server-info`, exact `/proc` executable ownership, and a captured foreign
same-binary process. The Electron test sets the no-local-discovery fixture seam
so it does not probe unrelated local servers.

## Implementation notes

- `ServerSpawnResources` now contains the Rust binary, client, Claude/MCP
  runtime entries, and isolated home/config/log paths.
- Rust starts with no script arguments, exact config-directory cwd, the
  explicit `FRESHELL_*` contract, and inherited `AUTH_TOKEN` removed so the
  configured `.env` remains authoritative.
- Readiness requires unauthenticated health plus authenticated Rust
  `server-info` runtime/commit provenance.
- Stop and double-start behavior is tied to the exact `ChildProcess` returned by
  `spawn`, with bounded SIGTERM/SIGKILL deadlines.
- The packaged artifact still has the pre-Task-8 runtime staging layout; Task 8
  owns replacing those remaining Node packaging entries with staged Rust and
  sanctioned sidecar runtime entries.

No live port 3001 server was contacted, stopped, restarted, or health-checked
by the final Task 7 verification commands.
