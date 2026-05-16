# Coding CLI Session Contract Lab Note

This note records the real-binary provider probes rerun on `2026-04-26` inside `/home/user/code/freshell/.worktrees/trycycle-codex-session-resilience`. Binary version facts were refreshed on `2026-05-14` inside `/home/user/code/freshell/.worktrees/codex-stability-implementation-20260514`; the OpenCode binary version fact was refreshed on `2026-05-16` inside `/home/user/code/freshell/.worktrees/dev-green-20260516`.

The implementation plan file is dated `2026-04-19` because the design work was written the day before. This note is dated `2026-04-26` because the real-provider contracts were re-proved on the implementation machine on that date, and that verification date is the one Freshell is allowed to build on.

## Machine-readable contract
```json
{
  "capturedOn": "2026-04-26",
  "planCreatedOn": "2026-04-19",
  "dateReason": "The plan was drafted on 2026-04-19, but the checked-in note is dated 2026-04-26 because that is when the durable behavior contract was re-proved on the implementation machine and the earlier 2026-04-23 contract capture was superseded by the newer provider behavior. Binary version facts were refreshed on 2026-05-14 after the installed provider versions changed, and the OpenCode binary version fact was refreshed on 2026-05-16 after the installed provider version changed again.",
  "cleanup": {
    "liveProcessAuditCommand": "ps -eo pid,ppid,stat,cmd --sort=pid | rg \"codex|claude|opencode\"",
    "ownershipReportFields": [
      "pid",
      "ppid",
      "cwd",
      "tempHome",
      "sentinelPath",
      "safeToStop",
      "command"
    ],
    "safeToStopRequires": [
      "FRESHELL_PROBE_HOME must match the current temp root.",
      "FRESHELL_PROBE_SENTINEL must match the current sentinel path."
    ],
    "safeExamples": [
      "Probe-owned temp-home root processes and their descendants tagged by the current harness sentinel."
    ],
    "unsafeExamples": [
      "Real user codex, claude, or opencode sessions under the user home.",
      "Any process that lacks the current harness sentinel metadata."
    ]
  },
  "providers": {
    "codex": {
      "executable": "codex",
      "resolvedPath": "/home/user/.npm-global/bin/codex",
      "version": "codex-cli 0.130.0",
      "freshRemoteBootstrapCommand": "codex --remote <ws>",
      "freshRemoteBootstrapEventsBeforeUserTurn": [
        "connection",
        "initialize",
        "initialized",
        "account/read",
        "account/read",
        "model/list",
        "thread/start"
      ],
      "remoteResumeBootstrapStablePrefix": [
        "connection",
        "initialize",
        "initialized",
        "account/read",
        "thread/read",
        "account/read",
        "model/list",
        "thread/resume"
      ],
      "remoteResumeBootstrapFollowupMethods": [
        "account/rateLimits/read",
        "command/exec",
        "hooks/list",
        "skills/list",
        "skills/list",
        "thread/goal/get"
      ],
      "freshRemoteAllocatesThreadBeforeUserTurn": true,
      "shellSnapshotGlob": ".codex/shell_snapshots/*.sh",
      "durableArtifactGlob": ".codex/sessions/YYYY/MM/DD/rollout-*.jsonl",
      "freshInteractiveCreatesShellSnapshotBeforeTurn": true,
      "freshInteractiveCreatesDurableSessionBeforeTurn": false,
      "appServerThreadPathAvailableBeforeArtifact": true,
      "appServerMissingPathWatchAccepted": true,
      "appServerMissingParentWatchAccepted": true,
      "appServerWatchEchoesCallerWatchId": false,
      "appServerArtifactMaterializesAtReportedPath": true,
      "appServerChangedPathsMentionRolloutPath": false,
      "resumeCommandTemplate": "codex --remote <ws> --no-alt-screen resume <sessionId>",
      "mutableNameSurface": "absent"
    },
    "claude": {
      "executable": "claude",
      "resolvedPath": "/home/user/bin/claude",
      "isolatedBinaryPath": "/home/user/.local/bin/claude",
      "version": "2.1.140 (Claude Code)",
      "exactIdCommandTemplate": "HOME=<temp-home> /home/user/.local/bin/claude --bare --dangerously-skip-permissions -p --session-id <uuid> <prompt>",
      "namedResumeCommandTemplate": "HOME=<temp-home> /home/user/.local/bin/claude --bare --dangerously-skip-permissions -p --resume <title-or-uuid> [--name <title>] <prompt>",
      "transcriptGlob": ".claude/projects/*/<uuid>.jsonl",
      "canonicalIdentity": "uuid-transcript",
      "namedResumeWorksInPrintMode": true,
      "renameMutatesMetadataOnly": true,
      "oldTitleStopsResolvingAfterRename": true,
      "oldTitleErrorFragment": "does not match any session title"
    },
    "opencode": {
      "executable": "opencode",
      "resolvedPath": "/home/user/.opencode/bin/opencode",
      "version": "1.15.1",
      "runCommandTemplate": "opencode run <prompt> --format json --dangerously-skip-permissions",
      "serveCommandTemplate": "opencode serve --hostname 127.0.0.1 --port <port>",
      "globalHealthPath": "/global/health",
      "sessionStatusPath": "/session/status",
      "canonicalIdentity": "session-id",
      "runEventSessionIdMatchesDbId": true,
      "busyStatusUsesAuthoritativeSessionId": true,
      "attachFormatJsonEmitsEvents": false,
      "titleOnResumeMutatesStoredTitle": false,
      "sessionSubcommands": [
        "list",
        "delete"
      ]
    }
  }
}
```

## Process audit and cleanup rule

The live process audit was run with:

```bash
ps -eo pid,ppid,stat,cmd --sort=pid | rg "codex|claude|opencode"
```

That audit showed live user sessions for all three providers outside the temp homes used for the probes. Those processes must never be stopped by cleanup.

The checked-in harness therefore only stops processes when both provenance checks succeed:

1. `FRESHELL_PROBE_HOME` matches the current temp root.
2. `FRESHELL_PROBE_SENTINEL` matches the current sentinel file.

Before cleanup runs, the harness emits a dry-run ownership report containing `pid`, `ppid`, `cwd`, `tempHome`, `sentinelPath`, `safeToStop`, and `command` for every candidate PID in the probe-owned process tree. Cleanup aborts if any candidate lacks the expected temp-home or sentinel metadata.

## Codex

Version and binary:

```bash
command -v codex
# /home/user/.npm-global/bin/codex

codex --version
# codex-cli 0.130.0
```

This 2026-05-14 version refresh supersedes the older `codex-cli 0.128.0` capture. The current version of record on this machine is `codex-cli 0.130.0`.

Fresh remote bootstrap was probed with a loopback websocket stub and:

```bash
CODEX_HOME=<temp-root>/.codex codex --remote <ws> --no-alt-screen
```

Before any user turn, the CLI opened a connection and issued:

1. `initialize`
2. `initialized`
3. `account/read`
4. `account/read`
5. `model/list`
6. `thread/start`

That proves fresh `codex --remote` allocates a thread during bootstrap, before the first user turn, but that thread allocation is not yet the durable contract Freshell may persist.

The remote resume form was re-proved through a websocket proxy in front of the real app-server. Before any user turn, `codex --remote <ws> --no-alt-screen resume <sessionId>` issued the stable prefix through `thread/resume`, and then the follow-up `account/rateLimits/read`, `command/exec`, `hooks/list`, `skills/list`, and `thread/goal/get` calls. The trailing post-resume follow-up order was observed to vary between reruns on the same binary, so only the stable prefix plus the required follow-up method set is treated as contract.

Real provider-owned durability was re-proved against the app-server websocket with:

```bash
CODEX_HOME=<temp-root>/.codex codex app-server --listen <ws>
# JSON-RPC:
#   initialize
#   thread/start
#   turn/start
#   thread/resume
```

Observed provider-owned artifacts:

- After `thread/start` and before `turn/start`: a shell snapshot under `.codex/shell_snapshots/*.sh`.
- After `thread/start` and before `turn/start`: no `.codex/sessions/**.jsonl` durable artifact.
- `thread/start` already returned `thread.ephemeral: false` and a concrete `thread.path` under `.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- Immediately after `thread/start`, neither the rollout file nor its date directory existed yet.
- `fs/watch` accepted caller-supplied `watchId` values for both the missing rollout path and the missing parent directory and returned only the canonicalized watched `path`.
- After the first real `turn/start`: a durable artifact under `.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- After the first real `turn/start`: the durable artifact appeared at the exact `thread.path`.
- In the 2026-04-26 rerun, no `fs/changed` notification was observed for the newly materialized rollout path within the historical timeout, so durable detection must not depend on that notification.

Short JSON-ish transcript from the 2026-04-26 rerun:

```json
{
  "thread/start": {
    "thread": {
      "id": "<uuid>",
      "ephemeral": false,
      "path": "<temp-root>/.codex/sessions/2026/04/23/rollout-...jsonl"
    }
  },
  "preTurn": {
    "rolloutExists": false,
    "parentExists": false
  },
  "fs/watch": [
    {
      "watchId": "probe-rollout-path",
      "result": { "path": "<same rollout path>" }
    },
    {
      "watchId": "probe-rollout-parent",
      "result": { "path": "<same parent directory>" }
    }
  ],
  "fs/changed": null
}
```

The durable restore path that worked after restarting the app-server runtime was:

```bash
thread/resume <sessionId>
turn/start <sessionId>
```

`codex --help` in the tested mode did not expose a rename or title mutation flag such as `--name`, so no mutable-name surface was confirmed for Codex in this contract.

Allowed Freshell behavior:

- Fresh Codex panes may stay live-only even though a fresh thread exists and `thread.path` is already known.
- Freshell may use `fs/watch` as the event source for Codex durability, but it still needs a direct existence check on the exact rollout path before promotion.
- Freshell may only persist canonical Codex identity after the durable `.jsonl` artifact exists at the provider-reported `thread.path`.
- Freshell must not treat the bootstrap `thread/start` id as durable restore identity.

### 2026-05-14 Codex restore decision addendum

The `da2e0076` refactor added a design constraint that belongs with the provider contract: deterministic Codex restore needs one typed create/restore decision path, not only a correct rollout proof reader. Restore-like entry points must make the same decision about canonical `sessionRef`, captured candidate proof, live attach after proof failure, fresh create, and legacy raw resume. Keeping those choices local to each caller risks separate restore semantics.

Design-level change recorded from `/home/user/code/freshell/.worktrees/codex-stability-implementation-20260514`: `/home/user/code/freshell/.worktrees/codex-stability-implementation-20260514/server/coding-cli/codex-app-server/restore-decision.ts` now owns `planCodexCreateRestoreDecision` and `resolveCodexCreateRestoreDecision`, and `/home/user/code/freshell/.worktrees/codex-stability-implementation-20260514/server/ws-handler.ts` routes Codex `terminal.create` and reopen handling through it. This is a narrow centralization, not a claim that every surface is done.

Follow-up constraints:

- Move exact live-candidate matching into the central module or make its typed input contract require enough live candidate identity for the module to verify `candidateThreadId` and `rolloutPath`.
- Remove or replace `legacy_raw_resume_passthrough`; raw resume should not remain a durable restore identity path.
- Extend the same decision path to REST, MCP, CLI, and any future restore-like surface instead of maintaining parallel semantics.
- Add surface matrix tests so coverage proves all entry points use the same restore decisions, not just the decision module and the current websocket route.

## Claude

Version and binaries:

```bash
command -v claude
# /home/user/bin/claude

claude --version
# 2.1.140 (Claude Code)
```

The wrapper at `/home/user/bin/claude` shells out to `/home/user/.local/bin/claude`. The isolated probes used the actual binary and overrode `HOME` to keep persistence inside the probe temp root.

Fresh exact-id durability was probed with:

```bash
HOME=<temp-home> /home/user/.local/bin/claude --bare --dangerously-skip-permissions -p --session-id <uuid> "Reply with exactly: claude-home-probe-ok"
```

Observed provider-owned artifacts:

- `.claude/.credentials.json`
- `.claude/policy-limits.json`
- `.claude/projects/*/<uuid>.jsonl`

The UUID-backed transcript file is the canonical durable identity.

Named resume and rename/title mutation were probed with:

```bash
HOME=<temp-home> /home/user/.local/bin/claude --bare --dangerously-skip-permissions -p --session-id <uuid> --name probe-name-one "Reply with exactly: named-create-ok"
HOME=<temp-home> /home/user/.local/bin/claude --bare --dangerously-skip-permissions -p --resume probe-name-one "Reply with exactly: named-resume-ok"
HOME=<temp-home> /home/user/.local/bin/claude --bare --dangerously-skip-permissions -p --resume <uuid> --name probe-name-two "Reply with exactly: renamed-ok"
```

Observed rename semantics:

- The transcript filename and UUID-backed `sessionId` remained stable.
- Claude appended new `custom-title` and `agent-name` metadata lines for the renamed title.
- After rename, the old title no longer resolved in `--resume`.
- The new title resolved, but only as mutable metadata pointing back to the same UUID transcript identity.

Allowed Freshell behavior:

- UUID-backed Claude transcript identity is canonical durable identity.
- Named resume values and titles are mutable metadata only.
- Freshell must not persist a mutable title as Claude durable identity.

## OpenCode

Version and binary:

```bash
command -v opencode
# /home/user/.opencode/bin/opencode

opencode --version
# 1.15.1
```

Fresh isolated runs were probed with:

```bash
XDG_DATA_HOME=<temp-home>/.local/share XDG_CONFIG_HOME=<temp-home>/.config opencode run "Reply with exactly: opencode-probe-ok" --format json --dangerously-skip-permissions
```

Observed durable identity rule:

- The 2026-04-26 rerun used isolated empty OpenCode data/config roots for the session-identity probes so stale user-local provider configuration could not affect the contract.
- The first JSON `step_start` event carried a `sessionID`.
- That exact `sessionID` matched the `session.id` row written into the isolated OpenCode database.

The authoritative control surface was probed with:

```bash
XDG_DATA_HOME=<temp-home>/.local/share XDG_CONFIG_HOME=<temp-home>/.config opencode serve --hostname 127.0.0.1 --port <port>
curl http://127.0.0.1:<port>/global/health
curl http://127.0.0.1:<port>/session/status
```

Observed control behavior:

- `/global/health` returned a healthy payload with version `1.15.1`.
- `/session/status` returned `{}` while idle.
- During an attached `opencode run ... --attach http://127.0.0.1:<port>`, `/session/status` returned an authoritative `sessionID` with `{ "type": "busy" }`, and the same id was persisted as a `session.id` row in the isolated OpenCode database.
- On OpenCode `1.15.1`, attached `opencode run ... --attach ... --format json` exited successfully but emitted no JSON event lines on stdout, so attached-mode identity must come from `/session/status` plus the persisted database row rather than attached-run stdout.

Title semantics were probed with:

```bash
opencode run "Reply with exactly: opencode-title-one" --format json --dangerously-skip-permissions --title probe-title-one
opencode run "Reply with exactly: opencode-title-two" --format json --dangerously-skip-permissions --session <sessionId> --title probe-title-two
opencode session --help
```

Observed title behavior:

- The resumed run kept the same `sessionID`.
- The stored database title remained `probe-title-one`.
- `opencode session --help` only exposed `list` and `delete`; no rename subcommand was present in the tested mode.

Allowed Freshell behavior:

- Canonical OpenCode identity is the authoritative `sessionID`.
- Busy or restore state may only be promoted from the control surface or the canonical DB/session events.
- Titles are metadata and do not replace session identity.
