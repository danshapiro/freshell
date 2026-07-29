# Compatibility-Aware Rust Deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Freshell client and Rust server advance independently when both artifacts declare the pairing compatible, reject incompatible pairings before replacing either artifact, and restore the last working server after a failed server deployment.

**Architecture:** Add one source-controlled compatibility contract whose client and server entries have independent semantic versions and independent supported-version ranges. Embed the server declaration in the Rust binary, emit the client declaration into the built client directory, and make the canonical launcher stage builds, mutually validate the two declarations, probe a candidate server away from the live port, then replace artifacts transactionally with rollback.

**Tech Stack:** Bash, Node.js 22, TypeScript/ESM, Zod, `semver`, Vite 6, Rust 1.96, Axum, Vitest, Cargo tests, disposable Docker test sandbox.

## Global Constraints

- Work only in `.worktrees/deploy-compatibility-rollback` on branch `feat/deploy-compatibility-rollback`, based on verified-green `origin/main` commit `ab9c3381dab642c57b1c2c54700c2eaf81e02fcb`.
- Preserve deliberate independent advancement: a client version and a server version do not need to be equal, share a release number, or come from the same commit.
- A client-only update proceeds only when the candidate client accepts the running server version and the running server accepts the candidate client version.
- A server-only update proceeds only when the candidate server accepts the installed client version and the installed client accepts the candidate server version.
- A combined update validates the staged client and staged server against each other.
- Reject missing, malformed, or mutually incompatible declarations before replacing `dist/client` or `target/release/freshell-server`.
- Probe a candidate server on an isolated temporary port and temporary Freshell home before stopping a running server.
- If the replacement server does not become healthy on the requested port, restore and restart the previously working server; during a combined update, also restore the prior client so the restored pair remains compatible.
- Do not claim this change explains or fixes the earlier red-pane incident.
- Do not change the WebSocket protocol version or relax its exact handshake check.
- Do not add an in-product update screen or automatic updater.
- Do not restart or deploy to the live self-hosted server on port 3002 during implementation or verification.
- Run process-stop, failed-start, and rollback integration tests only through `scripts/sandbox-test.sh`.
- Preserve the launcher's pid-file, cwd, executable-path, and foreign-port safety checks.
- Keep human-readable launcher output and add structured JSONL deployment events without logging `AUTH_TOKEN`.
- Use red-green-refactor TDD, focused commits, NodeNext `.js` import suffixes where applicable, and do not open a PR without explicit user approval.

---

## Load-Bearing Validation Results

This section is intentionally reserved for verified facts from the required load-bearing review. It must be populated before execution; it may revise implementation details but must not expand or reduce the scope above.

## File Structure

- Create `config/deployment-compatibility.json`
  - The sole editable compatibility declaration, with independent client/server versions and reciprocal semver ranges.
- Create `scripts/deployment-compatibility.ts`
  - Zod validation, semver mutual-compatibility checks, artifact projection, and a small CLI used by the launcher and tests.
- Modify `config/vite/vite.config.ts`
  - Builds to an optional staging directory and emits only the client half as `deployment-compatibility.json`.
- Modify `package.json` and `package-lock.json`
  - Add direct `semver` and `@types/semver` dependencies used by the production launcher helper.
- Modify `crates/freshell-server/build.rs`
  - Validates the server entry at compile time and embeds its version/range into the candidate binary.
- Create `crates/freshell-deployment/Cargo.toml` and `crates/freshell-deployment/src/lib.rs`
  - Own the Rust representation and semver validation used by the build script and API.
- Modify `crates/freshell-api/src/lib.rs`
  - Adds the unauthenticated, additive `GET /api/deployment-compatibility` route without changing the seven-field health response.
- Modify `crates/freshell-server/src/main.rs`
  - Supplies the embedded server declaration to the API and uses the declared server version as the default app version.
- Create `test/unit/server/deployment-compatibility.test.ts`
  - Protects schema validation, projection, independent versions, reciprocal checks, and useful failure messages.
- Modify `test/unit/vite-config.test.ts`
  - Protects staged output and client artifact emission.
- Add Rust unit tests in `crates/freshell-api/src/lib.rs` and `crates/freshell-deployment/src/lib.rs`
  - Protect the new route shape and build-time parsing.
- Refactor `scripts/launch-rust.sh`
  - Adds `--server-only`, staging, preflight probing, compatibility validation, atomic replacement, rollback, and structured deployment events while retaining lifecycle safety.
- Create `test/integration/server/launch-rust-deployment.test.ts`
  - A fixture-driven launcher contract suite for build selection and all pre-replacement decisions.
- Create `test/fixtures/launch-rust/`
  - Fake build commands and a small fake server used only inside the disposable sandbox to exercise real launcher process behavior.
- Modify `AGENTS.md`
  - Documents the new `--server-only` command and the compatibility/rollback guarantees for future operators and agents.

### Task 1: Define and Validate Independent Compatibility Declarations

**Files:**
- Create: `config/deployment-compatibility.json`
- Create: `scripts/deployment-compatibility.ts`
- Create: `test/unit/server/deployment-compatibility.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `type DeploymentComponent = 'client' | 'server'`
- Produces: `type DeploymentDeclaration = { schemaVersion: 1; component: DeploymentComponent; version: string; supports: { client?: string; server?: string } }`
- Produces: `loadSourceContract(path: string): DeploymentSourceContract`
- Produces: `projectDeclaration(contract: DeploymentSourceContract, component: DeploymentComponent): DeploymentDeclaration`
- Produces: `readDeclaration(path: string, expected: DeploymentComponent): DeploymentDeclaration`
- Produces: `assertMutuallyCompatible(client: DeploymentDeclaration, server: DeploymentDeclaration): void`
- Produces CLI: `tsx scripts/deployment-compatibility.ts project <client|server> <source-file> <output-file>`
- Produces CLI: `tsx scripts/deployment-compatibility.ts check <client-file> <server-file>`

- [ ] **Step 1: Add direct semver dependencies**

Run:

```bash
npm install --save semver@^7.7.4
npm install --save-dev @types/semver@^7.7.1
```

Expected: `package.json` and `package-lock.json` record direct dependencies; no unrelated package changes are made.

- [ ] **Step 2: Write the failing compatibility tests**

Create `test/unit/server/deployment-compatibility.test.ts` with table-driven tests that:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  assertMutuallyCompatible,
  projectDeclaration,
  type DeploymentSourceContract,
} from '../../../scripts/deployment-compatibility.js'

const contract: DeploymentSourceContract = {
  schemaVersion: 1,
  client: { version: '12.1.0', supportsServer: '>=12.0.0 <13.0.0' },
  server: { version: '12.0.0', supportsClient: '>=12.0.0 <13.0.0' },
}

describe('deployment compatibility', () => {
  it('accepts deliberately different, mutually supported client and server versions', () => {
    expect(() => assertMutuallyCompatible(
      projectDeclaration(contract, 'client'),
      projectDeclaration(contract, 'server'),
    )).not.toThrow()
  })

  it.each([
    {
      name: 'candidate client rejects server',
      client: { ...contract.client, supportsServer: '>=13.0.0 <14.0.0' },
      message: /client 12\.1\.0 does not support server 12\.0\.0/,
    },
    {
      name: 'server rejects candidate client',
      server: { ...contract.server, supportsClient: '>=11.0.0 <12.0.0' },
      message: /server 12\.0\.0 does not support client 12\.1\.0/,
    },
  ])('rejects when $name', ({ client = contract.client, server = contract.server, message }) => {
    const changed = { ...contract, client, server }
    expect(() => assertMutuallyCompatible(
      projectDeclaration(changed, 'client'),
      projectDeclaration(changed, 'server'),
    )).toThrow(message)
  })

  it('rejects malformed versions, ranges, wrong component projections, and missing fields', () => {
    // Use temporary JSON files and readDeclaration/loadSourceContract to assert
    // each error names the file, component, and invalid field.
  })
})
```

Replace the final explanatory comment with concrete temporary-file assertions for `version: "twelve"`, `supportsClient: "maybe"`, a client file passed as `expected: 'server'`, and a missing server entry.

- [ ] **Step 3: Run the focused test and confirm red**

Run:

```bash
npm run test:vitest -- run test/unit/server/deployment-compatibility.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: FAIL because `scripts/deployment-compatibility.ts` does not exist.

- [ ] **Step 4: Implement the contract and helper**

Create `config/deployment-compatibility.json`:

```json
{
  "schemaVersion": 1,
  "client": {
    "version": "0.7.5",
    "supportsServer": ">=0.7.0 <0.8.0"
  },
  "server": {
    "version": "0.7.0",
    "supportsClient": ">=0.7.0 <0.8.0"
  }
}
```

Implement `scripts/deployment-compatibility.ts` with strict Zod schemas, `semver.valid`, `semver.validRange`, and `semver.satisfies`. Projected artifacts must have exactly one reciprocal range:

```ts
export type DeploymentSourceContract = z.infer<typeof sourceContractSchema>
export type DeploymentDeclaration = z.infer<typeof declarationSchema>

export function projectDeclaration(
  source: DeploymentSourceContract,
  component: DeploymentComponent,
): DeploymentDeclaration {
  return component === 'client'
    ? {
        schemaVersion: 1,
        component: 'client',
        version: source.client.version,
        supports: { server: source.client.supportsServer },
      }
    : {
        schemaVersion: 1,
        component: 'server',
        version: source.server.version,
        supports: { client: source.server.supportsClient },
      }
}

export function assertMutuallyCompatible(
  client: DeploymentDeclaration,
  server: DeploymentDeclaration,
): void {
  if (!semver.satisfies(server.version, client.supports.server!, { includePrerelease: true })) {
    throw new Error(
      `Incompatible deployment: client ${client.version} does not support server ${server.version} ` +
      `(accepted server range: ${client.supports.server})`,
    )
  }
  if (!semver.satisfies(client.version, server.supports.client!, { includePrerelease: true })) {
    throw new Error(
      `Incompatible deployment: server ${server.version} does not support client ${client.version} ` +
      `(accepted client range: ${server.supports.client})`,
    )
  }
}
```

The CLI must write files via a temporary sibling plus `rename`, print one concise success line, print validation errors to stderr, and exit non-zero. Guard CLI execution using `import.meta.url === pathToFileURL(process.argv[1]).href`.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm run test:vitest -- run test/unit/server/deployment-compatibility.test.ts --config config/vitest/vitest.server.config.ts
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 6: Refactor and commit**

Remove duplicated validation/error formatting, rerun Step 5, then:

```bash
git add config/deployment-compatibility.json scripts/deployment-compatibility.ts test/unit/server/deployment-compatibility.test.ts package.json package-lock.json
git commit -m "feat(deploy): define independent compatibility declarations"
```

### Task 2: Put the Declarations in the Built Client and Server

**Files:**
- Modify: `config/vite/vite.config.ts`
- Modify: `test/unit/vite-config.test.ts`
- Create: `crates/freshell-deployment/Cargo.toml`
- Create: `crates/freshell-deployment/src/lib.rs`
- Modify: `crates/freshell-server/build.rs`
- Modify: `crates/freshell-server/Cargo.toml`
- Modify: `crates/freshell-api/src/lib.rs`
- Modify: `crates/freshell-server/src/main.rs`

**Interfaces:**
- Consumes: `projectDeclaration` and `config/deployment-compatibility.json` from Task 1.
- Produces client artifact: `<client-out-dir>/deployment-compatibility.json`
- Produces Rust parser: `freshell_deployment::load_source_contract(path: &Path) -> Result<SourceContract, CompatibilityError>`
- Produces Rust compile-time values: `FRESHELL_SERVER_VERSION`, `FRESHELL_SERVER_SUPPORTS_CLIENT`
- Produces API: `GET /api/deployment-compatibility` returning a `DeploymentCompatibility` server declaration.

- [ ] **Step 1: Write failing Vite artifact tests**

Extend `test/unit/vite-config.test.ts` to resolve the production config with:

```ts
process.env.FRESHELL_CLIENT_OUT_DIR = temporaryOutDir
const resolved = await resolveConfig({ configFile, mode: 'production' }, 'build')
expect(resolved.build.outDir).toBe(temporaryOutDir)
```

Run the Vite build in a temporary output directory and assert `deployment-compatibility.json` equals:

```json
{
  "schemaVersion": 1,
  "component": "client",
  "version": "0.7.5",
  "supports": { "server": ">=0.7.0 <0.8.0" }
}
```

Restore the environment in `finally`.

- [ ] **Step 2: Run the Vite test and confirm red**

Run:

```bash
npm run test:vitest -- run test/unit/vite-config.test.ts
```

Expected: FAIL because the output override and emitted declaration do not exist.

- [ ] **Step 3: Implement staged Vite output and declaration emission**

In `config/vite/vite.config.ts`, load and validate the source contract once, project the client entry, and add a focused plugin:

```ts
const deploymentContract = loadSourceContract(
  path.join(projectRoot, 'config/deployment-compatibility.json'),
)
const clientDeclaration = projectDeclaration(deploymentContract, 'client')

const deploymentCompatibilityPlugin = {
  name: 'freshell-deployment-compatibility',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'deployment-compatibility.json',
      source: `${JSON.stringify(clientDeclaration, null, 2)}\n`,
    })
  },
}
```

Add it after `react()` and set:

```ts
outDir: process.env.FRESHELL_CLIENT_OUT_DIR || 'dist/client'
```

- [ ] **Step 4: Run the Vite test and confirm green**

Run:

```bash
npm run test:vitest -- run test/unit/vite-config.test.ts
npm run typecheck:client
```

Expected: PASS.

- [ ] **Step 5: Write failing Rust tests**

In `crates/freshell-deployment/src/lib.rs`, add table-driven tests proving `12.1.0` client / `12.0.0` server declarations are valid while malformed versions, malformed ranges, absent components, and unknown fields are rejected. In `crates/freshell-api/src/lib.rs`, add a `DeploymentCompatibility` value to `sample_state` and tests asserting:

```rust
assert_eq!(
    deployment_compatibility_body(&sample_state(true)),
    json!({
        "schemaVersion": 1,
        "component": "server",
        "version": "12.0.0",
        "supports": { "client": ">=12.0.0 <13.0.0" }
    })
);
```

Also assert the existing health test still has exactly seven fields.

- [ ] **Step 6: Run the Rust tests and confirm red**

Run:

```bash
cargo test -p freshell-api
cargo test -p freshell-deployment
```

Expected: FAIL because the deployment crate and API state/route do not exist.

- [ ] **Step 7: Embed and serve the server declaration**

Create `freshell-deployment` with `serde`, `serde_json`, `semver`, strict `deny_unknown_fields` structs, and the tested `load_source_contract` function. Add it as a normal dependency of `freshell-api` and a build dependency of `freshell-server`. In `build.rs`, watch `../../config/deployment-compatibility.json` and load its validated server entry:

```rust
struct ServerCompatibility {
    version: String,
    supports_client: String,
}
```

Reject invalid semantic versions/ranges at build time through the shared crate. Emit:

```rust
println!("cargo:rustc-env=FRESHELL_SERVER_VERSION={}", server.version);
println!(
    "cargo:rustc-env=FRESHELL_SERVER_SUPPORTS_CLIENT={}",
    server.supports_client
);
```

In `freshell-api`, introduce:

```rust
#[derive(Clone)]
pub struct DeploymentCompatibility {
    pub version: Arc<String>,
    pub supports_client: Arc<String>,
}
```

Add it to `ApiState`, add `.route("/api/deployment-compatibility", get(deployment_compatibility))`, and return the exact server declaration shown in Step 5. Do not add fields to `/api/health`.

In `main.rs`, replace the hard-coded default:

```rust
const APP_VERSION: &str = env!("FRESHELL_SERVER_VERSION");
```

and supply `env!("FRESHELL_SERVER_SUPPORTS_CLIENT")` to `ApiState`. `FRESHELL_APP_VERSION` may continue overriding display/update-check version, but must not alter the compiled deployment declaration.

- [ ] **Step 8: Run artifact and API verification**

Run:

```bash
cargo test -p freshell-api
cargo test -p freshell-deployment
cargo test -p freshell-server --bin freshell-server
task_artifact_root="$(mktemp -d)"
FRESHELL_CLIENT_OUT_DIR="$task_artifact_root/client" npm run build:client
test -f "$task_artifact_root/client/deployment-compatibility.json"
rm -rf "$task_artifact_root"
cargo build -p freshell-server
```

Expected: PASS; the client build contains the client declaration, and the Rust build succeeds with the server declaration embedded.

- [ ] **Step 9: Refactor and commit**

Keep source-contract parsing in TypeScript and Rust intentionally small and local to their build environments; remove any duplicated API JSON construction. Rerun Step 8, then:

```bash
git add config/vite/vite.config.ts test/unit/vite-config.test.ts crates/freshell-deployment crates/freshell-server/build.rs crates/freshell-server/Cargo.toml crates/freshell-api/Cargo.toml crates/freshell-api/src/lib.rs crates/freshell-server/src/main.rs Cargo.lock
git commit -m "feat(deploy): embed compatibility in client and server artifacts"
```

### Task 3: Stage and Reject Unsafe Deployments Before Replacement

**Files:**
- Modify: `scripts/launch-rust.sh`
- Create: `test/integration/server/launch-rust-deployment.test.ts`
- Create: `test/fixtures/launch-rust/fake-npm`
- Create: `test/fixtures/launch-rust/fake-cargo`
- Create: `test/fixtures/launch-rust/fake-server.mjs`

**Interfaces:**
- Consumes client artifact: `deployment-compatibility.json`
- Consumes server endpoint: `GET /api/deployment-compatibility`
- Produces CLI mode: `scripts/launch-rust.sh --server-only [--restart]`
- Produces internal staging tree: `$FRESHELL_HOME/deploy-staging/<port>-<pid>/`
- Produces structured log: `$FRESHELL_HOME/logs/rust-deploy-<port>.jsonl`

- [ ] **Step 1: Write failing preflight integration tests**

Build a test fixture that copies the launcher/helper/config into a temporary repo, puts deterministic fake `npm` and `cargo` commands first on `PATH`, and records every build/replacement action. Add tests for:

```ts
it('client-only stages only the client and accepts different mutually supported versions')
it('server-only stages only the server and accepts different mutually supported versions')
it('combined mode stages both and validates the candidate pair')
it.each([
  'candidate client rejects running server',
  'running server rejects candidate client',
  'candidate server rejects installed client',
  'installed client rejects candidate server',
  'declaration is missing',
  'declaration is malformed',
])('rejects %s before either installed artifact changes')
it('rejects --client-only with --server-only')
it('does not replace artifacts when a running server requires --restart')
```

For every rejection, hash both installed artifacts before launch and assert the hashes are unchanged afterward. The fake server must expose real HTTP health and compatibility endpoints but never bind a host production port.

- [ ] **Step 2: Run the preflight suite in the sandbox and confirm red**

Run:

```bash
scripts/sandbox-test.sh "npm run test:vitest -- run test/integration/server/launch-rust-deployment.test.ts --config config/vitest/vitest.server.config.ts -t 'stages|rejects'"
```

Expected: FAIL because staging, `--server-only`, and compatibility checks do not exist.

- [ ] **Step 3: Add explicit modes and staged builds**

Refactor launcher argument validation to reject conflicting modes and define:

```bash
SERVER_ONLY=0
STAGING_ROOT="$FRESHELL_HOME/deploy-staging/$PORT-$$"
STAGED_CLIENT="$STAGING_ROOT/client"
STAGED_TARGET="$STAGING_ROOT/cargo-target"
STAGED_BINARY="$STAGED_TARGET/release/freshell-server"
```

Use a cleanup trap that only removes this exact staging root and only stops the exact recorded probe PID. Build commands become:

```bash
FRESHELL_CLIENT_OUT_DIR="$STAGED_CLIENT" npm run build:client
CARGO_TARGET_DIR="$STAGED_TARGET" cargo build --release -p freshell-server
```

`--client-only` runs only the first command; `--server-only` runs only the second; combined mode runs both. Never build directly over an installed artifact.

- [ ] **Step 4: Probe server declarations away from the live server**

For a running server, fetch its declaration from `http://127.0.0.1:$PORT/api/deployment-compatibility`. For a staged server, allocate an unused loopback probe port, launch the exact staged binary with:

```bash
HOME="$STAGING_ROOT/home" \
FRESHELL_HOME="$STAGING_ROOT/home/.freshell" \
AUTH_TOKEN="$AUTH_TOKEN_VALUE" \
FRESHELL_BIND_HOST="127.0.0.1" \
PORT="$probe_port" \
"$STAGED_BINARY"
```

Wait for both `/api/health` with `ready: true` and `/api/deployment-compatibility`, write the server response under the staging root, then terminate only that probe PID. A probe failure exits before replacement.

- [ ] **Step 5: Validate the candidate pairing**

Select the pair by mode:

```text
client-only: staged client + running server
server-only: installed client + staged server
combined:    staged client + staged server
skip-build restart/start: installed client + installed/running server
```

Invoke:

```bash
"$REPO_ROOT/node_modules/.bin/tsx" \
  "$REPO_ROOT/scripts/deployment-compatibility.ts" \
  check "$CLIENT_DECLARATION" "$SERVER_DECLARATION"
```

Any inability to prove both directions compatible fails closed before `mv`, `install`, `kill`, or pid-file mutation. Emit JSONL events `deployment_preflight_started`, `deployment_preflight_rejected`, and `deployment_preflight_passed`, including mode, port, component versions, and ranges but no token.

- [ ] **Step 6: Make preflight tests green**

Run:

```bash
scripts/sandbox-test.sh "npm run test:vitest -- run test/integration/server/launch-rust-deployment.test.ts --config config/vitest/vitest.server.config.ts -t 'stages|rejects'"
bash -n scripts/launch-rust.sh
```

Expected: PASS.

- [ ] **Step 7: Refactor and commit**

Extract focused shell functions for `build_client`, `build_server`, `probe_server`, `fetch_running_server_declaration`, and `validate_pair`; keep mutation out of them. Rerun Step 6, then:

```bash
git add scripts/launch-rust.sh test/integration/server/launch-rust-deployment.test.ts test/fixtures/launch-rust
git commit -m "feat(deploy): preflight staged client and server updates"
```

### Task 4: Replace Transactionally and Roll Back Failed Servers

**Files:**
- Modify: `scripts/launch-rust.sh`
- Modify: `test/integration/server/launch-rust-deployment.test.ts`
- Modify: `test/fixtures/launch-rust/fake-server.mjs`

**Interfaces:**
- Consumes: staged, mutually compatible artifacts from Task 3.
- Produces: recoverable backups beneath `$FRESHELL_HOME/deploy-backups/<port>/`
- Produces: rollback events `deployment_replacement_started`, `deployment_succeeded`, `deployment_failed`, `deployment_rollback_started`, `deployment_rollback_succeeded`, `deployment_rollback_failed`.

- [ ] **Step 1: Write failing transactional integration tests**

Add sandboxed tests that use real child processes and exact pid files:

```ts
it('a compatible client-only update swaps the client without interrupting the server')
it('a compatible server-only update probes first, replaces the binary, and starts it on the requested port')
it('a combined update replaces both artifacts after one successful preflight')
it('an incompatible candidate never stops the running server')
it('a candidate that probes successfully but fails on the requested port restores and restarts the old server')
it('a failed combined update restores both the old server and old client')
it('a failed first install with no prior server exits clearly without inventing a rollback')
it('never stops a stale-pid or foreign-port process during deployment or rollback')
```

The failure candidate must be controlled by an explicit fixture flag that permits the probe port and fails only on the requested port. Assert final health, pid ownership, installed artifact hashes, and ordered structured events.

- [ ] **Step 2: Run rollback tests in the sandbox and confirm red**

Run:

```bash
scripts/sandbox-test.sh "npm run test:vitest -- run test/integration/server/launch-rust-deployment.test.ts --config config/vitest/vitest.server.config.ts -t 'swaps|replaces|restores|never stops|first install'"
```

Expected: FAIL because replacement and rollback are not transactional.

- [ ] **Step 3: Implement recoverable replacement**

After all preflight checks pass:

1. Copy the currently installed server binary and client directory, when present, into a new exact backup directory.
2. Stop the pid-file-verified running server only when `--restart` is present.
3. Install the staged server to a sibling temporary file, preserve executable mode, then rename it over `target/release/freshell-server`.
4. Rename the installed client directory to a transaction-local old path, rename the staged client into `dist/client`, and retain the old path until success.
5. Start the replacement server with the existing pid-file verification and health loop.
6. On success, remove only transaction-local old paths and retain one bounded last-known-good backup.

Client-only mode performs only steps 3–4 applicable to the client and never calls `stop_ours`.

- [ ] **Step 4: Implement failure rollback**

If live startup exits or times out:

```text
stop only the replacement PID if it still exists
restore the prior server binary
restore the prior client directory when combined mode changed it
start the restored server on the requested port
require restored /api/health ready=true
return a non-zero deployment status even when rollback succeeds
```

If rollback itself fails, leave the prior artifacts installed, preserve the logs/backups, emit `deployment_rollback_failed`, and print exact manual recovery paths. Never escalate from SIGTERM to SIGKILL automatically.

- [ ] **Step 5: Make rollback tests green**

Run:

```bash
scripts/sandbox-test.sh "npm run test:vitest -- run test/integration/server/launch-rust-deployment.test.ts --config config/vitest/vitest.server.config.ts"
bash -n scripts/launch-rust.sh
```

Expected: PASS with no host process or port changes.

- [ ] **Step 6: Refactor and commit**

Unify normal start and rollback start under one `start_and_wait` helper, centralize cleanup traps, and make the transaction state explicit instead of inferring from filesystem leftovers. Rerun Step 5, then:

```bash
git add scripts/launch-rust.sh test/integration/server/launch-rust-deployment.test.ts test/fixtures/launch-rust
git commit -m "feat(deploy): roll back failed Rust server replacements"
```

### Task 5: Operator Contract and End-to-End Verification

**Files:**
- Modify: `AGENTS.md`
- Modify if verification exposes a gap: files already listed in Tasks 1–4 only.

**Interfaces:**
- Consumes: final launcher behavior.
- Produces: exact operator-facing commands and guarantees for future work.

- [ ] **Step 1: Update the operator instructions**

Update only the Rust launcher section of `AGENTS.md`:

```text
scripts/launch-rust.sh --client-only          # stage, compatibility-check, and replace only the client
scripts/launch-rust.sh --server-only --restart # stage, probe, compatibility-check, and replace only the server
scripts/launch-rust.sh --restart              # stage/check/replace both, with rollback on failed server start
```

State plainly that different versions are expected, both declared ranges must accept the pairing, rejection occurs before replacement, and a failed server deployment restores the last working server. Preserve the exact `APPROVED` requirement for live port 3002.

- [ ] **Step 2: Run focused verification**

Run:

```bash
npm run test:vitest -- run test/unit/server/deployment-compatibility.test.ts test/unit/vite-config.test.ts --config config/vitest/vitest.server.config.ts
cargo test -p freshell-api
cargo test -p freshell-deployment
cargo test -p freshell-server --bin freshell-server
bash -n scripts/launch-rust.sh
scripts/sandbox-test.sh "npm run test:vitest -- run test/integration/server/launch-rust-deployment.test.ts --config config/vitest/vitest.server.config.ts"
```

Expected: PASS.

- [ ] **Step 3: Run repository-wide verification**

Run:

```bash
npm run lint
FRESHELL_TEST_SUMMARY='compatibility-aware independent Rust client/server deploy final verification' npm run check
cargo test --workspace
```

Expected: PASS with only repository-documented skips. Do not run `scripts/launch-rust.sh` against port 3002.

- [ ] **Step 4: Verify scope and artifacts**

Run:

```bash
git diff --check origin/main...
git status --short
git diff --stat origin/main...
rg -n 'same version|same commit' \
  config/deployment-compatibility.json scripts/deployment-compatibility.ts \
  scripts/launch-rust.sh test/integration/server/launch-rust-deployment.test.ts AGENTS.md
```

Expected: no whitespace errors, no placeholders, no accidental same-version/same-commit rule, and changes limited to the files in this plan.

- [ ] **Step 5: Commit documentation or verification fixes**

```bash
git add AGENTS.md
git commit -m "docs: explain compatibility-checked Rust deploys"
```

If Step 2 or Step 3 required code changes, commit each focused fix separately before this documentation commit and rerun the affected verification.

## Plan Self-Review

- **Spec coverage:** Task 1 permits independent versions and enforces reciprocal declarations. Task 2 places those declarations in the actual artifacts. Task 3 rejects every unprovable or incompatible pairing before mutation. Task 4 probes candidates before interruption and restores the working pair after failure. Task 5 documents the resulting operator experience.
- **Production outcomes, not test seams:** The fixture commands in Tasks 3–4 exercise the real launcher only inside Docker. The production Vite build emits the real client artifact; the production Rust build embeds and serves the real server artifact; the production launcher consumes both. Task 5 builds/tests those real artifacts in addition to fixture-driven failure paths.
- **No silent deferrals:** Compatible client-only, server-only, and combined updates all have production commands and integration coverage. Both incompatible directions, missing declarations, failed probes, failed live starts, rollback success, rollback failure, stale pid files, and foreign ports are specified.
- **Scope guard:** No session restoration, panes, tabs, WebSocket behavior, in-product UI, release downloader, or root-cause claim is included.
- **Type consistency:** Both artifacts use `schemaVersion`, `component`, `version`, and `supports`; client has `supports.server`, server has `supports.client`; the helper and launcher use those exact names.
- **Placeholder scan:** The plan contains no implementation placeholders; the sole comment in the sample test is explicitly required to be replaced by enumerated concrete assertions before commit.
