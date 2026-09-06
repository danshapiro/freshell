# Fresh-Agent Per-Send Settings on the Rust Server — Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
On the Rust server, fresh-agent panes (freshclaude, kilroy, freshcodex, freshopencode) silently discard per-send model/effort/sandbox/permission selections made in the UI between sends: the client ships them in every `freshAgent.send` frame's `settings` object, but the Rust `handle_send` handlers never read `msg.settings` (claude/kilroy: `crates/freshell-freshagent/src/claude.rs:762-800`; codex: `crates/freshell-freshagent/src/codex.rs:1082-1193` uses only create-time values; opencode already honors model/effort). Apply per-send settings at send time for every provider that supports mid-session changes, capability-gated where the provider cannot, with wire-contract-safe frames. Where a provider genuinely cannot honor a mid-session change, the UI must say so at selection time rather than silently ignoring it. This is checklist item AGENT-12 (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:350`).

### Explicit constraints
- Wire-contract-safe frames: no breaking changes to the shared schemas in `shared/ws-protocol.ts` / `crates/freshell-protocol` (the `freshAgent.send.settings {cwd?, model?, permissionMode?, sandbox?, effort?}` payload already exists on both stacks, `shared/ws-protocol.ts:529-548` and `crates/freshell-protocol/src/client_messages.rs:578-609`, and the client already sends it on every send, `src/components/fresh-agent/FreshAgentView.tsx:1070-1089`).
- Acceptance: (1) changing effort/model for a send measurably alters that turn against the Rust server (provider-level assertion in a server test); (2) UI reflects "applies to next send only" vs "session create only" honestly per provider; (3) unit coverage for parse→apply per provider adapter; no silent drop path remains.
- Node adapter reference for per-send application (including effort forwarding on `turn/start`): `server/fresh-agent/adapters/codex/adapter.ts:130-131,978`.

### Accepted tradeoffs and residuals
- The claude-family mid-session application happens via a new internal Rust→sidecar frame (`settings.update`) driving SDK control requests; the Node server's claude adapter remains create-only and advertises that honestly.
- Sandbox is a codex-only concept; opencode and claude advertise `unsupported` for it and Rust logs instead of silently dropping when it arrives anyway.
- Plugins are not part of per-send selection (they remain create-time-only and unchanged by this work); `msg.images` handling is unchanged.
- `docs/index.html` is a nonfunctional mock of the default experience; the disclosure-hint copy change is minor and does not change default-experience flows, so no docs/index.html edit is included.

**Goal:** On the Rust server, every fresh-agent provider applies the pane's current model/effort/sandbox/permission selections to each send (or advertises `create-only`/`unsupported` per knob), so changing a selection between two sends measurably alters the second turn — with the UI honestly labeling each knob's scope.

**Architecture:** The client already stages per-pane settings and sends them on every `freshAgent.send`. This work adds: (1) a shared additive `capabilities.settingScopes` field on the fresh-agent snapshot schema (provider- and server-advertised `'per-send' | 'create-only' | 'unsupported'` per knob); (2) Rust-side application — codex merges `msg.settings` over the session baseline and forwards them on `turn/start` (native per-turn protocol support), claude/kilroy gains a `settings.update` sidecar frame driving the SDK's mid-session `setModel`/`setPermissionMode`/`applyFlagSettings` control requests, opencode already applies model/effort per send and gains wire-level proof plus honest `unsupported` advertisement for sandbox/permission; (3) Node-adapter capability emission so both server stacks tell the truth; (4) client disclosure copy in the settings popover and model dialog driven by the advertised scopes; (5) e2e proof on both wire protocols.

**Tech Stack:** Rust workspace (`crates/freshell-freshagent`, `crates/freshell-protocol`), Node claude-agent sidecar (`crates/freshell-claude-sidecar/index.mjs`, vendored `@anthropic-ai/claude-agent-sdk@0.3.237`), TypeScript/React client (Redux, zod schemas under `shared/`), Node server adapters (`server/fresh-agent/adapters/*`), Vitest, `cargo test`, Playwright (`rust-chromium` project).

## Global Constraints

- TDD red/green/refactor per task; every task's failing test must fail for the stated reason before the implementation lands. No test may pass vacuously.
- The Darkforge baseline ledger records three pre-existing `test/unit/vite-config.test.ts > getNetworkHost` failures at base commit `398a866f527909e37e68c46424a5d3a77951cf60`; a nonzero QA gate exit is accepted only when every parsed failure identity is in that set. Do not touch those tests.
- The full QA gate (`/home/dan/.local/share/darkforge/sources/freshell-qa.sh`) runs `npm ci` (conditional), `npm run check` (typecheck + coordinated client+server+electron vitest), `cargo fmt --all --check`, and three clippy invocations — it never runs `cargo test`. Therefore every Rust task gate below includes `cargo test -p freshell-freshagent` explicitly.
- Server TS is NodeNext/ESM: relative imports under `server/`/`shared/` carry `.js` extensions. Client imports use the `@/` alias.
- Structured logging discipline: no prompt text in logs; session ids/codes only.
- Never restart the self-hosted production server; all e2e runs use owned scratch servers via the existing harness.
- Test coordination: focused vitest runs use `npm run test:vitest -- run ...` (the repo-owned path); broad suites go through the coordinator (`npm run check`/`npm test` or the QA gate). Never raw `npx vitest`.
- Do not modify anything under the pinned workflow source or the Darkforge state directories.

---

### Task 1: Shared contract — `capabilities.settingScopes` + client copy helpers

Additive, optional field on the fresh-agent capabilities schema so servers can
advertise per-knob application scope. Optional-on-strict-object preserves wire
compatibility in both directions (old server + new client parses; new server +
old client tolerates the extra key on the WS side and the REST client ignores
unknown keys only if the schema is not `.strict()` rejected — it IS strict, so
the schema must know the field BEFORE any server emits it; hence Task 1 lands
first and emission lands per provider in Tasks 2-4).

**Files:**
- Modify: `shared/fresh-agent-contract.ts:14-23` (`FreshAgentCapabilitiesSchema`)
- Create: `src/lib/fresh-agent-setting-scopes.ts`
- Test: `test/unit/shared/fresh-agent-contract.test.ts` (extend existing)
- Test: `test/unit/client/lib/fresh-agent-setting-scopes.test.ts` (new)

**Interfaces:**
- Consumes: shared/fresh-agent-contract.ts existing schemas.
- Produces:
  - `FreshAgentSettingScopeSchema = z.enum(['per-send', 'create-only', 'unsupported'])`
  - `FreshAgentSettingScopesSchema = z.object({ model: ..., effort: ..., sandbox: ..., permissionMode: ... }).strict()` (all optional)
  - `FreshAgentCapabilitiesSchema` gains `settingScopes: FreshAgentSettingScopesSchema.optional()`.
  - `export type FreshAgentSettingScope` / `FreshAgentSettingScopes`.
  - Client lib: `SETTING_SCOPE_COPY: Record<'per-send','create-only', string>`, `settingScopeHint(scopes, knob): string`, `freshAgentDialogFooterCopy(scopes): string`.

- [ ] **Step 1: Write the failing test**

Extend `test/unit/shared/fresh-agent-contract.test.ts` with a describe block that (a) parses a capabilities object WITH `settingScopes: { model: 'per-send', effort: 'per-send', sandbox: 'per-send', permissionMode: 'per-send' }` through `FreshAgentCapabilitiesSchema` and asserts the value round-trips; (b) asserts the existing minimal capabilities object (without settingScopes) still parses (backward compat); (c) asserts `settingScopes: { model: 'sometimes' }` FAILS to parse. New file `test/unit/client/lib/fresh-agent-setting-scopes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  SETTING_SCOPE_COPY,
  freshAgentDialogFooterCopy,
  settingScopeHint,
} from '@/lib/fresh-agent-setting-scopes'

describe('fresh-agent setting scope copy', () => {
  it('maps per-send/create-only to hint copy', () => {
    expect(settingScopeHint({ permissionMode: 'per-send' }, 'permissionMode')).toBe(SETTING_SCOPE_COPY['per-send'])
    expect(settingScopeHint({ permissionMode: 'create-only' }, 'permissionMode')).toBe(SETTING_SCOPE_COPY['create-only'])
    expect(settingScopeHint(undefined, 'permissionMode')).toBe(SETTING_SCOPE_COPY['per-send']) // legacy fallback
  })
  it('builds the model dialog footer per scope', () => {
    expect(freshAgentDialogFooterCopy({ model: 'per-send', effort: 'per-send' })).toContain('applies from your next message')
    expect(freshAgentDialogFooterCopy({ model: 'create-only' })).toContain('applies at session start')
    expect(freshAgentDialogFooterCopy(undefined)).toContain('applies from your next message') // legacy fallback
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/lib/fresh-agent-setting-scopes.test.ts test/unit/shared/fresh-agent-contract.test.ts`

Expected: FAIL because `@/lib/fresh-agent-setting-scopes` does not exist yet (import error), and the new contract describe fails on parsing `settingScopes` (strict object rejects unknown key).

- [ ] **Step 3: Add the minimal production implementation**

In `shared/fresh-agent-contract.ts`, after the existing capability keys:

```ts
export const FreshAgentSettingScopeSchema = z.enum(['per-send', 'create-only', 'unsupported'])
export type FreshAgentSettingScope = z.infer<typeof FreshAgentSettingScopeSchema>
export const FreshAgentSettingScopesSchema = z.object({
  model: FreshAgentSettingScopeSchema.optional(),
  effort: FreshAgentSettingScopeSchema.optional(),
  sandbox: FreshAgentSettingScopeSchema.optional(),
  permissionMode: FreshAgentSettingScopeSchema.optional(),
}).strict()
export type FreshAgentSettingScopes = z.infer<typeof FreshAgentSettingScopesSchema>
```
and add `settingScopes: FreshAgentSettingScopesSchema.optional(),` inside `FreshAgentCapabilitiesSchema` (before its closing `}).strict()`).

Create `src/lib/fresh-agent-setting-scopes.ts`:

```ts
import type { FreshAgentSettingScopes } from '@shared/fresh-agent-contract'

export const SETTING_SCOPE_COPY = {
  'per-send': 'Applies from the next message.',
  'create-only': 'Applies when a session starts — start a new conversation to change it.',
} as const

export type FreshAgentSettingKnob = 'model' | 'effort' | 'sandbox' | 'permissionMode'

/** Scope-driven hint. Older servers (field absent, or knob absent) fall back to
 * the pre-existing per-send copy: for a not-yet-created pane everything applies
 * at create, which that copy truthfully covers. */
export function settingScopeHint(scopes: FreshAgentSettingScopes | undefined, knob: FreshAgentSettingKnob): string {
  const scope = scopes?.[knob]
  if (scope === 'create-only') return SETTING_SCOPE_COPY['create-only']
  return SETTING_SCOPE_COPY['per-send']
}

const DIALOG_FOOTER_BASE = '↑↓ move · ←→ switch column · Enter = OK · Esc = cancel'
/** Model dialog footer: model+effort scopes decide the application clause. */
export function freshAgentDialogFooterCopy(scopes: FreshAgentSettingScopes | undefined): string {
  const createOnly = scopes?.model === 'create-only' || scopes?.effort === 'create-only'
  return `${DIALOG_FOOTER_BASE} · ${createOnly ? 'applies at session start' : 'applies from your next message'} · becomes your default`
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/lib/fresh-agent-setting-scopes.test.ts test/unit/shared/fresh-agent-contract.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — new leaf module.

- [ ] **Step 6: Run impacted-test verification**

Impacted: everything that parses fresh-agent snapshots/capabilities (client contract tests) plus a typecheck of the whole repo (the schema type flows into adapter normalize return types).

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/shared/` && `npm run typecheck`

Expected: PASS (the optional field is additive; no existing test constructs capabilities with unknown keys).

- [ ] **Step 7: Commit the task**

```bash
git add shared/fresh-agent-contract.ts src/lib/fresh-agent-setting-scopes.ts test/unit/shared/fresh-agent-contract.test.ts test/unit/client/lib/fresh-agent-setting-scopes.test.ts
git commit -m "feat(freshagent): add capabilities.settingScopes contract + scope copy helpers"
```

---

### Task 2: Rust codex — merge `msg.settings` into every `turn/start` + scope advertisement (Node too)

In `crates/freshell-freshagent/src/codex.rs` `FreshCodexState::handle_send`
(1082-1193): per-send merge of `msg.settings` over the session record
(explicit send fields win; omitted fields keep the session baseline — Node
`rememberThreadSettings` semantics, `adapter.ts:695-710,957-967`), persist the
merged baseline back onto `CodexSession`, refresh the pane-ledger binding row,
and advertise `settingScopes` (all four knobs `per-send`) in the snapshot
capabilities json (codex.rs:3677-3686). The Node codex adapter is truthful
about the same scopes (`server/fresh-agent/adapters/codex/normalize.ts:764`).

The pane ledger preserves an existing row's `create_request_id` when the new
write carries `None` (`crates/freshell-ws/src/pane_ledger.rs:498-501`), so the
refresh write passes `create_request_id: None` safely.

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` (handle_send merge + capabilities json)
- Modify: `server/fresh-agent/adapters/codex/normalize.ts:764` (capabilities literal)
- Test: `crates/freshell-freshagent/src/codex.rs` tests module (4237+)
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts` (snapshot scopes pin)

**Interfaces:**
- Consumes: `FreshAgentSendSettings { cwd, effort, model, permission_mode, sandbox }` (freshell-protocol); `normalize_freshcodex_model(Option<&str>) -> String` (freshell-codex/src/model.rs:83); `normalize_freshcodex_effort(Option<&str>, Option<&str>) -> Option<String>` (model.rs:116); `to_codex_reasoning_effort` (Result; INVALID_EFFORT error path exists at codex.rs:1140-1146); `sandbox_wire_value(Sandbox) -> String` (codex.rs:4185); `sandbox_policy_value(&str) -> Value` (codex.rs:4195); `self.record_codex_binding(session_id, create_request_id, model, sandbox, permission_mode, effort, cwd, supersedes)` (codex.rs:350-400).
- Produces: `handle_send` applies per-send settings on every `turn/start`; `CodexSession` carries the merged baseline; ledger row refreshed; snapshot capabilities json gains `settingScopes`; Node codex snapshot capabilities gain the same.

- [ ] **Step 1: Write the failing test**

In `crates/freshell-freshagent/src/codex.rs`'s tests module, add (pattern after `codex.rs:4829-4911`'s channel-peer style):

```rust
#[tokio::test]
async fn handle_send_applies_per_send_settings_to_turn_start() {
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    let client = Arc::new(client);
    let (st, _rx) = state_with_bus();
    let active_turn = Arc::new(StdMutex::new(None));
    insert_fake_session(&st, "thread-1", client, active_turn, spawn_sleeper(), "codex-per-send-settings").await;
    // Baseline: stored session is model gpt-5.3-codex-spark / no effort (fixture defaults).
    // DRIVER PATTERN (must match codex.rs:5789-5804): spawn handle_send; answer the
    // initialize handshake; expect turn/start from the peer. Driving handle_send in the
    // foreground would deadlock (it awaits the RPC response).
    let driver = {
        let st = st.clone();
        tokio::spawn(async move {
            st.handle_send(FreshAgentSend {
                request_id: Some("req-1".to_string()),
                provider: freshell_protocol::AgentProvider::Codex,
                session_id: "thread-1".to_string(),
                session_type: freshell_protocol::SessionType::Freshcodex,
                text: "turn two".to_string(),
                images: None,
                cwd: None,
                settings: Some(freshell_protocol::FreshAgentSendSettings {
                    cwd: None,
                    effort: Some("low".to_string()),
                    model: Some("gpt-5.4-flash".to_string()),
                    permission_mode: Some("never".to_string()),
                    sandbox: Some(freshell_protocol::Sandbox::WorkspaceWrite),
                }),
            })
            .await;
        })
    };
    answer_initialize(&peer).await;
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "turn/start");
    assert_eq!(params["model"], json!("gpt-5.4-flash"));
    assert_eq!(params["effort"], json!("low"));
    assert_eq!(params["sandboxPolicy"], json!({ "type": "workspaceWrite" }));
    assert_eq!(params["approvalPolicy"], json!("never"));
    peer.respond(&id, json!({ "turn": { "id": "turn-2", "status": "inProgress" } }));
    driver.await.expect("send task");
}
```

(Response shape and helpers: `answer_initialize` at codex.rs:5114; frame-capture helper
`capturing_sink()` / `captured_frames()` used by the fork test at codex.rs:5793+; the
per-send-turns test asserts the error frames through those same helpers.)

Also add, in the same module:
- `handle_send_per_send_settings_persist_as_new_baseline` — after the settings send above and an answered turn, a SECOND send with `settings: None` produces `turn/start` params with the NEW model/effort (baseline changed), not the fixture defaults.
- `handle_send_invalid_per_send_effort_emits_invalid_effort_and_skips_turn` — settings `effort: Some("bogus")` yields the INVALID_EFFORT error frame on the broadcast bus and `peer.expect_request()` must NOT see a `turn/start` (bounded wait pattern used elsewhere, e.g. asserting only the `error` frame arrives within a short timeout before any request).
- `codex_snapshot_advertises_setting_scopes_per_send` — build the snapshot (existing get_snapshot test style, e.g. codex.rs:4829 pattern) and assert `snapshot["capabilities"]["settingScopes"]["model"] == "per-send"` for all four knobs.

Node pin: extend `test/unit/server/fresh-agent/codex-adapter.test.ts` — in the existing snapshot assertions add `expect(snap.capabilities.settingScopes).toEqual({ model: 'per-send', effort: 'per-send', sandbox: 'per-send', permissionMode: 'per-send' })`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent codex::tests::handle_send_applies_per_send_settings_to_turn_start codex::tests::handle_send_per_send_settings_persist_as_new_baseline codex::tests::handle_send_invalid_per_send_effort_emits_invalid_effort_and_skips_turn codex::tests::codex_snapshot_advertises_setting_scopes_per_send -- --nocapture`

Expected: FAIL because `handle_send` ignores `msg.settings` (turn/start params carry the fixture-stored values), and the snapshot capabilities have no `settingScopes` key.

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/fresh-agent/codex-adapter.test.ts`

Expected: FAIL because Node's snapshot lacks `settingScopes`.

- [ ] **Step 3: Add the minimal production implementation**

In `handle_send` (codex.rs:1116-1158), replace the derive-only block with a merge — preserving the existing drop-lock-before-await structure:

```rust
// Merge msg.settings over the session baseline (Node adapter.ts:957-967):
// explicit send-side fields win; omitted fields keep the stored baseline.
let settings = msg.settings.as_ref();
let model_raw = settings.and_then(|s| s.model.clone()).unwrap_or(model);
let effort_raw = settings.and_then(|s| s.effort.clone()).or(effort);
let turn_cwd = settings.and_then(|s| s.cwd.clone()).or(turn_cwd);
let sandbox = settings.map(|s| s.sandbox.map(sandbox_wire_value)).flatten().or(sandbox);
let permission_mode = settings.and_then(|s| s.permission_mode.clone()).or(permission_mode);

let model = normalize_freshcodex_model(Some(&model_raw));
let effort = normalize_freshcodex_effort(Some(&model), effort_raw.as_deref());
```
(keep the existing INVALID_EFFORT path at 1140-1146 — it now also guards per-send values.) Then, only when `msg.settings.is_some()`, write the merged baseline back under the sessions lock (`model`, `effort`, `cwd`, `sandbox`, `permission_mode` on the `CodexSession`), drop the lock, and call `self.record_codex_binding(&session_id, None, &model, sandbox.as_deref(), permission_mode.as_deref(), effort.as_deref(), turn_cwd.as_deref(), None).await` BEFORE `client.start_turn`. (The ledger keeps the original row's `create_request_id` when `None` is passed — pane_ledger.rs:498-501.)

Capabilities: add `"settingScopes": { "model": "per-send", "effort": "per-send", "sandbox": "per-send", "permissionMode": "per-send" }` to the codex `get_snapshot` capabilities json (codex.rs:3677-3686).

Node (`server/fresh-agent/adapters/codex/normalize.ts:764`): add the same `settingScopes: { model: 'per-send', effort: 'per-send', sandbox: 'per-send', permissionMode: 'per-send' }` to the capabilities object literal.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent codex::tests:: -- --nocapture` && `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/fresh-agent/codex-adapter.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Share nothing prematurely; the merge tuple is local. Clippy/fmt clean.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent` && `cargo clippy -p freshell-freshagent --all-targets -- -D warnings` && `cargo fmt --check -p freshell-freshagent` && `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/fresh-agent/`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex.rs server/fresh-agent/adapters/codex/normalize.ts test/unit/server/fresh-agent/codex-adapter.test.ts
git commit -m "feat(freshagent): apply per-send settings on codex turn/start (Rust) + scope advertisement"
```

---

### Task 3: Rust claude/kilroy — mid-session `settings.update` sidecar frame + crate application + scope advertisement

Biggest task: claude's sidecar has no settings-change frame today. Add one —
internal Rust↔sidecar protocol (NOT the shared WS schema):

- Rust→sidecar: `{"type":"settings.update","sessionId":...,"model"?:str,"permissionMode"?:str,"effort"?:str}` — at least one knob present.
- Sidecar (`crates/freshell-claude-sidecar/index.mjs`): per-session serialized op chain so the update is fully applied BEFORE the next `send` pushes the user turn into the SDK input stream — the stdin dispatch loop's handlers are synchronous, so naive `await` would let a following `send` line race past the in-flight control requests:
  ```js
  // handleCreate: state gains { chain: Promise.resolve(), model: req.model, permissionMode: req.permissionMode, effort: req.effort }
  // (the existing state literal gains chain/model/effort fields)
  function enqueue(st, op) { const run = st.chain.then(op, op); st.chain = run.catch(() => {}); return st.chain }
  ```
  `handleSend` re-arms through `enqueue` so a user message never overtakes a pending settings application; `handleSettingsUpdate(req)` enqueues: `setPermissionMode` (also `st.permissionMode = req.permissionMode` — the canUseTool bypass fast-path in permission-channel.mjs:181 reads this session copy and must not go stale), `setModel` (`st.model = req.model`), `applyFlagSettings({ effortLevel })` (`st.effort = req.effort`), then emit `{type:'sdk.session.metadata', sessionId, cliSessionId: st.cliSessionId, model: st.model}` (existing normalize maps it to `freshAgent.session.metadata` → the client status chip and session store update live via `sessionMetadataReceived`, src/store/freshAgentSlice.ts:251-276). SDK failures: emit `{type:'sdk.error', sessionId, message}` (existing normalize → `freshAgent.error`) and do NOT mutate the session baseline.
- Crate `FreshClaudeState::handle_send` (claude.rs:762-800): when `msg.settings` presents any of model/permissionMode/effort, validate (claude effort levels: `["low","medium","high","xhigh","max"]`; permission modes: `["default","acceptEdits","bypassPermissions","plan"]`; invalid → `self.send_error(&request_id, "INVALID_EFFORT"|"INVALID_PERMISSION_MODE", ...)` and return WITHOUT writing anything), persist the merged baseline onto the session record, refresh the ledger via `identity_sink().record_binding(...)` (keyed by `session.cli_session_id` when known, else skip with a debug log — the init-arm's binding still lands moments later for creates), write the `settings.update` frame, THEN write the `send` frame — ordering guaranteed by line order on stdin plus the sidecar chain. Sends whose `settings` carry only `cwd`/no knobs behave exactly as today (single `send` frame, no settings.update).
- `ClaudeSession` (claude.rs:186+) gains `model: Option<String>, permission_mode: Option<String>, effort: Option<String>` seeded at create from the create-frame values and updated by `handle_send`; the fake-sidecar and `insert_fake_claude_session*` fixtures seed `None`s.
- `crates/freshell-freshagent/src/claude_snapshot.rs:597-603` capabilities gain `settingScopes {model/effort/permissionMode: per-send, sandbox: unsupported}`; ALSO emit it from the runtime snapshot path if one exists for claude (implementer: grep for capabilities emitters covering kilroy/freshclaude REST+WS — there may be a second site in claude.rs's attach/resume snapshot).
- kilroy rides the same provider code path (`provider: 'claude'` arm at freshell-ws terminal.rs:1023-1029) — no separate change.
- Node claude (`server/fresh-agent/adapters/claude/normalize.ts:230,57` + snapshot `settings` type): advertise `settingScopes {model:'create-only', effort:'create-only', permissionMode:'create-only', sandbox:'unsupported'}` — Node claude stays create-only; that's the truth.

**Files:**
- Modify: `crates/freshell-claude-sidecar/index.mjs` (dispatch arm + handler + chain)
- Modify: `crates/freshell-freshagent/src/claude.rs` (handle_send + session fields + consumer-arm metadata passthrough if needed)
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs` (capabilities)
- Modify: `server/fresh-agent/adapters/claude/normalize.ts`
- Modify: `crates/freshell-freshagent/src/claude.rs` test double `FAKE_CLAUDE_SIDECAR_SOURCE` (2984-3060): log `settings.update` frames verbatim to `FRESHELL_TEST_CLAUDE_RESPOND_LOG` and emit back `sdk.session.metadata` — the e2e fake `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` logs every raw stdin line to FRESHELL_FAKE_STDIN already and needs no behavior change (its dispatch ignores unknown types; verify at execution).
- Test: `crates/freshell-freshagent/src/claude.rs` tests module
- Test: `crates/freshell-freshagent/tests/claude_sidecar_settings_update.rs` (NEW — real-sidecar integration, pattern after `tests/claude_sidecar_interrupt_dispatch.rs`)
- Test: `test/unit/server/fresh-agent/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `write_line(&mut ChildStdin, &Value) -> Result<(), String>` (claude.rs:2069-2077); `FreshClaudeState::send_error` (claude.rs:1423+); `self.identity_sink()`; vendored SDK 0.3.237 `Query.setModel/setPermissionMode/applyFlagSettings` (lockfile-pinned, crates/freshell-claude-sidecar/package-lock.json:15).
- Produces: sidecar frames `settings.update` (Rust→sidecar) and post-apply `sdk.session.metadata`/`sdk.error` (sidecar→Rust, both already normalized at claude.rs:1837+); `ClaudeSession.model/permission_mode/effort` baseline fields; capabilities `settingScopes` for freshclaude + kilroy.

- [ ] **Step 1: Write the failing tests**

Crate test (module `claude::tests`, fixtures: `FakeClaudeSidecarEnv::install()`, `respond_log_frames(2)`, `spawn_log_path()`):

```rust
#[tokio::test]
async fn handle_send_applies_per_send_settings_via_settings_update_frame() {
    let env = FakeClaudeSidecarEnv::install(); // existing harness, env-locked
    let st = state(); // existing fixture
    // drive a real create through the fake sidecar (existing helper pattern,
    // e.g. the `__raise_permission__` tests at claude.rs:3536+) ... session created.
    st.handle_send(send_msg(<session-id>, "turn two", Some(settings{
        model: Some("opus-x"), permissionMode: Some("plan"), effort: Some("low"), ...None
    }))).await;
    let frames = respond_log_frames(2).await;
    assert_eq!(frames[0]["type"], json!("settings.update"));
    assert_eq!(frames[0]["model"], json!("opus-x"));
    assert_eq!(frames[0]["permissionMode"], json!("plan"));
    assert_eq!(frames[0]["effort"], json!("low"));
    assert_eq!(frames[1]["type"], json!("send"));
    assert_eq!(frames[1]["text"], json!("turn two"));
}
```

(`send_msg` helper at claude.rs:3155 currently always passes `settings: None` — extend it with a settings param or build the `FreshAgentSend` struct literally as in the codex test above. The fake sidecar must log the frame BEFORE the behaviour assertions run — extend `FAKE_CLAUDE_SIDECAR_SOURCE` to append `settings.update` lines.

Also:
- `handle_send_rejects_invalid_effort_loudly`: settings `{effort:"bogus"}` → an `error`/`freshAgent.error` frame observed on the broadcast receiver; respond log sees NEITHER a settings.update NOR a send (assert `respond_log_frames` stays empty with a bounded wait).
- `handle_send_rejects_invalid_permission_mode_loudly`: same shape with `permissionMode: "bogus"`.
- `handle_send_without_settings_writes_plain_send_only`: existing behavior retained (single `send` frame, no settings frame).
- Claude session-baseline test: after the settings send above, a second `send_msg(..., None)` reuses the NEW baseline — if a settings.update were emitted grazing `None`-settings it would be a regression (assert exactly one send frame, and no settings.update on the second send).
- Claude snapshot pin: `claude_snapshot` capability test — built snapshot's `capabilities.settingScopes.model == "per-send"` etc.

Real-sidecar integration (`crates/freshell-freshagent/tests/claude_sidecar_settings_update.rs` — copy the staging pattern from `tests/claude_sidecar_interrupt_dispatch.rs`: stage real `index.mjs` + `permission-channel.mjs` into a temp dir with a stub SDK package; this stub's `query()` returns an object recording control calls and consuming the prompt):

Stub SDK sketch (embedded const):
```js
export function query({ prompt, options }) {
  globalThis.__log = (row) => { require('node:fs').appendFileSync(process.env.FRESHELL_TEST_STUB_SDK_LOG, JSON.stringify(row) + '\n') }
  // NOTE: ESM — use `import fs from 'node:fs'` at module top instead of require.
  const q = {
    setModel: async (m) => { globalThis.__log({ call: 'setModel', model: m }) },
    setPermissionMode: async (m) => { globalThis.__log({ call: 'setPermissionMode', mode: m }) },
    applyFlagSettings: async (s) => { globalThis.__log({ call: 'applyFlagSettings', settings: s }) },
    interrupt: async () => {},
    [Symbol.asyncIterator]: async function* () { await new Promise(() => {}) },
  }
  ;(async () => { for await (const msg of prompt) globalThis.__log({ input: msg?.message?.content?.[0]?.text }) })().catch(() => {})
  return q
}
```

The test: spawn real sidecar, wait for stderr `ready`, write `create` → expect `created`; write `settings.update` `{model:"opus-y", permissionMode:"plan", effort:"xhigh"}` + `send` "hello"; poll the stub log file until it contains 4+ rows; assert setModel/setPermissionMode/applyFlagSettings all appear BEFORE the `{"input":"hello"}` row; assert stdout carried `sdk.session.metadata` with `model === "opus-y"`. Invalid-effort arm: send `settings.update {effort:"bogus"}` → assert the stub recorded NO applyFlagSettings call for it and stdout/stderr shows the refusal (sidecar validates and emits sdk.error).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent claude::tests::handle_send_applies_per_send_settings_via_settings_update_frame claude::tests::handle_send_rejects_invalid_effort_loudly claude::tests::handle_send_rejects_invalid_permission_mode_loudly -- --nocapture` and `cargo test -p freshell-freshagent --test claude_sidecar_settings_update -- --nocapture`

Expected: FAIL — crate tests fail because `handle_send` drops `msg.settings` (respond log shows only the send frame; error frames absent); the integration test fails with `unknown request type: settings.update` on stderr and no control calls logged.

- [ ] **Step 3: Add the minimal production implementation**

Implement per the design above: sidecar `settings.update` dispatch arm + per-session chain + state copy updates + metadata emission; crate `handle_send` validation + frame write + session baseline + ledger refresh; session struct fields; snapshot capabilities.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent claude::tests:: -- --nocapture` && `cargo test -p freshell-freshagent --test claude_sidecar_settings_update -- --nocapture` && `cargo test -p freshell-freshagent --test claude_sidecar_interrupt_dispatch -- --nocapture`

Expected: PASS (interrupt-dispatch regression test still green — the dispatch switch gained an arm but the existing behavior is unchanged).

- [ ] **Step 5: Refactor while green**

Extract the knob validation into a small helper (`validate_claude_send_settings`) shared by arm; keep the sidecar handler flat.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent` && `cargo clippy -p freshell-freshagent --all-targets -- -D warnings` && `cargo fmt --check -p freshell-freshagent` && `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-claude-sidecar/index.mjs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/tests/claude_sidecar_settings_update.rs server/fresh-agent/adapters/claude/normalize.ts test/unit/server/fresh-agent/claude-adapter.test.ts
git commit -m "feat(freshagent): mid-session model/effort/permission changes for claude+kilroy on Rust (settings.update sidecar frame)"
```

---

### Task 4: Rust opencode — provider-level wire assertion + scope advertisement + observability

Rust opencode already honors per-send model/effort (`opencode_ws.rs:635-647`). This task closes the remaining AGENT-12 gaps for this provider: prove the wire body actually changes (provider-level test), advertise scopes truthfully, and make the unsupported knobs observable rather than silently ignored.

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (recording fake + test in tests module at 1806+; production capabilities + log)
- Modify: `crates/freshell-freshagent/src/lib.rs:1541-1553` (capabilities insertion) + any second opencode capabilities emission site the implementer greps (e.g. in opencode_ws.rs WS-side snapshot producer)
- Modify: `server/fresh-agent/adapters/opencode/normalize.ts:453` (capabilities literal)
- Test: `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts` (scopes pin)

**Interfaces:**
- Consumes: existing `handle_send` merge; `build_prompt_body` (`crates/freshell-opencode/src/serve.rs:993-1010`); `ForkFakeHttp`'s `RecordedRequest{method, url, body}` recording pattern (opencode_ws.rs:4423-4470); `StatusPollFakeHttp` busy→idle polling behavior (opencode_ws.rs:1905-1960) so `run_turn` settles.
- Produces: `capabilities.settingScopes {model:'per-send', effort:'per-send', sandbox:'unsupported', permissionMode:'unsupported'}` on Rust opencode snapshots AND the Node opencode snapshot; `tracing::info!` observation when a send settings carries sandbox/permission_mode (Observability, matches repo logging discipline).

- [ ] **Step 1: Write the failing tests**

In opencode_ws.rs tests: a `PromptRecordingFakeHttp` — StatusPollFakeHttp + `recorded: Mutex<Vec<RecordedRequest>>` capturing every request. New test `send_with_changed_settings_rewrites_the_prompt_body`:

```rust
#[tokio::test]
async fn send_with_changed_settings_rewrites_the_prompt_body() {
    // Build state with PromptRecordingFakeHttp as the ServeHttp fake (pattern from
    // ForkFakeHttp injection), create a freshopencode session (existing helpers),
    // send turn 1 with settings {model: Some("openai/gpt-5.5"), effort: Some("high")},
    // wait for the busy→idle settle, then send turn 2 with settings
    // {model: Some("openai/gpt-5-nano"), effort: Some("low")}.
    // Read fake.recorded(): the two POST /session/:id/prompt_async bodies differ:
    //   turn1 body["model"] == {"providerID":"openai","modelID":"gpt-5.5"} and body["variant"] == "high"
    //   turn2 body["model"]["modelID"] == "gpt-5-nano" and body["variant"] == "low"
}
```

Plus `snapshot capabilities` pin: opencode snapshot reports `settingScopes` with model/effort per-send and sandbox/permissionMode unsupported (assert at opencode_ws.rs:2404-style test or the lib.rs snapshot test at pane_ops).

Node: extend `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts` — existing capabilities matchObject at :969 gains `settingScopes: { model: 'per-send', effort: 'per-send', sandbox: 'unsupported', permissionMode: 'unsupported' }`.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent opencode_ws::tests::send_with_changed_settings_rewrites_the_prompt_body -- --nocapture` && `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`

Expected: FAIL for the capability-scope assertion (no `settingScopes` key on the opencode snapshot) and for the prompt-body observability expectations tied to the new log line; NOTE the prompt-body model/variant rewrite itself is EXISTING behavior (opencode already applies per-send settings — opencode_ws.rs:635-647), so that assertion may pass on first run: to prove it is NOT vacuous, run it once against a temporarily neutered merge (e.g. force the `else` baseline branch) and confirm it goes RED, then restore. Vacuity-check receipt goes in the task evidence. The Node test fails on missing settingScopes.

- [ ] **Step 3: Add the minimal production implementation**

- opencode_ws.rs: add `"settingScopes"` to every opencode capabilities emission (one site in lib.rs:1541 and any other opencode snapshot producer — grep capabilities).
- lib.rs + opencode_ws.rs (whichever owns the capabilities object): same addition.
- In `handle_send` (opencode_ws.rs:635-647 region), after the merge: if `settings.sandbox.is_some() || settings.permission_mode.is_some()`, emit `tracing::info!(session_id = %..., has_sandbox = ..., has_permission_mode = ..., "freshagent.opencode.unsupported-settings-ignored")` — no frame shape change (the wire contract stays put; these knobs have no opencode concept).
- Node opencode normalize.ts:453: add settingScopes to the capabilities literal.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent opencode_ws::tests:: -- --nocapture` && `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If two opencode capabilities sites exist, factor the literal into one const used by both.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent` && `cargo clippy -p freshell-freshagent --all-targets -- -D warnings` && `cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings` && `cargo fmt --check -p freshell-freshagent` && `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts test/unit/server/fresh-agent/`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/lib.rs server/fresh-agent/adapters/opencode/normalize.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts
git commit -m "test(freshagent): provider-level per-send proof for opencode + scope advertisement"
```

---

### Task 5: Client UI — scope-driven disclosure copy in the settings popover and model dialog

Honest selection-time copy, driven by the server-advertised `capabilities.settingScopes` (Tasks 2-4). Two surfaces:

1. `FreshAgentSettingsButton` (`src/components/fresh-agent/FreshAgentSettingsButton.tsx`): on popover open, fetch the session's REST snapshot (`getFreshAgentThreadSnapshot`, src/lib/api.ts:422) ONLY when the pane has a live session id; read `capabilities.settingScopes`. Render a scope hint under each gated control using `settingScopeHint` (Task 1):
   - Model radio list (claude providers, `keepsSimpleModelList`) and Thinking select: new hint `<span className="block text-[11px] text-muted-foreground">{settingScopeHint(scopes, 'model')}</span>` / `('effort')` under the control.
   - Permission mode select: REPLACE the hard-coded "Applies from the next message." span (lines 435-437) with `<span …>{settingScopeHint(scopes, 'permissionMode')}</span>`.
   - The snapshot thread id resolution mirrors `FreshAgentView.getFreshAgentSnapshotThreadId` (270-297): extract it to a shared helper `getFreshAgentSnapshotThreadId(pane, session)` in a small module (e.g. `src/lib/fresh-agent-snapshot-thread.ts`) imported by both the view and the button — the view's copy is currently its own; factor without behavior change. Fetch pattern follows the existing popover probe effect (lines 186-200: cancelled-flag, no loading gate). On fetch/parse failure or missing session: leave hints at the legacy fallback (function already returns per-send copy for undefined scopes).
2. `FreshAgentModelDialog` (`src/components/fresh-agent/FreshAgentModelDialog.tsx:555-557`): new optional prop `settingScopes?: FreshAgentSettingScopes`; footer text = `freshAgentDialogFooterCopy(settingScopes)`. `FreshAgentView.tsx:2737-2744` passes `snapshot?.capabilities?.settingScopes`; the popover's dialog instance (FreshAgentSettingsButton's `modelDialogOpen`) passes the scopes it fetched.

A11y/house-style: hints reuse the existing `<span className="block text-[11px] text-muted-foreground">` pattern (no new interactive elements, nothing to label).

Wire-check note for the implementer: REST snapshot parse for Rust-side claude — `getFreshAgentThreadSnapshot` targets `/api/fresh-agent/threads/...` whose Rust routing resolves both durable and runtime ids for claude (verify in execution; if the runtime-id route 404s pre-materialization, the button skips scopes fetch pre-create, which is exactly the fallback branch).

**Files:**
- Modify: `src/lib/fresh-agent-setting-scopes.ts` (no change — from Task 1)
- Create: `src/lib/fresh-agent-snapshot-thread.ts` (extracted helper)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (use shared helper; pass settingScopes prop)
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx` (fetch + hints + pass scopes to its dialog)
- Modify: `src/components/fresh-agent/FreshAgentModelDialog.tsx` (prop + footer)
- Test: `test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx` (extend — mock `@/lib/api`'s `getFreshAgentThreadSnapshot`)
- Test: `test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx` (extend — pass prop, assert both footer variants; keep the pinned legacy test at :291 passing unchanged since no prop = legacy copy)

**Interfaces:**
- Consumes: Task 1 helpers; FreshAgentCapabilitiesSchema.settingScopes; api.getFreshAgentThreadSnapshot.
- Produces: `FreshAgentModelDialog` prop `settingScopes?: FreshAgentSettingScopes`; shared `getFreshAgentSnapshotThreadId(pane, session)` export.

- [ ] **Step 1: Write the failing tests**

`FreshAgentSettingsButton.test.tsx`: render the popover for a freshclaude pane with `sessionId: 's-1'`; mock `getFreshAgentThreadSnapshot` to resolve a snapshot whose `capabilities.settingScopes = { model: 'create-only', effort: 'create-only', permissionMode: 'create-only' }`; open the popover; assert the permission hint reads the create-only copy and the model list shows the create-only hint. Second case: scopes all per-send → "Applies from the next message." everywhere. Third: the promise rejects (older server contract) → legacy copy visible, no crash. The existing 16 tests must keep passing (mock `getFreshAgentThreadSnapshot` returns a session-less default when they pre-date the prop — actually existing tests have no live sessionId in the pane fixture; verify that's true so the fetch never fires for them — otherwise extend their api mock).

`FreshAgentModelDialog.test.tsx`: pass `settingScopes={{model:'create-only',effort:'create-only'}}` → footer asserts "applies at session start"; the pinned default test (:291) with no prop keeps asserting the legacy footer verbatim. Add one per-send-prop case asserting the "applies from your next message" copy.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx`

Expected: FAIL — popover shows the hard-coded permission copy regardless (create-only case fails), and the dialog has no settingScopes prop (TS prop error / footer assertion fails).

- [ ] **Step 3: Add the minimal production implementation**

Implement per design above (shared `getFreshAgentSnapshotThreadId` extraction, popover fetch effect, hint wiring, dialog prop + footer).

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx test/unit/client/lib/fresh-agent-setting-scopes.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None beyond the helper extraction already planned.

- [ ] **Step 6: Run impacted-test verification**

The FreshAgentView extraction and dialog prop touch a heavily-tested component: run the whole fresh-agent client cluster.

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/fresh-agent/ test/unit/client/lib/ test/unit/shared/` && `npm run typecheck`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/fresh-agent-snapshot-thread.ts src/lib/fresh-agent-setting-scopes.ts src/components/fresh-agent/FreshAgentView.tsx src/components/fresh-agent/FreshAgentSettingsButton.tsx src/components/fresh-agent/FreshAgentModelDialog.tsx test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx
git commit -m "feat(freshagent): scope-driven per-send vs create-only disclosure in settings UI"
```

---

### Task 6: e2e proof on the Rust server + checklist AGENT-12 + full QA gate

Playerwright e2e on the `rust-chromium` project (owned scratch servers; NEVER the production server). Extends `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`.

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (+2 tests)
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (recordTurns gains the turn/start params on recorded turns — currently `makeRecordedTurn(turnId, promptText)`: extend to capture the `turn/start` params `{model, effort, sandboxPolicy, approvalPolicy}` onto the recorded turn object so specs can assert them; keep the extra field additive so existing consumers of the record file (fork tests reading turns) are unaffected)
- Modify: `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` (teach the fake to accept `settings.update`: record it in its session state and emit `sdk.session.metadata` with the applied model — the raw-stdin audit already logs every line, so the spec's order assertion is possible without this, but the metadata echo exercises the Rust consumer's normalize arm end-to-end)
- Modify: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:350` — mark AGENT-12 checked and append a completion note in the established style (see AGENT-14's date-stamped note), naming the validation evidence.
- Test: same spec file.

**Interfaces:**
- Consumes: `bootClaudeLane` / `bootCodexLane` (existing helpers), `readStdinFrames`/`waitForStdinFrame` (spec lines 379-423), FRESHELL_FAKE_STDIN audit log, the fake app-server's recorded turn file at `<codexHome>/fake-turns/<threadId>.json` (lane knows homeDir via `lane.sharedRoot` / `lane.info.homeDir`; verify the fixture's `getCodexHome` env resolution in execution — it reads `CODEX_HOME` or `~/.codex`; the lane boots with an isolated HOME, so the path is `<home>/.codex/fake-turns/<threadId>.json`).
- Produces: two new e2e tests, e.g. `per-send settings alter the turn payload against the Rust server (freshcodex)` and `per-send settings reach the claude sidecar before the send (freshclaude)`.

- [ ] **Step 1: Write the failing tests**

Codex lane test: boot, create pane, send "first turn" with the default settings; via the UI settings popover's Model row → dialog, change model to `gpt-5.4-flash` and effort→"Low"; send "second turn". Then read the recorded turns file for the pane's thread id and assert: recorded turn 2's start params carry `{model:"gpt-5.4-flash", effort:"low"}` and turn 1's carry the defaults (proving the change was applied to exactly the second turn).

Claude lane test: boot freshclaude, create pane; change permission mode via the pane's settings gear (existing kilroy test does `.selectOption('default')` at spec:1055-1061 — mirror it), change model via the model radio row if simple-list (or skip model: permission+the wire frame is the assertion core), send "settings probe". Assert via `waitForStdinFrame(stdinLog, f => f?.type === 'settings.update')` and that its index in `readStdinFrames(stdinLog)` is BEFORE the index of the `send` frame for that text, and that the settings.update frame carries `permissionMode: 'default'`. Also assert the `sdk.session.metadata` frame surfaced on the events log (FRESHELL_FAKE_EVENTS) with the applied model — proving the client-visible metadata echo.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium fresh-agent-control-rust -g "per-send settings"`

Expected: FAIL — codex lane: the recorded turns have identical start params (or fixture lacks the field; either is an intended failure: the fixture edit is prep, Step 3 covers both fixture and product side); claude lane: no `settings.update` frame exists in the audit log.

NOTE: these e2e runs need the release Rust binary (`cargo build --release -p freshell-server` — `ensureRustServerBuilt` handles it) and are LONG; run them with generous timeout. If the whole spec takes too long in this environment, the two new tests are gated by `-g "per-send settings"` and self-boot per lane; total 2 lane boots.

- [ ] **Step 3: Add the minimal production implementation**

All production behavior landed in Tasks 2-4. This step contains ONLY the fixture changes (recordTurns params capture; fake claude sidecar settings.update acceptance + metadata echo) and the checklist flip.

- [ ] **Step 4: Run the focused tests**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium fresh-agent-control-rust -g "per-send settings"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Confirm the fake fixture header comment (fixture protocol list at fake-claude-sdk-sidecar.mjs lines 14-25 region) documents the new accepted frame — keep fixture docs truthful.

- [ ] **Step 6: Run impacted-test verification**

Run the FULL spec (both lanes plus existing regression tests to prove no fixture regression): `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium fresh-agent-control-rust`

Expected: PASS. This is expensive; it is the compliance cost for touching shared fixtures. (If the full suite is impractical in the sandbox, scope to the kilroy describe + codex describe + claude describe blocks that use the touched fixtures, and record the exact command + exit in run-state.)

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
git commit -m "test(freshagent): e2e per-send settings proof on Rust lanes; close AGENT-12"
```

---

## Final gate (Stage 4 completion)

After Task 6 lands and the branch is green, the owner runs the full Darkforge QA gate on the then-HEAD commit (see run-state.md progress ledger): `darkforge qa --repo '/home/dan/code/freshell' --id 'z7j7'`. Acceptance: exit 0, or nonzero whose parsed failure identities are exactly the three baseline-listed `vite-config` `getNetworkHost` cases.

## Cross-cutting verification of the acceptance criteria

- "Changing effort/model for a send measurably alters that turn, provider-level assertion": codex crate test asserts turn/start params change; claude crate test asserts the settings.update frame preceding the send; opencode test asserts the POST body changes; e2e repeats both wire protocols.
- "UI honestly reflects scope": settingsScope-driven hints (per-send vs create-only) are unit-tested at both selection surfaces.
- "No silent drop path remains": claude/codex/opencode parse→apply covered by crate tests; invalid values produce loud error frames (claude INVALID_EFFORT/INVALID_PERMISSION_MODE; codex INVALID_EFFORT pre-existing path now also guards per-send); opencode's nonexistent knobs are advertised `unsupported` AND logged when present.
