# Compatibility-Aware Rust Deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Freshell’s client and Rust server advance independently when both sides declare the pairing compatible, reject incompatible pairings before changing the live generation, and recover the exact prior working generation after a failed server activation.

**Architecture:** Build each update into a private immutable generation containing the browser client and the complete repo-owned Rust runtime. A small Rust deployment controller—not shell process matching—validates reciprocal half-open version bounds, records exact artifact/process identity, switches a per-checkout/per-port generation pointer, and replays a durable rollback journal after failures or interruption; `scripts/launch-rust.sh` remains the canonical thin build/mode wrapper.

**Tech Stack:** Bash wrapper, dependency-free Node.js ESM build helper, Vite 6, TypeScript, Rust 1.96, Axum, Serde/serde_json, SHA-256, Linux pidfds and `/proc`, Vitest, Cargo tests, Playwright, disposable Docker test sandbox.

## Global Constraints

- Work only in `.worktrees/deploy-compatibility-rollback` on branch `feat/deploy-compatibility-rollback`.
- The implementation began on verified-green `origin/main` commit `2641ada382472586ce1aa7664331d384853e867d` and was later revalidated and rebased onto `179c0d45eb4ae8c459dba37e0d0f7d22f2023bd0`; final verification is pinned to that integration base.
- Preserve deliberate independent advancement: client and server versions do not need to be equal, share a release number, or come from the same commit.
- A client-only update proceeds only when the candidate client accepts the running server version and the running server accepts the candidate client.
- A server-only update proceeds only when the candidate server and the selected client accept each other.
- A combined update proceeds only when the staged client and staged server accept each other.
- Compatibility is between the selected client artifact and selected server artifact. Do not add a browser-tab inventory, forced reload protocol, or a permanent “every version ever seen” pin; managing stale JavaScript already loaded in a browser is outside this issue.
- Reject missing, malformed, or incompatible declarations before switching the live generation or stopping a working server.
- Keep product/app version semantics unchanged. Deployment component versions are separate metadata and must not replace `APP_VERSION`, `/api/version`, health version, diagnostics version, or GitHub update-check version.
- Keep WebSocket protocol version 7 and its exact mismatch behavior. This deploy feature does not add a WebSocket protocol message.
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
- Compatibility preflight reads the selected client artifact declaration and the candidate/running server declaration. It does not infer artifact identity from browser connections.
- Current shell PID/cwd/argv checks cannot close PID reuse or signal races. The Rust controller uses kernel boot ID, `/proc` identity, pidfds, exact ready receipts, a single-user/non-hostile-same-UID threat model, and never kills by process scans or port ownership.
- The authoritative generation store is inside the checkout, outside ordinary `dist` and `target` build outputs. It uses private staging, recursive manifests/digests, sibling copy+fsync+rename publication, a checkout/port lock, atomic pointers, and a durable intent-before-side-effect journal. A candidate server may bind the live port in controller-only gated mode, but cannot serve ordinary browser/API traffic until it durably records activation. Server/full recovery rolls back before that target-owned receipt and rolls forward after it; client-only recovery uses the atomic `current` pointer as its commit boundary.
- Existing artifacts have no declarations/receipts. The first transition must capture and scratch-validate the actual working legacy closure before any non-private build, then permit only a combined declared update whose staged client/server pair is reciprocally compatible. A bootstrap failure before the candidate’s durable activation receipt restores the captured legacy generation. One-sided modes fail closed until bootstrap succeeds; an emergency restart may use only the captured legacy receipt.
- Real E2E global setup can write checkout `dist` even when launched through the Docker sandbox. Deployment tests need a dedicated no-global-setup config and container `/tmp` fixture root. Use `CARGO_BUILD_JOBS=2` and `CMAKE_BUILD_PARALLEL_LEVEL=2` to stay within the sandbox PID budget.

## File Structure

- Create `config/deployment-compatibility.json` and `test/fixtures/deployment-compatibility/cases.jsonl`
  - Independent component versions/bounds and the shared raw JSON conformance corpus.
- Create `scripts/deployment-compatibility.mjs`
  - Dependency-free strict parser/projector/checker/JSONL serializer used at build time; no process signaling or transaction ownership.
- Modify `tsconfig.json`, `config/vite/vite.config.ts`, and add `test/unit/deployment-compatibility-artifact.test.ts`
  - Statically checks the helper, accepts only launcher-created absolute client output, and emits the client declaration/digest.
- Create `crates/freshell-deployment/`
  - Shared Rust declarations/comparison/manifest/receipt types and tests consuming the same corpus.
- Modify `crates/freshell-server/build.rs` and `crates/freshell-server/Cargo.toml`
  - Embed server deployment metadata without changing product version.
- Modify `crates/freshell-api/src/lib.rs`, `crates/freshell-server/src/main.rs`, `crates/freshell-server/src/rate_limit.rs`
  - Authenticated operational compatibility status and nonce-bound actual-address ready receipts.
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
- Canonical declaration bytes are UTF-8 for the exact compact JSON key order `schemaVersion`, `component`, `version`, `supports`, then the single peer key, then `minInclusive`, `maxExclusive`, with no insignificant whitespace or trailing newline. The declaration digest is lowercase 64-character SHA-256 hex of those bytes. Parsers always recompute it; a supplied digest is only an assertion.
- Produces Node exports: `parseContract`, `parseDeclaration`, `projectDeclaration`, `canonicalDeclarationBytes`, `declarationDigest`, `assertMutuallyCompatible`, `serializeEvent`.
- Produces Rust types/functions with the same names in snake_case.

- [ ] **Step 1: Write failing Node and Rust corpus tests**

The JSONL corpus stores `{name, raw, expectedCode, expectedCanonical?, expectedSha256?}` so lexical cases survive parsing and valid vectors prove byte-for-byte canonicalization/digest parity. Include valid exact bounds and invalid duplicate keys, unknown keys at every depth, leading zero, prerelease/build, signed/whitespace/exponent/float versions, component overflow, malformed schema version, missing reciprocal key, and both incompatibility directions.

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

Use a custom Serde visitor (or a raw duplicate-key tokenizer before constructing `serde_json::Value`) that rejects duplicate keys at every object depth, then validate exact keys manually, parse version string components as `u32`, and return stable error codes matching the corpus. Do not use Rust semver ranges. Recompute canonical bytes and SHA-256 server-side; never trust a client-supplied digest.

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
- Produces authenticated `GET /api/deployment-compatibility` containing the running server declaration, server process generation ID, and boot ID.
- Produces optional durable ready receipt selected by `FRESHELL_DEPLOY_READY_FILE` and bound to `FRESHELL_DEPLOY_NONCE`.
- Produces optional live-port gated startup selected by `FRESHELL_DEPLOY_ACTIVATION_FILE`/`FRESHELL_DEPLOY_ACTIVATED_FILE`: controller checks remain available, ordinary routes remain unavailable, and matching durable authorization causes the server to publish its durable activated receipt immediately before an infallible in-process gate flip.

- [ ] **Step 1: Write failing real client-artifact and Rust API tests**

The unmocked client test runs `npm run typecheck:client`, builds to an absolute temp directory, asserts the exact client manifest/digest, and asserts `dist/client` is unchanged. Rust router tests authenticate the endpoint, prove it bypasses only the rate bucket (not auth), prove `/api/health` remains exactly seven fields, and prove gated startup admits only nonce-authenticated controller checks until activation.

- [ ] **Step 2: Implement Vite projection**

Reject a non-absolute `FRESHELL_CLIENT_OUT_DIR` and emit the projected client declaration plus its canonical digest. Do not put deployment metadata into the browser WebSocket protocol.

- [ ] **Step 3: Embed server metadata while retaining `APP_VERSION`**

`build.rs` loads the contract through `freshell-deployment`, watches its absolute path, and embeds only deployment constants. Leave `APP_VERSION`, `FRESHELL_APP_VERSION`, and their consumers unchanged.

- [ ] **Step 4: Add deployment status and ready receipt**

Write the ready receipt only after binding and resolving `listener.local_addr()`. It contains nonce, actual address, PID, boot ID, instance ID, generation ID, server component version, and build commit. A requested receipt that cannot be durably published makes startup fail. In live gated mode, validate a controller-published authorization containing the same nonce/generation, complete all fallible preparation, durably publish `activated.json`, then flip the ordinary-routing gate without another fallible operation. If the activated receipt cannot be made durable, remain gated and exit so the controller can restore prior.

- [ ] **Step 5: Run artifact/API tests and commit**

```bash
npm run test:vitest -- run test/unit/deployment-compatibility-artifact.test.ts
cargo test -p freshell-api
cargo test -p freshell-server --bin freshell-server
git add config/vite/vite.config.ts test/unit/deployment-compatibility-artifact.test.ts crates/freshell-server/build.rs crates/freshell-server/Cargo.toml crates/freshell-api/src/lib.rs crates/freshell-server/src/main.rs crates/freshell-server/src/rate_limit.rs Cargo.lock
git commit -m "feat(deploy): embed client and server deployment identity"
```

### Task 3: Bind Repo Runtime Assets

**Files:**
- Modify: `crates/freshell-platform/src/mcp_inject.rs`
- Modify: `crates/freshell-server/src/extensions.rs` tests if needed
- Add focused runtime-path tests where the existing crates keep them.

**Interfaces:**
- Produces `FRESHELL_MCP_SERVER_ENTRY` override; reuses existing `FRESHELL_CLIENT_DIR`, `FRESHELL_EXTENSIONS_DIR`, and `FRESHELL_CLAUDE_SIDECAR`.

- [ ] **Step 1: Write failing runtime override tests**

Prove each explicit generation runtime path wins over source/production fallback, empty overrides preserve existing behavior, and an invalid explicit path fails clearly rather than silently using checkout files.

- [ ] **Step 2: Add explicit MCP runtime override**

When `FRESHELL_MCP_SERVER_ENTRY` is non-empty, use that compiled JS path directly. Otherwise preserve existing production/source fallback exactly.

- [ ] **Step 3: Run focused runtime tests**

```bash
cargo test -p freshell-platform mcp
cargo test -p freshell-server extensions
```

- [ ] **Step 4: Refactor and commit**

```bash
git add crates/freshell-platform/src/mcp_inject.rs crates/freshell-platform/src/mcp_inject_tests.rs crates/freshell-server/src/extensions.rs
git commit -m "feat(deploy): bind immutable runtime paths"
```

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
- Produces atomic `current` selection pointer and `live.json` receipt with separate `selectedGenerationId` and `runningServerGenerationId`.
- Produces legacy `capture` using a verified `/proc/<pid>/exe`.

- [ ] **Step 1: Write failing path/store/manifest tests**

Cover invalid ports, symlinked/relative/unsafe roots, exclusive generation creation, cross-device import through sibling temp, digest/mode mismatch, concurrent locks, atomic pointer switch, separate selected/server generation identities, and refusal to clean any unmanifested path.

- [ ] **Step 2: Implement canonical store and manifest publication**

Every authoritative file uses write-temp, `sync_all`, rename, and parent-directory `sync_all`. Generations are immutable copies/reflinks, never hardlinks to mutable build output.

- [ ] **Step 3: Write failing legacy capture tests**

Inside a temp fixture, start an executable that owns a known listening socket, replace/unlink its pathname, verify path bytes differ, capture `/proc/<pid>/exe`, and assert boot ID/start time/device/inode/digest/mode plus socket-inode-to-PID ownership before and after the copy. A stale PID identifying another legitimate Freshell while a foreign process owns the requested port must be rejected. Also require captured client, extensions, sidecar, MCP runtime, lockfile-derived production dependencies, cwd, Node executable/version, and non-secret launch metadata.

- [ ] **Step 4: Implement legacy capture and fail-closed rules**

Do not treat the legacy PID file alone as ownership. Resolve the requested listener socket inode to the PID, open a pidfd, recheck boot/process/executable/socket identity immediately before any signal, and refuse on ambiguity. Capture must keep the observed process alive, revalidate after copying, scratch-start the captured closure—including actual sidecar and MCP imports—on port 0 with an isolated home, and mark the receipt `legacy: true` without inventing compatibility declarations.

- [ ] **Step 5: Run, refactor, and commit**

```bash
cargo test -p freshell-deploy --test generation_store
cargo test -p freshell-deploy --test legacy_capture
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 cargo test -p freshell-deploy --test legacy_capture actual_proc_capture -- --ignored --test-threads=1"
git add .gitignore crates/freshell-deploy Cargo.lock
git commit -m "feat(deploy): capture immutable working generations"
```

### Task 5: Durable Activation and Rollback State Machine

**Files:**
- Add modules under `crates/freshell-deploy/src/` for probe, journal, process control, activation, rollback, and recovery.
- Create: `crates/freshell-deploy/tests/transaction_state.rs`
- Create: `crates/freshell-deploy/tests/process_identity.rs` using fake process/pidfd adapters only; real signaling remains in Docker-only launcher tests.

**Interfaces:**
- Durable phases: `prepared`, `stop_old_intent`, `start_target_intent`, `target_ready_gated`, `switch_current_intent`, `activation_authorized`, `activated`, `rollback_complete`.
- Produces pidfd-bound SIGTERM/SIGKILL only for receipt-proven transaction candidates.
- For server/full updates, treats the target’s durable `activated` receipt as the commit/roll-forward boundary; before that receipt recovery restores prior, and after it recovery completes target activation. The target writes this receipt only after all fallible activation preparation and immediately before an infallible in-process gate flip admits ordinary traffic.
- For client-only updates, the atomic `current` pointer switch is the commit boundary because the unchanged server dereferences it per request.
- Keeps the candidate listener gated to nonce-authenticated controller checks until the relevant commit boundary.

- [ ] **Step 1: Write the state-table tests before implementation**

Table-drive controller death or IO failure before/after every durable intent and side effect. Assert: no live mutation before `prepared`; for server/full updates every failure before the durable target-owned `activated` receipt restores prior even if `current` was tentatively switched; after that receipt replay preserves target; for client-only updates pointer state determines prior versus target; no ordinary request is served by a candidate before its commit boundary; and a third-party pointer/port/process is never overwritten or signaled.

- [ ] **Step 2: Implement probe on actual port 0**

Launch with an allowlisted environment, isolated home/token, explicit staged runtime paths and production dependencies, nonce, generation ID, and ready-file path. Verify ready receipt, pidfd, boot ID/start time, executable inode/digest, Node executable/version, real sidecar/MCP imports, actual listener, and exact compatibility response, then terminate/reap the probe. Immediately before stopping the old server, repeat the same restartability/closure verification for the prior generation.

- [ ] **Step 3: Implement server/full activation**

Validate the candidate server declaration reciprocally against the selected client artifact before interruption. Durably prepare prior/target receipts, stop only the pidfd-proven old server with SIGTERM, and start the target from its immutable path in gated mode on the live port. Verify target identity/readiness and prepare its live/PID receipts. Tentatively switch `current` while the target still admits only nonce-authenticated controller checks. Send activation authorization; after all fallible preparation, the target durably publishes its own nonce/generation-bound `activated` receipt and immediately flips an in-process gate to admit ordinary traffic. That receipt is the commit point. Failure or controller death before it restores the prior pointer/server; recovery after it preserves and completes the target.

- [ ] **Step 4: Implement client-only activation**

Read the running server’s authenticated declaration and require reciprocal compatibility with the candidate client before publication. Require the running server identity before and after the switch; target generation reuses identical server/runtime/dependency digests, merges prior hashed assets into the candidate client, and prepares all receipts. The atomic `current` switch is the commit point and the only live mutation. Record `selectedGenerationId = target` while retaining `runningServerGenerationId = priorProcessGeneration`; a later restart launches the selected generation’s byte-identical server and then advances the process identity. A crash before the pointer switch retains prior; a crash after it preserves target and finishes receipts. Never signal the server.

- [ ] **Step 5: Implement rollback and replay**

Before the applicable commit boundary, rollback stops only a verified candidate. SIGKILL is permitted only through its verified pidfd after bounded SIGTERM failure. Restore the prior pointer, start the exact prior generation, verify identity/health/runtime imports plus ordinary service, and return the original deployment failure. After commit, replay preserves the target pointer and completes target activation/receipts. Foreign port theft, uncertain identity, unreadable receipts, or restart failure retain both generations and the active recovery receipt and fail closed.

- [ ] **Step 6: Run host-safe state/identity tests, refactor, and commit**

```bash
cargo test -p freshell-deploy --test transaction_state
cargo test -p freshell-deploy --test process_identity
git add crates/freshell-deploy Cargo.lock
git commit -m "feat(deploy): recover interrupted server activations"
```

These Cargo tests exercise deterministic adapters and never signal or stop a host process. The production Linux process adapter is exercised only by the explicitly sandboxed tests in Tasks 6–7.

### Task 6: Canonical Wrapper and Independent Update Modes

**Files:**
- Refactor: `scripts/launch-rust.sh`
- Create: `test/integration/server/launch-rust-real-boundary.sandbox.test.ts`
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

Reject invalid/repeated/conflicting flags and malformed ports before build. Prove each mode builds only its component set, uses exclusive private staging, never writes checkout `dist`/`target`, and rejects both incompatibility directions before stop/pointer switch. Prove plain `--skip-build` is a no-op when the current generation is already running and only `--skip-build --restart` interrupts it. Exercise client-only followed by stop, start, server-only activation, failed server activation, and rollback while asserting both selected-client and running-server generation identities at every step.

- [ ] **Step 2: Refactor shell to a thin wrapper**

The wrapper selects/builds a controller, creates private outputs, runs required typechecks, and passes exact artifact paths. It contains no `kill`, process scan, direct `mv` over live artifacts, or hand-built JSON.

- [ ] **Step 3: Implement generation assembly by mode**

Server runtime assembly includes staged compiled `dist/server`, built-in extensions, Claude sidecar, runtime overrides, `package.json`/lockfile, and a private `npm ci --omit=dev` production dependency closure. Client-only copies the selected server/runtime/dependency generation; server-only copies the selected client.

Combined bootstrap captures legacy before any command allowed to write non-private outputs. Because legacy artifacts have no declarations, one-sided modes remain unavailable. Bootstrap validates the staged client/server pair, starts the candidate server in the same controller-only gated mode, and uses the target-owned durable activation receipt as the commit boundary. A failure before that receipt restores the captured legacy generation. Tests cover interruption and replay at every boundary without inventing compatibility metadata for legacy artifacts.

Modify the ordinary server Vitest config to explicitly exclude `**/*.sandbox.test.ts`. The dedicated deploy-sandbox config includes only those files, has no global setup, and every sandbox test hard-fails unless `FRESHELL_DESTRUCTIVE_SANDBOX=1`. No Cargo auto-discovered test may send real signals; those boundaries are exercised through this dedicated config.

- [ ] **Step 4: Run exhaustive sandbox mode/failpoint tests**

```bash
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 npm run test:vitest -- run test/integration/server/launch-rust-real-boundary.sandbox.test.ts --config config/vitest/vitest.deploy-sandbox.config.ts --maxWorkers=1 --no-file-parallelism"
bash -n scripts/launch-rust.sh
```

- [ ] **Step 5: Refactor and commit**

```bash
git add scripts/launch-rust.sh config/vitest/vitest.deploy-sandbox.config.ts config/vitest/vitest.server.config.ts test/integration/server/launch-rust-real-boundary.sandbox.test.ts test/fixtures/launch-rust
git commit -m "feat(deploy): add compatibility-checked update modes"
```

### Task 7: Real-Boundary Rollback Proof and Operator Contract

**Files:**
- Create: `test/integration/server/launch-rust-real-boundary.sandbox.test.ts`
- Create: `test/e2e-browser/deployment-compatibility.spec.ts`
- Create: `test/e2e-browser/playwright.deploy-sandbox.config.ts`
- Modify: `crates/freshell-server/src/main.rs` with the sandbox-only
  `FRESHELL_TEST_EXIT_AFTER_DEPLOY_AUTHORIZATION=1` pre-commit failure seam
- Modify: `AGENTS.md`
- Modify only if verification exposes a defect: files from Tasks 1–6.

- [ ] **Step 1: Write one serial real-boundary scenario**

Use container `/tmp` for the complete runtime/store. Prebuild the real server with two Cargo jobs. Assert real ELF `/proc` identity, listening-socket ownership, immutable generation digests, explicit client/extensions/sidecar/MCP/dependency paths, successful real sidecar and MCP imports, real compatibility endpoint, exact seven-field health, and served unique client marker. Then activate a native candidate that passes shadow probe but exits before publishing its durable `activated` receipt on the requested live port and prove the controller restores the real prior binary/client generation with ordered events. Add a failpoint immediately after that receipt and prove recovery rolls forward to the exact target. Include the bootstrap path and prove a pre-commit failure restores the captured legacy generation.

- [ ] **Step 2: Run real-boundary verification**

```bash
scripts/sandbox-test.sh "CARGO_BUILD_JOBS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 cargo build --release -p freshell-server"
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 CARGO_BUILD_JOBS=2 npm run test:vitest -- run test/integration/server/launch-rust-real-boundary.sandbox.test.ts --config config/vitest/vitest.deploy-sandbox.config.ts --maxWorkers=1 --no-file-parallelism"
```

Expected: PASS without changing bind-mounted checkout `dist`, source, production home, or host processes.

- [ ] **Step 3: Run the exact-pair browser compatibility smoke**

Create a dedicated no-global-setup Playwright config whose server, browser profile, build outputs, and deployment store all live under container `/tmp`. Prove an unequal but mutually accepted client/server pair loads and preserves the normal tab layout across a server-only restart; prove both incompatibility directions are rejected before interruption. Also run the focused Rust boot/restart/reap, terminal-command, lazy-editor-chunk, and multi-pane restart cases through this contained harness. Cap Cargo jobs at 2.

Run:

```bash
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 CARGO_BUILD_JOBS=2 npx playwright test test/e2e-browser/deployment-compatibility.spec.ts --config test/e2e-browser/playwright.deploy-sandbox.config.ts --workers=1"
```

- [ ] **Step 4: Update operator instructions**

Document:

```text
scripts/launch-rust.sh --client-only
scripts/launch-rust.sh --server-only --restart
scripts/launch-rust.sh --restart
scripts/launch-rust.sh --skip-build
scripts/launch-rust.sh --skip-build --restart
```

Explain in plain language: different versions are normal; the selected client and server must both accept the pairing; incompatible updates stop before replacement; server candidates are tested before interruption; a failure before activation restores the recorded prior generation, while recovery after durable activation completes the new generation; plain `--skip-build` never restarts an already-running server; first adoption from legacy artifacts requires a combined approved restart; port 3002 still requires exact user approval `APPROVED`.

- [ ] **Step 5: Run full verification**

```bash
npm run lint
FRESHELL_TEST_SUMMARY='compatibility-aware independent client/server deploy final verification' npm run check
cargo test --workspace
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 cargo test -p freshell-deploy --test legacy_capture actual_proc_capture -- --ignored --test-threads=1"
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 CARGO_BUILD_JOBS=2 npm run test:vitest -- run test/integration/server/launch-rust-real-boundary.sandbox.test.ts --config config/vitest/vitest.deploy-sandbox.config.ts --maxWorkers=1 --no-file-parallelism"
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 CARGO_BUILD_JOBS=2 npx playwright test test/e2e-browser/deployment-compatibility.spec.ts --config test/e2e-browser/playwright.deploy-sandbox.config.ts --workers=1"
git diff --check 179c0d45eb4ae8c459dba37e0d0f7d22f2023bd0...HEAD
git status --short
```

Expected: PASS with only documented skips and a clean worktree after commits.

- [ ] **Step 6: Commit docs and any focused verification fixes**

```bash
git add AGENTS.md docs/superpowers/plans/2026-07-29-compatibility-aware-rust-deploys.md
git commit -m "docs: explain compatibility-checked Rust deploys"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1–3 implement truthful independent artifact declarations and immutable runtime paths. Tasks 4–6 make each update mode private, coherent, preflighted, and recoverable. Task 7 proves the production boundary and documents the plain-language behavior.
- **Production proof:** Fake fixtures cover malformed input and every fault boundary; the dedicated no-global-setup sandbox test sends a real Rust ELF through the actual controller and rollback path; a contained Playwright test covers unequal compatible versions and tab restoration through restart.
- **No silent deferral:** Compatible client-only/server-only/combined paths, both incompatibility directions, missing declarations, legacy bootstrap, interrupted transactions on both sides of activation, failed live start, candidate TERM refusal, foreign port ownership, rollback-start failure, and first-install cleanup all have explicit behavior/tests.
- **Scope guard:** No UI updater, downloader, session/pane repair, product-version coupling, generic host packaging, user-data rollback, or red-pane root-cause claim is included.
- **Type consistency:** Source and artifacts use canonical strings; bounds are always `minInclusive`/`maxExclusive`; client supports server and server supports client; receipts identify full immutable generations.
- **Truthful user promise:** Normal compatible updates proceed independently. Incompatible selected artifact pairs do not replace the live generation. A server failure before durable activation restores the exact prior recorded generation when Freshell can still safely own the port/process/storage. Once the target has durably activated, recovery completes that generation. If either recovery path is unsafe, Freshell preserves evidence and refuses dangerous guesses.
