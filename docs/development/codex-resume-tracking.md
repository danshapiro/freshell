# Codex Resume Tracking

Freshell's Rust server tracks a Codex terminal pane's canonical durable thread
across three identity lanes. Each lane converges on the same shared
adopt/rebind tail so every identity home (in-memory store, registry meta,
durable pane ledger, broadcast frames, activity hub, sidecar record, disk
fork watch) moves atomically.

## The Three Identity Lanes

1. **Startup rollout locator window** (`codex_locator`): on a fresh codex pane
   the locator arms a short window after the first Enter and scans the
   sessions tree for a rollout whose `cwd` matches the pane's. The first
   matching rollout binds (D-03 first-bind-wins). Managed panes
   (`FRESHELL_CODEX_MANAGED_LAUNCH=1`, the default) suppress this lane — the
   proxy candidate is authoritative instead.

2. **Disk fork watch** (`watch_fork` → `tick_forks`): after adoption or rebind,
   the pane is registered to watch its bound thread's forks on disk. A
   `forked_from_id == bound id` rollout appearing in a later scan window
   triggers `rebind_codex_identity` (the D-FORK lane). One watch per terminal;
   a re-point (resume or fork) REPLACES the watch (overwrite semantics).

3. **Remote-proxy resume arm** (D-RESUME): a `thread/resume` JSON-RPC
   *response* candidate extracted by the proxy is the ONLY source allowed to
   MOVE an existing binding. It is the TUI's server-authoritative,
   request-correlated report of an in-TUI switch. D-03 still governs
   `thread/start` and `thread/started` — first bind wins there. Resume of the
   currently bound thread is a no-op.

## Shared Adopt/Rebind Tail

Both adoption (first bind) and rebind (mid-session move) funnel through
`apply_codex_identity` in `codex_identity.rs`, which writes in the pinned
load-bearing order:

1. `identity.upsert` — in-memory identity store
2. `registry.set_meta` — terminal registry meta (resume_session_id)
3. `ledger_resolve_identity` — durable pane ledger (fsync-before-announce)
4. `broadcast terminal.session.associated` — with `previousSessionId` on a
   rebind, absent on a first bind
5. `broadcast terminal.meta.updated` — upsert row with provider + sessionId
6. `activity.bind_codex_session` + `attach_codex_rollout` — activity hub re-key

After the tail, the fan-out continues:
- `note_session_id` — the durable sidecar record's restore-time reattach key
- `watch_fork` — re-register the disk fork watch at the new thread
  (spawn_blocking; bounded fs walk)

On a rebind, the ledger supersedes the old row (Retired, Superseded,
supersededBy the new id) before binding the new row.

## Recovery Funnel

Idle reap, browser reconnect, and server restart all funnel through the same
resume path: the client's persisted `sessionRef {provider: "codex",
sessionId}` drives a restore-style `terminal.create` that spawns
`codex resume <id>`. The sidecar record's `session_id` (set by
`note_session_id`) is the reattach key the reconciler uses to claim a
surviving sidecar.

## Fail-Closed Continuity Gates

- `deploy-tab-diff.sh` verdicts: `RE-POINTED` (sessionRef moved) and
  `NO CAPTURED IDENTITY` (unresolved coding pane) — the detection net for
  switches made while the server was down.
- `resume_validation` gate: a restore create with a `sessionRef` whose
  rollout is absent from disk demotes to a fresh spawn (never resumes a
  ghost).
- `codex_claim_refused` guards: D7 live-owner, A13 no-live-owner-of-new, A8
  retired-inclusive, freshagent lane — prevent hijack and misbind.

## Residuals

- A thread switch made while the Freshell server is down is outside this
  change's detection lifetime; the pane-ledger supersession chain plus the
  deploy-tab-diff verdicts remain the detection net. A `~/.codex/logs_2.sqlite`
  corroborating tail is deferred to a later job.
- The unmanaged launch lane (`FRESHELL_CODEX_MANAGED_LAUNCH=0`) has no remote
  proxy and stays startup-locator-scoped for resume detection.
- User-set tab titles never migrate across a rebind; an automatic tab title
  adopts the resumed session's session-directory title only when the client
  already knows one.
