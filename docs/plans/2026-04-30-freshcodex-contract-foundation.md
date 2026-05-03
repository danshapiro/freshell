# Freshcodex Contract Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Freshcodex as a first-class rich client on the shared fresh-agent foundation, with strict shared contracts, typed Codex normalization, interactive Codex actions, scalable transcript/diff UX, and full regression coverage.

**Architecture:** Keep `fresh-agent` as the shared product domain, but make the normalized contract real instead of implicit: every snapshot, turn page, turn body, transcript item, action response, and provider extension crosses server/client boundaries through shared Zod schemas. Freshcodex uses the official Codex app-server as its source of truth for thread lifecycle, turn lifecycle, fork, interrupt, approvals, questions, review/diff items, token usage, worktrees, and child threads; the client consumes only typed fresh-agent data and never reaches into Claude session state. Freshclaude remains supported through the existing adapter, but this plan optimizes implementation order and tests for Freshcodex correctness.

**Tech Stack:** TypeScript, Zod, React 18, Redux Toolkit, Express, WebSocket JSON-RPC, Codex app-server, existing read-model scheduler, react-window, Vitest, Testing Library, Playwright browser e2e.

---

## Current State

The implementation workspace is `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation`, based on `a0a2d18d` (`docs: plan freshcodex contract foundation`) on top of `23fe41aa` (`Surface Codex shared-shell metadata`). It already contains the first fresh-agent platform cutover:

- `kind: 'fresh-agent'` pane content with `sessionType` separate from runtime `provider`.
- Claude and Codex runtime adapters under `server/fresh-agent/adapters/*`.
- Fresh-agent REST routes and WebSocket messages.
- A shared FreshAgent shell that can render Freshclaude and Freshcodex snapshots.
- Basic Codex rich snapshot metadata for diffs, worktrees, child threads, review, fork lineage, and token totals.
- Regression coverage for the initial cutover and the last nonconvergence closure pass.

The branch is behind `origin/main` by commits that touch exactly the areas this project depends on: agent-chat auto-title, mobile keyboard/touch behavior, stale pane hydration, two-browser reconnect recovery, and Codex app-server startup/init hardening. Those changes must be merged into this worktree before contract work so the implementation does not reintroduce known fixed bugs.

## Protocol Facts To Preserve

These facts come from the official Codex app-server README and must be verified against the locally installed Codex schema before implementation:

- Codex app-server supports generating version-specific TypeScript or JSON Schema with `codex app-server generate-ts --out DIR` and `codex app-server generate-json-schema --out DIR`.
- The JSON-RPC wire format intentionally omits the `"jsonrpc": "2.0"` header. Freshell's Codex app-server client must not emit that field unless the generated local schema proves the local version requires it.
- App-server initialization is a two-step handshake: request `initialize`, validate the result, then emit an `initialized` notification on the same connection before sending non-initialize requests.
- The current documented `initialize` result includes `userAgent`, `codexHome`, `platformFamily`, and `platformOs`.
- Supported transports include `stdio://`, websocket, unix socket, and off; the README calls websocket experimental/unsupported for production. Freshcodex production runtime should use stdio unless local generated docs prove that is no longer supported.
- Thread lifecycle primitives include `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, and `thread/turns/list`.
- User input starts a turn through `turn/start`; interruption uses `turn/interrupt`.
- App-server streams `turn/*`, `item/*`, token, status, approval, and tool/request events over JSON-RPC.
- Approval flows can arrive as server-initiated JSON-RPC requests. Freshell must retain their request ids and answer on the same app-server connection.
- Current documented item variants include user messages, hook prompts, agent messages, plans, reasoning, command executions, file changes, MCP tool calls, collaboration tool calls, web searches, image views, image generations, entered review mode, exited review mode, context compaction, deprecated compacted markers, and dynamic tool calls.
- Current documented server-request variants include command approvals, file-change approvals, permission-profile approvals, request-user-input prompts, MCP elicitations, and dynamic tool calls; `serverRequest/resolved` clears any pending UI state.
- `thread/turns/list` is experimental and supports cursor pagination, `nextCursor`, and `backwardsCursor`; local generated schemas decide exact field names such as `sortDirection`.
- Local schema check for `codex-cli 0.128.0` confirms JSON-RPC request ids are `string | integer`, `thread/read` returns `{ thread }`, `thread/read` accepts `includeTurns` but no `revision`, `thread/turns/list` returns `{ data, nextCursor, backwardsCursor }`, `thread/turns/list` accepts `cursor`, `limit`, and `sortDirection` but no `revision` or `includeBodies`, `turn/start` returns `{ turn }`, `turn/interrupt` requires both `threadId` and `turnId`, `thread/fork` returns `{ thread, cwd, model, modelProvider, approvalPolicy, approvalsReviewer, sandbox, ... }`, and there is no `thread/turn/read` method. Any per-turn body API in Freshell must therefore be an internal facade over `thread/turns/list`, `thread/read includeTurns: true`, or a server-side page/body cache until Codex exposes a direct turn-read request.

Source checked while writing this plan: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

## User-Visible End State

- The Freshcodex pane picker entry creates a `fresh-agent` pane with `sessionType: 'freshcodex'` and `provider: 'codex'`.
- Creating, resuming, and refreshing Freshcodex uses Codex app-server thread APIs only over the stable stdio app-server transport. No terminal scraping, no websocket production dependency, and no Claude state path.
- Freshcodex honors Codex runtime settings at create and turn time, including model, sandbox, permission/approval policy, and effort where supported by the generated local app-server schema.
- Freshcodex can send text and image inputs, interrupt an active turn, fork a thread into a new freshcodex pane, answer Codex command/file/permission approval requests, answer request-user-input prompts, answer MCP elicitations, and reject unsupported dynamic tool calls with a clear response that unblocks the turn.
- Unsupported Codex capabilities are disabled with clear labels. Do not silently fall back to raw terminal mode.
- The Freshcodex transcript renders normalized item cards for user messages, hook prompts, agent messages, plans, reasoning, command executions, file changes/diffs, MCP tool calls, collaboration calls, web searches, image views, image generations, review mode, context compaction, dynamic tool calls, errors, and tool/request prompts.
- Long transcripts page through `thread/turns/list`, hydrate bodies on demand, and render through virtualization so mobile remains responsive.
- Diff/review/worktree/fork metadata is usable, not just listed. Users can inspect file-change diffs, see review status/output, see fork lineage, see child threads, and identify worktree branch/path.
- Freshcodex has typed load/create/action errors that point to the failing boundary: app-server unavailable, app-server protocol invalid, fresh-agent contract invalid, stale revision, unsupported capability, unauthorized session, or lost session.
- Freshclaude still works after the refactor. Hidden `kilroy` still resolves as Claude-backed. `freshopencode` remains disabled and unimplemented.
- Existing Freshclaude saved layouts, settings, remote tab snapshots, and history stay readable. Do not clear browser storage to force migration.

## Contracts And Invariants

- Durable read-model contracts live in `shared/fresh-agent-contract.ts`; pane lifecycle state stays in `src/store/paneTypes.ts` and must not leak into durable snapshot schemas.
- `provider` means runtime family: `claude`, `codex`, or later `opencode`.
- `sessionType` means user-facing identity: `freshclaude`, `freshcodex`, `kilroy`, or disabled `freshopencode`.
- All fresh-agent server adapter outputs parse before leaving `server/fresh-agent/runtime-manager.ts`.
- All fresh-agent REST payloads parse again in `src/lib/api.ts` before UI state sees them.
- A snapshot, turn page, or turn body with an invalid contract is a controlled error, not partially rendered data.
- Fresh-agent `revision` is a Freshell normalized read-model revision, not a Codex app-server revision. For Codex, derive it from runtime-manager event ordering and stable thread metadata such as `thread.updatedAt`; preserve the app-server source version separately in `extensions.codex.sourceVersion`. Turn page and turn body requests compare against the Freshell normalized revision. Do not send nonexistent Codex `revision` fields to app-server requests.
- Codex app-server protocol schemas are owned by `server/coding-cli/codex-app-server/protocol.ts`, and must be cross-checked with `codex app-server generate-json-schema` during implementation.
- Codex app-server transport is owned by `server/coding-cli/codex-app-server/client.ts` plus focused transport helpers. The production Freshcodex runtime uses stdio JSONL; websocket remains only for legacy terminal launch behavior if still required outside Freshcodex and must not be the Freshcodex fallback.
- Codex JSON-RPC messages omit the `jsonrpc` property on the wire and emit `initialized` exactly once after successful `initialize`.
- Codex request ids must round-trip as `string | number`; never coerce server-initiated request ids to numbers before responding.
- Provider-specific detail is preserved under typed extension schemas, not ad-hoc `Record<string, unknown>` blobs in transcript items.
- Every app-server item/request type documented by the current local generated schema must either have a normalized UI representation or a clear supported-negative response path. Unknown future item types should fail contract validation until intentionally modeled. Do not add a catch-all transcript fallback without explicit approval.
- Async pane updates in `FreshAgentView` must use targeted `mergePaneContent` updates unless replacing an entire pane is intentional.
- Freshcodex tests must be able to render without `state.agentChat.sessions` or Claude restore helpers.
- Main-branch fixes for auto-title, mobile keyboard/touch target behavior, stale pane hydration, reconnect recovery, and app-server stdio/init hardening must survive the cutover.

## File Structure

### Create

- `shared/fresh-agent-contract.ts` - Zod schemas and exported types for snapshots, turn pages, turn bodies, items, provider extensions, action responses, and contract errors.
- `src/lib/fresh-agent-api-error.ts` - typed client error helper for contract parse failures and fresh-agent API errors.
- `server/coding-cli/codex-app-server/transport.ts` - stdio JSONL transport abstraction that owns app-server process stdin/stdout framing, close/error handling, and request/notification delivery.
- `src/components/fresh-agent/useFreshAgentThreadController.ts` - controller hook for create/attach/snapshot/action/pagination state.
- `src/components/fresh-agent/FreshAgentShell.tsx` - pure presentational shell for header, banners, transcript, composer, sidebar, and workspace panel.
- `src/components/fresh-agent/FreshAgentTranscriptVirtualList.tsx` - virtualized transcript list backed by turn summaries and hydrated bodies.
- `src/components/fresh-agent/FreshAgentWorkspacePanel.tsx` - typed worktree, child-thread, review, fork, and diff browser.
- `src/components/fresh-agent/FreshAgentItemCard.tsx` - normalized transcript item rendering.
- `src/components/fresh-agent/fresh-agent-policy.ts` - small runtime/session policy helpers for labels, action availability, and restore behavior.
- `test/fixtures/fresh-agent/codex/contract-fixtures.ts` - schema-validated Codex snapshot, turn page, turn body, event, approval, review, and fork fixtures.
- `test/fixtures/fresh-agent/claude/contract-fixtures.ts` - schema-validated Claude snapshot/page/body fixtures that preserve existing behavior.
- `test/unit/shared/fresh-agent-contract.test.ts`
- `test/unit/client/lib/api.fresh-agent-contract.test.ts`
- `test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx`
- `test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx`
- `test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`
- `test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx`
- `test/unit/server/fresh-agent/contract-boundary.test.ts`
- `test/unit/server/coding-cli/codex-app-server/transport.test.ts` - stdio JSONL transport, framing, request/notification delivery, and close/error behavior.

### Modify

- `shared/fresh-agent.ts`
- `shared/read-models.ts`
- `shared/ws-protocol.ts`
- `server/coding-cli/codex-app-server/protocol.ts`
- `server/coding-cli/codex-app-server/client.ts`
- `server/coding-cli/codex-app-server/runtime.ts`
- `server/coding-cli/codex-app-server/launch-planner.ts`
- `server/fresh-agent/runtime-adapter.ts`
- `server/fresh-agent/runtime-manager.ts`
- `server/fresh-agent/router.ts`
- `server/fresh-agent/adapters/claude/normalize.ts`
- `server/fresh-agent/adapters/claude/adapter.ts`
- `server/fresh-agent/adapters/codex/normalize.ts`
- `server/fresh-agent/adapters/codex/adapter.ts`
- `server/index.ts`
- `server/ws-handler.ts`
- `src/lib/api.ts`
- `src/lib/fresh-agent-ws.ts`
- `src/lib/fresh-agent-registry.ts`
- `src/store/freshAgentSlice.ts`
- `src/store/paneTypes.ts`
- `src/store/panesSlice.ts`
- `src/store/selectors/sidebarSelectors.ts`
- `src/lib/derivePaneTitle.ts`
- `src/lib/session-utils.ts`
- `src/components/fresh-agent/FreshAgentView.tsx`
- `src/components/fresh-agent/FreshAgentTranscript.tsx`
- `src/components/fresh-agent/FreshAgentComposer.tsx`
- `src/components/fresh-agent/FreshAgentDiffPanel.tsx`
- `src/components/fresh-agent/FreshAgentSidebar.tsx`
- `src/components/HistoryView.tsx`
- `src/components/panes/PaneContainer.tsx`
- `src/components/panes/PanePicker.tsx`
- `src/components/SettingsView.tsx`
- `src/hooks/useKeyboardInset.ts` if main merge introduces it
- `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
- `test/unit/server/coding-cli/codex-app-server/client.test.ts`
- `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
- `test/unit/server/fresh-agent/codex-normalize.test.ts`
- `test/unit/server/fresh-agent/codex-adapter.test.ts`
- `test/unit/server/fresh-agent/claude-normalize.test.ts`
- `test/unit/server/fresh-agent/claude-adapter.test.ts`
- `test/unit/server/fresh-agent/router.test.ts`
- `test/unit/server/fresh-agent/runtime-manager.test.ts`
- `test/unit/server/ws-handler-fresh-agent.test.ts`
- `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`
- `test/e2e-browser/specs/fresh-agent.spec.ts`
- `test/e2e-browser/specs/fresh-agent-mobile.spec.ts`
- `test/e2e-browser/perf/scenarios.ts`
- `docs/index.html`

### Preserve Unless Proven Dead

- `src/components/agent-chat/*`
- `src/store/agentChatSlice.ts`
- `src/lib/sdk-message-handler.ts`
- Legacy `sdk.*` WebSocket protocol

These still back Freshclaude behavior and current regression coverage. This plan removes Freshcodex dependence on them, not the entire legacy Claude path.

## Strategy Gate

The most important decision is to make the shared contract the center of the architecture before adding more UI. The current branch already has the right shape, but the contract is informal: Codex normalizers pass raw-ish records, client API returns `any`, and `FreshAgentView` infers provider behavior directly. Adding more Freshcodex features on top of that would make every later diff/review/fork/mobile improvement fragile.

The correct route is:

- Merge current main first because main contains fixes in exactly the cutover surfaces.
- Lock shared Zod contracts for all read-model payloads and action responses.
- Enforce those contracts on both server and client boundaries.
- Replace Freshcodex's app-server dependency on the experimental websocket transport with stdio JSONL, then normalize Codex app-server data fully using app-server generated schemas to avoid guessing method shapes.
- Model every currently documented app-server item and server-request surface before choosing to fail unknown future variants.
- Split controller from presentation only after contract fixtures exist.
- Implement Freshcodex actions through app-server thread/turn primitives and explicit server-request response handling.
- Finish transcript virtualization and workspace UX so the foundation is good enough for long-term feature growth, not just a thin demo.

No user decision is required. The plan makes one deliberate scope choice: `freshopencode` stays disabled and unimplemented, while the shared contract remains provider-extensible.

### Task 1: Merge Current Main Without Regressing Fresh-Agent Work

**Files:**
- Modify as needed by merge: `server/ws-handler.ts`
- Modify as needed by merge: `shared/ws-protocol.ts`
- Modify as needed by merge: `server/coding-cli/codex-app-server/protocol.ts`
- Modify as needed by merge: `server/coding-cli/codex-app-server/runtime.ts`
- Modify as needed by merge: `src/components/agent-chat/AgentChatView.tsx`
- Modify as needed by merge: `src/components/agent-chat/AgentChatSettings.tsx`
- Modify as needed by merge: `src/components/agent-chat/ChatComposer.tsx`
- Modify as needed by merge: `src/components/agent-chat/PermissionBanner.tsx`
- Modify as needed by merge: `src/components/agent-chat/QuestionBanner.tsx`
- Modify as needed by merge: `src/components/agent-chat/ToolStrip.tsx`
- Modify as needed by merge: `src/store/panesSlice.ts`
- Modify as needed by merge: `src/lib/ws-client.ts`
- Modify as needed by merge: `server/title-utils.ts`
- Create or preserve from main: `shared/title-utils.ts`
- Create or preserve from main: `src/hooks/useKeyboardInset.ts`
- Test: `test/unit/client/components/agent-chat/AgentChatView.auto-title.test.tsx`
- Test: `test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx`
- Test: `test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx`
- Test: `test/unit/client/hooks/useKeyboardInset.test.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/server/ws-handler-sdk.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/client.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

- [ ] **Step 1: Identify the merge conflict surface and baseline expectations**

Run:

```bash
git status --short --branch
git log --oneline --left-right --cherry-pick HEAD...origin/main --max-count=30
npm run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/server/ws-handler-sdk.test.ts
```

Expected: branch is clean; logs show main commits that must be merged; some tests may not exist or may fail before the merge because they live only on `origin/main`.

- [ ] **Step 2: Merge `origin/main` into the worktree branch**

Run:

```bash
git fetch origin
git merge origin/main
```

Expected: conflicts are possible in `server/ws-handler.ts`, `shared/ws-protocol.ts`, `src/store/panesSlice.ts`, `src/components/agent-chat/AgentChatView.tsx`, and Codex app-server files.

- [ ] **Step 3: Resolve conflicts by preserving both main fixes and fresh-agent behavior**

Conflict resolution rules:

```ts
// Keep main's stale-hydration protection in reducers.
// Keep fresh-agent pane normalization and legacy agent-chat migration.
// Keep main's mobile keyboard/touch helpers in agent-chat components.
// Later tasks port those helpers into fresh-agent components.
// Keep main's Codex app-server stdout/stderr drain and initialize contract fixes.
// Keep fresh-agent runtime manager and routes.
```

Do not delete fresh-agent tests to make the merge pass. Do not revert main's production static routing, reconnect, stale hydration, or app-server fixes.

- [ ] **Step 4: Verify the merge**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/server/ws-handler-sdk.test.ts \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Expected: all pass. If main introduced new tests, include their exact paths from the merge output.

- [ ] **Step 5: Refactor and verify**

Tighten only conflict-resolved code. Do not start the freshcodex contract work in this commit.

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  server/ws-handler.ts shared/ws-protocol.ts \
  server/coding-cli/codex-app-server/protocol.ts \
  server/coding-cli/codex-app-server/runtime.ts \
  src/store/panesSlice.ts src/lib/ws-client.ts \
  src/components/agent-chat/AgentChatView.tsx \
  src/components/agent-chat/AgentChatSettings.tsx \
  src/components/agent-chat/ChatComposer.tsx \
  src/components/agent-chat/PermissionBanner.tsx \
  src/components/agent-chat/QuestionBanner.tsx \
  src/components/agent-chat/ToolStrip.tsx \
  src/hooks/useKeyboardInset.ts shared/title-utils.ts server/title-utils.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/server/ws-handler-sdk.test.ts
git commit -m "Merge main into freshcodex contract foundation"
```

### Task 2: Define The Shared Fresh-Agent Contract

**Files:**
- Create: `shared/fresh-agent-contract.ts`
- Modify: `shared/fresh-agent.ts`
- Modify: `shared/read-models.ts`
- Test: `test/unit/shared/fresh-agent-contract.test.ts`
- Test: `test/fixtures/fresh-agent/codex/contract-fixtures.ts`
- Test: `test/fixtures/fresh-agent/claude/contract-fixtures.ts`

- [ ] **Step 1: Write failing contract tests**

Create tests that require:

```ts
expect(FreshAgentThreadSnapshotSchema.parse(validCodexSnapshot)).toMatchObject({
  provider: 'codex',
  threadId: 'thread-codex-1',
  status: 'idle',
})

expect(() => FreshAgentThreadSnapshotSchema.parse({
  provider: 'codex',
  threadId: 'thread-codex-1',
  revision: 1,
  status: 'creating',
})).toThrow(/status/i)

expect(() => FreshAgentTranscriptItemSchema.parse({
  id: 'bad-item',
  kind: 'raw',
  payload: {},
})).toThrow(/kind/i)
```

Also assert that `FreshAgentTurnPageSchema`, `FreshAgentTurnBodySchema`, `FreshAgentActionResultSchema`, `FreshAgentCodexExtensionSchema`, and `FreshAgentClaudeExtensionSchema` parse the new fixtures.

Include explicit fixtures for every Codex transcript/request surface the user-visible end state names:

```ts
expect(FreshAgentTranscriptItemSchema.parse({
  id: 'compact-1',
  kind: 'context_compaction',
  status: 'completed',
  summary: 'Compacted prior context',
})).toMatchObject({ kind: 'context_compaction' })

expect(FreshAgentTranscriptItemSchema.parse({
  id: 'dyn-1',
  kind: 'dynamic_tool',
  name: 'unsupported-local-tool',
  status: 'declined',
  reason: 'Dynamic tool calls are not supported by Freshell yet.',
})).toMatchObject({ kind: 'dynamic_tool', status: 'declined' })

expect(FreshAgentQuestionRequestSchema.parse({
  requestId: 'server-request-1',
  kind: 'mcp_elicitation',
  title: 'Confirm MCP input',
  prompt: 'Choose a value',
  fields: [],
})).toMatchObject({ kind: 'mcp_elicitation' })
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/fresh-agent-contract.test.ts
```

Expected: FAIL because `shared/fresh-agent-contract.ts` does not exist.

- [ ] **Step 3: Implement the schemas**

Create `shared/fresh-agent-contract.ts` with this shape:

```ts
import { z } from 'zod'

export const FreshAgentRuntimeProviderSchema = z.enum(['claude', 'codex', 'opencode'])
export const FreshAgentThreadStatusSchema = z.enum(['idle', 'running', 'compacting', 'exited', 'lost', 'error'])
export const FreshAgentRoleSchema = z.enum(['user', 'assistant', 'system'])
export const FreshAgentTurnSourceSchema = z.enum(['durable', 'live'])

const NonEmptyString = z.string().min(1)
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValue),
  z.record(z.string(), JsonValue),
]))

export const FreshAgentTextItemSchema = z.object({
  id: NonEmptyString,
  kind: z.literal('text'),
  text: z.string(),
})

export const FreshAgentReasoningItemSchema = z.object({
  id: NonEmptyString,
  kind: z.literal('reasoning'),
  summary: z.array(z.string()).default([]),
  text: z.string().optional(),
})

export const FreshAgentCommandItemSchema = z.object({
  id: NonEmptyString,
  kind: z.literal('command'),
  command: z.string(),
  cwd: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'declined']),
  output: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
})

export const FreshAgentFileChangeItemSchema = z.object({
  id: NonEmptyString,
  kind: z.literal('file_change'),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'declined']),
  changes: z.array(z.object({
    path: NonEmptyString,
    changeKind: z.enum(['add', 'modify', 'delete', 'rename', 'unknown']),
    diff: z.string().optional(),
  })),
})

export const FreshAgentToolItemSchema = z.object({
  id: NonEmptyString,
  kind: z.literal('tool'),
  name: NonEmptyString,
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  input: z.record(z.string(), JsonValue).optional(),
  result: JsonValue.optional(),
  error: z.string().optional(),
})

export const FreshAgentTranscriptItemSchema = z.discriminatedUnion('kind', [
  FreshAgentTextItemSchema,
  FreshAgentReasoningItemSchema,
  FreshAgentCommandItemSchema,
  FreshAgentFileChangeItemSchema,
  FreshAgentToolItemSchema,
  z.object({ id: NonEmptyString, kind: z.literal('plan'), text: z.string(), status: z.enum(['pending', 'running', 'completed']).optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('review'), phase: z.enum(['entered', 'exited']), label: z.string().optional(), text: z.string().optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('web_search'), query: z.string(), status: z.enum(['pending', 'running', 'completed', 'failed']).optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('hook_prompt'), fragments: z.array(z.string()).default([]), text: z.string().optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('image'), path: z.string().optional(), url: z.string().optional(), alt: z.string().optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('image_generation'), prompt: z.string().optional(), status: z.enum(['pending', 'running', 'completed', 'failed']).optional(), imageUrl: z.string().optional(), path: z.string().optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('collaboration'), tool: NonEmptyString, status: z.enum(['pending', 'running', 'completed', 'failed']), senderThreadId: z.string().optional(), receiverThreadId: z.string().optional(), newThreadId: z.string().optional(), prompt: z.string().optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('context_compaction'), status: z.enum(['pending', 'running', 'completed', 'failed', 'deprecated']), summary: z.string().optional(), beforeTokens: z.number().int().nonnegative().optional(), afterTokens: z.number().int().nonnegative().optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('dynamic_tool'), name: NonEmptyString, status: z.enum(['pending', 'running', 'completed', 'failed', 'declined']), input: z.record(z.string(), JsonValue).optional(), result: JsonValue.optional(), reason: z.string().optional(), error: z.string().optional() }),
  z.object({ id: NonEmptyString, kind: z.literal('request_prompt'), requestId: NonEmptyString, requestKind: z.enum(['approval', 'question', 'mcp_elicitation', 'dynamic_tool', 'auth_refresh']), title: z.string().optional(), prompt: z.string().optional(), status: z.enum(['pending', 'resolved', 'declined']) }),
  z.object({ id: NonEmptyString, kind: z.literal('error'), message: z.string(), code: z.string().optional() }),
])

export const FreshAgentTurnBodySchema = z.object({
  provider: FreshAgentRuntimeProviderSchema,
  threadId: NonEmptyString,
  turnId: NonEmptyString,
  revision: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative().optional(),
  source: FreshAgentTurnSourceSchema.optional(),
  role: FreshAgentRoleSchema,
  summary: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  items: z.array(FreshAgentTranscriptItemSchema),
})

export const FreshAgentTurnSummarySchema = FreshAgentTurnBodySchema.omit({ items: true }).extend({
  itemCount: z.number().int().nonnegative().default(0),
  preview: z.string().optional(),
  body: FreshAgentTurnBodySchema.optional(),
})

export const FreshAgentTurnPageSchema = z.object({
  provider: FreshAgentRuntimeProviderSchema,
  threadId: NonEmptyString,
  revision: z.number().int().nonnegative(),
  turns: z.array(FreshAgentTurnSummarySchema),
  nextCursor: z.string().nullable(),
  backwardsCursor: z.string().nullable().optional(),
})

export const FreshAgentCapabilitiesSchema = z.object({
  send: z.boolean(),
  interrupt: z.boolean(),
  approvals: z.boolean(),
  questions: z.boolean(),
  fork: z.boolean(),
  worktrees: z.boolean(),
  diffs: z.boolean(),
  childThreads: z.boolean(),
  turnPaging: z.boolean(),
  turnBodies: z.boolean(),
})

export const FreshAgentThreadSnapshotSchema = z.object({
  provider: FreshAgentRuntimeProviderSchema,
  threadId: NonEmptyString,
  revision: z.number().int().nonnegative(),
  status: FreshAgentThreadStatusSchema,
  summary: z.string().optional(),
  capabilities: FreshAgentCapabilitiesSchema,
  tokenUsage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative(),
    contextTokens: z.number().int().nonnegative().optional(),
    compactPercent: z.number().nonnegative().optional(),
    compactThresholdTokens: z.number().int().nonnegative().optional(),
  }).optional(),
  turns: z.array(FreshAgentTurnBodySchema).default([]),
  pendingApprovals: z.array(FreshAgentApprovalRequestSchema).default([]),
  pendingQuestions: z.array(FreshAgentQuestionRequestSchema).default([]),
  worktrees: z.array(FreshAgentWorktreeRefSchema).default([]),
  diffs: z.array(FreshAgentDiffRefSchema).default([]),
  childThreads: z.array(FreshAgentChildThreadRefSchema).default([]),
  extensions: FreshAgentExtensionsSchema.default({}),
})
```

Define the referenced approval, question, worktree, diff, child-thread, Claude extension, Codex extension, and action-result schemas in the same file. Export inferred types for every schema. Keep provider extension schemas typed and narrow:

Define referenced schemas before any schema that uses them, or wrap recursive references in `z.lazy`, so module evaluation cannot hit a temporal-dead-zone `ReferenceError`.

```ts
export type FreshAgentThreadSnapshot = z.infer<typeof FreshAgentThreadSnapshotSchema>
export type FreshAgentTurnPage = z.infer<typeof FreshAgentTurnPageSchema>
export type FreshAgentTurnBody = z.infer<typeof FreshAgentTurnBodySchema>
export type FreshAgentTranscriptItem = z.infer<typeof FreshAgentTranscriptItemSchema>
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/shared/fresh-agent-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Move any duplicate provider/session enum literals from `shared/fresh-agent.ts` into imports from `shared/fresh-agent-contract.ts` where that reduces duplication without creating circular imports.

Run:

```bash
npm run test:vitest -- test/unit/shared/fresh-agent-contract.test.ts test/unit/shared/fresh-agent-registry.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  shared/fresh-agent-contract.ts shared/fresh-agent.ts shared/read-models.ts \
  test/unit/shared/fresh-agent-contract.test.ts \
  test/fixtures/fresh-agent/codex/contract-fixtures.ts \
  test/fixtures/fresh-agent/claude/contract-fixtures.ts
git commit -m "Add strict fresh-agent read-model contracts"
```

### Task 3: Enforce Contracts At Server And Client Boundaries

**Files:**
- Modify: `server/fresh-agent/runtime-adapter.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `server/fresh-agent/router.ts`
- Modify: `server/fresh-agent/adapters/claude/normalize.ts`
- Modify: `server/fresh-agent/adapters/codex/normalize.ts`
- Modify: `src/lib/api.ts`
- Create: `src/lib/fresh-agent-api-error.ts`
- Test: `test/unit/server/fresh-agent/contract-boundary.test.ts`
- Test: `test/unit/server/fresh-agent/router.test.ts`
- Test: `test/unit/client/lib/api.fresh-agent-contract.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Add tests for these cases:

```ts
it('rejects invalid adapter snapshots with a clear contract error', async () => {
  const manager = new FreshAgentRuntimeManager({ registry: registryReturningInvalidSnapshot })
  await expect(manager.getSnapshot({ provider: 'codex', threadId: 'thread-1' }))
    .rejects.toMatchObject({ code: 'FRESH_AGENT_CONTRACT_INVALID' })
})

it('returns 502 when adapter output violates the fresh-agent contract', async () => {
  const response = await request(app).get('/api/fresh-agent/threads/codex/thread-1')
  expect(response.status).toBe(502)
  expect(response.body.code).toBe('FRESH_AGENT_CONTRACT_INVALID')
})

it('surfaces a controlled client load error for invalid snapshot payloads', async () => {
  mockFetchJson({ provider: 'codex', status: 'creating' })
  await expect(getFreshAgentThreadSnapshot('codex', 'thread-1'))
    .rejects.toMatchObject({ code: 'FRESH_AGENT_CONTRACT_INVALID' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/fresh-agent/contract-boundary.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/lib/api.fresh-agent-contract.test.ts
```

Expected: FAIL because boundary parsing is not implemented and client helpers return `any`.

- [ ] **Step 3: Implement boundary parsing**

In `server/fresh-agent/runtime-adapter.ts`, replace `unknown` read-model returns:

```ts
import type {
  FreshAgentThreadSnapshot,
  FreshAgentTurnBody,
  FreshAgentTurnPage,
} from '../../shared/fresh-agent-contract.js'

getSnapshot?(thread: FreshAgentThreadLocator, revision?: number): Promise<FreshAgentThreadSnapshot>
getTurnPage?(thread: FreshAgentThreadLocator, query: FreshAgentTurnPageQuery): Promise<FreshAgentTurnPage>
getTurnBody?(thread: FreshAgentThreadLocator & { turnId: string }, revision: number): Promise<FreshAgentTurnBody>
```

In `runtime-manager.ts`, add:

```ts
export class FreshAgentContractValidationError extends Error {
  readonly code = 'FRESH_AGENT_CONTRACT_INVALID' as const
  constructor(readonly surface: string, readonly issues: unknown) {
    super(`Fresh-agent ${surface} violated the shared contract`)
  }
}

function parseSnapshot(value: unknown): FreshAgentThreadSnapshot {
  const parsed = FreshAgentThreadSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new FreshAgentContractValidationError('snapshot', parsed.error.issues)
  return parsed.data
}
```

Parse snapshot, page, body, fork/action responses before returning them.

In `router.ts`, map `FreshAgentContractValidationError` to HTTP 502:

```ts
return res.status(502).json({
  error: error.message,
  code: error.code,
  details: error.issues,
})
```

In `src/lib/api.ts`, parse fresh-agent helpers with the schemas and throw `FreshAgentApiPayloadError` from `src/lib/fresh-agent-api-error.ts` when parsing fails.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/fresh-agent/contract-boundary.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/lib/api.fresh-agent-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Remove duplicate local `FreshAgentSnapshot` types from client code only after Task 6 has shell/controller types in place. For now, ensure `api.ts` returns the exported contract types:

```ts
export async function getFreshAgentThreadSnapshot(...): Promise<FreshAgentThreadSnapshot>
export async function getFreshAgentTurnPage(...): Promise<FreshAgentTurnPage>
export async function getFreshAgentTurnBody(...): Promise<FreshAgentTurnBody>
```

Run:

```bash
npm run test:vitest -- \
  test/unit/server/fresh-agent/contract-boundary.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/lib/api.fresh-agent-contract.test.ts \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  server/fresh-agent/runtime-adapter.ts server/fresh-agent/runtime-manager.ts \
  server/fresh-agent/router.ts server/fresh-agent/adapters/claude/normalize.ts \
  server/fresh-agent/adapters/codex/normalize.ts src/lib/api.ts \
  src/lib/fresh-agent-api-error.ts \
  test/unit/server/fresh-agent/contract-boundary.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/lib/api.fresh-agent-contract.test.ts
git commit -m "Validate fresh-agent payloads at runtime boundaries"
```

### Task 4: Bring Codex App-Server Protocol Support Up To Freshcodex Needs

**Files:**
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
- Modify: `server/coding-cli/codex-app-server/client.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
- Create: `server/coding-cli/codex-app-server/transport.ts`
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
- Test: `test/unit/server/coding-cli/codex-app-server/transport.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/client.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

- [ ] **Step 1: Generate local app-server schema and write failing protocol tests**

Run this inspection command before editing code:

```bash
rm -rf /tmp/freshell-codex-app-server-schema
codex app-server generate-json-schema --out /tmp/freshell-codex-app-server-schema
find /tmp/freshell-codex-app-server-schema -maxdepth 3 -type f | sort | rg 'JSONRPC|Initialize|Thread|Turn|Approval|Request|Item|Fork|Interrupt|ServerRequest'
```

Use the generated schema to verify exact parameter and response names for `initialize`, `initialized`, `thread/start`, `thread/read`, `thread/turns/list`, `turn/start`, `turn/interrupt`, `thread/fork`, server notifications, approval server requests, and user-input server requests. The current local schema uses `thread/read { includeTurns?: boolean }`, `thread/turns/list { cursor?, limit?, sortDirection? }`, `thread/turns/list -> { data, nextCursor, backwardsCursor }`, `turn/start -> { turn }`, `turn/interrupt { threadId, turnId }`, `thread/fork -> { thread, ...metadata }`, and has no `thread/turn/read`; tests must encode those facts so a future implementation does not accidentally keep the stale API.

Add transport tests requiring stdio JSONL framing:

```ts
const transport = new CodexStdioJsonlTransport(fakeChildProcess)
await transport.send({ id: 1, method: 'initialize', params: initializeParams })
expect(fakeChild.stdinLines).toEqual([
  JSON.stringify({ id: 1, method: 'initialize', params: initializeParams }),
])
fakeChild.stdout.push(JSON.stringify({ id: 1, result: initializeResponse }) + '\n')
expect(await transport.nextMessage()).toEqual({ id: 1, result: initializeResponse })
```

Then add client/runtime tests requiring:

```ts
await expect(client.initialize()).resolves.toMatchObject({
  userAgent: expect.any(String),
  codexHome: expect.any(String),
  platformFamily: expect.any(String),
  platformOs: expect.any(String),
})
expect(fakeTransport.sent).toContainEqual({ method: 'initialized' })

await expect(client.readThread({ threadId: 'thread-1', includeTurns: true }))
  .resolves.toMatchObject({ thread: { id: 'thread-1' } })

await expect(client.listThreadTurns({ threadId: 'thread-1', limit: 25, sortDirection: 'desc' }))
  .resolves.toMatchObject({ data: expect.any(Array), nextCursor: null })

await expect(client.startTurn({
  threadId: 'thread-1',
  input: [{ type: 'text', text: 'Implement this' }],
})).resolves.toMatchObject({ turn: { id: expect.any(String) } })

await expect(client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' })).resolves.toEqual({})

await expect(client.forkThread({ threadId: 'thread-1', excludeTurns: true }))
  .resolves.toMatchObject({ thread: { id: expect.any(String) } })

await expect(runtime.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'Hello' }] }))
  .resolves.toMatchObject({ turn: { id: expect.any(String) } })

expect('readThreadTurn' in client).toBe(false) // no public method; direct turn read is not in the generated schema
```

Add server-request tests in `client.test.ts`:

```ts
it('surfaces server-initiated approval requests and responds on the same JSON-RPC id', async () => {
  const seen: unknown[] = []
  client.onServerRequest((request) => seen.push(request))
  await fakeServer.sendRequest({ id: 'approval-99', method: 'item/commandExecution/requestApproval', params: approvalParams })
  await client.respondToServerRequest('approval-99', { decision: { type: 'accept' } })
  expect(fakeServer.responses).toContainEqual({ id: 'approval-99', result: { decision: { type: 'accept' } } })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/transport.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: FAIL because the client/runtime still use WebSocket, emit `"jsonrpc": "2.0"`, do not send `initialized`, parse the old initialize result, expose stale turn-read behavior, and lack turn, fork, interrupt, and server-request response methods.

- [ ] **Step 3: Implement app-server protocol methods**

Update `protocol.ts` with schema names matching the generated app-server schema. The implementation must include, at minimum:

```ts
export const CodexRequestIdSchema = z.union([z.string().min(1), z.number().int()])

export const CodexInitializeResultSchema = z.object({
  userAgent: z.string().min(1),
  codexHome: z.string().min(1),
  platformFamily: z.string().min(1),
  platformOs: z.string().min(1),
})

export const CodexThreadReadParamsSchema = z.object({
  threadId: z.string().min(1),
  includeTurns: z.boolean().optional(),
})

export const CodexThreadTurnsListParamsSchema = z.object({
  threadId: z.string().min(1),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().nonnegative().optional(),
  sortDirection: z.enum(['asc', 'desc']).nullable().optional(),
})

export const CodexThreadTurnsListResultSchema = z.object({
  data: z.array(CodexTurnSchema),
  nextCursor: z.string().nullable().optional(),
  backwardsCursor: z.string().nullable().optional(),
})

export const CodexTurnInputItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), url: z.string().url() }),
  z.object({ type: z.literal('localImage'), path: z.string().min(1) }),
])

export const CodexTurnStartParamsSchema = z.object({
  threadId: z.string().min(1),
  input: z.array(CodexTurnInputItemSchema).min(1),
  cwd: z.string().optional(),
  model: z.string().optional(),
  sandboxPolicy: CodexSandboxPolicySchema.nullable().optional(),
  approvalPolicy: CodexApprovalPolicySchema.nullable().optional(),
  effort: CodexReasoningEffortSchema.nullable().optional(),
}).passthrough()

export const CodexThreadForkParamsSchema = z.object({
  threadId: z.string().min(1),
  ephemeral: z.boolean().optional(),
  excludeTurns: z.boolean().optional(),
}).passthrough()
```

Use generated schema field names. Do not guess against tests. Delete the stale `CodexThreadTurnRead*` schemas unless a future generated schema actually contains a direct turn-read client request.

Model the response schemas with the generated shapes, not Freshell convenience shapes:

```ts
export const CodexTurnStartResultSchema = z.object({
  turn: CodexTurnSchema,
})

export const CodexTurnInterruptParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
})

export const CodexTurnInterruptResultSchema = z.object({}).passthrough()

export const CodexThreadForkResultSchema = z.object({
  thread: CodexThreadSchema,
  cwd: z.string().min(1),
  model: z.string().min(1),
  modelProvider: z.string().min(1),
}).passthrough()
```

Create `transport.ts` as the only stdio JSONL framing owner:

```ts
export type CodexRpcMessage = {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export class CodexStdioJsonlTransport {
  send(message: CodexRpcMessage): Promise<void>
  onMessage(listener: (message: CodexRpcMessage) => void): () => void
  close(): Promise<void>
}
```

It should split stdout on newlines, parse one JSON message per line, reject malformed app-server output with a clear transport error, and never add a `jsonrpc` property.

Update `client.ts`:

```ts
type CodexRequestId = string | number
type ServerRequest = { id: CodexRequestId; method: string; params: unknown }

onNotification(listener: (notification: { method: string; params?: unknown }) => void): () => void
onServerRequest(listener: (request: ServerRequest) => void): () => void
respondToServerRequest(id: CodexRequestId, result: unknown): Promise<void>
readThread(params: CodexThreadReadParams): Promise<CodexThreadReadResult>
listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResult>
startTurn(params: CodexTurnStartParams): Promise<CodexTurnStartResult>
interruptTurn(params: CodexTurnInterruptParams): Promise<CodexTurnInterruptResult>
forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResult>
```

Update message handling so app-server requests with `id` and `method` are not ignored, and so notifications without `id` reach subscribers. Keep request timeout behavior for client-initiated calls. After a successful `initialize`, send exactly one `initialized` notification on the same transport before non-initialize requests.

Update `runtime.ts` to spawn:

```ts
spawn(command, [...commandArgs, 'app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
```

Proxy the new methods after `ensureReady()`. Keep WebSocket launch-planner behavior only outside Freshcodex if another code path still requires it; Freshcodex runtime creation must not return or depend on `wsUrl`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/transport.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Keep `client.ts` as the only JSON-RPC envelope owner. `runtime.ts` should remain a thin lifecycle/proxy layer.

Run:

```bash
npm run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/transport.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/integration/server/codex-session-flow.test.ts
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  server/coding-cli/codex-app-server/protocol.ts \
  server/coding-cli/codex-app-server/transport.ts \
  server/coding-cli/codex-app-server/client.ts \
  server/coding-cli/codex-app-server/runtime.ts \
  server/coding-cli/codex-app-server/launch-planner.ts \
  test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs \
  test/unit/server/coding-cli/codex-app-server/transport.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/integration/server/codex-session-flow.test.ts
git commit -m "Extend Codex app-server client for rich turns"
```

### Task 5: Fully Normalize Codex Snapshots, Pages, Bodies, And Events

**Files:**
- Modify: `server/fresh-agent/adapters/codex/normalize.ts`
- Modify: `server/fresh-agent/adapters/codex/adapter.ts`
- Modify: `server/fresh-agent/runtime-adapter.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/fresh-agent-ws.ts`
- Modify: `test/fixtures/fresh-agent/codex/contract-fixtures.ts`
- Test: `test/unit/server/fresh-agent/codex-normalize.test.ts`
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/runtime-manager.test.ts`
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts`

- [ ] **Step 1: Write failing normalization and event tests**

Require all documented Codex item variants to normalize into `FreshAgentTranscriptItemSchema` variants:

```ts
expect(normalizeCodexItem({ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Do it' }] }))
  .toEqual({ id: 'u1', kind: 'text', text: 'Do it' })

expect(normalizeCodexItem({ type: 'hookPrompt', id: 'h1', fragments: [{ text: 'Preflight' }] }))
  .toMatchObject({ id: 'h1', kind: 'hook_prompt' })

expect(normalizeCodexItem({ type: 'agentMessage', id: 'a1', text: 'Done' }))
  .toEqual({ id: 'a1', kind: 'text', text: 'Done' })

expect(normalizeCodexItem({ type: 'commandExecution', id: 'c1', command: 'npm test', status: 'completed', aggregatedOutput: 'ok' }))
  .toMatchObject({ id: 'c1', kind: 'command', command: 'npm test', status: 'completed', output: 'ok' })

expect(normalizeCodexItem({ type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'modify', diff: '@@' }] }))
  .toMatchObject({ id: 'f1', kind: 'file_change', changes: [{ path: 'src/a.ts', diff: '@@' }] })

expect(() => normalizeCodexItem({ type: 'newUnknownItem', id: 'u1' }))
  .toThrow(/unsupported Codex item/i)

expect(normalizeCodexItem({ type: 'contextCompaction', id: 'compact-1', status: 'completed', summary: 'Compacted' }))
  .toMatchObject({ id: 'compact-1', kind: 'context_compaction', status: 'completed' })

expect(normalizeCodexItem({ type: 'dynamicToolCall', id: 'dyn-1', name: 'tool-x', status: 'declined' }))
  .toMatchObject({ id: 'dyn-1', kind: 'dynamic_tool', status: 'declined' })

expect(normalizeCodexItem({ type: 'imageGeneration', id: 'img-gen-1', prompt: 'diagram', status: 'completed' }))
  .toMatchObject({ id: 'img-gen-1', kind: 'image_generation' })
```

Add table-driven coverage for every local generated `ThreadItem` type: `userMessage`, `hookPrompt`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`, `imageView`, `imageGeneration`, `enteredReviewMode`, `exitedReviewMode`, and `contextCompaction`.

Require adapter methods:

```ts
runtime.startTurn.mockResolvedValue({ turn: { id: 'turn-1' } })
await adapter.send?.('thread-1', { text: 'Ship it' })
expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
  threadId: 'thread-1',
  input: [{ type: 'text', text: 'Ship it' }],
}))

await adapter.interrupt?.('thread-1')
expect(runtime.interruptTurn).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-1' })

await expect(adapter.interrupt?.('thread-without-active-turn'))
  .rejects.toMatchObject({ code: 'FRESH_AGENT_NO_ACTIVE_TURN' })

runtime.forkThread.mockResolvedValue({ thread: { id: 'thread-fork-1' }, cwd: '/repo', model: 'fixture', modelProvider: 'fixture' })
await expect(adapter.fork?.('thread-1', { excludeTurns: true }))
  .resolves.toMatchObject({ sessionId: 'thread-fork-1', parentThreadId: 'thread-1' })

await expect(adapter.getTurnPage?.({ provider: 'codex', threadId: 'thread-new-1' }, { revision: 7, limit: 25, sortDirection: 'desc' }))
  .resolves.toMatchObject({ provider: 'codex', threadId: 'thread-new-1' })

await expect(adapter.getTurnBody?.({ provider: 'codex', threadId: 'thread-new-1', turnId: 'turn-1' }, 7))
  .resolves.toMatchObject({ provider: 'codex', threadId: 'thread-new-1', turnId: 'turn-1' })
expect(runtime.readThread).toHaveBeenCalledWith({ threadId: 'thread-new-1', includeTurns: true })
```

Require server-request approval mapping:

```ts
emitServerRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'npm test' })
expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.snapshot.invalidate' }))
expect(await adapter.getSnapshot?.({ provider: 'codex', threadId: 'thread-1' }))
  .toMatchObject({ pendingApprovals: [{ requestId: expect.stringContaining('cmd-1') }] })
```

Add table-driven server-request coverage for every local generated `ServerRequest` method. `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `item/permissions/requestApproval` become pending approvals; `item/tool/requestUserInput` and `mcpServer/elicitation/request` become pending questions; `item/tool/call` receives an explicit unsupported dynamic-tool response; `account/chatgptAuthTokens/refresh` receives an explicit unsupported auth-refresh response with a clear message; deprecated `applyPatchApproval` and `execCommandApproval` are mapped to legacy approval prompts only if generated schema still includes them. `serverRequest/resolved` must remove matching pending approval/question/request state.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/fresh-agent/codex-normalize.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/client/lib/fresh-agent-ws.test.ts
```

Expected: FAIL because Codex items are still raw-ish and actions are incomplete.

- [ ] **Step 3: Implement normalization and action adapter**

In `normalize.ts`, expose focused pure helpers:

```ts
export function normalizeCodexThreadStatus(raw: unknown): FreshAgentThreadStatus
export function normalizeCodexItem(raw: unknown): FreshAgentTranscriptItem
export function normalizeCodexTurnBody(input: { provider: 'codex'; threadId: string; revision: number; rawTurn: CodexThreadTurn }): FreshAgentTurnBody
export function normalizeCodexTurnPage(input: { threadId: string; revision: number; page: CodexThreadTurnsListResult }): FreshAgentTurnPage
export function normalizeCodexThreadSnapshot(input: ...): FreshAgentThreadSnapshot
```

Map statuses explicitly:

```ts
const CODEX_STATUS_MAP = new Map<string, FreshAgentThreadStatus>([
  ['idle', 'idle'],
  ['running', 'running'],
  ['busy', 'running'],
  ['compacting', 'compacting'],
  ['interrupted', 'idle'],
  ['failed', 'error'],
  ['completed', 'idle'],
  ['closed', 'exited'],
  ['notLoaded', 'idle'],
])
```

Throw a clear `UnsupportedCodexItemError` for item types not intentionally modeled. Normalize actual app-server shapes from the generated `Thread` / `Turn` / `ThreadItem` schemas:

```ts
export function normalizeCodexThreadSnapshot(input: {
  thread: CodexThread
  normalizedRevision: number
  pendingApprovals: PendingCodexApproval[]
  pendingQuestions: PendingCodexQuestion[]
}): FreshAgentThreadSnapshot

export function normalizeCodexTurnPage(input: {
  provider: 'codex'
  threadId: string
  revision: number
  page: CodexThreadTurnsListResult // { data, nextCursor, backwardsCursor }
}): FreshAgentTurnPage
```

Do not read `rawSnapshot.revision`, `rawSnapshot.turns`, or `page.turns`; those are stale assumptions from Freshell's provisional protocol. Use `raw.thread.turns` from `thread/read { includeTurns: true }` and `page.data` from `thread/turns/list`.

In `adapter.ts`, track per-thread ephemeral live state:

```ts
type CodexLiveThreadState = {
  pendingApprovals: Map<string, PendingCodexApproval>
  pendingQuestions: Map<string, PendingCodexQuestion>
  activeTurnId?: string
  latestRevision?: number
}
```

Implement `send`, `interrupt`, `fork`, `resolveApproval`, and `answerQuestion` using the app-server runtime/client methods from Task 4. `send` must store the active turn id from `turn/start -> { turn }`; `turn/started`, `turn/completed`, and runtime close/error notifications must keep `activeTurnId` current. `interrupt(sessionId)` remains the Fresh-agent API because the UI interrupts the active turn, but the Codex adapter must translate that to `turn/interrupt { threadId, turnId: activeTurnId }` and return a clear `FRESH_AGENT_NO_ACTIVE_TURN` action error if there is no active turn. `resolveApproval` and `answerQuestion` must respond to the stored JSON-RPC server request id, not invent a new RPC.

Convert `thread/fork -> { thread, ...metadata }` to the fresh-agent fork result at the adapter boundary:

```ts
const forked = await runtime.forkThread({ threadId: sessionId, excludeTurns: true })
return {
  sessionId: forked.thread.id,
  sessionType: 'freshcodex',
  runtimeProvider: 'codex',
  parentThreadId: sessionId,
  extensions: { codex: { fork: { parentThreadId: sessionId } } },
}
```

Implement `getTurnBody` as a fresh-agent compatibility facade, not a Codex RPC method:

```ts
async getTurnBody(thread, revision) {
  const currentRevision = getNormalizedRevisionFor(thread.threadId)
  if (revision !== currentRevision) throw new FreshAgentStaleThreadRevisionError(currentRevision)
  const raw = await runtime.readThread({ threadId: thread.threadId, includeTurns: true })
  const turn = raw.thread.turns.find((candidate) => candidate.id === thread.turnId)
  if (!turn) throw new FreshAgentTurnNotFoundError(thread.threadId, thread.turnId)
  return normalizeCodexTurnBody({ provider: 'codex', threadId: thread.threadId, revision, rawTurn: turn })
}
```

If a later generated schema adds a direct turn-read method, replace this facade in a focused follow-up. Do not add a nonexistent `thread/turn/read` call.

Extend WS protocol with `freshAgent.forked`:

```ts
| { type: 'freshAgent.forked'; sourceSessionId: string; sessionId: string; sessionType: string; runtimeProvider: string; parentThreadId?: string }
```

Send it from `server/ws-handler.ts` after `freshAgent.fork`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/fresh-agent/codex-normalize.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/client/lib/fresh-agent-ws.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Ensure `server/fresh-agent/adapters/codex/normalize.ts` contains no `Array<Record<string, unknown>>` transcript items and no unchecked `any` payload crossing into contract output.

Run:

```bash
rg -n "Array<Record<string, unknown>>|Promise<Record<string, any>>|turns: input\\.transcript\\.turns|extensions = .*\\?\\? \\{\\}" server/fresh-agent/adapters/codex server/coding-cli/codex-app-server
npm run test:vitest -- \
  test/unit/server/fresh-agent/codex-normalize.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/shared/fresh-agent-contract.test.ts
npm run typecheck:server
```

Expected: `rg` finds no stale raw transcript patterns; tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add \
  server/fresh-agent/adapters/codex/normalize.ts \
  server/fresh-agent/adapters/codex/adapter.ts \
  server/fresh-agent/runtime-adapter.ts server/fresh-agent/runtime-manager.ts \
  shared/ws-protocol.ts server/ws-handler.ts src/lib/fresh-agent-ws.ts \
  test/fixtures/fresh-agent/codex/contract-fixtures.ts \
  test/unit/server/fresh-agent/codex-normalize.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/client/lib/fresh-agent-ws.test.ts
git commit -m "Normalize Codex fresh-agent turns and actions"
```

### Task 6: Split FreshAgentView Into Controller And Pure Shell

**Files:**
- Create: `src/components/fresh-agent/useFreshAgentThreadController.ts`
- Create: `src/components/fresh-agent/FreshAgentShell.tsx`
- Create: `src/components/fresh-agent/fresh-agent-policy.ts`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `src/components/fresh-agent/FreshAgentComposer.tsx`
- Modify: `src/components/fresh-agent/FreshAgentApprovalBanner.tsx`
- Modify: `src/components/fresh-agent/FreshAgentQuestionBanner.tsx`
- Modify: `src/store/panesSlice.ts`
- Test: `test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/unit/client/store/panesSlice.test.ts`

- [ ] **Step 1: Write failing controller and shell tests**

Tests must prove:

```ts
it('renders freshcodex without agentChat state', async () => {
  const store = configureStore({ reducer: { panes, settings, freshAgent } })
  render(<FreshAgentView ...freshcodexPane />)
  expect(await screen.findByText('Codex summary')).toBeInTheDocument()
})

it('does not clobber newer pane fields when freshAgent.created arrives late', async () => {
  // Start with model/initialCwd/user title mutated after create was sent.
  // Deliver freshAgent.created.
  // Assert only sessionId, resumeSessionId, status, and createError changed.
})

it('opens a forked freshcodex thread in a sibling pane', async () => {
  emitWs({ type: 'freshAgent.forked', sourceSessionId: 'thread-1', sessionId: 'thread-fork-1', sessionType: 'freshcodex', runtimeProvider: 'codex', parentThreadId: 'thread-1' })
  expect(selectLayoutLeaves(store.getState(), 'tab-1')).toContainEqual(expect.objectContaining({
    content: expect.objectContaining({ kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex', sessionId: 'thread-fork-1' }),
  }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: FAIL because the controller/shell split does not exist and FreshAgentView imports Claude state directly.

- [ ] **Step 3: Implement controller and shell**

`FreshAgentView.tsx` becomes a small wrapper:

```tsx
export function FreshAgentView(props: FreshAgentViewProps) {
  const controller = useFreshAgentThreadController(props)
  return <FreshAgentShell {...controller.shellProps} />
}
```

`useFreshAgentThreadController.ts` owns:

- create/attach WS sends
- snapshot loading
- turn page/body loading hooks needed by Task 7
- retry/recovery state
- action dispatchers
- forked-pane creation through `splitPane`
- controlled load/create/action errors

`FreshAgentShell.tsx` is pure and receives typed props:

```ts
type FreshAgentShellProps = {
  descriptorLabel: string
  statusLabel: string
  summaryText: string
  snapshot: FreshAgentThreadSnapshot | null
  loadError: string | null
  createError: FreshAgentCreateError | null
  actions: {
    send(text: string, images?: FreshAgentInputImage[]): void
    interrupt(): void
    fork(): void
    retryCreate(): void
    answerQuestion(requestId: string, answers: Record<string, string>): void
    resolveApproval(requestId: string, decision: FreshAgentApprovalDecision): void
  }
}
```

`fresh-agent-policy.ts` owns small pure helpers:

```ts
export function getFreshAgentStatusLabel(status: FreshAgentPaneStatus, readModelStatus?: FreshAgentThreadStatus, restoring?: boolean): string
export function getFreshAgentQuestionLabel(sessionType: FreshAgentSessionType, provider: FreshAgentRuntimeProvider): string
export function canUseFreshAgentAction(snapshot: FreshAgentThreadSnapshot | null, action: keyof FreshAgentCapabilities): boolean
export function usesClaudeRestoreState(sessionType: FreshAgentSessionType, provider: FreshAgentRuntimeProvider): boolean
```

Use `mergePaneContent` for async field updates:

```ts
dispatch(mergePaneContent({
  tabId,
  paneId,
  updates: {
    sessionId: message.sessionId,
    resumeSessionId: paneContentRef.current.resumeSessionId ?? message.sessionId,
    status: 'connected',
    createError: undefined,
  },
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/store/panesSlice.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Remove local duplicated snapshot/item types from `FreshAgentView.tsx`; import all fresh-agent read-model types from `shared/fresh-agent-contract`.

Run:

```bash
rg -n "type FreshAgentSnapshot|state\\.agentChat|\\.\\.\\.paneContent" src/components/fresh-agent
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx
npm run typecheck:client
```

Expected: `rg` finds no stale local snapshot type and no Claude state read outside policy/controller; tests and typecheck pass. A controlled `paneContentRef.current` spread for explicit retry replacement is acceptable, but async message handlers should not spread captured `paneContent`.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/fresh-agent/useFreshAgentThreadController.ts \
  src/components/fresh-agent/FreshAgentShell.tsx \
  src/components/fresh-agent/fresh-agent-policy.ts \
  src/components/fresh-agent/FreshAgentView.tsx \
  src/components/fresh-agent/FreshAgentComposer.tsx \
  src/components/fresh-agent/FreshAgentApprovalBanner.tsx \
  src/components/fresh-agent/FreshAgentQuestionBanner.tsx \
  src/store/panesSlice.ts \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/store/panesSlice.test.ts
git commit -m "Split fresh-agent controller from shell"
```

### Task 7: Add Turn Paging, Body Hydration, And Transcript Virtualization

**Files:**
- Create: `src/components/fresh-agent/FreshAgentTranscriptVirtualList.tsx`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Modify: `src/components/fresh-agent/useFreshAgentThreadController.ts`
- Modify: `src/components/fresh-agent/FreshAgentShell.tsx`
- Modify: `src/lib/api.ts`
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx`
- Test: `test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`
- Test: `test/unit/client/lib/api.fresh-agent-contract.test.ts`

- [ ] **Step 1: Write failing paging and virtualization tests**

Add tests:

```ts
it('loads a visible turn page and hydrates missing bodies on demand', async () => {
  api.getFreshAgentTurnPage.mockResolvedValue(contractPageWithTwoSummaries)
  api.getFreshAgentTurnBody.mockResolvedValue(contractBodyForTurn2)
  renderFreshcodex()
  expect(await screen.findByText('Preview for turn 1')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /load full turn 2/i }))
  expect(await screen.findByText('Full body for turn 2')).toBeInTheDocument()
})

it('does not render every row in a 1000-turn transcript', () => {
  render(<FreshAgentTranscriptVirtualList turns={makeTurns(1000)} ... />)
  expect(screen.queryByText('turn 999')).not.toBeInTheDocument()
})

it('shows a stale revision error instead of mixing page and body revisions', async () => {
  api.getFreshAgentTurnBody.mockRejectedValue({ code: 'STALE_THREAD_REVISION', currentRevision: 9 })
  expect(await screen.findByText(/session changed while loading/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
```

Expected: FAIL because transcript paging and virtualization are not implemented.

- [ ] **Step 3: Implement virtualized transcript state**

Use `react-window` already present in the repo. This repo has `react-window@2.x`, which exports `List`, not the old v1 `FixedSizeList`. The controller should:

- Use snapshot `turns` as initial visible bodies.
- If `snapshot.capabilities.turnPaging`, call `getFreshAgentTurnPage(provider, threadId, { revision, priority: 'visible', limit, sortDirection })`; the server adapter maps this to Codex `thread/turns/list` without sending unsupported `revision` or `includeBodies` fields to app-server.
- Store turn summaries keyed by `turnId`.
- Hydrate body through `getFreshAgentTurnBody` when a visible row needs full content. For Codex this calls the Fresh-agent server facade from Task 5, not a nonexistent Codex `thread/turn/read` method.
- Refresh the snapshot and first page on stale revision errors.

`FreshAgentTranscriptVirtualList.tsx` should render:

```tsx
import { List } from 'react-window'

function Row({
  ariaAttributes,
  index,
  style,
  turns,
  hydrateTurn,
}: {
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
  index: number
  style: React.CSSProperties
  turns: FreshAgentTurnSummary[]
  hydrateTurn: (turnId: string) => void
}) {
  const turn = turns[index]
  return (
    <div {...ariaAttributes} style={style}>
      <FreshAgentTurnRow turn={turn} onHydrate={hydrateTurn} />
    </div>
  )
}

<List
  className="min-h-0 flex-1"
  defaultHeight={availableHeight}
  rowComponent={Row}
  rowCount={turns.length}
  rowHeight={estimatedTurnHeight}
  rowProps={{ turns, hydrateTurn }}
  overscanCount={4}
  style={{ height: availableHeight, width: '100%' }}
/>
```

Keep accessible markup inside each row: role/heading labels must remain visible to browser-use automation.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Ensure the empty transcript state still renders when snapshot and page are empty.

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/components/HistoryView.mobile.test.tsx
npm run typecheck:client
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/fresh-agent/FreshAgentTranscriptVirtualList.tsx \
  src/components/fresh-agent/FreshAgentTranscript.tsx \
  src/components/fresh-agent/useFreshAgentThreadController.ts \
  src/components/fresh-agent/FreshAgentShell.tsx \
  src/lib/api.ts \
  test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx \
  test/unit/client/lib/api.fresh-agent-contract.test.ts
git commit -m "Page and virtualize fresh-agent transcripts"
```

### Task 8: Build Freshcodex Item, Diff, Review, Worktree, And Fork UX

**Files:**
- Create: `src/components/fresh-agent/FreshAgentItemCard.tsx`
- Create: `src/components/fresh-agent/FreshAgentWorkspacePanel.tsx`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Modify: `src/components/fresh-agent/FreshAgentDiffPanel.tsx`
- Modify: `src/components/fresh-agent/FreshAgentSidebar.tsx`
- Modify: `src/components/fresh-agent/FreshAgentShell.tsx`
- Modify: `src/components/agent-chat/DiffView.tsx` only if a shared prop is needed
- Test: `test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/e2e-browser/specs/fresh-agent.spec.ts`

- [ ] **Step 1: Write failing UX tests**

Use typed fixtures to assert every important Codex surface:

```ts
expect(screen.getByRole('article', { name: /command npm test/i })).toHaveTextContent('completed')
expect(screen.getByRole('button', { name: /view diff src\/app.ts/i })).toBeInTheDocument()
expect(screen.getByRole('region', { name: /review current changes/i })).toHaveTextContent('No blocking findings')
expect(screen.getByRole('region', { name: /worktree/i })).toHaveTextContent('feature/freshcodex')
expect(screen.getByRole('region', { name: /fork lineage/i })).toHaveTextContent('thread-parent-1')
expect(screen.getByRole('region', { name: /child threads/i })).toHaveTextContent('Review shell')
```

Browser e2e should seed a Freshcodex snapshot with a file-change diff and verify the diff is expandable without relying on selectors.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: FAIL because normalized Codex item rendering and workspace panel are incomplete.

- [ ] **Step 3: Implement item and workspace UI**

`FreshAgentItemCard.tsx` renders one contract item with semantic labels:

- `text`: markdown/plain text with wrapping.
- `hook_prompt`: hook/context prompt fragments without exposing raw JSON.
- `reasoning`: collapsed by default, with summary visible and accessible toggle.
- `plan`: plan card.
- `command`: command, cwd, status, output, exit code.
- `file_change`: list changed files and expandable diff using shared `DiffView`.
- `tool`: MCP/tool card with input/result/error.
- `dynamic_tool`: unsupported or completed dynamic tool call state with the user-visible response.
- `collaboration`: child-agent action card with thread ids.
- `review`: entered/exited review cards.
- `web_search`: query and status.
- `image`: path/url card.
- `image_generation`: prompt/status and generated image metadata when available.
- `context_compaction`: compaction status and token before/after summary when available.
- `request_prompt`: pending/resolved approval/question/tool prompt state.
- `error`: alert card.

`FreshAgentWorkspacePanel.tsx` replaces sidebar-only listing for:

- worktrees
- child threads
- diffs
- review metadata and review output
- fork lineage
- token/context details

Keep a compact sidebar on narrow panes and full details in the main panel. Use semantic `button`, `section`, `article`, headings, and `aria-label`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run the browser spec after unit tests:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts
npm run typecheck:client
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/fresh-agent/FreshAgentItemCard.tsx \
  src/components/fresh-agent/FreshAgentWorkspacePanel.tsx \
  src/components/fresh-agent/FreshAgentTranscript.tsx \
  src/components/fresh-agent/FreshAgentDiffPanel.tsx \
  src/components/fresh-agent/FreshAgentSidebar.tsx \
  src/components/fresh-agent/FreshAgentShell.tsx \
  src/components/agent-chat/DiffView.tsx \
  test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "Render rich Freshcodex transcript and workspace items"
```

### Task 9: Port Mobile Keyboard, Touch, And Performance Fixes Into Fresh-Agent

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentShell.tsx`
- Modify: `src/components/fresh-agent/FreshAgentComposer.tsx`
- Modify: `src/components/fresh-agent/FreshAgentApprovalBanner.tsx`
- Modify: `src/components/fresh-agent/FreshAgentQuestionBanner.tsx`
- Modify: `src/components/fresh-agent/FreshAgentTranscriptVirtualList.tsx`
- Modify: `src/hooks/useKeyboardInset.ts`
- Modify: `test/e2e-browser/perf/scenarios.ts`
- Test: `test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx` if it does not already exist, create it
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx`
- Test: `test/e2e-browser/specs/fresh-agent-mobile.spec.ts`

- [ ] **Step 1: Write failing mobile tests**

Add tests proving:

```ts
expect(screen.getByRole('textbox', { name: /chat message input/i })).toHaveAttribute('enterkeyhint', 'send')
expect(screen.getByRole('button', { name: 'Send' })).toHaveClass(expect.stringMatching(/min-h|h-/))
expect(screen.getByTestId('fresh-agent-root')).toHaveStyle({ paddingBottom: 'var(--keyboard-inset-bottom)' })
```

Browser mobile spec should verify the composer remains visible while typing and approval/question buttons have accessible labels and usable touch size.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx
```

Expected: FAIL because FreshAgent shell has not yet ported the main-branch mobile keyboard behavior.

- [ ] **Step 3: Implement mobile behavior**

Port the main `agent-chat` keyboard/touch behavior into fresh-agent components without importing `agent-chat` view state:

- apply `useKeyboardInset` to the fresh-agent root/composer region
- keep composer sticky in mobile panes
- preserve virtualization container height when keyboard inset changes
- ensure approval/question/action buttons have accessible names and mobile touch targets
- keep transcript scroll stable on send and on snapshot refresh

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx \
  test/unit/client/hooks/useKeyboardInset.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-mobile.spec.ts
npm run test:visible-first:contract
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/fresh-agent/FreshAgentShell.tsx \
  src/components/fresh-agent/FreshAgentComposer.tsx \
  src/components/fresh-agent/FreshAgentApprovalBanner.tsx \
  src/components/fresh-agent/FreshAgentQuestionBanner.tsx \
  src/components/fresh-agent/FreshAgentTranscriptVirtualList.tsx \
  src/hooks/useKeyboardInset.ts test/e2e-browser/perf/scenarios.ts \
  test/unit/client/components/fresh-agent/FreshAgentShell.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentTranscriptVirtualList.test.tsx \
  test/e2e-browser/specs/fresh-agent-mobile.spec.ts
git commit -m "Port mobile ergonomics to fresh-agent shell"
```

### Task 10: Finish Freshcodex Session Identity, Titles, Sidebar, And Settings

**Files:**
- Modify: `src/lib/fresh-agent-registry.ts`
- Modify: `src/lib/derivePaneTitle.ts`
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/panes/PanePicker.tsx`
- Modify: `src/components/SettingsView.tsx`
- Modify: `server/session-directory/fresh-agent-projection.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `shared/settings.ts`
- Test: `test/unit/shared/fresh-agent-registry.test.ts`
- Test: `test/unit/client/lib/derivePaneTitle.test.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Test: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Test: `test/unit/client/components/panes/PanePicker.test.tsx`
- Test: `test/unit/server/session-directory/fresh-agent-projection.test.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`

- [ ] **Step 1: Write failing identity tests**

Add tests:

```ts
expect(derivePaneTitle({ kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex', createRequestId: 'r', status: 'idle' }))
  .toBe('Freshcodex')

expect(collectSessionRefsFromNode(freshcodexLayout)).toContainEqual(expect.objectContaining({
  provider: 'codex',
  sessionType: 'freshcodex',
}))

expect(projectFreshAgentSession(codexThread)).toMatchObject({
  provider: 'codex',
  sessionType: 'freshcodex',
  title: expect.any(String),
})
```

Also test that `freshcodex` settings appear independently from Freshclaude where the UI exposes runtime settings, and `freshopencode` remains disabled/hidden.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/shared/fresh-agent-registry.test.ts \
  test/unit/client/lib/derivePaneTitle.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/server/session-directory/fresh-agent-projection.test.ts
```

Expected: FAIL for any identity/title/sidebar gaps still coupled to `agent-chat` or Claude assumptions.

- [ ] **Step 3: Implement identity fixes**

Rules:

- `freshcodex` title defaults to `Freshcodex`, then updates from the first user message or thread name when available.
- `provider: 'codex'` plus `sessionType: 'freshcodex'` is the session ref identity.
- Hidden `kilroy` resolves to Claude runtime metadata but does not appear as a public picker entry.
- `freshopencode` remains disabled and cannot be created.
- Settings and history labels use `sessionType`; runtime behavior uses `provider`.

Port main's agent-chat auto-title behavior into fresh-agent by using shared title utilities, not by importing `AgentChatView`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/shared/fresh-agent-registry.test.ts \
  test/unit/client/lib/derivePaneTitle.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/HistoryView.mobile.test.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx \
  test/unit/client/components/panes/PanePicker.test.tsx \
  test/unit/server/session-directory/fresh-agent-projection.test.ts \
  test/unit/server/coding-cli/session-indexer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
rg -n "freshcodex.*agentChat|agentChat.*freshcodex|state\\.agentChat.*freshcodex|kind: 'agent-chat'.*freshcodex" src server test
npm run typecheck
```

Expected: `rg` finds no Freshcodex dependence on agent-chat state; typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/fresh-agent-registry.ts src/lib/derivePaneTitle.ts src/lib/session-utils.ts \
  src/store/selectors/sidebarSelectors.ts src/components/HistoryView.tsx \
  src/components/panes/PaneContainer.tsx src/components/panes/PanePicker.tsx \
  src/components/SettingsView.tsx server/session-directory/fresh-agent-projection.ts \
  server/coding-cli/session-indexer.ts shared/settings.ts \
  test/unit/shared/fresh-agent-registry.test.ts \
  test/unit/client/lib/derivePaneTitle.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/HistoryView.mobile.test.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx \
  test/unit/client/components/panes/PanePicker.test.tsx \
  test/unit/server/session-directory/fresh-agent-projection.test.ts \
  test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "Finalize Freshcodex identity and session projections"
```

### Task 11: Harden Error Handling, Reconnect, And Multi-Client Freshcodex Behavior

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `server/fresh-agent/adapters/codex/adapter.ts`
- Modify: `src/lib/fresh-agent-ws.ts`
- Modify: `src/components/fresh-agent/useFreshAgentThreadController.ts`
- Modify: `src/components/fresh-agent/FreshAgentShell.tsx`
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts`
- Test: `test/unit/server/fresh-agent/runtime-manager.test.ts`
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts`
- Test: `test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx`
- Test: `test/e2e-browser/specs/fresh-agent.spec.ts`

- [ ] **Step 1: Write failing resilience tests**

Add tests for:

```ts
it('keeps two clients subscribed to the same Freshcodex thread without dropping either on event refresh', ...)
it('emits a freshAgent.error message instead of generic sdk error for freshcodex action failures', ...)
it('recovers a stopped Codex app-server by surfacing runtime unavailable and enabling retry, not by clearing pane state', ...)
it('does not create duplicate turn starts when the browser reconnects and reattaches a pane', ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx
```

Expected: FAIL for missing typed fresh-agent action errors and duplicate/reconnect guards.

- [ ] **Step 3: Implement resilience behavior**

Add fresh-agent specific errors to `shared/ws-protocol.ts`:

```ts
| { type: 'freshAgent.error'; sessionId?: string; requestId?: string; code: string; message: string; retryable?: boolean }
```

Use this message for fresh-agent action errors instead of generic `sendError`.

In the controller:

- store last create request id sent per pane
- do not re-send create for a pane with an in-flight request unless retry explicitly changes `createRequestId`
- attach on reconnect if `sessionId` exists
- refresh snapshot on `freshAgent.event`, `freshAgent.error` when recoverable, and `freshAgent.forked`
- keep action errors in shell state until dismissed or superseded

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  shared/ws-protocol.ts server/ws-handler.ts \
  server/fresh-agent/runtime-manager.ts \
  server/fresh-agent/adapters/codex/adapter.ts \
  src/lib/fresh-agent-ws.ts \
  src/components/fresh-agent/useFreshAgentThreadController.ts \
  src/components/fresh-agent/FreshAgentShell.tsx \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/client/components/fresh-agent/useFreshAgentThreadController.test.tsx \
  test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "Harden Freshcodex reconnect and action errors"
```

### Task 12: Documentation, Cleanup, And Final Cutover Verification

**Files:**
- Modify: `docs/index.html`
- Modify: `docs/plans/2026-04-18-fresh-agent-platform-test-plan.md` only if it is still used as living reference; otherwise leave old plan untouched
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts`
- Modify: `test/e2e-browser/specs/fresh-agent-mobile.spec.ts`
- Modify: any tests renamed from legacy `agent-chat` specs only if they now cover fresh-agent behavior

- [ ] **Step 1: Write or update final acceptance checks**

Ensure browser specs cover:

```ts
test('freshcodex create, send, interrupt, approval, question, fork, diff, and reconnect', ...)
test('freshcodex mobile composer remains usable with long virtualized transcript', ...)
```

Do not delete legacy `agent-chat` browser specs unless equivalent Freshclaude or Freshcodex coverage exists and the old UI path is truly gone.

- [ ] **Step 2: Run targeted acceptance checks**

Run:

```bash
npm run test:e2e:chromium -- \
  test/e2e-browser/specs/fresh-agent.spec.ts \
  test/e2e-browser/specs/fresh-agent-mobile.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Update docs and clean stale names**

Update `docs/index.html` to show Freshcodex as a rich fresh-agent pane with transcript, diff/review, fork, and worktree surfaces.

Run:

```bash
rg -n "freshcodex.*agent-chat|Freshcodex.*agent-chat|sdk\\.send.*freshcodex|kind: 'agent-chat'.*freshcodex|provider: 'freshcodex'" src server shared test docs
```

Expected: no stale Freshcodex-on-agent-chat references. Legacy Freshclaude/agent-chat references may remain where they are still intentional.

- [ ] **Step 4: Run full verification**

Use the coordinator gate for broad tests:

```bash
npm run lint
npm run build
FRESHELL_TEST_SUMMARY="freshcodex contract foundation final verification" npm test
npm run test:e2e:chromium -- \
  test/e2e-browser/specs/fresh-agent.spec.ts \
  test/e2e-browser/specs/fresh-agent-mobile.spec.ts
```

Expected: all PASS. If a broad run fails, treat it as a real defect until proven unrelated and fixed or documented with evidence.

- [ ] **Step 5: Final main integration safety check**

If `origin/main` moved since Task 1, merge it into the feature branch in this worktree and re-run the final verification. Never merge directly on main.

Run:

```bash
git fetch origin
git rev-list --left-right --count HEAD...origin/main
```

If the right-side count is nonzero:

```bash
git merge origin/main
npm run build
FRESHELL_TEST_SUMMARY="freshcodex contract foundation post-main-merge" npm test
```

Expected: clean merge or resolved conflicts in the worktree, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add \
  docs/index.html \
  test/e2e-browser/specs/fresh-agent.spec.ts \
  test/e2e-browser/specs/fresh-agent-mobile.spec.ts \
  docs/plans/2026-04-18-fresh-agent-platform-test-plan.md
git commit -m "Document and verify Freshcodex contract foundation"
```

If `docs/plans/2026-04-18-fresh-agent-platform-test-plan.md` was not modified, omit it from `git add`.

## Final Acceptance Checklist

- `shared/fresh-agent-contract.ts` owns typed schemas for snapshots, turn pages, turn bodies, items, provider extensions, and action results.
- Server adapters and runtime manager parse every fresh-agent payload before returning it.
- Client API parses fresh-agent payloads and surfaces controlled errors.
- Codex app-server client supports thread fork, turn start, turn interrupt, notifications, and server-request responses according to generated local app-server schemas.
- Codex transcript items are fully normalized; no raw transcript item arrays cross the fresh-agent boundary.
- Freshcodex renders without `agentChat` session state.
- Freshcodex supports create, resume, send, interrupt, fork, approvals, questions, diff/review/worktree/child-thread display, reconnect, retry, and stale revision recovery.
- Long Freshcodex transcripts use paging and virtualization.
- Mobile Freshcodex composer, banners, and transcript remain usable with keyboard inset changes.
- Existing Freshclaude and hidden Kilroy paths still pass their targeted tests.
- No storage-clearing migration is introduced.
- `npm run lint`, `npm run build`, coordinated `npm test`, and targeted Freshcodex browser specs pass.
