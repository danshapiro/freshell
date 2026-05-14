# Coding CLI Session Restore Research

This is the primary research record for how Freshell should identify, persist, and restore sessions for Codex, Claude Code, and OpenCode. Consult this file before changing session identity, restore, resume, sidebar, or terminal recovery behavior.

## What matters

| Provider | Deterministic restore identity | What works | What fails or must not be used | Not fully studied |
| --- | --- | --- | --- | --- |
| Codex | The rollout-backed root TUI `ThreadId` after the exact provider-reported `.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` file exists and starts with matching `session_meta`. | Fresh `codex --remote` creates a thread before user work; Freshell can capture that pre-durable candidate after installing listeners, then promote only after the exact rollout file proves the same root TUI `ThreadId`. `turn/completed` is the required proof-check boundary, not proof itself. | Pre-creating an app-server thread and launching the TUI with `codex resume <threadId>` before the rollout file exists fails with `no rollout found for thread id`. Cwd, time, title, shell snapshot, and bare pre-durable thread id are not durable restore identity. If proof fails after `turn/completed`, Freshell must show a degraded/error state and use only deterministic one-shot repair triggers. | Full long-idle and restart behavior still needs product-level coverage, but the identity contract is known. |
| Claude Code | The UUID-backed transcript file under `.claude/projects/*/<uuid>.jsonl`. | `--session-id <uuid>` creates a durable transcript, and `--resume <uuid>` restores it. | Titles and names are mutable metadata only. The old title stops resolving after rename. | The proof covers print-mode session creation/resume/rename; broader interactive TUI edge cases are not the source of truth here. |
| OpenCode | The authoritative `sessionID` from JSON events, the DB row, and `/session/status`. | JSON `step_start` session id matches the DB session id; `/session/status` reports the same busy id while attached. | Titles are metadata and do not replace session identity. No rename subcommand was present in the tested mode. | Full interactive TUI restart and long-idle behavior still needs product-level coverage. |

## Freshell rules

- Never infer a coding-agent restore identity from cwd, launch time, tab title, pane title, or proximity.
- For Codex, capture the pre-durable root TUI `ThreadId` candidate before allowing user input, but persist it as a candidate only; promote it to canonical durable identity only after the exact rollout path returned by Codex exists and starts with parseable `session_meta` whose `payload.id` matches the candidate `ThreadId`.
- For Codex, `turn/completed` is the mandatory proof-check boundary. It is not itself proof of durable restore. On that event, Freshell must run one exact proof read and either promote to durable or mark `durability_unproven_after_completion`.
- For Codex, a post-completion proof failure is not a normal grey/live-only steady state. Later Codex events, `fs/changed`, PTY exit, app-server websocket close/error, and user restore/list/open actions may each trigger one exact repair proof read, but Freshell must not start periodic or backoff read loops.
- For Codex, do not try to prevent restore loss by pre-creating an app-server thread and TUI-resuming it before rollout materialization; the real binary rejected that path.
- For Claude Code, persist the UUID transcript identity, not the visible title or `--name` value.
- For OpenCode, promote only from authoritative provider surfaces: JSON events, the DB/session row, or `/session/status`.
- Cleanup for probes must never stop real user sessions; only processes tagged with the current temp root and sentinel are safe to stop.

## Scope and provenance

The real-binary provider probes were rerun on `2026-04-26` inside `/home/user/code/freshell/.worktrees/trycycle-codex-session-resilience`. Binary version facts were refreshed on `2026-05-03` inside `/home/user/code/freshell/.worktrees/land-local-main-codex-sidecar-lifecycle`; the Claude Code binary version fact was refreshed again on `2026-05-06` inside `/home/user/code/freshell/.worktrees/codex-sidebar-reopen-corner-origin-pr-20260505` after the installed binary changed. A targeted Codex pre-durable resume and identity-capture experiment was run on `2026-05-13` inside `/home/user/code/freshell/.worktrees/dev` using isolated temp roots.

The later version-only refreshes did not re-prove the full behavior contract, so `capturedOn` remains `2026-04-26`; the `2026-05-13` experiment is recorded as a narrow Codex addendum. A Codex source-code study was added on `2026-05-13` against the locally installed `@openai/codex` package and the official upstream `openai/codex` tag `rust-v0.130.0`.

The implementation plan file is dated `2026-04-19` because the design work was written the day before. This research record is dated `2026-05-13` because it now includes the targeted Codex pre-durable resume experiment. The durable behavior contract date remains `2026-04-26`, because that is when the full real-provider contract was re-proved on the implementation machine and that verification date is the one Freshell is allowed to build on.

The real-provider harness parses the next section. Keep the `## Machine-readable contract` heading and the fenced JSON block intact when editing this file.

## Machine-readable contract
```json
{
  "capturedOn": "2026-04-26",
  "planCreatedOn": "2026-04-19",
  "binaryVersionFactsRefreshedOn": "2026-05-06",
  "dateReason": "The plan was drafted on 2026-04-19, but the checked-in note is dated 2026-04-26 because that is when the durable behavior contract was re-proved on the implementation machine and the earlier 2026-04-23 contract capture was superseded by the newer provider behavior. Binary version facts were refreshed on 2026-05-03 after installed provider versions changed, and the Claude Code binary version fact was refreshed on 2026-05-06 after the local installed binary changed to 2.1.132. These later version-only refreshes did not re-prove the behavior contract.",
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
      "resumeCommandTemplate": "codex --remote <ws> --no-alt-screen resume <threadId>",
      "preDurableResumeExperimentCapturedOn": "2026-05-13",
      "preDurableResumeCommandTemplate": "codex --remote <ws> --no-alt-screen resume <threadId>",
      "preDurableResumeBeforeRolloutWorks": false,
      "preDurableResumeFailureFragment": "no rollout found for thread id",
      "freshRemoteThreadStartedDelayMs": 641,
      "preDurableIdentityCaptureStrategy": "Launch fresh remote TUI only after listener installation, then block user input until thread/started is persisted.",
      "codexIdentityNames": {
        "rootTuiThreadId": "Provider ThreadId observed from thread/start or thread/started for the root TUI thread.",
        "rolloutProofId": "The payload.id value from the first rollout JSONL record when type is session_meta.",
        "resumeId": "The same root TUI ThreadId passed to codex --remote <ws> --no-alt-screen resume <threadId>.",
        "ambiguousTermsToAvoid": [
          "generic session id",
          "provider session_id"
        ]
      },
      "turnCompletedIsDurabilityProof": false,
      "noPollingPromotionSupported": "yes_with_required_completion_proof_check_and_event_driven_repair",
      "noPollingCanonicalPromotionStrategy": "Use turn/completed for the candidate root TUI ThreadId as the normal proof-check boundary. On that event, immediately do one exact proof read of the stored provider-reported rollout path and promote only if the first JSONL record is matching session_meta. fs/changed, later Codex events, PTY exit, app-server websocket close/error, and user-initiated restore/list/open actions are repair opportunities, not the normal success path.",
      "noPollingPromotionGuarantee": "No periodic or backoff existence/read loop. Durable restore is allowed to be unproven before a Codex turn completes. After turn/completed, a missing, unreadable, empty, malformed, or mismatched rollout proof is durability_unproven_after_completion and must be visible as degraded/error state.",
      "proofReadContract": {
        "trigger": "turn/completed",
        "path": "stored provider-reported rolloutPath",
        "read": "one exact read of the rollout path",
        "success": "regular readable JSONL file whose first record has type session_meta and payload.id equal to candidateThreadId",
        "failureStateAfterTurnCompleted": "durability_unproven_after_completion",
        "timerLoopAllowed": false
      },
      "durabilityStateModel": {
        "identity_pending": {
          "canonical": false,
          "userInput": "blocked",
          "sidebar": "Starting Codex; restore identity not captured.",
          "userCan": "wait, close, or start a fresh pane"
        },
        "captured_pre_turn": {
          "canonical": false,
          "userInput": "allowed after the candidate write succeeds",
          "sidebar": "Codex identity captured; restore proof pending before first turn.",
          "userCan": "work in the live terminal"
        },
        "turn_in_progress_unproven": {
          "canonical": false,
          "userInput": "allowed while live terminal is healthy",
          "sidebar": "Codex turn running; restore proof pending.",
          "userCan": "continue live work, with restore not yet guaranteed"
        },
        "proof_checking": {
          "canonical": false,
          "userInput": "allowed if the live terminal remains attachable",
          "sidebar": "Checking Codex restore proof.",
          "userCan": "keep using the live terminal while the exact proof read is in flight"
        },
        "durable": {
          "canonical": true,
          "userInput": "allowed",
          "sidebar": "Codex session restorable.",
          "userCan": "restore or reopen using the durable root TUI ThreadId"
        },
        "durability_unproven_after_completion": {
          "canonical": false,
          "userInput": "allowed only through an attachable live terminal",
          "sidebar": "Codex restore proof failed after turn completion.",
          "userCan": "attach live if available, trigger one-shot repair by restore/list/open, or start fresh"
        },
        "non_restorable": {
          "canonical": false,
          "userInput": "fresh terminal only",
          "sidebar": "Codex session not restorable.",
          "userCan": "open a fresh Codex terminal"
        }
      },
      "repairTriggers": [
        {
          "name": "later_codex_event",
          "semantics": "On a later Codex notification/response that is deterministically tied to the candidate root TUI ThreadId, run one exact proof read. Promote on success; remain degraded on failure."
        },
        {
          "name": "fs_changed",
          "semantics": "On fs/changed for the exact rollout path or watched parent, run one exact proof read. Promote on success; remain degraded on failure."
        },
        {
          "name": "pty_exit",
          "semantics": "On PTY exit, run one exact proof read before deciding whether the captured session is durable, still pre-completion lenient, or non_restorable."
        },
        {
          "name": "app_server_websocket_close_or_error",
          "semantics": "On app-server websocket close/error, run one exact proof read for the captured candidate. Promote on success; otherwise keep or enter degraded/non-restorable state according to live terminal availability."
        },
        {
          "name": "user_restore_list_open",
          "semantics": "On user restore, list, or open for a captured-but-unproven Codex session, run one exact proof read first. This is a repair path, not the normal success path."
        }
      ],
      "capturedUnprovenReopenPolicy": {
        "firstStep": "Run one exact proof read of the stored rolloutPath.",
        "onProofSuccess": "Promote to durable and resume with the proven root TUI ThreadId.",
        "onProofFailureLiveAttachable": "Attach the existing live terminal and keep the degraded/unproven state visible.",
        "onProofFailureLiveMissing": "Create a fresh Codex terminal and show a clear message that the captured session could not be proven restorable.",
        "forbidden": [
          "cwd_time_title_matching",
          "shell_snapshot_identity",
          "hidden_hook_configuration",
          "fake_or_mutating_provider_writes"
        ]
      },
      "inputGatePurpose": "Block user-originating PTY input only until Freshell has captured and durably saved Codex's candidate root TUI ThreadId and provider-reported rollout path. The gate is not waiting for the rollout file to exist.",
      "turnCompletionDurabilityContract": "Before a Codex turn completes, canonical restore may be unproven. When turn/completed arrives for the candidate root TUI ThreadId, Freshell must immediately proof-read the exact rollout path. Completion is the required proof-check boundary, not proof itself, because Codex can warn on rollout flush failure and still complete the turn.",
      "mutableNameSurface": "absent"
    },
    "claude": {
      "executable": "claude",
      "resolvedPath": "/home/user/bin/claude",
      "isolatedBinaryPath": "/home/user/.local/bin/claude",
      "version": "2.1.132 (Claude Code)",
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
      "version": "1.14.41",
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

## Process audit and cleanup

The live process audit was run with:

```bash
ps -eo pid,ppid,stat,cmd --sort=pid | rg "codex|claude|opencode"
```

That audit showed live user sessions for all three providers outside the temp homes used for the probes. Those processes must never be stopped by cleanup.

The checked-in harness therefore only stops processes when both provenance checks succeed:

1. `FRESHELL_PROBE_HOME` matches the current temp root.
2. `FRESHELL_PROBE_SENTINEL` matches the current sentinel file.

Before cleanup runs, the harness emits a dry-run ownership report containing `pid`, `ppid`, `cwd`, `tempHome`, `sentinelPath`, `safeToStop`, and `command` for every candidate PID in the probe-owned process tree. Cleanup aborts if any candidate lacks the expected temp-home or sentinel metadata.

## Codex evidence

### Version

```bash
command -v codex
# /home/user/.npm-global/bin/codex

codex --version
# codex-cli 0.130.0
```

This `2026-05-13` version refresh supersedes the older `codex-cli 0.129.0` capture. The current version of record on this machine is `codex-cli 0.130.0`.

### Fresh remote startup

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

That proves fresh `codex --remote` allocates a thread during bootstrap, before the first user turn. This thread allocation is useful for preventing untracked user work, but it is not yet the durable restore identity.

### Remote resume

The remote resume form was re-proved through a websocket proxy in front of the real app-server. Before any user turn, `codex --remote <ws> --no-alt-screen resume <threadId>` issued the stable prefix through `thread/resume`, followed by `skills/list`, `account/rateLimits/read`, `command/exec`, `hooks/list`, and `thread/goal/get` calls.

The trailing post-resume follow-up order varied between reruns on the same binary, so only the stable prefix plus the required follow-up method set is treated as contract.

### Durable artifact creation

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
- In the `2026-04-26` rerun, no `fs/changed` notification was observed for the newly materialized rollout path within the historical timeout, so durable detection must not depend on that notification.

Short JSON-ish transcript from the `2026-04-26` rerun:

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
thread/resume <threadId>
turn/start <threadId>
```

### Pre-durable resume and input-gating experiment

This targeted `2026-05-13` experiment tested whether Freshell can prevent un-restorable fresh Codex work by pre-creating the Codex app-server thread, persisting that `thread.id`, and then launching the user-facing TUI against the pre-created thread before any rollout artifact exists.

The isolated setup used:

```bash
CODEX_HOME=<temp-root>/.codex /home/user/.npm-global/bin/codex app-server --listen ws://127.0.0.1:<port>

# JSON-RPC over the app-server websocket:
#   initialize
#   thread/start { cwd: <temp-cwd>, persistExtendedHistory: true }

CODEX_HOME=<same-temp-root>/.codex /home/user/.npm-global/bin/codex --remote ws://127.0.0.1:<port> --no-alt-screen resume <threadId>
```

Result:

- `thread/start` returned a persistable `thread.id` and exact future `thread.path`.
- The rollout artifact and parent date directory did not exist immediately after `thread/start`.
- The pre-created-thread TUI resume read that exact in-memory thread successfully with `thread/read`.
- The same TUI then failed `thread/resume` with `no rollout found for thread id <threadId>`.
- No real model prompt was sent during the failed pre-durable resume experiment.

Measured timings from the isolated run:

| Phase | Elapsed |
| --- | ---: |
| app-server spawn to websocket accepting | 316.9 ms |
| `initialize` request to response | 33.9 ms |
| `thread/start` request to response | 559.7 ms |
| first `thread/started` notification from probe start | 1006.9 ms |
| pre-durable resume TUI spawn to proxy connection | 450.3 ms |
| pre-durable resume TUI `thread/read` success | 2.9 ms |
| pre-durable resume TUI `thread/resume` failure | 1.9 ms |
| fresh remote TUI spawn to `thread/start` response | 638.0 ms |
| fresh remote TUI spawn to `thread/started` notification | 640.9 ms |

Conclusion:

- Pre-creating a thread via app-server and then attaching the user-facing TUI with `codex resume <threadId>` before rollout materialization is not a viable prevention strategy.
- Fresh remote TUI launch after listener installation is viable for identity capture: in this run the thread identity was available about 641 ms after TUI spawn.
- To prevent untracked user work, Freshell must block terminal input until `thread/started` has been observed and the pre-durable candidate identity has been persisted.
- The pre-durable `thread.id` is useful as a captured candidate identity, but it is not a durable restore identity until the exact rollout artifact exists at the provider-reported `thread.path`.

### Codex source-code study

This study used the installed launcher at `/home/user/.npm-global/lib/node_modules/@openai/codex` and the official upstream source `openai/codex` tag `rust-v0.130.0`, commit `58573da43ab697e8b79f152c53df4b42230395a8`, cloned at `/tmp/codex-rust-v0.130.0`. The installed npm package contains the JavaScript native-binary launcher and package metadata; the Rust TUI, app-server, protocol, thread-store, and rollout code live in the official upstream repository.

Source locations studied:

- `/home/user/.npm-global/lib/node_modules/@openai/codex/package.json`: version `0.130.0`, upstream repository `https://github.com/openai/codex.git`, package directory `codex-cli`, and platform-native optional dependencies.
- `/home/user/.npm-global/lib/node_modules/@openai/codex/bin/codex.js`: locates the platform binary and execs it with inherited stdio; it does not implement session identity.
- `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/lib.rs`: remote app-server connection and resume lookup.
- `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app.rs`: fresh/resume startup ordering and TUI input event loop.
- `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app_server_session.rs`: TUI JSON-RPC calls for `thread/start`, `thread/resume`, `thread/read`, and `turn/start`.
- `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/session_state.rs`: TUI stores `thread_id` and optional `rollout_path`.
- `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs`: `thread/start`, `thread/read`, and `thread/resume` behavior.
- `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/turn_processor.rs`: `turn/start` converts app-server input into core `Op::UserInput`.
- `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/fs_watch.rs` and `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/v2/fs.rs`: `fs/watch` and `fs/changed`.
- `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/common.rs`: public JSON-RPC method set, including `fs/watch`, `turn/start`, and no public `thread/persist`-style method.
- `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs`: `thread.path` is explicitly marked `[UNSTABLE]`.
- `/tmp/codex-rust-v0.130.0/codex-rs/core/src/thread_manager.rs`, `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/session.rs`, and `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/mod.rs`: session startup, `SessionConfigured`, rollout path propagation, and materialization hooks.
- `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/turn.rs` and `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/handlers.rs`: first user input is recorded and then forces rollout materialization.
- `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs`: fresh rollout path precomputation, deferred writer open, `persist()`, `flush()`, and `session_meta` write ordering.
- `/tmp/codex-rust-v0.130.0/codex-rs/thread-store/src/local/read_thread.rs`: stored-thread lookup, rollout existence checks, and the `no rollout found for thread id` path.
- `/tmp/codex-rust-v0.130.0/codex-rs/core/src/hook_runtime.rs`: `SessionStart` hook transcript path obtains a materialized rollout internally.
- `/tmp/codex-rust-v0.130.0/codex-rs/core/src/shell_snapshot.rs`: shell snapshot lifecycle.

#### Remote TUI startup and candidate identity

The remote TUI connects with `client_name: "codex-tui"`, `experimental_api: true`, and `opt_out_notification_methods: Vec::new()` in `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/lib.rs:378`. That means Freshell can observe normal app-server responses and notifications when it owns the remote websocket proxy.

For fresh sessions, `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app.rs:734` awaits `app_server.start_thread(&config)` before it constructs the chat widget; `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app_server_session.rs:328` sends `ClientRequest::ThreadStart`; `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app_server_session.rs:1329` copies `response.thread.id` and `response.thread.path` into `ThreadSessionState`; and `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/session_state.rs:27` stores `thread_id` plus optional `rollout_path`.

On the app-server side, `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:1102` builds the API thread from the `SessionConfigured` event, including `session_configured.rollout_path`; `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:1156` builds the `ThreadStartResponse`; `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:1170` creates the `thread/started` notification; and `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:1171` sends the response before `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:1180` sends the notification. Therefore a Freshell websocket proxy can capture the same candidate from either the `thread/start` response or the later `thread/started` notification. The notification is useful as a provider event surface, but the response is the earlier source-supported surface.

The TUI itself does not start its main terminal event loop until after it enqueues the started thread in `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app.rs:913`. Once the loop is running, `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app.rs:1018` reads terminal events and `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app.rs:1082` dispatches keys and paste. Freshell still needs a PTY-side input gate because terminal bytes can be queued outside Codex before Freshell has atomically persisted the observed candidate.

#### Rollout path is announced before the rollout exists

The app-server integration test at `/tmp/codex-rust-v0.130.0/codex-rs/app-server/tests/suite/v2/thread_start.rs:147` asserts the fresh `thread.path` is absolute and `/tmp/codex-rust-v0.130.0/codex-rs/app-server/tests/suite/v2/thread_start.rs:149` asserts it does not yet exist. The same test waits for the `thread/started` notification at `/tmp/codex-rust-v0.130.0/codex-rs/app-server/tests/suite/v2/thread_start.rs:186` and asserts no preceding `thread/status/changed` for the new thread at `/tmp/codex-rust-v0.130.0/codex-rs/app-server/tests/suite/v2/thread_start.rs:194`.

The rollout recorder explains why. In `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:680`, the create path calls `precompute_log_file_info`, captures `path`, and constructs `SessionMeta`, but returns `None` for the writer and `Some(log_file_info)` at `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:718`. A fresh thread therefore has an in-memory rollout path and session metadata before the file is opened.

Materialization happens only when persistence is forced or pending items require a write. `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1494` makes `add_items` a no-op for the filesystem while the writer is deferred; `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1503` makes `persist()` write even when there are no pending items; `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1507` makes `flush()` return without creating a file when the writer is deferred and there are no pending items; `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1576` opens the deferred writer; `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1614` opens the writer, writes session metadata, writes pending items, and flushes; and `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1714` writes `RolloutItem::SessionMeta`.

The metadata line has the durable root TUI `ThreadId` Freshell needs to validate. `/tmp/codex-rust-v0.130.0/codex-rs/protocol/src/protocol.rs:2703` defines `SessionMeta { id: ThreadId, ... }`; `/tmp/codex-rust-v0.130.0/codex-rs/protocol/src/protocol.rs:2759` defines the JSONL `SessionMetaLine`; and `/tmp/codex-rust-v0.130.0/codex-rs/protocol/src/protocol.rs:2767` wraps it as the `session_meta` rollout item. Because the writer opens before the first line is written, a plain `exists()` check can observe a transient empty file. The deterministic promotion proof should require the exact provider-reported path to exist, be readable as JSONL, and begin with `payload.id == candidateThreadId` on a `session_meta` record.

`thread.path` is useful but not a stable protocol guarantee by itself: `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:125` marks the path field `[UNSTABLE]`. Freshell should version/probe this provider surface and keep the direct rollout proof as the durable promotion gate.

#### First user input is the materialization trigger

`turn/start` is the first app-server request that accepts user work. `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/app_server_session.rs:520` sends `ClientRequest::TurnStart`; `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/turn_processor.rs:348` maps app-server input to core input items; `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/turn_processor.rs:449` starts the turn by submitting `Op::UserInput` or `Op::UserInputWithTurnContext`; and `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/handlers.rs:233` creates the turn context before `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/handlers.rs:239` steers user input into the active turn.

After the prompt is accepted, `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/turn.rs:328` records the user prompt, and `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/mod.rs:2976` persists the prompt to history, emits the UI item, then calls `ensure_rollout_materialized()` at `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/mod.rs:2990`. That method calls `live_thread.persist()` through `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/mod.rs:1072`.

Before Codex emits turn completion, `/tmp/codex-rust-v0.130.0/codex-rs/core/src/tasks/mod.rs:396` calls `sess.flush_rollout().await`. The important caveat is the error path: `/tmp/codex-rust-v0.130.0/codex-rs/core/src/tasks/mod.rs:397` logs the flush failure, `/tmp/codex-rust-v0.130.0/codex-rs/core/src/tasks/mod.rs:398` through `/tmp/codex-rust-v0.130.0/codex-rs/core/src/tasks/mod.rs:406` sends a warning that the transcript failed to save and Codex will retry, and `/tmp/codex-rust-v0.130.0/codex-rs/core/src/tasks/mod.rs:410` still finishes the task when the turn was not cancelled. The app-server exposes that task finish as `turn/completed`: `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/common.rs:1429` defines the notification method, and `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/bespoke_event_handling.rs:1278` through `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/bespoke_event_handling.rs:1299` emits it with the thread id and turn id.

This gives Freshell a practical no-polling contract, but only if the boundary is named precisely: `turn/completed` is the required proof-check boundary, not proof itself. Durable restore does not need to be proven before the first Codex turn completes. When the turn-completed event arrives for the captured root TUI `ThreadId`, Freshell must immediately do one proof read of the exact provider-reported rollout path. If that proof read fails, the session enters `durability_unproven_after_completion`, a visible restore-durability failure state. It is not acceptable to leave it green, grey, live-only, or captured-not-canonical as a normal steady state past turn completion.

The reason to block typing is therefore narrow. The gate is not waiting for durable restore. The gate only prevents the user's first prompt from reaching Codex before Freshell has captured and saved the Codex candidate root TUI `ThreadId` and provider-reported rollout path. Once that candidate is durably saved by Freshell, user input can be released even though the rollout file may not exist yet.

This proves the normal first-turn path should materialize the rollout promptly after the user prompt is accepted and should flush it before turn completion. It does not prove a zero-risk crash window between forwarding the first `turn/start` and observing a parseable rollout file. No public app-server method named like `thread/persist` or `thread/materialize` appears in the public request set around `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/common.rs:699` through `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/common.rs:777`. Therefore strict prevention of all un-restorable first-turn bytes is not source-supported by a public pre-turn materialization RPC in this version. Under the accepted product leniency, that is tolerable only until the first turn completes.

#### Why pre-create plus TUI resume is not viable

The TUI resume lookup path explains the mixed result from the `2026-05-13` experiment. `/tmp/codex-rust-v0.130.0/codex-rs/tui/src/lib.rs:579` parses a UUID and calls `thread/read(... include_turns=false)`. The app-server allows metadata-only reads from live in-memory state before persistence: `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:1950` falls back to a live thread snapshot when persisted metadata is missing.

`thread/resume` is different. `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:2290` handles resume; `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:2336` first tries to resume a running thread; but `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:2637` still calls `read_stored_thread_for_resume(... include_history=true)` for a running thread id before it attaches. The local thread store requires an existing rollout: `/tmp/codex-rust-v0.130.0/codex-rs/thread-store/src/local/read_thread.rs:66` resolves the rollout path, `/tmp/codex-rust-v0.130.0/codex-rs/thread-store/src/local/read_thread.rs:68` returns `no rollout found for thread id` if it cannot, and `/tmp/codex-rust-v0.130.0/codex-rs/thread-store/src/local/read_thread.rs:168` only accepts the live writer path when `try_exists(path)` is true. The app-server maps thread-store misses to the same `no rollout found for thread id` error at `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/request_processors/thread_processor.rs:3574`.

That source path proves the pre-created id can be readable as live metadata and still be non-resumable.

#### fs/watch, shell snapshots, hooks, and provider events

`fs/watch` is a wake-up source, not a proof. The protocol accepts an absolute path with a connection-scoped `watch_id` in `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/v2/fs.rs:160`, and `fs/changed` echoes the `watch_id` plus changed paths at `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/v2/fs.rs:195`. The implementation registers the requested path without an existence check in `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/fs_watch.rs:118`, emits sorted changed paths joined under the watch root at `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/fs_watch.rs:165`, and returns only `FsWatchResponse { path }` at `/tmp/codex-rust-v0.130.0/codex-rs/app-server/src/fs_watch.rs:185`. The underlying watcher is `notify::recommended_watcher` in `/tmp/codex-rust-v0.130.0/codex-rs/core/src/file_watcher.rs:327`; missing targets are watched through the nearest existing ancestor in `/tmp/codex-rust-v0.130.0/codex-rs/core/src/file_watcher.rs:736`; the OS watch is skipped if the actual path does not exist in `/tmp/codex-rust-v0.130.0/codex-rs/core/src/file_watcher.rs:556`; and matching reports the requested path only when an event plus current existence state reaches the requested target in `/tmp/codex-rust-v0.130.0/codex-rs/core/src/file_watcher.rs:811`. Codex's own fs-watch tests explicitly avoid failing when no OS event arrives in `/tmp/codex-rust-v0.130.0/codex-rs/app-server/tests/suite/v2/fs.rs:684`, and the real probe observed no `fs/changed` before timeout. Therefore an event-driven Freshell implementation may subscribe to the exact rollout path and parent, but an `fs/changed` event cannot be the only event source and cannot replace a direct proof read.

Shell snapshots are not identity. `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/session.rs:699` starts shell snapshotting during session startup when the feature is enabled; `/tmp/codex-rust-v0.130.0/codex-rs/core/src/shell_snapshot.rs:39` keys the snapshot by session id and cwd; and `/tmp/codex-rust-v0.130.0/codex-rs/core/src/shell_snapshot.rs:153` writes and validates a temporary shell environment file before renaming it. The snapshot can appear before the rollout and can help diagnose startup, but it is deleted on drop and is not used by `thread/resume` as durable session history.

Hooks expose an internal materialization path but not a Freshell startup contract. `/tmp/codex-rust-v0.130.0/codex-rs/core/src/hook_runtime.rs:104` runs pending `SessionStart` hooks on the first turn context and includes `transcript_path: sess.hook_transcript_path().await` at `/tmp/codex-rust-v0.130.0/codex-rs/core/src/hook_runtime.rs:115`; `hook_transcript_path()` calls `ensure_rollout_materialized()` at `/tmp/codex-rust-v0.130.0/codex-rs/core/src/session/mod.rs:3284`. That could force materialization for Codex-owned hook execution, but Freshell should not rely on configuring hidden provider hooks to create identity; it is not a public app-server session-start barrier, and it changes provider configuration semantics.

Provider events split into candidate, proof-check, and repair surfaces. `thread/start` response and `thread/started` notification carry the candidate before user work. `turn/start` proves user work has already been accepted, so it is too late to protect candidate capture. `turn/completed` is the normal no-polling proof-check trigger: by then Codex should have materialized and flushed the rollout, but source shows flush failure can still warn and continue to completion. `fs/changed`, later Codex events, PTY exit, app-server websocket close/error, and user restore/list/open actions are deterministic repair opportunities, not the main path.

#### Codex identity names

For Codex, Freshell should be explicit about identity terms:

| Name | Meaning |
| --- | --- |
| `rootTuiThreadId` | The `ThreadId` for the user-facing root TUI thread, observed from `thread/start` or `thread/started`. |
| `candidateThreadId` | A persisted non-canonical copy of `rootTuiThreadId` before rollout proof succeeds. |
| `rolloutPath` | The provider-reported `thread.path` for that candidate. It is useful but marked `[UNSTABLE]` in `/tmp/codex-rust-v0.130.0/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:125`. |
| `rolloutProofId` | The `payload.id` from the first JSONL rollout record when `type == "session_meta"`. `/tmp/codex-rust-v0.130.0/codex-rs/protocol/src/protocol.rs:2703` through `/tmp/codex-rust-v0.130.0/codex-rs/protocol/src/protocol.rs:2705` define that id as a `ThreadId`. |
| `durableThreadId` | The canonical identity after `rolloutProofId == candidateThreadId` at the exact `rolloutPath`. This is also the id passed to `codex --remote <ws> --no-alt-screen resume <threadId>`. |

Avoid generic "session id" in Codex restore design because it can be confused with provider fields named `sessionId` or `session_id`. The durable Codex identity in this contract is the root TUI `ThreadId`; the rollout proof is the first JSONL line shaped like `{"type":"session_meta","payload":{"id":"<ThreadId>", ...}}`. That shape follows the tagged `RolloutItem` wrapper in `/tmp/codex-rust-v0.130.0/codex-rs/protocol/src/protocol.rs:2767` through `/tmp/codex-rust-v0.130.0/codex-rs/protocol/src/protocol.rs:2770`, and the recorder writes that `RolloutItem::SessionMeta` at `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1738` through `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1740`.

#### State model

| State | Meaning | What the user can do | Sidebar/state surface |
| --- | --- | --- | --- |
| `identity_pending` | Fresh Codex is starting, but Freshell has not persisted a `candidateThreadId` plus `rolloutPath`. | Wait, close the pane, or start a fresh pane. User-originating PTY input is blocked. | "Starting Codex; restore identity not captured." No restorable indicator. |
| `captured_pre_turn` | Freshell has persisted the candidate before a user turn is accepted, but the rollout proof is not expected yet. | Use the live terminal after the candidate write succeeds. | "Codex identity captured; restore proof pending." Neutral pending state, not green. |
| `turn_in_progress_unproven` | A Codex turn is running for the captured candidate and durable proof has not succeeded. | Continue live work while the terminal is attachable. Restore is not guaranteed yet. | "Codex turn running; restore proof pending." Not an error before completion. |
| `proof_checking` | `turn/completed` arrived or a repair trigger fired, and Freshell is doing one exact proof read. | Keep using the live terminal if it remains attachable. | "Checking Codex restore proof." Short-lived pending state. |
| `durable` | The exact rollout proof succeeded, so `durableThreadId` is canonical. | Reopen, resume, split, or restore using the durable root TUI `ThreadId`. | Normal restorable Codex session. |
| `durability_unproven_after_completion` | A proof read failed after `turn/completed` for the candidate. | Attach the live terminal if available, trigger user repair by restore/list/open, or start fresh. | Visible degraded/error state: "Codex restore proof failed after turn completion." |
| `non_restorable` | There is no captured candidate, or the captured candidate cannot be proven and no live terminal can be attached. | Open a fresh Codex terminal. | Clear non-restorable error. No fake resume affordance. |

The state model intentionally accepts leniency before a Codex turn completes. After `turn/completed`, proof failure is not a normal grey state. It is `durability_unproven_after_completion` until a deterministic repair trigger succeeds or the live terminal is gone and the pane becomes `non_restorable`.

#### Failure handling at `turn/completed`

When `turn/completed` arrives for the captured root TUI `ThreadId`, Freshell must transition to `proof_checking` and immediately run exactly one proof read of the stored `rolloutPath`. The proof succeeds only if the path is a regular readable JSONL file and the first record is parseable `session_meta` with `payload.id == candidateThreadId`. A mere path existence check is too weak because `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1576` through `/tmp/codex-rust-v0.130.0/codex-rs/rollout/src/recorder.rs:1622` opens the deferred writer, writes session metadata, writes pending items, and then flushes.

If the proof read succeeds, Freshell promotes to `durable`, persists the canonical `sessionRef`, and may display normal restore affordances. If it fails after `turn/completed`, Freshell must immediately surface `durability_unproven_after_completion`. The live PTY may remain usable if it is still attachable, but the sidebar and pane state must not silently present it as durable, green, or harmlessly pending.

There is no periodic, delayed, or backoff read loop. If a proof read is already in flight and another deterministic trigger arrives, Freshell may coalesce the trigger into at most one additional exact read after the current read resolves. It must not keep retrying because time passed.

#### Deterministic repair triggers

Each repair trigger below performs one exact proof read of the stored `rolloutPath`. Success promotes to `durable`. Failure keeps `durability_unproven_after_completion` after a completed turn, or keeps the pre-completion unproven state before a completed turn. User actions are repair paths, not the normal success path.

| Trigger | Semantics |
| --- | --- |
| Later Codex event | A later Codex notification/response deterministically tied to the candidate root TUI `ThreadId` may trigger one proof read. Generic app-server noise that cannot be tied to the candidate is ignored. |
| `fs/changed` | A notification for the exact rollout path or watched parent may trigger one proof read. The notification is only a wake-up source and does not prove durability. |
| PTY exit | Before marking the session gone, Freshell runs one proof read. If it fails after completion and no live terminal remains, the state becomes `non_restorable`; if it fails before completion, it stays within the accepted pre-completion leniency but still is not durable. |
| App-server websocket close/error | Close/error from the app-server observer or TUI connection triggers one proof read for the captured candidate. Success promotes; failure stays degraded or becomes non-restorable depending on live attachability. |
| User restore/list/open | A user attempt to restore, list, or open a captured-but-unproven Codex session runs one proof read first. This can repair a missed provider/filesystem event, but it is not the normal success path. |

#### Re-open/resume policy for captured-but-unproven sessions

If the user attempts to re-open or resume a captured-but-unproven Codex session, Freshell must proof-read first. If proof succeeds, it promotes to `durable` and resumes with the proven root TUI `ThreadId`. If proof fails and the live terminal is attachable, Freshell attaches the live terminal and keeps the degraded/unproven state visible. If proof fails and no live terminal is attachable, Freshell creates a fresh Codex terminal with a clear local message/state explaining that the captured Codex session could not be proven restorable.

This path must not use cwd, launch time, title, pane title, shell snapshots, hidden hook configuration, or fake/mutating provider writes. It also must not try `codex resume <candidateThreadId>` before proof succeeds; the real-binary experiment and the thread-store source prove that a live-readable pre-durable id can still fail resume with `no rollout found for thread id`.

#### Approach evaluation

| Approach | Source proof | Failure mode | Use in Freshell |
| --- | --- | --- | --- |
| Pre-create app-server thread, then TUI `resume <threadId>` | `thread/read include_turns=false` can return live metadata before persistence, but `thread/resume` requires stored rollout history and path existence. | Fails before rollout with `no rollout found for thread id`; this matches the real-binary experiment. | Do not use. |
| Fresh remote TUI after listener/proxy install | TUI awaits `thread/start` before its main input loop, app-server sends `thread/start` response then `thread/started`, both with `thread.id` and `thread.path`. | If Freshell starts Codex before installing the proxy/listener or before its own persistence transaction is ready, early terminal bytes can race identity capture. | Use. Install proxy/listeners first. |
| PTY input blocking | TUI reads keys/paste after startup; Freshell controls the PTY input boundary. | Without a Freshell gate, queued bytes can enter Codex before the candidate is durably recorded by Freshell. | Use. Block user-originating stdin until the candidate is atomically persisted. |
| App-server-side `turn/start` interception | `turn/start` is the app-server request that submits `Op::UserInput`. | Intercepting it as the primary guard is late: the user already typed. Forwarding it before candidate persistence creates untracked work. | Use only as a secondary safety net in the websocket proxy: reject or hold `turn/start` if the candidate is missing. |
| Exact rollout-path watch plus proof | `fs/watch` accepts the path and can notify, while rollout writer writes `session_meta` first when materialized. | `fs/changed` is not guaranteed by source tests or the probe; `exists()` alone can observe an empty file between open and first write. | Use watch only as one explicit event source; do a one-shot proof read on each event and promote only after parseable `payload.id` on `session_meta` matches the candidate. |
| Turn-completed proof check | Codex normally materializes after recording the first prompt and attempts to flush before completing the turn, but the flush error path can warn and still finish the task. | If the proof read fails after `turn/completed`, Freshell has evidence of a restore-durability failure, not proof that durability exists. | Use as the required proof-check boundary. Promote only after the exact rollout proof succeeds. |
| Shell snapshot identity | Shell snapshots are startup environment files keyed by session id and cwd, separate from `thread/resume` history. | Snapshot may exist before rollout, is deleted on drop, and is not consulted by resume. | Do not use as identity or promotion proof. |
| Provider event promotion | `thread/start` response and `thread/started` are pre-user-work candidate surfaces; `turn/start` and turn notifications are post-acceptance surfaces. | Promoting on `thread/started` alone treats an unmaterialized future path as durable. Waiting for turn events cannot prevent first-turn loss. | Use start response/notification for candidate only; promote on rollout proof only. |
| Hidden hook-based materialization | `SessionStart` hooks call `hook_transcript_path()`, which materializes internally. | Requires provider hook configuration and only runs in the first-turn hook path; not a stable external session-start API. | Do not use. |
| Mutating API calls to force persistence | Methods like injecting items can write history, but they mutate provider-visible state. No public no-op materialize method was found in this source pass. | Creates fake history or hidden behavior. | Do not use; under the current constraints there is no source-supported no-op materialization path. |

#### Practical Freshell contract

1. Fresh Codex launch starts in `identity_pending`. Freshell installs the remote websocket proxy/listeners and prepares its own atomic persistence before spawning `codex --remote`.
2. While `identity_pending`, Freshell forwards provider output and resize signals, but not user-originating PTY input. The UI should show a clear starting state rather than silently accepting untracked work.
3. Freshell captures the first valid candidate from either the `thread/start` response or the `thread/started` notification. The candidate must have `ephemeral == false`, a non-empty root TUI `ThreadId`, and a provider-reported absolute `rolloutPath`.
4. Freshell atomically persists the candidate as non-canonical state: provider `codex`, candidate root TUI `ThreadId`, `rolloutPath`, source event/response, CLI version, capture timestamp, and durability state.
5. After that write succeeds, Freshell transitions to `captured_pre_turn` and may unblock user-originating PTY input. This prevents unknown-thread work, but it does not claim the first prompt is restorable.
6. During `turn_in_progress_unproven`, live use may continue. Canonical restore remains unproven and the sidebar must not show durable/green restore state.
7. On `turn/completed` for the captured root TUI `ThreadId`, Freshell transitions to `proof_checking` and performs one exact proof read of the stored `rolloutPath`.
8. Freshell promotes to `durable` only after the proof read finds a regular readable JSONL file whose first record is `type == "session_meta"` and whose `payload.id == candidateThreadId`.
9. If the proof read fails after `turn/completed`, Freshell transitions to `durability_unproven_after_completion`, shows a degraded/error state immediately, and keeps the live terminal attachable only as live terminal access.
10. Freshell registers deterministic repair triggers but never starts a periodic or backoff existence/read loop. Each trigger is one exact proof read.
11. If the process exits before candidate capture, report `non_restorable` and never infer identity from cwd, time, title, or shell snapshot. If it exits after candidate capture but before a turn completes, do one final proof read; a failed proof is still pre-completion leniency, not durability.
12. The residual unproven gap is strict first-turn crash safety. Source shows the normal first user prompt forces rollout materialization, but this version does not expose a public pre-turn materialize RPC. Under the stated constraints, the enforceable boundary is "captured before input, proof check required at turn completion."

#### Current Freshell implementation gap

The current `/home/user/code/freshell/.worktrees/dev` implementation does not yet match this contract. `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/durable-rollout-tracker.ts:6` through `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/durable-rollout-tracker.ts:8` define delayed probe intervals, `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/durable-rollout-tracker.ts:164` through `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/durable-rollout-tracker.ts:205` schedules repeated probes, and `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/durable-rollout-tracker.ts:183` promotes on `pathExists()` rather than a first-record `session_meta` proof. Those lines are incompatible with the no-polling proof contract.

The current app-server client schema handles thread lifecycle notifications and `fs/changed` in `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/protocol.ts:355` through `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/protocol.ts:367`, and dispatches them in `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/client.ts:376` through `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/client.ts:399` and `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/client.ts:447` through `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server/client.ts:482`. This source pass found no `turn/completed` parser under `/home/user/code/freshell/.worktrees/dev/server/coding-cli/codex-app-server`, so the implementation must add a deterministic completion proof-check surface before it can satisfy this contract.

The current recovery path also has a timer-based live-only success surface: `/home/user/code/freshell/.worktrees/dev/server/terminal-registry.ts:1979` through `/home/user/code/freshell/.worktrees/dev/server/terminal-registry.ts:1997` starts a pre-durable stability timer and marks `running_live_only`. Under the revised contract, a live-only state is acceptable only before a completed turn or while visibly degraded after proof failure; it must not be a silent green/grey steady state after `turn/completed`.

### Codex allowed behavior

- Fresh Codex panes may be captured-but-unproven before a turn completes, but user input should not be accepted until the pre-durable candidate root TUI `ThreadId` and provider-reported `rolloutPath` have been captured and persisted.
- Freshell may use `fs/watch` as a wake-up source for Codex durability, but it still needs direct proof at the exact rollout path before promotion. Without polling, a missed filesystem event is repairable only through later deterministic provider/process/user events that each trigger one exact proof read.
- Freshell may only persist canonical Codex identity after the durable `.jsonl` artifact exists at the provider-reported `thread.path` and the first rollout record proves `payload.id == candidateThreadId` on a `session_meta` record.
- Freshell must not treat the bootstrap `thread/start` id as durable restore identity, and must not try to TUI-resume a pre-artifact thread as if it were durable.
- After `turn/completed`, failed proof is `durability_unproven_after_completion`. The user can still attach a live terminal if one exists, but the sidebar/pane state must be visibly degraded until proof succeeds or the session becomes non-restorable.

`codex --help` in the tested mode did not expose a rename or title mutation flag such as `--name`, so no mutable-name surface was confirmed for Codex in this contract.

## Claude Code evidence

### Version

```bash
command -v claude
# /home/user/bin/claude

claude --version
# 2.1.132 (Claude Code)
```

This Claude Code version line was refreshed on `2026-05-06`; the behavior observations below remain from the `2026-04-26` real-provider proof.

The wrapper at `/home/user/bin/claude` shells out to `/home/user/.local/bin/claude`. The isolated probes used the actual binary and overrode `HOME` to keep persistence inside the probe temp root.

### Exact-id durability

Fresh exact-id durability was probed with:

```bash
HOME=<temp-home> /home/user/.local/bin/claude --bare --dangerously-skip-permissions -p --session-id <uuid> "Reply with exactly: claude-home-probe-ok"
```

Observed provider-owned artifacts:

- `.claude/.credentials.json`
- `.claude/policy-limits.json`
- `.claude/projects/*/<uuid>.jsonl`

The UUID-backed transcript file is the canonical durable identity.

### Named resume and rename

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

### Claude Code allowed behavior

- UUID-backed Claude transcript identity is canonical durable identity.
- Named resume values and titles are mutable metadata only.
- Freshell must not persist a mutable title as Claude durable identity.

## OpenCode evidence

### Version

```bash
command -v opencode
# /home/user/.opencode/bin/opencode

opencode --version
# 1.14.41
```

### Run-event identity

Fresh isolated runs were probed with:

```bash
XDG_DATA_HOME=<temp-home>/.local/share XDG_CONFIG_HOME=<temp-home>/.config opencode run "Reply with exactly: opencode-probe-ok" --format json --dangerously-skip-permissions
```

Observed durable identity rule:

- The `2026-04-26` rerun used isolated empty OpenCode data/config roots for the session-identity probes so stale user-local provider configuration could not affect the contract.
- The first JSON `step_start` event carried a `sessionID`.
- That exact `sessionID` matched the `session.id` row written into the isolated OpenCode database.

### Control surface identity

The authoritative control surface was probed with:

```bash
XDG_DATA_HOME=<temp-home>/.local/share XDG_CONFIG_HOME=<temp-home>/.config opencode serve --hostname 127.0.0.1 --port <port>
curl http://127.0.0.1:<port>/global/health
curl http://127.0.0.1:<port>/session/status
```

Observed control behavior:

- `/global/health` returned a healthy payload with version `1.14.41`.
- `/session/status` returned `{}` while idle.
- During an attached `opencode run ... --attach http://127.0.0.1:<port>`, `/session/status` returned the same authoritative `sessionID` with `{ "type": "busy" }`.

### Title behavior

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

### OpenCode allowed behavior

- Canonical OpenCode identity is the authoritative `sessionID`.
- Busy or restore state may only be promoted from the control surface or the canonical DB/session events.
- Titles are metadata and do not replace session identity.
