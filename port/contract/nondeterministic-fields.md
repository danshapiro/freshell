# Nondeterministic wire fields — normalization input

The oracle diffs old-vs-new traffic **after** canonicalizing the fields that
carry run-specific values. This file enumerates those fields, derived by
inspecting the frozen schemas in `ws-protocol.schema.json` /
`ws-message-inventory.json` (source: `shared/ws-protocol.ts` and its imports).
Every entry names the message(s)/schema(s) it appears in so the normalization
layer can be built field-by-field.

## Normalization convention

- Replace each nondeterministic value with a **stable placeholder** derived from
  first-seen order, scoped per field family, e.g. `terminalId → <TID:1>`,
  `sessionId → <SID:1>`, `timestamp → <TS:1>`, `port → <PORT:1>`,
  `path → <PATH:1>`.
- **Preserve shape, not value.** For ids whose *format* is itself part of the
  contract, assert the shape before masking: Claude session ids match the UUID
  regex (`session-contract.ts` `CLAUDE_SESSION_ID_RE`), Codex ids are `ses_…` /
  thread ids with a `rolloutPath`, nanoid terminal/stream ids are the nanoid
  alphabet. T2 live invariants check the *shape*; the value is masked.
- **Opaque blobs** (`event: unknown`, screenshot bytes, PTY `data`, provider
  stderr, token counts) are excluded from byte-diffing and asserted only at the
  invariant level (present / parseable / monotonic), never for equality.
- Sequence numbers and revisions are **run-monotonic**: normalize to a
  per-stream ordinal, then assert ordering/monotonicity rather than absolute
  values.

## Ids (generated / opaque)

| Field | Kind | Appears in (`type`) |
|-------|------|---------------------|
| `terminalId` | nanoid | terminal.create, terminal.attach, terminal.detach, terminal.input, terminal.resize, terminal.kill, terminal.codex.candidate.persisted, terminal.created, terminal.attach.ready, terminal.stream.changed, terminal.detached, terminal.exit, terminal.status, terminal.output, terminal.output.batch, terminal.output.gap, terminal.title.updated, terminal.session.associated, terminal.codex.durability.updated, terminal.input.blocked, terminal.meta.updated, terminal.turn.complete, terminal.inventory, terminals.changed (`recoverableTerminalIds[]`), {codex,opencode,claude}.activity.updated / .list.response |
| `requestId` | correlation id | terminal.create, {codex,opencode,claude}.activity.list(+.response), ui.screenshot.result, codingcli.create/.created, freshAgent.create/.send/.fork(+.created/.create.failed/.send.accepted/.forked), tabs.sync.snapshot, error |
| `sessionId` | provider session id (`ses_…`, Claude UUID, opencode id) | codingcli.input/.kill/.created/.event/.exit/.stderr/.killed, freshAgent.* (attach/send/interrupt/compact/approval.respond/question.respond/kill/fork + created/.event/.materialized/.forked/.killed/.send.accepted), session.status, session.repair.activity, terminal.turn.complete, terminal metadata, {codex,opencode,claude} activity records |
| `resumeSessionId` | references a prior session id | codingcli.create, freshAgent.create/.attach |
| `streamId` | pty stream id | terminal.attach.ready, terminal.stream.changed, terminal.output, terminal.output.batch, terminal.output.gap |
| `attachRequestId` | attach correlation id | terminal.attach, terminal.attach.ready, terminal.stream.changed, terminal.output, terminal.output.batch, terminal.output.gap |
| `tabId`, `paneId` | client layout ids | client.diagnostic, terminal.create |
| `candidateThreadId`, `durableThreadId` | codex thread ids | terminal.codex.candidate.persisted, terminal.codex.durability.updated (`durability.candidate.candidateThreadId`, `durability.durableThreadId`) |
| `serverInstanceId` | per-boot server id | ready, terminal.create (`liveTerminal.serverInstanceId`) |
| `bootId` | per-boot id | ready, terminal.inventory |
| `submittedTurnId` | turn id | freshAgent.send.accepted |
| `previousSessionId` | prior session id | freshAgent.session.materialized |
| `parentSessionId` | forked-from id | freshAgent.forked |
| `createRequestId` | pane create correlation | ui.layout.sync (`layouts[*].content`) |
| `deviceId`, `deviceLabel`, `clientInstanceId` | device/client ids | tabs.sync.snapshot (`data.*Open[]`, `data.closed[]`, `data.devices[]`) |

## Timestamps (epoch millis unless noted)

| Field | Appears in |
|-------|------------|
| `timestamp` | ready (ISO string), pong (ISO string), error (ISO string), ui.layout.sync (number) |
| `createdAt` | terminal.created, terminal.inventory (`terminals[].createdAt`), freshAgent.create (`legacyRestoreContext.createdAt`) |
| `updatedAt` | terminal.meta.updated (`upsert[].updatedAt`), {codex,opencode,claude} activity records, freshAgent.create (`legacyRestoreContext.updatedAt`) |
| `capturedAt` | terminal.codex.candidate.persisted, terminal.codex.durability.updated (`durability.candidate.capturedAt`) |
| `checkedAt` | terminal.codex.durability.updated (`durability.lastProofFailure.checkedAt`) |
| `turnCompletedAt` | terminal.codex.durability.updated (`durability.turnCompletedAt`) |
| `at` | terminal.turn.complete, {codex,opencode,claude}.activity.list.response (`latestTurnCompletions[].at`) |
| `lastActivityAt` | terminal.inventory (`terminals[].lastActivityAt`) |
| `lastSeenAt` | tabs.sync.snapshot (`data.devices[].lastSeenAt`) |

## Sequence numbers, revisions, counters (run-monotonic)

| Field | Appears in |
|-------|------------|
| `seqStart`, `seqEnd` | terminal.output, terminal.output.batch (+ `segments[]`) |
| `headSeq`, `replayFromSeq`, `replayToSeq`, `requestedSinceSeq`, `effectiveSinceSeq`, `geometryEpoch` | terminal.attach.ready |
| `sinceSeq` | terminal.attach |
| `fromSeq`, `toSeq` | terminal.output.gap |
| `completionSeq` | terminal.turn.complete, {codex,opencode,claude}.activity.list.response (`latestTurnCompletions[].completionSeq`) |
| `revision` | terminals.changed, sessions.changed |
| `endOffset`, `rawFrameCount`, `serializedBytes` | terminal.output.batch (+ `segments[]`) |
| `chainDepth`, `orphansFixed`, `orphanCount` | session.status, session.repair.activity |
| token counts (`inputTokens`, `outputTokens`, `cachedTokens`, `totalTokens`, `contextTokens`, …) | terminal.meta.updated (`upsert[].tokenUsage`); `Usage` (`input_tokens`, `output_tokens`, `cache_*`) in SDK payloads |

## Ports

| Field | Appears in |
|-------|------------|
| `port` | extension.server.ready |
| `serverPort` | extensions.registry (`extensions[].serverPort`) |

## Paths (host-/temp-/rollout-specific)

| Field | Appears in |
|-------|------------|
| `cwd` | terminal.create, codingcli.create, freshAgent.* , terminal.created, terminal metadata, terminal.inventory |
| `rolloutPath` | terminal.codex.candidate.persisted, terminal.codex.durability.updated (`durability.candidate.rolloutPath`) |
| `checkoutRoot`, `repoRoot`, `displaySubdir` | terminal.meta.updated (`upsert[]`) |
| `defaultCwd`, `allowedFilePaths[]` | settings.updated (`settings`) |

## Opaque / content blobs (assert invariants, never byte-equality)

| Field | Appears in | Note |
|-------|------------|------|
| `data` | terminal.output, terminal.output.batch (+ `segments[].data`) | PTY bytes — deterministic only for fixed shell commands (T1); LLM-driven output is nondeterministic |
| `event` (`unknown`) | codingcli.event, freshAgent.event | provider-specific payload; parse + shape-check only |
| `text` | codingcli.stderr | provider stderr |
| `imageBase64` | ui.screenshot.result | PNG bytes; compare via perceptual/size invariants, not equality |
| `title` | terminal.title.updated, terminal.inventory (`terminals[].title`), ui.layout.sync tab titles | may be LLM-generated |
| `branch`, `isDirty` | terminal.meta.updated (`upsert[]`) | live git state |
| `cliVersion` | terminal.codex.durability.updated (`durability.candidate.cliVersion`) | environment-specific |
| `model` | codingcli.create, freshAgent.send (`settings.model`) | usually pinned; provider may echo a resolved id |

## Deterministic (do NOT normalize — must match exactly)

These are part of the contract's fixed surface and any diff is a real divergence:
`type` discriminants, `protocolVersion` / `wsProtocolVersion` (= 7), enum values
(`ErrorCode`, `phase`, `reason`, `status`, `barrier`, `intent`, `priority`,
`sandbox`, `permissionMode`, `sessionType`, `provider`, …), `code`, booleans like
`ok`/`success`/`accepted`/`enabled`, and fixed literals (`mimeType: 'image/png'`,
`RESTORE_UNAVAILABLE`).
