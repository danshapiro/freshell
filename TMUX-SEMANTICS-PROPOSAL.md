# Freshell Agent API: tmux-Compatible Semantics

## 1. Goal

Provide a `freshell` CLI that AI agents can drive from Bash with tmux-like ergonomics,
while using Freshell's native multi-device model.

This proposal is a **unified cutover**. There is no phased rollout and no backward
compatibility layer.

---

## 2. Final Architecture Decisions (Locked)

The following decisions are final and drive every API and protocol choice in this doc:

- **Client-owned state**: each device is the source of truth for its own pane/tab/layout state.
- **Server as relay/cache**: server forwards commands/events between devices and keeps last-known snapshots, but does not become global authority for live per-device layout.
- **Remote control = RPC to owner device**: operations like "open pane on dandesktop" are sent to that owner device and applied there.
- **Offline behavior**: if the owner device is offline, return explicit error `DEVICE_OFFLINE`.
- **No deferred queueing / surrogate execution**: no server-side queued replay, no server-side substitute owner behavior.
- **Accepted consequence**: deterministic remote mutation is available only while the owner device is online.
- **Rollout direction**: unified cutover, no phased backward-compat path.

---

## 3. Conceptual Model

### 3.1 tmux to Freshell Translation

| tmux concept | Freshell equivalent | Notes |
|---|---|---|
| Server | Freshell server | Relay/cache + auth + discovery |
| Session | Device workspace | Not global; owned by a connected device |
| Window | Tab | Owned by one device |
| Pane | Pane | Owned by one device |
| Client | Browser/CLI process | Can control local or remote owner via RPC |

### 3.2 Ownership Model

Every tab and pane has an immutable `ownerDeviceId`.

- Local commands mutate local owned entities directly.
- Remote commands route to the entity owner.
- Ownership transfer is explicit (not implicit side effect).

### 3.3 State Classes

- **Authoritative live state**: maintained in owner device runtime.
- **Relay/cache state**: last-known snapshot in server for discovery and stale reads.
- **Historical/registry state**: existing registry artifacts for search and history.

---

## 4. Addressing and Targeting

Ambiguous target parsing is not allowed.

### 4.1 Device Selector

- `--device <device-id>`: explicit owner device target.
- Omitted `--device` means "local device only" for mutating commands.

### 4.2 Entity Selectors

Use explicit selector prefixes:

- `tab:<tab-id>`
- `tab-name:<name>`
- `tab-index:<n>` (index in owner device tab order)
- `pane:<pane-id>`
- `pane-index:<n>` (index in specified tab)

### 4.3 Resolution Rules

1. Parse selector type.
2. Resolve against owner device state (live if online; cached only for reads).
3. If resolution yields 0 or >1 results, return `AMBIGUOUS_TARGET` or `NOT_FOUND`.

No tmux `session:window.pane` parsing. No shorthand numeric heuristics.

---

## 5. Command Semantics

## 5.1 Core tmux-like Commands

| tmux command | freshell command | cutover behavior |
|---|---|---|
| `new-session` / `new-window` | `freshell new-tab` | Creates tab on local device, or remote owner via `--device` RPC |
| `list-sessions` / `list-windows` | `freshell list-tabs` | Lists tabs for selected device; can show stale cache metadata |
| `kill-session` / `kill-window` | `freshell kill-tab` | Must execute on owner device |
| `split-window` | `freshell split-pane` | Must execute on owner device; direction flag must be honored |
| `list-panes` | `freshell list-panes` | Device-scoped pane list |
| `select-pane` | `freshell select-pane` | Sets active pane on owner device |
| `kill-pane` | `freshell kill-pane` | Owner-executed mutation |
| `send-keys` | `freshell send-keys` | Owner-executed; writes to target terminal |
| `capture-pane` | `freshell capture-pane` | Read path from owner live buffer if online, else stale cache only when explicitly requested |

### 5.1.1 Mutating Commands

All mutating commands require deterministic owner routing:

- `new-tab`
- `kill-tab`
- `split-pane`
- `kill-pane`
- `resize-pane`
- `swap-pane`
- `select-tab`
- `select-pane`
- `send-keys`
- `attach`
- `respawn-pane`
- `navigate`
- `open-browser`

If owner device is offline: fail fast with `DEVICE_OFFLINE`.

### 5.1.2 Read Commands

Read commands support two modes:

- default: require live owner response.
- `--allow-stale`: return server cached snapshot if owner offline; include freshness metadata.

### 5.1.3 `send-keys`

`send-keys` keeps tmux-like key-token semantics:

- ordered left-to-right token processing
- key token translation (`Enter`, `C-c`, arrows, etc.)
- `-l` for literal mode

Execution always occurs on the owner device process that owns the pane.

### 5.1.4 `capture-pane`

Define strict v1 semantics:

- Capture source is owner terminal ring buffer.
- `-S N` means "tail from line offset N relative to end" after server-side normalization.
- `-J` joins wrapped soft-lines only if wrap metadata exists; otherwise returns normalized hard lines.
- `-e` includes ANSI; default strips ANSI.

If owner offline and `--allow-stale` not set: `DEVICE_OFFLINE`.

### 5.1.5 `wait-for`

`wait-for` is an owner-executed operation:

- `-p/--pattern`: regex over normalized stream
- `--stable N`: no output for N seconds
- `--exit`: process exit
- `--prompt`: best-effort heuristic
- `-T`: timeout seconds

Return machine-readable reason fields:

- `matched`
- `stabilized`
- `exited`
- `timed_out`
- `device_offline`

---

## 6. Device RPC Protocol (Primary Control Plane)

Remote control is implemented as request/response RPC over WS relay.

### 6.1 Message Types

- `device.rpc.request`
- `device.rpc.response`
- `device.presence`
- `device.snapshot.updated`
- `device.event`

### 6.2 Request Envelope

```json
{
  "type": "device.rpc.request",
  "requestId": "req_123",
  "callerDeviceId": "laptop",
  "targetDeviceId": "dandesktop",
  "command": "split-pane",
  "args": {
    "target": "pane:p_abc",
    "direction": "horizontal"
  },
  "idempotencyKey": "idem_123"
}
```

### 6.3 Response Envelope

```json
{
  "type": "device.rpc.response",
  "requestId": "req_123",
  "ok": false,
  "error": {
    "code": "DEVICE_OFFLINE",
    "message": "Target device is offline"
  }
}
```

### 6.4 Delivery Contract

- At-most-once relay delivery.
- Idempotency keys required for create/split/attach/respawn operations.
- No queued replay when target reconnects.

### 6.5 Timeouts

- Relay timeout: `RPC_TIMEOUT`.
- Owner does not acknowledge in time: `OWNER_TIMEOUT`.
- Caller receives explicit terminal error; no deferred completion.

---

## 7. Server Role: Relay + Cache (Not Global SoT)

Server responsibilities:

- authenticate callers
- track device presence
- route RPC requests/responses
- persist last-known snapshots per device
- expose cached discovery endpoints

Server non-responsibilities:

- no authoritative live mutation of per-device layout
- no queueing pending mutations for offline devices
- no substitute owner execution

### 7.1 Snapshot Cache Shape

Each cached snapshot contains:

- `deviceId`
- `snapshotVersion`
- `capturedAt`
- `tabs[]` and pane trees
- `activeTabId` and active pane map
- `stale` (derived)

### 7.2 Freshness Metadata

Any cache-backed response includes:

- `source: live|cache`
- `capturedAt`
- `ownerOnline: boolean`

---

## 8. Data Model

## 8.1 Required Fields

Tab:

- `id`
- `ownerDeviceId`
- `title`
- `createdAt`
- `revision`

Pane:

- `id`
- `ownerDeviceId`
- `tabId`
- `kind`
- `revision`

### 8.2 Revisions and Concurrency

Owner device applies a monotonic revision per owned workspace.

- Mutations include expected revision.
- Mismatch returns `REVISION_CONFLICT` with current revision.
- Caller may re-read and retry.

CRDT/OT is out of scope for cutover.

---

## 9. CLI Design

### 9.1 Principles

- Automation-first: stable machine parse (`--json`).
- Explicit owner routing.
- Explicit errors; no hidden fallbacks.

### 9.2 Examples

```bash
# Local device mutation
freshell new-tab -n "dev"

# Remote mutation routed to owner device
freshell split-pane --device dandesktop -t pane:p_abc --direction horizontal

# Explicit offline failure behavior
freshell kill-pane --device dandesktop -t pane:p_abc
# -> exits non-zero with DEVICE_OFFLINE if owner is offline

# Read with stale allowed
freshell list-tabs --device dandesktop --allow-stale --json
```

### 9.3 Command Reference (Cutover)

```bash
# Device
freshell list-devices
freshell device-status --device DEVICE

# Tabs
freshell new-tab [--device DEVICE] [-n NAME] [--shell SHELL] [--cwd DIR]
freshell list-tabs [--device DEVICE] [--allow-stale]
freshell select-tab --device DEVICE -t tab:ID
freshell kill-tab --device DEVICE -t tab:ID
freshell rename-tab --device DEVICE -t tab:ID NAME

# Panes
freshell split-pane --device DEVICE -t pane:ID --direction horizontal|vertical
freshell list-panes [--device DEVICE] [-t tab:ID] [--allow-stale]
freshell select-pane --device DEVICE -t pane:ID
freshell kill-pane --device DEVICE -t pane:ID
freshell resize-pane --device DEVICE -t pane:ID [-x WIDTH] [-y HEIGHT]
freshell swap-pane --device DEVICE -s pane:SRC -t pane:DST

# I/O
freshell send-keys --device DEVICE -t pane:ID [-l] [KEYS...]
freshell capture-pane --device DEVICE -t pane:ID [-S LINES] [-J] [-e] [--allow-stale]
freshell wait-for --device DEVICE -t pane:ID [-p PATTERN] [--stable N] [--exit] [--prompt] [-T TIMEOUT]

# Browser/editor
freshell open-browser --device DEVICE -t pane:ID URL
freshell navigate --device DEVICE -t pane:ID URL
freshell split-pane --device DEVICE -t pane:ID --browser URL --direction horizontal|vertical
freshell split-pane --device DEVICE -t pane:ID --editor FILE --direction horizontal|vertical

# Utility
freshell display --device DEVICE -p FORMAT -t pane:ID
freshell health
freshell lan-info
```

---

## 10. Error Model

Required error codes:

- `DEVICE_OFFLINE`
- `OWNER_TIMEOUT`
- `RPC_TIMEOUT`
- `NOT_FOUND`
- `AMBIGUOUS_TARGET`
- `INVALID_TARGET`
- `REVISION_CONFLICT`
- `UNAUTHORIZED`
- `UNSUPPORTED`
- `INTERNAL_ERROR`

CLI requirements:

- non-zero exit code on any error
- `--json` error body includes `code`, `message`, `details`

---

## 11. Security Model

### 11.1 Token Handling

- Do not inject long-lived server auth token into spawned shell env.
- Use scoped control tokens for CLI/RPC sessions.
- Store local credentials with strict file permissions.

### 11.2 Authorization

Server enforces caller policy for cross-device operations:

- same user namespace required
- optional explicit allowlist per device
- audit log for remote mutation attempts

### 11.3 Audit Events

Minimum audit fields:

- `requestId`
- `callerDeviceId`
- `targetDeviceId`
- `command`
- `result`
- `timestamp`

---

## 12. Unified Cutover Checklist

All items are required before landing:

1. Device ownership fields added to tab/pane models.
2. Owner-device RPC protocol implemented (`request`, `response`, presence).
3. Server relay/cache behavior implemented without surrogate mutation paths.
4. `DEVICE_OFFLINE` behavior implemented and tested across all mutating commands.
5. Explicit target parsing implemented; ambiguous shorthand removed.
6. No compatibility shim, no session/window legacy parser, no deferred queue.
7. CLI `--json` success/error schema finalized and documented.
8. Security changes landed (no long-lived token injection into child env).
9. Unit tests for target parsing, routing, error codes, revision conflicts.
10. Integration tests for live remote mutate and offline failure.
11. E2E tests for agent-critical flows (`send-keys`, `wait-for`, `capture-pane`).
12. Docs and examples updated to cutover semantics only.

---

## 13. Non-Goals

- No backward compatibility with tmux target syntax.
- No server-authoritative global layout state.
- No queued/deferred remote execution.
- No CRDT/OT collaborative merge model in cutover scope.

---

## 14. Rationale

This model optimizes for correctness of ownership boundaries and predictable failure
semantics:

- A device always controls its own live workspace state.
- Remote mutation is deterministic when and only when owner is online.
- Offline behavior is explicit and immediate, never hidden behind replay queues.
- The server remains simple and reliable as relay/cache/auth infrastructure.

