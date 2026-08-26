# Rust-Only Freshell Backend Retirement Plan (v2)

> **For agentic workers:** Execute this plan in order on
> `.worktrees/retire-node-server-v2`. Use a fresh implementer plus specification
> and quality review after every task. Each task must finish with its focused
> tests green and a focused commit before the next task starts.

## User Request

### Requested result
Retire Freshell's legacy Node.js application server so the Rust server is the only supported backend/server path going forward.

### Explicit constraints
- Use the requested the-usual workflow.
- Work in the fresh isolated `the-usual/retire-node-server-v2` worktree created from updated, green `origin/main`; preserve the first run as a superseded audit record until this replacement plan is validated.
- Treat current Rust server behavior as the compatibility baseline.
- Inventory and triage Node-only server features absent from Rust. If important and not tracked elsewhere, file them as katas.
- Do not carry the prior BrowserPane security-redesign premise into this retirement.
- Node may remain for non-server frontend/build/test tooling, the Electron shell, standalone CLI/MCP clients, and the isolated Claude SDK sidecar; no Node process may remain as Freshell's HTTP/WebSocket/backend server.
- Relocate retained CLI/MCP client source and build artifacts out of the legacy `server/` and `dist/server/` namespaces; do not rewrite them in Rust solely for this retirement.
- Remove or clearly disable current client/CLI/MCP actions that only call Node-only endpoints absent from the Rust baseline; already-tracked future capabilities remain owned by their existing issues.
- Make every supported source, packaged Electron, daemon/service, container, test, and release server path launch `freshell-server` rather than the Node backend.
- Use Red-Green-Refactor TDD and preserve appropriate unit, integration, and end-to-end coverage for retained behavior.
- Keep end-user documentation in `README.md`; update `docs/index.html` only for a major user-facing UI change.
- Commit `.kata.toml` whenever it is modified.
- Do not create or open a PR without explicit user approval, and do not push behavior changes directly to `origin/main`.
- Never restart the live self-hosted Rust server on port 3001 without the user's explicit word `APPROVED`.
- Prefer bash; repository code must use robust structured JSONL logging with severity where logging is needed.

### Accepted tradeoffs and residuals
- Current Rust server behavior, rather than every legacy Node-only behavior, is the compatibility baseline for retirement.
- Node-only server features absent from Rust are not automatic porting requirements; important untracked features are preserved as katas instead.
- The prior run's BrowserPane security redesign is outside this retirement scope.
- Retained Node CLI/MCP programs are non-server backend clients and may remain after being disentangled from the legacy server build.

**Goal:** `freshell-server` is the only executable that listens on Freshell's
HTTP/WebSocket port, owns Freshell PTYs, or composes backend state. Browser,
Electron, standalone service, container, test, and release paths all start that Rust
binary. Node remains only in the explicitly permitted frontend/build/test,
Electron-shell, standalone CLI/MCP-client, and Claude-sidecar roles.

**Architecture:** Keep the Rust backend unchanged as the product compatibility
baseline. First move neutral TypeScript contracts and the retained HTTP clients
out of `server/`, and make Rust-absent actions truthful without porting them.
Then make every live harness, source command, Electron process plan, installer,
container, and CI/release job Rust-backed. Only after those consumers are green
delete the legacy implementation, its tests, configs, dependencies, and emitted
namespace. Permanent structural and non-vacuity guards prevent a Node backend or
an empty test lane from returning.

**Tech stack:** Rust 1.96.0 (`freshell-server`, Cargo workspace, Tokio/Axum,
structured `tracing` output), React/Vite/TypeScript, standalone Node 22 CLI and
MCP HTTP clients, Vitest, Playwright, Electron/electron-builder, bash launchers,
Docker, and GitHub Actions.

## Global Execution Constraints

- Work only in `/home/dan/code/freshell/.worktrees/retire-node-server-v2` on
  `the-usual/retire-node-server-v2`. Preserve
  `/home/dan/code/freshell/.worktrees/retire-node-server` and its plan as an
  untouched superseded audit record.
- Current Rust behavior is authoritative. Do not port attachments, fresh-agent
  exec/diff/send, external editor opening, extension lifecycle/assets, raw TCP
  forwarding, WebSocket proxy upgrades, `/api/run`, paged transcript turns,
  terminal viewport/paged scrollback, `codingcli.*`, or the incident dump merely
  to delete Node. Existing parity issue #624/checklist items retain ownership.
- Never contact, stop, restart, or health-check port 3001. Every executable test
  owns an isolated `HOME`/`FRESHELL_HOME`, token, PID, and OS-assigned or unique
  non-3001 loopback port. Lifecycle/restart-storm tests use
  `scripts/sandbox-test.sh`; no broad kill pattern is allowed.
- Direct Vitest runs go through `npm run test:vitest -- ...`; broad branch runs
  use the shared coordinator. Before a configured Playwright run, obey the
  repository rule for an unset `FRESHELL_E2E_BACKEND`. A required spec in
  `CLOUD_SKIP_SPECS`, a zero-test filter, or a soft skip is not coverage.
- New Node/Electron/tooling logs are one JSON object per line with `severity`,
  `event`, and non-secret context. New Rust logs use the configured structured
  `tracing` subscriber. Never log tokens, authorization headers, prompts,
  attachment/file bodies, or sidecar payloads.
- No task starts a PR. A branch push is permitted for the final review handoff;
  never push to `origin/main`. Native required checks run only after the user
  explicitly approves PR creation. Do not deploy the result.
- `.kata.toml` is expected to remain byte-identical. If implementation really
  changes it, include it in the focused task commit. Normal Kata create/search
  operations must not change it.
- `docs/index.html` remains unchanged: the default UI layout is not being
  redesigned. User-visible capability and install/runtime statements belong in
  `README.md`; contributor/runtime commands belong in `AGENTS.md` and the
  Windows Electron build guide.

## File Responsibility and Interface Map

- `scripts/retirement/runtime-surfaces.json` is the checked-in, closed inventory
  of every supported launch, service, packaging, container, test-fixture, and
  release owner, including root executables and surviving `port/**` bootstrap
  scripts. `scripts/retirement/runtime-boundary.ts` reconciles the manifest in
  both directions: every discovered owner maps to exactly one row and every row
  resolves to tracked evidence. It ignores historical `docs/plans/**` and frozen
  evidence, and reports sorted `manifestDrift`, `legacyDebt`, and
  `unexpectedNodeBackend` entries.
- `shared/tab-registry-types.ts` and `shared/freshell-home.ts` own application
  contracts formerly imported from the Node backend.
  `config/vite/get-network-host.ts` owns Vite's bind-host lookup.
  `scripts/testing/repo-context.ts` owns test-coordinator Git and worktree
  discovery.
- `tools/freshell-cli/**` is the retained package CLI; `tools/freshell-mcp/**` is
  the retained stdio MCP bridge; `tools/node-client-runtime/**` owns common
  client config, terminal-key translation, shared error constants, and the
  minimal runtime-dependency manifest. These programs are
  HTTP clients only: they never listen, own a PTY, import `server/**`, or compose
  backend state. `tsconfig.tools.json` emits only `dist/tools/**`.
- `crates/freshell-platform/src/mcp_inject.rs` injects the retained MCP client.
  Its production interface accepts the explicit pair `FRESHELL_MCP_NODE` and
  `FRESHELL_MCP_ENTRY`; checkout fallback resolves
  `dist/tools/freshell-mcp/server.js` or the TypeScript source under `tools/`.
- `src/components/**`, `src/lib/api.ts`, `src/store/freshAgentThunks.ts`, and
  `shared/ws-protocol.ts` advertise only current Rust-baseline behavior. A
  disabled action never sends a request to a known-missing route.
- `test/e2e-browser/helpers/rust-server.ts`, `external-target.ts`, `fixtures.ts`,
  and `playwright.config.ts` own one Rust-backed browser lane. An external target
  is read-only and never stopped; an owned target records/reaps its exact PID.
- `scripts/testing/**`, `config/vitest/vitest.config.ts`, and
  `config/vitest/vitest.electron.config.ts` own the broad gate: retained Vitest,
  the Rust workspace, and Electron. Required lanes reject zero selection and do
  not use `--passWithNoTests`.
- `scripts/start-rust-server.ts`, `scripts/launch.sh`,
  `scripts/launch-rust.sh`, root `run-rust-server.sh`, and retained
  `port/**` bootstrap scripts own source start/serve lifecycle. They launch or
  build only `target/{debug,release}/freshell-server` and preserve exact-PID
  safety.
- `electron/server-spawner.ts` owns the Electron app-bound Rust child. Electron
  supports app-bound and remote modes; the advertised but never provisioned
  Electron daemon mode and its service managers/templates are removed. The
  standalone `installers/systemd/freshell-rust.service` remains the supported
  Rust service path. The app-bound process contract has `serverBinary`,
  `clientDir`, `claudeNodeBinary`, `claudeSidecarEntry`, `mcpNodeBinary`,
  `mcpEntry`, `homeDir`, `configDir`, and `logDir`; it has no Node server entry
  or `NODE_PATH`.
- `scripts/prepare-electron-runtime.ts` stages the host-native Rust server, built
  client, compiled MCP bridge plus its minimal production dependency closure,
  and the isolated Claude Node/sidecar runtime. `config/electron-builder.yml`
  packages only those staged resources plus Electron assets/installers.
- `docker/cloud-run/**`, `examples/docker/Dockerfile`, `.github/workflows/**`,
  and `scripts/verify-electron-artifact.ts` own container/CI/release proof that
  the backend artifact is Rust and forbidden Node-server artifacts are absent.
- `README.md` is the end-user truth. `AGENTS.md`, `.env.example`, and
  `docs/development/windows-electron-build.md` are active contributor/operator
  truth. Historical plans and port evidence remain as provenance.

## Requirement Trace

| Requirement | Delivering tasks | Proof |
| --- | --- | --- |
| Rust is the sole backend/server | 1, 4, 6-11 | Closed runtime manifest has zero drift/debt; source/browser/Electron/container/release provenance names `freshell-server`; `server/` and `dist/server/` do not exist. |
| CLI/MCP remain standalone Node clients | 2, 7-8, 10 | Sources and output are `tools/**`/`dist/tools/**`; MCP injection and package bin use them; unit and live Rust E2E pass; no client listens or imports backend code. |
| Rust-absent actions are honest | 2-3, 5 | A 33-action/14-alias table rejects every unsupported action or argument locally without HTTP; browser client makes no missing-route requests; dead REST/WS declarations disappear. |
| Browser uses only Rust | 3-5, 11 | One `chromium` project, Rust fixture provenance, at least 308 tests in at least 86 files, zero legacy project/kind, and configured E2E green. |
| Electron/service use packaged Rust | 7-9, 11 | Electron daemon mode is absent; app-bound Electron E2E, standalone-service inspection, checkout-free native artifact acceptance, and all-OS CI receipts show the Rust binary and reject Node backend artifacts. |
| Test/build/release proof is non-vacuous | 4, 6, 9, 11 | No `--passWithNoTests`; Cargo workspace is in the broad gate; Tauri smoke fails without a binary; selection/artifact floors and provenance assertions pass. |
| Node-only gaps are triaged, not silently ported | 3, 5, 11 | Final external receipt repeats source/caller/Kata/GitHub/checklist searches; expected result is no important untracked gap; a Kata is filed only on contrary evidence. |
| Safety/docs/process constraints | all, especially 11 | Isolated ports/PIDs, no port-3001 contact, README/active guides updated, `docs/index.html` untouched, `.kata.toml` unchanged or committed. |

---

### Task 1: Establish the Runtime Boundary and Move Neutral TypeScript Owners

**Files:**

- Create: `scripts/retirement/runtime-surfaces.json`
- Create: `scripts/retirement/runtime-boundary.ts`
- Create: `test/unit/architecture/rust-only-server-runtime.test.ts`
- Create: `shared/tab-registry-types.ts`
- Create: `shared/freshell-home.ts`
- Create: `config/vite/get-network-host.ts`
- Create: `scripts/testing/repo-context.ts`
- Modify: `src/store/tabRegistryTypes.ts`
- Modify: `server/tabs-registry/types.ts`
- Modify: `server/freshell-home.ts`
- Modify: `config/vite/vite.config.ts`
- Modify: `scripts/testing/test-coordinator.ts`
- Modify: `scripts/precheck.ts`
- Modify: `test/unit/vite-config.test.ts`
- Modify: `test/e2e-browser/helpers/session-corpus/session-corpus.test.ts`
- Modify: existing coordinator/precheck/tab-registry tests that import the moved owners

**Interfaces:**

- `analyzeRuntimeBoundary(root): Promise<{ manifestDrift: string[];
  legacyDebt: string[]; unexpectedNodeBackend: string[] }>` loads a closed
  manifest seeded from the load-bearing review's 44 runtime/resource owners and
  returns stable sorted repo-relative evidence. Every tracked executable,
  package command, service/template, container entrypoint, fixture server,
  release job, root launcher, and surviving `port/**` bootstrap owner must map to
  exactly one manifest row; every row must resolve. Sanctioned Node roles are
  explicit entrypoint/module rules, not directory-wide exclusions: backend
  listeners, WebSocket servers, Freshell PTY ownership, or imports from
  `server/**` still fail when placed under Electron, tools, scripts, or tests.
- `getFreshellHomeDir(env)` and `getFreshellConfigDir(env)` preserve the current
  `FRESHELL_HOME`-then-home behavior without relying on the `NodeJS` global type;
  the two legacy `server/**` modules are temporary re-exports until Task 10.
- `getNetworkHost({ env, configDir, isWsl })` is dependency-injected and has no
  import from `server/**`; Vite's live wrapper supplies process env and WSL
  detection.
- `resolveGitRepoRoot`, `resolveGitCheckoutRoot`, and cache reset remain available
  to the coordinator from `scripts/testing/repo-context.ts`.
- `scripts/precheck.ts` retains branch confirmation, dependency checks, and port
  conflict checks; it drops the duplicate Node-updater invocation because Rust
  already owns update behavior.

- [ ] **Step 1: Write the failing behavioral test**

  Add `rust-only-server-runtime.test.ts` with a synthetic-tree test proving an
  invented Node HTTP listener is `unexpectedNodeBackend`, an allowlist test for
  Vite/Vitest/Electron-main/CLI/MCP/Claude-sidecar Node roles, and manifest
  reconciliation tests for an unlisted tracked owner, a stale row, and duplicate
  ownership. The current-tree test requires the known debt entries
  `server/index.ts`, `package.json:scripts.start`,
  `config/electron-builder.yml:dist/server`,
  `test/e2e-browser/playwright.config.ts:legacy-chromium`, the stale legacy
  comment in root `run-rust-server.sh`, and the inherited build path in
  `port/laptop-bootstrap/2-bootstrap-wsl.sh`. Extend existing
  Vite/coordinator/tab-registry tests to import only the new neutral paths.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts test/unit/vite-config.test.ts --config config/vitest/vitest.config.ts
  npm run test:e2e:helpers -- test/e2e-browser/helpers/session-corpus/session-corpus.test.ts
  ```

  Expected: FAIL because `scripts/retirement/runtime-boundary.ts` and the neutral
  modules do not exist. No test may fail by contacting a server or port 3001.

- [ ] **Step 3: Add the minimal implementation**

  Check in the closed manifest and implement two-way reconciliation before
  moving the neutral code without changing its data semantics. Discovery is
  deliberately broader than the manifest and fails closed on a new root
  executable, package script, service resource, container command, test server,
  workflow launch step, or retained `port/**` bootstrap path. Replace the
  coordinator import of `server/coding-cli/utils.ts`, the
  Vite import of `server/get-network-host.ts`, and the client import of
  `server/tabs-registry/types.ts`. Make `server/freshell-home.ts` and
  `server/tabs-registry/types.ts` temporary NodeNext `.js` re-exports from the
  neutral owners so the intermediate backend consumes the same contracts. Remove
  only the update-check block/import from `scripts/precheck.ts`; preserve its
  serve-branch and port protections. Keep a temporary explicit debt list so
  later tasks can remove entries one by one; manifest rows remain after their
  classification changes from legacy debt to Rust or sanctioned Node client.

- [ ] **Step 4: Run the focused GREEN command**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts test/unit/vite-config.test.ts --config config/vitest/vitest.config.ts
  npm run test:e2e:helpers -- test/e2e-browser/helpers/session-corpus/session-corpus.test.ts
  ```

  Expected: PASS; synthetic Node listener rejection bites, sanctioned tooling is
  accepted, manifest drift is empty, and current legacy debt is enumerated rather
  than hidden.

- [ ] **Step 5: Refactor while green**

  Deduplicate path normalization/file walking, sort every diagnostic, and extract
  pure adapters around process env/filesystem access. Preserve public schema/type
  names so client persistence does not migrate. Add fixtures showing that a file
  under `docs/plans/**` is ignored while the same text under `scripts/**` is debt,
  that root and `port/**` executable owners cannot escape inventory, and that a
  fake `tools/` or `electron/` Node HTTP listener cannot bypass capability
  detection. Keep semantic listener detection as defense in depth behind the
  closed surface manifest.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "server/(tabs-registry/types|get-network-host|coding-cli/utils|updater)" src config scripts test/e2e-browser test/unit --glob '!test/unit/server/**'
  npm run typecheck:client
  npm run test:vitest -- run test/unit/architecture test/unit/vite-config.test.ts test/unit/server/testing test/unit/server/prebuild-guard.test.ts --config config/vitest/vitest.server.config.ts
  ```

  Expected: the search returns no retained consumer of those paths; typecheck and
  impacted tests PASS. References confined to legacy implementation/tests remain
  eligible for Task 10 deletion.

- [ ] **Step 7: Commit the task**

  ```bash
  git add scripts/retirement test/unit/architecture shared/tab-registry-types.ts shared/freshell-home.ts config/vite/get-network-host.ts scripts/testing/repo-context.ts src/store/tabRegistryTypes.ts server/tabs-registry/types.ts server/freshell-home.ts config/vite/vite.config.ts scripts/testing/test-coordinator.ts scripts/precheck.ts test/unit/vite-config.test.ts test/e2e-browser/helpers/session-corpus
  git commit -m "refactor: isolate neutral code from Node server"
  ```

### Task 2: Relocate and Make Truthful the Standalone CLI and MCP Clients

**Files:**

- Create: `tools/freshell-cli/**` from retained `server/cli/**`
- Create: `tools/freshell-mcp/{server.ts,freshell-tool.ts,http-client.ts}`
- Create: `tools/node-client-runtime/{action-capabilities,config,keys,codex-restore-contract}.ts`
- Create: `tsconfig.tools.json`
- Move: `test/unit/server/mcp/{freshell-tool,http-client,server}.test.ts` to `test/unit/mcp/`
- Modify: `test/unit/cli/**`
- Delete after replacement: `test/e2e/agent-cli-flow.test.ts`
- Delete after replacement: `test/e2e/agent-cli-screenshot-smoke.test.ts`
- Create: `test/e2e-browser/specs/cli-rust.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/agent-api/router.ts`
- Modify: `server/coding-cli/codex-app-server/restore-decision.ts`
- Modify: `server/mcp/config-writer.ts`
- Modify: `test/unit/server/mcp/config-writer.test.ts`
- Modify: `test/unit/server/mcp/config-writer-paths.test.ts`
- Modify: `crates/freshell-platform/src/mcp_inject.rs`
- Modify: `crates/freshell-platform/src/mcp_inject_tests.rs`
- Modify: `crates/freshell-platform/src/cli_launch_goldens.rs`
- Modify: `test/e2e-browser/helpers/mcp-stdio-client.ts`
- Modify: `test/e2e-browser/playwright.config.ts`
- Modify: `test/e2e-browser/specs/mcp-bridge-rust.spec.ts`
- Modify: `test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts`
- Create: `test/fixtures/tools/rust-action-capability-matrix.json`
- Retain until Task 10: `server/mcp/config-writer.ts` as part of the still-pending legacy backend only; it is not copied into `tools/**`

**Interfaces:**

- `package.json#bin.freshell` points to `dist/tools/freshell-cli/index.js`.
  `build:tools` runs `tsc -p tsconfig.tools.json`; that config uses
  NodeNext/NodeNext, `rootDir: "tools"`, `outDir: "dist/tools"`, and includes
  only `tools/**/*.ts`. Tool-relative runtime imports carry `.js`; no tool emits
  under `dist/server` or requires a compiled `shared/**` tree.
- A checked-in capability matrix contains all 33 canonical actions and 14
  aliases. Validation, CLI help, MCP schema/description, and tests consume the
  same table; unclassified or duplicate actions fail the build. Supported rows
  preserve current Rust request paths/output shapes. Unsupported rows return a
  deterministic local exit-code-2 or `{ error, hint }` result and make zero HTTP
  requests.
- Unsupported rows/variants are: `run`; `fresh-send`; `attach`; `new-tab` with
  `agent` other than Rust-supported `opencode`; `split-pane` with any of
  `agent`, `model`, or `effort`; `wait-for` without a pattern or with
  `stable|exit|prompt`; and legacy `capture` `J`/`e` arguments whose semantics
  Rust ignores. Help and MCP parameter schemas do not advertise them. Direct
  Claude/Codex terminals continue through supported `mode` values rather than
  the rejected `agent` sugar.
- Replace the hard-coded-`node` args-only seam with
  `McpServerCommand { command: McpServerArg, args: Vec<McpServerArg> }` and
  `McpRuntime::server_command()`. Every generated Claude/Gemini/Kimi JSON,
  Codex TOML pair, and OpenCode command array uses that command field.
  `RealMcpRuntime` resolves an explicit `FRESHELL_MCP_NODE` plus
  `FRESHELL_MCP_ENTRY` pair first, production (`node` plus)
  `dist/tools/freshell-mcp/server.js` second, and dev
  `tools/freshell-mcp/server.ts` with the tsx loader third. Supplying only one
  explicit variable is an error, not a fallback. Command-aware conversion covers
  both the executable and every path-valued argument/config selector in native
  Linux, macOS, and Windows plus WSL-to-Windows and Windows-to-WSL crossings;
  conversion failure is fatal.
- During the intermediate Tasks 2-9 branch, the legacy backend's
  `buildMcpServerCommandArgs` resolves the same `dist/tools`/`tools` entrypoints;
  it never points at the deleted `server/mcp/server.ts` source. The whole config
  writer disappears with the backend in Task 10.
- Retained Node programs are stdout-disciplined clients: CLI owns stdout UX; MCP
  stdout is JSON-RPC only and diagnostics are structured JSONL on stderr.

- [ ] **Step 1: Write the failing behavioral test**

  Move the MCP/CLI tests to their final paths and add assertions that imports
  resolve under `tools/**`, `npm run build:tools` creates both final entrypoints,
  the complete 33-action/14-alias matrix is classified exactly once, every
  unsupported row/variant above makes zero fake-HTTP calls, `package.json#bin`
  is outside `dist/server`, and `mcp_inject` prefers the explicit packaged pair
  and rejects a half-configured pair. Change retained config-writer tests to
  require its production/dev injection paths under `dist/tools`/`tools` and no
  path under `server/mcp`. Put `// @vitest-environment node` at the top of the
  moved MCP tests so the default config runs their filesystem/stdio behavior
  under the correct environment. Add `cli-rust.spec.ts` against an owned Rust
  server and the compiled `dist/tools/freshell-cli/index.js`; its scenarios cover
  health/list/create/mutate tab and pane operations, send/capture/wait, browser
  navigation/screenshot, paged session listing/search, and the local unsupported
  `run` result. Register it explicitly in the pre-collapse `rust-chromium`
  `testMatch`. This replaces the two Express/Node-backend fake E2E files.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/cli test/unit/mcp --config config/vitest/vitest.config.ts
  cargo test -p freshell-platform --locked mcp_inject
  ```

  Expected: FAIL because the tool sources/final imports do not exist and current
  clients still call `/api/run` and `/api/fresh-agent/send`; the Rust test also
  reports the old `server/mcp`/`dist/server/mcp` paths.

- [ ] **Step 3: Add the minimal implementation**

  Move the CLI and only the stdio/client MCP modules. Extract config-dir, key
  translation, the action-capability table, and the raw-Codex-resume message to
  neutral modules; update the legacy `agent-api/router.ts` and restore-decision
  module to consume/re-export
  those neutral contracts so removing `server/cli/**` does not break the
  intermediate branch. Leave `server/mcp/config-writer.ts` solely inside the
  legacy backend until Task 10; do not copy it or any backend/provider module
  into `tools/**`, but repoint its generated client command to the new tool
  entrypoint so the intermediate backend remains buildable. Add the dedicated
  tools TypeScript build and update all source/test/package/Rust-injection paths.
  Implement deterministic local unsupported results for every listed
  action/variant; remove their happy-path help and parameter schemas. Keep
  `@modelcontextprotocol/sdk` as a production dependency of the retained MCP
  program. Convert every Rust injection renderer from the old args-only,
  hard-coded `node` contract to `McpServerCommand`, including WSL path conversion
  of both the executable and every path argument.

- [ ] **Step 4: Run the focused GREEN command**

  Run:

  ```bash
  npm run typecheck:tools
  npm run build:tools
  npm run build:server
  test -f dist/tools/freshell-cli/index.js
  test -f dist/tools/freshell-mcp/server.js
  npm run test:vitest -- run test/unit/cli test/unit/mcp --config config/vitest/vitest.config.ts
  npm run test:vitest -- run test/unit/server/mcp/config-writer.test.ts test/unit/server/mcp/config-writer-paths.test.ts --config config/vitest/vitest.server.config.ts
  cargo test -p freshell-platform --locked mcp_inject
  ```

  Expected: PASS; both outputs exist outside `dist/server`, unsupported actions
  produce the frozen local errors with zero HTTP calls, and every MCP injection
  target points at `tools`/`dist/tools`; the full action table is reconciled.

- [ ] **Step 5: Refactor while green**

  Consolidate CLI/MCP auth URL resolution in `tools/node-client-runtime/config.ts`,
  make unsupported-action metadata a read-only table used by validation and help,
  and remove duplicated path conversion in `mcp_inject.rs`. Add parse/round-trip
  goldens for every provider renderer with command plus args, spaces, quotes,
  backslashes, native Linux/macOS/Windows paths, and both WSL crossing directions;
  convert config selector paths as well and fail on conversion errors. Add
  negative tests proving neither executable opens a listening socket and MCP
  stderr remains valid JSONL without corrupting stdout JSON-RPC.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "server/(cli|mcp)|dist/server/(cli|mcp)" package.json tools crates/freshell-platform test/unit/cli test/unit/mcp test/e2e test/e2e-browser/helpers test/e2e-browser/specs/mcp-*.spec.ts
  FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/cli-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts
  ```

  Expected: the search finds no old path; unit tests prove every unsupported
  variant has zero transport. The explicit local E2E command avoids the current
  cloud skip during this pre-collapse task, runs a nonzero test count, starts one
  owned Rust server, executes
  `dist/tools/freshell-mcp/server.js`, and PASSes. Task 4 removes any transitional
  cloud skip before these specs join configured broad coverage.

- [ ] **Step 7: Commit the task**

  ```bash
  git add tools tsconfig.tools.json package.json package-lock.json crates/freshell-platform test/fixtures/tools test/unit/cli test/unit/mcp test/unit/server/mcp/config-writer.test.ts test/unit/server/mcp/config-writer-paths.test.ts test/e2e test/e2e-browser/helpers/mcp-stdio-client.ts test/e2e-browser/playwright.config.ts test/e2e-browser/specs/cli-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts server/agent-api/router.ts server/coding-cli/codex-app-server/restore-decision.ts
  git add -A server/cli server/mcp
  git commit -m "refactor: separate Node clients from legacy server"
  ```

### Task 3: Remove or Clearly Disable Rust-Absent Browser Actions

**Files:**

- Modify: `src/components/panes/BrowserPane.tsx`
- Modify: `src/components/fresh-agent/FreshAgentComposer.tsx`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `src/components/fresh-agent/FreshAgentDiffPanel.tsx`
- Modify: `src/components/panes/EditorPane.tsx`
- Modify: `src/components/panes/ExtensionPane.tsx`
- Modify: `src/lib/pane-action-registry.ts`
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/components/panes/BrowserPane.test.tsx`
- Modify: `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Modify: `test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`
- Replace: `test/unit/client/components/panes/EditorPane.openInEditor.test.tsx` with disabled-action assertions
- Modify: `test/unit/client/components/ExtensionPane.test.tsx`
- Modify: `test/unit/client/components/context-menu/menu-defs.test.ts`
- Modify: `test/e2e-browser/playwright.config.ts`
- Create: `test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts`

**Interfaces:**

- BrowserPane continues to proxy `http://localhost:<port>` through
  `/api/proxy/http/<port>/...` and loads ordinary non-loopback URLs directly.
  A remote browser targeting `https://localhost` or Freshell's own loopback port
  shows `Remote loopback forwarding is unavailable; use a localhost HTTP URL or open the URL on the server host.` It never POSTs/DELETEs `/api/proxy/forward`.
- Attachment selection is not rendered; `!command` shows
  `Shell commands are unavailable here; open a shell pane instead` and does not
  send or call REST; diff summaries are non-expandable and state that full diff
  loading is unavailable.
- External editor/reveal menu actions and callbacks are removed; the embedded
  editor's save/preview behavior remains and never calls `/api/files/open`.
- Client/server extension panes render an accessible unsupported-baseline panel
  and never call lifecycle/asset endpoints. CLI-category extension behavior is
  left unchanged.

- [ ] **Step 1: Write the failing behavioral test**

  Change the seven focused component/menu tests to require the exact messages and zero
  calls to `/api/proxy/forward`, `/api/fresh-agent/attachments`,
  `/api/fresh-agent/exec`, `/api/fresh-agent/diff`, `/api/files/open`, and
  `/api/extensions/:name/start`. Add one Rust-owned E2E spec with five scenarios:
  localhost HTTP still uses the supported Rust proxy; remote HTTPS loopback
  renders the baseline message with no raw-forward request; an editor pane's
  context menu lacks external-open/reveal while save still works; a
  server/client extension pane renders the accessible unsupported panel with no
  start/asset request; an actual markdown file is read, edited, saved, verified
  on disk, and rendered in preview through Rust's supported editor routes; and a
  fake-provider fresh-agent pane has no attachment
  control, blocks `!command`, and cannot expand a diff without making any of the
  three removed fresh-agent requests. Capture all page requests and fail on a
  forbidden route. Register this Rust-only spec in the pre-collapse
  `rust-chromium` `testMatch` and keep it out of `CLOUD_SKIP_SPECS`.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/panes/EditorPane.openInEditor.test.tsx test/unit/client/components/ExtensionPane.test.tsx test/unit/client/components/context-menu/menu-defs.test.ts --config config/vitest/vitest.config.ts
  ```

  Expected: FAIL because current components perform at least one listed
  Rust-absent request or expose the active control.

- [ ] **Step 3: Add the minimal implementation**

  Remove BrowserPane forwarding state/retry/cleanup and replace only the
  unsupported remote-loopback branch with the explicit outcome. Remove attachment
  upload state and file input. Keep `!` detection solely to block with the exact
  notice. Render diff filenames/status as text, unregister external editor/reveal
  callbacks and their menu entries, and short-circuit unsupported
  extension categories before any request/iframe URL is constructed. Preserve
  Rust's existing localhost proxy and editor read/save/preview behavior.

- [ ] **Step 4: Run the focused GREEN command**

  Run the Step 2 command again.

  Expected: PASS; every disabled branch is accessible and deterministic, and the
  fake API/fetch clients record zero missing-route calls.

- [ ] **Step 5: Refactor while green**

  Extract a single `RUST_BASELINE_UNAVAILABLE` message map used by controls and
  tests, remove dead upload/forward/diff loader types and retry state, and preserve
  semantic buttons/`aria-disabled` for controls that remain visible. Keep the
  normal localhost HTTP proxy helper independently testable.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "/api/(proxy/forward|fresh-agent/(attachments|exec|diff)|files/open|extensions/.*/start)" src
  npm run typecheck:client
  npm run lint
  npm run test:e2e -- --project=rust-chromium test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts test/e2e-browser/specs/browser-pane.spec.ts
  ```

  Expected: the search returns no production caller; typecheck/lint PASS; the
  configured E2E run reports a nonzero test count and PASSes against an owned Rust
  server, including the disk-verified editor round trip. Neither required spec
  appears in `CLOUD_SKIP_SPECS`.

- [ ] **Step 7: Commit the task**

  ```bash
  git add src/components src/lib/pane-action-registry.ts test/unit/client/components test/e2e-browser/playwright.config.ts test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts
  git commit -m "fix: align browser actions with Rust baseline"
  ```

### Task 4: Collapse Browser E2E to One Owned Rust Backend

**Files:**

- Modify: `test/e2e-browser/helpers/external-target.ts`
- Modify: `test/e2e-browser/helpers/fixtures.ts`
- Modify: `test/e2e-browser/helpers/rust-server.ts`
- Create: `test/e2e-browser/helpers/server-fixture-support.ts`
- Delete: `test/e2e-browser/helpers/test-server.ts`
- Delete: `test/e2e-browser/helpers/test-server.test.ts`
- Create: `test/e2e-browser/helpers/server-fixture-support.test.ts`
- Modify: `test/e2e-browser/helpers/rust-server.test.ts`
- Modify: `test/e2e-browser/playwright.config.ts`
- Delete: `test/e2e-browser/playwright.gate01.config.ts`
- Delete: `test/e2e-browser/gate01-run-slice.sh`
- Delete: `test/e2e-browser/helpers/gate01-collate.ts`
- Delete: `test/e2e-browser/helpers/gate01-collate.test.ts`
- Modify: `test/e2e-browser/playwright.cloud.config.ts`
- Modify: `test/e2e-browser/global-setup.ts`
- Modify: `test/e2e-browser/global-teardown.ts`
- Modify: `test/e2e-browser/perf/run-sample.ts`
- Modify: `test/e2e-browser/helpers/leak-metrics.ts`
- Modify: `test/e2e-browser/vitest.config.ts`
- Modify: `test/setup/e2e-browser-global-setup.ts`
- Modify: `test/e2e-electron/electron-app.test.ts`
- Modify: the closed current set of specs returned by
  `rg -l '\be2eServerKind\b' test/e2e-browser/specs | sort`; remove the obsolete
  fixture parameter and convert any executable legacy conditional to one
  Rust-baseline assertion
- Modify: the closed current set returned by
  `rg -l '\bTestServer\b|test-server\.js' test/e2e-browser/specs test/e2e-browser/perf test/e2e-electron | sort`;
  direct owned constructors become `RustServer`, while shared types/port/home
  helpers import from `server-fixture-support.ts`
- Create: `test/e2e-browser/helpers/selection-nonvacuity.test.ts`

**Interfaces:**

- `E2eServerKind` and the `e2eServerKind` fixture option are removed. The fixture
  starts an owned `RustServer`; `createE2eServerHandle` returns that owned server
  or a non-owned `ExternalServer` when an explicit external URL is configured.
- `server-fixture-support.ts` owns `E2eServerInfo`, ephemeral-port allocation,
  isolated-home env construction, and setup-wizard seeding without any process
  constructor. `test-server.ts` is deleted only after every direct constructor
  and type/helper import in the two closed sets above has moved.
- `playwright.config.ts` exposes one application project named `chromium` with
  Rust fixtures. There is no `legacy-chromium`, `rust-chromium`, `MATRIX_SPECS`,
  or Node `TestServer`.
- Selection inspection requires at least 308 tests in at least 86 files (the
  observed pre-retirement Rust floor), zero legacy projects, and zero required
  specs intersecting `CLOUD_SKIP_SPECS`.
- `gate01-baseline.json` remains frozen audit evidence, but its Node/Rust slice
  runner, alternate config, collator, and collator test are deleted so there is no
  executable path that can regenerate it by launching Node.
- Owned-server readiness proves `/api/server-info` runtime/provenance identifies
  `freshell-server`; unauthenticated health alone is insufficient.

- [ ] **Step 1: Write the failing behavioral test**

  Add `selection-nonvacuity.test.ts` to import local/cloud configs and fixture
  factories, asserting the one-project/literal-Rust contract, positive floors,
  no legacy helper import (including the visible-first audit runner), no cloud
  skip for Tasks 2-4 specs, and a provenance failure when a fake healthy process
  reports a non-Rust runtime. Update current helper tests to expect only
  `RustServer` construction.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:e2e:helpers
  npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=chromium --list
  ```

  Expected: FAIL because the default fixture is `legacy`, the `chromium` project
  is not yet Rust-explicit, and legacy projects/helpers still exist. The list
  command must not start a server.

- [ ] **Step 3: Add the minimal implementation**

  Make Rust the only owned constructor, retain the external-target no-stop seam,
  and move/rename shared types out of `test-server.ts`. Collapse Playwright to one
  `chromium` project; convert conditional Rust branches to unconditional current
  baseline assertions and delete legacy-only expectations/spec registrations.
  Build `dist/client` and `target/release/freshell-server` in global setup. Point
  Electron remote-connect E2E and `perf:audit:visible-first`'s owned sample server
  at `RustServer`. Delete the completed GATE-01 executable/collator while retaining
  its JSON as frozen historical evidence; update helper-config, teardown, and leak
  comments/types to the new fixture names.

- [ ] **Step 4: Run the focused GREEN command**

  Run:

  ```bash
  npm run test:e2e:helpers
  npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=chromium --list
  ```

  Expected: PASS; output names only `[chromium]`, reports at least 308 tests in at
  least 86 files, and contains no `legacy-chromium` or zero-test warning.

- [ ] **Step 5: Refactor while green**

  Rename matrix descriptions/comments to Rust-baseline language, deduplicate
  owned/external server info types, and centralize exact-child stop/restart logic
  in the Rust fixture. Preserve external-target non-ownership and add a test that
  `stop()` never signals an external PID.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "legacy-chromium|e2eServerKind|TestServer|test-server\.js|dist/server/index" test/e2e-browser test/e2e-electron --glob '!gate01-baseline.json'
  npm run test:e2e -- --project=chromium test/e2e-browser/specs/auth.spec.ts test/e2e-browser/specs/terminal-lifecycle.spec.ts test/e2e-browser/specs/server-restart-recovery.spec.ts test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts
  ```

  Expected: search returns no executable legacy path; configured E2E reports a
  positive count and PASSes, and server-info provenance in every worker identifies
  the owned Rust binary on a non-3001 port.

- [ ] **Step 7: Commit the task**

  ```bash
  git add test/e2e-browser test/setup/e2e-browser-global-setup.ts test/e2e-electron/electron-app.test.ts
  git commit -m "test: make browser coverage Rust-only"
  ```

### Task 5: Retire Dead Contracts and Rebase Active Port Oracles on Rust

**Files:**

- Modify: `shared/ws-protocol.ts`
- Modify: `crates/freshell-protocol/src/{client_messages,server_messages,common}.rs`
- Modify: `crates/freshell-protocol/tests/roundtrip.rs`
- Modify: `crates/freshell-ws/src/{terminal,reconcile}.rs`
- Modify: `crates/freshell-ws/tests/live_session_ref_guard.rs`
- Modify: `src/lib/api.ts`
- Delete: `src/store/freshAgentThunks.ts`
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/lib/fresh-agent-ws.test.ts`
- Delete: `test/helpers/visible-first/protocol-harness.ts`
- Delete: `test/helpers/visible-first/read-model-route-harness.ts`
- Delete: `test/helpers/visible-first/terminal-mirror-fixture.ts`
- Delete: `test/unit/visible-first/protocol-harness.test.ts`
- Delete: `test/unit/visible-first/read-model-route-harness.test.ts`
- Delete: `test/unit/visible-first/terminal-mirror-fixture.test.ts`
- Modify: `test/unit/visible-first/acceptance-contract.test.ts`
- Modify: `port/contract/ws-message-inventory.json`
- Regenerate: `port/contract/ws-protocol.schema.json`
- Regenerate: `port/contract/ws-server-messages.schema.json`
- Delete: `port/contract/generate-manifest-oracle.ts`
- Modify: `port/contract/README.md`
- Modify: `crates/freshell-extensions/Cargo.toml`
- Modify: `crates/freshell-extensions/src/lib.rs`
- Modify: `crates/freshell-extensions/tests/oracle.rs`
- Delete: `port/oracle/baselines/batch/generate-batch-goldens.ts`
- Modify: `crates/freshell-terminal/tests/batch_wire_golden.rs`
- Modify: `port/oracle/harness/external-server.ts`
- Modify: `port/oracle/harness/normalize.ts`
- Modify: `port/oracle/harness/invariants.ts`
- Modify: `port/oracle/harness/t2-live.ts`
- Modify: `port/oracle/harness/t2-live-claude.ts`
- Modify: `port/oracle/harness/t2-live-codex.ts`
- Delete: `port/oracle/harness/opencode-warm-proxy.ts`
- Create: `test/unit/port/oracle/rust-only-oracle-boundary.test.ts`
- Modify: `test/unit/port/oracle/{external-handshake-t0,t0-equivalence-rust,t1-equivalence-rust,t1-batch-equivalence-rust,freshagent-wireshape-differential}.test.ts`
- Move: `test/unit/port/oracle/t2-opencode-equivalence-rust.test.ts` to `test/unit/port/oracle/t2-opencode-rust-baseline.test.ts`
- Move: `test/unit/port/oracle/t2-claude-equivalence-rust.test.ts` to `test/unit/port/oracle/t2-claude-rust-baseline.test.ts`
- Move: `test/unit/port/oracle/t2-codex-equivalence-rust.test.ts` to `test/unit/port/oracle/t2-codex-rust-baseline.test.ts`
- Delete: `test/integration/port/oracle/{t2-claude-haiku,t2-codex-gptmini,t2-opencode-kimi}.test.ts`
- Modify: `config/vitest/vitest.oracle.config.ts`
- Delete: `config/vitest/vitest.oracle-t2.config.ts`
- Modify: `package.json`

**Interfaces:**

- `codingcli.create/input/kill` and `codingcli.created/event/exit/stderr/killed`
  are absent from TS/Rust schemas, handlers, inventories, and generated schemas.
- `api.ts` no longer exports terminal viewport/paged-scrollback or paged
  fresh-agent-turn helpers; no production caller exists. Whole-thread snapshots,
  WS terminal replay, and terminal search remain.
- Client WS tests construct normalized Rust-baseline provider event frames
  directly; they do not import Node SDK/OpenCode adapter implementations merely
  to make test input.
- Oracle target selection is Rust-only. T0 asserts Rust schema conformance and
  two-boot determinism; T1 asserts Rust bytes against committed goldens and keeps
  mutation tests that prove comparisons bite; wire-shape checks compare current
  Rust to a committed normalized Rust fixture with at least one captured frame.
- The gated T2 provider contracts have no `target`/warm-proxy switch and always
  start an owned Rust server. They assert fatal lifecycle/persistence invariants,
  positive event counts, request ceilings, isolated writes, and exact-child
  teardown; they do not compare with or read the historical original-side T2
  JSON files. They prove ownership from their own PID ledger and never inspect,
  connect to, or make assertions about a listener on port 3001.
- Those real-provider T2 contracts remain explicitly opt-in and may skip when
  `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS` is unset. They are useful supplemental
  provider checks, not required replacement coverage for any deleted Node test;
  always-running fake/provider-shape Rust tests own retirement closure.
- Historical reports/baselines stay untouched as provenance, but no active oracle
  command can build or launch Node.
- `crates/freshell-extensions/fixtures/manifest-oracle.json` remains a frozen
  migration artifact consumed by Rust mutation tests; its Node schema generator
  and active regeneration claim are removed from the contract README, crate
  metadata/docs, and oracle test.
- `port/oracle/baselines/batch/*.json` likewise remain frozen byte goldens for
  `batch_wire_golden.rs`; the Node terminal-stream generator is deleted and the
  Rust test's mutation assertion keeps the fixture non-vacuous.

- [ ] **Step 1: Write the failing behavioral test**

  Tighten protocol/API tests to assert the dead discriminators and exports are
  rejected/absent. Change T0/T1/wire-shape tests to request only an owned Rust
  target, require a nonempty capture, compare two Rust boots or committed Rust
  fixtures, and prove a one-field/one-byte mutation fails the comparator. Change
  the visible-first acceptance test to require its focused lane to omit the
  Node-backed protocol harness while retaining the static contract and report
  tests. Tighten the Rust extension fixture test to require a nonempty fixture and
  prove a changed expected verdict fails, without importing the deleted Node
  manifest generator. Rewrite the client fresh-agent WS cases to feed literal
  normalized Rust-baseline frames instead of importing Node provider adapters.
  Add `rust-only-oracle-boundary.test.ts` as an always-running source/exports
  guard: it rejects a `node` target, warm-proxy module, legacy build command, or
  active read of `port/oracle/baselines/t2/*.json` even when live-provider gates
  are off. It also rejects `listenersOn3001`/`ss`-based inspection; an assertion
  that an allocated owned port is not 3001 remains allowed.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/client/lib/api.test.ts --config config/vitest/vitest.config.ts
  npm run test:vitest -- run test/unit/visible-first/acceptance-contract.test.ts --config config/vitest/vitest.config.ts
  npm run test:vitest -- run test/unit/port --config config/vitest/vitest.port.config.ts
  cargo test -p freshell-protocol -p freshell-ws -p freshell-terminal -p freshell-extensions --locked
  env -u FRESHELL_RUN_REAL_PROVIDER_CONTRACTS npm run test:oracle
  ```

  Expected: FAIL because dead messages/helpers still parse/export and the oracle
  still constructs a Node target or compares against a live original.

- [ ] **Step 3: Add the minimal implementation**

  Delete the caller-free client helpers/thunks and the full `codingcli.*` family
  in both languages, regenerate the committed schemas/inventory, and remove the
  Rust no-op/guard handlers. Delete the three self-testing visible-first harnesses
  that instantiate Node `WsHandler`, Express routes for removed endpoints, or the
  Node terminal replay ring; update `test:visible-first:contract` to select only
  `acceptance-contract.test.ts` and `visible-first-acceptance-report.test.ts`
  through `npm run test:vitest -- run ... --config
  config/vitest/vitest.config.ts`.
  Make the external oracle harness wrap the existing owned Rust fixture, delete
  Node build/spawn/copy logic and original-side live generators, and reframe
  current tests around Rust determinism plus committed goldens/fixtures. Preserve
  mutation tests and nonempty-capture assertions. Delete the Node extension
  manifest generator and document its committed output as frozen migration
  provenance rather than an active regeneration workflow. Delete the Node batch
  generator too and update the consuming Rust golden test's provenance comment;
  keep its byte-mutation bite proof. Collapse each T2 harness to Rust-only owned
  startup, delete the OpenCode warm proxy, rename the three gated tests to
  Rust-baseline files, and replace original-fixture equality with invariant,
  positive-event, isolation, cost-ceiling, and cleanup assertions. Keep the old
  T2 JSON only as unreferenced historical evidence. Delete the original-side T2
  integration files, their dedicated config, and `test:oracle:t2`; the retained
  Rust T2 contracts remain opt-in under `test:oracle`. Remove their snapshots of
  port-3001 listeners; exact owned-PID teardown is the safety proof.

- [ ] **Step 4: Run the focused GREEN command**

  Run the Step 2 commands again.

  Expected: PASS; schema generation has no drift, the Rust crates reject removed
  messages, client exports are gone, and every active always-running oracle
  starts/reaps only an owned Rust process on a non-3001 port. Opt-in T2 skips are
  reported as supplemental and are not counted as replacement coverage.

- [ ] **Step 5: Refactor while green**

  Rename `equivalence` descriptions to `Rust baseline` or `determinism`, extract a
  single Rust oracle boot helper, and retain the smallest committed fixtures that
  exercise each comparator. Do not rewrite historical Markdown/PNG/JSON evidence
  merely for mentioning the original server.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "codingcli\.|getTerminalViewport|getTerminalScrollback|loadFreshAgent(ThreadTurns|TurnBody)" shared src crates/freshell-protocol crates/freshell-ws port/contract test/unit/port
  ! rg -n "target: ['\"]node|FRESHELL_ORACLE_TARGET|build:server|dist/server/index|new TestServer|warmProxy|opencode-warm-proxy|baselines/t2" port/oracle/harness config/vitest/vitest.oracle.config.ts test/unit/port/oracle package.json --glob '!rust-only-oracle-boundary.test.ts'
  ! rg -n "listenersOn3001|ss .*3001|grep.*3001" port/oracle/harness test/unit/port/oracle --glob '!rust-only-oracle-boundary.test.ts'
  ! rg -n "server/extension-manifest|generate-manifest-oracle" port/contract package.json
  ! rg -n "server/terminal-stream|generate-batch-goldens" port/oracle/baselines/batch crates/freshell-terminal/tests/batch_wire_golden.rs
  contract_hash_before="$(sha256sum port/contract/ws-message-inventory.json port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json)"
  npm run contract:generate
  contract_hash_after="$(sha256sum port/contract/ws-message-inventory.json port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json)"
  test "$contract_hash_before" = "$contract_hash_after"
  ```

  Expected: all searches return no active match; generation completes and the
  generated files are already up to date.

- [ ] **Step 7: Commit the task**

  ```bash
  git add shared/ws-protocol.ts crates/freshell-protocol crates/freshell-ws crates/freshell-terminal/tests/batch_wire_golden.rs crates/freshell-extensions/Cargo.toml crates/freshell-extensions/src/lib.rs crates/freshell-extensions/tests/oracle.rs src/lib/api.ts src/store/freshAgentThunks.ts test/unit/client/lib/api.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/helpers/visible-first test/unit/visible-first port/contract port/oracle/baselines/batch port/oracle/harness test/unit/port/oracle test/integration/port/oracle config/vitest/vitest.oracle.config.ts config/vitest/vitest.oracle-t2.config.ts package.json
  git commit -m "refactor: retire Node-only contracts and oracles"
  ```

### Task 6: Make Source Build, Start, and Broad Tests Rust-First and Non-Vacuous

**Files:**

- Create: `scripts/start-rust-server.ts`
- Create: `scripts/testing/run-rust-tests.ts`
- Create: `test/unit/tooling/testing/test-selection.test.ts`
- Create: `test/integration/tooling/source-runtime-rust.test.ts`
- Modify: `package.json`
- Modify: `scripts/launch.sh`
- Modify: `scripts/launch-rust.sh`
- Modify: `run-rust-server.sh`
- Modify: `port/laptop-bootstrap/2-bootstrap-wsl.sh`
- Modify: `scripts/run-standard-tests.ts`
- Modify: `scripts/testing/coordinator-command-matrix.ts`
- Modify: `scripts/testing/test-coordinator.ts`
- Modify: `scripts/vitest-cloud.sh`
- Modify: `scripts/test/cloud-vitest-wrapper.test.sh`
- Modify: `docker/cloud-run/entrypoint.sh`
- Modify: `config/vitest/vitest.config.ts`
- Modify: `test/unit/vite-config.test.ts`
- Delete: `config/vitest/vitest.server.config.ts`
- Delete: `config/vitest/vitest.codex-real-provider-smoke.config.ts`
- Delete: `config/vitest/vitest.opencode-serve-real-provider-smoke.config.ts`
- Delete: `test/setup/server-global-setup.ts`
- Delete: `tsconfig.server.json`
- Delete: `test/integration/real/codex-app-server-fork-shape-contract.test.ts`
- Delete: `test/integration/real/codex-app-server-readiness-contract.test.ts`
- Delete: `test/integration/real/codex-remote-fork-contract.test.ts`
- Delete: `test/integration/real/coding-cli-session-contract.test.ts`
- Delete: `test/helpers/coding-cli/real-session-contract-harness.ts`
- Delete: `test/integration/extension-system.test.ts`
- Move: retained files from `test/unit/server/claude-sidecar/**` to `test/unit/claude-sidecar/**`
- Move: retained coordinator/global-setup tests from `test/unit/server/testing/**` to `test/unit/tooling/testing/**`
- Move: `test/unit/server/deploy-tab-diff-coverage-gate.test.ts` to `test/unit/tooling/deploy-tab-diff-coverage-gate.test.ts`
- Move: `test/unit/server/prebuild-guard.test.ts` to `test/unit/tooling/prebuild-guard.test.ts`
- Move: `test/unit/server/run-standard-tests.test.ts` to `test/unit/tooling/run-standard-tests.test.ts`
- Move: `test/unit/server/opencode-rebind-plugin.test.ts` to `test/unit/extensions/opencode-rebind-plugin.test.ts`
- Move: `test/unit/server/rust-claude-snapshot-contract.test.ts` to `test/unit/contracts/rust-claude-snapshot-contract.test.ts`
- Move: `test/unit/server/amplifier-cli-isolation.test.ts` to `test/unit/provider-fixtures/amplifier-cli-isolation.test.ts`
- Modify: `crates/freshell-tauri/tests/server_spawn_smoke.rs`
- Modify: `.github/workflows/rust-clippy.yml`

**Interfaces:**

- `dev:server` runs `cargo run -p freshell-server --locked`; `dev` runs Vite plus
  that Rust server. `build:rust`, `check:rust`, and `test:rust` are explicit.
  `build` produces client, tools, and release `freshell-server`; `start` executes
  the release Rust binary through the cross-platform signal-forwarding script.
- `scripts/launch.sh` is a compatibility forwarder to the safe Rust launcher;
  `launch-rust.sh` remains canonical and exact-PID verified. Root
  `run-rust-server.sh` no longer advertises the Node command, and the retained
  laptop bootstrap invokes the Rust-inclusive build/start contract rather than
  inheriting a Node-server build path.
- Broad `npm test`/`npm run check`/`npm run verify` cover retained default Vitest,
  `cargo test --workspace --locked`, and Electron Vitest under one coordinator
  gate. `test:server` runs the `freshell-server` crate; `test:integration` runs
  `cargo test --workspace --tests --locked`; `test:unit` remains default
  `test/unit`.
- No required runner uses `--passWithNoTests`. Cloud Vitest runs only the retained
  default config; `--config=server` is rejected with exit 2 and a Rust-lane hint.
  Cargo runs in the Rust lane.
- The default config stops excluding
  `test/unit/visible-first/cli-command-harness.test.ts` and its selection is
  asserted. Its two obsolete Node route/mirror siblings were deleted in Task 5.
- Tauri `server_spawn_smoke` hard-fails when the explicit/sibling Rust binary is
  absent; `run-rust-tests.ts` builds it and sets `FRESHELL_SERVER_BIN` before the
  workspace tests.
- `source-runtime-rust.test.ts` spawns `npm start` on an OS-assigned non-3001
  port with an isolated `FRESHELL_HOME`, explicit test-only `AUTH_TOKEN`, and
  absolute built-client path, then requires the SPA response and authenticated
  server-info provenance to identify the exact release
  `freshell-server` child before exact-PID teardown. It uses
  `// @vitest-environment node` because it owns a child process and filesystem
  fixture.

- [ ] **Step 1: Write the failing behavioral test**

  Add `test-selection.test.ts` and update coordinator/runner tests to require
  client+Rust+Electron broad phases, the script meanings above, absence of the
  server/real-provider Vitest configs and `--passWithNoTests`, removal of their
  now-invalid package scripts, and rejection of a simulated zero selected-test
  result. Require the retained visible-first CLI harness to be selected by the
  default lane. Require the closed runtime manifest to reconcile root launchers
  and `port/**` bootstrap owners. Add the owned source-runtime integration test
  described above. Change the Tauri smoke unit path to panic, not print SKIP,
  when no binary can be resolved.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run build:client
  npm run build:server
  npm run test:vitest -- run test/unit/tooling/testing test/unit/tooling/run-standard-tests.test.ts test/unit/vite-config.test.ts test/integration/tooling/source-runtime-rust.test.ts --config config/vitest/vitest.config.ts
  bash scripts/test/cloud-vitest-wrapper.test.sh
  cargo test -p freshell-tauri --locked --test server_spawn_smoke app_bound_spawn_health_reap_end_to_end -- --exact --nocapture
  ```

  Expected: FAIL because current plans are client+server+Electron Vitest, use
  `--passWithNoTests`, and the Tauri smoke can soft-skip.

- [ ] **Step 3: Add the minimal implementation**

  Move retained non-server tests before removing exclusions/config. Implement the
  Rust phases and source scripts, delete server TypeScript build/typecheck/start
  scripts/config/global setup, and make cloud Vitest one truthful default-config
  lane. Delete the four opt-in provider contracts and PTY harness that import the
  legacy Codex/Claude/OpenCode runtime; they test external-provider or Node
  implementation behavior, not Freshell's retained Rust backend. Delete the two
  dedicated Node-backend real-provider configs/scripts; keep the two independent
  Amplifier contracts excluded and opt-in. The start wrapper resolves `.exe` on
  Windows, forwards argv/signals,
  inherits stdio, emits structured JSONL only for wrapper errors, and never
  backgrounds or kills an unowned PID. Update root `run-rust-server.sh` and the
  retained laptop bootstrap to the same Rust-only build/start contract and
  reclassify their manifest rows. Add the explicit build+env Tauri test
  wrapper and matching CI step. Delete the Node-only extension-system integration
  from the default lane; current Rust extension crate/browser coverage is the
  baseline.

- [ ] **Step 4: Run the focused GREEN command**

  Run:

  ```bash
  npm run build:client
  npm run build:tools
  cargo build --release -p freshell-server --locked
  npm run test:vitest -- run test/unit/tooling/testing test/unit/tooling test/unit/claude-sidecar test/unit/contracts test/unit/provider-fixtures test/unit/visible-first/cli-command-harness.test.ts test/unit/vite-config.test.ts test/integration/tooling/source-runtime-rust.test.ts --config config/vitest/vitest.config.ts
  bash scripts/test/cloud-vitest-wrapper.test.sh
  cargo build -p freshell-server --locked
  FRESHELL_SERVER_BIN="$PWD/target/debug/freshell-server" cargo test -p freshell-tauri --locked --test server_spawn_smoke app_bound_spawn_health_reap_end_to_end -- --exact --nocapture
  cargo test -p freshell-codex --features real-transport --locked
  cargo test -p freshell-opencode --features real-transport --locked
  ```

  Expected: PASS; the Tauri smoke starts/reaps the exact binary on an ephemeral
  port, and no required test selector is empty.

- [ ] **Step 5: Refactor while green**

  Extract typed phase builders for `vitest|cargo|npm`, centralize structured
  child-process logging, and keep Cargo argument routing separate from Vitest file
  filters. Remove old `client|server|electron` naming from status receipts and
  make zero-selection errors include the requested selectors and selected phase.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "vitest\.(server|codex-real-provider-smoke|opencode-serve-real-provider-smoke)|server-global-setup|tsconfig\.server|tsx watch server|dist/server/index|--passWithNoTests|test:real:coding-cli-contracts|test:codex-real-provider-smoke|test:opencode-serve-smoke|npm start" package.json config scripts run-rust-server.sh port/laptop-bootstrap docker/cloud-run test/setup test/unit/tooling .github/workflows/rust-clippy.yml
  test ! -f tsconfig.server.json
  test ! -f config/vitest/vitest.server.config.ts
  test ! -f test/setup/server-global-setup.ts
  npm run typecheck
  FRESHELL_TEST_SUMMARY="retire Node server: Rust broad gate" npm test
  ```

  Expected: search returns no match; absence checks succeed; typecheck and the
  coordinated broad test PASS with nonzero retained Vitest, Rust workspace, and
  Electron phase counts.

- [ ] **Step 7: Commit the task**

  ```bash
  git add -A package.json package-lock.json scripts run-rust-server.sh port/laptop-bootstrap/2-bootstrap-wsl.sh config/vitest test/setup test/unit test/integration test/helpers crates/freshell-tauri .github/workflows/rust-clippy.yml tsconfig.server.json docker/cloud-run/entrypoint.sh
  git commit -m "build: make Rust the default server and test lane"
  ```

### Task 7: Cut Electron App-Bound Lifecycle Over to Rust and Retire Dead Daemon Mode

**Files:**

- Modify: `electron/server-spawner.ts`
- Modify: `electron/startup.ts`
- Modify: `electron/entry.ts`
- Modify: `electron/{types,desktop-config,launch-policy,preload}.ts`
- Modify: `electron/setup-wizard/{wizard-logic,wizard}.tsx`
- Delete: `electron/daemon/**`
- Delete: `installers/systemd/freshell.service.template`
- Delete: `installers/launchd/com.freshell.server.plist.template`
- Delete: `installers/windows/freshell-task.xml.template`
- Modify: `config/electron-builder.yml`
- Modify: `test/unit/electron/{server-spawner,startup,desktop-config,launch-policy,preload}.test.ts`
- Modify: `test/unit/electron/setup-wizard/wizard.test.tsx`
- Delete: `test/unit/electron/daemon/**`
- Create: `test/e2e-electron/app-bound-rust-server.test.ts`
- Modify: Electron tests/fixtures whose config union currently names `daemon`

**Interfaces:**

- Electron's supported `ServerMode` is `app-bound | remote`. The setup wizard no
  longer advertises “Always-running daemon,” startup creates no daemon manager,
  and packaged resources contain no Electron-owned launchd/systemd/Task
  Scheduler templates. A persisted `serverMode: "daemon"` is migrated once to
  `app-bound`, written back atomically, and surfaced through a clear structured
  migration notice; all other persisted fields remain unchanged.
- `ServerSpawnResources` contains `serverBinary`, `clientDir`,
  `claudeNodeBinary`, `claudeSidecarEntry`, `mcpNodeBinary`, `mcpEntry`,
  `homeDir`, `configDir`, and `logDir`. No `nodeBinary`, `serverEntry`, native
  modules, server modules, or `NODE_PATH` exists. Startup derives `homeDir` as
  the parent of its existing absolute `configDir` and rejects a config directory
  whose basename is not `.freshell`; `logDir` is `configDir/logs`.
- App-bound spawn env sets `PORT`, `FRESHELL_HOME`, `FRESHELL_CLIENT_DIR`,
  `FRESHELL_CLAUDE_NODE`, `FRESHELL_CLAUDE_SIDECAR`, `FRESHELL_MCP_NODE`, and
  `FRESHELL_MCP_ENTRY`; `FRESHELL_HOME` is exactly `homeDir`. The child working
  directory is exactly `configDir`, so Rust loads `AUTH_TOKEN` from the existing
  `.env`; token values are never logged. Dev uses
  `target/debug/freshell-server`; packaged mode uses
  `resources/bin/freshell-server[.exe]`. Readiness verifies authenticated
  server-info provenance.
- App-bound ownership is the exact `ChildProcess` returned by spawn. Close/error
  handlers clear that reference. Stop signals only that child, waits to a fixed
  first deadline, escalates only that same PID, waits to a second fixed deadline,
  and reports failure if it is still alive. No path/command-line scan or broad
  kill is permitted. “Stopped” means the owned backend process exited; this task
  adds no descendant-survival or restart-continuity guarantee.
- `installers/systemd/freshell-rust.service` remains the supported standalone
  Rust service and is not an Electron daemon resource.

- [ ] **Step 1: Write the failing behavioral test**

  Change spawner/startup/config/wizard tests to require the exact Rust command
  and env, reject every Node-server field, reject daemon as a new configuration,
  and prove a persisted daemon value migrates atomically to app-bound. Add
  lifecycle tests with two same-path fake server processes: stopping Electron
  reaps only its captured child, clears the reference on close/error, waits after
  escalation, and reports a second-deadline failure. Add app-bound E2E that
  launches Electron with staged Rust/MCP/Claude fixtures, authenticates, verifies
  server-info runtime/commit, exits the app, and proves the exact Rust child is
  gone while the foreign same-path process remains.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:electron -- test/unit/electron/server-spawner.test.ts test/unit/electron/startup.test.ts test/unit/electron/desktop-config.test.ts test/unit/electron/launch-policy.test.ts test/unit/electron/setup-wizard/wizard.test.tsx test/unit/electron/daemon
  ```

  Expected: FAIL because Electron currently plans bundled Node plus
  `resources/server/index.js`, advertises daemon mode, constructs a daemon
  manager, and Windows daemon stop can target a foreign same-path process.

- [ ] **Step 3: Add the minimal implementation**

  Replace the spawn/resource types atomically, invoke the Rust binary with no
  server script argument, set only the explicit Rust/client/MCP/Claude env, and
  preserve cwd, redacted JSONL log piping, health timeout, and double-start
  handling. Implement exact captured-child bounded stop. Remove daemon from the
  schema/wizard/startup/IPC surface, migrate persisted daemon config to
  app-bound, delete `electron/daemon/**` and its three templates/tests, and remove
  those resources from electron-builder. Dev startup requires the Task 6 debug
  build; it never falls back to tsx/Node backend.

- [ ] **Step 4: Run the focused GREEN command**

  Run the Step 2 command without the now-deleted `test/unit/electron/daemon`
  selector.

  Expected: PASS; every captured backend command begins with
  `freshell-server[.exe]`, required env paths are absolute, exact-child stop is
  bounded, daemon config migrates, and daemon cannot be newly selected.

- [ ] **Step 5: Refactor while green**

  Extract `resolveDesktopRuntimeResources(resourcesPath, platform, isDev)` as a
  pure app-bound function and a reusable exact-child wait helper. Keep process
  identity tied to the spawn handle, preserve paths-with-spaces cases on every
  platform, and ensure lifecycle/migration logs are redacted structured JSONL.
  Remove dead daemon-only preload/launch-policy branches and fixtures.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "server/index|NODE_PATH|server-node-modules|nativeModules|nodeBinary|serverEntry|serverMode.*daemon|Always-running daemon|createDaemonManager" electron config/electron-builder.yml
  test ! -d electron/daemon
  test ! -e installers/systemd/freshell.service.template
  test -f installers/systemd/freshell-rust.service
  cargo build -p freshell-server --locked
  npm run build:electron
  npm run test:e2e:electron -- test/e2e-electron/app-bound-rust-server.test.ts
  ```

  Expected: search and absence checks PASS; the standalone Rust service remains;
  Electron build/E2E authenticate to a non-3001 owned `freshell-server`, stop
  that backend PID exactly, and leave the foreign same-path fixture alive until
  the fixture performs its own exact cleanup.

- [ ] **Step 7: Commit the task**

  ```bash
  git add -A electron installers config/electron-builder.yml test/unit/electron test/e2e-electron
  git commit -m "feat: run Electron app-bound backend in Rust"
  ```

### Task 8: Package the Rust Server and Only Sanctioned Node Runtimes in Electron

**Files:**

- Create: `scripts/prepare-electron-runtime.ts`
- Create: `scripts/verify-electron-artifact.ts`
- Create: `test/unit/electron/prepare-electron-runtime.test.ts`
- Create: `test/unit/electron/verify-electron-artifact.test.ts`
- Create: `test/integration/electron/checkout-free-runtime.test.ts`
- Modify: `scripts/prepare-bundled-node.ts` by extracting reusable Node-download code, then delete it
- Modify: `scripts/bundled-node-version.json`
- Modify: `scripts/assert-native-windows-build.ts`
- Modify: `config/electron-builder.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete after migration: generated/staging assumptions for `server-node-modules` and `bundled-node/native-modules`
- Delete/replace: `test/unit/electron/prepare-bundled-node.test.ts`

**Interfaces:**

- `prepare-electron-runtime --platform <darwin|linux|win32> --arch <x64|arm64>`
  stages `electron-runtime/bin/freshell-server[.exe]`, `dist/client`,
  `electron-runtime/node/bin/node[.exe]`,
  `electron-runtime/claude-sidecar/**`, and
  `electron-runtime/mcp/**`. The MCP directory contains
  `dist/tools/freshell-mcp`, shared compiled client modules, and only the locked
  production dependency closure for `@modelcontextprotocol/sdk` and `zod`.
- The Node binary is sanctioned for the Claude sidecar and standalone MCP client
  only. Staging contains no `node-pty`, Freshell Node backend entrypoint,
  `dist/server`, `server-node-modules`, or native-module rebuild output. The MCP
  SDK's locked closure may include dormant HTTP-framework libraries such as
  Express; structural and execution tests prove that the stdio MCP entrypoint
  never listens or becomes Freshell's backend.
- Node archive extraction retains the existing locked `extract-zip` and `tar`
  libraries, their integrity checks, and cross-platform error handling. The
  retirement does not introduce a host-`tar` prerequisite merely to remove the
  Node backend; failures emit redacted structured JSONL context.
- `verify-electron-artifact(path, platform)` fails unless the native Rust binary,
  client index, MCP entry/dependencies, Claude entry/dependencies, and Node runtime
  exist; it fails on any forbidden artifact or if the Rust binary cannot be
  executed on the native host. Its bounded execution probe uses an empty temporary
  cwd, removes `AUTH_TOKEN`, `.env` discovery, and inherited Freshell config env,
  and requires exit code 1 plus
  `AUTH_TOKEN is required. Refusing to start without authentication.` before any
  listen event; it never starts a listening service. Foreign-platform
  artifacts receive structural format checks locally and the native CI matrix
  performs the execution probe.
- `electron:build`/`:win` build the host-native Rust server and tools, stage the
  runtime, package, and verify the unpacked artifact before installers upload.
- `checkout-free-runtime.test.ts` copies the staged runtime to a temporary root
  outside the checkout, runs with empty cwd/`NODE_PATH` and no root
  `node_modules`, authenticates to Rust server-info, fetches the SPA plus a real
  hashed asset, exercises the fake-Claude hook, speaks stdio JSON-RPC to the
  compiled MCP entry with no listening socket, and reaps every exact owned child.

- [ ] **Step 1: Write the failing behavioral test**

  Add staging and artifact tests with an injected binary-probe runner and temporary
  fake resource tree. Require the exact allowlist, assert each forbidden name
  fails verification, and assert the probe runs in an empty cwd with auth/config
  env removed and a deadline. Add the checkout-free acceptance test above, with
  deliberate failures when it can see checkout files/root `node_modules`, MCP
  writes non-JSON-RPC stdout, or any owned PID survives. Change the Windows
  platform check message to require native Rust `.exe` production, not native
  `node-pty` compilation.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:electron -- test/unit/electron/prepare-electron-runtime.test.ts test/unit/electron/verify-electron-artifact.test.ts test/unit/electron/native-windows-build-script.test.ts
  ```

  Expected: FAIL because staging/verifier modules do not exist and builder config
  still requires Node-server/native-module resources.

- [ ] **Step 3: Add the minimal implementation**

  Refactor the verified Node download to the new staging script, delete header and
  `node-pty` rebuild/pruned-server-dependency logic, copy the host-native Cargo
  binary, build/copy `dist/tools`, and stage the two permitted Node consumers with
  their locked dependency closures. Preserve the locked archive libraries and
  extraction checks. Rewrite electron-builder resources and npm Electron scripts
  to use the staging directory and invoke the verifier on the unpacked result;
  package only app-bound resources, with no Electron daemon templates.

- [ ] **Step 4: Run the focused GREEN command**

  Run:

  ```bash
  npm run test:electron -- test/unit/electron/prepare-electron-runtime.test.ts test/unit/electron/verify-electron-artifact.test.ts test/unit/electron/native-windows-build-script.test.ts
  npm run build:client
  npm run build:tools
  cargo build --release -p freshell-server --locked
  npm run prepare:electron-runtime
  npm run test:vitest -- run test/integration/electron/checkout-free-runtime.test.ts --config config/vitest/vitest.electron.config.ts
  ```

  Expected: PASS; staging contains every allowlisted resource and none of the
  forbidden Node-server/native-module paths, and the copied runtime works without
  checkout or root dependency access.

- [ ] **Step 5: Refactor while green**

  Split pure layout planning, dependency-closure calculation, and filesystem copy
  execution. Add stable sorted JSONL receipts with file hashes and `severity` but
  no tokens. Make the verifier share the same declarative allowlist without
  allowing the producer to suppress forbidden-file checks.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "dist/server|server-node-modules|node-pty|native-modules|prepare-bundled-node" config/electron-builder.yml scripts package.json --glob '!verify-electron-artifact.ts' --glob '!prepare-electron-runtime.ts'
  npm run electron:build
  npm run verify:electron-artifact
  ```

  Expected: search returns no match; the native host build/verification PASS and
  reports a runnable `freshell-server`, client, MCP, and Claude sidecar, with zero
  forbidden artifacts. This command does not launch or deploy a server.

- [ ] **Step 7: Commit the task**

  ```bash
  git add scripts/prepare-electron-runtime.ts scripts/verify-electron-artifact.ts scripts/assert-native-windows-build.ts scripts/bundled-node-version.json config/electron-builder.yml package.json package-lock.json test/unit/electron test/integration/electron
  git add -u scripts/prepare-bundled-node.ts
  git commit -m "build: package Rust backend in Electron"
  ```

### Task 9: Make Containers, CI, and Release Artifacts Rust-Only

**Files:**

- Modify: `examples/docker/Dockerfile`
- Modify: `docker/cloud-run/Dockerfile`
- Modify: `docker/cloud-run/entrypoint.sh`
- Modify: `docker/cloud-run/test-durations.txt`
- Modify: `.github/workflows/rust-clippy.yml`
- Modify: `.github/workflows/typecheck-client.yml`
- Modify: `.github/workflows/electron-build.yml`
- Modify: `.github/workflows/electron-release.yml`
- Create: `test/unit/tooling/distribution-runtime.test.ts`
- Create: `scripts/verify-container-layout.sh`
- Create: `test/fixtures/distribution/rust-only/**`
- Create: `test/fixtures/distribution/node-server/**`

**Interfaces:**

- The example image is a Rust server + built client example and no longer claims
  Node-only extension lifecycle support. Its final command is
  `/app/freshell-server`; Node is present at runtime only when the staged Claude
  sidecar/MCP client is included and is never the container entrypoint.
- The Cloud E2E image builds/copies `freshell-server`, `dist/client`, and
  `dist/tools`; it does not compile/copy `dist/server` or install native build
  prerequisites for `node-pty`. Until Task 10 removes the legacy dependencies
  from the root lock, its Node tooling stage uses `npm ci --ignore-scripts` and a
  declared removal/assertion step for the exact Task 10 backend-only dependency
  directories before copying `node_modules`; the final image contains none of
  them. The intermediate E2E image still contains the tracked legacy source so
  the runtime-boundary test observes the same tree as local Vitest; Task 11
  rebuilds after Task 10 and proves that source is absent from final images.
- Required CI runs `cargo fmt`, clippy including real-transport feature lanes,
  `cargo build -p freshell-server`, and `cargo test --workspace --locked` with
  `FRESHELL_SERVER_BIN` set for the non-skipping Tauri smoke. Retained Vitest and
  Electron tests have required jobs: `typecheck-client.yml` runs client
  typecheck plus the nonempty default Vitest lane, `rust-clippy.yml` owns Cargo,
  and `electron-build.yml` runs Electron Vitest before packaging on every matrix
  OS.
- Electron build/release matrix installs Rust 1.96.0, builds the native server,
  verifies each unpacked artifact, runs the checkout-free authenticated runtime
  acceptance (server-info, SPA asset, PTY creation/I/O, fake Claude, stdio MCP,
  exact cleanup), and uploads only verified installers. Required PR checks own
  this proof on `macos-15-intel`, `macos-latest`, `ubuntu-latest`, and
  `windows-2022`; the plan does not add a branch-only dispatch path.

- [ ] **Step 1: Write the failing behavioral test**

  Add `distribution-runtime.test.ts` to parse Dockerfiles/workflows and require
  Rust entrypoints/build/test jobs, Electron `crates/**` path triggers,
  the four-target required native acceptance, artifact verification, and absence
  of Node-server build or artifact names. Add `verify-container-layout.sh`
  fixture tests that fail a staged `dist/server/index.js` and accept the
  Rust/client/tools layout.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/tooling/distribution-runtime.test.ts --config config/vitest/vitest.config.ts
  ```

  Expected: FAIL because the example CMD is Node, Cloud Docker builds
  `dist/server`, CI lacks workspace Cargo tests, and Electron workflows lack Rust
  prerequisites/artifact verification.

- [ ] **Step 3: Add the minimal implementation**

  Convert both container builds/entrypoints, remove server Vitest vocabulary and
  `--passWithNoTests` from cloud execution, and make empty discovery a hard
  failure. Make the cloud Node stage ignore lifecycle scripts, remove and assert
  absence of the explicit backend-only dependency directories before runtime
  copy; Task 10's lockfile pruning makes that transitional removal a no-op. Add
  the Cargo test job and native Electron Rust setup/build/verify steps. Expand
  Electron path filters to `crates/**`, `Cargo.toml`, `Cargo.lock`, tools, and
  runtime scripts. Run Task 8's checkout-free acceptance against the unpacked
  native artifact in every matrix job, including an authenticated PTY round trip
  and exact cleanup. Keep the permitted Node test/browser/MCP/Claude runtimes
  explicit in comments and image checks.

- [ ] **Step 4: Run the focused GREEN command**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/tooling/distribution-runtime.test.ts --config config/vitest/vitest.config.ts
  bash scripts/verify-container-layout.sh --fixture test/fixtures/distribution/rust-only
  docker build --tag freshell-retire-node-server-v2-cloud --file docker/cloud-run/Dockerfile .
  docker build --tag freshell-retire-node-server-v2-example --file examples/docker/Dockerfile .
  docker image inspect freshell-retire-node-server-v2-cloud --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}'
  docker image inspect freshell-retire-node-server-v2-example --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}'
  docker run --rm --entrypoint /bin/sh freshell-retire-node-server-v2-cloud -c 'test -x /app/target/release/freshell-server && test -f /app/dist/client/index.html && test -f /app/dist/tools/freshell-mcp/server.js && test ! -e /app/dist/server && test ! -e /app/node_modules/node-pty'
  docker run --rm --entrypoint /bin/sh freshell-retire-node-server-v2-example -c 'test -x /app/freshell-server && test -f /app/dist/client/index.html && test ! -e /app/dist/server && test ! -e /app/node_modules'
  ```

  Expected: PASS; the example image command is `/app/freshell-server`; the cloud
  image retains only its E2E shard entrypoint, whose Rust-only fixture contract is
  asserted by `distribution-runtime.test.ts`. The two non-server container probes
  find the required Rust/client/tool artifacts with no `dist/server`. Neither
  probe starts Freshell or binds a port.

- [ ] **Step 5: Refactor while green**

  Reuse the artifact forbidden/required-name list in container and Electron
  verification, pin Rust/Node versions in one documented workflow location, and
  make shell verifier diagnostics structured JSONL with `severity`, `event`, and
  sorted path evidence.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "node dist/server|build:server|dist/server|server-node-modules|node-pty|vitest\.server|--passWithNoTests" examples/docker docker/cloud-run .github/workflows
  cargo fmt --all --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  ```

  Expected: search returns no match and all local Rust checks PASS. The Tauri
  smoke output names the explicit built server and contains no SKIP.

- [ ] **Step 7: Commit the task**

  ```bash
  git add examples/docker docker/cloud-run .github/workflows test/unit/tooling/distribution-runtime.test.ts scripts/verify-container-layout.sh test/fixtures/distribution
  git commit -m "ci: enforce Rust-only backend artifacts"
  ```

### Task 10: Delete the Legacy Node Backend, Tests, Scripts, and Dependencies

**Files:**

- Delete: `server/**`
- Delete: `test/server/**`
- Delete: remaining `test/unit/server/**`
- Delete: `test/integration/server/**`
- Delete: `test/integration/{session-repair,session-search-e2e}.test.ts`
- Delete: `test/helpers/coding-cli/fake-codex-launch-planner.ts`
- Delete: `test/fixtures/fresh-agent/claude/thread.ts`
- Delete: `scripts/{find-corrupted,repair-one,repair-all}.ts`
- Delete: `scripts/proofs/terminal-catchup-pty-metrics.ts`
- Delete: `port/oracle/interchange/*.mjs`
- Delete: `port/oracle/matrix/*.mjs`
- Delete: `port/oracle/rest-parity/sweep.mjs`
- Delete: `port/oracle/robustness/kill-probe.mjs`
- Delete: `port/oracle/indexer/{sd-probe.mjs,seed.sh}`
- Delete: `port/oracle/t3/{gen-summary.mjs,global-setup.target.ts,playwright.target.config.ts}`
- Modify: `package.json`
- Regenerate: `package-lock.json`
- Modify: `.gitignore` only for obsolete generated Node-server directories
- Modify: `scripts/retirement/runtime-boundary.ts`
- Modify: `test/unit/architecture/rust-only-server-runtime.test.ts`
- Create: `scripts/retirement/node-test-disposition.json`
- Create: `scripts/retirement/verify-node-test-disposition.ts`
- Create: `test/unit/architecture/node-test-disposition.test.ts`

**Interfaces:**

- The tracked `server/` directory does not exist. No package/config/script/test
  compiles, emits, imports, or launches it.
- Root production dependencies remove Node-backend-only
  `@ai-sdk/google`, root `@anthropic-ai/claude-agent-sdk`, `ai`, `chokidar`,
  `cookie-parser`, `dotenv`, `express`, `express-rate-limit`, `glob`, `node-pty`,
  `pino`, `rotating-file-stream`, and `is-port-reachable`; dev dependencies remove
  `@types/cookie-parser`, `@types/express`, `@types/supertest`, `supertest`,
  `superwstest`, and `pino-pretty`. Keep `extract-zip` and `tar` for reliable
  cross-platform Electron runtime staging, `diff` for the client, and
  `@modelcontextprotocol/sdk` for the retained MCP client. The
  Claude SDK remains only in `crates/freshell-claude-sidecar/package*.json`.
  Transitive packages required by the retained MCP SDK may remain in the lock;
  the forbidden set is absent from the root's direct dependency ownership and
  no retained entrypoint imports it as a Freshell backend.
- Deleted Node tests are not mechanically ported. Retained behavior stays covered
  by current Rust crate tests, default Vitest, Rust Playwright, Electron tests,
  and Tasks 1-9 regression tests.
- `node-test-disposition.json` is a committed deletion ledger for the complete
  346-file Task 5/6/10 candidate universe identified by the load-bearing review
  before deletion. Every old test path
  and every independently meaningful subject in a mixed test has a row with the
  old path/title/subject, retained-or-deleted decision, exact surviving test,
  required lane, selector, and latest receipt. Optional real-provider T2 checks
  are marked supplemental and cannot satisfy a required replacement. Unknown,
  duplicate, stale, or unresolved rows block deletion and the final gate.
- Runtime guard debt shrinks to active documentation-only items left for Task 11;
  `unexpectedNodeBackend` stays empty.

- [ ] **Step 1: Write the failing behavioral test**

  Tighten the runtime/dependency test to require `server/` and every Node-server
  test/config/script category absent, require the explicit forbidden dependency
  set absent from root direct dependencies, and require zero imports into
  `server/**`. Add a fixture that proves the allowed CLI/MCP/Claude Node packages
  and their locked transitive dependencies do not satisfy a Node-backend
  detector unless an entrypoint actually listens or owns backend state. Add the
  disposition verifier with a synthetic mixed test whose second subject is
  unresolved, a zero-test selector receipt, and a skipped optional T2 receipt;
  all three must fail required replacement closure.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts
  ```

  Expected: FAIL with concrete `server/**`, Node-test-tree, dependency, and legacy
  maintenance-script debt entries.

- [ ] **Step 3: Add the minimal implementation**

  Before deleting anything, generate and review the complete committed
  disposition ledger from the closed Task 5/6/10 universe. Split mixed files by
  title/subject, bind each retained subject to an exact surviving test/lane and a
  positive-count receipt, mark obsolete Node-implementation subjects explicitly,
  and resolve every row; the verifier refuses an unresolved or vacuous row. Then
  run a retained-fixture import scan and move any provider fixture still
  consumed by Rust/E2E to `test/fixtures/**`; Task 6 already removed the
  Node-runtime provider contracts while preserving the independent Amplifier
  contracts. Then delete the exact legacy trees and scripts, prune the listed
  dependencies/types, and regenerate the root lock with
  `npm install --package-lock-only`. Do not delete shared contracts,
  `dist/tools` sources, Electron, test fixtures used by Rust, or
  `crates/freshell-claude-sidecar`. Do not edit historical plans/reports merely to
  erase references.

- [ ] **Step 4: Run the focused GREEN command**

  Run:

  ```bash
  test ! -d server
  npm install --package-lock-only
  npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts test/unit/architecture/node-test-disposition.test.ts --config config/vitest/vitest.config.ts
  node --import tsx scripts/retirement/verify-node-test-disposition.ts
  npm run typecheck
  ```

  Expected: all commands PASS; the disposition has zero unresolved/vacuous rows
  and the runtime guard reports only active docs/process wording reserved for
  Task 11, with no implementation/build/test dependency on Node backend code.

- [ ] **Step 5: Refactor while green**

  Remove newly unreachable exclusions/path classifiers, collapse empty legacy
  directories, and sort package entries. Replace stale implementation comments in
  active source only when they imply a runnable Node path; keep useful historical
  semantic provenance in Rust comments and committed port reports.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  ! rg -n "from ['\"][^'\"]*server/|import\(['\"][^'\"]*server/|server/index\.(ts|js)|dist/server|tsconfig\.server|node-pty" src shared tools config scripts electron installers docker examples .github test/e2e-browser test/e2e-electron test/integration test/helpers --glob '!scripts/retirement/runtime-boundary.ts' --glob '!scripts/verify-electron-artifact.ts' --glob '!scripts/prepare-electron-runtime.ts' --glob '!scripts/verify-container-layout.sh'
  node --import tsx scripts/retirement/verify-node-test-disposition.ts
  cargo test -p freshell-codex --features real-transport --locked
  cargo test -p freshell-opencode --features real-transport --locked
  npm run build
  FRESHELL_TEST_SUMMARY="legacy Node backend deleted" npm test
  ```

  Expected: search returns no active import/launch/artifact match; the disposition
  ledger has zero unresolved rows; feature-gated transports, build, and broad
  coordinated tests PASS with positive counts.

- [ ] **Step 7: Commit the task**

  ```bash
  git add -A
  git diff --cached --check
  git commit -m "refactor: delete legacy Node application server"
  ```

### Task 11: Update Active Documentation, Repeat Gap Triage, and Prove the Cutover

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.env.example`
- Modify: `docs/development/windows-electron-build.md`
- Modify: `docs/development/test-sandbox.md`
- Modify: `scripts/retirement/runtime-boundary.ts`
- Modify: `test/unit/architecture/rust-only-server-runtime.test.ts`
- Create outside the worktree during execution:
  `/home/dan/code/freshell/.worktrees/.the-usual-logs/retire-node-server-v2/reports/final-node-feature-triage.md`
- Do not modify: `docs/index.html`
- Do not modify: `.kata.toml` unless a real Kata configuration change is independently required

**Interfaces:**

- README describes Rust server install/dev/build/start/serve, standalone Node
  CLI/MCP clients, Electron's packaged app-bound Rust backend, the standalone
  Rust systemd service, the isolated Claude sidecar, and accepted unavailable
  features without advertising deterministic 404s or Electron daemon mode.
- AGENTS command/test/Electron/service guidance matches final scripts and keeps the
  port-3001 approval rule. `.env.example` says Rust server and documents explicit
  packaged MCP/Claude env only where operators can set them. Windows guide builds
  native `freshell-server.exe` and verifies the installer; it no longer mentions
  `conpty.node`/Node backend compilation.
- The sandbox guide retains its destructive-test safety contract but replaces the
  obsolete `node-pty` rationale with current process-kill/config-corruption/restart
  examples.
- Final runtime guard requires `manifestDrift=[]`, `legacyDebt=[]`, and
  `unexpectedNodeBackend=[]`, scans active README/process/release paths, and
  retains historical-plan exclusions. The committed test-disposition verifier
  also requires zero unresolved or vacuous replacement rows.
- The external triage receipt records the final source/caller inventory and
  Kata/GitHub/checklist owner searches. Expected result: every important residual
  remains owned by #624/checklist or another listed issue, so no Kata is created.

- [ ] **Step 1: Write the failing behavioral test**

  Tighten `rust-only-server-runtime.test.ts` to require all three arrays empty and add
  active-document assertions for Rust commands, retained standalone clients, and
  forbidden Node-backend wording/paths. Add assertions that `docs/index.html` and
  `.kata.toml` are unchanged from `origin/main`.

- [ ] **Step 2: Run the test and verify the intended RED**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts
  ```

  Expected: FAIL on current README/AGENTS/.env/Windows-guide legacy statements or
  remaining temporary debt allowlist entries, not on historical plans.

- [ ] **Step 3: Add the minimal implementation**

  Update the five active documents and remove the temporary debt list so the guard
  requires zero. Then create the external triage receipt with exact command,
  timestamp, commit, result, and owner sections. Re-run source/caller searches for
  attachments, exec/diff/send, editor open, extension lifecycle/assets, raw/WS
  browser forwarding, `/api/run`, paged turns, viewport/scrollback,
  `codingcli.*`, and incident dump. For every reachable Rust-absent capability,
  run targeted `kata search --workspace "$PWD" --lexical --limit 20`,
  `kata list --workspace "$PWD" --json`,
  `gh issue list --repo danshapiro/freshell --state all --limit 500 --search`, and
  `rg` over the parity checklist/plans; record the output summary. The expected
  conclusion is `no important untracked residual; no Kata filed`.

  Use this fixed final inventory/owner-search command set and record every command,
  exit code, and summarized result in the receipt:

  ```bash
  rg -n "/api/(fresh-agent/(attachments|exec|diff|send)|files/open|extensions/.*/(start|assets)|proxy/forward|run)|codingcli\.|getTerminalViewport|getTerminalScrollback|loadFreshAgent(ThreadTurns|TurnBody)|debug/fresh-agent" src tools shared crates README.md AGENTS.md
  kata list --workspace "$PWD" --json
  triage_terms=("fresh agent attachments" "fresh agent exec diff" "fresh agent send" "api run automation" "external editor reveal" "extension lifecycle assets" "browser proxy forwarding websocket" "session repair" "fresh agent paged turns" "terminal viewport scrollback" "codingcli websocket" "fresh agent incident")
  for triage_term in "${triage_terms[@]}"; do
    kata search --workspace "$PWD" --lexical --limit 20 "$triage_term" --agent
    gh issue list --repo danshapiro/freshell --state all --limit 500 --search "$triage_term in:title,body" --json number,title,state,url
  done
  gh issue view 624 --repo danshapiro/freshell --json number,title,state,url,body
  gh issue view 165 --repo danshapiro/freshell --json number,title,state,url,body
  gh issue view 6 --repo danshapiro/freshell --json number,title,state,url,body
  rg -n "AGENT-(09|11|13|20)|AUTO-(11|12|13)|BROWSER-0[2-4]|EXT-0[3-9]|FILE-04|SESSION-(11|16|21)|TERM-21" docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
  ```

  The first source/caller search may return only deliberate unsupported-result
  messages/tests represented in active source; the receipt classifies each match
  and fails if it finds a request sender or advertised supported action.

  If and only if contrary implementation evidence establishes a reachable or
  safety-critical gap with independent Rust-only product value and all three
  owner searches are empty, create one acceptance-sized Kata using priority 1, labels
  `enhancement` and `rust-gap`, metadata
  `source=retire-node-server-v2`. Derive the idempotency-key slug from the
  lowercase ASCII capability name, collapse non-alphanumerics to single hyphens,
  trim boundary hyphens, and truncate to 48 characters; concatenate
  `freshell-retire-node-server-v2-`, that slug, and `-20260826`. Store its
  triage/body receipts beside the final receipt, verify it with `kata show` plus
  `kata events`, and verify `.kata.toml` remains unchanged.

- [ ] **Step 4: Run the focused GREEN command**

  Run:

  ```bash
  npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts
  git diff --exit-code origin/main -- docs/index.html .kata.toml
  test -s /home/dan/code/freshell/.worktrees/.the-usual-logs/retire-node-server-v2/reports/final-node-feature-triage.md
  ```

  Expected: PASS; all guard arrays are empty, protected files match
  `origin/main`, the receipt is nonempty and concludes no new Kata unless it names
  and verifies one evidence-backed discovery.

- [ ] **Step 5: Refactor while green**

  Deduplicate README/AGENTS command tables by linking contributor details from
  README rather than copying them, normalize final scanner diagnostics, and remove
  obsolete `legacy`, `original`, and `port` naming only from active commands and
  config. Preserve historical plan/report provenance and the first run's worktree.

- [ ] **Step 6: Run full impacted and non-vacuity verification**

  Run from the v2 worktree without any server on port 3001:

  ```bash
  npm run test:status
  FRESHELL_TEST_SUMMARY="retire Node server: final Rust-only proof" npm run check
  cargo fmt --all --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo clippy -p freshell-codex --features real-transport --all-targets --locked -- -D warnings
  cargo clippy -p freshell-opencode --features real-transport --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  cargo test -p freshell-codex --features real-transport --locked
  cargo test -p freshell-opencode --features real-transport --locked
  npm run lint
  env -u FRESHELL_RUN_REAL_PROVIDER_CONTRACTS npm run test:oracle
  npm run test:e2e:helpers
  npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=chromium --list
  npm run test:e2e -- --project=chromium
  npm run test:electron
  npm run test:e2e:electron
  npm run electron:build
  npm run verify:electron-artifact
  npm run test:vitest -- run test/integration/electron/checkout-free-runtime.test.ts --config config/vitest/vitest.electron.config.ts
  node --import tsx scripts/retirement/verify-node-test-disposition.ts
  docker build --tag freshell-retire-node-server-v2-cloud --file docker/cloud-run/Dockerfile .
  docker build --tag freshell-retire-node-server-v2-example --file examples/docker/Dockerfile .
  docker run --rm --entrypoint /bin/sh freshell-retire-node-server-v2-cloud -c 'test -x /app/target/release/freshell-server && test -f /app/dist/client/index.html && test -f /app/dist/tools/freshell-mcp/server.js && test ! -e /app/dist/server && test ! -e /app/server && test ! -e /app/node_modules/node-pty'
  docker run --rm --entrypoint /bin/sh freshell-retire-node-server-v2-example -c 'test -x /app/freshell-server && test -f /app/dist/client/index.html && test ! -e /app/dist/server && test ! -e /app/server && test ! -e /app/node_modules'
  ! rg -n "dist/server|server/index\.(ts|js)|tsx watch server|tsconfig\.server|server-node-modules|node-pty|legacy-chromium|npm start" package.json config scripts run-rust-server.sh port/laptop-bootstrap tools electron installers docker examples .github test/e2e-browser test/e2e-electron README.md AGENTS.md .env.example docs/development/windows-electron-build.md docs/development/test-sandbox.md --glob '!scripts/retirement/runtime-boundary.ts' --glob '!scripts/verify-electron-artifact.ts' --glob '!scripts/prepare-electron-runtime.ts' --glob '!scripts/verify-container-layout.sh'
  test ! -d server
  test ! -d dist/server
  test ! -f tsconfig.server.json
  test ! -f config/vitest/vitest.server.config.ts
  git diff --exit-code origin/main -- docs/index.html .kata.toml
  ```

  Expected: all commands PASS; Playwright lists at least 308 tests in at least 86
  files and no legacy project; full configured E2E has nonzero executed tests and
  zero required skips; optional real-provider T2 tests are reported as
  supplemental rather than replacement coverage; Electron artifact works from a
  checkout-free staged copy with a runnable Rust server and no forbidden path;
  the disposition ledger has zero unresolved rows; rebuilt final container images contain no legacy source,
  compiled Node server, or Node-backend-only native dependency; final `rg` has no output;
  absence/protected-file checks pass.
  Any selected destructive lifecycle suite runs via `scripts/sandbox-test.sh`,
  never directly on the host.

  Native cross-platform acceptance is a required PR check, not a pre-PR dispatch.
  After the final commit, push only this feature branch:

  ```bash
  git push -u origin the-usual/retire-node-server-v2
  ```

  Then stop and request the user's explicit approval to create the PR. Once
  approved, the normal required PR matrix must be green on `macos-15-intel`,
  `macos-latest`, `ubuntu-latest`, and `windows-2022`; each job reports native
  `freshell-server[.exe]`, authenticated server-info/SPA/PTY acceptance, stdio
  MCP/fake-Claude acceptance, exact cleanup, and no forbidden Node-server
  artifact. The branch push itself creates no PR and performs no deployment.

- [ ] **Step 7: Commit the task**

  ```bash
  git add README.md AGENTS.md .env.example docs/development/windows-electron-build.md docs/development/test-sandbox.md scripts/retirement/runtime-boundary.ts scripts/retirement/runtime-surfaces.json test/unit/architecture/rust-only-server-runtime.test.ts
  if ! git diff --quiet -- .kata.toml; then git add .kata.toml; fi
  git commit -m "docs: declare the Rust-only backend"
  ```

  Expected final state: the worktree is clean after the commit; the external
  triage receipt remains outside tracked worktree history; no PR exists; port
  3001 was never contacted or restarted; the first retirement run remains intact.
