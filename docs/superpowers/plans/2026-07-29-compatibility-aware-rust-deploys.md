# Compatibility-Aware Rust Deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Freshell’s client and Rust server advance independently when both sides declare the pairing compatible, reject incompatible pairings before changing the live generation, and recover the exact prior working generation after a failed server activation.

**Architecture:** Build each update into a private immutable generation containing the browser client and the complete repo-owned Rust runtime. A small Rust deployment controller—not shell process matching—validates reciprocal half-open version bounds, records exact artifact/process identity, switches a per-checkout/per-port generation pointer, and replays a durable rollback journal after failures or interruption; `scripts/launch-rust.sh` remains the canonical thin build/mode wrapper.

**Tech Stack:** Bash wrapper, dependency-free Node.js ESM build helper, Vite 6, TypeScript, Rust 1.96, Axum, Serde/serde_json, SHA-256, Linux pidfds and `/proc`, Vitest, Cargo tests, Playwright, disposable Docker test sandbox.

## Global Constraints

- Work only in `.worktrees/deploy-compatibility-rollback` on branch `feat/deploy-compatibility-rollback`.
- Base all behavior on verified-green `origin/main` commit `4c04dc9c1d5bd603ac6bb00540cfbafed675a78b`; the coordinated suite passed there with 9,585 active tests and repository-documented skips.
- Preserve deliberate independent advancement: client and server versions do not need to be equal, share a release number, or come from the same commit.
- A client-only update proceeds only when the candidate client accepts the running server version and the running server accepts the candidate client. Already-loaded older clients remain governed by their own declarations and the reload fence below.
- A server-only update proceeds only when the candidate server and selected client accept each other and every active/reconnecting client is either reciprocally compatible or safely reloaded onto the selected client before the old server stops.
- A combined update validates the staged client and staged server reciprocally and applies the same active/reconnecting-client fence before stopping the old server.
- A client declaration is immutable for a component version: the server persists the full canonical declaration and digest, and rejects a second declaration using the same version with different contents.
- Do not keep a permanent “every version ever seen” compatibility pin. During deployment, atomically fence new application handshakes, snapshot active declarations, reload incompatible loaded tabs onto the selected compatible client, and admit a reconnect only after it presents a compatible declaration. A client that reaches an incompatible server receives only the reload-required handshake path, never ordinary application traffic.
- Reject missing, malformed, or incompatible declarations before switching the live generation or stopping a working server.
- Keep product/app version semantics unchanged. Deployment component versions are separate metadata and must not replace `APP_VERSION`, `/api/version`, health version, diagnostics version, or GitHub update-check version.
- Keep WebSocket protocol version 7 and its exact mismatch behavior. Adding an optional client declaration/digest and reload-required response is additive and does not relax protocol validation.
- A failed server deployment must attempt to restore the exact prior immutable generation. If safe restoration is blocked by foreign port ownership, unreadable receipts, storage failure, or unproven process identity, retain the recovery receipt, signal no unproven process, and fail loudly; do not claim uninterrupted availability or impossible recovery from external destruction.
- Do not roll back `.env`, user settings, transcripts, provider state, or logs. This change adds no persisted user-data migration.
- Do not add an in-product updater, release downloader, UI, or claim that this caused/fixes the earlier red-pane incident.
- Do not restart/deploy the live self-hosted port 3002 during implementation or verification.
- Run all process-stop, crash, signal, rollback, and interruption tests only through `scripts/sandbox-test.sh`, with every writable fixture/build/output beneath container `/tmp` or isolated named volumes—not the bind-mounted checkout’s `dist`.
- Preserve human-readable launcher output. Deployment JSONL is non-authoritative, uses a real serializer and whitelisted fields, and never includes tokens or full inherited environments.
- Use red-green-refactor TDD, focused atomic commits, NodeNext `.js` suffixes where applicable, and do not open a PR without explicit user approval.

---

## Load-Bearing Validation Results

- Current `origin/main` is green. A real Rust-browser harness boot/restart test, a real terminal-command test, and the multi-pane server-restart recovery test passed with the current client labeled `0.7.5` and Rust server labeled `0.7.0`. Seed only these exact patch-level versions; no wider `0.7.x` compatibility claim is justified.
- npm and Rust semver range grammars disagree. Use canonical stable `MAJOR.MINOR.PATCH` strings, each numeric component restricted to canonical decimal `0..4294967295`, and structured `{ minInclusive, maxExclusive }` bounds. Both implementations consume one raw-string golden corpus. Reject prereleases, build metadata, leading zeros, floats, exponent notation, signs, whitespace, duplicate/unknown keys, and empty/inverted ranges.
- `APP_VERSION` is product-wide and feeds health, `/api/version`, diagnostics, logging, and release checks. Component version metadata must remain separate.
- Vite can emit a root manifest to an absolute private output, but Vite does not typecheck. Every client build retains `npm run typecheck:client`. Put the artifact build test in a new unmocked test because the existing Vite config test mocks `node:fs`.
- A plain `.mjs` helper using only Node built-ins works without `tsx` or `node_modules`; statically check it with TypeScript `allowJs/checkJs` plus `node --check`.
- The running server may be a deleted executable inode whose bytes differ from `target/release/freshell-server`; this is true in the present installation. Legacy capture and rollback must copy `/proc/<pid>/exe` after verifying boot ID/start time/inode/digest. Future servers launch from immutable generation paths.
- The rollback closure is larger than binary plus client. It includes built-in extensions, the Claude Node sidecar, the compiled MCP runtime, and an immutable lockfile-derived production `node_modules` closure for those Node entry points. Add explicit runtime overrides and copy these files into each generation. The Node executable/version, coding CLIs, `.env`, and user/provider data remain preflighted host prerequisites/state, not copied release artifacts.
- Rust retains an unresolved `FRESHELL_CLIENT_DIR` path and opens files per request. A stable `current/client` indirection permits a no-restart client-only switch. New client generations retain prior hashed assets so already-loaded tabs can still lazy-load old chunks.
- A client manifest on disk does not identify already-loaded tabs. Send the full canonical client declaration and digest additively in WebSocket `hello`. Persist the declaration registry, reject version/declaration conflicts, and expose an authenticated nonce-bound deployment fence that atomically snapshots active clients while preventing a new unchecked application handshake. Incompatible loaded clients are instructed to reload the selected current client and must reconnect compatibly before deployment proceeds; disconnected old pages get the same reload-only treatment when they return. This retires an old version safely instead of pinning the server to every version ever seen.
- Current shell PID/cwd/argv checks cannot close PID reuse or signal races. The Rust controller uses kernel boot ID, `/proc` identity, pidfds, exact ready receipts, a single-user/non-hostile-same-UID threat model, and never kills by process scans or port ownership.
- The authoritative generation store is inside the checkout, outside ordinary `dist` and `target` build outputs. It uses private staging, recursive manifests/digests, sibling copy+fsync+rename publication, a checkout/port lock, atomic pointers, and a durable intent-before-side-effect journal. The atomic `current` pointer switch is the commit boundary: before it, recovery restores the prior generation; after it, recovery completes activation of the target. A candidate cannot serve ordinary browser/API traffic before that boundary.
- Existing artifacts have no declarations/receipts. The first transition must capture and scratch-validate the actual working legacy closure before any non-private build, then permit only a combined declared update. One-sided advancement fails closed until bootstrap succeeds; an emergency restart may use only the captured legacy receipt.
- Real E2E global setup can write checkout `dist` even when launched through the Docker sandbox. Deployment tests need a dedicated no-global-setup config and container `/tmp` fixture root. Use `CARGO_BUILD_JOBS=2` and `CMAKE_BUILD_PARALLEL_LEVEL=2` to stay within the sandbox PID budget.

## File Structure

- Create `config/deployment-compatibility.json` and `test/fixtures/deployment-compatibility/cases.jsonl`
  - Independent component versions/bounds and the shared raw JSON conformance corpus.
- Create `scripts/deployment-compatibility.mjs`
  - Dependency-free strict parser/projector/checker/JSONL serializer used at build time; no process signaling or transaction ownership.
- Modify `tsconfig.json`, `config/vite/vite.config.ts`, and add `test/unit/deployment-compatibility-artifact.test.ts`
  - Statically checks the helper, accepts only launcher-created absolute client output, defines client version, and emits the client declaration.
- Create `crates/freshell-deployment/`
  - Shared Rust declarations/comparison/manifest/receipt types and tests consuming the same corpus.
- Modify `crates/freshell-server/build.rs` and `crates/freshell-server/Cargo.toml`
  - Embed server deployment metadata without changing product version.
- Modify `crates/freshell-api/src/lib.rs`, `crates/freshell-server/src/main.rs`, `crates/freshell-server/src/rate_limit.rs`
  - Authenticated operational compatibility status and nonce-bound actual-address ready receipts.
- Modify `shared/ws-protocol.ts`, `src/lib/ws-client.ts`, `crates/freshell-ws/src/lib.rs`, and related state wiring
  - Optional canonical client declaration/digest in hello, durable declaration identity, active connection tracking, and reload-required handling.
- Modify `crates/freshell-platform/src/mcp_inject.rs`
  - Explicit compiled MCP entry override.
- Create `crates/freshell-deploy/`
  - Rust deployment controller: canonical inputs, locks, immutable store, legacy capture, staging verification, pidfds, journal, activation, rollback, recovery.
- Refactor `scripts/launch-rust.sh`
  - Thin mode/build wrapper with `--server-only`, private builds, controller selection, and no direct process kill/artifact replacement.
- Create focused unit/integration tests plus explicitly excluded Docker-only tests under `test/integration/server/`, `crates/freshell-deploy/tests/`, and `config/vitest/vitest.deploy-sandbox.config.ts`. Real signals, process stops, crashes, and rollback run only from the dedicated sandbox config.
- Modify `AGENTS.md`
  - Exact operator commands, first-bootstrap rule, compatibility behavior, truthful rollback guarantee, and unchanged `APPROVED` rule.

### Task 1: Canonical Cross-Language Compatibility Contract

**Files:**
- Create: `config/deployment-compatibility.json`
- Create: `test/fixtures/deployment-compatibility/cases.jsonl`
- Create: `scripts/deployment-compatibility.mjs`
- Create: `test/unit/server/deployment-compatibility.test.ts`
- Create: `crates/freshell-deployment/Cargo.toml`
- Create: `crates/freshell-deployment/src/lib.rs`
- Modify: `Cargo.lock`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces source contract:

```json
{
  "schemaVersion": "1",
  "legacyClientVersion": "0.7.5",
  "client": {
    "version": "0.7.5",
    "supportsServer": {
      "minInclusive": "0.7.0",
      "maxExclusive": "0.7.1"
    }
  },
  "server": {
    "version": "0.7.0",
    "supportsClient": {
      "minInclusive": "0.7.5",
      "maxExclusive": "0.7.6"
    }
  }
}
```

- Produces artifact declaration shape: `{ schemaVersion: "1", component, version, supports: { client|server: bounds } }`
- Produces Node exports: `parseContract`, `parseDeclaration`, `projectDeclaration`, `assertMutuallyCompatible`, `serializeEvent`
- Produces Rust types/functions with the same names in snake_case.

- [ ] **Step 1: Write failing Node and Rust corpus tests**

The JSONL corpus stores `{name, raw, expectedCode}` so lexical cases survive parsing. Include valid exact bounds and invalid duplicate keys, unknown keys at every depth, leading zero, prerelease/build, signed/whitespace/exponent/float versions, component overflow, malformed schema version, missing reciprocal key, and both incompatibility directions.

Run:

```bash
npm run test:vitest -- run test/unit/server/deployment-compatibility.test.ts --config config/vitest/vitest.server.config.ts
cargo test -p freshell-deployment
```

Expected: FAIL because neither implementation exists.

- [ ] **Step 2: Implement the dependency-free Node parser**

Use exact-key checks before value parsing and canonical regex:

```js
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const MAX_COMPONENT = 4294967295n
```

Compare parsed `BigInt` components explicitly—never compare arrays with `<`. Reject duplicate JSON keys with a small tokenizer before `JSON.parse`. CLI subcommands are `project`, `check`, and `event`; all output writes use a temporary sibling plus rename.

- [ ] **Step 3: Implement the Rust parser and identical codes**

Parse through `serde_json::Value`, validate exact keys manually, parse version string components as `u32`, and return stable error codes matching the corpus. Do not use Rust semver ranges.

- [ ] **Step 4: Make both corpus suites green and statically check the helper**

Run:

```bash
node --check scripts/deployment-compatibility.mjs
npm run typecheck:client
npm run test:vitest -- run test/unit/server/deployment-compatibility.test.ts --config config/vitest/vitest.server.config.ts
cargo test -p freshell-deployment
```

Expected: PASS with every corpus line asserted by both languages.

- [ ] **Step 5: Refactor and commit**

Keep parsing, comparison, projection, and CLI routing separate. Then:

```bash
git add config/deployment-compatibility.json test/fixtures/deployment-compatibility scripts/deployment-compatibility.mjs test/unit/server/deployment-compatibility.test.ts crates/freshell-deployment tsconfig.json Cargo.lock
git commit -m "feat(deploy): define reciprocal component compatibility"
```

### Task 2: Embed Artifact Identity Without Changing Product Version

**Files:**
- Modify: `config/vite/vite.config.ts`
- Create: `test/unit/deployment-compatibility-artifact.test.ts`
- Modify: `crates/freshell-server/build.rs`
- Modify: `crates/freshell-server/Cargo.toml`
- Modify: `crates/freshell-api/src/lib.rs`
- Modify: `crates/freshell-server/src/main.rs`
- Modify: `crates/freshell-server/src/rate_limit.rs`

**Interfaces:**
- Produces client artifact `deployment-compatibility.json`.
- Produces compile-time `FRESHELL_SERVER_COMPONENT_VERSION` and bounds.
- Produces authenticated `GET /api/deployment-compatibility` containing the server declaration, canonical persisted client declarations/digests, active connection counts, deployment-fence state, generation ID, and boot ID.
- Produces authenticated controller-only fence operations bound to a fresh nonce: begin fence and atomically snapshot active client declarations, request reload for incompatible clients, observe compatible reconnects, and release the fence.
- Produces optional durable ready receipt selected by `FRESHELL_DEPLOY_READY_FILE` and bound to `FRESHELL_DEPLOY_NONCE`.

- [ ] **Step 1: Write failing real client-artifact and Rust API tests**

The unmocked client test runs `npm run typecheck:client`, builds to an absolute temp directory, asserts the exact client manifest, and asserts `dist/client` is unchanged. Rust router tests authenticate the endpoint, prove it bypasses only the rate bucket (not auth), and prove `/api/health` remains exactly seven fields.

- [ ] **Step 2: Implement Vite projection and declaration defines**

Reject a non-absolute `FRESHELL_CLIENT_OUT_DIR`. Emit the projected client declaration and define:

```ts
__FRESHELL_CLIENT_DEPLOYMENT_DECLARATION__: JSON.stringify(clientDeclaration),
__FRESHELL_CLIENT_DEPLOYMENT_DECLARATION_DIGEST__: JSON.stringify(clientDeclarationDigest)
```

Add its type to `src/vite-env.d.ts`.

- [ ] **Step 3: Embed server metadata while retaining `APP_VERSION`**

`build.rs` loads the contract through `freshell-deployment`, watches its absolute path, and embeds only deployment constants. Leave `APP_VERSION`, `FRESHELL_APP_VERSION`, and their consumers unchanged.

- [ ] **Step 4: Add deployment status and ready receipt**

Write the ready receipt only after binding and resolving `listener.local_addr()`. It contains nonce, actual address, PID, boot ID, instance ID, generation ID, server component version, and build commit. A requested receipt that cannot be durably published makes startup fail.

- [ ] **Step 5: Run artifact/API tests and commit**

```bash
npm run test:vitest -- run test/unit/deployment-compatibility-artifact.test.ts
cargo test -p freshell-api
cargo test -p freshell-server --bin freshell-server
git add config/vite/vite.config.ts src/vite-env.d.ts test/unit/deployment-compatibility-artifact.test.ts crates/freshell-server/build.rs crates/freshell-server/Cargo.toml crates/freshell-api/src/lib.rs crates/freshell-server/src/main.rs crates/freshell-server/src/rate_limit.rs Cargo.lock
git commit -m "feat(deploy): embed client and server deployment identity"
```

### Task 3: Identify Loaded Clients and Bind Repo Runtime Assets

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `crates/freshell-ws/src/lib.rs`
- Modify: relevant WS state/connection tests
- Modify: `crates/freshell-platform/src/mcp_inject.rs`
- Modify: `crates/freshell-server/src/extensions.rs` tests if needed

**Interfaces:**
- Consumes the build-emitted client declaration and digest.
- Produces optional `hello.clientDeclaration` and `hello.clientDeclarationDigest`.
- Produces a durable version-to-declaration registry and reference-counted active connection inventory shared with deployment status.
- Produces a nonce-bound deployment fence and reload-required handshake path before ordinary application traffic.
- Produces `FRESHELL_MCP_SERVER_ENTRY` override; reuses existing `FRESHELL_CLIENT_DIR`, `FRESHELL_EXTENSIONS_DIR`, and `FRESHELL_CLAUDE_SIDECAR`.

- [ ] **Step 1: Write failing handshake lifecycle tests**

Prove protocol 7 still validates first; a valid canonical declaration/digest is persisted; a second declaration with the same version but different contents is rejected; multiple connections are reference-counted; disconnect removes them from the active inventory; and missing legacy values map to the single configured legacy declaration during bootstrap.

- [ ] **Step 2: Implement additive client identity tracking**

Send:

```ts
{
  type: 'hello',
  token,
  protocolVersion: WS_PROTOCOL_VERSION,
  clientDeclaration: __FRESHELL_CLIENT_DEPLOYMENT_DECLARATION__,
  clientDeclarationDigest: __FRESHELL_CLIENT_DEPLOYMENT_DECLARATION_DIGEST__
}
```

Share a concurrency-safe registry with the deployment API and persist each first-seen canonical declaration atomically. Do not add deployment identity to unrelated messages.

- [ ] **Step 3: Implement the fenced reload handshake**

An authenticated controller call starts a nonce-bound fence before the final compatibility snapshot. While fenced, no unchecked WebSocket may enter ordinary application handling. Compatible declarations may reconnect and be counted; incompatible loaded clients receive `client.reloadRequired`, reload the selected client once, and reconnect. The controller waits for the pre-fence active connection set to either reconnect compatibly or close, then takes the final snapshot. Timeout aborts with the old server still running. Persist the declaration registry and fence/snapshot under the per-port deployment store so a server or controller crash cannot forget which clients were admitted. A declaration-less legacy client has no reload handler, so it must be reciprocally compatible with the candidate server or the deployment aborts before interruption.

- [ ] **Step 4: Add explicit MCP runtime override**

When `FRESHELL_MCP_SERVER_ENTRY` is non-empty, use that compiled JS path directly. Otherwise preserve existing production/source fallback exactly.

- [ ] **Step 5: Run focused client/Rust protocol and runtime tests**

```bash
npm run test:vitest -- run test/unit/client/lib/ws-client.test.ts test/unit/shared/ws-protocol.reconcile.test.ts
cargo test -p freshell-ws
cargo test -p freshell-platform mcp
```

- [ ] **Step 6: Refactor and commit**

```bash
git add shared/ws-protocol.ts src/lib/ws-client.ts crates/freshell-ws crates/freshell-platform/src/mcp_inject.rs crates/freshell-server/src/extensions.rs test
git commit -m "feat(deploy): track reconnectable client versions"
```

Stage only the exact focused tests changed by this task; do not sweep unrelated `test` changes.

### Task 4: Immutable Generation Store and Legacy Bootstrap

**Files:**
- Create: `crates/freshell-deploy/Cargo.toml`
- Create: `crates/freshell-deploy/src/main.rs`
- Create focused modules under `crates/freshell-deploy/src/` for paths, manifests, locks, process identity, receipts, and store.
- Create: `crates/freshell-deploy/tests/generation_store.rs`
- Modify: `.gitignore`

**Interfaces:**
- Store root: `<canonical-checkout>/.freshell-deploy/ports/<port>/`
- Produces immutable generation manifest covering relative path, type, mode, symlink target, and SHA-256.
- Produces atomic `current` pointer and `live.json` receipt.
- Produces an atomic declaration registry keyed by component version with a canonical declaration digest; one version can never acquire new compatibility bounds.
- Produces legacy `capture` using a verified `/proc/<pid>/exe`.

- [ ] **Step 1: Write failing path/store/manifest tests**

Cover invalid ports, symlinked/relative/unsafe roots, exclusive generation creation, cross-device import through sibling temp, digest/mode mismatch, concurrent locks, atomic pointer switch, declaration-version conflict, and refusal to clean any unmanifested path.

- [ ] **Step 2: Implement canonical store and manifest publication**

Every authoritative file uses write-temp, `sync_all`, rename, and parent-directory `sync_all`. Generations are immutable copies/reflinks, never hardlinks to mutable build output.

- [ ] **Step 3: Write failing legacy capture tests**

Inside a temp fixture, start an executable, replace/unlink its pathname, verify path bytes differ, capture `/proc/<pid>/exe`, and assert boot ID/start time/device/inode/digest/mode before and after the copy. Also require captured client, extensions, sidecar, MCP runtime, lockfile-derived production dependencies, cwd, Node executable/version, and non-secret launch metadata.

- [ ] **Step 4: Implement legacy capture and fail-closed rules**

Do not treat the legacy PID file alone as ownership. Capture must keep the observed process alive, revalidate after copying, scratch-start the captured closure—including actual sidecar and MCP imports—on port 0 with an isolated home, and mark the receipt `legacy: true` without inventing compatibility declarations.

- [ ] **Step 5: Run, refactor, and commit**

```bash
cargo test -p freshell-deploy generation_store
cargo test -p freshell-deploy legacy_capture
git add .gitignore crates/freshell-deploy Cargo.lock
git commit -m "feat(deploy): capture immutable working generations"
```

### Task 5: Durable Activation and Rollback State Machine

**Files:**
- Add modules under `crates/freshell-deploy/src/` for probe, journal, process control, activation, rollback, and recovery.
- Create: `crates/freshell-deploy/tests/transaction_state.rs`
- Create: `crates/freshell-deploy/tests/process_identity.rs` using fake process/pidfd adapters only; real signaling remains in Docker-only launcher tests.

**Interfaces:**
- Durable phases: `prepared`, `clients_fenced`, `stop_old_intent`, `start_target_intent`, `target_ready_fenced`, `switch_current_intent`, `committed`, `activation_confirmed`, `rollback_complete`.
- Produces pidfd-bound SIGTERM/SIGKILL only for receipt-proven transaction candidates.
- Treats the atomic `current` pointer switch as the durable commit/roll-forward boundary: recovery rolls back before it and completes target activation after it.
- Keeps the target listener fenced from ordinary browser/API traffic until that commit boundary.

- [ ] **Step 1: Write the state-table tests before implementation**

Table-drive controller death or IO failure before/after every durable intent and side effect. Assert: no live mutation before `prepared`; every failure before the pointer commit restores prior; once the atomic pointer names the target, replay preserves and activates the target; no ordinary request is served by the target before commit; and a third-party pointer/port/process is never overwritten or signaled.

- [ ] **Step 2: Implement probe on actual port 0**

Launch with an allowlisted environment, isolated home/token, explicit staged runtime paths and production dependencies, nonce, generation ID, and ready-file path. Verify ready receipt, pidfd, boot ID/start time, executable inode/digest, Node executable/version, real sidecar/MCP imports, actual listener, and exact compatibility response, then terminate/reap the probe. Immediately before stopping the old server, repeat the same restartability/closure verification for the prior generation.

- [ ] **Step 3: Implement server/full activation**

Begin the nonce-bound client fence, obtain the final atomic active-client declaration snapshot, and require reciprocal compatibility after any reloads. Durably prepare prior/target receipts, stop only the pidfd-proven old server with SIGTERM, and start the target from its immutable path in a fenced mode that binds the live port but serves only nonce-authenticated controller checks. Verify target identity/readiness and prepare its live/PID receipts. Atomically switch `current`; that switch is the commit point. Then lift the target fence, verify the selected generation is serving, and durably record `activation_confirmed`. A crash after the pointer switch rolls forward by activating or restarting the exact target; it never restores old assets beneath browsers that may have observed the committed pointer.

- [ ] **Step 4: Implement client-only activation**

Require the running server identity before and after the switch; target generation reuses identical server/runtime/dependency digests, merges prior hashed assets into the candidate client, validates reciprocal compatibility, and prepares all receipts. The atomic `current` switch is the commit point and the only user-visible mutation. A crash before it retains prior; a crash after it preserves target and finishes receipts. Never signal the server.

- [ ] **Step 5: Implement rollback and replay**

Before the pointer commit, rollback stops only a verified candidate. SIGKILL is permitted only through its verified pidfd after bounded SIGTERM failure. Restore the prior pointer if needed, start the exact prior generation, verify identity/health/runtime imports, and return the original deployment failure. After the pointer commit, replay instead preserves the target pointer and completes target activation from its exact generation. Foreign port theft, uncertain identity, unreadable receipts, or restart failure retain both generations and the active recovery receipt and fail closed.

- [ ] **Step 6: Run host-safe state/identity tests, refactor, and commit**

```bash
cargo test -p freshell-deploy transaction_state process_identity
git add crates/freshell-deploy Cargo.lock
git commit -m "feat(deploy): recover interrupted server activations"
```

These Cargo tests exercise deterministic adapters and never signal or stop a host process. The production Linux process adapter is exercised only by the explicitly sandboxed tests in Tasks 6–7.

### Task 6: Canonical Wrapper and Independent Update Modes

**Files:**
- Refactor: `scripts/launch-rust.sh`
- Create: `test/integration/server/launch-rust-deployment.sandbox.test.ts`
- Create: `config/vitest/vitest.deploy-sandbox.config.ts`
- Modify: `config/vitest/vitest.server.config.ts`
- Create fixture commands beneath `test/fixtures/launch-rust/`

**Interfaces:**
- `--client-only`: typecheck/build private client; controller reuses server/runtime.
- `--server-only --restart`: typecheck/build private server JS, Rust binary, controller, extensions/sidecar; controller reuses client.
- `--restart`: privately build both components/runtime and activate combined.
- `--skip-build`: preserve existing behavior: start the exact current generation only when it is not already running; never restart a running server by itself.
- `--skip-build --restart`: restart the exact current generation through its stored controller; no npm/Cargo/tsx dependency.
- `--stop`: stop only receipt-proven current process.

- [ ] **Step 1: Write the complete failing flag/build/preflight matrix**

Reject invalid/repeated/conflicting flags and malformed ports before build. Prove each mode builds only its component set, uses exclusive private staging, never writes checkout `dist`/`target`, and rejects both incompatibility directions before stop/pointer switch. Prove plain `--skip-build` is a no-op when the current generation is already running and only `--skip-build --restart` interrupts it.

- [ ] **Step 2: Refactor shell to a thin wrapper**

The wrapper selects/builds a controller, creates private outputs, runs required typechecks, and passes exact artifact paths. It contains no `kill`, process scan, direct `mv` over live artifacts, or hand-built JSON.

- [ ] **Step 3: Implement generation assembly by mode**

Server runtime assembly includes staged compiled `dist/server`, built-in extensions, Claude sidecar, runtime overrides, `package.json`/lockfile, and a private `npm ci --omit=dev` production dependency closure. Client-only copies the selected server/runtime/dependency generation; server-only copies the selected client. Combined bootstrap captures legacy before any command allowed to write non-private outputs.

Modify the ordinary server Vitest config to explicitly exclude `**/*.sandbox.test.ts`. The dedicated deploy-sandbox config includes only those files, has no global setup, and every sandbox test hard-fails unless `FRESHELL_DESTRUCTIVE_SANDBOX=1`. No Cargo auto-discovered test may send real signals; those boundaries are exercised through this dedicated config.

- [ ] **Step 4: Run exhaustive sandbox mode/failpoint tests**

```bash
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 npm run test:vitest -- run test/integration/server/launch-rust-deployment.sandbox.test.ts --config config/vitest/vitest.deploy-sandbox.config.ts --maxWorkers=1 --no-file-parallelism"
bash -n scripts/launch-rust.sh
```

- [ ] **Step 5: Refactor and commit**

```bash
git add scripts/launch-rust.sh config/vitest/vitest.deploy-sandbox.config.ts config/vitest/vitest.server.config.ts test/integration/server/launch-rust-deployment.sandbox.test.ts test/fixtures/launch-rust
git commit -m "feat(deploy): add compatibility-checked update modes"
```

### Task 7: Real-Boundary Rollback Proof and Operator Contract

**Files:**
- Create: `test/integration/server/launch-rust-real-boundary.sandbox.test.ts`
- Add: tiny native failure-candidate fixture crate under `test/fixtures/launch-rust/failing-candidate/`
- Modify: `AGENTS.md`
- Modify only if verification exposes a defect: files from Tasks 1–6.

- [ ] **Step 1: Write one serial real-boundary scenario**

Use container `/tmp` for the complete runtime/store. Prebuild the real server with two Cargo jobs. Assert real ELF `/proc` identity, immutable generation digests, explicit client/extensions/sidecar/MCP/dependency paths, successful real sidecar and MCP imports, real compatibility endpoint, exact seven-field health, and served unique client marker. Then activate a native candidate that passes shadow probe but exits before the atomic pointer commit on the requested live port and prove the controller restores the real prior binary/client generation with ordered events. Add a second failpoint immediately after pointer commit and prove recovery rolls forward to the exact target rather than serving prior assets after target visibility.

- [ ] **Step 2: Run real-boundary verification**

```bash
scripts/sandbox-test.sh "CARGO_BUILD_JOBS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 cargo build --release -p freshell-server"
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 CARGO_BUILD_JOBS=2 npm run test:vitest -- run test/integration/server/launch-rust-real-boundary.sandbox.test.ts --config config/vitest/vitest.deploy-sandbox.config.ts --maxWorkers=1 --no-file-parallelism"
```

Expected: PASS without changing bind-mounted checkout `dist`, source, production home, or host processes.

- [ ] **Step 3: Run the exact-pair browser compatibility smoke**

Run only focused existing cases with private build outputs or a corrected harness that cannot write checkout `dist`: Rust boot/restart/reap, terminal command, lazy editor chunk load, and multi-pane server restart. Add an unequal-version case in which an older loaded client reconnects: if reciprocal bounds accept it, it resumes normally; if not, it is limited to the reload-required handshake, reloads the selected compatible client, restores its tabs, and only then receives ordinary traffic. Cap Cargo jobs at 2. Any pre-existing unrelated flaky case is reported, not hidden or skipped.

- [ ] **Step 4: Update operator instructions**

Document:

```text
scripts/launch-rust.sh --client-only
scripts/launch-rust.sh --server-only --restart
scripts/launch-rust.sh --restart
scripts/launch-rust.sh --skip-build
scripts/launch-rust.sh --skip-build --restart
```

Explain in plain language: different versions are normal; both sides must accept the pairing; older loaded tabs are safely reloaded when they cannot speak to the new server; incompatible updates stop before replacement; server candidates are tested before interruption; a failure before the visible switch restores the recorded prior generation, while a crash after the visible switch completes the new generation; plain `--skip-build` never restarts an already-running server; first adoption from legacy artifacts requires a combined approved restart; port 3002 still requires exact user approval `APPROVED`.

- [ ] **Step 5: Run full verification**

```bash
npm run lint
FRESHELL_TEST_SUMMARY='compatibility-aware independent client/server deploy final verification' npm run check
cargo test --workspace
git diff --check origin/main...
git status --short
```

Expected: PASS with only documented skips and a clean worktree after commits.

- [ ] **Step 6: Commit docs and any focused verification fixes**

```bash
git add AGENTS.md
git commit -m "docs: explain compatibility-checked Rust deploys"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1–3 implement truthful independent declarations and active client identity. Tasks 4–6 make each update mode private, coherent, preflighted, and recoverable. Task 7 proves the production boundary and documents the plain-language behavior.
- **Production proof:** Fake fixtures cover malformed input and every fault boundary; the dedicated no-global-setup sandbox test sends a real Rust ELF through the actual controller and rollback path; focused browser tests cover the exact seeded pair and reconnect behavior.
- **No silent deferral:** Compatible client-only/server-only/combined paths, both incompatibility directions, conflicting declarations, incompatible loaded-client reload, missing declarations, legacy bootstrap, interrupted transactions on both sides of the pointer commit, failed live start, candidate TERM refusal, foreign port ownership, rollback-start failure, and first-install cleanup all have explicit behavior/tests.
- **Scope guard:** No UI updater, downloader, session/pane repair, product-version coupling, generic host packaging, user-data rollback, or red-pane root-cause claim is included.
- **Type consistency:** Source and artifacts use canonical strings; bounds are always `minInclusive`/`maxExclusive`; client supports server and server supports client; receipts identify full immutable generations.
- **Truthful user promise:** Normal compatible updates proceed independently. Incompatible updates do not replace the live generation. A failure before the new generation becomes visible restores the exact prior recorded generation when Freshell can still safely own the port/process/storage. Once the new generation is durably selected, recovery completes that generation instead of exposing a mixed old/new state. If either recovery path is unsafe, Freshell preserves evidence and refuses dangerous guesses.
