# Durable Souls Phase 5 handoff

The authoritative candidate is the commit containing this file. Resolve it with
`git rev-parse HEAD`. All final receipts and the cumulative gate must be under
that exact SHA; no tracked edit is permitted after qualification without
regenerating every SHA-bound receipt and rerunning Gate 5.

## Release gates for this landing

Two gates run the same cumulative body over the commit containing this file:

```bash
# Landing / pre-certification gate. PASS is permitted while exactly Claude,
# Codex, and Amplifier are recorded DEFERRED_LIVE_PROVIDER_CERTIFICATION.
npm run test:runtime -- gate landing --require-live

# Full production Gate 5. Reports BLOCKED (exit 2) with
# blockedReason "pending_live_provider_certification" until those three pass
# their live campaigns. BLOCKED is never PASS.
npm run test:runtime -- gate phase-5 --require-live
```

Each run enumerates every cumulative case plus one `PC-<PROVIDER>`
certification case per managed-or-queued provider, and classifies each as
`PASS`, `DEFERRED_LIVE_PROVIDER_CERTIFICATION`, `BLOCKED`, or `FAIL`. Only the
three named providers may be deferred, and only in landing mode. The explicit
deferred-provider manifest is written to `deferred-providers.json` in the
evidence root.

## Release scope for this landing

This landing enables durable managed ownership for **OpenCode 1.18.21** using
`opencode/big-pickle` free tier. Managed shell isolation remains available, but
shell is intrinsically non-resumable and is not counted as a durable coding
provider.

Claude, Codex, and Amplifier adapters, exact-resume builders, provider-store
probes, bootstrap rules, and pinned binaries remain in the tree, but their
manifest entries carry `certificationState:
"pending_live_provider_certification"` and are release-disabled with
`PENDING_LIVE_QUALIFICATION`. Certification is the outer bound on
`managedEnabled`/`durableRecoveryEnabled`; the compiled capability table and
the checked-in manifest fail their own tests if the two ever disagree.

All browser/API/control-protocol create doorways therefore keep those three
providers on the legacy path and cannot claim managed ownership for them.
Promoting one later is intentionally mechanical: run its live low-cost
qualification campaign, commit the certification/manifest flag change,
regenerate candidate-bound receipts, and rerun both gates. Until that
happens, the provider does not participate in managed-default, loss
certification, or provider-matrix PASS criteria.

The release qualification matrix and runtime routing consume the same checked-in
manifest; adding a provider to the release scope automatically makes its live
receipt mandatory. This prevents a documentation-only enablement or accidental
route drift.

## Delivered system

Phase 5 completes the failure and operations layer for durable coding-agent
souls:

- explicit provider recovery-path inventories with fresh evidence states;
- proof-gated LOST decision and typed decision certificate;
- incident persistence before exact ownership-scoped cleanup;
- crash-resumable cleanup, export, metric, and notice transactions;
- one durable brief notice per profile with explicit ACK and incident details;
- ended panes retaining history, identity, and incident links;
- migration dry-run, verified backup, managed opt-in/default, rollback, and
  bounded repair audit;
- redaction-before-persistence, private rotated lifecycle logs, atomic incident
  exports, and retention that never evicts open incidents;
- runtime metrics, real browser loss/chaos specs, destructive Gate 5, and the
  >=30-minute/50-soul pressure soak.

Plan-named implementation seams:

- `crates/freshell-supervisor/src/loss_report.rs`
- `crates/freshell-supervisor/src/notice_outbox.rs`
- `crates/freshell-supervisor/src/migration.rs`
- `crates/freshell-supervisor/src/repair.rs`
- `crates/freshell-runtime-observability`
- `src/components/ManagedRuntimeNotices.tsx`
- `src/components/ManagedAgentRecoveryStatus.tsx`
- `test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts`
- `test/e2e-browser/specs/runtime-chaos-rust.spec.ts`
- `test/runtime/gates/phase-5.test.ts`
- `scripts/testing/runtime-phase5-soak.ts`

## Non-negotiable invariants

1. A missing/unreadable/unknown provider store is BLOCKED, never LOST.
2. Every applicable recovery path must be a fresh definitive negative before
   loss authority exists.
3. The incident commits before cleanup; signal delivery is not emptiness.
4. Cleanup accepts only the registry-issued full ownership handle and records
   zero foreign objects touched.
5. A lost soul never receives a blank replacement incarnation or replayed
   prompt.
6. Cleanup/export/notice replay is idempotent across every named crash boundary.
7. One final notice is deliverable per profile; ACK survives web/controller
   restart.
8. Ended panes retain the former soul/native identity and history.
9. Repair and migration never infer ownership or native identity from labels,
   process names, cwd, newest session, or filesystem guesses.
10. Runtime-test failpoints are absent from release behavior.

## Final qualification

Run focused tests and broad coordinated checks first, then generate every live
receipt against the final commit:

```bash
~/.local/bin/mise exec rust@1.96 -- cargo fmt --all -- --check
~/.local/bin/mise exec rust@1.96 -- cargo test --workspace --all-features
~/.local/bin/mise exec node@22 -- npm run typecheck
~/.local/bin/mise exec node@22 -- npm run contract:generate
npm run check
```

Receipt producers cover:

- Phase 2 web/OpenCode continuity;
- Phase 3 enabled-provider recovery and permission-prompt resurrection;
- Phase 4 deterministic tab/view rehydration;
- Phase 5 real isolated OpenCode loss notice;
- Phase 5 100-web/20-controller chaos;
- every **release-enabled** provider/mode at its required low-cost configuration
  (OpenCode for this landing);
- a real soak of at least 30 minutes with at least 50 desired souls and CPU,
  memory, and PID pressure.

Then run both gates:

```bash
npm run test:runtime -- gate landing --require-live   # expected PASS
npm run test:runtime -- gate phase-5 --require-live   # expected BLOCKED
```

The final run must contain all cumulative `P1-G*` through `P5-G*` assertions,
all imported receipts, `summary.json`, runtime metrics, migration plan,
incident/browser artifacts, ownership before/after, cleanup success, and a
restricted-broker log with zero unsafe attempts. The evidence is intentionally
untracked at:

```text
.runtime-evidence/<candidate-sha>/<run-id>/
```

A skipped case, stale candidate SHA, wrong image, missing provider/mode, soak
shorter than 30 minutes, cleanup uncertainty, duplicate writer, false loss
notice, or unsafe broker request fails Gate 5.

## Operations

See:

- `docs/development/lost-soul-runbook.md` for incident triage, cleanup failure,
  notice ACK, backup restore, and escalation;
- `docs/development/managed-runtime-rollout.md` for dry-run, backup, opt-in,
  managed-default, rollback, and repair limits;
- `docs/development/managed-runtime.md` for the ownership/recovery architecture;
- `test/runtime/README.md` for safe destructive test operation.

No production Freshell restart is part of qualification. The self-hosted port
3001 process must retain the same exact PID/start identity throughout. No PR is
created by the delivery workflow; branch push and PR creation are separate
operator decisions.

## Deferred provider promotion queue

Run these only when the corresponding live provider access is available. They
are deliberately the final work item and do not block the OpenCode landing:

1. **Claude:** Haiku, lowest available reasoning; prove a real turn, exact native
   session capture, host/provider crash recovery, permission/tool continuity,
   blockers, one writer, and final cleanup.
2. **Codex:** GPT-5.6 Luna, lowest reasoning; prove exact thread/app-server
   resume, terminal plus second-view one-writer behavior, pending approval/tool
   continuity, blockers, and cleanup.
3. **Amplifier:** pinned CLI and approved lowest-cost model; prove exact session
   materialization/resume and the same crash/blocker/isolation matrix.

For each provider, change `certificationState`, `managedEnabled`, and
`durableRecoveryEnabled` together, only in the same candidate that contains its
real receipt-producing test. A promotion is incomplete until
`checked_in_capability_manifest_matches_runtime_inventory`, the provider
qualification receipt, browser resurrection receipt, and cumulative Gate 5 all
pass on the final SHA.
