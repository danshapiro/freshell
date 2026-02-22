# Freshell Agent API: tmux-Compatible Semantics

## 1. Goal

Provide a `freshell` CLI that agents can drive from Bash with tmux-like ergonomics,
while preserving Freshell's multi-device model.

This document is a **unified cutover** design. There is no phased rollout and no
backward-compatibility path.

---

## 2. Locked Product Decisions

The following decisions are fixed:

- **Client-owned layout state**: each device is the source of truth for its own tab/pane/layout state.
- **Server as relay/cache for layout**: server forwards commands/events between devices and stores last-known snapshots; it is not global authority for live per-device layout.
- **Remote control = owner-device RPC**: layout mutations targeting another device are sent to that owner device and applied there.
- **Offline behavior**: if owner device is offline, default to explicit `DEVICE_OFFLINE`.
- **No deferred queueing / surrogate execution**: no server-side queued replay; no server-side substitute owner behavior.
- **Accepted consequence**: deterministic remote layout mutation exists only while owner device is online.
- **Unified cutover**: no legacy parser/shim compatibility mode.

---

## 3. Authority Boundaries (Critical)

The previous draft mixed ownership domains. This cutover defines them explicitly.

### 3.1 Domain A: Layout Authority (Device-Owned)

Owned by one device (`ownerDeviceId`) and mutated only by that owner device runtime:

- tab list/order
- pane tree structure (split/close/swap/resize)
- active tab and active pane pointers
- pane metadata that is UI-owned (titles, browser URL, editor path)
- mapping from pane IDs to content types and process/session references

### 3.2 Domain B: Terminal Process Authority (Server-Owned)

Authoritative on server, independent of browser presence:

- PTY spawn/kill/resize/input
- terminal output stream
- terminal ring buffer / capture source
- terminal exit status and lifecycle events

### 3.3 Domain C: SDK/CodingCLI Session Authority (Server-Owned)

Authoritative on server:

- `sdk.create/send/interrupt/kill/attach`
- `codingcli.create/input/kill`
- provider session state and event stream

### 3.4 Hard Invariant

- Layout mutations are owner-device RPC.
- Process/session operations are server-direct.
- Hybrid operations do both, in that order, with rollback rules.

This preserves your client-owned layout requirement without breaking PTY/session
correctness.

---

## 4. Device Identity and Presence

### 4.1 Device Types

- `browser`: interactive UI device.
- `cli`: headless control device used by `freshell` CLI.

Both are first-class devices for layout ownership.

### 4.2 CLI Local Device Model

`freshell` must have stable local identity.

- Device ID stored at `~/.freshell/cli-device.json`.
- On first run, generate `deviceId` and `deviceLabel` (hostname + username + suffix).
- Omitted `--device` means this CLI device.
- Tabs created by CLI default to `ownerDeviceId = <cli deviceId>`.

This resolves the "local device" ambiguity.

### 4.3 Presence Contract

- Presence comes from active WS connection + heartbeat.
- Server marks device offline after `presenceTtlMs` expiration.
- RPC routing to offline owner returns `DEVICE_OFFLINE` immediately.
- No offline replay queue.

---

## 5. Targeting Model

Ambiguous shorthand is removed.

### 5.1 Device Selector

- `--device <device-id>`: target specific owner device.
- Missing `--device`: current CLI device.

### 5.2 Entity Selectors

Allowed selectors:

- `tab:<tab-id>`
- `tab-name:<name>`
- `tab-index:<n>`
- `pane:<pane-id>`
- `pane-index:<n>` (requires explicit tab selector)
- `terminal:<terminal-id>`
- `session:<provider>:<session-id>`

### 5.3 Resolution Rules

1. Parse selector type.
2. Resolve against owner live state for layout selectors.
3. Resolve against server live registries for `terminal:` / `session:` selectors.
4. Multiple matches are hard errors (`AMBIGUOUS_TARGET`).

No tmux `session:window.pane` compatibility parser.

### 5.4 Selector Support by Command

- Any command argument documented as `--target` or `--tab` accepts relevant selectors
  from this section unless the command explicitly narrows target type.
- `pane-index:<n>` is valid only when a tab selector is also provided (`--tab ...`).
- Class for dual-plane commands is determined after selector resolution:
  `terminal:` / `session:` -> server-direct (`P` / `S`), `pane:` / `pane-index:` -> hybrid (`H`).

---

## 6. Command Routing Classes

### 6.1 Class L: Layout Mutations (Owner RPC)

Require online owner device:

- `new-tab`, `kill-tab`, `rename-tab`, `select-tab`
- `split-pane --browser|--editor`, `kill-pane`, `resize-pane`, `swap-pane`, `select-pane`
- `open-browser`, `navigate`, `open-editor`

If target owner offline: `DEVICE_OFFLINE`.

### 6.2 Class P: Terminal Process Ops (Server-Direct)

Never routed through owner device:

- `send-keys --target terminal:...`
- `capture-pane --target terminal:...`
- `wait-for --target terminal:...`
- `list-terminals`, `respawn-terminal`, `kill-terminal`

These remain deterministic when no browser is connected.
`wait-for` uses a shared server `WaitManager` and stream events; it never relies on
client polling loops.

### 6.3 Class S: SDK/CodingCLI Ops (Server-Direct)

- `sdk.create/send/interrupt/kill/attach`
- `codingcli.create/input/kill`
- CLI aliases (`session-create`, `session-send`, `session-wait`, etc.)

### 6.4 Class H: Hybrid Ops (Layout + Process)

Example: `split-pane --shell`.

Hybrid command forms include:

- `split-pane --shell` (or default terminal split form)
- `respawn-pane --target pane:...`
- `attach-terminal --target terminal:... --to pane:...`
- `send-keys` / `capture-pane` / `wait-for` when target is `pane:...` or `pane-index:...`

Execution order depends on hybrid subtype:

Mutation hybrids (`split-pane --shell`, `attach-terminal`, `respawn-pane`):

1. Owner RPC applies/validates layout mutation and reserves or validates pane reference.
2. Server spawns/attaches/respawns process or terminal binding.
3. Owner RPC finalizes pane content reference (`terminalId` or `sessionRef`).

Resolution hybrids (`send-keys` / `capture-pane` / `wait-for` with pane selectors):

1. Owner RPC resolves pane selector to stable process/session reference.
2. Server executes process/session operation on resolved reference (no layout mutation).

Failure handling:

- Mutation hybrid step 1 fails: no side effects.
- Mutation hybrid step 2 fails: owner receives compensating mutation to remove orphan pane.
- Mutation hybrid step 3 fails: operation returns `INCONSISTENT_STATE`; server retains process and emits remediation guidance.
- Resolution hybrid step 1 fails: return `DEVICE_OFFLINE`, `NOT_FOUND`, or `INVALID_TARGET`.
- Resolution hybrid step 2 fails: return server operation error; no layout side effects.

### 6.5 Routing Matrix (Authoritative)

| command form | class | owner online required | notes |
|---|---|---|---|
| `new-tab` / `kill-tab` / `rename-tab` / `select-tab` | L | yes | layout-only mutation |
| `split-pane --browser|--editor` | L | yes | layout-only pane creation |
| `split-pane --shell` (or default terminal split) | H | yes | owner reserve/finalize + server create/attach |
| `send-keys --target terminal:...` | P | no | server-direct PTY input |
| `send-keys --target pane:...|pane-index:...` | H | yes | owner resolves pane -> terminal, then server input |
| `capture-pane --target terminal:...` | P | no | server buffer read |
| `capture-pane --target pane:...|pane-index:...` | H | yes | owner resolves pane -> terminal, then server read |
| `wait-for --target terminal:...` | P | no | server `WaitManager` on PTY stream |
| `wait-for --target session:...` | S | no | server `WaitManager` on session stream |
| `wait-for --target pane:...|pane-index:...` | H | yes | owner resolves pane ref, then server wait |
| `attach-terminal --target terminal:... --to pane:...` | H | yes | owner layout mutation binding pane contentRef |
| `respawn-terminal --target terminal:...` | P | no | server process lifecycle |
| `respawn-pane --target pane:...|pane-index:...` | H | yes | owner resolution + server respawn + owner finalize |
| `sdk.create/send/interrupt/kill/attach` | S | no | server session authority |
| `codingcli.create/input/kill` | S | no | server session authority |

---

## 7. tmux Mapping (Constrained)

This proposal is tmux-like, not byte-for-byte tmux emulation.

| tmux intent | freshell command | route |
|---|---|---|
| create window/session | `new-tab` | L |
| list windows | `list-tabs` | live owner or cache if `--allow-stale` |
| split pane | `split-pane --direction ...` | L/H |
| send keys | `send-keys` | P (`terminal:` target) / H (`pane:` target) |
| capture output | `capture-pane` | P (`terminal:` target) / H (`pane:` target) |
| wait for completion | `wait-for` | P (`terminal:`), S (`session:`), H (`pane:`) |
| kill pane/window | `kill-pane` / `kill-tab` | L |

Explicitly not supported:

- tmux target grammar (`session:window.pane`)
- transparent tmux wrapper shim

---

## 8. Critical Command Semantics

### 8.1 `send-keys`

Target forms:

- `--target terminal:<id>` (Class P, server-direct)
- `--target pane:<id>|pane-index:<n>` (Class H, requires owner-online pane->terminal resolution)
- `pane-index:<n>` requires `--tab` selector context

Behavior:

- left-to-right token processing
- key token translation (`Enter`, `C-c`, arrows, etc.)
- `-l` means literal mode

If pane target owner offline: `DEVICE_OFFLINE`.
If resolved pane content is not terminal-backed: `INVALID_TARGET`.

### 8.2 `capture-pane`

Target forms mirror `send-keys`:

- `terminal:` target -> Class P
- `pane:` / `pane-index:` target -> Class H
- `pane-index:<n>` requires `--tab` selector context

Semantics:

- `-S <line>` follows tmux-style line indexing against retained history
- `-S -` means full retained history
- `-J` joins wrapped soft-lines only when wrap metadata is available
- `-e` includes ANSI; default strips ANSI

If requested semantics cannot be satisfied exactly (e.g. missing wrap metadata),
return `UNSUPPORTED_CAPTURE_MODE` instead of silently changing meaning.

### 8.3 `wait-for`

Targets `terminal:`, `session:`, or pane selectors (`pane:` / `pane-index:`).

Predicates:

- `--pattern <text-or-regex>`
- `--literal` (default when `--pattern` is provided)
- `--regex` (opt-in)
- `--from now|tail:N` (default: `now`)
- `--stable <seconds>`
- `--exit`
- `--prompt` (terminal mode only; heuristic)

Combination rule:

- multiple predicates are **AND** conditions
- no predicates provided is `INVALID_ARGUMENT`
- `--stable` is non-latching and must be true at completion time

Execution model (performance-critical):

- All waits are managed by one server `WaitManager` keyed by terminal/session target.
- No polling against `capture-pane`; no full `buffer.snapshot()` rescans in steady state.
- Each target stream has a monotonic `outputSeq`.
- Each wait records `startSeq`, `lastSeqChecked`, and a small carry buffer for
  cross-chunk pattern boundaries.
- Matching evaluates only incremental chunks `> lastSeqChecked`.
- Pattern/exit/prompt predicates latch true when satisfied.
- `stable` is evaluated as a level condition and resets on every new output event.
- Command succeeds when all requested predicates are true.
- Timeout returns `TIMEOUT` with predicate progress.

Pattern engine contract:

- `--literal` uses incremental substring search and is the default.
- `--regex` is allowed only with a safe linear-time regex engine (RE2 class).
- Regex compilation happens once per wait request, never per chunk.
- If safe regex engine is unavailable, return `UNSUPPORTED_PATTERN_ENGINE`.

Timer/scheduler contract:

- Stable/timeout checks use central scheduler structures (timer wheel or min-heap),
  not ad-hoc per-chunk polling loops.
- Wait evaluation runs with per-tick CPU budget; overflow work is deferred by
  `setImmediate`/equivalent to protect event loop responsiveness.

`--stable` contract:

- `--stable N` means: no output events for `N` continuous seconds on target stream.
- Stable timer resets whenever new output is observed.
- `--stable` observes stream activity from wait registration time forward
  (`--from` affects pattern scan window only).
- With `--exit`, success requires exit observed and stable window satisfied after
  the later of (exit event time, last output time).

Resource limits and load-shedding:

- `WAIT_MAX_GLOBAL`: max active waits across server.
- `WAIT_MAX_PER_TARGET`: max active waits per terminal/session target.
- `WAIT_MAX_TIMEOUT_SEC`: hard upper bound on timeout duration.
- `WAIT_MAX_PATTERN_BYTES`: max pattern size.
- `WAIT_MAX_REGEX_PER_TARGET`: regex wait budget per target.
- Excess wait requests fail fast with `RESOURCE_LIMIT`.
- Under overload, reject new regex waits before literal waits.
- Deduplicate identical active waits on the same target and fan out one matcher
  result to multiple callers.
- Backpressure or wait overload must not degrade terminal output fanout.

Prompt heuristic contract:

- explicitly best-effort
- never sole correctness guarantee for destructive operations
- should be treated as advisory signal unless combined with stronger predicates
- baseline heuristic: shell-like prompt token at end-of-line after ANSI-stripping
  (`$`, `#`, `>`, `%`); implementation may extend but must document false-positive risk

### 8.4 `attach-terminal`

`attach-terminal --target terminal:<id> --to pane:<id>|pane-index:<n>`:

- owner RPC updates pane mapping to referenced terminal
- no process transfer; only pane binding change
- requires owner online
- `pane-index:<n>` requires `--tab` selector context
- class is `H` (layout mutation + process reference rebind)
- request must include `expectedRevision` and `idempotencyKey`
- revision mismatch returns `REVISION_CONFLICT` with `currentRevision`

### 8.5 `navigate`

`navigate --target pane:<id> <url>`:

- layout/UI metadata mutation owned by pane owner device
- routed via owner RPC
- validates URL before apply

### 8.6 `respawn`

Two explicit forms:

- `respawn-terminal --target terminal:<id>` (P)
- `respawn-pane --target pane:<id>|pane-index:<n>` (H: owner resolves pane, server respawns bound process, owner updates refs)

### 8.7 `display`

`display` is a pure read command; it never mutates layout/process state.

Format grammar:

- `-p FORMAT` is a token template rendered once.
- Supported tokens: `%deviceId`, `%tabId`, `%tabTitle`, `%paneId`, `%paneKind`,
  `%terminalId`, `%sessionRef`, `%ownerOnline`, `%workspaceRevision`.
- `%%` escapes to literal `%`.
- Unknown tokens return `INVALID_ARGUMENT`.
- Missing values render as empty string.

### 8.8 `session-create`

`session-create` maps directly to existing server message contracts:

- `--provider sdk` -> `sdk.create` (`cwd`, `resumeSessionId`, `model`,
  `permissionMode`, `effort`).
- `--provider codingcli` -> `codingcli.create` and requires:
  `--coding-provider <claude|codex|opencode|gemini|kimi>` and `--prompt <text>`.

If required provider-specific arguments are missing, return `INVALID_ARGUMENT`.

---

## 9. RPC Protocol (Layout Plane)

### 9.1 Messages

- `layout.rpc.request`
- `layout.rpc.ack`
- `layout.rpc.result`
- `device.presence`
- `layout.snapshot.updated`

### 9.2 Request Envelope

```json
{
  "type": "layout.rpc.request",
  "requestId": "req_123",
  "callerDeviceId": "cli_dev_1",
  "targetDeviceId": "dandesktop",
  "command": "split-pane",
  "args": {
    "target": "pane:p_abc",
    "direction": "horizontal"
  },
  "expectedRevision": 42,
  "idempotencyKey": "idem_123"
}
```

### 9.3 Timeout/Error Stages

- `RPC_TIMEOUT`: relay-level failure before owner ack (delivery stage).
- `OWNER_TIMEOUT`: owner acked but did not complete before deadline (execution stage).

Error payload includes `stage: relay|owner`.

### 9.4 Delivery Contract

- at-most-once relay delivery
- idempotency keys required for owner-routed mutating commands (`new-tab`,
  `split-pane --shell`, `attach-terminal`, `respawn-pane`)
- CLI auto-generates idempotency keys when omitted; `--idempotency-key` allows
  caller-specified stable retry identity.
- no queued replay after reconnect

---

## 10. Cache and Read Semantics

Server cache is last-known snapshot only.

### 10.1 Read Modes

- default: live owner required for layout reads
- `--allow-stale`: permit cached layout snapshot

### 10.2 Freshness Fields

Any cache-backed result includes:

- `source: "cache" | "live"`
- `capturedAt`
- `ownerOnline`
- `ownerLastSeenAt`

Process/session reads (`terminal:` / `session:`) are live server reads and do not
require owner presence.

---

## 11. Data Model

### 11.1 Layout Entities (Authoritative on Owner Device)

Tab minimum fields:

- `id`
- `ownerDeviceId`
- `title`
- `status`
- `createdAt`
- `updatedAt`

Pane minimum fields:

- `id`
- `tabId`
- `ownerDeviceId`
- `kind` (`terminal|browser|editor|claude-chat|picker`)
- `status`
- `contentRef` (`terminalId` or `sessionRef` where applicable)
- `updatedAt`

Owner workspace metadata minimum fields:

- `ownerDeviceId`
- `workspaceRevision`
- `updatedAt`

### 11.2 Process/Session Entities (Authoritative on Server)

Terminal fields:

- `terminalId`
- `mode`
- `status`
- `createdAt`
- `lastActivityAt`
- `bufferRef`

SDK/CodingCLI session fields:

- `provider`
- `sessionId`
- `status`
- `updatedAt`

### 11.3 Revision Rules

- Revision scope is per owner workspace (`workspaceRevision` monotonic per `ownerDeviceId`).
- Tab/pane entities do not maintain independent revision counters.
- Every successful layout mutation increments `workspaceRevision` by 1.
- RPC mutation must provide `expectedRevision`.
- CLI supports `--expected-revision` on layout-mutating commands; when omitted, CLI
  performs a live owner read and injects current `workspaceRevision`.
- If owner is offline, revision preflight fails with `DEVICE_OFFLINE`.
- Mismatch returns `REVISION_CONFLICT` with `currentRevision` (`workspaceRevision`).
- Successful mutation responses include `appliedRevision`.
- Initial revision after migration: `1`.

---

## 12. Security Model

### 12.1 Token Flow

- `AUTH_TOKEN` remains bootstrap auth for server access.
- CLI exchanges bootstrap auth for short-lived device session token via `POST /api/device-sessions`.
- Device token TTL: 15 minutes; renewable via refresh endpoint.
- Device token scopes include device-bound layout write scope.
- CLI mutating commands auto-refresh device token when expiry is near; refresh failure
  returns `UNAUTHORIZED` with re-login guidance.

### 12.2 Credential Storage

- CLI credential path: `~/.freshell/cli-auth.json`.
- File mode must be `0600`; refuse startup if broader.
- Child process env must never include long-lived auth tokens.

### 12.3 Authorization Rules

For cross-device layout mutation:

- same authenticated principal required
- caller must have remote-control scope for target device
- deny by default without explicit permission

### 12.4 Audit Log

Server writes JSONL at `~/.freshell/audit/remote-control.jsonl`:

- `requestId`
- `callerDeviceId`
- `targetDeviceId`
- `command`
- `result`
- `errorCode`
- `stage`
- `timestamp`

### 12.5 CLI Auth Command Contract

- `freshell auth login`: exchange bootstrap credentials for device session token.
- `freshell auth status`: show token expiry and active device binding.
- `freshell auth refresh`: proactively renew device token.
- `freshell auth logout`: remove local credential file and invalidate refresh token.

---

## 13. Migration and Cutover

Unified cutover still requires deterministic migration.

### 13.1 Client-Side Layout Migration

On first cutover startup, each device:

1. loads local tabs/panes
2. stamps missing `ownerDeviceId` with local `deviceId`
3. initializes `workspaceRevision = 1`
4. writes migrated local state
5. publishes `layout.snapshot.updated` to server

### 13.2 Server Migration

- Existing cached snapshots without owner metadata are rejected after cutover.
- Server accepts only `layoutOwnershipV1` clients.
- Legacy clients are denied with explicit version error.

### 13.3 Capability Gate

Cutover prerequisite:

- extend `HelloSchema.capabilities` in `shared/ws-protocol.ts` and handshake parsing
  in `server/ws-handler.ts` with cutover fields below.
- existing capability fields (`sessionsPatchV1`, `terminalAttachChunkV1`) remain
  supported and orthogonal.

`hello.capabilities` must include:

- `layoutOwnershipV1: true`
- `layoutRpcV1: true`
- `devicePresenceV1: true`

No compatibility path for old capability sets.

---

## 14. Error Model

Canonical command/operation errors (post-cutover):

- `DEVICE_OFFLINE`
- `RPC_TIMEOUT`
- `OWNER_TIMEOUT`
- `REVISION_CONFLICT`
- `NOT_FOUND`
- `AMBIGUOUS_TARGET`
- `INVALID_TARGET`
- `INVALID_ARGUMENT`
- `UNAUTHORIZED`
- `RESOURCE_LIMIT`
- `UNSUPPORTED_PATTERN_ENGINE`
- `UNSUPPORTED_CAPTURE_MODE`
- `TIMEOUT`
- `INCONSISTENT_STATE`
- `INTERNAL_ERROR`

Protocol alignment requirement:

- `shared/ws-protocol.ts` `ErrorCode` enum must be extended with all command/operation
  codes above before enabling cutover.
- Client and server error handlers must be updated to support the expanded union.
- Existing transport/auth errors (`NOT_AUTHENTICATED`, `INVALID_MESSAGE`,
  `UNKNOWN_MESSAGE`, etc.) remain valid and unchanged.

CLI contract:

- non-zero exit on error
- `--json` output includes `code`, `message`, `details`, and (when relevant) `stage`

---

## 15. Command Surface (Cutover)

Selector note:

- `--target` and `--tab` accept selector forms from section 5.2 unless narrowed.
- `pane-index:<n>` requires `--tab ...`.

Mutation concurrency note:

- all Class L/H mutating commands accept `--expected-revision N` (or auto-resolve per section 11.3).
- commands requiring protocol idempotency (`new-tab`, `split-pane --shell`,
  `attach-terminal`, `respawn-pane`) accept `--idempotency-key KEY` (auto-generated if omitted).

```bash
# Device, presence, and auth
freshell list-devices
freshell device-status --device DEVICE
freshell auth login [--auth-token TOKEN|--from-env AUTH_TOKEN]
freshell auth status
freshell auth refresh
freshell auth logout

# Layout (Class L/H)
freshell new-tab [--device DEVICE] [-n NAME] [--shell SHELL] [--cwd DIR] [--expected-revision N] [--idempotency-key KEY]
freshell list-tabs [--device DEVICE] [--allow-stale]
freshell select-tab --device DEVICE --target tab:ID|tab-name:NAME|tab-index:N [--expected-revision N]
freshell kill-tab --device DEVICE --target tab:ID|tab-name:NAME|tab-index:N [--expected-revision N]
freshell rename-tab --device DEVICE --target tab:ID|tab-name:NAME|tab-index:N NAME [--expected-revision N]

freshell split-pane --device DEVICE --target pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] --direction horizontal|vertical [--shell SHELL|--browser URL|--editor FILE] [--expected-revision N] [--idempotency-key KEY]
freshell list-panes [--device DEVICE] [--tab tab:ID|tab-name:NAME|tab-index:N] [--allow-stale]
freshell select-pane --device DEVICE --target pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] [--expected-revision N]
freshell kill-pane --device DEVICE --target pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] [--expected-revision N]
freshell resize-pane --device DEVICE --target pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] [-x WIDTH] [-y HEIGHT] [--expected-revision N]
freshell swap-pane --device DEVICE --source pane:SRC|pane-index:SRC_IDX --target pane:DST|pane-index:DST_IDX [--tab tab:ID|tab-name:NAME|tab-index:N] [--expected-revision N]

freshell open-browser --device DEVICE --target pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] URL [--expected-revision N]
freshell navigate --device DEVICE --target pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] URL [--expected-revision N]
freshell open-editor --device DEVICE --target pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] FILE [--expected-revision N]

# Terminal process (Class P/H by target type)
freshell list-terminals
freshell send-keys --target terminal:ID|pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] [--device DEVICE] [-l] [KEYS...]
freshell capture-pane --target terminal:ID|pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] [--device DEVICE] [-S START] [-J] [-e]
freshell wait-for --target terminal:ID|pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] [--device DEVICE] [--from now|tail:N] [-p PATTERN] [--literal|--regex] [--stable N] [--exit] [--prompt] [-T TIMEOUT]
freshell respawn-terminal --target terminal:ID
freshell respawn-pane --target pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] --device DEVICE [--expected-revision N] [--idempotency-key KEY]
freshell kill-terminal --target terminal:ID
freshell attach-terminal --target terminal:ID --to pane:ID|pane-index:N [--tab tab:ID|tab-name:NAME|tab-index:N] --device DEVICE [--expected-revision N] [--idempotency-key KEY]

# SDK/CodingCLI sessions (Class S)
freshell session-create --provider sdk [--cwd DIR] [--resume-session-id ID] [--model MODEL] [--permission-mode MODE] [--effort low|medium|high|max]
freshell session-create --provider codingcli --coding-provider claude|codex|opencode|gemini|kimi --prompt TEXT [--cwd DIR] [--resume-session-id ID] [--model MODEL] [--max-turns N] [--permission-mode default|plan|acceptEdits|bypassPermissions] [--sandbox read-only|workspace-write|danger-full-access]
freshell session-list [--provider PROVIDER]
freshell session-send --target session:PROVIDER:ID TEXT
freshell session-wait --target session:PROVIDER:ID [--from now|tail:N] [-p PATTERN] [--literal|--regex] [--stable N] [-T TIMEOUT]
freshell session-kill --target session:PROVIDER:ID

# Utility
freshell display --device DEVICE -p FORMAT [--target pane:ID|pane-index:N] [--tab tab:ID|tab-name:NAME|tab-index:N]
freshell health
freshell lan-info
```

---

## 16. Unified Cutover Acceptance Checklist

All items required before merge:

1. Authority boundaries implemented (layout owner-routed; process/session server-direct).
2. CLI stable device identity implemented (`~/.freshell/cli-device.json`).
3. Layout RPC protocol implemented with relay/owner stage errors.
4. Presence + `DEVICE_OFFLINE` behavior enforced for Class L/H commands.
5. No server-side layout surrogate execution and no replay queue.
6. Explicit selector parser implemented; ambiguous shorthand removed.
7. `send-keys` / `capture-pane` / `wait-for` route by resolved target (`terminal/session` server-direct, `pane` hybrid owner-resolved).
8. SDK/CodingCLI command path integrated and documented (including protocol-aligned `session-create` parameters).
9. Revision conflict handling implemented with workspace-level `expectedRevision` and `currentRevision`.
10. Security token flow, auth command lifecycle, and credential permission checks implemented.
11. Migration implemented for owner metadata and revision initialization.
12. Capability gate enabled with schema/handler support (`shared/ws-protocol.ts` `HelloSchema.capabilities` + `server/ws-handler.ts` parsing); legacy clients rejected.
13. Unit/integration/e2e coverage updated for routing, offline behavior, and hybrid rollback.
14. Docs reflect only cutover semantics; no phased/back-compat language remains.
15. Server `WaitManager` implemented as event-driven incremental matcher (no polling, no repeated full-buffer scans).
16. Wait resource caps and load-shedding implemented (`WAIT_MAX_*`, `RESOURCE_LIMIT`) with tests.
17. Performance telemetry implemented for waits (`wait_active`, `wait_match_latency_ms`, `wait_eval_ms`, `wait_timeouts_total`, `wait_resource_limit_total`, `wait_backlog_depth`).
18. SLOs defined and validated under load: no terminal-stream regression with waits enabled, and bounded p99 wait match latency.
19. Load tests added for high-output terminals, many concurrent waits, regex-heavy/adversarial patterns, and timeout churn.
20. Shared `ErrorCode` union expanded and validated end-to-end for all cutover command errors.

---

## 17. Non-Goals

- tmux command parser compatibility shim
- server-authoritative global live layout state
- offline queue/replay for remote layout mutation
- CRDT/OT collaborative layout merge in this cutover

---

## 18. Rationale

This design keeps your core constraint intact (device-owned layout authority) while
resolving operational contradictions:

- Browser/device ownership governs layout semantics.
- Server-owned PTY and SDK authorities preserve reliability for agent automation.
- Remote layout mutation remains explicit and fail-fast (`DEVICE_OFFLINE`) when owner
  is unavailable.
- The CLI has a first-class device identity, so "local" is deterministic.
