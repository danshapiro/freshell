# Compatibility-Aware Rust Deploys Implementation Record

> **Status:** Implemented on `feat/deploy-compatibility-rollback`. This is an
> implementation record and maintenance checklist, not a from-scratch plan.
> The listed files already exist, completed steps are checked, and the retained
> commands verify the implementation as it exists. Do not recreate files or
> expect the historical tests to fail before implementation.

**Goal:** Let Freshell’s client and Rust server advance independently when both sides declare the pairing compatible, reject incompatible pairings before changing the live generation, and recover the exact prior working generation after a failed server activation.

**Architecture:** Each update is built into a private immutable generation containing the browser client and the complete repo-owned Rust runtime. A small Rust deployment controller—not shell process matching—validates reciprocal half-open version bounds, records exact artifact/process identity, switches a per-checkout/per-port generation pointer, and replays a durable rollback journal after failures or interruption; `scripts/launch-rust.sh` remains the canonical thin build/mode wrapper. For server-changing updates, the target-owned `activated.json` receipt is evidence rather than commit authority: the controller independently rechecks that receipt, the selected generation, the target process, and ordinary service before durably recording `activation_confirmed`. That controller-owned phase is the roll-forward authority.

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

- At initial validation, `origin/main` was green. A real Rust-browser harness boot/restart test, a real terminal-command test, and the multi-pane server-restart recovery test passed with the then-current client labeled `0.7.5` and Rust server labeled `0.7.0`. The implementation therefore seeded only these exact patch-level versions; no wider `0.7.x` compatibility claim was justified.
- npm and Rust semver range grammars disagree. Use canonical stable `MAJOR.MINOR.PATCH` strings, each numeric component restricted to canonical decimal `0..4294967295`, and structured `{ minInclusive, maxExclusive }` bounds. Both implementations consume one raw-string golden corpus. Reject prereleases, build metadata, leading zeros, floats, exponent notation, signs, whitespace, duplicate/unknown keys, and empty/inverted ranges.
- `APP_VERSION` is product-wide and feeds health, `/api/version`, diagnostics, logging, and release checks. Component version metadata must remain separate.
- Vite can emit a root manifest to an absolute private output, but Vite does not typecheck. Every client build retains `npm run typecheck:client`. Put the artifact build test in a new unmocked test because the existing Vite config test mocks `node:fs`.
- A plain `.mjs` helper using only Node built-ins works without `tsx` or `node_modules`; statically check it with TypeScript `allowJs/checkJs` plus `node --check`.
- The running server may be a deleted executable inode whose bytes differ from `target/release/freshell-server`; this is true in the present installation. Legacy capture and rollback must copy `/proc/<pid>/exe` after verifying boot ID/start time/inode/digest. Future servers launch from immutable generation paths.
- The rollback closure is larger than binary plus client. It includes built-in extensions, the Claude Node sidecar, the compiled MCP runtime, and an immutable lockfile-derived production `node_modules` closure for those Node entry points. Add explicit runtime overrides and copy these files into each generation. The Node executable/version, coding CLIs, `.env`, and user/provider data remain preflighted host prerequisites/state, not copied release artifacts.
- Rust retains an unresolved `FRESHELL_CLIENT_DIR` path and opens files per request. A stable `current/client` indirection permits a no-restart client-only switch. New client generations retain prior hashed assets so already-loaded tabs can still lazy-load old chunks.
- Compatibility preflight reads the selected client artifact declaration and the candidate/running server declaration. It does not infer artifact identity from browser connections.
- Current shell PID/cwd/argv checks cannot close PID reuse or signal races. The Rust controller uses kernel boot ID, `/proc` identity, pidfds, exact ready receipts, a single-user/non-hostile-same-UID threat model, and never kills by process scans or port ownership.
- The authoritative generation store is inside the checkout, outside ordinary `dist` and `target` build outputs. It uses private staging, recursive manifests/digests, sibling copy+fsync+rename publication, a checkout/port lock, atomic pointers, and a durable intent-before-side-effect journal. A candidate server may bind the live port in controller-only gated mode, but cannot serve ordinary browser/API traffic until it durably records its activation receipt and flips its gate. The controller does not treat that receipt alone as commit authority: server/full roll-forward requires the controller to validate the target state and durably record `activation_confirmed`; client-only recovery uses the atomic `current` pointer as its commit boundary.
- Existing artifacts have no declarations/receipts. The first transition captures and scratch-validates the actual working legacy closure before any non-private build, then permits only a combined declared update whose staged client/server pair is reciprocally compatible. Bootstrap recovery follows the same controller-confirmation rule: it restores the captured legacy generation unless it can validate the candidate receipt and target state and durably record `activation_confirmed`. One-sided modes fail closed until bootstrap succeeds; an emergency restart may use only the captured legacy receipt.
- Real E2E global setup can write checkout `dist` even when launched through the Docker sandbox. Deployment tests need a dedicated no-global-setup config and container `/tmp` fixture root. Use `CARGO_BUILD_JOBS=2` and `CMAKE_BUILD_PARALLEL_LEVEL=2` to stay within the sandbox PID budget.

## Implemented File Structure

- Added `config/deployment-compatibility.json` and `test/fixtures/deployment-compatibility/cases.jsonl`
  - Independent component versions/bounds and the shared raw JSON conformance corpus.
- Added `scripts/deployment-compatibility.mjs`
  - Dependency-free strict parser/projector/checker/JSONL serializer used at build time; no process signaling or transaction ownership.
- Updated `tsconfig.json` and `config/vite/vite.config.ts`, and added `test/unit/deployment-compatibility-artifact.test.ts`
  - Statically checks the helper, accepts only launcher-created absolute client output, and emits the client declaration/digest.
- Added `crates/freshell-deployment/`
  - Shared Rust declarations/comparison/manifest/receipt types and tests consuming the same corpus.
- Updated `crates/freshell-server/build.rs` and `crates/freshell-server/Cargo.toml`
  - Embed server deployment metadata without changing product version.
- Updated `crates/freshell-api/src/lib.rs`, `crates/freshell-server/src/main.rs`, and `crates/freshell-server/src/rate_limit.rs`
  - Authenticated operational compatibility status and nonce-bound actual-address ready receipts.
- Updated `crates/freshell-platform/src/mcp_inject.rs`
  - Explicit compiled MCP entry override.
- Added `crates/freshell-deploy/`
  - Rust deployment controller: canonical inputs, locks, immutable store, legacy capture, staging verification, pidfds, journal, activation, rollback, recovery.
- Refactored `scripts/launch-rust.sh`
  - Thin mode/build wrapper with `--server-only`, private builds, controller selection, and no direct process kill/artifact replacement.
- Added focused unit/integration tests plus explicitly excluded Docker-only tests under `test/integration/server/`, `crates/freshell-deploy/tests/`, and `config/vitest/vitest.deploy-sandbox.config.ts`. Real signals, process stops, crashes, and rollback run only from the dedicated sandbox config.
- Updated `AGENTS.md`
  - Exact operator commands, first-bootstrap rule, compatibility behavior, truthful rollback guarantee, and unchanged `APPROVED` rule.

### Completed Task 1: Canonical Cross-Language Compatibility Contract

**Files changed:**
- Added: `config/deployment-compatibility.json`
- Added: `test/fixtures/deployment-compatibility/cases.jsonl`
- Added: `scripts/deployment-compatibility.mjs`
- Added: `test/unit/server/deployment-compatibility.test.ts`
- Added: `crates/freshell-deployment/Cargo.toml`
- Added: `crates/freshell-deployment/src/lib.rs`
- Updated: `Cargo.lock`
- Updated: `tsconfig.json`

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

- [x] **Step 1: Added Node and Rust corpus tests before implementation**

The JSONL corpus stores `{name, raw, expectedCode, expectedCanonical?, expectedSha256?}` so lexical cases survive parsing and valid vectors prove byte-for-byte canonicalization/digest parity. Include valid exact bounds and invalid duplicate keys, unknown keys at every depth, leading zero, prerelease/build, signed/whitespace/exponent/float versions, component overflow, malformed schema version, missing reciprocal key, and both incompatibility directions.

Run:

```bash
npm run test:vitest -- run test/unit/server/deployment-compatibility.test.ts --config config/vitest/vitest.server.config.ts
cargo test -p freshell-deployment
```

Historical TDD result: these tests failed before either implementation existed. They pass now.

- [x] **Step 2: Implemented the dependency-free Node parser**

The implementation uses exact-key checks before value parsing and this canonical regex:

```js
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const MAX_COMPONENT = 4294967295n
```

Parsed `BigInt` components are compared explicitly—never as arrays with `<`. A small tokenizer rejects duplicate JSON keys before `JSON.parse`. CLI subcommands are `project`, `check`, and `event`; all output writes use a temporary sibling plus rename.

- [x] **Step 3: Implemented the Rust parser and identical codes**

The Rust parser rejects duplicate keys at every object depth before constructing a usable value, validates exact keys manually, parses version components as `u32`, and returns stable error codes matching the corpus. It does not use Rust semver ranges. It recomputes canonical bytes and SHA-256 server-side rather than trusting a client-supplied digest.

- [x] **Step 4: Made both corpus suites green and statically checked the helper**

Run:

```bash
node --check scripts/deployment-compatibility.mjs
npm run typecheck:client
npm run test:vitest -- run test/unit/server/deployment-compatibility.test.ts --config config/vitest/vitest.server.config.ts
cargo test -p freshell-deployment
```

Expected: PASS with every corpus line asserted by both languages.

- [x] **Step 5: Refactored and committed**

Parsing, comparison, projection, and CLI routing remain separate.

Historical checkpoint: `be5f7bcb7 feat(deploy): define reciprocal component compatibility`.

### Completed Task 2: Embed Artifact Identity Without Changing Product Version

**Files changed:**
- Updated: `config/vite/vite.config.ts`
- Added: `test/unit/deployment-compatibility-artifact.test.ts`
- Updated: `crates/freshell-server/build.rs`
- Updated: `crates/freshell-server/Cargo.toml`
- Updated: `crates/freshell-api/src/lib.rs`
- Updated: `crates/freshell-server/src/main.rs`
- Updated: `crates/freshell-server/src/rate_limit.rs`

**Interfaces:**
- Produces client artifact `deployment-compatibility.json`.
- Produces compile-time `FRESHELL_SERVER_COMPONENT_VERSION` and bounds.
- Produces authenticated `GET /api/deployment-compatibility` containing the running server declaration, server process generation ID, and boot ID.
- Produces optional durable ready receipt selected by `FRESHELL_DEPLOY_READY_FILE` and bound to `FRESHELL_DEPLOY_NONCE`.
- Produces optional live-port gated startup selected by `FRESHELL_DEPLOY_ACTIVATION_FILE`/`FRESHELL_DEPLOY_ACTIVATED_FILE`: controller checks remain available, ordinary routes remain unavailable, and matching durable authorization causes the server to publish its durable activated receipt immediately before an infallible in-process gate flip.

- [x] **Step 1: Added real client-artifact and Rust API tests before implementation**

The unmocked client test runs `npm run typecheck:client`, builds to an absolute temp directory, asserts the exact client manifest/digest, and asserts `dist/client` is unchanged. Rust router tests authenticate the endpoint, prove it bypasses only the rate bucket (not auth), prove `/api/health` remains exactly seven fields, and prove gated startup admits only nonce-authenticated controller checks until activation.

- [x] **Step 2: Implemented Vite projection**

The Vite projection rejects a non-absolute `FRESHELL_CLIENT_OUT_DIR` and emits the projected client declaration plus its canonical digest. Deployment metadata is not added to the browser WebSocket protocol.

- [x] **Step 3: Embedded server metadata while retaining `APP_VERSION`**

`build.rs` loads the contract through `freshell-deployment`, watches its absolute path, and embeds only deployment constants. Leave `APP_VERSION`, `FRESHELL_APP_VERSION`, and their consumers unchanged.

- [x] **Step 4: Added deployment status and ready receipt**

The implementation writes the ready receipt only after binding and resolving `listener.local_addr()`. It contains nonce, actual address, PID, boot ID, instance ID, generation ID, server component version, and build commit. A requested receipt that cannot be durably published makes startup fail. In live gated mode, the server validates a controller-published authorization containing the same nonce/generation, completes all fallible preparation, durably publishes `activated.json`, then flips the ordinary-routing gate without another fallible operation. If the activated receipt cannot be made durable, it remains gated and exits so the controller can restore prior.

- [x] **Step 5: Ran artifact/API tests and committed**

```bash
npm run test:vitest -- run test/unit/deployment-compatibility-artifact.test.ts
cargo test -p freshell-api
cargo test -p freshell-server --bin freshell-server
```

Historical checkpoint: `cb946e5df feat(deploy): embed client and server deployment identity`.

### Completed Task 3: Bind Repo Runtime Assets

**Files changed:**
- Updated: `crates/freshell-platform/src/mcp_inject.rs`
- Updated: `crates/freshell-server/src/extensions.rs` tests as needed
- Added focused runtime-path tests where the existing crates keep them.

**Interfaces:**
- Produces `FRESHELL_MCP_SERVER_ENTRY` override; reuses existing `FRESHELL_CLIENT_DIR`, `FRESHELL_EXTENSIONS_DIR`, and `FRESHELL_CLAUDE_SIDECAR`.

- [x] **Step 1: Added runtime override tests before implementation**

Prove each explicit generation runtime path wins over source/production fallback, empty overrides preserve existing behavior, and an invalid explicit path fails clearly rather than silently using checkout files.

- [x] **Step 2: Added explicit MCP runtime override**

When `FRESHELL_MCP_SERVER_ENTRY` is non-empty, use that compiled JS path directly. Otherwise preserve existing production/source fallback exactly.

- [x] **Step 3: Ran focused runtime tests**

```bash
cargo test -p freshell-platform mcp
cargo test -p freshell-server extensions
```

- [x] **Step 4: Refactored and committed**

Historical checkpoint: `37d8cc991 feat(deploy): bind immutable runtime paths`.

### Completed Task 4: Immutable Generation Store and Legacy Bootstrap

**Files changed:**
- Added: `crates/freshell-deploy/Cargo.toml`
- Added: `crates/freshell-deploy/src/main.rs`
- Added focused modules under `crates/freshell-deploy/src/` for paths, manifests, locks, process identity, receipts, and store.
- Added: `crates/freshell-deploy/tests/generation_store.rs`
- Updated: `.gitignore`

**Interfaces:**
- Store root: `<canonical-checkout>/.freshell-deploy/ports/<port>/`
- Produces immutable generation manifest covering relative path, type, mode, symlink target, and SHA-256.
- Produces atomic `current` selection pointer and `live.json` receipt with separate `selectedGenerationId` and `runningServerGenerationId`.
- Produces legacy `capture` using a verified `/proc/<pid>/exe`.

- [x] **Step 1: Added path/store/manifest tests before implementation**

Cover invalid ports, symlinked/relative/unsafe roots, exclusive generation creation, cross-device import through sibling temp, digest/mode mismatch, concurrent locks, atomic pointer switch, separate selected/server generation identities, and refusal to clean any unmanifested path.

- [x] **Step 2: Implemented canonical store and manifest publication**

Every authoritative file uses write-temp, `sync_all`, rename, and parent-directory `sync_all`. Generations are immutable copies/reflinks, never hardlinks to mutable build output.

- [x] **Step 3: Added legacy capture tests before implementation**

Inside a temp fixture, start an executable that owns a known listening socket, replace/unlink its pathname, verify path bytes differ, capture `/proc/<pid>/exe`, and assert boot ID/start time/device/inode/digest/mode plus socket-inode-to-PID ownership before and after the copy. A stale PID identifying another legitimate Freshell while a foreign process owns the requested port must be rejected. Also require captured client, extensions, sidecar, MCP runtime, lockfile-derived production dependencies, cwd, Node executable/version, and non-secret launch metadata.

- [x] **Step 4: Implemented legacy capture and fail-closed rules**

The legacy PID file alone is not treated as ownership. Capture resolves the requested listener socket inode to the PID, opens a pidfd, rechecks boot/process/executable/socket identity immediately before any signal, and refuses ambiguity. It keeps the observed process alive, revalidates after copying, scratch-starts the captured closure—including actual sidecar and MCP imports—on port 0 with an isolated home, and marks the receipt `legacy: true` without inventing compatibility declarations.

- [x] **Step 5: Ran tests, refactored, and committed**

```bash
cargo test -p freshell-deploy --test generation_store
cargo test -p freshell-deploy --test legacy_capture
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 cargo test -p freshell-deploy --test legacy_capture actual_proc_capture -- --ignored --test-threads=1"
```

Historical checkpoint: `0a67fcdc1 feat(deploy): capture immutable working generations`.

### Completed Task 5: Durable Activation and Rollback State Machine

**Files changed:**
- Added modules under `crates/freshell-deploy/src/` for probe, journal, process control, activation, rollback, and recovery.
- Added: `crates/freshell-deploy/tests/transaction_state.rs`
- Added: `crates/freshell-deploy/tests/process_identity.rs` using fake process/pidfd adapters only; real signaling remains in Docker-only launcher tests.

**Interfaces:**
- Durable phases: `prepared`, `stop_old_intent`, `start_target_intent`, `target_ready_gated`, `switch_current_intent`, `activation_authorized`, `activated`, `activation_confirmed`, `rollback_complete`.
- Produces pidfd-bound SIGTERM/SIGKILL only for receipt-proven transaction candidates.
- For server/full updates, the target writes its durable `activated.json` receipt only after all fallible activation preparation and immediately before an infallible in-process gate flip admits ordinary traffic. That target-owned receipt is necessary evidence, but it is not commit authority by itself. The controller verifies the nonce/generation-bound receipt, selected generation, target process identity, and ordinary service, then durably records `activation_confirmed`; this controller-owned phase is the commit/roll-forward authority. If interruption occurs after the target receipt but before confirmation, recovery must repeat those checks before it may record `activation_confirmed` and finish the target. If the evidence is absent or cannot be proven, recovery restores the prior generation or fails closed when safe restoration cannot be proven.
- For client-only updates, the atomic `current` pointer switch is the commit boundary because the unchanged server dereferences it per request.
- Keeps the candidate listener gated to nonce-authenticated controller checks until it durably writes its receipt after controller authorization; the gate then flips without another fallible server operation, and the controller's independent validation plus durable `activation_confirmed` follows as the server-changing commit authority.

- [x] **Step 1: Added the state-table tests before implementation**

The tests table-drive controller death or IO failure before/after every durable intent and side effect. They assert: no live mutation before `prepared`; for server/full updates a target receipt never grants authority on its own; recovery may roll forward only after independently validating the receipt, selected generation, target process, and ordinary service and durably recording `activation_confirmed`; otherwise it restores prior or fails closed; for client-only updates pointer state determines prior versus target; no ordinary request is served by a candidate before authorization; and a third-party pointer/port/process is never overwritten or signaled.

- [x] **Step 2: Implemented probe on actual port 0**

The probe launches with an allowlisted environment, isolated home/token, explicit staged runtime paths and production dependencies, nonce, generation ID, and ready-file path. It verifies the ready receipt, pidfd, boot ID/start time, executable inode/digest, Node executable/version, real sidecar/MCP imports, actual listener, and exact compatibility response, then terminates and reaps the probe. Immediately before stopping the old server, the controller repeats the same restartability/closure verification for the prior generation.

- [x] **Step 3: Implemented server/full activation**

The controller validates the candidate server declaration reciprocally against the selected client artifact before interruption. It durably prepares prior/target receipts, stops only the pidfd-proven old server with SIGTERM, and starts the target from its immutable path in gated mode on the live port. It verifies target identity/readiness and prepares its live/PID receipts. It tentatively switches `current` while the target still admits only nonce-authenticated controller checks. It sends activation authorization; after all fallible preparation, the target durably publishes its own nonce/generation-bound `activated.json` receipt and immediately flips an in-process gate to admit ordinary traffic. The controller then verifies the receipt, target process, selected generation, and ordinary service before saving `activation_confirmed`. Recovery can repeat that confirmation after interruption; it does not treat the target receipt alone as commit authority.

- [x] **Step 4: Implemented client-only activation**

Client-only activation reads the running server’s authenticated declaration and requires reciprocal compatibility with the candidate client before publication. It requires the running server identity before and after the switch; the target generation reuses identical server/runtime/dependency digests, merges prior hashed assets into the candidate client, and prepares all receipts. The atomic `current` switch is the commit point and the only live mutation. The live receipt records `selectedGenerationId = target` while retaining `runningServerGenerationId = priorProcessGeneration`; a later restart launches the selected generation’s byte-identical server and then advances the process identity. A crash before the pointer switch retains prior; a crash after it preserves target and finishes receipts. The client-only path never signals the server.

- [x] **Step 5: Implemented rollback and replay**

Before the applicable commit boundary, rollback stops only a verified candidate. SIGKILL is permitted only through its verified pidfd after bounded SIGTERM failure. Recovery restores the prior pointer, starts the exact prior generation, verifies identity/health/runtime imports plus ordinary service, and returns the original deployment failure. After durable `activation_confirmed`, replay preserves the target pointer and completes target receipts. When only a target receipt exists, recovery first repeats the controller confirmation checks and persists `activation_confirmed`; it never mints that authority from an unreadable or unverified receipt. Foreign port theft, uncertain identity, unreadable receipts, or restart failure retain both generations and the active recovery receipt and fail closed.

- [x] **Step 6: Ran host-safe state/identity tests, refactored, and committed**

```bash
cargo test -p freshell-deploy --test transaction_state
cargo test -p freshell-deploy --test process_identity
```

Historical checkpoint: `ccafe5153 feat(deploy): recover interrupted server activations`.

These Cargo tests exercise deterministic adapters and never signal or stop a host process. The production Linux process adapter is exercised only by the explicitly sandboxed tests in Tasks 6–7.

### Completed Task 6: Canonical Wrapper and Independent Update Modes

**Files changed:**
- Refactored: `scripts/launch-rust.sh`
- Added: `test/integration/server/launch-rust-real-boundary.sandbox.test.ts`
- Added: `config/vitest/vitest.deploy-sandbox.config.ts`
- Updated: `config/vitest/vitest.server.config.ts`
- Added fixture commands beneath `test/fixtures/launch-rust/`

**Interfaces:**
- `--client-only`: typecheck/build private client; controller reuses server/runtime.
- `--server-only --restart`: typecheck/build private server JS, Rust binary, controller, extensions/sidecar; controller reuses client.
- `--restart`: privately build both components/runtime and activate combined.
- `--skip-build`: preserve existing behavior: start the exact current generation only when it is not already running; never restart a running server by itself.
- `--skip-build --restart`: restart the exact current generation through its stored controller; no npm/Cargo/tsx dependency.
- `--stop`: stop only receipt-proven current process.

- [x] **Step 1: Added the complete flag/build/preflight matrix before implementation**

The matrix rejects invalid/repeated/conflicting flags and malformed ports before build. It proves each mode builds only its component set, uses exclusive private staging, never writes checkout `dist`/`target`, and rejects both incompatibility directions before stop/pointer switch. It proves plain `--skip-build` is a no-op when the current generation is already running and only `--skip-build --restart` interrupts it. It exercises client-only followed by stop, start, server-only activation, failed server activation, and rollback while asserting both selected-client and running-server generation identities at every step.

- [x] **Step 2: Refactored the shell to a thin wrapper**

The wrapper selects/builds a controller, creates private outputs, runs required typechecks, and passes exact artifact paths. It contains no `kill`, process scan, direct `mv` over live artifacts, or hand-built JSON.

- [x] **Step 3: Implemented generation assembly by mode**

Server runtime assembly includes staged compiled `dist/server`, built-in extensions, Claude sidecar, runtime overrides, `package.json`/lockfile, and a private `npm ci --omit=dev` production dependency closure. Client-only copies the selected server/runtime/dependency generation; server-only copies the selected client.

Combined bootstrap captures legacy before any command allowed to write non-private outputs. Because legacy artifacts have no declarations, one-sided modes remain unavailable. Bootstrap validates the staged client/server pair and starts the candidate server in the same controller-only gated mode. As with later server-changing updates, the target-owned activation receipt is evidence; the controller's durable `activation_confirmed` phase is the roll-forward authority. Recovery after a receipt but before confirmation repeats the full target-state validation before confirming, while absent or unprovable evidence restores the captured legacy generation or fails closed. Tests cover interruption and replay at every boundary without inventing compatibility metadata for legacy artifacts.

The ordinary server Vitest config explicitly excludes `**/*.sandbox.test.ts`. The dedicated deploy-sandbox config includes only those files, has no global setup, and every sandbox test hard-fails unless `FRESHELL_DESTRUCTIVE_SANDBOX=1`. No Cargo auto-discovered test sends real signals; those boundaries are exercised through this dedicated config.

- [x] **Step 4: Ran exhaustive sandbox mode/failpoint tests**

```bash
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 npm run test:vitest -- run test/integration/server/launch-rust-real-boundary.sandbox.test.ts --config config/vitest/vitest.deploy-sandbox.config.ts --maxWorkers=1 --no-file-parallelism"
bash -n scripts/launch-rust.sh
```

- [x] **Step 5: Refactored and committed**

Historical checkpoint: `36f8d1d32 feat(deploy): add compatibility-checked update modes`.

### Completed Task 7: Real-Boundary Rollback Proof and Operator Contract

**Files changed:**
- Added: `test/integration/server/launch-rust-real-boundary.sandbox.test.ts`
- Added: `test/e2e-browser/deployment-compatibility.spec.ts`
- Added: `test/e2e-browser/playwright.deploy-sandbox.config.ts`
- Updated: `crates/freshell-server/src/main.rs` with the sandbox-only
  `FRESHELL_TEST_EXIT_AFTER_DEPLOY_AUTHORIZATION=1` pre-commit failure seam
- Updated: `AGENTS.md`
- Updated files from Tasks 1–6 only when verification exposed a defect.

- [x] **Step 1: Added one serial real-boundary scenario**

The scenario uses container `/tmp` for the complete runtime/store and prebuilds the real server with two Cargo jobs. It asserts real ELF `/proc` identity, listening-socket ownership, immutable generation digests, explicit client/extensions/sidecar/MCP/dependency paths, successful real sidecar and MCP imports, real compatibility endpoint, exact seven-field health, and a served unique client marker. It then activates a native candidate that passes shadow probe but exits before publishing its durable `activated` receipt on the requested live port and proves the controller restores the real prior binary/client generation with ordered events. Separate failpoints immediately after the target receipt and after `activation_confirmed` prove that recovery independently confirms the former before rolling forward and directly completes the latter. The scenario includes the bootstrap path and proves a pre-confirmation failure without valid target evidence restores the captured legacy generation.

- [x] **Step 2: Ran real-boundary verification**

```bash
scripts/sandbox-test.sh "CARGO_BUILD_JOBS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 cargo build --release -p freshell-server"
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 CARGO_BUILD_JOBS=2 npm run test:vitest -- run test/integration/server/launch-rust-real-boundary.sandbox.test.ts --config config/vitest/vitest.deploy-sandbox.config.ts --maxWorkers=1 --no-file-parallelism"
```

Expected: PASS without changing bind-mounted checkout `dist`, source, production home, or host processes.

- [x] **Step 3: Ran the exact-pair browser compatibility smoke**

The dedicated no-global-setup Playwright config keeps its server, browser profile, build outputs, and deployment store under container `/tmp`. It proves an unequal but mutually accepted client/server pair loads and preserves the normal tab layout across a server-only restart, and that both incompatibility directions are rejected before interruption. The contained harness also runs the focused Rust boot/restart/reap, terminal-command, lazy-editor-chunk, and multi-pane restart cases with Cargo jobs capped at 2.

Run:

```bash
scripts/sandbox-test.sh "FRESHELL_DESTRUCTIVE_SANDBOX=1 CARGO_BUILD_JOBS=2 npx playwright test test/e2e-browser/deployment-compatibility.spec.ts --config test/e2e-browser/playwright.deploy-sandbox.config.ts --workers=1"
```

- [x] **Step 4: Updated operator instructions**

The operator documentation records:

```text
scripts/launch-rust.sh --client-only
scripts/launch-rust.sh --server-only --restart
scripts/launch-rust.sh --restart
scripts/launch-rust.sh --skip-build
scripts/launch-rust.sh --skip-build --restart
```

It explains in plain language: different versions are normal; the selected client and server must both accept the pairing; incompatible updates stop before replacement; server candidates are tested before interruption; recovery restores the recorded prior generation unless it can independently validate the target and durably record controller confirmation, after which it completes the new generation; plain `--skip-build` never restarts an already-running server; first adoption from legacy artifacts requires a combined approved restart; port 3002 still requires exact user approval `APPROVED`.

- [x] **Step 5: Ran full verification**

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

- [x] **Step 6: Committed docs and focused verification fixes**

Historical checkpoint: `9d1aa6d6a docs: explain compatibility-checked Rust deploys`.

## Implementation Self-Review

- **Spec coverage:** Tasks 1–3 implement truthful independent artifact declarations and immutable runtime paths. Tasks 4–6 make each update mode private, coherent, preflighted, and recoverable. Task 7 proves the production boundary and documents the plain-language behavior.
- **Production proof:** Fake fixtures cover malformed input and every fault boundary; the dedicated no-global-setup sandbox test sends a real Rust ELF through the actual controller and rollback path; a contained Playwright test covers unequal compatible versions and tab restoration through restart.
- **No silent deferral:** Compatible client-only/server-only/combined paths, both incompatibility directions, missing declarations, legacy bootstrap, interrupted transactions on both sides of activation, failed live start, candidate TERM refusal, foreign port ownership, rollback-start failure, and first-install cleanup all have explicit behavior/tests.
- **Scope guard:** No UI updater, downloader, session/pane repair, product-version coupling, generic host packaging, user-data rollback, or red-pane root-cause claim is included.
- **Type consistency:** Source and artifacts use canonical strings; bounds are always `minInclusive`/`maxExclusive`; client supports server and server supports client; receipts identify full immutable generations.
- **Truthful user promise:** Normal compatible updates proceed independently. Incompatible selected artifact pairs do not replace the live generation. A server failure without provable target evidence restores the exact prior recorded generation when Freshell can still safely own the port/process/storage. A target receipt alone is not authority: recovery completes the target only after the controller validates the receipt, selected generation, process identity, and ordinary service and durably records `activation_confirmed`. If either recovery path is unsafe, Freshell preserves evidence and refuses dangerous guesses.
