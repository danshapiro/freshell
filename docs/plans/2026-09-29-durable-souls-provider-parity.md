# Durable Souls Provider Parity Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement durable souls for Claude CLI, Codex CLI, Amplifier, and fresh Claude, OpenCode, and Codex. Managed sessions must be featurewise equivalent to non-managed sessions. Remove any documentation that invents a security boundary restricting managed agents from MCP access, opencode.json/opencode.jsonc, or ordinary provider functionality. Managed agents should use OneCLI when they need secret access.

### Explicit constraints
- Use the-usual with a dedicated worktree, tests, and independent review.
- Compare managed and non-managed behavior directly for every named provider/mode.
- Do not add artificial restrictions to make managed sessions safer; preserve ordinary provider capabilities and configuration access.
- Remove security-rationale documentation that supports restrictions not present for non-managed sessions.
- Use the existing OneCLI path for secret access; do not invent a separate secret store or put secrets in durable soul state.
- Keep unrelated behavior unchanged.

### Accepted tradeoffs and residuals
- External provider credentials and live provider contracts may remain deferred where the repository already treats them as environment-dependent, but code and local contract coverage must be complete.
- The known origin/main OpenCode readiness baseline failure is outside this parity change.

**Goal:** A managed soul exposes the same provider-visible launch inputs, MCP/config/plugin behavior, create fields, and supported operations as the corresponding ordinary session for Claude CLI, Codex CLI, Amplifier, fresh Claude, fresh Codex, and fresh OpenCode. The only managed-specific behavior is durable lifecycle ownership, private state placement, resource accounting, and child-only OneCLI secret resolution.

**Architecture:** Carry a typed, non-secret provider preparation context through the runtime protocol and registry. It stores provider-specific preparation inputs and ownership metadata, never arbitrary host paths or resolved credentials. The session host recreates MCP/config/plugin state inside the soul; an image-packaged MCP runtime uses a per-incarnation capability file to reach the same Freshell tools as an ordinary child, while OneCLI remains the only provider-secret path. A shared parity fixture captures provider-visible behavior from direct and managed routes, while live qualification remains an explicit gate for credentials that are not available in the local test environment.

**Tech Stack:** Rust workspace crates (`freshell-runtime-protocol`, `freshell-supervisor`, `freshell-session-host`, `freshell-platform`, `freshell-ws`, `freshell-freshagent`, provider adapters), TypeScript/Vitest/Playwright runtime gates, Docker-backed session hosts, JSONL structured logs, and the existing OneCLI typed secret-reference flow.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/durable-souls-provider-parity` on branch `the-usual/durable-souls-provider-parity`, based on `12e5e9f55fa049fd33b81f8f7ff64f451605b907`; never edit the main checkout.
- Use pnpm `10.34.5`, `pnpm run test:vitest run ...` for focused Vitest work, and the repository coordination gate for broad tests. Do not use npm-era lockfile commands.
- Preserve the existing managed runtime ownership boundary: private per-soul provider homes and journals, exact supervisor ownership, bounded host IPC, no Docker socket, and no raw secret bytes in registry rows, Docker JSON, logs, or event journals.
- Managed MCP uses the image-packaged Freshell MCP runtime and a per-incarnation capability file created by the server controller. The durable launch record stores only the capability-file reference and endpoint metadata; the capability bytes are mounted/read only for the provider child and are recreated or revoked with the incarnation. The ordinary web `AUTH_TOKEN` never appears in durable launch JSON, logs, or event journals.
- The provider-visible behavior contract must match the ordinary path after normalizing only lifecycle-owned values: soul/provider-home paths, managed endpoint/port, terminal/session identifiers, provider store roots, and generated temporary paths.
- Approved provider-user roots are explicit and provider-specific: `~/.claude`, `~/.codex`, `~/.config/opencode`, and `~/.amplifier` (plus the workspace project roots). Their ordinary non-secret settings, plugins, skills, hooks, bundles, and user MCP executable references are copied or mounted read-only into the soul; auth files and other secret-bearing paths are excluded and supplied through OneCLI grants. The parity comparator treats the copied root as the same logical provider-user root.
- Provider-native differences remain explicit and shared by both routes: Claude/Kilroy native fork remains unsupported, OpenCode approval/question remains unsupported, and Codex redo remains unsupported unless the existing provider itself changes.
- OneCLI is the only managed secret lookup path. Extend the existing typed reference, authenticated host grant, bounded parser, and child-only environment mapping. Do not add a second secret store, persist secret bytes, forward host-local OneCLI control URLs, or place provider credentials in a durable launch context.
- Existing raw Claude/Codex/OpenCode credential-file bootstrap is removed from the named Claude, Codex, and OpenCode managed/fresh launches and recovery. Provider credentials are materialized through typed OneCLI environment profiles or provider-specific OneCLI file grants; a generic config reference cannot carry credentials. Ordinary non-secret configuration is copied into the soul from typed workspace and user-provider roots, while the existing Kilroy legacy bootstrap remains unchanged and covered by its current regression tests.
- Existing live-provider deferral is allowed only for the external credential/contract receipt. It must not disable local managed adapter code, fake-provider parity coverage, or qualification-mode routing for the six requested modes.
- Do not broaden the change to Kilroy, Gemini, Kimi, or unrelated legacy provider behavior.
- Every behavior change receives a failing behavior test first, a focused green test, an impacted-test run, a focused commit, and task-level independent review. Do not weaken or skip existing tests.
- Update `README.md` only for user-visible OneCLI setup changes. Agent-facing implementation detail belongs in the existing `docs/development` or `docs/plans` documents.

---

## Task 1: Carry a non-secret provider launch context and extend OneCLI profiles

**Files:**
- Modify: `crates/freshell-runtime-protocol/src/lib.rs`
- Modify: `crates/freshell-server/src/managed_runtime.rs`
- Modify: `crates/freshell-server/src/managed_provider_bootstrap.rs`
- Modify: `crates/freshell-session-host/src/provider_secret_resolution.rs`
- Modify: `crates/freshell-supervisor/src/backend/docker.rs`
- Modify: `crates/freshell-supervisor/src/backend.rs`
- Modify: `crates/freshell-supervisor/src/registry.rs`
- Modify: `crates/freshell-supervisor/src/recovery.rs`
- Modify: `crates/freshell-supervisor/src/resume_catalog.rs`
- Modify: `crates/freshell-runtime-protocol/src/lib.rs` protocol tests
- Test: `crates/freshell-session-host/src/provider_secret_resolution.rs` tests and `crates/freshell-runtime-protocol/src/lib.rs` tests

**Interfaces:**
- Add a serializable `ProviderLaunchContext` owned by `freshell-runtime-protocol` and optional `provider_launch_context` fields on `TerminalLaunchSpec` and `FreshAgentLaunchSpec`. It contains typed provider preparation data, typed configuration roots (`Workspace` or an approved provider-user root plus a relative path), plugin selectors, and an `McpCapabilityReference` containing only an endpoint, provider-relative path, and opaque grant id. It contains no resolved token, API key, OAuth payload, arbitrary absolute config path, or opaque provider JSON.
- Add `ProviderSecretProfile` variants for the named providers' OneCLI-backed environment profiles and provider-specific file grants, and add `provider_secret_references` to `FreshAgentLaunchSpec`. Replace the restrictive Amplifier-only profile with a non-restrictive provider profile while keeping the legacy profile rejected for new launches. The existing raw credential bootstrap references are removed from the named managed/fresh launch construction and recovery; a typed OneCLI file grant or environment profile is the only provider-secret input.
- The session host resolves a `ProviderLaunchContext` into provider-native argv/env/config files at spawn time. Generated MCP files are written under the soul-owned runtime directory and are recreated on replacement. Typed user-provider roots are copied read-only into the soul after secret files are removed; secret files arrive only through OneCLI grants. The active capability file is mounted only for the incarnation and is never copied into provider state; the durable record keeps only its opaque grant id, endpoint, and ordinary preparation inputs.
- Extend `resolve_child_environment` with a provider/profile dispatch table. Every profile has an explicit allowlist and validation; host-local `ONECLI_URL`/`NO_PROXY` stay excluded, and all provider API values are child-only.

- [ ] **Step 1: Write the failing behavioral tests**

Add tests that deserialize old launch records with an absent context, serialize a context without secret values, accept each named OneCLI environment profile and file grant only for its provider, reject a raw secret value in a launch context, and prove a registry/Docker JSON projection contains a typed source reference but not the contents of a fixture keys/auth file. Add a fake mounted OneCLI grant test for Claude, Codex, OpenCode, and Amplifier that returns the expected child-only provider variables or provider-relative auth file, and a user-provider-root test that copies ordinary non-secret config while rejecting credential files and unapproved roots.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-runtime-protocol && cargo test -p freshell-session-host provider_secret && cargo test -p freshell-supervisor provider_secret`

Expected: FAIL because the context types, provider-user root validation, non-Amplifier profile dispatch, and OneCLI file-grant path do not exist, and the managed launch still drops the ordinary provider context.

- [ ] **Step 3: Add the minimal protocol and secret implementation**

Implement the following shape in `freshell-runtime-protocol` (field names may gain serde defaults for backward compatibility, but the non-secret rule is fixed):

```rust
pub struct ProviderLaunchContext {
    pub preparation: ProviderPreparation,
    pub mcp_capability: Option<McpCapabilityReference>,
    pub config: Vec<ProviderConfigReference>,
    pub plugins: Vec<String>,
}

pub enum ProviderPreparation {
    Claude { mcp_args: Vec<String> },
    Codex { tui_args: Vec<String>, sidecar_args: Vec<String> },
    Opencode { project_config: Vec<ProviderConfigReference>, tui_config: Option<ProviderConfigReference> },
    Amplifier { bundle: String, resume_args: Vec<String> },
}

pub struct McpCapabilityReference {
    pub grant_id: String,
    pub endpoint: String,
    pub provider_relative_path: String,
}

pub enum ProviderConfigRoot {
    Workspace,
    UserProvider,
}

pub struct ProviderConfigReference {
    pub root: ProviderConfigRoot,
    pub relative_path: String,
    pub provider_relative_path: String,
    pub format: String,
}
```

Validate bounded lengths, safe relative paths, an allowlisted provider-user root per provider, opaque grant ids, known formats, and provider-specific preparation variants. Extend Docker mount calculation, registry/recovery round trips, and immutable expected-config digests to carry these references. Have `managed_runtime` construct the context from provider-specific preparation results returned by the same platform launch helpers used by the ordinary path. Extend the existing OneCLI parser with typed profiles for Claude, Codex, OpenCode, and Amplifier plus typed file grants, preserving its child-only output contract. The profile table is explicit: Claude permits its API/OAuth env names and `.claude` auth-file grant; Codex permits its OpenAI env names and `.codex/auth.json` grant; OpenCode permits its provider env names and the approved OpenCode auth-file grant; Amplifier permits its bundle/provider env names and keys-file grant. Reject the old raw credential bootstrap path for the named Claude, Codex, and OpenCode modes, migrate existing mounted copies out of soul homes during recovery, and add equivalent typed secret references to fresh-agent mounts; leave Kilroy's legacy path unchanged.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-runtime-protocol && cargo test -p freshell-session-host provider_secret && cargo test -p freshell-supervisor provider_secret`

Expected: PASS, including assertions that the test secret string is absent from serialized launch state, supervisor request JSON, and structured error output.

- [ ] **Step 5: Refactor while green**

Keep validation in the protocol crate, mount canonicalization in supervisor Docker code, and provider-specific secret mapping in the session host. Remove duplicated per-provider allowlist checks and use one table-driven profile resolver.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-runtime-protocol && cargo test -p freshell-session-host && cargo test -p freshell-supervisor` and `pnpm run test:vitest run test/unit/tooling/testing/provider-certification.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS, with all existing backward-compatibility and ownership tests green.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-runtime-protocol/src/lib.rs crates/freshell-server/src/managed_runtime.rs crates/freshell-server/src/managed_provider_bootstrap.rs crates/freshell-session-host/src/provider_secret_resolution.rs crates/freshell-supervisor/src/backend/docker.rs crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/resume_catalog.rs
git commit -m "feat(runtime): carry provider parity context and onecli profiles"
```

## Task 2: Make managed terminal launches provider-equivalent

**Files:**
- Modify: `crates/freshell-server/src/managed_runtime.rs`
- Modify: `crates/freshell-ws/src/terminal.rs`
- Modify: `crates/freshell-platform/src/cli_launch.rs`
- Modify: `crates/freshell-platform/src/mcp_inject.rs`
- Modify: `crates/freshell-session-host/src/pty.rs`
- Modify: `crates/freshell-session-host/src/providers/codex.rs`
- Modify: `crates/freshell-session-host/src/providers/mod.rs`
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify: `tools/freshell-mcp/http-client.ts`
- Modify: `tools/freshell-mcp/server.ts`
- Modify: `docker/runtime/Dockerfile`
- Modify: `docker/runtime/README.md`
- Modify: `packages/freshell-mcp-runtime/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `crates/freshell-server/src/boot.rs`, `crates/freshell-server/src/managed_runtime_api.rs`, and `crates/freshell-api/src/lib.rs` for scoped capability validation
- Modify: `crates/freshell-supervisor/src/backend.rs` and `crates/freshell-supervisor/src/recovery.rs` for capability reissue before host replacement
- Create: `scripts/testing/probe-managed-mcp-image.ts`
- Test: `crates/freshell-server/src/managed_runtime.rs`, `crates/freshell-ws/src/terminal.rs`, `crates/freshell-platform/src/cli_launch_goldens.rs`, `docker/runtime` image probe, and new `test/integration/server/managed-provider-parity.test.ts`

**Interfaces:**
- The managed terminal route consumes `ProviderLaunchContext` from Task 1 and uses provider-specific preparation adapters built from the same `resolve_cli_launch`, `generate_mcp_injection`, and Codex managed rendering helpers as the ordinary route. It must retain ordinary Claude `--mcp-config`, Codex TUI/app-server MCP recipes, OpenCode config/TUI environment, provider args, and plugin selectors.
- Package `tools/freshell-mcp/server.ts` and its runtime dependencies into the pinned managed image at a stable path. The server controller issues an in-memory per-incarnation capability through the existing managed-runtime control channel; the server auth layer validates the opaque scope, soul id, incarnation, and expiry without persisting the web `AUTH_TOKEN`. The controller writes a mode-0600 capability file containing the reachable host-gateway endpoint and opaque scope, and supervisor mounts it at the provider path. The session host reads the grant at spawn and sets the same `FRESHELL=1`, `FRESHELL_URL`, `FRESHELL_TOKEN`, and pane/tab variables on the provider process that an ordinary terminal receives, so provider-owned MCP children inherit them. The web `AUTH_TOKEN` and scope value never enter durable launch JSON, logs, or event journals.
- The endpoint is a controller-derived host-gateway address and port that the managed bridge can reach; startup fails closed if the server cannot bind an address reachable from the soul. `session-host` materializes provider config and the packaged MCP command inside the soul. On a host replacement, the supervisor asks the live server controller for a fresh scoped grant before mounting the new incarnation; if the controller is unavailable, recovery waits in a typed `capability_pending` state rather than resuming without ordinary MCP. Stop revokes the scope and removes the ephemeral file. The provider-visible MCP server behavior and tool results must be identical.
- Managed terminal provider selection becomes qualification-capable for `claude`, `codex`, `amplifier`, and `opencode`; live release flags remain governed by the manifest in Task 6.

- [ ] **Step 1: Write the failing behavioral tests**

Create a fake provider executable that records argv, env names/values after redaction, copied user-provider config, plugin files, MCP list/call requests, and native session id. Launch each of Claude CLI, Codex CLI, OpenCode, and Amplifier once through the ordinary adapter and once through the managed terminal route with identical cwd, model, effort, permission, sandbox, workspace config, approved user-provider config, and MCP fixture. Assert normalized provider-visible records are equal and the fake MCP tool call returns the same value. Add a regression test proving managed Claude keeps `--mcp-config` rather than deleting it, managed Codex passes both TUI and sidecar recipes, managed OpenCode preserves both user config filenames plus rebind behavior, and the provider process itself retains the ordinary Freshell environment. Add an image-probe test that builds the pinned image and runs `node /opt/freshell-mcp/server.js --self-test` against a fake endpoint.
Name the source-level regressions `managed_claude_provider_context` and `managed_codex_provider_context` so the focused Cargo commands select real tests.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-server --features managed-runtime-v1 managed_claude_provider_context && cargo test -p freshell-ws --features provider-qualification managed_codex_provider_context && cargo test -p freshell-platform mcp_inject && pnpm run test:vitest run test/integration/server/managed-provider-parity.test.ts --config config/vitest/vitest.config.ts` and `docker build --tag freshell-managed-runtime:provider-parity --file docker/runtime/Dockerfile . && pnpm exec tsx scripts/testing/probe-managed-mcp-image.ts --image freshell-managed-runtime:provider-parity`

Expected: FAIL because managed Claude strips MCP args, managed Codex durable launches use an empty sidecar context, OpenCode uses a minimal config and skips rebind, Amplifier is pinned to one managed profile, and the managed controller has no reachable scoped MCP grant.

- [ ] **Step 3: Add the minimal production implementation**

Remove the managed-only argument stripping and minimal OpenCode env replacement. Build the provider-specific preparation context from the same platform launch inputs as the ordinary route, carry it through `TerminalLaunchSpec`, and materialize it in the session host before `HostedPty::spawn`. Reuse `ManagedCodexMcpRenderings` for the durable Codex TUI and app-server. Add the image-packaged MCP runtime and capability-file mount, the server/API scope validator, the host-gateway endpoint, and the probe command `pnpm exec tsx scripts/testing/probe-managed-mcp-image.ts --image freshell-managed-runtime:provider-parity`, which runs `tools/list`/`tools/call` against a fake endpoint plus a live controller-to-soul grant test. Set the ordinary Freshell variables on the provider process, not just a nested MCP child. Move OpenCode rebind/config merge into the soul-owned preparation path and preserve both `.opencode/opencode.json` and `.opencode/opencode.jsonc` entries plus approved global config. Make Amplifier launch the configured ordinary bundle, provider, model, effort, plugin, and resume arguments with a typed OneCLI child environment rather than a hard-coded model wrapper; remove the image's single-vLLM/provider-default assumption, package the generic Amplifier runtime and the provider modules selected by the ordinary bundle, and replace the old GLM-only validation with provider-specific secret-shape validation. If an ordinary bundle/provider is unavailable in the image, report the same typed provider-unavailable result as the ordinary route rather than silently switching providers. Remove named Claude/Codex/OpenCode raw credential-file bootstrap and use the Task 1 OneCLI grant; preserve Kilroy's legacy bootstrap path.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-server --features managed-runtime-v1 managed_claude_provider_context && cargo test -p freshell-ws --features provider-qualification managed_codex_provider_context && cargo test -p freshell-platform mcp_inject && pnpm run test:vitest run test/integration/server/managed-provider-parity.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS, including fake list/call MCP behavior, reachable scoped auth, ordinary provider environment inheritance, and normalized argv/env/config/plugin equality for all four terminal providers.

- [ ] **Step 5: Refactor while green**

Make provider-specific preparation adapters the only place that choose each provider's target, MCP recipe, and ordinary config selectors, behind one shared lifecycle context. Keep lifecycle-owned paths, ids, host-gateway endpoints, and the managed image MCP command normalized as named lifecycle-owned values in the test comparator; never normalize away provider features or the provider process's ordinary Freshell environment.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-server --features managed-runtime-v1 && cargo test -p freshell-ws --features provider-qualification && cargo test -p freshell-platform && cargo test -p freshell-freshagent --features provider-qualification && pnpm run test:vitest run test/integration/server/managed-provider-parity.test.ts test/unit/tooling/runtime-manager-launch.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS, including all existing non-managed CLI launch goldens, Codex sidecar tests, and the managed feature-gated modules.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/managed_runtime.rs crates/freshell-server/src/managed_runtime_api.rs crates/freshell-server/src/boot.rs crates/freshell-api/src/lib.rs crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-ws/src/terminal.rs crates/freshell-platform/src/cli_launch.rs crates/freshell-platform/src/cli_launch_goldens.rs crates/freshell-platform/src/mcp_inject.rs crates/freshell-platform/src/mcp_inject_tests.rs crates/freshell-session-host/src/pty.rs crates/freshell-session-host/src/providers/codex.rs crates/freshell-session-host/src/providers/mod.rs crates/freshell-freshagent/src/terminal_tabs.rs tools/freshell-mcp/http-client.ts tools/freshell-mcp/server.ts docker/runtime/Dockerfile docker/runtime/README.md packages/freshell-mcp-runtime/package.json pnpm-lock.yaml scripts/testing/probe-managed-mcp-image.ts test/integration/server/managed-provider-parity.test.ts
git commit -m "feat(runtime): preserve managed terminal provider capabilities"
```

## Task 3: Carry every fresh-agent create input through hosted souls

**Files:**
- Modify: `crates/freshell-server/src/fresh_agent_proxy.rs`
- Modify: `crates/freshell-session-host/src/providers/fresh_agent.rs`
- Modify: `crates/freshell-agent-runtime/src/host_actor.rs`
- Modify: `crates/freshell-freshagent/src/claude.rs`
- Modify: `crates/freshell-freshagent/src/codex.rs`
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs`
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify: `crates/freshell-runtime-protocol/src/lib.rs`
- Modify: `crates/freshell-claude-sidecar/index.mjs`
- Modify: `crates/freshell-supervisor/src/backend/docker.rs`
- Modify: `crates/freshell-supervisor/src/recovery.rs`
- Modify: `crates/freshell-supervisor/src/resume_catalog.rs`
- Test: `crates/freshell-session-host/src/providers/fresh_agent.rs`, `crates/freshell-agent-runtime/src/host_actor_tests.rs`, and new `test/integration/server/fresh-agent-parity.test.ts`

**Interfaces:**
- Extend `FreshAgentLaunchSpec` and `FreshAgentProfile` with the provider-affecting create inputs: `plugins`, `model_selection`, exact `session_ref`/native resume identity, provider config references, OneCLI secret references, and the Task 1 launch context. Carry `naming_handle` through the existing session-display/control-plane record so direct and hosted panes expose the same name, but do not present it as provider input. Keep transient control-plane fields (`request_id`, observed epoch/generation, tab id, and the deliberately rejected legacy resume shortcut) out of the provider profile. Add serde defaults so old registry rows still recover.
- `HostedTransport::start` must construct a `FreshAgentCreate` containing the persisted values rather than hard-coded `None`. The direct REST/MCP path and hosted path use the same provider transport builders for Claude, Codex, and OpenCode. The exact provider-specific resume rule remains in each adapter; do not apply a universal rejection to `session_ref`.
- Keep provider-native operation support identical between direct and hosted routes. The host must report the existing unsupported results rather than silently dropping a request.

- [ ] **Step 1: Write the failing behavioral tests**

Build a deterministic provider transport that records the full create request and operation calls. Create direct and hosted sessions for `freshclaude`, `freshcodex`, and `freshopencode` with every provider-affecting public create field populated, including plugins, model selection, provider config, the exact session reference, and all settings; also populate `naming_handle` and control-plane fields and assert their display/event behavior separately. Record the ordinary direct route's actual MCP capability for each provider and require the hosted route to match it, including the current absence of Freshell MCP in direct fresh Claude/Codex/OpenCode. Assert the recorded create requests match after lifecycle id normalization. Exercise send, interrupt, approval, question, compact, rollback, capture, fork, and restart/resume; assert the same success or typed unsupported result for both routes.
Name the source-level regressions `fresh_agent_provider_context_round_trip` and `fresh_agent_operation_matrix_parity` so the focused Cargo commands select real tests.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-session-host --features fresh-agent-fixtures fresh_agent_provider_context_round_trip && cargo test -p freshell-agent-runtime operation_support && cargo test -p freshell-freshagent --features provider-qualification fresh_agent_operation_matrix_parity && pnpm run test:vitest run test/integration/server/fresh-agent-parity.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because hosted create currently drops plugins, model selection, provider config, and resume context, while the sidecars discard the ordinary provider preparation context.

- [ ] **Step 3: Add the minimal production implementation**

Thread the provider-affecting fields from `FreshAgentCreate` through `fresh_agent_proxy` into `FreshAgentLaunchSpec`, through `HostedTransport::start` into the provider create request, and into each provider transport. Persist only typed non-secret config references and provider-specific OneCLI references; add fresh-agent secret mounts through the same typed OneCLI mechanism as terminal launches. Update `crates/freshell-claude-sidecar/index.mjs` and the Codex sidecar launch context construction to accept exactly the ordinary direct preparation context instead of dropping it or using `default()`. Preserve each direct fresh route's actual MCP behavior rather than adding a managed-only MCP feature: if direct fresh Claude/Codex/OpenCode has no Freshell MCP today, both routes have none; if a provider's ordinary direct route has MCP/config/plugin state, materialize the same state in the soul. Fresh OpenCode uses `opencode_ws.rs` plus the same project/global config merge and TUI rebind preparation. Add a Kilroy regression covering the shared Claude sidecar and leave its legacy fields/bootstrap unchanged. Keep the existing Claude fork, OpenCode approval/question, and Codex redo capability decisions explicit and shared.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-session-host --features fresh-agent-fixtures fresh_agent_provider_context_round_trip && cargo test -p freshell-agent-runtime operation_support && cargo test -p freshell-freshagent --features provider-qualification fresh_agent_operation_matrix_parity && pnpm run test:vitest run test/integration/server/fresh-agent-parity.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS, with every create field observed by the fake provider and the operation matrix matching between direct and hosted routes.

- [ ] **Step 5: Refactor while green**

Use one `FreshAgentCreate` conversion helper for the web and hosted paths. Keep `FreshAgentProfile` as the recovery source of truth and derive transient request ids, lifecycle epochs, and event routing at the boundary rather than persisting duplicate state.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-server --features managed-runtime-v1 && cargo test -p freshell-session-host --features fresh-agent-fixtures && cargo test -p freshell-agent-runtime && cargo test -p freshell-freshagent --features provider-qualification && cargo test -p freshell-supervisor && pnpm run test:vitest run test/unit/tooling/testing/fresh-agent-qualification.test.ts test/unit/tooling/testing/fresh-agent-ingress-inventory.test.ts test/integration/server/fresh-agent-parity.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS, including existing direct fresh-agent control, resume, rollback, and supervisor recovery tests.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-agent-runtime/src/host_actor_tests.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-claude-sidecar/index.mjs crates/freshell-supervisor/src/backend/docker.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/resume_catalog.rs test/integration/server/fresh-agent-parity.test.ts
git commit -m "feat(fresh-agent): preserve hosted provider inputs"
```

## Task 4: Complete OpenCode file, plugin, and MCP parity for terminal and fresh modes

**Files:**
- Modify: `crates/freshell-opencode/src/serve.rs`
- Modify: `crates/freshell-platform/src/mcp_inject.rs`
- Modify: `crates/freshell-ws/src/terminal.rs`
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify: `crates/freshell-session-host/src/providers/fresh_agent.rs`
- Modify: `crates/freshell-session-host/src/providers/opencode.rs`
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs`
- Modify: `crates/freshell-session-host/src/pty.rs` for the OpenCode identity relay
- Test: `crates/freshell-opencode/src/serve.rs` tests, `crates/freshell-platform/src/mcp_inject_tests.rs`, an offline pinned-image `opencode debug config` probe with its exact command recorded in the test, and `test/e2e-browser/specs/fresh-agent-rest-resume-rust.spec.ts`

**Interfaces:**
- The OpenCode preparation helper accepts an existing project directory plus the approved user-provider root and returns a typed provider-visible config plan that preserves user entries from both `.opencode/opencode.json` and `.opencode/opencode.jsonc`, global user MCP servers, `OPENCODE_TUI_CONFIG`, provider settings, and plugins. Freshell-owned entries are tagged and cleaned up by reference counting without deleting user entries; the plan carries file references and merge operations, never opaque provider JSON.
- Managed terminal and fresh OpenCode use that helper inside the soul-owned provider home/project mount. The provider's private loopback runtime and exact native session identity remain lifecycle-owned values and are excluded from parity comparison.

- [ ] **Step 1: Write the failing behavioral tests**

Seed a temporary project and approved user-provider root with both OpenCode config filenames, user MCP entries, user TUI config, provider settings, and a plugin. Run direct and managed terminal sessions plus direct and hosted `freshopencode` sessions. Capture the effective provider config, MCP list/call result where the direct route supports it, plugin execution, native session-switch relay, event history, and cleanup result. Assert user files and entries survive restart and Freshell-owned entries are removed only after the final reference is released.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-opencode && cargo test -p freshell-platform opencode && pnpm run test:vitest run test/integration/server/fresh-agent-parity.test.ts --config config/vitest/vitest.config.ts` and `docker run --rm --entrypoint sh freshell-managed-runtime:provider-parity -lc 'mkdir -p /workspace/fixture && opencode debug config --cwd /workspace/fixture'`

Expected: FAIL because managed OpenCode replaces inline config, drops the user-provider root, skips TUI/session identity relay, and hosted fresh OpenCode does not preserve the direct route's config/plugin behavior.

- [ ] **Step 3: Add the minimal production implementation**

Replace the managed minimal config with the shared typed merge/cleanup helper. Treat `.jsonc` as a preserved user source, follow the pinned OpenCode 1.18.21 effective precedence observed by the offline probe, and write only the Freshell-owned generated representation needed by the provider. Install/use the same rebind plugin for managed and direct routes, carry user `OPENCODE_TUI_CONFIG` forward through an approved relative reference, and relay its signal directory from the soul to the host identity watcher so native session switches survive restart. Expose the same MCP command recipe only when the direct route supports it, using the Task 2 provider environment and image runtime. The fixture must cover two souls, restart/re-materialization, malformed JSONC, user-global config, session switching, and final cleanup without deleting user entries.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-opencode && cargo test -p freshell-platform opencode && pnpm run test:vitest run test/integration/server/fresh-agent-parity.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS, including malformed-config refusal, user-global and project-entry preservation, reference-counted cleanup, plugin execution, session identity relay, and direct-versus-managed MCP parity where applicable.

- [ ] **Step 5: Refactor while green**

Keep parsing/merge/cleanup pure and filesystem effects behind the existing runtime seams. Use one cleanup sidecar schema for direct and managed paths and preserve existing lock/refcount semantics.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-opencode && cargo test -p freshell-platform && cargo test -p freshell-ws && cargo test -p freshell-freshagent && cargo test -p freshell-session-host && pnpm run test:vitest run test/integration/server/fresh-agent-parity.test.ts test/unit/tooling/runtime-manager-launch.test.ts --config config/vitest/vitest.config.ts` and `pnpm run test:e2e:local test/e2e-browser/specs/fresh-agent-rest-resume-rust.spec.ts --grep 'opencode|managed'`

Expected: PASS for the affected OpenCode and fresh-agent flows; the known baseline OpenCode readiness unit failure remains separately ledgered.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-opencode/src/serve.rs crates/freshell-platform/src/mcp_inject.rs crates/freshell-platform/src/mcp_inject_tests.rs crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-session-host/src/providers/opencode.rs crates/freshell-session-host/src/pty.rs test/e2e-browser/specs/fresh-agent-rest-resume-rust.spec.ts
git commit -m "fix(opencode): preserve managed config and mcp parity"
```

## Task 5: Prove the six-provider parity contract and secret hygiene end to end

**Files:**
- Create: `test/integration/server/provider-parity-fixture.ts`
- Create: `test/integration/server/provider-parity-contract.test.ts`
- Create: `scripts/testing/provider-parity-receipt.ts`
- Create: `test/unit/tooling/testing/provider-parity-receipt.test.ts`
- Modify: `test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts`
- Modify: `test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts`
- Modify: `test/e2e-browser/specs/mcp-bridge-rust.spec.ts`
- Modify: `test/e2e-browser/specs/restore-matrix.spec.ts`
- Modify: `test/e2e-browser/specs/agent-continuity-matrix.spec.ts`
- Modify: `test/runtime/gate-manifest.json`
- Modify: `test/runtime/gates/provider-certification.test.ts`
- Modify: `test/runtime/gates/phase-5.test.ts`
- Modify: `scripts/testing/provider-certification.ts`
- Modify: `scripts/testing/runtime-landing-campaign.ts`
- Modify: `scripts/testing/runtime-receipts.ts`
- Test: the new integration contract and affected runtime gate tests

**Interfaces:**
- The parity fixture exposes a deterministic provider executable/sidecar for Claude CLI, Codex CLI, Amplifier, fresh Claude, fresh Codex, and fresh OpenCode. It records provider-visible argv/env/config/plugin/MCP operations and emits structured JSONL events without including secret bytes. The fresh-agent rows assert the direct route's actual MCP support rather than manufacturing MCP for a provider that does not expose it.
- A normalized comparison removes only the lifecycle-owned values listed in Global Constraints. Any missing provider feature, changed ordinary config, missing MCP tool, dropped plugin, or changed supported operation fails the contract.
- Gate cases are named `PC-PARITY-CLAUDE`, `PC-PARITY-CODEX`, `PC-PARITY-OPENCODE`, `PC-PARITY-AMPLIFIER`, `FA-PARITY-FRESHCLAUDE`, `FA-PARITY-FRESHCODEX`, and `FA-PARITY-FRESHOPENCODE`. They use a distinct `provider-parity-local` receipt kind validated by `scripts/testing/provider-parity-receipt.ts`; the existing live receipt validators continue to reject deterministic/fixture rows. Live provider credential cases remain deferrable only through the existing typed certification mechanism.

- [ ] **Step 1: Write the failing behavioral tests**

Add one direct-versus-managed scenario per named mode. Each scenario creates a session, calls an MCP tool when the direct route exposes one, sends one provider turn, exercises every provider-supported operation, captures the exact native identity, restarts/replaces the host, resumes the same identity, and inspects registry/supervisor/event-journal material for the fixture secret. Add assertions that an unapproved OneCLI reference fails closed without changing the ordinary provider feature set, and that a missing live credential produces a named deferred result rather than a skipped local parity row.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `pnpm run test:vitest run test/integration/server/provider-parity-contract.test.ts test/unit/tooling/testing/provider-certification.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because the managed paths currently omit at least one provider-visible config/plugin input and the gate manifest/gate implementation has no local parity cases.

- [ ] **Step 3: Add the minimal production and gate coverage**

Wire the fixture through the existing qualification feature, add the seven gate cases to both the manifest and the gate case-id/certification implementation, and make the local parity receipt include provider-visible parity, the direct-route MCP result or explicit direct absence, normalized operation matrix, exact resume identity, and secret-hygiene evidence. Keep live provider receipts under the existing `PENDING_LIVE_PROVIDER_CERTIFICATION` deferral; a deferred live case never makes a local parity case pass by omission. Add a validator test proving a local receipt cannot satisfy the live receipt validator and a missing provider row fails the local parity validator. Run the deterministic fixture through the gate directly so the existing live qualification specs are not counted as local parity coverage or silently skipped.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/integration/server/provider-parity-contract.test.ts test/unit/tooling/testing/provider-parity-receipt.test.ts test/unit/tooling/testing/provider-certification.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS for every deterministic parity case and for manifest validation, with deferred live cases reported explicitly.

- [ ] **Step 5: Refactor while green**

Keep the comparator provider-neutral and put provider-specific expectations in a small table containing only the known operation differences. Reuse shared receipt parsing and validation helpers, while keeping the `provider-parity-local` discriminated lane separate from live certification so a fixture cannot satisfy a live receipt.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/integration/server/provider-parity-contract.test.ts test/unit/tooling/testing/provider-parity-receipt.test.ts test/unit/tooling/testing/provider-certification.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts test/unit/tooling/testing/runtime-release-readiness.test.ts --config config/vitest/vitest.config.ts` and `pnpm run test:runtime:raw gate landing --require-live`

Expected: PASS for all locally runnable cases; any external credential case is present as a named deferred result, never silently skipped.

- [ ] **Step 7: Commit the task**

```bash
git add test/integration/server/provider-parity-fixture.ts test/integration/server/provider-parity-contract.test.ts scripts/testing/provider-parity-receipt.ts test/unit/tooling/testing/provider-parity-receipt.test.ts test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts test/e2e-browser/specs/restore-matrix.spec.ts test/e2e-browser/specs/agent-continuity-matrix.spec.ts test/runtime/gate-manifest.json test/runtime/gates/provider-certification.test.ts test/runtime/gates/phase-5.test.ts scripts/testing/provider-certification.ts scripts/testing/runtime-landing-campaign.ts scripts/testing/runtime-receipts.ts
git commit -m "test(runtime): certify managed provider feature parity"
```

## Task 6: Align capability policy and remove the invented security-boundary documentation

**Files:**
- Modify: `crates/freshell-agent-runtime/src/lib.rs`
- Modify: `crates/freshell-agent-runtime/src/qualification_policy.rs`
- Modify: `crates/freshell-server/src/fresh_agent_proxy.rs`
- Modify: `docs/development/runtime-provider-capabilities.json`
- Modify: `docs/development/managed-runtime.md`
- Modify: `docs/development/managed-runtime-rollout.md`
- Modify: `docs/plans/freshell-durable-souls-five-phase-execution-plan.md`
- Modify: `docs/plans/2026-07-08-amplifier-session-durability-plan.md`
- Modify: `docs/plans/2026-09-07-codex-mcp-sidecar-config.md`
- Modify: `docs/superpowers/plans/2026-03-22-mcp-orchestration-server.md` only where its managed-session wording claims a provider restriction
- Modify: `README.md` only when OneCLI setup wording changes
- Test: `test/unit/tooling/testing/provider-certification.test.ts`, `test/unit/tooling/testing/fresh-agent-qualification.test.ts`, and `test/runtime/gates/provider-certification.test.ts` through the runtime gate, plus feature-gated `cargo test -p freshell-server --features managed-provider-qualification`

**Interfaces:**
- The compiled capability table and JSON manifest must agree that the six requested adapters are parity-complete in qualification mode. Live `managedEnabled`/`durableRecoveryEnabled` and fresh-agent release claims remain false only where the existing manifest records missing live certification; no code path may use that deferral to justify dropping MCP/config/plugin behavior.
- Documentation describes lifecycle ownership, private provider state, resource limits, and child-only OneCLI secret transport as managed-runtime responsibilities. It explicitly says provider MCP, provider config files including `opencode.json` and `opencode.jsonc`, plugins, user-provider roots, and provider-native operations retain ordinary semantics. Remove statements that call omitted MCP/rebind/config behavior a security boundary, and update the older five-phase/OpenCode and Codex/Amplifier plans so they no longer prescribe a managed-only omission.
- The Amplifier documentation distinguishes “MCP is not required for lifecycle recovery” from “managed Amplifier loses its ordinary bundle MCP,” and the Codex plan covers both web-managed and durable session-host MCP rendering.

- [ ] **Step 1: Write the failing policy tests**

Add a feature-gated policy test that qualification mode admits all six requested modes while release mode still reports only the manifest's explicit live-certification deferrals. Update the existing bounded-provider test to distinguish qualification adapter readiness from release certification instead of deleting its coverage. The documentation changes are reviewed as part of this task and are verified by the runtime behavior tests from Tasks 2–5; no test should treat prose as runtime behavior.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `pnpm run test:vitest run test/unit/tooling/testing/provider-certification.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts` and `pnpm run test:runtime:raw gate landing --require-live`

Expected: FAIL because the compiled table and manifest still gate Claude/Codex/Amplifier and every fresh mode as unavailable, and the docs still state that managed MCP/rebind/config is intentionally stripped.

- [ ] **Step 3: Add the minimal policy and documentation implementation**

Update qualification allowlists, compiled capability rows, and manifest metadata to represent adapter parity separately from live certification. Keep the release gate blocked for deferred live providers. Rewrite the affected documentation sections in plain language, delete the restriction rationale, retain legitimate isolation rules, and document the OneCLI setup/child-only resolution path. Do not add a new security claim or a provider-specific exception.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/unit/tooling/testing/provider-certification.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts` and `pnpm run test:runtime:raw gate landing --require-live`

Expected: PASS; the release readiness output names the deferred live providers, while the qualification output includes all six parity adapters.

- [ ] **Step 5: Refactor while green**

Keep one source of truth for the provider/mode list and derive disabled release rows from certification state. Remove stale duplicated comments rather than adding an exception list that can diverge.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-agent-runtime && cargo test -p freshell-server --features managed-provider-qualification` and `pnpm run test:vitest run test/unit/tooling/testing/provider-certification.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts` followed by `pnpm run test:runtime:raw gate landing --require-live`

Expected: PASS, with the known origin/main OpenCode readiness failure excluded by the baseline ledger only when the broad gate is evaluated.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-agent-runtime/src/lib.rs crates/freshell-agent-runtime/src/qualification_policy.rs crates/freshell-server/src/fresh_agent_proxy.rs docs/development/runtime-provider-capabilities.json docs/development/managed-runtime.md docs/development/managed-runtime-rollout.md docs/plans/freshell-durable-souls-five-phase-execution-plan.md docs/plans/2026-07-08-amplifier-session-durability-plan.md docs/plans/2026-09-07-codex-mcp-sidecar-config.md docs/superpowers/plans/2026-03-22-mcp-orchestration-server.md README.md test/unit/tooling/testing/provider-certification.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts test/runtime/gates/provider-certification.test.ts
git commit -m "docs(runtime): document provider parity and qualification state"
```

## Final verification and handoff

After all six tasks have committed and each task review has passed:

1. Run `git diff --check 12e5e9f55fa049fd33b81f8f7ff64f451605b907...HEAD`.
2. Run `pnpm run test` once at the final `HEAD`, retaining the base-reproduced OpenCode readiness failure as the only allowed pre-existing failure if it remains unchanged.
3. Run `pnpm run build` and the affected runtime qualification tests required by the gate manifest. Do not claim live provider certification when the credential receipt is deferred.
4. Inspect the final registry/Docker/event-journal fixtures for secret bytes and verify OneCLI transport rules remain intact.
5. Record the final gate receipt, task count, deferred live-provider cases, and any residual baseline failure in the-usual run ledger. Leave the worktree clean and do not merge, push, create a PR, or restart the live server in this run.

**Self-review:** The plan covers all six named provider/mode families, direct-versus-managed comparisons, ordinary MCP/config/plugin behavior, approved user-provider roots, provider-process Freshell environment, scoped controller-to-soul MCP grants, typed OneCLI secret access, raw-bootstrap migration, live deferral semantics, release metadata, security-boundary documentation removal, restart/resume identity, and e2e/runtime gate evidence. Managed code tests name the feature flags that compile the edited modules; cross-route parity tests are runnable Vitest integrations, and deterministic fresh-agent cases compare each direct route's actual MCP support rather than inventing a capability. No required behavior is represented only by a fake; the deterministic fixture is paired with production launch-context wiring and the existing live qualification path. The known origin/main OpenCode readiness failure is explicitly carried from the baseline ledger and is not attributed to this change.
