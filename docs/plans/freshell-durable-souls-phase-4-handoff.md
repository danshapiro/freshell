# Durable Souls Phase 4 handoff

The authoritative Phase 4 implementation is the commit containing this file.
Resolve it with `git rev-parse HEAD`; do not copy a historical SHA into a newer
qualification report.

Phase 4 moves browser tabs and panes to durable **view intents** over
supervisor-owned souls. The supervisor performs bounded startup reconciliation
before its control socket is ready, maintains exact runtime liveness after
startup, and exposes a revisioned inventory. The Rust web server projects view
intents through a durable outbox and an idempotent local cache; the browser
merges that inventory into saved layout without replacing unrelated tabs or
stealing focus.

Delivered surfaces include:

- `crates/freshell-supervisor/src/inventory.rs` and `view_intents.rs`;
- `crates/freshell-server/src/managed_runtime_api.rs`;
- generated public contract in `shared/managed-runtime.ts` and
  `port/contract/managed-runtime.schema.json`;
- always-on browser reconciliation in
  `src/lib/recovery/managed-runtime-recovery.ts`;
- `ManagedAgentRecoveryStatus` and `AgentResourceLimits`;
- compatibility adoption for non-negotiated clients without duplicate launch;
- `test/runtime/gates/phase-4.test.ts` and
  `runtime-tabs-rehydrate-rust.spec.ts`.

Key invariants:

- one soul may have multiple views but only one provider writer;
- close/detach view is distinct from stop agent;
- stop intent and revisions fence stale recreation;
- configured, effective, and actual resource values are separate;
- blocked/recovering/lost states do not become blank fresh sessions;
- managed supervisor truth dominates a stale legacy disk-index absence verdict
  (a live managed facade owning the exact identity wins; unknown managed truth
  answers `error{managed_runtime_unavailable}`, never `dead_session`);
- Node and non-negotiated routes remain honestly legacy.

Phase 4 is qualified cumulatively by the landing gate
(`npm run test:runtime -- gate landing --require-live`) and, once Claude,
Codex, and Amplifier are live-certified, by the full production Gate 5. No
Phase 4 case is deferrable: only the three named providers' `PC-*`
certification cases may be recorded
`DEFERRED_LIVE_PROVIDER_CERTIFICATION`. The final evidence root is
`.runtime-evidence/$(git rev-parse HEAD)/<run-id>/`; see the Phase 5 handoff and
its `summary.json`, assertions, browser receipts, broker log, and cleanup
artifact.
