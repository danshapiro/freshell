# Plan: freshclaude/kilroy transcript and live rendering (audit gaps G10, G12, G13)

Repo: Freshell. Worktree: `/home/dan/code/freshell/.worktrees/freshclaude-parity` (branch `feat/freshclaude-parity`, identical to `origin/main` 1c7e4dff7 when this plan was written). This document is design only; no repo file was changed.

Scope: freshclaude and kilroy (provider `claude`, one runtime). Shared code changes only where a freshclaude problem is best fixed there. No new codex/opencode features. The core-runtime workstream (G01–G09, G14–G16, G21–G24, G27, G32) is planned separately; section 7 lists the interfaces between the two.

---

## 1. Summary

Today a visible freshclaude pane shows a running turn only through a 3-second poll. Streamed text is folded into Redux but never rendered, and every token rewrites the `freshAgent.sessions` map that six app-wide components subscribe to. The sidecar drops retries, rate limits, compaction failures, permission-mode changes and tool results. The snapshot drops compaction markers, subagent work, diffs, images, command output and token usage.

The plan has four parts:

1. **One projection for durable content (Rust).** The Claude transcript file stays the single source of truth for anything the CLI persists. `claude_snapshot.rs` gains a stateful projector that emits the item shapes codex/opencode already use: `context_compaction`, `task_delegation` (with activity rows read from the subagent transcript), turn `error`, `[image]` placeholders, slash-command output, a `diffs` summary built from `structuredPatch`, and `tokenUsage` from the same parser the session indexer uses.
2. **Per-message invalidation (sidecar → Rust → client).** The sidecar announces every message the CLI will persist (`sdk.session.changed {reason:'transcript', uuid}`). The client already refetches on that event type (250 ms debounce, single-flight). A small landing check re-polls if the CLI's ~100 ms write delay made the refetch miss the line. An incremental parse cache keeps per-message refetches cheap.
3. **A client-only live tail for what the file cannot hold yet.** Streaming text/thinking blocks, a "tool starting" row, and API retries live in a new `freshAgentLive` slice, fed by a 100 ms stream batcher. The tail is rendered by one small component that reuses the transcript's own turn renderer. Token deltas never touch `freshAgent.sessions`.
4. **Status surfaces.** Retries render as the existing `retry` activity row. Compaction success or failure, rate limits and informational messages arrive as a new non-terminal `freshAgent.notice`. Plan-mode exits converge the pane's permission mode through `freshAgent.session.metadata`.

No schema change is needed in `shared/fresh-agent-contract.ts`. Every new item uses an existing kind and an existing renderer.

---

## 2. Verified current behavior (file:line in the worktree)

### 2.1 Sidecar (`crates/freshell-claude-sidecar/index.mjs`)
- `handleSdkMessage` forwards only: replayed user frames (for checkpoint identity, :243-263), `system/init` (:265-278), `commands_changed` (:279-285), `status:'compacting'` (:286-287), `compact_boundary` (:288-299, relayed as `sdk.compact_boundary`, which Rust consumes and never broadcasts), `assistant` (:302-312), `result` (:314-339) and `stream_event` (:340-342). Everything else falls into `default` and is dropped (:344-346).
- Dropped as a result: `system/api_retry`, `rate_limit_event`, `status` frames carrying `compact_result`, `compact_error` or `permissionMode`, non-replay `user` frames (tool results, compact summary), `task_*` system messages, `informational`.
- The `assistant` frame is reduced to `{content, model}` with no `uuid`, `message.id` or `parent_tool_use_id` (:303-311).
- Every `stream_event` is forwarded verbatim, including subagent (`parent_tool_use_id`) events, `input_json_delta`, `signature_delta`, `message_delta` and `message_stop` (:340-342). `includePartialMessages: true` (:447).
- `resultErrorMessage` returns `undefined` for `subtype:'success'`, so a success result with `is_error:true` (API error) gets no banner (`session-settings.mjs:47-48`).

### 2.2 Rust (`crates/freshell-freshagent/src/claude.rs`, `claude_snapshot.rs`)
- `normalize_sdk_type` (claude.rs:9338-9362) has no entry for retry, notice or compact frames. `sdk_line_to_frame` returns `None` for unknown types (:9318-9320), so they are never broadcast.
- The consumer (claude.rs:8307 `spawn_consumer`; arms at :8445-8650) folds `last_status` from `sdk.assistant`, `sdk.result` and `sdk.status` (:8666-8676). An `sdk.session.changed` without reason `session-commands` falls through to the broadcast unchanged (:8445-8451), so a new announcement reason needs no Rust change.
- `parse_transcript_turn_indexed` keeps only `type: user|assistant` (claude_snapshot.rs:455-458). It skips `isMeta`, `isSidechain`, `isCompactSummary` and `isVisibleInTranscriptOnly` lines (:460-470). It projects only `text`, `thinking`, `tool_use` and `tool_result` blocks; image blocks hit `_ => {}` (:549). `tool_result_text` keeps text parts only, so image results become `""` (:587-600).
- `build_claude_snapshot_json` hard-codes `tokenUsage` to zero (:1159), `diffs: []` (:1163), `childThreads: []`, `worktrees: []` and `extensions: {}` (:1166). `capabilities.diffs` is absent.
- `get_claude_snapshot` re-reads and re-parses the whole JSONL on the async runtime thread for every GET (:1190-1230). There is no cache.
- `native_history.rs:398-431` reuses `parse_transcript_turn_indexed` per record, with bounded retention.
- `session_metadata_frame` states only `model` and `effort` (`session_metadata.rs:44-63`).

### 2.3 Client
- `fresh-agent-ws.ts:427-452`: `freshAgent.assistant` goes to `addAssistantMessage`. `freshAgent.stream` goes to `setStreaming(true)` on every `content_block_start`, `appendStreamDelta` on every `text_delta`, and `setStreaming(false)` on every `content_block_stop`.
- `freshAgentSlice.ts:611-652`: all four reducers write into `state.freshAgent.sessions[key]`. No component reads `streamingText`, `session.turns` or `historyItems` (grep: the only readers are the slice and its types). `pane-activity.ts:72` reads `streamingActive` for busy.
- Six components select the whole sessions map, so every token re-renders them: `TabBar.tsx:249`, `PaneContainer.tsx:205`, `MobileTabStrip.tsx:33`, `TabSwitcher.tsx:54`, `ContextMenuProvider.tsx:198`, and `Sidebar.tsx:396,462` (through its selector).
- `FreshAgentView.tsx:148-164`: `freshAgent.assistant` and `freshAgent.stream` are not in `SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS`. They are in `TRANSCRIPT_INVALIDATING` (:170-182), which only marks a hidden or already-dirty pane (:3147-3155). A visible pane therefore sees new content only through the 3000 ms busy poll (:4029-4042). `freshAgent.session.changed` IS snapshot-invalidating, and the shared scheduler debounces `event` triggers by 250 ms with single-flight and trailing coalescing (`fresh-agent-snapshot-scheduler.ts:30-34`).
- `turnResult` adds up `costUsd` (`freshAgentSlice.ts:585-597`), but the SDK's `total_cost_usd` is cumulative.
- `sessionMetadataReceived` has no `permissionMode` (`freshAgentSlice.ts:255-287`). The per-send `permissionMode` comes from pane content (`FreshAgentView.tsx:520, 1912, 2051`). So a mode change made by the CLI would be reverted by the next send.
- Renderers that already exist: `context_compaction` card (`FreshAgentItemCard.tsx:476-480`), `task_delegation` block with `↳` activity rows and optional "Open session" (:172-220), `retry` row (:222-229), activity-strip delegation and retry rows plus the "Retrying" reel (`FreshAgentTranscript.tsx:140-160, 666-677`), the durable turn error module (:990-1000), and the diff panel that fetches `git diff` per path (`FreshAgentDiffPanel.tsx:47-58`).
- `tool-preview.ts:1-34` has no case for `Agent`/`Task`, `TodoWrite`, `ExitPlanMode`, `MultiEdit` or `NotebookEdit`; they fall back to `JSON.stringify`.
- `openDelegationSession` hardcodes opencode (`FreshAgentView.tsx:4304-4314`). This is harmless for claude under this plan, because claude delegation items never carry `childSessionId` (section 4.3).

---

## 3. Real-CLI facts this plan depends on (pinned CLI 2.1.237 / SDK 0.3.237, local fake endpoint)

All probes are new and live under `/tmp/claude-1000/-home-dan-code-freshell/1374fc0b-889d-437e-b369-0aa473c2880f/scratchpad/live-probe/`:
- `probe-tools.mjs [sync] [slow]`
- `probe-compact.mjs ok|fail|retry|plan`
- `probe-image.mjs`

Plus `/tmp/claude-1000/-home-dan-code-freshell/1374fc0b-889d-437e-b369-0aa473c2880f/scratchpad/verify/probe-apierr.mjs` (run with `PROBE_STATUS=400`). Each run's output was printed to the terminal; the tools and compact probes also save a summary file (`*.out.jsonl`) next to the script. None of them contacts the real API.

| # | Fact | Evidence |
|---|---|---|
| F1 | An SDK `assistant`/`user` message `uuid` equals the JSONL line `uuid`. The SDK's `message.id` equals the line's `message.id`. | probe-tools: every uuid matched |
| F2 | One SDK `assistant` message per content block (thinking, text and tool_use each separate), all sharing `message.id`. One JSONL line per block. | probe-tools |
| F3 | Tool results arrive live as `type:'user'` (not replay) with `tool_use_result` equal to the JSONL `toolUseResult`. | probe-tools |
| F4 | Write `toolUseResult = {type:'create'\|'update', filePath, content, structuredPatch:[], originalFile}`. Edit `toolUseResult = {filePath, oldString, newString, originalFile, structuredPatch:[{oldStart,oldLines,newStart,newLines,lines:['-one','+two']}], replaceAll}`. | probe-tools |
| F5 | The subagent tool is named `Agent` on the wire and in the JSONL, but `Task` in `system/init.tools`. Live: `task_started`, `task_progress`, `task_updated`, `task_notification`, plus subagent `assistant`/`user` frames with `parent_tool_use_id`. Disk: `<projects>/<proj>/<sessionId>/subagents/agent-<agentId>.jsonl` (lines `isSidechain:true`) and `agent-<agentId>.meta.json {agentType, description, toolUseId, spawnDepth}`, written at spawn. | probe-tools sync and async |
| F6 | A synchronous Agent result has `toolUseResult = {status:'completed', agentId, agentType, content:[text], totalDurationMs, totalTokens, totalToolUseCount, usage, toolStats}`. An async/background Agent gets `{isAsync:true, status:'async_launched', agentId, outputFile}`. Later a USER line with `origin:{kind:'task-notification'}` and XML content (`<tool-use-id>`, `<status>`, `<result>`, `<usage><duration_ms>`) arrives and **starts a new unsolicited turn and result**. | probe-tools (async, the default when the model does not set `run_in_background:false`) |
| F7 | JSONL writes lag SDK emission by **95–130 ms** and land progressively mid-turn, in both the main and the subagent file. | probe-tools `slow` |
| F8 | Successful `/compact`: `status:'compacting'`, then `status:null, compact_result:'success'`, then `system/compact_boundary {compact_metadata:{trigger, pre_tokens, post_tokens, duration_ms}}`, then a non-replay user summary, then a replayed user `<local-command-stdout>Compacted </local-command-stdout>`, then the result. JSONL: `system/compact_boundary` (uuid equals the live uuid; `compactMetadata` in camelCase), a user `isCompactSummary` line, an `isMeta` caveat, a user `<command-name>/compact</command-name>…` line and a user `<local-command-stdout>` line. | probe-compact ok |
| F9 | Failed compaction: `status:null, compact_result:'failed', compact_error:'Error during compaction: API Error: 400 …'`, then an `assistant` frame with that text, then `result success`. JSONL: `system/local_command` containing `<local-command-stderr>…</local-command-stderr>` (uuid equals the assistant frame's uuid). "Not enough messages to compact." takes the same path. | probe-compact fail / ok (first run) |
| F10 | `/cost` (recorded as `<command-name>/usage</command-name>`) and `/context` arrive live as `assistant` text. The JSONL stores `system/local_command` with `<local-command-stdout>`. `/context` output is markdown (headings and tables). | probe-compact ok, verify/probe-local |
| F11 | `system/api_retry {attempt, max_retries:10, retry_delay_ms, error_status:529, error:'overloaded'}` is live only and never persisted. | probe-compact retry |
| F12 | After an `ExitPlanMode` approval: `system/status {status:null, permissionMode:'default'}`. | probe-compact plan |
| F13 | A user image attachment is stored inline as base64 in the user line. A `Read` of an image gives a `tool_result.content:[{type:'image', source:{base64…}}]` and `toolUseResult {type:'image', file:{base64,type,dimensions}}`. | probe-image |
| F14 | An API 400 gives an assistant line `{isApiErrorMessage:true, error:'unknown', apiErrorStatus:400, content:[text 'API Error: 400 …']}`, then `result {subtype:'success', is_error:true, terminal_reason:'api_error'}`. | verify/probe-apierr |
| F15 | `result.usage` adds up the turn's API calls. `modelUsage[model].contextWindow` is 200000. `getContextUsage()` returns camelCase `{totalTokens, maxTokens, percentage, categories…}`, which differs from the snake_case `SDKContextUsage` typing. | probe-tools |
| F16 | New noise types are emitted: `system/status {status:'requesting'}` before each API call, `command_lifecycle`, `thinking_tokens` and `background_tasks_changed`. | all probes |

---

## 4. Target behavior and design

### 4.1 Principles
- **P1. The transcript file is the authority for durable content.** Rust projects it with one projector. The client renders snapshot turns. No second projection of durable content exists in the client.
- **P2. The live tail holds only what the file cannot hold yet:** in-flight streaming text/thinking blocks, a "tool starting" row (name only), and the current API retry. Each tail block is bound to its SDK `uuid` and hidden as soon as a snapshot contains that uuid. This avoids flicker and duplicates.
- **P3. Token-rate state never enters `freshAgent.sessions`.** The sessions map changes at most a few times per turn (running, result), not per token.
- **P4. Non-terminal provider events (retry, rate limit, compaction outcome) never end a turn** and never use the error/`sessionError` path, which flips the session to idle.
- **P5. Existing item kinds and renderers only.** No contract schema change.

### 4.2 Wire contract changes (sidecar → Rust → client)

| Sidecar frame (stdout) | Rust | Client event | Purpose |
|---|---|---|---|
| `sdk.assistant {sessionId, content, model, uuid, messageId, parentToolUseId}` (fields added) | unchanged forward | `freshAgent.assistant` | Binds a tail block to its uuid |
| `sdk.stream {sessionId, event, parentToolUseId:null, messageId}`. Only top-level events of type `message_start`, `content_block_start`, `content_block_delta` (`text_delta`/`thinking_delta` only) and `content_block_stop`. Subagent, `input_json_delta`, `signature_delta`, `message_delta` and `message_stop` are dropped. | unchanged forward | `freshAgent.stream` | Live tail |
| **new** `sdk.session.changed {sessionId, reason:'transcript', uuid, parentToolUseId}`, once per SDK message the CLI persists: `assistant`, non-replay `user`, replayed `user` prompt or local-command stdout, `system/compact_boundary`, `system/local_command_output` (if a future CLI emits it) | unchanged forward (only `session-commands` is folded) | `freshAgent.session.changed` (already snapshot-invalidating) | Per-message refetch plus landing check |
| **new** `sdk.retry {sessionId, attempt, maxRetries, delayMs, errorStatus, error}` from top-level `system/api_retry` | normalize → `freshAgent.retry`; `tracing::info!` | `freshAgent.retry` | Retry row in the tail |
| **new** `sdk.notice {sessionId, level:'info'\|'warning'\|'error', code, message, rateLimit?}`. Sources: `status.compact_result==='failed'` → `COMPACTION_FAILED`; `rate_limit_event` with `allowed_warning` → `RATE_LIMIT_WARNING` or `rejected` → `RATE_LIMITED` (status `allowed` emits nothing); `system/informational` → `INFORMATIONAL` | normalize → `freshAgent.notice`; `tracing::warn!/info!` | `freshAgent.notice` | Pane notice banner (no idle flip) |
| `sdk.status {status:'running'}` when a `status:null` frame (compaction finished) arrives while `pendingResults > 0` | existing `last_status` fold | `freshAgent.status` | A pane stops saying "compacting" after an auto/manual compaction finishes mid-turn |
| **new** `sdk.session.metadata {sessionId, permissionMode}` when `status.permissionMode` differs from `st.settings.permissionMode`. The sidecar folds it into `st.settings` and `st.permissionMode` first. | consumer folds `permission_mode` into `configuration.settings`, then broadcasts | `freshAgent.session.metadata {permissionMode}` (key absent = "no statement", as for model/effort) | Plan-mode exit converges the pane |
| `session_metadata_frame(..., permission_mode: Option<&str>)`: claude configure/send paths state it; codex/opencode pass `None` | — | `freshAgent.session.metadata` | Multi-device permission-mode convergence |

Ignored on purpose: `status:'requesting'`, `thinking_tokens`, `command_lifecycle`, `background_tasks_changed`, `task_progress`, `task_started`, `task_updated` and `tool_progress`. Subagent progress reaches the UI through the subagent-file activity rows, which refresh on the `parentToolUseId` announcements. These announcements cover sidechain messages too: the subagent's own assistant and tool-result frames, which carry a `parentToolUseId`.

### 4.3 Rust: one projector for durable content

**Layer 1: per-line projection** (`parse_transcript_turn_indexed`, pure; also used by `native_history.rs`):
- `system/compact_boundary` → turn `{role:'system', items:[{id, kind:'context_compaction'}], summary:'Context compacted'}` (codex parity: `contextCompaction` is role `system`, `codex.rs:9411`).
- `system/local_command`, and `user` lines whose whole text is a `<local-command-stdout|stderr>` wrapper → role `system`. stdout becomes a `text` item with the wrapper stripped (renders as markdown because `markdown = !isUser`). stderr becomes `items:[]` plus `error:{name:'CommandError', message}`, which uses the existing durable error module.
- `user` lines starting with `<command-name>` → user `text` item `"/name args"`.
- `user` image blocks → `{kind:'text', text:'[image]'}` (exact codex parity, `codex.rs:26549-26562`). Image parts inside `tool_result` content flatten to `"[image]"`.
- `assistant` lines with `isApiErrorMessage:true` → `items:[]` plus `error:{name:'ApiError', message:<text>}`. The turn is kept even though it has no items.
- `tool_use` named `Agent` or `Task` → `task_delegation {id, status:'running', title, description, subagent, background: input.run_in_background===true}`. The title comes from a shared `task_delegation_title`, extracted from `lib.rs:3888`.
- `user` lines with `origin.kind==='task-notification'` → `None`. Layer 2 consumes them.
- `summarize` gains `context_compaction` → "Context compacted", `task_delegation` → its title, and an error-only turn → the error message (the session-host text capture `render_snapshot_text` falls back to the summary).

**Layer 2: `ClaudeTranscriptProjector`** (new, `claude_projection.rs`). It is `Clone`, and has `push_line(&Value)` and `finish(&dyn SubagentSource)`.
- An index maps each `tool_use_id` to its item location.
- A `tool_result` for a delegation id folds into the item: `completed` or `failed` (`is_error`); `background:true` plus `running` for `async_launched`; `durationMs` from `totalDurationMs`; `result` from the content text. The `tool_result` item is removed, and its turn is dropped if it becomes empty. Without this, `buildActivity` (`FreshAgentTranscript.tsx:162-188`) would show an orphan "Result" row, because delegation rows are never registered in `toolIndexById`.
- A task-notification line updates the matching delegation's `status` (completed, or failed/stopped → failed), `result` and `durationMs`.
- Edit, Write, MultiEdit and NotebookEdit results with a `toolUseResult` and no `is_error` produce one diff row per path, in a `BTreeMap` (codex `metadata.rs` parity). Fields: `id` and `path` (= `toolUseResult.filePath` or `input.file_path`/`notebook_path`), and `status` = `"created"` for a Write create, otherwise `"+A −D"` summed from the `structuredPatch` lines. Sets `capabilities.diffs = !diffs.is_empty()`. The panel's `git diff` fetch works with these absolute paths.
- Token usage comes from a `ClaudeUsageAccumulator` refactored out of `freshell-sessions/src/parse/claude.rs:495-570` (the indexer's own dedupe and context-window logic), so the snapshot and the context meter share one definition. It maps to `{inputTokens, outputTokens, cachedTokens, totalTokens, contextTokens, compactPercent}`. `costUsd` is omitted because the transcript does not persist it. `getContextUsage()` is deliberately not used: it has different semantics (whole-prompt `percentage` versus the indexer's compact-threshold percent) and costs a control round-trip.
- `recent_line_uuids`: a ring buffer of the last 64 uuid-bearing lines, including dropped ones. It is exposed as `extensions.claude.transcriptLineUuids`, which the client's landing check uses.
- `childThreads` stays `[]`. Claude subagents are not openable sessions, so no `childSessionId` is set and the delegation block shows no "Open session" link.

**Subagent activity** (`SubagentSource` trait; filesystem implementation in `get_claude_snapshot`): the directory is `<transcript without .jsonl>/subagents/`. A `meta.json` `toolUseId` maps to its agent file, which covers delegations that are still running (F5). Rows are `{tool, status, preview}` from the agent file's `tool_use` blocks (paired `tool_result` → completed/failed, otherwise running), capped at 200, with the preview from the shared `delegation_activity_preview` (both `file_path` and `filePath` spellings). The opencode code is refactored onto the same helpers, with its tests unchanged.

**Incremental cache** (`claude_projection_cache.rs`): an LRU of 8 entries keyed by path. Each entry holds the file identity (length, mtime, inode on unix), the parsed offset, a fingerprint of the 4 KiB before that offset, and a projector clone. If the file grew and the fingerprint matches, only the complete lines after the offset are parsed. A shrink, a fingerprint mismatch or a new identity triggers a full parse. An unterminated trailing line is never consumed. Subagent files use the same cache. Parsing runs in `spawn_blocking`.

### 4.4 Client
- **New slice `freshAgentLive`** (`src/store/freshAgentLiveSlice.ts`, a separate root key so `freshAgent.sessions` keeps its identity). Its state is `bySession[sessionKey] = { blocks: LiveBlock[], retry?, expectedTurnIds: string[], notice?: {seq, level, code, message, rateLimit?} }`, where `LiveBlock = {messageId, index, kind:'text'|'thinking'|'tool_use', text, name?, toolUseId?, uuid?}`.
  - Reducers: `streamOpsApplied`, `assistantBlockBound`, `transcriptAnnounced`, `transcriptLanded`, `liveRetrySet`, `liveNoticeReceived`, `liveTailCleared`.
  - `extraReducers` mirror `materializeSession`, `removeSession`, `sessionExited`, `markSessionLost` and `setSessionStatus`(exited/stuck).
  - Rules: deltas for a block whose start was not observed are dropped (mid-stream attach). A `content_block_start` clears `retry`. Binding goes to the first unbound block of the same `messageId` and kind.
- **Stream batcher** (`src/lib/fresh-agent-stream-batcher.ts`) buffers stream ops per session and flushes every `LIVE_STREAM_FLUSH_MS = 100` with an injectable scheduler. It flushes immediately before `freshAgent.assistant`, `freshAgent.result` and `freshAgent.error`.
- **`fresh-agent-ws.ts` changes:**
  - `stream`: dispatch `setStreaming(true)` only on a `content_block_start` while the session is not already streaming (one sessions write per turn), then enqueue the op.
  - Remove `appendStreamDelta`, the per-block `setStreaming(false)` and `addAssistantMessage`.
  - `assistant`: flush the batcher, then `assistantBlockBound` (top-level only).
  - `session.changed` with reason `transcript` and no `parentToolUseId`: `transcriptAnnounced`.
  - New cases: `freshAgent.retry` → `liveRetrySet`; `freshAgent.notice` → `liveNoticeReceived`.
  - `session.metadata`: pass `permissionMode`.
- **`freshAgentSlice.ts` changes:**
  - Delete `streamingText`, `appendStreamDelta`, `clearStreaming`, `addAssistantMessage` and `addUserMessage` (all dead).
  - `streamingActive` now means "a stream opened this turn". It is set once and cleared by `turnResult`, `setSessionStatus` (idle/exited/stuck) and `sessionError` as today, so `isFreshAgentBusy` is unchanged.
  - `turnResult` assigns `totalCostUsd = costUsd`, because the value is cumulative.
  - `sessionMetadataReceived` folds `permissionMode`.
- **`FreshAgentLiveTail.tsx`** (new) selects only its own session's tail. It builds one synthetic turn `{id:'__live-tail', role:'assistant', source:'live', items}`: an optional `{kind:'retry', attempt, error:'overloaded (529) · retrying in 1s'}`, then `thinking`, `text` and `tool_use` items for blocks whose `uuid` is not in `landedTurnIds`. It renders through the transcript's own `buildTranscriptLayout` and `FreshAgentTurnArticle` (exported), so the thinking strip, the SlotReel "Retrying" reel, markdown text and the tool row all look identical to durable content. On growth it calls `requestFollow()` from a new `TranscriptFollowContext`.
- **`FreshAgentTranscript.tsx` changes:**
  - New `tail?: ReactNode` slot rendered after the turns.
  - `TranscriptFollowContext`: pins to the bottom when `atBottom`.
  - Export the article and layout primitives.
  - FreshAgentView passes `isStreaming={isBusy && !liveTailActive}` (`liveTailActive` is a boolean selector), so only one live reel shows.
- **`FreshAgentView.tsx` changes:**
  - Do NOT subscribe to tail text.
  - Add `useTranscriptLandings(sessionKey, snapshot, requestSnapshotRefresh)`. On each committed snapshot it dispatches `transcriptLanded(present = turnIds ∪ extensions.claude.transcriptLineUuids)`. If announced ids remain, it re-polls with trigger `'event'`, at most `LANDING_RECHECK_MAX = 4` times, then drops them (the busy poll and the result refetch still cover).
  - `liveTailCleared` when a committed snapshot is idle and the pane is not busy.
  - Notice effect: `notice.seq` → `setNotice(message)`, with a locally formatted reset time for rate-limit codes, shown through the existing `FreshAgentApprovalBanner` (:4645).
  - Permission-mode convergence: when `agentSession.permissionMode` changes and differs from `paneContent.permissionMode`, dispatch `mergePaneContent({permissionMode})`, so the next send does not re-enter plan mode.
- **`tool-preview.ts`** gains `Agent`/`Task` (description), `TodoWrite` (`N todos` or the in-progress item), `ExitPlanMode` (first plan line), `MultiEdit` (file path) and `NotebookEdit` (`notebook_path`).

### 4.5 User-visible target behavior (acceptance)
1. Streamed text and thinking appear within about 100 ms of the token, in place, with no flicker or duplicate when the durable turn lands.
2. A tool's name appears when its block starts. Its result row appears within about 250–600 ms of the tool finishing (not up to 3 s).
3. "Retrying (attempt N) — overloaded (529)" shows while the CLI retries and clears on the next output.
4. `/compact`: a "Context compaction" card; the pane leaves "compacting" when compaction ends. On failure, a notice plus a durable red command error.
5. `/cost` and `/context` output render as markdown "System" rows.
6. Agent/Task subagents: a delegation block with live `↳ Tool preview` rows, a spinner while running (including background agents), then a result and duration. No raw tool row and no orphan "Result" row.
7. The diff panel lists files changed by Edit/Write/MultiEdit with `created` or `+A −D`.
8. Image attachments show `[image]`. API errors show the durable error module.
9. After approving ExitPlanMode, the gear shows the new permission mode and the next send keeps it.
10. Token deltas cause no render of TabBar, PaneContainer, MobileTabStrip, TabSwitcher, Sidebar or ContextMenuProvider.
11. Kilroy behaves identically.

---

## 5. File-by-file changes

**Sidecar**
- `crates/freshell-claude-sidecar/sdk-message-frames.mjs` (new): a pure `framesForSdkMessage(msg, sessionState) → frame[]` plus the stream filter, holding per-session `streamMessageId`. `handleSdkMessage` keeps only the side effects: the turn gate, `pendingResults`, `cancelPending` and `emit`.
- `crates/freshell-claude-sidecar/index.mjs`: delegate to the mapper; fold `status.permissionMode`; structured `logEvent(severity, event, fields)` for retry/notice/compaction; extend the header protocol comment.
- `crates/freshell-claude-sidecar/session-settings.mjs`: unchanged. The API-error banner belongs to the core runtime (G03); the transcript gets the durable error module instead.

**Rust**
- `crates/freshell-freshagent/src/claude_snapshot.rs`: layer 1 rules; `summarize`; `build_claude_snapshot_json` takes a `ClaudeProjection` (turns, diffs, tokenUsage, `transcriptLineUuids`); `get_claude_snapshot` uses the cache and the filesystem `SubagentSource`; `restored_slice_turns` projects through the projector.
- `crates/freshell-freshagent/src/claude_projection.rs` (new): projector, `SubagentSource`, diff aggregation.
- `crates/freshell-freshagent/src/claude_projection_cache.rs` (new): incremental cache.
- `crates/freshell-freshagent/src/delegation.rs` (new): shared `task_delegation_title`, `delegation_activity_preview` and the row cap. `lib.rs` (opencode) calls them; a pure refactor.
- `crates/freshell-freshagent/src/claude.rs`: `normalize_sdk_type` maps `sdk.retry` and `sdk.notice`; a consumer arm for `sdk.session.metadata` folds `permission_mode`; tracing for retry/notice; configure/send metadata frames state `permissionMode`.
- `crates/freshell-freshagent/src/session_metadata.rs`: optional `permission_mode` (serialized only when `Some`).
- `crates/freshell-freshagent/src/native_history.rs`: no code change (it inherits layer 1); add a test.
- `crates/freshell-sessions/src/parse/claude.rs`: extract `ClaudeUsageAccumulator`; `parse_session_content` uses it (the parity tests in `crates/freshell-sessions/tests/claude_fixture_parity.rs` must stay green).

**Client**
- `src/store/freshAgentLiveSlice.ts` (new), `src/store/freshAgentLiveTypes.ts` (new), `src/store/store.ts` (register the slice).
- `src/lib/fresh-agent-stream-batcher.ts` (new).
- `src/lib/fresh-agent-ws.ts` (routing as in section 4.4, with typed parsers for the new events).
- `src/store/freshAgentSlice.ts`, `src/store/freshAgentTypes.ts` (removals, `permissionMode`, cost).
- `src/components/fresh-agent/FreshAgentLiveTail.tsx` (new), `FreshAgentTranscript.tsx` (slot, follow context, exports), `FreshAgentView.tsx` (landing hook, notice, permission convergence, `isStreaming` gate, tail mount).
- `src/components/fresh-agent/useTranscriptLandings.ts` (new hook).
- `src/components/fresh-agent/shared/tool-preview.ts`.
- `shared/fresh-agent-contract.ts`: comment only (turn `error` is no longer opencode-only). No schema change.

**Fixtures and tests** (see section 6)
- `test/fixtures/fresh-agent/claude/real-cli-2.1.237/` (new): captured JSONL plus `subagents/` plus `meta.json` for tools/edits, Agent sync, Agent async with task-notification, compaction ok/fail, `/cost`, `/context`, API error and image; recorded SDK message sequences (`*.sdk.jsonl`) for sidecar tests and the e2e script.
- `test/integration/providers/claude-capture-fixtures.mjs` (new; a manual capture tool reusing the probe approach, local fake endpoint only).
- `test/fixtures/fresh-agent/claude-snapshot-rich-golden.json` (new); `claude-snapshot-golden.json` (regenerated: tokenUsage and extensions).
- `docs/index.html`: add a streaming tail and a delegation block to the freshclaude mock (AGENTS.md rule for significant UI changes).

---

## 6. Ordered TDD commits (each: failing test → minimal code → refactor; tests exercise behavior, none assert on prose or config text)

### Phase A: durable projection (server); useful on its own after reload
- **A1** Capture the fixtures (no test yet; the fixtures are inputs). RED: `claude_snapshot` unit tests over the real-CLI fixtures:
  - a compact boundary yields a `context_compaction` system turn;
  - local-command stdout yields system text;
  - stderr yields a `CommandError` error turn;
  - a `<command-name>` line yields `/compact`;
  - images yield `[image]`;
  - `isApiErrorMessage` yields an `ApiError` turn with no items.
  GREEN: layer 1. REFACTOR: the `summarize` arms.
- **A2** Extract `delegation.rs` from the opencode code (pure refactor; opencode tests in `lib.rs:11216+` stay green).
- **A3** RED: projector tests for Agent sync (completed, result, `durationMs`, the `tool_result` item absorbed so no orphan row), Agent async (background running, then completed via task-notification; the notification line is not rendered) and a failed Agent. GREEN: `ClaudeTranscriptProjector`; `parse_transcript_turns` and `restored_slice_turns` use it. The rollback tests (`claude_snapshot` rollback tests and `crates/freshell-ws/tests/freshagent_claude_rollback.rs`) must stay green.
- **A4** RED: activity rows from the fixture's `subagents/` (map-backed `SubagentSource` in unit tests, plus one filesystem test); a running delegation (`meta.json`, no result yet) shows running rows. GREEN.
- **A5** RED: the diffs summary (Write create, Edit `+1 −1`, a failed Edit excluded, one row per path, `capabilities.diffs`). GREEN.
- **A6** RED: the snapshot's `tokenUsage` equals the TokenSummary from `freshell_sessions::parse::claude::parse_session_content` for the same fixture (cross-crate parity). GREEN: extract `ClaudeUsageAccumulator` (the indexer's parity suite stays green).
- **A7** RED: `extensions.claude.transcriptLineUuids` holds the last 64 uuid-bearing lines, including absorbed ones. GREEN.
- **A8** Goldens: regenerate the simple golden; add the rich golden (Rust asserts the builder equals the golden; kilroy re-run leg). Extend `test/unit/contracts/rust-claude-snapshot-contract.test.ts` to parse the rich golden with the strict zod schema. RED: a component test rendering the rich golden in `FreshAgentTranscript` (delegation block with `↳` rows, compaction card, error module, system command output, no orphan Result row) and `FreshAgentDiffPanel` rows. GREEN (expected to pass with the existing renderers; any failure is a real rendering gap to fix here).
- **A9** RED: `native_history` read of the rich fixture includes the compaction marker and `[image]`. GREEN (inherited).
- **A10** RED: `tool-preview` cases. GREEN.

### Phase B: sidecar frames
- **B1** Characterization: unit tests for the new `sdk-message-frames.mjs` that feed recorded real SDK sequences and assert today's frames. Then move the code (pure refactor; the existing `test/unit/claude-sidecar/*` tests stay green).
- **B2** RED: transcript announcements (`uuid`, `parentToolUseId`) for assistant, tool_result, replayed prompt, compact boundary and local command; `sdk.assistant` carries `uuid`, `messageId` and `parentToolUseId`. GREEN.
- **B3** RED: stream filtering (drop sidechain, `input_json_delta`, `signature_delta`, `message_delta`, `message_stop`; stamp `messageId`). GREEN.
- **B4** RED: `api_retry` → `sdk.retry`; `rate_limit_event` warning/rejected → `sdk.notice` (allowed → none); `informational` → notice. GREEN.
- **B5** RED (spawn-level, with the fake query module): compaction failed → `sdk.notice COMPACTION_FAILED`, plus `sdk.status running` only while a send is pending; success → `running`; `permissionMode` fold → `sdk.session.metadata`, and a following `configure` with the same mode applies nothing (a `setPermissionMode` spy is not called). GREEN.
- **B6** Real-CLI contract (new `test/integration/providers/claude-live-frames.{mjs,test.ts}`, copying the setup of `claude-checkpoint-uuid-replay`): spawn the REAL `index.mjs` with `CLAUDE_CMD` set to the pinned CLI and a fake endpoint. Scenarios: text, Write/Edit, Agent sync, retry (529 twice), `/compact` ok and fail, plan exit. Assert the frame sequences, and that every announced top-level uuid appears in the JSONL within 2 s.

### Phase C: Rust wiring
- **C1** RED (claude.rs unit): `sdk.retry` and `sdk.notice` broadcast as `freshAgent.retry` and `freshAgent.notice` with the broadcast-id stamp; a transcript `sdk.session.changed` passes through; `sdk.session.metadata {permissionMode}` updates `configuration.settings.permission_mode` (asserted through a following `configure_for_send` that sends no configure line for the same mode). GREEN; tracing events added.
- **C2** RED: a configure that changes `permissionMode` broadcasts metadata stating it; codex/opencode frames are unchanged (their existing metadata tests). GREEN.
- **C3** RED, new `crates/freshell-ws/tests/freshagent_claude_live_rendering.rs`, running the real `index.mjs` with a scripted SDK module (section 6, E1 module; `FRESHELL_CLAUDE_NODE=node`). Over WS: stream frames carry `messageId`; `freshAgent.assistant` carries `uuid`; there is one `session.changed{reason:'transcript'}` per message; a mid-turn REST snapshot already contains the delegation item with running activity rows; after the turn, the snapshot carries `diffs` and `tokenUsage`; retry, notice and metadata frames are broadcast. GREEN.
- **C4** RED: projecting the rich fixture from appended chunks (split at every line boundary and mid-line) equals a full parse; rewrite or shrink triggers a full re-parse; an unterminated last line is ignored until complete; subagent file growth is reflected. GREEN: cache plus `spawn_blocking`.

### Phase D: client live rendering
- **D1** RED (store test): 200 `freshAgent.stream` text deltas through `handleFreshAgentTransportEvent` leave `state.freshAgent.sessions` referentially unchanged after the first `content_block_start`; text accumulates in `freshAgentLive`. GREEN: slice, batcher (fake timers) and ws routing; removals. Delete the tests of the removed reducers (`fresh-agent-ws.test.ts` and `freshAgentSlice.test.ts` cases for `appendStreamDelta`/`addAssistantMessage`) and add their behavioral replacements.
- **D2** RED: a render-count test (React `<Profiler>`) proving TabBar, PaneContainer, Sidebar, MobileTabStrip and TabSwitcher commit zero times across a burst of deltas. GREEN (expected after D1; if not, narrow the selectors).
- **D3** RED, live-slice reducer tests: uuid binding by `messageId` and kind; landed blocks are removed; deltas without a seen start are dropped; retry is cleared on block start; tails re-key on `materializeSession` and clear on exit/lost/kill. GREEN.
- **D4** RED, `FreshAgentLiveTail` component tests: streaming markdown text; a live thinking strip; a tool-starting row; the "Retrying" reel; blocks hidden when their uuid is in `landedTurnIds`; `requestFollow` called on growth; and FreshAgentTranscript pins to the bottom only when at the bottom. GREEN.
- **D5** RED (FreshAgentView tests): a claude pane refetches within `SNAPSHOT_DEBOUNCE_MS` after `session.changed{reason:'transcript'}`; the landing hook re-polls when an announced uuid is missing and stops after `LANDING_RECHECK_MAX`; the tail is cleared on an idle snapshot commit; FreshAgentView itself does not re-render per delta (Profiler). GREEN.
- **D6** RED: `freshAgent.notice` shows the banner without changing session status (it stays running); the rate-limit reset time is formatted; `COMPACTION_FAILED` is shown. GREEN.
- **D7** RED: `session.metadata {permissionMode:'default'}` updates pane content, and the next `freshAgent.send` carries `permissionMode:'default'`. GREEN.
- **D8** RED: `turnResult` with cumulative `costUsd` assigns rather than sums. GREEN.
- **D9** jsdom flow test `test/e2e/freshclaude-live-rendering-flow.test.tsx`: real store, real ws handler and a mocked snapshot API. Stream text appears, then the snapshot containing the uuid commits, and the text is shown exactly once throughout (no duplicate and no gap frame).

### Phase E: browser e2e (rust-chromium, local and cloud)
- **E1** `test/e2e-browser/fixtures/providers/claude-sdk-script.mjs`: a scripted `query()` module for the REAL sidecar. It replays the recorded real-CLI sequences with timing (token pacing, tool latency, 529 retries) and appends the matching JSONL lines with about 100 ms lag, as in F7. Plus a harness helper to launch with `FRESHELL_CLAUDE_SIDECAR=<repo>/crates/freshell-claude-sidecar/index.mjs` and `FRESHELL_CLAUDE_SDK_QUERY_MODULE=<script>`. If core-runtime's G04 delivers the same harness first, reuse it.
- **E2** `test/e2e-browser/specs/freshclaude-live-transcript-rust.spec.ts`, freshclaude cases:
  1. partial streamed text is visible while Stop is shown;
  2. a tool row appears before the turn ends;
  3. the "Retrying (attempt 1)" row appears, then disappears;
  4. `/compact` shows the card and the pane returns to idle; a failed compact shows the notice and the red command error;
  5. the delegation block's `↳` rows update while running, then complete;
  6. the diff panel lists the edited file and expands to the git diff (temp repo cwd);
  7. `/cost` output is rendered;
  8. after the plan exit, the gear shows Default and the next send keeps it;
  9. reload mid-session shows the same rich transcript.

  Kilroy variant for cases 1, 4 and 5. Confirm the spec is not in `CLOUD_SKIP_SPECS` and passes on the configured `FRESHELL_E2E_BACKEND`.
- **E3** `docs/index.html` mock update.

Run commands: `pnpm run test:vitest run <paths> --config config/vitest/vitest.config.ts`; `cargo test -p freshell-freshagent claude_`; `cargo test -p freshell-ws --test freshagent_claude_live_rendering`; `cargo test -p freshell-sessions`; `pnpm run test:e2e` (backend per `FRESHELL_E2E_BACKEND`); then the broad gate `pnpm run test` with `GCLOUD_ROBOT_REQUIRE=1`.

---

## 7. Interfaces with the core-runtime workstream

**What this plan needs** (none blocks Phases A–D):
- **N1 (G04).** A real-`index.mjs` plus scripted-SDK harness for WS and browser tests (interface: `FRESHELL_CLAUDE_SIDECAR` = real `index.mjs`, `FRESHELL_CLAUDE_SDK_QUERY_MODULE` = script module, scenario via `FRESHELL_CLAUDE_SDK_SCRIPT`). This plan builds it in E1 if it does not exist yet; core can share it.
- **N2 (G21/G23).** `freshAgent.status running` at send accept and `effective_status` on acks compose with this plan's `sdk.status running` after compaction. No ordering dependency. Until G21 lands, a stale idle ack still resets `streamingActive`, exactly as today.
- **N3 (G14).** The server forwards sidecar stderr JSON into tracing. This plan's sidecar log lines (`{severity, component:'claude-sidecar', event, …}`) become visible once G14 lands; the Rust-side retry and notice tracing is added here regardless.
- **N4 (G08, new evidence F6).** A background Agent completion makes the CLI run an **unsolicited turn and result with no send** (`origin.kind='task-notification'`). The pendingResults/TurnTracker accounting and bell rules must tolerate it. This plan renders it correctly, since the notification is absorbed into the delegation item and the follow-up assistant text renders normally, but busy/bell correctness belongs to core.
- **N5 (G02/G05).** The live slice clears on `sessionExited`, `sessionError` (non-restore), `markSessionLost`, `removeSession` and status exited/stuck. Any new exit signal core adds must reach one of these actions.
- **N6 (G03/G06).** The `case 'result'` and interrupt paths stay core-owned. B1 extracts the pure message→frame mapping first so both workstreams edit separate functions. Whichever lands second rebases; the mapping module has its own unit tests.
- **N7 (G01, observation).** `is_user_anchor` (`claude_snapshot.rs:789-818`) treats `<command-name>` and `<local-command-stdout>` user lines, and the new task-notification lines, as rollback step anchors. That is a likely mis-step for undo; this plan does not change rollback math.

**What this plan provides:** the `sdk-message-frames.mjs` mapper; stable turn ids (still the line uuid); `extensions.claude.transcriptLineUuids`; the `freshAgent.notice` channel (core may reuse it for non-terminal warnings instead of `sessionError`); and real-CLI fixtures.

---

## 8. Risks and mitigations
1. **Refetch load.** Per-message refetch re-reads the transcript and re-serializes the whole snapshot. Big sessions (MBs, with base64 images inline) are costly, and every watching client refetches. Mitigations: the C4 incremental cache plus `spawn_blocking`; the scheduler's 250 ms debounce plus single-flight. If profiling shows client parse cost, add an adaptive minimum gap (equal to the last fetch duration) in `fresh-agent-snapshot-scheduler.ts`; the shared scheduler test pins it. Snapshot deltas or turn paging remain a later option.
2. **CLI write lag (F7).** Covered by the landing check plus `transcriptLineUuids`. File timestamps (mtime) are not used, so filesystem timing granularity and the rollback revision floor cannot fake a landing.
3. **CLI format drift beyond 2.1.237** (`Agent`/`Task` naming, the subagent layout, local-command wrappers). The projector skips unknown shapes rather than failing (opencode/codex precedent), and the B6 real-CLI contract test plus the captured fixtures flag drift on every pin bump.
4. **Unsolicited turns from background agents** (N4) can confuse busy and bell accounting until core handles them.
5. **Merge friction with core in `index.mjs` and `claude.rs`.** Mitigated by B1, which lands first as a pure refactor, and by keeping the Rust changes to the normalize table plus one consumer arm.
6. **Streaming markdown cost** for very long answers. The 100 ms flush bounds re-parses to 10/s; the tail renders one block, not the transcript.
7. **Multi-device memory.** Stream frames go to every client; tails are bounded to one turn and cleared at idle.
8. **Rollback marker projections** now include the new kinds and absorb Agent results. The A3 gate keeps the rollback suites green; the N7 anchor issue is reported, not changed.
9. **Images are placeholders only** (codex parity). Inline thumbnails would need a contract addition and are out of scope.
10. **Capture-text consumers.** The session-host `render_snapshot_text` falls back to `summary` for item kinds without text; the A1 `summarize` arms keep those lines meaningful.

## 9. Out of scope / follow-ups
- Opening a claude subagent's full transcript as its own pane (needs a history-only sidechain view).
- `worktrees` from the EnterWorktree tool.
- `getContextUsage()`-based meter.
- Approval-card rendering of ExitPlanMode (G20).
- Fixing the hardcoded opencode provider in `openDelegationSession` (unused by claude under this plan).
- Sidecar-side delta coalescing.
