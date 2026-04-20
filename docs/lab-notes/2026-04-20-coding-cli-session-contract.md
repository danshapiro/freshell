# Coding CLI Session Contract Lab Note

This note records the real-binary provider probes rerun on `2026-04-20` inside `/home/user/code/freshell/.worktrees/exact-durable-session-contract`.

The implementation plan file is dated `2026-04-19` because the design work was written the day before. This note is dated `2026-04-20` because the real-provider contracts were re-proved on the implementation machine on that date, and that verification date is the one Freshell is allowed to build on.

## Machine-readable contract
```json
{
  "capturedOn": "2026-04-20",
  "planCreatedOn": "2026-04-19",
  "dateReason": "The plan was drafted on 2026-04-19, but the checked-in note is dated 2026-04-20 because that is when the real binaries were re-proved on the implementation machine.",
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
      "version": "codex-cli 0.121.0",
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
      "remoteResumeBootstrapEventsBeforeUserTurn": [
        "connection",
        "initialize",
        "initialized",
        "account/read",
        "thread/read",
        "account/read",
        "model/list",
        "thread/resume",
        "skills/list",
        "account/rateLimits/read",
        "skills/list"
      ],
      "freshRemoteAllocatesThreadBeforeUserTurn": true,
      "shellSnapshotGlob": ".codex/shell_snapshots/*.sh",
      "durableArtifactGlob": ".codex/sessions/YYYY/MM/DD/rollout-*.jsonl",
      "freshInteractiveCreatesShellSnapshotBeforeTurn": true,
      "freshInteractiveCreatesDurableSessionBeforeTurn": false,
      "resumeCommandTemplate": "codex --remote <ws> --no-alt-screen resume <sessionId>",
      "mutableNameSurface": "absent"
    },
    "claude": {
      "executable": "claude",
      "resolvedPath": "/home/user/bin/claude",
      "isolatedBinaryPath": "/home/user/.local/bin/claude",
      "version": "2.1.114 (Claude Code)",
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
      "version": "1.4.11",
      "runCommandTemplate": "opencode run <prompt> --format json --dangerously-skip-permissions",
      "serveCommandTemplate": "opencode serve --hostname 127.0.0.1 --port <port>",
      "globalHealthPath": "/global/health",
      "sessionStatusPath": "/session/status",
      "canonicalIdentity": "session-id",
      "runEventSessionIdMatchesDbId": true,
      "busyStatusUsesAuthoritativeSessionId": true,
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
# codex-cli 0.121.0
```

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

The remote resume form was re-proved through a websocket proxy in front of the real app-server. Before any user turn, `codex --remote <ws> --no-alt-screen resume <sessionId>` issued `thread/read`, then `thread/resume`, and then its follow-up `skills/list` and `account/rateLimits/read` calls.

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
- After the first real `turn/start`: a durable artifact under `.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.

The durable restore path that worked after restarting the app-server runtime was:

```bash
thread/resume <sessionId>
turn/start <sessionId>
```

`codex --help` in the tested mode did not expose a rename or title mutation flag such as `--name`, so no mutable-name surface was confirmed for Codex in this contract.

Allowed Freshell behavior:

- Fresh Codex panes may stay live-only even though a fresh thread exists.
- Freshell may only persist canonical Codex identity after the durable `.jsonl` artifact exists.
- Freshell must not treat the bootstrap `thread/start` id as durable restore identity.

## Claude

Version and binaries:

```bash
command -v claude
# /home/user/bin/claude

claude --version
# 2.1.114 (Claude Code)
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
# 1.4.11
```

Fresh isolated runs were probed with:

```bash
XDG_DATA_HOME=<temp-home>/.local/share XDG_CONFIG_HOME=<temp-home>/.config opencode run "Reply with exactly: opencode-probe-ok" --format json --dangerously-skip-permissions
```

Observed durable identity rule:

- The first JSON `step_start` event carried a `sessionID`.
- That exact `sessionID` matched the `session.id` row written into the isolated OpenCode database.

The authoritative control surface was probed with:

```bash
XDG_DATA_HOME=<temp-home>/.local/share XDG_CONFIG_HOME=<temp-home>/.config opencode serve --hostname 127.0.0.1 --port <port>
curl http://127.0.0.1:<port>/global/health
curl http://127.0.0.1:<port>/session/status
```

Observed control behavior:

- `/global/health` returned a healthy payload with version `1.4.11`.
- `/session/status` returned `{}` while idle.
- During an attached `opencode run ... --attach http://127.0.0.1:<port>`, `/session/status` returned the same authoritative `sessionID` with `{ "type": "busy" }`.

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
