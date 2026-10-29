# First-class Google coding CLI support in Freshell

Date: 2026-10-29. Status: proposed implementation plan; no product code changed.
Repository inspected: `origin/main` at `31cb9ad69f5b` (refresh the base before implementation).

## 1. Product decision and scope

Google's current consumer successor to **Gemini CLI** is **Antigravity CLI**, invoked as `agy`. Google announced the transition on May 19, 2026, with consumer Gemini CLI access ending June 18; it continues to support Gemini CLI for Standard/Enterprise customers and paid API-key usage. These are distinct products with different launch, authentication, configuration, and conversation contracts. [Google's transition announcement](https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)

Recommended interpretation of this request: make **Antigravity CLI** a first-class terminal agent, while preserving Freshell's existing **Gemini CLI** entry. Use provider ID `antigravity`, label `Antigravity CLI`, command `agy`, and override `ANTIGRAVITY_CMD`. Keep `gemini` and `GEMINI_CMD` intact. Never silently send a saved Gemini session to `agy`, alias their IDs, or run Google's configuration migration on the user's behalf.

If the product requirement specifically means the maintained `gemini` executable, use the same Freshell integration stages below with its separate contract described in section 4. Do not build two full provider integrations as an implicit expansion of this request.

“First class” means the following observable behavior:

1. The installed CLI appears in the pane picker and settings, launches in the selected directory, accepts the supported model and permission controls, and can be launched through Freshell's CLI and MCP client.
2. Each pane has an exact provider conversation identity. Concurrent panes in the same directory stay separate, and in-CLI conversation switches update that identity.
3. Sidebar/history/search show native conversations with the correct directory, title, timestamps, messages, and available usage information. Clicking an entry focuses its live pane or resumes that exact conversation.
4. Pane, tab, sidebar, and history names agree; manual names retain precedence. Working, waiting, completed, interrupted, and failed states reflect provider evidence.
5. Browser refresh and transport reconnect retain the same terminal. Managed execution and recovery become available only after their existing qualification requirements pass.
6. Missing executables, expired authentication, unavailable history, and unsupported versions produce useful errors without quietly creating a replacement conversation.

This plan covers the terminal CLI experience. A new FreshAgent chat interface, Google IDE/app integration, provider configuration migration, and changes to Freshell's Gemini-powered title/summary service are outside this implementation. Existing checkpoint and provider-environment mechanisms should be extended where necessary; no new general provider framework is proposed.

## 2. Current Freshell support and concrete gaps

| Area | Existing behavior | Required work |
| --- | --- | --- |
| Provider registration | `extensions/gemini/freshell.json` launches `gemini`, honors `GEMINI_CMD`, and puts it in the agents group. | Add a distinct Antigravity extension. Leave existing Gemini settings and saved panes valid. |
| Picker and appearance | CLI choices derive from the extension registry; Gemini already has an icon and settings entry. | Register Antigravity's label/icon and availability through the same paths; preserve user enable/disable choices. |
| Launch | `crates/freshell-platform/src/cli_launch.rs` already builds argv from manifest templates. | Express model, exact resume, and other proven options as templates; add special code only for behavior the schema cannot express. |
| History | `freshell-sessions` has Claude, Codex, OpenCode, and Amplifier sources/layouts; no Google CLI source. | Add a provider-specific reader, discovery/watch layout, metadata, history, and search. |
| Identity | Generic `SessionRef` and identity registry accept arbitrary provider strings. Gemini is excluded from live identity marker resolution. | Capture exact native identity and verify store evidence before advertising resume. |
| Naming | Unified naming still has explicit provider lists in TypeScript and Rust. | Add the new provider through those lists and name consumers after identity exists. |
| Activity | No Gemini activity adapter; completion handling treats it as shell. | Add native lifecycle tracking and turn completion, including client attention handling. |
| Managed runtime | Gemini is explicitly `legacy-extension`, with identity/state unimplemented and managed/durable recovery disabled. Antigravity has no capability row or image install. | Add typed preparation, version inventory, probes, and qualification before enabling managed promises. |
| Automation/tests | CLI/MCP mode and session-reference flows are mostly generic. `fake-gemini.mjs` is only a generic terminal fixture. | Exercise real server behavior and introduce fixtures that model the selected CLI's actual contracts. |

Important implementation seams:

1. Registration/UI: `extensions/`, `shared/extension-types.ts`, `src/lib/coding-cli-utils.ts`, `src/components/panes/PanePicker.tsx`, `src/components/settings/CodingAgentsSettings.tsx`, `src/components/icons/provider-icons.tsx`, and `src/deck/provider-icon-svg.ts`.
2. Native sessions: `crates/freshell-sessions/src/{provider_layout,directory_index,meta,search,resume_input,resume_resolve}.rs`, `src/parse/`, and server `main.rs`, `session_directory.rs`, `resolve.rs`, and `existence.rs`.
3. Terminal identity/activity: `crates/freshell-ws/src/{terminal,identity,resume_validation,activity}.rs`, existing `claude_signal.rs` and OpenCode association/signal patterns, and `crates/freshell-activity/src/`.
4. Names and notifications: `shared/session-names.ts`, `shared/resume-input-parser.ts`, `shared/turn-complete-signal.ts`, `crates/freshell-protocol/src/session_names.rs`, `crates/freshell-freshagent/src/naming.rs`, `src/lib/session-names.ts`, and `src/lib/turn-complete-signal.ts`. The FreshAgent naming file is shared infrastructure; changing its terminal provider mapping does not add a FreshAgent UI.
5. Managed execution: `crates/freshell-agent-runtime/src/{lib,provider_inventory}.rs`, server `managed_provider_bootstrap.rs` and `managed_provider_references.rs`, `crates/freshell-session-host/src/providers/`, `crates/freshell-platform/src/provider_environment_grants.rs`, `crates/freshell-runtime-protocol/src/`, and `docker/runtime/{provider-versions.json,Dockerfile}`.

## 3. Antigravity contracts: established facts and proof still needed

The current CLI reference documents `--model`, `--effort`, `--mode`, `-i`/`--prompt-interactive`, and exact resume with `--conversation <id>`. Use the interactive prompt option for a seeded terminal pane; `-p` selects headless operation. Offer only controls supported by the tested release and account. [CLI reference](https://antigravity.google/docs/cli/reference/), [headless interface](https://antigravity.google/docs/cli/headless/)

The last-conversation cache is `~/.gemini/antigravity-cli/cache/last_conversations.json`. It maps workspaces to their latest IDs; `--continue` can start fresh if its target is missing. Consequently, this cache is neither a complete history index nor sufficient identity evidence, and Freshell must never use `--continue` for an exact-session resume. [Resume documentation](https://www.antigravity.google/docs/cli/commands/resume/)

The documented hook inputs include `conversationId`, `workspacePaths`, and `transcriptPath`. For CLI sessions, transcript storage is described as `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`. Hooks load from `.agents/hooks.json`, `~/.gemini/config/hooks.json`, or plugins, rather than CLI `settings.json`. Relevant events include `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop`; `Stop` includes `fullyIdle`, an error, and a termination reason. These provide candidate integration surfaces, subject to the release probe below. [Hook contracts](https://antigravity.google/docs/hooks/)

Migration changes MCP configuration and skills paths, and first launch can offer to import old assets. Treat onboarding as provider-owned interaction, not a background Freshell operation. [Migration documentation](https://antigravity.google/docs/cli/gcli-migration/)

Antigravity's authentication documentation says API-key operation requires both `modelProvider: "gemini"` in its settings and `GEMINI_API_KEY`; the variable alone is insufficient, and the CLI does not load `.env` files. Local sign-in uses the OS keyring. Verify the manual remote-login flow from a browser-hosted Freshell pane, which may lack the SSH environment variables used to select that flow. [Antigravity authentication](https://antigravity.google/docs/install/?tab=cli)

Neither `agy` nor `gemini` was on this planning shell's PATH. Documentation research establishes candidate contracts, not a tested binary version or successful authentication. Before writing the provider adapter, prove:

1. A pinned stable `agy` release and its Linux, macOS, and native Windows distribution/install mechanisms. Antigravity is not the `@google/gemini-cli` npm package. Record artifact checksums and actual version/help output; identify the minimum supported release.
2. Actual transcript record schema, complete conversation enumeration, workspace association, retention/deletion behavior, native titles, and whether the transcript is sufficient for native recovery or only an exported display log. Check unobserved sessions created outside Freshell; hook-only indexing cannot claim complete history parity.
3. Hook behavior on fresh start, exact resume, `/resume`, `/clear`, forks, cancellation, approvals, subagents, and asynchronous work. A model invocation ending is not necessarily a user turn ending; hook inputs alone do not prove the final outcome after all user hooks run.
4. A launch-scoped way to install the Freshell hook/MCP configuration while preserving ordinary user hooks, plugins, skills, rules, credential access, and project configuration. Prefer a supported overlay or plugin selected for the child. If the release requires changing shared files, stop that design and specify a reversible, narrowly owned integration before implementation; do not overwrite the user's shared configuration.
5. Authentication under host and managed execution, including whether login relies on an OS keyring, local daemon, or backend state that cannot be projected into a container. Prove the documented headless/Cloud-project path where applicable. Obtain secret values through the existing OneCLI integration; do not copy live credential stores into fixtures or commit them.
6. Independent CLI-process lifecycle and session resume across process/server restart. Determine whether any shared backend process owns durable state, and keep cleanup limited to processes created by the test.

**Exit condition:** checked-in sanitized native fixtures and a short contract record in this plan identify the tested version, source/overlay mechanism, identity/rebind semantics, and native recovery store. Missing evidence stays a named blocker for that capability. A launch-only milestone may ship with accurate limitations; it is not completion of first-class support.

## 4. Maintained Gemini CLI compatibility

Preserve the existing `gemini` provider even when Antigravity becomes the recommended Google CLI. Do not infer that a working Gemini CLI installation is obsolete for every account.

If `gemini` itself is selected for full integration, use these separate inputs:

1. Executable `gemini`, package `@google/gemini-cli`; the registry reported stable version `0.66.0` during research. Use `gemini --resume <full-uuid>` and verify interactive/model flags against the pinned executable. [Package metadata](https://registry.npmjs.org/@google/gemini-cli/latest), [Gemini session documentation](https://geminicli.com/docs/cli/session-management/)
2. The session documentation still describes project-hash chat directories. The pinned `v0.66.0` source already handles JSONL recording, legacy JSON migration, patch/metadata/rewind records, a project registry, and project-root markers. Base the reader on the pinned format and migration fixtures; do not implement only the old JSON-snapshot schema or attempt to reverse a directory hash into a cwd. [Recording types](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/services/chatRecordingTypes.ts), [recording service](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/services/chatRecordingService.ts), [storage](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/config/storage.ts), [project registry](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/config/projectRegistry.ts)
3. Gemini hooks use their own event vocabulary and snake-case fields such as `session_id`, `transcript_path`, and `cwd`; Antigravity hooks use a different contract. Implement separate boundary adapters while reusing existing Freshell identity/activity types. [Gemini hooks](https://geminicli.com/docs/hooks/reference/)
4. Google sign-in, API-key authentication, and Vertex AI are separate supported Gemini authentication paths. Keep CLI authentication separate from Freshell's Gemini API setting for generated names and summaries. [Gemini authentication](https://geminicli.com/docs/get-started/authentication/)

No full second adapter is required merely to preserve existing launch/settings compatibility.

## 5. Implementation sequence

Each code stage follows red/green/refactor: first run a behavioral test that fails for the missing behavior, implement the smallest complete path, then remove duplication and rerun affected checks. Commit each completed stage. Tests must execute readers, launches, server routes, or user interactions; do not assert that source, documentation, prompts, or configuration contain particular strings.

Across these stages, emit structured JSONL/tracing events with severity for launch outcomes, identity binding/rebinding, discovery/parse failures, resume decisions, rejected or stale hook events, activity transitions, and managed qualification/recovery. Correlate provider, terminal, launch generation, and native session ID where available; omit prompt/transcript contents and credentials. Validate representative failure and rebind events by exercising those production paths and checking their emitted fields. Keep routine events concise and rate-limit repeated failures through existing logging conventions.

### Stage 1 — Prove the provider contract

Run the section 3 probes in disposable homes/workspaces and record sanitized fixtures for fresh, resumed, switched, tool-using, cancelled, failed, and zero-turn sessions. Capture the actual hook configuration and payloads. Include two simultaneous sessions in one directory. Keep paid real-provider probes opt-in and bounded; this planning document does not execute them.

Deliverable: versioned fixture corpus and executable contract smoke. Resolve the configuration/keyring/backend questions before selecting a managed launch design. Do not install global software or migrate the user's configuration as part of the probe.

### Stage 2 — Register the CLI and launch it correctly

Create `extensions/antigravity/freshell.json` and register the label/icon through the existing UI paths. Add command override, exact-resume template, and proven option templates. Derive availability from the selected executable on the server host; distinguish installed from authenticated. Reuse provider discovery/settings merging so a new provider appears without resetting existing choices.

Use argv arrays through the current platform launch builder. Handle spaces, Unicode, Windows `.cmd`/executable resolution, and custom wrappers. Preserve provider-native interactive authentication/approvals; default launch must not add broad approval-bypass flags. Model and effort controls should use supported discovery/default behavior rather than a copied list of today's model names. Add controls only where actual flag/value mapping exists.

Tests: execute a contract-faithful fake executable through the real launch builder and create route; check observed argv, cwd, selected model, interactive prompt, and override resolution. Exercise absent executable and rejected option errors. Verify picker/settings behavior and CLI/MCP creation against the server.

Deliverable: complete launch/settings behavior, explicitly without native-history or durable-recovery claims until later stages pass.

### Stage 3 — Read native history and search it

Add proposed `AntigravityLayout`, `AntigravitySource`, and `parse/antigravity.rs` using the stage 1 schema. Register them in `all_layouts()`, server source construction, and provider-home watcher mapping. Reuse the current index's dirty marking, cache, checked discovery, and scan-failure reporting.

Extract exact native ID, recorded workspace paths, native title where available, first authored user prompt, start/update time, message/tool history, and available usage. Keep missing usage unknown. For multi-folder conversations, retain all known paths and use an evidenced primary directory for the existing single-directory UI; do not guess from an unrelated current terminal.

Search the normalized native conversation rather than grepping raw JSON. Handle append/replace/rename, partial writes, unknown records, truncation/rewind, missing/late roots, deletion, and configured home paths. Recover from a temporarily incomplete tail without erasing the last valid indexed result. Bound reads and avoid repeatedly parsing entire histories on every filesystem event. Leave provider files read-only.

Tests: parser fixtures and real temporary-directory watcher/index tests, then session-directory/history/search HTTP tests. Include sessions created outside Freshell, duplicate-ID ambiguity across providers, malformed records, Unicode/Windows paths, and deleted history. If complete native enumeration is not supported, document the remaining gap instead of presenting observed-only history as full coverage.

### Stage 4 — Bind exact live identity and resume it

Add a small provider hook adapter using the established terminal signal path. Bind events to the terminal and its launch generation, carry the exact conversation ID and authoritative transcript/store locator, and acknowledge quickly without changing provider behavior. Observer hooks return neutral `{}` output and do not alter permissions, inject messages, or force the agent loop to continue. Keep hooks inactive in ordinary external shells. Reuse the generic identity registry and `SessionRef { provider, sessionId }` rather than inventing another identity type.

Only enable this provider in marker/association resolution once its adapter works. Rebind on proven in-CLI conversation changes; reject late events from retired generations. Do not associate a pane with the newest transcript, a cwd match, a process title, or the last-conversation cache. Retain identity after process exit and keep zero-turn session identity distinct from proof of a durable conversation.

Extend server existence checks, resolve hints and exact-ID routing, `resume_validation`, and client resume templates. A live matching session is focused/reattached. A stopped session resumes with the exact native ID and workspace. Missing native state, authentication failure, and transient store errors remain different outcomes; none silently becomes a fresh chat. Never copy Antigravity's “continue latest” fallback into Freshell's resume path.

Tests: two same-directory panes, live focus, stopped resume, explicit ambiguous IDs, `/resume`/`/clear`/fork rebinding, delayed old-generation events, browser reload, disconnect/reconnect, exited processes, and native history loss. Assert continued conversation content after a second turn, not just matching displayed IDs.

### Stage 5 — Names, activity, completion, and attention

Extend unified naming's explicit TypeScript/Rust provider lists and terminal mappings. Use native names when supported, existing first-message fallback otherwise, and the current manual-name precedence. Keep pane/tab/sidebar/history names aligned after reload and rebind. Native rename writes require a supported provider operation; do not edit provider transcripts to rename a session.

Add a `freshell-activity` adapter and wire it through WebSocket state and client completion handling. Normalize observed events into existing activity types. For Antigravity, distinguish individual invocation completion from full turn completion and outstanding asynchronous work. Treat `Stop` plus `fullyIdle` and outcome as evidence to validate against real traces, not an unconditional success bell. Only expose approval/question distinctions if the release supplies reliable evidence; otherwise show an accurate broader state.

Tests: tool loops, multiple invocations, subagents/background work, approval waits, cancellation, errors, stale/duplicate hooks, process exit, and completion/attention exactly once. Verify name consistency and manual precedence across multiple clients.

### Stage 6 — Managed execution and durable recovery

Add the selected provider to the version inventory and runtime image with a pinned, verified artifact. Extend existing typed provider preparation/bootstrap/reference profiles, host provider dispatch, and native-history probes. Carry ordinary instructions, skills, plugins/dependencies, MCP definitions, proxy settings, and configuration references through the established bounded environment mechanism. Source private credential values through OneCLI and existing grants; preserve native auth requirements identified in stage 1.

Reuse existing recovery policy: verified live reattach, exact native resume, checkpoint restore where genuinely supported, and pristine-seed recovery only when never dispatched. A transcript display export alone does not establish native resume/checkpoint capability. Confirm which state/backend must survive host/container replacement; never claim recovery by copying an insufficient log.

Add an Antigravity capability row in `freshell-agent-runtime` and its documentation mirror. Advance certification states only through the existing qualification process. Preserve the Gemini row's disabled guarantees unless its own implementation is being completed. Keep unsupported recovery paths explicit rather than inventing positive evidence or a parallel recovery engine.

Tests: real controller → session host → provider preparation, executable configured resources and MCP access, exact identity, native resume after process replacement, host/controller restart, checkpoint restore where claimed, retained replay, missing-store evidence, zero-turn recovery, and blocked recovery without replacement. Run destructive cases in the repo's disposable sandbox. Exercise auth/config failure paths without touching production or other agents' processes.

### Stage 7 — End-to-end proof and documentation

Add proposed browser specs `google-cli-launch-rust.spec.ts`, `google-cli-history-resume-rust.spec.ts`, `google-cli-identity-activity-rust.spec.ts`, and `runtime-google-provider-qualification-rust.spec.ts`. Build the fake CLI from the stage 1 fixtures and actual hook/native-store semantics; the existing generic `fake-gemini.mjs` launcher is insufficient proof.

The browser tests must create a pane, send a prompt, observe work and completion, find its history, refresh/reconnect, focus the live session, stop the owned fixture process, resume the exact native conversation, and continue with preserved content. Cover two concurrent same-directory sessions and at least one failure that preserves the conversation instead of replacing it.

Keep the real-provider contract smoke separate from routine hermetic CI. Run it against the pinned binary with isolated state and an approved low-cost model, proving one turn, a tool operation, exact resume, and continued context. A fake passing is necessary for regression coverage and insufficient for provider qualification.

Update `README.md` with the actual product name, installation/login location, command override, supported settings, history/resume behavior, and specific supported-version limitations. Update `docs/index.html` for the new visible provider experience. Link agent implementation notes from `AGENTS.md`; do not add a separate end-user Markdown guide.

## 6. Verification and completion gates

1. Before implementation, fetch/fast-forward clean local `main`, verify a green intended base through `scripts/base-gate.sh`, and create a fresh `.worktrees/` feature branch from `origin/main`.
2. Use repo-owned focused Vitest commands for affected client/tooling tests, e.g. `pnpm run test:vitest run test/unit/client/lib/coding-cli-utils.test.ts --config config/vitest/vitest.config.ts`. Use narrowed Rust selectors during development and the sandbox wrapper for destructive or direct server/integration workloads. New tests must execute a nonzero count.
3. Run the affected browser specs on the configured `FRESHELL_E2E_BACKEND`; verify they are not in `CLOUD_SKIP_SPECS` and did not filter to zero cases. Managed tests must exercise an actual managed candidate on that backend, not a legacy-terminal substitute. Follow the existing external-target managed test topology when needed.
4. Run `pnpm run check` with `GCLOUD_ROBOT_REQUIRE=1`, `FRESHELL_RUST_TEST_SANDBOX=1`, and a useful `FRESHELL_TEST_SUMMARY` from the implementation worktree. Preserve the configured cloud backend and coordinator gate; no silent local fallback. Broad passing results supplement the specific acceptance coverage above.
5. Require the real-provider qualification receipt before enabling managed/durable flags. Record the tested binary, target platform, image, recovery paths, and limitations. Verify Linux/WSL terminal behavior and native Windows executable/argv behavior; the Windows desktop path uses the native Windows app.
6. Commit focused changes and push the clean branch. Obtain explicit approval before creating the PR; merge only after required checks and approval constraints are satisfied. Follow existing launch/rollout runbooks for any later deployment. The live self-hosted server on port 3001 must not be restarted without the user's explicit `APPROVED`.

Completion is assessed against all six user-visible requirements in section 1. A picker entry, passing generic fixture, working headless prompt, or optimistic capability flag alone is not first-class integration.

## 7. Recommended first action

Run Stage 1 for **Antigravity CLI (`agy`)**, then implement launch → native history → exact identity/resume → naming/activity → qualified managed recovery in that order. Preserve `gemini` compatibility throughout. The highest-risk unknowns are launch-scoped hooks/configuration, native state needed for recovery, and managed authentication/backend ownership; resolving those first prevents building the rest on an assumed contract.
