# Freshcodex Contract Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Freshcodex as a first-class rich client on the shared fresh-agent foundation, with strict shared contracts, typed Codex normalization, interactive Codex actions, scalable transcript/diff UX, and full regression coverage.

**Architecture:** Keep `fresh-agent` as the shared product domain, but make the normalized contract real instead of implicit: every snapshot, turn page, turn body, transcript item, action response, and provider extension crosses server/client boundaries through shared Zod schemas. Freshcodex uses the official Codex app-server as its source of truth for thread lifecycle, turn lifecycle, fork, interrupt, approvals, questions, review/diff items, token usage, worktrees, and child threads; the client consumes only typed fresh-agent data and never reaches into Claude session state. Freshclaude remains supported through the existing adapter, but this plan optimizes implementation order and tests for Freshcodex correctness.

**Tech Stack:** TypeScript, Zod, React 18, Redux Toolkit, Express, WebSocket JSON-RPC, Codex app-server, existing read-model scheduler, react-window, Vitest, Testing Library, Playwright browser e2e.

---

## Current State

The implementation workspace is `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation`. At this planning checkpoint the branch already contains `origin/main`, but Task 1 must re-check the exact ahead/behind counts before implementation because main can move between planning and execution. If `origin/main` has moved, merge it into this worktree branch before contract work. If `origin/main` is already contained, run the merge-sensitive verification and skip the no-op merge commit. The branch already contains:

- `kind: 'fresh-agent'` pane content with `sessionType` separate from runtime `provider`.
- Claude and Codex runtime adapters under `server/fresh-agent/adapters/*`.
- Fresh-agent REST routes and WebSocket messages.
- A shared FreshAgent shell that can render Freshclaude and Freshcodex snapshots.
- Basic Codex rich snapshot metadata for diffs, worktrees, child threads, review, fork lineage, and token totals.
- Regression coverage for the initial cutover and the last nonconvergence closure pass.

Two existing implementation seams must be corrected before the new feature work can be considered a durable shared foundation:

- `server/fresh-agent/provider-registry.ts` currently stores one registration per runtime provider. Because both `freshclaude` and hidden `kilroy` use `provider: 'claude'`, the last registration can overwrite the runtime-provider lookup. Split session identity registration from runtime adapter registration so many `sessionType` values can intentionally share one provider adapter without changing lookup semantics.
- `src/store/freshAgentSlice.ts`, `src/store/freshAgentTypes.ts`, and `src/store/freshAgentThunks.ts` currently re-export or alias legacy agent-chat state/thunks. `src/lib/pane-activity.ts` also reads fresh-agent pane activity from `agentChatSessions`. That was acceptable as a temporary bridge, but it is not a shared fresh-agent foundation. Fresh-agent state, thunks, activity projection, and action names must be based on the shared fresh-agent contract; legacy agent-chat may keep its own slice until Freshclaude is fully ported.
- Freshcodex defaults and restored-pane runtime settings currently flow through helper files that still assume Claude-shaped agent-chat values. `src/lib/session-type-utils.ts`, `src/store/tabsSlice.ts`, `src/lib/tab-registry-snapshot.ts`, `src/store/paneTreeValidation.ts`, `src/components/TabsView.tsx`, and pane persistence tests must be updated so Codex-shaped approval policy, sandbox, and effort values survive picker creation, session resume, browser persistence, remote tab snapshots, and hydration.

Recent mainline fixes touched exactly the areas this project depends on: agent-chat auto-title, mobile keyboard/touch behavior, stale pane hydration, two-browser reconnect recovery, and Codex app-server startup/init hardening. Those changes are present at this planning checkpoint, but Task 1 must preserve them and repeat the main-sync gate if `origin/main` moves again before implementation so the implementation does not reintroduce known fixed bugs.

## Local Codex Schema Audit

These facts were verified in this worktree against the locally installed CLI, not from memory:

```bash
codex --version
# codex-cli 0.128.0
rm -rf /tmp/freshell-codex-schema-0.128.0
mkdir -p /tmp/freshell-codex-schema-0.128.0/ts /tmp/freshell-codex-schema-0.128.0/json
codex app-server generate-ts --out /tmp/freshell-codex-schema-0.128.0/ts
codex app-server generate-json-schema --out /tmp/freshell-codex-schema-0.128.0/json
```

The generated sources that matter most are:

- `/tmp/freshell-codex-schema-0.128.0/json/JSONRPCRequest.json`, `JSONRPCResponse.json`, `JSONRPCError.json`, `JSONRPCNotification.json`, and `JSONRPCMessage.json`.
- `/tmp/freshell-codex-schema-0.128.0/ts/RequestId.ts`, `ClientRequest.ts`, `ClientNotification.ts`, `ServerRequest.ts`, `ServerNotification.ts`, `InitializeParams.ts`, `InitializeResponse.ts`, and `InitializeCapabilities.ts`.
- `/tmp/freshell-codex-schema-0.128.0/ts/v2/ThreadStartParams.ts`, `ThreadStartResponse.ts`, `ThreadResumeParams.ts`, `ThreadReadParams.ts`, `ThreadReadResponse.ts`, `ThreadTurnsListParams.ts`, `ThreadTurnsListResponse.ts`, `ThreadForkParams.ts`, `ThreadForkResponse.ts`, `TurnStartParams.ts`, `TurnStartResponse.ts`, `TurnInterruptParams.ts`, and `TurnInterruptResponse.ts`.
- `/tmp/freshell-codex-schema-0.128.0/ts/v2/Thread.ts`, `Turn.ts`, `ThreadItem.ts`, `UserInput.ts`, `ThreadStatus.ts`, `TurnStatus.ts`, the approval/request param and response files, and `DynamicToolCallResponse.ts`.
- Runtime-setting and identity leaf types are part of the contract, not incidental dependencies. The plan must also preserve and audit `ReasoningEffort.ts`, `v2/AskForApproval.ts`, `v2/SandboxMode.ts`, `v2/SandboxPolicy.ts`, `v2/NetworkAccess.ts`, `v2/UserInput.ts`, `v2/ThreadStatus.ts`, `v2/TurnStatus.ts`, `v2/ThreadActiveFlag.ts`, `v2/SessionSource.ts`, and `SubAgentSource.ts` because those files define the values Freshcodex sends to Codex and the source/subagent shapes Freshcodex projects into history and child-thread UI.

Schema-grounded protocol facts to preserve:

- Codex app-server supports `--listen stdio://`, `unix://`, `ws://IP:PORT`, and `off`; `stdio://` is the default. Freshcodex rich runtime should use stdio; keep the existing websocket runtime only for raw Codex terminal `--remote` attach.
- JSON-RPC envelopes omit `"jsonrpc": "2.0"`. Request ids are `string | number`; server-initiated request ids must round-trip unchanged.
- JSON-RPC requests are `{ id, method, params?, trace? }`; responses are `{ id, result }`; errors are `{ id, error: { code, message, data? } }`; notifications are `{ method, params? }`.
- Initialization is `initialize` with `{ clientInfo, capabilities }`, followed by exactly one client notification `{ method: 'initialized' }` after a valid response. `InitializeCapabilities` has `experimentalApi` and optional `optOutNotificationMethods`. `InitializeResponse` has `userAgent`, `codexHome`, `platformFamily`, and `platformOs`; there is no `protocolVersion` field in this local schema. Because this plan checks in and classifies the normal generated schema, Freshcodex must initialize with `experimentalApi: false`. If a future plan opts into experimental APIs, it must regenerate the checked-in snapshot with `--experimental`, classify every added method/field/notification, and update fixtures before sending `experimentalApi: true`.
- Generated client methods relevant enough to classify include `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/loaded/list`, `thread/read`, `thread/turns/list`, `thread/compact/start`, `thread/rollback`, `turn/start`, `turn/steer`, `turn/interrupt`, `review/start`, `model/list`, and `modelProvider/capabilities/read`; Task 4 defines which of these Freshcodex implements now versus disables with a clear unsupported path. There is no `thread/turn/read` method.
- `thread/start` accepts runtime settings such as `model`, `modelProvider`, `serviceTier`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `config`, instructions/personality, `ephemeral`, and `sessionStartSource`; it does not accept `richClient`, `experimentalRawEvents`, or `persistExtendedHistory`.
- `thread/resume` accepts `threadId`, the same major runtime overrides, and `excludeTurns?: boolean`; it does not accept `persistExtendedHistory`.
- `thread/read` params are exactly `{ threadId: string, includeTurns: boolean }`. `includeTurns` is required in the generated TypeScript. The response is `{ thread }`.
- `thread/turns/list` params are `{ threadId, cursor?, limit?, sortDirection? }`. It does not accept `revision` or `includeBodies`. The response is `{ data, nextCursor, backwardsCursor }`.
- `turn/start` params are `{ threadId, input, cwd?, approvalPolicy?, approvalsReviewer?, sandboxPolicy?, model?, serviceTier?, effort?, summary?, personality?, outputSchema? }`. Input is an array of generated `UserInput`: text is `{ type: 'text', text, text_elements: [] }`, remote/data images are `{ type: 'image', url }`, local images are `{ type: 'localImage', path }`, skills are `{ type: 'skill', name, path }`, and mentions are `{ type: 'mention', name, path }`.
- Codex reasoning effort values are generated as `"none" | "minimal" | "low" | "medium" | "high" | "xhigh"`. Freshcodex must not reuse Claude's legacy `"max"` effort value; if `"max"` is present in migrated settings, show a controlled unsupported Freshcodex settings error or map only through an explicit user-visible migration rule added in this plan.
- Codex approval policy values are generated as `"untrusted" | "on-failure" | "on-request" | "never" | { granular: ... }`. Freshcodex must not send Claude permission modes such as `"bypassPermissions"` as Codex `approvalPolicy`.
- Codex sandbox settings are split across APIs: `thread/start`, `thread/resume`, and `thread/fork` accept string `sandbox?: "read-only" | "workspace-write" | "danger-full-access"`, while `turn/start` accepts structured `sandboxPolicy`. `SandboxPolicy.externalSandbox.networkAccess` uses generated `NetworkAccess` values `"restricted" | "enabled"`, not a free-form payload. Do not send the thread-level `sandbox` string to `turn/start`.
- `turn/start` returns `{ turn }`. `turn/interrupt` requires `{ threadId, turnId }` and returns `{}`.
- `thread/fork` accepts `threadId`, runtime overrides, `ephemeral?`, and `excludeTurns?`; it returns `{ thread, model, modelProvider, serviceTier, cwd, instructionSources, approvalPolicy, approvalsReviewer, sandbox, reasoningEffort }`.
- `review/start` accepts `{ threadId, target, delivery? }` where target is `uncommittedChanges`, `baseBranch`, `commit`, or `custom`, and delivery is `inline` or `detached`. It returns `{ turn, reviewThreadId }`; the review thread id must be preserved in fresh-agent action results and extensions so inline and future detached review flows can be tracked correctly.
- `thread/loaded/list` returns `{ data: string[], nextCursor }`, not thread summaries. Any fresh-agent loaded-thread UI or API must expose loaded ids directly or hydrate them through `thread/read`/`thread/list`; it must not pretend this app-server method returns rich session rows.
- `thread/list` is paginated. Params include `cursor`, `limit`, `sortKey`, `sortDirection`, `modelProviders`, `sourceKinds`, `archived`, `cwd`, `useStateDbOnly`, and `searchTerm`; the response is `{ data: Thread[], nextCursor, backwardsCursor }`. Freshcodex history/session APIs must preserve both cursors instead of collapsing the response to an array.
- `model/list` is paginated. Params are `{ cursor?, limit?, includeHidden? }`; the response is `{ data: Model[], nextCursor }`. Fresh-agent model APIs must preserve `nextCursor` rather than returning a bare first-page array. A convenience settings helper may accumulate pages for a dropdown, but the adapter/runtime/router/API contract must remain page-shaped so hidden or future large model lists are not silently truncated.
- Generated `ThreadSourceKind` values are `cli`, `vscode`, `exec`, `appServer`, `subAgent`, `subAgentReview`, `subAgentCompact`, `subAgentThreadSpawn`, `subAgentOther`, and `unknown`. Freshcodex rich history must explicitly request `appServer`, `vscode`, and every generated `subAgent*` kind, including `subAgentCompact`, so Codex app-server rich sessions and child-agent sessions are not hidden by default source filters. The `vscode` source is required because local runtime probes against `codex app-server --listen stdio://` on `codex-cli 0.128.0` returned newly created app-server threads with `source: "vscode"` even when the client was Freshell and `serviceName: "freshell"` was supplied.
- Generated `ThreadStartSource` values are only `"startup"` and `"clear"`. Do not use `sessionStartSource` as a Freshell/app-server source marker or send `"appServer"` there.
- `Thread` has `id`, `forkedFromId`, `preview`, `ephemeral`, `modelProvider`, Unix-second timestamps, structured `status`, `path`, `cwd`, `cliVersion`, `source`, optional subagent metadata, `gitInfo`, `name`, and `turns`. `Turn` has `id`, `items`, `status`, `error`, Unix-second `startedAt`/`completedAt` values, and `durationMs`. Fresh-agent contract timestamps may stay ISO strings for UI consistency, but Codex raw protocol schemas and fixtures must parse numeric app-server timestamps and normalize them explicitly.
- Generated `Thread` objects require the full thread metadata envelope even when turn bodies are omitted. At minimum, schema-valid fixtures must include `id`, `forkedFromId`, `preview`, `ephemeral`, `modelProvider`, `createdAt`, `updatedAt`, structured `status`, `path`, `cwd`, `cliVersion`, `source`, `agentNickname`, `agentRole`, `gitInfo`, `name`, and `turns`. `turns` is a required array that may be empty; do not mark it optional in `CodexThreadSchema` just because `thread/read { includeTurns: false }` returns an empty list.
- `ThreadStatus` is structured: `{ type: 'notLoaded' } | { type: 'idle' } | { type: 'systemError' } | { type: 'active', activeFlags: [...] }`. `TurnStatus` is `"completed" | "interrupted" | "failed" | "inProgress"`.
- `Thread.source` uses generated `SessionSource`, not `ThreadSourceKind`. `ThreadSourceKind` is only the filter type for `thread/list`. `SessionSource` values include flat sources such as `"cli"`, `"vscode"`, `"exec"`, and `"appServer"`, but subagent source metadata is represented as `{ subAgent: ... }` with generated `SubAgentSource` variants such as `"review"`, `"compact"`, `{ thread_spawn: ... }`, `"memory_consolidation"`, and `{ other: string }`. Freshcodex protocol schemas, fixtures, history projection, and child-thread metadata must parse and preserve the generated `SessionSource` shape instead of flattening thread metadata to `subAgentReview`/`subAgentCompact` strings.
- Generated `ThreadItem` variants are exactly `userMessage`, `hookPrompt`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`, `imageView`, `imageGeneration`, `enteredReviewMode`, `exitedReviewMode`, and `contextCompaction`.
- Generated `ServerRequest` variants are exactly `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/permissions/requestApproval`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `applyPatchApproval`, and `execCommandApproval`.
- Command approval responses use `{ decision: "accept" | "acceptForSession" | "decline" | "cancel" | amendment-object }`; file-change approval responses use `{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }`; permission responses use `{ permissions, scope, strictAutoReview? }`; user-input responses use `{ answers }`; MCP elicitation responses use `{ action, content, _meta }`; dynamic-tool responses use `{ contentItems, success }`.
- `account/chatgptAuthTokens/refresh` expects real token fields in a successful result and its generated params do not include `threadId`. Freshcodex must not fabricate an unsupported success payload for it. If Freshell cannot satisfy this request, respond with a JSON-RPC error envelope on the original server request id and surface a clear unsupported-auth-refresh runtime error to every subscribed Freshcodex pane for that rich runtime instance, since the request is not thread-addressable.
- Generated `ServerNotification` method names are slash-delimited and must be copied exactly from `ServerNotification.ts`; examples include `thread/status/changed`, `thread/tokenUsage/updated`, `turn/diff/updated`, `turn/plan/updated`, `thread/compacted`, `item/agentMessage/delta`, `item/fileChange/patchUpdated`, `serverRequest/resolved`, `thread/realtime/error`, and `thread/realtime/closed`.
- Any per-turn body API in Freshell must be an internal facade over `thread/turns/list` results or a server-side page/body cache until Codex exposes a direct turn-read request. Do not implement normal Freshcodex body hydration by repeatedly calling `thread/read { includeTurns: true }` over the full thread.
- Freshcodex must not opt out of generated notification methods that affect visible state. In particular, do not include `thread/started`, turn lifecycle, item lifecycle, token usage, diff/review, status, compaction, or error notifications in `InitializeCapabilities.optOutNotificationMethods`; suppressing those events would make the live read model stale by construction.

Generated method inventory the executor must keep aligned with the local schema:

- Freshcodex client-request methods to implement or intentionally leave unsupported must be generated from `ClientRequest.ts` during Task 4, not copied by hand. The implementation-required Freshcodex subset is `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/loaded/list`, `thread/read`, `thread/turns/list`, `turn/start`, `turn/interrupt`, `review/start`, `model/list`, and `modelProvider/capabilities/read`. The explicit unsupported/disabled subset for this plan is every other generated client method, including `thread/archive`, `thread/unsubscribe`, `thread/name/set`, `thread/metadata/update`, `thread/unarchive`, `thread/compact/start`, `thread/shellCommand`, `thread/approveGuardianDeniedAction`, `thread/rollback`, `thread/inject_items`, skills/plugin/marketplace/app/fs/config/account/device/feedback/fuzzy-file-search methods, standalone `command/exec*`, `turn/steer`, MCP direct-call methods, and Windows sandbox setup. Unsupported methods must have clear server/client capability labels if exposed by UI; do not silently proxy arbitrary generated methods through Freshcodex.
- Server-request methods requiring pending UI state or explicit unblock responses: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/permissions/requestApproval`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `applyPatchApproval`, and `execCommandApproval`.
- Visible-state notification methods that must invalidate or patch Freshcodex read models: `error`, `thread/started`, `thread/status/changed`, `thread/archived`, `thread/unarchived`, `thread/closed`, `thread/name/updated`, `thread/goal/updated`, `thread/goal/cleared`, `thread/tokenUsage/updated`, `turn/started`, `hook/started`, `turn/completed`, `hook/completed`, `turn/diff/updated`, `turn/plan/updated`, `item/started`, `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, `item/completed`, `rawResponseItem/completed`, `item/agentMessage/delta`, `item/plan/delta`, `command/exec/outputDelta`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, `serverRequest/resolved`, `item/mcpToolCall/progress`, `mcpServer/oauthLogin/completed`, `mcpServer/startupStatus/updated`, `fs/changed`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`, `thread/compacted`, `model/rerouted`, `model/verification`, `warning`, `guardianWarning`, `configWarning`, `thread/realtime/started`, `thread/realtime/itemAdded`, `thread/realtime/transcript/delta`, `thread/realtime/transcript/done`, `thread/realtime/outputAudio/delta`, `thread/realtime/sdp`, `thread/realtime/error`, `thread/realtime/closed`, `windows/worldWritableWarning`, and `windowsSandbox/setupCompleted`.
- Generated notifications that may be ignored only by an explicit non-visible allowlist: `skills/changed`, `account/updated`, `account/rateLimits/updated`, `app/list/updated`, `remoteControl/status/changed`, `externalAgentConfig/import/completed`, `deprecationNotice`, `fuzzyFileSearch/sessionUpdated`, `fuzzyFileSearch/sessionCompleted`, and `account/login/completed`.

## User-Visible End State

- The Freshcodex pane picker entry creates a `fresh-agent` pane with `sessionType: 'freshcodex'` and `provider: 'codex'`.
- Creating, resuming, and refreshing Freshcodex uses Codex app-server thread APIs only over a dedicated stdio app-server runtime. No terminal scraping, no Freshcodex websocket production dependency, and no Claude state path. Existing raw Codex terminal panes keep their loopback websocket app-server launch path because terminal `--remote` attach currently requires a websocket URL.
- Freshcodex honors Codex runtime settings at create and turn time, including model, sandbox, permission/approval policy, and effort where supported by the generated local app-server schema.
- Freshcodex model and provider capability choices come from Codex app-server `model/list` and `modelProvider/capabilities/read` when the app-server is available. Model-list REST/API contracts preserve the generated `nextCursor`; dropdown helpers may cache or aggregate pages, but they must not hard-code model or capability assumptions into the shared shell.
- Freshcodex can send text and image inputs, interrupt an active turn, fork a thread into a new freshcodex pane, answer Codex command/file/permission approval requests, answer request-user-input prompts, answer MCP elicitations, and reject unsupported dynamic tool calls with a clear response that unblocks the turn.
- Freshcodex can start a Codex review through `review/start` for uncommitted changes by default, preserve the schema `target`, `delivery`, and returned `reviewThreadId`, and then render review status/output through the shared workspace panel.
- Freshcodex receives Codex app-server notifications live. Turn started/completed, item started/completed, token usage, status, diff, review, compaction, child-agent/collaboration, and thread metadata notifications invalidate or patch the normalized read model and reach subscribed browsers as `freshAgent.event` without requiring a manual refresh.
- Unsupported Codex capabilities are disabled with clear labels. Do not silently fall back to raw terminal mode.
- The Freshcodex transcript renders normalized item cards for user messages, hook prompts, agent messages, plans, reasoning, command executions, file changes/diffs, MCP tool calls, collaboration calls, web searches, image views, image generations, review mode, context compaction, dynamic tool calls, errors, and tool/request prompts. Codex user-message content is preserved as multi-part message content, including mixed text and images; do not collapse a multi-part Codex `userMessage.content` array into a single text-only item.
- Long transcripts page through `thread/turns/list`, hydrate from page-provided turn bodies or a bounded body cache, and render through virtualization so mobile remains responsive. Freshcodex snapshots must not load every turn body as the normal path.
- Diff/review/worktree/fork metadata is usable, not just listed. Users can inspect file-change diffs, see review status/output, see fork lineage, see child threads, and identify worktree branch/path.
- Freshcodex has typed load/create/action errors that point to the failing boundary: app-server unavailable, app-server protocol invalid, fresh-agent contract invalid, stale revision, unsupported capability, unauthorized session, or lost session.
- Freshclaude still works after the refactor. Hidden `kilroy` still resolves as Claude-backed. `freshopencode` remains disabled and unimplemented.
- Existing Freshclaude saved layouts, settings, remote tab snapshots, and history stay readable. Existing Freshcodex saved panes must be able to attach after a browser reload or server restart by resuming/loading the Codex app-server thread before snapshot/action work. Do not clear browser storage to force migration.

## Contracts And Invariants

- Durable read-model contracts live in `shared/fresh-agent-contract.ts`; pane lifecycle state stays in `src/store/paneTypes.ts` and must not leak into durable snapshot schemas.
- `provider` means runtime family: `claude`, `codex`, or later `opencode`.
- `sessionType` means user-facing identity: `freshclaude`, `freshcodex`, `kilroy`, or disabled `freshopencode`.
- Every fresh-agent read-model contract and browser/server API that identifies a session must include `sessionType` as well as `provider` and `threadId`. Do not infer user-facing identity from `provider`; multiple session types can share one runtime provider. Use one canonical REST locator shape for fresh-agent thread resources: `/api/fresh-agent/threads/:sessionType/:provider/:threadId` and `/api/fresh-agent/threads/:sessionType/:provider/:threadId/turns...`. Do not keep the old provider-only route as the primary API because it makes `freshclaude`/`kilroy` and future shared-provider clients ambiguous.
- Fresh-agent live session tracking and action routing must key sessions by the full locator `{ sessionType, provider, threadId }`, not by `sessionId` alone. Claude, Codex, and later OpenCode can all expose opaque ids, and a durable foundation must not depend on cross-provider id uniqueness. WebSocket action messages may keep `sessionId` as the user-facing field name for compatibility, but they must also carry `sessionType` and `provider`, and the runtime manager must validate the full locator before dispatching an action.
- Fresh-agent client state, thunk caches, pane activity projection, and subscription bookkeeping must use the same canonical full-locator key as the server runtime manager. Do not index `freshAgent.sessions` by bare `sessionId`; a server-side routing fix is incomplete if Redux or pane activity can still collapse two providers that reuse an opaque id.
- `server/fresh-agent/provider-registry.ts` must model two separate concepts: a session-type descriptor registry and a runtime-provider adapter registry. Runtime adapter lookup by provider must not be overwritten by another session type using the same provider.
- `src/store/freshAgentSlice.ts` must become an actual fresh-agent slice with fresh-agent action names and contract-shaped state. It must not re-export `agentChatSlice`; `src/store/freshAgentTypes.ts` must not alias `agentChatTypes`; and `src/store/freshAgentThunks.ts` must not alias `agentChatThunks`.
- All fresh-agent server adapter outputs parse before leaving `server/fresh-agent/runtime-manager.ts`.
- All fresh-agent REST payloads parse again in `src/lib/api.ts` before UI state sees them.
- A snapshot, turn page, or turn body with an invalid contract is a controlled error, not partially rendered data.
- Freshcodex snapshots are lightweight. They may include thread metadata, pending request state, extensions, and at most a bounded initial turn page. They must not call `thread/read { includeTurns: true }` merely to render the normal snapshot.
- Fresh-agent `revision` is a Freshell normalized read-model revision, not a Codex app-server revision. For Codex, derive it from runtime-manager event ordering and stable thread metadata such as `thread.updatedAt`; preserve the app-server source version separately in `extensions.codex.sourceVersion`. Turn page and turn body requests compare against the Freshell normalized revision. Do not send nonexistent Codex `revision` fields to app-server requests.
- Codex app-server protocol schemas are owned by `server/coding-cli/codex-app-server/protocol.ts`, and must be cross-checked with `codex app-server generate-json-schema` during implementation.
- Codex app-server transports are separated by runtime purpose. `server/coding-cli/codex-app-server/client.ts` owns JSON-RPC request/response semantics over an injected transport; `transport.ts` owns concrete stdio JSONL and websocket framing. `runtime.ts` remains the loopback websocket runtime used by `CodexLaunchPlanner` and raw Codex terminal `--remote` attach. New `rich-runtime.ts` is the Freshcodex-only stdio runtime and must not return or require a `wsUrl`.
- Codex JSON-RPC messages omit the `jsonrpc` property on the wire and emit `initialized` exactly once after successful `initialize`.
- Codex request ids must round-trip as `string | number`; never coerce server-initiated request ids to numbers before responding.
- Provider-specific detail is preserved under typed extension schemas, not ad-hoc `Record<string, unknown>` blobs in transcript items.
- A normalized turn is a lifecycle/container boundary, not a single message role. Codex `Turn` objects contain mixed user, assistant, tool, and system items, so role belongs on message transcript items and turn-level `role` must be optional/legacy-only. Do not invent a turn role to satisfy the contract.
- A Codex app-server item may normalize to zero, one, or many fresh-agent transcript items. In particular, `userMessage.content` can contain multiple text/image/localImage parts. Codex item normalization must return an array and turn normalization must `flatMap` item output while preserving stable derived ids for split content parts.
- Codex `UserInput` content parts include text, image, localImage, skill, and mention. Freshcodex message content and renderers must preserve every generated part type; do not silently drop skill or mention references from existing threads.
- Freshcodex runtime settings use Codex-shaped values at the app-server boundary. Shared UI/state may keep the historical field name `permissionMode`, but the value sent to Codex must parse as generated `AskForApproval`; `effort` must parse as generated `ReasoningEffort`; and turn-time sandbox overrides must be converted to generated `SandboxPolicy` with a clear error if the selected mode cannot be represented.
- Codex turn bodies are page-first. `thread/turns/list` returns `Turn` objects with items, so Freshcodex should normalize those page results directly into turn bodies. A server-side LRU turn-body cache may serve `/turns/:turnId` for bodies already loaded from pages; the adapter must not implement body hydration by repeatedly calling `thread/read { includeTurns: true }` over the full thread.
- Every app-server item/request type documented by the current local generated schema must either have a normalized UI representation or a clear supported-negative response path. Unknown future item types should fail contract validation until intentionally modeled. Do not add a catch-all transcript fallback without explicit approval.
- Every Codex normalization fixture that claims to model an app-server `Thread`, `Turn`, `ThreadItem`, `ServerRequest`, or `ServerNotification` must first parse through the local generated Codex protocol schemas in `server/coding-cli/codex-app-server/protocol.ts`. Do not write tests against impossible mock shapes. If an example in this plan differs from the generated schema, the generated schema wins and the fixture must be corrected.
- Codex protocol schemas in `server/coding-cli/codex-app-server/protocol.ts` must reject missing generated-required fields. Do not use permissive partial schemas for app-server entities that the generated schema makes required. Known important examples are `Thread.turns`, `Thread.cwd`, `Thread.source`, `Thread.createdAt`, `Thread.updatedAt`, `Turn.items`, `Turn.status`, `ThreadTurnsListResponse.nextCursor`, and `ThreadTurnsListResponse.backwardsCursor`.
- Every app-server notification method documented by the current local generated schema that can affect visible Freshcodex state must be intentionally handled. At minimum, turn lifecycle, item lifecycle, token usage, status, diff/review, thread metadata/name/archive/close, context compaction, collaboration/child-agent, realtime error/close, and app-server error notifications must trigger a fresh-agent invalidation event or a typed terminal error. Unknown future notification methods should be logged at debug level and ignored only if they are explicitly classified as non-visible; visible-state notifications must not be silently dropped.
- Server-initiated Codex requests that include `threadId` are routed to that Freshcodex thread. Server-initiated Codex requests without `threadId`, currently `account/chatgptAuthTokens/refresh`, are runtime-global; they must be answered on the original JSON-RPC id and broadcast as a typed runtime error to subscribed Freshcodex panes instead of being dropped or attached to an arbitrary thread.
- Codex server-request response shapes must stay discriminated by generated request method all the way through the shared contract, WebSocket protocol, controller, and adapter. Do not collapse all prompts to Claude-style `answers: Record<string, string>` or `decision: string`: `item/tool/requestUserInput` responds with `{ answers: Record<string, { answers: string[] }> }`, `mcpServer/elicitation/request` responds with `{ action, content, _meta }`, `item/permissions/requestApproval` responds with `{ permissions, scope, strictAutoReview? }`, and command/file approval responses keep their generated decision payloads.
- Async pane updates in `FreshAgentView` must use targeted `mergePaneContent` updates unless replacing an entire pane is intentional.
- Freshcodex tests must be able to render without `state.agentChat.sessions` or Claude restore helpers.
- Main-branch fixes for auto-title, mobile keyboard/touch target behavior, stale pane hydration, reconnect recovery, and app-server stdio/init hardening must survive the cutover.

## File Structure

### Create

- `shared/fresh-agent-contract.ts` - Zod schemas and exported types for snapshots, turn pages, turn bodies, items, provider extensions, action responses, and contract errors.
- `src/lib/fresh-agent-api-error.ts` - typed client error helper for contract parse failures and fresh-agent API errors.
- `server/coding-cli/codex-app-server/transport.ts` - app-server transport abstraction plus stdio JSONL and websocket implementations that own framing, close/error handling, and request/notification delivery.
- `server/coding-cli/codex-app-server/rich-runtime.ts` - Freshcodex-only stdio app-server runtime that exposes rich thread/turn/fork/request APIs without a terminal `wsUrl`.
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
- `test/unit/server/coding-cli/codex-app-server/transport.test.ts` - stdio JSONL and websocket transport framing, request/notification delivery, and close/error behavior.
- `test/unit/server/coding-cli/codex-app-server/rich-runtime.test.ts` - Freshcodex stdio runtime lifecycle and rich API proxy coverage.
- `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/` - checked-in schema audit snapshot generated from local `codex app-server generate-ts` / `generate-json-schema`, reduced to the files needed by tests.
- `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts` - helper that extracts method/type inventories from the checked-in generated schema snapshot so protocol tests do not depend on `/tmp` state.
- `scripts/audit-codex-app-server-schema.ts` - developer audit script that regenerates the local Codex schema, compares it with the checked-in fixture inventory, and prints the exact methods/types requiring reclassification.

### Modify

- `shared/fresh-agent.ts`
- `shared/read-models.ts`
- `shared/ws-protocol.ts`
- `server/coding-cli/codex-app-server/protocol.ts`
- `server/coding-cli/codex-app-server/client.ts`
- `server/coding-cli/codex-app-server/runtime.ts`
- `server/coding-cli/codex-app-server/launch-planner.ts`
- `server/fresh-agent/runtime-adapter.ts`
- `server/fresh-agent/provider-registry.ts`
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
- `src/lib/pane-activity.ts`
- `src/lib/session-type-utils.ts`
- `src/lib/tab-registry-snapshot.ts`
- `src/store/freshAgentSlice.ts`
- `src/store/freshAgentThunks.ts`
- `src/store/freshAgentTypes.ts`
- `src/store/paneTypes.ts`
- `src/store/panesSlice.ts`
- `src/store/paneTreeValidation.ts`
- `src/store/selectors/sidebarSelectors.ts`
- `src/store/tabsSlice.ts`
- `src/store/managed-items.ts`
- `src/store/settingsThunks.ts`
- `src/lib/derivePaneTitle.ts`
- `src/lib/session-utils.ts`
- `src/components/ExtensionsView.tsx`
- `src/components/TabsView.tsx`
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
- Split session-type identity from runtime-provider adapter lookup before depending on either in contract tests. `freshclaude` and `kilroy` sharing the Claude adapter must be an intentional many-to-one mapping, not a Map overwrite side effect.
- Lock shared Zod contracts for all read-model payloads and action responses.
- Enforce those contracts on both server and client boundaries.
- Replace the temporary `freshAgentSlice` re-export of `agentChatSlice` with a real contract-shaped fresh-agent slice. Freshclaude compatibility can be implemented through the Claude adapter and explicit migration/projection code, not by keeping Fresh-agent state as a renamed agent-chat state tree.
- Replace only Freshcodex's app-server dependency on the experimental websocket transport with a dedicated stdio JSONL rich runtime, while preserving the existing websocket runtime for raw Codex terminal remote attach. Then normalize Codex app-server data fully using app-server generated schemas to avoid guessing method shapes.
- Model every currently documented app-server item and server-request surface before choosing to fail unknown future variants.
- Treat app-server method classification as product scope, not just protocol plumbing. If Freshcodex marks `thread/list`, `thread/loaded/list`, `review/start`, `model/list`, or `modelProvider/capabilities/read` as implemented, the plan must wire those methods into history/session projection, review actions, and settings/capability UI rather than leaving them as unused client helpers.
- Split controller from presentation only after contract fixtures exist.
- Implement Freshcodex actions through app-server thread/turn primitives and explicit server-request response handling.
- Finish transcript virtualization and workspace UX so the foundation is good enough for long-term feature growth, not just a thin demo. Freshcodex must stay page-first for transcript bodies: normal snapshots and body hydration should not load the whole app-server thread.

No user decision is required. The plan makes one deliberate scope choice: `freshopencode` stays disabled and unimplemented, while the shared contract remains provider-extensible.

### Task 1: Sync Current Main Without Regressing Fresh-Agent Work

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

Expected: record the exact ahead/behind state. If `git status` shows pre-existing unrelated changes, record those paths and do not stage or overwrite them; stop only if they conflict with this task. If the right-side count is nonzero, logs show main commits that must be merged. If the right-side count is zero, `origin/main` is already contained and this task becomes a verification-only sync gate with no merge commit.

- [ ] **Step 2: Merge `origin/main` into the worktree branch only when needed**

Run:

```bash
git fetch origin
git rev-list --left-right --count HEAD...origin/main
```

If the right-side count is nonzero, run:

```bash
git merge origin/main
```

Expected: conflicts are possible in `server/ws-handler.ts`, `shared/ws-protocol.ts`, `src/store/panesSlice.ts`, `src/components/agent-chat/AgentChatView.tsx`, and Codex app-server files. If the right-side count is zero, do not run a no-op merge and do not create an empty commit; proceed to Step 4.

- [ ] **Step 3: Resolve conflicts by preserving both main fixes and fresh-agent behavior**

Skip this step if Step 2 found no right-side `origin/main` commits.

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

- [ ] **Step 6: Commit only if the main sync changed tracked files**

If Step 2 found no right-side `origin/main` commits and Step 5 made no tracked changes, do not create an empty commit. Otherwise commit only the files changed by the sync/conflict resolution; do not stage unrelated pre-existing dirty paths.

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
git commit -m "Sync main into freshcodex contract foundation"
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
  sessionType: 'freshcodex',
  provider: 'codex',
  threadId: 'thread-codex-1',
  status: 'idle',
})

expect(() => FreshAgentThreadSnapshotSchema.parse({
  sessionType: 'freshcodex',
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

expect(FreshAgentTranscriptItemSchema.parse({
  id: 'user-message-1',
  kind: 'message',
  role: 'user',
  content: [
    { kind: 'text', text: 'Use this mockup' },
    { kind: 'image', url: 'https://example.test/mockup.png', mediaType: 'image/png' },
    { kind: 'mention', name: 'README.md', path: '/repo/README.md' },
    { kind: 'skill', name: 'reviewer', path: '/repo/.codex/skills/reviewer/SKILL.md' },
  ],
})).toMatchObject({
  kind: 'message',
  role: 'user',
  content: [
    { kind: 'text' },
    { kind: 'image' },
    { kind: 'mention' },
    { kind: 'skill' },
  ],
})
```

Also assert that `FreshAgentTurnPageSchema`, `FreshAgentTurnBodySchema`, `FreshAgentThreadListPageSchema`, `FreshAgentModelListPageSchema`, `FreshAgentActionResultSchema`, `FreshAgentCodexExtensionSchema`, and `FreshAgentClaudeExtensionSchema` parse the new fixtures. The thread-list fixture must preserve `items`, `nextCursor`, and `backwardsCursor` because Codex `thread/list` is paginated and Freshcodex history must not collapse the app-server page to an array. The model-list fixture must preserve `items` and `nextCursor` because Codex `model/list` is paginated and Freshcodex settings must not treat the first page as a complete model catalog.
Also assert that `FreshAgentInputImageSchema` and `FreshAgentRuntimeSettingsSchema` parse URL, local-path, data-URL/image-data, model, sandbox, Codex approval policy, and Codex effort fixtures because those shapes are shared by REST, WebSocket, controller, and adapter code. The test must prove Freshcodex accepts generated Codex effort values (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) and rejects sending legacy Claude-only effort values such as `max` through the Codex adapter. It must also prove Freshcodex accepts generated Codex approval policies (`untrusted`, `on-failure`, `on-request`, `never`, and granular policy objects) and rejects Claude permission modes such as `bypassPermissions` at the Codex boundary.

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

expect(FreshAgentServerRequestResponseSchema.parse({
  requestId: 'user-input-1',
  kind: 'tool_user_input',
  answers: {
    choice: { answers: ['a'] },
  },
})).toMatchObject({
  kind: 'tool_user_input',
  answers: { choice: { answers: ['a'] } },
})

expect(FreshAgentServerRequestResponseSchema.parse({
  requestId: 'mcp-elicit-1',
  kind: 'mcp_elicitation',
  action: 'accept',
  content: { value: 'approved' },
  _meta: null,
})).toMatchObject({ kind: 'mcp_elicitation', action: 'accept' })

expect(FreshAgentServerRequestResponseSchema.parse({
  requestId: 'permissions-1',
  kind: 'permissions_approval',
  permissions: { filesystem: { read: true } },
  scope: 'turn',
  strictAutoReview: true,
})).toMatchObject({ kind: 'permissions_approval' })

expect(FreshAgentServerRequestResponseSchema.parse({
  requestId: 'dynamic-tool-1',
  kind: 'dynamic_tool',
  contentItems: [{ type: 'inputText', text: 'Dynamic tool calls are not supported by Freshell yet.' }],
  success: false,
})).toMatchObject({ kind: 'dynamic_tool', success: false })
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

export const FreshAgentSessionTypeSchema = z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode'])
export const FreshAgentRuntimeProviderSchema = z.enum(['claude', 'codex', 'opencode'])
export const FreshAgentThreadStatusSchema = z.enum(['idle', 'running', 'compacting', 'exited', 'lost', 'error'])
export const FreshAgentRoleSchema = z.enum(['user', 'assistant', 'system'])
export const FreshAgentTurnSourceSchema = z.enum(['durable', 'live'])

export type FreshAgentSessionType = z.infer<typeof FreshAgentSessionTypeSchema>
export type FreshAgentRuntimeProvider = z.infer<typeof FreshAgentRuntimeProviderSchema>

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
  role: FreshAgentRoleSchema.optional(),
})

export const FreshAgentMessageContentPartSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('image'),
    url: z.string().url().optional(),
    path: z.string().optional(),
    data: z.string().optional(),
    mediaType: z.string().optional(),
    alt: z.string().optional(),
  }).refine((value) => Boolean(value.url || value.path || value.data), {
    message: 'image message content requires url, path, or data',
  }),
  z.object({
    kind: z.literal('mention'),
    name: NonEmptyString,
    path: NonEmptyString,
  }),
  z.object({
    kind: z.literal('skill'),
    name: NonEmptyString,
    path: NonEmptyString,
  }),
])

export const FreshAgentMessageItemSchema = z.object({
  id: NonEmptyString,
  kind: z.literal('message'),
  role: FreshAgentRoleSchema,
  content: z.array(FreshAgentMessageContentPartSchema).min(1),
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
  FreshAgentMessageItemSchema,
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
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  threadId: NonEmptyString,
  turnId: NonEmptyString,
  revision: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative().optional(),
  source: FreshAgentTurnSourceSchema.optional(),
  summary: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  role: FreshAgentRoleSchema.optional(), // legacy compatibility only; Codex role lives on message items
  items: z.array(FreshAgentTranscriptItemSchema),
})

export const FreshAgentTurnSummarySchema = FreshAgentTurnBodySchema.omit({ items: true }).extend({
  itemCount: z.number().int().nonnegative().default(0),
  preview: z.string().optional(),
  body: FreshAgentTurnBodySchema.optional(),
})

export const FreshAgentTurnPageSchema = z.object({
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  threadId: NonEmptyString,
  revision: z.number().int().nonnegative(),
  turns: z.array(FreshAgentTurnSummarySchema),
  nextCursor: z.string().nullable(),
  backwardsCursor: z.string().nullable(),
})

export const FreshAgentSessionSummarySchema = z.object({
  sessionId: NonEmptyString,
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  runtimeProvider: FreshAgentRuntimeProviderSchema.optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  cwd: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  source: JsonValue.optional(),
  archived: z.boolean().optional(),
  parentThreadId: z.string().nullable().optional(),
})

export const FreshAgentThreadListPageSchema = z.object({
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  items: z.array(FreshAgentSessionSummarySchema),
  nextCursor: z.string().nullable(),
  backwardsCursor: z.string().nullable(),
})

export const FreshAgentCodexReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

export const FreshAgentModelSummarySchema = z.object({
  id: NonEmptyString,
  model: NonEmptyString,
  displayName: z.string(),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: FreshAgentCodexReasoningEffortSchema,
  supportedReasoningEfforts: z.array(z.object({
    reasoningEffort: FreshAgentCodexReasoningEffortSchema,
    description: z.string(),
  })).default([]),
  inputModalities: z.array(z.enum(['text', 'image'])).default([]),
  supportsPersonality: z.boolean().default(false),
  additionalSpeedTiers: z.array(z.string()).default([]),
})

export const FreshAgentModelListPageSchema = z.object({
  provider: z.literal('codex'),
  items: z.array(FreshAgentModelSummarySchema),
  nextCursor: z.string().nullable(),
})

const BooleanQueryParam = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
])

export const FreshAgentModelListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  includeHidden: BooleanQueryParam.optional(),
})

export const FreshAgentTurnPageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: z.enum(['visible', 'background']).optional(),
  revision: z.coerce.number().int().nonnegative(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  sortDirection: z.enum(['asc', 'desc']).optional(),
})

export const FreshAgentCapabilitiesSchema = z.object({
  send: z.boolean(),
  interrupt: z.boolean(),
  approvals: z.boolean(),
  questions: z.boolean(),
  fork: z.boolean(),
  review: z.boolean(),
  worktrees: z.boolean(),
  diffs: z.boolean(),
  childThreads: z.boolean(),
  turnPaging: z.boolean(),
  turnBodies: z.boolean(),
})

export const FreshAgentReviewTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('uncommittedChanges') }),
  z.object({ type: z.literal('baseBranch'), branch: NonEmptyString }),
  z.object({ type: z.literal('commit'), sha: NonEmptyString, title: z.string().nullable().optional() }),
  z.object({ type: z.literal('custom'), instructions: NonEmptyString }),
])

export const FreshAgentInputImageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().url(), mediaType: z.string().optional() }),
  z.object({ kind: z.literal('local'), path: z.string().min(1), mediaType: z.string().optional() }),
  z.object({ kind: z.literal('data'), data: z.string().min(1), mediaType: z.string().min(1) }),
])

export const FreshAgentLegacyClaudeEffortSchema = z.enum(['low', 'medium', 'high', 'max'])
export const FreshAgentCodexApprovalPolicySchema = z.union([
  z.enum(['untrusted', 'on-failure', 'on-request', 'never']),
  z.object({
    granular: z.object({
      sandbox_approval: z.boolean(),
      rules: z.boolean(),
      skill_approval: z.boolean(),
      request_permissions: z.boolean(),
      mcp_elicitations: z.boolean(),
    }),
  }),
])
export const FreshAgentLegacyClaudePermissionModeSchema = z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions'])

export const FreshAgentRuntimeSettingsSchema = z.object({
  model: z.string().min(1).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  // Historical field name retained for pane/settings compatibility. Provider
  // adapters must validate against their own generated runtime schema before sending.
  permissionMode: z.union([FreshAgentCodexApprovalPolicySchema, FreshAgentLegacyClaudePermissionModeSchema]).optional(),
  effort: z.union([FreshAgentCodexReasoningEffortSchema, FreshAgentLegacyClaudeEffortSchema]).optional(),
})

export const FreshAgentThreadSnapshotSchema = z.object({
  sessionType: FreshAgentSessionTypeSchema,
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
  initialTurnPage: FreshAgentTurnPageSchema.optional(),
  pendingApprovals: z.array(FreshAgentApprovalRequestSchema).default([]),
  pendingQuestions: z.array(FreshAgentQuestionRequestSchema).default([]),
  worktrees: z.array(FreshAgentWorktreeRefSchema).default([]),
  diffs: z.array(FreshAgentDiffRefSchema).default([]),
  childThreads: z.array(FreshAgentChildThreadRefSchema).default([]),
  extensions: FreshAgentExtensionsSchema.default({}),
})
```

Define the referenced approval, question, worktree, diff, child-thread, Claude extension, Codex extension, and action-result schemas in the same file. Export inferred types for every schema. Keep provider extension schemas typed and narrow:

Also define a generated-shape-preserving response schema for pending server requests. This schema is the shared surface used by WebSocket actions, controller props, and the Codex adapter when it responds on the original JSON-RPC server request id:

```ts
export const FreshAgentToolUserInputAnswerSchema = z.object({
  answers: z.array(z.string()),
})

export const FreshAgentMcpElicitationActionSchema = z.enum(['accept', 'decline', 'cancel'])
export const FreshAgentDynamicToolOutputContentItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inputText'), text: z.string() }),
  z.object({ type: z.literal('inputImage'), imageUrl: z.string() }),
])

export const FreshAgentServerRequestResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    requestId: NonEmptyString,
    kind: z.literal('command_approval'),
    decision: z.union([
      z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
      z.record(z.string(), JsonValue),
    ]),
  }),
  z.object({
    requestId: NonEmptyString,
    kind: z.literal('file_change_approval'),
    decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
  }),
  z.object({
    requestId: NonEmptyString,
    kind: z.literal('permissions_approval'),
    permissions: z.record(z.string(), JsonValue),
    scope: z.enum(['turn', 'session']),
    strictAutoReview: z.boolean().optional(),
  }),
  z.object({
    requestId: NonEmptyString,
    kind: z.literal('tool_user_input'),
    answers: z.record(z.string(), FreshAgentToolUserInputAnswerSchema),
  }),
  z.object({
    requestId: NonEmptyString,
    kind: z.literal('mcp_elicitation'),
    action: FreshAgentMcpElicitationActionSchema,
    content: JsonValue.nullable(),
    _meta: JsonValue.nullable(),
  }),
  z.object({
    requestId: NonEmptyString,
    kind: z.literal('dynamic_tool'),
    contentItems: z.array(FreshAgentDynamicToolOutputContentItemSchema),
    success: z.boolean(),
  }),
])
```

The implementation may narrow `permissions`, `scope`, MCP `content`, and dynamic-tool output content further when the Codex generated response schemas are modeled in `server/coding-cli/codex-app-server/protocol.ts`, but the shared action contract must not reduce them to strings or Claude-style answers. Even when Freshcodex auto-declines unsupported dynamic tool calls without user input, the response shape must stay contract-modeled so tests can prove the app-server turn is unblocked with the generated `DynamicToolCallResponse` envelope.

Define referenced schemas before any schema that uses them, or wrap recursive references in `z.lazy`, so module evaluation cannot hit a temporal-dead-zone `ReferenceError`.

```ts
export type FreshAgentThreadSnapshot = z.infer<typeof FreshAgentThreadSnapshotSchema>
export type FreshAgentTurnPage = z.infer<typeof FreshAgentTurnPageSchema>
export type FreshAgentTurnBody = z.infer<typeof FreshAgentTurnBodySchema>
export type FreshAgentTranscriptItem = z.infer<typeof FreshAgentTranscriptItemSchema>
export type FreshAgentThreadListPage = z.infer<typeof FreshAgentThreadListPageSchema>
export type FreshAgentModelSummary = z.infer<typeof FreshAgentModelSummarySchema>
export type FreshAgentModelListPage = z.infer<typeof FreshAgentModelListPageSchema>
export type FreshAgentModelListQuery = z.infer<typeof FreshAgentModelListQuerySchema>
export type FreshAgentServerRequestResponse = z.infer<typeof FreshAgentServerRequestResponseSchema>
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
- Modify: `server/index.ts`
- Modify: `server/fresh-agent/runtime-adapter.ts`
- Modify: `server/fresh-agent/provider-registry.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `server/fresh-agent/router.ts`
- Modify: `server/fresh-agent/adapters/claude/normalize.ts`
- Modify: `server/fresh-agent/adapters/codex/normalize.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/fresh-agent-ws.ts`
- Modify: `src/store/freshAgentSlice.ts`
- Modify: `src/store/freshAgentThunks.ts`
- Modify: `src/store/freshAgentTypes.ts`
- Modify: `src/lib/pane-activity.ts`
- Create: `src/lib/fresh-agent-api-error.ts`
- Test: `test/unit/server/fresh-agent/contract-boundary.test.ts`
- Test: `test/unit/server/fresh-agent/provider-registry.test.ts`
- Test: `test/unit/server/fresh-agent/router.test.ts`
- Test: `test/unit/server/fresh-agent/runtime-manager.test.ts`
- Test: `test/unit/client/lib/api.fresh-agent-contract.test.ts`
- Test: `test/unit/client/store/freshAgentSlice.test.ts`
- Test: `test/unit/client/lib/pane-activity.test.ts`
- Test: `test/unit/server/fresh-agent/claude-normalize.test.ts`
- Test: `test/unit/server/fresh-agent/claude-adapter.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Add tests for these cases:

```ts
it('rejects invalid adapter snapshots with a clear contract error', async () => {
  const manager = new FreshAgentRuntimeManager({ registry: registryReturningInvalidSnapshot })
  await expect(manager.getSnapshot({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-1' }))
    .rejects.toMatchObject({ code: 'FRESH_AGENT_CONTRACT_INVALID' })
})

it('returns 502 when adapter output violates the fresh-agent contract', async () => {
  const response = await request(app).get('/api/fresh-agent/threads/freshcodex/codex/thread-1')
  expect(response.status).toBe(502)
  expect(response.body.code).toBe('FRESH_AGENT_CONTRACT_INVALID')
})

it('does not expose provider-only fresh-agent thread routes', async () => {
  const response = await request(app).get('/api/fresh-agent/threads/codex/thread-1')
  expect([400, 404]).toContain(response.status)
})

it('surfaces a controlled client load error for invalid snapshot payloads', async () => {
  mockFetchJson({ provider: 'codex', status: 'creating' })
  await expect(getFreshAgentThreadSnapshot('freshcodex', 'codex', 'thread-1'))
    .rejects.toMatchObject({ code: 'FRESH_AGENT_CONTRACT_INVALID' })
})

it('keeps session-type identity separate from runtime adapter lookup', () => {
  const registry = createFreshAgentProviderRegistry({
    sessionTypes: [
      { sessionType: 'freshclaude', runtimeProvider: 'claude', label: 'Freshclaude' },
      { sessionType: 'kilroy', runtimeProvider: 'claude', label: 'Kilroy', hidden: true },
      { sessionType: 'freshcodex', runtimeProvider: 'codex', label: 'Freshcodex' },
    ],
    runtimeAdapters: [
      { runtimeProvider: 'claude', adapter: claudeAdapter },
      { runtimeProvider: 'codex', adapter: codexAdapter },
    ],
  })
  expect(registry.resolveBySessionType('freshclaude')?.adapter).toBe(claudeAdapter)
  expect(registry.resolveBySessionType('kilroy')?.adapter).toBe(claudeAdapter)
  expect(registry.resolveByRuntimeProvider('claude')?.adapter).toBe(claudeAdapter)
})

it('freshAgentSlice is independent from legacy agentChatSlice', () => {
  expect(freshAgentReducer).not.toBe(agentChatReducer)
  const state = freshAgentReducer(undefined, freshAgentSnapshotReceived(validCodexSnapshot))
  const key = makeFreshAgentSessionKey({
    sessionType: 'freshcodex',
    provider: 'codex',
    sessionId: 'thread-codex-1',
  })
  expect(state.sessions[key]).toMatchObject({
    sessionType: 'freshcodex',
    provider: 'codex',
  })
})

it('freshAgentSlice keeps colliding opaque ids separate by full locator', () => {
  const codexSnapshot = { ...validCodexSnapshot, sessionType: 'freshcodex', provider: 'codex', threadId: 'shared-thread-id' }
  const claudeSnapshot = { ...validClaudeSnapshot, sessionType: 'freshclaude', provider: 'claude', threadId: 'shared-thread-id' }
  let state = freshAgentReducer(undefined, freshAgentSnapshotReceived(codexSnapshot))
  state = freshAgentReducer(state, freshAgentSnapshotReceived(claudeSnapshot))
  expect(Object.keys(state.sessions)).toEqual(expect.arrayContaining([
    'freshcodex:codex:shared-thread-id',
    'freshclaude:claude:shared-thread-id',
  ]))
})

it('freshAgentThunks and activity projection do not read fresh-agent state through agent-chat bridges', () => {
  expect(String(loadFreshAgentTurnBody.typePrefix)).toMatch(/^freshAgent\//)
  const activity = resolvePaneActivity({
    paneId: 'pane-1',
    content: { kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex', sessionId: 'thread-1', createRequestId: 'req-1', status: 'running' },
    isOnlyPane: true,
    codexActivityByTerminalId: {},
    opencodeActivityByTerminalId: {},
    paneRuntimeActivityByPaneId: {},
    agentChatSessions: {},
    freshAgentSessions: {
      [makeFreshAgentSessionKey({ sessionType: 'freshcodex', provider: 'codex', sessionId: 'thread-1' })]: {
        sessionType: 'freshcodex',
        provider: 'codex',
        status: 'running',
      },
    },
  })
  expect(activity).toEqual({ isBusy: true, source: 'fresh-agent' })
})

it('routes fresh-agent actions by the full session locator instead of bare session id', async () => {
  const manager = new FreshAgentRuntimeManager({ registry })
  manager.attach({ sessionType: 'freshclaude', provider: 'claude', sessionId: 'shared-thread-id' })
  manager.attach({ sessionType: 'freshcodex', provider: 'codex', sessionId: 'shared-thread-id' })
  await manager.send({
    sessionType: 'freshcodex',
    provider: 'codex',
    sessionId: 'shared-thread-id',
  }, { text: 'Route to Codex' })
  expect(codexAdapter.send).toHaveBeenCalledWith('shared-thread-id', expect.objectContaining({ text: 'Route to Codex' }))
  expect(claudeAdapter.send).not.toHaveBeenCalled()
})

it('rejects action messages whose locator does not match the attached session record', async () => {
  const manager = new FreshAgentRuntimeManager({ registry })
  manager.attach({ sessionType: 'freshcodex', provider: 'codex', sessionId: 'thread-1' })
  await expect(manager.send({
    sessionType: 'freshclaude',
    provider: 'claude',
    sessionId: 'thread-1',
  }, { text: 'Wrong runtime' })).rejects.toMatchObject({ code: 'FRESH_AGENT_SESSION_LOCATOR_MISMATCH' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/fresh-agent/contract-boundary.test.ts \
  test/unit/server/fresh-agent/provider-registry.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/lib/api.fresh-agent-contract.test.ts \
  test/unit/client/store/freshAgentSlice.test.ts \
  test/unit/client/lib/pane-activity.test.ts \
  test/unit/server/fresh-agent/claude-normalize.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts
```

Expected: FAIL because boundary parsing is not implemented, client helpers return `any`, provider lookup still conflates session type with runtime provider, fresh-agent state/thunks are still legacy agent-chat aliases, and fresh-agent pane activity still reads through `agentChatSessions`.

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

`FreshAgentThreadLocator` should be `{ sessionType: FreshAgentSessionType; provider: FreshAgentRuntimeProvider; threadId: string }`, not provider/thread id only.

In `server/fresh-agent/provider-registry.ts`, split the registry inputs:

```ts
type FreshAgentSessionTypeRegistration = {
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
  label: string
  hidden?: boolean
  disabled?: boolean
}

type FreshAgentRuntimeAdapterRegistration = {
  runtimeProvider: FreshAgentRuntimeProvider
  adapter: FreshAgentRuntimeAdapter
}
```

`resolveBySessionType(sessionType)` should return the matching session descriptor plus the adapter registered for that descriptor's runtime provider. `resolveByRuntimeProvider(provider)` should return the adapter registered for that provider without depending on whichever session type was registered last. Add an invariant test that `freshclaude` and `kilroy` both resolve to the Claude adapter and cannot overwrite each other.

Update every registry construction site in the same task. In `server/index.ts`, replace the current array of combined registrations with separate session descriptors and runtime adapters:

```ts
const freshAgentRuntimeManager = new FreshAgentRuntimeManager({
  registry: createFreshAgentProviderRegistry({
    sessionTypes: [
      { sessionType: 'freshclaude', runtimeProvider: 'claude', label: 'Freshclaude' },
      { sessionType: 'kilroy', runtimeProvider: 'claude', label: 'Kilroy', hidden: true },
      { sessionType: 'freshcodex', runtimeProvider: 'codex', label: 'Freshcodex' },
    ],
    runtimeAdapters: [
      { runtimeProvider: 'claude', adapter: claudeFreshAgentAdapter },
      { runtimeProvider: 'codex', adapter: codexFreshAgentAdapter },
    ],
  }),
})
```

Update existing runtime-manager tests that construct the registry so Task 3 remains typecheckable on its own. Do not add a legacy overload that accepts the old combined array; that would keep the ambiguous many-session-to-one-provider model alive.

In a shared fresh-agent locator module or in `shared/fresh-agent-contract.ts`, export the canonical locator key helper so server runtime state, Redux state, pane activity, and tests cannot drift:

```ts
export type FreshAgentSessionLocator = {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionId: string
}

export type FreshAgentSessionKey = `${FreshAgentSessionType}:${FreshAgentRuntimeProvider}:${string}`

export function makeFreshAgentSessionKey(locator: FreshAgentSessionLocator): FreshAgentSessionKey {
  return `${locator.sessionType}:${locator.provider}:${locator.sessionId}`
}
```

In `runtime-manager.ts`, import that helper and add:

```ts

export class FreshAgentSessionLocatorMismatchError extends Error {
  readonly code = 'FRESH_AGENT_SESSION_LOCATOR_MISMATCH' as const
}

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

Use `FreshAgentSessionLocator` for `attach`, `subscribe`, `send`, `interrupt`, `kill`, `fork`, `respondToServerRequest`, and `startReview` routing. Internally store sessions by `makeFreshAgentSessionKey(locator)`, and when an action arrives for a bare `sessionId` from older compatibility paths, resolve it only if exactly one tracked session has that id; otherwise throw `FreshAgentSessionLocatorMismatchError` with a clear error requiring `sessionType` and `provider`. Parse snapshot, page, body, fork/action responses before returning them.

In `router.ts`, map `FreshAgentContractValidationError` to HTTP 502:

```ts
return res.status(502).json({
  error: error.message,
  code: error.code,
  details: error.issues,
})
```

In `src/lib/api.ts`, parse fresh-agent helpers with the schemas and throw `FreshAgentApiPayloadError` from `src/lib/fresh-agent-api-error.ts` when parsing fails. Update helper signatures and REST paths to carry session identity explicitly and to use the canonical locator route `/api/fresh-agent/threads/:sessionType/:provider/:threadId`:

```ts
getFreshAgentThreadSnapshot(sessionType, provider, threadId, options): Promise<FreshAgentThreadSnapshot>
getFreshAgentTurnPage(sessionType, provider, threadId, query): Promise<FreshAgentTurnPage>
getFreshAgentTurnBody(sessionType, provider, threadId, turnId, revision): Promise<FreshAgentTurnBody>
```

The router must accept `sessionType` in the request path, validate it with `FreshAgentSessionTypeSchema`, and pass it to the runtime manager. Do not reconstruct `sessionType` from `provider`, and do not leave a provider-only fresh-agent thread route active except as an explicit temporary backwards-compatibility redirect that rejects ambiguous shared-provider cases and is removed before final verification.
The fresh-agent turn-page REST query should use `FreshAgentTurnPageQuerySchema` from `shared/fresh-agent-contract.ts`, not the legacy `AgentTimelinePageQuerySchema`, because Freshcodex needs `sortDirection` for newest-first pages and must not expose `includeBodies` as a Codex app-server parameter. The router may keep an `includeBodies` compatibility branch only for non-Codex providers that still need it, but Freshcodex requests should use `sortDirection` plus bounded `limit`, and the Codex adapter must not forward Freshell-only `revision`, `priority`, or `includeBodies` fields to `thread/turns/list`.

Replace `src/store/freshAgentSlice.ts`, `src/store/freshAgentTypes.ts`, and `src/store/freshAgentThunks.ts` with independent fresh-agent reducer, contract-shaped types, and thunk type prefixes. Store sessions by `FreshAgentSessionKey`, not by bare `sessionId`; each session value should still retain `sessionId`, `sessionType`, and `provider` for rendering and debugging. Keep action names fresh-agent-specific, for example `freshAgentCreateRegistered`, `freshAgentCreateFailed`, `freshAgentSnapshotReceived`, `freshAgentEventReceived`, and `freshAgentSessionLost`. `src/lib/fresh-agent-ws.ts` should dispatch these actions directly and should not import `agentChatSlice` actions.

Update `src/lib/pane-activity.ts` so `agent-chat` panes continue to use `agentChatSessions`, while `fresh-agent` panes use the new fresh-agent session state by computing `makeFreshAgentSessionKey({ sessionType, provider, sessionId })` from pane content. `resolvePaneActivity`, `getBusyPaneIdsForTab`, and `collectBusySessionKeys` should accept `freshAgentSessions` separately from `agentChatSessions`; do not keep the current behavior where a Freshcodex pane has to appear in `agentChat.sessions` before activity, busy badges, or session keys work, and do not look up Freshcodex activity by bare `sessionId`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/fresh-agent/contract-boundary.test.ts \
  test/unit/server/fresh-agent/provider-registry.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/lib/api.fresh-agent-contract.test.ts \
  test/unit/client/store/freshAgentSlice.test.ts \
  test/unit/client/lib/pane-activity.test.ts \
  test/unit/server/fresh-agent/claude-normalize.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts
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
  test/unit/server/fresh-agent/provider-registry.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/lib/api.fresh-agent-contract.test.ts \
  test/unit/client/store/freshAgentSlice.test.ts \
  test/unit/client/lib/pane-activity.test.ts \
  test/unit/server/fresh-agent/claude-normalize.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  server/index.ts \
  server/fresh-agent/runtime-adapter.ts server/fresh-agent/provider-registry.ts \
  server/fresh-agent/runtime-manager.ts \
  server/fresh-agent/router.ts server/fresh-agent/adapters/claude/normalize.ts \
  server/fresh-agent/adapters/codex/normalize.ts src/lib/api.ts \
  src/lib/fresh-agent-ws.ts src/store/freshAgentSlice.ts src/store/freshAgentThunks.ts \
  src/store/freshAgentTypes.ts src/lib/pane-activity.ts \
  src/lib/fresh-agent-api-error.ts \
  test/unit/server/fresh-agent/contract-boundary.test.ts \
  test/unit/server/fresh-agent/provider-registry.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/lib/api.fresh-agent-contract.test.ts \
  test/unit/client/store/freshAgentSlice.test.ts \
  test/unit/client/lib/pane-activity.test.ts \
  test/unit/server/fresh-agent/claude-normalize.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts
git commit -m "Validate fresh-agent payloads at runtime boundaries"
```

### Task 4: Bring Codex App-Server Protocol Support Up To Freshcodex Needs

**Files:**
- Modify: `server/index.ts`
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
- Modify: `server/coding-cli/codex-app-server/client.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
- Create: `server/coding-cli/codex-app-server/transport.ts`
- Create: `server/coding-cli/codex-app-server/rich-runtime.ts`
- Modify: `server/fresh-agent/adapters/codex/adapter.ts`
- Modify: `package.json`
- Create: `scripts/audit-codex-app-server-schema.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/ClientRequest.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/ServerRequest.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/ServerNotification.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/RequestId.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/ReasoningEffort.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/InputModality.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/SubAgentSource.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/InitializeParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/InitializeResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/CommandExecutionRequestApprovalResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/FileChangeRequestApprovalResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/PermissionsRequestApprovalResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ToolRequestUserInputResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/McpServerElicitationRequestResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/DynamicToolCallResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ChatgptAuthTokensRefreshResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/AskForApproval.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/SandboxMode.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/SandboxPolicy.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/NetworkAccess.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/Thread.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/Turn.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadItem.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/UserInput.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadStatus.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadActiveFlag.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnStatus.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/SessionSource.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadStartParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadStartSource.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadStartResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadResumeParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadResumeResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadListParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadListResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadSourceKind.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadSortKey.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/SortDirection.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadLoadedListParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadLoadedListResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadReadParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadReadResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadTurnsListParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadTurnsListResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnStartParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnStartResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnInterruptParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnInterruptResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ReviewStartParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ReviewStartResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/Model.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ReasoningEffortOption.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ModelListParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ModelListResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ModelProviderCapabilitiesReadParams.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ModelProviderCapabilitiesReadResponse.ts`
- Create: `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts`
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
- Test: `test/unit/server/coding-cli/codex-app-server/transport.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/client.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/rich-runtime.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts`
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`

- [ ] **Step 1: Generate local app-server schema and write failing protocol tests**

Run this inspection command before editing code, then copy the listed generated files into `test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/`:

```bash
rm -rf /tmp/freshell-codex-app-server-schema
codex app-server generate-json-schema --out /tmp/freshell-codex-app-server-schema
codex app-server generate-ts --out /tmp/freshell-codex-app-server-schema-ts
find /tmp/freshell-codex-app-server-schema -maxdepth 3 -type f | sort | rg 'JSONRPC|Initialize|Thread|Turn|Approval|Request|Item|Fork|Interrupt|ServerRequest|Model|Capabilities'
```

Use the generated schema to verify exact parameter and response names for `initialize`, `initialized`, `thread/start`, `thread/read`, `thread/turns/list`, `turn/start`, `turn/interrupt`, `thread/fork`, `model/list`, `modelProvider/capabilities/read`, server notifications, approval server requests, and user-input server requests. The current local schema uses `thread/read { includeTurns: boolean }`, `thread/turns/list { cursor?, limit?, sortDirection? }`, `thread/turns/list -> { data, nextCursor, backwardsCursor }`, `model/list { cursor?, limit?, includeHidden? }`, `model/list -> { data, nextCursor }`, `turn/start -> { turn }`, `turn/interrupt { threadId, turnId }`, `thread/fork -> { thread, ...metadata }`, and has no `thread/turn/read`; tests must encode those facts so a future implementation does not accidentally keep the stale API. Tests must also prove `thread/start` and `thread/resume` do not send stale fields such as `richClient`, `experimentalRawEvents`, or `persistExtendedHistory`.

Add generated inventory assertions for both methods and field-level requiredness. Tests must parse method names and important required fields from the checked-in generated schema snapshot through `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts`, not from `/tmp`, so normal test runs and CI do not depend on an external `codex` executable. The generated `*.ts` snapshot files intentionally import many sibling type files that this reduced fixture does not check in, so `schema-inventory.ts` must read them as raw UTF-8 text with `fs`/`import.meta.url` path resolution and extract discriminant strings and required object fields. Do not import generated snapshot modules into the test module graph unless the entire generated dependency tree is checked in. The developer audit script may call the local `codex` executable and compare against the checked-in snapshot, but unit tests must be deterministic.

Field inventory tests must fail if `protocol.ts` accepts a generated-required entity with missing required fields. At minimum, assert these local schema facts:

```ts
expect(requiredFieldsForGeneratedType('v2/Thread.ts', 'Thread')).toEqual(expect.arrayContaining([
  'id',
  'forkedFromId',
  'preview',
  'ephemeral',
  'modelProvider',
  'createdAt',
  'updatedAt',
  'status',
  'path',
  'cwd',
  'cliVersion',
  'source',
  'agentNickname',
  'agentRole',
  'gitInfo',
  'name',
  'turns',
]))
expect(() => CodexThreadSchema.parse({ id: 'thread-missing-required-fields' })).toThrow(/turns|cwd|createdAt/i)
expect(() => CodexThreadTurnsListResultSchema.parse({ data: [] })).toThrow(/nextCursor|backwardsCursor/i)
expect(CodexThreadReadResultSchema.parse({ thread: schemaValidThread({ turns: [] }) }).thread.turns).toEqual([])
expect(sourceKindValuesFromGeneratedSchema()).toEqual(expect.arrayContaining([
  'vscode',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
]))
expect(threadStartSourceValuesFromGeneratedSchema()).toEqual(['startup', 'clear'])
expect(() => CodexThreadListResultSchema.parse({ data: [] })).toThrow(/nextCursor|backwardsCursor/i)
expect(() => CodexModelListResultSchema.parse({ data: [] })).toThrow(/nextCursor/i)
expect(() => CodexThreadStartResultSchema.parse({ thread: schemaValidThread({ turns: [] }) })).toThrow(/model|cwd|instructionSources|approvalPolicy|sandbox/i)
expect(() => CodexThreadResumeResultSchema.parse({ thread: schemaValidThread({ turns: [] }) })).toThrow(/model|cwd|instructionSources|approvalPolicy|sandbox/i)
expect(() => CodexThreadForkResultSchema.parse({ thread: schemaValidThread({ turns: [] }), model: 'fixture', modelProvider: 'fixture', cwd: '/repo' })).toThrow(/instructionSources|approvalPolicy|sandbox|reasoningEffort/i)
expect(requiredFieldsForGeneratedType('v2/Model.ts', 'Model')).toEqual(expect.arrayContaining([
  'id',
  'model',
  'displayName',
  'description',
  'hidden',
  'supportedReasoningEfforts',
  'defaultReasoningEffort',
  'inputModalities',
  'supportsPersonality',
  'additionalSpeedTiers',
  'isDefault',
]))
expect(requiredFieldsForGeneratedType('v2/ReasoningEffortOption.ts', 'ReasoningEffortOption')).toEqual(['reasoningEffort', 'description'])
expect(() => CodexModelSchema.parse({ id: 'model-missing-required-fields' })).toThrow(/displayName|defaultReasoningEffort|inputModalities/i)
expect(reasoningEffortValuesFromGeneratedSchema()).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
expect(inputModalityValuesFromGeneratedSchema()).toEqual(['text', 'image'])
expect(askForApprovalValuesFromGeneratedSchema()).toEqual(expect.arrayContaining([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
  'granular',
]))
expect(sandboxModeValuesFromGeneratedSchema()).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
expect(sandboxPolicyVariantsFromGeneratedSchema()).toEqual(expect.arrayContaining([
  'dangerFullAccess',
  'readOnly',
  'externalSandbox',
  'workspaceWrite',
]))
expect(networkAccessValuesFromGeneratedSchema()).toEqual(['restricted', 'enabled'])
expect(userInputVariantsFromGeneratedSchema()).toEqual(['text', 'image', 'localImage', 'skill', 'mention'])
expect(threadStatusVariantsFromGeneratedSchema()).toEqual(['notLoaded', 'idle', 'systemError', 'active'])
expect(turnStatusValuesFromGeneratedSchema()).toEqual(['completed', 'interrupted', 'failed', 'inProgress'])
expect(sessionSourceVariantsFromGeneratedSchema()).toEqual(expect.arrayContaining([
  'cli',
  'vscode',
  'exec',
  'appServer',
  'custom',
  'subAgent',
  'unknown',
]))
expect(subAgentSourceVariantsFromGeneratedSchema()).toEqual(expect.arrayContaining([
  'review',
  'compact',
  'thread_spawn',
  'memory_consolidation',
  'other',
]))
expect(CodexThreadSchema.parse(schemaValidThread({
  source: { subAgent: { thread_spawn: {
    parent_thread_id: 'thread-parent-1',
    depth: 1,
    agent_path: null,
    agent_nickname: 'reviewer',
    agent_role: 'review',
  } } },
  turns: [],
}))).toMatchObject({
  source: { subAgent: { thread_spawn: expect.objectContaining({ parent_thread_id: 'thread-parent-1' }) } },
})
```

This is required because `thread/read { includeTurns: false }` returns a schema-valid `Thread` with `turns: []`, not a partial object with `turns` omitted. Do not loosen `protocol.ts` to make impossible mocks easier to write.
It is also required because `ThreadSourceKind` and `SessionSource` are different generated types: `sourceKinds` filters use flattened subagent source-kind strings, while the `Thread.source` metadata returned in `Thread` objects preserves nested subagent details. The checked-in schema snapshot and inventory tests must cover both so Freshcodex history filters and child-thread metadata do not accidentally share one lossy source enum.
Add fixture helpers such as `schemaValidThread`, `schemaValidTurn`, `schemaValidCodexItem`, `schemaValidThreadLifecycleResult`, and `schemaValidModel`; adapter/runtime tests must use those helpers instead of `{ thread: { id } }`, `{ turn: { id } }`, `{ item: { id } }`, `{ model: { id } }`, or partial lifecycle/model responses.

Add a package script so the schema audit is runnable from normal verification commands:

```json
{
  "scripts": {
    "audit:codex-app-server-schema": "tsx scripts/audit-codex-app-server-schema.ts"
  }
}
```

Compare generated method names to two explicit sets:

- implemented in Freshcodex rich runtime: `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/loaded/list`, `thread/read`, `thread/turns/list`, `turn/start`, `turn/interrupt`, `review/start`, `model/list`, `modelProvider/capabilities/read`
- explicitly unsupported in Freshcodex rich runtime: every other generated method

The test must fail if a new generated client method appears in the checked-in schema snapshot without being classified, and must fail if a method outside the implemented set is accidentally proxied through as a generic request. `scripts/audit-codex-app-server-schema.ts` must fail when the local generated schema differs from the checked-in snapshot and print the new method/type names or required-field changes that require updating fixtures and classification.

Add transport tests requiring stdio JSONL framing and websocket preservation:

```ts
const transport = new CodexStdioJsonlTransport(fakeChildProcess)
await transport.send({ id: 1, method: 'initialize', params: initializeParams })
expect(fakeChild.stdinLines).toEqual([
  JSON.stringify({ id: 1, method: 'initialize', params: initializeParams }),
])
fakeChild.stdout.push(JSON.stringify({ id: 1, result: initializeResponse }) + '\n')
expect(await transport.nextMessage()).toEqual({ id: 1, result: initializeResponse })

const wsTransport = new CodexWebSocketTransport({ wsUrl: 'ws://127.0.0.1:43123' })
await wsTransport.send({ id: 2, method: 'thread/start', params: threadStartParams })
expect(fakeWebSocket.sentMessages).toContainEqual(JSON.stringify({ id: 2, method: 'thread/start', params: threadStartParams }))
```

Then add client/runtime tests requiring:

```ts
await expect(client.initialize()).resolves.toMatchObject({
  userAgent: expect.any(String),
  codexHome: expect.any(String),
  platformFamily: expect.any(String),
  platformOs: expect.any(String),
})
const initializeRequest = fakeTransport.sent.find((message) => message.method === 'initialize')
expect(initializeRequest).toMatchObject({
  params: {
    capabilities: expect.objectContaining({
      experimentalApi: false,
    }),
  },
})
expect(initializeRequest.params.capabilities.optOutNotificationMethods ?? [])
  .not.toEqual(expect.arrayContaining([
    'thread/started',
    'turn/started',
    'turn/completed',
    'item/started',
    'item/completed',
    'thread/tokenUsage/updated',
    'turn/diff/updated',
    'error',
  ]))
expect(fakeTransport.sent).toContainEqual({ method: 'initialized' })

await expect(client.readThread({ threadId: 'thread-1', includeTurns: true }))
  .resolves.toMatchObject({ thread: { id: 'thread-1' } })

await expect(client.listThreadTurns({ threadId: 'thread-1', limit: 25, sortDirection: 'desc' }))
  .resolves.toMatchObject({ data: expect.any(Array), nextCursor: null })

await expect(client.startTurn({
  threadId: 'thread-1',
  input: [{ type: 'text', text: 'Implement this', text_elements: [] }],
})).resolves.toMatchObject({ turn: { id: expect.any(String) } })

await expect(client.interruptTurn({ threadId: 'thread-1', turnId: 'turn-1' })).resolves.toEqual({})

await expect(client.forkThread({ threadId: 'thread-1', excludeTurns: true }))
  .resolves.toMatchObject({ thread: { id: expect.any(String) } })

await expect(client.listThreads({ limit: 25 }))
  .resolves.toMatchObject({ data: expect.any(Array) })

await expect(client.listLoadedThreads({}))
  .resolves.toMatchObject({ data: ['thread-1'], nextCursor: null })

await expect(client.startReview({ threadId: 'thread-1', target: { type: 'uncommittedChanges' }, delivery: 'inline' }))
  .resolves.toMatchObject({ turn: expect.any(Object), reviewThreadId: 'thread-1' })

await expect(client.listModels({ limit: 25 }))
  .resolves.toMatchObject({ data: expect.any(Array), nextCursor: null })

await expect(client.readModelProviderCapabilities({}))
  .resolves.toMatchObject({ webSearch: expect.any(Boolean) })

await expect(runtime.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'Hello', text_elements: [] }] }))
  .resolves.toMatchObject({ turn: { id: expect.any(String) } })

expect('readThreadTurn' in client).toBe(false) // no public method; direct turn read is not in the generated schema
expect('readThreadTurn' in runtime).toBe(false) // the raw websocket runtime must not keep a fake turn-read API either

await expect(websocketRuntime.startThread({ cwd: '/repo' }))
  .resolves.toMatchObject({ threadId: expect.any(String), wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/) })
await expect(richRuntime.startThread({ cwd: '/repo' }))
  .resolves.toMatchObject({ threadId: expect.any(String) })
expect(await richRuntime.ensureReady()).not.toHaveProperty('wsUrl')
```

Add server-request tests in `client.test.ts`:

```ts
it('surfaces server-initiated approval requests and responds on the same JSON-RPC id', async () => {
  const seen: unknown[] = []
  client.onServerRequest((request) => seen.push(request))
  await fakeServer.sendRequest({ id: 'approval-99', method: 'item/commandExecution/requestApproval', params: approvalParams })
  await client.respondToServerRequest('approval-99', { decision: 'accept' })
  expect(fakeServer.responses).toContainEqual({ id: 'approval-99', result: { decision: 'accept' } })
})

it('surfaces runtime-global server requests without inventing a thread id', async () => {
  const seen: unknown[] = []
  client.onServerRequest((request) => seen.push(request))
  await fakeServer.sendRequest({
    id: 'auth-refresh-1',
    method: 'account/chatgptAuthTokens/refresh',
    params: { reason: 'unauthorized', previousAccountId: null },
  })
  await client.respondToServerRequestError('auth-refresh-1', {
    code: -32050,
    message: 'Freshell cannot refresh Codex ChatGPT auth tokens from this runtime.',
  })
  expect(seen).toContainEqual(expect.objectContaining({ id: 'auth-refresh-1', method: 'account/chatgptAuthTokens/refresh' }))
  expect(fakeServer.responses).toContainEqual({
    id: 'auth-refresh-1',
    error: expect.objectContaining({ code: -32050 }),
  })
})
```

Add notification forwarding tests in `client.test.ts` and `rich-runtime.test.ts`:

```ts
it('forwards app-server notifications without treating them as request responses', async () => {
  const notifications: unknown[] = []
  client.onNotification((notification) => notifications.push(notification))
  await fakeServer.sendNotification({ method: 'turn/started', params: { threadId: 'thread-1', turn: schemaValidTurn({ id: 'turn-1' }) } })
  expect(notifications).toContainEqual({ method: 'turn/started', params: expect.objectContaining({ threadId: 'thread-1' }) })
  expect(client.pendingRequestCountForTest()).toBe(0)
})

it('lets the rich stdio runtime subscribe to notifications and server requests for a specific Freshcodex session', async () => {
  const seen: unknown[] = []
  const unsubscribe = await richRuntime.subscribe('thread-1', (event) => seen.push(event))
  await fakeServer.sendNotification({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: schemaValidCodexItem({ type: 'plan', id: 'item-1', text: 'Plan' }) } })
  expect(seen).toContainEqual(expect.objectContaining({ method: 'item/completed' }))
  unsubscribe()
})

it('shuts down the rich stdio app-server child without touching the raw websocket runtime', async () => {
  await richRuntime.ensureReady()
  await richRuntime.shutdown()
  expect(fakeStdioChild.killed).toBe(true)
  expect(websocketRuntime.status()).toBe('running')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/transport.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/rich-runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts
```

Expected: FAIL because the client still owns WebSocket directly, emits `"jsonrpc": "2.0"`, does not send `initialized`, parses the old initialize result, exposes stale turn-read behavior, lacks turn, fork, interrupt, and server-request response methods, and has no Freshcodex-only stdio rich runtime.

- [ ] **Step 3: Implement app-server protocol methods**

Update `protocol.ts` with schema names matching the generated app-server schema. The implementation must include generated response schemas for every server request that Freshell answers, not only request-param schemas. The checked-in schema snapshot and `schema-inventory.ts` should cover `CommandExecutionRequestApprovalResponse`, `FileChangeRequestApprovalResponse`, `PermissionsRequestApprovalResponse`, `ToolRequestUserInputResponse`, `McpServerElicitationRequestResponse`, `DynamicToolCallResponse`, and `ChatgptAuthTokensRefreshResponse` so tests fail when Codex changes the payload shape Freshell sends back to unblock a turn.

The implementation must include, at minimum:

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
  includeTurns: z.boolean(),
})

export const CodexThreadTurnsListParamsSchema = z.object({
  threadId: z.string().min(1),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().nonnegative().optional(),
  sortDirection: z.enum(['asc', 'desc']).nullable().optional(),
})

export const CodexThreadTurnsListResultSchema = z.object({
  data: z.array(CodexTurnSchema),
  nextCursor: z.string().nullable(),
  backwardsCursor: z.string().nullable(),
})

export const CodexThreadSourceKindSchema = z.enum([
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
])
export const CodexSubAgentSourceSchema = z.union([
  z.literal('review'),
  z.literal('compact'),
  z.object({
    thread_spawn: z.object({
      parent_thread_id: z.string().min(1),
      depth: z.number().int().nonnegative(),
      agent_path: z.unknown().nullable(),
      agent_nickname: z.string().nullable(),
      agent_role: z.string().nullable(),
    }),
  }),
  z.literal('memory_consolidation'),
  z.object({ other: z.string() }),
])
export const CodexSessionSourceSchema = z.union([
  z.literal('cli'),
  z.literal('vscode'),
  z.literal('exec'),
  z.literal('appServer'),
  z.object({ custom: z.string() }),
  z.object({ subAgent: CodexSubAgentSourceSchema }),
  z.literal('unknown'),
])
export const CodexThreadSortKeySchema = z.enum(['created_at', 'updated_at'])

export const CodexThreadListParamsSchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.number().int().nonnegative().optional(),
  sortKey: CodexThreadSortKeySchema.nullable().optional(),
  sortDirection: z.enum(['asc', 'desc']).nullable().optional(),
  modelProviders: z.array(z.string()).nullable().optional(),
  sourceKinds: z.array(CodexThreadSourceKindSchema).nullable().optional(),
  archived: z.boolean().nullable().optional(),
  cwd: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  useStateDbOnly: z.boolean().optional(),
  searchTerm: z.string().nullable().optional(),
})

export const CodexThreadListResultSchema = z.object({
  data: z.array(CodexThreadSchema),
  nextCursor: z.string().nullable(),
  backwardsCursor: z.string().nullable(),
})

export const CodexThreadLoadedListResultSchema = z.object({
  data: z.array(z.string().min(1)),
  nextCursor: z.string().nullable(),
})

export const CodexTurnInputItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), text_elements: z.array(z.unknown()).default([]) }),
  z.object({ type: z.literal('image'), url: z.string().url() }),
  z.object({ type: z.literal('localImage'), path: z.string().min(1) }),
  z.object({ type: z.literal('skill'), name: z.string().min(1), path: z.string().min(1) }),
  z.object({ type: z.literal('mention'), name: z.string().min(1), path: z.string().min(1) }),
])

export const CodexReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
export const CodexApprovalPolicySchema = z.union([
  z.enum(['untrusted', 'on-failure', 'on-request', 'never']),
  z.object({
    granular: z.object({
      sandbox_approval: z.boolean(),
      rules: z.boolean(),
      skill_approval: z.boolean(),
      request_permissions: z.boolean(),
      mcp_elicitations: z.boolean(),
    }),
  }),
])
export const CodexSandboxPolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dangerFullAccess') }),
  z.object({ type: z.literal('readOnly'), networkAccess: z.boolean() }),
  z.object({ type: z.literal('externalSandbox'), networkAccess: z.enum(['restricted', 'enabled']) }),
  z.object({
    type: z.literal('workspaceWrite'),
    writableRoots: z.array(z.string()),
    networkAccess: z.boolean(),
    excludeTmpdirEnvVar: z.boolean(),
    excludeSlashTmp: z.boolean(),
  }),
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
export const CodexServiceTierSchema = z.enum(['fast', 'flex'])
export const CodexApprovalsReviewerSchema = z.enum(['user', 'auto_review', 'guardian_subagent'])

const CodexThreadLifecycleResultSchema = z.object({
  thread: CodexThreadSchema,
  model: z.string().min(1),
  modelProvider: z.string().min(1),
  serviceTier: CodexServiceTierSchema.nullable(),
  cwd: z.string().min(1),
  instructionSources: z.array(z.string()),
  approvalPolicy: CodexApprovalPolicySchema,
  approvalsReviewer: CodexApprovalsReviewerSchema,
  sandbox: CodexSandboxPolicySchema,
  reasoningEffort: CodexReasoningEffortSchema.nullable(),
})

export const CodexThreadStartResultSchema = CodexThreadLifecycleResultSchema
export const CodexThreadResumeResultSchema = CodexThreadLifecycleResultSchema
export const CodexThreadForkResultSchema = CodexThreadLifecycleResultSchema

export const CodexTurnStartResultSchema = z.object({
  turn: CodexTurnSchema,
})

export const CodexTurnInterruptParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
})

export const CodexTurnInterruptResultSchema = z.object({}).passthrough()

```

Also model generated app-server read shapes used by later normalization and UI tasks:

```ts
export const CodexUserInputSchema = z.discriminatedUnion('type', [...])
export const CodexThreadItemSchema = z.discriminatedUnion('type', [...])
export const CodexTurnSchema = z.object({
  id: z.string().min(1),
  items: z.array(CodexThreadItemSchema),
  status: CodexTurnStatusSchema,
  error: z.unknown().nullable().optional(),
  startedAt: z.number().nullable().optional(),
  completedAt: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
})
export const CodexThreadSchema = z.object({
  id: z.string().min(1),
  forkedFromId: z.string().nullable(),
  preview: z.string(),
  ephemeral: z.boolean(),
  modelProvider: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: CodexThreadStatusSchema,
  path: z.string().nullable(),
  cwd: z.string().min(1),
  cliVersion: z.string(),
  source: CodexSessionSourceSchema,
  agentNickname: z.string().nullable(),
  agentRole: z.string().nullable(),
  gitInfo: CodexGitInfoSchema.nullable(),
  name: z.string().nullable(),
  turns: z.array(CodexTurnSchema),
}).passthrough()
export const CodexServerRequestSchema = z.discriminatedUnion('method', [...])
export const CodexServerNotificationSchema = z.discriminatedUnion('method', [...])
```

The object schemas and discriminated unions must be generated-schema faithful enough that Task 5 fixtures cannot use impossible app-server thread, turn, item, request, response, or notification shapes. It is acceptable to use `.passthrough()` for extra future fields on known variants, but do not make generated-required fields optional and do not use a catch-all unknown item variant.

Create `transport.ts` as the only app-server framing owner:

```ts
export type CodexRpcMessage = {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export interface CodexAppServerTransport {
  send(message: CodexRpcMessage): Promise<void>
  onMessage(listener: (message: CodexRpcMessage) => void): () => void
  close(): Promise<void>
}

export class CodexStdioJsonlTransport implements CodexAppServerTransport {}
export class CodexWebSocketTransport implements CodexAppServerTransport {}
```

The stdio implementation should split stdout on newlines, parse one JSON message per line, reject malformed app-server output with a clear transport error, and never add a `jsonrpc` property. The websocket implementation should preserve the existing loopback app-server terminal launch behavior while using the same no-`jsonrpc` envelope semantics as stdio.

Update `client.ts`:

```ts
type CodexRequestId = string | number
type ServerRequest = { id: CodexRequestId; method: string; params: unknown }

onNotification(listener: (notification: { method: string; params?: unknown }) => void): () => void
onServerRequest(listener: (request: ServerRequest) => void): () => void
respondToServerRequest(id: CodexRequestId, result: unknown): Promise<void>
respondToServerRequestError(id: CodexRequestId, error: { code: number; message: string; data?: unknown }): Promise<void>
readThread(params: CodexThreadReadParams): Promise<CodexThreadReadResult>
listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResult>
listThreads(params: CodexThreadListParams): Promise<CodexThreadListResult>
listLoadedThreads(params: CodexThreadLoadedListParams): Promise<CodexThreadLoadedListResult>
startTurn(params: CodexTurnStartParams): Promise<CodexTurnStartResult>
interruptTurn(params: CodexTurnInterruptParams): Promise<CodexTurnInterruptResult>
forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResult>
startReview(params: CodexReviewStartParams): Promise<CodexReviewStartResult>
listModels(params: CodexModelListParams): Promise<CodexModelListResult>
readModelProviderCapabilities(params: CodexModelProviderCapabilitiesReadParams): Promise<CodexModelProviderCapabilitiesReadResult>
```

Update message handling so app-server requests with `id` and `method` are not ignored, and so notifications without `id` reach subscribers. Keep request timeout behavior for client-initiated calls. `initialize` must send `capabilities.experimentalApi: false` because the checked-in protocol snapshot and method classification are non-experimental; do not send `experimentalApi: true` unless this plan is updated to generate and classify `--experimental` schema artifacts. `initialize` also must not opt out of any visible-state notification method; remove the existing `thread/started` opt-out. After a successful `initialize`, send exactly one `initialized` notification on the same transport before non-initialize requests. The client constructor should receive a `CodexAppServerTransport` instead of a `{ wsUrl }` endpoint. Server-request responses must support both result and error envelopes so unsupported required requests such as auth-token refresh can unblock the app-server without sending an invalid success shape.

Keep `runtime.ts` as the websocket remote runtime for raw Codex terminal panes and `CodexLaunchPlanner`. It should spawn:

```ts
spawn(command, [...commandArgs, 'app-server', '--listen', wsUrl], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

and use `CodexWebSocketTransport` internally. Its `startThread` and `resumeThread` continue returning `{ threadId, wsUrl }`; do not break `server/terminal-registry.ts`, `server/agent-api/router.ts`, or `CodexLaunchPlanner`.

Create `rich-runtime.ts` for Freshcodex. It should spawn:

```ts
spawn(command, [...commandArgs, 'app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
```

and use `CodexStdioJsonlTransport` internally. Proxy the new rich methods after `ensureReady()`. Freshcodex adapter dependencies must use this rich runtime and must not receive or depend on `wsUrl`.

`rich-runtime.ts` must also expose:

```ts
subscribe(threadId: string, listener: (event: CodexRuntimeEvent) => void): Promise<() => void>
onServerRequest(listener: (request: CodexServerRequest) => void): () => void
onRuntimeError(listener: (error: CodexRuntimeError) => void): () => void
```

The runtime should forward notifications and server requests from `client.ts` without buffering them behind a snapshot call. It may filter by `threadId` only when the generated params contain a thread id; notifications or server requests without a thread id but with visible global impact, such as app-server errors and `account/chatgptAuthTokens/refresh`, should still reach subscribers as typed runtime events or runtime errors.

Keep the branch typecheckable at the end of Task 4. Because this task removes the nonexistent `thread/turn/read` client/runtime API, also update `server/fresh-agent/adapters/codex/adapter.ts` enough to stop depending on `readThreadTurn` or a websocket-only `{ wsUrl }` result. This is a narrow compile-preserving bridge before Task 5's full normalization:

```ts
type CodexFreshAgentRichRuntimePort = {
  startThread(params: CodexThreadStartParams): Promise<{ threadId: string }>
  resumeThread(params: CodexThreadResumeParams): Promise<{ threadId: string }>
  readThread(params: CodexThreadReadParams): Promise<CodexThreadReadResult>
  listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResult>
  subscribe?(threadId: string, listener: (event: unknown) => void): Promise<() => void> | (() => void)
}
```

For this bridge only, `getTurnBody` should return a typed `FreshAgentUnsupportedCapabilityError` or cache-miss style error rather than calling a fake Codex RPC. Task 5 replaces that bridge with the bounded page/body cache and full event/request handling. Do not keep any `readThreadTurn` method on the client, raw websocket runtime, rich stdio runtime, or adapter port.

Wire both Codex runtimes in `server/index.ts` in the same task:

```ts
const codexAppServerRuntime = new CodexAppServerRuntime()
const codexRichAppServerRuntime = new CodexRichAppServerRuntime()
const codexLaunchPlanner = new CodexLaunchPlanner(codexAppServerRuntime)
const codexFreshAgentAdapter = createCodexFreshAgentAdapter({
  runtime: codexRichAppServerRuntime,
})
```

The raw websocket runtime remains exclusively for `CodexLaunchPlanner` and raw Codex terminal `--remote` attach. The rich stdio runtime is passed to the Freshcodex adapter. On server shutdown, call `await codexRichAppServerRuntime.shutdown()` next to the existing raw runtime shutdown so the stdio app-server process cannot be orphaned.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/transport.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/rich-runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Keep `client.ts` as the only JSON-RPC envelope owner. `runtime.ts` and `rich-runtime.ts` should remain thin lifecycle/proxy layers with separate responsibilities.

Run:

```bash
npm run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/transport.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/rich-runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/integration/server/codex-session-flow.test.ts
npm run audit:codex-app-server-schema
npm run typecheck:server
```

Expected: PASS. If `npm run audit:codex-app-server-schema` fails because the installed `codex` schema differs from the checked-in snapshot, do not proceed by weakening tests; regenerate the snapshot, update protocol schemas and classifications, and rerun this task.

- [ ] **Step 6: Commit**

```bash
git add \
  server/index.ts \
  server/coding-cli/codex-app-server/protocol.ts \
  server/coding-cli/codex-app-server/transport.ts \
  server/coding-cli/codex-app-server/client.ts \
  server/coding-cli/codex-app-server/rich-runtime.ts \
  server/coding-cli/codex-app-server/runtime.ts \
  server/coding-cli/codex-app-server/launch-planner.ts \
  server/fresh-agent/adapters/codex/adapter.ts \
  package.json \
  test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/ClientRequest.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/ServerRequest.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/ServerNotification.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/RequestId.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/ReasoningEffort.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/InputModality.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/SubAgentSource.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/InitializeParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/InitializeResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/CommandExecutionRequestApprovalResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/FileChangeRequestApprovalResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/PermissionsRequestApprovalResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ToolRequestUserInputResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/McpServerElicitationRequestResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/DynamicToolCallResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ChatgptAuthTokensRefreshResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/AskForApproval.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/SandboxMode.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/SandboxPolicy.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/NetworkAccess.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/Thread.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/Turn.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadItem.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/UserInput.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadStatus.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadActiveFlag.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnStatus.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/SessionSource.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadStartParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadStartSource.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadStartResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadResumeParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadResumeResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadListParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadListResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadSourceKind.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadSortKey.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/SortDirection.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadLoadedListParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadLoadedListResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadReadParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadReadResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadTurnsListParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ThreadTurnsListResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnStartParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnStartResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnInterruptParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/TurnInterruptResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ReviewStartParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ReviewStartResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/Model.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ReasoningEffortOption.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ModelListParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ModelListResponse.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ModelProviderCapabilitiesReadParams.ts \
  test/fixtures/coding-cli/codex-app-server/generated-schema-0.128.0/v2/ModelProviderCapabilitiesReadResponse.ts \
  test/fixtures/coding-cli/codex-app-server/schema-inventory.ts \
  scripts/audit-codex-app-server-schema.ts \
  test/unit/server/coding-cli/codex-app-server/transport.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/rich-runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/integration/server/codex-session-flow.test.ts
git commit -m "Extend Codex app-server client for rich turns"
```

### Task 5: Fully Normalize Codex Snapshots, Pages, Bodies, And Events

**Files:**
- Modify: `server/coding-cli/codex-app-server/rich-runtime.ts`
- Modify: `server/fresh-agent/adapters/codex/normalize.ts`
- Modify: `server/fresh-agent/adapters/codex/adapter.ts`
- Modify: `server/fresh-agent/runtime-adapter.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/fresh-agent-ws.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `test/fixtures/fresh-agent/codex/contract-fixtures.ts`
- Modify: `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts`
- Test: `test/unit/server/fresh-agent/codex-normalize.test.ts`
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/runtime-manager.test.ts`
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts`

- [ ] **Step 1: Write failing normalization and event tests**

Require all documented Codex item variants to normalize into `FreshAgentTranscriptItemSchema` variants. Build every raw fixture with a helper that first parses the fixture through `CodexThreadItemSchema` or `CodexTurnSchema`:

```ts
function parseCodexItemFixture(value: unknown): CodexThreadItem {
  return CodexThreadItemSchema.parse(value)
}

function parseCodexTurnFixture(value: unknown): CodexTurn {
  return CodexTurnSchema.parse(value)
}
```

If the generated schema requires fields not shown in a short example below, the test fixture must include those fields. For Codex CLI 0.128.0, for example, `commandExecution` requires `cwd`, `source`, and `commandActions`; `agentMessage` includes `phase` and `memoryCitation`; `imageGeneration` includes `result`; and `contextCompaction` contains only `id`.

```ts
expect(normalizeCodexItem(parseCodexItemFixture({ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Do it', text_elements: [] }] })))
  .toEqual([{ id: 'u1', kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Do it' }] }])

expect(normalizeCodexItem(parseCodexItemFixture({
  type: 'userMessage',
  id: 'u2',
  content: [
    { type: 'text', text: 'Use this mockup', text_elements: [] },
    { type: 'image', url: 'https://example.test/mockup.png' },
    { type: 'localImage', path: '/tmp/mockup.png' },
    { type: 'mention', name: 'README.md', path: '/repo/README.md' },
    { type: 'skill', name: 'reviewer', path: '/repo/.codex/skills/reviewer/SKILL.md' },
  ],
}))).toEqual([{
  id: 'u2',
  kind: 'message',
  role: 'user',
  content: [
    { kind: 'text', text: 'Use this mockup' },
    { kind: 'image', url: 'https://example.test/mockup.png' },
    { kind: 'image', path: '/tmp/mockup.png' },
    { kind: 'mention', name: 'README.md', path: '/repo/README.md' },
    { kind: 'skill', name: 'reviewer', path: '/repo/.codex/skills/reviewer/SKILL.md' },
  ],
}])

expect(normalizeCodexItem(parseCodexItemFixture({ type: 'hookPrompt', id: 'h1', fragments: [{ text: 'Preflight', hookRunId: 'hook-1' }] })))
  .toEqual([expect.objectContaining({ id: 'h1', kind: 'hook_prompt' })])

expect(normalizeCodexItem(parseCodexItemFixture({ type: 'agentMessage', id: 'a1', text: 'Done', phase: null, memoryCitation: null })))
  .toEqual([{ id: 'a1', kind: 'message', role: 'assistant', content: [{ kind: 'text', text: 'Done' }] }])

expect(normalizeCodexItem(parseCodexItemFixture({
  type: 'commandExecution',
  id: 'c1',
  command: 'npm test',
  cwd: '/repo',
  processId: null,
  source: 'agent',
  status: 'completed',
  commandActions: [],
  aggregatedOutput: 'ok',
  exitCode: 0,
  durationMs: 10,
})))
  .toEqual([expect.objectContaining({ id: 'c1', kind: 'command', command: 'npm test', status: 'completed', output: 'ok' })])

expect(normalizeCodexItem(parseCodexItemFixture({ type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@' }] })))
  .toEqual([expect.objectContaining({ id: 'f1', kind: 'file_change', changes: [{ path: 'src/a.ts', diff: '@@' }] })])

expect(() => normalizeCodexItem({ type: 'newUnknownItem', id: 'u1' }))
  .toThrow(/unsupported Codex item/i)

expect(normalizeCodexItem(parseCodexItemFixture({ type: 'contextCompaction', id: 'compact-1' })))
  .toEqual([expect.objectContaining({ id: 'compact-1', kind: 'context_compaction' })])

expect(normalizeCodexItem(parseCodexItemFixture({
  type: 'dynamicToolCall',
  id: 'dyn-1',
  namespace: null,
  tool: 'tool-x',
  arguments: {},
  status: 'failed',
  contentItems: [{ type: 'inputText', text: 'Dynamic tool calls are not supported by Freshell yet.' }],
  success: false,
  durationMs: null,
})))
  .toEqual([expect.objectContaining({ id: 'dyn-1', kind: 'dynamic_tool', status: 'failed' })])

expect(normalizeCodexItem(parseCodexItemFixture({ type: 'imageGeneration', id: 'img-gen-1', status: 'completed', revisedPrompt: 'diagram', result: 'https://example.test/generated.png' })))
  .toEqual([expect.objectContaining({ id: 'img-gen-1', kind: 'image_generation' })])
```

Add table-driven coverage for every local generated `ThreadItem` type: `userMessage`, `hookPrompt`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`, `imageView`, `imageGeneration`, `enteredReviewMode`, `exitedReviewMode`, and `contextCompaction`. The table must derive the expected type names from `schema-inventory.ts` and fail if the checked-in generated `ThreadItem.ts` contains a variant with no schema-valid fixture.

Require adapter methods:

```ts
runtime.startTurn.mockResolvedValue({ turn: schemaValidTurn({ id: 'turn-1' }) })
await adapter.send?.('thread-1', { text: 'Ship it' })
expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
  threadId: 'thread-1',
  input: [{ type: 'text', text: 'Ship it', text_elements: [] }],
}))

await adapter.send?.('thread-1', {
  text: 'Use this mockup',
  images: [{ kind: 'url', url: 'https://example.test/mockup.png', mediaType: 'image/png' }],
  runtimeSettings: {
    model: 'configured-model',
    sandbox: 'workspace-write',
    permissionMode: 'on-request',
    effort: 'xhigh',
  },
})
expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
  threadId: 'thread-1',
  model: 'configured-model',
  sandboxPolicy: expect.anything(),
  approvalPolicy: expect.anything(),
  effort: 'xhigh',
  input: [
    { type: 'text', text: 'Use this mockup', text_elements: [] },
    { type: 'image', url: 'https://example.test/mockup.png' },
  ],
}))

await adapter.send?.('thread-1', {
  images: [
    { kind: 'data', mediaType: 'image/png', data: 'AQID' },
    { kind: 'local', path: '/repo/mockup.png', mediaType: 'image/png' },
  ],
})
expect(runtime.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({
  threadId: 'thread-1',
  input: [
    { type: 'image', url: 'data:image/png;base64,AQID' },
    { type: 'localImage', path: '/repo/mockup.png' },
  ],
}))

await expect(adapter.send?.('thread-1', {
  text: 'Invalid codex settings',
  runtimeSettings: { permissionMode: 'bypassPermissions', effort: 'max' },
})).rejects.toMatchObject({ code: 'FRESH_AGENT_UNSUPPORTED_RUNTIME_SETTING' })

await adapter.interrupt?.('thread-1')
expect(runtime.interruptTurn).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-1' })

await expect(adapter.interrupt?.('thread-without-active-turn'))
  .rejects.toMatchObject({ code: 'FRESH_AGENT_NO_ACTIVE_TURN' })

runtime.readThread.mockResolvedValue({
  thread: schemaValidThread({
    id: 'thread-resumed-running',
    status: { type: 'active', activeFlags: [] },
    turns: [],
  }),
})
runtime.listThreadTurns.mockResolvedValue({
  data: [schemaValidTurn({ id: 'turn-running-1', status: 'inProgress', items: [] })],
  nextCursor: null,
  backwardsCursor: null,
})
await adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-resumed-running' })
await adapter.interrupt?.('thread-resumed-running')
expect(runtime.interruptTurn).toHaveBeenCalledWith({
  threadId: 'thread-resumed-running',
  turnId: 'turn-running-1',
})

runtime.forkThread.mockResolvedValue(schemaValidThreadLifecycleResult({ thread: schemaValidThread({ id: 'thread-fork-1', turns: [] }) }))
await expect(adapter.fork?.('thread-1', { excludeTurns: true }))
  .resolves.toMatchObject({ sessionId: 'thread-fork-1', parentThreadId: 'thread-1' })

await expect(adapter.startReview?.('thread-1')).resolves.toMatchObject({
  turnId: expect.any(String),
  reviewThreadId: 'thread-1',
  target: { type: 'uncommittedChanges' },
  delivery: 'inline',
})
expect(runtime.startReview).toHaveBeenCalledWith({
  threadId: 'thread-1',
  target: { type: 'uncommittedChanges' },
  delivery: 'inline',
})

await expect(adapter.listThreads?.({ limit: 25 })).resolves.toMatchObject({
  sessionType: 'freshcodex',
  provider: 'codex',
  items: [expect.objectContaining({ sessionType: 'freshcodex', provider: 'codex', runtimeProvider: 'codex' })],
  nextCursor: null,
  backwardsCursor: null,
})

runtime.listThreads.mockResolvedValue({
  data: [schemaValidThread({
    id: 'thread-child-1',
    source: { subAgent: { thread_spawn: {
      parent_thread_id: 'thread-parent-1',
      depth: 1,
      agent_path: null,
      agent_nickname: 'reviewer',
      agent_role: 'review',
    } } },
    turns: [],
  })],
  nextCursor: null,
  backwardsCursor: null,
})
await expect(adapter.listThreads?.({ limit: 25 })).resolves.toMatchObject({
  items: [expect.objectContaining({
    sessionId: 'thread-child-1',
    source: expect.objectContaining({
      subAgent: expect.objectContaining({
        thread_spawn: expect.objectContaining({ parent_thread_id: 'thread-parent-1' }),
      }),
    }),
    parentThreadId: 'thread-parent-1',
  })],
})

runtime.listModels.mockResolvedValue({
  data: [schemaValidModel({ id: 'model-page-1', model: 'model-page-1' })],
  nextCursor: 'next-model-page',
})
await expect(adapter.listModels?.({ limit: 25 })).resolves.toMatchObject({
  items: [expect.objectContaining({ id: 'model-page-1' })],
  nextCursor: 'next-model-page',
})

await expect(adapter.getTurnPage?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1' }, { revision: 7, limit: 25, sortDirection: 'desc' }))
  .resolves.toMatchObject({ provider: 'codex', threadId: 'thread-new-1' })

await adapter.getTurnPage?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1' }, { revision: 7, limit: 25, sortDirection: 'desc' })
await expect(adapter.getTurnBody?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1', turnId: 'turn-1' }, 7))
  .resolves.toMatchObject({ provider: 'codex', threadId: 'thread-new-1', turnId: 'turn-1' })
expect(runtime.readThread).not.toHaveBeenCalledWith({ threadId: 'thread-new-1', includeTurns: true })
```

Require server-request approval mapping:

```ts
emitServerRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'npm test' })
expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.snapshot.invalidate' }))
expect(await adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-1' }))
  .toMatchObject({ pendingApprovals: [{ requestId: expect.stringContaining('cmd-1') }] })
```

Add table-driven server-request coverage for every local generated `ServerRequest` method. Build each request with a helper that parses `{ id, method, params }` through `CodexServerRequestSchema` before the adapter sees it, because several request variants have required structured params beyond `threadId`. `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `item/permissions/requestApproval` become pending approvals; `item/tool/requestUserInput` and `mcpServer/elicitation/request` become pending questions; `item/tool/call` receives an explicit generated-shape dynamic-tool result such as `{ contentItems: [{ type: 'inputText', text: 'Dynamic tool calls are not supported by Freshell yet.' }], success: false }`; `account/chatgptAuthTokens/refresh` receives a JSON-RPC error response on the same request id because its success shape requires real token fields and, because it has no `threadId`, also emits a runtime-global `freshAgent.error` or equivalent runtime event to all subscribed Freshcodex panes for that rich runtime. Deprecated `applyPatchApproval` and `execCommandApproval` are mapped to legacy approval prompts only if generated schema still includes them. `serverRequest/resolved` must remove matching pending approval/question/request state by generated `requestId`.

The same table must verify response serialization for each interactive request method through the fresh-agent action contract, not only through low-level client tests:

```ts
await adapter.respondToServerRequest?.('thread-1', {
  requestId: 'user-input-1',
  kind: 'tool_user_input',
  answers: { choice: { answers: ['a'] } },
})
expect(runtime.respondToServerRequest).toHaveBeenCalledWith('user-input-1', {
  answers: { choice: { answers: ['a'] } },
})

await adapter.respondToServerRequest?.('thread-1', {
  requestId: 'mcp-elicit-1',
  kind: 'mcp_elicitation',
  action: 'accept',
  content: { selected: true },
  _meta: null,
})
expect(runtime.respondToServerRequest).toHaveBeenCalledWith('mcp-elicit-1', {
  action: 'accept',
  content: { selected: true },
  _meta: null,
})

await adapter.respondToServerRequest?.('thread-1', {
  requestId: 'permissions-1',
  kind: 'permissions_approval',
  permissions: grantedPermissionFixture,
  scope: 'session',
})
expect(runtime.respondToServerRequest).toHaveBeenCalledWith('permissions-1', {
  permissions: grantedPermissionFixture,
  scope: 'session',
})

await adapter.respondToServerRequest?.('thread-1', {
  requestId: 'dynamic-tool-1',
  kind: 'dynamic_tool',
  contentItems: [{ type: 'inputText', text: 'Dynamic tool calls are not supported by Freshell yet.' }],
  success: false,
})
expect(runtime.respondToServerRequest).toHaveBeenCalledWith('dynamic-tool-1', {
  contentItems: [{ type: 'inputText', text: 'Dynamic tool calls are not supported by Freshell yet.' }],
  success: false,
})
```

Add table-driven notification coverage for every local generated `ServerNotification` method that can change visible Freshcodex state:

```ts
function emitSchemaValidNotification(method: string, overrides: Record<string, unknown> = {}) {
  const params = schemaValidNotificationParams(method, overrides)
  const notification = CodexServerNotificationSchema.parse({ method, params })
  emitNotification(notification.method, notification.params)
}

it.each([
  ['turn/started'],
  ['turn/completed'],
  ['item/started'],
  ['item/completed'],
  ['thread/status/changed'],
  ['thread/tokenUsage/updated'],
  ['turn/diff/updated'],
  ['turn/plan/updated'],
  ['thread/compacted'],
  ['thread/name/updated'],
  ['thread/closed'],
  ['thread/archived'],
  ['thread/realtime/error'],
])('invalidates the Freshcodex snapshot for %s notifications', async (method) => {
  const listener = vi.fn()
  await adapter.subscribe?.('thread-1', listener)
  emitSchemaValidNotification(method, { threadId: 'thread-1' })
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({
    type: 'freshAgent.snapshot.invalidate',
    sessionType: 'freshcodex',
    provider: 'codex',
    threadId: 'thread-1',
    reason: method,
  }))
})
```

If the generated schema uses different method names or params, use the generated names and generated params in the test table. The executor must add every visible-state notification method present in `ServerNotification.json`; do not shrink the table to the example above. Do not emit `{ threadId }`-only fake notifications for methods whose generated params require a `Turn`, `ThreadItem`, token-usage object, realtime payload, or another structured body; every notification fixture must parse through `CodexServerNotificationSchema` before it reaches the adapter.

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
export function normalizeCodexItem(raw: unknown): FreshAgentTranscriptItem[]
export function normalizeCodexTurnBody(input: { sessionType: 'freshcodex'; provider: 'codex'; threadId: string; revision: number; rawTurn: CodexTurn }): FreshAgentTurnBody
export function normalizeCodexTurnPage(input: { threadId: string; revision: number; page: CodexThreadTurnsListResult }): FreshAgentTurnPage
export function normalizeCodexThreadSnapshot(input: ...): FreshAgentThreadSnapshot
```

Map generated Codex status objects explicitly. The current app-server schema represents thread status as `{ type: 'notLoaded' | 'idle' | 'systemError' | 'active', activeFlags?: [...] }`, not as a bare string. Preserve active flags such as `waitingOnApproval` and `waitingOnUserInput` under the Codex extension while mapping them to a shared running status:

```ts
export function normalizeCodexThreadStatus(raw: unknown): FreshAgentThreadStatus {
  const parsed = CodexThreadStatusSchema.parse(raw)
  switch (parsed.type) {
    case 'notLoaded':
    case 'idle':
      return 'idle'
    case 'systemError':
      return 'error'
    case 'active':
      return 'running'
  }
}
```

Throw a clear `UnsupportedCodexItemError` for item types not intentionally modeled. Normalize actual app-server shapes from the generated `Thread` / `Turn` / `ThreadItem` schemas:

```ts
export function normalizeCodexThreadSnapshot(input: {
  thread: CodexThread
  normalizedRevision: number
  pendingApprovals: PendingCodexApproval[]
  pendingQuestions: PendingCodexQuestion[]
  tokenUsage?: FreshAgentThreadSnapshot['tokenUsage']
}): FreshAgentThreadSnapshot

export function normalizeCodexTurnPage(input: {
  sessionType: 'freshcodex'
  provider: 'codex'
  threadId: string
  revision: number
  page: CodexThreadTurnsListResult // { data, nextCursor, backwardsCursor }
}): FreshAgentTurnPage
```

Do not read `rawSnapshot.revision`, `rawSnapshot.turns`, or `page.turns`; those are stale assumptions from Freshell's provisional protocol. Use `raw.thread` from `thread/read { includeTurns: false }` for snapshot metadata and `page.data` from `thread/turns/list` for turn bodies. `normalizeCodexTurnPage` should place each page turn's normalized body on the matching `FreshAgentTurnSummary.body` and should also populate the adapter's bounded turn-body cache.
Do not require or synthesize a turn-level role for Codex. `normalizeCodexTurnBody` must set `role` only when a legacy provider supplies one, and must preserve Codex user/assistant roles on `message` transcript items. `normalizeCodexItem` must return an array and `normalizeCodexTurnBody` must flatten those arrays:

```ts
const items = rawTurn.items.flatMap((item) => normalizeCodexItem(item))
const codexUnixSecondsToIso = (value: number | null | undefined) => (
  typeof value === 'number' ? new Date(value * 1000).toISOString() : undefined
)
return FreshAgentTurnBodySchema.parse({
  sessionType: 'freshcodex',
  provider: 'codex',
  threadId,
  turnId: rawTurn.id,
  revision,
  source: 'durable',
  startedAt: codexUnixSecondsToIso(rawTurn.startedAt),
  completedAt: codexUnixSecondsToIso(rawTurn.completedAt),
  items,
})
```

The `startedAt` and `completedAt` conversion is required because the local Codex app-server schema emits Unix seconds, while the fresh-agent UI contract uses ISO strings. Tests should include non-null numeric timestamps and assert the ISO conversion so the raw Codex schema is not accidentally modeled as strings.

In `adapter.ts`, track per-thread ephemeral live state:

```ts
type CodexLiveThreadState = {
  pendingApprovals: Map<string, PendingCodexApproval>
  pendingQuestions: Map<string, PendingCodexQuestion>
  activeTurnId?: string
  latestRevision?: number
  tokenUsage?: FreshAgentThreadSnapshot['tokenUsage']
}
```

Implement `adapter.subscribe(sessionId, listener)` for Codex by subscribing to the rich runtime notification stream and translating visible app-server events into fresh-agent events:

```ts
return await runtime.subscribe(sessionId, (event) => {
  if (isCodexServerRequest(event)) {
    if (!hasThreadId(event)) {
      respondToUnsupportedRuntimeGlobalRequest(event)
      listener({ type: 'freshAgent.error', sessionId, sessionType: 'freshcodex', provider: 'codex', code: 'FRESH_AGENT_UNSUPPORTED_AUTH_REFRESH', message: 'Freshell cannot refresh Codex ChatGPT auth tokens from this runtime.', retryable: false })
      return
    }
    updatePendingRequestState(sessionId, event)
    listener({ type: 'freshAgent.snapshot.invalidate', sessionType: 'freshcodex', provider: 'codex', threadId: sessionId, reason: event.method })
    return
  }
  if (isVisibleCodexNotification(event)) {
    updateLiveThreadStateFromNotification(sessionId, event)
    listener({ type: 'freshAgent.snapshot.invalidate', sessionType: 'freshcodex', provider: 'codex', threadId: sessionId, reason: event.method })
  }
})
```

`turn/started` and `turn/completed` must update `activeTurnId`; `thread/tokenUsage/updated` must update `tokenUsage` in live state so the next snapshot rebuild includes current token counts; status, diff, review, compaction, item, metadata/name, close/archive, realtime error/close, and child-agent/collaboration notifications must invalidate the snapshot so every subscribed browser refreshes from the normalized app-server source. Non-visible notifications may be ignored only through an explicit allowlist with a comment naming why they do not affect the Freshcodex UI.
`getSnapshot` and `resume` must also recover `activeTurnId` without loading the full transcript. First read metadata with `thread/read { includeTurns: false }`, then fetch a bounded newest-first page with `thread/turns/list { limit: 10, sortDirection: 'desc' }` and select the newest `status: 'inProgress'` turn if present. This is required for interrupt to work after a browser reconnect, server restart, or adapter resubscription that missed the original `turn/started` notification while preserving long-transcript scalability.

Implement `send`, `interrupt`, `fork`, and `respondToServerRequest` using the Freshcodex stdio rich runtime from Task 4, not the websocket launch planner runtime. `send` must store the active turn id from `turn/start -> { turn }`; `turn/started`, `turn/completed`, and runtime close/error notifications must keep `activeTurnId` current. `interrupt(locator)` remains the Fresh-agent API because the UI interrupts the active turn, but the Codex adapter must translate that to `turn/interrupt { threadId, turnId: activeTurnId }` and return a clear `FRESH_AGENT_NO_ACTIVE_TURN` action error if there is no active turn. `respondToServerRequest` must look up the pending request by generated request id, validate that the response `kind` matches the original generated server request method, serialize the generated response shape, and respond on the original JSON-RPC server request id. Do not keep separate `resolveApproval` / `answerQuestion` action paths for Codex; those names encourage collapsing permissions approvals, request-user-input prompts, and MCP elicitations into the wrong Claude-shaped payload.

Carry runtime settings into both create/resume and turn start. Add `sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'` to `FreshAgentCreateRequest`, `FreshAgentPaneContent`, and the fresh-agent create WS payload. Replace the old create-message effort enum with the shared runtime-settings schema so Freshcodex create can carry generated Codex effort values such as `xhigh` and granular approval policy objects:

```ts
export const FreshAgentCreateSchema = z.object({
  type: z.literal('freshAgent.create'),
  requestId: z.string().min(1),
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema.optional(), // omitted only when resolved from the session-type registry
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: FreshAgentRuntimeSettingsSchema.shape.model,
  sandbox: FreshAgentRuntimeSettingsSchema.shape.sandbox,
  permissionMode: FreshAgentRuntimeSettingsSchema.shape.permissionMode,
  effort: FreshAgentRuntimeSettingsSchema.shape.effort,
  plugins: z.array(z.string()).optional(),
})
```

Also update the server-to-client create response so the newly created session immediately carries the same locator shape:

```ts
| {
    type: 'freshAgent.created'
    requestId: string
    sessionId: string
    sessionType: string
    provider: string
    runtimeProvider?: string
  }
| { type: 'freshAgent.create.failed'; requestId: string; sessionType?: string; provider?: string; code: string; message: string; retryable?: boolean }
```

Resolve Freshcodex defaults from provider settings when the pane is created, then include `model`, `sandbox`, Codex-shaped `permissionMode` as generated `approvalPolicy`, and Codex-shaped `effort` in `thread/start`, `thread/resume`, and `turn/start` where the generated schema supports them. Tests must prove a pane with model/sandbox/permission/effort settings creates the Codex thread with those values and sends a later turn with the same values unless the user changes them. Tests must also prove Freshcodex rejects legacy Claude-only values (`permissionMode: 'bypassPermissions'`, `effort: 'max'`) before calling Codex app-server, including through `freshAgent.create` parsing rather than only through later send actions.

Implement explicit runtime-setting mappers:

```ts
import path from 'node:path'

export function mapFreshcodexApprovalPolicy(value: FreshAgentRuntimeSettings['permissionMode']): CodexApprovalPolicy | undefined {
  if (value === undefined) return undefined
  return CodexApprovalPolicySchema.parse(value)
}

export function mapFreshcodexReasoningEffort(value: FreshAgentRuntimeSettings['effort']): CodexReasoningEffort | undefined {
  if (value === undefined) return undefined
  return CodexReasoningEffortSchema.parse(value)
}

export function mapFreshcodexSandboxModeToTurnPolicy(
  sandbox: FreshAgentRuntimeSettings['sandbox'],
  cwd: string | undefined,
): CodexSandboxPolicy | undefined {
  switch (sandbox) {
    case undefined:
      return undefined
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'read-only':
      return { type: 'readOnly', networkAccess: false }
    case 'workspace-write':
      if (!cwd || !path.isAbsolute(cwd)) throw new FreshAgentUnsupportedRuntimeSettingError('workspace-write turn sandbox requires an absolute cwd')
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
  }
}
```

Use `sandbox` only for `thread/start`, `thread/resume`, and `thread/fork`; use `mapFreshcodexSandboxModeToTurnPolicy()` for `turn/start`. Do not pass the string `sandbox` field to `turn/start`.

Extend `FreshAgentSendSchema`, `FreshAgentRuntimeAdapter.send`, `FreshAgentRuntimeManager.send`, and `server/ws-handler.ts` so turn-time runtime settings and typed image inputs cross the browser/server boundary. Import `FreshAgentInputImageSchema` and `FreshAgentRuntimeSettingsSchema` from `shared/fresh-agent-contract.ts`; do not duplicate those schemas in WebSocket protocol code:

```ts
export const FreshAgentSendSchema = z.object({
  type: z.literal('freshAgent.send'),
  sessionId: z.string().min(1),
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  text: z.string().optional(),
  images: z.array(FreshAgentInputImageSchema).optional(),
  runtimeSettings: FreshAgentRuntimeSettingsSchema.optional(),
}).refine((value) => Boolean(value.text?.trim() || value.images?.length), {
  message: 'Fresh-agent send requires text or an image',
})
```

Apply the same locator rule to `freshAgent.interrupt`, `freshAgent.fork`, approval/request response, review start, and any future fresh-agent action message: each action schema must include `sessionType` and `provider` alongside `sessionId`, and `server/ws-handler.ts` must pass the full locator to the runtime manager. Tests should send two attached records with the same `sessionId` and different providers, then prove each action reaches only the intended adapter.

Map input content explicitly. The Freshcodex composer/controller should pass image attachments as typed `FreshAgentInputImage` values; the adapter should convert remote URLs to Codex `{ type: 'image', url }`, convert `{ kind: 'data', mediaType, data }` into a valid `data:${mediaType};base64,${data}` URL before sending `{ type: 'image', url }`, and convert local file paths to `{ type: 'localImage', path }`. Existing Codex transcripts may contain `{ type: 'skill' }` and `{ type: 'mention' }` content parts; preserve them in normalized message content. If a new outbound input part cannot be represented by the generated schema, return a typed unsupported-capability error before starting the turn.

Extend `FreshAgentAttachSchema`, `FreshAgentRuntimeManager.attach`, and `FreshAgentRuntimeAdapter.attach?` so a saved Freshcodex pane can provide `cwd`, `model`, `sandbox`, `permissionMode`, and `effort` when it reattaches:

```ts
export const FreshAgentAttachSchema = z.object({
  type: z.literal('freshAgent.attach'),
  sessionId: z.string().min(1),
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  resumeSessionId: z.string().optional(),
  cwd: z.string().optional(),
  runtimeSettings: FreshAgentRuntimeSettingsSchema.optional(),
})
```

The Codex adapter must implement `ensureThreadLoaded(sessionId, context)` and call it before snapshot, subscribe, send, interrupt, fork, and start-review work. It should first try `thread/read { includeTurns: false }`; if the returned status is `{ type: 'notLoaded' }` or the app-server reports a lost/unloaded thread, call `thread/resume` with the attach/create context and then re-read metadata. If the thread still cannot be loaded, surface `FRESH_AGENT_LOST_SESSION` or `FRESH_AGENT_RUNTIME_UNAVAILABLE` with a clear pane error. This is required because a fresh stdio app-server process does not necessarily have browser-restored thread ids loaded in memory.

Convert `thread/fork -> { thread, ...metadata }` to the fresh-agent fork result at the adapter boundary:

```ts
const forked = await runtime.forkThread({ threadId: sessionId, excludeTurns: true })
return {
  sessionId: forked.thread.id,
  sessionType: 'freshcodex',
  provider: 'codex',
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
  const cached = turnBodyCache.get(`${thread.threadId}:${thread.turnId}`)
  if (!cached) throw new FreshAgentTurnBodyNotLoadedError(thread.threadId, thread.turnId)
  return cached
}
```

If a later generated schema adds a direct turn-read method, replace this cache facade in a focused follow-up. Do not add a nonexistent `thread/turn/read` call, and do not use `thread/read { includeTurns: true }` as a body-fetch fallback for long transcripts.

Extend WS protocol with `freshAgent.forked`:

```ts
| {
    type: 'freshAgent.forked'
    sourceSessionId: string
    sourceSessionType: string
    sourceProvider: string
    sessionId: string
    sessionType: string
    provider: string
    runtimeProvider?: string
    parentThreadId?: string
  }
```

Send it from `server/ws-handler.ts` after `freshAgent.fork`.

Extend client-to-server WS protocol with `freshAgent.review.start` and route it through `FreshAgentRuntimeManager.startReview(locator, { target, delivery })`:

```ts
export const FreshAgentReviewStartSchema = z.object({
  type: z.literal('freshAgent.review.start'),
  sessionId: z.string().min(1),
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  target: FreshAgentReviewTargetSchema.default({ type: 'uncommittedChanges' }),
  delivery: z.enum(['inline', 'detached']).default('inline'),
})

export const FreshAgentServerRequestRespondSchema = z.object({
  type: z.literal('freshAgent.serverRequest.respond'),
  sessionId: z.string().min(1),
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  response: FreshAgentServerRequestResponseSchema,
})

export type FreshAgentServerMessage =
  | { type: 'freshAgent.event'; sessionId: string; sessionType: string; provider: string; event: unknown }
  | { type: 'freshAgent.review.started'; sessionId: string; sessionType: string; provider: string; turnId: string; reviewThreadId: string; target: FreshAgentReviewTarget; delivery: 'inline' | 'detached' }
  | { type: 'freshAgent.killed'; sessionId: string; sessionType: string; provider: string; success: boolean }
  | { type: 'freshAgent.error'; sessionId?: string; sessionType?: string; provider?: string; requestId?: string; code: string; message: string; retryable?: boolean }
```

On success, emit `freshAgent.review.started` with the returned `reviewThreadId` and full `{ sessionType, provider, sessionId }` locator, then emit a `freshAgent.event` invalidation for the same session so the workspace panel refreshes review output. On failure, emit `freshAgent.error` with a typed code and locator fields whenever the failure is session-specific. Preserve `reviewThreadId` in the Codex extension or review metadata when the snapshot refresh observes review items; do not collapse detached and inline reviews into only the source thread id.

Extend the fresh-agent adapter/runtime contract with implemented Codex methods that Task 4 classified as supported:

```ts
startReview?(sessionId: string, input?: { target?: FreshAgentReviewTarget; delivery?: 'inline' | 'detached' }): Promise<{ turnId: string; reviewThreadId: string; target: FreshAgentReviewTarget; delivery: 'inline' | 'detached' }>
respondToServerRequest?(sessionId: string, response: FreshAgentServerRequestResponse): Promise<void>
listThreads?(query: { limit?: number; cursor?: string; sortDirection?: 'asc' | 'desc'; sourceKinds?: string[] }): Promise<FreshAgentThreadListPage>
listLoadedThreadIds?(query?: { limit?: number; cursor?: string }): Promise<{ ids: string[]; nextCursor: string | null }>
listModels?(query?: FreshAgentModelListQuery): Promise<FreshAgentModelListPage>
readModelProviderCapabilities?(): Promise<FreshAgentModelProviderCapabilities>
```

Do not leave these as raw `CodexAppServerClient` helpers only. If the shared UI does not expose a method in this plan, move it from the implemented set to the explicit unsupported set in Task 4.

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
  server/coding-cli/codex-app-server/rich-runtime.ts \
  server/fresh-agent/adapters/codex/normalize.ts \
  server/fresh-agent/adapters/codex/adapter.ts \
  server/fresh-agent/runtime-adapter.ts server/fresh-agent/runtime-manager.ts \
  shared/ws-protocol.ts server/ws-handler.ts src/lib/fresh-agent-ws.ts \
  src/store/paneTypes.ts \
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
- Modify: `src/store/paneTypes.ts`
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
  emitWs({
    type: 'freshAgent.forked',
    sourceSessionId: 'thread-1',
    sourceSessionType: 'freshcodex',
    sourceProvider: 'codex',
    sessionId: 'thread-fork-1',
    sessionType: 'freshcodex',
    provider: 'codex',
    runtimeProvider: 'codex',
    parentThreadId: 'thread-1',
  })
  expect(selectLayoutLeaves(store.getState(), 'tab-1')).toContainEqual(expect.objectContaining({
    content: expect.objectContaining({ kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex', sessionId: 'thread-fork-1' }),
  }))
})

it('sends Freshcodex text, images, and runtime settings without reading Claude state', async () => {
  renderFreshcodexPane({
    paneContent: {
      model: 'configured-model',
      sandbox: 'workspace-write',
      permissionMode: 'on-request',
      effort: 'xhigh',
    },
  })
  await user.type(screen.getByRole('textbox', { name: /chat message input/i }), 'Use this mockup')
  await attachImageUrl('https://example.test/mockup.png')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'freshAgent.send',
    sessionType: 'freshcodex',
    provider: 'codex',
    text: 'Use this mockup',
    images: [{ kind: 'url', url: 'https://example.test/mockup.png', mediaType: 'image/png' }],
    runtimeSettings: {
      model: 'configured-model',
      sandbox: 'workspace-write',
      permissionMode: 'on-request',
      effort: 'xhigh',
    },
  }))
})

it('attaches a restored Freshcodex pane with runtime context so the server can load the thread', async () => {
  renderFreshcodexPane({
    paneContent: {
      sessionId: 'thread-restored-1',
      resumeSessionId: 'thread-restored-1',
      initialCwd: '/repo',
      model: 'configured-model',
      sandbox: 'workspace-write',
      permissionMode: 'on-request',
      effort: 'xhigh',
    },
  })
  expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'freshAgent.attach',
    sessionId: 'thread-restored-1',
    sessionType: 'freshcodex',
    provider: 'codex',
    cwd: '/repo',
    runtimeSettings: {
      model: 'configured-model',
      sandbox: 'workspace-write',
      permissionMode: 'on-request',
      effort: 'xhigh',
    },
  }))
})

it('accepts pasted or uploaded browser images as data image inputs', async () => {
  renderFreshcodexPane()
  await uploadImageFile(new File([new Uint8Array([1, 2, 3])], 'mockup.png', { type: 'image/png' }))
  await user.type(screen.getByRole('textbox', { name: /chat message input/i }), 'Use this uploaded image')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'freshAgent.send',
    sessionType: 'freshcodex',
    provider: 'codex',
    text: 'Use this uploaded image',
    images: [expect.objectContaining({ kind: 'data', mediaType: 'image/png', data: expect.any(String) })],
  }))
})

it('responds to Codex request-user-input prompts with generated answer arrays', async () => {
  renderFreshcodexPane({ snapshot: snapshotWithToolUserInputRequest })
  await user.click(screen.getByRole('button', { name: /answer a/i }))
  expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'freshAgent.serverRequest.respond',
    sessionType: 'freshcodex',
    provider: 'codex',
    response: {
      requestId: 'user-input-1',
      kind: 'tool_user_input',
      answers: { choice: { answers: ['a'] } },
    },
  }))
})

it('responds to MCP elicitations with generated action/content metadata', async () => {
  renderFreshcodexPane({ snapshot: snapshotWithMcpElicitationRequest })
  await user.click(screen.getByRole('button', { name: /accept mcp input/i }))
  expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'freshAgent.serverRequest.respond',
    sessionType: 'freshcodex',
    provider: 'codex',
    response: {
      requestId: 'mcp-elicit-1',
      kind: 'mcp_elicitation',
      action: 'accept',
      content: expect.any(Object),
      _meta: null,
    },
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
- image attachment state passed from the composer to `freshAgent.send`
- retry/recovery state
- action dispatchers
- forked-pane creation through `splitPane`
- controlled load/create/action errors
- attach context for restored Freshcodex panes, including cwd and Codex runtime settings, so the server-side adapter can call `thread/resume` before snapshot/action work when a new app-server process has not loaded the thread

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
    send(text: string, images?: FreshAgentInputImage[], runtimeSettings?: FreshAgentRuntimeSettings): void
    interrupt(): void
    fork(): void
    startReview(target?: FreshAgentReviewTarget, delivery?: 'inline' | 'detached'): void
    retryCreate(): void
    respondToServerRequest(response: FreshAgentServerRequestResponse): void
  }
}
```

`FreshAgentRuntimeSettings` is a shared client/server shape for turn-time overrides:

```ts
type FreshAgentRuntimeSettings = {
  model?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  permissionMode?: CodexApprovalPolicy | ClaudePermissionMode
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}
```

Provider policy helpers must validate these union fields before action dispatch. Freshcodex may dispatch only generated Codex `approvalPolicy` and `effort` values; Freshclaude may keep its existing Claude-specific permission/effort values. The shell should show a controlled settings error if a migrated Freshcodex pane still contains Claude-only values.

`FreshAgentComposer.tsx` must support browser-representable image input directly, not only a test helper. Add an accessible image URL attachment control and file/paste handling that converts selected browser files to `{ kind: 'data', mediaType, data }` before dispatch. Keep `{ kind: 'local', path }` in the shared contract for server-side or restored Codex content, but do not pretend the browser can produce arbitrary local filesystem paths without an explicit server-side file picker.

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

When attaching a pane that already has `sessionId`, send:

```ts
ws.send({
  type: 'freshAgent.attach',
  sessionId,
  sessionType,
  provider,
  resumeSessionId: paneContent.resumeSessionId,
  cwd: paneContent.initialCwd,
  runtimeSettings: {
    model: paneContent.model,
    sandbox: paneContent.sandbox,
    permissionMode: paneContent.permissionMode,
    effort: paneContent.effort,
  },
})
```

Do not reduce attach to `{ sessionId, sessionType }` for Freshcodex; that loses the context needed to load the thread into a fresh stdio app-server runtime.

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
  src/store/paneTypes.ts \
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

- Use `snapshot.initialTurnPage` as the initial visible page when present. Snapshots should not expose or require a full `turns` array.
- If `snapshot.capabilities.turnPaging`, call `getFreshAgentTurnPage(sessionType, provider, threadId, { revision, priority: 'visible', limit, sortDirection })`; the server adapter maps this to Codex `thread/turns/list` without sending unsupported `revision` or `includeBodies` fields to app-server.
- Store turn summaries keyed by `turnId`; when a page summary includes `body`, render that body directly and cache it client-side.
- Hydrate body through `getFreshAgentTurnBody` only for providers or summaries that advertise an uncached body endpoint. For Codex, page results already contain the app-server `Turn` items, so the normal hydration path is loading the containing page, not calling a direct body endpoint and not a nonexistent Codex `thread/turn/read` method.
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
await user.click(screen.getByRole('button', { name: /start codex review/i }))
expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
  type: 'freshAgent.review.start',
  sessionId: 'thread-1',
}))
expect(screen.getByRole('region', { name: /worktree/i })).toHaveTextContent('feature/freshcodex')
expect(screen.getByRole('region', { name: /fork lineage/i })).toHaveTextContent('thread-parent-1')
expect(screen.getByRole('region', { name: /child threads/i })).toHaveTextContent('Review shell')
expect(screen.getByRole('button', { name: /mentioned file README.md/i })).toHaveTextContent('/repo/README.md')
expect(screen.getByRole('button', { name: /skill reviewer/i })).toHaveTextContent('reviewer')
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

- `message`: role-labelled user/assistant/system message with ordered text and image parts, preserving mixed Codex input content.
- `message` mention/skill parts: render preserved Codex `mention` and `skill` content parts as accessible inline chips with their names and paths.
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
- start-review action when `snapshot.capabilities.review` or the Codex extension says review is supported; disabled with a clear label otherwise
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
- Modify: `src/lib/session-type-utils.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/pane-activity.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/paneTreeValidation.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/persistedState.ts` if runtime-setting persistence schemas need versioned validation changes
- Modify: `src/store/managed-items.ts`
- Modify: `src/store/settingsThunks.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/ExtensionsView.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/panes/PanePicker.tsx`
- Modify: `src/components/SettingsView.tsx`
- Modify: `src/store/paneTypes.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `server/fresh-agent/router.ts`
- Modify: `server/session-directory/projection.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `shared/settings.ts`
- Test: `test/unit/shared/fresh-agent-registry.test.ts`
- Test: `test/unit/client/lib/derivePaneTitle.test.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`
- Test: `test/unit/client/lib/session-type-utils.test.ts`
- Test: `test/unit/client/lib/tab-registry-snapshot.test.ts`
- Test: `test/unit/client/lib/pane-activity.test.ts`
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`
- Test: `test/unit/client/store/storage-migration.fresh-agent.test.ts`
- Test: `test/unit/client/store/persisted-state.fresh-agent.test.ts`
- Test: `test/unit/client/components/TabsView.fresh-agent.test.tsx`
- Test: `test/unit/client/components/ExtensionsView.test.tsx`
- Test: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Test: `test/unit/client/components/panes/PanePicker.test.tsx`
- Test: `test/unit/server/fresh-agent/router.test.ts`
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

expect(projectFreshAgentSession(schemaValidThread({
  id: 'thread-child-1',
  source: { subAgent: { thread_spawn: {
    parent_thread_id: 'thread-parent-1',
    depth: 1,
    agent_path: null,
    agent_nickname: 'reviewer',
    agent_role: 'review',
  } } },
  turns: [],
}))).toMatchObject({
  provider: 'codex',
  sessionType: 'freshcodex',
  sessionId: 'thread-child-1',
  parentThreadId: 'thread-parent-1',
  source: expect.objectContaining({
    subAgent: expect.objectContaining({
      thread_spawn: expect.objectContaining({ parent_thread_id: 'thread-parent-1' }),
    }),
  }),
})

runtime.listThreads.mockResolvedValue({ data: [codexThread], nextCursor: null, backwardsCursor: null })
await expect(loadFreshcodexHistoryPage({ limit: 25 })).resolves.toMatchObject({
  items: [expect.objectContaining({ provider: 'codex', sessionType: 'freshcodex', sessionId: codexThread.id })],
  nextCursor: null,
  backwardsCursor: null,
})
expect(runtime.listThreads).toHaveBeenCalledWith(expect.objectContaining({
  limit: 25,
  sourceKinds: ['appServer', 'vscode', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'],
}))

runtime.listModels.mockResolvedValue({
  data: [{
    id: 'fixture-model',
    model: 'fixture-model',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Fixture Model',
    description: 'Fixture model for tests',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: [],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    isDefault: true,
  }],
  nextCursor: null,
})
runtime.readModelProviderCapabilities.mockResolvedValue({ namespaceTools: true, imageGeneration: false, webSearch: true })
await expect(loadFreshcodexModelPage({ limit: 25 })).resolves.toMatchObject({
  items: [expect.objectContaining({ id: 'fixture-model', supportsWebSearch: true })],
  nextCursor: null,
})
await expect(loadFreshcodexModelOptions()).resolves.toEqual(expect.arrayContaining([
  expect.objectContaining({ id: 'fixture-model', supportsWebSearch: true }),
]))

expect(createFreshcodexPaneFromSettings({
  codingCli: {
    providers: {
      codex: {
        model: 'configured-model',
        sandbox: 'workspace-write',
        permissionMode: 'on-request',
      },
    },
  },
  freshAgent: {
    providers: {
      freshcodex: {
        defaultEffort: 'xhigh',
      },
    },
  },
})).toMatchObject({
  kind: 'fresh-agent',
  provider: 'codex',
  sessionType: 'freshcodex',
  model: 'configured-model',
  sandbox: 'workspace-write',
  permissionMode: 'on-request',
  effort: 'xhigh',
})

expect(createFreshcodexPaneFromSettings({
  codingCli: {
    providers: {
      codex: {
        model: 'configured-model',
        sandbox: 'workspace-write',
        permissionMode: 'bypassPermissions',
      },
    },
  },
  freshAgent: {
    providers: {
      freshcodex: {
        defaultEffort: 'max',
      },
    },
  },
})).toMatchObject({
  kind: 'fresh-agent',
  provider: 'codex',
  sessionType: 'freshcodex',
  createError: expect.objectContaining({ code: 'FRESH_AGENT_UNSUPPORTED_RUNTIME_SETTING' }),
})
```

Also test that `buildResumeContent`, `TabsView` remote snapshot hydration, `collectPaneSnapshots`, `paneTreeValidation`, and pane persistence preserve Freshcodex `sandbox`, generated Codex effort values, and generated Codex approval policies without narrowing them to Claude strings:

```ts
expect(buildResumeContent({
  sessionType: 'freshcodex',
  sessionId: 'thread-1',
  cwd: '/repo',
  freshAgentProviderSettings: {
    defaultModel: 'configured-model',
    defaultSandbox: 'workspace-write',
    defaultPermissionMode: 'on-request',
    defaultEffort: 'xhigh',
  },
})).toMatchObject({
  kind: 'fresh-agent',
  provider: 'codex',
  sessionType: 'freshcodex',
  sandbox: 'workspace-write',
  permissionMode: 'on-request',
  effort: 'xhigh',
})

expect(collectPaneSnapshots({
  type: 'leaf',
  id: 'pane-1',
  content: {
    kind: 'fresh-agent',
    provider: 'codex',
    sessionType: 'freshcodex',
    resumeSessionId: 'thread-1',
    createRequestId: 'req-1',
    status: 'idle',
    sandbox: 'workspace-write',
    permissionMode: { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } },
    effort: 'xhigh',
  },
}, 'server-1')).toContainEqual(expect.objectContaining({
  payload: expect.objectContaining({
    sandbox: 'workspace-write',
    permissionMode: expect.objectContaining({ granular: expect.any(Object) }),
    effort: 'xhigh',
  }),
}))
```

Add persistence tests for browser-reloaded Freshcodex panes with valid Codex runtime settings and for legacy Freshcodex panes with Claude-only values. Valid panes must rehydrate unchanged and attach; legacy invalid panes must remain visible with a controlled `createError`, not be dropped, silently coerced, or replaced with a picker pane. Also test that `freshcodex` settings appear independently from Freshclaude where the UI exposes runtime settings, and `freshopencode` remains disabled/hidden.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- \
  test/unit/shared/fresh-agent-registry.test.ts \
  test/unit/client/lib/derivePaneTitle.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/pane-activity.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.fresh-agent.test.ts \
  test/unit/client/store/persisted-state.fresh-agent.test.ts \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/components/ExtensionsView.test.tsx \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/server/session-directory/fresh-agent-projection.test.ts
```

Expected: FAIL for any identity/title/sidebar/settings/history/snapshot gaps still coupled to `agent-chat` or Claude-shaped runtime assumptions.

- [ ] **Step 3: Implement identity fixes**

Rules:

- `freshcodex` title defaults to `Freshcodex`, then updates from the first user message or thread name when available.
- `provider: 'codex'` plus `sessionType: 'freshcodex'` is the session ref identity.
- `sandbox` is stored on fresh-agent pane content and comes from Codex provider settings, not from Claude/Freshclaude settings.
- `freshcodex` default permission/effort settings must be Codex-shaped. Replace any Freshcodex registry/default value that still uses Claude-specific permission modes such as `bypassPermissions` with a generated Codex approval policy such as `on-request`; replace any Freshcodex default effort that still uses Claude-only `max` with a generated Codex effort value. Do not mutate Freshclaude or Kilroy defaults.
- Split settings types so Codex and Claude defaults cannot be accidentally interchanged. In `shared/settings.ts`, stop typing `codingCli.providers.codex.permissionMode` and `freshAgent.providers.freshcodex.defaultEffort` with Claude-only aliases. Introduce Codex-specific approval/effort/sandbox schemas based on the generated app-server values, keep Claude-specific settings for Freshclaude/Kilroy, and migrate invalid legacy Freshcodex values into a visible `createError` rather than silently coercing them.
- Update `src/lib/session-type-utils.ts`, `src/store/tabsSlice.ts`, and `src/components/panes/PaneContainer.tsx` so Freshcodex creation and resume use Freshcodex settings from `freshAgent.providers.freshcodex` plus Codex CLI defaults from `codingCli.providers.codex`. Do not route Freshcodex through `getAgentChatProviderConfig()` or an `agentChatProviderSettings` parameter; those are Claude/Kilroy compatibility paths only.
- Update `src/lib/tab-registry-snapshot.ts`, `src/components/TabsView.tsx`, `src/store/paneTreeValidation.ts`, and pane persistence schemas/tests so Freshcodex `sandbox`, generated Codex effort values, and structured/generated approval policies are preserved in local and remote tab snapshots. Remote snapshots must not cast Freshcodex effort back to `'low' | 'medium' | 'high' | 'max'`, must not cast structured approval policy objects to strings, and must not omit `sandbox`.
- Update `src/store/managed-items.ts`, `src/components/ExtensionsView.tsx`, and `src/store/settingsThunks.ts` where provider settings are exposed or sanitized so Codex provider settings do not offer or accept Claude permission modes for Freshcodex defaults. If raw Codex terminal settings still need a narrower CLI-specific representation, model that separately from Freshcodex rich runtime settings.
- Add fresh-agent REST/API surfaces for the adapter methods classified as implemented in Task 5: list Freshcodex threads, list loaded Freshcodex thread ids, list models, and read model-provider capabilities. These should be typed in `server/fresh-agent/runtime-manager.ts`, exposed by `server/fresh-agent/router.ts`, parsed in `src/lib/api.ts`, and consumed by history/settings UI. Do not leave `thread/list`, `thread/loaded/list`, `model/list`, or `modelProvider/capabilities/read` as uncalled low-level app-server helpers after classifying them as implemented. The thread-list surface must reflect the generated app-server shape after fresh-agent normalization (`{ items, nextCursor, backwardsCursor }`) rather than returning a bare array; the loaded-list surface must reflect the generated app-server shape (`{ ids, nextCursor }` after fresh-agent normalization), or explicitly hydrate those ids with `thread/read`; it must not return fake `FreshAgentSessionSummary` rows from `thread/loaded/list` alone. The model-list surface must likewise reflect the generated paginated shape after fresh-agent normalization (`{ items, nextCursor }`) rather than returning a bare first-page array.
- Feed Freshcodex history/session rows from the Codex rich adapter's `thread/list` results where available, projected through `session-directory` with `sessionType: 'freshcodex'` and `provider: 'codex'`. Existing file/indexer-derived Codex terminal history may remain for raw Codex terminal panes, but it must not be the only source for Freshcodex rich threads. The Freshcodex history query must pass explicit generated `sourceKinds` for rich app-server sessions, locally created app-server threads reported as `vscode`, and child-agent sessions, at least `['appServer', 'vscode', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther']`, rather than relying on the app-server default source filter. This keeps locally created Freshcodex threads, app-server-created threads, review threads, compaction subagent threads, and spawned child-agent threads visible even if Codex changes the default "interactive" source set.
- Preserve generated `Thread.source` separately from the `thread/list` `sourceKinds` filter. For subagent threads, parse and store nested `SessionSource` metadata such as `{ subAgent: { thread_spawn: ... } }`; derive `parentThreadId`, child-thread labels, and fork/child UX from that nested metadata where available. Do not flatten returned `Thread.source` into the source-kind filter enum because that loses spawned-agent parent ids, depth, nickname, and role.
- Feed Freshcodex model/settings options from `model/list` plus `modelProvider/capabilities/read` and cache them behind the fresh-agent adapter boundary. `loadFreshcodexModelPage` should preserve the page cursor for settings UIs that can page model options; any `loadFreshcodexModelOptions` convenience helper that returns an array must explicitly iterate pages until `nextCursor` is null and fail on cursor cycles or an excessive page count instead of silently truncating. If the runtime is unavailable, show a typed runtime-unavailable settings error rather than falling back to stale Claude model defaults.
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
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/pane-activity.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.fresh-agent.test.ts \
  test/unit/client/store/persisted-state.fresh-agent.test.ts \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/components/ExtensionsView.test.tsx \
  test/unit/client/components/HistoryView.mobile.test.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx \
  test/unit/client/components/panes/PanePicker.test.tsx \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/server/session-directory/fresh-agent-projection.test.ts \
  test/unit/server/coding-cli/session-indexer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
rg -n "freshcodex.*agentChat|agentChat.*freshcodex|state\\.agentChat.*freshcodex|kind: 'agent-chat'.*freshcodex" src server test
rg -n "agentChatSlice|agentChatTypes|agentChatThunks" src/store/freshAgentSlice.ts src/store/freshAgentTypes.ts src/store/freshAgentThunks.ts src/lib/pane-activity.ts
rg -n "effort.*'max'|as 'low' \\| 'medium' \\| 'high' \\| 'max'|permissionMode as string" src/lib/fresh-agent-registry.ts src/lib/session-type-utils.ts src/lib/tab-registry-snapshot.ts src/components/TabsView.tsx src/store/paneTreeValidation.ts
npm run typecheck
```

Expected: `rg` commands find no Freshcodex dependence on agent-chat state, no fresh-agent slice/type/thunk alias back to agent-chat modules, and no Freshcodex runtime-setting narrowing to Claude-only effort or string-only permission values; typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/fresh-agent-registry.ts src/lib/derivePaneTitle.ts src/lib/session-utils.ts \
  src/lib/session-type-utils.ts src/lib/tab-registry-snapshot.ts src/lib/api.ts \
  src/lib/pane-activity.ts \
  src/store/selectors/sidebarSelectors.ts src/components/HistoryView.tsx \
  src/components/ExtensionsView.tsx src/components/TabsView.tsx \
  src/components/panes/PaneContainer.tsx src/components/panes/PanePicker.tsx \
  src/components/SettingsView.tsx src/store/paneTypes.ts src/store/panesSlice.ts \
  src/store/paneTreeValidation.ts src/store/persistedState.ts src/store/tabsSlice.ts \
  src/store/managed-items.ts src/store/settingsThunks.ts \
  server/fresh-agent/runtime-manager.ts server/fresh-agent/router.ts \
  server/session-directory/projection.ts \
  server/coding-cli/session-indexer.ts shared/settings.ts \
  test/unit/shared/fresh-agent-registry.test.ts \
  test/unit/client/lib/derivePaneTitle.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/pane-activity.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.fresh-agent.test.ts \
  test/unit/client/store/persisted-state.fresh-agent.test.ts \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/components/ExtensionsView.test.tsx \
  test/unit/client/components/HistoryView.mobile.test.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx \
  test/unit/client/components/panes/PanePicker.test.tsx \
  test/unit/server/fresh-agent/router.test.ts \
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
it('refreshes both clients when a Codex turn/item/token/diff notification invalidates the Freshcodex snapshot', ...)
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

Use the fresh-agent specific error message added in Task 5 consistently in `shared/ws-protocol.ts` and handlers:

```ts
| { type: 'freshAgent.error'; sessionId?: string; sessionType?: string; provider?: string; requestId?: string; code: string; message: string; retryable?: boolean }
```

Use this message for fresh-agent action errors instead of generic `sendError`. Include `sessionType` and `provider` whenever `sessionId` is present so client-side reconnect/error handling never has to guess which runtime owns an opaque id.

In the controller:

- store last create request id sent per pane
- do not re-send create for a pane with an in-flight request unless retry explicitly changes `createRequestId`
- attach on reconnect if `sessionId` exists
- refresh snapshot on `freshAgent.event`, `freshAgent.error` when recoverable, and `freshAgent.forked`
- debounce notification-driven snapshot refresh per session so a burst of Codex item/token/diff events causes one near-term refresh, not one REST request per raw app-server notification
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
- Modify: `docs/plans/2026-05-03-freshcodex-contract-foundation-test-plan.md` only if implementation changes alter the living Freshcodex acceptance-test inventory; otherwise leave the test plan untouched
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
rg -n "freshcodex.*agent-chat|Freshcodex.*agent-chat|sdk\\.send.*freshcodex|kind: 'agent-chat'.*freshcodex|provider: 'freshcodex'" src server shared test docs/index.html
```

Expected: no stale Freshcodex-on-agent-chat references in product code, tests, shared contracts, or the public docs mock. Do not include `docs/plans/**` in this grep; the historical implementation plan itself intentionally describes stale references that the implementation is removing. Legacy Freshclaude/agent-chat references may remain where they are still intentional.

- [ ] **Step 4: Run full verification**

Use the coordinator gate for broad tests:

```bash
npm run lint
npm run audit:codex-app-server-schema
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
npm run lint
npm run audit:codex-app-server-schema
npm run build
FRESHELL_TEST_SUMMARY="freshcodex contract foundation post-main-merge" npm test
npm run test:e2e:chromium -- \
  test/e2e-browser/specs/fresh-agent.spec.ts \
  test/e2e-browser/specs/fresh-agent-mobile.spec.ts
```

Expected: clean merge or resolved conflicts in the worktree, all final gates pass after the merge. If the right-side count is zero, do not create a no-op merge commit.

- [ ] **Step 6: Commit**

```bash
git add \
  docs/index.html \
  test/e2e-browser/specs/fresh-agent.spec.ts \
  test/e2e-browser/specs/fresh-agent-mobile.spec.ts \
  docs/plans/2026-05-03-freshcodex-contract-foundation-test-plan.md
git commit -m "Document and verify Freshcodex contract foundation"
```

If `docs/plans/2026-05-03-freshcodex-contract-foundation-test-plan.md` was not modified, omit it from `git add`.

## Final Acceptance Checklist

- `shared/fresh-agent-contract.ts` owns typed schemas for snapshots, turn pages, turn bodies, items, provider extensions, and action results.
- Server adapters and runtime manager parse every fresh-agent payload before returning it.
- Client API parses fresh-agent payloads and surfaces controlled errors.
- Session-type registry and runtime-provider adapter registry are separate; `freshclaude` and `kilroy` can share the Claude adapter without overwriting provider lookup.
- `src/store/freshAgentSlice.ts` and `src/store/freshAgentTypes.ts` are real fresh-agent state modules, not aliases/re-exports of agent-chat modules.
- `src/store/freshAgentThunks.ts` and `src/lib/pane-activity.ts` are fresh-agent-aware, key Freshcodex state by full `{ sessionType, provider, sessionId }` locators, and do not require Freshcodex sessions to exist in legacy agent-chat state.
- Codex app-server client supports thread fork, turn start, turn interrupt, notifications, and server-request responses according to generated local app-server schemas.
- Codex protocol schemas and fixtures reject impossible partial app-server entities; generated-required fields such as `Thread.turns`, `Thread.cwd`, and `Thread.updatedAt` are required in tests and runtime parsing.
- Codex generated leaf types for runtime settings, user input, statuses, and session/subagent source metadata are checked into the reduced schema fixture snapshot and covered by inventory tests; `Thread.source` preserves generated nested `SessionSource` / `SubAgentSource` metadata while `thread/list` filters use generated `ThreadSourceKind` values.
- Codex transcript items are fully normalized; no raw transcript item arrays cross the fresh-agent boundary.
- Codex app-server notifications and server requests flow through the rich stdio runtime into fresh-agent subscriptions; live turns, items, token usage, status, diffs, review, compaction, child-thread/collaboration, and thread metadata updates refresh subscribed browsers.
- Codex runtime-global server requests without `threadId`, currently auth-token refresh, are answered with valid JSON-RPC error envelopes and surfaced as typed Freshcodex runtime errors instead of hanging or attaching to an arbitrary thread.
- Freshcodex renders without `agentChat` session state.
- Freshcodex normal snapshot and transcript paths are page-first; they do not load the full Codex thread body list for every snapshot or visible-row hydration.
- Freshcodex supports create, resume, send text/images with runtime settings, interrupt, fork, approvals, questions, diff/review/worktree/child-thread display, reconnect, retry, and stale revision recovery.
- Freshcodex starts Codex review through `review/start`, preserves `reviewThreadId`/target/delivery metadata, lists/resumes rich Codex threads through paginated `thread/list`, exposes loaded thread ids according to `thread/loaded/list`, and populates model/capability UI from paginated `model/list` plus `modelProvider/capabilities/read`.
- Freshcodex history APIs preserve `thread/list` `nextCursor` and `backwardsCursor`, and history queries explicitly include Codex rich app-server, local app-server-created `vscode` source, and all generated child-agent source kinds rather than relying on app-server defaults.
- Freshcodex settings/model APIs preserve `model/list` `nextCursor`; any dropdown convenience helper that returns a full option array explicitly drains pages and guards against cursor loops instead of truncating at the first page.
- Freshcodex create/resume settings are Codex-shaped across picker creation, history open, pane persistence, remote tab snapshots, and attach; `sandbox`, generated Codex approval policies, and generated Codex effort values are not dropped or narrowed to Claude-only types.
- Restored Freshcodex panes send attach context and load/resume the Codex app-server thread before snapshot or action work after a browser reload, server restart, or app-server process restart.
- Existing raw Codex terminal panes still launch through the websocket app-server planner and receive a valid loopback `wsUrl`.
- Long Freshcodex transcripts use paging and virtualization.
- Mobile Freshcodex composer, banners, and transcript remain usable with keyboard inset changes.
- Existing Freshclaude and hidden Kilroy paths still pass their targeted tests.
- No storage-clearing migration is introduced.
- `npm run lint`, `npm run audit:codex-app-server-schema`, `npm run build`, coordinated `npm test`, and targeted Freshcodex browser specs pass.
